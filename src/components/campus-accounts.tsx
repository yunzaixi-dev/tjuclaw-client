import { useEffect, useRef, useState, type FormEvent } from 'react';
import { LockKeyhole, Trash2, UnlockKeyhole } from 'lucide-react';
import type { CampusCredentials } from '../lib/campus-api';
import { forgetCampusCredentials, hasCampusCredentials, storeCampusCredentials, unlockCampusCredentials } from '../lib/campus-vault';
import { campusUnlockVersion, hasOfficeAccount, hasWpyAccount, publishCampusCredentials, restoreCampusCredentials, subscribeCampusCredentials, unlockedCampusCredentials } from '../lib/campus-unlock';
import { campusTrustExpires, rememberCampusDevice, revokeCampusTrust } from '../lib/campus-device-trust';
import { attempt } from '../lib/attempt';
import { CampusAccountFields } from './campus-account-fields';

const empty: CampusCredentials = { wpyUsername: '', wpyPassword: '', officeUsername: '', officePassword: '' };

/**
 * Settings section for the two campus accounts. 微北洋 and 办公网 are
 * independent: bind either or both. Both are encrypted on this device with a
 * local passphrase and only decrypted into memory while unlocked.
 */
export function CampusAccounts({ identity }: { identity: string }) {
  return <IdentityCampusAccounts key={identity} identity={identity} />;
}

function IdentityCampusAccounts({ identity }: { identity: string }) {
  const [exists, setExists] = useState(() => hasCampusCredentials(identity));
  const [unlocked, setUnlocked] = useState<CampusCredentials | null>(() => unlockedCampusCredentials(identity));
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<CampusCredentials>(empty);
  const [passphrase, setPassphrase] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [trustDevice, setTrustDevice] = useState(false);
  const [trustedUntil, setTrustedUntil] = useState(() => campusTrustExpires(identity));
  const active = useRef(true);

  useEffect(() => {
    active.current = true;
    const unsubscribe = subscribeCampusCredentials(identity, credentials => {
      setUnlocked(credentials);
      setTrustedUntil(campusTrustExpires(identity));
    });
    void restoreCampusCredentials(identity);
    return () => { active.current = false; unsubscribe(); };
  }, [identity]);

  const field = (key: keyof CampusCredentials) => (value: string) => {
    setForm(current => ({ ...current, [key]: value })); setMessage('');
  };

  async function finishUnlock(credentials: CampusCredentials, version: number, saved = false) {
    if (!active.current || version !== campusUnlockVersion()) return;
    let notice = saved ? '已加密保存在这台设备上。' : '';
    if (trustDevice) {
      try {
        await rememberCampusDevice(identity, credentials);
        notice = '已信任此设备，7 天内免解锁。';
      } catch {
        notice = '已解锁，但未能启用免解锁；下次仍需输入口令。';
      }
    } else revokeCampusTrust(identity);
    if (!active.current || version !== campusUnlockVersion()) return;
    publishCampusCredentials(identity, credentials);
    setPassphrase(''); setTrustDevice(false); setMessage(notice);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage('');
    const credentials = { ...form, wpyUsername: form.wpyUsername.trim(), officeUsername: form.officeUsername.trim() };
    const version = campusUnlockVersion();
    return await attempt(async () => {
      await storeCampusCredentials(identity, passphrase, credentials);
      if (!active.current || version !== campusUnlockVersion()) return;
      setExists(true); setEditing(false); setPassphrase(''); setForm(empty);
      await finishUnlock(credentials, version, true);
    }, async (error) => { if (active.current) setMessage(error instanceof Error ? error.message : '保存失败。'); }, async () => { if (active.current) setBusy(false); });
  }

  async function unlock(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage('');
    const version = campusUnlockVersion();
    return await attempt(async () => {
      const credentials = await unlockCampusCredentials(identity, passphrase);
      await finishUnlock(credentials, version);
    }, async () => { if (active.current) setMessage('解锁失败：口令错误或本地数据已损坏。'); }, async () => { if (active.current) setBusy(false); });
  }

  function edit() {
    setForm(unlocked ?? empty);
    setEditing(true); setTrustDevice(false); setMessage('');
  }

  function forget() {
    if (!window.confirm('删除这台设备上的加密校园账号？')) return;
    try {
      forgetCampusCredentials(identity);
      publishCampusCredentials(identity, null);
      setExists(false); setEditing(false); setForm(empty); setPassphrase(''); setMessage('');
    } catch { setMessage('本地存储不可用，未能删除。'); }
  }

  const status = (bound: boolean) => unlocked ? bound ? '已连接' : '未绑定' : exists ? '已锁定' : '未绑定';

  return <section className="campus-accounts" aria-label="校园账号">
    <h3>账号</h3>
    <div className="settings-entry"><div className="settings-entry-copy"><strong>微北洋</strong><span>入校码、空教室与论坛使用。{unlocked && hasWpyAccount(unlocked) ? ` 账号 ${unlocked.wpyUsername}` : ''}</span></div><div className="settings-entry-action"><span className="settings-value">{status(hasWpyAccount(unlocked))}</span></div></div>
    <div className="settings-entry"><div className="settings-entry-copy"><strong>办公网</strong><span>课程表与 GPA 使用，经本站 API 转发至微北洋教务服务；兼容服务要求时才输入验证码。{unlocked && hasOfficeAccount(unlocked) ? ` 账号 ${unlocked.officeUsername}` : ''}</span></div><div className="settings-entry-action"><span className="settings-value">{status(hasOfficeAccount(unlocked))}</span></div></div>
    <p className="settings-model-hint">两个账号相互独立，只绑定需要的那个即可。账号用独立口令加密，仅保存在这台设备上。可自愿开启 7 天免解锁；锁定、退出登录或删除绑定会取消信任。</p>

    {editing || !exists ? <form className="settings-model-form" onSubmit={event => void save(event)}>
      <h3>{exists ? '更换绑定' : '绑定账号'}</h3>
      <p className="settings-model-hint">可先分别验证账号再保存。验证经本站服务端请求校园服务，不会自动保存，也不改变工具当前连接。</p>
      <CampusAccountFields provider="wpy" username={form.wpyUsername} password={form.wpyPassword} disabled={busy} onUsername={field('wpyUsername')} onPassword={field('wpyPassword')} />
      <CampusAccountFields provider="office" username={form.officeUsername} password={form.officePassword} disabled={busy} onUsername={field('officeUsername')} onPassword={field('officePassword')} />
      <label><span>本地解锁口令</span><input type="password" autoComplete="new-password" minLength={12} placeholder="至少 12 位" value={passphrase} onChange={event => setPassphrase(event.target.value)} required /></label>
      <DeviceTrustChoice checked={trustDevice} disabled={busy} onChange={setTrustDevice} />
      {message ? <p className="settings-notice" role="status">{message}</p> : null}
      <div className="settings-model-actions">
        {exists ? <button type="button" className="settings-action-button" onClick={() => { setEditing(false); setForm(empty); }}>取消</button> : null}
        <button type="submit" className="settings-action-button is-primary" disabled={busy}><LockKeyhole size={14} /> 加密保存</button>
      </div>
    </form> : unlocked ? <>
      {trustedUntil ? <p className="settings-model-hint">此设备免解锁至 {new Date(trustedUntil).toLocaleString('zh-CN')}，到期后需重新输入口令。</p> : null}
      <div className="settings-model-actions campus-accounts-actions">
        <button type="button" className="settings-action-button" disabled={busy} onClick={edit}>更换绑定</button>
        <button type="button" className="settings-action-button" disabled={busy} onClick={() => { publishCampusCredentials(identity, null); setMessage('已锁定，并取消此设备的免解锁。'); }}><LockKeyhole size={14} /> {trustedUntil ? '锁定并取消信任' : '锁定'}</button>
      </div>
    </> : <form className="settings-model-form" onSubmit={event => void unlock(event)}>
      <label><span>本地解锁口令</span><input type="password" autoComplete="off" value={passphrase} onChange={event => setPassphrase(event.target.value)} /></label>
      <DeviceTrustChoice checked={trustDevice} disabled={busy} onChange={setTrustDevice} />
      {message ? <p className="settings-notice" role="status">{message}</p> : null}
      <div className="settings-model-actions">
        <button type="button" className="settings-action-button" onClick={() => { setForm(empty); setEditing(true); }}>更换绑定</button>
        <button type="submit" className="settings-action-button is-primary" disabled={busy || !passphrase}><UnlockKeyhole size={14} /> 解锁</button>
      </div>
    </form>}
    {!editing && message && (unlocked || !exists) ? <p className="settings-model-saved" role="status">{message}</p> : null}
    {exists ? <button type="button" className="settings-action-button is-danger campus-accounts-forget" disabled={busy} onClick={forget}><Trash2 size={14} /> 删除本地绑定</button> : null}
  </section>;
}

function DeviceTrustChoice({ checked, disabled, onChange }: { checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  return <div>
    <label className="campus-device-trust-choice"><input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} /><span>信任此设备，7 天内免解锁</span></label>
    <p className="settings-model-hint">仅适合私人设备。持有这台已登录设备的人也能打开入校码；不会保存明文密码或解锁口令。</p>
  </div>;
}
