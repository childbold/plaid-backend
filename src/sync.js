// Pulls everything Plaid will give us for an Item into SQLite: accounts + transactions
// (via /transactions/sync cursors), then each extra product independently.
import { db } from './db.js';
import { config } from './config.js';
import { plaid, plaidError } from './plaid.js';
import { decrypt } from './crypto.js';

const upsertAccount = db.prepare(`
  INSERT INTO accounts (account_id, item_id, name, official_name, mask, type, subtype,
    balance_current, balance_available, balance_limit, iso_currency_code, raw, updated_at)
  VALUES (@account_id, @item_id, @name, @official_name, @mask, @type, @subtype,
    @balance_current, @balance_available, @balance_limit, @iso_currency_code, @raw, datetime('now'))
  ON CONFLICT(account_id) DO UPDATE SET
    name=excluded.name, official_name=excluded.official_name, mask=excluded.mask,
    type=excluded.type, subtype=excluded.subtype, balance_current=excluded.balance_current,
    balance_available=excluded.balance_available, balance_limit=excluded.balance_limit,
    iso_currency_code=excluded.iso_currency_code, raw=excluded.raw, updated_at=datetime('now')`);

const snapshotBalance = db.prepare(`
  INSERT INTO balance_history (account_id, date, balance_current, balance_available, balance_limit)
  VALUES (@account_id, date('now', 'localtime'), @balance_current, @balance_available, @balance_limit)
  ON CONFLICT(account_id, date) DO UPDATE SET balance_current=excluded.balance_current,
    balance_available=excluded.balance_available, balance_limit=excluded.balance_limit`);

const upsertTx = db.prepare(`
  INSERT INTO transactions (transaction_id, account_id, item_id, date, authorized_date, name,
    merchant_name, amount, iso_currency_code, category_primary, category_detailed, pending, raw)
  VALUES (@transaction_id, @account_id, @item_id, @date, @authorized_date, @name,
    @merchant_name, @amount, @iso_currency_code, @category_primary, @category_detailed, @pending, @raw)
  ON CONFLICT(transaction_id) DO UPDATE SET
    date=excluded.date, authorized_date=excluded.authorized_date, name=excluded.name,
    merchant_name=excluded.merchant_name, amount=excluded.amount, category_primary=excluded.category_primary,
    category_detailed=excluded.category_detailed, pending=excluded.pending, raw=excluded.raw`);

const deleteTx = db.prepare('DELETE FROM transactions WHERE transaction_id = ?');
const setCursor = db.prepare(`UPDATE items SET sync_cursor = ?, status = 'ok', last_error = NULL,
  last_synced_at = datetime('now') WHERE item_id = ?`);
const setStatus = db.prepare('UPDATE items SET status = ?, last_error = ? WHERE item_id = ?');
const getItem = db.prepare('SELECT * FROM items WHERE item_id = ?');

const txRow = (t, itemId) => ({
  transaction_id: t.transaction_id,
  account_id: t.account_id,
  item_id: itemId,
  date: t.date,
  authorized_date: t.authorized_date ?? null,
  name: t.name ?? null,
  merchant_name: t.merchant_name ?? null,
  amount: t.amount,
  iso_currency_code: t.iso_currency_code ?? null,
  category_primary: t.personal_finance_category?.primary ?? null,
  category_detailed: t.personal_finance_category?.detailed ?? null,
  pending: t.pending ? 1 : 0,
  raw: JSON.stringify(t),
});

const running = new Set(); // per-item lock so webhooks + scheduler don't overlap

export async function syncItem(itemId) {
  if (running.has(itemId)) return { skipped: true };
  running.add(itemId);
  try {
    const item = getItem.get(itemId);
    if (!item) throw new Error(`unknown item ${itemId}`);
    const accessToken = decrypt(item.access_token_enc);

    // Accounts + cached balances (free; /accounts/balance/get forces a live refresh but costs in production)
    const { data: acct } = await plaid.accountsGet({ access_token: accessToken });

    // Page through /transactions/sync. Collect everything first, commit once, so a failure
    // mid-pagination doesn't leave a half-applied cursor.
    let cursor, added, modified, removed;
    for (let attempt = 0; ; attempt++) {
      cursor = item.sync_cursor || undefined;
      added = []; modified = []; removed = [];
      try {
        let hasMore = true;
        while (hasMore) {
          const { data } = await plaid.transactionsSync({ access_token: accessToken, cursor, count: 500 });
          added.push(...data.added); modified.push(...data.modified); removed.push(...data.removed);
          cursor = data.next_cursor;
          hasMore = data.has_more;
        }
        break;
      } catch (err) {
        // Plaid asks you to restart pagination from the original cursor if data changed mid-sync.
        const code = err?.response?.data?.error_code;
        if (code !== 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' || attempt >= 3) throw err;
      }
    }

    db.transaction(() => {
      for (const a of acct.accounts) {
        const row = {
          account_id: a.account_id, item_id: itemId, name: a.name, official_name: a.official_name ?? null,
          mask: a.mask ?? null, type: a.type, subtype: a.subtype ?? null,
          balance_current: a.balances.current ?? null, balance_available: a.balances.available ?? null,
          balance_limit: a.balances.limit ?? null, iso_currency_code: a.balances.iso_currency_code ?? null,
          raw: JSON.stringify(a),
        };
        upsertAccount.run(row);
        snapshotBalance.run(row);
      }
      for (const t of [...added, ...modified]) upsertTx.run(txRow(t, itemId));
      for (const r of removed) deleteTx.run(r.transaction_id);
      setCursor.run(cursor, itemId);
    })();

    const extras = await syncExtras(item, accessToken);
    return { added: added.length, modified: modified.length, removed: removed.length, extras };
  } catch (err) {
    const e = plaidError(err);
    const status = e.error_code === 'ITEM_LOGIN_REQUIRED' ? 'login_required' : 'error';
    setStatus.run(status, JSON.stringify(e), itemId);
    console.error(`[sync] ${itemId} failed:`, e);
    return { error: e };
  } finally {
    running.delete(itemId);
  }
}

export async function syncAll() {
  const items = db.prepare("SELECT item_id FROM items WHERE status != 'login_required'").all();
  const results = {};
  for (const { item_id } of items) results[item_id] = await syncItem(item_id);
  return results;
}

// ---------- Extra products ----------
// Each runs on its own: a bank without loans shouldn't stop holdings from syncing.
// Status per product lands in items.product_status for the admin page and frontends.

const json = v => JSON.stringify(v ?? null);
const isoDate = d => d.toISOString().slice(0, 10);

// Plaid errors that mean "nothing to fetch here", not "something broke".
const UNSUPPORTED = new Set([
  'PRODUCTS_NOT_SUPPORTED', 'PRODUCT_NOT_ENABLED', 'NO_LIABILITY_ACCOUNTS', 'NO_INVESTMENT_ACCOUNTS',
  'NO_INVESTMENT_AUTH_ACCOUNTS', 'NO_ACCOUNTS', 'INSTITUTION_NOT_SUPPORTED',
  'INVALID_PRODUCT',
]);

const setItemMeta = db.prepare('UPDATE items SET item_info = ?, product_status = ? WHERE item_id = ?');
const setInstitution = db.prepare(`UPDATE items SET institution_logo = ?, institution_color = ?, institution_url = ?,
  institution_name = COALESCE(institution_name, ?) WHERE item_id = ?`);

const liab = {
  clear: db.prepare('DELETE FROM liabilities WHERE item_id = ?'),
  insert: db.prepare('INSERT OR REPLACE INTO liabilities (account_id, item_id, kind, data) VALUES (?, ?, ?, ?)'),
};
const inv = {
  security: db.prepare(`INSERT INTO securities (security_id, data) VALUES (?, ?)
    ON CONFLICT(security_id) DO UPDATE SET data=excluded.data, updated_at=datetime('now')`),
  clearHoldings: db.prepare('DELETE FROM holdings WHERE item_id = ?'),
  holding: db.prepare('INSERT OR REPLACE INTO holdings (account_id, item_id, security_id, data) VALUES (?, ?, ?, ?)'),
  clearTx: db.prepare('DELETE FROM investment_transactions WHERE item_id = ? AND date >= ?'),
  tx: db.prepare(`INSERT OR REPLACE INTO investment_transactions (investment_transaction_id, account_id, item_id, date, data)
    VALUES (?, ?, ?, ?, ?)`),
};
const rec = {
  clear: db.prepare('DELETE FROM recurring_streams WHERE item_id = ?'),
  insert: db.prepare('INSERT OR REPLACE INTO recurring_streams (stream_id, item_id, account_id, direction, data) VALUES (?, ?, ?, ?, ?)'),
};
const ident = {
  clear: db.prepare('DELETE FROM identities WHERE item_id = ?'),
  insert: db.prepare('INSERT OR REPLACE INTO identities (account_id, item_id, owners) VALUES (?, ?, ?)'),
};
const knownAccount = db.prepare('SELECT 1 FROM accounts WHERE account_id = ?');

const fetchers = {
  async liabilities(itemId, access_token) {
    const { data } = await plaid.liabilitiesGet({ access_token });
    const l = data.liabilities || {};
    db.transaction(() => {
      liab.clear.run(itemId);
      for (const kind of ['credit', 'mortgage', 'student']) {
        for (const x of l[kind] || []) if (x.account_id) liab.insert.run(x.account_id, itemId, kind, json(x));
      }
    })();
    return { credit: l.credit?.length || 0, mortgage: l.mortgage?.length || 0, student: l.student?.length || 0 };
  },

  async investments(itemId, access_token) {
    const { data: h } = await plaid.investmentsHoldingsGet({ access_token });

    // Investment transactions: last 24 months (Plaid's max), offset-paginated.
    const start = new Date(); start.setMonth(start.getMonth() - 24);
    const start_date = isoDate(start), end_date = isoDate(new Date());
    const txs = [], securities = [...h.securities];
    for (let offset = 0; ; ) {
      const { data } = await plaid.investmentsTransactionsGet({ access_token, start_date, end_date, options: { count: 500, offset } });
      txs.push(...data.investment_transactions);
      securities.push(...data.securities);
      offset += data.investment_transactions.length;
      if (offset >= data.total_investment_transactions || !data.investment_transactions.length) break;
    }

    db.transaction(() => {
      for (const s of securities) inv.security.run(s.security_id, json(s));
      inv.clearHoldings.run(itemId);
      for (const x of h.holdings) inv.holding.run(x.account_id, itemId, x.security_id, json(x));
      inv.clearTx.run(itemId, start_date);
      for (const t of txs) if (knownAccount.get(t.account_id)) inv.tx.run(t.investment_transaction_id, t.account_id, itemId, t.date, json(t));
    })();
    return { holdings: h.holdings.length, transactions: txs.length };
  },

  async recurring(itemId, access_token) {
    const { data } = await plaid.transactionsRecurringGet({ access_token });
    db.transaction(() => {
      rec.clear.run(itemId);
      for (const s of data.inflow_streams) rec.insert.run(s.stream_id, itemId, s.account_id, 'inflow', json(s));
      for (const s of data.outflow_streams) rec.insert.run(s.stream_id, itemId, s.account_id, 'outflow', json(s));
    })();
    return { inflow: data.inflow_streams.length, outflow: data.outflow_streams.length };
  },

  async identity(itemId, access_token) {
    const { data } = await plaid.identityGet({ access_token });
    db.transaction(() => {
      ident.clear.run(itemId);
      for (const a of data.accounts) if (knownAccount.get(a.account_id)) ident.insert.run(a.account_id, itemId, json(a.owners));
    })();
    return { accounts: data.accounts.length };
  },
};

async function syncExtras(item, accessToken) {
  const itemId = item.item_id;
  const status = JSON.parse(item.product_status || '{}');

  // /item/get tells us what the Item has and what the bank could add.
  let info = null;
  try {
    ({ data: { item: info } } = await plaid.itemGet({ access_token: accessToken }));
  } catch (err) {
    console.warn(`[sync] ${itemId} item/get failed:`, plaidError(err));
  }

  // Institution logo/colour/url: fetched once (free, rarely changes).
  const instId = item.institution_id || info?.institution_id;
  if (instId && !item.institution_logo) {
    try {
      const { data } = await plaid.institutionsGetById({
        institution_id: instId, country_codes: config.plaid.countryCodes, options: { include_optional_metadata: true },
      });
      const i = data.institution;
      setInstitution.run(i.logo ?? null, i.primary_color ?? null, i.url ?? null, i.name ?? null, itemId);
    } catch (err) {
      console.warn(`[sync] ${itemId} institution lookup failed:`, plaidError(err));
    }
  }

  const have = new Set([...(info?.products || []), ...(info?.billed_products || []),
    ...(info?.available_products || []), ...(info?.consented_products || [])]);
  const results = {};
  for (const product of config.plaid.extraProducts) {
    if (!fetchers[product]) continue;
    // Recurring rides on Transactions; everything else must be on (or addable to) the Item.
    const supported = !info || (product === 'recurring' ? have.has('transactions') : have.has(product));
    if (!supported) { status[product] = { state: 'unsupported', checked_at: new Date().toISOString() }; continue; }
    try {
      results[product] = await fetchers[product](itemId, accessToken);
      status[product] = { state: 'ok', synced_at: new Date().toISOString(), counts: results[product] };
    } catch (err) {
      const e = plaidError(err);
      // consent_required: the Item was linked without this product; re-run Link in update mode to grant it.
      const state = UNSUPPORTED.has(e.error_code) ? 'unsupported'
        : e.error_code === 'ADDITIONAL_CONSENT_REQUIRED' ? 'consent_required'
        : e.error_code === 'PRODUCT_NOT_READY' ? 'pending' : 'error';
      status[product] = { state, checked_at: new Date().toISOString(), error: e };
      results[product] = { [state]: e.error_code || e.message };
      if (state === 'error') console.warn(`[sync] ${itemId} ${product} failed:`, e);
    }
  }

  setItemMeta.run(json(info && {
    products: info.products, billed_products: info.billed_products, available_products: info.available_products,
    consented_products: info.consented_products, consent_expiration_time: info.consent_expiration_time,
    update_type: info.update_type, webhook: info.webhook ? true : false, error: info.error,
  }), json(status), itemId);
  return results;
}
