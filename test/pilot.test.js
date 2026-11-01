import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createDatabase, migrate } from '../src/pilot/database.js';
import { buildServer } from '../src/pilot/server.js';
import { hashPassword } from '../src/pilot/auth.js';
import { loadSupplier } from '../src/supplier-tools.js';
import { runSupplierTask } from '../src/supplier-interface.js';
import { runResearchTask } from '../src/research-interface.js';
import { mockResearchOptions } from '../examples/research-fixture.js';
import { fingerprint } from '../src/pilot/fingerprints.js';

let db, app, data, clock = Date.now();
const origin = 'http://localhost:3000';
const password = 'test-only-strong-password-987';
const actors = {}, sessions = {};
before(async () => {
  db = await createDatabase({ connectionString: process.env.TEST_DATABASE_URL, localPath: ':memory:' }); await migrate(db);
  data = await loadSupplier();
  data.tax_policies = [{ active: true, approved_by: 'test-admin-only', jurisdiction: 'Test jurisdiction', tax_rate_bps: 1000, tax_on_delivery: false, source: 'Synthetic test policy' }];
  const hash = await hashPassword(password);
  await db.query("INSERT INTO suppliers(id,name) VALUES('a','Supplier A'),('b','Supplier B')");
  for (const sid of ['a', 'b']) {
    await db.query("INSERT INTO branches(supplier_id,id,name) VALUES($1,'sample-main','Main'),($1,'other','Other')", [sid]);
    await db.query("INSERT INTO accounts(supplier_id,id,name) VALUES($1,'normal','Normal'),($1,'near-limit','Near limit')", [sid]);
  }
  for (const [name, role, sid, account, branch] of [['admin','admin','a',null,null],['rep','staff','a','normal','sample-main'],['credit','credit_manager','a','normal','sample-main'],['buyer','contractor','a','normal',null],['otherbuyer','contractor','a','near-limit',null],['foreign','admin','b',null,null],['unscoped','staff','a','normal','other']]) {
    actors[name] = { id: randomUUID(), email: `${name}@test.example` };
    await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [actors[name].id, actors[name].email, hash]);
    await db.query('INSERT INTO memberships(user_id,supplier_id,role) VALUES($1,$2,$3)', [actors[name].id, sid, role]);
    if (account) await db.query('INSERT INTO access_grants(id,user_id,supplier_id,branch_id,account_id) VALUES($1,$2,$3,$4,$5)', [randomUUID(), actors[name].id, sid, branch, account]);
  }
  app = await buildServer({ db, dataProvider: async () => data, origin, clock: () => clock, metricsToken: 'operator-test-token-only', modelRespond: async () => { throw new Error('private-provider-key'); } });
  await app.ready();
  for (const [name, actor] of Object.entries(actors)) {
    const session = await app.services.auth.issueSession(actor);
    sessions[name] = { cookie: `buildbridge=${session.token}`, csrf: session.csrf_token };
  }
});
after(async () => { await app?.close(); await db?.close(); });
afterEach(async () => { await db.query('DELETE FROM credit_reservations'); });
async function request(actor, method, url, payload, headers = {}) {
  const session = sessions[actor];
  return app.inject({ method, url, headers: { origin, 'content-type': 'application/json', ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}), ...headers }, ...(payload === undefined ? {} : { payload }) });
}
async function create(actor = 'rep', partial = false) {
  const source = JSON.parse(await readFile(new URL(partial ? '../examples/partial-stock.json' : '../examples/normal.json', import.meta.url), 'utf8'));
  const supplier_result = await runSupplierTask({ schema_version: '1.0', request_id: randomUUID(), task_id: 'supplier', agent: 'supplier_quote_desk', input: source }, { supplierData: data });
  const body = { supplier_id: 'a', draft_input: { save_id: randomUUID(), supplier_result } };
  const response = await request(actor, 'POST', '/api/quotes', body);
  assert.equal(response.statusCode, 201, response.body); return { quote: response.json(), body };
}
const terms = () => ({ tax_rate_bps: 1000, tax_on_delivery: false, tax_confirmed: true, tax_jurisdiction: 'Test jurisdiction', tax_basis: 'Synthetic test policy', tax_exemption_reference: null, fees: [], valid_until: new Date(clock + 7 * 86400000).toISOString() });
async function review(quote, extra = {}) {
  const response = await request('rep', 'POST', `/api/quotes/${quote.id}/revisions`, { expected_revision: quote.revision, reason: 'Reviewed commercial treatment.', terms: terms(), ...extra });
  assert.equal(response.statusCode, 200, response.body); return response.json();
}
const action = (actor, quote, name) => request(actor, 'POST', `/api/quotes/${quote.id}/actions/${name}`, { expected_revision: quote.revision, reason: 'Test user confirmed the displayed revision.' });

test('real sign-in uses HttpOnly SameSite cookies and rejects wrong passwords', async () => {
  const failed = await request(null, 'POST', '/api/auth/login', { email: 'rep@test.example', password: 'wrong' });
  assert.equal(failed.statusCode, 401);
  const success = await request(null, 'POST', '/api/auth/login', { email: 'rep@test.example', password });
  assert.equal(success.statusCode, 200, success.body);
  assert.match(success.headers['set-cookie'], /HttpOnly/); assert.match(success.headers['set-cookie'], /SameSite=Strict/);
  assert.doesNotMatch(success.body, /password_hash/);
});
test('sign-in is rate limited consistently for an email', async () => {
  for (let i=0;i<5;i++) assert.equal((await request(null, 'POST', '/api/auth/login', { email: 'unknown@test.example', password: 'wrong' })).statusCode, 401);
  assert.equal((await request(null, 'POST', '/api/auth/login', { email: 'unknown@test.example', password: 'wrong' })).statusCode, 429);
});
test('authentication, CSRF, origin, and request schemas are enforced', async () => {
  assert.equal((await request(null, 'GET', '/api/suppliers/a/quotes')).statusCode, 401);
  assert.equal((await request('rep', 'POST', '/api/quotes', {}, { 'x-csrf-token': 'wrong' })).statusCode, 403);
  assert.equal((await request('rep', 'POST', '/api/quotes', {}, { origin: 'https://evil.example' })).statusCode, 403);
  assert.equal((await request('rep', 'POST', '/api/quotes', { supplier_id: 'a', extra: 'unexpected' })).statusCode, 400);
});
test('draft creation reprices server-side and identical saves do not create duplicates', async () => {
  const created = await create();
  const again = await request('rep', 'POST', '/api/quotes', created.body);
  assert.equal(again.statusCode, 201); assert.equal(again.json().id, created.quote.id);
  assert.equal(created.quote.draft.quote.total_cents, 35008);
  created.body.draft_input.unresolved_questions = [{ question: 'Changed content', line_ids: [] }];
  assert.equal((await request('rep', 'POST', '/api/quotes', created.body)).statusCode, 409);
});
test('customers cannot see drafts, other accounts, branch mismatches, or another supplier', async () => {
  const { quote } = await create();
  for (const actor of ['buyer', 'otherbuyer', 'unscoped', 'foreign']) {
    assert.equal((await request(actor, 'GET', `/api/quotes/${quote.id}`)).statusCode, 404);
    assert.equal((await request(actor, 'GET', `/api/quotes/${quote.id}/revisions/1`)).statusCode, 404);
  }
  assert.equal((await request('foreign', 'GET', '/api/suppliers/a/quotes')).statusCode, 404);
  assert.equal((await request('unscoped', 'GET', '/api/suppliers/a/quotes')).json().length, 0);
});
test('approval requires reviewed terms and optimistic revision matching', async () => {
  const { quote } = await create();
  assert.equal((await action('rep', quote, 'approve')).statusCode, 409);
  const revised = await review(quote);
  assert.equal(revised.commercial.tax_cents, 2751);
  assert.equal(revised.commercial.total_cents, 37759);
  assert.equal((await action('rep', quote, 'approve')).statusCode, 409);
  assert.equal((await action('rep', revised, 'approve')).statusCode, 200);
});
test('publish, contractor acceptance, and local order request are distinct audited states', async () => {
  const { quote } = await create(); const revised = await review(quote);
  assert.equal((await action('rep', revised, 'publish')).statusCode, 409);
  assert.equal((await action('rep', revised, 'approve')).json().state, 'approved');
  assert.equal((await action('rep', revised, 'publish')).json().state, 'sent');
  const buyer = await request('buyer', 'GET', `/api/quotes/${quote.id}`);
  assert.equal(buyer.statusCode, 200); assert.equal(buyer.json().state, 'sent');
  assert.doesNotMatch(buyer.body, /credit_limit|open_balance|supplier_result|source_input|unresolved_questions|rule_id/);
  assert.equal((await request('otherbuyer', 'GET', `/api/quotes/${quote.id}`)).statusCode, 404);
  assert.equal((await request('buyer', 'GET', `/api/quotes/${quote.id}/history`)).statusCode, 403);
  assert.equal((await request('buyer', 'GET', `/api/quotes/${quote.id}/revisions/1`)).statusCode, 404);
  assert.equal((await action('rep', revised, 'accept')).statusCode, 403);
  assert.equal((await action('buyer', revised, 'accept')).json().state, 'accepted');
  assert.equal((await action('rep', revised, 'order')).json().state, 'order_requested');
  assert.equal((await action('rep', revised, 'order')).statusCode, 200);
  const orders = await db.query('SELECT * FROM order_requests WHERE quote_id=$1', [quote.id]);
  assert.equal(orders.rows.length, 1); assert.equal(orders.rows[0].status, 'pending_external_confirmation');
  const history = (await request('rep', 'GET', `/api/quotes/${quote.id}/history`)).json();
  assert.deepEqual(history.events.filter(item => ['approved','published','accepted','order_requested'].includes(item.action)).map(item => item.action), ['approved','published','accepted','order_requested']);
});
test('editing an approved revision invalidates its approval and preserves history', async () => {
  const { quote } = await create(); const revised = await review(quote);
  await action('rep', revised, 'approve');
  const changed = await review(revised, { reason: 'Changed fees require a fresh approval.', terms: { ...terms(), fees: [{ label: 'Handling', amount_cents: 1000, taxable: true }] } });
  assert.equal(changed.state, 'draft'); assert.equal(changed.revision, revised.revision + 1);
  assert.equal((await action('rep', changed, 'publish')).statusCode, 409);
  const old = await request('rep', 'GET', `/api/quotes/${quote.id}/revisions/${revised.revision}`);
  assert.equal(old.json().commercial.fees_cents, 0);
});
test('unmatched quantities cannot be approved by merely answering questions', async () => {
  const { quote } = await create('admin', true);
  const response = await request('admin', 'POST', `/api/quotes/${quote.id}/revisions`, { expected_revision: 1, reason: 'Answered review questions, not a specification approval.', terms: terms(), resolutions: quote.draft.unresolved_questions.map(item => ({ question_id: item.question_id, resolution: 'Rep inspected and recorded this issue.' })) });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal((await action('admin', response.json(), 'approve')).statusCode, 409);
});
test('changed supplier prices block commitment until repriced and reviewed', async () => {
  const { quote } = await create(); const revised = await review(quote);
  const original = data.catalog[0].list_price_cents;
  data.catalog[0].list_price_cents++;
  try { assert.equal((await action('rep', revised, 'approve')).statusCode, 409); }
  finally { data.catalog[0].list_price_cents = original; }
});
test('credit checks include taxes and only a credit manager can grant an exception', async () => {
  const { quote } = await create(); const revised = await review(quote);
  const account = data.accounts.find(item => item.id === 'normal'), oldBalance = account.open_balance_cents;
  account.open_balance_cents = account.credit_limit_cents - revised.draft.quote.total_cents;
  try {
    assert.equal((await action('rep', revised, 'approve')).statusCode, 409);
    const payload = { expected_revision: revised.revision, reason: 'Credit manager approved the tax-inclusive overage.', limit_cents: 3000 };
    assert.equal((await request('rep', 'POST', `/api/quotes/${quote.id}/credit-exception`, payload)).statusCode, 403);
    assert.equal((await request('credit', 'POST', `/api/quotes/${quote.id}/credit-exception`, payload)).statusCode, 200);
    assert.equal((await action('rep', revised, 'approve')).statusCode, 200);
  } finally { account.open_balance_cents = oldBalance; }
});
test('expired quotes cannot be published or accepted', async () => {
  const { quote } = await create(); const revised = await review(quote);
  await action('rep', revised, 'approve'); await action('rep', revised, 'publish');
  const oldClock = clock; clock += 8 * 86400000;
  try { assert.equal((await request('buyer', 'GET', `/api/quotes/${quote.id}`)).json().state, 'expired'); assert.equal((await action('buyer', revised, 'accept')).statusCode, 409); }
  finally { clock = oldClock; }
});
test('revision and audit records cannot be updated or deleted in the database', async () => {
  const { quote } = await create();
  await assert.rejects(() => db.query('UPDATE quote_revisions SET reason=$1 WHERE quote_id=$2', ['tampered', quote.id]), /Immutable/);
  await assert.rejects(() => db.query('DELETE FROM quote_events WHERE quote_id=$1', [quote.id]), /Immutable/);
});
test('invitation is one-use and does not allow public self-registration', async () => {
  const response = await request('admin', 'POST', '/api/suppliers/a/users', { email: 'invited@test.example', role: 'contractor', grants: [{ account_id: 'normal', branch_id: null }] });
  assert.equal(response.statusCode, 201, response.body);
  const token = response.json().activation_token;
  const activated = await request(null, 'POST', '/api/auth/activate', { token, password });
  assert.equal(activated.statusCode, 200, activated.body);
  assert.equal((await request(null, 'POST', '/api/auth/activate', { token, password })).statusCode, 400);
  assert.equal((await request('rep', 'POST', '/api/suppliers/a/users', { email: 'other@test.example', role: 'admin', grants: [] })).statusCode, 403);
});
test('grant updates revoke access on the next request without trusting cached roles', async () => {
  const { quote } = await create();
  const changed = await request('admin', 'PUT', `/api/suppliers/a/users/${actors.unscoped.id}/grants`, { grants: [{ account_id: 'normal', branch_id: 'sample-main' }] });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal((await request('unscoped', 'GET', `/api/quotes/${quote.id}`)).statusCode, 200);
  await request('admin', 'PUT', `/api/suppliers/a/users/${actors.unscoped.id}/grants`, { grants: [{ account_id: 'normal', branch_id: 'other' }] });
  assert.equal((await request('unscoped', 'GET', `/api/quotes/${quote.id}`)).statusCode, 404);
});
test('logout revokes the session and operator metrics require a separate secret', async () => {
  const session = await app.services.auth.issueSession(actors.rep);
  const headers = { cookie: `buildbridge=${session.token}`, 'x-csrf-token': session.csrf_token };
  assert.equal((await request(null, 'POST', '/api/auth/logout', {}, headers)).statusCode, 200);
  assert.equal((await request(null, 'GET', '/api/auth/me', undefined, headers)).statusCode, 401);
  assert.equal((await app.inject({ url: '/metrics' })).statusCode, 401);
  assert.equal((await app.inject({ url: '/metrics', headers: { authorization: 'Bearer operator-test-token-only' } })).statusCode, 200);
});
test('worker endpoints enforce scope and sanitize provider errors', async () => {
  const task = JSON.parse(await readFile(new URL('../examples/supplier-task.json', import.meta.url), 'utf8'));
  assert.equal((await request('rep', 'POST', '/api/worker-tasks', { supplier_id: 'a', task })).statusCode, 404);
  task.input.account_id = 'normal';
  const result = await request('rep', 'POST', '/api/worker-tasks', { supplier_id: 'a', task });
  assert.equal(result.statusCode, 200, result.body); assert.equal(result.json().status, 'failed');
  assert.doesNotMatch(result.body, /private-provider-key/);
});
test('the portal is served with restrictive security and no-cache headers', async () => {
  const response = await app.inject({ url: '/' });
  assert.equal(response.statusCode, 200); assert.match(response.body, /BuildBridge/);
  assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('concurrent quotes cannot spend the same available account credit', async () => {
  const first = await review((await create()).quote), second = await review((await create()).quote);
  const account = data.accounts.find(item => item.id === 'normal'), balance = account.open_balance_cents;
  account.open_balance_cents = account.credit_limit_cents - first.commercial.total_cents - 1;
  try {
    const results = await Promise.all([action('rep', first, 'approve'), action('rep', second, 'approve')]);
    assert.deepEqual(results.map(result => result.statusCode).sort(), [200,409]);
    assert.equal(Number((await db.query('SELECT count(*) AS count FROM credit_reservations')).rows[0].count), 1);
    const approved = results[0].statusCode === 200 ? first : second;
    assert.equal((await action('rep', approved, 'cancel')).statusCode, 200);
    assert.equal(Number((await db.query('SELECT count(*) AS count FROM credit_reservations')).rows[0].count), 0);
  } finally { account.open_balance_cents = balance; }
});
test('changed delivery fees are included in the commitment freshness check', async () => {
  const revised = await review((await create()).quote);
  const fee = data.delivery_slots[0].fee_cents; data.delivery_slots[0].fee_cents += 500;
  try { assert.equal((await action('rep', revised, 'approve')).statusCode, 409); }
  finally { data.delivery_slots[0].fee_cents = fee; }
});
test('manual tax treatment requires an administrator and a separate audit event', async () => {
  const revised = await review((await create()).quote, { terms: { ...terms(), tax_rate_bps: 500, tax_jurisdiction: 'Manually reviewed area', tax_basis: 'Manual tax schedule evidence' } });
  assert.equal((await action('rep', revised, 'approve')).statusCode, 409);
  const body = { expected_revision: revised.revision, reason: 'Tax administrator inspected the tax schedule and jurisdiction.' };
  assert.equal((await request('rep', 'POST', `/api/quotes/${revised.id}/tax-approval`, body)).statusCode, 403);
  assert.equal((await request('admin', 'POST', `/api/quotes/${revised.id}/tax-approval`, body)).statusCode, 200);
  assert.equal((await action('rep', revised, 'approve')).statusCode, 200);
});
test('contractor options do not enumerate supplier branches', async () => {
  const response = await request('buyer', 'GET', '/api/suppliers/a/options');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), [{ account_id: 'normal', account_name: 'Normal' }]);
  assert.equal((await request('unscoped', 'GET', '/api/suppliers/a/catalog?account_id=normal&branch_id=other')).statusCode, 404);
});
test('forged research is rejected; changed requirements invalidate stored prior evidence', async () => {
  const { quote } = await create('admin', true);
  const handoff = quote.draft.supplier_result.handoffs[0];
  const evidence = await runResearchTask(handoff, mockResearchOptions());
  const edits = { expected_revision: 1, reason: 'Attach specification research evidence.', research_results: [evidence] };
  assert.equal((await request('admin', 'POST', `/api/quotes/${quote.id}/revisions`, edits)).statusCode, 400);
  await db.query('INSERT INTO worker_results(id,supplier_id,branch_id,account_id,actor_id,request_id,task_id,input_hash,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [randomUUID(), 'a', 'sample-main', 'near-limit', actors.admin.id, handoff.request_id, handoff.task_id, fingerprint(handoff.input), JSON.stringify(evidence)]);
  const attached = await request('admin', 'POST', `/api/quotes/${quote.id}/revisions`, edits);
  assert.equal(attached.statusCode, 200, attached.body);
  const changed = await request('admin', 'POST', `/api/quotes/${quote.id}/revisions`, { expected_revision: 2, reason: 'Contractor changed the required lumber grade.', lines: [{ line_id: '1', item: '2x10x12 SPF joists', quantity: 40, unit: 'each', required_specs: { grade: 'Contractor-specific grade' } }] });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(changed.json().draft.evidence.length, 0);
  assert.deepEqual(changed.json().invalidated_evidence, [handoff.task_id]);
});
test('confirmed external posting is required before releasing accepted order exposure', async () => {
  const revised = await review((await create()).quote);
  await action('rep', revised, 'approve'); await action('rep', revised, 'publish'); await action('buyer', revised, 'accept'); await action('rep', revised, 'order');
  const input = { expected_revision: revised.revision, reason: 'Finance verified the external supplier posting.', external_reference: 'TEST-ORDER' };
  assert.equal((await request('credit', 'POST', `/api/quotes/${revised.id}/reconcile-order`, input)).statusCode, 409);
  data.posted_orders = [{ external_reference: 'TEST-ORDER', quote_id: revised.id, revision: revised.revision, account_id: 'normal', total_cents: revised.commercial.total_cents, posted_to_balance: true }];
  try {
    const confirmed = await request('credit', 'POST', `/api/quotes/${revised.id}/reconcile-order`, input);
    assert.equal(confirmed.statusCode, 200, confirmed.body); assert.equal(confirmed.json().state, 'ordered');
    assert.equal(Number((await db.query('SELECT count(*) AS count FROM credit_reservations WHERE quote_id=$1', [revised.id])).rows[0].count), 0);
  } finally { delete data.posted_orders; }
});
test('an accepted quote with a missing reservation cannot request an order', async () => {
  const revised = await review((await create()).quote);
  await action('rep', revised, 'approve'); await action('rep', revised, 'publish'); await action('buyer', revised, 'accept');
  await db.query('DELETE FROM credit_reservations WHERE quote_id=$1', [revised.id]);
  assert.equal((await action('rep', revised, 'order')).statusCode, 409);
});
