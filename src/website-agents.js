import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { supplierProvider } from './pilot/provider.js';
import { runParserTask } from './parser-interface.js';
import { runSupplierTask } from './supplier-interface.js';
import { runResearchTask } from './research-interface.js';
import { responses } from './anthropic.js';

export async function websiteSupplier(tenantId) {
  const file = process.env.QBC_SUPPLIER_BINDINGS_FILE;
  let binding;
  if (file) {
    const bindings = JSON.parse(await readFile(file, 'utf8'));
    binding = bindings[tenantId];
    if (!binding || !binding.source_file) throw new Error('No supplier access is configured for this workspace.');
    binding = { ...binding, source_file: resolve(dirname(resolve(file)), binding.source_file) };
  } else if (process.env.NODE_ENV !== 'production' && process.env.QBC_ALLOW_SAMPLE_SUPPLIER === 'true') {
    binding = { supplier_id: 'pilot-supplier', account_id: 'normal', branch: 'sample-main' };
  } else throw new Error('Configure supplier access for this workspace.');
  const data = await supplierProvider({ file: binding.source_file, production: process.env.NODE_ENV === 'production', allowSample: false })(binding.supplier_id);
  if (data.branch !== binding.branch || !data.accounts.some(account => account.id === binding.account_id)) throw new Error('Supplier scope is unavailable.');
  return { binding, data };
}

const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
export function supplierFingerprint(result) {
  const { created_at, ...business } = result.data;
  return createHash('sha256').update(JSON.stringify(stable(business))).digest('hex');
}

export async function runWebsiteAgents(input, { load = websiteSupplier, respond = responses, researchOptions = {}, runResearch = runResearchTask, live = true } = {}) {
  const { binding, data } = await load(input.tenant_id);
  if (input.operation === 'context') return { account_id: binding.account_id, branch: binding.branch, sample_data: Boolean(data.sample_data), source: data.source ?? 'Sample supplier dataset' };
  const base = { schema_version: '1.0', request_id: input.request_id };
  const parsed = input.operation === 'check' ? null : await runParserTask({ ...base, task_id: 'website-parser', agent: 'materials_parser', input: { text: input.text, format: 'text' } });
  if (parsed && parsed.status !== 'completed') return { parser: parsed, supplier: null, research: [], ready: false };
  const lines = parsed ? parsed.data.supplier_lines : input.lines;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);
  let calls = 0;
  const bounded = async body => {
    if (++calls > 20) throw new Error('Website agent model-call limit reached.');
    return respond(body, { signal: controller.signal });
  };
  try {
    const supplier = await runSupplierTask({ ...base, task_id: 'website-supplier', agent: 'supplier_quote_desk', input: { account_id: binding.account_id, branch: binding.branch, delivery: null, lines } }, { supplierData: data, live: input.operation === 'check' ? false : live, respond: bounded });
    const research = [];
    if (input.operation !== 'check') for (const task of supplier.handoffs.slice(0, 3)) research.push(await runResearch(task, { ...researchOptions, respond: bounded }));
    const account = data.accounts.find(account => account.id === binding.account_id);
    const commercialCredit = input.operation !== 'check' || (Number.isSafeInteger(input.commercial_total_cents) && input.commercial_total_cents >= 0 && account.open_balance_cents + input.commercial_total_cents <= account.credit_limit_cents);
    const approvalEligible = input.operation !== 'check' || data.sample_data || (data.commercial_use === true && data.stock_confirmed === true && Date.parse(data.valid_until) > Date.now());
    const ready = supplier.status === 'completed' && supplier.data?.credit.status === 'within_limit' && supplier.handoffs.length === 0 && commercialCredit && Boolean(approvalEligible);
    const supplier_scope = { supplier_id: binding.supplier_id ?? data.supplier_id ?? 'pilot-supplier', account_id: binding.account_id };
    return { parser: parsed, supplier, research, ready, lines, supplier_scope, source_permissions: { commercial_use: data.commercial_use ?? null, stock_confirmed: data.stock_confirmed ?? null, valid_until: data.valid_until ?? null }, available_credit_cents: account.credit_limit_cents - account.open_balance_cents, fingerprint: supplier.data ? supplierFingerprint(supplier) : null, model_calls: calls, research_limit_reached: supplier.handoffs.length > 3 };
  } finally { clearTimeout(timer); }
}
