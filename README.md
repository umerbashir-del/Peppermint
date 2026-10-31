# BuildBridge

Combined prototype for materials parsing, supplier quoting, specification research, and saved draft review. This integration branch includes the current `codex/parse-materials-list`, `codex/supplier-quote-desk-agent`, and `codex/research-agent` branches, including their common task interfaces and examples. Your partner's orchestrator remains separate.

Requires Node.js 22 or later; no dependency installation is needed. Supplier data is sample data, and nothing can approve, send, reserve, book, or place an order.

## Try it locally

```powershell
# Only copy when .env does not already exist; preserve any existing key.
if (!(Test-Path .env)) { Copy-Item .env.example .env }
npm test
npm run demo
npm run example:parser
npm run example:supplier
npm run example:research
npm run example:draft
```

The research and draft examples use explicitly mocked research evidence. The draft example connects the parser, supplier, mocked research, and storage, then prints the path to a review report you can open locally. It also writes `output/example-save-input.json` for replaying the exact same save.

## Save and inspect a draft

```powershell
npm run draft -- save examples/save-draft-input.json
npm run draft -- list
npm run draft -- show DRAFT_ID
npm run draft -- show DRAFT_ID --html
```

Replace `DRAFT_ID` with the returned `quote_id`. `show` displays the complete JSON record; `--html` writes a readable local report containing materials, totals, unresolved questions, source quotes, and review status. Reports display a draft/approval notice and escape untrusted content. The checked-in save example contains sample data and mocked evidence, not a real manufacturer finding.

Drafts are stored as `output/drafts/DRAFT_ID/record.json`, which Git ignores. Saved records preserve the entire quote, original supplier result, research results including failures, unresolved questions, and approval/review status. Repeating a `save_id` for the same request and identical input returns the same receipt. Reusing it with different content raises `SAVE_CONFLICT`; use a new save ID for a revision. Atomic directory publication prevents incomplete/duplicate records from concurrent retries. Drafts always require rep approval.

## Connect the orchestrator

Read [the shared worker contract](docs/orchestrator-integration.md) and [the draft storage contract](docs/draft-storage.md).

| Component | Entry point | Tool/work |
| --- | --- | --- |
| Materials parser | `runParserTask` in `src/parser-interface.js` | Text, CSV, and extracted PDF text → structured or flagged lines |
| Supplier | `runSupplierTask` in `src/supplier-interface.js` | Catalog, account pricing/credit, delivery, and substitution validation |
| Research | `runResearchTask` in `src/research-interface.js` | Separate `web_search` and `read_source` tools with verified excerpts |
| Draft storage | `saveDraftQuote` / `save_draft_quote` in `src/draft-store.js` | Save correlated results; never approve or send |

Each worker accepts the same versioned task envelope and returns consistent IDs, status, issues, approval requirements, data, and research handoffs. Existing `quote`, `research`, and parser functions remain supported. The orchestrator routes handoffs; workers do not invoke one another. Draft storage is an orchestrator tool, not another agent.

## Live research and matching

The live agents now use Anthropic's Claude Messages API. Set `ANTHROPIC_API_KEY` in your local `.env`; `ANTHROPIC_MODEL` defaults to `claude-sonnet-5-5` and `ANTHROPIC_EFFORT` defaults to `low`. `.env` remains ignored; only the empty `.env.example` is shared. No OpenAI key or separate search-provider key is required. See [Anthropic setup](docs/anthropic-setup.md).

```powershell
npm run research -- "Which manufacturer specifications should be checked before substituting joist lumber?"
npm run quote -- examples/normal.json --live
npm run example:research -- --live
```

Live model commands make paid Anthropic API requests. The `web_search` wrapper uses Claude's hosted search with one search per wrapper call; `read_source` still fetches approved URLs directly and checks structured excerpts against page text. Research reads public HTTPS HTML/plain text only, opens only results from the current run, and enforces four searches or two source-read attempts. Missing dates remain null. PDFs, redirects, unreadable pages, and missing evidence require review. API responses are mocked in the test suite; passing offline tests alone does not establish live account access or search quality.

## Supplier and parser limits

Supplier amounts are integer USD cents, rounded per allocated line; totals exclude tax. Available stock is shared across lines within one quote but is not reserved. Every quote stays a draft.

`validate_substitution` checks size, grade, material, units, other known specifications, explicit supplier rules, contractor requirements, and available quantity. Size, grade, material, pack size, and contractor requirements cannot be relaxed by an equivalence rule. Unknown specifications or missing approval policies never imply compatibility.

The PRD's sample SPF-to-Hem-Fir replacement lacks grades and an approved policy. Its quote therefore retains 15 original joists and 25 unresolved units, with a $193.20 partial total. A clearly fictional test fixture verifies the original $492.20 split and $92.20 credit overage when complete specifications and an explicit policy are present. Normal sample quoting still totals $350.08.

Parsing is conservative and local. It preserves each nonblank material/note record, flags missing details, and blocks handoff when lines/notes are unresolved. Binary PDF reading, OCR, unrestricted prose interpretation, and unit conversions are not implemented. `npm run parse -- examples/materials.txt` and the CSV example run without API calls.

Persistence and review are local files, not a hosted database or approval application. Production ERP access, authentication, account authorization, deployment, and the orchestrator itself remain outside this prototype. Keep saved account data and evidence in the ignored storage directory.
