import { useEffect, useRef, useState } from 'react';
import { ArrowRight, GitBranch, History, Loader2, Lock, Network, Search, Sparkles, type LucideIcon } from 'lucide-react';
import { createSession, listSessions, type ChatSession } from '../lib/library';
import { SandboxNotes } from './sandbox-notes';
import { PrivateNotebook } from './private-notebook';
import './sandbox-notes.css';

const MODES: { id: 'git' | 'private'; title: string; detail: string; icon: LucideIcon }[] = [
  { id: 'git', title: '协作笔记', detail: 'Agent 能读写、检索和整理，每次保存都留下版本', icon: GitBranch },
  { id: 'private', title: '私密笔记', detail: '在你的设备上加密，服务器只保存密文', icon: Lock },
];

const FEATURES: { label: string; icon: LucideIcon }[] = [
  { label: '版本历史', icon: History },
  { label: '全文检索', icon: Search },
  { label: '双向链接图谱', icon: Network },
  { label: 'Agent 协作', icon: Sparkles },
];

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
      if (!controller.signal.aborted) setError('暂时无法打开 Git 笔记，请稍后重试。');
    } finally {
      if (!controller.signal.aborted) setConnecting(false);
    }
  };

  const opened = mode === 'private' || Boolean(session);
  return <section className={`git-workspace-page${opened ? ' is-open' : ''}`} aria-label="Git 笔记">
    <header className="git-hero">
      <span className="git-hero-mark"><GitBranch size={22} /></span>
      <div>
        <h1>Git 笔记</h1>
        <p>每一次保存都是一次提交，随时回到任何一个版本。</p>
      </div>
    </header>
    <div className="git-modes" role="group" aria-label="笔记类型">
      {MODES.map(({ id, title, detail, icon: Icon }) => (
        <button key={id} type="button" className="git-mode" aria-pressed={mode === id} onClick={() => setMode(id)}>
          <span className="git-mode-icon"><Icon size={18} /></span>
          <span className="git-mode-text"><strong>{title}</strong><small>{detail}</small></span>
        </button>
      ))}
    </div>
    {mode === 'private' ? <PrivateNotebook key={`${ownerId}:${workspaceId}`} ownerId={ownerId} workspaceId={workspaceId} />
      : session ? <SandboxNotes key={`${ownerId}:${session.id}`} sessionId={session.id} ownerId={ownerId}
        entryId={agentId!} preset={preset ?? ''} />
        : <div className="git-workspace-connect">
          <ul className="git-features" aria-label="协作笔记能做什么">
            {FEATURES.map(({ label, icon: Icon }) => <li key={label}><Icon size={15} aria-hidden="true" />{label}</li>)}
          </ul>
          {agentId ? <>
            {error ? <p className="sandbox-notes-error" role="alert">{error}</p> : null}
            <button type="button" className="git-open" onClick={() => void connect()} disabled={connecting}>
              {connecting ? <Loader2 size={16} className="animate-spin" /> : null}
              {connecting ? '正在准备你的笔记…' : error ? '重试' : '打开协作笔记'}
              {connecting ? null : <ArrowRight size={16} />}
            </button>
            <p className="git-open-note">首次打开需要几秒钟准备你的笔记仓库。</p>
          </> : <p className="git-open-note">先在知识库里添加一个 Agent，就能开始使用协作笔记。</p>}
        </div>}
  </section>;
}
