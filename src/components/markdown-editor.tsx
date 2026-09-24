import { useEffect, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { basicSetup } from 'codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { EditorState, RangeSet } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { defaultKeymap, indentWithTab, history, historyKeymap, redo, undo } from '@codemirror/commands';
import { keymap } from '@codemirror/view';
import { MarkdownContextMenu } from './markdown-context-menu';

const hide = Decoration.replace({});
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
    return checkbox;
  }
  ignoreEvent() { return true; }
}

type PreviewRanges = { decorations: DecorationSet; hidden: DecorationSet };

function livePreviewDecorations(view: EditorView): PreviewRanges {
  const doc = view.state.doc;
  const text = doc.toString();
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

  syntaxTree(view.state).iterate({
    enter(node) {
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
        // The Markdown parser sees the inner [target] of [[target]] as a normal link.
        if (text[from - 1] === '[' && text[to] === ']') return;
        const labelEnd = text.indexOf(']', from);
        if (labelEnd < from || labelEnd >= to) return;
        const prefixEnd = from + (name === 'Image' ? 2 : 1);
        const reveal = selected(from, to);
        syntax(from, prefixEnd, reveal);
        add(prefixEnd, labelEnd, mark(name === 'Image' ? 'cm-md-image-label' : 'cm-md-link-label'));
        syntax(labelEnd, to, reveal);
      }
      if (name === 'LinkMark' || name === 'URL') {
        if (parent?.name === 'Link' || parent?.name === 'Image') return;
      }
      if (name === 'ListMark') {
        const end = withSeparator(to);
        if (activeLine) add(from, end, mark('cm-md-syntax'));
        else if (parent?.parent?.name === 'OrderedList') add(from, end, mark('cm-md-ordered-marker'));
        else if (/^\[[ xX]\]/.test(text.slice(end))) {
          const range = hide.range(from, end);
          decorations.push(range);
          atomic.push(range);
        } else decorations.push(Decoration.replace({ widget: new BulletWidget() }).range(from, end));
      }
      if (name === 'TaskMarker') {
        const checked = text[from + 1]?.toLowerCase() === 'x';
        const range = Decoration.replace({ widget: new TaskWidget(from, checked) }).range(from, withSeparator(to));
        decorations.push(range);
        atomic.push(range);
      }
      if (name === 'QuoteMark') {
        line(from, 'cm-md-quote-line');
        syntax(from, withSeparator(to), activeLine);
      }
      if (name === 'FencedCode') {
        for (let pos = doc.lineAt(from).from; pos <= to; ) {
          line(pos, 'cm-md-code-line');
          const current = doc.lineAt(pos);
          if (current.to >= to || current.number === doc.lines) break;
          pos = current.to + 1;
        }
      }
      if ((name === 'CodeMark' || name === 'CodeInfo') && parent?.name === 'FencedCode') add(from, to, mark('cm-md-fence'));
      if (name === 'HorizontalRule') {
        if (!activeLine) add(from, to, mark('cm-md-rule'));
      }
      if (name === 'Paragraph') {
        const paragraph = text.slice(from, to);
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

class LivePreviewPlugin {
  preview: PreviewRanges;
  constructor(view: EditorView) { this.preview = livePreviewDecorations(view); }
  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged) this.preview = livePreviewDecorations(update.view);
  }
}

const livePreview = ViewPlugin.fromClass(LivePreviewPlugin, { decorations: value => value.preview.decorations });
const previewAtomicRanges = EditorView.atomicRanges.of(view => view.plugin(livePreview)?.preview.hidden ?? Decoration.none);

export function MarkdownEditor({ value, onChange, editorRef }: { value: string; onChange: (value: string) => void; editorRef?: MutableRefObject<EditorView | null> }) {
  const host = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; view: EditorView } | null>(null);
  const longPress = useRef<{ timer: number; x: number; y: number } | null>(null);
  const consumedContextMenu = useRef(false);
  const onChangeRef = useRef(onChange);
  const initialValueRef = useRef(value);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: initialValueRef.current,
        extensions: [
          basicSetup,
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          markdown({ base: markdownLanguage }),
          syntaxHighlighting(noteHighlight),
          livePreview,
          previewAtomicRanges,
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ spellcheck: 'false' }),
          EditorView.updateListener.of((update: ViewUpdate) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
          EditorView.theme({
            '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--foreground)' },
            '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-ui)', lineHeight: '1.85' },
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
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  function cancelLongPress() {
    if (longPress.current) window.clearTimeout(longPress.current.timer);
    longPress.current = null;
  }

  function openMenu(x: number, y: number) {
    if (viewRef.current) setMenu({ x, y, view: viewRef.current });
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

  function openMenuAtCursor() {
    const view = viewRef.current;
    const cursor = view?.coordsAtPos(view.state.selection.main.head);
    const bounds = host.current?.getBoundingClientRect();
    openMenu(cursor?.left ?? bounds?.left ?? 12, cursor?.bottom ?? bounds?.top ?? 12);
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

  return <><div ref={host} className="codemirror-editor" aria-label="Markdown 编辑器"
    onContextMenu={onContextMenu} onPointerDown={onPointerDown} onPointerMove={onPointerMove}
    onPointerUp={cancelLongPress} onPointerCancel={cancelLongPress} onTouchMove={cancelLongPress} onKeyDown={onKeyDown} />
    {menu ? <MarkdownContextMenu view={menu.view} position={menu} onClose={() => setMenu(null)} /> : null}
  </>;
}
