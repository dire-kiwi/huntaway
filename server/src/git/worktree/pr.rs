//! A task's pull request and its work to merge: `has_work_to_merge`, `unmerged`, approvals, and
//! looking up its pull request with gh (`find_pr`).

use super::*;

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
    let base = db::task_base(&state.db(), task, Some(&project));
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
        let env = crate::agent::runner::task_gh_env(state, task).await.ok()?;
        gh_json(Path::new(&project.repo_path), &["pr", "view", &url, "--json", "state"], env.as_ref()).await
    };
    !matches!(tokio::time::timeout(Duration::from_secs(5), pr).await, Ok(Some(pr)) if pr["state"] == "MERGED")
}

/// Whether the setting that a task needs an approving review on its pull request to go to
/// "Ready for merge" applies to `task`: its project's, or else its profile's (API 95). It doesn't
/// where the task's merge goes through no pull request (the project's settings open none for it).
pub async fn pr_approval_required(state: &Shared, task: &Task) -> bool {
    let (project, required) = {
        let c = state.db();
        let project = task.project_id.as_deref().and_then(|id| db::get_project(&c, id).ok().flatten());
        let in_subproject = task.parent_id.as_deref().and_then(|id| db::get_task(&c, id).ok().flatten()).is_some_and(|t| t.subproject);
        let required = match project.as_ref().and_then(|p| p.require_pr_approval) {
            Some(on) => on,
            None => db::get_profile(&c, &task.profile_id).ok().flatten().is_some_and(|p| p.require_pr_approval),
        };
        (project.filter(|p| p.pull_requests(in_subproject)), required)
    };
    // Agents open a pull request only for a task with its own branch, in a repository pushed to GitHub (see agent/runner/launch.rs).
    let Some(project) = project.filter(|_| required && task.branch.is_some()) else { return false };
    let base = remote_base(state, task, &project).await;
    github(Path::new(&project.repo_path), base.as_deref()).await.is_some()
}

/// Whether a pull request (as `gh pr view --json reviewDecision,reviews` prints it) is approved:
/// GitHub's decision if it has one, else each reviewer's standing verdict from their reviews in order
/// (comments keep it, a dismissal clears it) is an approval with no change request standing.
pub fn approved_by_reviews(pr: &Value) -> bool {
    match pr["reviewDecision"].as_str() {
        Some("APPROVED") => return true,
        // Required reviews GitHub doesn't count as met (too few, or not from people who can write), or changes asked for.
        Some("CHANGES_REQUESTED" | "REVIEW_REQUIRED") => return false,
        _ => {}
    }
    let mut verdicts: std::collections::HashMap<&str, &str> = Default::default();
    for r in pr["reviews"].as_array().into_iter().flatten() {
        let (Some(who), Some(state)) = (r["author"]["login"].as_str(), r["state"].as_str()) else { continue };
        // Anyone can review a public repository's pull request: only those with a say in the repository count.
        if state == "APPROVED" && !["OWNER", "MEMBER", "COLLABORATOR"].contains(&r["authorAssociation"].as_str().unwrap_or("")) {
            continue;
        }
        match state {
            "APPROVED" | "CHANGES_REQUESTED" => drop(verdicts.insert(who, state)),
            "DISMISSED" => drop(verdicts.remove(who)),
            _ => {}
        }
    }
    verdicts.values().any(|v| *v == "APPROVED") && !verdicts.values().any(|v| *v == "CHANGES_REQUESTED")
}

/// Whether the pull request at `url` (the one the task will have) is approved on GitHub. Err says why
/// it can't be told (no pull request, or GitHub couldn't be read).
pub async fn pr_approved(state: &Shared, task: &Task, url: Option<&str>) -> Result<bool, String> {
    let Some(url) = url else { return Err("the task has no pull request yet; open one and get it approved on GitHub first".into()) };
    let project = task.project_id.as_deref().and_then(|id| db::get_project(&state.db(), id).ok().flatten()).ok_or("the task has no project")?;
    let env = crate::agent::runner::task_gh_env(state, task).await.map_err(|e| format!("couldn't read the pull request: {e:#}"))?;
    let pr = gh_json(Path::new(&project.repo_path), &["pr", "view", url, "--json", "reviewDecision,reviews"], env.as_ref())
        .await
        .ok_or("couldn't read the pull request's reviews from GitHub")?;
    Ok(approved_by_reviews(&pr))
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
        let base = remote_base(&state, &task, &project).await;
        let args = pr_view_args(Path::new(&project.repo_path), base.as_deref(), &branch).await;
        // Not as another account when the task's isn't signed in.
        let env = match crate::agent::runner::task_gh_env(&state, &task).await {
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

#[cfg(test)]
thread_local! {
    /// The gh `gh_json` runs in this thread's test (gh on the PATH when unset).
    pub(super) static GH: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

/// The `gh` arguments that look up the pull request of a task's `branch` (branched from `base`
/// in `repo`): in the GitHub repository it's pushed to (see `github`), which gh wouldn't pick
/// from the remotes' fetch URLs if they're elsewhere, or else wherever gh finds it.
pub(super) async fn pr_view_args(repo: &Path, base: Option<&str>, branch: &str) -> Vec<String> {
    let mut args: Vec<String> = ["pr", "view", branch, "--json", "url"].map(String::from).into();
    if let Some(gh) = github(repo, base).await {
        args.extend(["--repo".into(), gh.repo]);
    }
    args
}

/// The URL of a pull request, from `gh` run in `dir` with `pr_view_args` (and `env`, see
/// runner::task_gh_env).
async fn pr_url(dir: &Path, args: &[String], env: Option<&crate::mcp::gh_mcp::GhEnv>) -> Option<String> {
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let pr = gh_json(dir, &args, env).await?;
    pr["url"].as_str().filter(|u| u.starts_with("https://")).map(str::to_string)
}

/// The JSON a `gh` command run in `dir` prints, or None when it fails (e.g. `gh` isn't installed
/// or signed in, or there's no such pull request).
pub(super) async fn gh_json(dir: &Path, args: &[&str], env: Option<&crate::mcp::gh_mcp::GhEnv>) -> Option<Value> {
    #[cfg(not(test))]
    let mut cmd = Command::new("gh");
    #[cfg(test)]
    let mut cmd = Command::new(GH.with_borrow(|g| g.clone()).unwrap_or_else(|| "gh".into()));
    cmd.args(args).current_dir(dir).stdin(Stdio::null()).env("GH_PROMPT_DISABLED", "1").env("GIT_TERMINAL_PROMPT", "0").kill_on_drop(true);
    if let Some(env) = env {
        env.check(args, None).ok()?;
        env.apply(&mut cmd);
    }
    let out = cmd.output();
    let out = tokio::time::timeout(Duration::from_secs(30), out).await.ok()?.ok()?;
    out.status.success().then(|| serde_json::from_slice(&out.stdout).ok()).flatten()
}
