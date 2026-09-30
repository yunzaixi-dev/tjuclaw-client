import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { BlueprintBackdrop } from './blueprint-backdrop';
import { BrandIcon } from './brand-icon';
import './workspace-loading.css';

export type LoadStep = 'app' | 'session' | 'library' | 'entries' | 'cards' | 'note' | 'done';

const STEPS: { id: Exclude<LoadStep, 'done'>; label: string; detail: string }[] = [
  { id: 'app', label: '加载界面', detail: '正在下载工作区界面与编辑器代码。' },
  { id: 'session', label: '验证登录状态', detail: '正在向服务器确认当前登录身份。' },
  { id: 'library', label: '读取知识库', detail: '正在读取知识库列表并检查工作区解锁状态。' },
  { id: 'entries', label: '载入笔记目录', detail: '正在读取笔记、附件和文件夹，整理目录结构。' },
  { id: 'cards', label: '同步记忆闪卡', detail: '正在读取闪卡分区与学习记录。' },
  { id: 'note', label: '打开笔记', detail: '正在读取笔记正文并准备编辑器。' },
];

function LoadingDetails({ detail, done }: { detail: string; done: boolean }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (done) return;
    const start = performance.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((performance.now() - start) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [done]);
  return <div className="workspace-opening-detail">
    <p>{detail}</p>
    {!done ? <small>本阶段已等待 {elapsed} 秒{elapsed >= 8 ? ' · 服务器响应较慢，仍在等待，请勿重复刷新。' : ''}</small> : null}
  </div>;
}
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
      <section className="workspace-opening-card" role="status" aria-label={`${title}：${label}`}>
        <BrandIcon size={52} />
        <h1>{title}</h1>
        <div className="workspace-opening-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-valuetext={step === 'done' ? '准备就绪' : `阶段 ${current + 1}/${STEPS.length}：${label}`} aria-label="加载进度">
          <span key={step} className={step === 'done' ? 'is-done' : ''} style={{
            '--from': `${(current / STEPS.length) * 100}%`,
            '--to': `${progress}%`,
            '--next': `${Math.min(100, ((current + 1) / STEPS.length) * 100 - 2)}%`,
          } as React.CSSProperties} />
        </div>
        <p className="workspace-opening-now" aria-live="polite">{step === 'done' ? '准备就绪' : `${label}…`}<span>{step === 'done' ? '完成' : `阶段 ${current + 1}/${STEPS.length}`}</span></p>
        <LoadingDetails key={step} done={step === 'done'} detail={STEPS[current]?.detail ?? '工作区已准备完成，正在进入。'} />
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
