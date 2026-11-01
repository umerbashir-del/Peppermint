import base64
import hashlib
import hmac
import json
import os
import time

from fastapi import Header, HTTPException

from app.db import connect

PBKDF2_ROUNDS = 310000
MIN_PASSWORD = 14
MAX_PASSWORD = 256
TOKEN_TTL_SECONDS = 3600


def validate_password(password: str) -> None:
    if not (MIN_PASSWORD <= len(password) <= MAX_PASSWORD):
        raise HTTPException(422, f"Password must be {MIN_PASSWORD}-{MAX_PASSWORD} characters")


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ROUNDS)
    return f"pbkdf2_sha256${PBKDF2_ROUNDS}$" + base64.urlsafe_b64encode(salt).decode() + "$" + base64.urlsafe_b64encode(digest).decode()


def verify_password(password: str, encoded: str) -> bool:
    try:
        _, rounds, salt, digest = encoded.split("$")
        actual = hashlib.pbkdf2_hmac("sha256", password.encode(), base64.urlsafe_b64decode(salt), int(rounds))
        return hmac.compare_digest(base64.urlsafe_b64encode(actual).decode(), digest)
    except Exception:
        return False


# Used when no account matches, so unknown users cost the same time as wrong passwords.
DUMMY_HASH = hash_password("dummy-password-for-timing-only")


def _signing_keys() -> list[str]:
    """Current key first, then the previous key during rotation. Keys shorter than 32 chars are refused."""
    keys = [os.getenv("QBC_SECRET_KEY"), os.getenv("QBC_SECRET_KEY_PREVIOUS")]
    usable = [k for k in keys if k and len(k) >= 32]
    if not usable:
        raise RuntimeError("QBC_SECRET_KEY must be configured with at least 32 characters")
    return usable


def _sign(secret: str, body: str) -> str:
    return hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()


def token_for(user: dict) -> str:
    payload = {"sub": user["id"], "tenant": user["tenant_id"], "role": user["role"],
               "ver": int(user["token_version"]), "exp": int(time.time()) + TOKEN_TTL_SECONDS}
    body = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode().rstrip("=")
    return body + "." + _sign(_signing_keys()[0], body)


def current_user(authorization: str | None = Header(default=None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Bearer token required")
    try:
        body, sig = authorization[7:].split(".")
        if not any(hmac.compare_digest(sig, _sign(k, body)) for k in _signing_keys()):
            raise ValueError("bad signature")
        payload = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
        if payload["exp"] < time.time():
            raise ValueError("expired")
        with connect() as c:
            row = c.execute("SELECT id, tenant_id, role, active, token_version FROM users WHERE id=?", (payload["sub"],)).fetchone()
        # Authority is re-read on every request: deactivation, role change and logout all take effect at once.
        if not row or not row["active"]:
            raise ValueError("inactive")
        if row["tenant_id"] != payload["tenant"] or row["role"] != payload["role"] or row["token_version"] != payload["ver"]:
            raise ValueError("stale token")
        return {"id": row["id"], "tenant_id": row["tenant_id"], "role": row["role"]}
    except (ValueError, KeyError, TypeError):
        raise HTTPException(401, "Invalid or expired token") from None
