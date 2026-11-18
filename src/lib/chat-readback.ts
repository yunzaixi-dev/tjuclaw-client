import { AuthError } from './auth';
import { getSession, type ChatSession } from './library';

/** Returns the saved conversation through this turn, never across the next user message. */
export function savedTurnReply(session: ChatSession, sessionId: string, requestId: string, content: string): ChatSession | undefined {
  if (session.id !== sessionId) return;
  const messages = session.messages ?? [];
  const index = messages.findIndex(message => message.role === 'user' && message.client_request_id === requestId && message.content === content);
  const reply = index >= 0 ? messages[index + 1] : undefined;
  if (reply?.role !== 'assistant' || !reply.content.trim() || (reply.client_request_id && reply.client_request_id !== requestId)) return;
  return index + 2 === messages.length ? session : { ...session, messages: messages.slice(0, index + 2) };
}

/** A timed-out POST may still finish. Read without ever sending the turn again. */
async function readTurnAfterSendError(sessionId: string, requestId: string, content: string, pending: boolean,
  signal: AbortSignal, current: () => boolean): Promise<ChatSession | undefined> {
  const deadline = Date.now() + 200_000;
  while (!signal.aborted) {
    const session = await getSession(sessionId, signal);
    if (signal.aborted) return;
    const reply = savedTurnReply(session, sessionId, requestId, content);
    if (reply || !pending || Date.now() >= deadline || !current()) return reply;
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}

export async function recoverSend(cause: unknown, sessionId: string, requestId: string, content: string,
  signal: AbortSignal, current: () => boolean): Promise<ChatSession | 'refused' | undefined> {
  // These are refused before a turn can be stored.
  const refused = cause instanceof AuthError ? cause.body?.error?.id : undefined;
  if (refused && ['local_docker_unavailable', 'local_sandbox_unavailable', 'model_unconfigured', 'quota_exceeded',
    'quota_5h_exceeded', 'quota_7d_exceeded', 'quota_unavailable', 'sandbox_model_unavailable', 'upstream_blocked'].includes(refused)) return 'refused';
  const status = cause instanceof AuthError ? cause.status : 0;
  const pending = status === 0 || status === 502 || status === 504;
  const reply = await readTurnAfterSendError(sessionId, requestId, content, pending, signal, current);
  return reply ?? (!pending && cause instanceof AuthError ? 'refused' : undefined);
}
