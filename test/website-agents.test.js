import test from 'node:test';
import assert from 'node:assert/strict';
import { runWebsiteAgents } from '../src/website-agents.js';
import { loadSupplier } from '../src/supplier-tools.js';
import { runResearchTask } from '../src/research-interface.js';
import { mockResearchOptions } from '../examples/research-fixture.js';
import { websiteSupplier } from '../src/website-agents.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const input = text => ({ operation: 'run', tenant_id: 'tenant-a', request_id: 'website-test', text });
const load = async () => ({ binding: { account_id: 'normal', branch: 'sample-main' }, data: await loadSupplier() });

test('progress follows actual parser and supplier work and skips unnecessary research', async () => {
  const events = [];
  const result = await runWebsiteAgents(input('10 of 2x4x8 SPF studs'), { load, live: false, onProgress: event => events.push(event) });
  assert.equal(result.ready, true);
  assert.deepEqual(events, [
    { stage: 'materials', status: 'running' }, { stage: 'materials', status: 'complete' },
    { stage: 'supplier', status: 'running' }, { stage: 'supplier', status: 'complete' },
    { stage: 'research', status: 'skipped' },
  ]);
  events.length = 0;
  await runWebsiteAgents({ ...input(), operation: 'check', lines: result.lines, commercial_total_cents: 3864 }, { load, onProgress: event => events.push(event) });
  assert.deepEqual(events, [], 'approval checks cannot invent agent progress');
});

test('research reports working before the handoff returns, while ambiguous parsing stops early', async () => {
  const events = [];
  await runWebsiteAgents(input('40 of 2x10x12 SPF joists'), {
    load, live: false, onProgress: event => events.push(event),
    runResearch: async task => {
      assert.deepEqual(events.at(-1), { stage: 'research', status: 'running' });
      return runResearchTask(task, mockResearchOptions());
    },
  });
  assert.deepEqual(events.at(-1), { stage: 'research', status: 'complete' });
  events.length = 0;
  await runWebsiteAgents(input('some wood'), { load, live: false, onProgress: event => events.push(event) });
  assert.deepEqual(events, [{ stage: 'materials', status: 'running' }, { stage: 'materials', status: 'needs_input' }]);
});
test('website runs the real parser and supplier and preserves exact discounted totals', async () => {
  const result = await runWebsiteAgents(input('10 of 2x4x8 SPF studs'), { load, live: false });
  assert.equal(result.ready, true);
  assert.equal(result.supplier.data.total_cents, 3864);
  assert.equal(result.supplier.approval_required, true);
  const checked = await runWebsiteAgents({ ...input(), operation: 'check', lines: result.lines, commercial_total_cents: 3864 }, { load });
  assert.equal(result.fingerprint, checked.fingerprint);
  assert.equal(checked.ready, true);
});
test('supplier specification handoffs actually run research but cannot approve substitutes', async () => {
  let calls = 0;
  const result = await runWebsiteAgents(input('40 of 2x10x12 SPF joists'), { load, live: false, runResearch: async task => { calls++; return runResearchTask(task, mockResearchOptions()); } });
  assert.ok(calls > 0);
  assert.equal(result.research[0].status, 'completed');
  assert.equal(result.ready, false);
  assert.equal(result.supplier.data.lines[0].unresolved_quantity, 25);
});
test('ambiguous lists stop before supplier or model calls', async () => {
  const result = await runWebsiteAgents(input('some wood'), { load, respond: () => { throw new Error('must not call'); } });
  assert.equal(result.supplier, null);
  assert.equal(result.ready, false);
});
test('a fenced supplier JSON response is parsed without weakening match validation', async () => {
  const respond = async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: '```json\n{"matches":[{"line_id":"1","sku":"STUD-SPF-248"}]}\n```' }] }] });
  const result = await runWebsiteAgents(input('10 of 2x4x8 SPF studs'), { load, respond });
  assert.equal(result.ready, true);
  assert.equal(result.supplier.data.total_cents, 3864);
});
test('binding failures prevent access and checks include tax and markup in credit', async () => {
  await assert.rejects(runWebsiteAgents(input('10 studs'), { load: async () => { throw new Error('denied'); } }), /denied/);
  const result = await runWebsiteAgents(input('10 of 2x4x8 SPF studs'), { load, live: false });
  const checked = await runWebsiteAgents({ ...input(), operation: 'check', lines: result.lines, commercial_total_cents: 400000 }, { load });
  assert.equal(checked.ready, false);
});
test('production bindings deny other tenants and do not invent source permissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'buildbridge-binding-'));
  const priorFile = process.env.QBC_SUPPLIER_BINDINGS_FILE, priorMode = process.env.NODE_ENV;
  try {
    const data = { ...await loadSupplier(), sample_data: false, supplier_id: 's1', as_of: new Date().toISOString() };
    await writeFile(join(directory, 'source.json'), JSON.stringify(data));
    await writeFile(join(directory, 'bindings.json'), JSON.stringify({ 'tenant-a': { supplier_id: 's1', account_id: 'normal', branch: 'sample-main', source_file: 'source.json' } }));
    process.env.QBC_SUPPLIER_BINDINGS_FILE = join(directory, 'bindings.json'); process.env.NODE_ENV = 'production';
    await assert.rejects(websiteSupplier('tenant-b'), /No supplier access/);
    const result = await runWebsiteAgents(input('10 of 2x4x8 SPF studs'), { live: false });
    assert.equal(result.ready, true);
    const checked = await runWebsiteAgents({ ...input(), operation: 'check', lines: result.lines, commercial_total_cents: 3864 });
    assert.equal(checked.ready, false);
    assert.equal(checked.source_permissions.commercial_use, null);
    data.commercial_use = true; data.stock_confirmed = true; data.valid_until = new Date(Date.now() + 60000).toISOString();
    await writeFile(join(directory, 'source.json'), JSON.stringify(data));
    const approved = await runWebsiteAgents({ ...input(), operation: 'check', lines: result.lines, commercial_total_cents: 3864 });
    assert.equal(approved.ready, true);
    data.as_of = '2020-01-01T00:00:00Z'; await writeFile(join(directory, 'source.json'), JSON.stringify(data));
    await assert.rejects(websiteSupplier('tenant-a'), /stale/);
  } finally {
    if (priorFile === undefined) delete process.env.QBC_SUPPLIER_BINDINGS_FILE; else process.env.QBC_SUPPLIER_BINDINGS_FILE = priorFile;
    if (priorMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = priorMode;
    await rm(directory, { recursive: true, force: true });
  }
});

test('hosted demo catalog requires an exact tenant allowlist and preserves sample provenance', async () => {
  const prior = Object.fromEntries(['NODE_ENV','QBC_SUPPLIER_BINDINGS_FILE','QBC_DEMO_SUPPLIER_TENANTS','QBC_ALLOW_SAMPLE_SUPPLIER'].map(key => [key,process.env[key]]));
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.QBC_SUPPLIER_BINDINGS_FILE;
    process.env.QBC_ALLOW_SAMPLE_SUPPLIER = 'true';
    delete process.env.QBC_DEMO_SUPPLIER_TENANTS;
    await assert.rejects(websiteSupplier('buildbridge-demo'), /Configure supplier access/);
    process.env.QBC_DEMO_SUPPLIER_TENANTS = ' buildbridge-demo ';
    const source = await websiteSupplier('buildbridge-demo');
    assert.equal(source.data.sample_data, true);
    assert.equal(source.binding.account_id, 'normal');
    await assert.rejects(websiteSupplier('buildbridge-demo-other'), /Configure supplier access/);
    const result = await runWebsiteAgents({...input('10 of 2x4x8 SPF studs'),tenant_id:'buildbridge-demo'}, {live:false});
    assert.equal(result.supplier.data.sample_data,true);
    assert.equal(result.supplier.data.total_cents,3864);
    assert.equal(result.ready,true);
    process.env.QBC_SUPPLIER_BINDINGS_FILE = 'missing-private-binding.json';
    await assert.rejects(websiteSupplier('buildbridge-demo'), /ENOENT/);
  } finally { for (const [key,value] of Object.entries(prior)) { if(value===undefined)delete process.env[key];else process.env[key]=value; } }
});
