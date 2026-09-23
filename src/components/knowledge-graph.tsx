import { useMemo } from 'react';
import { Network, X } from 'lucide-react';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import type { Entry } from '../lib/library';

export function KnowledgeGraph({ open, onOpenChange, entries, onOpenNote }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: Entry[];
  onOpenNote: (id: string) => void;
}) {
  const graph = useMemo(() => {
    const notes = entries.filter(entry => entry.kind === 'note').slice(0, 48);
    const positions = notes.map((_, index) => {
      const angle = index * 2.399963229728653;
      const radius = Math.sqrt(index + 0.5) / Math.sqrt(Math.max(notes.length, 1)) * 170;
      return { x: 320 + Math.cos(angle) * radius, y: 210 + Math.sin(angle) * radius };
    });
    const links = notes.flatMap((entry, source) => [...(entry.body ?? '').matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].flatMap(match => {
      const target = notes.findIndex(note => note.title === match[1]);
      return target < 0 || target === source ? [] : [{ source, target }];
    }));
    return { notes, positions, links };
  }, [entries]);

  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="knowledge-graph-dialog">
    <header className="graph-header"><div><DialogTitle>知识图谱</DialogTitle><DialogDescription>{graph.notes.length} 篇笔记 · {graph.links.length} 条双向链接{entries.filter(entry => entry.kind === 'note').length > 48 ? ' · 仅显示前 48 篇' : ''}</DialogDescription></div><DialogClose asChild><button type="button" aria-label="关闭知识图谱"><X size={17} /></button></DialogClose></header>
    {graph.notes.length ? <div className="graph-stage"><svg viewBox="0 0 640 420" role="img" aria-label="笔记及其双向链接的图形视图">
      {graph.links.map(({ source, target }, index) => <line key={`${source}-${target}-${index}`} className="graph-edge" x1={graph.positions[source].x} y1={graph.positions[source].y} x2={graph.positions[target].x} y2={graph.positions[target].y} />)}
      {graph.notes.map((note, index) => <g key={note.id} className="graph-node" tabIndex={0} role="button" aria-label={`打开笔记 ${note.title}`} onClick={() => onOpenNote(note.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpenNote(note.id); } }}>
        <circle cx={graph.positions[index].x} cy={graph.positions[index].y} r={graph.links.some(link => link.source === index || link.target === index) ? 8 : 6} />
        <text x={graph.positions[index].x + 12} y={graph.positions[index].y + 4}>{note.title.slice(0, 12)}</text>
      </g>)}
    </svg></div> : <div className="graph-empty"><Network size={26} /><p>还没有笔记</p><span>创建笔记后，这里会显示它们之间的连接。</span></div>}
    <p className="graph-hint">连接来自笔记正文里的 [[笔记标题]]。点击节点打开笔记。</p>
  </DialogContent></Dialog>;
}
