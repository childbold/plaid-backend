// Usage: npm run sandbox-item [-- ins_109508]
// Sandbox only: creates a test Item directly via the API, no browser needed,
// then fires a webhook so you can test the receiver. Default bank is "First Platypus Bank".
import { config } from '../src/config.js';
import { db } from '../src/db.js';
import { plaid, plaidError } from '../src/plaid.js';
import { encrypt } from '../src/crypto.js';
import { syncItem } from '../src/sync.js';

if (config.plaid.env !== 'sandbox') { console.error('Refusing: PLAID_ENV is not sandbox'); process.exit(1); }
const institution_id = process.argv[2] || 'ins_109508';

try {
  const { data: pt } = await plaid.sandboxPublicTokenCreate({
    institution_id,
    // Every product we sync, so liabilities/investments/identity are there from the start.
    initial_products: [...new Set([...config.plaid.products,
      ...config.plaid.extraProducts.filter(p => ['liabilities', 'investments', 'identity', 'auth'].includes(p))])],
    options: config.plaid.webhookUrl ? { webhook: config.plaid.webhookUrl } : undefined,
  });
  const { data: ex } = await plaid.itemPublicTokenExchange({ public_token: pt.public_token });
  const { data: inst } = await plaid.institutionsGetById({ institution_id, country_codes: config.plaid.countryCodes });

  db.prepare(`INSERT INTO items (item_id, access_token_enc, institution_id, institution_name) VALUES (?, ?, ?, ?)`)
    .run(ex.item_id, encrypt(ex.access_token), institution_id, inst.institution.name);
  console.log(`Created sandbox Item ${ex.item_id} (${inst.institution.name})`);

  // Sandbox transactions can take a few seconds to be ready on a brand-new Item.
  for (let i = 0; i < 6; i++) {
    const r = await syncItem(ex.item_id);
    console.log('sync:', r);
    if (r.added) break;
    await new Promise(r => setTimeout(r, 5000));
  }
} catch (err) {
  console.error(plaidError(err));
  process.exit(1);
}
