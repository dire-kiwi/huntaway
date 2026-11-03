use super::*;
use crate::agent::runner;

/// A task (in the profile's default config, or `config`'s), and a run of it that's going (so a message sent to it is
/// queued for it, as no agent reads its input).
fn running_task(s: &Shared, config: Option<&str>) -> (Task, db::Run) {
    let ids: Vec<String> = config.into_iter().map(String::from).collect();
    let profile = db::insert_profile(&s.db(), &format!("p{}", new_id()), &ids, None).unwrap();
    let t = db::NewTask {
        profile_id: &profile.id,
        project_id: None,
        kind: "task",
        title: "t",
        description: "",
        status: "in_progress",
        use_worktree: false,
        model: None,
        effort: None,
        claude_config_id: config,
    };
    let task = db::insert_task(&s.db(), t).unwrap();
    let run = db::insert_run(&s.db(), &task.id, "prompt").unwrap();
    s.db().execute("UPDATE runs SET status='running' WHERE id=?1", [&run.id]).unwrap();
    s.runs.lock().unwrap().insert(task.id.clone(), crate::state::RunHandle { run_id: run.id.clone(), cancel: None });
    let task = s.update_task(&task.id, &[("running", json!(true))]).unwrap().unwrap();
    (task, run)
}

/// Raise a prompt for `tool` from `task` (as MCP call `call_id`) and wait until it's asked. Returns its request id
/// and what the agent is told once it's answered.
async fn asked(s: &Shared, task: &Task, call_id: &str, tool: &str, input: Value) -> (String, tokio::task::JoinHandle<Value>) {
    let (s2, t2, call, tool2) = (s.clone(), task.clone(), call_id.to_string(), tool.to_string());
    let answer = tokio::spawn(async move { prompt(&s2, &t2, &call, &tool2, &input, None).await.unwrap() });
    loop {
        let id: Option<String> = s.db().query_row("SELECT id FROM permission_requests WHERE call_id=?1", [call_id], |r| r.get(0)).ok();
        if let Some(id) = id {
            return (id, answer);
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
}

fn prompt_message(s: &Shared, id: &str) -> Value {
    let mid: i64 = s.db().query_row("SELECT message_id FROM permission_requests WHERE id=?1", [id], |r| r.get(0)).unwrap();
    s.db().query_row("SELECT data FROM messages WHERE id=?1", [mid], |r| r.get::<_, String>(0)).map(|d| serde_json::from_str(&d).unwrap()).unwrap()
}

fn two_questions() -> Value {
    json!({"questions": [
        {"question": "Which season?", "header": "Season", "multiSelect": false, "options": [{"label": "Summer", "description": "Warm"}, {"label": "Winter"}]},
        {"question": "Which pets?", "header": "Pets", "multiSelect": true, "options": [{"label": "Cats"}, {"label": "Dogs"}, {"label": "Birds"}]}
    ]})
}

fn answers(a: Vec<Vec<&str>>) -> Reply {
    Reply { answers: Some(a.into_iter().map(|q| q.into_iter().map(String::from).collect()).collect()), ..Default::default() }
}

#[test]
fn answers_to_claudes_questions_go_back_as_its_tool_takes_them() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (task, _) = running_task(&s, None);
        let input = two_questions();
        let (id, told) = asked(&s, &task, "c1", ASK_USER, input.clone()).await;
        // The task says what it's waiting for: a question, not a permission.
        let t = db::get_task(&s.db(), &task.id).unwrap().unwrap();
        assert_eq!((t.status.as_str(), t.attention_reason.as_deref()), ("needs_attention", Some("Which season? (and 1 more question)")));
        // Answers are checked against the questions.
        assert_eq!(answer(&s, &id, true, false, None, answers(vec![vec!["Summer"]])).unwrap_err().0, axum::http::StatusCode::BAD_REQUEST);
        assert_eq!(answer(&s, &id, true, false, None, answers(vec![vec!["Summer", "Winter"], vec![]])).unwrap_err().0, axum::http::StatusCode::BAD_REQUEST);

        assert_eq!(answer(&s, &id, true, false, None, answers(vec![vec![" Summer "], vec!["Cats", "Birds", "a lizard"]])).unwrap(), "allowed");
        let mut updated = input.clone();
        updated["answers"] = json!({"Which season?": "Summer", "Which pets?": "Cats, Birds, a lizard"});
        assert_eq!(told.await.unwrap(), json!({"behavior": "allow", "updatedInput": updated}));
        let shown = prompt_message(&s, &id);
        assert_eq!((&shown["status"], &shown["answers"]), (&json!("allowed"), &json!([["Summer"], ["Cats", "Birds", "a lizard"]])));
        let t = db::get_task(&s.db(), &task.id).unwrap().unwrap();
        assert_eq!((t.status.as_str(), t.attention_reason), ("in_progress", None));
        // Not as an always-allowed tool.
        assert!(t.auto_allow.is_empty());
    });
}

#[test]
fn answers_to_codexs_questions_go_back_by_question_id() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let codex = db::insert_claude_config(&s.db(), "Codex", "", "codex").unwrap();
        let (task, _) = running_task(&s, Some(&codex.id));
        let input = json!({"questions": [
            {"id": "name", "question": "Which name?", "options": [{"label": "a.txt", "description": ""}], "isOther": true, "isSecret": false},
            {"id": "token", "question": "Your token?", "options": [], "isOther": true, "isSecret": true},
            {"id": "skip", "question": "Anything else?", "options": [{"label": "No", "description": ""}], "isOther": false, "isSecret": false}
        ]});
        let (id, told) = asked(&s, &task, "c1", CODEX_QUESTIONS, input.clone()).await;
        // The thread says it's Codex asking.
        assert_eq!(prompt_message(&s, &id)["agent"], "codex");
        answer(&s, &id, true, true, None, answers(vec![vec!["b.txt"], vec!["s3cret"], vec![]])).unwrap();
        let told = told.await.unwrap();
        assert_eq!(told["updatedInput"]["answers"], json!({"name": {"answers": ["b.txt"]}, "token": {"answers": ["s3cret"]}}));
        // The thread doesn't show a secret.
        assert_eq!(prompt_message(&s, &id)["answers"], json!([["b.txt"], ["(hidden)"], []]));
    });
}

#[test]
fn questions_are_asked_whatever_the_threads_mode_unless_it_asks_nothing() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (task, _) = running_task(&s, None);
        let task = s.update_task(&task.id, &[("permission_mode", json!("bypassPermissions")), ("auto_allow", json!(r#"["AskUserQuestion"]"#))]).unwrap().unwrap();
        // Bypass allows a tool call, but a question is still the user's to answer.
        assert_eq!(prompt(&s, &task, "b", "Bash", &json!({"command": "ls"}), None).await.unwrap()["behavior"], "allow");
        let (id, told) = asked(&s, &task, "q", ASK_USER, two_questions()).await;
        let (bash, bash_told) = asked(&s, &s.update_task(&task.id, &[("permission_mode", json!("default"))]).unwrap().unwrap(), "b2", "Bash", json!({})).await;
        // Switching to Bypass settles the tool call, not the question.
        let t = s.update_task(&task.id, &[("permission_mode", json!("bypassPermissions"))]).unwrap().unwrap();
        apply_mode_to_pending(&s, &t).unwrap();
        assert_eq!(bash_told.await.unwrap()["behavior"], "allow");
        let status = |id: &str| s.db().query_row("SELECT status FROM permission_requests WHERE id=?1", [id], |r| r.get::<_, String>(0)).unwrap();
        assert_eq!((status(&bash), status(&id)), ("allowed".into(), "pending".into()));
        // Don't ask denies it, as it does every prompt.
        let t = s.update_task(&task.id, &[("permission_mode", json!("dontAsk"))]).unwrap().unwrap();
        apply_mode_to_pending(&s, &t).unwrap();
        assert_eq!(told.await.unwrap(), json!({"behavior": "deny", "message": DONT_ASK_DENIAL}));
        assert_eq!(prompt(&s, &t, "q2", ASK_USER, &two_questions(), None).await.unwrap()["behavior"], "deny");
    });
}

#[test]
fn only_the_first_answer_counts() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (task, _) = running_task(&s, None);
        let (id, told) = asked(&s, &task, "c1", ASK_USER, two_questions()).await;
        // Two tabs answering at once.
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let tabs: Vec<_> = [vec!["Summer"], vec!["Winter"]]
            .into_iter()
            .map(|season| {
                let (s, id, barrier) = (s.clone(), id.clone(), barrier.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    answer(&s, &id, true, false, None, answers(vec![season, vec![]]))
                })
            })
            .collect();
        let results: Vec<_> = tabs.into_iter().map(|t| t.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1, "{results:?}");
        let refused = results.iter().find_map(|r| r.as_ref().err()).unwrap();
        assert_eq!(refused.0, axum::http::StatusCode::CONFLICT);
        let given = told.await.unwrap()["updatedInput"]["answers"]["Which season?"].clone();
        assert_eq!(prompt_message(&s, &id)["answers"][0][0], given);
        // Nor can it be denied after.
        assert!(decide(&s, &id, false, false, None).is_err());
    });
}

#[test]
fn an_approved_plan_carries_on_in_the_mode_picked() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (task, _) = running_task(&s, None);
        let task = s.update_task(&task.id, &[("permission_mode", json!("plan"))]).unwrap().unwrap();
        let plan = json!({"plan": "# Plan: add a cache\n\n1. Do it", "planFilePath": "/p.md"});
        let (id, told) = asked(&s, &task, "p1", EXIT_PLAN, plan.clone()).await;
        assert_eq!(db::get_task(&s.db(), &task.id).unwrap().unwrap().attention_reason.as_deref(), Some("Plan ready for approval: add a cache"));
        // Sent back with feedback.
        let reply = Reply { feedback: Some(" Add tests too. ".into()), ..Default::default() };
        assert_eq!(answer(&s, &id, false, false, None, reply).unwrap(), "denied");
        let told = told.await.unwrap();
        assert_eq!(told["behavior"], "deny");
        assert!(told["message"].as_str().unwrap().ends_with("Their feedback:\n\nAdd tests too."), "{told}");
        assert_eq!(prompt_message(&s, &id)["feedback"], "Add tests too.");
        assert_eq!(db::get_task(&s.db(), &task.id).unwrap().unwrap().permission_mode.as_deref(), Some("plan"));

        // Approved, into Accept edits: the agent's Claude Code switches to it too.
        let (id, told) = asked(&s, &task, "p2", EXIT_PLAN, plan.clone()).await;
        let bad = Reply { mode: Some("plan".into()), ..Default::default() };
        assert_eq!(answer(&s, &id, true, false, None, bad).unwrap_err().0, axum::http::StatusCode::BAD_REQUEST);
        answer(&s, &id, true, false, None, Reply { mode: Some("acceptEdits".into()), ..Default::default() }).unwrap();
        assert_eq!(
            told.await.unwrap(),
            json!({"behavior": "allow", "updatedInput": plan, "updatedPermissions": [{"type": "setMode", "mode": "acceptEdits", "destination": "session"}]})
        );
        assert_eq!(db::get_task(&s.db(), &task.id).unwrap().unwrap().permission_mode.as_deref(), Some("acceptEdits"));
        assert_eq!(prompt_message(&s, &id)["mode"], "acceptEdits");

        // Into the thread's default (Ask): its own mode is cleared, and Claude Code goes to Ask by itself.
        let task = s.update_task(&task.id, &[("permission_mode", json!("plan"))]).unwrap().unwrap();
        let (id, told) = asked(&s, &task, "p3", EXIT_PLAN, plan.clone()).await;
        answer(&s, &id, true, false, None, Reply { mode: Some("default".into()), ..Default::default() }).unwrap();
        assert_eq!(told.await.unwrap(), json!({"behavior": "allow", "updatedInput": plan}));
        assert_eq!(db::get_task(&s.db(), &task.id).unwrap().unwrap().permission_mode, None);

        // From a UI that doesn't pick: out of Plan, as before.
        let task = s.update_task(&task.id, &[("permission_mode", json!("plan"))]).unwrap().unwrap();
        let (id, told) = asked(&s, &task, "p4", EXIT_PLAN, plan.clone()).await;
        decide(&s, &id, true, false, None).unwrap();
        assert_eq!(told.await.unwrap()["behavior"], "allow");
        assert_eq!(db::get_task(&s.db(), &task.id).unwrap().unwrap().permission_mode, None);
    });
}

#[test]
fn a_question_or_plan_whose_run_ended_is_answered_by_message() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (task, run) = running_task(&s, None);
        let (id, told) = asked(&s, &task, "c1", ASK_USER, two_questions()).await;
        let (bash, _) = asked(&s, &task, "c2", "Bash", json!({"command": "ls"})).await;
        let (plan, _) = asked(&s, &task, "c3", EXIT_PLAN, json!({"plan": "Do it"})).await;
        // Its run ended (see runner::finish).
        expire_for_task(&s, &task.id);
        assert_eq!(told.await.unwrap(), json!({"behavior": "deny", "message": EXPIRED}));
        // A tool call can't be allowed once its run has ended.
        assert_eq!(decide(&s, &bash, true, false, None).unwrap_err().0, axum::http::StatusCode::CONFLICT);

        // Without a run to take it (and no agents here to start one), the answer isn't sent, and can be given again.
        s.runs.lock().unwrap().remove(&task.id);
        assert!(answer(&s, &id, true, false, None, answers(vec![vec!["Winter"], vec!["Dogs"]])).is_err());
        assert_eq!(prompt_message(&s, &id)["status"], "expired");

        s.runs.lock().unwrap().insert(task.id.clone(), crate::state::RunHandle { run_id: run.id.clone(), cancel: None });
        assert_eq!(answer(&s, &id, true, false, None, answers(vec![vec!["Winter"], vec!["Dogs"]])).unwrap(), "allowed");
        let queued = db::get_task(&s.db(), &task.id).unwrap().unwrap().queued_message.unwrap();
        assert_eq!(queued, "My answers to the questions you asked:\n\n- Which season?\n  Winter\n- Which pets?\n  Dogs");
        let shown = prompt_message(&s, &id);
        assert_eq!((&shown["status"], &shown["late"], &shown["answers"]), (&json!("allowed"), &json!(true), &json!([["Winter"], ["Dogs"]])));
        assert!(answer(&s, &id, true, false, None, answers(vec![vec!["Summer"], vec![]])).is_err());

        // The plan, approved: out of Plan mode, with a message to carry on.
        s.update_task(&task.id, &[("permission_mode", json!("plan")), ("queued_message", Value::Null)]).unwrap();
        answer(&s, &id_of(&s, "c3"), true, false, None, Reply { mode: Some("acceptEdits".into()), ..Default::default() }).unwrap();
        let t = db::get_task(&s.db(), &task.id).unwrap().unwrap();
        assert_eq!((t.permission_mode.as_deref(), t.queued_message.as_deref()), (Some("acceptEdits"), Some("Your plan is approved: go ahead and implement it.")));
        assert_eq!(prompt_message(&s, &plan)["status"], "allowed");
    });
}

#[test]
fn a_question_or_plan_the_conversation_has_moved_past_isnt_answered() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (task, _) = running_task(&s, None);
        s.update_task(&task.id, &[("permission_mode", json!("plan"))]).unwrap();
        let (question, _) = asked(&s, &task, "c1", ASK_USER, two_questions()).await;
        let (plan, _) = asked(&s, &task, "c2", EXIT_PLAN, json!({"plan": "Do it"})).await;
        expire_for_task(&s, &task.id);
        // The user carries on in the thread (here, steering the next run).
        let m = db::insert_message(&s.db(), &task.id, "user", &json!({"text": "Never mind, do this instead"})).unwrap();
        s.emit_message(&m);

        let refused = answer(&s, &question, true, false, None, answers(vec![vec!["Summer"], vec![]])).unwrap_err();
        assert_eq!(refused.0, axum::http::StatusCode::CONFLICT, "{}", refused.1);
        let refused = answer(&s, &plan, true, false, None, Reply { mode: Some("acceptEdits".into()), ..Default::default() }).unwrap_err();
        assert_eq!(refused.0, axum::http::StatusCode::CONFLICT);
        assert!(answer(&s, &plan, false, false, None, Reply { feedback: Some("More".into()), ..Default::default() }).is_err());
        // Nothing was sent, and the thread's still planning.
        let t = db::get_task(&s.db(), &task.id).unwrap().unwrap();
        assert_eq!((t.queued_message, t.permission_mode.as_deref()), (None, Some("plan")));
        assert_eq!((prompt_message(&s, &question)["status"].clone(), prompt_message(&s, &plan)["status"].clone()), (json!("expired"), json!("expired")));
    });
}

#[test]
fn approving_a_plan_in_the_threads_own_mode_keeps_it() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (task, _) = running_task(&s, None);
        // Its own mode is Accept edits (the host's default is Ask), and the agent went into plan mode by itself.
        let task = s.update_task(&task.id, &[("permission_mode", json!("acceptEdits"))]).unwrap().unwrap();
        let plan = json!({"plan": "Do it"});
        let (id, told) = asked(&s, &task, "p1", EXIT_PLAN, plan.clone()).await;
        answer(&s, &id, true, false, None, Reply { mode: Some("acceptEdits".into()), ..Default::default() }).unwrap();
        assert_eq!(told.await.unwrap()["updatedPermissions"], json!([{"type": "setMode", "mode": "acceptEdits", "destination": "session"}]));
        assert_eq!(db::get_task(&s.db(), &task.id).unwrap().unwrap().permission_mode.as_deref(), Some("acceptEdits"));
        // Approved without a pick, as before: it's left alone too.
        let (id, _) = asked(&s, &task, "p2", EXIT_PLAN, plan.clone()).await;
        decide(&s, &id, true, false, None).unwrap();
        assert_eq!(db::get_task(&s.db(), &task.id).unwrap().unwrap().permission_mode.as_deref(), Some("acceptEdits"));
        // Picking the default is a change back to it.
        let (id, _) = asked(&s, &task, "p3", EXIT_PLAN, plan.clone()).await;
        answer(&s, &id, true, false, None, Reply { mode: Some("default".into()), ..Default::default() }).unwrap();
        assert_eq!(db::get_task(&s.db(), &task.id).unwrap().unwrap().permission_mode, None);
        // A thread set to Ask itself stays so (rather than following the host's default from now on).
        let task = s.update_task(&task.id, &[("permission_mode", json!("default"))]).unwrap().unwrap();
        let (id, _) = asked(&s, &task, "p4", EXIT_PLAN, plan).await;
        answer(&s, &id, true, false, None, Reply { mode: Some("default".into()), ..Default::default() }).unwrap();
        assert_eq!(db::get_task(&s.db(), &task.id).unwrap().unwrap().permission_mode.as_deref(), Some("default"));
    });
}

#[test]
fn a_late_approval_leaves_plan_mode_before_its_message_starts_a_run() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (task, run) = running_task(&s, None);
        s.update_task(&task.id, &[("permission_mode", json!("plan"))]).unwrap();
        let (id, _) = asked(&s, &task, "p1", EXIT_PLAN, json!({"plan": "Do it"})).await;
        s.runs.lock().unwrap().remove(&task.id);
        s.db().execute("UPDATE runs SET status='exited' WHERE id=?1", [&run.id]).unwrap();
        expire_for_task(&s, &task.id);
        s.update_task(&task.id, &[("running", json!(false))]).unwrap();

        // No agent can start: the approval isn't taken, and the thread's still planning.
        let approve = || Reply { mode: Some("auto".into()), ..Default::default() };
        assert!(answer(&s, &id, true, false, None, approve()).is_err());
        assert_eq!(db::get_task(&s.db(), &task.id).unwrap().unwrap().permission_mode.as_deref(), Some("plan"));
        assert_eq!(prompt_message(&s, &id)["status"], "expired");

        // One that starts runs with the mode picked, from the run the approval starts.
        crate::agent::runs::TEST_CAN_RUN.set(true);
        let mode = std::rc::Rc::new(std::cell::RefCell::new(None));
        crate::testing::when("run:started", {
            let (s, task_id, mode) = (s.clone(), task.id.clone(), mode.clone());
            move || *mode.borrow_mut() = db::get_task(&s.db(), &task_id).unwrap().unwrap().permission_mode
        });
        let answered = answer(&s, &id, true, false, None, approve());
        crate::agent::runs::TEST_CAN_RUN.set(false);
        answered.unwrap();
        assert_eq!(mode.borrow().as_deref(), Some("auto"));
        runner::stop(&s, &task.id);
    });
}

fn id_of(s: &Shared, call_id: &str) -> String {
    s.db().query_row("SELECT id FROM permission_requests WHERE call_id=?1", [call_id], |r| r.get(0)).unwrap()
}

#[test]
fn a_prompt_from_before_answers_were_taken_can_be_answered() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (task, _) = running_task(&s, None);
        // As an older build raised it: no agent in its message, and the MCP call retried after the upgrade finds it.
        let input = two_questions();
        let data = json!({"tool_name": ASK_USER, "input": input, "tool_use_id": null, "request_id": "old", "status": "pending"});
        let msg = s.add_message(&task.id, "permission", data).unwrap();
        s.db()
            .execute(
                "INSERT INTO permission_requests (id,task_id,message_id,tool_name,input,status,created_at,call_id) VALUES ('old',?1,?2,?3,?4,'pending',?5,'c1')",
                rusqlite::params![task.id, msg.id, ASK_USER, input.to_string(), now()],
            )
            .unwrap();
        let (id, told) = asked(&s, &task, "c1", ASK_USER, input.clone()).await;
        assert_eq!(id, "old");
        answer(&s, &id, true, false, None, answers(vec![vec!["Summer"], vec!["Cats"]])).unwrap();
        assert_eq!(told.await.unwrap()["updatedInput"]["answers"], json!({"Which season?": "Summer", "Which pets?": "Cats"}));
    });
}

#[test]
fn says_what_a_question_or_plan_waits_for() {
    assert_eq!(reason(ASK_USER, &json!({"questions": [{"question": "Which\n  one?"}]})), "Which one?");
    assert_eq!(reason(CODEX_QUESTIONS, &json!({"questions": [{"question": "A?"}, {"question": "B?"}, {"question": "C?"}]})), "A? (and 2 more questions)");
    assert_eq!(reason(ASK_USER, &json!({})), "The agent has questions for you");
    assert_eq!(reason(EXIT_PLAN, &json!({"plan": "\n## Plan: Add a cache\nSteps"})), "Plan ready for approval: Add a cache");
    assert_eq!(reason(EXIT_PLAN, &json!({"plan": "Just do it"})), "Plan ready for approval");
    assert_eq!(reason("Bash", &json!({})), "Approve Bash?");
}

#[test]
fn lists_pending_prompts() {
    let s = crate::testing::state();
    let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
    let task = |title: &str| {
        let t = db::NewTask {
            profile_id: &profile.id,
            project_id: None,
            kind: "scratch",
            title,
            description: "",
            status: "todo",
            use_worktree: false,
            model: None,
            effort: None,
            claude_config_id: None,
        };
        db::insert_task(&s.db(), t).unwrap().id
    };
    let (a, b) = (task("a"), task("b"));
    let add = |id: &str, task: &str, input: &str, status: &str| {
        s.db()
            .execute(
                "INSERT INTO permission_requests (id,task_id,message_id,tool_name,input,status,created_at) VALUES (?1,?2,0,'Bash',?3,?4,?5)",
                rusqlite::params![id, task, input, status, now()],
            )
            .unwrap();
    };
    add("r1", &a, r#"{"command":"ls"}"#, "pending");
    add("r2", &b, "not json", "pending");
    add("r3", &a, "{}", "allowed");

    let ids = |v: Vec<Value>| v.iter().map(|r| r["id"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    assert_eq!(ids(pending(&s, None).unwrap()), ["r1", "r2"]);
    let only_a = pending(&s, Some(&a)).unwrap();
    assert_eq!(ids(only_a.clone()), ["r1"]);
    assert_eq!(only_a[0]["input"]["command"], "ls");
    assert_eq!(only_a[0]["task_id"], a.as_str());
    assert_eq!(pending(&s, Some(&b)).unwrap()[0]["input"], "not json");
}

// ---------- approval rules and expiry ----------

/// `running_task`, made its profile's assistant (where the rules hold), with `rules`.
fn assistant(s: &Shared, rules: &[(&str, Decision)], mode: &str) -> (Task, db::Run) {
    let (task, run) = running_task(s, None);
    s.db().execute("UPDATE tasks SET task_type='assistant' WHERE id=?1", [&task.id]).unwrap();
    let r = approval_rules::Rules { rules: rules.iter().map(|(t, d)| Rule { tool: t.to_string(), decision: *d }).collect(), expiry_minutes: 30 };
    approval_rules::set(&s.db(), &task.profile_id, Some(&r)).unwrap();
    let task = s.update_task(&task.id, &[("permission_mode", json!(mode))]).unwrap().unwrap();
    assert!(task.is_assistant());
    (task, run)
}

fn log(s: &Shared, task: &Task) -> Vec<(String, String, String, Option<String>)> {
    let mut l: Vec<_> = approval_rules::list(&s.db(), &task.profile_id, 100).unwrap().into_iter().map(|a| (a.tool_name, a.decision, a.outcome, a.answered_by)).collect();
    l.reverse();
    l
}

fn entry(tool: &str, decision: &str, outcome: &str, by: Option<&str>) -> (String, String, String, Option<String>) {
    (tool.into(), decision.into(), outcome.into(), by.map(String::from))
}

/// Marks MCP call `call_id` as `run`'s, whose turn an automation started (with `routine`) or the user did.
fn call_in_turn(s: &Shared, task: &Task, run: &db::Run, call_id: &str, routine: bool) {
    let mut data = json!({"text": "check the mail"});
    if routine {
        data["routine"] = json!(true);
    }
    let m = s.add_message(&task.id, "user", data).unwrap();
    s.db().execute("UPDATE runs SET turn_message_id=?1 WHERE id=?2", rusqlite::params![m.id, run.id]).unwrap();
    s.db()
        .execute("INSERT INTO mcp_calls (id,run_id,task_id,tool,args,created_at) VALUES (?1,?2,?3,'permission_prompt','{}',?4)", rusqlite::params![call_id, run.id, task.id, now()])
        .unwrap();
}

#[test]
fn an_ask_rule_asks_the_user_even_in_bypass_and_each_time() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (task, _) = assistant(&s, &[("mcp__g__send*", Decision::Ask), ("mcp__g__get*", Decision::Allow)], "bypassPermissions");
        // Bypass allows what no rule asks about, and what a rule allows.
        assert_eq!(prompt(&s, &task, "a", "Bash", &json!({}), None).await.unwrap()["behavior"], "allow");
        assert_eq!(prompt(&s, &task, "b", "mcp__g__get_mail", &json!({}), None).await.unwrap()["behavior"], "allow");
        let input = json!({"to": "bob@example.com", "subject": "Hi"});
        let (id, told) = asked(&s, &task, "c", "mcp__g__send_mail", input.clone()).await;
        let shown = prompt_message(&s, &id);
        assert_eq!(shown["rule"], json!({"tool": "mcp__g__send*", "decision": "ask"}));
        assert!(shown["expires_at"].is_null(), "the user started this run");
        // Switching to Bypass (again) doesn't answer it for the user.
        apply_mode_to_pending(&s, &task).unwrap();
        assert_eq!(s.db().query_row("SELECT status FROM permission_requests WHERE id=?1", [&id], |r| r.get::<_, String>(0)).unwrap(), "pending");
        assert_eq!(log(&s, &task), vec![entry("mcp__g__send_mail", "ask", "pending", None)]);
        // "Always allow" allows it this once: the rule asks next time too.
        answer(&s, &id, true, true, None, Reply::default()).unwrap();
        assert_eq!(told.await.unwrap(), json!({"behavior": "allow", "updatedInput": input}));
        let t = db::get_task(&s.db(), &task.id).unwrap().unwrap();
        assert!(t.auto_allow.is_empty());
        assert_eq!(log(&s, &task), vec![entry("mcp__g__send_mail", "ask", "allowed", Some("user"))]);
        let (id2, told2) = asked(&s, &t, "d", "mcp__g__send_mail", json!({"to": "eve@example.com"})).await;
        answer_by(&s, &id2, false, false, None, Reply::default(), "push").unwrap();
        assert_eq!(told2.await.unwrap()["behavior"], "deny");
        let l = approval_rules::list(&s.db(), &task.profile_id, 10).unwrap();
        assert_eq!((l[0].outcome.as_str(), l[0].answered_by.as_deref(), l[0].summary.as_str()), ("denied", Some("push"), "to: eve@example.com"));
        assert_eq!(l[0].request_id.as_deref(), Some(id2.as_str()));
    });
}

#[test]
fn never_rules_block_and_dont_ask_denies_what_a_rule_asks() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (task, _) = assistant(&s, &[("mcp__g__send*", Decision::Ask), ("mcp__g__*delete*", Decision::Never)], "default");
        let told = prompt(&s, &task, "a", "mcp__g__delete_mail", &json!({"id": "m1"}), None).await.unwrap();
        assert_eq!(told["behavior"], "deny");
        assert!(told["message"].as_str().unwrap().starts_with(approval_rules::BLOCKED));
        let task = s.update_task(&task.id, &[("permission_mode", json!("dontAsk"))]).unwrap().unwrap();
        assert_eq!(prompt(&s, &task, "b", "mcp__g__send_mail", &json!({}), None).await.unwrap(), deny(DONT_ASK_DENIAL));
        // Neither was asked.
        assert_eq!(s.db().query_row("SELECT COUNT(*) FROM permission_requests", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(
            log(&s, &task),
            vec![entry("mcp__g__delete_mail", "never", "blocked", Some("rule")), entry("mcp__g__send_mail", "ask", "denied", Some("mode"))]
        );
        // Another thread of the profile isn't the assistant's: its mode decides.
        let (other, _) = running_task(&s, None);
        s.db().execute("UPDATE tasks SET profile_id=?1 WHERE id=?2", [&task.profile_id, &other.id]).unwrap();
        let other = s.update_task(&other.id, &[("permission_mode", json!("bypassPermissions"))]).unwrap().unwrap();
        assert_eq!(prompt(&s, &other, "c", "mcp__g__delete_mail", &json!({}), None).await.unwrap()["behavior"], "allow");
    });
}

#[test]
fn prompts_from_routine_runs_are_denied_once_they_expire() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (task, run) = assistant(&s, &[("mcp__g__send*", Decision::Ask)], "default");
        call_in_turn(&s, &task, &run, "r1", true);
        let before = chrono::Utc::now();
        let (id, told) = asked(&s, &task, "r1", "mcp__g__send_mail", json!({"to": "bob@example.com"})).await;
        let at: String = s.db().query_row("SELECT expires_at FROM permission_requests WHERE id=?1", [&id], |r| r.get(0)).unwrap();
        let at = chrono::DateTime::parse_from_rfc3339(&at).unwrap().with_timezone(&chrono::Utc);
        // Thirty minutes from when it was asked (to the millisecond it is kept to).
        assert!(at >= before + chrono::Duration::minutes(30) - chrono::Duration::milliseconds(1) && at <= chrono::Utc::now() + chrono::Duration::minutes(30));
        assert_eq!(prompt_message(&s, &id)["expires_at"], json!(at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)));
        // A tool no rule asks about expires too: background work never hangs on a card.
        call_in_turn(&s, &task, &run, "r2", true);
        let (bash, told_bash) = asked(&s, &task, "r2", "Bash", json!({"command": "make"})).await;
        assert_eq!(db::get_task(&s.db(), &task.id).unwrap().unwrap().status, "needs_attention");

        // Not before its time (as the sweeper's clock has it).
        assert_eq!(expire_due(&s, at - chrono::Duration::seconds(1)), 0);
        assert_eq!(expire_due(&s, at + chrono::Duration::seconds(1)), 2);
        assert_eq!(told.await.unwrap(), deny(EXPIRED_UNANSWERED));
        assert_eq!(told_bash.await.unwrap(), deny(EXPIRED_UNANSWERED));
        for id in [&id, &bash] {
            let shown = prompt_message(&s, id);
            assert_eq!((&shown["status"], &shown["note"]), (&json!("expired"), &json!(EXPIRED_UNANSWERED)));
        }
        // Back to work, and the log says nobody answered.
        assert_eq!(db::get_task(&s.db(), &task.id).unwrap().unwrap().status, "in_progress");
        assert_eq!(log(&s, &task), vec![entry("mcp__g__send_mail", "ask", "expired", Some("expiry"))]);
        // An answer after that is too late.
        assert!(answer(&s, &id, true, false, None, Reply::default()).is_err());
        assert_eq!(expire_due(&s, at + chrono::Duration::hours(1)), 0);
    });
}

#[test]
fn only_routine_runs_prompts_expire_and_only_if_the_profile_says_so() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (task, run) = assistant(&s, &[], "default");
        // The user's own turn: it waits for them.
        call_in_turn(&s, &task, &run, "u", false);
        let (mine, _) = asked(&s, &task, "u", "Bash", json!({})).await;
        // No expiry set.
        let r = approval_rules::Rules { expiry_minutes: 0, ..approval_rules::get(&s.db(), &task.profile_id).unwrap() };
        approval_rules::set(&s.db(), &task.profile_id, Some(&r)).unwrap();
        call_in_turn(&s, &task, &run, "r", true);
        let (routine, _) = asked(&s, &task, "r", "Bash", json!({})).await;
        // A prompt from before prompts expired has no expiry either.
        let (old, _) = asked(&s, &task, "o", "Bash", json!({})).await;
        for id in [&mine, &routine, &old] {
            assert_eq!(s.db().query_row("SELECT expires_at FROM permission_requests WHERE id=?1", [id], |r| r.get::<_, Option<String>>(0)).unwrap(), None);
        }
        assert_eq!(expire_due(&s, chrono::Utc::now() + chrono::Duration::days(365)), 0);
        assert_eq!(pending(&s, Some(&task.id)).unwrap().len(), 3);
    });
}

#[test]
fn a_prompt_that_expired_while_the_board_was_down_is_denied_when_its_call_comes_again() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (task, run) = assistant(&s, &[("mcp__g__send*", Decision::Ask)], "default");
        call_in_turn(&s, &task, &run, "r", true);
        let (id, told) = asked(&s, &task, "r", "mcp__g__send_mail", json!({})).await;
        // The board stops: nobody waits on the prompt any more.
        told.abort();
        s.perm_waiters.lock().unwrap().clear();
        // It starts again after the prompt's time: the sweeper's first pass denies it, and the agent's
        // call, delivered again, gets the denial.
        let at: String = s.db().query_row("SELECT expires_at FROM permission_requests WHERE id=?1", [&id], |r| r.get(0)).unwrap();
        let later = chrono::DateTime::parse_from_rfc3339(&at).unwrap().with_timezone(&chrono::Utc) + chrono::Duration::minutes(5);
        assert_eq!(expire_due(&s, later), 1);
        assert_eq!(prompt(&s, &task, "r", "mcp__g__send_mail", &json!({}), None).await.unwrap(), deny(EXPIRED_UNANSWERED));
        assert_eq!(log(&s, &task), vec![entry("mcp__g__send_mail", "ask", "expired", Some("expiry"))]);
    });
}

#[test]
fn a_prompt_a_rule_asked_whose_run_ends_is_logged_as_expired() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (task, _) = assistant(&s, &[("mcp__g__send*", Decision::Ask)], "default");
        let (_, told) = asked(&s, &task, "c", "mcp__g__send_mail", json!({})).await;
        expire_for_task(&s, &task.id);
        assert_eq!(told.await.unwrap()["behavior"], "deny");
        assert_eq!(log(&s, &task), vec![entry("mcp__g__send_mail", "ask", "expired", Some("ended"))]);
    });
}
