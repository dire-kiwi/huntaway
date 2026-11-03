use super::*;
use crate::testing;
use axum::body::Bytes;
use aws_lc_rs::signature::{UnparsedPublicKey as VerifyingKey, ECDSA_P256_SHA256_FIXED};
use axum::http::HeaderMap;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;
use tower::ServiceExt;

fn b64(s: &str) -> Vec<u8> {
    B64.decode(s).unwrap()
}

/// A device's key (as its browser makes one).
fn device_key() -> agreement::PrivateKey {
    agreement::PrivateKey::generate(&ECDH_P256).unwrap()
}

/// What a browser does with a push it gets (RFC 8291 section 3.4, the other way round).
fn decrypt(ua: &agreement::PrivateKey, auth: &[u8], body: &[u8]) -> Vec<u8> {
    let (salt, rest) = body.split_at(16);
    assert_eq!(u32::from_be_bytes(rest[..4].try_into().unwrap()), RECORD_SIZE);
    let idlen = rest[4] as usize;
    let (as_public, sealed) = rest[5..].split_at(idlen);
    let (key, nonce) = content_keys(&ecdh(ua, as_public).unwrap(), auth, &public_key(ua).unwrap(), as_public, salt).unwrap();
    let mut sealed = sealed.to_vec();
    let mut plain = key.open_in_place(nonce, Aad::empty(), &mut sealed).unwrap().to_vec();
    // The last record ends in 2, then any padding of zeros.
    while plain.last() == Some(&0) {
        plain.pop();
    }
    assert_eq!(plain.pop(), Some(2));
    plain
}

#[test]
fn encryption_matches_the_rfc_8291_example() {
    // RFC 8291, section 5 and appendix A.
    let as_secret = agreement::PrivateKey::from_private_key(&ECDH_P256, &b64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")).unwrap();
    let salt: [u8; 16] = b64("DGv6ra1nlYgDCS1FRnbzlw").try_into().unwrap();
    let ua_public = b64("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
    let auth = b64("BTBZMqHH6r4Tts7J_aSIgg");
    let body = encrypt_with(&as_secret, &salt, &ua_public, &auth, b"When I grow up, I want to be a watermelon").unwrap();
    let expected = concat!(
        "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95",
        "bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
    assert_eq!(B64.encode(&body), expected);
    // And the user agent's key reads it.
    let ua = agreement::PrivateKey::from_private_key(&ECDH_P256, &b64("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94")).unwrap();
    assert_eq!(decrypt(&ua, &auth, &body), b"When I grow up, I want to be a watermelon");
}

#[test]
fn each_message_gets_its_own_key_and_salt() {
    let ua = device_key();
    let ua_public = public_key(&ua).unwrap();
    let auth = [7u8; 16];
    let (a, b) = (encrypt(&ua_public, &auth, b"hello").unwrap(), encrypt(&ua_public, &auth, b"hello").unwrap());
    assert_ne!(a[..86], b[..86]);
    assert_eq!(decrypt(&ua, &auth, &a), b"hello");
    assert_eq!(decrypt(&ua, &auth, &b), b"hello");
    // Too long for one record, or a key that isn't one.
    assert!(encrypt(&ua_public, &auth, &[b'x'; 4000]).is_err());
    assert!(encrypt(&[4u8; 65], &auth, b"hello").is_err());
}

#[test]
fn the_vapid_key_is_made_once_and_signs_tokens_for_the_push_service() {
    let s = testing::state();
    let v = vapid(&s.db()).unwrap();
    assert_eq!(vapid(&s.db()).unwrap().public_key(), v.public_key());
    assert_eq!(v.public.len(), 65);
    let header = authorization(&v, "https://fcm.googleapis.com/fcm/send/abc:def", "mailto:me@example.com", 1_000_000).unwrap();
    let (t, k) = header.strip_prefix("vapid t=").unwrap().split_once(", k=").unwrap();
    assert_eq!(k, v.public_key());
    let parts: Vec<&str> = t.split('.').collect();
    assert_eq!(serde_json::from_slice::<Value>(&b64(parts[0])).unwrap(), json!({"typ": "JWT", "alg": "ES256"}));
    assert_eq!(
        serde_json::from_slice::<Value>(&b64(parts[1])).unwrap(),
        json!({"aud": "https://fcm.googleapis.com", "exp": 1_000_000 + 12 * 3600, "sub": "mailto:me@example.com"})
    );
    let key = VerifyingKey::new(&ECDSA_P256_SHA256_FIXED, b64(k));
    key.verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &b64(parts[2])).unwrap();
    assert!(key.verify(b"something else", &b64(parts[2])).is_err());
}

fn task(status: &str) -> Value {
    json!({"id": "t1", "kind": "task", "number": 3, "title": "Fix the login", "status": status, "running": false, "review": null, "attention_reason": null})
}

fn with(mut t: Value, fields: Value) -> Value {
    for (k, v) in fields.as_object().unwrap() {
        t[k] = v.clone();
    }
    t
}

#[test]
fn task_changes_notify_as_the_ui_does() {
    let working = with(task("in_progress"), json!({"running": true}));
    let asks = with(task("needs_attention"), json!({"running": true, "attention_reason": "Approve Bash?"}));
    assert_eq!(task_event(&working, &asks), Some(Event::Attention));
    // Not again while it stays there, nor for a run the user stopped, nor for a review thread.
    assert_eq!(task_event(&asks, &with(asks.clone(), json!({"attention_reason": "Approve Write?"}))), None);
    assert_eq!(task_event(&working, &with(task("needs_attention"), json!({"attention_reason": STOPPED}))), None);
    assert_eq!(task_event(&working, &with(asks.clone(), json!({"kind": "review"}))), None);
    // In review: once its agent stopped and its review passed (or with none).
    let reviewing = with(task("in_review"), json!({"review": {"state": "running"}}));
    assert_eq!(task_event(&working, &reviewing), None);
    assert_eq!(task_event(&reviewing, &with(task("in_review"), json!({"review": {"state": "issues"}}))), None);
    let passed = with(task("in_review"), json!({"review": {"state": "passed"}}));
    assert_eq!(task_event(&reviewing, &passed), Some(Event::Review));
    assert_eq!(task_event(&working, &task("in_review")), Some(Event::Review));
    assert_eq!(task_event(&working, &with(task("in_review"), json!({"running": true}))), None);
    assert_eq!(task_event(&passed, &task("ready_for_merge")), Some(Event::Merge));
    assert_eq!(task_event(&task("ready_for_merge"), &task("done")), Some(Event::Done));
    assert_eq!(task_event(&task("done"), &task("done")), None);

    assert_eq!(notification_text(Event::Attention, &asks, "WEB-3"), ("WEB-3 Fix the login".into(), "Needs attention: Approve Bash?".into()));
    assert_eq!(notification_text(Event::Review, &passed, "WEB-3").1, "Ready to review: its review passed");
    assert_eq!(notification_text(Event::Done, &with(task("done"), json!({"resolution": "wont_fix"})), "WEB-3").1, "Closed: won't fix");
    let long = notification_text(Event::Attention, &with(asks, json!({"attention_reason": "x".repeat(300)})), "WEB-3").1;
    assert_eq!(long.chars().count(), 200);
    assert!(long.ends_with('…'));
}

/// A push service on this machine: it takes what's posted to it, answering with `status`.
async fn push_service(status: Arc<AtomicU16>) -> (String, mpsc::UnboundedReceiver<(HeaderMap, Bytes)>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let app = axum::Router::new().route(
        "/push/{id}",
        axum::routing::post(move |headers: HeaderMap, body: Bytes| {
            let (tx, status) = (tx.clone(), status.clone());
            async move {
                let _ = tx.send((headers, body));
                axum::http::StatusCode::from_u16(status.load(Ordering::SeqCst)).unwrap()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/push/device-1", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, rx)
}

async fn api(s: &Shared, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
    let req = axum::http::Request::builder()
        .method(method)
        .uri(path)
        .header("authorization", "Bearer ")
        .header("content-type", "application/json")
        .body(axum::body::Body::from(body.map(|b| b.to_string()).unwrap_or_default()))
        .unwrap();
    let res = crate::api::router(s.clone()).oneshot(req).await.unwrap();
    let status = res.status().as_u16();
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

fn device() -> (agreement::PrivateKey, Value) {
    let ua = device_key();
    let keys = json!({"p256dh": B64.encode(public_key(&ua).unwrap()), "auth": B64.encode([9u8; 16])});
    (ua, keys)
}

#[test]
fn devices_subscribe_change_their_events_and_unsubscribe() {
    testing::run(async || {
        let s = testing::state();
        let (status, info) = api(&s, "GET", "/api/push", None).await;
        assert_eq!(status, 200);
        assert_eq!(b64(info["public_key"].as_str().unwrap()).len(), 65);
        assert_eq!(info["subscriptions"], json!([]));

        let (_, keys) = device();
        let endpoint = "https://push.example.com/send/abc";
        let (status, sub) = api(&s, "POST", "/api/push/subscriptions", Some(json!({"endpoint": endpoint, "keys": keys, "name": "Pixel"}))).await;
        assert_eq!(status, 200, "{sub}");
        assert_eq!(sub["events"], json!({"attention": true, "review": true, "merge": false, "done": false, "prompts": "assistant"}));
        assert_eq!(sub["name"], "Pixel");
        assert!(sub.get("auth").is_none() && sub.get("p256dh").is_none());
        let id = sub["id"].as_str().unwrap().to_string();

        // The same endpoint again (a browser that subscribed again) is the same device, keeping its events.
        let events = json!({"events": {"attention": true, "review": false, "merge": true, "done": false}});
        let (_, events) = api(&s, "PATCH", &format!("/api/push/subscriptions/{id}"), Some(events)).await;
        assert_eq!(events["events"]["merge"], true);
        let (_, again) = api(&s, "POST", "/api/push/subscriptions", Some(json!({"endpoint": endpoint, "keys": keys, "name": "Pixel 8"}))).await;
        assert_eq!((again["id"].as_str(), again["name"].as_str(), again["events"]["merge"].as_bool()), (Some(id.as_str()), Some("Pixel 8"), Some(true)));
        assert_eq!(api(&s, "GET", "/api/push", None).await.1["subscriptions"].as_array().unwrap().len(), 1);

        // Endpoints are HTTPS (HTTP only on this machine), and keys have to be real.
        for (body, why) in [
            (json!({"endpoint": "http://push.example.com/x", "keys": keys}), "https"),
            (json!({"endpoint": "not a url", "keys": keys}), "URL"),
            (json!({"endpoint": endpoint, "keys": {"p256dh": B64.encode([4u8; 65]), "auth": B64.encode([1u8; 16])}}), "p256dh"),
            (json!({"endpoint": endpoint, "keys": {"p256dh": keys["p256dh"], "auth": B64.encode([1u8; 8])}}), "auth"),
        ] {
            let (status, err) = api(&s, "POST", "/api/push/subscriptions", Some(body)).await;
            assert_eq!(status, 400);
            assert!(err["error"].as_str().unwrap().contains(why), "{err}");
        }

        assert_eq!(api(&s, "DELETE", &format!("/api/push/subscriptions/{id}"), None).await.0, 200);
        assert_eq!(api(&s, "DELETE", &format!("/api/push/subscriptions/{id}"), None).await.0, 404);
        assert_eq!(api(&s, "GET", "/api/push", None).await.1["subscriptions"], json!([]));
    })
}

/// The board's task event for task `t` on this host.
fn emit(s: &Shared, t: &Value) {
    let _ = s.hub_events.send(json!({"type": "task", "task": t, "host_id": s.host_id}));
}

#[test]
fn a_link_is_connected_only_after_its_initial_push_snapshot() {
    testing::run(async || {
        let s = testing::state();
        let (url, mut got) = push_service(Arc::new(AtomicU16::new(201))).await;
        let (ua, keys) = device();
        api(&s, "POST", "/api/push/subscriptions", Some(json!({"endpoint": url, "keys": keys}))).await;
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (began, gate, count) = (entered.clone(), release.clone(), reads.clone());
        let remote = axum::Router::new()
            .route("/api/profiles", axum::routing::get(|| async { Json(json!([{"id": "p"}])) }))
            .route("/api/profiles/p/tasks", axum::routing::get(move || {
                let (began, gate, count) = (began.clone(), gate.clone(), count.clone());
                async move {
                    // The second snapshot, from the initial resync, used to swallow a change
                    // made after /api/hosts had already advertised the link as connected.
                    if count.fetch_add(1, Ordering::SeqCst) == 1 { began.notify_one(); gate.notified().await; }
                    Json(json!([task("in_progress")]))
                }
            }));
        crate::hosts::hub::link_http(&s, "remote", remote, crate::hosts::proto::API_VERSION).await;
        db::upsert_link(&s.db(), "remote", "remote", "outbound", None, None).unwrap();
        start(&s);
        s.hub_events.send(json!({"type": "hosts_changed"})).unwrap();
        s.hub_events.send(json!({"type": "resync", "host_id": "remote"})).unwrap();
        entered.notified().await;
        let connected = async || {
            let hosts = crate::hosts::hub::list_hosts(State(s.clone())).await.unwrap().0;
            hosts.as_array().unwrap().iter().find(|h| h["id"] == "remote").unwrap()["connected"] == true
        };
        assert!(!connected().await, "link advertised before its task snapshot was ready");
        release.notify_one();
        while !connected().await { tokio::time::sleep(Duration::from_millis(10)).await; }
        assert_eq!(reads.load(Ordering::SeqCst), 2);
        s.hub_events.send(json!({"type": "task", "host_id": "remote", "task": task("needs_attention")})).unwrap();
        let (_, body) = got.recv().await.unwrap();
        let msg: Value = serde_json::from_slice(&decrypt(&ua, &[9u8; 16], &body)).unwrap();
        assert_eq!(msg["event"], "attention");
        assert_eq!(msg["tag"], "remote:t1");
        // Readiness belongs to this connection, not just the host id reused on reconnect.
        crate::hosts::hub::link_http(&s, "remote", axum::Router::new(), crate::hosts::proto::API_VERSION).await;
        assert!(!connected().await);
    });
}

#[test]
fn task_events_are_pushed_encrypted_to_the_devices_that_want_them() {
    testing::run(async || {
        let s = testing::state();
        let (url, mut got) = push_service(Arc::new(AtomicU16::new(201))).await;
        let (ua, keys) = device();
        let events = json!({"attention": true, "review": false, "merge": true, "done": true});
        let (_, sub) = api(&s, "POST", "/api/push/subscriptions", Some(json!({"endpoint": url, "keys": keys, "name": "phone", "events": events}))).await;
        // A device that only wants reviews gets none of these.
        let (_, other) = device();
        let none = json!({"attention": false, "review": true, "merge": false, "done": false});
        api(&s, "POST", "/api/push/subscriptions", Some(json!({"endpoint": format!("{url}-other"), "keys": other, "events": none}))).await;
        let profile = db::insert_profile(&s.db(), "work", &[], None).unwrap();
        let x = "/x";
        let p = db::NewProject {
            id: "p1",
            profile_id: &profile.id,
            name: "Web",
            key: "WEB",
            repo_path: x,
            scratch_path: x,
            worktrees_root: x,
            base_branch: None,
            use_worktrees: false,
        };
        let project = db::insert_project(&s.db(), p).unwrap();
        let new = db::NewTask {
            profile_id: &profile.id,
            project_id: Some(&project.id),
            kind: "task",
            title: "Fix the login",
            description: "",
            status: "in_progress",
            use_worktree: false,
            model: None,
            effort: None,
            claude_config_id: None,
        };
        let t = json!(db::insert_task(&s.db(), new).unwrap());
        start(&s);

        emit(&s, &with(t.clone(), json!({"status": "needs_attention", "attention_reason": "Approve Bash?", "running": true})));
        let (headers, body) = got.recv().await.unwrap();
        let msg: Value = serde_json::from_slice(&decrypt(&ua, &[9u8; 16], &body)).unwrap();
        let id = t["id"].as_str().unwrap();
        let title = format!("WEB-{} Fix the login", t["number"]);
        let (url, tag) = (format!("/t/{id}"), format!("h:{id}"));
        let want = json!({"title": title, "body": "Needs attention: Approve Bash?", "url": url, "tag": tag, "task_id": id, "event": "attention"});
        assert_eq!(msg, want);
        let header = |k: &str| headers.get(k).unwrap().to_str().unwrap().to_string();
        assert_eq!((header("content-encoding"), header("ttl"), header("urgency")), ("aes128gcm".into(), "86400".into(), "high".into()));
        let public = api(&s, "GET", "/api/push", None).await.1["public_key"].as_str().unwrap().to_string();
        assert!(header("authorization").starts_with("vapid t=") && header("authorization").ends_with(&format!(", k={public}")));
        assert_eq!(header("topic").len(), 32);
        // Noted once the push service has answered.
        let sent = async || {
            let subs = api(&s, "GET", "/api/push", None).await.1["subscriptions"].clone();
            subs.as_array().unwrap().iter().find(|x| x["id"] == sub["id"]).unwrap()["last_sent_at"].is_string()
        };
        while !sent().await {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        // A move the user made doesn't notify them; the agent's next one does.
        s.push.note_move("h", id, "ready_for_merge");
        emit(&s, &with(t.clone(), json!({"status": "ready_for_merge"})));
        emit(&s, &with(t.clone(), json!({"status": "done", "resolution": "done"})));
        let (headers, body) = got.recv().await.unwrap();
        let msg: Value = serde_json::from_slice(&decrypt(&ua, &[9u8; 16], &body)).unwrap();
        assert_eq!((msg["body"].as_str(), msg["event"].as_str()), (Some("Done"), Some("done")));
        assert_eq!(headers.get("urgency").unwrap(), "normal");
        assert!(got.try_recv().is_err(), "the device that only wants reviews got one");
    })
}

#[test]
fn a_move_the_user_makes_through_the_board_is_noted() {
    testing::run(async || {
        let s = testing::state();
        let profile = db::insert_profile(&s.db(), "work", &[], None).unwrap();
        let new = db::NewTask {
            profile_id: &profile.id,
            project_id: None,
            kind: "task",
            title: "Scratch",
            description: "",
            status: "todo",
            use_worktree: false,
            model: None,
            effort: None,
            claude_config_id: None,
        };
        let id = db::insert_task(&s.db(), new).unwrap().id;
        let key = format!("h:{id}");
        assert!(!s.push.moved(&key, Event::Merge));
        // The UI's requests for a host go through the hub's proxy.
        let (status, t) = api(&s, "PATCH", &format!("/api/h/h/tasks/{id}"), Some(json!({"status": "ready_for_merge"}))).await;
        assert_eq!(status, 200, "{t}");
        assert!(s.push.moved(&key, Event::Merge));
        assert!(!s.push.moved(&key, Event::Done));
        // Other changes aren't moves.
        api(&s, "PATCH", &format!("/api/h/h/tasks/{id}"), Some(json!({"title": "Renamed"}))).await;
        assert!(s.push.moved(&key, Event::Merge));
    })
}

#[test]
fn ready_to_review_waits_to_see_that_it_stays_so() {
    testing::run(async || {
        let s = testing::state();
        let (url, mut got) = push_service(Arc::new(AtomicU16::new(201))).await;
        let (ua, keys) = device();
        api(&s, "POST", "/api/push/subscriptions", Some(json!({"endpoint": url, "keys": keys}))).await;
        start(&s);
        let working = with(task("in_progress"), json!({"running": true, "id": "t2"}));
        emit(&s, &working);
        // Its review starts straight after: nothing.
        emit(&s, &with(working.clone(), json!({"status": "in_review", "running": false})));
        emit(&s, &with(working.clone(), json!({"status": "in_review", "running": false, "review": {"state": "running"}})));
        // Then it passes, and stays passed.
        emit(&s, &with(working.clone(), json!({"status": "in_review", "running": false, "review": {"state": "passed"}})));
        let started = Instant::now();
        let (_, body) = got.recv().await.unwrap();
        assert!(started.elapsed() >= Duration::from_secs(4));
        let msg: Value = serde_json::from_slice(&decrypt(&ua, &[9u8; 16], &body)).unwrap();
        assert_eq!(msg["body"], "Ready to review: its review passed");
        assert!(got.try_recv().is_err());
    })
}

#[test]
fn a_subscription_its_push_service_has_dropped_is_deleted() {
    testing::run(async || {
        let s = testing::state();
        let status = Arc::new(AtomicU16::new(500));
        let (url, mut got) = push_service(status.clone()).await;
        let (_, keys) = device();
        let (_, sub) = api(&s, "POST", "/api/push/subscriptions", Some(json!({"endpoint": url, "keys": keys}))).await;
        let id = sub["id"].as_str().unwrap();
        let (code, err) = api(&s, "POST", &format!("/api/push/subscriptions/{id}/test"), None).await;
        assert_eq!(code, 502);
        assert!(err["error"].as_str().unwrap().contains("500"), "{err}");
        got.recv().await.unwrap();
        assert!(api(&s, "GET", "/api/push", None).await.1["subscriptions"][0]["last_error"].as_str().unwrap().contains("500"));

        status.store(410, Ordering::SeqCst);
        assert_eq!(api(&s, "POST", &format!("/api/push/subscriptions/{id}/test"), None).await.0, 502);
        assert_eq!(api(&s, "GET", "/api/push", None).await.1["subscriptions"], json!([]));
    })
}

// ---------- permission prompts ----------

/// A task with a run going (so it can raise prompts), of `task_type` if given.
fn running_task(s: &Shared, task_type: Option<&str>) -> db::Task {
    let profile = db::insert_profile(&s.db(), &format!("p{}", crate::util::new_id()), &[], None).unwrap();
    let new = db::NewTask {
        profile_id: &profile.id,
        project_id: None,
        kind: "task",
        title: "Send the invoice",
        description: "",
        status: "in_progress",
        use_worktree: false,
        model: None,
        effort: None,
        claude_config_id: None,
    };
    let task = db::insert_task(&s.db(), new).unwrap();
    if let Some(tt) = task_type {
        s.db().execute("UPDATE tasks SET task_type=?1 WHERE id=?2", [tt, &task.id]).unwrap();
    }
    let run = db::insert_run(&s.db(), &task.id, "prompt").unwrap();
    s.db().execute("UPDATE runs SET status='running' WHERE id=?1", [&run.id]).unwrap();
    s.runs.lock().unwrap().insert(task.id.clone(), crate::state::RunHandle { run_id: run.id, cancel: None });
    s.update_task(&task.id, &[("running", json!(true))]).unwrap().unwrap()
}

/// Raises a prompt for `tool` from `task` and waits until it's asked: its request id, and what the agent is told.
async fn raise(s: &Shared, task: &db::Task, call: &str, tool: &str, input: Value) -> (String, tokio::task::JoinHandle<Value>) {
    let (s2, t2, call2, tool2) = (s.clone(), task.clone(), call.to_string(), tool.to_string());
    let told = tokio::spawn(async move { crate::mcp::permissions::prompt(&s2, &t2, &call2, &tool2, &input, None).await.unwrap() });
    loop {
        if let Ok(id) = s.db().query_row("SELECT id FROM permission_requests WHERE call_id=?1", [call], |r| r.get::<_, String>(0)) {
            return (id, told);
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

/// A device subscribed to `url` that wants `events`.
async fn subscribe_device(s: &Shared, url: &str, events: Value) -> agreement::PrivateKey {
    let (ua, keys) = device();
    let (status, sub) = api(s, "POST", "/api/push/subscriptions", Some(json!({"endpoint": url, "keys": keys, "events": events}))).await;
    assert_eq!(status, 200, "{sub}");
    ua
}

async fn next_push(got: &mut mpsc::UnboundedReceiver<(HeaderMap, Bytes)>, ua: &agreement::PrivateKey) -> Value {
    let (_, body) = tokio::time::timeout(Duration::from_secs(10), got.recv()).await.expect("no push").unwrap();
    serde_json::from_slice(&decrypt(ua, &[9u8; 16], &body)).unwrap()
}

async fn answer_from_push(s: &Shared, request: &str, token: &str, decision: &str) -> (u16, Value) {
    let req = axum::http::Request::builder()
        .method("POST")
        .uri(format!("/api/permissions/{request}/push-answer"))
        .header("content-type", "application/json")
        .body(axum::body::Body::from(json!({"token": token, "decision": decision}).to_string()))
        .unwrap();
    let res = crate::api::router(s.clone()).oneshot(req).await.unwrap();
    let status = res.status().as_u16();
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

/// Waits until the board has noted prompt `request`'s tokens as `status`.
async fn settled_as(s: &Shared, request: &str, status: &str) {
    for _ in 0..500 {
        if crate::integrations::push_answers::status_of(&s.db(), request).as_deref() == Some(status) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("prompt {request}'s tokens never became {status}");
}

#[test]
fn a_prompt_is_pushed_with_a_token_that_answers_it_once() {
    testing::run(async || {
        let s = testing::state();
        let (url, mut got) = push_service(Arc::new(AtomicU16::new(201))).await;
        let ua = subscribe_device(&s, &url, json!({"attention": true, "review": true, "prompts": "all"})).await;
        // Another device wants needs-attention, but no prompts: it's told of the task as before.
        let (other_url, mut other_got) = push_service(Arc::new(AtomicU16::new(201))).await;
        let other = subscribe_device(&s, &other_url, json!({"attention": true, "prompts": "off"})).await;
        crate::hosts::hub::start(&s).unwrap();
        start(&s);
        let task = running_task(&s, None);
        let (request, told) = raise(&s, &task, "c1", "Bash", json!({"command": "rm -rf /tmp/secret-stuff"})).await;

        let msg = next_push(&mut got, &ua).await;
        let token = msg["answer"]["token"].as_str().unwrap().to_string();
        let title = format!("T-{} Send the invoice", task.number);
        let want = json!({
            "title": title, "body": "Approve Bash?", "url": format!("/t/{}", task.id), "tag": format!("h:{}:{request}", task.id),
            "task_id": task.id, "event": "prompt", "request_id": request,
            "answer": {"url": format!("/api/permissions/{request}/push-answer"), "token": token},
        });
        assert_eq!(msg, want);
        // The other device gets the task's needs-attention; this one isn't told twice.
        assert_eq!(next_push(&mut other_got, &other).await["event"], "attention");
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(got.try_recv().is_err(), "the device that got the prompt was told it needs attention too");

        // Only its own token answers it, and only it.
        let (status, v) = answer_from_push(&s, &request, "not-the-token", "allow").await;
        assert_eq!((status, v["result"].as_str()), (403, Some("invalid")), "{v}");
        let (status, _) = answer_from_push(&s, "another-request", &token, "allow").await;
        assert_eq!(status, 403);
        assert_eq!(answer_from_push(&s, &request, &token, "maybe").await.0, 400);
        // The board's token isn't needed (nor taken instead of the prompt's).
        let (status, v) = answer_from_push(&s, &request, &token, "deny").await;
        assert_eq!((status, v["result"].as_str()), (200, Some("denied")), "{v}");
        assert_eq!(told.await.unwrap()["behavior"], "deny");
        // Once.
        let (status, v) = answer_from_push(&s, &request, &token, "allow").await;
        assert_eq!((status, v["result"].as_str()), (409, Some("answered")), "{v}");
        assert_eq!(v["message"], "It was already denied.");
    })
}

#[test]
fn a_token_stops_working_once_its_prompt_is_answered_on_the_board_or_expires() {
    testing::run(async || {
        let s = testing::state();
        let (url, mut got) = push_service(Arc::new(AtomicU16::new(201))).await;
        let ua = subscribe_device(&s, &url, json!({"prompts": "all"})).await;
        crate::hosts::hub::start(&s).unwrap();
        start(&s);
        let task = running_task(&s, None);

        // Answered on the board.
        let (request, told) = raise(&s, &task, "c1", "Bash", json!({})).await;
        let token = next_push(&mut got, &ua).await["answer"]["token"].as_str().unwrap().to_string();
        assert_eq!(api(&s, "POST", &format!("/api/permissions/{request}"), Some(json!({"decision": "allow"}))).await.0, 200);
        assert_eq!(told.await.unwrap()["behavior"], "allow");
        settled_as(&s, &request, "allowed").await;
        let (status, v) = answer_from_push(&s, &request, &token, "deny").await;
        assert_eq!((status, v["result"].as_str(), v["message"].as_str()), (409, Some("answered"), Some("It was already allowed.")));

        // Expired with its run.
        let (request, told) = raise(&s, &task, "c2", "Write", json!({})).await;
        let token = next_push(&mut got, &ua).await["answer"]["token"].as_str().unwrap().to_string();
        crate::mcp::permissions::expire_for_task(&s, &task.id);
        assert_eq!(told.await.unwrap()["behavior"], "deny");
        settled_as(&s, &request, "expired").await;
        let (status, v) = answer_from_push(&s, &request, &token, "allow").await;
        assert_eq!((status, v["result"].as_str()), (409, Some("expired")), "{v}");
    })
}

#[test]
fn an_answer_the_board_missed_is_found_out_from_the_host() {
    testing::run(async || {
        // Not watching: the board misses the prompt's answer (as over a link that was down).
        let s = testing::state();
        let task = running_task(&s, None);
        let (request, told) = raise(&s, &task, "c1", "Bash", json!({})).await;
        let token = crate::integrations::push_answers::mint(&s.db(), "h", &request, &task.id, None).unwrap();
        assert_eq!(api(&s, "POST", &format!("/api/permissions/{request}"), Some(json!({"decision": "deny"}))).await.0, 200);
        told.await.unwrap();
        let (status, v) = answer_from_push(&s, &request, &token, "allow").await;
        assert_eq!((status, v["result"].as_str()), (409, Some("closed")), "{v}");
        assert_eq!(answer_from_push(&s, &request, &token, "allow").await.0, 409);
    })
}

#[test]
fn questions_and_plans_are_pushed_without_allow_and_deny_and_only_the_assistants_by_default() {
    testing::run(async || {
        let s = testing::state();
        let (url, mut got) = push_service(Arc::new(AtomicU16::new(201))).await;
        // Its events as a browser that subscribed before prompts sends them.
        let ua = subscribe_device(&s, &url, json!({"attention": false, "review": false, "merge": false, "done": false})).await;
        assert_eq!(api(&s, "GET", "/api/push", None).await.1["subscriptions"][0]["events"]["prompts"], "assistant");
        crate::hosts::hub::start(&s).unwrap();
        start(&s);
        let project_task = running_task(&s, None);
        raise(&s, &project_task, "c0", "Bash", json!({})).await;
        let assistant = running_task(&s, Some("assistant"));
        raise(&s, &assistant, "c1", crate::mcp::permissions::ASK_USER, json!({"questions": [{"question": "Which account?"}]})).await;
        let msg = next_push(&mut got, &ua).await;
        assert_eq!((msg["task_id"].as_str(), msg["body"].as_str()), (Some(assistant.id.as_str()), Some("The agent has questions for you")));
        assert!(msg.get("answer").is_none(), "{msg}");
        raise(&s, &assistant, "c2", crate::mcp::permissions::EXIT_PLAN, json!({"plan": "# Plan: send it"})).await;
        let msg = next_push(&mut got, &ua).await;
        assert_eq!(msg["body"], "Plan ready for approval");
        assert!(msg.get("answer").is_none());
        raise(&s, &assistant, "c3", "mcp__gmail__send", json!({"to": "someone@example.com"})).await;
        let msg = next_push(&mut got, &ua).await;
        assert_eq!(msg["body"], "Approve mcp__gmail__send?");
        assert!(msg["answer"]["token"].is_string());
        assert!(!msg.to_string().contains("example.com"), "a tool's input was pushed: {msg}");
        // Nothing of the project task's.
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(got.try_recv().is_err());
    })
}

#[test]
fn a_prompt_on_a_linked_host_is_answered_through_the_link() {
    testing::run(async || {
        let hub = testing::state();
        let remote = testing::state_as(crate::state::Identity {
            host_id: "remote".into(),
            host_name: "assistant box".into(),
            token: "remote-token".into(),
            hub_token: String::new(),
            internal_url: String::new(),
        });
        let (url, mut got) = push_service(Arc::new(AtomicU16::new(201))).await;
        let ua = subscribe_device(&hub, &url, json!({"prompts": "all"})).await;
        // The remote's events reach the hub over the link.
        let mut events = remote.events.subscribe();
        let to = hub.clone();
        tokio::spawn(async move {
            while let Ok(mut ev) = events.recv().await {
                ev["host_id"] = json!("remote");
                let _ = to.hub_events.send(ev);
            }
        });
        // As the remote takes the hub's requests: with its token.
        let signed_in = crate::api::router(remote.clone()).layer(axum::middleware::map_request(|mut req: axum::http::Request<axum::body::Body>| async move {
            req.headers_mut().insert("authorization", "Bearer remote-token".parse().unwrap());
            req
        }));
        crate::hosts::hub::link_http(&hub, "remote", signed_in, crate::hosts::proto::API_VERSION).await;
        start(&hub);
        let task = running_task(&remote, Some("assistant"));
        let (request, told) = raise(&remote, &task, "c1", "Bash", json!({})).await;
        let msg = next_push(&mut got, &ua).await;
        assert_eq!(msg["tag"], format!("remote:{}:{request}", task.id));
        let token = msg["answer"]["token"].as_str().unwrap().to_string();
        // The hub keeps the token; the remote never sees it.
        assert_eq!(crate::integrations::push_answers::status_of(&remote.db(), &request), None);

        // While the link is down it says so, and the token still works after.
        let link = hub.links.lock().unwrap().remove("remote").unwrap();
        let (status, v) = answer_from_push(&hub, &request, &token, "allow").await;
        assert_eq!((status, v["result"].as_str()), (503, Some("offline")), "{v}");
        hub.links.lock().unwrap().insert("remote".into(), link);
        let (status, v) = answer_from_push(&hub, &request, &token, "allow").await;
        assert_eq!((status, v["result"].as_str()), (200, Some("allowed")), "{v}");
        assert_eq!(told.await.unwrap()["behavior"], "allow");
        // Answering the remote's prompt with the remote's own push-answer route (which has no token for it) fails.
        assert_eq!(answer_from_push(&remote, &request, &token, "allow").await.0, 403);
    })
}

#[test]
fn a_prompt_the_board_missed_the_end_of_doesnt_keep_its_task_from_notifying() {
    testing::run(async || {
        let s = testing::state();
        let (url, mut got) = push_service(Arc::new(AtomicU16::new(201))).await;
        let ua = subscribe_device(&s, &url, json!({"attention": true, "prompts": "all"})).await;
        start(&s);
        emit(&s, &with(task("in_progress"), json!({"running": true})));
        while !s.push.tasks.lock().unwrap().contains_key("h:t1") {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        // A prompt it heard of, but not its answer (over a link that was down).
        s.push.prompts.lock().unwrap().entry("h:t1".into()).or_default().insert("r1".into());
        // The run ends, and the task needs attention for another reason.
        emit(&s, &with(task("needs_attention"), json!({"running": false, "attention_reason": "The run failed"})));
        let msg = next_push(&mut got, &ua).await;
        assert_eq!((msg["event"].as_str(), msg["body"].as_str()), (Some("attention"), Some("Needs attention: The run failed")));
    })
}

#[test]
fn an_answer_cut_off_part_way_doesnt_hold_its_prompt_after_a_restart_or_its_lease() {
    testing::run(async || {
        let hub = testing::state();
        let remote = testing::state_as(crate::state::Identity {
            host_id: "remote".into(),
            host_name: "assistant box".into(),
            token: "remote-token".into(),
            hub_token: String::new(),
            internal_url: String::new(),
        });
        let signed_in = crate::api::router(remote.clone()).layer(axum::middleware::map_request(|mut req: axum::http::Request<axum::body::Body>| async move {
            req.headers_mut().insert("authorization", "Bearer remote-token".parse().unwrap());
            req
        }));
        crate::hosts::hub::link_http(&hub, "remote", signed_in, crate::hosts::proto::API_VERSION).await;
        let task = running_task(&remote, Some("assistant"));
        let (request, told) = raise(&remote, &task, "c1", "Bash", json!({})).await;
        let token = crate::integrations::push_answers::mint(&hub.db(), "remote", &request, &task.id, None).unwrap();
        // The hub claimed it to answer, and stopped before it could (the claim is in its database).
        let claim = |request: &str, at: String| {
            hub.db().execute("UPDATE push_answer_tokens SET status='answering', claimed_at=?1 WHERE request_id=?2", [at.as_str(), request]).unwrap()
        };
        assert_eq!(claim(&request, crate::util::now()), 1);
        let (status, v) = answer_from_push(&hub, &request, &token, "allow").await;
        assert_eq!((status, v["result"].as_str()), (409, Some("answered")), "a claim under way holds: {v}");
        // Started again: no answer is under way.
        start(&hub);
        let (status, v) = answer_from_push(&hub, &request, &token, "deny").await;
        assert_eq!((status, v["result"].as_str()), (200, Some("denied")), "{v}");
        assert_eq!(told.await.unwrap()["behavior"], "deny");

        // A claim older than any answer takes runs out without a restart.
        let (request, told) = raise(&remote, &task, "c2", "Bash", json!({})).await;
        let token = crate::integrations::push_answers::mint(&hub.db(), "remote", &request, &task.id, None).unwrap();
        assert_eq!(claim(&request, (chrono::Utc::now() - chrono::Duration::minutes(10)).to_rfc3339()), 1);
        let (status, v) = answer_from_push(&hub, &request, &token, "allow").await;
        assert_eq!((status, v["result"].as_str()), (200, Some("allowed")), "{v}");
        assert_eq!(told.await.unwrap()["behavior"], "allow");
    })
}

#[test]
fn a_notification_cant_answer_a_prompt_past_its_expiry_and_one_it_answers_is_logged_as_from_it() {
    use crate::agent::approval_rules::{self, Decision, Rule, Rules};
    testing::run(async || {
        let s = testing::state();
        let task = running_task(&s, Some("assistant"));
        let ask = Rule { tool: "mcp__google__send*".into(), decision: Decision::Ask };
        approval_rules::set(&s.db(), &task.profile_id, Some(&Rules { rules: vec![ask], expiry_minutes: 30 })).unwrap();
        let (request, told) = raise(&s, &task, "c1", "mcp__google__send_gmail_message", json!({})).await;
        // Its time is up, though the host hasn't said so (its sweeper hasn't run, or the link is down).
        let past = (chrono::Utc::now() - chrono::Duration::seconds(1)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let late = crate::integrations::push_answers::mint(&s.db(), "h", &request, &task.id, Some(&past)).unwrap();
        let (status, v) = answer_from_push(&s, &request, &late, "allow").await;
        assert_eq!((status, v["result"].as_str()), (409, Some("expired")), "{v}");
        assert!(v["message"].as_str().unwrap().contains("nobody answered it in time"), "{v}");
        // Still waiting on the host: the late answer didn't go through.
        assert_eq!(crate::mcp::permissions::pending(&s, Some(&task.id)).unwrap().len(), 1);
        // One in time does, and the action log says it came from a notification.
        let future = (chrono::Utc::now() + chrono::Duration::minutes(30)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let token = crate::integrations::push_answers::mint(&s.db(), "h", &request, &task.id, Some(&future)).unwrap();
        let (status, v) = answer_from_push(&s, &request, &token, "allow").await;
        assert_eq!((status, v["result"].as_str()), (200, Some("allowed")), "{v}");
        assert_eq!(told.await.unwrap()["behavior"], "allow");
        let log = approval_rules::list(&s.db(), &task.profile_id, 10).unwrap();
        assert_eq!((log[0].outcome.as_str(), log[0].answered_by.as_deref()), ("allowed", Some("push")));
    })
}
