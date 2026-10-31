import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, stat, open, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

const magic = Buffer.from('BBBK1');
function keyBytes(key) { const value = Buffer.from(key || '', 'base64'); if (value.length !== 32) throw new Error('BACKUP_KEY must be a base64-encoded 32-byte key.'); return value; }
export async function encryptArchive(input, path, key) {
  const iv = randomBytes(12), header = Buffer.concat([magic, iv]);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(key), iv); cipher.setAAD(header);
  const output = createWriteStream(path, { flags: 'wx', mode: 0o600 }); output.write(header);
  try { await pipeline(input, cipher, output); await appendFile(path, cipher.getAuthTag()); }
  catch (error) { await unlink(path).catch(() => {}); throw error; }
}
export async function decryptArchive(path, outputPath, key) {
  const size = (await stat(path)).size;
  if (size < 33) throw new Error('Invalid backup archive.');
  const file = await open(path, 'r');
  const header = Buffer.alloc(17), tag = Buffer.alloc(16);
  try { await file.read(header, 0, 17, 0); await file.read(tag, 0, 16, size - 16); } finally { await file.close(); }
  if (!header.subarray(0, 5).equals(magic)) throw new Error('Invalid backup archive.');
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(key), header.subarray(5)); decipher.setAAD(header); decipher.setAuthTag(tag);
  try { await pipeline(createReadStream(path, { start: 17, end: size - 17 }), decipher, createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })); }
  catch { await unlink(outputPath).catch(() => {}); throw new Error('Backup authentication failed. No data was restored.'); }
}
export function pgEnvironment(connectionString) {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('A PostgreSQL URL is required.');
  return { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGSSLMODE: url.searchParams.get('sslmode') || (['localhost', '127.0.0.1', 'db'].includes(url.hostname) ? 'prefer' : 'verify-full') };
}
