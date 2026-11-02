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
from app import progress
from app.crew.service import _save
from app.quotes import build_quote, load_profile

_slots = asyncio.Semaphore(2)


def validate_worker_result(result, payload):
    if not isinstance(result, dict):
        raise ValueError('invalid worker result')
    if payload.get('operation') == 'context':
        return
    if not isinstance(result.get('ready'), bool) or not isinstance(result.get('research'), list):
        raise ValueError('invalid worker status')
    def envelope(value, agent, task_id):
        if (not isinstance(value, dict) or value.get('schema_version') != '1.0'
            or value.get('request_id') != payload.get('request_id') or value.get('task_id') != task_id
            or value.get('agent') != agent or value.get('status') not in ('completed', 'needs_human_review', 'failed')
            or not isinstance(value.get('issues'), list) or not isinstance(value.get('handoffs'), list)):
            raise ValueError('invalid worker envelope')
        if any(not isinstance(issue, dict) or not isinstance(issue.get('message'), str) for issue in value['issues']):
            raise ValueError('invalid worker issues')
    supplier = result.get('supplier')
    if payload.get('operation') == 'run':
        envelope(result.get('parser'), 'materials_parser', 'website-parser')
    if supplier is not None:
        envelope(supplier, 'supplier_quote_desk', 'website-supplier')
    if result['ready']:
        if (not supplier or supplier['status'] != 'completed' or not isinstance(supplier.get('data'), dict)
            or not isinstance(result.get('lines'), list) or not result['lines']
            or not isinstance(result.get('fingerprint'), str) or not isinstance(result.get('supplier_scope'), dict)
            or not isinstance(result.get('available_credit_cents'), int)):
            raise ValueError('incomplete ready result')
    if supplier is None and (result['ready'] or result['research']):
        raise ValueError('missing supplier handoff')


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
        except (OSError, NotImplementedError):
            raise HTTPException(503, 'The supplier agent runtime is unavailable.') from None
        try:
            if progress.current.get() and payload.get('operation') == 'run':
                reply = await asyncio.wait_for(_stream_worker(process, payload), 200)
            else:
                stdout, _ = await asyncio.wait_for(process.communicate(json.dumps(payload).encode()), 200)
                if len(stdout) > 2_000_000:
                    raise ValueError('oversized response')
                reply = json.loads(stdout)
            if process.returncode or not isinstance(reply, dict) or reply.get('ok') is not True or not isinstance(reply.get('result'), dict):
                raise ValueError('worker failed')
            validate_worker_result(reply['result'], payload)
            return reply['result']
        except (ValueError, asyncio.TimeoutError, OSError):
            raise HTTPException(503, 'Supplier agents could not finish. Check server configuration or try again.') from None
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()


async def _stream_worker(process, payload):
    process.stdin.write(json.dumps({**payload, 'progress_events': True}).encode())
    await process.stdin.drain()
    process.stdin.close()
    total, frames, reply = 0, 0, None
    async for line in process.stdout:
        total += len(line)
        frames += 1
        if total > 2_000_000 or frames > 128:
            raise ValueError('Worker output limit reached')
        frame = json.loads(line)
        if not isinstance(frame, dict):
            raise ValueError('Invalid worker frame')
        if frame.get('type') == 'progress' and reply is None:
            event = frame.get('event')
            if not isinstance(event, dict) or set(event) != {'stage', 'status'} or not all(isinstance(value, str) for value in event.values()):
                raise ValueError('Invalid progress event')
            if event['stage'] not in {'materials', 'supplier', 'research'} or event['status'] not in progress.STATES:
                raise ValueError('Worker cannot report draft creation or human approval')
            progress.report(event['stage'], event['status'])
        elif frame.get('type') == 'result' and reply is None:
            if not isinstance(frame.get('reply'), dict):
                raise ValueError('Invalid worker result frame')
            reply = frame['reply']
        else:
            raise ValueError('Invalid worker frame')
    await process.wait()
    return reply


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
    if progress.current.get():
        for stage, result in [('materials', agents['parser']), ('supplier', supplier)]:
            if result:
                progress.report(stage, 'complete' if result['status'] == 'completed' else 'failed' if result['status'] == 'failed' else 'needs_input')
    if not ready and not questions:
        questions.append('Supplier pricing, stock, or credit requires review before drafting.')
    failed_agent = 'supplier' if supplier and supplier['status'] == 'failed' else 'parser' if agents['parser']['status'] == 'failed' else None
    output = {'workflow': 'supplier', 'status': 'failed' if failed_agent else 'ready' if ready else 'needs_input', 'failed_half': failed_agent,
              'items': [], 'missing': [], 'questions': questions, 'flags': [], 'problems': [], 'trace': [],
              'quote': None, 'project_id': None, 'policy': policy, 'agents': agents}
    if ready:
        progress.report('draft', 'running')
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
    if ready:
        progress.report('draft', 'complete')
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
        workflow = 'supplier' if execute is globals()['execute'] else 'crew'
        run = progress.Run(c_factory, user, job, key, workflow)
        context = progress.current.set(run)
        try:
            output = await execute(c_factory, user, job, policy)
            run.finish(output['status'])
            return output
        except BaseException:
            run.finish('failed')
            raise
        finally:
            progress.current.reset(context)
