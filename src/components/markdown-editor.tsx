import { useEffect, useRef, useState, useSyncExternalStore, type MutableRefObject, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { basicSetup } from 'codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { bracketMatching, defaultHighlightStyle, HighlightStyle, indentOnInput, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { EditorState, RangeSet, StateEffect, StateField, type Range } from '@codemirror/state';
import { Decoration, dropCursor, EditorView, highlightSpecialChars, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { defaultKeymap, indentWithTab, history, historyKeymap, redo, undo } from '@codemirror/commands';
import { keymap } from '@codemirror/view';
import { MoreHorizontal } from 'lucide-react';
import { MarkdownContextMenu } from './markdown-context-menu';
import { actions, applyAction, toolbarActions } from './markdown-actions';
import { FootnoteWidget, HtmlBlockWidget, htmlBlockRenders, ImageWidget, INLINE_HTML, INLINE_MATH, MathWidget, mathLoaded, mathReady, MermaidWidget, SummaryWidget } from './markdown-extras';
import { classHighlighter } from '@lezer/highlight';
import { codeLanguages } from '../lib/code-highlight';
import { findDisplayMath } from './display-math';

// Phones and tablets: CodeMirror's drawn cursor and selection hide the native
// caret, selection handles and magnifier, so touch devices use the browser's
// own selection and keep long-press for the system text menu.
const coarsePointer = typeof window !== 'undefined' && Boolean(window.matchMedia?.('(pointer: coarse)').matches);
const touchSetup = [highlightSpecialChars(), dropCursor(), indentOnInput(), bracketMatching()];
const TOOLBAR_HEIGHT = 48;

function subscribeViewport(onChange: () => void) {
  const viewport = window.visualViewport;
  viewport?.addEventListener('resize', onChange);
  viewport?.addEventListener('scroll', onChange);
  return () => {
    viewport?.removeEventListener('resize', onChange);
    viewport?.removeEventListener('scroll', onChange);
  };
}

/** Height covered by the on-screen keyboard, so the bar sits right above it. */
function keyboardInset() {
  const viewport = window.visualViewport;
  return viewport ? Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop)) : 0;
}

function TouchFormatBar({ view, onMore }: { view: EditorView; onMore: () => void }) {
  const inset = useSyncExternalStore(subscribeViewport, keyboardInset, () => 0);
  // Rendered inline (not portaled) so it inherits the workspace colour tokens.
  return (
    <div className="md-touch-bar" role="toolbar" aria-label="Markdown 格式" style={{ bottom: inset }}
      // Keep the editor focused (and the keyboard open) while tapping a button.
      onPointerDown={event => event.preventDefault()}>
      {toolbarActions.map(action => {
        const Icon = action.icon;
        return <button key={action.label} type="button" aria-label={action.label} title={action.label} onClick={() => { void applyAction(view, action); }}>
          {action.kind === 'heading' ? <span className="md-touch-bar-text">H{action.text}</span> : <Icon size={18} />}
        </button>;
      })}
      <button type="button" aria-label="更多格式" title="更多格式" onClick={onMore}><MoreHorizontal size={18} /></button>
    </div>
  );
}

const hide = Decoration.replace({});
/** Width of one list level and of a list marker, in em. */
const LIST_STEP = 1.6;
const mark = (className: string) => Decoration.mark({ class: className });
// Keep CodeMirror's syntax colors without its default heading underline.
const noteHighlight = HighlightStyle.define([
  ...defaultHighlightStyle.specs.filter(style => style.tag !== tags.heading),
  { tag: tags.heading, fontWeight: 'bold', textDecoration: 'none' },
]);

class BulletWidget extends WidgetType {
  toDOM() {
    const bullet = document.createElement('span');
    bullet.className = 'cm-md-bullet';
    bullet.setAttribute('aria-hidden', 'true');
    bullet.textContent = '•';
    return bullet;
  }
}

/** Nested list indentation, drawn at a fixed width so wrapped lines can hang. */
class IndentWidget extends WidgetType {
  constructor(readonly level: number) { super(); }
  eq(other: IndentWidget) { return this.level === other.level; }
  toDOM() {
    const indent = document.createElement('span');
    indent.className = 'cm-md-indent';
    indent.style.width = `${this.level * LIST_STEP}em`;
    indent.setAttribute('aria-hidden', 'true');
    return indent;
  }
}

class OrderedWidget extends WidgetType {
  constructor(readonly marker: string) { super(); }
  eq(other: OrderedWidget) { return this.marker === other.marker; }
  toDOM() {
    const marker = document.createElement('span');
    marker.className = 'cm-md-ordered-marker';
    marker.textContent = this.marker;
    return marker;
  }
}

/** The language label that stands in for an opening code fence. */
class FenceWidget extends WidgetType {
  constructor(readonly language: string) { super(); }
  eq(other: FenceWidget) { return this.language === other.language; }
  toDOM() {
    const label = document.createElement('span');
    label.className = 'cm-md-code-label';
    label.textContent = this.language;
    return label;
  }
}

class TaskWidget extends WidgetType {
  constructor(readonly from: number, readonly checked: boolean) { super(); }
  eq(other: TaskWidget) { return this.from === other.from && this.checked === other.checked; }
  toDOM(view: EditorView) {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'cm-md-checkbox';
    checkbox.checked = this.checked;
    checkbox.setAttribute('aria-label', this.checked ? '标记任务未完成' : '标记任务完成');
    checkbox.addEventListener('mousedown', event => event.stopPropagation());
    const box = document.createElement('span');
    box.className = 'cm-md-task-box';
    box.append(checkbox);
    checkbox.addEventListener('change', () => {
      view.dispatch({ changes: { from: this.from + 1, to: this.from + 2, insert: checkbox.checked ? 'x' : ' ' } });
    });
    checkbox.addEventListener('keydown', event => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return;
      event.preventDefault();
      event.stopPropagation();
      view.focus();
      if (event.shiftKey) redo(view);
      else undo(view);
    });
    return box;
  }
  ignoreEvent() { return true; }
}

type PreviewRanges = { decorations: DecorationSet; hidden: DecorationSet };

/** Index of the ']' closing the '[' at start, allowing nested brackets. */
function closingBracket(text: string, start: number, limit: number) {
  let depth = 0;
  for (let index = start; index < limit; index += 1) {
    const char = text[index];
    if (char === '\\') { index += 1; continue; }
    if (char === '[') depth += 1;
    else if (char === ']' && --depth === 0) return index;
  }
  return -1;
}

/** The URL of a link or image destination "(url "title")". */
function destination(inner: string) {
  const trimmed = inner.trim();
  return trimmed.startsWith('<') ? trimmed.slice(1, trimmed.indexOf('>')) : trimmed.split(/\s+/)[0] ?? '';
}

const QUOTE_PREFIX = /^(?:[ \t]*>)+[ \t]?/;

function livePreviewDecorations(view: EditorView): PreviewRanges {
  const doc = view.state.doc;
  const text = doc.toString();
  const mathBlocks = view.state.field(displayMathBlocks);
  const inMath = (from: number, to = from) => mathBlocks.some(block => from >= block.from && to <= block.to);
  const decorations: ReturnType<Decoration['range']>[] = [];
  const atomic: ReturnType<Decoration['range']>[] = [];
  const selected = (from: number, to: number) =>
    view.hasFocus && view.state.selection.ranges.some(range => range.from <= to && range.to >= from);
  const add = (from: number, to: number, decoration: Decoration) => {
    if (from < to) decorations.push(decoration.range(from, to));
  };
  const syntax = (from: number, to: number, reveal: boolean) => {
    if (from >= to) return;
    if (reveal) add(from, to, mark('cm-md-syntax'));
    else {
      const range = hide.range(from, to);
      decorations.push(range);
      atomic.push(range);
    }
  };
  const line = (from: number, className: string) => {
    decorations.push(Decoration.line({ attributes: { class: className } }).range(doc.lineAt(from).from));
  };
  const withSeparator = (to: number) => {
    const remainder = text.slice(to, doc.lineAt(to).to);
    return to + (/^[ \t]+/.exec(remainder)?.[0].length ?? 0);
  };

  let alignStart: number | null = null;
  // Blank lines between blocks fold to a small gap, as in reading mode;
  // the caret's line keeps its full height.
  for (const { from: start, to: end } of view.visibleRanges) {
    for (let pos = start; pos <= end; ) {
      const current = doc.lineAt(pos);
      if (/^[\s>]*$/.test(current.text) && !selected(current.from, current.to)
        && !/Code/.test(syntaxTree(view.state).resolveInner(current.from, 1).name)) line(current.from, 'cm-md-blank');
      if (current.to >= end || current.number === doc.lines) break;
      pos = current.to + 1;
    }
  }
  syntaxTree(view.state).iterate({
    enter(node) {
      if (inMath(node.from, node.to)) return false;
      const { from, to, name } = node;
      const parent = node.node.parent;
      const activeLine = selected(doc.lineAt(from).from, doc.lineAt(from).to);
      if (/^ATXHeading[1-6]$/.test(name)) line(from, `cm-md-heading-line cm-md-heading-line-${name.at(-1)}`);
      if (/^SetextHeading[12]$/.test(name)) line(from, `cm-md-heading-line cm-md-heading-line-${name.at(-1)}`);
      if (name === 'HeaderMark') {
        // Setext underlines occupy their own line; retain them while editing.
        syntax(from, parent?.name.startsWith('SetextHeading') ? to : withSeparator(to), activeLine || parent?.name.startsWith('SetextHeading') === true);
      }
      if (name === 'StrongEmphasis') add(from, to, mark('cm-md-strong'));
      if (name === 'Emphasis') add(from, to, mark('cm-md-emphasis'));
      if (name === 'Strikethrough') add(from, to, mark('cm-md-strikethrough'));
      if (name === 'InlineCode') add(from, to, mark('cm-md-inline-code'));
      if (name === 'EmphasisMark' || name === 'StrikethroughMark' || (name === 'CodeMark' && parent?.name === 'InlineCode')) {
        syntax(from, to, parent ? selected(parent.from, parent.to) : activeLine);
      }
      if (name === 'Link' || name === 'Image') {
        // The Markdown parser sees the inner [target] of [[target]] as a normal link
        // (an image inside a link, [![alt](src)](href), is not that).
        if (name === 'Link' && text[from - 1] === '[' && text[to] === ']') return;
        // A footnote reference [^1] is drawn by the paragraph pass.
        if (text.startsWith('[^', from)) return;
        const prefixEnd = from + (name === 'Image' ? 2 : 1);
        const labelEnd = closingBracket(text, prefixEnd - 1, to);
        if (labelEnd < from || labelEnd >= to) return;
        const reveal = selected(from, to);
        if (name === 'Image' && !reveal && text[labelEnd + 1] === '(') {
          // Away from the caret an image shows as the image (or where it lives).
          const src = destination(text.slice(labelEnd + 2, to - 1));
          const range = Decoration.replace({ widget: new ImageWidget(src, text.slice(prefixEnd, labelEnd)) }).range(from, to);
          decorations.push(range);
          atomic.push(range);
          return false;
        }
        syntax(from, prefixEnd, reveal);
        add(prefixEnd, labelEnd, mark(name === 'Image' ? 'cm-md-image-label' : 'cm-md-link-label'));
        syntax(labelEnd, to, reveal);
      }
      if (name === 'Autolink') {
        const reveal = selected(from, to);
        syntax(from, from + 1, reveal);
        add(from + 1, to - 1, mark('cm-md-link-label'));
        syntax(to - 1, to, reveal);
      }
      if (name === 'LinkReference') {
        const footnote = /^\[\^([^\]\s]+)\]:[ \t]*/.exec(text.slice(from, to));
        line(from, footnote ? 'cm-md-footnote-line' : 'cm-md-linkref-line');
        if (footnote && !activeLine) {
          const range = Decoration.replace({ widget: new FootnoteWidget(footnote[1], true) }).range(from, from + footnote[0].length);
          decorations.push(range);
          atomic.push(range);
        }
      }
      if (name === 'Escape') {
        syntax(from, from + 1, activeLine);
        if (!activeLine) add(from + 1, to, mark('cm-md-escape'));
      }
      if (name === 'LinkMark' || name === 'URL') {
        if (parent?.name === 'Link' || parent?.name === 'Image') return;
      }
      if (name === 'ListMark') {
        const end = withSeparator(to);
        const lineStart = doc.lineAt(from).from;
        let level = 0;
        for (let ancestor = parent?.parent?.parent; ancestor; ancestor = ancestor.parent) {
          if (ancestor.name === 'BulletList' || ancestor.name === 'OrderedList') level += 1;
        }
        // Wrapped lines hang under the item's text, not under the marker.
        decorations.push(Decoration.line({
          attributes: { class: 'cm-md-list-line', style: `--md-hang: ${(level + 1) * LIST_STEP}em` },
        }).range(lineStart));
        if (activeLine) add(from, end, mark('cm-md-syntax'));
        else {
          if (from > lineStart) {
            const indent = Decoration.replace({ widget: new IndentWidget(level) }).range(lineStart, from);
            decorations.push(indent);
            atomic.push(indent);
          }
          const replace = (widget: WidgetType | null) => {
            const range = (widget ? Decoration.replace({ widget }) : hide).range(from, end);
            decorations.push(range);
            atomic.push(range);
          };
          if (/^\[[ xX]\]/.test(text.slice(end))) replace(null);
          else if (parent?.parent?.name === 'OrderedList') replace(new OrderedWidget(text.slice(from, to)));
          else replace(new BulletWidget());
        }
      }
      if (name === 'TaskMarker') {
        const checked = text[from + 1]?.toLowerCase() === 'x';
        const range = Decoration.replace({ widget: new TaskWidget(from, checked) }).range(from, withSeparator(to));
        decorations.push(range);
        atomic.push(range);
      }
      if (name === 'QuoteMark') {
        const current = doc.lineAt(from);
        // One line decoration per line, with its nesting depth.
        if (from === current.from + current.text.indexOf('>')) {
          const depth = (/^(?:[ \t]*>)+/.exec(current.text)?.[0].match(/>/g) ?? []).length;
          line(from, `cm-md-quote-line cm-md-quote-d${Math.min(depth, 4)}`);
        }
        syntax(from, withSeparator(to), activeLine);
      }
      if (name === 'FencedCode' && /^\s*(```|~~~)\s*mermaid\b/i.test(doc.lineAt(from).text) && !selected(from, to)) return false;
      if (name === 'FencedCode') {
        const first = doc.lineAt(from);
        const last = doc.lineAt(to);
        const closed = last.number > first.number && /^[\s>]*(```|~~~)/.test(last.text);
        // Fences inside a blockquote keep their '>' marks for the quote pass.
        const firstPrefix = /^[\s>]*/.exec(first.text)?.[0].length ?? 0;
        const lastPrefix = /^[\s>]*/.exec(last.text)?.[0].length ?? 0;
        // Away from the cursor the fences give way to a language label.
        const reveal = selected(from, to);
        for (let pos = first.from; pos <= to; ) {
          const current = doc.lineAt(pos);
          const edge = current.number === first.number ? ' cm-md-code-first' : current.number === last.number && closed ? ' cm-md-code-last' : '';
          line(pos, `cm-md-code-line${edge}${edge && !reveal ? ' is-collapsed' : ''}`);
          if (current.to >= to || current.number === doc.lines) break;
          pos = current.to + 1;
        }
        if (!reveal) {
          const language = first.text.slice(firstPrefix).replace(/^(```|~~~)+/, '').trim().split(/\s+/)[0] ?? '';
          const opening = Decoration.replace({ widget: new FenceWidget(language) }).range(first.from + firstPrefix, first.to);
          decorations.push(opening);
          atomic.push(opening);
          if (closed && last.from + lastPrefix < last.to) {
            const closing = hide.range(last.from + lastPrefix, last.to);
            decorations.push(closing);
            atomic.push(closing);
          }
        }
      }
      if ((name === 'CodeMark' || name === 'CodeInfo') && parent?.name === 'FencedCode' && selected(parent.from, parent.to)) add(from, to, mark('cm-md-fence'));
      if (name === 'HorizontalRule') {
        // Drawn as a rule; the ---, *** or ___ come back on the caret's line.
        if (activeLine) add(from, to, mark('cm-md-rule'));
        else {
          line(from, 'cm-md-hr-line');
          syntax(from, to, false);
        }
      }
      if (name === 'HTMLBlock') {
        const source = text.slice(from, to);
        // <div align="center"> … </div> centres the Markdown between them.
        if (/^\s*<(div|p)\b[^>]*\balign\s*=\s*["']?center/i.test(source) || /^\s*<center>\s*$/i.test(source)) alignStart = doc.lineAt(to).to + 1;
        else if (alignStart !== null && /^\s*<\/(div|p|center)>\s*$/i.test(source)) {
          for (let pos = alignStart; pos < from; pos = doc.lineAt(pos).to + 1) line(pos, 'cm-md-align-center');
          alignStart = null;
        }
        if (htmlBlockRenders(source) && !selected(from, to)) return false;
        for (let pos = from; pos <= to; ) {
          const current = doc.lineAt(pos);
          const lineText = current.text;
          const editing = selected(current.from, current.to);
          const image = /^\s*<img\b([^>]*)>\s*$/i.exec(lineText);
          const summary = /^\s*<summary>(.*?)<\/summary>\s*$/i.exec(lineText);
          if (!editing && image) {
            const attribute = (key: string) => new RegExp(`\\b${key}\\s*=\\s*["']([^"']*)["']`, 'i').exec(image[1])?.[1] ?? '';
            const range = Decoration.replace({ widget: new ImageWidget(attribute('src'), attribute('alt')) }).range(current.from, current.to);
            decorations.push(range);
            atomic.push(range);
          } else if (!editing && summary) {
            const range = Decoration.replace({ widget: new SummaryWidget(summary[1]) }).range(current.from, current.to);
            decorations.push(range);
            atomic.push(range);
          } else if (!editing && /^\s*(<\/?[a-z][^<>]*>\s*)+$/i.test(lineText)) {
            // Structural tags (div, details…) fold to a thin line.
            line(current.from, 'cm-md-html-tag-line');
            syntax(current.from, current.to, false);
          }
          if (current.to >= to || current.number === doc.lines) break;
          pos = current.to + 1;
        }
        return false;
      }
      if (name === 'Paragraph') {
        const paragraph = text.slice(from, to);
        const tree = syntaxTree(view.state);
        const inCode = (pos: number) => /Code/.test(tree.resolveInner(pos, 1).name);
        const replaceWith = (start: number, end: number, widget: WidgetType) => {
          const range = Decoration.replace({ widget }).range(start, end);
          decorations.push(range);
          atomic.push(range);
        };
        // $$ blocks are drawn by the block field; inline formulas outside them
        // still render even when Markdown groups the entire text as a paragraph.
        for (const match of paragraph.matchAll(INLINE_MATH)) {
          const start = from + (match.index ?? 0);
          const end = start + match[0].length;
          if (inCode(start) || inMath(start, end)) continue;
          if (selected(start, end)) add(start, end, mark('cm-md-math-source'));
          else replaceWith(start, end, new MathWidget(match[1], false, mathReady()));
        }
        for (const match of paragraph.matchAll(INLINE_HTML)) {
          const start = from + (match.index ?? 0);
          const end = start + match[0].length;
          if (inCode(start)) continue;
          const openEnd = start + match[0].indexOf('>') + 1;
          const closeStart = end - (match[0].length - match[0].lastIndexOf('</'));
          const reveal = selected(start, end);
          const title = /\btitle\s*=\s*["']([^"']*)["']/i.exec(match[2] ?? '')?.[1];
          syntax(start, openEnd, reveal);
          add(openEnd, closeStart, Decoration.mark({ class: `cm-md-html cm-md-html-${match[1].toLowerCase()}`, ...(title ? { attributes: { title } } : {}) }));
          syntax(closeStart, end, reveal);
        }
        for (const match of paragraph.matchAll(/<br\s*\/?>/gi)) {
          const start = from + (match.index ?? 0);
          if (!inCode(start)) syntax(start, start + match[0].length, activeLine);
        }
        for (const match of paragraph.matchAll(/\[\^([^\]\s]+)\](?!:)/g)) {
          const start = from + (match.index ?? 0);
          const end = start + match[0].length;
          if (!inCode(start) && !selected(start, end)) replaceWith(start, end, new FootnoteWidget(match[1], false));
        }
        for (const match of paragraph.matchAll(/!?\[\[([^\]\n]+)\]\]/g)) {
          const start = from + (match.index ?? 0);
          const end = start + match[0].length;
          const contentStart = start + (match[0][0] === '!' ? 3 : 2);
          const separator = match[1].lastIndexOf('|');
          const labelStart = separator < 0 ? contentStart : contentStart + separator + 1;
          const reveal = selected(start, end);
          syntax(start, labelStart, reveal);
          add(labelStart, end - 2, mark('cm-md-wikilink'));
          syntax(end - 2, end, reveal);
        }
      }
    },
  });
  return { decorations: Decoration.set(decorations, true), hidden: RangeSet.of(atomic, true) };
}

type TableCell = { text: string; pos: number };

/** Splits one table row into cells, keeping each cell's document position. */
function tableRow(line: string, lineFrom: number): TableCell[] {
  const cells: TableCell[] = [];
  // A table inside a blockquote keeps its '>' marks outside the cells.
  let start = QUOTE_PREFIX.exec(line)?.[0].length ?? 0;
  let end = line.length;
  while (start < end && /\s/.test(line[start])) start += 1;
  if (line[start] === '|') start += 1;
  while (end > start && /\s/.test(line[end - 1])) end -= 1;
  if (end > start && line[end - 1] === '|' && line[end - 2] !== '\\') end -= 1;
  let cellStart = start;
  for (let index = start; index <= end; index += 1) {
    if (index === end || (line[index] === '|' && line[index - 1] !== '\\')) {
      const raw = line.slice(cellStart, index);
      const lead = raw.length - raw.trimStart().length;
      cells.push({ text: raw.trim().replace(/\\\|/g, '|'), pos: lineFrom + cellStart + lead });
      cellStart = index + 1;
    }
  }
  return cells;
}

/** Bold, italic, inline code and link labels inside a table cell, as DOM. */
function inlineCell(target: HTMLElement, text: string) {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|~~[^~]+~~|!?\[\[[^\]]+\]\]|\[[^\]]+\]\([^)]*\))/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > last) target.append(text.slice(last, index));
    let element: HTMLElement;
    if (token.startsWith('`')) { element = document.createElement('code'); element.className = 'cm-md-inline-code'; element.textContent = token.slice(1, -1); }
    else if (token.startsWith('**')) { element = document.createElement('strong'); element.textContent = token.slice(2, -2); }
    else if (token.startsWith('~~')) { element = document.createElement('s'); element.textContent = token.slice(2, -2); }
    else if (token.startsWith('*')) { element = document.createElement('em'); element.textContent = token.slice(1, -1); }
    else if (token.includes('[[')) {
      element = document.createElement('span'); element.className = 'cm-md-wikilink';
      const inner = token.replace(/^!?\[\[|\]\]$/g, '');
      element.textContent = inner.slice(inner.lastIndexOf('|') + 1);
    } else { element = document.createElement('span'); element.className = 'cm-md-link-label'; element.textContent = token.slice(1, token.indexOf('](')); }
    target.append(element);
    last = index + token.length;
  }
  if (last < text.length) target.append(text.slice(last));
}

class TableWidget extends WidgetType {
  constructor(readonly source: string, readonly from: number) { super(); }
  eq(other: TableWidget) { return this.source === other.source && this.from === other.from; }
  toDOM(view: EditorView) {
    const lines = this.source.split('\n');
    let offset = this.from;
    const rows = lines.map(line => { const row = tableRow(line, offset); offset += line.length + 1; return row; });
    const aligns = (rows[1] ?? []).map(cell => {
      const spec = cell.text.replace(/\s/g, '');
      return spec.startsWith(':') && spec.endsWith(':') ? 'center' : spec.endsWith(':') ? 'right' : '';
    });
    const wrap = document.createElement('div');
    wrap.className = 'cm-md-table-wrap';
    const table = document.createElement('table');
    table.className = 'cm-md-table';
    const columns = rows[0]?.length ?? 0;
    rows.forEach((row, rowIndex) => {
      if (rowIndex === 1) return;
      const tr = document.createElement('tr');
      for (let column = 0; column < columns; column += 1) {
        const cell = document.createElement(rowIndex === 0 ? 'th' : 'td');
        const source = row[column];
        if (source) inlineCell(cell, source.text);
        if (aligns[column]) cell.style.textAlign = aligns[column];
        // Clicking a cell opens the table source with the caret in that cell.
        const pos = source?.pos ?? this.from;
        cell.addEventListener('mousedown', event => {
          event.preventDefault();
          view.dispatch({ selection: { anchor: pos } });
          view.focus();
        });
        tr.append(cell);
      }
      (rowIndex === 0 ? (table.createTHead()) : (table.tBodies[0] ?? table.createTBody())).append(tr);
    });
    wrap.append(table);
    return wrap;
  }
  ignoreEvent() { return true; }
}

const setEditorFocus = StateEffect.define<boolean>();
const editorFocus = StateField.define<boolean>({
  create: () => false,
  update: (value, tr) => tr.effects.reduce((focused, effect) => effect.is(setEditorFocus) ? effect.value : focused, value),
});

function scanDisplayMath(state: EditorState) {
  const tree = syntaxTree(state);
  return findDisplayMath(state.doc.toString(), position => {
    for (let node = tree.resolveInner(position, 1); node; node = node.parent!) {
      if (node.name === 'FencedCode' || node.name === 'CodeBlock' || node.name === 'HTMLBlock') return true;
    }
    return false;
  });
}

const displayMathBlocks = StateField.define<ReturnType<typeof findDisplayMath>>({
  create: scanDisplayMath,
  update: (value, tr) => tr.docChanged || syntaxTree(tr.startState) !== syntaxTree(tr.state) ? scanDisplayMath(tr.state) : value,
});

/** Block previews (tables, $$ math, setext underlines) need a state field. */
function blockDecorations(state: EditorState): DecorationSet {
  const focused = state.field(editorFocus, false) ?? false;
  const ranges: Range<Decoration>[] = [];
  const editing = (from: number, to: number) => focused && state.selection.ranges.some(range => range.from <= to && range.to >= from);
  const mathBlocks = state.field(displayMathBlocks);
  for (const block of mathBlocks) {
    if (!editing(block.from, block.to)) ranges.push(Decoration.replace({ widget: new MathWidget(block.tex, true, mathReady(), block.contentFrom), block: true }).range(block.from, block.to));
  }
  syntaxTree(state).iterate({
    enter(node) {
      if (mathBlocks.some(block => node.from >= block.from && node.to <= block.to)) return false;
      if (node.name === 'Table') {
        const from = state.doc.lineAt(node.from).from;
        const to = state.doc.lineAt(node.to).to;
        if (!editing(from, to)) ranges.push(Decoration.replace({ widget: new TableWidget(state.doc.sliceString(from, to), from), block: true }).range(from, to));
        return false;
      }
      if (node.name === 'FencedCode') {
        const from = state.doc.lineAt(node.from).from;
        const to = state.doc.lineAt(node.to).to;
        const lines = state.doc.sliceString(from, to).split('\n');
        if (/^\s*(```|~~~)\s*mermaid\b/i.test(lines[0] ?? '') && lines.length > 2 && !editing(from, to)) {
          ranges.push(Decoration.replace({ widget: new MermaidWidget(lines.slice(1, /^\s*(```|~~~)/.test(lines.at(-1) ?? '') ? -1 : undefined).join('\n')), block: true }).range(from, to));
        }
        return false;
      }
      if (node.name === 'HTMLBlock') {
        const from = state.doc.lineAt(node.from).from;
        const to = state.doc.lineAt(node.to).to;
        const source = state.doc.sliceString(from, to);
        if (htmlBlockRenders(source) && !editing(from, to)) ranges.push(Decoration.replace({ widget: new HtmlBlockWidget(source), block: true }).range(from, to));
        return false;
      }
      if (node.name === 'SetextHeading1' || node.name === 'SetextHeading2') {
        // The ==== or ---- underline folds away until the heading is edited.
        const first = state.doc.lineAt(node.from);
        const last = state.doc.lineAt(node.to);
        if (last.number > first.number && !editing(first.from, last.to)) ranges.push(Decoration.replace({}).range(first.to, last.to));
        return false;
      }
    },
  });
  return Decoration.set(ranges, true);
}

/** Tables render as tables until the caret enters them (block widgets need a state field). */
const tablePreview = StateField.define<DecorationSet>({
  create: blockDecorations,
  update(value, tr) {
    const syntaxChanged = syntaxTree(tr.startState) !== syntaxTree(tr.state);
    if (tr.docChanged || tr.selection || syntaxChanged || tr.effects.some(effect => effect.is(setEditorFocus) || effect.is(mathLoaded))) return blockDecorations(tr.state);
    return value;
  },
  provide: field => EditorView.decorations.from(field),
});

class LivePreviewPlugin {
  preview: PreviewRanges;
  constructor(view: EditorView) { this.preview = livePreviewDecorations(view); }
  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged
      || update.transactions.some(tr => tr.effects.some(effect => effect.is(mathLoaded)))) this.preview = livePreviewDecorations(update.view);
  }
}

const livePreview = ViewPlugin.fromClass(LivePreviewPlugin, { decorations: value => value.preview.decorations });
const previewAtomicRanges = EditorView.atomicRanges.of(view => view.plugin(livePreview)?.preview.hidden ?? Decoration.none);

/** Runs with flag set, clearing it even when run throws. */
function whileFlagged(flag: { current: boolean }, run: () => void) {
  flag.current = true;
  try { run(); } finally { flag.current = false; }
}

export function MarkdownEditor({ value, onChange, editorRef }: { value: string; onChange: (value: string) => void; editorRef?: MutableRefObject<EditorView | null> }) {
  const host = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; view: EditorView } | null>(null);
  // The editor while it has focus; the touch bar acts on it.
  const [focusedView, setFocusedView] = useState<EditorView | null>(null);
  const longPress = useRef<{ timer: number; x: number; y: number } | null>(null);
  const consumedContextMenu = useRef(false);
  const onChangeRef = useRef(onChange);
  const initialValueRef = useRef(value);
  const applyingValueRef = useRef(false);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: initialValueRef.current,
        extensions: [
          coarsePointer ? touchSetup : basicSetup,
          ...(coarsePointer ? [EditorView.scrollMargins.of(() => ({ bottom: TOOLBAR_HEIGHT + 16 }))] : []),
          history(),
          // Ctrl/⌘+1…6 set a heading, Ctrl/⌘+0 a plain paragraph (as in Typora).
          keymap.of(Array.from({ length: 7 }, (_, level) => ({
            key: `Mod-${level}`,
            run: (target: EditorView) => {
              const action = actions.find(item => item.label === (level ? `标题 ${level}` : '正文'));
              if (action) void applyAction(target, action);
              return Boolean(action);
            },
          }))),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          markdown({ base: markdownLanguage, codeLanguages }),
          syntaxHighlighting(noteHighlight),
          // Code inside fences gets the same tok-* colours as rendered Markdown.
          syntaxHighlighting(classHighlighter),
          livePreview,
          previewAtomicRanges,
          editorFocus,
          displayMathBlocks,
          tablePreview,
          EditorView.focusChangeEffect.of((_state, focusing) => setEditorFocus.of(focusing)),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': '正文', role: 'textbox', spellcheck: 'false' }),
          EditorView.updateListener.of((update: ViewUpdate) => {
            if (update.docChanged && !applyingValueRef.current) onChangeRef.current(update.state.doc.toString());
            if (update.focusChanged) setFocusedView(update.view.hasFocus ? update.view : null);
          }),
          EditorView.theme({
            '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--foreground)' },
            '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-page)', lineHeight: '1.75' },
            '.cm-content': { minHeight: '60vh', padding: '0 0 100px', caretColor: 'var(--foreground)' },
            '.cm-line': { padding: '0' },
            '&.cm-focused': { outline: 'none' },
            '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground)', borderLeftWidth: '2px' },
            '.cm-selectionBackground, ::selection': { backgroundColor: 'color-mix(in oklch, var(--primary) 20%, transparent)' },
          }),
        ],
      }),
      parent: host.current,
    });
    viewRef.current = view;
    if (editorRef) editorRef.current = view;
    return () => {
      if (longPress.current) window.clearTimeout(longPress.current.timer);
      if (editorRef?.current === view) editorRef.current = null;
      view.destroy();
    };
  }, [editorRef]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || value === view.state.doc.toString()) return;
    whileFlagged(applyingValueRef, () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }));
  }, [value]);

  function cancelLongPress() {
    if (longPress.current) window.clearTimeout(longPress.current.timer);
    longPress.current = null;
  }

  function openMenu(x: number, y: number) {
    if (viewRef.current) setMenu({ x, y, view: viewRef.current });
  }

  function openMenuAtCursor() {
    const view = viewRef.current;
    const cursor = view?.coordsAtPos(view.state.selection.main.head);
    const bounds = host.current?.getBoundingClientRect();
    openMenu(cursor?.left ?? bounds?.left ?? 12, cursor?.bottom ?? bounds?.top ?? 12);
  }

  function onContextMenu(event: ReactMouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (consumedContextMenu.current) {
      consumedContextMenu.current = false;
      return;
    }
    if (event.clientX === 0 && event.clientY === 0) {
      openMenuAtCursor();
    } else {
      openMenu(event.clientX, event.clientY);
    }
  }


  function onKeyDown(event: ReactKeyboardEvent) {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    event.preventDefault();
    event.stopPropagation();
    openMenuAtCursor();
  }

  function onPointerDown(event: ReactPointerEvent) {
    if (event.pointerType !== 'touch') return;
    cancelLongPress();
    const { clientX: x, clientY: y } = event;
    longPress.current = {
      x, y,
      timer: window.setTimeout(() => {
        consumedContextMenu.current = true;
        openMenu(x, y);
        longPress.current = null;
        window.setTimeout(() => { consumedContextMenu.current = false; }, 700);
      }, 500),
    };
  }

  function onPointerMove(event: ReactPointerEvent) {
    if (longPress.current && Math.hypot(event.clientX - longPress.current.x, event.clientY - longPress.current.y) > 10) cancelLongPress();
  }

  // Touch devices keep the native long-press menu; formatting lives on the bar.
  const pointerHandlers = coarsePointer ? {} : {
    onContextMenu, onPointerDown, onPointerMove, onPointerUp: cancelLongPress, onPointerCancel: cancelLongPress, onTouchMove: cancelLongPress,
  };
  return <><div ref={host} className={`codemirror-editor${coarsePointer ? ' is-touch' : ''}`} aria-label="Markdown 编辑器"
    {...pointerHandlers} onKeyDown={onKeyDown} />
    {coarsePointer && focusedView && !menu ? <TouchFormatBar view={focusedView} onMore={openMenuAtCursor} /> : null}
    {menu ? <MarkdownContextMenu view={menu.view} position={menu} onClose={() => setMenu(null)} /> : null}
  </>;
}
