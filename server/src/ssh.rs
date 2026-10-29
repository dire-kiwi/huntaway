//! Hosts reached over SSH.
//!
//! The hub has its own SSH key. On the target machine that key is restricted to a forced
//! command, `huntaway ssh-host`, plus port forwarding to the host's port:
//!
//! ```text
//! restrict,port-forwarding,permitopen="127.0.0.1:7878",command="/path/huntaway ssh-host --port 7878" ssh-ed25519 AAAA… huntaway-hub
//! ```
//!
//! `ssh-host` starts a host if none is running (through the user's login shell, so agents get
//! the usual PATH) and prints how to talk to it. The hub then reaches the host through an SSH
//! tunnel, so the host can listen on localhost only and never needs to reach the hub. If the
//! tunnel drops, agents keep running and the hub reconnects.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::process::Command;

use crate::db::Link;
use crate::state::Shared;
use crate::util::path_str;

// ---------- on the target machine ----------

/// `huntaway ssh-host`: make sure a host is running on `port` and print JSON describing it.
pub async fn ssh_host(port: u16, data_dir: PathBuf, name: Option<String>) -> Result<()> {
    let base = format!("http://127.0.0.1:{port}");
    let http = reqwest::Client::builder().timeout(Duration::from_secs(3)).build()?;
    let healthy = |http: reqwest::Client, base: String| async move {
        matches!(http.get(format!("{base}/api/health")).send().await, Ok(r) if r.status().is_success())
    };
    let mut started = false;
    if !healthy(http.clone(), base.clone()).await {
        start_detached(port, &data_dir, name.as_deref())?;
        started = true;
        let mut up = false;
        for _ in 0..60 {
            tokio::time::sleep(Duration::from_millis(250)).await;
            if healthy(http.clone(), base.clone()).await {
                up = true;
                break;
            }
        }
        if !up {
            bail!("started a host on port {port}, but it didn't come up; see {}", path_str(&data_dir.join("serve.log")));
        }
    }
    // A running host on the default data dir uses its token file; IA_TOKEN isn't visible here.
    let token = std::fs::read_to_string(data_dir.join("auth_token"))
        .map(|t| t.trim().to_string())
        .with_context(|| format!("no auth_token in {}", data_dir.display()))?;
    let info: Value = http.get(format!("{base}/api/info")).bearer_auth(&token).send().await?.json().await?;
    if info["host_id"].as_str().is_none() {
        bail!("the host on port {port} is too old to link; update it");
    }
    println!("{}", json!({"port": port, "token": token, "started": started, "info": info}));
    Ok(())
}

/// Start `huntaway serve` in its own session, via the user's login shell.
fn start_detached(port: u16, data_dir: &Path, name: Option<&str>) -> Result<()> {
    use std::os::unix::process::CommandExt;
    std::fs::create_dir_all(data_dir)?;
    let exe = std::env::current_exe()?;
    let quote = |s: &str| format!("'{}'", s.replace('\'', r"'\''"));
    let mut cmd_line = format!(
        "exec {} serve --host 127.0.0.1 --port {port} --data-dir {}",
        quote(&path_str(&exe)),
        quote(&path_str(data_dir))
    );
    if let Some(n) = name {
        cmd_line.push_str(&format!(" --name {}", quote(n)));
    }
    let log = std::fs::OpenOptions::new().create(true).append(true).open(data_dir.join("serve.log"))?;
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into());
    let mut cmd = std::process::Command::new(shell);
    cmd.arg("-lc").arg(cmd_line).stdin(Stdio::null()).stdout(log.try_clone()?).stderr(log);
    // Outlive the SSH session.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    cmd.spawn().context("starting huntaway serve")?;
    Ok(())
}

// ---------- on the hub ----------

/// How to reach an SSH host; stored as JSON in `links.ssh`.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Target {
    /// `user@host`
    pub target: String,
    #[serde(default = "default_ssh_port")]
    pub ssh_port: u16,
    /// The host's port on that machine.
    #[serde(default = "default_host_port")]
    pub remote_port: u16,
}

fn default_ssh_port() -> u16 {
    22
}

fn default_host_port() -> u16 {
    7878
}

fn ssh_dir(s: &Shared) -> PathBuf {
    s.data_dir.join("ssh")
}

/// The hub's SSH key, created on first use. Returns the public key line.
pub async fn public_key(s: &Shared) -> Result<String> {
    let dir = ssh_dir(s);
    let key = dir.join("id_ed25519");
    if !key.exists() {
        tokio::fs::create_dir_all(&dir).await?;
        let comment = format!("huntaway-hub@{}", s.host_name);
        let out = Command::new("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-C", &comment, "-f"])
            .arg(&key)
            .output()
            .await
            .context("ssh-keygen not found (the hub needs openssh-client)")?;
        if !out.status.success() {
            bail!("ssh-keygen failed: {}", String::from_utf8_lossy(&out.stderr).trim());
        }
    }
    Ok(tokio::fs::read_to_string(key.with_extension("pub")).await?.trim().to_string())
}

fn ssh_command(s: &Shared, t: &Target) -> Command {
    let dir = ssh_dir(s);
    let mut cmd = Command::new("ssh");
    cmd.arg("-i")
        .arg(dir.join("id_ed25519"))
        .args(["-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"])
        .args(["-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"])
        // Trust on first use; later changes of the host key are refused.
        .arg("-o")
        .arg(format!("UserKnownHostsFile={}", path_str(&dir.join("known_hosts"))))
        .args(["-o", "StrictHostKeyChecking=accept-new"])
        .args(["-p", &t.ssh_port.to_string(), &t.target])
        .stdin(Stdio::null())
        .kill_on_drop(true);
    // If the hub dies, take its ssh processes (tunnels) with it.
    #[cfg(target_os = "linux")]
    unsafe {
        cmd.pre_exec(|| {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
            Ok(())
        });
    }
    cmd
}

/// Run the target's forced command: starts its host if needed and returns its details.
pub async fn ensure(s: &Shared, t: &Target) -> Result<Value> {
    public_key(s).await?;
    let out = ssh_command(s, t).arg("ensure").output().await.context("running ssh")?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let line = stdout.lines().rev().find(|l| l.trim_start().starts_with('{'));
    match (out.status.success(), line) {
        (true, Some(l)) => Ok(serde_json::from_str(l)?),
        _ => {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            if err.contains("Permission denied") {
                bail!("{} refused the hub's key; add the authorized_keys line shown in Settings → Hosts", t.target);
            }
            bail!("ssh {} failed: {}", t.target, if err.is_empty() { stdout.trim().to_string() } else { err })
        }
    }
}

/// Keep an SSH host linked: start it if needed, tunnel to it, follow it; retry on failure.
pub async fn run(s: Shared, link: Link) {
    let Some(t) = link.ssh.as_deref().and_then(|j| serde_json::from_str::<Target>(j).ok()) else {
        return tracing::error!("ssh link {} has no target", link.name);
    };
    let mut backoff = 1;
    loop {
        match connect_once(&s, &link, &t).await {
            Ok(()) => backoff = 1,
            Err(e) => tracing::warn!("ssh host {}: {e:#}", link.name),
        }
        tokio::time::sleep(Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(30);
    }
}

async fn connect_once(s: &Shared, link: &Link, t: &Target) -> Result<()> {
    let details = ensure(s, t).await?;
    let token = details["token"].as_str().ok_or_else(|| anyhow!("no token from ssh-host"))?.to_string();
    let port = details["port"].as_u64().unwrap_or(t.remote_port as u64) as u16;

    // Forward a free local port to the host's port on the target.
    let local = std::net::TcpListener::bind("127.0.0.1:0")?.local_addr()?.port();
    let mut tunnel = ssh_command(s, t)
        .args(["-N", "-o", "ExitOnForwardFailure=yes", "-L", &format!("127.0.0.1:{local}:127.0.0.1:{port}")])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .context("starting the ssh tunnel")?;
    let mut ready = false;
    for _ in 0..100 {
        if tokio::net::TcpStream::connect(("127.0.0.1", local)).await.is_ok() {
            ready = true;
            break;
        }
        if let Some(status) = tunnel.try_wait()? {
            bail!("ssh tunnel exited ({status})");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if !ready {
        bail!("ssh tunnel didn't open");
    }
    let via = Link { url: Some(format!("http://127.0.0.1:{local}")), token: Some(token), ..link.clone() };
    tokio::select! {
        r = crate::hub::run_outbound(s, &via, "ssh") => r,
        status = tunnel.wait() => bail!("ssh tunnel closed ({})", status.map(|s| s.to_string()).unwrap_or_default()),
    }
}
