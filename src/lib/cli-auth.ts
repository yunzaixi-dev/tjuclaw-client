import { AuthError, authRequest } from './auth';

// Signing the TJUClaw CLI in: the confirm page approves a code the CLI shows,
// and Settings lists and revokes the tokens issued that way.

export interface CliDevice { name: string; created_at: string; user_code: string }
export interface CliToken { id: string; name: string; created_at: string; expires_at: string; last_used_at?: string }

const RETURN_KEY = 'tjuclaw.return.v1';

/** Normalises what a person types: XXXX-XXXX in capitals, or '' when invalid. */
export function normalizeUserCode(input: string) {
  const letters = input.toUpperCase().replace(/[^BCDFGHJKLMNPQRSTVWXZ]/g, '');
  return letters.length === 8 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : '';
}

export async function describeDevice(code: string, signal?: AbortSignal) {
  return authRequest<CliDevice>(`/api/cli/device/${encodeURIComponent(code)}`, { signal });
}

export async function decideDevice(code: string, approve: boolean) {
  await authRequest(`/api/cli/device/${encodeURIComponent(code)}/${approve ? 'approve' : 'deny'}`, { method: 'POST', body: '{}' });
}

export async function listCliTokens(signal?: AbortSignal) {
  const value = await authRequest<{ tokens?: CliToken[] }>('/api/cli/tokens', { signal });
  if (!Array.isArray(value.tokens)) throw new AuthError(502);
  return value.tokens;
}

export async function revokeCliToken(id: string) {
  await authRequest(`/api/cli/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Remembers a confirm page to come back to after signing in. */
export function rememberReturn(path: string) {
  try { sessionStorage.setItem(RETURN_KEY, path); } catch { /* storage unavailable */ }
}

/** Where to go after signing in: a remembered confirm page, else the workspace. */
export function takeReturn() {
  let path = '';
  try { path = sessionStorage.getItem(RETURN_KEY) ?? ''; sessionStorage.removeItem(RETURN_KEY); } catch { /* storage unavailable */ }
  return /^\/device(\?code=[A-Za-z-]{0,12})?$/.test(path) ? path : '/workspace';
}
