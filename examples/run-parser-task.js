import { readFile } from 'node:fs/promises';
import { runParserTask } from '../src/parser-interface.js';

const task = JSON.parse(await readFile(new URL('./parser-task.json', import.meta.url), 'utf8'));
console.log(JSON.stringify(await runParserTask(task), null, 2));
