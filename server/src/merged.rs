//! Tasks whose pull requests are merged or closed on GitHub (by the user, or by auto-merge)
//! rather than through *Ready for merge* (API 68). Every `POLL` the server reads the state of the
//! pull requests (`pr_url`) of the tasks in *In review* or *Needs attention* whose project has
//! `done_when_merged` on (the default), with one GraphQL query per GitHub account and host (and
//! `CHUNK` pull requests), as each task's own account (see runner::github_account; gh's active
//! account when none is set), never as another.
//!
//! - Merged: the task moves to *Done* (resolution `done`), as moving it there does, says so in
//!   its thread, and its worktree is removed if nothing in it would be lost (see
//!   worktree::remove_if_merged, which says why when it's kept).
//! - Closed without being merged: a task in *In review* moves to *Needs attention* saying so; one
//!   already there (whose reason is the agent's) only gets an event.
//!
//! Each is done once per change of state: what the last read found is kept per task and pull
//! request (`pr_states`), so a task the user moves back out of *Done* stays where they put it, and
//! a pull request that's reopened and closed again is reported again. Tasks whose agent (or a
//! reviewer) is running or that are merging are left alone, and so are a subproject's tasks,
//! which its own merge brings in, and a subproject with open tasks.
//!
//! A `wait` on the pull request (pr_watch.rs) already tells the agent it was merged, and leaves
//! marking the task done to it (and its project's instructions); if it ends its run without
//! doing so, the task goes to *In review* and the next read here moves it on.

use std::collections::HashMap;
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value, json};

use crate::db::{self, Task};
use crate::gh_mcp::Account;
use crate::pr_watch::Target;
use crate::state::Shared;
use crate::worktree::Removal;

/// How often the pull requests are read.
pub const POLL: Duration = Duration::from_secs(180);

/// How long after the server starts they're first read.
const FIRST: Duration = Duration::from_secs(30);

/// The most pull requests one query reads.
const CHUNK: usize = 50;

/// Starts reading the tasks' pull requests every `POLL`.
pub fn start(s: &Shared) {
    let s = s.clone();
    tokio::spawn(async move {
        tokio::time::sleep(FIRST).await;
        let mut failing = HashMap::new();
        loop {
            check(&s, &mut failing).await;
            tokio::time::sleep(POLL).await;
        }
    });
}

/// The tasks to read the pull requests of now: open in *In review* or *Needs attention* with a
/// pull request, in a project that wants it, and not being worked on or merged.
fn candidates(s: &Shared) -> anyhow::Result<Vec<(Task, Option<String>)>> {
    let tasks = db::tasks_with_open_prs(&s.db())?;
    let mut out = Vec::new();
    for t in tasks {
        if busy(s, &t)? || !settles_here(&s.db(), &t)? {
            continue;
        }
        out.push(t);
    }
    // The accounts, read once per project and profile.
    let mut accounts: HashMap<(String, String), Option<String>> = HashMap::new();
    let mut with = Vec::new();
    for t in out {
        let key = (t.profile_id.clone(), t.project_id.clone().unwrap_or_default());
        let account = match accounts.get(&key) {
            Some(a) => a.clone(),
            None => {
                let a = crate::runner::task_github_account(s, &t)?;
                accounts.insert(key, a.clone());
                a
            }
        };
        with.push((t, account));
    }
    Ok(with)
}

/// Whether `t`'s agent or one of its reviewers is running (the database unlocked, as runs are
/// locked first elsewhere).
fn busy(s: &Shared, t: &Task) -> anyhow::Result<bool> {
    let reviews = db::review_threads(&s.db(), &t.id)?;
    Ok(s.is_running(&t.id) || reviews.iter().any(|r| r.running || s.is_running(&r.id)))
}

/// Whether `t` is settled from its own pull request: not a subproject's task (which goes into its
/// subproject's branch with the subproject's own merge), nor a subproject with open tasks.
fn settles_here(c: &Connection, t: &Task) -> anyhow::Result<bool> {
    if db::subproject_of(c, t)?.is_some() {
        return Ok(false);
    }
    Ok(!t.subproject || db::subproject_tasks(c, &t.id)?.iter().all(|t| t.status == "done" || t.is_scratch()))
}

/// Read the candidates' pull requests and act on what changed. `failing` keeps the last error
/// of each account and host, so a read that keeps failing is logged once.
pub async fn check(s: &Shared, failing: &mut HashMap<(Option<String>, String), String>) {
    let tasks = match candidates(s) {
        Ok(t) => t,
        Err(e) => return tracing::error!("finding tasks whose pull requests to read: {e:#}"),
    };
    // By account and host, then by pull request (tasks can share one).
    let mut groups: HashMap<(Option<String>, String), Vec<(Target, Vec<Task>)>> = HashMap::new();
    for (t, account) in tasks {
        let Some(target) = t.pr_url.as_deref().and_then(|u| Target::parse(u, None).ok()) else { continue };
        // Not as an account on another host.
        if let Some(a) = account.as_deref().and_then(Account::parse)
            && a.host != target.host
        {
            continue;
        }
        let prs = groups.entry((account, target.host.clone())).or_default();
        match prs.iter_mut().find(|(p, _)| p.url() == target.url()) {
            Some((_, list)) => list.push(t),
            None => prs.push((target, vec![t])),
        }
    }
    for ((account, host), prs) in groups {
        let mut env = None;
        for chunk in prs.chunks(CHUNK) {
            let targets: Vec<&Target> = chunk.iter().map(|(t, _)| t).collect();
            let states = match read(account.as_deref(), &mut env, &host, &targets).await {
                Ok(states) => {
                    failing.remove(&(account.clone(), host.clone()));
                    states
                }
                Err(e) => {
                    let key = (account.clone(), host.clone());
                    if failing.get(&key) != Some(&e) {
                        tracing::warn!(account = account.as_deref().unwrap_or("gh's active account"), host, "reading tasks' pull requests: {e}");
                        failing.insert(key, e);
                    }
                    break;
                }
            };
            for ((target, tasks), read) in chunk.iter().zip(states) {
                let Some(read) = read else { continue };
                for t in tasks {
                    // The board shows how its checks stand (see pr_watch::record_checks).
                    if read.state == "open" {
                        crate::pr_watch::record_checks(s, &t.id, target, &read.head, &read.checks);
                    }
                    if let Err(e) = changed(s, t, target, &read.state).await {
                        tracing::error!(task = %t.id, pr = %target.label(), "acting on its pull request's state: {e:#}");
                    }
                }
            }
        }
    }
}

/// A pull request as a read found it.
struct Read {
    /// `open`, `merged` or `closed`.
    state: String,
    /// Its head commit, and that commit's checks.
    head: String,
    checks: Vec<crate::pr_watch::Check>,
}

/// Each of `targets`' states and checks, or None for one GitHub didn't return (gone, or out of
/// the account's reach), read in one query as `account` on `host`.
async fn read(account: Option<&str>, env: &mut Option<crate::gh_mcp::GhEnv>, host: &str, targets: &[&Target]) -> Result<Vec<Option<Read>>, String> {
    #[cfg(test)]
    let v = match FAKE.with_borrow(|f| f.as_ref().map(|f| f(account, host, targets))) {
        Some(r) => r?,
        None => return Err("no fake GitHub".into()),
    };
    #[cfg(not(test))]
    let v = {
        let (query, vars, numbers) = query(targets);
        let vars: Vec<(&str, String)> = vars.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();
        let numbers: Vec<(&str, u64)> = numbers.iter().map(|(k, n)| (k.as_str(), *n)).collect();
        crate::pr_watch::graphql(account, env, host, &query, &vars, &numbers).await?
    };
    #[cfg(test)]
    let _ = env;
    states(&v, targets.len())
}

/// The query that reads `targets`' states, aliased `pr0`, `pr1`… with their variables.
fn query(targets: &[&Target]) -> (String, Vec<(String, String)>, Vec<(String, u64)>) {
    let (mut params, mut fields, mut vars, mut numbers) = (Vec::new(), String::new(), Vec::new(), Vec::new());
    for (i, t) in targets.iter().enumerate() {
        params.push(format!("$o{i}: String!, $n{i}: String!, $p{i}: Int!"));
        let checks = crate::pr_watch::CHECKS.replace("$number", &format!("$p{i}"));
        fields.push_str(&format!("  pr{i}: repository(owner: $o{i}, name: $n{i}) {{ pullRequest(number: $p{i}) {{ state {checks} }} }}\n"));
        vars.extend([(format!("o{i}"), t.owner.clone()), (format!("n{i}"), t.name.clone())]);
        numbers.push((format!("p{i}"), t.number));
    }
    (format!("query({}) {{\n{fields}}}", params.join(", ")), vars, numbers)
}

/// The pull requests in a response to `query` for `n` of them. GitHub answers the others when one
/// can't be read (with an error and a null for it); none at all is an error.
fn states(v: &Value, n: usize) -> Result<Vec<Option<Read>>, String> {
    if !v["data"].is_object() {
        let errors: Vec<&str> = v["errors"].as_array().into_iter().flatten().filter_map(|e| e["message"].as_str()).collect();
        return Err(if errors.is_empty() { "GitHub didn't return the pull requests".into() } else { errors.join("; ") });
    }
    let read = |pr: &Value| {
        let state = pr["state"].as_str()?.to_ascii_lowercase();
        Some(Read { state, head: pr["headRefOid"].as_str().unwrap_or_default().into(), checks: crate::pr_watch::checks_of(pr) })
    };
    Ok((0..n).map(|i| read(&v["data"][format!("pr{i}")]["pullRequest"])).collect())
}

/// What the last read found for `t`'s pull request `url`.
fn last_state(c: &Connection, task_id: &str, url: &str) -> anyhow::Result<Option<String>> {
    Ok(c.query_row("SELECT state FROM pr_states WHERE task_id=?1 AND pr_url=?2", [task_id, url], |r| r.get(0)).optional()?)
}

fn store_state(c: &Connection, task_id: &str, url: &str, state: &str) -> anyhow::Result<()> {
    c.execute(
        "INSERT INTO pr_states (task_id, pr_url, state, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(task_id, pr_url) DO UPDATE SET state=?3, updated_at=?4",
        rusqlite::params![task_id, url, state, crate::util::now()],
    )?;
    Ok(())
}

/// Act on `t`'s pull request being in `state`, if it wasn't at the last read. The state is kept
/// once it's been acted on (or there was nothing to do), so a task that couldn't be moved (its
/// agent started meanwhile) is tried again at the next read.
async fn changed(s: &Shared, t: &Task, target: &Target, state: &str) -> anyhow::Result<()> {
    let url = target.url();
    let last = last_state(&s.db(), &t.id, &url)?;
    if last.as_deref() == Some(state) {
        return Ok(());
    }
    let done = match state {
        "merged" => merged(s, t, target).await?,
        "closed" => closed(s, t, target)?,
        _ => true,
    };
    if done {
        store_state(&s.db(), &t.id, &url, state)?;
    }
    Ok(())
}

/// Whether `t` is still as it was read for the pull request: open and idle with the same one.
fn unchanged(c: &Connection, t: &Task) -> anyhow::Result<bool> {
    Ok(db::get_task(c, &t.id)?.is_some_and(|now| {
        ["in_review", "needs_attention"].contains(&now.status.as_str()) && !now.running && !now.merging && now.pr_url == t.pr_url
    }))
}

/// `t`'s pull request was merged: move it to Done and remove its worktree. False if it changed
/// meanwhile, or its agent started.
async fn merged(s: &Shared, t: &Task, target: &Target) -> anyhow::Result<bool> {
    if busy(s, t)? {
        return Ok(false);
    }
    let fields = [("status", json!("done")), ("resolution", json!("done")), ("attention_reason", Value::Null), ("waiting", json!(false))];
    let Some(done) = s.update_task_if(&t.id, &fields, |c| unchanged(c, t))? else { return Ok(false) };
    s.add_event(&t.id, "info", format!("PR #{} was merged on GitHub, so the task is done.", target.number), Some(target.url()));
    // As moving it to Done does (see api::update_task_inner).
    crate::runner::start_unblocked(s, done.project_id.as_deref());
    crate::runner::start_next_merge(s, done.project_id.as_deref());
    crate::terminal::kill_all(s, &t.id).await;
    match crate::worktree::remove_if_merged(s, &t.id, true).await {
        Ok(Removal::Removed(_)) => {}
        Ok(Removal::Kept(why)) if why == "it has no worktree" => {}
        Ok(Removal::Kept(why)) => s.add_event(&t.id, "info", format!("The worktree was kept: {why}."), None),
        Err(e) => s.add_event(&t.id, "warn", "The worktree couldn't be removed", Some(format!("{e:#}"))),
    }
    Ok(true)
}

/// `t`'s pull request was closed without being merged: flag it. False if it changed meanwhile.
fn closed(s: &Shared, t: &Task, target: &Target) -> anyhow::Result<bool> {
    let text = format!("PR #{} was closed on GitHub without being merged", target.number);
    if t.status == "in_review" {
        let fields = [("status", json!("needs_attention")), ("attention_reason", json!(text))];
        let when = |c: &Connection| Ok(unchanged(c, t)? && db::get_task(c, &t.id)?.is_some_and(|now| now.status == "in_review"));
        if s.update_task_if(&t.id, &fields, when)?.is_none() {
            return Ok(false);
        }
    }
    s.add_event(&t.id, "warn", format!("{text}."), Some(target.url()));
    Ok(true)
}

// ---------- tests ----------

#[cfg(test)]
type Fake = Box<dyn Fn(Option<&str>, &str, &[&Target]) -> Result<Value, String>>;

#[cfg(test)]
thread_local! {
    /// A fake GitHub for this thread's test: the response to a query, given the account, host
    /// and pull requests it reads.
    static FAKE: std::cell::RefCell<Option<Fake>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{CreateProject, CreateTask, create_project_inner, create_task_inner};
    use std::cell::RefCell;
    use std::path::{Path, PathBuf};
    use std::rc::Rc;

    fn sh(dir: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@t"])
            .args(args)
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?}");
    }

    /// GitHub as a map of pull request URLs to states (missing ones aren't found), recording the
    /// queries made: (account, host, URLs).
    type Github = Rc<RefCell<HashMap<String, &'static str>>>;
    type Queries = Rc<RefCell<Vec<(Option<String>, String, Vec<String>)>>>;

    fn fake_github() -> (Github, Queries) {
        let (prs, queries): (Github, Queries) = Default::default();
        let (p, q) = (prs.clone(), queries.clone());
        FAKE.set(Some(Box::new(move |account, host, targets| {
            q.borrow_mut().push((account.map(String::from), host.to_string(), targets.iter().map(|t| t.url()).collect()));
            let mut data = serde_json::Map::new();
            for (i, t) in targets.iter().enumerate() {
                let pr = p.borrow().get(&t.url()).map(|st| json!({"pullRequest": {"state": st}}));
                data.insert(format!("pr{i}"), pr.unwrap_or(Value::Null));
            }
            Ok(json!({"data": data}))
        })));
        (prs, queries)
    }

    /// A project on a fresh repository, with a task in In review whose worktree has a commit and
    /// whose pull request is `url`: the repository, project id and task.
    async fn task_in_review(s: &Shared, profile: &str, url: &str) -> (PathBuf, String, Task) {
        let repo = crate::testing::temp_dir();
        sh(&repo, &["init", "-q", "-b", "master"]);
        sh(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
        let b = CreateProject { name: "x".into(), repo_path: crate::util::path_str(&repo), key: None, base_branch: Some("master".into()), use_worktrees: None };
        let p = create_project_inner(s, profile, b).await.unwrap();
        let t = new_task(s, &p.id, url).await;
        (repo, p.id, t)
    }

    async fn new_task(s: &Shared, project: &str, url: &str) -> Task {
        let t = create_task_inner(s, project, CreateTask { title: "Do it".into(), ..Default::default() }).unwrap();
        let t = crate::worktree::setup(s, &t.id).await.unwrap();
        let wt = PathBuf::from(t.worktree_path.clone().unwrap());
        std::fs::write(wt.join("a"), "a").unwrap();
        sh(&wt, &["add", "a"]);
        sh(&wt, &["commit", "-qm", "a"]);
        s.update_task(&t.id, &[("status", json!("in_review")), ("pr_url", json!(url))]).unwrap().unwrap()
    }

    fn task(s: &Shared, id: &str) -> Task {
        db::get_task(&s.db(), id).unwrap().unwrap()
    }

    fn events(s: &Shared, id: &str) -> Vec<String> {
        let messages = db::list_messages(&s.db(), id).unwrap();
        messages.into_iter().filter(|m| m.kind == "event").map(|m| m.data["text"].as_str().unwrap_or_default().to_string()).collect()
    }

    #[test]
    fn a_task_whose_pull_request_is_merged_is_done_and_its_worktree_removed() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
            let url = "https://github.com/o/r/pull/7";
            let (repo, _, t) = task_in_review(&s, &profile.id, url).await;
            let (prs, queries) = fake_github();
            let mut failing = HashMap::new();

            prs.borrow_mut().insert(url.into(), "OPEN");
            check(&s, &mut failing).await;
            assert_eq!(task(&s, &t.id).status, "in_review");
            assert_eq!(queries.borrow().as_slice(), [(None, "github.com".to_string(), vec![url.to_string()])]);

            // Merged on GitHub (squashed, say): its branch isn't in master, so the worktree stays.
            prs.borrow_mut().insert(url.into(), "MERGED");
            check(&s, &mut failing).await;
            let done = task(&s, &t.id);
            assert_eq!((done.status.as_str(), done.resolution.as_deref(), done.worktree_state.as_str()), ("done", Some("done"), "ready"));
            let ev = events(&s, &t.id);
            assert!(ev.contains(&"PR #7 was merged on GitHub, so the task is done.".to_string()), "{ev:?}");
            assert!(ev.iter().any(|e| e.starts_with("The worktree was kept: its work isn't merged into master")), "{ev:?}");

            // Done, it isn't read again; moved back by the user, it stays where they put it.
            check(&s, &mut failing).await;
            assert_eq!(queries.borrow().len(), 2);
            s.update_task(&t.id, &[("status", json!("in_review"))]).unwrap();
            check(&s, &mut failing).await;
            assert_eq!(queries.borrow().len(), 3);
            assert_eq!(task(&s, &t.id).status, "in_review");

            // Another task, whose branch was merged as it is: its worktree goes.
            let pid = t.project_id.clone().unwrap();
            let url2 = "https://github.com/o/r/pull/8";
            let t2 = new_task(&s, &pid, url2).await;
            sh(&repo, &["merge", "-q", "--no-ff", "-m", "merge", t2.branch.as_deref().unwrap()]);
            prs.borrow_mut().insert(url2.into(), "MERGED");
            check(&s, &mut failing).await;
            let done = task(&s, &t2.id);
            assert_eq!((done.status.as_str(), done.worktree_state.as_str()), ("done", "none"));
            assert!(!Path::new(t2.worktree_path.as_deref().unwrap()).exists());
            std::fs::remove_dir_all(&repo).ok();
        })
    }

    #[test]
    fn a_closed_pull_request_flags_the_task_once() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
            let url = "https://github.com/o/r/pull/7";
            let (repo, _, t) = task_in_review(&s, &profile.id, url).await;
            let (prs, _) = fake_github();
            let mut failing = HashMap::new();
            prs.borrow_mut().insert(url.into(), "CLOSED");
            check(&s, &mut failing).await;
            let flagged = task(&s, &t.id);
            assert_eq!(flagged.status, "needs_attention");
            assert_eq!(flagged.attention_reason.as_deref(), Some("PR #7 was closed on GitHub without being merged"));
            // Moved back to In review, it isn't flagged again until it's reopened and closed.
            s.update_task(&t.id, &[("status", json!("in_review"))]).unwrap();
            check(&s, &mut failing).await;
            assert_eq!(task(&s, &t.id).status, "in_review");
            prs.borrow_mut().insert(url.into(), "OPEN");
            check(&s, &mut failing).await;
            prs.borrow_mut().insert(url.into(), "CLOSED");
            check(&s, &mut failing).await;
            assert_eq!(task(&s, &t.id).status, "needs_attention");
            assert_eq!(events(&s, &t.id).iter().filter(|e| e.contains("closed on GitHub")).count(), 2);

            // Already waiting on the user, its reason stays the agent's.
            s.update_task(&t.id, &[("attention_reason", json!("Which colour?"))]).unwrap();
            prs.borrow_mut().insert(url.into(), "OPEN");
            check(&s, &mut failing).await;
            prs.borrow_mut().insert(url.into(), "CLOSED");
            check(&s, &mut failing).await;
            let t = task(&s, &t.id);
            assert_eq!((t.status.as_str(), t.attention_reason.as_deref()), ("needs_attention", Some("Which colour?")));
            assert_eq!(events(&s, &t.id).iter().filter(|e| e.contains("closed on GitHub")).count(), 3);
            std::fs::remove_dir_all(&repo).ok();
        })
    }

    #[test]
    fn leaves_tasks_that_are_busy_merging_opted_out_or_in_a_subproject() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
            let url = "https://github.com/o/r/pull/7";
            let (repo, pid, t) = task_in_review(&s, &profile.id, url).await;
            let (prs, queries) = fake_github();
            let mut failing = HashMap::new();
            prs.borrow_mut().insert(url.into(), "MERGED");

            // Running, merging, or in a project that turned it off: not read.
            for (k, v) in [("running", json!(true)), ("merging", json!(true))] {
                s.update_task(&t.id, &[(k, v.clone())]).unwrap();
                check(&s, &mut failing).await;
                s.update_task(&t.id, &[(k, json!(false))]).unwrap();
            }
            db::update_project(&s.db(), &pid, &[("done_when_merged", json!(false))]).unwrap();
            check(&s, &mut failing).await;
            assert!(queries.borrow().is_empty());
            db::update_project(&s.db(), &pid, &[("done_when_merged", json!(true))]).unwrap();

            // A subproject's task is merged by its subproject; the subproject waits for its tasks.
            s.update_task(&t.id, &[("subproject", json!(true))]).unwrap();
            let child = create_task_inner(&s, &pid, CreateTask { title: "Part".into(), parent_id: Some(t.id.clone()), ..Default::default() }).unwrap();
            s.update_task(&child.id, &[("status", json!("in_review")), ("pr_url", json!("https://github.com/o/r/pull/9"))]).unwrap();
            prs.borrow_mut().insert("https://github.com/o/r/pull/9".into(), "MERGED");
            check(&s, &mut failing).await;
            assert!(queries.borrow().is_empty());
            assert_eq!(task(&s, &child.id).status, "in_review");
            s.update_task(&child.id, &[("status", json!("done"))]).unwrap();
            check(&s, &mut failing).await;
            assert_eq!(task(&s, &t.id).status, "done");
            std::fs::remove_dir_all(&repo).ok();
        })
    }

    #[test]
    fn reads_each_accounts_pull_requests_together_as_that_account() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let work = db::insert_profile(&s.db(), "work", &[], None).unwrap();
            let home = db::insert_profile(&s.db(), "home", &[], None).unwrap();
            s.db().execute("UPDATE profiles SET github_account='alice' WHERE id=?1", [&work.id]).unwrap();
            let (r1, p1, a) = task_in_review(&s, &work.id, "https://github.com/o/r/pull/1").await;
            let b = new_task(&s, &p1, "https://github.com/o/r/pull/2").await;
            // The same pull request twice is read once.
            let b2 = new_task(&s, &p1, "https://github.com/o/r/pull/2").await;
            let (r2, p2, c) = task_in_review(&s, &home.id, "https://github.com/o/r/pull/3").await;
            // An account on another host doesn't read github.com's.
            s.db().execute("UPDATE projects SET github_account='acme.ghe.com/bob' WHERE id=?1", [&p2]).unwrap();
            let d = new_task(&s, &p2, "https://acme.ghe.com/o/r/pull/4").await;
            let (prs, queries) = fake_github();
            prs.borrow_mut().insert("https://github.com/o/r/pull/2".into(), "MERGED");
            check(&s, &mut HashMap::new()).await;
            let mut q = queries.borrow().clone();
            q.sort();
            assert_eq!(q, [
                (Some("acme.ghe.com/bob".into()), "acme.ghe.com".into(), vec!["https://acme.ghe.com/o/r/pull/4".to_string()]),
                (Some("alice".into()), "github.com".into(), vec!["https://github.com/o/r/pull/1".to_string(), "https://github.com/o/r/pull/2".into()]),
            ]);
            let statuses: Vec<String> = [&a, &b, &b2, &c, &d].iter().map(|t| task(&s, &t.id).status).collect();
            assert_eq!(statuses, ["in_review", "done", "done", "in_review", "in_review"]);
            for r in [r1, r2] {
                std::fs::remove_dir_all(&r).ok();
            }
        })
    }

    #[test]
    fn builds_one_query_and_reads_its_answer() {
        let t = |o: &str, n: u64| Target { host: "github.com".into(), owner: o.into(), name: "r".into(), number: n };
        let (a, b) = (t("o", 1), t("x", 2));
        let (q, vars, numbers) = query(&[&a, &b]);
        assert!(q.starts_with("query($o0: String!, $n0: String!, $p0: Int!, $o1: String!, $n1: String!, $p1: Int!) {"), "{q}");
        assert!(q.contains("pr1: repository(owner: $o1, name: $n1) { pullRequest(number: $p1) { state headRefOid commits(last: 1)"), "{q}");
        // Each pull request's checks are asked of its own number.
        assert!(q.contains("isRequired(pullRequestNumber: $p1)") && !q.contains("$number"), "{q}");
        assert_eq!(vars, [("o0".to_string(), "o".to_string()), ("n0".into(), "r".into()), ("o1".into(), "x".into()), ("n1".into(), "r".into())]);
        assert_eq!(numbers, [("p0".to_string(), 1), ("p1".into(), 2)]);
        // One it can't read is null, with an error, and the others are still read.
        let v = json!({"data": {"pr0": null, "pr1": {"pullRequest": {"state": "MERGED"}}}, "errors": [{"message": "Could not resolve"}]});
        let read = states(&v, 2).unwrap();
        assert!(read[0].is_none());
        assert_eq!(read[1].as_ref().map(|r| r.state.as_str()), Some("merged"));
        assert_eq!(states(&json!({"errors": [{"message": "Bad credentials"}]}), 2).err(), Some("Bad credentials".into()));
        // With its head commit's checks.
        let pr = crate::pr_watch::response("me", "c3", &[("test", "COMPLETED", "FAILURE", false)], &[])["data"]["repository"].clone();
        let read = states(&json!({"data": {"pr0": pr}}), 1).unwrap().pop().flatten().unwrap();
        assert_eq!((read.state.as_str(), read.head.as_str(), read.checks.len()), ("open", "c3", 1));
    }
}
