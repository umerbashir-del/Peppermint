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
function text(value, limit, label) {
  requireContract(typeof value === 'string' && value.trim().length > 0 && value.length <= limit, `${label} must be nonempty text of at most ${limit} characters.`);
}
export function validateAgentInput(input, agent) {
  if (agent === 'materials_parser') {
    fields(input, ['text', 'format'], 'Parser input');
    text(input.text, 100000, 'Materials list');
    requireContract(!input.text.includes('\0'), 'Materials list must be readable text.');
    requireContract(['text', 'csv', 'pdf_text'].includes(input.format), 'Parser format must be text, csv, or pdf_text.');
  } else if (agent === 'research') {
    fields(input, ['question', 'line_ids'], 'Research input');
    text(input.question, 3000, 'Research question');
    requireContract(Array.isArray(input.line_ids) && input.line_ids.length <= 100 && new Set(input.line_ids).size === input.line_ids.length, 'Research line_ids must be an array of at most 100 unique strings.');
    for (const lineId of input.line_ids) text(lineId, 128, 'Line ID');
  } else if (agent === 'supplier_quote_desk') {
    fields(input, ['account_id', 'branch', 'delivery', 'lines'], 'Supplier input');
    text(input.account_id, 128, 'Account ID'); text(input.branch, 128, 'Branch');
    requireContract(Object.hasOwn(input, 'delivery'), 'Supplier delivery is required; use null for pickup.');
    if (input.delivery !== null) {
      fields(input.delivery, ['zip', 'slot_id'], 'Delivery');
      requireContract(typeof input.delivery.zip === 'string' && /^\d{5}(?:-\d{4})?$/.test(input.delivery.zip), 'Delivery ZIP must be a US ZIP code.');
      text(input.delivery.slot_id, 128, 'Delivery slot ID');
    }
    requireContract(Array.isArray(input.lines) && input.lines.length >= 1 && input.lines.length <= 100, 'Supplier input must have 1–100 lines.');
    const ids = new Set();
    for (const line of input.lines) {
      fields(line, ['line_id', 'item', 'quantity', 'unit', 'required_specs'], 'Material line');
      text(line.line_id, 128, 'Line ID'); text(line.item, 2000, 'Item'); text(line.unit, 50, 'Unit');
      requireContract(!ids.has(line.line_id), 'Supplier line IDs must be unique.'); ids.add(line.line_id);
      requireContract(Number.isSafeInteger(line.quantity) && line.quantity > 0 && line.quantity <= 100000, 'Supplier quantities must be whole numbers from 1 to 100000.');
      if (Object.hasOwn(line, 'required_specs')) {
        requireContract(object(line.required_specs), 'required_specs must be a text-value map.');
        for (const value of Object.values(line.required_specs)) text(value, 1000, 'Required specification');
      }
    }
  } else throw new ContractError('Unknown agent.');
}
export function validateTask(task, agent) {
  fields(task, ['schema_version', 'request_id', 'task_id', 'agent', 'input'], 'Task');
  requireContract(task.schema_version === SCHEMA_VERSION, 'Unsupported schema_version; expected 1.0.');
  requireContract(id(task.request_id) && id(task.task_id), 'request_id and task_id must be 1–128 letters, numbers, dots, underscores, colons, or hyphens.');
  requireContract(AGENTS.includes(agent) && task.agent === agent, 'Task is addressed to the wrong agent.');
  requireContract(object(task.input), 'Task input must be an object.');
  validateAgentInput(task.input, agent);
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
