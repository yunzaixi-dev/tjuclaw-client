import { authRequest, AuthError } from './auth';

export type RunStatus =
  | 'queued'
  | 'provisioning'
  | 'running'
  | 'finalizing'
  | 'succeeded'
  | 'failed'
  | 'cancel_requested'
  | 'cancelled'
  | 'interrupted';

export interface RunArtifact {
  id: string;
  name: string;
  size_bytes?: number;
  url?: string;
  created_at?: string;
}

export interface Run {
  id: string;
  task_id: string;
  status: RunStatus;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  error?: string;
  artifacts?: RunArtifact[];
}

interface RunsResponse {
  runs: unknown;
}

interface RunResponse {
  run: unknown;
}

const HEX_32_REGEX = /^[0-9a-f]{32}$/;

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  queued: '排队中',
  provisioning: '环境准备中',
  running: '执行中',
  finalizing: '产物整理中',
  succeeded: '已完成',
  failed: '执行失败',
  cancel_requested: '正在取消',
  cancelled: '已取消',
  interrupted: '已中断',
};

export function isRunTerminal(status: RunStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'interrupted';
}

export function isRunActive(status: RunStatus): boolean {
  return status === 'queued' || status === 'provisioning' || status === 'running' || status === 'finalizing' || status === 'cancel_requested';
}

function isValidArtifact(value: unknown): value is RunArtifact {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || !record.id) {
    return false;
  }
  if (typeof record.name !== 'string' || !record.name) {
    return false;
  }
  if (record.size_bytes !== undefined && typeof record.size_bytes !== 'number') {
    return false;
  }
  if (record.url !== undefined && typeof record.url !== 'string') {
    return false;
  }
  if (record.created_at !== undefined && typeof record.created_at !== 'string') {
    return false;
  }
  return true;
}

const VALID_RUN_STATUSES: Set<RunStatus> = new Set([
  'queued',
  'provisioning',
  'running',
  'finalizing',
  'succeeded',
  'failed',
  'cancel_requested',
  'cancelled',
  'interrupted',
]);

export function isValidRun(value: unknown): value is Run {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;

  if (typeof record.id !== 'string' || !HEX_32_REGEX.test(record.id)) {
    return false;
  }

  if (typeof record.task_id !== 'string' || !HEX_32_REGEX.test(record.task_id)) {
    return false;
  }

  if (typeof record.status !== 'string' || !VALID_RUN_STATUSES.has(record.status as RunStatus)) {
    return false;
  }

  if (typeof record.created_at !== 'string' || !Number.isFinite(Date.parse(record.created_at))) {
    return false;
  }

  if (record.started_at !== undefined && (typeof record.started_at !== 'string' || !Number.isFinite(Date.parse(record.started_at)))) {
    return false;
  }

  if (record.finished_at !== undefined && (typeof record.finished_at !== 'string' || !Number.isFinite(Date.parse(record.finished_at)))) {
    return false;
  }

  if (record.error !== undefined && typeof record.error !== 'string') {
    return false;
  }

  if (record.artifacts !== undefined) {
    if (!Array.isArray(record.artifacts)) {
      return false;
    }
    for (const art of record.artifacts) {
      if (!isValidArtifact(art)) {
        return false;
      }
    }
  }

  return true;
}

export function parseRunResponse(data: unknown): Run {
  if (!data || typeof data !== 'object') {
    throw new AuthError(503, {});
  }
  const res = data as RunResponse;
  if (!isValidRun(res.run)) {
    throw new AuthError(503, {});
  }
  return res.run;
}

export function parseRunsResponse(data: unknown): Run[] {
  if (!data || typeof data !== 'object') {
    throw new AuthError(503, {});
  }
  const res = data as RunsResponse;
  if (!Array.isArray(res.runs)) {
    throw new AuthError(503, {});
  }
  for (const item of res.runs) {
    if (!isValidRun(item)) {
      throw new AuthError(503, {});
    }
  }
  return res.runs;
}

export async function listRuns(taskId: string, signal?: AbortSignal): Promise<Run[]> {
  if (!HEX_32_REGEX.test(taskId)) {
    throw new AuthError(404, { error: { id: 'task_not_found' } });
  }
  const data = await authRequest<unknown>(`/api/tasks/${encodeURIComponent(taskId)}/runs`, {
    method: 'GET',
    signal,
  });
  return parseRunsResponse(data);
}

export async function createRun(taskId: string, signal?: AbortSignal): Promise<Run> {
  if (!HEX_32_REGEX.test(taskId)) {
    throw new AuthError(404, { error: { id: 'task_not_found' } });
  }
  const data = await authRequest<unknown>(`/api/tasks/${encodeURIComponent(taskId)}/runs`, {
    method: 'POST',
    signal,
  });
  return parseRunResponse(data);
}

export async function getRun(runId: string, signal?: AbortSignal): Promise<Run> {
  if (!HEX_32_REGEX.test(runId)) {
    throw new AuthError(404, { error: { id: 'run_not_found' } });
  }
  const data = await authRequest<unknown>(`/api/runs/${encodeURIComponent(runId)}`, {
    method: 'GET',
    signal,
  });
  return parseRunResponse(data);
}

export async function cancelRun(runId: string, signal?: AbortSignal): Promise<Run> {
  if (!HEX_32_REGEX.test(runId)) {
    throw new AuthError(404, { error: { id: 'run_not_found' } });
  }
  const data = await authRequest<unknown>(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
    signal,
  });
  return parseRunResponse(data);
}

export function describeRunError(error: unknown): string {
  if (error instanceof AuthError) {
    const errorId = error.body?.error?.id;

    if (error.status === 401) {
      return '登录状态已失效，请重新登录。';
    }
    if (error.status === 404 || errorId === 'run_not_found' || errorId === 'task_not_found') {
      return '未找到指定的执行记录或任务。';
    }
    if (error.status === 409 || errorId === 'run_already_terminal' || errorId === 'concurrent_run_conflict') {
      return '当前执行状态已变更或已结束，无法取消。';
    }
    if (error.status === 429) {
      return '操作过于频繁，请稍后再试。';
    }
    if (error.status >= 500) {
      return '执行服务暂时不可用，请稍后重试。';
    }
  }

  if (error instanceof Error && error.name === 'AbortError') {
    return '请求已取消。';
  }

  return '执行操作失败，请检查网络后重试。';
}
