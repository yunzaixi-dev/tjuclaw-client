import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { ArrowRight, Blocks, BookOpen, Brain, CheckSquare, ChevronDown, ChevronRight, Copy, Download, FileText, FilePlus2, Folder, FolderInput, FolderOpen, FolderPlus, LibraryBig, ListTree, Loader2, MousePointer2, Network, PanelLeft, Plus, Search, Send, Settings, Trash2, X, Eye, Pencil, Link2, MoreHorizontal, Quote, Table2, MoveRight } from 'lucide-react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { EditorView } from '@codemirror/view';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Button } from './components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './components/ui/dialog';
import { MarkdownEditor } from './components/markdown-editor';
import { KnowledgeGraph } from './components/knowledge-graph';
import { WorkspaceSettings, type SettingsSection } from './components/workspace-settings';
import { builtInPlugins, WorkspacePlugins, type BuiltInPluginId } from './components/workspace-plugins';
import { AuthError, logout, readSession, type IdentitySession } from './lib/auth';
import { createEntry, createSession, deleteEntry, getSession, listEntries, listLibraries, listSessions, patchEntry, sendMessage, type ChatSession, type Entry, type Library } from './lib/library';
import './product.css';
import './workspace.css';
import './obsidian-shell.css';

type VaultFolder = { id: string; name: string; parentId: string | null };
type VaultPlacement = Record<string, string | null>;
type ContextMenuState = { x: number; y: number; kind: 'folder' | 'note' | 'editor'; id?: string } | null;

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
  };
  const items = menu.kind === 'folder'
    ? [['new-note', '新建笔记'], ['new-folder', '新建文件夹'], ['divider', ''], ['rename', '重命名'], ['delete', '删除']]
    : menu.kind === 'note'
      ? [['open', '打开'], ['outline', '大纲'], ['move', '移动到…'], ['divider', ''], ['rename', '重命名'], ['delete', '删除']]
      : [['copy', '复制 Markdown'], ['select-all', '全选']];
  return <div className="workspace-context-menu" style={{ left: menu.x, top: menu.y }} role="menu" aria-label="文档操作" onContextMenu={event => event.preventDefault()}>
    {items.map(([action, label], index) => action === 'divider'
      ? <div className="workspace-context-divider" key={`divider-${index}`} />
      : <button key={action} type="button" className={action === 'delete' ? 'is-danger' : ''} role="menuitem" onClick={() => { onAction(action); onClose(); }}>{icons[action]}<span>{label}</span></button>)}
  </div>;
}

function TreeItem({ entry, entries, selectedId, onSelect, onContextMenu }: { entry: Entry; entries: Entry[]; selectedId: string | null; onSelect: (id: string) => void; onContextMenu: (event: MouseEvent, kind: 'note', id: string) => void }) {
  const [open, setOpen] = useState(true);
  const children = entries.filter(item => item.parent_id === entry.id && item.kind === 'note');
  return <div className="obsidian-tree-node">
    <div className={`obsidian-tree-row${selectedId === entry.id ? ' is-active' : ''}`} draggable onDragStart={event => event.dataTransfer.setData('text/plain', `entry:${entry.id}`)} onContextMenu={event => onContextMenu(event, 'note', entry.id)}>
      {children.length ? <button className="tree-toggle" type="button" onClick={() => setOpen(value => !value)} aria-label="展开或折叠"><ChevronRight size={13} data-open={open ? 'true' : 'false'} /></button> : <span className="tree-spacer" />}
      <button className="tree-item" type="button" onClick={() => onSelect(entry.id)}><FileText size={15} /><span>{entry.title || '未命名笔记'}</span></button><button className="tree-more" type="button" onClick={event => onContextMenu(event, 'note', entry.id)} aria-label="文档操作"><MoreHorizontal size={14} /></button>
    </div>
    {open && children.length ? <div className="tree-children">{children.map(child => <TreeItem key={child.id} entry={child} entries={entries} selectedId={selectedId} onSelect={onSelect} onContextMenu={onContextMenu} />)}</div> : null}
  </div>;
}

type AnkiCard = { id: string; front: string; back: string; tags: string };

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
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'notes' | 'sessions' | 'anki' | 'plugins'>('notes');
  const [activePluginId, setActivePluginId] = useState<BuiltInPluginId>('editor');
  const [ankiCards, setAnkiCards] = useState<AnkiCard[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(() => typeof window === 'undefined' || window.innerWidth > 720);
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 720);
  const reduceMotion = useReducedMotion();
  const [railOpen, setRailOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(270);
  const [railWidth, setRailWidth] = useState(260);
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
  const [error, setError] = useState('');
  const saveTimer = useRef<number>(0);
  const identityRef = useRef<string | null>(null);
  const identityGeneration = useRef(0);
  const bodyRef = useRef<EditorView | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const railRef = useRef<HTMLElement | null>(null);
  const library = libraries[0];
  const noteCount = entries.filter(entry => entry.kind === 'note').length;
  const fileCount = entries.filter(entry => entry.kind === 'note' || entry.kind === 'file').length;

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

  function openContextMenu(event: MouseEvent, kind: 'folder' | 'note' | 'editor', id?: string) {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: Math.min(event.clientX, window.innerWidth - 250), y: Math.min(event.clientY, window.innerHeight - 360), kind, id });
  }

  function handleContextAction(action: string) {
    if (!contextMenu) return;
    if (contextMenu.kind === 'folder' && contextMenu.id) {
      const folder = folders.find(item => item.id === contextMenu.id);
      if (!folder) return;
      if (action === 'new-folder') createFolder(folder.id);
      if (action === 'rename') renameFolder(folder);
      if (action === 'delete') removeFolder(folder);
      if (action === 'new-note') void createNote('未命名笔记', '', folder.id);
    }
    if (contextMenu.kind === 'note' && contextMenu.id) {
      if (action === 'open') void openEntry(contextMenu.id);
      if (action === 'outline') { setSidebarOpen(false); setRailOpen(true); }
      if (action === 'delete') void deleteNote(contextMenu.id);
      if (action === 'move') moveEntry(contextMenu.id);
      if (action === 'rename') {
        void openEntry(contextMenu.id);
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

  function persistFolders(next: VaultFolder[]) {
    setFolders(next);
    if (identityRef.current) localStorage.setItem(`tjuclaw.vault.folders.v1.${identityRef.current}`, JSON.stringify(next));
  }

  function persistPlacements(next: VaultPlacement) {
    setPlacements(next);
    if (identityRef.current) localStorage.setItem(`tjuclaw.vault.placements.v1.${identityRef.current}`, JSON.stringify(next));
  }

  function createFolder(parentId: string | null = null) {
    const id = `folder-${crypto.randomUUID()}`;
    persistFolders([...folders, { id, name: '未命名', parentId }]);
    setOpenFolders(value => ({ ...value, ...(parentId ? { [parentId]: true } : {}), [id]: true }));
    setEditingFolderId(id);
  }

  function renameFolder(folder: VaultFolder) {
    setEditingFolderId(folder.id);
  }

  function removeFolder(folder: VaultFolder) {
    if (!window.confirm(`删除文件夹“${folder.name}”？其中的文档会移回根目录。`)) return;
    const ids = new Set([folder.id]);
    let changed = true;
    while (changed) {
      changed = false;
      folders.forEach(item => { if (item.parentId && ids.has(item.parentId) && !ids.has(item.id)) { ids.add(item.id); changed = true; } });
    }
    persistFolders(folders.filter(item => !ids.has(item.id)));
    const next = { ...placements };
    Object.keys(next).forEach(entryId => { if (next[entryId] && ids.has(next[entryId] as string)) next[entryId] = null; });
    persistPlacements(next);
  }

  function moveEntry(id: string, folderId?: string | null) {
    if (folderId === undefined) { setMoveEntryId(id); return; }
    persistPlacements({ ...placements, [id]: folderId });
    setMoveEntryId(null);
  }

  function moveFolder(id: string, parentId: string | null) {
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
    persistFolders(folders.map(folder => folder.id === id ? { ...folder, parentId } : folder));
  }

  function renderFolder(folder: VaultFolder): ReactNode {
    const children = folders.filter(item => item.parentId === folder.id);
    const folderEntries = visible.filter(entry => (placements[entry.id] ?? null) === folder.id);
    const open = openFolders[folder.id] ?? true;
    return <div className="obsidian-tree-node" key={folder.id}><div className="obsidian-tree-row" draggable onContextMenu={event => openContextMenu(event, 'folder', folder.id)} onDragStart={event => event.dataTransfer.setData('text/plain', `folder:${folder.id}`)} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const [kind, id] = event.dataTransfer.getData('text/plain').split(':'); if (kind === 'entry') moveEntry(id, folder.id); if (kind === 'folder') moveFolder(id, folder.id); }}><button className="tree-toggle" type="button" onClick={() => setOpenFolders(value => ({ ...value, [folder.id]: !open }))} aria-label="展开或折叠文件夹"><ChevronRight size={13} data-open={open ? 'true' : 'false'} /></button>{editingFolderId === folder.id ? <input className="tree-inline-input" autoFocus defaultValue={folder.name} onBlur={event => { const name = event.currentTarget.value.trim() || '未命名'; persistFolders(folders.map(item => item.id === folder.id ? { ...item, name } : item)); setEditingFolderId(null); }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') setEditingFolderId(null); }} /> : <button className="tree-item" type="button" onDoubleClick={() => renameFolder(folder)} onClick={() => setOpenFolders(value => ({ ...value, [folder.id]: !open }))}>{open ? <FolderOpen size={15} /> : <Folder size={15} />}<span>{folder.name}</span></button>}<button className="tree-more" type="button" onClick={event => openContextMenu(event, 'folder', folder.id)} aria-label="文件夹操作"><MoreHorizontal size={14} /></button></div>{open ? <div className="tree-children">{children.map(renderFolder)}{folderEntries.map(entry => <TreeItem key={entry.id} entry={entry} entries={visible} selectedId={selectedId} onSelect={openEntry} onContextMenu={openContextMenu} />)}</div> : null}</div>;
  }

  async function openEntry(id: string, loadedItem?: Entry) {
    const item = loadedItem ?? entries.find(entry => entry.id === id);
    if (!item) return;
    const generation = identityGeneration.current;
    setSelectedId(id); setSelected(item); setTitle(item.title); setBody(item.body ?? '');
    setView(item.kind === 'agent' ? 'sessions' : 'notes');
    if (window.innerWidth <= 720) setSidebarOpen(false);
    setRailOpen(window.innerWidth > 1050 && item.kind === 'note');
    if (item.kind === 'agent') {
      try {
        const current = (await listSessions(item.id))[0] ?? await createSession(item.id);
        const next = current.messages ? current : await getSession(current.id);
        if (generation === identityGeneration.current) setChat(next);
      } catch { if (generation === identityGeneration.current) setChat(null); }
    } else setChat(null);
  }

  async function load(generation: number) {
    try {
      const libs = await listLibraries();
      if (generation !== identityGeneration.current) return;
      setLibraries(libs);
      if (!libs[0]) return;
      const items = await listEntries(libs[0].id);
      if (generation !== identityGeneration.current) return;
      setEntries(items);
      const first = items.find(item => item.kind === 'note') ?? items[0];
      if (first) void openEntry(first.id, first);
    } catch (err) {
      if (generation !== identityGeneration.current) return;
      if (err instanceof AuthError && err.status === 401) location.replace('/auth/login');
      else setError('工作区暂时无法连接，请稍后重试。');
    } finally { if (generation === identityGeneration.current) setLoading(false); }
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
        setFolders(localData<VaultFolder[]>('tjuclaw.vault.folders.v1', []));
        setPlacements(localData<VaultPlacement>('tjuclaw.vault.placements.v1', {}));
        setAnkiCards(localData<AnkiCard[]>('tjuclaw.anki.cards.v1', []));
        setSelected(null);
        setSelectedId(null);
        setTitle('');
        setBody('');
        setChat(null);
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
    window.clearTimeout(saveTimer.current); setSaving(true);
    saveTimer.current = window.setTimeout(() => void patchEntry(selected.id, { title: nextTitle, body: nextBody }).then(entry => {
      if (generation !== identityGeneration.current) return;
      setSelected(entry); setEntries(items => items.map(item => item.id === entry.id ? entry : item)); setSaving(false);
    }).catch(() => { if (generation === identityGeneration.current) { setSaving(false); setError('保存失败，请稍后再试。'); } }), 650);
  }

  function switchView(next: 'notes' | 'sessions' | 'anki' | 'plugins') {
    setView(next);
    if (next !== 'notes') setRailOpen(false);
    if (next === 'plugins' || (next !== 'anki' && selected?.kind !== (next === 'notes' ? 'note' : 'agent'))) {
      setSelected(null);
      setSelectedId(null);
    }
  }

  async function createNote(noteTitle = '未命名笔记', initialBody = '', folderId?: string) {
    if (!library) return;
    const generation = identityGeneration.current;
    try {
      const entry = await createEntry(library.id, { kind: 'note', title: noteTitle, body: initialBody });
      if (generation !== identityGeneration.current) return;
      setEntries(items => [...items, entry]);
      if (folderId) persistPlacements({ ...placements, [entry.id]: folderId });
      setView('notes');
      setSelectedId(entry.id);
      setSelected(entry);
      setTitle(entry.title);
      setBody(entry.body ?? '');
      setChat(null);
      setRailOpen(window.innerWidth > 1050);
      if (window.innerWidth <= 720) setSidebarOpen(false);
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
      if (selectedId === id) { setSelected(null); setSelectedId(null); setTitle(''); setBody(''); }
    } catch { setError('删除文档失败，请稍后再试。'); }
  }

  async function handleChat(event: FormEvent) {
    event.preventDefault();
    if (!chat || !draft.trim()) return;
    const text = draft.trim(); setDraft('');
    try { setChat(await sendMessage(chat.id, text)); } catch { setError('会话暂时不可用，请稍后再试。'); }
  }

  function saveAnkiCards(cards: AnkiCard[]) {
    setAnkiCards(cards);
    if (identityRef.current) localStorage.setItem(`tjuclaw.anki.cards.v1.${identityRef.current}`, JSON.stringify(cards));
  }

  function exportAnki() {
    const content = ankiCards.map(card => `${card.front}\t${card.back}\t${card.tags}`).join('\n');
    const blob = new Blob([content], { type: 'text/tab-separated-values;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = 'tjuclaw-anki-deck.txt'; link.click();
    URL.revokeObjectURL(url);
  }

  function jumpToHeading(text: string) {
    const offset = body.indexOf(text);
    if (offset < 0 || !bodyRef.current) return;
    bodyRef.current.focus();
    bodyRef.current.dispatch({ selection: { anchor: offset, head: offset + text.length } });
  }

  if (loading || !session) return <div className="workspace-loading"><Loader2 className="animate-spin" size={18} /> 正在打开你的知识花园…</div>;

  return <div className={`obsidian-app${sidebarOpen ? '' : ' sidebar-collapsed'}${railOpen ? '' : ' rail-collapsed'}`} style={{ gridTemplateColumns: `${sidebarOpen ? sidebarWidth : 0}px minmax(0, 1fr) ${railOpen ? railWidth : 0}px` }}>
    <motion.aside ref={sidebarRef} className="obsidian-sidebar" aria-hidden={!sidebarOpen} inert={!sidebarOpen}
      initial={false} animate={{ x: isMobile && !sidebarOpen ? '-100%' : '0%', opacity: isMobile && !sidebarOpen ? 0 : 1 }}
      transition={{ duration: reduceMotion ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] }}>
      <div className="sidebar-activity" aria-label="工作区导航"><div className="activity-main">{([
        { id: 'notes', label: '资料夹', Icon: LibraryBig },
        { id: 'sessions', label: 'Agent', Icon: MousePointer2 },
        { id: 'anki', label: '记忆闪卡', Icon: Brain },
        { id: 'plugins', label: '插件', Icon: Blocks },
      ] as const).map(({ id, label, Icon }) => <motion.button key={id} className={view === id ? 'is-active' : ''} type="button" title={label} aria-label={label} aria-current={view === id ? 'page' : undefined} whileTap={reduceMotion ? undefined : { scale: 0.94 }} onClick={() => switchView(id)}>{view === id ? <motion.span className="activity-current-mark" layoutId="workspace-active-view" transition={{ duration: reduceMotion ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }} /> : null}<Icon size={19} /><span>{label}</span></motion.button>)}</div><motion.button className="activity-settings" type="button" title="知识图谱" aria-label="知识图谱" whileTap={reduceMotion ? undefined : { scale: 0.94 }} onClick={() => setGraphOpen(true)}><Network size={19} /><span>图谱</span></motion.button></div>
      <div className="sidebar-pane">
      <div className="sidebar-pane-header"><span>{view === 'notes' ? '资料夹' : view === 'sessions' ? 'Agent' : view === 'anki' ? '记忆闪卡' : '插件'}</span><button type="button" title="收起侧栏" aria-label="收起侧栏" onClick={() => setSidebarOpen(false)}><PanelLeft size={16} /></button></div>
      {view !== 'plugins' ? <label className="obsidian-search"><Search size={15} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索笔记..." /></label> : null}
      <div className="tree-heading"><span>{view === 'notes' ? '笔记库' : view === 'sessions' ? 'Agent' : view === 'anki' ? '记忆卡片' : '内置能力'}</span>{view === 'notes' ? <div className="tree-heading-actions"><button type="button" onClick={() => void createNote()} aria-label="新建笔记"><Plus size={15} /></button><button type="button" onClick={() => createFolder()} aria-label="新建文件夹"><FolderPlus size={15} /></button></div> : view === 'anki' ? <button type="button" onClick={() => saveAnkiCards([...ankiCards, { id: crypto.randomUUID(), front: '', back: '', tags: '' }])} aria-label="新建卡片"><Plus size={15} /></button> : null}</div>
      <nav className="obsidian-tree">
        {view === 'plugins' ? <>
          {builtInPlugins.map(plugin => { const Icon = plugin.Icon; return <button key={plugin.id} type="button" className={`session-tree-item${activePluginId === plugin.id ? ' is-active' : ''}`} aria-current={activePluginId === plugin.id ? 'page' : undefined} onClick={() => { setActivePluginId(plugin.id); if (isMobile) setSidebarOpen(false); }}><Icon size={15} /><span>{plugin.name}</span></button>; })}
          <p className="plugin-sidebar-note">第三方插件尚未开放</p>
        </> : view === 'anki' ? <div className="anki-sidebar-list">{ankiCards.map((card, index) => <button key={card.id} type="button" className="session-tree-item" onClick={() => { document.getElementById(`anki-card-${card.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); if (window.innerWidth <= 720) setSidebarOpen(false); }}><Brain size={15} /><span>{card.front || `新卡片 ${index + 1}`}</span></button>)}</div> : view === 'notes' ? <>{folderRoots.map(renderFolder)}{roots.map(entry => <TreeItem key={entry.id} entry={entry} entries={visible} selectedId={selectedId} onSelect={openEntry} onContextMenu={openContextMenu} />)}</> : roots.map(entry => <button key={entry.id} type="button" className={`session-tree-item${selectedId === entry.id ? ' is-active' : ''}`} onClick={() => void openEntry(entry.id)}><MousePointer2 size={15} /><span>{entry.title}</span></button>)}
      </nav>
      <div className="sidebar-bottom" aria-label="工作区工具"><button type="button" className="sidebar-library-button" title={library?.name ?? '我的知识库'} aria-label={`${library?.name ?? '我的知识库'}，${fileCount} 个文件，${folders.length} 个文件夹`} onClick={() => { setSettingsSection('library'); setSettingsOpen(true); }}><span className="sidebar-library-copy"><strong className="sidebar-library-name">{library?.name ?? '我的知识库'}</strong><small>{fileCount} 个文件 · {folders.length} 个文件夹</small></span><ChevronDown className="sidebar-library-chevron" size={15} /></button><button type="button" title="设置" aria-label="设置" onClick={() => { setSettingsSection('appearance'); setSettingsOpen(true); }}><Settings size={17} /></button></div>
      </div>
    </motion.aside>
    <AnimatePresence initial={false}>{isMobile && sidebarOpen ? <motion.button type="button" className="mobile-sidebar-backdrop" aria-label="收起侧栏" onClick={() => setSidebarOpen(false)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduceMotion ? 0 : 0.18 }} /> : null}</AnimatePresence>
    <div className="panel-resizer panel-resizer-sidebar" style={{ left: sidebarOpen ? sidebarWidth - 3 : 0 }} role="separator" aria-label="调整左侧面板宽度" onPointerDown={event => startResize('sidebar', event)} />
    <main className="obsidian-main" inert={(sidebarOpen || railOpen) && window.innerWidth <= 720}>
      <header className="obsidian-topbar"><Button variant="ghost" size="icon" className="sidebar-opener" onClick={() => setSidebarOpen(value => !value)} aria-label={sidebarOpen ? '收起侧栏' : '打开侧栏'}><PanelLeft size={18} /></Button><div className="workspace-tab"><span>{view === 'plugins' ? '插件' : view === 'anki' ? '记忆闪卡' : selected?.title || (view === 'sessions' ? 'Agent' : '新建笔记')}</span></div><div className="topbar-actions"><Button variant="ghost" size="icon" onClick={() => { setView('notes'); setSelected(null); setSelectedId(null); setRailOpen(false); }} aria-label="打开新建笔记页" title="打开新建笔记页"><Plus size={18} /></Button><Button variant="ghost" size="icon" onClick={() => setCommandOpen(true)} aria-label="快速切换" title="快速切换"><Search size={17} /></Button><Button variant="ghost" size="icon" onClick={() => setRailOpen(value => !value)} aria-label="切换信息栏" title="切换信息栏"><PanelLeft size={17} /></Button></div><div className="mobile-topbar-actions">{selected?.kind === 'note' && view === 'notes' ? <button type="button" onClick={() => setEditorMode(value => value === 'edit' ? 'preview' : 'edit')} aria-label={editorMode === 'edit' ? '阅读模式' : '编辑模式'}>{editorMode === 'edit' ? <BookOpen size={18} /> : <Pencil size={18} />}</button> : null}<button type="button" onClick={event => { event.stopPropagation(); if (selected?.kind === 'note' && view === 'notes') setContextMenu({ x: 0, y: 0, kind: 'note', id: selected.id }); else setCommandOpen(true); }} aria-label="更多操作"><MoreHorizontal size={19} /></button></div></header>
      {error ? <div className="workspace-error">{error}<button type="button" onClick={() => setError('')}><X size={14} /></button></div> : null}
      {view === 'plugins' ? <WorkspacePlugins activeId={activePluginId} onOpen={id => {
        if (id === 'graph') { setGraphOpen(true); return; }
        switchView(id === 'flashcards' ? 'anki' : 'notes');
      }} /> : view === 'anki' ? <section className="anki-editor"><div className="anki-header"><div><h1>记忆闪卡</h1><p>兼容 Anki TSV 导入格式</p></div><Button onClick={exportAnki} disabled={!ankiCards.length}><Download size={16} /> 导出 Anki</Button></div><div className="anki-cards">{ankiCards.map(card => <div className="anki-card" id={`anki-card-${card.id}`} key={card.id}><div className="anki-card-head"><span>卡片</span><button type="button" onClick={() => saveAnkiCards(ankiCards.filter(item => item.id !== card.id))}><X size={14} /></button></div><label>正面<textarea value={card.front} onChange={event => saveAnkiCards(ankiCards.map(item => item.id === card.id ? { ...item, front: event.target.value } : item))} placeholder="问题或提示" /></label><label>背面<textarea value={card.back} onChange={event => saveAnkiCards(ankiCards.map(item => item.id === card.id ? { ...item, back: event.target.value } : item))} placeholder="答案、解释或例子" /></label><label>标签<input value={card.tags} onChange={event => saveAnkiCards(ankiCards.map(item => item.id === card.id ? { ...item, tags: event.target.value } : item))} placeholder="例如：高数 期末" /></label></div>)}</div>{!ankiCards.length ? <div className="anki-empty"><Brain size={25} /><h2>还没有记忆闪卡</h2><p>点击左侧 +，建立第一张记忆卡片。</p></div> : null}</section> : view === 'sessions' && !selected ? <section className="workspace-blank"><MousePointer2 size={25} /><p>从左侧选择 Agent</p></section> : !selected ? <NewNoteHome entries={entries} onCreate={(noteTitle, initialBody) => void createNote(noteTitle, initialBody)} onOpen={id => void openEntry(id)} /> : selected.kind === 'agent' ? <section className="session-view"><div className="session-heading"><div className="session-icon"><MousePointer2 size={20} /></div><div><p>Agent</p><h1>{selected.title}</h1></div></div><div className="chat-messages">{(chat?.messages ?? []).filter(message => message.content).map((message, index) => <div key={`${message.created_at}-${index}`} className={`chat-message ${message.role}`}><small>{message.role === 'user' ? '你' : 'TJUClaw'}</small><p>{message.content}</p></div>)}</div><form className="chat-composer" onSubmit={handleChat}><textarea value={draft} onChange={event => setDraft(event.target.value)} placeholder="输入消息，按 Enter 发送..." rows={1} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /><button type="submit" aria-label="发送" disabled={!draft.trim()}><Send size={17} /></button></form></section> : <article className="note-editor" onContextMenu={event => openContextMenu(event, 'editor')}><div className="note-toolbar"><div className="mode-switch"><button type="button" className={editorMode === 'edit' ? 'is-active' : ''} onClick={() => setEditorMode('edit')} aria-label="编辑模式" title="编辑模式"><Pencil size={16} /></button><button type="button" className={editorMode === 'preview' ? 'is-active' : ''} onClick={() => setEditorMode('preview')} aria-label="阅读模式" title="阅读模式"><Eye size={16} /></button></div></div><input ref={titleRef} className="note-title" value={title} onChange={event => { setTitle(event.target.value); queueSave(event.target.value, body); }} placeholder="未命名笔记" />{editorMode === 'preview' ? <div className="markdown-preview" dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }} /> : <MarkdownEditor key={selected.id} value={body} onChange={nextBody => { setBody(nextBody); queueSave(title, nextBody); }} editorRef={bodyRef} />}</article>}
      <nav className="mobile-command-bar" aria-label="快捷操作"><button type="button" onClick={() => { switchView('notes'); setSidebarOpen(true); }} aria-label="打开资料夹"><LibraryBig size={19} /></button><button type="button" onClick={() => setCommandOpen(true)} aria-label="搜索和快速切换"><Search size={19} /></button><button type="button" onClick={() => void createNote()} aria-label="新建笔记"><Plus size={22} /></button><button type="button" onClick={() => { setSidebarOpen(true); switchView('sessions'); }} aria-label="打开 Agent"><MousePointer2 size={19} /></button><button type="button" onClick={() => { setSidebarOpen(true); switchView('anki'); }} aria-label="打开记忆闪卡"><Brain size={19} /></button></nav>
      <footer className="workspace-statusbar"><span>{library?.name ?? '我的知识库'}</span><span className="statusbar-details">{saving ? '保存中…' : '已保存'}{selected?.kind === 'note' ? ` · ${body.length} 字符` : ''}</span></footer>
    </main>
    {contextMenu ? <><button className="mobile-context-backdrop" type="button" aria-label="关闭操作菜单" onClick={() => setContextMenu(null)} /><WorkspaceContextMenu menu={contextMenu} onClose={() => setContextMenu(null)} onAction={handleContextAction} /></> : null}
    <div className="panel-resizer panel-resizer-rail" style={{ right: railOpen ? railWidth - 3 : 0 }} role="separator" aria-label="调整右侧面板宽度" onPointerDown={event => startResize('rail', event)} />
    <AnimatePresence initial={false}>{isMobile && railOpen ? <motion.button type="button" className="mobile-rail-backdrop" aria-label="关闭大纲" onClick={() => setRailOpen(false)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduceMotion ? 0 : 0.18 }} /> : null}</AnimatePresence>
    <motion.aside ref={railRef} className="obsidian-rail" aria-hidden={!railOpen} inert={!railOpen}
      initial={false} animate={{ x: isMobile && !railOpen ? '100%' : '0%', opacity: isMobile && !railOpen ? 0 : 1 }}
      transition={{ duration: reduceMotion ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] }}><div className="rail-heading"><span>{view === 'anki' ? '记忆闪卡' : '大纲'}</span><Button variant="ghost" size="icon" onClick={() => setRailOpen(false)} aria-label="关闭信息栏"><X size={15} /></Button></div>{view === 'anki' ? <div className="rail-tip"><BookOpen size={15} /> 导出为 TSV 后可在 Anki 中导入。</div> : <div className="rail-section">{selected?.kind === 'note' && headings.length ? headings.map(item => <button key={item.id} className={`outline-item level-${item.level}`} type="button" onClick={() => { jumpToHeading(item.text); if (window.innerWidth <= 720) setRailOpen(false); }}>{item.text}</button>) : <p className="outline-muted">当前笔记没有标题</p>}</div>}</motion.aside>
    <WorkspaceSettings open={settingsOpen} onOpenChange={setSettingsOpen} section={settingsSection} onSectionChange={setSettingsSection} libraryName={library?.name ?? '我的知识库'} fileCount={fileCount} noteCount={noteCount} folderCount={folders.length} cardCount={ankiCards.length} email={session.email} editorMode={editorMode} onEditorModeChange={setEditorMode} onShowNotes={() => { setView('notes'); setSettingsOpen(false); setSidebarOpen(true); }} onShowCards={() => { setView('anki'); setSettingsOpen(false); setSidebarOpen(true); }} onExportCards={exportAnki} onLogout={() => void logout()} />
    <KnowledgeGraph open={graphOpen} onOpenChange={setGraphOpen} entries={entries} onOpenNote={id => { void openEntry(id); setGraphOpen(false); }} />
    <Dialog open={moveEntryId !== null} onOpenChange={open => { if (!open) setMoveEntryId(null); }}><DialogContent className="workspace-move-dialog"><DialogTitle>移动到</DialogTitle><DialogDescription>选择文档所在的文件夹</DialogDescription><div className="workspace-folder-picker"><button type="button" onClick={() => moveEntryId && moveEntry(moveEntryId, null)}><Folder size={17} /> 知识库根目录 <MoveRight size={15} /></button>{folders.map(folder => <button key={folder.id} type="button" onClick={() => moveEntryId && moveEntry(moveEntryId, folder.id)} style={{ paddingLeft: 16 + folders.filter(parent => parent.id === folder.parentId).length * 16 }}><Folder size={17} /> {folder.name} <MoveRight size={15} /></button>)}</div></DialogContent></Dialog>
    <Dialog open={commandOpen} onOpenChange={setCommandOpen}><DialogContent className="command-dialog"><DialogTitle>快速切换</DialogTitle><DialogDescription>跳转到笔记、Agent 或工具。</DialogDescription><div className="command-list">{entries.filter(item => item.title.toLowerCase().includes(query.toLowerCase())).slice(0, 12).map(item => <button key={item.id} type="button" onClick={() => { setView(item.kind === 'agent' ? 'sessions' : 'notes'); void openEntry(item.id); setCommandOpen(false); }}><Link2 size={15} /><span>{item.title}</span><small>{item.kind === 'agent' ? 'Agent' : '笔记'}</small></button>)}<button type="button" onClick={() => { setView('anki'); setCommandOpen(false); }}><Brain size={15} /><span>打开记忆闪卡</span><small>工具</small></button></div></DialogContent></Dialog>
  </div>;
}
