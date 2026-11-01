// Translate the workers' existing response format to Anthropic Messages.
// Public worker task/result contracts do not depend on the model provider.
export const DEFAULT_MODEL = 'claude-sonnet-5-5';

export class AnthropicApiError extends Error {
  constructor(status) {
    const hint = status === 401 ? 'The credential was rejected.' : status === 403 ? 'The credential lacks permission.' : status === 404 ? 'Check ANTHROPIC_MODEL and model access.' : status === 429 ? 'Rate limit or account quota reached.' : 'Check model access, request configuration, and billing.';
    super(`Anthropic request failed (HTTP ${status}). ${hint}`);
    this.name = 'AnthropicApiError'; this.status = status;
  }
}

function messagesFromInput(input) {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input)) throw new Error('Model input must be text or a conversation.');
  const messages = [];
  const append = (role, content) => {
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content.push(...blocks);
    else messages.push({ role, content: [...blocks] });
  };
  for (const item of input) {
    if (item.provider_replay) continue;
    if (item.provider_content) append('assistant', item.provider_content);
    else if (item.type === 'function_call_output') append('user', [{ type: 'tool_result', tool_use_id: item.call_id, content: item.output }]);
    else if (item.type === 'function_call') append('assistant', [{ type: 'tool_use', id: item.call_id, name: item.name, input: JSON.parse(item.arguments) }]);
    else if (item.role === 'user' || item.role === 'assistant') append(item.role, typeof item.content === 'string' ? item.content : item.content.map(block => ({ type: 'text', text: block.text })));
    else if (item.type === 'message') append('assistant', (item.content ?? []).map(block => ({ type: 'text', text: block.text })));
    else throw new Error('Unsupported model conversation item.');
  }
  return messages;
}

// Native strict schemas omit these unsupported grammar constraints. Business
// rules continue to enforce quantities, units, quotes, and permissions in code.
function nativeSchema(schema) {
  if (Array.isArray(schema)) return schema.map(nativeSchema);
  if (schema === null || typeof schema !== 'object') return schema;
  const constraints = ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'];
  const result = {};
  for (const [key, value] of Object.entries(schema)) if (!constraints.includes(key)) result[key] = nativeSchema(value);
  const notes = constraints.filter(key => Object.hasOwn(schema, key)).map(key => `${key}: ${schema[key]}`);
  if (notes.length) result.description = [result.description, ...notes].filter(Boolean).join('; ');
  return result;
}

export function toAnthropicRequest(body) {
  const effort = process.env.ANTHROPIC_EFFORT || 'low';
  if (!['low', 'medium', 'high'].includes(effort)) throw new Error('ANTHROPIC_EFFORT must be low, medium, or high.');
  const request = {
    model: process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
    max_tokens: Math.max(2048, body.max_output_tokens ?? 4096),
    system: body.instructions ?? '', messages: messagesFromInput(body.input),
    output_config: { effort },
  };
  const tools = (body.tools ?? []).map(tool => {
    if (tool.type === 'web_search') return { type: 'web_search_20250305', name: 'web_search', max_uses: body.max_tool_calls ?? 1 };
    if (tool.type !== 'function') throw new Error('Unsupported model tool.');
    return { name: tool.name, description: tool.description, input_schema: nativeSchema(tool.parameters), ...(tool.strict === true ? { strict: true } : {}) };
  });
  if (tools.length) {
    request.tools = tools;
    // Auto is compatible with adaptive thinking. Results without actual search
    // evidence are rejected by the research worker rather than trusted as facts.
    request.tool_choice = { type: 'auto', ...(body.parallel_tool_calls === false ? { disable_parallel_tool_use: true } : {}) };
  }
  if (body.text?.format?.type === 'json_schema') request.output_config.format = { type: 'json_schema', schema: nativeSchema(body.text.format.schema) };
  return request;
}

export function normalizeMessage(message) {
  if (!Array.isArray(message.content) || !['end_turn', 'tool_use', 'stop_sequence'].includes(message.stop_reason)) throw new Error('Anthropic returned an incomplete or refused response. No result was approved.');
  const text = message.content.filter(block => block.type === 'text').map(block => ({
    type: 'output_text', text: block.text,
    annotations: (block.citations ?? []).filter(citation => citation.type === 'web_search_result_location').map(citation => ({ type: 'url_citation', url: citation.url, title: citation.title })),
  }));
  const output = [{ type: 'message', role: 'assistant', content: text, provider_content: message.content }];
  for (const block of message.content) {
    if (block.type === 'tool_use') output.push({ type: 'function_call', name: block.name, call_id: block.id, arguments: JSON.stringify(block.input), provider_replay: true });
    if (block.type === 'web_search_tool_result') {
      if (!Array.isArray(block.content)) throw new Error('Anthropic web search failed. No source evidence was returned.');
      output.push({ type: 'web_search_call', action: { type: 'search', sources: block.content.filter(item => item.type === 'web_search_result').map(item => ({ url: item.url, title: item.title })) }, provider_replay: true });
    }
  }
  return { status: 'completed', output };
}

export async function responses(body, { fetchImpl = fetch, apiKey = process.env.ANTHROPIC_API_KEY, signal } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey === 'your_api_key_here') throw new Error('Add ANTHROPIC_API_KEY to your local .env file first.');
  const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'x-api-key': apiKey, 'anthropic-version': '2026-10-21', 'Content-Type': 'application/json' },
    body: JSON.stringify(toAnthropicRequest(body)), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000),
  });
  // Never print provider error bodies: they may contain credentials/input data.
  if (!response.ok) throw new AnthropicApiError(response.status);
  const message = await response.json();
  const result = normalizeMessage(message);
  result.usage = { input_tokens: message.usage?.input_tokens ?? 0, output_tokens: message.usage?.output_tokens ?? 0, search_requests: message.usage?.server_tool_use?.web_search_requests ?? 0 };
  return result;
}

export function outputText(response) {
  return (response.output ?? []).flatMap(item => item.content ?? []).filter(item => item.type === 'output_text').map(item => item.text).join('\n');
}
