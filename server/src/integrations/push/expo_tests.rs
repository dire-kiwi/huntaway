//! The mobile app's push, through a fake of Expo's push service.

use super::tests::*;
use super::*;
use crate::state::Identity;
use crate::testing;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;
use tower::ServiceExt;

/// Expo's push service on this machine. Each message is taken (its ticket's id is `ticket:<token>`) unless its token
/// says otherwise: `Gone` isn't registered, `Slow` is over its rate. Receipts are what the test puts in `receipts`.
struct FakeExpo {
    url: String,
    /// Each request to send, as posted.
    sent: mpsc::UnboundedReceiver<Value>,
    /// Each request for receipts, as posted.
    asked: mpsc::UnboundedReceiver<Value>,
    receipts: Arc<Mutex<Value>>,
    /// What it answers with (200, or a failure).
    status: Arc<AtomicU16>,
}

async fn expo() -> FakeExpo {
    let (sent_tx, sent) = mpsc::unbounded_channel();
    let (asked_tx, asked) = mpsc::unbounded_channel();
    let receipts = Arc::new(Mutex::new(json!({})));
    let status = Arc::new(AtomicU16::new(200));
    let (st, st2) = (status.clone(), status.clone());
    let r = receipts.clone();
    let app = axum::Router::new()
        .route(
            "/--/api/v2/push/send",
            axum::routing::post(move |Json(body): Json<Value>| {
                let (tx, status) = (sent_tx.clone(), st.clone());
                async move {
                    let _ = tx.send(body.clone());
                    let code = axum::http::StatusCode::from_u16(status.load(Ordering::SeqCst)).unwrap();
                    if !code.is_success() {
                        return (code, Json(json!({"errors": [{"code": "INTERNAL", "message": "Expo is down"}]})));
                    }
                    let tickets: Vec<Value> = body
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|m| {
                            let to = m["to"].as_str().unwrap();
                            if to.contains("Gone") {
                                json!({"status": "error", "message": format!("\"{to}\" is not a registered push notification recipient"), "details": {"error": "DeviceNotRegistered"}})
                            } else if to.contains("Slow") {
                                json!({"status": "error", "message": "too many", "details": {"error": "MessageRateExceeded"}})
                            } else {
                                json!({"status": "ok", "id": format!("ticket:{to}")})
                            }
                        })
                        .collect();
                    (code, Json(json!({"data": tickets})))
                }
            }),
        )
        .route(
            "/--/api/v2/push/getReceipts",
            axum::routing::post(move |Json(body): Json<Value>| {
                let (tx, r, status) = (asked_tx.clone(), r.clone(), st2.clone());
                async move {
                    let _ = tx.send(body.clone());
                    let code = axum::http::StatusCode::from_u16(status.load(Ordering::SeqCst)).unwrap();
                    let all = r.lock().unwrap().clone();
                    let mut data = json!({});
                    for id in body["ids"].as_array().unwrap() {
                        let id = id.as_str().unwrap();
                        if !all[id].is_null() {
                            data[id] = all[id].clone();
                        }
                    }
                    (code, Json(json!({"data": data})))
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/--/api/v2/push/send", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    FakeExpo { url, sent, asked, receipts, status }
}

async fn next(rx: &mut mpsc::UnboundedReceiver<Value>) -> Value {
    tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.expect("nothing was sent to Expo").unwrap()
}

fn token(name: &str) -> String {
    format!("ExponentPushToken[{name}]")
}

/// Subscribes the app (with the board's token) for `events`.
async fn subscribe_app(s: &Shared, token: &str, events: Value) -> Value {
    let (status, sub) = api(s, "POST", "/api/push/subscriptions", Some(json!({"kind": "expo", "endpoint": token, "name": "Pixel", "events": events}))).await;
    assert_eq!(status, 200, "{sub}");
    sub
}

fn subscriptions(s: &Shared) -> Vec<Subscription> {
    list(&s.db()).unwrap()
}

fn sub_for(s: &Shared, token: &str) -> Option<Subscription> {
    subscriptions(s).into_iter().find(|x| x.endpoint == token)
}

/// A task in project WEB, as the board shows it.
fn project_task(s: &Shared) -> Value {
    let profile = db::insert_profile(&s.db(), "work", &[], None).unwrap();
    let x = "/x";
    let p = db::NewProject { id: "p1", profile_id: &profile.id, name: "Web", key: "WEB", repo_path: x, scratch_path: x, worktrees_root: x, base_branch: None, use_worktrees: false };
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
    json!(db::insert_task(&s.db(), new).unwrap())
}

#[test]
fn the_app_subscribes_with_its_expo_token_and_is_pushed_through_expo() {
    testing::run(async || {
        let s = testing::state();
        let mut fake = expo().await;
        s.push.set_expo_url(&fake.url);
        let phone = token("phone-1");
        let sub = subscribe_app(&s, &phone, json!({"attention": true, "review": false, "merge": false, "done": false})).await;
        assert_eq!((sub["kind"].as_str(), sub["endpoint"].as_str()), (Some("expo"), Some(phone.as_str())));
        // Its token, not a URL or keys; and a browser's subscription still needs its keys.
        for bad in ["https://exp.host/x", "ExponentPushToken[]", "ExponentPushToken[a b]", "ExponentPushToken[abc", "phone"] {
            let (status, err) = api(&s, "POST", "/api/push/subscriptions", Some(json!({"kind": "expo", "endpoint": bad}))).await;
            assert_eq!(status, 400, "{bad}: {err}");
        }
        assert_eq!(api(&s, "POST", "/api/push/subscriptions", Some(json!({"endpoint": "https://push.example.com/x"}))).await.0, 400);
        // The same token again is the same subscription.
        let again = subscribe_app(&s, &phone, json!({"attention": true, "review": false, "merge": true, "done": false})).await;
        assert_eq!((&again["id"], &again["events"]["merge"]), (&sub["id"], &json!(true)));
        // A browser wants the same events.
        let (url, mut web) = push_service(Arc::new(AtomicU16::new(201))).await;
        let ua = subscribe_device(&s, &url, json!({"attention": true})).await;

        let t = project_task(&s);
        start(&s);
        emit(&s, &with(t.clone(), json!({"status": "needs_attention", "attention_reason": "It printed the database password", "running": true})));
        let sent = next(&mut fake.sent).await;
        let id = t["id"].as_str().unwrap();
        let msgs = sent.as_array().unwrap();
        assert_eq!(msgs.len(), 1, "{sent}");
        let m = &msgs[0];
        let collapse = m["collapseId"].as_str().unwrap().to_string();
        assert_eq!(collapse.len(), 32);
        let want = json!({
            "to": phone,
            "title": format!("WEB-{} Fix the login", t["number"]),
            // Expo can read it: not the reason, which can quote the agent.
            "body": "Needs attention",
            "data": {"board": "h", "host": "h", "task_id": id, "url": format!("/t/{id}"), "tag": format!("h:{id}"), "event": "attention"},
            "ttl": 86400,
            "priority": "high",
            "sound": "default",
            "channelId": "default",
            "collapseId": collapse,
            "tag": collapse,
        });
        assert_eq!(m, &want);
        // The browser's is encrypted for it, with the reason; each kind gets only its own.
        assert_eq!(next_push(&mut web, &ua).await["body"], "Needs attention: It printed the database password");
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(fake.sent.try_recv().is_err() && web.try_recv().is_err());
        let phone_sub = sub_for(&s, &phone).unwrap();
        assert!(phone_sub.last_sent_at.is_some() && phone_sub.last_error.is_none());
        assert_eq!(s.push.tickets.lock().unwrap().iter().map(|t| t.id.clone()).collect::<Vec<_>>(), vec![format!("ticket:{phone}")]);

        // A test from Settings goes through Expo too.
        let (status, v) = api(&s, "POST", &format!("/api/push/subscriptions/{}/test", sub["id"].as_str().unwrap()), None).await;
        assert_eq!(status, 200, "{v}");
        assert_eq!(next(&mut fake.sent).await[0]["body"], "Push notifications work on this device.");
    })
}

#[test]
fn pushes_to_many_phones_go_to_expo_in_batches_of_100() {
    testing::run(async || {
        let s = testing::state();
        let mut fake = expo().await;
        s.push.set_expo_url(&fake.url);
        for i in 0..150 {
            subscribe_app(&s, &token(&format!("p{i}")), json!({"attention": true})).await;
        }
        start(&s);
        emit(&s, &with(task("needs_attention"), json!({"running": true})));
        // (The first sight of a task notifies of nothing: it's the board's baseline.)
        emit(&s, &with(task("in_progress"), json!({"running": true})));
        emit(&s, &with(task("needs_attention"), json!({"running": true})));
        let (a, b) = (next(&mut fake.sent).await, next(&mut fake.sent).await);
        assert_eq!((a.as_array().unwrap().len(), b.as_array().unwrap().len()), (100, 50));
        let mut to: Vec<String> = a.as_array().unwrap().iter().chain(b.as_array().unwrap()).map(|m| m["to"].as_str().unwrap().to_string()).collect();
        to.sort();
        to.dedup();
        assert_eq!(to.len(), 150);
    })
}

#[test]
fn tickets_and_receipts_drop_unregistered_phones_and_note_other_failures() {
    testing::run(async || {
        let s = testing::state();
        let mut fake = expo().await;
        s.push.set_expo_url(&fake.url);
        let names = ["ok1", "ok2", "ok3", "Gone", "Slow"];
        for n in names {
            subscribe_app(&s, &token(n), json!({"attention": true})).await;
        }
        let test_all = async |s: &Shared| {
            let subs = subscriptions(s);
            let msg = Message {
                title: "t".into(),
                body: "b".into(),
                url: "/".into(),
                tag: "x".into(),
                task_id: None,
                event: None,
                request_id: None,
                answer: None,
                host_id: None,
                summary: None,
            };
            send_all(s, &subs, &msg, false).await;
        };
        test_all(&s).await;
        assert_eq!(next(&mut fake.sent).await.as_array().unwrap().len(), 5);
        // Its ticket says one isn't registered (the app was uninstalled): it's dropped. Another failed, and says why.
        assert!(sub_for(&s, &token("Gone")).is_none());
        let slow = sub_for(&s, &token("Slow")).unwrap();
        assert!(slow.last_error.as_deref().unwrap().contains("MessageRateExceeded"), "{slow:?}");
        assert_eq!(s.push.tickets.lock().unwrap().len(), 3);

        // Receipts aren't asked for until they're due.
        check_receipts(&s, RECEIPT_AFTER).await;
        assert!(fake.asked.try_recv().is_err());
        assert_eq!(s.push.tickets.lock().unwrap().len(), 3);

        // Apple or Google turned one down as unregistered, and another as too big; the third's isn't ready yet.
        *fake.receipts.lock().unwrap() = json!({
            format!("ticket:{}", token("ok1")): {"status": "error", "message": "gone", "details": {"error": "DeviceNotRegistered"}},
            format!("ticket:{}", token("ok2")): {"status": "error", "message": "too big", "details": {"error": "MessageTooBig"}},
        });
        check_receipts(&s, Duration::ZERO).await;
        let mut ids: Vec<String> = next(&mut fake.asked).await["ids"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
        ids.sort();
        assert_eq!(ids, ["ok1", "ok2", "ok3"].map(|n| format!("ticket:{}", token(n))));
        assert!(sub_for(&s, &token("ok1")).is_none());
        assert!(sub_for(&s, &token("ok2")).unwrap().last_error.unwrap().contains("MessageTooBig"));
        assert!(sub_for(&s, &token("ok3")).unwrap().last_error.is_none());
        // Asked for again next time.
        assert_eq!(s.push.tickets.lock().unwrap().iter().map(|t| t.id.clone()).collect::<Vec<_>>(), vec![format!("ticket:{}", token("ok3"))]);
        *fake.receipts.lock().unwrap() = json!({format!("ticket:{}", token("ok3")): {"status": "ok"}});
        check_receipts(&s, Duration::ZERO).await;
        next(&mut fake.asked).await;
        assert!(s.push.tickets.lock().unwrap().is_empty());
        assert!(sub_for(&s, &token("ok3")).unwrap().last_error.is_none());

        // Expo itself failing: each push notes why, and the receipts are kept for later.
        fake.status.store(503, Ordering::SeqCst);
        test_all(&s).await;
        next(&mut fake.sent).await;
        for n in ["ok2", "ok3"] {
            let e = sub_for(&s, &token(n)).unwrap().last_error.unwrap();
            assert!(e.contains("503") && e.contains("Expo is down"), "{e}");
        }
        fake.status.store(200, Ordering::SeqCst);
        test_all(&s).await;
        next(&mut fake.sent).await;
        assert!(sub_for(&s, &token("ok3")).unwrap().last_error.is_none());
        fake.status.store(500, Ordering::SeqCst);
        check_receipts(&s, Duration::ZERO).await;
        next(&mut fake.asked).await;
        assert_eq!(s.push.tickets.lock().unwrap().len(), 2);
    })
}

#[test]
fn a_prompt_reaches_the_app_with_allow_and_deny_but_not_the_tools_input() {
    testing::run(async || {
        let s = testing::state();
        let mut fake = expo().await;
        s.push.set_expo_url(&fake.url);
        subscribe_app(&s, &token("phone"), json!({"attention": true, "prompts": "all"})).await;
        crate::hosts::hub::start(&s).unwrap();
        start(&s);
        let task = running_task(&s, None);
        let (request, told) = raise(&s, &task, "c1", "Bash", json!({"command": "cat ~/.ssh/id_ed25519"})).await;
        let sent = next(&mut fake.sent).await;
        let m = &sent[0];
        assert!(!sent.to_string().contains("id_ed25519"), "{sent}");
        assert_eq!((m["body"].as_str(), m["categoryId"].as_str(), m["channelId"].as_str()), (Some("Approve Bash?"), Some("prompt"), Some("prompts")));
        assert_eq!((m["data"]["event"].as_str(), m["data"]["request_id"].as_str(), m["data"]["task_id"].as_str()), (Some("prompt"), Some(request.as_str()), Some(task.id.as_str())));
        assert_eq!(m["data"]["answer"]["url"], format!("/api/permissions/{request}/push-answer"));
        // Not told again that it needs attention: the prompt is the notification.
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(fake.sent.try_recv().is_err());
        let token = m["data"]["answer"]["token"].as_str().unwrap();
        let (status, v) = answer_from_push(&s, &request, token, "allow").await;
        assert_eq!((status, v["result"].as_str()), (200, Some("allowed")), "{v}");
        assert_eq!(told.await.unwrap()["behavior"], "allow");
        let (status, v) = answer_from_push(&s, &request, token, "deny").await;
        assert_eq!((status, v["result"].as_str(), v["message"].as_str()), (409, Some("answered"), Some("It was already allowed.")));

        // A question opens the app instead: no category for Allow and Deny.
        let (_, _told) = raise(&s, &task, "c2", "AskUserQuestion", json!({"questions": []})).await;
        let m = next(&mut fake.sent).await[0].clone();
        assert!(m.get("categoryId").is_none() && m["data"].get("answer").is_none(), "{m}");
    })
}

// ---------- paired devices ----------

const BOARD: &str = "board-token";

fn board() -> Shared {
    testing::state_as(Identity { host_id: "h".into(), host_name: "desktop".into(), token: BOARD.into(), hub_token: String::new(), internal_url: String::new() })
}

async fn call(s: &Shared, method: &str, path: &str, token: &str, body: Option<Value>) -> (u16, Value) {
    let req = axum::http::Request::builder()
        .method(method)
        .uri(path)
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(axum::body::Body::from(body.map(|b| b.to_string()).unwrap_or_default()))
        .unwrap();
    let res = crate::api::router(s.clone()).oneshot(req).await.unwrap();
    let status = res.status().as_u16();
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

/// Pairs a device: its token and id.
async fn pair(s: &Shared, name: &str) -> (String, String) {
    let (_, code) = call(s, "POST", "/api/devices/pairing", BOARD, Some(json!({}))).await;
    let (status, paired) = call(s, "POST", "/api/devices/pair", "", Some(json!({"code": code["code"], "name": name}))).await;
    assert_eq!(status, 200, "{paired}");
    (paired["token"].as_str().unwrap().into(), paired["device"]["id"].as_str().unwrap().into())
}

#[test]
fn a_paired_phone_has_only_its_own_subscriptions_which_go_when_its_revoked() {
    testing::run(async || {
        let s = board();
        let (phone, phone_id) = pair(&s, "phone").await;
        let (tablet, tablet_id) = pair(&s, "tablet").await;
        // Only the app's kind, from a device.
        let (_, keys) = device();
        let (status, err) = call(&s, "POST", "/api/push/subscriptions", &phone, Some(json!({"endpoint": "https://push.example.com/x", "keys": keys}))).await;
        assert_eq!(status, 403, "{err}");
        let (status, mine) = call(&s, "POST", "/api/push/subscriptions", &phone, Some(json!({"kind": "expo", "endpoint": token("phone"), "name": "phone"}))).await;
        assert_eq!((status, mine["device_id"].as_str()), (200, Some(phone_id.as_str())), "{mine}");
        let (_, theirs) = call(&s, "POST", "/api/push/subscriptions", &tablet, Some(json!({"kind": "expo", "endpoint": token("tablet")}))).await;
        assert_eq!(theirs["device_id"], json!(tablet_id));
        api(&s, "GET", "/api/push", None).await;
        let (mine_id, theirs_id) = (mine["id"].as_str().unwrap(), theirs["id"].as_str().unwrap());

        // It sees and changes its own; the board sees them all.
        let (status, list) = call(&s, "GET", "/api/push", &phone, None).await;
        assert_eq!(status, 200);
        assert_eq!(list["subscriptions"].as_array().unwrap().iter().map(|x| x["id"].clone()).collect::<Vec<_>>(), vec![mine["id"].clone()]);
        assert_eq!(call(&s, "GET", "/api/push", BOARD, None).await.1["subscriptions"].as_array().unwrap().len(), 2);
        let events = json!({"events": {"attention": false, "review": true, "merge": true, "done": true, "prompts": "all"}});
        let (status, changed) = call(&s, "PATCH", &format!("/api/push/subscriptions/{mine_id}"), &phone, Some(events.clone())).await;
        assert_eq!((status, &changed["events"]["prompts"]), (200, &json!("all")));
        for (m, p) in [("PATCH", format!("/api/push/subscriptions/{theirs_id}")), ("DELETE", format!("/api/push/subscriptions/{theirs_id}")), ("POST", format!("/api/push/subscriptions/{theirs_id}/test"))] {
            assert_eq!(call(&s, m, &p, &phone, Some(events.clone())).await.0, 404, "{m} {p}");
        }
        // Not a host's route.
        assert_eq!(call(&s, "GET", "/api/h/h/push", &phone, None).await.0, 403);
        // The answer from a notification needs no token, but a device's doesn't keep it from getting there.
        let (status, v) = call(&s, "POST", "/api/permissions/r1/push-answer", &phone, Some(json!({"token": "x", "decision": "allow"}))).await;
        assert_eq!((status, v["result"].as_str()), (403, Some("invalid")), "{v}");

        // Re-registering the same token from another pairing of the phone takes it over.
        let (again, again_id) = pair(&s, "phone again").await;
        let (_, took) = call(&s, "POST", "/api/push/subscriptions", &again, Some(json!({"kind": "expo", "endpoint": token("phone")}))).await;
        assert_eq!((&took["id"], took["device_id"].as_str(), &took["events"]["prompts"]), (&mine["id"], Some(again_id.as_str()), &json!("all")));
        assert_eq!(call(&s, "GET", "/api/push", &phone, None).await.1["subscriptions"], json!([]));

        // Revoking a device drops its subscriptions, and only its.
        assert_eq!(call(&s, "DELETE", &format!("/api/devices/{again_id}"), BOARD, None).await.0, 200);
        let left: Vec<Subscription> = subscriptions(&s);
        assert_eq!(left.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), vec![theirs_id]);
        // A device can unsubscribe itself.
        assert_eq!(call(&s, "DELETE", &format!("/api/push/subscriptions/{theirs_id}"), &tablet, None).await.0, 200);
        assert!(subscriptions(&s).is_empty());
    })
}

#[test]
fn a_move_made_from_the_phone_isnt_pushed_to_it() {
    testing::run(async || {
        let s = board();
        let mut fake = expo().await;
        s.push.set_expo_url(&fake.url);
        let (phone, _) = pair(&s, "phone").await;
        let events = json!({"attention": true, "review": true, "merge": true, "done": true});
        let (status, _) = call(&s, "POST", "/api/push/subscriptions", &phone, Some(json!({"kind": "expo", "endpoint": token("phone"), "events": events}))).await;
        assert_eq!(status, 200);
        let t = project_task(&s);
        let id = t["id"].as_str().unwrap();
        crate::hosts::hub::start(&s).unwrap();
        start(&s);
        // The app moves tasks through the hub's proxy, as the web board does.
        let (status, moved) = call(&s, "PATCH", &format!("/api/h/h/tasks/{id}"), &phone, Some(json!({"status": "done"}))).await;
        assert_eq!((status, moved["status"].as_str()), (200, Some("done")), "{moved}");
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(fake.sent.try_recv().is_err(), "the phone's own move was pushed to it");
        // What happens next, not of its doing, is.
        s.update_task(id, &[("status", json!("needs_attention")), ("attention_reason", json!("Merge failed"))]).unwrap();
        let m = next(&mut fake.sent).await[0].clone();
        assert_eq!((m["data"]["event"].as_str(), m["body"].as_str()), (Some("attention"), Some("Needs attention")));
    })
}

#[test]
fn a_new_token_for_the_same_phone_keeps_its_subscription_and_events() {
    testing::run(async || {
        let s = board();
        let (phone, phone_id) = pair(&s, "phone").await;
        let quiet = json!({"attention": false, "review": false, "merge": false, "done": false, "prompts": "off", "reports": true});
        let (_, first) = call(&s, "POST", "/api/push/subscriptions", &phone, Some(json!({"kind": "expo", "endpoint": token("old"), "name": "phone", "events": quiet}))).await;
        // Expo's token rotated: the app subscribes again with the new one, and no events (it keeps what's there).
        let (status, next) = call(&s, "POST", "/api/push/subscriptions", &phone, Some(json!({"kind": "expo", "endpoint": token("new"), "name": "phone"}))).await;
        assert_eq!(status, 200, "{next}");
        assert_eq!((&next["id"], next["endpoint"].as_str(), &next["events"]), (&first["id"], Some(token("new").as_str()), &quiet));
        let all = subscriptions(&s);
        assert_eq!((all.len(), all[0].device_id.as_deref()), (1, Some(phone_id.as_str())));
        // Another phone's subscription is left alone, and a phone that had two (from before) is left with the one.
        let (tablet, _) = pair(&s, "tablet").await;
        call(&s, "POST", "/api/push/subscriptions", &tablet, Some(json!({"kind": "expo", "endpoint": token("tablet")}))).await;
        s.db()
            .execute("INSERT INTO push_subscriptions (id,endpoint,p256dh,auth,events,created_at,kind,device_id) VALUES ('x',?1,'','','{}','0','expo',?2)", params![token("stale"), phone_id])
            .unwrap();
        call(&s, "POST", "/api/push/subscriptions", &phone, Some(json!({"kind": "expo", "endpoint": token("new")}))).await;
        let mut left: Vec<String> = subscriptions(&s).into_iter().map(|x| x.endpoint).collect();
        left.sort();
        assert_eq!(left, vec![token("new"), token("tablet")]);
    })
}

#[test]
fn what_expo_says_of_an_old_token_doesnt_touch_the_new_one() {
    testing::run(async || {
        let s = board();
        let mut fake = expo().await;
        s.push.set_expo_url(&fake.url);
        let (phone, _) = pair(&s, "phone").await;
        let picked = json!({"attention": true, "review": false, "merge": true, "done": false, "prompts": "all", "reports": true});
        let (_, sub) = call(&s, "POST", "/api/push/subscriptions", &phone, Some(json!({"kind": "expo", "endpoint": token("A"), "events": picked}))).await;
        let id = sub["id"].as_str().unwrap().to_string();
        // A push to A is taken...
        let (status, _) = call(&s, "POST", &format!("/api/push/subscriptions/{id}/test"), BOARD, None).await;
        assert_eq!(status, 200);
        next(&mut fake.sent).await;
        // ...the phone's token becomes B...
        let (_, moved) = call(&s, "POST", "/api/push/subscriptions", &phone, Some(json!({"kind": "expo", "endpoint": token("B")}))).await;
        assert_eq!((moved["id"].as_str(), moved["endpoint"].as_str()), (Some(id.as_str()), Some(token("B").as_str())));
        // ...and then A's receipt says it isn't registered, or failed.
        *fake.receipts.lock().unwrap() = json!({format!("ticket:{}", token("A")): {"status": "error", "message": "gone", "details": {"error": "DeviceNotRegistered"}}});
        check_receipts(&s, Duration::ZERO).await;
        next(&mut fake.asked).await;
        let now = sub_for(&s, &token("B")).expect("the new token's subscription was deleted");
        assert_eq!((json!(now.events), now.last_error.clone()), (picked.clone(), None));
        // A send to A that answers after the change is about A too.
        let old = Subscription { endpoint: token("A"), ..now.clone() };
        noted(&s, &old, &Err(Failed("too late".into()))).unwrap();
        noted(&s, &old, &Err(Gone("too late".into()))).unwrap();
        assert_eq!(sub_for(&s, &token("B")).unwrap().last_error, None);
    })
}

// HA-125: a routine's report reaches the app as well, without its text, which can quote mail, as Expo can read it.
#[test]
fn a_routines_report_reaches_the_app_without_what_it_says() {
    testing::run(async || {
        let s = testing::state();
        let mut fake = expo().await;
        s.push.set_expo_url(&fake.url);
        subscribe_app(&s, &token("phone"), json!({"attention": false, "review": false, "merge": false, "done": false})).await;
        let profile = db::insert_profile(&s.db(), "personal", &[], None).unwrap();
        let assistant = crate::agent::assistant::get_or_create(&s, &profile.id).unwrap();
        crate::hosts::hub::start(&s).unwrap();
        start(&s);
        while s.events.receiver_count() == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let data = json!({"automation": "Morning brief", "outcome": "reported", "text": "Kim's invoice 4411 for $1,250 is overdue"});
        s.add_message(&assistant.id, "report", data).unwrap();
        let sent = next(&mut fake.sent).await;
        let m = &sent[0];
        assert!(!sent.to_string().contains("invoice"), "{sent}");
        assert_eq!((m["title"].as_str(), m["body"].as_str(), m["data"]["event"].as_str()), (Some("Morning brief"), Some("Posted a report"), Some("report")), "{m}");
        assert_eq!((m["data"]["task_id"].as_str(), m["data"]["host"].as_str()), (Some(assistant.id.as_str()), Some(s.host_id.as_str())));
    })
}
