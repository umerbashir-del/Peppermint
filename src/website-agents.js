import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { supplierProvider } from './pilot/provider.js';
import { runParserTask } from './parser-interface.js';
import { runSupplierTask } from './supplier-interface.js';
import { runResearchTask } from './research-interface.js';
import { responses } from './anthropic.js';
import { issue } from './agent-contract.js';

function researchMatches(result, task) {
  return result && result.schema_version === task.schema_version && result.request_id === task.request_id
    && result.task_id === task.task_id && result.agent === 'research'
    && ['completed', 'needs_human_review', 'failed'].includes(result.status)
    && Array.isArray(result.issues) && Array.isArray(result.handoffs) && result.handoffs.length === 0
    && (result.status === 'failed' && result.data === null || result.data && JSON.stringify(result.data.line_ids) === JSON.stringify(task.input.line_ids))
    && (result.status !== 'completed' || Array.isArray(result.data.sources) && result.data.sources.length > 0);
}

function failedResearch(task, code) {
  return { schema_version: task.schema_version, request_id: task.request_id, task_id: task.task_id, agent: 'research', status: 'failed', approval_required: true, data: null,
    issues: [issue(code, 'Research handoff could not be verified; supplier questions still require review.', task.input.line_ids)], handoffs: [] };
}

export async function websiteSupplier(tenantId) {
  const file = process.env.QBC_SUPPLIER_BINDINGS_FILE;
  let binding;
  let demo = false;
  if (file) {
    const bindings = JSON.parse(await readFile(file, 'utf8'));
    binding = bindings[tenantId];
    if (!binding || !binding.source_file) throw new Error('No supplier access is configured for this workspace.');
    binding = { ...binding, source_file: resolve(dirname(resolve(file)), binding.source_file) };
  } else if ((process.env.QBC_DEMO_SUPPLIER_TENANTS ?? '').split(',').map(value => value.trim()).filter(Boolean).includes(tenantId)) {
    demo = true;
    binding = { supplier_id: 'pilot-supplier', account_id: 'normal', branch: 'sample-main', source_file: fileURLToPath(new URL('../data/supplier.json', import.meta.url)) };
  } else if (process.env.NODE_ENV !== 'production' && process.env.QBC_ALLOW_SAMPLE_SUPPLIER === 'true') {
    binding = { supplier_id: 'pilot-supplier', account_id: 'normal', branch: 'sample-main' };
  } else throw new Error('Configure supplier access for this workspace.');
  const data = await supplierProvider({ file: binding.source_file, production: process.env.NODE_ENV === 'production', allowSample: demo })(binding.supplier_id);
  if (demo && data.sample_data !== true) throw new Error('Demo supplier requires explicitly labeled sample data.');
  if (data.branch !== binding.branch || !data.accounts.some(account => account.id === binding.account_id)) throw new Error('Supplier scope is unavailable.');
  return { binding, data };
}

const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
export function supplierFingerprint(result) {
  const { created_at, ...business } = result.data;
  return createHash('sha256').update(JSON.stringify(stable(business))).digest('hex');
}

function validateSource(binding, data) {
  const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
  const account = data?.accounts?.find(item => item.id === binding.account_id);
  if (!account || data.branch !== binding.branch || !nonnegative(account.open_balance_cents)
    || !nonnegative(account.credit_limit_cents) || !nonnegative(account.discount_basis_points) || account.discount_basis_points > 10000
    || !Array.isArray(data.catalog) || data.catalog.length === 0 || data.catalog.length > 5000
    || new Set(data.catalog.map(item => item.sku)).size !== data.catalog.length
    || data.catalog.some(item => typeof item.sku !== 'string' || !item.sku || typeof item.description !== 'string'
      || typeof item.unit !== 'string' || !nonnegative(item.list_price_cents) || !nonnegative(item.stock))) {
    throw new Error('Supplier pricing, stock, or account source is invalid.');
  }
}

export async function runWebsiteAgents(input, { load = websiteSupplier, respond = responses, researchOptions = {}, runResearch = runResearchTask, live = true, onProgress = async () => {} } = {}) {
  const emit = (stage, status) => onProgress({ stage, status });
  const { binding, data } = await load(input.tenant_id);
  validateSource(binding, data);
  if (input.operation === 'context') return { account_id: binding.account_id, branch: binding.branch, sample_data: Boolean(data.sample_data), source: data.source ?? 'Sample supplier dataset' };
  const base = { schema_version: '1.0', request_id: input.request_id };
  if (input.operation !== 'check') await emit('materials', 'running');
  const parsed = input.operation === 'check' ? null : await runParserTask({ ...base, task_id: 'website-parser', agent: 'materials_parser', input: { text: input.text, format: 'text' } });
  if (parsed) await emit('materials', parsed.status === 'completed' ? 'complete' : parsed.status === 'failed' ? 'failed' : 'needs_input');
  if (parsed && parsed.status !== 'completed') return { parser: parsed, supplier: null, research: [], ready: false };
  const lines = parsed ? parsed.data.supplier_lines : input.lines;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);
  let calls = 0;
  const bounded = async body => {
    if (calls >= 20) throw new Error('Website agent model-call limit reached.');
    calls++;
    return respond(body, { signal: controller.signal });
  };
  try {
    if (input.operation !== 'check') await emit('supplier', 'running');
    const supplier = await runSupplierTask({ ...base, task_id: 'website-supplier', agent: 'supplier_quote_desk', input: { account_id: binding.account_id, branch: binding.branch, delivery: null, lines } }, { supplierData: data, live: input.operation === 'check' ? false : live, respond: bounded });
    if (input.operation !== 'check') await emit('supplier', supplier.status === 'completed' ? 'complete' : supplier.status === 'failed' ? 'failed' : 'needs_input');
    const research = [];
    if (input.operation !== 'check') await emit('research', supplier.handoffs.length ? 'running' : 'skipped');
    if (input.operation !== 'check') for (const task of supplier.handoffs.slice(0, 3)) {
      try {
        const result = await runResearch(task, { ...researchOptions, respond: bounded });
        research.push(researchMatches(result, task) ? result : failedResearch(task, 'HANDOFF_MISMATCH'));
      } catch { research.push(failedResearch(task, 'HANDOFF_FAILED')); }
    }
    if (research.length) await emit('research', research.every(result => result.status === 'completed') ? 'complete' : research.some(result => result.status === 'failed') ? 'failed' : 'needs_input');
    const account = data.accounts.find(account => account.id === binding.account_id);
    const commercialCredit = input.operation !== 'check' || (Number.isSafeInteger(input.commercial_total_cents) && input.commercial_total_cents >= 0 && account.open_balance_cents + input.commercial_total_cents <= account.credit_limit_cents);
    const approvalEligible = input.operation !== 'check' || data.sample_data || (data.commercial_use === true && data.stock_confirmed === true && Date.parse(data.valid_until) > Date.now());
    const ready = supplier.status === 'completed' && supplier.data?.credit.status === 'within_limit' && supplier.handoffs.length === 0 && commercialCredit && Boolean(approvalEligible);
    const supplier_scope = { supplier_id: binding.supplier_id ?? data.supplier_id ?? 'pilot-supplier', account_id: binding.account_id };
    return { parser: parsed, supplier, research, ready, lines, supplier_scope, source_permissions: { commercial_use: data.commercial_use ?? null, stock_confirmed: data.stock_confirmed ?? null, valid_until: data.valid_until ?? null }, available_credit_cents: account.credit_limit_cents - account.open_balance_cents, fingerprint: supplier.data ? supplierFingerprint(supplier) : null, model_calls: calls, research_limit_reached: supplier.handoffs.length > 3 };
  } finally { clearTimeout(timer); }
}
