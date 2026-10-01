import { useState, useSyncExternalStore } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { applyUpdate, subscribeUpdate, updateWaiting } from '../lib/pwa';
import './update-notice.css';

// Web 端：新版本已在后台装好时提示刷新；不点刷新就继续用当前版本。
export function WebUpdateNotice() {
  const waiting = useSyncExternalStore(subscribeUpdate, updateWaiting, () => false);
  const [dismissed, setDismissed] = useState(false);
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
      <p>刷新后使用新版本；未保存的输入请先保存。</p>
      <div className="update-notice-actions">
        <button type="button" className="is-secondary" onClick={() => setDismissed(true)}>稍后</button>
        <button type="button" className="is-primary" onClick={applyUpdate}>刷新</button>
      </div>
    </aside>
  );
}
