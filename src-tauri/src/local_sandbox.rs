//! The desktop app's own Agent sandbox. Agent turns run in containers on the
//! user's Docker engine: a gateway container starts one hardened session
//! container per conversation on an internal network with no internet route.
//! The product model and tools stay behind the TJUClaw API: the gateway uses
//! a runtime grant the signed-in user obtained from the API, and each turn is
//! opened and closed by the web client. This module only drives Docker and
//! the loopback gateway; it never sees the user's cookies.

use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

/// Images are pinned by digest; they are pulled on first use.
const GATEWAY_IMAGE: &str = env!("TJUCLAW_LOCAL_GATEWAY_IMAGE");
const CONTROLLER_IMAGE: &str = env!("TJUCLAW_LOCAL_CONTROLLER_IMAGE");
const GATEWAY_CONTAINER: &str = "tjuclaw-local-gateway";
const NETWORK: &str = "tjuclaw-sandbox";
const PORT: u16 = 18_280;
/// Only the production web app may configure the local Broker.
const API_ORIGINS: [&str; 1] = ["https://app.tjuclaw.cloud"];
/// The Broker calls the API host directly: the web origin's /api is an
/// edge function with a short time limit, too short for model streams.
const API_BASE: &str = "https://auth.tjuclaw.cloud/api";

#[derive(Default)]
pub struct LocalSandbox {
    secret: Mutex<Option<String>>,
}

#[derive(Serialize)]
pub struct Status {
    docker: bool,
    images: bool,
    running: bool,
}

fn docker(args: &[&str], env: &[(&str, &str)]) -> Result<String, String> {
    let mut command = Command::new("docker");
    command.args(args);
    for (key, value) in env {
        command.env(key, value);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let output = command.output().map_err(|_| "docker_unavailable".to_string())?;
    if !output.status.success() {
        return Err(format!("docker_{}_failed", args.first().unwrap_or(&"command")));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn random_hex(bytes: usize) -> Result<String, String> {
    let mut buffer = vec![0u8; bytes];
    getrandom::fill(&mut buffer).map_err(|_| "random_unavailable".to_string())?;
    Ok(buffer.iter().map(|b| format!("{b:02x}")).collect())
}

fn hex64(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn safe_name(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
}

fn gateway_url(path: &str) -> String {
    format!("http://127.0.0.1:{PORT}{path}")
}

fn ready() -> bool {
    ureq::get(&gateway_url("/readyz"))
        .config()
        .timeout_global(Some(Duration::from_secs(3)))
        .build()
        .call()
        .map(|response| response.status() == 200)
        .unwrap_or(false)
}

#[tauri::command]
pub async fn local_sandbox_status() -> Status {
    tauri::async_runtime::spawn_blocking(|| {
        let docker_ok = docker(&["version", "--format", "{{.Server.Version}}"], &[]).is_ok();
        let images = docker_ok
            && docker(&["image", "inspect", GATEWAY_IMAGE], &[]).is_ok()
            && docker(&["image", "inspect", CONTROLLER_IMAGE], &[]).is_ok();
        Status { docker: docker_ok, images, running: docker_ok && ready() }
    })
    .await
    .unwrap_or(Status { docker: false, images: false, running: false })
}

/// Pulls the pinned images; this can take minutes on the first run.
#[tauri::command]
pub async fn local_sandbox_prepare() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        for image in [GATEWAY_IMAGE, CONTROLLER_IMAGE] {
            if docker(&["image", "inspect", image], &[]).is_err() {
                docker(&["pull", image], &[])?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|_| "prepare_failed".to_string())?
}

/// (Re)starts the gateway with a fresh runtime grant from the API.
#[tauri::command]
pub async fn local_sandbox_start(
    state: tauri::State<'_, LocalSandbox>,
    api_origin: String,
    runtime_grant: String,
    model: String,
    models: Vec<String>,
) -> Result<(), String> {
    if !API_ORIGINS.contains(&api_origin.as_str()) || !hex64(&runtime_grant) || !safe_name(&model, 80)
        || models.len() > 16 || !models.iter().all(|name| safe_name(name, 80))
    {
        return Err("invalid_configuration".into());
    }
    let started = tauri::async_runtime::spawn_blocking(move || start_gateway(&api_origin, &runtime_grant, &model, &models))
        .await
        .map_err(|_| "start_failed".to_string())??;
    *state.secret.lock().map_err(|_| "state_unavailable")? = Some(started);
    Ok(())
}

/// Starts the gateway container and returns the HMAC secret for its tokens.
pub fn start_gateway(api_origin: &str, runtime_grant: &str, model: &str, models: &[String]) -> Result<String, String> {
    if !API_ORIGINS.contains(&api_origin) {
        return Err("invalid_configuration".into());
    }
    let secret = random_hex(32)?;
    let session_token = random_hex(32)?;
    {
        if docker(&["network", "inspect", NETWORK], &[]).is_err() {
            docker(&["network", "create", "--internal", NETWORK], &[])?;
        }
        let _ = docker(&["rm", "-f", GATEWAY_CONTAINER], &[]);
        let model_url = format!("{API_BASE}/sandbox/local/model");
        let tools_url = format!("{API_BASE}/agent/sandbox-tools");
        let publish = format!("127.0.0.1:{PORT}:18080");
        let broker = format!("http://{GATEWAY_CONTAINER}:18081");
        let image_env = format!("SANDBOX_IMAGE={CONTROLLER_IMAGE}");
        let broker_env = format!("SANDBOX_BROKER_URL={broker}");
        let model_env = format!("NEWAPI_MODEL={model}");
        let models_env = format!("NEWAPI_MODELS={}", models.join(","));
        let base_env = format!("NEWAPI_BASE_URL={model_url}");
        let tools_env = format!("SANDBOX_TOOL_API_URL={tools_url}");
        docker(
            &[
                "run", "--detach", "--name", GATEWAY_CONTAINER, "--restart", "unless-stopped",
                "--publish", &publish,
                "--volume", "/var/run/docker.sock:/var/run/docker.sock",
                "--volume", "tjuclaw-local-gateway:/var/lib/tjuclaw-sandbox",
                "--label", "app.kubernetes.io/part-of=tjuclaw",
                // Secrets come from this process's environment, never argv.
                "--env", "SANDBOX_SESSION_TOKEN", "--env", "SANDBOX_GATEWAY_HMAC_SECRET", "--env", "NEWAPI_API_KEY",
                "--env", &image_env, "--env", &broker_env, "--env", &model_env, "--env", &models_env,
                "--env", &base_env, "--env", &tools_env, "--env", "BROKER_QUOTA_LIMIT=10000",
                GATEWAY_IMAGE,
            ],
            &[
                ("SANDBOX_SESSION_TOKEN", &session_token),
                ("SANDBOX_GATEWAY_HMAC_SECRET", &secret),
                ("NEWAPI_API_KEY", runtime_grant),
            ],
        )?;
        docker(&["network", "connect", NETWORK, GATEWAY_CONTAINER], &[])?;
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            if ready() {
                return Ok(secret);
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        Err("gateway_not_ready".into())
    }
}

#[tauri::command]
pub async fn local_sandbox_stop(state: tauri::State<'_, LocalSandbox>) -> Result<(), String> {
    *state.secret.lock().map_err(|_| "state_unavailable")? = None;
    tauri::async_runtime::spawn_blocking(|| docker(&["rm", "-f", GATEWAY_CONTAINER], &[]).map(|_| ()))
        .await
        .map_err(|_| "stop_failed".to_string())?
}

#[derive(Deserialize)]
#[cfg_attr(test, derive(Clone))]
pub struct Turn {
    owner_id: String,
    session_id: String,
    entry_id: String,
    profile: String,
    turn: u32,
    content: String,
    tool_grant: String,
    model: String,
}

#[derive(Serialize)]
struct AccessClaims<'a> {
    owner_id: &'a str,
    session_id: &'a str,
    entry_id: &'a str,
    profile: &'a str,
    iat: u64,
    exp: u64,
}

/// The gateway's v1 access token: base64url JSON claims signed with HMAC-SHA256.
fn access_token(secret: &str, turn: &Turn) -> Result<String, String> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| "clock")?.as_secs();
    let claims = AccessClaims {
        owner_id: &turn.owner_id, session_id: &turn.session_id, entry_id: &turn.entry_id,
        profile: &turn.profile, iat: now, exp: now + 600,
    };
    let payload = serde_json::to_vec(&claims).map_err(|_| "claims")?;
    let unsigned = format!("v1.{}", URL_SAFE_NO_PAD.encode(payload));
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|_| "secret")?;
    mac.update(unsigned.as_bytes());
    Ok(format!("{unsigned}.{}", URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())))
}

/// Runs one turn in the local sandbox and returns the Agent's reply.
#[tauri::command]
pub async fn local_sandbox_turn(state: tauri::State<'_, LocalSandbox>, turn: Turn) -> Result<LocalReply, String> {
    if !safe_name(&turn.owner_id, 128) || turn.session_id.len() != 32 || turn.entry_id.len() != 32
        || !safe_name(&turn.profile, 79) || !hex64(&turn.tool_grant) || !safe_name(&turn.model, 80)
        || turn.turn == 0 || turn.content.trim().is_empty() || turn.content.len() > 16 << 10
    {
        return Err("invalid_turn".into());
    }
    let secret = state.secret.lock().map_err(|_| "state_unavailable")?.clone().ok_or("sandbox_not_started")?;
    tauri::async_runtime::spawn_blocking(move || run_turn(&secret, &turn))
        .await
        .map_err(|_| "turn_failed".to_string())?
}

/// The Agent's reply and the thinking and tool steps behind it.
#[derive(Serialize)]
pub struct LocalReply {
    content: String,
    steps: serde_json::Value,
}

/// Sends one turn to the running gateway and returns the Agent's reply.
pub fn run_turn(secret: &str, turn: &Turn) -> Result<LocalReply, String> {
    {
        let token = access_token(secret, turn)?;
        let identity = serde_json::json!({
            "version": "session.v1", "owner_id": turn.owner_id, "session_id": turn.session_id,
            "entry_id": turn.entry_id, "profile": turn.profile,
        });
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(200)))
            .http_status_as_error(false)
            .build()
            .new_agent();
        let ensured = agent
            .post(&gateway_url("/v1/sessions/ensure"))
            .header("Authorization", &format!("Bearer {token}"))
            // The gateway accepts exactly application/json (no charset).
            .header("Content-Type", "application/json")
            .send(serde_json::to_vec(&identity).map_err(|_| "invalid_turn")?)
            .map_err(|error| format!("sandbox_unavailable: ensure: {error}"))?;
        if ensured.status() != 200 {
            return Err(format!("sandbox_unavailable: ensure HTTP {}", ensured.status().as_u16()));
        }
        let mut message = identity.clone();
        message["turn"] = turn.turn.into();
        message["content"] = turn.content.clone().into();
        let mut reply = agent
            .post(&gateway_url("/v1/sessions/message"))
            .header("Authorization", &format!("Bearer {token}"))
            .header("X-TJUClaw-Tool-Grant", &turn.tool_grant)
            .header("X-TJUClaw-Model", &turn.model)
            .header("Content-Type", "application/json")
            .send(serde_json::to_vec(&message).map_err(|_| "invalid_turn")?)
            .map_err(|error| format!("sandbox_unavailable: message: {error}"))?;
        if reply.status() != 200 {
            return Err(format!("sandbox_unavailable: message HTTP {}", reply.status().as_u16()));
        }
        #[derive(Deserialize)]
        struct Reply {
            turn: u32,
            content: String,
            #[serde(default)]
            steps: serde_json::Value,
        }
        let body: Reply = reply.body_mut().read_json().map_err(|_| "invalid_reply")?;
        if body.turn != turn.turn || body.content.trim().is_empty() {
            return Err("invalid_reply".into());
        }
        let steps = if body.steps.is_array() { body.steps } else { serde_json::Value::Array(vec![]) };
        Ok(LocalReply { content: body.content, steps })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn access_token_matches_the_gateway_format() {
        let turn = Turn {
            owner_id: "owner-a".into(), session_id: "0".repeat(32), entry_id: "1".repeat(32),
            profile: "study-agent".into(), turn: 1, content: "hi".into(), tool_grant: "a".repeat(64), model: "m".into(),
        };
        let token = access_token(&"s".repeat(64), &turn).unwrap();
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0], "v1");
        let claims: serde_json::Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(claims["owner_id"], "owner-a");
        assert_eq!(claims["exp"].as_u64().unwrap() - claims["iat"].as_u64().unwrap(), 600);
        let mut mac = Hmac::<Sha256>::new_from_slice("s".repeat(64).as_bytes()).unwrap();
        mac.update(format!("v1.{}", parts[1]).as_bytes());
        assert_eq!(URL_SAFE_NO_PAD.decode(parts[2]).unwrap(), mac.finalize().into_bytes().to_vec());
    }

    #[test]
    fn rejects_unexpected_api_origins_and_names() {
        assert!(!API_ORIGINS.contains(&"http://evil.example"));
        assert!(safe_name("deepseek-flash", 80));
        assert!(!safe_name("a b", 80));
        assert!(hex64(&"f".repeat(64)));
        assert!(!hex64(&"F".repeat(64)));
    }
}

/// A real turn against the production API: run with LOCAL_SANDBOX_E2E set to
/// a JSON file holding a runtime grant and an opened turn (see the desktop
/// sandbox verification script); prints the reply for the caller to finish.
#[cfg(test)]
mod live {
    use super::*;

    #[test]
    #[ignore]
    fn live_turn_through_the_local_gateway() {
        let path = std::env::var("LOCAL_SANDBOX_E2E").expect("LOCAL_SANDBOX_E2E");
        let input: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let models: Vec<String> = serde_json::from_value(input["models"].clone()).unwrap();
        let secret = start_gateway("https://app.tjuclaw.cloud", input["grant"].as_str().unwrap(), input["model"].as_str().unwrap(), &models)
            .expect("gateway starts");
        let turn: Turn = serde_json::from_value(input["turn"].clone()).unwrap();
        let reply = run_turn(&secret, &turn).unwrap_or_else(|error| panic!("turn failed: {error}"));
        println!("LOCAL_REPLY={}", serde_json::to_string(&reply.content).unwrap());
        println!("LOCAL_STEPS={}", serde_json::to_string(&reply.steps).unwrap());
    }
}
