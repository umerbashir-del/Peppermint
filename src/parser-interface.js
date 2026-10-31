import { runContractTask, ContractError, issue } from './agent-contract.js';
import { parseMaterialsList } from './materials-parser.js';

export async function runParserTask(task) {
  return runContractTask(task, 'materials_parser', () => {}, async input => {
    let parsed;
    try { parsed = parseMaterialsList(input); }
    catch (error) { throw new ContractError(error.message); }
    const issues = parsed.needs_human_review.map(item => issue('LINE_CLARIFICATION_REQUIRED', item.reasons.join(' '), [item.line_id]));
    for (const line of parsed.lines) {
      if (line.kind === 'material' && line.quantity !== null && !Number.isSafeInteger(line.quantity)) issues.push(issue('WHOLE_QUANTITY_REQUIRED', 'The supplier interface requires whole-unit quantities; do not round or convert automatically.', [line.line_id]));
    }
    if (parsed.escalation) issues.push(issue('LIST_REQUIRES_REVIEW', parsed.escalation));
    const ready = issues.length === 0;
    const supplier_lines = ready ? parsed.lines.map(({ line_id, item, quantity, unit }) => ({ line_id, item, quantity, unit })) : null;
    return { status: ready ? 'completed' : 'needs_human_review', approval_required: !ready, data: { ...parsed, supplier_lines }, issues, handoffs: [] };
  });
}
