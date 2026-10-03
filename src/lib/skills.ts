import { AuthError, authRequest } from './auth';

// Reviewed skill plugins: instruction packs the Agent reads when a task fits.

export interface Skill {
  id: string;
  title: string;
  summary: string;
  description: string;
  enabled: boolean;
}

export async function listSkills(signal?: AbortSignal) {
  return (await authRequest<{ skills: Skill[] }>('/api/account/skills', { signal })).skills;
}

export async function setSkill(id: string, enabled: boolean) {
  await authRequest<unknown>(`/api/account/skills/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ enabled }) });
}

export function describeSkillError(error: unknown, reading = false) {
  if (error instanceof AuthError && error.status === 401) return '登录状态已失效，请重新登录。';
  if (error instanceof AuthError) return reading ? '暂时无法读取技能列表，请稍后重试。' : '暂时无法保存，请稍后重试。';
  return '网络连接失败，请稍后重试。';
}
