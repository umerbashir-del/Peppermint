import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
if (existsSync('.env')) loadEnvFile('.env');
const { runWebsiteAgents } = await import('./website-agents.js');
try {
  let text = '';
  for await (const chunk of process.stdin) { text += chunk; if (text.length > 250000) throw new Error('Input too large.'); }
  const input = JSON.parse(text);
  if (!['context', 'run', 'check'].includes(input.operation) || typeof input.tenant_id !== 'string') throw new Error('Invalid request.');
  const options = input.progress_events ? { onProgress: event => { process.stdout.write(JSON.stringify({ type: 'progress', event }) + '\n'); } } : {};
  const reply = { ok: true, result: await runWebsiteAgents(input, options) };
  process.stdout.write(JSON.stringify(input.progress_events ? { type: 'result', reply } : reply) + '\n');
} catch {
  process.stdout.write(JSON.stringify({ ok: false, error: 'Supplier agents could not finish. Check supplier access, Anthropic credentials, and source freshness on the server.' }));
  process.exitCode = 1;
}
