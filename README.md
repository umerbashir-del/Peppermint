# BuildBridge

Shared foundation for the October 31, 2026 quoting prototype. Requires Node.js 22 or later; no dependency installation is needed.

Copy `.env.example` to `.env` and add your OpenAI key locally. `.env` is ignored by Git.

Feature branches based on main:

- `codex/research-agent`: public specification research with citations.
- `codex/supplier-quote-desk-agent`: supplier tools, sample quoting, and credit checks.
- `codex/buildbridge-integration`: both agents, command-line demo, documentation, and complete tests.

The supplier data is sample data. Quotes remain drafts and require human approval.

## Supplier feature

Run `npm test` to validate the supplier workflow. Import `quote` from `src/supplier-agent.js` and `loadSupplier` from `src/supplier-tools.js`; pass one of the example JSON requests to `quote(request, await loadSupplier())`. Pass `{ live: true }` as the third argument to enable AI tool calls after loading your key into the process environment. Quotes use sample data; calculations are independently validated and results remain drafts.

## Substitution validation

The Supplier Quote Desk Agent has four read-only tools: `search_catalog`, `get_account_pricing_and_credit`, `check_delivery_slots`, and `validate_substitution`.

`validate_substitution({ line_id, requested_sku, substitute_sku, quantity })` checks a candidate against the material line, supplier-listed substitutions, structured product specifications, documented supplier policy, and available branch quantity. Its inputs cannot override supplier specifications or policies. The same validator runs independently during quote assembly, even when the model skips or misinterprets the tool call. It also works without an API key.

```javascript
import { readFile } from 'node:fs/promises';
import { loadSupplier, supplierTools } from './src/supplier-tools.js';

const request = JSON.parse(await readFile('examples/partial-stock.json', 'utf8'));
const tools = supplierTools(await loadSupplier(), request);
console.log(tools.validate_substitution({
  line_id: '1', requested_sku: 'JOIST-SPF-21012',
  substitute_sku: 'JOIST-HF-21012', quantity: 25,
}));
```

Possible results:

| Status | Meaning |
| --- | --- |
| `approved_candidate` | Known specifications, an explicit supplier rule, matching units, and requested quantity pass. Rep approval and contractor acceptance are still required. |
| `incompatible` | A known requirement conflicts, units differ, or the candidate is not an allowed substitute. It is not allocated. |
| `needs_human_review` | Specifications, policy, stock, or inputs are incomplete, invalid, or insufficient. It is not allocated. |

Results include reasons, field-level checks, available quantity, supplier rule ID, source timestamp, and the requirement for human approval. Each quote line retains `substitution_checks`, including rejected candidates, so no decision is hidden.

Products use `specifications` maps containing explicit text values. At minimum `size`, `grade`, and `material` must be known on both products. Every additional specification present on either product is compared too. Size, grade, material, pack size, and unit cannot be relaxed. Optional contractor `required_specs` maps on input lines also cannot be relaxed. No unit conversions, strength calculations, code compliance, or engineering equivalence are inferred.

The supplier dataset can define `substitution_rules` records with `id`, `requested_sku`, `substitute_sku`, `status: 'approved'`, `approved_by`, and an explicit `approved_at` date. Exactly one matching documented approval is required. A noncritical difference such as species requires an explicit `allowed_differences` entry: `{ species: { from: 'SPF', to: 'Hem-Fir' } }`. The same rule cannot override contractor requirements. These records must be maintained by authorized supplier staff; the prototype has no policy-management or approval interface.

Stock checks account for allocations earlier in the same quote without reserving or changing supplier inventory. The quote may propose a validated partial quantity, with the shortage still shown as unresolved. It never shrinks quantities to fit credit.

**Sample behavior changed:** the PRD's SPF-to-Hem-Fir example does not provide grades or a documented approval rule. The sample data deliberately leaves grade unknown and the rule list empty. Its draft now contains only the 15 original joists, a $193.20 partial total, and 25 unresolved units requiring review. Credit is labeled an incomplete estimate. The original $492.20 split and $92.20 credit overage are tested using a clearly fictional, fully specified policy fixture; that fixture is not real-world substitution approval.

Run `npm test` for 21 offline tests covering normal pricing, compatibility, missing specifications, supplier rules, contractor requirements, stock reuse, and the model tool loop. API responses are mocked; live model access is not verified by these tests. All output remains a draft, and `.env` stays local.
