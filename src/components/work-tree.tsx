import { useState, type FormEvent, type ReactNode } from 'react';
import { ChevronRight, Cloud, Folder, FolderGit2, FolderPlus, Laptop, MoreHorizontal, Plus } from 'lucide-react';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { CLOUD_HOST, createWorkFolder, createWorkProject, deleteWorkFolder, deleteWorkProject, describeWorkError, renameWorkFolder, updateWorkProject,
  type SessionPlace, type WorkFolder, type WorkHost, type WorkLayout, type WorkProject } from '../lib/work';
import { storedJSON, storeItem } from '../lib/safe-storage';
import './work-tree.css';

export interface WorkConversation { id: string; title?: string; host?: string; projectId?: string; folderId?: string }

const OPEN_KEY = 'tjuclaw.work.open.v1';

/**
 * The work view's sidebar: hosts, each with its project folders and the
 * conversations that run there, then the folders the user made. Rows are
 * drawn by the caller, so a conversation keeps its usual actions.
 */
export function WorkTree({ hosts, layout, onLayoutChange, conversations, renderConversation, onNewChat, onError }: {
  hosts: WorkHost[];
  layout: WorkLayout;
  onLayoutChange: (layout: WorkLayout) => void;
  conversations: WorkConversation[];
  renderConversation: (conversation: WorkConversation, depth: number) => ReactNode;
  onNewChat: (place: SessionPlace) => void;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>(() => storedJSON(OPEN_KEY, { [`host:${CLOUD_HOST}`]: true }));
  const [creatingProject, setCreatingProject] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);

  const isOpen = (key: string, fallback = true) => open[key] ?? fallback;
  const toggle = (key: string, fallback = true) => setOpen(current => {
    const next = { ...current, [key]: !(current[key] ?? fallback) };
    storeItem(localStorage, OPEN_KEY, JSON.stringify(next));
    return next;
  });

  const projectIds = new Set(layout.projects.map(project => project.id));
  const folderIds = new Set(layout.folders.map(folder => folder.id));
  const hostIds = new Set(hosts.map(host => host.id));
  // A conversation whose folder, project or host is gone shows where it can.
  const folderOf = (item: WorkConversation) => item.folderId && folderIds.has(item.folderId) ? item.folderId : '';
  const hostOf = (item: WorkConversation) => item.host && hostIds.has(item.host) ? item.host : CLOUD_HOST;
  const projectOf = (item: WorkConversation) => item.projectId && projectIds.has(item.projectId) ? item.projectId : '';

  async function act(task: () => Promise<void>) {
    try { await task(); } catch (error) { onError(describeWorkError(error)); }
  }

  async function addFolder() {
    await act(async () => {
      const folder = await createWorkFolder('新建文件夹');
      onLayoutChange({ ...layout, folders: [...layout.folders, folder] });
      setOpen(current => ({ ...current, [`folder:${folder.id}`]: true }));
      setEditing(`folder:${folder.id}`);
    });
  }

  async function rename(kind: 'project' | 'folder', id: string, name: string) {
    setEditing(null);
    const trimmed = name.trim();
    if (!trimmed) return;
    await act(async () => {
      if (kind === 'project') {
        if (layout.projects.find(project => project.id === id)?.name === trimmed) return;
        const project = await updateWorkProject(id, { name: trimmed });
        onLayoutChange({ ...layout, projects: layout.projects.map(item => item.id === id ? project : item) });
      } else {
        if (layout.folders.find(folder => folder.id === id)?.name === trimmed) return;
        const folder = await renameWorkFolder(id, trimmed);
        onLayoutChange({ ...layout, folders: layout.folders.map(item => item.id === id ? folder : item) });
      }
    });
  }

  async function remove(kind: 'project' | 'folder', item: WorkProject | WorkFolder) {
    setMenu(null);
    const what = kind === 'project' ? '项目' : '文件夹';
    if (!window.confirm(`删除${what}「${item.name}」？其中的会话会保留${kind === 'project' ? '，显示在所在主机下' : '，回到所在主机下'}。`)) return;
    await act(async () => {
      if (kind === 'project') {
        await deleteWorkProject(item.id);
        onLayoutChange({ ...layout, projects: layout.projects.filter(project => project.id !== item.id) });
      } else {
        await deleteWorkFolder(item.id);
        onLayoutChange({ ...layout, folders: layout.folders.filter(folder => folder.id !== item.id) });
      }
    });
  }

  const nameInput = (kind: 'project' | 'folder', id: string, value: string) =>
    <input className="tree-inline-input work-name-input" autoFocus defaultValue={value} maxLength={60} aria-label={kind === 'project' ? '项目名称' : '文件夹名称'}
      onFocus={event => event.currentTarget.select()} onBlur={event => void rename(kind, id, event.currentTarget.value)}
      onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { event.stopPropagation(); setEditing(null); } }} />;

  const rowMenu = (key: string, label: string, items: [string, () => void][]) => <span className="work-row-menu">
    <button type="button" className="work-row-action" aria-label={`「${label}」的操作`} aria-expanded={menu === key} onClick={() => setMenu(current => current === key ? null : key)}><MoreHorizontal size={14} /></button>
    {menu === key ? <span className="work-menu" role="menu">{items.map(([name, run]) => <button key={name} type="button" role="menuitem" className={name === '删除' ? 'is-danger' : ''} onClick={() => { setMenu(null); run(); }}>{name}</button>)}</span> : null}
  </span>;

  // Each level steps in 22px: a child's icon sits under its parent's label.
  const empty = (text: string, depth: number) => <p className="work-empty" style={{ paddingLeft: 22 + depth * 22 }}>{text}</p>;

  function projectNode(project: WorkProject) {
    const key = `project:${project.id}`;
    const items = conversations.filter(item => !folderOf(item) && projectOf(item) === project.id);
    return <div className="work-node" key={project.id}>
      <div className="work-row work-row-project" style={{ paddingLeft: 22 }}>
        <button type="button" className="work-row-main" aria-expanded={isOpen(key, false)} onClick={() => toggle(key, false)} title={project.path || undefined}>
          <ChevronRight size={13} className="work-chevron" data-open={isOpen(key, false) ? 'true' : 'false'} aria-hidden="true" />
          <FolderGit2 size={15} aria-hidden="true" />
          {editing === key ? null : <span className="work-row-label">{project.name}</span>}
          {editing !== key && items.length ? <small className="work-count">{items.length}</small> : null}
        </button>
        {editing === key ? nameInput('project', project.id, project.name) : <>
          <button type="button" className="work-row-action" aria-label={`在「${project.name}」中新建对话`} title="在此项目中新建对话" onClick={() => onNewChat({ host: project.host, project_id: project.id })}><Plus size={14} /></button>
          {rowMenu(key, project.name, [['重命名', () => setEditing(key)], ['删除', () => void remove('project', project)]])}
        </>}
      </div>
      {isOpen(key, false) ? <div className="work-children">{items.length ? items.map(item => renderConversation(item, 2)) : empty('还没有对话', 2)}</div> : null}
    </div>;
  }

  return <div className="work-tree">
    <div className="work-section-head">
      <span>主机</span>
      <button type="button" className="work-head-action" aria-label="新建项目" title="新建项目" onClick={() => setCreatingProject(hosts[0]?.id ?? CLOUD_HOST)}><FolderGit2 size={15} /></button>
    </div>
    {hosts.map(host => {
      const key = `host:${host.id}`;
      const projects = layout.projects.filter(project => project.host === host.id);
      const loose = conversations.filter(item => !folderOf(item) && hostOf(item) === host.id && !projectOf(item));
      const Icon = host.kind === 'cloud' ? Cloud : Laptop;
      return <div className="work-node" key={host.id}>
        <div className="work-row work-row-host">
          <button type="button" className="work-row-main" aria-expanded={isOpen(key, host.id === CLOUD_HOST)} onClick={() => toggle(key, host.id === CLOUD_HOST)}>
            <ChevronRight size={13} className="work-chevron" data-open={isOpen(key, host.id === CLOUD_HOST) ? 'true' : 'false'} aria-hidden="true" />
            <Icon size={15} aria-hidden="true" />
            <span className="work-row-label">{host.name}</span>
            {host.kind === 'computer' ? <span className={`work-status${host.online ? ' is-online' : ''}`} aria-label={host.online ? '在线' : '离线'} /> : null}
          </button>
          <button type="button" className="work-row-action" aria-label={`在「${host.name}」新建项目`} title="新建项目" onClick={() => setCreatingProject(host.id)}><FolderPlus size={14} /></button>
          <button type="button" className="work-row-action" aria-label={`在「${host.name}」新建对话`} title="新建对话" onClick={() => onNewChat({ host: host.id, project_id: '', folder_id: '' })}><Plus size={14} /></button>
        </div>
        {isOpen(key, host.id === CLOUD_HOST) ? <div className="work-children">
          {projects.map(projectNode)}
          {loose.map(item => renderConversation(item, 1))}
          {!projects.length && !loose.length ? empty(host.kind === 'cloud' ? '在云端开始的对话会出现在这里' : '这台电脑上还没有项目或对话', 1) : null}
        </div> : null}
      </div>;
    })}

    <div className="work-section-head">
      <span>文件夹</span>
      <button type="button" className="work-head-action" aria-label="新建会话文件夹" title="新建文件夹" onClick={() => void addFolder()}><FolderPlus size={15} /></button>
    </div>
    {layout.folders.length ? layout.folders.map(folder => {
      const key = `folder:${folder.id}`;
      const items = conversations.filter(item => folderOf(item) === folder.id);
      return <div className="work-node" key={folder.id}>
        <div className="work-row">
          <button type="button" className="work-row-main" aria-expanded={isOpen(key)} onClick={() => toggle(key)}>
            <ChevronRight size={13} className="work-chevron" data-open={isOpen(key) ? 'true' : 'false'} aria-hidden="true" />
            <Folder size={15} aria-hidden="true" />
            {editing === key ? null : <span className="work-row-label">{folder.name}</span>}
            {editing !== key && items.length ? <small className="work-count">{items.length}</small> : null}
          </button>
          {editing === key ? nameInput('folder', folder.id, folder.name) : rowMenu(key, folder.name, [['重命名', () => setEditing(key)], ['删除', () => void remove('folder', folder)]])}
        </div>
        {isOpen(key) ? <div className="work-children">{items.length ? items.map(item => renderConversation(item, 1)) : empty('把对话移到这里来整理', 1)}</div> : null}
      </div>;
    }) : empty('用文件夹整理不属于某个项目的对话', 0)}

    {creatingProject ? <NewProjectDialog hosts={hosts} initialHost={creatingProject} onClose={() => setCreatingProject(null)} onCreated={project => {
      onLayoutChange({ ...layout, projects: [...layout.projects, project] });
      setOpen(current => ({ ...current, [`host:${project.host}`]: true, [`project:${project.id}`]: true }));
      setCreatingProject(null);
    }} /> : null}
  </div>;
}

/** Names a project and, on a computer, the directory the Agent works in. */
function NewProjectDialog({ hosts, initialHost, onClose, onCreated }: { hosts: WorkHost[]; initialHost: string; onClose: () => void; onCreated: (project: WorkProject) => void }) {
  const [host, setHost] = useState(initialHost);
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const computer = host !== CLOUD_HOST;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError('');
    try { onCreated(await createWorkProject({ host, name: name.trim(), ...(computer ? { path: path.trim() } : {}) })); }
    catch (cause) { setError(describeWorkError(cause)); }
    finally { setBusy(false); }
  }

  return <Dialog open onOpenChange={next => { if (!next) onClose(); }}>
    <DialogContent className="work-project-dialog">
      <DialogTitle>新建项目</DialogTitle>
      <DialogDescription>{computer ? '项目对应这台电脑上的一个文件夹，在项目里开始的对话，Agent 会在这个文件夹中读写文件和运行命令。' : '云端项目在沙箱中拥有自己的工作目录，项目里的对话共用这些文件。'}</DialogDescription>
      <form onSubmit={submit}>
        <label><span>主机</span>
          <select value={host} onChange={event => setHost(event.target.value)}>{hosts.map(item => <option key={item.id} value={item.id}>{item.name}{item.kind === 'computer' && !item.online ? '（离线）' : ''}</option>)}</select>
        </label>
        <label><span>项目名称</span><input autoFocus required maxLength={60} value={name} onChange={event => setName(event.target.value)} placeholder="例如 课程设计" /></label>
        {computer ? <label><span>文件夹路径</span><input required maxLength={512} spellCheck={false} value={path} onChange={event => setPath(event.target.value)} placeholder="/home/me/projects/课程设计 或 C:\\Users\\me\\课程设计" /></label> : null}
        {error ? <p className="work-dialog-error" role="alert">{error}</p> : null}
        <div className="work-dialog-actions">
          <DialogClose asChild><button type="button">取消</button></DialogClose>
          <button type="submit" className="is-primary" disabled={busy || !name.trim() || (computer && !path.trim())}>{busy ? '正在创建…' : '创建项目'}</button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}
