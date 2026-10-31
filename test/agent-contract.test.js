import test from 'node:test';
import assert from 'node:assert/strict';
import { runContractTask, requireContract } from '../src/agent-contract.js';

const task = { schema_version: '1.0', request_id: 'quote-001', task_id: 'test-001', agent: 'materials_parser', input: {} };
const execute = async () => ({ status: 'completed', data: { lines: [] } });
const run = (value, action = execute) => runContractTask(value, 'materials_parser', () => {}, action);

test('common envelope preserves correlation IDs and stable result keys', async () => {
  const result = await run(task);
  assert.deepEqual(Object.keys(result).sort(), ['schema_version', 'request_id', 'task_id', 'agent', 'status', 'approval_required', 'data', 'issues', 'handoffs'].sort());
  assert.equal(result.task_id, task.task_id);
  assert.equal(result.request_id, task.request_id);
  assert.equal(result.status, 'completed');
});
test('wrong routing, versions, IDs, and extra fields fail consistently', async () => {
  for (const value of [null, { ...task, agent: 'research' }, { ...task, schema_version: '2.0' }, { ...task, request_id: '' }, { ...task, secret: 'not-allowed' }]) {
    const result = await run(value);
    assert.equal(result.status, 'failed');
    assert.equal(result.data, null);
    assert.equal(result.issues[0].code, 'INVALID_INPUT');
    assert.equal(result.issues[0].retryable, false);
  }
});
test('execution failures do not expose secret error messages', async () => {
  const result = await run(task, async () => { throw new Error('secret-key-123'); });
  assert.equal(result.issues[0].code, 'AGENT_FAILED');
  assert.doesNotMatch(JSON.stringify(result), /secret-key/);
});
test('temporary timeouts are identified without automatically replaying tasks', async () => {
  let calls = 0;
  const result = await run(task, async () => { calls++; throw new DOMException('private timeout detail', 'TimeoutError'); });
  assert.equal(calls, 1);
  assert.equal(result.issues[0].retryable, true);
});
test('input errors have explicit safe explanations', async () => {
  const result = await runContractTask(task, 'materials_parser', () => requireContract(false, 'A list is required.'), execute);
  assert.equal(result.issues[0].message, 'A list is required.');
});
