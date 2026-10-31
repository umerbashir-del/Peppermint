# BuildBridge

Orchestrator connection: use `runParserTask` in `src/parser-interface.js`. Read [the shared contract guide](docs/orchestrator-integration.md), inspect `examples/parser-task.json` and `examples/parser-response.json`, and run `npm run example:parser`. Use `data.supplier_lines` only when non-null; clarification items and delivery notes must be resolved first. Existing parser functions remain supported.

Shared foundation for the October 31, 2026 quoting prototype. Requires Node.js 22 or later; no dependency installation is needed.

Copy `.env.example` to `.env` and add your OpenAI key locally. `.env` is ignored by Git.

Feature branches based on main:

- `codex/research-agent`: public specification research with citations.
- `codex/supplier-quote-desk-agent`: supplier tools, sample quoting, and credit checks.
- `codex/parse-materials-list`: materials parsing for the Contractor Buyer Agent.
- `codex/buildbridge-integration`: both agents, command-line demo, documentation, and complete tests.

The supplier data is sample data. Quotes remain drafts and require human approval.

## Materials parser

`parse_materials_list` converts pasted text, CSV, and already-extracted PDF text into structured lines. It runs locally without an API key, paid calls, or dependencies.

```powershell
npm run parse -- examples/materials.txt
npm run parse -- examples/materials.csv
npm run parse -- path/to/extracted-pdf.txt pdf_text
npm test
```

For application use, import `parseMaterialsList` (also exported as `parse_materials_list`) from `src/materials-parser.js`. Pass a string or `{ text, format: 'text' | 'csv' | 'pdf_text' }`. `PARSE_MATERIALS_LIST_TOOL` is the function schema for a future buyer agent/orchestrator; no agent or HTTP server is required to use the parser now.

Every nonblank record is retained with `line_id`, `raw_text`, `normalized_name`, `item`, `quantity`, `unit`, `kind`, `ambiguity_flag`, and clarification reasons. `item` mirrors `normalized_name` for the existing supplier agent. The result also includes review items and an escalation when there are no materials or no readable quantities. Instruction-like entries are data only and are flagged as non-material; other unknown text is conservatively retained as an unresolved material.

Supported text uses one item per line or semicolon, optionally with bullets/numbering, a numeric quantity first, and a recognized unit (for example `5 boxes of 2.5-inch drywall screws`). Simple comma-separated PRD lists and trailing quantities such as `stuff for the thing, 12` are supported. Studs, joists, boards, and pieces imply `each`; other missing units stay unknown. Dimensions and product specifications remain in the description: `2x4x8` is never treated as quantity or silently converted into a grade or SKU. Common unit aliases normalize without converting quantities or pack sizes. Missing lumber dimensions and screw lengths are flagged.

CSV requires `item`/`description`/`material`/`normalized_name`, `quantity`/`qty`, and `unit`/`uom` headers. Quoted fields, commas, CRLF, escaped quotes, and embedded newlines are supported. Invalid CSV syntax is rejected; malformed row widths are preserved and flagged. Original record text is preserved except for delimiters and an optional initial byte-order mark. Blank records and the CSV header are not material lines.

`toSupplierRequest(parsed, { account_id, branch, delivery })` builds the existing supplier input shape only when every row is a resolved material with whole-number quantities. Notes, missing information, and measurement fractions block the handoff rather than silently disappearing. Review delivery notes and explicitly create delivery metadata before submitting a corrected list. The helper does not call or modify the supplier agent.

Limits: 100 records and 100,000 input characters. This is a conservative rules-based parser, not unrestricted natural-language interpretation. Written-out quantities, arbitrary prose, unit conversions, OCR, and binary PDF reading are not implemented; unsupported details remain flagged. No catalog matching, pricing, deliveries, or orders are performed. The Contractor Buyer Agent and `/lists/parse` HTTP endpoint remain future work.
