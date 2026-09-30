import { strFromU8, unzipSync } from 'fflate';
import DOMPurify from 'dompurify';

// EPUB books read in the paged reader. The zip is opened in the browser; the
// spine gives the chapter order, the nav (EPUB 3) or NCX (EPUB 2) the chapter
// names. Chapter XHTML is sanitized and its images inlined as data: URLs, so
// nothing is fetched from anywhere.

export interface EpubChapter { id: string; href: string; title: string; html: string }
export interface EpubBook { title: string; author: string; chapters: EpubChapter[] }

const MAX_FILES = 4000;

function resolve(base: string, href: string) {
  const parts = (base ? `${base}/${href}` : href).split('#')[0].split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(decodeURIComponent(part));
  }
  return out.join('/');
}
const dirname = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

function xml(text: string, type: DOMParserSupportedType = 'application/xml') {
  const document = new DOMParser().parseFromString(text, type);
  if (document.querySelector('parsererror') && type !== 'text/html') return new DOMParser().parseFromString(text, 'text/html');
  return document;
}

function base64(bytes: Uint8Array) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

export function parseEpub(buffer: ArrayBuffer): EpubBook {
  const files = unzipSync(new Uint8Array(buffer), { filter: () => true });
  if (Object.keys(files).length > MAX_FILES) throw new Error('epub_too_many_files');
  const read = (path: string) => { const data = files[path]; if (!data) throw new Error(`epub_missing:${path}`); return strFromU8(data); };

  const container = xml(read('META-INF/container.xml'));
  const opfPath = container.querySelector('rootfile')?.getAttribute('full-path');
  if (!opfPath) throw new Error('epub_no_package');
  const opf = xml(read(opfPath));
  const base = dirname(opfPath);
  const manifest = new Map<string, { href: string; type: string; properties: string }>();
  opf.querySelectorAll('manifest > item').forEach(item => manifest.set(item.getAttribute('id') ?? '', {
    href: resolve(base, item.getAttribute('href') ?? ''), type: item.getAttribute('media-type') ?? '', properties: item.getAttribute('properties') ?? '',
  }));
  const typeOf = (path: string) => [...manifest.values()].find(item => item.href === path)?.type
    || (/\.png$/i.test(path) ? 'image/png' : /\.gif$/i.test(path) ? 'image/gif' : /\.svg$/i.test(path) ? 'image/svg+xml' : /\.webp$/i.test(path) ? 'image/webp' : 'image/jpeg');

  // Chapter names from the EPUB 3 nav document, else the EPUB 2 NCX.
  const names = new Map<string, string>();
  const nav = [...manifest.values()].find(item => item.properties.split(/\s+/).includes('nav'));
  if (nav && files[nav.href]) {
    const doc = xml(read(nav.href), 'application/xhtml+xml');
    doc.querySelectorAll('nav a[href]').forEach(link => {
      const target = resolve(dirname(nav.href), link.getAttribute('href') ?? '');
      if (!names.has(target) && link.textContent?.trim()) names.set(target, link.textContent.trim());
    });
  }
  const ncxId = opf.querySelector('spine')?.getAttribute('toc');
  const ncx = ncxId ? manifest.get(ncxId) : [...manifest.values()].find(item => item.type === 'application/x-dtbncx+xml');
  if (!names.size && ncx && files[ncx.href]) {
    xml(read(ncx.href)).querySelectorAll('navPoint').forEach(point => {
      const target = resolve(dirname(ncx.href), point.querySelector('content')?.getAttribute('src') ?? '');
      const label = point.querySelector('navLabel text')?.textContent?.trim();
      if (label && !names.has(target)) names.set(target, label);
    });
  }

  const chapters: EpubChapter[] = [];
  opf.querySelectorAll('spine > itemref').forEach((ref, index) => {
    const item = manifest.get(ref.getAttribute('idref') ?? '');
    if (!item || !files[item.href] || !/html|xml/.test(item.type)) return;
    const doc = xml(read(item.href), 'application/xhtml+xml');
    const body = doc.querySelector('body') ?? doc.documentElement;
    const folder = dirname(item.href);
    body.querySelectorAll('img[src], image').forEach(image => {
      const attribute = image.hasAttribute('src') ? 'src' : image.hasAttribute('href') ? 'href' : 'xlink:href';
      const source = image.getAttribute(attribute) ?? image.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? '';
      const path = resolve(folder, source);
      const data = files[path];
      if (data && data.length < 4 << 20) image.setAttribute(attribute === 'xlink:href' ? 'href' : attribute, `data:${typeOf(path)};base64,${base64(data)}`);
      else image.removeAttribute(attribute);
    });
    // Links between chapters keep the chapter path so the reader can follow them.
    body.querySelectorAll('a[href]').forEach(link => {
      const href = link.getAttribute('href') ?? '';
      if (!/^[a-z]+:/i.test(href)) link.setAttribute('data-epub-href', resolve(folder, href) + (href.includes('#') ? `#${href.split('#')[1]}` : ''));
    });
    const html = DOMPurify.sanitize(body.innerHTML, { USE_PROFILES: { html: true, svg: true }, ADD_ATTR: ['data-epub-href'] });
    const heading = doc.querySelector('h1, h2, h3, title')?.textContent?.trim();
    chapters.push({ id: `${index}`, href: item.href, title: names.get(item.href) || heading || `第 ${chapters.length + 1} 部分`, html });
  });
  if (!chapters.length) throw new Error('epub_empty');
  const text = (selector: string) => opf.querySelector(selector)?.textContent?.trim() ?? '';
  return { title: text('metadata > title, title') || '未命名图书', author: text('metadata > creator, creator'), chapters };
}
