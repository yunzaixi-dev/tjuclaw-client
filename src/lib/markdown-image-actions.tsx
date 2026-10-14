import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArrowLeft, ArrowRight, Copy, Crosshair, Download, ExternalLink, Maximize2, Minimize2, RotateCw, X } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../components/ui/dialog';
import type { CachedImage } from './image-cache';
import { markdownImageCache } from './image-cache';
import type { MarkdownGalleryImage, MarkdownImageGallery, MarkdownImageGalleryRequest } from './markdown-images';
import { prepareMarkdownImage } from './markdown-images';
import { forceParsing } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { HtmlBlockWidget, ImageWidget, loadableImage } from '../components/markdown-extras';
import DOMPurify from 'dompurify';

type Action = 'copy' | 'download';

async function imageBytes(cached: CachedImage, signal: AbortSignal) {
  signal.throwIfAborted();
  if (cached.blob) return cached.blob;
  const response = await fetch(cached.src, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
  });
  if (!response.ok) throw new Error('image_download_failed');
  const blob = await response.blob();
  signal.throwIfAborted();
  if (!blob.size || !blob.type.startsWith('image/')) throw new Error('image_download_failed');
  return blob;
}

async function pngBytes(cached: CachedImage, signal: AbortSignal) {
  const embedded = /^data:image\//i.test(cached.src);
  let url = cached.src;
  if (!embedded) {
    const blob = await imageBytes(cached, signal);
    signal.throwIfAborted();
    if (blob.type === 'image/png') return blob;
    url = URL.createObjectURL(blob);
  }
  const image = new Image();
  try {
    image.src = url;
    await image.decode();
    signal.throwIfAborted();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('image_copy_failed');
    context.drawImage(image, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => {
      if (value) resolve(value);
      else reject(new Error('image_copy_failed'));
    }, 'image/png'));
    signal.throwIfAborted();
    return png;
  } finally {
    image.removeAttribute('src');
    if (!embedded) URL.revokeObjectURL(url);
  }
}

async function perform(action: Action, cached: CachedImage, alt: string, signal: AbortSignal) {
  signal.throwIfAborted();
  if (action === 'copy') {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('image_clipboard_unavailable');
    // Start the clipboard write in the click handler; Safari needs user activation
    // even when encoding or fetching the PNG completes asynchronously.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBytes(cached, signal) })]);
    return;
  }
  const embedded = /^data:image\//i.test(cached.src);
  let url = cached.src;
  let type = embedded ? cached.src.slice(5).split(',', 1)[0] : '';
  if (!embedded) {
    const blob = await imageBytes(cached, signal);
    signal.throwIfAborted();
    type = blob.type;
    if (!cached.blob) url = URL.createObjectURL(blob);
  }
  const extension = type.split(';')[0].split('/')[1]?.split('+')[0] || 'png';
  const name = cached.filename && cached.filename !== 'file' ? cached.filename : `${alt || '图片'}.${extension}`;
  const link = document.createElement('a');
  link.href = url;
  link.download = name.replace(/[\\/:*?"<>|]|\p{Cc}/gu, '_');
  link.referrerPolicy = 'no-referrer';
  document.body.append(link);
  link.click();
  link.remove();
  if (!embedded && !cached.blob) window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function failure(action: Action, error: unknown) {
  if (error instanceof Error && error.message === 'image_clipboard_unavailable') return '当前浏览器不支持复制图片，可以下载后使用。';
  return action === 'copy' ? '复制失败，请检查剪贴板权限；外链图片也可能限制复制。' : '下载失败，外链图片可能限制读取；可以打开原图后保存。';
}

function ImageViewer({ initial, gallery, signal, onClose, onLocate }: { initial: CachedImage; gallery: MarkdownImageGallery; signal: AbortSignal; onClose: () => void; onLocate: (image: MarkdownGalleryImage) => void }) {
  const [index, setIndex] = useState(gallery.index);
  const [result, setResult] = useState<{ index: number; cached?: CachedImage; error?: boolean }>({ index: gallery.index, cached: initial });
  const [retry, setRetry] = useState(0);
  const [original, setOriginal] = useState(false);
  const [busy, setBusy] = useState<Action | null>(null);
  const [feedback, setFeedback] = useState('');
  const operation = useRef(0);
  const swipe = useRef<{ id: number; x: number; y: number } | null>(null);
  const current = gallery.images[index];
  const cached = result.index === index ? result.cached : current.src ? markdownImageCache.peek(current.src) : undefined;
  useEffect(() => {
    let stopped = false;
    if (!current.src) return;
    const lease = markdownImageCache.acquire(current.src);
    void lease.ready.then(image => {
      if (!stopped && !signal.aborted) setResult({ index, cached: image });
    }, () => { if (!stopped && !signal.aborted) setResult({ index, error: true }); });
    return () => { stopped = true; lease.release(); };
  }, [current.src, index, retry, signal]);
  function move(step: number) {
    if (index + step < 0 || index + step >= gallery.images.length) return;
    operation.current++;
    setOriginal(false);
    setBusy(null);
    setFeedback('');
    setIndex(value => Math.max(0, Math.min(gallery.images.length - 1, value + step)));
  }
  function act(action: Action) {
    if (busy || !cached) return;
    const generation = ++operation.current;
    setBusy(action);
    setFeedback(action === 'copy' ? '正在复制图片…' : '正在下载图片…');
    void perform(action, cached, current.alt, signal).then(() => {
      if (!signal.aborted && generation === operation.current) setFeedback(action === 'copy' ? '图片已复制，可以直接粘贴。' : '已开始下载原图。');
    }, error => {
      if (!signal.aborted && generation === operation.current) setFeedback(failure(action, error));
    }).finally(() => { if (!signal.aborted && generation === operation.current) setBusy(null); });
  }
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="md-image-viewer" onCloseAutoFocus={event => event.preventDefault()} onKeyDown={event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' || event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      move(event.key === 'ArrowLeft' ? -1 : 1);
    }}>
      <header className="md-image-viewer-header">
        <div className="md-image-viewer-heading">
          <DialogTitle>{current.alt || '图片预览'}</DialogTitle>
          <DialogDescription>{cached ? `${cached.width} × ${cached.height} · ` : ''}{original ? '原始尺寸，可滚动查看细节' : '适应窗口'} · 左右切换</DialogDescription>
        </div>
        <button type="button" className="md-image-viewer-close" aria-label="关闭图片预览" onClick={onClose} autoFocus><X size={20} /></button>
      </header>
      <div className={`md-image-viewer-stage${original ? ' is-original' : ''}`} onPointerDown={event => {
        if (event.pointerType !== 'touch') return;
        swipe.current = !original && event.isPrimary ? { id: event.pointerId, x: event.clientX, y: event.clientY } : null;
      }} onPointerUp={event => {
        const start = swipe.current;
        swipe.current = null;
        if (!start || start.id !== event.pointerId) return;
        const dx = event.clientX - start.x, dy = event.clientY - start.y;
        if (Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(dy) * 1.5) move(dx < 0 ? 1 : -1);
      }} onPointerCancel={() => { swipe.current = null; }}>
        {cached ? <img key={index} src={cached.src} alt={current.alt} referrerPolicy="no-referrer" width={cached.width} height={cached.height} />
          : <div className="md-image-viewer-loading" role="status">{!current.src || result.index === index && result.error
            ? <><span>图片未能加载</span><button type="button" aria-label="重新加载图片" title="重新加载图片" disabled={!current.src} onClick={() => { setResult({ index }); setRetry(value => value + 1); }}><RotateCw size={18} aria-hidden="true" /></button></>
            : '正在加载图片…'}</div>}
      </div>
      <footer className="md-image-viewer-footer">
        <nav className="md-image-viewer-navigation" aria-label="浏览笔记图片">
          <button type="button" aria-label="上一张图片" disabled={index === 0} onClick={() => move(-1)}><ArrowLeft size={18} /></button>
          <span role="status" aria-label="图片序号">{index + 1} / {gallery.images.length}</span>
          <button type="button" aria-label="下一张图片" disabled={index === gallery.images.length - 1} onClick={() => move(1)}><ArrowRight size={18} /></button>
        </nav>
        <div className="md-image-viewer-tools">
          <button type="button" disabled={!cached} onClick={() => setOriginal(value => !value)} aria-pressed={original} aria-label={original ? '适应窗口' : '原始尺寸'} title={original ? '适应窗口' : '原始尺寸'}>{original ? <Minimize2 size={18} aria-hidden="true" /> : <Maximize2 size={18} aria-hidden="true" />}</button>
          <button type="button" aria-label="定位到笔记" title="定位到笔记" onClick={() => onLocate(current)}><Crosshair size={18} aria-hidden="true" /></button>
          <button type="button" aria-label="复制图片" title="复制图片" aria-busy={busy === 'copy'} disabled={busy !== null || !cached} onClick={() => act('copy')}><Copy size={18} aria-hidden="true" /></button>
          <button type="button" aria-label="下载图片" title="下载图片" aria-busy={busy === 'download'} disabled={busy !== null || !cached} onClick={() => act('download')}><Download size={18} aria-hidden="true" /></button>
          {feedback.includes('失败') && cached ? <a href={cached.src} target="_blank" rel="noreferrer" aria-label="打开原图" title="打开原图"><ExternalLink size={18} aria-hidden="true" /></a> : null}
        </div>
        <p className="md-image-viewer-feedback" role="status">{feedback || '左右切换图片；定位返回笔记中的对应位置。'}</p>
      </footer>
    </DialogContent>
  </Dialog>;
}

function revealImage(frame: HTMLElement) {
  for (let parent = frame.parentElement; parent; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement) parent.open = true;
  }
  frame.tabIndex = -1;
  frame.focus({ preventScroll: true });
  frame.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

/** Reuse the editor's parsed decorations, including images outside its DOM viewport. */
export function collectEditorImageGallery(view: EditorView, frame: HTMLElement, decorations: () => DecorationSet[]): MarkdownImageGallery {
  const position = view.posAtDOM(frame);
  if (!forceParsing(view, view.state.doc.length, 2000)) throw new Error('image_gallery_unavailable');
  const blocks: { from: number; to: number; widget: ImageWidget | HtmlBlockWidget }[] = [];
  for (const set of decorations()) set.between(0, view.state.doc.length, (from, to, decoration) => {
    const widget = decoration.spec.widget;
    if (widget instanceof ImageWidget || widget instanceof HtmlBlockWidget) blocks.push({ from, to, widget });
  });
  blocks.sort((left, right) => left.from - right.from);
  const images: MarkdownGalleryImage[] = [];
  let index = -1;
  for (const { from, to, widget } of blocks) {
    const locate = (ordinal = 0) => {
      view.dispatch({ effects: EditorView.scrollIntoView(from, { y: 'center', yMargin: 48 }) });
      let attempts = 0;
      const place = () => {
        if (!view.dom.isConnected) return;
        const matches = [...view.dom.querySelectorAll<HTMLElement>('.md-image-frame')].filter(node => {
          const pos = view.posAtDOM(node);
          return pos >= from && pos < to;
        });
        if (matches[ordinal]) revealImage(matches[ordinal]);
        else if (++attempts < 60) requestAnimationFrame(place);
      };
      requestAnimationFrame(place);
    };
    if (widget instanceof ImageWidget) {
      if (position >= from && position < to) index = images.length;
      images.push({ src: widget.loadable, alt: widget.alt, locate });
    } else {
      DOMPurify.addHook('afterSanitizeAttributes', node => {
        if (node.tagName === 'IMG') prepareMarkdownImage(node, loadableImage(node.getAttribute('src') ?? '', widget.sourceId));
        if (node.tagName === 'SOURCE') node.removeAttribute('srcset');
      });
      let fragment: DocumentFragment;
      try { fragment = DOMPurify.sanitize(widget.html, { USE_PROFILES: { html: true }, RETURN_DOM_FRAGMENT: true }); }
      finally { DOMPurify.removeHook('afterSanitizeAttributes'); }
      if (position >= from && position < to) {
        const rendered = frame.closest('.cm-md-html-block');
        const ordinal = rendered ? [...rendered.querySelectorAll('.md-image-frame')].indexOf(frame) : 0;
        index = images.length + Math.max(0, ordinal);
      }
      fragment.querySelectorAll('img[data-md-image-src]').forEach((image, ordinal) => images.push({
        src: image.getAttribute('data-md-image-src') || null, alt: image.getAttribute('alt') ?? '', locate: () => locate(ordinal),
      }));
    }
  }
  if (index < 0 || index >= images.length) throw new Error('image_gallery_unavailable');
  return { images, index };
}

/** The same controls are attached to every visible Markdown image. */
export function attachMarkdownImageActions(frame: HTMLElement, image: HTMLImageElement, cached: CachedImage) {
  const controller = new AbortController();
  let busy = false;
  let closeViewer: ((restore?: boolean, locate?: () => void) => void) | undefined;
  const actions = document.createElement('span');
  actions.className = 'md-image-actions';
  actions.setAttribute('role', 'group');
  actions.setAttribute('aria-label', '图片操作');
  const feedback = document.createElement('span');
  feedback.className = 'md-image-feedback';
  feedback.setAttribute('role', 'status');
  feedback.hidden = true;
  const buttons = (['copy', 'download'] as const).map(action => {
    const button = document.createElement('button');
    button.type = 'button';
    button.innerHTML = renderToStaticMarkup(action === 'copy' ? <Copy size={18} aria-hidden="true" /> : <Download size={18} aria-hidden="true" />);
    button.setAttribute('aria-label', action === 'copy' ? '复制图片' : '下载图片');
    button.title = action === 'copy' ? '复制图片' : '下载图片';
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (busy) return;
      busy = true;
      buttons.forEach(control => { control.disabled = true; });
      feedback.hidden = false;
      feedback.textContent = action === 'copy' ? '正在复制…' : '正在下载…';
      void perform(action, cached, image.alt, controller.signal).then(() => {
        if (!controller.signal.aborted) feedback.textContent = action === 'copy' ? '图片已复制' : '已开始下载';
      }, error => {
        if (!controller.signal.aborted) feedback.textContent = failure(action, error);
      }).finally(() => {
        busy = false;
        buttons.forEach(control => { control.disabled = false; });
      });
    });
    return button;
  });
  actions.append(...buttons);
  frame.append(actions, feedback);
  image.tabIndex = 0;
  image.setAttribute('role', 'button');
  image.setAttribute('aria-label', image.alt ? `放大图片：${image.alt}` : '放大图片');
  image.title = '点击放大图片';
  const open = () => {
    if (closeViewer || controller.signal.aborted || frame.dataset.state !== 'ready') return;
    try {
      const request: MarkdownImageGalleryRequest = { frame };
      frame.dispatchEvent(new CustomEvent('tjuclaw:image-gallery', { bubbles: true, detail: request }));
      let gallery: MarkdownImageGallery;
      if (request.gallery) gallery = request.gallery();
      else {
        const scope = frame.closest('.note-reader, .cm-content, .markdown-preview') ?? frame.parentElement ?? frame;
        const frames = scope === frame ? [frame] : [...scope.querySelectorAll<HTMLElement>('.md-image-frame')];
        gallery = { index: frames.indexOf(frame), images: frames.map(source => {
          const img = source.querySelector('img');
          return { src: img?.dataset.imageSource ?? null, alt: img?.alt ?? '', locate: () => revealImage(source) };
        }) };
      }
      if (controller.signal.aborted) return;
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      closeViewer = (restore = true, locate) => {
        closeViewer = undefined;
        queueMicrotask(() => {
          root.unmount();
          container.remove();
          if (controller.signal.aborted) return;
          if (locate) locate();
          else if (restore && image.isConnected) image.focus({ preventScroll: true });
        });
      };
      root.render(<ImageViewer initial={cached} gallery={gallery} signal={controller.signal}
        onClose={() => closeViewer?.()} onLocate={target => closeViewer?.(false, target.locate)} />);
    } catch {
      if (!controller.signal.aborted) { feedback.hidden = false; feedback.textContent = '图片浏览暂时不可用，请重试。'; }
    }
  };
  const click = (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); open(); };
  const key = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    open();
  };
  const pointer = (event: Event) => event.stopPropagation();
  image.addEventListener('click', click);
  image.addEventListener('keydown', key);
  frame.addEventListener('pointerdown', pointer);
  frame.addEventListener('mousedown', pointer);
  frame.addEventListener('contextmenu', pointer);
  return () => {
    controller.abort();
    closeViewer?.(false);
    actions.remove();
    feedback.remove();
    image.removeAttribute('tabindex');
    image.removeAttribute('role');
    image.removeAttribute('aria-label');
    image.removeAttribute('title');
    image.removeEventListener('click', click);
    image.removeEventListener('keydown', key);
    frame.removeEventListener('pointerdown', pointer);
    frame.removeEventListener('mousedown', pointer);
    frame.removeEventListener('contextmenu', pointer);
  };
}
