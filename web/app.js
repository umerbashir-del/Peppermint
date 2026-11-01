const $ = id => document.getElementById(id);
const state = { me: null, csrf: null, quote: null, catalog: null, scopes: [] };
const el = (tag, text, parent) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; parent?.append(node); return node; };
const money = cents => cents === null || cents === undefined ? 'Not calculated' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const message = text => { $('message').textContent = text; };
const role = () => state.me?.memberships.find(item => item.supplier_id === $('supplier').value)?.role;
async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(state.csrf ? { 'X-CSRF-Token': state.csrf } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) {
    const details = data.result?.issues?.map(item => `${item.line_ids.join(', ')}: ${item.message}`).join('\n');
    throw new Error(details || data.error?.message || 'Request could not be completed.');
  }
  return data;
}
async function guarded(action) { message(''); try { await action(); } catch (error) { message(error.message); } }
function field(parent, title, value, type = 'text') { const label = el('label', title, parent); const input = el('input', undefined, label); input.type = type; if (type === 'checkbox') input.checked = Boolean(value); else input.value = value ?? ''; return input; }
function button(parent, label, action, secondary = false) { const node = el('button', label, parent); node.type = 'button'; if (secondary) node.className = 'secondary'; node.onclick = () => guarded(action); return node; }
async function enter() {
  state.me = await api('/api/auth/me'); state.csrf = state.me.csrf_token;
  $('identity').textContent = state.me.user.email;
  $('login').hidden = true; $('activation').hidden = true; $('workspace').hidden = false;
  $('supplier').replaceChildren();
  for (const item of state.me.memberships) { const option = el('option', item.supplier_id, $('supplier')); option.value = item.supplier_id; }
  await refresh();
}
async function refresh() {
  state.scopes = await api(`/api/suppliers/${encodeURIComponent($('supplier').value)}/options`);
  $('new-quote').hidden = role() === 'contractor'; $('admin-tools').hidden = role() !== 'admin';
  $('environment').textContent = 'Review every material, tax treatment, credit exception, and expiration before approval. Sample data is labeled inside each quote.';
  for (const select of [$('scope'), $('invite-scope')]) {
    select.replaceChildren(); state.scopes.forEach((item, index) => { const option = el('option', `${item.account_name} · ${item.branch_name}`, select); option.value = String(index); });
  }
  const quotes = await api(`/api/suppliers/${encodeURIComponent($('supplier').value)}/quotes`);
  $('quote-list').replaceChildren();
  for (const quote of quotes) { const b = button($('quote-list'), `${quote.account_id} · ${money(quote.total_cents)} · ${quote.state} · v${quote.revision}`, () => openQuote(quote.id)); b.className = 'quote-link'; }
  if (!quotes.length) el('p', 'No quotes available yet.', $('quote-list'));
}
async function openQuote(id) {
  state.quote = await api(`/api/quotes/${encodeURIComponent(id)}`);
  const q = state.quote, panel = $('detail'); panel.replaceChildren();
  const header = el('div', undefined, panel); header.className = 'toolbar'; el('h2', `${q.account_id} · revision ${q.revision}`, header); el('span', q.state.replaceAll('_', ' '), header).className = 'badge';
  if (q.draft?.quote.sample_data) el('p', 'Sample supplier data. This is not a purchasable or reserved order.', panel).className = 'notice';
  const lines = q.draft?.quote.lines ?? q.lines;
  const table = el('table', undefined, el('div', undefined, panel)); table.parentElement.className = 'table-scroll';
  const heading = el('tr', undefined, el('thead', undefined, table)); for (const title of ['Requested material', 'Qty / unit', 'Proposed item', 'Line amount']) el('th', title, heading);
  const tbody = el('tbody', undefined, table);
  for (const line of lines) { const row = el('tr', undefined, tbody); el('td', line.item, row); el('td', `${line.quantity} ${line.unit}`, row); el('td', line.allocations.map(item => `${item.sku}: ${item.description} × ${item.quantity}${item.substitute ? ' (substitute)' : ''}`).join('\n') || 'Unmatched', row); el('td', money(line.allocations.reduce((sum, item) => sum + item.line_total_cents, 0)), row); }
  el('h3', `Total: ${money(q.commercial?.total_cents ?? q.draft?.quote.total_cents)}`, panel);
  el('p', q.commercial ? `Tax ${money(q.commercial.tax_cents)} · fees ${money(q.commercial.fees_cents)} · valid until ${new Date(q.terms.valid_until).toLocaleString()}` : 'Tax treatment, fees, and expiration need rep review.', panel);
  if (role() === 'contractor') {
    if (q.state === 'sent') button(panel, 'Accept this exact revision', () => action('accept'));
    el('p', 'Acceptance records your agreement to this published revision. It does not reserve stock or confirm an order.', panel).className = 'muted'; return;
  }
  el('p', `Credit status: ${q.draft.quote.credit.status}. Final taxes and fees are rechecked against current credit before approval.`, panel);
  const catalog = await api(`/api/suppliers/${encodeURIComponent(q.supplier_id)}/catalog?account_id=${encodeURIComponent(q.account_id)}&branch_id=${encodeURIComponent(q.branch_id)}`);
  const taxPolicy = catalog.tax_policies.find(policy => policy.active === true);
  const questions = el('section', undefined, panel); el('h3', 'Review questions', questions);
  const resolutionInputs = [];
  for (const item of q.draft.unresolved_questions) { const saved = q.resolutions.find(resolution => resolution.question_id === item.question_id); const input = field(questions, item.question, saved?.resolution ?? ''); resolutionInputs.push({ question_id: item.question_id, input }); }
  const substitutionInputs = [];
  for (const line of lines) for (const part of line.allocations.filter(item => item.substitute)) {
    const saved = q.substitutions.find(item => item.line_id === line.line_id && item.sku === part.sku);
    const accepted = field(questions, `Accept proposed substitute ${part.sku} on line ${line.line_id}`, saved?.accepted ?? false, 'checkbox');
    const reason = field(questions, 'Substitution review reason', saved?.reason ?? ''); substitutionInputs.push({ line_id: line.line_id, sku: part.sku, accepted, reason });
  }
  const form = el('form', undefined, panel); el('h3', 'Commercial review', form);
  const grid = el('div', undefined, form); grid.className = 'grid';
  const tax = field(grid, 'Tax rate (%) — confirm the applicable rate', (q.terms?.tax_rate_bps ?? taxPolicy?.tax_rate_bps ?? 0) / 100, 'number'); tax.step = '0.01'; tax.min = '0'; tax.max = '100';
  const taxJurisdiction = field(grid, 'Tax jurisdiction (state / local area)', q.terms?.tax_jurisdiction ?? taxPolicy?.jurisdiction ?? '');
  const taxBasis = field(grid, 'Tax schedule, calculation source, or legal basis', q.terms?.tax_basis ?? taxPolicy?.source ?? '');
  const exemption = field(grid, 'Exemption reference (if applicable)', q.terms?.tax_exemption_reference ?? '');
  const valid = field(grid, 'Valid until', q.terms?.valid_until ? new Date(Date.parse(q.terms.valid_until) - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : new Date(Date.now() + 7 * 86400000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16), 'datetime-local');
  const taxDelivery = field(grid, 'Delivery is taxable', q.terms?.tax_on_delivery ?? false, 'checkbox');
  const confirmed = field(grid, 'I have checked tax treatment and fees', q.terms?.tax_confirmed ?? false, 'checkbox');
  const fees = [], feeSection = el('section', undefined, form); el('h3', 'Additional fees', feeSection);
  const addFee = value => {
    const row = el('div', undefined, feeSection); row.className = 'grid';
    const entry = { label: field(row, 'Fee name', value.label ?? ''), amount: field(row, 'Amount ($)', (value.amount_cents ?? 0) / 100, 'number'), taxable: field(row, 'This fee is taxable', value.taxable ?? false, 'checkbox'), removed: false };
    entry.amount.step = '0.01'; entry.amount.min = '0';
    button(row, 'Remove fee', async () => { entry.removed = true; row.remove(); }, true); fees.push(entry);
  };
  (q.terms?.fees ?? []).forEach(addFee); button(feeSection, 'Add a fee', async () => addFee({}), true);
  const reason = field(form, 'Reason for this revision', 'Reviewed commercial terms and questions.');
  const save = el('button', 'Save review as a new revision', form); save.disabled = ['accepted', 'order_requested', 'cancelled'].includes(q.state);
  form.onsubmit = event => { event.preventDefault(); void guarded(async () => {
    const body = { expected_revision: q.revision, reason: reason.value, terms: { tax_rate_bps: Math.round(Number(tax.value) * 100), tax_on_delivery: taxDelivery.checked, tax_confirmed: confirmed.checked, tax_jurisdiction: taxJurisdiction.value, tax_basis: taxBasis.value, tax_exemption_reference: exemption.value.trim() || null, fees: fees.filter(item => !item.removed).map(item => ({ label: item.label.value, amount_cents: Math.round(Number(item.amount.value) * 100), taxable: item.taxable.checked })), valid_until: new Date(valid.value).toISOString() }, resolutions: resolutionInputs.filter(item => item.input.value.trim()).map(item => ({ question_id: item.question_id, resolution: item.input.value })), substitutions: substitutionInputs.map(item => ({ line_id: item.line_id, sku: item.sku, accepted: item.accepted.checked, reason: item.reason.value })) };
    await api(`/api/quotes/${q.id}/revisions`, 'POST', body); await openQuote(q.id); await refresh();
  }); };
  const corrections = el('details', undefined, panel); el('summary', 'Correct materials or delivery', corrections);
  const materialRows = [], materialTable = el('table', undefined, corrections), materialHead = el('tr', undefined, el('thead', undefined, materialTable));
  ['Material description', 'Quantity', 'Unit', ''].forEach(title => el('th', title, materialHead)); const materialBody = el('tbody', undefined, materialTable);
  const suggestions = el('datalist', undefined, corrections); suggestions.id = `catalog-${q.id}`;
  catalog.items.forEach(item => { const option = el('option', undefined, suggestions); option.value = item.description; option.label = item.sku; });
  const addMaterial = line => {
    const row = el('tr', undefined, materialBody), item = el('input', undefined, el('td', undefined, row)); item.value = line.item ?? ''; item.setAttribute('list', suggestions.id);
    const quantity = el('input', undefined, el('td', undefined, row)); quantity.type = 'number'; quantity.min = '1'; quantity.step = '1'; quantity.value = line.quantity ?? 1;
    const unit = el('input', undefined, el('td', undefined, row)); unit.value = line.unit ?? 'each';
    const entry = { line_id: line.line_id ?? crypto.randomUUID(), item, quantity, unit, required_specs: line.required_specs, removed: false };
    button(el('td', undefined, row), 'Remove', async () => { entry.removed = true; row.remove(); }, true); materialRows.push(entry);
  };
  lines.forEach(addMaterial); button(corrections, 'Add a material', async () => addMaterial({}), true);
  const deliveryLabel = el('label', 'Delivery option', corrections), delivery = el('select', undefined, deliveryLabel); const pickup = el('option', 'Pickup', delivery); pickup.value = '';
  catalog.delivery_slots.forEach(slot => { const option = el('option', `${slot.label} · ${money(slot.fee_cents)}`, delivery); option.value = slot.id; });
  delivery.value = q.draft.quote.delivery?.id ?? ''; const zip = field(corrections, 'Job-site ZIP code (for delivery)', q.draft.quote.delivery?.zip ?? '');
  button(corrections, 'Reprice corrected materials', async () => {
    const revisedLines = materialRows.filter(item => !item.removed).map(item => ({ line_id: item.line_id, item: item.item.value, quantity: Number(item.quantity.value), unit: item.unit.value, ...(item.required_specs ? { required_specs: item.required_specs } : {}) }));
    await api(`/api/quotes/${q.id}/revisions`, 'POST', { expected_revision: q.revision, reason: 'Rep corrected materials or delivery; requires a fresh review.', lines: revisedLines, delivery: delivery.value ? { zip: zip.value, slot_id: delivery.value } : null, resolutions: [], substitutions: [] }); await openQuote(q.id); await refresh();
  });
  const evidence = el('details', undefined, panel); el('summary', 'Evidence and pending research', evidence);
  for (const item of q.draft.evidence) { el('p', item.data?.answer ?? `Research ${item.status}`, evidence); for (const source of item.data?.sources ?? []) { el('blockquote', source.quoted_text, evidence); const link = el('a', source.url, evidence); if (source.url.startsWith('https://')) { link.href = source.url; link.rel = 'noreferrer'; } } }
  for (const handoff of q.draft.supplier_result.handoffs) el('p', `Requested research: ${handoff.input.question}`, evidence);
  const actions = el('div', undefined, panel); actions.className = 'actions';
  if (q.state === 'draft') button(actions, 'Approve current revision', () => action('approve'));
  if (q.state === 'approved') button(actions, 'Publish to contractor portal', () => action('publish'));
  if (q.state === 'accepted') button(actions, 'Create order request', () => action('order'));
  if (['draft', 'approved', 'sent'].includes(q.state)) button(actions, 'Cancel quote', () => action('cancel'), true);
  if (['admin', 'credit_manager'].includes(role())) {
    const credit = el('details', undefined, panel); el('summary', 'Approve a credit exception for this revision', credit);
    const limit = field(credit, 'Maximum permitted overage ($)', 0, 'number'); const why = field(credit, 'Credit exception reason', '');
    button(credit, 'Record credit exception', async () => { await api(`/api/quotes/${q.id}/credit-exception`, 'POST', { expected_revision: q.revision, limit_cents: Math.round(Number(limit.value) * 100), reason: why.value }); await openQuote(q.id); });
    if (q.state === 'order_requested') {
      const order = el('details', undefined, panel); el('summary', 'Reconcile a supplier-confirmed order', order);
      const reference = field(order, 'External supplier order reference', ''), why = field(order, 'Reconciliation reason', '');
      button(order, 'Verify posting and confirm order', async () => { await api(`/api/quotes/${q.id}/reconcile-order`, 'POST', { expected_revision: q.revision, external_reference: reference.value, reason: why.value }); await openQuote(q.id); });
    }
  }
  if (role() === 'admin' && ['draft', 'approved'].includes(q.state)) {
    const taxReview = el('details', undefined, panel); el('summary', q.tax_approval ? 'Manual tax treatment approved for this revision' : 'Administrator review of manual tax treatment', taxReview);
    const why = field(taxReview, 'Basis for approving this tax treatment', '');
    button(taxReview, 'Approve manual tax treatment', async () => { await api(`/api/quotes/${q.id}/tax-approval`, 'POST', { expected_revision: q.revision, reason: why.value }); await openQuote(q.id); });
  }
  button(panel, 'View revision and approval history', async () => { const history = await api(`/api/quotes/${q.id}/history`); const block = el('section', undefined, panel); el('h3', 'Revision and approval history', block); for (const item of history.events) el('p', `${new Date(item.created_at).toLocaleString()} · ${item.action.replaceAll('_', ' ')}${item.revision ? ` · revision ${item.revision}` : ''} · ${item.details.reason ?? ''}`, block); block.scrollIntoView({ behavior: 'smooth' }); }, true);
}
async function action(action) { const q = state.quote; await api(`/api/quotes/${q.id}/actions/${action}`, 'POST', { expected_revision: q.revision, reason: `User confirmed ${action} for the displayed revision.` }); await openQuote(q.id); await refresh(); }
$('login-form').onsubmit = event => { event.preventDefault(); void guarded(async () => { await api('/api/auth/login', 'POST', { email: $('email').value, password: $('password').value }); $('password').value = ''; await enter(); }); };
$('activate-form').onsubmit = event => { event.preventDefault(); void guarded(async () => { const token = new URLSearchParams(location.hash.slice(1)).get('activate'); await api('/api/auth/activate', 'POST', { token, password: $('activate-password').value }); history.replaceState(null, '', '/'); await enter(); }); };
$('logout').onclick = () => guarded(async () => { await api('/api/auth/logout', 'POST', {}); location.reload(); });
$('refresh').onclick = () => guarded(refresh); $('supplier').onchange = () => guarded(refresh);
$('new-quote').onclick = () => { $('workspace').hidden = true; $('create').hidden = false; };
$('close-create').onclick = () => { $('workspace').hidden = false; $('create').hidden = true; };
$('list-file').onchange = () => guarded(async () => {
  const file = $('list-file').files[0]; if (!file) return;
  if (file.name.toLowerCase().endsWith('.pdf')) {
    if (file.size > 5000000) throw new Error('PDFs must be under 5 MB.');
    const encoded = await new Promise((accept, reject) => { const reader = new FileReader(); reader.onload = () => accept(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); });
    const result = await api('/api/lists/pdf', 'POST', { supplier_id: $('supplier').value, pdf_base64: encoded });
    $('materials').value = result.text; $('list-format').value = 'pdf_text';
    if (result.needs_human_review) { $('materials').value = ''; throw new Error(result.warnings.join(' ') + ' Transcribe/check the complete list before creating a quote.'); }
  } else { if (file.size > 100000) throw new Error('Text/CSV lists must be under 100,000 bytes.'); $('materials').value = await file.text(); $('list-format').value = file.name.toLowerCase().endsWith('.csv') ? 'csv' : 'text'; }
});
$('create-form').onsubmit = event => { event.preventDefault(); void guarded(async () => { const scope = state.scopes[Number($('scope').value)]; const quote = await api('/api/quotes/from-materials', 'POST', { supplier_id: $('supplier').value, account_id: scope.account_id, branch_id: scope.branch_id, text: $('materials').value, format: $('list-format').value, delivery: null, save_id: crypto.randomUUID() }); $('create').hidden = true; $('workspace').hidden = false; await refresh(); await openQuote(quote.id); }); };
$('invite-form').onsubmit = event => { event.preventDefault(); void guarded(async () => { const scope = state.scopes[Number($('invite-scope').value)]; const role = $('invite-role').value; const result = await api(`/api/suppliers/${$('supplier').value}/users`, 'POST', { email: $('invite-email').value, role, grants: role === 'admin' ? [] : [{ account_id: scope.account_id, branch_id: role === 'contractor' ? null : scope.branch_id }] }); $('invite-result').textContent = result.activation_url ? `Share this one-time activation link privately: ${result.activation_url}` : 'Access added. This person can use their existing sign-in.'; }); };
if (location.hash.startsWith('#activate=')) { $('login').hidden = true; $('activation').hidden = false; } else { try { await enter(); } catch { /* Signed out; show login without exposing an error. */ } }
