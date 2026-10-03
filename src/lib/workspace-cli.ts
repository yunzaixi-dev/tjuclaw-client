import { invoke, isTauri } from '@tauri-apps/api/core';

/** Desktop adapts a fixed packaged CLI, never an independent Agent. Build
 * wiring is not proof a distributed package contains it: native availability
 * checks the real sibling executable. Nothing autostarts or auto-approves. */
export interface WorkspaceCliAvailability {
  available: boolean;
  init_supported: boolean;
  connector_supported: boolean;
  configuration_supported: boolean;
  link_supported: boolean;
  capabilities_supported: boolean;
  reason: string | null;
  limitation: 'workspace_cli_local_consent_required';
  executable_source: 'sidecar' | 'unavailable';
  model_key_persistence: 'session_only';
}

export type WorkspaceCliCapability = 'pi.prompt' | 'claude.prompt' | 'codex.prompt' | 'mcp.call';
export interface WorkspaceCliEndpoint {
  name: string;
  model: string;
  /** Full endpoint URL/path and env references are not returned to HTML. */
  base_origin: string;
  requires_key: boolean;
  key_available: boolean;
}

/** Native projection of CLI PublicConfig; credentials and MCP argv/env never
 * cross this bridge. This says nothing about connector/server online status. */
export interface WorkspaceCliConfig {
  version: 1;
  id: string;
  name: string;
  root: string;
  allowed_capabilities: WorkspaceCliCapability[];
  linked: boolean;
  endpoints: WorkspaceCliEndpoint[];
  /** Basenames only. Never treat these as editable/full plugin references. */
  plugins: string[];
  mcp_servers: string[];
  /** Configuration only, NOT proof of login/usable credentials. */
  runtime_auth: Partial<Record<'pi' | 'claude' | 'codex', {
    mode: 'host-file' | 'oauth-env'; model: string; configured: boolean;
  }>>;
}

export interface WorkspaceCliConnectorStatus {
  /** running only after startup heartbeat/recovery, not model/login readiness. */
  state: 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';
  error: string | null;
}

export interface WorkspaceCliConfigurationDraft {
  /** CLI preserves current key references only when name AND base_url match;
   * URL changes clear the reference. This form cannot set/read keys or env.
   * Upsert by name, preserving all omitted endpoints. MCP/auth/grants remain
   * intact. Full replacement/removal only through native-picked import. */
  endpoints: Array<{ name: string; base_url: string; model: string }>;
  /** Fully absolute local Pi extension paths for the native host: /... on
   * Linux/macOS, C:\... (or C:/...) on Windows. At most 32 unique references,
   * each <=512 UTF-8 bytes, no control/bidi chars, = or surrounding whitespace.
   * No npm: refs, file: URIs, HTTP(S), relative/~ paths, UNC/device namespaces.
   * Native confirmation is required; no installation or immediate execution.
   * Appends unique refs, preserving ALL existing/native-imported plugins.
   * Omission and [] are no-ops; removal only through native-picked import.
   * Redacted status basenames must NEVER be used as an editable draft. */
  plugins?: string[];
}

export interface WorkspaceCliApproval {
  id: string;
  runtime: 'pi' | 'claude' | 'codex';
  session_id: string;
  expires_at: string;
}

export function workspaceCliSupported(): boolean {
  return isTauri() && !/Android|iPhone|iPad/i.test(navigator.userAgent);
}

export async function workspaceCliAvailability(): Promise<WorkspaceCliAvailability> {
  if (!workspaceCliSupported()) {
    return {
      available: false,
      init_supported: false,
      connector_supported: false,
      configuration_supported: false,
      link_supported: false,
      capabilities_supported: false,
      reason: 'workspace_cli_desktop_required',
      limitation: 'workspace_cli_local_consent_required',
      executable_source: 'unavailable',
      model_key_persistence: 'session_only',
    };
  }
  const result = await invoke<WorkspaceCliAvailability>('workspace_cli_availability');
  // Older status-only desktop shells omit mutation flags. Absence is not
  // permission: require an explicit true, as well as real CLI availability.
  return {
    ...result,
    init_supported: result.available === true && result.init_supported === true,
    connector_supported: result.available === true && result.connector_supported === true,
    configuration_supported: result.available === true && result.configuration_supported === true,
    link_supported: result.available === true && result.link_supported === true,
    capabilities_supported: result.available === true && result.capabilities_supported === true,
  };
}

/** Read-only fixed `tjuclaw --config-dir <native-dir> workspace status`. */
export async function workspaceCliStatus(): Promise<WorkspaceCliConfig> {
  if (!workspaceCliSupported()) throw new Error('workspace_cli_desktop_required');
  return invoke<WorkspaceCliConfig>('workspace_cli_status');
}

/** Request a native directory picker and native confirmation, not a webpage
 * root/consent. Must be called only after an explicit user action. Never starts
 * a connector or grants remote execution capabilities. */
export async function initWorkspaceCli(name: string): Promise<WorkspaceCliConfig> {
  if (!workspaceCliSupported()) throw new Error('workspace_cli_desktop_required');
  return invoke<WorkspaceCliConfig>('workspace_cli_init', { name });
}

function requireDesktop() {
  if (!workspaceCliSupported()) throw new Error('workspace_cli_desktop_required');
}

export async function workspaceCliConnectorStatus(): Promise<WorkspaceCliConnectorStatus> {
  requireDesktop();
  return invoke<WorkspaceCliConnectorStatus>('workspace_cli_connector_status');
}

/** Each mutation/start/stop displays a genuine native confirmation. Invoke only
 * from explicit UI actions; HTML provides neither host consent nor commands. */
export async function startWorkspaceCliConnector(): Promise<WorkspaceCliConnectorStatus> {
  requireDesktop();
  return invoke<WorkspaceCliConnectorStatus>('workspace_cli_connector_start');
}

export async function stopWorkspaceCliConnector(): Promise<WorkspaceCliConnectorStatus> {
  requireDesktop();
  return invoke<WorkspaceCliConnectorStatus>('workspace_cli_connector_stop');
}

/** Upserts endpoints by name and appends unique plugin refs; omission/[] cannot
 * remove originals. Full replace/removal uses native-picked trusted import.
 * Redacted status is NOT a draft and must never be replayed into configure. */
export async function configureWorkspaceCli(draft: WorkspaceCliConfigurationDraft): Promise<WorkspaceCliConfig> {
  requireDesktop();
  return invoke<WorkspaceCliConfig>('workspace_cli_configure', { draft });
}

/** No webpage path, MCP command/argv/env, auth source or key JSON accepted.
 * Import rejects allowed_capabilities; remote grants remain unchanged. */
export async function importWorkspaceCli(): Promise<WorkspaceCliConfig> {
  requireDesktop();
  return invoke<WorkspaceCliConfig>('workspace_cli_import');
}

/** Fixed product API; native shows destination ID, never the token. */
export async function linkWorkspaceCli(id: string, token: string): Promise<WorkspaceCliConfig> {
  requireDesktop();
  return invoke<WorkspaceCliConfig>('workspace_cli_link', { id, token });
}

export async function unlinkWorkspaceCli(): Promise<WorkspaceCliConfig> {
  requireDesktop();
  return invoke<WorkspaceCliConfig>('workspace_cli_unlink');
}

export async function allowWorkspaceCli(capabilities: WorkspaceCliCapability[]): Promise<WorkspaceCliConfig> {
  requireDesktop();
  return invoke<WorkspaceCliConfig>('workspace_cli_allow', { capabilities });
}

export async function workspaceCliApprovals(): Promise<WorkspaceCliApproval[]> {
  requireDesktop();
  return invoke<WorkspaceCliApproval[]>('workspace_cli_approvals');
}

/** Allow/deny/cancel is chosen exclusively in a native dialog after fetching
 * the current local request. No decision or operation detail accepted here. */
export async function reviewWorkspaceCliApproval(id: string): Promise<{ responded: true }> {
  requireDesktop();
  return invoke<{ responded: true }>('workspace_cli_review_approval', { id });
}
