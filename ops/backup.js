import { spawn } from 'node:child_process';
import { mkdir, rename, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { encryptArchive, pgEnvironment } from './archive.js';

try {
  if (!process.env.DATABASE_URL || !process.env.BACKUP_KEY) throw new Error('Configure DATABASE_URL and BACKUP_KEY.');
  const directory = resolve(process.env.BACKUP_DIRECTORY || 'output/backups'); await mkdir(directory, { recursive: true, mode: 0o700 });
  const name = `buildbridge-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.enc`;
  const temp = join(directory, `.${name}.part`), final = join(directory, name);
  const child = spawn('pg_dump', ['--format=custom', '--no-owner', '--no-privileges'], { env: pgEnvironment(process.env.DATABASE_URL), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.resume();
  const completed = new Promise((accept, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? accept() : reject(new Error('Database dump failed.'))); });
  try { await Promise.all([encryptArchive(child.stdout, temp, process.env.BACKUP_KEY), completed]); await rename(temp, final); }
  catch { child.kill(); await unlink(temp).catch(() => {}); throw new Error('Backup failed. Check database access, pg_dump version, disk space, and encryption configuration.'); }
  console.log(JSON.stringify({ status: 'backup_complete', archive: final, encrypted: true, at: new Date().toISOString() }));
} catch (error) { console.error(JSON.stringify({ status: 'backup_failed', message: error.message.includes('BACKUP_KEY') ? 'Check the backup encryption key.' : 'Backup failed; inspect operator configuration without logging credentials.' })); process.exitCode = 1; }
