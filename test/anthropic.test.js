import test from 'node:test';
import assert from 'node:assert/strict';
import { responses, outputText, normalizeMessage, toAnthropicRequest, DEFAULT_MODEL } from '../src/anthropic.js';

const key = 'test-only-anthropic-key';
const textMessage = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'OK' }] };
const mockFetch = callback => async (url, options) => { callback(url, options); return { ok: true, json: async () => textMessage }; };

test('requests use Anthropic endpoint/auth/version and never OpenAI fields', async () => {
  const result = await responses({ instructions: 'Be brief.', input: 'Hello', max_output_tokens: 100 }, { apiKey: key, fetchImpl: mockFetch((url, options) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(options.headers['x-api-key'], key);
    assert.equal(options.headers['anthropic-version'], '2026-10-21');
    assert.equal(options.headers.Authorization, undefined);
    const body = JSON.parse(options.body);
    assert.equal(body.model, process.env.ANTHROPIC_MODEL || DEFAULT_MODEL);
    assert.equal(body.system, 'Be brief.');
    assert.equal(body.messages[0].role, 'user');
    assert.equal(body.input, undefined);
    assert.equal(body.store, undefined);
    assert.doesNotMatch(options.body, /test-only-anthropic-key/);
  }) });
  assert.equal(outputText(result), 'OK');
});

test('tool calls and results preserve native assistant blocks and signatures', () => {
  const blocks = [{ type: 'thinking', thinking: 'private reasoning', signature: 'signature-123' }, { type: 'tool_use', id: 'toolu-1', name: 'search_catalog', input: { query: 'SPF' } }, { type: 'tool_use', id: 'toolu-2', name: 'get_account_pricing_and_credit', input: {} }];
  const response = normalizeMessage({ stop_reason: 'tool_use', content: blocks });
  assert.equal(response.output.filter(item => item.type === 'function_call').length, 2);
  assert.equal(outputText(response), '');
  const body = toAnthropicRequest({ input: [{ role: 'user', content: 'Quote this' }, ...response.output, { type: 'function_call_output', call_id: 'toolu-1', output: '{"items":[]}' }, { type: 'function_call_output', call_id: 'toolu-2', output: '{"tier":"B"}' }] });
  assert.equal(body.messages.length, 3);
  assert.deepEqual(body.messages[1], { role: 'assistant', content: blocks });
  assert.deepEqual(body.messages[2].content.map(item => item.tool_use_id), ['toolu-1', 'toolu-2']);
  assert.ok(body.messages[2].content.every(item => item.type === 'tool_result'));
});

test('function tools map to input_schema and leave business constraints to validators', () => {
  const body = toAnthropicRequest({ input: 'Validate', parallel_tool_calls: false, tools: [{ type: 'function', name: 'validate_substitution', description: 'Check', strict: true, parameters: { type: 'object', properties: { quantity: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['quantity'], additionalProperties: false } }] });
  assert.equal(body.tools[0].input_schema.properties.quantity.minimum, undefined);
  assert.match(body.tools[0].input_schema.properties.quantity.description, /minimum: 1/);
  assert.equal(body.tools[0].strict, true);
  assert.equal(body.tool_choice.disable_parallel_tool_use, true);
});

test('research search maps to Claude server search with a one-use budget', () => {
  const body = toAnthropicRequest({ input: 'Search for grade specs', tools: [{ type: 'web_search' }], max_tool_calls: 1 });
  assert.deepEqual(body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }]);
});

test('actual Claude search blocks become approved candidate sources and citations', () => {
  const response = normalizeMessage({ stop_reason: 'end_turn', content: [{ type: 'server_tool_use', id: 'server-1', name: 'web_search', input: { query: 'grade' } }, { type: 'web_search_tool_result', tool_use_id: 'server-1', content: [{ type: 'web_search_result', url: 'https://example.com/spec', title: 'Spec', encrypted_content: 'opaque' }] }, { type: 'text', text: 'Check grade.', citations: [{ type: 'web_search_result_location', url: 'https://example.com/spec', title: 'Spec', encrypted_index: 'opaque' }] }] });
  assert.equal(response.output.find(item => item.type === 'web_search_call').action.sources[0].url, 'https://example.com/spec');
  assert.equal(response.output[0].content[0].annotations[0].type, 'url_citation');
});

test('source extraction uses native structured JSON output', () => {
  const schema = { type: 'object', properties: { quoted_text: { type: ['string', 'null'] } }, required: ['quoted_text'], additionalProperties: false };
  const body = toAnthropicRequest({ input: 'Extract', text: { format: { type: 'json_schema', name: 'source_evidence', schema } } });
  assert.deepEqual(body.output_config.format, { type: 'json_schema', schema });
  assert.equal(body.tools, undefined);
});

test('authentication and provider error bodies cannot leak secrets', async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    await assert.rejects(() => responses({ input: 'Hello' }, { apiKey: key, fetchImpl: async () => ({ ok: false, status, json: () => { throw new Error('Do not read error body'); } }) }), error => {
      assert.equal(error.name, 'AnthropicApiError');
      assert.equal(error.status, status);
      assert.doesNotMatch(error.message, /test-only-anthropic-key/);
      return true;
    });
  }
});

test('truncation, refusal, paused turns, and search errors cannot look successful', () => {
  for (const stop_reason of ['max_tokens', 'refusal', 'pause_turn']) assert.throws(() => normalizeMessage({ stop_reason, content: [] }), /incomplete or refused/);
  assert.throws(() => normalizeMessage({ stop_reason: 'end_turn', content: [{ type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'unavailable' } }] }), /search failed/);
});

test('missing credentials fail before contacting the provider', async () => {
  await assert.rejects(() => responses({ input: 'Hello' }, { apiKey: '', fetchImpl: () => { throw new Error('Must not connect'); } }), /ANTHROPIC_API_KEY/);
});
