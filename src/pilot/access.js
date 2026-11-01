import { randomUUID } from 'node:crypto';
import { insist } from './errors.js';

export async function membership(db, actor, supplierId) {
  const { rows } = await db.query('SELECT role FROM memberships WHERE user_id=$1 AND supplier_id=$2', [actor.id, supplierId]);
  insist(rows.length, 404, 'NOT_FOUND', 'Resource not found.');
  return rows[0].role;
}
export async function authorize(db, actor, scope, { write = false, contractor = false, credit = false, admin = false } = {}) {
  const role = await membership(db, actor, scope.supplier_id);
  if (admin) insist(role === 'admin', 403, 'FORBIDDEN', 'Supplier administration permission is required.');
  if (write) insist(role !== 'contractor', 403, 'FORBIDDEN', 'Supplier staff permission is required.');
  if (contractor) insist(role === 'contractor', 403, 'FORBIDDEN', 'Contractor acceptance is required.');
  if (credit) insist(['admin', 'credit_manager'].includes(role), 403, 'FORBIDDEN', 'Credit manager permission is required.');
  if (role !== 'admin') {
    const { rows } = await db.query('SELECT 1 FROM access_grants WHERE user_id=$1 AND supplier_id=$2 AND account_id=$3 AND (branch_id=$4 OR ($5::boolean AND branch_id IS NULL))', [actor.id, scope.supplier_id, scope.account_id, scope.branch_id, role === 'contractor']);
    insist(rows.length, 404, 'NOT_FOUND', 'Resource not found.');
  }
  return role;
}
export async function event(db, actor, supplierId, quoteId, revision, action, details = {}) {
  await db.query('INSERT INTO quote_events(id,supplier_id,quote_id,revision,actor_id,action,details) VALUES($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), supplierId, quoteId, revision, actor?.id ?? null, action, JSON.stringify(details)]);
}
export async function visibleQuotes(db, actor, supplierId) {
  const role = await membership(db, actor, supplierId);
  const { rows } = await db.query(`SELECT q.* FROM quotes q WHERE q.supplier_id=$1 AND ($2='admin' OR EXISTS(SELECT 1 FROM access_grants g WHERE g.user_id=$3 AND g.supplier_id=q.supplier_id AND g.account_id=q.account_id AND (g.branch_id=q.branch_id OR ($2='contractor' AND g.branch_id IS NULL)))) AND ($2<>'contractor' OR q.published_revision IS NOT NULL) ORDER BY q.updated_at DESC LIMIT 200`, [supplierId, role, actor.id]);
  return rows;
}
