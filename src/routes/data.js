// Read-only endpoints for frontends. Everything is served from the local DB, never live from Plaid.
import { Router } from 'express';
import { db } from '../db.js';

export const data = Router();

const parse = s => (s ? JSON.parse(s) : null);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s);
const list = v => (v ? String(v).split(',').map(s => s.trim()).filter(Boolean) : []);

// Adds `start`/`end` (YYYY-MM-DD) and comma-separated `account_id` filters to a query.
function dateAndAccount(req, res, col, where, params) {
  const { start, end } = req.query;
  if (start) { if (!isDate(start)) return res.status(400).json({ error: 'start must be YYYY-MM-DD' }); where.push(`${col}.date >= @start`); params.start = start; }
  if (end)   { if (!isDate(end))   return res.status(400).json({ error: 'end must be YYYY-MM-DD' });   where.push(`${col}.date <= @end`);   params.end = end; }
  const ids = list(req.query.account_id);
  if (ids.length) {
    where.push(`${col}.account_id IN (${ids.map((_, i) => `@acct${i}`).join(',')})`);
    ids.forEach((id, i) => { params[`acct${i}`] = id; });
  }
  return true;
}

data.get('/institutions', (req, res) => {
  const rows = db.prepare(`SELECT item_id, institution_id, institution_name, institution_logo, institution_color,
    institution_url, status, last_error, last_synced_at, created_at, item_info, product_status
    FROM items ORDER BY institution_name`).all();
  res.json(rows.map(r => ({ ...r, last_error: parse(r.last_error), item_info: parse(r.item_info), product_status: parse(r.product_status) })));
});

data.get('/accounts', (req, res) => {
  const rows = db.prepare(`
    SELECT a.account_id, a.item_id, i.institution_name, a.name, a.official_name, a.mask, a.type, a.subtype,
           a.balance_current, a.balance_available, a.balance_limit, a.iso_currency_code, a.updated_at, a.raw
    FROM accounts a JOIN items i USING (item_id)
    ORDER BY i.institution_name, a.name`).all();
  res.json(rows.map(({ raw, ...r }) => {
    const a = parse(raw) || {};
    return { ...r, persistent_account_id: a.persistent_account_id ?? null, holder_category: a.holder_category ?? null,
      verification_status: a.verification_status ?? null, unofficial_currency_code: a.balances?.unofficial_currency_code ?? null };
  }));
});

// GET /transactions?start&end&account_id=a,b&pending=false&q=&category=FOOD_AND_DRINK,TRAVEL
//   &min_amount=&max_amount=&limit=100&offset=0
// Amounts are Plaid's convention (positive = money out). Enriched fields come from the stored Plaid JSON.
data.get('/transactions', (req, res) => {
  const { pending, q } = req.query;
  const limit = Math.min(Number(req.query.limit) || 100, 1000);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const where = [], params = {};
  if (dateAndAccount(req, res, 't', where, params) !== true) return;
  if (pending === 'true' || pending === 'false') { where.push('t.pending = @pending'); params.pending = pending === 'true' ? 1 : 0; }
  if (q) { where.push('(t.name LIKE @q OR t.merchant_name LIKE @q)'); params.q = `%${q}%`; }
  const cats = list(req.query.category);
  if (cats.length) {
    where.push(`t.category_primary IN (${cats.map((_, i) => `@cat${i}`).join(',')})`);
    cats.forEach((c, i) => { params[`cat${i}`] = c; });
  }
  if (req.query.min_amount !== undefined && req.query.min_amount !== '') { where.push('t.amount >= @min_amount'); params.min_amount = Number(req.query.min_amount); }
  if (req.query.max_amount !== undefined && req.query.max_amount !== '') { where.push('t.amount <= @max_amount'); params.max_amount = Number(req.query.max_amount); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT t.transaction_id, t.account_id, a.name AS account_name, t.date, t.authorized_date, t.name,
           t.merchant_name, t.amount, t.iso_currency_code, t.category_primary, t.category_detailed, t.pending, t.raw
    FROM transactions t JOIN accounts a USING (account_id)
    ${clause}
    ORDER BY t.date DESC, t.transaction_id
    LIMIT @limit OFFSET @offset`).all({ ...params, limit, offset });
  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM transactions t ${clause}`).get(params);

  res.json({
    total, limit, offset,
    transactions: rows.map(({ raw, ...r }) => {
      const t = parse(raw) || {};
      const loc = t.location || {};
      return {
        ...r, pending: !!r.pending,
        logo_url: t.logo_url ?? t.counterparties?.[0]?.logo_url ?? null,
        website: t.website ?? null,
        category_confidence: t.personal_finance_category?.confidence_level ?? null,
        category_icon_url: t.personal_finance_category_icon_url ?? null,
        payment_channel: t.payment_channel ?? null,
        transaction_code: t.transaction_code ?? null,
        check_number: t.check_number ?? null,
        merchant_entity_id: t.merchant_entity_id ?? null,
        pending_transaction_id: t.pending_transaction_id ?? null,
        authorized_datetime: t.authorized_datetime ?? null,
        datetime: t.datetime ?? null,
        location: Object.values(loc).some(v => v != null) ? loc : null,
        counterparties: t.counterparties?.length ? t.counterparties : null,
        payment_meta: t.payment_meta && Object.values(t.payment_meta).some(v => v != null) ? t.payment_meta : null,
      };
    }),
  });
});

// Daily balance snapshots, one per account per day a sync ran. History starts when this backend did.
data.get('/balances/history', (req, res) => {
  const where = [], params = {};
  if (dateAndAccount(req, res, 'h', where, params) !== true) return;
  res.json(db.prepare(`SELECT h.account_id, h.date, h.balance_current, h.balance_available, h.balance_limit
    FROM balance_history h ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY h.date, h.account_id`).all(params));
});

// Credit cards (APRs, minimum payment, due date, statement), mortgages and student loans.
data.get('/liabilities', (req, res) => {
  res.json(db.prepare(`SELECT l.account_id, a.name AS account_name, l.kind, l.data, l.updated_at
    FROM liabilities l JOIN accounts a USING (account_id) ORDER BY l.kind, a.name`).all()
    .map(r => ({ account_id: r.account_id, account_name: r.account_name, kind: r.kind, updated_at: r.updated_at, ...parse(r.data) })));
});

// Holdings joined with their security (ticker, name, type, close price).
data.get('/holdings', (req, res) => {
  res.json(db.prepare(`SELECT h.data, s.data AS security, a.name AS account_name
    FROM holdings h JOIN accounts a USING (account_id) LEFT JOIN securities s USING (security_id)`).all()
    .map(r => ({ ...parse(r.data), account_name: r.account_name, security: parse(r.security) })));
});

data.get('/investments/transactions', (req, res) => {
  const where = [], params = {};
  if (dateAndAccount(req, res, 'x', where, params) !== true) return;
  res.json(db.prepare(`SELECT x.data, s.data AS security, a.name AS account_name
    FROM investment_transactions x JOIN accounts a USING (account_id)
    LEFT JOIN securities s ON s.security_id = json_extract(x.data, '$.security_id')
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY x.date DESC`).all(params)
    .map(r => ({ ...parse(r.data), account_name: r.account_name, security: parse(r.security) })));
});

// Subscriptions, bills and paychecks Plaid detected from transaction history.
data.get('/recurring', (req, res) => {
  res.json(db.prepare(`SELECT r.direction, r.data, a.name AS account_name
    FROM recurring_streams r LEFT JOIN accounts a USING (account_id)`).all()
    .map(r => ({ direction: r.direction, account_name: r.account_name, ...parse(r.data) })));
});

// Account owners (names, emails, phones, addresses) as the bank reports them.
data.get('/identity', (req, res) => {
  res.json(db.prepare(`SELECT i.account_id, a.name AS account_name, i.owners
    FROM identities i JOIN accounts a USING (account_id) ORDER BY a.name`).all()
    .map(r => ({ ...r, owners: parse(r.owners) })));
});
