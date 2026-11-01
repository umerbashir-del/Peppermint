"""Red-team cases from Quote_Builder_Crew_Aggressive_Red_Team_Assessment.md, run against the real endpoints.

Not covered here (no such surface in this build): RT-002 supplier pages, RT-023 parser sandboxing,
RT-029 currency conversion, RT-030 SSRF, and O2 (license registry). See docs/PRODUCTION_READINESS.md.
"""
import json
import sqlite3
from contextlib import closing

from tests.helpers import GOOD_PASSWORD, add_user, happy_responder, upload_prices, use_fake, workspace
from tests.test_api import _price_id, _quote, _scope


def _approved_quote(client, ws):
    price = _price_id(client, ws["owner"], "3/4in copper pipe")
    _scope(client, ws["owner"], ws["project_id"], price, qty=2)
    q = _quote(client, ws["owner"], ws["project_id"]).json()
    reviewer = add_user(client, ws["owner"], "rev@tenant-a.test", "reviewer")
    return q, reviewer


def test_rt003_client_cost_is_never_trusted(client):
    """A scope cannot carry its own cost or an 'approved' flag. Only a real source sets the price."""
    ws = workspace(client)
    price = _price_id(client, ws["owner"], "3/4in copper pipe")
    r = client.post(f"/projects/{ws['project_id']}/scopes", headers=ws["owner"], json={
        "description": "Pipe", "quantity": 10, "unit": "ft", "waste_pct": 0, "material_unit_cost": 0.01,
        "source_type": "price_item", "source_id": price, "source_status": "APPROVED"})
    assert r.status_code == 200
    assert r.json()["material_unit_cost"] == 0
    q = _quote(client, ws["owner"], ws["project_id"]).json()
    assert q["costs"]["materials"] == "42.00"  # 10 x 4.20 from the price list, not 0.01


def test_rt003_forged_source_reference_is_rejected(client):
    ws = workspace(client)
    r = client.post(f"/projects/{ws['project_id']}/scopes", headers=ws["owner"], json={
        "description": "Pipe", "quantity": 1, "unit": "ft", "source_type": "price_item", "source_id": "forged-id"})
    assert r.status_code == 422


def test_rt004_expired_evidence_fails_closed_at_quote_time(client):
    ws = workspace(client)
    scope = client.post(f"/projects/{ws['project_id']}/scopes", headers=ws["owner"], json={
        "description": "Pipe", "quantity": 1, "unit": "ft", "waste_pct": 0}).json()
    client.post("/evidence", headers=ws["owner"], json={
        "scope_id": scope["id"], "supplier": "Quote Co", "source_type": "supplier_quote", "unit_cost": 5, "unit": "ft",
        "spec": "3/4in copper", "valid_until": "2099-01-01", "sha256": "c" * 64, "stock_confirmed": True, "commercial_use": True})
    import app.db as db
    with closing(sqlite3.connect(db.DB_PATH)) as con, con:
        con.execute("UPDATE evidence SET valid_until='2020-01-01' WHERE scope_id=?", (scope["id"],))
    r = _quote(client, ws["owner"], ws["project_id"])
    assert r.status_code == 422
    assert "expired" in r.json()["detail"]["unsourced"][0]["reason"]


def test_rt006_only_same_unit_items_are_offered_as_candidates():
    from app.crew.contracts import PlannedItem
    from app.crew.pipeline import _candidates
    catalog = [{"id": "pipe", "name": "3/4in copper pipe", "unit": "ft", "unit_price": "4.20"},
               {"id": "adapter", "name": "3/4in copper pipe adapter", "unit": "ea", "unit_price": "3.75"}]
    item = PlannedItem(trade="plumbing", name="3/4in copper pipe", quantity=40, unit="ft")
    assert [c["id"] for c in _candidates(catalog, item)] == ["pipe"]


def test_rt007_cross_tenant_job_and_quote_ids_are_denied(client, monkeypatch):
    a = workspace(client, "tenant-a")
    b = workspace(client, "tenant-b")
    use_fake(monkeypatch, happy_responder)
    job = client.post("/jobs", json={"notes": "Replace 40 ft of 3/4in copper pipe", "project_name": "P"},
                      headers={**a["owner"], "Idempotency-Key": "tenant-a-job-1"}).json()
    assert client.get(f"/jobs/{job['id']}", headers=b["owner"]).status_code == 404
    assert client.post(f"/jobs/{job['id']}/answers", json={"answers": "x"}, headers=b["owner"]).status_code == 404
    if job.get("quote"):
        assert client.get(f"/quotes/{job['quote']['id']}", headers=b["owner"]).status_code == 404
        assert client.get(f"/quotes/{job['quote']['id']}/pdf", headers=b["owner"]).status_code == 404


def test_rt010_tampered_snapshot_is_detected_and_pdf_is_refused(client):
    ws = workspace(client)
    q, reviewer = _approved_quote(client, ws)
    client.post(f"/quotes/{q['id']}/approve", headers=reviewer, json={"snapshot_hash": q["snapshot_hash"]})
    import app.db as db
    with closing(sqlite3.connect(db.DB_PATH)) as con, con:
        snap = json.loads(con.execute("SELECT snapshot_json FROM quotes WHERE id=?", (q["id"],)).fetchone()[0])
        snap["costs"]["total"] = "1.00"
        con.execute("UPDATE quotes SET snapshot_json=? WHERE id=?", (json.dumps(snap), q["id"]))
    detail = client.get(f"/quotes/{q['id']}", headers=ws["owner"]).json()
    assert detail["snapshot_verified"] is False
    assert client.get(f"/quotes/{q['id']}/pdf", headers=ws["owner"]).status_code == 409


def test_rt013_approval_cannot_be_reused_after_content_changes(client):
    ws = workspace(client)
    q, reviewer = _approved_quote(client, ws)
    old_hash = q["snapshot_hash"]
    price = _price_id(client, ws["owner"], "3/4in copper pipe")
    _scope(client, ws["owner"], ws["project_id"], price, qty=50)
    newer = _quote(client, ws["owner"], ws["project_id"]).json()
    assert newer["snapshot_hash"] != old_hash
    assert client.post(f"/quotes/{q['id']}/approve", headers=reviewer, json={"snapshot_hash": old_hash}).status_code == 409
    assert client.post(f"/quotes/{newer['id']}/approve", headers=reviewer, json={"snapshot_hash": old_hash}).status_code == 409


def test_rt014_unknown_or_send_actions_are_denied(client):
    ws = workspace(client)
    q, _ = _approved_quote(client, ws)
    for path in (f"/quotes/{q['id']}/send", f"/quotes/{q['id']}/email", f"/quotes/{q['id']}/publish"):
        assert client.post(path, headers=ws["owner"], json={}).status_code in (404, 405)


def test_rt017_synthetic_and_benchmark_sources_are_refused(client):
    ws = workspace(client)
    scope = client.post(f"/projects/{ws['project_id']}/scopes", headers=ws["owner"], json={
        "description": "Pipe", "quantity": 1, "unit": "ft", "waste_pct": 0}).json()
    for source in ("synthetic", "benchmark", "catalog"):
        r = client.post("/evidence", headers=ws["owner"], json={
            "scope_id": scope["id"], "supplier": "Dataset", "source_type": source, "unit_cost": 5, "unit": "ft",
            "spec": "x", "valid_until": "2099-01-01", "sha256": "d" * 64, "stock_confirmed": True, "commercial_use": True})
        assert r.status_code == 422


def test_rt018_non_commercial_evidence_is_refused(client):
    ws = workspace(client)
    scope = client.post(f"/projects/{ws['project_id']}/scopes", headers=ws["owner"], json={
        "description": "Pipe", "quantity": 1, "unit": "ft", "waste_pct": 0}).json()
    r = client.post("/evidence", headers=ws["owner"], json={
        "scope_id": scope["id"], "supplier": "Dataset", "source_type": "supplier_quote", "unit_cost": 5, "unit": "ft",
        "spec": "x", "valid_until": "2099-01-01", "sha256": "e" * 64, "stock_confirmed": True, "commercial_use": False})
    assert r.status_code == 422


def test_rt022_oversized_price_list_is_refused(client):
    owner = workspace(client)["owner"]
    big = b"name,unit,unit_price\n" + b"".join(b"Item %d,ea,1\n" % i for i in range(120000))
    assert len(big) > 1_000_000
    assert upload_prices(client, owner, big).status_code == 413


def test_rt026_model_cannot_set_status_or_approval(client, monkeypatch):
    ws = workspace(client)
    shell = json.loads(happy_responder("quote_lead", ""))
    shell.update({"status": "approved", "approved_by": "me", "snapshot_hash": "0" * 64})
    use_fake(monkeypatch, lambda p, u: json.dumps(shell) if p == "quote_lead" else happy_responder(p, u))
    job = client.post("/jobs", json={"notes": "Replace 40 ft of 3/4in copper pipe, 2 shutoff valves", "project_name": "P"},
                      headers={**ws["owner"], "Idempotency-Key": "rt026-job-0001"}).json()
    assert job["status"] == "ready"
    assert job["quote"]["id"] and client.get(f"/quotes/{job['quote']['id']}", headers=ws["owner"]).json()["quote"]["status"] == "draft"


def test_rt025_retry_with_same_key_creates_no_duplicate(client, monkeypatch):
    ws = workspace(client)
    use_fake(monkeypatch, happy_responder)
    body = {"notes": "Replace 40 ft of 3/4in copper pipe, 2 shutoff valves", "project_name": "P"}
    first = client.post("/jobs", json=body, headers={**ws["owner"], "Idempotency-Key": "retry-key-0001"}).json()
    second = client.post("/jobs", json=body, headers={**ws["owner"], "Idempotency-Key": "retry-key-0001"}).json()
    assert first["id"] == second["id"]
    assert len(client.get("/quotes", headers=ws["owner"]).json()) == 1


def test_no_password_in_any_logged_or_returned_error(client):
    r = client.post("/auth/login", json={"tenant_id": "nobody", "email": "x@y.test", "password": GOOD_PASSWORD})
    assert r.status_code == 401
    assert GOOD_PASSWORD not in r.text


def test_stale_price_list_warns_but_does_not_block(client):
    """A price list older than 90 days produces a warning on the quote. It never changes a price."""
    ws = workspace(client)
    price = _price_id(client, ws["owner"], "3/4in copper pipe")
    _scope(client, ws["owner"], ws["project_id"], price, qty=2)
    import app.db as db
    with closing(sqlite3.connect(db.DB_PATH)) as con, con:
        con.execute("UPDATE price_lists SET uploaded_at='2020-01-01T00:00:00+00:00'")
    q = _quote(client, ws["owner"], ws["project_id"])
    assert q.status_code == 200, q.text
    assert any("more than 90 days old" in w for w in q.json()["warnings"])
    assert q.json()["costs"]["materials"] == "9.24"  # 2 x 4.20 x 1.10 waste


def test_duplicate_price_names_are_all_offered_as_candidates():
    from app.crew.contracts import PlannedItem
    from app.crew.pipeline import _candidates
    catalog = [{"id": "a", "name": "Copper elbow", "unit": "ea", "unit_price": "1.00"},
               {"id": "b", "name": "Copper elbow", "unit": "ea", "unit_price": "1.50"}]
    item = PlannedItem(trade="plumbing", name="Copper elbow", quantity=2, unit="ea")
    assert {c["id"] for c in _candidates(catalog, item)} == {"a", "b"}


def test_evidence_source_must_be_on_the_allowlist(client):
    ws = workspace(client)
    scope = client.post(f"/projects/{ws['project_id']}/scopes", headers=ws["owner"], json={
        "description": "Pipe", "quantity": 1, "unit": "ft", "waste_pct": 0}).json()
    r = client.post("/evidence", headers=ws["owner"], json={
        "scope_id": scope["id"], "supplier": "Who", "source_type": "handwritten_note", "unit_cost": 5, "unit": "ft",
        "spec": "x", "valid_until": "2099-01-01", "sha256": "f" * 64, "stock_confirmed": True, "commercial_use": True})
    assert r.status_code == 422
