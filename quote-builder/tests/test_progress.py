import asyncio
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

import pytest

from app import progress, supplier_agents
from app.crew.fake import FakeGateway
from app.crew import service
from tests.helpers import add_user, happy_responder, workspace


def test_progress_is_visible_while_real_crew_is_running_and_approval_is_separate(client, monkeypatch):
    ws = workspace(client)
    started, release = threading.Event(), threading.Event()

    class Paused(FakeGateway):
        async def complete(self, slot, prompt_name, system, user, budget):
            if prompt_name == 'pricing_lead':
                started.set()
                await asyncio.to_thread(release.wait, 8)
            return await super().complete(slot, prompt_name, system, user, budget)

    monkeypatch.setattr(service, 'get_gateway', lambda: Paused(happy_responder))
    key = 'live-progress-test'
    with ThreadPoolExecutor() as pool:
        future = pool.submit(client.post, '/jobs', headers={**ws['owner'], 'Idempotency-Key': key},
                             json={'notes': 'Copper pipe and valves', 'project_name': 'Progress'})
        try:
            assert started.wait(5)
            live = client.get('/job-progress/create:' + key, headers=ws['owner'])
            assert live.status_code == 200
            data = live.json()
            assert data['status'] == 'running'
            states = {step['id']: step['status'] for step in data['steps']}
            assert states['pricing'] == 'running'
            assert states['draft'] == states['review'] == 'waiting'
            assert not future.done()
        finally:
            release.set()
        response = future.result(timeout=10)
    assert response.status_code == 200
    job = response.json()
    assert job['status'] == 'ready'
    state = client.get('/job-progress/job:' + job['id'], headers=ws['owner']).json()
    assert state['status'] == 'ready'
    assert [s['status'] for s in state['steps']] == ['complete', 'complete', 'complete', 'complete', 'waiting']
    quote = job['quote']
    assert client.post('/quotes/' + quote['id'] + '/approve', headers=ws['owner'], json={'snapshot_hash': quote['snapshot_hash']}).status_code == 403
    reviewer = add_user(client, ws['owner'], 'progress-reviewer@example.test', 'reviewer')
    assert client.post('/quotes/' + quote['id'] + '/approve', headers=reviewer, json={'snapshot_hash': quote['snapshot_hash']}).status_code == 200
    approved = client.get('/job-progress/job:' + job['id'], headers=reviewer).json()
    assert approved['status'] == 'approved' and approved['steps'][-1]['status'] == 'complete'
    other = workspace(client, tenant='other-progress')
    assert client.get('/job-progress/create:' + key, headers=other['owner']).status_code == 404
    viewer = add_user(client, ws['owner'], 'progress-viewer@example.test', 'viewer')
    assert client.get('/job-progress/create:' + key, headers=viewer).status_code == 403
    assert client.get('/job-progress/create:' + key).status_code == 401


def test_failures_are_sanitized_and_do_not_complete_waiting_steps(client, monkeypatch):
    ws = workspace(client)
    def fail(*args): raise RuntimeError('PRIVATE-PROVIDER-SENTINEL')
    monkeypatch.setattr(service, 'get_gateway', lambda: FakeGateway(fail))
    r = client.post('/jobs', headers={**ws['owner'], 'Idempotency-Key': 'failed-progress-run'}, json={'notes': 'pipe', 'project_name': 'Failure'})
    assert r.json()['status'] == 'failed'
    state = client.get('/job-progress/create:failed-progress-run', headers=ws['owner'])
    assert state.json()['status'] == 'failed'
    assert 'PRIVATE-PROVIDER-SENTINEL' not in state.text
    assert {s['id']: s['status'] for s in state.json()['steps']}['draft'] == 'waiting'


def test_retry_stale_writers_and_interrupted_runs(client):
    ws = workspace(client)
    from app.db import connect
    user = client.get('/auth/me', headers=ws['owner']).json()
    first = progress.Run(connect, user, {'id': 'job-one'}, 'create:retry-key', 'supplier')
    first.update('supplier', 'running')
    second = progress.Run(connect, user, {'id': 'job-two'}, 'create:retry-key', 'supplier')
    second.update('materials', 'running')
    first.finish('ready')
    data = client.get('/job-progress/create:retry-key', headers=ws['owner']).json()
    assert data['attempt'] == 2 and data['status'] == 'running'
    assert data['steps'][0]['status'] == 'running'
    with pytest.raises(ValueError): second.update('review', 'complete')
    with connect() as c:
        c.execute('UPDATE job_progress SET started_at=?', ((datetime.now(UTC) - timedelta(minutes=6)).isoformat(),))
    assert client.get('/job-progress/create:retry-key', headers=ws['owner']).json()['status'] == 'interrupted'


def test_real_node_stream_reports_ambiguous_materials_without_model_calls(client, monkeypatch):
    ws = workspace(client)
    monkeypatch.setenv('NODE_ENV', 'development')
    monkeypatch.setenv('QBC_ALLOW_SAMPLE_SUPPLIER', 'true')
    monkeypatch.delenv('QBC_SUPPLIER_BINDINGS_FILE', raising=False)
    r = client.post('/jobs', headers={**ws['owner'], 'Idempotency-Key': 'node-progress-stream'},
                    json={'workflow': 'supplier', 'notes': 'some wood', 'project_name': 'Ambiguous'})
    assert r.status_code == 200 and r.json()['status'] == 'needs_input'
    state = client.get('/job-progress/create:node-progress-stream', headers=ws['owner']).json()
    assert state['steps'][0]['status'] == 'needs_input'
    assert all(s['status'] == 'waiting' for s in state['steps'][1:])


@pytest.mark.parametrize('frame', [[], {'type':'progress','event':{'stage':'review','status':'complete'}}, {'type':'progress','event':{'stage':'supplier','status':'running','prompt':'PRIVATE'}}, {'type':'progress','event':{'stage':[],'status':'running'}}, {'type':'result'}, {'type':'progress','event':{'stage':'supplier','status':'invented'}}])
def test_invalid_worker_progress_cannot_forge_approval_or_leak_details(frame):
    class Input:
        def write(self, data): pass
        async def drain(self): pass
        def close(self): pass
    class Process:
        stdin = Input()
        async def wait(self): return 0
    async def run():
        process = Process()
        process.stdout = asyncio.StreamReader()
        process.stdout.feed_data((json.dumps(frame) + '\n').encode())
        process.stdout.feed_eof()
        with pytest.raises(ValueError): await supplier_agents._stream_worker(process, {'operation':'run'})
    asyncio.run(run())
