import { useEffect, useRef, useState } from 'react';
import { Brain } from 'lucide-react';
import { SaidText, ThinkingRow, ToolRow, groupSteps, toolView } from './agent-steps';
import { getLive, type LiveCursor } from '../lib/library';
import { formatTokenRate, mergeTimeline, stageText, timelineCursor, type TimelineItem } from '../lib/live-stream';
import './agent-live.css';

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Text that arrives in bursts, shown as a steady flow: each frame reveals a
 * share of what is still hidden, so a large burst catches up within a few
 * frames and a slow trickle stays character by character. The owner remounts
 * it (by key) when a different text starts.
 */
function useFlowingText(target: string): string {
  const [shown, setShown] = useState(0);
  const still = reducedMotion();
  useEffect(() => {
    if (still || shown >= target.length) return;
    const frame = requestAnimationFrame(() => {
      setShown(current => {
        let next = Math.min(target.length, current + Math.max(1, Math.ceil((target.length - current) / 10)));
        // Never cut a surrogate pair in half.
        const code = target.charCodeAt(next);
        if (next < target.length && code >= 0xdc00 && code <= 0xdfff) next++;
        return next;
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [shown, target, still]);
  return still ? target : target.slice(0, Math.min(shown, target.length));
}

function LiveThinking({ text, onProgress }: { text: string; onProgress?: () => void }) {
  const shown = useFlowingText(text);
  const box = useRef<HTMLParagraphElement | null>(null);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
    onProgress?.();
  }, [shown, onProgress]);
  return <div className="agent-live-thinking" aria-label="思考过程">
    <Brain size={14} aria-hidden="true" />
    <p ref={box}>{shown}</p>
  </div>;
}

function LiveText({ text, renderMarkdown, onProgress }: { text: string; renderMarkdown: (markdown: string) => string; onProgress?: () => void }) {
  const shown = useFlowingText(text);
  useEffect(() => { onProgress?.(); }, [shown, onProgress]);
  return <div className="agent-live-text chat-message-content markdown-preview" dangerouslySetInnerHTML={{ __html: renderMarkdown(shown) }} />;
}

/** Stages in which the model itself is writing, so its speed means something. */
const WRITING_STAGES = ['thinking', 'writing', 'preparing'];

/**
 * The Agent at work, laid out like the reply it becomes: the turn's thinking,
 * what the model says and each tool call, in the order they happen and as
 * they happen. Nothing shown is taken back; when the turn ends the saved
 * reply takes this place with the same rows.
 */
export function Working({ name, sessionId, stopping, renderMarkdown, onProgress }: {
  name: string;
  sessionId?: string;
  /** The user stopped the turn; it ends once the current step is done. */
  stopping?: boolean;
  renderMarkdown: (markdown: string) => string;
  /** Called as the live output grows, to keep it in view. */
  onProgress?: () => void;
}) {
  // Mounted when sending starts, so the first render marks the start.
  const [since] = useState(() => Date.now());
  const [now, setNow] = useState(since);
  const [items, setItems] = useState<TimelineItem[]>([]);
  // The server's stage and when it began on this device's clock.
  const [stage, setStage] = useState<{ id: string; at: number }>({ id: '', at: since });
  const [rate, setRate] = useState({ tokens: 0, ms: 0 });
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);
  // One long poll at a time: the server answers when the turn changes.
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    let timer = 0;
    let cursor: LiveCursor | undefined;
    let shown: TimelineItem[] = [];
    const pause = (ms: number) => new Promise<void>(resolve => { timer = window.setTimeout(resolve, ms); });
    void (async () => {
      await pause(300);
      while (!controller.signal.aborted) {
        try {
          const live = await getLive(sessionId, cursor, controller.signal);
          if (controller.signal.aborted) return;
          // Without a cursor the answer is the whole timeline.
          const merged = mergeTimeline(cursor ? shown : [], live);
          if (merged.resync) { cursor = undefined; await pause(200); continue; }
          if (live.version) {
            shown = merged.items;
            setItems(shown);
            setRate({ tokens: live.rateTokens, ms: live.rateMs });
          }
          // An idle snapshot at the end of the turn keeps the last stage shown.
          if (live.stage) {
            const began = Date.now() - live.stageMs;
            setStage(current => current.id === live.stage ? current : { id: live.stage, at: began });
          }
          // Before the turn is registered, or on a server without live output, poll gently.
          if (live.version === null) { cursor = undefined; await pause(1200); }
          else if (live.version === 0) { cursor = undefined; await pause(500); }
          else cursor = timelineCursor(live.version, shown);
        } catch {
          if (controller.signal.aborted) return;
          cursor = undefined;
          await pause(1500);
        }
      }
    })();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [sessionId]);

  const last = items.length - 1;
  const tail = last >= 0 ? items[last] : null;
  useEffect(() => { onProgress?.(); }, [items.length, tail?.text, tail?.status, tail?.lines, onProgress]);

  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const asStep = (item: TimelineItem) => ({ kind: 'tool' as const, name: item.name, input: item.input, output: item.output,
    failed: item.status === 'failed', added: item.added, removed: item.removed });
  const active = [...items].reverse().find(item => item.kind === 'tool' && (item.status === 'running' || item.status === 'writing'));
  const activeView = active ? toolView(asStep(active)) : null;
  const hasTools = items.some(item => item.kind === 'tool');
  // Honest wording: what the Agent is doing right now. The rate is separate so
  // the phase text stays an exact status.
  // The server says what the turn waits for; an older server leaves it to what is visible here.
  const reported = stageText(stage.id, now - stage.at, hasTools, activeView?.label);
  // A stop takes effect when the running step ends: say so rather than a stage.
  const phase = stopping ? (activeView ? `正在停止，等${activeView.label}结束` : '正在停止') : reported || (activeView ? `正在${activeView.label}`
    : tail?.kind === 'text' ? '正在回答' : tail?.kind === 'thinking' ? '正在思考' : hasTools ? '正在整理结果' : seconds < 6 ? '正在理解你的问题' : '正在思考');
  // The speed of the call being written now; a tool run or a wait has none.
  const speed = WRITING_STAGES.includes(stage.id) ? formatTokenRate(rate.tokens, rate.ms) : '';
  const rows = tail?.kind === 'text' ? items.slice(0, last) : items;
  return <article className="agent-working" role="status" aria-label={`${name}正在处理，已用 ${seconds} 秒`}>
    <div className="agent-reply-body">
      <header className="agent-reply-head agent-working-head"><span className="agent-reply-name agent-working-name">{name}</span><span className="agent-working-text">{phase}</span>{speed ? <span className="agent-working-rate">{speed}</span> : null}<span className="agent-working-time">{seconds} 秒</span></header>
      {groupSteps(rows).map(group => 'said' in group
        ? <SaidText key={`said:${group.index}`} text={group.said.text} renderMarkdown={renderMarkdown} />
        : <ol key={`rows:${group.rows[0].index}`} className="agent-steps-list agent-live-steps" aria-label="正在进行的步骤">
          {group.rows.map(({ step: item, index }) => item.kind === 'tool' ? <ToolRow key={index} step={asStep(item)} status={item.status} lines={item.lines} />
            // The thought being written is open; one the turn has moved past folds into a row.
            : index === last ? <li key={`live:${index}`} className="agent-step is-thinking is-live"><LiveThinking text={item.text} onProgress={onProgress} /></li>
              : <ThinkingRow key={index} step={{ kind: 'thinking', text: item.text }} />)}
        </ol>)}
      {/* The text being written now is the reply unless a tool call follows it. */}
      {tail?.kind === 'text' ? <LiveText key={`text:${last}`} text={tail.text} renderMarkdown={renderMarkdown} onProgress={onProgress} /> : null}
    </div>
  </article>;
}
