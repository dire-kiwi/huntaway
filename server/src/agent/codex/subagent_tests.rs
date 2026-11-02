use super::*;

fn running() -> (Shared, Run) {
    let state = crate::testing::state();
    let profile = db::insert_profile(&state.db(), "p", &[], None).unwrap();
    let task = db::insert_task(&state.db(), db::NewTask { profile_id: &profile.id, project_id: None, kind: "scratch", title: "Codex",
        description: "", status: "in_progress", use_worktree: false, model: None, effort: None, claude_config_id: None }).unwrap();
    let run = db::insert_run(&state.db(), &task.id, "prompt").unwrap();
    handle_line(&state, &run, &json!({"method": "thread/started", "params": {"thread": {"id": "main"}}})).unwrap();
    (state, run)
}

fn event(state: &Shared, run: &Run, method: &str, thread: &str, extra: Value) {
    let mut params = extra;
    params["threadId"] = json!(thread);
    handle_line(state, run, &json!({"method": method, "params": params})).unwrap();
}

fn item(state: &Shared, run: &Run, thread: &str, item: Value) {
    event(state, run, "item/started", thread, json!({"item": item}));
    event(state, run, "item/completed", thread, json!({"item": item}));
}

fn messages(state: &Shared, run: &Run) -> Vec<Value> {
    db::list_messages(&state.db(), &run.task_id).unwrap().into_iter().filter(|m| m.kind == "claude").map(|m| m.data).collect()
}

fn calls(state: &Shared, run: &Run) -> Vec<Value> {
    messages(state, run).into_iter().filter(|m| m["type"] == "assistant" && m["message"]["content"][0]["type"] == "tool_use").collect()
}

#[test]
fn codex_subagents_keep_the_main_session_turn_and_stream_separate() {
    crate::testing::run(async || {
        let (state, run) = running();
        let mut events = state.events.subscribe();
        // Both parentThreadId and v2's source.subAgent identify the parent before spawn returns.
        for thread in [
            json!({"id": "child", "parentThreadId": "main", "preview": "Inspect config", "agentRole": "explorer"}),
            json!({"id": "nested", "source": {"subAgent": {"thread_spawn": {"parent_thread_id": "child"}}}, "preview": "Check env"}),
        ] {
            handle_line(&state, &run, &json!({"method": "thread/started", "params": {"thread": thread}})).unwrap();
        }
        item(&state, &run, "main", json!({"type": "collabAgentToolCall", "id": "spawn", "tool": "spawnAgent", "status": "completed",
            "senderThreadId": "main", "receiverThreadIds": ["child"], "prompt": "Inspect config", "model": "gpt-6.1-sol", "agentsStates": {"child": {"status": "running"}}}));
        // A child starting, streaming or compacting mustn't reset the main preview.
        event(&state, &run, "turn/started", "child", json!({"turn": {"id": "child-turn"}}));
        event(&state, &run, "item/agentMessage/delta", "main", json!({"delta": "Main preview"}));
        event(&state, &run, "item/agentMessage/delta", "child", json!({"delta": "Child preview"}));
        item(&state, &run, "child", json!({"type": "agentMessage", "id": "text", "text": "Config report"}));
        item(&state, &run, "child", json!({"type": "commandExecution", "id": "bash", "command": "ls", "status": "completed", "aggregatedOutput": "config.rs"}));
        item(&state, &run, "nested", json!({"type": "reasoning", "id": "think", "summary": ["Check environment"]}));
        event(&state, &run, "turn/plan/updated", "nested", json!({"plan": [{"step": "Read env", "status": "inProgress"}]}));
        event(&state, &run, "turn/completed", "child", json!({"turn": {"id": "child-turn", "status": "completed"}}));
        assert_eq!(db::get_task(&state.db(), &run.task_id).unwrap().unwrap().session_id.as_deref(), Some("main"));
        let r = db::get_run(&state.db(), &run.id).unwrap().unwrap();
        assert!(!r.saw_result && r.result_error.is_none(), "a child's completion isn't the run's result");
        let emitted: Vec<Value> = std::iter::from_fn(|| events.try_recv().ok()).collect();
        let deltas: Vec<_> = emitted.iter().filter(|v| v["type"] == "delta" || v["type"] == "delta_reset").collect();
        assert_eq!(deltas.len(), 1);
        assert_eq!(deltas[0]["text"], "Main preview");
        let all = messages(&state, &run);
        assert!(all.iter().any(|m| m["parent_tool_use_id"] == "codex-agent-child" && m["message"]["content"][0]["text"] == "Config report"));
        assert!(all.iter().any(|m| m["parent_tool_use_id"] == "codex-agent-child" && m["message"]["content"][0]["content"] == "config.rs"));
        assert!(all.iter().any(|m| m["parent_tool_use_id"] == "codex-agent-nested" && m["message"]["content"][0]["thinking"] == "Check environment"));
        let agents: Vec<_> = calls(&state, &run).into_iter().filter(|m| m["message"]["content"][0]["name"] == "Agent").collect();
        assert_eq!(agents.len(), 2);
        assert_eq!(agents[1]["parent_tool_use_id"], "codex-agent-child");
        assert!(agents[0]["message"]["content"][0]["input"]["run_in_background"] == true);
    });
}

#[test]
fn codex_source_only_children_accept_v2_and_legacy_spelling() {
    crate::testing::run(async || {
        for spelling in ["subAgent", "subagent"] {
            let (state, run) = running();
            let mut source = json!({});
            source[spelling] = json!({"thread_spawn": {"parent_thread_id": "main", "agent_role": "explorer"}});
            let thread = json!({"id": "child", "source": source, "preview": "Inspect config"});
            handle_line(&state, &run, &json!({"method": "thread/started", "params": {"thread": thread}})).unwrap();
            assert_eq!(db::get_task(&state.db(), &run.task_id).unwrap().unwrap().session_id.as_deref(), Some("main"));
            let calls = calls(&state, &run);
            assert_eq!(calls.len(), 1);
            assert_eq!(calls[0]["message"]["content"][0]["input"]["subagent_type"], "explorer");
            assert!(calls[0]["parent_tool_use_id"].is_null());
            for kind in ["review", "compact"] {
                let mut source = json!({});
                source[spelling] = json!(kind);
                let thread = json!({"id": kind, "source": source});
                handle_line(&state, &run, &json!({"method": "thread/started", "params": {"thread": thread}})).unwrap();
                event(&state, &run, "turn/completed", kind, json!({"turn": {"id": kind, "status": "completed"}}));
                assert_eq!(db::get_task(&state.db(), &run.task_id).unwrap().unwrap().session_id.as_deref(), Some("main"));
                assert!(!db::get_run(&state.db(), &run.id).unwrap().unwrap().saw_result);
            }
        }
    });
}

#[test]
fn codex_collab_actions_update_existing_children_instead_of_spawning_rows() {
    crate::testing::run(async || {
        let (state, run) = running();
        for (n, tool, status) in [(1, "spawnAgent", "running"), (2, "wait", "completed"), (3, "followupTask", "running"),
            (4, "sendMessage", "running"), (5, "wait", "errored"), (6, "resumeAgent", "running"), (7, "closeAgent", "shutdown")] {
            item(&state, &run, "main", json!({"type": "collabAgentToolCall", "id": format!("call{n}"), "tool": tool, "status": "completed",
                "senderThreadId": "main", "receiverThreadIds": ["child"], "prompt": "Inspect config", "model": "gpt-6.1-sol",
                "agentsStates": {"child": {"status": status, "message": "Child report"}}}));
        }
        let calls = calls(&state, &run);
        assert_eq!(calls.len(), 7);
        assert_eq!(calls.iter().filter(|m| m["message"]["content"][0]["name"] == "Agent").count(), 1);
        let all = messages(&state, &run);
        let statuses: Vec<_> = all.iter().filter(|m| m["subtype"] == "task_notification").map(|m| m["status"].as_str().unwrap()).collect();
        assert_eq!(statuses, ["completed", "failed", "stopped", "stopped"]);
        assert!(all.iter().any(|m| m["subtype"] == "task_updated" && m["patch"]["status"] == "running"));
        assert!(all.iter().filter(|m| m["subtype"] == "task_notification").all(|m| m["tool_use_id"] == "codex-agent-child"));
    });
}

#[test]
fn codex_hosted_activity_and_late_metadata_share_one_row() {
    crate::testing::run(async || {
        let (state, run) = running();
        item(&state, &run, "main", json!({"type": "subAgentActivity", "id": "hosted1", "kind": "started", "agentThreadId": "hosted", "model": "gpt-6.1-sol"}));
        handle_line(&state, &run, &json!({"method": "thread/started", "params": {"thread": {"id": "hosted", "parentThreadId": "main", "preview": "Find tests"}}})).unwrap();
        item(&state, &run, "hosted", json!({"type": "subAgentActivity", "id": "hosted2", "kind": "started", "agentThreadId": "nested"}));
        item(&state, &run, "main", json!({"type": "subAgentActivity", "id": "hosted3", "kind": "completed", "agentThreadId": "hosted"}));
        item(&state, &run, "hosted", json!({"type": "subAgentActivity", "id": "hosted4", "kind": "interrupted", "agentThreadId": "nested"}));
        let agents = calls(&state, &run);
        assert_eq!(agents.len(), 2);
        assert_eq!(agents[0]["message"]["content"][0]["input"]["model"], "gpt-6.1-sol");
        assert_eq!(agents[1]["parent_tool_use_id"], "codex-agent-hosted");
        let all = messages(&state, &run);
        assert!(all.iter().any(|m| m["subtype"] == "task_started" && m["prompt"] == "Find tests"));
        assert_eq!(all.last().unwrap()["status"], "stopped");
    });
}

#[test]
fn codex_failed_spawns_and_child_failures_dont_finish_the_parent() {
    crate::testing::run(async || {
        let (state, run) = running();
        item(&state, &run, "main", json!({"type": "collabAgentToolCall", "id": "bad-spawn", "tool": "spawnAgent", "status": "failed", "receiverThreadIds": [],
            "agentsStates": {"missing": {"status": "notFound", "message": "No agent available"}}}));
        assert_eq!(calls(&state, &run)[0]["message"]["content"][0]["name"], "spawnAgent");
        assert!(messages(&state, &run).iter().any(|m| m["message"]["content"][0]["is_error"] == true));
        // Internal compact/review agents must never become the main session.
        handle_line(&state, &run, &json!({"method": "thread/started", "params": {"thread": {"id": "review", "source": {"subAgent": "review"}}}})).unwrap();
        event(&state, &run, "turn/completed", "child", json!({"turn": {"id": "child-turn", "status": "failed", "error": {"message": "Child failed"}}}));
        assert!(!db::get_run(&state.db(), &run.id).unwrap().unwrap().saw_result);
        assert_eq!(db::get_task(&state.db(), &run.task_id).unwrap().unwrap().session_id.as_deref(), Some("main"));
        event(&state, &run, "turn/completed", "main", json!({"turn": {"id": "main-turn", "status": "completed"}}));
        assert!(db::get_run(&state.db(), &run.id).unwrap().unwrap().saw_result);
    });
}
