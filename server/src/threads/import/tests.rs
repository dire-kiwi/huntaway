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
