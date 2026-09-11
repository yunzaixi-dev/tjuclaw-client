import { BrandIcon } from './brand-icon';
import './loading-fallback.css';

export function LoadingFallback() {
  return (
    <div className="app-loading-shell" role="status" aria-live="polite">
      <div className="app-loading-card">
        <div className="app-loading-badge-wrap">
          <BrandIcon size={52} className="app-loading-brand" alt="" />
          <div className="app-loading-spinner" aria-hidden="true" />
        </div>
        <div className="app-loading-text-group">
          <strong className="app-loading-title">正在打开 TJUClaw</strong>
          <span className="app-loading-subtitle">准备界面中…</span>
        </div>
      </div>
    </div>
  );
}
