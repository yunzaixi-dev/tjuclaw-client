import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Brain, ChevronRight } from 'lucide-react';
import { SaidText, ToolRow, groupSteps, toolView } from './agent-steps';
import { followLiveEvents } from '../lib/live-events';
import type { ChatSession } from '../lib/library';
import { formatTokenRate, stageText, type TimelineItem } from '../lib/live-stream';
import './agent-live.css';

/**
 * One stretch of the model's thinking in the running turn. While it is being
 * written it is open; once the turn has moved on it folds into a
 * row, in place, that opens again on demand.
 */
const LiveThought = memo(function LiveThought({ text, active, onProgress }: { text: string; active: boolean; onProgress?: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLParagraphElement | null>(null);
  useEffect(() => {
    if (active && box.current) box.current.scrollTop = box.current.scrollHeight;
    onProgress?.();
  }, [text, active, onProgress]);
  const expanded = active || open;
  return <li className={`agent-step is-thinking is-live${expanded ? ' is-open' : ''}${active ? ' is-active' : ''}`}>
    <button type="button" aria-expanded={expanded} disabled={active} onClick={() => setOpen(value => !value)}>
      <Brain size={14} aria-hidden="true" />
      <span className="agent-step-label">思考过程</span>
      {!expanded ? <span className="agent-step-detail">{text.trim().replace(/\s+/g, ' ')}</span> : null}
      <ChevronRight size={13} className="agent-step-chevron" aria-hidden="true" />
    </button>
    <div className="agent-live-thought" aria-label={active ? '思考过程' : undefined} aria-hidden={expanded ? undefined : true}>
      <p ref={box} className="agent-step-thought">{active ? text : text.trim()}</p>
    </div>
  </li>;
});

const LiveText = memo(function LiveText({ text, renderMarkdown }: { text: string; renderMarkdown: (markdown: string) => string }) {
  const html = useMemo(() => renderMarkdown(text), [renderMarkdown, text]);
  return <div className="agent-live-text chat-message-content markdown-preview" dangerouslySetInnerHTML={{ __html: html }} />;
});

const asStep = (item: TimelineItem) => ({ kind: 'tool' as const, name: item.name, input: item.input, output: item.output,
  failed: item.status === 'failed', added: item.added, removed: item.removed, unit: item.unit || undefined });

/** A tool call of the running turn. It renders again only when its own entry changes. */
const LiveTool = memo(function LiveTool({ item }: { item: TimelineItem }) {
  const step = useMemo(() => asStep(item), [item]);
  return <ToolRow step={step} status={item.status} lines={item.lines} />;
});

/**
 * The line above the running turn: who is working, what on, how fast and for
 * how long. It alone ticks with the clock, so the steps and the reply below
 * are drawn only when they change.
 */
function WorkingHead({ name, since, stage, stageAt, hasTools, toolLabel, tailKind, stopping, speed }: {
  name: string; since: number; stage: string; stageAt: number; hasTools: boolean; toolLabel: string;
  tailKind: TimelineItem['kind'] | null; stopping?: boolean; speed: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  // Honest wording: what the Agent is doing right now. The rate is separate so
  // the phase text stays an exact status.
  // The server says what the turn waits for; an older server leaves it to what is visible here.
  const reported = stageText(stage, now - stageAt, hasTools, toolLabel);
  // A stop takes effect when the running step ends: say so rather than a stage.
  const phase = stopping ? (toolLabel ? `正在停止，等${toolLabel}结束` : '正在停止') : reported || (toolLabel ? `正在${toolLabel}`
    : tailKind === 'text' ? '正在回答' : tailKind === 'thinking' ? '正在思考' : '等待回复');
  return <header className="agent-reply-head agent-working-head">
    <span className="agent-reply-name agent-working-name">{name}</span><span className="agent-working-text">{phase}</span>
    {speed ? <span className="agent-working-rate">{speed}</span> : null}<span className="agent-working-time" aria-hidden="true">{phase === '等待回复' ? '已等 ' : ''}{seconds} 秒</span>
  </header>;
}

/** Stages in which the model itself is writing, so its speed means something. */
const WRITING_STAGES = ['thinking', 'writing', 'preparing'];

/**
 * The Agent at work, laid out like the reply it becomes: the turn's thinking,
 * what the model says and each tool call, in the order they happen and as
 * they happen. Nothing shown is taken back; when the turn ends the saved
 * reply takes this place with the same rows.
 */
export function Working({ name, sessionId, requestId, since, content, onReply, stopping, renderMarkdown, onProgress }: {
  name: string;
  sessionId: string;
  requestId?: string;
  since: number;
  content?: string;
  onReply?: (session: ChatSession) => void;
  /** The user stopped the turn; it ends once the current step is done. */
  stopping?: boolean;
  renderMarkdown: (markdown: string) => string;
  /** Called as the live output grows, to keep it in view. */
  onProgress?: () => void;
}) {
  const [items, setItems] = useState<TimelineItem[]>([]);
  // The server's stage and when it began on this device's clock.
  const [stage, setStage] = useState<{ id: string; at: number }>({ id: '', at: since });
  const [rate, setRate] = useState({ tokens: 0, ms: 0 });
  // Follow only this send, including across a stream reconnect.
  useEffect(() => {
    if (!requestId || content === undefined || !onReply) return;
    return followLiveEvents(sessionId, requestId, (shown, live) => {
      if (shown) {
        setItems(shown);
        setRate({ tokens: live.rateTokens, ms: live.rateMs });
      }
      const began = Date.now() - live.stageMs;
      setStage(current => current.id === live.stage ? current : { id: live.stage, at: began });
    }, { content, onReply });
  }, [sessionId, requestId, content, onReply]);

  const last = items.length - 1;
  const tail = last >= 0 ? items[last] : null;
  useEffect(() => { onProgress?.(); }, [items.length, tail?.text, tail?.status, tail?.lines, onProgress]);

  const active = [...items].reverse().find(item => item.kind === 'tool' && (item.status === 'running' || item.status === 'writing'));
  const toolLabel = active ? toolView(asStep(active)).label : '';
  const hasTools = items.some(item => item.kind === 'tool');
  // The speed of the call being written now; a tool run or a wait has none.
  const speed = WRITING_STAGES.includes(stage.id) ? formatTokenRate(rate.tokens, rate.ms) : '';
  const rows = tail?.kind === 'text' ? items.slice(0, last) : items;
  return <article className="agent-working" role="status" aria-label={`${name}正在处理`}>
    <div className="agent-reply-body">
      <WorkingHead name={name} since={since} stage={stage.id} stageAt={stage.at} hasTools={hasTools} toolLabel={toolLabel}
        tailKind={tail?.kind ?? null} stopping={stopping} speed={speed} />
      {groupSteps(rows).map(group => 'said' in group
        ? <SaidText key={`said:${group.index}`} text={group.said.text} renderMarkdown={renderMarkdown} />
        : <ol key={`rows:${group.rows[0].index}`} className="agent-steps-list agent-live-steps" aria-label="正在进行的步骤">
          {group.rows.map(({ step: item, index }) => item.kind === 'tool' ? <LiveTool key={index} item={item} />
            // The thought being written is open; once the turn has moved past it, it folds into a row in place.
            : <LiveThought key={index} text={item.text} active={index === last && (!stage.id || stage.id === 'thinking')} onProgress={onProgress} />)}
        </ol>)}
      {/* The text being written now is the reply unless a tool call follows it. */}
      {tail?.kind === 'text' ? <LiveText key={`text:${last}`} text={tail.text} renderMarkdown={renderMarkdown} /> : null}
    </div>
  </article>;
}
