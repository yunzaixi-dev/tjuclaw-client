import { useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import type { Update } from '@tauri-apps/plugin-updater';
import { Download, X } from 'lucide-react';
import { summaryFromNotes } from '../lib/release-notes';
import './update-notice.css';

const DISMISS_KEY = 'tjuclaw.update-dismissed';
const FIRST_CHECK_DELAY_MS = 5_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

type Phase =
  | { kind: 'idle' }
  | { kind: 'available'; update: Update }
  | { kind: 'downloading'; update: Update; received: number; total: number | null }
  | { kind: 'installing'; update: Update }
  | { kind: 'failed'; update: Update };

function dismissedVersion() {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

// 桌面端检查已签名的新版本并提示安装；Web 与移动端不渲染。
// 更新清单来自 tauri.conf.json 中配置的 R2 latest.json，签名由内置公钥校验。
export function UpdateNotice() {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const busy = useRef(false);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;

    const run = async () => {
      if (busy.current) return;
      try {
        const { check } = await import('@tauri-apps/plugin-updater');
        const update = await check();
        if (cancelled || !update || busy.current) return;
        if (dismissedVersion() === update.version) return;
        setPhase({ kind: 'available', update });
      } catch {
        // 移动端未注册更新插件、离线或清单不可用时静默跳过，下次定时再查。
      }
    };

    const first = window.setTimeout(run, FIRST_CHECK_DELAY_MS);
    const timer = window.setInterval(run, CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);

  if (phase.kind === 'idle') return null;
  const { update } = phase;

  const install = async () => {
    busy.current = true;
    let received = 0;
    let total: number | null = null;
    setPhase({ kind: 'downloading', update, received, total });
    try {
      await update.downloadAndInstall(event => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? null;
        } else if (event.event === 'Progress') {
          received += event.data.chunkLength;
        } else {
          setPhase({ kind: 'installing', update });
          return;
        }
        setPhase({ kind: 'downloading', update, received, total });
      });
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch {
      busy.current = false;
      setPhase({ kind: 'failed', update });
    }
  };

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, update.version);
    } catch {
      // 存储不可用时只在本次会话内隐藏
    }
    setPhase({ kind: 'idle' });
  };

  const percent = phase.kind === 'downloading' && phase.total
    ? Math.min(100, Math.round((phase.received / phase.total) * 100))
    : null;
  const working = phase.kind === 'downloading' || phase.kind === 'installing';
  // What this version changes, from the release's own notes.
  const summary = phase.kind === 'available' ? summaryFromNotes(update.body) : [];

  return (
    <aside className="update-notice" role="status" aria-live="polite" aria-label="应用更新">
      <div className="update-notice-head">
        <Download size={16} aria-hidden="true" />
        <strong>发现新版本 v{update.version}</strong>
        {!working && (
          <button type="button" className="update-notice-close" aria-label="稍后提醒" onClick={dismiss}>
            <X size={14} />
          </button>
        )}
      </div>
      {summary.length ? <ul className="update-notice-summary" aria-label="更新内容">{summary.map(line => <li key={line}>{line}</li>)}</ul> : null}
      <p>
        {phase.kind === 'available' && `当前 v${update.currentVersion}，更新后将自动重启应用。`}
        {phase.kind === 'downloading' && (percent === null ? '正在下载更新…' : `正在下载更新… ${percent}%`)}
        {phase.kind === 'installing' && '正在安装，应用即将重启…'}
        {phase.kind === 'failed' && '更新失败，请检查网络后重试，或从官网下载安装包。'}
      </p>
      {phase.kind === 'downloading' && (
        <div className="update-notice-bar" aria-hidden="true">
          <span style={{ width: `${percent ?? 12}%` }} />
        </div>
      )}
      {(phase.kind === 'available' || phase.kind === 'failed') && (
        <div className="update-notice-actions">
          <button type="button" className="is-secondary" onClick={dismiss}>稍后</button>
          <button type="button" className="is-primary" onClick={install}>
            {phase.kind === 'failed' ? '重试' : '立即更新'}
          </button>
        </div>
      )}
    </aside>
  );
}
