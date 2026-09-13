import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, CircleHelp, Mail, Moon, ShieldCheck, Sun } from 'lucide-react';
import { BrandIcon } from './components/brand-icon';
import { Button } from './components/ui/button';
import { CapChallenge } from './components/cap-challenge';
import { setAppearance, useAppearance } from './lib/appearance';
import { AuthError, describeError, logout, readFlow, readSession, resendEmailCode, resetFlow, sendEmailCode, verifyEmailCode, type FlowState, type IdentitySession } from './lib/auth';
import './product.css';
import './auth.css';

function Shell({ children, back = false }: { children: ReactNode; back?: boolean }) {
  const appearance = useAppearance();
  return <div className="auth-shell">
    <header className="auth-toolbar">
      <div className="auth-toolbar-left">
        <a href="/" className="auth-wordmark" aria-label="TJUClaw 首页"><BrandIcon size={34} /><span className="auth-wordmark-title">TJUClaw</span><span className="auth-wordmark-badge">校园工作台</span></a>
        {back && <a className="auth-toolbar-back" href="/"><ArrowLeft size={16} /><span>返回首页</span></a>}
      </div>
      <div className="auth-toolbar-right">
        <a href="/auth/help" className="auth-toolbar-help" aria-label="查看登录帮助"><CircleHelp size={15} /><span>登录帮助</span></a>
        <Button variant="floating" size="icon" className="auth-appearance-toggle" aria-label={appearance.resolved === 'dark' ? '切换浅色外观' : '切换深色外观'} onClick={() => setAppearance({ mode: appearance.resolved === 'dark' ? 'light' : 'dark' })}>{appearance.resolved === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</Button>
      </div>
    </header>
    <main className="auth-main">{children}</main>
    <footer className="auth-footer"><span>少一点打扰，多一点完成。</span><div className="auth-footer-links"><span className="auth-footer-tag">参赛选手：TJUClaw 项目团队</span></div></footer>
  </div>;
}

function EditorialPanel() {
  return <aside className="auth-aside-panel" aria-label="平台介绍">
    <p className="auth-aside-tagline">为天津大学校园生活而设计</p>
    <div className="auth-aside-body">
      <div className="auth-aside-copy"><h2 className="auth-aside-title">校园日常，<br />从容开始。</h2><p className="auth-aside-desc">把资料、信息和计划汇聚在一起，<br />从你眼前的一件事开始。</p></div>
      <div className="auth-aside-mark-wrap" aria-hidden="true">
        <div className="auth-aside-mark">TJUClaw</div>
        <div className="auth-aside-mark-caption">A general intelligent agent platform<br />built for Tianjin University.</div>
      </div>
    </div>
    <div className="auth-aside-footer"><p className="auth-aside-mode-hint">你的目标，你的节奏。</p></div>
  </aside>;
}

function Heading({ title, children }: { title: string; children: ReactNode }) {
  return <header className="auth-heading"><h1>{title}</h1><div className="auth-description">{children}</div></header>;
}

function Welcome() {
  return <div className="auth-desktop-grid"><EditorialPanel /><section className="auth-card auth-welcome">
    <BrandIcon size={64} className="auth-welcome-logo" />
    <Heading title="你的校园生活，下一步。"><p>从一个目标开始，<br />让 TJUClaw 帮你把事情往前推进。</p></Heading>
    <a className="auth-primary-link" href="/auth/login"><Mail size={18} />使用邮箱继续<ArrowRight size={18} /></a>
    <p className="auth-switch">新邮箱验证后将自动创建账号。</p>
    <div className="auth-assurance"><ShieldCheck size={15} /><span>使用邮箱验证码，无需设置密码。</span></div>
  </section></div>;
}

function FlowScreen() {
  const [flow, setFlow] = useState<FlowState | null>(null);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [capToken, setCapToken] = useState('');
  const [capKey, setCapKey] = useState(0);
  const [resending, setResending] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [forcedExpiry, setForcedExpiry] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const lock = useRef(false);
  const mutation = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const stage = flow?.stage ?? 'email';
  const cooldown = Math.max(0, Math.ceil((Date.parse(flow?.resend_at ?? '') - now) / 1000)) || 0;
  const expired = forcedExpiry || (stage === 'code' && Date.parse(flow?.expires_at ?? '') <= now);

  useEffect(() => {
    const controller = new AbortController();
    readFlow(controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setFlow(result);
      // A fresh response never overwrites a draft typed while the request was pending.
      if (result.stage === 'code') setEmail(result.email ?? '');
      setReady(true);
    }).catch(cause => { if (!controller.signal.aborted) setError(describeError(cause)); });
    return () => controller.abort();
  }, [loadAttempt]);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, 1000);
    window.addEventListener('focus', tick);
    return () => { clearInterval(timer); window.removeEventListener('focus', tick); mutation.current?.abort(); };
  }, []);
  useEffect(() => { if (stage === 'code' && !resending) input.current?.focus(); }, [stage, resending]);

  function resetCaptcha() { setCapToken(''); setCapKey(key => key + 1); }
  async function perform(action: (signal: AbortSignal) => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(true); setError(''); setNotice('');
    try { await action(controller.signal); }
    catch (cause) {
      if (!controller.signal.aborted) {
        setError(describeError(cause));
        if (cause instanceof AuthError && cause.status === 410) setForcedExpiry(true);
      }
    } finally {
      lock.current = false;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  function acceptFlow(result: FlowState) {
    setFlow(result); setCode(''); setForcedExpiry(false); setResending(false); setNow(Date.now());
    if (result.stage === 'code') setEmail(result.email ?? '');
    resetCaptcha();
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || busy || expired) return;
    if (stage === 'email') {
      if (!capToken) { setError('请先完成安全验证。'); return; }
      void perform(async signal => {
        try { acceptFlow(await sendEmailCode(email, capToken, signal)); }
        finally { resetCaptcha(); }
      });
    } else if (/^\d{6}$/.test(code)) {
      void perform(async signal => { await verifyEmailCode(code, signal); location.replace('/workspace'); });
    } else { setError('请输入完整的 6 位数字验证码。'); input.current?.focus(); }
  }
  function restart() {
    void perform(async signal => { acceptFlow(await resetFlow(signal)); setReady(true); });
  }
  function resend() {
    if (busy || cooldown > 0 || !capToken) return;
    void perform(async signal => {
      try { acceptFlow(await resendEmailCode(capToken, signal)); setNotice('新验证码已发送，请使用最新的一封邮件。'); }
      finally { resetCaptcha(); }
    });
  }

  return <div className="auth-desktop-grid"><EditorialPanel /><section className="auth-card auth-flow-card">
    <Heading title={resending && !expired ? '重发验证码' : stage === 'code' ? '输入验证码' : '邮箱登录'}>
      {stage === 'code' ? <p className="auth-destination" title={email}>{email}</p> : <p>验证后自动登录或注册</p>}
    </Heading>
    <form onSubmit={event => { if (resending) { event.preventDefault(); resend(); } else submit(event); }} aria-busy={busy}>
      <div className="auth-entry">
        {resending && !expired ? <>
          <p className="auth-label">完成安全验证后重发</p>
          <CapChallenge key={capKey} onSolve={setCapToken} onError={() => setError('安全验证暂时未完成，请点击重试。')} disabled={busy} />
        </> : <>
          <label className="auth-label" htmlFor="auth-input">{stage === 'code' ? '邮箱验证码' : '邮箱地址'}</label>
          <div className={`auth-input-wrap ${error ? 'auth-input-error' : ''}`}>
            {stage === 'email' && <Mail size={18} aria-hidden="true" />}
            <input ref={input} id="auth-input" type={stage === 'code' ? 'text' : 'email'} name={stage === 'code' ? 'code' : 'email'} inputMode={stage === 'code' ? 'numeric' : 'email'} autoComplete={stage === 'code' ? 'one-time-code' : 'email'} autoCapitalize="none" spellCheck={false} required maxLength={stage === 'code' ? 6 : 200} className={stage === 'code' ? 'auth-code-input' : undefined} placeholder={stage === 'code' ? '6 位数字验证码' : 'name@example.com'} value={stage === 'code' ? code : email} disabled={busy || expired} aria-invalid={Boolean(error)} aria-describedby={error ? 'auth-form-error' : undefined} onChange={event => { if (stage === 'code') setCode(event.target.value.replace(/\D/g, '')); else setEmail(event.target.value); if (ready) setError(''); }} />
          </div>
          {stage === 'email' && <CapChallenge key={capKey} onSolve={setCapToken} onError={() => setError('安全验证暂时未完成，请点击重试。')} disabled={busy || !ready} />}
        </>}
      </div>
      <div className="auth-feedback">
        {error ? <p className="auth-inline-error" role="alert" id="auth-form-error">{error}</p>
          : expired ? <p className="auth-status" role="status">本次验证已过期，请重新开始。</p>
          : notice ? <p className="auth-status" role="status">{notice}</p>
          : !ready && <p className="auth-status" role="status">正在连接安全验证服务…</p>}
      </div>
      {expired ? <Button type="button" className="auth-submit" disabled={busy} onClick={restart}>重新开始<ArrowRight size={16} /></Button>
        : <Button className="auth-submit" type="submit" disabled={!ready || busy || (resending ? !capToken || cooldown > 0 : stage === 'email' ? !email.trim() || !capToken : code.length !== 6)}>{busy ? '正在处理…' : resending ? '确认重发' : stage === 'code' ? '验证并继续' : '获取验证码'}<ArrowRight size={16} /></Button>}
    </form>
    <div className="auth-flow-footer">
      {!ready && error ? <Button type="button" variant="ghost" onClick={() => { setError(''); setLoadAttempt(attempt => attempt + 1); }}>重试连接</Button>
        : stage === 'code' && !expired ? <div className="auth-code-actions">
          {resending ? <Button type="button" variant="ghost" disabled={busy} onClick={() => { setResending(false); resetCaptcha(); setError(''); }}>取消</Button>
            : <Button type="button" variant="ghost" disabled={busy || cooldown > 0} onClick={() => { setResending(true); resetCaptcha(); setError(''); setNotice(''); }}>{cooldown > 0 ? `${cooldown} 秒后可重发` : '重新发送'}</Button>}
          <Button type="button" variant="ghost" disabled={busy} onClick={restart}>更换邮箱</Button>
        </div> : <p className="auth-delivery-help">{stage === 'email' ? '无需密码，使用邮箱验证码继续。' : '请重新获取验证码。'}</p>}
    </div>
  </section></div>;
}

function SessionScreen() {
  const [session, setSession] = useState<IdentitySession | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    readSession(controller.signal).then(value => { if (!controller.signal.aborted) { if (value) setSession(value); else location.replace('/auth/login'); } }).catch(cause => { if (!controller.signal.aborted) setError(describeError(cause)); });
    return () => controller.abort();
  }, []);
  return <section className="auth-card auth-card-narrow">
    <Heading title={session ? '已安全登录。' : '确认登录状态。'}><p>{session ? '从你眼前的一件事开始。' : '正在确认当前账号。'}</p></Heading>
    {error && <p className="auth-inline-error" role="alert">{error}</p>}
    {session && <><div className="auth-assurance"><Check size={18} /><span className="auth-email">{session.email}</span></div><a className="auth-primary-link" href="/workspace">进入任务工作区<ArrowRight size={18} /></a><Button variant="ghost" className="auth-logout" disabled={busy} onClick={() => { setBusy(true); setError(''); void logout().catch(cause => { setError(describeError(cause)); setBusy(false); }); }}>{busy ? '正在退出…' : '退出登录'}</Button></>}
  </section>;
}

function Help() {
  return <section className="auth-card auth-card-narrow"><a className="auth-back" href="/auth/login"><ArrowLeft size={16} />返回登录</a><Heading title="让登录简单一点。"><p>关于邮箱登录，你可能想知道这些。</p></Heading><div className="auth-help-list">
    <details open><summary>没有收到验证码？</summary><p>检查邮箱地址和垃圾邮件文件夹。邮件可能稍有延迟，请等待片刻再重发，并使用最新收到的验证码。</p></details>
    <details><summary>第一次使用，需要注册吗？</summary><p>直接输入常用邮箱。验证后，新邮箱会自动创建账号，已有邮箱会直接登录，无需设置密码。</p></details>
    <details><summary>安全验证未完成？</summary><p>点击安全验证并稍等片刻。请保持页面打开，使用较新的浏览器，检查网络连接后重试。</p></details>
    <details><summary>验证过期或换了浏览器？</summary><p>返回登录页重新开始。请在发起验证的浏览器中输入验证码，不要复制验证页面地址到其他设备。</p></details>
    <details><summary>如何保护账号？</summary><p>不要分享验证码，在公共设备上使用后退出登录。登录不会自动授予教务等校园服务的访问权限。</p></details>
  </div></section>;
}

export default function Auth() {
  const path = location.pathname;
  let content: ReactNode;
  if (['/auth/login', '/auth/registration', '/auth/verification'].includes(path)) content = <FlowScreen />;
  else if (path === '/auth/complete' || path === '/app') content = <SessionScreen />;
  else if (path === '/auth/help') content = <Help />;
  else if (path === '/auth/logged-out') content = <section className="auth-card auth-card-narrow"><Heading title="已安全退出。"><p>下次需要时，TJUClaw 仍在这里。</p></Heading><a className="auth-primary-link" href="/auth/login">重新登录<ArrowRight size={18} /></a></section>;
  else if (path === '/') content = <Welcome />;
  else content = <section className="auth-card auth-card-narrow"><Heading title="这一步没能完成。"><p>验证可能已过期，请重新开始。</p></Heading><a className="auth-primary-link" href="/auth/login">重新登录<ArrowRight size={18} /></a></section>;
  return <Shell back={path !== '/'}>{content}</Shell>;
}
