"""Authenticated website adapter for the existing Node supplier/research workers."""
import asyncio
import json
import os
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from fastapi import HTTPException

from app.config import ROOT
from app import ratelimit
from app.crew.service import _save
from app.quotes import build_quote, load_profile

_slots = asyncio.Semaphore(2)


@asynccontextmanager
async def worker_slot():
    try:
        await asyncio.wait_for(_slots.acquire(), 5)
    except asyncio.TimeoutError:
        raise HTTPException(503, 'Supplier agents are busy. Please retry shortly.') from None
    try:
        yield
    finally:
        _slots.release()


async def bridge(payload):
    async with worker_slot():
        try:
            process = await asyncio.create_subprocess_exec(
                os.getenv('QBC_NODE_BINARY', 'node'), str(ROOT / 'src/website-agent-bridge.js'),
                cwd=str(ROOT), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL, limit=2_000_000)
        except OSError:
            raise HTTPException(503, 'The supplier agent runtime is unavailable.') from None
        try:
            stdout, _ = await asyncio.wait_for(process.communicate(json.dumps(payload).encode()), 200)
            if len(stdout) > 2_000_000:
                raise ValueError('oversized response')
            reply = json.loads(stdout)
            if process.returncode or not reply.get('ok'):
                raise ValueError('worker failed')
            return reply['result']
        except (ValueError, asyncio.TimeoutError):
            raise HTTPException(503, 'Supplier agents could not finish. Check server configuration or try again.') from None
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()


async def execute(c_factory, user, job, policy):
    if not ratelimit.allow(f"supplier-job:{user['tenant_id']}:{user['id']}", 10, 60):
        raise HTTPException(429, 'Too many supplier requests. Please wait a minute.')
    with c_factory() as c:
        if not load_profile(c, user['tenant_id']):
            raise HTTPException(422, 'Set the contractor profile before creating a job.')
    agents = await bridge({'operation': 'run', 'tenant_id': user['tenant_id'], 'request_id': job['id'], 'text': job['notes']})
    supplier = agents.get('supplier')
    questions = [issue['message'] for issue in (supplier or agents['parser'])['issues']]
    for result in agents['research']:
        if result['status'] != 'completed':
            questions.append('Specification evidence remains unresolved; a rep must review it.')
    if agents.get('research_limit_reached'):
        questions.append('Additional specification questions require rep review.')
    ready = agents['ready']
    if not ready and not questions:
        questions.append('Supplier pricing, stock, or credit requires review before drafting.')
    output = {'workflow': 'supplier', 'status': 'ready' if ready else 'needs_input', 'failed_half': None,
              'items': [], 'missing': [], 'questions': questions, 'flags': [], 'problems': [], 'trace': [],
              'quote': None, 'project_id': None, 'policy': policy, 'agents': agents}
    with c_factory() as c:
        if ready:
            project_id = str(uuid.uuid4())
            c.execute('INSERT INTO projects(id,tenant_id,name) VALUES(?,?,?)', (project_id, user['tenant_id'], job['project_name']))
            draft = supplier['data']
            labels = []
            for line in draft['lines']:
                # One sourced lot preserves the supplier's exact per-line rounded amount.
                # Original quantities/units and allocations remain in snapshot provenance.
                amount = sum(part['line_total_cents'] for part in line['allocations'])
                label = f"{line['quantity']} {line['unit']} {line['item']}"
                labels.append(label)
                scope_id, evidence_id = str(uuid.uuid4()), str(uuid.uuid4())
                c.execute('INSERT INTO scopes(id,tenant_id,project_id,description,quantity,unit,material_unit_cost,labor_hours_per_unit,labor_rate,waste_pct,source_type,source_id) VALUES(?,?,?,?,1,?,0,0,0,0,?,?)',
                          (scope_id, user['tenant_id'], project_id, label, 'set', 'supplier_snapshot', evidence_id))
                c.execute('INSERT INTO supplier_snapshots(id,tenant_id,scope_id,amount_cents,source_json) VALUES(?,?,?,?,?)',
                          (evidence_id, user['tenant_id'], scope_id, amount, json.dumps(line)))
            text = {'scope_text': 'Supply the listed materials. Stock is not reserved. Human approval is required.',
                    'assumptions': ['Supplier material pricing only; installation labor is excluded.'],
                    'exclusions': ['Installation labor', 'Delivery booking'],
                    'lines_text': [label + ': {{line_' + str(index + 1) + '_total}}' for index, label in enumerate(labels)],
                    'total_text': 'Total: {{grand_total}}'}
            output['quote'] = build_quote(c, user, project_id, policy, customer_text=text,
                                          customer={'name': job.get('customer_name'), 'project_name': job['project_name']},
                                          job_id=job['id'], supplier_agents=agents)
            output['project_id'] = project_id
        _save(c, user, job, output)
    return output


async def validate_approval(user, snapshot):
    prior = snapshot.get('supplier_agents')
    if not prior:
        return
    scope = prior['supplier_scope']
    total_cents = int(Decimal(snapshot['costs']['total']) * 100)
    current = await bridge({'operation': 'check', 'tenant_id': user['tenant_id'],
                            'request_id': str(uuid.uuid4()), 'lines': prior['lines'],
                            'commercial_total_cents': total_cents})
    if not current['ready'] or current['fingerprint'] != prior['fingerprint'] or current['supplier_scope'] != scope:
        raise HTTPException(409, 'Supplier prices, stock, specifications, or credit changed. Create and review a fresh draft.')
    return current


def reserve_credit(c, quote_id, snapshot, current):
    if current is None:
        return
    scope = current['supplier_scope']
    reserved = c.execute('SELECT COALESCE(sum(total_cents),0) FROM supplier_credit_reservations WHERE supplier_id=? AND account_id=? AND expires_at>?',
                         (scope['supplier_id'], scope['account_id'], datetime.now(UTC).isoformat())).fetchone()[0]
    total_cents = int(Decimal(snapshot['costs']['total']) * 100)
    if reserved + total_cents > current['available_credit_cents']:
        raise HTTPException(409, 'Available credit is already committed to other approved quotes.')
    expires = datetime.now(UTC) + timedelta(days=snapshot['profile']['valid_until_days'])
    c.execute('INSERT INTO supplier_credit_reservations(quote_id,supplier_id,account_id,total_cents,expires_at) VALUES(?,?,?,?,?)',
              (quote_id, scope['supplier_id'], scope['account_id'], total_cents, expires.isoformat()))


@asynccontextmanager
async def job_claim(c_factory, tenant, key):
    token = str(uuid.uuid4())
    now = datetime.now(UTC)
    with c_factory() as c:
        changed = c.execute('INSERT INTO job_claims(tenant_id,claim_key,token,expires_at) VALUES(?,?,?,?) ON CONFLICT(tenant_id,claim_key) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at WHERE job_claims.expires_at<?',
                            (tenant, key, token, (now + timedelta(minutes=5)).isoformat(), now.isoformat()))
        if changed.rowcount != 1:
            raise HTTPException(409, 'This job is already running. Wait for it to finish before retrying.')
    try:
        yield
    finally:
        with c_factory() as c:
            c.execute('DELETE FROM job_claims WHERE tenant_id=? AND claim_key=? AND token=?', (tenant, key, token))


async def claimed_execute(c_factory, user, job, policy, execute, initial=False):
    key = 'create:' + job['idempotency_key'] if initial else 'answer:' + job['id']
    async with job_claim(c_factory, user['tenant_id'], key):
        with c_factory() as c:
            current = c.execute('SELECT status,updated_at FROM jobs WHERE tenant_id=? AND idempotency_key=?', (user['tenant_id'], job['idempotency_key'])).fetchone()
            if current and (initial or current['status'] == 'ready' or current['updated_at'] != job['updated_at']):
                raise HTTPException(409, 'Job changed or completed. Refresh before retrying.')
        return await execute(c_factory, user, job, policy)
