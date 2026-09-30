import { StateEffect } from '@codemirror/state';
import { EditorView, WidgetType } from '@codemirror/view';

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
  constructor(readonly tex: string, readonly display: boolean, readonly ready: boolean) { super(); }
  eq(other: MathWidget) { return this.tex === other.tex && this.display === other.display && this.ready === other.ready; }
  toDOM(view: EditorView) {
    const element = document.createElement(this.display ? 'div' : 'span');
    element.className = this.display ? 'cm-md-math cm-md-math-block' : 'cm-md-math';
    const html = mathML(this.tex, this.display);
    if (html) element.innerHTML = html;
    else {
      element.textContent = this.tex;
      void loadMath().then(() => view.dispatch({ effects: mathLoaded.of(null) }));
    }
    return element;
  }
  ignoreEvent() { return false; }
}

/** Only images the client may load (CSP img-src 'self' data:) are drawn. */
export function loadableImage(src: string): string | null {
  const url = src.trim();
  if (/^data:image\//i.test(url)) return url;
  try {
    const parsed = new URL(url, location.origin);
    if (parsed.origin === location.origin) return parsed.pathname + parsed.search;
    if (parsed.protocol === 'https:' && parsed.hostname === 'qnhdpic.twt.edu.cn') return `/api/media/image?url=${encodeURIComponent(parsed.href)}`;
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
      return image;
    }
    // External images cannot load here; show what and where instead.
    const card = document.createElement('span');
    card.className = 'cm-md-image-card';
    const label = document.createElement('strong');
    label.textContent = this.alt || '图片';
    const host = document.createElement('small');
    try { host.textContent = `外部图片 · ${new URL(this.src).hostname}`; } catch { host.textContent = '图片'; }
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
