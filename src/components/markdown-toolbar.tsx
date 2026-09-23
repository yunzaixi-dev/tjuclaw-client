import { useEffect, useState, type CSSProperties } from 'react';
import { redo, undo } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import {
  Bold, CheckSquare2, ChevronDown, Code2, CornerDownLeft, Heading,
  Highlighter, Image, IndentDecrease, IndentIncrease, Italic, Link2,
  List, ListOrdered, Minus, Quote, Redo2, Strikethrough,
  Table2, Tag, Undo2, X, type LucideIcon,
} from 'lucide-react';

type Action = {
  label: string;
  icon?: LucideIcon;
  text?: string;
  kind: 'wrap' | 'line' | 'insert' | 'indent' | 'history' | 'heading';
  prefix?: string;
  suffix?: string;
};

const actions: Action[] = [
  { label: '撤销', icon: Undo2, kind: 'history', text: 'undo' },
  { label: '重做', icon: Redo2, kind: 'history', text: 'redo' },
  { label: '标题', icon: Heading, kind: 'heading' },
  { label: '加粗', icon: Bold, kind: 'wrap', prefix: '**', suffix: '**' },
  { label: '斜体', icon: Italic, kind: 'wrap', prefix: '*', suffix: '*' },
  { label: '删除线', icon: Strikethrough, kind: 'wrap', prefix: '~~', suffix: '~~' },
  { label: '高亮', icon: Highlighter, kind: 'wrap', prefix: '==', suffix: '==' },
  { label: '行内代码', icon: Code2, kind: 'wrap', prefix: '`', suffix: '`' },
  { label: '引用', icon: Quote, kind: 'line', prefix: '> ' },
  { label: '无序列表', icon: List, kind: 'line', prefix: '- ' },
  { label: '有序列表', icon: ListOrdered, kind: 'line', prefix: '1. ' },
  { label: '任务列表', icon: CheckSquare2, kind: 'line', prefix: '- [ ] ' },
  { label: '减少缩进', icon: IndentDecrease, kind: 'indent', text: 'out' },
  { label: '增加缩进', icon: IndentIncrease, kind: 'indent', text: 'in' },
  { label: '链接', icon: Link2, kind: 'wrap', prefix: '[', suffix: '](url)' },
  { label: '标签', icon: Tag, kind: 'insert', text: '#标签' },
  { label: '图片', icon: Image, kind: 'wrap', prefix: '![', suffix: '](url)' },
  { label: '双向链接', icon: Link2, kind: 'wrap', prefix: '[[', suffix: ']]' },
  { label: '代码块', icon: Code2, kind: 'wrap', prefix: '```\n', suffix: '\n```' },
  { label: '表格', icon: Table2, kind: 'insert', text: '| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |' },
  { label: '分隔线', icon: Minus, kind: 'insert', text: '\n---\n' },
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

function applyAction(view: EditorView, action: Action, headingLevel?: number) {
  if (action.kind === 'history') {
    (action.text === 'undo' ? undo : redo)(view);
    view.focus();
  } else if (action.kind === 'wrap') {
    replaceSelection(view, action.prefix ?? '', action.suffix ?? '');
  } else if (action.kind === 'line' || action.kind === 'heading') {
    editLines(view, action.kind === 'heading' ? headingLevel ? `${'#'.repeat(headingLevel)} ` : '' : action.prefix ?? '');
  } else if (action.kind === 'indent') {
    editLines(view, '', action.text as 'in' | 'out');
  } else {
    const { from, to } = view.state.selection.main;
    const text = action.text ?? '';
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
    view.focus();
  }
}

function keyboardInset() {
  const viewport = window.visualViewport;
  return viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0;
}

export function MarkdownToolbar({ view }: { view: EditorView }) {
  const [headingOpen, setHeadingOpen] = useState(false);
  const [inset, setInset] = useState(keyboardInset);

  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => setInset(keyboardInset());
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  return <div className="markdown-format-dock" style={{ '--editor-keyboard-inset': `${inset}px` } as CSSProperties}>
    <div className="markdown-format-toolbar" role="toolbar" aria-label="Markdown 格式工具栏">
      {actions.map((action, index) => {
        const Icon = action.icon;
        return <div className={`markdown-format-item${index === 2 || index === 8 || index === 15 ? ' is-group-start' : ''}`} key={action.label}>
          <button type="button" title={action.label} aria-label={action.label} aria-expanded={action.kind === 'heading' ? headingOpen : undefined}
            onPointerDown={event => event.preventDefault()}
            onClick={() => action.kind === 'heading' ? setHeadingOpen(open => !open) : (applyAction(view, action), setHeadingOpen(false))}>
            {Icon ? <Icon size={17} strokeWidth={1.8} /> : action.text}<span className="sr-only">{action.label}</span>
          </button>
          {action.kind === 'heading' ? <ChevronDown size={10} className="markdown-format-chevron" aria-hidden="true" /> : null}
        </div>;
      })}
      {headingOpen ? <div className="markdown-heading-menu" role="menu" aria-label="标题级别">
        {[0, 1, 2, 3, 4, 5, 6].map(level => <button key={level} type="button" role="menuitem"
          onPointerDown={event => event.preventDefault()}
          onClick={() => { applyAction(view, actions[2], level); setHeadingOpen(false); }}>
          {level ? `标题 ${level}` : '正文'}
        </button>)}
      </div> : null}
    </div>
    <button className="markdown-dismiss-keyboard" type="button" title="收起键盘" aria-label="收起键盘"
      onPointerDown={event => event.preventDefault()} onClick={() => view.contentDOM.blur()}><CornerDownLeft size={18} /><X size={10} /></button>
  </div>;
}
