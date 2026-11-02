//! Updates for release installs (the desktop app's packages, or a server installed from a release
//! tarball): with `--release-updates <OWNER/REPO>`, check that repository's GitHub releases for a
//! newer server, and report what was found in `GET /admin/server` (API 88). A newer release is downloaded into
//! `<data dir>/app/` in the background (see update/staging.rs), `POST /admin/release/update` restarts onto it, and
//! `POST /admin/release/rollback` goes back to the version before.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::state::{ApiError, ApiResult, Shared};
use crate::update::admin;
use crate::update::staging::{self, Asset, Download, Installed, Start};

/// The settings key for "Include prereleases" (`"true"` when on).
pub const PRERELEASES: &str = "release_prereleases";

const FIRST_CHECK: Duration = Duration::from_secs(30);
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

/// What `--release-updates` and the desktop app's environment say, read at startup.
#[derive(Clone, Debug)]
pub struct Config {
    /// `OWNER/REPO` on GitHub.
    pub repo: String,
    /// The GitHub API's base URL (`IA_RELEASE_API`, for tests).
    pub api: String,
    /// `<os>-<arch>` as the release's asset names have it (`linux-x64`, `mac-arm64`).
    pub platform: String,
    /// The desktop app's version (`IA_DESKTOP_VERSION`), when the app started this server.
    pub desktop_version: Option<String>,
    /// Its shell stamp (`IA_DESKTOP_SHELL`), compared with a release's `huntaway-<v>-release.json`.
    pub desktop_shell: Option<String>,
    /// How the app was installed (`IA_DESKTOP_INSTALL`): `pacman`, `appimage:<path>`, `mac:<.app path>` or `other`.
    pub desktop_install: Option<String>,
    /// The package's own server (`IA_BUNDLED_SERVER`), to fall back to.
    pub bundled_server: Option<String>,
}

impl Config {
    /// The config for `--release-updates <repo>`, or an error for a repo that isn't `OWNER/REPO`.
    pub fn from_env(repo: &str) -> Result<Self> {
        let repo = repo.trim();
        let valid = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
        match repo.split_once('/') {
            Some((owner, name)) if valid(owner) && valid(name) => {}
            _ => bail!("--release-updates {repo:?} isn't OWNER/REPO"),
        }
        let var = |k: &str| std::env::var(k).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        Ok(Config {
            repo: repo.to_string(),
            api: var("IA_RELEASE_API").unwrap_or_else(|| "https://api.github.com".into()).trim_end_matches('/').to_string(),
            platform: platform(),
            desktop_version: var("IA_DESKTOP_VERSION"),
            desktop_shell: var("IA_DESKTOP_SHELL"),
            desktop_install: var("IA_DESKTOP_INSTALL"),
            bundled_server: var("IA_BUNDLED_SERVER"),
        })
    }
}

/// On the startup of a server with release updates that the desktop app didn't start (a tarball host's, started again
/// by its supervisor after a reboot, say): exec the release in `app/` it last updated to, when that's newer than this
/// one (`staging::choose_at_startup`). The desktop app chooses for the servers it starts, and a server in `app/` is the
/// one chosen. Returns when there's nothing to start, or the exec failed.
#[cfg(unix)]
pub fn exec_installed(data_dir: &std::path::Path) {
    use std::os::unix::process::CommandExt;
    if std::env::var_os("IA_DESKTOP_VERSION").is_some_and(|v| !v.is_empty()) {
        return;
    }
    let Ok(exe) = std::env::current_exe() else { return };
    if staging::running_from_app(data_dir, &exe).is_some() {
        return;
    }
    let app = data_dir.join("app");
    let (v, bin) = match staging::choose_at_startup(&app, &running()) {
        Ok(Some(pick)) => pick,
        Ok(None) => return,
        Err(e) => return tracing::warn!("choosing a release in {} to start: {e:#}", app.display()),
    };
    tracing::info!("starting release {v}, which this host last updated to, from {}", bin.display());
    let mut cmd = std::process::Command::new(&bin);
    cmd.args(std::env::args_os().skip(1));
    // So that Roll back can come back to this server.
    if std::env::var_os("IA_BUNDLED_SERVER").is_none_or(|v| v.is_empty()) {
        cmd.env("IA_BUNDLED_SERVER", &exe);
    }
    let err = cmd.exec();
    tracing::warn!("starting {}: {err}; running {} instead", bin.display(), env!("CARGO_PKG_VERSION"));
    let mut s = staging::read(&app);
    if s.trying.as_deref() == Some(v.as_str()) {
        s.trying = None;
        s.bad.push(v);
        if let Err(e) = staging::write(&app, &s) {
            tracing::warn!("marking the release bad: {e:#}");
        }
    }
}

/// This build's `<os>-<arch>`, with the names `release.yml` uses.
fn platform() -> String {
    let os = match std::env::consts::OS {
        "macos" => "mac",
        os => os,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        arch => arch,
    };
    format!("{os}-{arch}")
}

/// A release from `GET /repos/{repo}/releases`, with the fields used here.
#[derive(Deserialize, Clone, Debug)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    published_at: Option<String>,
    body: Option<String>,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

#[derive(Deserialize, Clone, Debug)]
struct GhAsset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
    /// `sha256:<hex>` (GitHub fills it in for assets uploaded since mid 2025).
    digest: Option<String>,
}

impl GhAsset {
    fn sha256(&self) -> Option<&str> {
        let hex = self.digest.as_deref()?.strip_prefix("sha256:")?;
        (hex.len() == 64 && hex.chars().all(|c| c.is_ascii_hexdigit())).then_some(hex)
    }

    fn json(&self) -> Value {
        json!({"name": self.name, "url": self.browser_download_url, "size": self.size, "sha256": self.sha256()})
    }

    fn to_asset(&self) -> Option<Asset> {
        Some(Asset { name: self.name.clone(), url: self.browser_download_url.clone(), size: self.size, sha256: self.sha256()?.to_string() })
    }
}

/// A release's `huntaway-<v>-release.json`: which desktop shell it was built with.
#[derive(Deserialize, Clone, Debug, PartialEq)]
struct Manifest {
    shell: String,
}

/// The release a check picked.
#[derive(Clone, Debug)]
struct Latest {
    version: semver::Version,
    release: GhRelease,
    /// Its server tarball for this platform.
    asset: GhAsset,
    /// Its manifest, when it has one and it could be read.
    manifest: Option<Manifest>,
}

/// What the checks found (in `AppState::release`), and the download of the release they found.
#[derive(Default)]
pub struct Releases {
    last: Mutex<Checked>,
    /// Held for a check, so there's one at a time.
    checking: tokio::sync::Mutex<()>,
    /// The download in progress, or the last one (see staging::start).
    pub download: tokio::sync::watch::Sender<Option<Download>>,
    /// Held for a download, so there's one at a time.
    pub staging: Arc<tokio::sync::Mutex<()>>,
    /// Held to change `app/state.json` or the versions in `app/` (see staging::change).
    pub files: Mutex<()>,
}

#[derive(Default, Clone)]
struct Checked {
    /// The last list GitHub sent, and its ETag, so a 304 can be picked from again.
    etag: Option<String>,
    releases: Option<Vec<GhRelease>>,
    latest: Option<Latest>,
    checked_at: Option<String>,
    error: Option<String>,
    /// When GitHub's rate limit resets, if the last check ran into it.
    rate_limit_reset: Option<String>,
}

/// GitHub turned a request away for the rate limit.
#[derive(Debug)]
struct RateLimited {
    reset: Option<String>,
}

impl std::fmt::Display for RateLimited {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.reset {
            Some(at) => write!(f, "GitHub's rate limit for release checks is used up until {at}"),
            None => write!(f, "GitHub's rate limit for release checks is used up"),
        }
    }
}

impl std::error::Error for RateLimited {}

/// Whether "Include prereleases" is on.
pub fn prereleases(state: &Shared) -> Result<bool> {
    Ok(crate::db::get_setting(&state.db(), PRERELEASES)?.as_deref() == Some("true"))
}

/// With `--release-updates`, check 30 seconds after start and then every 6 hours.
pub fn start(state: &Shared) {
    let Some(cfg) = &state.meta.release else { return };
    tracing::info!("checking {}'s GitHub releases for updates", cfg.repo);
    let st = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            check(&st).await;
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

/// Check in the background (when "Include prereleases" changes).
pub fn check_soon(state: &Shared) {
    if state.meta.release.is_none() {
        return;
    }
    let st = state.clone();
    tokio::spawn(async move { check(&st).await });
}

/// Ask GitHub for the releases and pick the newest one this server could update to. A failed
/// check keeps what the last one found, with the error.
pub async fn check(state: &Shared) {
    let Some(cfg) = state.meta.release.clone() else { return };
    let _one = state.release.checking.lock().await;
    let last = state.release.last.lock().unwrap().clone();
    let result = check_with(state, &cfg, &last).await;
    let mut next = last;
    next.checked_at = Some(crate::util::now());
    next.rate_limit_reset = None;
    match result {
        Ok((etag, releases, latest)) => {
            next.etag = etag;
            next.releases = Some(releases);
            next.latest = latest;
            next.error = None;
        }
        Err(e) => {
            tracing::warn!("checking {} for releases: {e:#}", cfg.repo);
            next.rate_limit_reset = e.downcast_ref::<RateLimited>().and_then(|r| r.reset.clone());
            next.error = Some(format!("{e:#}"));
        }
    }
    *state.release.last.lock().unwrap() = next;
    unstage_unpicked(state);
    state.emit(json!({"type": "release_checked"}));
    stage_latest(state);
}

/// Once a check has succeeded, unstage a staged version it would no longer offer: a prerelease after "Include
/// prereleases" is turned off, or a release that was taken down. One it still offers stays, even below the latest, until
/// the latest's download replaces it.
fn unstage_unpicked(state: &Shared) {
    if let Some(still) = offered_now(state) {
        staging::unstage_unless(state, |v| still.contains(v));
    }
}

/// The versions the last check would offer under the settings as they are now, or none until a check has succeeded.
fn offered_now(state: &Shared) -> Option<Vec<semver::Version>> {
    let cfg = state.meta.release.as_ref()?;
    let releases = {
        let last = state.release.last.lock().unwrap();
        if last.checked_at.is_none() || last.error.is_some() {
            return None;
        }
        last.releases.clone().unwrap_or_default()
    };
    let prereleases = prereleases(state).ok()?;
    let bad = staging::read(&staging::app_dir(state)).bad;
    Some(offered(&releases, &cfg.platform, prereleases, &bad).map(|(v, ..)| v).collect())
}

/// An error if a check since has withdrawn `v` (prereleases turned off, or the release taken down).
fn still_offered(state: &Shared, v: &str) -> Result<()> {
    let version = semver::Version::parse(v)?;
    if offered_now(state).is_some_and(|o| !o.contains(&version)) {
        bail!("{v} isn't offered any more (prereleases were turned off, or the release was taken down)");
    }
    Ok(())
}

/// The version this server runs.
fn running() -> semver::Version {
    semver::Version::parse(env!("CARGO_PKG_VERSION")).expect("the server's version is semver")
}

/// Start downloading the latest release in the background, if it's newer than this server and isn't staged yet (nor
/// bad: those aren't picked). A download that failed is tried again; one that's running isn't started twice.
fn stage_latest(state: &Shared) {
    let Some(latest) = state.release.last.lock().unwrap().latest.clone() else { return };
    if latest.version <= running() {
        return;
    }
    let Some(asset) = latest.asset.to_asset() else { return };
    let version = latest.version.to_string();
    if staging::start(state, &version, asset) == Start::Started {
        tracing::info!("downloading release {version}");
    }
}

/// After a download of `version`: if a check found a newer release meanwhile, download that one now rather than
/// after the next check.
pub fn downloaded(state: &Shared, version: &str) {
    // A check while it downloaded may have stopped picking it (prereleases turned off).
    unstage_unpicked(state);
    let latest = state.release.last.lock().unwrap().latest.as_ref().map(|l| l.version.to_string());
    if latest.is_some_and(|l| l != version) {
        stage_latest(state);
    }
}

type Found = (Option<String>, Vec<GhRelease>, Option<Latest>);

/// The list (fetched again, or the last one on a 304) and the release picked from it. A manifest
/// that can't be read fails the check, so the last result (and what it said of the shell) stands.
async fn check_with(state: &Shared, cfg: &Config, last: &Checked) -> Result<Found> {
    let prereleases = prereleases(state)?;
    let bad = staging::read(&staging::app_dir(state)).bad;
    let url = format!("{}/repos/{}/releases?per_page=20", cfg.api, cfg.repo);
    let mut req = request(&url).header("accept", "application/vnd.github+json").header("x-github-api-version", "2022-11-28");
    // Only with the list it goes with: a 304 means "the list you have".
    if let (Some(etag), Some(_)) = (&last.etag, &last.releases) {
        req = req.header("if-none-match", etag);
    }
    let res = req.send().await.with_context(|| format!("asking {url}"))?;
    let status = res.status();
    let (etag, releases) = if status == reqwest::StatusCode::NOT_MODIFIED {
        (last.etag.clone(), last.releases.clone().context("GitHub said the releases hadn't changed, but there's no earlier list")?)
    } else if status.is_success() {
        let etag = res.headers().get("etag").and_then(|v| v.to_str().ok()).map(String::from);
        let releases: Vec<GhRelease> = res.json().await.context("reading the releases")?;
        (etag, releases)
    } else {
        return Err(refused(res).await);
    };
    let Some((version, release, asset)) = pick(&releases, &cfg.platform, prereleases, &bad) else {
        return Ok((etag, releases, None));
    };
    // The manifest only changes with the release, so one read before is kept.
    let manifest_name = format!("huntaway-{}-release.json", tag_version(&release.tag_name));
    let manifest_asset = release.assets.iter().find(|a| a.name == manifest_name);
    let kept = last.latest.as_ref().filter(|l| l.version == version && l.release.tag_name == release.tag_name).and_then(|l| l.manifest.clone());
    let manifest = match (manifest_asset, kept) {
        (None, _) => None,
        (Some(_), Some(m)) => Some(m),
        (Some(a), None) => Some(fetch_manifest(a).await.with_context(|| format!("reading {manifest_name}"))?),
    };
    Ok((etag, releases.clone(), Some(Latest { version, release: release.clone(), asset: asset.clone(), manifest })))
}

fn request(url: &str) -> reqwest::RequestBuilder {
    crate::hosts::hub::http().get(url).header("user-agent", concat!("huntaway/", env!("CARGO_PKG_VERSION"))).timeout(Duration::from_secs(30))
}

/// The error for a response that isn't a list: the rate limit (with when it resets), or GitHub's message.
async fn refused(res: reqwest::Response) -> anyhow::Error {
    let status = res.status();
    let header = |k: &str| res.headers().get(k).and_then(|v| v.to_str().ok()).map(str::trim).map(String::from);
    if matches!(status.as_u16(), 403 | 429) && header("x-ratelimit-remaining").as_deref() == Some("0") {
        let reset = header("x-ratelimit-reset")
            .and_then(|s| s.parse::<i64>().ok())
            .and_then(|t| chrono::DateTime::from_timestamp(t, 0))
            .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
        return RateLimited { reset }.into();
    }
    let body: Value = res.json().await.unwrap_or_default();
    match body["message"].as_str() {
        Some(m) => anyhow::anyhow!("GitHub answered {status}: {m}"),
        None => anyhow::anyhow!("GitHub answered {status}"),
    }
}

async fn fetch_manifest(asset: &GhAsset) -> Result<Manifest> {
    let res = request(&asset.browser_download_url).send().await?;
    if !res.status().is_success() {
        return Err(refused(res).await);
    }
    Ok(res.json().await?)
}

/// A tag's version text, without the optional `v`.
fn tag_version(tag: &str) -> &str {
    tag.strip_prefix('v').unwrap_or(tag)
}

/// The highest semver release that isn't a draft (nor a prerelease, unless they're included) nor
/// bad (rolled back from, or failed to start), and has a server tarball for `platform` with a
/// sha256 digest.
fn pick<'a>(releases: &'a [GhRelease], platform: &str, prereleases: bool, bad: &[String]) -> Option<(semver::Version, &'a GhRelease, &'a GhAsset)> {
    offered(releases, platform, prereleases, bad).max_by(|a, b| a.0.cmp(&b.0))
}

/// The releases a check could pick (see `pick`), each with its version and server tarball.
fn offered<'a, 'b>(
    releases: &'a [GhRelease],
    platform: &'b str,
    prereleases: bool,
    bad: &'b [String],
) -> impl Iterator<Item = (semver::Version, &'a GhRelease, &'a GhAsset)> {
    releases
        .iter()
        .filter(move |r| !r.draft && (prereleases || !r.prerelease))
        .filter_map(move |r| {
            let text = tag_version(&r.tag_name);
            let version = semver::Version::parse(text).ok()?;
            if bad.iter().any(|b| semver::Version::parse(b).is_ok_and(|b| b == version)) {
                return None;
            }
            let name = format!("huntaway-server-{text}-{platform}.tar.gz");
            let asset = r.assets.iter().find(|a| a.name == name && a.sha256().is_some())?;
            Some((version, r, asset))
        })
}

/// The `release` block of `GET /admin/server`, when release updates are on.
pub fn status(state: &Shared) -> Result<Option<Value>> {
    let Some(cfg) = &state.meta.release else { return Ok(None) };
    let prereleases = prereleases(state)?;
    let last = state.release.last.lock().unwrap().clone();
    let running = env!("CARGO_PKG_VERSION");
    let app = staging::app_dir(state);
    let installed = staging::read(&app);
    let download = state.release.download.borrow().clone();
    let latest = last.latest.as_ref().map(|l| {
        json!({
            "version": l.version.to_string(),
            "prerelease": l.release.prerelease,
            "published_at": l.release.published_at,
            "notes": l.release.body,
            "url": l.release.html_url,
            "asset": l.asset.json(),
            "newer": semver::Version::parse(running).is_ok_and(|r| l.version > r),
        })
    });
    Ok(Some(json!({
        "repo": cfg.repo,
        "running": running,
        // Where it runs from: `<data dir>/app/<v>/huntaway`, the desktop app's own server, or a tarball's.
        "exe": crate::util::path_str(&state.exe),
        "latest": latest,
        "prereleases": prereleases,
        "checked_at": last.checked_at,
        "error": last.error,
        "rate_limit_reset": last.rate_limit_reset,
        "shell": shell(cfg, last.latest.as_ref()),
        "bundled_server": cfg.bundled_server,
        // A version downloaded and checked, for Update to restart onto.
        "staged": staging::staged(&app, &installed),
        "download": download.as_ref().and_then(Download::reported),
        "previous": installed.previous,
        "bad": installed.bad,
        // What Roll back would start: a version, "bundled" (the desktop app's own server), or null.
        "rollback_to": rollback_target(state).map(|(_, v)| v.unwrap_or_else(|| "bundled".into())),
    })))
}

// ---------- Update and Roll back ----------

/// Restart onto `version` (a `RestartJob`): straight away if it's staged, after its background download if that's
/// still running, or after downloading it now. Anything that goes wrong before the exec leaves this server running.
pub fn update(state: &Shared, version: &str) -> ApiResult<()> {
    if state.meta.release.is_none() {
        return Err(ApiError::bad("this server doesn't update from releases (start it with --release-updates OWNER/REPO)"));
    }
    let version = semver::Version::parse(version.trim().trim_start_matches('v')).map_err(|_| ApiError::bad(format!("{version:?} isn't a version")))?;
    if version <= running() {
        return Err(ApiError::bad(format!("this server runs {}, which isn't older than {version}", running())));
    }
    let v = version.to_string();
    if staging::read(&staging::app_dir(state)).is_bad(&v) {
        return Err(ApiError::bad(format!("{v} was rolled back from or didn't start, so it isn't offered again")));
    }
    // The asset, in case it has to be downloaded: only the latest release's is known.
    let latest = state.release.last.lock().unwrap().latest.clone();
    let asset = latest.filter(|l| l.version == version).and_then(|l| l.asset.to_asset());
    if asset.is_none() && !staging::is_staged(state, &v) {
        return Err(ApiError::bad(format!("{v} isn't the latest release; check for releases again")));
    }
    admin::begin(state, move |st| async move {
        wait_for_staging(&st, &v, asset).await?;
        restart_onto(&st, &v).await
    })
}

/// A hub's Update for a release install (API 89): restart onto the release the hub runs, as `update` does. When that
/// isn't the latest release this server knows of (nor staged), it checks first: the hub may run one published since.
pub async fn update_from_hub(state: &Shared, version: &str) -> ApiResult<Value> {
    let target = semver::Version::parse(version.trim().trim_start_matches('v')).map_err(|_| ApiError::bad(format!("the board's version {version:?} isn't a version")))?;
    if target == running() {
        return Ok(json!({"ok": true, "up_to_date": true}));
    }
    if target < running() {
        return Err(ApiError::bad(format!("this host runs {}, which is newer than the board's {target}", running())));
    }
    let v = target.to_string();
    let latest = || state.release.last.lock().unwrap().latest.as_ref().map(|l| l.version.clone());
    if latest().as_ref() != Some(&target) && !staging::is_staged(state, &v) {
        check(state).await;
        if let Some(newer) = latest().filter(|l| *l > target).filter(|_| !staging::is_staged(state, &v)) {
            return Err(ApiError::bad(format!("the latest release is {newer}, newer than the board's {target}: update the board first, or this host from its own board")));
        }
    }
    update(state, &v)?;
    Ok(json!({"ok": true}))
}

/// Until `v` is staged: follow its download (starting one if none is running) in the restart's phases and log.
async fn wait_for_staging(st: &Shared, v: &str, asset: Option<Asset>) -> Result<()> {
    let mut rx = st.release.download.subscribe();
    let mut started = false;
    let mut logged: Option<(String, u64)> = None;
    loop {
        if staging::is_staged(st, v) {
            return Ok(());
        }
        let d = rx.borrow_and_update().clone().filter(|d| d.version == v);
        match d {
            Some(d) if d.running() => {
                mirror(st, &d, &mut logged);
                rx.changed().await?;
                continue;
            }
            Some(d) if started => bail!("{}", d.error.unwrap_or_else(|| format!("{v} wasn't staged"))),
            _ => {}
        }
        // Its download finished but was unstaged, or it's about to be downloaded again: only while it's still offered.
        still_offered(st, v)?;
        let asset = asset.clone().with_context(|| format!("{v} isn't staged any more; check for releases again"))?;
        match staging::start(st, v, asset) {
            Start::Started => started = true,
            Start::Staged => return Ok(()),
            Start::Busy => {
                let d = st.release.download.borrow().clone().filter(|d| d.running());
                match d {
                    // Followed next time round.
                    Some(d) if d.version == v => {}
                    d => {
                        if let Some(other) = d {
                            admin::log_line(st, &format!("Waiting for the download of {} to finish", other.version));
                        }
                        drop(st.release.staging.lock().await);
                    }
                }
            }
        }
    }
}

/// Show a download's progress in the restart job: its phase, and a line in the log for each phase and tenth.
fn mirror(st: &Shared, d: &Download, logged: &mut Option<(String, u64)>) {
    let tenth = d.total.filter(|t| *t > 0).map(|t| d.bytes * 10 / t).unwrap_or(0);
    if logged.as_ref().is_some_and(|(phase, t)| *phase == d.phase && *t == tenth) {
        return;
    }
    if logged.as_ref().is_none_or(|(phase, _)| *phase != d.phase) {
        admin::set_phase(st, &d.phase, None);
        admin::log_line(
            st,
            &match d.phase.as_str() {
                "downloading" => format!("Downloading {}{}", d.version, d.total.map(|t| format!(" ({})", mb(t))).unwrap_or_default()),
                "verifying" => "Checking its sha256 and what it holds".into(),
                _ => format!("Unpacking it into {}, and checking that it runs", crate::util::path_str(&staging::app_dir(st).join(&d.version))),
            },
        );
    } else if let Some(total) = d.total {
        admin::log_line(st, &format!("{}0% ({} of {})", tenth, mb(d.bytes), mb(total)));
    }
    *logged = Some((d.phase.clone(), tenth));
}

fn mb(bytes: u64) -> String {
    format!("{:.1} MB", bytes as f64 / 1e6)
}

/// Set `trying` and exec `app/<v>/huntaway`. When that fails, `trying` is put back.
async fn restart_onto(st: &Shared, v: &str) -> Result<()> {
    let app = staging::app_dir(st);
    let exe = staging::version_dir(&app, v).context("not a version")?.join("huntaway");
    let old = staging::change(st, |s| s.trying = Some(v.to_string()))?;
    let err = admin::restart_into(st, &exe, &bundled_env(st)).await;
    staging::change(st, |s| {
        if s.trying.as_deref() == Some(v) {
            s.trying = old.trying;
        }
    })?;
    Err(err)
}

/// What an Update adds to the environment of the version it execs: a server that isn't running from `app/` (a
/// tarball's) and has no `IA_BUNDLED_SERVER` passes itself as that, so that Roll back can come back to it straight
/// away, as it can after a supervisor's restart (`exec_installed`). One set already (by the desktop app or by hand)
/// carries over as it is.
fn bundled_env(st: &Shared) -> Vec<(&'static str, std::ffi::OsString)> {
    let unset = st.meta.release.as_ref().is_some_and(|c| c.bundled_server.is_none());
    if unset && staging::running_from_app(&st.data_dir, &st.exe).is_none() {
        vec![("IA_BUNDLED_SERVER", st.exe.clone().into_os_string())]
    } else {
        vec![]
    }
}

/// What Roll back would exec, and its version (none for the desktop app's own server): the version before this one,
/// or else the bundled server. Only for a server running from `app/`. As the desktop app does, it doesn't go back to a
/// version older than the app's own server (whose version is the app's): a newer package's server takes over from it.
fn rollback_target(state: &Shared) -> Option<(PathBuf, Option<String>)> {
    let current = staging::running_from_app(&state.data_dir, &state.exe)?;
    let app = staging::app_dir(state);
    let installed = staging::read(&app);
    let cfg = state.meta.release.as_ref()?;
    let desktop = cfg.desktop_version.as_deref().and_then(|d| semver::Version::parse(d.trim().trim_start_matches('v')).ok());
    let at_least_the_apps = |p: &str| desktop.as_ref().is_none_or(|d| semver::Version::parse(p).is_ok_and(|p| p >= *d));
    let previous = installed.previous.clone().filter(|p| *p != current && !installed.is_bad(p) && at_least_the_apps(p));
    if let Some(p) = previous {
        if let Some(dir) = staging::version_dir(&app, &p).filter(|d| staging::complete(d)) {
            return Some((dir.join("huntaway"), Some(p)));
        }
    }
    let bundled = PathBuf::from(cfg.bundled_server.as_ref()?);
    bundled.is_file().then_some((bundled, None))
}

/// Mark the running version bad and restart onto the one before it (or the desktop app's own server). When the exec
/// fails, `app/state.json` is put back.
pub fn rollback(state: &Shared) -> ApiResult<()> {
    if state.meta.release.is_none() {
        return Err(ApiError::bad("this server doesn't update from releases (start it with --release-updates OWNER/REPO)"));
    }
    let Some(current) = staging::running_from_app(&state.data_dir, &state.exe) else {
        return Err(ApiError::bad("this server isn't an installed release, so there's nothing to roll back"));
    };
    if rollback_target(state).is_none() {
        return Err(ApiError::bad("there's no earlier version to roll back to"));
    }
    admin::begin(state, move |st| async move {
        let (exe, previous) = rollback_target(&st).context("there's no earlier version to roll back to")?;
        admin::log_line(&st, &format!("Rolling back from {current} to {}", previous.as_deref().unwrap_or("the app's own server")));
        let old = staging::change(&st, |s| rolled_back(s, &current, previous.as_deref()))?;
        let err = admin::restart_into(&st, &exe, &[]).await;
        // Only what the rollback changed is put back: a download may have staged a version meanwhile.
        staging::change(&st, |s| not_rolled_back(s, &old, &current, previous.as_deref()))?;
        Err(err)
    })
}

/// Undo `rolled_back(s, current, previous)` on `s`, which was `old` before it, for the fields it changed and nothing
/// has changed since.
fn not_rolled_back(s: &mut Installed, old: &Installed, current: &str, previous: Option<&str>) {
    if !old.is_bad(current) {
        s.bad.retain(|b| b != current);
    }
    if s.current.as_deref() == previous {
        s.current = old.current.clone();
    }
    if s.previous.is_none() {
        s.previous = old.previous.clone();
    }
    if old.trying.as_deref() == Some(current) && s.trying.is_none() {
        s.trying = old.trying.clone();
    }
}

/// `s` once `current` is rolled back from to `previous` (none for the bundled server, which the desktop app starts
/// when there's no current).
fn rolled_back(s: &mut Installed, current: &str, previous: Option<&str>) {
    if !s.is_bad(current) {
        s.bad.push(current.to_string());
    }
    s.current = previous.map(String::from);
    s.previous = None;
    if s.trying.as_deref() == Some(current) {
        s.trying = None;
    }
}

/// The desktop package for an install `kind` (`pacman`, `appimage`) in release `version`, as
/// electron-builder names it: the pacman package with `platform`'s arch, and the AppImage with
/// AppImage's own (`x86_64`, `arm64`).
fn package_name(kind: &str, version: &str, platform: &str) -> Option<String> {
    match kind {
        "pacman" => Some(format!("huntaway-{version}-{platform}.pacman")),
        "appimage" => {
            let (os, arch) = platform.split_once('-')?;
            let arch = if arch == "x64" { "x86_64" } else { arch };
            Some(format!("huntaway-{version}-{os}-{arch}.AppImage"))
        }
        _ => None,
    }
}

/// The desktop app this server was started by, and whether the latest release has a newer shell
/// (null when no app started it).
fn shell(cfg: &Config, latest: Option<&Latest>) -> Value {
    if cfg.desktop_version.is_none() && cfg.desktop_install.is_none() && cfg.desktop_shell.is_none() {
        return Value::Null;
    }
    let install = cfg.desktop_install.as_deref().unwrap_or("other");
    let (kind, path) = match install.split_once(':') {
        Some((kind, path)) => (kind, Some(path)),
        None => (install, None),
    };
    // Only a newer release's: an app installed from a release the checks don't pick (a prerelease, with them off) would
    // otherwise be offered an older package, which would start its older server on a database the newer one migrated.
    let newer = |l: &Latest| cfg.desktop_version.as_deref().is_none_or(|d| semver::Version::parse(d.trim().trim_start_matches('v')).is_ok_and(|d| l.version > d));
    let outdated = match (latest.filter(|l| newer(l)).and_then(|l| Some(l.manifest.as_ref()?.shell.as_str())), cfg.desktop_shell.as_deref()) {
        (Some(theirs), Some(ours)) => theirs != ours,
        _ => false,
    };
    let package = latest.and_then(|l| {
        let name = package_name(kind, tag_version(&l.release.tag_name), &cfg.platform)?;
        l.release.assets.iter().find(|a| a.name == name)
    });
    json!({
        "version": cfg.desktop_version,
        "install": kind,
        "path": path,
        "outdated": outdated,
        "package": package.map(GhAsset::json),
    })
}

#[cfg(test)]
mod tests;
