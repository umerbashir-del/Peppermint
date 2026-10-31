# BuildBridge

Starter implementation of the Research Agent and Supplier Quote Desk Agent from the October 31, 2026 PRD. Requires Node.js 22 or later. No dependency installation is needed.

## Try the sample supplier workflow

From this folder:

```powershell
npm run demo
npm run quote -- examples/partial-stock.json
npm test
```

The demo and default quote command run a deterministic supplier workflow without an API key. Amounts are returned in integer cents. The PRD examples total $350.08 (normal) and $492.20 (partial stock), with a $92.20 credit overage in the second case. The substitution is also flagged for review.

## Enable the AI agents

Open `.env` locally and set `OPENAI_API_KEY` to your OpenAI API key. `OPENAI_MODEL` defaults to `gpt-4.1` and can be changed to a model available to your API account that supports the required tools. `.env` is ignored by Git; `.env.example` contains empty configuration for sharing. Do not put a key in source files or chat.

```powershell
npm run quote -- examples/normal.json --live
npm run research -- "Which manufacturer specifications should be checked before substituting joist lumber?"
```

Live commands make paid API requests. The supplier agent can call only `search_catalog`, `get_account_pricing_and_credit`, and `check_delivery_slots`. Those tools are bound to the request account and branch. A maximum of 12 response rounds prevents an endless loop. The application validates proposed matches against exact catalog descriptions/aliases and units, then computes prices, stock allocations, and credit independently. Broader or uncertain matches remain unresolved.

The Research Agent uses OpenAI's hosted web search, returning a short answer, citation URLs, and fetch time. Missing publication dates remain unknown. It rejects common price, stock, and account lookup requests before making an API call; its prompt also forbids those topics. Public evidence cannot authorize a substitution. The hosted tool replaces separate custom search/read functions in this starter; its six-call budget does not implement the PRD's exact four-search/two-page split. Research is invoked separately and is not automatically used to change quotes.

Official API reference used: [OpenAI web search documentation](https://developers.openai.com/api/docs/guides/tools-web-search).

## Input and supplier data

Quote input is structured JSON: account ID, branch, optional delivery ZIP/slot ID, and material lines with unique string IDs, item descriptions, positive whole quantities, and explicit units. Use `examples/normal.json` as a template. No automatic pack/unit conversions are made.

`data/supplier.json` contains clearly marked sample data, provenance time, two sample accounts, catalog prices and stock, supplier-listed substitutes, and a delivery slot. The Hem-Fir substitution is a fixture from the PRD, not a claim of engineering equivalence. A rep must verify the specifications and contractor acceptance.

Each requested line survives into the result. Unmatched lines and unfulfilled quantities produce a partial total and incomplete credit estimate. Missing account data falls back to clearly labeled list prices and unavailable credit. Duplicate product lines share one per-quote stock allocation. Prices use integer cents with rounding per allocated line after discount.

## Current limits

This is a command-line prototype using sample supplier data, not a live ERP connection. Results are printed as drafts; there is no persistence, approval interface, sending, order placement, stock reservation, or delivery booking. Every draft requires rep approval. Totals exclude tax; delivery uses sample labels rather than promised dates. There is no authentication or multi-tenant account authorization layer, so do not expose these commands as a public service.

The Contractor Buyer Agent, orchestrator, PDF/CSV parsing, production substitution rules, live stock/pricing freshness checks, and quote acceptance workflow are future work. Tests cover the sample workflow and mocked API responses; a real API run requires your key and has not been verified by the offline test suite.
