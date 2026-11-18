import { decodeLiveTurn, getLive, livePath, type ChatSession, type LiveCursor, type LiveTurn } from './library';
import { CHAT_READBACK_WINDOW_MS, pollSavedTurn } from './chat-readback';
import { mergeTimeline, stageText, timelineCursor, type TimelineItem } from './live-stream';

// A proxy can deliver heartbeats without delivering updates. Give SSE a short
// window to make progress, then read from the same turn over JSON instead.
const STREAM_PROGRESS_MS = 5000;
const MAX_FRAME_CHARS = 16 << 20;
const SSE = 'text/event-stream';

type FrameResult = 'progress' | 'ignore' | 'resync';

async function readLiveEvents(path: string, signal: AbortSignal, apply: (payload: unknown) => FrameResult): Promise<boolean> {
  const connection = new AbortController();
  const abort = () => connection.abort();
  signal.addEventListener('abort', abort, { once: true });
  let timeout = setTimeout(abort, STREAM_PROGRESS_MS);
  let progressed = false;
  try {
    const response = await fetch(path, { headers: { Accept: SSE }, signal: connection.signal,
      credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    const type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    if (!response.ok) return false;
    if (type === 'application/json') {
      // An older server already answered the requested poll. Apply it once
      // instead of discarding a snapshot just because its transport was JSON.
      const payload: unknown = await response.json();
      if (!connection.signal.aborted) apply(payload);
      return false;
    }
    if (type !== SSE || !response.body?.getReader || typeof TextDecoder === 'undefined') return false;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const boundary = /\r?\n\r?\n/;
    let buffered = '';
    try {
      while (!connection.signal.aborted) {
        const { done, value } = await reader.read();
        if (connection.signal.aborted) return false;
        if (done) return progressed && !buffered;
        if (!value?.length) continue;
        buffered += decoder.decode(value, { stream: true });
        let end: RegExpExecArray | null;
        while ((end = boundary.exec(buffered))) {
          const event = buffered.slice(0, end.index);
          buffered = buffered.slice(end.index + end[0].length);
          const data = event.split(/\r?\n/).filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).replace(/^ /, ''));
          if (event.length > MAX_FRAME_CHARS) return false;
          if (!data.length) continue;
          let payload: unknown;
          try { payload = JSON.parse(data.join('\n')); }
          catch { continue; }
          const result = apply(payload);
          if (result === 'resync' || connection.signal.aborted) return false;
          if (result === 'progress') {
            progressed = true;
            clearTimeout(timeout);
            timeout = setTimeout(abort, STREAM_PROGRESS_MS);
          }
        }
        if (buffered.length > MAX_FRAME_CHARS) return false;
      }
    } finally {
      reader.releaseLock();
    }
  } catch {
    return false;
  } finally {
    abort();
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
  return false;
}

/** Follow one turn until it is saved or the caller stops. Only reads are retried. */
export function followLiveEvents(sessionId: string, requestId: string, onFrame: (shown: TimelineItem[] | null, live: LiveTurn) => void,
  saved?: { content: string; onReply: (session: ChatSession) => void }): () => void {
  const controller = new AbortController();
  const { signal } = controller;
  const deadline = setTimeout(() => controller.abort(), CHAT_READBACK_WINDOW_MS);
  signal.addEventListener('abort', () => clearTimeout(deadline), { once: true });
  let cursor: LiveCursor | undefined;
  let shown: TimelineItem[] = [];
  const pause = (ms: number) => new Promise<void>(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
  let appliedVersion = 0;
  let stage = '';
  const apply = (live: LiveTurn): FrameResult => {
    if (signal.aborted || !live.version || live.version < appliedVersion || (cursor && live.version === appliedVersion)) return 'ignore';
    const merged = mergeTimeline(cursor ? shown : [], live);
    if (merged.resync) {
      cursor = undefined;
      return 'resync';
    }
    const progress = (stageText(live.stage, 0, false) !== '' && live.stage !== stage) || live.items.some(({ i }) => {
      const previous = shown[i];
      const item = merged.items[i];
      return !previous || (Object.keys(item) as (keyof TimelineItem)[]).some(key => previous[key] !== item[key]);
    });
    shown = merged.items;
    cursor = timelineCursor(live.version, shown);
    appliedVersion = live.version;
    stage = live.stage;
    if (progress) onFrame(shown, live);
    return progress ? 'progress' : 'ignore';
  };
  const applyFrame = (payload: unknown): FrameResult => {
    if (!payload || typeof payload !== 'object') return 'ignore';
    const frame = payload as Record<string, unknown>;
    if (frame.client_request_id !== requestId || !Number.isSafeInteger(frame.version) || (frame.version as number) <= 0 ||
      !Number.isSafeInteger(frame.count) || (frame.count as number) < 0 || !Array.isArray(frame.items)) return 'ignore';
    const live = decodeLiveTurn(frame, requestId);
    if (live.items.length !== frame.items.length) return 'ignore';
    return apply(live);
  };
  async function readSavedReply() {
    if (!saved) return;
    // Give a quick POST time to finish, but do not wait for the stream to end.
    await pause(5000);
    const reply = await pollSavedTurn(sessionId, requestId, saved.content, signal).catch(() => undefined);
    if (!reply || signal.aborted) return;
    controller.abort();
    saved.onReply(reply);
  }
  void readSavedReply();
  void (async () => {
    // Let the send register its request ID before the first read, as before.
    await pause(300);
    while (!signal.aborted) {
      const resume = await readLiveEvents(livePath(sessionId, cursor, requestId), signal, applyFrame);
      if (!resume || signal.aborted) break;
      await pause(300);
    }
    // Carry the last applied cursor into the long poll. A failed read has not
    // changed what is already on screen.
    while (!signal.aborted) {
      try {
        const live = await getLive(sessionId, cursor, signal, requestId);
        const applied = apply(live);
        if (signal.aborted) break;
        if (applied === 'resync') await pause(200);
        else if (applied === 'ignore') await pause(750);
      } catch {
        if (signal.aborted) break;
        await pause(1500);
      }
    }
  })();
  return () => controller.abort();
}
