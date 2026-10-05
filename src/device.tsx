import { useEffect, useState, type FormEvent } from 'react';
import { KeyRound, Laptop, ShieldCheck } from 'lucide-react';
import { AuthError, readSession, type IdentitySession } from './lib/auth';
import { decideDevice, describeDevice, normalizeUserCode, rememberReturn, type CliDevice } from './lib/cli-auth';
import './product.css';
import './device.css';

type Phase = 'loading' | 'enter' | 'checking' | 'confirm' | 'deciding' | 'approved' | 'denied';

function describeError(error: unknown) {
  if (error instanceof AuthError) {
    if (error.status === 404) return '没有找到这个验证码，或它已过期（10 分钟内有效）。请在终端重新运行 tjuclaw login。';
    if (error.status === 401) return '登录状态已失效，请刷新页面重新登录。';
  }
  return '暂时无法完成，请稍后重试。';
}

const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

/**
 * The page `tjuclaw login` opens: the signed-in person checks the code shown
 * in their terminal and allows that CLI to read and write their libraries.
 */
export default function DevicePage() {
  const initial = normalizeUserCode(new URLSearchParams(location.search).get('code') ?? '');
  const [session, setSession] = useState<IdentitySession | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [code, setCode] = useState(initial);
  const [device, setDevice] = useState<CliDevice | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    readSession(controller.signal).then(value => {
      if (controller.signal.aborted) return;
      if (!value) {
        rememberReturn(location.pathname + (initial ? `?code=${initial}` : ''));
        location.replace('/auth/login');
        return;
      }
      setSession(value);
      if (!initial) { setPhase('enter'); return; }
      setPhase('checking');
      describeDevice(initial, controller.signal)
        .then(found => { setDevice(found); setPhase('confirm'); })
        .catch(reason => { if (!controller.signal.aborted) { setError(describeError(reason)); setPhase('enter'); } });
    }).catch(() => { if (!controller.signal.aborted) { setError('无法读取登录状态，请刷新页面。'); setPhase('enter'); } });
    return () => controller.abort();
  }, [initial]);

  async function lookUp(event: FormEvent) {
    event.preventDefault();
    const normalized = normalizeUserCode(code);
    if (!normalized) { setError('验证码是 8 个字母，例如 WDJB-MJHT。'); return; }
    setError('');
    setPhase('checking');
    try {
      setDevice(await describeDevice(normalized));
      setCode(normalized);
      setPhase('confirm');
    } catch (reason) {
      setError(describeError(reason));
      setPhase('enter');
    }
  }

  async function decide(approve: boolean) {
    setPhase('deciding');
    setError('');
    try {
      await decideDevice(device?.user_code ?? code, approve);
      setPhase(approve ? 'approved' : 'denied');
    } catch (reason) {
      setError(describeError(reason));
      setPhase('confirm');
    }
  }

  return <main className="device-page">
    <section className="device-card" aria-labelledby="device-title">
      <div className="device-mark" aria-hidden="true"><KeyRound size={22} /></div>
      <h1 id="device-title">{phase === 'approved' ? '已授权' : phase === 'denied' ? '已拒绝' : '授权 TJUClaw CLI'}</h1>
      {phase === 'loading' || phase === 'checking' && !device ? <p className="device-lead" role="status">正在确认…</p> : null}

      {phase === 'enter' || (phase === 'checking' && !initial) ? <form className="device-form" onSubmit={lookUp}>
        <p className="device-lead">输入终端里显示的验证码。</p>
        <label htmlFor="device-code">验证码</label>
        <input id="device-code" value={code} onChange={event => setCode(event.target.value.toUpperCase())} placeholder="XXXX-XXXX"
          autoComplete="off" autoCapitalize="characters" spellCheck={false} autoFocus inputMode="text" maxLength={9} />
        {error ? <p className="device-error" role="alert">{error}</p> : null}
        <button type="submit" className="device-primary" disabled={phase === 'checking'}>继续</button>
      </form> : null}

      {(phase === 'confirm' || phase === 'deciding') && device ? <>
        <p className="device-lead">确认终端里显示的验证码与下面一致，再允许登录。</p>
        <p className="device-code" aria-label={`验证码 ${device.user_code}`}>{device.user_code}</p>
        <dl className="device-facts">
          <div><dt><Laptop size={15} aria-hidden="true" />设备</dt><dd>{device.name}</dd></div>
          <div><dt>请求时间</dt><dd>{timeLabel(device.created_at)}</dd></div>
          <div><dt><ShieldCheck size={15} aria-hidden="true" />可以</dt><dd>读写你的知识库：笔记、文件夹和文件</dd></div>
          <div><dt>不能</dt><dd>查看模型密钥、MCP 设置和对话，或删除整个知识库</dd></div>
        </dl>
        {error ? <p className="device-error" role="alert">{error}</p> : null}
        <div className="device-actions">
          <button type="button" onClick={() => void decide(false)} disabled={phase === 'deciding'}>拒绝</button>
          <button type="button" className="device-primary" onClick={() => void decide(true)} disabled={phase === 'deciding'}>允许</button>
        </div>
        <p className="device-note">不是你自己在终端里运行的 tjuclaw login？请点“拒绝”。</p>
      </> : null}

      {phase === 'approved' ? <p className="device-lead" role="status">回到终端，tjuclaw 会自动完成登录。之后可以在“设置 › 命令行登录”里随时吊销。</p> : null}
      {phase === 'denied' ? <p className="device-lead" role="status">这次登录请求已拒绝，终端里的 tjuclaw 会停止等待。</p> : null}

      {session ? <p className="device-account">当前账号：{session.email} · <a href="/workspace">返回工作区</a></p> : null}
    </section>
  </main>;
}
