# Quoting evaluations

`npm run evaluate -- eval/fixtures/synthetic.jsonl` produces an ignored `output/evaluation.json` report. The included cases are explicitly synthetic and run without API calls. They verify normal matching, partial stock, unclear material, injected instructions, and incompatible units; passing them is not a real-world accuracy claim.

For supplier-owned labels, store private JSONL files in ignored `eval/private/`. Each case includes:

```json
{"id":"anonymous-case-001","supplier_reviewed":true,"reviewed_by":"supplier-reviewer-ID","reviewed_at":"2026-10-31T12:00:00Z","input":{"text":"20 of 2x4x8 SPF studs","format":"text","account_id":"normal","branch":"sample-main","delivery":null},"expected":{"lines":[{"line_id":"1","sku":"STUD-SPF-248","quantity":20,"needs_review":false,"allowed_substitutes":[]}]}}
```

Replace the example with actual independently reviewed contractor cases and the corresponding supplier catalog/account source (`SUPPLIER_DATA_FILE`). Keep a held-out set separate from prompt tuning. Use anonymous case IDs; do not commit customer lists, raw project details, or real account balances. Preserve every original record in the expected labels, including explicit null-SKU/unmatched records. Only a supplier reviewer can supply meaningful ground truth; the application does not fabricate reviewed examples.

```powershell
npm run evaluate -- eval/private/reviewed.jsonl --require-reviewed --output output/reviewed-evaluation.json
# Add --live explicitly to evaluate Claude matching (paid API requests).
```

The reviewed gate requires at least 20 cases with reviewer IDs/dates, every case marked reviewed, at least 99% exact line classification accuracy, and zero incorrect confident matches, quantity/ambiguity errors, unsupported substitutions, fabricated values, or missing/unexpected records. A null-SKU expected label measures correct escalation rather than successful matching. Annotation provenance is supplied by the dataset owner, not cryptographically certified. Review the report rather than treating its boolean flag as proof of safety.

Reports include case timing, median/p95 latency, failures, model calls, input/output tokens, search counts, dataset SHA-256, prompt/source SHA-256, and individual mistake categories. Cost remains null unless explicit `EVAL_INPUT_USD_PER_MILLION`, `EVAL_OUTPUT_USD_PER_MILLION`, and `EVAL_SEARCH_USD_PER_THOUSAND` assumptions are provided; estimates are not invoices. The normal evaluator covers parser/supplier matching, not an independent engineering validation of public research answers. A supplier should separately score evidence relevance and substitution suitability during the supervised pilot.

CI always runs the synthetic regression set and fails on code/dependency/test failures. Before a production release, run the reviewed gate against real representative data and retain the report privately with the tested commit/model configuration. External hosting/secret setup and real supplier review cannot be supplied by a synthetic test suite.
