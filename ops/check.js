import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) result.push(...await files(path)); else if (entry.name.endsWith('.js')) result.push(path); }
  return result;
}
for (const directory of ['src', 'web', 'ops']) for (const path of await files(directory)) execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
for (const path of tracked) {
  if (path === '.env' || path.startsWith('output/') || path.startsWith('node_modules/')) throw new Error('Private runtime data is tracked by Git.');
  let text;
  try { text = await readFile(path, 'utf8'); } catch { continue; }
  if (/sk-ant-(?:usr|api\d*)-[A-Za-z0-9_-]{32,}/.test(text)) throw new Error(`A credential-like value is present in ${path}.`);
}
console.log('JavaScript syntax and tracked-secret checks passed.');
