import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { backendOrigin, buildFrontend } from '../quote-builder/web/build.mjs';

test('static build publishes only website assets and the backend origin with a restricted CSP', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'buildbridge-frontend-'));
  await buildFrontend({ apiBaseUrl: 'https://api.example.com/', outputDirectory });
  assert.deepEqual((await readdir(outputDirectory)).sort(), ['index.html', 'static']);
  assert.deepEqual((await readdir(join(outputDirectory, 'static'))).sort(), ['app.css', 'app.js', 'config.js', 'favicon.svg']);
  const context = { window: {} };
  const config = await readFile(join(outputDirectory, 'static/config.js'), 'utf8');
  runInNewContext(config, context);
  assert.equal(context.window.QBC_CONFIG.apiBaseUrl, 'https://api.example.com');
  assert.ok(Object.isFrozen(context.window.QBC_CONFIG));
  assert.doesNotMatch(config, /ANTHROPIC|SECRET|API_KEY|qbc_token/);
  const html = await readFile(join(outputDirectory, 'index.html'), 'utf8');
  assert.match(html, /connect-src 'self' https:\/\/api\.example\.com;/);
  assert.doesNotMatch(html, /unsafe-eval|unsafe-inline/);
  for (const match of html.matchAll(/(?:src|href)="(\/static\/[^"#]+)"/g)) await readFile(join(outputDirectory, match[1]));
  assert.ok(html.indexOf('/static/config.js') < html.indexOf('/static/app.js'));
});

test('a public deployment rejects missing, insecure, credential-bearing, and non-origin backend URLs', () => {
  for (const value of ['', undefined, 'http://api.example.com', 'https://user:pass@api.example.com', 'https://api.example.com/api', 'https://api.example.com?key=private', 'https://api.example.com/#secret', 'javascript:alert(1)']) {
    assert.throws(() => backendOrigin(value));
  }
  assert.equal(backendOrigin(' https://api.example.com/ '), 'https://api.example.com');
});

test('stale private files cannot be carried into a published frontend build', async () => {
  for (const path of ['.env', 'static/private.json']) {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'buildbridge-stale-'));
    await mkdir(join(outputDirectory, 'static'));
    await writeFile(join(outputDirectory, path), 'PRIVATE TEST DATA');
    await assert.rejects(buildFrontend({ apiBaseUrl: 'https://api.example.com', outputDirectory }), /Unexpected files/);
  }
});
