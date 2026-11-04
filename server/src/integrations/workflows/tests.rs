use std::path::{Path, PathBuf};

use super::*;
use crate::agent::runner::Outcome;

fn git(dir: &Path, args: &[&str]) {
    assert!(std::process::Command::new("git").arg("-C").arg(dir).args(args).status().unwrap().success());
}

/// A project, and a task in review with a worktree that has a commit of its own on a branch off master.
fn setup(s: &Shared) -> (db::Project, db::Task, PathBuf) {
    let p = db::insert_profile(&s.db(), "p", &[], None).unwrap();
    let np = db::NewProject { id: "pr", profile_id: &p.id, name: "x", key: "X", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: Some("master"), use_worktrees: true };
    let project = db::insert_project(&s.db(), np).unwrap();
    let nt = db::NewTask {
        profile_id: &p.id,
        project_id: Some("pr"),
        kind: "task",
        title: "Fix the thing",
        description: "Make it work.",
        status: "in_review",
        use_worktree: true,
        model: None,
        effort: None,
        claude_config_id: None,
    };
    let task = db::insert_task(&s.db(), nt).unwrap();
    let dir = crate::testing::temp_dir();
    let g = ["-c", "user.name=t", "-c", "user.email=t@t"];
    git(&dir, &["init", "-q", "-b", "master"]);
    git(&dir, &[&g[..], &["commit", "-q", "--allow-empty", "-m", "base"]].concat());
    git(&dir, &["checkout", "-q", "-b", "ia/x-1"]);
    git(&dir, &[&g[..], &["commit", "-q", "--allow-empty", "-m", "work"]].concat());
    let fields = [("worktree_path", json!(crate::util::path_str(&dir))), ("worktree_state", json!("ready")), ("branch", json!("ia/x-1"))];
    let task = db::update_task(&s.db(), &task.id, &fields).unwrap().unwrap();
    (project, task, dir)
}

/// Review, then fix rounds or a summary: what reviewers and summaries do, as a workflow.
fn review_graph() -> Value {
    json!({
        "nodes": [
            {"id": "start", "kind": "trigger", "on": "status", "status": "in_review"},
            {"id": "changed", "kind": "condition", "check": "changed"},
            {"id": "review", "kind": "agent", "name": "Reviewer", "output": "verdict", "tab": "Review"},
            {"id": "fix", "kind": "send_to_task", "max_rounds": 1},
            {"id": "summary", "kind": "agent", "name": "Summary", "output": "text", "tab": "Summary", "prompt": "Summarise {{task.key}}."}
        ],
        "edges": [
            {"from": "start", "port": "out", "to": "changed"},
            {"from": "changed", "port": "yes", "to": "review"},
            {"from": "review", "port": "issues", "to": "fix"},
            {"from": "review", "port": "pass", "to": "summary"}
        ]
    })
}

fn make(s: &Shared, project: &db::Project, graph: Value) -> Workflow {
    let mut b = Map::new();
    b.insert("name".into(), json!("Review"));
    b.insert("graph".into(), graph);
    create(s, &project.id, &b).unwrap()
}

fn thread_of(s: &Shared, run_id: &str, node: &str) -> db::Task {
    let run = get_run(&s.db(), run_id).unwrap().unwrap();
    let id = run.node(node).thread_id.unwrap_or_else(|| panic!("{node} has no thread: {:?}", run.nodes));
    db::get_task(&s.db(), &id).unwrap().unwrap()
}

/// Ends the agent step's thread run as `outcome`, and moves the run on (here, rather than in the background, so the
/// next steps' agents, which fail to start in tests, don't end first).
async fn end(s: &Shared, run_id: &str, node: &str, outcome: Outcome) {
    let thread = thread_of(s, run_id, node);
    let run = db::latest_run(&s.db(), &thread.id, None).unwrap().unwrap();
    s.runs.lock().unwrap().remove(&thread.id);
    let id = engine::step_ended(s, &thread, &run, &outcome, None).expect("the step's run");
    engine::advance(s, &id).await;
}

fn last_user_text(s: &Shared, task_id: &str) -> String {
    let msgs = db::list_messages(&s.db(), task_id).unwrap();
    msgs.iter().rev().find(|m| m.kind == "user").map(|m| m.data["text"].as_str().unwrap_or_default().to_string()).unwrap_or_default()
}

#[test]
fn a_graph_needs_one_trigger_real_ports_and_no_loops() {
    let s = crate::testing::state();
    let (project, _, dir) = setup(&s);
    let c = s.db();
    assert!(check_graph(&c, &project, &review_graph()).is_ok());
    let bad = |g: Value, what: &str| {
        let e = check_graph(&c, &project, &g).map(|_| ()).unwrap_err().1;
        assert!(e.contains(what), "{e}");
    };
    bad(json!({"nodes": [], "edges": []}), "exactly one trigger");
    bad(json!({"nodes": [{"id": "a", "kind": "trigger", "on": "status"}], "edges": []}), "needs the column");
    let two = json!({"nodes": [{"id": "a", "kind": "trigger", "on": "manual"}, {"id": "b", "kind": "set_status", "status": "todo"}], "edges": [{"from": "a", "port": "yes", "to": "b"}]});
    bad(two, "has no port yes");
    let into_trigger = json!({"nodes": [{"id": "a", "kind": "trigger", "on": "manual"}, {"id": "b", "kind": "set_status", "status": "todo"}], "edges": [{"from": "b", "port": "out", "to": "a"}]});
    bad(into_trigger, "into the trigger");
    let looped = json!({
        "nodes": [{"id": "a", "kind": "trigger", "on": "manual"}, {"id": "b", "kind": "set_status", "status": "todo"}, {"id": "c", "kind": "set_status", "status": "backlog"}],
        "edges": [{"from": "a", "port": "out", "to": "b"}, {"from": "b", "port": "out", "to": "c"}, {"from": "c", "port": "out", "to": "b"}]
    });
    bad(looped, "loop through b");
    bad(json!({"nodes": [{"id": "a", "kind": "trigger", "on": "manual"}, {"id": "b", "kind": "set_status", "status": "done"}], "edges": []}), "needs a column");
    bad(json!({"nodes": [{"id": "a", "kind": "trigger", "on": "manual"}, {"id": "b", "kind": "agent", "name": " "}], "edges": []}), "needs a name");
    bad(json!({"nodes": [{"id": "a", "kind": "trigger", "on": "manual"}, {"id": "b", "kind": "agent", "name": "R", "claude_config_id": "nope"}], "edges": []}), "agent configs");
    bad(json!({"nodes": [{"id": "a", "kind": "trigger", "on": "manual"}, {"id": "a", "kind": "set_status", "status": "todo"}], "edges": []}), "two nodes");
    // Blank settings are dropped, and a manual trigger keeps no column.
    let g = check_graph(&c, &project, &json!({"nodes": [{"id": "a", "kind": "trigger", "on": "manual", "status": "todo"}, {"id": "b", "kind": "agent", "name": " R ", "model": " ", "skills": ["/tldr", ""]}], "edges": []})).unwrap();
    assert_eq!(g.nodes[0].kind, NodeKind::Trigger { on: TriggerOn::Manual, status: None });
    match &g.nodes[1].kind {
        NodeKind::Agent { name, model, skills, .. } => assert_eq!((name.as_str(), model.clone(), skills.clone()), ("R", None, vec!["tldr".to_string()])),
        k => panic!("{k:?}"),
    }
    drop(c);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_node_runs_when_its_inputs_are_taken_and_is_skipped_otherwise() {
    let g: Graph = serde_json::from_value(json!({
        "nodes": [
            {"id": "t", "kind": "trigger", "on": "manual"},
            {"id": "a", "kind": "agent", "name": "A", "output": "verdict"},
            {"id": "b", "kind": "agent", "name": "B", "output": "verdict"},
            {"id": "any", "kind": "send_to_task"},
            {"id": "all", "kind": "agent", "name": "Summary", "join": "all"},
            {"id": "after", "kind": "set_status", "status": "todo"}
        ],
        "edges": [
            {"from": "t", "port": "out", "to": "a"}, {"from": "t", "port": "out", "to": "b"},
            {"from": "a", "port": "issues", "to": "any"}, {"from": "b", "port": "issues", "to": "any"},
            {"from": "a", "port": "pass", "to": "all"}, {"from": "b", "port": "pass", "to": "all"},
            {"from": "all", "port": "done", "to": "after"}
        ]
    }))
    .unwrap();
    let mut run = Run {
        id: "r".into(),
        workflow_id: "w".into(),
        task_id: "t".into(),
        source: "manual".into(),
        state: "running".into(),
        head: None,
        task_run: None,
        nodes: BTreeMap::from([("t".to_string(), NodeRun { state: "done".into(), port: Some("out".into()), ..Default::default() })]),
        graph: g,
        rounds: BTreeMap::new(),
        detail: None,
        created_at: now(),
        updated_at: now(),
        finished_at: None,
    };
    let mut ready = plan(&mut run);
    ready.sort();
    assert_eq!(ready, ["a", "b"]);
    assert!(plan(&mut run).is_empty(), "nothing more until they finish");
    let end = |run: &mut Run, id: &str, port: &str| {
        let r = run.nodes.get_mut(id).unwrap();
        r.state = "done".into();
        r.port = Some(port.into());
    };
    end(&mut run, "a", "pass");
    assert!(plan(&mut run).is_empty(), "both wait for b");
    end(&mut run, "b", "issues");
    // One reviewer found issues: they're sent, and the summary (after both pass) and what follows it are skipped.
    assert_eq!(plan(&mut run), ["any"]);
    assert_eq!((run.node("all").state.as_str(), run.node("after").state.as_str()), ("skipped", "skipped"));
}

#[test]
fn templates_take_the_task_and_earlier_steps() {
    let s = crate::testing::state();
    let (_, task, dir) = setup(&s);
    let mut run = Run {
        id: "r".into(),
        workflow_id: "w".into(),
        task_id: task.id.clone(),
        source: "manual".into(),
        state: "running".into(),
        head: Some("abc".into()),
        task_run: None,
        graph: serde_json::from_value(review_graph()).unwrap(),
        nodes: BTreeMap::new(),
        rounds: BTreeMap::new(),
        detail: None,
        created_at: now(),
        updated_at: now(),
        finished_at: None,
    };
    run.nodes.insert("review".into(), NodeRun { state: "done".into(), port: Some("issues".into()), text: Some("Nearly.".into()), issues: vec!["a bug".into(), "another".into()], ..Default::default() });
    let out = prompt::render("{{task.key}} {{ task.title }} on {{branch}} at {{commit}}: {{review.text}}\n{{issues}} {{nope}} {{unclosed", &task, "X-1", "W", &run);
    assert_eq!(out, "X-1 Fix the thing on ia/x-1 at abc: Nearly.\n1. a bug\n\n2. another {{nope}} {{unclosed");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_review_workflow_sends_its_issues_then_summarises_once_it_passes() {
    crate::testing::run(async || {
        crate::agent::runs::TEST_CAN_RUN.set(true);
        let s = crate::testing::state();
        let (project, task, dir) = setup(&s);
        let w = make(&s, &project, review_graph());

        // Round 1: the review finds an issue, which goes to the task's agent.
        let run = start(&s, &w.id, &task.id, false).await.map_err(|e| e.1).unwrap().expect("it runs");
        assert_eq!(run.node("changed").port.as_deref(), Some("yes"));
        assert_eq!(run.node("review").state, "running");
        let reviewer = thread_of(&s, &run.id, "review");
        assert!(is_workflow(&reviewer) && reviewer.parent_id.as_deref() == Some(task.id.as_str()));
        let asked = last_user_text(&s, &reviewer.id);
        assert!(asked.contains("You are \"Reviewer\", a step of the workflow \"Review\", for task X-1") && asked.contains("call `submit_review` once"), "{asked}");
        let r = db::latest_run(&s.db(), &reviewer.id, None).unwrap().unwrap();
        submit(&s, &reviewer, &r, &json!({"verdict": "needs_fixes", "summary": "One bug.", "serious_issues": ["the bug"]})).unwrap();
        end(&s, &run.id, "review", Outcome::Ok).await;
        let done = get_run(&s.db(), &run.id).unwrap().unwrap();
        assert_eq!((done.state.as_str(), done.node("fix").port.as_deref(), done.node("summary").state.as_str()), ("done", Some("sent"), "skipped"));
        assert_eq!(done.rounds.get("fix"), Some(&1));
        let sent = last_user_text(&s, &task.id);
        assert!(sent.contains("The workflow \"Review\" found a serious issue") && sent.contains("1. the bug"), "{sent}");

        // The agent's run (which the send started) ends: round 2 finds the issue again, and with no rounds left the
        // task is left for the user.
        // (Its run fails to start in tests: let that end first.)
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let fix_run = db::latest_run(&s.db(), &task.id, None).unwrap().unwrap();
        s.runs.lock().unwrap().remove(&task.id);
        db::update_task(&s.db(), &task.id, &[("running", json!(false)), ("status", json!("in_review"))]).unwrap();
        let _ = fix_run;
        let run = start(&s, &w.id, &task.id, false).await.map_err(|e| e.1).unwrap().expect("the agent worked since, so it changed");
        let reviewer2 = thread_of(&s, &run.id, "review");
        assert_eq!(reviewer2.id, reviewer.id, "the step keeps its thread");
        assert!(last_user_text(&s, &reviewer.id).contains("Check that they're fixed:\n\n- the bug"));
        let r = db::latest_run(&s.db(), &reviewer.id, None).unwrap().unwrap();
        submit(&s, &reviewer, &r, &json!({"verdict": "needs_fixes", "serious_issues": ["the bug"]})).unwrap();
        end(&s, &run.id, "review", Outcome::Ok).await;
        let done = get_run(&s.db(), &run.id).unwrap().unwrap();
        assert_eq!(done.node("fix").port.as_deref(), Some("exhausted"));
        let t = db::get_task(&s.db(), &task.id).unwrap().unwrap();
        assert_eq!(t.status, "needs_attention");
        assert!(t.attention_reason.unwrap_or_default().contains("after a round of fixes"));

        // Run by hand, with fresh rounds: it passes, and the summary is written.
        db::update_task(&s.db(), &task.id, &[("status", json!("in_review"))]).unwrap();
        let run = start(&s, &w.id, &task.id, true).await.map_err(|e| e.1).unwrap().unwrap();
        assert!(run.rounds.is_empty());
        let r = db::latest_run(&s.db(), &reviewer.id, None).unwrap().unwrap();
        submit(&s, &reviewer, &r, &json!({"verdict": "pass", "summary": "Good."})).unwrap();
        end(&s, &run.id, "review", Outcome::Ok).await;
        let summarizer = thread_of(&s, &run.id, "summary");
        let asked = last_user_text(&s, &summarizer.id);
        assert!(asked.contains("Summarise X-1.") && asked.contains("The step \"Reviewer\" before you said:\n\n> Good.") && !asked.contains("submit_review"), "{asked}");
        // A text step can't submit a verdict.
        let r = db::latest_run(&s.db(), &summarizer.id, None).unwrap().unwrap();
        assert!(submit(&s, &summarizer, &r, &json!({"verdict": "pass"})).is_err());
        s.add_message(&summarizer.id, "claude", json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "It fixes the thing."}]}})).unwrap();
        end(&s, &run.id, "summary", Outcome::Ok).await;
        let done = get_run(&s.db(), &run.id).unwrap().unwrap();
        assert_eq!(done.state, "done");
        assert_eq!(done.node("summary").text.as_deref(), Some("It fixes the thing."));
        assert_eq!(done.node("review").text.as_deref(), Some("Good."));

        // Nothing changed since: entering In review again doesn't review it again.
        let run = start(&s, &w.id, &task.id, false).await.map_err(|e| e.1).unwrap().unwrap();
        assert_eq!((run.state.as_str(), run.node("changed").port.as_deref(), run.node("review").state.as_str()), ("done", Some("no"), "skipped"));
        crate::agent::runs::TEST_CAN_RUN.set(false);
        std::fs::remove_dir_all(&dir).unwrap();
    })
}

#[test]
fn the_agent_working_again_stops_the_run_and_its_steps() {
    crate::testing::run(async || {
        crate::agent::runs::TEST_CAN_RUN.set(true);
        let s = crate::testing::state();
        let (project, task, dir) = setup(&s);
        let w = make(&s, &project, review_graph());
        let run = start(&s, &w.id, &task.id, false).await.map_err(|e| e.1).unwrap().unwrap();
        let reviewer = thread_of(&s, &run.id, "review");
        assert!(s.is_running(&reviewer.id));
        supersede(&s, &task);
        let stopped = get_run(&s.db(), &run.id).unwrap().unwrap();
        assert_eq!((stopped.state.as_str(), stopped.node("review").state.as_str(), stopped.node("fix").state.as_str()), ("stopped", "stopped", "skipped"));
        // Its late verdict and end don't count.
        let r = db::latest_run(&s.db(), &reviewer.id, None).unwrap().unwrap();
        assert!(submit(&s, &reviewer, &r, &json!({"verdict": "pass"})).is_err());
        finished(&s, &reviewer, &r, &Outcome::Cancelled, None);
        assert_eq!(get_run(&s.db(), &run.id).unwrap().unwrap().node("review").state, "stopped");
        // A stopped run doesn't count as one that finished: the next one reviews.
        s.runs.lock().unwrap().remove(&reviewer.id);
        let again = start(&s, &w.id, &task.id, false).await.map_err(|e| e.1).unwrap().unwrap();
        assert_eq!(again.node("changed").port.as_deref(), Some("yes"));
        assert!(stop(&s, &task.id));
        assert!(!stop(&s, &task.id));
        crate::agent::runs::TEST_CAN_RUN.set(false);
        std::fs::remove_dir_all(&dir).unwrap();
    })
}

#[test]
fn a_workflow_starts_when_its_task_enters_its_column_and_not_when_it_moves_it_there() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (project, task, dir) = setup(&s);
        // Entering In review moves the task to Ready for merge, which a second workflow picks up.
        let first = make(
            &s,
            &project,
            json!({
                "nodes": [{"id": "t", "kind": "trigger", "on": "status", "status": "in_review"}, {"id": "m", "kind": "set_status", "status": "todo"}],
                "edges": [{"from": "t", "port": "out", "to": "m"}]
            }),
        );
        let second = make(
            &s,
            &project,
            json!({
                "nodes": [{"id": "t", "kind": "trigger", "on": "status", "status": "todo"}, {"id": "m", "kind": "set_status", "status": "backlog"}],
                "edges": [{"from": "t", "port": "out", "to": "m"}]
            }),
        );
        // Off: it doesn't start by itself.
        let mut off = Map::new();
        off.insert("enabled".into(), json!(false));
        update(&s, &second.id, &off).unwrap();
        on_status(&s, &task);
        for _ in 0..200 {
            if db::get_task(&s.db(), &task.id).unwrap().unwrap().status == "todo" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let t = db::get_task(&s.db(), &task.id).unwrap().unwrap();
        assert_eq!(t.status, "todo");
        assert_eq!(latest_run(&s.db(), &first.id, &task.id).unwrap().unwrap().state, "done");
        assert!(latest_run(&s.db(), &second.id, &task.id).unwrap().is_none());
        // Moving it back into In review by hand starts the first again, but not when the first moves it there itself.
        let mut b = Map::new();
        b.insert("status".into(), json!("in_review"));
        crate::api::update_task_inner(&s, &task.id, &b).await.map_err(|e| e.1).unwrap();
        for _ in 0..200 {
            if db::get_task(&s.db(), &task.id).unwrap().unwrap().status == "todo" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(db::get_task(&s.db(), &task.id).unwrap().unwrap().status, "todo");
        let back = make(
            &s,
            &project,
            json!({
                "nodes": [{"id": "t", "kind": "trigger", "on": "manual"}, {"id": "m", "kind": "set_status", "status": "in_review"}],
                "edges": [{"from": "t", "port": "out", "to": "m"}]
            }),
        );
        let _ = back;
        // Deleting a workflow takes its runs with it.
        delete(&s, &first.id).unwrap();
        assert!(latest_run(&s.db(), &first.id, &task.id).unwrap().is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    })
}

#[test]
fn a_set_status_step_doesnt_start_its_own_workflow_again() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (project, task, dir) = setup(&s);
        db::update_task(&s.db(), &task.id, &[("status", json!("todo"))]).unwrap();
        // It moves the task into the column that triggers it: once, not over and over.
        let w = make(
            &s,
            &project,
            json!({
                "nodes": [{"id": "t", "kind": "trigger", "on": "status", "status": "in_review"}, {"id": "m", "kind": "set_status", "status": "in_review"}],
                "edges": [{"from": "t", "port": "out", "to": "m"}]
            }),
        );
        let run = start(&s, &w.id, &task.id, true).await.map_err(|e| e.1).unwrap().unwrap();
        assert_eq!(run.state, "done");
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let n: i64 = s.db().query_row("SELECT COUNT(*) FROM workflow_runs WHERE workflow_id=?1", [&w.id], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        std::fs::remove_dir_all(&dir).unwrap();
    })
}
