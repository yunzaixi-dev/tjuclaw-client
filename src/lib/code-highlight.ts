import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { classHighlighter, highlightCode } from '@lezer/highlight';

// Code in rendered Markdown (conversations, reading mode) is coloured with
// the same Lezer parsers as the editor, as tok-* classes styled by the app's
// theme. Each language loads on first use; views redraw when it arrives.

const listeners = new Set<() => void>();

export function onHighlighterLoaded(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const escape = (text: string) => text.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!);

export { languages as codeLanguages };

/** Highlighted HTML for code, or escaped text while its language loads. */
export function highlightHtml(code: string, language: string): string {
  const description = language ? LanguageDescription.matchLanguageName(languages, language, true) : null;
  if (!description) return escape(code);
  if (!description.support) {
    void description.load().then(() => listeners.forEach(listener => listener())).catch(() => undefined);
    return escape(code);
  }
  const tree = description.support.language.parser.parse(code);
  let html = '';
  highlightCode(code, tree, classHighlighter,
    (text, classes) => { html += classes ? `<span class="${classes}">${escape(text)}</span>` : escape(text); },
    () => { html += '\n'; });
  return html;
}
