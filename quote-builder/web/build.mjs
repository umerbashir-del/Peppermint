import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = dirname(fileURLToPath(import.meta.url));

export function backendOrigin(value) {
  if (!value?.trim()) throw new Error('Set QBC_PUBLIC_API_BASE_URL to the HTTPS backend origin.');
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('QBC_PUBLIC_API_BASE_URL must be an HTTPS origin without credentials, path, query, or fragment.');
  }
  return url.origin;
}

export async function buildFrontend({ apiBaseUrl = process.env.QBC_PUBLIC_API_BASE_URL, outputDirectory = join(source, 'dist') } = {}) {
  const origin = backendOrigin(apiBaseUrl);
  const staticDirectory = join(outputDirectory, 'static');
  await mkdir(staticDirectory, { recursive: true });
  const allowed = new Set(['app.js', 'app.css', 'config.js']);
  if ((await readdir(outputDirectory)).some(file => !['index.html', 'static'].includes(file))
      || (await readdir(staticDirectory)).some(file => !allowed.has(file))) {
    throw new Error('Unexpected files in frontend output. Use a clean output directory before publishing.');
  }
  // An explicit allowlist keeps source files, .env values, and build tools out of the public site.
  for (const file of ['app.js', 'app.css']) await writeFile(join(staticDirectory, file), await readFile(join(source, file)));
  const html = (await readFile(join(source, 'index.html'), 'utf8')).replace("connect-src 'self'", `connect-src 'self' ${origin}`);
  await writeFile(join(outputDirectory, 'index.html'), html);
  await writeFile(join(staticDirectory, 'config.js'), `window.QBC_CONFIG = Object.freeze(${JSON.stringify({ apiBaseUrl: origin })});\n`);
  return { outputDirectory, apiBaseUrl: origin };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildFrontend();
  console.log('Built the static frontend. No server secrets are included.');
}
