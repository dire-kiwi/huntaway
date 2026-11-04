//! The GitHub repository a task's pull request goes to (`github`), from its repository's remotes.

use super::*;

/// The GitHub repository a task's pull request goes to: the remote to push to, and the
/// repository's `OWNER/REPO`.
#[derive(Debug, Clone, PartialEq)]
pub struct Github {
    pub remote: String,
    pub repo: String,
}

/// Where a task branched from `base` in `repo` opens its pull request, if that's on GitHub:
/// `base`'s upstream remote, or else `origin` (or the only remote), going by where it pushes to.
pub async fn github(repo: &Path, base: Option<&str>) -> Option<Github> {
    let (remote, url) = push_remote(repo, base).await?;
    let (host, repo) = remote_repo(url.trim())?;
    is_github_com(&ssh_hostname(url.trim(), host).await).then_some(Github { repo, remote })
}

/// The host and `OWNER/REPO` that a task branched from `base` in `repo` pushes to, as `github`
/// picks the remote, on any host.
pub async fn push_repo(repo: &Path, base: Option<&str>) -> Option<(String, String)> {
    let url = push_remote(repo, base).await?.1;
    let (host, repo) = remote_repo(url.trim())?;
    Some((ssh_hostname(url.trim(), host).await, repo))
}

/// The host that an SSH remote's `host` (see `remote_repo`) stands for: an alias's `HostName` in
/// the SSH config, as `ssh -G` has it. Several GitHub accounts are often set up with an alias for
/// each one's key (`git@github-work:o/r.git`). Other remotes' hosts, and those ssh can't look up,
/// are as they are.
async fn ssh_hostname(url: &str, host: String) -> String {
    let ssh = !url.contains("://") || ["ssh://", "git+ssh://", "ssh+git://"].iter().any(|p| url.starts_with(p));
    let alias = !is_github_com(&host) && !host.starts_with('-') && host.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    if !ssh || !alias {
        return host;
    }
    let mut cmd = Command::new("ssh");
    // Tests read their own config, not the user's.
    #[cfg(test)]
    cmd.arg("-F").arg(SSH_CONFIG.with_borrow(|c| c.clone()).unwrap_or_else(|| "/dev/null".into()));
    cmd.args(["-G", "--", &host]).stdin(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true);
    let out = match tokio::time::timeout(Duration::from_secs(5), cmd.output()).await {
        Ok(Ok(out)) if out.status.success() => out,
        _ => return host,
    };
    let name = String::from_utf8_lossy(&out.stdout).lines().find_map(|l| l.strip_prefix("hostname ").map(|h| h.trim().to_ascii_lowercase()));
    name.filter(|h| !h.is_empty()).unwrap_or(host)
}

#[cfg(test)]
thread_local! {
    /// The SSH config `ssh_hostname` reads in this thread's test (none when unset).
    pub(super) static SSH_CONFIG: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

/// The remote `github` picks, and its push URL.
pub(super) async fn push_remote(repo: &Path, base: Option<&str>) -> Option<(String, String)> {
    let remotes = git(repo, &["remote"]).await.ok().filter(|o| o.ok)?.stdout;
    let remotes: Vec<&str> = remotes.lines().map(str::trim).filter(|r| !r.is_empty()).collect();
    let upstream = match base {
        Some(b) => git(repo, &["config", &format!("branch.{b}.remote")]).await.ok().map(|o| o.stdout.trim().to_string()),
        None => None,
    };
    let remote = upstream
        .filter(|r| remotes.contains(&r.as_str()))
        .or_else(|| remotes.contains(&"origin").then(|| "origin".to_string()))
        .or_else(|| (remotes.len() == 1).then(|| remotes[0].to_string()))?;
    let url = git_ok(repo, &["remote", "get-url", "--push", &remote]).await.ok()?;
    Some((remote, url))
}

/// The host (lowercase) and `OWNER/REPO` of a remote URL with a path of that shape, on any host:
/// `git@github.com:o/r.git`, `https://github.com/o/r`, `ssh://git@ssh.github.com:443/o/r.git` and
/// the like.
pub fn remote_repo(url: &str) -> Option<(String, String)> {
    let (host, path) = match url.split_once("://") {
        Some((_, rest)) => rest.split_once('/')?,
        // scp-like `[user@]host:path`; a local path has a slash before any colon.
        None => url.split_once(':').filter(|(host, _)| !host.contains('/'))?,
    };
    let host = host.rsplit('@').next()?.split(':').next()?.to_ascii_lowercase();
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let [owner, name] = path.split('/').collect::<Vec<_>>()[..] else { return None };
    (!owner.is_empty() && !name.is_empty()).then(|| (host, format!("{owner}/{name}")))
}

/// Whether a remote's host is github.com's (its web, or SSH over HTTPS's port).
pub fn is_github_com(host: &str) -> bool {
    ["github.com", "www.github.com", "ssh.github.com"].contains(&host)
}
