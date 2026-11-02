import test from 'node:test';
import assert from 'node:assert/strict';
import { runWebsiteAgents } from '../src/website-agents.js';
import { loadSupplier } from '../src/supplier-tools.js';
import { runResearchTask } from '../src/research-interface.js';

const input = text => ({ operation: 'run', tenant_id: 'fault-tenant', request_id: 'fault-request', text });
const load = async () => ({ binding: { supplier_id: 'pilot-supplier', account_id: 'normal', branch: 'sample-main' }, data: await loadSupplier() });
const message = text => ({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });

for (const status of [401, 403, 429, 500, 503]) test(`supplier HTTP ${status} fails safely with accurate retry classification`, async () => {
  const result = await runWebsiteAgents(input('10 of 2x4x8 SPF studs'), { load, respond: async () => { const error = new Error('private-error-sentinel'); error.status = status; throw error; } });
  assert.equal(result.ready, false);
  assert.equal(result.supplier.status, 'failed');
  assert.equal(result.supplier.issues[0].retryable, status === 429 || status >= 500);
  assert.doesNotMatch(JSON.stringify(result), /private-error-sentinel/);
  assert.equal(result.research.length, 0);
});
test('supplier malformed output and fabricated SKU cannot produce a ready quote', async () => {
  for (const output of ['not JSON', '{"matches":[{"line_id":"1","sku":"invented-sku"}]}', '{"matches":[{"line_id":"foreign-line","sku":"STUD-SPF-248"}]}']) {
    const result = await runWebsiteAgents(input('10 of 2x4x8 SPF studs'), { load, respond: async () => message(output) });
    assert.equal(result.ready, false);
    assert.ok(!result.supplier.data || result.supplier.data.total_cents === 0);
  }
});
test('supplier timeout is retryable and never leaks provider details', async () => {
  const result = await runWebsiteAgents(input('10 of 2x4x8 SPF studs'), { load, respond: async () => { const error = new Error('private-error-sentinel'); error.name = 'TimeoutError'; throw error; } });
  assert.equal(result.supplier.issues[0].retryable, true);
  assert.equal(result.ready, false);
  assert.doesNotMatch(JSON.stringify(result), /private-error-sentinel/);
});
test('research provider failure preserves supplier shortages and correlation', async () => {
  const result = await runWebsiteAgents(input('40 of 2x10x12 SPF joists'), { load, live: false, runResearch: task => runResearchTask(task, { respond: async () => { throw new Error('private-error-sentinel'); } }) });
  assert.equal(result.supplier.data.lines[0].unresolved_quantity, 25);
  assert.equal(result.research[0].status, 'failed');
  assert.equal(result.research[0].request_id, 'fault-request');
  assert.equal(result.ready, false);
  assert.doesNotMatch(JSON.stringify(result), /private-error-sentinel/);
});
for (const field of ['request_id', 'task_id', 'agent', 'line_ids']) test(`wrong research ${field} is rejected at the handoff boundary`, async () => {
  const result = await runWebsiteAgents(input('40 of 2x10x12 SPF joists'), { load, live: false, runResearch: async task => ({ schema_version: '1.0', request_id: field === 'request_id' ? 'foreign-request' : task.request_id, task_id: field === 'task_id' ? 'foreign-task' : task.task_id, agent: field === 'agent' ? 'supplier_quote_desk' : 'research', status: 'completed', approval_required: true, issues: [], handoffs: [], data: { line_ids: field === 'line_ids' ? ['foreign-line'] : task.input.line_ids, answer: 'UNRELATED-EVIDENCE', sources: [{ url: 'https://example.com', quoted_text: 'Unrelated.' }] } }) });
  assert.equal(result.research[0].status, 'failed');
  assert.doesNotMatch(JSON.stringify(result.research), /UNRELATED-EVIDENCE/);
  assert.equal(result.supplier.data.lines[0].unresolved_quantity, 25);
});
test('unexpected research adapter crash preserves supplier data and becomes a failed handoff', async () => {
  const result = await runWebsiteAgents(input('40 of 2x10x12 SPF joists'), { load, live: false, runResearch: async () => { throw new Error('private-error-sentinel'); } });
  assert.equal(result.research[0].status, 'failed');
  assert.equal(result.supplier.data.total_cents, 19320);
  assert.doesNotMatch(JSON.stringify(result), /private-error-sentinel/);
});
test('research fanout and model-call budget remain bounded', async () => {
  const result = await runWebsiteAgents(input(Array(5).fill('40 of 2x10x12 SPF joists').join('\n')), {
    load, live: false,
    runResearch: task => runResearchTask(task, { respond: async () => message('No evidence found.') }),
  });
  assert.equal(result.research.length, 3);
  assert.equal(result.research_limit_reached, true);
  assert.equal(result.ready, false);
});
test('repeated tool errors stop at twenty actual provider calls across research handoffs', async () => {
  let actual = 0;
  const result = await runWebsiteAgents(input(Array(3).fill('40 of 2x10x12 SPF joists').join('\n')), {
    load, live: false, respond: async () => { actual++; return { output: [{ type: 'function_call', name: 'unknown_tool', call_id: 'bad-call', arguments: '{}' }] }; },
  });
  assert.equal(actual, 20);
  assert.equal(result.model_calls, actual);
  assert.equal(result.ready, false);
  assert.ok(result.research.some(item => item.status === 'failed'));
});
for (const field of ['list_price_cents', 'stock', 'credit_limit_cents']) test(`invalid source ${field} stops before model calls or a draft`, async () => {
  const malformed = async () => {
    const source = await load();
    if (field === 'credit_limit_cents') source.data.accounts[0][field] = 'unknown';
    else source.data.catalog[0][field] = null;
    return source;
  };
  await assert.rejects(runWebsiteAgents(input('10 of 2x4x8 SPF studs'), { load: malformed, respond: () => { assert.fail('invalid data must not reach the model'); } }), /source is invalid/);
});
