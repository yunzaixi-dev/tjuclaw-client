import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { redo, undo } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import {
  Bold, CheckSquare2, Clipboard, ClipboardPaste, Code2, Copy, Heading,
  Highlighter, Image, IndentDecrease, IndentIncrease, Italic, Link2,
  List, ListOrdered, Minus, Quote, Redo2, Scissors, Search, Strikethrough,
  Table2, Tag, Undo2, X, type LucideIcon,
} from 'lucide-react';

type Action = {
  label: string;
  icon: LucideIcon;
  group: string;
  text?: string;
  kind: 'wrap' | 'line' | 'insert' | 'indent' | 'history' | 'heading' | 'clipboard' | 'select';
  prefix?: string;
  suffix?: string;
};

const actions: Action[] = [
  { label: '加粗', icon: Bold, group: '文本格式', kind: 'wrap', prefix: '**', suffix: '**' },
  { label: '斜体', icon: Italic, group: '文本格式', kind: 'wrap', prefix: '*', suffix: '*' },
  { label: '删除线', icon: Strikethrough, group: '文本格式', kind: 'wrap', prefix: '~~', suffix: '~~' },
  { label: '高亮', icon: Highlighter, group: '文本格式', kind: 'wrap', prefix: '==', suffix: '==' },
  { label: '行内代码', icon: Code2, group: '文本格式', kind: 'wrap', prefix: '`', suffix: '`' },
  { label: '正文', icon: Heading, group: '段落与标题', kind: 'heading', text: '0' },
  ...Array.from({ length: 6 }, (_, index): Action => ({ label: `标题 ${index + 1}`, icon: Heading, group: '段落与标题', kind: 'heading', text: String(index + 1) })),
  { label: '引用', icon: Quote, group: '段落与标题', kind: 'line', prefix: '> ' },
  { label: '无序列表', icon: List, group: '段落与标题', kind: 'line', prefix: '- ' },
  { label: '有序列表', icon: ListOrdered, group: '段落与标题', kind: 'line', prefix: '1. ' },
  { label: '任务列表', icon: CheckSquare2, group: '段落与标题', kind: 'line', prefix: '- [ ] ' },
  { label: '减少缩进', icon: IndentDecrease, group: '段落与标题', kind: 'indent', text: 'out' },
  { label: '增加缩进', icon: IndentIncrease, group: '段落与标题', kind: 'indent', text: 'in' },
  { label: '链接', icon: Link2, group: '插入', kind: 'wrap', prefix: '[', suffix: '](url)' },
  { label: '双向链接', icon: Link2, group: '插入', kind: 'wrap', prefix: '[[', suffix: ']]' },
  { label: '标签', icon: Tag, group: '插入', kind: 'insert', text: '#标签' },
  { label: '图片', icon: Image, group: '插入', kind: 'wrap', prefix: '![', suffix: '](url)' },
  { label: '代码块', icon: Code2, group: '插入', kind: 'wrap', prefix: '```\n', suffix: '\n```' },
  { label: '表格', icon: Table2, group: '插入', kind: 'insert', text: '| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |' },
  { label: '分隔线', icon: Minus, group: '插入', kind: 'insert', text: '\n---\n' },
  { label: '撤销', icon: Undo2, group: '编辑', kind: 'history', text: 'undo' },
  { label: '重做', icon: Redo2, group: '编辑', kind: 'history', text: 'redo' },
  { label: '剪切', icon: Scissors, group: '编辑', kind: 'clipboard', text: 'cut' },
  { label: '复制', icon: Copy, group: '编辑', kind: 'clipboard', text: 'copy' },
  { label: '粘贴', icon: ClipboardPaste, group: '编辑', kind: 'clipboard', text: 'paste' },
  { label: '以纯文本形式粘贴', icon: Clipboard, group: '编辑', kind: 'clipboard', text: 'paste' },
  { label: '全选', icon: CheckSquare2, group: '编辑', kind: 'select' },
];

function replaceSelection(view: EditorView, prefix: string, suffix: string) {
  const { from, to } = view.state.selection.main;
  const doc = view.state.doc;
  const selected = doc.sliceString(from, to);
  if (selected.startsWith(prefix) && selected.endsWith(suffix) && selected.length >= prefix.length + suffix.length) {
    const inner = selected.slice(prefix.length, selected.length - suffix.length);
    view.dispatch({ changes: { from, to, insert: inner }, selection: { anchor: from, head: from + inner.length } });
  } else if (from >= prefix.length && doc.sliceString(from - prefix.length, from) === prefix && doc.sliceString(to, to + suffix.length) === suffix) {
    view.dispatch({
      changes: [{ from: from - prefix.length, to: from, insert: '' }, { from: to, to: to + suffix.length, insert: '' }],
      selection: { anchor: from - prefix.length, head: to - prefix.length },
    });
  } else {
    view.dispatch({
      changes: { from, to, insert: prefix + selected + suffix },
      selection: { anchor: from + prefix.length, head: from + prefix.length + selected.length },
    });
  }
  view.focus();
}

function editLines(view: EditorView, prefix: string, indent?: 'in' | 'out') {
  const { doc, selection } = view.state;
  const range = selection.main;
  const first = doc.lineAt(range.from).number;
  const last = doc.lineAt(range.to > range.from && doc.lineAt(range.to).from === range.to ? range.to - 1 : range.to).number;
  const lines = Array.from({ length: last - first + 1 }, (_, index) => doc.line(first + index));
  const allMatch = !indent && lines.every(line => line.text.startsWith(prefix));
  const changes = lines.flatMap(line => {
    const current = line.text;
    if (indent === 'in') return [{ from: line.from, insert: '  ' }];
    if (indent === 'out') {
      const match = current.match(/^(?: {2}|\t)/);
      return match ? [{ from: line.from, to: line.from + match[0].length, insert: '' }] : [];
    }
    const existing = current.match(/^(?:>\s?|-\s+\[[ xX]\]\s+|[-*+]\s+|\d+\.\s+|#{1,6}\s+)/);
    if (allMatch || !prefix) return [{ from: line.from, to: line.from + (!prefix ? existing?.[0].length ?? 0 : prefix.length), insert: '' }];
    return [{ from: line.from, to: line.from + (existing?.[0].length ?? 0), insert: prefix }];
  });
  if (!changes.length) return;
  const transaction = view.state.update({ changes });
  view.dispatch({
    changes,
    selection: {
      anchor: transaction.changes.mapPos(range.anchor, 1),
      head: transaction.changes.mapPos(range.head, 1),
    },
  });
  view.focus();
}

async function applyAction(view: EditorView, action: Action) {
  if (action.kind === 'history') {
    (action.text === 'undo' ? undo : redo)(view);
    view.focus();
  } else if (action.kind === 'wrap') {
    replaceSelection(view, action.prefix ?? '', action.suffix ?? '');
  } else if (action.kind === 'line' || action.kind === 'heading') {
    editLines(view, action.kind === 'heading' ? Number(action.text) ? `${'#'.repeat(Number(action.text))} ` : '' : action.prefix ?? '');
  } else if (action.kind === 'indent') {
    editLines(view, '', action.text as 'in' | 'out');
  } else if (action.kind === 'select') {
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    view.focus();
  } else if (action.kind === 'clipboard') {
    const { from, to } = view.state.selection.main;
    if (action.text === 'paste') {
      const text = await navigator.clipboard.readText();
      view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
    } else if (from !== to) {
      await navigator.clipboard.writeText(view.state.doc.sliceString(from, to));
      if (action.text === 'cut') view.dispatch({ changes: { from, to, insert: '' }, selection: { anchor: from } });
    }
    view.focus();
  } else {
    const { from, to } = view.state.selection.main;
    const text = action.text ?? '';
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
    view.focus();
  }
}

export function MarkdownContextMenu({ view, position, onClose }: { view: EditorView; position: { x: number; y: number }; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [error, setError] = useState('');
  const [keyboardInset, setKeyboardInset] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [origin, setOrigin] = useState(position);
  const available = actions.filter(action => action.label.toLowerCase().includes(query.trim().toLowerCase()) &&
    (!['cut', 'copy'].includes(action.text ?? '') || !view.state.selection.main.empty));

  useEffect(() => {
    if (!window.matchMedia('(max-width: 720px)').matches) searchRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        view.focus();
      }
    };
    const closeOnScroll = (event: Event) => { if (!panelRef.current?.contains(event.target as Node)) onClose(); };
    window.addEventListener('keydown', closeOnEscape, true);
    window.addEventListener('scroll', closeOnScroll, true);
    return () => {
      window.removeEventListener('keydown', closeOnEscape, true);
      window.removeEventListener('scroll', closeOnScroll, true);
    };
  }, [onClose, view]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    setOrigin({
      x: Math.max(12, Math.min(position.x, window.innerWidth - panel.offsetWidth - 12)),
      y: Math.max(12, Math.min(position.y, window.innerHeight - panel.offsetHeight - 12)),
    });
  }, [position]);

  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => setKeyboardInset(viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0);
    update();
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    return () => {
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
    };
  }, []);

  async function run(action: Action) {
    try {
      await applyAction(view, action);
      onClose();
    } catch {
      setError('剪贴板不可用，请检查浏览器权限。');
    }
  }

  return createPortal(<>
    <button type="button" className="markdown-context-backdrop" aria-label="关闭 Markdown 菜单" onClick={onClose} />
    <div ref={panelRef} className="markdown-context-menu" role="dialog" aria-label="Markdown 编辑菜单"
      style={{ left: origin.x, top: origin.y, '--keyboard-inset': `${keyboardInset}px` } as CSSProperties}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}>
      <div className="markdown-context-search"><Search size={17} aria-hidden="true" />
        <input ref={searchRef} aria-label="查找 Markdown 命令" value={query} onChange={event => { setQuery(event.target.value); setActive(0); }}
          onKeyDown={event => {
            if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => (index + 1) % Math.max(1, available.length)); }
            if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => (index - 1 + available.length) % Math.max(1, available.length)); }
            if (event.key === 'Enter' && available[active]) { event.preventDefault(); void run(available[active]); }
          }} placeholder="格式、标题、插入…" />
        {query ? <button type="button" aria-label="清除搜索" onClick={() => { setQuery(''); setActive(0); searchRef.current?.focus(); }}><X size={15} /></button> : <kbd>Esc</kbd>}
      </div>
      <div className="markdown-context-results">
        {['文本格式', '段落与标题', '插入', '编辑'].map(group => {
          const items = available.filter(action => action.group === group);
          return items.length ? <section key={group} aria-label={group}><h3>{group}</h3>
            {items.map(action => {
              const Icon = action.icon;
              return <button key={action.label} type="button" className={available.indexOf(action) === active ? 'is-active' : ''}
                onMouseEnter={() => setActive(available.indexOf(action))}
                onClick={() => void run(action)}><Icon size={17} strokeWidth={1.7} aria-hidden="true" />
                <span>{action.label}</span>{action.kind === 'heading' && Number(action.text) ? <small>H{action.text}</small> : null}</button>;
            })}
          </section> : null;
        })}
        {!available.length ? <p className="markdown-context-empty">没有匹配的命令</p> : null}
      </div>
      {error ? <p className="markdown-context-error" role="alert">{error}</p> : null}
    </div>
  </>, document.body);
}
