import { decodeLiveTurn, getLive, livePath, type LiveCursor, type LiveTurn } from './library';
import { mergeTimeline, timelineCursor, type TimelineItem } from './live-stream';

// The server flushes on connect and sends heartbeats well before rotating the
// stream. If bytes stop arriving, a buffering proxy can be as bad as no SSE.
const STREAM_IDLE_MS = 10000;
const MAX_FRAME_CHARS = 16 << 20;
const SSE = 'text/event-stream';

async function readLiveEvents(path: string, signal: AbortSignal, apply: (payload: unknown) => boolean): Promise<boolean> {
  const connection = new AbortController();
  const abort = () => connection.abort();
  signal.addEventListener('abort', abort, { once: true });
  let timeout = setTimeout(abort, STREAM_IDLE_MS);
  let streaming = false;
  const started = Date.now();
  // Use the same request options as getLive, without authRequest's JSON reader
  // or its fixed deadline (the heartbeat is our deadline instead).
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
        if (done) return streaming || Date.now() - started >= STREAM_IDLE_MS;
        if (!value?.length) continue;
        clearTimeout(timeout);
        timeout = setTimeout(abort, STREAM_IDLE_MS);
        buffered += decoder.decode(value, { stream: true });
        let end: RegExpExecArray | null;
        while ((end = boundary.exec(buffered))) {
          const event = buffered.slice(0, end.index);
          buffered = buffered.slice(end.index + end[0].length);
          const data = event.split(/\r?\n/).filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).replace(/^ /, ''));
          if (!data.length && !event.startsWith(':')) continue;
          if (event.length > MAX_FRAME_CHARS) return false;
          const payload: unknown = data.length ? JSON.parse(data.join('\n')) : undefined;
          streaming ||= data.length > 0;
          if (data.length && !apply(payload)) return true; // reconnect without the broken cursor
          if (connection.signal.aborted) return false;
        }
        if (buffered.length > MAX_FRAME_CHARS) return false;
      }
    } finally {
      reader.releaseLock();
    }
  } catch {
    // A working stream can be resumed after a network error. An opening
    // failure or an expired heartbeat deadline needs the JSON path instead.
    return streaming && !connection.signal.aborted;
  } finally {
    abort();
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
  return false;
}

/** Follow one turn's timeline until the caller stops it. Only the read is retried. */
export function followLiveEvents(sessionId: string, requestId: string, onFrame: (shown: TimelineItem[] | null, live: LiveTurn) => void): () => void {
  const controller = new AbortController();
  const { signal } = controller;
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
  const apply = (live: LiveTurn) => {
    if (signal.aborted) return false;
    const merged = mergeTimeline(cursor ? shown : [], live);
    if (merged.resync) {
      cursor = undefined;
      return false;
    }
    if (live.version) {
      shown = merged.items;
      cursor = timelineCursor(live.version, shown);
    }
    onFrame(live.version ? shown : null, live);
    return true;
  };
  void (async () => {
    // Let the send register its request ID before the first read, as before.
    await pause(300);
    let reconnectMs = 300;
    while (!signal.aborted) {
      const resume = await readLiveEvents(livePath(sessionId, cursor, requestId), signal, payload => {
        const live = decodeLiveTurn(payload, requestId);
        const applied = apply(live);
        if (applied && live.version) reconnectMs = 300;
        return applied;
      });
      if (!resume || signal.aborted) break;
      await pause(reconnectMs);
      reconnectMs = Math.min(reconnectMs * 2, 1500);
    }
    // Stay on one transport at a time, carrying the last applied cursor into
    // the long poll. A failed read has not changed what is already on screen.
    while (!signal.aborted) {
      try {
        const live = await getLive(sessionId, cursor, signal, requestId);
        const applied = apply(live);
        if (signal.aborted) break;
        if (!applied) await pause(200);
        else if (live.version === null) await pause(1200);
        else if (live.version === 0) await pause(500);
      } catch {
        if (signal.aborted) break;
        await pause(1500);
      }
    }
  })();
  return () => controller.abort();
}
