import { StateEffect } from '@codemirror/state';
import { EditorView, WidgetType } from '@codemirror/view';
import { resolveNoteFile } from '../lib/note-files';

// Math renders with KaTeX as MathML: browsers draw it natively, and it needs
// no inline styles or fonts, so it works under the client's strict CSP.
// KaTeX loads only once a note contains math.

type Katex = typeof import('katex').default;
let katex: Katex | null = null;
let loading: Promise<Katex> | null = null;

export function loadMath(): Promise<Katex> {
  loading ??= import('katex').then(module => { katex = module.default; return katex; });
  return loading;
}

export const mathReady = () => katex !== null;

/** MathML for a TeX source, or null until KaTeX has loaded. */
export function mathML(tex: string, display: boolean): string | null {
  if (!katex) return null;
  return katex.renderToString(tex, { displayMode: display, output: 'mathml', throwOnError: false, trust: false, strict: 'ignore' });
}

/** Tells the editor to redraw math once KaTeX arrives. */
export const mathLoaded = StateEffect.define<null>();

export class MathWidget extends WidgetType {
  constructor(readonly tex: string, readonly display: boolean, readonly ready: boolean, readonly contentFrom?: number) { super(); }
  eq(other: MathWidget) { return this.tex === other.tex && this.display === other.display && this.ready === other.ready && this.contentFrom === other.contentFrom; }
  toDOM(view: EditorView) {
    const element: HTMLElement = document.createElement(this.display ? 'div' : 'span');
    element.className = this.display ? 'cm-md-math cm-md-math-block' : 'cm-md-math';
    const html = mathML(this.tex, this.display);
    if (html) element.innerHTML = html;
    else {
      element.textContent = this.tex;
      void loadMath().then(() => view.dispatch({ effects: mathLoaded.of(null) }));
    }
    if (this.contentFrom !== undefined) {
      element.setAttribute('aria-label', '数学公式，点击编辑');
      element.setAttribute('role', 'button');
      element.tabIndex = 0;
      const edit = () => {
        view.dispatch({ selection: { anchor: Math.min(this.contentFrom!, view.state.doc.length) } });
        view.focus();
      };
      element.addEventListener('mousedown', event => {
        event.preventDefault();
        edit();
      });
      element.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        edit();
      });
    }
    return element;
  }
  ignoreEvent() { return false; }
}

/** The URL an image loads from: same-origin, data:, campus images through the proxy, other HTTPS images directly. */
export function loadableImage(src: string): string | null {
  const url = src.trim();
  if (/^data:image\//i.test(url)) return url;
  // A relative path names a file in the open library.
  const file = resolveNoteFile(url);
  if (file) return file;
  try {
    const parsed = new URL(url, location.origin);
    if (parsed.origin === location.origin) return parsed.pathname + parsed.search;
    if (parsed.protocol === 'https:' && parsed.hostname === 'qnhdpic.twt.edu.cn') return `/api/media/image?url=${encodeURIComponent(parsed.href)}`;
    if (parsed.protocol === 'https:') return parsed.href;
  } catch { /* not a URL */ }
  return null;
}

export class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string) { super(); }
  eq(other: ImageWidget) { return this.src === other.src && this.alt === other.alt; }
  toDOM() {
    const loadable = loadableImage(this.src);
    if (loadable) {
      const image = document.createElement('img');
      image.className = 'cm-md-image';
      image.src = loadable;
      image.alt = this.alt;
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      // An image that fails to load shows as its card instead.
      image.addEventListener('error', () => image.replaceWith(this.card()));
      return image;
    }
    return this.card();
  }
  card() {
    const card = document.createElement('span');
    card.className = 'cm-md-image-card';
    const label = document.createElement('strong');
    label.textContent = this.alt || '图片';
    const host = document.createElement('small');
    try { host.textContent = `图片未能加载 · ${new URL(this.src).hostname}`; } catch { host.textContent = '图片未能加载'; }
    card.append(label, host);
    card.title = this.src;
    return card;
  }
}

export class FootnoteWidget extends WidgetType {
  constructor(readonly label: string, readonly definition: boolean) { super(); }
  eq(other: FootnoteWidget) { return this.label === other.label && this.definition === other.definition; }
  toDOM() {
    const element = document.createElement(this.definition ? 'span' : 'sup');
    element.className = this.definition ? 'cm-md-footnote-label' : 'cm-md-footnote-ref';
    element.textContent = this.definition ? `${this.label}.` : this.label;
    return element;
  }
}

export class SummaryWidget extends WidgetType {
  constructor(readonly text: string) { super(); }
  eq(other: SummaryWidget) { return this.text === other.text; }
  toDOM() {
    const element = document.createElement('span');
    element.className = 'cm-md-summary';
    element.textContent = this.text;
    return element;
  }
}

/** Inline HTML tags drawn as formatting in the live preview. */
export const INLINE_HTML = /<(u|mark|sub|sup|kbd|small|del|ins|abbr|s|b|i|em|strong|code)(\s[^<>]*)?>([^<]*?)<\/\1\s*>/gi;

/** Inline math: $…$ without a space inside the dollars (so prices stay text). */
export const INLINE_MATH = /(?<![\\$\w])\$(?![\s$])([^$\n]+?)(?<![\s\\])\$(?![\w$])/g;

/** A Mermaid diagram in place of its fenced source. */
export class MermaidWidget extends WidgetType {
  constructor(readonly source: string) { super(); }
  eq(other: MermaidWidget) { return this.source === other.source; }
  toDOM() {
    const block = document.createElement('div');
    block.className = 'cm-md-mermaid';
    block.textContent = '正在绘制图表…';
    void import('../lib/mermaid-render').then(({ renderMermaid }) => renderMermaid(this.source)).then(svg => { block.innerHTML = svg; })
      .catch(() => { block.textContent = 'Mermaid 图表有语法错误，点击查看源码。'; block.classList.add('is-error'); });
    return block;
  }
}

/** A raw HTML block, sanitized, drawn as the HTML it describes. */
export class HtmlBlockWidget extends WidgetType {
  constructor(readonly html: string) { super(); }
  eq(other: HtmlBlockWidget) { return this.html === other.html; }
  toDOM() {
    const block = document.createElement('div');
    block.className = 'cm-md-html-block';
    void import('dompurify').then(({ default: DOMPurify }) => {
      block.innerHTML = DOMPurify.sanitize(this.html, { USE_PROFILES: { html: true } });
      block.querySelectorAll('img').forEach(image => { image.referrerPolicy = 'no-referrer'; image.loading = 'lazy'; });
    });
    return block;
  }
}

const TAG_ONLY = /^\s*(<\/?[a-z][^<>]*>\s*)+$/i;
const SUMMARY = /^\s*<summary>.*<\/summary>\s*$/i;
/** Whether an HTML block draws as HTML (not only structural tag lines). */
export function htmlBlockRenders(source: string) {
  return source.split('\n').some(line => line.trim() && !TAG_ONLY.test(line) && !SUMMARY.test(line))
    || /^\s*<(img|table|p|figure|picture|video|audio|hr|br)\b/i.test(source);
}
