import { randomUUID, createHash } from 'node:crypto';
import { prepareDraftContent } from '../draft-store.js';
import { runSupplierTask } from '../supplier-interface.js';
import { authorize, visibleQuotes, membership, event } from './access.js';
import { insist, invalid, conflict } from './errors.js';
import { revisionSchema } from './schemas.js';
import { fingerprint } from './fingerprints.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const questionId = item => 'question-' + hash([item.source, item.question, item.line_ids]).slice(0, 24);
const stablePricing = quote => quote.lines.map(line => ({ line_id: line.line_id, quantity: line.quantity, item: line.item, unit: line.unit, unresolved_quantity: line.unresolved_quantity, allocations: line.allocations.map(({ sku, quantity, unit, line_total_cents, substitute }) => ({ sku, quantity, unit, line_total_cents, substitute })) }));
const fullPricing = quote => ({ lines: stablePricing(quote), delivery: quote.delivery, total_is_partial: quote.total_is_partial });
const specificationFingerprint = (data, quote) => {
  const skus = [...new Set(quote.lines.flatMap(line => line.allocations.map(item => item.sku)))].sort();
  return hash([skus.map(sku => { const item = data.catalog.find(item => item.sku === sku); return { sku, unit: item?.unit, specifications: item?.specifications ?? {}, allowed_substitutes: item?.allowed_substitutes ?? [] }; }), (data.substitution_rules ?? []).filter(rule => skus.includes(rule.requested_sku) || skus.includes(rule.substitute_sku))]);
};

function quoteRequest(quote) {
  return { account_id: quote.account_id, branch: quote.branch, delivery: quote.delivery ? { zip: quote.delivery.zip, slot_id: quote.delivery.id } : null, lines: quote.lines.map(({ line_id, item, quantity, unit, required_specs }) => ({ line_id, item, quantity, unit, ...(required_specs ? { required_specs } : {}) })) };
}
export function commercialTotals(draft, terms) {
  if (!terms) return null;
  const delivery = draft.quote.delivery?.fee_cents ?? 0;
  const fees = terms.fees.reduce((sum, fee) => sum + fee.amount_cents, 0);
  const taxable = draft.quote.subtotal_cents + (terms.tax_on_delivery ? delivery : 0) + terms.fees.filter(fee => fee.taxable).reduce((sum, fee) => sum + fee.amount_cents, 0);
  const tax = Math.round(taxable * terms.tax_rate_bps / 10000);
  const total = draft.quote.subtotal_cents + delivery + fees + tax;
  invalid(Number.isSafeInteger(total) && total <= 1000000000000, 'Commercial total is outside supported bounds.');
  return { subtotal_cents: draft.quote.subtotal_cents, delivery_fee_cents: delivery, fees_cents: fees, tax_cents: tax, total_cents: total, currency: 'USD' };
}

export class QuoteService {
  constructor(db, { supplierData, clock = () => Date.now() }) { this.db = db; this.supplierData = supplierData; this.clock = clock; }
  async reprice(supplierId, source, requestOverride) {
    const data = await this.supplierData(supplierId);
    const input = requestOverride ?? quoteRequest(source.data);
    const result = await runSupplierTask({ schema_version: '1.0', request_id: source.request_id, task_id: source.task_id, agent: 'supplier_quote_desk', input }, { supplierData: data });
    conflict(result.status !== 'failed', 'Supplier data could not produce a valid draft.');
    return { result, data };
  }
  async freshPayload(supplierId, input, previous = null, edits = {}, queryDb = this.db) {
    const parsed = prepareDraftContent(input);
    const { result, data } = await this.reprice(supplierId, parsed.snapshot.supplier_result, edits.request);
    const candidates = edits.research_results ?? parsed.snapshot.research_results ?? [];
    const research_results = [], invalidated_evidence = [];
    for (const evidence of candidates) {
      const handoff = result.handoffs.find(task => task.task_id === evidence.task_id);
      if (previous && edits.research_results === undefined && !handoff) { invalidated_evidence.push(evidence.task_id); continue; }
      if (evidence.status === 'completed') {
        invalid(handoff, 'Completed research must match a current specification handoff.');
        const stored = await queryDb.query('SELECT result FROM worker_results WHERE supplier_id=$1 AND branch_id=$2 AND account_id=$3 AND request_id=$4 AND task_id=$5 AND input_hash=$6', [supplierId, result.data.branch, result.data.account_id, result.request_id, evidence.task_id, fingerprint(handoff.input)]);
        invalid(stored.rows.some(row => fingerprint(row.result) === fingerprint(evidence)), 'Completed research must come from this server’s authorized worker result store.');
      }
      research_results.push(evidence);
    }
    const normalized = { ...parsed.snapshot, supplier_result: result, research_results, unresolved_questions: edits.unresolved_questions ?? parsed.snapshot.unresolved_questions ?? [] };
    const draft = prepareDraftContent(normalized).contents;
    draft.unresolved_questions = draft.unresolved_questions.map(item => ({ ...item, question_id: questionId(item) }));
    const terms = edits.terms ?? previous?.terms ?? null;
    if (terms) invalid(Date.parse(terms.valid_until) > this.clock() && Date.parse(terms.valid_until) <= this.clock() + 30 * 86400000, 'Quote expiration must be in the next 30 days.');
    const resolutions = edits.resolutions ?? previous?.resolutions ?? [];
    const questions = new Set(draft.unresolved_questions.map(item => item.question_id));
    invalid(resolutions.every(item => questions.has(item.question_id)), 'A resolution references a missing or changed question.');
    invalid(new Set(resolutions.map(item => item.question_id)).size === resolutions.length, 'Question resolutions must be unique.');
    const substitutions = edits.substitutions ?? previous?.substitutions ?? [];
    const keys = new Set(draft.quote.lines.flatMap(line => line.allocations.filter(item => item.substitute).map(item => `${line.line_id}:${item.sku}`)));
    invalid(substitutions.every(item => keys.has(`${item.line_id}:${item.sku}`)), 'A substitution decision references an unavailable candidate.');
    invalid(new Set(substitutions.map(item => `${item.line_id}:${item.sku}`)).size === substitutions.length, 'Substitution decisions must be unique.');
    return { source_input: normalized, draft, invalidated_evidence, supplier_spec_fingerprint: specificationFingerprint(data, draft.quote), tax_policy_fingerprint: fingerprint(data.tax_policies ?? []), terms, commercial: commercialTotals(draft, terms), resolutions, substitutions };
  }
  async create(actor, supplierId, input, { logicalHash } = {}) {
    const prepared = prepareDraftContent(input);
    const quote = prepared.contents.quote;
    await authorize(this.db, actor, { supplier_id: supplierId, branch_id: quote.branch, account_id: quote.account_id }, { write: true });
    return this.db.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [JSON.stringify([supplierId, prepared.contents.request_id])]);
      const bound = await tx.query('SELECT account_id,branch_id FROM quotes WHERE supplier_id=$1 AND request_id=$2', [supplierId, prepared.contents.request_id]);
      conflict(bound.rows.every(row => row.account_id === quote.account_id && row.branch_id === quote.branch), 'A request ID cannot be reused across accounts or branches.');
      const existing = await tx.query('SELECT * FROM quotes WHERE supplier_id=$1 AND request_id=$2 AND save_id=$3', [supplierId, prepared.contents.request_id, prepared.snapshot.save_id]);
      if (existing.rows.length) { conflict(existing.rows[0].input_hash === (logicalHash ?? prepared.content_hash), 'This save ID already contains different data.'); return this.load(actor, existing.rows[0].id, tx); }
      const payload = await this.freshPayload(supplierId, prepared.snapshot, null, {}, tx);
      const id = randomUUID();
      await tx.query("INSERT INTO quotes(id,supplier_id,branch_id,account_id,request_id,save_id,input_hash,state,current_revision,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'draft',1,$8)", [id, supplierId, quote.branch, quote.account_id, prepared.contents.request_id, prepared.snapshot.save_id, logicalHash ?? prepared.content_hash, actor.id]);
      await tx.query('INSERT INTO quote_revisions(quote_id,revision,payload,reason,created_by) VALUES($1,1,$2,$3,$4)', [id, JSON.stringify(payload), 'Initial supplier draft; server prices verified.', actor.id]);
      await event(tx, actor, supplierId, id, 1, 'draft_created', { request_id: prepared.contents.request_id });
      return this.load(actor, id, tx);
    });
  }
  async row(actor, quoteId, tx = this.db, options = {}) {
    const { rows } = await tx.query(`SELECT * FROM quotes WHERE id=$1${options.lock ? ' FOR UPDATE' : ''}`, [quoteId]);
    insist(rows.length, 404, 'NOT_FOUND', 'Resource not found.');
    const role = await authorize(tx, actor, rows[0], options);
    if (role === 'contractor') insist(rows[0].published_revision !== null, 404, 'NOT_FOUND', 'Resource not found.');
    return { row: rows[0], role };
  }
  async load(actor, quoteId, tx = this.db, revision = null) {
    const { row, role } = await this.row(actor, quoteId, tx);
    const selected = revision ?? (role === 'contractor' ? row.published_revision : row.current_revision);
    if (role === 'contractor') {
      const published = await tx.query("SELECT 1 FROM quote_events WHERE quote_id=$1 AND revision=$2 AND action='published'", [quoteId, selected]);
      insist(published.rows.length, 404, 'NOT_FOUND', 'Resource not found.');
    }
    const { rows } = await tx.query('SELECT * FROM quote_revisions WHERE quote_id=$1 AND revision=$2', [quoteId, selected]);
    insist(rows.length, 404, 'NOT_FOUND', 'Resource not found.');
    const payload = rows[0].payload;
    let state = row.state;
    if (role === 'contractor' && row.current_revision !== row.published_revision) state = 'revision_in_progress';
    if (['approved', 'sent'].includes(state) && payload.terms && Date.parse(payload.terms.valid_until) <= this.clock()) state = 'expired';
    const result = { id: row.id, supplier_id: row.supplier_id, account_id: row.account_id, branch_id: row.branch_id, revision: selected, current_revision: role === 'contractor' ? row.published_revision : row.current_revision, state, created_at: row.created_at, updated_at: row.updated_at, ...payload };
    if (role === 'contractor') {
      // Published customer views never expose internal account/credit or review evidence.
      return { id: result.id, supplier_id: result.supplier_id, account_id: result.account_id, branch_id: result.branch_id, revision: selected, state, terms: payload.terms, commercial: payload.commercial, lines: payload.draft.quote.lines.map(line => ({ line_id: line.line_id, item: line.item, quantity: line.quantity, unit: line.unit, allocations: line.allocations.map(({ sku, description, quantity, unit, line_total_cents, substitute }) => ({ sku, description, quantity, unit, line_total_cents, substitute })) })) };
    }
    const exception = await tx.query('SELECT * FROM credit_exceptions WHERE quote_id=$1 AND revision=$2', [quoteId, selected]);
    const tax = await tx.query('SELECT * FROM tax_approvals WHERE quote_id=$1 AND revision=$2', [quoteId, selected]);
    return { ...result, credit_exception: exception.rows[0] ?? null, tax_approval: tax.rows[0] ?? null };
  }
  async list(actor, supplierId) {
    const rows = await visibleQuotes(this.db, actor, supplierId);
    const results = [];
    for (const row of rows) { const quote = await this.load(actor, row.id); results.push({ id: quote.id, revision: quote.revision, state: quote.state, account_id: quote.account_id, branch_id: quote.branch_id, total_cents: quote.commercial?.total_cents ?? quote.draft?.quote.total_cents ?? null }); }
    return results;
  }
  async revise(actor, quoteId, edits) {
    edits = revisionSchema.parse(edits);
    return this.db.transaction(async tx => {
      const { row } = await this.row(actor, quoteId, tx, { write: true, lock: true });
      conflict(row.current_revision === edits.expected_revision, 'A newer revision exists. Refresh before editing.');
      conflict(['draft', 'approved', 'sent'].includes(row.state), 'Accepted, ordered, or cancelled quotes cannot be edited.');
      const { rows } = await tx.query('SELECT payload FROM quote_revisions WHERE quote_id=$1 AND revision=$2', [quoteId, row.current_revision]);
      const previous = rows[0].payload;
      const request = quoteRequest(previous.draft.quote);
      if (edits.lines) request.lines = edits.lines;
      if (Object.hasOwn(edits, 'delivery')) request.delivery = edits.delivery;
      const payload = await this.freshPayload(row.supplier_id, previous.source_input, previous, { ...edits, request }, tx);
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [JSON.stringify(['credit', row.supplier_id, row.account_id])]);
      await tx.query('DELETE FROM credit_reservations WHERE quote_id=$1', [quoteId]);
      const revision = row.current_revision + 1;
      await tx.query('INSERT INTO quote_revisions(quote_id,revision,payload,reason,created_by) VALUES($1,$2,$3,$4,$5)', [quoteId, revision, JSON.stringify(payload), edits.reason, actor.id]);
      await tx.query("UPDATE quotes SET current_revision=$1,approved_revision=NULL,state='draft',updated_at=now() WHERE id=$2", [revision, quoteId]);
      await event(tx, actor, row.supplier_id, quoteId, revision, 'revised', { reason: edits.reason, previous_revision: row.current_revision });
      return this.load(actor, quoteId, tx);
    });
  }
  async approvalChecks(tx, row, payload) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [JSON.stringify(['credit', row.supplier_id, row.account_id])]);
    conflict(payload.terms?.tax_confirmed && payload.commercial, 'Confirm tax treatment, fees, and expiration before approval.');
    conflict(Date.parse(payload.terms.valid_until) > this.clock(), 'Quote has expired. Create a fresh revision.');
    conflict(payload.draft.quote.lines.every(line => line.unresolved_quantity === 0), 'Resolve unavailable or unmatched quantities before approval.');
    conflict(payload.draft.unresolved_questions.every(question => payload.resolutions.some(item => item.question_id === question.question_id)), 'Resolve every review question before approval.');
    conflict(payload.draft.quote.lines.every(line => line.allocations.filter(item => item.substitute).every(item => payload.substitutions.some(decision => decision.line_id === line.line_id && decision.sku === item.sku && decision.accepted))), 'Review and accept each proposed substitution before approval.');
    const fresh = await this.reprice(row.supplier_id, payload.draft.supplier_result);
    for (const evidence of payload.draft.evidence.filter(result => result.status === 'completed')) {
      const handoff = fresh.result.handoffs.find(task => task.task_id === evidence.task_id);
      conflict(handoff, 'Existing research no longer matches current requirements. Create a fresh revision.');
      const stored = await tx.query('SELECT result FROM worker_results WHERE supplier_id=$1 AND branch_id=$2 AND account_id=$3 AND request_id=$4 AND task_id=$5 AND input_hash=$6', [row.supplier_id, row.branch_id, row.account_id, row.request_id, evidence.task_id, fingerprint(handoff.input)]);
      conflict(stored.rows.some(result => fingerprint(result.result) === fingerprint(evidence)), 'Existing research lacks server provenance. Run and attach fresh research before approval.');
    }
    conflict(specificationFingerprint(fresh.data, fresh.result.data) === payload.supplier_spec_fingerprint, 'Product specifications or supplier rules changed. Create and review a fresh revision.');
    conflict(fingerprint(fullPricing(fresh.result.data)) === fingerprint(fullPricing(payload.draft.quote)), 'Catalog prices, delivery fees/slots, availability, or substitutions changed. Create and review a fresh revision.');
    conflict(fingerprint(fresh.data.tax_policies ?? []) === payload.tax_policy_fingerprint, 'Supplier tax policy changed; review a fresh revision.');
    const policies = (fresh.data.tax_policies ?? []).filter(policy => policy.active === true && policy.approved_by && policy.jurisdiction === payload.terms.tax_jurisdiction && policy.tax_rate_bps === payload.terms.tax_rate_bps && policy.tax_on_delivery === payload.terms.tax_on_delivery);
    const taxApproval = await tx.query('SELECT 1 FROM tax_approvals WHERE quote_id=$1 AND revision=$2', [row.id, row.current_revision]);
    conflict(policies.length === 1 || taxApproval.rows.length > 0, 'An administrator must approve manual tax treatment for this revision when no documented supplier policy matches.');
    const account = fresh.data.accounts.find(account => account.id === row.account_id);
    conflict(account && Number.isSafeInteger(account.credit_limit_cents) && Number.isSafeInteger(account.open_balance_cents), 'Fresh credit data is required.');
    const pending = await tx.query("SELECT COALESCE(sum(r.total_cents),0) AS total FROM credit_reservations r JOIN quotes q ON q.id=r.quote_id WHERE r.supplier_id=$1 AND r.account_id=$2 AND r.quote_id<>$3 AND (r.valid_until>$4::timestamptz OR q.state IN ('accepted','order_requested'))", [row.supplier_id, row.account_id, row.id, new Date(this.clock()).toISOString()]);
    const overage = Math.max(0, account.open_balance_cents + Number(pending.rows[0].total) + payload.commercial.total_cents - account.credit_limit_cents);
    const exceptions = await tx.query('SELECT limit_cents FROM credit_exceptions WHERE quote_id=$1 AND revision=$2', [row.id, row.current_revision]);
    conflict(overage === 0 || Number(exceptions.rows[0]?.limit_cents ?? -1) >= overage, 'A credit manager must approve this revision’s credit overage.');
    await tx.query('INSERT INTO credit_reservations(quote_id,supplier_id,account_id,revision,total_cents,valid_until) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(quote_id) DO UPDATE SET revision=EXCLUDED.revision,total_cents=EXCLUDED.total_cents,valid_until=EXCLUDED.valid_until', [row.id, row.supplier_id, row.account_id, row.current_revision, payload.commercial.total_cents, payload.terms.valid_until]);
  }
  async transition(actor, quoteId, action, { expected_revision, reason }) {
    return this.db.transaction(async tx => {
      const { row } = await this.row(actor, quoteId, tx, { lock: true, ...(action === 'accept' ? { contractor: true } : { write: true }) });
      conflict(row.current_revision === expected_revision, 'A newer revision exists. Refresh before taking action.');
      const { rows } = await tx.query('SELECT payload FROM quote_revisions WHERE quote_id=$1 AND revision=$2', [quoteId, row.current_revision]);
      const payload = rows[0].payload;
      const states = { approve: ['draft', 'approved'], publish: ['approved', 'sent'], accept: ['sent', 'accepted'], order: ['accepted', 'order_requested'], cancel: ['draft', 'approved', 'sent'] };
      invalid(Object.hasOwn(states, action), 'Unknown action.');
      conflict(states[action].includes(row.state), 'Action is not valid for this quote state.');
      if (!['cancel', 'order'].includes(action)) await this.approvalChecks(tx, row, payload);
      if (action === 'cancel') {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [JSON.stringify(['credit', row.supplier_id, row.account_id])]);
        await tx.query('DELETE FROM credit_reservations WHERE quote_id=$1', [row.id]);
      }
      if (['publish', 'accept', 'order'].includes(action)) conflict(row.approved_revision === row.current_revision, 'The current revision needs rep approval.');
      if (action === 'accept') conflict(row.published_revision === row.current_revision, 'The current revision has not been published.');
      if (action === 'order') {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [JSON.stringify(['credit', row.supplier_id, row.account_id])]);
        const reservation = await tx.query('SELECT 1 FROM credit_reservations WHERE quote_id=$1 AND revision=$2 AND total_cents=$3', [quoteId, row.current_revision, payload.commercial.total_cents]);
        conflict(reservation.rows.length, 'A matching accepted-quote credit reservation is required before requesting an order.');
      }
      const next = { approve: 'approved', publish: 'sent', accept: 'accepted', order: 'order_requested', cancel: 'cancelled' }[action];
      if (row.state !== next) {
        await tx.query('UPDATE quotes SET state=$1,approved_revision=$2,published_revision=$3,updated_at=now() WHERE id=$4', [next, action === 'approve' ? row.current_revision : row.approved_revision, action === 'publish' ? row.current_revision : row.published_revision, quoteId]);
        await event(tx, actor, row.supplier_id, quoteId, row.current_revision, { approve: 'approved', publish: 'published', accept: 'accepted', order: 'order_requested', cancel: 'cancelled' }[action], { reason });
      }
      if (action === 'order') await tx.query("INSERT INTO order_requests(id,quote_id,revision,status,created_by) VALUES($1,$2,$3,'pending_external_confirmation',$4) ON CONFLICT(quote_id) DO NOTHING", [randomUUID(), quoteId, row.current_revision, actor.id]);
      return this.load(actor, quoteId, tx);
    });
  }
  async creditException(actor, quoteId, input) {
    return this.db.transaction(async tx => {
      const { row } = await this.row(actor, quoteId, tx, { credit: true, write: true, lock: true });
      conflict(row.current_revision === input.expected_revision && ['draft', 'approved'].includes(row.state), 'Credit exceptions require the current unsent revision.');
      await tx.query('INSERT INTO credit_exceptions(quote_id,revision,limit_cents,reason,approved_by) VALUES($1,$2,$3,$4,$5)', [quoteId, row.current_revision, input.limit_cents, input.reason, actor.id]);
      await event(tx, actor, row.supplier_id, quoteId, row.current_revision, 'credit_exception', { reason: input.reason, limit_cents: input.limit_cents });
      return this.load(actor, quoteId, tx);
    });
  }
  async approveTax(actor, quoteId, input) {
    return this.db.transaction(async tx => {
      const { row } = await this.row(actor, quoteId, tx, { admin: true, write: true, lock: true });
      conflict(row.current_revision === input.expected_revision && ['draft','approved'].includes(row.state), 'Manual tax approval must target the current unsent revision.');
      const { rows } = await tx.query('SELECT payload FROM quote_revisions WHERE quote_id=$1 AND revision=$2', [quoteId, row.current_revision]);
      conflict(rows[0].payload.terms?.tax_confirmed, 'Enter and confirm tax jurisdiction, basis, and treatment first.');
      const saved = await tx.query('INSERT INTO tax_approvals(quote_id,revision,reason,approved_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING quote_id', [quoteId, row.current_revision, input.reason, actor.id]);
      if (saved.rows.length) await event(tx, actor, row.supplier_id, quoteId, row.current_revision, 'manual_tax_approved', { reason: input.reason });
      return this.load(actor, quoteId, tx);
    });
  }
  async reconcileOrder(actor, quoteId, input) {
    return this.db.transaction(async tx => {
      const { row } = await this.row(actor, quoteId, tx, { credit: true, write: true, lock: true });
      conflict(row.current_revision === input.expected_revision && row.state === 'order_requested', 'Only a pending current order request can be reconciled.');
      const { rows } = await tx.query('SELECT payload FROM quote_revisions WHERE quote_id=$1 AND revision=$2', [quoteId, row.current_revision]);
      const source = await this.supplierData(row.supplier_id);
      const posted = (source.posted_orders ?? []).find(order => order.external_reference === input.external_reference && order.quote_id === quoteId && order.revision === row.current_revision && order.account_id === row.account_id && order.total_cents === rows[0].payload.commercial.total_cents && order.posted_to_balance === true);
      conflict(posted, 'Supplier data must confirm this exact order was posted to the account balance before releasing exposure.');
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [JSON.stringify(['credit', row.supplier_id, row.account_id])]);
      await tx.query("UPDATE order_requests SET status='confirmed',external_reference=$1 WHERE quote_id=$2", [input.external_reference, quoteId]);
      await tx.query("UPDATE quotes SET state='ordered',updated_at=now() WHERE id=$1", [quoteId]);
      await tx.query('DELETE FROM credit_reservations WHERE quote_id=$1', [quoteId]);
      await event(tx, actor, row.supplier_id, quoteId, row.current_revision, 'order_confirmed', { reason: input.reason, external_reference: input.external_reference });
      return this.load(actor, quoteId, tx);
    });
  }
  async history(actor, quoteId) {
    await this.row(actor, quoteId, this.db, { write: true });
    const revisions = await this.db.query('SELECT revision,reason,created_by,created_at FROM quote_revisions WHERE quote_id=$1 ORDER BY revision', [quoteId]);
    const events = await this.db.query('SELECT * FROM quote_events WHERE quote_id=$1 ORDER BY created_at,id', [quoteId]);
    return { revisions: revisions.rows, events: events.rows };
  }
}
