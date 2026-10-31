import { readFile } from 'node:fs/promises';
import { runResearchTask } from '../src/research-interface.js';
import { mockResearchOptions } from './research-fixture.js';

const task = JSON.parse(await readFile(new URL('./research-task.json', import.meta.url), 'utf8'));
// Default is mocked and free. --live uses your API key and public sources.
console.log(JSON.stringify(await runResearchTask(task, process.argv.includes('--live') ? {} : mockResearchOptions()), null, 2));
