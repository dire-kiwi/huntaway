//! The branch a base branch follows, fetching it, and where a new task branch starts from it
//! (`start_point`, `compare_ref`).

use super::*;

/// The branch a base branch follows.
pub(super) struct Upstream {
    pub(super) remote: String,
    /// Its ref on the remote (`refs/heads/master`).
    pub(super) merge: String,
    /// Where it's fetched to (`refs/remotes/origin/master`), or a local branch for an upstream
    /// in the repository itself (remote `.`).
    pub(super) tracking: String,
}

impl Upstream {
    /// Its short name, e.g. `origin/master`.
    pub(super) fn name(&self) -> &str {
        self.tracking.strip_prefix("refs/remotes/").or_else(|| self.tracking.strip_prefix("refs/heads/")).unwrap_or(&self.tracking)
    }
}

/// The branch base branch `base` follows: its upstream or, for one without (pushed without `-u`,
/// say, or only on the remote), the branch of the same name on `origin` (or the only remote),
/// if that was fetched before or there's no local branch. A remote's branch named with it
/// (`upstream/feature`, with no local branch of that name) is that branch on that remote, fetched
/// or not. None for a tag, a commit or `HEAD`.
pub(super) async fn upstream(repo: &Path, base: &str) -> Option<Upstream> {
    let local = format!("refs/heads/{base}");
    let has_local = commit(repo, &local).await.is_some();
    if !has_local && let Some((remote, name)) = remote_branch(repo, base).await {
        let merge = format!("refs/heads/{name}");
        return Some(Upstream { tracking: format!("refs/remotes/{base}"), remote, merge });
    }
    if has_local {
        let config = |key: &str| {
            let key = format!("branch.{base}.{key}");
            async move { git(repo, &["config", &key]).await.map(|o| o.stdout.trim().to_string()).unwrap_or_default() }
        };
        let (remote, merge) = (config("remote").await, config("merge").await);
        if !remote.is_empty() && !merge.is_empty() {
            let tracking = git_ok(repo, &["for-each-ref", "--format=%(upstream)", &local]).await.ok()?.trim().to_string();
            return (!tracking.is_empty()).then_some(Upstream { remote, merge, tracking });
        }
    } else if base == "HEAD" || commit(repo, base).await.is_some() {
        return None;
    }
    let remotes = git_ok(repo, &["remote"]).await.ok()?;
    let remotes: Vec<&str> = remotes.lines().map(str::trim).filter(|r| !r.is_empty()).collect();
    let remote = if remotes.contains(&"origin") { "origin" } else { remotes.iter().copied().find(|_| remotes.len() == 1)? };
    let tracking = format!("refs/remotes/{remote}/{base}");
    if has_local && commit(repo, &tracking).await.is_none() {
        return None;
    }
    Some(Upstream { remote: remote.to_string(), merge: local, tracking })
}

/// The remote and branch `name` stands for when it's a remote's name, a slash and a branch.
pub(super) async fn remote_branch(repo: &Path, name: &str) -> Option<(String, String)> {
    let (remote, rest) = name.split_once('/').filter(|(r, rest)| !r.is_empty() && !rest.is_empty())?;
    let remotes = git_ok(repo, &["remote"]).await.ok()?;
    remotes.lines().any(|l| l.trim() == remote).then(|| (remote.to_string(), rest.to_string()))
}

/// Fetch `up` (unless it's in the repository itself).
pub(super) async fn fetch(repo: &Path, up: &Upstream, account: Option<&str>) -> Result<()> {
    if up.remote == "." {
        return Ok(());
    }
    let refspec = format!("+{}:{}", up.merge, up.tracking);
    let run = async {
        let mut cmd = Command::new("git");
        cmd.arg("-C").arg(repo).stdin(Stdio::null()).env("GIT_TERMINAL_PROMPT", "0").kill_on_drop(true);
        crate::mcp::gh_mcp::authenticate_fetch(&mut cmd, repo, &up.remote, account).await?;
        let out = cmd.args(["fetch", "--quiet", "--no-tags", &up.remote, &refspec]).output().await.context("failed to run git fetch")?;
        if !out.status.success() { bail!("git fetch {} failed: {}", up.remote, String::from_utf8_lossy(&out.stderr).trim()) }
        Ok(())
    };
    match tokio::time::timeout(Duration::from_secs(60), run).await {
        Ok(r) => r,
        Err(_) => bail!("git fetch {} timed out", up.remote),
    }
}

/// Fetch base branch `base`'s upstream (see `upstream`), returning its name (e.g. `origin/master`),
/// or None when it has none.
pub(super) async fn fetch_upstream(repo: &Path, base: &str, account: Option<&str>) -> Result<Option<String>> {
    let Some(up) = upstream(repo, base).await else { return Ok(None) };
    fetch(repo, &up, account).await?;
    Ok(Some(up.name().to_string()))
}

/// What a task branched from base branch `base` is compared with to find its own work: the
/// newer of the local branch and its upstream as last fetched, as `start_point` picks (the
/// upstream when they've diverged), without fetching. The upstream when there's no local branch,
/// and `base` as is when it has no upstream or that was never fetched.
pub async fn compare_ref(repo: &Path, base: &str) -> String {
    let Some(up) = upstream(repo, base).await else { return base.to_string() };
    let Some(theirs) = commit(repo, &up.tracking).await else { return base.to_string() };
    match commit(repo, &format!("refs/heads/{base}")).await {
        Some(ours) if is_ancestor(repo, &theirs, &ours).await => base.to_string(),
        _ => up.name().to_string(),
    }
}

/// Where a new task branch starts.
pub(super) struct Start {
    /// The commit, or `base` as given when it has no upstream.
    pub(super) rev: String,
    /// What it is, for the task log: `master` or `origin/master`.
    pub(super) from: String,
    /// Events for the task log: level, text and detail.
    pub(super) notes: Vec<(&'static str, String, Option<String>)>,
}

/// Where a task branch from base branch `base` starts: the newer of the local branch and its
/// upstream (fetched first), so it starts from the latest commit even when the local branch is
/// behind and can't be fast-forwarded (it's checked out with changes in the way, say). The
/// local branch is fast-forwarded when it can be. When the two have diverged it's the upstream,
/// which is where the task's pull request goes; when the local branch is ahead (with commits
/// that aren't pushed), it's the local branch. If the fetch fails, it goes by the last one.
pub(super) async fn start_point(repo: &Path, base: &str, account: Option<&str>) -> Start {
    let mut start = Start { rev: base.to_string(), from: base.to_string(), notes: Vec::new() };
    let Some(up) = upstream(repo, base).await else { return start };
    let name = up.name().to_string();
    if let Err(e) = fetch(repo, &up, account).await {
        start.notes.push(("warn", format!("Could not fetch {name}; branching from the copy fetched before"), Some(format!("{e:#}"))));
    }
    let Some(theirs) = commit(repo, &up.tracking).await else { return start };
    let local = format!("refs/heads/{base}");
    let Some(ours) = commit(repo, &local).await else {
        (start.rev, start.from) = (theirs, name);
        return start;
    };
    if is_ancestor(repo, &theirs, &ours).await {
        start.rev = ours;
        return start;
    }
    let count = async |range: String| git_ok(repo, &["rev-list", "--count", &range]).await.map(|n| n.trim().to_string()).unwrap_or_else(|_| "?".into());
    if !is_ancestor(repo, &ours, &theirs).await {
        let n = count(format!("{theirs}..{ours}")).await;
        start.notes.push(("warn", format!("{base} has diverged from {name}; branching from {name}, without the {n} commit{} only {base} has", plural(&n)), None));
        (start.rev, start.from) = (theirs, name);
        return start;
    }
    let n = count(format!("{ours}..{theirs}")).await;
    let pulled = match checked_out_in(repo, &local).await {
        Some(dir) => git_ok(&dir, &["merge", "--ff-only", "--quiet", &theirs]).await,
        None => git_ok(repo, &["update-ref", "-m", "huntaway: pull before worktree", &local, &theirs, &ours]).await,
    };
    match pulled {
        Ok(_) => {
            start.notes.push(("info", format!("Pulled {base} from {name} ({n} new commit{})", plural(&n)), None));
            start.rev = theirs;
        }
        Err(e) => {
            let text = format!("Branching from {name}, {n} commit{} ahead of {base}, which couldn't be fast-forwarded", plural(&n));
            start.notes.push(("info", text, Some(format!("{e:#}"))));
            (start.rev, start.from) = (theirs, name);
        }
    }
    start
}
