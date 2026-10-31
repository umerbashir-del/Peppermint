import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { saveDraftQuote, readDraftQuote, listDraftQuotes, SAVE_DRAFT_QUOTE_TOOL } from '../src/draft-store.js';
import { renderDraftReview } from '../src/draft-review.js';
import { runSupplierTask } from '../src/supplier-interface.js';
import { runParserTask } from '../src/parser-interface.js';
import { runResearchTask } from '../src/research-interface.js';
import { mockResearchOptions } from '../examples/research-fixture.js';

async function storage(t) {
  const directory = await mkdtemp(join(tmpdir(), 'buildbridge-draft-'));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('buildbridge-draft-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory };
}
async function input(partial = false) {
  const supplierTask = JSON.parse(await readFile(new URL(partial ? '../examples/supplier-task.json' : '../examples/normal.json', import.meta.url), 'utf8'));
  const task = partial ? supplierTask : { schema_version: '1.0', request_id: 'draft-test', task_id: 'supplier-001', agent: 'supplier_quote_desk', input: supplierTask };
  return { save_id: 'save-001', supplier_result: await runSupplierTask(task), research_results: [], unresolved_questions: [] };
}

test('save and reload preserve the whole quote and force draft/rep approval', async t => {
  const options = await storage(t);
  const args = await input();
  const receipt = await saveDraftQuote(args, options);
  const record = await readDraftQuote(receipt.quote_id, options);
  assert.equal(receipt.status, 'draft');
  assert.equal(receipt.approval_required, true);
  assert.equal(receipt.review_status, 'awaiting_rep_approval');
  assert.deepEqual(record.quote, args.supplier_result.data);
  assert.equal(record.quote.total_cents, 35008);
  assert.deepEqual(record.supplier_result, args.supplier_result);
  assert.equal((await listDraftQuotes(options)).length, 1);
});

test('identical retries and reordered object keys return the same saved receipt', async t => {
  const options = await storage(t);
  const args = await input();
  const first = await saveDraftQuote(args, options);
  const reordered = Object.fromEntries(Object.entries(args).reverse());
  assert.deepEqual(await saveDraftQuote(reordered, options), first);
  assert.equal((await readdir(options.directory)).length, 1);
});

test('concurrent identical saves publish one complete record and no temporary files', async t => {
  const options = await storage(t);
  const args = await input();
  const results = await Promise.all(Array.from({ length: 5 }, () => saveDraftQuote(args, options)));
  assert.ok(results.every(value => JSON.stringify(value) === JSON.stringify(results[0])));
  assert.equal((await readdir(options.directory)).length, 1);
  assert.equal((await readDraftQuote(results[0].quote_id, options)).quote.total_cents, 35008);
});

test('changed content conflicts without overwriting; a new save ID creates a revision', async t => {
  const options = await storage(t);
  const args = await input();
  const first = await saveDraftQuote(args, options);
  args.unresolved_questions.push({ question: 'Confirm delivery access.', line_ids: ['1'] });
  await assert.rejects(() => saveDraftQuote(args, options), { code: 'SAVE_CONFLICT' });
  assert.equal((await readDraftQuote(first.quote_id, options)).unresolved_questions.length, 0);
  args.save_id = 'save-002';
  const revision = await saveDraftQuote(args, options);
  assert.notEqual(revision.quote_id, first.quote_id);
  assert.equal(revision.review_status, 'needs_human_review');
  assert.equal((await listDraftQuotes(options)).length, 2);
});

test('partial drafts retain unresolved units, supplier questions, and pending research', async t => {
  const options = await storage(t);
  const args = await input(true);
  const saved = await saveDraftQuote(args, options);
  const record = await readDraftQuote(saved.quote_id, options);
  assert.equal(record.review_status, 'needs_human_review');
  assert.equal(record.quote.total_is_partial, true);
  assert.equal(record.quote.lines[0].unresolved_quantity, 25);
  assert.ok(record.unresolved_questions.some(item => item.source === 'pending_research'));
});

test('research evidence is retained without authorizing or allocating the substitute', async t => {
  const options = await storage(t);
  const args = await input(true);
  args.research_results = [await runResearchTask(args.supplier_result.handoffs[0], mockResearchOptions())];
  const record = await readDraftQuote((await saveDraftQuote(args, options)).quote_id, options);
  assert.deepEqual(record.evidence, args.research_results);
  assert.equal(record.evidence[0].data.sources[0].page_date, null);
  assert.equal(record.quote.lines[0].unresolved_quantity, 25);
  assert.equal(record.review_status, 'needs_human_review');
  assert.ok(!record.unresolved_questions.some(item => item.source === 'pending_research'));
});

test('failed research remains attached and creates a review question', async t => {
  const options = await storage(t);
  const args = await input(true);
  args.research_results = [await runResearchTask(args.supplier_result.handoffs[0], { respond: async () => { throw new Error('private error'); } })];
  const record = await readDraftQuote((await saveDraftQuote(args, options)).quote_id, options);
  assert.equal(record.evidence[0].status, 'failed');
  assert.ok(record.unresolved_questions.some(item => item.source === 'research'));
  assert.doesNotMatch(JSON.stringify(record), /private error/);
});

test('wrong request or line IDs cannot attach evidence to a different quote', async t => {
  const options = await storage(t);
  for (const wrong of ['request', 'line']) {
    const args = await input(true);
    const result = await runResearchTask(args.supplier_result.handoffs[0], mockResearchOptions());
    if (wrong === 'request') result.request_id = 'different-request';
    else result.data.line_ids = ['missing'];
    args.research_results = [result];
    await assert.rejects(() => saveDraftQuote(args, options), { code: 'INVALID_DRAFT' });
  }
  assert.deepEqual(await listDraftQuotes(options), []);
});

test('invalid totals, changed quantities, approved statuses, and unknown fields are rejected', async t => {
  const options = await storage(t);
  for (const change of [
    args => { args.supplier_result.data.status = 'approved'; },
    args => { args.supplier_result.data.total_cents++; },
    args => { args.supplier_result.data.lines[0].quantity++; },
    args => { args.supplier_result.data.lines[0].allocations[0].line_total_cents = -1; },
    args => { args.review_status = 'approved'; },
    args => { args.supplier_result.status = 'failed'; args.supplier_result.data = null; },
    args => { args.unresolved_questions = [{ question: 'Which item?', line_ids: ['missing'] }]; },
  ]) {
    const args = await input(); change(args);
    await assert.rejects(() => saveDraftQuote(args, options), { code: 'INVALID_DRAFT' });
  }
  assert.deepEqual(await listDraftQuotes(options), []);
});

test('invalid IDs and oversized inputs cannot create paths outside draft storage', async t => {
  const options = await storage(t);
  const args = await input(); args.save_id = '../../escape';
  await assert.rejects(() => saveDraftQuote(args, options), { code: 'INVALID_DRAFT' });
  await assert.rejects(() => readDraftQuote('../../escape', options), { code: 'INVALID_DRAFT' });
  args.save_id = 'valid'; args.unresolved_questions = [{ question: 'x'.repeat(2_000_001), line_ids: [] }];
  await assert.rejects(() => saveDraftQuote(args, options), { code: 'INVALID_DRAFT' });
});

test('review report displays draft details while escaping untrusted content', async t => {
  const options = await storage(t);
  const args = await input();
  args.unresolved_questions.push({ question: '<script>alert(1)</script>', line_ids: [] });
  const record = await readDraftQuote((await saveDraftQuote(args, options)).quote_id, options);
  const html = renderDraftReview(record);
  assert.match(html, /DRAFT — rep approval required/);
  assert.match(html, /\$350\.08/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('the merged parser, supplier, research, and storage interfaces work together', async t => {
  const options = await storage(t);
  const base = { schema_version: '1.0', request_id: 'pipeline-test' };
  const parsed = await runParserTask({ ...base, task_id: 'parse', agent: 'materials_parser', input: { text: '40 of 2x10x12 SPF joists', format: 'text' } });
  const supplier_result = await runSupplierTask({ ...base, task_id: 'supplier', agent: 'supplier_quote_desk', input: { account_id: 'near-limit', branch: 'sample-main', delivery: null, lines: parsed.data.supplier_lines } });
  const research_results = [];
  for (const task of supplier_result.handoffs) research_results.push(await runResearchTask(task, mockResearchOptions()));
  const record = await readDraftQuote((await saveDraftQuote({ save_id: 'pipeline', supplier_result, research_results }, options)).quote_id, options);
  assert.equal(record.request_id, base.request_id);
  assert.equal(record.quote.total_cents, 19320);
  assert.equal(record.evidence[0].request_id, base.request_id);
  assert.equal(record.quote.status, 'draft');
  assert.equal(SAVE_DRAFT_QUOTE_TOOL.name, 'save_draft_quote');
});
