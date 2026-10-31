export const SCHEMA_VERSION = '1.0';
export const AGENTS = ['materials_parser', 'supplier_quote_desk', 'research'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);

export class ContractError extends Error {
  constructor(message) { super(message); this.name = 'ContractError'; }
}
export function requireContract(condition, message) {
  if (!condition) throw new ContractError(message);
}
export function fields(value, allowed, label) {
  requireContract(object(value), `${label} must be an object.`);
  requireContract(Object.keys(value).every(key => allowed.includes(key)), `${label} contains unsupported fields.`);
}
export function validateTask(task, agent) {
  fields(task, ['schema_version', 'request_id', 'task_id', 'agent', 'input'], 'Task');
  requireContract(task.schema_version === SCHEMA_VERSION, 'Unsupported schema_version; expected 1.0.');
  requireContract(id(task.request_id) && id(task.task_id), 'request_id and task_id must be 1–128 letters, numbers, dots, underscores, colons, or hyphens.');
  requireContract(AGENTS.includes(agent) && task.agent === agent, 'Task is addressed to the wrong agent.');
  requireContract(object(task.input), 'Task input must be an object.');
}
export function issue(code, message, line_ids = [], retryable = false) {
  return { code, message, line_ids, retryable };
}

// Adapters preserve the same envelope; legacy functions retain their existing return values.
export async function runContractTask(task, agent, validateInput, execute) {
  const result = {
    schema_version: SCHEMA_VERSION,
    request_id: id(task?.request_id) ? task.request_id : null,
    task_id: id(task?.task_id) ? task.task_id : null,
    agent, status: 'failed', approval_required: false, data: null, issues: [], handoffs: [],
  };
  try {
    validateTask(task, agent);
    validateInput(task.input);
    const payload = await execute(task.input);
    requireContract(['completed', 'needs_human_review'].includes(payload.status), 'Agent returned an invalid status.');
    requireContract(object(payload.data), 'Agent returned invalid data.');
    for (const handoff of payload.handoffs ?? []) validateTask(handoff, handoff.agent);
    return { ...result, approval_required: payload.approval_required ?? false, ...payload };
  } catch (error) {
    const invalid = error instanceof ContractError;
    const retryable = !invalid && (['TimeoutError', 'AbortError'].includes(error?.name) || ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(error?.cause?.code));
    result.issues = [issue(invalid ? 'INVALID_INPUT' : retryable ? 'TEMPORARY_FAILURE' : 'AGENT_FAILED', invalid ? error.message : 'Agent execution failed. Check local configuration or logs without exposing secrets; retry only when marked retryable.', [], retryable)];
    return result;
  }
}
