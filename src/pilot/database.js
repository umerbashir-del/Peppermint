import { readFile, readdir, mkdir, open, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { Pool } from 'pg';

export async function createDatabase({ connectionString = process.env.DATABASE_URL, production = process.env.NODE_ENV === 'production', localPath = 'output/pilot-db' } = {}) {
  if (!connectionString) {
    if (production) throw new Error('Production requires DATABASE_URL; embedded storage is development only.');
    const { PGlite } = await import('@electric-sql/pglite');
    const lock = localPath === ':memory:' ? null : resolve(localPath) + '.lock';
    if (lock) {
      await mkdir(dirname(lock), { recursive: true });
      let handle;
      try { handle = await open(lock, 'wx', 0o600); await handle.writeFile(String(process.pid)); }
      catch { throw new Error('The embedded development database is already open or has a stale lock. Stop its process before maintenance; see docs/pilot-service.md.'); }
      finally { await handle?.close(); }
    }
    const pg = new PGlite(localPath === ':memory:' ? undefined : resolve(localPath));
    try { await pg.waitReady; } catch (error) { if (lock) await unlink(lock); throw error; }
    return { kind: 'embedded-development', query: (sql, params) => pg.query(sql, params), transaction: fn => pg.transaction(tx => fn({ query: (sql, params) => tx.query(sql, params), exec: sql => tx.exec(sql) })), close: async () => { try { await pg.close(); } finally { if (lock) await unlink(lock); } } };
  }
  const target = new URL(connectionString);
  if (production && !['localhost','127.0.0.1','db'].includes(target.hostname) && target.searchParams.get('sslmode') !== 'verify-full') throw new Error('Remote production PostgreSQL requires sslmode=verify-full.');
  const pool = new Pool({ connectionString, max: Number(process.env.DB_POOL_SIZE || 10), connectionTimeoutMillis: 10000, statement_timeout: 15000 });
  const database = {
    kind: 'postgresql', query: (sql, params) => pool.query(sql, params),
    async transaction(fn) {
      const client = await pool.connect();
      try { await client.query('BEGIN'); const result = await fn({ query: (sql, params) => client.query(sql, params), exec: sql => client.query(sql) }); await client.query('COMMIT'); return result; }
      catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }, close: () => pool.end(),
  };
  await database.query('SELECT 1');
  return database;
}

export async function verifyMigrations(database) {
  const directory = new URL('../../migrations/', import.meta.url);
  for (const file of (await readdir(directory)).filter(file => /^\d{3}_[A-Za-z0-9_-]+\.sql$/.test(file)).sort()) {
    const checksum = createHash('sha256').update((await readFile(new URL(file, directory), 'utf8')).replaceAll('\r\n', '\n')).digest('hex');
    const { rows } = await database.query('SELECT checksum FROM schema_migrations WHERE version=$1', [file.slice(0,3)]);
    if (rows[0]?.checksum !== checksum) throw new Error('Database migrations are missing or changed. Apply them before starting this release.');
  }
}

export async function migrate(database) {
  const directory = new URL('../../migrations/', import.meta.url);
  const files = (await readdir(directory)).filter(file => /^\d{3}_[A-Za-z0-9_-]+\.sql$/.test(file)).sort();
  for (const file of files) {
    const sql = await readFile(new URL(file, directory), 'utf8'), version = file.slice(0, 3);
    const checksum = createHash('sha256').update(sql.replaceAll('\r\n', '\n')).digest('hex');
    await database.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(72641821)');
      await tx.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
      const { rows } = await tx.query('SELECT checksum FROM schema_migrations WHERE version=$1', [version]);
      if (rows.length) { if (rows[0].checksum !== checksum) throw new Error('Applied migration checksum changed. Add a new migration instead.'); return; }
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', [version, checksum]);
    });
  }
}
