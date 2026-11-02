import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';

const script = await readFile(new URL('../quote-builder/web/app.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function element(id) {
  const classes = new Set();
  return { id, value: '', innerHTML: '', textContent: '', dataset: {}, disabled: false, listeners: {}, controls: [],
    classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x), toggle: (x, force) => force ? classes.add(x) : classes.delete(x) },
    addEventListener(name, fn) { this.listeners[name] = fn; }, setAttribute() {}, scrollIntoView() {},
    querySelectorAll() { return this.controls; }, querySelector() { return this.button; }, closest() { return this.section ||= element('section'); },
    reset() { this.controls.forEach(control => { control.value = ''; }); },
  };
}
async function browser(extra = {}) {
  const nodes = new Map();
  const get = id => { if (!nodes.has(id)) nodes.set(id, element(id)); return nodes.get(id); };
  for (const [form, fields] of Object.entries({ 'job-form': ['job-notes', 'job-project', 'job-customer', 'job-workflow', 'job-overhead', 'job-markup'], 'profile-form': ['p-rate', 'p-days', 'p-license', 'p-insurance', 'p-terms'], 'scope-form': [] })) {
    get(form).button = element(form + '-submit'); get(form).button.textContent = 'Submit';
    get(form).controls = [...fields.map(get), get(form).button];
  }
  get('job-workflow').value = 'supplier';
  get('job-result').classList.add('hidden');
  const events = {}, calls = [], timers = [], storage = new Map([['qbc_token', 'session-A']]);
  if (extra.progress) storage.set('qbc_progress', JSON.stringify({ key: extra.progress }));
  const pending = { id: 'pending-job', project_name: 'Saved question job', status: 'needs_input', workflow: 'supplier', notes: 'some wood', questions: ['PRIVATE question'], policy: {}, quote: null };
  const routes = { '/projects': [{ id: 'private-project', name: 'PRIVATE Project' }], '/quotes': [], '/price-items?limit=200': [{ id: 'private-price', name: 'PRIVATE Catalog', unit: 'each', unit_price: '4.20' }], '/jobs': [pending], '/jobs/pending-job': pending,
    '/profile': { labor_rate: '45.00', valid_until_days: 30 }, '/auth/me': { id: 'owner-id', role: 'owner', tenant_id: 'a' },
    '/quotes/private': { quote: { id: 'private', status: 'draft', created_by: 'owner-id', snapshot_hash: 'hash' }, snapshot_verified: true, snapshot: { customer_text: { lines_text: ['PRIVATE quote'] } } } };
  const response = body => ({ status: 200, ok: true, json: async () => body });
  const context = { document: { getElementById: get, addEventListener: (name, fn) => { events[name] = fn; } },
    sessionStorage: { getItem: k => storage.get(k), setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) },
    crypto: webcrypto, window: { crypto: webcrypto, QBC_CONFIG: extra.config }, URL, AbortSignal, clearTimeout() {}, setTimeout: fn => timers.push(fn),
    fetch: async (path, options = {}) => { calls.push({ path, options }); return extra.fetch ? extra.fetch(path, options, response, routes) : response(routes[path] || {}); } };
  runInNewContext(script, context);
  await tick(); await tick();
  return { get, events, calls, timers, context, response };
}
test('dashboard restores saved profile and jobs while preserving unsaved profile edits', async () => {
  const page = await browser();
  assert.equal(page.get('p-rate').value, '45.00');
  assert.match(page.get('jobs-table').innerHTML, /Saved question job/);
  page.get('p-rate').value = '60'; page.get('profile-form').listeners.input();
  await page.get('refresh').listeners.click();
  assert.equal(page.get('p-rate').value, '60');
});

const runningProgress = () => ({ job_id: 'pending-job', workflow: 'supplier', attempt: 1, status: 'running', steps: [
  { id: 'materials', label: 'Read materials list', status: 'complete' },
  { id: 'supplier', label: 'Check supplier', status: 'running' },
  { id: 'research', label: 'Check specifications', status: 'waiting' },
  { id: 'draft', label: 'Prepare draft', status: 'waiting' },
  { id: 'review', label: 'Rep approval', status: 'waiting' },
] });

test('restored progress polls without submitting another job and never simulates completion', async () => {
  let state = runningProgress();
  const page = await browser({ progress: 'create:saved', fetch: (path, options, response, routes) => response(path.startsWith('/job-progress/') ? state : routes[path] || {}) });
  assert.match(page.get('quote-progress').innerHTML, /Work in progress/);
  assert.match(page.get('quote-progress').innerHTML, /Check supplier<\/strong><small>Working/);
  assert.equal(page.get('job-form').button.disabled, true);
  await page.timers.shift()();
  assert.match(page.get('quote-progress').innerHTML, /Prepare draft<\/strong><small>Not started/);
  state = { ...state, status: 'ready', steps: state.steps.map(s => ({ ...s, status: s.id === 'review' ? 'waiting' : s.id === 'research' ? 'skipped' : 'complete' })) };
  await page.timers.shift()();
  assert.match(page.get('quote-progress').innerHTML, /Draft ready for review/);
  assert.match(page.get('quote-progress').innerHTML, /Rep approval<\/strong><small>Not started/);
  assert.equal(page.get('job-form').button.disabled, false);
  assert.equal(page.calls.filter(c => c.options.method === 'POST').length, 0);
  assert.ok(page.calls.some(c => c.path === '/jobs/pending-job'));
});

test('late progress responses after sign-out cannot restore private status', async () => {
  let resolve;
  const page = await browser({ progress: 'create:saved', fetch: (path, options, response, routes) => path.startsWith('/job-progress/') ? new Promise(done => { resolve = () => done(response(runningProgress())); }) : response(routes[path] || {}) });
  page.get('logout').listeners.click();
  resolve(); await tick(); await tick();
  assert.equal(page.get('quote-progress').innerHTML, '');
  assert.equal(page.get('quote-progress').classList.contains('hidden'), true);
  assert.equal(page.timers.length, 0);
});

test('a correction keeps polling past the previous attempt instead of claiming the new run is done', async () => {
  let state = { ...runningProgress(), status: 'needs_input' };
  const page = await browser({ fetch: (path, options, response, routes) => response(path.startsWith('/job-progress/') ? state : routes[path] || {}) });
  const watch = page.context.watchProgress('answer:pending-job', false, true);
  await tick();
  assert.match(page.get('quote-progress').innerHTML, /Waiting for the server/);
  assert.equal(watch.live, true);
  state = { ...runningProgress(), attempt: 2 };
  await page.timers.shift()();
  assert.match(page.get('quote-progress').innerHTML, /Run 2/);
  assert.match(page.get('quote-progress').innerHTML, /Work in progress/);
});

test('opening a job created before progress tracking reports missing history without endless polling', async () => {
  const page = await browser({ fetch: (path, options, response, routes) => path.startsWith('/job-progress/') ? { status:404, ok:false, json:async()=>({detail:'Progress is not available yet'}) } : response(routes[path] || {}) });
  page.context.watchProgress('job:legacy-job');
  await tick();
  assert.match(page.get('quote-progress').innerHTML, /No progress history is available/);
  assert.equal(page.timers.length, 0);
});

test('interrupted progress describes the last observed stage without claiming it is still working', async () => {
  const page = await browser({ progress: 'create:saved', fetch: (path, options, response, routes) => response(path.startsWith('/job-progress/') ? { ...runningProgress(), status: 'interrupted' } : routes[path] || {}) });
  assert.match(page.get('quote-progress').innerHTML, /Last seen working/);
  assert.match(page.get('quote-progress').innerHTML, /Refresh saved jobs before retrying/);
  assert.equal(page.get('job-form').button.disabled, false);
});
test('repeated job submissions make one request and show busy controls until completion', async () => {
  let finish;
  const page = await browser({ fetch: (path, options, response, routes) => path === '/jobs' && options.method === 'POST' ? new Promise(resolve => { finish = () => resolve(response({ id: 'new', status: 'ready', questions: [], quote: null })); }) : response(routes[path] || {}) });
  const form = page.get('job-form'); page.get('job-notes').value = '10 studs'; page.get('job-project').value = 'Project';
  const event = { preventDefault() {}, target: form };
  const first = form.listeners.submit(event);
  await form.listeners.submit(event);
  assert.equal(page.calls.filter(c => c.path === '/jobs' && c.options.method === 'POST').length, 1);
  assert.equal(form.button.disabled, true);
  assert.equal(form.button.textContent, 'Creating draft…');
  finish(); await first;
  assert.equal(form.button.disabled, false);
});
test('network retries keep the same idempotency key and errors do not auto-dismiss', async () => {
  const keys = [];
  const page = await browser({ fetch: (path, options, response, routes) => {
    if (path === '/jobs' && options.method === 'POST') { keys.push(options.headers['Idempotency-Key']); if (keys.length === 1) throw new Error('Offline'); return response({ id: 'retry', status: 'ready', quote: null, questions: [] }); }
    return response(routes[path] || {});
  } });
  const event = { preventDefault() {}, target: page.get('job-form') };
  await page.get('job-form').listeners.submit(event);
  assert.equal(page.get('notice').textContent, 'Offline');
  assert.equal(page.timers.length, 0);
  await page.get('job-form').listeners.submit(event);
  assert.equal(keys[0], keys[1]);
});
test('sign-out removes private job, quote, and profile data before the next user sees the page', async () => {
  const page = await browser();
  const button = { dataset: { openJob: 'pending-job' }, closest() { return this; } };
  await page.events.click({ target: button });
  await page.events.click({ target: { dataset: { open: 'private' }, closest() { return this; } } });
  assert.match(page.get('job-result').innerHTML, /PRIVATE question/);
  assert.match(page.get('quote-body').innerHTML, /PRIVATE quote/);
  assert.match(page.get('scope-project').innerHTML, /PRIVATE Project/);
  page.get('logout').listeners.click();
  assert.equal(page.get('job-result').innerHTML, '');
  assert.equal(page.get('quote-body').innerHTML, '');
  assert.equal(page.get('p-rate').value, '');
  assert.equal(page.get('workspace-name').textContent, 'Construction quote desk');
  assert.equal(page.get('scope-project').innerHTML, '');
  assert.equal(page.get('scope-price').innerHTML, '');
  assert.equal(page.get('app-view').classList.contains('hidden'), true);
});

test('settings navigation reveals the form and pricing source explains the selected workflow', async () => {
  const page = await browser();
  assert.equal(page.get('workspace-name').textContent, 'a');
  page.get('settings-link').listeners.click();
  assert.equal(page.get('workspace-settings').open, true);
  page.get('job-workflow').value = 'crew';
  page.get('job-workflow').listeners.change();
  assert.equal(page.get('job-notes-label').textContent, 'Job description');
  assert.match(page.get('workflow-help').textContent, /uploaded price list/);
  page.get('job-workflow').value = 'supplier';
  page.get('job-workflow').listeners.change();
  assert.equal(page.get('job-notes-label').textContent, 'Materials list');
  assert.match(page.get('workflow-help').textContent, /Labor is excluded/);
});

test('reviewers see review instructions rather than an empty drafting form or unavailable settings', async () => {
  const page = await browser({ fetch: (path, options, response, routes) => response(path === '/auth/me' ? { id: 'reviewer', role: 'reviewer', tenant_id: 'a' } : routes[path] || {}) });
  assert.equal(page.get('job-form').classList.contains('hidden'), true);
  assert.equal(page.get('job-mode-label').textContent, 'View details');
  assert.equal(page.get('job-readonly-hint').classList.contains('hidden'), false);
  assert.match(page.get('welcome-description').textContent, /Review quotes/);
  assert.equal(page.get('settings-description').textContent, 'Contractor details');
});

test('split-host frontend routes authenticated requests, sign-in, uploads, PDFs, and logout to its backend', async () => {
  const origin = 'https://buildbridge-api.example';
  const page = await browser({ config: { apiBaseUrl: origin }, fetch: (url, options, response, routes) => {
    assert.ok(url.startsWith(origin + '/'));
    const path = url.slice(origin.length);
    if (path === '/auth/login') return response({ access_token: 'session-B' });
    if (path === '/price-lists') return response({ accepted: 1, rejected: [] });
    if (path.endsWith('/pdf')) return { ok: false }; // Exercise the destination without creating a browser download.
    return response(routes[path] || {});
  } });
  await page.get('login-form').listeners.submit({ preventDefault() {}, submitter: element('login') });
  await tick(); await tick();
  page.get('price-file').files = [{ text: async () => 'name,unit,unit_price\nstud,ea,4.20' }];
  await page.get('price-upload').listeners.click();
  const pdf = { dataset: { pdf: 'approved-quote' }, closest() { return this; } };
  await page.events.click({ target: pdf });
  page.get('logout').listeners.click();
  for (const path of ['/projects', '/jobs', '/auth/me', '/auth/login', '/price-lists', '/quotes/approved-quote/pdf', '/auth/logout']) {
    assert.ok(page.calls.some(call => call.path === origin + path), path);
  }
  assert.equal(page.calls.find(call => call.path.endsWith('/price-lists')).options.headers.Authorization, 'Bearer session-B');
  assert.equal(page.calls.find(call => call.path.endsWith('/pdf')).options.headers.Authorization, 'Bearer session-B');
});
