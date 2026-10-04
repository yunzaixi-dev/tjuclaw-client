import { AuthError, authRequest } from './auth';
import { listSystemWorkspaces } from './workspace-connections';

// The work view groups conversations by where the work happens: the host a
// conversation runs on, a project folder (a working directory) on that host,
// or a folder the user made. See backend work_layout.go.

export const CLOUD_HOST = 'cloud';

/** terminal: the computer allows live terminals (terminal.open). */
export interface WorkHost { id: string; name: string; kind: 'cloud' | 'computer'; online: boolean; terminal?: boolean }
export interface WorkProject { id: string; host: string; name: string; path?: string; created_at: string }
export interface WorkFolder { id: string; name: string; created_at: string }
export interface WorkLayout { projects: WorkProject[]; folders: WorkFolder[] }
export interface SessionPlace { host?: string; project_id?: string; folder_id?: string }

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object';
const isProject = (value: unknown): value is WorkProject => isRecord(value) && typeof value.id === 'string' && typeof value.host === 'string' && typeof value.name === 'string';
const isFolder = (value: unknown): value is WorkFolder => isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string';

export async function getWorkLayout(signal?: AbortSignal): Promise<WorkLayout> {
  const data = await authRequest<{ layout?: unknown }>('/api/work/layout', { signal });
  const layout = data.layout;
  if (!isRecord(layout) || !Array.isArray(layout.projects) || !Array.isArray(layout.folders) || !layout.projects.every(isProject) || !layout.folders.every(isFolder)) throw new AuthError(503);
  return { projects: layout.projects, folders: layout.folders };
}

/** The cloud sandbox always; each registered computer once system workspaces are in use. */
export async function listWorkHosts(signal?: AbortSignal): Promise<WorkHost[]> {
  const cloud: WorkHost = { id: CLOUD_HOST, name: '云端沙箱', kind: 'cloud', online: true };
  try {
    const computers = await listSystemWorkspaces(signal);
    return [cloud, ...computers.filter(item => item.kind === 'local').map(item => ({ id: `ws:${item.id}`, name: item.name, kind: 'computer' as const, online: item.online, terminal: item.capabilities.includes('terminal.open') }))];
  } catch {
    return [cloud];
  }
}

export async function createWorkProject(input: { host: string; name: string; path?: string }) {
  const data = await authRequest<{ project?: unknown }>('/api/work/projects', { method: 'POST', body: JSON.stringify(input) });
  if (!isProject(data.project)) throw new AuthError(503);
  return data.project;
}

export async function updateWorkProject(id: string, change: { name?: string; path?: string }) {
  const data = await authRequest<{ project?: unknown }>(`/api/work/projects/${id}`, { method: 'PATCH', body: JSON.stringify(change) });
  if (!isProject(data.project)) throw new AuthError(503);
  return data.project;
}

export async function deleteWorkProject(id: string) {
  await authRequest<unknown>(`/api/work/projects/${id}`, { method: 'DELETE' });
}

export async function createWorkFolder(name: string) {
  const data = await authRequest<{ folder?: unknown }>('/api/work/folders', { method: 'POST', body: JSON.stringify({ name }) });
  if (!isFolder(data.folder)) throw new AuthError(503);
  return data.folder;
}

export async function renameWorkFolder(id: string, name: string) {
  const data = await authRequest<{ folder?: unknown }>(`/api/work/folders/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
  if (!isFolder(data.folder)) throw new AuthError(503);
  return data.folder;
}

export async function deleteWorkFolder(id: string) {
  await authRequest<unknown>(`/api/work/folders/${id}`, { method: 'DELETE' });
}

/** Moves a conversation; the answer is where it now sits. */
export async function placeSession(id: string, place: SessionPlace): Promise<SessionPlace> {
  const data = await authRequest<Record<string, unknown>>(`/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(place) });
  return { host: String(data.host ?? ''), project_id: String(data.project_id ?? ''), folder_id: String(data.folder_id ?? '') };
}

export function describeWorkError(error: unknown) {
  if (!(error instanceof AuthError)) return '网络连接失败，请稍后重试。';
  switch (error.body?.error?.id) {
    case 'project_name_taken': return '这台主机上已经有同名项目。';
    case 'project_limit_reached': return '项目数量已达上限（64 个）。';
    case 'folder_limit_reached': return '文件夹数量已达上限（64 个）。';
    case 'invalid_project': return '项目名称或路径不符合要求：电脑上的项目需要填写绝对路径。';
    case 'invalid_folder': return '文件夹名称不能为空，最多 60 个字。';
    case 'invalid_place': return '目标项目或文件夹已不存在，请刷新后重试。';
  }
  return error.status === 401 ? '登录状态已失效，请重新登录。' : '操作失败，请稍后重试。';
}
