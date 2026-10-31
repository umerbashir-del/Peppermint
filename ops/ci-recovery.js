import { Pool } from 'pg';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const url = new URL(process.env.DATABASE_URL || '');
if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.endsWith('_test')) throw new Error('Recovery CI may only use a local database ending in _test.');
const name = 'buildbridge_restore_' + randomUUID().replaceAll('-', '');
const target = new URL(url); target.pathname = '/' + name;
const directory = await mkdtemp(join(tmpdir(), 'buildbridge-ci-backup-'));
const env = { ...process.env, RESTORE_DATABASE_URL: target.href, RESTORE_CONFIRM_EMPTY: 'true', BACKUP_KEY: randomBytes(32).toString('base64') };
const pool = new Pool({ connectionString: url.href });
const docker = command => new Promise((accept, reject) => {
  const args = ['run', '--rm', '--network', 'host', '--user', `${process.getuid()}:${process.getgid()}`, '-e', 'DATABASE_URL', '-e', 'RESTORE_DATABASE_URL', '-e', 'RESTORE_CONFIRM_EMPTY', '-e', 'BACKUP_KEY', '-v', `${directory}:/backups`, 'buildbridge-ops-check', 'node', ...command];
  const child = spawn('docker', args, { env, stdio: ['ignore', 'inherit', 'inherit'] });
  child.once('error', reject); child.once('exit', code => code === 0 ? accept() : reject(new Error('Recovery container failed.')));
});
try {
  await pool.query(`CREATE DATABASE ${name}`);
  await docker(['ops/backup.js']);
  const file = (await readdir(directory)).find(file => file.endsWith('.enc'));
  if (!file) throw new Error('Encrypted backup missing.');
  await docker(['ops/restore.js', `/backups/${file}`]);
  const restored = new Pool({ connectionString: target.href });
  try {
    const sourceCount = (await pool.query('SELECT count(*) AS count FROM quote_revisions')).rows[0].count;
    const targetCount = (await restored.query('SELECT count(*) AS count FROM quote_revisions')).rows[0].count;
    if (sourceCount !== targetCount || Number((await restored.query('SELECT count(*) AS count FROM sessions')).rows[0].count) !== 0) throw new Error('Recovery validation failed.');
    console.log('Encrypted backup/restore drill passed; revision counts match and restored sessions are revoked.');
  } finally { await restored.end(); }
} finally {
  if (!/^buildbridge_restore_[a-f0-9]{32}$/.test(name) || '/' + name === url.pathname) throw new Error('Unsafe recovery cleanup target.');
  await pool.query(`DROP DATABASE IF EXISTS ${name}`); await pool.end();
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('buildbridge-ci-backup-')) throw new Error('Unsafe temporary directory.');
  await rm(directory, { recursive: true, force: true });
}
