import { useEffect, useRef, useState } from 'react';
import { FileText, GitFork, Loader2, RefreshCw, Search, Trash2 } from 'lucide-react';
import { createSandboxNote, deleteSandboxNote, graphSandboxNotes, listSandboxNotes, moveSandboxNote, readSandboxNote, searchSandboxNotes, updateSandboxNote, type SandboxNoteGraph, type SandboxSearchHit } from '../lib/sandbox-notes';
import './sandbox-notes.css';

type PendingNote = { path: string; content: string; revision: string; draft: string };
const pendingNotes = new Map<string, PendingNote>();
function warnPendingNotes(event: BeforeUnloadEvent) {
  event.preventDefault();
  event.returnValue = '';
}
function rememberNote(key: string, pending: PendingNote | null) {
  if (pending) pendingNotes.set(key, pending);
  else pendingNotes.delete(key);
  if (pendingNotes.size) window.addEventListener('beforeunload', warnPendingNotes);
  else window.removeEventListener('beforeunload', warnPendingNotes);
}

export function SandboxNotes({ sessionId, ownerId, entryId, preset }: {
  sessionId: string; ownerId: string; entryId: string; preset: string;
}) {
  const draftKey = `${ownerId}:${sessionId}:${entryId}:${preset}`;
  const [restored] = useState(() => pendingNotes.get(draftKey));
  const [paths, setPaths] = useState<string[] | null>(null);
  const [headRevision, setHeadRevision] = useState<string | null>(null);
  const [newPath, setNewPath] = useState('');
  const [movePath, setMovePath] = useState(restored?.path ?? '');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SandboxSearchHit[] | null>(null);
  const [graph, setGraph] = useState<SandboxNoteGraph | null>(null);
  const [selected, setSelected] = useState<string | null>(restored?.path ?? null);
  const [content, setContent] = useState<string | null>(restored?.content ?? null);
  const [revision, setRevision] = useState<string | null>(restored?.revision ?? null);
  const [draft, setDraft] = useState(restored?.draft ?? '');
  const [editing, setEditing] = useState(Boolean(restored));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const dirty = editing && draft !== content;

  const start = () => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    return controller;
  };
  const refresh = async () => {
    const controller = start();
    try {
      const result = await listSandboxNotes(sessionId, ownerId, entryId, preset, controller.signal);
      if (!controller.signal.aborted) {
        setPaths(result.paths); setHeadRevision(result.revision); setHits(null); setGraph(null);
        setSelected(null); setContent(null); setRevision(null); setEditing(false);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '暂时无法打开笔记，请稍后重试。');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const search = async () => {
    if (!query.trim()) return;
    const controller = start();
    try {
      const result = await searchSandboxNotes(sessionId, ownerId, entryId, preset, query.trim(), controller.signal);
      if (!controller.signal.aborted) { setHits(result.hits); setHeadRevision(result.revision); setGraph(current => current?.revision === result.revision ? current : null); }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '检索失败。');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const open = async (path: string) => {
    const controller = start();
    setSelected(path);
    setMovePath(path);
    setContent(null);
    setRevision(null);
    setEditing(false);
    try {
      const result = await readSandboxNote(sessionId, ownerId, entryId, preset, path, controller.signal);
      if (!controller.signal.aborted) {
        setContent(result.content); setDraft(result.content); setRevision(result.revision);
        setGraph(current => current?.revision === result.revision ? current : null);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '文件读取失败。');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const save = async () => {
    if (!selected || !revision) return;
    const controller = start();
    try {
      const nextRevision = await updateSandboxNote(sessionId, ownerId, entryId, preset, selected, revision, draft, controller.signal);
      if (!controller.signal.aborted) {
        rememberNote(draftKey, null);
        setContent(draft);
        setRevision(nextRevision);
        setHeadRevision(nextRevision);
        setHits(null);
        setGraph(null);
        setEditing(false);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '保存失败，草稿已保留。');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const create = async () => {
    const path = newPath.trim();
    if (!path || !headRevision || paths?.includes(path) || (paths && paths.length >= 200)) {
      setError('请填写一个尚不存在的 Markdown 文件名。');
      return;
    }
    const controller = start();
    try {
      const nextRevision = await createSandboxNote(sessionId, ownerId, entryId, preset, path, headRevision, '', controller.signal);
      if (!controller.signal.aborted) {
        setPaths(current => [...(current ?? []), path].sort());
        setHeadRevision(nextRevision);
        setHits(null);
        setGraph(null);
        setSelected(path);
        setMovePath(path);
        setContent('');
        setDraft('');
        setRevision(nextRevision);
        setEditing(true);
        setNewPath('');
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '新建文件失败。');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const remove = async () => {
    if (!selected || !revision || dirty || !window.confirm(`从 Git 当前版本移除「${selected}」？历史版本仍可通过 Git 恢复。`)) return;
    const path = selected;
    const controller = start();
    try {
      const nextRevision = await deleteSandboxNote(sessionId, ownerId, entryId, preset, path, revision, controller.signal);
      if (!controller.signal.aborted) {
        rememberNote(draftKey, null);
        setPaths(current => current?.filter(item => item !== path) ?? null);
        setHeadRevision(nextRevision);
        setHits(null);
        setGraph(null);
        setSelected(null);
        setMovePath('');
        setContent(null);
        setRevision(null);
        setEditing(false);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '删除结果未确认，请刷新文件列表核对。');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const move = async () => {
    if (!selected || !revision || content === null || dirty || movePath.trim() === selected) return;
    const destination = movePath.trim();
    const controller = start();
    try {
      const nextRevision = await moveSandboxNote(sessionId, ownerId, entryId, preset, selected, destination, revision, content, controller.signal);
      if (!controller.signal.aborted) {
        setPaths(current => current?.map(path => path === selected ? destination : path).sort() ?? null);
        setHeadRevision(nextRevision);
        setSelected(destination);
        setMovePath(destination);
        setRevision(nextRevision);
        setGraph(null);
        setHits(null);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '移动结果未确认，请刷新文件列表核对。');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const cancel = () => {
    if (dirty && !window.confirm('放弃这份还没保存的修改？')) return;
    rememberNote(draftKey, null);
    setDraft(content ?? '');
    setEditing(false);
    setError('');
  };
  const loadGraph = async () => {
    const controller = start();
    try {
      const result = await graphSandboxNotes(sessionId, ownerId, entryId, preset, controller.signal);
      if (!controller.signal.aborted) {
        setGraph(result); setHeadRevision(result.revision);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '图谱读取失败。');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const outgoing = graph?.edges.filter(edge => edge.source === selected).map(edge => edge.target) ?? [];
  const incoming = graph?.edges.filter(edge => edge.target === selected).map(edge => edge.source) ?? [];

  return <section className="sandbox-notes" aria-label="Agent Git 工作区">
    <div className="sandbox-notes-heading"><div><strong>Agent Git 工作区</strong><small>每次保存都是一次提交，Agent 也能读写这里的笔记</small></div>
      <button type="button" onClick={() => void refresh()} disabled={busy || dirty}><RefreshCw size={14} /> {paths ? '刷新' : '查看文件'}</button>
    </div>
    {busy ? <p className="sandbox-notes-state"><Loader2 size={14} className="animate-spin" /> 正在打开笔记…</p> : null}
    {error ? <p className="sandbox-notes-error" role="alert">{error}</p> : null}
    {paths ? <form className="sandbox-notes-search" onSubmit={event => { event.preventDefault(); void search(); }}>
      <label htmlFor="sandbox-note-query" className="sr-only">检索 Git 笔记</label>
      <input id="sandbox-note-query" value={query} onChange={event => { setQuery(event.target.value); setHits(null); }}
        placeholder="搜索笔记…" maxLength={128} disabled={busy || dirty} />
      <button type="submit" disabled={busy || dirty || !query.trim()}><Search size={13} /> 检索</button>
    </form> : null}
    {hits ? <div className="sandbox-notes-results" aria-live="polite">
      {hits.length ? hits.map(hit => <button key={hit.path} type="button" disabled={busy || dirty} onClick={() => void open(hit.path)}>
        <strong>{hit.path}</strong><span>{hit.snippet}</span>
      </button>) : <p className="sandbox-notes-state">没有找到匹配的笔记。</p>}
    </div> : null}
    {paths ? <div className="sandbox-notes-graph-heading">
      <span>笔记链接</span>
      <button type="button" disabled={busy || dirty} onClick={() => graph ? setGraph(null) : void loadGraph()}>
        <GitFork size={13} /> {graph ? '收起图谱' : '查看图谱'}
      </button>
    </div> : null}
    {graph ? <div className="sandbox-notes-graph">
      <p>{graph.nodes.length} 篇笔记 · {graph.edges.length} 条链接（仅统计可解析的 [[双链]]）</p>
      {selected ? <div className="sandbox-notes-connections">
        <div><strong>链接到</strong>{outgoing.length ? outgoing.map(path => <button key={path} type="button" disabled={busy || dirty} onClick={() => void open(path)}>{path}</button>) : <span>暂无</span>}</div>
        <div><strong>反向链接</strong>{incoming.length ? incoming.map(path => <button key={path} type="button" disabled={busy || dirty} onClick={() => void open(path)}>{path}</button>) : <span>暂无</span>}</div>
      </div> : <p>选择一篇笔记，查看它的出链和反向链接。</p>}
      <SandboxGraphMap graph={graph} selected={selected} busy={busy || dirty} open={open} />
    </div> : null}
    {paths ? <form onSubmit={event => { event.preventDefault(); void create(); }}>
      <label htmlFor="sandbox-note-new-path" className="sr-only">新文件名</label>
      <input id="sandbox-note-new-path" value={newPath} onChange={event => setNewPath(event.target.value)}
        placeholder="新笔记.md 或 目录/新笔记.md" disabled={busy || dirty} />
      <button type="submit" disabled={busy || dirty || paths.length >= 200 || !newPath.trim()}>新建 Markdown</button>
    </form> : null}
    {paths?.length === 0 ? <p className="sandbox-notes-state">还没有笔记，新建第一篇吧。</p> : null}
    {paths?.length ? <div className="sandbox-notes-files">{paths.map(path => <button key={path} type="button" disabled={busy || dirty} aria-pressed={selected === path} onClick={() => void open(path)}><FileText size={14} /> {path}</button>)}</div> : null}
    {selected && content !== null ? <div className="sandbox-notes-preview"><div className="sandbox-notes-preview-heading"><strong>{selected}</strong>
      {editing ? <div className="sandbox-notes-actions"><button type="button" disabled={busy || !dirty} onClick={() => void save()}>保存到 Git</button><button type="button" disabled={busy} onClick={cancel}>取消</button></div>
        : <div className="sandbox-notes-actions"><button type="button" disabled={busy} onClick={() => setEditing(true)}>编辑文件</button>
          <button type="button" disabled={busy} onClick={() => void remove()}><Trash2 size={13} /> 移除</button></div>}</div>
      {editing ? <><label htmlFor="sandbox-note-draft" className="sr-only">笔记内容</label><textarea id="sandbox-note-draft" value={draft} onChange={event => {
        const next = event.target.value;
        setDraft(next);
        if (revision) rememberNote(draftKey, next === content ? null : { path: selected, content, revision, draft: next });
      }} disabled={busy} />
        {error ? <button type="button" onClick={() => void navigator.clipboard.writeText(draft)} className="sandbox-notes-copy">复制当前草稿</button> : null}</>
        : <><form onSubmit={event => { event.preventDefault(); void move(); }}>
          <label htmlFor="sandbox-note-move-path" className="sr-only">重命名或移动到路径</label>
          <input id="sandbox-note-move-path" value={movePath} onChange={event => setMovePath(event.target.value)}
            placeholder="目录/新文件名.md" disabled={busy} />
          <button type="submit" disabled={busy || !movePath.trim() || movePath.trim() === selected}>重命名/移动</button>
        </form><pre>{content}</pre></>}</div> : null}
  </section>;
}

function SandboxGraphMap({ graph, selected, busy, open }: {
  graph: SandboxNoteGraph; selected: string | null; busy: boolean; open: (path: string) => Promise<void>;
}) {
  const counts = new Map(graph.nodes.map(node => [node, 0]));
  for (const edge of graph.edges) {
    counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1);
    counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1);
  }
  const neighbors = selected
    ? new Set(graph.edges.filter(edge => edge.source === selected || edge.target === selected)
      .map(edge => edge.source === selected ? edge.target : edge.source))
    : null;
  const shown = selected && graph.nodes.includes(selected)
    ? [selected, ...graph.nodes.filter(node => neighbors?.has(node)).sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0)).slice(0, 17)]
    : [...graph.nodes].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0)).slice(0, 18);
  if (!shown.length) return null;
  const positions = new Map(shown.map((node, index) => {
    const angle = 2 * Math.PI * (index - (selected ? 1 : 0)) / (selected ? Math.max(1, shown.length - 1) : shown.length);
    return [node, selected && index === 0 ? [260, 155] : [260 + 200 * Math.cos(angle), 155 + 120 * Math.sin(angle)]] as const;
  }));
  return <svg viewBox="0 0 520 310" role="group" aria-label="笔记链接图，点击节点可打开笔记">
    {graph.edges.filter(edge => positions.has(edge.source) && positions.has(edge.target)).map(edge => {
      const [x1, y1] = positions.get(edge.source)!;
      const [x2, y2] = positions.get(edge.target)!;
      return <line key={`${edge.source}\0${edge.target}`} x1={x1} y1={y1} x2={x2} y2={y2} className="sandbox-notes-graph-line" />;
    })}
    {shown.map(node => {
      const [x, y] = positions.get(node)!;
      return <g key={node} transform={`translate(${x} ${y})`}>
        <circle r={node === selected ? 11 : 7} className={node === selected ? 'is-selected' : ''} />
        <text y="-15" textAnchor="middle">{node.length > 20 ? `${node.slice(0, 17)}…` : node}</text>
        <title>{node}</title>
        <circle r="16" className="sandbox-notes-graph-target" onClick={() => { if (!busy) void open(node); }}
          onKeyDown={event => { if (!busy && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); void open(node); } }}
          role="button" tabIndex={busy ? -1 : 0} aria-label={`打开 ${node}`} aria-disabled={busy} />
      </g>;
    })}
  </svg>;
}
