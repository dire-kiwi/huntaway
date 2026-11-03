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

/// Stops the backend's processes (they stay alive between turns), so they leave nothing behind.
async fn close_fake(s: &Shared) {
    if let Some(b) = backend(s) {
        b.close(true).await.unwrap();
    }
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
        close_fake(&s).await;
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
        close_fake(&s).await;
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
        close_fake(&s).await;
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
        close_fake(&s).await;
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
        close_fake(&s).await;
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
        close_fake(&s).await;
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
                return close_fake(&s).await;
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
        close_fake(&s).await;
    })
}

/// The board's own messages and other agents' are sent with a client id, which their user_message items carry
/// for their origin to be kept by; the user's own aren't.
#[test]
fn messages_not_wholly_the_users_carry_their_origin() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        start_fake(&s, &[("IA_FAKE_CLAUDE_SLEEP", "1")]);
        let t = new_task(&s);
        // Started with no message: the board's start message (auto).
        runner::send_as(&s, &t.id, "", true).unwrap();
        until(&s, &t.id, "its run going", |_| db::active_runs(&s.db()).unwrap().iter().any(|r| r.status == "running")).await;
        runner::send_from_agent(&s, &t.id, "from another agent").unwrap();
        until(&s, &t.id, "to in_review", |t| !t.running && t.status == "in_review").await;
        runner::send(&s, &t.id, "the user's own").unwrap();
        until(&s, &t.id, "running", |t| t.running).await;
        until(&s, &t.id, "to in_review again", |t| !t.running && t.status == "in_review").await;
        let snap = backend(&s).unwrap().snapshot(&t.id).await.unwrap();
        let users: Vec<(String, Option<String>)> = snap
            .items
            .iter()
            .filter_map(|i| match i {
                Item::UserMessage(m) => Some((m.text.clone(), m.client_id.clone())),
                _ => None,
            })
            .collect();
        assert_eq!(users.len(), 3, "{users:?}");
        assert!(users[0].0.contains("Start working on this task") && users[0].1.is_some(), "{users:?}");
        assert!(users[1].0 == "from another agent" && users[1].1.is_some(), "{users:?}");
        assert!(users[2].0 == "the user's own" && users[2].1.is_none(), "{users:?}");
        let ids: Vec<String> = users.iter().filter_map(|u| u.1.clone()).collect();
        let left = ORIGINS.lock().unwrap();
        assert!(ids.iter().all(|c| !left.contains_key(c)), "the follower took their origins");
        close_fake(&s).await;
    })
}

/// "Stop, then do this instead": the follow-up starts a new turn in the same run, which then ends as that turn
/// did, not as stopped.
#[test]
fn a_message_after_a_stop_carries_on_in_a_new_turn() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        start_fake(&s, &[("IA_FAKE_CLAUDE_SLEEP", "3")]);
        let t = new_task(&s);
        runner::send(&s, &t.id, "the first thing").unwrap();
        // Once the agent is at work on its turn (it has said its session): a stop before then ends the run as
        // stopped, as an agent that hasn't started its turn has nothing to interrupt.
        until(&s, &t.id, "its agent at work", |t| t.running && t.session_id.is_some()).await;
        assert!(runner::stop(&s, &t.id));
        runner::send(&s, &t.id, "do this instead").unwrap();
        let done = until(&s, &t.id, "its run ended", |t| !t.running).await;
        let snap = backend(&s).unwrap().snapshot(&t.id).await.unwrap();
        let items: Vec<String> = snap.items.iter().map(|i| serde_json::to_string(i).unwrap()).collect();
        assert!(last_reply(&s, &t.id).await.contains("do this instead"), "{}", items.join("\n"));
        assert_eq!((done.status.as_str(), done.attention_reason.as_deref()), ("in_review", None), "{}", items.join("\n"));
        close_fake(&s).await;
    })
}

/// Many short turns at once: each task's run ends once, with its turn's outcome, however far behind the
/// follower is (it's slowed down here, as it is under load).
#[test]
fn fast_turns_on_many_tasks_end_their_runs_once_each() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        start_fake(&s, &[]);
        FOLLOW_DELAY.set(30);
        let tasks: Vec<Task> = (0..12).map(|_| new_task(&s)).collect();
        for t in &tasks {
            runner::send(&s, &t.id, "quick").unwrap();
        }
        for t in &tasks {
            until(&s, &t.id, "to in_review", |t| !t.running && t.status == "in_review").await;
        }
        // Nothing follows: no run adopted from a turn that had ended.
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        for t in &tasks {
            let (runs, ok): (i64, i64) = s
                .db()
                .query_row("SELECT COUNT(*), SUM(saw_result) FROM runs WHERE task_id=?1", [&t.id], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap();
            assert_eq!((runs, ok), (1, 1), "one run each");
            let failed: i64 =
                s.db().query_row("SELECT COUNT(*) FROM messages WHERE task_id=?1 AND kind='event' AND data LIKE '%Run failed%'", [&t.id], |r| r.get(0)).unwrap();
            assert_eq!(failed, 0);
            assert_eq!(db::get_task(&s.db(), &t.id).unwrap().unwrap().status, "in_review");
        }
        close_fake(&s).await;
    })
}

/// A question kept open after its run ended (it was stopped) is answered: the crate sends the answer as the
/// next message, which gets a board run of its own, and the thread's helpers call the board as that run.
#[test]
fn a_late_answer_gets_a_run_that_the_board_tools_reach() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        start_fake(&s, &[("IA_FAKE_CLAUDE_SLEEP", "1")]);
        let t = new_task(&s);
        let call = |id: &str| crate::mcp::tools::McpCall {
            run_id: helper_run_id(&t.id),
            call_id: id.into(),
            tool: "get_task".into(),
            args: json!({"task_id": t.id}),
            task_fields: true,
        };
        // Behind, as under load: the answer's turn can end before the follower sees it start.
        FOLLOW_DELAY.set(25);
        runner::send(&s, &t.id, "fake-ask-question").unwrap();
        let asked = until(&s, &t.id, "a question", |t| t.status == "needs_attention").await;
        assert_eq!(asked.attention_reason.as_deref(), Some("Which one?"));
        // While it runs, its helpers' calls are its run's.
        crate::mcp::tools::handle_mcp(&s, call("c1")).await.unwrap();
        assert!(runner::stop(&s, &t.id));
        until(&s, &t.id, "stopped", |t| !t.running).await;
        let err = crate::mcp::tools::handle_mcp(&s, call("c2")).await.unwrap_err();
        assert!(err.contains("no run going"), "{err}");
        let b = backend(&s).unwrap();
        let snap = b.snapshot(&t.id).await.unwrap();
        let open: Vec<Value> = snap.requests.iter().map(|r| serde_json::to_value(r).unwrap()).filter(|r| r["resolution"].is_null()).collect();
        assert_eq!(open.len(), 1, "the question is kept: {open:?}");
        let resolution: agent_threads::protocol::Resolution =
            serde_json::from_value(json!({"outcome": "answer", "answers": {"Which one?": ["b"]}})).unwrap();
        b.respond(&t.id, open[0]["id"].as_str().unwrap(), resolution).await.unwrap();
        // A board tool called in its turn reaches the board as its run (adopted then, if the follower is behind).
        for _ in 0..200 {
            if running_turn(b, &t.id).await.is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        crate::mcp::tools::handle_mcp(&s, call("c3")).await.unwrap();
        until(&s, &t.id, "to in_review", |t| !t.running && t.status == "in_review").await;
        let runs: i64 = s.db().query_row("SELECT COUNT(*) FROM runs WHERE task_id=?1", [&t.id], |r| r.get(0)).unwrap();
        assert_eq!(runs, 2);
        close_fake(&s).await;
    })
}

/// The helpers' config has no token (Claude Code's is on its command line): they read it from a file of the
/// user's own.
#[test]
fn the_helpers_read_the_token_from_a_private_file() {
    crate::testing::run(async || {
        let id = crate::state::Identity {
            host_id: "h".into(),
            host_name: "desktop".into(),
            token: "the-hosts-token".into(),
            hub_token: String::new(),
            internal_url: "http://127.0.0.1:1".into(),
        };
        let s = crate::testing::state_as(id);
        start_fake(&s, &[]);
        let t = fix(&s, new_task(&s)).unwrap();
        let run = db::insert_run(&s.db(), &t.id, "prompt").unwrap();
        let spec = Spec {
            codex: false, cwd: "/".into(), text: String::new(), compact: false, model: None, effort: None, permission_mode: "default".into(),
            system_prompt: String::new(), args: vec![], allowed: vec![], add_dirs: vec![], env: vec![], config_dir: None, mcp_servers: Map::new(),
            skills: vec![], github_account: None,
        };
        let servers = mcp_servers(&s, &run, &spec);
        for (name, server) in &servers {
            let McpServer::Stdio { env, .. } = server else { panic!("{name}") };
            assert!(!env.contains_key("IA_TOKEN") && !env.values().any(|v| v.contains("the-hosts-token")), "{name}: {env:?}");
            assert_eq!(env["IA_RUN_ID"], format!("thread:{}", t.id));
            assert_eq!(std::fs::read_to_string(&env["IA_TOKEN_FILE"]).unwrap(), "the-hosts-token");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(token_file(&s)).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // Codex's timeouts for the board's servers, as its adapter has them: a wait lasts up to an hour.
        assert_eq!(servers["huntaway"].codex_settings().unwrap()["tool_timeout_sec"], json!(crate::mcp::wait::MAX_SECS + 300));
        assert_eq!(servers["huntaway"].codex_settings().unwrap()["default_tools_approval_mode"], json!("approve"));
        assert_eq!(servers["gh"].codex_settings().unwrap()["tool_timeout_sec"], json!(600));
        // Codex's sandbox has the network, as the board's own adapter gives it.
        assert_eq!(codex_config()["sandbox_workspace_write.network_access"], json!(true));
        close_fake(&s).await;
    })
}
