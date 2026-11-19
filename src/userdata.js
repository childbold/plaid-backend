// Your own data, as opposed to what Plaid sends: the budget, your edits to transactions, and goals.
// It lives here, next to the accounts it describes, so every frontend (the dashboard, the widget,
// anything added later) reads and changes the same copy, and the backup covers it.
//
// Each area is read whole (GET returns the same document shape the dashboard has always used) and
// changed with a small patch that names only what changed: { section: { id: value | null } },
// where null deletes. A patch is applied in one transaction, so it lands completely or not at all.
//
// None of these tables reference accounts or transactions with foreign keys on purpose: Plaid data
// is replaced on sync and deleted when a bank is removed, and your work must outlive both.
import { db } from './db.js';

// ---------- schema: numbered steps tracked in PRAGMA user_version ----------
// Append a step to change the schema; never edit a step that has shipped.
const MIGRATIONS = [
  // 1: budget, transaction edits, goals, settings
  `
  CREATE TABLE budget_items (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    parent_id   TEXT REFERENCES budget_items(id) ON DELETE CASCADE,  -- null for a category
    sort_order  REAL NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- An amount applies from its month onward, until a later entry for the same item.
  CREATE TABLE budget_amounts (
    item_id     TEXT NOT NULL REFERENCES budget_items(id) ON DELETE CASCADE,
    from_month  TEXT NOT NULL,                 -- YYYY-MM
    amount      REAL NOT NULL,
    PRIMARY KEY (item_id, from_month)
  );
  CREATE TABLE budget_rules (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN ('merchant', 'category')),
    value       TEXT NOT NULL,                 -- lowercased Plaid merchant name, or a Plaid category
    item_id     TEXT NOT NULL REFERENCES budget_items(id) ON DELETE CASCADE,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (kind, value)
  );
  -- One-off moves: a transaction to a budget item, or 'exclude' to leave it out.
  CREATE TABLE budget_overrides (
    transaction_id  TEXT PRIMARY KEY,
    target          TEXT NOT NULL,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE transaction_edits (
    transaction_id  TEXT PRIMARY KEY,
    name            TEXT,
    category        TEXT,                      -- a Plaid primary category
    notes           TEXT,
    tags            TEXT,                      -- JSON array of strings
    reviewed        INTEGER NOT NULL DEFAULT 0,
    work            INTEGER NOT NULL DEFAULT 0, -- work trip: left out of income, spending and budget
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- "Always do this for this merchant", keyed on Plaid's lowercased merchant name.
  CREATE TABLE merchant_rules (
    merchant_key  TEXT PRIMARY KEY,
    name          TEXT,
    category      TEXT,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE goals (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('save', 'payoff')),
    target        REAL,
    by_month      TEXT,                        -- YYYY-MM
    account_ids   TEXT NOT NULL DEFAULT '[]',  -- JSON array of account_id
    manual        REAL,                        -- amount saved, when no account is linked
    start_date    TEXT,
    start_amount  REAL,
    created       TEXT,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Small values shared by every frontend, JSON-encoded. Keys look like 'edits.reviewSince'.
  CREATE TABLE user_settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  // Next planned step, savings buckets (split one savings account into named amounts):
  //   CREATE TABLE savings_buckets (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, name TEXT NOT NULL,
  //     amount REAL NOT NULL, sort_order REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  // with a 'buckets' area below following the same read/patch pattern.
];

export function migrate() {
  const at = db.pragma('user_version', { simple: true });
  for (let v = at; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
    console.log(`[db] applied schema step ${v + 1}`);
  }
}
migrate();

// ---------- validation ----------
export class BadInput extends Error {
  constructor(message) { super(message); this.status = 400; this.expose = true; }
}
const bad = msg => { throw new BadInput(msg); };
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function key(v, what) {
  if (typeof v !== 'string' || !v || v.length > 200) bad(`${what} must be a non-empty string of at most 200 characters`);
  return v;
}
function text(v, what, max, { optional = true } = {}) {
  if (v === undefined || v === null || v === '') { if (optional) return null; bad(`${what} is required`); }
  if (typeof v !== 'string' || v.length > max) bad(`${what} must be text of at most ${max} characters`);
  return v;
}
function num(v, what, { optional = true } = {}) {
  if (v === undefined || v === null || v === '') { if (optional) return null; bad(`${what} is required`); }
  if (typeof v !== 'number' || !Number.isFinite(v)) bad(`${what} must be a number`);
  return v;
}
function only(o, allowed, what) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) bad(`${what}: unknown field "${k}"`);
}
// A patch section: { id: value | null }.
function section(patch, name) {
  const s = patch[name];
  if (s === undefined) return [];
  if (!isObj(s)) bad(`${name} must be an object of { id: value or null }`);
  return Object.entries(s);
}

const revKey = area => `rev_${area}`;
const getMeta = db.prepare('SELECT value FROM meta WHERE key = ?');
const setMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
const revOf = area => Number(getMeta.get(revKey(area))?.value || 0);
function bump(area) {
  const rev = revOf(area) + 1;
  setMeta.run(revKey(area), String(rev));
  return { rev, updated_at: new Date().toISOString() };
}

const getSetting = k => { const r = db.prepare('SELECT value FROM user_settings WHERE key = ?').get(k); return r ? JSON.parse(r.value) : null; };
function putSetting(k, v) {
  if (v === null || v === undefined) db.prepare('DELETE FROM user_settings WHERE key = ?').run(k);
  else db.prepare(`INSERT INTO user_settings (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).run(k, JSON.stringify(v));
}

// Runs fn in a transaction; a foreign key failure means the patch pointed at something missing.
function atomically(fn) {
  try {
    return db.transaction(fn)();
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') bad('the change refers to a budget item that does not exist');
    throw err;
  }
}

// ---------- budget ----------
// { version, items: [{ id, name, parentId, order }], amounts: { itemId: [{ from, amount }] },
//   rules: [{ id, kind, value, itemId }], overrides: { transactionId: itemId | 'exclude' } }
export function readBudget() {
  const items = db.prepare('SELECT id, name, parent_id, sort_order FROM budget_items ORDER BY rowid').all()
    .map(r => ({ id: r.id, name: r.name, parentId: r.parent_id, order: r.sort_order }));
  const amounts = {};
  for (const r of db.prepare('SELECT item_id, from_month, amount FROM budget_amounts ORDER BY item_id, from_month').all()) {
    (amounts[r.item_id] ||= []).push({ from: r.from_month, amount: r.amount });
  }
  const rules = db.prepare('SELECT id, kind, value, item_id FROM budget_rules ORDER BY rowid').all()
    .map(r => ({ id: r.id, kind: r.kind, value: r.value, itemId: r.item_id }));
  const overrides = Object.fromEntries(db.prepare('SELECT transaction_id, target FROM budget_overrides').all().map(r => [r.transaction_id, r.target]));
  return { version: 1, rev: revOf('budget'), items, amounts, rules, overrides };
}

function budgetItem(id, v) {
  if (!isObj(v)) bad(`items.${id} must be an object or null`);
  only(v, ['id', 'name', 'parentId', 'order'], `items.${id}`);
  return {
    id,
    name: text(typeof v.name === 'string' ? v.name.trim() : v.name, `items.${id}.name`, 200, { optional: false }),
    parent_id: v.parentId == null ? null : key(v.parentId, `items.${id}.parentId`),
    sort_order: num(v.order, `items.${id}.order`) ?? 0,
  };
}
function budgetAmounts(id, list) {
  if (!Array.isArray(list) || list.length > 1000) bad(`amounts.${id} must be a list of { from, amount }`);
  const seen = new Map();
  for (const e of list) {
    if (!isObj(e) || !MONTH.test(e.from)) bad(`amounts.${id}: each entry needs from as YYYY-MM`);
    seen.set(e.from, Math.max(0, num(e.amount, `amounts.${id}.amount`, { optional: false })));
  }
  return [...seen];
}
function budgetRule(id, v) {
  if (!isObj(v)) bad(`rules.${id} must be an object or null`);
  only(v, ['id', 'kind', 'value', 'itemId'], `rules.${id}`);
  if (v.kind !== 'merchant' && v.kind !== 'category') bad(`rules.${id}.kind must be merchant or category`);
  const value = text(v.value, `rules.${id}.value`, 200, { optional: false });
  return { id, kind: v.kind, value: v.kind === 'merchant' ? value.trim().toLowerCase() : value, item_id: key(v.itemId, `rules.${id}.itemId`) };
}

export function validateBudgetPatch(patch) {
  if (!isObj(patch)) bad('send a JSON object');
  only(patch, ['items', 'amounts', 'rules', 'overrides'], 'budget patch');
  const p = { items: [], itemDeletes: [], amounts: [], rules: [], ruleDeletes: [], overrides: [] };
  for (const [id, v] of section(patch, 'items')) { key(id, 'item id'); if (v === null) p.itemDeletes.push(id); else p.items.push(budgetItem(id, v)); }
  for (const [id, v] of section(patch, 'amounts')) { key(id, 'item id'); p.amounts.push([id, v === null ? [] : budgetAmounts(id, v)]); }
  for (const [id, v] of section(patch, 'rules')) { key(id, 'rule id'); if (v === null) p.ruleDeletes.push(id); else p.rules.push(budgetRule(id, v)); }
  for (const [tx, v] of section(patch, 'overrides')) { key(tx, 'transaction id'); p.overrides.push([tx, v === null ? null : key(v, `overrides.${tx}`)]); }
  // Categories before their line items, so a new category and its first line item can arrive together.
  p.items.sort((a, b) => (a.parent_id ? 1 : 0) - (b.parent_id ? 1 : 0));
  return p;
}

const itemExists = db.prepare('SELECT 1 FROM budget_items WHERE id = ?');
export function patchBudget(patch) {
  const p = validateBudgetPatch(patch);
  return atomically(() => {
    for (const id of p.itemDeletes) {
      // Its line items go too (foreign key cascade), and so do amounts, rules and moves that pointed at any of them.
      const gone = [id, ...db.prepare('SELECT id FROM budget_items WHERE parent_id = ?').pluck().all(id)];
      for (const g of gone) db.prepare('DELETE FROM budget_overrides WHERE target = ?').run(g);
      db.prepare('DELETE FROM budget_items WHERE id = ?').run(id);
    }
    const upsertItem = db.prepare(`INSERT INTO budget_items (id, name, parent_id, sort_order) VALUES (@id, @name, @parent_id, @sort_order)
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, parent_id = excluded.parent_id, sort_order = excluded.sort_order, updated_at = datetime('now')`);
    for (const it of p.items) upsertItem.run(it);
    for (const id of p.ruleDeletes) db.prepare('DELETE FROM budget_rules WHERE id = ?').run(id);
    for (const r of p.rules) {
      // One rule per merchant or category: a new one replaces whatever pointed it elsewhere.
      db.prepare('DELETE FROM budget_rules WHERE kind = ? AND value = ? AND id <> ?').run(r.kind, r.value, r.id);
      db.prepare(`INSERT INTO budget_rules (id, kind, value, item_id) VALUES (@id, @kind, @value, @item_id)
        ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, value = excluded.value, item_id = excluded.item_id, updated_at = datetime('now')`).run(r);
    }
    for (const [id, entries] of p.amounts) {
      db.prepare('DELETE FROM budget_amounts WHERE item_id = ?').run(id);
      for (const [from, amount] of entries) db.prepare('INSERT INTO budget_amounts (item_id, from_month, amount) VALUES (?, ?, ?)').run(id, from, amount);
    }
    for (const [tx, target] of p.overrides) {
      if (target === null) { db.prepare('DELETE FROM budget_overrides WHERE transaction_id = ?').run(tx); continue; }
      if (target !== 'exclude' && !itemExists.get(target)) bad(`overrides.${tx} points at a budget item that does not exist`);
      db.prepare(`INSERT INTO budget_overrides (transaction_id, target) VALUES (?, ?)
        ON CONFLICT (transaction_id) DO UPDATE SET target = excluded.target, updated_at = datetime('now')`).run(tx, target);
    }
    return bump('budget');
  });
}

// ---------- transaction edits ----------
// { version, tx: { transactionId: { name?, category?, notes?, tags?, reviewed?: true, work?: true } },
//   merchants: { merchantKey: { name?, category? } }, reviewSince: 'YYYY-MM-DD' | null }
export function readEdits() {
  const tx = {};
  for (const r of db.prepare('SELECT * FROM transaction_edits').all()) {
    const e = {};
    if (r.name) e.name = r.name;
    if (r.category) e.category = r.category;
    if (r.notes) e.notes = r.notes;
    const tags = r.tags ? JSON.parse(r.tags) : [];
    if (tags.length) e.tags = tags;
    if (r.reviewed) e.reviewed = true;
    if (r.work) e.work = true;
    tx[r.transaction_id] = e;
  }
  const merchants = {};
  for (const r of db.prepare('SELECT * FROM merchant_rules').all()) {
    const m = {};
    if (r.name) m.name = r.name;
    if (r.category) m.category = r.category;
    merchants[r.merchant_key] = m;
  }
  return { version: 1, rev: revOf('edits'), tx, merchants, reviewSince: getSetting('edits.reviewSince') };
}

function txEdit(id, v) {
  if (!isObj(v)) bad(`tx.${id} must be an object or null`);
  only(v, ['name', 'category', 'notes', 'tags', 'reviewed', 'work'], `tx.${id}`);
  if (v.tags != null && (!Array.isArray(v.tags) || v.tags.length > 50 || v.tags.some(t => typeof t !== 'string' || !t || t.length > 100))) {
    bad(`tx.${id}.tags must be a list of up to 50 short strings`);
  }
  for (const f of ['reviewed', 'work']) if (v[f] != null && typeof v[f] !== 'boolean') bad(`tx.${id}.${f} must be true or false`);
  return {
    transaction_id: id,
    name: text(v.name, `tx.${id}.name`, 200),
    category: text(v.category, `tx.${id}.category`, 64),
    notes: text(v.notes, `tx.${id}.notes`, 5000),
    tags: v.tags?.length ? JSON.stringify(v.tags) : null,
    reviewed: v.reviewed ? 1 : 0,
    work: v.work ? 1 : 0,
  };
}
function merchantRule(k, v) {
  if (!isObj(v)) bad(`merchants.${k} must be an object or null`);
  only(v, ['name', 'category'], `merchants.${k}`);
  return { merchant_key: k, name: text(v.name, `merchants.${k}.name`, 200), category: text(v.category, `merchants.${k}.category`, 64) };
}
const emptyEdit = e => !e.name && !e.category && !e.notes && !e.tags && !e.reviewed && !e.work;

export function validateEditsPatch(patch) {
  if (!isObj(patch)) bad('send a JSON object');
  only(patch, ['tx', 'merchants', 'reviewSince'], 'edits patch');
  const p = { tx: [], merchants: [], reviewSince: undefined };
  for (const [id, v] of section(patch, 'tx')) { key(id, 'transaction id'); p.tx.push([id, v === null ? null : txEdit(id, v)]); }
  for (const [k, v] of section(patch, 'merchants')) { key(k, 'merchant key'); p.merchants.push([k, v === null ? null : merchantRule(k, v)]); }
  if (patch.reviewSince !== undefined) {
    if (patch.reviewSince !== null && !DAY.test(patch.reviewSince)) bad('reviewSince must be YYYY-MM-DD or null');
    p.reviewSince = patch.reviewSince;
  }
  return p;
}

export function patchEdits(patch) {
  const p = validateEditsPatch(patch);
  return atomically(() => {
    const del = db.prepare('DELETE FROM transaction_edits WHERE transaction_id = ?');
    const put = db.prepare(`INSERT INTO transaction_edits (transaction_id, name, category, notes, tags, reviewed, work)
      VALUES (@transaction_id, @name, @category, @notes, @tags, @reviewed, @work)
      ON CONFLICT (transaction_id) DO UPDATE SET name = excluded.name, category = excluded.category, notes = excluded.notes,
        tags = excluded.tags, reviewed = excluded.reviewed, work = excluded.work, updated_at = datetime('now')`);
    for (const [id, e] of p.tx) (e === null || emptyEdit(e)) ? del.run(id) : put.run(e);
    const delM = db.prepare('DELETE FROM merchant_rules WHERE merchant_key = ?');
    const putM = db.prepare(`INSERT INTO merchant_rules (merchant_key, name, category) VALUES (@merchant_key, @name, @category)
      ON CONFLICT (merchant_key) DO UPDATE SET name = excluded.name, category = excluded.category, updated_at = datetime('now')`);
    for (const [k, m] of p.merchants) (m === null || (!m.name && !m.category)) ? delM.run(k) : putM.run(m);
    if (p.reviewSince !== undefined) putSetting('edits.reviewSince', p.reviewSince);
    return bump('edits');
  });
}

// ---------- goals ----------
// { version, goals: [{ id, name, kind, target, by, accountIds, manual, start: { date, amount }, created }] }
export function readGoals() {
  const goals = db.prepare('SELECT * FROM goals ORDER BY rowid').all().map(r => ({
    id: r.id, name: r.name, kind: r.kind, target: r.target, by: r.by_month, accountIds: JSON.parse(r.account_ids),
    manual: r.manual, start: r.start_date || r.start_amount != null ? { date: r.start_date, amount: r.start_amount } : null,
    created: r.created,
  }));
  return { version: 1, rev: revOf('goals'), goals };
}

function goal(id, v) {
  if (!isObj(v)) bad(`goals.${id} must be an object or null`);
  only(v, ['id', 'name', 'kind', 'target', 'by', 'accountIds', 'manual', 'start', 'created'], `goals.${id}`);
  if (v.kind !== 'save' && v.kind !== 'payoff') bad(`goals.${id}.kind must be save or payoff`);
  if (v.by != null && !MONTH.test(v.by)) bad(`goals.${id}.by must be YYYY-MM or null`);
  const ids = v.accountIds ?? [];
  if (!Array.isArray(ids) || ids.length > 100 || ids.some(a => typeof a !== 'string' || !a)) bad(`goals.${id}.accountIds must be a list of account ids`);
  if (v.start != null && !isObj(v.start)) bad(`goals.${id}.start must be { date, amount } or null`);
  if (v.start?.date != null && !DAY.test(v.start.date)) bad(`goals.${id}.start.date must be YYYY-MM-DD`);
  return {
    id,
    name: text(typeof v.name === 'string' ? v.name.trim() : v.name, `goals.${id}.name`, 200, { optional: false }),
    kind: v.kind,
    target: num(v.target, `goals.${id}.target`),
    by_month: v.by ?? null,
    account_ids: JSON.stringify(ids),
    manual: num(v.manual, `goals.${id}.manual`),
    start_date: v.start?.date ?? null,
    start_amount: num(v.start?.amount, `goals.${id}.start.amount`),
    created: text(v.created, `goals.${id}.created`, 40),
  };
}

export function validateGoalsPatch(patch) {
  if (!isObj(patch)) bad('send a JSON object');
  only(patch, ['goals'], 'goals patch');
  return section(patch, 'goals').map(([id, v]) => { key(id, 'goal id'); return [id, v === null ? null : goal(id, v)]; });
}

export function patchGoals(patch) {
  const p = validateGoalsPatch(patch);
  return atomically(() => {
    const put = db.prepare(`INSERT INTO goals (id, name, kind, target, by_month, account_ids, manual, start_date, start_amount, created)
      VALUES (@id, @name, @kind, @target, @by_month, @account_ids, @manual, @start_date, @start_amount, @created)
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, kind = excluded.kind, target = excluded.target, by_month = excluded.by_month,
        account_ids = excluded.account_ids, manual = excluded.manual, start_date = excluded.start_date,
        start_amount = excluded.start_amount, created = COALESCE(goals.created, excluded.created), updated_at = datetime('now')`);
    for (const [id, g] of p) g === null ? db.prepare('DELETE FROM goals WHERE id = ?').run(id) : put.run(g);
    return bump('goals');
  });
}

// ---------- one-time import of the dashboard's old JSON files ----------
// Takes the `data` of budget.json, edits.json and goals.json as the dashboard stored them. Each area
// is imported only once, and only while it is still empty here, so running it again (or after you
// have started editing) never overwrites anything. Records that don't validate are skipped and counted.
const tablesOf = { budget: ['budget_items', 'budget_overrides'], edits: ['transaction_edits', 'merchant_rules'], goals: ['goals'] };
const isEmpty = area => tablesOf[area].every(t => !db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get());

function keepValid(entries, check) {
  const ok = {};
  let skipped = 0;
  for (const [k, v] of entries) {
    try { check(k, v); ok[k] = v; } catch (err) { if (!(err instanceof BadInput)) throw err; skipped++; }
  }
  return { ok, skipped };
}

function importBudget(d) {
  const items = keepValid((Array.isArray(d.items) ? d.items : []).map(i => [i?.id, i]), (id, v) => { key(id, 'id'); budgetItem(id, v); });
  // A line item whose category is missing can't be kept.
  for (const [id, v] of Object.entries(items.ok)) if (v.parentId && !items.ok[v.parentId]) { delete items.ok[id]; items.skipped++; }
  const ids = new Set(Object.keys(items.ok));
  const amounts = keepValid(Object.entries(isObj(d.amounts) ? d.amounts : {}), (id, v) => { if (!ids.has(id)) bad('orphan'); budgetAmounts(id, v); });
  const rules = keepValid((Array.isArray(d.rules) ? d.rules : []).map(r => [r?.id, r]), (id, v) => { key(id, 'id'); if (!ids.has(v.itemId)) bad('orphan'); budgetRule(id, v); });
  const overrides = keepValid(Object.entries(isObj(d.overrides) ? d.overrides : {}), (tx, v) => { key(tx, 'tx'); if (v !== 'exclude' && !ids.has(v)) bad('orphan'); });
  patchBudget({ items: items.ok, amounts: amounts.ok, rules: rules.ok, overrides: overrides.ok });
  return {
    imported: { items: ids.size, amounts: Object.keys(amounts.ok).length, rules: Object.keys(rules.ok).length, overrides: Object.keys(overrides.ok).length },
    skipped: items.skipped + amounts.skipped + rules.skipped + overrides.skipped,
  };
}

function importEdits(d) {
  // The old file could hold empty strings and false flags; drop those before checking.
  const clean = e => isObj(e) ? Object.fromEntries(Object.entries(e).filter(([, v]) => v !== '' && v != null && v !== false && !(Array.isArray(v) && !v.length))) : e;
  const tx = keepValid(Object.entries(isObj(d.tx) ? d.tx : {}).map(([k, v]) => [k, clean(v)]).filter(([, v]) => !isObj(v) || Object.keys(v).length),
    (id, v) => { key(id, 'tx'); txEdit(id, v); });
  const merchants = keepValid(Object.entries(isObj(d.merchants) ? d.merchants : {}).map(([k, v]) => [k, clean(v)]), (k, v) => { key(k, 'merchant'); merchantRule(k, v); });
  const reviewSince = typeof d.reviewSince === 'string' && DAY.test(d.reviewSince) ? d.reviewSince : undefined;
  patchEdits({ tx: tx.ok, merchants: merchants.ok, ...(reviewSince ? { reviewSince } : {}) });
  return { imported: { tx: Object.keys(tx.ok).length, merchants: Object.keys(merchants.ok).length, reviewSince: reviewSince || null }, skipped: tx.skipped + merchants.skipped };
}

function importGoals(d) {
  const goals = keepValid((Array.isArray(d.goals) ? d.goals : []).map(g => [g?.id, g]), (id, v) => { key(id, 'id'); goal(id, v); });
  patchGoals({ goals: goals.ok });
  return { imported: { goals: Object.keys(goals.ok).length }, skipped: goals.skipped };
}

const importers = { budget: importBudget, edits: importEdits, goals: importGoals };
export function importLegacy(body) {
  if (!isObj(body)) bad('send { budget?, edits?, goals? }');
  only(body, Object.keys(importers), 'import');
  const out = {};
  for (const [area, run] of Object.entries(importers)) {
    if (body[area] == null) continue;
    if (!isObj(body[area])) bad(`${area} must be the document's data object`);
    if (getMeta.get(`imported_${area}`) || !isEmpty(area)) { out[area] = { status: 'skipped', reason: 'already has data' }; continue; }
    out[area] = db.transaction(() => {
      const r = run(body[area]);
      setMeta.run(`imported_${area}`, new Date().toISOString());
      return { status: 'imported', ...r };
    })();
  }
  return out;
}
