//! Agent-threads tasks run on scripts/fake-claude (its stream-json session mode) with the direct spawner:
//! the engine is fixed with the first run, the turn's end moves the task on, and messages, stops and
//! permission prompts go through the crate.

use super::*;
use crate::agent::runner;

/// A backend whose `claude` is scripts/fake-claude, with `env` (IA_FAKE_CLAUDE_SLEEP...), started on `s`.
fn start_fake(s: &Shared, env: &[(&str, &str)]) {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/fake-claude");
    let claude = ClaudeCodeOptions {
        bin: "python3".into(),
        bin_args: vec![path_str(&script)],
        env: env.iter().map(|(k, v)| (k.to_string(), Some(v.to_string()))).collect(),
        user_settings: true,
        stop_grace: std::time::Duration::from_secs(2),
        ..Default::default()
    };
    start_with(s, build_with(s, agent_threads::direct(), claude, CodexOptions::default()));
}

/// A task (no project) on `s`, with new tasks on agent-threads.
fn new_task(s: &Shared) -> Task {
    db::set_setting(&s.db(), NEW_TASKS, Some("true")).unwrap();
    crate::agent::runs::TEST_CAN_RUN.set(true);
    crate::testing::task(s)
}

/// Waits (up to 20s) for `f` to hold of the task.
async fn until(s: &Shared, id: &str, what: &str, f: impl Fn(&Task) -> bool) -> Task {
    for _ in 0..400 {
        let t = db::get_task(&s.db(), id).unwrap().unwrap();
        if f(&t) {
            return t;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let thread = match backend(s) {
        Some(b) => match b.snapshot(id).await {
            Ok(snap) => format!("{:?}\n{}", snap.thread.status, snap.items.iter().map(|i| serde_json::to_string(i).unwrap()).collect::<Vec<_>>().join("\n")),
            Err(e) => e.to_string(),
        },
        None => "no backend".into(),
    };
    let runs: Vec<String> = db::active_runs(&s.db()).unwrap().iter().map(|r| format!("{} {} {}", r.id, r.status, r.task_id)).collect();
    panic!("the task never got {what}: {:?}\nactive runs: {runs:?}\nits thread: {thread}", db::get_task(&s.db(), id).unwrap());
}

/// The text of the thread's last assistant message.
async fn last_reply(s: &Shared, id: &str) -> String {
    let snap = backend(s).unwrap().snapshot(id).await.unwrap();
    snap.items
        .iter()
        .rev()
        .find_map(|i| match i {
            Item::AssistantMessage(m) => Some(m.text.clone()),
            _ => None,
        })
        .unwrap_or_default()
}

#[test]
fn the_engine_is_fixed_with_the_first_run() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let t = crate::testing::task(&s);
        // No backend: legacy, whatever the setting.
        db::set_setting(&s.db(), NEW_TASKS, Some("true")).unwrap();
        assert_eq!(fix(&s, t).unwrap().run_engine.as_deref(), Some(LEGACY));

        start_fake(&s, &[]);
        let t = crate::testing::task(&s);
        let t = fix(&s, t).unwrap();
        assert_eq!(t.run_engine.as_deref(), Some(AGENT_THREADS));
        // Fixed: turning the setting off doesn't move it.
        db::set_setting(&s.db(), NEW_TASKS, None).unwrap();
        assert_eq!(fix(&s, t).unwrap().run_engine.as_deref(), Some(AGENT_THREADS));
        let t = crate::testing::task(&s);
        assert_eq!(fix(&s, t).unwrap().run_engine.as_deref(), Some(LEGACY));

        // A conversation from before (a session), or a review, stays legacy.
        db::set_setting(&s.db(), NEW_TASKS, Some("true")).unwrap();
        let t = crate::testing::task(&s);
        let t = db::update_task(&s.db(), &t.id, &[("session_id", json!("s-1"))]).unwrap().unwrap();
        assert_eq!(fix(&s, t).unwrap().run_engine.as_deref(), Some(LEGACY));
        let t = crate::testing::task(&s);
        s.db().execute("UPDATE tasks SET kind='review' WHERE id=?1", [&t.id]).unwrap();
        let t = db::get_task(&s.db(), &t.id).unwrap().unwrap();
        assert_eq!(fix(&s, t).unwrap().run_engine.as_deref(), Some(LEGACY));
    })
}

#[test]
fn a_task_runs_a_turn_and_a_follow_up_on_agent_threads() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        start_fake(&s, &[]);
        let t = new_task(&s);
        runner::send(&s, &t.id, "hello there").unwrap();
        let done = until(&s, &t.id, "to in_review", |t| !t.running && t.status == "in_review").await;
        assert_eq!(done.run_engine.as_deref(), Some(AGENT_THREADS));
        assert!(done.session_id.is_some(), "the thread's session is the task's");
        assert!(last_reply(&s, &t.id).await.contains("hello there"));
        let runs: Vec<(String, bool)> = {
            let c = s.db();
            let mut st = c.prepare("SELECT status, saw_result FROM runs WHERE task_id=?1").unwrap();
            st.query_map([&t.id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(Result::unwrap).collect()
        };
        assert_eq!(runs, vec![("exited".to_string(), true)]);
        assert!(!s.is_running(&t.id));

        runner::send(&s, &t.id, "and again").unwrap();
        until(&s, &t.id, "running", |t| t.running).await;
        until(&s, &t.id, "to in_review again", |t| !t.running && t.status == "in_review").await;
        assert!(last_reply(&s, &t.id).await.contains("and again"));
        let sessions: i64 = s.db().query_row("SELECT COUNT(DISTINCT session_id) FROM runs WHERE task_id=?1", [&t.id], |r| r.get(0)).unwrap();
        assert_eq!(sessions, 1, "the follow-up resumes the session");
    })
}

#[test]
fn a_message_sent_while_it_works_steers_the_turn() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        start_fake(&s, &[("IA_FAKE_CLAUDE_SLEEP", "2")]);
        let t = new_task(&s);
        runner::send(&s, &t.id, "first").unwrap();
        // Sent while the run is being prepared, then once it's going.
        runner::send(&s, &t.id, "early").unwrap();
        until(&s, &t.id, "its run going", |_| db::active_runs(&s.db()).unwrap().iter().any(|r| r.status == "running")).await;
        let steered = runner::send(&s, &t.id, "later").unwrap();
        assert!(steered.queued_message.is_none(), "it isn't queued for later");
        until(&s, &t.id, "to in_review", |t| !t.running && t.status == "in_review").await;
        let reply = last_reply(&s, &t.id).await;
        assert!(reply.contains("early") && reply.contains("later"), "{reply}");
        let runs: i64 = s.db().query_row("SELECT COUNT(*) FROM runs WHERE task_id=?1", [&t.id], |r| r.get(0)).unwrap();
        assert_eq!(runs, 1, "one run took all three");
        let steers: i64 =
            s.db().query_row("SELECT COUNT(*) FROM messages WHERE task_id=?1 AND kind='user' AND json_extract(data,'$.steered')=1", [&t.id], |r| r.get(0)).unwrap();
        assert_eq!(steers, 2, "the board's thread has them");
        assert!(db::get_task(&s.db(), &t.id).unwrap().unwrap().steering.is_empty());
    })
}

#[test]
fn a_stop_interrupts_the_turn() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        start_fake(&s, &[("IA_FAKE_CLAUDE_SLEEP", "30")]);
        let t = new_task(&s);
        runner::send(&s, &t.id, "take your time").unwrap();
        until(&s, &t.id, "its run going", |_| db::active_runs(&s.db()).unwrap().iter().any(|r| r.status == "running")).await;
        assert!(runner::stop(&s, &t.id));
        let t = until(&s, &t.id, "stopped", |t| !t.running).await;
        assert_eq!((t.status.as_str(), t.attention_reason.as_deref()), ("needs_attention", Some("Stopped by user")));
        let snap = backend(&s).unwrap().snapshot(&t.id).await.unwrap();
        assert!(snap.items.iter().any(|i| matches!(i, Item::TurnResult(r) if r.interrupted)), "the turn ended as interrupted");
    })
}

#[test]
fn permissions_are_the_boards_prompts() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        start_fake(&s, &[]);
        let t = new_task(&s);
        runner::send(&s, &t.id, "fake-ask-permission please").unwrap();
        let asked = until(&s, &t.id, "a prompt", |t| t.status == "needs_attention").await;
        assert_eq!(asked.attention_reason.as_deref(), Some("Approve Bash?"));
        let pending = crate::mcp::permissions::pending(&s, Some(&t.id)).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0]["input"], json!({"command": "echo fake"}));
        crate::mcp::permissions::decide(&s, pending[0]["id"].as_str().unwrap(), true, false, None).unwrap();
        until(&s, &t.id, "to in_review", |t| !t.running && t.status == "in_review").await;
        assert!(last_reply(&s, &t.id).await.contains("(permission: allow)"));

        // Allowed tools (the board's own, say) aren't asked about.
        assert!(is_allowed(&["mcp__huntaway".into()], "mcp__huntaway__get_task") && !is_allowed(&["mcp__huntaway".into()], "mcp__huntaway2__x"));
    })
}

#[test]
fn a_restart_leaves_runs_to_the_engine() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        start_fake(&s, &[]);
        let t = new_task(&s);
        let t = fix(&s, t).unwrap();
        // A run that was going when the server stopped, and one that was still being prepared.
        let run = db::insert_run(&s.db(), &t.id, "prompt").unwrap();
        s.db().execute("UPDATE runs SET status='running' WHERE id=?1", [&run.id]).unwrap();
        s.update_task(&t.id, &[("running", json!(true)), ("status", json!("in_progress"))]).unwrap();
        let other = fix(&s, new_task(&s)).unwrap();
        let preparing = db::insert_run(&s.db(), &other.id, "prompt").unwrap();
        s.update_task(&other.id, &[("running", json!(true)), ("status", json!("in_progress"))]).unwrap();
        runner::load_active(&s).unwrap();
        // Not followed as a legacy run (it has no run directory), and still going until the engine says.
        assert!(s.is_running(&t.id));
        assert_eq!(db::get_run(&s.db(), &run.id).unwrap().unwrap().status, "running");
        assert_eq!(db::get_run(&s.db(), &preparing.id).unwrap().unwrap().status, "exited");
        // Its thread has nothing running: recovering ends the run.
        recover(&s).await;
        let t = until(&s, &t.id, "its run ended", |t| !t.running).await;
        assert_eq!(t.status, "needs_attention");
        assert!(!s.is_running(&t.id));
    })
}

#[test]
fn migration_86_makes_older_tasks_legacy_once() {
    let dir = crate::testing::temp_dir();
    let path = dir.join("db.sqlite");
    let c = db::open(&path).unwrap();
    let p = db::insert_profile(&c, "p", &[], None).unwrap();
    let nt = |title| db::NewTask {
        profile_id: &p.id, project_id: None, kind: "task", title, description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None,
    };
    let old = db::insert_task(&c, nt("old")).unwrap();
    // As a database from before: no column, at version 85.
    c.execute_batch("ALTER TABLE tasks DROP COLUMN run_engine; PRAGMA user_version=85;").unwrap();
    drop(c);
    let c = db::open(&path).unwrap();
    assert_eq!(db::get_task(&c, &old.id).unwrap().unwrap().run_engine.as_deref(), Some(LEGACY));
    let new = db::insert_task(&c, nt("new")).unwrap();
    assert_eq!(new.run_engine, None, "a new task's engine waits for its first run");
    // Again, as when another migration took the version first: nothing changes.
    c.execute_batch("PRAGMA user_version=85;").unwrap();
    drop(c);
    let c = db::open(&path).unwrap();
    assert_eq!(db::get_task(&c, &new.id).unwrap().unwrap().run_engine, None);
}

#[test]
fn deleting_a_task_deletes_its_thread_and_ends_its_run() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        start_fake(&s, &[("IA_FAKE_CLAUDE_SLEEP", "30")]);
        let t = new_task(&s);
        runner::send(&s, &t.id, "take your time").unwrap();
        until(&s, &t.id, "its run going", |_| db::active_runs(&s.db()).unwrap().iter().any(|r| r.status == "running")).await;
        crate::api::delete_one(&s, &t, false).await.unwrap();
        for _ in 0..200 {
            if !s.is_running(&t.id) && backend(&s).unwrap().get(&t.id).await.unwrap().is_none() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        panic!("still running {} / thread {:?}", s.is_running(&t.id), backend(&s).unwrap().get(&t.id).await.unwrap().map(|t| t.status));
    })
}

/// Stopping a task's agents without deleting it (as fanout's retire does) keeps its thread.
#[test]
fn an_abort_keeps_the_thread() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        start_fake(&s, &[("IA_FAKE_CLAUDE_SLEEP", "30")]);
        let t = new_task(&s);
        runner::send(&s, &t.id, "take your time").unwrap();
        until(&s, &t.id, "its run going", |_| db::active_runs(&s.db()).unwrap().iter().any(|r| r.status == "running")).await;
        assert!(runner::abort(&s, &t.id));
        until(&s, &t.id, "stopped", |t| !t.running).await;
        assert!(backend(&s).unwrap().get(&t.id).await.unwrap().is_some());
    })
}
