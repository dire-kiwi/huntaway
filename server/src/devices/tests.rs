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
        let mut other = open("/ws", &tablet).await;
        assert_eq!(call(&app, "DELETE", &format!("/api/devices/{phone_id}"), BOARD, None).await.0, 200);
        for ws in [&mut ui] {
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

/// A task, and a Claude login with a credentials file, for a device to try to reach.
fn task_and_login(s: &Shared, dir: &std::path::Path) -> (String, String) {
    let p = crate::db::insert_profile(&s.db(), "work", &[], None).unwrap();
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
    std::fs::write(dir.join(".credentials.json"), "SECRET-LOGIN").unwrap();
    let id = crate::util::new_id();
    s.db()
        .execute("INSERT INTO claude_configs (id, name, config_dir, created_at) VALUES (?1, 'login', ?2, ?3)", params![id, dir.to_string_lossy(), now()])
        .unwrap();
    (t.id, id)
}

#[test]
fn a_device_cant_get_the_boards_tokens_or_a_shell() {
    crate::testing::run(async || {
        let s = state();
        let app = crate::api::router(s.clone());
        let dir = crate::testing::temp_dir();
        let (task, login) = task_and_login(&s, &dir);
        let (phone, phone_id) = pair_device(&app, "phone").await;
        // The board's own token still gets them.
        let (status, join) = call(&app, "GET", "/api/hosts/join", BOARD, None).await;
        assert_eq!((status, &join["host_token"]), (200, &json!(BOARD)));
        let (status, archive) = call(&app, "GET", &format!("/api/h/h/claude-configs/{login}/archive"), BOARD, None).await;
        assert_eq!(status, 200, "{archive}");
        assert_eq!(call(&app, "GET", &format!("/api/h/h/tasks/{task}/terminal"), BOARD, None).await.0, 200);

        let get = |p: &str| ("GET", p.replace("{task}", &task).replace("{login}", &login));
        for (method, path) in [
            get("/api/hosts/join"),
            get("/api/h/h/hosts/join"),
            get("/api/tasks/{task}/terminal"),
            get("/api/tasks/{task}/terminal/ws?cols=80"),
            get("/api/h/h/tasks/{task}/terminal/ws"),
            get("/api/claude-configs/{login}/archive"),
            get("/api/h/other-host/claude-configs/{login}/archive"),
            get("/api/profiles/p1/claude-config"),
            // Encoded, through the hub's proxy, which forwards the decoded path with the board's token.
            get("/api/h/h/tasks/{task}%2Fterminal"),
            get("/api/h/h/tasks/{task}%2fterminal"),
            get("/api/h/h/tasks/{task}/%74erminal"),
            get("/api/h/h/tasks/{task}%2Fterminal%2Fws"),
            get("/api/h/h/claude-configs/{login}%2Farchive"),
            get("/api/h/h/%63laude-configs/{login}/archive"),
            get("/api/h/h/claude-configs/{login}/%2561rchive"),
            get("/api/h/h/hosts%2Fjoin"),
            // Empty and dot segments.
            get("/api/h/h/tasks//terminal"),
            get("/api/h/h/tasks/{task}/./terminal"),
            get("/api/h/h/profiles/../tasks/{task}/terminal"),
            get("/api/h/h/tasks/{task}/"),
            // An encoded '?' or '#', which the forwarded URL would cut the path at.
            get("/api/h/h/tasks/{task}%3F/messages"),
            get("/api/h/h/tasks/{task}%23/messages"),
            // Moving a Claude login to another host, linking one, and the rest of what the app doesn't use.
            ("POST", "/api/hosts/copy-claude-config".into()),
            ("POST", "/api/h/h/hosts/copy-claude-config".into()),
            ("POST", "/api/hosts".into()),
            ("POST", "/api/hosts/ssh".into()),
            get("/api/settings"),
            get("/api/h/h/settings"),
            ("POST", "/api/h/h/admin/restart".into()),
            get("/api/host/ws"),
            ("DELETE", "/api/h/h/tasks/{task}".replace("{task}", &task)),
        ] {
            let body = json!({"from_host": "h", "to_host": "other", "config": "login", "url": "http://127.0.0.1:1", "token": "x"});
            let (status, out) = call(&app, method, &path, &phone, (method == "POST").then_some(body)).await;
            assert_eq!(status, 403, "{method} {path}: {out}");
            assert!(!out.to_string().contains(BOARD) && !out.to_string().contains("archive\":"), "{path}");
        }
        // As ?token= too.
        assert_eq!(call(&app, "GET", &format!("/api/hosts/join?token={phone}"), "", None).await.0, 403);
        // What the app uses works.
        for path in ["/api/hosts", "/api/devices", "/api/profiles", "/api/h/h/profiles", "/api/h/h/permissions", "/api/h/h/tasks/{task}", "/api/h/h/tasks/{task}/messages"] {
            let path = path.replace("{task}", &task);
            assert_eq!(call(&app, "GET", &path, &phone, None).await.0, 200, "{path}");
        }
        // Revoked, it has nothing left that works.
        assert_eq!(call(&app, "DELETE", &format!("/api/devices/{phone_id}"), BOARD, None).await.0, 200);
        assert_eq!(call(&app, "GET", "/api/hosts/join", &phone, None).await.0, 401);
        assert_eq!(call(&app, "POST", "/api/devices/pairing", &phone, Some(json!({}))).await.0, 401);
    })
}

/// The app's Assistant tab (API 104): a device reaches the profile's assistant on the board, through the hub's proxy to
/// the host it's on (`?local=1`, as the app asks for it), and its thread; not the assistant's memory.
#[test]
fn a_device_reaches_the_profiles_assistant() {
    crate::testing::run(async || {
        let s = state();
        let app = crate::api::router(s.clone());
        let p = crate::db::insert_profile(&s.db(), "work", &[], None).unwrap();
        let (phone, _) = pair_device(&app, "phone").await;
        let (status, a) = call(&app, "GET", &format!("/api/profiles/{}/assistant", p.id), &phone, None).await;
        assert_eq!((status, &a["task_type"], &a["host_id"]), (200, &json!("assistant"), &json!("h")), "{a}");
        let (status, again) = call(&app, "GET", &format!("/api/h/h/profiles/{}/assistant?local=1", p.id), &phone, None).await;
        assert_eq!((status, &again["id"]), (200, &a["id"]), "{again}");
        let id = a["id"].as_str().unwrap();
        assert_eq!(call(&app, "GET", &format!("/api/h/h/tasks/{id}/messages"), &phone, None).await.0, 200);
        assert_eq!(refused("POST", &format!("/api/h/h/profiles/{}/assistant", p.id)), None);
        for path in ["memory", "memory/file?path=USER.md", "memory/history", "memory/diff"] {
            let path = format!("/api/h/h/profiles/{}/assistant/{path}", p.id);
            assert_eq!(call(&app, "GET", &path, &phone, None).await.0, 403, "{path}");
        }
        for path in ["memory/file", "memory/restore", "memory/import"] {
            let path = format!("/api/profiles/{}/assistant/{path}", p.id);
            assert_eq!(call(&app, "POST", &path, &phone, Some(json!({}))).await.0, 403, "{path}");
        }
    })
}

/// The second check: the handlers of what a device must never reach refuse a request that carries one, as a request
/// through the hub's proxy to this host does, whatever the path check let through.
#[test]
fn credential_handlers_refuse_a_device_themselves() {
    crate::testing::run(async || {
        let s = state();
        let app = crate::api::router(s.clone());
        let dir = crate::testing::temp_dir();
        let (task, login) = task_and_login(&s, &dir);
        for (method, path) in [
            ("GET", "/api/hosts/join".to_string()),
            ("POST", "/api/hosts".into()),
            ("POST", "/api/hosts/ssh".into()),
            ("POST", "/api/hosts/copy-claude-config".into()),
            ("GET", format!("/api/claude-configs/{login}/archive")),
            ("POST", format!("/api/claude-configs/{login}/archive")),
            ("GET", "/api/profiles/p1/claude-config".into()),
            ("POST", "/api/profiles/p1/claude-config".into()),
            ("GET", format!("/api/tasks/{task}/terminal")),
            ("DELETE", format!("/api/tasks/{task}/terminal")),
            ("POST", format!("/api/tasks/{task}/terminal/keepalive?tool=x")),
        ] {
            let body = json!({"from_host": "h", "to_host": "other", "config": "login", "url": "http://127.0.0.1:1", "token": "x", "target": "x", "archive": ""});
            let req = Request::builder().method(method).uri(&path).header("authorization", format!("Bearer {BOARD}"));
            let mut req = req.header("content-type", "application/json").body(axum::body::Body::from(body.to_string())).unwrap();
            req.extensions_mut().insert(DeviceAuth { id: "d".into(), revoked: s.devices.revoked.subscribe() });
            let res = app.clone().oneshot(req).await.unwrap();
            assert_eq!(res.status().as_u16(), 403, "{method} {path}");
        }
    })
}

#[test]
fn what_a_device_may_do() {
    for (m, p) in [
        ("GET", "/api/ws"),
        ("GET", "/api/hosts"),
        ("DELETE", "/api/devices/d1"),
        ("GET", "/api/h/x/profiles"),
        ("GET", "/api/profiles/p/tasks"),
        ("POST", "/api/h/x/projects/p/tasks"),
        ("PATCH", "/api/h/x/tasks/a"),
        ("GET", "/api/h/x/tasks/a/messages"),
        ("POST", "/api/h/x/tasks/a/questions/7"),
        ("POST", "/api/h/x/permissions/p"),
        ("GET", "/api/h/x/attachments/a/photo%20one.jpg"),
        ("GET", "/api/h/my%20host/profiles"),
        ("GET", "/api/profiles/p/assistant"),
        ("POST", "/api/h/x/profiles/p/assistant"),
        ("GET", "/api/push"),
        ("POST", "/api/push/subscriptions"),
        ("PATCH", "/api/push/subscriptions/s1"),
        ("DELETE", "/api/push/subscriptions/s1"),
        ("POST", "/api/push/subscriptions/s1/test"),
        ("POST", "/api/permissions/p/push-answer"),
    ] {
        assert_eq!(refused(m, p), None, "{m} {p}");
    }
    for (m, p) in [
        ("GET", "/api/hosts/join"),
        ("GET", "/api/h/x/hosts/join"),
        ("GET", "/api/h/x/ws"),
        ("GET", "/api/h/x/push"),
        ("POST", "/api/h/x/push/subscriptions"),
        ("GET", "/api/push/subscriptions"),
        ("GET", "/api/h/x/devices"),
        ("DELETE", "/api/h/x/devices/d1"),
        ("PATCH", "/api/devices/d1"),
        ("POST", "/api/devices/pairing"),
        ("POST", "/api/hosts/copy-claude-config"),
        ("DELETE", "/api/tasks/a"),
        ("GET", "/api/tasks/a/terminal"),
        ("GET", "/api/h/x/tasks/a%2Fterminal"),
        ("GET", "/api/h/x/tasks/a/%74erminal"),
        ("GET", "/api/h/x/tasks/a%252Fmessages"),
        ("GET", "/api/h/x/tasks/a%5Cmessages"),
        ("GET", "/api/h/x/tasks//messages"),
        ("GET", "/api/h/x/tasks/./messages"),
        ("GET", "/api/h/x/tasks/../tasks/a"),
        ("GET", "/api/h/x/h/y/profiles"),
        ("GET", "/api/h/x/attachments/a/%FF"),
        // A '?' or '#' that the proxy's forwarded URL would cut the path at.
        ("GET", "/api/h/x/tasks/a%3F/messages"),
        ("GET", "/api/h/x/tasks/a%3f/messages"),
        ("GET", "/api/h/x/tasks/a%23/messages"),
        ("POST", "/api/h/x/permissions/p%3Fx"),
        ("GET", "/api/profiles/"),
        ("GET", "/api/h/x/profiles/p/assistant/memory"),
        ("POST", "/api/profiles/p/assistant/memory/import"),
        ("GET", "/api"),
        ("GET", "/profiles"),
    ] {
        assert!(refused(m, p).is_some(), "{m} {p}");
    }
    // The proxy's own check, on the path it forwards.
    assert_eq!(refused_on_host("GET", "tasks/a/messages"), None);
    assert!(refused_on_host("GET", "tasks/a/terminal").is_some());
    assert!(refused_on_host("GET", "hosts/join").is_some());
    assert!(refused_on_host("GET", "tasks/a?/messages").is_some());
    assert!(refused_on_host("GET", "tasks/a#/messages").is_some());
}
