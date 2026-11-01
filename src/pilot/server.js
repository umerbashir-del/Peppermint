import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import { z, ZodError } from 'zod';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { AuthService, consumeQuota, digest, inviteUser } from './auth.js';
import { authorize, membership, event } from './access.js';
import { AppError, insist, invalid, conflict } from './errors.js';
import { QuoteService } from './quotes.js';
import { supplierProvider } from './provider.js';
import { createQuoteSchema, revisionSchema, actionSchema, creditSchema, inviteSchema, grantSchema, deliverySchema } from './schemas.js';
import { validateTask } from '../agent-contract.js';
import { runParserTask } from '../parser-interface.js';
import { runSupplierTask } from '../supplier-interface.js';
import { runResearchTask } from '../research-interface.js';
import { responses } from '../anthropic.js';
import { extractPdf } from './pdf.js';
import { fingerprint } from './fingerprints.js';

const strId = z.string().trim().min(1).max(128);
const supplierQuery = z.strictObject({ account_id: strId, branch_id: strId });

export async function buildServer({ db, dataProvider = supplierProvider(), origin = process.env.APP_ORIGIN || 'http://localhost:3000', production = process.env.NODE_ENV === 'production', logger = false, modelRespond = responses, alert = async () => {}, clock, dailyCalls = 200, dailyTokenBudget = 500000, taskTimeoutMs = 180000, metricsToken = process.env.METRICS_TOKEN } = {}) {
  const url = new URL(origin);
  if (production && (url.protocol !== 'https:' || !metricsToken || metricsToken.length < 32)) throw new Error('Production requires an HTTPS APP_ORIGIN and a METRICS_TOKEN of at least 32 characters.');
  const app = Fastify({ logger, bodyLimit: 2_000_000, requestTimeout: 190000, connectionTimeout: 15000, ajv: { customOptions: { removeAdditional: false } }, trustProxy: process.env.TRUST_PROXY || false });
  await app.register(cookie);
  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], connectSrc: ["'self'"], imgSrc: ["'self'"], formAction: ["'self'"], baseUri: ["'none'"], frameAncestors: ["'none'"] } } });
  const auth = new AuthService(db, { secure: production || url.protocol === 'https:' });
  const quotes = new QuoteService(db, { supplierData: dataProvider, ...(clock ? { clock } : {}) });
  let failures = 0;
  app.decorateRequest('actor', null);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      insist(request.headers.origin === origin, 403, 'ORIGIN_FAILED', 'Request origin is not allowed.');
      insist(String(request.headers['content-type'] ?? '').split(';')[0] === 'application/json', 415, 'CONTENT_TYPE', 'Use application/json.');
    }
    const path = request.url.split('?')[0];
    if (path.startsWith('/api/') && !['/api/auth/login', '/api/auth/activate'].includes(path)) {
      request.actor = await auth.authenticate(request.cookies[auth.cookieName]);
      await consumeQuota(db, `api:${request.actor.id}`, 120, 60);
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) auth.checkCsrf(request.actor, request.headers['x-csrf-token']);
    }
  });
  app.setErrorHandler(async (error, request, reply) => {
    const status = error instanceof AppError ? error.status : error instanceof ZodError || error.name === 'ContractError' || error.name === 'DraftStoreError' ? 400 : error.code === '23505' ? 409 : error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    const code = error instanceof AppError ? error.code : status === 400 ? 'INVALID_INPUT' : status === 409 ? 'CONFLICT' : status < 500 ? 'REQUEST_REJECTED' : 'INTERNAL_ERROR';
    if (status >= 500) {
      failures++;
      request.log.error({ code, request_id: request.id, error_type: error.name }, 'Request failed');
      void alert({ code, request_id: request.id, error_type: error.name }).catch(() => {});
    }
    reply.code(status).send({ error: { code, message: error instanceof AppError ? error.message : status === 400 ? 'Input is invalid; check required fields and supported values.' : status === 409 ? 'Conflicting update; refresh and retry with a new revision/save ID.' : 'Request could not be completed.', request_id: request.id } });
  });
  const sessionReply = (reply, session) => { reply.setCookie(auth.cookieName, session.token, auth.cookieOptions()); return { user: session.user, csrf_token: session.csrf_token }; };
  app.post('/api/auth/login', async (request, reply) => {
    const body = z.strictObject({ email: z.email().max(254), password: z.string().max(128) }).parse(request.body);
    return sessionReply(reply, await auth.login(body.email, body.password, request.ip));
  });
  app.post('/api/auth/activate', async (request, reply) => {
    await consumeQuota(db, `activate-ip:${digest(request.ip)}`, 5, 900);
    const body = z.strictObject({ token: z.string().max(128), password: z.string().min(15).max(128) }).parse(request.body);
    return sessionReply(reply, await auth.activate(body.token, body.password));
  });
  app.get('/api/auth/me', async request => {
    const memberships = await db.query('SELECT supplier_id,role FROM memberships WHERE user_id=$1 ORDER BY supplier_id', [request.actor.id]);
    const grants = await db.query('SELECT supplier_id,branch_id,account_id FROM access_grants WHERE user_id=$1', [request.actor.id]);
    return { user: { id: request.actor.id, email: request.actor.email }, csrf_token: request.actor.csrf_token, memberships: memberships.rows, grants: grants.rows };
  });
  app.post('/api/auth/logout', async (request, reply) => { await auth.logout(request.cookies[auth.cookieName]); reply.clearCookie(auth.cookieName, { path: '/' }); return { logged_out: true }; });
  app.post('/api/auth/password', async (request, reply) => {
    const body = z.strictObject({ current_password: z.string().max(128), password: z.string().min(15).max(128) }).parse(request.body);
    await auth.changePassword(request.actor, body.current_password, body.password);
    reply.clearCookie(auth.cookieName, { path: '/' }); return { logged_out: true };
  });
  app.get('/api/suppliers/:supplierId/options', async request => {
    const sid = request.params.supplierId;
    const role = await membership(db, request.actor, sid);
    if (role === 'contractor') {
      const { rows } = await db.query('SELECT DISTINCT a.id AS account_id,a.name AS account_name FROM accounts a JOIN access_grants g ON g.supplier_id=a.supplier_id AND g.account_id=a.id WHERE a.supplier_id=$1 AND g.user_id=$2 ORDER BY a.id', [sid, request.actor.id]);
      return rows;
    }
    const { rows } = await db.query(`SELECT a.id AS account_id,a.name AS account_name,b.id AS branch_id,b.name AS branch_name FROM accounts a JOIN branches b ON b.supplier_id=a.supplier_id WHERE a.supplier_id=$1 AND ($2='admin' OR EXISTS(SELECT 1 FROM access_grants g WHERE g.user_id=$3 AND g.supplier_id=$1 AND g.account_id=a.id AND (g.branch_id=b.id OR ($2='contractor' AND g.branch_id IS NULL)))) ORDER BY a.id,b.id`, [sid, role, request.actor.id]);
    return rows;
  });
  app.get('/api/suppliers/:supplierId/catalog', async request => {
    const input = supplierQuery.parse(request.query);
    await authorize(db, request.actor, { supplier_id: request.params.supplierId, ...input }, { write: true });
    const data = await dataProvider(request.params.supplierId);
    insist(data.branch === input.branch_id, 404, 'NOT_FOUND', 'No data is available for this authorized branch.');
    return { as_of: data.as_of, sample_data: Boolean(data.sample_data), items: data.catalog, tax_policies: data.tax_policies ?? [], delivery_slots: data.delivery_slots.filter(slot => slot.branch === input.branch_id) };
  });
  app.post('/api/suppliers/:supplierId/users', async (request, reply) => {
    const result = await inviteUser(db, request.actor, request.params.supplierId, inviteSchema.parse(request.body));
    reply.code(201); return { ...result, activation_url: result.activation_token ? `${origin}/#activate=${encodeURIComponent(result.activation_token)}` : null };
  });
  app.get('/api/suppliers/:supplierId/users', async request => {
    await authorize(db, request.actor, { supplier_id: request.params.supplierId }, { admin: true });
    const users = await db.query('SELECT u.id,u.email,u.active,m.role FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.supplier_id=$1 ORDER BY u.email', [request.params.supplierId]);
    return users.rows;
  });
  app.put('/api/suppliers/:supplierId/users/:userId/grants', async request => {
    const sid = request.params.supplierId, uid = request.params.userId;
    await authorize(db, request.actor, { supplier_id: sid }, { admin: true });
    const body = z.strictObject({ grants: z.array(grantSchema).min(1).max(100) }).parse(request.body);
    return db.transaction(async tx => {
      await tx.query('SELECT id FROM suppliers WHERE id=$1 FOR UPDATE', [sid]);
      await authorize(tx, request.actor, { supplier_id: sid }, { admin: true });
      const members = await tx.query('SELECT role FROM memberships WHERE supplier_id=$1 AND user_id=$2 FOR UPDATE', [sid, uid]);
      insist(members.rows.length, 404, 'NOT_FOUND', 'User not found.');
      invalid(members.rows[0].role !== 'admin', 'Administrator scope cannot be changed using customer grants.');
      for (const grant of body.grants) {
        invalid(members.rows[0].role === 'contractor' ? grant.branch_id === null : grant.branch_id !== null, 'Grant scope does not match this role.');
        const exists = await tx.query('SELECT 1 FROM accounts WHERE supplier_id=$1 AND id=$2', [sid, grant.account_id]); invalid(exists.rows.length, 'Unknown account.');
        if (grant.branch_id !== null) { const branch = await tx.query('SELECT 1 FROM branches WHERE supplier_id=$1 AND id=$2', [sid, grant.branch_id]); invalid(branch.rows.length, 'Unknown branch.'); }
      }
      await tx.query('DELETE FROM access_grants WHERE supplier_id=$1 AND user_id=$2', [sid, uid]);
      for (const grant of body.grants) await tx.query('INSERT INTO access_grants(id,user_id,supplier_id,branch_id,account_id) VALUES($1,$2,$3,$4,$5)', [randomUUID(), uid, sid, grant.branch_id, grant.account_id]);
      await event(tx, request.actor, sid, null, null, 'grants_changed', { user_id: uid, grants: body.grants });
      return { updated: true };
    });
  });
  app.delete('/api/suppliers/:supplierId/users/:userId', async request => {
    const sid = request.params.supplierId, uid = request.params.userId;
    await authorize(db, request.actor, { supplier_id: sid }, { admin: true });
    invalid(uid !== request.actor.id, 'Administrators cannot revoke their own membership here.');
    return db.transaction(async tx => {
      await tx.query('SELECT id FROM suppliers WHERE id=$1 FOR UPDATE', [sid]);
      await authorize(tx, request.actor, { supplier_id: sid }, { admin: true });
      const result = await tx.query('DELETE FROM memberships WHERE supplier_id=$1 AND user_id=$2 RETURNING user_id', [sid, uid]);
      insist(result.rows.length, 404, 'NOT_FOUND', 'User not found.');
      await tx.query('DELETE FROM sessions WHERE user_id=$1', [uid]);
      await event(tx, request.actor, sid, null, null, 'membership_revoked', { user_id: uid }); return { revoked: true };
    });
  });
  app.get('/api/suppliers/:supplierId/quotes', request => quotes.list(request.actor, request.params.supplierId));
  app.post('/api/quotes', async (request, reply) => { const body = createQuoteSchema.parse(request.body); const result = await quotes.create(request.actor, body.supplier_id, body.draft_input); reply.code(201); return result; });
  app.post('/api/lists/pdf', { bodyLimit: 7000000 }, async request => {
    const input = z.strictObject({ supplier_id: strId, pdf_base64: z.string().max(6700000) }).parse(request.body);
    await membership(db, request.actor, input.supplier_id);
    await consumeQuota(db, `pdf:${request.actor.id}`, 10, 3600);
    return extractPdf(input.pdf_base64);
  });
  app.post('/api/quotes/from-materials', async (request, reply) => {
    const input = z.strictObject({ supplier_id: strId, account_id: strId, branch_id: strId, delivery: deliverySchema, text: z.string().min(1).max(100000), format: z.enum(['text', 'csv', 'pdf_text']), save_id: strId }).parse(request.body);
    await authorize(db, request.actor, input, { write: true });
    const base = { schema_version: '1.0', request_id: `manual-${digest(JSON.stringify([input.supplier_id, input.account_id, input.branch_id, input.save_id])).slice(0, 32)}` };
    const parsed = await runParserTask({ ...base, task_id: 'parse', agent: 'materials_parser', input: { text: input.text, format: input.format } });
    if (parsed.status !== 'completed') { reply.code(422); return { error: { code: 'LIST_REQUIRES_REVIEW', message: 'Clarify the materials list before quoting.' }, result: parsed }; }
    const supplier_result = await runSupplierTask({ ...base, task_id: 'supplier', agent: 'supplier_quote_desk', input: { account_id: input.account_id, branch: input.branch_id, delivery: input.delivery, lines: parsed.data.supplier_lines } }, { supplierData: await dataProvider(input.supplier_id) });
    const result = await quotes.create(request.actor, input.supplier_id, { save_id: input.save_id, supplier_result }, { logicalHash: digest(JSON.stringify(input)) }); reply.code(201); return result;
  });
  app.get('/api/quotes/:quoteId', request => quotes.load(request.actor, request.params.quoteId));
  app.get('/api/quotes/:quoteId/revisions/:revision', request => quotes.load(request.actor, request.params.quoteId, db, z.coerce.number().int().min(1).parse(request.params.revision)));
  app.get('/api/quotes/:quoteId/history', request => quotes.history(request.actor, request.params.quoteId));
  app.post('/api/quotes/:quoteId/revisions', request => quotes.revise(request.actor, request.params.quoteId, revisionSchema.parse(request.body)));
  app.post('/api/quotes/:quoteId/actions/:action', request => quotes.transition(request.actor, request.params.quoteId, request.params.action, actionSchema.parse(request.body)));
  app.post('/api/quotes/:quoteId/credit-exception', request => quotes.creditException(request.actor, request.params.quoteId, creditSchema.parse(request.body)));
  app.post('/api/quotes/:quoteId/tax-approval', request => quotes.approveTax(request.actor, request.params.quoteId, actionSchema.parse(request.body)));
  app.post('/api/quotes/:quoteId/reconcile-order', request => quotes.reconcileOrder(request.actor, request.params.quoteId, actionSchema.extend({ external_reference: strId }).parse(request.body)));
  app.post('/api/worker-tasks', async request => {
    const body = z.strictObject({ supplier_id: strId, task: z.unknown(), scope: supplierQuery.optional() }).parse(request.body);
    validateTask(body.task, body.task?.agent);
    const role = await membership(db, request.actor, body.supplier_id);
    if (body.task.agent !== 'materials_parser') insist(role !== 'contractor', 403, 'FORBIDDEN', 'Supplier staff permission is required.');
    if (body.task.agent === 'supplier_quote_desk') await authorize(db, request.actor, { supplier_id: body.supplier_id, branch_id: body.task.input.branch, account_id: body.task.input.account_id }, { write: true });
    let scope = body.scope;
    if (body.task.agent === 'research') {
      const linked = await db.query('SELECT * FROM quotes WHERE supplier_id=$1 AND request_id=$2 LIMIT 1', [body.supplier_id, body.task.request_id]);
      if (linked.rows.length) { await authorize(db, request.actor, linked.rows[0], { write: true }); scope = { branch_id: linked.rows[0].branch_id, account_id: linked.rows[0].account_id }; }
      invalid(scope, 'Research needs an authorized quote request ID or an explicit account/branch scope.');
      await authorize(db, request.actor, { supplier_id: body.supplier_id, ...scope }, { write: true });
      const validScope = await db.query('SELECT 1 FROM accounts a JOIN branches b ON b.supplier_id=a.supplier_id WHERE a.supplier_id=$1 AND a.id=$2 AND b.id=$3', [body.supplier_id, scope.account_id, scope.branch_id]);
      insist(validScope.rows.length, 404, 'NOT_FOUND', 'Scope not found.');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('Task deadline reached', 'TimeoutError')), taskTimeoutMs); timer.unref();
    let calls = 0;
    const respond = async modelInput => {
      controller.signal.throwIfAborted();
      insist(++calls <= 20, 429, 'MODEL_LIMIT', 'Task model-call budget reached.');
      await consumeQuota(db, `model-calls:${request.actor.id}`, dailyCalls, 86400);
      await consumeQuota(db, `model-calls-supplier:${body.supplier_id}`, dailyCalls * 10, 86400);
      const reserve = Buffer.byteLength(JSON.stringify(modelInput), 'utf8') + Math.max(2048, modelInput.max_output_tokens ?? 4096) + 1024;
      // Token reservations are conservative and shared across processes, unlike local counters.
      const tokenUnits = Math.ceil(reserve / 1000);
      await consumeQuota(db, `model-token-units:${request.actor.id}`, Math.floor(dailyTokenBudget / 1000), 86400, tokenUnits);
      await consumeQuota(db, `model-token-units-supplier:${body.supplier_id}`, Math.floor(dailyTokenBudget / 1000) * 10, 86400, tokenUnits);
      const start = Date.now();
      const result = await modelRespond(modelInput, { signal: controller.signal });
      await db.query('INSERT INTO model_usage(id,user_id,supplier_id,task_id,input_tokens,output_tokens,search_requests,elapsed_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [randomUUID(), request.actor.id, body.supplier_id, body.task.task_id, result.usage?.input_tokens ?? 0, result.usage?.output_tokens ?? 0, result.usage?.search_requests ?? 0, Date.now() - start]);
      return result;
    };
    try {
      if (body.task.agent === 'materials_parser') return await runParserTask(body.task);
      if (body.task.agent === 'supplier_quote_desk') return await runSupplierTask(body.task, { supplierData: await dataProvider(body.supplier_id), live: true, respond });
      const result = await runResearchTask(body.task, { respond });
      await db.query('INSERT INTO worker_results(id,supplier_id,branch_id,account_id,actor_id,request_id,task_id,input_hash,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [randomUUID(), body.supplier_id, scope.branch_id, scope.account_id, request.actor.id, body.task.request_id, body.task.task_id, fingerprint(body.task.input), JSON.stringify(result)]);
      return result;
    } finally { clearTimeout(timer); }
  });
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (request, reply) => { try { await db.query('SELECT 1'); return { status: 'ready', storage: db.kind }; } catch { reply.code(503); return { status: 'unavailable' }; } });
  app.get('/metrics', async request => {
    insist(typeof metricsToken === 'string' && request.headers.authorization === `Bearer ${metricsToken}`, 401, 'UNAUTHENTICATED', 'Operator authentication is required.');
    const usage = await db.query("SELECT COALESCE(sum(input_tokens),0) AS input_tokens,COALESCE(sum(output_tokens),0) AS output_tokens,COALESCE(sum(search_requests),0) AS searches,count(*) AS model_calls FROM model_usage WHERE created_at>now()-interval '24 hours'");
    return { request_failures: failures, last_24_hours: usage.rows[0] };
  });
  for (const [route, file, type] of [['/', 'index.html', 'text/html'], ['/app.js', 'app.js', 'text/javascript'], ['/app.css', 'app.css', 'text/css']]) app.get(route, async (_request, reply) => { reply.type(type); return readFile(new URL(`../../web/${file}`, import.meta.url)); });
  app.decorate('services', { auth, quotes });
  return app;
}
