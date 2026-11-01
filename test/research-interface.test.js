import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runResearchTask } from '../src/research-interface.js';
import { mockResearchOptions } from '../examples/research-fixture.js';

const task = async () => JSON.parse(await readFile(new URL('../examples/research-task.json', import.meta.url), 'utf8'));
test('research adapter preserves task and line IDs with verified source structure', async () => {
  const input = await task();
  const result = await runResearchTask(input, mockResearchOptions());
  assert.equal(result.status, 'completed');
  assert.equal(result.request_id, input.request_id);
  assert.equal(result.task_id, input.task_id);
  assert.deepEqual(result.data.line_ids, ['1']);
  assert.equal(result.data.sources[0].url, 'https://example.com/buildbridge-test-spec');
  assert.equal(result.data.sources[0].page_date, null);
  assert.equal(result.approval_required, true);
  assert.deepEqual(result.handoffs, []);
});
test('unverified research returns useful review data instead of a success claim', async () => {
  const result = await runResearchTask(await task(), { respond: async () => ({ output: [] }) });
  assert.equal(result.status, 'needs_human_review');
  assert.equal(result.issues[0].code, 'RESEARCH_UNVERIFIED');
  assert.deepEqual(result.issues[0].line_ids, ['1']);
});
test('commercial questions are reviewed without calling the provider', async () => {
  const input = await task(); input.input.question = 'What is the price?';
  const result = await runResearchTask(input, { respond: () => { throw new Error('Must not call'); } });
  assert.equal(result.status, 'needs_human_review');
  assert.equal(result.data.sources.length, 0);
});
test('research input rejects unsupported fields and invalid line references', async () => {
  for (const change of [input => { input.input.question = ''; }, input => { input.input.line_ids = ['1', '1']; }, input => { input.input.line_ids = null; }, input => { input.input.account_id = 'private'; }]) {
    const input = await task(); change(input);
    const result = await runResearchTask(input, mockResearchOptions());
    assert.equal(result.status, 'failed');
    assert.equal(result.issues[0].code, 'INVALID_INPUT');
  }
});
test('research provider failures are sanitized and correlated', async () => {
  const result = await runResearchTask(await task(), { respond: async () => { throw new Error('secret-api-key'); } });
  assert.equal(result.status, 'failed');
  assert.equal(result.task_id, 'research-001');
  assert.doesNotMatch(JSON.stringify(result), /secret-api-key/);
});
test('research snapshot documents the same envelope and evidence format', async () => {
  const result = await runResearchTask(await task(), mockResearchOptions());
  const snapshot = JSON.parse(await readFile(new URL('../examples/research-response.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(result), Object.keys(snapshot));
  assert.equal(snapshot.data.sources[0].quoted_text, result.data.sources[0].quoted_text);
});
