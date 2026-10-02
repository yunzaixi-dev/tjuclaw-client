import type { LiveCursor, LiveItem, LiveStatus, LiveTurn } from './library';

/** One entry of the running turn as it is on screen. */
export interface TimelineItem {
  kind: 'thinking' | 'text' | 'tool';
  text: string;
  /** Bytes of `text` the server has sent, the offset for the next poll. */
  next: number;
  name: string; input: string; status: LiveStatus;
  lines: number; added: number; removed: number;
  output: string;
}

const asTimelineItem = (item: LiveItem, text: string): TimelineItem => ({
  kind: item.kind, text, next: item.next, name: item.name, input: item.input, status: item.status,
  lines: item.lines, added: item.added, removed: item.removed, output: item.output,
});

/**
 * Fold one live poll into the timeline on screen.
 *
 * The timeline only grows: entries are placed by their index, and an entry
 * whose text arrived in part is continued. The server clears the turn when it
 * ends (`version` 0), and a server without live output reports no version;
 * neither may blank what is showing, so the timeline is kept as it is until
 * the saved reply replaces the working view.
 *
 * `resync` is true when the poll cannot be joined to what is on screen: the
 * server's timeline is shorter, an entry before the end is missing, or a
 * continued text does not start where the shown one ends. The caller then
 * reads the whole timeline again.
 */
export function mergeTimeline(current: TimelineItem[], live: Pick<LiveTurn, 'version' | 'items' | 'count'>): { items: TimelineItem[]; resync: boolean } {
  if (!live.version) return { items: current, resync: false };
  if (live.count < current.length) return { items: current, resync: true };
  const items = current.slice();
  for (const item of [...live.items].sort((a, b) => a.i - b.i)) {
    if (item.i > items.length) return { items: current, resync: true };
    const shown = items[item.i];
    if (item.from > 0) {
      if (!shown || shown.kind !== item.kind || shown.next !== item.from) return { items: current, resync: true };
      items[item.i] = asTimelineItem(item, shown.text + item.text);
    } else {
      items[item.i] = asTimelineItem(item, item.text);
    }
  }
  return { items, resync: items.length !== live.count };
}

/**
 * The cursor for the next poll: the version just read, and the last entry
 * when its text can still grow. A tool call at the end means no text is
 * growing, which an index past the end says.
 */
export function timelineCursor(version: number, items: TimelineItem[]): LiveCursor {
  const last = items.length - 1;
  if (last >= 0 && items[last].kind !== 'tool') return { version, tail: last, at: items[last].next };
  return { version, tail: items.length, at: 0 };
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
  // The model is still writing the call's arguments, for a file its whole content.
  if (stage === 'preparing') return toolLabel ? `正在准备${toolLabel}` : '正在准备调用工具';
  if (stage === 'thinking') return '模型正在思考';
  if (stage === 'writing') return '正在回答';
  // After a tool call Pi is already running: it reads the result next.
  const label = stage === 'agent' && hasSteps ? 'Pi 正在整理工具结果' : WAITING[stage];
  if (!label) return '';
  const seconds = Math.floor(Math.max(0, waitedMs) / 1000);
  return seconds >= 2 ? `${label}（已等 ${seconds} 秒）` : label;
}

/** Average speed of the current model call, or '' before there is anything to time. */
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
