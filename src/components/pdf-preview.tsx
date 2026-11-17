import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker&url';
import './pdf-preview.css';

GlobalWorkerOptions.workerSrc = workerUrl;

// Vite emits the library's CJK maps, fallback fonts and image decoders locally.
// PDFs never choose a network address for these built-in resources.
const assets = import.meta.glob<string>('/node_modules/pdfjs-dist/{cmaps,standard_fonts,wasm}/*.{bcmap,pfb,ttf,wasm}', {
  query: '?url&no-inline', import: 'default', eager: true,
});
class PdfBinaryDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }) {
    const directory = { cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' }[kind];
    const url = directory && assets[`/node_modules/pdfjs-dist/${directory}/${filename}`];
    if (!url) throw new Error('pdf_resource_unavailable');
    const response = await fetch(url, { credentials: 'same-origin', redirect: 'error' });
    if (!response.ok) throw new Error('pdf_resource_unavailable');
    return new Uint8Array(await response.arrayBuffer());
  }
}

export default function PdfPreview({ blob }: { blob: Blob }) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [width, setWidth] = useState(0);
  const [rendered, setRendered] = useState(false);
  const [error, setError] = useState('');
  const container = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let disposed = false;
    let task: ReturnType<typeof getDocument> | undefined;
    void blob.arrayBuffer().then(data => {
      if (disposed) return;
      // Bytes already passed the authenticated file route and PDF header check.
      // Never give the worker a private URL or enable document JavaScript.
      task = getDocument({ data, enableXfa: false, useWorkerFetch: false, BinaryDataFactory: PdfBinaryDataFactory });
      return task.promise.then(pdf => { if (!disposed) setDocument(pdf); });
    }).catch(() => { if (!disposed) setError('预览暂不可用，可下载原件。'); });
    return () => { disposed = true; void task?.destroy().catch(() => undefined); };
  }, [blob]);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = canvas.current;
    if (!document || !element || width < 1) return;
    let disposed = false;
    let task: RenderTask | undefined;
    element.dataset.rendered = 'false';
    void document.getPage(page).then(pdfPage => {
      if (disposed) return;
      const natural = pdfPage.getViewport({ scale: 1 });
      const scale = Math.min(width / natural.width, 2);
      // Keep a single mobile canvas below eight megapixels, including long pages.
      const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(8_000_000 / (natural.width * natural.height * scale * scale)));
      const viewport = pdfPage.getViewport({ scale: scale * ratio });
      element.width = Math.ceil(viewport.width);
      element.height = Math.ceil(viewport.height);
      element.style.width = `${viewport.width / ratio}px`;
      element.style.height = `${viewport.height / ratio}px`;
      task = pdfPage.render({ canvas: element, viewport });
      return task.promise.then(() => {
        if (disposed) return;
        element.dataset.rendered = 'true';
        setRendered(true);
      });
    }).catch(() => { if (!disposed) setError('预览暂不可用，可下载原件。'); });
    return () => { disposed = true; task?.cancel(); };
  }, [document, page, width]);

  const changePage = (next: number) => { setRendered(false); setPage(next); };
  return <div className="pdf-preview" ref={container}>
    {error ? <p className="file-preview-message" role="alert">{error}</p> : <>
      <nav className="pdf-preview-controls" aria-label="PDF 翻页">
        <button type="button" aria-label="上一页" disabled={!document || page === 1} onClick={() => changePage(page - 1)}><ChevronLeft size={18} /></button>
        <span aria-live="polite">{document ? `${page} / ${document.numPages}` : '正在打开 PDF…'}</span>
        <button type="button" aria-label="下一页" disabled={!document || page === document.numPages} onClick={() => changePage(page + 1)}><ChevronRight size={18} /></button>
      </nav>
      {!rendered ? <p className="file-preview-message" role="status">正在绘制页面…</p> : null}
      <canvas ref={canvas} role="img" aria-label={`PDF 第 ${page} 页，共 ${document?.numPages ?? 0} 页`} style={{ visibility: rendered ? 'visible' : 'hidden' }} />
    </>}
  </div>;
}
