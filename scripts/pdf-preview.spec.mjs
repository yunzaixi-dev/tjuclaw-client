import { expect, test } from '@playwright/test';
import { createServer } from 'vite';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createEdgeoneConfig } from './edgeone-config.mjs';

// A real two-page PDF: the parser and canvas renderer must process its bytes.
function pdfBytes(cjk = false) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 6 0 R >>',
    ...['0 0 0 rg 20 20 200 300 re f BT /F1 16 Tf 30 350 Td (PDF preview) Tj ET', '0 0 1 rg 40 40 160 240 re f'].map(stream =>
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`),
    cjk
      ? '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [8 0 R] >>'
      : '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...(cjk ? ['<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>'] : []),
  ];
  if (cjk) {
    const stream = 'BT /F1 24 Tf 30 300 Td <4E2D65878BFE7A0B> Tj ET';
    objects[4] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  }
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(pdf);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

let server;
const id = 'a'.repeat(32);
const csp = createEdgeoneConfig().headers[0].headers[0].value;
test.beforeAll(async () => {
  server = await createServer({
    server: { host: '127.0.0.1', port: 1437, strictPort: true, hmr: false },
    plugins: [{
      name: 'pdf-preview-test',
      resolveId(id) { if (id === '/__pdf_test.mjs') return '\0pdf-preview-test'; },
      load(id) {
        if (id === '\0pdf-preview-test') return `import React from 'react';
          import {createRoot} from 'react-dom/client';
          import {FilePreview} from '/src/components/file-preview.tsx';
          createRoot(document.getElementById('root')).render(React.createElement(FilePreview,{
            entry:{id:'${'a'.repeat(32)}',title:'课程资料.pdf',content_type:'application/pdf'},
            renameRequest:0,onRename:()=>{}}));`;
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== '/__pdf_test') return next();
          res.setHeader('Content-Type', 'text/html');
          res.setHeader('Content-Security-Policy', csp);
          res.end(await server.transformIndexHtml('/__pdf_test', '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/__pdf_test.mjs"></script>'));
        });
      },
    }],
  });
  await server.listen();
});
test.afterAll(async () => { await server?.close(); });

test('valid PDF paints real pages on a phone under the production CSP without a PDF plugin', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const violations = [];
  const failures = [];
  const requests = [];
  page.on('request', request => requests.push(request.url()));
  page.on('pageerror', error => failures.push(error.message));
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', event => {
    window.__pdfViolations ??= [];
    window.__pdfViolations.push(event.violatedDirective);
  }));
  await page.route(`**/api/entries/${id}/file`, route => route.fulfill({ contentType: 'application/pdf', body: pdfBytes() }));
  await page.goto('http://127.0.0.1:1437/__pdf_test');
  const canvas = page.getByRole('img', { name: 'PDF 第 1 页，共 2 页' });
  await expect(canvas).toHaveAttribute('data-rendered', 'true');
  expect(await canvas.evaluate(canvas => Array.from(canvas.getContext('2d').getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data))).toEqual([0, 0, 0, 255]);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  const next = page.getByRole('img', { name: 'PDF 第 2 页，共 2 页' });
  await expect(next).toHaveAttribute('data-rendered', 'true');
  expect(await next.evaluate(canvas => Array.from(canvas.getContext('2d').getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data))).toEqual([0, 0, 255, 255]);
  await expect(page.locator('iframe, object, embed')).toHaveCount(0);
  violations.push(...await page.evaluate(() => window.__pdfViolations ?? []));
  expect(violations).toEqual([]);
  expect(failures).toEqual([]);
  expect(requests.every(url => new URL(url).origin === 'http://127.0.0.1:1437')).toBe(true);
  expect(requests.some(url => /LiberationSans-Regular.*\.ttf/.test(url))).toBe(true);
  // Resizing and quick page changes cancel stale paint work, not the document.
  await page.setViewportSize({ width: 360, height: 800 });
  await page.getByRole('button', { name: '上一页', exact: true }).click();
  await expect(canvas).toHaveAttribute('data-rendered', 'true');
  await expect(page.getByRole('button', { name: '上一页', exact: true })).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath('mobile-pdf.png') });
  await page.goto('about:blank');
  expect(failures).toEqual([]);
});

for (const scenario of ['html', 'invalid-pdf', 'denied', 'unauthorized']) {
  test(`PDF preview fails closed for ${scenario}`, async ({ page }) => {
    await page.route(`**/api/entries/${id}/file`, route => route.fulfill({
      status: scenario === 'denied' ? 404 : scenario === 'unauthorized' ? 401 : 200,
      contentType: 'application/pdf', body: scenario === 'invalid-pdf' ? '%PDF-not-a-document' : '<html>not a PDF</html>',
    }));
    await page.goto('http://127.0.0.1:1437/__pdf_test');
    await expect(page.getByRole('alert')).toContainText('预览暂不可用');
    await expect(page.locator('iframe, object, embed')).toHaveCount(0);
    await expect(page.locator('canvas[data-rendered="true"]')).toHaveCount(0);
  });
}

test('Chinese PDFs load the local CMap instead of a CDN or a PDF plugin', async ({ page }) => {
  const requests = [];
  page.on('request', request => requests.push(request.url()));
  await page.route(`**/api/entries/${id}/file`, route => route.fulfill({ contentType: 'application/pdf', body: pdfBytes(true) }));
  await page.goto('http://127.0.0.1:1437/__pdf_test');
  const canvas = page.getByRole('img', { name: 'PDF 第 1 页，共 2 页' });
  await expect(canvas).toHaveAttribute('data-rendered', 'true');
  expect(requests.some(url => url.includes('UniGB-UCS2-H') && url.includes('.bcmap'))).toBe(true);
  expect(requests.every(url => new URL(url).origin === 'http://127.0.0.1:1437')).toBe(true);
  expect(await canvas.evaluate(canvas => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    return pixels.some((value, index) => index % 4 !== 3 && value < 128);
  })).toBe(true);
});


test('legacy reader handles missing recent URL/Base64 APIs in the page and worker', async ({ page }) => {
  await page.addInitScript(() => {
    delete URL.parse;
    delete Uint8Array.fromBase64;
    delete Uint8Array.prototype.setFromBase64;
    delete Promise.try;
  });
  let workers = 0;
  const warnings = [];
  page.on('console', message => { if (message.type() === 'warning' || message.type() === 'error') warnings.push(message.text()); });
  await page.route(url => /pdf\.worker.*\.(?:mjs|js)$/.test(url.pathname) && (!url.search || url.searchParams.has('worker_file')), async route => {
    workers++;
    const response = await route.fetch();
    await route.fulfill({ response, body: `delete URL.parse; delete Uint8Array.fromBase64; delete Uint8Array.prototype.setFromBase64; delete Promise.try;\n${await response.text()}` });
  });
  await page.route(`**/api/entries/${id}/file`, route => route.fulfill({ contentType: 'application/pdf', body: pdfBytes(true) }));
  await page.goto('http://127.0.0.1:1437/__pdf_test');
  await expect(page.getByRole('img', { name: 'PDF 第 1 页，共 2 页' })).toHaveAttribute('data-rendered', 'true');
  expect(workers).toBeGreaterThan(0);
  expect(warnings.filter(message => /fake worker|TypeError|ReferenceError/.test(message) && !message.startsWith('Failed to send error to Vite server'))).toEqual([]);
});

test('outdated WebViews get an update notice instead of a Promise.withResolvers crash', async ({ page }) => {
  await page.addInitScript(() => { delete Promise.withResolvers; });
  const failures = [];
  page.on('pageerror', error => failures.push(error.message));
  await page.route(`**/api/entries/${id}/file`, route => route.fulfill({ contentType: 'application/pdf', body: pdfBytes() }));
  await page.goto('http://127.0.0.1:1437/__pdf_test');
  await expect(page.getByRole('alert')).toContainText('请更新 Android System WebView');
  await expect(page.locator('canvas, iframe')).toHaveCount(0);
  expect(failures).toEqual([]);
  expect(await page.evaluate(() => 'withResolvers' in Promise)).toBe(false);
});


test('production PDF worker has a JavaScript extension and executes as a real module', async ({ page }) => {
  test.skip(!process.env.PDF_PREVIEW_BUILD_DIR, 'Run with the production build directory to verify the emitted worker');
  const directory = join(process.env.PDF_PREVIEW_BUILD_DIR, 'assets');
  const filename = (await readdir(directory)).find(name => /^pdf\.worker.*\.js$/.test(name));
  expect(filename, 'EdgeOne serves .mjs assets as octet-stream; emit a .js worker').toBeTruthy();
  const body = await readFile(join(directory, filename));
  await page.route('**/__built_pdf_worker.js', route => route.fulfill({ contentType: 'application/javascript', body }));
  await page.route(`**/api/entries/${id}/file`, route => route.fulfill({ contentType: 'application/pdf', body: pdfBytes() }));
  await page.goto('http://127.0.0.1:1437/__pdf_test');
  expect(await page.evaluate(() => new Promise(resolve => {
    const worker = new Worker('/__built_pdf_worker.js', { type: 'module' });
    const timeout = setTimeout(() => { worker.terminate(); resolve(false); }, 5000);
    worker.onerror = () => { clearTimeout(timeout); worker.terminate(); resolve(false); };
    worker.onmessage = event => {
      if (event.data?.action !== 'ready') return;
      clearTimeout(timeout); worker.terminate(); resolve(true);
    };
  }))).toBe(true);
});
