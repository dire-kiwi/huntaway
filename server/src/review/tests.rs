use super::*;

#[test]
fn the_projects_instructions_go_between_where_and_how_to_report() {
    let c = db::open(std::path::Path::new(":memory:")).unwrap();
    let p = db::insert_profile(&c, "p", &[], None).unwrap();
    let t = NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "Fix it", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
    let task = db::insert_task(&c, t).unwrap();
    let text = prompt("X-1", &task, "ia/x-1", Some("master"), "abc", &Work::Branch { own_start: false }, &["the bug".into()], &Default::default(), "Check the docs too.");
    let at = |s: &str| text.find(s).unwrap_or_else(|| panic!("{s:?} not in {text}"));
    assert!(at("`pr_view` tool (pr `ia/x-1`)") < at("Check the docs too.") && at("Check the docs too.") < at("call `submit_review` once"));
    assert!(at("submit_review") < at("- the bug"));
}

#[test]
fn what_the_user_decided_goes_before_the_instructions() {
    let c = db::open(std::path::Path::new(":memory:")).unwrap();
    let p = db::insert_profile(&c, "p", &[], None).unwrap();
    let t = NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "Fix it", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
    let task = db::insert_task(&c, t).unwrap();
    let replies = vec![(Some("Should it be A or B?\nB is faster.".to_string()), "A, the gap is fine".to_string()), (None, "thanks".to_string())];
    let replies = db::UserReplies { replies, ..Default::default() };
    let text = prompt("X-1", &task, "ia/x-1", Some("master"), "abc", &Work::Branch { own_start: false }, &[], &replies, "Check the docs too.");
    let at = |s: &str| text.find(s).unwrap_or_else(|| panic!("{s:?} not in {text}"));
    assert!(at("`pr_view`") < at("decisions they made there stand") && at("decisions they made") < at("Check the docs too."));
    assert!(at("The agent:\n\n> Should it be A or B?\n> B is faster.\n\nThe user:\n\n> A, the gap is fine\n") < at("The user:\n\n> thanks"));
    let none = prompt("X-1", &task, "ia/x-1", Some("master"), "abc", &Work::Branch { own_start: false }, &[], &Default::default(), "Check the docs too.");
    assert!(!none.contains("decisions they made"));
}

#[test]
fn what_the_user_said_is_cut_to_the_latest() {
    let long = "x".repeat(REPLY_CHARS + 10);
    let said = format!("{} the question?", "y".repeat(REPLY_CONTEXT_CHARS));
    let text = user_said(&[(Some(said), long.clone())], false);
    assert!(text.contains(&format!("> {} [...]\n", "x".repeat(REPLY_CHARS))) && !text.contains(&long));
    assert!(text.contains("> [...] y") && text.contains("the question?") && !text.contains(&"y".repeat(REPLY_CONTEXT_CHARS)));
    // The latest messages, as many as fit.
    let many: Vec<(Option<String>, String)> = (0..20).map(|i| (None, format!("message {i} {}", "z".repeat(REPLY_CHARS - 20)))).collect();
    let text = user_said(&many, false);
    assert!(text.len() < REPLIES_CHARS + 1000 && text.contains("message 19") && !text.contains("message 0 "));
    let at = |s: &str| text.find(s).unwrap_or_else(|| panic!("{s:?} not in {text}"));
    assert!(at("[Earlier messages left out.]") < at("message 18") && at("message 18") < at("message 19"));
    assert_eq!(user_said(&[], false), "");
    // Those the board didn't read are left out too.
    let text = user_said(&many[18..], true);
    assert!(text.contains("[Earlier messages left out.]\n\nThe user:\n\n> message 18") && text.contains("message 19"), "{text}");
    assert!(!user_said(&many[18..], false).contains("left out"));
}

#[test]
fn work_done_elsewhere_is_found_from_the_agents_last_message_and_pr() {
    let c = db::open(std::path::Path::new(":memory:")).unwrap();
    let p = db::insert_profile(&c, "p", &[], None).unwrap();
    let t = NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "Pin images", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
    let mut task = db::insert_task(&c, t).unwrap();
    task.pr_url = Some("https://github.com/o/deploy/pull/4".into());
    let work = Work::Elsewhere { last_message: Some("Done in o/deploy#4.\nBoth images build.".into()) };
    let text = prompt("X-1", &task, "ia/x-1", Some("master"), "abc", &work, &[], &Default::default(), "Check the docs too.");
    let at = |s: &str| text.find(s).unwrap_or_else(|| panic!("{s:?} not in {text}"));
    assert!(!text.contains("ia/x-1`)"));
    assert!(at("no commits of its own") < at("https://github.com/o/deploy/pull/4") && at("pull/4") < at("`pr_diff` tools with its URL"));
    assert!(at("> Done in o/deploy#4.\n> Both images build.") < at("Check the docs too.") && at("Check the docs too.") < at("submit_review"));

    let work = Work::Elsewhere { last_message: Some("x".repeat(LAST_MESSAGE_CHARS + 10)) };
    let text = prompt("X-1", &task, "ia/x-1", None, "abc", &work, &[], &Default::default(), "");
    assert!(text.contains(&format!("> {} [...]", "x".repeat(LAST_MESSAGE_CHARS))));
}

#[test]
fn a_branch_without_commits_is_reviewed_only_when_the_agent_changed_code() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let p = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let task = db::insert_task(&s.db(), new_task(&p.id, "task")).unwrap();
        let dir = crate::testing::temp_dir();
        assert!(std::process::Command::new("git").arg("init").arg("-q").arg(&dir).status().unwrap().success());
        let n = std::cell::Cell::new(0);
        // A tool call, and its result unless `result` is None (declined or cut short).
        let tool = |name: &str, input: Value, result: Option<bool>| {
            n.set(n.get() + 1);
            let id = format!("t{}", n.get());
            let call = json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": id, "name": name, "input": input}]}});
            s.add_message(&task.id, "claude", call).unwrap();
            if let Some(is_error) = result {
                let out = json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": id, "content": "", "is_error": is_error}]}});
                s.add_message(&task.id, "claude", out).unwrap();
            }
        };
        // Only read and answered, and its edits failed or were declined.
        tool("Read", json!({"file_path": "README.md"}), Some(false));
        tool("Bash", json!({"command": "git log -3 > /tmp/log"}), Some(false));
        tool("ApplyPatch", json!({"changes": []}), Some(true));
        tool("Edit", json!({"file_path": "/src/deploy/a.yml"}), None);
        tool("Write", json!({"file_path": "/src/deploy/b.yml"}), Some(true));
        assert!(!changed_elsewhere(&s, &task, &dir, None).await.unwrap());
        let mut with_pr = task.clone();
        with_pr.pr_url = Some("https://github.com/o/deploy/pull/4".into());
        assert!(changed_elsewhere(&s, &with_pr, &dir, None).await.unwrap());

        tool("Bash", json!({"command": "git -C '../deploy repo' commit -am x"}), Some(false));
        assert!(changed_elsewhere(&s, &task, &dir, None).await.unwrap());
        // After a review, only what the agent did since counts, and uncommitted changes.
        std::thread::sleep(std::time::Duration::from_millis(5));
        let review = Review { state: "issues".into(), updated_at: now(), ..Default::default() };
        assert!(!changed_elsewhere(&s, &with_pr, &dir, Some(&review)).await.unwrap());
        std::fs::write(dir.join("a.txt"), "x").unwrap();
        assert!(changed_elsewhere(&s, &task, &dir, Some(&review)).await.unwrap());
        std::fs::remove_file(dir.join("a.txt")).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        tool("Bash", json!({"command": "sed -i 's/a/b/' /src/deploy/a.yml && false"}), Some(true));
        assert!(changed_elsewhere(&s, &task, &dir, Some(&review)).await.unwrap());
        // An unfinished review doesn't count.
        let stopped = Review { state: "stopped".into(), updated_at: now(), ..Default::default() };
        assert!(changed_elsewhere(&s, &task, &dir, Some(&stopped)).await.unwrap());
        std::fs::remove_dir_all(&dir).unwrap();
    })
}

fn new_task<'a>(profile: &'a str, kind: &'a str) -> NewTask<'a> {
    NewTask { profile_id: profile, project_id: None, kind, title: "t", description: "", status: "in_review", use_worktree: false, model: None, effort: None, claude_config_id: None }
}

/// A task in review with a review in progress by `n` reviewers, and their threads.
fn reviewing(s: &Shared, n: usize) -> (Task, Vec<Task>) {
    let p = db::insert_profile(&s.db(), "p", &[], None).unwrap();
    let task = db::insert_task(&s.db(), new_task(&p.id, "task")).unwrap();
    let threads: Vec<Task> = (0..n)
        .map(|_| {
            let t = db::insert_task(&s.db(), new_task(&p.id, "review")).unwrap();
            s.update_task(&t.id, &[("parent_id", json!(task.id))]).unwrap().unwrap()
        })
        .collect();
    let parts = threads.iter().enumerate().map(|(i, t)| ReviewerRun { thread_id: t.id.clone(), label: format!("r{i}"), state: "running".into(), ..Default::default() });
    let review = Review { thread_id: threads[0].id.clone(), state: "running".into(), reviewers: parts.collect(), updated_at: now(), ..Default::default() };
    set_review(s, &task.id, &review).unwrap();
    (task, threads)
}

fn review_of(s: &Shared, task: &Task) -> Review {
    db::get_task(&s.db(), &task.id).unwrap().unwrap().review.unwrap()
}

#[test]
fn the_review_waits_for_every_reviewer_and_combines_their_issues() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (task, threads) = reviewing(&s, 3);
        submit(&s, &threads[0], "run", &json!({"verdict": "pass", "summary": "Looks good."})).unwrap();
        finished(&s, &threads[0], "run", &Outcome::Ok, None);
        let r = review_of(&s, &task);
        assert_eq!((r.state.as_str(), r.reviewers[0].state.as_str()), ("running", "passed"));

        submit(&s, &threads[1], "run", &json!({"verdict": "needs_fixes", "summary": "One bug.", "serious_issues": ["the bug"]})).unwrap();
        finished(&s, &threads[1], "run", &Outcome::Ok, None);
        assert_eq!(review_of(&s, &task).state, "running");

        // The last one fails: the issues the others found still count.
        finished(&s, &threads[2], "run", &Outcome::Failed("boom".into()), None);
        let r = review_of(&s, &task);
        assert_eq!(r.state, "issues");
        assert_eq!(r.issues, vec!["(r1) the bug".to_string()]);
        assert_eq!(r.reviewers.iter().map(|p| p.state.as_str()).collect::<Vec<_>>(), ["passed", "issues", "failed"]);
        let summary = r.summary.unwrap();
        assert!(summary.contains("**r0:** Looks good.") && summary.contains("**r1:** One bug."), "{summary}");
        // No fix rounds (it has no project): left for the user.
        let t = db::get_task(&s.db(), &task.id).unwrap().unwrap();
        assert_eq!(t.status, "needs_attention");

        // A reviewer that has finished can't submit again.
        assert!(submit(&s, &threads[0], "run", &json!({"verdict": "pass"})).is_err());
    })
}

#[test]
fn each_submission_is_kept_for_statistics() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (task, threads) = reviewing(&s, 2);
        let mut review = review_of(&s, &task);
        review.started_at = Some("2026-10-01T10:00:00.000Z".into());
        set_review(&s, &task.id, &review).unwrap();
        submit(&s, &threads[0], "run1", &json!({"verdict": "pass", "summary": "Fine at first."})).unwrap();
        // Submitted again in the same run: this one counts instead.
        let args = json!({"verdict": "needs_fixes", "summary": "One bug, and a nit.", "serious_issues": ["the bug"], "minor_issues": ["a nit", "another"]});
        submit(&s, &threads[0], "run1", &args).unwrap();
        submit(&s, &threads[1], "run2", &json!({"verdict": "pass", "summary": "Fine."})).unwrap();
        let c = s.db();
        let mut st = c.prepare("SELECT task_id, thread_id, round, run_id, verdict, serious, minor, minor_noted, label FROM review_stats ORDER BY id").unwrap();
        type Row = (String, String, String, String, String, i64, Option<i64>, bool, String);
        let rows: Vec<Row> =
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?))).unwrap().map(Result::unwrap).collect();
        // Both in the round the review started.
        let round = "2026-10-01T10:00:00.000Z".to_string();
        assert_eq!(
            rows,
            vec![
                (task.id.clone(), threads[0].id.clone(), round.clone(), "run1".into(), "issues".into(), 1, Some(2), true, "r0".into()),
                (task.id.clone(), threads[1].id.clone(), round, "run2".into(), "pass".into(), 0, Some(0), false, "r1".into()),
            ]
        );
    })
}

#[test]
fn a_submission_keeps_the_effort_the_work_was_done_at() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (task, threads) = reviewing(&s, 3);
        let effort = |thread: &Task| s.db().query_row("SELECT effort FROM review_stats WHERE thread_id=?1", [&thread.id], |r| r.get::<_, Option<String>>(0)).unwrap();
        let work = |at: &str, effort: Option<&str>| {
            let r = db::insert_run(&s.db(), &task.id, "prompt").unwrap();
            s.db().execute("UPDATE runs SET created_at=?1, effort=?2 WHERE id=?3", rusqlite::params![at, effort, r.id]).unwrap();
        };
        // A task from before runs kept their efforts: what it's set to now, the host's default while it has none of its own.
        db::set_setting(&s.db(), "default_effort", Some("medium")).unwrap();
        work("2000-01-01T00:00:00.000Z", None);
        submit(&s, &threads[0], "run1", &json!({"verdict": "pass", "summary": "Fine."})).unwrap();
        // The work run's own effort, as its agent was given it (see runner/launch.rs), whatever the task and the host are set to after.
        work("2000-01-02T00:00:00.000Z", Some("low"));
        s.update_task(&task.id, &[("effort", json!("xhigh"))]).unwrap();
        db::set_setting(&s.db(), "default_effort", Some("max")).unwrap();
        submit(&s, &threads[1], "run2", &json!({"verdict": "needs_fixes", "summary": "A bug.", "serious_issues": ["x"]})).unwrap();
        // A run the agent's own default.
        work("2000-01-03T00:00:00.000Z", Some(""));
        submit(&s, &threads[2], "run3", &json!({"verdict": "pass", "summary": "Fine."})).unwrap();
        assert_eq!((effort(&threads[0]).as_deref(), effort(&threads[1]).as_deref(), effort(&threads[2]).as_deref()), (Some("medium"), Some("low"), None));
        // And the report has it, with the model the task's agent used before the review.
        let c = s.db();
        let run = |at: &str, kind: &str, model: &str, out: i64| {
            let r = db::insert_run(&c, &task.id, kind).unwrap();
            c.execute("UPDATE runs SET created_at=?1 WHERE id=?2", [at, &r.id]).unwrap();
            c.execute("INSERT INTO token_usage (run_id, model, runtime, output_tokens) VALUES (?1, ?2, 'claude', ?3)", rusqlite::params![r.id, model, out]).unwrap();
        };
        run("2000-01-01T00:00:00.000Z", "prompt", "sonnet", 100);
        run("2000-01-02T00:00:00.000Z", "prompt", "opus", 100);
        run("2000-01-02T00:00:00.000Z", "compact", "haiku", 100);
        run("2100-01-01T00:00:00.000Z", "prompt", "haiku", 100);
        let r = crate::analytics::token_report(&c, &task.profile_id, "2000-01-01T00:00:00.000Z", "2200-01-01T00:00:00.000Z").unwrap();
        assert_eq!(r.reviews.iter().map(|v| (v.effort.as_deref(), v.task_model.as_deref())).collect::<Vec<_>>(), [(Some("medium"), Some("opus")), (Some("low"), Some("opus")), (None, Some("opus"))]);
    })
}

#[test]
fn a_review_started_before_rounds_were_kept_is_one_round() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        // Its review has no start: its reviewers' runs started half a minute apart.
        let (task, threads) = reviewing(&s, 2);
        let run = |thread: &Task, at: &str| {
            let r = db::insert_run(&s.db(), &thread.id, "review").unwrap();
            s.db().execute("UPDATE runs SET created_at=?1 WHERE id=?2", [at, &r.id]).unwrap();
            r.id
        };
        let (a, b) = (run(&threads[0], "2026-10-01T10:00:00.000Z"), run(&threads[1], "2026-10-01T10:00:30.000Z"));
        submit(&s, &threads[0], &a, &json!({"verdict": "pass", "summary": "Fine."})).unwrap();
        submit(&s, &threads[1], &b, &json!({"verdict": "needs_fixes", "summary": "A bug.", "serious_issues": ["x"]})).unwrap();
        let c = s.db();
        let rounds: Vec<String> = c.prepare("SELECT round FROM review_stats ORDER BY id").unwrap().query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
        assert_eq!(rounds, ["2026-10-01T10:00:00.000Z", "2026-10-01T10:00:00.000Z"]);
        let r = crate::analytics::token_report(&c, &task.profile_id, "2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z").unwrap();
        assert_eq!(r.rounds.iter().map(|x| (x.round, x.verdict.as_str(), x.reviewers)).collect::<Vec<_>>(), [(1, "issues", 2)]);
    })
}

#[test]
fn a_review_passes_when_every_reviewer_passes() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (task, threads) = reviewing(&s, 2);
        for t in &threads {
            submit(&s, t, "run", &json!({"verdict": "pass"})).unwrap();
            finished(&s, t, "run", &Outcome::Ok, None);
        }
        let r = review_of(&s, &task);
        assert_eq!(r.state, "passed");
        assert!(r.issues.is_empty());
        assert_eq!(db::get_task(&s.db(), &task.id).unwrap().unwrap().status, "in_review");
    })
}

#[test]
fn superseding_stops_every_reviewer() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (task, threads) = reviewing(&s, 2);
        submit(&s, &threads[0], "run", &json!({"verdict": "pass"})).unwrap();
        finished(&s, &threads[0], "run", &Outcome::Ok, None);
        supersede(&s, &task);
        let r = review_of(&s, &task);
        assert_eq!(r.state, "stopped");
        assert_eq!(r.reviewers.iter().map(|p| p.state.as_str()).collect::<Vec<_>>(), ["passed", "stopped"]);
        // The stopped run ending doesn't change it.
        finished(&s, &threads[1], "run", &Outcome::Cancelled, None);
        assert_eq!(review_of(&s, &task).state, "stopped");
    })
}

#[test]
fn stopping_the_task_stops_its_review() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (task, threads) = reviewing(&s, 2);
        assert!(stop(&s, &task.id));
        let r = review_of(&s, &task);
        assert_eq!((r.state.as_str(), r.summary.as_deref()), ("stopped", Some("Stopped by the user.")));
        assert!(r.reviewers.iter().all(|p| p.state == "stopped"));
        finished(&s, &threads[0], "run", &Outcome::Cancelled, None);
        assert_eq!(review_of(&s, &task).state, "stopped");
        // Nothing left to stop.
        assert!(!stop(&s, &task.id));
    })
}

#[test]
fn a_review_from_before_several_reviewers_still_finishes() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (task, threads) = reviewing(&s, 1);
        let old = Review { thread_id: threads[0].id.clone(), state: "running".into(), updated_at: now(), ..Default::default() };
        set_review(&s, &task.id, &old).unwrap();
        submit(&s, &threads[0], "run", &json!({"verdict": "pass", "summary": "Fine."})).unwrap();
        finished(&s, &threads[0], "run", &Outcome::Ok, None);
        let r = review_of(&s, &task);
        assert_eq!((r.state.as_str(), r.summary.as_deref()), ("passed", Some("Fine.")));
    })
}

#[test]
fn reviewers_are_labelled_by_config_model_and_effort() {
    let c = ClaudeConfig { id: "c".into(), name: "Codex".into(), config_dir: String::new(), agent: "codex".into(), show_usage: false, restart_window: false, created_at: String::new() };
    assert_eq!(label(Some(&c), Some("gpt-5"), Some("high")), "Codex · gpt-5 · high");
    assert_eq!(label(None, None, None), "Claude");
}

/// A task in a project that reviews automatically, with a worktree branch with a commit.
fn reviewable(s: &Shared) -> (Task, PathBuf) {
    let p = db::insert_profile(&s.db(), "p", &[], None).unwrap();
    let np = db::NewProject { id: "pr", profile_id: &p.id, name: "x", key: "X", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: true };
    db::insert_project(&s.db(), np).unwrap();
    let task = db::insert_task(&s.db(), NewTask { project_id: Some("pr"), ..new_task(&p.id, "task") }).unwrap();
    let dir = crate::testing::temp_dir();
    commit(&dir, &["init", "-q"]);
    commit(&dir, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "work"]);
    let fields = [("worktree_path", json!(crate::util::path_str(&dir))), ("worktree_state", json!("ready")), ("branch", json!("ia/x"))];
    let task = db::update_task(&s.db(), &task.id, &fields).unwrap().unwrap();
    (task, dir)
}

fn commit(dir: &Path, args: &[&str]) {
    assert!(std::process::Command::new("git").arg("-C").arg(dir).args(args).status().unwrap().success());
}

#[test]
fn a_review_doesnt_start_once_the_agent_has_started_again() {
    crate::testing::run(async || {
        crate::agent::runs::TEST_CAN_RUN.set(true);
        let s = crate::testing::state();
        let (task, dir) = reviewable(&s);
        // The agent starts again while the review reads the worktree's git state.
        crate::testing::when("review:recording", {
            let (s, task) = (s.clone(), task.clone());
            move || {
                let run = db::insert_run(&s.db(), &task.id, "prompt").unwrap();
                s.runs.lock().unwrap().insert(task.id.clone(), crate::state::RunHandle { run_id: run.id, cancel: None });
                supersede(&s, &task);
            }
        });
        assert!(start(&s, &task.id, false).await.map_err(|e| e.1).unwrap().is_none());
        let t = db::get_task(&s.db(), &task.id).unwrap().unwrap();
        assert!(t.review.is_none(), "{:?}", t.review.map(|r| r.state));
        for thread in db::review_threads(&s.db(), &task.id).unwrap() {
            assert!(!s.is_running(&thread.id), "no reviewer started");
        }
        crate::agent::runs::TEST_CAN_RUN.set(false);
        std::fs::remove_dir_all(&dir).unwrap();
    })
}

#[test]
fn a_review_doesnt_start_on_work_changed_while_it_was_read() {
    crate::testing::run(async || {
        crate::agent::runs::TEST_CAN_RUN.set(true);
        let s = crate::testing::state();
        let (task, dir) = reviewable(&s);
        // A run starts, commits and ends while the review reads the worktree's git state.
        crate::testing::when("review:recording", {
            let (s, task, dir) = (s.clone(), task.clone(), dir.clone());
            move || {
                let run = db::insert_run(&s.db(), &task.id, "prompt").unwrap();
                s.runs.lock().unwrap().insert(task.id.clone(), crate::state::RunHandle { run_id: run.id.clone(), cancel: None });
                supersede(&s, &task);
                commit(&dir, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "more work"]);
                s.db().execute("UPDATE runs SET status='running', saw_result=1 WHERE id=?1", [&run.id]).unwrap();
                runner::on_exit(&s, &run.id, Some(0), None, None, "");
            }
        });
        assert!(start(&s, &task.id, false).await.map_err(|e| e.1).unwrap().is_none());
        let t = db::get_task(&s.db(), &task.id).unwrap().unwrap();
        assert!(t.review.is_none(), "{:?}", t.review.map(|r| (r.state, r.head)));
        // The run's own end reviews it.
        let head = rev_parse(&dir, "HEAD").await;
        let review = loop {
            if let Some(r) = db::get_task(&s.db(), &task.id).unwrap().unwrap().review {
                break r;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        };
        assert_eq!(review.head, head);
        crate::agent::runs::TEST_CAN_RUN.set(false);
        std::fs::remove_dir_all(&dir).unwrap();
    })
}

#[test]
fn a_review_doesnt_start_on_work_changed_by_a_run_that_started_as_it_did() {
    crate::testing::run(async || {
        crate::agent::runs::TEST_CAN_RUN.set(true);
        let s = crate::testing::state();
        let (task, dir) = reviewable(&s);
        // A run starts as the review looks for the task's last one, then commits and ends while git is read.
        let run = db::insert_run(&s.db(), &task.id, "prompt").unwrap();
        crate::testing::when("review:last-run", {
            let (s, task, run) = (s.clone(), task.clone(), run.clone());
            move || {
                s.runs.lock().unwrap().insert(task.id.clone(), crate::state::RunHandle { run_id: run.id, cancel: None });
                supersede(&s, &task);
            }
        });
        crate::testing::when("review:recording", {
            let (s, dir) = (s.clone(), dir.clone());
            move || {
                commit(&dir, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "more work"]);
                s.db().execute("UPDATE runs SET status='running', saw_result=1 WHERE id=?1", [&run.id]).unwrap();
                runner::on_exit(&s, &run.id, Some(0), None, None, "");
            }
        });
        assert!(start(&s, &task.id, false).await.map_err(|e| e.1).unwrap().is_none());
        let t = db::get_task(&s.db(), &task.id).unwrap().unwrap();
        assert!(t.review.is_none(), "{:?}", t.review.map(|r| (r.state, r.head)));
        crate::agent::runs::TEST_CAN_RUN.set(false);
        std::fs::remove_dir_all(&dir).unwrap();
    })
}

#[test]
fn a_review_superseded_as_it_starts_leaves_the_task_to_its_agent() {
    crate::testing::run(async || {
        crate::agent::runs::TEST_CAN_RUN.set(true);
        for fails in [false, true] {
            let s = crate::testing::state();
            let (task, dir) = reviewable(&s);
            let task = s.update_task(&task.id, &[("status", json!("needs_attention"))]).unwrap().unwrap();
            // The user sends the agent more work once the reviewer has started; that run may fail at once.
            crate::testing::when("review:reviewer-started", {
                let (s, task) = (s.clone(), task.clone());
                move || {
                    runner::send(&s, &task.id, "more work").unwrap();
                    if fails {
                        let run = s.runs.lock().unwrap().get(&task.id).unwrap().run_id.clone();
                        runner::on_exit(&s, &run, None, None, Some("it didn't start".into()), "");
                    }
                }
            });
            start(&s, &task.id, true).await.map_err(|e| e.1).unwrap();
            let t = db::get_task(&s.db(), &task.id).unwrap().unwrap();
            assert_eq!(t.review.map(|r| r.state).as_deref(), Some("stopped"));
            match fails {
                false => assert_eq!((t.running, t.status.as_str()), (true, "in_progress")),
                true => {
                    assert_eq!((t.running, t.status.as_str()), (false, "needs_attention"));
                    assert!(t.attention_reason.is_some_and(|r| r.contains("it didn't start")));
                }
            }
            std::fs::remove_dir_all(&dir).unwrap();
        }
        crate::agent::runs::TEST_CAN_RUN.set(false);
    })
}

#[test]
fn a_verdict_from_an_earlier_round_doesnt_count() {
    crate::testing::run(async || {
        use futures::FutureExt;
        let s = crate::testing::state();
        let (task, threads) = reviewing(&s, 1);
        let thread = &threads[0];
        let round = |after: &str| {
            let mut r = review_of(&s, &task);
            r.state = "running".into();
            r.reviewers[0].state = "running".into();
            r.reviewers[0].after_run = Some(after.into());
            set_review(&s, &task.id, &r).unwrap();
        };
        round("");
        let a = db::insert_run(&s.db(), &thread.id, "review").unwrap();
        // A's verdict is cut short by a restart, then A ends and B starts the next round.
        let call = || crate::mcp::tools::McpCall { task_fields: true, run_id: a.id.clone(), call_id: "a".into(), tool: "submit_review".into(), args: json!({"verdict": "pass", "summary": "Fine.", "serious_issues": []}) };
        crate::testing::when("mcp:executed", || panic!("the server stopped"));
        assert!(std::panic::AssertUnwindSafe(crate::mcp::tools::handle_mcp(&s, call())).catch_unwind().await.is_err());
        finished(&s, thread, &a.id, &Outcome::Ok, None);
        round(&a.id);
        let b = db::insert_run(&s.db(), &thread.id, "review").unwrap();
        submit(&s, thread, &b.id, &json!({"verdict": "needs_fixes", "summary": "A bug.", "serious_issues": ["the bug"]})).unwrap();
        // A's verdict, retried, is turned away; B's stands.
        let err = crate::mcp::tools::handle_mcp(&s, call()).await.unwrap_err();
        assert!(err.contains("has ended"), "{err}");
        assert!(submit(&s, thread, &a.id, &json!({"verdict": "pass"})).is_err());
        finished(&s, thread, &b.id, &Outcome::Ok, None);
        let r = review_of(&s, &task);
        assert_eq!((r.state.as_str(), r.issues.clone()), ("issues", vec!["the bug".to_string()]));
    });
}

#[test]
fn a_reviewer_started_just_before_a_restart_still_ends_its_part() {
    crate::testing::run(async || {
        use futures::FutureExt;
        crate::agent::runs::TEST_CAN_RUN.set(true);
        let s = crate::testing::state();
        let (task, dir) = reviewable(&s);
        crate::testing::when("review:reviewer-started", || panic!("the server stopped"));
        assert!(std::panic::AssertUnwindSafe(start(&s, &task.id, true)).catch_unwind().await.is_err());
        assert_eq!(review_of(&s, &task).state, "running");
        // The restart fails the run, which hadn't started its agent: its part ends with it.
        s.runs.lock().unwrap().clear();
        runner::load_active(&s).unwrap();
        let r = review_of(&s, &task);
        assert_eq!((r.state.as_str(), r.reviewers[0].state.as_str()), ("failed", "failed"));
        crate::agent::runs::TEST_CAN_RUN.set(false);
        std::fs::remove_dir_all(&dir).unwrap();
    })
}

#[test]
fn a_task_that_started_after_its_base_branch_is_reviewed_from_where_it_started() {
    crate::testing::run(async || {
        crate::agent::runs::TEST_CAN_RUN.set(true);
        // It starts at a commit master doesn't have, or at master's latest, and has a pull request
        // into master either way.
        for off_master in [true, false] {
            let s = crate::testing::state();
            let (task, dir) = reviewable(&s);
            let git = ["-c", "user.name=t", "-c", "user.email=t@t"];
            commit(&dir, &["branch", "-q", "-m", "master"]);
            let start = match off_master {
                true => {
                    commit(&dir, &[&git[..], &["commit", "-q", "--allow-empty", "-m", "someone else's"]].concat());
                    rev(&dir, "HEAD")
                }
                false => rev(&dir, "master"),
            };
            commit(&dir, &["checkout", "-q", "-b", "ia/x"]);
            if off_master {
                commit(&dir, &["branch", "-q", "-f", "master", "HEAD~1"]);
            }
            commit(&dir, &["update-ref", &format!("refs/huntaway/start/{}", task.id), "HEAD"]);
            commit(&dir, &[&git[..], &["commit", "-q", "--allow-empty", "-m", "its own"]].concat());
            let fields = [
                ("base_branch", json!("master")),
                ("start_from", json!(db::StartFrom::Commit { commit: start.clone() })),
                ("pr_url", json!("https://github.com/o/r/pull/3")),
            ];
            db::update_task(&s.db(), &task.id, &fields).unwrap();
            super::start(&s, &task.id, true).await.map_err(|e| e.1).unwrap();
            let thread = db::review_threads(&s.db(), &task.id).unwrap().remove(0);
            let sent = db::list_messages(&s.db(), &thread.id).unwrap().iter().map(|m| m.data.to_string()).collect::<String>();
            let own = format!("`git diff {start}...HEAD`) rather than `pr_diff`");
            match off_master {
                true => assert!(sent.contains(&own) && sent.contains("only for its description and comments"), "{sent}"),
                false => assert!(!sent.contains("rather than `pr_diff`") && sent.contains("review the pull request's changes"), "{sent}"),
            }
            let task = db::get_task(&s.db(), &task.id).unwrap().unwrap();
            supersede(&s, &task);
            std::fs::remove_dir_all(&dir).unwrap();
        }
        crate::agent::runs::TEST_CAN_RUN.set(false);
    })
}

/// A task in a project with `rounds` rounds of fixes whose review found an issue after `fixes` of them.
fn out_of_rounds(s: &Shared, rounds: u32, fixes: u32) -> Task {
    let (task, dir) = reviewable(s);
    std::fs::remove_dir_all(&dir).unwrap();
    s.db().execute("UPDATE projects SET review_rounds=?1 WHERE id='pr'", [rounds]).unwrap();
    let review = Review { thread_id: "r".into(), state: "issues".into(), issues: vec!["the bug".into()], fixes, updated_at: now(), ..Default::default() };
    set_review(s, &task.id, &review).unwrap();
    s.update_task(&task.id, &[("status", json!("needs_attention")), ("attention_reason", json!("found"))]).unwrap().unwrap()
}

#[test]
fn a_task_out_of_rounds_of_fixes_can_be_given_as_many_again() {
    crate::testing::run(async || {
        crate::agent::runs::TEST_CAN_RUN.set(true);
        let s = crate::testing::state();
        let task = out_of_rounds(&s, 2, 2);
        let t = extend(&s, &task.id).map_err(|e| e.1).unwrap();
        assert_eq!((t.status.as_str(), t.attention_reason.as_deref()), ("in_progress", None));
        assert!(s.is_running(&task.id));
        let r = review_of(&s, &task);
        assert_eq!((r.fixes, r.extra_rounds), (3, 2));
        let sent = db::list_messages(&s.db(), &task.id).unwrap().into_iter().rev().find(|m| m.kind == "user").unwrap();
        assert_eq!(sent.data["review_round"], 3);
        assert!(sent.data["text"].as_str().unwrap().contains("1. the bug"));
        // Not twice.
        assert!(extend(&s, &task.id).unwrap_err().1.contains("hasn't used up"));
        runner::stop(&s, &task.id);
        crate::agent::runs::TEST_CAN_RUN.set(false);
    })
}

#[test]
fn the_extra_rounds_of_fixes_count_until_theyre_used_up() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let task = out_of_rounds(&s, 2, 2);
        s.update_task(&task.id, &[("status", json!("in_review"))]).unwrap();
        let found = |fixes| Review { state: "issues".into(), issues: vec!["still".into()], fixes, extra_rounds: 2, updated_at: now(), ..Default::default() };
        let save = |r: &Review| set_review(&s, &task.id, r).unwrap();
        // A round left: it goes to the agent (which can't start here).
        let t = db::get_task(&s.db(), &task.id).unwrap().unwrap();
        send_issues(&s, &t, found(3), 2, save);
        assert_eq!(review_of(&s, &task).fixes, 4);
        assert_eq!(db::get_task(&s.db(), &task.id).unwrap().unwrap().status, "in_review");
        // None left: it's left for the user.
        let t = db::get_task(&s.db(), &task.id).unwrap().unwrap();
        send_issues(&s, &t, found(4), 2, save);
        let t = db::get_task(&s.db(), &task.id).unwrap().unwrap();
        assert_eq!((t.status.as_str(), t.attention_reason.as_deref()), ("needs_attention", Some("The review found 1 serious issue after 4 rounds of fixes")));
    })
}

#[test]
fn rounds_of_fixes_are_given_back_if_the_agent_cant_start() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        // A project with no rounds of fixes gets one.
        let task = out_of_rounds(&s, 0, 0);
        assert!(extend(&s, &task.id).is_err(), "this host can't run agents");
        let r = review_of(&s, &task);
        assert_eq!((r.fixes, r.extra_rounds), (0, 0));
        assert_eq!(db::get_task(&s.db(), &task.id).unwrap().unwrap().status, "needs_attention");

        crate::agent::runs::TEST_CAN_RUN.set(true);
        extend(&s, &task.id).map_err(|e| e.1).unwrap();
        let r = review_of(&s, &task);
        assert_eq!((r.fixes, r.extra_rounds), (1, 1));
        runner::stop(&s, &task.id);
        crate::agent::runs::TEST_CAN_RUN.set(false);
    })
}

#[test]
fn only_a_review_with_issues_left_after_its_rounds_can_be_extended() {
    crate::testing::run(async || {
        crate::agent::runs::TEST_CAN_RUN.set(true);
        let s = crate::testing::state();
        let task = out_of_rounds(&s, 2, 1);
        assert!(extend(&s, &task.id).unwrap_err().1.contains("hasn't used up"));
        let passed = Review { state: "passed".into(), fixes: 2, updated_at: now(), ..Default::default() };
        set_review(&s, &task.id, &passed).unwrap();
        assert!(extend(&s, &task.id).unwrap_err().1.contains("didn't find issues"));
        assert!(!s.is_running(&task.id));
        crate::agent::runs::TEST_CAN_RUN.set(false);
    })
}

#[test]
fn rounds_added_to_a_cycle_of_fixes_end_with_it() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (task, threads) = reviewing(&s, 1);
        let extended = Review { fixes: 3, extra_rounds: 2, ..review_of(&s, &task) };
        set_review(&s, &task.id, &extended).unwrap();
        submit(&s, &threads[0], "run", &json!({"verdict": "pass"})).unwrap();
        finished(&s, &threads[0], "run", &Outcome::Ok, None);
        let r = review_of(&s, &task);
        // So the next automatic review, which carries both on, gets the project's rounds.
        assert_eq!((r.state.as_str(), r.fixes, r.extra_rounds), ("passed", 0, 0));
    })
}

fn rev(dir: &Path, rev: &str) -> String {
    let out = std::process::Command::new("git").arg("-C").arg(dir).args(["rev-parse", rev]).output().unwrap();
    String::from_utf8(out.stdout).unwrap().trim().to_string()
}
