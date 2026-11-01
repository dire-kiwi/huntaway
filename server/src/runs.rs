//! Agent processes on this machine. Each run is launched under `ia-shim`, which detaches it
//! from this server and records everything in `<data>/runs/<run_id>/`:
//! `prompt`, `out.jsonl` (stream-json output), `err.log`, `pid`, `shim.pid` and, when it
//! finishes, `exit`. The server only follows those files, so it can restart freely and pick
//! up where it left off.
//!
//! From format 2, a run that takes input while it goes (stream-json input, see
//! runner::steer) also has `input.jsonl`: the shim feeds the agent `prompt`, then each line
//! the server appends there, and ends its input once the server writes `input.closed`. A
//! run with stream-json input only exits once its input is closed, so a server that doesn't
//! know to close it must not follow it.
//!
//! Those files are a stable format: shims and agents started by an older build keep running
//! after an upgrade, so a newer server must still read them. Changes must be additive; a
//! change that older readers can't handle needs a new `RUN_FORMAT`, and readers must keep
//! supporting the old one. `run.json` records the format (runs without it are format 1).

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use tokio::process::Command;

use crate::runner;
use crate::state::Shared;
use crate::util::{expand_tilde, path_str};

/// On-disk format of a run directory written by this build.
pub const RUN_FORMAT: u32 = 2;

pub struct Launch {
    pub run_id: String,
    pub cwd: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// CLAUDE_CONFIG_DIR (CODEX_HOME for Codex), may start with `~`.
    pub config_dir: Option<String>,
    pub prompt: String,
    /// The agent reads more input after `prompt` (see `write_input`), until `close_input`.
    pub input: bool,
    /// A review thread's run: its MCP helper also offers `submit_review`.
    pub review: bool,
    /// The project's own MCP servers (see agent_tools.rs).
    pub mcp_servers: serde_json::Map<String, Value>,
    /// The GitHub account the gh server acts as (see gh_mcp::Account), if not gh's active one.
    pub github_account: Option<String>,
    /// Run Codex instead of Claude Code: `args` are ignored, and the adapter gets this as
    /// `codex.json` (see codex.rs).
    pub codex: Option<crate::codex::Spec>,
}

pub fn run_dir(state: &Shared, run_id: &str) -> PathBuf {
    state.data_dir.join("runs").join(run_id)
}

fn shim_path(state: &Shared) -> PathBuf {
    state.exe.with_file_name("ia-shim")
}

/// Start the agent (claude, or the Codex adapter) under ia-shim. Returns once its process exists.
pub async fn start(state: &Shared, l: Launch) -> Result<()> {
    let dir = run_dir(state, &l.run_id);
    if dir.join("pid").exists() || dir.join("exit").exists() {
        bail!("run {} was already started", l.run_id);
    }
    let shim = shim_path(state);
    if !shim.exists() {
        bail!("ia-shim not found next to {} (build the workspace with `cargo build --release`)", state.exe.display());
    }
    tokio::fs::create_dir_all(&dir).await?;
    tokio::fs::write(dir.join("run.json"), json!({"format": RUN_FORMAT, "version": env!("CARGO_PKG_VERSION")}).to_string()).await?;
    tokio::fs::write(dir.join("prompt"), &l.prompt).await?;
    if l.input {
        tokio::fs::write(dir.join("input.jsonl"), "").await?;
    }

    // The agent's MCP helper calls back into this server; IA_URL stays valid across restarts.
    let mut mcp = json!({
        "mcpServers": {
            runner::MCP_SERVER_NAME: {
                "type": "stdio",
                "command": path_str(&state.exe),
                "args": ["mcp"],
                "env": {
                    "IA_URL": state.internal_url,
                    "IA_TOKEN": state.token,
                    "IA_RUN_ID": l.run_id,
                }
            },
            // GitHub through gh, outside the agent's sandbox. A server of the project's own by
            // this name replaces it.
            crate::gh_mcp::SERVER_NAME: {
                "type": "stdio",
                "command": path_str(&state.exe),
                "args": ["gh-mcp"],
                "env": {"IA_CWD": l.cwd, "IA_URL": state.internal_url, "IA_TOKEN": state.token, "IA_RUN_ID": l.run_id}
            }
        }
    });
    if l.review {
        mcp["mcpServers"][runner::MCP_SERVER_NAME]["env"]["IA_REVIEW"] = json!("1");
    }
    if let Some(a) = &l.github_account {
        mcp["mcpServers"][crate::gh_mcp::SERVER_NAME]["env"][crate::gh_mcp::ACCOUNT_ENV] = json!(a);
    }
    for (name, server) in &l.mcp_servers {
        if name != runner::MCP_SERVER_NAME {
            mcp["mcpServers"][name] = server.clone();
        }
    }
    let mcp_path = dir.join("mcp.json");
    tokio::fs::write(&mcp_path, serde_json::to_vec_pretty(&mcp)?).await?;
    let (program, args) = match &l.codex {
        Some(spec) => {
            let spec_path = dir.join("codex.json");
            tokio::fs::write(&spec_path, serde_json::to_vec_pretty(spec)?).await?;
            (path_str(&state.exe), vec!["codex-run".to_string(), path_str(&spec_path)])
        }
        None => {
            let mut args = l.args.clone();
            args.extend(["--mcp-config".into(), path_str(&mcp_path)]);
            (claude_program(), args)
        }
    };
    tokio::fs::write(
        dir.join("spec.json"),
        serde_json::to_vec_pretty(&json!({"cwd": l.cwd, "args": args, "config_dir": l.config_dir}))?,
    )
    .await?;

    let cwd = expand_tilde(&l.cwd);
    if !cwd.is_dir() {
        bail!("working directory {} does not exist", cwd.display());
    }
    let mut cmd = Command::new(&shim);
    cmd.arg(&dir).arg("--").arg(&program).args(&args).current_dir(&cwd).envs(l.env.clone());
    if let Some(cd) = l.config_dir.as_deref().filter(|c| !c.trim().is_empty()) {
        cmd.env(if l.codex.is_some() { "CODEX_HOME" } else { "CLAUDE_CONFIG_DIR" }, expand_tilde(cd));
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    // The shim forks; the process we spawned exits right away.
    let status = cmd.status().await.context("failed to launch ia-shim")?;
    if !status.success() {
        bail!("ia-shim exited with {status}");
    }
    for _ in 0..100 {
        if dir.join("pid").exists() {
            return Ok(());
        }
        if let Some(exit) = read_exit(&dir) {
            bail!("{}", exit["error"].as_str().unwrap_or("the run exited immediately"));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    bail!("the run did not start within 5s")
}

/// Whether the run's agent is still reading input (see `write_input`).
pub fn accepts_input(state: &Shared, run_id: &str) -> bool {
    let dir = run_dir(state, run_id);
    dir.join("input.jsonl").exists() && !dir.join("input.closed").exists() && !dir.join("exit").exists()
}

/// Send the agent a line of input (a stream-json message). Returns false if it no longer
/// takes any.
pub fn write_input(state: &Shared, run_id: &str, line: &str) -> Result<bool> {
    use std::io::Write;
    if !accepts_input(state, run_id) {
        return Ok(false);
    }
    let mut f = std::fs::OpenOptions::new().append(true).open(run_dir(state, run_id).join("input.jsonl"))?;
    // One write, so the shim never relays half a line followed by someone else's.
    f.write_all(format!("{}\n", line.trim_end()).as_bytes())?;
    Ok(true)
}

/// End the agent's input: it exits once it has dealt with what it was sent.
pub fn close_input(state: &Shared, run_id: &str) {
    let dir = run_dir(state, run_id);
    if dir.join("input.jsonl").exists() && !dir.join("input.closed").exists() {
        if let Err(e) = std::fs::write(dir.join("input.closed"), "") {
            tracing::error!(run = run_id, "closing the agent's input: {e}");
        }
    }
}

/// Signal the agent's process group; escalate if it hasn't exited after 10s.
pub fn kill(state: &Shared, run_id: &str) -> bool {
    let dir = run_dir(state, run_id);
    if dir.join("exit").exists() {
        return false;
    }
    let Some(pid) = read_pid(&dir, "pid") else { return false };
    unsafe { libc::kill(-pid, libc::SIGTERM) };
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(10)).await;
        if !dir.join("exit").exists() {
            unsafe { libc::kill(-pid, libc::SIGKILL) };
        }
    });
    true
}

/// How long `reap` waits for ia-shim to start an agent it may still start.
const REAP_WAIT: Duration = Duration::from_secs(if cfg!(test) { 5 } else { 60 });

/// How long an agent `reap` stops has to exit before it's killed.
const REAP_GRACE: Duration = Duration::from_secs(if cfg!(test) { 1 } else { 10 });

/// Make sure nothing goes on of a run whose launch failed or was stopped: its input is closed
/// and its agent stopped, including one ia-shim starts only after this (if it's slow, or the
/// launch gave up waiting for it, or was stopped while it waited).
pub fn reap(state: &Shared, run_id: &str) {
    close_input(state, run_id);
    let dir = run_dir(state, run_id);
    // The shim is started once spec.json is written.
    if !dir.join("spec.json").exists() || dir.join("exit").exists() {
        return;
    }
    // Kept until the agent has exited or can't start any more, so a restart carries on (see `resume_reaping`).
    if let Err(e) = std::fs::write(dir.join("reap"), "") {
        tracing::error!(run = run_id, "marking a run to stop: {e}");
    }
    watch_to_reap(state, run_id);
}

/// Carry on stopping the agents of failed launches that a restart interrupted (see `reap`).
pub fn resume_reaping(state: &Shared) {
    let Ok(dirs) = std::fs::read_dir(state.data_dir.join("runs")) else { return };
    for dir in dirs.flatten().filter(|d| d.path().join("reap").exists()) {
        if let Some(run_id) = dir.file_name().to_str() {
            close_input(state, run_id);
            watch_to_reap(state, run_id);
        }
    }
}

/// Stop the run's agent once ia-shim has started it (killing it if it doesn't exit in time), or
/// give up once the shim has had time to start it.
fn watch_to_reap(state: &Shared, run_id: &str) {
    let (state, run_id, dir) = (state.clone(), run_id.to_string(), run_dir(state, run_id));
    tokio::spawn(async move {
        let since = std::time::Instant::now();
        let mut stopping: Option<std::time::Instant> = None;
        while !dir.join("exit").exists() {
            match read_pid(&dir, "pid") {
                None if since.elapsed() >= REAP_WAIT => break,
                None => {}
                // (One gone without its exit recorded went with a reboot, say.)
                Some(pid) if !alive(pid) => break,
                Some(pid) => match stopping {
                    None => {
                        tracing::warn!(run = %run_id, "stopping an agent that started after its launch was given up on");
                        close_input(&state, &run_id);
                        unsafe { libc::kill(-pid, libc::SIGTERM) };
                        stopping = Some(std::time::Instant::now());
                    }
                    Some(at) if at.elapsed() >= REAP_GRACE => {
                        unsafe { libc::kill(-pid, libc::SIGKILL) };
                    }
                    Some(_) => {}
                },
            }
            tokio::time::sleep(Duration::from_millis(if stopping.is_some() { 100 } else { 20 })).await;
        }
        let _ = std::fs::remove_file(dir.join("reap"));
    });
}

/// Format of an existing run directory.
pub fn format(state: &Shared, run_id: &str) -> u32 {
    std::fs::read_to_string(run_dir(state, run_id).join("run.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v["format"].as_u64())
        .map(|f| f as u32)
        .unwrap_or(1)
}

/// The arguments a run's agent was started with (`spec.json`), none if it wasn't.
pub fn launch_args(state: &Shared, run_id: &str) -> Vec<String> {
    std::fs::read_to_string(run_dir(state, run_id).join("spec.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|mut v| serde_json::from_value(v["args"].take()).ok())
        .unwrap_or_default()
}

/// A Codex run's `codex.json`, as it was launched.
pub fn codex_spec(state: &Shared, run_id: &str) -> Option<crate::codex::Spec> {
    serde_json::from_str(&std::fs::read_to_string(run_dir(state, run_id).join("codex.json")).ok()?).ok()
}

pub fn claude_program() -> String {
    std::env::var("IA_CLAUDE_BIN").unwrap_or_else(|_| "claude".into())
}

fn on_path(name: &str) -> bool {
    Path::new(name).is_absolute() && Path::new(name).exists()
        || std::env::var_os("PATH").is_some_and(|p| std::env::split_paths(&p).any(|d| d.join(name).is_file()))
}

#[cfg(test)]
thread_local! {
    /// Lets a test act as a host that runs agents, without starting any.
    pub static TEST_CAN_RUN: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Whether this host can run agents: it has ia-shim and a claude or codex CLI.
pub fn can_run_agents(state: &Shared) -> bool {
    #[cfg(test)]
    if TEST_CAN_RUN.get() {
        return true;
    }
    shim_path(state).exists() && (on_path(&claude_program()) || on_path(&crate::codex::program()))
}

/// Whether this host has the CLI for `agent` (one of db::AGENTS).
pub fn has_agent(agent: &str) -> bool {
    #[cfg(test)]
    if TEST_CAN_RUN.get() {
        return true;
    }
    on_path(&if agent == "codex" { crate::codex::program() } else { claude_program() })
}

pub fn exists(state: &Shared, run_id: &str) -> bool {
    let dir = run_dir(state, run_id);
    dir.join("out.jsonl").exists() || dir.join("exit").exists()
}

/// Follow a run's output from `offset` until it exits, feeding the runner.
pub fn follow(state: &Shared, run_id: &str, offset: u64) {
    let (state, run_id) = (state.clone(), run_id.to_string());
    tokio::spawn(async move {
        if let Err(e) = follow_inner(&state, &run_id, offset).await {
            tracing::error!(run = %run_id, "following output failed: {e:#}");
        }
    });
}

/// How much of a run's output `follow_inner` reads at a time, unless a line is longer.
const OUTPUT_CHUNK: usize = 1 << 20;

async fn follow_inner(state: &Shared, run_id: &str, mut offset: u64) -> Result<()> {
    let dir = run_dir(state, run_id);
    let out_path = dir.join("out.jsonl");
    let mut polls = 0u32;
    let mut want = OUTPUT_CHUNK;
    loop {
        let exited = dir.join("exit").exists();
        let chunk = read_from(&out_path, offset, want)?;
        // Whole lines only, unless the run is over and its last line lacks a newline.
        let end = match chunk.iter().rposition(|b| *b == b'\n') {
            Some(i) => i + 1,
            // A line longer than the chunk (a tool result with an image, say): read more of it.
            None if chunk.len() == want => {
                want *= 2;
                continue;
            }
            None if exited => chunk.len(),
            None => 0,
        };
        if end > 0 {
            runner::on_output(state, run_id, offset, &String::from_utf8_lossy(&chunk[..end]));
            offset += end as u64;
            want = OUTPUT_CHUNK;
            continue;
        }
        if exited {
            let exit = read_exit(&dir).unwrap_or(json!({}));
            runner::on_exit(
                state,
                run_id,
                exit["code"].as_i64().map(|c| c as i32),
                exit["signal"].as_i64().map(|c| c as i32),
                exit["error"].as_str().map(String::from),
                &tail(&dir.join("err.log"), 4000),
            );
            return Ok(());
        }
        // Its folder was removed with its task (see `remove_finished` and `prune`), maybe before
        // its exit was seen here, so nothing will write one now. on_exit ends a run still recorded.
        if !dir.exists() {
            runner::on_exit(state, run_id, None, None, Some("the run's folder was removed".into()), "");
            return Ok(());
        }
        // A shim that vanished without recording an exit (killed, or the machine rebooted).
        polls += 1;
        if polls % 10 == 0 {
            if let Some(shim_pid) = read_pid(&dir, "shim.pid") {
                if !alive(shim_pid) && !dir.join("exit").exists() {
                    std::fs::write(dir.join("exit"), r#"{"code":null,"signal":null,"error":"the run's supervisor (ia-shim) disappeared"}"#)?;
                    continue;
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

fn read_pid(dir: &Path, name: &str) -> Option<i32> {
    std::fs::read_to_string(dir.join(name)).ok()?.trim().parse().ok()
}

fn alive(pid: i32) -> bool {
    let ok = unsafe { libc::kill(pid, 0) } == 0;
    ok || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn read_exit(dir: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(dir.join("exit")).ok()?).ok()
}

fn read_from(path: &Path, offset: u64, max: usize) -> Result<Vec<u8>> {
    let mut f = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return Ok(Vec::new()),
    };
    f.seek(SeekFrom::Start(offset))?;
    let mut buf = Vec::new();
    f.take(max as u64).read_to_end(&mut buf)?;
    Ok(buf)
}

fn tail(path: &Path, max: u64) -> String {
    let len = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    read_from(path, len.saturating_sub(max), max as usize)
        .map(|b| String::from_utf8_lossy(&b).to_string())
        .unwrap_or_default()
}

/// How long a finished run's folder is kept: its output has every streamed delta, tool result and
/// image, and nothing reads it once the run has been taken in (see `prune`).
pub const KEEP_DAYS: i64 = 14;
/// How long the results of a finished run's MCP calls are kept. They're only needed while its
/// helper may deliver a call again (see tools::handle_mcp), which it can't once the run has ended.
const KEEP_CALLS: chrono::Duration = chrono::Duration::hours(1);
/// How long a folder of a run whose task is gone, with no sign of whether it's finished, is kept.
const KEEP_UNKNOWN: Duration = Duration::from_secs(3600);
const PRUNE_EVERY: Duration = Duration::from_secs(3600);
/// How many MCP calls are deleted at a time, so the database isn't held long.
const CALLS_BATCH: usize = 1000;

#[derive(Debug, Default, PartialEq)]
pub struct Pruned {
    pub runs: usize,
    pub calls: usize,
}

/// Remove the folders of runs that finished over `KEEP_DAYS` before `now`, and of finished runs
/// whose task is gone, and the MCP calls of runs that finished over `KEEP_CALLS` ago (or are gone).
pub fn prune(state: &Shared, now: chrono::DateTime<chrono::Utc>) -> Result<Pruned> {
    let ts = |d: chrono::Duration| (now - d).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut pruned = Pruned::default();
    // Listed before the runs are read: a run is added before its folder is made, so each folder
    // listed is either in what's read or its task is gone.
    let dirs: Vec<(String, PathBuf)> = match std::fs::read_dir(state.data_dir.join("runs")) {
        Ok(entries) => entries
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .filter_map(|e| Some((e.file_name().into_string().ok()?, e.path())))
            .collect(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => vec![],
        Err(e) => return Err(e).context("listing runs"),
    };
    // Whether each run's folder is kept: it hasn't finished, or did lately.
    let keep: std::collections::HashMap<String, bool> = {
        let c = state.db();
        let mut st = c.prepare("SELECT id, status != 'exited' OR COALESCE(ended_at, created_at) > ?1 FROM runs")?;
        st.query_map([ts(chrono::Duration::days(KEEP_DAYS))], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?
    };
    for (id, dir) in dirs {
        let remove = match keep.get(&id) {
            Some(keep) => !keep,
            None => finished(&dir),
        };
        if remove {
            match std::fs::remove_dir_all(&dir) {
                Ok(()) => pruned.runs += 1,
                Err(e) => tracing::warn!(run = id, "removing the run's folder: {e}"),
            }
        }
    }
    let before = ts(KEEP_CALLS);
    loop {
        let n = state.db().execute(
            "DELETE FROM mcp_calls WHERE rowid IN (SELECT m.rowid FROM mcp_calls m LEFT JOIN runs r ON r.id=m.run_id
               WHERE m.created_at < ?1 AND (r.id IS NULL OR r.status='exited' AND COALESCE(r.ended_at, r.created_at) < ?1) LIMIT ?2)",
            rusqlite::params![before, CALLS_BATCH as i64],
        )?;
        pruned.calls += n;
        if n < CALLS_BATCH {
            break;
        }
    }
    Ok(pruned)
}

/// Whether the run in `dir`, whose task is gone, has finished (it's stopped as its task is deleted).
fn finished(dir: &Path) -> bool {
    if dir.join("exit").exists() {
        return true;
    }
    match read_pid(dir, "shim.pid") {
        Some(pid) => !alive(pid),
        // Never started, or from before shims recorded their pid.
        None => std::fs::metadata(dir).and_then(|m| m.modified()).is_ok_and(|t| t.elapsed().is_ok_and(|e| e > KEEP_UNKNOWN)),
    }
}

/// Remove the folders of these runs that have finished, as their task is deleted. `prune` takes
/// the others once they have.
pub fn remove_finished(state: &Shared, run_ids: &[String]) {
    for id in run_ids {
        let dir = run_dir(state, id);
        if dir.join("exit").exists() {
            if let Err(e) = std::fs::remove_dir_all(&dir) {
                tracing::warn!(run = id, "removing the run's folder: {e}");
            }
        }
    }
}

/// Prune runs (see `prune`) now and every hour.
pub fn start_pruner(state: &Shared) {
    let s = state.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(PRUNE_EVERY);
        loop {
            tick.tick().await;
            let st = s.clone();
            match tokio::task::spawn_blocking(move || prune(&st, chrono::Utc::now())).await {
                Ok(Ok(p)) if p == Pruned::default() => {}
                Ok(Ok(p)) => tracing::info!("runs: removed {} finished runs' folders and {} MCP calls", p.runs, p.calls),
                Ok(Err(e)) => tracing::warn!("runs: pruning failed: {e:#}"),
                Err(e) => tracing::warn!("runs: pruning failed: {e}"),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    /// A running run with output `out` so far, and the task it's for.
    fn run_with_output(out: &str) -> (Shared, String, String) {
        let state = crate::testing::state();
        let p = db::insert_profile(&state.db(), "p", &[], None).unwrap();
        let t = db::NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "t", description: "", status: "in_progress", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let task = db::insert_task(&state.db(), t).unwrap();
        let run = db::insert_run(&state.db(), &task.id, "prompt").unwrap();
        state.db().execute("UPDATE runs SET status='running' WHERE id=?1", [&run.id]).unwrap();
        let dir = run_dir(&state, &run.id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("out.jsonl"), out).unwrap();
        (state, task.id, run.id)
    }

    /// A tool result with an image that makes its line over 1 MiB, as a Read of a big screenshot does.
    fn screenshot() -> String {
        let image = json!({"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "A".repeat(3 << 20)}});
        json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": [image]}]}}).to_string()
    }

    fn said(text: &str) -> String {
        json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}}).to_string()
    }

    fn thread(state: &Shared, task_id: &str) -> Vec<Value> {
        db::list_messages(&state.db(), task_id).unwrap().into_iter().filter(|m| m.kind == "claude").map(|m| m.data).collect()
    }

    fn image_result(m: &Value) -> bool {
        m["message"]["content"][0]["content"] == json!([{"type": "text", "text": "[image]"}])
    }

    /// A run of `task_id` with a folder, ended at `ended` (still running if None) and finished on disk if `exit`.
    fn run_in(state: &Shared, task_id: &str, ended: Option<&str>, exit: bool) -> String {
        let run = db::insert_run(&state.db(), task_id, "prompt").unwrap();
        if let Some(at) = ended {
            state.db().execute("UPDATE runs SET status='exited', ended_at=?1 WHERE id=?2", [at, &run.id]).unwrap();
        }
        let dir = run_dir(state, &run.id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("out.jsonl"), "{}\n").unwrap();
        if exit {
            std::fs::write(dir.join("exit"), r#"{"code":0}"#).unwrap();
        }
        run.id
    }

    fn call(state: &Shared, run_id: &str, at: &str) {
        let c = state.db();
        c.execute(
            "INSERT INTO mcp_calls (id,run_id,task_id,tool,args,status,result,created_at) VALUES (?1,?2,'t','wait','{}','done','{}',?3)",
            rusqlite::params![crate::util::new_id(), run_id, at],
        )
        .unwrap();
    }

    #[test]
    fn prunes_old_finished_runs_and_their_calls_and_finished_runs_of_deleted_tasks() {
        let state = crate::testing::state();
        let p = db::insert_profile(&state.db(), "p", &[], None).unwrap();
        let new_task = || {
            let t = db::NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "t", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
            db::insert_task(&state.db(), t).unwrap().id
        };
        let (task, gone) = (new_task(), new_task());
        let now: chrono::DateTime<chrono::Utc> = "2026-10-28T12:00:00Z".parse().unwrap();
        let old = "2026-10-01T12:00:00.000Z";
        let lately = "2026-10-27T12:00:00.000Z";
        let old_run = run_in(&state, &task, Some(old), true);
        let recent_run = run_in(&state, &task, Some(lately), true);
        // Started weeks ago and still going.
        let running = run_in(&state, &task, None, false);
        state.db().execute("UPDATE runs SET created_at=?1 WHERE id=?2", [old, &running]).unwrap();
        let gone_done = run_in(&state, &gone, Some(lately), true);
        let gone_running = run_in(&state, &gone, None, false);
        // Its shim (this process, for the test) is still stopping it.
        std::fs::write(run_dir(&state, &gone_running).join("shim.pid"), std::process::id().to_string()).unwrap();
        let gone_dead = run_in(&state, &gone, None, false);
        std::fs::write(run_dir(&state, &gone_dead).join("shim.pid"), "999999999").unwrap();
        for r in [&old_run, &recent_run, &running, &gone_done] {
            call(&state, r, old);
        }
        call(&state, &recent_run, "2026-10-28T11:59:00.000Z");
        state.db().execute("DELETE FROM tasks WHERE id=?1", [&gone]).unwrap();

        let pruned = prune(&state, now).unwrap();
        assert_eq!(pruned, Pruned { runs: 3, calls: 3 });
        let kept = |id: &str| run_dir(&state, id).exists();
        assert!(!kept(&old_run) && kept(&recent_run) && kept(&running));
        assert!(!kept(&gone_done) && kept(&gone_running) && !kept(&gone_dead));
        // A call of the recent run made in the last hour stays, as do the running run's.
        let calls: Vec<String> = state.db().prepare("SELECT run_id FROM mcp_calls ORDER BY created_at").unwrap()
            .query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
        assert_eq!(calls, [running.clone(), recent_run.clone()]);
        assert_eq!(prune(&state, now).unwrap(), Pruned::default());
        std::fs::remove_dir_all(&state.data_dir).ok();
    }

    #[test]
    fn following_stops_when_a_deleted_tasks_run_folder_goes_before_its_exit_is_seen() {
        crate::testing::run(async || {
            let (state, task_id, run_id) = run_with_output(&format!("{}\n", said("working")));
            let following = tokio::spawn({
                let (state, run_id) = (state.clone(), run_id.clone());
                async move { follow_inner(&state, &run_id, 0).await }
            });
            while thread(&state, &task_id).is_empty() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            // The agent exits between two polls, and its task is deleted before the next.
            std::fs::write(run_dir(&state, &run_id).join("exit"), r#"{"code":0}"#).unwrap();
            state.db().execute("DELETE FROM tasks WHERE id=?1", [&task_id]).unwrap();
            remove_finished(&state, std::slice::from_ref(&run_id));
            assert!(!run_dir(&state, &run_id).exists());
            tokio::time::timeout(Duration::from_secs(3), following).await.expect("still following a removed run").unwrap().unwrap();
            std::fs::remove_dir_all(&state.data_dir).ok();
        });
    }

    #[test]
    fn follows_a_running_agent_past_a_line_over_a_chunk() {
        crate::testing::run(async || {
            let result = json!({"type": "result", "subtype": "success", "is_error": false, "total_cost_usd": 0.5, "num_turns": 1});
            let out = format!("{}\n{}\n{}\n{result}\n", said("checking the screenshot"), screenshot(), said("looks right"));
            let (state, task_id, run_id) = run_with_output(&out);
            let following = tokio::spawn({
                let (state, run_id) = (state.clone(), run_id.clone());
                async move { follow_inner(&state, &run_id, 0).await }
            });
            // All of it reaches the thread while the agent is still running.
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            while thread(&state, &task_id).len() < 4 {
                assert!(std::time::Instant::now() < deadline, "the thread stopped at {:?}", thread(&state, &task_id).last());
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            let msgs = thread(&state, &task_id);
            assert!(image_result(&msgs[1]));
            assert_eq!(msgs[2]["message"]["content"][0]["text"], "looks right");
            assert_eq!(msgs[3]["type"], "result");
            let run = db::get_run(&state.db(), &run_id).unwrap().unwrap();
            assert_eq!(run.out_offset as usize, out.len());

            std::fs::write(run_dir(&state, &run_id).join("exit"), r#"{"code":0}"#).unwrap();
            following.await.unwrap().unwrap();
            assert_eq!(db::get_run(&state.db(), &run_id).unwrap().unwrap().status, "exited");
        });
    }

    #[test]
    fn takes_in_a_long_last_line_of_an_exited_run_whole() {
        crate::testing::run(async || {
            // The agent's last line has no newline: it was killed while writing, say.
            let out = format!("{}\n{}", said("checking the screenshot"), screenshot());
            let (state, task_id, run_id) = run_with_output(&out);
            std::fs::write(run_dir(&state, &run_id).join("exit"), r#"{"code":1}"#).unwrap();
            follow_inner(&state, &run_id, 0).await.unwrap();
            let msgs = thread(&state, &task_id);
            assert_eq!(msgs.len(), 2, "{msgs:?}");
            assert!(image_result(&msgs[1]));
            let run = db::get_run(&state.db(), &run_id).unwrap().unwrap();
            assert_eq!((run.out_offset as usize, run.status.as_str()), (out.len(), "exited"));
        });
    }
}
