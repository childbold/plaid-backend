import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import './db.js';
import { requireAdmin, requireClient } from './auth.js';
import { link } from './routes/link.js';
import { admin } from './routes/admin.js';
import { data } from './routes/data.js';
import { webhooks } from './routes/webhooks.js';
import { syncAll } from './sync.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');

// Minimal CORS: only listed origins, only for browser frontends.
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && config.corsOrigins.includes(origin)) {
    res.set({
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'Authorization, X-API-Key, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      Vary: 'Origin',
    });
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Webhooks first: they need the raw body for signature checks.
app.use(webhooks);
app.use(express.json({ limit: '100kb' }));

app.get('/healthz', (req, res) => res.json({ ok: true, env: config.plaid.env }));

// Admin page (the page is static; every action it takes requires the admin key).
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
app.get('/admin', (req, res) => res.sendFile(path.join(publicDir, 'admin.html')));

app.use('/api/admin', requireAdmin, link, admin);
app.use('/api', requireClient, data);

app.use((req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.expose ? err.message : 'internal error' });
});

app.listen(config.port, () => {
  console.log(`plaid-backend listening on :${config.port} (Plaid env: ${config.plaid.env})`);
  if (config.syncIntervalMinutes > 0) {
    setInterval(() => syncAll().catch(e => console.error('[scheduler]', e)), config.syncIntervalMinutes * 60_000);
  }
});
