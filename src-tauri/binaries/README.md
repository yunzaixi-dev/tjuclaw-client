# Desktop CLI sidecar

Desktop Cargo builds compile the pinned **public** `cmd/tjuclaw` source with Go
1.27 and stage `tjuclaw-<Rust target triple>[.exe]` here. Tauri `externalBin`
packages it beside the desktop executable. Generated binaries are ignored.
Android/iOS builds skip this step and have no host connector.

In the integration checkout the source is `../../cli` relative to `src-tauri`.
Standalone builders must first check out the reviewed CLI revision and set
`TJUCLAW_CLI_SOURCE_DIR` to that directory. No source is downloaded automatically;
no private component or root environment file is a build input. Desktop builds
fail rather than silently produce a CLI-less package.

Use a native toolchain for each package. macOS universal packaging also needs
`lipo`. Windows/Linux/macOS binary execution must be verified on each platform;
a Linux artifact does not establish Windows or macOS runtime behavior.

## Native bridge consent and configuration

The bridge resolves only the packaged sibling executable, once at startup.
There is no runtime PATH fallback and no webpage executable, argv, environment
map, config directory or root parameter. Mobile has no host commands. Read-only
status does not create a configuration. Init picks a folder using the native
dialog and requires a second native confirmation. Configuration changes,
link/unlink, capability changes and connector start/stop each require native
confirmation. Changing configuration requires stopping this app's connector.
The app never starts or reconnects the connector on load; exiting the native
app stops its owned process. External CLI processes are not managed by it.

`workspace_cli_import` picks a trusted JSON file using the native dialog; HTML
cannot supply its path or contents. Its optional fields are `endpoints`,
`plugins`, `mcp_servers`, and `runtime_auth`. Only fields present are replaced:

```json
{
  "endpoints": [
    {
      "name": "local",
      "base_url": "http://127.0.0.1:1234/v1",
      "model": "chosen-model"
    }
  ],
  "plugins": [],
  "mcp_servers": {},
  "runtime_auth": {}
}
```

An endpoint may additionally contain `api_key`: it is kept in native session
memory, supplied under a native-generated environment name to the fixed CLI,
and never written into CLI metadata or returned to HTML. Restarting the desktop
app requires importing it again. `api_key_env` references without an imported
key are not resolved from the desktop host's environment. MCP values follow the
CLI schema (`command`, `args`, `env` references), but can only enter through this
locally picked, explicitly trusted file. No tool is installed or run by import.
Plugin references in both configure and import must be fully absolute local Pi
extension paths on the native host (`/path/extension.ts` on Linux/macOS,
`C:\path\extension.ts` or `C:/path/extension.ts` on Windows). At most 32 unique
references of 512 UTF-8 bytes each are accepted. Relative/tilde paths, npm
references, file URIs, HTTP(S) URLs, UNC/device namespaces, controls/bidi
overrides, `=` and surrounding whitespace are rejected. Configure does not
install plugins; their trusted code may execute later when Pi runs, after
native confirmation and separate capability consent. Redacted status returns
only basenames and cannot be used as an editable configuration draft.
For endpoint-only configure, omit `plugins` entirely: the CLI transaction
preserves its current plugin list, including paths from native imports. An
explicit `plugins: []` also preserves it; supplied refs append uniquely.
GUI configure invokes fixed `workspace configure --merge`: endpoints upsert
by name while preserving all omitted originals. Full replacement or removal
requires native-picked import, which uses the non-merge configure protocol.
The bridge never reconstructs a list from status or
replays a stale list captured before consent. npm and HTTPS repository refs
are not supported by the current runtime and must not be offered as executable
plugins in the UI.
The webpage endpoint form accepts only `name`, `base_url`, and `model`;
it omits `api_key_env` entirely rather than replaying a potentially stale native
status snapshot. The CLI transaction preserves only the current reference when
both name and URL match exactly. Changing the URL clears the reference; explicit
reattachment requires a trusted native import. Concurrent credential revocations
must not be undone by saving a draft after a native dialog.
Neither import nor GUI configure accepts `allowed_capabilities`; remote grants
remain unchanged. Capability replacement/revocation has its own native consent.
Imported `runtime_auth` supports explicit `host-file` sources for Pi/Claude/Codex;
host `oauth-env` inheritance is deliberately unavailable. A configured account
attachment is not proof of login or usable credentials.

Availability reports `configuration_supported`, `link_supported`, and
`capabilities_supported` alongside init/connector support. The TypeScript
adapter treats absent flags from older status-only shells as false. These flags
never substitute for native consent, account login or model readiness.
On Windows, `reason: workspace_cli_windows_config_connect_only` is an
informational limitation even when the packaged CLI is available. Nonempty
capability grants are rejected before any confirmation or mutation with
`workspace_cli_windows_host_execution_unavailable`; an empty revocation remains
allowed. Metadata/config/link and outbound connection are supported, but prompt
and MCP host execution remain unavailable until invocation-tree supervision is
implemented. Linux/macOS behavior is unchanged; this is not Windows execution
or CI evidence.

Connector status is `{state, error}` with states `stopped`, `starting`,
`running`, `stopping`, `failed`. `running` requires the CLI's exact startup
connected event after heartbeat and recovery flush, not merely process spawn.
It does not prove model/login readiness or ongoing cloud availability.

Pending approvals are read from the fixed CLI/config. HTML gets only random ID,
runtime, session ID and expiry, not command input. A review accepts only an ID:
native reloads current pending details and presents allow/deny/cancel, then
rechecks the still-pending request before writing a one-shot reply via CLI.
Cancel sends no decision; the runtime defaults to denial on expiry. Oversized
reviews are refused rather than truncated. This does not auto-approve commands
or claim every runtime/tool supports interactive approvals.

Linux focused tests and actual CLI process interoperability are separate from
native dialog/manual verification and from `.deb`/installer inspection. CI must
pin a committed public CLI source before a distributed bundle can be claimed.

Official API references used for the native-only implementation:

- https://v2.tauri.app/plugin/dialog/
- https://docs.rs/tauri-plugin-dialog/2.7.1/tauri_plugin_dialog/
- https://v2.tauri.app/develop/sidecar/

The web capability deliberately grants no dialog, filesystem or shell plugin
IPC; dialogs are constructed by Rust on blocking worker threads.
