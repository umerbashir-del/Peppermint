import { readSource } from '../src/research-tools.js';

// Explicit offline fixture: this URL and sentence are test data, not a fetched source.
const url = 'https://example.com/buildbridge-test-spec';
const sentence = 'Check the manufacturer grade and species specifications before proposing any lumber substitution.';
const message = text => ({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });
export function mockResearchOptions() {
  let step = 0;
  const respond = async body => {
    if (body.text?.format?.name === 'source_evidence') return message(JSON.stringify({ quoted_text: sentence }));
    if (body.tools?.some(tool => tool.type === 'web_search')) return { output: [{ type: 'web_search_call', action: { type: 'search', sources: [{ url, title: 'Offline example fixture, not real evidence' }] } }] };
    const name = step++ === 0 ? 'web_search' : step === 2 ? 'read_source' : null;
    if (!name) return message('Offline fixture: verify manufacturer grade and species; this example does not establish equivalence.');
    return { output: [{ type: 'function_call', name, call_id: `fixture-${step}`, arguments: JSON.stringify(name === 'web_search' ? { query: 'lumber grade manufacturer specifications' } : { url }) }] };
  };
  return { respond, read: (target, question, options) => readSource(target, question, { ...options, fetchPage: async () => ({ contentType: 'text/html', body: `<p>${sentence}</p>` }) }) };
}
