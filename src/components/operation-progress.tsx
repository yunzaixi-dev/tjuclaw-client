import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';

/** Elapsed time is real; it is not an estimated server completion percentage. */
export function OperationProgress({ label }: { label: string }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = performance.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((performance.now() - start) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <div className="workspace-operation" role="status" aria-label="笔记操作进度">
    <LoaderCircle size={16} className="workspace-operation-spinner" aria-hidden="true" />
    <span aria-live="polite">{label}…{elapsed >= 8 ? ' 服务器响应较慢，请稍候，无需重复操作。' : ''}</span>
    <small aria-hidden="true">已等待 {elapsed} 秒</small>
  </div>;
}
