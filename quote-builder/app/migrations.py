"""Versioned schema migrations. Run with `python -m app.migrations` before starting the API.

Each migration is applied once, in order, and recorded in schema_migrations. Migrations
must be safe on databases created by earlier builds, so columns are added only if missing.
"""
import sqlite3
import sys
from datetime import UTC, datetime


def _columns(con, table):
    return {row[1] for row in con.execute(f"PRAGMA table_info({table})")}


def _add_column(con, table, column, decl):
    if column not in _columns(con, table):
        con.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")


def m001_base(con):
    con.executescript("""
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, email TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('owner','admin','estimator','reviewer','viewer')),
        password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(tenant_id,email));
    CREATE TABLE IF NOT EXISTS customers(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
        email TEXT, phone TEXT, address TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
        customer_id TEXT REFERENCES customers(id), name TEXT NOT NULL, address TEXT,
        status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS scopes(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id), description TEXT NOT NULL,
        quantity REAL NOT NULL CHECK(quantity>=0), unit TEXT NOT NULL,
        material_unit_cost REAL NOT NULL DEFAULT 0, labor_hours_per_unit REAL NOT NULL DEFAULT 0,
        labor_rate REAL NOT NULL DEFAULT 0, waste_pct REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS quotes(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id), version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'draft', overhead_pct REAL NOT NULL DEFAULT 0,
        markup_pct REAL NOT NULL DEFAULT 0, tax_rate REAL NOT NULL DEFAULT 0,
        discount REAL NOT NULL DEFAULT 0, delivery REAL NOT NULL DEFAULT 0,
        subtotal REAL NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL REFERENCES users(id), approved_by TEXT REFERENCES users(id),
        approved_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS evidence(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
        scope_id TEXT NOT NULL REFERENCES scopes(id), supplier TEXT NOT NULL, source_type TEXT NOT NULL,
        unit_cost REAL NOT NULL CHECK(unit_cost>=0), currency TEXT NOT NULL DEFAULT 'USD',
        spec TEXT NOT NULL, valid_until TEXT, sha256 TEXT NOT NULL,
        stock_confirmed INTEGER NOT NULL CHECK(stock_confirmed IN (0,1)),
        commercial_use INTEGER NOT NULL CHECK(commercial_use IN (0,1)),
        created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS audit_log(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, actor_id TEXT,
        action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    """)


def m002_pricing_and_snapshots(con):
    for col, decl in [("reviewed_by", "TEXT REFERENCES users(id)"), ("reviewed_at", "TEXT"),
                      ("review_reason", "TEXT"), ("snapshot_json", "TEXT"), ("snapshot_hash", "TEXT")]:
        _add_column(con, "quotes", col, decl)
    for col, decl in [("source_type", "TEXT"), ("source_id", "TEXT")]:
        _add_column(con, "scopes", col, decl)
    _add_column(con, "evidence", "unit", "TEXT")
    con.executescript("""
    CREATE TABLE IF NOT EXISTS price_lists(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, sha256 TEXT NOT NULL,
        accepted_count INTEGER NOT NULL, rejected_count INTEGER NOT NULL, uploaded_by TEXT NOT NULL,
        uploaded_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS price_items(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
        price_list_id TEXT NOT NULL REFERENCES price_lists(id), name TEXT NOT NULL, unit TEXT NOT NULL,
        unit_price TEXT NOT NULL, supplier TEXT, source_row INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS contractor_profiles(tenant_id TEXT PRIMARY KEY, license_number TEXT,
        insurance_text TEXT, payment_terms TEXT, labor_rate TEXT, valid_until_days INTEGER NOT NULL DEFAULT 30,
        updated_by TEXT, updated_at TEXT);
    """)


def m003_audit_chain(con):
    _add_column(con, "audit_log", "prev_hash", "TEXT")
    _add_column(con, "audit_log", "hash", "TEXT")


def m004_auth_hardening(con):
    _add_column(con, "users", "token_version", "INTEGER NOT NULL DEFAULT 0")
    con.executescript("""
    CREATE TABLE IF NOT EXISTS login_attempts(key TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0,
        locked_until REAL NOT NULL DEFAULT 0);
    """)


def m005_jobs_and_indexes(con):
    con.executescript("""
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL, notes TEXT NOT NULL,
        project_name TEXT NOT NULL, customer_name TEXT, idempotency_key TEXT NOT NULL,
        project_id TEXT, quote_id TEXT, result_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(tenant_id, idempotency_key));
    CREATE INDEX IF NOT EXISTS idx_scopes_project ON scopes(project_id);
    CREATE INDEX IF NOT EXISTS idx_quotes_project ON quotes(project_id);
    CREATE INDEX IF NOT EXISTS idx_price_items_tenant_name ON price_items(tenant_id, name);
    """)


MIGRATIONS = [
    (1, "base_schema", m001_base),
    (2, "pricing_and_snapshots", m002_pricing_and_snapshots),
    (3, "audit_chain", m003_audit_chain),
    (4, "auth_hardening", m004_auth_hardening),
    (5, "jobs_and_indexes", m005_jobs_and_indexes),
]


def migrate(path):
    con = sqlite3.connect(path, timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    # WAL lets readers continue while a write is in progress. The setting is stored in the database file.
    con.execute("PRAGMA journal_mode=WAL")
    try:
        con.execute("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)")
        applied = {r["version"] for r in con.execute("SELECT version FROM schema_migrations")}
        for version, name, fn in MIGRATIONS:
            if version in applied:
                continue
            with con:
                fn(con)
                con.execute("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)",
                            (version, name, datetime.now(UTC).isoformat()))
            print(f"applied migration {version} {name}", file=sys.stderr)
    finally:
        con.close()


if __name__ == "__main__":
    import os

    migrate(os.getenv("QBC_DB_PATH", "quote_builder.db"))
