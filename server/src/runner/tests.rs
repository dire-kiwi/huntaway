use super::*;

#[test]
fn caches_are_writable_before_their_first_use() {
    let home = crate::testing::temp_dir();
    // A bare home directory: no `~/.cargo` (a system Cargo) or `~/.local/share` yet.
    let found = cache_dirs_in(&home, |_| None);
    assert_eq!(found, [".cache", ".npm", ".cargo/registry", ".cargo/git", ".local/share/pnpm"].map(|d| path_str(&home.join(d))));
    assert!(found.iter().all(|d| std::path::Path::new(d).is_dir()));
    // Where the environment moves them.
    let env = |k: &str| match k {
        "XDG_CACHE_HOME" => Some(path_str(&home.join("xdg/cache"))),
        "XDG_DATA_HOME" => Some(path_str(&home.join("xdg/data"))),
        "CARGO_HOME" => Some(path_str(&home.join("cargo"))),
        _ => Some(String::new()),
    };
    let found = cache_dirs_in(&home, env);
    assert_eq!(found, ["xdg/cache", ".npm", "cargo/registry", "cargo/git", "xdg/data/pnpm"].map(|d| path_str(&home.join(d))));
    assert!(found.iter().all(|d| std::path::Path::new(d).is_dir()));
    std::fs::remove_dir_all(&home).unwrap();
}

#[test]
fn many_long_ignored_directories_dont_block_the_launch() {
    crate::testing::run(async || {
        let dir = crate::testing::temp_dir();
        // More than check-ignore's input and output pipes hold together (64 KiB each): 200
        // paths of ~730 bytes.
        let long = "x".repeat(240);
        let mut expected = Vec::new();
        for i in 0..10 {
            for j in 0..20 {
                let parent = dir.join(format!("{i}{long}/{j}{long}"));
                std::fs::create_dir_all(&parent).unwrap();
                std::fs::write(parent.join("tracked"), "1").unwrap();
                let d = parent.join(format!("{long}.ign"));
                std::fs::create_dir_all(&d).unwrap();
                std::fs::write(d.join("f"), "1").unwrap();
                expected.push(path_str(&d));
            }
        }
        std::fs::write(dir.join(".gitignore"), "*.ign\n").unwrap();
        let git = |args: &[&str]| assert!(std::process::Command::new("git").args(args).current_dir(&dir).output().unwrap().status.success());
        git(&["init", "-q", "."]);
        git(&["add", "."]);
        let mut found = ignored_dirs(&path_str(&dir)).await;
        found.sort();
        expected.sort();
        let base = path_str(&dir).len();
        assert!(expected.iter().map(|p| p.len() - base).sum::<usize>() > 140 * 1024);
        assert_eq!(found, expected);
        std::fs::remove_dir_all(&dir).unwrap();
    })
}

#[test]
fn a_reviewers_work_stays_read_only_inside_a_cache() {
    let write = vec!["/home/me/.cache".to_string(), "/home/me/.cache/w/target".to_string()];
    let fs = review_filesystem(write, vec!["/home/me/.cache/w".into(), "/home/me/.cache/repo/.git".into()]);
    let fs: Vec<(&str, &str)> = fs.iter().map(|(p, a)| (p.as_str(), a.as_str())).collect();
    assert_eq!(
        fs,
        [("/home/me/.cache", "write"), ("/home/me/.cache/repo/.git", "read"), ("/home/me/.cache/w", "read"), ("/home/me/.cache/w/target", "write")]
    );
}

#[test]
fn a_reviewer_may_write_the_directories_git_ignores_whole() {
    crate::testing::run(async || {
        let dir = crate::testing::temp_dir();
        for d in ["target/debug", "app/node_modules/x", "build", ".claude", "src"] {
            std::fs::create_dir_all(dir.join(d)).unwrap();
        }
        std::fs::write(dir.join(".gitignore"), "target\nnode_modules\nbuild\n.claude\n.env\n").unwrap();
        for f in ["build/tracked", "build/untracked", ".env", "src/a.rs", "app/node_modules/x/i", ".claude/settings.local.json"] {
            std::fs::write(dir.join(f), "1").unwrap();
        }
        let git = |args: &[&str]| assert!(std::process::Command::new("git").args(args).current_dir(&dir).output().unwrap().status.success());
        git(&["init", "-q", "."]);
        git(&["add", ".gitignore", "src"]);
        git(&["add", "-f", "build/tracked"]);
        let mut found = ignored_dirs(&path_str(&dir)).await;
        found.sort();
        // Not `build`, which holds a tracked file, nor the agents' settings.
        assert_eq!(found, vec![path_str(&dir.join("app/node_modules")), path_str(&dir.join("target"))]);
        assert_eq!(ignored_dirs(&path_str(&crate::testing::temp_dir().join("no-such-dir"))).await, Vec::<String>::new());
        std::fs::remove_dir_all(&dir).unwrap();
    })
}

#[test]
fn only_merging_tasks_merge_without_asking() {
    let c = db::open(std::path::Path::new(":memory:")).unwrap();
    let p = db::insert_profile(&c, "p", &[], None).unwrap();
    let np = db::NewProject { id: "pr", profile_id: &p.id, name: "x", key: "X", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
    db::insert_project(&c, np).unwrap();
    let t = db::NewTask { profile_id: &p.id, project_id: Some("pr"), kind: "task", title: "t", description: "", status: "in_review", use_worktree: false, model: None, effort: None, claude_config_id: None };
    let task = db::insert_task(&c, t).unwrap();
    assert_eq!(gh_allowed(&task), crate::gh_mcp::READ_ONLY);
    let merging = Task { merging: true, status: "ready_for_merge".into(), ..task.clone() };
    assert_eq!(gh_allowed(&merging), [crate::gh_mcp::READ_ONLY, &["pr_merge"]].concat());
    // Still merging while it waits on the user, so their reply's run can merge too.
    assert!(gh_allowed(&Task { status: "needs_attention".into(), ..merging.clone() }).contains(&"pr_merge"));
    assert!(!gh_allowed(&Task { kind: "review".into(), ..merging }).contains(&"pr_merge"));
}

#[test]
fn a_message_queued_during_a_run_waits_for_new_dependencies() {
    let c = db::open(std::path::Path::new(":memory:")).unwrap();
    let p = db::insert_profile(&c, "p", &[], None).unwrap();
    let np = db::NewProject { id: "pr", profile_id: &p.id, name: "x", key: "X", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
    db::insert_project(&c, np).unwrap();
    let task = |title: &str| {
        let t = db::NewTask { profile_id: &p.id, project_id: Some("pr"), kind: "task", title, description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
        db::insert_task(&c, t).unwrap()
    };
    let (a, b) = (task("a"), task("b"));
    let id = crate::state::Identity { host_id: "h".into(), host_name: "h".into(), token: String::new(), hub_token: String::new(), internal_url: String::new() };
    let meta = crate::admin::ServerMeta { boot_id: String::new(), started_at: String::new(), source_dir: None, running_commit: None, update_from: None, release: None, args: vec![] };
    let dir = crate::testing::TempDir::new();
    let state: Shared = crate::state::AppState::new(c, dir.to_path_buf(), id, meta);
    let _ = state.test_dir.set(dir);
    runs::TEST_CAN_RUN.set(true);

    // B's agent is running; it gets a dependency on A and a message is queued meanwhile.
    let run = db::insert_run(&state.db(), &b.id, "prompt").unwrap();
    state.runs.lock().unwrap().insert(b.id.clone(), RunHandle { run_id: run.id.clone(), cancel: None });
    state.update_task(&b.id, &[("running", json!(true)), ("status", json!("in_progress")), ("depends_on", json!([a.id]))]).unwrap();
    send(&state, &b.id, "and then this").unwrap();
    finish(&state, &run.id, Outcome::Ok);

    let b = db::get_task(&state.db(), &b.id).unwrap().unwrap();
    assert!(!state.is_running(&b.id));
    assert_eq!((b.running, b.waiting, b.status.as_str()), (false, true, "in_progress"));
    assert_eq!(b.queued_message.as_deref(), Some("and then this"));
    runs::TEST_CAN_RUN.set(false);
}

#[test]
fn an_effort_a_codex_model_doesnt_take_gives_way_to_its_default() {
    let model = |id: &str, default: bool, efforts: &[&str], effort: Option<&str>| crate::codex::Model {
        id: id.into(),
        name: id.into(),
        is_default: default,
        efforts: efforts.iter().map(|e| e.to_string()).collect(),
        default_effort: effort.map(String::from),
    };
    let models = [model("gpt-5.5", true, &["low", "medium", "high", "xhigh"], Some("medium")), model("gpt-6", false, &["low", "max"], None), model("odd", false, &[], None)];
    let e = |effort: &str, m: Option<&str>| codex_effort(Some(effort.into()), m, &models);
    assert_eq!(e("max", Some("gpt-5.5")).as_deref(), Some("medium"));
    assert_eq!(e("high", Some("gpt-5.5")).as_deref(), Some("high"));
    // No model: the default one's.
    assert_eq!(e("max", None).as_deref(), Some("medium"));
    assert_eq!(e("max", Some("gpt-6")).as_deref(), Some("max"));
    assert_eq!(e("high", Some("gpt-6")), None, "no default of its own: Codex picks");
    // A model it doesn't know, or one that doesn't list its efforts, keeps it.
    assert_eq!(e("max", Some("gpt-7")).as_deref(), Some("max"));
    assert_eq!(e("max", Some("odd")).as_deref(), Some("max"));
    assert_eq!(codex_effort(None, Some("gpt-5.5"), &models), None);

    // A run checks the model it runs with, its own or inherited, with the config's models (as Codex lists them).
    let listed = models.to_vec();
    crate::testing::run(async move || {
        let home = format!("/tmp/ia-codex-{}", crate::util::new_id());
        crate::codex::set_test_models(&home, listed.clone());
        let c = crate::testing::state();
        let cfg = db::insert_claude_config(&c.db(), "Codex", &home, "codex").unwrap();
        assert_eq!(codex_run_effort(&cfg, Some("gpt-5.5"), Some("max".into())).await.as_deref(), Some("medium"));
        assert_eq!(codex_run_effort(&cfg, Some("gpt-6"), Some("max".into())).await.as_deref(), Some("max"));
        assert_eq!(codex_run_effort(&cfg, None, Some("max".into())).await.as_deref(), Some("medium"));
        assert_eq!(codex_run_effort(&cfg, Some("gpt-5.5"), None).await, None);
    })
}

/// A task whose agent is running a run that takes input (or not), with no process behind it.
fn running(input: bool) -> (Shared, Task, Run) {
    let state = crate::testing::state();
    let p = db::insert_profile(&state.db(), "p", &[], None).unwrap();
    let t = db::NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "t", description: "", status: "in_progress", use_worktree: false, model: None, effort: None, claude_config_id: None };
    let task = db::insert_task(&state.db(), t).unwrap();
    let run = db::insert_run(&state.db(), &task.id, "prompt").unwrap();
    state.db().execute("UPDATE runs SET status='running' WHERE id=?1", [&run.id]).unwrap();
    let dir = runs::run_dir(&state, &run.id);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("out.jsonl"), "").unwrap();
    if input {
        std::fs::write(dir.join("input.jsonl"), "").unwrap();
    }
    state.runs.lock().unwrap().insert(task.id.clone(), RunHandle { run_id: run.id.clone(), cancel: None });
    let task = state.update_task(&task.id, &[("running", json!(true))]).unwrap().unwrap();
    (state, task, run)
}

/// The agent writes `lines` to its output.
fn output(state: &Shared, run: &Run, lines: &[Value]) {
    let offset = db::get_run(&state.db(), &run.id).unwrap().unwrap().out_offset as u64;
    let data: String = lines.iter().map(|l| format!("{l}\n")).collect();
    on_output(state, &run.id, offset, &data);
}

/// What the agent has been sent after its prompt.
fn input(state: &Shared, run: &Run) -> Vec<Value> {
    let text = std::fs::read_to_string(runs::run_dir(state, &run.id).join("input.jsonl")).unwrap();
    text.lines().map(|l| serde_json::from_str(l).unwrap()).collect()
}

fn input_closed(state: &Shared, run: &Run) -> bool {
    runs::run_dir(state, &run.id).join("input.closed").exists()
}

fn reload(state: &Shared, id: &str) -> Task {
    db::get_task(&state.db(), id).unwrap().unwrap()
}

fn user_messages(state: &Shared, id: &str) -> Vec<Value> {
    db::list_messages(&state.db(), id).unwrap().into_iter().filter(|m| m.kind == "user").map(|m| m.data).collect()
}

fn replay(id: &str, text: &str) -> Value {
    json!({"type": "user", "isReplay": true, "uuid": id, "message": {"role": "user", "content": text}})
}

fn result(subtype: &str, total_cost: f64) -> Value {
    json!({"type": "result", "subtype": subtype, "is_error": subtype != "success", "total_cost_usd": total_cost, "num_turns": 1})
}

#[test]
fn a_merge_that_needs_changes_lets_the_queue_go_and_rejoins_it() {
    crate::testing::run(async || {
        let (state, a, run) = running(false);
        let a = state.update_task(&a.id, &[("status", json!("ready_for_merge")), ("merging", json!(true))]).unwrap().unwrap();
        let nt = db::NewTask { profile_id: &a.profile_id, project_id: None, kind: "task", title: "b", description: "", status: "ready_for_merge", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let b = db::insert_task(&state.db(), nt).unwrap();
        let b = state.update_task(&b.id, &[("merging", json!(true)), ("position", json!(a.position + 1.0))]).unwrap().unwrap();
        let slot = |state: &Shared| db::active_merge(&state.db(), None, None).unwrap().map(|t| t.id);
        let queue = |state: &Shared| db::queued_merges(&state.db(), None, None).unwrap().into_iter().map(|t| t.id).collect::<Vec<_>>();
        assert_eq!((slot(&state), queue(&state)), (Some(a.id.clone()), vec![b.id.clone()]));
        let update = async |state: &Shared, id: &str, body: Value| crate::api::update_task_inner(state, id, body.as_object().unwrap()).await;

        // Only a merging task steps out, into In progress.
        assert!(update(&state, &a.id, json!({"status": "in_review", "remerge": true})).await.is_err());
        assert!(update(&state, &a.id, json!({"status": "in_progress", "remerge": "yes"})).await.is_err());
        let t = update(&state, &a.id, json!({"status": "in_progress", "remerge": true})).await.unwrap();
        assert_eq!((t.status.as_str(), t.merging, t.remerge, t.running), ("in_progress", false, true, true));
        assert!(update(&state, &b.id, json!({"status": "in_progress", "remerge": true})).await.is_err());
        // B can merge while A makes its changes.
        assert_eq!((slot(&state), queue(&state)), (None, vec![b.id.clone()]));
        // Waiting on the user keeps its place to come back to.
        let t = update(&state, &a.id, json!({"status": "needs_attention"})).await.unwrap();
        assert!(t.remerge);
        assert_eq!(slot(&state), None);
        update(&state, &a.id, json!({"status": "in_progress"})).await.unwrap();

        // Done, it rejoins the end of the queue, rather than going to In review.
        finish(&state, &run.id, Outcome::Ok);
        let t = reload(&state, &a.id);
        assert_eq!((t.status.as_str(), t.merging, t.remerge, t.running), ("ready_for_merge", true, false, false));
        assert!(t.position > b.position);
        assert_eq!((slot(&state), queue(&state)), (None, vec![b.id.clone(), a.id.clone()]));

        // Moved to another column meanwhile, it's out of the queue for good.
        let (state, c, run) = running(false);
        state.update_task(&c.id, &[("status", json!("ready_for_merge")), ("merging", json!(true))]).unwrap();
        update(&state, &c.id, json!({"status": "in_progress", "remerge": true})).await.unwrap();
        let t = update(&state, &c.id, json!({"status": "todo"})).await.unwrap();
        assert_eq!((t.merging, t.remerge), (false, false));
        update(&state, &c.id, json!({"status": "in_progress"})).await.unwrap();
        finish(&state, &run.id, Outcome::Ok);
        assert_eq!(reload(&state, &c.id).status, "in_review");

        // A run that fails leaves it for the user, still to rejoin once its agent is done.
        let (state, d, run) = running(false);
        state.update_task(&d.id, &[("status", json!("ready_for_merge")), ("merging", json!(true))]).unwrap();
        update(&state, &d.id, json!({"status": "in_progress", "remerge": true})).await.unwrap();
        finish(&state, &run.id, Outcome::Failed("boom".into()));
        let t = reload(&state, &d.id);
        assert_eq!((t.status.as_str(), t.merging, t.remerge), ("needs_attention", false, true));
        // Moved on by the board rather than the user (a review starting puts it in In review),
        // it drops its place all the same: work after that goes to review, not to the queue.
        state.update_task(&d.id, &[("status", json!("in_review")), ("attention_reason", Value::Null)]).unwrap();
        assert!(!reload(&state, &d.id).remerge);
        update(&state, &d.id, json!({"status": "in_progress"})).await.unwrap();
        let next = db::insert_run(&state.db(), &d.id, "prompt").unwrap();
        state.runs.lock().unwrap().insert(d.id.clone(), RunHandle { run_id: next.id.clone(), cancel: None });
        state.update_task(&d.id, &[("running", json!(true))]).unwrap();
        finish(&state, &next.id, Outcome::Ok);
        let t = reload(&state, &d.id);
        assert_eq!((t.status.as_str(), t.merging, t.remerge), ("in_review", false, false));
    })
}

#[test]
fn steers_a_message_into_the_running_turn() {
    crate::testing::run(async || {
        let (state, task, run) = running(true);
        let t = send(&state, &task.id, "  also do this  ").unwrap();
        assert_eq!(t.queued_message, None);
        assert_eq!(t.steering.len(), 1);
        let steer = t.steering[0].clone();
        assert!(steer.written);
        assert_eq!(input(&state, &run), vec![json!({"type": "user", "uuid": steer.id, "message": {"role": "user", "content": "also do this"}})]);
        // Nothing in the thread until the agent takes it in.
        assert!(user_messages(&state, &task.id).is_empty());

        output(&state, &run, &[replay("the prompt's id", "the prompt"), replay(&steer.id, "also do this")]);
        assert_eq!(user_messages(&state, &task.id), vec![json!({"text": "also do this", "steered": true})]);
        assert!(task_steering_is_empty(&state, &task.id));
        assert!(!input_closed(&state, &run));

        // Nothing left waiting, so the turn's end ends the run.
        output(&state, &run, &[result("success", 0.5)]);
        assert!(input_closed(&state, &run));
        // A message sent now can't reach this run any more: it waits for the next.
        let t = send(&state, &task.id, "too late").unwrap();
        assert_eq!(t.queued_message.as_deref(), Some("too late"));
        assert!(t.steering.is_empty());
    });
}

#[test]
fn plan_labels_the_task_and_tells_its_agent_how() {
    crate::testing::run(async || {
        // A run that started without labels, working in a worktree, may not be let write the
        // task's folder (Codex's writable roots don't have it): `/plan` waits for the next run,
        // which starts with the label.
        let (state, task, run) = running(true);
        let t = send(&state, &task.id, "/plan  the cache ").unwrap();
        assert_eq!(t.labels, vec!["plan"]);
        assert!(crate::documents::dir(&state, &task.id).is_dir());
        assert_eq!((t.queued_message.as_deref(), t.steering.len()), (Some("/plan  the cache"), 0));
        assert!(input(&state, &run).is_empty());
        // An ordinary message still goes to it.
        assert_eq!(send(&state, &task.id, "and this").unwrap().steering.len(), 1);

        // One that can write it (it started with a label, say) takes it in its turn.
        let (state, task, run) = running(true);
        set_writes_documents(&run.id, true);
        let t = send(&state, &task.id, "/plan  the cache ").unwrap();
        assert_eq!(t.labels, vec!["plan"]);
        let file = crate::documents::path(&state, &t, "plan").unwrap();
        assert!(file.parent().unwrap().is_dir());
        // Its system prompt may not say how to write the plan, so the message does.
        let sent = input(&state, &run)[0]["message"]["content"].as_str().unwrap().to_string();
        assert!(sent.contains(&path_str(&file)) && sent.contains("<ol class=\"steps\">") && sent.ends_with("What to plan: the cache"), "{sent}");
        // The thread shows the command, as it was sent.
        let steer = t.steering[0].clone();
        output(&state, &run, &[replay(&steer.id, &sent)]);
        assert_eq!(user_messages(&state, &task.id), vec![json!({"text": "/plan  the cache", "steered": true})]);
        // Its labels stay as they are, and a command that only starts the same way isn't it.
        let t = state.update_task(&task.id, &[("labels", json!(["plan", "diagram"]))]).unwrap().unwrap();
        assert_eq!(send(&state, &t.id, "/plan").unwrap().labels, vec!["plan", "diagram"]);
        // Its end forgets it.
        finish(&state, &run.id, Outcome::Ok);
        assert!(!writes_documents(&run.id));
        let (state, task, run) = running(true);
        send(&state, &task.id, "/planner go").unwrap();
        assert_eq!(input(&state, &run)[0]["message"]["content"], "/planner go");
        assert!(reload(&state, &task.id).labels.is_empty());
    });
}

#[test]
fn the_end_of_a_turn_or_run_ends_a_wait() {
    crate::testing::run(async || {
        let (state, task, run) = running(true);
        let wait = |call_id: &str| {
            let w = db::AgentWait { reason: None, since: crate::util::now(), until: crate::util::now(), tasks: vec![], command: None, call_id: call_id.into(), run_id: run.id.clone(), moved_to: None, subagent_finished: None, pull_request: None };
            state.update_task(&task.id, &[("agent_wait", json!(w))]).unwrap();
        };
        // Its own thread calling another tool means it's working again; a subagent's doesn't.
        let tool_use = |parent: Value| json!({"type": "assistant", "parent_tool_use_id": parent, "message": {"content": [{"type": "tool_use", "id": "t", "name": "Bash", "input": {}}]}});
        wait("c0");
        output(&state, &run, &[tool_use(json!("toolu_sub"))]);
        assert!(reload(&state, &task.id).agent_wait.is_some());
        output(&state, &run, &[tool_use(Value::Null)]);
        assert_eq!(reload(&state, &task.id).agent_wait, None);
        // The agent gave up on the call (it was interrupted, say): the turn's end clears it.
        wait("c1");
        output(&state, &run, &[result("success", 0.1)]);
        assert_eq!(reload(&state, &task.id).agent_wait, None);
        wait("c2");
        finish(&state, &run.id, Outcome::Ok);
        let t = reload(&state, &task.id);
        assert_eq!((t.agent_wait, t.running), (None, false));
    });
}

fn task_steering_is_empty(state: &Shared, id: &str) -> bool {
    reload(state, id).steering.is_empty()
}

#[test]
fn a_message_that_misses_the_turn_starts_the_next() {
    crate::testing::run(async || {
        let (state, task, run) = running(true);
        let steer = send(&state, &task.id, "one more thing").unwrap().steering[0].clone();
        // The turn ends before the agent took it in: it starts the next turn instead.
        output(&state, &run, &[result("success", 0.1)]);
        assert!(!input_closed(&state, &run));
        output(&state, &run, &[replay(&steer.id, "one more thing"), result("success", 0.25)]);
        assert!(input_closed(&state, &run));
        assert_eq!(user_messages(&state, &task.id).len(), 1);
        // Each turn's result shows that turn's cost; the task adds them up.
        let costs: Vec<Value> = db::list_messages(&state.db(), &task.id)
            .unwrap()
            .into_iter()
            .filter(|m| m.data["type"] == "result")
            .map(|m| m.data["total_cost_usd"].clone())
            .collect();
        assert_eq!(costs.len(), 2);
        assert!((costs[1].as_f64().unwrap() - 0.15).abs() < 1e-9, "{costs:?}");
        assert!((reload(&state, &task.id).cost_usd - 0.25).abs() < 1e-9);
    });
}

#[test]
fn messages_the_agent_never_took_in_go_to_the_next_run() {
    crate::testing::run(async || {
        let (state, task, run) = running(true);
        send(&state, &task.id, "first").unwrap();
        send_from_agent(&state, &task.id, "second").unwrap();
        // Closed meanwhile (e.g. the agent exited), so this one is queued behind them.
        runs::close_input(&state, &run.id);
        send(&state, &task.id, "third").unwrap();
        {
            let _runs = state.runs.lock().unwrap();
            requeue_steers(&state, &task.id, &run.id).unwrap();
        }
        let t = reload(&state, &task.id);
        assert!(t.steering.is_empty());
        assert_eq!(t.queued_message.as_deref(), Some("first\n\nsecond\n\nthird"));
        // Not all of it came from other agents, so it counts as the user's.
        assert_eq!(db::take_queued(&state.db(), &task.id).unwrap(), Some(db::Queued { text: "first\n\nsecond\n\nthird".into(), from_agent: false, user_text: Some("first\n\nthird".into()) }));
    });
}

#[test]
fn the_users_messages_retitle_the_task() {
    crate::testing::run(async || {
        let (state, task, run) = running(true);
        crate::title::TEST_REPLY.set(Some("Deploy the fix".into()));
        send_from_agent(&state, &task.id, "from another agent").unwrap();
        crate::title::tests::settle().await;
        assert_eq!(reload(&state, &task.id).title, "t");
        assert!(crate::title::TEST_ASKED.with_borrow(Vec::is_empty));

        send(&state, &task.id, "now deploy it").unwrap();
        crate::title::tests::settle().await;
        assert_eq!(reload(&state, &task.id).title, "Deploy the fix");
        let asked = crate::title::TEST_ASKED.with_borrow(Vec::clone);
        // Still waiting for the agent to take it in, it counts all the same; other agents' messages don't.
        assert!(asked.len() == 1 && asked[0].contains("now deploy it") && !asked[0].contains("another agent"), "{asked:?}");

        // Queued for the next run, it counts too.
        runs::close_input(&state, &run.id);
        crate::title::TEST_REPLY.set(Some("Deploy and tag the fix".into()));
        assert_eq!(send(&state, &task.id, "and tag it").unwrap().queued_message.as_deref(), Some("and tag it"));
        crate::title::tests::settle().await;
        assert_eq!(reload(&state, &task.id).title, "Deploy and tag the fix");
        assert!(crate::title::TEST_ASKED.with_borrow(|a| a.len() == 2 && a[1].contains("and tag it")));
    });
}

#[test]
fn a_reply_the_agent_hasnt_taken_in_yet_goes_with_what_it_answers() {
    crate::testing::run(async || {
        let (state, task, run) = running(true);
        let said = |text: &str| json!({"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}});
        output(&state, &run, &[said("A: add a search cache; B: replace the database index")]);
        crate::title::TEST_REPLY.set(Some("Replace the database index".into()));
        let t = send(&state, &task.id, "Use option B").unwrap();
        assert_eq!(t.steering.len(), 1);
        crate::title::tests::settle().await;
        let asked = crate::title::TEST_ASKED.with_borrow(Vec::clone);
        assert!(asked[0].contains("<agent>A: add a search cache; B: replace the database index</agent>\nUse option B"), "{asked:?}");
        assert_eq!(reload(&state, &task.id).title, "Replace the database index");
    });
}

#[test]
fn keeps_marking_messages_from_other_agents() {
    crate::testing::run(async || {
        let (state, task, run) = running(true);
        let steer = send_from_agent(&state, &task.id, "from another agent").unwrap().steering[0].clone();
        assert!(steer.from_agent);
        output(&state, &run, &[replay(&steer.id, "from another agent")]);
        assert_eq!(user_messages(&state, &task.id), vec![json!({"text": "from another agent", "steered": true, "from_agent": true})]);
    });
}

#[test]
fn stop_interrupts_the_turn() {
    crate::testing::run(async || {
        let (state, task, run) = running(true);
        assert!(stop(&state, &task.id));
        let sent = input(&state, &run);
        assert_eq!((sent.len(), &sent[0]["type"], &sent[0]["request"]["subtype"]), (1, &json!("control_request"), &json!("interrupt")));
        assert!(!input_closed(&state, &run));
        output(&state, &run, &[result("error_during_execution", 0.0)]);
        assert!(input_closed(&state, &run));
        let r = db::get_run(&state.db(), &run.id).unwrap().unwrap();
        assert!(r.stop_requested);
        let last = db::list_messages(&state.db(), &task.id).unwrap().pop().unwrap();
        assert_eq!(last.data["interrupted"], true);
    });
}

#[test]
fn a_message_waiting_when_stopped_starts_the_next_turn() {
    crate::testing::run(async || {
        let (state, task, run) = running(true);
        let steer = send(&state, &task.id, "do this instead").unwrap().steering[0].clone();
        state.db().execute("UPDATE runs SET attention='a question' WHERE id=?1", [&run.id]).unwrap();
        stop(&state, &task.id);
        // The agent ends the interrupted turn, then starts the next with the message.
        output(&state, &run, &[result("error_during_execution", 0.0)]);
        assert!(!input_closed(&state, &run));
        output(&state, &run, &[replay(&steer.id, "do this instead")]);
        let r = db::get_run(&state.db(), &run.id).unwrap().unwrap();
        // That turn goes ahead, so the run isn't stopped any more (and the user answered).
        assert!(!r.stop_requested);
        assert_eq!(r.attention, None);
        output(&state, &run, &[result("success", 0.0)]);
        assert!(input_closed(&state, &run));
        assert_eq!(db::get_run(&state.db(), &run.id).unwrap().unwrap().result_error, None);
    });
}

#[test]
fn a_message_taken_in_before_a_stop_doesnt_undo_it() {
    crate::testing::run(async || {
        let (state, task, run) = running(true);
        let steer = send(&state, &task.id, "and this").unwrap().steering[0].clone();
        stop(&state, &task.id);
        // Taken in before the interrupt landed: the stop still ends the turn and the run.
        output(&state, &run, &[replay(&steer.id, "and this"), result("error_during_execution", 0.0)]);
        assert!(db::get_run(&state.db(), &run.id).unwrap().unwrap().stop_requested);
        assert!(input_closed(&state, &run));
    });
}

#[test]
fn an_earlier_stop_doesnt_cut_a_later_one_short() {
    crate::testing::run(async || {
        let (state, task, run) = running(true);
        let steer = send(&state, &task.id, "do this instead").unwrap().steering[0].clone();
        stop(&state, &task.id);
        // The stop ends the turn, and the waiting message starts the next.
        output(&state, &run, &[result("error_during_execution", 0.0), replay(&steer.id, "do this instead")]);
        tokio::time::sleep(STOP_GRACE / 2).await;
        // Stopped again: the first stop's time is up before this one's.
        stop(&state, &task.id);
        tokio::time::sleep(STOP_GRACE * 3 / 4).await;
        assert!(!input_closed(&state, &run));
        // This one's isn't, and its turn hasn't ended.
        tokio::time::sleep(STOP_GRACE / 2).await;
        assert!(input_closed(&state, &run));
    });
}

/// The server restarts while the run is in `state`.
fn restart(state: &Shared, task: &Task) {
    state.runs.lock().unwrap().remove(&task.id);
    load_active(state).unwrap();
}

#[test]
fn after_a_restart_messages_still_have_to_start_the_next_turn() {
    crate::testing::run(async || {
        let (state, task, run) = running(true);
        send(&state, &task.id, "one more thing").unwrap();
        // The turn ended (before the restart) and the agent never took it in.
        state.db().execute("UPDATE runs SET saw_result=1, between_turns=1 WHERE id=?1", [&run.id]).unwrap();
        restart(&state, &task);
        assert!(reload(&state, &task.id).steerable);
        tokio::time::sleep(STEER_GRACE / 2).await;
        assert!(!input_closed(&state, &run));
        tokio::time::sleep(STEER_GRACE).await;
        assert!(input_closed(&state, &run));
    });
}

#[test]
fn after_a_restart_a_turn_that_ended_with_nothing_waiting_ends_the_run() {
    crate::testing::run(async || {
        let (state, task, run) = running(true);
        // The server stopped after the turn's end was recorded, before its input was closed.
        state.db().execute("UPDATE runs SET saw_result=1, between_turns=1 WHERE id=?1", [&run.id]).unwrap();
        restart(&state, &task);
        assert!(input_closed(&state, &run));
    });
}

#[test]
fn after_a_restart_messages_the_agent_wasnt_sent_are_sent() {
    crate::testing::run(async || {
        let (state, task, run) = running(true);
        // Sent as the turn ended, and kept, before the server stopped, to be written to its input.
        let steer = db::Steer { id: "s1".into(), text: "one more thing".into(), from_agent: false, run_id: run.id.clone(), written: false };
        state.update_task(&task.id, &[("steering", json!([steer]))]).unwrap();
        state.db().execute("UPDATE runs SET saw_result=1, between_turns=1 WHERE id=?1", [&run.id]).unwrap();
        restart(&state, &task);
        assert_eq!(input(&state, &run).last().unwrap()["message"]["content"], "one more thing");
        assert!(reload(&state, &task.id).steering[0].written);
        // It starts the next turn, or the run ends and it goes to the next.
        assert!(!input_closed(&state, &run));
        tokio::time::sleep(STEER_GRACE * 3 / 2).await;
        assert!(input_closed(&state, &run));
    });
}

#[test]
fn a_turns_end_closes_the_input_even_if_it_cant_be_recorded() {
    crate::testing::run(async || {
        // The disk is full, say, as the turn's result goes in the thread, or as its cost is added up.
        for failing in ["BEFORE INSERT ON messages", "BEFORE UPDATE OF cost_usd ON tasks"] {
            let (state, _task, run) = running(true);
            state.db().execute_batch(&format!("CREATE TRIGGER full {failing} BEGIN SELECT RAISE(FAIL, 'database or disk is full'); END;")).unwrap();
            output(&state, &run, &[result("success", 0.1)]);
            assert!(input_closed(&state, &run), "{failing}");
        }
    });
}

#[test]
fn a_run_from_a_newer_build_is_stopped_rather_than_left_unfollowed() {
    crate::testing::run(async || {
        use std::os::unix::process::CommandExt;
        let (state, task, run) = running(true);
        let dir = runs::run_dir(&state, &run.id);
        std::fs::write(dir.join("run.json"), r#"{"format": 99}"#).unwrap();
        std::fs::write(dir.join("spec.json"), "{}").unwrap();
        // Its agent, in a process group of its own as ia-shim starts it.
        let mut agent = std::process::Command::new("sleep").arg("60").process_group(0).spawn().unwrap();
        std::fs::write(dir.join("pid"), agent.id().to_string()).unwrap();
        restart(&state, &task);
        assert_eq!(db::get_run(&state.db(), &run.id).unwrap().unwrap().status, "exited");
        assert!(input_closed(&state, &run));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while agent.try_wait().unwrap().is_none() {
            assert!(std::time::Instant::now() < deadline, "the agent is still running");
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    });
}

#[test]
fn after_a_restart_a_message_can_wait_for_the_agents_next_step() {
    crate::testing::run(async || {
        let (state, task, run) = running(true);
        // Mid-turn, in a later turn than the one that ended.
        state.db().execute("UPDATE runs SET saw_result=1 WHERE id=?1", [&run.id]).unwrap();
        send(&state, &task.id, "when you get to it").unwrap();
        restart(&state, &task);
        tokio::time::sleep(STEER_GRACE * 2).await;
        assert!(!input_closed(&state, &run));
    });
}

#[test]
fn follows_how_full_the_context_is() {
    crate::testing::run(async || {
        let (state, task, run) = running(true);
        let context = || reload(&state, &task.id).context.unwrap();
        let reply = |parent: Value, written: u64| {
            let usage = json!({"input_tokens": 2, "cache_creation_input_tokens": written, "cache_read_input_tokens": 1000, "output_tokens": 50});
            json!({"type": "assistant", "parent_tool_use_id": parent, "message": {"model": "claude-x", "content": [{"type": "text", "text": "hi"}], "usage": usage}})
        };
        output(&state, &run, &[reply(Value::Null, 500)]);
        assert_eq!((context().tokens, context().max_tokens), (1502, None));
        // A subagent's context is its own.
        output(&state, &run, &[reply(json!("toolu_sub"), 90_000)]);
        assert_eq!(context().tokens, 1502);

        // The turn's end gives the model's window, and asks for the breakdown before the
        // input is closed.
        let mut end = result("success", 0.1);
        end["modelUsage"] = json!({"claude-haiku": {"contextWindow": 1000}, "claude-x": {"contextWindow": 200_000}});
        output(&state, &run, &[end]);
        assert_eq!(context().max_tokens, Some(200_000));
        assert!(input_closed(&state, &run));
        let sent = input(&state, &run);
        let ask = sent.last().unwrap();
        assert_eq!((&ask["type"], &ask["request"]["subtype"]), (&json!("control_request"), &json!("get_context_usage")));
        // Not the full recount, which calls the token-counting API.
        assert_eq!(ask["request"]["detail"], "summary");
        assert_eq!(context().detail_at, None);

        // Other control responses aren't breakdowns.
        output(&state, &run, &[json!({"type": "control_response", "response": {"subtype": "success", "request_id": "stop-1", "response": {"totalTokens": 5}}})]);
        assert_eq!(context().tokens, 1502);
        let breakdown = json!({
            "categories": [{"id": "messages", "name": "Messages", "tokens": 600, "kind": "used"}],
            "totalTokens": 1600, "maxTokens": 1_000_000, "autoCompactThreshold": 967_000, "isAutoCompactEnabled": true,
            "model": "claude-x", "gridRows": [[{"color": "x"}]],
        });
        output(&state, &run, &[json!({"type": "control_response", "response": {"subtype": "success", "request_id": ask["request_id"], "response": breakdown}})]);
        let ctx = context();
        assert_eq!((ctx.tokens, ctx.max_tokens, ctx.compact_at, ctx.model.as_deref()), (1600, Some(1_000_000), Some(967_000), Some("claude-x")));
        assert!(ctx.detail_at.is_some());
        let got = crate::context::get(axum::extract::State(state.clone()), axum::extract::Path(task.id.clone())).await.unwrap().0;
        assert_eq!(got["detail"]["categories"][0]["tokens"], 600);
        assert!(got["detail"].get("gridRows").is_none());

        // Compacting starts again from the summary.
        output(&state, &run, &[json!({"type": "system", "subtype": "compact_boundary", "compact_metadata": {"trigger": "auto", "pre_tokens": 1600, "post_tokens": 300}})]);
        assert_eq!((context().tokens, context().max_tokens), (300, Some(1_000_000)));
    });
}

#[test]
fn records_context_sizes_and_compactions() {
    crate::testing::run(async || {
        let (state, task, run) = running(true);
        let stats = || -> Vec<(String, String, Option<i64>, Option<i64>, Option<String>, Option<f64>)> {
            let c = state.db();
            let mut st = c.prepare("SELECT run_id, kind, tokens, post_tokens, source, cost_usd FROM context_stats ORDER BY id").unwrap();
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))).unwrap().map(|r| r.unwrap()).collect()
        };
        let starts = || -> Vec<Option<i64>> {
            let c = state.db();
            let mut st = c.prepare("SELECT start_tokens FROM context_stats WHERE kind='turn' ORDER BY id").unwrap();
            st.query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
        };
        let reply = |written: u64| {
            let usage = json!({"input_tokens": 2, "cache_creation_input_tokens": written, "cache_read_input_tokens": 1000});
            json!({"type": "assistant", "parent_tool_use_id": null, "message": {"model": "claude-x", "content": [{"type": "text", "text": "hi"}], "usage": usage}})
        };
        // Each turn's end records the context it started from (its first request) and leaves,
        // and what it cost.
        output(&state, &run, &[reply(100), reply(500), result("success", 0.25)]);
        let turn = (run.id.clone(), "turn".to_string(), Some(1502), None, None, Some(0.25));
        assert_eq!(stats(), vec![turn.clone()]);
        assert_eq!(starts(), vec![Some(1102)]);
        // The breakdown asked for at the turn's end changes the task's context, but a turn the
        // model then didn't answer isn't one to count.
        let ask = input(&state, &run).last().unwrap().clone();
        let breakdown = json!({"totalTokens": 1600, "maxTokens": 200_000, "model": "claude-x"});
        output(&state, &run, &[json!({"type": "control_response", "response": {"subtype": "success", "request_id": ask["request_id"], "response": breakdown}})]);
        output(&state, &run, &[result("error_during_execution", 0.25)]);
        assert_eq!(stats().len(), 1);
        // A session started afresh on the thread (as reviews and summaries do) starts small,
        // whatever the last turn left.
        output(&state, &run, &[reply(10), result("success", 0.3)]);
        assert_eq!((stats().len(), stats()[1].2), (2, Some(1012)));
        assert_eq!(starts(), vec![Some(1102), Some(1012)]);
        let turn2 = stats()[1].clone();

        // The agent compacting by itself mid-turn.
        output(&state, &run, &[json!({"type": "system", "subtype": "compact_boundary", "compact_metadata": {"trigger": "auto", "pre_tokens": 1600, "post_tokens": 300}})]);
        let auto = (run.id.clone(), "compact".to_string(), Some(1600), Some(300), Some("auto".to_string()), None);
        assert_eq!(stats()[2], auto);
        // A compaction alone isn't a turn either.
        output(&state, &run, &[result("success", 0.0)]);
        assert_eq!(stats().len(), 3);
        state.db().execute("UPDATE runs SET status='done' WHERE id=?1", [&run.id]).unwrap();

        // The board's `/compact` after the session sat idle, and the user's.
        let manual = json!({"trigger": "manual", "pre_tokens": 300, "post_tokens": 100});
        let idle = db::insert_run(&state.db(), &task.id, "compact").unwrap();
        crate::context::on_compacted(&state, &idle, &manual).unwrap();
        let user = db::insert_run(&state.db(), &task.id, "compact").unwrap();
        db::insert_message(&state.db(), &task.id, "user", &json!({"text": "/compact"})).unwrap();
        crate::context::on_compacted(&state, &user, &manual).unwrap();
        // Without `pre_tokens` (Codex), it's the latest count.
        crate::context::on_compacted(&state, &user, &json!({"trigger": "manual"})).unwrap();
        let sources: Vec<_> = stats()[3..].iter().map(|s| (s.0.clone(), s.2, s.4.clone().unwrap())).collect();
        assert_eq!(sources, vec![(idle.id.clone(), Some(300), "idle".into()), (user.id.clone(), Some(300), "user".into()), (user.id.clone(), Some(100), "user".into())]);
        // A `/compact`'s turn isn't one of the agent's.
        crate::context::record_turn(&state, &user, Some(0.01)).unwrap();
        assert_eq!(stats().len(), 6);

        // The report has the profile's, in range.
        let all = crate::analytics::context_report(&state.db(), &task.profile_id, "2000-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z").unwrap();
        assert_eq!((all.stats.len(), all.tasks.len()), (6, 1));
        let first = &all.stats[0];
        assert_eq!((first.kind.as_str(), first.start_tokens, first.tokens, first.cost_usd), ("turn", Some(1102), Some(1502), Some(0.25)));
        assert_eq!(all.stats[1].tokens, turn2.2);
        let none = crate::analytics::context_report(&state.db(), "someone-else", "2000-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z").unwrap();
        assert!(none.stats.is_empty());
        let later = crate::analytics::context_report(&state.db(), &task.profile_id, "2100-01-01T00:00:00.000Z", "2100-01-02T00:00:00.000Z").unwrap();
        assert!(later.stats.is_empty());
    });
}

#[test]
fn says_whether_the_running_agent_takes_messages() {
    crate::testing::run(async || {
        let (state, task, _run) = running(false);
        let task = state.update_task(&task.id, &[("steerable", json!(true))]).unwrap().unwrap();
        // Started by an older build, whose agents read only their prompt.
        restart(&state, &task);
        assert!(!reload(&state, &task.id).steerable);
    });
}

#[test]
fn messages_sent_while_preparing_go_once_the_agent_starts() {
    crate::testing::run(async || {
        let (state, task, run) = running(true);
        state.db().execute("UPDATE runs SET status='preparing' WHERE id=?1", [&run.id]).unwrap();
        let dir = runs::run_dir(&state, &run.id);
        std::fs::remove_dir_all(&dir).unwrap();
        let t = send(&state, &task.id, "early").unwrap();
        assert!(!t.steering[0].written);
        // `started`, once the shim is up.
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("input.jsonl"), "").unwrap();
        let t = {
            let _runs = state.runs.lock().unwrap();
            write_steers(&state, &task.id).unwrap().unwrap()
        };
        assert!(t.steering[0].written);
        assert_eq!(input(&state, &run)[0]["message"]["content"], "early");
    });
}

#[test]
fn queues_for_runs_that_cant_take_messages() {
    crate::testing::run(async || {
        // Started by an older build, whose agents read only their prompt.
        let (state, task, _run) = running(false);
        let t = send(&state, &task.id, "later").unwrap();
        assert_eq!((t.queued_message.as_deref(), t.steering.len()), (Some("later"), 0));
        // `/compact` can't go into a turn.
        let (state, task, run) = running(true);
        let t = send(&state, &task.id, "/compact").unwrap();
        assert_eq!((t.queued_message.as_deref(), t.steering.len()), (Some("/compact"), 0));
        assert!(input(&state, &run).is_empty());
    });
}

#[test]
fn tells_agents_which_boards_they_reach() {
    let c = db::open(std::path::Path::new(":memory:")).unwrap();
    let [personal, work, lab] = ["personal", "work", "lab"].map(|n| db::insert_profile(&c, n, &[], None).unwrap());
    db::update_profile(&c, &work.id, &[("agent_access", serde_json::json!(["personal"]))]).unwrap();
    let note = profiles_note(&db::list_profiles(&c).unwrap(), &personal);
    assert!(note.contains("also reach these profiles' boards: work."), "{note}");
    assert!(note.contains("their projects aren't listed: lab."), "{note}");
    let note = profiles_note(&db::list_profiles(&c).unwrap(), &lab);
    assert!(!note.contains("also reach") && note.contains("personal, work"), "{note}");
}

#[test]
fn an_archived_projects_agents_dont_start() {
    crate::testing::run(async || {
        crate::runs::TEST_CAN_RUN.set(true);
        let state = crate::testing::state();
        let p = db::insert_profile(&state.db(), "p", &[], None).unwrap();
        let np = db::NewProject { id: "pr", profile_id: &p.id, name: "Old", key: "OLD", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
        db::insert_project(&state.db(), np).unwrap();
        let t = db::NewTask { profile_id: &p.id, project_id: Some("pr"), kind: "task", title: "Fix it", description: "", status: "in_review", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let task = db::insert_task(&state.db(), t).unwrap();
        db::update_task(&state.db(), &task.id, &[("session_id", serde_json::json!("sess"))]).unwrap();
        db::update_project(&state.db(), "pr", &[("archived_at", serde_json::json!("2026-01-01T00:00:00.000Z"))]).unwrap();
        // Neither a message (from the user or another agent) nor a compaction starts one.
        for err in [send(&state, &task.id, "Carry on").unwrap_err(), compact(&state, &task.id, "idle").unwrap_err()] {
            assert!(err.1.contains("\"Old\" is archived"), "{}", err.1);
        }
        assert!(!state.is_running(&task.id));
        assert!(!db::get_task(&state.db(), &task.id).unwrap().unwrap().running);
        let runs: i64 = state.db().query_row("SELECT COUNT(*) FROM runs WHERE task_id=?1", [&task.id], |r| r.get(0)).unwrap();
        assert_eq!(runs, 0, "no run was registered");
        crate::runs::TEST_CAN_RUN.set(false);
    })
}

#[test]
fn an_archived_projects_queued_messages_wait_for_it() {
    crate::testing::run(async || {
        crate::runs::TEST_CAN_RUN.set(true);
        let state = crate::testing::state();
        let p = db::insert_profile(&state.db(), "p", &[], None).unwrap();
        let np = db::NewProject { id: "pr", profile_id: &p.id, name: "Old", key: "OLD", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
        db::insert_project(&state.db(), np).unwrap();
        let new = |title: &str| {
            let t = db::NewTask { profile_id: &p.id, project_id: Some("pr"), kind: "task", title, description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
            db::insert_task(&state.db(), t).unwrap()
        };
        let (first, waits, blocked) = (new("First"), new("Waits"), new("Blocked"));
        for t in [&waits, &blocked] {
            state.update_task(&t.id, &[("depends_on", json!([first.id]))]).unwrap();
        }
        // One already waiting for its dependency, with what it was asked queued.
        send(&state, &waits.id, "Do the thing").unwrap();
        let get = |id: &str| db::get_task(&state.db(), id).unwrap().unwrap();
        assert!(get(&waits.id).waiting);
        db::update_project(&state.db(), "pr", &[("archived_at", json!("2026-01-01T00:00:00.000Z"))]).unwrap();

        // A message behind dependencies is refused rather than queued where nothing sends it.
        let err = send(&state, &blocked.id, "Go").unwrap_err();
        assert!(err.1.contains("is archived"), "{}", err.1);
        let b = get(&blocked.id);
        assert_eq!((b.status.as_str(), b.waiting, b.queued_message), ("todo", false, None));

        // Its dependency merged, the waiting one keeps waiting with its message.
        state.update_task(&first.id, &[("status", json!("done"))]).unwrap();
        start_unblocked(&state, Some("pr"));
        let w = get(&waits.id);
        assert_eq!((w.waiting, w.status.as_str(), w.queued_message.as_deref()), (true, "in_progress", Some("Do the thing")));
        // A message to it now is refused, and leaves the queued one.
        assert!(send(&state, &waits.id, "And this").is_err());
        assert_eq!(get(&waits.id).queued_message.as_deref(), Some("Do the thing"));

        // Archived after start_unblocked picked it: it waits again, message and all.
        db::update_project(&state.db(), "pr", &[("archived_at", Value::Null)]).unwrap();
        db::queue(&state.db(), &blocked.id, db::Queued::new("Go", false)).unwrap();
        state.update_task(&blocked.id, &[("waiting", json!(true)), ("status", json!("in_progress"))]).unwrap();
        let picked = get(&blocked.id);
        db::update_project(&state.db(), "pr", &[("archived_at", json!("2026-01-02T00:00:00.000Z"))]).unwrap();
        start_waiting(&state, &picked);
        let b = get(&blocked.id);
        assert_eq!((b.waiting, b.status.as_str(), b.attention_reason, b.queued_message.as_deref()), (true, "in_progress", None, Some("Go")));
        crate::runs::TEST_CAN_RUN.set(false);
    })
}

#[test]
fn a_queued_message_stays_when_its_run_cant_start() {
    crate::testing::run(async || {
        // This host can't run agents, which start_run finds after the queued message is taken.
        let state = crate::testing::state();
        let p = db::insert_profile(&state.db(), "p", &[], None).unwrap();
        let t = db::NewTask { profile_id: &p.id, project_id: None, kind: "scratch", title: "t", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let t = db::insert_task(&state.db(), t).unwrap();
        db::queue(&state.db(), &t.id, db::Queued::new("First", true)).unwrap();
        assert!(send(&state, &t.id, "Second").is_err());
        assert_eq!(db::take_queued(&state.db(), &t.id).unwrap(), Some(db::Queued::new("First", true)));
    })
}

#[test]
fn starts_with_the_projects_instructions() {
    let c = db::open(std::path::Path::new(":memory:")).unwrap();
    let p = db::insert_profile(&c, "p", &[], None).unwrap();
    let np = db::NewProject { id: "pr", profile_id: &p.id, name: "x", key: "X", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
    let mut project = db::insert_project(&c, np).unwrap();
    let t = db::NewTask { profile_id: &p.id, project_id: Some("pr"), kind: "task", title: "Fix it", description: "It's broken.", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
    let task = db::insert_task(&c, t).unwrap();
    let text = start_prompt(&task, Some(&project), "");
    assert_eq!(text, format!("# X-1: Fix it\n\nIt's broken.\n\n---\n\n{}\n", crate::prompts::DEFAULT_START));
    project.start_prompt = Some("Write a plan and ask me about it first.".into());
    let text = start_prompt(&task, Some(&project), "Only the server.");
    assert!(text.ends_with("---\n\nWrite a plan and ask me about it first.\n\nOnly the server.\n"), "{text}");
    // A skill's command goes first, where Claude Code expands it, with the task as its arguments.
    let text = start_prompt(&task, Some(&project), " /code-review the server\n");
    assert_eq!(text, "/code-review the server\n\n# X-1: Fix it\n\nIt's broken.\n\n---\n\nWrite a plan and ask me about it first.\n");
    let text = start_prompt(&task, Some(&project), "/plugin:skill");
    assert!(text.starts_with("/plugin:skill\n\n# X-1"), "{text}");
    // A path isn't a command.
    let text = start_prompt(&task, Some(&project), "/home/me/x.log has the error");
    assert!(text.starts_with("# X-1") && text.ends_with("\n/home/me/x.log has the error\n"), "{text}");
    // Followed by what it's for elsewhere.
    let links = serde_json::json!([{"provider": "asana", "id": "12", "url": "https://app.asana.com/0/1/12", "title": "Fix signup"}]);
    let task = db::update_task(&c, &task.id, &[("external_links", links)]).unwrap().unwrap();
    let text = start_prompt(&task, Some(&project), "");
    assert!(text.starts_with("# X-1: Fix it\n\nIt's broken.\n\nThis task is for:\n- Asana task: Fix signup (https://app.asana.com/0/1/12)\n\n---\n"), "{text}");
}

/// A system prompt is in paragraphs, with a blank line between them: none is empty, and no line starts or ends
/// with a space (as a sentence joined on to the one before would).
fn assert_paragraphs(text: &str) {
    assert!(text.contains("\n\n") && !text.contains("\n\n\n"), "{text}");
    assert!(text.lines().all(|l| l.trim() == l) && text.split("\n\n").all(|p| !p.trim().is_empty()), "{text:?}");
}

#[test]
fn a_group_task_is_told_its_groups_projects() {
    let c = db::open(std::path::Path::new(":memory:")).unwrap();
    let p = db::insert_profile(&c, "p", &[], None).unwrap();
    let np = db::NewProject { id: "pr", profile_id: &p.id, name: "Web", key: "WEB", repo_path: "/src/web", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
    db::insert_project(&c, np).unwrap();
    db::update_project(&c, "pr", &[("group_name", serde_json::json!("Shop"))]).unwrap();
    let t = db::NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "Plan it", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
    let task = db::insert_group_task(&c, t, "Shop").unwrap();
    let group = db::group_projects(&c, &p.id, "Shop").unwrap();
    let text = system_prompt(&task, None, None, &group, &[], None, true);
    assert!(text.contains("task G-1 (\"Plan it\"") && text.contains("Web (key WEB, id pr, repository /src/web)"), "{text}");
    assert_paragraphs(&text);
    assert!(start_prompt(&task, None, "").starts_with("# G-1: Plan it\n"));
}

#[test]
fn previews_what_a_new_thread_in_a_project_is_told() {
    crate::testing::run(async || {
        let state = crate::testing::state();
        let repo = crate::testing::temp_dir();
        let git = |args: &[&str]| assert!(std::process::Command::new("git").args(args).current_dir(&repo).status().unwrap().success());
        git(&["init", "-q", "-b", "main"]);
        git(&["remote", "add", "origin", "git@github.com:o/web.git"]);
        let project = {
            let c = state.db();
            let p = db::insert_profile(&c, "me", &[], None).unwrap();
            let repo_path = path_str(&repo);
            let np = db::NewProject {
                id: "pr", profile_id: &p.id, name: "Web", key: "WEB", repo_path: &repo_path, scratch_path: "/s", worktrees_root: "/w", base_branch: Some("main"), use_worktrees: true,
            };
            db::insert_project(&c, np).unwrap()
        };
        let preview = async |q: Value| {
            let p = preview(&state, &project, &serde_json::from_value(q).unwrap()).await;
            if let Ok((text, ..)) = &p {
                assert_paragraphs(text);
            }
            p
        };

        // A task as the project's new ones are, numbered as its next.
        let (text, codex, mode) = preview(json!({})).await.unwrap();
        assert!(!codex && mode == "default");
        assert!(text.starts_with("You are an agent working on task WEB-1 (\"Task title\") on the Huntaway board."), "{text}");
        assert!(text.contains("worktree at /w/1-task-title on branch `ia/web-1-task-title` (branched from `main`)"), "{text}");
        assert!(text.contains("on GitHub (o/web)") && text.contains("pr_create with repo `o/web`, head `ia/web-1-task-title` and base `main`"), "{text}");
        let profiles = db::list_profiles(&state.db()).unwrap();
        assert!(text.contains(&gh_note(None)) && text.ends_with(&profiles_note(&profiles, &profiles[0])), "{text}");
        // Making it doesn't make a task, or take the number.
        let (again, ..) = preview(json!({})).await.unwrap();
        assert_eq!(again, text);
        assert!(db::list_tasks_for_project(&state.db(), "pr", "task").unwrap().is_empty());

        // The options a new thread is made with.
        let (text, ..) = preview(json!({"labels": "plan,diagram"})).await.unwrap();
        assert!(text.contains("This task has the labels plan, diagram on the board") && text.contains("<task id>/plan.html"), "{text}");
        let (text, ..) = preview(json!({"worktree": false})).await.unwrap();
        assert!(!text.contains("worktree") && !text.contains("open a pull request"), "{text}");
        let (text, ..) = preview(json!({"type": "scratch"})).await.unwrap();
        assert!(text.contains("This scratch task is in the project Web") && !text.contains("worktree at"), "{text}");
        let (text, ..) = preview(json!({"type": "subproject", "worktree": false})).await.unwrap();
        assert!(text.contains("This task is a subproject") && text.contains("worktree at /w/1-task-title"), "{text}");
        let (text, codex, mode) = preview(json!({"runtime": "codex", "permission_mode": "plan"})).await.unwrap();
        assert!(codex && mode == "plan" && text.contains("You are in plan mode") && text.contains("`gh.pr_view`") && !text.contains(&gh_note(None)), "{text}");
        let (text, ..) = preview(json!({"permission_mode": "plan"})).await.unwrap();
        assert!(!text.contains("You are in plan mode"), "Claude Code tells Claude itself: {text}");
        // A thread inherits the host's mode, when the project has none.
        db::set_setting(&state.db(), "default_permission_mode", Some("plan")).unwrap();
        let (text, _, mode) = preview(json!({"runtime": "codex"})).await.unwrap();
        assert!(mode == "plan" && text.contains("You are in plan mode"), "{text}");
        let (text, _, mode) = preview(json!({"runtime": "codex", "permission_mode": "default"})).await.unwrap();
        assert!(mode == "default" && !text.contains("You are in plan mode"), "{text}");

        for bad in [json!({"type": "review"}), json!({"labels": "nope"}), json!({"runtime": "gpt"}), json!({"permission_mode": "yolo"})] {
            assert_eq!(preview(bad).await.unwrap_err().0, axum::http::StatusCode::BAD_REQUEST);
        }
        std::fs::remove_dir_all(&repo).ok();
    })
}

#[test]
fn a_task_on_github_is_told_to_open_a_pull_request() {
    let c = db::open(std::path::Path::new(":memory:")).unwrap();
    let p = db::insert_profile(&c, "p", &[], None).unwrap();
    let np = db::NewProject { id: "pr", profile_id: &p.id, name: "Web", key: "WEB", repo_path: "/src/web", scratch_path: "/s", worktrees_root: "/w", base_branch: Some("main"), use_worktrees: true };
    let project = db::insert_project(&c, np).unwrap();
    let t = db::NewTask { profile_id: &p.id, project_id: Some("pr"), kind: "task", title: "Fix it", description: "", status: "todo", use_worktree: true, model: None, effort: None, claude_config_id: None };
    let mut task = db::insert_task(&c, t).unwrap();
    (task.worktree_path, task.branch) = (Some("/w/1-fix-it".into()), Some("ia/web-1-fix-it".into()));
    // Pushed to a mirror: gh is told which repository, as it would pick the fetch remote's.
    let gh = worktree::Github { remote: "origin".into(), repo: "o/web-mirror".into() };
    let text = system_prompt(&task, Some(&project), None, &[], &[], Some(&gh), false);
    assert!(text.contains("Do not merge or switch branches unless asked."), "{text}");
    assert!(text.contains("on GitHub (o/web-mirror)") && text.contains("`git push -u origin ia/web-1-fix-it`"), "{text}");
    assert!(text.contains("into `main` in o/web-mirror (`gh pr create --repo o/web-mirror --head ia/web-1-fix-it --base main`"), "{text}");
    // With the gh server, which turns away gh in Bash, through its tools.
    let text = system_prompt(&task, Some(&project), None, &[], &[], Some(&gh), true);
    assert!(text.contains("in o/web-mirror (the gh tools' pr_create with repo `o/web-mirror`, head `ia/web-1-fix-it` and base `main`)"), "{text}");
    assert!(!text.contains("gh pr create"), "{text}");

    // Without GitHub (or a branch of its own), it leaves pushing to the user.
    let text = system_prompt(&task, Some(&project), None, &[], &[], None, false);
    assert!(text.contains("Do not push, merge, or switch branches unless asked.") && !text.contains("open a pull request"), "{text}");
    task.branch = None;
    assert!(!system_prompt(&task, Some(&project), None, &[], &[], Some(&gh), false).contains("open a pull request"));
    // Every agent is told it can wait on one, though.
    assert!(text.contains("For CI or reviews on a pull request, give it the `pull_request`"), "{text}");
}

#[test]
fn projects_and_their_subprojects_can_turn_pull_requests_off() {
    let c = db::open(std::path::Path::new(":memory:")).unwrap();
    let p = db::insert_profile(&c, "p", &[], None).unwrap();
    let np = db::NewProject { id: "pr", profile_id: &p.id, name: "Web", key: "WEB", repo_path: "/src/web", scratch_path: "/s", worktrees_root: "/w", base_branch: Some("main"), use_worktrees: true };
    let mut project = db::insert_project(&c, np).unwrap();
    let t = db::NewTask { profile_id: &p.id, project_id: Some("pr"), kind: "task", title: "Big", description: "", status: "todo", use_worktree: true, model: None, effort: None, claude_config_id: None };
    let mut sp = db::insert_task(&c, t).unwrap();
    (sp.subproject, sp.worktree_path, sp.branch, sp.base_branch) = (true, Some("/w/1-big".into()), Some("ia/web-1-big".into()), Some("main".into()));
    let t = db::NewTask { profile_id: &p.id, project_id: Some("pr"), kind: "task", title: "Part", description: "", status: "todo", use_worktree: true, model: None, effort: None, claude_config_id: None };
    let mut part = db::insert_task(&c, t).unwrap();
    (part.parent_id, part.worktree_path, part.branch, part.base_branch) = (Some(sp.id.clone()), Some("/w/2-part".into()), Some("ia/web-2-part".into()), Some("ia/web-1-big".into()));
    let gh = worktree::Github { remote: "origin".into(), repo: "o/web".into() };
    let opens = |text: &str| text.contains("so before you finish, open a pull request") && text.contains("Do not merge or switch branches unless asked.");
    let off = "This project's settings turn off pull requests";

    // On by default, for both.
    let text = system_prompt(&sp, Some(&project), None, &[], &[], Some(&gh), true);
    assert!(opens(&text) && text.contains("(through pull requests that target it, if the project uses them)") && !text.contains(off), "{text}");
    let text = system_prompt(&part, Some(&project), Some(&sp), &[], &[], Some(&gh), true);
    assert!(opens(&text) && text.contains("If you open a pull request, target `ia/web-1-big` (e.g. pr_create with base `ia/web-1-big`)"), "{text}");
    assert!(text.contains("head `ia/web-2-part` and base `ia/web-1-big`") && !text.contains(off), "{text}");

    // Off for the subproject's tasks: the subproject itself still opens one.
    project.subproject_pull_requests = false;
    let text = system_prompt(&sp, Some(&project), None, &[], &[], Some(&gh), true);
    assert!(opens(&text) && text.contains("(without pull requests, which the project's settings turn off for subprojects' tasks)"), "{text}");
    let text = system_prompt(&part, Some(&project), Some(&sp), &[], &[], Some(&gh), true);
    assert!(!opens(&text) && !text.contains("pr_create with") && text.contains("Do not push, merge, or switch branches unless asked."), "{text}");
    assert!(text.contains("When you merge, merge into `ia/web-1-big`, which is checked out in the subproject's worktree at /w/1-big."), "{text}");
    assert!(text.contains(&format!("{off} for its subprojects' tasks, so don't push this task's branch")), "{text}");

    // Off for the project's tasks: its subprojects' tasks follow their own setting.
    (project.pull_requests, project.subproject_pull_requests) = (false, true);
    let text = system_prompt(&sp, Some(&project), None, &[], &[], Some(&gh), true);
    assert!(!opens(&text) && text.contains(&format!("{off} for its tasks, so don't push")), "{text}");
    assert!(text.contains("(through pull requests that target it, if the project uses them)"), "{text}");
    let text = system_prompt(&part, Some(&project), Some(&sp), &[], &[], Some(&gh), true);
    assert!(opens(&text) && !text.contains(off), "{text}");
    // A task without a branch of its own isn't told about them.
    let mut plain = part.clone();
    (plain.parent_id, plain.worktree_path, plain.branch) = (None, None, None);
    assert!(!system_prompt(&plain, Some(&project), None, &[], &[], Some(&gh), true).contains(off));
}

#[test]
fn the_github_account_is_the_projects_or_the_profiles() {
    let c = db::open(std::path::Path::new(":memory:")).unwrap();
    let mut profile = db::insert_profile(&c, "p", &[], None).unwrap();
    let np = db::NewProject { id: "pr", profile_id: &profile.id, name: "Web", key: "WEB", repo_path: "/src/web", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
    let mut project = db::insert_project(&c, np).unwrap();
    assert_eq!(github_account(Some(&project), &profile), None);
    profile.github_account = Some("me".into());
    assert_eq!(github_account(Some(&project), &profile).as_deref(), Some("me"));
    assert_eq!(github_account(None, &profile).as_deref(), Some("me"));
    project.github_account = Some("work-me".into());
    assert_eq!(github_account(Some(&project), &profile).as_deref(), Some("work-me"));
    project.github_account = Some(" ".into());
    assert_eq!(github_account(Some(&project), &profile).as_deref(), Some("me"));
    assert!(gh_note(Some("work-me")).contains("as the GitHub account work-me") && !gh_note(None).contains("account"));
}

#[test]
fn the_gh_hook_runs_this_binary() {
    let settings: Value = serde_json::from_str(&gh_hook_settings(std::path::Path::new("/opt/it's here/huntaway"))).unwrap();
    let hook = &settings["hooks"]["PreToolUse"][0];
    assert_eq!(hook["matcher"], "Bash");
    assert_eq!(hook["hooks"][0]["command"], r"'/opt/it'\''s here/huntaway' gh-hook");
    // A project that turns the gh server off, or has its own, gets neither.
    let mut tools = crate::agent_tools::RunTools::default();
    assert!(uses_gh_server(&tools));
    tools.disallowed.push("mcp__gh".into());
    assert!(!uses_gh_server(&tools));
    tools.disallowed.clear();
    tools.mcp_servers.insert("gh".into(), json!({}));
    assert!(!uses_gh_server(&tools));
}

#[test]
fn a_plan_task_from_before_labels_is_told_to_make_only_its_plan() {
    let c = db::open(std::path::Path::new(":memory:")).unwrap();
    let p = db::insert_profile(&c, "p", &[], None).unwrap();
    let np = db::NewProject { id: "pr", profile_id: &p.id, name: "Web", key: "WEB", repo_path: "/src/web", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
    let mut project = db::insert_project(&c, np).unwrap();
    project.start_prompt = Some("Write a failing test first.".into());
    let t = db::NewTask { profile_id: &p.id, project_id: Some("pr"), kind: "task", title: "Plan search", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
    let task = db::insert_task(&c, t).unwrap();
    // As the migration to labels leaves it.
    let fields = [("labels", serde_json::json!(["plan"])), ("work_dir", serde_json::json!(format!("documents/{}", task.id)))];
    let task = db::update_task(&c, &task.id, &fields).unwrap().unwrap();
    let docs = [("plan", "/data/documents/t/plan.html".to_string())];
    let text = system_prompt(&task, Some(&project), None, &[], &docs, None, true);
    assert!(text.contains("task WEB-1 (\"Plan search\"") && text.contains("a plan (HTML) to /data/documents/t/plan.html"), "{text}");
    assert!(text.contains("Rather than changing code") && text.contains("break it into tasks"), "{text}");
    assert_paragraphs(&text);
    assert!(text.contains("repository /src/web, which you can read") && !text.contains("worktree"), "{text}");
    assert!(!text.contains("label plan") && !text.contains("carry it out in this task"), "{text}");
    // It's told about the plan theme's components.
    assert!(text.contains("<ol class=\"steps\">") && text.contains("<ia-html><template>"), "{text}");
    // The project's start instructions are for its code tasks.
    assert!(start_prompt(&task, Some(&project), "").contains(crate::prompts::DEFAULT_START));
}

#[test]
fn a_labelled_task_is_told_to_write_its_documents_besides_its_work() {
    let c = db::open(std::path::Path::new(":memory:")).unwrap();
    let p = db::insert_profile(&c, "p", &[], None).unwrap();
    let np = db::NewProject { id: "pr", profile_id: &p.id, name: "Web", key: "WEB", repo_path: "/src/web", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: true };
    let mut project = db::insert_project(&c, np).unwrap();
    project.start_prompt = Some("Write a failing test first.".into());
    let t = db::NewTask { profile_id: &p.id, project_id: Some("pr"), kind: "task", title: "Search", description: "", status: "todo", use_worktree: true, model: None, effort: None, claude_config_id: None };
    let mut task = db::insert_task(&c, t).unwrap();
    (task.branch, task.worktree_path) = (Some("ia/web-1-search".into()), Some("/w/1".into()));
    let plain = system_prompt(&task, Some(&project), None, &[], &[], None, true);
    assert!(!plain.contains("label") && !plain.contains("<ol class=\"steps\">"), "{plain}");
    task.labels = vec!["plan".into(), "diagram".into()];
    let docs = [("plan", "/d/plan.html".to_string()), ("diagram", "/d/diagram.mmd".to_string())];
    let text = system_prompt(&task, Some(&project), None, &[], &docs, None, true);
    // A code task still, in its worktree.
    assert!(text.starts_with(&plain) && text.contains("dedicated git worktree at /w/1"), "{text}");
    assert!(text.contains("the labels plan, diagram") && text.contains("a plan (HTML) to /d/plan.html and a Mermaid diagram to /d/diagram.mmd"), "{text}");
    assert!(text.contains("don't commit them") && text.contains("The plan comes first") && text.contains("carry it out in this task"), "{text}");
    assert!(text.contains("<ol class=\"steps\">") && text.contains("Mermaid source") && !text.contains("Rather than changing code"), "{text}");
    assert!(text.contains("<ia-diagram><pre>flowchart LR") && text.contains("Always use Mermaid for plan diagrams"), "{text}");
    assert!(!text.contains("<ia-diagram><svg"), "{text}");
    // And it starts with the project's instructions.
    assert!(start_prompt(&task, Some(&project), "").contains("Write a failing test first."));
}

#[test]
fn a_reviewer_is_told_what_it_reviews_and_not_to_change_it() {
    let c = db::open(std::path::Path::new(":memory:")).unwrap();
    let p = db::insert_profile(&c, "p", &[], None).unwrap();
    let np = db::NewProject { id: "pr", profile_id: &p.id, name: "Web", key: "WEB", repo_path: "/src/web", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: true };
    let project = db::insert_project(&c, np).unwrap();
    let t = |kind, title| db::NewTask { profile_id: &p.id, project_id: Some("pr"), kind, title, description: "", status: "todo", use_worktree: true, model: None, effort: None, claude_config_id: None };
    let mut parent = db::insert_task(&c, t("task", "Fix it")).unwrap();
    (parent.worktree_path, parent.branch, parent.worktree_state) = (Some("/w/1".into()), Some("ia/web-1-fix-it".into()), "ready".into());
    let mut review = db::insert_task(&c, t("review", "Review")).unwrap();
    review.kind = "review".into();
    let text = system_prompt(&review, Some(&project), Some(&parent), &[], &[], None, true);
    assert!(text.starts_with("You are the code reviewer for task WEB-1 (\"Fix it\")") && text.contains("worktree at /w/1 on branch `ia/web-1-fix-it`"), "{text}");
    assert!(text.contains("\n\nReview only:") && text.contains("call `submit_review` exactly once"), "{text}");
    assert_paragraphs(&text);
    review.task_type = Some(crate::summary::SUMMARY.into());
    let text = system_prompt(&review, Some(&project), Some(&parent), &[], &[], None, true);
    assert!(text.starts_with("You summarise the changes made for task WEB-1") && text.contains("\n\nRead only:"), "{text}");
    assert_paragraphs(&text);
}

#[test]
fn a_scratch_task_is_told_it_has_no_repository() {
    let c = db::open(std::path::Path::new(":memory:")).unwrap();
    let p = db::insert_profile(&c, "p", &[], None).unwrap();
    let t = db::NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "Ask", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
    let mut task = db::insert_scratch_task(&c, t).unwrap();
    let text = system_prompt(&task, None, None, &[], &[], None, true);
    assert!(text.contains("scratch task S-1 (\"Ask\"") && text.contains("isn't in a project or a repository"), "{text}");
    assert!(text.contains("the task's own folder") && text.contains("write freely") && !text.contains("worktree"), "{text}");
    // One from a scratch chat isn't told its (maybe shared) folder is free to write in.
    task.work_dir = Some("/data/profiles/p/scratch".into());
    let text = system_prompt(&task, None, None, &[], &[], None, true);
    assert!(text.contains("a scratch folder") && !text.contains("write freely"), "{text}");
    assert_paragraphs(&text);
    assert!(start_prompt(&task, None, "").starts_with("# S-1: Ask"));
}

#[test]
fn a_scratch_task_in_a_project_reads_it() {
    let c = db::open(std::path::Path::new(":memory:")).unwrap();
    let p = db::insert_profile(&c, "p", &[], None).unwrap();
    let np = db::NewProject { id: "pr", profile_id: &p.id, name: "Web", key: "WEB", repo_path: "/src/web", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: true };
    let project = db::insert_project(&c, np).unwrap();
    let t = |title| db::NewTask { profile_id: &p.id, project_id: Some("pr"), kind: "task", title, description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
    let mut sp = db::insert_task(&c, t("Search")).unwrap();
    (sp.subproject, sp.branch, sp.worktree_path, sp.worktree_state) = (true, Some("ia/web-1-search".into()), Some("/w/1".into()), "ready".into());
    let task = db::insert_task(&c, t("Ask")).unwrap();
    let task = db::update_task(&c, &task.id, &[("task_type", serde_json::json!("scratch"))]).unwrap().unwrap();
    let text = system_prompt(&task, Some(&project), None, &[], &[], None, true);
    assert!(text.contains("scratch task WEB-2 (\"Ask\"") && text.contains("in the project Web") && text.contains("repository /src/web, which you can read"), "{text}");
    assert!(text.contains("Don't change the repository") && !text.contains("subproject") && !text.contains("isn't in a project"), "{text}");
    // In a subproject, it's told about the subproject's branch and worktree.
    let text = system_prompt(&task, Some(&project), Some(&sp), &[], &[], None, true);
    assert!(text.contains("part of the subproject WEB-1 (\"Search\"), whose branch `ia/web-1-search`") && text.contains("worktree at /w/1, which you can read"), "{text}");
    assert_paragraphs(&text);
    assert!(start_prompt(&task, Some(&project), "").starts_with("# WEB-2: Ask"));
}

#[test]
fn in_auto_mode_claude_reviews_waits_itself() {
    let args = |mode: &str, review: bool| {
        let mut a: Vec<String> = ["-p", "--permission-mode", mode, "--allowedTools"].map(String::from).into();
        a.extend(board_tools_allowed(mode, review));
        a.extend(["mcp__gh__pr_view", "--disallowedTools", "mcp__gh__pr_merge", "--add-dir", "/a"].map(String::from));
        a
    };
    for mode in ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"] {
        assert_eq!(board_tools_allowed(mode, false), ["mcp__huntaway"]);
        assert!(!approves_own_waits(&args(mode, false)), "{mode}");
    }
    for review in [false, true] {
        let auto = board_tools_allowed("auto", review);
        assert!(auto.contains(&"mcp__huntaway__get_task".into()) && auto.contains(&"mcp__huntaway__permission_prompt".into()));
        assert!(auto.contains(&"mcp__huntaway__get_task_field".into()));
        assert!(!auto.iter().any(|t| t == "mcp__huntaway__wait" || t == "mcp__huntaway"), "{auto:?}");
        assert_eq!(auto.contains(&"mcp__huntaway__submit_review".into()), review);
        assert!(approves_own_waits(&args("auto", review)));
    }
    // Runs started by an older build had every board tool pre-approved, under the board's
    // current or (before the rename) old server name, whatever their mode.
    let old = |mode: &str, allowed: &str| -> Vec<String> {
        ["-p", "--permission-mode", mode, "--allowedTools", allowed, "mcp__gh__pr_view", "--add-dir", "/a"].map(String::from).into()
    };
    for mode in ["auto", "default", "dontAsk", "plan"] {
        for allowed in ["mcp__huntaway", "mcp__issue_agent", "mcp__issue_agent__wait", "mcp__gh__pr_list,mcp__issue_agent"] {
            assert!(!approves_own_waits(&old(mode, allowed)), "{mode} {allowed}");
        }
    }
    // Only auto mode leaves waits to Claude, however the board tools are listed.
    assert!(approves_own_waits(&old("auto", "mcp__huntaway__get_task")));
    for mode in ["default", "dontAsk", "plan", "acceptEdits", "bypassPermissions"] {
        assert!(!approves_own_waits(&old(mode, "mcp__huntaway__get_task")), "{mode}");
    }
    // A Codex run's arguments are the adapter's.
    assert!(!approves_own_waits(&["codex-run".into(), "/runs/r/codex.json".into()]));
    assert!(!approves_own_waits(&[]));
}

/// Run `b` starts on `task`, asks permission (as call `call`) and waits.
fn start_next(state: &Shared, task_id: &str, call: &str) -> String {
    let b = db::insert_run(&state.db(), task_id, "prompt").unwrap();
    state.runs.lock().unwrap().insert(task_id.to_string(), RunHandle { run_id: b.id.clone(), cancel: None });
    state.update_task(task_id, &[("running", json!(true)), ("status", json!("in_progress"))]).unwrap();
    ask(state, task_id, &b.id, call);
    let wait = json!({"since": "", "until": "", "call_id": format!("{call}-wait"), "run_id": b.id});
    state.update_task(task_id, &[("agent_wait", wait)]).unwrap();
    b.id
}

/// Run `run_id` asks permission, as call `call`.
fn ask(state: &Shared, task_id: &str, run_id: &str, call: &str) {
    state
        .db()
        .execute(
            "INSERT INTO mcp_calls (id,run_id,task_id,tool,args,status,created_at) VALUES (?1,?2,?3,'permission_prompt','{}','executing','')",
            [call, run_id, task_id],
        )
        .unwrap();
    state
        .db()
        .execute(
            "INSERT INTO permission_requests (id,task_id,message_id,tool_name,input,status,created_at,call_id) VALUES (?1,?2,0,'Bash','{}','pending','',?1)",
            [call, task_id],
        )
        .unwrap();
}

fn prompt_status(state: &Shared, call: &str) -> String {
    state.db().query_row("SELECT status FROM permission_requests WHERE call_id=?1", [call], |r| r.get(0)).unwrap()
}

#[test]
fn a_run_that_starts_as_the_last_one_ends_keeps_the_task_running() {
    crate::testing::run(async || {
        let (state, task, run) = running(false);
        // A message starts the next run once the last one's handle is gone, before its end is written.
        let next = std::rc::Rc::new(std::cell::RefCell::new(String::new()));
        crate::testing::when("finish:released", {
            let (st, id, next) = (state.clone(), task.id.clone(), next.clone());
            move || *next.borrow_mut() = start_next(&st, &id, "b1")
        });
        finish(&state, &run.id, Outcome::Ok);
        let t = reload(&state, &task.id);
        assert_eq!((t.running, t.status.as_str(), t.attention_reason), (true, "in_progress", None));
        assert_eq!(state.runs.lock().unwrap().get(&task.id).map(|h| h.run_id.clone()), Some(next.borrow().clone()));
        // Its prompt and wait are left alone.
        assert_eq!(prompt_status(&state, "b1"), "pending");
        assert_eq!(t.agent_wait.map(|w| w.run_id), Some(next.borrow().clone()));

        // Started before the last one's end is handled at all (a stop, then a message): the
        // last one's prompt expires, the next one's doesn't.
        let (state, task, run) = running(false);
        ask(&state, &task.id, &run.id, "a2");
        state.runs.lock().unwrap().remove(&task.id);
        let next = start_next(&state, &task.id, "b2");
        finish(&state, &run.id, Outcome::Cancelled);
        let t = reload(&state, &task.id);
        assert_eq!((t.running, t.status.as_str()), (true, "in_progress"));
        assert_eq!((prompt_status(&state, "a2").as_str(), prompt_status(&state, "b2").as_str()), ("expired", "pending"));
        assert_eq!(t.agent_wait.map(|w| w.run_id), Some(next.clone()));
        // Its own end clears them.
        finish(&state, &next, Outcome::Ok);
        let t = reload(&state, &task.id);
        assert_eq!((t.running, prompt_status(&state, "b2").as_str(), t.agent_wait), (false, "expired", None));
    })
}

#[test]
fn a_reviewer_that_exits_late_doesnt_end_the_next_round() {
    crate::testing::run(async || {
        let (s, thread, run) = running(false);
        let dir = crate::testing::temp_dir();
        let git = |args: &[&str]| assert!(std::process::Command::new("git").arg("-C").arg(&dir).args(args).status().unwrap().success());
        git(&["init", "-q"]);
        git(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "work"]);
        let path = crate::util::path_str(&dir);
        let np = db::NewProject { id: "pr", profile_id: &thread.profile_id, name: "x", key: "X", repo_path: &path, scratch_path: &path, worktrees_root: &path, base_branch: None, use_worktrees: true };
        db::insert_project(&s.db(), np).unwrap();
        let t = db::NewTask { profile_id: &thread.profile_id, project_id: Some("pr"), kind: "task", title: "parent", description: "", status: "in_review", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let parent = db::insert_task(&s.db(), t).unwrap();
        s.update_task(&parent.id, &[("worktree_path", json!(path)), ("worktree_state", json!("ready")), ("branch", json!("ia/x"))]).unwrap();
        s.db().execute("UPDATE tasks SET kind='review', parent_id=?1, project_id='pr' WHERE id=?2", [&parent.id, &thread.id]).unwrap();
        s.db().execute("UPDATE runs SET kind='review' WHERE id=?1", [&run.id]).unwrap();
        // A round from before reviewers' runs were kept.
        let part = db::ReviewerRun { thread_id: thread.id.clone(), state: "running".into(), ..Default::default() };
        let old = db::Review { thread_id: thread.id.clone(), state: "running".into(), reviewers: vec![part], ..Default::default() };
        s.update_task(&parent.id, &[("review", json!(old))]).unwrap();
        // The user stops it and starts another as soon as the reviewer's handle goes, before its end is recorded.
        crate::review::stop(&s, &parent.id);
        crate::testing::when("finish:released", {
            let (s, parent) = (s.clone(), parent.clone());
            move || {
                crate::testing::run(async move || {
                    runs::TEST_CAN_RUN.set(true);
                    crate::review::start(&s, &parent.id, true).await.map_err(|e| e.1).unwrap().unwrap();
                })
            }
        });
        finish(&s, &run.id, Outcome::Cancelled);
        let newer = s.runs.lock().unwrap().get(&thread.id).unwrap().run_id.clone();
        assert_ne!(newer, run.id);
        let r = reload(&s, &parent.id).review.unwrap();
        assert_eq!((r.state.as_str(), r.reviewers[0].state.as_str(), r.reviewers[0].after_run.as_deref()), ("running", "running", Some(run.id.as_str())));
        // Its own end does.
        finish(&s, &newer, Outcome::Cancelled);
        assert_eq!(reload(&s, &parent.id).review.unwrap().state, "stopped");
        std::fs::remove_dir_all(&dir).unwrap();
    });
}

#[test]
fn a_message_queued_as_a_run_ends_is_sent_after_a_restart() {
    crate::testing::run(async || {
        runs::TEST_CAN_RUN.set(true);
        let (state, task, run) = running(false);
        state.update_task(&task.id, &[("steerable", json!(false))]).unwrap();
        send(&state, &task.id, "and then this").unwrap();
        // The server stops once the run is recorded as ended, before the message is sent.
        crate::testing::when("finish:exited", || panic!("the server stopped"));
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| finish(&state, &run.id, Outcome::Ok))).is_err());
        assert_eq!(reload(&state, &task.id).queued_message.as_deref(), Some("and then this"));
        load_active(&state).unwrap();
        let t = reload(&state, &task.id);
        assert!(state.is_running(&task.id));
        assert_eq!((t.running, t.queued_message, t.status.as_str()), (true, None, "in_progress"));
    });
}

#[test]
fn a_run_that_cant_start_as_the_last_one_ends_leaves_the_task_idle() {
    crate::testing::run(async || {
        runs::TEST_CAN_RUN.set(true);
        // The next run is registered once the last one's handle is gone, but can't be marked running.
        let fail_next = |state: &Shared, task: &Task| {
            let (state, task) = (state.clone(), task.clone());
            move || {
                state.db().execute_batch("CREATE TRIGGER no_start BEFORE UPDATE OF running ON tasks WHEN NEW.running=1 BEGIN SELECT RAISE(ABORT, 'disk full'); END").unwrap();
                assert!(send(&state, &task.id, "next").unwrap_err().1.contains("disk full"));
                state.db().execute_batch("DROP TRIGGER no_start").unwrap();
            }
        };
        let (state, task, run) = running(false);
        crate::testing::when("finish:released", fail_next(&state, &task));
        finish(&state, &run.id, Outcome::Ok);
        let t = reload(&state, &task.id);
        // (Its sender hears that it failed.)
        assert_eq!((t.running, t.status.as_str()), (false, "in_review"));
        assert!(!state.is_running(&task.id));
        // Or once the last one has ended, leaving its end to the next.
        let (state, task, run) = running(false);
        let next = std::rc::Rc::new(std::cell::RefCell::new(None));
        crate::testing::when("finish:released", {
            let (state, task, next) = (state.clone(), task.clone(), next.clone());
            move || {
                let b = db::insert_run(&state.db(), &task.id, "prompt").unwrap();
                state.runs.lock().unwrap().insert(task.id.clone(), RunHandle { run_id: b.id.clone(), cancel: None });
                *next.borrow_mut() = Some(b);
            }
        });
        finish(&state, &run.id, Outcome::Ok);
        assert!(reload(&state, &task.id).running);
        abandon(&state, &next.borrow().clone().unwrap(), None);
        assert!(!reload(&state, &task.id).running);
        assert!(!state.is_running(&task.id));
    });
}

#[test]
fn a_queued_message_another_run_sent_isnt_sent_again() {
    crate::testing::run(async || {
        runs::TEST_CAN_RUN.set(true);
        let (s, task, a) = running(false);
        send(&s, &task.id, "queued").unwrap();
        // Once A's handle goes, another message starts B with what's queued, and B ends, before A carries on.
        crate::testing::when("finish:released", {
            let (s, task) = (s.clone(), task.clone());
            move || {
                send(&s, &task.id, "and this").unwrap();
                let b = s.runs.lock().unwrap().get(&task.id).unwrap().run_id.clone();
                finish(&s, &b, Outcome::Ok);
            }
        });
        finish(&s, &a.id, Outcome::Ok);
        let t = reload(&s, &task.id);
        let count: i64 = s.db().query_row("SELECT COUNT(*) FROM runs WHERE task_id=?1", [&task.id], |r| r.get(0)).unwrap();
        assert_eq!((t.running, t.status.as_str(), t.queued_message, count), (false, "in_review", None, 2));
        assert!(!s.is_running(&task.id));
        let events: i64 = s.db().query_row("SELECT COUNT(*) FROM messages WHERE task_id=?1 AND data LIKE '%queued message%'", [&task.id], |r| r.get(0)).unwrap();
        assert_eq!(events, 0);
    });
}

#[test]
fn an_agent_that_starts_late_is_stopped_after_a_restart() {
    use std::os::unix::process::CommandExt;
    let (tx, rx) = std::sync::mpsc::channel();
    crate::testing::run(async move || {
        let (s, _, run) = running(true);
        std::fs::write(runs::run_dir(&s, &run.id).join("spec.json"), "{}").unwrap();
        launch_ended(&s, &run, Err(anyhow!("the agent didn't start in time")));
        tx.send((s, run)).unwrap();
    });
    // The server stops (with its watch for the agent), and ia-shim starts the agent once it's back.
    let (s, run) = rx.recv().unwrap();
    crate::testing::run(async move || {
        load_active(&s).unwrap();
        let mut agent = std::process::Command::new("sleep").arg("30").process_group(0).spawn().unwrap();
        std::fs::write(runs::run_dir(&s, &run.id).join("pid"), agent.id().to_string()).unwrap();
        let since = std::time::Instant::now();
        while agent.try_wait().unwrap().is_none() && since.elapsed() < std::time::Duration::from_secs(3) {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let stopped = agent.try_wait().unwrap().is_some();
        if !stopped {
            unsafe { libc::kill(-(agent.id() as i32), libc::SIGKILL) };
            agent.wait().unwrap();
        }
        assert!(stopped, "the agent was left running");
        assert!(input_closed(&s, &run));
        // Done with it: a later restart doesn't watch it again.
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(!runs::run_dir(&s, &run.id).join("reap").exists());
    });
}

#[test]
fn an_agent_being_stopped_is_killed_after_a_restart() {
    use std::os::unix::process::CommandExt;
    let (tx, rx) = std::sync::mpsc::channel();
    crate::testing::run(async move || {
        let (s, _, run) = running(true);
        let dir = runs::run_dir(&s, &run.id);
        std::fs::write(dir.join("spec.json"), "{}").unwrap();
        launch_ended(&s, &run, Err(anyhow!("the agent didn't start in time")));
        // The agent starts late, and ignores being asked to stop.
        let ready = dir.join("ready");
        let script = "import signal, sys, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); open(sys.argv[1], 'w').close(); time.sleep(30)";
        let agent = std::process::Command::new("python3").args(["-c", script]).arg(&ready).process_group(0).spawn().unwrap();
        let since = std::time::Instant::now();
        while !ready.exists() && since.elapsed() < std::time::Duration::from_secs(3) {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        std::fs::write(dir.join("pid"), agent.id().to_string()).unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert!(dir.join("reap").exists());
        tx.send((s, run, agent)).unwrap();
    });
    // The server stops before killing it.
    let (s, run, mut agent) = rx.recv().unwrap();
    crate::testing::run(async move || {
        assert!(agent.try_wait().unwrap().is_none());
        load_active(&s).unwrap();
        let since = std::time::Instant::now();
        while agent.try_wait().unwrap().is_none() && since.elapsed() < std::time::Duration::from_secs(5) {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let stopped = agent.try_wait().unwrap().is_some();
        if !stopped {
            unsafe { libc::kill(-(agent.id() as i32), libc::SIGKILL) };
            agent.wait().unwrap();
        }
        assert!(stopped, "the agent was left running");
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert!(!runs::run_dir(&s, &run.id).join("reap").exists());
    });
}

#[test]
fn a_queued_message_taken_back_as_its_run_ends_doesnt_wait_for_dependencies() {
    crate::testing::run(async || {
        runs::TEST_CAN_RUN.set(true);
        let (s, task, run) = running(false);
        let np = db::NewProject { id: "pr", profile_id: &task.profile_id, name: "x", key: "X", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
        db::insert_project(&s.db(), np).unwrap();
        let nt = db::NewTask { profile_id: &task.profile_id, project_id: Some("pr"), kind: "task", title: "dependency", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let dependency = db::insert_task(&s.db(), nt).unwrap();
        s.db().execute("UPDATE tasks SET project_id='pr' WHERE id=?1", [&task.id]).unwrap();
        s.update_task(&task.id, &[("depends_on", json!([dependency.id]))]).unwrap();
        send(&s, &task.id, "queued").unwrap();
        // The user takes the message back as the run ends.
        crate::testing::when("finish:released", {
            let (s, task) = (s.clone(), task.clone());
            move || {
                unqueue(&s, &task.id).unwrap();
            }
        });
        finish(&s, &run.id, Outcome::Ok);
        let t = reload(&s, &task.id);
        assert_eq!((t.waiting, t.running, t.status.as_str(), t.queued_message), (false, false, "in_review", None));
        // Nothing starts once the dependency is merged.
        s.update_task(&dependency.id, &[("status", json!("done"))]).unwrap();
        start_unblocked(&s, Some("pr"));
        let count: i64 = s.db().query_row("SELECT COUNT(*) FROM runs WHERE task_id=?1", [&task.id], |r| r.get(0)).unwrap();
        assert_eq!(count, 1);
        assert!(!s.is_running(&task.id));
    });
}

#[test]
fn an_agent_launched_just_before_a_restart_is_stopped() {
    crate::testing::run(async || {
        use std::os::unix::process::CommandExt;
        // ia-shim was launched as the server stopped, and hasn't written its output yet.
        let (s, task, run) = running(true);
        let dir = runs::run_dir(&s, &run.id);
        std::fs::remove_file(dir.join("out.jsonl")).unwrap();
        std::fs::write(dir.join("spec.json"), "{}").unwrap();
        s.runs.lock().unwrap().clear();
        load_active(&s).unwrap();
        let t = reload(&s, &task.id);
        assert_eq!((t.running, t.status.as_str()), (false, "needs_attention"));
        assert!(input_closed(&s, &run));
        // Then it starts the agent.
        let mut agent = std::process::Command::new("sleep").arg("30").process_group(0).spawn().unwrap();
        std::fs::write(dir.join("pid"), agent.id().to_string()).unwrap();
        let since = std::time::Instant::now();
        while agent.try_wait().unwrap().is_none() && since.elapsed() < std::time::Duration::from_secs(3) {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let stopped = agent.try_wait().unwrap().is_some();
        if !stopped {
            unsafe { libc::kill(-(agent.id() as i32), libc::SIGKILL) };
            agent.wait().unwrap();
        }
        assert!(stopped, "the agent was left running");
    });
}

#[test]
fn a_run_that_cant_be_recorded_isnt_left_running() {
    crate::testing::run(async || {
        runs::TEST_CAN_RUN.set(true);
        let state = crate::testing::state();
        let p = db::insert_profile(&state.db(), "p", &[], None).unwrap();
        let t = db::NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "t", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let task = db::insert_task(&state.db(), t).unwrap();
        let active = |id: &str| state.db().query_row("SELECT COUNT(*) FROM runs WHERE task_id=?1 AND status != 'exited'", [id], |r| r.get::<_, i64>(0)).unwrap();
        db::queue(&state.db(), &task.id, db::Queued::new("queued", false)).unwrap();
        let err = start_run(&state, &task.id, db::Queued::new("go", false), "prompt", Take::Ahead, |_, _, _| Err(anyhow!("disk full"))).unwrap_err();
        assert!(err.1.contains("disk full"), "{}", err.1);
        assert!(!state.is_running(&task.id));
        assert_eq!(active(&task.id), 0);
        let t = reload(&state, &task.id);
        assert_eq!((t.running, t.queued_message.as_deref()), (false, Some("queued")));
        // Deleted meanwhile: an error, not a panic, and nothing left behind.
        let err = start_run(&state, &task.id, db::Queued::new("go", false), "prompt", Take::Ahead, |c, t, _| {
            c.execute("DELETE FROM tasks WHERE id=?1", [&t.id])?;
            Ok(Vec::new())
        })
        .unwrap_err();
        assert_eq!(err.0, axum::http::StatusCode::NOT_FOUND);
        assert!(!state.is_running(&task.id));
        runs::TEST_CAN_RUN.set(false);
    })
}

#[test]
fn a_queued_message_survives_a_crash_as_its_run_ends() {
    crate::testing::run(async || {
        let (state, task, run) = running(false);
        state.update_task(&task.id, &[("steerable", json!(false))]).unwrap();
        send(&state, &task.id, "and then this").unwrap();
        assert_eq!(reload(&state, &task.id).queued_message.as_deref(), Some("and then this"));
        // The server goes down (a crash, or a restart's exec) as the run ends.
        crate::testing::when("finish:released", || panic!("the server stopped"));
        let crashed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| finish(&state, &run.id, Outcome::Ok)));
        assert!(crashed.is_err());
        assert_eq!(reload(&state, &task.id).queued_message.as_deref(), Some("and then this"));
    })
}

#[test]
fn a_launch_that_fails_leaves_no_agent_behind() {
    crate::testing::run(async || {
        use std::os::unix::process::CommandExt;
        for outcome in [Err(anyhow!("the run did not start within 5s")), Ok(false)] {
            let stopped = outcome.is_ok();
            let (state, task, run) = running(true);
            let dir = runs::run_dir(&state, &run.id);
            std::fs::write(dir.join("spec.json"), "{}").unwrap();
            // Given up on (or stopped) before ia-shim had started the agent, which it does after.
            launch_ended(&state, &run, outcome);
            assert!(input_closed(&state, &run), "an agent that reads its input as it works isn't left waiting for more");
            let mut agent = std::process::Command::new("sleep").arg("30").process_group(0).spawn().unwrap();
            std::fs::write(dir.join("pid"), agent.id().to_string()).unwrap();
            let since = std::time::Instant::now();
            while agent.try_wait().unwrap().is_none() {
                assert!(since.elapsed() < std::time::Duration::from_secs(3), "the agent was left running");
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            let t = reload(&state, &task.id);
            assert!(!state.is_running(&task.id) && !t.running);
            assert_eq!(t.attention_reason.as_deref().map(|r| r.starts_with(if stopped { "Stopped" } else { "Run failed" })), Some(true));
        }
    })
}

/// A profile with a config (and a second if `two`), set to `limit_wait`/`limit_switch`, and a task on the first.
fn out_of_usage_setup(state: &Shared, agent: &str, wait: bool, switch: bool, two: bool) -> (Task, Vec<db::ClaudeConfig>) {
    let c = state.db();
    let mut configs = vec![db::insert_claude_config(&c, "Max", "/tmp/ia-max", agent).unwrap()];
    if two {
        configs.push(db::insert_claude_config(&c, "Spare", "/tmp/ia-spare", agent).unwrap());
    }
    let ids: Vec<String> = configs.iter().map(|c| c.id.clone()).collect();
    let p = db::insert_profile(&c, "p", &ids, None).unwrap();
    db::update_profile(&c, &p.id, &[("limit_wait", json!(wait)), ("limit_switch", json!(switch))]).unwrap();
    let t = db::NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "t", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: Some(&configs[0].id) };
    (db::insert_task(&c, t).unwrap(), configs)
}

/// What Claude Code prints when a turn is refused for the usage limit (from a real run).
fn refused_lines(resets: i64) -> Vec<Value> {
    let info = json!({"status": "rejected", "resetsAt": resets, "rateLimitType": "five_hour", "overageStatus": "rejected", "isUsingOverage": false});
    let mut event = json!({"type": "rate_limit_event", "rate_limit_info": info.clone()});
    event["rate_limit_info"]["unifiedWindows"] = json!({"five_hour": {"utilization": 1, "resetsAt": resets, "status": "rejected"}, "seven_day": {"utilization": 0.87, "resetsAt": resets + 86400, "status": "allowed_warning"}});
    let text = "You've hit your 5-hour limit · resets 6:30pm (Pacific/Auckland)";
    vec![
        event,
        json!({"type": "assistant", "message": {"model": "<synthetic>", "role": "assistant", "content": [{"type": "text", "text": text}]}, "parent_tool_use_id": null,
            "error": "rate_limit", "api_error_status": 429, "api_error": "usage_limit_reached", "api_error_params": {"rate_limit_info": info}}),
        json!({"type": "result", "subtype": "success", "is_error": true, "api_error_status": 429, "api_error": "usage_limit_reached", "result": text, "session_id": "s1", "num_turns": 2, "total_cost_usd": 0.1}),
    ]
}

/// A run of `task` that's refused for its usage limit, which resets at `resets`, and ends.
fn run_out(state: &Shared, task: &Task, resets: i64) {
    let run = db::insert_run(&state.db(), &task.id, "prompt").unwrap();
    state.runs.lock().unwrap().insert(task.id.clone(), RunHandle { run_id: run.id.clone(), cancel: None });
    state.update_task(&task.id, &[("running", json!(true)), ("status", json!("in_progress"))]).unwrap();
    for line in refused_lines(resets) {
        handle_line(state, &run, &line.to_string()).unwrap();
    }
    on_exit(state, &run.id, Some(0), None, None, "");
}

fn reset_in(hours: i64) -> (i64, String) {
    let t = chrono::Utc::now().timestamp() + hours * 3600;
    (t, chrono::DateTime::from_timestamp(t, 0).unwrap().to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

#[test]
fn a_run_out_of_usage_waits_for_the_reset_and_carries_on() {
    crate::testing::run(async || {
        let state = crate::testing::state();
        let (task, configs) = out_of_usage_setup(&state, "claude", true, false, false);
        let (resets, at) = reset_in(2);
        run_out(&state, &task, resets);
        let get = || db::get_task(&state.db(), &task.id).unwrap().unwrap();
        let t = get();
        assert_eq!((t.status.as_str(), t.waiting, t.running, t.attention_reason), ("in_progress", true, false, None));
        assert_eq!(t.limit_reset_at.as_deref(), Some(at.as_str()));
        assert_eq!(crate::usage::out_until(&state, &configs[0].id).as_deref(), Some(at.as_str()));

        // Not before the reset.
        crate::runs::TEST_CAN_RUN.set(true);
        start_unblocked(&state, None);
        assert!(get().waiting && !state.is_running(&task.id));

        // Once it's reset, the agent carries on.
        let past = chrono::DateTime::from_timestamp(resets - 3 * 3600, 0).unwrap().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        state.update_task(&task.id, &[("limit_reset_at", json!(past))]).unwrap();
        state.usage.lock().unwrap().get_mut(&configs[0].id).unwrap().out_until = Some(past);
        start_unblocked(&state, None);
        crate::runs::TEST_CAN_RUN.set(false);
        let t = get();
        assert!(state.is_running(&task.id));
        assert_eq!((t.waiting, t.limit_reset_at, t.status.as_str()), (false, None, "in_progress"));
        let last = db::list_messages(&state.db(), &task.id).unwrap().into_iter().filter(|m| m.kind == "user").last().unwrap();
        assert!(last.data["text"].as_str().unwrap().contains("has reset"), "{}", last.data);
        stop(&state, &task.id);
    })
}

#[test]
fn a_run_out_of_usage_offers_to_wait_and_keeps_its_queued_message() {
    crate::testing::run(async || {
        let state = crate::testing::state();
        let (task, _) = out_of_usage_setup(&state, "claude", false, false, false);
        let (resets, at) = reset_in(2);
        db::queue(&state.db(), &task.id, db::Queued::new("And then this", false)).unwrap();
        run_out(&state, &task, resets);
        let get = || db::get_task(&state.db(), &task.id).unwrap().unwrap();
        let t = get();
        assert_eq!((t.status.as_str(), t.waiting, t.running), ("needs_attention", false, false));
        assert_eq!(t.attention_reason.as_deref(), Some("You've hit your 5-hour limit · resets 6:30pm (Pacific/Auckland)"));
        assert_eq!(t.limit_reset_at.as_deref(), Some(at.as_str()));
        // It would only be refused too, so it isn't sent.
        assert_eq!(t.queued_message.as_deref(), Some("And then this"));
        assert!(!state.is_running(&task.id));

        // Asked to, it waits for the reset.
        let axum::Json(v) = crate::usage::wait_for_reset(axum::extract::State(state.clone()), axum::extract::Path(task.id.clone())).await.unwrap();
        assert_eq!((&v["status"], &v["waiting"], &v["limit_reset_at"]), (&json!("in_progress"), &json!(true), &json!(at)));

        // A run that fails for something else leaves nothing to wait for.
        let (other, _) = {
            let c = state.db();
            let p = db::insert_profile(&c, "q", &[], None).unwrap();
            let t = db::NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "t", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
            (db::insert_task(&c, t).unwrap(), p)
        };
        let run = db::insert_run(&state.db(), &other.id, "prompt").unwrap();
        on_exit(&state, &run.id, Some(1), None, None, "boom");
        let o = db::get_task(&state.db(), &other.id).unwrap().unwrap();
        assert_eq!((o.status.as_str(), o.limit_reset_at), ("needs_attention", None));
        assert!(crate::usage::wait_for_reset(axum::extract::State(state.clone()), axum::extract::Path(other.id.clone())).await.is_err());
    })
}

#[test]
fn a_task_started_on_a_config_out_of_usage_waits_or_moves_to_one_with_room() {
    crate::testing::run(async || {
        let state = crate::testing::state();
        let (resets, at) = reset_in(1);
        let refused = json!({"type": "rate_limit_event", "rate_limit_info": {"status": "rejected", "resetsAt": resets}});

        // Waiting: it's queued, message and all, until the reset.
        let (task, configs) = out_of_usage_setup(&state, "claude", true, false, true);
        crate::usage::on_rate_limit_event(&state, &configs[0].id, &refused);
        crate::runs::TEST_CAN_RUN.set(true);
        let t = send(&state, &task.id, "Go").unwrap();
        assert_eq!((t.status.as_str(), t.waiting, t.limit_reset_at.as_deref(), t.queued_message.as_deref()), ("in_progress", true, Some(at.as_str()), Some("Go")));
        assert!(!state.is_running(&task.id));
        // Another message joins the queue rather than starting it.
        let t = send(&state, &task.id, "And this").unwrap();
        assert!(t.waiting && !state.is_running(&task.id));

        // Switching: a task that hasn't started moves to the next config with room.
        let state = crate::testing::state();
        let (task, configs) = out_of_usage_setup(&state, "claude", true, true, true);
        crate::usage::on_rate_limit_event(&state, &configs[0].id, &refused);
        send(&state, &task.id, "Go").unwrap();
        let t = db::get_task(&state.db(), &task.id).unwrap().unwrap();
        assert_eq!(t.claude_config_id.as_deref(), Some(configs[1].id.as_str()));
        assert!(state.is_running(&task.id) && !t.waiting);
        stop(&state, &task.id);

        // With every config out, it waits.
        let state = crate::testing::state();
        let (task, configs) = out_of_usage_setup(&state, "claude", true, true, true);
        for c in &configs {
            crate::usage::on_rate_limit_event(&state, &c.id, &refused);
        }
        let t = send(&state, &task.id, "Go").unwrap();
        assert_eq!((t.claude_config_id.as_deref(), t.waiting), (Some(configs[0].id.as_str()), true));

        // Neither set: it runs (and is refused as before).
        let state = crate::testing::state();
        let (task, configs) = out_of_usage_setup(&state, "claude", false, false, true);
        crate::usage::on_rate_limit_event(&state, &configs[0].id, &refused);
        send(&state, &task.id, "Go").unwrap();
        assert!(state.is_running(&task.id));
        stop(&state, &task.id);
        crate::runs::TEST_CAN_RUN.set(false);
    })
}

#[test]
fn a_codex_turn_out_of_usage_waits_for_its_limits_reset() {
    crate::testing::run(async || {
        let state = crate::testing::state();
        let (task, configs) = out_of_usage_setup(&state, "codex", true, false, false);
        let (resets, at) = reset_in(3);
        let run = db::insert_run(&state.db(), &task.id, "prompt").unwrap();
        state.runs.lock().unwrap().insert(task.id.clone(), RunHandle { run_id: run.id.clone(), cancel: None });
        state.update_task(&task.id, &[("running", json!(true)), ("status", json!("in_progress"))]).unwrap();
        let line = |method: &str, params: Value| handle_line(&state, &run, &json!({"method": method, "params": params}).to_string()).unwrap();
        line("thread/started", json!({"thread": {"id": "main"}}));
        line("account/rateLimits/updated", json!({"rateLimits": {"primary": {"usedPercent": 100, "resetsAt": resets}, "secondary": {"usedPercent": 40, "resetsAt": resets + 86400}}}));
        let error = json!({"message": "You've hit your usage limit.", "codexErrorInfo": "usageLimitExceeded"});
        line("turn/completed", json!({"threadId": "main", "turn": {"id": "t1", "status": "failed", "error": error, "items": []}}));
        on_exit(&state, &run.id, Some(0), None, None, "");
        let t = db::get_task(&state.db(), &task.id).unwrap().unwrap();
        assert_eq!((t.status.as_str(), t.waiting, t.limit_reset_at.as_deref()), ("in_progress", true, Some(at.as_str())));
        assert_eq!(crate::usage::out_until(&state, &configs[0].id).as_deref(), Some(at.as_str()));
    })
}

#[test]
fn a_message_to_a_task_waiting_for_its_reset_is_queued() {
    crate::testing::run(async || {
        crate::runs::TEST_CAN_RUN.set(true);
        let get = |state: &Shared, id: &str| db::get_task(&state.db(), id).unwrap().unwrap();
        // Asked to wait, with neither setting on.
        let state = crate::testing::state();
        let (task, _) = out_of_usage_setup(&state, "claude", false, false, false);
        let (resets, at) = reset_in(2);
        run_out(&state, &task, resets);
        let _ = crate::usage::wait_for_reset(axum::extract::State(state.clone()), axum::extract::Path(task.id.clone())).await.unwrap();
        let t = send(&state, &task.id, "x").unwrap();
        assert!(!state.is_running(&task.id));
        assert_eq!((t.waiting, t.limit_reset_at.as_deref(), t.queued_message.as_deref()), (true, Some(at.as_str()), Some("x")));
        // An empty send (Start) doesn't start it either.
        send_message(&state, &task.id, Some(db::Queued::new("", false)), false, "prompt", None).unwrap();
        assert!(!state.is_running(&task.id) && get(&state, &task.id).waiting);

        // Waiting by itself, after a restart forgot that the config is out.
        let state = crate::testing::state();
        let (task, _) = out_of_usage_setup(&state, "claude", true, false, false);
        run_out(&state, &task, resets);
        state.usage.lock().unwrap().clear();
        let t = send(&state, &task.id, "y").unwrap();
        assert!(!state.is_running(&task.id));
        assert_eq!((t.waiting, t.limit_reset_at.as_deref(), t.queued_message.as_deref()), (true, Some(at.as_str()), Some("y")));
        crate::runs::TEST_CAN_RUN.set(false);
    })
}

#[test]
fn a_task_waiting_for_a_reset_moved_to_another_config_starts_there() {
    crate::testing::run(async || {
        crate::runs::TEST_CAN_RUN.set(true);
        let (resets, _) = reset_in(2);
        let refused = json!({"type": "rate_limit_event", "rate_limit_info": {"status": "rejected", "resetsAt": resets}});
        let state = crate::testing::state();
        let (task, configs) = out_of_usage_setup(&state, "claude", true, false, true);
        crate::usage::on_rate_limit_event(&state, &configs[0].id, &refused);
        assert!(send(&state, &task.id, "Go").unwrap().waiting);
        let b = serde_json::Map::from_iter([("claude_config_id".to_string(), json!(configs[1].id))]);
        crate::api::update_task_inner(&state, &task.id, &b).await.unwrap();
        let t = db::get_task(&state.db(), &task.id).unwrap().unwrap();
        assert!(state.is_running(&task.id));
        assert_eq!((t.waiting, t.limit_reset_at, t.claude_config_id.as_deref(), t.queued_message), (false, None, Some(configs[1].id.as_str()), None));
        stop(&state, &task.id);

        // Moved to another config that's out too: it waits for that one's reset.
        let (later, at) = reset_in(3);
        let state = crate::testing::state();
        let (task, configs) = out_of_usage_setup(&state, "claude", true, false, true);
        crate::usage::on_rate_limit_event(&state, &configs[0].id, &refused);
        crate::usage::on_rate_limit_event(&state, &configs[1].id, &json!({"rate_limit_info": {"status": "rejected", "resetsAt": later}}));
        send(&state, &task.id, "Go").unwrap();
        let b = serde_json::Map::from_iter([("claude_config_id".to_string(), json!(configs[1].id))]);
        crate::api::update_task_inner(&state, &task.id, &b).await.unwrap();
        let t = db::get_task(&state.db(), &task.id).unwrap().unwrap();
        assert!(!state.is_running(&task.id));
        assert_eq!((t.waiting, t.limit_reset_at.as_deref(), t.queued_message.as_deref()), (true, Some(at.as_str()), Some("Go")));
        crate::runs::TEST_CAN_RUN.set(false);
    })
}

#[test]
fn a_config_on_extra_usage_isnt_out() {
    crate::testing::run(async || {
        crate::runs::TEST_CAN_RUN.set(true);
        let state = crate::testing::state();
        let (task, configs) = out_of_usage_setup(&state, "claude", true, true, true);
        // What a plan with extra usage reports on every turn past its limit, while the turns go on.
        let (resets, _) = reset_in(2);
        let info = json!({"status": "rejected", "resetsAt": resets, "rateLimitType": "five_hour", "overageStatus": "allowed", "isUsingOverage": true,
            "unifiedWindows": {"five_hour": {"utilization": 1, "resetsAt": resets, "status": "rejected"}}});
        crate::usage::on_rate_limit_event(&state, &configs[0].id, &json!({"type": "rate_limit_event", "rate_limit_info": info}));
        assert_eq!(crate::usage::out_until(&state, &configs[0].id), None);
        let t = send(&state, &task.id, "Go").unwrap();
        assert!(state.is_running(&task.id));
        assert_eq!((t.waiting, t.claude_config_id.as_deref()), (false, Some(configs[0].id.as_str())), "neither held nor moved");
        stop(&state, &task.id);
        crate::runs::TEST_CAN_RUN.set(false);
    })
}

#[test]
fn a_merge_out_of_usage_keeps_its_place_in_the_merge_queue() {
    crate::testing::run(async || {
        let state = crate::testing::state();
        let (task, _) = out_of_usage_setup(&state, "claude", false, false, false);
        let np = db::NewProject { id: "pr", profile_id: &task.profile_id, name: "x", key: "X", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
        db::insert_project(&state.db(), np).unwrap();
        state.db().execute("UPDATE tasks SET project_id='pr' WHERE id=?1", [&task.id]).unwrap();
        // Its merge run is refused for the usage limit.
        let (resets, _) = reset_in(2);
        let run = db::insert_run(&state.db(), &task.id, "prompt").unwrap();
        state.runs.lock().unwrap().insert(task.id.clone(), RunHandle { run_id: run.id.clone(), cancel: None });
        state.update_task(&task.id, &[("running", json!(true)), ("status", json!("ready_for_merge")), ("merging", json!(true))]).unwrap();
        for line in refused_lines(resets) {
            handle_line(&state, &run, &line.to_string()).unwrap();
        }
        on_exit(&state, &run.id, Some(0), None, None, "");
        let t = db::get_task(&state.db(), &task.id).unwrap().unwrap();
        assert_eq!((t.status.as_str(), t.merging, t.waiting), ("needs_attention", true, false));
        assert!(t.limit_reset_at.is_some());

        // It can't wait out of the merge queue, where another merge could take its slot.
        let err = crate::usage::wait_for_reset(axum::extract::State(state.clone()), axum::extract::Path(task.id.clone())).await.unwrap_err();
        assert!(err.1.contains("merge"), "{}", err.1);
        let t = db::get_task(&state.db(), &task.id).unwrap().unwrap();
        assert_eq!((t.status.as_str(), t.merging, t.waiting), ("needs_attention", true, false));
        assert_eq!(db::active_merge(&state.db(), Some("pr"), None).unwrap().map(|m| m.id), Some(task.id.clone()), "it still holds the merge slot");
    })
}
