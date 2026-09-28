import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { BlueprintBackdrop } from './blueprint-backdrop';
import { BrandIcon } from './brand-icon';
import './workspace-loading.css';

export type LoadStep = 'app' | 'session' | 'library' | 'entries' | 'note' | 'done';

const STEPS: { id: Exclude<LoadStep, 'done'>; label: string }[] = [
  { id: 'app', label: '加载界面' },
  { id: 'session', label: '验证登录状态' },
  { id: 'library', label: '读取知识库' },
  { id: 'entries', label: '载入笔记与卡片' },
  { id: 'note', label: '打开上次的笔记' },
];

/** Loads finishing sooner than this never show the opening screen. */
export const OPENING_REVEAL_MS = 240;
/** Once shown, the screen stays at least this long so it never flickers. */
export const OPENING_MIN_VISIBLE_MS = 450;

// The screen is rendered by the Suspense fallback and then by the workspace
// itself. Shared state lets the second mount continue the first without
// replaying its delay or entrance, so the two read as one screen.
const opening: { mountedAt: number; visibleAt: number } = { mountedAt: 0, visibleAt: 0 };

/** How long the caller should keep the screen up after loading finished. */
export function openingHoldMs(now = performance.now()) {
  if (!opening.visibleAt) return 0;
  return Math.max(0, opening.visibleAt + OPENING_MIN_VISIBLE_MS - now);
}

/** Whether the opening screen was actually seen, so the page may fade in. */
export const openingWasVisible = () => opening.visibleAt > 0;

/**
 * Opening TJUClaw on the same blueprint surface as sign-in, with the real
 * loading steps. The bar creeps within a step so a slow request never looks
 * frozen, and a cached load that finishes quickly shows nothing at all.
 */
export function WorkspaceLoading({ step, title = '正在打开你的知识花园' }: { step: LoadStep; title?: string }) {
  const [continued] = useState(() => {
    const now = performance.now();
    if (!opening.mountedAt) opening.mountedAt = now;
    return now - opening.mountedAt > OPENING_REVEAL_MS;
  });
  const [visible, setVisible] = useState(() => opening.visibleAt > 0);
  useEffect(() => {
    if (visible) return;
    const wait = Math.max(0, opening.mountedAt + OPENING_REVEAL_MS - performance.now());
    const timer = window.setTimeout(() => {
      if (!opening.visibleAt) opening.visibleAt = performance.now();
      setVisible(true);
    }, wait);
    return () => window.clearTimeout(timer);
  }, [visible]);
  const current = step === 'done' ? STEPS.length : STEPS.findIndex(item => item.id === step);
  const progress = step === 'done' ? 100 : Math.round(((current + 0.5) / STEPS.length) * 100);
  const label = STEPS[current]?.label ?? '即将完成';
  return (
    <div className={`workspace-opening blueprint-surface${visible ? ' is-visible' : ''}${continued ? ' is-continued' : ''}`}>
      <BlueprintBackdrop />
      <section className="workspace-opening-card" role="status" aria-live="polite" aria-label={`${title}：${label}`}>
        <BrandIcon size={52} />
        <h1>{title}</h1>
        <div className="workspace-opening-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label="加载进度">
          <span key={step} className={step === 'done' ? 'is-done' : ''} style={{
            '--from': `${(current / STEPS.length) * 100}%`,
            '--to': `${progress}%`,
            '--next': `${Math.min(100, ((current + 1) / STEPS.length) * 100 - 2)}%`,
          } as React.CSSProperties} />
        </div>
        <p className="workspace-opening-now" aria-hidden="true">{step === 'done' ? '准备就绪' : `${label}…`}<span>{progress}%</span></p>
        <ol>
          {STEPS.map((item, index) => (
            <li key={item.id} className={index < current ? 'is-done' : index === current ? 'is-active' : ''}>
              <i aria-hidden="true">{index < current ? <Check size={12} strokeWidth={3} /> : null}</i>
              <span>{item.label}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
