// Usage: npm run create-client -- <name>
// Creates a frontend API key from the command line (same as the admin page).
import { db } from '../src/db.js';
import { sha256, randomKey } from '../src/crypto.js';

const name = process.argv[2];
if (!name) { console.error('usage: npm run create-client -- <name>'); process.exit(1); }
const key = randomKey();
db.prepare('INSERT INTO clients (name, key_hash) VALUES (?, ?)').run(name, sha256(key));
console.log(`Created client "${name}". API key (shown once):\n${key}`);
