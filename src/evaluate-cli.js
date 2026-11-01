import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { evaluateFile } from './evaluate.js';
import { loadSupplier } from './supplier-tools.js';

const args = process.argv.slice(2);
try {
  const path = args[0] || 'eval/fixtures/synthetic.jsonl';
  if (args.includes('--live') && existsSync('.env')) loadEnvFile('.env');
  const outputIndex = args.indexOf('--output');
  const rates = { input_usd_per_million: Number(process.env.EVAL_INPUT_USD_PER_MILLION ?? NaN), output_usd_per_million: Number(process.env.EVAL_OUTPUT_USD_PER_MILLION ?? NaN), search_usd_per_thousand: Number(process.env.EVAL_SEARCH_USD_PER_THOUSAND ?? NaN) };
  const supplierData = process.env.SUPPLIER_DATA_FILE ? JSON.parse(await (await import('node:fs/promises')).readFile(process.env.SUPPLIER_DATA_FILE, 'utf8')) : await loadSupplier();
  const result = await evaluateFile(path, { supplierData, live: args.includes('--live'), requireReviewed: args.includes('--require-reviewed'), output: outputIndex >= 0 ? args[outputIndex + 1] : 'output/evaluation.json', rates });
  console.log(JSON.stringify(result, null, 2)); if (!result.passed) process.exitCode = 1;
} catch { console.error('Evaluation failed. Check dataset format and configuration; no credential or contractor source data was printed.'); process.exitCode = 1; }
