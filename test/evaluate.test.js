import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFile, evaluateCases } from '../src/evaluate.js';
import { loadSupplier } from '../src/supplier-tools.js';

test('synthetic evaluations run offline and never claim supplier-reviewed accuracy', async () => {
  const result = await evaluateFile('eval/fixtures/synthetic.jsonl', { supplierData: await loadSupplier() });
  assert.equal(result.passed, true); assert.equal(result.match_accuracy, 1); assert.equal(result.model_calls, 0);
  assert.equal(result.dataset_kind, 'synthetic_or_unreviewed'); assert.equal(result.reviewed_gate_passed, false);
  assert.equal(result.estimated_cost_usd, null);
});
test('the reviewed release gate fails on synthetic data', async () => {
  const result = await evaluateFile('eval/fixtures/synthetic.jsonl', { supplierData: await loadSupplier(), requireReviewed: true });
  assert.equal(result.passed, false);
});
test('incorrect confident catalog labels and quantities fail the quality gate', async () => {
  const cases = [{ id: 'bad-label', input: { text: '20 of 2x4x8 SPF studs', account_id: 'normal', branch: 'sample-main' }, expected: { lines: [{ line_id: '1', sku: 'WRONG', quantity: 99 }] } }];
  const result = await evaluateCases(cases, { supplierData: await loadSupplier() });
  assert.equal(result.passed, false); assert.equal(result.incorrect_confident_matches, 1); assert.equal(result.quantity_errors, 1);
});
