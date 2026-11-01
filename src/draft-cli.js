import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { saveDraftQuote, listDraftQuotes, readDraftQuote } from './draft-store.js';
import { renderDraftReview } from './draft-review.js';

try {
  const [command, value, option] = process.argv.slice(2);
  let result;
  if (command === 'save' && value) result = await saveDraftQuote(JSON.parse(await readFile(value, 'utf8')));
  else if (command === 'list') result = await listDraftQuotes();
  else if (command === 'show' && value) {
    result = await readDraftQuote(value);
    if (option === '--html') {
      const directory = new URL('../output/draft-reviews/', import.meta.url);
      await mkdir(directory, { recursive: true });
      const path = new URL(`${result.quote_id}.html`, directory);
      await writeFile(path, renderDraftReview(result), 'utf8');
      result = { quote_id: result.quote_id, review_file: fileURLToPath(path), status: 'draft' };
    }
  } else throw new Error('Usage: npm run draft -- save INPUT.json | list | show DRAFT_ID [--html]');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.code === 'ENOENT' ? 'Draft or input file not found.' : error.message);
  process.exitCode = 1;
}
