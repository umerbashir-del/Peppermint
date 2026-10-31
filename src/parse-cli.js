import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parseMaterialsList } from './materials-parser.js';

try {
  const [file, format] = process.argv.slice(2);
  if (!file) throw new Error('Usage: npm run parse -- path/to/list.txt [text|csv|pdf_text]');
  if (extname(file).toLowerCase() === '.pdf') throw new Error('Extract the PDF text first, then pass its text file with pdf_text.');
  const text = await readFile(file, 'utf8');
  const result = parseMaterialsList({ text, format: format ?? (extname(file).toLowerCase() === '.csv' ? 'csv' : 'text') });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
