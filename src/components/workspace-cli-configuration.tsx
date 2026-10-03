import { useState, type FormEvent } from 'react';
import { Button } from './ui/button';

export type WorkspaceEndpointDraft = { name: string; base_url: string; model: string };
export type WorkspaceConfigurationDraft = { endpoints: WorkspaceEndpointDraft[]; plugins?: string[] };
export type WorkspaceEndpointSummary = {
  name: string; model: string; base_origin: string; requires_key: boolean; key_available: boolean;
};

function hasControl(value: string) {
  return [...value].some(character => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
  });
}

/** Only declarative metadata goes to native. No keys, executable/argv/env or root. */
export function parseWorkspaceConfigurationDraft(endpoints: WorkspaceEndpointDraft[], pluginText?: string): WorkspaceConfigurationDraft {
  if (endpoints.length > 16) throw new Error('最多配置 16 个模型端点。');
  const names = new Set<string>();
  const cleaned = endpoints.map(endpoint => {
    const name = endpoint.name.trim();
    const model = endpoint.model.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(name) || names.has(name)) throw new Error('端点名称使用字母、数字、点、下划线或短横线，不能重复，且最多 80 字。');
    names.add(name);
    if (!model || model.length > 160 || hasControl(model)) throw new Error('请为每个端点填写有效的模型名称。');
    if (hasControl(endpoint.base_url)) throw new Error('模型 API 地址不能包含控制字符或方向控制符。');
    const base_url = endpoint.base_url.trim();
    let url: URL;
    try { url = new URL(base_url); } catch { throw new Error('请填写完整的 HTTP 或 HTTPS 模型 API 地址。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.href.length > 2048) {
      throw new Error('模型 API 地址只能使用 HTTP 或 HTTPS，不能含账号、密码、查询参数或片段。密钥须通过原生窗口导入，不能放在地址中。');
    }
    // The CLI compares the current full URL exactly before preserving its key
    // reference. Do not silently strip a slash or canonicalize an unchanged URL.
    return { name, base_url, model };
  });
  // Omission preserves CURRENT native references, not this page's snapshot.
  if (pluginText === undefined) return { endpoints: cleaned };
  const plugins = pluginText.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  if (plugins.length > 32 || new Set(plugins).size !== plugins.length || plugins.some(value =>
    new TextEncoder().encode(value).length > 512 || hasControl(value) || value.startsWith('-') || value.includes('='))) {
    throw new Error('插件引用最多 32 个，每个最多 512 字节，不能重复或含控制字符、命令参数、密钥赋值。');
  }
  for (const value of plugins) {
    const absolute = (value.startsWith('/') && !value.startsWith('//')) || /^[A-Za-z]:[\\/]/.test(value);
    if (!absolute) {
      throw new Error('插件引用只能填写当前主机的绝对本地扩展路径，不支持 npm、网址、file: URI、~、相对路径或 UNC/设备路径。也可通过原生窗口导入。');
    }
  }
  return { endpoints: cleaned, plugins };
}

export function WorkspaceCliConfiguration({
  endpoints, plugins, mcpServers, busy, disabled, onSave, onImport,
}: {
  endpoints: WorkspaceEndpointSummary[];
  plugins: string[];
  mcpServers: string[];
  busy: boolean;
  disabled: boolean;
  onSave: (draft: WorkspaceConfigurationDraft) => Promise<void>;
  onImport: () => void;
}) {
  // Native exposes redacted summaries, not complete URLs/plugin paths. Never
  // reconstruct these summaries as editable configuration.
  const [drafts, setDrafts] = useState<WorkspaceEndpointDraft[]>([]);
  const [pluginText, setPluginText] = useState('');
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [pluginConsent, setPluginConsent] = useState(false);
  const controlsDisabled = busy || disabled;
  const hasPluginDraft = !!pluginText.trim();
  const hasDraft = !!drafts.length || hasPluginDraft;
  function change(index: number, field: keyof WorkspaceEndpointDraft, value: string) {
    setDrafts(rows => rows.map((row, at) => at === index ? { ...row, [field]: value } : row));
    setDirty(true);
    setError('');
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (controlsDisabled || !hasDraft || (hasPluginDraft && !pluginConsent)) return;
    let draft: WorkspaceConfigurationDraft;
    try { draft = parseWorkspaceConfigurationDraft(drafts, hasPluginDraft ? pluginText : undefined); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '请检查端点与插件引用。'); return; }
    setError('');
    await onSave(draft);
  }
  return <details className="connections-native-settings">
    <summary>模型端点、插件与 MCP 配置</summary>
    <p className="connections-hint">仅配置当前桌面管理的系统环境。其他环境须在对应主机配置；不会修改资料库或迁移已有会话。写入前由原生窗口确认，网页不会安装插件或发起模型请求。</p>
    <h3>已有端点与引用</h3>
    {endpoints.length ? <ul className="connections-native-references">{endpoints.map(endpoint => <li key={endpoint.name}>
      <h4><code>{endpoint.name}</code></h4>
      <dl className="connections-details">
        <div><dt>模型</dt><dd>{endpoint.model}</dd></div>
        <div><dt>API 来源</dt><dd><code>{endpoint.base_origin}</code>（仅显示来源，不是完整地址）</dd></div>
        <div><dt>凭据状态</dt><dd>{!endpoint.requires_key ? '未要求密钥' : endpoint.key_available ? '本机凭据引用可用' : '需要本机凭据，当前不可用'}</dd></div>
      </dl>
    </li>)}</ul> : <p className="connections-hint">尚无模型端点。</p>}
    <p className="connections-hint">完整 API 地址、密钥与本地凭据引用不回传网页。已有插件引用：{plugins.length ? plugins.join(' · ') : '暂无'}（仅显示名称）。</p>
    <p className="connections-warning">保存只新增或按名称更新填写的端点，未填写的端点保持不变；插件只追加新引用，不会替换或清空现有引用，也不会用页面旧摘要覆盖本机当前配置。MCP、账号附件与本机远程许可保持不变。只有端点名称和完整 API 地址均未变更时，才保留当前凭据引用；更换地址会解除该引用，须通过可信的原生导入重新附加。上面的摘要不是完整地址或插件路径，不能自动填回草稿。</p>
    <form onSubmit={event => void save(event)}>
      <fieldset disabled={controlsDisabled}>
        <legend>新增或更新模型端点</legend>
        {drafts.length ? drafts.map((draft, index) => <div className="connections-endpoint" key={index}>
          <div className="connections-section-heading"><h3>端点 {index + 1}</h3><Button variant="ghost" disabled={controlsDisabled} onClick={() => { setDrafts(rows => rows.filter((_, at) => at !== index)); setDirty(true); setError(''); }} aria-label={`移除端点 ${index + 1}`}>移除</Button></div>
          <div className="connections-endpoint-fields">
            <label>端点 {index + 1} 名称<input value={draft.name} required maxLength={80} autoComplete="off" placeholder="例如 campus-model" onChange={event => change(index, 'name', event.target.value)} /></label>
            <label>端点 {index + 1} 模型<input value={draft.model} required maxLength={160} autoComplete="off" onChange={event => change(index, 'model', event.target.value)} /></label>
            <label className="connections-endpoint-address">端点 {index + 1} API 地址<input type="url" value={draft.base_url} required maxLength={2048} autoComplete="off" spellCheck={false} onChange={event => change(index, 'base_url', event.target.value)} /></label>
          </div>
          <p className="connections-hint">{endpoints.some(endpoint => endpoint.name === draft.name.trim()) ? '同名更新：仅在完整 API 地址也未变更时保留当前凭据引用；更换地址会解除引用。' : '新端点：不会继承全局模型凭据。'} 网页不接收密钥；如需凭据，请使用下方可信的原生导入。</p>
        </div>) : <p className="connections-hint">尚未填写端点草稿，已有端点不会因此移除。可添加完整端点，或通过原生窗口导入配置与凭据引用。</p>}
        <Button variant="floating" disabled={controlsDisabled || drafts.length >= 16} onClick={() => { setDrafts(rows => [...rows, { name: '', base_url: '', model: '' }]); setDirty(true); setError(''); }}>添加模型端点</Button>
      </fieldset>
      <label htmlFor="native-plugin-references">追加本地扩展引用（每行一个，可留空）</label>
      <textarea id="native-plugin-references" value={pluginText} rows={3} disabled={controlsDisabled} spellCheck={false} autoComplete="off" aria-describedby="native-plugin-hint" onChange={event => { setPluginText(event.target.value); setDirty(true); setPluginConsent(false); setError(''); }} />
      <p className="connections-hint" id="native-plugin-hint">仅接受当前主机已存在的绝对本地扩展路径（Linux/macOS 为 / 开头，Windows 为盘符路径），每个最多 512 字节、最多 32 个；原生会校验本机路径。不支持 npm、网址、file: URI、~、相对路径或 UNC/设备路径，不会下载安装。若不知道完整路径，请通过原生窗口导入；不要填写 Shell 命令、环境变量或密钥。插件与 MCP 可能执行代码并访问宿主机，请确认来源。</p>
      {dirty ? <p className="connections-hint" role="status">配置草稿尚未保存。重新检查本机状态会重载草稿。</p> : null}
      {error ? <p className="connections-error" role="alert">{error}</p> : null}
      {hasPluginDraft ? <label className="connections-choice">
        <input type="checkbox" disabled={controlsDisabled} checked={pluginConsent} onChange={event => setPluginConsent(event.target.checked)} />
        <span>我已核对扩展来源，理解它可能执行代码并访问宿主机；原生窗口仍须确认。</span>
      </label> : null}
      <div className="connections-actions">
        <Button variant="floating" type="submit" disabled={controlsDisabled || !hasDraft || (hasPluginDraft && !pluginConsent)}>{busy ? '等待原生操作完成…' : '请求保存端点与插件配置'}</Button>
        <Button variant="ghost" disabled={controlsDisabled || !dirty} onClick={() => { setDrafts([]); setPluginText(''); setDirty(false); setPluginConsent(false); setError(''); }}>放弃配置草稿</Button>
      </div>
    </form>
    <h3>MCP 与高级配置</h3>
    <p>{mcpServers.length ? `已配置的 MCP 引用：${mcpServers.join(' · ')}` : '尚无 MCP 服务引用。'}</p>
    <p className="connections-hint">MCP 命令、参数与凭据只在原生窗口选择的本地配置文件中声明，不经网页编辑或上传。替换或移除配置请使用可信的原生文件导入，并在原生窗口核对变更；导入不用于授予远程能力，许可须通过上方独立操作管理。此处仅展示服务名称与端点凭据状态。请先停止连接器再导入或修改运行配置。</p>
    <Button variant="floating" disabled={controlsDisabled} onClick={onImport}>在原生窗口导入 MCP 与高级配置</Button>
    <p className="connections-hint">原生会确认文件和宿主机访问范围。直接导入的模型密钥只在本次桌面会话保留，退出后需重新导入；外部环境变量引用可能不可用。网页不接收密钥，也不会默认借用开发者或系统全局账户。</p>
  </details>;
}
