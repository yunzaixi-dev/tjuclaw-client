import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { syntaxTree } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { marked } from 'marked';
import { Check, ChevronRight, ClipboardPaste, Code2, Copy, Link2, List, ListChecks, ListOrdered, Quote, Scissors, Trash2 } from 'lucide-react';
import { actions, applyAction, type Action } from './markdown-actions';

// The note's right-click menu, after Typora: edit buttons, a format grid,
// then 段落 and 插入 submenus with their keyboard shortcuts.

const find = (label: string) => actions.find(action => action.label === label)!;
const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const shortcutLabel = (key: string) => (mac ? `⌘${key}` : `Ctrl+${key}`);

const HEADINGS = ['一级标题', '二级标题', '三级标题', '四级标题', '五级标题', '六级标题'];
const INSERTS: { label: string; action: string }[] = [
  { label: '图片', action: '图片' }, { label: '链接', action: '链接' }, { label: '双向链接', action: '双向链接' },
  { label: '表格', action: '表格' }, { label: '代码块', action: '代码块' }, { label: '公式块', action: '公式块' },
  { label: '分隔线', action: '分隔线' }, { label: '标签', action: '标签' },
];

/** Markdown reduced to its words, for "copy as plain text". */
function plainText(markdown: string) {
  return markdown
    .replace(/^```.*$/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+\.\s+)/gm, '')
    .replace(/(\*\*|__|~~|==|\*|_|`)/g, '');
}

/** What the caret is in: inline formats and the line's block type. */
function formatState(view: EditorView) {
  const { state } = view;
  const { from } = state.selection.main;
  const inside = new Set<string>();
  for (let node: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null = syntaxTree(state).resolveInner(from, -1); node; node = node.parent) inside.add(node.name);
  const line = state.doc.lineAt(from).text;
  const heading = /^ {0,3}(#{1,6})\s/.exec(line)?.[1].length ?? 0;
  return {
    加粗: inside.has('StrongEmphasis'),
    斜体: inside.has('Emphasis'),
    行内代码: inside.has('InlineCode'),
    链接: inside.has('Link'),
    引用: /^\s*>/.test(line),
    有序列表: /^\s*\d+[.)]\s/.test(line),
    无序列表: /^\s*[-*+]\s(?!\[[ xX]\])/.test(line),
    任务列表: /^\s*[-*+]\s\[[ xX]\]/.test(line),
    heading,
  } as Record<string, boolean | number>;
}

export function MarkdownContextMenu({ view, position, onClose }: { view: EditorView; position: { x: number; y: number }; onClose: () => void }) {
  const [error, setError] = useState('');
  const [submenu, setSubmenu] = useState<string | null>(null);
  const [keyboardInset, setKeyboardInset] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const [origin, setOrigin] = useState(position);
  const [compact] = useState(() => window.matchMedia('(max-width: 720px)').matches);
  const [formats] = useState(() => formatState(view));
  const hasSelection = !view.state.selection.main.empty;

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
      view.focus();
    };
    const closeOnScroll = (event: Event) => { if (!panelRef.current?.contains(event.target as Node)) onClose(); };
    window.addEventListener('keydown', closeOnEscape, true);
    window.addEventListener('scroll', closeOnScroll, true);
    return () => {
      window.removeEventListener('keydown', closeOnEscape, true);
      window.removeEventListener('scroll', closeOnScroll, true);
    };
  }, [onClose, view]);

  const [opensLeft, setOpensLeft] = useState(false);
  // Focus the menu itself once (Tab reaches its buttons) without ringing the first one.
  useEffect(() => { panelRef.current?.focus({ preventScroll: true }); }, []);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    // Room for a submenu on the right, or it opens to the left.
    setOpensLeft(position.x + panel.offsetWidth + 244 > window.innerWidth - 12);
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

  async function run(work: () => unknown) {
    try {
      await work();
      onClose();
    } catch {
      setError('剪贴板不可用，请检查浏览器权限。');
    }
  }
  const act = (action: Action) => void run(() => applyAction(view, action));
  const selectedText = () => {
    const { from, to } = view.state.selection.main;
    return view.state.doc.sliceString(from, to);
  };

  const icon = (label: string, Icon: typeof Copy, onClick: () => void, options: { disabled?: boolean; pressed?: boolean; glyph?: ReactNode } = {}) =>
    <button key={label} type="button" className="md-menu-icon" aria-label={label} title={label} disabled={options.disabled}
      aria-pressed={options.pressed === undefined ? undefined : options.pressed} onClick={onClick}>
      {options.glyph ?? <Icon size={17} strokeWidth={1.7} aria-hidden="true" />}
    </button>;

  const row = (id: string, label: string, children: ReactNode) => {
    const open = submenu === id;
    return <div className={`md-menu-branch${open ? ' is-open' : ''}`} onMouseEnter={() => { if (!compact) setSubmenu(id); }}>
      <button type="button" className="md-menu-row" aria-haspopup="menu" aria-expanded={open}
        onClick={() => setSubmenu(open ? null : id)}
        onKeyDown={event => { if (event.key === 'ArrowRight') { event.preventDefault(); setSubmenu(id); } }}>
        <span>{label}</span><ChevronRight size={14} aria-hidden="true" />
      </button>
      {open ? <div className="md-menu-sub" role="menu" aria-label={label}
        onKeyDown={event => { if (event.key === 'ArrowLeft') { event.preventDefault(); setSubmenu(null); } }}>{children}</div> : null}
    </div>;
  };
  const item = (label: string, onClick: () => void, options: { shortcut?: string; checked?: boolean; disabled?: boolean } = {}) =>
    <button key={label} type="button" role="menuitem" className="md-menu-item" disabled={options.disabled} onClick={onClick}>
      <span className="md-menu-check" aria-hidden="true">{options.checked ? <Check size={14} /> : null}</span>
      <span>{label}</span>{options.shortcut ? <kbd>{options.shortcut}</kbd> : null}
    </button>;

  return createPortal(<>
    <button type="button" className="markdown-context-backdrop" aria-label="关闭 Markdown 菜单" onClick={onClose} />
    <div ref={panelRef} className={`markdown-context-menu md-menu${compact ? ' is-compact' : ''}${opensLeft ? ' opens-left' : ''}`} role="dialog" aria-label="Markdown 编辑菜单" tabIndex={-1}
      style={{ left: origin.x, top: origin.y, '--keyboard-inset': `${keyboardInset}px` } as CSSProperties}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}>
      <div className="md-menu-grid" role="group" aria-label="编辑" onMouseEnter={() => setSubmenu(null)}>
        {icon('剪切', Scissors, () => act(find('剪切')), { disabled: !hasSelection })}
        {icon('复制', Copy, () => act(find('复制')), { disabled: !hasSelection })}
        {icon('粘贴', ClipboardPaste, () => act(find('粘贴')))}
        {icon('删除', Trash2, () => void run(() => {
          const { from, to } = view.state.selection.main;
          view.dispatch({ changes: { from, to, insert: '' }, selection: { anchor: from } });
          view.focus();
        }), { disabled: !hasSelection })}
      </div>
      {row('copy', '复制／粘贴为…', <>
        {item('复制为 Markdown', () => act(find('复制')), { disabled: !hasSelection })}
        {item('复制为纯文本', () => void run(() => navigator.clipboard.writeText(plainText(selectedText()))), { disabled: !hasSelection })}
        {item('复制为 HTML', () => void run(async () => navigator.clipboard.writeText(await marked.parse(selectedText()))), { disabled: !hasSelection })}
        <hr />
        {item('粘贴为纯文本', () => act(find('粘贴')))}
      </>)}
      <hr />
      <div className="md-menu-grid" role="group" aria-label="格式" onMouseEnter={() => setSubmenu(null)}>
        {icon('加粗', Copy, () => act(find('加粗')), { pressed: Boolean(formats.加粗), glyph: <b aria-hidden="true">B</b> })}
        {icon('斜体', Copy, () => act(find('斜体')), { pressed: Boolean(formats.斜体), glyph: <i aria-hidden="true">I</i> })}
        {icon('行内代码', Code2, () => act(find('行内代码')), { pressed: Boolean(formats.行内代码) })}
        {icon('链接', Link2, () => act(find('链接')), { pressed: Boolean(formats.链接) })}
        {icon('引用', Quote, () => act(find('引用')), { pressed: Boolean(formats.引用) })}
        {icon('有序列表', ListOrdered, () => act(find('有序列表')), { pressed: Boolean(formats.有序列表) })}
        {icon('无序列表', List, () => act(find('无序列表')), { pressed: Boolean(formats.无序列表) })}
        {icon('任务列表', ListChecks, () => act(find('任务列表')), { pressed: Boolean(formats.任务列表) })}
      </div>
      <hr />
      {row('paragraph', '段落', <>
        {HEADINGS.map((label, index) => item(label, () => act(find(`标题 ${index + 1}`)), { shortcut: shortcutLabel(String(index + 1)), checked: formats.heading === index + 1 }))}
        <hr />
        {item('段落', () => act(find('正文')), { shortcut: shortcutLabel('0'), checked: formats.heading === 0 })}
        <hr />
        {item('增加缩进', () => act(find('增加缩进')))}
        {item('减少缩进', () => act(find('减少缩进')))}
      </>)}
      {row('insert', '插入', <>{INSERTS.map(({ label, action }) => item(label, () => act(find(action))))}</>)}
      {error ? <p className="markdown-context-error" role="alert">{error}</p> : null}
    </div>
  </>, document.body);
}
