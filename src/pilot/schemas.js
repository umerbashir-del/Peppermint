import { z } from 'zod';

const id = z.string().trim().min(1).max(128);
export const lineSchema = z.strictObject({ line_id: id, item: z.string().trim().min(1).max(2000), quantity: z.number().int().min(1).max(100000), unit: z.string().trim().min(1).max(50), required_specs: z.record(z.string(), z.string().trim().min(1).max(1000)).optional() });
export const deliverySchema = z.strictObject({ zip: z.string().regex(/^\d{5}(?:-\d{4})?$/), slot_id: id }).nullable();
export const termsSchema = z.strictObject({
  tax_rate_bps: z.number().int().min(0).max(10000), tax_on_delivery: z.boolean(), tax_confirmed: z.boolean(),
  tax_jurisdiction: z.string().trim().min(2).max(200), tax_basis: z.string().trim().min(5).max(1000), tax_exemption_reference: z.string().trim().min(2).max(1000).nullable(),
  fees: z.array(z.strictObject({ label: z.string().trim().min(1).max(100), amount_cents: z.number().int().min(0).max(100000000), taxable: z.boolean() })).max(20),
  valid_until: z.iso.datetime(),
});
export const revisionSchema = z.strictObject({
  expected_revision: z.number().int().min(1), reason: z.string().trim().min(5).max(2000),
  lines: z.array(lineSchema).min(1).max(100).optional(), delivery: deliverySchema.optional(), terms: termsSchema.optional(),
  research_results: z.array(z.unknown()).max(100).optional(),
  unresolved_questions: z.array(z.strictObject({ question: z.string().trim().min(1).max(3000), line_ids: z.array(id).max(100) })).max(100).optional(),
  resolutions: z.array(z.strictObject({ question_id: id, resolution: z.string().trim().min(5).max(3000) })).max(300).optional(),
  substitutions: z.array(z.strictObject({ line_id: id, sku: id, accepted: z.boolean(), reason: z.string().trim().min(5).max(2000) })).max(100).optional(),
});
export const actionSchema = z.strictObject({ expected_revision: z.number().int().min(1), reason: z.string().trim().min(5).max(2000) });
export const creditSchema = actionSchema.extend({ limit_cents: z.number().int().min(1).max(1000000000) });
export const createQuoteSchema = z.strictObject({ supplier_id: id, draft_input: z.unknown() });
export const grantSchema = z.strictObject({ account_id: id, branch_id: id.nullable() });
export const inviteSchema = z.strictObject({ email: z.email().max(254), role: z.enum(['admin', 'staff', 'credit_manager', 'contractor']), grants: z.array(grantSchema).max(100) });
