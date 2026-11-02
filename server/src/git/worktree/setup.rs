//! Setting up a task's worktree (`setup`), one at a time per task.

use super::*;

/// Worktree setups (and removals once merged) in progress, by task: one at a time per task, so
/// that two runs needing the same worktree (e.g. two of a subproject's tasks both setting up the
/// subproject's first) don't both try to create it, and a run doesn't set up a worktree that's
/// being removed.
static SETUPS: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = LazyLock::new(Default::default);

/// Run `f` holding the task's setup lock.
pub(super) async fn locked<T>(task_id: &str, f: impl AsyncFnOnce() -> T) -> T {
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
    setup_within(state, task_id, &[]).await
}

/// `setup`, for a task whose worktree the setups of `within` (outermost first) need first: a
/// subproject's for its tasks, a task's for one stacked on it. One of those can't need its own
/// (it would wait for its own setup lock), which `check_start_from` should have prevented.
pub(super) async fn setup_within(state: &Shared, task_id: &str, within: &[String]) -> Result<Task> {
    if within.iter().any(|t| t == task_id) {
        bail!("its worktree can't be set up: the tasks it starts from (or the subproject it's in) start from it");
    }
    // Not from the repository folder the project is moving from, and the folder stays put until
    // the worktree is stored.
    let project_id = db::get_task(&state.db(), task_id)?.and_then(|t| t.project_id);
    let _holding = match &project_id {
        Some(pid) => Some(crate::git::relocate::hold(state, pid).await),
        None => None,
    };
    let within: Vec<String> = within.iter().cloned().chain([task_id.to_string()]).collect();
    locked(task_id, async || setup_locked(state, task_id, &within).await).await
}

/// `setup` while holding the task's setup lock: whatever another setup did before is seen here.
async fn setup_locked(state: &Shared, task_id: &str, within: &[String]) -> Result<Task> {
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
    crate::git::relocate::record_fingerprint(state, &project).await;
    // A subproject's task branches from the subproject's branch, which needs to exist first.
    let subproject = db::subproject_of(&state.db(), &task)?;
    let subproject_branch = match subproject {
        Some(sp) if task.base_branch.is_none() => match sp.branch {
            Some(b) => Some(b),
            None => {
                state.add_event(task_id, "info", "Setting up the subproject's worktree first…", None);
                let sp = Box::pin(setup_within(state, &sp.id, within)).await.context("setting up the subproject's worktree")?;
                sp.branch
            }
        },
        _ => None,
    };
    let name = folder_name(&project, &task);
    let branch = task.branch.clone().unwrap_or_else(|| format!("ia/{}-{name}", project.key.to_lowercase()));
    let wt = PathBuf::from(&project.worktrees_root).join(&name);
    let _ = git(&repo, &["worktree", "prune"]).await;
    let branch_exists = git(&repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).await?.ok;
    state.update_task(task_id, &[("worktree_state", json!("setting_up")), ("worktree_error", Value::Null)])?;
    // What it was asked to start from counts until its branch exists: that's where it started. Its
    // base branch is saved with the branch (see below), but one made before that was (a setup cut
    // short) is worked out again.
    let fresh = !branch_exists && !wt.exists();
    let picked = match &task.start_from {
        Some(sf) if fresh || (task.branch.is_none() && task.base_branch.is_none()) => match pick_start(state, &task, &project, &repo, sf, within).await {
            Ok(p) => p,
            Err(e) => return Err(setup_failed(state, task_id, e)),
        },
        _ => None,
    };

    let result = async {
        let given = picked.as_ref().and_then(|p| p.base.as_ref()).or(task.base_branch.as_ref()).or(subproject_branch.as_ref());
        let base = match (given, &project.base_branch) {
            (Some(b), _) => b.clone(),
            (None, Some(b)) if !b.is_empty() => b.clone(),
            _ => current_branch(&repo).await.unwrap_or_else(|| "HEAD".into()),
        };
        tokio::fs::create_dir_all(&project.worktrees_root).await?;

        let mut from = base.clone();
        // A folder there already is the task's worktree from before (a setup that didn't finish, say);
        // anything else is in the way, not something to take over and later remove.
        if wt.exists() && !is_worktree_of(&repo, &wt).await {
            bail!("{} is in the way: it isn't a worktree of {}", wt.display(), repo.display());
        }
        if !wt.exists() {
            let wt_s = path_str(&wt);
            if branch_exists {
                git_ok(&repo, &["worktree", "add", &wt_s, &branch]).await?;
            } else {
                for (level, text) in picked.as_ref().map(|p| p.notes.clone()).unwrap_or_default() {
                    state.add_event(task_id, level, text, None);
                }
                let start = match picked.as_ref().and_then(|p| p.commit.clone()) {
                    // A commit is where it starts, whatever the base branch has since.
                    Some((rev, what)) => Start { rev, from: what, notes: Vec::new() },
                    None => {
                        let account = crate::agent::runner::task_github_account(state, &task)?;
                        start_point(&repo, &base, account.as_deref()).await
                    }
                };
                for (level, text, detail) in start.notes {
                    state.add_event(task_id, level, text, detail);
                }
                // Not tracking the branch it starts from (git would for a remote-tracking one).
                git_ok(&repo, &["worktree", "add", "--no-track", "-b", &branch, &wt_s, &start.rev]).await?;
                from = start.from;
                if task.start_from.is_some() {
                    git_ok(&repo, &["update-ref", &start_ref(task_id), &format!("refs/heads/{branch}")]).await?;
                }
            }
        }
        // Saved as soon as git has them, so a setup script that fails (or a restart meanwhile)
        // doesn't lose where the branch started: setting up again keeps it, and so does the API,
        // which only lets what it starts from change before there's a branch.
        state.update_task(task_id, &[("worktree_path", json!(path_str(&wt))), ("branch", json!(branch)), ("base_branch", json!(base))])?;
        state.add_event(task_id, "info", format!("Worktree ready at {} on branch {branch} (from {from})", wt.display()), None);

        // Before the setup script, which can rely on them. Nothing already there is overwritten,
        // so a setup that didn't finish can do it again.
        match crate::git::worktree_files::bring_in(&project, &wt).await {
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
        Err(e) => Err(setup_failed(state, task_id, e)),
    }
}

/// Record that a task's worktree couldn't be set up, returning the error.
fn setup_failed(state: &Shared, task_id: &str, e: anyhow::Error) -> anyhow::Error {
    let msg = format!("{e:#}");
    if let Err(e) = state.update_task(task_id, &[("worktree_state", json!("error")), ("worktree_error", json!(msg))]) {
        tracing::warn!(task = task_id, "couldn't record the failed worktree setup: {e:#}");
    }
    state.add_event(task_id, "error", "Worktree setup failed", Some(msg.clone()));
    anyhow!(msg)
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
