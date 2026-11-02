# Website supplier and research connection

The website has two quote sources. **Supplier materials and specification research** runs the existing JavaScript parser, supplier desk, and research agents through a private Node subprocess. **Job estimate from uploaded price list** retains the partner's parallel pricing/writing crew. Both model paths now use the repository's private `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL`; no browser API key or OpenAI account is required. An explicitly configured `QBC_LLM_BASE_URL` still selects the legacy compatible gateway for the crew.

## Start

For hosted frontend/backend setup, see [Vercel and Render deployment](VERCEL_RENDER.md).

Use Node 24+ and Python 3.11+. From the repository root, create a Python virtual environment, install `quote-builder/requirements-dev.txt`, run `npm ci`, then run:

```text
python -m uvicorn app.main:app --app-dir quote-builder --host 127.0.0.1 --port 8000
```

The server loads root `.env` without replacing hosting environment variables. Set a random `QBC_SECRET_KEY` of at least 32 characters and keep `QBC_DB_PATH` under ignored `output/`. Account creation/sign-in use the website's existing bootstrap/user APIs and tenant roles. The separate Node pilot's port-3000 accounts are not website accounts. Local generated demo credentials, when provisioned, are in `output/website-demo-credentials.json`.

## Supplier scope

Production requires a server-managed `QBC_SUPPLIER_BINDINGS_FILE`. The file maps an authenticated website tenant to exactly one supplier account and branch. Source paths are relative to the binding file. For example (IDs must exist in the source):

```json
{"contractor-workspace": {"supplier_id":"supplier-id","account_id":"customer-id","branch":"branch-id","source_file":"supplier-source.json"}}
```

Keep this file and supplier feeds outside Git. The source uses the existing supplier schema, with an explicit `supplier_id`, source label, catalog, accounts, branch, and current `as_of`. Non-sample sources older than five minutes are rejected. Commercial approval additionally requires source-issued `commercial_use: true`, `stock_confirmed: true`, and a future ISO `valid_until`; missing permissions remain unknown and block approval. The adapter records a distinct supplier snapshot and never invents formal quote evidence or its validity. Client requests cannot choose source paths, other accounts, or branches. All users in a website tenant share its supplier binding; use distinct tenants for distinct contractor accounts.

For local synthetic testing only, set `QBC_ALLOW_SAMPLE_SUPPLIER=true` without a bindings file. That binds each demo tenant to the sample `normal` account; it does not expose real customer data. Sample sources are denied in production. Both jobs and quote snapshots mark sample data.

## Flow and review

`POST /jobs` accepts `workflow: "supplier"` and a materials list such as `10 of 2x4x8 SPF studs`, one item per line. Existing callers default to `workflow: "crew"`. The local parser preserves unresolved input. The supplier worker uses live Anthropic tool calls and authoritative source calculations. Up to three specification handoffs invoke the real research worker. They never authorize substitutions. Research and questions are retained in tenant-scoped job results and displayed on the website. Failed or partial supplier quotes never become customer draft quotes.

Fully resolved original materials within available credit become a normal website draft with an exact snapshot and the complete worker provenance. Each supplied line is represented as one sourced lot so its discounted, rounded supplier total is preserved exactly; original quantities, units, and allocations remain in the snapshot. Installation labor is excluded. Existing overhead, markup, and tax inputs apply after supplier material pricing.

A different owner/admin/reviewer must approve the exact snapshot. Approval rechecks current supplier prices, stock, specifications, and tax/markup-inclusive credit without another paid model call. Source changes require a new job and fresh review. Generic manual quote creation cannot strip supplier provenance from a supplier project. Corrections to a supplier job replace the complete materials list instead of appending prose answers. Substitutions, missing specs, credit exceptions, and partial stock require further rep work; this integration never automatically resolves them.

Database-backed five-minute job claims prevent duplicate concurrent creation/answer work and reject stale answers before paid calls. Approval atomically records account credit exposure, including other approved supplier quotes across bound tenants. Reservations expire after the quote's validity period; they are not prematurely released based on an unverified ERP posting. View-only users receive customer-safe job and quote views without raw agent/credit provenance. No database write lock is held during model or subprocess calls.

Each supplier run permits at most twenty model requests, three research handoffs, and a bounded subprocess lifetime. Two worker subprocesses run concurrently; per-user supplier jobs are rate limited. No model raw reasoning or key goes to the browser. The crew's token-derived dollar budgets use explicit rate estimates, not provider billing totals.

## Verification and remaining limits

Chrome browser testing covers owner/reviewer sign-in, creating a supplier draft, reopening saved questions after reload, correcting the complete list, separate-reviewer approval, rejection, and completed PDF download. The dashboard now loads saved profile values and jobs, prevents repeated submissions while agents run, preserves an idempotency key after a network failure, and displays visible persistent errors. Role-aware controls use `/auth/me`; the server still authorizes every request. Sign-out clears prior job, quote, profile, project, and catalog data before another user signs in.

### Chrome eval warning diagnosis

The previously unattributed blocked-evaluation issue was traced with Chrome's caught-exception debugger to the installed **Grammarly** extension (`kbfnbcaeplbcioakkpcpgfkobkghlhen`), not this website. The stack starts at `new Function` in `src/js/1163.vendors.chunk.js:1:132161`, passes through `$ZodObjectJIT`, and then Grammarly's own initialization. Its capability probe catches the exception and falls back. The rejected policy is the extension's own `script-src`, which includes a `chrome-extension://` origin.

The identical local website loaded in an extension-free Chrome Incognito window with **zero console messages and no DevTools issues**. The served website code contains no `eval`, `new Function`, or string-based timers. There is no application code change that patches a signed third-party extension; adding `unsafe-eval` to this site's policy would not repair the extension's own policy and must not be used as a workaround. Update Grammarly or prevent it from running on the affected local site/browser profile. Use an extension-free test window to separate application failures from injected extension diagnostics. Browser permissions were left unchanged, and temporary debugger settings were restored.

Tests cover the actual Node parser/supplier behind the Python HTTP API, research routing, exact cents, corrections, tenant isolation, stale-source rejection, approval separation, PDF export, and native Anthropic transport. CI now runs both Python and Node suites. Live verification must use the private local key separately from CI; no secrets are committed.

The Python website still uses its own SQLite store, tenant roles, and approval workflow, with a local approval-exposure ledger. It has not inherited the separate Node pilot's PostgreSQL store or order lifecycle. Run one application process/machine per SQLite database; use a shared database and tested multi-instance admission controls before scaling. It does not reserve stock, publish/send quotes, or place orders. A reliable live supplier feed and domain-approved tax policy remain deployment requirements for real commitments. Research failures remain explicit review questions.
