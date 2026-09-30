import { useEffect, useState, type FormEvent } from 'react';
import { LockKeyhole, Trash2, UnlockKeyhole } from 'lucide-react';
import type { CampusCredentials } from '../lib/campus-api';
import { forgetCampusCredentials, hasCampusCredentials, storeCampusCredentials, unlockCampusCredentials } from '../lib/campus-vault';
import { hasOfficeAccount, hasWpyAccount, publishCampusCredentials, subscribeCampusCredentials, unlockedCampusCredentials } from '../lib/campus-unlock';

const empty: CampusCredentials = { wpyUsername: '', wpyPassword: '', officeUsername: '', officePassword: '' };

/**
 * Settings section for the two campus accounts. 微北洋 and 办公网 are
 * independent: bind either or both. Both are encrypted on this device with a
 * local passphrase and only decrypted into memory while unlocked.
 */
export function CampusAccounts({ identity }: { identity: string }) {
  const [exists, setExists] = useState(() => hasCampusCredentials(identity));
  const [unlocked, setUnlocked] = useState<CampusCredentials | null>(() => unlockedCampusCredentials(identity));
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<CampusCredentials>(empty);
  const [passphrase, setPassphrase] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => subscribeCampusCredentials(identity, setUnlocked), [identity]);

  const field = (key: keyof CampusCredentials) => ({
    value: form[key],
    onChange: (event: { target: { value: string } }) => { setForm(current => ({ ...current, [key]: event.target.value })); setMessage(''); },
  });

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage('');
    const credentials = { ...form, wpyUsername: form.wpyUsername.trim(), officeUsername: form.officeUsername.trim() };
    try {
      await storeCampusCredentials(identity, passphrase, credentials);
      setExists(true); setEditing(false); setPassphrase(''); setForm(empty);
      publishCampusCredentials(identity, credentials);
      setMessage('已加密保存在这台设备上。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败。'); }
    finally { setBusy(false); }
  }

  async function unlock(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage('');
    try {
      publishCampusCredentials(identity, await unlockCampusCredentials(identity, passphrase));
      setPassphrase('');
    } catch { setMessage('解锁失败：口令错误或本地数据已损坏。'); }
    finally { setBusy(false); }
  }

  function edit() {
    setForm(unlocked ?? empty);
    setEditing(true); setMessage('');
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
    <div className="settings-entry"><div className="settings-entry-copy"><strong>办公网</strong><span>课程表与 GPA 使用，连接时需要图片验证码。{unlocked && hasOfficeAccount(unlocked) ? ` 账号 ${unlocked.officeUsername}` : ''}</span></div><div className="settings-entry-action"><span className="settings-value">{status(hasOfficeAccount(unlocked))}</span></div></div>
    <p className="settings-model-hint">两个账号相互独立，只绑定需要的那个即可。账号只保存在这台设备上，用独立口令加密（AES-GCM），解锁后才在内存中使用。</p>

    {editing || !exists ? <form className="settings-model-form" onSubmit={event => void save(event)}>
      <h3>{exists ? '更换绑定' : '绑定账号'}</h3>
      <label><span>微北洋账号<em>可选</em></span><input autoComplete="off" {...field('wpyUsername')} /></label>
      <label><span>微北洋密码</span><input type="password" autoComplete="new-password" {...field('wpyPassword')} /></label>
      <label><span>办公网账号<em>可选</em></span><input autoComplete="off" {...field('officeUsername')} /></label>
      <label><span>办公网密码</span><input type="password" autoComplete="new-password" {...field('officePassword')} /></label>
      <label><span>本地解锁口令</span><input type="password" autoComplete="new-password" minLength={12} placeholder="至少 12 位" value={passphrase} onChange={event => setPassphrase(event.target.value)} required /></label>
      {message ? <p className="settings-notice" role="status">{message}</p> : null}
      <div className="settings-model-actions">
        {exists ? <button type="button" className="settings-action-button" onClick={() => { setEditing(false); setForm(empty); }}>取消</button> : null}
        <button type="submit" className="settings-action-button is-primary" disabled={busy}><LockKeyhole size={14} /> 加密保存</button>
      </div>
    </form> : unlocked ? <div className="settings-model-actions campus-accounts-actions">
      <button type="button" className="settings-action-button" onClick={edit}>更换绑定</button>
      <button type="button" className="settings-action-button" onClick={() => publishCampusCredentials(identity, null)}><LockKeyhole size={14} /> 锁定</button>
    </div> : <form className="settings-model-form" onSubmit={event => void unlock(event)}>
      <label><span>本地解锁口令</span><input type="password" autoComplete="off" value={passphrase} onChange={event => setPassphrase(event.target.value)} /></label>
      {message ? <p className="settings-notice" role="status">{message}</p> : null}
      <div className="settings-model-actions">
        <button type="button" className="settings-action-button" onClick={() => { setForm(empty); setEditing(true); }}>更换绑定</button>
        <button type="submit" className="settings-action-button is-primary" disabled={busy || !passphrase}><UnlockKeyhole size={14} /> 解锁</button>
      </div>
    </form>}
    {!editing && message && (unlocked || !exists) ? <p className="settings-model-saved" role="status">{message}</p> : null}
    {exists ? <button type="button" className="settings-action-button is-danger campus-accounts-forget" onClick={forget}><Trash2 size={14} /> 删除本地绑定</button> : null}
  </section>;
}
