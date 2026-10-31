// Admin-only: create Link tokens and exchange public tokens for access tokens.
import { Router } from 'express';
import { config } from '../config.js';
import { db } from '../db.js';
import { plaid, plaidError } from '../plaid.js';
import { encrypt, decrypt, sha256 } from '../crypto.js';
import { appendRecovery, readRecovery, saveItem, checkLive } from '../recovery.js';
import { syncItem } from '../sync.js';

export const link = Router();

// Extra products that Link itself can initialize (recurring rides on transactions).
const LINK_PRODUCTS = new Set(['liabilities', 'investments', 'identity', 'auth']);
const extraLinkProducts = () => config.plaid.extraProducts.filter(p => LINK_PRODUCTS.has(p) && !config.plaid.products.includes(p));

// POST /link/token            -> new connection
// POST /link/token {item_id}  -> update mode (re-auth an existing Item without using a new slot)
link.post('/link/token', async (req, res) => {
  const { item_id } = req.body || {};
  const base = {
    user: { client_user_id: 'owner' }, // single-user app
    client_name: 'Plaid Backend',
    country_codes: config.plaid.countryCodes,
    language: 'en',
    webhook: config.plaid.webhookUrl,
    redirect_uri: config.plaid.redirectUri,
  };
  try {
    let request;
    if (item_id) {
      const item = db.prepare('SELECT access_token_enc, product_status FROM items WHERE item_id = ?').get(item_id);
      if (!item) return res.status(404).json({ error: 'unknown item_id' });
      // Ask for consent to any extra product a sync was refused for.
      const status = JSON.parse(item.product_status || '{}');
      const needConsent = extraLinkProducts().filter(p => status[p]?.state === 'consent_required');
      request = {
        ...base, access_token: decrypt(item.access_token_enc),
        ...(needConsent.length && { additional_consented_products: needConsent }),
      };
    } else {
      // Extras are only pulled if the bank supports them, so they never hide institutions in Link.
      const extra = extraLinkProducts();
      request = {
        ...base, products: config.plaid.products, transactions: { days_requested: 730 },
        ...(extra.length && { required_if_supported_products: extra }),
      };
    }
    const { data } = await plaid.linkTokenCreate(request);
    res.json({ link_token: data.link_token, expiration: data.expiration });
  } catch (err) {
    res.status(502).json(plaidError(err));
  }
});

// POST /link/exchange { public_token, institution: { institution_id, name } }
// Safe to retry with the same public_token: a token already exchanged answers with its Item.
link.post('/link/exchange', async (req, res) => {
  const { public_token, institution } = req.body || {};
  if (!public_token) return res.status(400).json({ error: 'public_token required' });
  const public_token_sha256 = sha256(public_token);

  try {
    // The browser retries when it never saw our answer. Plaid only exchanges a public_token once,
    // so look it up instead of exchanging again.
    const prior = readRecovery().find(r => r.public_token_sha256 === public_token_sha256);
    if (prior) {
      const saved = await saveItem(prior);
      syncItem(prior.item_id).catch(() => {});
      return res.status(200).json({ item_id: prior.item_id, retried: true, ...dupeWarning(saved, institution) });
    }

    const { data } = await plaid.itemPublicTokenExchange({ public_token });

    // Never throw a new Item away. Plaid created (and counted) it before this ran, and
    // removing it doesn't give a trial slot back. Keep it and flag the duplicate instead.
    const rec = {
      item_id: data.item_id,
      access_token_enc: encrypt(data.access_token),
      institution_id: institution?.institution_id ?? null,
      institution_name: institution?.name ?? null,
    };

    // Two independent copies before answering: the recovery file, then the database.
    let fileSaved = true;
    try { appendRecovery({ ...rec, public_token_sha256 }); } catch (err) {
      fileSaved = false;
      console.error(`link recovery file write failed for ${rec.item_id}: ${err.message}`);
    }
    let saved;
    try { saved = await saveItem(rec); } catch (err) {
      console.error(`saving new Item ${rec.item_id} to the database failed: ${err.message}`);
      // The token is encrypted with a key only this server has, so the browser can hold it safely.
      return res.status(500).json({
        error: fileSaved
          ? 'Linked at Plaid, but saving to the database failed. A copy is in the recovery file; run npm run restore-links.'
          : 'Linked at Plaid, but both saves failed. This page kept an encrypted copy; use Restore once the server is fixed.',
        recovery: rec,
      });
    }

    // Kick off the initial sync without making the browser wait for it.
    syncItem(rec.item_id).catch(() => {});
    res.status(201).json({
      item_id: rec.item_id,
      ...dupeWarning(saved, institution),
      ...(!fileSaved && { recovery_file_failed: true }),
    });
  } catch (err) {
    res.status(502).json(plaidError(err));
  }
});

// POST /link/restore { item_id, access_token_enc, institution_id, institution_name }
// Puts back an Item from an encrypted copy the admin page kept after a failed save.
link.post('/link/restore', async (req, res) => {
  const { item_id, access_token_enc, institution_id, institution_name } = req.body || {};
  if (!item_id || !access_token_enc) return res.status(400).json({ error: 'item_id and access_token_enc required' });
  const rec = { item_id, access_token_enc, institution_id: institution_id ?? null, institution_name: institution_name ?? null };
  try {
    const live = await checkLive(rec);
    if (!live.ok) return res.status(live.gone ? 410 : 422).json({ error: `not restored: ${live.reason}`, gone: !!live.gone });
    if (!readRecovery().some(r => r.item_id === item_id)) {
      try { appendRecovery(rec); } catch (err) { console.error(`link recovery file write failed: ${err.message}`); }
    }
    const saved = await saveItem(rec);
    syncItem(item_id).catch(() => {});
    res.status(saved.inserted ? 201 : 200).json({ item_id, restored: saved.inserted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function dupeWarning(saved, institution) {
  return saved.duplicate_of ? {
    duplicate_of: saved.duplicate_of,
    warning: `${institution?.name || 'This bank'} was already linked. Both are kept; remove the one you don't want.`,
  } : {};
}
