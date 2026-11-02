# Runbook

## Deploy (Fly.io, single machine)
1. `fly apps create <name>`; set `app` and region in `fly.toml`.
2. `fly volumes create qbc_data --region <region> --size 1`
3. `fly secrets set QBC_SECRET_KEY=... QBC_BOOTSTRAP_SECRET=... QBC_LLM_BASE_URL=... QBC_LLM_API_KEY=... QBC_MODEL_STRONG=... QBC_MODEL_MID=... QBC_MODEL_SMALL=...`
4. `fly deploy`. Migrations run at startup (idempotent). `/ready` gates traffic.
5. Bootstrap the first owner, then `fly secrets unset QBC_BOOTSTRAP_SECRET`.

Do not scale above one machine while the database is SQLite on a volume.

## Backup and restore
- Back up the volume's database file with SQLite's online backup, not a raw file copy while writing:
  `sqlite3 /data/quote_builder.db ".backup /data/backup-$(date +%F).db"`
- Restore drill (do this before go-live, then monthly): copy the backup to a scratch machine, start the app with `QBC_DB_PATH` pointing at it, and check `/ready`, `GET /audit/verify` (must return `ok: true`), and one approved quote's PDF.

## Key rotation
1. Generate a new key. Set `QBC_SECRET_KEY_PREVIOUS` to the current key and `QBC_SECRET_KEY` to the new one. Deploy.
2. Tokens signed by either key are accepted for their remaining lifetime (1 hour).
3. After one hour, unset `QBC_SECRET_KEY_PREVIOUS`.

## Incidents
- **Suspected account compromise:** deactivate the user with `PATCH /users/{id}` (this revokes their tokens), then review `GET /audit`.
- **Suspected wrong quote sent:** the system never sends. Check `GET /audit` for approvals and the snapshot hash that was approved.
- **Audit verification fails:** stop writes, snapshot the database, and treat the rows after the first bad row as tampered.
- **Sign-in throttled:** the website limits sign-in requests to 20 per IP per minute. Wait one minute before retrying. There is no per-account failed-password lockout; a correct password works even if a legacy `login_attempts` row remains. Repeated invalid-credential responses require checking the workspace ID, email, and password.
- **LLM gateway down:** `POST /jobs` returns 502/503 or a failed half. The rest of the app keeps working.

## Data handling
- Job notes, customer names and quotes are personal and business data. Set a retention period for `jobs` and `audit_log` before real customers use the system (not yet automated).
- Do not paste real supplier price lists into test environments.
