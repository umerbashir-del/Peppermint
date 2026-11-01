# Production readiness

## Verified in this build
| Check | How | Result |
|---|---|---|
| Unit and API tests | `pytest -q --cov=app` | 102 passed, 93% coverage (gate 80%) |
| Lint, types | `ruff check`, `mypy app` | clean |
| Dependencies | `pip-audit -r requirements.lock` | no known vulnerabilities at build time |
| Migrations | applied fresh and re-run | idempotent |
| Live server | uvicorn with runtime deps only | health, ready, headers, CSP, static files |
| End-to-end over HTTP | bootstrap → price list → scope → quote → reviewer approve → PDF → audit verify → logout | passed; PDF renders |
| Red-team cases | `tests/test_redteam.py` | see table below |

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
2. **Real model not tested.** The gateway is covered with a mock transport. Quality of prompts, cost per job, and latency are unmeasured. Run the eval cases against a real model and record results.
3. **Real price list not tested.** Only labelled test data is in the repo. Test a real contractor's CSV.
4. **Deploy not verified** against a live Fly account or a live Docker daemon in CI.
5. **Browser UI not exercised** in a real browser. Only the script's syntax and the server's responses were checked.
6. **Data retention** for notes, customers and audit rows is not automated.
7. **Account management:** no email verification, password reset, or MFA. Deactivation and logout work.
8. **Rate limits and lockout** are per process and in memory for limits (lockout is in the database).
9. **Business rules need domain sign-off:** tax base (currently overhead + markup), labor classification, units, validity periods, and the $5,000 review threshold.
10. **Quote wording** is model text. Digits are checked; words are not. Human review is the control.
11. **Money columns** on `quotes` are `REAL`. Snapshots are exact.
12. **Minor:** `HEAD /` returns 405; `login_attempts` rows accumulate for unknown accounts.

## Go-live decision
Not ready for production customers. Ready for an internal pilot with synthetic or test data, one owner, and a reviewer who checks every draft.
