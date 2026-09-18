import { useSyncExternalStore } from 'react';
import { X } from 'lucide-react';
import './contest-banner.css';

const STORAGE_KEY = 'tjuclaw.contest-banner.v1';
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
        href="https://agent2026.tju.edu.cn/ai-competition/introduction/"
        target="_blank"
        rel="noreferrer"
      >
        🎉 此作品正在参加天津大学智能体大赛 2026，希望大家能投我们一票，感谢 🥳
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
