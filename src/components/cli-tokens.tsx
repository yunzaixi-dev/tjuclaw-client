import { useEffect, useState } from 'react';
import { Terminal } from 'lucide-react';
import { attempt } from '../lib/attempt';
import { listCliTokens, revokeCliToken, type CliToken } from '../lib/cli-auth';
import './cli-tokens.css';

const day = (iso: string) => new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });

/**
 * Settings › Account: the computers signed in with `tjuclaw login`. Each can
 * read and write the libraries until revoked here or it expires.
 */
export function CliTokens() {
  const [tokens, setTokens] = useState<CliToken[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    listCliTokens(controller.signal).then(setTokens).catch(() => { if (!controller.signal.aborted) setError('暂时无法读取命令行登录列表。'); });
    return () => controller.abort();
  }, []);

  async function revoke(token: CliToken) {
    setBusy(token.id);
    setError('');
    await attempt(async () => {
      await revokeCliToken(token.id);
      setTokens(current => current?.filter(item => item.id !== token.id) ?? null);
    }, () => setError('吊销失败，请重试。'), () => setBusy(''));
  }

  return <section className="cli-tokens" aria-labelledby="cli-tokens-title">
    <h3 id="cli-tokens-title">命令行登录</h3>
    <p className="settings-about-note">在终端运行 <code>tjuclaw login</code> 并在此确认的设备，可以像操作 git 仓库那样读写你的知识库（clone、pull、push）。它们不能查看模型密钥、MCP 设置和对话。</p>
    {error ? <p className="settings-notice" role="alert">{error}</p> : null}
    {tokens === null && !error ? <p className="settings-about-note">正在读取…</p> : null}
    {tokens?.length === 0 ? <p className="settings-about-note">还没有设备登录。安装 CLI 后运行 <code>tjuclaw login</code>：<br /><code>curl -fsSL https://tjuclaw-release.zaixi.dev/cli/install.sh | sh</code></p> : null}
    {tokens?.length ? <ul className="cli-token-list">
      {tokens.map(token => <li key={token.id}>
        <Terminal size={16} aria-hidden="true" />
        <div>
          <strong>{token.name}</strong>
          <small>{day(token.created_at)} 登录 · {token.last_used_at ? `最近使用 ${day(token.last_used_at)}` : '尚未使用'} · {day(token.expires_at)} 过期</small>
        </div>
        <button type="button" className="settings-action-button is-danger" disabled={busy === token.id} onClick={() => void revoke(token)} aria-label={`吊销 ${token.name}`}>吊销</button>
      </li>)}
    </ul> : null}
  </section>;
}
