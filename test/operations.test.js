import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { encryptArchive, decryptArchive, pgEnvironment } from '../ops/archive.js';
import { extractPdf } from '../src/pilot/pdf.js';

async function temp(t) {
  const path = await mkdtemp(join(tmpdir(), 'buildbridge-ops-test-'));
  t.after(async () => { assert.equal(dirname(resolve(path)), resolve(tmpdir())); assert.ok(basename(path).startsWith('buildbridge-ops-test-')); await rm(path, { recursive: true, force: true }); });
  return path;
}
test('backups encrypt and authenticate data before restoring it', async t => {
  const dir = await temp(t), key = Buffer.alloc(32, 7).toString('base64');
  const encrypted = join(dir, 'backup.enc'), restored = join(dir, 'verified.dump');
  await encryptArchive(Readable.from(['private quote information']), encrypted, key);
  assert.doesNotMatch((await readFile(encrypted)).toString(), /private quote/);
  await decryptArchive(encrypted, restored, key);
  assert.equal(await readFile(restored, 'utf8'), 'private quote information');
  const damaged = await readFile(encrypted); damaged[20] ^= 1;
  await writeFile(join(dir, 'damaged.enc'), damaged);
  await assert.rejects(() => decryptArchive(join(dir, 'damaged.enc'), join(dir, 'bad.dump'), key), /authentication failed/);
  await assert.rejects(() => readFile(join(dir, 'bad.dump')), { code: 'ENOENT' });
});
test('PostgreSQL credentials stay in the child environment rather than process arguments', () => {
  const env = pgEnvironment('postgres://operator:secret-test-password@localhost:5432/pilot');
  assert.equal(env.PGUSER, 'operator'); assert.equal(env.PGPASSWORD, 'secret-test-password'); assert.equal(env.PGDATABASE, 'pilot');
});
function pdf(text = '20 of 2x4x8 SPF studs') {
  const stream = text ? `BT /F1 12 Tf 20 100 Td (${text}) Tj ET` : '';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let source = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object,index) => { offsets.push(Buffer.byteLength(source)); source += `${index+1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(source);
  source += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer << /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(source).toString('base64');
}
test('PDF lists are extracted in an isolated bounded worker', async () => {
  const result = await extractPdf(pdf());
  assert.match(result.text, /20 of 2x4x8 SPF studs/);
  assert.equal(result.needs_human_review, false); assert.equal(result.page_count, 1);
});
test('PDF pages without text are flagged instead of silently omitted', async () => {
  const result = await extractPdf(pdf(''));
  assert.equal(result.needs_human_review, true); assert.deepEqual(result.empty_pages, [1]);
});
test('invalid PDF uploads and deadlines fail safely', async () => {
  await assert.rejects(() => extractPdf(Buffer.from('not a PDF').toString('base64')), /not a supported PDF/);
  await assert.rejects(() => extractPdf(pdf(), { timeoutMs: 1 }), error => ['PDF_TIMEOUT','PDF_UNREADABLE'].includes(error.code));
});
