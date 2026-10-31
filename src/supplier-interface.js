import { createHash } from 'node:crypto';
import { runContractTask, requireContract, issue } from './agent-contract.js';
import { quote } from './supplier-agent.js';
import { loadSupplier } from './supplier-tools.js';

export async function runSupplierTask(task, { supplierData, live = false, respond } = {}) {
  return runContractTask(task, 'supplier_quote_desk', () => {}, async input => {
    const data = supplierData ?? await loadSupplier();
    requireContract(input.branch === data.branch, 'Unknown supplier branch.');
    const draft = await quote(input, data, { live, ...(respond ? { respond } : {}) });
    const handoffs = [];
    const issues = draft.needs_human_review.map(message => issue('QUOTE_REVIEW_REQUIRED', message));
    for (const line of draft.lines) {
      if (line.unresolved_quantity) issues.push(issue('LINE_UNRESOLVED', 'Some requested units remain unresolved.', [line.line_id]));
      for (const check of line.substitution_checks) {
        const fields = check.checks.filter(item => item.outcome === 'needs_human_review' && !['supplier_rule', 'request', 'quantity', 'stock', 'required_specs'].includes(item.field)).map(item => item.field);
        if (!fields.length) continue;
        const candidate = data.catalog.find(item => item.sku === check.substitute_sku);
        const task_id = 'research-' + createHash('sha256').update(JSON.stringify([task.request_id, task.task_id, line.line_id, check.substitute_sku])).digest('hex').slice(0, 24);
        handoffs.push({
          schema_version: '1.0', request_id: task.request_id, task_id, agent: 'research',
          input: { question: `What manufacturer specification evidence is needed to compare ${line.item.slice(0, 600)} with ${(candidate?.description ?? 'the proposed material').slice(0, 600)}, particularly ${fields.join(', ').slice(0, 500)}? Identify missing evidence; do not authorize a substitution.`, line_ids: [line.line_id] },
        });
      }
    }
    return { status: draft.review_status === 'needs_human_review' ? 'needs_human_review' : 'completed', approval_required: true, data: draft, issues, handoffs };
  });
}
