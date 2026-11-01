import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { parseMaterialsList } from './materials-parser.js';
import { runSupplierTask } from './supplier-interface.js';
import { responses } from './anthropic.js';

export async function evaluateCases(cases, { supplierData, live = false, respond = responses, requireReviewed = false, minimumReviewed = 20, rates = {} } = {}) {
  if (!Array.isArray(cases) || cases.length === 0) throw new Error('Provide a nonempty evaluation dataset.');
  const totals = { expected_lines: 0, correct_matches: 0, incorrect_confident_matches: 0, quantity_errors: 0, ambiguity_errors: 0, execution_errors: 0, unsupported_substitutions: 0, fabricated_values: 0, dropped_lines: 0, model_calls: 0, input_tokens: 0, output_tokens: 0, search_requests: 0 };
  const details = [], times = [];
  let reviewed = 0;
  for (const entry of cases) {
    if (!entry.id || !Array.isArray(entry.expected?.lines) || entry.expected.lines.length === 0) throw new Error('Every evaluation case needs an ID and expected lines.');
    if (entry.supplier_reviewed === true && typeof entry.reviewed_by === 'string' && entry.reviewed_by.trim() && Number.isFinite(Date.parse(entry.reviewed_at))) reviewed++;
    const start = performance.now();
    const parsed = parseMaterialsList({ text: entry.input.text, format: entry.input.format || 'text' });
    let result;
    if (parsed.lines.every(line => line.kind === 'material' && !line.ambiguity_flag && Number.isSafeInteger(line.quantity))) {
      result = await runSupplierTask({ schema_version: '1.0', request_id: 'eval', task_id: 'case-' + createHash('sha256').update(entry.id).digest('hex').slice(0, 20), agent: 'supplier_quote_desk', input: { account_id: entry.input.account_id, branch: entry.input.branch, delivery: entry.input.delivery ?? null, lines: parsed.lines.map(({ line_id, item, quantity, unit }) => ({ line_id, item, quantity, unit })) } }, { supplierData, live, respond: async body => { const response = await respond(body); totals.model_calls++; for (const key of ['input_tokens', 'output_tokens', 'search_requests']) totals[key] += response.usage?.[key] ?? 0; return response; } });
    }
    const elapsed = performance.now() - start; times.push(elapsed);
    const mistakes = [];
    if (result?.status === 'failed') { totals.execution_errors++; mistakes.push('execution_error'); }
    for (const expected of entry.expected.lines) {
      totals.expected_lines++;
      const line = parsed.lines.find(line => line.line_id === expected.line_id);
      const quoted = result?.data?.lines.find(line => line.line_id === expected.line_id);
      const primary = quoted?.allocations.find(item => !item.substitute)?.sku ?? null;
      if (!line) { totals.dropped_lines++; mistakes.push('dropped_line'); }
      if (primary === expected.sku) totals.correct_matches++;
      else { mistakes.push('incorrect_match'); if (primary !== null) totals.incorrect_confident_matches++; }
      if (line?.quantity !== expected.quantity) { totals.quantity_errors++; mistakes.push('quantity_error'); }
      if (typeof expected.needs_review === 'boolean' && expected.needs_review !== Boolean(line?.ambiguity_flag || quoted?.unresolved_quantity || quoted?.substitution_checks?.some(check => check.status !== 'approved_candidate'))) { totals.ambiguity_errors++; mistakes.push('ambiguity_error'); }
      for (const part of quoted?.allocations ?? []) {
        if (part.substitute && !(expected.allowed_substitutes ?? []).includes(part.sku)) { totals.unsupported_substitutions++; mistakes.push('unsupported_substitution'); }
        const product = supplierData.catalog.find(item => item.sku === part.sku);
        const account = supplierData.accounts.find(item => item.id === entry.input.account_id);
        if (!product || part.list_unit_price_cents !== product.list_price_cents || part.line_total_cents !== Math.round(product.list_price_cents * part.quantity * (10000 - (account?.discount_basis_points ?? 0)) / 10000)) { totals.fabricated_values++; mistakes.push('fabricated_value'); }
      }
    }
    totals.dropped_lines += Math.max(0, parsed.lines.length - entry.expected.lines.length); // Extra unexpected records also fail the completeness gate.
    details.push({ case_id: entry.id, elapsed_ms: Math.round(elapsed), status: result?.status ?? parsed.status, mistakes: [...new Set(mistakes)] });
  }
  times.sort((a,b) => a-b);
  const match_accuracy = totals.correct_matches / totals.expected_lines;
  const qualityPassed = match_accuracy >= 0.99 && ['incorrect_confident_matches','quantity_errors','ambiguity_errors','execution_errors','unsupported_substitutions','fabricated_values','dropped_lines'].every(key => totals[key] === 0);
  const reviewedPassed = reviewed === cases.length && reviewed >= minimumReviewed;
  const hasRates = ['input_usd_per_million', 'output_usd_per_million', 'search_usd_per_thousand'].every(key => Number.isFinite(rates[key]) && rates[key] >= 0);
  return { schema_version: '1.0', generated_at: new Date().toISOString(), mode: live ? 'live_supplier_matching' : 'offline_rules', dataset_kind: reviewed === cases.length ? 'supplier_reviewed' : 'synthetic_or_unreviewed', cases: cases.length, reviewed_cases: reviewed, reviewed_gate_passed: reviewedPassed, passed: qualityPassed && (!requireReviewed || reviewedPassed), match_accuracy, median_ms: Math.round(times[Math.floor(times.length / 2)]), p95_ms: Math.round(times[Math.min(times.length - 1, Math.floor(times.length * 0.95))]), ...totals, estimated_cost_usd: hasRates ? totals.input_tokens / 1e6 * rates.input_usd_per_million + totals.output_tokens / 1e6 * rates.output_usd_per_million + totals.search_requests / 1000 * rates.search_usd_per_thousand : null, price_assumptions: hasRates ? rates : null, note: 'Unmatched null-SKU labels count as correct classification. Synthetic/offline passing does not establish real-world accuracy. Rate inputs are explicit estimates, not billing totals.', details };
}

export async function evaluateFile(path, options = {}) {
  const source = await readFile(path, 'utf8');
  const cases = source.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
  const result = await evaluateCases(cases, options);
  result.dataset_sha256 = createHash('sha256').update(source).digest('hex');
  result.prompt_sha256 = createHash('sha256').update(await readFile(new URL('./supplier-agent.js', import.meta.url))).digest('hex');
  if (options.output) { await mkdir(dirname(options.output), { recursive: true }); await writeFile(options.output, JSON.stringify(result, null, 2)); }
  return result;
}
