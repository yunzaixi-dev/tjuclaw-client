import { useEffect, useRef } from 'react';
import '../lib/cap-assets';
import '@cap.js/widget';
import type { CapSolveEvent } from '@cap.js/widget';

export function CapChallenge({ onSolve, onError, disabled = false }: {
  onSolve: (token: string) => void;
  onError: () => void;
  disabled?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onSolve, onError });
  useEffect(() => { callbacks.current = { onSolve, onError }; }, [onSolve, onError]);
  useEffect(() => {
    const container = host.current;
    if (!container) return;
    const widget = document.createElement('cap-widget');
    widget.setAttribute('data-cap-api-endpoint', '/api/auth/captcha/');
    widget.setAttribute('data-cap-worker-count', '2');
    widget.setAttribute('data-cap-i18n-initial-state', '安全验证');
    widget.setAttribute('data-cap-i18n-verifying-label', '正在验证…');
    widget.setAttribute('data-cap-i18n-solved-label', '安全验证已通过');
    widget.setAttribute('data-cap-i18n-error-label', '验证失败，点击重试');
    widget.setAttribute('data-cap-i18n-verify-aria-label', '安全验证');
    widget.setAttribute('data-cap-i18n-verified-aria-label', '安全验证已通过');
    widget.setAttribute('data-cap-troubleshooting-url', '/auth/help');
    const solve = (event: CapSolveEvent) => callbacks.current.onSolve(event.detail.token);
    const reset = () => callbacks.current.onSolve('');
    const error = () => { reset(); callbacks.current.onError(); };
    widget.addEventListener('solve', solve);
    widget.addEventListener('reset', reset);
    widget.addEventListener('error', error);
    container.append(widget);
    return () => {
      widget.removeEventListener('solve', solve);
      widget.removeEventListener('reset', reset);
      widget.removeEventListener('error', error);
      widget.remove();
    };
  }, []);
  return <div ref={host} className="auth-captcha-row" inert={disabled} aria-label="安全验证" />;
}
