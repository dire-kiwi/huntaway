use super::*;
use crate::state::Identity;
use axum::extract::Request;
use axum::Router;
use futures::{SinkExt, StreamExt};
use tower::ServiceExt;

const BOARD: &str = "board-token";

fn state() -> Shared {
    crate::testing::state_as(Identity { host_id: "h".into(), host_name: "desktop".into(), token: BOARD.into(), hub_token: String::new(), internal_url: String::new() })
}

/// Status and JSON body of a request to `app` with `token` as its bearer token (none for "").
async fn call(app: &Router, method: &str, path: &str, token: &str, body: Option<Value>) -> (u16, Value) {
    let mut req = Request::builder().method(method).uri(path);
    if !token.is_empty() {
        req = req.header("authorization", format!("Bearer {token}"));
    }
    let req = match body {
        Some(b) => req.header("content-type", "application/json").body(axum::body::Body::from(b.to_string())),
        None => req.body(axum::body::Body::empty()),
    }
    .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status().as_u16();
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

/// Pairs a device named `name`, returning its token and id.
async fn pair_device(app: &Router, name: &str) -> (String, String) {
    let (status, code) = call(app, "POST", "/api/devices/pairing", BOARD, Some(json!({}))).await;
    assert_eq!(status, 200, "{code}");
    let (status, paired) = call(app, "POST", "/api/devices/pair", "", Some(json!({"code": code["code"], "name": name}))).await;
    assert_eq!(status, 200, "{paired}");
    (paired["token"].as_str().unwrap().to_string(), paired["device"]["id"].as_str().unwrap().to_string())
}

#[test]
fn a_code_pairs_one_device_whose_token_the_api_takes() {
    crate::testing::run(async || {
        let s = state();
        let app = crate::api::router(s.clone());
        // No pairing without the board's token, and a made-up code pairs nothing.
        assert_eq!(call(&app, "POST", "/api/devices/pairing", "", Some(json!({}))).await.0, 401);
        assert_eq!(call(&app, "POST", "/api/devices/pair", "", Some(json!({"code": "nope", "name": "x"}))).await.0, 403);

        let (_, code) = call(&app, "POST", "/api/devices/pairing", BOARD, Some(json!({}))).await;
        assert_eq!(code["ttl_secs"], 300);
        let (status, paired) = call(&app, "POST", "/api/devices/pair", "", Some(json!({"code": code["code"], "name": "  Ivan's\nphone "}))).await;
        assert_eq!(status, 200);
        assert_eq!((&paired["device"]["name"], &paired["host_id"], &paired["api_version"]), (&json!("Ivan'sphone"), &json!("h"), &json!(crate::hosts::proto::API_VERSION)));
        let token = paired["token"].as_str().unwrap();
        assert_ne!(token, BOARD);
        // Once only.
        assert_eq!(call(&app, "POST", "/api/devices/pair", "", Some(json!({"code": code["code"], "name": "again"}))).await.0, 403);
        // Only its hash is kept.
        let stored: String = s.db().query_row("SELECT token_hash FROM device_tokens", [], |r| r.get(0)).unwrap();
        assert_eq!(stored, hash(token));
        assert!(!stored.contains(token));

        // REST, through the hub to this host, and as ?token=.
        assert_eq!(call(&app, "GET", "/api/profiles", token, None).await, (200, json!([])));
        assert_eq!(call(&app, "GET", "/api/h/h/profiles", token, None).await, (200, json!([])));
        assert_eq!(call(&app, "GET", &format!("/api/hosts?token={token}"), "", None).await.0, 200);
        assert_eq!(call(&app, "GET", "/api/profiles", "wrong", None).await.0, 401);
        let used: Option<String> = s.db().query_row("SELECT last_used_at FROM device_tokens", [], |r| r.get(0)).unwrap();
        assert!(used.is_some());

        // It lists the devices, knowing itself.
        let (_, list) = call(&app, "GET", "/api/devices", token, None).await;
        assert_eq!((list["devices"].as_array().unwrap().len(), &list["current"]), (1, &paired["device"]["id"]));
        assert_eq!(call(&app, "GET", "/api/devices", BOARD, None).await.1["current"], Value::Null);
    })
}

#[test]
fn codes_expire() {
    crate::testing::run(async || {
        let s = state();
        let app = crate::api::router(s.clone());
        let (_, code) = call(&app, "POST", "/api/devices/pairing", BOARD, Some(json!({}))).await;
        let code = code["code"].as_str().unwrap().to_string();
        *s.devices.codes.lock().unwrap().get_mut(&code).unwrap() = Instant::now() - Duration::from_secs(1);
        assert_eq!(call(&app, "POST", "/api/devices/pair", "", Some(json!({"code": code, "name": "late"}))).await.0, 403);
        assert_eq!(list(&s.db()).unwrap().len(), 0);
        // There's a cap on codes waiting at once.
        for _ in 0..MAX_CODES + 5 {
            call(&app, "POST", "/api/devices/pairing", BOARD, Some(json!({}))).await;
        }
        assert_eq!(s.devices.codes.lock().unwrap().len(), MAX_CODES);
    })
}

#[test]
fn devices_are_managed_from_the_board_and_can_only_unpair_themselves() {
    crate::testing::run(async || {
        let s = state();
        let app = crate::api::router(s.clone());
        let (phone, phone_id) = pair_device(&app, "phone").await;
        let (tablet, tablet_id) = pair_device(&app, "tablet").await;

        // A device can't pair more, rename or revoke others.
        assert_eq!(call(&app, "POST", "/api/devices/pairing", &phone, Some(json!({}))).await.0, 403);
        assert_eq!(call(&app, "PATCH", &format!("/api/devices/{tablet_id}"), &phone, Some(json!({"name": "mine"}))).await.0, 403);
        assert_eq!(call(&app, "DELETE", &format!("/api/devices/{tablet_id}"), &phone, None).await.0, 403);
        assert_eq!(call(&app, "GET", "/api/profiles", &tablet, None).await.0, 200);

        // The board renames and revokes.
        let (status, renamed) = call(&app, "PATCH", &format!("/api/devices/{tablet_id}"), BOARD, Some(json!({"name": "iPad"}))).await;
        assert_eq!((status, &renamed["name"]), (200, &json!("iPad")));
        assert_eq!(call(&app, "DELETE", &format!("/api/devices/{tablet_id}"), BOARD, None).await.0, 200);
        assert_eq!(call(&app, "GET", "/api/profiles", &tablet, None).await.0, 401);
        assert_eq!(call(&app, "DELETE", &format!("/api/devices/{tablet_id}"), BOARD, None).await.0, 404);

        // A device unpairs itself.
        assert_eq!(call(&app, "DELETE", &format!("/api/devices/{phone_id}"), &phone, None).await.0, 200);
        assert_eq!(call(&app, "GET", "/api/profiles", &phone, None).await.0, 401);
        assert_eq!(list(&s.db()).unwrap(), vec![]);
    })
}

/// Serves `s`'s API on a free port.
async fn serve(s: &Shared) -> std::net::SocketAddr {
    let app = crate::api::router(s.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).await });
    addr
}

#[test]
fn revoking_a_device_closes_its_websockets() {
    crate::testing::run(async || {
        let s = state();
        let app = crate::api::router(s.clone());
        let addr = serve(&s).await;
        let (phone, phone_id) = pair_device(&app, "phone").await;
        let (tablet, _) = pair_device(&app, "tablet").await;

        let open = async |path: &str, token: &str| {
            let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/api{path}?token={token}")).await.unwrap();
            // Each says hello first.
            let hello = ws.next().await.unwrap().unwrap();
            assert!(hello.to_text().unwrap().contains("hello"), "{hello:?}");
            ws
        };
        let refused = tokio_tungstenite::connect_async(format!("ws://{addr}/api/ws?token=nope")).await;
        assert!(refused.is_err());

        // The board's events (the hub's), this host's own, and the tablet's, which stays open.
        let mut ui = open("/ws", &phone).await;
        let mut host = open("/host/ws", &phone).await;
        let mut other = open("/ws", &tablet).await;
        assert_eq!(call(&app, "DELETE", &format!("/api/devices/{phone_id}"), BOARD, None).await.0, 200);
        for ws in [&mut ui, &mut host] {
            let end = tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    match ws.next().await {
                        None | Some(Err(_)) | Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) => break,
                        Some(Ok(_)) => {}
                    }
                }
            });
            end.await.expect("the revoked device's websocket stays open");
        }
        // Nor can it open another.
        assert!(tokio_tungstenite::connect_async(format!("ws://{addr}/api/ws?token={phone}")).await.is_err());
        // The other device's is still there.
        s.hub_events.send(json!({"type": "ping-test"})).unwrap();
        let next = tokio::time::timeout(Duration::from_secs(5), other.next()).await.unwrap().unwrap().unwrap();
        assert!(next.to_text().unwrap().contains("ping-test"));
        let _ = other.send(tokio_tungstenite::tungstenite::Message::Close(None)).await;
    })
}

#[test]
fn the_inbox_lists_one_profiles_prompts() {
    crate::testing::run(async || {
        let s = state();
        let app = crate::api::router(s.clone());
        let (phone, _) = pair_device(&app, "phone").await;
        let work = crate::db::insert_profile(&s.db(), "work", &[], None).unwrap();
        let home = crate::db::insert_profile(&s.db(), "home", &[], None).unwrap();
        let mut ids = vec![];
        for p in [&work, &home] {
            let t = crate::db::NewTask {
                profile_id: &p.id,
                project_id: None,
                kind: "task",
                title: "t",
                description: "",
                status: "in_progress",
                use_worktree: false,
                model: None,
                effort: None,
                claude_config_id: None,
            };
            let t = crate::db::insert_task(&s.db(), t).unwrap();
            s.db()
                .execute(
                    "INSERT INTO permission_requests (id, task_id, message_id, tool_name, input, status, created_at) VALUES (?1, ?2, 0, 'Bash', '{}', 'pending', ?3)",
                    params![format!("perm-{}", p.name), t.id, now()],
                )
                .unwrap();
            ids.push(t.id);
        }
        let ids_of = |v: &Value| v.as_array().unwrap().iter().map(|p| p["id"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        let (_, all) = call(&app, "GET", "/api/h/h/permissions", &phone, None).await;
        assert_eq!(ids_of(&all), ["perm-work", "perm-home"]);
        let (_, mine) = call(&app, "GET", &format!("/api/h/h/permissions?profile_id={}", work.id), &phone, None).await;
        assert_eq!(ids_of(&mine), ["perm-work"]);
        let (_, theirs) = call(&app, "GET", &format!("/api/permissions?profile_id={}", home.id), &phone, None).await;
        assert_eq!(ids_of(&theirs), ["perm-home"]);
    })
}
