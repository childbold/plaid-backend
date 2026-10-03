// Plaid webhook receiver with signature verification.
// https://plaid.com/docs/api/webhooks/webhook-verification/
import express, { Router } from 'express';
import { decodeProtectedHeader, importJWK, jwtVerify } from 'jose';
import { plaid } from '../plaid.js';
import { db } from '../db.js';
import { sha256 } from '../crypto.js';
import { syncItem } from '../sync.js';

export const webhooks = Router();
const keyCache = new Map();

async function verify(req) {
  const token = req.get('plaid-verification');
  if (!token) throw new Error('missing Plaid-Verification header');
  const { alg, kid } = decodeProtectedHeader(token);
  if (alg !== 'ES256') throw new Error('unexpected alg');

  let key = keyCache.get(kid);
  if (!key) {
    const { data } = await plaid.webhookVerificationKeyGet({ key_id: kid });
    if (data.key.expired_at) throw new Error('verification key expired');
    key = await importJWK(data.key, 'ES256');
    keyCache.set(kid, key);
  }

  const { payload } = await jwtVerify(token, key, { maxTokenAge: '5 min' });
  if (payload.request_body_sha256 !== sha256(req.body)) throw new Error('body hash mismatch');
}

webhooks.post('/webhooks/plaid', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    await verify(req);
  } catch (err) {
    console.warn('[webhook] rejected:', err.message);
    return res.status(401).end();
  }

  const body = JSON.parse(req.body.toString('utf8'));
  const { webhook_type: type, webhook_code: code, item_id } = body;
  console.log(`[webhook] ${type}.${code} item=${item_id}`);
  res.status(200).end(); // ack fast; do work afterward

  const setStatus = (status, err) =>
    db.prepare('UPDATE items SET status = ?, last_error = ? WHERE item_id = ?').run(status, err, item_id);

  // Any "new data" webhook: resync the whole Item (cheap; everything is diffed/replaced locally).
  const NEW_DATA = new Set(['TRANSACTIONS.SYNC_UPDATES_AVAILABLE', 'TRANSACTIONS.RECURRING_TRANSACTIONS_UPDATE',
    'HOLDINGS.DEFAULT_UPDATE', 'INVESTMENTS_TRANSACTIONS.DEFAULT_UPDATE', 'INVESTMENTS_TRANSACTIONS.HISTORICAL_UPDATE',
    'LIABILITIES.DEFAULT_UPDATE']);
  if (NEW_DATA.has(`${type}.${code}`)) {
    syncItem(item_id).catch(() => {});
  } else if (type === 'ITEM' && code === 'ERROR') {
    const login = body.error?.error_code === 'ITEM_LOGIN_REQUIRED';
    setStatus(login ? 'login_required' : 'error', JSON.stringify(body.error ?? null));
  } else if (type === 'ITEM' && (code === 'PENDING_EXPIRATION' || code === 'PENDING_DISCONNECT')) {
    setStatus('login_required', code);
  } else if (type === 'ITEM' && code === 'LOGIN_REPAIRED') {
    setStatus('ok', null);
    syncItem(item_id).catch(() => {});
  }
});
