//! Terminals in the browser: each task can have a tmux session in its working directory.
//!
//! The sessions live on a tmux server of our own (`tmux -L ia-<host>`), so they keep running
//! when the browser disconnects or this server restarts. Each websocket runs
//! `tmux attach-session` in a pty and relays it:
//!
//! * server → client: binary frames with terminal output, and JSON text frames for control
//!   (`{"type":"ready"}`);
//! * client → server: binary frames with input, and JSON text frames
//!   `{"type":"resize","cols","rows"}` and `{"type":"ack","bytes"}`.
//!
//! The client acknowledges output once xterm has processed it, and we stop reading the pty
//! while too much is unacknowledged, so a flood of output can't pile up in the browser.
//!
//! Besides its shell, a task can have a session per *terminal tool*: a TUI program (lazygit,
//! an editor, a script…) configured in the host's settings, run in the same directory. Tool
//! sessions last as long as a board has them open: the board renews a lease on each while it
//! is open, and sessions that nobody is attached to and whose lease ran out are ended.

use std::collections::HashMap;
use std::process::Output;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use axum::extract::ws::{Message as WsMessage, WebSocket};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::process::Command;

use crate::db::{self, Task};
use crate::pty::Pty;
use crate::relay::close;
use crate::state::Shared;
use crate::util::{expand_tilde, path_str};

/// Output we send ahead of the client's acknowledgements.
const MAX_UNACKED: usize = 384 << 10;
const PING_EVERY: Duration = Duration::from_secs(15);
/// How long a tool session nobody is attached to outlives the board's last keepalive.
const TOOL_LEASE: Duration = Duration::from_secs(90);
const REAP_EVERY: Duration = Duration::from_secs(30);

/// A TUI program the board offers as a shortcut in each task's terminal (host setting
/// `terminal_tools`). `command` is run by the user's login shell in the task's directory.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Tool {
    pub id: String,
    pub name: String,
    pub command: String,
}

/// The host's terminal tools.
pub fn tools(c: &rusqlite::Connection) -> Vec<Tool> {
    db::get_setting(c, "terminal_tools").ok().flatten().and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default()
}

/// Check and normalise a new list of tools; tools without a usable id get one.
pub fn parse_tools(v: &Value) -> Result<Vec<Tool>, String> {
    let items = v.as_array().ok_or("terminal_tools must be a list")?;
    let mut out: Vec<Tool> = Vec::new();
    for item in items {
        let field = |k: &str| item.get(k).and_then(|v| v.as_str()).map(str::trim).unwrap_or("").to_string();
        let (name, command) = (field("name"), field("command"));
        if name.is_empty() || command.is_empty() {
            return Err("each terminal tool needs a name and a command".into());
        }
        let mut id = field("id");
        if !valid_tool_id(&id) || out.iter().any(|t| t.id == id) {
            id = crate::util::new_id()[..8].to_string();
        }
        out.push(Tool { id, name, command });
    }
    Ok(out)
}

/// Tool ids end up in tmux session names.
fn valid_tool_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 32 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Runs a tool in the user's login shell (so its PATH is the one their shells see). If it
/// fails, the message stays on screen until Enter instead of the session vanishing.
const TOOL_WRAPPER: &str = r#""${SHELL:-/bin/sh}" -lc "$IA_TOOL_COMMAND"; s=$?; [ "$s" -eq 0 ] || { printf '\n%s exited with status %d. Press Enter to close.' "$IA_TOOL_NAME" "$s"; read -r _; }"#;

/// Whether tmux is installed.
pub fn available() -> bool {
    static FOUND: OnceLock<bool> = OnceLock::new();
    *FOUND.get_or_init(|| {
        std::env::var_os("PATH").is_some_and(|paths| std::env::split_paths(&paths).any(|d| d.join("tmux").is_file()))
    })
}

/// Our own tmux server, one per data dir, so test servers don't share the live sessions.
fn socket(s: &Shared) -> String {
    format!("ia-{}", &s.host_id[..s.host_id.len().min(12)])
}

/// `ia-<task>` for the task's shell, `ia-<task>~<tool>` for a tool.
fn session_name(task_id: &str, tool: Option<&str>) -> String {
    match tool {
        Some(t) => format!("ia-{task_id}~{t}"),
        None => format!("ia-{task_id}"),
    }
}

/// `=name` matches the session exactly instead of by prefix.
fn target(task_id: &str, tool: Option<&str>) -> String {
    format!("={}", session_name(task_id, tool))
}

fn tmux_command(s: &Shared) -> Command {
    let mut cmd = Command::new("tmux");
    cmd.arg("-L").arg(socket(s));
    // Shells inherit the tmux server's environment: keep our secrets out of it, and let it
    // work when this server itself runs inside tmux.
    for var in ["TMUX", "TMUX_PANE", "IA_TOKEN", "IA_HUB_TOKEN", "IA_BROKER_TOKEN"] {
        cmd.env_remove(var);
    }
    cmd.env("TERM", "xterm-256color").env("COLORTERM", "truecolor").env("TERM_PROGRAM", "huntaway");
    cmd
}

async fn tmux(s: &Shared, args: &[&str]) -> Result<Output> {
    tmux_command(s).args(args).stdin(std::process::Stdio::null()).output().await.context("running tmux")
}

pub async fn session_exists(s: &Shared, task_id: &str, tool: Option<&str>) -> bool {
    available() && tmux(s, &["has-session", "-t", &target(task_id, tool)]).await.is_ok_and(|o| o.status.success())
}

/// Our sessions, with how many clients are attached to each.
async fn list_sessions(s: &Shared) -> Vec<(String, u32)> {
    let Ok(o) = tmux(s, &["list-sessions", "-F", "#{session_name} #{session_attached}"]).await else { return Vec::new() };
    String::from_utf8_lossy(&o.stdout)
        .lines()
        .filter_map(|l| l.rsplit_once(' ').map(|(name, n)| (name.to_string(), n.parse().unwrap_or(0))))
        .collect()
}

/// Where a task's terminal starts: its worktree once there is one, otherwise where its agent
/// would run.
pub fn working_dir(s: &Shared, task: &Task) -> Result<String> {
    // A scratch task's shell (or one that makes only documents) opens in its folder, where its agent works.
    if let Some(d) = crate::documents::work_dir(s, task) {
        return Ok(path_str(&d));
    }
    let c = s.db();
    let project = match &task.project_id {
        Some(pid) => db::get_project(&c, pid)?,
        None => None,
    };
    let dir = match (task.kind.as_str(), &project, &task.worktree_path) {
        (_, Some(_), Some(wt)) if expand_tilde(wt).is_dir() => wt.clone(),
        (_, Some(p), _) => p.repo_path.clone(),
        (_, None, _) => path_str(&s.profile_scratch_dir(&task.profile_id)),
    };
    Ok(path_str(&expand_tilde(&dir)))
}

async fn ensure_session(s: &Shared, task: &Task, tool: Option<&Tool>, cols: u16, rows: u16) -> Result<()> {
    let tool_id = tool.map(|t| t.id.as_str());
    if session_exists(s, &task.id, tool_id).await {
        return Ok(());
    }
    let cwd = working_dir(s, task)?;
    tokio::fs::create_dir_all(&cwd).await.ok();
    let config_dir = db::task_config_dir(&s.db(), task)?;
    let codex = db::task_is_codex(&s.db(), task)?;
    let (cols, rows) = (cols.to_string(), rows.to_string());
    let name = session_name(&task.id, tool_id);
    let mut env = Vec::new();
    // `claude` (or `codex`) in the terminal uses the task's config.
    if let Some(d) = config_dir {
        env.push(format!("{}={}", if codex { "CODEX_HOME" } else { "CLAUDE_CONFIG_DIR" }, path_str(&expand_tilde(&d))));
    }
    // The temp folder the task's agents use (see task_tmp.rs).
    if let Some(d) = crate::task_tmp::ensure(s, task) {
        env.push(format!("TMPDIR={}", path_str(&d)));
    }
    if let Some(t) = tool {
        env.push(format!("IA_TOOL_NAME={}", t.name));
        env.push(format!("IA_TOOL_COMMAND={}", t.command));
    }
    let mut args = vec!["new-session", "-d", "-s", &name, "-c", &cwd, "-x", &cols, "-y", &rows];
    for e in &env {
        args.extend(["-e", e]);
    }
    // More than one argument: tmux runs it directly rather than through its default shell,
    // which may not be a POSIX one.
    if tool.is_some() {
        args.extend(["--", "/bin/sh", "-c", TOOL_WRAPPER]);
        touch(&name);
    }
    let o = tmux(s, &args).await?;
    if !o.status.success() && !session_exists(s, &task.id, tool_id).await {
        bail!("tmux new-session failed: {}", String::from_utf8_lossy(&o.stderr).trim());
    }
    // The board already says which task this is. With the mouse on, the wheel scrolls
    // tmux's history instead of sending arrow keys, and selections reach the browser's
    // clipboard (OSC 52); Shift+drag still selects in xterm itself.
    let t = format!("{}:", target(&task.id, tool_id));
    tmux(s, &["set-option", "-t", &t, "status", "off", ";", "set-option", "-t", &t, "mouse", "on"]).await?;
    Ok(())
}

/// End a task's shell session (or one of its tool sessions), if it has one.
pub async fn kill(s: &Shared, task_id: &str, tool: Option<&str>) {
    if session_exists(s, task_id, tool).await {
        let _ = tmux(s, &["kill-session", "-t", &target(task_id, tool)]).await;
    }
    if tool.is_some() {
        leases().remove(&session_name(task_id, tool));
    }
}

/// End all of a task's sessions: its shell and its tools.
pub async fn kill_all(s: &Shared, task_id: &str) {
    if !available() {
        return;
    }
    let shell = session_name(task_id, None);
    let tools = format!("{shell}~");
    for (name, _) in list_sessions(s).await {
        if name == shell || name.starts_with(&tools) {
            let _ = tmux(s, &["kill-session", "-t", &format!("={name}")]).await;
            leases().remove(&name);
        }
    }
}

pub async fn status(s: &Shared, task: &Task, tool: Option<&Tool>) -> Value {
    if !available() {
        return json!({"available": false, "running": false, "reason": "tmux is not installed on this host"});
    }
    let running = session_exists(s, &task.id, tool.map(|t| t.id.as_str())).await;
    json!({"available": true, "running": running, "cwd": working_dir(s, task).ok(), "tool": tool})
}

/// When a board last said it still has each tool session open, by session name.
fn leases() -> std::sync::MutexGuard<'static, HashMap<String, Instant>> {
    static LEASES: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    LEASES.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

fn touch(name: &str) {
    leases().insert(name.to_string(), Instant::now());
}

/// A board still has this tool session open.
pub fn keepalive(task_id: &str, tool: &str) {
    touch(&session_name(task_id, Some(tool)));
}

/// End tool sessions that no board has kept open: nobody attached and the lease ran out.
pub fn start_reaper(s: &Shared) {
    if !available() {
        return;
    }
    let s = s.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(REAP_EVERY);
        loop {
            tick.tick().await;
            let sessions = list_sessions(&s).await;
            let mut expired = Vec::new();
            {
                let mut leases = leases();
                leases.retain(|name, _| sessions.iter().any(|(n, _)| n == name));
                for (name, attached) in sessions.iter().filter(|(n, _)| n.starts_with("ia-") && n.contains('~')) {
                    // Sessions from before a restart get a full lease to be claimed again.
                    let seen = leases.entry(name.clone()).or_insert_with(Instant::now);
                    if *attached > 0 {
                        *seen = Instant::now();
                    } else if seen.elapsed() > TOOL_LEASE {
                        expired.push(name.clone());
                    }
                }
            }
            for name in expired {
                tracing::info!("terminal: ending {name}, no board has it open");
                let _ = tmux(&s, &["kill-session", "-t", &format!("={name}")]).await;
                leases().remove(&name);
            }
        }
    });
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMsg {
    Resize { cols: u16, rows: u16 },
    Ack { bytes: usize },
}

/// Attach a websocket to the task's session (or a tool's), creating the session if needed.
pub async fn serve(s: Shared, task: Task, tool: Option<Tool>, cols: u16, rows: u16, mut ws: WebSocket) {
    let reason = match attach(&s, &task, tool.as_ref(), cols, rows, &mut ws).await {
        Ok(()) => return,
        Err(e) => format!("{e:#}"),
    };
    tracing::warn!(task = %task.id, "terminal: {reason}");
    close(&mut ws, Some((1011, reason.chars().take(120).collect()))).await;
}

async fn attach(s: &Shared, task: &Task, tool: Option<&Tool>, cols: u16, rows: u16, ws: &mut WebSocket) -> Result<()> {
    ensure_session(s, task, tool, cols, rows).await?;
    let tool_id = tool.map(|t| t.id.as_str());
    let t = target(&task.id, tool_id);
    let mut cmd = tmux_command(s);
    // Copying in tmux reaches the browser's clipboard (OSC 52). When the session ends, the
    // client should end with it rather than switch to another task's session.
    #[rustfmt::skip]
    cmd.args([
        "set-option", "-q", "-s", "set-clipboard", "external", ";",
        "set-option", "-t", &format!("{t}:"), "detach-on-destroy", "on", ";",
        "attach-session", "-t", &t,
    ]);
    let (pty, mut child) = Pty::spawn(cmd, cols, rows)?;
    let _ = ws.send(WsMessage::Text(json!({"type": "ready"}).to_string().into())).await;

    let mut buf = vec![0u8; 32 << 10];
    let mut unacked = 0usize;
    let mut ping = tokio::time::interval(PING_EVERY);
    ping.tick().await;
    loop {
        tokio::select! {
            n = pty.read(&mut buf), if unacked < MAX_UNACKED => {
                let n = n.context("reading terminal")?;
                if n == 0 {
                    break;
                }
                unacked += n;
                if ws.send(WsMessage::Binary(buf[..n].to_vec().into())).await.is_err() {
                    return Ok(());
                }
            }
            msg = ws.recv() => match msg {
                Some(Ok(WsMessage::Binary(data))) => pty.write_all(&data).await.context("writing to terminal")?,
                Some(Ok(WsMessage::Text(t))) => match serde_json::from_str::<ClientMsg>(&t) {
                    Ok(ClientMsg::Resize { cols, rows }) if cols > 1 && rows > 1 => { let _ = pty.resize(cols.min(1000), rows.min(1000)); }
                    Ok(ClientMsg::Ack { bytes }) => unacked = unacked.saturating_sub(bytes),
                    _ => {}
                },
                Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => return Ok(()),
                Some(Ok(_)) => {}
            },
            _ = ping.tick() => {
                if let Some(t) = tool_id {
                    keepalive(&task.id, t);
                }
                if ws.send(WsMessage::Ping(Vec::new().into())).await.is_err() {
                    return Ok(());
                }
            }
        }
    }
    // The shell or tool exited (or the session was killed): the attach client has gone too.
    let _ = child.wait().await;
    close(ws, Some((1000, "Session ended".into()))).await;
    Ok(())
}
