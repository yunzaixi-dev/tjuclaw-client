import { invoke, isTauri } from '@tauri-apps/api/core';
import { authRequest, AuthError } from './auth';
import { isChatSession, type ChatSession } from './library';

// The desktop app can run Agent turns in containers on the user's own Docker
// engine. The API still opens and closes every turn (tools, quota and the
// transcript stay on the server); the native side only drives Docker.

export type AgentRuntime = 'cloud' | 'local';

export interface LocalSandboxStatus {
  docker: boolean;
  images: boolean;
  running: boolean;
}

const RUNTIME_KEY = 'tjuclaw.agent.runtime.v1';
const PRODUCT_ORIGIN = 'https://app.tjuclaw.cloud';

/** The desktop app loads the product origin with native commands available. */
export function localSandboxSupported(): boolean {
  return isTauri() && location.origin === PRODUCT_ORIGIN && !/Android|iPhone|iPad/i.test(navigator.userAgent);
}

export function agentRuntime(): AgentRuntime {
  if (!localSandboxSupported()) return 'cloud';
  try { return localStorage.getItem(RUNTIME_KEY) === 'local' ? 'local' : 'cloud'; } catch { return 'cloud'; }
}

export function setAgentRuntime(runtime: AgentRuntime) {
  try { localStorage.setItem(RUNTIME_KEY, runtime); } catch { /* the choice lasts for this page only */ }
  started = null;
}

export async function localSandboxStatus(): Promise<LocalSandboxStatus> {
  return invoke<LocalSandboxStatus>('local_sandbox_status');
}

/** Pulls the pinned images; the first run downloads several hundred MB. */
export async function prepareLocalSandbox(): Promise<void> {
  await invoke('local_sandbox_prepare');
}

let started: Promise<void> | null = null;

/** Starts the local gateway with a fresh runtime grant, once per page. */
export function ensureLocalSandbox(): Promise<void> {
  started ??= (async () => {
    const runtime = await authRequest<{ grant: string; model: string; models: string[] }>('/api/sandbox/local/runtime', { method: 'POST', body: '{}' });
    const status = await localSandboxStatus();
    if (!status.docker) throw localError('local_docker_unavailable');
    if (!status.images) await prepareLocalSandbox();
    await invoke('local_sandbox_start', { apiOrigin: location.origin, runtimeGrant: runtime.grant, model: runtime.model, models: runtime.models });
  })().catch(error => { started = null; throw error; });
  return started;
}

function localError(id: string) {
  return new AuthError(503, { error: { id } });
}

/** Runs one Agent turn in the local sandbox and returns the updated session. */
export async function sendLocalTurn(sessionId: string, content: string, requestId: string): Promise<ChatSession> {
  await ensureLocalSandbox();
  const turn = await authRequest<{
    tool_grant: string; turn: number; owner_id: string; session_id: string; entry_id: string; profile: string; model: string;
  }>(`/api/sessions/${sessionId}/local-turns`, { method: 'POST', body: '{}' });
  let reply: { content: string; steps: unknown[] };
  try {
    reply = await invoke<{ content: string; steps: unknown[] }>('local_sandbox_turn', { turn: { ...turn, content } });
  } catch {
    // The gateway may have stopped (Docker restarted); start it once more.
    started = null;
    try {
      await ensureLocalSandbox();
      reply = await invoke<{ content: string; steps: unknown[] }>('local_sandbox_turn', { turn: { ...turn, content } });
    } catch {
      throw localError('local_sandbox_unavailable');
    }
  }
  const data = await authRequest<{ session: unknown }>(`/api/sessions/${sessionId}/local-turns/finish`, {
    method: 'POST',
    body: JSON.stringify({ tool_grant: turn.tool_grant, client_request_id: requestId, content, reply: reply.content, steps: reply.steps }),
  });
  if (!isChatSession(data.session)) throw new AuthError(503);
  return data.session;
}
