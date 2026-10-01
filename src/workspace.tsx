import { Fragment, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowLeft, ArrowUp, ArrowRight, BookOpen, Check, CheckSquare, History, SquareStack, ChevronDown, ChevronRight, Copy, FileText, FilePlus2, Folder, FolderInput, FolderOpen, FolderPlus, ListTree, Network, PanelLeft, Plus, Search, SquarePen, House, LibraryBig, MessageCircle, Settings, StickyNote, Trash2, X, Eye, Pencil, MoreHorizontal, Quote, Table2, MoveRight, Wrench, FileUp, FilePenLine, Paperclip } from 'lucide-react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { loadMath, mathML, mathReady } from './components/markdown-extras';
import { highlightHtml, onHighlighterLoaded } from './lib/code-highlight';
import { renderMermaidBlocks } from './lib/mermaid-render';
import { EditorView } from '@codemirror/view';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { Button } from './components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './components/ui/dialog';
import { MarkdownEditor } from './components/markdown-editor';
import { openingHoldMs, openingWasVisible, WorkspaceLoading, type LoadStep } from './components/workspace-loading';
import { OperationProgress } from './components/operation-progress';
import { agentRuntime, sendLocalTurn } from './lib/local-sandbox';
import { getGitStatus, gitStatusLabel, type GitStatus } from './lib/git-history';
import { BrandIcon } from './components/brand-icon';
import { EMPTY_RICH_TEXT } from './lib/rich-text';
import { clearPrivateDrafts, hasPrivateDrafts } from './components/private-notebook';
import { type SettingsSection } from './components/workspace-settings';
import { WorkspacePassphraseGate } from './components/workspace-passphrase-gate';
import { builtInPlugins, WorkspacePlugins, type BuiltInPluginId } from './components/workspace-plugins';
import { campusToolList, type CampusToolId } from './components/campus-tool-list';
import { createCard as createAnkiCard, createDeck, deckStudySummary, deleteCard as deleteAnkiCard, deleteDeck as deleteAnkiDeck, exportDeck as exportAnkiDeck, getReviewRequest, importDeck as importAnkiDeck, listCards as listAnkiCards, listDecks, patchCard as patchAnkiCard, renameDeck as renameAnkiDeck, reviewCard as reviewAnkiCard, type AnkiCard as RemoteAnkiCard, type AnkiDeck as RemoteAnkiDeck } from './lib/anki';
import { type AnkiCard, type AnkiSchedule, type AnkiWorkspaceHandle } from './components/anki-workspace';
import { AuthError, logout, readSession, type IdentitySession } from './lib/auth';
import { VaultError } from './lib/sealed-vault';
import { createEntry, describeLibraryError, createFolder as createFolderRemote, createSession, deleteEntry, deleteFolder as deleteFolderRemote, getEntry, getSession, listEntries, listLibraries, listSessions, moveEntry as moveEntryRemote, patchEntry, patchFolder, reorderEntries, sendMessage, uploadFile, getModel, type AgentCapabilities, type ChatSession, type Entry, type Library } from './lib/library';
import { clearEntryCache, enableEntryReplica, hydrateEntryCache, justLoaded, loadEntry, localNote, openEntryCache, peekNote, pruneEntryCache, rememberEntry, warmEntry } from './lib/entry-cache';
import { clearRemoteWorkspaceUnlocks, clearWorkspaceUnlock, workspacePassphraseState, workspaceVerification, type WorkspacePassphraseState } from './lib/workspace-vault';
import './product.css';
import './workspace.css';
import './obsidian-shell.css';

type VaultFolder = { id: string; name: string; parentId: string | null };
type VaultPlacement = Record<string, string | null>;
type SidebarView = 'notes' | 'sessions' | 'anki' | 'plugins' | 'tools';
type SortMode = 'manual' | 'name-asc' | 'name-desc' | 'recent';
type SidebarSort = Record<SidebarView, SortMode>;
type Sortable = { id: string; title: string; updated_at?: string };
type ContextMenuState = { x: number; y: number; kind: 'folder' | 'note' | 'file' | 'editor' | 'sidebar' | 'session'; id?: string; group?: string } | null;
type WorkspaceGateState = { workspaceId: string | null; workspaceName: string; mode: WorkspacePassphraseState['mode']; verification: WorkspacePassphraseState['verification']; firstWorkspace?: boolean } | null;
const ACTIVITY_RAIL_WIDTH = 48;
const defaultSidebarSort: SidebarSort = { notes: 'manual', sessions: 'manual', anki: 'manual', plugins: 'manual', tools: 'manual' };
const sortLabels: Record<SortMode, string> = { manual: '手动排序', 'name-asc': '名称 A → Z', 'name-desc': '名称 Z → A', recent: '最近修改' };
const nameCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
const RichTextEditor = lazy(() => import('./components/rich-text-editor'));
const AgentThread = lazy(() => import('./components/agent-thread').then(module => ({ default: module.AgentThread })));
const NoteHistory = lazy(() => import('./components/note-history').then(module => ({ default: module.NoteHistory })));
const SearchPalette = lazy(() => import('./components/search-palette').then(module => ({ default: module.SearchPalette })));
const PagedReader = lazy(() => import('./components/paged-reader').then(module => ({ default: module.PagedReader })));
const FilePreview = lazy(() => import('./components/file-preview').then(module => ({ default: module.FilePreview })));
const KnowledgeGraph = lazy(() => import('./components/knowledge-graph').then(module => ({ default: module.KnowledgeGraph })));
const WorkspaceSettings = lazy(() => import('./components/workspace-settings').then(module => ({ default: module.WorkspaceSettings })));
const AnkiWorkspace = lazy(() => import('./components/anki-workspace').then(module => ({ default: module.AnkiWorkspace })));
const CampusTools = lazy(() => import('./components/campus-tools').then(module => ({ default: module.CampusTools })));

function orderedItems<T extends Sortable>(items: T[], mode: SortMode, order: string[] = []): T[] {
  const positions = new Map(order.map((id, index) => [id, index]));
  return items.slice().sort((a, b) => {
    if (mode === 'manual') {
      const left = positions.get(a.id);
      const right = positions.get(b.id);
      if (left !== undefined || right !== undefined) return (left ?? Infinity) - (right ?? Infinity);
      return 0;
    }
    if (mode === 'recent') {
      const difference = (b.updated_at ?? '').localeCompare(a.updated_at ?? '');
      if (difference) return difference;
    }
    const byName = nameCollator.compare(a.title, b.title);
    return (mode === 'name-desc' ? -byName : byName) || nameCollator.compare(a.id, b.id);
  });
}

function noteOrdersFromEntries(entries: Entry[]): Record<string, string[]> {
  const kinds = new Map(entries.map(entry => [entry.id, entry.kind]));
  const groups: Record<string, Entry[]> = {};
  for (const entry of entries) {
    if (entry.kind !== 'note' && entry.kind !== 'rich_text' && entry.kind !== 'file' && entry.kind !== 'folder') continue;
    const parentKind = kinds.get(entry.parent_id);
    const group = !entry.parent_id ? 'notes:root'
      : parentKind === 'folder' ? `notes:folder:${entry.parent_id}` : `notes:entry:${entry.parent_id}`;
    (groups[group] ??= []).push(entry);
  }
  return Object.fromEntries(Object.entries(groups).map(([group, children]) => [
    group,
    children.sort((a, b) => {
      const left = a.sort_order || Infinity;
      const right = b.sort_order || Infinity;
      return left - right || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
    }).map(entry => `${entry.kind === 'folder' ? 'folder' : 'entry'}:${entry.id}`),
  ]));
}

function defaultContentPaneWidth() {
  return Math.min(340, Math.max(245, Math.round((window.innerWidth - ACTIVITY_RAIL_WIDTH) * 0.191)));
}

function WorkspaceContextMenu({ menu, onClose, onAction }: { menu: Exclude<ContextMenuState, null>; onClose: () => void; onAction: (action: string) => void }) {
  const icons: Record<string, ReactNode> = {
    'new-note': <FilePlus2 size={18} />,
    'new-rich': <FilePenLine size={18} />,
    'upload-file': <FileUp size={18} />,
    'new-folder': <FolderPlus size={18} />,
    open: <FileText size={18} />,
    outline: <ListTree size={18} />,
    move: <FolderInput size={18} />,
    rename: <Pencil size={18} />,
    delete: <Trash2 size={18} />,
    copy: <Copy size={18} />,
    'select-all': <CheckSquare size={18} />,
    'move-up': <ArrowUp size={18} />,
    'move-down': <ArrowDown size={18} />,
    'new-chat': <SquarePen size={18} />,
    history: <History size={18} />,
    search: <Search size={18} />,
  };
  const items = menu.kind === 'folder'
    ? [['new-note', '新建笔记'], ['new-rich', '新建富文本文档'], ['upload-file', '上传文件'], ['new-folder', '新建文件夹'], ['divider', ''], ['move-up', '上移'], ['move-down', '下移'], ['divider', ''], ['rename', '重命名'], ['delete', '删除']]
    : menu.kind === 'file'
      ? [['open', '预览'], ['move', '移动到…'], ['divider', ''], ['move-up', '上移'], ['move-down', '下移'], ['divider', ''], ['rename', '重命名'], ['delete', '删除']]
    : menu.kind === 'note'
      ? [['open', '打开'], ['outline', '大纲'], ['move', '移动到…'], ['divider', ''], ['move-up', '上移'], ['move-down', '下移'], ['divider', ''], ['rename', '重命名'], ['delete', '删除']]
      : menu.kind === 'sidebar' ? [['move-up', '上移'], ['move-down', '下移']]
        : menu.kind === 'session' ? [['new-chat', '新会话'], ['history', '历史会话'], ['search', '搜索']]
          : [['copy', '复制 Markdown'], ['select-all', '全选']];
  return <div className="workspace-context-menu" style={{ left: menu.x, top: menu.y }} role="menu" aria-label={menu.kind === 'session' ? '会话操作' : '文档操作'} onContextMenu={event => event.preventDefault()}>
    {items.map(([action, label], index) => action === 'divider'
      ? <div className="workspace-context-divider" key={`divider-${index}`} />
      : <button key={action} type="button" className={action === 'delete' ? 'is-danger' : ''} role="menuitem" onClick={() => { onAction(action); onClose(); }}>{icons[action]}<span>{label}</span></button>)}
  </div>;
}

function TreeItem({ entry, entries, group, selectedId, onSelect, onContextMenu, orderChildren, dragProps }: { entry: Entry; entries: Entry[]; group: string; selectedId: string | null; onSelect: (id: string) => void; onContextMenu: (event: MouseEvent, kind: 'note' | 'file', id: string, group?: string) => void; orderChildren: (items: Entry[], group: string) => Entry[]; dragProps: (id: string, group: string) => React.HTMLAttributes<HTMLDivElement> & { draggable: boolean } }) {
  const [open, setOpen] = useState(true);
  const children = orderChildren(entries.filter(item => item.parent_id === entry.id && (item.kind === 'note' || item.kind === 'rich_text' || item.kind === 'file')), `notes:entry:${entry.id}`);
  return <div className="obsidian-tree-node">
    <div className={`obsidian-tree-row${selectedId === entry.id ? ' is-active' : ''}`} role="treeitem" aria-label={entry.title || '未命名笔记'} aria-selected={selectedId === entry.id} {...dragProps(`entry:${entry.id}`, group)} onContextMenu={event => onContextMenu(event, entry.kind === 'file' ? 'file' : 'note', `entry:${entry.id}`, group)}>
      {children.length ? <button className="tree-toggle" type="button" onClick={() => setOpen(value => !value)} aria-label="展开或折叠"><ChevronRight size={13} data-open={open ? 'true' : 'false'} /></button> : <span className="tree-spacer" />}
      <button className="tree-item" type="button" onPointerEnter={() => warmEntry(entry)} onFocus={() => warmEntry(entry)} onClick={() => onSelect(entry.id)}>{entry.kind === 'file' ? <Paperclip size={15} /> : entry.kind === 'rich_text' ? <FilePenLine size={15} /> : <FileText size={15} />}<span>{entry.title || '未命名笔记'}</span></button><button className="tree-more" type="button" onClick={event => onContextMenu(event, entry.kind === 'file' ? 'file' : 'note', `entry:${entry.id}`, group)} aria-label="文档操作"><MoreHorizontal size={14} /></button>
    </div>
    {open && children.length ? <div className="tree-children">{children.map(child => <TreeItem key={child.id} entry={child} entries={entries} group={`notes:entry:${entry.id}`} selectedId={selectedId} onSelect={onSelect} onContextMenu={onContextMenu} orderChildren={orderChildren} dragProps={dragProps} />)}</div> : null}
  </div>;
}

type WorkspaceTab = { key: string; kind: 'note' | 'rich_text' | 'file' | 'agent' | 'blank' | 'agent-blank' | 'anki' | 'tool'; title: string; entryId?: string; toolId?: CampusToolId; history: string[]; historyIndex: number };
const sampleCards: Array<{ front: string; back: string; tags: string }> = [
  { front: '什么是主动回忆？', back: '不看答案，先尝试从记忆中提取知识，再核对并修正。', tags: '学习方法 示例' },
  { front: '间隔复习的核心做法是什么？', back: '在遗忘前后分散复习，而不是集中在一天反复阅读。', tags: '学习方法 示例' },
  { front: 'Markdown 中 [[笔记名]] 通常表示什么？', back: '指向另一篇笔记的内部链接，可以用来建立知识关联。', tags: 'Markdown 示例' },
  { front: '导数 f′(x) 的几何意义是什么？', back: '函数曲线在 x 处切线的斜率。', tags: '数学 示例' },
];
const ANKI_REVIEW_ID = /^[0-9a-f]{32}$/;
type PendingAnkiReview = { requestId: string; rating: 1 | 2 | 3 | 4; repsBefore: number };
type PendingChatRequest = { sessionId: string; id: string; content?: string; digest?: string };
function pendingChatKey(identity: string, sessionId: string) {
  return `tjuclaw.chat.pending.v1.${identity}.${sessionId}`;
}
async function chatDigest(content: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
function readPendingChat(identity: string, sessionId: string): PendingChatRequest | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(pendingChatKey(identity, sessionId)) ?? '');
    if (!value || typeof value !== 'object') return null;
    const pending = value as Record<string, unknown>;
    return pending.sessionId === sessionId && typeof pending.id === 'string' && ANKI_REVIEW_ID.test(pending.id) &&
      !Object.hasOwn(pending, 'content') &&
      (pending.digest === undefined || typeof pending.digest === 'string' && /^[0-9a-f]{64}$/.test(pending.digest))
      ? pending as PendingChatRequest : null;
  } catch { return null; }
}
function clearPendingChat(identity: string, sessionId: string, id: string) {
  if (readPendingChat(identity, sessionId)?.id === id) sessionStorage.removeItem(pendingChatKey(identity, sessionId));
}
function ankiReviewKey(identity: string, cardId: string) {
  return `tjuclaw.anki.review.pending.v1.${identity}.${cardId}`;
}
function readPendingAnkiReview(key: string): PendingAnkiReview | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? '');
    if (!value || typeof value !== 'object') return null;
    const pending = value as Record<string, unknown>;
    return typeof pending.requestId === 'string' && ANKI_REVIEW_ID.test(pending.requestId) &&
      (pending.rating === 1 || pending.rating === 2 || pending.rating === 3 || pending.rating === 4) &&
      typeof pending.repsBefore === 'number' && Number.isSafeInteger(pending.repsBefore) && pending.repsBefore >= 0
      ? pending as PendingAnkiReview : null;
  } catch { return null; }
}

/** Notion's "Edited …" line. */
/** Wall-clock time for event handlers (send deadlines), never for rendering. */
const clockNow = () => Date.now();

/** A conversation is named by its first question. */
function conversationTitle(session: ChatSession | null): string {
  const first = session?.messages?.find(message => message.role === 'user')?.content.trim().replace(/\s+/g, ' ');
  return first ? first.slice(0, 40) : '新对话';
}

function editedLabel(updatedAt: string) {
  const minutes = Math.floor((Date.now() - Date.parse(updatedAt)) / 60000);
  if (!Number.isFinite(minutes) || minutes < 1) return '刚刚编辑';
  if (minutes < 60) return `${minutes} 分钟前编辑`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} 小时前编辑`;
  return `编辑于 ${new Date(updatedAt).toLocaleDateString('zh-CN')}`;
}

function NewNoteHome({ entries, busy, onCreate, onCreateRich, onUpload, onOpen }: { entries: Entry[]; busy: boolean; onCreate: (title?: string, body?: string) => void; onCreateRich: () => void; onUpload: () => void; onOpen: (id: string) => void }) {
  const templates = [
    { title: '空白笔记', description: '从一个标题或一句想法开始', icon: FilePlus2, body: '' },
    { title: '项目记录', description: '目标、进展、风险和下一步', icon: Table2, body: '# 项目记录\n\n## 目标\n\n## 当前进展\n\n## 风险与阻塞\n\n## 下一步\n\n- [ ] ' },
    { title: '读书卡片', description: '把摘录和思考沉淀成知识', icon: Quote, body: '# 书名\n\n> 一句重要摘录\n\n## 我的理解\n\n## 关联笔记\n\n- [[' },
    { title: '每日复盘', description: '记录今天发生了什么', icon: CheckSquare, body: `# ${new Date().toLocaleDateString('zh-CN')}\n\n## 完成了什么\n\n- [ ] \n\n## 学到了什么\n\n## 明天要做什么\n\n- [ ] ` },
  ];
  const hour = new Date().getHours();
  const greeting = hour < 5 ? '夜深了' : hour < 11 ? '早上好' : hour < 13 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
  const recents = entries.filter(entry => entry.kind === 'note' || entry.kind === 'rich_text').slice().sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 8);
  const rows = [
    { key: 'blank', title: '空白笔记', description: '从一个标题开始', icon: FilePlus2, run: () => onCreate() },
    { key: 'rich', title: '富文本文档', label: '新建富文本文档', description: '所见即所得地整理内容', icon: FilePenLine, run: onCreateRich },
    { key: 'upload', title: '上传课程资料', description: '保留原件，支持预览', icon: FileUp, run: onUpload },
    ...templates.slice(1).map(template => ({ key: template.title, title: template.title, description: template.description, icon: template.icon, run: () => onCreate(template.title, template.body) })),
  ];
  return <section className="new-note-home notion-home">
    <h1 className="notion-home-greeting">{greeting}</h1>
    <div className="notion-section">
      <h2 className="notion-section-head">最近访问</h2>
      <div className="notion-recents" role="list">
        {recents.length ? recents.map(entry => <button type="button" role="listitem" key={entry.id} className="notion-recent-card" onClick={() => onOpen(entry.id)}>
          <span className="notion-recent-cover" aria-hidden="true" />
          <span className="notion-recent-icon" aria-hidden="true">{entry.kind === 'rich_text' ? <FilePenLine size={18} /> : <FileText size={18} />}</span>
          <strong>{entry.title || '未命名笔记'}</strong>
          <small>{new Date(entry.updated_at).toLocaleDateString('zh-CN')}</small>
        </button>) : <button type="button" disabled={busy} className="notion-recent-card is-empty" onClick={() => onCreate()}>
          <span className="notion-recent-cover" aria-hidden="true" />
          <span className="notion-recent-icon" aria-hidden="true"><Plus size={18} /></span>
          <strong>写下第一篇笔记</strong><small>最近打开的会显示在这里</small>
        </button>}
      </div>
    </div>
    <div className="notion-section">
      <h2 className="notion-section-head">新建</h2>
      <div className="notion-list">
        {rows.map(row => { const Icon = row.icon; return <button type="button" disabled={busy} key={row.key} aria-label={row.label ?? row.title} onClick={row.run}>
          <Icon size={18} aria-hidden="true" /><span>{row.title}</span><small>{row.description}</small>
        </button>; })}
      </div>
    </div>
  </section>;
}

/** Headings with their line, skipping fenced code, in document order. */
function parseHeadings(markdown: string) {
  let fence = '';
  return markdown.split('\n').flatMap((line, index) => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/)?.[1];
    if (marker && (!fence || marker[0] === fence[0] && marker.length >= fence.length)) { fence = fence ? '' : marker; return []; }
    if (fence) return [];
    const match = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    return match ? [{ id: `heading-${index}`, line: index, level: match[1].length, text: match[2].replace(/[*_`]/g, '') }] : [];
  });
}
type OutlineHeading = ReturnType<typeof parseHeadings>[number];
const NOTES_PANE_KEY = 'tjuclaw.sidebar.notes-pane.v1';
function storedNotesPane(): 'files' | 'outline' {
  try { return localStorage.getItem(NOTES_PANE_KEY) === 'outline' ? 'outline' : 'files'; } catch { return 'files'; }
}

// Original campus images load through the authenticated API proxy, so the
// client CSP stays img-src 'self'. Other external images are dropped.
const PROXIED_IMAGE_HOSTS = new Set(['qnhdpic.twt.edu.cn']);
let allowExternalImages = false;
function proxiedImage(node: Element) {
  if (node.tagName !== 'IMG') return;
  const src = node.getAttribute('src') ?? '';
  let url: URL | null = null;
  try { url = new URL(src); } catch { url = null; }
  if (url && url.protocol === 'https:' && PROXIED_IMAGE_HOSTS.has(url.hostname)) {
    node.setAttribute('src', `/api/media/image?url=${encodeURIComponent(url.href)}`);
    node.setAttribute('loading', 'lazy');
    node.setAttribute('decoding', 'async');
    node.setAttribute('referrerpolicy', 'no-referrer');
    node.setAttribute('data-original', url.href);
    if (!node.getAttribute('alt')) node.setAttribute('alt', '原图');
  } else if (url && url.protocol === 'https:' && allowExternalImages) {
    // The user's own notes may show images from the web; Agent replies may not
    // (a crafted reply could leak data through an image address).
    node.setAttribute('loading', 'lazy');
    node.setAttribute('referrerpolicy', 'no-referrer');
  } else if (!src.startsWith('data:') && !src.startsWith('/')) {
    node.removeAttribute('src');
  }
}

// $…$ and $$…$$ render as MathML once KaTeX has loaded; until then, as code.
const escapeHtml = (text: string) => text.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!);
const mathHtml = (tex: string, display: boolean) => mathML(tex, display) ?? `<code>${escapeHtml(tex)}</code>`;
// Code blocks: highlighted, with their language and a copy button; Mermaid
// blocks become diagrams after rendering (renderMermaidBlocks).
marked.use({ renderer: {
  code({ text, lang }) {
    const language = (lang ?? '').trim().split(/\s+/)[0] ?? '';
    const escaped = escapeHtml(text);
    if (language.toLowerCase() === 'mermaid') return `<div class="mermaid-block"><pre><code>${escaped}</code></pre></div>`;
    return `<div class="code-block"><div class="code-block-head"><span>${escapeHtml(language)}</span><button type="button" class="code-copy" aria-label="复制代码">复制</button></div><pre><code class="language-${escapeHtml(language)}">${highlightHtml(text, language)}</code></pre></div>`;
  },
} });

marked.use({ extensions: [
  {
    name: 'blockMath', level: 'block',
    start: (src: string) => src.indexOf('$$'),
    tokenizer(src: string) {
      const match = /^\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/.exec(src);
      return match ? { type: 'blockMath', raw: match[0], tex: match[1].trim() } : undefined;
    },
    renderer: token => `<div class="math-block">${mathHtml(token.tex as string, true)}</div>`,
  },
  {
    name: 'inlineMath', level: 'inline',
    start: (src: string) => src.indexOf('$'),
    tokenizer(src: string) {
      const match = /^\$(?![\s$])([^$\n]+?)(?<![\s\\])\$(?![\w$])/.exec(src);
      return match ? { type: 'inlineMath', raw: match[0], tex: match[1] } : undefined;
    },
    renderer: token => mathHtml(token.tex as string, false),
  },
] });

function renderMarkdown(markdown: string, externalImages = false) {
  const html = marked.parse(markdown, { gfm: true, breaks: true }) as string;
  DOMPurify.addHook('afterSanitizeAttributes', proxiedImage);
  allowExternalImages = externalImages;
  try {
    return DOMPurify.sanitize(html, { USE_PROFILES: { html: true, mathMl: true } });
  } finally {
    allowExternalImages = false;
    DOMPurify.removeHook('afterSanitizeAttributes');
  }
}

/** Message errors the API returns before storing the turn. */
const definiteChatRefusals = new Set(['local_docker_unavailable', 'local_sandbox_unavailable', 'model_unconfigured', 'quota_exceeded', 'quota_5h_exceeded', 'quota_7d_exceeded', 'quota_unavailable', 'sandbox_model_unavailable', 'upstream_blocked']);

export default function Workspace() {
  const [session, setSession] = useState<IdentitySession | null>(null);
  const [agentCapabilities, setAgentCapabilities] = useState<AgentCapabilities | null>(null);
  const sessionId = session?.id;
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    // Capabilities only shape suggestions and panels; failures leave the defaults.
    getModel(controller.signal).then(status => {
      if (!controller.signal.aborted) setAgentCapabilities(status.agent ?? null);
    }).catch(() => {
      if (!controller.signal.aborted) setAgentCapabilities(null);
    });
    return () => controller.abort();
  }, [sessionId]);
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [folders, setFolders] = useState<VaultFolder[]>([]);
  const [placements, setPlacements] = useState<VaultPlacement>({});
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<Entry | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [chat, setChat] = useState<ChatSession | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatSending, setChatSending] = useState(false);
  // The message being sent, shown optimistically until the server confirms it.
  const [pendingText, setPendingText] = useState('');
  const [chatError, setChatError] = useState('');
  const [draft, setDraft] = useState('');
  const [tabs, setTabs] = useState<WorkspaceTab[]>([{ key: 'home', kind: 'blank', title: '新建笔记', history: [], historyIndex: -1 }]);
  const [activeTabKey, setActiveTabKey] = useState<string | null>('home');
  // Searching happens in the search palette; the tree is never filtered.
  const query = '' as string;
  const [view, setView] = useState<SidebarView>('notes');
  const [sidebarSort, setSidebarSort] = useState<SidebarSort>(defaultSidebarSort);
  const [sidebarOrder, setSidebarOrder] = useState<Record<string, string[]>>({});
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [activePluginId, setActivePluginId] = useState<BuiltInPluginId>('editor');
  const [activeToolId, setActiveToolId] = useState<CampusToolId>('schedule');
  const [ankiCards, setAnkiCards] = useState<AnkiCard[]>([]);
  const [ankiSchedules, setAnkiSchedules] = useState<Record<string, AnkiSchedule>>({});
  const [ankiLastStudyAt, setAnkiLastStudyAt] = useState<number | null>(null);
  const [ankiDecks, setAnkiDecks] = useState<RemoteAnkiDeck[]>([]);
  const [ankiDeckId, setAnkiDeckId] = useState<string | null>(null);
  const [ankiDeckBusy, setAnkiDeckBusy] = useState(false);
  const [ankiOpenCardId, setAnkiOpenCardId] = useState<string | null>(null);
  const [ankiRemoteReady, setAnkiRemoteReady] = useState(false);
  const [ankiLoadFailed, setAnkiLoadFailed] = useState(false);
  const [legacyAnkiBackupAvailable, setLegacyAnkiBackupAvailable] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => typeof window === 'undefined' || window.innerWidth > 720);
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 720);
  const reduceMotion = useReducedMotion();
  const [railOpen, setRailOpen] = useState(false);
  const [activeHeading, setActiveHeading] = useState('');
  // Like Typora, the notes sidebar shows either the files or the outline.
  const [notesPane, setNotesPane] = useState<'files' | 'outline'>(storedNotesPane);
  const [collapsedHeadings, setCollapsedHeadings] = useState<Set<string>>(() => new Set());
  // Notion's sidebar sits around 256px on a laptop screen.
  const [sidebarWidth, setSidebarWidth] = useState(() => Math.min(280, Math.max(240, Math.round(window.innerWidth * 0.18))));
  const [railWidth, setRailWidth] = useState(defaultContentPaneWidth);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('appearance');
  const [graphOpen, setGraphOpen] = useState(false);
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [moveEntryId, setMoveEntryId] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<'edit' | 'preview'>('edit');
  // Reading views render math once KaTeX has loaded; this redraws them then.
  const [, setMathLoaded] = useState(mathReady());
  const [, setHighlightVersion] = useState(0);
  useEffect(() => onHighlighterLoaded(() => setHighlightVersion(version => version + 1)), []);
  // Diagrams render after each paint; copy buttons in code blocks copy their code.
  useEffect(() => { renderMermaidBlocks(document); });
  useEffect(() => {
    const copy = (event: globalThis.MouseEvent) => {
      const button = (event.target as Element | null)?.closest?.('.code-copy');
      const code = button?.closest('.code-block')?.querySelector('code')?.textContent;
      if (!button || code === undefined || code === null) return;
      void navigator.clipboard?.writeText(code).then(() => {
        button.textContent = '已复制';
        window.setTimeout(() => { button.textContent = '复制'; }, 1400);
      });
    };
    document.addEventListener('click', copy);
    return () => document.removeEventListener('click', copy);
  }, []);
  const needsMath = !mathReady() && (editorMode === 'preview' || view === 'sessions') && /\$/.test(editorMode === 'preview' ? body : JSON.stringify(chat?.messages ?? []));
  useEffect(() => {
    if (needsMath) void loadMath().then(() => setMathLoaded(true));
  }, [needsMath]);
  const [commandOpen, setCommandOpen] = useState(false);
  const [tabSheetOpen, setTabSheetOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [operations, setOperations] = useState<Record<string, string>>({});
  const operationLocks = useRef(new Map<string, symbol>());
  const noteRequestRef = useRef(0);

  function beginOperation(key: string, label: string) {
    if (operationLocks.current.has(key)) return null;
    const token = Symbol(key);
    const generation = identityGeneration.current;
    operationLocks.current.set(key, token);
    setOperations(current => ({ ...current, [key]: label }));
    return () => {
      if (operationLocks.current.get(key) !== token) return;
      operationLocks.current.delete(key);
      if (generation !== identityGeneration.current) return;
      setOperations(current => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    };
  }
  const failedSave = useRef<{ id: string; title: string; body: string; generation: number; version: number } | null>(null);
  const conflictDraft = useRef<{ id: string; title: string; body: string } | null>(null);
  const [saveFailedId, setSaveFailedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadStep, setLoadStep] = useState<LoadStep>('session');
  // Keep a visible opening screen up briefly after loading so it never
  // flickers; a load that finished before it appeared skips straight in.
  const [openingDone, setOpeningDone] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [restoreNonce, setRestoreNonce] = useState(0);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [entering] = useState(() => ({ fade: false }));
  const opened = !loading && Boolean(session);
  // The flashcards page keeps the notes sidebar: decks are listed with the notes.
  const sideView: SidebarView = view === 'anki' ? 'notes' : view;
  useEffect(() => {
    if (!opened) return;
    let stopped = false;
    const read = () => { getGitStatus().then(status => { if (!stopped) setGitStatus(status); }).catch(() => undefined); };
    read();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') read(); }, 15000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [opened, saving]);
  useEffect(() => {
    if (!opened || openingDone) return;
    const timer = window.setTimeout(() => {
      // Fade the page in only when it replaces a screen the user saw.
      entering.fade = openingWasVisible();
      setOpeningDone(true);
    }, openingHoldMs());
    return () => window.clearTimeout(timer);
  }, [opened, openingDone, entering]);
  const [workspaceGate, setWorkspaceGate] = useState<WorkspaceGateState>(null);
  const [error, setError] = useState('');
  const saveTimer = useRef<number>(0);
  const pendingSave = useRef<{ id: string; title: string; body: string; generation: number; version: number } | null>(null);
  const saveVersions = useRef<Record<string, number>>({});
  const entryRevisions = useRef<Record<string, string>>({});
  const conflictedEntries = useRef<Set<string>>(new Set());
  const [saveConflictId, setSaveConflictId] = useState<string | null>(null);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const draftsRef = useRef<Record<string, string>>({});
  const chatCacheRef = useRef<Record<string, ChatSession>>({});
  // Which conversation each Agent shows: a session ID, 'new' for a fresh one,
  // or nothing for the most recently active.
  const sessionChoiceRef = useRef<Record<string, string>>({});
  // Conversations are listed on their own; Agents are only where they are stored.
  const [conversations, setConversations] = useState<{ id: string; entryId: string; updatedAt: string; title?: string }[]>([]);
  const pendingChatRequestRef = useRef<PendingChatRequest | null>(null);
  const activeTabRef = useRef<string | null>('home');
  const identityRef = useRef<string | null>(null);
  const identityGeneration = useRef(0);
  const bodyRef = useRef<EditorView | null>(null);
  const ankiWorkspaceRef = useRef<AnkiWorkspaceHandle | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const [fileRenameRequest, setFileRenameRequest] = useState(0);
  const uploadRef = useRef<HTMLInputElement | null>(null);
  const uploadParent = useRef<string | undefined>(undefined);
  const chatRequestRef = useRef(0);
  const sendingRef = useRef(false);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const railRef = useRef<HTMLElement | null>(null);
  const dragSource = useRef<{ id: string; group: string } | null>(null);
  const sortMenuRef = useRef<HTMLDivElement | null>(null);
  const ankiRemoteIds = useRef<Set<string>>(new Set());
  const ankiPendingIds = useRef<Map<string, string>>(new Map());
  const ankiWriteQueue = useRef<Promise<void>>(Promise.resolve());
  const ankiCardsRef = useRef<AnkiCard[]>([]);
  const ankiDeckIdRef = useRef<string | null>(null);
  const ankiDeckRequest = useRef(0);
  const ankiDeckMutation = useRef(false);
  const ankiSyncHealthy = useRef(false);
  const pendingStudyDeckRef = useRef<string | null>(null);
  const attachAnkiWorkspace = useCallback((handle: AnkiWorkspaceHandle | null) => {
    ankiWorkspaceRef.current = handle;
    if (handle && pendingStudyDeckRef.current && pendingStudyDeckRef.current === ankiDeckIdRef.current) {
      pendingStudyDeckRef.current = null;
      handle.startStudy();
    }
  }, []);
  const library = libraries[0];
  const noteCount = entries.filter(entry => entry.kind === 'note' || entry.kind === 'rich_text').length;
  const fileCount = entries.filter(entry => entry.kind === 'note' || entry.kind === 'rich_text' || entry.kind === 'file').length;
  const activeTab = tabs.find(tab => tab.key === activeTabKey);
  const ankiDeckName = ankiDecks.find(deck => deck.id === ankiDeckId)?.name ?? '默认牌组';
  const visibleTabs = tabs.filter(tab => view === 'notes' ? tab.kind === 'note' || tab.kind === 'rich_text' || tab.kind === 'file' || tab.kind === 'blank'
    : view === 'sessions' ? tab.kind === 'agent' || tab.kind === 'agent-blank'
      : view === 'anki' ? tab.kind === 'anki' : view === 'tools' && tab.kind === 'tool');

  function chooseTab(key: string | null) {
    ++noteRequestRef.current;
    activeTabRef.current = key;
    setActiveTabKey(key);
  }

  function changeDraft(value: string) {
    if (selectedId) draftsRef.current[selectedId] = value;
    setDraft(value);
  }

  function flushPendingSave() {
    window.clearTimeout(saveTimer.current);
    const pending = pendingSave.current;
    if (!pending) return;
    pendingSave.current = null;
    saveChain.current = saveChain.current.catch(() => {}).then(async () => {
      if (pending.generation !== identityGeneration.current || conflictedEntries.current.has(pending.id)) return;
      try {
        const expected = entryRevisions.current[pending.id];
        if (!expected) throw new Error('entry revision unavailable');
        const entry = await patchEntry(pending.id, { title: pending.title, body: pending.body, expected_updated_at: expected });
        if (pending.generation !== identityGeneration.current) return;
        entryRevisions.current[entry.id] = entry.updated_at;
        rememberEntry(entry);
        if (saveVersions.current[entry.id] === pending.version) {
          if (failedSave.current?.id === entry.id) {
            failedSave.current = null;
            setSaveFailedId(null);
          }
          setEntries(items => items.map(item => item.id === entry.id ? entry : item));
          setSelected(current => current?.id === entry.id ? entry : current);
          setSaving(false);
        }
      } catch (cause) {
        if (pending.generation === identityGeneration.current) {
          if (saveVersions.current[pending.id] !== pending.version) return;
          if (cause instanceof AuthError && cause.status === 409 && cause.body?.error?.id === 'entry_conflict') {
            try {
              const latest = await getEntry(pending.id);
              if (pending.generation !== identityGeneration.current || saveVersions.current[pending.id] !== pending.version) return;
              if (latest.title === pending.title && latest.body === pending.body) {
                entryRevisions.current[latest.id] = latest.updated_at;
                if (failedSave.current?.id === latest.id) {
                  failedSave.current = null;
                  setSaveFailedId(null);
                }
                setEntries(items => items.map(item => item.id === latest.id ? latest : item));
                setSelected(current => current?.id === latest.id ? latest : current);
                setSaving(false);
                setError('');
                return;
              }
            } catch { /* The server result is unknown; retain the local draft. */ }
            if (pending.generation !== identityGeneration.current || saveVersions.current[pending.id] !== pending.version) return;
            setSaving(false);
            conflictDraft.current = { id: pending.id, title: pending.title, body: pending.body };
            conflictedEntries.current.add(pending.id);
            setSaveConflictId(pending.id);
            setError('笔记已在其他设备更新；当前编辑内容未覆盖服务器版本。');
          } else {
            setSaving(false);
            failedSave.current = pending;
            setSaveFailedId(pending.id);
            setError('保存失败，请稍后再试。');
          }
        }
      }
    });
  }

  function retryFailedSave() {
    const failed = failedSave.current;
    if (!failed || failed.generation !== identityGeneration.current || conflictedEntries.current.has(failed.id)) return;
    failedSave.current = null;
    setSaveFailedId(null);
    setError('');
    setSaving(true);
    pendingSave.current = failed;
    flushPendingSave();
  }

  function canLeaveDraft(destinationId?: string) {
    if ((saveConflictId || conflictedEntries.current.size) && destinationId !== saveConflictId) {
      setError('请先处理笔记保存冲突，再切换文档。');
      return false;
    }
    if ((saveFailedId || failedSave.current) && destinationId !== saveFailedId) {
      setError('当前笔记尚未保存，请重试保存后再切换文档。');
      return false;
    }
    return true;
  }

  async function copyConflictDraft() {
    try {
      const draft = conflictDraft.current;
      if (!draft || draft.id !== saveConflictId) return;
      await navigator.clipboard.writeText(`${draft.title}\n\n${draft.body}`);
      setError('当前版本已复制；加载服务器版本前请先保存副本。');
    } catch {
      setError('复制失败；请手动复制当前编辑内容后再加载服务器版本。');
    }
  }

  async function discardConflictDraft() {
    if (!saveConflictId || !window.confirm('确定丢弃当前未保存的编辑，并加载服务器上的版本吗？')) return;
    const generation = identityGeneration.current;
    try {
      const entry = await getEntry(saveConflictId);
      if (generation !== identityGeneration.current) return;
      entryRevisions.current[entry.id] = entry.updated_at;
      conflictedEntries.current.delete(entry.id);
      conflictDraft.current = null;
      setSaveConflictId(null);
      setEntries(items => items.map(item => item.id === entry.id ? entry : item));
      if (selectedId === entry.id) {
        setSelected(entry);
        setTitle(entry.title);
        setBody(entry.body ?? '');
      }
      setError('');
    } catch {
      setError('读取服务器版本失败，当前草稿仍在编辑器中。');
    }
  }

  function newBlankTab(forView: SidebarView = view) {
    if (!canLeaveDraft()) return;
    flushPendingSave();
    ++chatRequestRef.current;
    const key = `blank-${crypto.randomUUID()}`;
    const kind = forView === 'sessions' ? 'agent-blank' : forView === 'anki' ? 'anki' : forView === 'tools' ? 'tool' : 'blank';
    const title = kind === 'agent-blank' ? '新会话' : kind === 'anki' ? '记忆闪卡' : kind === 'tool' ? '课程表' : '新建笔记';
    setTabs(current => [...current, { key, kind, title, toolId: kind === 'tool' ? 'schedule' : undefined, history: [], historyIndex: -1 }]);
    chooseTab(key);
    setView(kind === 'agent-blank' ? 'sessions' : kind === 'anki' ? 'anki' : kind === 'tool' ? 'tools' : 'notes');
    if (kind === 'tool') setActiveToolId('schedule');
    setSelected(null); setSelectedId(null); setTitle(''); setBody('');
    setChat(null); setRailOpen(false);
    if (isMobile) setSidebarOpen(false);
    // A new conversation tab starts a fresh conversation (an empty one is reused).
    if (kind === 'agent-blank') void startNewChat(key, true);
  }

  function activateTab(tab: WorkspaceTab, preserveSidebar = false) {
    if (tab.key === activeTabRef.current && (view === 'notes' || view === 'sessions' || view === 'anki' || view === 'tools')) return;
    if (!canLeaveDraft(tab.entryId)) return;
    flushPendingSave();
    chooseTab(tab.key);
    if (tab.kind === 'blank' || tab.kind === 'agent-blank' || tab.kind === 'anki' || tab.kind === 'tool' || !tab.entryId) {
      ++chatRequestRef.current;
      setView(tab.kind === 'agent-blank' ? 'sessions' : tab.kind === 'anki' ? 'anki' : tab.kind === 'tool' ? 'tools' : 'notes');
      if (tab.kind === 'tool') setActiveToolId(tab.toolId ?? 'schedule');
      setSelected(null); setSelectedId(null); setTitle(''); setBody('');
      setChat(null); setRailOpen(false);
    } else {
      void openEntry(tab.entryId, undefined, tab.key, tab.historyIndex, preserveSidebar);
    }
  }

  function moveTabHistory(delta: number) {
    if (!activeTab) return;
    const index = activeTab.historyIndex + delta;
    const id = activeTab.history[index];
    if (id && entries.some(entry => entry.id === id)) void openEntry(id, undefined, activeTab.key, index);
  }

  function closeTab(key: string) {
    if (key === activeTabRef.current && !canLeaveDraft()) return;
    const index = tabs.findIndex(tab => tab.key === key);
    if (index < 0) return;
    const remaining = tabs.filter(tab => tab.key !== key);
    setTabs(remaining);
    if (activeTabRef.current !== key) return;
    flushPendingSave();
    const closed = tabs[index];
    const sameSection = remaining.filter(tab => closed.kind === 'tool' ? tab.kind === 'tool' : closed.kind === 'anki' ? tab.kind === 'anki'
      : closed.kind === 'agent' || closed.kind === 'agent-blank' ? tab.kind === 'agent' || tab.kind === 'agent-blank'
        : tab.kind === 'note' || tab.kind === 'rich_text' || tab.kind === 'file' || tab.kind === 'blank');
    const next = sameSection.find(tab => remaining.indexOf(tab) >= index) ?? sameSection[sameSection.length - 1];
    if (next) {
      chooseTab(null);
      activateTab(next);
    } else {
      ++chatRequestRef.current;
      chooseTab(null); setSelected(null); setSelectedId(null);
      setTitle(''); setBody(''); setChat(null); setRailOpen(false);
      setView(closed.kind === 'tool' ? 'tools' : closed.kind === 'anki' ? 'anki' : closed.kind === 'agent' || closed.kind === 'agent-blank' ? 'sessions' : 'notes');
    }
  }

  function localData<T>(key: string, fallback: T): T {
    if (!identityRef.current) return fallback;
    try { return JSON.parse(localStorage.getItem(`${key}.${identityRef.current}`) ?? '') as T; } catch { return fallback; }
  }

  function startResize(side: 'sidebar' | 'rail', event: React.PointerEvent<HTMLDivElement>) {
    if (window.innerWidth <= 1050) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = side === 'sidebar' ? sidebarWidth : railWidth;
    const update = (move: PointerEvent) => {
      const delta = move.clientX - startX;
      if (side === 'sidebar') setSidebarWidth(Math.min(420, Math.max(210, startWidth + delta)));
      else setRailWidth(Math.min(420, Math.max(210, startWidth - delta)));
    };
    const stop = () => {
      window.removeEventListener('pointermove', update);
      window.removeEventListener('pointerup', stop);
      document.body.classList.remove('is-resizing-panels');
    };
    document.body.classList.add('is-resizing-panels');
    window.addEventListener('pointermove', update);
    window.addEventListener('pointerup', stop, { once: true });
  }

  const visible = useMemo(() => entries.filter(entry => (view === 'notes' || view === 'anki' ? entry.kind === 'note' || entry.kind === 'rich_text' || entry.kind === 'file' : view === 'sessions' && entry.kind === 'agent') && (!query || entry.title.toLowerCase().includes(query.toLowerCase()))), [entries, query, view]);
  const roots = visible.filter(entry => !entry.parent_id && !placements[entry.id]);
  const folderRoots = folders.filter(folder => !folder.parentId);
  const headings = useMemo(() => parseHeadings(body), [body]);
  const outlineBase = headings.reduce((min, item) => Math.min(min, item.level), 6);

  function siblings(group: string): Sortable[] {
    if (group === 'notes:root' || group.startsWith('notes:folder:')) {
      const parentId = group === 'notes:root' ? null : group.slice('notes:folder:'.length);
      return [
        ...folders.filter(folder => folder.parentId === parentId).map(folder => ({ id: `folder:${folder.id}`, title: folder.name })),
        ...entries.filter(entry => (entry.kind === 'note' || entry.kind === 'rich_text' || entry.kind === 'file') && (placements[entry.id] ?? null) === parentId && (parentId !== null || !entry.parent_id))
          .map(entry => ({ id: `entry:${entry.id}`, title: entry.title, updated_at: entry.updated_at })),
      ];
    }
    if (group.startsWith('notes:entry:')) return entries.filter(entry => (entry.kind === 'note' || entry.kind === 'rich_text' || entry.kind === 'file') && entry.parent_id === group.slice('notes:entry:'.length))
      .map(entry => ({ id: `entry:${entry.id}`, title: entry.title, updated_at: entry.updated_at }));
    if (group === 'sessions') return entries.filter(entry => entry.kind === 'agent')
      .map(entry => ({ id: `entry:${entry.id}`, title: entry.title, updated_at: entry.updated_at }));
    if (group === 'anki') return ankiCards.map(card => ({ id: `card:${card.id}`, title: card.front || '未命名卡片' }));
    if (group === 'tools') return campusToolList.map(tool => ({ id: `tool:${tool.id}`, title: tool.name }));
    return builtInPlugins.map(plugin => ({ id: `plugin:${plugin.id}`, title: plugin.name }));
  }

  function orderChildren<T extends Sortable>(items: T[], group: string): T[] {
    return orderedItems(items, sidebarSort[view], sidebarOrder[group]);
  }

  function persistSidebarOrder(next: Record<string, string[]>) {
    setSidebarOrder(next);
    if (identityRef.current) localStorage.setItem(`tjuclaw.sidebar.order.v1.${identityRef.current}`, JSON.stringify(
      Object.fromEntries(Object.entries(next).filter(([group]) => !group.startsWith('notes:'))),
    ));
  }

  function changeSort(mode: SortMode) {
    const next = { ...sidebarSort, [sideView]: mode };
    setSidebarSort(next);
    if (identityRef.current) localStorage.setItem(`tjuclaw.sidebar.sort.v1.${identityRef.current}`, JSON.stringify(next));
    setSortMenuOpen(false);
  }

  function reorder(id: string, target: string, group: string, after: boolean) {
    const current = orderedItems(siblings(group), sidebarSort[view], sidebarOrder[group]).map(item => item.id);
    if (id === target || !current.includes(id) || !current.includes(target)) return;
    const next = current.filter(item => item !== id);
    next.splice(next.indexOf(target) + (after ? 1 : 0), 0, id);
    persistSidebarOrder({ ...sidebarOrder, [group]: next });
    if (library && group.startsWith('notes:')) {
      const parentId = group === 'notes:root' ? '' : group.startsWith('notes:folder:') ? group.slice('notes:folder:'.length) : group.slice('notes:entry:'.length);
      const entryIds = next.filter(item => item.startsWith('entry:') || item.startsWith('folder:')).map(item => item.slice(item.indexOf(':') + 1));
      void reorderEntries(library.id, parentId, entryIds).catch(() => {
        setSidebarOrder(value => ({ ...value, [group]: current }));
        setError('保存手动排序失败，已恢复原顺序，请稍后再试。');
      });
    }
    changeSort('manual');
  }

  function moveInSidebar(id: string, group: string, direction: -1 | 1) {
    const current = orderedItems(siblings(group), sidebarSort[view], sidebarOrder[group]).map(item => item.id);
    const index = current.indexOf(id);
    const target = current[index + direction];
    if (target) reorder(id, target, group, direction > 0);
  }

  function dragProps(id: string, group: string, targetFolder?: string): React.HTMLAttributes<HTMLDivElement> & { draggable: boolean } {
    return {
      draggable: !query,
      onDragStart: event => {
        if (query) { event.preventDefault(); return; }
        event.stopPropagation();
        dragSource.current = { id, group };
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', id);
      },
      onDragEnd: event => { event.stopPropagation(); dragSource.current = null; event.currentTarget.removeAttribute('data-drop'); },
      onDragOver: event => {
        const source = dragSource.current;
        if (!source || query || source.id === id) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const ratio = (event.clientY - rect.top) / rect.height;
        const position = targetFolder && ratio >= .25 && ratio <= .75 ? 'inside' : ratio < .5 ? 'before' : 'after';
        if (source.group !== group && position !== 'inside') return;
        if (position === 'inside' && !source.id.startsWith('entry:') && !source.id.startsWith('folder:')) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        event.currentTarget.dataset.drop = position;
      },
      onDragLeave: event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) event.currentTarget.removeAttribute('data-drop');
      },
      onDrop: event => {
        const position = event.currentTarget.dataset.drop;
        event.currentTarget.removeAttribute('data-drop');
        const source = dragSource.current;
        if (!source || !position) return;
        event.preventDefault();
        event.stopPropagation();
        if (position === 'inside' && targetFolder) {
          if (source.id.startsWith('entry:')) moveEntry(source.id.slice(6), targetFolder);
          if (source.id.startsWith('folder:')) moveFolder(source.id.slice(7), targetFolder);
          setOpenFolders(value => ({ ...value, [targetFolder]: true }));
        } else if (source.group === group) reorder(source.id, id, group, position === 'after');
        dragSource.current = null;
      },
    };
  }

  function openContextMenu(event: MouseEvent, kind: 'folder' | 'note' | 'file' | 'editor' | 'sidebar', id?: string, group?: string) {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: Math.max(8, Math.min(event.clientX, window.innerWidth - 250)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - (kind === 'sidebar' ? 100 : 360))), kind, id, group });
  }

  function handleContextAction(action: string) {
    if (!contextMenu) return;
    if ((action === 'move-up' || action === 'move-down') && contextMenu.id && contextMenu.group) {
      moveInSidebar(contextMenu.id, contextMenu.group, action === 'move-up' ? -1 : 1);
      return;
    }
    if (contextMenu.kind === 'folder' && contextMenu.id) {
      const folder = folders.find(item => item.id === contextMenu.id?.replace(/^folder:/, ''));
      if (!folder) return;
      if (action === 'new-folder') createFolder(folder.id);
      if (action === 'rename') renameFolder(folder);
      if (action === 'delete') removeFolder(folder);
      if (action === 'new-note') void createNote('未命名笔记', '', folder.id);
      if (action === 'new-rich') void createRichText(folder.id);
      if (action === 'upload-file') uploadPicker(folder.id);
    }
    if ((contextMenu.kind === 'note' || contextMenu.kind === 'file') && contextMenu.id) {
      const id = contextMenu.id.replace(/^entry:/, '');
      if (action === 'open') void openEntry(id);
      if (action === 'outline') setOutlineOpen(true);
      if (action === 'delete') void deleteNote(id);
      if (action === 'move') moveEntry(id);
      if (action === 'rename' && contextMenu.kind === 'file') {
        void openEntry(id);
        setFileRenameRequest(value => value + 1);
      } else if (action === 'rename') {
        void openEntry(id);
        window.setTimeout(() => titleRef.current?.focus(), 0);
      }
    }
    if (contextMenu.kind === 'session') {
      if (action === 'new-chat') void startNewChat();
      if (action === 'history') setSidebarOpen(true);
      if (action === 'search') setCommandOpen(true);
      return;
    }
    if (contextMenu.kind === 'editor' && selected?.kind === 'note' && action === 'copy') void navigator.clipboard?.writeText(body);
    if (contextMenu.kind === 'editor' && selected?.kind === 'note' && action === 'select-all') bodyRef.current?.dispatch({ selection: { anchor: 0, head: body.length } });
  }

  useEffect(() => {
    const close = () => setContextMenu(null);
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', escape); };
  }, []);

  useEffect(() => {
    if (!saveConflictId && !saveFailedId && !saving) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [saveConflictId, saveFailedId, saving]);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!sortMenuRef.current?.contains(event.target as Node)) setSortMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setSortMenuOpen(false); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', escape); };
  }, []);

  function persistFolders(next: VaultFolder[]) { setFolders(next); }

  function persistPlacements(next: VaultPlacement) { setPlacements(next); }

  async function createFolder(parentId: string | null = null) {
    if (!library) return;
    const finish = beginOperation('create-folder', '正在创建文件夹');
    if (!finish) return;
    const generation = identityGeneration.current;
    try {
      const entry = await createFolderRemote(library.id, '未命名', parentId ?? undefined);
      if (generation !== identityGeneration.current) return;
      setEntries(items => [...items, entry]);
      persistFolders([...folders, { id: entry.id, name: entry.title, parentId: entry.parent_id || null }]);
      setOpenFolders(value => ({ ...value, ...(parentId ? { [parentId]: true } : {}), [entry.id]: true }));
      setEditingFolderId(entry.id);
    } catch { if (generation === identityGeneration.current) setError('创建文件夹失败，请稍后再试。'); }
    finally { finish(); }
  }

  function renameFolder(folder: VaultFolder) {
    setEditingFolderId(folder.id);
  }

  async function saveFolderName(id: string, name: string) {
    const finish = beginOperation(`folder:${id}`, '正在重命名文件夹');
    if (!finish) return;
    const generation = identityGeneration.current;
    try {
      const entry = await patchFolder(id, { title: name });
      if (generation !== identityGeneration.current) return;
      setEntries(items => items.map(item => item.id === id ? entry : item));
      setFolders(current => current.map(item => item.id === id ? { ...item, name: entry.title } : item));
    } catch { if (generation === identityGeneration.current) setError('重命名文件夹失败，请稍后再试。'); }
    finally { finish(); }
  }

  async function removeFolder(folder: VaultFolder) {
    if (!canLeaveDraft()) return;
    const ids = new Set([folder.id]);
    let changed = true;
    while (changed) {
      changed = false;
      entries.forEach(item => {
        if (ids.has(item.parent_id) && !ids.has(item.id)) { ids.add(item.id); changed = true; }
      });
    }
    if (saveConflictId && ids.has(saveConflictId)) {
      setError('请先处理笔记保存冲突，再删除所在文件夹。');
      return;
    }
    if (!window.confirm(`删除文件夹“${folder.name}”？其中的所有笔记、文件和子文件夹都会永久删除，无法恢复；其他设备新建的内容也可能受影响。`)) return;
    const finish = beginOperation(`folder:${folder.id}`, '正在删除文件夹及其内容');
    if (!finish) return;
    const generation = identityGeneration.current;
    try {
      flushPendingSave();
      await saveChain.current;
      if (generation !== identityGeneration.current || [...ids].some(id => conflictedEntries.current.has(id) || failedSave.current?.id === id)) return;
      await deleteFolderRemote(folder.id);
      if (generation !== identityGeneration.current) return;
      setEntries(items => items.filter(item => !ids.has(item.id)));
      persistFolders(folders.filter(item => !ids.has(item.id)));
      setPlacements(current => Object.fromEntries(Object.entries(current).filter(([id, parent]) => !ids.has(id) && (!parent || !ids.has(parent)))));
      setSidebarOrder(current => Object.fromEntries(Object.entries(current)
        .filter(([group]) => !group.startsWith('notes:folder:') || !ids.has(group.slice('notes:folder:'.length)))
        .map(([group, order]) => [group, order.filter(id => !ids.has(id.slice(id.indexOf(':') + 1)))])));
      setTabs(current => current.map(tab => {
        const history = tab.history.filter(id => !ids.has(id));
        return tab.entryId && ids.has(tab.entryId)
          ? { ...tab, kind: tab.kind === 'agent' ? 'agent-blank' as const : 'blank' as const,
            title: tab.kind === 'agent' ? '新建会话' : '新建笔记', entryId: undefined, history: [], historyIndex: -1 }
          : { ...tab, history, historyIndex: history.length ? Math.min(tab.historyIndex, history.length - 1) : -1 };
      }));
      for (const id of ids) {
        delete draftsRef.current[id];
        delete entryRevisions.current[id];
        delete chatCacheRef.current[id];
      }
      if (selectedId && ids.has(selectedId)) {
        ++chatRequestRef.current;
        setSelected(null); setSelectedId(null); setTitle(''); setBody(''); setChat(null); setRailOpen(false);
      }
    } catch { if (generation === identityGeneration.current) setError('删除文件夹失败，请稍后再试。'); }
    finally { finish(); }
  }

  async function moveEntry(id: string, folderId?: string | null) {
    if (folderId === undefined) { setMoveEntryId(id); return; }
    const finish = beginOperation(`move:${id}`, '正在移动文档');
    if (!finish) return;
    const generation = identityGeneration.current;
    flushPendingSave();
    const move = saveChain.current.catch(() => {}).then(async () => {
      if (generation !== identityGeneration.current) return;
      if (conflictedEntries.current.has(id) || failedSave.current?.id === id) {
        setError('请先处理当前笔记的保存问题，再移动文档。');
        return;
      }
      const expected = entryRevisions.current[id] ?? entries.find(item => item.id === id)?.updated_at;
      if (!expected) {
        setError('文档版本不可用，请重新打开后再移动。');
        return;
      }
      try {
        const entry = await moveEntryRemote(id, folderId ?? '', expected);
        if (generation !== identityGeneration.current) return;
        entryRevisions.current[id] = entry.updated_at;
        setEntries(items => items.map(item => item.id === id ? entry : item));
        setSelected(current => current?.id === id ? { ...current, parent_id: entry.parent_id, updated_at: entry.updated_at } : current);
        setPlacements(current => ({ ...current, [id]: folderId }));
        setMoveEntryId(null);
      } catch (error) {
        if (generation !== identityGeneration.current) return;
        setError(error instanceof AuthError && error.status === 409
          ? '文档已在其他设备更新，移动未执行；请先重新打开文档核对内容。'
          : '移动文档失败，请稍后再试。');
      }
    });
    saveChain.current = move;
    try { await move; } finally { finish(); }
  }

  async function moveFolder(id: string, parentId: string | null) {
    if (id === parentId) return;
    const descendants = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      folders.forEach(folder => {
        if (folder.parentId && (folder.parentId === id || descendants.has(folder.parentId)) && !descendants.has(folder.id)) {
          descendants.add(folder.id);
          changed = true;
        }
      });
    }
    if (descendants.has(parentId ?? '')) return;
    const finish = beginOperation(`folder:${id}`, '正在移动文件夹');
    if (!finish) return;
    const generation = identityGeneration.current;
    try {
      const entry = await patchFolder(id, { parent_id: parentId ?? '' });
      if (generation !== identityGeneration.current) return;
      setEntries(items => items.map(item => item.id === id ? entry : item));
      setFolders(current => current.map(folder => folder.id === id ? { ...folder, parentId } : folder));
    } catch { if (generation === identityGeneration.current) setError('移动文件夹失败，请稍后再试。'); }
    finally { finish(); }
  }

  function renderFolder(folder: VaultFolder): ReactNode {
    const group = `notes:folder:${folder.id}`;
    const children = folders.filter(item => item.parentId === folder.id);
    const folderEntries = visible.filter(entry => (placements[entry.id] ?? null) === folder.id);
    const items = orderChildren([
      ...children.map(item => ({ id: `folder:${item.id}`, title: item.name })),
      ...folderEntries.map(item => ({ id: `entry:${item.id}`, title: item.title, updated_at: item.updated_at })),
    ], group);
    const open = openFolders[folder.id] ?? true;
    return <div className="obsidian-tree-node" key={folder.id}>
      <div className="obsidian-tree-row" {...dragProps(`folder:${folder.id}`, folder.parentId ? `notes:folder:${folder.parentId}` : 'notes:root', folder.id)} onContextMenu={event => openContextMenu(event, 'folder', `folder:${folder.id}`, folder.parentId ? `notes:folder:${folder.parentId}` : 'notes:root')}>
        <button className="tree-toggle" type="button" onClick={() => setOpenFolders(value => ({ ...value, [folder.id]: !open }))} aria-label="展开或折叠文件夹"><ChevronRight size={13} data-open={open ? 'true' : 'false'} /></button>
        {editingFolderId === folder.id
          ? <input className="tree-inline-input" autoFocus defaultValue={folder.name} onBlur={event => { const name = event.currentTarget.value.trim() || '未命名'; void saveFolderName(folder.id, name); setEditingFolderId(null); }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') setEditingFolderId(null); }} />
          : <button className="tree-item" type="button" onDoubleClick={() => renameFolder(folder)} onClick={() => setOpenFolders(value => ({ ...value, [folder.id]: !open }))}>{open ? <FolderOpen size={15} /> : <Folder size={15} />}<span>{folder.name}</span></button>}
        <button className="tree-more" type="button" onClick={event => openContextMenu(event, 'folder', `folder:${folder.id}`, folder.parentId ? `notes:folder:${folder.parentId}` : 'notes:root')} aria-label="文件夹操作"><MoreHorizontal size={14} /></button>
      </div>
      {open ? <div className="tree-children">{items.map(item => item.id.startsWith('folder:')
        ? renderFolder(children.find(child => child.id === item.id.slice(7))!)
        : <TreeItem key={item.id} entry={folderEntries.find(entry => entry.id === item.id.slice(6))!} entries={visible} group={group} selectedId={selectedId} onSelect={openEntry} onContextMenu={openContextMenu} orderChildren={orderChildren} dragProps={dragProps} />)}</div> : null}
    </div>;
  }

  // After a note opened from this device: fetch the server's copy, keep it for
  // next time and, if it is newer and the note has not been edited or left
  // meanwhile, show it. An edited note keeps its text; saving it then reports
  // the conflict as before.
  async function refreshFromServer(shown: Entry, generation: number, request: number, version: number) {
    let fresh: Entry;
    try { fresh = await loadEntry(shown.id); } catch { return; }
    if (generation !== identityGeneration.current) return;
    if (fresh.updated_at === shown.updated_at || request !== noteRequestRef.current ||
      (saveVersions.current[shown.id] ?? 0) !== version || conflictedEntries.current.has(shown.id)) return;
    entryRevisions.current[shown.id] = fresh.updated_at;
    setEntries(items => items.map(item => item.id === fresh.id ? fresh : item));
    setSelected(current => current?.id === fresh.id ? fresh : current);
    setTabs(current => current.map(tab => tab.entryId === fresh.id ? { ...tab, title: fresh.title || '未命名笔记' } : tab));
    setTitle(fresh.title);
    setBody(fresh.body ?? '');
  }

  async function openEntry(id: string, loadedItem?: Entry, targetTabKey?: string, historyIndex?: number, preserveSidebar = false) {
    if (id !== selectedId && !canLeaveDraft(id)) return;
    const listedItem = loadedItem ?? entries.find(entry => entry.id === id);
    if (!listedItem) return;
    // Selecting the Agent this tab already shows keeps its loaded conversation;
    // retries (after an error) and opening into another tab still reload.
    if (listedItem.kind === 'agent' && id === selectedId && targetTabKey === undefined && chat && !chatLoading && !chatError
      && tabs.find(tab => tab.key === activeTabRef.current)?.entryId === id) {
      if (!preserveSidebar && window.innerWidth <= 720) setSidebarOpen(false);
      return;
    }
    let item: Entry = listedItem;
    const generation = identityGeneration.current;
    const request = ++noteRequestRef.current;
    // A note whose body is on this device opens from it. The tree's updated_at
    // is the revision: a match is not fetched again. An older local body is
    // shown at once, then refreshed. The first screen does not open the store.
    let fromDevice: Entry | null = null;
    let revisionMatches = false;
    if ((item.kind === 'note' || item.kind === 'rich_text') && item.body === undefined) {
      // Memory and the localStorage mirror are synchronous: a hit paints in
      // this click, with no progress indicator. Disk is only awaited on a miss.
      const local = peekNote(item) ?? await localNote(item, !loading);
      if (generation !== identityGeneration.current || request !== noteRequestRef.current) return;
      if (local) {
        fromDevice = local.entry;
        revisionMatches = local.fresh;
        item = local.fresh
          ? { ...item, body: local.entry.body }
          : { ...local.entry, title: item.title || local.entry.title, library_id: item.library_id, parent_id: item.parent_id };
      }
    }
    if ((item.kind === 'note' || item.kind === 'rich_text') && item.body === undefined) {
      // A later selection wins even if this request is slower.
      const finish = beginOperation(`open:${request}`, `正在打开「${item.title || '未命名笔记'}」`);
      try {
        item = await loadEntry(item.id);
      } catch {
        if (generation === identityGeneration.current && request === noteRequestRef.current) setError('打开笔记失败，请稍后重试。');
        return;
      } finally {
        finish?.();
      }
      if (generation !== identityGeneration.current || request !== noteRequestRef.current) return;
      if (!canLeaveDraft(id)) return;
    }
    if ((item.kind === 'note' || item.kind === 'rich_text') && !entryRevisions.current[id]) {
      entryRevisions.current[id] = item.updated_at;
    }
    flushPendingSave();
    const compatible = (tab: WorkspaceTab) => item.kind === 'agent' ? tab.kind === 'agent' || tab.kind === 'agent-blank' : tab.kind === 'note' || tab.kind === 'rich_text' || tab.kind === 'file' || tab.kind === 'blank';
    const key = targetTabKey
      ?? tabs.find(tab => tab.key === activeTabRef.current && compatible(tab))?.key
      ?? tabs.slice().reverse().find(compatible)?.key
      ?? `tab-${crypto.randomUUID()}`;
    setTabs(current => {
      const update = (tab?: WorkspaceTab): WorkspaceTab => {
        const history = tab?.history ?? [];
        const cursor = tab?.historyIndex ?? -1;
        const nextHistory = historyIndex === undefined && history[cursor] !== id
          ? [...history.slice(0, cursor + 1), id] : history.length ? history : [id];
        return { key, kind: item.kind === 'agent' ? 'agent' : item.kind === 'file' ? 'file' : item.kind === 'rich_text' ? 'rich_text' : 'note', title: item.title, entryId: id,
          history: nextHistory, historyIndex: historyIndex ?? (nextHistory === history ? cursor : nextHistory.length - 1) };
      };
      return current.some(tab => tab.key === key) ? current.map(tab => tab.key === key ? update(tab) : tab) : [...current, update()];
    });
    chooseTab(key);
    setSelectedId(id); setSelected(item); setTitle(item.title); setBody(item.body ?? '');
    if (fromDevice) rememberEntry({ ...fromDevice, title: item.title || fromDevice.title, library_id: item.library_id, parent_id: item.parent_id });
    // Keep a matching body on the tree row so the next open does not wait at all.
    if ((item.kind === 'note' || item.kind === 'rich_text') && typeof item.body === 'string' && item.updated_at === listedItem.updated_at) {
      setEntries(rows => rows.map(row => row.id === id && row.body === item.body ? row : row.id === id ? { ...row, body: item.body } : row));
    }
    // chooseTab advanced the counter; a later selection advances it again.
    if (fromDevice && !revisionMatches && !justLoaded(id)) void refreshFromServer(fromDevice, generation, noteRequestRef.current, saveVersions.current[id] ?? 0);
    setView(item.kind === 'agent' ? 'sessions' : 'notes');
    if (!preserveSidebar && window.innerWidth <= 720) setSidebarOpen(false);
    // Like Notion, the page opens without a side panel; the outline is on demand.
    if (item.kind !== 'note') setRailOpen(false);
    if (item.kind === 'agent') {
      const request = ++chatRequestRef.current;
      setChat(chatCacheRef.current[id] ?? null); setChatLoading(true); setChatError(''); setDraft(draftsRef.current[id] ?? '');
      try {
        const choice = sessionChoiceRef.current[item.id];
        let next: ChatSession;
        if (choice && choice !== 'new') next = await getSession(choice);
        else {
          const latest = (await listSessions(item.id))[0];
          const loaded = latest && (latest.messages ? latest : await getSession(latest.id));
          // A new conversation reuses the latest one while it is still empty.
          next = loaded && (choice !== 'new' || !loaded.messages?.length) ? loaded : await createSession(item.id);
        }
        if (generation === identityGeneration.current && request === chatRequestRef.current) sessionChoiceRef.current[item.id] = next.id;
        if (generation === identityGeneration.current && request === chatRequestRef.current) {
          const pending = (identityRef.current ? readPendingChat(identityRef.current, next.id) : null) ??
            (pendingChatRequestRef.current?.sessionId === next.id ? pendingChatRequestRef.current : null);
          const saved = pending && next.messages?.find(message => message.role === 'user' && message.client_request_id === pending.id);
          const confirmed = saved && (pending.content === undefined || saved.content === pending.content) &&
            (!pending.digest || await chatDigest(saved.content) === pending.digest);
          if (generation !== identityGeneration.current || request !== chatRequestRef.current) return;
          if (pending && confirmed) {
            clearPendingChat(identityRef.current!, next.id, pending.id);
            if (pendingChatRequestRef.current?.id === pending.id) pendingChatRequestRef.current = null;
            const draftText = draftsRef.current[id] ?? '';
            if (draftText && (pending.content === draftText.trim() ||
              pending.digest && await chatDigest(draftText.trim()) === pending.digest)) {
              if (generation !== identityGeneration.current || request !== chatRequestRef.current) return;
              if (draftsRef.current[id] === draftText) {
                draftsRef.current[id] = '';
                setDraft('');
              }
            }
          } else if (saved) {
            pendingChatRequestRef.current = pending;
            setChatError('服务器记录与原消息不一致，请不要重新发送；请检查其他设备的会话记录。');
          } else if (pending) {
            // Kept so resending the same text reuses its id; anything else is a new message.
            pendingChatRequestRef.current = pending;
          }
          chatCacheRef.current[id] = next;
          showChat(next);
        }
      } catch (error) {
        if (generation === identityGeneration.current && request === chatRequestRef.current) {
          setChatError(error instanceof AuthError && error.body.error?.id === 'library_limit_reached'
            ? '这个 Agent 的会话已达 50 个上限，请在历史会话中继续已有的对话。' : '会话暂时不可用，请稍后再试。');
        }
      }
      finally { if (generation === identityGeneration.current && request === chatRequestRef.current) setChatLoading(false); }
    } else { ++chatRequestRef.current; setChat(null); setChatLoading(false); }
  }

  /** Opens an Agent on a fresh conversation, or on one from its history. */
  function openConversation(agentId: string, sessionId: string | 'new', agent?: Entry, tabKey?: string, preserveSidebar = false) {
    if (sessionId !== 'new' && sessionId === chat?.id && selectedId === agentId && view === 'sessions') {
      // Already open: on a phone, picking it still closes the drawer.
      if (!preserveSidebar && isMobile) setSidebarOpen(false);
      return;
    }
    sessionChoiceRef.current[agentId] = sessionId;
    delete chatCacheRef.current[agentId];
    const tab = tabs.find(item => item.key === activeTabRef.current);
    void openEntry(agentId, agent, tabKey ?? (tab && (tab.kind === 'agent' || tab.kind === 'agent-blank') ? tab.key : undefined), undefined, preserveSidebar);
  }

  const agentKey = entries.filter(entry => entry.kind === 'agent').map(entry => entry.id).join(',');
  useEffect(() => {
    if (!agentKey) return;
    const generation = identityGeneration.current;
    let cancelled = false;
    void (async () => {
      const lists = await Promise.all(agentKey.split(',').map(id => listSessions(id).then(list => list.map(item => ({ id: item.id, entryId: id, updatedAt: item.updated_at }))).catch(() => [])));
      if (cancelled || generation !== identityGeneration.current) return;
      const merged = lists.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      setConversations(current => merged.map(item => ({ ...item, title: current.find(old => old.id === item.id)?.title })));
      // The list has no messages; read the first question of recent ones.
      for (const item of merged.slice(0, 40)) {
        const full = await getSession(item.id).catch(() => null);
        if (cancelled || generation !== identityGeneration.current) return;
        const title = conversationTitle(full);
        setConversations(current => current.map(old => old.id === item.id ? { ...old, title } : old));
      }
    })();
    return () => { cancelled = true; };
  }, [agentKey]);

  // The open conversation keeps its row current: title, and first place once it moves.
  const listedConversations = useMemo(() => {
    const known = agentKey ? conversations : [];
    if (!chat) return known;
    const row = { id: chat.id, entryId: chat.entry_id, updatedAt: chat.updated_at, title: conversationTitle(chat) };
    return [row, ...known.filter(item => item.id !== chat.id)].sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
  }, [agentKey, conversations, chat]);

  /** Shows a conversation and names its tab after the first question. */
  function showChat(next: ChatSession) {
    setChat(next);
    const title = conversationTitle(next);
    // Keep the row once the conversation is no longer the open one.
    setConversations(current => [{ id: next.id, entryId: next.entry_id, updatedAt: next.updated_at, title },
      ...current.filter(item => item.id !== next.id)].sort((x, y) => y.updatedAt.localeCompare(x.updatedAt)));
    setTabs(current => current.map(tab => tab.key === activeTabRef.current && tab.kind === 'agent' && tab.title !== title ? { ...tab, title } : tab));
  }

  /** The Agent new conversations use: a general one, created once when only the guide exists. */
  async function conversationAgent(): Promise<Entry | null> {
    const general = entries.find(entry => entry.kind === 'agent' && entry.preset !== 'guide');
    if (general) return general;
    if (!library) return entries.find(entry => entry.kind === 'agent') ?? null;
    try {
      const created = await createEntry(library.id, { kind: 'agent', title: 'TJUClaw' });
      setEntries(items => items.some(item => item.id === created.id) ? items : [...items, created]);
      return created;
    } catch {
      return entries.find(entry => entry.kind === 'agent') ?? null;
    }
  }

  async function startNewChat(tabKey?: string, preserveSidebar = false) {
    const agent = await conversationAgent();
    if (!agent) { setError('暂时无法开始新对话，请稍后再试。'); return; }
    openConversation(agent.id, 'new', agent, tabKey, preserveSidebar);
  }


  function adoptAnkiCards(cards: RemoteAnkiCard[]) {
    const display = cards.map(card => ({ id: card.id, front: card.front, back: card.back, tags: (card.tags ?? []).join(' ') }));
    ankiRemoteIds.current = new Set(cards.map(card => card.id));
    ankiPendingIds.current = new Map();
    ankiCardsRef.current = display;
    setAnkiSchedules(Object.fromEntries(cards.map(card => [card.id, card])));
    setAnkiCards(display);
  }

  async function loadAnkiData(generation: number) {
    setAnkiLoadFailed(false);
    try {
      let decks = await listDecks();
      if (generation !== identityGeneration.current) return;
      const deck = decks[0] ?? await createDeck('默认牌组');
      if (generation !== identityGeneration.current) return;
      if (!decks.length) decks = [deck];
      const [cards, lastStudyAt] = await Promise.all([listAnkiCards(deck.id), deckStudySummary(deck.id)]);
      if (generation !== identityGeneration.current) return;
      if (identityRef.current) {
        for (const card of cards) {
          const key = ankiReviewKey(identityRef.current, card.id);
          const pending = readPendingAnkiReview(key);
          if (!pending) continue;
          try {
            const committed = await getReviewRequest(pending.requestId);
            if (generation !== identityGeneration.current) return;
            if (committed?.cardId === card.id && committed.rating === pending.rating) sessionStorage.removeItem(key);
          } catch {
            // A failed read cannot prove whether the request committed; retain its ID for a safe retry.
          }
        }
      }
      setAnkiDecks(decks);
      setAnkiLastStudyAt(lastStudyAt);
      ankiDeckIdRef.current = deck.id;
      setAnkiDeckId(deck.id);
      ankiSyncHealthy.current = true;
      setAnkiRemoteReady(true);
      setAnkiLoadFailed(false);
      adoptAnkiCards(cards);
      setError(current => current.startsWith('闪卡') ? '' : current);
    } catch {
      if (generation !== identityGeneration.current) return;
      ankiSyncHealthy.current = false;
      setAnkiRemoteReady(false);
      setAnkiLoadFailed(true);
      setAnkiOpenCardId(null);
      if (!ankiDeckIdRef.current) {
        setAnkiDecks([]);
        setAnkiLastStudyAt(null);
        ankiCardsRef.current = [];
        setAnkiCards([]);
        setAnkiSchedules({});
      }
      setError('闪卡服务暂时不可用，已暂停编辑；旧版浏览器卡片不会自动显示或归入当前账号。');
    }
  }

  // The device's note store is opened once the workspace is on screen, so its
  // code and database never delay the first load.
  useEffect(() => {
    if (loading || !session) return;
    const start = () => { void hydrateEntryCache(); enableEntryReplica(); };
    const idle = window.requestIdleCallback(start, { timeout: 1200 });
    return () => window.cancelIdleCallback(idle);
  }, [loading, session]);

  async function loadWorkspaceData(libraryId: string, generation: number) {
    setLoadStep('entries');
    // Flashcards do not depend on the note tree: both load at once.
    const flashcards = loadAnkiData(generation);
    const items = await listEntries(libraryId);
    if (generation !== identityGeneration.current) return;
    pruneEntryCache(items);
    setEntries(items);
    setSidebarOrder(current => ({
      ...Object.fromEntries(Object.entries(current).filter(([group]) => !group.startsWith('notes:'))),
      ...noteOrdersFromEntries(items),
    }));
    const remoteFolders = items.filter(item => item.kind === 'folder').map(item => ({ id: item.id, name: item.title, parentId: item.parent_id || null }));
    setFolders(remoteFolders);
    setPlacements(Object.fromEntries(items.filter(item => (item.kind === 'note' || item.kind === 'rich_text' || item.kind === 'file') && item.parent_id).map(item => [item.id, item.parent_id])));
    // A new workspace always contains the guide agent, but opening that agent
    // automatically would switch the user away from the notes home and hide
    // the primary "new note" action. Only restore a real note here; otherwise
    // keep the notes home visible.
    const firstNote = items.find(item => item.kind === 'note' || item.kind === 'rich_text');
    // Open the last note before the loading screen ends, so the workspace
    // appears on that note instead of flashing the new-note home first. Its
    // body is requested now, while the flashcards are still loading.
    const opening = firstNote ? openEntry(firstNote.id, firstNote) : null;
    opening?.catch(() => undefined);
    setLoadStep('cards');
    await flashcards;
    if (generation !== identityGeneration.current) return;
    if (opening) {
      setLoadStep('note');
      await opening;
    }
    else {
      ++chatRequestRef.current;
      setView('notes');
      chooseTab('home');
      setSelected(null);
      setSelectedId(null);
      setTitle('');
      setBody('');
      setChat(null);
      setRailOpen(false);
    }
  }

  async function continueAfterWorkspaceUnlock(createdWorkspace?: Library) {
    const gate = workspaceGate;
    const generation = identityGeneration.current;
    if (!gate) return;
    const target = createdWorkspace ?? (gate.workspaceId ? { id: gate.workspaceId, name: gate.workspaceName } : null);
    if (!target) return;
    if (createdWorkspace) setLibraries([createdWorkspace]);
    setWorkspaceGate(null);
    setLoading(true);
    try {
      await loadWorkspaceData(target.id, generation);
    } catch (err) {
      if (generation !== identityGeneration.current) return;
      if ((err instanceof AuthError || err instanceof VaultError) && err.status === 401) location.replace('/auth/login');
      else setError('工作区暂时无法连接，请稍后重试。');
    } finally {
      if (generation === identityGeneration.current) setLoading(false);
    }
  }

  async function load(generation: number, early?: { libraries: Promise<Library[]>; verification: ReturnType<typeof workspaceVerification> }) {
    try {
      setLoadStep('library');
      // Neither answer depends on the other, and the first page load already
      // asked for both while the session was being confirmed.
      const [libs, verification] = await Promise.all([early?.libraries ?? listLibraries(), early?.verification ?? workspaceVerification()]);
      if (generation !== identityGeneration.current) return;
      setLibraries(libs);
      const activeLibrary = libs[0];
      if (!activeLibrary) {
        setWorkspaceGate({ workspaceId: null, workspaceName: '', mode: 'setup', verification, firstWorkspace: true });
        return;
      }
      const identity = identityRef.current;
      if (!identity) return;
      const passphraseState = await workspacePassphraseState(identity, activeLibrary.id, verification);
      if (generation !== identityGeneration.current) return;
      if (!passphraseState.unlocked) {
        setWorkspaceGate({
          workspaceId: activeLibrary.id,
          workspaceName: activeLibrary.name,
          mode: passphraseState.mode,
          verification,
        });
        return;
      }
      setWorkspaceGate(null);
      await loadWorkspaceData(activeLibrary.id, generation);
    } catch (err) {
      if (generation !== identityGeneration.current) return;
      if ((err instanceof AuthError || err instanceof VaultError) && err.status === 401) location.replace('/auth/login');
      else setError('工作区暂时无法连接，请稍后重试。');
    } finally {
      if (generation === identityGeneration.current) setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      // On the first load, ask for the workspace list and vault mode together
      // with the session instead of after it; a signed-out visitor is
      // redirected by the session answer and these are simply dropped.
      const early = identityRef.current ? undefined : { libraries: listLibraries(), verification: workspaceVerification() };
      early?.libraries.catch(() => undefined);
      early?.verification.catch(() => undefined);
      void readSession().then(next => {
        if (!active) return;
        if (!next) { location.replace('/auth/login'); return; }
        if (identityRef.current === next.id) return;
        clearRemoteWorkspaceUnlocks();
        clearPrivateDrafts();
        if (identityRef.current) clearEntryCache();
        identityRef.current = next.id;
        openEntryCache(next.id);
        const generation = ++identityGeneration.current;
        ++noteRequestRef.current;
        operationLocks.current.clear();
        setOperations({});
        window.clearTimeout(saveTimer.current);
        setSession(next);
        setLibraries([]);
        setEntries([]);
        ankiDeckIdRef.current = null;
        ++ankiDeckRequest.current;
        pendingStudyDeckRef.current = null;
        setAnkiDeckId(null);
        setAnkiDecks([]);
        ankiDeckMutation.current = false;
        setAnkiDeckBusy(false);
        setAnkiLastStudyAt(null);
        setAnkiRemoteReady(false);
        setAnkiLoadFailed(false);
        try { setLegacyAnkiBackupAvailable(localStorage.getItem('tjuclaw.anki.cards.v1') !== null); }
        catch { setLegacyAnkiBackupAvailable(false); }
        ankiSyncHealthy.current = false;
        ankiRemoteIds.current = new Set();
        ankiPendingIds.current = new Map();
        ankiCardsRef.current = [];
        ankiWriteQueue.current = Promise.resolve();
        setAnkiCards([]);
        setAnkiSchedules({});
        setWorkspaceGate(null);
        setActiveToolId('schedule');
        const savedSort = localData<Partial<SidebarSort>>('tjuclaw.sidebar.sort.v1', {});
        setSidebarSort(Object.fromEntries((Object.keys(defaultSidebarSort) as SidebarView[]).map(section =>
          [section, Object.hasOwn(sortLabels, savedSort?.[section] ?? '') ? savedSort[section] : 'manual'])) as SidebarSort);
        const savedOrder = localData<Record<string, string[]>>('tjuclaw.sidebar.order.v1', {});
        setSidebarOrder(savedOrder && typeof savedOrder === 'object' && !Array.isArray(savedOrder)
          ? Object.fromEntries(Object.entries(savedOrder).filter(([group]) => !group.startsWith('notes:'))) : {});
        setSortMenuOpen(false);
        setSelected(null);
        setSelectedId(null);
        setTitle('');
        setBody('');
        setChat(null);
        ++chatRequestRef.current;
        activeTabRef.current = 'home';
        setTabs([{ key: 'home', kind: 'blank', title: '新建笔记', history: [], historyIndex: -1 }]);
        setActiveTabKey('home');
        draftsRef.current = {};
        chatCacheRef.current = {};
        sessionChoiceRef.current = {};
        setConversations([]);
        pendingChatRequestRef.current = null;
        pendingSave.current = null;
        failedSave.current = null;
        conflictDraft.current = null;
        setSaveFailedId(null);
        saveVersions.current = {};
        entryRevisions.current = {};
        conflictedEntries.current.clear();
        setSaveConflictId(null);
        setChatLoading(false);
        setChatSending(false);
        sendingRef.current = false;
        setSaving(false);
        setLoading(true);
        void load(generation, early);
      }).catch(() => { if (active && !identityRef.current) setLoading(false); });
    };
    refresh();
    document.addEventListener('visibilitychange', refresh);
    return () => { active = false; document.removeEventListener('visibilitychange', refresh); window.clearTimeout(saveTimer.current); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    document.body.classList.add('workspace-page');
    return () => document.body.classList.remove('workspace-page');
  }, []);

  useEffect(() => {
    if (pendingStudyDeckRef.current !== ankiDeckId || !ankiCards.length || view !== 'anki' || !ankiWorkspaceRef.current) return;
    pendingStudyDeckRef.current = null;
    ankiWorkspaceRef.current?.startStudy();
  }, [ankiCards, ankiDeckId, view]);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 720px)');
    const update = () => setIsMobile(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandOpen(true);
      }
      if (event.key === 'Escape') setCommandOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (!sidebarOpen || window.innerWidth > 720 || settingsOpen || moveEntryId || commandOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSidebarOpen(false);
        window.setTimeout(() => document.querySelector<HTMLButtonElement>('.sidebar-opener')?.focus(), 0);
      }
      if (event.key !== 'Tab' || !sidebarRef.current) return;
      const controls = [...sidebarRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')];
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !sidebarRef.current.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !sidebarRef.current.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [sidebarOpen, settingsOpen, moveEntryId, commandOpen]);

  useEffect(() => {
    if (!railOpen || window.innerWidth > 720 || settingsOpen || moveEntryId || commandOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setRailOpen(false);
        window.setTimeout(() => document.querySelector<HTMLButtonElement>('.sidebar-opener')?.focus(), 0);
      }
      if (event.key !== 'Tab' || !railRef.current) return;
      const controls = [...railRef.current.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !railRef.current.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !railRef.current.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [railOpen, settingsOpen, moveEntryId, commandOpen]);

  function queueSave(nextTitle: string, nextBody: string) {
    if (!selected || (selected.kind !== 'note' && selected.kind !== 'rich_text')) return;
    if (conflictedEntries.current.has(selected.id)) return;
    const generation = identityGeneration.current;
    const id = selected.id;
    const version = (saveVersions.current[id] ?? 0) + 1;
    saveVersions.current[id] = version;
    pendingSave.current = { id, title: nextTitle, body: nextBody, generation, version };
    if (failedSave.current?.id === id) {
      failedSave.current = null;
      setSaveFailedId(null);
    }
    setEntries(items => items.map(item => item.id === id ? { ...item, title: nextTitle, body: nextBody } : item));
    setTabs(current => current.map(tab => tab.entryId === id ? { ...tab, title: nextTitle || (selected.kind === 'rich_text' ? '未命名文档' : '未命名笔记') } : tab));
    window.clearTimeout(saveTimer.current);
    setSaving(true);
    saveTimer.current = window.setTimeout(flushPendingSave, 650);
  }

  function switchView(next: SidebarView) {
    if (next !== view && !canLeaveDraft()) return;
    flushPendingSave();
    const matches = (tab: WorkspaceTab) => next === 'notes' ? tab.kind === 'note' || tab.kind === 'rich_text' || tab.kind === 'file' || tab.kind === 'blank'
      : next === 'sessions' ? tab.kind === 'agent' || tab.kind === 'agent-blank'
        : next === 'anki' ? tab.kind === 'anki' : next === 'tools' && tab.kind === 'tool';
    const match = tabs.find(tab => tab.key === activeTabRef.current && matches(tab))
      ?? tabs.slice().reverse().find(matches);
    if (match) { activateTab(match, true); return; }
    let blankKey: string | undefined;
    if (next === 'sessions' || next === 'anki' || next === 'tools') {
      const key = `blank-${crypto.randomUUID()}`;
      blankKey = key;
      const tab: WorkspaceTab = { key, kind: next === 'anki' ? 'anki' : next === 'tools' ? 'tool' : 'agent-blank', title: next === 'anki' ? '记忆闪卡' : next === 'tools' ? campusToolList.find(tool => tool.id === activeToolId)!.name : '新会话', toolId: next === 'tools' ? activeToolId : undefined, history: [], historyIndex: -1 };
      setTabs(current => [...current, tab]);
      chooseTab(key);
    } else chooseTab(null);
    ++chatRequestRef.current;
    setView(next);
    if (next !== 'notes') setRailOpen(false);
    setSelected(null); setSelectedId(null);
    // Opening conversations lands in a fresh one (an empty latest one is reused).
    if (next === 'sessions' && blankKey) void startNewChat(blankKey, true);
  }

  async function createNote(noteTitle = '未命名笔记', initialBody = '', folderId?: string) {
    if (!canLeaveDraft()) return;
    if (!library) return;
    const finish = beginOperation('create', '正在创建笔记');
    if (!finish) return;
    const generation = identityGeneration.current;
    try {
      const entry = await createEntry(library.id, { kind: 'note', title: noteTitle, body: initialBody, ...(folderId ? { parent_id: folderId } : {}) });
      if (generation !== identityGeneration.current) return;
      setEntries(items => [...items, entry]);
      if (folderId) persistPlacements({ ...placements, [entry.id]: folderId });
      setEditorMode('edit');
      await openEntry(entry.id, { ...entry, body: entry.body ?? initialBody });
      window.setTimeout(() => titleRef.current?.focus(), 0);
    } catch { if (generation === identityGeneration.current) setError('暂时无法创建笔记。'); }
    finally { finish(); }
  }

  async function createRichText(folderId?: string) {
    if (!canLeaveDraft()) return;
    if (!library) return;
    const finish = beginOperation('create', '正在创建富文本文档');
    if (!finish) return;
    const generation = identityGeneration.current;
    try {
      const entry = await createEntry(library.id, { kind: 'rich_text', title: '未命名文档', body: EMPTY_RICH_TEXT, ...(folderId ? { parent_id: folderId } : {}) });
      if (generation !== identityGeneration.current) return;
      setEntries(items => [...items, entry]);
      if (folderId) persistPlacements({ ...placements, [entry.id]: folderId });
      setEditorMode('edit');
      await openEntry(entry.id, { ...entry, body: entry.body ?? EMPTY_RICH_TEXT });
      window.setTimeout(() => titleRef.current?.focus(), 0);
    } catch { if (generation === identityGeneration.current) setError('暂时无法创建富文本文档。'); }
    finally { finish(); }
  }

  function uploadPicker(folderId?: string) {
    uploadParent.current = folderId;
    uploadRef.current?.click();
  }

  async function handleFileUpload(files: FileList | null) {
    if (!canLeaveDraft()) return;
    if (!library || !files?.length) return;
    const finish = beginOperation('upload', '正在上传课程资料');
    if (!finish) return;
    const generation = identityGeneration.current;
    const folderId = uploadParent.current;
    try { for (const [index, file] of Array.from(files).entries()) {
      setOperations(current => ({ ...current, upload: `正在上传 ${index + 1}/${files.length}：「${file.name}」` }));
      if (!file.size || file.size > 8 * 1024 * 1024) {
        setError(`“${file.name}”超过当前 8 MB 的单文件上限，或是空文件。`);
        continue;
      }
      try {
        const entry = await uploadFile(library.id, file, folderId);
        if (generation !== identityGeneration.current) return;
        setEntries(items => [...items, entry]);
        if (folderId) setPlacements(current => ({ ...current, [entry.id]: folderId }));
        await openEntry(entry.id, entry);
      } catch { if (generation === identityGeneration.current) setError(`“${file.name}”上传失败。`); }
    } } finally { finish(); }
  }

  async function renameFile(item: Entry, name: string) {
    const finish = beginOperation(`rename:${item.id}`, '正在重命名文件');
    if (!finish) return;
    const generation = identityGeneration.current;
    try {
      const entry = await patchEntry(item.id, { title: name, expected_updated_at: item.updated_at });
      if (generation !== identityGeneration.current) return;
      setEntries(items => items.map(item => item.id === entry.id ? entry : item));
      setSelected(current => current?.id === entry.id ? entry : current);
      setTabs(current => current.map(tab => tab.entryId === entry.id ? { ...tab, title: entry.title } : tab));
    } catch {
      if (generation === identityGeneration.current) setError('重命名失败，请重新打开文件后重试。');
    } finally { finish(); }
  }

  async function deleteNote(id: string) {
    if (!canLeaveDraft()) return;
    const item = entries.find(entry => entry.id === id);
    if (!item || !window.confirm(`删除“${item.title || '未命名笔记'}”？`)) return;
    const finish = beginOperation(`delete:${id}`, `正在删除「${item.title || '未命名笔记'}」`);
    if (!finish) return;
    const generation = identityGeneration.current;
    try {
      flushPendingSave();
      await saveChain.current;
      if (generation !== identityGeneration.current) return;
      if (!canLeaveDraft()) return;
      await deleteEntry(id);
      if (generation !== identityGeneration.current) return;
      setEntries(items => items.filter(entry => entry.id !== id));
      const next = { ...placements };
      delete next[id];
      persistPlacements(next);
      const nextTabs = tabs.map(tab => {
        if (!tab.history.includes(id)) return tab;
        const history = tab.history.filter(item => item !== id);
        const historyIndex = Math.min(tab.historyIndex, history.length - 1);
        const nextId = history[historyIndex];
        const nextEntry = entries.find(entry => entry.id === nextId);
        return nextEntry ? { ...tab, history, historyIndex, entryId: nextId, title: nextEntry.title, kind: nextEntry.kind === 'agent' ? 'agent' as const : nextEntry.kind === 'rich_text' ? 'rich_text' as const : nextEntry.kind === 'file' ? 'file' as const : 'note' as const }
          : { ...tab, history: [], historyIndex: -1, entryId: undefined, title: '新建笔记', kind: 'blank' as const };
      });
      setTabs(nextTabs);
      if (selectedId === id) {
        const current = nextTabs.find(tab => tab.key === activeTabRef.current);
        if (current?.entryId) void openEntry(current.entryId, undefined, current.key, current.historyIndex);
        else { setSelected(null); setSelectedId(null); setTitle(''); setBody(''); setRailOpen(false); setView('notes'); }
      }
    } catch { if (generation === identityGeneration.current) setError('删除文档失败，请稍后再试。'); }
    finally { finish(); }
  }

  async function handleChat(event: FormEvent) {
    event.preventDefault();
    if (!chat || !draft.trim() || sendingRef.current) return;
    const text = draft.trim();
    const currentId = chat.id;
    const entryId = selectedId;
    const request = chatRequestRef.current;
    const generation = identityGeneration.current;
    const identity = identityRef.current;
    if (!identity) return;
    const pending = pendingChatRequestRef.current?.sessionId === currentId
      ? pendingChatRequestRef.current : readPendingChat(identity, currentId);
    sendingRef.current = true;
    setChatSending(true);
    let digest: string;
    try {
      digest = await chatDigest(text);
    } catch {
      sendingRef.current = false;
      setChatSending(false);
      setChatError('无法校验消息重试，请检查浏览器安全环境后再试。');
      return;
    }
    if (generation !== identityGeneration.current || identity !== identityRef.current || request !== chatRequestRef.current) {
      sendingRef.current = false;
      if (generation === identityGeneration.current) setChatSending(false);
      return;
    }
    // Resending the same text reuses its request id, so a turn the server did
    // store is not stored twice; different text is simply a new message.
    const same = pending?.sessionId === currentId && (pending.digest ? pending.digest === digest : pending.content === text);
    const requestId = same ? pending!.id : crypto.randomUUID().replaceAll('-', '');
    pendingChatRequestRef.current = { sessionId: currentId, content: text, id: requestId, digest };
    try {
      sessionStorage.setItem(pendingChatKey(identity, currentId), JSON.stringify({ sessionId: currentId, id: requestId, digest }));
    } catch { /* In-memory retries still work when browser storage is disabled. */ }
    setChatError('');
    // Optimistic: the message leaves the composer at once and returns to it
    // only if the send fails.
    let delivered = false;
    setPendingText(text);
    setDraft('');
    try {
      // The desktop app may run the turn in the user's own Docker sandbox.
      const next = agentRuntime() === 'local' ? await sendLocalTurn(currentId, text, requestId) : await sendMessage(currentId, text, requestId);
      delivered = true;
      clearPendingChat(identity, currentId, requestId);
      if (pendingChatRequestRef.current?.id === requestId) pendingChatRequestRef.current = null;
      if (generation === identityGeneration.current && request === chatRequestRef.current) {
        if (entryId) { chatCacheRef.current[entryId] = next; draftsRef.current[entryId] = ''; }
        showChat(next);
        setDraft('');
      }
    } catch (cause) {
      // These are refused before the turn is stored, so the outcome is known:
      // say why and let the user send again instead of asking to confirm.
      const refused = cause instanceof AuthError ? cause.body?.error?.id ?? '' : '';
      if (definiteChatRefusals.has(refused)) {
        clearPendingChat(identity, currentId, requestId);
        if (pendingChatRequestRef.current?.id === requestId) pendingChatRequestRef.current = null;
        if (generation === identityGeneration.current && request === chatRequestRef.current) setChatError(describeLibraryError(cause));
        return;
      }
      try {
        // A CDN may time out a long turn (504) while the server finishes and
        // saves it; wait for the reply under this request id before giving up.
        const status = cause instanceof AuthError ? cause.status : 0;
        const pending = status === 0 || status === 502 || status === 504;
        const deadline = clockNow() + (pending ? 200_000 : 0);
        let latest = await getSession(currentId);
        const answered = (session: ChatSession) => {
          const index = session.messages?.findIndex(message => message.role === 'user' && message.client_request_id === requestId && message.content === text) ?? -1;
          return index >= 0 && Boolean(session.messages?.slice(index + 1).some(message => message.role === 'assistant' && message.content));
        };
        while (pending && !answered(latest) && clockNow() < deadline
          && generation === identityGeneration.current && request === chatRequestRef.current) {
          await new Promise(resolve => setTimeout(resolve, 3000));
          latest = await getSession(currentId);
        }
        if (latest.messages?.some(message => message.role === 'user' && message.client_request_id === requestId && message.content === text)) {
          clearPendingChat(identity, currentId, requestId);
          if (pendingChatRequestRef.current?.id === requestId) pendingChatRequestRef.current = null;
          delivered = true;
          if (generation === identityGeneration.current && request === chatRequestRef.current) {
            if (entryId) { chatCacheRef.current[entryId] = latest; draftsRef.current[entryId] = ''; }
            showChat(latest);
            setDraft('');
          }
          return;
        }
        if (!pending && cause instanceof AuthError) {
          // An error response (not a timeout) and nothing stored: the turn failed.
          clearPendingChat(identity, currentId, requestId);
          if (pendingChatRequestRef.current?.id === requestId) pendingChatRequestRef.current = null;
          if (generation === identityGeneration.current && request === chatRequestRef.current) setChatError(describeLibraryError(cause));
          return;
        }
      } catch { /* Retain the request id when the outcome cannot be read back. */ }
      if (generation === identityGeneration.current && request === chatRequestRef.current) setChatError('发送结果未确认，草稿已保留；重试会沿用同一请求编号。');
    } finally {
      sendingRef.current = false;
      if (generation === identityGeneration.current) {
        setChatSending(false);
        setPendingText('');
        if (!delivered && request === chatRequestRef.current) setDraft(text);
      }
    }
  }

  function saveAnkiCards(cards: AnkiCard[]) {
    if (!ankiSyncHealthy.current || !ankiDeckId) return;
    const previous = ankiCardsRef.current;
    ankiCardsRef.current = cards;
    setAnkiCards(cards);
    const deckId = ankiDeckId;
    const generation = identityGeneration.current;
    const oldCards = new Map(previous.map(card => [card.id, card]));
    const nextIds = new Set(cards.map(card => card.id));
    const changed = cards.filter(card => {
      const old = oldCards.get(card.id);
      return !old || old.front !== card.front || old.back !== card.back || old.tags !== card.tags;
    });
    const removed = previous.filter(card => !nextIds.has(card.id));
    ankiWriteQueue.current = ankiWriteQueue.current.then(async () => {
      if (generation !== identityGeneration.current || !ankiSyncHealthy.current) return;
      for (const card of removed) {
        const id = ankiPendingIds.current.get(card.id) ?? card.id;
        if (!ankiRemoteIds.current.has(id)) continue;
        await deleteAnkiCard(id);
        ankiRemoteIds.current.delete(id);
        ankiPendingIds.current.delete(card.id);
      }
      for (const card of changed) {
        const id = ankiPendingIds.current.get(card.id) ?? card.id;
        const input = { front: card.front, back: card.back, tags: card.tags.split(/\s+/).filter(Boolean) };
        if (ankiRemoteIds.current.has(id)) {
          await patchAnkiCard(id, input);
        } else if (input.front.trim()) {
          const created = await createAnkiCard(deckId, input);
          ankiRemoteIds.current.add(created.id);
          ankiPendingIds.current.set(card.id, created.id);
        }
      }
    }).catch(() => {
      if (generation === identityGeneration.current) {
        ankiSyncHealthy.current = false;
        setAnkiRemoteReady(false);
        setAnkiLoadFailed(true);
        setError('闪卡同步结果未确认，已暂停编辑；请先导出当前卡片备份，再重新连接。');
      }
    });
  }

  async function addAnkiCard(): Promise<AnkiCard | null> {
    if (!ankiDeckId || !ankiSyncHealthy.current) return null;
    try {
      const generation = identityGeneration.current;
      await ankiWriteQueue.current;
      if (generation !== identityGeneration.current) return null;
      const card = await createAnkiCard(ankiDeckId, { front: '', back: '', tags: [] });
      if (generation !== identityGeneration.current) return null;
      ankiRemoteIds.current.add(card.id);
      const display = { id: card.id, front: card.front, back: card.back, tags: '' };
      ankiCardsRef.current = [...ankiCardsRef.current, display];
      setAnkiCards(ankiCardsRef.current);
      setAnkiSchedules(current => ({ ...current, [card.id]: card }));
      return display;
    } catch {
      setError('新建闪卡失败，请稍后重试。');
      return null;
    }
  }

  async function reviewAnki(id: string, rating: 1 | 2 | 3 | 4) {
    const identity = identityRef.current;
    if (!identity || !ankiSyncHealthy.current) throw new Error('review_unavailable');
    const key = ankiReviewKey(identity, id);
    const pending = readPendingAnkiReview(key);
    if (pending && pending.rating !== rating) {
      setError('上次复习结果未确认，请使用相同评分重试，或重新打开牌组确认进度。');
      throw new Error('review_rating_mismatch');
    }
    const requestId = pending?.requestId ?? crypto.randomUUID().replaceAll('-', '');
    if (!pending) sessionStorage.setItem(key, JSON.stringify({
      requestId, rating, repsBefore: ankiSchedules[id]?.reps ?? 0,
    } satisfies PendingAnkiReview));
    try {
      await ankiWriteQueue.current;
      if (identity !== identityRef.current || !ankiSyncHealthy.current) throw new Error('review_unavailable');
      const resolved = ankiPendingIds.current.get(id) ?? id;
      const deckID = ankiDeckIdRef.current;
      const { card, reviewedAt } = await reviewAnkiCard(resolved, rating, requestId);
      if (identity !== identityRef.current) return;
      sessionStorage.removeItem(key);
      if (deckID === ankiDeckIdRef.current) {
        setAnkiSchedules(current => ({ ...current, [id]: card }));
        setAnkiLastStudyAt(current => Math.max(current ?? 0, reviewedAt));
      }
    } catch {
      if (identity === identityRef.current) setError('复习结果未确认；请用相同评分重试，系统不会重复计入。');
      throw new Error('review_not_saved');
    }
  }

  async function selectAnkiDeck(deck: RemoteAnkiDeck) {
    if (ankiDeckMutation.current || !ankiSyncHealthy.current) return;
    if (deck.id === ankiDeckId) {
      if (ankiWorkspaceRef.current) ankiWorkspaceRef.current.startStudy();
      else pendingStudyDeckRef.current = deck.id;
      return;
    }
    const generation = identityGeneration.current;
    const request = ++ankiDeckRequest.current;
    try {
      await ankiWriteQueue.current;
      if (generation !== identityGeneration.current || request !== ankiDeckRequest.current) return;
      const cards = await listAnkiCards(deck.id);
      if (generation !== identityGeneration.current || request !== ankiDeckRequest.current) return;
      const lastStudyAt = await deckStudySummary(deck.id);
      if (generation !== identityGeneration.current || request !== ankiDeckRequest.current) return;
      ankiDeckIdRef.current = deck.id;
      setAnkiDeckId(deck.id);
      setAnkiLastStudyAt(lastStudyAt);
      pendingStudyDeckRef.current = deck.id;
      adoptAnkiCards(cards);
    } catch {
      if (generation === identityGeneration.current && request === ankiDeckRequest.current) setError('暂时无法打开这个牌组，请稍后重试。');
    }
  }

  async function createAnkiDeck() {
    if (!ankiSyncHealthy.current || ankiDeckMutation.current) return;
    const name = window.prompt('新牌组名称');
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 120) { setError('牌组名称需为 1–120 个字符。'); return; }
    const generation = identityGeneration.current;
    ankiDeckMutation.current = true;
    setAnkiDeckBusy(true);
    try {
      await ankiWriteQueue.current;
      if (generation !== identityGeneration.current || !ankiSyncHealthy.current) return;
      const deck = await createDeck(trimmed);
      if (generation !== identityGeneration.current) return;
      ++ankiDeckRequest.current;
      setAnkiDecks(current => [...current, deck]);
      ankiDeckIdRef.current = deck.id;
      setAnkiDeckId(deck.id);
      setAnkiLastStudyAt(null);
      pendingStudyDeckRef.current = null;
      adoptAnkiCards([]);
    } catch {
      if (generation === identityGeneration.current) {
        ankiSyncHealthy.current = false;
        setAnkiRemoteReady(false);
        setAnkiLoadFailed(true);
        setError('创建牌组的结果未确认，请重新连接后核对牌组列表，勿立即重复创建。');
      }
    } finally {
      if (generation === identityGeneration.current) {
        ankiDeckMutation.current = false;
        setAnkiDeckBusy(false);
      }
    }
  }

  async function renameAnkiDeckAction(deck: RemoteAnkiDeck) {
    if (!ankiSyncHealthy.current || ankiDeckMutation.current) return;
    const name = window.prompt('重命名牌组', deck.name);
    if (name === null || name.trim() === deck.name) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 120) { setError('牌组名称需为 1–120 个字符。'); return; }
    const generation = identityGeneration.current;
    ankiDeckMutation.current = true;
    setAnkiDeckBusy(true);
    try {
      await ankiWriteQueue.current;
      if (generation !== identityGeneration.current || !ankiSyncHealthy.current) return;
      const updated = await renameAnkiDeck(deck.id, trimmed);
      if (generation !== identityGeneration.current) return;
      setAnkiDecks(current => current.map(item => item.id === updated.id ? updated : item));
    } catch {
      if (generation === identityGeneration.current) setError('牌组改名结果未确认，请重新打开工作区核对。');
    } finally {
      if (generation === identityGeneration.current) {
        ankiDeckMutation.current = false;
        setAnkiDeckBusy(false);
      }
    }
  }

  async function removeAnkiDeck(deck: RemoteAnkiDeck) {
    if (!ankiSyncHealthy.current || ankiDeckMutation.current) return;
    if (ankiDecks.length <= 1) { setError('请至少保留一个牌组；可以删除牌组中的卡片。'); return; }
    if (!window.confirm(`删除牌组“${deck.name}”及其中全部卡片？此操作无法撤销。`)) return;
    const generation = identityGeneration.current;
    ankiDeckMutation.current = true;
    setAnkiDeckBusy(true);
    try {
      await ankiWriteQueue.current;
      if (generation !== identityGeneration.current || !ankiSyncHealthy.current) return;
      await deleteAnkiDeck(deck.id);
      if (generation !== identityGeneration.current) return;
      ++ankiDeckRequest.current;
      setAnkiDecks(current => current.filter(item => item.id !== deck.id));
      if (ankiDeckIdRef.current === deck.id) {
        ankiSyncHealthy.current = false;
        setAnkiRemoteReady(false);
        await loadAnkiData(generation);
      }
    } catch {
      if (generation === identityGeneration.current) {
        ankiSyncHealthy.current = false;
        setAnkiRemoteReady(false);
        setAnkiLoadFailed(true);
        setError('删除牌组的结果未确认，请重新连接后核对牌组列表。');
      }
    } finally {
      if (generation === identityGeneration.current) {
        ankiDeckMutation.current = false;
        setAnkiDeckBusy(false);
      }
    }
  }

  function openAnkiCard(id: string) {
    setAnkiOpenCardId(id);
    if (window.innerWidth <= 720) setSidebarOpen(false);
  }

  async function addSampleCards() {
    if (!ankiDeckId || !ankiSyncHealthy.current) return;
    try {
      const deckId = ankiDeckId;
      const generation = identityGeneration.current;
      await ankiWriteQueue.current;
      if (generation !== identityGeneration.current || deckId !== ankiDeckIdRef.current) return;
      const cards = await Promise.all(sampleCards.map(card => createAnkiCard(deckId, { ...card, tags: card.tags.split(/\s+/) })));
      if (generation !== identityGeneration.current || deckId !== ankiDeckIdRef.current) return;
      cards.forEach(card => ankiRemoteIds.current.add(card.id));
      const display = cards.map(card => ({ id: card.id, front: card.front, back: card.back, tags: (card.tags ?? []).join(' ') }));
      ankiCardsRef.current = [...ankiCardsRef.current, ...display];
      setAnkiCards(ankiCardsRef.current);
      setAnkiSchedules(current => ({ ...current, ...Object.fromEntries(cards.map(card => [card.id, card])) }));
    } catch { setError('示例闪卡未全部保存，请重新打开牌组检查。'); }
  }

  async function exportAnki() {
    try {
      const blob = ankiRemoteReady && ankiDeckId ? await exportAnkiDeck(ankiDeckId) : new Blob([ankiCards.map(card => `${card.front}\t${card.back}\t${card.tags}`).join('\n')], { type: 'text/tab-separated-values;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = 'tjuclaw-anki-deck.tsv'; link.click();
      URL.revokeObjectURL(url);
    } catch { setError('导出闪卡失败，请稍后再试。'); }
  }

  function exportLegacyAnkiBackup() {
    try {
      const raw = localStorage.getItem('tjuclaw.anki.cards.v1');
      if (raw === null) return;
      const url = URL.createObjectURL(new Blob([raw], { type: 'application/json;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'tjuclaw-legacy-browser-cards.json';
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('无法读取旧版浏览器卡片，请检查浏览器存储权限。');
    }
  }

  async function importAnki(file: File) {
    if (!ankiRemoteReady || !ankiDeckId) return;
    const generation = identityGeneration.current;
    if (file.size > 200 * 1024) {
      setError('导入文件过大，请使用小于 200 KB 的 TSV 文件。');
      throw new Error('anki_import_too_large');
    }
    try {
      const tsv = await file.text();
      if (!tsv.split(/\r?\n/).some(line => line.split('\t').length >= 2)) {
        setError('请选择包含正面和背面两列的 TSV 文件。');
        throw new Error('anki_import_invalid');
      }
      await ankiWriteQueue.current;
      if (generation !== identityGeneration.current) throw new Error('anki_identity_changed');
      const name = file.name.replace(/\.(tsv|txt)$/i, '').trim().slice(0, 80) || '导入牌组';
      const imported = await importAnkiDeck(name, tsv);
      if (generation !== identityGeneration.current) return;
      setAnkiDecks(current => [...current, imported.deck]);
      ankiDeckIdRef.current = imported.deck.id;
      setAnkiDeckId(imported.deck.id);
      adoptAnkiCards(imported.cards);
    } catch (cause) {
      if (generation === identityGeneration.current && !(cause instanceof Error && cause.message.startsWith('anki_import_'))) {
        setError('导入闪卡失败，原有牌组未更改；请检查文件格式后重试。');
      }
      throw cause;
    }
  }

  function logoutWorkspace() {
    if (hasPrivateDrafts() && !window.confirm('私密笔记还有未保存的草稿。退出登录会丢失草稿，确定继续吗？')) return;
    clearRemoteWorkspaceUnlocks();
    clearPrivateDrafts();
    clearEntryCache();
    if (session && library) clearWorkspaceUnlock(session.id, library.id);
    void logout();
  }

  function jumpToHeading(item: OutlineHeading) {
    setActiveHeading(item.id);
    if (editorMode === 'preview' || !bodyRef.current) {
      const index = headings.findIndex(heading => heading.id === item.id);
      // Reading mode turns to the page holding the heading.
      const target = document.querySelectorAll('.markdown-preview :is(h1, h2, h3, h4, h5, h6)')[index];
      if (target) window.dispatchEvent(new CustomEvent('tjuclaw:reader-goto', { detail: target }));
      return;
    }
    const view = bodyRef.current;
    const line = view.state.doc.line(Math.min(item.line + 1, view.state.doc.lines));
    // Glide to the heading (scroll only: a caret would reveal its Markdown marks).
    let scroller: HTMLElement | null = view.dom;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    if (!scroller) { view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 72 }) }); return; }
    const target = () => Math.max(0, view.lineBlockAt(line.from).top + view.documentTop - scroller!.getBoundingClientRect().top + scroller!.scrollTop - 24);
    scroller.scrollTo({ top: target(), behavior: reduceMotion ? 'auto' : 'smooth' });
    // Heights of lines not yet drawn are estimates; once there, settle on the real position.
    for (const delay of [450, 900]) {
      window.setTimeout(() => {
        const exact = target();
        if (Math.abs(scroller!.scrollTop - exact) > 4) scroller!.scrollTo({ top: exact, behavior: reduceMotion ? 'auto' : 'smooth' });
      }, delay);
    }
  }

  function setOutlineOpen(open: boolean) {
    const pane = open ? 'outline' : 'files';
    setNotesPane(pane);
    if (open) { setSidebarOpen(true); if (view !== 'notes' && view !== 'anki') switchView('notes'); }
    try { localStorage.setItem(NOTES_PANE_KEY, pane); } catch { /* the choice lasts for this page */ }
  }

  // The outline keeps the section being read in sight as the page scrolls.
  useEffect(() => {
    if (notesPane !== 'outline' || !activeHeading) return;
    document.querySelector('.notes-outline-pane .outline-row.is-active')?.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
  }, [activeHeading, notesPane, reduceMotion]);

  /** The outline, after Typora: a collapsible tree that follows reading. */
  function outlineTree() {
    return <nav className="rail-section outline-list" aria-label="笔记大纲">{selected?.kind === 'note' && headings.length ? headings.map((item, index) => {
      const depth = item.level - outlineBase;
      const next = headings[index + 1];
      // Hidden while any enclosing heading is collapsed.
      let level = item.level;
      for (const above of headings.slice(0, index).reverse()) if (above.level < level) { if (collapsedHeadings.has(above.id)) return null; level = above.level; }
      const hasChildren = Boolean(next && next.level > item.level);
      const collapsed = collapsedHeadings.has(item.id);
      return <div key={item.id} className={`outline-row${activeHeading === item.id ? ' is-active' : ''}`} style={{ paddingLeft: depth * 14 }}>
        {hasChildren ? <button type="button" className="outline-toggle" aria-label={collapsed ? `展开 ${item.text}` : `折叠 ${item.text}`} aria-expanded={!collapsed} onClick={() => setCollapsedHeadings(current => { const nextSet = new Set(current); if (collapsed) nextSet.delete(item.id); else nextSet.add(item.id); return nextSet; })}><ChevronRight size={12} /></button> : <span className="outline-toggle" aria-hidden="true" />}
        <button className={`outline-item level-${depth + 1}`} type="button" aria-current={activeHeading === item.id ? 'location' : undefined} onClick={() => { jumpToHeading(item); if (isMobile) setSidebarOpen(false); }}>{item.text}</button>
      </div>;
    }) : <p className="outline-muted">{selected?.kind === 'note' ? '用 # 开头的行会作为标题出现在这里。' : '打开一篇笔记后，这里显示它的大纲。'}</p>}</nav>;
  }

  // The outline follows reading: the last heading above the top of the page is current.
  useEffect(() => {
    if (notesPane !== 'outline' || !sidebarOpen || view !== 'notes' || selected?.kind !== 'note' || !headings.length) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const scroller = document.querySelector('.note-editor');
      const top = (scroller?.getBoundingClientRect().top ?? 0) + 96;
      let current = headings[0].id;
      if (editorMode === 'preview' || !bodyRef.current) {
        // Pages: the last heading that starts on or before the page in view.
        const edge = document.querySelector('.paged-reader-viewport')?.getBoundingClientRect().right ?? Infinity;
        const nodes = document.querySelectorAll('.markdown-preview :is(h1, h2, h3, h4, h5, h6)');
        nodes.forEach((node, index) => { if (headings[index] && node.getBoundingClientRect().left < edge - 4) current = headings[index].id; });
      } else {
        const editor = bodyRef.current;
        const line = editor.state.doc.lineAt(editor.lineBlockAtHeight(Math.max(0, top - editor.documentTop)).from).number - 1;
        for (const heading of headings) if (heading.line <= line) current = heading.id;
      }
      setActiveHeading(current);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    document.addEventListener('scroll', schedule, true);
    window.addEventListener('tjuclaw:reader-page', schedule);
    return () => { document.removeEventListener('scroll', schedule, true); window.removeEventListener('tjuclaw:reader-page', schedule); if (frame) cancelAnimationFrame(frame); };
  }, [notesPane, sidebarOpen, view, selected?.id, selected?.kind, headings, editorMode]);

  function sidebarRow(id: string, group: string, label: string, icon: ReactNode, onClick: () => void, active = false, extraClass = '') {
    return <div className={`sidebar-sort-row${active ? ' is-active' : ''}${extraClass ? ` ${extraClass}` : ''}`} key={id} {...dragProps(id, group)}
      onContextMenu={event => openContextMenu(event, 'sidebar', id, group)}>
      <button className="session-tree-item" type="button" onClick={onClick}>{icon}<span>{label}</span></button>
      <button className="tree-more" type="button" aria-label="排序操作" onClick={event => openContextMenu(event, 'sidebar', id, group)}><MoreHorizontal size={14} /></button>
    </div>;
  }

  function openTool(id: CampusToolId) {
    setActiveToolId(id);
    const tool = campusToolList.find(item => item.id === id)!;
    const key = activeTabKey;
    if (key && tabs.some(tab => tab.key === key && tab.kind === 'tool')) {
      setTabs(current => current.map(tab => tab.key === key ? { ...tab, title: tool.name, toolId: id } : tab));
    } else {
      const nextKey = `tool-${crypto.randomUUID()}`;
      setTabs(current => [...current, { key: nextKey, kind: 'tool', title: tool.name, toolId: id, history: [], historyIndex: -1 }]);
      chooseTab(nextKey);
    }
    if (isMobile) setSidebarOpen(false);
  }

  function rootItem(item: Sortable) {
    return item.id.startsWith('folder:')
      ? renderFolder(folderRoots.find(folder => folder.id === item.id.slice(7))!)
      : <TreeItem key={item.id} entry={roots.find(entry => entry.id === item.id.slice(6))!} entries={visible} group="notes:root" selectedId={selectedId} onSelect={openEntry} onContextMenu={openContextMenu} orderChildren={orderChildren} dragProps={dragProps} />;
  }

  const toolItems = orderedItems(siblings('tools'), sidebarSort.tools, sidebarOrder.tools);
  // Drag handlers access dragSource only on user events, not while rows render.
  // eslint-disable-next-line react-hooks/refs
  const toolRows = toolItems.map(item => {
    const tool = campusToolList.find(candidate => `tool:${candidate.id}` === item.id)!;
    const Icon = tool.Icon;
    return sidebarRow(item.id, 'tools', tool.name, <Icon size={16} />, () => openTool(tool.id), activeToolId === tool.id);
  });

  if (loading || !session) return <WorkspaceLoading step={session ? loadStep : 'session'} />;
  if (!openingDone) return <WorkspaceLoading step="done" />;
  if (workspaceGate) return <WorkspacePassphraseGate identity={session.id} workspaceId={workspaceGate.workspaceId} workspaceName={workspaceGate.workspaceName} mode={workspaceGate.mode} verification={workspaceGate.verification} firstWorkspace={workspaceGate.firstWorkspace} accountEmail={session.email} onUnlocked={continueAfterWorkspaceUnlock} />;

  return <div className={`obsidian-app${entering.fade ? ' is-entering' : ''}${sidebarOpen ? '' : ' sidebar-collapsed'}${railOpen ? '' : ' rail-collapsed'}`} style={{ gridTemplateColumns: `${sidebarOpen ? sidebarWidth : 0}px minmax(0, 1fr) 0px` }}>
    <m.aside ref={sidebarRef} className="obsidian-sidebar" aria-hidden={!sidebarOpen} inert={!sidebarOpen}
      initial={false} animate={{ x: isMobile && !sidebarOpen ? '-100%' : '0%', opacity: isMobile && !sidebarOpen ? 0 : 1 }}
      transition={{ duration: reduceMotion ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] }}>
      {/* Notion-style sidebar: workspace, a pill row, the section's own list, apps. */}
      <div className="notion-side-head">
        <button type="button" className="sidebar-library-button" title={library?.name ?? '我的知识库'} aria-label={`${library?.name ?? '我的知识库'}，${fileCount} 个文件，${folders.length} 个文件夹`} onClick={() => { setSettingsSection('library'); setSettingsOpen(true); }}>
          <span className="notion-workspace-mark" aria-hidden="true"><LibraryBig size={16} strokeWidth={1.8} /></span>
          <span className="sidebar-library-copy"><strong className="sidebar-library-name">{library?.name ?? '我的知识库'}</strong><small>{fileCount} 个文件 · {folders.length} 个文件夹</small></span>
          <ChevronDown className="sidebar-library-chevron" size={14} />
        </button>
        <button type="button" className="notion-side-collapse" title="收起侧栏" aria-label="收起侧栏" onClick={() => setSidebarOpen(false)}><PanelLeft size={16} /></button>
      </div>
      <div className="notion-nav" aria-label="工作区导航">
        <button type="button" className={`notion-nav-home${sideView === 'notes' ? ' is-active' : ''}`} aria-current={sideView === 'notes' ? 'page' : undefined} onClick={() => switchView('notes')}><House size={16} /><span>主页</span></button>
        <button type="button" className={view === 'sessions' ? 'is-active' : ''} aria-label="Agent" title="Agent" aria-current={view === 'sessions' ? 'page' : undefined} onClick={() => switchView('sessions')}><MessageCircle size={16} /></button>
        <button type="button" className="notion-nav-search" aria-label="搜索" title="搜索" onClick={() => setCommandOpen(true)}><Search size={16} /></button>
      </div>
      <div className="sidebar-pane">
      {sideView === 'notes' ? <div className="notes-pane-tabs" role="tablist" aria-label="侧栏内容">
        <button type="button" role="tab" aria-selected={notesPane === 'files'} onClick={() => setOutlineOpen(false)}>文件</button>
        <button type="button" role="tab" aria-selected={notesPane === 'outline'} onClick={() => setOutlineOpen(true)}>大纲</button>
      </div> : null}
      {sideView === 'notes' && notesPane === 'outline' ? <div className="notes-outline-pane">{outlineTree()}</div> : <>
      <div className="tree-heading"><span>{sideView === 'notes' ? '私人' : sideView === 'sessions' ? '会话' : sideView === 'tools' ? '校园与专注' : '内置能力'}</span>
        <div className="tree-heading-actions">
          {sideView === 'notes' ? <><button type="button" disabled={Boolean(operations.create)} onClick={() => void createNote()} aria-label="新建笔记" title="新建 Markdown 笔记"><Plus size={15} /></button><button type="button" onClick={() => void createRichText()} aria-label="新建富文本文档" title="新建富文本文档"><FilePenLine size={15} /></button><button type="button" onClick={() => uploadPicker()} aria-label="上传文件" title="上传文件"><FileUp size={15} /></button><button type="button" onClick={() => createFolder()} aria-label="新建文件夹"><FolderPlus size={15} /></button></> : null}
          {sideView === 'sessions' ? <button type="button" onClick={() => void startNewChat()} aria-label="新建对话" title="新对话"><Plus size={15} /></button> : null}
          {sideView !== 'sessions' ? <div className="sidebar-sort-anchor" ref={sortMenuRef}>
            <button type="button" aria-label="侧栏排序" aria-expanded={sortMenuOpen} title={`排序：${sortLabels[sidebarSort[sideView]]}`} onClick={() => setSortMenuOpen(open => !open)}><ListTree size={15} /></button>
            {sortMenuOpen ? <div className="sidebar-sort-menu" role="menu" aria-label="侧栏排序方式">
              {(sideView === 'notes' ? Object.keys(sortLabels) : ['manual', 'name-asc', 'name-desc']).map(mode => <button type="button" role="menuitemradio" aria-checked={sidebarSort[sideView] === mode} key={mode} onClick={() => changeSort(mode as SortMode)}><span>{sortLabels[mode as SortMode]}</span>{sidebarSort[sideView] === mode ? <Check size={14} /> : null}</button>)}
              <small>拖动或在项目操作中上移/下移，可改为手动排序</small>
            </div> : null}
          </div> : null}
        </div>
      </div>
      <input ref={uploadRef} type="file" multiple hidden aria-label="上传课程资料" onChange={event => { void handleFileUpload(event.target.files); event.target.value = ''; }} />
      <nav className="obsidian-tree">
        {sideView === 'tools' ? <div className="campus-sidebar-list">{toolRows}</div> : sideView === 'plugins' ? <>
          {orderedItems(siblings('plugins'), sidebarSort.plugins, sidebarOrder.plugins).map(item => { const plugin = builtInPlugins.find(candidate => `plugin:${candidate.id}` === item.id)!; const Icon = plugin.Icon; return sidebarRow(item.id, 'plugins', plugin.name, <Icon size={15} />, () => { setActivePluginId(plugin.id); if (isMobile) setSidebarOpen(false); }, activePluginId === plugin.id); })}
          <p className="plugin-sidebar-note">更多插件即将上线</p>
        </> : sideView === 'notes' ? <>
          {orderedItems([
            ...folderRoots.map(folder => ({ id: `folder:${folder.id}`, title: folder.name })),
            ...roots.map(entry => ({ id: `entry:${entry.id}`, title: entry.title, updated_at: entry.updated_at })),
          ], sidebarSort.notes, sidebarOrder['notes:root']).map(rootItem)}
          <div className="notes-flashcards">
            <div className="tree-heading notes-flashcards-heading">
              <button type="button" className={`notes-flashcards-title${view === 'anki' ? ' is-active' : ''}`} aria-current={view === 'anki' ? 'page' : undefined} onClick={() => switchView('anki')}>记忆闪卡</button>
              <div className="tree-heading-actions">
                <button type="button" disabled={!ankiRemoteReady || ankiDeckBusy} onClick={() => { if (view !== 'anki') switchView('anki'); void createAnkiDeck(); }} aria-label="新建牌组" title="新建牌组"><FolderPlus size={15} /></button>
                <button type="button" disabled={!ankiRemoteReady || ankiDeckBusy} onClick={() => { if (view !== 'anki') switchView('anki'); void addAnkiCard().then(card => { if (card) setAnkiOpenCardId(card.id); }); }} aria-label="新建卡片"><Plus size={15} /></button>
              </div>
            </div>
            <div className="anki-sidebar-list">
          {ankiDecks.map(deck => <Fragment key={deck.id}><div className="anki-sidebar-deck-row"><button type="button" disabled={ankiDeckBusy} className={`anki-sidebar-deck${view === 'anki' && ankiDeckId === deck.id ? ' is-active' : ''}`} onClick={() => { if (view !== 'anki') switchView('anki'); void selectAnkiDeck(deck); }}><SquareStack size={15} /><span><strong>{deck.name}</strong>{ankiDeckId === deck.id && ankiCards.length ? <small>{ankiCards.length}</small> : null}</span></button><span className="anki-deck-actions"><button type="button" className="anki-deck-action" disabled={ankiDeckBusy} onClick={() => void renameAnkiDeckAction(deck)} aria-label={`重命名牌组 ${deck.name}`} title="重命名牌组"><Pencil size={13} /></button><button type="button" className="anki-deck-action" disabled={ankiDeckBusy || ankiDecks.length <= 1} onClick={() => void removeAnkiDeck(deck)} aria-label={`删除牌组 ${deck.name}`} title={ankiDecks.length <= 1 ? '请至少保留一个牌组' : '删除牌组及全部卡片'}><Trash2 size={13} /></button></span></div>
          {view === 'anki' && ankiDeckId === deck.id ? orderedItems(siblings('anki'), sidebarSort.anki, sidebarOrder.anki).map((item, index) => { const card = ankiCards.find(candidate => `card:${candidate.id}` === item.id)!; return sidebarRow(item.id, 'anki', card.front || `新卡片 ${index + 1}`, <StickyNote size={15} />, () => openAnkiCard(card.id), false, 'anki-card'); }) : null}</Fragment>)}
        </div>
          </div>
        </> : <>
          {listedConversations.filter(item => !query.trim() || (item.title ?? '').toLowerCase().includes(query.trim().toLowerCase())).map(item =>
            <div key={item.id} className={`sidebar-sort-row conversation-row${view === 'sessions' && chat?.id === item.id ? ' is-active' : ''}`}>
              <button className="session-tree-item" type="button" onClick={() => openConversation(item.entryId, item.id)}><MessageCircle size={15} /><span>{item.title ?? '…'}</span></button>
            </div>)}
          {!listedConversations.length ? <p className="plugin-sidebar-note">还没有对话</p> : null}
        </>}
      </nav>
      </>}
      <div className="notion-side-section notion-apps" aria-label="应用">
        <div className="tree-heading"><span>应用</span></div>
        {([
          { id: 'tools', label: '小工具', Icon: Wrench },
        ] as const).map(({ id, label, Icon }) => <button key={id} type="button" className={`notion-side-row${view === id ? ' is-active' : ''}`} aria-current={view === id ? 'page' : undefined} onClick={() => switchView(id)}><Icon size={15} /><span>{label}</span></button>)}
        <button type="button" className="notion-side-row" onClick={() => setGraphOpen(true)}><Network size={15} /><span>知识图谱</span></button>
        <button type="button" className="notion-side-row" onClick={() => { setSettingsSection('appearance'); setSettingsOpen(true); }}><Settings size={15} /><span>设置</span></button>
      </div>
      <div className="sidebar-bottom notion-side-bottom" aria-label="工作区工具">
        <button type="button" className="notion-new-chat" onClick={() => void startNewChat()}><MessageCircle size={15} /><span>新对话</span></button>
        <button type="button" className="notion-new-page" title="新建笔记" aria-label="新建笔记页面" onClick={() => void createNote()}><SquarePen size={16} /></button>
      </div>
      </div>
    </m.aside>
    <AnimatePresence initial={false}>{isMobile && sidebarOpen ? <m.button type="button" className="mobile-sidebar-backdrop" aria-label="收起侧栏" onClick={() => setSidebarOpen(false)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduceMotion ? 0 : 0.18 }} /> : null}</AnimatePresence>
    <div className="panel-resizer panel-resizer-sidebar" style={{ left: sidebarOpen ? sidebarWidth : 0 }} role="separator" aria-label="调整左侧面板宽度" onPointerDown={event => startResize('sidebar', event)} />
    <main className="obsidian-main" inert={(sidebarOpen || railOpen) && window.innerWidth <= 720}>
      <header className="obsidian-topbar"><Button variant="ghost" size="icon" className="sidebar-opener" onClick={() => setSidebarOpen(value => !value)} aria-label={sidebarOpen ? '收起侧栏' : '打开侧栏'}><PanelLeft size={18} /></Button>{/* Phones show the current page instead of a tab strip; tabs live in a bottom sheet. */}<button type="button" className="mobile-tab-title" onClick={() => setTabSheetOpen(true)} aria-haspopup="dialog" aria-label={`标签页：${visibleTabs.find(tab => tab.key === activeTabKey)?.title || '未命名笔记'}，共 ${visibleTabs.length} 个`}><span>{visibleTabs.find(tab => tab.key === activeTabKey)?.title || (visibleTabs.length ? '未命名笔记' : '标签页')}</span><ChevronDown size={15} aria-hidden="true" /></button><div className="workspace-tabs" role="tablist" aria-label="打开的标签页">{visibleTabs.map(tab => <div key={tab.key} className={`workspace-tab${activeTabKey === tab.key ? ' is-active' : ''}`} role="presentation"><button type="button" role="tab" aria-selected={activeTabKey === tab.key} aria-label={`${tab.kind === 'agent' || tab.kind === 'agent-blank' ? '会话' : tab.kind === 'anki' ? '闪卡' : tab.kind === 'tool' ? '小工具' : '笔记'} ${tab.title || '未命名笔记'}`} onClick={() => activateTab(tab)}><span>{tab.title || '未命名笔记'}</span></button><button type="button" className="workspace-tab-close" aria-label={`关闭标签 ${tab.title || '未命名笔记'}`} title="关闭标签" onClick={() => closeTab(tab.key)}><X size={14} /></button></div>)}</div><button type="button" className="workspace-new-tab" aria-label="新建标签页" title="新建标签页" onClick={() => newBlankTab()}><Plus size={18} /></button><div className="topbar-actions">{selected && (selected.kind === 'note' || selected.kind === 'rich_text') && view === 'notes' ? <div className="note-topbar-controls"><div className="note-history"><button type="button" onClick={() => moveTabHistory(-1)} disabled={!activeTab || activeTab.historyIndex <= 0} aria-label="上一个笔记" title="上一个笔记"><ArrowLeft size={16} /></button><button type="button" onClick={() => moveTabHistory(1)} disabled={!activeTab || activeTab.historyIndex >= activeTab.history.length - 1} aria-label="下一个笔记" title="下一个笔记"><ArrowRight size={16} /></button></div><div className="mode-switch"><button type="button" className={editorMode === 'edit' ? 'is-active' : ''} onClick={() => setEditorMode('edit')} aria-label="编辑模式" title="编辑模式"><Pencil size={15} /></button><button type="button" className={editorMode === 'preview' ? 'is-active' : ''} onClick={() => setEditorMode('preview')} aria-label="阅读模式" title="阅读模式"><Eye size={15} /></button></div></div> : null}{selected?.kind === 'note' && view === 'notes' && gitStatus?.enabled ? <Button variant="ghost" size="icon" onClick={() => setHistoryOpen(true)} aria-label="版本历史" title="版本历史（Git）"><History size={17} /></Button> : null}{view === 'sessions' && selected?.kind === 'agent' ? <><Button variant="ghost" size="icon" onClick={() => void startNewChat()} aria-label="新会话" title="新会话"><SquarePen size={17} /></Button></> : null}<Button variant="ghost" size="icon" onClick={() => setCommandOpen(true)} aria-label="快速切换" title="快速切换"><Search size={17} /></Button></div><div className="mobile-topbar-actions"><button type="button" className="mobile-tab-count" onClick={() => setTabSheetOpen(true)} aria-label={`打开的标签页（${visibleTabs.length}）`}><span>{visibleTabs.length}</span></button>{selected?.kind === 'note' && view === 'notes' ? <button type="button" onClick={() => setEditorMode(value => value === 'edit' ? 'preview' : 'edit')} aria-label={editorMode === 'edit' ? '阅读模式' : '编辑模式'}>{editorMode === 'edit' ? <BookOpen size={18} /> : <Pencil size={18} />}</button> : null}<button type="button" onClick={event => { event.stopPropagation(); if (selected?.kind === 'note' && view === 'notes') setContextMenu({ x: 0, y: 0, kind: 'note', id: selected.id }); else if (view === 'sessions') setContextMenu({ x: 0, y: 0, kind: 'session' }); else setCommandOpen(true); }} aria-label="更多操作"><MoreHorizontal size={19} /></button></div></header>
      {tabSheetOpen ? <div className="mobile-tab-sheet-backdrop" onClick={() => setTabSheetOpen(false)}>
        <div className="mobile-tab-sheet" role="dialog" aria-modal="true" aria-label="标签页" onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Escape') setTabSheetOpen(false); }}>
          <div className="mobile-tab-sheet-grip" aria-hidden="true" />
          <div className="mobile-tab-sheet-head"><strong>标签页</strong><span>{visibleTabs.length} 个</span><button type="button" autoFocus onClick={() => setTabSheetOpen(false)} aria-label="关闭标签页列表"><X size={18} /></button></div>
          <ul>{visibleTabs.map(tab => <li key={tab.key} className={activeTabKey === tab.key ? 'is-active' : ''}>
            <button type="button" className="mobile-tab-sheet-open" aria-current={activeTabKey === tab.key ? 'page' : undefined} onClick={() => { activateTab(tab); setTabSheetOpen(false); }}><small>{(tab.kind === 'agent' || tab.kind === 'agent-blank' ? '会话' : tab.kind === 'anki' ? '闪卡' : tab.kind === 'tool' ? '小工具' : '笔记')}</small><span>{tab.title || '未命名笔记'}</span></button>
            <button type="button" className="mobile-tab-sheet-close" aria-label={`关闭标签 ${tab.title || '未命名笔记'}`} onClick={() => closeTab(tab.key)}><X size={17} /></button>
          </li>)}</ul>
          {visibleTabs.length ? null : <p className="mobile-tab-sheet-empty">还没有打开的标签页</p>}
          <button type="button" className="mobile-tab-sheet-new" onClick={() => { newBlankTab(); setTabSheetOpen(false); }}><Plus size={17} />新建标签页</button>
        </div>
      </div> : null}
      {Object.entries(operations).map(([key, label]) => <OperationProgress key={key} label={label} />)}
      {error ? <div className="workspace-error">{error}<button type="button" onClick={() => setError('')}><X size={14} /></button></div> : null}
      {saveConflictId ? <div className="workspace-save-conflict" role="alert"><span>「{entries.find(entry => entry.id === saveConflictId)?.title || '未命名笔记'}」云端已更新，本地内容未保存。请先复制备份，再决定是否加载云端版本。</span>{selectedId !== saveConflictId ? <button type="button" onClick={() => void openEntry(saveConflictId)}>返回冲突笔记</button> : null}<button type="button" onClick={() => void copyConflictDraft()}>复制我的内容</button><button type="button" onClick={() => void discardConflictDraft()}>加载云端版本</button></div> : null}
      {saveFailedId ? <div className="workspace-save-conflict" role="alert"><span>「{entries.find(entry => entry.id === saveFailedId)?.title || '未命名笔记'}」尚未保存。请重试，成功前不要关闭页面。</span>{selectedId !== saveFailedId ? <button type="button" onClick={() => void openEntry(saveFailedId)}>返回未保存笔记</button> : null}<button type="button" onClick={retryFailedSave}>重试保存</button></div> : null}
      <div className="workspace-view" key={view}>
      <Suspense fallback={<OperationProgress label="正在加载分区界面" />}>
      {view === 'tools' ? <CampusTools key={session.id} identity={session.id} activeId={activeToolId} onOpenAccounts={() => { setSettingsSection('campus'); setSettingsOpen(true); }} suspended={settingsOpen} /> : view === 'sessions' && selected?.kind === 'agent' ? <AgentThread renderMarkdown={renderMarkdown} title="TJUClaw" chat={chat} capabilities={agentCapabilities} loading={chatLoading} error={chatError} draft={draft} sending={chatSending} pending={pendingText} modelVersion={settingsOpen ? 1 : 0} onDraftChange={changeDraft} onSubmit={handleChat} onRetry={() => void openEntry(selected.id)} onManageModels={() => { setSettingsSection('model'); setSettingsOpen(true); }} onNewChat={() => void startNewChat()} onShowHistory={() => setSidebarOpen(true)} /> : view === 'plugins' ? <WorkspacePlugins activeId={activePluginId} onOpen={id => {
        if (id === 'graph') { setGraphOpen(true); return; }
        switchView(id === 'flashcards' ? 'anki' : 'notes');
      }} /> : view === 'anki' ? ankiRemoteReady
        ? <AnkiWorkspace key={`${session.id}:${ankiDeckId}`} ref={attachAnkiWorkspace} cards={ankiCards} identity={session.id} deckName={ankiDeckName} schedules={ankiSchedules} lastStudyAt={ankiLastStudyAt} onCreateCard={addAnkiCard} onReviewCard={reviewAnki} onImportFile={importAnki} onCardsChange={saveAnkiCards} onExport={() => void exportAnki()} onAddSampleCards={addSampleCards} openCardId={ankiOpenCardId} onOpenCardHandled={() => setAnkiOpenCardId(null)} />
        : <section className="workspace-blank anki-recovery" aria-label="闪卡服务不可用"><SquareStack size={25} /><p>{ankiLoadFailed ? '闪卡连接中断，编辑已暂停。重试会重新读取服务端卡片，未确认的修改可能被覆盖。' : '正在连接闪卡服务…'}</p>{ankiLoadFailed ? <div className="anki-recovery-actions"><button type="button" onClick={() => { ankiSyncHealthy.current = false; void loadAnkiData(identityGeneration.current); }}>重试连接</button>{ankiCards.length && ankiDeckId ? <button type="button" onClick={() => void exportAnki()}>导出当前卡片备份</button> : null}{legacyAnkiBackupAvailable ? <button type="button" onClick={exportLegacyAnkiBackup}>下载旧版浏览器备份</button> : null}</div> : null}</section>
        : view === 'sessions' ? <section className="workspace-blank" aria-label="新对话"><button type="button" className="settings-action-button" onClick={() => void startNewChat(activeTabKey ?? undefined, true)}><MessageCircle size={15} /> 开始新对话</button></section> : !selected ? <NewNoteHome entries={entries} busy={Boolean(operations.create)} onCreate={(noteTitle, initialBody) => void createNote(noteTitle, initialBody)} onCreateRich={() => void createRichText()} onUpload={() => uploadPicker()} onOpen={id => void openEntry(id)} /> : selected.kind === 'file' ? <FilePreview key={selected.id} entry={selected} renameRequest={fileRenameRequest} onRename={name => void renameFile(selected, name)} /> : <article className={`note-editor${editorMode === 'preview' && selected.kind === 'note' ? ' is-reading' : ''}`} onContextMenu={selected.kind === 'note' ? event => openContextMenu(event, 'editor') : undefined}>
        {isMobile ? <div className="note-toolbar"><div className="note-history"><button type="button" onClick={() => moveTabHistory(-1)} disabled={!activeTab || activeTab.historyIndex <= 0} aria-label="上一个笔记" title="上一个笔记"><ArrowLeft size={17} /></button><button type="button" onClick={() => moveTabHistory(1)} disabled={!activeTab || activeTab.historyIndex >= activeTab.history.length - 1} aria-label="下一个笔记" title="下一个笔记"><ArrowRight size={17} /></button></div></div> : null}
        <input ref={titleRef} className="note-title" aria-label="标题" value={title} onChange={event => { setTitle(event.target.value); queueSave(event.target.value, body); }} placeholder={selected.kind === 'rich_text' ? '未命名文档' : '未命名笔记'} />
        {selected.kind === 'rich_text'
          ? <Suspense fallback={<div className="rich-text-loading" role="status">正在打开文档…</div>}><RichTextEditor key={selected.id} value={body} readOnly={editorMode === 'preview'} onChange={nextBody => { setBody(nextBody); queueSave(title, nextBody); }} /></Suspense>
          : editorMode === 'preview' ? <PagedReader key={selected.id} className="note-reader" storageKey={`tjuclaw.reader.v1.${selected.id}`} chapters={[{ id: selected.id, title: title || '未命名笔记', html: renderMarkdown(body, true) }]} /> : <MarkdownEditor key={`${selected.id}:${restoreNonce}`} value={body} onChange={nextBody => { setBody(nextBody); queueSave(title, nextBody); }} editorRef={bodyRef} />}
      </article>}
      </Suspense>
      </div>
      {!isMobile && view !== 'sessions' && view !== 'notes' && view !== 'anki' ? <button type="button" className="notion-ai-fab" aria-label="问 AI" title="问 AI" onClick={() => switchView('sessions')}><BrandIcon size={24} /></button> : null}
      <nav className="mobile-command-bar" aria-label="快捷操作">
        <button type="button" className="mobile-bar-round" onClick={() => setCommandOpen(true)} aria-label="搜索和快速切换"><Search size={20} /></button>
        <button type="button" className="mobile-bar-ask" onClick={() => { setSidebarOpen(false); switchView('sessions'); }} aria-label="打开 Agent"><span className="mobile-bar-ask-mark"><BrandIcon size={20} /></span><span>问 AI</span></button>
        <button type="button" className="mobile-bar-round" disabled={Boolean(operations.create)} onClick={() => void createNote()} aria-label="新建笔记"><SquarePen size={20} /></button>
      </nav>
      <footer className="workspace-statusbar"><span>{library?.name ?? '我的知识库'}</span><span className="statusbar-details">{<>{saveConflictId ? `保存冲突 · ${selectedId === saveConflictId ? '当前内容' : '另一篇笔记'}未保存` : saveFailedId ? `保存失败 · ${selectedId === saveFailedId ? '当前内容' : '另一篇笔记'}未保存` : saving ? '保存中…' : '已保存'}{selected?.kind === 'note' ? ` · ${body.length} 字符` : ''}{selected && (selected.kind === 'note' || selected.kind === 'rich_text') && view === 'notes' ? ` · ${editedLabel(selected.updated_at)}` : ''}{gitStatusLabel(gitStatus) ? ` · ${gitStatusLabel(gitStatus)}` : ''}</>}</span></footer>
      {selected?.kind === 'note' && gitStatus?.enabled && historyOpen ? <Suspense fallback={<OperationProgress label="正在加载版本历史" />}><NoteHistory key={selected.id} entryId={selected.id} title={title} open={historyOpen} onOpenChange={setHistoryOpen} current={body} renderMarkdown={renderMarkdown}
        onRestore={content => { setBody(content); queueSave(title, content); setRestoreNonce(value => value + 1); }} /></Suspense> : null}
    </main>
    {contextMenu ? <><button className="mobile-context-backdrop" type="button" aria-label="关闭操作菜单" onClick={() => setContextMenu(null)} /><WorkspaceContextMenu menu={contextMenu} onClose={() => setContextMenu(null)} onAction={handleContextAction} /></> : null}
    <Suspense fallback={<div className="workspace-feature-loading"><OperationProgress label="正在加载设置" /></div>}>{settingsOpen ? <WorkspaceSettings open={settingsOpen} onOpenChange={setSettingsOpen} section={settingsSection} onSectionChange={setSettingsSection} libraryName={library?.name ?? '我的知识库'} fileCount={fileCount} noteCount={noteCount} folderCount={folders.length} cardCount={ankiCards.length} email={session.email} editorMode={editorMode} onEditorModeChange={setEditorMode} onShowNotes={() => { setView('notes'); setSettingsOpen(false); setSidebarOpen(true); }} onShowCards={() => { setView('anki'); setSettingsOpen(false); setSidebarOpen(true); }} onExportCards={exportAnki} legacyAnkiBackupAvailable={legacyAnkiBackupAvailable} onExportLegacyAnkiBackup={exportLegacyAnkiBackup} onLogout={logoutWorkspace} identity={session.id} onOpenPlugin={id => {
      setSettingsOpen(false);
      if (id === 'graph') { setGraphOpen(true); return; }
      switchView(id === 'flashcards' ? 'anki' : 'notes');
    }} /> : null}</Suspense>
    <Suspense fallback={<div className="workspace-feature-loading"><OperationProgress label="正在加载知识图谱" /></div>}>{graphOpen ? <KnowledgeGraph key={session.id} open={graphOpen} onOpenChange={setGraphOpen} entries={entries} onOpenNote={id => { void openEntry(id); setGraphOpen(false); }} /> : null}</Suspense>
    <Dialog open={moveEntryId !== null} onOpenChange={open => { if (!open) setMoveEntryId(null); }}><DialogContent className="workspace-move-dialog"><DialogTitle>移动到</DialogTitle><DialogDescription>选择文档所在的文件夹</DialogDescription><div className="workspace-folder-picker"><button type="button" onClick={() => moveEntryId && moveEntry(moveEntryId, null)}><Folder size={17} /> 知识库根目录 <MoveRight size={15} /></button>{folders.map(folder => <button key={folder.id} type="button" onClick={() => moveEntryId && moveEntry(moveEntryId, folder.id)} style={{ paddingLeft: 16 + folders.filter(parent => parent.id === folder.parentId).length * 16 }}><Folder size={17} /> {folder.name} <MoveRight size={15} /></button>)}</div></DialogContent></Dialog>
    <Suspense fallback={<div className="workspace-feature-loading"><OperationProgress label="正在加载快速切换" /></div>}>{commandOpen ? <SearchPalette open={commandOpen} onOpenChange={setCommandOpen} libraryId={library?.id} sources={{
      notes: entries.filter(item => item.kind === 'note' || item.kind === 'rich_text' || item.kind === 'file').map(item => ({ id: item.id, title: item.title, updatedAt: item.updated_at })),
      conversations: listedConversations.map(item => ({ id: item.id, title: item.title ?? '新对话' })),
      decks: ankiDecks.map(deck => ({ id: deck.id, name: deck.name })),
      tools: campusToolList.map(tool => ({ id: tool.id, name: tool.name })),
      openNote: id => { switchView('notes'); void openEntry(id); },
      openConversation: id => { const item = listedConversations.find(row => row.id === id); if (item) { switchView('sessions'); openConversation(item.entryId, id); } },
      openDeck: id => { const deck = ankiDecks.find(item => item.id === id); if (deck) { switchView('anki'); void selectAnkiDeck(deck); } },
      openTool: id => { switchView('tools'); openTool(id as CampusToolId); },
      newNote: noteTitle => void createNote(noteTitle),
      newChat: () => void startNewChat(),
      openGraph: () => setGraphOpen(true),
      openSettings: () => { setSettingsSection('appearance'); setSettingsOpen(true); },
    }} /> : null}</Suspense>
  </div>;
}
