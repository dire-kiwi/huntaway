//! Running gh as one account and no other (`GhEnv`), `huntaway gh-run`, authenticated git fetches,
//! and the accounts gh is signed in to.

use super::*;

#[cfg(test)]
thread_local! {
    pub(crate) static TEST_GH_PROGRAM: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
    /// The board's `BOARD_ENV`, in place of the environment's.
    pub(super) static TEST_BOARD: std::cell::RefCell<Option<[String; 3]>> = const { std::cell::RefCell::new(None) };
}

/// The gh to run: `IA_GH_BIN` (for `gh-run`, which is `gh` on its commands' PATH), or else `gh`.
pub(crate) fn gh_program() -> String {
    #[cfg(test)]
    if let Some(program) = TEST_GH_PROGRAM.with_borrow(Clone::clone) { return program }
    std::env::var("IA_GH_BIN").ok().filter(|b| !b.is_empty()).unwrap_or_else(|| "gh".into())
}

/// The host of a URL (`https://`, `ssh://`, …).
pub(super) fn url_host(s: &str) -> Option<String> {
    let s = s.trim().to_ascii_lowercase();
    let (scheme, rest) = s.split_once("://")?;
    if scheme.is_empty() || !scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c)) {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next()?;
    Some(authority.rsplit('@').next()?.split(':').next()?.to_string())
}

/// Every URL `remote` (a remote's name) pushes to in `dir`, with git's URL rewrites
/// (`pushInsteadOf`, `insteadOf`) applied. None if there's no such remote.
pub(super) async fn push_urls(dir: Option<&std::path::Path>, remote: &str) -> Option<Vec<String>> {
    let mut cmd = tokio::process::Command::new("git");
    cmd.args(["remote", "get-url", "--push", "--all", "--", remote]).stdin(Stdio::null());
    if let Some(d) = dir {
        cmd.current_dir(d);
    }
    let out = cmd.output().await.ok()?;
    let urls: Vec<String> = String::from_utf8_lossy(&out.stdout).lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
    (out.status.success() && !urls.is_empty()).then_some(urls)
}

/// git's `-c` options that empty every `http.extraHeader` (generic, and scoped to a URL or path)
/// configured where `dir` pushes from, so no `Authorization` header pushes as another account
/// instead of the credential helper's (see `Account::git_config`). An empty value clears the
/// headers set before it for its own key only, so each key that's set is cleared.
pub(super) async fn extra_header_resets(dir: Option<&std::path::Path>) -> Vec<String> {
    let mut cmd = tokio::process::Command::new("git");
    cmd.args(["config", "--get-regexp", r"^http\..*extraheader$"]).stdin(Stdio::null());
    if let Some(d) = dir {
        cmd.current_dir(d);
    }
    let out = cmd.output().await.map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
    let mut keys: Vec<&str> = out.lines().filter_map(|l| l.split(' ').next()).filter(|k| !k.is_empty()).collect();
    keys.push("http.extraheader");
    keys.sort();
    keys.dedup();
    keys.into_iter().flat_map(|k| ["-c".to_string(), format!("{k}=")]).collect()
}

/// The environment for gh to act as one account and no other. gh's config is a folder of its own
/// (GH_CONFIG_DIR, removed when this is dropped) with a login for the account's host only, so gh
/// has no token for any other host, whatever a command names: unlike GH_ENTERPRISE_TOKEN, which
/// gh sends to every host but github.com. There are no tokens in the environment, the keyring is
/// out of reach on Linux (gh looks there for hosts it has no login for: the Secret Service, over
/// the session bus), and GH_HOST is the account's host, so calls that don't name a host go there
/// and gh refuses a repository whose remotes are elsewhere.
#[derive(Debug)]
pub struct GhEnv {
    pub(super) account: Account,
    pub(super) dir: std::path::PathBuf,
}

impl Drop for GhEnv {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Where gh (and the GitHub tools it follows) may find tokens in the environment.
pub(super) const TOKEN_VARS: &[&str] = &["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];

impl GhEnv {
    /// Set up `cmd`, a gh command, to run as the account. Check its targets first (`check`), and
    /// set GH_REPO after this if it has one (an inherited one is removed).
    pub fn apply(&self, cmd: &mut tokio::process::Command) {
        for v in TOKEN_VARS.iter().chain(&["GH_REPO"]) {
            cmd.env_remove(v);
        }
        cmd.env("GH_CONFIG_DIR", &self.dir).env("GH_HOST", &self.account.host);
        if cfg!(target_os = "linux") {
            cmd.env("DBUS_SESSION_BUS_ADDRESS", "disabled:");
        }
    }

    /// Fails if gh with these arguments (and `GH_REPO`) would reach another host than the
    /// account's (see `Account::check_targets`).
    pub fn check(&self, args: &[&str], repo: Option<&str>) -> Result<()> {
        self.account.check_targets(args, repo)
    }

    /// The environment for a shell command (a wait's) whose gh calls act as the account. The
    /// shell doesn't get the token: `gh` on its PATH is a script in `shim_dir` that runs `exe
    /// gh-run`, which checks each call's targets as the gh tools do and runs gh with the token.
    pub fn shell_env(&self, exe: &std::path::Path, shim_dir: &std::path::Path) -> Result<Vec<(&'static str, String)>> {
        let path = std::env::var_os("PATH").unwrap_or_default();
        let real = std::env::split_paths(&path).filter(|d| d != shim_dir).map(|d| d.join("gh")).find(|g| g.is_file()).context("gh isn't installed")?;
        std::fs::create_dir_all(shim_dir)?;
        let shim = shim_dir.join("gh");
        let script = format!("#!/bin/sh\nexec '{}' gh-run \"$@\"\n", crate::util::path_str(exe).replace('\'', r"'\''"));
        if std::fs::read_to_string(&shim).ok().as_deref() != Some(script.as_str()) {
            // Written aside and renamed, so a command running it never sees half of it.
            let tmp = shim_dir.join(format!(".gh-{}", crate::util::new_id()));
            std::fs::write(&tmp, &script)?;
            std::fs::set_permissions(&tmp, std::os::unix::fs::PermissionsExt::from_mode(0o755))?;
            std::fs::rename(&tmp, &shim)?;
        }
        let mut dirs = vec![shim_dir.to_path_buf()];
        dirs.extend(std::env::split_paths(&path).filter(|d| d != shim_dir));
        Ok(vec![
            ("PATH", crate::util::path_str(std::path::Path::new(&std::env::join_paths(dirs)?))),
            (ACCOUNT_ENV, self.account.to_string()),
            ("IA_GH_BIN", crate::util::path_str(&real)),
        ])
    }
}

/// `huntaway gh-run <args>`: gh in a wait's command, for a task with a GitHub account (see
/// `GhEnv::shell_env`). Refuses calls that would reach another host, and runs the rest with the
/// account's token. Returns gh's exit code.
pub async fn gh_run(args: Vec<String>) -> Result<i32> {
    let account = Account::from_env().with_context(|| format!("{ACCOUNT_ENV} isn't set"))?;
    let repo = std::env::var("GH_REPO").ok().filter(|r| !r.is_empty());
    refuse(&args)?;
    account.check_targets(&args, repo.as_deref())?;
    let env = account.env(&account.token().await?)?;
    let mut cmd = tokio::process::Command::new(gh_program());
    cmd.args(&args);
    env.apply(&mut cmd);
    if let Some(r) = repo {
        cmd.env("GH_REPO", r);
    }
    Ok(cmd.status().await.context("couldn't run gh")?.code().unwrap_or(1))
}

/// The environment that makes gh act as `account` (a profile's or project's, see `Account`), for
/// the host's own gh calls. Fails when that account isn't signed in to gh.
pub async fn account_env(account: Option<&str>) -> Result<Option<GhEnv>> {
    let Some(a) = account.and_then(Account::parse) else { return Ok(None) };
    Ok(Some(a.env(&a.token().await?)?))
}

/// Give a host-side fetch the selected account's credentials for HTTPS on its host. Resolve
/// insteadOf rewrites first; SSH, local repositories and other hosts keep git's usual auth.
/// No repository or global config is written, and a missing login never falls back to another.
pub async fn authenticate_fetch(cmd: &mut tokio::process::Command, repo: &std::path::Path, remote: &str, account: Option<&str>) -> Result<()> {
    let Some(account) = account.and_then(Account::parse) else { return Ok(()) };
    let out = crate::git::worktree::git(repo, &["remote", "get-url", "--", remote]).await?;
    if !out.ok { bail!("couldn't read the fetch URL for {remote}: {}", out.stderr.trim()) }
    let url = out.stdout.trim();
    if !url.to_ascii_lowercase().starts_with("https://") || url_host(url).as_deref() != Some(account.host.as_str()) {
        return Ok(());
    }
    account.check_git_urls(&[url.to_string()])?;
    let token = account.token().await?;
    cmd.args(extra_header_resets(Some(repo)).await).args(account.git_config()).env("IA_GH_GIT_TOKEN", token);
    Ok(())
}

/// The accounts gh is signed in to on this host, for picking one: `{accounts: [{account, host,
/// login, active, ok}], error}`. `account` is what a profile or project saves.
pub async fn accounts() -> Value {
    let out = tokio::process::Command::new(gh_program())
        .args(["auth", "status", "--json=hosts"])
        .env("GH_PROMPT_DISABLED", "1")
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output();
    let out = match tokio::time::timeout(Duration::from_secs(30), out).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => return json!({"accounts": [], "error": format!("couldn't run gh: {e}")}),
        Err(_) => return json!({"accounts": [], "error": "gh auth status timed out"}),
    };
    match serde_json::from_slice::<Value>(&out.stdout) {
        Ok(v) if out.status.success() => json!({"accounts": accounts_from_status(&v), "error": null}),
        _ => json!({"accounts": [], "error": format!("gh auth status failed: {}", String::from_utf8_lossy(&out.stderr).trim())}),
    }
}

pub(super) fn accounts_from_status(v: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    for (host, list) in v["hosts"].as_object().into_iter().flatten() {
        for a in list.as_array().into_iter().flatten() {
            let Some(account) = a["login"].as_str().and_then(|l| Account::parse(&format!("{host}/{l}"))) else { continue };
            out.push(json!({
                "account": account.to_string(),
                "host": account.host,
                "login": account.login,
                "active": a["active"] == true,
                "ok": a["state"] == "success",
            }));
        }
    }
    out
}
