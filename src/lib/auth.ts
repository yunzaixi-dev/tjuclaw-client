export type IdentitySession = { id: string; email: string; email_verified: boolean; expires_at: string };
export type FlowState = {
  stage: 'email' | 'code';
  email?: string;
  expires_at?: string;
  resend_at?: string;
  captcha_endpoint: '/api/auth/captcha/';
};
type ErrorBody = { error?: { id?: string } };

export class AuthError extends Error {
  constructor(public status: number, public body: ErrorBody = {}) {
    super(body.error?.id || 'auth_unavailable');
    this.name = 'AuthError';
  }
}

// Provider credentials remain in HttpOnly cookies; callers use the same-origin API.
export async function authRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!path.startsWith('/api/')) throw new Error('Invalid API path');
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (init.signal?.aborted) abort();
  init.signal?.addEventListener('abort', abort, { once: true });
  const timeout = window.setTimeout(abort, 15000);
  try {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    if (typeof init.body === 'string') headers.set('Content-Type', 'application/json');
    const response = await fetch(path, { ...init, headers, signal: controller.signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    const body: unknown = response.status === 204 ? {} : await response.json().catch(() => {
      throw new AuthError(response.ok ? 503 : response.status);
    });
    if (!response.ok) throw new AuthError(response.status, body && typeof body === 'object' ? body as ErrorBody : {});
    return body as T;
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener('abort', abort);
  }
}

function validateSession(session: IdentitySession): IdentitySession {
  if (!session || typeof session.id !== 'string' || !session.id || typeof session.email !== 'string' || !session.email || session.email_verified !== true || !Number.isFinite(Date.parse(session.expires_at)) || Date.parse(session.expires_at) <= Date.now()) {
    throw new AuthError(503);
  }
  return session;
}

export async function readSession(signal?: AbortSignal): Promise<IdentitySession | null> {
  try { return validateSession(await authRequest<IdentitySession>('/api/auth/session', { signal })); }
  catch (error) {
    if (error instanceof AuthError && (error.status === 401 || error.status === 403)) return null;
    throw error;
  }
}

function validateFlow(flow: FlowState): FlowState {
  if (!flow || !['email', 'code'].includes(flow.stage) || flow.captcha_endpoint !== '/api/auth/captcha/' || (flow.stage === 'code' && (!flow.email || !Number.isFinite(Date.parse(flow.expires_at ?? '')) || !Number.isFinite(Date.parse(flow.resend_at ?? ''))))) {
    throw new AuthError(503);
  }
  return flow;
}
const post = <T,>(path: string, body: object, signal?: AbortSignal) => authRequest<T>(`/api/auth/${path}`, { method: 'POST', body: JSON.stringify(body), signal });
export async function readFlow(signal?: AbortSignal) { return validateFlow(await authRequest<FlowState>('/api/auth/flow', { signal })); }
export async function sendEmailCode(email: string, captchaToken: string, signal?: AbortSignal) { return validateFlow(await post<FlowState>('start', { email: email.trim(), captcha_token: captchaToken }, signal)); }
export async function verifyEmailCode(code: string, signal?: AbortSignal) { return validateSession(await post<IdentitySession>('verify', { code: code.trim() }, signal)); }
export async function resendEmailCode(captchaToken: string, signal?: AbortSignal) { return validateFlow(await post<FlowState>('resend', { captcha_token: captchaToken }, signal)); }
export async function loginWithPassword(email: string, password: string, captchaToken: string, signal?: AbortSignal) {
  return validateSession(await post<IdentitySession>('password', { email: email.trim(), password, captcha_token: captchaToken }, signal));
}
export async function registerWithPassword(email: string, password: string, captchaToken: string, signal?: AbortSignal) {
  return validateFlow(await post<FlowState>('register', { email: email.trim(), password, captcha_token: captchaToken }, signal));
}
export async function resetFlow(signal?: AbortSignal) { return validateFlow(await post<FlowState>('reset', {}, signal)); }
export async function logout() {
  await post('logout', {});
  if (await readSession()) throw new AuthError(503);
  location.replace('/auth/logged-out');
}

export function describeError(error: unknown): string {
  if (!(error instanceof AuthError)) return '暂时连接不上认证服务，请稍后重试。';
  switch (error.body.error?.id) {
    case 'invalid_email': return '请输入有效的邮箱地址。';
    case 'invalid_code': return '验证码不正确，请检查后再试。';
    case 'invalid_password': return '密码至少 8 个字符，最多 72 个字符。';
    case 'invalid_credentials': return '邮箱或密码不正确。若用验证码注册过，请改用验证码登录。';
    case 'account_exists': return '该邮箱已注册，请直接登录或改用验证码。';
    case 'captcha_required': return '请先完成安全验证。';
    case 'captcha_invalid': return '安全验证已失效，请重新验证。';
    case 'flow_expired': return '本次验证已过期，请重新开始。';
    case 'rate_limited': return '操作有些频繁，请稍后再试。';
    default: return error.status === 429 ? '操作有些频繁，请稍后再试。' : '暂时连接不上认证服务，请稍后重试。';
  }
}
