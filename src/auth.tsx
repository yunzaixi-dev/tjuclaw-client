import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, HelpCircle, Home, Lock, Mail, MailCheck, Moon, Sun } from 'lucide-react';
import { BrandIcon } from './components/brand-icon';
import { Button } from './components/ui/button';
import { CapChallenge } from './components/cap-challenge';
import { setAppearance, useAppearance } from './lib/appearance';
import { AuthError, describeError, loginWithPassword, logout, readFlow, readSession, registerWithPassword, resendEmailCode, resetFlow, sendEmailCode, verifyEmailCode, type FlowState, type IdentitySession } from './lib/auth';
import { OtpInput } from './components/ui/otp-input';
import './product.css';
import './auth.css';

function Shell({ children }: { children: ReactNode }) {
  const appearance = useAppearance();
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const initialTransform = useRef({ x: 0, y: 0 });
  const touchDist = useRef<number | null>(null);

  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement)?.closest('.auth-card, .auth-footer, button, input, a')) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const zoomFactor = -e.deltaY * 0.003;
        setTransform(prev => ({
          ...prev,
          scale: Math.min(Math.max(prev.scale + zoomFactor, 0.4), 2.5),
        }));
      } else {
        setTransform(prev => ({
          ...prev,
          x: prev.x - e.deltaX,
          y: prev.y - e.deltaY,
        }));
      }
    };

    window.addEventListener('wheel', handleWheel, { passive: false });
    return () => window.removeEventListener('wheel', handleWheel);
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement)?.closest('.auth-card, .auth-footer, button, input, a')) return;
    isDragging.current = true;
    dragStart.current = { x: e.clientX, y: e.clientY };
    initialTransform.current = { x: transform.x, y: transform.y };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging.current) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    setTransform(prev => ({
      ...prev,
      x: initialTransform.current.x + dx,
      y: initialTransform.current.y + dy,
    }));
  };

  const handleMouseUp = () => {
    isDragging.current = false;
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if ((e.target as HTMLElement)?.closest('.auth-card, .auth-footer, button, input, a')) return;
    if (e.touches.length === 1) {
      isDragging.current = true;
      dragStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      initialTransform.current = { x: transform.x, y: transform.y };
    } else if (e.touches.length === 2) {
      isDragging.current = false;
      touchDist.current = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 1 && isDragging.current) {
      const dx = e.touches[0].clientX - dragStart.current.x;
      const dy = e.touches[0].clientY - dragStart.current.y;
      setTransform(prev => ({
        ...prev,
        x: initialTransform.current.x + dx,
        y: initialTransform.current.y + dy,
      }));
    } else if (e.touches.length === 2 && touchDist.current !== null) {
      const newDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const scaleChange = (newDist - touchDist.current) * 0.005;
      touchDist.current = newDist;
      setTransform(prev => ({
        ...prev,
        scale: Math.min(Math.max(prev.scale + scaleChange, 0.4), 2.5),
      }));
    }
  };

  const handleTouchEnd = () => {
    isDragging.current = false;
    touchDist.current = null;
  };

  const gridPatternSize = 24 * transform.scale;
  const offsetX = transform.x % gridPatternSize;
  const offsetY = transform.y % gridPatternSize;

  return (
    <div
      className="auth-shell auth-canvas-shell"
      style={{
        '--canvas-grid-size': `${gridPatternSize}px`,
        '--canvas-offset-x': `${offsetX}px`,
        '--canvas-offset-y': `${offsetY}px`,
      } as React.CSSProperties}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <div className="auth-canvas-bg" aria-hidden="true" />
      <main className="auth-main">
        {children}
      </main>
      <footer className="auth-footer">
        <div className="auth-footer-inner">
          <div className="auth-footer-copy">
            <span>© 2026 TJUClaw</span>
            <a href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer" className="auth-footer-link">津ICP备2026013377号</a>
          </div>
          <div className="auth-footer-links">
            <a href="https://tjuclaw.cloud/docs/about" target="_blank" rel="noreferrer" className="auth-footer-link">关于我们</a>
            <span>·</span>
            <a href="https://tjuclaw.cloud" target="_blank" rel="noreferrer" className="auth-footer-link">文档</a>
            <span>·</span>
            <button
              type="button"
              className="auth-footer-appearance-btn"
              aria-label={appearance.resolved === 'dark' ? '切换浅色模式' : '切换深色模式'}
              onClick={() => setAppearance({ mode: appearance.resolved === 'dark' ? 'light' : 'dark' })}
            >
              {appearance.resolved === 'dark' ? <Sun size={13} /> : <Moon size={13} />}
              <span>{appearance.resolved === 'dark' ? '浅色' : '深色'}</span>
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}

function Heading({ title, children }: { title: string; children: ReactNode }) {
  return <header className="auth-heading"><h1>{title}</h1><div className="auth-description">{children}</div></header>;
}

function loginMethodFromUrl() {
  return new URLSearchParams(location.search).get('method') === 'password' ? 'password' : 'code';
}


function Welcome() {
  return <section className="auth-card auth-card-narrow auth-welcome">
    <BrandIcon size={64} className="auth-welcome-logo" />
    <Heading title="你的校园生活，下一步。"><p>从一个目标开始，<br />让 TJUClaw 帮你把事情往前推进。</p></Heading>
    <a className="auth-primary-link" href="/auth/login"><Mail size={18} />使用验证码登录 / 注册<ArrowRight size={18} /></a>
    <a className="auth-secondary-link" href="/auth/login?method=password"><Lock size={18} />使用密码登录<ArrowRight size={18} /></a>
    <p className="auth-switch">新邮箱验证后会创建账号。忘记密码请用验证码。</p>
    <p className="auth-legal-note">
      登录即表示同意我们的
      <a href="https://tjuclaw.cloud/docs/privacy" target="_blank" rel="noreferrer">隐私协议</a>
      和
      <a href="https://tjuclaw.cloud/docs/terms" target="_blank" rel="noreferrer">用户协议</a>
    </p>
  </section>;
}

function FlowScreen() {
  const [flow, setFlow] = useState<FlowState | null>(null);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [method, setMethod] = useState<'code' | 'password' | 'register'>(loginMethodFromUrl);
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
  const usingPassword = stage === 'email' && !resending && method !== 'code';


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
      if (method === 'password') {
        void perform(async signal => {
          try { await loginWithPassword(email, password, capToken, signal); location.replace('/workspace'); }
          finally { resetCaptcha(); }
        });
        return;
      }
      if (method === 'register') {
        if (password !== confirmPassword) { setError('两次输入的密码不一致。'); return; }
        void perform(async signal => {
          try { acceptFlow(await registerWithPassword(email, password, capToken, signal)); setPassword(''); setConfirmPassword(''); }
          finally { resetCaptcha(); }
        });
        return;
      }
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

  return <section className="auth-card auth-card-narrow auth-flow-card">
    <div className="auth-card-topbar">
      <a href="/" className="auth-card-back-text" aria-label="返回首页" title="返回首页">
        <Home size={13} />
        <span>返回首页</span>
      </a>
      <a href="/auth/help" className="auth-card-help-icon" aria-label="登录帮助" title="登录帮助">
        <HelpCircle size={16} />
      </a>
    </div>
    {stage === 'email' && !resending && (
      <div className="auth-card-logo">
        <BrandIcon size={52} />
      </div>
    )}
    <Heading title={resending && !expired ? '重发验证码' : stage === 'code' ? '输入验证码' : method === 'register' ? '注册 TJUClaw Cloud' : '登录 TJUClaw Cloud'}>
      {stage === 'code' ? (
        <div className="auth-stage-intro">
          <div className="auth-stage-badge" aria-hidden="true">
            <MailCheck size={16} />
          </div>
          <div className="auth-stage-copy">
            <p className="auth-destination" title={email}>{email}</p>
            <p className="auth-stage-tip">通过阿里云邮件推送服务投递，请留意收件箱或垃圾邮件</p>
          </div>
        </div>
      ) : <p>{method === 'register' ? '设置密码后，仍需验证邮箱才能登录。' : method === 'password' ? '使用已验证邮箱和密码登录。' : '欢迎使用 TJUClaw Cloud，输入邮箱以继续'}</p>}
    </Heading>
    {stage === 'email' && !resending && (
      <div className="auth-oauth-group">
        <div className="auth-oauth-buttons">
          <Button type="button" variant="ghost" className="auth-oauth-btn" disabled title="微北洋（开发中）">
            <svg className="auth-oauth-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" /></svg>
            <span>微北洋 (开发中)</span>
          </Button>
          <Button type="button" variant="ghost" className="auth-oauth-btn" disabled title="GitHub 登录（接入中）">
            <svg className="auth-oauth-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/></svg>
            <span>GitHub</span>
          </Button>
        </div>
        <div className="auth-divider">
          <span className="auth-divider-line" />
          <div className="auth-method-tabs" role="tablist" aria-label="登录方式">
            <button type="button" role="tab" aria-selected={method === 'code'} className={method === 'code' ? 'is-active' : ''} disabled={busy} onClick={() => { setMethod('code'); setError(''); }}>验证码</button>
            <button type="button" role="tab" aria-selected={method === 'password' || method === 'register'} className={method !== 'code' ? 'is-active' : ''} disabled={busy} onClick={() => { setMethod('password'); setError(''); }}>密码</button>
          </div>
          <span className="auth-divider-line" />
        </div>
      </div>
    )}
    <form onSubmit={event => { if (resending) { event.preventDefault(); resend(); } else submit(event); }} aria-busy={busy}>
      <div className={`auth-entry ${stage === 'code' ? 'auth-stage-otp' : ''}`}>
        {resending && !expired ? <>
          <p className="auth-label">完成安全验证后重发</p>
          <CapChallenge key={capKey} onSolve={setCapToken} onError={() => setError('安全验证暂时未完成，请点击重试。')} disabled={busy} />
        </> : stage === 'code' ? <>
          <label className="auth-label" htmlFor="auth-input">邮箱验证码</label>
          <OtpInput
            id="auth-input"
            inputRef={input}
            name="code"
            value={code}
            disabled={busy || expired}
            hasError={Boolean(error)}
            describedBy={error ? 'auth-form-error' : undefined}
            onChange={val => {
              setCode(val);
              if (ready) setError('');
            }}
          />
        </> : <>
          <label className="auth-label" htmlFor="auth-input">邮箱地址</label>
          <div className={`auth-input-wrap ${error ? 'auth-input-error' : ''}`}>
            <Mail size={18} aria-hidden="true" />
            <input ref={input} id="auth-input" type="email" name="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} required maxLength={200} placeholder="name@example.com" value={email} disabled={busy || expired} aria-invalid={Boolean(error)} aria-describedby={error ? 'auth-form-error' : undefined} onChange={event => { setEmail(event.target.value); if (ready) setError(''); }} />
          </div>
          {usingPassword ? <>
            <label className="auth-label" htmlFor="auth-password">{method === 'register' ? '设置密码' : '密码'}</label>
            <div className={`auth-input-wrap ${error ? 'auth-input-error' : ''}`}>
              <Lock size={18} aria-hidden="true" />
              <input id="auth-password" type="password" name="password" autoComplete={method === 'register' ? 'new-password' : 'current-password'} required minLength={8} maxLength={72} value={password} disabled={busy} aria-invalid={Boolean(error)} onChange={event => { setPassword(event.target.value); if (ready) setError(''); }} />
            </div>
            {method === 'register' ? <>
              <label className="auth-label" htmlFor="auth-password-confirm">确认密码</label>
              <div className={`auth-input-wrap ${error ? 'auth-input-error' : ''}`}>
                <Lock size={18} aria-hidden="true" />
                <input id="auth-password-confirm" type="password" name="confirm" autoComplete="new-password" required minLength={8} maxLength={72} value={confirmPassword} disabled={busy} onChange={event => { setConfirmPassword(event.target.value); if (ready) setError(''); }} />
              </div>
            </> : null}
          </> : null}
          <CapChallenge key={capKey} onSolve={setCapToken} onError={() => setError('安全验证暂时未完成，请点击重试。')} disabled={busy || !ready} />
        </>}
      </div>
      {(error || expired || notice || !ready) && (
        <div className="auth-feedback">
          {error ? <p className="auth-inline-error" role="alert" id="auth-form-error">{error}</p>
            : expired ? <p className="auth-status" role="status">本次验证已过期，请重新开始。</p>
            : notice ? <p className="auth-status" role="status">{notice}</p>
            : <p className="auth-status" role="status">正在连接安全验证服务…</p>}
        </div>
      )}
      {expired ? <Button type="button" className="auth-submit" disabled={busy} onClick={restart}>重新开始<ArrowRight size={16} /></Button>
        : <Button className="auth-submit" type="submit" disabled={!ready || busy || (resending ? !capToken || cooldown > 0 : stage === 'email' ? !email.trim() || !capToken || (usingPassword && (password.length < 8 || (method === 'register' && password !== confirmPassword))) : code.length !== 6)}>{busy ? '正在处理…' : resending ? '确认重发' : stage === 'code' ? '验证并继续' : method === 'password' ? '登录' : method === 'register' ? '创建账号' : '获取验证码'}<ArrowRight size={16} /></Button>}
    </form>
    {stage === 'email' && !resending && usingPassword ? (
      <div className="auth-flow-footer">
        <div className="auth-code-actions">
          {method === 'register'
            ? <Button type="button" variant="ghost" disabled={busy} onClick={() => { setMethod('password'); setError(''); }}>已有账号？登录</Button>
            : <Button type="button" variant="ghost" disabled={busy} onClick={() => { setMethod('register'); setError(''); }}>没有账号？注册</Button>}
          <Button type="button" variant="ghost" disabled={busy} onClick={() => { setMethod('code'); setError(''); }}>改用验证码</Button>
        </div>
      </div>
    ) : null}
    {((!ready && error) || (stage === 'code' && !expired)) && (
      <div className="auth-flow-footer">
        {!ready && error ? <Button type="button" variant="ghost" onClick={() => { setError(''); setLoadAttempt(attempt => attempt + 1); }}>重试连接</Button>
          : (
            <div className="auth-code-actions">
              {resending ? <Button type="button" variant="ghost" disabled={busy} onClick={() => { setResending(false); resetCaptcha(); setError(''); }}>取消</Button>
                : <Button type="button" variant="ghost" disabled={busy || cooldown > 0} onClick={() => { setResending(true); resetCaptcha(); setError(''); setNotice(''); }}>{cooldown > 0 ? `${cooldown} 秒后可重发` : '重新发送'}</Button>}
              <Button type="button" variant="ghost" disabled={busy} onClick={restart}>更换邮箱</Button>
            </div>
          )}
      </div>
    )}
    <div className="auth-card-subfooter">
      <p className="auth-card-subfooter-note">{usingPassword ? '忘记密码请改用验证码登录' : '由阿里云邮件推送服务投递 · 新邮箱将自动创建账号'}</p>
      <p className="auth-legal-note">
        登录即表示同意我们的
        <a href="https://tjuclaw.cloud/docs/privacy" target="_blank" rel="noreferrer">隐私协议</a>
        和
        <a href="https://tjuclaw.cloud/docs/terms" target="_blank" rel="noreferrer">用户协议</a>
      </p>
      <div className="auth-secured-by">
        <span>Secured by</span>
        <span className="auth-secured-brand">TJUClaw Auth</span>
      </div>
    </div>
  </section>;
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
    {session && <><div className="auth-assurance"><Check size={18} /><span className="auth-email">{session.email}</span></div><a className="auth-primary-link" href="/workspace">进入知识工作区<ArrowRight size={18} /></a><Button variant="ghost" className="auth-logout" disabled={busy} onClick={() => { setBusy(true); setError(''); void logout().catch(cause => { setError(describeError(cause)); setBusy(false); }); }}>{busy ? '正在退出…' : '退出登录'}</Button></>}

  </section>;
}

function Help() {
  return <section className="auth-card auth-card-narrow"><a className="auth-back" href="/auth/login"><ArrowLeft size={16} />返回登录</a><Heading title="让登录简单一点。"><p>关于邮箱登录，你可能想知道这些。</p></Heading><div className="auth-help-list">
    <details open><summary>没有收到验证码？</summary><p>邮件由阿里云邮件推送服务投递，请检查邮箱收件箱及垃圾邮件文件夹。受邮件服务商灰名单及过滤规则影响可能稍有延迟，请耐心等待片刻再重发，并使用最新收到的验证码。</p></details>
    <details><summary>第一次使用，需要注册吗？</summary><p>可以直接输入邮箱获取验证码，验证后会自动创建账号。也可以在「密码」里设置密码注册；注册后仍要验证邮箱。</p></details>
    <details><summary>如何用密码登录？</summary><p>在登录页选择「密码」，输入已验证的邮箱和密码。用验证码注册的账号默认没有密码，请继续用验证码。忘记密码时也请改用验证码，没有单独的重置邮件。</p></details>
    <details><summary>安全验证未完成？</summary><p>点击安全验证并稍等片刻。请保持页面打开，使用较新的浏览器，检查网络连接后重试。</p></details>
    <details><summary>验证过期或换了浏览器？</summary><p>返回登录页重新开始。请在发起验证的浏览器中输入验证码，不要复制验证页面地址到其他设备。</p></details>
    <details><summary>如何保护账号？</summary><p>不要分享验证码或密码，在公共设备上使用后退出登录。登录不会自动授予教务等校园服务的访问权限。</p></details>
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
  return <Shell>{content}</Shell>;
}
