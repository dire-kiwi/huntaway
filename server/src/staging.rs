//! The per-user install dir release updates use, `<data dir>/app/` (see release.rs):
//!
//! - `<v>/`: a release's server tarball, unpacked (`huntaway`, `ia-shim` and `ui/index.html` side by side)
//! - `<v>.partial/`: one being downloaded or unpacked
//! - `state.json`: `{current, previous, staged, trying, bad}`, which the desktop app reads and writes too
//!   (app/electron/versions.cjs), so it's written through a temp file and a rename, and keeps the keys it doesn't know.
//!
//! A release found by a check is downloaded, verified and unpacked here in the background ("staged"), and Update
//! restarts onto it. A server running from `app/<v>/huntaway` settles on startup: it becomes `current`, and the
//! versions nothing needs any more are deleted.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use futures::StreamExt;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value, json};
use tokio::io::AsyncWriteExt;

use crate::state::Shared;
use crate::util::path_str;

/// `app/state.json`.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
pub struct Installed {
    /// The version that last came up from `app/`.
    #[serde(default, deserialize_with = "version")]
    pub current: Option<String>,
    /// The one before it, kept for a rollback.
    #[serde(default, deserialize_with = "version")]
    pub previous: Option<String>,
    /// Downloaded and checked, waiting for Update.
    #[serde(default, deserialize_with = "version")]
    pub staged: Option<String>,
    /// The one an Update is exec'ing into, until it's up.
    #[serde(default, deserialize_with = "version")]
    pub trying: Option<String>,
    /// Versions that didn't start or were rolled back from, which aren't offered again.
    #[serde(default, deserialize_with = "versions")]
    pub bad: Vec<String>,
    /// Keys written by a newer server or the desktop app, kept as they are.
    #[serde(flatten)]
    pub other: Map<String, Value>,
}

/// A version, or none for anything else: the file is shared, so one odd value doesn't lose the rest.
fn version<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(Value::deserialize(d)?.as_str().map(String::from))
}

fn versions<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(v.as_array().into_iter().flatten().filter_map(|v| v.as_str().map(String::from)).collect())
}

impl Installed {
    pub fn is_bad(&self, v: &str) -> bool {
        self.bad.iter().any(|b| b == v)
    }
}

pub fn app_dir(state: &Shared) -> PathBuf {
    state.data_dir.join("app")
}

/// `app/<v>`, for a `v` that is a version (so it can't lead out of `app/`).
pub fn version_dir(app: &Path, v: &str) -> Option<PathBuf> {
    semver::Version::parse(v).is_ok().then(|| app.join(v))
}

/// Whether `dir` has what a server needs: itself, the shim its agents run under, and the UI it serves.
pub fn complete(dir: &Path) -> bool {
    ["huntaway", "ia-shim", "ui/index.html"].iter().all(|f| dir.join(f).symlink_metadata().is_ok_and(|m| m.is_file()))
}

/// `app/state.json`, or the default when there's none or it can't be read.
pub fn read(app: &Path) -> Installed {
    let file = app.join("state.json");
    match std::fs::read(&file) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
            tracing::warn!("ignoring {}: {e}", file.display());
            Installed::default()
        }),
        Err(_) => Installed::default(),
    }
}

/// Write `app/state.json` through a temp file and a rename, so the desktop app never reads half of it.
pub fn write(app: &Path, s: &Installed) -> Result<()> {
    std::fs::create_dir_all(app)?;
    let file = app.join("state.json");
    let tmp = app.join(format!("state.json.{}.tmp", crate::util::new_id()));
    std::fs::write(&tmp, format!("{}\n", serde_json::to_string_pretty(s)?)).with_context(|| format!("writing {}", tmp.display()))?;
    std::fs::rename(&tmp, &file).with_context(|| format!("renaming {} to {}", tmp.display(), file.display())).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// Change `app/state.json`, one change at a time in this server. Returns it as it was.
pub fn change(state: &Shared, f: impl FnOnce(&mut Installed)) -> Result<Installed> {
    let _one = state.release.files.lock().unwrap();
    let app = app_dir(state);
    let old = read(&app);
    let mut new = old.clone();
    f(&mut new);
    if new != old {
        write(&app, &new)?;
    }
    Ok(old)
}

/// The version this server runs from `app/`, when its binary is `<data dir>/app/<v>/huntaway`.
pub fn running_from_app(data_dir: &Path, exe: &Path) -> Option<String> {
    let exe = exe.canonicalize().ok()?;
    if exe.file_name()? != "huntaway" {
        return None;
    }
    let dir = exe.parent()?;
    if dir.parent()? != data_dir.join("app").canonicalize().ok()? {
        return None;
    }
    let v = dir.file_name()?.to_str()?;
    semver::Version::parse(v).is_ok().then(|| v.to_string())
}

/// Whether `v` is staged: `staged` in state.json, with all its files.
pub fn is_staged(state: &Shared, v: &str) -> bool {
    let app = app_dir(state);
    read(&app).staged.as_deref() == Some(v) && version_dir(&app, v).is_some_and(|d| complete(&d))
}

/// For a server running from `app/<v>/huntaway`: make `v` current (and the one it replaced previous, after an
/// Update), and delete what nothing needs: leftover downloads, and every version but current, previous and staged.
/// Runs on startup, before the desktop app is told the server is up.
pub fn settle(state: &Shared) -> Result<Option<String>> {
    let Some(v) = running_from_app(&state.data_dir, &state.exe) else { return Ok(None) };
    let mut now = change(state, |s| settled(s, &v))?;
    settled(&mut now, &v);
    tracing::info!("running release {v} (previous {})", now.previous.as_deref().unwrap_or("none"));
    prune(&app_dir(state), &now);
    Ok(Some(v))
}

fn settled(s: &mut Installed, v: &str) {
    if s.trying.as_deref() == Some(v) {
        if s.current.as_deref() != Some(v) {
            s.previous = s.current.take();
        }
        s.trying = None;
    }
    s.current = Some(v.to_string());
    // Staged is for a newer version.
    let running = semver::Version::parse(v).ok();
    if s.staged.as_deref().is_some_and(|st| semver::Version::parse(st).ok() <= running) {
        s.staged = None;
    }
}

/// Delete everything in `app/` but `state.json` and the versions `s` names (current, previous, staged, and one an
/// Update is still trying): leftover `.partial` downloads, temp files and versions nothing needs.
pub fn prune(app: &Path, s: &Installed) {
    let keep: Vec<&str> = [&s.current, &s.previous, &s.staged, &s.trying].into_iter().flatten().map(String::as_str).collect();
    let Ok(entries) = std::fs::read_dir(app) else { return };
    for e in entries.flatten() {
        let name = e.file_name();
        let name = name.to_string_lossy();
        if name == "state.json" || keep.contains(&name.as_ref()) {
            continue;
        }
        let path = e.path();
        let is_dir = e.file_type().is_ok_and(|t| t.is_dir());
        // Files the desktop app put here are left alone, but for state.json's temp files.
        if !is_dir && !(name.starts_with("state.json.") && name.ends_with(".tmp")) {
            continue;
        }
        tracing::info!("removing {}", path.display());
        let removed = if is_dir { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) };
        if let Err(e) = removed {
            tracing::warn!("removing {}: {e}", path.display());
        }
    }
}

// ---------- downloading a release ----------

/// A release's server tarball for this platform.
#[derive(Clone, Debug)]
pub struct Asset {
    pub name: String,
    pub url: String,
    pub size: u64,
    /// Its sha256 (hex), as the GitHub API lists it.
    pub sha256: String,
}

/// The download in progress (or the last one), in `release.download`.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Download {
    pub version: String,
    /// `downloading`, `verifying`, `installing`, `failed`, or `staged` once it's done (reported as no download).
    pub phase: String,
    pub bytes: u64,
    pub total: Option<u64>,
    pub error: Option<String>,
}

impl Download {
    pub fn running(&self) -> bool {
        matches!(self.phase.as_str(), "downloading" | "verifying" | "installing")
    }

    /// As `release.download` reports it: a staged one is done, and reported as `release.staged` instead.
    pub fn reported(&self) -> Option<&Self> {
        (self.phase != "staged").then_some(self)
    }
}

/// What `start` did.
#[derive(Debug, PartialEq)]
pub enum Start {
    Started,
    /// Another download is running (of `release.download`'s version).
    Busy,
    /// The version is staged already.
    Staged,
}

/// Download, verify and unpack `version` into `app/<version>/` in the background, then stage it, unless a download is
/// running already: there's one at a time.
pub fn start(state: &Shared, version: &str, asset: Asset) -> Start {
    let Ok(one) = state.release.staging.clone().try_lock_owned() else { return Start::Busy };
    if is_staged(state, version) {
        return Start::Staged;
    }
    let total = (asset.size > 0).then_some(asset.size);
    set_download(state, Download { version: version.into(), phase: "downloading".into(), bytes: 0, total, error: None });
    let (st, version) = (state.clone(), version.to_string());
    tokio::spawn(async move {
        stage(&st, &version, &asset).await;
        drop(one);
        crate::release::downloaded(&st, &version);
    });
    Start::Started
}

pub fn set_download(state: &Shared, d: Download) {
    state.release.download.send_replace(Some(d));
    emit_download(state);
}

fn emit_download(state: &Shared) {
    let d = state.release.download.borrow().clone();
    state.emit(json!({"type": "release_download", "download": d.as_ref().and_then(Download::reported)}));
}

fn set_phase(state: &Shared, phase: &str) {
    state.release.download.send_modify(|d| {
        if let Some(d) = d {
            d.phase = phase.into();
        }
    });
    emit_download(state);
}

/// Stage `version`, recording how it went in `release.download`. A failure leaves nothing behind.
async fn stage(state: &Shared, version: &str, asset: &Asset) {
    let app = app_dir(state);
    let partial = app.join(format!("{version}.partial"));
    match stage_into(state, &app, &partial, version, asset).await {
        Ok(()) => {
            tracing::info!("release {version} is staged");
            set_phase(state, "staged");
        }
        Err(e) => {
            let msg = format!("{e:#}");
            tracing::warn!("staging release {version}: {msg}");
            let _ = tokio::fs::remove_dir_all(&partial).await;
            state.release.download.send_modify(|d| {
                if let Some(d) = d {
                    d.phase = "failed".into();
                    d.error = Some(msg);
                }
            });
            emit_download(state);
        }
    }
}

async fn stage_into(state: &Shared, app: &Path, partial: &Path, version: &str, asset: &Asset) -> Result<()> {
    let dest = version_dir(app, version).with_context(|| format!("{version:?} isn't a version"))?;
    if let (Ok(dest), Ok(exe)) = (dest.join("huntaway").canonicalize(), state.exe.canonicalize()) {
        if dest == exe {
            bail!("{version} is the version running");
        }
    }
    // There's one download at a time, so any other is one a restart cut off.
    if let Ok(entries) = std::fs::read_dir(app) {
        for e in entries.flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".partial")) {
            let _ = tokio::fs::remove_dir_all(e.path()).await;
        }
    }
    tokio::fs::create_dir_all(partial).await.with_context(|| format!("making {}", partial.display()))?;
    let tarball = partial.join("download.tar.gz");
    let sha256 = download(state, asset, &tarball).await.with_context(|| format!("downloading {}", asset.name))?;

    set_phase(state, "verifying");
    if !sha256.eq_ignore_ascii_case(&asset.sha256) {
        bail!("{} has sha256 {sha256}, not the {} GitHub lists for it", asset.name, asset.sha256);
    }
    check_entries(&tar(&["-tzf".as_ref(), tarball.as_os_str()]).await?).with_context(|| format!("{} can't be unpacked", asset.name))?;
    check_types(&tar(&["-tvzf".as_ref(), tarball.as_os_str()]).await?).with_context(|| format!("{} can't be unpacked", asset.name))?;

    set_phase(state, "installing");
    tar(&["-xzf".as_ref(), tarball.as_os_str(), "-C".as_ref(), partial.as_os_str(), "--strip-components=1".as_ref(), "--no-same-owner".as_ref()]).await?;
    tokio::fs::remove_file(&tarball).await?;
    if !complete(partial) {
        bail!("{} doesn't have huntaway, ia-shim and ui/index.html", asset.name);
    }
    smoke_test(&partial.join("huntaway"), version).await?;
    // The state is changed under its lock, so a dir that's staged is always there.
    let replaced = {
        let _one = state.release.files.lock().unwrap();
        if dest.exists() {
            std::fs::remove_dir_all(&dest).with_context(|| format!("removing {}", dest.display()))?;
        }
        std::fs::rename(partial, &dest).with_context(|| format!("renaming {} to {}", partial.display(), dest.display()))?;
        let mut s = read(app);
        let old = s.staged.replace(version.to_string());
        write(app, &s)?;
        // A newer release replaces one that was never used.
        old.filter(|o| o != version && ![&s.current, &s.previous, &s.trying].iter().any(|k| k.as_deref() == Some(o.as_str())))
    };
    if let Some(dir) = replaced.and_then(|o| version_dir(app, &o)) {
        tracing::info!("removing {}, which {version} replaces", dir.display());
        if let Err(e) = tokio::fs::remove_dir_all(&dir).await {
            tracing::warn!("removing {}: {e}", dir.display());
        }
    }
    Ok(())
}

/// How long a download may go without a byte before it's given up on.
const STALLED: Duration = Duration::from_secs(60);

/// Stream `asset` to `file`, hashing it as it comes. Returns its sha256 (hex).
async fn download(state: &Shared, asset: &Asset, file: &Path) -> Result<String> {
    let req = crate::hub::http().get(&asset.url).header("user-agent", concat!("huntaway/", env!("CARGO_PKG_VERSION")));
    let res = tokio::time::timeout(STALLED, req.send()).await.context("no answer")??;
    if !res.status().is_success() {
        bail!("{} answered {}", asset.url, res.status());
    }
    let total = res.content_length().or((asset.size > 0).then_some(asset.size));
    state.release.download.send_modify(|d| {
        if let Some(d) = d {
            d.total = total;
        }
    });
    let mut out = tokio::fs::File::create(file).await.with_context(|| format!("making {}", file.display()))?;
    let mut hash = aws_lc_rs::digest::Context::new(&aws_lc_rs::digest::SHA256);
    let mut stream = res.bytes_stream();
    let mut bytes = 0u64;
    let mut emitted = Instant::now();
    loop {
        let chunk = match tokio::time::timeout(STALLED, stream.next()).await {
            Err(_) => bail!("it stalled at {bytes} bytes"),
            Ok(None) => break,
            Ok(Some(chunk)) => chunk.with_context(|| format!("it was cut off at {bytes} bytes"))?,
        };
        hash.update(&chunk);
        out.write_all(&chunk).await?;
        bytes += chunk.len() as u64;
        state.release.download.send_modify(|d| {
            if let Some(d) = d {
                d.bytes = bytes;
            }
        });
        if emitted.elapsed() > Duration::from_millis(500) {
            emitted = Instant::now();
            emit_download(state);
        }
    }
    out.flush().await?;
    drop(out);
    if let Some(total) = total.filter(|t| *t != bytes) {
        bail!("it was cut off at {bytes} of {total} bytes");
    }
    Ok(hash.finish().as_ref().iter().map(|b| format!("{b:02x}")).collect())
}

/// Run the system tar (GNU tar, or bsdtar on a mac) and return what it printed.
async fn tar(args: &[&std::ffi::OsStr]) -> Result<String> {
    let mut cmd = tokio::process::Command::new("tar");
    cmd.args(args).stdin(Stdio::null()).kill_on_drop(true);
    let out = tokio::time::timeout(Duration::from_secs(300), cmd.output()).await.context("tar timed out")?.context("running tar")?;
    if !out.status.success() {
        bail!("tar {} failed: {}", args[0].to_string_lossy(), String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The tarball's entries (`tar -t`) must all be in one top folder (which unpacking strips), with no absolute paths or
/// `..` that could lead out of it.
fn check_entries(listing: &str) -> Result<()> {
    use std::path::Component;
    let mut top: Option<&str> = None;
    for name in listing.lines().filter(|l| !l.is_empty()) {
        let mut parts = Path::new(name).components();
        let first = match parts.next() {
            Some(Component::Normal(first)) => first.to_str().unwrap_or_default(),
            _ => bail!("it has an entry outside its folder: {name}"),
        };
        if name.starts_with('/') || parts.any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
            bail!("it has an entry outside its folder: {name}");
        }
        match top {
            Some(t) if t != first => bail!("it has more than one top folder ({t} and {first})"),
            _ => top = Some(first),
        }
    }
    if top.is_none() {
        bail!("it's empty");
    }
    Ok(())
}

/// The tarball's entries (`tar -tv`) must be files and folders: a link could point out of the folder it unpacks to.
fn check_types(listing: &str) -> Result<()> {
    for line in listing.lines().filter(|l| !l.is_empty()) {
        if !line.starts_with(['-', 'd']) {
            bail!("it has an entry that isn't a file or a folder: {line}");
        }
    }
    Ok(())
}

/// Run `huntaway --version`, which must succeed and print `version`.
async fn smoke_test(exe: &Path, version: &str) -> Result<()> {
    let mut cmd = tokio::process::Command::new(exe);
    cmd.arg("--version").stdin(Stdio::null()).kill_on_drop(true);
    let out = tokio::time::timeout(Duration::from_secs(30), cmd.output())
        .await
        .with_context(|| format!("{} --version didn't finish", path_str(exe)))?
        .with_context(|| format!("running {} --version", path_str(exe)))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    if !out.status.success() {
        bail!("huntaway --version failed with {}: {}", out.status, String::from_utf8_lossy(&out.stderr).trim());
    }
    if !stdout.split_whitespace().any(|w| w.strip_prefix('v').unwrap_or(w) == version) {
        bail!("huntaway --version printed {:?}, not {version}", stdout.trim());
    }
    Ok(())
}
