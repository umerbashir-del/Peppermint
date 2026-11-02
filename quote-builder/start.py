"""Render/container entry point. Run one API worker while storage is SQLite."""
import os
import sys
from pathlib import Path

from app.config import cors_origins


def validate_environment(env):
    if len(env.get('QBC_SECRET_KEY', '')) < 32:
        raise ValueError('Set QBC_SECRET_KEY to a random value of at least 32 characters.')
    if not env.get('ANTHROPIC_API_KEY') or not env.get('ANTHROPIC_MODEL'):
        raise ValueError('Set ANTHROPIC_API_KEY and ANTHROPIC_MODEL in the backend environment.')
    if not cors_origins(env.get('QBC_CORS_ORIGINS', '')):
        raise ValueError('Set QBC_CORS_ORIGINS to the exact frontend origin.')
    port = int(env.get('PORT', '10000'))
    if not 1 <= port <= 65535:
        raise ValueError('PORT must be between 1 and 65535.')
    db = Path(env.get('QBC_DB_PATH', '/var/data/quote_builder.db'))
    if not db.is_absolute():
        raise ValueError('QBC_DB_PATH must be an absolute path on persistent storage.')
    return port, db


def main():
    port, db = validate_environment(os.environ)
    db.parent.mkdir(parents=True, exist_ok=True)
    # Render mounts disks at runtime. Image-time permissions cannot prepare the mount.
    account = os.environ.get('QBC_CONTAINER_USER')
    if account and hasattr(os, 'getuid') and os.getuid() == 0:
        import pwd
        user = pwd.getpwnam(account)
        os.chown(db.parent, user.pw_uid, user.pw_gid)
        os.setgroups([])
        os.setgid(user.pw_gid)
        os.setuid(user.pw_uid)
    os.execv(sys.executable, [sys.executable, '-m', 'uvicorn', 'app.main:app',
                            '--app-dir', 'quote-builder', '--host', '0.0.0.0', '--port', str(port),
                            '--workers', '1', '--timeout-graceful-shutdown', '210'])


if __name__ == '__main__':
    main()
