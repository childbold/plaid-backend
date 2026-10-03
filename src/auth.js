import crypto from 'node:crypto';
import { config } from './config.js';
import { db } from './db.js';
import { sha256 } from './crypto.js';

function bearer(req) {
  const h = req.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : req.get('x-api-key');
}

function safeEqual(a, b) {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

const findClient = db.prepare('SELECT id, name FROM clients WHERE key_hash = ? AND revoked_at IS NULL');

// Admin: linking, removing items, managing clients, forcing syncs.
export function requireAdmin(req, res, next) {
  const key = bearer(req);
  if (key && safeEqual(key, config.adminApiKey)) { req.client = { name: 'admin', admin: true }; return next(); }
  res.status(401).json({ error: 'admin key required' });
}

// Frontends: read-only data access. The admin key also works here.
export function requireClient(req, res, next) {
  const key = bearer(req);
  if (!key) return res.status(401).json({ error: 'API key required' });
  if (safeEqual(key, config.adminApiKey)) { req.client = { name: 'admin', admin: true }; return next(); }
  const client = findClient.get(sha256(key));
  if (!client) return res.status(401).json({ error: 'invalid API key' });
  req.client = client;
  next();
}
