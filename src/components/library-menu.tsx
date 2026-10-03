import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Download, LibraryBig, Pencil, Settings2, Trash2, Upload, X } from 'lucide-react';
import { useSheetGesture } from '../lib/use-sheet-gesture';
import './library-menu.css';

type Mode = 'menu' | 'rename' | 'delete';

/**
 * The library's own menu, opened from its name in the sidebar: rename it in
 * place, export it as a ZIP, import Markdown or a ZIP, or delete it after
 * typing its name. A popover on a computer, a bottom sheet on a phone.
 */
export function LibraryMenu({ name, noteCount, fileCount, folderCount, anchor, onClose, onRename, onExport, onImport, onDelete, onOpenSettings }: {
  name: string;
  noteCount: number;
  fileCount: number;
  folderCount: number;
  anchor: DOMRect | null;
  onClose: () => void;
  onRename: (name: string) => Promise<void>;
  onExport: (progress: (done: number, total: number) => void) => Promise<number>;
  onImport: (files: File[], progress: (done: number, total: number) => void) => Promise<string>;
  onDelete: () => Promise<void>;
  onOpenSettings: () => void;
}) {
  const [mode, setMode] = useState<Mode>('menu');
  const [draft, setDraft] = useState(name);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const veilRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const phone = typeof window !== 'undefined' && window.innerWidth <= 720;
  useSheetGesture({ sheet: sheetRef, veil: veilRef, enabled: phone && !busy, onClose });

  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [busy, onClose]);

  async function run(label: string, task: () => Promise<void>) {
    setBusy(label); setError(''); setMessage('');
    try { await task(); } catch { setError(`${label}失败，请稍后重试。`); } finally { setBusy(''); }
  }

  function rename(event: FormEvent) {
    event.preventDefault();
    const next = draft.trim();
    if (!next || next === name) { setMode('menu'); return; }
    void run('重命名', async () => { await onRename(next); setMode('menu'); setMessage('已重命名。'); });
  }

  const progress = (verb: string) => (done: number, total: number) => setBusy(`${verb} ${done}/${total}`);

  const position = !phone && anchor ? { left: Math.max(8, anchor.left), top: anchor.bottom + 6 } : undefined;
  return <div ref={veilRef} className="library-menu-veil" onPointerDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div ref={sheetRef} className="library-menu" role="dialog" aria-modal="true" aria-label="管理知识库" style={position}>
      <div className="library-menu-grip" data-sheet-handle aria-hidden="true" />
      <header className="library-menu-head" data-sheet-handle>
        <span className="library-menu-icon" aria-hidden="true"><LibraryBig size={18} /></span>
        <div><strong>{name}</strong><span>{noteCount} 篇笔记 · {fileCount - noteCount > 0 ? `${fileCount - noteCount} 个文件 · ` : ''}{folderCount} 个文件夹</span></div>
        <button type="button" className="library-menu-close" aria-label="关闭" disabled={Boolean(busy)} onClick={onClose}><X size={16} /></button>
      </header>

      {mode === 'rename' ? <form className="library-menu-form" onSubmit={rename}>
        <label><span>知识库名称</span><input autoFocus value={draft} maxLength={80} onChange={event => setDraft(event.target.value)} /></label>
        <div className="library-menu-actions">
          <button type="button" onClick={() => { setMode('menu'); setDraft(name); }}>取消</button>
          <button type="submit" className="is-primary" disabled={Boolean(busy) || !draft.trim()}>保存</button>
        </div>
      </form> : mode === 'delete' ? <form className="library-menu-form" onSubmit={event => { event.preventDefault(); if (confirm === name) void run('删除', onDelete); }}>
        <p className="library-menu-warning">删除后，知识库里的全部笔记、文件、文件夹和会话都会永久删除，无法恢复。建议先导出备份。</p>
        <label><span>输入「{name}」确认删除</span><input autoFocus value={confirm} onChange={event => setConfirm(event.target.value)} /></label>
        <div className="library-menu-actions">
          <button type="button" onClick={() => { setMode('menu'); setConfirm(''); }}>取消</button>
          <button type="submit" className="is-danger" disabled={Boolean(busy) || confirm !== name}>永久删除</button>
        </div>
      </form> : <div className="library-menu-list" role="menu">
        <button type="button" role="menuitem" disabled={Boolean(busy)} onClick={() => { setDraft(name); setMode('rename'); }}><Pencil size={16} /><span>重命名</span></button>
        <button type="button" role="menuitem" disabled={Boolean(busy)} onClick={() => void run('导出', async () => {
          const count = await onExport(progress('正在导出'));
          setMessage(`已导出 ${count} 项，ZIP 文件已开始下载。`);
        })}><Download size={16} /><span>导出为 ZIP</span><small>Markdown 笔记与原始文件</small></button>
        <button type="button" role="menuitem" disabled={Boolean(busy)} onClick={() => fileRef.current?.click()}><Upload size={16} /><span>导入</span><small>Markdown、文本或 ZIP</small></button>
        <input ref={fileRef} type="file" hidden multiple accept=".md,.markdown,.txt,.zip,text/markdown,text/plain,application/zip" aria-label="选择要导入的文件" onChange={event => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (files.length) void run('导入', async () => setMessage(await onImport(files, progress('正在导入'))));
        }} />
        <button type="button" role="menuitem" disabled={Boolean(busy)} onClick={onOpenSettings}><Settings2 size={16} /><span>知识库设置</span></button>
        <div className="library-menu-rule" />
        <button type="button" role="menuitem" className="is-danger" disabled={Boolean(busy)} onClick={() => { setConfirm(''); setMode('delete'); }}><Trash2 size={16} /><span>删除知识库</span></button>
      </div>}

      {busy ? <p className="library-menu-status" role="status">{busy.includes('/') ? busy : `正在${busy}…`}</p>
        : error ? <p className="library-menu-status is-error" role="alert">{error}</p>
          : message ? <p className="library-menu-status" role="status">{message}</p> : null}
    </div>
  </div>;
}
