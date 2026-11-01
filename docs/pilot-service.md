# Pilot setup and review workflow

This service is independent of the partner orchestrator. It exposes the existing workers and imports their v1.0 results; the orchestrator can connect later without owning sign-in, permissions, persistence, or the human review rules.

## Local run

Use Node.js 24+, `npm ci`, `npm run pilot:seed`, then `npm start`. Visit `http://localhost:3000`. Seed credentials are generated, local-only, and stored in ignored `output/pilot-demo-credentials.json`. Demo seeding refuses production and nonempty databases. Stop the server before running another embedded-database process; local embedded storage is single-process development storage, not the shared production deployment.

The existing `.env` keeps its Anthropic key. Missing server settings have development defaults; use `.env.example` as a reference without overwriting `.env`. A blank `DATABASE_URL` selects the development embedded database. PostgreSQL connection URLs select the shared `pg` pool. Production refuses embedded storage and requires HTTPS, an operator metrics token, and an explicit supplier source. Do not publish a development server on the internet.

Embedded development storage uses an exclusive sibling `output/pilot-db.lock`. Graceful shutdown removes it. If a process crashes, verify that the recorded process ID is no longer running before removing that specific lock file; never remove a live process's lock or open the same database from two processes. Shared PostgreSQL does not use this development lock.

## Accounts and permissions

Accounts are invitation-only. Administrators invite users with explicit supplier memberships. A new user receives a one-use activation link valid for 24 hours. The application returns that link to the administrator for private delivery; no email is sent automatically. Existing users retain their password when invited into another supplier. Public self-registration is not available.

| Role | Scope |
| --- | --- |
| Administrator | All branches/customers in their own supplier; manages invitations/grants, review, and credit exceptions |
| Counter rep (`staff`) | Only explicit account-and-branch pairs; prepares, edits, approves, publishes, and requests orders |
| Credit manager | Same explicit pairs, plus revision-bound credit exceptions |
| Contractor | Only explicit customer accounts; sees published revisions, accepts a specific current offer; no internal credit/research/audit data |

Every API request reads current membership/grants. Quote reads, revision reads, history, list, catalog, worker tasks, and writes are scoped. Guessing an ID does not grant access. Unpublished revisions are hidden from contractors, even for their own account. Published customer views omit internal balances, original agent payloads, policy checks, and review questions.

Sessions are opaque random tokens stored hashed in PostgreSQL, with HttpOnly/SameSite cookies, Secure cookies in production, eight-hour absolute expiry and a thirty-minute idle limit. Mutations require the exact configured Origin, JSON content, and an `X-CSRF-Token` from sign-in or `/api/auth/me`. Passwords use salted scrypt with a 15-character minimum. Sign-in and activation are rate limited. Password changes revoke sessions; an authorized operator can use the reset CLI if recovery is needed. No email/password-recovery provider or MFA/SSO provider is configured.

## Review and commercial rules

1. Create/import a draft. The server rechecks supplier pricing rather than trusting uploaded totals.
2. Correct materials/delivery as needed. Each change creates a new immutable revision and invalidates approval.
3. Resolve review questions and accept each validated proposed substitution explicitly. Answers cannot override missing quantities, incompatible specifications, missing policies, or supplier credit.
4. Enter the applicable tax rate in basis points, tax jurisdiction/basis/exemption reference, whether delivery is taxable, each fee's taxability, and expiration. A rep must explicitly confirm tax treatment. The rate must match a single active supplier `tax_policies` record or receive separate administrator approval for this revision. Tax is rounded once on the taxable subtotal using integer cents. This is configured supplier policy; the app does not determine legal tax rates or nexus.
5. Approve the exact current revision. Fresh supplier data must still match prices, delivery identity/fees, allocations, specifications, and tax policy. Credit checks serialize by account and include other approved/published/accepted/pending-order exposure plus this tax/fee-inclusive total. Only the credit manager/admin can approve a documented overage for this revision. A later revision invalidates approval/exception and releases its reservation. Unaccepted offers stop consuming exposure after expiration; accepted/pending orders retain exposure until verified supplier posting.
6. Publish the approved revision to the contractor portal (`sent`). This does not send external messages or reserve stock. Contractor acceptance applies only to the current published revision and is blocked after expiration or a new unapproved revision.
7. A rep may create an order request after acceptance. Its separate record is `pending_external_confirmation`; live order placement/fulfillment is not implemented. A credit manager/admin may reconcile it only when the supplier feed includes a matching `posted_orders` entry for this quote/revision/account/total with an external reference and `posted_to_balance: true`. Only then is state `ordered` and pending credit released; the app cannot fabricate confirmation.

Revising a previously published offer keeps the old published revision visible but marks it as being revised; acceptance is blocked until the new revision is approved/published. Accepted or ordered quotes cannot be edited in place. Every edit/action records actor ID, revision, reason, and time. Database triggers reject updates/deletes of audit records, revisions, and credit exceptions. Cancellation is an explicit action, not deletion.

The production supplier adapter currently reads one configured source file (`SUPPLIER_DATA_FILE`) with `supplier_id`, branch/catalog/account/delivery arrays, source label, and `as_of`. Non-sample data older than five minutes is rejected. This adapter is replaceable; a live ERP connector is still required for reliable ongoing updates. Production rejects sample data unless deliberately allowed for staging. Stock and delivery are not reserved by this service.

## API connection

All API failures return `{ error: { code, message, request_id } }` without raw provider/database errors. Protected routes require a session cookie; mutations also need the configured Origin and CSRF header. A backend orchestrator should use a dedicated narrowly scoped supplier user, store its password server-side, and renew expired sessions. Never expose the raw library functions as unauthenticated endpoints.

| Method/path | Purpose |
| --- | --- |
| `POST /api/auth/login` | `{ email, password }` → session cookie and CSRF token |
| `POST /api/auth/activate` | `{ token, password }` → activate and sign in |
| `GET /api/auth/me` | Current user, memberships, grants, CSRF token |
| `POST /api/auth/logout`, `/api/auth/password` | Revoke session / change password |
| `GET /api/suppliers/:id/options`, `/catalog?account_id=...&branch_id=...` | Allowed accounts/branches and scoped catalog |
| `POST /api/suppliers/:id/users` | Admin invitation: `{ email, role, grants }` |
| `PUT /api/suppliers/:id/users/:user/grants`, `DELETE /api/suppliers/:id/users/:user` | Replace scopes / revoke membership |
| `POST /api/quotes` | `{ supplier_id, draft_input }`; `draft_input` is the existing save-draft shape |
| `POST /api/quotes/from-materials` | Manual text/CSV list → draft using local parser and supplier data |
| `GET /api/suppliers/:id/quotes`, `/api/quotes/:id` | Scoped list / detail |
| `GET /api/quotes/:id/revisions/:revision`, `/history` | Scoped immutable revision / staff audit history |
| `POST /api/quotes/:id/revisions` | `expected_revision`, reason, optional lines/delivery/terms/research/resolutions/substitutions |
| `POST /api/quotes/:id/actions/:action` | `approve`, `publish`, `accept`, `order`, `cancel`; body `{ expected_revision, reason }` |
| `POST /api/quotes/:id/credit-exception` | `{ expected_revision, reason, limit_cents }`; credit manager/admin only |
| `POST /api/quotes/:id/tax-approval` | `{ expected_revision, reason }`; administrator approval for manual tax settings |
| `POST /api/quotes/:id/reconcile-order` | `{ expected_revision, reason, external_reference }`; verified supplier posting required |
| `POST /api/worker-tasks` | `{ supplier_id, task }`; existing v1 worker envelope returned unchanged |
| `POST /api/lists/pdf` | `{ supplier_id, pdf_base64 }`; 5 MB/40-page/15-second isolated text extraction |

Worker calls reserve shared per-user and per-supplier daily budgets, enforce at most 20 model calls per task and a three-minute task deadline, and record token/search usage. Model requests accept the task cancellation signal. These limits do not change worker tool permissions. Conservative token reservations can be larger than actual usage. No API call is needed for manual/local drafting.

Completed research attached to the pilot API must exactly match a server-recorded worker result and its current handoff input hash. Call research through `/api/worker-tasks`; provide its saved quote request ID, or an explicit HTTP `scope: { account_id, branch_id }` when research runs before draft creation. Worker-result envelopes themselves are unchanged. Editing requirements invalidates stale evidence. Unsigned legacy/offline examples are not accepted as completed evidence by this production boundary. The local-file draft CLI remains a development tool and does not claim server-side provenance.

The PDF reader disables evaluation and reads text in a bounded worker. Empty/scanned pages are flagged; the portal refuses to treat the remaining pages as a complete list. OCR is not silently guessed or sent to an external service.

Production configuration and database backup/recovery are covered in [operations](operations.md). Benchmark data and release quality gates are covered in [evaluation](evaluation.md).
