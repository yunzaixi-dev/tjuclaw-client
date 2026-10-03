import { useEffect, useState, type FormEvent } from 'react';
import { ExternalLink, Plus, RefreshCw, Trash2 } from 'lucide-react';
import {
  addCatalogMcp, addCustomMcp, checkMcp, describeMcpError, listMcp, removeMcp, updateMcp,
  type CustomMcpServer, type McpAuth, type McpCatalogEntry, type McpServer, type McpTool,
} from '../lib/mcp';

const emptyCustom: CustomMcpServer = { name: '', title: '', url: '', auth: 'none', auth_name: '', secret: '' };

const authLabels: Record<McpAuth, string> = {
  none: '无需密钥',
  bearer: 'Bearer 令牌',
  header: '自定义请求头',
  query: 'URL 参数',
};

type Check = { state: 'checking' } | { state: 'ok'; tools: McpTool[] } | { state: 'error'; message: string };

/**
 * Settings section for remote MCP servers: the curated catalog, the servers
 * the user added, and a form for any other Streamable HTTP server. The Agent
 * calls their tools during a conversation; keys stay on the server.
 */
export function McpSettings() {
  const [catalog, setCatalog] = useState<McpCatalogEntry[]>([]);
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [checks, setChecks] = useState<Record<string, Check>>({});
  // The catalog entry whose key form is open, and what was typed into it.
  const [adding, setAdding] = useState<string | null>(null);
  const [secret, setSecret] = useState('');
  const [rekey, setRekey] = useState<string | null>(null);
  const [custom, setCustom] = useState<CustomMcpServer>(emptyCustom);
  const [customOpen, setCustomOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    listMcp(controller.signal)
      .then(result => { setCatalog(result.catalog); setServers(result.servers); })
      .catch(cause => { if (!controller.signal.aborted) setError(describeMcpError(cause)); });
    return () => controller.abort();
  }, []);

  async function run(key: string, task: () => Promise<void>) {
    setBusy(key); setError('');
    try { await task(); } catch (cause) { setError(describeMcpError(cause)); } finally { setBusy(''); }
  }

  async function check(server: McpServer) {
    setChecks(current => ({ ...current, [server.id]: { state: 'checking' } }));
    try {
      const tools = await checkMcp(server.id);
      setChecks(current => ({ ...current, [server.id]: { state: 'ok', tools } }));
    } catch (cause) {
      setChecks(current => ({ ...current, [server.id]: { state: 'error', message: describeMcpError(cause) } }));
    }
  }

  function added(server: McpServer) {
    setServers(current => [...(current ?? []), server]);
    void check(server);
  }

  function addFromCatalog(entry: McpCatalogEntry, event?: FormEvent) {
    event?.preventDefault();
    void run(`add:${entry.id}`, async () => {
      added(await addCatalogMcp(entry.id, secret));
      setAdding(null); setSecret('');
    });
  }

  function startAdding(entry: McpCatalogEntry) {
    if (entry.auth === 'none') { addFromCatalog(entry); return; }
    setAdding(entry.id); setSecret(''); setError('');
  }

  function toggle(server: McpServer) {
    void run(`toggle:${server.id}`, async () => {
      const next = await updateMcp(server.id, { enabled: !server.enabled });
      setServers(current => current?.map(item => item.id === next.id ? next : item) ?? null);
    });
  }

  function saveKey(server: McpServer, event: FormEvent) {
    event.preventDefault();
    void run(`key:${server.id}`, async () => {
      const next = await updateMcp(server.id, { secret });
      setServers(current => current?.map(item => item.id === next.id ? next : item) ?? null);
      setRekey(null); setSecret('');
      void check(next);
    });
  }

  function remove(server: McpServer) {
    if (!window.confirm(`移除「${server.title}」？Agent 将不再使用它的工具。`)) return;
    void run(`remove:${server.id}`, async () => {
      await removeMcp(server.id);
      setServers(current => current?.filter(item => item.id !== server.id) ?? null);
    });
  }

  function addCustom(event: FormEvent) {
    event.preventDefault();
    void run('custom', async () => {
      added(await addCustomMcp(custom));
      setCustom(emptyCustom); setCustomOpen(false);
    });
  }

  const installed = new Set((servers ?? []).map(server => server.catalog_id).filter(Boolean));
  const entryFor = (server: McpServer) => catalog.find(entry => entry.id === server.catalog_id);

  return <>
    <p className="settings-about-note">添加后，Agent 会在对话中按需调用这些服务的工具，每次调用都会显示在会话步骤里。密钥保存在服务器上，只用于访问对应的服务，不会出现在浏览器、笔记或沙箱中。</p>
    {error ? <p className="settings-notice" role="alert">{error}</p> : null}

    <h3>已添加</h3>
    {servers === null && !error ? <p className="settings-about-note" role="status">读取中…</p> : null}
    {servers?.length === 0 ? <p className="settings-about-note">还没有添加 MCP 服务。可以从下方精选中添加，或填写自定义地址。</p> : null}
    {servers?.map(server => {
      const entry = entryFor(server);
      const status = checks[server.id];
      const keyed = server.auth !== 'none';
      return <div key={server.id} className="mcp-server">
        <div className="settings-entry">
          <div className="settings-entry-copy">
            <strong>{server.title}</strong>
            <span>{entry ? entry.summary : server.url}{keyed ? ` · ${server.has_secret ? '已设置密钥' : '未设置密钥'}` : ''}</span>
          </div>
          <div className="settings-entry-action mcp-server-actions">
            <label className="mcp-switch">
              <input type="checkbox" checked={server.enabled} disabled={busy === `toggle:${server.id}`} onChange={() => toggle(server)} />
              <span>{server.enabled ? '已启用' : '已停用'}</span>
            </label>
            <button type="button" className="settings-action-button" aria-label={`检查「${server.title}」的连接`} disabled={status?.state === 'checking'} onClick={() => void check(server)}>
              <RefreshCw size={14} aria-hidden="true" /> 检查
            </button>
            {keyed ? <button type="button" className="settings-action-button" onClick={() => { setRekey(rekey === server.id ? null : server.id); setSecret(''); }}>更换密钥</button> : null}
            <button type="button" className="settings-action-button is-danger" aria-label={`移除「${server.title}」`} disabled={busy === `remove:${server.id}`} onClick={() => remove(server)}>
              <Trash2 size={14} aria-hidden="true" />
            </button>
          </div>
        </div>
        {status ? <p className={status.state === 'error' ? 'settings-notice mcp-status' : 'settings-about-note mcp-status'} role="status">
          {status.state === 'checking' ? '正在连接…'
            : status.state === 'error' ? status.message
              : status.tools.length ? `连接正常，提供 ${status.tools.length} 个工具：${status.tools.map(tool => tool.name).join('、')}` : '连接正常，但这个服务没有提供工具。'}
        </p> : null}
        {rekey === server.id ? <form className="settings-model-form mcp-key-form" onSubmit={event => saveKey(server, event)}>
          <label>
            <span>{entry?.key_label ?? '密钥'}{entry?.key_optional ? <em>可留空</em> : null}</span>
            <input type="password" autoComplete="off" spellCheck={false} maxLength={1024} required={!entry?.key_optional} value={secret} onChange={event => setSecret(event.target.value)} />
          </label>
          <div className="settings-model-actions">
            <button type="submit" className="settings-action-button is-primary" disabled={busy === `key:${server.id}`}>保存密钥</button>
            <button type="button" className="settings-action-button" onClick={() => setRekey(null)}>取消</button>
          </div>
        </form> : null}
      </div>;
    })}

    <h3>精选服务</h3>
    <div className="mcp-catalog">
      {catalog.map(entry => {
        const open = adding === entry.id;
        return <article key={entry.id} className="mcp-card" aria-labelledby={`mcp-${entry.id}`}>
          <header>
            <strong id={`mcp-${entry.id}`}>{entry.title}</strong>
            <span>{entry.publisher}</span>
          </header>
          <p className="mcp-card-summary">{entry.summary}</p>
          <p>{entry.description}</p>
          <footer>
            <a href={entry.homepage} target="_blank" rel="noreferrer">了解更多 <ExternalLink size={12} aria-hidden="true" /></a>
            {installed.has(entry.id)
              ? <span className="settings-badge">已添加</span>
              : <button type="button" className="settings-action-button is-primary" disabled={busy === `add:${entry.id}` || open} onClick={() => startAdding(entry)}>
                <Plus size={14} aria-hidden="true" /> 添加
              </button>}
          </footer>
          {open ? <form className="settings-model-form mcp-key-form" onSubmit={event => addFromCatalog(entry, event)}>
            <label>
              <span>{entry.key_label ?? '密钥'}{entry.key_optional ? <em>可留空</em> : null}</span>
              <input type="password" autoComplete="off" spellCheck={false} maxLength={1024} required={!entry.key_optional} value={secret} onChange={event => setSecret(event.target.value)} autoFocus />
            </label>
            {entry.key_help ? <p className="settings-model-hint">{entry.key_help}{entry.key_url ? <> · <a href={entry.key_url} target="_blank" rel="noreferrer">前往获取</a></> : null}</p> : null}
            <div className="settings-model-actions">
              <button type="submit" className="settings-action-button is-primary" disabled={busy === `add:${entry.id}`}>{busy === `add:${entry.id}` ? '正在添加…' : '保存并添加'}</button>
              <button type="button" className="settings-action-button" onClick={() => setAdding(null)}>取消</button>
            </div>
          </form> : null}
        </article>;
      })}
    </div>

    <h3>自定义服务</h3>
    {customOpen ? <form className="settings-model-form" onSubmit={addCustom}>
      <label>
        <span>服务地址</span>
        <input type="url" inputMode="url" required autoComplete="off" spellCheck={false} maxLength={512} placeholder="https://example.com/mcp" value={custom.url} onChange={event => setCustom(form => ({ ...form, url: event.target.value }))} />
      </label>
      <label>
        <span>显示名称<em>可选</em></span>
        <input type="text" autoComplete="off" maxLength={40} placeholder="例如 课程助手" value={custom.title} onChange={event => setCustom(form => ({ ...form, title: event.target.value }))} />
      </label>
      <label>
        <span>工具前缀</span>
        <input type="text" required autoComplete="off" spellCheck={false} maxLength={24} pattern="[a-z][a-z0-9_]*" placeholder="例如 course" value={custom.name} onChange={event => setCustom(form => ({ ...form, name: event.target.value }))} />
      </label>
      <label>
        <span>认证方式</span>
        <select value={custom.auth} onChange={event => setCustom(form => ({ ...form, auth: event.target.value as McpAuth }))}>
          {(Object.keys(authLabels) as McpAuth[]).map(auth => <option key={auth} value={auth}>{authLabels[auth]}</option>)}
        </select>
      </label>
      {custom.auth === 'header' || custom.auth === 'query' ? <label>
        <span>{custom.auth === 'header' ? '请求头名称' : '参数名称'}</span>
        <input type="text" required autoComplete="off" spellCheck={false} maxLength={64} placeholder={custom.auth === 'header' ? '例如 X-API-Key' : '例如 key'} value={custom.auth_name} onChange={event => setCustom(form => ({ ...form, auth_name: event.target.value }))} />
      </label> : null}
      {custom.auth !== 'none' ? <label>
        <span>密钥</span>
        <input type="password" required autoComplete="off" spellCheck={false} maxLength={1024} value={custom.secret} onChange={event => setCustom(form => ({ ...form, secret: event.target.value }))} />
      </label> : null}
      <p className="settings-model-hint">需要公网 HTTPS 的 Streamable HTTP 端点；不支持旧版 SSE 端点和需要 OAuth 登录的服务。工具前缀只能用小写字母、数字和下划线，会出现在工具名中。</p>
      <div className="settings-model-actions">
        <button type="submit" className="settings-action-button is-primary" disabled={busy === 'custom'}>{busy === 'custom' ? '正在添加…' : '添加'}</button>
        <button type="button" className="settings-action-button" onClick={() => { setCustomOpen(false); setCustom(emptyCustom); }}>取消</button>
      </div>
    </form> : <button type="button" className="settings-action-button" onClick={() => setCustomOpen(true)}><Plus size={14} aria-hidden="true" /> 添加自定义服务</button>}
  </>;
}
