import base64
import json
import time

import pytest
from fastapi import HTTPException

from app import ratelimit
from app.logging_setup import redact
from app.security import _sign, hash_password, token_for, validate_password, verify_password
from tests.helpers import GOOD_PASSWORD, bootstrap_owner


def test_password_policy_bounds():
    validate_password(GOOD_PASSWORD)
    with pytest.raises(HTTPException):
        validate_password("short")
    with pytest.raises(HTTPException):
        validate_password("x" * 300)


def test_password_hash_verifies_and_is_salted():
    a, b = hash_password(GOOD_PASSWORD), hash_password(GOOD_PASSWORD)
    assert a != b
    assert verify_password(GOOD_PASSWORD, a) and not verify_password("wrong", a)
    assert not verify_password(GOOD_PASSWORD, "not-a-hash")


def test_token_signed_with_previous_key_is_accepted_during_rotation(client, monkeypatch):
    headers = bootstrap_owner(client)
    token = headers["Authorization"].split(" ")[1]
    body, _ = token.split(".")
    monkeypatch.setenv("QBC_SECRET_KEY", "a-brand-new-secret-key-that-is-long-enough")
    monkeypatch.setenv("QBC_SECRET_KEY_PREVIOUS", "test-secret-that-is-long-enough-for-hmac")
    assert client.get("/projects", headers=headers).status_code == 200
    monkeypatch.delenv("QBC_SECRET_KEY_PREVIOUS")
    assert client.get("/projects", headers=headers).status_code == 401


def test_expired_token_is_rejected(client, monkeypatch):
    headers = bootstrap_owner(client)
    token = headers["Authorization"].split(" ")[1]
    body, _ = token.split(".")
    payload = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    payload["exp"] = int(time.time()) - 10
    new_body = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode().rstrip("=")
    forged = new_body + "." + _sign("test-secret-that-is-long-enough-for-hmac", new_body)
    assert client.get("/projects", headers={"Authorization": f"Bearer {forged}"}).status_code == 401


def test_tampered_token_is_rejected(client):
    headers = bootstrap_owner(client)
    token = headers["Authorization"].split(" ")[1]
    body, sig = token.split(".")
    assert client.get("/projects", headers={"Authorization": f"Bearer {body}.{'0' * len(sig)}"}).status_code == 401


def test_short_signing_key_is_refused(monkeypatch):
    monkeypatch.setenv("QBC_SECRET_KEY", "too-short")
    with pytest.raises(RuntimeError):
        token_for({"id": "1", "tenant_id": "t", "role": "owner", "token_version": 0})


def test_log_redaction_removes_bearer_tokens_and_secrets():
    text = redact("Authorization: Bearer abc.def-ghi password=hunter2 api_key: sk-123")
    assert "abc.def" not in text and "hunter2" not in text and "sk-123" not in text
    assert "[REDACTED]" in text


def test_rate_limiter_blocks_after_limit():
    ratelimit.reset()
    assert [ratelimit.allow("k", 3, 60) for _ in range(4)] == [True, True, True, False]
    ratelimit.reset()
    assert ratelimit.allow("k", 3, 60)


def test_login_rate_limit_per_ip(client):
    ratelimit.reset()
    statuses = [client.post("/auth/login", json={"tenant_id": "t", "email": "a@b.test", "password": "wrong-password-x"}).status_code
                for _ in range(21)]
    assert statuses[-1] == 429
