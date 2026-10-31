import { readFile } from 'node:fs/promises';
import { validateSubstitution } from './substitution-validator.js';

export async function loadSupplier() {
  return JSON.parse(await readFile(new URL('../data/supplier.json', import.meta.url), 'utf8'));
}

export const normalize = text => String(text).toLowerCase().replace(/\s+/g, ' ').trim();

export function supplierTools(data, request, { remainingStock } = {}) {
  const meta = { source: 'sample supplier dataset', as_of: data.as_of };
  return {
    validate_substitution(args) {
      return validateSubstitution(data, request, args, { remainingStock });
    },
    search_catalog({ query }) {
      const words = normalize(query).split(' ');
      return { ...meta, items: data.catalog.filter(item => words.every(word => normalize(item.description).includes(word))) };
    },
    get_account_pricing_and_credit() {
      const account = data.accounts.find(account => account.id === request.account_id);
      if (!account) throw new Error('Account pricing and credit unavailable.');
      return { ...meta, ...account };
    },
    check_delivery_slots() {
      return { ...meta, slots: data.delivery_slots.filter(slot => slot.branch === request.branch && slot.zip === request.delivery?.zip) };
    },
  };
}
