import { useEffect, useRef, useState } from 'react';
import { fetchOfficeVerificationCaptcha, verifyOfficeAccount, verifyWpyAccount, type OfficeCaptcha } from '../lib/campus-api';

function verificationError(error: unknown) {
  const id = (error as { body?: { error?: { id?: string } } } | null)?.body?.error?.id;
  if (id === 'campus_invalid_credentials') return '微北洋账号或密码不正确，请检查后重试。';
  if (id === 'campus_office_credentials_invalid') return '办公网账号、密码或验证码有误，请检查后重新验证。';
  if (id === 'campus_office_captcha_expired') return '验证码已过期或已使用，请重新验证获取新图片。';
  if (id === 'campus_not_configured' || id === 'campus_office_not_configured') return '校园验证服务尚未配置，暂时无法检查账号。';
  if (id === 'campus_office_captcha_unavailable') return '办公网验证码接口不可用，无法检查账号；这不表示账号或密码错误。';
  if (id === 'campus_academic_unavailable' || id === 'campus_invalid_response') return '微北洋教务服务暂时未返回可确认的账号数据；请稍后重试，不代表密码错误。';
  return '校园验证服务暂时不可用，无法判断账号是否正确，请稍后重试。';
}

/** A draft check has its own transient server session; it never saves or connects tools. */
export function CampusAccountFields({ provider, username, password, disabled, onUsername, onPassword }: {
  provider: 'wpy' | 'office';
  username: string;
  password: string;
  disabled: boolean;
  onUsername: (value: string) => void;
  onPassword: (value: string) => void;
}) {
  const name = provider === 'wpy' ? '微北洋' : '办公网';
  const [message, setMessage] = useState('');
  const [valid, setValid] = useState(false);
  const [pending, setPending] = useState(false);
  const [captcha, setCaptcha] = useState<OfficeCaptcha | null>(null);
  const [code, setCode] = useState('');
  const controller = useRef<AbortController | null>(null);
  const ready = Boolean(username.trim() && password);

  useEffect(() => () => controller.current?.abort(), []);

  function cancel() {
    controller.current?.abort();
    controller.current = null;
    setPending(false); setCaptcha(null); setCode(''); setMessage(''); setValid(false);
  }

  async function check(submit = false) {
    if (!ready || disabled || pending || (submit && (!captcha || !code.trim()))) return;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setPending(true); setMessage(''); setValid(false);
    try {
      if (provider === 'office' && !submit) {
        const next = await fetchOfficeVerificationCaptcha(request.signal);
        if (request.signal.aborted) return;
        if ('captcha_required' in next && next.captcha_required === false) {
          const result = await verifyOfficeAccount(username.trim(), password, next.captcha_id, '', request.signal);
          if (request.signal.aborted) return;
          if (result.valid !== true) throw new Error('Verification not confirmed');
          setValid(true); setMessage(`${name}验证通过，尚未保存。`);
        } else if ('content_type' in next) {
          setCaptcha(next); setCode('');
        } else throw new Error('Invalid office challenge');
      } else {
        const result = provider === 'wpy'
          ? await verifyWpyAccount(username.trim(), password, request.signal)
          : await verifyOfficeAccount(username.trim(), password, captcha!.captcha_id, code.trim(), request.signal);
        if (request.signal.aborted) return;
        if (result.valid !== true) throw new Error('Verification not confirmed');
        setCaptcha(null); setCode('');
        setValid(true);
        setMessage(`${name}验证通过，尚未保存。`);
      }
    } catch (error) {
      if (request.signal.aborted) return;
      setCaptcha(null); setCode('');
      setMessage(verificationError(error));
    } finally {
      if (!request.signal.aborted) { controller.current = null; setPending(false); }
    }
  }

  return <div className="campus-account-fields">
    <div className="campus-account-input-row">
      <label><span>{name}账号<em>可选</em></span><input autoComplete="off" disabled={disabled} value={username} onChange={event => { cancel(); onUsername(event.target.value); }} /></label>
      <button type="button" className="settings-action-button" disabled={disabled || pending || !ready} onClick={() => void check()}>
        {pending ? '验证中…' : `验证${name}账号`}
      </button>
    </div>
    <label><span>{name}密码</span><input type="password" autoComplete="new-password" disabled={disabled} value={password} onChange={event => { cancel(); onPassword(event.target.value); }} /></label>
    {provider === 'office' ? <p className="settings-model-hint">网页端经本站 API 转发至微北洋教务服务验证，不是设备直连办公网；验证成功不自动保存。</p> : null}
    {captcha ? <div className="campus-account-captcha" role="group" aria-label="办公网账号验证">
      <p className="settings-model-hint">输入图片验证码，仅检查账号，不会连接校园工具。</p>
      <img src={`data:${/^image\/(png|jpeg|gif|webp)$/.test(captcha.content_type) ? captcha.content_type : 'image/png'};base64,${captcha.data}`} alt="办公网验证图片" />
      <label><span>验证办公网验证码</span><input autoComplete="off" value={code} disabled={disabled || pending} onChange={event => setCode(event.target.value)} onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); void check(true); }
      }} /></label>
      <div className="settings-model-actions">
        <button type="button" className="settings-action-button" disabled={disabled || pending || !code.trim()} onClick={() => void check(true)}>提交办公网验证</button>
        <button type="button" className="settings-action-button" disabled={disabled || pending} onClick={() => void check()}>刷新验证图片</button>
        <button type="button" className="settings-action-button" onClick={cancel}>取消验证</button>
      </div>
    </div> : null}
    {message ? <p className={valid ? 'settings-model-saved' : 'settings-notice'} role="status">{message}</p> : null}
  </div>;
}
