import { useEffect, useRef, useState } from 'react';
import { GitBranch, Loader2 } from 'lucide-react';
import { createSession, listSessions, type ChatSession } from '../lib/library';
import { SandboxNotes } from './sandbox-notes';
import { PrivateNotebook } from './private-notebook';
import './sandbox-notes.css';

export function GitWorkspace({ ownerId, workspaceId, agentId, preset }: {
  ownerId: string; workspaceId: string; agentId?: string; preset?: string;
}) {
  const [mode, setMode] = useState<'git' | 'private'>('git');
  const [session, setSession] = useState<ChatSession | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);

  const connect = async () => {
    if (!agentId || connecting) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setConnecting(true);
    setError('');
    try {
      const existing = await listSessions(agentId, controller.signal);
      const current = existing[0] ?? await createSession(agentId, controller.signal);
      if (current.entry_id !== agentId) throw new Error('会话与当前 Agent 不匹配。');
      if (!controller.signal.aborted) setSession(current);
    } catch {
      if (!controller.signal.aborted) setError('无法连接 Git 工作区，请稍后重试。');
    } finally {
      if (!controller.signal.aborted) setConnecting(false);
    }
  };

  return <section className="git-workspace-page" aria-label="Git 笔记">
    <header className="git-workspace-intro">
      <span className="git-workspace-icon"><GitBranch size={18} /></span>
      <div><h1>Git 笔记</h1><p>{mode === 'private'
        ? '私密笔记在浏览器中加解密，Forgejo 保存密文；它不属于 Agent 的明文工作树，也不会自动迁移旧笔记。'
        : '从 Forgejo 的已提交 Markdown 读取和保存。旧资料夹仍是独立的知识库，尚未迁移；当前 Git 仓库未启用端到端加密。'}</p></div>
    </header>
    <div className="git-workspace-mode" role="group" aria-label="Git 工作区存储方式">
      <button type="button" aria-pressed={mode === 'git'} onClick={() => setMode('git')}>普通 Markdown · Agent 可用</button>
      <button type="button" aria-pressed={mode === 'private'} onClick={() => setMode('private')}>私密笔记 · 浏览器解密</button>
    </div>
    {mode === 'private' ? <PrivateNotebook key={`${ownerId}:${workspaceId}`} ownerId={ownerId} workspaceId={workspaceId} />
      : !session ? <div className="git-workspace-connect">
      <p>{agentId ? '连接到现有 Agent 会话的工作区；若还没有会话，将创建一个。仅在查看文件时启动沙箱。' : '当前知识库没有可用的 Agent，暂时无法打开 Git 笔记。'}</p>
      {error ? <p className="sandbox-notes-error" role="alert">{error}</p> : null}
      {agentId ? <button type="button" onClick={() => void connect()} disabled={connecting}>
        {connecting ? <Loader2 size={14} className="animate-spin" /> : <GitBranch size={14} />}
        {connecting ? '正在连接…' : error ? '重试连接' : '连接 Git 工作区'}
      </button> : null}
    </div> : <SandboxNotes key={`${ownerId}:${session.id}`} sessionId={session.id} ownerId={ownerId}
      entryId={agentId!} preset={preset ?? ''} />}
  </section>;
}
