use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{DefaultBodyLimit, Request, State},
    http::{header::AUTHORIZATION, HeaderMap, StatusCode},
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

pub const BRIDGE_APP: &str = "subway-wrapper";
const MAX_BODY: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentPhase {
    Working,
    Waiting,
    Offline,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentReason {
    Execution,
    Idle,
    Permission,
    BackgroundShell,
    Background,
    Startup,
    PluginUnload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionCounts {
    pub busy: u32,
    pub pending_permissions: u32,
    #[serde(default)]
    pub background: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShellCounts {
    pub running: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentState {
    pub v: u8,
    pub phase: AgentPhase,
    pub reason: AgentReason,
    pub location: String,
    pub sessions: SessionCounts,
    pub shells: ShellCounts,
    pub sent_at: i64,
}

impl AgentState {
    fn validate(&self) -> Result<(), &'static str> {
        if self.v != 1 {
            return Err("unsupported protocol version");
        }
        if self.location.len() > 4096 {
            return Err("location too long");
        }
        if self.sessions.busy > 10_000
            || self.sessions.pending_permissions > 10_000
            || self.sessions.background > 10_000
            || self.shells.running > 10_000
        {
            return Err("count out of range");
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct ApiState {
    app: AppHandle,
    token: Arc<String>,
    last: Arc<Mutex<Option<AgentState>>>,
    port: u16,
}

impl ApiState {
    pub fn latest(&self) -> Option<AgentState> {
        self.last.lock().ok().and_then(|guard| guard.clone())
    }
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    ok: bool,
    app: &'static str,
    version: String,
    pid: u32,
    port: u16,
}

#[derive(Debug, Serialize)]
struct StateResponse {
    ok: bool,
    accepted: bool,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    ok: bool,
    error: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscoveryFile {
    schema: u8,
    app: &'static str,
    version: String,
    pid: u32,
    port: u16,
    token: String,
    started_at: i64,
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

pub fn bridge_path() -> PathBuf {
    if let Some(path) = std::env::var_os("SUBWAY_BRIDGE_FILE") {
        return PathBuf::from(path);
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".subway-autopause")
        .join("bridge.json")
}

fn write_discovery(port: u16, token: &str) -> std::io::Result<PathBuf> {
    let path = bridge_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let payload = DiscoveryFile {
        schema: 1,
        app: BRIDGE_APP,
        version: version(),
        pid: std::process::id(),
        port,
        token: token.to_string(),
        started_at: now_millis(),
    };
    let json = serde_json::to_vec_pretty(&payload).map_err(std::io::Error::other)?;
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(&temp, json)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&temp, fs::Permissions::from_mode(0o600));
    }

    fs::rename(&temp, &path)?;
    Ok(path)
}

/// Removes the discovery file only when it still belongs to this process.
pub fn cleanup() {
    let path = bridge_path();
    let Ok(raw) = fs::read_to_string(&path) else {
        return;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        let _ = fs::remove_file(&path);
        return;
    };
    if value.get("pid").and_then(|pid| pid.as_u64()) == Some(u64::from(std::process::id())) {
        let _ = fs::remove_file(&path);
    }
}

pub fn push_state_to_window(window: &WebviewWindow, payload: &AgentState) {
    if let Ok(json) = serde_json::to_string(payload) {
        let script = format!("window.__SUBWAY_WRAPPER__?.onAgentState({json});");
        if let Err(error) = window.eval(&script) {
            eprintln!("[subway-bridge] could not eval state: {error}");
        }
    }
}

pub fn start(app: AppHandle) -> Result<ApiState, Box<dyn std::error::Error>> {
    let mut token_bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut token_bytes);
    let token = token_bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();

    let std_listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    std_listener.set_nonblocking(true)?;
    let port = std_listener.local_addr()?.port();

    write_discovery(port, &token)?;

    let state = ApiState {
        app: app.clone(),
        token: Arc::new(token),
        last: Arc::new(Mutex::new(None)),
        port,
    };

    let router = Router::new()
        .route("/v1/health", get(health))
        .route("/v1/state", post(accept_state))
        .route("/v1/quit", post(quit_app))
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .layer(middleware::from_fn_with_state(state.clone(), auth))
        .with_state(state.clone());

    let app_for_server = app.clone();
    std::thread::Builder::new()
        .name("subway-bridge".into())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    eprintln!("[subway-bridge] could not start tokio: {error}");
                    return;
                }
            };
            runtime.block_on(async move {
                let listener = match tokio::net::TcpListener::from_std(std_listener) {
                    Ok(listener) => listener,
                    Err(error) => {
                        eprintln!("[subway-bridge] listener conversion failed: {error}");
                        return;
                    }
                };
                if let Err(error) = axum::serve(listener, router).await {
                    eprintln!("[subway-bridge] server stopped: {error}");
                    let _ = app_for_server
                        .emit("agent-state", &serde_json::json!({ "phase": "offline" }));
                }
            });
        })?;

    println!(
        "[subway-bridge] listening on http://127.0.0.1:{port}, discovery {}",
        bridge_path().display()
    );
    Ok(state)
}

async fn auth(
    State(state): State<ApiState>,
    headers: HeaderMap,
    request: Request,
    next: Next,
) -> Result<Response, (StatusCode, Json<ErrorResponse>)> {
    let expected = format!("Bearer {}", state.token);
    let provided = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();

    if !constant_time_eq(provided.as_bytes(), expected.as_bytes()) {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                ok: false,
                error: "unauthorized".into(),
            }),
        ));
    }
    Ok(next.run(request).await)
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0u8;
    for (l, r) in left.iter().zip(right.iter()) {
        difference |= l ^ r;
    }
    difference == 0
}

async fn health(State(state): State<ApiState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        ok: true,
        app: BRIDGE_APP,
        version: version(),
        pid: std::process::id(),
        port: state.port,
    })
}

async fn quit_app(State(state): State<ApiState>) -> Json<StateResponse> {
    let app = state.app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(50));
        app.exit(0);
    });
    Json(StateResponse {
        ok: true,
        accepted: true,
    })
}

async fn accept_state(
    State(state): State<ApiState>,
    Json(payload): Json<AgentState>,
) -> Result<Json<StateResponse>, (StatusCode, Json<ErrorResponse>)> {
    if let Err(error) = payload.validate() {
        return Err((
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(ErrorResponse {
                ok: false,
                error: error.to_string(),
            }),
        ));
    }

    let mut guard = state.last.lock().map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                ok: false,
                error: "state lock poisoned".into(),
            }),
        )
    })?;
    *guard = Some(payload.clone());
    drop(guard);

    if let Some(window) = state.app.get_webview_window("main") {
        push_state_to_window(&window, &payload);
    }

    if let Err(error) = state.app.emit("agent-state", &payload) {
        eprintln!("[subway-bridge] could not emit agent-state: {error}");
    }

    Ok(Json(StateResponse {
        ok: true,
        accepted: true,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_time_comparison_works() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
    }

    #[test]
    fn validates_counts() {
        let state = AgentState {
            v: 1,
            phase: AgentPhase::Working,
            reason: AgentReason::Execution,
            location: "/tmp".into(),
            sessions: SessionCounts {
                busy: 1,
                pending_permissions: 0,
                background: 0,
            },
            shells: ShellCounts { running: 0 },
            sent_at: 0,
        };
        assert!(state.validate().is_ok());
    }

    #[test]
    fn rejects_invalid_version() {
        let state = AgentState {
            v: 2,
            phase: AgentPhase::Working,
            reason: AgentReason::Execution,
            location: "/tmp".into(),
            sessions: SessionCounts {
                busy: 0,
                pending_permissions: 0,
                background: 0,
            },
            shells: ShellCounts { running: 0 },
            sent_at: 0,
        };
        assert!(state.validate().is_err());
    }
}
