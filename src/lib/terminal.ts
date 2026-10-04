import { AuthError, authRequest } from './auth';

// Live terminals on the user's connected computers, relayed by the API.
// Keystrokes go up as small posts; output comes back by long-polling from a
// byte position, so a slow or dropped read never loses or repeats output.

export type TerminalState = 'opening' | 'open' | 'closed';
export interface TerminalRead { data: Uint8Array; cursor: number; state: TerminalState; skipped: boolean; exitCode?: number; error?: string }

const encoder = new TextEncoder();
const validID = (id: string) => /^[A-Za-z0-9_-]{1,128}$/.test(id);

function toBase64(bytes: Uint8Array) {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

function fromBase64(text: string) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
  return bytes;
}

export async function openTerminal(workspaceId: string, size: { cols: number; rows: number }, cwd?: string, signal?: AbortSignal) {
  if (!validID(workspaceId)) throw new AuthError(400, { error: { id: 'invalid_workspace_request' } });
  const response = await authRequest<{ terminal?: { id?: unknown } }>(`/api/workspaces/${workspaceId}/terminals`, {
    method: 'POST', signal, body: JSON.stringify({ cols: size.cols, rows: size.rows, ...(cwd ? { cwd } : {}) }),
  });
  const id = response.terminal?.id;
  if (typeof id !== 'string' || !validID(id)) throw new AuthError(502);
  return id;
}

/** Sends keystrokes (at most 24 KB a call; longer pastes are split). */
export async function sendTerminalInput(id: string, text: string) {
  const bytes = encoder.encode(text);
  for (let at = 0; at < bytes.length; at += 16 << 10) {
    await authRequest(`/api/terminals/${id}/input`, { method: 'POST', body: JSON.stringify({ data: toBase64(bytes.subarray(at, at + (16 << 10))) }) });
  }
}

export async function resizeTerminal(id: string, cols: number, rows: number) {
  await authRequest(`/api/terminals/${id}/input`, { method: 'POST', body: JSON.stringify({ data: '', cols, rows }) });
}

export async function readTerminal(id: string, cursor: number, state: TerminalState, signal?: AbortSignal): Promise<TerminalRead> {
  const value = await authRequest<Record<string, unknown>>(`/api/terminals/${id}/read`, {
    method: 'POST', signal, body: JSON.stringify({ cursor, state }),
  }, 35_000);
  const next = value.state;
  if (typeof value.data !== 'string' || typeof value.cursor !== 'number' || (next !== 'opening' && next !== 'open' && next !== 'closed')) throw new AuthError(502);
  return {
    data: fromBase64(value.data), cursor: value.cursor, state: next, skipped: value.skipped === true,
    ...(typeof value.exit_code === 'number' ? { exitCode: value.exit_code } : {}),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  };
}

export async function closeTerminal(id: string) {
  await authRequest(`/api/terminals/${id}`, { method: 'DELETE' }).catch(() => undefined);
}

export function describeTerminalError(code: string | undefined) {
  switch (code) {
    case 'workspace_offline': return '这台电脑当前离线。请在电脑上运行 tjuclaw connect。';
    case 'workspace_capability_denied': return '这台电脑尚未开放远程终端。请在电脑上运行 tjuclaw workspace allow terminal.open（连同已开放的其他能力）。';
    case 'workspace_limit_reached': return '这台电脑同时打开的终端已达上限（4 个）。';
    case 'terminal_not_allowed': return '电脑拒绝了终端：本机设置没有开放 terminal.open。';
    case 'terminal_cwd_outside_root': return '项目目录不在这台电脑的工作空间根目录内，或目录不存在。';
    case 'terminal_limit_reached': return '这台电脑同时打开的终端已达上限。';
    case 'terminal_start_failed': return '电脑无法启动 shell。';
    case 'terminal_idle': return '终端闲置超过 30 分钟，已关闭。';
    default: return '终端连接失败，请稍后重试。';
  }
}
