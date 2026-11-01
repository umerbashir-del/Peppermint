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
        const requirements = JSON.stringify(line.required_specs ?? {});
        const question = `What manufacturer specification evidence is needed to compare ${line.item.slice(0, 600)} with ${(candidate?.description ?? 'the proposed material').slice(0, 600)}, particularly ${fields.join(', ').slice(0, 500)}? Required specifications: ${requirements.length <= 1000 ? requirements : 'Detailed requirements require human clarification.'} Identify missing evidence; do not authorize a substitution.`;
        const researchInput = { question, line_ids: [line.line_id] };
        const task_id = 'research-' + createHash('sha256').update(JSON.stringify([task.request_id, task.task_id, researchInput, line.required_specs ?? {}])).digest('hex').slice(0, 24);
        handoffs.push({
          schema_version: '1.0', request_id: task.request_id, task_id, agent: 'research',
          input: researchInput,
        });
      }
    }
    return { status: draft.review_status === 'needs_human_review' ? 'needs_human_review' : 'completed', approval_required: true, data: draft, issues, handoffs };
  });
}
