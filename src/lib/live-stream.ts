import type { LiveStep } from './library';

/** What the live endpoint reported, reduced to the fields the view merges. */
export interface LiveFrame {
  version: number | null;
  steps: LiveStep[];
  call: string;
  thinking: string;
  thinkingFrom: number;
  text: string;
  textFrom: number;
}

/** The frame currently on screen. An idle snapshot must not blank it. */
export interface HeldStream {
  call: string;
  thinking: string;
  text: string;
  steps: LiveStep[];
}

const empty: HeldStream = { call: '', thinking: '', text: '', steps: [] };

/**
 * Fold one live poll into what is already showing.
 *
 * The server clears the turn when it ends (`version` 0) and also starts a new
 * model call with empty text. Either one used to replace the reply with nothing
 * for a moment. Keep the last thinking, reply and tool rows until a newer call
 * has actually written something, or until the working view unmounts.
 * A missing version still applies tool rows the server did send.
 */
export function mergeLiveFrame(current: HeldStream = empty, live: LiveFrame): HeldStream {
  // version 0 is the turn being cleared at the end. null is a server that
  // still sends tool rows without a stream version; those rows must update.
  if (live.version === 0) {
    return {
      call: current.call,
      thinking: current.thinking || live.thinking,
      text: current.text || live.text,
      steps: current.steps.length ? current.steps : live.steps,
    };
  }
  const same = Boolean(current.call) && live.call === current.call;
  const thinking = same && live.thinkingFrom > 0 ? current.thinking + live.thinking : live.thinking || (same || !live.call ? current.thinking : '');
  const incomingText = same && live.textFrom > 0 ? current.text + live.text : live.text;
  const steps = live.steps.length ? live.steps : current.steps;
  // A new call that has not written yet must not blank the reply already shown.
  if (!incomingText && current.text) {
    return { call: current.call, thinking: thinking || current.thinking, text: current.text, steps };
  }
  return {
    call: live.call || current.call,
    thinking: thinking || current.thinking,
    text: incomingText || current.text,
    steps,
  };
}

/** Stages in which the turn is waiting on something outside the model's own output. */
const WAITING: Record<string, string> = {
  connecting: '正在连接云端',
  lease: '等待工作区空闲',
  sandbox: '等待沙箱就绪',
  agent: '正在启动 Pi',
  model: '等待模型回复',
};

/**
 * What the turn is doing right now, as the server reports it: waiting for the
 * sandbox, for Pi, or for the upstream model. Waits of two seconds or more
 * say how long. Returns '' for a stage this client does not know, so the
 * caller falls back to what it can see itself.
 */
export function stageText(stage: string, waitedMs: number, hasSteps: boolean, toolLabel = ''): string {
  if (stage === 'tool') return toolLabel ? `正在${toolLabel}` : '正在调用工具';
  if (stage === 'thinking') return '模型正在思考';
  if (stage === 'writing') return '正在回答';
  // After a tool call Pi is already running: it reads the result next.
  const label = stage === 'agent' && hasSteps ? 'Pi 正在整理工具结果' : WAITING[stage];
  if (!label) return '';
  const seconds = Math.floor(Math.max(0, waitedMs) / 1000);
  return seconds >= 2 ? `${label}（已等 ${seconds} 秒）` : label;
}

/** Rough token count: one CJK/non-ASCII character, otherwise about four bytes of text. */
export function estimateTokens(value: string): number {
  let tokens = 0;
  let ascii = 0;
  for (const char of value) {
    if ((char.codePointAt(0) ?? 0) > 0x7f) tokens += 1;
    else ascii += 1;
  }
  return tokens + Math.ceil(ascii / 4);
}

/** Average speed since the first character, or '' before there is anything to time. */
export function formatTokenRate(tokens: number, elapsedMs: number): string {
  if (tokens < 1 || elapsedMs < 400) return '';
  const perSecond = tokens / (elapsedMs / 1000);
  const shown = perSecond >= 10 ? String(Math.round(perSecond)) : (Math.round(perSecond * 10) / 10).toFixed(1);
  return `${shown} token/秒`;
}

/** A short, single-line view of a tool's arguments for the live row. */
export function inputPreview(input?: string, limit = 48): string {
  if (!input) return '';
  let text = input.trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const parts = Object.entries(parsed as Record<string, unknown>)
        .filter(([, value]) => value !== undefined && value !== '')
        .slice(0, 3)
        .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
      if (parts.length) text = parts.join(' · ');
    }
  } catch { /* show the raw argument */ }
  text = text.replace(/\s+/g, ' ');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
