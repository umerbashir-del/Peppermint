"""SQLite connection helper. Schema changes live in app/migrations.py, not here."""
import os
import sqlite3
from contextlib import contextmanager

DB_PATH = os.getenv("QBC_DB_PATH", "quote_builder.db")


@contextmanager
def connect():
    con = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    try:
        yield con
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


def init_db():
    from app.migrations import migrate

    migrate(DB_PATH)
