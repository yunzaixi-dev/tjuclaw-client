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
      // A long-lived tab asks again when it comes back into view.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void registration.update().catch(() => undefined);
      });
    }).catch(() => undefined);
  });
}
