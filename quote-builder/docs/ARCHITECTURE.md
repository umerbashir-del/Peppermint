# Architecture

## Components
```
Browser (web/index.html, app.js, app.css)
   │  bearer token, JSON
FastAPI app (app/main.py)
   ├─ security.py   tokens, passwords, per-request authority check
   ├─ ratelimit.py  in-process sliding window (login per IP)
   ├─ catalog.py    price-list CSV validation
   ├─ quotes.py     source resolution, Decimal totals (money.py), snapshot + hash, slot filling
   ├─ audit.py      hash-chained audit rows
   ├─ pdf.py        renders an approved snapshot only
   └─ crew/         the quoting crew (below)
SQLite (app/db.py, migrations in app/migrations.py)
```

## The crew
One job runs through these steps:
1. **Intake** (`crew/intake.py`): size cap, control characters removed, instruction-like text flagged.
2. **Parallel leads** (`crew/pipeline.py`, `asyncio.gather`):
   - *Pricing team:* Pricing Lead (strong model) extracts items as a typed plan. An Estimator (mid model) per trade chooses among **code-selected candidates** from the tenant's price list. Estimators never see other trades.
   - *Quote team:* Quote Lead (strong) writes scope, assumptions, exclusions and line labels. Writer (small) writes lines using slots only; it is retried once if it types a number.
3. **Join** (deterministic, code): estimate version matches; label count matches item count; each label resembles its item name; customer text has no digit outside a slot or an item name.
4. **Outcome:** `ready` (draft quote built), `needs_input` (questions, nothing built), or `failed` (named half, nothing built).

Each lead has its own budget ($0.25 and 15 turns). Each team has a 120-second limit. A failed team does not discard the other team's work. Traces record counts and categories, never raw model output.

Only `app/crew/service.py` writes to the database, and it does so after the model calls finish, so no write lock is held during model calls.

## Trust boundaries
| Input | Trust | Control |
|---|---|---|
| Job notes | Untrusted | Size cap, data delimiters, flags, never obeyed |
| Price list | Untrusted | Row validation, formula and instruction rejection, unit allowlist |
| Model output | Untrusted | Typed contracts (extra fields ignored), slot-only numbers, code totals |
| Supplier evidence | Untrusted | Must be current, USD, commercial-use, stock-confirmed, unit-matched |
| Contractor profile | Trusted input from the contractor | Only source of license and insurance text |

## Data model (summary)
`users`, `customers`, `projects`, `scopes` (source reference, not cost), `evidence`, `price_lists`, `price_items`, `contractor_profiles`, `quotes` (snapshot JSON and hash), `jobs` (idempotency key, result), `audit_log` (hash chain), `login_attempts`, `schema_migrations`.

Money: calculations use `Decimal` rounded half-up to cents at each stage. Stored money columns on `quotes` are still `REAL` for compatibility; the snapshot holds exact strings and is the source of truth.

## Known limits
- **SQLite only.** Postgres is the planned next step (a dialect rewrite plus a live test database). Run one machine per SQLite database.
- **Rate limiting is per process.** Multiple instances need a shared store.
- **Estimator candidate selection is by string similarity.** A correct match beyond the top five candidates is missed and becomes a question.
- **Customer wording is model-written text.** Digits are checked; words are not. The contractor reviews every draft before approval.
