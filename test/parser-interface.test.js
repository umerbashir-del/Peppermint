import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runParserTask } from '../src/parser-interface.js';
import { validateTask } from '../src/agent-contract.js';

const task = async () => JSON.parse(await readFile(new URL('../examples/parser-task.json', import.meta.url), 'utf8'));
test('parser adapter produces supplier input without dropping any source lines', async () => {
  const input = await task();
  const result = await runParserTask(input);
  assert.equal(result.status, 'completed');
  assert.equal(result.request_id, input.request_id);
  assert.equal(result.task_id, input.task_id);
  assert.equal(result.approval_required, false);
  assert.equal(result.data.supplier_lines.length, result.data.lines.length);
  const supplierTask = { ...input, agent: 'supplier_quote_desk', task_id: 'supplier-001', input: { account_id: 'normal', branch: 'sample-main', delivery: null, lines: result.data.supplier_lines } };
  validateTask(supplierTask, 'supplier_quote_desk');
});
test('ambiguous materials, delivery notes, and fractional quantities block handoff', async () => {
  for (const text of ['stuff for the thing, 12', '20 of 2x4x8 SPF studs\ndelivery Thursday', '12.5 feet of copper pipe']) {
    const input = await task(); input.input.text = text;
    const result = await runParserTask(input);
    assert.equal(result.status, 'needs_human_review');
    assert.equal(result.data.supplier_lines, null);
    assert.ok(result.data.lines.length > 0);
    assert.ok(result.issues.every(issue => issue.retryable === false));
  }
});
test('invalid parser input produces an explicit failed envelope', async () => {
  for (const change of [input => { input.input.text = ''; }, input => { input.input.format = 'pdf'; }, input => { input.input.extra = 'not-supported'; }, input => { input.agent = 'research'; }]) {
    const input = await task(); change(input);
    const result = await runParserTask(input);
    assert.equal(result.status, 'failed');
    assert.equal(result.issues[0].code, 'INVALID_INPUT');
    assert.equal(result.data, null);
  }
});
test('bad CSV syntax is a nonretryable input failure, not a system error', async () => {
  const input = await task(); input.input = { text: 'bad,header\nwood,2', format: 'csv' };
  const result = await runParserTask(input);
  assert.equal(result.status, 'failed');
  assert.equal(result.issues[0].code, 'INVALID_INPUT');
  assert.match(result.issues[0].message, /CSV/);
});
test('parser response example matches the executable interface exactly', async () => {
  const snapshot = JSON.parse(await readFile(new URL('../examples/parser-response.json', import.meta.url), 'utf8'));
  assert.deepEqual(await runParserTask(await task()), snapshot);
});
