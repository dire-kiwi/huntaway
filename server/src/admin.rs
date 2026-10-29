//! Rebuild-and-restart from the server's own source checkout, so changes merged to
//! the branch it runs from can be picked up from the UI.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::state::{ApiError, ApiResult, Shared};
use crate::util::{path_str, truncate};
use crate::worktree::git;

/// Facts about this server process, captured at startup.
pub struct ServerMeta {
    pub boot_id: String,
    pub started_at: String,
    /// Repository root containing `server/` and `app/`, if known.
    pub source_dir: Option<PathBuf>,
    /// HEAD of the source checkout when this process started.
    pub running_commit: Option<String>,
    /// Arguments to re-exec with.
    pub args: Vec<OsString>,
}

#[derive(Serialize, Clone)]
pub struct RestartJob {
    pub phase: String,
    pub log: String,
    pub error: Option<String>,
}

impl RestartJob {
    fn active(&self) -> bool {
        self.phase != "failed"
    }
}

/// `--source-dir`, or the checkout this binary was built in (`<root>/server/target/<profile>/huntaway`).
pub fn detect_source_dir(explicit: Option<PathBuf>) -> Option<PathBuf> {
    let root = explicit.or_else(|| {
        let exe = std::env::current_exe().ok()?;
        Some(exe.parent()?.parent()?.parent()?.parent()?.to_path_buf())
    })?;
    let root = root.canonicalize().ok()?;
    (root.join("server/Cargo.toml").is_file() && root.join("app/package.json").is_file()).then_some(root)
}

pub async fn head_commit(dir: &Path) -> Option<String> {
    let o = git(dir, &["rev-parse", "HEAD"]).await.ok()?;
    o.ok.then(|| o.stdout.trim().to_string())
}

pub async fn status(state: &Shared) -> Result<Value> {
    let meta = &state.meta;
    let running_agents = state.runs.lock().unwrap().len();
    let job = state.restart.lock().unwrap().clone();
    let mut v = json!({
        "boot_id": meta.boot_id,
        "started_at": meta.started_at,
        "source_dir": meta.source_dir.as_deref().map(path_str),
        "running_commit": meta.running_commit,
        "running_agents": running_agents,
        "restart": job,
    });
    let Some(src) = &meta.source_dir else { return Ok(v) };
    let head = head_commit(src).await;
    let branch = git(src, &["symbolic-ref", "--short", "HEAD"]).await.ok().filter(|o| o.ok).map(|o| o.stdout.trim().to_string());
    let dirty = git(src, &["status", "--porcelain", "--untracked-files=no"]).await.map(|o| !o.stdout.trim().is_empty()).unwrap_or(false);
    let mut new_commits = Vec::new();
    if let (Some(running), Some(head)) = (&meta.running_commit, &head) {
        if running != head {
            let o = git(src, &["log", "--format=%h %s", "-n", "30", &format!("{running}..{head}")]).await?;
            new_commits = o.stdout.lines().map(String::from).collect();
        }
    }
    v["source_commit"] = json!(head);
    v["source_branch"] = json!(branch);
    v["dirty"] = json!(dirty);
    v["new_commits"] = json!(new_commits);
    Ok(v)
}

/// Start a restart in the background. With `rebuild`, the UI and server are rebuilt
/// first and the restart is abandoned if either build fails.
pub fn start(state: &Shared, rebuild: bool) -> ApiResult<()> {
    if rebuild && state.meta.source_dir.is_none() {
        return Err(ApiError::bad("source checkout not found; start the server with --source-dir"));
    }
    {
        let mut job = state.restart.lock().unwrap();
        if job.as_ref().is_some_and(|j| j.active()) {
            return Err(ApiError::conflict("a restart is already in progress"));
        }
        *job = Some(RestartJob { phase: "starting".into(), log: String::new(), error: None });
    }
    let st = state.clone();
    tokio::spawn(async move {
        if let Err(e) = run(&st, rebuild).await {
            let msg = format!("{e:#}");
            tracing::error!("restart failed: {msg}");
            set_phase(&st, "failed", Some(msg));
        }
    });
    Ok(())
}

fn set_phase(state: &Shared, phase: &str, error: Option<String>) {
    if let Some(job) = state.restart.lock().unwrap().as_mut() {
        job.phase = phase.into();
        job.error = error.clone();
    }
    state.emit(json!({"type": "restart", "phase": phase, "error": error}));
}

fn log_line(state: &Shared, line: &str) {
    if let Some(job) = state.restart.lock().unwrap().as_mut() {
        job.log.push_str(line);
        job.log.push('\n');
        // Keep the tail; build logs can be long.
        if job.log.len() > 200_000 {
            job.log = job.log.split_off(job.log.len() - 150_000);
        }
    }
    state.emit(json!({"type": "restart_log", "line": line}));
}

/// Run a build step, streaming stdout and stderr into the restart log.
async fn step(state: &Shared, dir: &Path, program: &str, args: &[&str]) -> Result<()> {
    log_line(state, &format!("$ {program} {}", args.join(" ")));
    let mut cmd = Command::new(program);
    cmd.args(args).current_dir(dir).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    // Servers launched from a desktop session may not have ~/.cargo/bin on PATH.
    if let Some(home) = dirs::home_dir() {
        let cargo_bin = home.join(".cargo/bin");
        let path = std::env::var_os("PATH").unwrap_or_default();
        let mut paths: Vec<PathBuf> = std::env::split_paths(&path).collect();
        if cargo_bin.is_dir() && !paths.contains(&cargo_bin) {
            paths.push(cargo_bin);
            cmd.env("PATH", std::env::join_paths(paths)?);
        }
    }
    let mut child = cmd.spawn().with_context(|| format!("failed to run {program}"))?;
    let mut out = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut err = BufReader::new(child.stderr.take().unwrap()).lines();
    let (mut out_done, mut err_done) = (false, false);
    while !(out_done && err_done) {
        tokio::select! {
            l = out.next_line(), if !out_done => match l? {
                Some(l) => log_line(state, &l),
                None => out_done = true,
            },
            l = err.next_line(), if !err_done => match l? {
                Some(l) => log_line(state, &l),
                None => err_done = true,
            },
        }
    }
    let status = child.wait().await?;
    if !status.success() {
        bail!("`{program} {}` failed with {status}", args.join(" "));
    }
    Ok(())
}

async fn run(state: &Shared, rebuild: bool) -> Result<()> {
    let mut exe = state.exe.clone();
    if rebuild {
        let src = state.meta.source_dir.clone().context("source checkout not found")?;
        set_phase(state, "building_ui", None);
        step(state, &src.join("app"), "npm", &["install", "--no-audit", "--no-fund"]).await?;
        step(state, &src.join("app"), "npm", &["run", "build"]).await?;
        set_phase(state, "building_server", None);
        step(state, &src.join("server"), "cargo", &["build", "--release"]).await?;
        exe = src.join("server/target/release/huntaway");
    }
    // Agents keep running under ia-shim; the new process resumes following them.
    set_phase(state, "restarting", None);
    // Give the websocket a moment to deliver the final events.
    tokio::time::sleep(Duration::from_millis(300)).await;
    tracing::info!("re-executing {}", exe.display());
    Err(exec(&exe, &state.meta.args))
}

/// Replace this process with a fresh server. Only returns on failure.
#[cfg(unix)]
fn exec(exe: &Path, args: &[OsString]) -> anyhow::Error {
    use std::os::unix::process::CommandExt;
    let err = std::process::Command::new(exe).args(args).exec();
    anyhow!("failed to exec {}: {}", exe.display(), truncate(&err.to_string(), 500))
}

/// Reap the children this process inherited from the server it replaced (see `exec`), such as
/// a wait's command, killed as that server went (see wait::LAUNCH): nothing else knows to, so
/// they'd stay zombies. Call before starting any process of its own, which it would take for
/// inherited ones.
pub fn reap_inherited() {
    let me = std::process::id();
    let parent = |pid: u32| {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // "pid (comm) state ppid …", where comm may hold anything.
        stat.rsplit_once(')')?.1.split_whitespace().nth(1)?.parse::<u32>().ok()
    };
    let Ok(dir) = std::fs::read_dir("/proc") else { return };
    let mut children: Vec<u32> = dir.flatten().filter_map(|e| e.file_name().to_str()?.parse().ok()).filter(|&pid| parent(pid) == Some(me)).collect();
    if children.is_empty() {
        return;
    }
    std::thread::spawn(move || {
        while !children.is_empty() {
            // Done with those reaped or not children after all; waiting on the others.
            children.retain(|&pid| unsafe { libc::waitpid(pid as i32, std::ptr::null_mut(), libc::WNOHANG) } == 0);
            std::thread::sleep(Duration::from_secs(5));
        }
    });
}

#[cfg(not(unix))]
fn exec(exe: &Path, args: &[OsString]) -> anyhow::Error {
    match std::process::Command::new(exe).args(args).spawn() {
        Ok(_) => std::process::exit(0),
        Err(e) => anyhow!("failed to start {}: {e}", exe.display()),
    }
}

// ---------- updating from a hub ----------

/// The source checkout's current branch and commit, packed as a git bundle (base64), for a
/// linked host to update from.
pub async fn bundle(state: &Shared) -> ApiResult<Value> {
    let src = state.meta.source_dir.clone().ok_or_else(|| ApiError::bad("this hub has no source checkout to share"))?;
    let branch = git(&src, &["symbolic-ref", "--short", "HEAD"]).await?;
    if !branch.ok {
        return Err(ApiError::bad("the hub's checkout isn't on a branch"));
    }
    let branch = branch.stdout.trim().to_string();
    let commit = head_commit(&src).await.ok_or_else(|| ApiError::bad("can't read the hub's commit"))?;
    let path = state.data_dir.join("outgoing.bundle");
    let o = git(&src, &["bundle", "create", &path_str(&path), &branch]).await?;
    if !o.ok {
        return Err(ApiError::bad(format!("git bundle failed: {}", o.stderr.trim())));
    }
    let bytes = tokio::fs::read(&path).await.map_err(anyhow::Error::from)?;
    let _ = tokio::fs::remove_file(&path).await;
    use base64::Engine;
    Ok(json!({"branch": branch, "commit": commit, "bundle": base64::engine::general_purpose::STANDARD.encode(bytes)}))
}

/// Fast-forward this host's checkout to a hub's bundle, then rebuild and restart.
pub async fn update_from_bundle(state: &Shared, branch: &str, commit: &str, bundle_b64: &str) -> ApiResult<Value> {
    let src = state.meta.source_dir.clone().ok_or_else(|| ApiError::bad("this host isn't running from a source checkout; update it by hand"))?;
    let current = git(&src, &["symbolic-ref", "--short", "HEAD"]).await?.stdout.trim().to_string();
    if current != branch {
        return Err(ApiError::conflict(format!("this host's checkout is on {current}, the hub's on {branch}")));
    }
    if head_commit(&src).await.as_deref() == Some(commit) && state.meta.running_commit.as_deref() == Some(commit) {
        return Ok(json!({"ok": true, "up_to_date": true}));
    }
    let dirty = git(&src, &["status", "--porcelain", "--untracked-files=no"]).await?;
    if !dirty.stdout.trim().is_empty() {
        return Err(ApiError::conflict("this host's checkout has uncommitted changes"));
    }
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(bundle_b64.trim()).map_err(|e| ApiError::bad(format!("bad bundle: {e}")))?;
    let path = state.data_dir.join("incoming.bundle");
    tokio::fs::write(&path, bytes).await.map_err(anyhow::Error::from)?;
    let refspec = format!("refs/heads/{branch}:refs/remotes/hub/{branch}");
    let fetched = git(&src, &["fetch", "--quiet", &path_str(&path), &refspec]).await?;
    let _ = tokio::fs::remove_file(&path).await;
    if !fetched.ok {
        return Err(ApiError::bad(format!("fetching the hub's bundle failed: {}", fetched.stderr.trim())));
    }
    let merged = git(&src, &["merge", "--ff-only", commit]).await?;
    if !merged.ok {
        return Err(ApiError::conflict(format!("can't fast-forward to the hub's {branch}: {}", merged.stderr.trim())));
    }
    start(state, true)?;
    Ok(json!({"ok": true, "commit": commit}))
}

/// Fast-forward this host's checkout to `commit`, fetched from its own `origin`, then rebuild
/// and restart. Only follows the checkout's own branch: the commit must be on its upstream.
pub async fn update_from_origin(state: &Shared, commit: &str) -> ApiResult<Value> {
    let src = state.meta.source_dir.clone().ok_or_else(|| ApiError::bad("this host isn't running from a source checkout; update it by hand"))?;
    if state.meta.running_commit.as_deref() == Some(commit) {
        return Ok(json!({"ok": true, "up_to_date": true}));
    }
    let branch = git(&src, &["symbolic-ref", "--short", "HEAD"]).await?;
    if !branch.ok {
        return Err(ApiError::conflict("this host's checkout isn't on a branch"));
    }
    let branch = branch.stdout.trim().to_string();
    let dirty = git(&src, &["status", "--porcelain", "--untracked-files=no"]).await?;
    if !dirty.stdout.trim().is_empty() {
        return Err(ApiError::conflict("this host's checkout has uncommitted changes"));
    }
    let fetched = git(&src, &["fetch", "--quiet", "origin"]).await?;
    if !fetched.ok {
        return Err(ApiError::bad(format!("git fetch origin failed: {}", fetched.stderr.trim())));
    }
    let upstream = format!("origin/{branch}");
    if !git(&src, &["merge-base", "--is-ancestor", commit, &upstream]).await?.ok {
        return Err(ApiError::conflict(format!("{} isn't on {upstream}; push it, or update this host by hand", &commit[..commit.len().min(7)])));
    }
    if head_commit(&src).await.as_deref() != Some(commit) {
        let merged = git(&src, &["merge", "--ff-only", commit]).await?;
        if !merged.ok {
            return Err(ApiError::conflict(format!("can't fast-forward {branch}: {}", merged.stderr.trim())));
        }
    }
    start(state, true)?;
    Ok(json!({"ok": true, "commit": commit}))
}
