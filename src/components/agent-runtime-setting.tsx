import { useEffect, useState } from 'react';
import { Cloud, HardDrive, Loader2 } from 'lucide-react';
import { agentRuntime, ensureLocalSandbox, localSandboxStatus, localSandboxSupported, setAgentRuntime, type AgentRuntime, type LocalSandboxStatus } from '../lib/local-sandbox';
import { describeLibraryError } from '../lib/library';

/** Desktop only: run Agent turns in the cloud sandbox or in Docker on this computer. */
export function AgentRuntimeSetting() {
  const [runtime, setRuntime] = useState<AgentRuntime>(agentRuntime);
  const [status, setStatus] = useState<LocalSandboxStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!localSandboxSupported()) return;
    let cancelled = false;
    localSandboxStatus().then(value => { if (!cancelled) setStatus(value); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [runtime]);

  if (!localSandboxSupported()) return null;

  const choose = (next: AgentRuntime) => {
    setAgentRuntime(next);
    setRuntime(next);
    setMessage('');
    if (next !== 'local') return;
    setBusy(true);
    ensureLocalSandbox()
      .then(() => { setMessage('本机沙箱已就绪，新的对话会在这台电脑上运行。'); return localSandboxStatus().then(setStatus); })
      .catch(error => setMessage(describeLibraryError(error)))
      .finally(() => setBusy(false));
  };

  const detail = !status ? '正在检测 Docker…'
    : !status.docker ? '没有检测到 Docker。安装并启动 Docker Desktop 后即可使用本机沙箱。'
    : status.running ? '本机沙箱正在运行。'
    : status.images ? 'Docker 已就绪。' : 'Docker 已就绪；首次启用会下载沙箱镜像（约数百 MB）。';

  return <>
    <h3>Agent 运行位置</h3>
    <div className="settings-entry">
      <div className="settings-entry-copy">
        <strong>{runtime === 'local' ? '本机沙箱' : '云端沙箱'}</strong>
        <span>{runtime === 'local'
          ? 'Agent 的命令和文件在这台电脑的 Docker 容器里运行，容器与互联网隔离；模型、笔记工具和额度仍由 TJUClaw 提供。'
          : 'Agent 在 TJUClaw 云端的隔离沙箱里运行。'} {detail}</span>
      </div>
      <div className="settings-entry-action">
        <div className="settings-segments" role="group" aria-label="Agent 运行位置">
          <button type="button" aria-pressed={runtime === 'cloud'} onClick={() => choose('cloud')}><Cloud size={15} />云端</button>
          <button type="button" aria-pressed={runtime === 'local'} disabled={busy || status?.docker === false} onClick={() => choose('local')}>
            {busy ? <Loader2 className="animate-spin" size={15} /> : <HardDrive size={15} />}本机
          </button>
        </div>
      </div>
    </div>
    {message ? <p className={runtime === 'local' && !message.startsWith('本机沙箱已就绪') ? 'settings-notice' : 'settings-model-saved'} role="status">{message}</p> : null}
  </>;
}
