# Connect BuildBridge workers to an orchestrator

All three feature branches include the same v1.0 envelope helpers and JSON Schema in `contracts/agent-interface.schema.json`. Use these adapters for integration; existing `quote`, `research`, and parser functions remain available and unchanged.

| Agent ID | Import | Input |
| --- | --- | --- |
| `materials_parser` | `runParserTask` from `src/parser-interface.js` | `{ text, format }`, where format is `text`, `csv`, or `pdf_text` |
| `supplier_quote_desk` | `runSupplierTask` from `src/supplier-interface.js` | `{ account_id, branch, delivery, lines }` |
| `research` | `runResearchTask` from `src/research-interface.js` | `{ question, line_ids }` |

Each adapter is maintained on its feature branch. The `codex/buildbridge-integration` branch now combines all three current workers and draft storage, so your orchestrator can import them together from that checkout. Shared contract files are identical across the feature branches. This package does not implement or take over the orchestrator.

## Task envelope

```json
{
  "schema_version": "1.0",
  "request_id": "quote-001",
  "task_id": "parse-001",
  "agent": "materials_parser",
  "input": { "text": "20 of 2x4x8 SPF studs", "format": "text" }
}
```

`request_id` follows the quote workflow. Give every distinct task a unique `task_id`; retries reuse its ID. IDs must contain 1–128 letters, digits, dots, underscores, colons, or hyphens. Agent routing and version are validated in code. Input payloads are validated too; unsupported fields fail explicitly. No credentials, supplier datasets, model choices, or tool permissions belong in the task payload.

## Result envelope

Every adapter resolves to the same keys: `schema_version`, `request_id`, `task_id`, `agent`, `status`, `approval_required`, `data`, `issues`, and `handoffs`. Invalid inputs and execution failures return this envelope instead of leaking exception traces or provider error bodies. Invalid/missing correlation IDs become null on failure.

- `completed`: worker produced its requested result without unresolved blockers. This never means a quote or order is approved.
- `needs_human_review`: useful data may exist, but clarification, missing evidence, credit, stock, or other checks need review. Do not discard partial data or silently drop flagged lines.
- `failed`: execution or input validation failed; `data` is null. Issues include `INVALID_INPUT`, `AGENT_FAILED`, or `TEMPORARY_FAILURE`.
- `approval_required`: supplier drafts and research evidence always require human approval before any commercial commitment, even with status `completed`.
- `issues`: `{ code, message, line_ids, retryable }` records. Only retry errors explicitly marked retryable; adapters do not automatically replay entire tasks. Configure bounded workflow retries/timeouts in the orchestrator. Do not interpret business review items as transient failures.
- `handoffs`: fully formed task envelopes for the orchestrator to route. Workers never invoke other agents directly.

## Data and routing

Parser `data` contains `lines` (including original text and ambiguity flags), `supplier_lines` (the exact supplier line shape, or null if anything is unresolved), and `escalation`. Pass only non-null `supplier_lines` onward. Delivery notes block this handoff until explicitly resolved; never turn a note into a booked date.

Supplier `data` is the existing complete draft quote, including integer-cent totals, unresolved quantities, credit status, substitution checks, and human-review reasons. All prices are USD cents; tax is not calculated. Sample supplier data is injected by default. Production authentication/authorization and supplier data access must be bound by trusted server code, not claimed by task account IDs.

Supplier `handoffs` request research only for missing material specifications. They include the same request ID and source line IDs, with a stable derived task ID. They omit account IDs, pricing, balances, and stock counts. Missing supplier approval policies, stock, and credit are human/internal-data issues, not public-web research tasks. Research evidence cannot fill a supplier policy or authorize a replacement.

Research `data` contains the answer, verified source quotes and URLs, page/fetch dates, confidence, usage, and the input `line_ids`. Sources have been checked against opened pages. Unknown dates stay null. A result with no verified evidence needs human review. Return evidence to your workflow/rep; never modify supplier catalog/specifications or approve substitutions from a public answer automatically.

## Calling the workers

```javascript
const result = await runSupplierTask(task); // Offline sample workflow by default.
// Trusted options: { supplierData, live: true, respond } for live matching.
const findings = await runResearchTask(researchTask); // Live API key required.
// Trusted test options: { respond, search, read }.
const parsed = await runParserTask(parserTask); // Local; no API key required.
```

For local tests, each feature branch includes task/response JSON examples and `examples/run-*-task.js`. Run its `npm run example:...` script. Research's default example is explicitly mocked, with no claim that its example source is real; pass `--live` for a paid live request. Example responses are snapshots: generated timestamps and live model wording vary.

These are in-process JavaScript interfaces, not HTTP endpoints or a hosted service. If you expose them over a network, validate task envelopes, enforce caller account/branch authorization, and keep credentials/dependencies server-side. Keep `.env` local. The worker tool restrictions and existing iteration budgets remain in force.

The combined integration branch now uses Anthropic for live calls. Load `ANTHROPIC_API_KEY` and optional `ANTHROPIC_MODEL`/`ANTHROPIC_EFFORT` in the orchestrator process; no task-envelope fields changed. See [Anthropic setup](anthropic-setup.md).

## Save the assembled draft

After routing any research handoffs, call `saveDraftQuote({ save_id, supplier_result, research_results, unresolved_questions })` from `src/draft-store.js`. This is the `save_draft_quote` orchestrator tool; it does not add a new agent ID or change the worker envelope. It returns a draft receipt and never approves or sends anything. See [draft storage](draft-storage.md) for its schema, replay rules, and rep inspection commands.
