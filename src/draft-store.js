import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, readFile, readdir, unlink, rmdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTask } from './agent-contract.js';

const DEFAULT_DIRECTORY = fileURLToPath(new URL('../output/drafts/', import.meta.url));
const id = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const cents = value => Number.isSafeInteger(value) && value >= 0;
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

export class DraftStoreError extends Error {
  constructor(code, message) { super(message); this.name = 'DraftStoreError'; this.code = code; }
}
const check = (condition, message) => { if (!condition) throw new DraftStoreError('INVALID_DRAFT', message); };

export const SAVE_DRAFT_QUOTE_TOOL = {
  type: 'function', name: 'save_draft_quote', strict: false,
  description: 'Persist a supplier draft with correlated research results and unresolved questions. Idempotent per request/save ID. Can never approve, send, reserve, or place an order.',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      save_id: { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,128}$' },
      supplier_result: { type: 'object', description: 'The complete v1.0 runSupplierTask result, without modifying its draft.' },
      research_results: { type: 'array', maxItems: 100, items: { type: 'object' }, description: 'Complete v1.0 runResearchTask results for this request, including failed/review results.' },
      unresolved_questions: { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: false, required: ['question', 'line_ids'], properties: { question: { type: 'string', minLength: 1, maxLength: 3000 }, line_ids: { type: 'array', items: { type: 'string' } } } } },
    }, required: ['save_id', 'supplier_result'],
  },
};

function workerResult(result, agent, requestId) {
  check(object(result) && result.schema_version === '1.0' && result.agent === agent && id(result.request_id) && id(result.task_id), 'A valid v1.0 worker result with correlation IDs is required.');
  check(!requestId || result.request_id === requestId, 'Worker results must belong to the same request.');
  check(['completed', 'needs_human_review', 'failed'].includes(result.status), 'Unknown worker result status.');
  check(typeof result.approval_required === 'boolean' && Array.isArray(result.issues) && Array.isArray(result.handoffs), 'Worker approval, issues, and handoffs are required.');
  check(result.status === 'failed' ? result.data === null : object(result.data), 'Worker result data does not match its status.');
}

function validateInput(input) {
  check(object(input) && Object.keys(input).every(key => ['save_id', 'supplier_result', 'research_results', 'unresolved_questions'].includes(key)), 'Unsupported draft input fields.');
  check(id(input.save_id), 'A save_id of 1–128 letters, digits, dots, underscores, colons, or hyphens is required.');
  const supplier = input.supplier_result;
  workerResult(supplier, 'supplier_quote_desk');
  check(supplier.status !== 'failed' && supplier.approval_required === true, 'A successful supplier draft requiring approval is needed before saving.');
  const quote = supplier.data;
  check(quote.status === 'draft' && ['needs_human_review', 'awaiting_rep_approval'].includes(quote.review_status), 'Only unapproved supplier drafts can be saved.');
  check(quote.currency === 'USD' && cents(quote.subtotal_cents) && cents(quote.total_cents), 'Draft totals must be nonnegative integer USD cents.');
  check(Array.isArray(quote.lines) && quote.lines.length > 0 && quote.lines.length <= 100, 'A draft must preserve 1–100 material lines.');
  check(Array.isArray(quote.needs_human_review) && quote.needs_human_review.every(value => typeof value === 'string'), 'Draft review reasons are required.');
  const lineIds = new Set();
  let subtotal = 0;
  for (const line of quote.lines) {
    check(typeof line.line_id === 'string' && line.line_id.length > 0 && !lineIds.has(line.line_id), 'Draft line IDs must be unique.');
    lineIds.add(line.line_id);
    check(Number.isSafeInteger(line.quantity) && line.quantity > 0 && cents(line.unresolved_quantity) && Array.isArray(line.allocations), 'Line quantities and allocations are invalid.');
    let allocated = 0;
    for (const allocation of line.allocations) {
      check(Number.isSafeInteger(allocation.quantity) && allocation.quantity > 0 && cents(allocation.line_total_cents), 'Allocated quantities/prices must be nonnegative whole values.');
      allocated += allocation.quantity; subtotal += allocation.line_total_cents;
    }
    check(allocated + line.unresolved_quantity === line.quantity, 'Allocated and unresolved quantities must preserve the requested quantity.');
    if (line.unresolved_quantity) check(quote.total_is_partial === true, 'An unresolved line must be marked as a partial quote.');
  }
  const fee = quote.delivery === null ? 0 : quote.delivery?.fee_cents;
  check(cents(fee) && subtotal === quote.subtotal_cents && subtotal + fee === quote.total_cents, 'Draft totals do not reconcile with saved lines and delivery.');
  check(object(quote.credit) && ['within_limit', 'would_exceed', 'incomplete_estimate', 'unavailable'].includes(quote.credit.status), 'Draft credit status is required.');
  const research = input.research_results ?? [];
  const questions = input.unresolved_questions ?? [];
  check(Array.isArray(research) && research.length <= 100 && Array.isArray(questions) && questions.length <= 100, 'Research results and questions must be arrays of at most 100 entries.');
  const validateLines = ids => check(Array.isArray(ids) && new Set(ids).size === ids.length && ids.every(value => lineIds.has(value)), 'Evidence/questions must reference unique existing quote line IDs.');
  for (const item of supplier.issues) {
    check(object(item) && typeof item.message === 'string', 'Supplier review issues must have text.');
    validateLines(item.line_ids);
  }
  const handoffIds = new Set();
  for (const handoff of supplier.handoffs) {
    try { validateTask(handoff, 'research'); } catch { check(false, 'Supplier handoffs must be valid research tasks.'); }
    check(handoff.request_id === supplier.request_id && !handoffIds.has(handoff.task_id), 'Research handoffs must be unique and belong to this request.');
    handoffIds.add(handoff.task_id); validateLines(handoff.input.line_ids);
  }
  const tasks = new Set();
  for (const result of research) {
    workerResult(result, 'research', supplier.request_id);
    check(!tasks.has(result.task_id), 'Research task results must be unique; keep the final result for each task.'); tasks.add(result.task_id);
    if (result.status === 'failed') continue;
    validateLines(result.data.line_ids);
    const handoff = supplier.handoffs.find(task => task.task_id === result.task_id);
    if (handoff) check(JSON.stringify([...handoff.input.line_ids].sort()) === JSON.stringify([...result.data.line_ids].sort()), 'Research result line IDs must match the requested handoff.');
    check(Array.isArray(result.data.sources), 'Research sources must be an array.');
    if (result.status === 'completed') check(result.data.sources.length > 0 && result.approval_required === true, 'Completed research needs source evidence and human approval.');
    for (const source of result.data.sources) {
      let url;
      try { url = new URL(source.url); } catch { check(false, 'Evidence source URL is invalid.'); }
      check(url.protocol === 'https:' && !url.username && !url.password, 'Evidence source URLs must be HTTPS without credentials.');
      check(typeof source.quoted_text === 'string' && source.quoted_text.trim().length > 0, 'Evidence must preserve quoted source text.');
      check(typeof source.date_fetched === 'string' && !Number.isNaN(Date.parse(source.date_fetched)), 'Evidence fetch date is required.');
      check(source.page_date === null || (typeof source.page_date === 'string' && !Number.isNaN(Date.parse(source.page_date))), 'Unknown publication dates must remain null.');
    }
  }
  for (const question of questions) {
    check(object(question) && Object.keys(question).every(key => ['question', 'line_ids'].includes(key)) && typeof question.question === 'string' && question.question.trim().length > 0 && question.question.length <= 3000, 'Each unresolved question needs text and line_ids.');
    validateLines(question.line_ids);
  }
  return { supplier, quote, research, questions, lineIds };
}

function assemble(input) {
  const { supplier, quote, research, questions } = validateInput(input);
  const unresolved = [];
  const add = (question, line_ids, source) => {
    if (!unresolved.some(item => item.question === question && JSON.stringify(item.line_ids) === JSON.stringify(line_ids))) unresolved.push({ question, line_ids, source });
  };
  for (const message of quote.needs_human_review) add(message, [], 'supplier');
  for (const line of quote.lines) if (line.unresolved_quantity) add(`Resolve ${line.unresolved_quantity} unfulfilled units for line ${line.line_id}.`, [line.line_id], 'supplier');
  for (const item of supplier.issues) add(typeof item.message === 'string' ? item.message : 'Supplier result requires review.', Array.isArray(item.line_ids) ? item.line_ids : [], 'supplier');
  for (const handoff of supplier.handoffs) {
    const result = research.find(result => result.task_id === handoff.task_id && result.status === 'completed');
    if (!result) add(handoff.input?.question ?? 'Requested research remains unresolved.', handoff.input?.line_ids ?? [], 'pending_research');
  }
  for (const result of research) if (result.status !== 'completed' || result.issues.length) add(`Research task ${result.task_id} requires review.`, result.data?.line_ids ?? [], 'research');
  for (const item of questions) add(item.question, item.line_ids, 'manual');
  const requiresReview = supplier.status === 'needs_human_review' || quote.review_status === 'needs_human_review' || quote.total_is_partial || quote.credit.status !== 'within_limit' || unresolved.length > 0;
  const review_status = requiresReview ? 'needs_human_review' : 'awaiting_rep_approval';
  return { request_id: supplier.request_id, status: 'draft', review_status, approval_required: true, quote, unresolved_questions: unresolved, evidence: research, supplier_result: supplier };
}

function receipt(record) {
  return { quote_id: record.quote_id, request_id: record.request_id, status: 'draft', review_status: record.review_status, approval_required: true, saved_at: record.saved_at };
}

export function prepareDraftContent(input) {
  let serialized;
  try { serialized = JSON.stringify(input); } catch { throw new DraftStoreError('INVALID_DRAFT', 'Draft input must be JSON serializable.'); }
  check(typeof serialized === 'string' && Buffer.byteLength(serialized) <= 2_000_000, 'Draft input must be JSON data of at most 2 MB.');
  const snapshot = JSON.parse(serialized);
  const contents = assemble(snapshot);
  const content_hash = sha(JSON.stringify(canonical(snapshot)));
  return { snapshot, contents, content_hash };
}

export async function saveDraftQuote(input, { directory = DEFAULT_DIRECTORY } = {}) {
  const { snapshot, contents, content_hash } = prepareDraftContent(input);
  const quote_id = 'draft-' + sha(JSON.stringify([contents.request_id, snapshot.save_id]));
  const root = resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, quote_id);
  const existing = async () => {
    const record = JSON.parse(await readFile(join(path, 'record.json'), 'utf8'));
    if (record.content_hash !== content_hash) throw new DraftStoreError('SAVE_CONFLICT', 'This save_id already holds different content. Use a new save_id for a revised draft.');
    return receipt(record);
  };
  try { return await existing(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const record = { schema_version: '1.0', quote_id, save_id: snapshot.save_id, content_hash, saved_at: new Date().toISOString(), ...contents };
  const temp = join(root, `.${quote_id}.${randomUUID()}.tmp`);
  await mkdir(temp, { mode: 0o700 });
  const tempFile = join(temp, 'record.json');
  try {
    const handle = await open(tempFile, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(record, null, 2) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    // Publish a complete directory. A concurrent nonempty destination cannot be replaced.
    try { await rename(temp, path); }
    catch (error) {
      if (['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) {
        try { return await existing(); } catch (readError) { if (readError.code !== 'ENOENT') throw readError; }
      }
      throw error;
    }
    return receipt(record);
  } finally {
    await unlink(tempFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export const save_draft_quote = saveDraftQuote;

export async function readDraftQuote(quote_id, { directory = DEFAULT_DIRECTORY } = {}) {
  check(typeof quote_id === 'string' && /^draft-[a-f0-9]{64}$/.test(quote_id), 'Invalid draft ID.');
  return JSON.parse(await readFile(join(resolve(directory), quote_id, 'record.json'), 'utf8'));
}

export async function listDraftQuotes({ directory = DEFAULT_DIRECTORY } = {}) {
  let files;
  try { files = await readdir(resolve(directory)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const records = await Promise.all(files.filter(file => /^draft-[a-f0-9]{64}$/.test(file)).map(file => readDraftQuote(file, { directory })));
  return records.map(record => ({ ...receipt(record), unresolved_count: record.unresolved_questions.length, evidence_count: record.evidence.length })).sort((a, b) => b.saved_at.localeCompare(a.saved_at));
}
