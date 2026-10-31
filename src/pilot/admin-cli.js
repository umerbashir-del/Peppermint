import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createDatabase, migrate } from './database.js';
import { hashPassword } from './auth.js';
import { event } from './access.js';
import { loadSupplier } from '../supplier-tools.js';

if (existsSync('.env')) loadEnvFile('.env');
const [command = 'migrate'] = process.argv.slice(2);
const db = await createDatabase();
try {
  await migrate(db);
  if (command === 'migrate') console.log('Database migrations applied.');
  else if (command === 'seed-demo') {
    if (process.env.NODE_ENV === 'production') throw new Error('Demo accounts are disabled in production.');
    const existing = await db.query('SELECT 1 FROM suppliers LIMIT 1');
    if (existing.rows.length) throw new Error('Demo seed only runs on an empty database. Existing accounts were preserved.');
    const data = await loadSupplier();
    const credentials = [];
    await db.transaction(async tx => {
      await tx.query('INSERT INTO suppliers(id,name) VALUES($1,$2)', ['pilot-supplier', 'BuildBridge sample supplier']);
      await tx.query('INSERT INTO branches(supplier_id,id,name) VALUES($1,$2,$3)', ['pilot-supplier', data.branch, 'Sample main branch']);
      for (const account of data.accounts) await tx.query('INSERT INTO accounts(supplier_id,id,name) VALUES($1,$2,$3)', ['pilot-supplier', account.id, account.id]);
      for (const [role, email, account] of [['admin', 'admin@buildbridge.local', null], ['staff', 'rep@buildbridge.local', 'normal'], ['credit_manager', 'credit@buildbridge.local', 'near-limit'], ['contractor', 'contractor@buildbridge.local', 'normal']]) {
        const id = randomUUID(), password = randomBytes(24).toString('base64url');
        await tx.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [id, email, await hashPassword(password)]);
        await tx.query('INSERT INTO memberships(user_id,supplier_id,role) VALUES($1,$2,$3)', [id, 'pilot-supplier', role]);
        if (account) await tx.query('INSERT INTO access_grants(id,user_id,supplier_id,branch_id,account_id) VALUES($1,$2,$3,$4,$5)', [randomUUID(), id, 'pilot-supplier', role === 'contractor' ? null : data.branch, account]);
        credentials.push({ email, password, role });
      }
    });
    await mkdir('output', { recursive: true });
    await writeFile('output/pilot-demo-credentials.json', JSON.stringify(credentials, null, 2), { mode: 0o600 });
    console.log('Demo users created. Local sign-in details are in ignored output/pilot-demo-credentials.json.');
  } else if (command === 'bootstrap') {
    const email = process.env.BOOTSTRAP_EMAIL?.trim().toLowerCase(), password = process.env.BOOTSTRAP_PASSWORD;
    if (!email || !password || !process.env.SUPPLIER_DATA_FILE) throw new Error('Set BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, and SUPPLIER_DATA_FILE locally.');
    const { readFile } = await import('node:fs/promises');
    const data = JSON.parse(await readFile(process.env.SUPPLIER_DATA_FILE, 'utf8'));
    if (!data.supplier_id) throw new Error('Supplier source needs an explicit supplier_id.');
    const id = randomUUID(), hash = await hashPassword(password);
    await db.transaction(async tx => {
      const existing = await tx.query('SELECT 1 FROM suppliers WHERE id=$1', [data.supplier_id]);
      if (existing.rows.length) throw new Error('Supplier already exists; use an authorized administrator to manage users.');
      await tx.query('INSERT INTO suppliers(id,name) VALUES($1,$2)', [data.supplier_id, data.supplier_name || data.supplier_id]);
      await tx.query('INSERT INTO branches(supplier_id,id,name) VALUES($1,$2,$3)', [data.supplier_id, data.branch, data.branch]);
      for (const account of data.accounts) await tx.query('INSERT INTO accounts(supplier_id,id,name) VALUES($1,$2,$3)', [data.supplier_id, account.id, account.name || account.id]);
      await tx.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [id, email, hash]);
      await tx.query('INSERT INTO memberships(user_id,supplier_id,role) VALUES($1,$2,$3)', [id, data.supplier_id, 'admin']);
      await event(tx, { id }, data.supplier_id, null, null, 'supplier_bootstrapped');
    });
    console.log('Initial supplier administrator created. Remove bootstrap credentials from your environment.');
  } else if (command === 'reset-password') {
    const email = process.env.BOOTSTRAP_EMAIL?.trim().toLowerCase();
    const hash = await hashPassword(process.env.BOOTSTRAP_PASSWORD);
    await db.transaction(async tx => {
      const user = await tx.query('UPDATE users SET password_hash=$1 WHERE email=$2 RETURNING id', [hash, email]);
      if (!user.rows.length) throw new Error('User not found.');
      await tx.query('DELETE FROM sessions WHERE user_id=$1', [user.rows[0].id]);
      const memberships = await tx.query('SELECT supplier_id FROM memberships WHERE user_id=$1', [user.rows[0].id]);
      for (const row of memberships.rows) await event(tx, { id: user.rows[0].id }, row.supplier_id, null, null, 'operator_password_reset');
    });
    console.log('Password replaced and all sessions revoked. Remove bootstrap credentials from your environment.');
  } else throw new Error('Choose migrate, seed-demo, bootstrap, or reset-password.');
} finally { await db.close(); }
