use std::time::Duration;

use agent_threads::{ClaudeCodeOptions, CreateOptions, Options, ThreadOptions};
use axum::Router;
use axum::extract::Request;
use tower::ServiceExt;

use super::*;
use crate::db;
use crate::testing;

/// The spec's example thread (spec/examples at the revision Cargo.toml pins): its saved and streamed
/// events, the snapshot they fold into, its window of 8 and the page of 3 before index 5.
const EVENTS: &str = include_str!("examples/thread.events.jsonl");
const SNAPSHOT: &str = include_str!("examples/thread.snapshot.json");
const WINDOW: &str = include_str!("examples/thread.window.json");
const PAGE: &str = include_str!("examples/thread.page.json");

fn example(text: &str) -> Value {
    serde_json::from_str(text).unwrap()
}

/// The example's events (`th_1`'s), deltas included.
fn example_events() -> Vec<Value> {
    EVENTS.lines().filter(|l| !l.trim().is_empty()).map(|l| serde_json::from_str(l).unwrap()).collect()
}

/// Another task in `t`'s profile.
pub(crate) fn another_task(s: &Shared, t: &db::Task) -> db::Task {
    let new = db::NewTask {
        profile_id: &t.profile_id,
        project_id: None,
        kind: "task",
        title: "another",
        description: "",
        status: "todo",
        use_worktree: false,
        model: None,
        effort: None,
        claude_config_id: None,
    };
    db::insert_task(&s.db(), new).unwrap()
}

fn store(s: &Shared) -> HuntawayStore<Weak<AppState>> {
    HuntawayStore::new(Arc::downgrade(s))
}

/// Stages the example thread for `task` as `huntaway threads-import --stage` would an import: its saved
/// events, under the example's thread id `th_1`.
pub(crate) async fn stage_example(s: &Shared, task: &str) {
    let store = store(s);
    let thread = json!({"id": "th_1", "harness": "claude", "status": "idle", "created_at": "2026-11-01T00:00:00Z",
        "metadata": {"task_id": task, "imported": {"converter": 1, "fingerprint": "f"}}});
    store.create_thread(&thread).await.unwrap();
    let saved: Vec<Value> = example_events().into_iter().filter(|e| e["type"] != "delta").collect();
    store.append_events("th_1", &saved, &[]).await.unwrap();
}

/// Puts the staged example in the middle of a turn, on a run the backend didn't start: a backend that
/// loads it ends the turn, as its run was lost. Its last seq is then 36.
async fn make_running(s: &Shared) {
    let mut thread = example(SNAPSHOT)["thread"].clone();
    thread["status"] = json!("running");
    thread["run"] = json!({"id": "run_9", "spawner": "shim", "started_at": "2026-11-01T00:20:00Z"});
    let events = [
        json!({"type": "turn.started", "thread_id": "th_1", "seq": 35, "turn_id": "t9"}),
        json!({"type": "thread.updated", "thread_id": "th_1", "seq": 36, "thread": thread}),
    ];
    store(s).append_events("th_1", &events, &[]).await.unwrap();
}

/// A backend on `s`'s store whose harness can't start (no turn runs in these tests), keeping questions
/// open after their turns.
pub(crate) fn backend(s: &Shared) -> AgentThreads {
    let claude = agent_threads::claude_code(ClaudeCodeOptions { bin: "/nonexistent/claude".into(), ..Default::default() });
    AgentThreads::new(Options {
        store: Some(Arc::new(store(s))),
        harnesses: vec![claude],
        late_answers: true,
        on_error: Some(Arc::new(|_| {})),
        ..Default::default()
    })
}

/// Creates `task`'s thread on the backend, as the engine does.
pub(crate) async fn create_thread(b: &AgentThreads, task: &str) {
    let mut metadata = serde_json::Map::new();
    metadata.insert("task_id".into(), json!(task));
    b.create(CreateOptions { id: Some(task.into()), harness: Some("claude".into()), metadata, ..Default::default() }).await.unwrap();
}

/// The next `thread_event` (or `thread_resync`) on `rx`, within 10s.
pub(crate) async fn next_thread_event(rx: &mut broadcast::Receiver<Value>) -> Value {
    let wait = async {
        loop {
            let ev = rx.recv().await.unwrap();
            if ev["type"] == "thread_event" || ev["type"] == "thread_resync" {
                return ev;
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(10), wait).await.expect("no thread event")
}

/// Status and body of a request to `app`, with a JSON body if one is given.
pub(crate) async fn call(app: &Router, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
    let req = Request::builder().method(method).uri(path).header("authorization", "Bearer ").header("content-type", "application/json");
    let req = req.body(body.map(|b| axum::body::Body::from(b.to_string())).unwrap_or_default()).unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status().as_u16();
    let bytes = axum::body::to_bytes(res.into_body(), 16 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into())))
}

fn seqs(events: &Value) -> Vec<u64> {
    events.as_array().unwrap().iter().map(|e| e["seq"].as_u64().unwrap()).collect()
}

#[test]
fn a_staged_thread_is_read_whole_in_windows_and_pages() {
    testing::run(async || {
        let s = testing::state();
        let app = crate::api::router(s.clone());
        let t = testing::task(&s);
        stage_example(&s, &t.id).await;
        // A backend that's running doesn't load an import its task hasn't been switched over to.
        install(&s, backend(&s));
        for base in ["/api", "/api/h/h"] {
            let at = |p: &str| format!("{base}/tasks/{}/thread{p}", t.id);
            assert_eq!(call(&app, "GET", &at(""), None).await, (200, example(SNAPSHOT)), "{base}");
            assert_eq!(call(&app, "GET", &at("?limit=8"), None).await, (200, example(WINDOW)), "{base}");
            // A limit it's within is the whole thread.
            assert_eq!(call(&app, "GET", &at("?limit=13"), None).await, (200, example(SNAPSHOT)), "{base}");
            assert_eq!(call(&app, "GET", &at("/items?before=5&limit=3"), None).await, (200, example(PAGE)), "{base}");
            let (status, page) = call(&app, "GET", &at("/items?before=5"), None).await;
            assert_eq!((status, &page["start"], page["items"].as_array().unwrap().len()), (200, &json!(0), 5));
            let (status, missing) = call(&app, "GET", &at("/items"), None).await;
            assert_eq!(status, 400, "{missing}");
        }
        make_running(&s).await;
        let (_, state) = call(&app, "GET", &format!("/api/tasks/{}/thread?limit=8", t.id), None).await;
        assert_eq!((&state["seq"], &state["thread"]["status"]), (&json!(36), &json!("running")));
        assert_eq!(store(&s).last_seq("th_1").await.unwrap(), 36);
    })
}

#[test]
fn a_client_catches_up_on_saved_events_after_its_seq() {
    testing::run(async || {
        let s = testing::state();
        let app = crate::api::router(s.clone());
        let t = testing::task(&s);
        stage_example(&s, &t.id).await;
        let at = |p: &str| format!("/api/tasks/{}/thread/events{p}", t.id);
        // From the start, deltas left out: they aren't saved.
        let (_, all) = call(&app, "GET", &at(""), None).await;
        assert_eq!((seqs(&all["events"]), &all["more"]), ((1..=34).collect(), &json!(false)));
        // A page at a time.
        let (_, first) = call(&app, "GET", &at("?after=29&limit=3"), None).await;
        assert_eq!((seqs(&first["events"]), &first["more"]), (vec![30, 31, 32], &json!(true)));
        let (_, rest) = call(&app, "GET", &at("?after=32&limit=3"), None).await;
        assert_eq!((seqs(&rest["events"]), &rest["more"]), (vec![33, 34], &json!(false)));
        let (_, none) = call(&app, "GET", &at("?after=34"), None).await;
        assert_eq!(none, json!({"events": [], "more": false, "seq": 34}));

        // The window of a state with those events, after a gap, is the whole state's.
        let saved: Vec<ThreadEvent> = example_events().into_iter().filter(|e| e["type"] != "delta").map(|e| serde_json::from_value(e).unwrap()).collect();
        let thread: Thread = serde_json::from_value(example(SNAPSHOT)["thread"].clone()).unwrap();
        let mut client = initial_state(thread);
        for e in &saved[..20] {
            apply_event(&mut client, e);
        }
        let (_, missed) = call(&app, "GET", &at(&format!("?after={}", client.seq)), None).await;
        for e in missed["events"].as_array().unwrap() {
            apply_event(&mut client, &serde_json::from_value(e.clone()).unwrap());
        }
        assert_eq!(serde_json::to_value(&client).unwrap(), example(SNAPSHOT));

        // An event type from a newer build is left out, and its seq gone past.
        store(&s).append_events("th_1", &[json!({"type": "thread.renamed", "thread_id": "th_1", "seq": 35})], &[]).await.unwrap();
        let (_, newer) = call(&app, "GET", &at("?after=33"), None).await;
        assert_eq!((seqs(&newer["events"]), &newer["more"], &newer["seq"]), (vec![34], &json!(false), &json!(35)));
        let (_, state) = call(&app, "GET", &format!("/api/tasks/{}/thread", t.id), None).await;
        assert_eq!(state["seq"], 35);
    })
}

/// Appends events of types this build doesn't know at `unknown`, and known ones at the other seqs from
/// `from` to `to`, to `thread`.
async fn append_mixed(s: &Shared, thread: &str, from: u64, to: u64, unknown: &[u64]) {
    let events: Vec<Value> = (from..=to)
        .map(|seq| match unknown.contains(&seq) {
            true => json!({"type": "thread.renamed", "thread_id": thread, "seq": seq}),
            false => json!({"type": "turn.started", "thread_id": thread, "seq": seq, "turn_id": format!("t{seq}")}),
        })
        .collect();
    store(s).append_events(thread, &events, &[]).await.unwrap();
}

/// Every page of `task`'s events after `after`, `limit` at a time: the known events' seqs, and the
/// `seq` the last page went up to.
async fn every_page(app: &Router, task: &str, mut after: u64, limit: usize) -> (Vec<u64>, u64) {
    let mut got = Vec::new();
    for _ in 0..100 {
        let (status, page) = call(app, "GET", &format!("/api/tasks/{task}/thread/events?after={after}&limit={limit}"), None).await;
        assert_eq!(status, 200, "{page}");
        got.extend(seqs(&page["events"]));
        let seq = page["seq"].as_u64().unwrap();
        assert!(seq >= after, "{page}");
        if page["more"] == false {
            return (got, seq);
        }
        assert!(!page["events"].as_array().unwrap().is_empty(), "more, with nothing: {page}");
        after = seq;
    }
    panic!("never ended");
}

#[test]
fn unknown_event_types_dont_end_a_catch_up_early() {
    testing::run(async || {
        let s = testing::state();
        let app = crate::api::router(s.clone());
        let t = testing::task(&s);
        stage_example(&s, &t.id).await;
        // 35-36 unknown, 37-38 known, 39 unknown, 40 known, 41-43 unknown.
        append_mixed(&s, "th_1", 35, 43, &[35, 36, 39, 41, 42, 43]).await;
        let at = |q: &str| format!("/api/tasks/{}/thread/events?{q}", t.id);
        // Unknown ones before the page's first known one, and between its end and the next.
        let (_, first) = call(&app, "GET", &at("after=34&limit=1"), None).await;
        assert_eq!(first, json!({"events": [first["events"][0]], "more": true, "seq": 37}));
        assert_eq!(seqs(&first["events"]), vec![37]);
        let (_, second) = call(&app, "GET", &at("after=37&limit=1"), None).await;
        assert_eq!((seqs(&second["events"]), &second["more"], &second["seq"]), (vec![38], &json!(true), &json!(38)));
        let (_, third) = call(&app, "GET", &at("after=38&limit=1"), None).await;
        assert_eq!((seqs(&third["events"]), &third["more"], &third["seq"]), (vec![40], &json!(false), &json!(43)));
        // Only unknown ones left: none, but gone past.
        let (_, rest) = call(&app, "GET", &at("after=40"), None).await;
        assert_eq!(rest, json!({"events": [], "more": false, "seq": 43}));
        for limit in [1, 2, 3, 7] {
            assert_eq!(every_page(&app, &t.id, 30, limit).await, (vec![31, 32, 33, 34, 37, 38, 40], 43), "limit {limit}");
        }
    })
}

#[test]
fn a_live_threads_unknown_event_types_dont_end_a_catch_up_early() {
    testing::run(async || {
        let s = testing::state();
        let app = crate::api::router(s.clone());
        let t = testing::task(&s);
        let b = backend(&s);
        install(&s, b.clone());
        create_thread(&b, &t.id).await;
        // As a newer build of the backend would have saved them.
        append_mixed(&s, &t.id, 2, 9, &[2, 3, 5, 6, 9]).await;
        let (_, first) = call(&app, "GET", &format!("/api/tasks/{}/thread/events?after=1&limit=1", t.id), None).await;
        assert_eq!((seqs(&first["events"]), &first["more"], &first["seq"]), (vec![4], &json!(true), &json!(4)));
        for limit in [1, 2, 5] {
            assert_eq!(every_page(&app, &t.id, 0, limit).await, (vec![1, 4, 7, 8], 9), "limit {limit}");
        }
    })
}

#[test]
fn only_a_tasks_own_thread_is_reached() {
    testing::run(async || {
        let s = testing::state();
        let app = crate::api::router(s.clone());
        let t = testing::task(&s);
        let legacy = another_task(&s, &t);
        stage_example(&s, &t.id).await;
        let cmd = |task: &str| format!("/api/tasks/{task}/thread/commands");
        let respond = json!({"type": "respond", "request_id": "q1", "resolution": {"outcome": "cancel"}});

        assert_eq!(call(&app, "GET", "/api/tasks/nope/thread", None).await, (404, json!({"error": "task not found"})));
        let none = json!({"error": format!("task {} has no agent-threads thread", legacy.id)});
        for path in ["", "/items?before=1", "/events"] {
            assert_eq!(call(&app, "GET", &format!("/api/tasks/{}/thread{path}", legacy.id), None).await, (404, none.clone()), "{path}");
        }
        assert_eq!(call(&app, "POST", &cmd(&legacy.id), Some(respond.clone())).await, (404, none));

        // A command can't name another task's thread.
        let mut other = respond.clone();
        other["thread_id"] = json!(legacy.id);
        let (status, err) = call(&app, "POST", &cmd(&t.id), Some(other)).await;
        assert_eq!(status, 400, "{err}");
        // Nor be one the board's own routes carry out, or a malformed one.
        for (body, says) in [
            (json!({"type": "send", "text": "hi"}), "POST /api/tasks/{id}/messages"),
            (json!({"type": "interrupt"}), "POST /api/tasks/{id}/stop"),
            (json!({"type": "rewind", "turn_id": "t1"}), "POST /api/tasks/{id}/rewind"),
            (json!({"type": "set_options", "model": "opus"}), "PATCH /api/tasks/{id}"),
            (json!({"type": "nope"}), "type must be respond"),
            (json!({"type": "respond"}), "isn't a valid command"),
            (json!([]), "a JSON object"),
        ] {
            let (status, err) = call(&app, "POST", &cmd(&t.id), Some(body.clone())).await;
            assert!(status == 400 && err["error"].as_str().unwrap().contains(says), "{body}: {status} {err}");
        }
        // A staged import isn't run, so it takes no commands.
        let (status, err) = call(&app, "POST", &cmd(&t.id), Some(respond.clone())).await;
        assert_eq!(status, 409, "{err}");

        // An engine's thread, on a host not running the engine (yet).
        let mut thread = store(&s).get_thread("th_1").await.unwrap().unwrap();
        thread["metadata"].as_object_mut().unwrap().remove("imported");
        store(&s).update_thread(&thread).await.unwrap();
        let (status, err) = call(&app, "POST", &cmd(&t.id), Some(respond)).await;
        assert_eq!(status, 503, "{err}");

        // A thread goes with its task.
        s.db().execute("DELETE FROM tasks WHERE id=?1", [&t.id]).unwrap();
        assert_eq!(call(&app, "GET", &format!("/api/tasks/{}/thread", t.id), None).await.0, 404);
    })
}

#[test]
fn a_switched_over_import_is_read_from_the_backend() {
    testing::run(async || {
        let s = testing::state();
        let app = crate::api::router(s.clone());
        let t = testing::task(&s);
        stage_example(&s, &t.id).await;
        make_running(&s).await;
        install(&s, backend(&s));
        // A database with the engine's column, and the task switched over.
        s.db().execute_batch("ALTER TABLE tasks ADD COLUMN run_engine TEXT NOT NULL DEFAULT 'legacy'").unwrap();
        s.db().execute("UPDATE tasks SET run_engine='agent_threads' WHERE id=?1", [&t.id]).unwrap();
        let (status, state) = call(&app, "GET", &format!("/api/tasks/{}/thread", t.id), None).await;
        assert_eq!(status, 200, "{state}");
        // The backend loaded it: the example's run was lost with the backend it ran on, which it says.
        assert!(state["seq"].as_u64().unwrap() > 36, "{}", state["seq"]);
        assert_ne!(state["thread"]["status"], "running");
        assert_eq!(store(&s).last_seq("th_1").await.unwrap(), state["seq"].as_u64().unwrap());
    })
}

#[test]
fn live_events_reach_clients_and_a_gap_is_caught_up() {
    testing::run(async || {
        let s = testing::state();
        let app = crate::api::router(s.clone());
        let t = testing::task(&s);
        let mut rx = s.events.subscribe();
        let b = backend(&s);
        assert!(install(&s, b.clone()));
        assert!(!install(&s, backend(&s)), "a second backend");
        create_thread(&b, &t.id).await;
        let first = next_thread_event(&mut rx).await;
        assert_eq!((&first["task_id"], &first["event"]["type"], &first["event"]["seq"]), (&json!(t.id), &json!("thread.updated"), &json!(1)));

        // Changes the client misses (it's offline, say) it gets from its seq.
        b.set_options(&t.id, ThreadOptions { model: Some("sonnet".into()), ..Default::default() }).await.unwrap();
        let second = next_thread_event(&mut rx).await;
        assert_eq!((&second["event"]["seq"], &second["event"]["thread"]["model"]), (&json!(2), &json!("sonnet")));
        let (_, missed) = call(&app, "GET", &format!("/api/tasks/{}/thread/events?after=1", t.id), None).await;
        assert_eq!(missed["events"], json!([second["event"]]));
        let (_, state) = call(&app, "GET", &format!("/api/tasks/{}/thread?limit=10", t.id), None).await;
        assert_eq!((&state["seq"], &state["thread"]["model"]), (&json!(2), &json!("sonnet")));

        // A thread that isn't a task's isn't sent.
        b.create(CreateOptions { id: Some("loose".into()), ..Default::default() }).await.unwrap();
        b.set_options(&t.id, ThreadOptions { model: Some("opus".into()), ..Default::default() }).await.unwrap();
        let third = next_thread_event(&mut rx).await;
        assert_eq!((&third["task_id"], &third["event"]["seq"]), (&json!(t.id), &json!(3)));
    })
}

#[test]
fn a_question_is_answered_through_the_backend() {
    testing::run(async || {
        let s = testing::state();
        let app = crate::api::router(s.clone());
        let t = testing::task(&s);
        // The engine's thread, idle with a question kept open after its turn.
        let id = t.id.as_str();
        let thread = json!({"id": id, "harness": "claude", "status": "idle", "created_at": "2026-11-01T00:00:00Z", "metadata": {"task_id": id}});
        let question = json!({"id": "q1", "type": "question", "turn_id": "t1", "user_messages": 1,
            "questions": [{"id": "runner", "question": "Which test runner?", "options": [{"label": "vitest"}, {"label": "jest"}]}]});
        let events = [
            json!({"type": "thread.updated", "thread": thread}),
            json!({"type": "item.added", "item": {"id": "u1", "type": "user_message", "text": "Fix the test", "turn_id": "t1"}}),
            json!({"type": "turn.started", "turn_id": "t1"}),
            json!({"type": "request.opened", "request": question}),
            json!({"type": "item.added", "item": {"id": "tr1", "type": "turn_result", "ok": true, "turn_id": "t1"}}),
            json!({"type": "turn.completed", "turn_id": "t1"}),
        ];
        let events: Vec<Value> = events.into_iter().enumerate().map(|(i, mut e)| {
            e["thread_id"] = json!(id);
            e["seq"] = json!(i + 1);
            e
        }).collect();
        store(&s).create_thread(&thread).await.unwrap();
        store(&s).append_events(id, &events, &[]).await.unwrap();
        let mut rx = s.events.subscribe();
        install(&s, backend(&s));

        let (_, state) = call(&app, "GET", &format!("/api/tasks/{id}/thread"), None).await;
        assert_eq!(state["requests"][0]["resolution"], Value::Null, "{state}");
        let answer = json!({"type": "respond", "request_id": "q1", "resolution": {"outcome": "answer", "answers": {"runner": ["vitest"]}}});
        assert_eq!(call(&app, "POST", &format!("/api/tasks/{id}/thread/commands"), Some(answer)).await, (200, json!({"ok": true})));
        let resolved = loop {
            let ev = next_thread_event(&mut rx).await;
            if ev["event"]["type"] == "request.resolved" {
                break ev;
            }
        };
        assert_eq!(resolved["event"]["resolution"]["answers"], json!({"runner": ["vitest"]}));
        let (_, state) = call(&app, "GET", &format!("/api/tasks/{id}/thread"), None).await;
        assert_eq!(state["requests"][0]["resolution"]["outcome"], "answer");
    })
}

#[test]
fn a_subscription_that_falls_behind_tells_clients_to_resync() {
    testing::run(async || {
        let s = testing::state();
        let t = testing::task(&s);
        stage_example(&s, &t.id).await;
        let mut rx = s.events.subscribe();
        let (tx, events) = broadcast::channel(2);
        for e in example_events().into_iter().take(4) {
            tx.send(serde_json::from_value(e).unwrap()).unwrap();
        }
        drop(tx);
        // It missed the first two, then forwards what's left, deltas included.
        forward(Arc::downgrade(&s), events).await;
        assert_eq!(next_thread_event(&mut rx).await, json!({"type": "thread_resync"}));
        for seq in [3, 4] {
            let ev = next_thread_event(&mut rx).await;
            assert_eq!((&ev["task_id"], &ev["event"]["seq"]), (&json!(t.id), &json!(seq)));
        }
    })
}
