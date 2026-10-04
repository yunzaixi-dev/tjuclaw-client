import { AuthError, authRequest } from './auth';

export const workspaceCapabilities = ['pi.prompt', 'claude.prompt', 'codex.prompt', 'mcp.call', 'terminal.open'] as const;
export type WorkspaceCapability = typeof workspaceCapabilities[number];
export type WorkspaceKind = 'local' | 'cloud';
export type SystemWorkspace = {
  id: string;
  name: string;
  kind: WorkspaceKind;
  capabilities: WorkspaceCapability[];
  online: boolean;
  last_seen_at: string | null;
  created_at: string;
};
export type WorkspaceRegistration = { workspace: SystemWorkspace; connection_token: string };
// Managed cloud registration requires an owner-owned Agent binding and returns
// no connector token. This page only implements explicit local CLI registration.
export type RegisterWorkspaceInput = { name: string; kind: 'local'; capabilities: WorkspaceCapability[] };

function invalidResponse(): never { throw new AuthError(502, { error: { id: 'workspace_invalid_response' } }); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function isCapability(value: unknown): value is WorkspaceCapability {
  return typeof value === 'string' && workspaceCapabilities.some(capability => capability === value);
}
function validID(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

// Select only public fields. In particular, a list response can never retain a token.
function parseWorkspace(value: unknown): SystemWorkspace {
  if (!isRecord(value) || !validID(value.id) || typeof value.name !== 'string' || !value.name.trim()
    || (value.kind !== 'local' && value.kind !== 'cloud') || typeof value.online !== 'boolean'
    || !Array.isArray(value.capabilities) || !value.capabilities.every(isCapability)
    || typeof value.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at))
    || (value.last_seen_at !== null && (typeof value.last_seen_at !== 'string'
      || (value.last_seen_at !== '' && !Number.isFinite(Date.parse(value.last_seen_at)))))) invalidResponse();
  return {
    id: value.id, name: value.name, kind: value.kind, capabilities: [...new Set(value.capabilities)],
    online: value.online, last_seen_at: value.last_seen_at || null, created_at: value.created_at,
  };
}

export async function listSystemWorkspaces(signal?: AbortSignal): Promise<SystemWorkspace[]> {
  const response = await authRequest<unknown>('/api/workspaces', { signal });
  if (!isRecord(response) || !Array.isArray(response.workspaces)) invalidResponse();
  return response.workspaces.map(parseWorkspace);
}

export async function registerSystemWorkspace(input: RegisterWorkspaceInput, signal?: AbortSignal): Promise<WorkspaceRegistration> {
  const name = input.name.trim();
  if (!name || [...name].length > 80 || input.kind !== 'local' || !input.capabilities.every(isCapability)) {
    throw new AuthError(400, { error: { id: 'invalid_workspace' } });
  }
  // No owner, executable, remote URL, or caller-controlled command is sent.
  const response = await authRequest<unknown>('/api/workspaces', {
    method: 'POST', signal,
    body: JSON.stringify({ name, kind: input.kind, capabilities: [...new Set(input.capabilities)] }),
  });
  if (!isRecord(response) || typeof response.connection_token !== 'string' || !response.connection_token
    || response.connection_token.length > 4096 || /\s/.test(response.connection_token)) invalidResponse();
  const workspace = parseWorkspace(response.workspace);
  if (workspace.kind !== 'local') invalidResponse();
  return { workspace, connection_token: response.connection_token };
}

export async function deleteSystemWorkspace(id: string, signal?: AbortSignal): Promise<void> {
  if (!validID(id)) throw new AuthError(400, { error: { id: 'invalid_workspace' } });
  await authRequest<unknown>(`/api/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE', signal });
}

export function workspaceConnectionError(error: unknown): string {
  if (error instanceof AuthError) {
    switch (error.body.error?.id) {
      case 'invalid_workspace':
      case 'invalid_workspace_request': return '连接信息不符合要求，请检查名称（最多 80 字）、环境类型与能力选择。';
      case 'invalid_capabilities':
      case 'capability_denied':
      case 'workspace_capability_denied': return '所选远程能力未获许可，请检查环境配置。';
      case 'workspace_limit_reached': return '系统环境连接数量已达上限，请先撤销不再使用的连接。';
      case 'workspace_invalid_response': return '连接服务返回了无法识别的数据，请刷新列表核对。';
    }
    if (error.status === 401) return '登录已失效，请重新登录后管理连接。';
    if (error.status === 403) return '当前请求未获授权，请检查登录状态后重试。';
    if (error.status === 404) return '连接不存在或你无权访问，请刷新列表。';
    if (error.status === 429) return '操作过于频繁，请稍后重试。';
    if (error.status === 503) return '系统工作空间连接服务暂不可用，请稍后重试。';
  }
  return '暂时无法连接服务，请检查网络后重试。';
}
