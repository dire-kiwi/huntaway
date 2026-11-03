use std::fmt::Debug;
use std::sync::Arc;

use serde_json::json;

use super::*;
use crate::state::Shared;
use crate::testing;
use crate::threads::store::HuntawayStore;

fn said(text: &str) -> Value {
    json!({"type": "assistant", "message": {"content": [{"type": "thinking", "thinking": "hm"}, {"type": "text", "text": text}]}})
}

fn add(s: &Shared, task: &str, kind: &str, data: Value) -> i64 {
    db::insert_message(&s.db(), task, kind, &data).unwrap().id
}

/// Runs `f` with every task on the thread layer `e`.
fn on<T>(e: Engine, f: impl FnOnce() -> T) -> T {
    ENGINE.set(Some(e));
    let out = f();
    ENGINE.set(None);
    out
}

/// What `f` reads in task `task`'s thread, as its legacy messages and as the agent-threads thread their
/// import is (staged and read from the store): they must agree.
async fn both<T: PartialEq + Debug>(s: &Shared, task: &str, f: impl Fn(&Connection) -> T) -> T {
    let legacy = on(Engine::Legacy, || f(&s.db()));
    let (t, messages) = {
        let c = s.db();
        (db::get_task(&c, task).unwrap().unwrap(), db::list_messages(&c, task).unwrap())
    };
    let conv = import::convert(&Source { task: &t, harness: "claude", messages: &messages }).unwrap();
    import::stage(&HuntawayStore::new(Arc::downgrade(s)), &conv).await.unwrap();
    let stored = on(Engine::AgentThreads, || f(&s.db()));
    assert_eq!(legacy, stored, "the legacy thread and its import disagree");
    legacy
}

#[test]
fn user_replies_are_the_users_own_messages_after_what_the_agent_said() {
    testing::run(async || {
        let s = testing::state();
        let t = testing::task(&s).id;
        add(&s, &t, "user", json!({"text": "Start working on this task.", "auto": true, "start": true}));
        add(&s, &t, "user", json!({"text": "Also do the docs"}));
        add(&s, &t, "claude", said("Working on it."));
        add(&s, &t, "claude", json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Bash", "input": {}}]}}));
        add(&s, &t, "claude", said("Should it be A or B?"));
        add(&s, &t, "event", json!({"level": "info", "text": "Needs attention"}));
        add(&s, &t, "user", json!({"text": " A is fine, B is too slow \n", "steered": true}));
        add(&s, &t, "user", json!({"text": "and keep the old flag"}));
        add(&s, &t, "claude", said("Done."));
        add(&s, &t, "user", json!({"text": "Fix this from IA-2", "from_agent": true}));
        add(&s, &t, "user", json!({"text": "Serious issues found in your changes", "auto": true}));
        let all = vec![
            (None, "Also do the docs".to_string()),
            (Some("Should it be A or B?".to_string()), "A is fine, B is too slow".to_string()),
            (None, "and keep the old flag".to_string()),
        ];
        let done = Some("Done.".to_string());
        let replies = |limit| {
            let t = t.clone();
            move |c: &Connection| user_replies(c, &t, limit).unwrap()
        };
        assert_eq!(both(&s, &t, replies(None)).await, UserReplies { replies: all.clone(), since: done.clone(), earlier: 0 });
        // Only the latest, with how many are left out.
        for n in 0..=4 {
            let skip = 3usize.saturating_sub(n);
            assert_eq!(both(&s, &t, replies(Some(n))).await, UserReplies { replies: all[skip..].to_vec(), since: done.clone(), earlier: skip }, "limit {n}");
        }
        add(&s, &t, "user", json!({"text": "Ship it"}));
        let r = both(&s, &t, replies(Some(1))).await;
        assert_eq!(r, UserReplies { replies: vec![(done, "Ship it".to_string())], since: None, earlier: 3 });
    })
}

#[test]
fn user_replies_read_a_long_thread_only_back_to_the_latest() {
    testing::run(async || {
        let s = testing::state();
        let t = testing::task(&s).id;
        // More messages than the first window has.
        for i in 0..200 {
            add(&s, &t, "claude", json!({"type": "assistant", "message": {"content": [{"type": "text", "text": format!("Question {i}?")}]}}));
            add(&s, &t, "user", json!({"text": format!("Answer {i}")}));
            add(&s, &t, "claude", json!({"type": "user", "message": {"content": [{"type": "tool_result", "content": "x".repeat(1000)}]}}));
        }
        let all = both(&s, &t, |c| user_replies(c, &t, None).unwrap()).await;
        assert_eq!((all.replies.len(), &all.since, all.earlier), (200, &None, 0));
        let r = both(&s, &t, |c| user_replies(c, &t, Some(30)).unwrap()).await;
        assert_eq!(r.replies, all.replies[170..]);
        assert_eq!((r.since, r.earlier), (None, 170));
        assert_eq!(r.replies[0], (Some("Question 170?".to_string()), "Answer 170".to_string()));
        // Read back only as far as those, not the whole thread.
        let c = s.db();
        let task = db::get_task(&c, &t).unwrap().unwrap();
        let mut whole = Vec::new();
        read_back_on(&c, &task, Engine::Legacy, Part::Said, &mut |h| {
            whole.push(h.whole);
            h.user_replies(Some(30))
        })
        .unwrap();
        assert_eq!(whole.last(), Some(&false));
    })
}

#[test]
fn a_users_message_sent_with_other_agents_counts_only_their_part() {
    testing::run(async || {
        let s = testing::state();
        let t = testing::task(&s).id;
        add(&s, &t, "user", json!({"text": "Build a payment gateway\n\nAdd a search cache", "user_text": "Add a search cache"}));
        add(&s, &t, "claude", json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "A or B?"}]}}));
        let r = both(&s, &t, |c| user_replies(c, &t, None).unwrap()).await;
        assert_eq!((r.replies, r.since), (vec![(None, "Add a search cache".to_string())], Some("A or B?".to_string())));
    })
}

#[test]
fn the_last_thing_the_agent_said() {
    testing::run(async || {
        let s = testing::state();
        let t = testing::task(&s).id;
        let last = |c: &Connection| (last_said(c, &t).unwrap(), said_since_asked(c, &t).unwrap());
        assert_eq!(both(&s, &t, last).await, (None, None));
        add(&s, &t, "user", json!({"text": "Go"}));
        // A message's text blocks, joined.
        let blocks = json!([{"type": "text", "text": "First,"}, {"type": "tool_use", "id": "b1", "name": "Bash", "input": {"command": "ls"}}, {"type": "text", "text": "then."}]);
        add(&s, &t, "claude", json!({"type": "assistant", "message": {"content": blocks}}));
        add(&s, &t, "claude", json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "b1", "content": "a.rs"}]}}));
        assert_eq!(both(&s, &t, last).await, (Some("First,\nthen.".into()), Some("First,\nthen.".into())));
        add(&s, &t, "claude", said("Done."));
        add(&s, &t, "claude", json!({"type": "result", "subtype": "success", "is_error": false, "result": "Done.", "num_turns": 1}));
        assert_eq!(both(&s, &t, last).await, (Some("Done.".into()), Some("Done.".into())));
        // Asked again, it has said nothing since.
        add(&s, &t, "user", json!({"text": "And the docs?", "auto": true}));
        assert_eq!(both(&s, &t, last).await, (Some("Done.".into()), None));
        // A turn that failed with nothing to say about it leaves what it said before.
        add(&s, &t, "claude", json!({"type": "result", "subtype": "error_during_execution", "is_error": true, "result": null}));
        assert_eq!(both(&s, &t, last).await, (Some("Done.".into()), None));
        // One that says what went wrong, says that.
        add(&s, &t, "claude", json!({"type": "result", "subtype": "success", "is_error": true, "result": "You've hit your limit · resets 3pm"}));
        assert_eq!(both(&s, &t, last).await, (Some("You've hit your limit · resets 3pm".into()), Some("You've hit your limit · resets 3pm".into())));
        // And it's what the user answered, if they did then.
        let limit = json!({"type": "assistant", "is_api_error_message": true, "message": {"content": [{"type": "text", "text": "You've hit your limit"}]}});
        add(&s, &t, "claude", limit);
        add(&s, &t, "claude", json!({"type": "result", "subtype": "success", "is_error": true, "result": "You've hit your limit"}));
        add(&s, &t, "user", json!({"text": "start again"}));
        let replies = both(&s, &t, |c| user_replies(c, &t, Some(1)).unwrap()).await;
        assert_eq!(replies.replies, [(Some("You've hit your limit".to_string()), "start again".to_string())]);
        // A subagent's messages count too.
        add(&s, &t, "claude", json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "a1", "name": "Agent", "input": {"description": "look", "prompt": "p"}}]}}));
        add(&s, &t, "claude", json!({"type": "assistant", "parent_tool_use_id": "a1", "message": {"content": [{"type": "text", "text": "Looking."}]}}));
        assert_eq!(both(&s, &t, last).await, (Some("Looking.".into()), Some("Looking.".into())));
    })
}

#[test]
fn what_the_agent_said_long_ago_is_read_back_to() {
    testing::run(async || {
        let s = testing::state();
        let t = testing::task(&s).id;
        add(&s, &t, "user", json!({"text": "Fix it"}));
        add(&s, &t, "claude", said("On it."));
        add(&s, &t, "user", json!({"text": "Thanks"}));
        // More tool calls since than the first windows have.
        for i in 0..1000 {
            let call = format!("c{i}");
            add(&s, &t, "claude", json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": call, "name": "Read", "input": {"file_path": "a"}}]}}));
            add(&s, &t, "claude", json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": call, "content": "x"}]}}));
        }
        let read = |c: &Connection| (last_said(c, &t).unwrap(), said_since_asked(c, &t).unwrap(), user_replies(c, &t, Some(1)).unwrap());
        let replies = UserReplies { replies: vec![(Some("On it.".into()), "Thanks".into())], since: None, earlier: 1 };
        assert_eq!(both(&s, &t, read).await, (Some("On it.".into()), None, replies));
    })
}

#[test]
fn tool_calls_since_a_time_and_the_code_they_changed() {
    testing::run(async || {
        let s = testing::state();
        let t = testing::task(&s).id;
        let at = |s: &Shared, id: i64, minute: u32| {
            s.db().execute("UPDATE messages SET created_at=?1 WHERE id=?2", params![format!("2026-11-01T10:{minute:02}:00.000Z"), id]).unwrap();
        };
        let call = |s: &Shared, minute: u32, id: &str, name: &str, input: Value, result: Option<(bool, &str)>| {
            let m = add(s, &t, "claude", json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": id, "name": name, "input": input}]}}));
            at(s, m, minute);
            if let Some((is_error, text)) = result {
                let r = add(s, &t, "claude", json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": id, "is_error": is_error, "content": text}]}}));
                at(s, r, minute);
            }
        };
        call(&s, 0, "edit", "Edit", json!({"file_path": "/a.rs"}), Some((false, "ok")));
        call(&s, 1, "commit", "Bash", json!({"command": "git commit -am x"}), Some((true, "The user denied this action.")));
        call(&s, 2, "ls", "Bash", json!({"command": "ls"}), Some((false, "a.rs")));
        call(&s, 3, "write", "Write", json!({"file_path": "/b.rs"}), Some((true, "no such directory")));
        call(&s, 4, "rm", "Bash", json!({"command": "rm a.rs"}), None);
        call(&s, 5, "patch", "mcp__codex__apply", json!({}), Some((false, "ok")));
        let changing = |since: Option<&'static str>| {
            let t = t.clone();
            move |c: &Connection| -> (usize, Vec<String>) {
                let calls = tool_calls_since(c, &t, since).unwrap();
                (calls.len(), calls.iter().filter(|c| crate::git::changes::changes_code(c)).map(|c| c.id.clone()).collect())
            }
        };
        assert_eq!(both(&s, &t, changing(None)).await, (6, vec!["edit".to_string(), "rm".to_string()]));
        assert_eq!(both(&s, &t, changing(Some("2026-11-01T10:01:30.000Z"))).await, (4, vec!["rm".to_string()]));
        assert_eq!(both(&s, &t, changing(Some("2026-11-01T10:05:00.000Z"))).await, (0, vec![]));
    })
}

#[test]
fn the_user_wrote_since_unless_the_board_or_an_agent_did() {
    testing::run(async || {
        let s = testing::state();
        let t = testing::task(&s).id;
        let since = "2000-01-01T00:00:00Z";
        add(&s, &t, "user", json!({"text": "Start working on this task.", "auto": true}));
        add(&s, &t, "user", json!({"text": "From IA-2", "from_agent": true}));
        assert!(!both(&s, &t, |c| user_wrote_since(c, &t, since).unwrap()).await);
        add(&s, &t, "user", json!({"text": "From me"}));
        assert!(both(&s, &t, |c| user_wrote_since(c, &t, since).unwrap()).await);
        assert!(!both(&s, &t, |c| user_wrote_since(c, &t, "2999-01-01T00:00:00Z").unwrap()).await);
    })
}

#[test]
fn subagents_by_their_calls_and_claudes_task_ids() {
    testing::run(async || {
        let s = testing::state();
        let t = testing::task(&s).id;
        let call = |s: &Shared, session: &str, id: &str, name: &str| {
            add(s, &t, "claude", json!({"type": "assistant", "session_id": session, "message": {"content": [{"type": "tool_use", "id": id, "name": name, "input": {"description": "d", "prompt": "p"}}]}}));
        };
        let started = |s: &Shared, session: &str, task: &str, call: &str, kind: &str| {
            add(s, &t, "claude", json!({"type": "system", "subtype": "task_started", "session_id": session, "task_id": task, "tool_use_id": call, "task_type": kind}));
        };
        call(&s, "s1", "a1", "Agent");
        started(&s, "s1", "t1", "a1", "local_agent");
        // A Skill forked into a subagent, and a background shell job.
        call(&s, "s1", "k1", "Skill");
        started(&s, "s1", "t2", "k1", "local_agent");
        call(&s, "s1", "b1", "Bash");
        started(&s, "s1", "t3", "b1", "local_bash");
        // The same call id again, in a resumed session.
        call(&s, "s2", "a1", "Task");
        started(&s, "s2", "t4", "a1", "local_agent");
        let found = |c: &Connection| -> Vec<Option<String>> {
            let by_task = ["t1", "t2", "t3", "t4", "nope"].map(|task| subagent_call(c, &t, &json!({"task_id": task})).unwrap());
            let by_call = ["a1", "k1", "b1", "nope"].map(|call| subagent_call(c, &t, &json!({"tool_use_id": call, "task_id": "x"})).unwrap());
            by_task.into_iter().chain(by_call).chain([subagent_call(c, &t, &json!({})).unwrap()]).collect()
        };
        let a1 = Some("a1".to_string());
        assert_eq!(both(&s, &t, found).await, [a1.clone(), None, None, a1.clone(), None, a1, None, None, None, None]);
    })
}

#[test]
fn a_task_that_isnt_there_has_said_nothing() {
    let s = testing::state();
    let c = s.db();
    assert_eq!(last_said(&c, "nope").unwrap(), None);
    assert_eq!(user_replies(&c, "nope", Some(3)).unwrap(), UserReplies::default());
    assert!(tool_calls_since(&c, "nope", None).unwrap().is_empty());
    assert_eq!(subagent_call(&c, "nope", &json!({"task_id": "t1"})).unwrap(), None);
}

#[test]
fn an_agent_threads_thread_has_the_origins_the_board_records() {
    testing::run(async || {
        use agent_threads::Store;
        let s = testing::state();
        let t = testing::task(&s).id;
        let store = HuntawayStore::new(Arc::downgrade(&s));
        store.create_thread(&json!({"id": t, "harness": "claude", "status": "idle", "created_at": "2026-11-01T00:00:00Z", "metadata": {"task_id": t}})).await.unwrap();
        let items = [
            json!({"id": "u1", "type": "user_message", "text": "Start working on this task."}),
            json!({"id": "m1", "type": "assistant_message", "text": "Which one?"}),
            json!({"id": "u2", "type": "user_message", "text": "The first"}),
            json!({"id": "m2", "type": "assistant_message", "text": "Done."}),
        ];
        let events: Vec<Value> = items.into_iter().enumerate().map(|(i, item)| json!({"type": "item.added", "thread_id": t, "seq": i + 1, "item": item})).collect();
        store.append_events(&t, &events, &[]).await.unwrap();
        record_origin(&s.db(), &t, "u1", &Origin { auto: true, ..Default::default() }).unwrap();
        // No snapshot yet: its events are folded.
        let (replies, last) = on(Engine::AgentThreads, || {
            let c = s.db();
            (user_replies(&c, &t, None).unwrap(), last_said(&c, &t).unwrap())
        });
        assert_eq!(replies, UserReplies { replies: vec![(Some("Which one?".into()), "The first".into())], since: Some("Done.".into()), earlier: 0 });
        assert_eq!(last.as_deref(), Some("Done."));
        // The legacy thread (no messages) has said nothing.
        assert_eq!(last_said(&s.db(), &t).unwrap(), None);
    })
}

#[test]
fn a_turn_ends_with_what_its_result_says_though_a_subagent_spoke_after_the_message() {
    testing::run(async || {
        // A subagent's last messages after the main conversation's: fewer than a window, then more.
        for children in [1, 30] {
            let s = testing::state();
            let t = testing::task(&s).id;
            add(&s, &t, "user", json!({"text": "Go"}));
            add(&s, &t, "claude", json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "a1", "name": "Agent", "input": {"description": "d", "prompt": "p"}}]}}));
            add(&s, &t, "claude", said("Main final answer"));
            for i in 0..children {
                add(&s, &t, "claude", json!({"type": "assistant", "parent_tool_use_id": "a1", "message": {"content": [{"type": "text", "text": format!("Child report {i}")}]}}));
            }
            add(&s, &t, "claude", json!({"type": "result", "subtype": "success", "is_error": false, "result": "Main final answer", "num_turns": 1}));
            let last = |c: &Connection| (last_said(c, &t).unwrap(), said_since_asked(c, &t).unwrap());
            let main = Some("Main final answer".to_string());
            assert_eq!(both(&s, &t, last).await, (main.clone(), main.clone()), "{children} child messages");
            // The user's reply is to the messages, not the result (as before): the subagent's last.
            add(&s, &t, "user", json!({"text": "Thanks"}));
            let r = both(&s, &t, |c| user_replies(c, &t, Some(1)).unwrap()).await;
            assert_eq!(r.replies, [(Some(format!("Child report {}", children - 1)), "Thanks".to_string())], "{children} child messages");
        }
    })
}

#[test]
fn a_result_no_message_said_is_said_but_isnt_what_the_user_answers() {
    testing::run(async || {
        let s = testing::state();
        let t = testing::task(&s).id;
        add(&s, &t, "claude", said("Waiting on the report."));
        add(&s, &t, "claude", json!({"type": "result", "subtype": "success", "result": "Waiting on the report.", "num_turns": 1}));
        add(&s, &t, "claude", json!({"type": "result", "subtype": "success", "result": "The report is in.", "num_turns": 1}));
        assert_eq!(both(&s, &t, |c| last_said(c, &t).unwrap()).await.as_deref(), Some("The report is in."));
        add(&s, &t, "user", json!({"text": "Good"}));
        let r = both(&s, &t, |c| user_replies(c, &t, None).unwrap()).await;
        assert_eq!(r.replies, [(Some("Waiting on the report.".to_string()), "Good".to_string())]);
    })
}

#[test]
fn agent_threads_items_that_dont_say_when_they_were_made_are_read_by_when_they_were_added() {
    testing::run(async || {
        use agent_threads::Store;
        let s = testing::state();
        let t = testing::task(&s).id;
        let store = HuntawayStore::new(Arc::downgrade(&s));
        store.create_thread(&json!({"id": t, "harness": "codex", "status": "idle", "created_at": "2026-11-01T00:00:00Z", "metadata": {"task_id": t}})).await.unwrap();
        // As agent-threads' drivers add them: no created_at.
        let items = [
            json!({"id": "u1", "type": "user_message", "text": "Commit it"}),
            json!({"id": "c1", "type": "tool_call", "kind": "shell", "name": "exec", "command": "git commit -am x", "input": {"command": "git commit -am x"}, "status": "running"}),
        ];
        let mut events: Vec<Value> = items.into_iter().enumerate().map(|(i, item)| json!({"type": "item.added", "thread_id": t, "seq": i + 1, "item": item})).collect();
        events.push(json!({"type": "item.updated", "thread_id": t, "seq": 3, "item_id": "c1", "patch": {"status": "completed", "result": {"content": "1 file changed"}}}));
        store.append_events(&t, &events, &[]).await.unwrap();
        let read = |since: &str| {
            on(Engine::AgentThreads, || {
                let c = s.db();
                let calls = tool_calls_since(&c, &t, Some(since)).unwrap();
                (calls.iter().filter(|c| crate::git::changes::changes_code(c)).count(), user_wrote_since(&c, &t, since).unwrap())
            })
        };
        assert_eq!(read("2000-01-01T00:00:00.000Z"), (1, true));
        assert_eq!(read("2999-01-01T00:00:00.000Z"), (0, false));
    })
}
