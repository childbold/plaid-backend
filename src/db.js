import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS clients (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  key_hash    TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at  TEXT
);

CREATE TABLE IF NOT EXISTS items (
  item_id           TEXT PRIMARY KEY,
  access_token_enc  TEXT NOT NULL,
  institution_id    TEXT,
  institution_name  TEXT,
  sync_cursor       TEXT,
  status            TEXT NOT NULL DEFAULT 'ok',   -- ok | login_required | error
  last_error        TEXT,
  last_synced_at    TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
  account_id         TEXT PRIMARY KEY,
  item_id            TEXT NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
  name               TEXT,
  official_name      TEXT,
  mask               TEXT,
  type               TEXT,
  subtype            TEXT,
  balance_current    REAL,
  balance_available  REAL,
  balance_limit      REAL,
  iso_currency_code  TEXT,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  transaction_id     TEXT PRIMARY KEY,
  account_id         TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  item_id            TEXT NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
  date               TEXT NOT NULL,
  authorized_date    TEXT,
  name               TEXT,
  merchant_name      TEXT,
  amount             REAL NOT NULL,          -- Plaid convention: positive = money out
  iso_currency_code  TEXT,
  category_primary   TEXT,
  category_detailed  TEXT,
  pending            INTEGER NOT NULL DEFAULT 0,
  raw                TEXT                    -- full Plaid JSON for anything not broken out
);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id, date);
`);

// --- Everything beyond accounts + transactions. Each product's rows are replaced wholesale on sync. ---
db.exec(`
CREATE TABLE IF NOT EXISTS balance_history (
  account_id         TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  date               TEXT NOT NULL,          -- one snapshot per account per day (latest sync wins)
  balance_current    REAL,
  balance_available  REAL,
  balance_limit      REAL,
  PRIMARY KEY (account_id, date)
);

CREATE TABLE IF NOT EXISTS liabilities (
  account_id  TEXT PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
  item_id     TEXT NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                 -- credit | mortgage | student
  data        TEXT NOT NULL,                 -- Plaid JSON for that liability
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS securities (
  security_id  TEXT PRIMARY KEY,
  data         TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS holdings (
  account_id   TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  item_id      TEXT NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
  security_id  TEXT NOT NULL,
  data         TEXT NOT NULL,
  PRIMARY KEY (account_id, security_id)
);

CREATE TABLE IF NOT EXISTS investment_transactions (
  investment_transaction_id  TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  item_id     TEXT NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
  date        TEXT NOT NULL,
  data        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_itx_date ON investment_transactions(date);

CREATE TABLE IF NOT EXISTS recurring_streams (
  stream_id   TEXT PRIMARY KEY,
  item_id     TEXT NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
  account_id  TEXT NOT NULL,
  direction   TEXT NOT NULL,                 -- inflow | outflow
  data        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS identities (
  account_id  TEXT PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
  item_id     TEXT NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
  owners      TEXT NOT NULL                  -- Plaid owners[] JSON
);
`);

// Additive column migrations for databases created before these existed.
function addColumns(table, cols) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
  for (const [name, type] of Object.entries(cols)) {
    if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}
addColumns('items', {
  institution_logo: 'TEXT',      // base64 PNG from /institutions/get_by_id
  institution_color: 'TEXT',
  institution_url: 'TEXT',
  item_info: 'TEXT',             // /item/get JSON: products, consent expiry, etc.
  product_status: 'TEXT',        // { product: { ok, synced_at, error } }
});
addColumns('accounts', { raw: 'TEXT' });
