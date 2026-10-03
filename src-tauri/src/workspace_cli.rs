//! Desktop GUI adapter for the fixed packaged TJUClaw CLI, not an Agent runtime.
//!
//! Remote HTML may request init, but cannot provide a root or consent. The
//! directory picker and final confirmation both belong to the native shell.
use crate::workspace_connector::{Connector, ConnectorStatus};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};

const OUTPUT_LIMIT: usize = 64 * 1024;
const STDERR_LIMIT: usize = 8 * 1024;
const TIMEOUT: Duration = Duration::from_secs(5);
const CONSENT_REQUIRED: &str = "workspace_cli_local_consent_required";
const CLOUD_API: &str = "https://app.tjuclaw.cloud/api";

#[derive(Clone)]
pub struct WorkspaceCli {
    executable: Option<PathBuf>,
    config_dir: Option<PathBuf>,
    busy: Arc<AtomicBool>,
    connector: Arc<Connector>,
    keys: Arc<Mutex<BTreeMap<String, String>>>,
    runtime_path: OsString,
}

impl WorkspaceCli {
    /// Resolve only the packaged sibling once. No PATH fallback in any build.
    pub fn new(app_config_dir: Option<PathBuf>) -> Self {
        Self {
            executable: resolve_sidecar(std::env::current_exe().ok().as_deref()),
            config_dir: app_config_dir
                .filter(|path| path.is_absolute())
                .map(|path| path.join("workspace-cli")),
            busy: Arc::new(AtomicBool::new(false)),
            connector: Arc::new(Connector::default()),
            keys: Arc::new(Mutex::new(BTreeMap::new())),
            runtime_path: trusted_runtime_path(),
        }
    }

    fn availability(&self) -> Availability {
        let reason = if self.executable.is_none() {
            Some("workspace_cli_unavailable")
        } else if self.config_dir.is_none() {
            Some("workspace_cli_config_unavailable")
        } else {
            None
        };
        Availability {
            available: reason.is_none(),
            init_supported: reason.is_none(),
            connector_supported: reason.is_none(),
            configuration_supported: reason.is_none(),
            link_supported: reason.is_none(),
            capabilities_supported: reason.is_none(),
            reason: reason.or(if cfg!(windows) {
                Some("workspace_cli_windows_config_connect_only")
            } else {
                None
            }),
            limitation: CONSENT_REQUIRED,
            executable_source: if self.executable.is_some() {
                "sidecar"
            } else {
                "unavailable"
            },
            model_key_persistence: "session_only",
        }
    }

    fn status(&self) -> Result<PublicConfig, &'static str> {
        let lease = BusyLease::acquire(self.busy.clone())?;
        self.status_with_lease(lease)
    }

    fn status_with_lease(&self, lease: Arc<BusyLease>) -> Result<PublicConfig, &'static str> {
        let (executable, config_dir) = self.paths()?;
        let mut command = status_command(executable, config_dir);
        let (success, stdout) = capture(&mut command, TIMEOUT, lease.clone())?;
        self.with_key_status(parse_status(success, &stdout)?)
    }

    fn with_key_status(&self, mut config: PublicConfig) -> Result<PublicConfig, &'static str> {
        let keys = self
            .keys
            .lock()
            .map_err(|_| "workspace_cli_state_unavailable")?;
        for endpoint in &mut config.endpoints {
            endpoint.key_available = endpoint.requires_key
                && endpoint.key_env == model_key_env(&endpoint.name)
                && keys.contains_key(&endpoint.name);
        }
        Ok(config)
    }

    pub fn shutdown(&self) {
        let _ = self.connector.stop();
    }

    fn paths(&self) -> Result<(&Path, &Path), &'static str> {
        Ok((
            self.executable
                .as_deref()
                .ok_or("workspace_cli_unavailable")?,
            self.config_dir
                .as_deref()
                .ok_or("workspace_cli_config_unavailable")?,
        ))
    }

    fn init(
        &self,
        consent: NativeInitConsent,
        lease: Arc<BusyLease>,
    ) -> Result<PublicConfig, &'static str> {
        self.connector.require_stopped()?;
        let (executable, config_dir) = self.paths()?;
        // Recheck a local symlink/rename change after the native confirmation.
        if selected_root(consent.root.clone())? != consent.root {
            return Err("workspace_cli_root_changed");
        }
        let mut command = init_command(executable, config_dir, &consent);
        let (success, stdout) = capture(&mut command, TIMEOUT, lease.clone())?;
        let config = parse_config(success, &stdout, "workspace_cli_init_failed")?;
        if Path::new(&config.root) != consent.root
            || config.name != consent.name
            || !config.allowed_capabilities.is_empty()
        {
            return Err("workspace_cli_invalid_output");
        }
        Ok(config)
    }

    fn connector_command(&self) -> Result<Command, &'static str> {
        let (executable, config_dir) = self.paths()?;
        let mut command = config_command(executable, config_dir);
        command.arg("connect").env("PATH", &self.runtime_path);
        // Only keys the user explicitly supplied to this application session.
        // No arbitrary env map, host OAuth, proxy, HOME, NODE_OPTIONS or global
        // model credentials are ever inherited into the daemon.
        for (name, value) in self
            .keys
            .lock()
            .map_err(|_| "workspace_cli_state_unavailable")?
            .iter()
        {
            command.env(model_key_env(name), value);
        }
        Ok(command)
    }

    fn mutate(
        &self,
        operation: Mutation,
        lease: Arc<BusyLease>,
    ) -> Result<PublicConfig, &'static str> {
        self.connector.require_stopped()?;
        let (executable, config_dir) = self.paths()?;
        let (mut command, input, failure) = mutation_command(executable, config_dir, operation)?;
        let (success, stdout) = capture_input(&mut command, TIMEOUT, lease.clone(), input)?;
        self.with_key_status(parse_config(success, &stdout, failure)?)
    }
}

#[derive(Serialize)]
pub struct Availability {
    available: bool,
    init_supported: bool,
    connector_supported: bool,
    configuration_supported: bool,
    link_supported: bool,
    capabilities_supported: bool,
    reason: Option<&'static str>,
    limitation: &'static str,
    executable_source: &'static str,
    model_key_persistence: &'static str,
}

/// Deliberately narrower than PublicConfig: do not forward arbitrary CLI JSON,
/// tokens, MCP env/argv, endpoint URLs, or future private fields to remote HTML.
#[derive(Debug, Deserialize, Serialize)]
pub struct PublicConfig {
    version: u32,
    id: String,
    name: String,
    root: String,
    #[serde(default)]
    allowed_capabilities: Vec<String>,
    #[serde(default)]
    linked: bool,
    #[serde(skip_deserializing)]
    endpoints: Vec<EndpointSummary>,
    #[serde(skip_deserializing)]
    plugins: Vec<String>,
    #[serde(skip_deserializing)]
    mcp_servers: Vec<String>,
    #[serde(skip_deserializing)]
    runtime_auth: BTreeMap<String, RuntimeAuthSummary>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeAuthSummary {
    mode: String,
    #[serde(default)]
    model: String,
    configured: bool,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct EndpointSummary {
    name: String,
    model: String,
    base_origin: String,
    requires_key: bool,
    key_available: bool,
    #[serde(skip)]
    key_env: String,
}

fn resolve_sidecar(current_exe: Option<&Path>) -> Option<PathBuf> {
    #[cfg(windows)]
    const BINARY: &str = "tjuclaw.exe";
    #[cfg(not(windows))]
    const BINARY: &str = "tjuclaw";
    let candidate = current_exe?.parent()?.join(BINARY);
    if !candidate.is_absolute() || candidate.symlink_metadata().ok()?.file_type().is_symlink() {
        return None;
    }
    let canonical = candidate.canonicalize().ok()?;
    let metadata = canonical.metadata().ok()?;
    if !metadata.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return None;
        }
    }
    Some(canonical)
}

fn trusted_runtime_path() -> OsString {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::join_paths(std::env::split_paths(&path).filter(|path| path.is_absolute()))
        .unwrap_or_default()
}

fn status_command(executable: &Path, config_dir: &Path) -> Command {
    let mut command = config_command(executable, config_dir);
    command.args(["workspace", "status"]);
    command
}

fn init_command(executable: &Path, config_dir: &Path, consent: &NativeInitConsent) -> Command {
    let mut command = config_command(executable, config_dir);
    command
        .args(["workspace", "init", "--root"])
        .arg(&consent.root)
        .arg("--name")
        .arg(&consent.name);
    command
}

fn config_command(executable: &Path, config_dir: &Path) -> Command {
    let mut command = Command::new(executable);
    command
        .arg("--config-dir")
        .arg(config_dir)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // No developer model credentials, shell settings, HOME, or plugin paths.
    // Status/init must not need user-global model state.
    if let Some(parent) = executable.parent() {
        command.current_dir(parent);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if let Some(root) = std::env::var_os("SystemRoot") {
            command.env("SystemRoot", root);
        }
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
}

/// The last reader releases the busy flag. If an unexpected descendant holds
/// a pipe open past the deadline, further requests cannot leak more threads.
struct BusyLease(Arc<AtomicBool>);

impl BusyLease {
    fn acquire(busy: Arc<AtomicBool>) -> Result<Arc<Self>, &'static str> {
        busy.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "workspace_cli_busy")?;
        Ok(Arc::new(Self(busy)))
    }
}

impl Drop for BusyLease {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn read_bounded(mut reader: impl Read, limit: usize) -> Result<Vec<u8>, &'static str> {
    let mut bytes = Vec::new();
    reader
        .by_ref()
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "workspace_cli_output_failed")?;
    if bytes.len() > limit {
        return Err("workspace_cli_output_limit");
    }
    Ok(bytes)
}

fn capture(
    command: &mut Command,
    timeout: Duration,
    lease: Arc<BusyLease>,
) -> Result<(bool, Vec<u8>), &'static str> {
    capture_input(command, timeout, lease, None)
}

fn capture_input(
    command: &mut Command,
    timeout: Duration,
    lease: Arc<BusyLease>,
    input: Option<Vec<u8>>,
) -> Result<(bool, Vec<u8>), &'static str> {
    if input
        .as_ref()
        .is_some_and(|bytes| bytes.len() > OUTPUT_LIMIT)
    {
        return Err("workspace_cli_input_limit");
    }
    if input.is_some() {
        command.stdin(Stdio::piped());
    }
    let mut child = command.spawn().map_err(|_| "workspace_cli_spawn_failed")?;
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    let (tx, rx) = mpsc::channel();
    let stdout_tx = tx.clone();
    let stdout_lease = lease.clone();
    // Builder::spawn reports resource exhaustion instead of panicking.
    let stdout_thread = std::thread::Builder::new().spawn(move || {
        let _lease = stdout_lease;
        let _ = stdout_tx.send((0, read_bounded(stdout, OUTPUT_LIMIT)));
    });
    let mut input_done = input.is_none();
    let input_thread = if let Some(bytes) = input {
        let stdin = child.stdin.take().expect("stdin is piped");
        let input_tx = tx.clone();
        let input_lease = lease.clone();
        Some(std::thread::Builder::new().spawn(move || {
            let _lease = input_lease;
            let result = write_input(stdin, bytes).map(|_| Vec::new());
            let _ = input_tx.send((2, result));
        }))
    } else {
        None
    };
    let stderr_thread = std::thread::Builder::new().spawn(move || {
        let _lease = lease;
        // Discard diagnostics, including secrets and full model URLs.
        let result = read_bounded(stderr, STDERR_LIMIT).map(|_| Vec::new());
        let _ = tx.send((1, result));
    });
    let result = (|| {
        if stdout_thread.is_err()
            || stderr_thread.is_err()
            || input_thread.as_ref().is_some_and(|result| result.is_err())
        {
            return Err("workspace_cli_output_failed");
        }
        let deadline = Instant::now() + timeout;
        let mut output = None;
        let mut stderr_done = false;
        let mut exit = None;
        loop {
            while let Ok((stream, bytes)) = rx.try_recv() {
                let bytes = bytes?;
                if stream == 0 {
                    output = Some(bytes);
                } else if stream == 1 {
                    stderr_done = true;
                } else {
                    input_done = true;
                }
            }
            if exit.is_none() {
                exit = child.try_wait().map_err(|_| "workspace_cli_wait_failed")?;
            }
            if let (Some(status), Some(bytes), true) =
                (exit, output.as_mut(), stderr_done && input_done)
            {
                return Ok((status.success(), std::mem::take(bytes)));
            }
            if Instant::now() >= deadline {
                return Err("workspace_cli_timeout");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    })();
    if result.is_err() {
        let _ = child.kill();
    }
    let _ = child.wait(); // Reap on success and on every failure after spawn.
    result
}

fn write_input(mut writer: impl Write, bytes: Vec<u8>) -> Result<(), &'static str> {
    writer
        .write_all(&bytes)
        .map_err(|_| "workspace_cli_input_failed")
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
}

/// CLI workspace identities may be base64url IDs beginning with '-' or '_'.
/// Endpoint/MCP names still use the separate, stricter identifier validator.
fn workspace_identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && (value.as_bytes()[0].is_ascii_alphanumeric() || b"-_".contains(&value.as_bytes()[0]))
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
}

fn valid_endpoint_url(value: &str) -> bool {
    if !safe_text(value, 2048) || has_direction_override(value) {
        return false;
    }
    let Ok(url) = value.parse::<tauri::Url>() else {
        return false;
    };
    ["http", "https"].contains(&url.scheme())
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
}

fn model_key_env(name: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(name.as_bytes());
    format!(
        "TJUCLAW_DESKTOP_KEY_{}",
        digest[..16]
            .iter()
            .map(|v| format!("{v:02X}"))
            .collect::<String>()
    )
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EndpointDraft {
    name: String,
    base_url: String,
    model: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigureDraft {
    endpoints: Vec<EndpointDraft>,
    /// Add references; omission and Some([]) preserve the current list.
    /// Absolute local Pi extension paths, never package refs or URLs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    plugins: Option<Vec<String>>,
}

fn valid_plugin_path(value: &str) -> bool {
    safe_text(value, 512)
        && value.trim() == value
        && !has_direction_override(value)
        && !value.contains('=')
        && !value.contains("://")
        // Reject UNC/network and device namespaces even on Windows. A drive
        // path must be fully absolute on the native host, not merely C:foo.
        && !value.starts_with("//")
        && !value.starts_with("\\\\")
        && Path::new(value).is_absolute()
}

fn validate_draft(draft: &ConfigureDraft) -> Result<(), &'static str> {
    let mut names = std::collections::BTreeSet::new();
    let plugins = draft.plugins.as_deref().unwrap_or_default();
    if draft.endpoints.len() > 16 || plugins.len() > 32 {
        return Err("workspace_cli_invalid_config");
    }
    for endpoint in &draft.endpoints {
        if !identifier(&endpoint.name)
            || !names.insert(&endpoint.name)
            || !safe_text(&endpoint.model, 160)
            || has_direction_override(&endpoint.model)
            || !valid_endpoint_url(&endpoint.base_url)
        {
            return Err("workspace_cli_invalid_config");
        }
    }
    names.clear();
    for plugin in plugins {
        if !valid_plugin_path(plugin) || !names.insert(plugin) {
            return Err("workspace_cli_invalid_config");
        }
    }
    Ok(())
}

/// Omit credentials entirely: only the CLI's locked Update may preserve a
/// CURRENT reference when name and URL match. Never replay a status snapshot
/// after the dialog: a separate CLI may have revoked it in the meantime.
fn configured_endpoints(draft: &[EndpointDraft]) -> Vec<serde_json::Value> {
    draft
        .iter()
        .map(|endpoint| {
            serde_json::json!({
                "name": endpoint.name, "model": endpoint.model,
                "base_url": endpoint.base_url
            })
        })
        .collect()
}

fn configure_input(draft: &ConfigureDraft) -> Result<Vec<u8>, &'static str> {
    let mut value = serde_json::json!({"endpoints": configured_endpoints(&draft.endpoints)});
    if let Some(plugins) = &draft.plugins {
        value["plugins"] = serde_json::json!(plugins);
    }
    // Never copy redacted status plugin basenames or a stale native list.
    // CLI Update preserves its CURRENT list when the field is absent.
    serde_json::to_vec(&value).map_err(|_| "workspace_cli_invalid_config")
}

enum Mutation {
    Configure(Vec<u8>),
    Merge(Vec<u8>),
    Link { id: String, token: String },
    Unlink,
    Allow(Vec<String>),
}

fn validate_capabilities(capabilities: &[String]) -> Result<(), &'static str> {
    let mut seen = std::collections::BTreeSet::new();
    if capabilities.len() > 4
        || capabilities.iter().any(|value| {
            !["pi.prompt", "claude.prompt", "codex.prompt", "mcp.call"].contains(&value.as_str())
                || !seen.insert(value)
        })
    {
        return Err("workspace_cli_invalid_capabilities");
    }
    Ok(())
}

fn validate_native_capabilities(capabilities: &[String]) -> Result<(), &'static str> {
    validate_platform_capabilities(capabilities, cfg!(windows))
}

fn validate_platform_capabilities(
    capabilities: &[String],
    windows_host: bool,
) -> Result<(), &'static str> {
    validate_capabilities(capabilities)?;
    if windows_host && !capabilities.is_empty() {
        // No invocation-tree supervisor yet: metadata and outbound connector
        // remain usable, but never offer host execution or a consent bypass.
        return Err("workspace_cli_windows_host_execution_unavailable");
    }
    Ok(())
}

fn mutation_command(
    executable: &Path,
    config_dir: &Path,
    operation: Mutation,
) -> Result<(Command, Option<Vec<u8>>, &'static str), &'static str> {
    let mut command = config_command(executable, config_dir);
    command.arg("workspace");
    Ok(match operation {
        Mutation::Configure(input) => {
            command.arg("configure");
            (command, Some(input), "workspace_cli_configure_failed")
        }
        Mutation::Merge(input) => {
            command.args(["configure", "--merge"]);
            (command, Some(input), "workspace_cli_configure_failed")
        }
        Mutation::Link { id, token } => {
            if !workspace_identity(&id)
                || token.len() < 32
                || token.len() > 4096
                || !token.bytes().all(|b| b.is_ascii_graphic())
            {
                return Err("workspace_cli_invalid_link");
            }
            command.args(["link", "--api", CLOUD_API, "--id"]).arg(id);
            // Connection credential never appears in argv, logs or status.
            (
                command,
                Some(token.into_bytes()),
                "workspace_cli_link_failed",
            )
        }
        Mutation::Unlink => {
            command.arg("unlink");
            (command, None, "workspace_cli_unlink_failed")
        }
        Mutation::Allow(capabilities) => {
            validate_native_capabilities(&capabilities)?;
            command.arg("allow").args(capabilities);
            (command, None, "workspace_cli_allow_failed")
        }
    })
}

/// File-only schema. This type is never an IPC argument. MCP command/argv,
/// auth file sources and key literals are accepted only from a locally picked
/// file and shown/consented to in native UI, never from webpage JSON.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeImport {
    #[serde(default)]
    endpoints: Option<Vec<ImportedEndpoint>>,
    #[serde(default)]
    plugins: Option<Vec<String>>,
    #[serde(default)]
    mcp_servers: Option<BTreeMap<String, ImportedMcp>>,
    #[serde(default)]
    runtime_auth: Option<BTreeMap<String, ImportedAuth>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ImportedEndpoint {
    name: String,
    base_url: String,
    model: String,
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    api_key_env: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ImportedMcp {
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ImportedAuth {
    mode: String,
    source: String,
    #[serde(default)]
    model: String,
}

struct PreparedImport {
    input: Vec<u8>,
    keys: BTreeMap<String, String>,
    preview: String,
}

fn prepare_import(bytes: &[u8]) -> Result<PreparedImport, &'static str> {
    if bytes.len() > OUTPUT_LIMIT {
        return Err("workspace_cli_input_limit");
    }
    let import: NativeImport =
        serde_json::from_slice(bytes).map_err(|_| "workspace_cli_invalid_import")?;
    let mut data = serde_json::Map::new();
    let mut keys = BTreeMap::new();
    let mut preview = String::new();
    if let Some(endpoints) = import.endpoints {
        let draft = ConfigureDraft {
            endpoints: endpoints
                .iter()
                .map(|e| EndpointDraft {
                    name: e.name.clone(),
                    base_url: e.base_url.clone(),
                    model: e.model.clone(),
                })
                .collect(),
            plugins: import.plugins.clone(),
        };
        validate_draft(&draft)?;
        let mut values = Vec::new();
        for endpoint in endpoints {
            preview.push_str(&format!(
                "端点：{} · {} · {}\n",
                endpoint.name, endpoint.model, endpoint.base_url
            ));
            let env = if let Some(key) = endpoint.api_key {
                if !safe_text(&key, 4096) {
                    return Err("workspace_cli_invalid_import");
                }
                let env = model_key_env(&endpoint.name);
                keys.insert(endpoint.name.clone(), key);
                env
            } else {
                endpoint.api_key_env.unwrap_or_default()
            };
            // References are configuration only; no host variables inherited.
            values.push(serde_json::json!({"name":endpoint.name,"base_url":endpoint.base_url,"model":endpoint.model,"api_key_env":env}));
        }
        data.insert("endpoints".into(), serde_json::Value::Array(values));
    }
    if let Some(plugins) = import.plugins {
        validate_draft(&ConfigureDraft {
            endpoints: vec![],
            plugins: Some(plugins.clone()),
        })?;
        for plugin in &plugins {
            preview.push_str(&format!("插件：{plugin}\n"));
        }
        data.insert("plugins".into(), serde_json::json!(plugins));
    }
    if let Some(servers) = import.mcp_servers {
        if servers.len() > 32 {
            return Err("workspace_cli_invalid_import");
        }
        for (name, server) in &servers {
            if !identifier(name)
                || !safe_text(&server.command, 4096)
                || has_direction_override(&server.command)
                || server.args.len() > 128
                || server.env.len() > 128
                || server
                    .args
                    .iter()
                    .any(|arg| arg.len() > 8192 || arg.chars().any(char::is_control))
            {
                return Err("workspace_cli_invalid_import");
            }
            // Arg literals may be secrets: never show or forward them to HTML.
            preview.push_str(&format!(
                "MCP：{name} · 可执行文件 {} · {} 个参数（不展示内容）\n",
                server.command,
                server.args.len()
            ));
        }
        data.insert("mcp_servers".into(), serde_json::json!(servers));
    }
    if let Some(auth) = import.runtime_auth {
        if auth.len() > 3 {
            return Err("workspace_cli_invalid_import");
        }
        for (runtime, attachment) in &auth {
            if !["pi", "claude", "codex"].contains(&runtime.as_str())
                || attachment.mode != "host-file"
                || !safe_text(&attachment.source, 4096)
                || has_direction_override(&attachment.source)
                || !Path::new(&attachment.source).is_absolute()
                || (!attachment.model.is_empty() && !safe_text(&attachment.model, 256))
            {
                // env_clear intentionally makes host oauth-env unavailable.
                return Err("workspace_cli_auth_import_unsupported");
            }
            preview.push_str(&format!(
                "账号附件：{runtime} · 本机凭据文件 {}\n",
                attachment.source
            ));
        }
        data.insert("runtime_auth".into(), serde_json::json!(auth));
    }
    if data.is_empty() || preview.len() > 16 * 1024 {
        return Err("workspace_cli_invalid_import");
    }
    Ok(PreparedImport {
        input: serde_json::to_vec(&data).map_err(|_| "workspace_cli_invalid_import")?,
        keys,
        preview,
    })
}

fn parse_status(success: bool, bytes: &[u8]) -> Result<PublicConfig, &'static str> {
    parse_config(success, bytes, "workspace_cli_status_failed")
}

fn parse_config(
    success: bool,
    bytes: &[u8],
    failure: &'static str,
) -> Result<PublicConfig, &'static str> {
    if bytes.len() > OUTPUT_LIMIT {
        return Err("workspace_cli_output_limit");
    }
    let envelope: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| "workspace_cli_invalid_output")?;
    if envelope.get("ok").and_then(|ok| ok.as_bool()) == Some(false) && !success {
        // Only documented config errors are exposed, never arbitrary messages.
        return Err(
            match envelope.pointer("/error/id").and_then(|id| id.as_str()) {
                Some("workspace_not_initialized") => "workspace_cli_not_initialized",
                Some("workspace_config_unavailable") => "workspace_cli_config_unavailable",
                _ => failure,
            },
        );
    }
    if !success {
        return Err(failure);
    }
    if envelope.get("ok").and_then(|ok| ok.as_bool()) != Some(true)
        || envelope.get("error").is_some()
    {
        return Err("workspace_cli_invalid_output");
    }
    let data = envelope
        .get("data")
        .filter(|data| data.is_object())
        .ok_or("workspace_cli_invalid_output")?;
    let mut config: PublicConfig = serde_json::from_value(
        envelope
            .get("data")
            .filter(|data| data.is_object())
            .cloned()
            .ok_or("workspace_cli_invalid_output")?,
    )
    .map_err(|_| "workspace_cli_invalid_output")?;
    if config.version != 1
        || !workspace_identity(&config.id)
        || !safe_text(&config.name, 256)
        || has_direction_override(&config.name)
        || !safe_text(&config.root, 4096)
        || has_direction_override(&config.root)
        || !Path::new(&config.root).is_absolute()
        || config.allowed_capabilities.len() > 4
        || !config.allowed_capabilities.iter().all(|capability| {
            ["pi.prompt", "claude.prompt", "codex.prompt", "mcp.call"]
                .contains(&capability.as_str())
        })
    {
        return Err("workspace_cli_invalid_output");
    }
    if let Some(endpoints) = data.get("endpoints").and_then(|v| v.as_array()) {
        if endpoints.len() > 128 {
            return Err("workspace_cli_invalid_output");
        }
        for endpoint in endpoints {
            let name = endpoint
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let model = endpoint
                .get("model")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let base = endpoint
                .get("base_url")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let key_env = endpoint
                .get("api_key_env")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if !identifier(name) || !safe_text(model, 256) || !valid_endpoint_url(base) {
                return Err("workspace_cli_invalid_output");
            }
            let url: tauri::Url = base.parse().map_err(|_| "workspace_cli_invalid_output")?;
            config.endpoints.push(EndpointSummary {
                name: name.into(),
                model: model.into(),
                base_origin: url.origin().ascii_serialization(),
                requires_key: !key_env.is_empty(),
                key_available: false,
                key_env: key_env.into(),
            });
        }
    }
    for (field, object) in [
        ("endpoints", false),
        ("plugins", false),
        ("mcp_servers", true),
        ("runtime_auth", true),
    ] {
        if let Some(value) = data.get(field) {
            if !value.is_null()
                && !(if object {
                    value.is_object()
                } else {
                    value.is_array()
                })
            {
                return Err("workspace_cli_invalid_output");
            }
        }
    }
    if let Some(plugins) = data.get("plugins").and_then(|v| v.as_array()) {
        if plugins.len() > 128 {
            return Err("workspace_cli_invalid_output");
        }
        for plugin in plugins {
            let path = plugin.as_str().ok_or("workspace_cli_invalid_output")?;
            if !safe_text(path, 2048) {
                return Err("workspace_cli_invalid_output");
            }
            let name = Path::new(path)
                .file_name()
                .and_then(|v| v.to_str())
                .ok_or("workspace_cli_invalid_output")?;
            config.plugins.push(name.to_string());
        }
    }
    if let Some(servers) = data.get("mcp_servers").and_then(|v| v.as_object()) {
        if servers.len() > 128 {
            return Err("workspace_cli_invalid_output");
        }
        for name in servers.keys() {
            if !identifier(name) {
                return Err("workspace_cli_invalid_output");
            }
            config.mcp_servers.push(name.clone());
        }
    }
    if let Some(auth) = data.get("runtime_auth").and_then(|v| v.as_object()) {
        if auth.len() > 3 {
            return Err("workspace_cli_invalid_output");
        }
        for (name, value) in auth {
            let summary: RuntimeAuthSummary = serde_json::from_value(value.clone())
                .map_err(|_| "workspace_cli_invalid_output")?;
            if !["pi", "claude", "codex"].contains(&name.as_str())
                || !["host-file", "oauth-env"].contains(&summary.mode.as_str())
                || (!summary.model.is_empty()
                    && (!safe_text(&summary.model, 256) || has_direction_override(&summary.model)))
            {
                return Err("workspace_cli_invalid_output");
            }
            config.runtime_auth.insert(name.clone(), summary);
        }
    }
    Ok(config)
}

fn safe_text(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}

fn check_window(window: &tauri::WebviewWindow) -> Result<(), &'static str> {
    let url = window.url().map_err(|_| "workspace_cli_origin_denied")?;
    if window.label() != "main" || !allowed_page(&url) {
        return Err("workspace_cli_origin_denied");
    }
    Ok(())
}

fn allowed_page(url: &tauri::Url) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    // `tauri:` is a non-special URL scheme with an opaque URL origin.
    let bundled =
        url.scheme() == "tauri" && url.host_str() == Some("localhost") && url.port().is_none();
    let origin = url.origin().ascii_serialization();
    bundled
        || origin == "https://app.tjuclaw.cloud"
        || origin == "http://tauri.localhost"
        || origin == "https://tauri.localhost"
        || (cfg!(debug_assertions) && origin == "http://127.0.0.1:5173")
}

#[tauri::command]
pub fn workspace_cli_availability(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceCli>,
) -> Result<Availability, &'static str> {
    check_window(&window)?;
    Ok(state.availability())
}

#[tauri::command]
pub async fn workspace_cli_status(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceCli>,
) -> Result<PublicConfig, &'static str> {
    check_window(&window)?;
    let cli = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || cli.status())
        .await
        .map_err(|_| "workspace_cli_status_failed")?
}

/// Not deserializable: only native dialog code can construct production consent.
#[derive(Debug)]
struct NativeInitConsent {
    root: PathBuf,
    name: String,
}

fn has_direction_override(value: &str) -> bool {
    value.chars().any(|ch| {
        matches!(ch, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
    })
}

fn init_name(name: &str) -> Result<String, &'static str> {
    if !safe_text(name, 256) || has_direction_override(name) {
        return Err("workspace_cli_invalid_name");
    }
    Ok(name.trim().to_owned())
}

fn selected_root(root: PathBuf) -> Result<PathBuf, &'static str> {
    let root = root
        .canonicalize()
        .map_err(|_| "workspace_cli_invalid_root")?;
    let text = root.to_str().ok_or("workspace_cli_invalid_root")?;
    if !root.is_absolute()
        || !root.is_dir()
        || !safe_text(text, 4096)
        || has_direction_override(text)
    {
        return Err("workspace_cli_invalid_root");
    }
    Ok(root)
}

fn confirm_selection(
    root: PathBuf,
    name: String,
    confirmed: bool,
) -> Result<NativeInitConsent, &'static str> {
    if !confirmed {
        return Err("workspace_cli_cancelled");
    }
    Ok(NativeInitConsent { root, name })
}

fn native_consent(
    window: &tauri::WebviewWindow,
    name: String,
    executable: &Path,
    config_dir: &Path,
) -> Result<NativeInitConsent, &'static str> {
    let selected = window
        .dialog()
        .file()
        .set_parent(window)
        .set_title("TJUClaw · 选择本机工作空间目录")
        .blocking_pick_folder()
        .ok_or("workspace_cli_cancelled")?
        .into_path()
        .map_err(|_| "workspace_cli_invalid_root")?;
    let root = selected_root(selected)?;
    check_window(window)?;
    let confirmed = window
        .dialog()
        .message(format!(
            "是否初始化这个本机工作空间？\n\n名称：{name}\n目录：{}\n配置目录：{}\nCLI：{}\n\n仅创建独立配置，不覆盖已有配置，不启动 Agent 或云端连接。远程能力默认关闭；本机目录并不构成系统沙箱。",
            root.display(), config_dir.display(), executable.display()
        ))
        .title("TJUClaw · 确认本机初始化")
        .parent(window)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "初始化此目录".into(),
            "取消".into(),
        ))
        .blocking_show();
    check_window(window)?;
    confirm_selection(root, name, confirmed)
}

/// No root, argv, executable, environment, or confirmation argument from HTML.
#[tauri::command]
pub async fn workspace_cli_init(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceCli>,
    name: String,
) -> Result<PublicConfig, &'static str> {
    check_window(&window)?;
    let name = init_name(&name)?;
    let cli = state.inner().clone();
    cli.paths()?;
    // One native interaction at a time, including while a dialog is open.
    let lease = BusyLease::acquire(cli.busy.clone())?;
    tauri::async_runtime::spawn_blocking(move || {
        let (executable, config_dir) = cli.paths()?;
        let consent = native_consent(&window, name, executable, config_dir)?;
        check_window(&window)?;
        cli.init(consent, lease)
    })
    .await
    .map_err(|_| "workspace_cli_init_failed")?
}

fn confirm_native(
    window: &tauri::WebviewWindow,
    title: &str,
    message: String,
    action: &str,
) -> Result<(), &'static str> {
    if message.len() > 16 * 1024 {
        return Err("workspace_cli_consent_too_large");
    }
    check_window(window)?;
    let confirmed = window
        .dialog()
        .message(message)
        .title(title)
        .parent(window)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            action.into(),
            "取消".into(),
        ))
        .blocking_show();
    check_window(window)?;
    if !confirmed {
        return Err("workspace_cli_cancelled");
    }
    Ok(())
}

fn config_identity(config: &PublicConfig) -> String {
    format!(
        "环境：{} ({})\n本机目录：{}\n",
        config.name, config.id, config.root
    )
}

#[tauri::command]
pub fn workspace_cli_connector_status(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceCli>,
) -> Result<ConnectorStatus, &'static str> {
    check_window(&window)?;
    state.connector.status()
}

#[tauri::command]
pub async fn workspace_cli_connector_start(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceCli>,
) -> Result<ConnectorStatus, &'static str> {
    check_window(&window)?;
    let cli = state.inner().clone();
    let lease = BusyLease::acquire(cli.busy.clone())?;
    tauri::async_runtime::spawn_blocking(move || {
        cli.connector.require_stopped()?;
        let config = cli.status_with_lease(lease.clone())?;
        if !config.linked { return Err("workspace_cli_not_linked"); }
        confirm_native(&window, "TJUClaw · 启动本机连接器", format!(
            "{}\n是否启动出站 CLI 连接器？\n已许可能力：{}\n\n同账号远程任务可使用这些能力访问宿主机文件、网络及系统工具；目录不是沙箱。仅传入本次原生导入的模型密钥，不继承全局账号。连接器仅在桌面应用运行期间保持；不会自动重连或自动启动，不代表模型/审批已可用。",
            config_identity(&config), if config.allowed_capabilities.is_empty() { "无（仅连接状态）".into() } else { config.allowed_capabilities.join("、") },
        ), "启动连接器")?;
        let result = cli.connector.start(cli.connector_command()?);
        drop(lease);
        result
    }).await.map_err(|_| "workspace_cli_spawn_failed")?
}

#[tauri::command]
pub async fn workspace_cli_connector_stop(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceCli>,
) -> Result<ConnectorStatus, &'static str> {
    check_window(&window)?;
    let cli = state.inner().clone();
    let lease = BusyLease::acquire(cli.busy.clone())?;
    tauri::async_runtime::spawn_blocking(move || {
        confirm_native(&window, "TJUClaw · 停止本机连接器",
            "是否停止此桌面应用启动的连接器？\n\n将取消正在处理的任务并停止接收新调用。已执行的主机操作不会撤销，未送达的完成结果由 CLI 的本机恢复记录保留。其他自行启动的 CLI 不受影响。".into(),
            "停止连接器")?;
        let result = cli.connector.stop();
        drop(lease);
        result
    }).await.map_err(|_| "workspace_cli_stop_failed")?
}

#[tauri::command]
pub async fn workspace_cli_configure(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceCli>,
    draft: ConfigureDraft,
) -> Result<PublicConfig, &'static str> {
    check_window(&window)?;
    validate_draft(&draft)?;
    let cli = state.inner().clone();
    let lease = BusyLease::acquire(cli.busy.clone())?;
    tauri::async_runtime::spawn_blocking(move || {
        cli.connector.require_stopped()?;
        let current = cli.status_with_lease(lease.clone())?;
        let mut preview = config_identity(&current);
        for endpoint in &draft.endpoints {
            preview.push_str(&format!("端点：{} · {} · {}\n", endpoint.name, endpoint.model, endpoint.base_url));
        }
        match &draft.plugins {
            None => preview.push_str("插件：保留本机 CLI 当前列表（未提供新增引用）\n"),
            Some(plugins) if plugins.is_empty() => preview.push_str("插件：保留本机 CLI 当前列表（无新增引用）\n"),
            Some(plugins) => {
                for plugin in plugins { preview.push_str(&format!("插件：{plugin}\n")); }
            }
        }
        confirm_native(&window, "TJUClaw · 修改本机配置", format!(
            "{preview}\n按名称新增或更新端点，保留未提供的现有端点；插件引用追加去重，不删除现有引用。保留 MCP/账号附件及远程许可。完整替换或删除端点、插件、MCP 请通过本机可信文件导入。仅名称和 API 地址都未改变的端点可保留当前密钥引用；修改 API 地址会清除引用，若需重新附加请通过本机可信文件导入。执行时会向所选 API 地址发送内容。插件可能执行代码并访问宿主机。此次只保存，不安装、不调用模型、不启动连接器。"
        ), "保存本机配置")?;
        let input = configure_input(&draft)?;
        cli.mutate(Mutation::Merge(input), lease)
    }).await.map_err(|_| "workspace_cli_configure_failed")?
}

/// Import accepts no path or JSON from HTML, only a real native-picked file.
#[tauri::command]
pub async fn workspace_cli_import(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceCli>,
) -> Result<PublicConfig, &'static str> {
    check_window(&window)?;
    let cli = state.inner().clone();
    let lease = BusyLease::acquire(cli.busy.clone())?;
    tauri::async_runtime::spawn_blocking(move || {
        cli.connector.require_stopped()?;
        let current = cli.status_with_lease(lease.clone())?;
        let path = window.dialog().file().set_parent(&window)
            .set_title("TJUClaw · 选择本机可信配置 JSON（不要选择陌生文件）")
            .add_filter("JSON 配置", &["json"]).blocking_pick_file()
            .ok_or("workspace_cli_cancelled")?.into_path().map_err(|_| "workspace_cli_invalid_import")?;
        check_window(&window)?;
        let path = path.canonicalize().map_err(|_| "workspace_cli_invalid_import")?;
        if !path.is_file() || !safe_text(&path.to_string_lossy(), 4096) || has_direction_override(&path.to_string_lossy()) {
            return Err("workspace_cli_invalid_import");
        }
        // Capture the bounded bytes before confirmation; never re-open a file
        // later that could have changed behind the user's decision.
        let file = std::fs::File::open(&path).map_err(|_| "workspace_cli_invalid_import")?;
        let prepared = prepare_import(&read_bounded(file, OUTPUT_LIMIT)?)?;
        confirm_native(&window, "TJUClaw · 导入本机可信配置", format!(
            "{}文件：{}\n\n{}\n此文件可指定 MCP 可执行文件及参数、插件和账号附件；它们可能访问宿主机。仅导入你已审查的文件。账号附件将仅复制指定凭据文件到独立状态；不会继承 HOME 或全局账号。api_key 仅保留在本次桌面会话内，不返回网页、不写入 CLI 配置；退出后需重新导入。外部环境变量引用不会继承，可能不可用。不会初始化目录、扩大远程许可、启动连接或安装工具。",
            config_identity(&current), path.display(), prepared.preview
        ), "信任并导入此文件")?;
        let mut config = cli.mutate(Mutation::Configure(prepared.input), lease.clone())?;
        let mut keys = cli.keys.lock().map_err(|_| "workspace_cli_state_unavailable")?;
        // Apply secrets only after the CLI accepted the metadata transaction.
        keys.extend(prepared.keys);
        keys.retain(|name, _| config.endpoints.iter().any(|e| &e.name == name && e.key_env == model_key_env(name)));
        drop(keys);
        config = cli.with_key_status(config)?;
        Ok(config)
    }).await.map_err(|_| "workspace_cli_import_failed")?
}

#[tauri::command]
pub async fn workspace_cli_link(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceCli>,
    id: String,
    token: String,
) -> Result<PublicConfig, &'static str> {
    check_window(&window)?;
    // Validate before allocating a dialog, but never display the token.
    let cli = state.inner().clone();
    let (executable, dir) = cli.paths()?;
    mutation_command(
        executable,
        dir,
        Mutation::Link {
            id: id.clone(),
            token: token.clone(),
        },
    )?;
    let lease = BusyLease::acquire(cli.busy.clone())?;
    tauri::async_runtime::spawn_blocking(move || {
        cli.connector.require_stopped()?;
        let config = cli.status_with_lease(lease.clone())?;
        confirm_native(&window, "TJUClaw · 关联本机与云端", format!(
            "{}\n目标环境 ID：{id}\n产品 API：{CLOUD_API}\n\n将替换此本机配置的云端关联，专属连接凭据仅写入本机私密配置，不在命令参数或状态显示。不启动连接器，不开启远程能力。请确认这是你要关联的同账号环境。",
            config_identity(&config)
        ), "关联此环境")?;
        cli.mutate(Mutation::Link { id, token }, lease)
    }).await.map_err(|_| "workspace_cli_link_failed")?
}

#[tauri::command]
pub async fn workspace_cli_unlink(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceCli>,
) -> Result<PublicConfig, &'static str> {
    check_window(&window)?;
    let cli = state.inner().clone();
    let lease = BusyLease::acquire(cli.busy.clone())?;
    tauri::async_runtime::spawn_blocking(move || {
        cli.connector.require_stopped()?;
        let config = cli.status_with_lease(lease.clone())?;
        confirm_native(&window, "TJUClaw · 解除本机关联", format!(
            "{}\n仅删除此本机配置的 API 地址和连接凭据，不删除云端环境，也不撤销服务端凭据。要彻底撤销请在云端删除该环境。本机文件和许可保持不变。",
            config_identity(&config)
        ), "解除本机关联")?;
        cli.mutate(Mutation::Unlink, lease)
    }).await.map_err(|_| "workspace_cli_unlink_failed")?
}

#[tauri::command]
pub async fn workspace_cli_allow(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceCli>,
    capabilities: Vec<String>,
) -> Result<PublicConfig, &'static str> {
    check_window(&window)?;
    validate_native_capabilities(&capabilities)?;
    let cli = state.inner().clone();
    let lease = BusyLease::acquire(cli.busy.clone())?;
    tauri::async_runtime::spawn_blocking(move || {
        cli.connector.require_stopped()?;
        let config = cli.status_with_lease(lease.clone())?;
        let selected = if capabilities.is_empty() { "无（撤销全部远程能力）".into() } else { capabilities.join("、") };
        confirm_native(&window, "TJUClaw · 修改本机远程许可", format!(
            "{}\n新许可：{selected}\n\n开启 Agent/MCP 能力后，同账号远程调用可访问本机文件、网络和系统工具。工作目录不是隔离沙箱；工具必须已安装、配置及获得必要审批，不会自动登录、继承全局模型凭据或绕过工具审批。许可仅在下次明确启动连接器后同步云端，此次不启动。",
            config_identity(&config)
        ), "保存此许可")?;
        cli.mutate(Mutation::Allow(capabilities), lease)
    }).await.map_err(|_| "workspace_cli_allow_failed")?
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct ApprovalSummary {
    id: String,
    runtime: String,
    session_id: String,
    expires_at: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
struct LocalApproval {
    #[serde(flatten)]
    summary: ApprovalSummary,
    kind: String,
    #[serde(default)]
    tool: String,
    input: serde_json::Value,
}

#[derive(Serialize)]
pub struct ApprovalResponse {
    responded: bool,
}

fn local_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    bytes.len() == 36
        && bytes[14] == b'4'
        && b"89ab".contains(&bytes[19])
        && bytes.iter().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                *b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(b)
            }
        })
}

fn parse_approvals(success: bool, bytes: &[u8]) -> Result<Vec<LocalApproval>, &'static str> {
    if bytes.len() > OUTPUT_LIMIT {
        return Err("workspace_cli_output_limit");
    }
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| "workspace_cli_invalid_output")?;
    if !success || value["ok"] != true || value.get("error").is_some() {
        return Err("workspace_cli_approvals_unavailable");
    }
    let approvals: Vec<LocalApproval> = serde_json::from_value(value["data"]["approvals"].clone())
        .map_err(|_| "workspace_cli_invalid_output")?;
    if approvals.len() > 32 {
        return Err("workspace_cli_output_limit");
    }
    let mut ids = std::collections::BTreeSet::new();
    for approval in &approvals {
        if !local_id(&approval.summary.id)
            || !local_id(&approval.summary.session_id)
            || !ids.insert(&approval.summary.id)
            || !["pi", "claude", "codex"].contains(&approval.summary.runtime.as_str())
            || !safe_text(&approval.summary.expires_at, 40)
            || !approval
                .summary
                .expires_at
                .bytes()
                .all(|b| b.is_ascii_digit() || b"T:.-+Z".contains(&b))
            || !safe_text(&approval.kind, 128)
            || approval.tool.len() > 256
            || approval.tool.chars().any(char::is_control)
        {
            return Err("workspace_cli_invalid_output");
        }
    }
    Ok(approvals)
}

impl WorkspaceCli {
    fn pending_approvals(&self, lease: Arc<BusyLease>) -> Result<Vec<LocalApproval>, &'static str> {
        let (binary, dir) = self.paths()?;
        let mut command = config_command(binary, dir);
        command.arg("approvals");
        let (success, bytes) = capture(&mut command, TIMEOUT, lease)?;
        parse_approvals(success, &bytes)
    }

    fn respond_approval(
        &self,
        id: &str,
        decision: &'static str,
        lease: Arc<BusyLease>,
    ) -> Result<ApprovalResponse, &'static str> {
        if !local_id(id) || !["allow", "deny"].contains(&decision) {
            return Err("workspace_cli_invalid_approval");
        }
        let (binary, dir) = self.paths()?;
        let mut command = config_command(binary, dir);
        command.args(["approval", id, decision]);
        let (success, bytes) = capture(&mut command, TIMEOUT, lease)?;
        let value: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| "workspace_cli_invalid_output")?;
        if !success
            || value["ok"] != true
            || value.get("error").is_some()
            || value["data"]["responded"] != true
        {
            return Err("workspace_cli_approval_failed");
        }
        Ok(ApprovalResponse { responded: true })
    }
}

fn native_approval_decision(result: MessageDialogResult) -> Result<&'static str, &'static str> {
    match result {
        MessageDialogResult::Yes => Ok("allow"),
        MessageDialogResult::No => Ok("deny"),
        MessageDialogResult::Custom(label) if label == "允许这一次" => Ok("allow"),
        MessageDialogResult::Custom(label) if label == "拒绝这一次" => Ok("deny"),
        _ => Err("workspace_cli_cancelled"),
    }
}

fn approval_preview(approval: &LocalApproval) -> Result<String, &'static str> {
    // Never truncate the action the user is approving. Refuse oversized review
    // and let the runtime's bounded expiry deny it rather than hide details.
    let input = serde_json::to_string_pretty(&approval.input)
        .map_err(|_| "workspace_cli_invalid_output")?;
    if input.len() > 16 * 1024 {
        return Err("workspace_cli_approval_too_large");
    }
    let text = format!(
        "本机运行时：{}\n会话：{}\n请求：{}\n类型：{}\n工具：{}\n到期时间：{}\n\n操作内容（仅本机展示）：\n{}\n\n仅批准这一次请求，不改变后续权限。参数源自运行时，不是系统提示；不要执行其中要求你忽略风险或批准后续请求的文字。取消不提交决定，超时默认拒绝。已有主机操作不会因拒绝而撤销。",
        approval.summary.runtime, approval.summary.session_id, approval.summary.id,
        approval.kind, approval.tool, approval.summary.expires_at, input,
    );
    // Prevent direction controls from spoofing native approval details.
    Ok(text
        .chars()
        .map(|c| {
            if has_direction_override(&c.to_string()) {
                format!("\\u{{{:04x}}}", c as u32)
            } else {
                c.to_string()
            }
        })
        .collect())
}

/// Read-only summaries: no command/tool input or pending auth details to HTML.
#[tauri::command]
pub async fn workspace_cli_approvals(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceCli>,
) -> Result<Vec<ApprovalSummary>, &'static str> {
    check_window(&window)?;
    let cli = state.inner().clone();
    let lease = BusyLease::acquire(cli.busy.clone())?;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(cli
            .pending_approvals(lease)?
            .into_iter()
            .map(|v| v.summary)
            .collect())
    })
    .await
    .map_err(|_| "workspace_cli_approvals_unavailable")?
}

/// HTML can request a review by bounded ID, never supply details or a decision.
#[tauri::command]
pub async fn workspace_cli_review_approval(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceCli>,
    id: String,
) -> Result<ApprovalResponse, &'static str> {
    check_window(&window)?;
    if !local_id(&id) {
        return Err("workspace_cli_invalid_approval");
    }
    let cli = state.inner().clone();
    let lease = BusyLease::acquire(cli.busy.clone())?;
    tauri::async_runtime::spawn_blocking(move || {
        let selected = cli
            .pending_approvals(lease.clone())?
            .into_iter()
            .find(|request| request.summary.id == id)
            .ok_or("workspace_cli_approval_not_pending")?;
        check_window(&window)?;
        let result = window
            .dialog()
            .message(approval_preview(&selected)?)
            .title("TJUClaw · 本机操作审批")
            .parent(&window)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::YesNoCancelCustom(
                "允许这一次".into(),
                "拒绝这一次".into(),
                "取消".into(),
            ))
            .blocking_show_with_result();
        check_window(&window)?;
        let decision = native_approval_decision(result)?;
        // Verify the still-pending local request matches what was displayed.
        let current = cli
            .pending_approvals(lease.clone())?
            .into_iter()
            .find(|request| request.summary.id == id)
            .ok_or("workspace_cli_approval_not_pending")?;
        if current != selected {
            return Err("workspace_cli_approval_changed");
        }
        cli.respond_approval(&id, decision, lease)
    })
    .await
    .map_err(|_| "workspace_cli_approval_failed")?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::ffi::OsStr;

    fn envelope() -> Vec<u8> {
        serde_json::to_vec(&json!({
            "ok": true,
            "data": {
                "version": 1, "id": "test-workspace", "name": "本机环境",
                "root": std::env::temp_dir(), "allowed_capabilities": [],
                "connection_token": "must-not-forward",
                "endpoints": [{"name": "test", "model": "test-model", "api_key_env": "SECRET", "base_url": "https://private.example/api"}],
                "mcp_servers": {"server": {"env": {"SECRET": "must-not-forward"}}}
            }
        }))
        .unwrap()
    }

    #[test]
    fn mutation_support_flags_require_both_managed_paths() {
        for executable in [None, Some(std::env::temp_dir().join("tjuclaw"))] {
            for config_dir in [None, Some(std::env::temp_dir().join("managed"))] {
                let supported = executable.is_some() && config_dir.is_some();
                let cli = WorkspaceCli {
                    executable: executable.clone(),
                    config_dir,
                    busy: Arc::new(AtomicBool::new(false)),
                    connector: Arc::new(Connector::default()),
                    keys: Arc::new(Mutex::new(BTreeMap::new())),
                    runtime_path: OsString::new(),
                };
                let availability = serde_json::to_value(cli.availability()).unwrap();
                for field in [
                    "available",
                    "init_supported",
                    "connector_supported",
                    "configuration_supported",
                    "link_supported",
                    "capabilities_supported",
                ] {
                    assert_eq!(availability[field], json!(supported), "{field}");
                }
                assert_eq!(availability["limitation"], CONSENT_REQUIRED);
                assert_eq!(availability["model_key_persistence"], "session_only");
                if supported && cfg!(windows) {
                    assert_eq!(
                        availability["reason"],
                        "workspace_cli_windows_config_connect_only"
                    );
                } else {
                    assert_eq!(availability["reason"].is_null(), supported);
                }
            }
        }
    }

    #[test]
    fn plugins_accept_only_bounded_unique_native_absolute_extension_paths() {
        let absolute = std::env::temp_dir()
            .join("chosen extension.ts")
            .to_str()
            .unwrap()
            .to_string();
        let draft = |plugins| ConfigureDraft {
            endpoints: vec![],
            plugins: Some(plugins),
        };
        assert!(validate_draft(&draft(vec![absolute.clone()])).is_ok());
        assert!(
            prepare_import(&serde_json::to_vec(&json!({"plugins": [absolute]})).unwrap()).is_ok()
        );
        for value in [
            "",
            "extension.ts",
            "./extension.ts",
            "../extension.ts",
            "~/extension.ts",
            "npm:package@1.2.3",
            "npm:@scope/package@1.2.3",
            "file:///tmp/extension.ts",
            "https://example.test/extension.ts",
            "http://127.0.0.1/extension.ts",
            "C:extension.ts",
            "\\\\server\\share\\extension.ts",
            "\\\\?\\C:\\extension.ts",
            "//server/share/extension.ts",
        ] {
            assert!(
                validate_draft(&draft(vec![value.into()])).is_err(),
                "{value}"
            );
            assert!(
                prepare_import(&serde_json::to_vec(&json!({"plugins": [value]})).unwrap()).is_err()
            );
        }
        for value in [
            format!(" {absolute}"),
            format!("{absolute} "),
            format!("{absolute}\n"),
            format!("{absolute}\u{202e}"),
            format!("{absolute}=secret"),
            format!("{absolute}{}", "é".repeat(257)),
        ] {
            assert!(!valid_plugin_path(&value));
        }
        assert!(validate_draft(&draft(vec![absolute.clone(), absolute.clone()])).is_err());
        assert!(
            validate_draft(&draft((0..33).map(|n| format!("{absolute}{n}")).collect())).is_err()
        );
        #[cfg(windows)]
        {
            assert!(valid_plugin_path("C:\\extensions\\chosen.ts"));
            assert!(valid_plugin_path("C:/extensions/chosen.ts"));
            assert!(!valid_plugin_path("/extensions/chosen.ts"));
        }
        #[cfg(not(windows))]
        {
            assert!(valid_plugin_path("/extensions/chosen.ts"));
            assert!(!valid_plugin_path("C:\\extensions\\chosen.ts"));
        }
    }

    #[test]
    fn configure_omits_credential_references_and_cannot_replay_stale_status() {
        let draft = vec![
            EndpointDraft {
                name: "new".into(),
                base_url: "https://new.example/v1".into(),
                model: "new-model".into(),
            },
            EndpointDraft {
                name: "test".into(),
                base_url: "https://changed.example/v2".into(),
                model: "changed-model".into(),
            },
        ];
        let payload = configured_endpoints(&draft);
        for endpoint in &payload {
            assert_eq!(endpoint.as_object().unwrap().len(), 3);
            assert!(endpoint.get("api_key_env").is_none());
            assert!(endpoint.get("credential_ref").is_none());
            assert!(endpoint.get("api_key").is_none());
        }
        assert_eq!(payload[1]["base_url"], "https://changed.example/v2");
        assert_eq!(payload[1]["model"], "changed-model");
        assert!(!serde_json::to_string(&payload).unwrap().contains("SECRET"));
        assert!(configured_endpoints(&[]).is_empty());
    }

    #[test]
    fn configure_encodes_only_additions_and_never_reconstructs_originals() {
        let omitted: ConfigureDraft = serde_json::from_value(json!({"endpoints": []})).unwrap();
        validate_draft(&omitted).unwrap();
        let input: serde_json::Value =
            serde_json::from_slice(&configure_input(&omitted).unwrap()).unwrap();
        assert!(input.get("plugins").is_none());
        assert_eq!(input["endpoints"], json!([]));

        let no_additions: ConfigureDraft =
            serde_json::from_value(json!({"endpoints": [], "plugins": []})).unwrap();
        validate_draft(&no_additions).unwrap();
        let input: serde_json::Value =
            serde_json::from_slice(&configure_input(&no_additions).unwrap()).unwrap();
        assert_eq!(input["plugins"], json!([]));

        let plugin = std::env::temp_dir().join("native-imported-extension.ts");
        let append: ConfigureDraft =
            serde_json::from_value(json!({"endpoints": [], "plugins": [plugin]})).unwrap();
        validate_draft(&append).unwrap();
        let input: serde_json::Value =
            serde_json::from_slice(&configure_input(&append).unwrap()).unwrap();
        assert_eq!(input["plugins"], json!([plugin]));
        assert!(serde_json::from_value::<ConfigureDraft>(
            json!({"endpoints": [], "plugins": "preserve"})
        )
        .is_err());
    }

    #[test]
    fn gui_merge_uses_fixed_flag_and_import_uses_replacement_protocol() {
        let binary = std::env::temp_dir().join("tjuclaw");
        let dir = std::env::temp_dir().join("native-managed");
        for (operation, expected) in [
            (
                Mutation::Merge(b"{}".to_vec()),
                vec!["workspace", "configure", "--merge"],
            ),
            (
                Mutation::Configure(b"{}".to_vec()),
                vec!["workspace", "configure"],
            ),
        ] {
            let (command, input, _) = mutation_command(&binary, &dir, operation).unwrap();
            assert_eq!(
                command.get_args().skip(2).collect::<Vec<_>>(),
                expected.iter().map(OsStr::new).collect::<Vec<_>>()
            );
            assert_eq!(input.unwrap(), b"{}");
        }
    }

    #[test]
    fn windows_refuses_host_grants_but_allows_revocation() {
        for capabilities in [
            vec!["pi.prompt".into()],
            vec!["claude.prompt".into()],
            vec!["codex.prompt".into()],
            vec!["mcp.call".into()],
        ] {
            assert_eq!(
                validate_platform_capabilities(&capabilities, true),
                Err("workspace_cli_windows_host_execution_unavailable")
            );
            assert!(validate_platform_capabilities(&capabilities, false).is_ok());
        }
        assert!(validate_platform_capabilities(&[], true).is_ok());
        assert!(validate_platform_capabilities(&[], false).is_ok());
        #[cfg(windows)]
        assert!(mutation_command(
            &std::env::temp_dir().join("tjuclaw.exe"),
            &std::env::temp_dir().join("managed"),
            Mutation::Allow(vec!["pi.prompt".into()])
        )
        .is_err());
    }

    #[test]
    fn native_import_cannot_change_grants_or_environment_identity() {
        for field in [
            "allowed_capabilities",
            "capabilities",
            "id",
            "name",
            "root",
            "api_base_url",
            "connection_token",
        ] {
            let mut input = json!({"plugins": []});
            input[field] = json!(["pi.prompt"]);
            assert!(
                prepare_import(&serde_json::to_vec(&input).unwrap()).is_err(),
                "{field}"
            );
        }
        assert!(prepare_import(br#"{"plugins":[]}"#).is_ok());
    }

    #[test]
    fn status_redacts_fields_and_defaults_to_no_permissions() {
        let config = parse_status(true, &envelope()).unwrap();
        assert!(config.allowed_capabilities.is_empty());
        let public = serde_json::to_value(config).unwrap();
        assert!(public.get("connection_token").is_none());
        assert_eq!(
            public["endpoints"][0]["base_origin"],
            "https://private.example"
        );
        assert!(public["endpoints"][0].get("api_key_env").is_none());
        assert!(public["endpoints"][0].get("base_url").is_none());
        assert_eq!(public["mcp_servers"], json!(["server"]));
        assert!(!public.to_string().contains("must-not-forward"));
    }

    #[test]
    fn rejects_malformed_trailing_and_oversized_json() {
        for bytes in [b"{}".as_slice(), b"\xff", b"{\"ok\":true,\"data\":null}"] {
            assert!(parse_status(true, bytes).is_err());
        }
        let mut bytes = envelope();
        bytes.extend_from_slice(b"{}");
        assert!(parse_status(true, &bytes).is_err());
        assert_eq!(
            parse_status(true, &vec![b' '; OUTPUT_LIMIT + 1]).unwrap_err(),
            "workspace_cli_output_limit"
        );
        assert_eq!(
            read_bounded(&b"12345"[..], 4).unwrap_err(),
            "workspace_cli_output_limit"
        );
    }

    #[test]
    fn rejects_invalid_config_and_nonzero_success_envelope() {
        let data: serde_json::Value = serde_json::from_slice(&envelope()).unwrap();
        for (key, value) in [
            ("version", json!(2)),
            ("root", json!("relative")),
            ("name", json!("")),
            ("id", json!("")),
            ("allowed_capabilities", json!(["shell.exec"])),
        ] {
            let mut invalid = data.clone();
            invalid["data"][key] = value;
            assert!(parse_status(true, &serde_json::to_vec(&invalid).unwrap()).is_err());
        }
        assert_eq!(
            parse_status(false, &envelope()).unwrap_err(),
            "workspace_cli_status_failed"
        );
        assert_eq!(
            parse_status(
                false,
                br#"{"ok":false,"error":{"id":"workspace_not_initialized","message":"secret"}}"#
            )
            .unwrap_err(),
            "workspace_cli_not_initialized"
        );
    }

    #[test]
    fn native_confirmation_cancel_never_produces_consent() {
        for root in ["/", "../elsewhere", "--config-dir", "", "/tmp/workspace"] {
            assert_eq!(
                confirm_selection(PathBuf::from(root), "名称".into(), false).unwrap_err(),
                "workspace_cli_cancelled"
            );
        }
    }

    #[test]
    fn rejects_misleading_or_unbounded_names_before_showing_dialogs() {
        assert_eq!(init_name(" 本机环境 ").unwrap(), "本机环境");
        for name in [
            "",
            " \t",
            "name\nconfirm",
            "\u{202e}confirm",
            "\u{2066}name",
        ] {
            assert_eq!(init_name(name).unwrap_err(), "workspace_cli_invalid_name");
        }
        assert_eq!(
            init_name(&"a".repeat(257)).unwrap_err(),
            "workspace_cli_invalid_name"
        );
        assert!(selected_root(PathBuf::from("/no-such-tjuclaw-native-root")).is_err());
    }

    #[test]
    fn only_product_and_native_pages_can_request_the_bridge() {
        for url in [
            "https://app.tjuclaw.cloud/workspace",
            "tauri://localhost/workspace",
            "http://tauri.localhost/",
            "https://tauri.localhost/",
        ] {
            assert!(allowed_page(&url.parse().unwrap()));
        }
        for url in [
            "https://evil.example/",
            "https://app.tjuclaw.cloud.evil.example/",
            "https://app.tjuclaw.cloud:444/",
            "https://user@app.tjuclaw.cloud/",
            "tauri://evil.example/",
            "tauri://localhost:123/",
            "file:///tmp/page.html",
            "data:text/html,hello",
        ] {
            assert!(!allowed_page(&url.parse().unwrap()));
        }
    }

    #[test]
    fn status_argv_and_environment_are_native_fixed() {
        let executable = std::env::temp_dir().join("tjuclaw");
        let dir = std::env::temp_dir().join("native-managed");
        let command = status_command(&executable, &dir);
        assert_eq!(command.get_program(), executable.as_os_str());
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [
                OsStr::new("--config-dir"),
                dir.as_os_str(),
                OsStr::new("workspace"),
                OsStr::new("status")
            ]
        );
        #[cfg(not(windows))]
        assert_eq!(command.get_envs().count(), 0);
        assert!(resolve_sidecar(Some(Path::new("relative/app"))).is_none());
    }

    #[test]
    fn init_argv_uses_native_selected_path_and_name_as_single_arguments() {
        let executable = std::env::temp_dir().join("tjuclaw");
        let dir = std::env::temp_dir().join("native-managed");
        let consent = NativeInitConsent {
            root: std::env::temp_dir().join("root with spaces"),
            name: "本机环境 --name other".into(),
        };
        let command = init_command(&executable, &dir, &consent);
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [
                OsStr::new("--config-dir"),
                dir.as_os_str(),
                OsStr::new("workspace"),
                OsStr::new("init"),
                OsStr::new("--root"),
                consent.root.as_os_str(),
                OsStr::new("--name"),
                OsStr::new(&consent.name),
            ]
        );
        #[cfg(not(windows))]
        assert_eq!(command.get_envs().count(), 0);
    }

    #[test]
    fn declarative_ipc_rejects_root_argv_env_and_unknown_fields() {
        for field in [
            "root",
            "argv",
            "command",
            "executable",
            "env",
            "mcp_servers",
            "runtime_auth",
        ] {
            let mut value = json!({"endpoints":[],"plugins":[]});
            value[field] = json!("web-controlled");
            assert!(
                serde_json::from_value::<ConfigureDraft>(value).is_err(),
                "{field}"
            );
        }
        assert!(serde_json::from_value::<ConfigureDraft>(json!({
            "endpoints":[{"name":"x","base_url":"https://example.test/api","model":"m","api_key":"secret"}],
            "plugins":[]
        })).is_err());
        for base in [
            "file:///tmp/x",
            "https://user:pass@example.test",
            "https://example.test?key=secret",
            "https://example.test/#secret",
        ] {
            assert!(!valid_endpoint_url(base));
        }
        assert!(valid_endpoint_url("http://127.0.0.1:1234/v1"));
        assert!(validate_capabilities(&["mcp.call".into(), "mcp.call".into()]).is_err());
        assert!(validate_capabilities(&["shell.exec".into()]).is_err());
    }

    #[test]
    fn link_uses_fixed_cloud_and_private_stdin_not_credential_argv() {
        let binary = std::env::temp_dir().join("tjuclaw");
        let dir = std::env::temp_dir().join("native-managed");
        let token = "secret-connection-token-0123456789abcdef";
        let (command, input, _) = mutation_command(
            &binary,
            &dir,
            Mutation::Link {
                id: "test-workspace".into(),
                token: token.into(),
            },
        )
        .unwrap();
        let args: Vec<_> = command.get_args().collect();
        assert!(args.contains(&OsStr::new(CLOUD_API)));
        assert!(!args.contains(&OsStr::new(token)));
        assert_eq!(input.unwrap(), token.as_bytes());
        let (command, _, _) = mutation_command(&binary, &dir, Mutation::Allow(vec![])).unwrap();
        assert_eq!(command.get_args().last(), Some(OsStr::new("allow")));
    }

    #[test]
    fn workspace_ids_accept_base64url_prefixes_without_relaxing_config_names() {
        let binary = std::env::temp_dir().join("tjuclaw");
        let dir = std::env::temp_dir().join("native-managed");
        let token = "synthetic-native-link-token-0123456789";
        for prefix in ["-", "_"] {
            let id = format!("{prefix}{}", "A".repeat(42));
            assert!(!identifier(&id)); // Endpoint/MCP names stay unchanged.
            let (command, input, _) = mutation_command(
                &binary,
                &dir,
                Mutation::Link {
                    id: id.clone(),
                    token: token.into(),
                },
            )
            .expect("backend-generated base64url workspace ID must be linkable");
            let args = command.get_args().collect::<Vec<_>>();
            assert_eq!(args[args.len() - 2], OsStr::new("--id"));
            assert_eq!(args.last().unwrap(), &OsStr::new(&id));
            assert_eq!(input.unwrap(), token.as_bytes());
            let mut status: serde_json::Value = serde_json::from_slice(&envelope()).unwrap();
            status["data"]["id"] = json!(id);
            assert_eq!(
                parse_status(true, &serde_json::to_vec(&status).unwrap())
                    .unwrap()
                    .id,
                id
            );
        }
        for id in [
            "",
            ".leading",
            "../path",
            "has space",
            "id/other",
            "id?secret",
            "id\nother",
        ] {
            assert!(
                mutation_command(
                    &binary,
                    &dir,
                    Mutation::Link {
                        id: id.into(),
                        token: token.into()
                    }
                )
                .is_err(),
                "{id:?}"
            );
            let mut status: serde_json::Value = serde_json::from_slice(&envelope()).unwrap();
            status["data"]["id"] = json!(id);
            assert!(
                parse_status(true, &serde_json::to_vec(&status).unwrap()).is_err(),
                "{id:?}"
            );
        }
        assert!(mutation_command(
            &binary,
            &dir,
            Mutation::Link {
                id: "A".repeat(129),
                token: token.into()
            }
        )
        .is_err());
    }

    #[test]
    fn native_import_secrets_are_session_only_and_not_in_config_or_preview() {
        let import = prepare_import(br#"{
            "endpoints":[{"name":"example","base_url":"https://example.test/v1","model":"test","api_key":"secret-do-not-echo"}],
            "mcp_servers":{"local":{"command":"trusted-mcp","args":["literal-secret"],"env":{}}},
            "runtime_auth":{"codex":{"mode":"host-file","source":"/native-picked/auth.json"}}
        }"#).unwrap();
        assert_eq!(import.keys["example"], "secret-do-not-echo");
        let payload: serde_json::Value = serde_json::from_slice(&import.input).unwrap();
        assert_eq!(
            payload["endpoints"][0]["api_key_env"],
            model_key_env("example")
        );
        assert!(!String::from_utf8(import.input)
            .unwrap()
            .contains("secret-do-not-echo"));
        assert!(!import.preview.contains("secret-do-not-echo"));
        assert!(!import.preview.contains("literal-secret"));
        assert!(prepare_import(br#"{"root":"/anywhere","endpoints":[]}"#).is_err());
        assert!(prepare_import(
            br#"{"runtime_auth":{"codex":{"mode":"oauth-env","source":"HOST_SECRET"}}}"#
        )
        .is_err());
        assert!(
            prepare_import(br#"{"mcp_servers":{"local":{"command":"a","command":"b"}}}"#).is_err()
        );
    }

    #[test]
    fn approvals_only_project_metadata_and_never_accept_web_decisions() {
        let bytes = serde_json::to_vec(&json!({"ok":true,"data":{"approvals":[{
            "id":"12345678-1234-4123-8123-123456789abc",
            "runtime":"codex","session_id":"abcdefab-1234-4123-8123-123456789abc",
            "kind":"command","tool":"shell","expires_at":"2030-01-01T00:00:00Z",
            "input":{"command":"private-command","env":{"KEY":"never-to-html"}}
        }]}}))
        .unwrap();
        let approval = parse_approvals(true, &bytes).unwrap().remove(0);
        let public = serde_json::to_string(&approval.summary).unwrap();
        assert!(!public.contains("private-command"));
        assert!(!public.contains("never-to-html"));
        assert!(!public.contains("shell"));
        assert!(approval_preview(&approval)
            .unwrap()
            .contains("private-command"));
        assert_eq!(
            native_approval_decision(MessageDialogResult::Yes),
            Ok("allow")
        );
        assert_eq!(
            native_approval_decision(MessageDialogResult::No),
            Ok("deny")
        );
        for result in [
            MessageDialogResult::Ok,
            MessageDialogResult::Cancel,
            MessageDialogResult::Custom("allow".into()),
        ] {
            assert_eq!(
                native_approval_decision(result),
                Err("workspace_cli_cancelled")
            );
        }
        for id in [
            "../request",
            "--config-dir",
            "",
            "12345678123441238123123456789abc",
        ] {
            assert!(!local_id(id));
        }
        let mut large = approval.clone();
        large.input = json!({"command":"a".repeat(16 * 1024)});
        assert_eq!(
            approval_preview(&large),
            Err("workspace_cli_approval_too_large")
        );
        let mut misleading = approval;
        misleading.input = json!({"command":"\u{202e}spoof"});
        let preview = approval_preview(&misleading).unwrap();
        assert!(!preview.contains('\u{202e}'));
        assert!(preview.contains("\\u{202e}"));
        assert_eq!(
            parse_approvals(false, br#"{"ok":false,"error":{"id":"secret-error"}}"#).unwrap_err(),
            "workspace_cli_approvals_unavailable"
        );
    }

    #[cfg(unix)]
    #[test]
    fn sidecar_resolution_never_uses_path_or_follows_binary_symlink() {
        let _serial = FAKE_CLI_LOCK.lock().unwrap();
        let fake = FakeCli::new("exit 0");
        let host = fake.0.parent().unwrap().join("desktop-app");
        assert_eq!(resolve_sidecar(Some(&host)), Some(fake.0.clone()));
        std::fs::remove_file(&fake.0).unwrap();
        std::os::unix::fs::symlink("/bin/echo", &fake.0).unwrap();
        assert!(resolve_sidecar(Some(&host)).is_none());
    }

    #[test]
    fn busy_gate_stays_closed_until_last_reader_releases_it() {
        let busy = Arc::new(AtomicBool::new(false));
        let lease = BusyLease::acquire(busy.clone()).unwrap();
        let reader = lease.clone();
        assert!(BusyLease::acquire(busy.clone()).is_err());
        drop(lease);
        assert!(busy.load(Ordering::Acquire));
        drop(reader);
        assert!(BusyLease::acquire(busy).is_ok());
    }

    #[cfg(unix)]
    struct FakeCli(PathBuf);

    // Avoid concurrent fork inheriting a sibling fixture's briefly writable
    // script descriptor (ETXTBSY) before exec closes its CLOEXEC descriptors.
    #[cfg(unix)]
    static FAKE_CLI_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[cfg(unix)]
    impl FakeCli {
        fn new(body: &str) -> Self {
            use std::os::unix::fs::PermissionsExt;
            use std::sync::atomic::AtomicUsize;
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let dir = std::env::temp_dir().join(format!(
                "tjuclaw-native-cli-test-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&dir).unwrap();
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
            let executable = dir.join("tjuclaw");
            std::fs::write(&executable, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
            Self(executable)
        }

        fn command(&self) -> Command {
            status_command(&self.0, &self.0.parent().unwrap().join("managed config"))
        }
    }

    #[cfg(unix)]
    impl Drop for FakeCli {
        fn drop(&mut self) {
            std::fs::remove_dir_all(self.0.parent().unwrap()).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn fake_cli_receives_only_fixed_status_args_no_credentials_or_stdin() {
        let _serial = FAKE_CLI_LOCK.lock().unwrap();
        let output = String::from_utf8(envelope()).unwrap();
        let fake = FakeCli::new(&format!(
            r#"
            [ "$#" -eq 4 ] || exit 2
            [ "$1" = "--config-dir" ] || exit 2
            [ "$2" = "$PWD/managed config" ] || exit 2
            [ "$3" = "workspace" ] && [ "$4" = "status" ] || exit 2
            [ -z "${{HOME}}${{OPENAI_API_KEY}}${{ANTHROPIC_API_KEY}}${{TJUCLAW_TOKEN}}" ] || exit 3
            if read -r input; then exit 4; fi
            printf '%s' '{output}'
            "#
        ));
        let lease = BusyLease::acquire(Arc::new(AtomicBool::new(false))).unwrap();
        let (success, bytes) = capture(&mut fake.command(), TIMEOUT, lease).unwrap();
        assert!(success);
        assert!(parse_status(success, &bytes).is_ok());
        // Status must not create even the managed config directory.
        assert!(!fake.0.parent().unwrap().join("managed config").exists());
    }

    #[cfg(unix)]
    #[test]
    fn fake_cli_timeout_kills_and_reaps_the_child() {
        let _serial = FAKE_CLI_LOCK.lock().unwrap();
        let fake = FakeCli::new("exec /bin/sleep 30");
        let busy = Arc::new(AtomicBool::new(false));
        let lease = BusyLease::acquire(busy.clone()).unwrap();
        let started = Instant::now();
        assert_eq!(
            capture(&mut fake.command(), Duration::from_millis(50), lease).unwrap_err(),
            "workspace_cli_timeout"
        );
        assert!(started.elapsed() < Duration::from_secs(2));
        // Pipe readers finish after the child is killed.
        let deadline = Instant::now() + Duration::from_secs(1);
        while busy.load(Ordering::Acquire) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!busy.load(Ordering::Acquire));
    }

    #[cfg(unix)]
    #[test]
    fn fake_cli_stdout_and_stderr_are_bounded_and_not_returned_on_error() {
        let _serial = FAKE_CLI_LOCK.lock().unwrap();
        for body in [
            "exec /usr/bin/head -c 70000 /dev/zero",
            "exec /usr/bin/head -c 9000 /dev/zero >&2",
        ] {
            let fake = FakeCli::new(body);
            let lease = BusyLease::acquire(Arc::new(AtomicBool::new(false))).unwrap();
            assert_eq!(
                capture(&mut fake.command(), TIMEOUT, lease).unwrap_err(),
                "workspace_cli_output_limit"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    #[ignore = "Requires TJUCLAW_TEST_BINARY pointing to a freshly built cmd/tjuclaw"]
    fn real_cli_init_and_status_interoperate_without_user_environment() {
        let _serial = FAKE_CLI_LOCK.lock().unwrap();
        // The fake fixture is used only for its isolated, owned temp directory.
        let fixture = FakeCli::new("exit 99");
        let native_dir = fixture.0.parent().unwrap();
        let root = native_dir.join("chosen directory");
        std::fs::create_dir(&root).unwrap();
        let root = selected_root(root).unwrap();
        let cli = WorkspaceCli {
            executable: Some(
                PathBuf::from(
                    std::env::var_os("TJUCLAW_TEST_BINARY").expect("TJUCLAW_TEST_BINARY"),
                )
                .canonicalize()
                .unwrap(),
            ),
            config_dir: Some(native_dir.join("managed config")),
            busy: Arc::new(AtomicBool::new(false)),
            connector: Arc::new(Connector::default()),
            keys: Arc::new(Mutex::new(BTreeMap::new())),
            runtime_path: trusted_runtime_path(),
        };
        // Missing status does not create or repair config.
        assert_eq!(
            cli.status().unwrap_err(),
            "workspace_cli_config_unavailable"
        );
        assert!(!cli.config_dir.as_ref().unwrap().exists());
        // Consent here is a test seam, NOT verification of a live native picker.
        let consent = confirm_selection(root.clone(), "测试环境 --flag".into(), true).unwrap();
        let config = cli
            .init(consent, BusyLease::acquire(cli.busy.clone()).unwrap())
            .unwrap();
        assert_eq!(config.root, root.to_str().unwrap());
        assert_eq!(config.name, "测试环境 --flag");
        assert!(config.allowed_capabilities.is_empty());
        assert!(cli
            .pending_approvals(BusyLease::acquire(cli.busy.clone()).unwrap())
            .unwrap()
            .is_empty());
        let public = serde_json::to_value(cli.status().unwrap()).unwrap();
        assert!(public.get("connection_token").is_none());
        assert_eq!(public["mcp_servers"], json!([]));
        let draft = json!({
            "endpoints":[
                {"name":"local","base_url":"http://127.0.0.1:9999/v1","model":"synthetic","api_key_env":"SYNTHETIC_LOCAL_REF"},
                {"name":"original","base_url":"https://original.example/v1","model":"original","api_key_env":"SYNTHETIC_ORIGINAL_REF"}
            ],
            "plugins":[],
            "mcp_servers":{"local":{"command":"synthetic-mcp","args":[],"env":{}}}
        });
        let config = cli
            .mutate(
                Mutation::Configure(serde_json::to_vec(&draft).unwrap()),
                BusyLease::acquire(cli.busy.clone()).unwrap(),
            )
            .unwrap();
        assert_eq!(config.endpoints.len(), 2);
        assert_eq!(config.mcp_servers, ["local"]);
        // Native-import seam, not a real picker click. No extension executes.
        let plugin = native_dir.join("native-imported-extension.ts");
        let replacement = native_dir.join("updated-extension.ts");
        let import =
            prepare_import(&serde_json::to_vec(&json!({"plugins": [plugin]})).unwrap()).unwrap();
        let config = cli
            .mutate(
                Mutation::Configure(import.input),
                BusyLease::acquire(cli.busy.clone()).unwrap(),
            )
            .unwrap();
        assert_eq!(config.plugins, ["native-imported-extension.ts"]);
        let endpoints_only: ConfigureDraft = serde_json::from_value(json!({
            "endpoints":[{"name":"local","base_url":"http://127.0.0.1:9999/v1","model":"changed"}]
        }))
        .unwrap();
        let deferred_input = configure_input(&endpoints_only).unwrap();
        let config = cli
            .mutate(
                Mutation::Merge(deferred_input.clone()),
                BusyLease::acquire(cli.busy.clone()).unwrap(),
            )
            .unwrap();
        assert_eq!(config.plugins, ["native-imported-extension.ts"]);
        assert_eq!(config.endpoints.len(), 2);
        assert_eq!(config.endpoints[0].key_env, "SYNTHETIC_LOCAL_REF");
        assert_eq!(config.endpoints[1].key_env, "SYNTHETIC_ORIGINAL_REF");
        // Another CLI update during a hypothetical consent dialog replaces
        // plugins. The deferred endpoint draft must preserve CURRENT refs,
        // not replay the old list or its redacted basenames.
        cli.mutate(
            Mutation::Configure(serde_json::to_vec(&json!({
                "plugins": [replacement],
                "endpoints":[
                    {"name":"local","base_url":"http://127.0.0.1:9999/v1","model":"synthetic","api_key_env":""},
                    {"name":"original","base_url":"https://original.example/v1","model":"original","api_key_env":"SYNTHETIC_ORIGINAL_REF"}
                ]
            })).unwrap()),
            BusyLease::acquire(cli.busy.clone()).unwrap(),
        )
        .unwrap();
        let config = cli
            .mutate(
                Mutation::Merge(deferred_input),
                BusyLease::acquire(cli.busy.clone()).unwrap(),
            )
            .unwrap();
        assert_eq!(config.plugins, ["updated-extension.ts"]);
        assert!(config.endpoints[0].key_env.is_empty()); // Revocation survives.
        assert_eq!(config.endpoints[1].key_env, "SYNTHETIC_ORIGINAL_REF");
        let raw: serde_json::Value = serde_json::from_slice(
            &std::fs::read(cli.config_dir.as_ref().unwrap().join("config.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(raw["plugins"], json!([replacement]));
        let config = cli
            .mutate(
                Mutation::Merge(
                    configure_input(&ConfigureDraft {
                        endpoints: endpoints_only.endpoints,
                        plugins: Some(vec![]),
                    })
                    .unwrap(),
                ),
                BusyLease::acquire(cli.busy.clone()).unwrap(),
            )
            .unwrap();
        assert_eq!(config.plugins, ["updated-extension.ts"]);
        assert_eq!(config.endpoints.len(), 2);
        let append: ConfigureDraft = serde_json::from_value(json!({
            "endpoints":[{"name":"local","base_url":"https://retarget.example/v1","model":"changed"}],
            "plugins":[replacement, plugin]
        })).unwrap();
        let config = cli
            .mutate(
                Mutation::Merge(configure_input(&append).unwrap()),
                BusyLease::acquire(cli.busy.clone()).unwrap(),
            )
            .unwrap();
        assert_eq!(config.endpoints.len(), 2);
        assert!(config.endpoints[0].key_env.is_empty());
        assert_eq!(config.endpoints[1].key_env, "SYNTHETIC_ORIGINAL_REF");
        assert_eq!(
            config.plugins,
            ["updated-extension.ts", "native-imported-extension.ts"]
        );
        let config = cli
            .mutate(
                Mutation::Merge(configure_input(&append).unwrap()),
                BusyLease::acquire(cli.busy.clone()).unwrap(),
            )
            .unwrap();
        assert_eq!(config.plugins.len(), 2); // Append is idempotent.
        let replace = prepare_import(br#"{"endpoints":[],"plugins":[],"mcp_servers":{}}"#).unwrap();
        let config = cli
            .mutate(
                Mutation::Configure(replace.input),
                BusyLease::acquire(cli.busy.clone()).unwrap(),
            )
            .unwrap();
        assert!(config.endpoints.is_empty());
        assert!(config.plugins.is_empty());
        assert!(config.mcp_servers.is_empty());
        let config = cli
            .mutate(
                Mutation::Allow(vec!["mcp.call".into()]),
                BusyLease::acquire(cli.busy.clone()).unwrap(),
            )
            .unwrap();
        assert_eq!(config.allowed_capabilities, ["mcp.call"]);
        cli.mutate(
            Mutation::Allow(vec![]),
            BusyLease::acquire(cli.busy.clone()).unwrap(),
        )
        .unwrap();
        // Deterministic real-binary regressions for backend base64url IDs:
        // each leading dash/underscore is one --id value, never a new flag.
        for prefix in ["-", "_"] {
            let id = format!("{prefix}{}", "A".repeat(42));
            let linked = cli
                .mutate(
                    Mutation::Link {
                        id: id.clone(),
                        token: "native-test-token-not-a-real-credential-0123456789".into(),
                    },
                    BusyLease::acquire(cli.busy.clone()).unwrap(),
                )
                .unwrap();
            assert_eq!(linked.id, id);
            assert!(linked.linked);
            let status = cli.status().unwrap();
            assert_eq!(status.id, id);
            assert!(status.linked);
            let unlinked = cli
                .mutate(
                    Mutation::Unlink,
                    BusyLease::acquire(cli.busy.clone()).unwrap(),
                )
                .unwrap();
            assert_eq!(unlinked.id, id);
            assert!(!unlinked.linked);
        }
        let config = cli
            .mutate(
                Mutation::Link {
                    id: config.id.clone(),
                    token: "native-test-token-not-a-real-credential-0123456789".into(),
                },
                BusyLease::acquire(cli.busy.clone()).unwrap(),
            )
            .unwrap();
        assert!(config.linked);
        let config = cli
            .mutate(
                Mutation::Unlink,
                BusyLease::acquire(cli.busy.clone()).unwrap(),
            )
            .unwrap();
        assert!(!config.linked);
        // The CLI must refuse a second init and preserve the existing identity.
        let original = std::fs::read(cli.config_dir.as_ref().unwrap().join("config.json")).unwrap();
        let consent = confirm_selection(root, "不同名称".into(), true).unwrap();
        assert_eq!(
            cli.init(consent, BusyLease::acquire(cli.busy.clone()).unwrap())
                .unwrap_err(),
            "workspace_cli_init_failed"
        );
        assert_eq!(
            std::fs::read(cli.config_dir.as_ref().unwrap().join("config.json")).unwrap(),
            original
        );
        assert_eq!(public["id"], config.id);
    }

    #[cfg(unix)]
    #[test]
    #[ignore = "Requires TJUCLAW_TEST_BINARY; exercises real CLI daemon against isolated local HTTP"]
    fn real_cli_connector_heartbeat_start_and_stop_interoperate() {
        use std::net::{TcpListener, TcpStream};
        let _serial = FAKE_CLI_LOCK.lock().unwrap();
        let fixture = FakeCli::new("exit 99");
        let root = fixture.0.parent().unwrap().join("root");
        std::fs::create_dir(&root).unwrap();
        let cli = WorkspaceCli {
            executable: Some(
                PathBuf::from(std::env::var_os("TJUCLAW_TEST_BINARY").expect("binary"))
                    .canonicalize()
                    .unwrap(),
            ),
            config_dir: Some(fixture.0.parent().unwrap().join("managed")),
            busy: Arc::new(AtomicBool::new(false)),
            connector: Arc::new(Connector::default()),
            keys: Arc::new(Mutex::new(BTreeMap::new())),
            runtime_path: trusted_runtime_path(),
        };
        let config = cli
            .init(
                confirm_selection(root, "synthetic environment".into(), true).unwrap(),
                BusyLease::acquire(cli.busy.clone()).unwrap(),
            )
            .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let finish = Arc::new(AtomicBool::new(false));
        let heartbeats = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let done = finish.clone();
        let count = heartbeats.clone();
        let server = std::thread::spawn(move || {
            while !done.load(Ordering::Acquire) {
                let Ok((mut socket, _)) = listener.accept() else {
                    std::thread::sleep(Duration::from_millis(5));
                    continue;
                };
                socket
                    .set_read_timeout(Some(Duration::from_secs(1)))
                    .unwrap();
                let mut buffer = [0; 8192];
                let n = socket.read(&mut buffer).unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..n]);
                if request.contains("/heartbeat ") {
                    count.fetch_add(1, Ordering::AcqRel);
                }
                let body = if request.contains("/poll ") {
                    r#"{"invocation":null}"#
                } else {
                    "{}"
                };
                let _ = write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            }
        });
        // Test-only local API seam: production Mutation::Link is pinned to the
        // product API and exposes no API/root/executable arguments through IPC.
        let (binary, dir) = cli.paths().unwrap();
        let mut command = config_command(binary, dir);
        command.args([
            "workspace",
            "link",
            "--api",
            &format!("http://{address}/api"),
            "--id",
            &config.id,
        ]);
        let (success, bytes) = capture_input(
            &mut command,
            TIMEOUT,
            BusyLease::acquire(cli.busy.clone()).unwrap(),
            Some(b"synthetic-local-token-0123456789abcdef".to_vec()),
        )
        .unwrap();
        assert!(parse_status(success, &bytes).unwrap().linked);
        cli.connector
            .start(cli.connector_command().unwrap())
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !cli.connector.status().unwrap().connected && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        let status = cli.connector.status().unwrap();
        let stopped = cli.connector.stop().unwrap();
        finish.store(true, Ordering::Release);
        let _ = TcpStream::connect(address);
        server.join().unwrap();
        assert!(status.connected, "{status:?}");
        assert_eq!(heartbeats.load(Ordering::Acquire), 1);
        assert!(!stopped.running && !stopped.connected);
    }

    #[cfg(unix)]
    #[test]
    #[ignore = "Requires TJUCLAW_TEST_BINARY; isolated synthetic local approval records, no model"]
    fn real_cli_local_approval_response_is_one_shot_and_private() {
        use std::os::unix::fs::PermissionsExt;
        let _serial = FAKE_CLI_LOCK.lock().unwrap();
        let fixture = FakeCli::new("exit 99");
        let root = fixture.0.parent().unwrap().join("root");
        std::fs::create_dir(&root).unwrap();
        let cli = WorkspaceCli {
            executable: Some(
                PathBuf::from(std::env::var_os("TJUCLAW_TEST_BINARY").expect("binary"))
                    .canonicalize()
                    .unwrap(),
            ),
            config_dir: Some(fixture.0.parent().unwrap().join("managed")),
            busy: Arc::new(AtomicBool::new(false)),
            connector: Arc::new(Connector::default()),
            keys: Arc::new(Mutex::new(BTreeMap::new())),
            runtime_path: trusted_runtime_path(),
        };
        let config = cli
            .init(
                confirm_selection(root.clone(), "synthetic environment".into(), true).unwrap(),
                BusyLease::acquire(cli.busy.clone()).unwrap(),
            )
            .unwrap();
        cli.mutate(
            Mutation::Allow(vec!["codex.prompt".into()]),
            BusyLease::acquire(cli.busy.clone()).unwrap(),
        )
        .unwrap();
        let dir = cli.config_dir.as_ref().unwrap();
        let session_id = "12345678-1234-4123-8123-123456789abc";
        let approval_id = "abcdefab-1234-4123-8123-123456789abc";
        for relative in [
            "runtime",
            "runtime/conversations",
            "runtime/conversations/codex",
            &format!("runtime/conversations/codex/{session_id}"),
            "runtime/approvals",
            &format!("runtime/approvals/{approval_id}"),
        ] {
            std::fs::create_dir_all(dir.join(relative)).unwrap();
            std::fs::set_permissions(dir.join(relative), std::fs::Permissions::from_mode(0o700))
                .unwrap();
        }
        let seconds = (std::time::SystemTime::now() + Duration::from_secs(25))
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as libc::time_t;
        let expires = unsafe {
            let mut tm: libc::tm = std::mem::zeroed();
            assert!(!libc::gmtime_r(&seconds, &mut tm).is_null());
            format!(
                "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
                tm.tm_year + 1900,
                tm.tm_mon + 1,
                tm.tm_mday,
                tm.tm_hour,
                tm.tm_min,
                tm.tm_sec
            )
        };
        let metadata = json!({
            "id":session_id,"runtime":"codex","endpoint":"","state":"ready","turns":0,
            "created_at":expires,"updated_at":expires,"workspace_id":config.id,
            "root":root,"binding":"synthetic-test"
        });
        let request = json!({
            "id":approval_id,"runtime":"codex","session_id":session_id,"kind":"command",
            "tool":"shell","input":{"command":"synthetic-only"},"expires_at":expires
        });
        for (relative, value) in [
            (
                format!("runtime/conversations/codex/{session_id}/metadata.json"),
                metadata,
            ),
            (
                format!("runtime/approvals/{approval_id}/request.json"),
                request,
            ),
        ] {
            std::fs::write(dir.join(&relative), serde_json::to_vec(&value).unwrap()).unwrap();
            std::fs::set_permissions(dir.join(relative), std::fs::Permissions::from_mode(0o600))
                .unwrap();
        }
        let pending = cli
            .pending_approvals(BusyLease::acquire(cli.busy.clone()).unwrap())
            .unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].summary.id, approval_id);
        // A test seam for an explicit local Deny. This does not verify a live
        // native dialog click or any real Codex/account/model execution.
        assert!(
            cli.respond_approval(
                approval_id,
                "deny",
                BusyLease::acquire(cli.busy.clone()).unwrap()
            )
            .unwrap()
            .responded
        );
        let path = dir.join(format!("runtime/approvals/{approval_id}/response.json"));
        let response: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            response,
            json!({"request_id":approval_id,"decision":"deny"})
        );
        assert_eq!(path.metadata().unwrap().permissions().mode() & 0o777, 0o600);
        assert!(cli
            .pending_approvals(BusyLease::acquire(cli.busy.clone()).unwrap())
            .unwrap()
            .is_empty());
        assert!(cli
            .respond_approval(
                approval_id,
                "allow",
                BusyLease::acquire(cli.busy.clone()).unwrap()
            )
            .is_err());
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&std::fs::read(path).unwrap()).unwrap(),
            response
        );
    }
}
