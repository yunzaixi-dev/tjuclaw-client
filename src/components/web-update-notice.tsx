import { useEffect, useState, useSyncExternalStore } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { applyUpdate, subscribeUpdate, updateWaiting } from '../lib/pwa';
import { fetchReleaseSummary } from '../lib/release-notes';
import { versionLabel } from '../lib/version';
import './update-notice.css';

// Web 端：新版本已在后台装好时提示刷新；不点刷新就继续用当前版本。
export function WebUpdateNotice() {
  const waiting = useSyncExternalStore(subscribeUpdate, updateWaiting, () => false);
  const [dismissed, setDismissed] = useState(false);
  // What the waiting version changes, read from the deployment that produced it.
  const [summary, setSummary] = useState<string[]>([]);
  useEffect(() => {
    if (!waiting) return;
    const controller = new AbortController();
    void fetchReleaseSummary(controller.signal).then(lines => { if (!controller.signal.aborted) setSummary(lines); });
    return () => controller.abort();
  }, [waiting]);
  if (!waiting || dismissed) return null;
  return (
    <aside className="update-notice" role="status" aria-live="polite" aria-label="应用更新">
      <div className="update-notice-head">
        <RefreshCw size={16} aria-hidden="true" />
        <strong>新版本已就绪</strong>
        <button type="button" className="update-notice-close" aria-label="稍后提醒" onClick={() => setDismissed(true)}>
          <X size={14} />
        </button>
      </div>
      {summary.length ? <ul className="update-notice-summary" aria-label="更新内容">{summary.map(line => <li key={line}>{line}</li>)}</ul> : null}
      <p>当前 {versionLabel}。刷新后使用新版本；未保存的输入请先保存。{summary.length ? <> <a href="https://changelog.tjuclaw.cloud/" target="_blank" rel="noreferrer">全部更新</a></> : null}</p>
      <div className="update-notice-actions">
        <button type="button" className="is-secondary" onClick={() => setDismissed(true)}>稍后</button>
        <button type="button" className="is-primary" onClick={applyUpdate}>刷新</button>
      </div>
    </aside>
  );
}
