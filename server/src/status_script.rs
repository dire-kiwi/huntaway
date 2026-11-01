//! A project's status scripts: its status script runs with bash whenever one of its tasks moves
//! to another column, and each column's script whenever a task moves into that column, whatever
//! moved it (the user, its agent, a review, a merge), e.g. to notify someone, update another
//! tracker or clean up a done task's build. They run in the background in the task's worktree
//! (the repository when the task has none), and a task's scripts run one at a time in the order
//! its status changed, the status script before the column's. Their output goes in the task's
//! thread.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use rusqlite::Connection;
use tokio::sync::mpsc;

use crate::db::{self, Project, Task};
use crate::state::Shared;
use crate::util::truncate;

/// How long a status script may run before it's stopped.
const LIMIT: Duration = Duration::from_secs(300);

struct Change {
    /// The task right after the change.
    task: Task,
    old: String,
}

/// Each task's queue of changes whose scripts haven't run yet, while it has any.
static QUEUES: LazyLock<Mutex<HashMap<String, mpsc::UnboundedSender<Change>>>> = LazyLock::new(Default::default);

/// A task's status moved from `old` to `task.status`: queue its project's scripts for it. Call it
/// with the database lock the change was made under (`c`) still held, so that changes to a task
/// are queued in the order they were made.
pub fn status_changed(state: &Shared, c: &Connection, task: &Task, old: &str) {
    if task.kind != "task" || task.status == old {
        return;
    }
    let Some(pid) = &task.project_id else { return };
    // Status changes in tests that don't run on a runtime have nowhere to run it.
    let Ok(rt) = tokio::runtime::Handle::try_current() else { return };
    let has_script = db::get_project(c, pid).ok().flatten().is_some_and(|p| !scripts(&p, &task.status).is_empty());
    if !has_script {
        return;
    }
    let mut change = Change { task: task.clone(), old: old.to_string() };
    let mut queues = QUEUES.lock().unwrap();
    if let Some(q) = queues.get(&task.id) {
        match q.send(change) {
            Ok(()) => return,
            // Its runner is gone (its runtime ended), so it's replaced.
            Err(mpsc::error::SendError(c)) => change = c,
        }
    }
    let (tx, rx) = mpsc::unbounded_channel();
    let _ = tx.send(change);
    queues.insert(task.id.clone(), tx);
    rt.spawn(run_queue(state.clone(), task.id.clone(), rx));
}

/// Run a task's queued scripts until there are none left.
async fn run_queue(state: Shared, task_id: String, mut rx: mpsc::UnboundedReceiver<Change>) {
    loop {
        let change = {
            // Checked under the lock that `status_changed` sends under, so a change is either
            // seen here or sent to a new queue.
            let mut queues = QUEUES.lock().unwrap();
            match rx.try_recv() {
                Ok(c) => c,
                Err(_) => {
                    queues.remove(&task_id);
                    return;
                }
            }
        };
        run(&state, change).await;
    }
}

/// The scripts to run when a task moves to `status`, each with its name for the thread: the
/// project's status script, then the column's.
fn scripts(project: &Project, status: &str) -> Vec<(String, String)> {
    let column = project.status_scripts.get(status).map(|s| (format!("{} script", label(status)), s));
    [Some(("Status script".to_string(), &project.status_script)), column]
        .into_iter()
        .flatten()
        .filter(|(_, s)| !s.trim().is_empty())
        .map(|(name, s)| (name, s.clone()))
        .collect()
}

async fn run(state: &Shared, Change { task, old }: Change) {
    // The scripts as they are now, in case they changed since.
    let project = task.project_id.as_deref().and_then(|pid| db::get_project(&state.db(), pid).ok().flatten());
    let Some(project) = project else { return };
    let scripts = scripts(&project, &task.status);
    if scripts.is_empty() {
        return;
    }
    let worktree = match (&task.worktree_path, task.worktree_state.as_str()) {
        (Some(p), "ready") if Path::new(p).is_dir() => Some(PathBuf::from(p)),
        _ => None,
    };
    let dir = worktree.clone().unwrap_or_else(|| PathBuf::from(&project.repo_path));
    let env = script_env(&project, &task, worktree.as_deref(), &old);
    let change = format!("{} → {}", label(&old), label(&task.status));
    for (name, script) in scripts {
        match crate::worktree::run_script(&script, &dir, &env, Some(LIMIT)).await {
            Ok(log) => {
                let log = Some(log.trim()).filter(|l| !l.is_empty()).map(|l| truncate(l, 20000));
                state.add_event(&task.id, "info", format!("{name} ran ({change})"), log);
            }
            Err(e) => state.add_event(&task.id, "warn", format!("{name} failed ({change})"), Some(format!("{e:#}"))),
        }
    }
}

/// The setup script's variables (with an empty IA_WORKTREE_PATH when the task has no worktree),
/// and the change.
fn script_env(project: &Project, task: &Task, worktree: Option<&Path>, old: &str) -> Vec<(&'static str, String)> {
    let mut env = crate::worktree::script_env(project, task, worktree.unwrap_or(Path::new("")), task.branch.as_deref().unwrap_or(""));
    env.extend([
        ("IA_TASK_KEY", format!("{}-{}", project.key, task.number)),
        ("IA_TASK_TITLE", task.title.clone()),
        ("IA_OLD_STATUS", old.to_string()),
        ("IA_NEW_STATUS", task.status.clone()),
        ("IA_RESOLUTION", task.resolution.clone().unwrap_or_default()),
        ("IA_PR_URL", task.pr_url.clone().unwrap_or_default()),
    ]);
    if worktree.is_none() {
        env.retain(|(k, _)| *k != "IA_WORKTREE_PATH");
        env.push(("IA_WORKTREE_PATH", String::new()));
    }
    env
}

/// A status's column name on the board.
fn label(status: &str) -> &str {
    match status {
        "backlog" => "Backlog",
        "todo" => "To do",
        "in_progress" => "In progress",
        "needs_attention" => "Needs attention",
        "in_review" => "In review",
        "ready_for_merge" => "Ready for merge",
        "done" => "Done",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::testing;
    use crate::util::path_str;

    fn project_and_task(s: &Shared, repo: &str) -> (Project, Task) {
        let c = s.db();
        let p = db::insert_profile(&c, "p", &[], None).unwrap();
        let np = db::NewProject { id: "pr", profile_id: &p.id, name: "x", key: "X", repo_path: repo, scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
        let project = db::insert_project(&c, np).unwrap();
        let t = db::NewTask { profile_id: &p.id, project_id: Some("pr"), kind: "task", title: "t", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
        (project, db::insert_task(&c, t).unwrap())
    }

    fn events(s: &Shared, task_id: &str) -> Vec<serde_json::Value> {
        db::list_messages(&s.db(), task_id).unwrap().into_iter().filter(|m| m.kind == "event").map(|m| m.data).collect()
    }

    #[test]
    fn runs_the_script_for_each_status_change_in_order() {
        testing::run(async || {
            let s = testing::state();
            let repo = crate::testing::temp_dir();
            let log = repo.join("log");
            let (project, task) = project_and_task(&s, &path_str(&repo));
            let script = format!("echo \"$IA_TASK_KEY $IA_OLD_STATUS $IA_NEW_STATUS $PWD\" >> {}\necho moved", path_str(&log));
            db::update_project(&s.db(), &project.id, &[("status_script", json!(script))]).unwrap();

            s.update_task(&task.id, &[("status", json!("in_progress"))]).unwrap();
            // Not a status change.
            s.update_task(&task.id, &[("title", json!("Renamed"))]).unwrap();
            s.update_task(&task.id, &[("status", json!("in_progress"))]).unwrap();
            s.update_task(&task.id, &[("status", json!("in_review"))]).unwrap();
            s.update_task(&task.id, &[("status", json!("done"))]).unwrap();

            while QUEUES.lock().unwrap().contains_key(&task.id) {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let key = format!("{}-{}", project.key, task.number);
            let dir = path_str(&repo);
            assert_eq!(
                std::fs::read_to_string(&log).unwrap(),
                format!("{key} todo in_progress {dir}\n{key} in_progress in_review {dir}\n{key} in_review done {dir}\n")
            );
            let ev = events(&s, &task.id);
            assert_eq!(ev.len(), 3);
            assert_eq!(ev[0]["text"], "Status script ran (To do → In progress)");
            assert_eq!(ev[0]["detail"], "moved");

            // A failing script says so in the thread.
            db::update_project(&s.db(), &project.id, &[("status_script", json!("echo nope >&2; exit 3"))]).unwrap();
            s.update_task(&task.id, &[("status", json!("todo"))]).unwrap();
            while QUEUES.lock().unwrap().contains_key(&task.id) {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let ev = events(&s, &task.id);
            assert_eq!(ev.last().unwrap()["text"], "Status script failed (Done → To do)");
            assert!(ev.last().unwrap()["detail"].as_str().unwrap().contains("nope"));
            std::fs::remove_dir_all(&repo).ok();
        })
    }

    #[test]
    fn a_column_script_runs_when_a_task_moves_into_its_column() {
        testing::run(async || {
            let s = testing::state();
            let repo = crate::testing::temp_dir();
            let log = path_str(&repo.join("log"));
            let (project, task) = project_and_task(&s, &path_str(&repo));
            let scripts = json!({ "done": format!("echo \"done $IA_OLD_STATUS\" >> {log}"), "in_review": format!("echo review >> {log}") });
            db::update_project(&s.db(), &project.id, &[("status_scripts", json!(scripts.to_string()))]).unwrap();

            for st in ["in_progress", "in_review", "in_progress", "done"] {
                s.update_task(&task.id, &[("status", json!(st))]).unwrap();
            }
            while QUEUES.lock().unwrap().contains_key(&task.id) {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            assert_eq!(std::fs::read_to_string(&log).unwrap(), "review\ndone in_progress\n");
            let ev: Vec<_> = events(&s, &task.id).into_iter().map(|e| e["text"].as_str().unwrap().to_string()).collect();
            assert_eq!(ev, ["In review script ran (In progress → In review)", "Done script ran (In progress → Done)"]);

            // The status script runs too, before the column's.
            db::update_project(&s.db(), &project.id, &[("status_script", json!(format!("echo any >> {log}")))]).unwrap();
            s.update_task(&task.id, &[("status", json!("in_review"))]).unwrap();
            s.update_task(&task.id, &[("status", json!("todo"))]).unwrap();
            while QUEUES.lock().unwrap().contains_key(&task.id) {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            assert_eq!(std::fs::read_to_string(&log).unwrap(), "review\ndone in_progress\nany\nreview\nany\n");
            std::fs::remove_dir_all(&repo).ok();
        })
    }

    #[test]
    fn nothing_runs_without_a_script() {
        testing::run(async || {
            let s = testing::state();
            let (_, task) = project_and_task(&s, "/nonexistent");
            s.update_task(&task.id, &[("status", json!("in_progress"))]).unwrap();
            assert!(!QUEUES.lock().unwrap().contains_key(&task.id));
            assert!(events(&s, &task.id).is_empty());
        })
    }

    #[test]
    fn changes_made_at_once_run_in_the_order_they_were_made() {
        testing::run(async || {
            let s = testing::state();
            let repo = crate::testing::temp_dir();
            let log = repo.join("log");
            let (project, task) = project_and_task(&s, &path_str(&repo));
            let script = format!("echo \"$IA_OLD_STATUS $IA_NEW_STATUS\" >> {}", path_str(&log));
            db::update_project(&s.db(), &project.id, &[("status_script", json!(script))]).unwrap();

            // Several threads move the task at once.
            let movers: Vec<_> = (0..4)
                .map(|i| {
                    let (s, id) = (s.clone(), task.id.clone());
                    tokio::task::spawn_blocking(move || {
                        for n in 0..25 {
                            let st = db::STATUSES[(i * 3 + n) % db::STATUSES.len()];
                            s.update_task(&id, &[("status", json!(st))]).unwrap();
                        }
                    })
                })
                .collect();
            for m in movers {
                m.await.unwrap();
            }
            while QUEUES.lock().unwrap().contains_key(&task.id) {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            // Each script starts where the one before it left off, and the last ends where the task is.
            let log = std::fs::read_to_string(&log).unwrap();
            let mut at = "todo".to_string();
            for line in log.lines() {
                let (old, new) = line.split_once(' ').unwrap();
                assert_eq!(old, at, "out of order:\n{log}");
                at = new.to_string();
            }
            assert!(log.lines().count() > 10);
            assert_eq!(at, db::get_task(&s.db(), &task.id).unwrap().unwrap().status);
            std::fs::remove_dir_all(&repo).ok();
        })
    }

    #[test]
    fn a_script_that_runs_over_is_stopped_with_what_it_started() {
        testing::run(async || {
            let dir = crate::testing::temp_dir();
            let pid_file = dir.join("pid");
            let script = format!("sleep 600 & echo $! > {}; echo started; wait", path_str(&pid_file));
            let err = crate::worktree::run_script(&script, &dir, &[], Some(Duration::from_millis(500))).await.unwrap_err();
            let err = format!("{err:#}");
            assert!(err.contains("stopped it") && err.contains("started"), "{err}");
            let pid = std::fs::read_to_string(&pid_file).unwrap().trim().to_string();
            // Killed: gone, or a zombie until it's reaped.
            let alive = || std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|st| !st.contains(") Z "));
            for _ in 0..50 {
                if !alive() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            assert!(!alive(), "sleep {pid} is still running");
            std::fs::remove_dir_all(&dir).ok();
        })
    }
}
