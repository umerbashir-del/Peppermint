"""Shared fixtures for API and crew tests. The fixture price list is TEST DATA, not real prices."""
import json

import pytest
from fastapi.testclient import TestClient

from app import ratelimit

FIXTURE_PRICE_LIST = b"""name,unit,unit_price,supplier
3/4in copper pipe,ft,4.20,Test Supplier
Shutoff valve 3/4in,ea,12.50,Test Supplier
Copper pipe 1/2in,ft,2.10,Test Supplier
PEX adapter,ea,3.75,Test Supplier
"""
BOOTSTRAP_SECRET = "bootstrap-test-secret"
GOOD_PASSWORD = "correct-horse-battery-staple"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    db_path = str(tmp_path / "test.db")
    monkeypatch.setenv("QBC_DB_PATH", db_path)
    monkeypatch.setenv("QBC_SECRET_KEY", "test-secret-that-is-long-enough-for-hmac")
    monkeypatch.setenv("QBC_BOOTSTRAP_SECRET", BOOTSTRAP_SECRET)
    monkeypatch.setenv("QBC_ALLOW_MULTI_TENANT_BOOTSTRAP", "1")
    monkeypatch.delenv("QBC_SECRET_KEY_PREVIOUS", raising=False)
    import app.db as db
    monkeypatch.setattr(db, "DB_PATH", db_path)
    ratelimit.reset()
    import app.main as main
    with TestClient(main.app) as test_client:
        yield test_client


def bootstrap_owner(client, tenant="tenant-a", email="owner@example.test"):
    r = client.post("/auth/bootstrap", json={"tenant_id": tenant, "email": email, "password": GOOD_PASSWORD},
                    headers={"X-Bootstrap-Secret": BOOTSTRAP_SECRET})
    assert r.status_code == 200, r.text
    return login(client, tenant, email, GOOD_PASSWORD)


def login(client, tenant, email, password):
    r = client.post("/auth/login", json={"tenant_id": tenant, "email": email, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def add_user(client, headers, email, role, tenant="tenant-a"):
    r = client.post("/users", json={"email": email, "password": GOOD_PASSWORD, "role": role}, headers=headers)
    assert r.status_code == 200, r.text
    return login(client, tenant, email, GOOD_PASSWORD)


def upload_prices(client, headers, body=FIXTURE_PRICE_LIST):
    return client.post("/price-lists", content=body, headers={**headers, "Content-Type": "text/csv"})


def set_profile(client, headers, labor_rate=45, license_number="TEST-LIC-1"):
    r = client.put("/profile", json={"license_number": license_number, "insurance_text": "Test insurance $1,000,000",
                                     "payment_terms": "Net 15", "labor_rate": labor_rate, "valid_until_days": 30},
                   headers=headers)
    assert r.status_code == 200, r.text


def workspace(client, tenant="tenant-a"):
    """Owner, profile, price list and one project. Returns a dict of headers and ids."""
    owner = bootstrap_owner(client, tenant=tenant, email=f"owner@{tenant}.test")
    set_profile(client, owner)
    up = upload_prices(client, owner)
    assert up.status_code == 200, up.text
    project = client.post("/projects", json={"name": "Test kitchen"}, headers=owner).json()
    return {"owner": owner, "project_id": project["id"]}


def estimator_pick(user_text: str) -> str:
    """Scripted estimator: picks the candidate whose name equals the item name, else null."""
    payload = json.loads(user_text.split("<items>")[1].split("</items>")[0])
    matches = []
    for item in payload:
        pick = next((c["id"] for c in item["candidates"] if c["name"].lower() == item["name"].lower()), None)
        matches.append({"index": item["index"], "price_item_id": pick})
    return json.dumps({"matches": matches})


PLAN_TWO_ITEMS = json.dumps({"items": [
    {"trade": "plumbing", "name": "3/4in copper pipe", "quantity": 40, "unit": "ft", "labor_hours_per_unit": 0.1, "waste_pct": 0.05},
    {"trade": "plumbing", "name": "Shutoff valve 3/4in", "quantity": 2, "unit": "ea", "labor_hours_per_unit": 0.5, "waste_pct": 0},
]})
SHELL_TWO_LINES = json.dumps({"scope_text": "We will replace the copper supply pipe and install new shutoff valves.",
                              "assumptions": ["Access to the work area"], "exclusions": ["Permits"],
                              "line_labels": ["Copper pipe", "Shutoff valves"], "questions": []})
WRITER_TWO_LINES = json.dumps({"lines_text": ["Copper pipe: {{line_1_total}}", "Shutoff valves: {{line_2_total}}"],
                               "total_text": "Total: {{grand_total}}"})


def happy_responder(prompt_name: str, user: str) -> str:
    if prompt_name == "pricing_lead":
        return PLAN_TWO_ITEMS
    if prompt_name == "estimator":
        return estimator_pick(user)
    if prompt_name == "quote_lead":
        return SHELL_TWO_LINES
    if prompt_name == "writer":
        return WRITER_TWO_LINES
    raise AssertionError(f"unexpected prompt {prompt_name}")


def use_fake(monkeypatch, responder, delay=0.0):
    from app.crew import service
    from app.crew.fake import FakeGateway
    fake = FakeGateway(responder, delay=delay)
    monkeypatch.setattr(service, "get_gateway", lambda: fake)
    return fake
