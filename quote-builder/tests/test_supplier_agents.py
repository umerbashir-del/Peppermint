import asyncio
import json
import os
import subprocess
from pathlib import Path

import httpx
import pytest

from app import supplier_agents
from app.crew import llm
from tests.helpers import add_user, workspace

ROOT = Path(__file__).resolve().parents[2]


def result(text='10 of 2x4x8 SPF studs'):
    # Actual JavaScript parser and supplier, with live model transport disabled only in this fixture.
    script = "import{runWebsiteAgents}from'./src/website-agents.js';import{loadSupplier}from'./src/supplier-tools.js';let s='';for await(const c of process.stdin)s+=c;console.log(JSON.stringify(await runWebsiteAgents(JSON.parse(s),{load:async()=>({binding:{account_id:'normal',branch:'sample-main'},data:await loadSupplier()}),live:false,runResearch:async task=>({schema_version:'1.0',request_id:task.request_id,task_id:task.task_id,agent:'research',status:'needs_human_review',data:null,issues:[],handoffs:[],approval_required:true})})));"
    payload = {'operation': 'run', 'tenant_id': 'tenant-a', 'request_id': 'cross-language-test', 'text': text}
    return json.loads(subprocess.check_output(['node', '--input-type=module', '-e', script], input=json.dumps(payload).encode(), cwd=ROOT, timeout=30))


def test_supplier_job_cross_language_quote_approval_and_pdf(client, monkeypatch):
    ws = workspace(client)
    agents = result()
    seen = []
    async def fake(payload):
        seen.append(payload)
        return agents
    monkeypatch.setattr(supplier_agents, 'bridge', fake)
    job = client.post('/jobs', headers={**ws['owner'], 'Idempotency-Key': 'supplier-test-key'}, json={'workflow': 'supplier', 'notes': '10 of 2x4x8 SPF studs', 'project_name': 'Materials'}).json()
    assert job['status'] == 'ready', job
    assert job['quote']['costs']['total'] == '38.64'
    assert seen[0]['tenant_id'] == 'tenant-a'
    quote = job['quote']
    assert client.post(f"/quotes/{quote['id']}/approve", headers=ws['owner'], json={'snapshot_hash': quote['snapshot_hash']}).status_code == 403
    reviewer = add_user(client, ws['owner'], 'reviewer@tenant.test', 'reviewer')
    assert client.post(f"/quotes/{quote['id']}/approve", headers=reviewer, json={'snapshot_hash': quote['snapshot_hash']}).status_code == 200
    assert seen[-1]['operation'] == 'check'
    assert seen[-1]['commercial_total_cents'] == 3864
    assert client.get(f"/quotes/{quote['id']}/pdf", headers=ws['owner']).content.startswith(b'%PDF')
    assert client.post('/quotes', headers=ws['owner'], json={'project_id': job['project_id']}).status_code == 409
    viewer = add_user(client, ws['owner'], 'viewer@tenant.test', 'viewer')
    assert 'agents' not in client.get(f"/jobs/{job['id']}", headers=viewer).json()
    assert 'notes' not in client.get(f"/jobs/{job['id']}", headers=viewer).json()
    assert client.get(f"/jobs/{job['id']}", headers=ws['owner']).json()['notes'] == '10 of 2x4x8 SPF studs'
    assert client.get('/auth/me', headers=reviewer).json()['role'] == 'reviewer'
    assert client.get('/auth/me').status_code == 401
    assert 'supplier_agents' not in client.get(f"/quotes/{quote['id']}", headers=viewer).json()['snapshot']
    other = workspace(client, tenant='tenant-b')
    assert client.get(f"/jobs/{job['id']}", headers=other['owner']).status_code == 404


def test_research_and_partial_stock_are_visible_and_do_not_build_a_quote(client, monkeypatch):
    ws = workspace(client)
    agents = result('40 of 2x10x12 SPF joists')
    async def fake(payload): return agents
    monkeypatch.setattr(supplier_agents, 'bridge', fake)
    job = client.post('/jobs', headers={**ws['owner'], 'Idempotency-Key': 'supplier-partial-key'}, json={'workflow': 'supplier', 'notes': '40 of 2x10x12 SPF joists', 'project_name': 'Joists'}).json()
    assert job['status'] == 'needs_input'
    assert job['quote'] is None
    assert job['agents']['research']
    corrected = result()
    async def answer(payload):
        assert payload['text'] == '10 of 2x4x8 SPF studs'
        return corrected
    monkeypatch.setattr(supplier_agents, 'bridge', answer)
    assert client.post(f"/jobs/{job['id']}/answers", headers=ws['owner'], json={'answers': '10 of 2x4x8 SPF studs'}).json()['status'] == 'ready'


def test_changed_supplier_data_blocks_approval(client, monkeypatch):
    ws = workspace(client)
    agents = result()
    async def initial(payload): return agents
    monkeypatch.setattr(supplier_agents, 'bridge', initial)
    job = client.post('/jobs', headers={**ws['owner'], 'Idempotency-Key': 'supplier-stale-key'}, json={'workflow': 'supplier', 'notes': '10 of 2x4x8 SPF studs', 'project_name': 'Materials'}).json()
    async def changed(payload): return {**agents, 'fingerprint': 'changed'}
    monkeypatch.setattr(supplier_agents, 'bridge', changed)
    reviewer = add_user(client, ws['owner'], 'reviewer@tenant.test', 'reviewer')
    quote = job['quote']
    assert client.post(f"/quotes/{quote['id']}/approve", headers=reviewer, json={'snapshot_hash': quote['snapshot_hash']}).status_code == 409


def test_anthropic_gateway_uses_native_api_and_keeps_key_out_of_body(monkeypatch):
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'test-only-secret')
    monkeypatch.delenv('QBC_LLM_BASE_URL', raising=False)
    original = httpx.AsyncClient
    def handler(request):
        assert str(request.url) == 'https://api.anthropic.com/v1/messages'
        assert request.headers['x-api-key'] == 'test-only-secret'
        assert 'test-only-secret' not in request.content.decode()
        return httpx.Response(200, json={'stop_reason': 'end_turn', 'content': [{'type': 'text', 'text': '{"items":[]}'}], 'usage': {}})
    monkeypatch.setattr(llm.httpx, 'AsyncClient', lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))
    gateway = llm.gateway_from_env()
    assert isinstance(gateway, llm.AnthropicGateway)
    assert asyncio.run(gateway.complete('strong', 'pricing_lead', 's', 'u', llm.Budget(.25, 2))) == '{"items":[]}'


def test_credit_reservations_cover_other_approved_quotes(client, monkeypatch):
    ws = workspace(client)
    agents = result()
    agents['available_credit_cents'] = 5000
    async def fake(payload): return agents
    monkeypatch.setattr(supplier_agents, 'bridge', fake)
    reviewer = add_user(client, ws['owner'], 'reviewer@tenant.test', 'reviewer')
    jobs = [client.post('/jobs', headers={**ws['owner'], 'Idempotency-Key': f'credit-supplier-{i}'}, json={'workflow': 'supplier', 'notes': '10 of 2x4x8 SPF studs', 'project_name': 'Materials'}).json() for i in range(2)]
    first, second = [job['quote'] for job in jobs]
    assert client.post(f"/quotes/{first['id']}/approve", headers=reviewer, json={'snapshot_hash': first['snapshot_hash']}).status_code == 200
    assert client.post(f"/quotes/{second['id']}/approve", headers=reviewer, json={'snapshot_hash': second['snapshot_hash']}).status_code == 409


def test_job_claims_exclude_duplicate_work_and_release_after_failure(client):
    from app.db import connect
    async def run():
        async with supplier_agents.job_claim(connect, 'tenant-a', 'same-job'):
            with pytest.raises(Exception) as error:
                async with supplier_agents.job_claim(connect, 'tenant-a', 'same-job'):
                    pytest.fail('duplicate claim acquired')
            assert error.value.status_code == 409
        async with supplier_agents.job_claim(connect, 'tenant-a', 'same-job'):
            pass
    asyncio.run(run())


def test_simultaneous_approval_retries_reserve_credit_once(client, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    ws = workspace(client)
    agents = result()
    waiting = {'count': 0, 'event': None}
    async def fake(payload):
        if payload['operation'] == 'check':
            if waiting['event'] is None:
                waiting['event'] = asyncio.Event()
            waiting['count'] += 1
            if waiting['count'] == 2:
                waiting['event'].set()
            await asyncio.wait_for(waiting['event'].wait(), 10)
        return agents
    monkeypatch.setattr(supplier_agents, 'bridge', fake)
    job = client.post('/jobs', headers={**ws['owner'], 'Idempotency-Key': 'same-approval-key'}, json={'workflow': 'supplier', 'notes': '10 of 2x4x8 SPF studs', 'project_name': 'Materials'}).json()
    reviewer = add_user(client, ws['owner'], 'reviewer@tenant.test', 'reviewer')
    quote = job['quote']
    def approve():
        return client.post(f"/quotes/{quote['id']}/approve", headers=reviewer, json={'snapshot_hash': quote['snapshot_hash']}).status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        calls = [pool.submit(approve) for _ in range(2)]
        statuses = [call.result() for call in calls]
    assert sorted(statuses) == [200, 409]
    from app.db import connect
    with connect() as c:
        assert c.execute('SELECT count(*) FROM supplier_credit_reservations WHERE quote_id=?', (quote['id'],)).fetchone()[0] == 1


def test_upgrade_backfills_credit_from_approval_time_not_old_draft_time(client, monkeypatch):
    from datetime import UTC, datetime
    from app.db import connect
    from app import db
    from app.migrations import migrate
    ws = workspace(client)
    agents = result()
    async def fake(payload): return agents
    monkeypatch.setattr(supplier_agents, 'bridge', fake)
    job = client.post('/jobs', headers={**ws['owner'], 'Idempotency-Key': 'upgrade-reservation-key'}, json={'workflow': 'supplier', 'notes': '10 of 2x4x8 SPF studs', 'project_name': 'Materials'}).json()
    quote = job['quote']
    reviewer = add_user(client, ws['owner'], 'reviewer@tenant.test', 'reviewer')
    assert client.post(f"/quotes/{quote['id']}/approve", headers=reviewer, json={'snapshot_hash': quote['snapshot_hash']}).status_code == 200
    with connect() as c:
        c.execute("UPDATE quotes SET created_at='2000-01-01 00:00:00' WHERE id=?", (quote['id'],))
        c.execute('DELETE FROM supplier_credit_reservations')
        c.execute('DELETE FROM schema_migrations WHERE version=6')
    migrate(db.DB_PATH)
    with connect() as c:
        reservation = c.execute('SELECT * FROM supplier_credit_reservations WHERE quote_id=?', (quote['id'],)).fetchone()
        assert datetime.fromisoformat(reservation['expires_at']) > datetime.now(UTC)
