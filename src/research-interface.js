import { runContractTask, issue } from './agent-contract.js';
import { research } from './research-agent.js';

export async function runResearchTask(task, options = {}) {
  return runContractTask(task, 'research', () => {}, async input => {
    const findings = await research(input.question, options);
    const verified = findings.status === 'evidence_for_human_review' && findings.sources.length > 0;
    const issues = verified ? [] : [issue('RESEARCH_UNVERIFIED', 'No reliable source evidence was verified; human review is required.', input.line_ids)];
    for (const error of findings.errors ?? []) issues.push(issue('RESEARCH_TOOL_FAILED', `${error.tool}: source evidence could not be verified.`, input.line_ids));
    return { status: verified ? 'completed' : 'needs_human_review', approval_required: true, data: { ...findings, line_ids: [...input.line_ids] }, issues, handoffs: [] };
  });
}
