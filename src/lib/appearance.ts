import { useSyncExternalStore } from 'react';

export type Mode = 'system' | 'light' | 'dark';
export type Accent = 'mono' | 'blue';
/** Page text font, as in Notion's Default / Serif / Mono. */
export type PageFont = 'sans' | 'serif' | 'mono';
type Preferences = { mode: Mode; accent: Accent; font: PageFont };
const key = 'tjuclaw.appearance.v1';
const defaults: Preferences = { mode: 'system', accent: 'mono', font: 'sans' };
let canPersist = true;

export function parseAppearance(raw: string | null): Preferences {
  try {
    const value = JSON.parse(raw || '{}');
    return {
      mode: ['system', 'light', 'dark'].includes(value?.mode) ? value.mode : defaults.mode,
      accent: ['mono', 'blue'].includes(value?.accent) ? value.accent : defaults.accent,
      font: ['sans', 'serif', 'mono'].includes(value?.font) ? value.font : defaults.font,
    };
  } catch { return { ...defaults }; }
}

function readPreferences() {
  try { const value = localStorage.getItem(key); canPersist = true; return parseAppearance(value); }
  catch { canPersist = false; return { ...defaults }; }
}
const media = window.matchMedia('(prefers-color-scheme: dark)');
function resolve(preferences: Preferences) {
  return { ...preferences, canPersist, resolved: preferences.mode === 'system' ? (media.matches ? 'dark' : 'light') : preferences.mode };
}
let snapshot = resolve(readPreferences());
const listeners = new Set<() => void>();
// Declared before the first apply().
let wenkai: Promise<unknown> | null = null;
function loadWenkai() { wenkai ??= import('../wenkai.css'); }
function apply() {
  const root = document.documentElement;
  root.dataset.theme = snapshot.resolved;
  root.dataset.accent = snapshot.accent;
  root.dataset.font = snapshot.font;
  if (snapshot.font !== 'sans') loadWenkai();
  root.style.colorScheme = snapshot.resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', snapshot.resolved === 'dark' ? '#191919' : '#ffffff');
  listeners.forEach(listener => listener());
}
// Runs before the product's first render; no inline script or native CSP exception.
apply();

// WenKai (the serif/mono page font and the chalk notes) is ~210 KB of
// @font-face CSS: apply() fetches it at once when the page font needs it,
// otherwise it waits until the first screen is idle.
if ('requestIdleCallback' in window) window.requestIdleCallback(loadWenkai, { timeout: 4000 });
else setTimeout(loadWenkai, 2500);

function subscribe(listener: () => void) {
  listeners.add(listener);
  const systemChanged = () => { snapshot = resolve(snapshot); apply(); };
  const storageChanged = (event: StorageEvent) => {
    if (event.key === key || event.key === null) { snapshot = resolve(readPreferences()); apply(); }
  };
  media.addEventListener('change', systemChanged);
  window.addEventListener('storage', storageChanged);
  return () => {
    listeners.delete(listener);
    media.removeEventListener('change', systemChanged);
    window.removeEventListener('storage', storageChanged);
  };
}
export function setAppearance(patch: Partial<Preferences>) {
  const preferences = parseAppearance(JSON.stringify({ ...snapshot, ...patch }));
  try { localStorage.setItem(key, JSON.stringify(preferences)); canPersist = true; }
  catch { canPersist = false; }
  snapshot = resolve(preferences);
  apply();
}
export function useAppearance() {
  return useSyncExternalStore(subscribe, () => snapshot);
}
