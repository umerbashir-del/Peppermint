import { parentPort, workerData } from 'node:worker_threads';
try {
  const { DOMMatrix, ImageData, Path2D } = await import('@napi-rs/canvas');
  Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: workerData.bytes, isEvalSupported: false, useSystemFonts: false, disableFontFace: true, useWorkerFetch: false, verbosity: 0 });
  const pdf = await task.promise;
  if (pdf.numPages > 40) throw new Error('PDF exceeds 40 pages.');
  const pages = [], empty_pages = [];
  let length = 0;
  for (let index = 1; index <= pdf.numPages; index++) {
    const page = await pdf.getPage(index);
    const content = await page.getTextContent();
    const text = content.items.map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('').trim();
    length += text.length;
    if (length > 100000) throw new Error('Extracted PDF text exceeds 100000 characters.');
    if (!text) empty_pages.push(index);
    pages.push(text); page.cleanup();
  }
  await task.destroy();
  parentPort.postMessage({ text: pages.join('\n'), page_count: pages.length, empty_pages });
} catch { parentPort.postMessage({ error: 'PDF could not be safely read. Use an unencrypted, text-based PDF of at most 40 pages.' }); }
