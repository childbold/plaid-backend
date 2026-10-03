// Admin-only: manage Items and frontend API clients.
import { Router } from 'express';
import { db } from '../db.js';
import { plaid, plaidError } from '../plaid.js';
import { decrypt, sha256, randomKey } from '../crypto.js';
import { syncItem, syncAll } from '../sync.js';

export const admin = Router();

admin.get('/items', (req, res) => {
  res.json(db.prepare(`SELECT item_id, institution_id, institution_name, status, last_error,
    last_synced_at, created_at, product_status FROM items ORDER BY created_at`).all()
    .map(r => ({ ...r, product_status: JSON.parse(r.product_status || '{}') })));
});

admin.post('/items/:id/sync', async (req, res) => {
  res.json(await syncItem(req.params.id));
});

admin.post('/sync', async (req, res) => {
  res.json(await syncAll());
});

// Frees the slot at Plaid and deletes all local data for the Item.
admin.delete('/items/:id', async (req, res) => {
  const item = db.prepare('SELECT access_token_enc FROM items WHERE item_id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'unknown item' });
  try {
    await plaid.itemRemove({ access_token: decrypt(item.access_token_enc) });
  } catch (err) {
    const e = plaidError(err);
    // If Plaid already forgot it, still clean up locally.
    if (e.error_code !== 'ITEM_NOT_FOUND') return res.status(502).json(e);
  }
  db.prepare('DELETE FROM items WHERE item_id = ?').run(req.params.id);
  res.json({ removed: req.params.id });
});

// --- Frontend API clients ---
admin.get('/clients', (req, res) => {
  res.json(db.prepare('SELECT id, name, created_at, revoked_at FROM clients ORDER BY id').all());
});

admin.post('/clients', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const key = randomKey();
  try {
    const { lastInsertRowid } = db.prepare('INSERT INTO clients (name, key_hash) VALUES (?, ?)').run(name, sha256(key));
    res.status(201).json({ id: lastInsertRowid, name, api_key: key, note: 'store this now; it is not retrievable later' });
  } catch {
    res.status(409).json({ error: 'client name already exists' });
  }
});

admin.delete('/clients/:id', (req, res) => {
  const r = db.prepare("UPDATE clients SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL").run(req.params.id);
  res.status(r.changes ? 200 : 404).json(r.changes ? { revoked: Number(req.params.id) } : { error: 'not found' });
});
