//! A task's changes: what they're compared with (`changes_base`, its start ref) and `diff`.

use super::*;

/// Where a task's changes are: its worktree once it's ready, else the project's repository.
pub fn changes_dir(state: &Shared, task_id: &str) -> Result<(PathBuf, Task, Project)> {
    let (task, project) = load(state, task_id)?;
    let dir = match (&task.worktree_path, task.worktree_state.as_str()) {
        (Some(p), "ready") => PathBuf::from(p),
        _ => PathBuf::from(&project.repo_path),
    };
    Ok((dir, task, project))
}

/// Where a task that started from elsewhere (see db::StartFrom) started, kept in its repository so
/// its changes can be told from what it started on whatever happens to that (a branch deleted once
/// merged, say): the commit its branch was made at, moved on to the branch it's stacked on as the
/// task takes in more of that (see `changes_base`). It goes with the task.
pub(super) fn start_ref(task_id: &str) -> String {
    format!("refs/huntaway/start/{task_id}")
}

/// Drop a deleted task's start ref (see `start_ref`) from `repo`, if it has one.
pub async fn forget_start(repo: &Path, task_id: &str) {
    let _ = git(repo, &["update-ref", "-d", &start_ref(task_id)]).await;
}

/// Move task `task`'s start ref (see `start_ref`) on to as much of the branch it's stacked on as the
/// task's work at `head` in `dir` has taken in (that branch may have more since), while that branch
/// is there, so what it took in of it later isn't counted as its own either, even once it's gone.
async fn keep_start(dir: &Path, task: &Task, head: &str) {
    let kept = start_ref(&task.id);
    let (Some(at), Some(b)) = (commit(dir, &kept).await, task.base_branch.as_ref()) else { return };
    let tip = compare_ref(dir, b).await;
    let Some(taken) = git(dir, &["merge-base", &tip, head]).await.ok().filter(|o| o.ok).map(|o| o.stdout.trim().to_string()) else { return };
    if taken != at && is_ancestor(dir, &at, &taken).await {
        let _ = git(dir, &["update-ref", &kept, &taken, &at]).await;
    }
}

/// `keep_start` for task `task_id`'s branch and those of the tasks stacked on it. Called as its agent's
/// run ends, when it's done and before its worktree or branch goes, so its own start, and theirs on its
/// branch, keep up without anyone reading their changes before that branch is deleted.
pub async fn keep_starts(state: &Shared, task_id: &str) {
    let found = {
        let c = state.db();
        let mut tasks = db::stacked_on(&c, task_id).unwrap_or_default();
        tasks.extend(db::get_task(&c, task_id).ok().flatten());
        tasks
            .into_iter()
            .filter(|t| t.start_from.is_some())
            .filter_map(|t| {
                let p = t.project_id.as_deref().and_then(|p| db::get_project(&c, p).ok().flatten())?;
                let branch = t.branch.clone().filter(|b| !b.is_empty())?;
                Some((t, p.repo_path, branch))
            })
            .collect::<Vec<_>>()
    };
    for (t, repo, branch) in found {
        keep_start(Path::new(&repo), &t, &format!("refs/heads/{branch}")).await;
    }
}

/// The base branch a task's changes are compared with (see db::task_base), and where its work
/// starts (only known in the task's own worktree): its merge base with the base branch or, when it
/// started from somewhere else that's later, that. That's where it started (see `start_ref`) or a
/// commit it started from that the base branch doesn't have, or the branch of the task it's
/// stacked on once that's merged, until it's brought up to date with where that went (which
/// squashed or rebased it, say, or deleted its branch).
pub async fn changes_base(state: &Shared, dir: &Path, task: &Task, project: &Project) -> (Option<String>, Option<String>) {
    if task.worktree_state != "ready" {
        return (db::task_base(&state.db(), task, Some(project)), None);
    }
    changes_base_at(state, dir, task, project, "HEAD").await
}

/// What a review or a summary of a task's work in its worktree `dir` compares it with: its base
/// branch (that or its upstream, see `compare_ref`) or, for a task started from somewhere else (a
/// commit its base branch doesn't have, a task stacked on that's merged since), the commit where the
/// Changes tab has its work start. True when that's later than where it left its base branch, so a
/// pull request's diff has more than its own work.
pub async fn work_scope(state: &Shared, dir: &Path, task: &Task, project: &Project) -> (Option<String>, bool) {
    let base = db::task_base(&state.db(), task, Some(project));
    let base = match base {
        Some(b) => Some(compare_ref(dir, &b).await),
        None => None,
    };
    if task.start_from.is_none() {
        return (base, false);
    }
    let Some(start) = changes_base(state, dir, task, project).await.1 else { return (base, false) };
    let left = match &base {
        Some(b) => git(dir, &["merge-base", b, "HEAD"]).await.ok().filter(|o| o.ok).map(|o| o.stdout.trim().to_string()),
        None => None,
    };
    let later = left.as_deref() != Some(start.as_str());
    (Some(start), later)
}

/// `changes_base` for the task's work at `head` in `dir` (its worktree's HEAD, or its branch when it has no worktree).
async fn changes_base_at(state: &Shared, dir: &Path, task: &Task, project: &Project, head: &str) -> (Option<String>, Option<String>) {
    let base = db::task_base(&state.db(), task, Some(project));
    let mut from = Vec::new();
    // The task may have started from the base branch's upstream.
    if let Some(b) = &base {
        from.push(compare_ref(dir, b).await);
    }
    match &task.start_from {
        Some(db::StartFrom::Task { .. }) => {
            if let Some(b) = task.base_branch.as_ref().filter(|b| Some(*b) != base.as_ref()) {
                from.push(compare_ref(dir, b).await);
            }
        }
        Some(db::StartFrom::Commit { commit: c }) => from.push(c.clone()),
        _ => {}
    }
    if task.start_from.is_some() {
        let kept = start_ref(&task.id);
        keep_start(dir, task, head).await;
        if commit(dir, &kept).await.is_some() {
            from.push(kept);
        }
    }
    let mut start: Option<String> = None;
    for rev in from {
        let Some(mb) = git(dir, &["merge-base", &rev, head]).await.ok().filter(|o| o.ok).map(|o| o.stdout.trim().to_string()) else { continue };
        start = match start {
            Some(s) if !is_ancestor(dir, &s, &mb).await => Some(s),
            _ => Some(mb),
        };
    }
    (base, start)
}

/// Diff of the task's work against the merge-base with its base branch,
/// including uncommitted and untracked changes.
pub async fn diff(state: &Shared, task_id: &str) -> Result<Value> {
    let (dir, task, project) = changes_dir(state, task_id)?;
    // A task with a worktree of its own that isn't there (not set up yet, or removed, even since the task was loaded, as a
    // teardown does while it's read): what its branch has, if anything, rather than the project folder's changes, which
    // aren't its own.
    let repo = Path::new(&project.repo_path);
    let gone = || task.use_worktree && (task.worktree_state != "ready" || !dir.exists());
    let from = if gone() { repo } else { &dir };
    if !is_git_repo(from).await {
        return Ok(json!({"available": false, "reason": "not a git repository"}));
    }
    if gone() {
        return branch_diff(state, repo, &task, &project).await;
    }
    match dir_diff(state, &dir, &task, &project).await {
        Err(_) if gone() => branch_diff(state, repo, &task, &project).await,
        r => r,
    }
}

/// `diff` of the changes in `dir`, the task's worktree or the project's folder.
async fn dir_diff(state: &Shared, dir: &Path, task: &Task, project: &Project) -> Result<Value> {
    #[cfg(test)]
    crate::testing::reached("diff:read");
    let (base, merge_base) = changes_base(state, dir, task, project).await;
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
async fn branch_diff(state: &Shared, repo: &Path, task: &Task, project: &Project) -> Result<Value> {
    let Some(branch) = task.branch.clone().filter(|b| !b.is_empty()) else {
        return Ok(json!({"available": false, "reason": "the task has no worktree or branch"}));
    };
    let head = format!("refs/heads/{branch}");
    if !git(repo, &["rev-parse", "--verify", "--quiet", &head]).await?.ok {
        return Ok(json!({"available": false, "reason": format!("the task has no worktree, and its branch {branch} is gone")}));
    }
    let (base, merge_base) = changes_base_at(state, repo, task, project, &head).await;
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
