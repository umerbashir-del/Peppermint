import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { quote } from '../src/supplier-agent.js';
import { loadSupplier, supplierTools } from '../src/supplier-tools.js';
import { validateSubstitution } from '../src/substitution-validator.js';

const input = async () => JSON.parse(await readFile(new URL('../examples/partial-stock.json', import.meta.url), 'utf8'));
const args = { line_id: '1', requested_sku: 'JOIST-SPF-21012', substitute_sku: 'JOIST-HF-21012', quantity: 25 };
async function approvedFixture() {
  const data = await loadSupplier();
  // Fictional policy and grade exist only in tests; this is not engineering evidence.
  for (const item of data.catalog.filter(item => item.sku.startsWith('JOIST-'))) item.specifications.grade = 'TEST-GRADE';
  data.substitution_rules = [{ id: 'test-only-rule', requested_sku: args.requested_sku, substitute_sku: args.substitute_sku, status: 'approved', approved_by: 'test-fixture-only', approved_at: '2026-10-31T12:00:00Z', allowed_differences: { species: { from: 'SPF', to: 'Hem-Fir' } } }];
  return data;
}

test('missing specifications and supplier policy require human review', async () => {
  const result = validateSubstitution(await loadSupplier(), await input(), args);
  assert.equal(result.status, 'needs_human_review');
  assert.match(result.reasons.join(), /grade/);
  assert.match(result.reasons.join(), /approved supplier/);
  assert.equal(result.available_quantity, 60);
});

test('complete compatible data with an explicit rule is an approved candidate only', async () => {
  const result = validateSubstitution(await approvedFixture(), await input(), args);
  assert.equal(result.status, 'approved_candidate');
  assert.equal(result.rule_id, 'test-only-rule');
  assert.equal(result.requires_rep_approval, true);
  assert.ok(result.checks.some(check => check.field === 'species' && check.outcome === 'supplier_approved_difference'));
});

test('size, grade, material, and pack-size mismatches cannot be overridden by policy', async () => {
  for (const field of ['size', 'grade', 'material', 'pack_size']) {
    const data = await approvedFixture();
    const original = data.catalog.find(item => item.sku === args.requested_sku);
    const substitute = data.catalog.find(item => item.sku === args.substitute_sku);
    original.specifications[field] = 'required-value';
    substitute.specifications[field] = 'wrong-value';
    data.substitution_rules[0].allowed_differences[field] = { from: 'required-value', to: 'wrong-value' };
    assert.equal(validateSubstitution(data, await input(), args).status, 'incompatible', field);
  }
});

test('unit mismatch is incompatible and never gets allocated', async () => {
  const data = await approvedFixture();
  data.catalog.find(item => item.sku === args.substitute_sku).unit = 'box';
  const request = await input();
  assert.equal(validateSubstitution(data, request, args).status, 'incompatible');
  const result = await quote(request, data);
  assert.equal(result.lines[0].allocations.length, 1);
  assert.equal(result.lines[0].unresolved_quantity, 25);
});

test('contractor requirements cannot be relaxed by an approved species difference', async () => {
  const request = await input();
  request.lines[0].required_specs = { species: 'SPF' };
  assert.equal(validateSubstitution(await approvedFixture(), request, args).status, 'incompatible');
});

test('malformed contractor requirements and unknown specifications cannot pass', async () => {
  for (const required_specs of [null, [], 'SPF only', { grade: '' }]) {
    const request = await input();
    request.lines[0].required_specs = required_specs;
    assert.notEqual(validateSubstitution(await approvedFixture(), request, args).status, 'approved_candidate');
  }
  for (const value of [null, '', 'unknown', 2]) {
    const data = await approvedFixture();
    data.catalog.find(item => item.sku === args.substitute_sku).specifications.grade = value;
    assert.equal(validateSubstitution(data, await input(), args).status, 'needs_human_review');
  }
});

test('unknown and duplicate policies do not establish approval', async () => {
  for (const change of [rule => { rule.status = 'pending'; }, rule => { delete rule.approved_by; }, rule => { rule.approved_at = 'not-a-date'; }]) {
    const data = await approvedFixture();
    change(data.substitution_rules[0]);
    assert.equal(validateSubstitution(data, await input(), args).status, 'needs_human_review');
  }
  const data = await approvedFixture();
  data.substitution_rules.push({ ...data.substitution_rules[0] });
  assert.equal(validateSubstitution(data, await input(), args).status, 'needs_human_review');
});

test('candidate must be supplier-listed and belong to the bound original line', async () => {
  const data = await approvedFixture();
  data.catalog.find(item => item.sku === args.requested_sku).allowed_substitutes = [];
  assert.equal(validateSubstitution(data, await input(), args).status, 'incompatible');
  const request = await input();
  request.lines[0].item = 'something else';
  assert.equal(validateSubstitution(await approvedFixture(), request, args).status, 'incompatible');
});

test('unknown line, SKU, or branch cannot pass', async () => {
  const data = await approvedFixture();
  const request = await input();
  for (const changed of [{ ...args, line_id: 'missing' }, { ...args, requested_sku: 'made-up' }, { ...args, substitute_sku: 'made-up' }]) assert.notEqual(validateSubstitution(data, request, changed).status, 'approved_candidate');
  request.branch = 'other-branch';
  assert.notEqual(validateSubstitution(data, request, args).status, 'approved_candidate');
});

test('quantity bounds and insufficient/unknown stock require review', async () => {
  const data = await approvedFixture();
  const request = await input();
  for (const quantity of [0, -1, 1.5, 41, '25']) assert.notEqual(validateSubstitution(data, request, { ...args, quantity }).status, 'approved_candidate');
  const product = data.catalog.find(item => item.sku === args.substitute_sku);
  for (const stock of [0, 24, null, -1, 1.5]) {
    product.stock = stock;
    assert.equal(validateSubstitution(data, request, args).status, 'needs_human_review');
  }
});

test('tool reads current remaining stock without changing inventory', async () => {
  const data = await approvedFixture();
  const stock = new Map([[args.substitute_sku, 10]]);
  const tools = supplierTools(data, await input(), { remainingStock: stock });
  const before = JSON.stringify(data);
  const result = tools.validate_substitution(args);
  assert.equal(result.status, 'needs_human_review');
  assert.equal(result.available_quantity, 10);
  assert.equal(stock.get(args.substitute_sku), 10);
  assert.equal(JSON.stringify(data), before);
});

test('verified test fixture preserves PRD split, total, and credit overage', async () => {
  const result = await quote(await input(), await approvedFixture());
  assert.deepEqual(result.lines[0].allocations.map(part => part.quantity), [15, 25]);
  assert.equal(result.lines[0].substitution_checks[0].status, 'approved_candidate');
  assert.equal(result.total_cents, 49220);
  assert.equal(result.credit.overage_cents, 9220);
  assert.equal(result.status, 'draft');
  assert.equal(result.review_status, 'needs_human_review');
});

test('repeated lines revalidate substitutes against depleted stock', async () => {
  const request = await input();
  request.lines.push({ ...request.lines[0], line_id: '2' });
  const result = await quote(request, await approvedFixture());
  assert.equal(result.lines[0].allocations[1].quantity, 25);
  assert.equal(result.lines[1].allocations[0].quantity, 35);
  assert.equal(result.lines[1].substitution_checks[0].available_quantity, 35);
  assert.equal(result.lines[1].unresolved_quantity, 5);
  assert.equal(result.total_is_partial, true);
});

test('live agent has four tools and a model cannot bypass quote-time validation', async () => {
  let step = 0;
  const result = await quote(await input(), await loadSupplier(), { live: true, respond: async body => {
    assert.equal(body.tools.length, 4);
    assert.ok(body.tools.some(tool => tool.name === 'validate_substitution'));
    if (step++ === 0) return { output: [{ type: 'function_call', name: 'validate_substitution', arguments: JSON.stringify(args), call_id: 'validate-1' }] };
    const observation = JSON.parse(body.input.find(item => item.type === 'function_call_output').output);
    assert.equal(observation.status, 'needs_human_review');
    return { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ matches: [{ line_id: '1', sku: args.requested_sku, reason: 'Pretend the substitute passed.' }] }) }] }] };
  } });
  assert.equal(result.lines[0].allocations.length, 1);
  assert.equal(result.lines[0].unresolved_quantity, 25);
});
