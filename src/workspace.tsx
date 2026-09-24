import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowLeft, ArrowUp, ArrowRight, Blocks, BookOpen, Brain, Check, CheckSquare, ChevronDown, ChevronRight, Copy, FileText, FilePlus2, Folder, FolderInput, FolderOpen, FolderPlus, LibraryBig, ListTree, Loader2, MousePointer2, Network, PanelLeft, Plus, Search, Settings, Sparkles, Trash2, X, Eye, Pencil, Link2, MoreHorizontal, Quote, Table2, MoveRight, Wrench } from 'lucide-react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { EditorView } from '@codemirror/view';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Button } from './components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './components/ui/dialog';
import { MarkdownEditor } from './components/markdown-editor';
import { KnowledgeGraph } from './components/knowledge-graph';
import { WorkspaceSettings, type SettingsSection } from './components/workspace-settings';
import { WorkspacePassphraseGate } from './components/workspace-passphrase-gate';
import { builtInPlugins, WorkspacePlugins, type BuiltInPluginId } from './components/workspace-plugins';
import { campusToolList, CampusTools, type CampusToolId } from './components/campus-tools';
import { createCard as createAnkiCard, createDeck, deleteCard as deleteAnkiCard, exportDeck as exportAnkiDeck, listCards as listAnkiCards, listDecks, patchCard as patchAnkiCard, type AnkiDeck as RemoteAnkiDeck } from './lib/anki';
import { AnkiWorkspace, type AnkiCard, type AnkiWorkspaceHandle } from './components/anki-workspace';
import { AuthError, logout, readSession, type IdentitySession } from './lib/auth';
import { createEntry, createFolder as createFolderRemote, createSession, deleteEntry, deleteFolder as deleteFolderRemote, getEntry, getSession, listEntries, listLibraries, listSessions, moveEntry as moveEntryRemote, patchEntry, patchFolder, reorderEntries, sendMessage, type ChatSession, type Entry, type Library } from './lib/library';
import { clearWorkspaceUnlock, hasWorkspacePassphrase, isWorkspaceUnlocked } from './lib/workspace-vault';
import './product.css';
import './workspace.css';
import './obsidian-shell.css';

type VaultFolder = { id: string; name: string; parentId: string | null };
type VaultPlacement = Record<string, string | null>;
type SidebarView = 'notes' | 'sessions' | 'anki' | 'plugins' | 'tools';
type SortMode = 'manual' | 'name-asc' | 'name-desc' | 'recent';
type SidebarSort = Record<SidebarView, SortMode>;
type Sortable = { id: string; title: string; updated_at?: string };
type ContextMenuState = { x: number; y: number; kind: 'folder' | 'note' | 'editor' | 'sidebar'; id?: string; group?: string } | null;
type WorkspaceGateState = { workspaceId: string | null; workspaceName: string; mode: 'setup' | 'unlock'; firstWorkspace?: boolean } | null;
const ACTIVITY_RAIL_WIDTH = 48;
const defaultSidebarSort: SidebarSort = { notes: 'manual', sessions: 'manual', anki: 'manual', plugins: 'manual', tools: 'manual' };
const sortLabels: Record<SortMode, string> = { manual: '手动排序', 'name-asc': '名称 A → Z', 'name-desc': '名称 Z → A', recent: '最近修改' };
const nameCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

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

function defaultContentPaneWidth() {
  return Math.min(340, Math.max(245, Math.round((window.innerWidth - ACTIVITY_RAIL_WIDTH) * 0.191)));
}

function WorkspaceContextMenu({ menu, onClose, onAction }: { menu: Exclude<ContextMenuState, null>; onClose: () => void; onAction: (action: string) => void }) {
  const icons: Record<string, ReactNode> = {
    'new-note': <FilePlus2 size={18} />,
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
  };
  const items = menu.kind === 'folder'
    ? [['new-note', '新建笔记'], ['new-folder', '新建文件夹'], ['divider', ''], ['move-up', '上移'], ['move-down', '下移'], ['divider', ''], ['rename', '重命名'], ['delete', '删除']]
    : menu.kind === 'note'
      ? [['open', '打开'], ['outline', '大纲'], ['move', '移动到…'], ['divider', ''], ['move-up', '上移'], ['move-down', '下移'], ['divider', ''], ['rename', '重命名'], ['delete', '删除']]
      : menu.kind === 'sidebar' ? [['move-up', '上移'], ['move-down', '下移']]
        : [['copy', '复制 Markdown'], ['select-all', '全选']];
  return <div className="workspace-context-menu" style={{ left: menu.x, top: menu.y }} role="menu" aria-label="文档操作" onContextMenu={event => event.preventDefault()}>
    {items.map(([action, label], index) => action === 'divider'
      ? <div className="workspace-context-divider" key={`divider-${index}`} />
      : <button key={action} type="button" className={action === 'delete' ? 'is-danger' : ''} role="menuitem" onClick={() => { onAction(action); onClose(); }}>{icons[action]}<span>{label}</span></button>)}
  </div>;
}

function TreeItem({ entry, entries, group, selectedId, onSelect, onContextMenu, orderChildren, dragProps }: { entry: Entry; entries: Entry[]; group: string; selectedId: string | null; onSelect: (id: string) => void; onContextMenu: (event: MouseEvent, kind: 'note', id: string, group?: string) => void; orderChildren: (items: Entry[], group: string) => Entry[]; dragProps: (id: string, group: string) => React.HTMLAttributes<HTMLDivElement> & { draggable: boolean } }) {
  const [open, setOpen] = useState(true);
  const children = orderChildren(entries.filter(item => item.parent_id === entry.id && item.kind === 'note'), `notes:entry:${entry.id}`);
  return <div className="obsidian-tree-node">
    <div className={`obsidian-tree-row${selectedId === entry.id ? ' is-active' : ''}`} {...dragProps(`entry:${entry.id}`, group)} onContextMenu={event => onContextMenu(event, 'note', `entry:${entry.id}`, group)}>
      {children.length ? <button className="tree-toggle" type="button" onClick={() => setOpen(value => !value)} aria-label="展开或折叠"><ChevronRight size={13} data-open={open ? 'true' : 'false'} /></button> : <span className="tree-spacer" />}
      <button className="tree-item" type="button" onClick={() => onSelect(entry.id)}><FileText size={15} /><span>{entry.title || '未命名笔记'}</span></button><button className="tree-more" type="button" onClick={event => onContextMenu(event, 'note', `entry:${entry.id}`, group)} aria-label="文档操作"><MoreHorizontal size={14} /></button>
    </div>
    {open && children.length ? <div className="tree-children">{children.map(child => <TreeItem key={child.id} entry={child} entries={entries} group={`notes:entry:${entry.id}`} selectedId={selectedId} onSelect={onSelect} onContextMenu={onContextMenu} orderChildren={orderChildren} dragProps={dragProps} />)}</div> : null}
  </div>;
}

type WorkspaceTab = { key: string; kind: 'note' | 'agent' | 'blank' | 'agent-blank' | 'anki' | 'tool'; title: string; entryId?: string; toolId?: CampusToolId; history: string[]; historyIndex: number };
const sampleCards: Array<{ front: string; back: string; tags: string }> = [
  { front: '什么是主动回忆？', back: '不看答案，先尝试从记忆中提取知识，再核对并修正。', tags: '学习方法 示例' },
  { front: '间隔复习的核心做法是什么？', back: '在遗忘前后分散复习，而不是集中在一天反复阅读。', tags: '学习方法 示例' },
  { front: 'Markdown 中 [[笔记名]] 通常表示什么？', back: '指向另一篇笔记的内部链接，可以用来建立知识关联。', tags: 'Markdown 示例' },
  { front: '导数 f′(x) 的几何意义是什么？', back: '函数曲线在 x 处切线的斜率。', tags: '数学 示例' },
];
const localAnkiDeck: RemoteAnkiDeck = { id: 'local-default', name: '默认牌组', created_at: '', updated_at: '' };

function NewNoteHome({ entries, onCreate, onOpen }: { entries: Entry[]; onCreate: (title?: string, body?: string) => void; onOpen: (id: string) => void }) {
  const recent = entries.filter(entry => entry.kind === 'note').slice().sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 4);
  const templates = [
    { title: '空白笔记', description: '从一个标题或一句想法开始', icon: FilePlus2, body: '' },
    { title: '项目记录', description: '目标、进展、风险和下一步', icon: Table2, body: '# 项目记录\n\n## 目标\n\n## 当前进展\n\n## 风险与阻塞\n\n## 下一步\n\n- [ ] ' },
    { title: '读书卡片', description: '把摘录和思考沉淀成知识', icon: Quote, body: '# 书名\n\n> 一句重要摘录\n\n## 我的理解\n\n## 关联笔记\n\n- [[' },
    { title: '每日复盘', description: '记录今天发生了什么', icon: CheckSquare, body: `# ${new Date().toLocaleDateString('zh-CN')}\n\n## 完成了什么\n\n- [ ] \n\n## 学到了什么\n\n## 明天要做什么\n\n- [ ] ` },
  ];
  return <section className="new-note-home"><div className="new-note-header"><h1>新建笔记</h1><Button className="new-note-primary" onClick={() => onCreate()}><Plus size={16} /> 空白笔记</Button></div><div className="new-note-grid"><div className="new-note-panel"><div className="new-note-panel-head"><span>从模板开始</span></div><div className="new-note-templates">{templates.slice(1).map(template => { const Icon = template.icon; return <button type="button" key={template.title} onClick={() => onCreate(template.title, template.body)}><span className="new-note-template-icon"><Icon size={17} /></span><span><strong>{template.title}</strong><small>{template.description}</small></span><ArrowRight size={15} /></button>; })}</div></div><div className="new-note-panel new-note-recent"><div className="new-note-panel-head"><span>最近文档</span></div>{recent.length ? recent.map(entry => <button type="button" key={entry.id} onClick={() => onOpen(entry.id)}><FileText size={16} /><span><strong>{entry.title || '未命名笔记'}</strong><small>{new Date(entry.updated_at).toLocaleDateString('zh-CN')}</small></span></button>) : <div className="new-note-empty">暂无最近文档</div>}</div></div></section>;
}

function parseHeadings(markdown: string) {
  return markdown.split('\n').flatMap((line, index) => {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    return match ? [{ id: `heading-${index}`, level: match[1].length, text: match[2] }] : [];
  });
}

function renderMarkdown(markdown: string) {
  const html = marked.parse(markdown, { gfm: true, breaks: true }) as string;
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

function SessionThread({ title, chat, loading, error, draft, sending, onDraftChange, onSubmit, onRetry }: {
  title: string;
  chat: ChatSession | null;
  loading: boolean;
  error: string;
  draft: string;
  sending: boolean;
  onDraftChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onRetry: () => void;
}) {
  const messages = (chat?.messages ?? []).filter(message => message.content);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  useEffect(() => {
    const area = scrollRef.current;
    if (area) area.scrollTop = area.scrollHeight;
  }, [chat?.id, messages.length]);

  return <section className="session-view" aria-label={`${title} 会话`}>
    <div className="chat-messages" ref={scrollRef} role="log" aria-label="会话记录">
      <div className="session-heading"><span className="session-icon"><MousePointer2 size={18} /></span><div><h1>{title}</h1><p>Agent 任务线程</p><div className="session-context-line"><span>当前知识库</span><span>按需读取笔记</span><span>Markdown 回复</span></div></div><button type="button" className="session-heading-action" aria-label="会话选项" title="会话选项"><MoreHorizontal size={17} /></button></div>
      {loading ? <div className="session-feedback"><Loader2 className="animate-spin" size={16} /> 正在加载会话…</div>
        : !chat ? <div className="session-feedback"><p>{error || '暂时无法连接会话。'}</p><button type="button" onClick={onRetry}>重试</button></div>
          : messages.length ? <div className="session-transcript">{messages.map((message, index) => <article key={`${message.created_at}-${index}`} className={`chat-message ${message.role}`}>
            <div className="chat-message-label"><span>{message.role === 'user' ? '你' : 'Agent'}</span><time dateTime={message.created_at}>{new Date(message.created_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>{message.role === 'assistant' ? <button type="button" aria-label="复制回复" title="复制回复" onClick={() => { void navigator.clipboard?.writeText(message.content); setCopiedIndex(index); window.setTimeout(() => setCopiedIndex(current => current === index ? null : current), 1200); }}>{copiedIndex === index ? <Check size={13} /> : <Copy size={13} />}</button> : null}</div>
            {message.role === 'assistant' ? <div className="chat-message-content markdown-preview" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }} /> : <p>{message.content}</p>}
          </article>)}</div> : <div className="session-start"><h2>从一个问题开始</h2><p>向 {title} 描述你正在处理的内容。</p><div className="session-starters">
            {['帮我整理这篇笔记的重点', '解释一个我还没弄懂的概念', '把这篇内容改成复习提纲'].map(prompt => <button type="button" key={prompt} onClick={() => onDraftChange(prompt)}>{prompt}<ArrowRight size={14} /></button>)}
          </div></div>}
    </div>
    <div className="session-composer-dock"><form className="chat-composer" onSubmit={onSubmit}>
      <label htmlFor="session-draft" className="sr-only">发送给 Agent 的消息</label>
      <textarea id="session-draft" value={draft} onChange={event => onDraftChange(event.target.value)} placeholder={chat ? '描述任务，或引用当前笔记中的一段内容…' : '会话尚未就绪'} rows={2} disabled={!chat || sending} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
      <div className="chat-composer-footer"><span className="composer-capabilities"><span><BookOpen size={12} /> 当前笔记</span><span><Sparkles size={12} /> Agent</span>{sending ? '正在处理任务…' : 'Enter 发送 · Shift + Enter 换行'}</span><button type="submit" aria-label="发送" title="发送" disabled={!chat || sending || !draft.trim()}>{sending ? <Loader2 className="animate-spin" size={16} /> : <ArrowUp size={17} />}</button></div>
    </form>{error && chat ? <p className="chat-inline-error" role="alert">{error}</p> : null}</div>
  </section>;
}

export default function Workspace() {
  const [session, setSession] = useState<IdentitySession | null>(null);
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
  const [chatError, setChatError] = useState('');
  const [draft, setDraft] = useState('');
  const [tabs, setTabs] = useState<WorkspaceTab[]>([{ key: 'home', kind: 'blank', title: '新建笔记', history: [], historyIndex: -1 }]);
  const [activeTabKey, setActiveTabKey] = useState<string | null>('home');
  const [query, setQuery] = useState('');
  const [view, setView] = useState<SidebarView>('notes');
  const [sidebarSort, setSidebarSort] = useState<SidebarSort>(defaultSidebarSort);
  const [sidebarOrder, setSidebarOrder] = useState<Record<string, string[]>>({});
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [activePluginId, setActivePluginId] = useState<BuiltInPluginId>('editor');
  const [activeToolId, setActiveToolId] = useState<CampusToolId>('schedule');
  const [ankiCards, setAnkiCards] = useState<AnkiCard[]>([]);
  const [ankiDecks, setAnkiDecks] = useState<RemoteAnkiDeck[]>([]);
  const [ankiDeckId, setAnkiDeckId] = useState<string | null>(null);
  const [ankiOpenCardId, setAnkiOpenCardId] = useState<string | null>(null);
  const [ankiRemoteReady, setAnkiRemoteReady] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => typeof window === 'undefined' || window.innerWidth > 720);
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 720);
  const reduceMotion = useReducedMotion();
  const [railOpen, setRailOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => ACTIVITY_RAIL_WIDTH + defaultContentPaneWidth());
  const [railWidth, setRailWidth] = useState(defaultContentPaneWidth);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('appearance');
  const [graphOpen, setGraphOpen] = useState(false);
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [moveEntryId, setMoveEntryId] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<'edit' | 'preview'>('edit');
  const [commandOpen, setCommandOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [workspaceGate, setWorkspaceGate] = useState<WorkspaceGateState>(null);
  const [error, setError] = useState('');
  const saveTimer = useRef<number>(0);
  const pendingSave = useRef<{ id: string; title: string; body: string; generation: number; version: number } | null>(null);
  const saveVersions = useRef<Record<string, number>>({});
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const draftsRef = useRef<Record<string, string>>({});
  const chatCacheRef = useRef<Record<string, ChatSession>>({});
  const activeTabRef = useRef<string | null>('home');
  const identityRef = useRef<string | null>(null);
  const identityGeneration = useRef(0);
  const bodyRef = useRef<EditorView | null>(null);
  const ankiWorkspaceRef = useRef<AnkiWorkspaceHandle | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const chatRequestRef = useRef(0);
  const sendingRef = useRef(false);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const railRef = useRef<HTMLElement | null>(null);
  const dragSource = useRef<{ id: string; group: string } | null>(null);
  const sortMenuRef = useRef<HTMLDivElement | null>(null);
  const ankiRemoteIds = useRef<Set<string>>(new Set());
  const library = libraries[0];
  const noteCount = entries.filter(entry => entry.kind === 'note').length;
  const fileCount = entries.filter(entry => entry.kind === 'note' || entry.kind === 'file').length;
  const activeTab = tabs.find(tab => tab.key === activeTabKey);
  const ankiDeckName = ankiDecks.find(deck => deck.id === ankiDeckId)?.name ?? '默认牌组';
  const visibleTabs = tabs.filter(tab => view === 'notes' ? tab.kind === 'note' || tab.kind === 'blank'
    : view === 'sessions' ? tab.kind === 'agent' || tab.kind === 'agent-blank'
      : view === 'anki' ? tab.kind === 'anki' : view === 'tools' && tab.kind === 'tool');

  function chooseTab(key: string | null) {
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
      try {
        const entry = await patchEntry(pending.id, { title: pending.title, body: pending.body });
        if (pending.generation !== identityGeneration.current) return;
        if (saveVersions.current[entry.id] === pending.version) {
          setEntries(items => items.map(item => item.id === entry.id ? entry : item));
          setSaving(false);
        }
      } catch {
        if (pending.generation === identityGeneration.current) {
          setSaving(false);
          setError('保存失败，请稍后再试。');
        }
      }
    });
  }

  function newBlankTab() {
    flushPendingSave();
    ++chatRequestRef.current;
    const key = `blank-${crypto.randomUUID()}`;
    const kind = view === 'sessions' ? 'agent-blank' : view === 'anki' ? 'anki' : view === 'tools' ? 'tool' : 'blank';
    const title = kind === 'agent-blank' ? '新会话' : kind === 'anki' ? '记忆闪卡' : kind === 'tool' ? '课程表' : '新建笔记';
    setTabs(current => [...current, { key, kind, title, toolId: kind === 'tool' ? 'schedule' : undefined, history: [], historyIndex: -1 }]);
    chooseTab(key);
    setView(kind === 'agent-blank' ? 'sessions' : kind === 'anki' ? 'anki' : kind === 'tool' ? 'tools' : 'notes');
    if (kind === 'tool') setActiveToolId('schedule');
    setSelected(null); setSelectedId(null); setTitle(''); setBody('');
    setChat(null); setRailOpen(false);
    if (isMobile) setSidebarOpen(false);
  }

  function activateTab(tab: WorkspaceTab, preserveSidebar = false) {
    if (tab.key === activeTabRef.current && (view === 'notes' || view === 'sessions' || view === 'anki' || view === 'tools')) return;
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
    const index = tabs.findIndex(tab => tab.key === key);
    if (index < 0) return;
    const remaining = tabs.filter(tab => tab.key !== key);
    setTabs(remaining);
    if (activeTabRef.current !== key) return;
    flushPendingSave();
    const closed = tabs[index];
    const sameSection = remaining.filter(tab => closed.kind === 'tool' ? tab.kind === 'tool' : closed.kind === 'anki' ? tab.kind === 'anki'
      : closed.kind === 'agent' || closed.kind === 'agent-blank' ? tab.kind === 'agent' || tab.kind === 'agent-blank'
        : tab.kind === 'note' || tab.kind === 'blank');
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

  const visible = useMemo(() => entries.filter(entry => (view === 'notes' ? entry.kind === 'note' : view === 'sessions' && entry.kind === 'agent') && (!query || entry.title.toLowerCase().includes(query.toLowerCase()))), [entries, query, view]);
  const roots = visible.filter(entry => !entry.parent_id && !placements[entry.id]);
  const folderRoots = folders.filter(folder => !folder.parentId);
  const headings = useMemo(() => parseHeadings(body), [body]);

  function siblings(group: string): Sortable[] {
    if (group === 'notes:root' || group.startsWith('notes:folder:')) {
      const parentId = group === 'notes:root' ? null : group.slice('notes:folder:'.length);
      return [
        ...folders.filter(folder => folder.parentId === parentId).map(folder => ({ id: `folder:${folder.id}`, title: folder.name })),
        ...entries.filter(entry => entry.kind === 'note' && (placements[entry.id] ?? null) === parentId && (parentId !== null || !entry.parent_id))
          .map(entry => ({ id: `entry:${entry.id}`, title: entry.title, updated_at: entry.updated_at })),
      ];
    }
    if (group.startsWith('notes:entry:')) return entries.filter(entry => entry.kind === 'note' && entry.parent_id === group.slice('notes:entry:'.length))
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
    if (identityRef.current) localStorage.setItem(`tjuclaw.sidebar.order.v1.${identityRef.current}`, JSON.stringify(next));
  }

  function changeSort(mode: SortMode) {
    const next = { ...sidebarSort, [view]: mode };
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
      void reorderEntries(library.id, parentId, entryIds).catch(() => setError('保存手动排序失败，请稍后再试。'));
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

  function openContextMenu(event: MouseEvent, kind: 'folder' | 'note' | 'editor' | 'sidebar', id?: string, group?: string) {
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
    }
    if (contextMenu.kind === 'note' && contextMenu.id) {
      const id = contextMenu.id.replace(/^entry:/, '');
      if (action === 'open') void openEntry(id);
      if (action === 'outline') { setSidebarOpen(false); setRailOpen(true); }
      if (action === 'delete') void deleteNote(id);
      if (action === 'move') moveEntry(id);
      if (action === 'rename') {
        void openEntry(id);
        window.setTimeout(() => titleRef.current?.focus(), 0);
      }
    }
    if (contextMenu.kind === 'editor' && action === 'copy') void navigator.clipboard?.writeText(body);
    if (contextMenu.kind === 'editor' && action === 'select-all') bodyRef.current?.dispatch({ selection: { anchor: 0, head: body.length } });
  }

  useEffect(() => {
    const close = () => setContextMenu(null);
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', escape); };
  }, []);

  useEffect(() => {
    const close = (event: PointerEvent) => { if (!sortMenuRef.current?.contains(event.target as Node)) setSortMenuOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setSortMenuOpen(false); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', escape); };
  }, []);

  function persistFolders(next: VaultFolder[]) { setFolders(next); }

  function persistPlacements(next: VaultPlacement) { setPlacements(next); }

  async function createFolder(parentId: string | null = null) {
    if (!library) return;
    try {
      const entry = await createFolderRemote(library.id, '未命名', parentId ?? undefined);
      setEntries(items => [...items, entry]);
      persistFolders([...folders, { id: entry.id, name: entry.title, parentId: entry.parent_id || null }]);
      setOpenFolders(value => ({ ...value, ...(parentId ? { [parentId]: true } : {}), [entry.id]: true }));
      setEditingFolderId(entry.id);
    } catch { setError('创建文件夹失败，请稍后再试。'); }
  }

  function renameFolder(folder: VaultFolder) {
    setEditingFolderId(folder.id);
  }

  async function removeFolder(folder: VaultFolder) {
    if (!window.confirm(`删除文件夹“${folder.name}”？其中的文档会移回根目录。`)) return;
    const ids = new Set([folder.id]);
    let changed = true;
    while (changed) {
      changed = false;
      folders.forEach(item => { if (item.parentId && ids.has(item.parentId) && !ids.has(item.id)) { ids.add(item.id); changed = true; } });
    }
    try {
      await deleteFolderRemote(folder.id);
      setEntries(items => items.filter(item => !ids.has(item.id)));
      persistFolders(folders.filter(item => !ids.has(item.id)));
      const next = { ...placements };
      Object.keys(next).forEach(entryId => { if (next[entryId] && ids.has(next[entryId] as string)) delete next[entryId]; });
      persistPlacements(next);
    } catch { setError('删除文件夹失败，请稍后再试。'); }
  }

  async function moveEntry(id: string, folderId?: string | null) {
    if (folderId === undefined) { setMoveEntryId(id); return; }
    try {
      const entry = await moveEntryRemote(id, folderId ?? '');
      setEntries(items => items.map(item => item.id === id ? entry : item));
      persistPlacements({ ...placements, [id]: folderId });
      setMoveEntryId(null);
    } catch { setError('移动文档失败，请稍后再试。'); }
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
    try {
      const entry = await patchFolder(id, { parent_id: parentId ?? '' });
      setEntries(items => items.map(item => item.id === id ? entry : item));
      persistFolders(folders.map(folder => folder.id === id ? { ...folder, parentId } : folder));
    } catch { setError('移动文件夹失败，请稍后再试。'); }
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
          ? <input className="tree-inline-input" autoFocus defaultValue={folder.name} onBlur={event => { const name = event.currentTarget.value.trim() || '未命名'; void patchFolder(folder.id, { title: name }).then(entry => { setEntries(items => items.map(item => item.id === folder.id ? entry : item)); persistFolders(folders.map(item => item.id === folder.id ? { ...item, name } : item)); }).catch(() => setError('重命名文件夹失败，请稍后再试。')); setEditingFolderId(null); }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') setEditingFolderId(null); }} />
          : <button className="tree-item" type="button" onDoubleClick={() => renameFolder(folder)} onClick={() => setOpenFolders(value => ({ ...value, [folder.id]: !open }))}>{open ? <FolderOpen size={15} /> : <Folder size={15} />}<span>{folder.name}</span></button>}
        <button className="tree-more" type="button" onClick={event => openContextMenu(event, 'folder', `folder:${folder.id}`, folder.parentId ? `notes:folder:${folder.parentId}` : 'notes:root')} aria-label="文件夹操作"><MoreHorizontal size={14} /></button>
      </div>
      {open ? <div className="tree-children">{items.map(item => item.id.startsWith('folder:')
        ? renderFolder(children.find(child => child.id === item.id.slice(7))!)
        : <TreeItem key={item.id} entry={folderEntries.find(entry => entry.id === item.id.slice(6))!} entries={visible} group={group} selectedId={selectedId} onSelect={openEntry} onContextMenu={openContextMenu} orderChildren={orderChildren} dragProps={dragProps} />)}</div> : null}
    </div>;
  }

  async function openEntry(id: string, loadedItem?: Entry, targetTabKey?: string, historyIndex?: number, preserveSidebar = false) {
    const listedItem = loadedItem ?? entries.find(entry => entry.id === id);
    if (!listedItem) return;
    let item: Entry = listedItem;
    const generation = identityGeneration.current;
    if (item.kind === 'note' && item.body === undefined) {
      try {
        item = await getEntry(item.id);
      } catch {
        setError('打开笔记失败，请稍后重试。');
        return;
      }
      if (generation !== identityGeneration.current) return;
    }
    flushPendingSave();
    const compatible = (tab: WorkspaceTab) => item.kind === 'agent' ? tab.kind === 'agent' || tab.kind === 'agent-blank' : tab.kind === 'note' || tab.kind === 'blank';
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
        return { key, kind: item.kind === 'agent' ? 'agent' : 'note', title: item.title, entryId: id,
          history: nextHistory, historyIndex: historyIndex ?? (nextHistory === history ? cursor : nextHistory.length - 1) };
      };
      return current.some(tab => tab.key === key) ? current.map(tab => tab.key === key ? update(tab) : tab) : [...current, update()];
    });
    chooseTab(key);
    setSelectedId(id); setSelected(item); setTitle(item.title); setBody(item.body ?? '');
    setView(item.kind === 'agent' ? 'sessions' : 'notes');
    if (!preserveSidebar && window.innerWidth <= 720) setSidebarOpen(false);
    setRailOpen(window.innerWidth > 1050 && item.kind === 'note');
    if (item.kind === 'agent') {
      const request = ++chatRequestRef.current;
      setChat(chatCacheRef.current[id] ?? null); setChatLoading(true); setChatError(''); setDraft(draftsRef.current[id] ?? '');
      try {
        const current = (await listSessions(item.id))[0] ?? await createSession(item.id);
        const next = current.messages ? current : await getSession(current.id);
        if (generation === identityGeneration.current && request === chatRequestRef.current) { chatCacheRef.current[id] = next; setChat(next); }
      } catch { if (generation === identityGeneration.current && request === chatRequestRef.current) setChatError('会话暂时不可用，请稍后再试。'); }
      finally { if (generation === identityGeneration.current && request === chatRequestRef.current) setChatLoading(false); }
    } else { ++chatRequestRef.current; setChat(null); setChatLoading(false); }
  }

  async function loadWorkspaceData(libraryId: string, generation: number) {
    const items = await listEntries(libraryId);
    if (generation !== identityGeneration.current) return;
    setEntries(items);
    const remoteFolders = items.filter(item => item.kind === 'folder').map(item => ({ id: item.id, name: item.title, parentId: item.parent_id || null }));
    setFolders(remoteFolders);
    setPlacements(Object.fromEntries(items.filter(item => item.kind === 'note' && item.parent_id).map(item => [item.id, item.parent_id])));
    try {
      let decks = await listDecks();
      const deck = decks[0] ?? await createDeck('默认牌组');
      if (!decks.length) decks = [deck];
      setAnkiDecks(decks);
      setAnkiDeckId(deck.id);
      setAnkiRemoteReady(true);
      const cards = await listAnkiCards(deck.id);
      ankiRemoteIds.current = new Set(cards.map(card => card.id));
      setAnkiCards(cards.map(card => ({ id: card.id, front: card.front, back: card.back, tags: (card.tags ?? []).join(' ') })));
    } catch {
      setAnkiDecks([localAnkiDeck]);
      setAnkiDeckId(localAnkiDeck.id);
      setAnkiRemoteReady(false);
      setAnkiOpenCardId(null);
      ankiRemoteIds.current = new Set();
      const cachedCards = localData<AnkiCard[]>('tjuclaw.anki.cards.v1', []);
      setAnkiCards(Array.isArray(cachedCards) ? cachedCards : []);
    }
    // A new workspace always contains the guide agent, but opening that agent
    // automatically would switch the user away from the notes home and hide
    // the primary "new note" action. Only restore a real note here; otherwise
    // keep the notes home visible.
    const firstNote = items.find(item => item.kind === 'note');
    if (firstNote) void openEntry(firstNote.id, firstNote);
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
      if (err instanceof AuthError && err.status === 401) location.replace('/auth/login');
      else setError('工作区暂时无法连接，请稍后重试。');
    } finally {
      if (generation === identityGeneration.current) setLoading(false);
    }
  }

  async function load(generation: number) {
    try {
      const libs = await listLibraries();
      if (generation !== identityGeneration.current) return;
      setLibraries(libs);
      const activeLibrary = libs[0];
      if (!activeLibrary) {
        setWorkspaceGate({ workspaceId: null, workspaceName: '', mode: 'setup', firstWorkspace: true });
        return;
      }
      const identity = identityRef.current;
      if (!identity) return;
      const configured = hasWorkspacePassphrase(identity, activeLibrary.id);
      if (!configured || !isWorkspaceUnlocked(identity, activeLibrary.id)) {
        setWorkspaceGate({
          workspaceId: activeLibrary.id,
          workspaceName: activeLibrary.name,
          mode: configured ? 'unlock' : 'setup',
        });
        return;
      }
      setWorkspaceGate(null);
      await loadWorkspaceData(activeLibrary.id, generation);
    } catch (err) {
      if (generation !== identityGeneration.current) return;
      if (err instanceof AuthError && err.status === 401) location.replace('/auth/login');
      else setError('工作区暂时无法连接，请稍后重试。');
    } finally {
      if (generation === identityGeneration.current) setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      void readSession().then(next => {
        if (!active) return;
        if (!next) { location.replace('/auth/login'); return; }
        if (identityRef.current === next.id) return;
        identityRef.current = next.id;
        const generation = ++identityGeneration.current;
        window.clearTimeout(saveTimer.current);
        setSession(next);
        setLibraries([]);
        setEntries([]);
        setAnkiDeckId(null);
        setAnkiDecks([]);
        setAnkiRemoteReady(false);
        ankiRemoteIds.current = new Set();
        setAnkiCards([]);
        setWorkspaceGate(null);
        setActiveToolId('schedule');
        const savedSort = localData<Partial<SidebarSort>>('tjuclaw.sidebar.sort.v1', {});
        setSidebarSort(Object.fromEntries((Object.keys(defaultSidebarSort) as SidebarView[]).map(section =>
          [section, Object.hasOwn(sortLabels, savedSort?.[section] ?? '') ? savedSort[section] : 'manual'])) as SidebarSort);
        const savedOrder = localData<Record<string, string[]>>('tjuclaw.sidebar.order.v1', {});
        setSidebarOrder(savedOrder && typeof savedOrder === 'object' && !Array.isArray(savedOrder) ? savedOrder : {});
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
        pendingSave.current = null;
        saveVersions.current = {};
        setChatLoading(false);
        setChatSending(false);
        sendingRef.current = false;
        setSaving(false);
        setLoading(true);
        void load(generation);
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
    if (!selected || selected.kind !== 'note') return;
    const generation = identityGeneration.current;
    const id = selected.id;
    const version = (saveVersions.current[id] ?? 0) + 1;
    saveVersions.current[id] = version;
    pendingSave.current = { id, title: nextTitle, body: nextBody, generation, version };
    setEntries(items => items.map(item => item.id === id ? { ...item, title: nextTitle, body: nextBody } : item));
    setTabs(current => current.map(tab => tab.entryId === id ? { ...tab, title: nextTitle || '未命名笔记' } : tab));
    window.clearTimeout(saveTimer.current);
    setSaving(true);
    saveTimer.current = window.setTimeout(flushPendingSave, 650);
  }

  function switchView(next: SidebarView) {
    flushPendingSave();
    const matches = (tab: WorkspaceTab) => next === 'notes' ? tab.kind === 'note' || tab.kind === 'blank'
      : next === 'sessions' ? tab.kind === 'agent' || tab.kind === 'agent-blank'
        : next === 'anki' ? tab.kind === 'anki' : next === 'tools' && tab.kind === 'tool';
    const match = tabs.find(tab => tab.key === activeTabRef.current && matches(tab))
      ?? tabs.slice().reverse().find(matches);
    if (match) { activateTab(match, true); return; }
    if (next === 'sessions' || next === 'anki' || next === 'tools') {
      const key = `blank-${crypto.randomUUID()}`;
      const tab: WorkspaceTab = { key, kind: next === 'anki' ? 'anki' : next === 'tools' ? 'tool' : 'agent-blank', title: next === 'anki' ? '记忆闪卡' : next === 'tools' ? campusToolList.find(tool => tool.id === activeToolId)!.name : '新会话', toolId: next === 'tools' ? activeToolId : undefined, history: [], historyIndex: -1 };
      setTabs(current => [...current, tab]);
      chooseTab(key);
    } else chooseTab(null);
    ++chatRequestRef.current;
    setView(next);
    if (next !== 'notes') setRailOpen(false);
    setSelected(null); setSelectedId(null);
  }

  async function createNote(noteTitle = '未命名笔记', initialBody = '', folderId?: string) {
    if (!library) return;
    const generation = identityGeneration.current;
    try {
      const entry = await createEntry(library.id, { kind: 'note', title: noteTitle, body: initialBody, ...(folderId ? { parent_id: folderId } : {}) });
      if (generation !== identityGeneration.current) return;
      setEntries(items => [...items, entry]);
      if (folderId) persistPlacements({ ...placements, [entry.id]: folderId });
      void openEntry(entry.id, entry);
      window.setTimeout(() => titleRef.current?.focus(), 0);
    } catch { if (generation === identityGeneration.current) setError('暂时无法创建笔记。'); }
  }

  async function deleteNote(id: string) {
    const item = entries.find(entry => entry.id === id);
    if (!item || !window.confirm(`删除“${item.title || '未命名笔记'}”？`)) return;
    try {
      await deleteEntry(id);
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
        return nextEntry ? { ...tab, history, historyIndex, entryId: nextId, title: nextEntry.title, kind: nextEntry.kind === 'agent' ? 'agent' as const : 'note' as const }
          : { ...tab, history: [], historyIndex: -1, entryId: undefined, title: '新建笔记', kind: 'blank' as const };
      });
      setTabs(nextTabs);
      if (selectedId === id) {
        const current = nextTabs.find(tab => tab.key === activeTabRef.current);
        if (current?.entryId) void openEntry(current.entryId, undefined, current.key, current.historyIndex);
        else { setSelected(null); setSelectedId(null); setTitle(''); setBody(''); setRailOpen(false); setView('notes'); }
      }
    } catch { setError('删除文档失败，请稍后再试。'); }
  }

  async function handleChat(event: FormEvent) {
    event.preventDefault();
    if (!chat || !draft.trim() || sendingRef.current) return;
    const text = draft.trim();
    const currentId = chat.id;
    const entryId = selectedId;
    const request = chatRequestRef.current;
    const generation = identityGeneration.current;
    sendingRef.current = true;
    setChatSending(true);
    setChatError('');
    try {
      const next = await sendMessage(currentId, text);
      if (generation === identityGeneration.current && request === chatRequestRef.current) {
        if (entryId) { chatCacheRef.current[entryId] = next; draftsRef.current[entryId] = ''; }
        setChat(next);
        setDraft('');
      }
    } catch {
      if (generation === identityGeneration.current && request === chatRequestRef.current) setChatError('发送失败，草稿已保留，请重试。');
    } finally {
      sendingRef.current = false;
      if (generation === identityGeneration.current) setChatSending(false);
    }
  }

  function saveLocalAnkiCards(cards: AnkiCard[]) {
    setAnkiRemoteReady(false);
    setAnkiDecks([localAnkiDeck]);
    setAnkiDeckId(localAnkiDeck.id);
    ankiRemoteIds.current = new Set();
    setAnkiCards(cards);
    if (identityRef.current) localStorage.setItem(`tjuclaw.anki.cards.v1.${identityRef.current}`, JSON.stringify(cards));
  }

  function saveAnkiCards(cards: AnkiCard[]) {
    setAnkiCards(cards);
    if (!ankiRemoteReady || !ankiDeckId) {
      if (identityRef.current) localStorage.setItem(`tjuclaw.anki.cards.v1.${identityRef.current}`, JSON.stringify(cards));
      return;
    }
    const nextIds = new Set(cards.map(card => card.id));
    for (const oldId of ankiRemoteIds.current) {
      if (!nextIds.has(oldId)) void deleteAnkiCard(oldId).catch(() => setError('删除闪卡失败，请稍后再试。'));
    }
    for (const card of cards) {
      if (ankiRemoteIds.current.has(card.id)) {
        void patchAnkiCard(card.id, { front: card.front, back: card.back, tags: card.tags.split(/\s+/).filter(Boolean) }).catch(() => setError('保存闪卡失败，请稍后再试。'));
      }
    }
    ankiRemoteIds.current = nextIds;
  }

  async function addAnkiCard() {
    if (!ankiDeckId) return;
    if (!ankiRemoteReady) {
      const card = { id: crypto.randomUUID(), front: '', back: '', tags: '' };
      setAnkiCards(cards => [...cards, card]);
      window.setTimeout(() => ankiWorkspaceRef.current?.openCard(card.id), 0);
      return;
    }
    try {
      const card = await createAnkiCard(ankiDeckId, { front: '', back: '', tags: [] });
      ankiRemoteIds.current.add(card.id);
      setAnkiCards(cards => [...cards, { id: card.id, front: card.front, back: card.back, tags: '' }]);
      window.setTimeout(() => ankiWorkspaceRef.current?.openCard(card.id), 0);
    } catch {
      const card = { id: crypto.randomUUID(), front: '', back: '', tags: '' };
      saveLocalAnkiCards([...ankiCards, card]);
      window.setTimeout(() => ankiWorkspaceRef.current?.openCard(card.id), 0);
    }
  }

  async function selectAnkiDeck(deck: RemoteAnkiDeck) {
    if (deck.id === ankiDeckId) {
      ankiWorkspaceRef.current?.startStudy();
      return;
    }
    try {
      const cards = await listAnkiCards(deck.id);
      setAnkiDeckId(deck.id);
      ankiRemoteIds.current = new Set(cards.map(card => card.id));
      setAnkiCards(cards.map(card => ({ id: card.id, front: card.front, back: card.back, tags: (card.tags ?? []).join(' ') })));
      window.setTimeout(() => ankiWorkspaceRef.current?.startStudy(), 0);
    } catch {
      setError('暂时无法打开这个牌组，请稍后重试。');
    }
  }

  function openAnkiCard(id: string) {
    setAnkiOpenCardId(id);
    if (window.innerWidth <= 720) setSidebarOpen(false);
  }

  async function addSampleCards() {
    if (!ankiDeckId) return;
    if (!ankiRemoteReady) {
      saveAnkiCards(sampleCards.map(card => ({ ...card, id: crypto.randomUUID() })));
      return;
    }
    try {
      const cards = await Promise.all(sampleCards.map(card => createAnkiCard(ankiDeckId, { ...card, tags: card.tags.split(/\s+/) })));
      cards.forEach(card => ankiRemoteIds.current.add(card.id));
      setAnkiCards(current => [...current, ...cards.map(card => ({ id: card.id, front: card.front, back: card.back, tags: (card.tags ?? []).join(' ') }))]);
    } catch {
      saveLocalAnkiCards([...ankiCards, ...sampleCards.map(card => ({ ...card, id: crypto.randomUUID() }))]);
    }
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

  function logoutWorkspace() {
    if (session && library) clearWorkspaceUnlock(session.id, library.id);
    void logout();
  }

  function jumpToHeading(text: string) {
    const offset = body.indexOf(text);
    if (offset < 0 || !bodyRef.current) return;
    bodyRef.current.focus();
    bodyRef.current.dispatch({ selection: { anchor: offset, head: offset + text.length } });
  }

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

  if (loading || !session) return <div className="workspace-loading"><Loader2 className="animate-spin" size={18} /> 正在打开你的知识花园…</div>;
  if (workspaceGate) return <WorkspacePassphraseGate identity={session.id} workspaceId={workspaceGate.workspaceId} workspaceName={workspaceGate.workspaceName} mode={workspaceGate.mode} firstWorkspace={workspaceGate.firstWorkspace} onUnlocked={continueAfterWorkspaceUnlock} />;

  return <div className={`obsidian-app${sidebarOpen ? '' : ' sidebar-collapsed'}${railOpen ? '' : ' rail-collapsed'}`} style={{ gridTemplateColumns: `${sidebarOpen ? sidebarWidth : 0}px minmax(0, 1fr) ${railOpen ? railWidth : 0}px` }}>
    <motion.aside ref={sidebarRef} className="obsidian-sidebar" aria-hidden={!sidebarOpen} inert={!sidebarOpen}
      initial={false} animate={{ x: isMobile && !sidebarOpen ? '-100%' : '0%', opacity: isMobile && !sidebarOpen ? 0 : 1 }}
      transition={{ duration: reduceMotion ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] }}>
      <div className="sidebar-activity" aria-label="工作区导航"><div className="activity-main">{([
        { id: 'notes', label: '资料夹', Icon: LibraryBig },
        { id: 'sessions', label: 'Agent', Icon: MousePointer2 },
        { id: 'anki', label: '记忆闪卡', Icon: Brain },
        { id: 'plugins', label: '插件', Icon: Blocks },
        { id: 'tools', label: '小工具', Icon: Wrench },
      ] as const).map(({ id, label, Icon }) => <motion.button key={id} className={view === id ? 'is-active' : ''} type="button" title={label} aria-label={label} aria-current={view === id ? 'page' : undefined} whileTap={reduceMotion ? undefined : { scale: 0.94 }} onClick={() => switchView(id)}>{view === id ? <motion.span className="activity-current-mark" layoutId="workspace-active-view" transition={{ duration: reduceMotion ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }} /> : null}<Icon size={19} /><span>{label}</span></motion.button>)}</div><motion.button className="activity-settings" type="button" title="知识图谱" aria-label="知识图谱" whileTap={reduceMotion ? undefined : { scale: 0.94 }} onClick={() => setGraphOpen(true)}><Network size={19} /><span>图谱</span></motion.button></div>
      <div className="sidebar-pane">
      <div className="sidebar-pane-header"><span>{view === 'notes' ? '资料夹' : view === 'sessions' ? 'Agent' : view === 'anki' ? '记忆闪卡' : view === 'tools' ? '小工具' : '插件'}</span><button type="button" title="收起侧栏" aria-label="收起侧栏" onClick={() => setSidebarOpen(false)}><PanelLeft size={16} /></button></div>
      {view !== 'plugins' && view !== 'tools' ? <label className="obsidian-search"><Search size={15} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索笔记..." /></label> : null}
      <div className="tree-heading"><span>{view === 'notes' ? '笔记库' : view === 'sessions' ? 'Agent' : view === 'anki' ? '记忆卡片' : view === 'tools' ? '校园与专注' : '内置能力'}</span>
        <div className="tree-heading-actions">
          {view === 'notes' ? <><button type="button" onClick={() => void createNote()} aria-label="新建笔记"><Plus size={15} /></button><button type="button" onClick={() => createFolder()} aria-label="新建文件夹"><FolderPlus size={15} /></button></> : null}
          {view === 'anki' ? <button type="button" onClick={() => void addAnkiCard()} aria-label="新建卡片"><Plus size={15} /></button> : null}
          <div className="sidebar-sort-anchor" ref={sortMenuRef}>
            <button type="button" aria-label="侧栏排序" aria-expanded={sortMenuOpen} title={`排序：${sortLabels[sidebarSort[view]]}`} onClick={() => setSortMenuOpen(open => !open)}><ListTree size={15} /></button>
            {sortMenuOpen ? <div className="sidebar-sort-menu" role="menu" aria-label="侧栏排序方式">
              {(view === 'notes' || view === 'sessions' ? Object.keys(sortLabels) : ['manual', 'name-asc', 'name-desc']).map(mode => <button type="button" role="menuitemradio" aria-checked={sidebarSort[view] === mode} key={mode} onClick={() => changeSort(mode as SortMode)}><span>{sortLabels[mode as SortMode]}</span>{sidebarSort[view] === mode ? <Check size={14} /> : null}</button>)}
              <small>拖动或在项目操作中上移/下移，可改为手动排序</small>
            </div> : null}
          </div>
        </div>
      </div>
      <nav className="obsidian-tree">
        {view === 'tools' ? <div className="campus-sidebar-list">{toolRows}</div> : view === 'plugins' ? <>
          {orderedItems(siblings('plugins'), sidebarSort.plugins, sidebarOrder.plugins).map(item => { const plugin = builtInPlugins.find(candidate => `plugin:${candidate.id}` === item.id)!; const Icon = plugin.Icon; return sidebarRow(item.id, 'plugins', plugin.name, <Icon size={15} />, () => { setActivePluginId(plugin.id); if (isMobile) setSidebarOpen(false); }, activePluginId === plugin.id); })}
          <p className="plugin-sidebar-note">第三方插件尚未开放</p>
        </> : view === 'anki' ? <div className="anki-sidebar-list">
          {ankiDecks.map(deck => <button key={deck.id} type="button" className={`anki-sidebar-deck${ankiDeckId === deck.id ? ' is-active' : ''}`} onClick={() => void selectAnkiDeck(deck)}><Brain size={16} /><span><strong>{deck.name}</strong><small>{ankiDeckId === deck.id ? `${ankiCards.length} 张卡片` : '牌组'}</small></span><ArrowRight size={14} /></button>)}
          {ankiDeckId ? orderedItems(siblings('anki'), sidebarSort.anki, sidebarOrder.anki).map((item, index) => { const card = ankiCards.find(candidate => `card:${candidate.id}` === item.id)!; return sidebarRow(item.id, 'anki', card.front || `新卡片 ${index + 1}`, <Brain size={15} />, () => openAnkiCard(card.id), false, 'anki-card'); }) : null}
        </div> : view === 'notes' ? <>
          {orderedItems([
            ...folderRoots.map(folder => ({ id: `folder:${folder.id}`, title: folder.name })),
            ...roots.map(entry => ({ id: `entry:${entry.id}`, title: entry.title, updated_at: entry.updated_at })),
          ], sidebarSort.notes, sidebarOrder['notes:root']).map(rootItem)}
        </> : orderedItems(roots.map(entry => ({ id: `entry:${entry.id}`, title: entry.title, updated_at: entry.updated_at })), sidebarSort.sessions, sidebarOrder.sessions).map(item => {
          const entry = roots.find(candidate => `entry:${candidate.id}` === item.id)!;
          return <div key={item.id} className={`sidebar-sort-row${selectedId === entry.id ? ' is-active' : ''}`} {...dragProps(item.id, 'sessions')} onContextMenu={event => openContextMenu(event, 'sidebar', item.id, 'sessions')}>
            <button className="session-tree-item" type="button" onClick={() => void openEntry(entry.id)}><MousePointer2 size={15} /><span>{entry.title}</span></button>
            <button className="tree-more" type="button" aria-label="排序操作" onClick={event => openContextMenu(event, 'sidebar', item.id, 'sessions')}><MoreHorizontal size={14} /></button>
          </div>;
        })}
      </nav>
      <div className="sidebar-bottom" aria-label="工作区工具"><button type="button" className="sidebar-library-button" title={library?.name ?? '我的知识库'} aria-label={`${library?.name ?? '我的知识库'}，${fileCount} 个文件，${folders.length} 个文件夹`} onClick={() => { setSettingsSection('library'); setSettingsOpen(true); }}><span className="sidebar-library-copy"><strong className="sidebar-library-name">{library?.name ?? '我的知识库'}</strong><small>{fileCount} 个文件 · {folders.length} 个文件夹</small></span><ChevronDown className="sidebar-library-chevron" size={15} /></button><button type="button" title="设置" aria-label="设置" onClick={() => { setSettingsSection('appearance'); setSettingsOpen(true); }}><Settings size={17} /></button></div>
      </div>
    </motion.aside>
    <AnimatePresence initial={false}>{isMobile && sidebarOpen ? <motion.button type="button" className="mobile-sidebar-backdrop" aria-label="收起侧栏" onClick={() => setSidebarOpen(false)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduceMotion ? 0 : 0.18 }} /> : null}</AnimatePresence>
    <div className="panel-resizer panel-resizer-sidebar" style={{ left: sidebarOpen ? sidebarWidth : 0 }} role="separator" aria-label="调整左侧面板宽度" onPointerDown={event => startResize('sidebar', event)} />
    <main className="obsidian-main" inert={(sidebarOpen || railOpen) && window.innerWidth <= 720}>
      <header className="obsidian-topbar"><Button variant="ghost" size="icon" className="sidebar-opener" onClick={() => setSidebarOpen(value => !value)} aria-label={sidebarOpen ? '收起侧栏' : '打开侧栏'}><PanelLeft size={18} /></Button><div className="workspace-tabs" role="tablist" aria-label="打开的标签页">{visibleTabs.map(tab => <div key={tab.key} className={`workspace-tab${activeTabKey === tab.key ? ' is-active' : ''}`} role="presentation"><button type="button" role="tab" aria-selected={activeTabKey === tab.key} aria-label={`${tab.kind === 'agent' || tab.kind === 'agent-blank' ? '会话' : tab.kind === 'anki' ? '闪卡' : tab.kind === 'tool' ? '小工具' : '笔记'} ${tab.title || '未命名笔记'}`} onClick={() => activateTab(tab)}><span>{tab.title || '未命名笔记'}</span></button><button type="button" className="workspace-tab-close" aria-label={`关闭标签 ${tab.title || '未命名笔记'}`} title="关闭标签" onClick={() => closeTab(tab.key)}><X size={14} /></button></div>)}</div><button type="button" className="workspace-new-tab" aria-label="新建标签页" title="新建标签页" onClick={newBlankTab}><Plus size={18} /></button><div className="topbar-actions"><Button variant="ghost" size="icon" onClick={() => setCommandOpen(true)} aria-label="快速切换" title="快速切换"><Search size={17} /></Button><Button variant="ghost" size="icon" onClick={() => setRailOpen(value => !value)} aria-label="切换信息栏" title="切换信息栏"><PanelLeft size={17} /></Button></div><div className="mobile-topbar-actions">{selected?.kind === 'note' && view === 'notes' ? <button type="button" onClick={() => setEditorMode(value => value === 'edit' ? 'preview' : 'edit')} aria-label={editorMode === 'edit' ? '阅读模式' : '编辑模式'}>{editorMode === 'edit' ? <BookOpen size={18} /> : <Pencil size={18} />}</button> : null}<button type="button" onClick={event => { event.stopPropagation(); if (selected?.kind === 'note' && view === 'notes') setContextMenu({ x: 0, y: 0, kind: 'note', id: selected.id }); else setCommandOpen(true); }} aria-label="更多操作"><MoreHorizontal size={19} /></button></div></header>
      {error ? <div className="workspace-error">{error}<button type="button" onClick={() => setError('')}><X size={14} /></button></div> : null}
      {view === 'tools' ? <CampusTools key={session.id} identity={session.id} activeId={activeToolId} /> : view === 'sessions' && selected?.kind === 'agent' ? <SessionThread title={selected.title} chat={chat} loading={chatLoading} error={chatError} draft={draft} sending={chatSending} onDraftChange={changeDraft} onSubmit={handleChat} onRetry={() => void openEntry(selected.id)} /> : view === 'plugins' ? <WorkspacePlugins activeId={activePluginId} onOpen={id => {
        if (id === 'graph') { setGraphOpen(true); return; }
        switchView(id === 'flashcards' ? 'anki' : 'notes');
      }} /> : view === 'anki' ? <AnkiWorkspace ref={ankiWorkspaceRef} cards={ankiCards} identity={session.id} deckName={ankiDeckName} onCardsChange={saveAnkiCards} onExport={() => void exportAnki()} onAddSampleCards={addSampleCards} openCardId={ankiOpenCardId} onOpenCardHandled={() => setAnkiOpenCardId(null)} /> : view === 'sessions' ? <section className="workspace-blank"><MousePointer2 size={25} /><p>从左侧选择 Agent</p></section> : !selected ? <NewNoteHome entries={entries} onCreate={(noteTitle, initialBody) => void createNote(noteTitle, initialBody)} onOpen={id => void openEntry(id)} /> : <article className="note-editor" onContextMenu={event => openContextMenu(event, 'editor')}><div className="note-toolbar"><div className="note-history"><button type="button" onClick={() => moveTabHistory(-1)} disabled={!activeTab || activeTab.historyIndex <= 0} aria-label="上一个笔记" title="上一个笔记"><ArrowLeft size={17} /></button><button type="button" onClick={() => moveTabHistory(1)} disabled={!activeTab || activeTab.historyIndex >= activeTab.history.length - 1} aria-label="下一个笔记" title="下一个笔记"><ArrowRight size={17} /></button></div><div className="mode-switch"><button type="button" className={editorMode === 'edit' ? 'is-active' : ''} onClick={() => setEditorMode('edit')} aria-label="编辑模式" title="编辑模式"><Pencil size={16} /></button><button type="button" className={editorMode === 'preview' ? 'is-active' : ''} onClick={() => setEditorMode('preview')} aria-label="阅读模式" title="阅读模式"><Eye size={16} /></button></div></div><input ref={titleRef} className="note-title" aria-label="标题" value={title} onChange={event => { setTitle(event.target.value); queueSave(event.target.value, body); }} placeholder="未命名笔记" />{editorMode === 'preview' ? <div className="markdown-preview" dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }} /> : <MarkdownEditor key={selected.id} value={body} onChange={nextBody => { setBody(nextBody); queueSave(title, nextBody); }} editorRef={bodyRef} />}</article>}
      <nav className="mobile-command-bar" aria-label="快捷操作"><button type="button" onClick={() => { switchView('notes'); setSidebarOpen(true); }} aria-label="打开资料夹"><LibraryBig size={19} /></button><button type="button" onClick={() => setCommandOpen(true)} aria-label="搜索和快速切换"><Search size={19} /></button><button type="button" onClick={() => void createNote()} aria-label="新建笔记"><Plus size={22} /></button><button type="button" onClick={() => { setSidebarOpen(true); switchView('sessions'); }} aria-label="打开 Agent"><MousePointer2 size={19} /></button><button type="button" onClick={() => { setSidebarOpen(true); switchView('anki'); }} aria-label="打开记忆闪卡"><Brain size={19} /></button><button type="button" onClick={() => { setSidebarOpen(true); switchView('tools'); }} aria-label="打开小工具"><Wrench size={19} /></button></nav>
      <footer className="workspace-statusbar"><span>{library?.name ?? '我的知识库'}</span><span className="statusbar-details">{saving ? '保存中…' : '已保存'}{selected?.kind === 'note' ? ` · ${body.length} 字符` : ''}</span></footer>
    </main>
    {contextMenu ? <><button className="mobile-context-backdrop" type="button" aria-label="关闭操作菜单" onClick={() => setContextMenu(null)} /><WorkspaceContextMenu menu={contextMenu} onClose={() => setContextMenu(null)} onAction={handleContextAction} /></> : null}
    <div className="panel-resizer panel-resizer-rail" style={{ right: railOpen ? railWidth : 0 }} role="separator" aria-label="调整右侧面板宽度" onPointerDown={event => startResize('rail', event)} />
    <AnimatePresence initial={false}>{isMobile && railOpen ? <motion.button type="button" className="mobile-rail-backdrop" aria-label="关闭大纲" onClick={() => setRailOpen(false)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduceMotion ? 0 : 0.18 }} /> : null}</AnimatePresence>
    <motion.aside ref={railRef} className="obsidian-rail" aria-hidden={!railOpen} inert={!railOpen}
      initial={false} animate={{ x: isMobile && !railOpen ? '100%' : '0%', opacity: isMobile && !railOpen ? 0 : 1 }}
      transition={{ duration: reduceMotion ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] }}><div className="rail-heading"><span>{view === 'anki' ? '记忆闪卡' : '大纲'}</span><Button variant="ghost" size="icon" onClick={() => setRailOpen(false)} aria-label="关闭信息栏"><X size={15} /></Button></div>{view === 'anki' ? <div className="rail-tip"><BookOpen size={15} /> 导出为 TSV 后可在 Anki 中导入。</div> : <div className="rail-section">{selected?.kind === 'note' && headings.length ? headings.map(item => <button key={item.id} className={`outline-item level-${item.level}`} type="button" onClick={() => { jumpToHeading(item.text); if (window.innerWidth <= 720) setRailOpen(false); }}>{item.text}</button>) : <p className="outline-muted">当前笔记没有标题</p>}</div>}</motion.aside>
    <WorkspaceSettings open={settingsOpen} onOpenChange={setSettingsOpen} section={settingsSection} onSectionChange={setSettingsSection} libraryName={library?.name ?? '我的知识库'} fileCount={fileCount} noteCount={noteCount} folderCount={folders.length} cardCount={ankiCards.length} email={session.email} editorMode={editorMode} onEditorModeChange={setEditorMode} onShowNotes={() => { setView('notes'); setSettingsOpen(false); setSidebarOpen(true); }} onShowCards={() => { setView('anki'); setSettingsOpen(false); setSidebarOpen(true); }} onExportCards={exportAnki} onLogout={logoutWorkspace} />
    <KnowledgeGraph open={graphOpen} onOpenChange={setGraphOpen} entries={entries} onOpenNote={id => { void openEntry(id); setGraphOpen(false); }} />
    <Dialog open={moveEntryId !== null} onOpenChange={open => { if (!open) setMoveEntryId(null); }}><DialogContent className="workspace-move-dialog"><DialogTitle>移动到</DialogTitle><DialogDescription>选择文档所在的文件夹</DialogDescription><div className="workspace-folder-picker"><button type="button" onClick={() => moveEntryId && moveEntry(moveEntryId, null)}><Folder size={17} /> 知识库根目录 <MoveRight size={15} /></button>{folders.map(folder => <button key={folder.id} type="button" onClick={() => moveEntryId && moveEntry(moveEntryId, folder.id)} style={{ paddingLeft: 16 + folders.filter(parent => parent.id === folder.parentId).length * 16 }}><Folder size={17} /> {folder.name} <MoveRight size={15} /></button>)}</div></DialogContent></Dialog>
    <Dialog open={commandOpen} onOpenChange={setCommandOpen}><DialogContent className="command-dialog"><DialogTitle>快速切换</DialogTitle><DialogDescription>跳转到笔记、Agent 或工具。</DialogDescription><div className="command-list">{entries.filter(item => item.title.toLowerCase().includes(query.toLowerCase())).slice(0, 12).map(item => <button key={item.id} type="button" onClick={() => { setView(item.kind === 'agent' ? 'sessions' : 'notes'); void openEntry(item.id); setCommandOpen(false); }}><Link2 size={15} /><span>{item.title}</span><small>{item.kind === 'agent' ? 'Agent' : '笔记'}</small></button>)}<button type="button" onClick={() => { setView('anki'); setCommandOpen(false); }}><Brain size={15} /><span>打开记忆闪卡</span><small>工具</small></button></div></DialogContent></Dialog>
  </div>;
}
