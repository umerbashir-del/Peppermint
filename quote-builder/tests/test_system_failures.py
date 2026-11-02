import asyncio
import json

import pytest

from app import supplier_agents
from app.crew.fake import FakeGateway
from app.crew.llm import LLMError
from app.crew.pipeline import run_crew
from tests.helpers import happy_responder, use_fake, workspace


@pytest.mark.parametrize('stage,half', [('pricing_lead', 'pricing'), ('estimator', 'pricing'), ('quote_lead', 'quote'), ('writer', 'quote')])
def test_each_crew_stage_failure_has_no_quote_or_partial_project(client, monkeypatch, stage, half):
    ws = workspace(client)
    def responder(prompt, user):
        if prompt == stage:
            raise LLMError('private-error-sentinel')
        return happy_responder(prompt, user)
    use_fake(monkeypatch, responder)
    response = client.post('/jobs', headers={**ws['owner'], 'Idempotency-Key': 'stage-failure-key'}, json={'notes': 'Replace 40 ft of 3/4in copper pipe, 2 shutoff valves', 'project_name': 'Fault injection'})
    assert response.status_code == 200
    job = response.json()
    assert job['status'] == 'failed' and job['failed_half'] == half
    assert job['quote'] is None and job['project_id'] is None
    assert 'private-error-sentinel' not in response.text
    assert client.get('/quotes', headers=ws['owner']).json() == []
    assert len(client.get('/projects', headers=ws['owner']).json()) == 1


@pytest.mark.parametrize('stdout', [b'not json', b'[]', b'{}', b'{"ok":true}', b'{"ok":true,"result":null}', b'{"ok":true,"result":{}}', b'{"ok":true,"result":{"ready":"yes","research":[]}}'])
def test_malformed_bridge_responses_are_safe_503s(monkeypatch, stdout):
    class Process:
        returncode = 0
        async def communicate(self, data): return stdout, b''
    async def spawn(*args, **kwargs): return Process()
    monkeypatch.setattr(supplier_agents.asyncio, 'create_subprocess_exec', spawn)
    async def run():
        with pytest.raises(Exception) as error:
            await supplier_agents.bridge({'operation': 'run'})
        assert error.value.status_code == 503
    asyncio.run(run())


def test_timed_out_worker_is_killed_and_slot_is_released(monkeypatch):
    class Process:
        returncode = None
        killed = False
        async def communicate(self, data): raise asyncio.TimeoutError()
        def kill(self): self.killed = True; self.returncode = -9
        async def wait(self): return self.returncode
    process = Process()
    async def spawn(*args, **kwargs): return process
    monkeypatch.setattr(supplier_agents.asyncio, 'create_subprocess_exec', spawn)
    async def run():
        before = supplier_agents._slots._value
        with pytest.raises(Exception) as error:
            await supplier_agents.bridge({'operation': 'run'})
        assert error.value.status_code == 503
        assert process.killed
        assert supplier_agents._slots._value == before
    asyncio.run(run())


def test_worker_crash_releases_job_claim_for_same_key_retry(client, monkeypatch):
    ws = workspace(client)
    from fastapi import HTTPException
    async def unavailable(payload): raise HTTPException(503, 'Worker unavailable')
    monkeypatch.setattr(supplier_agents, 'bridge', unavailable)
    headers = {**ws['owner'], 'Idempotency-Key': 'recoverable-worker-key'}
    body = {'workflow': 'supplier', 'notes': '10 of 2x4x8 SPF studs', 'project_name': 'Recovery'}
    assert client.post('/jobs', headers=headers, json=body).status_code == 503
    assert client.post('/jobs', headers=headers, json=body).status_code == 503
    assert client.get('/quotes', headers=ws['owner']).json() == []
    from app.db import connect
    with connect() as c:
        assert c.execute('SELECT count(*) FROM job_claims').fetchone()[0] == 0


def test_both_crews_fail_without_echoing_private_error():
    def fail(*args): raise LLMError('private-error-sentinel')
    result = asyncio.run(run_crew('notes', [], FakeGateway(fail)))
    assert result.status == 'failed' and result.failed_half == 'both'
    assert 'private-error-sentinel' not in json.dumps(result.__dict__)


def test_failed_supplier_is_saved_as_failure_and_retry_can_recover(client, monkeypatch):
    from tests.test_supplier_agents import result
    ws = workspace(client)
    agents = result()
    failed = json.loads(json.dumps(agents))
    failed['ready'] = False
    failed['supplier']['status'] = 'failed'
    failed['supplier']['data'] = None
    failed['supplier']['issues'] = [{'message': 'Provider temporarily unavailable', 'retryable': True}]
    async def first(payload): return failed
    monkeypatch.setattr(supplier_agents, 'bridge', first)
    headers = {**ws['owner'], 'Idempotency-Key': 'failed-supplier-job'}
    body = {'workflow': 'supplier', 'notes': '10 of 2x4x8 SPF studs', 'project_name': 'Recovery'}
    response = client.post('/jobs', headers=headers, json=body)
    job = response.json()
    assert job['status'] == 'failed' and job['failed_half'] == 'supplier'
    assert job['quote'] is None
    async def recovered(payload): return agents
    monkeypatch.setattr(supplier_agents, 'bridge', recovered)
    retry = client.post(f"/jobs/{job['id']}/answers", headers=ws['owner'], json={'answers': body['notes']})
    assert retry.json()['status'] == 'ready'
    assert len(client.get('/quotes', headers=ws['owner']).json()) == 1
