# save_draft_quote

The integration branch exports `saveDraftQuote` (also `save_draft_quote`), `SAVE_DRAFT_QUOTE_TOOL`, `readDraftQuote`, and `listDraftQuotes` from `src/draft-store.js`. This adds the PRD's draft-writing tool without implementing your partner's orchestrator or changing the three worker contracts.

## Orchestrator call

```javascript
import { saveDraftQuote, SAVE_DRAFT_QUOTE_TOOL } from './src/draft-store.js';

const receipt = await saveDraftQuote({
  save_id: 'review-v1',
  supplier_result,        // complete runSupplierTask result
  research_results,      // complete runResearchTask results; defaults to []
  unresolved_questions: [
    { question: 'Confirm job-site unloading access.', line_ids: [] }
  ]
});
// { quote_id, request_id, status: 'draft', review_status,
//   approval_required: true, saved_at }
```

Register `SAVE_DRAFT_QUOTE_TOOL` only in the orchestrator's allowed write tools, and dispatch it to `saveDraftQuote`. Its function schema uses `strict: false` because it carries complete worker-result objects with agent-specific data. The local handler validates correlation, draft state, line arithmetic, evidence references, and review data before writing. A machine-readable input schema is in `contracts/save-draft-quote.schema.json`; JSON task/response examples remain in `examples/`.

`supplier_result` must contain a successful supplier draft. Failed supplier tasks cannot create a quote; resolve them first. Material clarification still belongs to the parser/rep, not a fabricated quote. Research results can be completed, require review, or fail; all are retained. The request IDs must match, line references must exist, and a research result for a generated handoff must reference that handoff's lines. There may be at most one final result per research task ID.

The saved record includes the original supplier result, complete quote, attached research results, and derived unresolved questions. Supplier issues, unfulfilled units, unanswered research handoffs, failed research, and explicitly supplied questions are retained. A completed research result resolves its pending research question only; it does not resolve supplier approval rules, fill missing grade data, change quantities/prices, or approve substitutions. The evidence itself remains available for a rep to inspect.

Review is computed conservatively. The record remains `status: 'draft'` and `approval_required: true`. Blocking items produce `review_status: 'needs_human_review'`; otherwise it is `awaiting_rep_approval`. Neither state is approved. The outer saved review status may be stricter than the original supplier quote status because later research/questions were added; the original quote is retained for audit.

## Local persistence and replay

Default storage is the project-relative `output/drafts/` directory, independent of the shell's current folder. Trusted server code/tests may pass `{ directory: absolutePath }`; callers/model tasks cannot choose the directory. Records are local JSON files containing account and pricing information, so the entire default output directory remains ignored by Git.

The request ID and `save_id` determine the draft ID. Identical retries, including reordered object keys, return the original receipt and save time. Different content with the same identity raises `DraftStoreError` with code `SAVE_CONFLICT` without modifying the old record. Use a new save ID to create a revision. Replaying a workflow that regenerates timestamps is different content; reuse the original result objects when retrying a save. Each input is limited to 2 MB.

Writes use a unique temporary directory, flush its `record.json`, and publish the complete directory with a same-volume rename. An existing nonempty draft directory cannot be overwritten, so concurrent retries load its completed record and compare content hashes. Temporary data is cleaned up on handled errors; abandoned hidden temporary directories from an interrupted process are not listed as drafts. Records live at `output/drafts/DRAFT_ID/record.json`. No hard-link permission, database, distributed locking, automatic retention, or authentication is required/included.

Validation errors use `INVALID_DRAFT`; content conflicts use `SAVE_CONFLICT`; filesystem errors preserve their normal codes. The handler throws errors for the orchestrator to translate to its tool/error format. No new worker/agent envelope is introduced for this tool. Fix invalid/conflicting inputs rather than blindly retrying them.

## Rep inspection

```powershell
npm run example:draft
npm run draft -- save examples/save-draft-input.json
npm run draft -- list
npm run draft -- show DRAFT_ID
npm run draft -- show DRAFT_ID --html
```

`example:draft` is a runnable connection example using the real parser/supplier/storage and explicitly mocked research. It is not an autonomous orchestrator. It creates a new demonstration save ID each run and prints the HTML report path. Its exact replay input is written to ignored `output/example-save-input.json`. The checked-in `examples/save-draft-input.json` is a static, replayable fixture with sample pricing and mocked evidence.

`show` returns the complete JSON record. `--html` exports a standalone, escaped report to `output/draft-reviews/`. A rep can inspect it in a browser or print it; there are no approval/send buttons or remote requests. It contains requested materials, proposed allocations, unresolved units, total/credit status, review questions, source quotes, dates, and a draft/sample-data notice.

Only read/list/export operations are exposed for existing drafts. Revisions create new records; this tool cannot delete, approve, send, reserve stock, book delivery, or place an order.
