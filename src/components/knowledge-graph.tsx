import { useEffect, useMemo, useState } from 'react';
import { Network, X } from 'lucide-react';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { getEntry, type Entry } from '../lib/library';
import { attempt } from '../lib/attempt';

export function KnowledgeGraph({ open, onOpenChange, entries, onOpenNote }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: Entry[];
  onOpenNote: (id: string) => void;
}) {
  const notes = useMemo(() => entries.filter(entry => entry.kind === 'note').slice(0, 48), [entries]);
  const revisionKey = notes.map(note => `${note.id}:${note.updated_at}`).join('|');
  const [retry, setRetry] = useState(0);
  const requestKey = `${revisionKey}:${retry}`;
  const [snapshot, setSnapshot] = useState<{ key: string; notes: Entry[]; error: boolean } | null>(null);

  useEffect(() => {
    if (!open || notes.length === 0) return;
    const controller = new AbortController();
    void (async () => {
      return await attempt(async () => {
        const loaded: Entry[] = [];
        for (let index = 0; index < notes.length; index += 6) {
          const batch = await Promise.all(notes.slice(index, index + 6).map(note => getEntry(note.id, controller.signal)));
          if (batch.some((entry, offset) => entry.id !== notes[index + offset].id)) throw new Error('Graph entry changed');
          loaded.push(...batch);
        }
        if (!controller.signal.aborted) setSnapshot({ key: requestKey, notes: loaded, error: false });
      }, async () => {
        if (!controller.signal.aborted) setSnapshot({ key: requestKey, notes: [], error: true });
      });
    })();
    return () => controller.abort();
  }, [open, notes, requestKey]);

  const ready = open && snapshot?.key === requestKey && !snapshot.error;
  const failed = open && snapshot?.key === requestKey && snapshot.error;
  const graph = useMemo(() => {
    const loaded = ready ? snapshot.notes : notes;
    const positions = loaded.map((_, index) => {
      const angle = index * 2.399963229728653;
      const radius = Math.sqrt(index + 0.5) / Math.sqrt(Math.max(loaded.length, 1)) * 170;
      return { x: 320 + Math.cos(angle) * radius, y: 210 + Math.sin(angle) * radius };
    });
    const links = ready ? loaded.flatMap((entry, source) => [...(entry.body ?? '').matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].flatMap(match => {
      const target = loaded.findIndex(note => note.title === match[1]);
      return target < 0 || target === source ? [] : [{ source, target }];
    })) : [];
    return { notes: loaded, positions, links };
  }, [notes, ready, snapshot]);

  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="knowledge-graph-dialog">
    <header className="graph-header"><div><DialogTitle>知识图谱</DialogTitle><DialogDescription>{graph.notes.length} 篇笔记 · {graph.notes.length && !ready ? failed ? '链接读取失败' : '正在加载链接…' : `${graph.links.length} 条双向链接`}{entries.filter(entry => entry.kind === 'note').length > 48 ? ' · 仅显示前 48 篇' : ''}</DialogDescription></div><DialogClose asChild><button type="button" aria-label="关闭知识图谱"><X size={17} /></button></DialogClose></header>
    {failed ? <div className="graph-empty" role="alert"><Network size={26} /><p>暂时无法读取笔记链接</p><button type="button" onClick={() => setRetry(value => value + 1)}>重试加载</button></div> : graph.notes.length && !ready ? <div className="graph-empty" role="status"><Network size={26} /><p>正在读取笔记链接…</p></div> : graph.notes.length ? <div className="graph-stage"><svg viewBox="0 0 640 420" role="img" aria-label="笔记及其双向链接的图形视图">
      {graph.links.map(({ source, target }, index) => <line key={`${source}-${target}-${index}`} className="graph-edge" x1={graph.positions[source].x} y1={graph.positions[source].y} x2={graph.positions[target].x} y2={graph.positions[target].y} />)}
      {graph.notes.map((note, index) => <g key={note.id} className="graph-node" tabIndex={0} role="button" aria-label={`打开笔记 ${note.title}`} onClick={() => onOpenNote(note.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpenNote(note.id); } }}>
        <circle cx={graph.positions[index].x} cy={graph.positions[index].y} r={graph.links.some(link => link.source === index || link.target === index) ? 8 : 6} />
        <text x={graph.positions[index].x + 12} y={graph.positions[index].y + 4}>{note.title.slice(0, 12)}</text>
      </g>)}
    </svg></div> : <div className="graph-empty"><Network size={26} /><p>还没有笔记</p><span>创建笔记后，这里会显示它们之间的连接。</span></div>}
    <p className="graph-hint">连接来自笔记正文里的 [[笔记标题]]。点击节点打开笔记。</p>
  </DialogContent></Dialog>;
}
