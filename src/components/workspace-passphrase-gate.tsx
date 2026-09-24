import { useState, type FormEvent } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  AlertTriangle,
  Check,
  Download,
  KeyRound,
  LibraryBig,
} from 'lucide-react';
import { createLibrary, type Library } from '../lib/library';
import {
  createWorkspacePassphrase,
  markWorkspaceUnlocked,
  MAX_WORKSPACE_PASSPHRASE_LENGTH,
  MIN_WORKSPACE_PASSPHRASE_LENGTH,
  unlockWorkspace,
} from '../lib/workspace-vault';

type WorkspacePassphraseGateProps = {
  identity: string;
  workspaceId: string | null;
  workspaceName: string;
  mode: 'setup' | 'unlock';
  firstWorkspace?: boolean;
  onUnlocked: (workspace?: Library) => Promise<void> | void;
};

type GateStage = 'form' | 'backup';

function describeError(error: unknown) {
  if (!(error instanceof Error)) return '当前设备无法完成安全验证，请稍后重试。';
  switch (error.message) {
    case 'workspace_passphrase_too_short': return `口令至少需要 ${MIN_WORKSPACE_PASSPHRASE_LENGTH} 个字符。`;
    case 'workspace_passphrase_too_long': return `口令最多支持 ${MAX_WORKSPACE_PASSPHRASE_LENGTH} 个字符。`;
    case 'workspace_passphrase_exists': return '这个工作区已经创建过口令，请直接解锁。';
    case 'workspace_passphrase_invalid': return '口令错误，或本地验证材料已损坏。';
    case 'workspace_crypto_unavailable': return '当前环境不支持安全加密，无法打开工作区。';
    default: return '当前设备无法完成安全验证，请稍后重试。';
  }
}

function downloadPassphraseBackup(workspaceId: string, workspaceName: string, passphrase: string) {
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
    '- 口令丢失后不可找回，创建后不可修改。',
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
  firstWorkspace = false,
  onUnlocked,
}: WorkspacePassphraseGateProps) {
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
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
      setError('请确认你已了解口令丢失后无法找回。');
      return;
    }
    setBusy(true);
    setError('');
    try {
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
        await createWorkspacePassphrase(identity, target.id, passphrase);
        markWorkspaceUnlocked(identity, target.id);
        downloadPassphraseBackup(target.id, target.name, passphrase);
        setDownloaded(true);
        setStage('backup');
      } else {
        await unlockWorkspace(identity, target.id, passphrase);
        markWorkspaceUnlocked(identity, target.id);
        await onUnlocked();
      }
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  function handleDownload() {
    const target = createdWorkspace ?? (workspaceId && workspaceName ? { id: workspaceId, name: workspaceName } : null);
    if (!passphrase || !target) return;
    downloadPassphraseBackup(target.id, target.name, passphrase);
    setDownloaded(true);
  }

  async function enterWorkspace() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onUnlocked(createdWorkspace ?? undefined);
    } catch (cause) {
      setError(describeError(cause));
      setBusy(false);
    }
  }

  return (
    <main className="workspace-vault-screen">
      <motion.section
        className="workspace-vault-card"
        aria-labelledby="workspace-vault-title"
        initial={{ opacity: 0, y: reduceMotion ? 0 : 14, scale: reduceMotion ? 1 : 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={transition}
      >
        <AnimatePresence initial={false} mode="wait">
          {stage === 'backup' ? (
            <motion.div
              key="backup"
              className="workspace-vault-stage"
              initial={{ opacity: 0, x: reduceMotion ? 0 : 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: reduceMotion ? 0 : -12 }}
              transition={transition}
            >
              <h1 id="workspace-vault-title">口令已创建</h1>
              <p className="workspace-vault-workspace">{targetWorkspace?.name}</p>
              <p className="workspace-vault-description">备份文件已下载。口令丢失后不可找回，也不能修改。</p>
              <div className="workspace-vault-warning workspace-vault-warning-caution">
                <AlertTriangle size={16} />
                <span>备份文件包含明文口令，请保存到安全位置。</span>
              </div>
              <div className="workspace-vault-actions">
                <motion.button
                  type="button"
                  className="workspace-vault-submit"
                  whileHover={reduceMotion ? undefined : { y: -1 }}
                  whileTap={reduceMotion ? undefined : { y: 1, scale: 0.99 }}
                  transition={{ duration: 0.14 }}
                  onClick={handleDownload}
                >
                  <Download size={16} />
                  {downloaded ? '再次下载口令备份' : '下载口令备份'}
                </motion.button>
                <motion.button
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
                </motion.button>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="form"
              className="workspace-vault-stage"
              initial={{ opacity: 0, x: reduceMotion ? 0 : -12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: reduceMotion ? 0 : 12 }}
              transition={transition}
            >
              <h1 id="workspace-vault-title">{firstWorkspace ? '创建工作空间' : isSetup ? '创建工作区口令' : '解锁工作区'}</h1>
              {!firstWorkspace ? <p className="workspace-vault-workspace">{targetWorkspace?.name ?? workspaceName}</p> : null}
              <p className="workspace-vault-description">
                {firstWorkspace
                  ? '首次进入，设置名称和独立口令。'
                  : isSetup
                    ? '每个工作区使用独立口令。'
                    : '输入此工作区的口令以继续。'}
              </p>
              <div className="workspace-vault-warning">
                <AlertTriangle size={16} />
                <span>{firstWorkspace ? '端到端加密保护工作区数据；口令丢失后不可找回，也不能修改。' : '口令丢失后不可找回，也不能修改。不同工作区不会共用口令。'}</span>
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
                ) : null}
                <AnimatePresence initial={false}>
                  {error ? (
                    <motion.p
                      className="workspace-vault-error"
                      role="alert"
                      initial={{ opacity: 0, y: reduceMotion ? 0 : -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: reduceMotion ? 0 : -4 }}
                      transition={transition}
                    >
                      {error}
                    </motion.p>
                  ) : null}
                </AnimatePresence>
                <motion.button
                  type="submit"
                  className="workspace-vault-submit"
                  disabled={busy || !passphrase || (firstWorkspace && !workspaceNameInput.trim()) || (isSetup && (!confirmation || !acknowledged))}
                  whileHover={reduceMotion || busy ? undefined : { y: -1 }}
                  whileTap={reduceMotion || busy ? undefined : { y: 1, scale: 0.99 }}
                  transition={{ duration: 0.14 }}
                >
                  <KeyRound size={16} />
                  {busy ? '正在处理…' : firstWorkspace || isSetup ? '创建并下载备份' : '解锁进入工作区'}
                </motion.button>
              </form>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.section>
    </main>
  );
}
