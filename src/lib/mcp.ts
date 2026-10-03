import { AuthError, authRequest } from './auth';

// The user's remote MCP servers. The API is their client: it lists their
// tools beside the product tools for every Agent turn and keeps any key.

export type McpAuth = 'none' | 'bearer' | 'header' | 'query';

export interface McpCatalogEntry {
  id: string;
  title: string;
  summary: string;
  description: string;
  publisher: string;
  homepage: string;
  auth: McpAuth;
  key_optional?: boolean;
  key_label?: string;
  key_help?: string;
  key_url?: string;
}

export interface McpServer {
  id: string;
  catalog_id?: string;
  name: string;
  title: string;
  url?: string;
  auth: McpAuth;
  auth_name?: string;
  has_secret: boolean;
  enabled: boolean;
}

export interface McpTool { name: string; description: string }

export interface CustomMcpServer {
  name: string;
  title: string;
  url: string;
  auth: McpAuth;
  auth_name: string;
  secret: string;
}

export function listMcp(signal?: AbortSignal) {
  return authRequest<{ catalog: McpCatalogEntry[]; servers: McpServer[] }>('/api/account/mcp', { signal });
}

export async function addCatalogMcp(catalogId: string, secret: string) {
  const body: Record<string, string> = { catalog_id: catalogId };
  if (secret.trim()) body.secret = secret.trim();
  return (await authRequest<{ server: McpServer }>('/api/account/mcp', { method: 'POST', body: JSON.stringify(body) })).server;
}

export async function addCustomMcp(server: CustomMcpServer) {
  const body = { ...server, url: server.url.trim(), name: server.name.trim(), title: server.title.trim(), auth_name: server.auth_name.trim(), secret: server.secret.trim() };
  return (await authRequest<{ server: McpServer }>('/api/account/mcp', { method: 'POST', body: JSON.stringify(body) })).server;
}

export async function updateMcp(id: string, change: { enabled?: boolean; secret?: string }) {
  return (await authRequest<{ server: McpServer }>(`/api/account/mcp/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(change) })).server;
}

export async function removeMcp(id: string) {
  await authRequest<unknown>(`/api/account/mcp/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function checkMcp(id: string) {
  return (await authRequest<{ tools: McpTool[] }>(`/api/account/mcp/${encodeURIComponent(id)}/check`, { method: 'POST' }, 20000)).tools;
}

export function describeMcpError(error: unknown): string {
  if (!(error instanceof AuthError)) return '网络连接失败，请稍后重试。';
  switch (error.body?.error?.id) {
    case 'mcp_secret_required': return '这个服务需要填写密钥。';
    case 'mcp_url_invalid': return '地址需要是公网可访问的 HTTPS 地址。';
    case 'mcp_name_taken': return '已经添加过同名的服务。';
    case 'mcp_limit_reached': return '最多添加 12 个服务，请先移除不用的。';
    case 'mcp_unauthorized': return '服务拒绝了访问，请检查密钥是否正确、是否有权限。';
    case 'mcp_unavailable': return '暂时连接不上这个服务，请稍后再试。';
    case 'mcp_protocol': return '服务的回应不符合 MCP 协议，请确认地址是 Streamable HTTP 端点。';
    case 'upstream_blocked': return '这个地址指向内网或本机，不能使用。';
    case 'mcp_server_not_found': return '这个服务已被移除。';
    case 'invalid_mcp_server': return '填写的内容不符合要求，请检查后重试。';
  }
  if (error.status === 401) return '登录状态已失效，请重新登录。';
  return '操作失败，请稍后重试。';
}
