/** Login diagnostics contain only a bounded numeric provider code, never its raw message. */
export function wpyLoginErrorMessage(error: unknown, loginContext = false): string | null {
  const detail = (error as { body?: { error?: { id?: string; upstream_code?: unknown } } } | null)?.body?.error;
  const code = typeof detail?.upstream_code === 'number' && Number.isInteger(detail.upstream_code)
    && detail.upstream_code >= 0 && detail.upstream_code <= 99999 ? detail.upstream_code : null;
  const suffix = code === null ? '' : `（服务码 ${code}）`;
  if (detail?.id === 'campus_invalid_credentials') {
    if (code === 40002) return `微北洋服务未找到该账号${suffix}。若官方 App 可登录，可尝试用学号验证，或反馈此服务码。`;
    if (code === 40004) return `微北洋服务拒绝了这次登录${suffix}。若官方 App 可登录，请反馈此服务码，不必反复修改密码。`;
    return `微北洋服务未接受这次登录${suffix}。若官方 App 可登录，请反馈此提示。`;
  }
  if (detail?.id === 'campus_auth_rejected') {
    return `微北洋认证服务未接受请求${suffix}；无法据此判断密码是否正确，请反馈${code === null ? '此提示' : '此服务码'}。`;
  }
  if (detail?.id === 'campus_invalid_response' && (loginContext || code !== null)) {
    return `微北洋未返回可确认的登录结果${suffix}；不代表密码错误，请稍后重试或反馈此提示。`;
  }
  return null;
}
