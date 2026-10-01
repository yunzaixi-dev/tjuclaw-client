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

const CHECK_INTERVAL_MS = 30 * 60 * 1000;

export function registerServiceWorker() {
  if (!import.meta.env.PROD || import.meta.env.MODE === 'audit' || isTauri() || !('serviceWorker' in navigator)) return;
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
      // A long-lived tab asks again when it comes back into view, and every half hour while open.
      const ask = () => { if (document.visibilityState === 'visible') void registration.update().catch(() => undefined); };
      document.addEventListener('visibilitychange', ask);
      window.setInterval(ask, CHECK_INTERVAL_MS);
    }).catch(() => undefined);
  });
}
