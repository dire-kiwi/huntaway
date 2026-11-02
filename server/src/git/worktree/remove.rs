//! Removing a task's worktree: `teardown`, and removing it once its work is merged
//! (`remove_if_merged`, `remove_merged`).

use super::*;

/// Whether `wt` may be removed by hand when git won't remove it as a worktree: a folder inside the
/// project's worktrees folder that isn't the repository (or another main checkout), so a stray folder
/// there, or a misconfigured worktrees folder, can't cost work kept elsewhere.
pub(super) async fn removable_by_hand(project: &Project, repo: &Path, wt: &Path) -> bool {
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
pub(super) async fn git_output(dir: &Path, args: &[&OsStr]) -> Result<std::process::Output> {
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
pub(super) async fn git_bytes(dir: &Path, args: &[&OsStr]) -> Result<Vec<u8>> {
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
    // The tasks stacked on it keep where they took its branch up to before it's gone.
    keep_starts(state, task_id).await;

    if wt.exists() {
        if !force {
            let status = uncommitted(&wt).await.context("checking the worktree for uncommitted changes")?;
            if !status.is_empty() {
                bail!("worktree has uncommitted changes:\n{}", truncate(status.trim(), 2000));
            }
        }
        state.update_task(task_id, &[("worktree_state", json!("tearing_down"))])?;
        // Its terminal would be left in a deleted directory.
        crate::hosts::terminal::kill_all(state, task_id).await;
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
    crate::git::checkpoints::forget(state, task_id, &repo).await;
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
        let Some(base) = db::task_base(&state.db(), &task, Some(&project)) else {
            return kept("it has no base branch to be merged into");
        };
        let status = uncommitted(&wt).await?;
        if !status.is_empty() {
            let n = status.lines().count();
            return Ok(Removal::Kept(format!("it has {n} uncommitted or untracked file{}", if n == 1 { "" } else { "s" })));
        }
        let head = git_ok(&wt, &["rev-parse", "--verify", "HEAD"]).await?.trim().to_string();
        let account = crate::agent::runner::task_github_account(state, &task)?;
        let env = crate::agent::runner::task_gh_env(state, &task).await;
        let mut found = merged_into(&repo, &wt, &base, task.branch.as_deref(), &head, fetch, account.as_deref(), &env).await;
        // One stacked on another task's branch may have gone into the project's base branch with it,
        // or after it (its pull request retargeted there); its own pull request was asked about already.
        let stacked = matches!(task.start_from, Some(db::StartFrom::Task { .. } | db::StartFrom::PullRequest { .. }));
        if let Some(main) = project.base_branch.clone().filter(|m| found.is_none() && stacked && !m.is_empty() && *m != base) {
            found = merged_into(&repo, &wt, &main, None, &head, fetch, account.as_deref(), &env).await;
        }
        let Some(merged_into) = found else {
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
    gh_env: &Result<Option<crate::mcp::gh_mcp::GhEnv>>,
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
    let mut bases: Vec<String> = tasks.iter().filter_map(|t| db::task_base(&state.db(), t, Some(&project))).collect();
    bases.sort();
    bases.dedup();
    let profile = db::get_profile(&state.db(), &project.profile_id)?.context("profile not found")?;
    let account = crate::agent::runner::github_account(Some(&project), &profile);
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
