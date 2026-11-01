import { spawn } from 'node:child_process';
const hours = Number(process.env.BACKUP_INTERVAL_HOURS || 6);
if (!Number.isFinite(hours) || hours < 1) throw new Error('Backup interval must be at least one hour.');
while (true) {
  const child = spawn(process.execPath, ['ops/backup.js'], { stdio: 'inherit', env: process.env });
  const code = await new Promise(accept => { child.once('error', () => accept(1)); child.once('exit', accept); });
  if (code !== 0) { console.error('Scheduled backup failed; restart policy/monitoring must notify the operator.'); process.exit(1); }
  await new Promise(accept => setTimeout(accept, hours * 3600000));
}
