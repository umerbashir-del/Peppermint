import { spawn } from 'node:child_process';
import { mkdtemp, readdir, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { decryptArchive, pgEnvironment } from './archive.js';

let pool, directory;
try {
  const archive = process.argv[2], target = process.env.RESTORE_DATABASE_URL;
  if (!archive || !target || process.env.RESTORE_CONFIRM_EMPTY !== 'true') throw new Error('Specify an archive, RESTORE_DATABASE_URL, and RESTORE_CONFIRM_EMPTY=true.');
  const dest = new URL(target), source = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
  if (source && source.hostname === dest.hostname && (source.port || '5432') === (dest.port || '5432') && source.pathname === dest.pathname) throw new Error('Restore target must differ from the source database.');
  pool = new Pool({ connectionString: target, max: 1 });
  const existing = await pool.query("SELECT count(*)::integer AS count FROM information_schema.tables WHERE table_schema='public'");
  if (existing.rows[0].count !== 0) throw new Error('Restore target must be a new empty database. No existing data was modified.');
  directory = await mkdtemp(join(tmpdir(), 'buildbridge-restore-'));
  const dump = join(directory, 'verified.dump');
  // Authenticate the entire encrypted archive before any database writes.
  await decryptArchive(archive, dump, process.env.BACKUP_KEY);
  const child = spawn('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction', '--dbname', decodeURIComponent(dest.pathname.slice(1)), dump], { env: pgEnvironment(target), stdio: ['ignore', 'ignore', 'pipe'] }); child.stderr.resume();
  await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? accept() : reject(new Error('Database restore failed.'))); });
  await pool.query('DELETE FROM sessions'); await pool.query('DELETE FROM activation_tokens');
  const suppliers = await pool.query('SELECT id FROM suppliers');
  for (const supplier of suppliers.rows) await pool.query("INSERT INTO quote_events(id,supplier_id,action,details) VALUES($1,$2,'restored_from_backup',$3)", [randomUUID(), supplier.id, JSON.stringify({ sessions_revoked: true })]);
  const verified = await pool.query("SELECT (SELECT count(*) FROM quotes) AS quotes,(SELECT count(*) FROM quote_revisions) AS revisions,(SELECT count(*) FROM quote_events) AS events");
  console.log(JSON.stringify({ status: 'restore_verified', ...verified.rows[0], sessions_revoked: true }));
} catch { console.error('Restore failed or target was not empty. Production data was not intentionally overwritten. Inspect operator configuration.'); process.exitCode = 1; }
finally {
  await pool?.end();
  if (directory) { for (const file of await readdir(directory)) await unlink(join(directory, file)); await rmdir(directory); }
}
