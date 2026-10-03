import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Button } from './ui/button';
import { WorkspaceCliConfiguration, type WorkspaceConfigurationDraft } from './workspace-cli-configuration';
import {
  configureWorkspaceCli, importWorkspaceCli as importWorkspaceCliConfiguration, initWorkspaceCli, linkWorkspaceCli,
  allowWorkspaceCli as setWorkspaceCliCapabilities, startWorkspaceCliConnector, stopWorkspaceCliConnector,
  reviewWorkspaceCliApproval, unlinkWorkspaceCli, workspaceCliApprovals, workspaceCliAvailability, workspaceCliConnectorStatus, workspaceCliStatus,
  type WorkspaceCliApproval, type WorkspaceCliAvailability, type WorkspaceCliConfig, type WorkspaceCliConnectorStatus,
} from '../lib/workspace-cli';
import { workspaceCapabilities, type WorkspaceCapability, type WorkspaceRegistration } from '../lib/workspace-connections';

const capabilityLabels: Record<WorkspaceCapability, string> = {
  'pi.prompt': 'Pi 提示任务', 'claude.prompt': 'Claude 提示任务',
  'codex.prompt': 'Codex 提示任务', 'mcp.call': 'MCP 工具调用',
};
type Phase = 'checking' | 'init' | 'link' | 'unlink' | 'capabilities' | 'start' | 'stop' | 'configure' | 'import' | 'approvals' | 'review';

export function nativeCliError(error: unknown): string {
  const code = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  switch (code) {
    case 'workspace_cli_unavailable': return '未找到可用的 tjuclaw CLI，请检查客户端安装或本机 CLI 后重新检查。';
    case 'workspace_cli_not_initialized':
    case 'workspace_cli_config_unavailable': return '本机环境配置尚不可用。请通过原生窗口初始化；若已配置，请检查本机配置目录。';
    case 'workspace_cli_cancelled':
    case 'workspace_cli_init_cancelled': return '已取消本机操作，页面不会自动重试。';
    case 'workspace_cli_timeout': return '本机操作超时，结果尚未确认。请重新检查状态，不要连续重复提交。';
    case 'workspace_cli_busy': return '本机 CLI 正在处理其他操作，请稍后重新检查。';
    case 'workspace_cli_windows_host_execution_unavailable': return '当前 Windows 客户端仅支持配置、关联与出站连接，不支持远程宿主机执行；仍可撤销已有本机许可。';
    case 'workspace_cli_connector_running':
    case 'workspace_cli_connector_not_stopped': return '请先停止本机连接器，再修改连接、许可或运行配置。';
    case 'workspace_cli_not_linked': return '本机环境尚未关联服务端连接。请显式登记并关联一次性令牌。';
    case 'workspace_cli_connector_failed':
    case 'workspace_cli_connector_exited':
    case 'workspace_cli_connection_timeout':
    case 'workspace_cli_start_failed': return '连接器未能就绪。请核对本机连接配置、网络与令牌是否已撤销，再手动重试。';
    case 'workspace_cli_approvals_unavailable': return '未能读取本机待审批请求。请检查 CLI 是否支持本机审批与当前配置；页面不会绕过审批。';
    case 'workspace_cli_approval_not_pending':
    case 'workspace_cli_approval_changed': return '审批请求已变化、已处理或已过期。请重新读取列表；本次没有按旧请求作出决定。';
    case 'workspace_cli_approval_failed': return '尚未确认本机审批处理结果。请重新读取列表核对，不要自动重复审批。';
    default: return '未能确认本机操作结果，请重新检查状态及客户端版本。页面不会显示可能含凭据的 CLI 诊断，也不会自动重试。';
  }
}

function connectorLabel(status: WorkspaceCliConnectorStatus | null): string {
  switch (status?.state) {
    case 'stopped': return '已停止';
    case 'starting': return '正在启动，尚未确认就绪';
    case 'running': return '运行中，启动心跳已确认';
    case 'stopping': return '正在停止，尚未确认结束';
    case 'failed': return '连接器失败，尚未就绪';
    default: return '尚未确认';
  }
}

/** Desktop operations are explicit requests to the native confirmation boundary.
 * Loading or polling this panel is read-only. A page can never choose host roots,
 * MCP files, executable, argv, env values or supply its own host consent. */
export function NativeWorkspaceCliPanel({
  registration, onLinked,
}: {
  registration: WorkspaceRegistration | null;
  onLinked: (id: string) => void;
}) {
  const [availability, setAvailability] = useState<WorkspaceCliAvailability | null>(null);
  const [config, setConfig] = useState<WorkspaceCliConfig | null>(null);
  const [connector, setConnector] = useState<WorkspaceCliConnectorStatus | null>(null);
  const [phase, setPhase] = useState<Phase | null>('checking');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [localName, setLocalName] = useState('');
  const [capabilities, setCapabilities] = useState<WorkspaceCapability[]>([]);
  const [configurationVersion, setConfigurationVersion] = useState(0);
  const [approvals, setApprovals] = useState<WorkspaceCliApproval[] | null>(null);
  const alive = useRef(false);
  const sequence = useRef({ version: 0 });
  const locked = useRef(false);
  const pollInFlight = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);

  const updateConfig = useCallback((next: WorkspaceCliConfig) => {
    setConfig(next);
    setCapabilities([...next.allowed_capabilities]);
    setConfigurationVersion(value => value + 1);
  }, []);

  const check = useCallback(async () => {
    if (locked.current) return;
    locked.current = true;
    const request = ++sequence.current.version;
    setPhase('checking');
    setError('');
    setNotice('');
    setConfig(null);
    setConnector(null);
    setApprovals(null);
    setAvailability(null);
    try {
      const found = await workspaceCliAvailability();
      if (!alive.current || request !== sequence.current.version) return;
      setAvailability(found);
      if (found.available) {
        if (found.connector_supported) {
          const status = await workspaceCliConnectorStatus();
          if (!alive.current || request !== sequence.current.version) return;
          setConnector(status);
        }
        const status = await workspaceCliStatus();
        if (alive.current && request === sequence.current.version) updateConfig(status);
      }
    } catch (failure) {
      if (alive.current && request === sequence.current.version) setError(nativeCliError(failure));
    } finally {
      if (alive.current && request === sequence.current.version) {
        locked.current = false;
        setPhase(null);
      }
    }
  }, [updateConfig]);

  useEffect(() => {
    alive.current = true;
    const lifecycle = sequence.current;
    let active = true;
    queueMicrotask(() => { if (active) void check(); });
    const hide = () => {
      alive.current = false;
      lifecycle.version++;
      if (locked.current) setError('离开页面时本机操作结果尚未确认；返回后请重新检查，不要自动重复提交。');
      locked.current = false;
      setPhase(null);
    };
    const restore = (event: PageTransitionEvent) => {
      alive.current = true;
      if (event.persisted) void check();
    };
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', restore);
    return () => {
      active = false;
      hide();
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', restore);
    };
  }, [check]);

  useEffect(() => {
    if (!availability?.connector_supported) return;
    let active = true;
    const poll = async () => {
      if (!active || !alive.current || locked.current || pollInFlight.current || document.visibilityState !== 'visible') return;
      const request = sequence.current.version;
      pollInFlight.current = true;
      try {
        const status = await workspaceCliConnectorStatus();
        if (active && alive.current && request === sequence.current.version) setConnector(status);
      } catch {
        if (active && alive.current && request === sequence.current.version) {
          setConnector(null);
          setError('未能读取本机连接器状态。请重新检查；页面不会因此自动启动或重启。');
        }
      } finally { pollInFlight.current = false; }
    };
    const timer = window.setInterval(() => void poll(), 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [availability?.connector_supported]);

  async function operate<T>(key: Phase, task: () => Promise<T>, commit: (result: T) => void, message: string) {
    if (locked.current || !alive.current) return;
    locked.current = true;
    const request = ++sequence.current.version;
    setPhase(key);
    setError('');
    setNotice('');
    try {
      const result = await task();
      if (!alive.current || request !== sequence.current.version) return;
      commit(result);
      setNotice(message);
    } catch (failure) {
      if (alive.current && request === sequence.current.version) setError(nativeCliError(failure));
    } finally {
      if (alive.current && request === sequence.current.version) {
        locked.current = false;
        setPhase(null);
      }
    }
  }

  const stopped = connector?.state === 'stopped' || connector?.state === 'failed';
  const busy = phase !== null;
  const extended = availability?.available && availability.connector_supported;
  const editable = !!extended && stopped;
  const canLink = editable && availability?.link_supported === true;
  const canSetCapabilities = editable && availability?.capabilities_supported === true;
  const canConfigure = editable && availability?.configuration_supported === true;
  const windowsHostExecutionBlocked = availability?.reason === 'workspace_cli_windows_config_connect_only';
  const capabilitiesDirty = !!config && (capabilities.length !== config.allowed_capabilities.length ||
    capabilities.some(capability => !config.allowed_capabilities.includes(capability)));

  function initialize(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!availability?.init_supported || !localName.trim() || config) return;
    void operate('init', () => initWorkspaceCli(localName.trim()), updateConfig,
      '本机环境已初始化，未关联服务端、未启动连接器，也未开放远程能力。');
  }

  function link() {
    if (!canLink || !registration || registration.workspace.kind !== 'local' || !config) return;
    const id = registration.workspace.id;
    void operate('link', () => linkWorkspaceCli(id, registration.connection_token), status => {
      if (status.id !== id || !status.linked) throw new Error('workspace_cli_invalid_output');
      updateConfig(status);
      onLinked(id);
      requestAnimationFrame(() => heading.current?.focus());
    }, '一次性令牌已交给原生 CLI 并关联本机环境，页面已关闭令牌。连接器仍未启动；本机许可仍需逐项确认。');
  }

  async function saveConfiguration(draft: WorkspaceConfigurationDraft) {
    if (!canConfigure) return;
    await operate('configure', () => configureWorkspaceCli(draft), updateConfig,
      `已请求新增或更新填写的端点，${draft.plugins?.length ? '追加本地扩展引用' : '当前本机插件引用保持不变'}；未填写的配置保持不变。没有安装插件、发起模型请求或启动连接器。`);
  }

  return <section className="connections-native" aria-labelledby="native-cli-title">
    <div className="connections-section-heading">
      <h2 id="native-cli-title" ref={heading} tabIndex={-1}>本机 CLI · 桌面客户端</h2>
      <Button variant="ghost" disabled={busy} onClick={() => void check()}>{phase === 'checking' ? '检查中…' : '重新检查本机 CLI'}</Button>
    </div>
    <p className="connections-hint">本机可用性、连接器进程与服务端在线状态分别检查。打开此页只读取状态，不会自动启动、重启连接器或执行 Agent 任务。每次本机修改均需原生窗口确认。</p>
    {phase === 'checking' ? <p role="status">正在检查本机 CLI 可用性与配置状态…</p> : null}
    {availability ? <p role="status">{availability.available ? '本机 CLI 可用。' : '本机 CLI 尚不可用，请检查客户端安装或受支持的 tjuclaw CLI 后重新检查。'}</p> : null}
    {windowsHostExecutionBlocked ? <p className="connections-warning" role="status">当前 Windows 客户端仅支持配置、关联和出站连接，不支持 Pi、Claude、Codex 或 MCP 远程宿主机执行。不能新增本机远程许可，已有许可仍可撤销；运行中不代表主机执行可用。</p> : null}
    {error ? <p className="connections-error" role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {busy && phase !== 'checking' ? <p role="status">等待本机选择、确认或操作完成…请勿重复提交。</p> : null}
    {config ? <dl className="connections-details">
      <div><dt>本机环境</dt><dd>{config.name}</dd></div>
      <div><dt>环境 ID</dt><dd><code>{config.id}</code></dd></div>
      <div><dt>项目目录</dt><dd><code>{config.root}</code></dd></div>
      <div><dt>本机许可</dt><dd>{config.allowed_capabilities.length ? config.allowed_capabilities.join(' · ') : '未开放远程能力'}</dd></div>
      {extended ? <div><dt>连接配置</dt><dd>{config.linked ? '已保存本机连接配置（不代表服务端令牌仍有效）' : '未关联服务端连接'}</dd></div> : null}
    </dl> : null}
    {availability?.available && availability.init_supported && !config ? <form onSubmit={initialize}>
      <label htmlFor="native-workspace-name">本机环境名称</label>
      <input id="native-workspace-name" value={localName} onChange={event => setLocalName(event.target.value)} required maxLength={80} disabled={busy} autoComplete="off" aria-describedby="native-init-warning" />
      <p className="connections-hint" id="native-init-warning">点击后由原生窗口选择项目目录并确认初始化。网页不指定主机路径；初始化不会启动连接器或授予远程能力。</p>
      <Button variant="floating" type="submit" disabled={busy || !localName.trim()}>{phase === 'init' ? '等待本机选择与确认…' : '选择目录并请求本机初始化'}</Button>
    </form> : null}

    {extended ? <div className="connections-native-state">
      <h3>本机连接器状态：<span role="status">{connectorLabel(connector)}</span></h3>
      {connector?.error ? <p className="connections-error" role="alert">{nativeCliError(connector.error)}</p> : null}
      <p className="connections-hint">运行中仅表示启动时已完成真实心跳与待送结果恢复；当前远程可达性请刷新下方服务端列表确认。停止不撤销令牌，服务端可能仍显示在线至心跳过期。</p>
      <div className="connections-actions">
        <Button variant="floating" disabled={busy || !stopped || !config?.linked} onClick={() => void operate('start', startWorkspaceCliConnector, setConnector, '启动请求已完成，请核对本机状态与服务端列表。页面不会自动执行测试任务或再次启动。')}>{phase === 'start' ? '等待连接器就绪…' : '请求启动本机连接器'}</Button>
        <Button variant="ghost" disabled={busy || connector?.state === 'stopped' || connector?.state === 'stopping'} onClick={() => void operate('stop', stopWorkspaceCliConnector, setConnector, '停止请求已完成，请核对本机状态。若不再使用此连接，请另行撤销服务端连接。')}>{phase === 'stop' ? '正在停止…' : '请求停止本机连接器'}</Button>
      </div>
    </div> : availability?.available ? <p className="connections-hint">当前原生桥仅支持可用性、状态检查与初始化。请使用下方 CLI 指令手动关联、许可和连接；更新客户端后重新检查。</p> : null}

    {config && extended ? <>
      <section className="connections-native-link" aria-labelledby="native-link-title">
        <h3 id="native-link-title">关联刚登记的本地环境</h3>
        {!availability?.link_supported ? <p className="connections-hint">当前原生桥尚未支持关联或解除关联，请更新客户端后重新检查。</p> : null}
        {registration?.workspace.kind === 'local' ? <>
          <p>将「{registration.workspace.name}」关联到上述本机环境。它会替换本机已有的连接配置，不会改变项目目录、自动许可或启动连接器。</p>
          <p className="connections-hint">仅本次登记得到的令牌可通过此按钮交给原生 CLI，原生通过标准输入写入私密配置。不会放入 URL、命令参数、剪贴板或网页存储。</p>
          <Button variant="floating" disabled={busy || !canLink} onClick={link}>将此连接关联到本机 CLI（原生确认）</Button>
        </> : <p className="connections-hint">在下方显式登记一个本地环境，处理一次性令牌时即可请求关联。云端或其他主机的连接须在对应主机配置；遗失的令牌不能重新读取。</p>}
        {config.linked ? <>
          <p className="connections-hint">解除本机关联只移除当前本机的连接配置，不撤销服务端令牌。彻底撤销请同时删除下方服务端连接。</p>
          <Button variant="ghost" disabled={busy || !canLink} onClick={() => { if (canLink) void operate('unlink', unlinkWorkspaceCli, updateConfig, '本机关联已解除，服务端登记仍保留。需要彻底撤销时，请另行撤销服务端连接。'); }}>请求解除本机关联</Button>
        </> : null}
      </section>
      <section className="connections-native-capabilities" aria-labelledby="native-capabilities-title">
        <h3 id="native-capabilities-title">当前本机环境的远程许可</h3>
        {!availability?.capabilities_supported ? <p className="connections-hint">当前原生桥尚未支持修改本机许可，请更新客户端后重新检查。</p> : null}
        <p className="connections-warning" id="native-host-warning"><ShieldAlert size={18} aria-hidden="true" />授权后，同账号环境可请求读取或修改宿主机文件、启动进程及使用模型额度，不默认限于 Docker。请仅开放你确实需要的能力；原生窗口会再次确认宿主机访问。</p>
        <form onSubmit={event => {
          event.preventDefault();
          if (canSetCapabilities && !windowsHostExecutionBlocked && capabilitiesDirty) void operate('capabilities', () => setWorkspaceCliCapabilities(capabilities), updateConfig,
            '本机许可已保存。服务端公布的能力将在连接器下次心跳同步；本机仍独立检查许可。未启动连接器。');
        }}>
          <fieldset disabled={busy || !canSetCapabilities || windowsHostExecutionBlocked} aria-describedby="native-host-warning">
            <legend>本机允许的能力（全部不选即全部撤销）</legend>
            {workspaceCapabilities.map(capability => <label key={capability} className="connections-choice">
              <input type="checkbox" checked={capabilities.includes(capability)} onChange={event => setCapabilities(values => event.target.checked ? [...values, capability] : values.filter(value => value !== capability))} />
              <span>本机 {capabilityLabels[capability]}<code>{capability}</code></span>
            </label>)}
          </fieldset>
          <div className="connections-actions">
            <Button variant="floating" type="submit" disabled={busy || !canSetCapabilities || windowsHostExecutionBlocked || !capabilitiesDirty}>请求保存本机许可</Button>
            <Button variant="ghost" disabled={busy || !canSetCapabilities || !config.allowed_capabilities.length} onClick={() => { if (canSetCapabilities) void operate('capabilities', () => setWorkspaceCliCapabilities([]), updateConfig, '全部本机远程许可已撤销。服务端能力仍须等下次心跳同步；未启动连接器。'); }}>请求撤销全部本机许可</Button>
          </div>
        </form>
      </section>
      {!editable ? <p className="connections-hint">请先停止连接器并确认状态，再关联、修改许可或配置。状态未知时可请求停止或重新检查，不会自动重试。</p> : null}
      <section className="connections-native-approvals" aria-labelledby="native-approvals-title">
        <div className="connections-section-heading">
          <h3 id="native-approvals-title">本机运行时审批</h3>
          <Button variant="ghost" disabled={busy} onClick={() => void operate('approvals', workspaceCliApprovals, setApprovals, '已读取本机待审批摘要。具体工具输入与允许/拒绝决定仅在原生窗口处理。')}>读取本机待审批请求</Button>
        </div>
        <p className="connections-hint">CLI 或运行时可能等待本机审批。这里不会自动允许：仅显示上次手动读取的请求摘要，打开原生窗口后才能选择允许这一次、拒绝这一次或取消。原生会重新核对请求与有效期，网页不能提供工具输入或审批决定。</p>
        {approvals === null ? <p className="connections-hint">尚未读取本机审批状态。</p> : approvals.length === 0 ? <p role="status">本次读取没有待审批请求；有新任务时请再次读取。</p> : <ul className="connections-native-references">{approvals.map(approval => <li key={approval.id}>
          <h4>{approval.runtime === 'pi' ? 'Pi' : approval.runtime === 'claude' ? 'Claude' : 'Codex'} 待审批</h4>
          <dl className="connections-details">
            <div><dt>请求 ID</dt><dd><code>{approval.id}</code></dd></div>
            <div><dt>本机会话</dt><dd><code>{approval.session_id}</code></dd></div>
            <div><dt>有效至</dt><dd><time dateTime={approval.expires_at}>{new Date(approval.expires_at).toLocaleString('zh-CN', { hour12: false })}</time></dd></div>
          </dl>
          <Button variant="floating" disabled={busy} onClick={() => void operate('review', () => reviewWorkspaceCliApproval(approval.id), result => {
            if (result.responded !== true) throw new Error('workspace_cli_approval_failed');
            setApprovals(rows => rows?.filter(row => row.id !== approval.id) ?? null);
          }, '原生窗口已处理这一次审批。页面不代替你的允许/拒绝决定；请重新读取列表核对其他请求。')}>在原生窗口审查此请求</Button>
        </li>)}</ul>}
      </section>
      {!availability?.configuration_supported ? <p className="connections-hint">当前原生桥尚未支持修改或导入运行配置，请更新客户端后重新检查。</p> : null}
      <WorkspaceCliConfiguration key={configurationVersion} endpoints={config.endpoints ?? []} plugins={config.plugins ?? []} mcpServers={config.mcp_servers ?? []} busy={busy} disabled={!canConfigure} onSave={saveConfiguration}
        onImport={() => { if (canConfigure) void operate('import', importWorkspaceCliConfiguration, updateConfig, '原生配置导入已完成。请核对端点、插件、MCP 引用与本机许可；没有自动启动连接器。'); }} />
      <h3>本机账号附件</h3>
      <p className="connections-hint">附件配置不代表已登录或凭据可用。这里只显示引用状态，不显示凭据来源路径或内容；不会默认继承主机全局模型账户。</p>
      {Object.keys(config.runtime_auth ?? {}).length ? <dl className="connections-details">{Object.entries(config.runtime_auth).map(([runtime, auth]) => <div key={runtime}>
        <dt>{runtime === 'pi' ? 'Pi' : runtime === 'claude' ? 'Claude' : 'Codex'}</dt>
        <dd>{auth.configured ? '已配置附件（未验证登录）' : '附件未配置'} · {auth.mode === 'host-file' ? '原生凭据文件引用' : '本机环境变量引用'}{auth.model ? ` · ${auth.model}` : ''}</dd>
      </div>)}</dl> : <p className="connections-hint">尚无显式账号附件。可在原生窗口导入经过审核的高级配置。</p>}
    </> : null}
  </section>;
}
