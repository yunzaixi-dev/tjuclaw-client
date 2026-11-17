import { AuthError } from './auth';
import { getLibraryChanges } from './library';

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    if (signal.aborted) { resolve(); return; }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = window.setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** One serial wait per active workspace. Catch up after establishing the
 * cursor so an edit between the initial tree read and the handshake isn't lost. */
export async function syncLibrary(signal: AbortSignal, reconcile: () => Promise<boolean>) {
  let cursor: string | undefined;
  let retryMs = 1000;
  while (!signal.aborted) {
    try {
      const started = performance.now();
      const next = await getLibraryChanges(cursor, signal);
      if (signal.aborted) return;
      if (next !== cursor) {
        // A canceled or superseded read must not consume this notification.
        if (!await reconcile()) {
          await wait(250, signal);
          continue;
        }
        cursor = next;
      } else if (performance.now() - started < 1000) {
        // A proxy or an incompatible server returning immediately must not
        // create a tight loop. Normal 15-second timeouts don't wait here.
        await wait(1000, signal);
      }
      retryMs = 1000;
    } catch (error) {
      if (signal.aborted || (error instanceof AuthError && (error.status === 401 || error.status === 403))) return;
      cursor = undefined; // After a network error, handshake and catch up again.
      await wait(retryMs, signal);
      retryMs = Math.min(retryMs * 2, 30_000);
    }
  }
}
