import { readFile } from 'node:fs/promises';
import { runSupplierTask } from '../src/supplier-interface.js';

const task = JSON.parse(await readFile(new URL('./supplier-task.json', import.meta.url), 'utf8'));
console.log(JSON.stringify(await runSupplierTask(task, { live: process.argv.includes('--live') }), null, 2));
