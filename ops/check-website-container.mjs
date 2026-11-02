// CI smoke test for the actual Python+Node image and a persistent SQLite volume.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

const image = process.argv[2] || 'buildbridge-website-check';
const name = 'buildbridge-smoke-' + randomUUID();
const volume = name + '-data';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60000 }).trim();
let started = false;
try {
  docker('volume', 'create', volume);
  docker('run', '-d', '--name', name, '-p', '127.0.0.1::10000', '--mount', `source=${volume},target=/var/data`,
    '-e', 'QBC_SECRET_KEY=ci-only-signing-secret-at-least-32-characters',
    '-e', 'QBC_BOOTSTRAP_SECRET=ci-only-bootstrap', '-e', 'ANTHROPIC_API_KEY=ci-dummy-key',
    '-e', 'ANTHROPIC_MODEL=ci-dummy-model', '-e', 'QBC_CORS_ORIGINS=https://frontend.example', image);
  started = true;
  const port = docker('port', name, '10000/tcp').split(':').at(-1);
  const base = `http://127.0.0.1:${port}`;
  async function ready() {
    for (let n = 0; n < 60; n++) {
      try { if ((await fetch(base + '/ready', { signal: AbortSignal.timeout(2000) })).ok) return; } catch { /* starting */ }
      await setTimeout(500);
    }
    throw new Error('Website container did not become ready.');
  }
  await ready();
  const status = docker('exec', name, 'python', '-c', "print(open('/proc/1/status').read())");
  assert.match(status, /Uid:\s+10001\s+10001/);
  assert.match(docker('exec', name, 'node', '--version'), /^v24\./);
  const parser = docker('exec', name, 'node', '--input-type=module', '-e',
    "import {runParserTask} from './src/parser-interface.js'; const r=await runParserTask({schema_version:'1.0',request_id:'ci',task_id:'parse',agent:'materials_parser',input:{text:'10 of 2x4x8 SPF studs',format:'text'}}); if(r.status!=='completed')process.exit(1);console.log(r.data.supplier_lines.length);");
  assert.equal(parser, '1');
  const credentials = { tenant_id: 'ci-workspace', email: 'owner@ci.example', password: 'ci-only-correct-horse-battery-staple' };
  const boot = await fetch(base + '/auth/bootstrap', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bootstrap-Secret': 'ci-only-bootstrap' }, body: JSON.stringify(credentials) });
  assert.equal(boot.status, 200);
  const signIn = async () => {
    const r = await fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://frontend.example' }, body: JSON.stringify(credentials) });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://frontend.example');
    return (await r.json()).access_token;
  };
  let token = await signIn();
  const project = await fetch(base + '/projects', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ name: 'Persistent CI project' }) });
  assert.equal(project.status, 200);
  docker('restart', name);
  await ready();
  token = await signIn();
  const projects = await (await fetch(base + '/projects', { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.ok(projects.some(item => item.name === 'Persistent CI project'));
  const audit = await (await fetch(base + '/audit/verify', { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(audit.ok, true);
  console.log('Website image passed: non-root API, Node parser, cross-origin sign-in, restart persistence, and audit verification.');
} catch (error) {
  if (started) console.error(docker('logs', name));
  throw error;
} finally {
  if (started) docker('rm', '-f', name);
  docker('volume', 'rm', volume);
}
