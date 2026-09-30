import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CornerDownLeft, FilePlus2, FileText, MessageCircle, Network, Search, Settings, SquareStack, Wrench, type LucideIcon } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { searchNotes, type SearchHit } from '../lib/library';

// Search, after Notion: one field over notes (titles at once, then full text
// from the server with a snippet), conversations, decks, tools and actions.

export interface PaletteItem {
  id: string;
  group: '笔记' | '全文' | '会话' | '闪卡' | '小工具' | '操作';
  title: string;
  detail?: string;
  icon: LucideIcon;
  run: () => void;
}

export interface PaletteSources {
  notes: { id: string; title: string; updatedAt: string }[];
  conversations: { id: string; title: string }[];
  decks: { id: string; name: string }[];
  tools: { id: string; name: string }[];
  openNote: (id: string) => void;
  openConversation: (id: string) => void;
  openDeck: (id: string) => void;
  openTool: (id: string) => void;
  newNote: (title?: string) => void;
  newChat: () => void;
  openGraph: () => void;
  openSettings: () => void;
}

const GROUPS: PaletteItem['group'][] = ['笔记', '全文', '会话', '闪卡', '小工具', '操作'];
const matches = (text: string, query: string) => text.toLowerCase().includes(query.toLowerCase());

/** Text with each occurrence of query marked. */
function Marked({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const parts: ReactNode[] = [];
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  let from = 0;
  for (let at = lower.indexOf(needle); at >= 0 && parts.length < 40; at = lower.indexOf(needle, from)) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(<mark key={at}>{text.slice(at, at + needle.length)}</mark>);
    from = at + needle.length;
  }
  parts.push(text.slice(from));
  return <>{parts}</>;
}

export function SearchPalette({ open, onOpenChange, libraryId, sources }: { open: boolean; onOpenChange: (open: boolean) => void; libraryId?: string; sources: PaletteSources }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const trimmed = query.trim();

  // Full text comes from the server, a moment after typing stops.
  useEffect(() => {
    if (!open || !libraryId || trimmed.length < 1) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearching(true);
      searchNotes(libraryId, trimmed, controller.signal).then(setHits).catch(() => { if (!controller.signal.aborted) setHits([]); })
        .finally(() => { if (!controller.signal.aborted) setSearching(false); });
    }, 180);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [open, libraryId, trimmed]);

  const close = (run?: () => void) => { onOpenChange(false); setQuery(''); setHits([]); setActive(0); run?.(); };

  const items = useMemo<PaletteItem[]>(() => {
    const list: PaletteItem[] = [];
    const notes = trimmed
      ? sources.notes.filter(note => matches(note.title || '未命名笔记', trimmed))
      : [...sources.notes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const titled = new Set(notes.map(note => note.id));
    notes.slice(0, trimmed ? 8 : 6).forEach(note => list.push({ id: `note:${note.id}`, group: '笔记', title: note.title || '未命名笔记', icon: FileText, run: () => sources.openNote(note.id) }));
    if (trimmed) {
      hits.filter(hit => !titled.has(hit.id)).slice(0, 8).forEach(hit => list.push({ id: `hit:${hit.id}`, group: '全文', title: hit.title || '未命名笔记', detail: hit.snippet, icon: FileText, run: () => sources.openNote(hit.id) }));
      sources.conversations.filter(item => matches(item.title, trimmed)).slice(0, 5).forEach(item => list.push({ id: `chat:${item.id}`, group: '会话', title: item.title, icon: MessageCircle, run: () => sources.openConversation(item.id) }));
      sources.decks.filter(deck => matches(deck.name, trimmed)).slice(0, 4).forEach(deck => list.push({ id: `deck:${deck.id}`, group: '闪卡', title: deck.name, icon: SquareStack, run: () => sources.openDeck(deck.id) }));
      sources.tools.filter(tool => matches(tool.name, trimmed)).forEach(tool => list.push({ id: `tool:${tool.id}`, group: '小工具', title: tool.name, icon: Wrench, run: () => sources.openTool(tool.id) }));
    }
    const actions: PaletteItem[] = [
      { id: 'act:note', group: '操作', title: trimmed ? `新建笔记「${trimmed}」` : '新建笔记', icon: FilePlus2, run: () => sources.newNote(trimmed || undefined) },
      { id: 'act:chat', group: '操作', title: '新对话', icon: MessageCircle, run: sources.newChat },
      { id: 'act:graph', group: '操作', title: '知识图谱', icon: Network, run: sources.openGraph },
      { id: 'act:settings', group: '操作', title: '设置', icon: Settings, run: sources.openSettings },
    ];
    list.push(...actions.filter(action => !trimmed || action.id === 'act:note' || matches(action.title, trimmed)));
    return list;
  }, [trimmed, hits, sources]);

  const current = Math.min(active, Math.max(0, items.length - 1));
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  return <Dialog open={open} onOpenChange={next => { if (!next) close(); else onOpenChange(true); }}>
    <DialogContent className="search-palette">
      <DialogTitle className="sr-only">搜索</DialogTitle>
      <DialogDescription className="sr-only">搜索笔记正文、会话、闪卡与小工具。</DialogDescription>
      <label className="search-palette-field">
        <Search size={18} aria-hidden="true" />
        <input autoFocus value={query} placeholder="搜索笔记、正文、会话…" aria-label="搜索"
          onChange={event => { setQuery(event.target.value); setActive(0); if (!event.target.value.trim()) setHits([]); }}
          onKeyDown={event => {
            if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => Math.min(index + 1, items.length - 1)); }
            if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(index - 1, 0)); }
            if (event.key === 'Enter' && items[current]) { event.preventDefault(); close(items[current].run); }
          }} />
        {searching ? <span className="search-palette-busy" aria-hidden="true" /> : null}
      </label>
      <div className="search-palette-results" ref={listRef} role="listbox" aria-label="搜索结果">
        {GROUPS.map(group => {
          const inGroup = items.filter(item => item.group === group);
          if (!inGroup.length) return null;
          return <section key={group} aria-label={group}>
            <h3>{group === '笔记' && !trimmed ? '最近' : group === '全文' ? '正文中' : group}</h3>
            {inGroup.map(item => {
              const index = items.indexOf(item);
              const Icon = item.icon;
              return <button key={item.id} type="button" role="option" aria-selected={index === current} data-active={index === current}
                onMouseMove={() => setActive(index)} onClick={() => close(item.run)}>
                <Icon size={16} aria-hidden="true" />
                <span className="search-palette-text"><strong><Marked text={item.title} query={trimmed} /></strong>{item.detail ? <small><Marked text={item.detail} query={trimmed} /></small> : null}</span>
                {index === current ? <CornerDownLeft size={14} className="search-palette-enter" aria-hidden="true" /> : null}
              </button>;
            })}
          </section>;
        })}
        {trimmed && !searching && items.every(item => item.group === '操作') ? <p className="search-palette-empty">没有找到「{trimmed}」</p> : null}
      </div>
      <footer className="search-palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>Enter</kbd> 打开</span><span><kbd>Esc</kbd> 关闭</span></footer>
    </DialogContent>
  </Dialog>;
}
