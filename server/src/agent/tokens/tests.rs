use super::*;
use serde_json::json;

fn result(session: &str, models: Value) -> String {
    json!({"type": "result", "subtype": "success", "session_id": session, "modelUsage": models}).to_string()
}

fn opus(input: i64, output: i64, read: i64, cost: f64) -> Value {
    json!({"inputTokens": input, "outputTokens": output, "cacheReadInputTokens": read, "cacheCreationInputTokens": 10, "costUSD": cost, "thinkingTokens": 1})
}

fn usage(thread: &str, total: (i64, i64, i64), last: (i64, i64, i64)) -> String {
    let u = |(input, cached, output): (i64, i64, i64)| json!({"inputTokens": input, "cachedInputTokens": cached, "outputTokens": output, "totalTokens": input + output});
    json!({"method": "thread/tokenUsage/updated", "params": {"threadId": thread, "tokenUsage": {"total": u(total), "last": u(last)}}}).to_string()
}

fn none(_: &str) -> Option<BTreeMap<String, Counts>> {
    None
}

#[test]
fn a_claude_run_uses_what_its_sessions_totals_went_up_by() {
    let lines = [
        json!({"type": "system", "subtype": "init", "session_id": "s1"}).to_string(),
        r#"{"type":"assistant","message":{"usage":{"output_tokens":3}}}"#.to_string(),
        result("s1", json!({"claude-opus-5-5": opus(5, 100, 1000, 1.0)})),
        // A turn that failed before the model answered: no modelUsage, so no count.
        json!({"type": "result", "subtype": "error_during_execution", "session_id": "s1", "modelUsage": {}}).to_string(),
        result("s1", json!({"claude-opus-5-5": opus(7, 150, 3000, 1.5), "claude-haiku-5-5": opus(1, 2, 0, 0.01)})),
    ];
    let c = count_claude(lines.into_iter(), &mut none);
    assert_eq!(c.models["claude-opus-5-5"], Counts { input: 7, output: 150, cache_read: 3000, cache_write: 10, reasoning: 1, cost: 1.5 });
    assert_eq!(c.models["claude-haiku-5-5"].output, 2);
    assert_eq!(c.session.as_deref(), Some("s1"));
    assert_eq!(c.snapshot["claude-opus-5-5"].output, 150);

    // A later run that resumes the session goes on from those totals.
    let snapshot = c.snapshot.clone();
    let mut earlier = |s: &str| (s == "s1").then(|| snapshot.clone());
    let next = count_claude([result("s1", json!({"claude-opus-5-5": opus(9, 200, 4000, 2.0), "claude-haiku-5-5": opus(1, 2, 0, 0.01)}))].into_iter(), &mut earlier);
    assert_eq!(next.models["claude-opus-5-5"].output, 50);
    assert_eq!(next.models["claude-opus-5-5"].cache_read, 1000);
    assert!((next.models["claude-opus-5-5"].cost - 0.5).abs() < 1e-9);
    // Haiku did nothing more in it.
    assert!(!next.models.contains_key("claude-haiku-5-5"));

    // A new session (a review round's) starts from nothing.
    let fresh = count_claude([result("s2", json!({"claude-opus-5-5": opus(1, 10, 100, 0.1)}))].into_iter(), &mut earlier);
    assert_eq!(fresh.models["claude-opus-5-5"].output, 10);

    // Totals that went down: Claude Code started counting again.
    let again = count_claude([result("s1", json!({"claude-opus-5-5": opus(1, 20, 100, 0.2)}))].into_iter(), &mut earlier);
    assert_eq!(again.models["claude-opus-5-5"].output, 20);
}

#[test]
fn a_codex_run_counts_each_threads_increase() {
    let lines = [
        json!({"method": "thread/started", "params": {"thread": {"id": "main"}}}).to_string(),
        json!({"method": "huntaway/model", "params": {"threadId": "main", "model": "gpt-6.1-sol"}}).to_string(),
        usage("main", (100, 40, 10), (100, 40, 10)),
        usage("main", (300, 200, 30), (200, 160, 20)),
        // A subagent's thread, new in this run.
        usage("child", (50, 0, 5), (50, 0, 5)),
    ];
    let c = count_codex(lines.into_iter(), "codex", &mut none);
    let m = c.models["gpt-6.1-sol"];
    // Cached input isn't counted as input.
    assert_eq!((m.input, m.cache_read, m.output), (150, 200, 35));
    assert_eq!(c.snapshot["main"].output, 30);

    // Resumed: the thread says its old totals again first, then goes on.
    let snapshot = c.snapshot.clone();
    let mut earlier = |t: &str| snapshot.contains_key(t).then(|| snapshot.clone());
    let lines = [usage("main", (300, 200, 30), (200, 160, 20)), usage("main", (400, 250, 40), (100, 50, 10))];
    let next = count_codex(lines.into_iter(), "gpt-6.1-sol", &mut earlier);
    assert_eq!(next.models["gpt-6.1-sol"].output, 10);

    // Its totals went down (rolled back), or a resumed thread's earlier totals aren't known: just
    // the latest request.
    let lines = [usage("main", (120, 0, 12), (20, 0, 2))];
    assert_eq!(count_codex(lines.clone().into_iter(), "m", &mut earlier).models["m"].output, 2);
    assert_eq!(count_codex(lines.into_iter(), "m", &mut none).models["m"].output, 2);
}

#[test]
fn counts_runs_once_from_their_output_or_their_cost() {
    crate::testing::run(async || {
        let state = crate::testing::state();
        let p = db::insert_profile(&state.db(), "p", &[], None).unwrap();
        let t = db::NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "t", description: "", status: "in_progress", use_worktree: false, model: Some("opus".into()), effort: None, claude_config_id: None };
        let task = db::insert_task(&state.db(), t).unwrap();
        let mut runs = Vec::new();
        for _ in 0..3 {
            let run = db::insert_run(&state.db(), &task.id, "prompt").unwrap();
            runs.push(run.id);
        }
        let write = |id: &str, lines: &[String]| {
            let dir = run_dir(&state, id);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("out.jsonl"), lines.join("\n")).unwrap();
        };
        write(&runs[0], &[result("s1", json!({"claude-opus-5-5": opus(5, 100, 1000, 1.0)}))]);
        write(&runs[1], &[result("s1", json!({"claude-opus-5-5": opus(6, 160, 1500, 1.25)}))]);
        // The third's folder is gone: it has its cost.
        let c = state.db();
        c.execute("UPDATE runs SET cost_usd=0.25 WHERE id=?1", [&runs[1]]).unwrap();
        c.execute("UPDATE runs SET cost_usd=0.75 WHERE id=?1", [&runs[2]]).unwrap();
        c.execute("UPDATE runs SET status='exited' WHERE id IN (?1, ?2)", [&runs[0], &runs[2]]).unwrap();
        drop(c);

        // The second hasn't ended: the others are counted, and it waits.
        assert_eq!(count_pending(&state, None).unwrap(), 2);
        state.db().execute("UPDATE runs SET status='exited' WHERE id=?1", [&runs[1]]).unwrap();
        assert_eq!(count_pending(&state, Some(&task.id)).unwrap(), 1);
        assert_eq!(count_pending(&state, None).unwrap(), 0);

        let rows = |id: &str| -> Vec<(String, i64, f64, bool)> {
            let c = state.db();
            let mut st = c.prepare("SELECT model, output_tokens, cost_usd, estimated FROM token_usage WHERE run_id=?1").unwrap();
            st.query_map([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap().map(Result::unwrap).collect()
        };
        assert_eq!(rows(&runs[0]), vec![("claude-opus-5-5".into(), 100, 1.0, false)]);
        // It went on from the first, though counted after the third.
        assert_eq!(rows(&runs[1]), vec![("claude-opus-5-5".into(), 60, 0.25, false)]);
        assert_eq!(rows(&runs[2]), vec![("opus".into(), 0, 0.75, true)]);
    })
}

#[test]
fn a_run_counted_from_nothing_is_scaled_to_its_cost() {
    crate::testing::run(async || {
        let state = crate::testing::state();
        let p = db::insert_profile(&state.db(), "p", &[], None).unwrap();
        let t = db::NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "t", description: "", status: "in_progress", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let task = db::insert_task(&state.db(), t).unwrap();
        // It resumed a session whose earlier runs' output is gone: its totals are all of them.
        let run = db::insert_run(&state.db(), &task.id, "prompt").unwrap();
        let dir = run_dir(&state, &run.id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("out.jsonl"), result("s1", json!({"claude-opus-5-5": opus(10, 400, 4000, 4.0)}))).unwrap();
        state.db().execute("UPDATE runs SET status='exited', cost_usd=1.0 WHERE id=?1", [&run.id]).unwrap();
        count_pending(&state, None).unwrap();
        let (output, cost, estimated): (i64, f64, bool) =
            state.db().query_row("SELECT output_tokens, cost_usd, estimated FROM token_usage WHERE run_id=?1", [&run.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!((output, estimated), (100, true));
        assert!((cost - 1.0).abs() < 1e-9);
    })
}

#[test]
fn a_codex_subagents_tokens_go_to_its_own_model() {
    let lines = [
        json!({"method": "huntaway/model", "params": {"threadId": "main", "model": "gpt-6.1-sol"}}).to_string(),
        json!({"method": "item/started", "params": {"threadId": "main", "item": {"type": "collabAgentToolCall", "tool": "spawnAgent",
            "receiverThreadIds": ["child"], "model": "gpt-6-luna"}}}).to_string(),
        json!({"method": "item/started", "params": {"threadId": "main", "item": {"type": "subAgentActivity", "kind": "started",
            "agentThreadId": "hosted", "model": "gpt-6-astra"}}}).to_string(),
        usage("main", (100, 0, 10), (100, 0, 10)),
        usage("child", (1000, 0, 200), (1000, 0, 200)),
        usage("hosted", (50, 0, 7), (50, 0, 7)),
        // Spawned without a model: the run's.
        usage("other", (20, 0, 3), (20, 0, 3)),
    ];
    let c = count_codex(lines.into_iter(), "codex", &mut none);
    let out: Vec<(&str, i64)> = c.models.iter().map(|(m, n)| (m.as_str(), n.output)).collect();
    assert_eq!(out, [("gpt-6-astra", 7), ("gpt-6-luna", 200), ("gpt-6.1-sol", 13)]);
}
