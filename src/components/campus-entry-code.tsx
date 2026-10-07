import { useCallback, useEffect, useRef, useState } from 'react';
import { QrCode } from 'lucide-react';
import { fetchEntryCode } from '../lib/campus-api';
import { entryQr } from '../lib/entry-qr';

type Code = ReturnType<typeof entryQr> & { expires: number; updated: number };

export function CampusEntryCode() {
  const [code, setCode] = useState<Code | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now);
  const request = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    setCode(null);
    try {
      const result = await fetchEntryCode(controller.signal);
      if (controller.signal.aborted) return;
      const updated = Date.now();
      const expires = Date.parse(result.expires_at);
      if (!Number.isFinite(expires) || expires <= updated) throw new Error('expired entry QR');
      const matrix = entryQr(result.content);
      setNow(updated);
      setCode({ ...matrix, updated, expires });
    } catch {
      if (!controller.signal.aborted) setError('暂时无法获取有效入校码，请刷新重试；也可使用微北洋官方 App。');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    // The official App refreshes every 2 minutes 30 seconds for a 3-minute code.
    const autoRefresh = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 150000);
    const resume = () => setNow(Date.now());
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    return () => {
      request.current?.abort();
      window.clearTimeout(initial);
      window.clearInterval(clock);
      window.clearInterval(autoRefresh);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('focus', resume);
    };
  }, [refresh]);

  const valid = code && now < code.expires;
  return <div className="campus-entry-code" aria-busy={busy}>
    {valid ? <>
      <small>更新于 {new Date(code.updated).toLocaleTimeString('zh-CN')}</small>
      <svg className="campus-entry-qr" role="img" aria-label="实时入校二维码" viewBox={`0 0 ${code.size} ${code.size}`} xmlns="http://www.w3.org/2000/svg" shapeRendering="crispEdges">
        <rect width={code.size} height={code.size} fill="#fff" />
        <path d={code.path} fill="#000" />
      </svg>
      <small>有效至 {new Date(code.expires).toLocaleTimeString('zh-CN')} · 剩余 {Math.ceil((code.expires - now) / 1000)} 秒</small>
    </> : <p role="status">{busy ? '正在获取入校二维码…' : error || '入校码已过期，请刷新后使用。'}</p>}
    <button type="button" className="campus-action-button" disabled={busy} onClick={() => void refresh()}><QrCode size={15} />{busy ? '获取中…' : '刷新入校码'}</button>
    <small>约 3 分钟有效，页面打开时每 2 分 30 秒自动刷新。请勿分享二维码。</small>
  </div>;
}
