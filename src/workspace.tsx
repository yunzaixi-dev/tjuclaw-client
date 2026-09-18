import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Bot, ChevronRight, File, FileText, Loader2, Monitor, Moon, PanelLeft, Plus, Search, Send, Settings, Share2, Store, Sun, Trash2, Upload } from 'lucide-react';
import { BrandIcon } from './components/brand-icon';
import { Button } from './components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './components/ui/dialog';
import { setAppearance, useAppearance } from './lib/appearance';
import { setContestBannerOpen, useContestBannerOpen } from './contest-banner';
import { AuthError, logout, readSession, type IdentitySession } from './lib/auth';
import {
  clearModel,
  createEntry,
  createLibrary,
  createSession,
  deleteEntry,
  deleteLibrary,
  describeLibraryError,
  downloadFile,
  getEntry,
  getModel,
  getSession,
  listEntries,
  listLibraries,
  listMarket,
  listPublications,
  listSessions,
  patchEntry,
  publishLibrary,
  putModel,
  renameLibrary,
  searchNotes,
  sendMessage,
  subscribePublication,
  uploadFile,
  withdrawPublication,
  type ChatSession,
  type Entry,
  type Library,
  type ModelStatus,
  type Publication,
  type SearchHit,
} from './lib/library';

import './product.css';
import './workspace.css';

function isUnauthorized(error: unknown) {
  return error instanceof AuthError && error.status === 401;
}

export default function Workspace() {
  const appearance = useAppearance();
  const bannerOpen = useContestBannerOpen();
  const [session, setSession] = useState<IdentitySession | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [libraryId, setLibraryId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Entry | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [chat, setChat] = useState<ChatSession | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [model, setModel] = useState<ModelStatus | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [modelName, setModelName] = useState('');
  const [newLibraryName, setNewLibraryName] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  const [marketOpen, setMarketOpen] = useState(false);
  const [market, setMarket] = useState<Publication[]>([]);
  const [publications, setPublications] = useState<Publication[]>([]);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [saveStatus, setSaveStatus] = useState<'saving' | 'saved' | ''>('');
  const [filePreview, setFilePreview] = useState<{ id: string; url: string } | null>(null);




  const activeUserIdRef = useRef<string | null>(null);
  const closingRef = useRef(false);
  const sessionSeqRef = useRef(0);
  const saveTimer = useRef<number>(0);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  function resetPrivateState() {
    setLibraries([]);
    setEntries([]);
    setLibraryId(null);
    setSelectedId(null);
    setSelected(null);
    setTitle('');
    setBody('');
    setChat(null);
    setDraft('');
    setError('');
    setModel(null);
    setBaseUrl('');
    setApiKey('');
    setModelName('');
    setMarket([]);
    setPublications([]);
    setQuery('');
    setHits([]);
    setSaveStatus('');
    if (filePreview) URL.revokeObjectURL(filePreview.url);
    setFilePreview(null);

  }


  function fail(err: unknown) {
    setError(describeLibraryError(err));
    if (isUnauthorized(err)) {
      resetPrivateState();
      location.replace('/auth/login');
    }
  }

  async function loadWorkspace() {
    if (!activeUserIdRef.current) return;
    const user = activeUserIdRef.current;
    try {
      const libs = await listLibraries();
      if (user !== activeUserIdRef.current) return;
      setLibraries(libs);
      const current = libs.find(item => item.id === libraryId) ?? libs[0];
      try {
        setModel(await getModel());
      } catch (err) {
        if (user !== activeUserIdRef.current) return;
        fail(err);
      }
      if (!current) {
        setEntries([]);
        return;
      }
      setLibraryId(current.id);
      const tree = await listEntries(current.id);
      if (user !== activeUserIdRef.current) return;
      setEntries(tree);
      const nextId = selectedId && tree.some(item => item.id === selectedId) ? selectedId : tree[0]?.id ?? null;
      if (nextId) void openEntry(nextId);
    } catch (err) {
      if (user !== activeUserIdRef.current) return;
      fail(err);
    }
  }


  async function openEntry(id: string) {
    const user = activeUserIdRef.current;
    setSelectedId(id);
    try {
      const entry = await getEntry(id);
      if (user !== activeUserIdRef.current) return;
      setSelected(entry);
      setTitle(entry.title);
      setBody(entry.body ?? '');
      setError('');
      if (entry.kind === 'agent') {
        if (libraries.find(item => item.id === entry.library_id)?.role === 'subscribed') {
          setChat(null);
        } else {
          const sessions = await listSessions(id);
          if (user !== activeUserIdRef.current) return;
          const current = sessions[0] ?? await createSession(id);
          const full = current.messages ? current : await getSession(current.id);
          if (user !== activeUserIdRef.current) return;
          setChat(full);
        }
      } else {
        setChat(null);
      }

    } catch (err) {
      if (user !== activeUserIdRef.current) return;
      fail(err);
    }
  }
  useEffect(() => {
    let unmounted = false;
    let inFlight: AbortController | null = null;
    async function checkSession() {
      if (closingRef.current) return;
      inFlight?.abort();
      const controller = new AbortController();
      inFlight = controller;
      const seq = ++sessionSeqRef.current;
      try {
        const next = await readSession(controller.signal);
        if (unmounted || controller.signal.aborted || seq !== sessionSeqRef.current) return;
        if (!next) {
          resetPrivateState();
          location.replace('/auth/login');
          return;
        }
        const switched = activeUserIdRef.current !== next.id;
        if (activeUserIdRef.current && switched) resetPrivateState();
        activeUserIdRef.current = next.id;
        setSession(next);
        if (switched) void loadWorkspace();
      } catch {
        if (!unmounted && !controller.signal.aborted && seq === sessionSeqRef.current) {
          resetPrivateState();
          location.replace('/auth/login');
        }
      } finally {
        if (!unmounted && !controller.signal.aborted && seq === sessionSeqRef.current) setSessionLoading(false);
      }
    }
    void checkSession();
    const onVisible = () => { if (document.visibilityState === 'visible') void checkSession(); };
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(() => void checkSession(), 60000);
    return () => {
      unmounted = true;
      inFlight?.abort();
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer);
      resetPrivateState();
    };
  }, []);


  function queueSave(nextTitle: string, nextBody: string) {
    if (!selected || selected.kind === 'file') return;
    if (libraries.find(item => item.id === libraryId)?.role === 'subscribed') return;
    window.clearTimeout(saveTimer.current);
    setSaveStatus('saving');
    saveTimer.current = window.setTimeout(() => {
      const patch = selected.kind === 'agent' ? { title: nextTitle } : { title: nextTitle, body: nextBody };
      void patchEntry(selected.id, patch).then(entry => {
        if (activeUserIdRef.current) {
          setSelected(entry);
          setEntries(prev => prev.map(item => item.id === entry.id ? { ...item, title: entry.title } : item));
          setSaveStatus('saved');
        }
      }).catch(err => {
        setSaveStatus('');
        fail(err);
      });
    }, 500);
  }

  async function handleCreate(kind: 'note' | 'agent' | 'work_env') {
    if (!libraryId || busy || libraries.find(item => item.id === libraryId)?.role === 'subscribed') return;
    setBusy(true);
    try {
      const parent_id = selected?.kind === 'note' ? selected.id : undefined;
      const title = kind === 'agent' ? '未命名智能体' : kind === 'work_env' ? '未命名工作环境' : '未命名笔记';
      const entry = await createEntry(libraryId, { kind, title, parent_id });
      setEntries(prev => [...prev, entry]);
      await openEntry(entry.id);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }


  async function handleDelete() {
    if (!selected) return;
    try {
      await deleteEntry(selected.id);
      setSelected(null);
      setSelectedId(null);
      await loadWorkspace();
    } catch (err) {
      fail(err);
    }
  }

  async function handleChat(event: FormEvent) {
    event.preventDefault();
    if (!chat || busy || !draft.trim() || model?.source === 'none') return;
    const content = draft;
    setBusy(true);
    try {
      const next = await sendMessage(chat.id, content);
      if (activeUserIdRef.current) {
        setChat(next);
        setDraft('');
        await loadWorkspace();
      }
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }


  async function handleCreateLibrary(event: FormEvent) {
    event.preventDefault();
    const name = newLibraryName.trim();
    if (!name) return;
    try {
      const lib = await createLibrary(name);
      setNewLibraryName('');
      setLibraryId(lib.id);
      setSelectedId(null);
      setLibraries(prev => [...prev, lib]);
      const tree = await listEntries(lib.id);
      setEntries(tree);
    } catch (err) {
      fail(err);
    }
  }

  async function handlePublish() {
    if (!libraryId || busy) return;
    setBusy(true);
    try {
      await publishLibrary(libraryId);
      setPublications(await listPublications(libraryId));
      setError('');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function openMarket() {
    setMarketOpen(true);
    try {
      setMarket(await listMarket());
    } catch (err) {
      fail(err);
    }
  }

  async function handleSubscribe(id: string) {
    try {
      await subscribePublication(id);
      setMarketOpen(false);
      await loadWorkspace();
    } catch (err) {
      fail(err);
    }
  }

  async function handleSearch(value: string) {
    setQuery(value);
    if (!libraryId || !value.trim()) {
      setHits([]);
      return;
    }
    try {
      setHits(await searchNotes(libraryId, value.trim()));
    } catch (err) {
      fail(err);
    }
  }

  async function handleUpload(fileList: FileList | null) {
    const file = fileList?.[0];
    if (!file || !libraryId || libraries.find(item => item.id === libraryId)?.role === 'subscribed') return;
    try {
      const parent_id = selected?.kind === 'note' ? selected.id : undefined;
      const entry = await uploadFile(libraryId, file, parent_id);
      setEntries(prev => [...prev, entry]);
      await openEntry(entry.id);
    } catch (err) {
      fail(err);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }


  async function openSettings() {
    setSettingsOpen(true);
    try {
      setModel(await getModel());
      if (libraryId && libraries.find(item => item.id === libraryId)?.role !== 'subscribed') {
        setPublications(await listPublications(libraryId));
      }
    } catch (err) {
      fail(err);
    }
  }

  async function handleRenameLibrary() {
    if (!libraryId || !newLibraryName.trim()) return;
    try {
      const lib = await renameLibrary(libraryId, newLibraryName.trim());
      setNewLibraryName('');
      setLibraries(prev => prev.map(item => item.id === lib.id ? lib : item));
    } catch (err) {
      fail(err);
    }
  }


  async function handleDeleteLibrary() {
    if (!libraryId) return;
    try {
      await deleteLibrary(libraryId);
      setLibraryId(null);
      setSelected(null);
      setSelectedId(null);
      await loadWorkspace();
    } catch (err) {
      fail(err);
    }
  }

  async function handleWithdraw(id: string) {
    try {
      await withdrawPublication(id);
      if (libraryId) setPublications(await listPublications(libraryId));
    } catch (err) {
      fail(err);
    }
  }

  async function handleUnsubscribe() {
    if (!libraryId) return;
    try {
      await deleteLibrary(libraryId);
      setLibraryId(null);
      setSelected(null);
      setSelectedId(null);
      await loadWorkspace();
    } catch (err) {
      fail(err);
    }
  }


  async function handleSaveModel(event: FormEvent) {
    event.preventDefault();
    try {
      await putModel({ base_url: baseUrl.trim(), api_key: apiKey.trim(), model: modelName.trim() || undefined });
      setApiKey('');
      setModel(await getModel());
    } catch (err) {
      fail(err);
    }
  }

  async function handleLogout() {
    closingRef.current = true;
    sessionSeqRef.current++;
    activeUserIdRef.current = null;
    resetPrivateState();
    setSession(null);
    setLoggingOut(true);
    try {
      await logout();
    } finally {
      location.replace('/auth/login');
    }
  }

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: 'end' });
  }, [chat?.messages?.length]);

  const previewId = selected?.kind === 'file' && selected.content_type?.startsWith('image/') ? selected.id : null;

  useEffect(() => {
    if (!previewId) return;
    let objectUrl = '';
    let cancelled = false;
    void fetch(`/api/entries/${previewId}/file`, { credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
      .then(response => {
        if (!response.ok) throw new Error('file');
        return response.blob();
      })
      .then(blob => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setFilePreview({ id: previewId, url: objectUrl });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [previewId]);



  const currentLibrary = libraries.find(item => item.id === libraryId) ?? libraries[0];
  const readOnly = currentLibrary?.role === 'subscribed';
  const roots = useMemo(() => entries.filter(item => !item.parent_id), [entries]);


  if (sessionLoading || !session) {
    return (
      <div className="workspace-shell">
        <main className="workspace-stage">
          <div className="workspace-loading" role="status" aria-label="正在确认登录状态">
            <Loader2 className="animate-spin" size={22} />
            正在打开知识工作区…
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="workspace-shell" data-sidebar={sidebarOpen ? 'open' : 'closed'}>
      <aside className="workspace-sidebar" aria-label="知识库">
        <div className="workspace-switcher">
          <BrandIcon size={28} className="workspace-switcher-mark" label="TJUClaw" />
          <label className="workspace-switcher-label">
            <span className="sr-only">当前知识库</span>
            <select
              value={currentLibrary?.id ?? ''}
              onChange={event => {
                setLibraryId(event.target.value);
                setSelectedId(null);
                setSelected(null);
                setQuery('');
                setHits([]);
                void listEntries(event.target.value).then(setEntries).catch(fail);
              }}
            >
              {libraries.map(lib => <option key={lib.id} value={lib.id}>{lib.role === 'subscribed' ? `${lib.name}（只读）` : lib.name}</option>)}
            </select>
          </label>
        </div>
        <label className="workspace-search">
          <Search size={16} aria-hidden="true" />
          <span className="sr-only">检索笔记</span>
          <input value={query} onChange={event => void handleSearch(event.target.value)} placeholder="检索笔记" />
        </label>
        <div className="workspace-tree" role="tree" aria-label="条目">
          {query.trim() ? (
            hits.length === 0 ? <p className="workspace-tree-empty">没有匹配的笔记。</p> : hits.map(hit => (
              <button key={hit.id} type="button" className="workspace-tree-item" onClick={() => void openEntry(hit.id)}>
                <FileText size={15} />
                <span>{hit.title}</span>
              </button>
            ))
          ) : (
            <>
              {roots.length === 0 ? <p className="workspace-tree-empty">还没有条目。先建一篇笔记，或打开新手向导。</p> : null}
              {roots.map(entry => (
                <TreeItem
                  key={entry.id}
                  entry={entry}
                  entries={entries}
                  selectedId={selectedId}
                  onSelect={id => void openEntry(id)}
                />
              ))}
            </>
          )}
        </div>
        {readOnly ? null : (
          <div className="workspace-sidebar-actions">
            <Button variant="ghost" className="workspace-plain-btn" onClick={() => void handleCreate('note')} disabled={busy}>
              <Plus size={16} /> 新建笔记
            </Button>
            <Button variant="ghost" className="workspace-plain-btn" onClick={() => void handleCreate('agent')} disabled={busy}>
              <Bot size={16} /> 新建智能体
            </Button>
            <Button variant="ghost" className="workspace-plain-btn" onClick={() => void handleCreate('work_env')} disabled={busy}>
              <Monitor size={16} /> 新建工作环境
            </Button>

            <Button variant="ghost" className="workspace-plain-btn" onClick={() => fileInputRef.current?.click()} disabled={busy}>
              <Upload size={16} /> 上传文件
            </Button>
            <input ref={fileInputRef} type="file" className="sr-only" onChange={event => void handleUpload(event.target.files)} />
          </div>
        )}

        <div className="workspace-sidebar-foot">
          <Button variant="ghost" className="workspace-plain-btn" onClick={() => void openSettings()} aria-label="设置">
            <Settings size={16} /> 设置
          </Button>
          <Button variant="ghost" className="workspace-plain-btn" onClick={() => void handleLogout()} disabled={loggingOut}>
            退出
          </Button>
        </div>
      </aside>

      <div className="workspace-stage">
        <header className="workspace-topbar">
          <Button variant="ghost" size="icon" className="workspace-icon-btn" aria-label={sidebarOpen ? '收起侧栏' : '展开侧栏'} onClick={() => setSidebarOpen(open => !open)}>
            <PanelLeft size={18} />
          </Button>
          <h1>{currentLibrary?.name || '知识工作区'}{readOnly ? '（只读）' : ''}</h1>
          {selected && selected.kind !== 'file' && !readOnly && saveStatus ? (
            <span className="workspace-save">{saveStatus === 'saving' ? '正在写入…' : '已写入'}</span>
          ) : null}
          {readOnly ? null : (
            <Button variant="ghost" className="workspace-plain-btn" onClick={() => void handlePublish()} disabled={busy} aria-label="发布当前知识库">
              <Share2 size={16} /> 发布
            </Button>
          )}
          <Button variant="ghost" className="workspace-plain-btn" onClick={() => void openMarket()} aria-label="打开市场">
            <Store size={16} /> 市场
          </Button>
          {readOnly ? (
            <Button variant="ghost" className="workspace-plain-btn" onClick={() => void handleUnsubscribe()} aria-label="移出接入">
              移出接入
            </Button>
          ) : null}

          {selected && !readOnly ? (
            <Button variant="ghost" className="workspace-plain-btn" onClick={() => void handleDelete()} aria-label="删除当前条目">
              <Trash2 size={16} /> 删除
            </Button>
          ) : null}

        </header>

        {error ? <p className="workspace-error" role="alert">{error}</p> : null}

        {!selected ? (
          <div className="workspace-empty">
            <p>从左侧打开一篇笔记，或新建条目。智能体打开后是对话，不是编辑器。</p>
          </div>
        ) : selected.kind === 'agent' ? (
          <section className="workspace-chat" aria-label="智能体会话">
            <header className="workspace-doc-head">
              <Bot size={18} />
              {readOnly ? (
                <h2>{selected.title || '未命名智能体'}</h2>
              ) : (
                <>
                  <label className="sr-only" htmlFor="agent-title">智能体标题</label>
                  <input
                    id="agent-title"
                    className="workspace-agent-title"
                    value={title}
                    placeholder="未命名智能体"
                    onChange={event => {
                      setTitle(event.target.value);
                      queueSave(event.target.value, body);
                    }}
                  />
                </>
              )}
            </header>
            {readOnly ? (
              <p className="workspace-tree-empty">这是接入快照里的智能体，只能查看，不能在这里对话。</p>
            ) : (
              <>
                <div className="workspace-transcript">
                  {(chat?.messages ?? []).filter(message => (message.role === 'user' || message.role === 'assistant') && message.content).length === 0 && model?.source === 'none' ? (
                    <p className="workspace-tree-empty">还没有可用的模型。先在设置里填自己的公网 HTTPS 上游，或先去写笔记。</p>
                  ) : null}
                  {(chat?.messages ?? []).filter(message => (message.role === 'user' || message.role === 'assistant') && message.content).map((message, index) => (
                    <p key={`${message.created_at}-${index}`} className={`workspace-bubble is-${message.role}`}>{message.content}</p>
                  ))}
                  <div ref={chatEndRef} />
                </div>
                <form className="workspace-composer" onSubmit={handleChat}>
                  <label className="sr-only" htmlFor="chat-draft">发给智能体</label>
                  <textarea
                    id="chat-draft"
                    value={draft}
                    onChange={event => setDraft(event.target.value)}
                    onKeyDown={event => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        event.currentTarget.form?.requestSubmit();
                      }
                    }}
                    placeholder={model?.source === 'none' ? '先配置模型…' : '写给智能体…'}
                    rows={2}
                    disabled={model?.source === 'none'}
                  />
                  <Button type="submit" size="icon" aria-label="发送" disabled={busy || model?.source === 'none' || !draft.trim()}>
                    {busy ? <Loader2 className="animate-spin" size={16} /> : <Send size={16} />}
                  </Button>
                </form>
              </>
            )}
          </section>
        ) : selected.kind === 'file' ? (
          <section className="workspace-editor workspace-file" aria-label="文件">
            <h2 className="workspace-title">{selected.title}</h2>
            <p className="workspace-file-meta">{selected.content_type || 'application/octet-stream'} · {selected.size ?? 0} 字节</p>
            {filePreview?.id === previewId ? <img className="workspace-file-preview" src={filePreview.url} alt="" /> : null}
            <Button type="button" onClick={() => void downloadFile(selected.id).catch(fail)}>下载文件</Button>
          </section>
        ) : (
          <section className="workspace-editor" aria-label={selected.kind === 'work_env' ? '工作环境' : '笔记'}>
            <label className="sr-only" htmlFor="note-title">标题</label>
            <input
              id="note-title"
              className="workspace-title"
              value={title}
              placeholder="未命名"
              readOnly={readOnly}
              onChange={event => {
                setTitle(event.target.value);
                queueSave(event.target.value, body);
              }}
            />
            <label className="sr-only" htmlFor="note-body">正文</label>
            <textarea
              id="note-body"
              className="workspace-body"
              value={body}
              placeholder={selected.kind === 'work_env' ? '写用途、主机名和端口。不要写私钥或密码。远程访问还没接通。' : '写 Markdown…'}
              readOnly={readOnly}
              onChange={event => {
                setBody(event.target.value);
                queueSave(title, event.target.value);
              }}
            />
          </section>
        )}


      </div>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="workspace-settings">
          <DialogTitle>设置</DialogTitle>
          <DialogDescription>外观只留在这台设备。模型钥匙只存在服务端，不会写进笔记。</DialogDescription>
          <fieldset className="workspace-appearance">
            <legend>外观</legend>
            <label><input type="radio" name="mode" checked={appearance.mode === 'system'} onChange={() => setAppearance({ mode: 'system' })} /> 系统 <Monitor size={14} /></label>
            <label><input type="radio" name="mode" checked={appearance.mode === 'light'} onChange={() => setAppearance({ mode: 'light' })} /> 浅色 <Sun size={14} /></label>
            <label><input type="radio" name="mode" checked={appearance.mode === 'dark'} onChange={() => setAppearance({ mode: 'dark' })} /> 深色 <Moon size={14} /></label>
          </fieldset>
          <fieldset className="workspace-appearance">
            <legend>强调色</legend>
            <label><input type="radio" name="accent" checked={appearance.accent === 'mono'} onChange={() => setAppearance({ accent: 'mono' })} /> 黑白</label>
            <label><input type="radio" name="accent" checked={appearance.accent === 'blue'} onChange={() => setAppearance({ accent: 'blue' })} /> 蓝色</label>
          </fieldset>
          <fieldset className="workspace-appearance">
            <legend>公告</legend>
            <label>
              <input
                type="checkbox"
                checked={bannerOpen}
                onChange={(event) => setContestBannerOpen(event.target.checked)}
              />
              显示比赛公告
            </label>
          </fieldset>
          <p className="workspace-model-status">
            {appearance.canPersist ? '外观只留在这台设备。' : '这次会话里外观已生效，浏览器限制了存储，关掉后可能要重设。'}
          </p>
          <p className="workspace-model-status">
            {model?.configured
              ? `已配置自己的模型${model.name ? `（${model.name}）` : ''}`
              : model?.source === 'product'
                ? `未配置，走产品 NewAPI。今日剩余 ${model.quota.remaining} / ${model.quota.limit} 次`
                : '还没有可用的模型。填写公网 HTTPS 上游，或等产品 NewAPI 接上。'}
          </p>
          <form className="workspace-model-form" onSubmit={handleSaveModel}>
            <label>Base URL<input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" autoComplete="off" /></label>
            <label>API Key<input value={apiKey} onChange={event => setApiKey(event.target.value)} type="password" autoComplete="off" /></label>
            <label>模型名（可选）<input value={modelName} onChange={event => setModelName(event.target.value)} /></label>
            <div className="workspace-model-actions">
              <Button type="submit">保存模型</Button>
              {model?.configured ? (
                <Button type="button" variant="ghost" onClick={() => void clearModel().then(() => getModel()).then(setModel).catch(fail)}>改用产品 NewAPI</Button>
              ) : null}
            </div>
          </form>

          <form className="workspace-model-form" onSubmit={handleCreateLibrary}>
            <label>新建知识库<input value={newLibraryName} onChange={event => setNewLibraryName(event.target.value)} placeholder="知识库名称" /></label>
            <div className="workspace-model-actions">
              <Button type="submit">创建知识库</Button>
              {readOnly ? null : <Button type="button" variant="ghost" onClick={handleRenameLibrary}>重命名当前库</Button>}
            </div>
          </form>
          {readOnly ? null : (
            <>
              <p className="workspace-model-status">已发布的快照。撤回后别人不能再接入，已经接入的下次打开会失败。</p>
              {publications.length === 0 ? <p className="workspace-tree-empty">还没有发布过。</p> : (
                <ul className="workspace-market">
                  {publications.map(item => (
                    <li key={item.id}>
                      <span>{item.name}{item.withdrawn ? '（已撤回）' : ''}</span>
                      {item.withdrawn ? null : (
                        <Button type="button" variant="ghost" onClick={() => void handleWithdraw(item.id)}>撤回</Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <Button type="button" variant="ghost" onClick={() => void handleDeleteLibrary()}>删除当前知识库</Button>
            </>
          )}

        </DialogContent>
      </Dialog>

      <Dialog open={marketOpen} onOpenChange={setMarketOpen}>
        <DialogContent className="workspace-settings">
          <DialogTitle>市场</DialogTitle>
          <DialogDescription>接入别人发布的整库快照。接入后只读，撤回后会从列表消失。</DialogDescription>
          {market.length === 0 ? <p className="workspace-tree-empty">还没有公开的知识库。</p> : (
            <ul className="workspace-market">
              {market.map(item => (
                <li key={item.id}>
                  <span>{item.name}</span>
                  <Button type="button" variant="ghost" onClick={() => void handleSubscribe(item.id)}>接入</Button>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TreeItem({ entry, entries, selectedId, onSelect }: { entry: Entry; entries: Entry[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const [expanded, setExpanded] = useState(true);
  const children = entries.filter(item => item.parent_id === entry.id);
  const Icon = entry.kind === 'agent' ? Bot : entry.kind === 'work_env' ? Monitor : entry.kind === 'file' ? File : FileText;

  return (
    <div className="workspace-tree-node">
      <div className={`workspace-tree-row${selectedId === entry.id ? ' is-active' : ''}`}>
        {children.length > 0 ? (
          <button
            type="button"
            className="workspace-tree-toggle"
            aria-expanded={expanded}
            aria-label={expanded ? `折叠 ${entry.title || '未命名'}` : `展开 ${entry.title || '未命名'}`}
            onClick={() => setExpanded(open => !open)}
          >
            <ChevronRight size={14} className="workspace-tree-chevron" data-open={expanded ? 'true' : 'false'} />
          </button>
        ) : <span className="workspace-tree-spacer" />}
        <button type="button" role="treeitem" aria-current={selectedId === entry.id ? 'page' : undefined} className="workspace-tree-item" onClick={() => onSelect(entry.id)}>
          <Icon size={15} />
          <span>{entry.title || '未命名'}</span>
        </button>
      </div>
      {expanded && children.length > 0 ? (
        <div className="workspace-tree-children">
          {children.map(child => (
            <TreeItem key={child.id} entry={child} entries={entries} selectedId={selectedId} onSelect={onSelect} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
