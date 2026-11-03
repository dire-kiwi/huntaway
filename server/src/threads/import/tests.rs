use std::sync::Arc;

use agent_threads::Store;
use agent_threads::protocol::Item;

use super::*;
use crate::testing;
use crate::threads::store::HuntawayStore;

fn msg(id: i64, kind: &str, data: Value) -> Message {
    Message { id, task_id: "t".into(), kind: kind.into(), data, created_at: format!("2026-11-01T00:00:{:02}.000Z", id % 60) }
}

fn assistant(id: i64, parent: Option<&str>, blocks: Value) -> Message {
    msg(id, "claude", json!({"type": "assistant", "message": {"content": blocks}, "parent_tool_use_id": parent, "session_id": "s1"}))
}

fn results(id: i64, parent: Option<&str>, blocks: Value) -> Message {
    msg(id, "claude", json!({"type": "user", "message": {"content": blocks}, "parent_tool_use_id": parent, "session_id": "s1"}))
}

fn task() -> crate::db::Task {
    let mut t = testing::task(&testing::state());
    t.session_id = Some("s1".into());
    t
}

fn convert_all(messages: &[Message]) -> Conversion {
    convert(&Source { task: &task(), harness: "claude", messages }).unwrap()
}

/// The snapshot's items as JSON, by id.
fn items(c: &Conversion) -> BTreeMap<String, Value> {
    c.snapshot.items.iter().map(|i| (i.id().to_string(), serde_json::to_value(i).unwrap())).collect()
}

fn codes(c: &Conversion) -> Vec<&'static str> {
    c.warnings.iter().map(|w| w.code).collect()
}

fn disposition(c: &Conversion, id: i64) -> Disposition {
    c.rows.iter().find(|r| r.message_id == id).unwrap().disposition
}

#[test]
fn converts_a_turn() {
    let c = convert_all(&[
        msg(1, "user", json!({"text": "Fix the test", "auto": true})),
        assistant(2, None, json!([{"type": "thinking", "thinking": "Hmm"}, {"type": "text", "text": "Looking"}, {"type": "tool_use", "id": "tu1", "name": "Bash", "input": {"command": "cargo test"}}])),
        results(3, None, json!([{"type": "tool_result", "tool_use_id": "tu1", "content": [{"type": "text", "text": "ok"}]}])),
        assistant(4, None, json!([{"type": "text", "text": "  "}])),
        msg(5, "user", json!({"text": "and the docs", "steered": true})),
        msg(6, "claude", json!({"type": "result", "subtype": "success", "is_error": false, "duration_ms": 1200, "num_turns": 3, "total_cost_usd": 0.5})),
        msg(7, "event", json!({"level": "warn", "text": "Slow", "detail": null})),
    ]);
    let ThreadEvent::ThreadUpdated(first) = &c.events[0] else { panic!("{:?}", c.events[0]) };
    assert_eq!((first.seq.get(), first.thread.id.as_str()), (1, c.thread.id.as_str()));
    assert!(c.events.iter().enumerate().all(|(i, e)| e.seq() == i as u64 + 1));
    let ids: Vec<&str> = c.snapshot.items.iter().map(|i| i.id()).collect();
    assert_eq!(ids, ["legacy:1", "legacy:2:0", "legacy:2:1", "tu1", "legacy:5", "legacy:6", "legacy:7"]);
    let items = items(&c);
    assert_eq!(items["legacy:1"], json!({"id": "legacy:1", "type": "user_message", "text": "Fix the test", "created_at": "2026-11-01T00:00:01.000Z"}));
    assert_eq!(items["legacy:5"]["steered"], true);
    assert_eq!(items["legacy:2:0"]["type"], "reasoning");
    assert_eq!(items["tu1"]["status"], "completed");
    assert_eq!(items["tu1"]["kind"], "shell");
    assert_eq!(items["tu1"]["command"], "cargo test");
    assert_eq!(items["tu1"]["result"], json!({"content": "ok"}));
    assert_eq!(items["legacy:6"]["ok"], true);
    assert_eq!(items["legacy:6"]["duration_ms"], 1200);
    assert_eq!(items["legacy:7"]["level"], "warning");
    assert_eq!(disposition(&c, 4), Disposition::Redundant);
    assert_eq!(c.count(Disposition::Retained), 0);
    assert!(c.warnings.is_empty(), "{:?}", c.warnings);
    assert_eq!(c.snapshot.seq, c.events.len() as u64);
    assert_eq!(c.thread.session_id.as_deref(), Some("s1"));
    assert_eq!(c.thread.metadata["imported"]["converter"], CONVERTER_VERSION);
}

#[test]
fn the_same_messages_convert_the_same_and_an_edit_shows() {
    let mut messages = vec![msg(1, "user", json!({"text": "hi"})), assistant(2, None, json!([{"type": "text", "text": "hello"}]))];
    let t = task();
    let a = convert(&Source { task: &t, harness: "claude", messages: &messages }).unwrap();
    let b = convert(&Source { task: &t, harness: "claude", messages: &messages }).unwrap();
    assert_eq!(serde_json::to_value(&a.events).unwrap(), serde_json::to_value(&b.events).unwrap());
    assert_eq!(a.fingerprint, b.fingerprint);
    messages[1].data["message"]["content"][0]["text"] = json!("hello!");
    assert_ne!(fingerprint(&messages), a.fingerprint);
}

#[test]
fn subagents_and_their_messages() {
    let c = convert_all(&[
        assistant(1, None, json!([{"type": "tool_use", "id": "ag", "name": "Agent", "input": {"description": "Look around", "prompt": "Look", "model": "haiku"}}])),
        msg(2, "claude", json!({"type": "system", "subtype": "task_started", "task_type": "local_agent", "task_id": "k1", "tool_use_id": "ag", "subagent_type": "Explore"})),
        results(3, Some("ag"), json!([{"type": "text", "text": "Look"}])),
        assistant(4, Some("ag"), json!([{"type": "tool_use", "id": "rd", "name": "Read", "input": {"file_path": "/a"}}])),
        results(5, Some("ag"), json!([{"type": "tool_result", "tool_use_id": "rd", "content": "text"}])),
        msg(6, "claude", json!({"type": "system", "subtype": "task_progress", "task_id": "k1", "description": "Reading /a", "usage": {"tool_uses": 1}})),
        msg(7, "claude", json!({"type": "system", "subtype": "task_notification", "task_id": "k1", "status": "completed"})),
        msg(8, "claude", json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "ag", "content": "Found it"}]}, "tool_use_result": {"agentType": "Explore", "totalToolUseCount": 1, "status": "completed"}})),
        // A Bash command's run: its call shows it.
        assistant(9, None, json!([{"type": "tool_use", "id": "sh", "name": "Bash", "input": {"command": "ls"}}])),
        msg(10, "claude", json!({"type": "system", "subtype": "task_started", "task_type": "local_bash", "task_id": "k2", "tool_use_id": "sh"})),
        msg(11, "claude", json!({"type": "system", "subtype": "task_notification", "task_id": "k2", "status": "completed"})),
        results(12, None, json!([{"type": "tool_result", "tool_use_id": "sh", "content": "a"}])),
        // Not the subagent's prompt.
        results(13, Some("ag"), json!([{"type": "text", "text": "[Request interrupted by user]"}])),
    ]);
    let items = items(&c);
    assert_eq!(items["ag"]["kind"], "subagent");
    assert_eq!(items["ag"]["title"], "Look around");
    assert_eq!(items["ag"]["subagent"], json!({"status": "completed", "agent_type": "Explore", "model": "haiku", "activity": "Reading /a", "tool_uses": 1}));
    assert_eq!(items["rd"]["parent_id"], "ag");
    assert_eq!(items["rd"]["path"], "/a");
    assert_eq!((&items["legacy:13"]["code"], &items["legacy:13"]["parent_id"]), (&json!("interrupted"), &json!("ag")));
    // The subagent's prompt is its call's input.
    assert_eq!(disposition(&c, 3), Disposition::Redundant);
    for id in [10, 11] {
        assert_eq!(disposition(&c, id), Disposition::Redundant);
    }
    assert!(c.warnings.is_empty(), "{:?}", c.warnings);
}

#[test]
fn a_background_subagent_and_one_that_never_ends() {
    let c = convert_all(&[
        assistant(1, None, json!([{"type": "tool_use", "id": "bg", "name": "Agent", "input": {"description": "Away", "run_in_background": true}}])),
        msg(2, "claude", json!({"type": "system", "subtype": "task_started", "task_type": "local_agent", "task_id": "k1", "tool_use_id": "bg", "is_backgrounded": true})),
        results(3, None, json!([{"type": "tool_result", "tool_use_id": "bg", "content": "Async agent launched successfully"}])),
        msg(4, "claude", json!({"type": "system", "subtype": "task_notification", "task_id": "k1", "status": "completed", "summary": "Done away"})),
        assistant(5, None, json!([{"type": "tool_use", "id": "bg2", "name": "Agent", "input": {"description": "Lost"}}])),
        msg(6, "claude", json!({"type": "system", "subtype": "task_started", "task_type": "local_agent", "task_id": "k2", "tool_use_id": "bg2", "is_backgrounded": true})),
        results(7, None, json!([{"type": "tool_result", "tool_use_id": "bg2", "content": "Async agent launched successfully"}])),
    ]);
    let items = items(&c);
    assert_eq!(items["bg"]["status"], "completed");
    assert_eq!(items["bg"]["subagent"], json!({"status": "completed", "background": true, "summary": "Done away"}));
    assert_eq!(items["bg2"]["subagent"]["status"], "stopped");
    assert_eq!(codes(&c), ["subagent_running"]);
}

#[test]
fn a_forked_skill_becomes_a_subagent() {
    let c = convert_all(&[
        assistant(1, None, json!([{"type": "tool_use", "id": "sk", "name": "Skill", "input": {"skill": "review"}}])),
        msg(2, "claude", json!({"type": "system", "subtype": "task_started", "task_type": "local_agent", "task_id": "k1", "tool_use_id": "sk"})),
        assistant(3, Some("sk"), json!([{"type": "text", "text": "Reviewing"}])),
        results(4, None, json!([{"type": "tool_result", "tool_use_id": "sk", "content": "Reviewed"}])),
    ]);
    let items = items(&c);
    assert_eq!(items["sk"]["kind"], "subagent");
    assert_eq!(items["sk"]["subagent"]["status"], "completed");
    assert_eq!(items["legacy:3:0"]["parent_id"], "sk");
    assert!(c.warnings.is_empty(), "{:?}", c.warnings);
}

#[test]
fn prompts_become_resolved_requests() {
    let c = convert_all(&[
        // Stored before the call it's for, made in a subagent.
        assistant(1, None, json!([{"type": "tool_use", "id": "ag", "name": "Task", "input": {}}])),
        msg(2, "permission", json!({"tool_name": "Bash", "input": {"command": "rm -rf x"}, "tool_use_id": "rm", "request_id": "r1", "status": "denied", "note": "No"})),
        assistant(3, Some("ag"), json!([{"type": "tool_use", "id": "rm", "name": "Bash", "input": {"command": "rm -rf x"}}])),
        results(4, Some("ag"), json!([{"type": "tool_result", "tool_use_id": "rm", "content": "No", "is_error": true}])),
        msg(5, "permission", json!({"tool_name": "ExitPlanMode", "input": {"plan": "# Plan"}, "tool_use_id": "pl", "request_id": "r2", "status": "allowed"})),
        msg(6, "permission", json!({"tool_name": "AskUserQuestion", "input": {"questions": [{"question": "Which?", "header": "Pick", "options": [{"label": "A"}, {"label": "B", "description": "b"}], "multiSelect": true}]}, "request_id": "r3", "status": "allowed", "answers": {"Which?": "A, B"}})),
        msg(7, "permission", json!({"tool_name": "Write", "input": {"file_path": "/f"}, "request_id": "r4", "status": "expired"})),
        msg(8, "permission", json!({"tool_name": "delete_task", "kind": "delete_task", "input": {"task": "X-1"}, "request_id": "r5", "status": "pending"})),
        msg(9, "permission", json!({"tool_name": "mcp__gh__pr_merge", "input": {}, "request_id": "r6", "status": "allowed"})),
    ]);
    let requests: BTreeMap<String, Value> = c.snapshot.requests.iter().map(|r| serde_json::to_value(r).unwrap()).map(|r| (r["id"].as_str().unwrap().to_string(), r)).collect();
    let r1 = &requests["r1"];
    assert_eq!((&r1["type"], &r1["kind"], &r1["title"], &r1["tool_call_id"], &r1["parent_id"]), (&json!("permission"), &json!("shell"), &json!("rm -rf x"), &json!("rm"), &json!("ag")));
    assert_eq!(r1["resolution"], json!({"outcome": "deny", "message": "No"}));
    assert_eq!(items(&c)["rm"]["status"], "denied");
    assert_eq!((&requests["r2"]["type"], &requests["r2"]["plan"]), (&json!("plan"), &json!("# Plan")));
    assert_eq!(requests["r2"]["resolution"]["outcome"], "allow");
    assert_eq!(requests["r3"]["questions"], json!([{"id": "0", "question": "Which?", "header": "Pick", "options": [{"label": "A"}, {"label": "B", "description": "b"}], "multi_select": true}]));
    assert_eq!(requests["r3"]["resolution"], json!({"outcome": "answer", "answers": {"0": ["A, B"]}}));
    assert_eq!(requests["r4"]["resolution"]["outcome"], "cancel");
    assert_eq!(requests["r4"]["kind"], "edit");
    // Not answered: not made an approval, nor a live request.
    assert_eq!((&requests["r5"]["kind"], &requests["r5"]["resolution"]["outcome"]), (&json!("app"), &json!("cancel")));
    assert_eq!((&requests["r6"]["kind"], &requests["r6"]["server"], &requests["r6"]["name"]), (&json!("mcp"), &json!("gh"), &json!("pr_merge")));
    assert!(c.snapshot.requests.iter().all(|r| serde_json::to_value(r).unwrap()["resolution"].is_object()));
    // The Task call never got a result.
    assert_eq!(codes(&c), ["open_prompt", "no_result"]);
}

#[test]
fn board_questions() {
    let card = |status: &str| json!({"question": "Merge?", "options": [{"label": "Yes"}, {"label": "No"}], "multi_select": false, "allow_other": true, "call_id": "c", "status": status});
    let mut answered = card("answered");
    answered["answer"] = json!({"choices": ["Yes"], "text": "now"});
    let c = convert_all(&[msg(1, "question", answered), msg(2, "question", card("replied")), msg(3, "question", card("pending"))]);
    let r: Vec<Value> = c.snapshot.requests.iter().map(|r| serde_json::to_value(r).unwrap()).collect();
    assert_eq!(r[0]["questions"], json!([{"id": "q", "question": "Merge?", "options": [{"label": "Yes"}, {"label": "No"}], "allow_other": true}]));
    assert_eq!(r[0]["resolution"], json!({"outcome": "answer", "answers": {"q": ["Yes", "now"]}}));
    assert_eq!(r[1]["resolution"]["outcome"], "cancel");
    assert_eq!(r[2]["resolution"]["outcome"], "cancel");
    assert_eq!(codes(&c), ["open_prompt"]);
}

#[test]
fn compaction_and_its_summary() {
    let c = convert_all(&[
        msg(1, "claude", json!({"type": "system", "subtype": "compact_boundary", "compact_metadata": {"trigger": "manual", "pre_tokens": 1234}})),
        msg(2, "claude", json!({"type": "user", "isSynthetic": true, "message": {"content": "Summary so far"}})),
        msg(3, "claude", json!({"type": "result", "subtype": "success", "is_error": false, "num_turns": 0})),
        msg(4, "claude", json!({"type": "result", "subtype": "error_during_execution", "is_error": true, "interrupted": true})),
    ]);
    let items = items(&c);
    assert_eq!(items["legacy:1"], json!({"id": "legacy:1", "type": "compaction", "trigger": "manual", "tokens_before": 1234, "summary": "Summary so far", "created_at": "2026-11-01T00:00:01.000Z"}));
    assert_eq!(disposition(&c, 3), Disposition::Redundant);
    assert_eq!(items["legacy:4"]["ok"], false);
    assert_eq!(items["legacy:4"]["interrupted"], true);
    assert_eq!(items["legacy:4"]["error"], "error_during_execution");
}

#[test]
fn what_the_history_doesnt_say() {
    let long = format!("{}\n… [truncated 5 bytes]", "x".repeat(30_000));
    let c = convert_all(&[
        // A result before its call, a call with no result, and a result with no call.
        results(1, None, json!([{"type": "tool_result", "tool_use_id": "early", "content": "first"}])),
        assistant(2, None, json!([{"type": "tool_use", "id": "early", "name": "Read", "input": {}}, {"type": "tool_use", "id": "open", "name": "Grep", "input": {"pattern": "x"}}])),
        results(3, None, json!([{"type": "tool_result", "tool_use_id": "nowhere", "content": "?"}])),
        // The same call id again.
        assistant(4, None, json!([{"type": "tool_use", "id": "early", "name": "Read", "input": {}}])),
        results(5, None, json!([{"type": "tool_result", "tool_use_id": "early", "content": long}])),
        assistant(6, Some("missing"), json!([{"type": "text", "text": "orphan"}])),
        msg(7, "claude", json!({"type": "system", "subtype": "task_updated", "task_id": "never"})),
        msg(8, "claude", json!({"type": "system", "subtype": "hook_response"})),
        results(9, None, json!([{"type": "text", "text": "[Request interrupted by user]"}])),
        msg(10, "mystery", json!({})),
    ]);
    let items = items(&c);
    assert_eq!(items["early"]["result"]["content"], "first");
    assert_eq!(items["open"]["status"], "cancelled");
    assert_eq!(items["legacy:4:0"]["result"]["truncated"], true);
    assert_eq!(items["legacy:6:0"]["parent_id"], "missing");
    assert_eq!(items["legacy:9"]["code"], "interrupted");
    let mut got = codes(&c);
    got.sort();
    assert_eq!(got, ["duplicate_call", "missing_parent", "no_result", "orphan_result", "unknown_claude", "unknown_kind", "unknown_task"]);
    for id in [3, 7, 8, 10] {
        assert_eq!(disposition(&c, id), Disposition::Retained, "{id}");
    }
    assert_eq!(c.rows.len(), 10);
}

#[test]
fn codex_file_changes_are_edits() {
    let input = json!({"changes": [{"path": "/a.rs", "kind": "add", "diff": "+x"}, {"path": "/b.rs", "kind": "update", "move_path": "/c.rs", "diff": "@@"}]});
    let t = task();
    let messages = [assistant(1, None, json!([{"type": "tool_use", "id": "p", "name": "ApplyPatch", "input": input}]))];
    let c = convert(&Source { task: &t, harness: "codex", messages: &messages }).unwrap();
    assert_eq!(c.thread.harness, "codex");
    let Item::ToolCall(call) = &c.snapshot.items[0] else { panic!() };
    assert_eq!(serde_json::to_value(&call.changes).unwrap(), json!([{"path": "/a.rs", "op": "add", "diff": "+x"}, {"path": "/b.rs", "op": "update", "move_to": "/c.rs", "diff": "@@"}]));
}

#[test]
fn staging_is_idempotent_and_replaces_an_older_import() {
    testing::run(async || {
        let s = testing::state();
        let t = testing::task(&s);
        let store = HuntawayStore::new(Arc::downgrade(&s));
        let mut messages = vec![msg(1, "user", json!({"text": "hi"})), assistant(2, None, json!([{"type": "text", "text": "hello"}]))];
        let conv = |m: &[Message]| convert(&Source { task: &t, harness: "claude", messages: m }).unwrap();
        assert_eq!(stage(&store, &conv(&messages)).await.unwrap(), Staged::Staged);
        assert_eq!(stage(&store, &conv(&messages)).await.unwrap(), Staged::Unchanged);
        messages.push(msg(3, "user", json!({"text": "more"})));
        assert_eq!(stage(&store, &conv(&messages)).await.unwrap(), Staged::Staged);
        assert_eq!(store.last_seq(&t.id).await.unwrap(), 4);
        let snapshot = store.load_snapshot(&t.id).await.unwrap().unwrap();
        assert_eq!(snapshot["items"].as_array().unwrap().len(), 3);
        // Cut short before its snapshot (a crash, say): staged again.
        s.db().execute("DELETE FROM at_snapshots", []).unwrap();
        assert_eq!(stage(&store, &conv(&messages)).await.unwrap(), Staged::Staged);
        // A thread that wasn't imported is left alone.
        store.delete_thread(&t.id).await.unwrap();
        store.create_thread(&json!({"id": t.id, "harness": "claude", "status": "idle", "created_at": "2026-11-01T00:00:00Z"})).await.unwrap();
        assert!(stage(&store, &conv(&messages)).await.is_err());
        assert_eq!(store.last_seq(&t.id).await.unwrap(), 0);
    })
}

/// What the board stores for a Codex run whose child agent compacts and completes, written by its own
/// Codex output handler (agent/codex/output.rs) from app-server notifications.
#[test]
fn codex_children_as_the_board_stores_them() {
    use crate::agent::codex::handle_line;
    let s = testing::state();
    let t = testing::task(&s);
    let run = crate::db::insert_run(&s.db(), &t.id, "prompt").unwrap();
    let send = |method: &str, thread: &str, mut params: Value| {
        params["threadId"] = json!(thread);
        handle_line(&s, &run, &json!({"method": method, "params": params})).unwrap();
    };
    let item = |thread: &str, item: Value| {
        send("item/started", thread, json!({"item": item}));
        send("item/completed", thread, json!({"item": item}));
    };
    handle_line(&s, &run, &json!({"method": "thread/started", "params": {"thread": {"id": "main"}}})).unwrap();
    item("main", json!({"type": "collabAgentToolCall", "id": "spawn", "tool": "spawnAgent", "status": "completed", "senderThreadId": "main",
        "receiverThreadIds": ["child"], "prompt": "Inspect config", "model": "gpt-6.1-sol", "agentsStates": {"child": {"status": "running"}}}));
    item("child", json!({"type": "agentMessage", "id": "text", "text": "Reading"}));
    item("child", json!({"type": "contextCompaction", "id": "squash"}));
    item("main", json!({"type": "collabAgentToolCall", "id": "wait", "tool": "wait", "status": "completed", "senderThreadId": "main",
        "receiverThreadIds": ["child"], "agentsStates": {"child": {"status": "completed", "message": "Config is fine"}}}));
    let messages = crate::db::list_messages(&s.db(), &t.id).unwrap();
    let c = convert(&Source { task: &t, harness: "codex", messages: &messages }).unwrap();
    let items = items(&c);
    let agent = &items["codex-agent-child"];
    assert_eq!(agent["status"], "completed", "{agent}");
    assert_eq!(agent["subagent"]["status"], "completed");
    assert_eq!(agent["subagent"]["background"], true);
    assert_eq!(agent["subagent"]["model"], "gpt-6.1-sol");
    assert_eq!(agent["subagent"]["summary"], "Config is fine");
    // The child's compaction stays in the child's conversation.
    let compaction = items.values().find(|i| i["type"] == "compaction").unwrap();
    assert_eq!(compaction["parent_id"], "codex-agent-child");
    assert!(c.warnings.is_empty(), "{:?}", c.warnings);
    assert_eq!(c.count(Disposition::Retained), 0);
}

#[test]
fn a_prompt_before_a_call_with_a_reused_id_is_for_that_call() {
    let c = convert_all(&[
        assistant(1, None, json!([{"type": "tool_use", "id": "c", "name": "Bash", "input": {"command": "ls"}}])),
        results(2, None, json!([{"type": "tool_result", "tool_use_id": "c", "content": "a"}])),
        msg(3, "permission", json!({"tool_name": "Bash", "input": {"command": "rm x"}, "tool_use_id": "c", "request_id": "r1", "status": "denied"})),
        assistant(4, Some("ag"), json!([{"type": "tool_use", "id": "c", "name": "Bash", "input": {"command": "rm x"}}])),
        results(5, Some("ag"), json!([{"type": "tool_result", "tool_use_id": "c", "content": "Denied", "is_error": true}])),
        // A prompt after both have their results can't be told apart.
        msg(6, "permission", json!({"tool_name": "Bash", "input": {}, "tool_use_id": "c", "request_id": "r2", "status": "allowed"})),
    ]);
    let items = items(&c);
    assert_eq!((&items["c"]["status"], &items["c"]["result"]["content"]), (&json!("completed"), &json!("a")));
    assert_eq!((&items["legacy:4:0"]["status"], &items["legacy:4:0"]["result"]["content"]), (&json!("denied"), &json!("Denied")));
    let requests: Vec<Value> = c.snapshot.requests.iter().map(|r| serde_json::to_value(r).unwrap()).collect();
    assert_eq!(requests[0]["tool_call_id"], "legacy:4:0");
    // Its parent is the second call's, which isn't in the thread.
    assert_eq!(requests[0]["parent_id"], "ag");
    assert!(requests[1].get("tool_call_id").is_none());
    let mut got = codes(&c);
    got.sort();
    assert_eq!(got, ["ambiguous_call", "duplicate_call", "missing_parent", "missing_parent"]);
}

#[test]
fn a_subagents_compaction_and_its_summary_stay_in_it() {
    let c = convert_all(&[
        assistant(1, None, json!([{"type": "tool_use", "id": "ag", "name": "Agent", "input": {}}])),
        msg(2, "claude", json!({"type": "system", "subtype": "compact_boundary", "parent_tool_use_id": "ag", "compact_metadata": {"trigger": "auto"}})),
        assistant(3, None, json!([{"type": "text", "text": "Meanwhile"}])),
        msg(4, "claude", json!({"type": "user", "isSynthetic": true, "parent_tool_use_id": "ag", "message": {"content": "Child summary"}})),
        results(5, None, json!([{"type": "tool_result", "tool_use_id": "ag", "content": "done"}])),
    ]);
    let items = items(&c);
    assert_eq!(items["legacy:2"]["parent_id"], "ag");
    assert_eq!(items["legacy:2"]["summary"], "Child summary");
    assert!(c.warnings.is_empty(), "{:?}", c.warnings);
}

#[test]
fn calls_with_one_id_in_two_subagents_get_their_own_results() {
    let c = convert_all(&[
        assistant(1, None, json!([{"type": "tool_use", "id": "a", "name": "Agent", "input": {}}, {"type": "tool_use", "id": "b", "name": "Agent", "input": {}}])),
        assistant(2, Some("a"), json!([{"type": "tool_use", "id": "c", "name": "Bash", "input": {"command": "ls a"}}])),
        assistant(3, Some("b"), json!([{"type": "tool_use", "id": "c", "name": "Bash", "input": {"command": "ls b"}}])),
        results(4, Some("a"), json!([{"type": "tool_result", "tool_use_id": "c", "content": "out a"}])),
        results(5, Some("b"), json!([{"type": "tool_result", "tool_use_id": "c", "content": "out b"}])),
    ]);
    let items = items(&c);
    assert_eq!((&items["c"]["parent_id"], &items["c"]["result"]["content"]), (&json!("a"), &json!("out a")));
    assert_eq!((&items["legacy:3:0"]["parent_id"], &items["legacy:3:0"]["result"]["content"]), (&json!("b"), &json!("out b")));
}

#[test]
fn a_result_two_calls_with_its_id_wait_for_goes_to_neither() {
    let c = convert_all(&[
        assistant(1, None, json!([{"type": "tool_use", "id": "c", "name": "Bash", "input": {"command": "one"}}])),
        assistant(2, None, json!([{"type": "tool_use", "id": "c", "name": "Bash", "input": {"command": "two"}}])),
        results(3, None, json!([{"type": "tool_result", "tool_use_id": "c", "content": "which?"}])),
    ]);
    let items = items(&c);
    assert_eq!((&items["c"]["status"], &items["legacy:2:0"]["status"]), (&json!("cancelled"), &json!("cancelled")));
    assert!(items.values().all(|i| i.get("result").is_none()));
    assert_eq!(disposition(&c, 3), Disposition::Retained);
    assert_eq!(codes(&c), ["duplicate_call", "ambiguous_call", "no_result"]);
}

/// A call with id `c` in session `session`, and its result if it has one.
fn bash(id: i64, session: &str, command: &str) -> Message {
    msg(id, "claude", json!({"type": "assistant", "session_id": session, "message": {"content": [{"type": "tool_use", "id": "c", "name": "Bash", "input": {"command": command}}]}}))
}

fn bash_denied(id: i64, session: &str) -> Message {
    msg(id, "claude", json!({"type": "user", "session_id": session, "message": {"content": [{"type": "tool_result", "tool_use_id": "c", "content": "Denied", "is_error": true}]}}))
}

#[test]
fn a_prompt_before_a_reused_id_whose_first_call_never_returned() {
    let denied = |command: &str| msg(2, "permission", json!({"tool_name": "Bash", "input": {"command": command}, "tool_use_id": "c", "request_id": "r", "status": "denied"}));
    // Its input tells the calls apart.
    let c = convert_all(&[bash(1, "s1", "ls"), denied("rm x"), bash(3, "s2", "rm x"), bash_denied(4, "s2")]);
    let items = items(&c);
    assert_eq!(serde_json::to_value(&c.snapshot.requests[0]).unwrap()["tool_call_id"], "legacy:3:0");
    assert_eq!((&items["legacy:3:0"]["status"], &items["c"]["status"]), (&json!("denied"), &json!("cancelled")));
    // The same input: no telling which call asked, and the result is only the new session's call's.
    let c = convert_all(&[bash(1, "s1", "rm x"), denied("rm x"), bash(3, "s2", "rm x"), bash_denied(4, "s2")]);
    let same = super::tests::items(&c);
    assert!(serde_json::to_value(&c.snapshot.requests[0]).unwrap().get("tool_call_id").is_none());
    assert_eq!((&same["legacy:3:0"]["status"], &same["c"]["status"]), (&json!("failed"), &json!("cancelled")));
    assert!(codes(&c).contains(&"ambiguous_call"));
}

#[test]
fn a_subagents_compaction_and_summary_before_its_call() {
    let c = convert_all(&[
        msg(1, "claude", json!({"type": "system", "subtype": "compact_boundary", "compact_metadata": {"trigger": "auto"}})),
        msg(2, "claude", json!({"type": "system", "subtype": "compact_boundary", "parent_tool_use_id": "ag", "compact_metadata": {"trigger": "auto"}})),
        msg(3, "claude", json!({"type": "user", "isSynthetic": true, "parent_tool_use_id": "ag", "message": {"content": "Child summary"}})),
        assistant(4, None, json!([{"type": "tool_use", "id": "ag", "name": "Agent", "input": {}}])),
        results(5, None, json!([{"type": "tool_result", "tool_use_id": "ag", "content": "done"}])),
    ]);
    let items = items(&c);
    assert_eq!((&items["legacy:2"]["parent_id"], &items["legacy:2"]["summary"]), (&json!("ag"), &json!("Child summary")));
    assert!(items["legacy:1"].get("summary").is_none());
    assert!(c.warnings.is_empty(), "{:?}", c.warnings);
}

#[test]
fn a_result_before_its_agent_call_keeps_what_the_board_kept_of_it() {
    let call = assistant(2, None, json!([{"type": "tool_use", "id": "ag", "name": "Agent", "input": {"description": "Away"}}]));
    let meta = json!({"agentId": "x", "resolvedModel": "haiku", "agentType": "Explore", "totalToolUseCount": 3, "isAsync": true, "status": "async_launched"});
    let result = |id| msg(id, "claude", json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "ag", "content": "Launched"}]}, "tool_use_result": meta}));
    let early = convert_all(&[result(1), call.clone()]);
    let in_order = convert_all(&[call, result(3)]);
    let (early, in_order) = (&items(&early)["ag"], &items(&in_order)["ag"]);
    assert_eq!(early["subagent"], json!({"status": "stopped", "background": true, "model": "haiku", "agent_type": "Explore", "tool_uses": 3}));
    assert_eq!((&early["status"], &early["subagent"]), (&in_order["status"], &in_order["subagent"]));
}

#[test]
fn a_prompt_before_two_calls_with_its_id_is_for_the_one_with_its_input() {
    let c = convert_all(&[
        assistant(1, None, json!([{"type": "tool_use", "id": "a", "name": "Agent", "input": {}}, {"type": "tool_use", "id": "b", "name": "Agent", "input": {}}])),
        msg(2, "permission", json!({"tool_name": "Bash", "input": {"command": "ls b"}, "tool_use_id": "c", "request_id": "r", "status": "denied"})),
        assistant(3, Some("a"), json!([{"type": "tool_use", "id": "c", "name": "Bash", "input": {"command": "ls a"}}])),
        assistant(4, Some("b"), json!([{"type": "tool_use", "id": "c", "name": "Bash", "input": {"command": "ls b"}}])),
        results(5, Some("a"), json!([{"type": "tool_result", "tool_use_id": "c", "content": "out a"}])),
        results(6, Some("b"), json!([{"type": "tool_result", "tool_use_id": "c", "content": "Denied", "is_error": true}])),
        // Neither call has this input: no telling.
        msg(7, "permission", json!({"tool_name": "Bash", "input": {"command": "ls c"}, "tool_use_id": "c", "request_id": "r2", "status": "allowed"})),
    ]);
    let request = serde_json::to_value(&c.snapshot.requests[0]).unwrap();
    assert_eq!((&request["tool_call_id"], &request["parent_id"]), (&json!("legacy:4:0"), &json!("b")));
    let items = items(&c);
    assert_eq!((&items["c"]["status"], &items["legacy:4:0"]["status"]), (&json!("completed"), &json!("denied")));
    assert!(serde_json::to_value(&c.snapshot.requests[1]).unwrap().get("tool_call_id").is_none());
    // The agents never got results.
    assert_eq!(codes(&c), ["duplicate_call", "ambiguous_call", "no_result"]);
}

/// A task (on Codex with `codex`) with a run that's going, so its agent's prompts are asked.
fn running(s: &crate::state::Shared, codex: bool) -> crate::db::Task {
    let config = codex.then(|| crate::db::insert_claude_config(&s.db(), "Codex", "", "codex").unwrap().id);
    let ids: Vec<String> = config.iter().cloned().collect();
    let profile = crate::db::insert_profile(&s.db(), "p", &ids, None).unwrap();
    let t = crate::db::NewTask {
        profile_id: &profile.id,
        project_id: None,
        kind: "task",
        title: "t",
        description: "",
        status: "in_progress",
        use_worktree: false,
        model: None,
        effort: None,
        claude_config_id: config.as_deref(),
    };
    let task = crate::db::insert_task(&s.db(), t).unwrap();
    let run = crate::db::insert_run(&s.db(), &task.id, "prompt").unwrap();
    s.db().execute("UPDATE runs SET status='running' WHERE id=?1", [&run.id]).unwrap();
    s.runs.lock().unwrap().insert(task.id.clone(), crate::state::RunHandle { run_id: run.id.clone(), cancel: None });
    s.update_task(&task.id, &[("running", json!(true))]).unwrap().unwrap()
}

/// The questions in `input` asked by `tool` as the board asks them, answered with `answers` as the board answers
/// them, and the thread's messages then.
async fn answered(codex: bool, tool: &str, input: Value, answers: Vec<Vec<&str>>) -> (crate::db::Task, Vec<Message>) {
    use crate::mcp::permissions;
    let s = testing::state();
    let task = running(&s, codex);
    let (s2, t2, tool2, input2) = (s.clone(), task.clone(), tool.to_string(), input.clone());
    let told = tokio::spawn(async move { permissions::prompt(&s2, &t2, "call", &tool2, &input2, None).await.unwrap() });
    let id = loop {
        if let Ok(id) = s.db().query_row("SELECT id FROM permission_requests WHERE call_id='call'", [], |r| r.get::<_, String>(0)) {
            break id;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    };
    let answers = answers.into_iter().map(|a| a.into_iter().map(String::from).collect()).collect();
    permissions::answer(&s, &id, true, false, None, permissions::Reply { answers: Some(answers), ..Default::default() }).unwrap();
    told.await.unwrap();
    let messages = crate::db::list_messages(&s.db(), &task.id).unwrap();
    (task, messages)
}

#[test]
fn answers_to_claudes_questions_as_the_board_keeps_them() {
    testing::run(async || {
        let input = json!({"questions": [
            {"question": "Which season?", "header": "Season", "multiSelect": false, "options": [{"label": "Summer"}, {"label": "Winter"}]},
            {"question": "Which pets?", "header": "Pets", "multiSelect": true, "options": [{"label": "Cats"}, {"label": "Dogs"}]},
            {"question": "Anything else?", "options": [{"label": "No"}]}
        ]});
        let (task, messages) = answered(false, crate::mcp::permissions::ASK_USER, input, vec![vec!["Summer"], vec!["Cats", "a lizard"], vec![]]).await;
        let c = convert(&Source { task: &task, harness: "claude", messages: &messages }).unwrap();
        let request = serde_json::to_value(&c.snapshot.requests[0]).unwrap();
        assert_eq!(request["resolution"], json!({"outcome": "answer", "answers": {"0": ["Summer"], "1": ["Cats", "a lizard"]}}));
        assert!(c.warnings.is_empty(), "{:?}", c.warnings);
    })
}

#[test]
fn answers_to_codexs_questions_as_the_board_keeps_them() {
    testing::run(async || {
        let input = json!({"questions": [
            {"id": "name", "question": "Which name?", "options": [{"label": "a.txt", "description": ""}], "isOther": true, "isSecret": false},
            {"id": "token", "question": "Your token?", "options": [], "isOther": true, "isSecret": true}
        ]});
        let (task, messages) = answered(true, crate::mcp::permissions::CODEX_QUESTIONS, input, vec![vec!["b.txt"], vec!["s3cret"]]).await;
        let c = convert(&Source { task: &task, harness: "codex", messages: &messages }).unwrap();
        let request = serde_json::to_value(&c.snapshot.requests[0]).unwrap();
        assert_eq!(request["questions"][1], json!({"id": "token", "question": "Your token?", "allow_other": true, "secret": true}));
        // The secret stays hidden, as the board kept it.
        assert_eq!(request["resolution"], json!({"outcome": "answer", "answers": {"name": ["b.txt"], "token": ["(hidden)"]}}));
        assert!(c.warnings.is_empty(), "{:?}", c.warnings);
    })
}

#[test]
fn a_prompt_matching_no_call_with_its_reused_id_is_for_none() {
    let c = convert_all(&[
        bash(1, "s1", "ls a"),
        msg(2, "claude", json!({"type": "user", "session_id": "s1", "message": {"content": [{"type": "tool_result", "tool_use_id": "c", "content": "a"}]}})),
        msg(3, "permission", json!({"tool_name": "Bash", "input": {"command": "rm c"}, "tool_use_id": "c", "request_id": "r", "status": "denied"})),
        bash(4, "s2", "ls b"),
        bash_denied(5, "s2"),
    ]);
    assert!(serde_json::to_value(&c.snapshot.requests[0]).unwrap().get("tool_call_id").is_none());
    let items = items(&c);
    assert_eq!((&items["c"]["status"], &items["legacy:4:0"]["status"]), (&json!("completed"), &json!("failed")));
    // (The test task's session is s1.)
    assert_eq!(codes(&c), ["ambiguous_call", "duplicate_call", "session_mismatch"]);
}

#[test]
fn what_a_turn_ended_by_saying_and_where_items_came_from() {
    let c = convert_all(&[
        msg(1, "user", json!({"text": "Go\n\nFrom IA-2", "user_text": "Go"})),
        assistant(2, None, json!([{"type": "text", "text": "Done."}])),
        msg(3, "claude", json!({"type": "result", "subtype": "success", "result": "Done.", "num_turns": 1})),
        // A turn a background subagent's report started: its result is all it said.
        msg(4, "claude", json!({"type": "result", "subtype": "success", "result": "The report is in.", "num_turns": 1})),
        msg(5, "claude", json!({"type": "result", "subtype": "error_during_execution", "is_error": true, "result": "Boom"})),
        assistant(6, None, json!([{"type": "tool_use", "id": "a1", "name": "Agent", "input": {"description": "d"}}])),
        msg(7, "claude", json!({"type": "system", "subtype": "task_started", "task_id": "t1", "tool_use_id": "a1", "task_type": "local_agent", "session_id": "s1"})),
        msg(8, "user", json!({"text": "Start working on this task.", "auto": true})),
        msg(9, "user", json!({"text": "Rebase", "from_agent": true})),
    ]);
    let ids: Vec<&str> = c.snapshot.items.iter().map(|i| i.id()).collect();
    assert_eq!(ids, ["legacy:1", "legacy:2:0", "legacy:3", "legacy:4:result", "legacy:4", "legacy:5", "a1", "legacy:8", "legacy:9"]);
    assert_eq!(items(&c)["legacy:4:result"], json!({"id": "legacy:4:result", "type": "assistant_message", "text": "The report is in.", "created_at": "2026-11-01T00:00:04.000Z"}));
    assert_eq!(items(&c)["legacy:5"]["error"], "Boom");
    let at = |m: i64| Origin { message_id: Some(m), ..Default::default() };
    assert_eq!(c.origins["legacy:1"], Origin { user_text: Some("Go".into()), ..at(1) });
    assert_eq!(c.origins["legacy:4:result"], Origin { from_result: true, ..at(4) });
    // Each turn's result's text, whichever way it went.
    assert_eq!(c.origins["legacy:3"], Origin { result_text: Some("Done.".into()), ..at(3) });
    assert_eq!(c.origins["legacy:4"], Origin { result_text: Some("The report is in.".into()), ..at(4) });
    assert_eq!(c.origins["legacy:5"], Origin { result_text: Some("Boom".into()), ..at(5) });
    assert_eq!(c.origins["a1"], Origin { subagent_task: Some("t1".into()), ..at(6) });
    assert_eq!(c.origins["legacy:8"], Origin { auto: true, ..at(8) });
    assert_eq!(c.origins["legacy:9"], Origin { from_agent: true, ..at(9) });
    // Most of that the ids say.
    assert_eq!(Origin::implied("legacy:4:result"), at(4));
    assert_eq!(Origin::implied("a1"), Origin::default());
}
