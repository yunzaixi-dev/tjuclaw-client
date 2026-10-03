import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, Monitor, RefreshCw, Server, ShieldAlert } from 'lucide-react';
import { Button } from './components/ui/button';
import { AuthError } from './lib/auth';
import { workspaceCliSupported } from './lib/workspace-cli';
import { NativeWorkspaceCliPanel } from './components/workspace-cli-panel';
import { CloudWorkspaceRegistration } from './components/workspace-cloud-registration';
import { registerCloudWorkspace, type CloudWorkspaceInput } from './lib/workspace-cloud-registration';
import {
  deleteSystemWorkspace, listSystemWorkspaces, registerSystemWorkspace, workspaceCapabilities,
  workspaceConnectionError, type SystemWorkspace, type WorkspaceCapability,
  type WorkspaceRegistration,
} from './lib/workspace-connections';
import './workspace-connections.css';

const capabilityLabels: Record<WorkspaceCapability, string> = {
  'pi.prompt': 'Pi 提示任务',
  'claude.prompt': 'Claude 提示任务',
  'codex.prompt': 'Codex 提示任务',
  'mcp.call': 'MCP 工具调用',
};

function dateLabel(value: string | null): string {
  if (!value) return '尚未连接';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

export default function WorkspaceConnections() {
  const [workspaces, setWorkspaces] = useState<SystemWorkspace[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [actionError, setActionError] = useState('');
  const [needsLogin, setNeedsLogin] = useState(false);
  const [notice, setNotice] = useState('');
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [capabilities, setCapabilities] = useState<WorkspaceCapability[]>([]);
  const [registration, setRegistration] = useState<WorkspaceRegistration | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const listController = useRef<AbortController | null>(null);
  const actionController = useRef<AbortController | null>(null);
  const mutationLocked = useRef(false);
  const registrationHeading = useRef<HTMLHeadingElement>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const revokeButtons = useRef(new Map<string, HTMLButtonElement>());

  const handleAuthFailure = useCallback((error: unknown) => {
    if (error instanceof AuthError && (error.status === 401 || (error.status === 403 && error.body.error?.id !== 'workspace_capability_denied'))) {
      setNeedsLogin(true);
      setRegistration(null);
      setWorkspaces(null);
      setUpdatedAt(null);
    }
  }, []);

  const refresh = useCallback(async () => {
    if (mutationLocked.current) return;
    listController.current?.abort();
    const controller = new AbortController();
    listController.current = controller;
    setLoading(true);
    setListError('');
    try {
      const rows = await listSystemWorkspaces(controller.signal);
      if (controller.signal.aborted) return;
      setWorkspaces(rows);
      setUpdatedAt(new Date().toISOString());
      setNeedsLogin(false);
    } catch (error) {
      if (controller.signal.aborted) return;
      handleAuthFailure(error);
      setListError(workspaceConnectionError(error));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [handleAuthFailure]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) void refresh(); });
    // A history/bfcache restore must not redisplay a one-time credential.
    const hide = () => {
      setRegistration(null);
      setWorkspaces(null);
      setUpdatedAt(null);
      listController.current?.abort();
      actionController.current?.abort();
      actionController.current = null;
      if (mutationLocked.current) setActionError('离开页面时操作结果尚未确认，请刷新核对列表。若已登记但未收到令牌，请撤销该连接后重新登记，不要连续重复提交。');
      mutationLocked.current = false;
      setBusy(null);
      setLoading(false);
    };
    const restore = (event: PageTransitionEvent) => {
      setRegistration(null);
      if (event.persisted) void refresh();
    };
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', restore);
    return () => {
      active = false;
      listController.current?.abort();
      actionController.current?.abort();
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', restore);
    };
  }, [refresh]);

  useEffect(() => {
    if (registration) registrationHeading.current?.focus();
  }, [registration]);

  function beginMutation(key: string): AbortController | null {
    if (mutationLocked.current) return null;
    mutationLocked.current = true;
    listController.current?.abort();
    setLoading(false);
    const controller = new AbortController();
    actionController.current = controller;
    setBusy(key);
    setActionError('');
    setNotice('');
    return controller;
  }

  function finishMutation(controller: AbortController) {
    if (controller.signal.aborted) return;
    mutationLocked.current = false;
    actionController.current = null;
    setBusy(null);
  }

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (registration || needsLogin) return;
    const controller = beginMutation('register');
    if (!controller) return;
    try {
      const result = await registerSystemWorkspace({ name, kind: 'local', capabilities }, controller.signal);
      if (controller.signal.aborted) return;
      setRegistration(result);
      setWorkspaces(rows => [result.workspace, ...(rows ?? []).filter(row => row.id !== result.workspace.id)]);
      setName('');
      setCapabilities([]);
      setNotice('已登记连接。尚需在对应主机配置 CLI 并主动启动连接器；登记不会自动执行任务。');
    } catch (error) {
      if (controller.signal.aborted) return;
      handleAuthFailure(error);
      setActionError(`${workspaceConnectionError(error)} 若注册请求已送达但响应丢失，连接可能已建立：先刷新核对，不要连续重复注册。无法找回令牌时，可撤销该连接后重新登记。`);
    } finally {
      finishMutation(controller);
    }
  }

  async function revoke(workspace: SystemWorkspace) {
    const controller = beginMutation(workspace.id);
    if (!controller) return;
    try {
      await deleteSystemWorkspace(workspace.id, controller.signal);
      if (controller.signal.aborted) return;
      setWorkspaces(rows => rows?.filter(row => row.id !== workspace.id) ?? null);
      setRegistration(value => value?.workspace.id === workspace.id ? null : value);
      setConfirmation(null);
      setNotice(`已撤销「${workspace.name}」的连接。`);
      requestAnimationFrame(() => listHeading.current?.focus());
    } catch (error) {
      if (controller.signal.aborted) return;
      handleAuthFailure(error);
      setActionError(`${workspaceConnectionError(error)} 未确认撤销成功，请刷新核对连接状态。`);
    } finally {
      finishMutation(controller);
    }
  }

  async function registerCloud(input: CloudWorkspaceInput): Promise<SystemWorkspace | null> {
    if (needsLogin || registration) return null;
    const controller = beginMutation('register-cloud');
    if (!controller) return null;
    try {
      const workspace = await registerCloudWorkspace(input, controller.signal);
      return controller.signal.aborted ? null : workspace;
    } catch (error) {
      if (controller.signal.aborted) return null;
      handleAuthFailure(error);
      setActionError(`${workspaceConnectionError(error)} 云端登记未确认成功。Agent 可能已删除或所有权已变化，请重新读取并选择；请求结果不明时先刷新核对列表，不要连续重复登记。`);
      return null;
    } finally {
      finishMutation(controller);
    }
  }

  return <div className="connections-page">
    <main className="connections-main">
      <a className="connections-back" href="/workspace"><ArrowLeft size={16} aria-hidden="true" />返回资料工作台</a>
      <header className="connections-heading">
        <h1>系统工作空间连接</h1>
        <p>连接一整个可执行系统环境，拥有独立的 Agent、插件、MCP、模型配置与会话。它不是知识资料库、项目目录或单个会话；项目目录只是环境内的执行上下文。</p>
        <p>当前仅支持同一账号的环境互调。这里管理连接与授权，不会自动启动本机程序或执行远程命令。</p>
      </header>
      

      <div className="connections-feedback" aria-live="polite" aria-atomic="true">
        {notice ? <p role="status">{notice}</p> : null}
      </div>
      {actionError ? <p className="connections-error" role="alert">{actionError}</p> : null}
      {needsLogin ? <p className="connections-error"><a href="/auth/login">重新登录</a>后再管理系统工作空间连接。</p> : null}

      {registration ? <section className="connections-secret" aria-labelledby="connection-secret-title">
        <h2 id="connection-secret-title" ref={registrationHeading} tabIndex={-1}>「{registration.workspace.name}」的连接令牌</h2>
        <p><ShieldAlert size={18} aria-hidden="true" />仅本次注册响应提供。关闭、刷新或离开页面后无法再次查看；页面不会保存令牌。</p>
        <p>令牌可连接此环境，请仅在对应主机上使用。不要分享、截图或粘贴到聊天中；遗失或泄露后请撤销连接，再重新登记。</p>
        <label htmlFor="connection-token">一次性显示的连接令牌（请手动选取）</label>
        <textarea id="connection-token" value={registration.connection_token} readOnly rows={3} spellCheck={false} autoComplete="off" autoCapitalize="none" />
        <p>环境 ID：<code>{registration.workspace.id}</code></p>
        <Button variant="floating" onClick={() => { setRegistration(null); requestAnimationFrame(() => nameInput.current?.focus()); }}>我已保存到对应主机，关闭令牌</Button>
      </section> : null}

      {workspaceCliSupported() ? <NativeWorkspaceCliPanel registration={registration} onLinked={id => {
        setRegistration(value => value?.workspace.id === id ? null : value);
      }} /> : null}

      <div className="connections-layout">
        <section className="connections-list" aria-labelledby="connections-list-title">
          <div className="connections-section-heading">
            <h2 id="connections-list-title" ref={listHeading} tabIndex={-1}>已登记的环境</h2>
            <Button variant="ghost" disabled={!!busy || loading} onClick={() => void refresh()}><RefreshCw size={16} aria-hidden="true" />{loading ? '刷新中…' : '刷新列表'}</Button>
          </div>
          <p className="connections-hint">{updatedAt ? `列表读取于 ${dateLabel(updatedAt)}。` : '在线状态由服务端返回。'} 超过 60 秒没有心跳会判定离线；点击刷新查看最新状态。</p>
          {listError ? <div className="connections-error" role="alert"><p>{listError}</p><Button variant="floating" disabled={!!busy || loading} onClick={() => void refresh()}>重试读取</Button></div> : null}
          <div aria-busy={loading}>
            {loading && workspaces === null ? <div className="connections-loading" role="status">
              <p>正在读取系统工作空间…</p>
              <div className="connections-skeleton" aria-hidden="true" />
              <div className="connections-skeleton" aria-hidden="true" />
            </div> : null}
            {!loading && !listError && workspaces?.length === 0 ? <div className="connections-empty">
              <Monitor size={24} aria-hidden="true" />
              <h3>还没有系统环境连接</h3>
              <p>先登记你要通过 CLI 连接的本地环境，再在对应主机配置 CLI。默认不开放任何远程能力。</p>
              <a href="#connection-name">登记第一个环境</a>
            </div> : null}
            {workspaces && workspaces.length > 0 ? <ul className="connections-rows">{workspaces.map(workspace => <li key={workspace.id}>
              <div className="connections-row-heading">
                <h3>{workspace.kind === 'local' ? <Monitor size={18} aria-hidden="true" /> : <Server size={18} aria-hidden="true" />}{workspace.name}</h3>
                <span className="connections-status">{workspace.online ? '在线' : '离线'}</span>
              </div>
              <dl className="connections-details">
                <div><dt>类型</dt><dd>{workspace.kind === 'local' ? '本地系统环境' : '云端系统环境'}</dd></div>
                <div><dt>最近心跳</dt><dd>{dateLabel(workspace.last_seen_at)}</dd></div>
                <div><dt>登记时间</dt><dd>{dateLabel(workspace.created_at)}</dd></div>
                <div><dt>环境 ID</dt><dd><code>{workspace.id}</code></dd></div>
                <div><dt>远程能力</dt><dd>{workspace.capabilities.length ? workspace.capabilities.join(' · ') : '未开放（默认拒绝远程调用）'}</dd></div>
              </dl>
              {confirmation === workspace.id ? <div className="connections-revoke">
                <p>撤销「{workspace.name}」后，令牌失效，待执行调用与连接队列将被撤销。这不会删除知识资料库、主机项目或本地配置，也不代表已启动的主机进程已停止。</p>
                <div className="connections-actions">
                  <Button variant="floating" autoFocus disabled={!!busy} onClick={() => void revoke(workspace)}>{busy === workspace.id ? '正在撤销…' : '确认撤销连接'}</Button>
                  <Button variant="ghost" disabled={!!busy} onClick={() => { setConfirmation(null); requestAnimationFrame(() => revokeButtons.current.get(workspace.id)?.focus()); }}>取消</Button>
                </div>
              </div> : <Button ref={element => { if (element) revokeButtons.current.set(workspace.id, element); else revokeButtons.current.delete(workspace.id); }} variant="ghost" disabled={!!busy} aria-label={`撤销「${workspace.name}」的连接`} onClick={() => { setConfirmation(workspace.id); setActionError(''); }}>撤销连接</Button>}
            </li>)}</ul> : null}
          </div>
        </section>

        <div className="connections-registration-column">
        <section className="connections-register" aria-labelledby="connection-register-title">
          <h2 id="connection-register-title">登记本地系统环境</h2>
          <p className="connections-hint">登记不等于已安装或运行，仍需在对应主机配置并主动启动 CLI 连接器。</p>
          <p className="connections-hint">托管云环境须绑定你拥有的 Agent 定义，不提供本机连接令牌；登记入口仅在服务端明确支持时开放。已有云端环境仍可在列表中查看或撤销。</p>
          <form onSubmit={event => void register(event)}>
            <label htmlFor="connection-name">环境名称</label>
            <input ref={nameInput} id="connection-name" value={name} onChange={event => setName(event.target.value)} required maxLength={80} autoComplete="off" disabled={!!busy || needsLogin || !!registration} aria-describedby="connection-name-hint" />
            <p id="connection-name-hint" className="connections-hint">最多 80 字。例如：我的笔记本、实验室电脑。不必填写目录路径。</p>
            <fieldset disabled={!!busy || needsLogin || !!registration} aria-describedby="connection-host-warning">
              <legend>允许的远程能力（可不选）</legend>
              {workspaceCapabilities.map(capability => <label key={capability} className="connections-choice">
                <input type="checkbox" checked={capabilities.includes(capability)} onChange={event => setCapabilities(values => event.target.checked ? [...values, capability] : values.filter(value => value !== capability))} />
                <span>{capabilityLabels[capability]}<code>{capability}</code></span>
              </label>)}
            </fieldset>
            <p className="connections-warning" id="connection-host-warning"><ShieldAlert size={18} aria-hidden="true" />开启后，同账号的其他环境可请求这些能力。工具可能读取或修改宿主机文件、启动进程及使用模型额度，不默认限于 Docker。服务端登记不能替代主机上的显式许可，CLI 仍会检查本地配置。</p>
            {registration ? <p className="connections-hint">请先处理并关闭上方令牌，再登记下一环境。</p> : null}
            <Button type="submit" disabled={!!busy || needsLogin || !!registration || !name.trim()}>{busy === 'register' ? '正在登记…' : '登记并显示一次性令牌'}</Button>
          </form>
        </section>
        {!needsLogin ? <CloudWorkspaceRegistration disabled={!!busy || !!registration} busy={busy === 'register-cloud'}
          onAuthFailure={handleAuthFailure} onRegister={registerCloud} onRegistered={workspace => {
            setWorkspaces(rows => [workspace, ...(rows ?? []).filter(row => row.id !== workspace.id)]);
            setNotice(`已登记云端环境「${workspace.name}」。它使用独立的新会话，没有本机连接令牌；登记不代表已就绪或在线，没有自动调用 Agent 或启动本机连接器。`);
          }} /> : null}
        </div>
      </div>
      <section className="connections-cli" aria-labelledby="connection-cli-title">
        <h2 id="connection-cli-title">在对应主机连接 CLI</h2>
        <p>以下手动流程需要可用且支持系统工作空间的 <code>tjuclaw</code> CLI。是否随桌面客户端提供及本机运行状态，以原生检查为准；网页不能确认本机安装。每个环境使用独立配置目录，项目目录不是环境身份。</p>
        <pre><code>{'tjuclaw --config-dir <独立配置目录> workspace init --root <项目绝对路径> --name <环境名称>\ntjuclaw --config-dir <独立配置目录> workspace status'}</code></pre>
        <p>将下面命令中的配置目录、API 地址和环境 ID 替换成自己的值。API 地址须包含 <code>/api</code>。运行 link 后，在标准输入粘贴令牌，再发送 EOF（Linux/macOS 通常为 Ctrl+D，Windows 终端通常为 Ctrl+Z 后回车）。</p>
        <pre><code>{'tjuclaw --config-dir <独立配置目录> workspace link --api <含/api的服务地址> --id <上方环境ID>\n# 标准输入：<连接令牌，仅在此粘贴，然后发送 EOF>'}</code></pre>
        <p>不要把真实令牌写入命令参数、URL、shell 历史或环境变量。以上命令始终只显示占位符，不会填入你的令牌。</p>
        <pre><code>{'tjuclaw --config-dir <独立配置目录> connect'}</code></pre>
        <p className="connections-hint">完成连接配置后，亲自运行 connect 启动常驻连接器。远程能力默认关闭，需在本机逐项许可。网页只管理服务端连接；桌面端可经原生确认修改本机配置及启停连接器，不提供远程执行按钮。</p>
      </section>
    </main>
  </div>;
}
