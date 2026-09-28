import { useEffect, useRef, useState, type FormEvent } from 'react';
import { FilePlus2, LockKeyhole, RefreshCw } from 'lucide-react';
import { listEntries, type Entry } from '../lib/library';
import { copyLegacyMarkdownNote } from '../lib/private-note-import';
import { VaultError } from '../lib/sealed-vault';
import { createPrivateNote, deletePrivateNote, listPrivateNotes, readPrivateNote, renamePrivateNote, retryPrivateNoteCleanup, updatePrivateNote, type PrivateNotebook } from '../lib/private-notes';
import { unlockRemoteWorkspace, workspaceVerification } from '../lib/workspace-vault';
import './sandbox-notes.css';

type Draft = { id: string; body: string; revision: string; draft: string };
const drafts = new Map<string, Draft>();
function warnUnload(event: BeforeUnloadEvent) {
  event.preventDefault();
  event.returnValue = '';
}
function remember(key: string, draft: Draft | null) {
  if (draft) drafts.set(key, draft);
  else drafts.delete(key);
  if (drafts.size) window.addEventListener('beforeunload', warnUnload);
  else window.removeEventListener('beforeunload', warnUnload);
}
export function hasPrivateDrafts() {
  return drafts.size > 0;
}
export function clearPrivateDrafts() {
  drafts.clear();
  window.removeEventListener('beforeunload', warnUnload);
}

function message(error: unknown) {
  if (error instanceof VaultError && error.message === 'private_import_exists') return '这篇旧笔记已复制过；请刷新目录核对，不要重复导入。';
  if (error instanceof VaultError && error.message === 'private_import_unverified') return '密文已写入，但回读核对失败。请刷新目录核对，不要重复导入；旧笔记未删除。';
  if (error instanceof VaultError && error.status === 409) return '远端版本已更新，本地草稿未覆盖。请复制草稿，刷新后核对。';
  if (error instanceof VaultError && error.status === 413) return '笔记超出当前加密对象容量，草稿仍在此标签页中。';
  if (error instanceof VaultError && error.message === 'vault_decryption_failed') return '口令不正确，或密文已损坏。';
  return '私密笔记暂时不可用，请检查连接；草稿仍在此标签页中。';
}

export function PrivateNotebook({ ownerId, workspaceId }: { ownerId: string; workspaceId: string }) {
  const key = `${ownerId}:${workspaceId}`;
  const [restored] = useState(() => drafts.get(key));
  const [available, setAvailable] = useState<boolean | 'unavailable' | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [input, setInput] = useState('');
  const [notebook, setNotebook] = useState<PrivateNotebook | null>(null);
  const [selectedId, setSelectedId] = useState(restored?.id ?? '');
  const [body, setBody] = useState<string | null>(restored?.body ?? null);
  const [revision, setRevision] = useState(restored?.revision ?? '');
  const [draft, setDraft] = useState(restored?.draft ?? '');
  const [title, setTitle] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [legacyNotes, setLegacyNotes] = useState<Entry[] | null>(null);
  const [legacyId, setLegacyId] = useState('');
  const [importStatus, setImportStatus] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [editing, setEditing] = useState(Boolean(restored));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    let active = true;
    void workspaceVerification().then(value => { if (active) setAvailable(value === 'remote'); })
      .catch(() => { if (active) setAvailable('unavailable'); });
    return () => { active = false; pending.current?.abort(); };
  }, []);
  const dirty = editing && body !== null && draft !== body;
  const orphaned = notebook !== null && body !== null && selectedId !== '' &&
    !notebook.notes.some(note => note.id === selectedId);
  const start = () => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    return controller;
  };
  async function unlock(event: FormEvent) {
    event.preventDefault();
    if (!input || busy) return;
    const controller = start();
    try {
      await unlockRemoteWorkspace(ownerId, workspaceId, input);
      const result = await retryPrivateNoteCleanup(workspaceId, input,
        await listPrivateNotes(workspaceId, input, controller.signal), controller.signal);
      if (!controller.signal.aborted) {
        setPassphrase(input);
        setInput('');
        setNotebook(result);
        if (restored && !result.notes.some(note => note.id === restored.id)) {
          setError('远端目录已移除这篇笔记。本地草稿仅保留在此标签页，请先复制备份，不要关闭页面。');
        }
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(message(cause));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function refresh() {
    if (!passphrase || dirty) return;
    const controller = start();
    try {
      const result = await retryPrivateNoteCleanup(workspaceId, passphrase,
        await listPrivateNotes(workspaceId, passphrase, controller.signal), controller.signal);
      if (!controller.signal.aborted) {
        setNotebook(result);
        setSelectedId('');
        setBody(null);
        setRevision('');
        setEditing(false);
        setRenaming(false);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(message(cause));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function open(id: string) {
    if (!passphrase || busy || dirty && !window.confirm('放弃当前未保存的私密笔记草稿？')) return;
    const controller = start();
    try {
      const result = await readPrivateNote(workspaceId, id, passphrase, controller.signal);
      if (!controller.signal.aborted) {
        remember(key, null);
        setSelectedId(id);
        setBody(result.body);
        setDraft(result.body);
        setRevision(result.revision);
        setEditing(false);
        setRenaming(false);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(message(cause));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    if (!passphrase || !notebook || busy || !title.trim() || dirty && !window.confirm('放弃当前未保存的私密笔记草稿？')) return;
    const controller = start();
    try {
      const result = await createPrivateNote(workspaceId, passphrase, title, '', notebook, controller.signal);
      if (!controller.signal.aborted) {
        remember(key, null);
        setNotebook(result.notebook);
        setSelectedId(result.id);
        setBody('');
        setDraft('');
        setRevision(result.contentRevision);
        setEditing(true);
        setTitle('');
        setRenaming(false);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(message(cause));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function loadLegacy() {
    if (!notebook || busy || dirty) return;
    const controller = start();
    setImportStatus('');
    try {
      const entries = await listEntries(workspaceId, controller.signal);
      if (!controller.signal.aborted) {
        const available = entries.filter(entry => entry.kind === 'note' && entry.title.trim() &&
          !notebook.notes.some(note => note.legacy_entry_id === entry.id));
        setLegacyNotes(available);
        setLegacyId(available[0]?.id ?? '');
      }
    } catch {
      if (!controller.signal.aborted) setError('旧笔记列表读取失败，未复制任何内容。');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function importLegacy(event: FormEvent) {
    event.preventDefault();
    if (!passphrase || !notebook || !legacyId || busy || dirty ||
      !window.confirm('仅复制这篇旧 Markdown 到私密笔记；原件仍以明文留在旧资料库，确定继续？')) return;
    const controller = start();
    setImportStatus('');
    try {
      const result = await copyLegacyMarkdownNote(workspaceId, legacyId, passphrase, notebook, controller.signal);
      if (!controller.signal.aborted) {
        setNotebook(result.notebook);
        setLegacyNotes(current => current?.filter(entry => entry.id !== legacyId) ?? null);
        setLegacyId('');
        setSelectedId(result.id);
        setBody(result.body);
        setDraft(result.body);
        setRevision(result.contentRevision);
        setEditing(false);
        setImportStatus('密文已回读核对。旧笔记仍在原资料库，未删除或加密原件。');
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof VaultError ? message(cause) :
        '复制未确认成功。旧笔记未删除，请刷新私密目录核对后再试。');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function save() {
    if (!passphrase || !selectedId || !revision || !dirty || orphaned || busy) return;
    const controller = start();
    try {
      const next = await updatePrivateNote(workspaceId, selectedId, passphrase, draft, revision, controller.signal);
      if (!controller.signal.aborted) {
        remember(key, null);
        setBody(draft);
        setRevision(next);
        setEditing(false);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(message(cause));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function rename(event: FormEvent) {
    event.preventDefault();
    if (!passphrase || !notebook || !selectedId || !newTitle.trim() || dirty || orphaned || busy) return;
    const controller = start();
    try {
      const updated = await renamePrivateNote(workspaceId, selectedId, passphrase, newTitle, notebook, controller.signal);
      if (!controller.signal.aborted) {
        setNotebook(updated);
        setRenaming(false);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(message(cause));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function remove() {
    if (!passphrase || !notebook || !selectedId || !revision || dirty || orphaned || busy ||
      !window.confirm('从笔记列表移除并删除当前密文对象？Git 历史中的旧密文仍可能保留。')) return;
    const controller = start();
    try {
      const updated = await deletePrivateNote(workspaceId, selectedId, passphrase, notebook, revision, controller.signal);
      if (!controller.signal.aborted) {
        remember(key, null);
        setNotebook(updated);
        setSelectedId('');
        setBody(null);
        setDraft('');
        setRevision('');
        setRenaming(false);
        setEditing(false);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(message(cause));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return <section className="private-notebook" aria-label="私密笔记">
    <h2><LockKeyhole size={18} /> 私密笔记</h2>
    <p>标题和正文在你的设备上加密，服务器只保存密文，Agent 也读不到这里的内容。删除笔记后，历史版本里的密文仍会保留；复制普通笔记进来不会影响原笔记。</p>
    {error ? <p role="alert" className="sandbox-notes-error">{error}</p> : null}
    {available === null ? <p role="status">正在检查加密仓库…</p>
      : available === 'unavailable' ? <p role="alert">无法检查加密仓库状态，请刷新后重试；不会回退到明文存储。</p>
      : !available ? <p>私密笔记暂时不可用；为保护隐私，这里不会改用明文保存。</p>
        : !notebook ? <form onSubmit={event => void unlock(event)}>
          <label htmlFor="private-notebook-key">再次输入工作区口令以解密私密笔记</label>
          <input id="private-notebook-key" type="password" autoComplete="off" value={input}
            onChange={event => setInput(event.target.value)} disabled={busy} />
          <button type="submit" disabled={busy || !input}>{busy ? '正在解锁…' : '解锁私密笔记'}</button>
        </form> : <>
          <div className="private-notebook-toolbar"><span>{notebook.notes.length} 篇加密笔记</span>
            <button type="button" disabled={busy || dirty} onClick={() => void refresh()}><RefreshCw size={14} /> 刷新</button></div>
          {notebook.pendingDeletes.length ? <p role="status">
            {notebook.pendingDeletes.length} 篇已从目录移除，密文清理尚未完成；不会将其视为彻底删除。
            <button type="button" disabled={busy || dirty} onClick={() => void refresh()}>重试密文清理</button>
          </p> : null}
          <form onSubmit={event => void create(event)}>
            <label htmlFor="private-notebook-title">新笔记标题</label>
            <input id="private-notebook-title" value={title} maxLength={80} disabled={busy}
              onChange={event => setTitle(event.target.value)} />
            <button type="submit" disabled={busy || !title.trim() || notebook.notes.length >= 200}>
              <FilePlus2 size={14} /> 新建私密笔记
            </button>
          </form>
          <div className="private-notebook-import">
            <button type="button" disabled={busy || dirty || notebook.notes.length >= 200}
              onClick={() => void loadLegacy()}>查看可复制的旧 Markdown</button>
            {legacyNotes ? <form onSubmit={event => void importLegacy(event)}>
              <label htmlFor="private-notebook-legacy">选择一篇旧资料库笔记</label>
              <select id="private-notebook-legacy" value={legacyId} disabled={busy || dirty}
                onChange={event => setLegacyId(event.target.value)}>
                {!legacyId ? <option value="">请选择笔记</option> : null}
                {legacyNotes.map(entry => <option key={entry.id} value={entry.id}>{entry.title}</option>)}
              </select>
              <button type="submit" disabled={busy || dirty || !legacyId || notebook.notes.length >= 200}>
                复制并核对密文
              </button>
              {!legacyNotes.length ? <span>没有可复制的旧 Markdown。</span> : null}
            </form> : null}
            {importStatus ? <p role="status">{importStatus}</p> : null}
          </div>
          <div className="private-notebook-list">{notebook.notes.map(note =>
            <button type="button" key={note.id} aria-pressed={selectedId === note.id}
              disabled={busy} onClick={() => void open(note.id)}>{note.title}</button>)}</div>
          {body !== null && selectedId ? <div className="private-notebook-editor">
            <div><strong>{notebook.notes.find(note => note.id === selectedId)?.title ?? '已从远端目录移除的草稿'}</strong>
              {editing ? <button type="button" disabled={busy || !dirty || orphaned} onClick={() => void save()}>保存密文</button>
                : <button type="button" disabled={busy} onClick={() => setEditing(true)}>编辑笔记</button>}</div>
            {renaming ? <form onSubmit={event => void rename(event)}>
              <label htmlFor="private-note-rename">修改私密笔记标题</label>
              <input id="private-note-rename" value={newTitle} maxLength={80} disabled={busy}
                onChange={event => setNewTitle(event.target.value)} />
              <button type="submit" disabled={busy || !newTitle.trim() || dirty || orphaned}>保存标题</button>
              <button type="button" disabled={busy} onClick={() => setRenaming(false)}>取消改名</button>
            </form> : <button type="button" disabled={busy || dirty || orphaned} onClick={() => {
              setNewTitle(notebook.notes.find(note => note.id === selectedId)?.title ?? '');
              setRenaming(true);
            }}>修改标题</button>}
            <button type="button" disabled={busy || dirty || orphaned || renaming}
              onClick={() => void remove()}>删除私密笔记</button>
            {editing ? <><label htmlFor="private-notebook-body" className="sr-only">私密笔记正文</label>
                <textarea id="private-notebook-body" disabled={busy} value={draft} onChange={event => {
                  const next = event.target.value;
                  setDraft(next);
                  remember(key, next === body ? null : { id: selectedId, body, revision, draft: next });
                }} />
                {error || orphaned ? <button type="button" onClick={() => void navigator.clipboard.writeText(draft)}>复制草稿</button> : null}</>
              : <pre>{body}</pre>}
          </div> : null}
        </>}
  </section>;
}
