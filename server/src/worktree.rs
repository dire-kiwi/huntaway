//! Git worktree lifecycle for tasks: setup (worktree add, ignored files, setup script),
//! teardown (teardown script + worktree remove), and diffs for review.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Value, json};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::db::{self, Project, Task};
use crate::state::Shared;
use crate::util::{path_str, slugify, truncate};

pub struct Output {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

pub async fn git(dir: &Path, args: &[&str]) -> Result<Output> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .stdin(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0")
        .kill_on_drop(true)
        .output()
        .await
        .context("failed to run git")?;
    Ok(Output {
        ok: out.status.success(),
        stdout: String::from_utf8_lossy(&out.stdout).to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).to_string(),
    })
}

async fn git_ok(dir: &Path, args: &[&str]) -> Result<String> {
    let o = git(dir, args).await?;
    if !o.ok {
        bail!("git {} failed: {}", args.join(" "), o.stderr.trim());
    }
    Ok(o.stdout)
}

pub async fn is_git_repo(dir: &Path) -> bool {
    matches!(git(dir, &["rev-parse", "--git-dir"]).await, Ok(o) if o.ok)
}

pub async fn current_branch(dir: &Path) -> Option<String> {
    let o = git(dir, &["symbolic-ref", "--short", "HEAD"]).await.ok()?;
    o.ok.then(|| o.stdout.trim().to_string()).filter(|s| !s.is_empty())
}

/// Whether git takes `name` for a branch name (`git check-ref-format --branch`), run outside any
/// repository so that `@{-1}` (the branch checked out before) isn't taken for the one it names.
pub async fn valid_branch_name(name: &str) -> bool {
    let run = Command::new("git")
        .args(["check-ref-format", "--branch", name])
        .current_dir("/")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .status()
        .await;
    !name.contains("@{") && run.is_ok_and(|st| st.success())
}

/// The worktree (main checkout included) that has `branch_ref` checked out, if any.
async fn checked_out_in(repo: &Path, branch_ref: &str) -> Option<PathBuf> {
    let list = git_ok(repo, &["worktree", "list", "--porcelain"]).await.ok()?;
    let mut dir = None;
    for line in list.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            dir = Some(PathBuf::from(p));
        } else if line.strip_prefix("branch ") == Some(branch_ref) {
            return dir;
        }
    }
    None
}

/// Whether `dir` is one of `repo`'s worktrees (the main checkout included), by git's own list.
async fn is_worktree_of(repo: &Path, dir: &Path) -> bool {
    let Ok(list) = git_ok(repo, &["worktree", "list", "--porcelain"]).await else { return false };
    let dir = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
    list.lines()
        .filter_map(|l| l.strip_prefix("worktree "))
        .any(|p| PathBuf::from(p).canonicalize().map(|p| p == dir).unwrap_or(false))
}

/// Whether `wt` may be removed by hand when git won't remove it as a worktree: a folder inside the
/// project's worktrees folder that isn't the repository (or another main checkout), so a stray folder
/// there, or a misconfigured worktrees folder, can't cost work kept elsewhere.
async fn removable_by_hand(project: &Project, repo: &Path, wt: &Path) -> bool {
    let canon = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let (root, wt_c, repo_c) = (canon(Path::new(&project.worktrees_root)), canon(wt), canon(repo));
    if !wt_c.starts_with(&root) || wt_c == root || wt_c == repo_c {
        return false;
    }
    // A main checkout's git dir is its own `.git`; a linked worktree's is under the repository's.
    match git(&wt_c, &["rev-parse", "--absolute-git-dir"]).await {
        Ok(o) if o.ok => !Path::new(o.stdout.trim()).ends_with(".git"),
        _ => true,
    }
}

/// The commit `rev` names, if it names one.
async fn commit(repo: &Path, rev: &str) -> Option<String> {
    git_ok(repo, &["rev-parse", "--verify", "--quiet", &format!("{rev}^{{commit}}")]).await.ok().map(|s| s.trim().to_string())
}

/// Whether commit `a` is in `b`'s history (or is `b`).
async fn is_ancestor(repo: &Path, a: &str, b: &str) -> bool {
    git(repo, &["merge-base", "--is-ancestor", a, b]).await.is_ok_and(|o| o.ok)
}

fn plural(n: &str) -> &'static str {
    if n == "1" { "" } else { "s" }
}

/// The branch a base branch follows.
struct Upstream {
    remote: String,
    /// Its ref on the remote (`refs/heads/master`).
    merge: String,
    /// Where it's fetched to (`refs/remotes/origin/master`), or a local branch for an upstream
    /// in the repository itself (remote `.`).
    tracking: String,
}

impl Upstream {
    /// Its short name, e.g. `origin/master`.
    fn name(&self) -> &str {
        self.tracking.strip_prefix("refs/remotes/").or_else(|| self.tracking.strip_prefix("refs/heads/")).unwrap_or(&self.tracking)
    }
}

/// The branch base branch `base` follows: its upstream or, for one without (pushed without `-u`,
/// say, or only on the remote), the branch of the same name on `origin` (or the only remote),
/// if that was fetched before or there's no local branch. None for a tag, a commit or `HEAD`.
async fn upstream(repo: &Path, base: &str) -> Option<Upstream> {
    let local = format!("refs/heads/{base}");
    let has_local = commit(repo, &local).await.is_some();
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

/// Fetch `up` (unless it's in the repository itself).
async fn fetch(repo: &Path, up: &Upstream, account: Option<&str>) -> Result<()> {
    if up.remote == "." {
        return Ok(());
    }
    let refspec = format!("+{}:{}", up.merge, up.tracking);
    let run = async {
        let mut cmd = Command::new("git");
        cmd.arg("-C").arg(repo).stdin(Stdio::null()).env("GIT_TERMINAL_PROMPT", "0").kill_on_drop(true);
        crate::gh_mcp::authenticate_fetch(&mut cmd, repo, &up.remote, account).await?;
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
async fn fetch_upstream(repo: &Path, base: &str, account: Option<&str>) -> Result<Option<String>> {
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
struct Start {
    /// The commit, or `base` as given when it has no upstream.
    rev: String,
    /// What it is, for the task log: `master` or `origin/master`.
    from: String,
    /// Events for the task log: level, text and detail.
    notes: Vec<(&'static str, String, Option<String>)>,
}

/// Where a task branch from base branch `base` starts: the newer of the local branch and its
/// upstream (fetched first), so it starts from the latest commit even when the local branch is
/// behind and can't be fast-forwarded (it's checked out with changes in the way, say). The
/// local branch is fast-forwarded when it can be. When the two have diverged it's the upstream,
/// which is where the task's pull request goes; when the local branch is ahead (with commits
/// that aren't pushed), it's the local branch. If the fetch fails, it goes by the last one.
async fn start_point(repo: &Path, base: &str, account: Option<&str>) -> Start {
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

/// How long a setup or teardown script may run (an install or a build, say): it holds the task's
/// setup lock and its project's folder in place meanwhile, so one that hangs is stopped.
pub const SCRIPT_LIMIT: Duration = Duration::from_secs(30 * 60);

/// Run a project script with bash. With a time limit, it's stopped (with everything it started)
/// if it runs over.
pub async fn run_script(script: &str, cwd: &Path, env: &[(&str, String)], limit: Option<Duration>) -> Result<String> {
    let mut cmd = Command::new("bash");
    cmd.arg("-c").arg(script).current_dir(cwd).stdin(Stdio::null());
    for (k, v) in env {
        cmd.env(k, v);
    }
    let out = match limit {
        Some(limit) => run_limited(cmd, limit).await?,
        None => cmd.output().await.context("failed to run script")?,
    };
    let log = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    if !out.status.success() {
        bail!("script exited with {}\n{}", out.status, truncate(&log, 8000));
    }
    Ok(log)
}

/// Kills a process group when dropped.
pub(crate) struct KillGroup(pub(crate) i32);

impl Drop for KillGroup {
    fn drop(&mut self) {
        unsafe { libc::kill(-self.0, libc::SIGKILL) };
    }
}

/// Run a script in a process group of its own, which is killed if the script runs over `limit`
/// or isn't waited for to the end (e.g. the server is shutting down), so nothing it started
/// keeps running.
async fn run_limited(mut cmd: Command, limit: Duration) -> Result<std::process::Output> {
    cmd.process_group(0).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = cmd.spawn().context("failed to run script")?;
    let pid = child.id().context("failed to run script")? as i32;
    // Dropped before `child`, while the shell isn't reaped, so its group id can't have been reused.
    let group = KillGroup(pid);
    let (mut stdout, mut stderr) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let ran = tokio::time::timeout(limit, async {
        let (_, _, status) = tokio::join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err), child.wait());
        status
    })
    .await;
    match ran {
        Ok(status) => {
            // It finished: anything it left running was started to outlive it.
            std::mem::forget(group);
            Ok(std::process::Output { status: status.context("failed to run script")?, stdout: out, stderr: err })
        }
        Err(_) => {
            drop(group);
            let _ = child.wait().await;
            let log = format!("{}{}", String::from_utf8_lossy(&out), String::from_utf8_lossy(&err));
            bail!("script still running after {limit:?}; stopped it\n{}", truncate(&log, 8000))
        }
    }
}

pub fn script_env(project: &Project, task: &Task, wt: &Path, branch: &str) -> Vec<(&'static str, String)> {
    vec![
        ("IA_REPO_PATH", project.repo_path.clone()),
        ("IA_WORKTREE_PATH", path_str(wt)),
        ("IA_BRANCH", branch.to_string()),
        ("IA_TASK_ID", task.id.clone()),
        ("IA_TASK_NUMBER", task.number.to_string()),
        ("IA_PROJECT_KEY", project.key.clone()),
    ]
}

fn load(state: &Shared, task_id: &str) -> Result<(Task, Project)> {
    let c = state.db();
    let task = db::get_task(&c, task_id)?.ok_or_else(|| anyhow!("task not found"))?;
    let pid = task.project_id.clone().ok_or_else(|| anyhow!("task has no project"))?;
    let project = db::get_project(&c, &pid)?.ok_or_else(|| anyhow!("project not found"))?;
    Ok((task, project))
}

/// Worktree setups (and removals once merged) in progress, by task: one at a time per task, so
/// that two runs needing the same worktree (e.g. two of a subproject's tasks both setting up the
/// subproject's first) don't both try to create it, and a run doesn't set up a worktree that's
/// being removed.
static SETUPS: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = LazyLock::new(Default::default);

/// Run `f` holding the task's setup lock.
async fn locked<T>(task_id: &str, f: impl AsyncFnOnce() -> T) -> T {
    let lock = SETUPS.lock().unwrap().entry(task_id.to_string()).or_default().clone();
    let result = {
        let _held = lock.lock().await;
        f().await
    };
    // Forget the lock once nobody else is waiting on it.
    let mut setups = SETUPS.lock().unwrap();
    if Arc::strong_count(&lock) == 2 {
        setups.remove(task_id);
    }
    result
}

/// Create the worktree for a task (idempotent) and run the project's setup script.
pub async fn setup(state: &Shared, task_id: &str) -> Result<Task> {
    // Not from the repository folder the project is moving from, and the folder stays put until
    // the worktree is stored.
    let project_id = db::get_task(&state.db(), task_id)?.and_then(|t| t.project_id);
    let _holding = match &project_id {
        Some(pid) => Some(crate::relocate::hold(state, pid).await),
        None => None,
    };
    locked(task_id, async || setup_locked(state, task_id).await).await
}

/// `setup` while holding the task's setup lock: whatever another setup did before is seen here.
async fn setup_locked(state: &Shared, task_id: &str) -> Result<Task> {
    let (task, project) = load(state, task_id)?;
    if task.worktree_state == "ready" {
        if let Some(p) = &task.worktree_path {
            if Path::new(p).exists() {
                return Ok(task);
            }
        }
    }
    let repo = PathBuf::from(&project.repo_path);
    if !is_git_repo(&repo).await {
        bail!("{} is not a git repository", project.repo_path);
    }
    // It may have become one since the board last looked, or have its first commits.
    crate::relocate::record_fingerprint(state, &project).await;
    // A subproject's task branches from the subproject's branch, which needs to exist first.
    let subproject = db::subproject_of(&state.db(), &task)?;
    let subproject_branch = match subproject {
        Some(sp) if task.base_branch.is_none() => match sp.branch {
            Some(b) => Some(b),
            None => {
                state.add_event(task_id, "info", "Setting up the subproject's worktree first…", None);
                let sp = Box::pin(setup(state, &sp.id)).await.context("setting up the subproject's worktree")?;
                sp.branch
            }
        },
        _ => None,
    };
    state.update_task(task_id, &[("worktree_state", json!("setting_up")), ("worktree_error", Value::Null)])?;

    let result = async {
        let name = folder_name(&project, &task);
        let branch = task.branch.clone().unwrap_or_else(|| format!("ia/{}-{name}", project.key.to_lowercase()));
        let wt = PathBuf::from(&project.worktrees_root).join(&name);
        let base = match (task.base_branch.as_ref().or(subproject_branch.as_ref()), &project.base_branch) {
            (Some(b), _) => b.clone(),
            (None, Some(b)) if !b.is_empty() => b.clone(),
            _ => current_branch(&repo).await.unwrap_or_else(|| "HEAD".into()),
        };
        tokio::fs::create_dir_all(&project.worktrees_root).await?;
        let _ = git(&repo, &["worktree", "prune"]).await;

        let mut from = base.clone();
        // A folder there already is the task's worktree from before (a setup that didn't finish, say);
        // anything else is in the way, not something to take over and later remove.
        if wt.exists() && !is_worktree_of(&repo, &wt).await {
            bail!("{} is in the way: it isn't a worktree of {}", wt.display(), repo.display());
        }
        if !wt.exists() {
            let branch_exists = git(&repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).await?.ok;
            let wt_s = path_str(&wt);
            if branch_exists {
                git_ok(&repo, &["worktree", "add", &wt_s, &branch]).await?;
            } else {
                let account = crate::runner::task_github_account(state, &task)?;
                let start = start_point(&repo, &base, account.as_deref()).await;
                for (level, text, detail) in start.notes {
                    state.add_event(task_id, level, text, detail);
                }
                // Not tracking the branch it starts from (git would for a remote-tracking one).
                git_ok(&repo, &["worktree", "add", "--no-track", "-b", &branch, &wt_s, &start.rev]).await?;
                from = start.from;
            }
        }
        state.add_event(task_id, "info", format!("Worktree ready at {} on branch {branch} (from {from})", wt.display()), None);

        // Before the setup script, which can rely on them. Nothing already there is overwritten,
        // so a setup that didn't finish can do it again.
        match crate::worktree_files::bring_in(&project, &wt).await {
            Ok(report) => {
                if let Some((level, text, detail)) = report.event() {
                    state.add_event(task_id, level, text, Some(detail));
                }
            }
            Err(e) => state.add_event(task_id, "warn", "Couldn't copy or link the project's files into the worktree", Some(format!("{e:#}"))),
        }
        if !project.setup_script.trim().is_empty() {
            state.add_event(task_id, "info", "Running setup script…", None);
            let log = run_script(&project.setup_script, &wt, &script_env(&project, &task, &wt, &branch), Some(SCRIPT_LIMIT)).await?;
            state.add_event(task_id, "info", "Setup script finished", Some(truncate(&log, 20000)));
        }
        Ok::<_, anyhow::Error>((wt, branch, base))
    }
    .await;

    match result {
        Ok((wt, branch, base)) => Ok(state
            .update_task(
                task_id,
                &[
                    ("worktree_state", json!("ready")),
                    ("worktree_path", json!(path_str(&wt))),
                    ("branch", json!(branch)),
                    ("base_branch", json!(base)),
                ],
            )?
            .unwrap()),
        Err(e) => {
            let msg = format!("{e:#}");
            state.update_task(task_id, &[("worktree_state", json!("error")), ("worktree_error", json!(msg))])?;
            state.add_event(task_id, "error", "Worktree setup failed", Some(msg.clone()));
            Err(anyhow!(msg))
        }
    }
}

/// The name of a task's worktree folder in the project's worktrees folder. A task that had a
/// worktree before (removed once merged, say) gets its folder back, named after its branch (even
/// if the project's key has changed since), so its agent's conversation, which is kept by
/// folder, carries on even if the task was renamed.
pub fn folder_name(project: &Project, task: &Task) -> String {
    let keys = std::iter::once(&project.key).chain(&project.former_keys);
    let from_branch = task.branch.as_deref().and_then(|b| keys.into_iter().find_map(|k| b.strip_prefix(format!("ia/{}-", k.to_lowercase()).as_str())));
    match from_branch {
        Some(n) if !n.is_empty() && !n.contains('/') => n.to_string(),
        _ => match slugify(&task.title, 40) {
            slug if slug.is_empty() => format!("{}", task.number),
            slug => format!("{}-{}", task.number, slug),
        },
    }
}

/// What in worktree `wt` isn't committed (`git status --porcelain`, trimmed), whatever the
/// repository's settings hide: every untracked file, every submodule change, and changes to
/// tracked files marked assume-unchanged or skip-worktree. Ignored files don't count.
pub(crate) async fn uncommitted(wt: &Path) -> Result<String> {
    let status = git_ok(wt, &["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"]).await?;
    let mut lines: Vec<String> = status.lines().filter(|l| !l.trim().is_empty()).map(str::to_string).collect();
    // git status skips marked files, so they're compared with the index here: content and, with
    // core.fileMode (git's default), the executable bit. One that isn't on disk (left out of a
    // sparse checkout, say) has nothing to lose. File names are bytes, which needn't be UTF-8.
    let index = git_bytes(wt, &["ls-files", "-v", "-s", "-z"].map(OsStr::new)).await?;
    let file_mode = git(wt, &["config", "--type=bool", "core.fileMode"]).await.map_or(true, |o| o.stdout.trim() != "false");
    for entry in index.split(|b| *b == 0) {
        // "<tag> <mode> <object> <stage>\t<path>"; a lowercase tag is assume-unchanged, S skip-worktree.
        let Some(tab) = entry.iter().position(|b| *b == b'\t') else { continue };
        let (meta, path) = (String::from_utf8_lossy(&entry[..tab]), OsStr::from_bytes(&entry[tab + 1..]));
        let mut fields = meta.split(' ');
        let (Some(tag), Some(mode), Some(object)) = (fields.next(), fields.next(), fields.next()) else { continue };
        let assumed = tag.chars().all(|c| c.is_ascii_lowercase());
        if !(assumed || tag == "S") {
            continue;
        }
        let file = match tokio::fs::symlink_metadata(wt.join(path)).await {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e).with_context(|| format!("checking {}", Path::new(path).display())),
        };
        // Only a regular file is compared; anything else counts as changed.
        let executable = file.permissions().mode() & 0o100 != 0;
        let same = file.is_file()
            && ["100644", "100755"].contains(&mode)
            && (!file_mode || executable == (mode == "100755"))
            && git_bytes(wt, &[OsStr::new("hash-object"), OsStr::new("--"), path]).await?.trim_ascii() == object.as_bytes();
        if !same {
            let mark = if assumed { "assume-unchanged" } else { "skip-worktree" };
            lines.push(format!(" M {} (marked {mark})", Path::new(path).display()));
        }
    }
    Ok(lines.join("\n"))
}

/// Run git in `dir` with arguments that needn't be UTF-8 (file names), whether it succeeds or not.
async fn git_output(dir: &Path, args: &[&OsStr]) -> Result<std::process::Output> {
    Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .stdin(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0")
        .kill_on_drop(true)
        .output()
        .await
        .context("failed to run git")
}

/// Run git in `dir`, returning what it prints as bytes (for file names, which needn't be UTF-8).
async fn git_bytes(dir: &Path, args: &[&OsStr]) -> Result<Vec<u8>> {
    let out = git_output(dir, args).await?;
    if !out.status.success() {
        let args: Vec<_> = args.iter().map(|a| a.to_string_lossy()).collect();
        bail!("git {} failed: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(out.stdout)
}

/// Run the teardown script and remove the worktree. Refuses when the worktree has
/// uncommitted changes unless `force` is set.
pub async fn teardown(state: &Shared, task_id: &str, force: bool, delete_branch: bool) -> Result<Task> {
    let (task, project) = load(state, task_id)?;
    let repo = PathBuf::from(&project.repo_path);
    let Some(wt) = task.worktree_path.clone().map(PathBuf::from) else {
        bail!("task has no worktree");
    };
    let branch = task.branch.clone().unwrap_or_default();

    if wt.exists() {
        if !force {
            let status = uncommitted(&wt).await.context("checking the worktree for uncommitted changes")?;
            if !status.is_empty() {
                bail!("worktree has uncommitted changes:\n{}", truncate(status.trim(), 2000));
            }
        }
        state.update_task(task_id, &[("worktree_state", json!("tearing_down"))])?;
        // Its terminal would be left in a deleted directory.
        crate::terminal::kill_all(state, task_id).await;
        if !project.teardown_script.trim().is_empty() {
            match run_script(&project.teardown_script, &wt, &script_env(&project, &task, &wt, &branch), Some(SCRIPT_LIMIT)).await {
                Ok(log) => state.add_event(task_id, "info", "Teardown script finished", Some(truncate(&log, 20000))),
                Err(e) if force => state.add_event(task_id, "warn", "Teardown script failed (continuing)", Some(format!("{e:#}"))),
                Err(e) => {
                    state.update_task(task_id, &[("worktree_state", json!("ready"))])?;
                    return Err(e);
                }
            }
        }
        let wt_s = path_str(&wt);
        if force {
            let o = git(&repo, &["worktree", "remove", "--force", &wt_s]).await?;
            if !o.ok && wt.exists() {
                if removable_by_hand(&project, &repo, &wt).await {
                    tokio::fs::remove_dir_all(&wt).await.ok();
                } else {
                    state.add_event(task_id, "warn", format!("Left {} in place: git won't remove it as a worktree ({}) and it isn't in the project's worktrees folder", wt.display(), o.stderr.trim()), None);
                }
            }
        } else {
            // What the teardown script left would be lost too, so it's checked again, and git's
            // own check (without --force) has the last word.
            let kept = match uncommitted(&wt).await.context("checking the worktree for uncommitted changes") {
                Ok(left) if left.is_empty() => match git(&repo, &["worktree", "remove", &wt_s]).await {
                    Ok(o) if o.ok || !wt.exists() => None,
                    Ok(o) => Some(anyhow!("git worktree remove failed: {}", o.stderr.trim())),
                    Err(e) => Some(e),
                },
                Ok(left) => Some(anyhow!("the teardown script left uncommitted changes:\n{}", truncate(&left, 2000))),
                Err(e) => Some(e),
            };
            if let Some(e) = kept {
                state.update_task(task_id, &[("worktree_state", json!("ready"))])?;
                return Err(e);
            }
        }
    }
    let _ = git(&repo, &["worktree", "prune"]).await;
    // Its checkpoints are of files that are gone now (or were already), and the next run takes a
    // new baseline. Not before: a teardown that keeps the worktree keeps them too.
    crate::checkpoints::forget(state, task_id, &repo).await;
    let mut fields = vec![
        ("worktree_state", json!("none")),
        ("worktree_path", Value::Null),
        ("worktree_error", Value::Null),
    ];
    if delete_branch && !branch.is_empty() {
        let o = git(&repo, &["branch", "-D", &branch]).await?;
        if o.ok {
            fields.push(("branch", Value::Null));
            state.add_event(task_id, "info", format!("Deleted branch {branch}"), None);
        } else {
            state.add_event(task_id, "warn", format!("Could not delete branch {branch}"), Some(o.stderr));
        }
    }
    state.add_event(task_id, "info", "Worktree removed", None);
    Ok(state.update_task(task_id, &fields)?.unwrap())
}

/// Whether an agent is working in the task's worktree: its own, or one of its reviewers, whose
/// threads run there too.
pub fn agent_in_worktree(state: &Shared, task_id: &str) -> bool {
    // Read (and the database unlocked) before checking runs, which are locked first elsewhere.
    let reviews = db::review_threads(&state.db(), task_id);
    state.is_running(task_id) || reviews.is_ok_and(|r| r.iter().any(|r| r.running || state.is_running(&r.id)))
}

/// What `remove_if_merged` did with a done task's worktree.
#[derive(Debug, PartialEq)]
pub enum Removal {
    /// Removed; its work is merged into this (a branch, or a pull request's base and URL).
    Removed(String),
    /// Kept, and why.
    Kept(String),
}

/// Remove a done task's worktree if its work is merged and nothing in it would be lost: its
/// HEAD is in its base branch (here or upstream) or is the head of its merged pull request, and
/// it has no uncommitted or untracked files (ignored ones, such as build output, don't count).
/// The task and its branch are kept; if its agent runs again, the worktree is set up again in
/// the same folder. With `fetch`, the base branch's upstream is fetched first.
pub async fn remove_if_merged(state: &Shared, task_id: &str, fetch: bool) -> Result<Removal> {
    let kept = |why: &str| Ok(Removal::Kept(why.to_string()));
    locked(task_id, async || {
        let (task, project) = load(state, task_id)?;
        let busy = || agent_in_worktree(state, task_id);
        if task.kind != "task" || task.status != "done" {
            return kept("it isn't done");
        }
        let wt = match (&task.worktree_path, task.worktree_state.as_str()) {
            (Some(wt), "ready") if Path::new(wt).is_dir() => PathBuf::from(wt),
            _ => return kept("it has no worktree"),
        };
        if task.running || busy() {
            return kept("an agent is working in it");
        }
        // A subproject's worktree is where its tasks get merged; it stays while any are open
        // (other than scratch tasks, which only read it).
        if task.subproject && db::subproject_tasks(&state.db(), task_id)?.iter().any(|t| t.status != "done" && !t.is_scratch()) {
            return kept("the subproject still has open tasks");
        }
        let repo = PathBuf::from(&project.repo_path);
        let Some(base) = task.base_branch.clone().or(project.base_branch.clone()).filter(|b| !b.is_empty()) else {
            return kept("it has no base branch to be merged into");
        };
        let status = uncommitted(&wt).await?;
        if !status.is_empty() {
            let n = status.lines().count();
            return Ok(Removal::Kept(format!("it has {n} uncommitted or untracked file{}", if n == 1 { "" } else { "s" })));
        }
        let head = git_ok(&wt, &["rev-parse", "--verify", "HEAD"]).await?.trim().to_string();
        let account = crate::runner::task_github_account(state, &task)?;
        let env = crate::runner::task_gh_env(state, &task).await;
        let Some(merged_into) = merged_into(&repo, &wt, &base, task.branch.as_deref(), &head, fetch, account.as_deref(), &env).await else {
            return Ok(Removal::Kept(format!("its work isn't merged into {base}")));
        };
        // Started meanwhile (fetching takes a while)?
        if busy() {
            return kept("an agent is working in it");
        }
        let branch = task.branch.as_deref().map_or("The task is".to_string(), |b| format!("The task and branch {b} are"));
        state.add_event(
            task_id,
            "info",
            format!("Removing the worktree: its work is merged into {merged_into} and nothing in it is uncommitted. {branch} kept; the worktree is set up again if the agent runs again."),
            None,
        );
        // Not forced, so teardown checks again just before removing it.
        teardown(state, task_id, false, false).await?;
        Ok(Removal::Removed(merged_into))
    })
    .await
}

/// Where `head` (the HEAD of a task's worktree `wt`) has been merged: `base`, its upstream
/// (fetched first with `fetch`), or the base of `branch`'s merged pull request (squashed or
/// rebased) whose head it is (looked up with gh, with `gh_env`, see runner::task_gh_env; not
/// when that failed, rather than as another account).
async fn merged_into(
    repo: &Path,
    wt: &Path,
    base: &str,
    branch: Option<&str>,
    head: &str,
    fetch: bool,
    account: Option<&str>,
    gh_env: &Result<Option<crate::gh_mcp::GhEnv>>,
) -> Option<String> {
    let contains = |rev: String| async move { git(repo, &["merge-base", "--is-ancestor", head, &rev]).await.is_ok_and(|o| o.ok) };
    if contains(format!("refs/heads/{base}")).await {
        return Some(base.to_string());
    }
    if let Some(up) = upstream(repo, base).await {
        if fetch {
            let _ = self::fetch(repo, &up, account).await;
        }
        if contains(up.tracking.clone()).await {
            return Some(up.name().to_string());
        }
    }
    let env = gh_env.as_ref().ok()?.as_ref();
    let pr = gh_json(wt, &["pr", "view", branch?, "--json", "state,headRefOid,baseRefName,url"], env).await?;
    (pr["state"] == "MERGED" && pr["headRefOid"] == head).then(|| match (pr["url"].as_str(), pr["baseRefName"].as_str()) {
        (Some(url), Some(b)) => format!("{b} ({url})"),
        _ => base.to_string(),
    })
}

/// Remove the worktrees of a project's done tasks that are merged and have nothing uncommitted
/// (see `remove_if_merged`), one at a time, fetching each base branch's upstream once first.
/// Returns what happened to each done task that had a worktree.
pub async fn remove_merged(state: &Shared, project_id: &str) -> Result<Vec<Value>> {
    let (project, tasks) = {
        let c = state.db();
        let project = db::get_project(&c, project_id)?.ok_or_else(|| anyhow!("project not found"))?;
        (project, db::list_tasks_for_project(&c, project_id, "task")?)
    };
    let mut tasks: Vec<Task> = tasks.into_iter().filter(|t| t.status == "done" && t.worktree_state == "ready").collect();
    tasks.sort_by_key(|t| t.number);
    let repo = PathBuf::from(&project.repo_path);
    let mut bases: Vec<String> = tasks.iter().filter_map(|t| t.base_branch.clone().or(project.base_branch.clone())).filter(|b| !b.is_empty()).collect();
    bases.sort();
    bases.dedup();
    let profile = db::get_profile(&state.db(), &project.profile_id)?.context("profile not found")?;
    let account = crate::runner::github_account(Some(&project), &profile);
    for base in bases {
        if let Err(e) = fetch_upstream(&repo, &base, account.as_deref()).await {
            tracing::warn!(project = project_id, "couldn't fetch {base}'s upstream: {e:#}");
        }
    }
    let mut results = Vec::new();
    for t in tasks {
        let (removed, detail) = match remove_if_merged(state, &t.id, false).await {
            Ok(Removal::Removed(into)) => (true, format!("merged into {into}")),
            Ok(Removal::Kept(why)) => (false, why),
            Err(e) => (false, format!("{e:#}")),
        };
        results.push(json!({"task_id": t.id, "number": t.number, "title": t.title, "removed": removed, "detail": detail}));
    }
    Ok(results)
}

/// Whether a task has work to merge: commits on its branch that its base branch doesn't have,
/// or uncommitted changes where its agent works. When it can't tell (e.g. the branch or its base
/// is missing locally), it says yes, so the task's agent sorts the merge out.
pub async fn has_work_to_merge(state: &Shared, task: &Task) -> bool {
    let project = match &task.project_id {
        Some(pid) => db::get_project(&state.db(), pid).ok().flatten(),
        None => None,
    };
    let Some(project) = project else { return false };
    let repo = PathBuf::from(&project.repo_path);
    if !is_git_repo(&repo).await {
        return false;
    }
    // A subproject's tasks were merged into its branch on the remote, which may be ahead of ours.
    // Its scratch tasks have no branch, so they don't count (a failed read counts as work).
    if task.subproject && !db::subproject_tasks(&state.db(), &task.id).map(|t| t.iter().all(Task::is_scratch)).unwrap_or(false) {
        return true;
    }
    let base = task.base_branch.clone().or(project.base_branch.clone()).filter(|b| !b.is_empty());
    let dirty = |dir: PathBuf| async move { git(&dir, &["status", "--porcelain"]).await.map_or(true, |o| !o.ok || !o.stdout.trim().is_empty()) };
    let Some(branch) = task.branch.clone() else {
        // No worktree: the agent worked in the repository's own checkout, on its base branch
        // unless it switched to another.
        if task.use_worktree && task.worktree_state == "none" {
            return false;
        }
        return base.is_none() || current_branch(&repo).await != base || dirty(repo).await;
    };
    let Some(base) = base else { return true };
    // It may have started from the base branch's upstream, ahead of the local branch (or with no
    // local branch at all).
    let mut bases = vec![format!("refs/heads/{base}")];
    bases.extend(upstream(&repo, &base).await.map(|up| up.tracking));
    let mut args = vec!["rev-list".to_string(), "--count".into(), format!("refs/heads/{branch}")];
    for b in bases {
        if commit(&repo, &b).await.is_some() {
            args.push(format!("^{b}"));
        }
    }
    if args.len() == 3 {
        return true;
    }
    let ahead = git(&repo, &args.iter().map(String::as_str).collect::<Vec<_>>()).await;
    match ahead {
        Ok(o) if o.ok && o.stdout.trim() == "0" => {}
        _ => return true,
    }
    match (&task.worktree_path, task.worktree_state.as_str()) {
        (Some(wt), "ready") => dirty(PathBuf::from(wt)).await,
        _ => false,
    }
}

/// Whether moving a task to Done would leave work of its unmerged (API 75), for the board to ask
/// first: it has work to merge (see `has_work_to_merge`) and its pull request, if it has one,
/// isn't merged on GitHub (squashed or rebased, its commits aren't in its base branch). Tasks with
/// a document (kept by the board) have none. A pull request that can't be read in a few seconds
/// counts as not merged.
pub async fn unmerged(state: &Shared, task: &Task) -> bool {
    if task.kind != "task" || task.task_type.is_some() || !has_work_to_merge(state, task).await {
        return false;
    }
    let Some(url) = task.pr_url.clone() else { return true };
    let pr = async {
        let project = db::get_project(&state.db(), task.project_id.as_deref()?).ok().flatten()?;
        // Not as another account when the task's isn't signed in.
        let env = crate::runner::task_gh_env(state, task).await.ok()?;
        gh_json(Path::new(&project.repo_path), &["pr", "view", &url, "--json", "state"], env.as_ref()).await
    };
    !matches!(tokio::time::timeout(Duration::from_secs(5), pr).await, Ok(Some(pr)) if pr["state"] == "MERGED")
}

/// Look up the pull request for a task's branch with `gh` once its agent's run ends, and keep
/// its URL on the task. Skipped when the task already has one; quietly gives up when `gh`
/// isn't installed or signed in, or the branch has no pull request yet.
pub fn find_pr(state: &Shared, task: &Task) {
    let Some(branch) = task.branch.clone().filter(|_| task.pr_url.is_none() && task.kind == "task") else { return };
    // Finished runs in tests have no runtime to look it up on.
    let Ok(rt) = tokio::runtime::Handle::try_current() else { return };
    let (state, task) = (state.clone(), task.clone());
    rt.spawn(async move {
        let Some(project) = task.project_id.as_ref().and_then(|pid| db::get_project(&state.db(), pid).ok().flatten()) else { return };
        let dir = match (&task.worktree_path, task.worktree_state.as_str()) {
            (Some(wt), "ready") => PathBuf::from(wt),
            _ => PathBuf::from(&project.repo_path),
        };
        let base = task.base_branch.as_deref().or(project.base_branch.as_deref()).filter(|b| !b.is_empty());
        let args = pr_view_args(Path::new(&project.repo_path), base, &branch).await;
        // Not as another account when the task's isn't signed in.
        let env = match crate::runner::task_gh_env(&state, &task).await {
            Ok(env) => env,
            Err(e) => return tracing::warn!(task = %task.id, "couldn't look up the pull request: {e:#}"),
        };
        let Some(url) = pr_url(&dir, &args, env.as_ref()).await else { return };
        // Unless it was set meanwhile.
        if db::get_task(&state.db(), &task.id).ok().flatten().is_some_and(|t| t.pr_url.is_none()) {
            if let Err(e) = state.update_task(&task.id, &[("pr_url", json!(url))]) {
                tracing::warn!(task = %task.id, "couldn't save the pull request: {e:#}");
            }
        }
    });
}

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
    static SSH_CONFIG: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

/// The remote `github` picks, and its push URL.
async fn push_remote(repo: &Path, base: Option<&str>) -> Option<(String, String)> {
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

/// The `gh` arguments that look up the pull request of a task's `branch` (branched from `base`
/// in `repo`): in the GitHub repository it's pushed to (see `github`), which gh wouldn't pick
/// from the remotes' fetch URLs if they're elsewhere, or else wherever gh finds it.
async fn pr_view_args(repo: &Path, base: Option<&str>, branch: &str) -> Vec<String> {
    let mut args: Vec<String> = ["pr", "view", branch, "--json", "url"].map(String::from).into();
    if let Some(gh) = github(repo, base).await {
        args.extend(["--repo".into(), gh.repo]);
    }
    args
}

/// The URL of a pull request, from `gh` run in `dir` with `pr_view_args` (and `env`, see
/// runner::task_gh_env).
async fn pr_url(dir: &Path, args: &[String], env: Option<&crate::gh_mcp::GhEnv>) -> Option<String> {
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let pr = gh_json(dir, &args, env).await?;
    pr["url"].as_str().filter(|u| u.starts_with("https://")).map(str::to_string)
}

/// The JSON a `gh` command run in `dir` prints, or None when it fails (e.g. `gh` isn't installed
/// or signed in, or there's no such pull request).
async fn gh_json(dir: &Path, args: &[&str], env: Option<&crate::gh_mcp::GhEnv>) -> Option<Value> {
    let mut cmd = Command::new("gh");
    cmd.args(args).current_dir(dir).stdin(Stdio::null()).env("GH_PROMPT_DISABLED", "1").env("GIT_TERMINAL_PROMPT", "0").kill_on_drop(true);
    if let Some(env) = env {
        env.check(args, None).ok()?;
        env.apply(&mut cmd);
    }
    let out = cmd.output();
    let out = tokio::time::timeout(Duration::from_secs(30), out).await.ok()?.ok()?;
    out.status.success().then(|| serde_json::from_slice(&out.stdout).ok()).flatten()
}

/// Where a task's changes are: its worktree once it's ready, else the project's repository.
pub fn changes_dir(state: &Shared, task_id: &str) -> Result<(PathBuf, Task, Project)> {
    let (task, project) = load(state, task_id)?;
    let dir = match (&task.worktree_path, task.worktree_state.as_str()) {
        (Some(p), "ready") => PathBuf::from(p),
        _ => PathBuf::from(&project.repo_path),
    };
    Ok((dir, task, project))
}

/// The base branch a task's changes are compared with, and where its branch left it (only known in
/// the task's own worktree).
pub async fn changes_base(dir: &Path, task: &Task, project: &Project) -> (Option<String>, Option<String>) {
    let base = task.base_branch.clone().or(project.base_branch.clone()).filter(|b| !b.is_empty());
    let merge_base = match &base {
        Some(b) if task.worktree_state == "ready" => {
            // The task may have started from the base branch's upstream.
            let b = compare_ref(dir, b).await;
            git(dir, &["merge-base", &b, "HEAD"]).await.ok().filter(|o| o.ok).map(|o| o.stdout.trim().to_string())
        }
        _ => None,
    };
    (base, merge_base)
}

/// Diff of the task's work against the merge-base with its base branch,
/// including uncommitted and untracked changes.
pub async fn diff(state: &Shared, task_id: &str) -> Result<Value> {
    let (dir, task, project) = changes_dir(state, task_id)?;
    // A task with a worktree of its own that isn't there (not set up yet, or removed): what its branch has, if
    // anything, rather than the project folder's changes, which aren't its own.
    if task.use_worktree && task.worktree_state != "ready" {
        if !is_git_repo(&dir).await {
            return Ok(json!({"available": false, "reason": "not a git repository"}));
        }
        return branch_diff(&dir, &task, &project).await;
    }
    let d = match is_git_repo(&dir).await {
        true => folder_diff(&dir, &task, &project).await,
        false => Ok(json!({"available": false, "reason": "not a git repository"})),
    };
    // HA-90: its worktree may have gone while it was read (Pick this one removes the other tasks'), which fails the
    // git calls or leaves them nothing to show. Then it's answered as a removed worktree is.
    if task.worktree_state == "ready" && task.worktree_path.is_some() {
        let (now, project) = load(state, task_id)?;
        if now.worktree_state != "ready" || now.worktree_path != task.worktree_path || !dir.is_dir() {
            return branch_diff(Path::new(&project.repo_path), &now, &project).await;
        }
    }
    d
}

/// The diff of the changes in `dir` (see `diff`).
async fn folder_diff(dir: &Path, task: &Task, project: &Project) -> Result<Value> {
    #[cfg(test)]
    crate::testing::reached("diff:read");
    let (base, merge_base) = changes_base(dir, task, project).await;
    let from = merge_base.clone().unwrap_or_else(|| "HEAD".into());
    // Mark untracked files as intent-to-add would mutate the index; instead diff them separately.
    let tracked = git(dir, &["diff", "--no-color", "--no-ext-diff", "--stat=200", &from]).await?.stdout;
    let patch = git(dir, &["diff", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", &from]).await?.stdout;
    // NUL-separated, so names git would quote (not ASCII, or with a newline) come as they are, and
    // after `--`, so a name starting with `-` isn't taken for an option.
    let untracked_list = git_bytes(dir, &["ls-files", "-z", "--others", "--exclude-standard"].map(OsStr::new)).await?;
    let untracked: Vec<&OsStr> = untracked_list.split(|b| *b == 0).filter(|f| !f.is_empty()).map(OsStr::from_bytes).collect();
    let mut untracked_patch = String::new();
    for f in untracked.iter().take(50) {
        let args = ["diff", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", "--no-index", "--", "/dev/null"].map(OsStr::new);
        // It exits 1 when the files differ, which they do.
        let o = git_output(dir, &[&args[..], &[*f]].concat()).await?;
        untracked_patch.push_str(&String::from_utf8_lossy(&o.stdout));
    }
    let commits = match &merge_base {
        Some(mb) => git(dir, &["log", "--oneline", &format!("{mb}..HEAD")]).await?.stdout,
        None => String::new(),
    };
    Ok(json!({
        "available": true,
        "dir": path_str(dir),
        "base": base,
        "merge_base": merge_base,
        "commits": commits,
        "stat": tracked,
        "patch": truncate(&format!("{patch}{untracked_patch}"), 2_000_000),
        "untracked": untracked.iter().map(|f| f.to_string_lossy()).collect::<Vec<_>>(),
    }))
}

/// The committed work on a task's branch with no worktree (API 81, see `diff`): from where it left its base branch.
async fn branch_diff(repo: &Path, task: &Task, project: &Project) -> Result<Value> {
    let Some(branch) = task.branch.clone().filter(|b| !b.is_empty()) else {
        return Ok(json!({"available": false, "reason": "the task has no worktree or branch"}));
    };
    let head = format!("refs/heads/{branch}");
    if !git(repo, &["rev-parse", "--verify", "--quiet", &head]).await?.ok {
        return Ok(json!({"available": false, "reason": format!("the task has no worktree, and its branch {branch} is gone")}));
    }
    let base = task.base_branch.clone().or(project.base_branch.clone()).filter(|b| !b.is_empty());
    let merge_base = match &base {
        Some(b) => {
            let b = compare_ref(repo, b).await;
            git(repo, &["merge-base", &b, &head]).await.ok().filter(|o| o.ok).map(|o| o.stdout.trim().to_string())
        }
        None => None,
    };
    let from = merge_base.clone().unwrap_or_else(|| head.clone());
    let stat = git(repo, &["diff", "--no-color", "--no-ext-diff", "--stat=200", &from, &head]).await?.stdout;
    let patch = git(repo, &["diff", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", &from, &head]).await?.stdout;
    let commits = match &merge_base {
        Some(mb) => git(repo, &["log", "--oneline", &format!("{mb}..{head}")]).await?.stdout,
        None => String::new(),
    };
    Ok(json!({
        "available": true,
        "dir": path_str(repo),
        "base": base,
        "merge_base": merge_base,
        "commits": commits,
        "stat": stat,
        "patch": truncate(&patch, 2_000_000),
        "untracked": [],
        "branch": branch,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{CreateProject, CreateTask, create_project_inner, create_task_inner};

    fn sh(dir: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@t"])
            .args(args)
            .stdout(Stdio::null())
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?}");
    }

    /// `OWNER/REPO` from a remote URL on github.com.
    fn github_repo(url: &str) -> Option<String> {
        remote_repo(url).filter(|(host, _)| is_github_com(host)).map(|(_, repo)| repo)
    }

    #[test]
    fn reads_github_remotes() {
        for url in [
            "git@github.com:o/r.git",
            "github.com:o/r",
            "https://github.com/o/r",
            "https://github.com/o/r.git/",
            "https://x:token@github.com/o/r.git",
            "ssh://git@ssh.github.com:443/o/r.git",
            "git://GitHub.com/o/r",
        ] {
            assert_eq!(github_repo(url).as_deref(), Some("o/r"), "{url}");
        }
        for url in ["git@gitlab.com:o/r.git", "https://example.com/github.com/o/r", "/srv/git/o/r.git", "./github.com:o/r", "https://github.com/o", "https://github.com/o/r/pull/1"] {
            assert_eq!(github_repo(url), None, "{url}");
        }
    }

    #[test]
    fn finds_the_github_remote_pull_requests_go_to() {
        crate::testing::run(async || {
            let repo = crate::testing::temp_dir();
            sh(&repo, &["init", "-q", "-b", "master"]);
            assert_eq!(github(&repo, Some("master")).await, None);
            sh(&repo, &["remote", "add", "history", "git@github.com:o/history.git"]);
            let only = Github { remote: "history".into(), repo: "o/history".into() };
            assert_eq!(github(&repo, Some("master")).await, Some(only));
            sh(&repo, &["remote", "add", "origin", "https://github.com/o/r.git"]);
            let origin = Github { remote: "origin".into(), repo: "o/r".into() };
            assert_eq!(github(&repo, Some("master")).await, Some(origin.clone()));
            assert_eq!(github(&repo, None).await, Some(origin));
            // The base branch's upstream comes first.
            sh(&repo, &["config", "branch.master.remote", "history"]);
            assert_eq!(github(&repo, Some("master")).await.map(|g| g.remote), Some("history".into()));
            sh(&repo, &["remote", "set-url", "history", "git@gitlab.com:o/history.git"]);
            assert_eq!(github(&repo, Some("master")).await, None);
            // It's where the branch is pushed that counts, not where it's fetched from.
            sh(&repo, &["remote", "set-url", "--push", "history", "git@github.com:o/mirror.git"]);
            assert_eq!(github(&repo, Some("master")).await.map(|g| g.repo), Some("o/mirror".into()));
            sh(&repo, &["remote", "set-url", "--push", "origin", "git@gitlab.com:o/r.git"]);
            assert_eq!(github(&repo, None).await, None);

            // The pull request is looked up where the branch is pushed, not where gh would look.
            let args = pr_view_args(&repo, Some("master"), "ia/x-1").await;
            assert_eq!(args, ["pr", "view", "ia/x-1", "--json", "url", "--repo", "o/mirror"]);
            sh(&repo, &["config", "--unset", "branch.master.remote"]);
            assert_eq!(pr_view_args(&repo, Some("master"), "ia/x-1").await, ["pr", "view", "ia/x-1", "--json", "url"]);
            std::fs::remove_dir_all(&repo).ok();
        })
    }

    #[test]
    fn an_ssh_host_alias_is_the_host_it_stands_for() {
        crate::testing::run(async || {
            let dir = crate::testing::temp_dir();
            let repo = dir.join("repo");
            std::fs::create_dir_all(&repo).unwrap();
            std::fs::write(dir.join("ssh_config"), "Host github-work\n  HostName github.com\n  IdentityFile ~/.ssh/work\nHost ghe\n  HostName GHE.acme.com\n").unwrap();
            SSH_CONFIG.set(Some(dir.join("ssh_config")));
            sh(&repo, &["init", "-q", "-b", "master"]);
            sh(&repo, &["remote", "add", "origin", "git@github-work:o/r.git"]);
            assert_eq!(push_repo(&repo, None).await, Some(("github.com".into(), "o/r".into())));
            assert_eq!(github(&repo, None).await.map(|g| g.repo), Some("o/r".into()));
            sh(&repo, &["remote", "set-url", "origin", "ssh://git@ghe/o/r.git"]);
            assert_eq!(push_repo(&repo, None).await, Some(("ghe.acme.com".into(), "o/r".into())));
            assert_eq!(github(&repo, None).await, None);
            // Only SSH remotes' hosts are aliases.
            sh(&repo, &["remote", "set-url", "origin", "https://github-work/o/r.git"]);
            assert_eq!(push_repo(&repo, None).await, Some(("github-work".into(), "o/r".into())));
            // A host the config doesn't name is as it is.
            sh(&repo, &["remote", "set-url", "origin", "git@gitlab.com:o/r.git"]);
            assert_eq!(push_repo(&repo, None).await, Some(("gitlab.com".into(), "o/r".into())));
            std::fs::remove_dir_all(&dir).ok();
        });
    }

    /// A repository (on master, ignoring target/) with a task whose worktree has a commit: the
    /// repository, the task and its worktree and branch.
    async fn task_with_work(s: &Shared) -> (PathBuf, Task, PathBuf, String) {
        let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let repo = crate::testing::temp_dir();
        sh(&repo, &["init", "-q", "-b", "master"]);
        std::fs::write(repo.join(".gitignore"), "target/\n").unwrap();
        sh(&repo, &["add", "."]);
        sh(&repo, &["commit", "-qm", "init"]);
        let b = CreateProject { name: "x".into(), repo_path: path_str(&repo), key: Some("X".into()), base_branch: Some("master".into()), use_worktrees: None };
        let p = create_project_inner(s, &profile.id, b).await.unwrap();
        let t = create_task_inner(s, &p.id, CreateTask { title: "Do it".into(), ..Default::default() }).unwrap();
        let t = setup(s, &t.id).await.unwrap();
        let (wt, branch) = (PathBuf::from(t.worktree_path.clone().unwrap()), t.branch.clone().unwrap());
        std::fs::write(wt.join("a"), "a").unwrap();
        sh(&wt, &["add", "a"]);
        sh(&wt, &["commit", "-qm", "a"]);
        (repo, t, wt, branch)
    }

    // HA-42: untracked files were listed without -z, so a name git quotes (not ASCII) or one starting
    // with `-` dropped out of the branch's diff.
    #[test]
    fn the_diff_has_every_untracked_file_whatever_its_name() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (repo, t, wt, _) = task_with_work(&s).await;
            for name in ["café.txt", "-n.txt", "plain.txt"] {
                std::fs::write(wt.join(name), format!("in {name}\n")).unwrap();
            }
            let d = diff(&s, &t.id).await.unwrap();
            let mut untracked: Vec<&str> = d["untracked"].as_array().unwrap().iter().map(|f| f.as_str().unwrap()).collect();
            untracked.sort();
            assert_eq!(untracked, ["-n.txt", "café.txt", "plain.txt"]);
            let patch = d["patch"].as_str().unwrap();
            for name in ["café.txt", "-n.txt", "plain.txt"] {
                assert!(patch.contains(&format!("+in {name}\n")), "{name}: {patch}");
            }
            std::fs::remove_dir_all(&repo).ok();
        })
    }

    // HA-51: a task whose worktree was removed showed the project folder's changes as its own.
    #[test]
    fn without_its_worktree_the_diff_is_its_branchs() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (repo, t, _, branch) = task_with_work(&s).await;
            std::fs::write(repo.join("main-only"), "not the task's\n").unwrap();
            teardown(&s, &t.id, false, false).await.unwrap();
            let d = diff(&s, &t.id).await.unwrap();
            assert_eq!((&d["available"], d["branch"].as_str()), (&json!(true), Some(branch.as_str())));
            let patch = d["patch"].as_str().unwrap();
            assert!(patch.contains("+++ b/a") && !patch.contains("main-only"), "{patch}");
            assert!(d["commits"].as_str().unwrap().contains(" a\n"), "{d}");
            assert_eq!(d["untracked"], json!([]));
            sh(&repo, &["branch", "-D", &branch]);
            let d = diff(&s, &t.id).await.unwrap();
            assert_eq!(d["available"], json!(false));
            assert!(d["reason"].as_str().unwrap().contains("is gone"), "{d}");
            std::fs::remove_dir_all(&repo).ok();
        })
    }

    // HA-90: a diff read while the worktree was being removed (as Pick this one removes the other tasks') failed
    // with a 500, as the git calls failed in the folder going away.
    #[test]
    fn a_worktree_removed_while_its_diff_is_read_shows_its_branch() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (repo, t, wt, branch) = task_with_work(&s).await;
            std::fs::write(wt.join("draft"), "uncommitted\n").unwrap();
            // As teardown does, and with the folder gone without the task knowing.
            for mark in [true, false] {
                let (s2, id, wt2) = (s.clone(), t.id.clone(), wt.clone());
                crate::testing::when("diff:read", move || {
                    if mark {
                        s2.update_task(&id, &[("worktree_state", json!("tearing_down"))]).unwrap();
                    }
                    std::fs::rename(&wt2, wt2.with_extension("gone")).unwrap();
                });
                let d = diff(&s, &t.id).await.unwrap();
                assert_eq!((&d["available"], d["branch"].as_str()), (&json!(true), Some(branch.as_str())), "{d}");
                assert!(d["patch"].as_str().unwrap().contains("+++ b/a"), "{d}");
                std::fs::rename(wt.with_extension("gone"), &wt).unwrap();
                s.update_task(&t.id, &[("worktree_state", json!("ready"))]).unwrap();
                // Back in place, it's the worktree's again, uncommitted work and all.
                let d = diff(&s, &t.id).await.unwrap();
                assert!(d["branch"].is_null() && d["untracked"] == json!(["draft"]), "{d}");
            }
            std::fs::remove_dir_all(&repo).ok();
        })
    }

    fn kept(why: &str) -> Removal {
        Removal::Kept(why.to_string())
    }

    #[test]
    fn removes_a_done_tasks_worktree_once_merged_and_clean() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (repo, t, wt, branch) = task_with_work(&s).await;
            let remove = async || remove_if_merged(&s, &t.id, true).await.unwrap();

            assert_eq!(remove().await, kept("it isn't done"));
            db::update_task(&s.db(), &t.id, &[("status", json!("done"))]).unwrap();
            assert_eq!(remove().await, kept("its work isn't merged into master"));
            sh(&repo, &["merge", "-q", "--no-ff", "-m", "merge", &branch]);
            // Untracked files would be lost, even when git status is set not to show them; ignored
            // ones (build output) wouldn't matter.
            sh(&repo, &["config", "status.showUntrackedFiles", "no"]);
            std::fs::write(wt.join("notes"), "n").unwrap();
            assert_eq!(remove().await, kept("it has 1 uncommitted or untracked file"));
            std::fs::remove_file(wt.join("notes")).unwrap();
            std::fs::create_dir_all(wt.join("target")).unwrap();
            std::fs::write(wt.join("target/out"), "o").unwrap();
            assert_eq!(remove().await, Removal::Removed("master".into()));

            assert!(!wt.exists());
            let t = db::get_task(&s.db(), &t.id).unwrap().unwrap();
            assert_eq!((t.status.as_str(), t.worktree_state.as_str(), t.branch.as_deref()), ("done", "none", Some(branch.as_str())));
            assert!(git(&repo, &["rev-parse", "--verify", &format!("refs/heads/{branch}")]).await.unwrap().ok);
            assert_eq!(remove().await, kept("it has no worktree"));

            // Run again (after a rename), it gets its folder back, on its branch.
            db::update_task(&s.db(), &t.id, &[("title", json!("Renamed")), ("status", json!("in_progress"))]).unwrap();
            let t = setup(&s, &t.id).await.unwrap();
            assert_eq!(t.worktree_path.as_deref(), Some(path_str(&wt).as_str()));
            assert_eq!(current_branch(&wt).await.as_deref(), Some(branch.as_str()));

            // The project's sweep removes it once it's done again, and leaves other tasks alone.
            let pid = t.project_id.clone().unwrap();
            let other = create_task_inner(&s, &pid, CreateTask { title: "Other".into(), ..Default::default() }).unwrap();
            let other = setup(&s, &other.id).await.unwrap();
            assert!(remove_merged(&s, &pid).await.unwrap().is_empty());
            db::update_task(&s.db(), &t.id, &[("status", json!("done"))]).unwrap();
            let results = remove_merged(&s, &pid).await.unwrap();
            assert_eq!(results.len(), 1);
            assert_eq!((&results[0]["task_id"], &results[0]["removed"], &results[0]["detail"]), (&json!(t.id), &json!(true), &json!("merged into master")));
            assert!(!wt.exists());
            assert!(Path::new(other.worktree_path.as_deref().unwrap()).exists());
            std::fs::remove_dir_all(&repo).ok();
        })
    }

    #[test]
    fn a_branch_merged_upstream_counts_as_merged() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
            let root = crate::testing::temp_dir();
            let (origin, repo, other) = (root.join("origin"), root.join("repo"), root.join("other"));
            std::fs::create_dir_all(&root).unwrap();
            sh(&root, &["init", "-q", "--bare", "-b", "master", &path_str(&origin)]);
            sh(&root, &["clone", "-q", &path_str(&origin), &path_str(&repo)]);
            sh(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
            sh(&repo, &["push", "-q", "-u", "origin", "master"]);
            let b = CreateProject { name: "x".into(), repo_path: path_str(&repo), key: Some("X".into()), base_branch: Some("master".into()), use_worktrees: None };
            let p = create_project_inner(&s, &profile.id, b).await.unwrap();
            let t = create_task_inner(&s, &p.id, CreateTask { title: "Do it".into(), ..Default::default() }).unwrap();
            let t = setup(&s, &t.id).await.unwrap();
            let (wt, branch) = (PathBuf::from(t.worktree_path.clone().unwrap()), t.branch.clone().unwrap());
            sh(&wt, &["commit", "-q", "--allow-empty", "-m", "work"]);
            sh(&wt, &["push", "-q", "origin", &branch]);
            db::update_task(&s.db(), &t.id, &[("status", json!("done"))]).unwrap();
            assert_eq!(remove_if_merged(&s, &t.id, true).await.unwrap(), kept("its work isn't merged into master"));

            // Merged elsewhere (as a pull request is), so the local master is behind.
            sh(&root, &["clone", "-q", &path_str(&origin), &path_str(&other)]);
            sh(&other, &["merge", "-q", "--no-ff", "-m", "merge", &format!("origin/{branch}")]);
            sh(&other, &["push", "-q", "origin", "master"]);
            // The sweep fetches it.
            let results = remove_merged(&s, &p.id).await.unwrap();
            assert_eq!((&results[0]["removed"], &results[0]["detail"]), (&json!(true), &json!("merged into origin/master")));
            assert!(!wt.exists());
            std::fs::remove_dir_all(&root).ok();
        })
    }

    // HA-32: setup took over any folder at the worktree's path, and a forced teardown removed whatever was
    // there when git wouldn't, so a shared or misconfigured worktrees folder could cost work kept elsewhere.
    #[test]
    fn a_folder_in_the_worktrees_way_is_neither_adopted_nor_removed() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
            let root = crate::testing::temp_dir();
            let repo = root.join("repo");
            std::fs::create_dir_all(&repo).unwrap();
            sh(&repo, &["init", "-q", "-b", "master"]);
            std::fs::write(repo.join("notes"), "1").unwrap();
            sh(&repo, &["add", "notes"]);
            sh(&repo, &["commit", "-qm", "init"]);
            let b = CreateProject { name: "x".into(), repo_path: path_str(&repo), key: Some("X".into()), base_branch: Some("master".into()), use_worktrees: None };
            let p = create_project_inner(&s, &profile.id, b).await.unwrap();
            let t = create_task_inner(&s, &p.id, CreateTask { title: "fix it".into(), ..Default::default() }).unwrap();
            // Someone's folder where the task's worktree would go.
            let wt = PathBuf::from(&p.worktrees_root).join(folder_name(&p, &t));
            std::fs::create_dir_all(&wt).unwrap();
            std::fs::write(wt.join("precious"), "mine").unwrap();
            let err = setup(&s, &t.id).await.unwrap_err().to_string();
            assert!(err.contains("in the way"), "{err}");
            assert_eq!(std::fs::read_to_string(wt.join("precious")).unwrap(), "mine");
            let t = db::get_task(&s.db(), &t.id).unwrap().unwrap();
            assert_eq!((t.worktree_state.as_str(), t.worktree_path), ("error", None), "the failure is the task's to show, the folder nobody's");

            // Only a folder inside the worktrees folder, other than a main checkout, is removed by hand.
            assert!(removable_by_hand(&p, &repo, &wt).await, "a stray folder in the worktrees folder");
            assert!(!removable_by_hand(&p, &repo, &repo).await, "the repository");
            assert!(!removable_by_hand(&p, &repo, &root).await, "outside the worktrees folder");
            assert!(!removable_by_hand(&p, &repo, Path::new(&p.worktrees_root)).await, "the worktrees folder itself");
            let checkout = PathBuf::from(&p.worktrees_root).join("checkout");
            sh(&root, &["clone", "-q", &path_str(&repo), &path_str(&checkout)]);
            assert!(!removable_by_hand(&p, &repo, &checkout).await, "another main checkout");
            std::fs::remove_dir_all(&root).ok();
        })
    }

    #[test]
    fn a_task_with_commits_its_base_lacks_is_unmerged() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
            let repo = crate::testing::temp_dir();
            sh(&repo, &["init", "-q", "-b", "master"]);
            sh(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
            let b = CreateProject { name: "x".into(), repo_path: path_str(&repo), key: Some("X".into()), base_branch: Some("master".into()), use_worktrees: None };
            let p = create_project_inner(&s, &profile.id, b).await.unwrap();
            let t = create_task_inner(&s, &p.id, CreateTask { title: "Do it".into(), ..Default::default() }).unwrap();
            let t = setup(&s, &t.id).await.unwrap();
            let (wt, branch) = (PathBuf::from(t.worktree_path.clone().unwrap()), t.branch.clone().unwrap());
            // Nothing done yet.
            assert!(!unmerged(&s, &t).await);
            std::fs::write(wt.join("notes"), "1").unwrap();
            assert!(unmerged(&s, &t).await);
            sh(&wt, &["add", "notes"]);
            sh(&wt, &["commit", "-qm", "work"]);
            assert!(unmerged(&s, &t).await);
            // A document is kept by the board, not merged.
            let doc = db::update_task(&s.db(), &t.id, &[("task_type", json!("plan"))]).unwrap().unwrap();
            assert!(!unmerged(&s, &doc).await);
            let t = db::update_task(&s.db(), &t.id, &[("task_type", Value::Null)]).unwrap().unwrap();
            sh(&repo, &["merge", "-q", "--no-ff", "-m", "merge", &branch]);
            assert!(!unmerged(&s, &t).await);
            std::fs::remove_dir_all(&repo).ok();
        })
    }

    #[test]
    fn task_branches_start_from_the_latest_base() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
            let root = crate::testing::temp_dir();
            let (origin, repo, other) = (root.join("origin"), root.join("repo"), root.join("other"));
            std::fs::create_dir_all(&root).unwrap();
            sh(&root, &["init", "-q", "--bare", "-b", "master", &path_str(&origin)]);
            sh(&root, &["clone", "-q", &path_str(&origin), &path_str(&repo)]);
            std::fs::write(repo.join("notes"), "1").unwrap();
            sh(&repo, &["add", "notes"]);
            sh(&repo, &["commit", "-qm", "init"]);
            sh(&repo, &["push", "-q", "-u", "origin", "master"]);
            sh(&root, &["clone", "-q", &path_str(&origin), &path_str(&other)]);
            // Someone else pushes to master.
            let push = |file: &str| {
                std::fs::write(other.join(file), crate::util::new_id()).unwrap();
                sh(&other, &["add", file]);
                sh(&other, &["commit", "-qm", file]);
                sh(&other, &["push", "-q", "origin", "HEAD"]);
                rev(&other, "HEAD")
            };
            let b = CreateProject { name: "x".into(), repo_path: path_str(&repo), key: Some("X".into()), base_branch: Some("master".into()), use_worktrees: None };
            let p = create_project_inner(&s, &profile.id, b).await.unwrap();
            // A task's worktree: the task, the commit it starts from, whether its branch tracks
            // anything, and its log's warnings and notes. It has nothing of its own to show or merge.
            let task = async |title: &str, base: Option<&str>| {
                let t = create_task_inner(&s, &p.id, CreateTask { title: title.into(), ..Default::default() }).unwrap();
                db::update_task(&s.db(), &t.id, &[("base_branch", json!(base))]).unwrap();
                let t = setup(&s, &t.id).await.unwrap();
                let wt = PathBuf::from(t.worktree_path.clone().unwrap());
                let tracks = git(&wt, &["rev-parse", "--abbrev-ref", "@{upstream}"]).await.unwrap().ok;
                let log: Vec<String> = db::list_messages(&s.db(), &t.id).unwrap().iter().filter(|m| m.kind == "event").map(|m| m.data["text"].as_str().unwrap().to_string()).collect();
                assert!(!has_work_to_merge(&s, &t).await, "{title}");
                let d = diff(&s, &t.id).await.unwrap();
                assert_eq!((&d["merge_base"], &d["commits"], &d["patch"]), (&json!(rev(&wt, "HEAD")), &json!(""), &json!("")), "{title}");
                (t, rev(&wt, "HEAD"), tracks, log.join("\n"))
            };
            let compared = async |base: &str| compare_ref(&repo, base).await;

            // The main checkout is on master, with a change in the way of pulling it.
            let latest = push("notes");
            std::fs::write(repo.join("notes"), "mine").unwrap();
            let (_, head, tracks, log) = task("Dirty", None).await;
            assert_eq!(head, latest, "{log}");
            assert_eq!(compared("master").await, "origin/master");
            assert!(!tracks);
            assert!(log.contains("Branching from origin/master, 1 commit ahead of master, which couldn't be fast-forwarded"), "{log}");
            assert!(log.contains("(from origin/master)"), "{log}");
            assert_ne!(rev(&repo, "master"), latest);
            assert_eq!(std::fs::read_to_string(repo.join("notes")).unwrap(), "mine");

            // Clean, it's pulled.
            sh(&repo, &["checkout", "-q", "notes"]);
            let latest = push("b");
            let (_, head, _, log) = task("Clean", None).await;
            assert_eq!((head, rev(&repo, "master")), (latest.clone(), latest.clone()));
            assert_eq!(compared("master").await, "master");
            assert!(log.contains("Pulled master from origin/master (2 new commits)"), "{log}");

            // Local commits that aren't pushed are kept.
            sh(&repo, &["commit", "-q", "--allow-empty", "-m", "local"]);
            let local = rev(&repo, "master");
            let (_, head, _, log) = task("Ahead", None).await;
            assert_eq!(head, local, "{log}");
            assert_eq!(compared("master").await, "master");

            // Diverged: the upstream, where its pull request goes.
            let latest = push("c");
            let (_, head, _, log) = task("Diverged", None).await;
            assert_eq!(head, latest);
            assert_eq!(compared("master").await, "origin/master");
            assert!(log.contains("master has diverged from origin/master; branching from origin/master, without the 1 commit only master has"), "{log}");
            assert_eq!(rev(&repo, "master"), local);

            // Pushed without -u, the branch of the same name on origin counts.
            sh(&repo, &["reset", "-q", "--hard", "origin/master"]);
            sh(&repo, &["branch", "-q", "--unset-upstream"]);
            let latest = push("d");
            let (_, head, _, log) = task("No upstream", None).await;
            assert_eq!(head, latest, "{log}");
            assert_eq!(compared("master").await, "master");

            // A base branch only on the remote.
            sh(&other, &["push", "-q", "origin", "HEAD:dev"]);
            let (t, head, tracks, log) = task("Remote only", Some("dev")).await;
            assert_eq!(head, latest, "{log}");
            assert!(!tracks && log.contains("(from origin/dev)"), "{log}");
            assert_eq!(compared("dev").await, "origin/dev");
            // Its work shows up in its diff.
            let wt = PathBuf::from(t.worktree_path.clone().unwrap());
            std::fs::write(wt.join("feature"), "f").unwrap();
            sh(&wt, &["add", "feature"]);
            sh(&wt, &["commit", "-qm", "feature"]);
            let d = diff(&s, &t.id).await.unwrap();
            assert_eq!(d["merge_base"], json!(latest));
            assert_eq!(d["commits"].as_str().unwrap().lines().count(), 1);
            assert!(d["patch"].as_str().unwrap().contains("+++ b/feature"));

            // Unreachable, it goes by the last fetch.
            sh(&repo, &["remote", "set-url", "origin", &path_str(&root.join("gone"))]);
            push("e");
            let (_, head, _, log) = task("Offline", None).await;
            assert_eq!(head, latest, "{log}");
            assert!(log.contains("Could not fetch origin/master; branching from the copy fetched before"), "{log}");
            std::fs::remove_dir_all(&root).ok();
        })
    }

    #[test]
    fn worktree_fetches_use_the_project_account_before_the_profile_account() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (repo, task, _, _) = task_with_work(&s).await;
            let gh = repo.join("fake-gh");
            // No real login or network: make gh fail and identify the account it was asked for.
            std::fs::write(&gh, "#!/bin/sh\necho \"$*\" >&2\nexit 1\n").unwrap();
            std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).unwrap();
            crate::gh_mcp::TEST_GH_PROGRAM.set(Some(path_str(&gh)));
            sh(&repo, &["remote", "add", "origin", "https://github.com/o/r.git"]);
            sh(&repo, &["update-ref", "refs/remotes/origin/master", "master"]);
            sh(&repo, &["branch", "--set-upstream-to=origin/master", "master"]);
            let pid = task.project_id.as_ref().unwrap();
            s.db().execute("UPDATE profiles SET github_account='profile-login' WHERE id=?1", [&task.profile_id]).unwrap();
            s.db().execute("UPDATE projects SET github_account='project-login' WHERE id=?1", [pid]).unwrap();
            for (title, expected) in [("Project account", "project-login"), ("Profile account", "profile-login")] {
                let t = create_task_inner(&s, pid, CreateTask { title: title.into(), ..Default::default() }).unwrap();
                let t = setup(&s, &t.id).await.unwrap();
                let log = db::list_messages(&s.db(), &t.id).unwrap();
                let warning = log.iter().find(|m| m.kind == "event" && m.data["level"] == "warn").unwrap();
                let detail = warning.data["detail"].as_str().unwrap();
                assert!(detail.contains(&format!("--user={expected}")), "{detail}");
                assert_eq!(rev(Path::new(t.worktree_path.as_ref().unwrap()), "HEAD"), rev(&repo, "master"));
                s.db().execute("UPDATE projects SET github_account=NULL WHERE id=?1", [pid]).unwrap();
            }
            crate::gh_mcp::TEST_GH_PROGRAM.set(None);
            std::fs::remove_dir_all(&repo).ok();
        })
    }

    fn rev(dir: &Path, rev: &str) -> String {
        let out = std::process::Command::new("git").arg("-C").arg(dir).args(["rev-parse", rev]).output().unwrap();
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    }

    #[test]
    fn keeps_what_the_teardown_script_leaves() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (repo, t, wt, branch) = task_with_work(&s).await;
            sh(&repo, &["merge", "-q", "--no-ff", "-m", "merge", &branch]);
            db::update_task(&s.db(), &t.id, &[("status", json!("done"))]).unwrap();
            let pid = t.project_id.clone().unwrap();
            s.db().execute("UPDATE projects SET teardown_script='printf backup > notes' WHERE id=?1", [&pid]).unwrap();

            let e = remove_if_merged(&s, &t.id, true).await.unwrap_err();
            assert!(format!("{e:#}").contains("notes"), "{e:#}");
            assert_eq!(std::fs::read_to_string(wt.join("notes")).unwrap(), "backup");
            assert_eq!(db::get_task(&s.db(), &t.id).unwrap().unwrap().worktree_state, "ready");
            // The sweep says why.
            std::fs::remove_file(wt.join("notes")).unwrap();
            let results = remove_merged(&s, &pid).await.unwrap();
            assert_eq!(results[0]["removed"], json!(false));
            assert!(results[0]["detail"].as_str().unwrap().contains("teardown script left uncommitted changes"));
            std::fs::remove_dir_all(&repo).ok();
        })
    }

    #[test]
    fn keeps_it_while_a_reviewer_works_in_it() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (repo, t, wt, branch) = task_with_work(&s).await;
            sh(&repo, &["merge", "-q", "--no-ff", "-m", "merge", &branch]);
            let r = db::NewTask { profile_id: &t.profile_id, project_id: t.project_id.as_deref(), kind: "review", title: "Review", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
            let r = db::insert_task(&s.db(), r).unwrap();
            db::update_task(&s.db(), &r.id, &[("parent_id", json!(t.id)), ("running", json!(true))]).unwrap();
            db::update_task(&s.db(), &t.id, &[("status", json!("done"))]).unwrap();

            assert_eq!(remove_if_merged(&s, &t.id, true).await.unwrap(), kept("an agent is working in it"));
            assert!(wt.exists());
            db::update_task(&s.db(), &r.id, &[("running", json!(false))]).unwrap();
            assert_eq!(remove_if_merged(&s, &t.id, true).await.unwrap(), Removal::Removed("master".into()));
            std::fs::remove_dir_all(&repo).ok();
        })
    }

    #[test]
    fn keeps_changes_git_status_is_told_to_skip() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (repo, t, wt, branch) = task_with_work(&s).await;
            sh(&repo, &["merge", "-q", "--no-ff", "-m", "merge", &branch]);
            db::update_task(&s.db(), &t.id, &[("status", json!("done"))]).unwrap();
            let remove = async || remove_if_merged(&s, &t.id, true).await.unwrap();

            // Marked but unchanged, it's clean.
            sh(&wt, &["update-index", "--assume-unchanged", "a"]);
            sh(&wt, &["update-index", "--skip-worktree", ".gitignore"]);
            assert_eq!(uncommitted(&wt).await.unwrap(), "");
            for (file, mark) in [("a", "assume-unchanged"), (".gitignore", "skip-worktree")] {
                std::fs::write(wt.join(file), "local edit").unwrap();
                assert!(uncommitted(&wt).await.unwrap().contains(&format!("{file} (marked {mark})")));
                assert_eq!(remove().await, kept("it has 1 uncommitted or untracked file"));
                assert_eq!(std::fs::read_to_string(wt.join(file)).unwrap(), "local edit");
                sh(&wt, &["update-index", &format!("--no-{mark}"), file]);
                sh(&wt, &["checkout", "--", file]);
            }
            // The sweep keeps it too.
            sh(&wt, &["update-index", "--assume-unchanged", "a"]);
            std::fs::write(wt.join("a"), "local edit").unwrap();
            let results = remove_merged(&s, t.project_id.as_deref().unwrap()).await.unwrap();
            assert_eq!((&results[0]["removed"], &results[0]["detail"]), (&json!(false), &json!("it has 1 uncommitted or untracked file")));
            assert_eq!(std::fs::read_to_string(wt.join("a")).unwrap(), "local edit");
            // A skip-worktree file that isn't there (as in a sparse checkout) has nothing to lose.
            sh(&wt, &["update-index", "--no-assume-unchanged", "a"]);
            sh(&wt, &["checkout", "--", "a"]);
            sh(&wt, &["update-index", "--skip-worktree", "a"]);
            std::fs::remove_file(wt.join("a")).unwrap();
            assert_eq!(remove().await, Removal::Removed("master".into()));
            std::fs::remove_dir_all(&repo).ok();
        })
    }

    #[test]
    fn keeps_mode_changes_and_files_whatever_their_names() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (repo, t, wt, branch) = task_with_work(&s).await;
            let odd = OsStr::from_bytes(b"config-\xff");
            std::fs::write(wt.join(odd), "x").unwrap();
            sh(&wt, &["add", "."]);
            sh(&wt, &["commit", "-qm", "odd"]);
            sh(&repo, &["merge", "-q", "--no-ff", "-m", "merge", &branch]);
            db::update_task(&s.db(), &t.id, &[("status", json!("done"))]).unwrap();
            let pid = t.project_id.clone().unwrap();
            let mark = |file: &OsStr, flag: &str| {
                let ok = std::process::Command::new("git").arg("-C").arg(&wt).args(["update-index", flag, "--"]).arg(file).status().unwrap().success();
                assert!(ok, "git update-index {flag}");
            };
            let teardown_script = |script: &str| {
                s.db().execute("UPDATE projects SET teardown_script=?1 WHERE id=?2", [script, &pid]).unwrap();
            };
            let chmod = |file: &str, mode: u32| std::fs::set_permissions(wt.join(file), std::fs::Permissions::from_mode(mode)).unwrap();
            let sweep = async || {
                let results = remove_merged(&s, &pid).await.unwrap();
                (results[0]["removed"].clone(), results[0]["detail"].clone())
            };
            let one_file = (json!(false), json!("it has 1 uncommitted or untracked file"));

            // Only the executable bit of a marked file changed.
            mark(OsStr::new("a"), "--assume-unchanged");
            chmod("a", 0o755);
            assert_eq!(sweep().await, one_file);
            chmod("a", 0o644);
            assert_eq!(uncommitted(&wt).await.unwrap(), "");
            // ...by the teardown script.
            teardown_script("chmod +x a");
            let e = remove_if_merged(&s, &t.id, true).await.unwrap_err();
            assert!(format!("{e:#}").contains("a (marked assume-unchanged)"), "{e:#}");
            assert_eq!(db::get_task(&s.db(), &t.id).unwrap().unwrap().worktree_state, "ready");
            chmod("a", 0o644);
            teardown_script("");

            // A marked file whose name isn't UTF-8.
            mark(odd, "--skip-worktree");
            std::fs::write(wt.join(odd), "local edit").unwrap();
            assert_eq!(sweep().await, one_file);
            assert_eq!(std::fs::read_to_string(wt.join(odd)).unwrap(), "local edit");
            std::fs::write(wt.join(odd), "x").unwrap();
            assert_eq!(uncommitted(&wt).await.unwrap(), "");
            // ...edited by the teardown script.
            teardown_script(r"printf more >> config-$'\xff'");
            let e = remove_if_merged(&s, &t.id, true).await.unwrap_err();
            assert!(format!("{e:#}").contains("config-"), "{e:#}");
            assert_eq!(std::fs::read_to_string(wt.join(odd)).unwrap(), "xmore");
            assert!(wt.exists());
            std::fs::remove_dir_all(&repo).ok();
        })
    }
}
