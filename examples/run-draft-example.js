import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runParserTask } from '../src/parser-interface.js';
import { runSupplierTask } from '../src/supplier-interface.js';
import { runResearchTask } from '../src/research-interface.js';
import { mockResearchOptions } from './research-fixture.js';
import { saveDraftQuote, readDraftQuote } from '../src/draft-store.js';
import { renderDraftReview } from '../src/draft-review.js';

// Connection example only. Workflow routing remains owned by your orchestrator.
const base = { schema_version: '1.0', request_id: 'saved-demo-001' };
const parsed = await runParserTask({ ...base, task_id: 'parse-demo', agent: 'materials_parser', input: { text: '40 of 2x10x12 SPF joists', format: 'text' } });
if (parsed.status !== 'completed') throw new Error('Example materials unexpectedly need clarification.');
const supplier = await runSupplierTask({ ...base, task_id: 'supplier-demo', agent: 'supplier_quote_desk', input: { account_id: 'near-limit', branch: 'sample-main', delivery: null, lines: parsed.data.supplier_lines } });
if (supplier.status === 'failed') throw new Error('Example supplier task failed.');
const research = [];
for (const task of supplier.handoffs) research.push(await runResearchTask(task, mockResearchOptions()));
const input = { save_id: `demo-${randomUUID()}`, supplier_result: supplier, research_results: research, unresolved_questions: [{ question: 'Confirm grade and supplier substitution approval with the rep. Research in this demo is mocked.', line_ids: ['1'] }] };
const receipt = await saveDraftQuote(input);
const draft = await readDraftQuote(receipt.quote_id);
const directory = new URL('../output/draft-reviews/', import.meta.url);
await mkdir(directory, { recursive: true });
const report = new URL(`${receipt.quote_id}.html`, directory);
await writeFile(report, renderDraftReview(draft));
const exampleInput = new URL('../output/example-save-input.json', import.meta.url);
await writeFile(exampleInput, JSON.stringify(input, null, 2));
console.log(JSON.stringify({ ...receipt, review_file: fileURLToPath(report), reusable_save_input: fileURLToPath(exampleInput), evidence: 'Offline mocked evidence; not a live manufacturer source.' }, null, 2));
