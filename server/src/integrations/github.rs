//! Adding a project from GitHub (the new project dialog's GitHub tab, API 55): the repositories
//! gh can reach on this host, and cloning one into the profile's clone folder (see
//! db::Profile::clone_dir). Both act as the profile's GitHub account (see gh_mcp::Account), or
//! as gh's active account when it has none.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio::io::AsyncReadExt;

use crate::git::worktree;
use crate::mcp::gh_mcp::{self, GhEnv};

/// How many pages of 100 of the repositories the account owns or collaborates on are listed, most
/// recently pushed first. Its organizations' are searched rather than listed (one can have tens of
/// thousands), but those it has contributed to are listed too.
const PAGES: usize = 3;

/// The GraphQL query for the repositories the account has contributed to lately (commits, pull
/// requests and their reviews, issues), others' (organizations') only.
const CONTRIBUTED: &str = "query=query { viewer { repositoriesContributedTo(first: 100, includeUserRepositories: false, \
contributionTypes: [COMMIT, PULL_REQUEST, PULL_REQUEST_REVIEW, ISSUE, REPOSITORY]) { nodes { nameWithOwner name description isPrivate \
isFork isArchived pushedAt url } } } }";

/// How many repositories a search finds at most.
const SEARCH_RESULTS: usize = 50;

/// How long an account's login and organizations are kept for its searches.
const OWNERS_TTL: Duration = Duration::from_secs(300);

/// How long a clone may take.
const CLONE_TIMEOUT: Duration = Duration::from_secs(3600);

/// How long creating a repository and pushing a folder's commits to it may take.
const CREATE_TIMEOUT: Duration = Duration::from_secs(900);

/// The repositories `account` (gh's active one when None) can clone, for picking one:
/// `{account, repos: [{full_name, name, description, private, fork, archived, pushed_at, url}],
/// error}`, where `account` is who gh acts as. Without `query`, the ones it owns, collaborates on
/// or has contributed to, most recently pushed first. With one, those named like it among the ones
/// it owns and its organizations' (see `search_query`).
pub async fn list(account: Option<&str>, query: Option<&str>) -> Value {
    match find(account, query.map(str::trim).filter(|q| !q.is_empty())).await {
        Ok((login, repos)) => json!({"account": account.unwrap_or(&login), "repos": repos, "error": null}),
        Err(e) => json!({"account": account, "repos": [], "error": e}),
    }
}

async fn find(account: Option<&str>, query: Option<&str>) -> Result<(String, Vec<Value>), String> {
    let env = gh_mcp::account_env(account).await.map_err(|e| format!("{e:#}"))?;
    let env = env.as_ref();
    if let Some(query) = query {
        let owners = owners(account, env).await?;
        let Some(q) = search_query(query, &owners) else { return Ok((owners[0].clone(), vec![])) };
        let args = ["api", "-X", "GET", "search/repositories", "-f", &format!("q={q}"), "-f", &format!("per_page={SEARCH_RESULTS}")];
        let found = gh_json(env, &args).await?;
        return Ok((owners[0].clone(), found["items"].as_array().into_iter().flatten().filter_map(repo).collect()));
    }
    let page = |n: usize| format!("user/repos?affiliation=owner,collaborator&sort=pushed&per_page=100&page={n}");
    let first = page(1);
    let first = ["api", first.as_str()];
    let (user, first, contributed) =
        tokio::join!(gh_json(env, &["api", "user"]), gh_json(env, &first), gh_json(env, &["api", "graphql", "-f", CONTRIBUTED]));
    let login = login(&user?)?;
    let mut list = first?.as_array().cloned().unwrap_or_default();
    for n in 2..=PAGES {
        if list.len() < (n - 1) * 100 {
            break;
        }
        list.extend(gh_json(env, &["api", &page(n)]).await?.as_array().cloned().unwrap_or_default());
    }
    // Without them (an error about one of them, e.g. an organization's SSO), its own are still listed.
    let contributed = contributed.unwrap_or_default();
    let contributed = contributed["data"]["viewer"]["repositoriesContributedTo"]["nodes"].as_array().into_iter().flatten().filter_map(graphql_repo);
    Ok((login, latest_first(list.iter().filter_map(repo).chain(contributed))))
}

/// `repos` without repeats, most recently pushed first.
fn latest_first(repos: impl Iterator<Item = Value>) -> Vec<Value> {
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<Value> = repos.filter(|r| seen.insert(r["full_name"].as_str().unwrap_or_default().to_lowercase())).collect();
    // ISO times, which sort as text; those never pushed to go last.
    out.sort_by(|a, b| b["pushed_at"].as_str().cmp(&a["pushed_at"].as_str()));
    out
}

/// The login `account` acts as, then its organizations: the owners a search looks among. Kept a
/// while (see OWNERS_TTL), as each search would otherwise ask again.
async fn owners(account: Option<&str>, env: Option<&GhEnv>) -> Result<Vec<String>, String> {
    static KNOWN: LazyLock<Mutex<HashMap<String, (Instant, Vec<String>)>>> = LazyLock::new(Default::default);
    let key = account.unwrap_or_default().to_string();
    if let Some((at, owners)) = KNOWN.lock().unwrap().get(&key)
        && at.elapsed() < OWNERS_TTL
    {
        return Ok(owners.clone());
    }
    let (user, orgs) = tokio::join!(gh_json(env, &["api", "user"]), gh_json(env, &["api", "user/orgs?per_page=100"]));
    let mut owners = vec![login(&user?)?];
    // Without them (a token that can't list them), it searches the account's own.
    owners.extend(orgs.unwrap_or_default().as_array().into_iter().flatten().filter_map(|o| o["login"].as_str().map(String::from)));
    KNOWN.lock().unwrap().insert(key, (Instant::now(), owners.clone()));
    Ok(owners)
}

/// The search API's query for repositories whose names are like `text`, among `owners`', or
/// OWNER's for `OWNER/NAME` (all of them for `OWNER/`). None when there's nothing to search for.
fn search_query(text: &str, owners: &[String]) -> Option<String> {
    // Only what logins and repository names are made of, so what's typed adds no qualifiers.
    let words = |s: &str| -> Vec<String> {
        s.split(|c: char| !(c.is_ascii_alphanumeric() || "-_.".contains(c))).filter(|w| !w.is_empty()).map(String::from).collect()
    };
    let (owners, name) = match text.split_once('/') {
        Some((owner, name)) if !words(owner).is_empty() => (words(owner), words(name)),
        Some((_, name)) => (owners.to_vec(), words(name)),
        None => (owners.to_vec(), words(text)),
    };
    if owners.is_empty() || (name.is_empty() && !text.contains('/')) {
        return None;
    }
    let owners: Vec<String> = owners.iter().map(|o| format!("user:{o}")).collect();
    Some(format!("{} in:name fork:true {}", name.join(" "), owners.join(" ")).trim().to_string())
}

/// What the dialog shows of a repository from GitHub's API.
fn repo(r: &Value) -> Option<Value> {
    let full_name = r["full_name"].as_str()?;
    Some(json!({
        "full_name": full_name,
        "name": r["name"].as_str().unwrap_or_else(|| full_name.rsplit('/').next().unwrap_or(full_name)),
        "description": r["description"].as_str(),
        "private": r["private"].as_bool().unwrap_or(false),
        "fork": r["fork"].as_bool().unwrap_or(false),
        "archived": r["archived"].as_bool().unwrap_or(false),
        "pushed_at": r["pushed_at"].as_str(),
        "url": r["html_url"].as_str(),
    }))
}

/// `repo` for a repository from the GraphQL API.
fn graphql_repo(r: &Value) -> Option<Value> {
    repo(&json!({
        "full_name": r["nameWithOwner"], "name": r["name"], "description": r["description"], "private": r["isPrivate"], "fork": r["isFork"],
        "archived": r["isArchived"], "pushed_at": r["pushedAt"], "html_url": r["url"],
    }))
}

fn login(user: &Value) -> Result<String, String> {
    user["login"].as_str().map(String::from).ok_or_else(|| "gh didn't say which GitHub account it's signed in as".into())
}

/// What gh prints as JSON, run as `env`'s account (gh's active one without it), or why it failed.
async fn gh_json(env: Option<&GhEnv>, args: &[&str]) -> Result<Value, String> {
    let mut cmd = tokio::process::Command::new(gh_mcp::gh_program());
    cmd.args(args).env("GH_PROMPT_DISABLED", "1").env("GH_NO_UPDATE_NOTIFIER", "1").stdin(Stdio::null()).kill_on_drop(true);
    if let Some(env) = env {
        env.apply(&mut cmd);
    }
    let out = run(&mut cmd, Duration::from_secs(60)).await?;
    if !out.status.success() {
        return Err(gh_error(&out.stderr));
    }
    serde_json::from_slice(&out.stdout).map_err(|e| format!("couldn't read what gh printed: {e}"))
}

async fn run(cmd: &mut tokio::process::Command, timeout: Duration) -> Result<std::process::Output, String> {
    match tokio::time::timeout(timeout, cmd.output()).await {
        Ok(Ok(out)) => Ok(out),
        Ok(Err(e)) => Err(spawn_error(e)),
        Err(_) => Err(format!("gh took more than {} seconds", timeout.as_secs())),
    }
}

fn spawn_error(e: std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound { "gh isn't installed on this host".into() } else { format!("couldn't run gh: {e}") }
}

/// Runs `cmd` (gh) in a process group of its own, which is killed if it runs over `limit`, so the
/// git it started doesn't carry on: its output, or why it didn't finish.
async fn run_in_group(mut cmd: tokio::process::Command, limit: Duration) -> Result<std::process::Output, String> {
    cmd.process_group(0).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = cmd.spawn().map_err(spawn_error)?;
    // Dropped before `child` is reaped, so its group id can't have been reused.
    let group = worktree::KillGroup(child.id().ok_or("gh exited before it started")? as i32);
    let (mut stdout, mut stderr) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let ran = tokio::time::timeout(limit, async {
        let (_, _, status) = tokio::join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err), child.wait());
        status
    })
    .await;
    match ran {
        Ok(status) => {
            std::mem::forget(group);
            Ok(std::process::Output { status: status.map_err(spawn_error)?, stdout: out, stderr: err })
        }
        Err(_) => {
            drop(group);
            let _ = child.wait().await;
            Err(format!("it was still running after {} minutes, so it was stopped", limit.as_secs() / 60))
        }
    }
}

/// What gh said when it failed: its last few lines, less git's "Cloning into …".
fn gh_error(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with("Cloning into")).collect();
    if lines.is_empty() { "gh failed".into() } else { lines[lines.len().saturating_sub(6)..].join(" ") }
}

/// `OWNER/REPO` (a trailing `.git` dropped), if `s` is one: logins and repository names are
/// letters, digits, `-`, `_` and `.`, and a login doesn't start with the last three, so it's no
/// option to gh.
pub fn check_repo(s: &str) -> Option<String> {
    let s = s.trim();
    let (owner, name) = s.strip_suffix(".git").unwrap_or(s).split_once('/')?;
    let chars = |p: &str| !p.is_empty() && p.len() <= 100 && p.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    let ok = chars(owner) && !owner.starts_with(['-', '_', '.']) && chars(name) && name != "." && name != "..";
    ok.then(|| format!("{owner}/{name}"))
}

/// Holds `dest` for a clone and the project it becomes, so a request for the same folder waits
/// until the one before it is done (and then finds its project). Folders' locks are kept, a few
/// bytes each.
pub async fn reserve(dest: &Path) -> tokio::sync::OwnedMutexGuard<()> {
    static FOLDERS: LazyLock<Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>> = LazyLock::new(Default::default);
    let lock = FOLDERS.lock().unwrap().entry(folder(dest)).or_default().clone();
    lock.lock_owned().await
}

/// The folder `path` (absolute) names, however it's written, as the filesystem would have it once
/// the folders in it that aren't there yet are made (as real folders, the way a clone makes them):
/// each part that's there is resolved (symlinks too), and `..` is the parent of what came before.
/// So it's the same before a clone makes them as after.
pub fn folder(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(name) => {
                out.push(name);
                if let Ok(there) = out.canonicalize() {
                    out = there;
                }
            }
            c => out.push(c),
        }
    }
    out
}

/// Clones `repo` (`OWNER/REPO`) into `dest`, a new or empty folder, as `account` (gh's active one
/// when None) with `gh` (the gh to run), as `gh repo clone` does: over the protocol gh is set up
/// to use for the account's host, with a fork's parent as its `upstream` remote. A clone of `repo`
/// that's there already is kept as it is. Returns whether it cloned. A clone that fails is taken
/// away again, leaving the folder as it was. Hold the folder meanwhile (`reserve`).
pub async fn clone(gh: &str, account: Option<&str>, repo: &str, dest: &Path) -> Result<bool, String> {
    let host = account.and_then(gh_mcp::Account::parse).map_or_else(|| "github.com".to_string(), |a| a.host);
    let existed = dest.exists();
    if existed {
        if is_clone_of(dest, &host, repo).await {
            return Ok(false);
        }
        if !std::fs::read_dir(dest).is_ok_and(|mut d| d.next().is_none()) {
            return Err(format!("{} already exists", dest.display()));
        }
    } else if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("couldn't create {}: {e}", parent.display()))?;
    }
    let env = gh_mcp::account_env(account).await.map_err(|e| format!("{e:#}"))?;
    // The account's own gh config (see GhEnv) clones over HTTPS, so SSH is asked for by URL when
    // that's what gh is set up to use.
    let target = if env.is_some() && git_protocol(&host).await.as_deref() == Some("ssh") {
        format!("git@{host}:{repo}.git")
    } else if host != "github.com" {
        format!("{host}/{repo}")
    } else {
        repo.to_string()
    };
    let mut cmd = tokio::process::Command::new(gh);
    cmd.args(["repo", "clone", &target])
        .arg(dest)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null());
    if let Some(env) = &env {
        env.apply(&mut cmd);
    }
    let (exited, failed) = match run_in_group(cmd, CLONE_TIMEOUT).await {
        Ok(out) if out.status.success() => return Ok(true),
        Ok(out) => (true, gh_error(&out.stderr)),
        Err(e) => (false, e),
    };
    let cloned = is_clone_of(dest, &host, repo).await;
    // gh adds a fork's parent as its `upstream` remote once it's cloned it, which can fail with the
    // clone whole. Git keeps a clone whose checkout failed (to look into), which isn't.
    if cloned && exited && checked_out(dest).await {
        return Ok(true);
    }
    if cloned {
        remove_clone(dest, existed);
    }
    Err(format!("couldn't clone {repo}: {failed}"))
}

/// What `create` made.
#[derive(Debug, PartialEq)]
pub struct Created {
    /// `OWNER/REPO`.
    pub full_name: String,
    /// Whether the folder's commits were pushed to it (a folder without commits has none to push).
    pub pushed: bool,
    /// Why they weren't, when the repository was made but the push failed.
    pub push_error: Option<String>,
}

/// A repository name on GitHub: letters, digits, `-`, `_` and `.`, up to 100 of them.
pub fn check_name(s: &str) -> Option<String> {
    let s = s.trim();
    let ok = !s.is_empty() && s.len() <= 100 && s != "." && s != ".." && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    ok.then(|| s.to_string())
}

/// Creates the GitHub repository `name` (under `owner`, the account's own login by default) as
/// `account` (gh's active one when None) with `gh repo create`, `private` or public, from the
/// folder `dir`: it becomes the repository's `origin`, and the folder's commits are pushed. A
/// folder that isn't a git repository yet is made one (`git init`), and a new folder is made. A
/// failure leaves the folder as it was. Hold the folder meanwhile (`reserve`).
pub async fn create(gh: &str, account: Option<&str>, dir: &Path, owner: Option<&str>, name: &str, private: bool) -> Result<Created, String> {
    let parsed = account.and_then(gh_mcp::Account::parse);
    let host = parsed.as_ref().map_or_else(|| "github.com".to_string(), |a| a.host.clone());
    let owner = owner.map(str::trim).filter(|o| !o.is_empty()).map(str::to_string).or_else(|| parsed.as_ref().map(|a| a.login.clone()));
    if let Some(owner) = &owner
        && check_repo(&format!("{owner}/{name}")).is_none()
    {
        return Err(format!("{owner}/{name} isn't a GitHub repository name"));
    }
    let made_dir = !dir.exists();
    if made_dir {
        std::fs::create_dir_all(dir).map_err(|e| format!("couldn't create {}: {e}", dir.display()))?;
    }
    let undo = |inited: bool| {
        if made_dir {
            let _ = std::fs::remove_dir_all(dir);
        } else if inited {
            let _ = std::fs::remove_dir_all(dir.join(".git"));
        }
    };
    let top = match worktree::git(dir, &["rev-parse", "--show-toplevel"]).await {
        Ok(o) if o.ok => std::fs::canonicalize(o.stdout.trim()).ok(),
        _ => None,
    };
    let is_repo = top.is_some();
    if let Some(top) = &top {
        if Some(top) != std::fs::canonicalize(dir).ok().as_ref() {
            return Err(format!("{} is inside the repository {}: pick its top folder", dir.display(), top.display()));
        }
        if matches!(worktree::git(dir, &["remote", "get-url", "origin"]).await, Ok(o) if o.ok) {
            return Err(format!("{} already has a remote called origin", dir.display()));
        }
    } else {
        match worktree::git(dir, &["init", "-q"]).await {
            Ok(o) if o.ok => {}
            Ok(o) => {
                undo(false);
                return Err(format!("git init failed: {}", o.stderr.trim()));
            }
            Err(e) => {
                undo(false);
                return Err(format!("{e:#}"));
            }
        }
    }
    let env = match gh_mcp::account_env(account).await {
        Ok(env) => env,
        Err(e) => {
            undo(!is_repo);
            return Err(format!("{e:#}"));
        }
    };
    let has_commits = matches!(worktree::git(dir, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).await, Ok(o) if o.ok);
    let mut target = owner.as_ref().map_or_else(|| name.to_string(), |o| format!("{o}/{name}"));
    if host != "github.com" {
        target = format!("{host}/{target}");
    }
    let mut cmd = tokio::process::Command::new(gh);
    cmd.args(["repo", "create", &target, if private { "--private" } else { "--public" }, "--source"])
        .arg(dir)
        .args(["--remote", "origin"])
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .current_dir(dir)
        .stdin(Stdio::null());
    if has_commits {
        cmd.arg("--push");
    }
    if let Some(env) = &env {
        env.apply(&mut cmd);
    }
    let (stdout, failed) = match run_in_group(cmd, CREATE_TIMEOUT).await {
        Ok(out) if out.status.success() => (String::from_utf8_lossy(&out.stdout).to_string(), None),
        Ok(out) => (String::new(), Some(gh_error(&out.stderr))),
        Err(e) => (String::new(), Some(e)),
    };
    // gh makes the repository and adds the remote before it pushes, so a push that fails leaves both.
    let remote = worktree::git(dir, &["remote", "get-url", "origin"]).await.ok().filter(|o| o.ok).map(|o| o.stdout.trim().to_string());
    let from_remote = remote.as_deref().and_then(worktree::remote_repo).map(|(_, r)| r);
    let printed = stdout.lines().rev().find_map(|l| worktree::remote_repo(l.trim()).map(|(_, r)| r));
    let full_name = match (&failed, printed.or(from_remote).or_else(|| owner.as_ref().map(|o| format!("{o}/{name}")))) {
        (None, Some(full_name)) => full_name,
        (Some(_), Some(full_name)) if remote.is_some() => full_name,
        (failed, _) => {
            undo(!is_repo);
            return Err(format!("couldn't create {target}: {}", failed.clone().unwrap_or_else(|| "gh didn't say what it made".into())));
        }
    };
    // The account's own gh config (see GhEnv) adds an HTTPS remote, so SSH is asked for by URL when
    // that's what gh is set up to use.
    if env.is_some() && git_protocol(&host).await.as_deref() == Some("ssh") {
        let _ = worktree::git(dir, &["remote", "set-url", "origin", &format!("git@{host}:{full_name}.git")]).await;
    }
    Ok(Created { full_name, pushed: has_commits && failed.is_none(), push_error: failed.map(|e| format!("couldn't push to {target}: {e}")) })
}

/// Whether the clone in `dir` is checked out whole: HEAD is a commit, and the index and working
/// tree have all of it (a checkout that fails partway leaves files out of them).
async fn checked_out(dir: &Path) -> bool {
    if !matches!(worktree::git(dir, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).await, Ok(o) if o.ok) {
        return false;
    }
    matches!(worktree::git(dir, &["status", "--porcelain", "--untracked-files=no"]).await, Ok(o) if o.ok && o.stdout.trim().is_empty())
}

/// Takes away the clone a failed `gh repo clone` left in `dest`: the folder, or what's in it if it
/// was there (empty) before.
fn remove_clone(dest: &Path, existed: bool) {
    if !existed {
        let _ = std::fs::remove_dir_all(dest);
        return;
    }
    for entry in std::fs::read_dir(dest).into_iter().flatten().flatten() {
        let path = entry.path();
        // A symlink goes itself, rather than what it points to.
        let _ = if entry.file_type().is_ok_and(|t| t.is_dir()) { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) };
    }
}

/// The protocol gh is set up to clone from `host` with (`https` or `ssh`), in its own config.
async fn git_protocol(host: &str) -> Option<String> {
    let mut cmd = tokio::process::Command::new(gh_mcp::gh_program());
    cmd.args(["config", "get", "git_protocol", "--host", host]).stdin(Stdio::null()).kill_on_drop(true);
    let out = run(&mut cmd, Duration::from_secs(10)).await.ok()?;
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|p| out.status.success() && !p.is_empty())
}

/// Whether `dir` is a clone of `repo` on `host`: the top of a git repository with a remote there.
async fn is_clone_of(dir: &Path, host: &str, repo: &str) -> bool {
    let top = match worktree::git(dir, &["rev-parse", "--show-toplevel"]).await {
        Ok(o) if o.ok => std::fs::canonicalize(o.stdout.trim()).ok(),
        _ => None,
    };
    if top.is_none() || top != std::fs::canonicalize(dir).ok() {
        return false;
    }
    let Ok(urls) = worktree::git(dir, &["config", "--get-regexp", r"^remote\..*\.url$"]).await else { return false };
    urls.stdout.lines().filter_map(|l| worktree::remote_repo(l.split_once(' ')?.1.trim())).any(|(h, r)| {
        let host_ok = if host == "github.com" { worktree::is_github_com(&h) } else { h == host };
        host_ok && r.eq_ignore_ascii_case(repo)
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::util::path_str;

    /// A folder (for the caller to remove) with a fake GitHub: `<dir>/gh` is a gh whose `repo clone
    /// o/NAME DIR` clones the repository o/NAME made in it, with GitHub's URL for its remote, as gh
    /// would. `o/checkout-fails`'s checkout fails (a filter it needs fails), `o/upstream-fails`
    /// fails once it's cloned (as gh does when it can't fetch a fork's parent), and `o/slow` takes
    /// a second once it's cloned. Anything else fails.
    pub(crate) fn fake_github() -> PathBuf {
        let dir = crate::testing::temp_dir();
        let git = |args: &[&str]| {
            let ok = std::process::Command::new("git").args(["-c", "user.name=t", "-c", "user.email=t@t"]).args(args).status().unwrap().success();
            assert!(ok, "git {args:?}");
        };
        for name in ["r", "checkout-fails", "upstream-fails", "slow"] {
            let work = dir.join("work").join(name);
            std::fs::create_dir_all(&work).unwrap();
            std::fs::write(work.join("README"), name).unwrap();
            if name == "checkout-fails" {
                std::fs::write(work.join(".gitattributes"), "README filter=broken\n").unwrap();
            }
            let work = path_str(&work);
            git(&["init", "-q", "-b", "main", &work]);
            git(&["-C", &work, "add", "-A"]);
            git(&["-C", &work, "commit", "-qm", "init"]);
            git(&["clone", "-q", "--bare", &work, &path_str(&dir.join(format!("o/{name}.git")))]);
        }
        let gh = format!(
            r#"#!/bin/sh
[ "$1 $2" = "repo clone" ] || exit 99
repo=$3 dir=$4
clone() {{ git -c "url.{}/.insteadOf=git@github.com:" "$@" clone -q "git@github.com:$repo.git" "$dir"; }}
case $repo in
  */checkout-fails) clone -c filter.broken.smudge=false -c filter.broken.required=true; exit $? ;;
esac
clone || exit $?
case $repo in
  */upstream-fails) echo "failed to run git: couldn't fetch upstream" >&2; exit 1 ;;
  */slow) sleep 1 ;;
esac
"#,
            path_str(&dir)
        );
        std::fs::write(dir.join("gh"), gh).unwrap();
        std::fs::set_permissions(dir.join("gh"), std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        dir
    }

    #[test]
    fn a_clone_that_fails_is_taken_away_but_gh_failing_after_a_whole_one_keeps_it() {
        crate::testing::run(async || {
            let github = fake_github();
            let gh = path_str(&github.join("gh"));
            let dest = |name: &str| github.join("clones").join(name);
            assert_eq!(clone(&gh, None, "o/r", &dest("r")).await, Ok(true));
            assert_eq!(std::fs::read_to_string(dest("r").join("README")).unwrap(), "r");
            // A clone that's there already is taken as it is, without cloning.
            assert_eq!(clone("/bin/false", None, "o/r", &dest("r")).await, Ok(false));

            // Git keeps a clone whose checkout failed, which isn't whole: it goes, from a new
            // folder or an empty one, so asking again doesn't find it.
            let err = clone(&gh, None, "o/checkout-fails", &dest("checkout")).await.unwrap_err();
            assert!(err.contains("checkout failed"), "{err}");
            assert!(!dest("checkout").exists());
            std::fs::create_dir_all(dest("empty")).unwrap();
            assert!(clone(&gh, None, "o/checkout-fails", &dest("empty")).await.is_err());
            assert_eq!(std::fs::read_dir(dest("empty")).unwrap().count(), 0, "the empty folder stays, empty");
            let err = clone(&gh, None, "o/checkout-fails", &dest("checkout")).await.unwrap_err();
            assert!(err.contains("checkout failed"), "{err}");

            // gh failing once the clone is whole (a fork's parent it couldn't fetch) leaves it.
            assert_eq!(clone(&gh, None, "o/upstream-fails", &dest("upstream")).await, Ok(true));
            assert_eq!(std::fs::read_to_string(dest("upstream").join("README")).unwrap(), "upstream-fails");
            // And nothing's taken away when gh can't clone it at all.
            assert!(clone(&gh, None, "o/missing", &dest("missing")).await.is_err());
            assert!(clone("/nonexistent/gh", None, "o/r", &dest("no-gh")).await.unwrap_err().contains("isn't installed"));
            std::fs::remove_dir_all(&github).unwrap();
        });
    }

    /// A folder (for the caller to remove) with a fake `gh repo create TARGET --private|--public
    /// --source DIR --remote origin [--push]`, as gh does it: it logs its arguments to `create.log`,
    /// makes the bare repository `bare/NAME.git`, adds a GitHub URL as `origin` to DIR, prints that
    /// URL and, with `--push`, pushes HEAD to it. `fails` can't be created and `push-fails` is made
    /// but can't be pushed to.
    pub(crate) fn fake_gh_create() -> PathBuf {
        let dir = crate::testing::temp_dir();
        let gh = format!(
            r#"#!/bin/sh
[ "$1 $2" = "repo create" ] || exit 99
echo "$*" >> "{base}/create.log"
target=$3 src= push=
shift 3
while [ $# -gt 0 ]; do
  case $1 in
    --source) src=$2; shift ;;
    --push) push=1 ;;
  esac
  shift
done
name=${{target##*/}}
case $target in */*) owner=${{target%/*}} ;; *) owner=me ;; esac
[ "$name" = fails ] && {{ echo "GraphQL: Name already exists on this account (createRepository)" >&2; exit 1; }}
git init -q --bare "{base}/bare/$name.git"
cd "$src" || exit 1
git remote add origin "https://github.com/$owner/$name.git"
echo "https://github.com/$owner/$name"
if [ -n "$push" ]; then
  [ "$name" = push-fails ] && {{ echo "remote: Permission denied" >&2; exit 1; }}
  git -c "url.{base}/bare/$name.git.insteadOf=https://github.com/$owner/$name.git" push -q -u origin HEAD || exit 1
fi
"#,
            base = path_str(&dir)
        );
        std::fs::write(dir.join("gh"), gh).unwrap();
        std::fs::set_permissions(dir.join("gh"), std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        dir
    }

    #[test]
    fn creates_a_repository_for_a_folder() {
        crate::testing::run(async || {
            let fake = fake_gh_create();
            let gh = path_str(&fake.join("gh"));
            let log = || std::fs::read_to_string(fake.join("create.log")).unwrap_or_default();
            let git = |dir: &Path, args: &[&str]| {
                let ok = std::process::Command::new("git").args(["-c", "user.name=t", "-c", "user.email=t@t"]).arg("-C").arg(dir).args(args).status().unwrap().success();
                assert!(ok, "git {args:?}");
            };

            // A folder that isn't there: made a git repository, with the repository private and no push (nothing to push).
            let new = fake.join("projects/new");
            let made = create(&gh, None, &new, Some("o"), "new", true).await.unwrap();
            assert_eq!(made, Created { full_name: "o/new".into(), pushed: false, push_error: None });
            assert!(new.join(".git").exists());
            assert!(log().contains("repo create o/new --private --source"), "{}", log());
            assert!(!log().contains("--push"));
            assert_eq!(worktree::git(&new, &["remote", "get-url", "origin"]).await.unwrap().stdout.trim(), "https://github.com/o/new.git");

            // A repository with commits is pushed, and a public one says so. Without an owner gh picks it.
            let old = fake.join("old");
            std::fs::create_dir_all(&old).unwrap();
            git(&old, &["init", "-q"]);
            std::fs::write(old.join("f"), "x").unwrap();
            git(&old, &["add", "-A"]);
            git(&old, &["commit", "-qm", "init"]);
            let made = create(&gh, None, &old, None, "old", false).await.unwrap();
            assert_eq!(made, Created { full_name: "me/old".into(), pushed: true, push_error: None });
            assert!(log().contains("repo create old --public --source"), "{}", log());
            assert!(log().contains("--push"));
            let pushed = worktree::git(&fake.join("bare/old.git"), &["rev-list", "--all", "--count"]).await.unwrap();
            assert_eq!(pushed.stdout.trim(), "1");

            // A push that fails leaves the repository and the remote, and says so.
            let pf = fake.join("pf");
            std::fs::create_dir_all(&pf).unwrap();
            git(&pf, &["init", "-q"]);
            git(&pf, &["commit", "-q", "--allow-empty", "-m", "init"]);
            let made = create(&gh, None, &pf, Some("o"), "push-fails", true).await.unwrap();
            assert!(!made.pushed && made.push_error.unwrap().contains("Permission denied"));
            assert_eq!(made.full_name, "o/push-fails");

            // A repository gh can't create leaves the folder as it was: a new folder is taken away, and a folder that wasn't a repository isn't one.
            let gone = fake.join("gone/fails");
            let err = create(&gh, None, &gone, Some("o"), "fails", true).await.unwrap_err();
            assert!(err.contains("Name already exists"), "{err}");
            assert!(!gone.exists());
            let plain = fake.join("plain");
            std::fs::create_dir_all(&plain).unwrap();
            std::fs::write(plain.join("f"), "x").unwrap();
            assert!(create(&gh, None, &plain, Some("o"), "fails", true).await.is_err());
            assert!(!plain.join(".git").exists() && plain.join("f").exists());

            // Refused before gh runs: an origin already there, a folder inside a repository, a bad name.
            let before = log();
            let err = create(&gh, None, &old, None, "again", true).await.unwrap_err();
            assert!(err.contains("already has a remote called origin"), "{err}");
            std::fs::create_dir_all(old.join("sub")).unwrap();
            let err = create(&gh, None, &old.join("sub"), None, "sub", true).await.unwrap_err();
            assert!(err.contains("is inside the repository"), "{err}");
            assert!(create(&gh, None, &fake.join("bad"), Some("-o"), "bad", true).await.is_err());
            assert!(!fake.join("bad").exists());
            assert_eq!(log(), before);
            assert!(create("/nonexistent/gh", None, &fake.join("no-gh"), None, "x", true).await.unwrap_err().contains("isn't installed"));
            assert!(!fake.join("no-gh").exists());
            std::fs::remove_dir_all(&fake).unwrap();
        });
    }

    #[test]
    fn repository_names_are_letters_digits_and_a_few_marks() {
        assert_eq!(check_name(" my-repo_1.x "), Some("my-repo_1.x".into()));
        for bad in ["", ".", "..", "a b", "a/b", "é", &"a".repeat(101)] {
            assert_eq!(check_name(bad), None, "{bad}");
        }
    }

    #[test]
    fn repositories_are_owner_and_name() {
        assert_eq!(check_repo(" dire-kiwi/dkcode ").as_deref(), Some("dire-kiwi/dkcode"));
        assert_eq!(check_repo("o/r.git").as_deref(), Some("o/r"));
        assert_eq!(check_repo("octo-org/.github").as_deref(), Some("octo-org/.github"));
        assert_eq!(check_repo("me/my_repo.v2").as_deref(), Some("me/my_repo.v2"));
        for bad in ["", "dkcode", "o/", "/r", "o/r/x", "-o/r", ".o/r", "o/..", "o/.", "o/r x", "o/r;rm", "https://github.com/o/r", "github.com/o/r"] {
            assert_eq!(check_repo(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn searches_the_names_of_the_owners_repositories() {
        let owners = ["me".to_string(), "acme".to_string()];
        assert_eq!(search_query("dk", &owners).as_deref(), Some("dk in:name fork:true user:me user:acme"));
        // What's typed can't add qualifiers of its own.
        assert_eq!(search_query("web app:x \"q\"", &owners).as_deref(), Some("web app x q in:name fork:true user:me user:acme"));
        assert_eq!(search_query("jenkinsci/gitlab", &owners).as_deref(), Some("gitlab in:name fork:true user:jenkinsci"));
        assert_eq!(search_query("jenkinsci/", &owners).as_deref(), Some("in:name fork:true user:jenkinsci"));
        assert_eq!(search_query("/gitlab", &owners).as_deref(), Some("gitlab in:name fork:true user:me user:acme"));
        assert_eq!(search_query("  ", &owners), None);
        assert_eq!(search_query("::", &owners), None);
    }

    #[test]
    fn repositories_are_what_the_dialog_shows() {
        let r = json!({"full_name": "o/r", "name": "r", "description": null, "private": true, "fork": false, "archived": false,
                       "pushed_at": "2026-10-26T23:45:48Z", "html_url": "https://github.com/o/r", "owner": {"login": "o"}});
        assert_eq!(
            repo(&r),
            Some(json!({"full_name": "o/r", "name": "r", "description": null, "private": true, "fork": false, "archived": false,
                        "pushed_at": "2026-10-26T23:45:48Z", "url": "https://github.com/o/r"}))
        );
        assert_eq!(repo(&json!({"name": "r"})), None);
        let node = json!({"nameWithOwner": "o/r", "name": "r", "description": null, "isPrivate": true, "isFork": false, "isArchived": false,
                          "pushedAt": "2026-10-26T23:45:48Z", "url": "https://github.com/o/r"});
        assert_eq!(graphql_repo(&node), repo(&r));
    }

    #[test]
    fn lists_each_repository_once_most_recently_pushed_first() {
        let r = |name: &str, pushed: Option<&str>| json!({"full_name": name, "pushed_at": pushed});
        let list = latest_first([r("me/old", Some("2024-01-01T00:00:00Z")), r("org/new", Some("2026-10-26T00:00:00Z")), r("me/empty", None), r("ORG/new", None)].into_iter());
        let names: Vec<&str> = list.iter().map(|r| r["full_name"].as_str().unwrap()).collect();
        assert_eq!(names, ["org/new", "me/old", "me/empty"]);
    }

    #[test]
    fn gh_errors_end_with_what_it_said_last() {
        assert_eq!(gh_error(b""), "gh failed");
        assert_eq!(gh_error(b"1\n2\n\n3\n4\n5\n6\n7\n"), "2 3 4 5 6 7");
        // Why a clone failed is before git's advice.
        let ssh = b"Cloning into '/tmp/x'...\ngit@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n\n\
                    Please make sure you have the correct access rights\nand the repository exists.\nfailed to run git: exit status 128\n";
        assert_eq!(
            gh_error(ssh),
            "git@github.com: Permission denied (publickey). fatal: Could not read from remote repository. Please make sure you have the correct \
             access rights and the repository exists. failed to run git: exit status 128"
        );
    }

    #[test]
    fn names_a_folder_the_same_before_and_after_it_is_made() {
        let dir = crate::testing::temp_dir();
        std::fs::create_dir_all(dir.join("real")).unwrap();
        std::os::unix::fs::symlink(dir.join("real"), dir.join("alias")).unwrap();
        let dir = dir.canonicalize().unwrap();
        let paths = ["alias/new/r", "alias/new/r/", "real/new/r", "alias/new/x/../r", "alias/../real/new/r", "alias/new/../new/r", "missing/../alias/new/r"];
        let before: Vec<PathBuf> = paths.iter().map(|p| folder(&dir.join(p))).collect();
        std::fs::create_dir_all(dir.join("real/new/r/x")).unwrap();
        std::fs::create_dir_all(dir.join("missing")).unwrap();
        for (p, was) in paths.iter().zip(&before) {
            assert_eq!(*was, dir.join("real/new/r"), "{p} before");
            assert_eq!(folder(&dir.join(p)), dir.join("real/new/r"), "{p} after");
        }
        // `..` after a symlink is its target's parent, as the filesystem has it.
        assert_eq!(folder(&dir.join("alias/../missing")), dir.join("missing"));
        assert_eq!(folder(&dir.join("alias/new/r/../../../elsewhere")), dir.join("elsewhere"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn finds_clones_of_a_repository_by_their_remotes() {
        crate::testing::run(async || {
            let dir = crate::testing::temp_dir();
            let repo = dir.join("r");
            std::fs::create_dir_all(repo.join("sub")).unwrap();
            assert!(!is_clone_of(&repo, "github.com", "o/r").await, "not a repository");
            worktree::git(&repo, &["init", "-q"]).await.unwrap();
            assert!(!is_clone_of(&repo, "github.com", "o/r").await, "no remotes");
            worktree::git(&repo, &["remote", "add", "upstream", "git@github.com:parent/r.git"]).await.unwrap();
            worktree::git(&repo, &["remote", "add", "origin", "https://github.com/O/R.git"]).await.unwrap();
            assert!(is_clone_of(&repo, "github.com", "o/r").await);
            assert!(is_clone_of(&repo, "github.com", "parent/r").await);
            assert!(!is_clone_of(&repo, "github.com", "o/other").await);
            assert!(!is_clone_of(&repo, "ghe.example.com", "o/r").await, "on another host");
            assert!(!is_clone_of(&repo.join("sub"), "github.com", "o/r").await, "a folder inside it");
            std::fs::remove_dir_all(&dir).unwrap();
        });
    }
}
