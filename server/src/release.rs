//! Updates for release installs (the desktop app's packages, or a server installed from a release
//! tarball): with `--release-updates <OWNER/REPO>`, check that repository's GitHub releases for a
//! newer server, and report what was found in `GET /admin/server` (API 83).

use std::sync::Mutex;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::state::Shared;

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
}

/// A release's `huntaway-<v>-release.json`: which desktop shell it was built with.
#[derive(Deserialize, Clone, Debug, PartialEq)]
struct Manifest {
    #[serde(default)]
    shell: Option<String>,
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

/// What the checks found (in `AppState::release`).
#[derive(Default)]
pub struct Releases {
    last: Mutex<Checked>,
    /// Held for a check, so there's one at a time.
    checking: tokio::sync::Mutex<()>,
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
        Ok((etag, releases, latest, error)) => {
            next.etag = etag;
            next.releases = Some(releases);
            next.latest = latest;
            next.error = error;
        }
        Err(e) => {
            tracing::warn!("checking {} for releases: {e:#}", cfg.repo);
            next.rate_limit_reset = e.downcast_ref::<RateLimited>().and_then(|r| r.reset.clone());
            next.error = Some(format!("{e:#}"));
        }
    }
    *state.release.last.lock().unwrap() = next;
    state.emit(json!({"type": "release_checked"}));
}

type Found = (Option<String>, Vec<GhRelease>, Option<Latest>, Option<String>);

/// The list (fetched again, or the last one on a 304), the release picked from it, and an error
/// that didn't stop the pick (a manifest that couldn't be read).
async fn check_with(state: &Shared, cfg: &Config, last: &Checked) -> Result<Found> {
    let prereleases = prereleases(state)?;
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
    let Some((version, release, asset)) = pick(&releases, &cfg.platform, prereleases) else {
        return Ok((etag, releases, None, None));
    };
    // The manifest only changes with the release, so one read before is kept.
    let manifest_name = format!("huntaway-{}-release.json", tag_version(&release.tag_name));
    let manifest_asset = release.assets.iter().find(|a| a.name == manifest_name);
    let kept = last.latest.as_ref().filter(|l| l.version == version && l.release.tag_name == release.tag_name).and_then(|l| l.manifest.clone());
    let (manifest, error) = match (manifest_asset, kept) {
        (None, _) => (None, None),
        (Some(_), Some(m)) => (Some(m), None),
        (Some(a), None) => match fetch_manifest(a).await {
            Ok(m) => (Some(m), None),
            Err(e) => (None, Some(format!("reading {manifest_name}: {e:#}"))),
        },
    };
    Ok((etag, releases.clone(), Some(Latest { version, release: release.clone(), asset: asset.clone(), manifest }), error))
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
    let res = request(&asset.browser_download_url).send().await?.error_for_status()?;
    Ok(res.json().await?)
}

/// A tag's version text, without the optional `v`.
fn tag_version(tag: &str) -> &str {
    tag.strip_prefix('v').unwrap_or(tag)
}

/// The highest semver release that isn't a draft (nor a prerelease, unless they're included) and
/// has a server tarball for `platform` with a sha256 digest.
fn pick<'a>(releases: &'a [GhRelease], platform: &str, prereleases: bool) -> Option<(semver::Version, &'a GhRelease, &'a GhAsset)> {
    releases
        .iter()
        .filter(|r| !r.draft && (prereleases || !r.prerelease))
        .filter_map(|r| {
            let text = tag_version(&r.tag_name);
            let version = semver::Version::parse(text).ok()?;
            let name = format!("huntaway-server-{text}-{platform}.tar.gz");
            let asset = r.assets.iter().find(|a| a.name == name && a.sha256().is_some())?;
            Some((version, r, asset))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
}

/// The `release` block of `GET /admin/server`, when release updates are on.
pub fn status(state: &Shared) -> Result<Option<Value>> {
    let Some(cfg) = &state.meta.release else { return Ok(None) };
    let prereleases = prereleases(state)?;
    let last = state.release.last.lock().unwrap().clone();
    let running = env!("CARGO_PKG_VERSION");
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
        "latest": latest,
        "prereleases": prereleases,
        "checked_at": last.checked_at,
        "error": last.error,
        "rate_limit_reset": last.rate_limit_reset,
        "shell": shell(cfg, last.latest.as_ref()),
        "bundled_server": cfg.bundled_server,
        // Filled in by the background download and Update.
        "staged": null,
        "download": null,
        "previous": null,
        "bad": [],
    })))
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
    let outdated = match (latest.and_then(|l| l.manifest.as_ref()?.shell.as_deref()), cfg.desktop_shell.as_deref()) {
        (Some(theirs), Some(ours)) => theirs != ours,
        _ => false,
    };
    let ext = match kind {
        "pacman" => Some(".pacman"),
        "appimage" => Some(".AppImage"),
        _ => None,
    };
    let package = ext.and_then(|ext| {
        let l = latest?;
        let name = format!("huntaway-{}-{}{ext}", tag_version(&l.release.tag_name), cfg.platform);
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

    /// A fake GitHub: its releases (with `{base}` in URLs standing for its own address), the ETag
    /// it gives them, and a status to answer with instead.
    #[derive(Default)]
    struct Fake {
        releases: Value,
        etag: String,
        fail: Option<(u16, Vec<(&'static str, String)>)>,
        not_modified: AtomicUsize,
        manifests: AtomicUsize,
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
                        let mut res = (StatusCode::from_u16(*code).unwrap(), axum::Json(json!({"message": "nope"}))).into_response();
                        for (k, v) in hs {
                            res.headers_mut().insert(*k, v.parse().unwrap());
                        }
                        return res;
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
                    f2.lock().unwrap().manifests.fetch_add(1, Ordering::SeqCst);
                    // The stamp is in the name: huntaway-<v>-release.json → shell-<v>.
                    let v = name.trim_start_matches("huntaway-").trim_end_matches("-release.json");
                    axum::Json(json!({"version": v, "shell": format!("shell-{v}"), "electron": "38.0.0"}))
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
                asset(&format!("huntaway-{v}-linux-x64.AppImage"), Some(DIGEST)),
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
            manifest: Some(Manifest { shell: Some("shell-0.2.0".into()) }),
        };
        let s = shell(&cfg, Some(&latest));
        assert_eq!((s["install"].as_str(), s["path"].as_str()), (Some("appimage"), Some("/home/me/Huntaway.AppImage")));
        assert_eq!(s["package"]["name"], "huntaway-0.2.0-linux-x64.AppImage");
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
}
