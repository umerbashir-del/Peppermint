import { readFile } from 'node:fs/promises';
import { quote } from './supplier-agent.js';
import { loadSupplier } from './supplier-tools.js';
import { research } from './research-agent.js';

try {
  const [command, ...args] = process.argv.slice(2);
  let result;
  if (command === 'demo') {
    const request = JSON.parse(await readFile(new URL('../examples/normal.json', import.meta.url), 'utf8'));
    result = await quote(request, await loadSupplier());
  } else if (command === 'quote') {
    if (!args[0]) throw new Error('Usage: npm run quote -- examples/normal.json [--live]');
    result = await quote(JSON.parse(await readFile(args[0], 'utf8')), await loadSupplier(), { live: args.includes('--live') });
  } else if (command === 'research') {
    result = await research(args.join(' '));
  } else throw new Error('Choose demo, quote, or research. See README.md.');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.name === 'TimeoutError' ? 'The request timed out. Please retry.' : error.message);
  process.exitCode = 1;
}
