use super::*;
use crate::state::RunHandle;
use crate::testing;

/// A task whose agent is running, with another task it can watch.
fn running() -> (Shared, Task, Run, Task) {
    let s = testing::state();
    let p = db::insert_profile(&s.db(), "p", &[], None).unwrap();
    let new = |title| db::NewTask { profile_id: &p.id, project_id: None, kind: "task", title, description: "", status: "in_progress", use_worktree: false, model: None, effort: None, claude_config_id: None };
    let task = db::insert_task(&s.db(), new("planner")).unwrap();
    let other = db::insert_task(&s.db(), new("other")).unwrap();
    let run = db::insert_run(&s.db(), &task.id, "prompt").unwrap();
    s.db().execute("UPDATE runs SET status='running' WHERE id=?1", [&run.id]).unwrap();
    s.runs.lock().unwrap().insert(task.id.clone(), RunHandle { run_id: run.id.clone(), cancel: None });
    let task = s.update_task(&task.id, &[("running", json!(true))]).unwrap().unwrap();
    (s, task, run, other)
}

fn secs(seconds: f64) -> Request {
    Request { seconds: Some(seconds), ..Default::default() }
}

fn reload(s: &Shared, id: &str) -> Task {
    db::get_task(&s.db(), id).unwrap().unwrap()
}

/// Run `then` once the task shows as waiting.
fn when_waiting(s: &Shared, id: &str, then: impl FnOnce(&Shared) + Send + 'static) {
    let (s, id) = (s.clone(), id.to_string());
    tokio::spawn(async move {
        while reload(&s, &id).agent_wait.is_none() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        then(&s);
    });
}

#[test]
fn waits_out_the_period_showing_as_waiting() {
    testing::run(async || {
        let (s, task, run, _) = running();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(None));
        let seen2 = seen.clone();
        let id = task.id.clone();
        when_waiting(&s, &task.id, move |s| *seen2.lock().unwrap() = reload(s, &id).agent_wait);
        let started = std::time::Instant::now();
        let ended = wait(&s, &run, &task, "c1", Request { reason: Some(" waiting for CI ".into()), ..secs(1.0) }).await.unwrap().0;
        assert_eq!(ended, Ended::Timeout);
        assert!(started.elapsed() >= Duration::from_millis(900));
        let w = seen.lock().unwrap().clone().unwrap();
        assert_eq!((w.reason.as_deref(), w.call_id.as_str(), w.run_id.as_str()), (Some("waiting for CI"), "c1", run.id.as_str()));
        // Still in progress, and working again.
        let t = reload(&s, &task.id);
        assert_eq!((t.status.as_str(), t.running, t.agent_wait), ("in_progress", true, None));
    });
}

#[test]
fn ends_when_a_watched_task_changes_status() {
    testing::run(async || {
        let (s, task, run, other) = running();
        let id = other.id.clone();
        when_waiting(&s, &task.id, move |s| {
            s.update_task(&id, &[("status", json!("in_review"))]).unwrap();
        });
        let ended = wait(&s, &run, &task, "c1", Request { tasks: vec![WaitTask { id: other.id.clone(), key: "T-2".into(), status: other.status.clone() }], ..secs(30.0) }).await.unwrap().0;
        assert_eq!(ended, Ended::Tasks(vec![other.id.clone()]));
        assert_eq!(reload(&s, &task.id).agent_wait, None);
    });
}

#[test]
fn ends_when_a_message_is_sent_to_the_agent() {
    testing::run(async || {
        let (s, task, run, _) = running();
        let id = task.id.clone();
        // The run takes no input, so the message is queued for when it ends.
        when_waiting(&s, &task.id, move |s| {
            crate::agent::runner::send(s, &id, "come back").unwrap();
        });
        let ended = wait(&s, &run, &task, "c1", secs(30.0)).await.unwrap().0;
        assert_eq!(ended, Ended::Message);
    });
}

#[test]
fn ends_when_the_run_is_stopped_or_the_task_moved() {
    testing::run(async || {
        let (s, task, run, _) = running();
        let run_id = run.id.clone();
        when_waiting(&s, &task.id, move |s| {
            s.db().execute("UPDATE runs SET stop_requested=1 WHERE id=?1", [&run_id]).unwrap();
        });
        assert_eq!(wait(&s, &run, &task, "c1", secs(30.0)).await.unwrap().0, Ended::Stopped);

        // Moved from the board or with update_task, to "Needs attention" too.
        for status in ["done", "needs_attention"] {
            let (s, task, run, _) = running();
            move_when_waiting(&s, &task.id, status);
            assert_eq!(wait(&s, &run, &task, "c1", secs(30.0)).await.unwrap().0, Ended::Moved(status.into()));
        }
    });
}

/// Move the task to `status` as the board does, once it shows as waiting.
fn move_when_waiting(s: &Shared, id: &str, status: &str) {
    let (s, id, body) = (s.clone(), id.to_string(), json!({"status": status}));
    tokio::spawn(async move {
        while reload(&s, &id).agent_wait.is_none() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        crate::api::update_task_inner(&s, &id, body.as_object().unwrap()).await.unwrap();
    });
}

#[test]
fn a_subagents_permission_prompt_isnt_a_move() {
    testing::run(async || {
        let (s, task, run, _) = running();
        let (s2, id) = (s.clone(), task.id.clone());
        let subagent = tokio::spawn(async move {
            while reload(&s2, &id).agent_wait.is_none() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            // The prompt moves the task to "Needs attention", and answering it (Always allow)
            // moves it back.
            let t = reload(&s2, &id);
            let asking = tokio::spawn({
                let s = s2.clone();
                async move { crate::mcp::permissions::prompt(&s, &t, "call-1", "Bash", &json!({"command": "make"}), Some("toolu_sub")).await.unwrap() }
            });
            let request = loop {
                let r: Option<String> = s2.db().query_row("SELECT id FROM permission_requests WHERE call_id='call-1'", [], |r| r.get(0)).ok();
                match r {
                    Some(r) => break r,
                    None => tokio::time::sleep(Duration::from_millis(10)).await,
                }
            };
            assert_eq!(reload(&s2, &id).status, "needs_attention");
            tokio::time::sleep(TICK * 2).await;
            crate::mcp::permissions::decide(&s2, &request, true, true, None).unwrap();
            assert_eq!(asking.await.unwrap()["behavior"], "allow");
            let t = reload(&s2, &id);
            (t.status, t.agent_wait.is_some())
        });
        assert_eq!(wait(&s, &run, &task, "c1", secs(1.5)).await.unwrap().0, Ended::Timeout);
        assert_eq!(subagent.await.unwrap(), ("in_progress".to_string(), true));
    });
}

#[test]
fn its_own_threads_other_tool_calls_end_a_wait() {
    let call = |name: &str, parent: Value| json!({"type": "assistant", "parent_tool_use_id": parent, "message": {"content": [{"type": "tool_use", "name": name}]}});
    assert!(is_activity(&call("Bash", Value::Null)));
    assert!(!is_activity(&call("mcp__huntaway__wait", Value::Null)));
    // A subagent working doesn't: its agent may be waiting for it.
    assert!(!is_activity(&call("Bash", json!("toolu_1"))));
    assert!(!is_activity(&json!({"type": "assistant", "parent_tool_use_id": null, "message": {"content": [{"type": "text", "text": "hi"}]}})));
    testing::run(async || {
        let (s, task, run, _) = running();
        let (id, run_id) = (task.id.clone(), run.id.clone());
        when_waiting(&s, &task.id, move |s| resumed(s, &id, &run_id));
        assert_eq!(wait(&s, &run, &task, "c1", secs(30.0)).await.unwrap().0, Ended::Resumed);
        assert_eq!(reload(&s, &task.id).agent_wait, None);
    });
}

#[test]
fn a_codex_agents_own_tool_calls_end_a_wait() {
    testing::run(async || {
        let (s, task, run, _) = running();
        let task = s.update_task(&task.id, &[("session_id", json!("main"))]).unwrap().unwrap();
        let (id, run_id) = (task.id.clone(), run.id.clone());
        when_waiting(&s, &task.id, move |s| {
            let started = |thread: &str| {
                let item = json!({"type": "commandExecution", "id": "e1", "command": "make", "status": "inProgress"});
                format!("{}\n", json!({"method": "item/started", "params": {"threadId": thread, "turnId": "t", "item": item}}))
            };
            let offset = |s: &Shared| db::get_run(&s.db(), &run_id).unwrap().unwrap().out_offset as u64;
            // A subagent's thread working doesn't end it.
            crate::agent::runner::on_output(s, &run_id, offset(s), &started("sub"));
            assert!(reload(s, &id).agent_wait.is_some());
            crate::agent::runner::on_output(s, &run_id, offset(s), &started("main"));
        });
        assert_eq!(wait(&s, &run, &task, "c1", secs(30.0)).await.unwrap().0, Ended::Resumed);
        assert_eq!(reload(&s, &task.id).agent_wait, None);
    });
    assert!(is_wait_tool("mcp__huntaway__wait") && !is_wait_tool("mcp__huntaway__wait_for") && !is_wait_tool("mcp__other__wait"));
    assert!(is_wait_tool("mcp__issue_agent__wait"), "runs from before the rename");
}

#[test]
fn only_a_subagents_terminal_status_wakes_its_own_run() {
    testing::run(async || {
        let (s, task, run, other) = running();
        // An Agent call needn't be the first content block.
        s.add_message(&task.id, "claude", json!({"type": "assistant", "message": {"content": [
            {"type": "text", "text": "Starting a worker"}, {"type": "tool_use", "name": "Agent", "id": "child"}
        ]}})).unwrap();
        let other_run = db::insert_run(&s.db(), &other.id, "prompt").unwrap();
        let stale_run = db::insert_run(&s.db(), &task.id, "prompt").unwrap();
        let (id, run2) = (task.id.clone(), run.clone());
        let done = json!({"type": "system", "subtype": "task_notification", "tool_use_id": "child", "status": "completed", "summary": "Ready"});
        let done2 = done.clone();
        when_waiting(&s, &task.id, move |s| {
            let original = reload(s, &id).agent_wait.unwrap();
            for event in [
                json!({"subtype": "task_started", "tool_use_id": "child"}),
                json!({"subtype": "task_progress", "tool_use_id": "child", "description": "Working"}),
                json!({"subtype": "task_updated", "tool_use_id": "child", "patch": {"status": "running"}}),
                json!({"subtype": "task_notification", "tool_use_id": "shell-or-internal-agent", "status": "completed"}),
            ] {
                subagent_finished(s, &run2, &event).unwrap();
                assert_eq!(reload(s, &id).agent_wait.as_ref(), Some(&original));
            }
            subagent_finished(s, &stale_run, &done2).unwrap();
            subagent_finished(s, &other_run, &done2).unwrap();
            assert_eq!(reload(s, &id).agent_wait.as_ref(), Some(&original));
            subagent_finished(s, &run2, &done2).unwrap();
            // The first completion wins even if several children finish together.
            subagent_finished(s, &run2, &json!({"subtype": "task_notification", "tool_use_id": "child", "status": "failed"})).unwrap();
        });
        let ended = wait(&s, &run, &task, "c1", secs(30.0)).await.unwrap().0;
        assert_eq!(ended, Ended::Subagent(json!({"tool_use_id": "child", "task_id": null, "status": "completed", "summary": "Ready"})));
        assert_eq!(reload(&s, &task.id).agent_wait, None);
    });
}

#[test]
fn a_subagents_completion_is_kept_until_a_retried_wait_returns() {
    testing::run(async || {
        let (s, task, run, _) = running();
        s.add_message(&task.id, "claude", json!({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "name": "Task", "id": "child"}
        ]}})).unwrap();
        s.add_message(&task.id, "claude", json!({"type": "system", "subtype": "task_started", "tool_use_id": "child", "task_id": "background"})).unwrap();
        // A stored wait from before this field existed can be resumed too.
        let w = json!({"since": now(), "until": (Utc::now() + chrono::Duration::seconds(60)).to_rfc3339(),
            "call_id": "c1", "run_id": run.id});
        s.update_task(&task.id, &[("agent_wait", w)]).unwrap();
        // Claude can identify a background child by task_id instead of tool_use_id.
        subagent_finished(&s, &run, &json!({"subtype": "task_notification", "task_id": "background", "status": "completed", "summary": "Report"})).unwrap();
        let task = reload(&s, &task.id);
        assert!(task.agent_wait.as_ref().unwrap().subagent_finished.is_some());
        let ended = wait(&s, &run, &task, "c1", secs(30.0)).await.unwrap().0;
        assert_eq!(ended, Ended::Subagent(json!({"tool_use_id": "child", "task_id": "background", "status": "completed", "summary": "Report"})));
        assert_eq!(ended.name(), "subagent_finished");
        assert_eq!(note(&ended, &[]), "A subagent finished (see subagent).");
        // A new wait doesn't replay an old completion.
        let task = reload(&s, &task.id);
        assert_eq!(wait(&s, &run, &task, "c2", secs(1.0)).await.unwrap().0, Ended::Timeout);
    });
}

#[test]
fn a_wait_without_tasks_or_a_command_is_short() {
    let watching = || vec![WaitTask { id: "t".into(), key: "T-2".into(), status: "todo".into() }];
    let command = |c: &str| Request { command: Some(c.into()), ..Default::default() };
    assert_eq!(period(&Request::default()), Ok(30.0));
    assert_eq!(period(&secs(30.0)), Ok(30.0));
    assert_eq!(period(&secs(0.1)), Ok(1.0));
    assert_eq!(period(&Request { tasks: watching(), ..Default::default() }), Ok(600.0));
    assert_eq!(period(&Request { tasks: watching(), ..secs(7200.0) }), Ok(3600.0));
    assert_eq!(period(&command("gh pr checks 1 --watch")), Ok(600.0));
    assert_eq!(period(&Request { seconds: Some(1800.0), ..command("gh pr checks 1 --watch") }), Ok(1800.0));
    // A blank command is none.
    let err = period(&Request { seconds: Some(1800.0), ..command("  ") }).unwrap_err();
    assert!(err.contains("30 seconds at most") && err.contains("give the pull_request") && err.contains("a command that exits"), "{err}");
    testing::run(async || {
        let (s, task, run, _) = running();
        let err = wait(&s, &run, &task, "c1", secs(30.5)).await.unwrap_err().to_string();
        assert!(err.starts_with("The wait didn't start"), "{err}");
        assert_eq!(reload(&s, &task.id).agent_wait, None);
    });
}

/// A wait running `command` in the task's working directory (its profile's scratch folder).
fn with_command(s: &Shared, task: &Task, command: &str, seconds: f64) -> Request {
    std::fs::create_dir_all(s.profile_scratch_dir(&task.profile_id)).unwrap();
    Request { command: Some(command.into()), ..secs(seconds) }
}

#[test]
fn ends_when_its_command_exits() {
    testing::run(async || {
        let (s, task, run, _) = running();
        let started = std::time::Instant::now();
        let req = with_command(&s, &task, "sleep 0.3; touch here; echo ready; echo oops >&2; exit 3", 60.0);
        let ended = wait(&s, &run, &task, "c1", req).await.unwrap().0;
        assert_eq!(ended, Ended::Command { code: Some(3), output: "ready\noops\n".into() });
        assert!(started.elapsed() >= Duration::from_millis(300));
        assert!(s.profile_scratch_dir(&task.profile_id).join("here").exists());
        assert_eq!(reload(&s, &task.id).agent_wait, None);

        // Only the end of a long output.
        let req = with_command(&s, &task, "head -c 10000 /dev/zero | tr '\\0' x; echo; echo end", 60.0);
        let Ended::Command { code, output } = wait(&s, &run, &task, "c2", req).await.unwrap().0 else { panic!() };
        assert_eq!(code, Some(0));
        assert!(output.starts_with("… [6005 bytes before this]\n") && output.ends_with("xx\nend\n"), "{output}");
    });
}

#[test]
fn its_command_doesnt_run_as_another_github_account() {
    testing::run(async || {
        // The profile picked an account gh isn't signed in to (or gh isn't installed): the
        // command would run as gh's active account, so it doesn't run at all.
        let (s, task, run, _) = running();
        db::update_profile(&s.db(), &task.profile_id, &[("github_account", json!("not-signed-in-ia123"))]).unwrap();
        let req = with_command(&s, &task, "touch ran", 60.0);
        let err = wait(&s, &run, &task, "c1", req).await.unwrap_err();
        assert!(format!("{err:#}").contains("not-signed-in-ia123"), "{err:#}");
        assert!(!s.profile_scratch_dir(&task.profile_id).join("ran").exists());
        assert_eq!(reload(&s, &task.id).agent_wait, None);
    });
}

#[test]
fn its_command_is_stopped_when_the_wait_ends_otherwise() {
    testing::run(async || {
        let (s, task, run, _) = running();
        let pid_file = s.profile_scratch_dir(&task.profile_id).join("pid");
        // Something it started in the background, as well as the shell itself.
        let req = with_command(&s, &task, &format!("sleep 30 & echo $! > {}; sleep 30", pid_file.display()), 1.0);
        assert_eq!(wait(&s, &run, &task, "c1", req).await.unwrap().0, Ended::Timeout);
        let pid: i32 = std::fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();
        assert!(gone(pid).await, "the command's background process is still running");
    });
}

/// Whether a process is running (not gone, nor a zombie waiting to be reaped).
fn alive(pid: i32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|st| !st.contains(") Z "))
}

/// Wait (a while at most) for `pid` to be gone.
async fn gone(pid: i32) -> bool {
    for _ in 0..100 {
        if !alive(pid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    false
}

#[test]
fn its_command_is_stopped_when_the_server_goes_without_cleaning_up() {
    testing::run(async || {
        let dir = crate::testing::temp_dir();
        let log = std::fs::File::create(dir.join("log")).unwrap();
        let pid_file = dir.join("pid");
        // `wait` waits for its own jobs only, not the watchdog.
        let command = format!("sleep 30 & echo $! > {}; wait", pid_file.display());
        let (child, alive_end) = spawn_command(&command, &dir, &log, &[]).unwrap();
        // An exec doesn't pass the server's end on to the new server.
        use std::os::fd::AsRawFd;
        let flags = unsafe { libc::fcntl(alive_end.as_raw_fd(), libc::F_GETFD) };
        assert!(flags & libc::FD_CLOEXEC != 0);
        let shell = child.id().unwrap() as i32;
        while std::fs::read_to_string(&pid_file).map_or(true, |p| p.trim().is_empty()) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let background: i32 = std::fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(alive(shell) && alive(background));
        // The server goes (exec, exit or crash): no destructors run, but the kernel closes its
        // files.
        std::mem::forget(child);
        drop(alive_end);
        assert!(gone(shell).await, "the command is still running");
        assert!(gone(background).await, "the command's background process is still running");
        std::fs::remove_dir_all(&dir).unwrap();
    });
}

// ---------- pull requests ----------

use crate::mcp::pr_watch::{self, Target, response};
use std::sync::{Arc, Mutex};

/// A fake GitHub (see pr_watch::fake): what reads of its pull requests get, and the account and
/// pull request of each read.
#[derive(Clone)]
struct Github {
    pr: Arc<Mutex<Result<Value, String>>>,
    reads: Arc<Mutex<Vec<(Option<String>, String)>>>,
}

impl Github {
    fn new(pr: Value) -> Self {
        let g = Self { pr: Arc::new(Mutex::new(Ok(pr))), reads: Arc::default() };
        let g2 = g.clone();
        pr_watch::fake(move |account, target| {
            g2.reads.lock().unwrap().push((account.map(String::from), target.label()));
            g2.pr.lock().unwrap().clone()
        });
        g
    }

    fn set(&self, pr: Result<Value, String>) {
        *self.pr.lock().unwrap() = pr;
    }

    fn reads(&self) -> usize {
        self.reads.lock().unwrap().len()
    }

    fn accounts(&self) -> Vec<Option<String>> {
        self.reads.lock().unwrap().iter().map(|(a, _)| a.clone()).collect()
    }
}

fn o_r(number: u64) -> Target {
    Target { host: "github.com".into(), owner: "o".into(), name: "r".into(), number }
}

/// A wait of `seconds` on o/r#7, for all of its news.
fn on_pr(seconds: f64) -> Request {
    let events = pr_watch::EVENTS.iter().map(|e| e.to_string()).collect();
    Request { pull_request: Some(pr_watch::Request { target: o_r(7), events }), ..secs(seconds) }
}

fn pr_events(ended: &Ended) -> Vec<&str> {
    let Ended::PullRequest(news) = ended else { panic!("{ended:?}") };
    news["events"].as_array().unwrap().iter().map(|e| e.as_str().unwrap()).collect()
}

fn authors(ended: &Ended) -> Vec<&str> {
    let Ended::PullRequest(news) = ended else { panic!("{ended:?}") };
    news["comments"].as_array().map_or(vec![], |c| c.iter().map(|c| c["author"].as_str().unwrap()).collect())
}

#[test]
fn ends_on_news_about_its_pull_request() {
    testing::run(async || {
        let (s, task, run, _) = running();
        let gh = Github::new(response("me", "a1", &[("test", "IN_PROGRESS", "", true)], &[("01", "alice", "old")]));
        let shown = Arc::new(Mutex::new(None));
        let (gh2, shown2, id) = (gh.clone(), shown.clone(), task.id.clone());
        when_waiting(&s, &task.id, move |s| {
            *shown2.lock().unwrap() = reload(s, &id).agent_wait.and_then(|w| w.pull_request);
            // A check fails, someone comments, and so does the agent's own account.
            gh2.set(Ok(response("me", "a1", &[("test", "COMPLETED", "FAILURE", true)], &[("01", "alice", "old"), ("02", "me", "mine"), ("03", "bob", "Looks off")])));
        });
        let (ended, w) = wait(&s, &run, &task, "c1", on_pr(30.0)).await.unwrap();
        assert_eq!(pr_events(&ended), ["checks_failed", "comments"]);
        assert_eq!(authors(&ended), ["bob"]);
        let Ended::PullRequest(news) = &ended else { unreachable!() };
        assert_eq!(news["checks"]["failed"][0]["url"], "https://github.com/o/r/actions/runs/0");
        assert_eq!(note(&ended, &[]), "Pull request #7: checks failed (test); 1 new comment or review from bob (see pull_request).");
        // The board showed what it watched.
        let shown = shown.lock().unwrap().clone().unwrap();
        assert_eq!((shown.url.as_str(), shown.repo.as_str(), shown.number, shown.news), ("https://github.com/o/r/pull/7", "o/r", 7, None));
        assert_eq!(w.pull_request.unwrap().news.as_ref(), Some(news));
        assert_eq!(reload(&s, &task.id).agent_wait, None);
        // Read as gh's account (the profile has none).
        assert!(gh.accounts().iter().all(Option::is_none) && gh.reads() >= 2);

        // Told, it isn't news again.
        assert_eq!(wait(&s, &run, &task, "c2", on_pr(0.5)).await.unwrap().0, Ended::Timeout);
        // A review left while the agent worked between waits ends the next one straight away.
        gh.set(Ok(response("me", "a1", &[("test", "COMPLETED", "FAILURE", true)], &[("01", "alice", "old"), ("03", "bob", "Looks off"), ("04", "carol", "Approve?")])));
        let started = std::time::Instant::now();
        let ended = wait(&s, &run, &task, "c3", on_pr(30.0)).await.unwrap().0;
        assert_eq!((pr_events(&ended), authors(&ended)), (vec!["comments"], vec!["carol"]));
        assert!(started.elapsed() < Duration::from_secs(5));
        // Merged ends it whatever it waits for.
        let mut merged = response("me", "a1", &[], &[]);
        merged["data"]["repository"]["pullRequest"]["state"] = json!("MERGED");
        gh.set(Ok(merged));
        let req = Request { pull_request: Some(pr_watch::Request { target: o_r(7), events: vec![] }), ..secs(30.0) };
        assert_eq!(pr_events(&wait(&s, &run, &task, "c4", req).await.unwrap().0), ["merged"]);
    });
}

#[test]
fn a_pull_request_that_cant_be_read_doesnt_start_the_wait() {
    testing::run(async || {
        let (s, task, run, _) = running();
        let gh = Github::new(json!(null));
        gh.set(Err("Could not resolve to a Repository with the name 'o/r'.".into()));
        let err = format!("{:#}", wait(&s, &run, &task, "c1", on_pr(30.0)).await.unwrap_err());
        assert_eq!(err, "The wait didn't start: o/r#7 couldn't be read: Could not resolve to a Repository with the name 'o/r'.");
        assert_eq!(reload(&s, &task.id).agent_wait, None);
        // A host from the task's remote that isn't GitHub's (an SSH alias ssh doesn't know) asks for the URL.
        gh.set(Err("gh failed: none of the git remotes configured for this repository point to a known GitHub host".into()));
        let target = Target { host: "github-work".into(), ..o_r(7) };
        let req = Request { pull_request: Some(pr_watch::Request { target, events: vec![] }), ..secs(30.0) };
        let err = format!("{:#}", wait(&s, &run, &task, "c2", req).await.unwrap_err());
        assert!(err.ends_with("known GitHub host (if github-work isn't a GitHub host, give the pull request's URL)"), "{err}");
    });
}

#[test]
fn its_pull_request_is_read_as_the_tasks_github_account_only() {
    testing::run(async || {
        // The personal profile's agents act as one account, the work profile's as another, whose
        // project's pull request the personal one's agent asks for.
        let (s, task, run, _) = running();
        db::update_profile(&s.db(), &task.profile_id, &[("github_account", json!("me-personal"))]).unwrap();
        let work = db::insert_profile(&s.db(), "work", &[], None).unwrap();
        db::update_profile(&s.db(), &work.id, &[("github_account", json!("me-work"))]).unwrap();
        let gh = Github::new(json!(null));
        let gh2 = gh.clone();
        pr_watch::fake(move |account, target| {
            gh2.reads.lock().unwrap().push((account.map(String::from), target.label()));
            match account {
                Some("me-work") => Ok(response("me-work", "a1", &[], &[("01", "boss", "secret")])),
                _ => Err("Could not resolve to a Repository with the name 'work-org/secret'.".into()),
            }
        });
        let target = Target { host: "github.com".into(), owner: "work-org".into(), name: "secret".into(), number: 7 };
        let req = Request { pull_request: Some(pr_watch::Request { target, events: vec!["comments".into()] }), ..secs(30.0) };
        let err = format!("{:#}", wait(&s, &run, &task, "c1", req).await.unwrap_err());
        assert!(err.contains("couldn't be read: Could not resolve"), "{err}");
        assert_eq!(*gh.reads.lock().unwrap(), [(Some("me-personal".to_string()), "work-org/secret#7".to_string())]);
        // Nor is one on another host than its account's asked for at all.
        db::update_profile(&s.db(), &task.profile_id, &[("github_account", json!("ghe.acme.com/me"))]).unwrap();
        let err = pr_watch::request(&s, &task, &json!("https://github.com/work-org/secret/pull/7"), &Value::Null).await.unwrap_err();
        assert!(err.contains("is on github.com, but this task's GitHub account ghe.acme.com/me is on ghe.acme.com"), "{err}");
        assert_eq!(gh.reads(), 1);
        // A profile whose account isn't gh's default reads as that account.
        let gh = Github::new(response("me-work", "a1", &[], &[]));
        db::update_profile(&s.db(), &task.profile_id, &[("github_account", json!("me-work"))]).unwrap();
        assert_eq!(wait(&s, &run, &task, "c2", on_pr(0.3)).await.unwrap().0, Ended::Timeout);
        assert!(gh.reads() >= 2 && gh.accounts().iter().all(|a| a.as_deref() == Some("me-work")), "{:?}", gh.accounts());
    });
}

#[test]
fn a_pull_request_wait_carried_on_after_a_restart_keeps_what_was_seen() {
    testing::run(async || {
        let (s, task, run, _) = running();
        let gh = Github::new(response("me", "a1", &[], &[("01", "alice", "old")]));
        // A first wait sees alice's comment.
        assert_eq!(wait(&s, &run, &task, "c1", on_pr(0.3)).await.unwrap().0, Ended::Timeout);
        // The server restarts during the next one, and bob comments meanwhile.
        let stored = |news: Option<Value>| AgentWait {
            reason: Some("waiting for review".into()),
            since: now(),
            until: (Utc::now() + chrono::Duration::seconds(30)).to_rfc3339(),
            tasks: vec![],
            command: None,
            call_id: "c2".into(),
            run_id: run.id.clone(),
            moved_to: None,
            subagent_finished: None,
            pull_request: Some(on_pr(1.0).pull_request.unwrap().stored(news)),
        };
        let task = s.update_task(&task.id, &[("agent_wait", json!(stored(None)))]).unwrap().unwrap();
        gh.set(Ok(response("me", "a1", &[], &[("01", "alice", "old"), ("02", "bob", "new")])));
        let started = std::time::Instant::now();
        let ended = wait(&s, &run, &task, "c2", secs(30.0)).await.unwrap().0;
        assert_eq!(authors(&ended), ["bob"]);
        assert!(started.elapsed() < Duration::from_secs(5));
        // News found before a restart is returned without reading again.
        let reads = gh.reads();
        let news = json!({"events": ["closed"], "number": 7});
        let task = s.update_task(&task.id, &[("agent_wait", json!(stored(Some(news.clone()))))]).unwrap().unwrap();
        assert_eq!(wait(&s, &run, &task, "c2", secs(30.0)).await.unwrap().0, Ended::PullRequest(news));
        assert_eq!(gh.reads(), reads);
    });
}

#[test]
fn news_that_doesnt_reach_the_agent_is_reported_again() {
    testing::run(async || {
        let (s, task, run, _) = running();
        let _gh = Github::new(response("me", "a1", &[("test", "COMPLETED", "FAILURE", false)], &[]));
        // A read for the wait c1 found the failure, and then the run was stopped.
        let mut w = pr_watch::Watcher::new(&s, &task, o_r(7)).unwrap();
        let events: Vec<String> = pr_watch::EVENTS.iter().map(|e| e.to_string()).collect();
        let news = w.poll(&s, &task.id, "c1", &events).await.unwrap();
        assert!(news.is_some());
        let pr = on_pr(1.0).pull_request.unwrap().stored(news);
        let stored = AgentWait {
            reason: None, since: now(), until: (Utc::now() + chrono::Duration::seconds(30)).to_rfc3339(), tasks: vec![], command: None,
            call_id: "c1".into(), run_id: run.id.clone(), moved_to: None, subagent_finished: None, pull_request: Some(pr),
        };
        let task = s.update_task(&task.id, &[("agent_wait", json!(stored))]).unwrap().unwrap();
        s.db().execute("UPDATE runs SET stop_requested=1 WHERE id=?1", [&run.id]).unwrap();
        assert_eq!(wait(&s, &run, &task, "c1", secs(30.0)).await.unwrap().0, Ended::Stopped);
        // The next run's wait is told.
        let (s2, task2, run2) = (s.clone(), reload(&s, &task.id), db::insert_run(&s.db(), &task.id, "prompt").unwrap());
        s2.db().execute("UPDATE runs SET status='running' WHERE id=?1", [&run2.id]).unwrap();
        assert_eq!(pr_events(&wait(&s2, &run2, &task2, "c2", on_pr(30.0)).await.unwrap().0), ["checks_failed"]);
        assert_eq!(wait(&s2, &run2, &task2, "c3", on_pr(0.3)).await.unwrap().0, Ended::Timeout);
    });
}

#[test]
fn a_pull_request_that_stops_being_readable_ends_the_wait() {
    testing::run(async || {
        let (s, task, run, _) = running();
        let gh = Github::new(response("me", "a1", &[], &[]));
        let gh2 = gh.clone();
        when_waiting(&s, &task.id, move |_| gh2.set(Err("HTTP 502: Bad Gateway".into())));
        let ended = wait(&s, &run, &task, "c1", on_pr(30.0)).await.unwrap().0;
        assert_eq!(pr_events(&ended), ["unreadable"]);
        assert_eq!(gh.reads(), 1 + pr_watch::GIVE_UP as usize);
        assert_eq!(
            note(&ended, &[]),
            "o/r#7 couldn't be read 5 times in a row: HTTP 502: Bad Gateway. Check it yourself (pr_view), and wait on it again once it can be read."
        );
    });
}

#[test]
fn a_wait_on_a_pull_request_is_watched() {
    assert_eq!(period(&on_pr(1800.0)), Ok(1800.0));
    assert_eq!(period(&Request { seconds: None, ..on_pr(1.0) }), Ok(600.0));
}

#[test]
fn a_retried_call_carries_on_with_its_deadline() {
    testing::run(async || {
        let (s, task, run, other) = running();
        // As if the server restarted with the call waiting since a while ago.
        let w = AgentWait {
            reason: Some("r".into()),
            since: now(),
            until: (Utc::now() + chrono::Duration::milliseconds(300)).to_rfc3339(),
            tasks: vec![WaitTask { id: other.id.clone(), key: "T-2".into(), status: "in_progress".into() }],
            command: None,
            call_id: "c1".into(),
            run_id: run.id.clone(),
            moved_to: None,
            subagent_finished: None,
            pull_request: None,
        };
        let task = s.update_task(&task.id, &[("agent_wait", json!(w))]).unwrap().unwrap();
        let started = std::time::Instant::now();
        assert_eq!(wait(&s, &run, &task, "c1", secs(30.0)).await.unwrap().0, Ended::Timeout);
        assert!(started.elapsed() < Duration::from_secs(5));
        // The watched task changed while the server was down.
        s.update_task(&other.id, &[("status", json!("done"))]).unwrap();
        let task = s.update_task(&task.id, &[("agent_wait", json!(w))]).unwrap().unwrap();
        assert_eq!(wait(&s, &run, &task, "c1", secs(30.0)).await.unwrap().0, Ended::Tasks(vec![other.id.clone()]));
    });
}
