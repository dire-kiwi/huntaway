//! Tasks that start from something other than their project's base branch (db::StartFrom): where
//! they start (`pick_start`), stacked tasks (`unstack`, `remote_base`), and the branches to pick from.

use super::*;

/// Where a task asked to start from something other than its project's base branch starts (see
/// db::StartFrom), worked out as its worktree is first made.
pub(super) struct Picked {
    /// Its base branch, which its pull request targets and its changes are compared with; None
    /// for the project's.
    pub(super) base: Option<String>,
    /// The commit its branch starts at, and what it is for the task log, when that isn't its base
    /// branch's latest (a commit; a pull request from a fork).
    pub(super) commit: Option<(String, String)>,
    /// Events for the task log: level and text.
    pub(super) notes: Vec<(&'static str, String)>,
}

/// Work out where task `task` starts from `sf`. A task it's stacked on that has no branch yet has
/// its worktree set up first, as a subproject's is for its tasks; one that's merged already has
/// its task start from where it was merged. So does a merged pull request; one from a fork (or
/// closed) starts from its head commit, fetched by its SHA, with the pull request's base as the
/// task's. None when it comes to the project's base branch after all.
pub(super) async fn pick_start(state: &Shared, task: &Task, project: &Project, repo: &Path, sf: &db::StartFrom, within: &[String]) -> Result<Option<Picked>> {
    let picked = |base: String, note: String| Some(Picked { base: Some(base), commit: None, notes: vec![("info", note)] });
    match sf {
        db::StartFrom::Branch { branch } => {
            // A remote's branch (`origin/feature`) is the branch of that name when that's the remote
            // the name alone follows (where its pull request goes).
            let base = match remote_branch(repo, branch).await {
                Some((remote, name)) if commit(repo, &format!("refs/heads/{branch}")).await.is_none() => match upstream(repo, &name).await {
                    Some(up) if up.remote == remote && up.merge == format!("refs/heads/{name}") => name,
                    // Another remote's (`upstream/feature`) isn't a branch the task's pull request
                    // can target, which goes to the push remote's repository: like a pull request
                    // from a fork, its latest commit it is (fetched), and the base branch the
                    // project's.
                    _ => {
                        let up = upstream(repo, branch).await.ok_or_else(|| anyhow!("couldn't tell where {branch} is fetched from"))?;
                        let account = crate::agent::runner::task_github_account(state, task)?;
                        if let Err(e) = fetch(repo, &up, account.as_deref()).await {
                            tracing::warn!(task = %task.id, "fetching {branch}: {e:#}");
                        }
                        let tip = commit(repo, &up.tracking).await.ok_or_else(|| anyhow!("branch {branch} isn't in the repository (fetching it failed)"))?;
                        let note = format!(
                            "{branch} is on {remote}, which this task's pull request doesn't go to, so starting from its latest commit {}: \
                             this task's pull request targets the base branch, with its commits too",
                            &tip[..12]
                        );
                        return Ok(Some(Picked { base: None, commit: Some((tip, branch.clone())), notes: vec![("info", note)] }));
                    }
                },
                _ => branch.clone(),
            };
            Ok(picked(base.clone(), format!("Starting from branch {base}")))
        }
        db::StartFrom::Task { task_id } => {
            let other = db::get_task(&state.db(), task_id)?.ok_or_else(|| anyhow!("the task this one starts from was deleted"))?;
            let key = format!("{}-{}", crate::agent::runner::key_prefix(&other, Some(project)), other.number);
            if db::is_merged(&other) {
                // Where it went: that's merged too when it was stacked on another task (see db::task_base).
                let base = db::task_base(&state.db(), &other, Some(project));
                let note = format!("{key} is merged already, so starting from {}", base.as_deref().unwrap_or("the base branch"));
                return Ok(Some(Picked { base, commit: None, notes: vec![("info", note)] }));
            }
            let branch = match other.branch.clone() {
                Some(b) => b,
                None if other.use_worktree => {
                    state.add_event(&task.id, "info", format!("Setting up {key}'s worktree first, to start from its branch…"), None);
                    let other = Box::pin(setup_within(state, &other.id, within)).await.with_context(|| format!("setting up {key}'s worktree"))?;
                    other.branch.ok_or_else(|| anyhow!("{key} has no branch to start from"))?
                }
                None => bail!("{key} has no branch to start from: it doesn't use a worktree"),
            };
            Ok(picked(branch.clone(), format!("Stacked on {key}: starting from its branch {branch}, which this task's pull request targets")))
        }
        db::StartFrom::PullRequest { number, repo: named } => {
            // Where the project's tasks open their pull requests: its base branch's remote's repository.
            let default = project_base(repo, project).await;
            let gh = github(repo, default.as_deref()).await.ok_or_else(|| anyhow!("{} isn't on GitHub, so it has no pull request #{number}", project.repo_path))?;
            if let Some(named) = named.as_deref().filter(|n| !n.eq_ignore_ascii_case(&gh.repo)) {
                bail!("pull request #{number} is in {named}, not in the project's repository {}", gh.repo);
            }
            let env = crate::agent::runner::task_gh_env(state, task).await?;
            let fields = "state,headRefName,baseRefName,headRefOid,isCrossRepository";
            let n = number.to_string();
            let pr = gh_json(repo, &["pr", "view", &n, "--repo", &gh.repo, "--json", fields], env.as_ref())
                .await
                .ok_or_else(|| anyhow!("couldn't read pull request #{number} of {} with gh", gh.repo))?;
            let text = |k: &str| pr[k].as_str().map(str::to_string).filter(|v| !v.is_empty());
            let (Some(head), Some(base), Some(oid)) = (text("headRefName"), text("baseRefName"), text("headRefOid")) else {
                bail!("gh didn't say where pull request #{number} of {} is", gh.repo);
            };
            if pr["state"] == "MERGED" {
                return Ok(picked(base.clone(), format!("Pull request #{number} is merged already, so starting from its base {base}")));
            }
            // Its branch, if the name alone follows the remote it's on (where this task's pull request goes too).
            let follows = upstream(repo, &head).await.is_some_and(|up| up.remote == gh.remote && up.merge == format!("refs/heads/{head}"));
            if pr["state"] == "OPEN" && pr["isCrossRepository"] == false && follows {
                return Ok(picked(head.clone(), format!("Starting from pull request #{number}'s branch {head}, which this task's pull request targets")));
            }
            // Its branch isn't one the task's pull request can target: its commit it is.
            let account = crate::agent::runner::task_github_account(state, task)?;
            fetch_commit(repo, &gh.remote, &oid, account.as_deref()).await.with_context(|| format!("fetching pull request #{number}'s head {oid}"))?;
            let why = match pr["state"] == "OPEN" {
                true if pr["isCrossRepository"] == false => &*format!("has its branch on {}, which {head} alone doesn't follow here", gh.remote),
                true => "is from a fork",
                false => "is closed",
            };
            let note = format!(
                "Pull request #{number} {why}, so starting from its head commit {} on top of {base}: this task's pull request targets {base}, with its commits too",
                &oid[..oid.len().min(12)]
            );
            Ok(Some(Picked { base: Some(base), commit: Some((oid.clone(), format!("pull request #{number}"))), notes: vec![("info", note)] }))
        }
        db::StartFrom::Commit { commit: sha } => {
            let found = match self::commit(repo, sha).await {
                Some(c) => c,
                None => {
                    // GitHub (like most hosts) hands out a commit that's on one of its branches by its full SHA.
                    let remote = push_remote(repo, project_base(repo, project).await.as_deref()).await.map(|(r, _)| r);
                    let account = crate::agent::runner::task_github_account(state, task)?;
                    match remote {
                        Some(r) if sha.len() == 40 => fetch_commit(repo, &r, sha, account.as_deref()).await.with_context(|| format!("fetching commit {sha}"))?,
                        _ => bail!("commit {sha} isn't in the repository (give its full SHA to fetch it)"),
                    }
                    self::commit(repo, sha).await.ok_or_else(|| anyhow!("commit {sha} isn't in the repository"))?
                }
            };
            let short = found[..12].to_string();
            Ok(Some(Picked { base: None, commit: Some((found, short.clone())), notes: vec![("info", format!("Starting from commit {short}"))] }))
        }
    }
}

/// The base branch a task in `project` (in `repo`) gets when it doesn't say: the project's, or the
/// branch checked out in its repository.
async fn project_base(repo: &Path, project: &Project) -> Option<String> {
    match project.base_branch.clone().filter(|b| !b.is_empty()) {
        Some(b) => Some(b),
        None => current_branch(repo).await,
    }
}

/// Before task `gone` is deleted, if it's merged: the tasks stacked on it keep going where it went
/// (see db::task_base), which they'd no longer find. When that's the branch of a task it was
/// stacked on that isn't merged yet, they're stacked on that one instead. Otherwise one with a
/// branch starts, from then on, from the commit where its own work starts (see `start_ref`), so
/// its changes are still only its own; one without is a task on that branch.
pub async fn unstack(state: &Shared, gone: &Task) {
    if !db::is_merged(gone) {
        return;
    }
    keep_starts(state, &gone.id).await;
    let (stacked, heir) = {
        let c = state.db();
        (db::stacked_on(&c, &gone.id).unwrap_or_default(), db::stacked_base(&c, gone))
    };
    for t in stacked {
        let project = t.project_id.as_deref().and_then(|p| db::get_project(&state.db(), p).ok().flatten());
        let base = db::task_base(&state.db(), &t, project.as_ref());
        let key = |t: &Task| format!("{}-{}", crate::agent::runner::key_prefix(t, project.as_ref()), t.number);
        let (fields, text) = match &heir {
            Some(heir) => {
                let fields = vec![("start_from", json!(db::StartFrom::Task { task_id: heir.id.clone() })), ("base_branch", json!(t.branch.as_ref().and(base)))];
                (fields, format!("{}, which this task was stacked on, was deleted: it's merged into {}, so this task is stacked on that now", key(gone), key(heir)))
            }
            None => {
                let kept = match (&project, &t.branch) {
                    (Some(p), Some(_)) => commit(&crate::util::expand_tilde(&p.repo_path), &start_ref(&t.id)).await,
                    _ => None,
                };
                let from = match (&t.branch, kept) {
                    (Some(_), Some(at)) => json!(db::StartFrom::Commit { commit: at }),
                    (Some(_), None) => json!(t.start_from),
                    (None, _) => Value::Null,
                };
                let to = base.as_deref().unwrap_or("the base branch").to_string();
                (vec![("base_branch", json!(base)), ("start_from", from)], format!("{}, which this task was stacked on, was deleted: it's merged, so this task goes to {to}", key(gone)))
            }
        };
        if let Err(e) = state.update_task(&t.id, &fields) {
            tracing::warn!(task = %t.id, "keeping where it goes as {} is deleted: {e:#}", key(gone));
            continue;
        }
        state.add_event(&t.id, "info", text, None);
    }
}

/// The branch whose remote task `task`'s pull request goes to (see `github`): its base branch (see
/// db::task_base) or, while that's the branch of a task it's stacked on that has no remote of its
/// own (made by the board and not pushed yet), that task's, and so on.
pub async fn remote_base(state: &Shared, task: &Task, project: &Project) -> Option<String> {
    let repo = crate::util::expand_tilde(&project.repo_path);
    let mut t = task.clone();
    for _ in 0..16 {
        let (base, on) = {
            let c = state.db();
            (db::task_base(&c, &t, Some(project)), db::stacked_base(&c, &t))
        };
        let (Some(b), Some(on)) = (&base, on) else { return base };
        let own = git(&repo, &["config", &format!("branch.{b}.remote")]).await.is_ok_and(|o| !o.stdout.trim().is_empty());
        if own {
            return base;
        }
        t = on;
    }
    None
}

/// Fetch commit `sha` (in full) from `remote`, as a pull request's head or a commit a task starts
/// from, so it's in the repository; the branch made from it keeps it.
async fn fetch_commit(repo: &Path, remote: &str, sha: &str, account: Option<&str>) -> Result<()> {
    if commit(repo, sha).await.is_some() {
        return Ok(());
    }
    let run = async {
        let mut cmd = Command::new("git");
        cmd.arg("-C").arg(repo).stdin(Stdio::null()).env("GIT_TERMINAL_PROMPT", "0").kill_on_drop(true);
        crate::mcp::gh_mcp::authenticate_fetch(&mut cmd, repo, remote, account).await?;
        let out = cmd.args(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", remote, sha]).output().await.context("failed to run git fetch")?;
        if !out.status.success() { bail!("git fetch {remote} {sha} failed: {}", String::from_utf8_lossy(&out.stderr).trim()) }
        Ok(())
    };
    match tokio::time::timeout(Duration::from_secs(60), run).await {
        Ok(r) => r,
        Err(_) => bail!("git fetch {remote} timed out"),
    }
}

/// The branches of `repo`, newest commits first, up to a few hundred: `{name, remote}` for each,
/// those only on a remote named with it (`origin/feature`), as a task's `start_from` takes them.
pub async fn branches(repo: &Path) -> Vec<Value> {
    let format = "--format=%(refname)";
    let Ok(list) = git_ok(repo, &["for-each-ref", "--sort=-committerdate", "--count=400", format, "refs/heads", "refs/remotes"]).await else {
        return Vec::new();
    };
    let refs: Vec<&str> = list.lines().map(str::trim).collect();
    let local: Vec<&str> = refs.iter().filter_map(|r| r.strip_prefix("refs/heads/")).collect();
    refs.iter()
        .filter_map(|r| match (r.strip_prefix("refs/heads/"), r.strip_prefix("refs/remotes/")) {
            (Some(name), _) => Some(json!({"name": name, "remote": false})),
            // Not a remote's HEAD, nor a branch that's here too.
            (_, Some(name)) => match name.split_once('/') {
                Some((_, b)) if b != "HEAD" && !local.contains(&b) => Some(json!({"name": name, "remote": true})),
                _ => None,
            },
            _ => None,
        })
        .take(200)
        .collect()
}
