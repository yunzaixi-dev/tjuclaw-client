import { useEffect, useRef, useState } from 'react';
import { Brain } from 'lucide-react';
import { StepStatus, toolView } from './agent-steps';
import { getLive, type LiveCursor, type LiveStep } from '../lib/library';
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

type Stream = { call: string; thinking: string; text: string };

/**
 * The Agent at work: elapsed seconds so a long task never looks stuck, each
 * tool call as it starts and settles, and the model's thinking and reply as
 * they are written.
 */
export function Working({ name, sessionId, renderMarkdown, onProgress }: {
  name: string;
  sessionId?: string;
  renderMarkdown: (markdown: string) => string;
  /** Called as the live output grows, to keep it in view. */
  onProgress?: () => void;
}) {
  // Mounted when sending starts, so the first render marks the start.
  const [since] = useState(() => Date.now());
  const [now, setNow] = useState(since);
  const [steps, setSteps] = useState<LiveStep[]>([]);
  const [stream, setStream] = useState<Stream>({ call: '', thinking: '', text: '' });
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  // One long poll at a time: the server answers when the turn changes.
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    let timer = 0;
    let cursor: LiveCursor | undefined;
    const pause = (ms: number) => new Promise<void>(resolve => { timer = window.setTimeout(resolve, ms); });
    void (async () => {
      await pause(300);
      while (!controller.signal.aborted) {
        try {
          const live = await getLive(sessionId, cursor, controller.signal);
          if (controller.signal.aborted) return;
          setSteps(live.steps);
          setStream(current => {
            const same = live.call === current.call;
            return {
              call: live.call,
              thinking: same && live.thinkingFrom > 0 ? current.thinking + live.thinking : live.thinking,
              text: same && live.textFrom > 0 ? current.text + live.text : live.text,
            };
          });
          // Before the turn is registered, or on a server without live output, poll gently.
          if (live.version === null) { cursor = undefined; await pause(1200); }
          else if (live.version === 0) { cursor = undefined; await pause(500); }
          else cursor = { version: live.version, call: live.call, thinkingNext: live.thinkingNext, textNext: live.textNext };
        } catch {
          if (controller.signal.aborted) return;
          cursor = undefined;
          await pause(1500);
        }
      }
    })();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [sessionId]);

  useEffect(() => { onProgress?.(); }, [steps.length, onProgress]);
  const { thinking, text } = stream;

  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const running = steps.some(step => step.status === 'running');
  // Honest wording: what the Agent is doing right now.
  const phase = running ? '正在调用工具' : text ? '正在回答' : thinking ? '正在思考'
    : steps.length ? '正在整理结果' : seconds < 6 ? '正在理解你的问题' : '正在思考';
  return <div className="agent-working" role="status" aria-label={`${name}正在处理，已用 ${seconds} 秒`}>
    <div><span className="agent-working-name">{name}</span><span className="agent-working-text">{phase}</span><span className="agent-working-time">{seconds} 秒</span></div>
    {steps.length ? <ol className="agent-steps-list agent-live-steps" aria-label="正在进行的工具调用">
      {steps.map((step, index) => {
        const view = toolView({ kind: 'tool', name: step.name, input: step.input });
        const Icon = view.icon;
        return <li key={index} className={`agent-step is-tool is-live is-${step.status}`}>
          <div className="agent-step-line"><Icon size={14} aria-hidden="true" /><span className="agent-step-label">{view.label}</span><StepStatus status={step.status} /></div>
        </li>;
      })}
    </ol> : null}
    {/* Keyed by model call: a new call starts its own thinking and reply. */}
    {thinking && !text ? <LiveThinking key={`thinking:${stream.call}`} text={thinking} onProgress={onProgress} /> : null}
    {text ? <LiveText key={`text:${stream.call}`} text={text} renderMarkdown={renderMarkdown} onProgress={onProgress} /> : null}
  </div>;
}
