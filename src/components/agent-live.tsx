import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Brain, ChevronRight } from 'lucide-react';
import { SaidText, ToolRow, groupSteps, toolView } from './agent-steps';
import { getLive, type LiveCursor } from '../lib/library';
import { formatTokenRate, mergeTimeline, stageText, timelineCursor, type TimelineItem } from '../lib/live-stream';
import './agent-live.css';

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** How many of the newest characters are still fading in. */
const TAIL = 14;

/**
 * Text that arrives in bursts, shown as a steady flow: each frame reveals a
 * share of what is still hidden, so a large burst catches up within a few
 * frames and a slow trickle stays character by character. The owner remounts
 * it (by key) when a different text starts.
 *
 * The newest characters fade in: `lead` is how far the fade has moved past
 * the end of the text, 0 while text is still arriving and TAIL once the last
 * character is fully shown.
 */
function useFlowingText(target: string): { shown: string; lead: number } {
  const [flow, setFlow] = useState({ shown: 0, lead: 0 });
  const still = reducedMotion();
  const done = flow.shown >= target.length;
  useEffect(() => {
    if (still || (done && flow.lead >= TAIL)) return;
    const frame = requestAnimationFrame(() => {
      setFlow(current => {
        // Caught up: let the last characters finish fading in.
        if (current.shown >= target.length) return { shown: current.shown, lead: Math.min(TAIL, current.lead + 1) };
        let next = Math.min(target.length, current.shown + Math.max(1, Math.ceil((target.length - current.shown) / 10)));
        // Never cut a surrogate pair in half.
        const code = target.charCodeAt(next);
        if (next < target.length && code >= 0xdc00 && code <= 0xdfff) next++;
        return { shown: next, lead: 0 };
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [flow, target, still, done]);
  return still ? { shown: target, lead: TAIL } : { shown: target.slice(0, Math.min(flow.shown, target.length)), lead: flow.lead };
}

/** The opacity of the character `distance` places before the end of the text. */
const tailOpacity = (distance: number, lead: number) => Math.min(1, (distance + lead + 1) / TAIL);

/** Plain text with its newest characters fading in. */
function FadingText({ text, lead }: { text: string; lead: number }) {
  const fading = Math.max(0, TAIL - lead);
  if (!fading) return <>{text}</>;
  const tail = Array.from(text).slice(-fading);
  const head = text.slice(0, text.length - tail.join('').length);
  return <>{head}{tail.map((char, index) => <span key={index} style={{ opacity: tailOpacity(tail.length - 1 - index, lead) }}>{char}</span>)}</>;
}

/**
 * Fades in the newest characters of rendered Markdown: the last text of the
 * element is split into one span per character, each lighter the newer it
 * is. Spans from the previous frame are folded back into plain text first.
 */
function fadeTail(root: HTMLElement, lead: number) {
  for (const span of Array.from(root.querySelectorAll('span.agent-tail'))) {
    const parent = span.parentNode;
    span.replaceWith(document.createTextNode(span.textContent ?? ''));
    parent?.normalize();
  }
  let fading = Math.max(0, TAIL - lead);
  let distance = 0;
  // Walk the text backwards from the end, leaving formulas and drawings whole.
  const visit = (node: Node): boolean => {
    if (fading <= 0) return false;
    if (node.nodeType === Node.TEXT_NODE) {
      const chars = Array.from((node as Text).data);
      const take = Math.min(fading, chars.length);
      if (!take) return true;
      const fragment = document.createDocumentFragment();
      fragment.append(chars.slice(0, chars.length - take).join(''));
      chars.slice(chars.length - take).forEach((char, index) => {
        const span = document.createElement('span');
        span.className = 'agent-tail';
        span.style.opacity = String(tailOpacity(distance + take - 1 - index, lead));
        span.textContent = char;
        fragment.append(span);
      });
      (node as Text).replaceWith(fragment);
      fading -= take;
      distance += take;
      return fading > 0;
    }
    if (node.nodeType !== Node.ELEMENT_NODE || (node as Element).matches('math, svg, .math-block, .mermaid-block, button')) return true;
    for (const child of Array.from(node.childNodes).reverse()) if (!visit(child)) return false;
    return true;
  };
  visit(root);
}

/**
 * One stretch of the model's thinking in the running turn. While it is being
 * written it is open and flows; once the turn has moved on it folds into a
 * row, in place, that opens again on demand.
 */
function LiveThought({ text, active, onProgress }: { text: string; active: boolean; onProgress?: () => void }) {
  const { shown, lead } = useFlowingText(text);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLParagraphElement | null>(null);
  useEffect(() => {
    if (active && box.current) box.current.scrollTop = box.current.scrollHeight;
    onProgress?.();
  }, [shown, active, onProgress]);
  const expanded = active || open;
  return <li className={`agent-step is-thinking is-live${expanded ? ' is-open' : ''}${active ? ' is-active' : ''}`}>
    <button type="button" aria-expanded={expanded} disabled={active} onClick={() => setOpen(value => !value)}>
      <Brain size={14} aria-hidden="true" />
      <span className="agent-step-label">思考过程</span>
      {!expanded ? <span className="agent-step-detail">{text.trim().replace(/\s+/g, ' ')}</span> : null}
      <ChevronRight size={13} className="agent-step-chevron" aria-hidden="true" />
    </button>
    <div className="agent-live-thought" aria-label={active ? '思考过程' : undefined} aria-hidden={expanded ? undefined : true}>
      <p ref={box} className="agent-step-thought">{active ? <FadingText text={shown} lead={lead} /> : text.trim()}</p>
    </div>
  </li>;
}

function LiveText({ text, renderMarkdown, onProgress }: { text: string; renderMarkdown: (markdown: string) => string; onProgress?: () => void }) {
  const { shown, lead } = useFlowingText(text);
  const box = useRef<HTMLDivElement | null>(null);
  const html = renderMarkdown(shown);
  useEffect(() => { onProgress?.(); }, [shown, onProgress]);
  // After React has written the Markdown, and again as the fade moves on.
  useLayoutEffect(() => { if (box.current) fadeTail(box.current, lead); }, [html, lead]);
  return <div ref={box} className="agent-live-text chat-message-content markdown-preview" dangerouslySetInnerHTML={{ __html: html }} />;
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
    failed: item.status === 'failed', added: item.added, removed: item.removed, unit: item.unit || undefined });
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
            // The thought being written is open; once the turn has moved past it, it folds into a row in place.
            : <LiveThought key={index} text={item.text} active={index === last} onProgress={onProgress} />)}
        </ol>)}
      {/* The text being written now is the reply unless a tool call follows it. */}
      {tail?.kind === 'text' ? <LiveText key={`text:${last}`} text={tail.text} renderMarkdown={renderMarkdown} onProgress={onProgress} /> : null}
    </div>
  </article>;
}
