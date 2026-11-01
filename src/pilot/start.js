import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
if (existsSync('.env')) loadEnvFile('.env');
const { createDatabase, migrate, verifyMigrations } = await import('./database.js');
const { buildServer } = await import('./server.js');
const production = process.env.NODE_ENV === 'production';
if (production && (!process.env.DATABASE_URL || !process.env.SUPPLIER_DATA_FILE)) throw new Error('Configure production DATABASE_URL and SUPPLIER_DATA_FILE before starting.');
if (['true', '*', '1', '0.0.0.0/0', '::/0'].includes(process.env.TRUST_PROXY)) throw new Error('TRUST_PROXY must name trusted addresses/CIDRs, not all proxies.');
const db = await createDatabase();
try {
  if (!production || process.env.AUTO_MIGRATE === 'true') await migrate(db);
  else await verifyMigrations(db);
} catch (error) { await db.close(); throw error; }
let lastAlert = 0;
const alert = async event => {
  if (!process.env.ALERT_WEBHOOK_URL || Date.now() - lastAlert < 300000) return;
  const target = new URL(process.env.ALERT_WEBHOOK_URL);
  if (target.protocol !== 'https:') throw new Error('Alert webhook must use HTTPS.');
  lastAlert = Date.now();
  await fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ service: 'buildbridge', timestamp: new Date().toISOString(), ...event }), signal: AbortSignal.timeout(5000) });
};
const app = await buildServer({ db, production, alert, logger: { level: process.env.LOG_LEVEL || 'info', redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers.x-csrf-token', 'body', 'password', 'token'] }, dailyCalls: Number(process.env.DAILY_MODEL_CALLS || 200), dailyTokenBudget: Number(process.env.DAILY_TOKEN_BUDGET || 500000), metricsToken: process.env.METRICS_TOKEN });
const cleanup = setInterval(() => {
  void db.query("DELETE FROM sessions WHERE expires_at<now() OR last_seen_at<now()-interval '30 minutes'").catch(() => {});
  void db.query('DELETE FROM activation_tokens WHERE expires_at<now()').catch(() => {});
  void db.query("DELETE FROM quotas WHERE reset_at<now()-interval '1 day'").catch(() => {});
}, 60000); cleanup.unref();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { clearInterval(cleanup); await app.close(); await db.close(); process.exit(0); });
try { await app.listen({ port: Number(process.env.PORT || 3000), host: process.env.SERVER_HOST || (production ? '0.0.0.0' : '127.0.0.1') }); }
catch { clearInterval(cleanup); await app.close(); await db.close(); throw new Error('Pilot server could not listen. Check the configured port and existing server processes.'); }
