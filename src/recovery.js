// Append-only record of every Item this backend has exchanged, kept beside the database.
// Each line holds the access token encrypted with TOKEN_ENCRYPTION_KEY (same as the DB), so a
// failed or lost database write never loses an Item Plaid has already counted.
// Restore with `npm run restore-links` (see README).
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export const recoveryPath = process.env.LINK_RECOVERY_PATH
  || path.join(path.dirname(config.dbPath), 'link-recovery.jsonl');

// Durable before it returns: written, fsynced, and readable only by this user.
export function appendRecovery(record) {
  fs.mkdirSync(path.dirname(recoveryPath), { recursive: true });
  const fd = fs.openSync(recoveryPath, 'a', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function readRecovery() {
  let text;
  try { text = fs.readFileSync(recoveryPath, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return text.split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; } // a torn last line from a crash
  });
}

// Shared by /link/exchange, /link/restore and scripts/restore-links.js.
// Lazy imports keep this file usable without a database for readRecovery().
export async function saveItem(rec) {
  const { db } = await import('./db.js');
  const dupe = rec.institution_id && db.prepare('SELECT item_id FROM items WHERE institution_id = ? AND item_id != ?')
    .get(rec.institution_id, rec.item_id);
  const { changes } = db.prepare(`INSERT OR IGNORE INTO items (item_id, access_token_enc, institution_id, institution_name)
              VALUES (?, ?, ?, ?)`)
    .run(rec.item_id, rec.access_token_enc, rec.institution_id ?? null, rec.institution_name ?? null);
  return { inserted: changes > 0, duplicate_of: dupe?.item_id };
}

// Confirms a recovered token still works at Plaid and belongs to the Item it claims.
export async function checkLive(rec) {
  const { plaid, plaidError } = await import('./plaid.js');
  const { decrypt } = await import('./crypto.js');
  let token;
  try { token = decrypt(rec.access_token_enc); } catch {
    return { ok: false, reason: 'cannot decrypt (different TOKEN_ENCRYPTION_KEY?)' };
  }
  try {
    const { data } = await plaid.itemGet({ access_token: token });
    if (data.item.item_id !== rec.item_id) return { ok: false, reason: 'token belongs to a different Item' };
    return { ok: true };
  } catch (err) {
    const e = plaidError(err);
    return { ok: false, reason: e.error_code || e.message, gone: ['ITEM_NOT_FOUND', 'INVALID_ACCESS_TOKEN'].includes(e.error_code) };
  }
}
