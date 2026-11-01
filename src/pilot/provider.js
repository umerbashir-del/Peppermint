import { readFile } from 'node:fs/promises';
import { loadSupplier } from '../supplier-tools.js';
import { insist } from './errors.js';

export function supplierProvider({ file = process.env.SUPPLIER_DATA_FILE, production = process.env.NODE_ENV === 'production', allowSample = process.env.ALLOW_SAMPLE_DATA === 'true', maxAgeSeconds = Number(process.env.SUPPLIER_MAX_AGE_SECONDS || 300) } = {}) {
  if (production && !file) throw new Error('Production requires a supplier data source file.');
  return async supplierId => {
    const data = file ? JSON.parse(await readFile(file, 'utf8')) : await loadSupplier();
    insist(supplierId === (data.supplier_id ?? 'pilot-supplier'), 404, 'NOT_FOUND', 'Supplier data source not found.');
    insist(!production || !data.sample_data || allowSample, 503, 'SAMPLE_DATA_DISABLED', 'Production sample data is disabled.');
    if (!data.sample_data) insist(Number.isFinite(Date.parse(data.as_of)) && Date.now() - Date.parse(data.as_of) <= maxAgeSeconds * 1000 && Date.parse(data.as_of) <= Date.now() + 10000, 503, 'STALE_SUPPLIER_DATA', 'Supplier data is stale; quotes cannot be committed.');
    return data;
  };
}
