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
  const events = {}, calls = [], timers = [], storage = new Map([['qbc_token', 'session-A']]);
  const pending = { id: 'pending-job', project_name: 'Saved question job', status: 'needs_input', workflow: 'supplier', notes: 'some wood', questions: ['PRIVATE question'], policy: {}, quote: null };
  const routes = { '/projects': [{ id: 'private-project', name: 'PRIVATE Project' }], '/quotes': [], '/price-items?limit=200': [{ id: 'private-price', name: 'PRIVATE Catalog', unit: 'each', unit_price: '4.20' }], '/jobs': [pending], '/jobs/pending-job': pending,
    '/profile': { labor_rate: '45.00', valid_until_days: 30 }, '/auth/me': { id: 'owner-id', role: 'owner', tenant_id: 'a' },
    '/quotes/private': { quote: { id: 'private', status: 'draft', created_by: 'owner-id', snapshot_hash: 'hash' }, snapshot_verified: true, snapshot: { customer_text: { lines_text: ['PRIVATE quote'] } } } };
  const response = body => ({ status: 200, ok: true, json: async () => body });
  const context = { document: { getElementById: get, addEventListener: (name, fn) => { events[name] = fn; } },
    sessionStorage: { getItem: k => storage.get(k), setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) },
    crypto: webcrypto, window: { crypto: webcrypto }, URL, setTimeout: fn => timers.push(fn),
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
  assert.equal(page.get('scope-project').innerHTML, '');
  assert.equal(page.get('scope-price').innerHTML, '');
  assert.equal(page.get('app-view').classList.contains('hidden'), true);
});
