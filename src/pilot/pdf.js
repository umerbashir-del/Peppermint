import { Worker } from 'node:worker_threads';
import { invalid, AppError } from './errors.js';

export async function extractPdf(base64, { timeoutMs = 15000 } = {}) {
  invalid(typeof base64 === 'string' && base64.length <= 6700000 && base64.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(base64), 'Provide a base64-encoded PDF of at most 5 MB.');
  const bytes = Buffer.from(base64, 'base64');
  invalid(bytes.length <= 5000000 && bytes.subarray(0, 1024).includes(Buffer.from('%PDF-')), 'Input is not a supported PDF.');
  return new Promise((accept, reject) => {
    const worker = new Worker(new URL('./pdf-worker.js', import.meta.url), { workerData: { bytes: new Uint8Array(bytes) }, resourceLimits: { maxOldGenerationSizeMb: 128 } });
    const timer = setTimeout(() => { void worker.terminate(); reject(new AppError(422, 'PDF_TIMEOUT', 'PDF reading timed out; use a smaller text-based document.')); }, timeoutMs);
    const finish = () => { clearTimeout(timer); void worker.terminate(); };
    worker.once('message', result => { finish(); if (result.error) reject(new AppError(422, 'PDF_UNREADABLE', result.error)); else accept({ ...result, format: 'pdf_text', needs_human_review: result.empty_pages.length > 0, warnings: result.empty_pages.length ? ['Some pages have no readable text and may require OCR or manual transcription. No material lines should be assumed complete.'] : [] }); });
    worker.once('error', () => { finish(); reject(new AppError(422, 'PDF_UNREADABLE', 'PDF could not be safely read.')); });
    worker.once('exit', code => { if (code !== 0) { clearTimeout(timer); reject(new AppError(422, 'PDF_UNREADABLE', 'PDF reader stopped before completion.')); } });
  });
}
