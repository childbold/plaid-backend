// Admin-only: create Link tokens and exchange public tokens for access tokens.
import { Router } from 'express';
import { config } from '../config.js';
import { db } from '../db.js';
import { plaid, plaidError } from '../plaid.js';
import { encrypt, decrypt } from '../crypto.js';
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
link.post('/link/exchange', async (req, res) => {
  const { public_token, institution } = req.body || {};
  if (!public_token) return res.status(400).json({ error: 'public_token required' });

  try {
    const { data } = await plaid.itemPublicTokenExchange({ public_token });

    // Never throw a new Item away. Plaid created (and counted) it before this ran, and
    // removing it doesn't give a trial slot back. Keep it and flag the duplicate instead.
    const instId = institution?.institution_id ?? null;
    const dupe = instId && db.prepare('SELECT item_id FROM items WHERE institution_id = ?').get(instId);

    db.prepare(`INSERT INTO items (item_id, access_token_enc, institution_id, institution_name)
                VALUES (?, ?, ?, ?)`)
      .run(data.item_id, encrypt(data.access_token), instId, institution?.name ?? null);

    // Kick off the initial sync without making the browser wait for it.
    syncItem(data.item_id).catch(() => {});
    res.status(201).json({
      item_id: data.item_id,
      ...(dupe && {
        duplicate_of: dupe.item_id,
        warning: `${institution?.name || 'This bank'} was already linked. Both are kept; remove the one you don't want.`,
      }),
    });
  } catch (err) {
    res.status(502).json(plaidError(err));
  }
});
