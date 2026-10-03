// AES-256-GCM encryption for Plaid access tokens at rest.
import crypto from 'node:crypto';
import { config } from './config.js';

const key = Buffer.from(config.encryptionKey, 'base64');
if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded (npm run gen-key)');

export function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map(b => b.toString('base64')).join('.');
}

export function decrypt(payload) {
  const [iv, tag, ct] = payload.split('.').map(s => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
export const randomKey = () => crypto.randomBytes(32).toString('base64url');
