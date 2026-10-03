import { AuthError, authRequest } from './auth';
import type { Entry, Library } from './library';
import type { SystemWorkspace } from './workspace-connections';

export type CloudWorkspaceInput = { name: string; agent_entry_id: string; capabilities: Array<'pi.prompt'> };
export type WorkspaceRegistrationOptions = { local_registration_supported: boolean; cloud_registration_supported: boolean };

export function ownedCloudLibraries(libraries: Library[]): Array<{ id: string; name: string }> {
  return libraries.filter(library => library.role === 'owner').map(({ id, name }) => ({ id, name }));
}

export function cloudAgentOptions(entries: Entry[], libraryId: string): Array<{ id: string; title: string }> {
  return entries.filter(entry => entry.kind === 'agent' && entry.library_id === libraryId).map(({ id, title }) => ({ id, title }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Configured registration support only, never model/gateway readiness.
 * Callers must not infer permission from missing/nonboolean/failed responses. */
export async function workspaceRegistrationOptions(signal?: AbortSignal): Promise<WorkspaceRegistrationOptions> {
  const response = await authRequest<unknown>('/api/workspaces/registration-options', { signal });
  return {
    local_registration_supported: isRecord(response) && response.local_registration_supported === true,
    cloud_registration_supported: isRecord(response) && response.cloud_registration_supported === true,
  };
}

/** Separate managed-cloud contract. The backend authoritatively checks Agent
 * ownership; HTML selection and this validator are not an ownership grant. */
export async function registerCloudWorkspace(input: CloudWorkspaceInput, signal?: AbortSignal): Promise<SystemWorkspace> {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || [...name].length > 80 || typeof input.agent_entry_id !== 'string'
    || !/^[0-9a-f]{32}$/.test(input.agent_entry_id) || !Array.isArray(input.capabilities)
    || !input.capabilities.every(capability => capability === 'pi.prompt')) {
    throw new AuthError(400, { error: { id: 'invalid_cloud_workspace' } });
  }
  const response = await authRequest<unknown>('/api/workspaces', {
    method: 'POST', signal,
    body: JSON.stringify({ name, kind: 'cloud', capabilities: [...new Set(input.capabilities)], agent_entry_id: input.agent_entry_id }),
  });
  const invalid = () => { throw new AuthError(502, { error: { id: 'workspace_invalid_response' } }); };
  if (!isRecord(response) || Object.hasOwn(response, 'connection_token')) return invalid();
  const workspace = response.workspace;
  if (!isRecord(workspace) || Object.hasOwn(workspace, 'connection_token')
    || typeof workspace.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(workspace.id)
    || typeof workspace.name !== 'string' || !workspace.name.trim() || workspace.kind !== 'cloud'
    || typeof workspace.online !== 'boolean' || !Array.isArray(workspace.capabilities)
    || !workspace.capabilities.every(capability => capability === 'pi.prompt')
    || typeof workspace.created_at !== 'string' || !Number.isFinite(Date.parse(workspace.created_at))
    || (workspace.last_seen_at !== null && (typeof workspace.last_seen_at !== 'string'
      || (workspace.last_seen_at !== '' && !Number.isFinite(Date.parse(workspace.last_seen_at)))))) return invalid();
  // Unknown metadata, private bodies and secret fields are never retained.
  return {
    id: workspace.id, name: workspace.name, kind: 'cloud', capabilities: workspace.capabilities.length ? ['pi.prompt'] : [],
    online: workspace.online, last_seen_at: workspace.last_seen_at || null, created_at: workspace.created_at,
  };
}
