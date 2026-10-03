import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Maximize2, Minus, Network, Plus, Search, X } from 'lucide-react';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { getEntry, type Entry } from '../lib/library';
import { attempt } from '../lib/attempt';
import './knowledge-graph.css';

const MAX_NOTES = 120;
const MIN_SCALE = 0.2;
const MAX_SCALE = 4;

type Point = { x: number; y: number };
type View = { x: number; y: number; scale: number };
type Link = { source: number; target: number };

/** Notes linked by [[title]] or [[title|label]] in their bodies. */
function linksOf(notes: Entry[]): Link[] {
  const byTitle = new Map(notes.map((note, index) => [note.title.trim(), index]));
  const seen = new Set<string>();
  const links: Link[] = [];
  notes.forEach((note, source) => {
    for (const match of (note.body ?? '').matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
      const target = byTitle.get(match[1].trim());
      if (target === undefined || target === source) continue;
      const key = source < target ? `${source}:${target}` : `${target}:${source}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ source, target });
    }
  });
  return links;
}

/**
 * A force-directed layout: nodes repel, links pull, a weak gravity keeps the
 * graph together. It starts from a golden-angle spiral, so the same notes
 * always settle the same way.
 */
function layout(count: number, links: Link[]): Point[] {
  const points = Array.from({ length: count }, (_, index) => {
    const angle = index * 2.399963229728653;
    const radius = 26 * Math.sqrt(index + 0.5);
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  });
  if (count < 2) return points;
  const degree = new Array<number>(count).fill(0);
  for (const link of links) { degree[link.source]++; degree[link.target]++; }
  const ideal = 70;
  for (let step = 0; step < 320; step++) {
    const heat = 1 - step / 320;
    const force = points.map(() => ({ x: 0, y: 0 }));
    for (let a = 0; a < count; a++) {
      for (let b = a + 1; b < count; b++) {
        let dx = points[a].x - points[b].x;
        let dy = points[a].y - points[b].y;
        let distance = Math.hypot(dx, dy);
        if (distance < 0.01) { dx = 0.01 * (a - b); dy = 0.01; distance = 0.02; }
        const push = (ideal * ideal) / distance;
        force[a].x += (dx / distance) * push; force[a].y += (dy / distance) * push;
        force[b].x -= (dx / distance) * push; force[b].y -= (dy / distance) * push;
      }
    }
    for (const { source, target } of links) {
      const dx = points[target].x - points[source].x;
      const dy = points[target].y - points[source].y;
      const distance = Math.max(Math.hypot(dx, dy), 0.01);
      const pull = (distance * distance) / ideal;
      force[source].x += (dx / distance) * pull; force[source].y += (dy / distance) * pull;
      force[target].x -= (dx / distance) * pull; force[target].y -= (dy / distance) * pull;
    }
    for (let index = 0; index < count; index++) {
      // Unlinked notes drift outward less: gravity is stronger for them.
      const gravity = degree[index] ? 0.03 : 0.06;
      force[index].x -= points[index].x * gravity * ideal;
      force[index].y -= points[index].y * gravity * ideal;
      const length = Math.hypot(force[index].x, force[index].y);
      const limit = 12 * heat + 0.5;
      if (length > limit) { force[index].x *= limit / length; force[index].y *= limit / length; }
      points[index].x += force[index].x;
      points[index].y += force[index].y;
    }
  }
  return points;
}

export function KnowledgeGraph({ open, onOpenChange, entries, onOpenNote }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: Entry[];
  onOpenNote: (id: string) => void;
}) {
  const notes = useMemo(() => entries.filter(entry => entry.kind === 'note').slice(0, MAX_NOTES), [entries]);
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
        for (let index = 0; index < notes.length; index += 8) {
          const batch = await Promise.all(notes.slice(index, index + 8).map(note => getEntry(note.id, controller.signal)));
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
    const links = ready ? linksOf(loaded) : [];
    const degree = new Array<number>(loaded.length).fill(0);
    for (const link of links) { degree[link.source]++; degree[link.target]++; }
    const neighbours = loaded.map(() => new Set<number>());
    for (const link of links) { neighbours[link.source].add(link.target); neighbours[link.target].add(link.source); }
    return { notes: loaded, links, degree, neighbours, layout: layout(loaded.length, links) };
  }, [notes, ready, snapshot]);

  // Dragged nodes keep where they were put until the notes change.
  const [moved, setMoved] = useState<{ key: string; points: Record<number, Point> }>({ key: '', points: {} });
  const dragged = moved.key === requestKey ? moved.points : {};
  const positions = graph.layout.map((point, index) => dragged[index] ?? point);

  const [hovered, setHovered] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const found = useMemo(() => {
    const text = query.trim().toLocaleLowerCase();
    if (!text) return null;
    const index = graph.notes.findIndex(note => note.title.toLocaleLowerCase().includes(text));
    return index < 0 ? -1 : index;
  }, [query, graph.notes]);
  const focus = hovered ?? (found !== null && found >= 0 ? found : null);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const layerRef = useRef<SVGGElement | null>(null);
  const zoomLabelRef = useRef<HTMLSpanElement | null>(null);
  const view = useRef<View>({ x: 0, y: 0, scale: 1 });

  /** Applies the view straight to the DOM: panning never re-renders React. */
  const apply = useCallback(() => {
    const { x, y, scale } = view.current;
    layerRef.current?.setAttribute('transform', `translate(${x} ${y}) scale(${scale})`);
    const svg = svgRef.current;
    if (svg) {
      svg.style.setProperty('--graph-scale', String(scale));
      svg.classList.toggle('is-far', scale < 0.7);
    }
    const stage = stageRef.current;
    if (stage) {
      const grid = 22 * scale;
      stage.style.backgroundSize = `${grid}px ${grid}px`;
      stage.style.backgroundPosition = `${x}px ${y}px`;
    }
    if (zoomLabelRef.current) zoomLabelRef.current.textContent = `${Math.round(scale * 100)}%`;
  }, []);

  const zoomAt = useCallback((factor: number, at?: Point) => {
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const point = at ?? { x: rect.width / 2, y: rect.height / 2 };
    const current = view.current;
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * factor));
    const ratio = scale / current.scale;
    view.current = { scale, x: point.x - (point.x - current.x) * ratio, y: point.y - (point.y - current.y) * ratio };
    apply();
  }, [apply]);

  const fit = useCallback(() => {
    const stage = stageRef.current;
    if (!stage || positions.length === 0) return;
    const rect = stage.getBoundingClientRect();
    const xs = positions.map(point => point.x);
    const ys = positions.map(point => point.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const pad = 64;
    const scale = Math.min(1.6, Math.max(MIN_SCALE, Math.min((rect.width - pad * 2) / Math.max(maxX - minX, 1), (rect.height - pad * 2) / Math.max(maxY - minY, 1))));
    view.current = { scale, x: rect.width / 2 - ((minX + maxX) / 2) * scale, y: rect.height / 2 - ((minY + maxY) / 2) * scale };
    apply();
  }, [positions, apply]);

  const centreOn = useCallback((index: number) => {
    const stage = stageRef.current;
    const point = positions[index];
    if (!stage || !point) return;
    const rect = stage.getBoundingClientRect();
    const scale = Math.max(view.current.scale, 1.2);
    view.current = { scale, x: rect.width / 2 - point.x * scale, y: rect.height / 2 - point.y * scale };
    apply();
  }, [positions, apply]);

  // Fit whenever a new set of notes is laid out, once the stage has a size.
  const fitted = useRef('');
  useEffect(() => {
    if (!open || fitted.current === `${requestKey}:${ready}`) return;
    const frame = requestAnimationFrame(() => { fit(); fitted.current = `${requestKey}:${ready}`; });
    return () => cancelAnimationFrame(frame);
  }, [open, requestKey, ready, fit]);

  useEffect(() => {
    if (found !== null && found >= 0) centreOn(found);
  }, [found, centreOn]);

  // The wheel zooms around the pointer (and a trackpad pinch arrives as a ctrl-wheel).
  useEffect(() => {
    const stage = stageRef.current;
    if (!open || !stage) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      zoomAt(Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0022)), { x: event.clientX - rect.left, y: event.clientY - rect.top });
    };
    stage.addEventListener('wheel', wheel, { passive: false });
    return () => stage.removeEventListener('wheel', wheel);
  }, [open, zoomAt, snapshot]);

  // Pointers: one drags the background or a node, two pinch.
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ kind: 'pan' | 'node' | 'pinch'; node?: number; start: Point; origin: View; moved: boolean; distance?: number; mid?: Point } | null>(null);
  const local = (event: { clientX: number; clientY: number }) => {
    const rect = stageRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const point = local(event);
    pointers.current.set(event.pointerId, point);
    event.currentTarget.setPointerCapture(event.pointerId);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { kind: 'pinch', start: point, origin: { ...view.current }, moved: true, distance: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      return;
    }
    const node = (event.target as Element).closest<SVGGElement>('[data-node]');
    gesture.current = { kind: node ? 'node' : 'pan', node: node ? Number(node.dataset.node) : undefined, start: point, origin: { ...view.current }, moved: false };
  }

  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const active = gesture.current;
    if (!active || !pointers.current.has(event.pointerId)) return;
    const point = local(event);
    pointers.current.set(event.pointerId, point);
    if (active.kind === 'pinch' && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      zoomAt(distance / (active.distance || distance), mid);
      view.current = { ...view.current, x: view.current.x + mid.x - active.mid!.x, y: view.current.y + mid.y - active.mid!.y };
      apply();
      active.distance = distance;
      active.mid = mid;
      return;
    }
    const dx = point.x - active.start.x;
    const dy = point.y - active.start.y;
    if (!active.moved && Math.hypot(dx, dy) < 4) return;
    active.moved = true;
    if (active.kind === 'pan') {
      view.current = { ...view.current, x: active.origin.x + dx, y: active.origin.y + dy };
      apply();
    } else if (active.kind === 'node' && active.node !== undefined) {
      const { x, y, scale } = view.current;
      const index = active.node;
      setMoved(current => ({ key: requestKey, points: { ...(current.key === requestKey ? current.points : {}), [index]: { x: (point.x - x) / scale, y: (point.y - y) / scale } } }));
    }
  }

  function pointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    pointers.current.delete(event.pointerId);
    const active = gesture.current;
    if (pointers.current.size > 0) {
      // One finger of a pinch lifted: continue as a pan from here.
      const [rest] = [...pointers.current.values()];
      gesture.current = { kind: 'pan', start: rest, origin: { ...view.current }, moved: true };
      return;
    }
    gesture.current = null;
    if (active?.kind === 'node' && !active.moved && active.node !== undefined && event.type === 'pointerup') openNote(active.node);
  }

  function openNote(index: number) {
    const note = graph.notes[index];
    if (!note) return;
    onOpenNote(note.id);
  }

  function keyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if ((event.target as Element).closest('input')) return;
    if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomAt(1.25); }
    else if (event.key === '-' || event.key === '_') { event.preventDefault(); zoomAt(0.8); }
    else if (event.key === '0') { event.preventDefault(); fit(); }
  }

  const linkCount = graph.links.length;
  const orphanCount = graph.degree.filter(value => value === 0).length;
  const touch = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
  const radius = (index: number) => 4.5 + Math.sqrt(graph.degree[index]) * 2.6;
  const status = graph.notes.length && !ready ? failed ? '链接读取失败' : '正在读取链接…' : `${linkCount} 条链接${orphanCount ? ` · ${orphanCount} 篇未链接` : ''}`;

  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="knowledge-graph-dialog" onKeyDown={keyDown}
    onOpenAutoFocus={event => { event.preventDefault(); (event.currentTarget as HTMLElement | null)?.focus(); }}>
    <header className="graph-header">
      <div className="graph-heading">
        <DialogTitle>知识图谱</DialogTitle>
        <DialogDescription>{graph.notes.length} 篇笔记 · {status}</DialogDescription>
      </div>
      {graph.notes.length ? <label className="graph-search">
        <Search size={14} aria-hidden="true" />
        <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="查找笔记" aria-label="在图谱中查找笔记" />
        {found === -1 ? <span className="graph-search-miss" role="status">无匹配</span> : null}
      </label> : null}
      <DialogClose asChild><button type="button" className="graph-close" aria-label="关闭知识图谱"><X size={17} /></button></DialogClose>
    </header>
    {failed ? <div className="graph-empty" role="alert"><Network size={28} /><p>暂时无法读取笔记链接</p><button type="button" onClick={() => setRetry(value => value + 1)}>重试加载</button></div>
      : graph.notes.length ? <div ref={stageRef} className="graph-stage" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp}
        onDoubleClick={event => { if (!(event.target as Element).closest('[data-node]')) zoomAt(1.6, local(event)); }}>
        <svg ref={svgRef} className={`graph-canvas${focus !== null ? ' has-focus' : ''}`} role="group" aria-label="笔记关系图">
          <g ref={layerRef}>
            {graph.links.map(({ source, target }) => {
              const lit = focus !== null && (source === focus || target === focus);
              return <line key={`${source}-${target}`} className={`graph-edge${lit ? ' is-lit' : ''}`}
                x1={positions[source].x} y1={positions[source].y} x2={positions[target].x} y2={positions[target].y} />;
            })}
            {graph.notes.map((note, index) => {
              const lit = focus === null || index === focus || graph.neighbours[focus]?.has(index);
              const major = graph.degree[index] >= 3;
              return <g key={note.id} data-node={index} className={`graph-node${lit ? '' : ' is-dim'}${index === focus ? ' is-focus' : ''}${graph.degree[index] ? '' : ' is-orphan'}${major ? ' is-major' : ''}`}
                transform={`translate(${positions[index].x} ${positions[index].y})`}
                tabIndex={0} role="button" aria-label={`打开笔记 ${note.title || '未命名笔记'}`}
                onPointerEnter={() => setHovered(index)} onPointerLeave={() => setHovered(current => current === index ? null : current)}
                onFocus={() => setHovered(index)} onBlur={() => setHovered(current => current === index ? null : current)}
                onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openNote(index); } }}>
                <circle className="graph-hit" r={Math.max(radius(index) + 8, 14)} />
                <circle className="graph-dot" r={radius(index)} />
                <text y={radius(index) + 13}>{(note.title || '未命名笔记').length > 18 ? `${(note.title || '未命名笔记').slice(0, 18)}…` : note.title || '未命名笔记'}</text>
              </g>;
            })}
          </g>
        </svg>
        <div className="graph-controls" role="toolbar" aria-label="缩放" onPointerDown={event => event.stopPropagation()}>
          <button type="button" aria-label="缩小" onClick={() => zoomAt(0.8)}><Minus size={15} /></button>
          <span ref={zoomLabelRef} className="graph-zoom" aria-live="polite">100%</span>
          <button type="button" aria-label="放大" onClick={() => zoomAt(1.25)}><Plus size={15} /></button>
          <span className="graph-controls-rule" aria-hidden="true" />
          <button type="button" aria-label="适应窗口" onClick={fit}><Maximize2 size={14} /></button>
        </div>
        <p className="graph-hint">{touch ? '双指缩放 · 拖动平移 · 轻点打开笔记' : '滚轮缩放 · 拖动画布平移 · 拖动节点调整 · 点击打开笔记'}</p>
      </div> : <div className="graph-empty"><Network size={28} /><p>还没有笔记</p><span>在笔记正文里写 [[笔记标题]] 链接其他笔记，这里会画出它们之间的关系。</span></div>}
  </DialogContent></Dialog>;
}
