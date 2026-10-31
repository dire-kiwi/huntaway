//! Tasks made together from one prompt, each run by another agent (a fan-out, API 61; see api::CreateTask::fanout_id).
//! The board's compare view shows them side by side (API 81): `GET /tasks/{id}/fanout` has what it can't read off the
//! tasks themselves (how long each one's agent ran, what's uncommitted in its worktree, its branch), and
//! `POST /tasks/{id}/fanout/pick` keeps that task and completes the others as not done, removing their worktrees, and
//! their branches and pull requests if asked to. Nothing uncommitted is lost unless `discard_uncommitted` says so: a
//! worktree with uncommitted changes is kept otherwise.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::{Path as UrlPath, State};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::db::{self, Task};
use crate::state::{ApiError, ApiResult, Shared};
use crate::worktree;

/// The most of a worktree's uncommitted changes listed.
const LISTED: usize = 20;

/// How long the agents of a task that wasn't picked have to stop before it's left as it is.
const STOP_WAIT: Duration = Duration::from_secs(if cfg!(test) { 2 } else { 20 });

/// How long deleting a pushed branch, or closing a pull request, may take.
const REMOTE_TIMEOUT: Duration = Duration::from_secs(60);

/// What the compare view shows of a task besides the task itself.
#[derive(Serialize, Debug)]
pub struct Facts {
    pub id: String,
    /// How long its agent has run, all of its runs together (one still going, up to now), and how many runs.
    pub run_secs: f64,
    pub runs: i64,
    /// Its agent, or one of its reviewers, is at work.
    pub working: bool,
    /// Its worktree's uncommitted changes, as `git status --porcelain` lists them (the first `LISTED`), and how many.
    pub uncommitted: Vec<String>,
    pub uncommitted_count: usize,
    /// Why its worktree couldn't be checked for them.
    pub uncommitted_error: Option<String>,
    /// Commits in its worktree that no branch, remote branch or tag has (a detached HEAD's): only the worktree has them,
    /// so it's kept when picking.
    pub stray_commits: usize,
    /// Its branch, if the repository has it, and its upstream (`origin/ia/x-1`) if it's been pushed.
    pub branch: Option<String>,
    pub pushed: Option<String>,
}

/// The tasks made from the same prompt as `t`, it among them, in the order they were made. Only its own profile's: a
/// fanout id is only a label, which a task elsewhere could have too.
fn siblings(s: &Shared, t: &Task) -> ApiResult<Vec<Task>> {
    let Some(f) = t.fanout_id.as_deref().filter(|_| t.kind == "task") else {
        return Err(ApiError::bad("the task wasn't made from one prompt with others"));
    };
    Ok(db::fanout_tasks(&s.db(), &t.profile_id, f)?)
}

fn key(s: &Shared, t: &Task) -> String {
    format!("{}-{}", crate::runner::task_key_prefix(s, t), t.number)
}

fn repo_of(s: &Shared, t: &Task) -> Option<PathBuf> {
    let project = db::get_project(&s.db(), t.project_id.as_deref()?).ok().flatten()?;
    Some(crate::util::expand_tilde(&project.repo_path))
}

/// The task's branch, if the repository has it.
async fn branch_of(repo: Option<&Path>, t: &Task) -> Option<String> {
    let (repo, branch) = (repo?, t.branch.as_deref().filter(|b| !b.is_empty())?);
    let o = worktree::git(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).await.ok()?;
    o.ok.then(|| branch.to_string())
}

/// Where a branch is pushed: its upstream's remote and branch there, and its short name (`origin/ia/x-1`), if the
/// repository has a copy of it (it was pushed, and not deleted there since it was last fetched).
struct Pushed {
    remote: String,
    remote_ref: String,
    short: String,
}

async fn pushed(repo: &Path, branch: &str) -> Option<Pushed> {
    let format = "--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)%00%(upstream:short)";
    let o = worktree::git(repo, &["for-each-ref", format, &format!("refs/heads/{branch}")]).await.ok()?;
    let line = o.stdout.lines().next()?;
    let [remote, remote_ref, tracking, short] = line.split('\0').collect::<Vec<_>>()[..] else { return None };
    if remote.is_empty() || !remote_ref.starts_with("refs/heads/") || tracking.is_empty() {
        return None;
    }
    let there = worktree::git(repo, &["rev-parse", "--verify", "--quiet", tracking]).await.ok()?;
    there.ok.then(|| Pushed { remote: remote.into(), remote_ref: remote_ref.into(), short: short.into() })
}

pub async fn facts(s: &Shared, t: &Task) -> anyhow::Result<Facts> {
    let (run_secs, runs) = db::run_time(&s.db(), &t.id, &crate::util::now())?;
    let repo = repo_of(s, t);
    let branch = branch_of(repo.as_deref(), t).await;
    let pushed = match (&repo, &branch) {
        (Some(r), Some(b)) => pushed(r, b).await.map(|p| p.short),
        _ => None,
    };
    let (mut uncommitted, mut uncommitted_error) = (Vec::new(), None);
    let mut stray_commits = 0;
    if let Some(wt) = t.worktree_path.as_deref().map(Path::new).filter(|w| t.worktree_state == "ready" && w.exists()) {
        match worktree::uncommitted(wt).await {
            Ok(status) => uncommitted = status.lines().filter(|l| !l.trim().is_empty()).map(str::to_string).collect(),
            Err(e) => uncommitted_error = Some(format!("{e:#}")),
        }
        stray_commits = stray(wt).await.unwrap_or(0);
    }
    let uncommitted_count = uncommitted.len();
    uncommitted.truncate(LISTED);
    let working = worktree::agent_in_worktree(s, &t.id);
    Ok(Facts { id: t.id.clone(), run_secs, runs, working, uncommitted, uncommitted_count, uncommitted_error, stray_commits, branch, pushed })
}

/// How many commits a worktree's HEAD has that no branch, remote branch or tag has: a detached HEAD's, which nothing
/// but the worktree keeps (they'd be garbage once it's gone).
async fn stray(wt: &Path) -> anyhow::Result<usize> {
    let o = worktree::git(wt, &["rev-list", "--count", "HEAD", "--not", "--branches", "--remotes", "--tags"]).await?;
    anyhow::ensure!(o.ok, "git rev-list failed: {}", o.stderr.trim());
    Ok(o.stdout.trim().parse()?)
}

/// `GET /tasks/{id}/fanout`: `{tasks: [Facts]}` for the tasks made from the same prompt as this one, it among them.
pub async fn get(State(s): State<Shared>, UrlPath(id): UrlPath<String>) -> ApiResult<Json<Value>> {
    let t = db::get_task(&s.db(), &id)?.ok_or_else(|| ApiError::not_found("task"))?;
    let mut out = Vec::new();
    for sibling in siblings(&s, &t)? {
        out.push(facts(&s, &sibling).await?);
    }
    Ok(Json(json!({"tasks": out})))
}

/// What to do with the tasks that aren't picked, besides completing them as not done and removing their worktrees.
#[derive(Deserialize, Default, Debug)]
pub struct Pick {
    /// Delete their branches, and the copies pushed of them (unless a pull request that's kept open has them).
    #[serde(default)]
    pub delete_branches: bool,
    /// Close their pull requests.
    #[serde(default)]
    pub close_prs: bool,
    /// Remove their worktrees even with uncommitted changes in them, which are lost. Otherwise those worktrees are kept.
    #[serde(default)]
    pub discard_uncommitted: bool,
}

/// What picking did with a task that wasn't picked.
#[derive(Serialize, Debug, Default)]
pub struct Outcome {
    pub id: String,
    pub key: String,
    /// Its agent (or a reviewer) was at work, and was stopped.
    pub stopped: bool,
    /// Completed as not done now (rather than done already).
    pub completed: bool,
    /// What became of its worktree, branch, pushed branch and pull request: `removed` or `deleted` or `closed`,
    /// `kept`, or `none` when it had none.
    pub worktree: &'static str,
    pub branch: &'static str,
    pub pushed_branch: &'static str,
    pub pr: &'static str,
    /// What didn't go as asked, and why.
    pub notes: Vec<String>,
}

/// `POST /tasks/{id}/fanout/pick` (`Pick`): keeps the task, and completes the others made from the same prompt as not
/// done, cleaning up after them. `{task, results: [Outcome]}`, the picked task as it is now and one result for each of
/// the others.
pub async fn pick(State(s): State<Shared>, UrlPath(id): UrlPath<String>, Json(b): Json<Pick>) -> ApiResult<Json<Value>> {
    Ok(Json(pick_inner(&s, &id, &b).await?))
}

pub async fn pick_inner(s: &Shared, id: &str, b: &Pick) -> ApiResult<Value> {
    // One pick at a time, so two at once (of two of them) can't complete them all as not done.
    static PICKING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _one = PICKING.lock().await;
    let t = db::get_task(&s.db(), id)?.ok_or_else(|| ApiError::not_found("task"))?;
    let picked = key(s, &t);
    if t.status == "done" && t.resolution.as_deref() == Some("not_done") {
        return Err(ApiError::conflict(format!("{picked} was completed as not done: move it out of Done to pick it")));
    }
    let others: Vec<Task> = siblings(s, &t)?.into_iter().filter(|o| o.id != t.id).collect();
    if others.is_empty() {
        return Err(ApiError::bad("there are no other tasks from the same prompt"));
    }
    let mut results = Vec::new();
    for o in &others {
        results.push(retire(s, o, &picked, b).await);
    }
    let keys: Vec<&str> = results.iter().map(|r| r.key.as_str()).collect();
    s.add_event(&t.id, "info", format!("Picked over {}, made from the same prompt", keys.join(", ")), None);
    let task = db::get_task(&s.db(), id)?.ok_or_else(|| ApiError::not_found("task"))?;
    Ok(json!({"task": task, "results": results}))
}

/// Until the task's agents (its own and its reviewers') have stopped, for `STOP_WAIT` at most: whether they have.
async fn stopped(s: &Shared, id: &str) -> bool {
    let until = Instant::now() + STOP_WAIT;
    loop {
        let reviews = db::review_threads(&s.db(), id).unwrap_or_default();
        // The run's end is written to the task (its column, `running`) after the run is marked exited: until then the
        // runner could put it back in a column after it's been completed.
        let marked = |t: &str| db::get_task(&s.db(), t).map_or(true, |t| t.is_some_and(|t| t.running));
        let active = |t: &str| s.is_running(t) || db::has_active_run(&s.db(), t).unwrap_or(true) || marked(t);
        if !active(id) && !reviews.iter().any(|r| active(&r.id)) {
            return true;
        }
        if Instant::now() >= until {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// Completes task `o`, which wasn't picked (`picked` was), as not done and cleans up after it as `b` asks.
async fn retire(s: &Shared, o: &Task, picked: &str, b: &Pick) -> Outcome {
    let mut out = Outcome { id: o.id.clone(), key: key(s, o), ..Default::default() };
    let why = format!("{picked}, made from the same prompt, was picked");
    // Its agents first: one at work would carry on in a worktree that's going.
    let reviews = db::review_threads(&s.db(), &o.id).unwrap_or_default();
    for id in std::iter::once(&o.id).chain(reviews.iter().map(|r| &r.id)) {
        out.stopped |= crate::runner::abort(s, id);
        crate::permissions::expire_for_task(s, id);
    }
    if out.stopped {
        s.add_event(&o.id, "warn", format!("Stopped: {why}"), None);
    }
    let repo = repo_of(s, o);
    let had = |v: bool| if v { "kept" } else { "none" };
    (out.worktree, out.branch, out.pushed_branch, out.pr) = (had(o.worktree_path.is_some()), had(o.branch.is_some()), "none", had(o.pr_url.is_some()));
    let fresh = if stopped(s, &o.id).await { db::get_task(&s.db(), &o.id).ok().flatten() } else { None };
    let Some(o) = fresh else {
        out.notes.push("Its agent didn't stop in time, so it was left as it is".into());
        return out;
    };
    if o.status != "done" {
        let mut done = Map::new();
        done.insert("status".into(), json!("done"));
        done.insert("resolution".into(), json!("not_done"));
        match crate::api::update_task_inner(s, &o.id, &done).await {
            Ok(_) => {
                out.completed = true;
                s.add_event(&o.id, "info", format!("Completed as not done: {why}"), None);
            }
            Err(e) => out.notes.push(format!("Couldn't complete it as not done: {}", e.1)),
        }
    }

    out.pr = had(o.pr_url.is_some());
    if let Some(url) = o.pr_url.as_deref().filter(|_| b.close_prs) {
        match close_pr(s, &o, repo.as_deref(), url).await {
            Ok(()) => {
                out.pr = "closed";
                s.add_event(&o.id, "info", format!("Closed pull request {url}"), None);
            }
            Err(e) => out.notes.push(format!("Couldn't close its pull request {url}: {e}")),
        }
    }

    let branch = branch_of(repo.as_deref(), &o).await;
    let pushed = match (&repo, &branch) {
        (Some(r), Some(br)) => pushed(r, br).await,
        _ => None,
    };
    (out.branch, out.pushed_branch, out.worktree) = (had(branch.is_some()), had(pushed.is_some()), had(o.worktree_path.is_some()));
    // The worktree first, keeping the branch: the branch goes once its pushed copy has (or there's none), so that what
    // can't be done now (a pull request kept open, a push that fails) can be done by picking again.
    if let Some(wt) = o.worktree_path.as_deref().map(Path::new) {
        let strays = if wt.exists() { stray(wt).await } else { Ok(0) };
        match strays {
            Ok(0) => match worktree::teardown(s, &o.id, b.discard_uncommitted, false).await {
                Ok(_) => out.worktree = "removed",
                Err(e) => out.notes.push(format!("Kept its worktree: {e:#}")),
            },
            Ok(n) => out.notes.push(format!("Kept its worktree: it has {n} commit{} on no branch (a detached HEAD), which would be lost", if n == 1 { "" } else { "s" })),
            Err(e) => out.notes.push(format!("Kept its worktree: couldn't check it for commits on no branch: {e:#}")),
        }
    }
    let (Some(repo), Some(br)) = (repo.as_deref().filter(|_| b.delete_branches), &branch) else { return out };
    if out.worktree == "kept" {
        out.notes.push("Kept its branch, as its worktree is kept".into());
        return out;
    }
    if let Some(p) = &pushed {
        if out.pr == "kept" {
            // Deleting a pull request's branch closes it.
            out.notes.push(format!("Kept its branch and the pushed copy {}: its pull request is still open", p.short));
            return out;
        }
        let failed = match tokio::time::timeout(REMOTE_TIMEOUT, worktree::git(repo, &["push", &p.remote, "--delete", &p.remote_ref])).await {
            Ok(Ok(g)) if g.ok => None,
            Ok(Ok(g)) => Some(g.stderr.trim().to_string()),
            Ok(Err(e)) => Some(format!("{e:#}")),
            Err(_) => Some("git push timed out".into()),
        };
        if let Some(why) = failed {
            out.notes.push(format!("Kept its branch, as its pushed copy {} couldn't be deleted: {why}", p.short));
            return out;
        }
        out.pushed_branch = "deleted";
        s.add_event(&o.id, "info", format!("Deleted the pushed branch {}", p.short), None);
    }
    match worktree::git(repo, &["branch", "-D", br]).await {
        Ok(g) if g.ok => {
            out.branch = "deleted";
            s.add_event(&o.id, "info", format!("Deleted branch {br}"), None);
            if let Err(e) = s.update_task(&o.id, &[("branch", Value::Null)]) {
                tracing::warn!(task = %o.id, "couldn't clear the deleted branch: {e:#}");
            }
        }
        Ok(g) => out.notes.push(format!("Couldn't delete its branch {br}: {}", g.stderr.trim())),
        Err(e) => out.notes.push(format!("Couldn't delete its branch {br}: {e:#}")),
    }
    out
}

/// Closes pull request `url` with gh, as the task's GitHub account (gh's active one when it has none).
async fn close_pr(s: &Shared, t: &Task, repo: Option<&Path>, url: &str) -> Result<(), String> {
    let env = crate::runner::task_gh_env(s, t).await.map_err(|e| format!("{e:#}"))?;
    let args = ["pr", "close", url];
    let mut cmd = tokio::process::Command::new(crate::gh_mcp::gh_program());
    if let Some(env) = &env {
        env.check(&args, None).map_err(|e| format!("{e:#}"))?;
        env.apply(&mut cmd);
    }
    if let Some(repo) = repo {
        cmd.current_dir(repo);
    }
    cmd.args(args)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let out = tokio::time::timeout(REMOTE_TIMEOUT, cmd.output())
        .await
        .map_err(|_| "gh timed out".to_string())?
        .map_err(|e| format!("couldn't run gh: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().trim_start_matches("gh: ").to_string())
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;
    use crate::api::{CreateProject, CreateTask, create_project_inner, create_task_inner};
    use crate::util::path_str;

    fn sh(dir: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@t"])
            .args(args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?}");
    }

    fn has_ref(dir: &Path, r: &str) -> bool {
        std::process::Command::new("git").arg("-C").arg(dir).args(["rev-parse", "--verify", "--quiet", r]).output().unwrap().status.success()
    }

    /// A repository (on master, pushed to a bare `origin`) with three tasks made from one prompt, each with a worktree
    /// and a commit of its own: the folder everything is in, and the tasks.
    async fn fanned_out(s: &Shared) -> (PathBuf, Vec<Task>) {
        let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let root = std::env::temp_dir().join(format!("ia-fanout-{}", crate::util::new_id()));
        let (repo, origin) = (root.join("repo"), root.join("origin.git"));
        std::fs::create_dir_all(&repo).unwrap();
        sh(&root, &["init", "-q", "--bare", "-b", "master", &path_str(&origin)]);
        sh(&repo, &["init", "-q", "-b", "master"]);
        std::fs::write(repo.join("readme"), "hi\n").unwrap();
        sh(&repo, &["add", "."]);
        sh(&repo, &["commit", "-qm", "init"]);
        sh(&repo, &["remote", "add", "origin", &path_str(&origin)]);
        sh(&repo, &["push", "-q", "-u", "origin", "master"]);
        let b = CreateProject { name: "x".into(), repo_path: path_str(&repo), key: Some("X".into()), base_branch: Some("master".into()), use_worktrees: None };
        let p = create_project_inner(s, &profile.id, b).await.unwrap();
        let mut tasks = Vec::new();
        for model in ["opus", "sonnet", "haiku"] {
            let b = CreateTask { title: "Do it".into(), model: Some(model.into()), fanout_id: Some("f-1".into()), ..Default::default() };
            let t = create_task_inner(s, &p.id, b).unwrap();
            let t = worktree::setup(s, &t.id).await.unwrap();
            let wt = PathBuf::from(t.worktree_path.clone().unwrap());
            std::fs::write(wt.join(model), format!("{model}\n")).unwrap();
            sh(&wt, &["add", "."]);
            sh(&wt, &["commit", "-qm", model]);
            tasks.push(t);
        }
        (root, tasks)
    }

    fn task(s: &Shared, id: &str) -> Task {
        db::get_task(&s.db(), id).unwrap().unwrap()
    }

    #[test]
    fn lists_how_long_each_ran_and_what_is_uncommitted() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (root, ts) = fanned_out(&s).await;
            let wt = PathBuf::from(ts[1].worktree_path.clone().unwrap());
            std::fs::write(wt.join("loose"), "x").unwrap();
            sh(&wt, &["push", "-q", "-u", "origin", ts[1].branch.as_deref().unwrap()]);
            {
                let c = s.db();
                c.execute("INSERT INTO runs (id,task_id,kind,status,created_at,ended_at) VALUES ('r1',?1,'prompt','exited','2026-01-01T10:00:00.000Z','2026-01-01T10:01:30.000Z')", [&ts[0].id]).unwrap();
                c.execute("INSERT INTO runs (id,task_id,kind,status,created_at,ended_at) VALUES ('r2',?1,'prompt','exited','2026-01-01T11:00:00.000Z','2026-01-01T11:00:30.000Z')", [&ts[0].id]).unwrap();
            }
            let Json(v) = get(State(s.clone()), UrlPath(ts[2].id.clone())).await.unwrap();
            let got = v["tasks"].as_array().unwrap();
            assert_eq!(got.iter().map(|f| f["id"].as_str().unwrap()).collect::<Vec<_>>(), ts.iter().map(|t| t.id.as_str()).collect::<Vec<_>>());
            assert_eq!((got[0]["run_secs"].as_f64().unwrap().round(), &got[0]["runs"]), (120.0, &json!(2)));
            assert_eq!((&got[1]["uncommitted"], &got[1]["uncommitted_count"]), (&json!(["?? loose"]), &json!(1)));
            assert_eq!(got[1]["pushed"].as_str(), Some(format!("origin/{}", ts[1].branch.as_deref().unwrap()).as_str()));
            assert_eq!((&got[0]["uncommitted"], &got[0]["pushed"], got[0]["branch"].as_str()), (&json!([]), &Value::Null, ts[0].branch.as_deref()));
            std::fs::remove_dir_all(&root).ok();
        })
    }

    #[test]
    fn picking_one_completes_the_others_and_keeps_uncommitted_work() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (root, ts) = fanned_out(&s).await;
            let (a, b, c) = (&ts[0], &ts[1], &ts[2]);
            let c_wt = PathBuf::from(c.worktree_path.clone().unwrap());
            std::fs::write(c_wt.join("draft"), "not committed").unwrap();
            let v = pick_inner(&s, &a.id, &Pick::default()).await.unwrap();
            let r = &v["results"];
            assert_eq!(r.as_array().unwrap().len(), 2);
            assert_eq!((&r[0]["key"], &r[0]["completed"], &r[0]["worktree"], &r[0]["branch"], &r[0]["pr"]), (&json!("X-2"), &json!(true), &json!("removed"), &json!("kept"), &json!("none")));
            assert_eq!((&r[1]["completed"], &r[1]["worktree"]), (&json!(true), &json!("kept")));
            assert!(r[1]["notes"][0].as_str().unwrap().contains("uncommitted changes"), "{}", r[1]["notes"]);
            for t in [b, c] {
                let now = task(&s, &t.id);
                assert_eq!((now.status.as_str(), now.resolution.as_deref()), ("done", Some("not_done")));
            }
            // Picked, it stays as it was; the others' commits are still on their branches.
            assert_eq!(task(&s, &a.id).status, a.status);
            assert!(Path::new(a.worktree_path.as_ref().unwrap()).exists());
            assert!(!Path::new(b.worktree_path.as_ref().unwrap()).exists());
            assert!(c_wt.join("draft").exists());
            let repo = root.join("repo");
            assert!(has_ref(&repo, &format!("refs/heads/{}", b.branch.as_deref().unwrap())));
            let said = db::list_messages(&s.db(), &b.id).unwrap();
            assert!(said.iter().any(|m| m.data["text"].as_str().is_some_and(|t| t.contains("X-1, made from the same prompt, was picked"))), "{said:?}");

            // A task completed as not done isn't picked over the one that was, until it's moved out of Done.
            let e = pick_inner(&s, &b.id, &Pick::default()).await.unwrap_err();
            assert_eq!(e.0, axum::http::StatusCode::CONFLICT);
            assert_eq!(task(&s, &a.id).status, a.status);

            // Asked again to discard what's uncommitted and delete the branches: the ones done already are cleaned up too.
            let all = Pick { delete_branches: true, discard_uncommitted: true, close_prs: false };
            let v = pick_inner(&s, &a.id, &all).await.unwrap();
            let r = &v["results"];
            assert_eq!((&r[0]["completed"], &r[0]["worktree"], &r[0]["branch"]), (&json!(false), &json!("none"), &json!("deleted")));
            assert_eq!((&r[1]["worktree"], &r[1]["branch"], &r[1]["notes"]), (&json!("removed"), &json!("deleted"), &json!([])));
            assert!(!c_wt.exists());
            for t in [b, c] {
                assert!(!has_ref(&repo, &format!("refs/heads/{}", t.branch.as_deref().unwrap())));
                assert_eq!(task(&s, &t.id).branch, None);
            }
            assert!(has_ref(&repo, &format!("refs/heads/{}", a.branch.as_deref().unwrap())));
            std::fs::remove_dir_all(&root).ok();
        })
    }

    #[test]
    fn deletes_pushed_branches_and_closes_pull_requests_only_when_asked() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (root, ts) = fanned_out(&s).await;
            let (repo, origin) = (root.join("repo"), root.join("origin.git"));
            for t in &ts[1..] {
                sh(Path::new(t.worktree_path.as_ref().unwrap()), &["push", "-q", "-u", "origin", t.branch.as_deref().unwrap()]);
            }
            // No real GitHub: gh says what it was asked to do.
            let log = root.join("gh.log");
            let gh = root.join("gh");
            std::fs::write(&gh, format!("#!/bin/sh\necho \"$*\" >> '{}'\n", path_str(&log))).unwrap();
            std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).unwrap();
            crate::gh_mcp::TEST_GH_PROGRAM.set(Some(path_str(&gh)));
            let pr = "https://github.com/o/r/pull/7";
            s.update_task(&ts[1].id, &[("pr_url", json!(pr))]).unwrap();

            // Branches deleted, pull requests kept open: the pull request's branch is kept, here and where it's pushed.
            let v = pick_inner(&s, &ts[0].id, &Pick { delete_branches: true, ..Default::default() }).await.unwrap();
            let r = &v["results"];
            assert_eq!((&r[0]["branch"], &r[0]["pushed_branch"], &r[0]["pr"]), (&json!("kept"), &json!("kept"), &json!("kept")));
            assert!(r[0]["notes"][0].as_str().unwrap().contains("its pull request is still open"), "{}", r[0]["notes"]);
            assert_eq!((&r[1]["branch"], &r[1]["pushed_branch"]), (&json!("deleted"), &json!("deleted")));
            let b1 = format!("refs/heads/{}", ts[1].branch.as_deref().unwrap());
            assert!(has_ref(&origin, &b1) && has_ref(&repo, &b1));
            assert!(!has_ref(&origin, &format!("refs/heads/{}", ts[2].branch.as_deref().unwrap())));
            assert!(!log.exists());
            // So the board still offers to delete it.
            let Json(f) = get(State(s.clone()), UrlPath(ts[0].id.clone())).await.unwrap();
            assert_eq!(f["tasks"][1]["pushed"].as_str(), Some(format!("origin/{}", ts[1].branch.as_deref().unwrap()).as_str()));

            // HA-51 review: asked to close it on a later pick, it's closed, and then its branch goes too, from both.
            let v = pick_inner(&s, &ts[0].id, &Pick { close_prs: true, delete_branches: true, ..Default::default() }).await.unwrap();
            let r = &v["results"][0];
            assert_eq!((&r["pr"], &r["branch"], &r["pushed_branch"], &r["notes"]), (&json!("closed"), &json!("deleted"), &json!("deleted"), &json!([])));
            assert_eq!(std::fs::read_to_string(&log).unwrap(), format!("pr close {pr}\n"));
            assert!(!has_ref(&origin, &b1) && !has_ref(&repo, &b1));
            assert!(has_ref(&repo, &format!("refs/heads/{}", ts[0].branch.as_deref().unwrap())));
            crate::gh_mcp::TEST_GH_PROGRAM.set(None);
            std::fs::remove_dir_all(&root).ok();
        })
    }

    // HA-51 review: a pushed copy that couldn't be deleted was forgotten with the branch here, so picking again
    // couldn't delete it.
    #[test]
    fn a_pushed_branch_that_cant_be_deleted_is_deleted_by_picking_again() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (root, ts) = fanned_out(&s).await;
            let (repo, origin) = (root.join("repo"), root.join("origin.git"));
            sh(Path::new(ts[1].worktree_path.as_ref().unwrap()), &["push", "-q", "-u", "origin", ts[1].branch.as_deref().unwrap()]);
            let hook = origin.join("hooks/pre-receive");
            std::fs::write(&hook, "#!/bin/sh\necho no deleting >&2\nexit 1\n").unwrap();
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
            let delete = Pick { delete_branches: true, ..Default::default() };
            let v = pick_inner(&s, &ts[0].id, &delete).await.unwrap();
            let r = &v["results"][0];
            assert_eq!((&r["worktree"], &r["branch"], &r["pushed_branch"]), (&json!("removed"), &json!("kept"), &json!("kept")));
            assert!(r["notes"][0].as_str().unwrap().contains("no deleting"), "{}", r["notes"]);
            let b1 = format!("refs/heads/{}", ts[1].branch.as_deref().unwrap());
            assert!(has_ref(&repo, &b1) && has_ref(&origin, &b1));
            std::fs::remove_file(&hook).unwrap();
            let v = pick_inner(&s, &ts[0].id, &delete).await.unwrap();
            let r = &v["results"][0];
            assert_eq!((&r["branch"], &r["pushed_branch"], &r["notes"]), (&json!("deleted"), &json!("deleted"), &json!([])));
            assert!(!has_ref(&repo, &b1) && !has_ref(&origin, &b1));
            std::fs::remove_dir_all(&root).ok();
        })
    }

    // HA-51 review: commits on a detached HEAD are on no branch, so removing the worktree lost them.
    #[test]
    fn a_worktree_with_commits_on_no_branch_is_kept() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (root, ts) = fanned_out(&s).await;
            let wt = PathBuf::from(ts[1].worktree_path.clone().unwrap());
            sh(&wt, &["checkout", "-q", "--detach"]);
            std::fs::write(wt.join("loose"), "x").unwrap();
            sh(&wt, &["add", "."]);
            sh(&wt, &["commit", "-qm", "detached"]);
            let Json(f) = get(State(s.clone()), UrlPath(ts[0].id.clone())).await.unwrap();
            assert_eq!((&f["tasks"][1]["stray_commits"], &f["tasks"][1]["uncommitted_count"], &f["tasks"][2]["stray_commits"]), (&json!(1), &json!(0), &json!(0)));
            let all = Pick { delete_branches: true, discard_uncommitted: true, close_prs: true };
            let v = pick_inner(&s, &ts[0].id, &all).await.unwrap();
            let r = &v["results"];
            assert_eq!((&r[0]["completed"], &r[0]["worktree"], &r[0]["branch"]), (&json!(true), &json!("kept"), &json!("kept")));
            assert!(r[0]["notes"][0].as_str().unwrap().contains("1 commit on no branch"), "{}", r[0]["notes"]);
            assert!(wt.join("loose").exists());
            assert_eq!((&r[1]["worktree"], &r[1]["branch"]), (&json!("removed"), &json!("deleted")));
            std::fs::remove_dir_all(&root).ok();
        })
    }

    /// Task `t`'s agent at work, as the runner has it: a run, its handle (which stopping cancels) and the task marked
    /// running. The run ends as the runner ends one that's stopped, a moment after.
    fn at_work(s: &Shared, t: &Task) {
        let run = db::insert_run(&s.db(), &t.id, "prompt").unwrap();
        s.db().execute("UPDATE runs SET status='running', between_turns=1 WHERE id=?1", [&run.id]).unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel();
        s.runs.lock().unwrap().insert(t.id.clone(), crate::state::RunHandle { run_id: run.id.clone(), cancel: Some(tx) });
        // With a pull request, the run's end doesn't look one up with gh.
        s.update_task(&t.id, &[("running", json!(true)), ("status", json!("in_progress")), ("pr_url", json!("https://github.com/o/r/pull/1"))]).unwrap();
        let s = s.clone();
        tokio::spawn(async move {
            let _ = rx.await;
            tokio::time::sleep(Duration::from_millis(300)).await;
            crate::runner::finish(&s, &run.id, crate::runner::Outcome::Cancelled);
        });
    }

    #[test]
    fn an_agent_at_work_is_stopped_before_its_task_is_completed() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (root, ts) = fanned_out(&s).await;
            at_work(&s, &ts[1]);
            let v = pick_inner(&s, &ts[0].id, &Pick::default()).await.unwrap();
            let r = &v["results"][0];
            assert_eq!((&r["stopped"], &r["completed"], &r["worktree"], &r["notes"]), (&json!(true), &json!(true), &json!("removed"), &json!([])));
            let t = task(&s, &ts[1].id);
            assert_eq!((t.status.as_str(), t.resolution.as_deref(), t.running), ("done", Some("not_done"), false));
            std::fs::remove_dir_all(&root).ok();
        })
    }

    // HA-51 review: the run was marked exited before the runner wrote its end to the task, and picking in between
    // completed the task only for the runner to move it to Needs attention.
    #[test]
    fn a_task_is_completed_only_once_the_runner_has_written_its_runs_end() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (root, ts) = fanned_out(&s).await;
            let run = db::insert_run(&s.db(), &ts[1].id, "prompt").unwrap();
            s.db().execute("UPDATE runs SET status='running', between_turns=1 WHERE id=?1", [&run.id]).unwrap();
            s.runs.lock().unwrap().insert(ts[1].id.clone(), crate::state::RunHandle { run_id: run.id.clone(), cancel: None });
            s.update_task(&ts[1].id, &[("running", json!(true)), ("status", json!("in_progress")), ("pr_url", json!("https://github.com/o/r/pull/1"))]).unwrap();
            // Picked once the run is marked exited, before its end is written to the task.
            let (s2, picked) = (s.clone(), ts[0].id.clone());
            let result = std::sync::Arc::new(std::sync::Mutex::new(None));
            let out = result.clone();
            crate::testing::when("finish:exited", move || {
                crate::testing::run(async move || *out.lock().unwrap() = Some(pick_inner(&s2, &picked, &Pick::default()).await.unwrap()));
            });
            crate::runner::finish(&s, &run.id, crate::runner::Outcome::Cancelled);
            let v = result.lock().unwrap().take().unwrap();
            let r = &v["results"][0];
            assert_eq!((&r["completed"], &r["worktree"]), (&json!(false), &json!("kept")));
            assert!(r["notes"][0].as_str().unwrap().contains("didn't stop in time"), "{}", r["notes"]);
            // Left as the runner left it, not completed and then moved back.
            let t = task(&s, &ts[1].id);
            assert_eq!((t.status.as_str(), t.resolution.as_deref()), ("needs_attention", None));
            std::fs::remove_dir_all(&root).ok();
        })
    }

    #[test]
    fn one_whose_agent_does_not_stop_is_left_as_it_is() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (root, ts) = fanned_out(&s).await;
            // A run that never ends (no agent to stop).
            s.db().execute("INSERT INTO runs (id,task_id,kind,status,created_at) VALUES ('r1',?1,'prompt','running','2026-01-01T10:00:00.000Z')", [&ts[1].id]).unwrap();
            let v = pick_inner(&s, &ts[0].id, &Pick { delete_branches: true, discard_uncommitted: true, close_prs: true }).await.unwrap();
            let r = &v["results"];
            assert_eq!((&r[0]["completed"], &r[0]["worktree"], &r[0]["branch"]), (&json!(false), &json!("kept"), &json!("kept")));
            assert!(r[0]["notes"][0].as_str().unwrap().contains("didn't stop in time"), "{}", r[0]["notes"]);
            assert_eq!(task(&s, &ts[1].id).status, ts[1].status);
            assert!(Path::new(ts[1].worktree_path.as_ref().unwrap()).exists());
            assert_eq!((&r[1]["completed"], &r[1]["worktree"]), (&json!(true), &json!("removed")));
            std::fs::remove_dir_all(&root).ok();
        })
    }

    #[test]
    fn only_the_profiles_own_tasks_are_picked_over() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (root, ts) = fanned_out(&s).await;
            // Another profile's task with the same fanout id.
            let other = db::insert_profile(&s.db(), "q", &[], None).unwrap();
            std::fs::create_dir_all(root.join("other")).unwrap();
            let b = CreateProject { name: "y".into(), repo_path: path_str(&root.join("other")), key: Some("Y".into()), base_branch: None, use_worktrees: Some(false) };
            let p = create_project_inner(&s, &other.id, b).await.unwrap();
            let theirs = create_task_inner(&s, &p.id, CreateTask { title: "Theirs".into(), fanout_id: Some("f-1".into()), ..Default::default() }).unwrap();
            let Json(v) = get(State(s.clone()), UrlPath(ts[0].id.clone())).await.unwrap();
            assert_eq!(v["tasks"].as_array().unwrap().len(), 3);
            let v = pick_inner(&s, &ts[0].id, &Pick::default()).await.unwrap();
            assert_eq!(v["results"].as_array().unwrap().len(), 2);
            assert_eq!(task(&s, &theirs.id).status, theirs.status);
            // And theirs alone has nothing to be picked over.
            assert_eq!(pick_inner(&s, &theirs.id, &Pick::default()).await.unwrap_err().0, axum::http::StatusCode::BAD_REQUEST);
            std::fs::remove_dir_all(&root).ok();
        })
    }
}
