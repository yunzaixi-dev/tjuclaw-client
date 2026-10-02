// Registers the service worker on the Web and tells the page when a newer
// build is installed and waiting. The native shell ships its files itself.
import { isTauri } from '@tauri-apps/api/core';

let waiting: ServiceWorker | null = null;
const listeners = new Set<() => void>();

const announce = (worker: ServiceWorker | null) => {
  waiting = worker;
  for (const listener of listeners) listener();
};

export const subscribeUpdate = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
/** True when a newer build is installed and will take over on refresh. */
export const updateWaiting = () => waiting !== null;

/** Switches to the waiting build and reloads once it controls the page. */
export function applyUpdate() {
  if (!waiting) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
  waiting.postMessage('activate');
}

/**
 * Asks the server for a newer build now. Resolves to whether one is ready,
 * the app is current, or this environment has no service worker.
 */
export async function checkForUpdate(): Promise<'ready' | 'current' | 'unavailable'> {
  if (waiting) return 'ready';
  const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration().catch(() => undefined) : undefined;
  if (!registration) return 'unavailable';
  try { await registration.update(); } catch { return 'unavailable'; }
  const installing = registration.installing;
  if (installing) await new Promise<void>(resolve => {
    const settle = () => { if (installing.state !== 'installing') { installing.removeEventListener('statechange', settle); resolve(); } };
    installing.addEventListener('statechange', settle);
    settle();
  });
  return waiting || registration.waiting ? 'ready' : 'current';
}

// How often an open page asks the server for a newer build, and the least
// time between two asks however many things prompt one.
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const CHECK_SPACING_MS = 60 * 1000;
const RECOVERED_KEY = 'tjuclaw.pwa.recovered';

/**
 * A lazily loaded file of this build is gone: a newer build replaced it on
 * the server. The page cannot go on with the old code, so switch to the newer
 * build and load again. Once per tab, so a file that is truly broken does not
 * reload forever.
 */
function recoverFromMissingCode() {
  window.addEventListener('vite:preloadError', event => {
    try {
      if (sessionStorage.getItem(RECOVERED_KEY)) return;
      sessionStorage.setItem(RECOVERED_KEY, String(Date.now()));
    } catch { return; }
    event.preventDefault();
    void (async () => {
      const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration().catch(() => undefined) : undefined;
      await registration?.update().catch(() => undefined);
      const next = waiting ?? registration?.waiting ?? null;
      if (next) {
        navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
        next.postMessage('activate');
        // If the worker does not take over, load again anyway.
        window.setTimeout(() => location.reload(), 4000);
      } else location.reload();
    })();
  });
}

export function registerServiceWorker() {
  if (!import.meta.env.PROD || import.meta.env.MODE === 'audit' || isTauri() || !('serviceWorker' in navigator)) return;
  recoverFromMissingCode();
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(registration => {
      // An update only matters to a page an older worker already controls.
      const watch = (worker: ServiceWorker | null) => {
        if (!worker) return;
        const settle = () => { if (worker.state === 'installed' && navigator.serviceWorker.controller) announce(worker); };
        worker.addEventListener('statechange', settle);
        settle();
      };
      watch(registration.waiting);
      registration.addEventListener('updatefound', () => watch(registration.installing));
      // Files this visit loaded before the worker took control stay on the device too.
      void navigator.serviceWorker.ready.then(ready => {
        const urls = performance.getEntriesByType('resource').map(entry => entry.name);
        ready.active?.postMessage({ type: 'keep', urls });
      });
      // The page finds a newer build by itself: when it comes back into view
      // or focus, when the network returns, and every few minutes while open.
      // An installed app is rarely reloaded, so it cannot rely on navigation.
      let asked = Date.now();
      const ask = () => {
        if (document.visibilityState !== 'visible' || Date.now() - asked < CHECK_SPACING_MS) return;
        asked = Date.now();
        void registration.update().catch(() => undefined);
      };
      document.addEventListener('visibilitychange', ask);
      window.addEventListener('focus', ask);
      window.addEventListener('online', ask);
      window.setInterval(ask, CHECK_INTERVAL_MS);
    }).catch(() => undefined);
  });
}
