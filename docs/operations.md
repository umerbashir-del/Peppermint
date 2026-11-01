# Deployment and operations

## What is included

`Dockerfile` builds a non-root application image and a PostgreSQL-17 backup/restore tools image. `compose.yaml` describes a shared database, the app, persistent volumes, health checks, resource limits, and encrypted scheduled backups. Runtime containers do not receive source-control credentials or local `.env` files in their images. `.dockerignore` excludes credentials, uploads, saved drafts, private benchmark data, and Git history.

Production deployment itself requires your hosting account, HTTPS domain/reverse proxy, database logins, real supplier feed, backup destination/key, and alert configuration. None has been provisioned by this repository. Docker Desktop was unavailable during local development; container/real-PostgreSQL restore verification is defined in CI, while local tests exercise PostgreSQL semantics using the embedded PostgreSQL engine.

## Deployment sequence

1. Install Node.js 24+ or build the application container. Supply a persistent PostgreSQL-17 database. Use a database-owner secret only for migrations/bootstrap.
2. Set owner `DATABASE_URL` in a private operator environment and run `npm run db:migrate`. Migrations are ordered/checksummed; changing an applied migration fails. Add new migration files rather than editing applied ones.
3. Run `ops/runtime-role.sql` as the owner. Provision a separate login and grant it `buildbridge_runtime`. Use that login's URL as the application `DATABASE_URL`/Compose `RUNTIME_DATABASE_URL`. It cannot mutate audit/revision/exception rows, truncate tables, or own the schema. Do not give the application the owner login.
4. Register the first supplier/admin with `SUPPLIER_DATA_FILE`, `BOOTSTRAP_EMAIL`, and `BOOTSTRAP_PASSWORD`, then `npm run admin:bootstrap` in the owner environment. Remove bootstrap credentials afterward. Customer accounts and the branch are taken from the explicit supplier source. Administrators invite and scope staff/contractors through the portal.
5. Set `NODE_ENV=production`, HTTPS `APP_ORIGIN`, a random `METRICS_TOKEN` of at least 32 characters, and a fresh supplier source. Store `ANTHROPIC_API_KEY`, database URLs, backup key, and webhook credentials in the hosting secret manager. Production rejects embedded storage and accidental sample data. No example/default production passwords exist.
6. Start the app behind TLS. The Compose app binds only `127.0.0.1:3000`; expose it through your chosen HTTPS proxy. If forwarding client IPs, configure `TRUST_PROXY` to only the actual proxy addresses/CIDRs. Do not trust arbitrary forwarded headers. Configure matching Origin/cookies; there is no wildcard CORS bypass.
7. Configure encrypted scheduled backups, copy them off-host, enable provider database snapshots/PITR where available, and execute an isolated restore drill before admitting pilot users. Include credit reservations and server worker results in recovery; do not discard pending exposure when rebuilding the service.
8. Run the supplier-reviewed evaluation gate and role/access tests. Promote only a tested commit. Enable required CI status checks/branch protection in GitHub and use a protected deployment environment; those repository/hosting settings are operator configuration, not automatically enabled here.

Example secrets/configuration variables are in `.env.example`. Compose additionally requires `DATABASE_PASSWORD`, `RUNTIME_DATABASE_URL`, `BACKUP_DATABASE_URL`, and `SUPPLIER_DATA_DIRECTORY`. Passwords embedded in URLs must be URL encoded. Use PostgreSQL TLS (`sslmode=verify-full` plus your provider's CA configuration) for remote databases. The app never logs database URLs or credentials.

## Health, usage, and alerts

`GET /health` is process liveness; `GET /ready` checks the database. `GET /metrics` requires `Authorization: Bearer METRICS_TOKEN` and returns failure/token/search counters without quote/customer data. Structured request logs redact cookies, authorization, CSRF headers, and bodies. Internal errors return safe request IDs. A configured HTTPS `ALERT_WEBHOOK_URL` receives sanitized critical events, at most once per five minutes per process. No alert destination is contacted when unset.

Configure your hosting monitor to alert on readiness failures, repeated 5xx responses, backup job failures/age, disk growth, and unexpected model use. `DAILY_MODEL_CALLS` and `DAILY_TOKEN_BUDGET` control per-user model reservations; supplier budgets are ten times those defaults. Limit account provisioning and review quotas for pilot volume. API quotas use shared database counters. Authentication limits apply by email and IP. Session/activation/expired quota cleanup runs once per minute.

## Backup and restore

The operations container uses PostgreSQL-17 tools. Backups use a custom-format `pg_dump` streamed into AES-256-GCM encryption. The database password stays in the subprocess environment, never command arguments. Supply an independent base64-encoded 32-byte `BACKUP_KEY` from a secret manager, keep recovery access to it separate from backups, and mount a protected backup directory. The scheduled container runs every six hours by default and exits on a failed backup so monitoring can notify the operator. A named Docker volume is not off-site protection; configure encrypted archive replication/managed storage outside this host and a retention policy before production.

```text
node ops/backup.js
# Restore requires a different, newly created empty database:
RESTORE_DATABASE_URL=<private target URL>
RESTORE_CONFIRM_EMPTY=true
node ops/restore.js /protected/path/archive.enc
```

The restore script refuses the source database and nonempty targets. It verifies the entire authenticated archive before database writes, restores in a single transaction, revokes all restored sessions/activation tokens, appends a restore audit event, and checks revision/event counts. Plaintext temporary dumps are owner-readable and removed afterward. Reapply restricted runtime-role grants, validate memberships/scopes, and test sign-in before switching application traffic. Restore errors are masked; inspect operator configuration without logging credentials. Keep the old database available for rollback until verification completes.

CI's `ops/ci-recovery.js` creates only a disposable local database named `buildbridge_restore_<random>`, uses the operations image, compares restored revision counts, checks session revocation, then deletes that isolated test database. It refuses nonlocal/non-test source URLs. Unit tests additionally cover encrypted archive authentication and tamper rejection.

## Recovery procedure

For a bad release: stop new quote commitments, retain database state, roll back the application image to the prior tested commit, and check schema compatibility; do not roll back migrations by deleting production data. For database loss: restore to an isolated target, validate it, reapply runtime permissions, change the runtime database URL, restart the app, and require new sign-ins. For credential exposure: replace the provider/database secret in the hosting manager; use the operator password-reset CLI for affected users and revoke their sessions. Record the incident and verify unaffected account boundaries.

Real supplier data/hosting/secrets, off-site copies, alert destinations, deployment protection, and a completed production restore drill require operator configuration. These are explicit launch requirements, not claims that the repository has deployed or backed up your production system.
