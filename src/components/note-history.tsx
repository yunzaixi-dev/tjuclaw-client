import { useEffect, useState } from 'react';
import { GitCommitHorizontal, History, Loader2, RotateCcw, X } from 'lucide-react';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { getNoteHistory, getNoteRevision, type NoteCommit } from '../lib/git-history';
import './note-history.css';

function when(date: string) {
  const at = new Date(date);
  if (Number.isNaN(at.getTime())) return date;
  return at.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** A note's Git history: every saved version is a commit in the owner's repository. */
export function NoteHistory({ entryId, title, open, onOpenChange, current, renderMarkdown, onRestore }: {
  entryId: string;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: string;
  renderMarkdown: (markdown: string) => string;
  onRestore: (content: string) => void;
}) {
  const [commits, setCommits] = useState<NoteCommit[] | null>(null);
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  // Mounted only while open (keyed by note), so the initial state is fresh.
  useEffect(() => {
    const controller = new AbortController();
    getNoteHistory(entryId, controller.signal)
      .then(result => { setCommits(result.commits); setPath(result.path); if (result.commits[0]) setSelected(result.commits[0].sha); })
      .catch(() => { if (!controller.signal.aborted) setError('暂时读不到这篇笔记的 Git 历史，请稍后再试。'); });
    return () => controller.abort();
  }, [entryId]);

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="note-versions" aria-describedby="note-versions-path">
      <header className="note-versions-head">
        <History size={16} aria-hidden="true" />
        <DialogTitle>版本历史 · {title || '未命名笔记'}</DialogTitle>
        <DialogClose className="note-versions-close" aria-label="关闭版本历史"><X size={16} /></DialogClose>
      </header>
      <DialogDescription id="note-versions-path" className="note-versions-path">{path ? `Git 仓库中的 ${path}` : '每次保存都会提交到你的 Git 仓库。'}</DialogDescription>
      <div className="note-versions-body">
        <ol className="note-versions-list" aria-label="提交记录">
          {commits === null && !error ? <li className="note-versions-state"><Loader2 className="animate-spin" size={14} /> 正在读取…</li> : null}
          {error ? <li className="note-versions-state" role="alert">{error}</li> : null}
          {commits?.length === 0 ? <li className="note-versions-state">还没有提交记录，保存后会出现在这里。</li> : null}
          {commits?.map((commit, index) => <li key={commit.sha}>
            <button type="button" aria-pressed={selected === commit.sha} onClick={() => setSelected(commit.sha)}>
              <GitCommitHorizontal size={14} aria-hidden="true" />
              <span><strong>{index === 0 ? '当前版本' : when(commit.date)}</strong><small>{index === 0 ? when(commit.date) : commit.message} · {commit.sha.slice(0, 7)}</small></span>
            </button>
          </li>)}
        </ol>
        {selected ? <RevisionPreview key={selected} entryId={entryId} revision={selected} current={current} renderMarkdown={renderMarkdown}
          onRestore={content => { onRestore(content); onOpenChange(false); }} />
          : <section className="note-versions-preview" aria-label="版本内容"><p className="note-versions-state">选择左侧的一个版本查看内容。</p></section>}
      </div>
    </DialogContent>
  </Dialog>;
}

function RevisionPreview({ entryId, revision, current, renderMarkdown, onRestore }: {
  entryId: string;
  revision: string;
  current: string;
  renderMarkdown: (markdown: string) => string;
  onRestore: (content: string) => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    getNoteRevision(entryId, revision, controller.signal)
      .then(setContent)
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [entryId, revision]);
  return <section className="note-versions-preview" aria-label="版本内容">
    {failed ? <p className="note-versions-state" role="alert">打不开这个版本，请稍后再试。</p>
      : content === null ? <p className="note-versions-state"><Loader2 className="animate-spin" size={14} /> 正在打开这个版本…</p>
      : <>
        <div className="markdown-preview" dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
        <footer>
          {content === current ? <span>与当前内容相同</span> : <button type="button" onClick={() => onRestore(content)}><RotateCcw size={14} aria-hidden="true" />恢复为此版本</button>}
        </footer>
      </>}
  </section>;
}
