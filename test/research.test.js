import test from 'node:test';
import assert from 'node:assert/strict';
import { research } from '../src/research-agent.js';
test('research refuses price lookups without contacting the provider', async () => {
  const result = await research('What is the price of drywall?', { respond: () => { throw new Error('Should not call API'); } });
  assert.equal(result.status, 'needs_human_review');
});

test('research preserves provider citations and flags absent evidence', async () => {
  const respond = async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Verify the manufacturer specification.', annotations: [{ type: 'url_citation', url: 'https://example.com/spec', title: 'Test specification' }] }] }] });
  const result = await research('Which specifications should be checked for joist substitutions?', { respond });
  assert.equal(result.sources[0].url, 'https://example.com/spec');
  assert.equal(result.publication_date, null);
  const noEvidence = await research('Which specifications should be checked?', { respond: async () => ({ output: [] }) });
  assert.equal(noEvidence.status, 'needs_human_review');
});
