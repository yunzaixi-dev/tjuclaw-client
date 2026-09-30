import { useSyncExternalStore } from 'react';
import { X } from 'lucide-react';
import './contest-banner.css';

// A new notice gets a new key, so it shows even where the contest banner was closed.
const STORAGE_KEY = 'tjuclaw.notice-banner.v2';
const HIDDEN_CLASS = 'contest-banner-hidden';

function readOpen() {
  try {
    return localStorage.getItem(STORAGE_KEY) !== '1';
  } catch {
    return true;
  }
}

let open = readOpen();
if (!open) document.documentElement.classList.add(HIDDEN_CLASS);

const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

function persistOpen(next: boolean) {
  open = next;
  document.documentElement.classList.toggle(HIDDEN_CLASS, !next);
  try {
    if (next) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    // keep in-memory visibility even if storage is blocked
  }
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    open = readOpen();
    document.documentElement.classList.toggle(HIDDEN_CLASS, !open);
    emit();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function useContestBannerOpen() {
  return useSyncExternalStore(subscribe, () => open);
}

export function setContestBannerOpen(next: boolean) {
  persistOpen(next);
}

export function ContestBanner() {
  const visible = useContestBannerOpen();
  if (!visible) return null;

  return (
    <div id="tjuclaw-contest-2026" className="contest-banner" role="banner">
      <a
        className="contest-banner-link"
        href="https://tjuclaw.cloud/docs"
        target="_blank"
        rel="noreferrer"
      >
        🚧 TJUClaw 仍处于快速迭代期，未来将引入大量功能与优化，敬请期待 ✨
      </a>
      <button
        type="button"
        className="contest-banner-close"
        aria-label="关闭公告"
        onClick={() => setContestBannerOpen(false)}
      >
        <X size={16} />
      </button>
    </div>
  );
}
