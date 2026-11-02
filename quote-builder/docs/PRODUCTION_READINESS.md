# Production readiness

## Verified in this build
| Check | How | Result |
|---|---|---|
| Unit, API, and client behavior tests | `npm test`, `pytest quote-builder/tests -q` | 156 JavaScript and 125 Python tests pass; coverage was not remeasured in this run |
| Lint, types | `ruff check`, `mypy app` | clean |
| Dependencies | `pip-audit -r requirements.lock` | no known vulnerabilities at build time |
| Migrations | applied fresh and re-run | idempotent |
| Live server | uvicorn with runtime deps only | health, ready, headers, CSP, static files |
| End-to-end over HTTP | bootstrap → price list → scope → quote → reviewer approve → PDF → audit verify → logout | passed; PDF renders |
| Red-team cases | `tests/test_redteam.py` | see table below |
| Browser workflow | Chrome on Windows, labelled sample supplier data | owner sign-in, draft creation, question recovery after refresh, correction, reviewer approval/rejection, PDF download, and narrow desktop layout passed |

## Red-team coverage (from the assessment)
| ID | Status | Where |
|---|---|---|
| RT-001 injection in notes | Covered: flagged, totals unchanged | `test_crew.py` |
| RT-003 forged source / client cost | Covered: client cost ignored, forged source rejected | `test_redteam.py` |
| RT-004 expired evidence | Covered: fails closed | `test_redteam.py` |
| RT-005 unit mismatch | Covered | `test_api.py`, `test_redteam.py` |
| RT-006 copper matched to PEX | Partly: candidates are same-unit only; the model's choice is still a risk | `test_redteam.py` |
| RT-007 cross-tenant IDs | Covered | `test_api.py`, `test_redteam.py` |
| RT-008 search without tenant filter | Covered for price items | `test_api.py` |
| RT-009 replayed old version | Covered at join (stale estimate) | `test_crew.py` |
| RT-010 snapshot tampered | Covered: detected, PDF refused | `test_redteam.py` |
| RT-011 concurrent writers | Covered: one writer per file | `test_crew.py` |
| RT-013 approval after change | Covered: hash binds approval | `test_redteam.py` |
| RT-014 unknown or send actions | Covered: no route | `test_redteam.py` |
| RT-015 retry budget | Covered per lead (unit); not under real concurrency | `test_crew.py` |
| RT-016 labor benchmark as rate | Covered by design: rate only from profile | `test_api.py` |
| RT-017 synthetic source | Covered | `test_redteam.py` |
| RT-018 non-commercial data | Covered for evidence | `test_redteam.py` |
| RT-020 unknown unit | Covered | `test_catalog.py` |
| RT-021 duplicate or omitted line | Covered: label count join | `test_crew.py` |
| RT-022 oversized input | Covered: notes, price list | `test_crew.py`, `test_redteam.py` |
| RT-025 retry duplicates | Covered: idempotency key | `test_redteam.py` |
| RT-026 model claims completion | Covered: model cannot set status | `test_redteam.py` |
| RT-002, RT-023, RT-029, RT-030 | Not applicable: no supplier crawling, parsing of PDFs, FX or URL fetching | — |
| O1 license name injection | Not applicable: no license registry integration | — |
| O2 near-match license | Not applicable: no license registry integration | — |

## Open gaps (must close or formally accept before real customers)
1. **Database:** SQLite only. Postgres, managed migrations and a concurrency test suite are required before more than one machine.
2. **Model quality is not established.** Live Anthropic smoke tests passed on labelled sample data, and provider failures are injected in tests. Supplier-reviewed accuracy, cost per job, and latency still need representative evaluation data.
3. **Real price list not tested.** Only labelled test data is in the repo. Test a real contractor's CSV.
4. **Python production deployment is not verified** against a live Fly account. The separate Node pilot's images and PostgreSQL recovery drill pass CI; that does not deploy the Python website.
5. **Browser coverage is limited.** The core website workflow passed in Chrome on Windows, including a narrow desktop window. Other browsers, actual mobile devices, and a full accessibility audit remain untested.
6. **Data retention** for notes, customers and audit rows is not automated.
7. **Account management:** no email verification, password reset, or MFA. Deactivation and logout work.
8. **Rate limits** are per process and in memory. Website sign-in is limited to 20 requests per IP per minute; there is no per-account failed-password lockout.
9. **Business rules need domain sign-off:** tax base (currently overhead + markup), labor classification, units, validity periods, and the $5,000 review threshold.
10. **Quote wording** is model text. Digits are checked; words are not. Human review is the control.
11. **Money columns** on `quotes` are `REAL`. Snapshots are exact.
12. **Minor:** `HEAD /` returns 405; `login_attempts` rows accumulate for unknown accounts.

## Go-live decision
Not ready for production customers. Ready for an internal pilot with synthetic or test data, one owner, and a reviewer who checks every draft.
