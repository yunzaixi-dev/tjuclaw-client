import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Button } from './ui/button';
import { listEntries, listLibraries } from '../lib/library';
import { workspaceConnectionError } from '../lib/workspace-connections';
import type { SystemWorkspace } from '../lib/workspace-connections';
import { cloudAgentOptions, ownedCloudLibraries, workspaceRegistrationOptions, type CloudWorkspaceInput } from '../lib/workspace-cloud-registration';

type LibraryOption = { id: string; name: string };
type AgentOption = { id: string; title: string };
type ReadState = 'loading' | 'ready' | 'error';

/** The existing entries API can include bodies. Retain only name/ID projections;
 * never display, round-trip, or store bodies, open sessions, or accept typed IDs. */
export function CloudWorkspaceRegistration({
  disabled, busy, onAuthFailure, onRegister, onRegistered,
}: {
  disabled: boolean;
  busy: boolean;
  onAuthFailure: (error: unknown) => void;
  onRegister: (input: CloudWorkspaceInput) => Promise<SystemWorkspace | null>;
  onRegistered: (workspace: SystemWorkspace) => void;
}) {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [libraries, setLibraries] = useState<LibraryOption[]>([]);
  const [libraryState, setLibraryState] = useState<ReadState>('loading');
  const [libraryError, setLibraryError] = useState('');
  const [libraryId, setLibraryId] = useState('');
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [agentState, setAgentState] = useState<ReadState>('ready');
  const [agentError, setAgentError] = useState('');
  const [agentId, setAgentId] = useState('');
  const [name, setName] = useState('');
  const [allowPi, setAllowPi] = useState(false);
  const catalogController = useRef<AbortController | null>(null);
  const agentController = useRef<AbortController | null>(null);
  const selectedLibrary = useRef('');
  const active = useRef(false);
  const submitting = useRef<symbol | null>(null);

  const clearSelection = useCallback(() => {
    agentController.current?.abort();
    selectedLibrary.current = '';
    setLibraryId('');
    setAgents([]);
    setAgentId('');
    setAllowPi(false);
    setAgentState('ready');
    setAgentError('');
  }, []);

  const loadCatalog = useCallback(async () => {
    catalogController.current?.abort();
    clearSelection();
    const controller = new AbortController();
    catalogController.current = controller;
    setSupported(null);
    setLibraries([]);
    setLibraryState('loading');
    setLibraryError('');
    try {
      const options = await workspaceRegistrationOptions(controller.signal);
      if (controller.signal.aborted || !active.current) return;
      const enabled = options.cloud_registration_supported === true;
      setSupported(enabled);
      if (!enabled) return;
      const rows = await listLibraries(controller.signal);
      if (controller.signal.aborted || !active.current) return;
      // Undefined/subscribed roles are not ownership. Discard all other fields.
      setLibraries(ownedCloudLibraries(rows));
      setLibraryState('ready');
    } catch (error) {
      if (controller.signal.aborted || !active.current) return;
      onAuthFailure(error);
      setSupported(value => value === true);
      setLibraryState('error');
      setLibraryError(workspaceConnectionError(error));
    }
  }, [clearSelection, onAuthFailure]);

  useEffect(() => {
    active.current = true;
    let mounted = true;
    queueMicrotask(() => { if (mounted) void loadCatalog(); });
    const hide = () => {
      active.current = false;
      submitting.current = null;
      catalogController.current?.abort();
      clearSelection();
      setLibraries([]);
      setSupported(false);
    };
    const restore = (event: PageTransitionEvent) => {
      active.current = true;
      if (event.persisted) void loadCatalog();
    };
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', restore);
    return () => {
      mounted = false;
      active.current = false;
      catalogController.current?.abort();
      agentController.current?.abort();
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', restore);
    };
  }, [clearSelection, loadCatalog]);

  async function chooseLibrary(id: string) {
    agentController.current?.abort();
    selectedLibrary.current = id;
    setLibraryId(id);
    setAgentId('');
    setAgents([]);
    setAllowPi(false);
    setAgentError('');
    if (!libraries.some(library => library.id === id) || supported !== true || !active.current) {
      setAgentState('ready');
      return;
    }
    const controller = new AbortController();
    agentController.current = controller;
    setAgentState('loading');
    try {
      const rows = await listEntries(id, controller.signal);
      if (controller.signal.aborted || !active.current || selectedLibrary.current !== id) return;
      // Discard the other entry fields received from the existing listing API.
      setAgents(cloudAgentOptions(rows, id));
      setAgentState('ready');
    } catch (error) {
      if (controller.signal.aborted || !active.current || selectedLibrary.current !== id) return;
      onAuthFailure(error);
      setAgentError(workspaceConnectionError(error));
      setAgentState('error');
    }
  }

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || submitting.current || supported !== true || !active.current || libraryState !== 'ready'
      || agentState !== 'ready' || selectedLibrary.current !== libraryId
      || !libraries.some(library => library.id === libraryId) || !agents.some(agent => agent.id === agentId) || !name.trim()) return;
    const request = Symbol();
    submitting.current = request;
    try {
      const completed = await onRegister({ name, agent_entry_id: agentId, capabilities: allowPi ? ['pi.prompt'] : [] });
      if (completed && active.current && submitting.current === request) {
        onRegistered(completed);
        setName('');
        setAgentId('');
        setAllowPi(false);
      }
    } finally { if (submitting.current === request) submitting.current = null; }
  }

  if (supported !== true) return <div className="connections-cloud-availability">
    <p className="connections-hint" role="status">{supported === null ? '正在检查云端登记支持…' : '当前未开放云端登记，或尚未确认登记支持。已有云端环境仍可查看或撤销。'}</p>
    {supported === false ? <Button variant="ghost" disabled={disabled} onClick={() => void loadCatalog()}>重新检查云端登记支持</Button> : null}
  </div>;

  const controlsDisabled = disabled || libraryState !== 'ready';
  return <section className="connections-cloud-register" aria-labelledby="cloud-register-title">
    <h2 id="cloud-register-title">登记云端系统环境</h2>
    <p className="connections-hint">当前服务配置支持登记，不代表模型、网关已就绪或在线。选择你拥有的 Agent 定义；服务端会再次核对所有权。</p>
    <p className="connections-hint">云端环境使用独立的新会话，不复用或迁移已有聊天，不提供本机连接令牌。登记不等于就绪或在线；云端逐环境的完整插件、MCP 与模型端点配置目前尚未完成，仍使用账号配置。</p>
    <form onSubmit={event => void register(event)}>
      <label htmlFor="cloud-workspace-name">云端环境名称</label>
      <input id="cloud-workspace-name" value={name} onChange={event => setName(event.target.value)} required maxLength={80} autoComplete="off" disabled={disabled} />
      <div aria-busy={libraryState === 'loading'}>
        {libraryState === 'loading' ? <p className="connections-hint" role="status">正在读取你拥有的资料库…</p> : null}
        {libraryError ? <div className="connections-error" role="alert"><p>{libraryError}</p><Button variant="ghost" disabled={disabled} onClick={() => void loadCatalog()}>重新读取拥有的资料库</Button></div> : null}
        {libraryState === 'ready' && !libraries.length ? <p className="connections-hint" role="status">没有可选的自有资料库。订阅资料库和所有权未确认的资料库不能用于云端登记；请先在资料工作台创建资料库与 Agent。</p> : null}
        <label htmlFor="cloud-library">你拥有的资料库</label>
        <select id="cloud-library" value={libraryId} disabled={controlsDisabled || !libraries.length} onChange={event => void chooseLibrary(event.target.value)}>
          <option value="">选择资料库</option>
          {libraries.map(library => <option key={library.id} value={library.id}>{library.name || '未命名资料库'}</option>)}
        </select>
      </div>
      <div aria-busy={agentState === 'loading'}>
        <label htmlFor="cloud-agent">云端 Agent 定义</label>
        <select id="cloud-agent" value={agentId} disabled={controlsDisabled || !libraryId || agentState !== 'ready' || !agents.length}
          onChange={event => { setAgentId(event.target.value); setAllowPi(false); }}>
          <option value="">选择 Agent 定义</option>
          {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.title || '未命名 Agent'}</option>)}
        </select>
        {!libraryId ? <p className="connections-hint">先选择自有资料库，再读取现有条目列表。此页只保留和展示 Agent 名称与 ID，丢弃其他条目字段，不打开或复用会话，也不回传正文。</p> : null}
        {agentId ? <p className="connections-hint">所选 Agent ID：<code>{agentId}</code></p> : null}
        {agentState === 'loading' ? <p className="connections-hint" role="status">正在读取所选资料库的 Agent…</p> : null}
        {agentError ? <div className="connections-error" role="alert"><p>{agentError}</p><Button variant="ghost" disabled={disabled} onClick={() => void chooseLibrary(libraryId)}>重新读取 Agent 定义</Button></div> : null}
        {libraryId && agentState === 'ready' && !agents.length ? <p className="connections-hint" role="status">此自有资料库中没有可绑定的 Agent 定义。笔记、项目与其他资料库的条目不能替代 Agent。</p> : null}
      </div>
      <label className="connections-choice" aria-describedby="cloud-pi-warning">
        <input type="checkbox" disabled={controlsDisabled || !agentId || agentState !== 'ready'} checked={allowPi} onChange={event => setAllowPi(event.target.checked)} />
        <span>允许同账号环境调用此云端 Pi；我理解它会使用模型额度并可能读写资料<code>pi.prompt</code></span>
      </label>
      <p className="connections-warning" id="cloud-pi-warning"><ShieldAlert size={18} aria-hidden="true" />默认不开放远程能力。不勾选也可登记，但不会允许 Pi 远程调用；此选择不授予本机宿主机权限，不会启动本机连接器。</p>
      <p className="connections-hint">云端登记后暂不能修改能力授权。需要改变 Pi 调用权限时，请撤销该云端环境后重新登记，并明确选择权限；本机 CLI 授权另行管理。</p>
      <Button type="submit" disabled={controlsDisabled || !name.trim() || !agentId || agentState !== 'ready'}>{busy ? '正在登记云端环境…' : '登记云端环境（无连接令牌）'}</Button>
    </form>
  </section>;
}
