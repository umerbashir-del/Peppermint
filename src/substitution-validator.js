const normalized = value => typeof value === 'string' ? value.toLowerCase().replace(/\s+/g, ' ').trim() : '';
const same = (left, right) => normalized(left) !== '' && normalized(left) === normalized(right);
const known = value => typeof value === 'string' && value.trim() && !/^(unknown|unspecified|n\/a|tbd)$/i.test(value.trim());

export const VALIDATE_SUBSTITUTION_TOOL = {
  type: 'function', name: 'validate_substitution', strict: true,
  description: 'Check a supplier-listed substitute against the bound material line, known specifications, supplier approval rule, unit, and available branch quantity. Read-only; never authorizes an order.',
  parameters: {
    type: 'object', properties: {
      line_id: { type: 'string' }, requested_sku: { type: 'string' }, substitute_sku: { type: 'string' }, quantity: { type: 'integer', minimum: 1, maximum: 100000 },
    }, required: ['line_id', 'requested_sku', 'substitute_sku', 'quantity'], additionalProperties: false,
  },
};

export function validateSubstitution(data, request, args, { remainingStock } = {}) {
  const result = {
    status: 'needs_human_review', line_id: args?.line_id ?? null,
    requested_sku: args?.requested_sku ?? null, substitute_sku: args?.substitute_sku ?? null,
    requested_quantity: args?.quantity ?? null, available_quantity: null, rule_id: null,
    checks: [], reasons: [], source: 'sample supplier dataset', as_of: data.as_of,
    requires_rep_approval: true,
  };
  let incompatible = false;
  const fail = (field, reason, hard = false) => {
    result.checks.push({ field, outcome: hard ? 'incompatible' : 'needs_human_review' });
    result.reasons.push(reason); incompatible ||= hard;
  };
  const finish = () => {
    result.status = incompatible ? 'incompatible' : result.reasons.length ? 'needs_human_review' : 'approved_candidate';
    if (!result.reasons.length) result.reasons.push('Known specifications, approved supplier rule, unit, and available quantity pass. Rep and contractor acceptance are still required.');
    return result;
  };
  const line = request.lines.find(line => line.line_id === args?.line_id);
  const original = data.catalog.find(item => item.sku === args?.requested_sku);
  const candidate = data.catalog.find(item => item.sku === args?.substitute_sku);
  if (!line || !original || !candidate || request.branch !== data.branch) {
    fail('request', 'Unknown line, SKU, or supplier branch.'); return finish();
  }
  if (![original.description, ...(original.aliases ?? [])].some(alias => same(alias, line.item))) fail('request', 'Requested SKU does not exactly match the bound material line.', true);
  if (original.sku === candidate.sku || !original.allowed_substitutes?.includes(candidate.sku)) fail('supplier_list', 'Candidate is not a distinct supplier-listed substitute for this item.', true);
  if (!Number.isSafeInteger(args.quantity) || args.quantity <= 0 || args.quantity > line.quantity || args.quantity > 100000) fail('quantity', 'Quantity must be a positive whole number within the requested line quantity.');
  if (!same(original.unit, line.unit) || !same(candidate.unit, line.unit)) fail('unit', 'Requested and substitute units must match exactly; pack conversions are not inferred.', true);
  else result.checks.push({ field: 'unit', outcome: 'match' });

  const rules = (data.substitution_rules ?? []).filter(rule => rule.requested_sku === original.sku && rule.substitute_sku === candidate.sku);
  const rule = rules.length === 1 ? rules[0] : null;
  const approved = rule?.status === 'approved' && known(rule.id) && known(rule.approved_by) && typeof rule.approved_at === 'string' && !Number.isNaN(Date.parse(rule.approved_at));
  if (!approved) fail('supplier_rule', 'A single documented, approved supplier substitution rule is required.');
  else { result.rule_id = rule.id; result.checks.push({ field: 'supplier_rule', outcome: 'approved' }); }

  const from = original.specifications ?? {};
  const to = candidate.specifications ?? {};
  const required = Object.hasOwn(line, 'required_specs') ? line.required_specs : {};
  if (required === null || typeof required !== 'object' || Array.isArray(required)) fail('required_specs', 'Contractor specifications must be a map of explicit text values.');
  const requiredMap = required && typeof required === 'object' && !Array.isArray(required) ? required : {};
  const fields = new Set(['size', 'grade', 'material', ...Object.keys(from), ...Object.keys(to), ...Object.keys(requiredMap)]);
  for (const field of fields) {
    if (!known(from[field]) || !known(to[field])) { fail(field, `Missing or unknown ${field}; compatibility cannot be confirmed.`); continue; }
    if (Object.hasOwn(requiredMap, field)) {
      if (!known(requiredMap[field])) { fail(field, `Contractor's required ${field} is unclear.`); continue; }
      if (!same(requiredMap[field], from[field]) || !same(requiredMap[field], to[field])) {
        fail(field, `Requested item or substitute does not meet contractor's required ${field}.`, true); continue;
      }
    }
    if (same(from[field], to[field])) result.checks.push({ field, outcome: 'match' });
    else {
      const exception = approved ? rule.allowed_differences?.[field] : null;
      // Size, grade, material, and contractor requirements cannot be relaxed by a rule.
      if (!['size', 'grade', 'material', 'pack_size'].includes(field) && !Object.hasOwn(requiredMap, field) && exception && same(exception.from, from[field]) && same(exception.to, to[field])) {
        result.checks.push({ field, outcome: 'supplier_approved_difference' });
      } else fail(field, `Substitute ${field} differs without an applicable permitted equivalence.`, ['size', 'grade', 'material', 'pack_size'].includes(field) || approved);
    }
  }

  const available = remainingStock ? remainingStock.get(candidate.sku) : candidate.stock;
  if (!Number.isSafeInteger(available) || available < 0) fail('stock', 'Available branch quantity is unknown or invalid.');
  else {
    result.available_quantity = available;
    if (available < args.quantity) fail('stock', `Only ${available} units remain for ${args.quantity} requested substitute units.`);
    else result.checks.push({ field: 'stock', outcome: 'available' });
  }
  return finish();
}
