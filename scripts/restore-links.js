// Usage: npm run restore-links            (dry run: shows what would be restored)
//        npm run restore-links -- --apply (puts missing Items back in the database)
// Reads data/link-recovery.jsonl, which /link/exchange writes before saving each new Item.
// An Item is only put back if Plaid confirms its token still works, so Items you removed stay removed.
import { db } from '../src/db.js';
import { readRecovery, recoveryPath, saveItem, checkLive } from '../src/recovery.js';

const apply = process.argv.includes('--apply');
const records = readRecovery();
const missing = [...new Map(records.map(r => [r.item_id, r])).values()]
  .filter(r => !db.prepare('SELECT 1 FROM items WHERE item_id = ?').get(r.item_id));

console.log(`${recoveryPath}: ${records.length} record(s), ${missing.length} not in the database.`);
for (const rec of missing) {
  const label = `${rec.institution_name || rec.institution_id || 'unknown bank'} (${rec.item_id}, linked ${rec.at})`;
  const live = await checkLive(rec);
  if (!live.ok) { console.log(`skip     ${label}: ${live.reason}`); continue; }
  if (!apply) { console.log(`would restore ${label}`); continue; }
  await saveItem(rec);
  console.log(`restored ${label}`);
}
if (!apply && missing.length) console.log('Dry run. Re-run with -- --apply to restore, then press Sync all on the admin page.');
