"""Tenant-scoped, durable milestones. Never persist prompts, tool arguments, or provider errors."""
import json
import uuid
from contextvars import ContextVar
from datetime import UTC, datetime

from fastapi import HTTPException

current = ContextVar('job_progress', default=None)
STATES = {'waiting', 'running', 'complete', 'needs_input', 'failed', 'skipped'}
SUPPLIER = [('materials', 'Read materials list'), ('supplier', 'Check supplier'), ('research', 'Check specifications'), ('draft', 'Prepare draft'), ('review', 'Rep approval')]
CREW = [('materials', 'Read job notes'), ('pricing', 'Price materials'), ('writing', 'Write quote'), ('draft', 'Assemble draft'), ('review', 'Rep approval')]


def now():
    return datetime.now(UTC).isoformat()


class Run:
    def __init__(self, connect, user, job, key, workflow):
        self.connect, self.tenant, self.key = connect, user['tenant_id'], key
        self.token = str(uuid.uuid4())
        self.steps = [{'id': key, 'label': label, 'status': 'waiting'} for key, label in (SUPPLIER if workflow == 'supplier' else CREW)]
        at = now()
        with connect() as c:
            attempt = c.execute('SELECT COALESCE(MAX(attempt),0)+1 FROM job_progress WHERE tenant_id=? AND (job_id=? OR progress_key=?)', (self.tenant, job['id'], key)).fetchone()[0]
            c.execute('''INSERT INTO job_progress VALUES(?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(tenant_id,progress_key) DO UPDATE SET job_id=excluded.job_id,
                created_by=excluded.created_by,run_token=excluded.run_token,workflow=excluded.workflow,
                attempt=excluded.attempt,status=excluded.status,steps_json=excluded.steps_json,
                started_at=excluded.started_at,updated_at=excluded.updated_at''',
                (self.tenant, key, job['id'], user['id'], self.token, workflow, attempt, 'running', json.dumps(self.steps), at, at))

    def update(self, stage, status):
        if status not in STATES or stage == 'review' or stage not in {step['id'] for step in self.steps}:
            raise ValueError('Invalid progress milestone')
        for step in self.steps:
            if step['id'] == stage:
                step.update(status=status, updated_at=now())
        self.save()

    def save(self, status='running'):
        with self.connect() as c:
            c.execute('UPDATE job_progress SET status=?,steps_json=?,updated_at=? WHERE tenant_id=? AND progress_key=? AND run_token=?',
                      (status, json.dumps(self.steps), now(), self.tenant, self.key, self.token))

    def finish(self, status):
        for step in self.steps:
            if step['status'] == 'running':
                step['status'] = 'failed' if status == 'failed' else 'needs_input' if status == 'needs_input' else 'complete'
        self.save(status)


def report(stage, status):
    run = current.get()
    if run:
        run.update(stage, status)


def crew_event(team, kind, detail):
    if team == 'pricing':
        if kind == 'start': report('pricing', 'running')
        if kind == 'plan': report('materials', 'complete')
        if kind == 'done': report('pricing', 'needs_input' if detail.get('missing') or not detail.get('priced') else 'complete')
        if kind == 'failed': report('pricing', 'failed')
    if team == 'quote':
        if kind == 'start': report('writing', 'running')
        if kind == 'writer_done': report('writing', 'complete')
        if kind == 'failed': report('writing', 'failed')


def view(connect, user, key):
    if user['role'] == 'viewer':
        raise HTTPException(403, 'Insufficient permission')
    with connect() as c:
        if key.startswith('job:'):
            row = c.execute('SELECT * FROM job_progress WHERE tenant_id=? AND job_id=? ORDER BY attempt DESC LIMIT 1', (user['tenant_id'], key[4:])).fetchone()
        else:
            row = c.execute('SELECT * FROM job_progress WHERE tenant_id=? AND progress_key=?', (user['tenant_id'], key)).fetchone()
        if not row:
            raise HTTPException(404, 'Progress is not available yet')
        result = {'job_id': row['job_id'], 'workflow': row['workflow'], 'attempt': row['attempt'],
                  'status': row['status'], 'steps': json.loads(row['steps_json']), 'updated_at': row['updated_at']}
        if result['status'] == 'running' and (datetime.now(UTC) - datetime.fromisoformat(row['started_at'])).total_seconds() > 240:
            result['status'] = 'interrupted'
        quote = c.execute('SELECT q.status FROM quotes q JOIN jobs j ON j.quote_id=q.id AND j.tenant_id=q.tenant_id WHERE j.tenant_id=? AND j.id=?', (user['tenant_id'], row['job_id'])).fetchone()
        if result['status'] == 'ready' and quote:
            review = next(step for step in result['steps'] if step['id'] == 'review')
            if quote['status'] == 'approved':
                review['status'] = 'complete'
                result['status'] = 'approved'
            elif quote['status'] == 'rejected':
                review['status'] = 'needs_input'
                result['status'] = 'rejected'
    return result
