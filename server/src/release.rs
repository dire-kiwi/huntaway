//! Updates for release installs (the desktop app's packages, or a server installed from a release
//! tarball): with `--release-updates <OWNER/REPO>`, check that repository's GitHub releases for a
//! newer server, and report what was found in `GET /admin/server` (API 88). A newer release is downloaded into
//! `<data dir>/app/` in the background (see staging.rs), `POST /admin/release/update` restarts onto it, and
//! `POST /admin/release/rollback` goes back to the version before.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::admin;
use crate::staging::{self, Asset, Download, Installed, Start};
use crate::state::{ApiError, ApiResult, Shared};

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
    crate::hub::http().get(url).header("user-agent", concat!("huntaway/", env!("CARGO_PKG_VERSION"))).timeout(Duration::from_secs(30))
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
    let err = admin::restart_into(st, &exe).await;
    staging::change(st, |s| {
        if s.trying.as_deref() == Some(v) {
            s.trying = old.trying;
        }
    })?;
    Err(err)
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
        let err = admin::restart_into(&st, &exe).await;
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
mod tests {
    use super::*;
    use crate::testing;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A status for the fake to answer with instead, and its headers.
    type Failure = Option<(u16, Vec<(&'static str, String)>)>;

    /// A fake GitHub: its releases (with `{base}` in URLs standing for its own address), the ETag
    /// it gives them, and statuses to answer the list and the manifests with instead. The files
    /// in `files` are served as they are, and any other download as a manifest.
    #[derive(Default)]
    struct Fake {
        releases: Value,
        etag: String,
        fail: Failure,
        manifest_fail: Failure,
        not_modified: AtomicUsize,
        manifests: AtomicUsize,
        files: std::collections::HashMap<String, (Vec<u8>, Serve)>,
        downloads: AtomicUsize,
    }

    /// How the fake serves a file.
    #[derive(Clone, Default)]
    enum Serve {
        #[default]
        Whole,
        /// Half of it, then the connection breaks.
        CutOff,
        /// All of it, once the test lets it go.
        Held(Arc<tokio::sync::Notify>),
    }

    async fn serve_file(bytes: Vec<u8>, serve: Serve) -> axum::response::Response {
        use axum::response::IntoResponse;
        let len = bytes.len().to_string();
        match serve {
            Serve::Whole => ([("content-length", len)], bytes).into_response(),
            Serve::Held(go) => {
                go.notified().await;
                ([("content-length", len)], bytes).into_response()
            }
            Serve::CutOff => {
                // Half, and a moment later the error, so the half is sent first.
                let half = bytes[..bytes.len() / 2].to_vec();
                let chunks = futures::stream::unfold(Some(half), |half| async move {
                    match half {
                        Some(half) => Some((Ok(half), None)),
                        None => {
                            tokio::time::sleep(Duration::from_millis(100)).await;
                            Some((Err(std::io::Error::other("cut off")), None))
                        }
                    }
                });
                ([("content-length", len)], axum::body::Body::from_stream(chunks)).into_response()
            }
        }
    }

    fn failure(code: u16, headers: &[(&'static str, String)]) -> axum::response::Response {
        use axum::response::IntoResponse;
        let mut res = (axum::http::StatusCode::from_u16(code).unwrap(), axum::Json(json!({"message": "nope"}))).into_response();
        for (k, v) in headers {
            res.headers_mut().insert(*k, v.parse().unwrap());
        }
        res
    }

    async fn github(fake: Arc<Mutex<Fake>>) -> String {
        use axum::http::{HeaderMap, StatusCode};
        use axum::response::IntoResponse;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (f1, f2, b) = (fake.clone(), fake, base.clone());
        let app = axum::Router::new()
            .route(
                "/repos/o/r/releases",
                axum::routing::get(move |headers: HeaderMap| async move {
                    let f = f1.lock().unwrap();
                    if let Some((code, hs)) = &f.fail {
                        return failure(*code, hs);
                    }
                    if headers.get("if-none-match").and_then(|v| v.to_str().ok()) == Some(f.etag.as_str()) {
                        f.not_modified.fetch_add(1, Ordering::SeqCst);
                        return StatusCode::NOT_MODIFIED.into_response();
                    }
                    let body = f.releases.to_string().replace("{base}", &b);
                    ([("etag", f.etag.clone()), ("content-type", "application/json".into())], body).into_response()
                }),
            )
            .route(
                "/download/{name}",
                axum::routing::get(move |axum::extract::Path(name): axum::extract::Path<String>| async move {
                    let file = {
                        let f = f2.lock().unwrap();
                        let file = f.files.get(&name).cloned();
                        if file.is_some() {
                            f.downloads.fetch_add(1, Ordering::SeqCst);
                        }
                        file
                    };
                    if let Some((bytes, serve)) = file {
                        return serve_file(bytes, serve).await;
                    }
                    let f = f2.lock().unwrap();
                    // (Not the server tarballs the other tests' checks start downloading.)
                    if name.ends_with("-release.json") {
                        f.manifests.fetch_add(1, Ordering::SeqCst);
                    }
                    if let Some((code, hs)) = &f.manifest_fail {
                        return failure(*code, hs);
                    }
                    // The stamp is in the name: huntaway-<v>-release.json → shell-<v>.
                    let v = name.trim_start_matches("huntaway-").trim_end_matches("-release.json");
                    axum::Json(json!({"version": v, "shell": format!("shell-{v}"), "electron": "38.0.0"})).into_response()
                }),
            );
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        base
    }

    const DIGEST: &str = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn asset(name: &str, digest: Option<&str>) -> Value {
        json!({"name": name, "browser_download_url": format!("{{base}}/download/{name}"), "size": 42, "digest": digest})
    }

    /// A release of `tag` with a server tarball for linux-x64, a pacman package and a manifest.
    fn release(tag: &str, prerelease: bool) -> Value {
        let v = tag.trim_start_matches('v');
        json!({
            "tag_name": tag, "draft": false, "prerelease": prerelease, "published_at": "2026-10-01T00:00:00Z",
            "body": format!("notes for {v}"), "html_url": format!("https://github.com/o/r/releases/tag/{tag}"),
            "assets": [
                asset(&format!("huntaway-server-{v}-linux-x64.tar.gz"), Some(DIGEST)),
                asset(&format!("huntaway-server-{v}-mac-arm64.tar.gz"), Some(DIGEST)),
                asset(&format!("huntaway-{v}-linux-x64.pacman"), Some(DIGEST)),
                asset(&format!("huntaway-{v}-linux-x86_64.AppImage"), Some(DIGEST)),
                asset(&format!("huntaway-{v}-release.json"), Some(DIGEST)),
            ],
        })
    }

    fn config(api: &str) -> Config {
        Config {
            repo: "o/r".into(),
            api: api.into(),
            platform: "linux-x64".into(),
            desktop_version: Some("0.1.0".into()),
            desktop_shell: Some("shell-0.2.0".into()),
            desktop_install: Some("pacman".into()),
            bundled_server: Some("/opt/Huntaway/resources/huntaway".into()),
        }
    }

    fn host(cfg: Config) -> Shared {
        let mut meta = testing::meta();
        meta.release = Some(cfg);
        testing::state_with(meta)
    }

    /// A host checking a fake GitHub with these releases.
    async fn setup(releases: Value) -> (Arc<Mutex<Fake>>, Shared) {
        let fake = Arc::new(Mutex::new(Fake { releases, etag: "\"one\"".into(), ..Default::default() }));
        let base = github(fake.clone()).await;
        (fake, host(config(&base)))
    }

    fn release_status(state: &Shared) -> Value {
        status(state).unwrap().unwrap()
    }

    #[test]
    fn picks_the_highest_version_with_a_server_for_this_platform() {
        testing::run(async || {
            let (_, state) = setup(json!([release("v0.1.0", false), release("0.10.0", false), release("v0.2.0", false)])).await;
            check(&state).await;
            let r = release_status(&state);
            assert_eq!(r["error"], Value::Null);
            assert_eq!(r["latest"]["version"], "0.10.0");
            assert_eq!(r["latest"]["notes"], "notes for 0.10.0");
            assert_eq!(r["latest"]["url"], "https://github.com/o/r/releases/tag/0.10.0");
            assert_eq!(r["latest"]["asset"]["name"], "huntaway-server-0.10.0-linux-x64.tar.gz");
            assert_eq!(r["latest"]["asset"]["sha256"], DIGEST.trim_start_matches("sha256:"));
            assert!(r["latest"]["asset"]["url"].as_str().unwrap().ends_with("/download/huntaway-server-0.10.0-linux-x64.tar.gz"));
            assert_eq!(r["latest"]["newer"], true);
            assert_eq!(r["running"], env!("CARGO_PKG_VERSION"));
            assert_eq!(r["shell"]["package"]["name"], "huntaway-0.10.0-linux-x64.pacman");
            assert_eq!((r["staged"].clone(), r["bad"].clone()), (Value::Null, json!([])));
            // In the server's status too.
            assert_eq!(crate::admin::status(&state).await.unwrap()["release"]["latest"]["version"], "0.10.0");
        });
    }

    #[test]
    fn skips_drafts_tags_that_arent_semver_and_assets_without_a_digest() {
        testing::run(async || {
            let mut draft = release("v0.4.0", false);
            draft["draft"] = json!(true);
            let mut undigested = release("v0.3.0", false);
            undigested["assets"][0]["digest"] = Value::Null;
            let mut bad_digest = release("v0.2.5", false);
            bad_digest["assets"][0]["digest"] = json!("md5:abc");
            let other_platform = json!({"tag_name": "v0.2.2", "assets": [asset("huntaway-server-0.2.2-mac-arm64.tar.gz", Some(DIGEST))]});
            let stray = json!({"tag_name": "release/v1", "assets": []});
            let (_, state) = setup(json!([draft, undigested, bad_digest, other_platform, stray, release("v0.2.0", false)])).await;
            check(&state).await;
            assert_eq!(release_status(&state)["latest"]["version"], "0.2.0");
            // With none left, there's no latest, and that isn't an error.
            let (_, state) = setup(json!([json!({"tag_name": "release/v1", "assets": []})])).await;
            check(&state).await;
            let r = release_status(&state);
            assert_eq!((r["latest"].clone(), r["error"].clone()), (Value::Null, Value::Null));
            assert!(r["checked_at"].is_string());
        });
    }

    #[test]
    fn prereleases_count_only_when_the_setting_is_on() {
        testing::run(async || {
            let (_, state) = setup(json!([release("v0.3.0-beta.1", true), release("v0.2.0", false)])).await;
            check(&state).await;
            let r = release_status(&state);
            assert_eq!((r["latest"]["version"].as_str(), r["prereleases"].as_bool()), (Some("0.2.0"), Some(false)));
            crate::db::set_setting(&state.db(), PRERELEASES, Some("true")).unwrap();
            check(&state).await;
            let r = release_status(&state);
            assert_eq!((r["latest"]["version"].as_str(), r["latest"]["prerelease"].as_bool()), (Some("0.3.0-beta.1"), Some(true)));
            assert_eq!(r["prereleases"], true);
        });
    }

    #[test]
    fn a_304_keeps_the_last_list() {
        testing::run(async || {
            let (fake, state) = setup(json!([release("v0.3.0-rc.1", true), release("v0.2.0", false)])).await;
            check(&state).await;
            // GitHub has more now, but says the list hasn't changed: the last one stands.
            fake.lock().unwrap().releases = json!([release("v0.9.0", false)]);
            check(&state).await;
            assert_eq!(fake.lock().unwrap().not_modified.load(Ordering::SeqCst), 1);
            let r = release_status(&state);
            assert_eq!((r["latest"]["version"].as_str(), r["error"].clone()), (Some("0.2.0"), Value::Null));
            // And it's picked from again, for a changed setting.
            crate::db::set_setting(&state.db(), PRERELEASES, Some("true")).unwrap();
            check(&state).await;
            assert_eq!(fake.lock().unwrap().not_modified.load(Ordering::SeqCst), 2);
            assert_eq!(release_status(&state)["latest"]["version"], "0.3.0-rc.1");
            // A new ETag brings the new list.
            fake.lock().unwrap().etag = "\"two\"".into();
            check(&state).await;
            assert_eq!(release_status(&state)["latest"]["version"], "0.9.0");
        });
    }

    #[test]
    fn a_failed_check_keeps_the_last_result() {
        testing::run(async || {
            let (fake, state) = setup(json!([release("v0.2.0", false)])).await;
            check(&state).await;
            fake.lock().unwrap().fail = Some((500, vec![]));
            check(&state).await;
            let r = release_status(&state);
            assert_eq!(r["latest"]["version"], "0.2.0");
            assert_eq!(r["error"], "GitHub answered 500 Internal Server Error: nope");
            assert_eq!(r["rate_limit_reset"], Value::Null);
            // The rate limit says so, with when it resets.
            let limited = vec![("x-ratelimit-remaining", "0".to_string()), ("x-ratelimit-reset", "1793491200".to_string())];
            fake.lock().unwrap().fail = Some((403, limited.clone()));
            check(&state).await;
            let r = release_status(&state);
            assert_eq!(r["latest"]["version"], "0.2.0");
            assert_eq!(r["rate_limit_reset"], "2026-11-01T00:00:00Z");
            assert!(r["error"].as_str().unwrap().contains("rate limit"), "{r}");
            // A 403 that isn't the rate limit is just an error.
            fake.lock().unwrap().fail = Some((403, vec![("x-ratelimit-remaining", "12".to_string())]));
            check(&state).await;
            let r = release_status(&state);
            assert_eq!((r["error"].as_str(), r["rate_limit_reset"].clone()), (Some("GitHub answered 403 Forbidden: nope"), Value::Null));
            // An unreachable API too.
            let state2 = host(config("http://127.0.0.1:1"));
            check(&state2).await;
            let r = release_status(&state2);
            assert_eq!(r["latest"], Value::Null);
            assert!(r["error"].as_str().unwrap().contains("asking http://127.0.0.1:1/repos/o/r/releases"), "{r}");
            // Recovering clears the error.
            fake.lock().unwrap().fail = None;
            check(&state).await;
            assert_eq!(release_status(&state)["error"], Value::Null);
        });
    }

    #[test]
    fn the_manifest_says_whether_the_shell_is_outdated() {
        testing::run(async || {
            // The app's shell is 0.2.0's (see config).
            let (fake, state) = setup(json!([release("v0.2.0", false)])).await;
            check(&state).await;
            let r = release_status(&state);
            assert_eq!(r["shell"]["outdated"], false);
            assert_eq!(r["shell"]["install"], "pacman");
            assert_eq!(r["shell"]["version"], "0.1.0");
            // 0.3.0 has another.
            fake.lock().unwrap().releases = json!([release("v0.3.0", false), release("v0.2.0", false)]);
            fake.lock().unwrap().etag = "\"two\"".into();
            check(&state).await;
            let r = release_status(&state);
            assert_eq!((r["latest"]["version"].as_str(), r["shell"]["outdated"].as_bool()), (Some("0.3.0"), Some(true)));
            assert_eq!(r["shell"]["package"]["name"], "huntaway-0.3.0-linux-x64.pacman");
            // The manifest is read once per release.
            fake.lock().unwrap().etag = "\"three\"".into();
            check(&state).await;
            assert_eq!(fake.lock().unwrap().manifests.load(Ordering::SeqCst), 2);
            // Without a manifest, it can't say.
            let mut bare = release("v0.4.0", false);
            bare["assets"].as_array_mut().unwrap().pop();
            fake.lock().unwrap().releases = json!([bare]);
            fake.lock().unwrap().etag = "\"four\"".into();
            check(&state).await;
            let r = release_status(&state);
            assert_eq!((r["latest"]["version"].as_str(), r["shell"]["outdated"].as_bool()), (Some("0.4.0"), Some(false)));
        });
    }

    #[test]
    fn an_app_newer_than_the_latest_release_isnt_offered_its_package() {
        testing::run(async || {
            // The app was installed from 0.3.0-rc.1, and prereleases are off (as they are by default), so the checks pick
            // 0.2.0, whose shell differs: installing its package would downgrade the app.
            let fake = Arc::new(Mutex::new(Fake { releases: json!([release("v0.2.0", false)]), etag: "\"one\"".into(), ..Default::default() }));
            let base = github(fake.clone()).await;
            let cfg = |v: &str| Config { desktop_version: Some(v.into()), desktop_shell: Some("shell-0.3.0-rc.1".into()), ..config(&base) };
            for (desktop, outdated) in [("0.3.0-rc.1", false), ("0.2.0", false), ("0.2.0-rc.1", true), ("0.1.0", true), ("not a version", false)] {
                let state = host(cfg(desktop));
                check(&state).await;
                let r = release_status(&state);
                assert_eq!((r["latest"]["version"].as_str(), r["shell"]["outdated"].as_bool()), (Some("0.2.0"), Some(outdated)), "app {desktop}");
            }
            // Without the app's version (a server started by hand with the IA_DESKTOP_* it was given), the stamps decide.
            let state = host(Config { desktop_version: None, ..cfg("") });
            check(&state).await;
            assert_eq!(release_status(&state)["shell"]["outdated"], true);
        });
    }

    #[test]
    fn a_manifest_that_cant_be_read_fails_the_check() {
        testing::run(async || {
            // 0.3.0 has a newer shell than the app's (see config).
            let (fake, state) = setup(json!([release("v0.3.0", false)])).await;
            check(&state).await;
            let r = release_status(&state);
            assert_eq!((r["latest"]["version"].as_str(), r["shell"]["outdated"].as_bool()), (Some("0.3.0"), Some(true)));
            state.release.last.lock().unwrap().checked_at = None;
            // 0.4.0's manifest can't be read: what 0.3.0 said stands, with the error.
            fake.lock().unwrap().releases = json!([release("v0.4.0", false), release("v0.3.0", false)]);
            fake.lock().unwrap().etag = "\"two\"".into();
            fake.lock().unwrap().manifest_fail = Some((500, vec![]));
            check(&state).await;
            let r = release_status(&state);
            assert_eq!((r["latest"]["version"].as_str(), r["shell"]["outdated"].as_bool()), (Some("0.3.0"), Some(true)));
            assert_eq!(r["error"], "reading huntaway-0.4.0-release.json: GitHub answered 500 Internal Server Error: nope");
            assert!(r["checked_at"].is_string(), "the attempt is recorded: {r}");
            // Nor one that isn't a manifest.
            fake.lock().unwrap().manifest_fail = Some((200, vec![]));
            check(&state).await;
            let r = release_status(&state);
            assert_eq!(r["latest"]["version"], "0.3.0");
            assert!(r["error"].as_str().unwrap().starts_with("reading huntaway-0.4.0-release.json: "), "{r}");
            // The rate limit on the manifest says when it resets.
            let limited = vec![("x-ratelimit-remaining", "0".to_string()), ("x-ratelimit-reset", "1793491200".to_string())];
            fake.lock().unwrap().manifest_fail = Some((429, limited));
            check(&state).await;
            let r = release_status(&state);
            assert_eq!((r["latest"]["version"].as_str(), r["rate_limit_reset"].as_str()), (Some("0.3.0"), Some("2026-11-01T00:00:00Z")));
            assert!(r["error"].as_str().unwrap().contains("rate limit"), "{r}");
            // Once it can be read, the check goes through (the list is asked for again, not taken from a 304).
            fake.lock().unwrap().manifest_fail = None;
            check(&state).await;
            let r = release_status(&state);
            assert_eq!((r["latest"]["version"].as_str(), r["shell"]["outdated"].as_bool()), (Some("0.4.0"), Some(true)));
            assert_eq!((r["error"].clone(), r["rate_limit_reset"].clone()), (Value::Null, Value::Null));
            assert_eq!(fake.lock().unwrap().not_modified.load(Ordering::SeqCst), 0);
        });
    }

    async fn api(s: &Shared, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
        use tower::ServiceExt;
        let req = axum::http::Request::builder()
            .method(method)
            .uri(path)
            .header("authorization", "Bearer ")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(body.map(|b| b.to_string()).unwrap_or_default()))
            .unwrap();
        let res = crate::api::router(s.clone()).oneshot(req).await.unwrap();
        let status = res.status().as_u16();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    #[test]
    fn the_prerelease_setting_and_check_now_go_through_the_api() {
        testing::run(async || {
            let (fake, state) = setup(json!([release("v0.3.0-beta.1", true), release("v0.2.0", false)])).await;
            let (code, v) = api(&state, "POST", "/api/admin/release/check", None).await;
            assert_eq!(code, 200, "{v}");
            assert_eq!(v["release"]["latest"]["version"], "0.2.0");
            let (_, v) = api(&state, "GET", "/api/settings", None).await;
            assert_eq!(v["release_prereleases"], false);
            for bad in [json!("true"), json!(1)] {
                assert_eq!(api(&state, "PATCH", "/api/settings", Some(json!({"release_prereleases": bad}))).await.0, 400, "{bad}");
            }
            // Turning it on checks again, in the background (from the last list: the ETag is the same).
            let mut events = state.events.subscribe();
            let (code, v) = api(&state, "PATCH", "/api/settings", Some(json!({"release_prereleases": true}))).await;
            assert_eq!((code, v["release_prereleases"].as_bool()), (200, Some(true)));
            while events.recv().await.unwrap()["type"] != "release_checked" {}
            assert_eq!(release_status(&state)["latest"]["version"], "0.3.0-beta.1");
            assert_eq!(fake.lock().unwrap().not_modified.load(Ordering::SeqCst), 1);
            // Setting it to what it is doesn't; null turns it off.
            api(&state, "PATCH", "/api/settings", Some(json!({"release_prereleases": true}))).await;
            let (_, v) = api(&state, "PATCH", "/api/settings", Some(json!({"release_prereleases": null}))).await;
            assert_eq!(v["release_prereleases"], false);
            while events.recv().await.unwrap()["type"] != "release_checked" {}
            assert_eq!(fake.lock().unwrap().not_modified.load(Ordering::SeqCst), 2);
            assert_eq!(release_status(&state)["latest"]["version"], "0.2.0");
            // Without --release-updates there's nothing to check.
            let (code, v) = api(&testing::state(), "POST", "/api/admin/release/check", None).await;
            assert_eq!(code, 400, "{v}");
        });
    }

    #[test]
    fn shell_reports_how_the_app_was_installed() {
        let mut cfg = config("http://unused");
        cfg.desktop_install = Some("appimage:/home/me/Huntaway.AppImage".into());
        let latest = Latest {
            version: semver::Version::new(0, 2, 0),
            release: serde_json::from_value(release("v0.2.0", false)).unwrap(),
            asset: serde_json::from_value(asset("huntaway-server-0.2.0-linux-x64.tar.gz", Some(DIGEST))).unwrap(),
            manifest: Some(Manifest { shell: "shell-0.2.0".into() }),
        };
        let s = shell(&cfg, Some(&latest));
        assert_eq!((s["install"].as_str(), s["path"].as_str()), (Some("appimage"), Some("/home/me/Huntaway.AppImage")));
        assert_eq!(s["package"]["name"], "huntaway-0.2.0-linux-x86_64.AppImage");
        assert_eq!(package_name("appimage", "0.2.0", "linux-arm64").as_deref(), Some("huntaway-0.2.0-linux-arm64.AppImage"));
        assert_eq!(package_name("pacman", "0.2.0", "linux-x64").as_deref(), Some("huntaway-0.2.0-linux-x64.pacman"));
        cfg.desktop_install = Some("mac:/Applications/Huntaway.app".into());
        let s = shell(&cfg, Some(&latest));
        assert_eq!((s["install"].as_str(), s["package"].clone()), (Some("mac"), Value::Null));
        // A server no app started (a tarball install) has no shell.
        let bare = Config { desktop_version: None, desktop_shell: None, desktop_install: None, ..cfg };
        assert_eq!(shell(&bare, Some(&latest)), Value::Null);
    }

    #[test]
    fn repo_must_be_owner_slash_name() {
        assert_eq!(Config::from_env(" dire-kiwi/huntaway ").unwrap().repo, "dire-kiwi/huntaway");
        for bad in ["huntaway", "a/b/c", "/b", "a/", "a b/c"] {
            assert!(Config::from_env(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn off_without_the_flag() {
        testing::run(async || {
            let state = testing::state();
            check(&state).await;
            assert_eq!(status(&state).unwrap(), None);
            assert!(crate::admin::status(&state).await.unwrap().get("release").is_none());
        });
    }

    // ---------- staging, Update and Roll back ----------

    fn sha256_hex(bytes: &[u8]) -> String {
        aws_lc_rs::digest::digest(&aws_lc_rs::digest::SHA256, bytes).as_ref().iter().map(|b| format!("{b:02x}")).collect()
    }

    /// A folder removed when the test ends (see `testing::temp_dir`).
    fn temp_dir() -> PathBuf {
        crate::testing::temp_dir()
    }

    /// A release's files in `dir`: `huntaway` (a script that runs `script`), `ia-shim` and `ui/index.html`.
    fn server_files(dir: &std::path::Path, script: &str) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(dir.join("ui")).unwrap();
        std::fs::write(dir.join("huntaway"), format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(dir.join("huntaway"), std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(dir.join("ia-shim"), "shim").unwrap();
        std::fs::write(dir.join("ui/index.html"), "<html>").unwrap();
    }

    /// A server tarball for `v` as release.yml packs it (`huntaway-server-<v>-linux-x64/…`), whose `huntaway` runs
    /// `script` (by default, prints its version like clap does), with `tar`'s extra arguments for other entries.
    fn tarball(v: &str, script: Option<&str>, extra: &[&str]) -> Vec<u8> {
        let dir = temp_dir();
        let top = format!("huntaway-server-{v}-linux-x64");
        server_files(&dir.join(&top), script.unwrap_or(&format!("echo 'huntaway {v}'")));
        std::fs::write(dir.join("evil"), "outside").unwrap();
        let o = std::process::Command::new("tar").current_dir(&dir).args(["-czPf", "out.tar.gz", &top]).args(extra).output().unwrap();
        assert!(o.status.success(), "tar: {}", String::from_utf8_lossy(&o.stderr));
        std::fs::read(dir.join("out.tar.gz")).unwrap()
    }

    /// A release of `tag` whose linux-x64 server tarball is `bytes`, served the way `serve` says.
    fn served(fake: &Arc<Mutex<Fake>>, tag: &str, bytes: Vec<u8>, serve: Serve) -> Value {
        let mut r = release(tag, false);
        let name = r["assets"][0]["name"].as_str().unwrap().to_string();
        r["assets"][0]["digest"] = json!(format!("sha256:{}", sha256_hex(&bytes)));
        r["assets"][0]["size"] = json!(bytes.len());
        fake.lock().unwrap().files.insert(name, (bytes, serve));
        r
    }

    /// A host checking a fake GitHub that has the releases `make` gives.
    async fn setup_with(make: impl FnOnce(&Arc<Mutex<Fake>>) -> Value) -> (Arc<Mutex<Fake>>, Shared) {
        let (fake, state) = setup(json!([])).await;
        let releases = make(&fake);
        fake.lock().unwrap().releases = releases;
        (fake, state)
    }

    /// Change what the fake lists (with a new ETag, so it's read again).
    fn relist(fake: &Arc<Mutex<Fake>>, releases: Value) {
        let mut f = fake.lock().unwrap();
        f.releases = releases;
        f.etag = format!("\"{}\"", crate::util::new_id());
    }

    /// The download, once it has finished (staged or failed).
    async fn finished(state: &Shared) -> Download {
        let mut rx = state.release.download.subscribe();
        loop {
            if let Some(d) = rx.borrow_and_update().clone().filter(|d| !d.running()) {
                return d;
            }
            rx.changed().await.unwrap();
        }
    }

    /// The names in `app/`, sorted.
    fn app_entries(state: &Shared) -> Vec<String> {
        let Ok(dir) = std::fs::read_dir(staging::app_dir(state)) else { return vec![] };
        let mut names: Vec<String> = dir.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    fn downloads(fake: &Arc<Mutex<Fake>>) -> usize {
        fake.lock().unwrap().downloads.load(Ordering::SeqCst)
    }

    #[test]
    fn a_newer_release_is_staged_in_the_background() {
        testing::run(async || {
            let (fake, state) = setup_with(|f| json!([served(f, "v0.2.0", tarball("0.2.0", None, &[]), Serve::Whole)])).await;
            let mut events = state.events.subscribe();
            check(&state).await;
            let d = finished(&state).await;
            assert_eq!((d.phase.as_str(), d.error.clone()), ("staged", None));
            assert_eq!(Some(d.bytes), d.total);
            let app = staging::app_dir(&state);
            assert!(staging::complete(&app.join("0.2.0")));
            assert_eq!(app_entries(&state), ["0.2.0", "state.json"], "no tarball or .partial is left");
            assert_eq!(staging::read(&app).staged.as_deref(), Some("0.2.0"));
            let r = release_status(&state);
            assert_eq!((r["staged"].as_str(), r["download"].clone()), (Some("0.2.0"), Value::Null));
            // The UI hears how it goes.
            let mut phases = vec![];
            while let Ok(ev) = events.try_recv() {
                if ev["type"] == "release_download" {
                    phases.push(ev["download"]["phase"].as_str().unwrap_or("done").to_string());
                }
            }
            phases.dedup();
            assert_eq!(phases, ["downloading", "verifying", "installing", "done"]);
            // Checking again doesn't download it again.
            check(&state).await;
            assert_eq!(downloads(&fake), 1);
            assert_eq!(release_status(&state)["staged"], "0.2.0");
        });
    }

    /// Stage a release whose tarball is `bytes`, served with `serve`, and expect it to fail with `error`, leaving
    /// nothing in `app/`.
    async fn refused(bytes: Vec<u8>, serve: Serve, digest: Option<&str>, error: &str) -> (Arc<Mutex<Fake>>, Shared) {
        let (fake, state) = setup_with(|f| {
            let mut r = served(f, "v0.2.0", bytes, serve);
            if let Some(d) = digest {
                r["assets"][0]["digest"] = json!(d);
            }
            json!([r])
        })
        .await;
        check(&state).await;
        let d = finished(&state).await;
        assert_eq!(d.phase, "failed");
        assert!(d.error.as_deref().unwrap().contains(error), "{d:?}");
        assert_eq!(app_entries(&state), Vec::<String>::new(), "nothing is left behind");
        assert!(!state.data_dir.join("evil").exists() && !staging::app_dir(&state).join("evil").exists());
        let r = release_status(&state);
        assert_eq!((r["download"]["phase"].as_str(), r["staged"].clone()), (Some("failed"), Value::Null));
        assert_eq!(r["download"]["error"], json!(d.error));
        (fake, state)
    }

    #[test]
    fn a_wrong_digest_leaves_nothing_behind_and_is_tried_again() {
        testing::run(async || {
            let bytes = tarball("0.2.0", None, &[]);
            let (fake, state) = refused(bytes.clone(), Serve::Whole, Some(DIGEST), "has sha256").await;
            // The next check tries again, and the release has the right digest now.
            relist(&fake, json!([served(&fake, "v0.2.0", bytes, Serve::Whole)]));
            check(&state).await;
            assert_eq!(finished(&state).await.phase, "staged");
            assert_eq!(release_status(&state)["staged"], "0.2.0");
        });
    }

    #[test]
    fn a_cut_off_download_leaves_nothing_behind() {
        testing::run(async || {
            refused(tarball("0.2.0", None, &[]), Serve::CutOff, None, "cut off").await;
        });
    }

    #[test]
    fn entries_outside_the_folder_are_refused() {
        testing::run(async || {
            // top/../evil would unpack beside app/0.2.0.partial.
            refused(tarball("0.2.0", None, &["huntaway-server-0.2.0-linux-x64/../evil"]), Serve::Whole, None, "outside its folder").await;
        });
    }

    #[test]
    fn links_are_refused() {
        testing::run(async || {
            let dir = temp_dir();
            let top = "huntaway-server-0.2.0-linux-x64";
            server_files(&dir.join(top), "echo huntaway 0.2.0");
            std::os::unix::fs::symlink("/etc", dir.join(top).join("etc")).unwrap();
            assert!(std::process::Command::new("tar").current_dir(&dir).args(["-czf", "out.tar.gz", top]).status().unwrap().success());
            refused(std::fs::read(dir.join("out.tar.gz")).unwrap(), Serve::Whole, None, "isn't a file or a folder").await;
        });
    }

    #[test]
    fn a_server_that_fails_its_smoke_test_is_refused() {
        testing::run(async || {
            refused(tarball("0.2.0", Some("echo broken >&2; exit 3"), &[]), Serve::Whole, None, "--version failed with exit status: 3: broken").await;
            refused(tarball("0.2.0", Some("echo huntaway 0.1.9"), &[]), Serve::Whole, None, "printed \"huntaway 0.1.9\", not 0.2.0").await;
            // Or that's missing its UI.
            let dir = temp_dir();
            let top = "huntaway-server-0.2.0-linux-x64";
            server_files(&dir.join(top), "echo huntaway 0.2.0");
            std::fs::remove_dir_all(dir.join(top).join("ui")).unwrap();
            assert!(std::process::Command::new("tar").current_dir(&dir).args(["-czf", "out.tar.gz", top]).status().unwrap().success());
            refused(std::fs::read(dir.join("out.tar.gz")).unwrap(), Serve::Whole, None, "doesn't have huntaway, ia-shim and ui/index.html").await;
        });
    }

    #[test]
    fn one_download_at_a_time() {
        testing::run(async || {
            let go = Arc::new(tokio::sync::Notify::new());
            let (fake, state) = setup_with(|f| json!([served(f, "v0.2.0", tarball("0.2.0", None, &[]), Serve::Held(go.clone()))])).await;
            check(&state).await;
            check(&state).await;
            check(&state).await;
            let r = release_status(&state);
            assert_eq!((r["download"]["version"].as_str(), r["download"]["phase"].as_str()), (Some("0.2.0"), Some("downloading")));
            assert_eq!(r["staged"], Value::Null);
            go.notify_one();
            assert_eq!(finished(&state).await.phase, "staged");
            assert_eq!(downloads(&fake), 1);
        });
    }

    #[test]
    fn a_release_found_during_a_download_is_downloaded_after_it() {
        testing::run(async || {
            let go = Arc::new(tokio::sync::Notify::new());
            let (fake, state) = setup_with(|f| json!([served(f, "v0.2.0", tarball("0.2.0", None, &[]), Serve::Held(go.clone()))])).await;
            check(&state).await;
            relist(&fake, json!([served(&fake, "v0.3.0", tarball("0.3.0", None, &[]), Serve::Whole)]));
            check(&state).await;
            assert_eq!(release_status(&state)["download"]["version"], "0.2.0");
            go.notify_one();
            let mut rx = state.release.download.subscribe();
            while rx.borrow_and_update().as_ref().is_none_or(|d| d.version != "0.3.0" || d.running()) {
                rx.changed().await.unwrap();
            }
            assert_eq!(release_status(&state)["staged"], "0.3.0");
            assert_eq!(app_entries(&state), ["0.3.0", "state.json"]);
        });
    }

    // HA-69: a prerelease staged while they were included stayed offered, and installable, after they were turned off.
    #[test]
    fn a_staged_prerelease_is_unstaged_once_prereleases_are_off() {
        testing::run(async || {
            let (_, state) = setup_with(|f| {
                let mut rc = served(f, "v0.3.0-rc.1", tarball("0.3.0-rc.1", None, &[]), Serve::Whole);
                rc["prerelease"] = json!(true);
                json!([rc, served(f, "v0.2.0", tarball("0.2.0", None, &[]), Serve::Whole)])
            })
            .await;
            crate::db::set_setting(&state.db(), PRERELEASES, Some("true")).unwrap();
            check(&state).await;
            assert_eq!(finished(&state).await.version, "0.3.0-rc.1");
            assert_eq!(release_status(&state)["staged"], "0.3.0-rc.1");
            crate::db::set_setting(&state.db(), PRERELEASES, None).unwrap();
            check(&state).await;
            let r = release_status(&state);
            assert_eq!((r["latest"]["version"].as_str(), r["staged"].as_str()), (Some("0.2.0"), None));
            assert!(!staging::app_dir(&state).join("0.3.0-rc.1").exists());
            // The release it does pick is downloaded instead.
            let mut rx = state.release.download.subscribe();
            while rx.borrow_and_update().as_ref().is_none_or(|d| d.version != "0.2.0" || d.running()) {
                rx.changed().await.unwrap();
            }
            assert_eq!(release_status(&state)["staged"], "0.2.0");
            assert_eq!(app_entries(&state), ["0.2.0", "state.json"]);
        });
    }

    /// A prerelease 0.3.0-rc.1 staged with prereleases on, then a stable 0.3.0 served with `serve` (and `digest`, if
    /// given) and prereleases turned off: the check that follows unstages the prerelease, below 0.3.0 as it is.
    async fn prerelease_below_a_newer_stable(serve: Serve, digest: Option<&str>) -> (Arc<Mutex<Fake>>, Shared) {
        let (fake, state) = setup_with(|f| {
            let mut rc = served(f, "v0.3.0-rc.1", tarball("0.3.0-rc.1", None, &[]), Serve::Whole);
            rc["prerelease"] = json!(true);
            json!([rc])
        })
        .await;
        crate::db::set_setting(&state.db(), PRERELEASES, Some("true")).unwrap();
        check(&state).await;
        assert_eq!(finished(&state).await.phase, "staged");
        let mut rc = served(&fake, "v0.3.0-rc.1", tarball("0.3.0-rc.1", None, &[]), Serve::Whole);
        rc["prerelease"] = json!(true);
        let mut stable = served(&fake, "v0.3.0", tarball("0.3.0", None, &[]), serve);
        if let Some(d) = digest {
            stable["assets"][0]["digest"] = json!(d);
        }
        relist(&fake, json!([stable, rc]));
        crate::db::set_setting(&state.db(), PRERELEASES, None).unwrap();
        check(&state).await;
        let r = release_status(&state);
        assert_eq!((r["latest"]["version"].as_str(), r["staged"].as_str()), (Some("0.3.0"), None));
        assert!(!staging::app_dir(&state).join("0.3.0-rc.1").exists());
        let (code, body) = api(&state, "POST", "/api/admin/release/update", Some(json!({"version": "0.3.0-rc.1"}))).await;
        assert_eq!(code, 400, "{body}");
        (fake, state)
    }

    // HA-69 review: a disabled prerelease below a newer stable release stayed offered while that one's download failed.
    #[test]
    fn a_disabled_prerelease_below_a_stable_whose_download_fails_is_unstaged() {
        testing::run(async || {
            let (_, state) = prerelease_below_a_newer_stable(Serve::Whole, Some(&format!("sha256:{}", "0".repeat(64)))).await;
            let d = finished(&state).await;
            assert_eq!((d.version.as_str(), d.phase.as_str()), ("0.3.0", "failed"));
            assert_eq!(release_status(&state)["staged"], Value::Null);
            assert_eq!(app_entries(&state), ["state.json"]);
        });
    }

    #[test]
    fn a_disabled_prerelease_is_unstaged_while_the_stable_one_downloads() {
        testing::run(async || {
            let go = Arc::new(tokio::sync::Notify::new());
            let (_, state) = prerelease_below_a_newer_stable(Serve::Held(go.clone()), None).await;
            assert_eq!(release_status(&state)["download"]["version"], "0.3.0");
            go.notify_one();
            let d = finished(&state).await;
            assert_eq!((d.version.as_str(), d.phase.as_str()), ("0.3.0", "staged"));
            assert_eq!(app_entries(&state), ["0.3.0", "state.json"]);
        });
    }

    // HA-69 review: an Update waiting for a prerelease's download that was then withdrawn downloaded it, and the stable
    // release, over and over, and its job never ended, so no other restart could start.
    #[test]
    fn an_update_waiting_for_a_withdrawn_prerelease_fails() {
        testing::run(async || {
            let go = Arc::new(tokio::sync::Notify::new());
            let (fake, state) = setup_with(|f| {
                let mut rc = served(f, "v0.3.0-rc.1", tarball("0.3.0-rc.1", None, &[]), Serve::Held(go.clone()));
                rc["prerelease"] = json!(true);
                json!([rc, served(f, "v0.2.0", tarball("0.2.0", None, &[]), Serve::Whole)])
            })
            .await;
            crate::db::set_setting(&state.db(), PRERELEASES, Some("true")).unwrap();
            check(&state).await;
            let mut events = state.events.subscribe();
            assert_eq!(api(&state, "POST", "/api/admin/release/update", Some(json!({"version": "0.3.0-rc.1"}))).await.0, 200);
            tokio::task::yield_now().await;
            crate::db::set_setting(&state.db(), PRERELEASES, None).unwrap();
            check(&state).await;
            fake.lock().unwrap().files.values_mut().for_each(|f| f.1 = Serve::Whole);
            go.notify_one();
            let (_, error) = tokio::time::timeout(Duration::from_secs(10), job_fails(&mut events)).await.expect("the Update ends");
            assert!(error.contains("0.3.0-rc.1 isn't offered any more"), "{error}");
            // The release still offered is downloaded, once, and the withdrawn one isn't again.
            let mut rx = state.release.download.subscribe();
            while rx.borrow_and_update().as_ref().is_none_or(|d| d.version != "0.2.0" || d.running()) {
                rx.changed().await.unwrap();
            }
            assert_eq!(downloads(&fake), 2, "the prerelease and 0.2.0, each once");
            assert_eq!(release_status(&state)["staged"], "0.2.0");
            assert_eq!(app_entries(&state), ["0.2.0", "state.json"]);
            // The job is over, so another can start.
            let (code, body) = api(&state, "POST", "/api/admin/release/update", Some(json!({"version": "0.2.0"}))).await;
            assert_eq!(code, 200, "{body}");
            let (phases, _) = job_fails(&mut events).await;
            assert_eq!(phases.last().map(String::as_str), Some("failed"), "not in a test, so its exec fails");
            assert_eq!(downloads(&fake), 2);
        });
    }

    #[test]
    fn an_older_staged_release_stays_offered_while_a_newer_one_downloads() {
        testing::run(async || {
            let (fake, state) = setup_with(|f| json!([served(f, "v0.2.0", tarball("0.2.0", None, &[]), Serve::Whole)])).await;
            check(&state).await;
            assert_eq!(finished(&state).await.phase, "staged");
            let go = Arc::new(tokio::sync::Notify::new());
            let older = served(&fake, "v0.2.0", tarball("0.2.0", None, &[]), Serve::Whole);
            relist(&fake, json!([served(&fake, "v0.3.0", tarball("0.3.0", None, &[]), Serve::Held(go.clone())), older]));
            check(&state).await;
            let r = release_status(&state);
            assert_eq!((r["staged"].as_str(), r["download"]["version"].as_str()), (Some("0.2.0"), Some("0.3.0")));
            go.notify_one();
            assert_eq!(finished(&state).await.phase, "staged");
            assert_eq!(release_status(&state)["staged"], "0.3.0");
        });
    }

    #[test]
    fn a_staged_release_taken_down_is_unstaged_but_not_on_a_failed_check() {
        testing::run(async || {
            let (fake, state) = setup_with(|f| json!([served(f, "v0.2.0", tarball("0.2.0", None, &[]), Serve::Whole)])).await;
            check(&state).await;
            assert_eq!(finished(&state).await.phase, "staged");
            fake.lock().unwrap().fail = Some((500, vec![]));
            check(&state).await;
            assert_eq!(release_status(&state)["staged"], "0.2.0", "a failed check says nothing about the release");
            fake.lock().unwrap().fail = None;
            relist(&fake, json!([]));
            check(&state).await;
            assert_eq!(release_status(&state)["staged"], Value::Null);
            assert_eq!(app_entries(&state), ["state.json"]);
        });
    }

    #[test]
    fn a_newer_release_replaces_an_unused_staged_one() {
        testing::run(async || {
            let (fake, state) = setup_with(|f| json!([served(f, "v0.2.0", tarball("0.2.0", None, &[]), Serve::Whole)])).await;
            check(&state).await;
            assert_eq!(finished(&state).await.phase, "staged");
            let older = served(&fake, "v0.2.0", tarball("0.2.0", None, &[]), Serve::Whole);
            relist(&fake, json!([served(&fake, "v0.3.0", tarball("0.3.0", None, &[]), Serve::Whole), older]));
            check(&state).await;
            let d = finished(&state).await;
            assert_eq!((d.version.as_str(), d.phase.as_str()), ("0.3.0", "staged"));
            assert_eq!(app_entries(&state), ["0.3.0", "state.json"]);
            assert_eq!(release_status(&state)["staged"], "0.3.0");
        });
    }

    #[test]
    fn a_bad_version_isnt_offered_or_staged() {
        testing::run(async || {
            let (fake, state) = setup_with(|f| {
                let newer = served(f, "v0.3.0", tarball("0.3.0", None, &[]), Serve::Whole);
                json!([newer, served(f, "v0.2.0", tarball("0.2.0", None, &[]), Serve::Whole)])
            })
            .await;
            staging::write(&staging::app_dir(&state), &Installed { bad: vec!["0.3.0".into()], ..Default::default() }).unwrap();
            check(&state).await;
            let d = finished(&state).await;
            assert_eq!((d.version.as_str(), d.phase.as_str()), ("0.2.0", "staged"));
            let r = release_status(&state);
            assert_eq!((r["latest"]["version"].as_str(), r["bad"].clone()), (Some("0.2.0"), json!(["0.3.0"])));
            let (code, v) = api(&state, "POST", "/api/admin/release/update", Some(json!({"version": "0.3.0"}))).await;
            assert_eq!(code, 400, "{v}");
            // A newer one is.
            relist(&fake, json!([served(&fake, "v0.3.1", tarball("0.3.1", None, &[]), Serve::Whole)]));
            check(&state).await;
            assert_eq!(finished(&state).await.version, "0.3.1");
            assert_eq!(release_status(&state)["staged"], "0.3.1");
            assert_eq!(downloads(&fake), 2);
        });
    }

    /// A host running from `app/<running>/huntaway` in its own data dir, whose `app/` has these versions.
    fn host_at(cfg: Config, running: Option<&str>, versions: &[&str]) -> Shared {
        let data_dir = temp_dir().canonicalize().unwrap();
        for v in versions.iter().chain(&running) {
            server_files(&data_dir.join("app").join(v), &format!("echo huntaway {v}"));
        }
        let exe = match running {
            Some(v) => data_dir.join("app").join(v).join("huntaway"),
            None => std::env::current_exe().unwrap(),
        };
        let mut meta = testing::meta();
        meta.release = Some(cfg);
        testing::state_at(meta, data_dir, exe)
    }

    #[test]
    fn settling_keeps_current_previous_and_staged() {
        testing::run(async || {
            let state = host_at(config("http://unused"), Some("0.2.0"), &["0.1.0", "0.1.5", "0.3.0"]);
            let app = staging::app_dir(&state);
            std::fs::create_dir_all(app.join("0.4.0.partial")).unwrap();
            std::fs::write(app.join("state.json.123.tmp"), "{").unwrap();
            std::fs::write(app.join("notes.txt"), "the desktop app's").unwrap();
            // An Update from 0.1.0 onto 0.2.0.
            let before = json!({"current": "0.1.0", "previous": "0.1.5", "staged": "0.2.0", "trying": "0.2.0", "bad": ["0.0.9"], "shell": {"x": 1}});
            std::fs::write(app.join("state.json"), before.to_string()).unwrap();
            assert_eq!(staging::settle(&state).unwrap().as_deref(), Some("0.2.0"));
            let after: Value = serde_json::from_slice(&std::fs::read(app.join("state.json")).unwrap()).unwrap();
            assert_eq!(after, json!({"current": "0.2.0", "previous": "0.1.0", "staged": null, "trying": null, "bad": ["0.0.9"], "shell": {"x": 1}}));
            assert_eq!(app_entries(&state), ["0.1.0", "0.2.0", "notes.txt", "state.json"]);
            // A later start (not an Update) keeps previous, and a staged version.
            server_files(&app.join("0.3.0"), "echo huntaway 0.3.0");
            staging::change(&state, |s| s.staged = Some("0.3.0".into())).unwrap();
            staging::settle(&state).unwrap();
            let s = staging::read(&app);
            assert_eq!((s.current.as_deref(), s.previous.as_deref(), s.staged.as_deref()), (Some("0.2.0"), Some("0.1.0"), Some("0.3.0")));
            assert_eq!(app_entries(&state), ["0.1.0", "0.2.0", "0.3.0", "notes.txt", "state.json"]);
            // One staged that isn't newer than what runs (updated past it) is dropped.
            staging::change(&state, |s| s.staged = Some("0.1.5".into())).unwrap();
            server_files(&app.join("0.1.5"), "echo huntaway 0.1.5");
            staging::settle(&state).unwrap();
            assert_eq!(staging::read(&app).staged, None);
            assert_eq!(app_entries(&state), ["0.1.0", "0.2.0", "notes.txt", "state.json"]);
            // A server that isn't running from app/ leaves it alone.
            let other = host_at(config("http://unused"), None, &["0.1.0", "0.2.0"]);
            std::fs::create_dir_all(staging::app_dir(&other).join("0.3.0.partial")).unwrap();
            assert_eq!(staging::settle(&other).unwrap(), None);
            assert_eq!(app_entries(&other), ["0.1.0", "0.2.0", "0.3.0.partial"]);
        });
    }

    #[test]
    fn state_json_round_trips_with_unknown_keys() {
        let app = temp_dir();
        assert_eq!(staging::read(&app), Installed::default());
        let written = json!({"current": "0.2.0", "previous": null, "staged": "0.3.0", "trying": 7, "bad": ["0.2.5", 3], "launches": [1, 2], "x": "y"});
        std::fs::write(app.join("state.json"), written.to_string()).unwrap();
        let mut s = staging::read(&app);
        assert_eq!((s.current.as_deref(), s.staged.as_deref(), s.trying.clone(), s.bad.clone()), (Some("0.2.0"), Some("0.3.0"), None, vec!["0.2.5".to_string()]));
        s.trying = Some("0.3.0".into());
        staging::write(&app, &s).unwrap();
        let back: Value = serde_json::from_slice(&std::fs::read(app.join("state.json")).unwrap()).unwrap();
        assert_eq!(back, json!({"current": "0.2.0", "previous": null, "staged": "0.3.0", "trying": "0.3.0", "bad": ["0.2.5"], "launches": [1, 2], "x": "y"}));
        assert_eq!(std::fs::read_dir(&app).unwrap().count(), 1, "no temp file is left");
        // One that can't be read counts as none.
        std::fs::write(app.join("state.json"), "{not json").unwrap();
        assert_eq!(staging::read(&app), Installed::default());
    }

    /// The restart job's phases until it fails, and its error.
    async fn job_fails(events: &mut tokio::sync::broadcast::Receiver<Value>) -> (Vec<String>, String) {
        let mut phases = vec![];
        loop {
            let ev = events.recv().await.unwrap();
            if ev["type"] == "restart" {
                phases.push(ev["phase"].as_str().unwrap().to_string());
                if ev["phase"] == "failed" {
                    phases.dedup();
                    return (phases, ev["error"].as_str().unwrap().to_string());
                }
            }
        }
    }

    /// state.json as it is when the job execs.
    fn at_exec(state: &Shared) -> Arc<Mutex<Option<Installed>>> {
        let seen = Arc::new(Mutex::new(None));
        let (s, app) = (seen.clone(), staging::app_dir(state));
        testing::when("exec", move || *s.lock().unwrap() = Some(staging::read(&app)));
        seen
    }

    #[test]
    fn update_restarts_onto_a_staged_version() {
        testing::run(async || {
            let (_, state) = setup_with(|f| json!([served(f, "v0.2.0", tarball("0.2.0", None, &[]), Serve::Whole)])).await;
            check(&state).await;
            assert_eq!(finished(&state).await.phase, "staged");
            let seen = at_exec(&state);
            let mut events = state.events.subscribe();
            let (code, v) = api(&state, "POST", "/api/admin/release/update", Some(json!({"version": "0.2.0"}))).await;
            assert_eq!(code, 200, "{v}");
            // One at a time.
            assert_eq!(api(&state, "POST", "/api/admin/release/update", Some(json!({"version": "0.2.0"}))).await.0, 409);
            let (phases, error) = job_fails(&mut events).await;
            assert_eq!(phases, ["restarting", "failed"]);
            let exe = staging::app_dir(&state).join("0.2.0/huntaway");
            assert_eq!(error, format!("failed to exec {}: not in a test", exe.display()));
            assert_eq!(seen.lock().unwrap().as_ref().unwrap().trying.as_deref(), Some("0.2.0"), "trying is set for the exec");
            // It failed, so this server carries on as it was.
            let s = staging::read(&staging::app_dir(&state));
            assert_eq!((s.trying, s.staged.as_deref()), (None, Some("0.2.0")));
        });
    }

    #[test]
    fn update_waits_for_the_background_download() {
        testing::run(async || {
            let go = Arc::new(tokio::sync::Notify::new());
            let (fake, state) = setup_with(|f| json!([served(f, "v0.2.0", tarball("0.2.0", None, &[]), Serve::Held(go.clone()))])).await;
            check(&state).await;
            let seen = at_exec(&state);
            let mut events = state.events.subscribe();
            assert_eq!(api(&state, "POST", "/api/admin/release/update", Some(json!({"version": "0.2.0"}))).await.0, 200);
            go.notify_one();
            let (phases, error) = job_fails(&mut events).await;
            assert_eq!(phases, ["downloading", "verifying", "installing", "restarting", "failed"]);
            assert!(error.ends_with("0.2.0/huntaway: not in a test"), "{error}");
            assert_eq!(seen.lock().unwrap().as_ref().unwrap().trying.as_deref(), Some("0.2.0"));
            assert_eq!(downloads(&fake), 1, "the job didn't start another");
            let log = state.restart.lock().unwrap().clone().unwrap().log;
            assert!(log.contains("Downloading 0.2.0") && log.contains("Checking its sha256"), "{log}");
        });
    }

    #[test]
    fn update_downloads_first_when_the_background_download_failed() {
        testing::run(async || {
            let bytes = tarball("0.2.0", None, &[]);
            let (fake, state) = setup_with(|f| json!([served(f, "v0.2.0", bytes.clone(), Serve::CutOff)])).await;
            check(&state).await;
            assert_eq!(finished(&state).await.phase, "failed");
            // Still cut off: the job fails, and nothing is left.
            let mut events = state.events.subscribe();
            assert_eq!(api(&state, "POST", "/api/admin/release/update", Some(json!({"version": "0.2.0"}))).await.0, 200);
            let (phases, error) = job_fails(&mut events).await;
            assert_eq!(phases, ["downloading", "failed"]);
            assert!(error.contains("cut off"), "{error}");
            assert_eq!(app_entries(&state), Vec::<String>::new());
            // Now it comes through.
            fake.lock().unwrap().files.values_mut().for_each(|f| f.1 = Serve::Whole);
            assert_eq!(api(&state, "POST", "/api/admin/release/update", Some(json!({"version": "v0.2.0"}))).await.0, 200);
            let (phases, error) = job_fails(&mut events).await;
            assert_eq!(phases, ["downloading", "verifying", "installing", "restarting", "failed"]);
            assert!(error.ends_with("not in a test"), "{error}");
            assert_eq!(downloads(&fake), 3);
            assert_eq!(staging::read(&staging::app_dir(&state)).staged.as_deref(), Some("0.2.0"));
        });
    }

    #[test]
    fn update_refuses_what_it_cant_update_to() {
        testing::run(async || {
            let (_, state) = setup_with(|f| json!([served(f, "v0.2.0", tarball("0.2.0", None, &[]), Serve::Whole)])).await;
            let update = async |v: &str| api(&state, "POST", "/api/admin/release/update", Some(json!({"version": v}))).await;
            // Before a check, nothing is known.
            assert_eq!(update("0.2.0").await.0, 400);
            check(&state).await;
            finished(&state).await;
            for (v, why) in [("0.1.0", "isn't older"), ("0.0.1", "isn't older"), ("0.9.0", "isn't the latest"), ("nope", "isn't a version")] {
                let (code, body) = update(v).await;
                assert_eq!(code, 400, "{v}: {body}");
                assert!(body["error"].as_str().unwrap().contains(why), "{v}: {body}");
            }
            let (code, _) = api(&testing::state(), "POST", "/api/admin/release/update", Some(json!({"version": "0.2.0"}))).await;
            assert_eq!(code, 400);
        });
    }

    #[test]
    fn rollback_goes_back_to_the_previous_version() {
        testing::run(async || {
            let state = host_at(config("http://unused"), Some("0.2.0"), &["0.1.5"]);
            let app = staging::app_dir(&state);
            staging::write(&app, &Installed { current: Some("0.2.0".into()), previous: Some("0.1.5".into()), ..Default::default() }).unwrap();
            assert_eq!(release_status(&state)["exe"], crate::util::path_str(&app.join("0.2.0").join("huntaway")));
            assert_eq!(release_status(&state)["rollback_to"], "0.1.5");
            assert_eq!(release_status(&state)["previous"], "0.1.5");
            let seen = at_exec(&state);
            let mut events = state.events.subscribe();
            assert_eq!(api(&state, "POST", "/api/admin/release/rollback", None).await.0, 200);
            let (phases, error) = job_fails(&mut events).await;
            assert_eq!(phases, ["restarting", "failed"]);
            assert_eq!(error, format!("failed to exec {}: not in a test", app.join("0.1.5/huntaway").display()));
            let s = seen.lock().unwrap().clone().unwrap();
            assert_eq!((s.current.as_deref(), s.previous, s.bad), (Some("0.1.5"), None, vec!["0.2.0".to_string()]));
            // The exec failed, so it's as it was.
            let s = staging::read(&app);
            assert_eq!((s.current.as_deref(), s.previous.as_deref(), s.bad.len()), (Some("0.2.0"), Some("0.1.5"), 0));
        });
    }

    #[test]
    fn a_failed_rollback_keeps_what_a_download_staged_meanwhile() {
        testing::run(async || {
            let state = host_at(config("http://unused"), Some("0.2.0"), &["0.1.5", "0.2.5", "0.3.0"]);
            let app = staging::app_dir(&state);
            let before = Installed { current: Some("0.2.0".into()), previous: Some("0.1.5".into()), staged: Some("0.2.5".into()), bad: vec!["0.0.9".into()], ..Default::default() };
            staging::write(&app, &before).unwrap();
            // A download finishes while the rollback waits to exec: it stages 0.3.0 in place of 0.2.5, as stage_into does.
            let st = state.clone();
            testing::when("exec", move || {
                staging::change(&st, |s| s.staged = Some("0.3.0".into())).unwrap();
                std::fs::remove_dir_all(staging::app_dir(&st).join("0.2.5")).unwrap();
            });
            let mut events = state.events.subscribe();
            assert_eq!(api(&state, "POST", "/api/admin/release/rollback", None).await.0, 200);
            let (_, error) = job_fails(&mut events).await;
            assert!(error.ends_with("0.1.5/huntaway: not in a test"), "{error}");
            // What the rollback changed is put back, and what the download did stands.
            assert_eq!(staging::read(&app), Installed { staged: Some("0.3.0".into()), ..before });
            assert_eq!(release_status(&state)["staged"], "0.3.0");
        });
    }

    #[test]
    fn a_bad_staged_version_isnt_offered_and_is_pruned() {
        testing::run(async || {
            // An Update onto 0.3.0 didn't start: the desktop app marked it bad and started 0.2.0 again.
            let state = host_at(config("http://unused"), Some("0.2.0"), &["0.1.5", "0.3.0"]);
            let app = staging::app_dir(&state);
            let s = Installed { current: Some("0.2.0".into()), previous: Some("0.1.5".into()), staged: Some("0.3.0".into()), bad: vec!["0.3.0".into()], ..Default::default() };
            staging::write(&app, &s).unwrap();
            assert_eq!(release_status(&state)["staged"], Value::Null);
            assert!(!staging::is_staged(&state, "0.3.0"));
            staging::settle(&state).unwrap();
            let s = staging::read(&app);
            assert_eq!((s.staged, s.bad), (None, vec!["0.3.0".to_string()]));
            assert_eq!(app_entries(&state), ["0.1.5", "0.2.0", "state.json"]);
            assert_eq!(release_status(&state)["staged"], Value::Null);
        });
    }

    #[test]
    fn a_newer_packages_server_takes_over_from_the_versions_downloaded_before_it() {
        testing::run(async || {
            let bundled = temp_dir().join("huntaway");
            std::fs::write(&bundled, "").unwrap();
            // This server is the app's own, from a package newer than what was downloaded before it: package 0.0.0-a
            // updated to 0.0.0-old, then this package was installed, so the desktop app starts its own server.
            let cfg = Config { desktop_version: Some(env!("CARGO_PKG_VERSION").into()), bundled_server: Some(crate::util::path_str(&bundled)), ..config("http://unused") };
            let state = host_at(cfg.clone(), None, &["0.0.0-a", "0.0.0-old"]);
            let app = staging::app_dir(&state);
            let bad = vec!["0.0.0-b".to_string()];
            staging::write(&app, &Installed { current: Some("0.0.0-old".into()), previous: Some("0.0.0-a".into()), bad: bad.clone(), ..Default::default() }).unwrap();
            staging::settle(&state).unwrap();
            let s = staging::read(&app);
            assert_eq!((s.current, s.previous, s.bad), (None, None, bad));
            // So an Update from it to 9.0.0 rolls back to this server, not to the download it took over from.
            server_files(&app.join("9.0.0"), "echo huntaway 9.0.0");
            staging::change(&state, |s| s.trying = Some("9.0.0".into())).unwrap();
            let mut meta = testing::meta();
            meta.release = Some(cfg);
            let updated = testing::state_at(meta, state.data_dir.clone(), app.join("9.0.0/huntaway"));
            staging::settle(&updated).unwrap();
            let s = staging::read(&app);
            assert_eq!((s.current.as_deref(), s.previous.as_deref(), s.trying), (Some("9.0.0"), None, None));
            assert_eq!(release_status(&updated)["rollback_to"], "bundled");
        });
    }

    #[test]
    fn rollback_doesnt_go_back_past_the_apps_own_server() {
        testing::run(async || {
            // app/state.json says 0.2.0 was before 0.5.0, but the app is 0.4.0: it starts its own server over 0.2.0.
            let bundled = temp_dir().join("huntaway");
            std::fs::write(&bundled, "").unwrap();
            let cfg = Config { desktop_version: Some("0.4.0".into()), bundled_server: Some(crate::util::path_str(&bundled)), ..config("http://unused") };
            let state = host_at(cfg.clone(), Some("0.5.0"), &["0.2.0", "0.4.5"]);
            let app = staging::app_dir(&state);
            staging::write(&app, &Installed { current: Some("0.5.0".into()), previous: Some("0.2.0".into()), ..Default::default() }).unwrap();
            assert_eq!(release_status(&state)["rollback_to"], "bundled");
            // One at least as new as the app's still counts.
            staging::write(&app, &Installed { current: Some("0.5.0".into()), previous: Some("0.4.5".into()), ..Default::default() }).unwrap();
            assert_eq!(release_status(&state)["rollback_to"], "0.4.5");
            // Without a bundled server to go back to, there's nothing.
            let state = host_at(Config { bundled_server: None, ..cfg }, Some("0.5.0"), &["0.2.0"]);
            staging::write(&staging::app_dir(&state), &Installed { current: Some("0.5.0".into()), previous: Some("0.2.0".into()), ..Default::default() }).unwrap();
            assert_eq!(release_status(&state)["rollback_to"], Value::Null);
        });
    }

    #[test]
    fn rollback_without_a_previous_version_starts_the_bundled_server() {
        testing::run(async || {
            let bundled = temp_dir().join("huntaway");
            std::fs::write(&bundled, "").unwrap();
            let mut cfg = config("http://unused");
            cfg.bundled_server = Some(crate::util::path_str(&bundled));
            let state = host_at(cfg, Some("0.2.0"), &[]);
            let app = staging::app_dir(&state);
            // A previous version that's bad, or missing its files, doesn't count.
            staging::write(&app, &Installed { current: Some("0.2.0".into()), previous: Some("0.1.5".into()), ..Default::default() }).unwrap();
            assert_eq!(release_status(&state)["rollback_to"], "bundled");
            let seen = at_exec(&state);
            let mut events = state.events.subscribe();
            assert_eq!(api(&state, "POST", "/api/admin/release/rollback", None).await.0, 200);
            let (_, error) = job_fails(&mut events).await;
            assert_eq!(error, format!("failed to exec {}: not in a test", bundled.display()));
            let s = seen.lock().unwrap().clone().unwrap();
            assert_eq!((s.current, s.bad), (None, vec!["0.2.0".to_string()]));
            // Without a bundled server either, there's nothing to roll back to.
            let state = host_at(Config { bundled_server: None, ..config("http://unused") }, Some("0.2.0"), &[]);
            assert_eq!(release_status(&state)["rollback_to"], Value::Null);
            assert_eq!(api(&state, "POST", "/api/admin/release/rollback", None).await.0, 400);
            // Nor for a server that isn't running from app/.
            let state = host_at(config("http://unused"), None, &["0.1.5"]);
            assert_eq!(api(&state, "POST", "/api/admin/release/rollback", None).await.0, 400);
        });
    }
}
