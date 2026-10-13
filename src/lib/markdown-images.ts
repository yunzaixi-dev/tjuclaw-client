import { markdownImageCache, type CachedImage, type ImageLease } from './image-cache';

const cleanups = new WeakMap<HTMLElement, () => void>();

function icon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  // Lucide's image glyph, matching the workspace's existing icon vocabulary.
  svg.innerHTML = '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>';
  return svg;
}

/** The same stable image frame is used by CodeMirror and sanitized reading HTML. */
export function createMarkdownImage(src: string | null, alt = '', width?: number, height?: number): HTMLSpanElement {
  const frame = document.createElement('span');
  frame.className = 'md-image-frame';
  frame.contentEditable = 'false';
  const image = document.createElement('img');
  image.className = 'md-image-content cm-md-image';
  image.alt = alt;
  if (width) image.width = width;
  if (height) image.height = height;
  if (src) image.dataset.imageSource = src;
  image.decoding = 'async';
  image.referrerPolicy = 'no-referrer';
  const placeholder = document.createElement('span');
  placeholder.className = 'md-image-placeholder';
  const glyph = icon();
  const status = document.createElement('span');
  status.className = 'md-image-status';
  status.setAttribute('role', 'status');
  const caption = document.createElement('span');
  caption.className = 'md-image-caption';
  caption.textContent = alt;
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'md-image-retry';
  retry.textContent = '重新加载';
  retry.setAttribute('aria-label', alt ? `重新加载图片：${alt}` : '重新加载图片');
  retry.addEventListener('mousedown', event => event.preventDefault());
  placeholder.append(glyph, status, caption, retry);
  frame.append(image, placeholder);
  let disposed = false;
  let attempt = 0;
  let lease: ImageLease | undefined;
  let observer: IntersectionObserver | undefined;
  const size = (cached?: CachedImage) => {
    const w = width || cached?.width || (src ? 480 : 360);
    const h = height || (cached ? w * cached.height / cached.width : src ? w * .625 : 144);
    frame.style.width = `min(100%, ${w}px)`;
    frame.style.aspectRatio = `${w} / ${h}`;
    frame.classList.toggle('is-compact', w < 180 || h < 120);
  };
  size(src ? markdownImageCache.peek(src) : undefined);
  const state = (value: 'waiting' | 'loading' | 'ready' | 'error') => {
    frame.dataset.state = value;
    frame.setAttribute('aria-busy', String(value === 'loading'));
    status.textContent = value === 'waiting' ? '图片待加载' : value === 'loading' ? '正在加载图片' : value === 'error' ? '图片未能加载' : '';
    placeholder.setAttribute('aria-hidden', String(value === 'ready'));
    retry.hidden = value !== 'error' || !src;
    image.hidden = value !== 'ready';
  };
  const load = () => {
    if (disposed || !src) return;
    observer?.disconnect();
    const current = ++attempt;
    lease?.release();
    image.removeAttribute('src');
    state('loading');
    lease = markdownImageCache.acquire(src);
    void lease.ready.then(cached => {
      if (disposed || current !== attempt) return;
      size(cached);
      image.onload = () => { if (!disposed && current === attempt) state('ready'); };
      image.onerror = () => { if (!disposed && current === attempt) state('error'); };
      image.src = cached.src;
      if (image.complete && image.naturalWidth) state('ready');
    }, () => { if (!disposed && current === attempt) state('error'); });
  };
  retry.addEventListener('click', load);
  const reset = markdownImageCache.onReset(() => {
    ++attempt;
    observer?.disconnect();
    lease?.release();
    lease = undefined;
    image.removeAttribute('src');
    state('error');
  });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    ++attempt;
    observer?.disconnect();
    image.onload = image.onerror = null;
    image.removeAttribute('src');
    lease?.release();
    reset();
    cleanups.delete(frame);
  };
  cleanups.set(frame, dispose);
  if (!src) state('error');
  else if (markdownImageCache.peek(src)) load();
  else if (typeof IntersectionObserver !== 'undefined') {
    state('waiting');
    observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) load();
    }, { rootMargin: '240px' });
    observer.observe(frame);
  } else load();
  return frame;
}

export function releaseMarkdownImages(root: HTMLElement) {
  cleanups.get(root)?.();
  root.querySelectorAll<HTMLElement>('.md-image-frame').forEach(frame => cleanups.get(frame)?.());
}

/** Sanitize/resolve URLs first; defer network loading until the frame is near view. */
export function prepareMarkdownImage(image: Element, src: string | null) {
  image.removeAttribute('src');
  image.removeAttribute('srcset');
  image.setAttribute('data-md-image-src', src ?? '');
}

export function enhanceMarkdownImages(root: HTMLElement) {
  const images = root.matches('img[data-md-image-src]') ? [root] : [...root.querySelectorAll('img[data-md-image-src]')];
  for (const image of images) {
    const number = (name: string) => {
      const value = Number(image.getAttribute(name));
      return Number.isFinite(value) && value > 0 ? Math.min(value, 10_000) : undefined;
    };
    const frame = createMarkdownImage(image.getAttribute('data-md-image-src') || null, image.getAttribute('alt') ?? '', number('width'), number('height'));
    image.replaceWith(frame);
  }
}

/** Includes portal-based note history; only marked Markdown images are touched. */
export function observeMarkdownImages(root: HTMLElement) {
  const frames = new Set<HTMLElement>();
  const scan = (element: HTMLElement) => {
    enhanceMarkdownImages(element);
    if (element.matches('.md-image-frame')) frames.add(element);
    element.querySelectorAll<HTMLElement>('.md-image-frame').forEach(frame => frames.add(frame));
  };
  scan(root);
  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) if (node instanceof HTMLElement) scan(node);
    }
    for (const frame of frames) {
      if (!frame.isConnected) { releaseMarkdownImages(frame); frames.delete(frame); }
    }
  });
  observer.observe(root, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    for (const frame of frames) releaseMarkdownImages(frame);
    releaseMarkdownImages(root);
    frames.clear();
  };
}
