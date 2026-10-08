import { useEffect, useState } from 'react';
import { AuthError, authRequest } from '../lib/auth';

interface PromptSettings { prompt: string; max_bytes: number }

export function AgentPromptSettings({ identity }: { identity: string }) {
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const [limit, setLimit] = useState(4096);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const bytes = new TextEncoder().encode(draft).length;

  useEffect(() => {
    const controller = new AbortController();
    authRequest<PromptSettings>('/api/account/agent-prompt', { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return;
      setDraft(value.prompt); setSaved(value.prompt); setLimit(value.max_bytes);
    }).catch(() => {
      if (!controller.signal.aborted) setError('暂时无法读取预置提示词，请重新打开设置重试。');
    });
    return () => controller.abort();
  }, [identity]);

  async function save(prompt: string) {
    if (busy || saved === null) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const value = await authRequest<PromptSettings>('/api/account/agent-prompt', { method: 'PUT', body: JSON.stringify({ prompt }) });
      setDraft(value.prompt); setSaved(value.prompt);
      setNotice(value.prompt ? '已保存，下一轮对话生效。' : '已恢复默认提示词，下一轮对话生效。');
    } catch (cause) {
      setError(cause instanceof AuthError && cause.status === 401 ? '登录状态已失效，请重新登录。' : '暂时无法保存，输入内容已保留，请重试。');
    } finally { setBusy(false); }
  }

  return <>
    <h3>预置提示词</h3>
    <form className="settings-model-form" onSubmit={event => { event.preventDefault(); void save(draft); }}>
      <label>
        <span>自定义指令<em>可选</em></span>
        <textarea rows={6} value={draft} disabled={busy || saved === null} maxLength={limit} aria-describedby="agent-prompt-help agent-prompt-count"
          placeholder="例如：先给结论，再解释推导；涉及公式时使用 LaTeX。"
          onChange={event => { setDraft(event.target.value); setError(''); setNotice(''); }} />
      </label>
      <p id="agent-prompt-help" className="settings-model-hint">用于此账号的学习 Agent 和引导对话，在系统预置指令后追加，不替代权限与安全规则。同步到其他设备；内容会随对话发给模型服务，请勿填写密钥或敏感信息。</p>
      <p id="agent-prompt-count" className="settings-model-hint" role={bytes > limit ? 'alert' : undefined}>{bytes} / {limit} 字节（中文通常占 3 字节）</p>
      {error ? <p className="settings-notice" role="alert">{error}</p> : null}
      {notice ? <p className="settings-model-saved" role="status">{notice}</p> : null}
      {saved === null && !error ? <p className="settings-model-hint" role="status">读取中…</p> : null}
      <div className="settings-model-actions">
        <button type="submit" className="settings-action-button is-primary" disabled={busy || saved === null || draft === saved || bytes > limit}>{busy ? '正在保存…' : '保存提示词'}</button>
        <button type="button" className="settings-action-button" disabled={busy || saved === null || (!saved && !draft)} onClick={() => void save('')}>恢复默认</button>
      </div>
    </form>
  </>;
}
