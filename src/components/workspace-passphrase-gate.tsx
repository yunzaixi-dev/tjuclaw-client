import { useState, type FormEvent } from 'react';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import {
  AlertTriangle,
  Check,
  Download,
  Info,
  KeyRound,
  LibraryBig,
  LogOut,
} from 'lucide-react';
import { BlueprintBackdrop } from './blueprint-backdrop';
import { BrandIcon } from './brand-icon';
import { describeError as describeAuthError, logout } from '../lib/auth';
import { createLibrary, type Library } from '../lib/library';
import {
  createWorkspacePassphrase,
  createRemoteWorkspacePassphrase,
  markWorkspaceUnlocked,
  REMEMBER_DAYS,
  rememberWorkspace,
  MAX_WORKSPACE_PASSPHRASE_LENGTH,
  migrateWorkspacePassphrase,
  MIN_WORKSPACE_PASSPHRASE_LENGTH,
  type WorkspacePassphraseState,
  unlockWorkspace,
  unlockRemoteWorkspace,
} from '../lib/workspace-vault';
import { VaultError } from '../lib/sealed-vault';
import { attempt } from '../lib/attempt';

type WorkspacePassphraseGateProps = {
  identity: string;
  workspaceId: string | null;
  workspaceName: string;
  mode: WorkspacePassphraseState['mode'];
  verification: WorkspacePassphraseState['verification'];
  firstWorkspace?: boolean;
  accountEmail?: string;
  onUnlocked: (workspace?: Library) => Promise<void> | void;
};

type GateStage = 'form' | 'backup';

function describeError(error: unknown) {
  if (error instanceof VaultError) {
    if (error.message === 'vault_decryption_failed') return '口令不正确，或远端验证材料已损坏。';
    if (error.status === 409) return '另一台设备已设置口令，请刷新后使用已有口令解锁。';
    return '远端口令验证暂时不可用，请稍后重试；不会切换成本地验证。';
  }
  if (!(error instanceof Error)) return '当前设备无法完成口令验证，请稍后重试。';
  switch (error.message) {
    case 'workspace_passphrase_too_short': return `口令至少需要 ${MIN_WORKSPACE_PASSPHRASE_LENGTH} 个字符。`;
    case 'workspace_passphrase_too_long': return `口令最多支持 ${MAX_WORKSPACE_PASSPHRASE_LENGTH} 个字符。`;
    case 'workspace_passphrase_exists': return '这个工作区已经创建过口令，请直接解锁。';
    case 'workspace_passphrase_invalid': return '口令错误，或此设备上的验证材料已损坏。';
    case 'workspace_crypto_unavailable': return '当前环境不支持安全加密，无法打开工作区。';
    default: return '当前设备无法完成口令验证，请稍后重试。';
  }
}

function downloadPassphraseBackup(workspaceId: string, workspaceName: string, passphrase: string, verification: WorkspacePassphraseState['verification']) {
  const safeName = workspaceName.trim().replace(/[^\w\u4e00-\u9fff-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
  const content = [
    'TJUClaw 工作区口令备份',
    `工作区: ${workspaceName}`,
    `工作区 ID: ${workspaceId}`,
    `创建时间: ${new Date().toISOString()}`,
    '',
    `口令: ${passphrase}`,
    '',
    '重要提示：',
    verification === 'remote'
      ? '- 口令验证材料已存于当前账号的私有仓库；可在另一台设备用此口令解锁，忘记后无法找回。'
      : '- 本设备不提供口令找回或修改；清理浏览器数据后可重新设置。',
    '- 口令用于解锁工作区；笔记加密存储即将推出，目前笔记尚未加密。',
    '- 此文件包含明文口令，请存放在安全位置。',
    '- 不要上传到代码仓库、公开网盘或聊天工具。',
  ].join('\n');
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `tjuclaw-${safeName}-passphrase.txt`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function WorkspacePassphraseGate({
  identity,
  workspaceId,
  workspaceName,
  mode,
  verification,
  firstWorkspace = false,
  accountEmail,
  onUnlocked,
}: WorkspacePassphraseGateProps) {
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  // Keep this device unlocked after a correct passphrase, unless the user opts out.
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stage, setStage] = useState<GateStage>('form');
  const [downloaded, setDownloaded] = useState(false);
  const [workspaceNameInput, setWorkspaceNameInput] = useState(workspaceName);
  const [createdWorkspace, setCreatedWorkspace] = useState<Library | null>(null);
  const reduceMotion = useReducedMotion();
  const targetWorkspace = createdWorkspace ?? (workspaceId && workspaceName ? { id: workspaceId, name: workspaceName } : null);
  const isSetup = mode === 'setup';

  const transition = {
    duration: reduceMotion ? 0 : 0.3,
    ease: 'easeOut' as const,
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (mode === 'setup' && passphrase !== confirmation) {
      setError('两次输入的口令不一致。');
      return;
    }
    if (mode === 'setup' && !acknowledged) {
      setError('请确认你已了解此设备不提供口令找回。');
      return;
    }
    setBusy(true);
    setError('');
    return await attempt(async () => {
      let target = targetWorkspace;
      if (isSetup && firstWorkspace && !target) {
        const name = workspaceNameInput.trim();
        if (!name) {
          setError('请输入工作空间名称。');
          setBusy(false);
          return;
        }
        const newWorkspace = await createLibrary(name);
        target = newWorkspace;
        setCreatedWorkspace(newWorkspace);
      }
      if (!target) {
        setError('当前工作空间信息不可用，请刷新后重试。');
        return;
      }
      if (mode === 'setup') {
        if (verification === 'remote') await createRemoteWorkspacePassphrase(identity, target.id, passphrase);
        else {
          await createWorkspacePassphrase(identity, target.id, passphrase);
          markWorkspaceUnlocked(identity, target.id);
        }
        // The device that just created the passphrase stays unlocked.
        rememberWorkspace(identity, target.id, verification);
        downloadPassphraseBackup(target.id, target.name, passphrase, verification);
        setDownloaded(true);
        setStage('backup');
      } else if (mode === 'migrate') {
        await migrateWorkspacePassphrase(identity, target.id, passphrase);
        if (remember) rememberWorkspace(identity, target.id, verification);
        await onUnlocked();
      } else {
        if (verification === 'remote') await unlockRemoteWorkspace(identity, target.id, passphrase);
        else {
          await unlockWorkspace(identity, target.id, passphrase);
          markWorkspaceUnlocked(identity, target.id);
        }
        if (remember) rememberWorkspace(identity, target.id, verification);
        await onUnlocked();
      }
    }, async (cause) => {
      setError(describeError(cause));
    }, async () => {
      setBusy(false);
    });
  }

  function handleDownload() {
    const target = createdWorkspace ?? (workspaceId && workspaceName ? { id: workspaceId, name: workspaceName } : null);
    if (!passphrase || !target) return;
    downloadPassphraseBackup(target.id, target.name, passphrase, verification);
    setDownloaded(true);
  }

  async function enterWorkspace() {
    if (busy) return;
    setBusy(true);
    setError('');
    return await attempt(async () => {
      await onUnlocked(createdWorkspace ?? undefined);
    }, async (cause) => {
      setError(describeError(cause));
      setBusy(false);
    });
  }

  function signOut() {
    setSigningOut(true); setSignOutError('');
    void logout().catch(cause => { setSignOutError(describeAuthError(cause)); setSigningOut(false); });
  }

  return (
    <main className="workspace-vault-screen blueprint-surface">
      <BlueprintBackdrop />
      <m.section
        className="workspace-vault-card"
        aria-labelledby="workspace-vault-title"
        initial={{ opacity: 0, y: reduceMotion ? 0 : 14, scale: reduceMotion ? 1 : 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={transition}
      >
        <AnimatePresence initial={false} mode="wait">
          {stage === 'backup' ? (
            <m.div
              key="backup"
              className="workspace-vault-stage"
              initial={{ opacity: 0, x: reduceMotion ? 0 : 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: reduceMotion ? 0 : -12 }}
              transition={transition}
            >
              <BrandIcon size={40} className="workspace-vault-logo" />
              <h1 id="workspace-vault-title">口令已创建</h1>
              <p className="workspace-vault-workspace">{targetWorkspace?.name}</p>
              <p className="workspace-vault-description">备份文件已下载。{verification === 'remote' ? '口令可在其他设备验证，但现有云端笔记并未加密。' : '此口令目前只在此设备上验证，不加密现有云端笔记。'}</p>
              <div className="workspace-vault-warning workspace-vault-warning-caution">
                <AlertTriangle size={16} />
                <span>备份文件包含明文口令，请保存到安全位置。</span>
              </div>
              <div className="workspace-vault-actions">
                <m.button
                  type="button"
                  className="workspace-vault-submit"
                  whileHover={reduceMotion ? undefined : { y: -1 }}
                  whileTap={reduceMotion ? undefined : { y: 1, scale: 0.99 }}
                  transition={{ duration: 0.14 }}
                  onClick={handleDownload}
                >
                  <Download size={16} />
                  {downloaded ? '再次下载口令备份' : '下载口令备份'}
                </m.button>
                <m.button
                  type="button"
                  className="workspace-vault-secondary"
                  whileHover={reduceMotion ? undefined : { y: -1 }}
                  whileTap={reduceMotion ? undefined : { y: 1, scale: 0.99 }}
                  transition={{ duration: 0.14 }}
                  onClick={() => void enterWorkspace()}
                  disabled={busy}
                >
                  <Check size={16} />
                  {busy ? '正在进入…' : '我已安全备份，进入工作区'}
                </m.button>
              </div>
            </m.div>
          ) : (
            <m.div
              key="form"
              className="workspace-vault-stage"
              initial={{ opacity: 0, x: reduceMotion ? 0 : -12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: reduceMotion ? 0 : 12 }}
              transition={transition}
            >
              <BrandIcon size={40} className="workspace-vault-logo" />
              <h1 id="workspace-vault-title">{firstWorkspace ? '创建工作空间' : isSetup ? '创建工作区口令' : '解锁工作区'}</h1>
              {!firstWorkspace ? <p className="workspace-vault-workspace">{targetWorkspace?.name ?? workspaceName}</p> : null}
              <p className="workspace-vault-description">
                {firstWorkspace
                  ? '首次进入，设置名称和独立口令。'
                  : isSetup
                    ? '每个工作区使用独立口令。'
                    : mode === 'migrate' ? '输入旧口令，迁移验证材料到私有仓库。' : '输入此工作区的口令以继续。'}
              </p>
              <div className="workspace-vault-warning">
                <Info size={16} />
                <span>
                  {verification === 'remote'
                    ? '口令可在你的其他设备上解锁此工作区。忘记口令将无法解锁，请妥善保存备份。'
                    : '口令用于在这台设备上解锁工作区，清理浏览器数据后可以重新设置。'}
                  <span className="workspace-vault-roadmap">可在「设置 → 模型」使用自己的模型 API。即将推出：服务器仅保存加密后的笔记，支持自建沙箱。</span>
                </span>
              </div>
              <form className="workspace-vault-form" onSubmit={submit}>
                {firstWorkspace ? (
                  <>
                    <label htmlFor="workspace-name">工作空间名称</label>
                    <div className="workspace-vault-input-wrap">
                      <LibraryBig size={16} aria-hidden="true" />
                      <input
                        id="workspace-name"
                        className="workspace-vault-name-input"
                        type="text"
                        autoFocus
                        autoComplete="off"
                        maxLength={64}
                        placeholder="例如：我的知识库"
                        value={workspaceNameInput}
                        onChange={event => { setWorkspaceNameInput(event.target.value); setError(''); }}
                        required
                      />
                    </div>
                  </>
                ) : null}
                <label htmlFor="workspace-passphrase">{isSetup ? '创建工作区口令' : '工作区口令'}</label>
                <div className="workspace-vault-input-wrap">
                  <KeyRound size={16} aria-hidden="true" />
                  <input
                    id="workspace-passphrase"
                    type="password"
                    autoFocus={!firstWorkspace}
                    autoComplete={isSetup ? 'new-password' : 'current-password'}
                    minLength={isSetup ? MIN_WORKSPACE_PASSPHRASE_LENGTH : undefined}
                    maxLength={isSetup ? MAX_WORKSPACE_PASSPHRASE_LENGTH : undefined}
                    placeholder={isSetup ? `输入 ${MIN_WORKSPACE_PASSPHRASE_LENGTH}–${MAX_WORKSPACE_PASSPHRASE_LENGTH} 个字符` : '输入此工作区口令'}
                    value={passphrase}
                    onChange={event => { setPassphrase(event.target.value); setError(''); }}
                    required
                  />
                </div>
                {isSetup ? (
                  <>
                    <label htmlFor="workspace-passphrase-confirm">再次输入口令</label>
                    <div className="workspace-vault-input-wrap">
                      <KeyRound size={16} aria-hidden="true" />
                      <input
                        id="workspace-passphrase-confirm"
                        type="password"
                        autoComplete="new-password"
                        minLength={MIN_WORKSPACE_PASSPHRASE_LENGTH}
                        maxLength={MAX_WORKSPACE_PASSPHRASE_LENGTH}
                        placeholder="再次输入以确认"
                        value={confirmation}
                        onChange={event => { setConfirmation(event.target.value); setError(''); }}
                        required
                      />
                    </div>
                    <label className="workspace-vault-check">
                      <input
                        type="checkbox"
                        checked={acknowledged}
                        onChange={event => { setAcknowledged(event.target.checked); setError(''); }}
                      />
                      <span><Check size={14} />我已了解口令规则，并准备好安全备份。</span>
                    </label>
                  </>
                ) : (
                  <label className="workspace-vault-check">
                    <input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} />
                    <span><Check size={14} />在这台设备上保持解锁 {REMEMBER_DAYS} 天</span>
                  </label>
                )}
                <AnimatePresence initial={false}>
                  {error ? (
                    <m.p
                      className="workspace-vault-error"
                      role="alert"
                      initial={{ opacity: 0, y: reduceMotion ? 0 : -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: reduceMotion ? 0 : -4 }}
                      transition={transition}
                    >
                      {error}
                    </m.p>
                  ) : null}
                </AnimatePresence>
                <m.button
                  type="submit"
                  className="workspace-vault-submit"
                  disabled={busy || !passphrase || (firstWorkspace && !workspaceNameInput.trim()) || (isSetup && (!confirmation || !acknowledged))}
                  whileHover={reduceMotion || busy ? undefined : { y: -1 }}
                  whileTap={reduceMotion || busy ? undefined : { y: 1, scale: 0.99 }}
                  transition={{ duration: 0.14 }}
                >
                  <KeyRound size={16} />
                  {busy ? '正在处理…' : firstWorkspace || isSetup ? '创建并下载备份' : mode === 'migrate' ? '迁移口令并进入工作区' : '解锁进入工作区'}
                </m.button>
              </form>
            </m.div>
          )}
        </AnimatePresence>
      </m.section>
      <div className="workspace-vault-account">
        {accountEmail ? <span className="workspace-vault-account-email" title={accountEmail}>当前账号 <strong>{accountEmail}</strong></span> : null}
        <button type="button" disabled={signingOut || busy} onClick={signOut}>
          <LogOut size={14} aria-hidden="true" />
          {signingOut ? '正在退出…' : '退出登录'}
        </button>
        {signOutError ? <p role="alert">{signOutError}</p> : null}
      </div>
    </main>
  );
}
