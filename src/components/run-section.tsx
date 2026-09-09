import { useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Download,
  FileText,
  Loader2,
  Play,
  RefreshCw,
  StopCircle,
  XCircle,
} from 'lucide-react';
import { Button } from './ui/button';
import {
  cancelRun,
  createRun,
  describeRunError,
  isRunActive,
  RUN_STATUS_LABELS,
  type Run,
  type RunStatus,
} from '../lib/runs';

interface RunSectionProps {
  taskId: string;
  runs: Run[];
  loading: boolean;
  error?: string;
  onRefresh: () => void;
  onRunUpdated: (run: Run) => void;
  onRunCreated: (run: Run) => void;
}

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const label = RUN_STATUS_LABELS[status] || status;

  let badgeClass = 'workspace-run-badge';
  let Icon = Clock;

  switch (status) {
    case 'queued':
    case 'provisioning':
      badgeClass += ' status-queued';
      Icon = Clock;
      break;
    case 'running':
    case 'finalizing':
      badgeClass += ' status-running';
      Icon = Loader2;
      break;
    case 'succeeded':
      badgeClass += ' status-succeeded';
      Icon = CheckCircle2;
      break;
    case 'cancel_requested':
      badgeClass += ' status-cancelling';
      Icon = Loader2;
      break;
    case 'cancelled':
      badgeClass += ' status-cancelled';
      Icon = StopCircle;
      break;
    case 'failed':
    case 'interrupted':
      badgeClass += ' status-failed';
      Icon = XCircle;
      break;
  }

  const isSpinning = status === 'running' || status === 'finalizing' || status === 'cancel_requested';

  return (
    <span className={badgeClass} data-status={status}>
      <Icon size={12} className={isSpinning ? 'animate-spin' : ''} />
      <span>{label}</span>
    </span>
  );
}

export function RunSection({
  taskId,
  runs,
  loading,
  error,
  onRefresh,
  onRunUpdated,
  onRunCreated,
}: RunSectionProps) {
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState('');
  const [cancellingRunId, setCancellingRunId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const activeRun = runs.find(r => isRunActive(r.status));

  async function handleStartRun() {
    if (starting || activeRun) return;
    setStarting(true);
    setStartError('');
    setActionError(null);

    try {
      const newRun = await createRun(taskId);
      onRunCreated(newRun);
    } catch (err) {
      setStartError(describeRunError(err));
    } finally {
      setStarting(false);
    }
  }

  async function handleCancelRun(runId: string) {
    if (cancellingRunId) return;
    setCancellingRunId(runId);
    setActionError(null);

    try {
      const updated = await cancelRun(runId);
      onRunUpdated(updated);
    } catch (err) {
      setActionError(describeRunError(err));
    } finally {
      setCancellingRunId(null);
    }
  }

  return (
    <div className="workspace-run-section" data-testid="run-section">
      <div className="workspace-run-header">
        <div>
          <h3 className="workspace-run-title">执行记录与运行 (Runs)</h3>
          <p className="workspace-run-subtitle">
            调度沙箱并启动 Agent 执行此目标任务。
          </p>
        </div>

        <div className="workspace-run-actions">
          <Button
            variant="ghost"
            size="default"
            onClick={onRefresh}
            disabled={loading}
            aria-label="刷新执行状态"
            className="workspace-run-refresh-btn"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            <span>刷新</span>
          </Button>
          <Button
            variant="solid"
            size="default"
            onClick={handleStartRun}
            disabled={starting || Boolean(activeRun)}
            aria-label="启动执行"
          >
            {starting ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                <span>正在启动…</span>
              </>
            ) : (
              <>
                <Play size={14} />
                <span>启动执行</span>
              </>
            )}
          </Button>
        </div>
      </div>

      {startError && (
        <div className="workspace-inline-error" role="alert" style={{ marginBottom: 12 }}>
          {startError}
        </div>
      )}

      {actionError && (
        <div className="workspace-inline-error" role="alert" style={{ marginBottom: 12 }}>
          {actionError}
        </div>
      )}

      {error && (
        <div className="workspace-inline-error" role="alert" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}

      {loading && runs.length === 0 ? (
        <div className="workspace-run-loading" role="status">
          <Loader2 className="animate-spin" size={18} />
          <span style={{ marginLeft: 8 }}>正在获取执行记录…</span>
        </div>
      ) : runs.length === 0 ? (
        <div className="workspace-run-empty">
          <p>暂无执行记录</p>
          <small>点击“启动执行”可在沙箱环境中运行该任务。</small>
        </div>
      ) : (
        <ul className="workspace-run-list" role="list" aria-label="执行列表">
          {runs.map(run => {
            const canCancel = isRunActive(run.status) && run.status !== 'cancel_requested';
            const isCancelling = cancellingRunId === run.id || run.status === 'cancel_requested';

            return (
              <li key={run.id} className="workspace-run-card" data-testid={`run-card-${run.id}`}>
                <div className="workspace-run-card-header">
                  <div className="workspace-run-card-info">
                    <span className="workspace-run-id" title={run.id}>
                      Run #{run.id.slice(0, 8)}
                    </span>
                    <RunStatusBadge status={run.status} />
                  </div>

                  <div className="workspace-run-card-ctrls">
                    {canCancel && (
                      <Button
                        variant="ghost"
                        size="default"
                        className="workspace-run-cancel-btn"
                        onClick={() => handleCancelRun(run.id)}
                        disabled={isCancelling}
                        aria-label={`取消执行 ${run.id.slice(0, 8)}`}
                      >
                        {isCancelling ? (
                          <>
                            <Loader2 size={13} className="animate-spin" />
                            <span>正在取消…</span>
                          </>
                        ) : (
                          <>
                            <StopCircle size={13} />
                            <span>取消</span>
                          </>
                        )}
                      </Button>
                    )}
                  </div>
                </div>

                <div className="workspace-run-timestamps">
                  <span title={run.created_at}>
                    创建：{new Date(run.created_at).toLocaleString('zh-CN', {
                      month: 'numeric',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </span>
                  {run.finished_at && (
                    <span title={run.finished_at} style={{ marginLeft: 12 }}>
                      结束：{new Date(run.finished_at).toLocaleString('zh-CN', {
                        month: 'numeric',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}
                    </span>
                  )}
                </div>

                {run.error && (
                  <div className="workspace-run-error-box" role="alert">
                    <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
                    <div className="workspace-run-error-text">
                      <strong>错误信息：</strong>
                      <span>{run.error}</span>
                    </div>
                  </div>
                )}

                {run.artifacts && run.artifacts.length > 0 && (
                  <div className="workspace-run-artifacts">
                    <span className="workspace-run-artifacts-title">产物文件：</span>
                    <ul className="workspace-run-artifact-list">
                      {run.artifacts.map(art => (
                        <li key={art.id} className="workspace-run-artifact-item">
                          <FileText size={14} className="workspace-run-artifact-icon" />
                          <span className="workspace-run-artifact-name">{art.name}</span>
                          {art.size_bytes !== undefined && (
                            <span className="workspace-run-artifact-size">
                              ({(art.size_bytes / 1024).toFixed(1)} KB)
                            </span>
                          )}
                          {art.url && (
                            <a
                              href={art.url}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="workspace-run-artifact-download"
                              aria-label={`下载 ${art.name}`}
                            >
                              <Download size={13} />
                              <span>下载</span>
                            </a>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
