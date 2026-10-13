import { cloudNoteImage } from './note-files';

export type CachedImage = { src: string; width: number; height: number; bytes: number };
export type ImageLease = { ready: Promise<CachedImage>; release: () => void };
type Record = { key: string; refs: number; touched: number; expires: number; controller: AbortController; ready: Promise<CachedImage>; image?: CachedImage; retired: boolean };
type CacheOptions = {
  load: (src: string, signal: AbortSignal) => Promise<CachedImage>;
  revoke: (image: CachedImage) => void;
  maxBytes?: number;
  maxEntries?: number;
  maxAge?: number;
};

/** Session-only, leased LRU: never revoke an image while a mounted reader uses it. */
export class ImageCache {
  private records = new Map<string, Record>();
  private live = new Set<Record>();
  private identity: string | null = null;
  private resetListeners = new Set<() => void>();
  constructor(private options: CacheOptions) {}
  get signedIn() { return this.identity !== null; }

  open(identity: string | null) {
    if (identity === this.identity) return;
    this.clear();
    this.identity = identity;
  }
  onReset(listener: () => void) {
    this.resetListeners.add(listener);
    return () => { this.resetListeners.delete(listener); };
  }
  clear() {
    this.identity = null;
    for (const listener of this.resetListeners) listener();
    for (const record of this.live) {
      record.retired = true;
      record.controller.abort();
      if (record.image) this.options.revoke(record.image);
    }
    this.live.clear();
    this.records.clear();
  }
  peek(src: string): CachedImage | undefined {
    const record = this.records.get(src);
    return record && Date.now() < record.expires ? record.image : undefined;
  }
  acquire(src: string): ImageLease {
    let record = this.records.get(src);
    if (record && Date.now() >= record.expires) {
      this.retire(record);
      record = undefined;
    }
    if (!record) {
      const controller = new AbortController();
      const created: Record = { key: src, controller, refs: 0, touched: Date.now(), expires: Infinity, retired: false, ready: Promise.resolve().then(() => this.options.load(src, controller.signal)).then(image => {
        if (controller.signal.aborted || created.retired) {
          this.options.revoke(image);
          throw new DOMException('Image request canceled', 'AbortError');
        }
        created.image = image;
        created.touched = Date.now();
        created.expires = Date.now() + (this.options.maxAge ?? 5 * 60_000);
        this.trim();
        return image;
      }, error => { this.retire(created); throw error; }) };
      this.live.add(created);
      this.records.set(src, created);
      record = created;
    }
    record.refs++;
    record.touched = Date.now();
    const leased = record;
    let released = false;
    return { ready: leased.ready, release: () => {
      if (released) return;
      released = true;
      leased.refs--;
      if (leased.retired && leased.refs === 0) this.dispose(leased);
      this.trim();
    } };
  }
  private retire(record: Record) {
    record.retired = true;
    if (this.records.get(record.key) === record) this.records.delete(record.key);
    if (record.refs === 0) this.dispose(record);
  }
  private dispose(record: Record) {
    record.controller.abort();
    if (this.live.delete(record) && record.image) this.options.revoke(record.image);
  }
  private trim() {
    let bytes = [...this.records.values()].reduce((sum, record) => sum + (record.image?.bytes ?? 0), 0);
    for (const record of [...this.records.values()].sort((a, b) => a.touched - b.touched)) {
      if (bytes <= (this.options.maxBytes ?? 32 * 1024 * 1024) && this.records.size <= (this.options.maxEntries ?? 128)) break;
      if (record.refs !== 0 || (!record.image && this.records.size <= (this.options.maxEntries ?? 128))) continue;
      bytes -= record.image?.bytes ?? 0;
      this.retire(record);
    }
  }
}

function dimensions(src: string, signal: AbortSignal): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.referrerPolicy = 'no-referrer';
    image.decoding = 'async';
    const finish = (error?: unknown) => {
      image.onload = image.onerror = null;
      signal.removeEventListener('abort', abort);
      if (error) { image.removeAttribute('src'); reject(error); }
      else resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    const abort = () => finish(new DOMException('Image request canceled', 'AbortError'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    image.onerror = () => finish(new Error('image_unavailable'));
    image.onload = () => {
      if (!image.naturalWidth || !image.naturalHeight) { finish(new Error('image_unavailable')); return; }
      // Decode once before revealing; GIF/SVG still render through a normal img.
      void image.decode().catch(() => undefined).then(() => {
        if (!signal.aborted) finish();
      });
    };
    image.src = src;
  });
}

async function loadImage(src: string, signal: AbortSignal): Promise<CachedImage> {
  const url = new URL(src, location.href);
  const privateImage = url.protocol === location.protocol && url.host === location.host && url.pathname.startsWith('/api/');
  let objectURL: string | undefined;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal.aborted) abort();
  signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 20_000);
  const bounded = controller.signal;
  try {
    if (privateImage) {
      if (!markdownImageCache.signedIn) throw new Error('image_session_required');
      let blob: Blob;
      if (/^\/api\/entries\/[a-f0-9]{32}\/(?:file|image)$/.test(url.pathname)) {
        const { fetchAttachment } = await import('./file-delivery');
        bounded.throwIfAborted();
        const cloud = cloudNoteImage(src);
        ({ blob } = await fetchAttachment(cloud?.url ?? src, {
          signal: bounded, fallback: cloud?.fallback,
          onUnauthorized: () => markdownImageCache.clear(),
        }));
      } else {
        const response = await fetch(src, { signal: bounded, credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'image/*' } });
        if (response.status === 401) markdownImageCache.clear();
        if (!response.ok) throw new Error('image_unavailable');
        blob = await response.blob();
      }
      if (!blob.size || !blob.type.startsWith('image/')) throw new Error('image_unavailable');
      objectURL = URL.createObjectURL(blob);
      const size = await dimensions(objectURL, bounded);
      return { src: objectURL, ...size, bytes: blob.size + size.width * size.height * 4 };
    }
    // Remote images use the browser image cache, preserving hosts without CORS.
    // They never receive API cookies and keep the no-referrer policy.
    const size = await dimensions(src, bounded);
    return { src, ...size, bytes: Math.min(size.width * size.height * 4, 32 * 1024 * 1024) };
  } catch (error) {
    if (objectURL) URL.revokeObjectURL(objectURL);
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}

export const markdownImageCache = new ImageCache({
  load: loadImage,
  revoke: image => { if (image.src.startsWith('blob:')) URL.revokeObjectURL(image.src); },
});
