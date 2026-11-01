import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runSupplierTask } from '../src/supplier-interface.js';
import { validateTask } from '../src/agent-contract.js';
import { loadSupplier } from '../src/supplier-tools.js';

const task = async () => JSON.parse(await readFile(new URL('../examples/supplier-task.json', import.meta.url), 'utf8'));
test('supplier task returns a draft and directly routable research handoff', async () => {
  const input = await task();
  const result = await runSupplierTask(input);
  assert.equal(result.request_id, input.request_id);
  assert.equal(result.task_id, input.task_id);
  assert.equal(result.status, 'needs_human_review');
  assert.equal(result.approval_required, true);
  assert.equal(result.data.total_cents, 19320);
  assert.equal(result.handoffs.length, 1);
  validateTask(result.handoffs[0], 'research');
  assert.deepEqual(result.handoffs[0].input.line_ids, ['1']);
  assert.equal(result.handoffs[0].request_id, input.request_id);
  assert.doesNotMatch(JSON.stringify(result.handoffs), /account_id|near-limit|credit|balance|price|stock|JOIST-/i);
  assert.equal((await runSupplierTask(input)).handoffs[0].task_id, result.handoffs[0].task_id);
});
test('normal supplier result is completed but never commercially approved', async () => {
  const input = await task();
  input.input = JSON.parse(await readFile(new URL('../examples/normal.json', import.meta.url), 'utf8'));
  const result = await runSupplierTask(input);
  assert.equal(result.status, 'completed');
  assert.equal(result.approval_required, true);
  assert.equal(result.data.status, 'draft');
  assert.equal(result.data.total_cents, 35008);
  assert.deepEqual(result.handoffs, []);
});
test('missing supplier policies and stock alone do not request public research', async () => {
  const data = await loadSupplier();
  const original = data.catalog.find(item => item.sku === 'JOIST-SPF-21012');
  const sub = data.catalog.find(item => item.sku === 'JOIST-HF-21012');
  original.specifications = sub.specifications = { size: '2x10x12', grade: 'TEST', material: 'wood' };
  const result = await runSupplierTask(await task(), { supplierData: data });
  assert.equal(result.status, 'needs_human_review');
  assert.deepEqual(result.handoffs, []);
});
test('invalid supplier inputs use the same nonretryable error envelope', async () => {
  for (const change of [input => { input.input.lines[0].quantity = -1; }, input => { input.input.lines.push({ ...input.input.lines[0] }); }, input => { input.input.delivery = { zip: 'bad' }; }, input => { input.input.branch = 'unknown'; }, input => { input.input.lines[0].required_specs = null; }]) {
    const input = await task(); change(input);
    const result = await runSupplierTask(input);
    assert.equal(result.status, 'failed');
    assert.equal(result.issues[0].code, 'INVALID_INPUT');
  }
});
test('supplier execution errors do not expose dependency secrets', async () => {
  const result = await runSupplierTask(await task(), { live: true, respond: async () => { throw new Error('secret-value'); } });
  assert.equal(result.status, 'failed');
  assert.doesNotMatch(JSON.stringify(result), /secret-value/);
});
test('checked-in supplier response snapshot has the documented result keys', async () => {
  const snapshot = JSON.parse(await readFile(new URL('../examples/supplier-response.json', import.meta.url), 'utf8'));
  const result = await runSupplierTask(await task());
  assert.deepEqual(Object.keys(snapshot), Object.keys(result));
  assert.equal(snapshot.data.total_cents, result.data.total_cents);
  assert.deepEqual(snapshot.handoffs, result.handoffs);
});
