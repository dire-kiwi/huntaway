use super::*;
use crate::state::Identity;
use crate::testing;
use serde_json::Value;

#[cfg(target_os = "linux")]
#[test]
fn connector_lives_across_broker_disconnects_and_is_stopped_when_its_owner_goes() {
    testing::run(async || {
        use std::os::unix::fs::PermissionsExt;
        let dir = testing::temp_dir();
        let bin = dir.join("cloudflared");
        // The fake connector records the credential from its environment and blocks like cloudflared.
        std::fs::write(&bin, "#!/bin/sh\nd=$(dirname \"$0\")\nprintf '%s' \"$TUNNEL_TOKEN\" > \"$d/token\"\nprintf '%s' \"$$\" > \"$d/pid\"\nexec sleep 600\n").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).unwrap();
        let tunnel = proto::Tunnel { url: "https://desktop.example.com".into(), token: "connector-secret".into() };
        let welcome = Ctl::Welcome { name: "desktop".into(), tunnel: Some(tunnel.clone()) };
        let app = axum::Router::new().route("/_broker/connect", axum::routing::get(move |ws: axum::extract::WebSocketUpgrade| {
            let welcome = welcome.clone();
            async move { ws.on_upgrade(move |mut ws| async move {
                let _ = ws.recv().await;
                ws.send(axum::extract::ws::Message::Text(serde_json::to_string(&welcome).unwrap().into())).await.unwrap();
                ws.close().await.unwrap();
            }) }
        }));
        let (broker, _) = http_server(app).await;
        let (tx, rx) = watch::channel(None);
        let connector = tokio::spawn(connect_tunnel(rx, bin.into_os_string()));
        let s = testing::state();
        let _ = session(&s, &broker, "broker-token", "desktop", "host-key", Some(12345), &tx).await;
        assert_eq!(*tx.borrow(), Some(tunnel));
        for _ in 0..100 {
            if dir.join("pid").is_file() { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let pid: u32 = std::fs::read_to_string(dir.join("pid")).unwrap().parse().unwrap();
        let process = std::path::PathBuf::from(format!("/proc/{pid}"));
        assert!(process.exists(), "broker disconnected and the connector died");
        assert_eq!(std::fs::read_to_string(dir.join("token")).unwrap(), "connector-secret");
        assert!(!String::from_utf8_lossy(&std::fs::read(process.join("cmdline")).unwrap()).contains("connector-secret"));
        drop(tx);
        connector.await.unwrap();
        assert!(!process.exists(), "connector wasn't reaped");
    });
}

#[test]
fn managed_registration_channels_refuse_application_requests() {
    testing::run(async || {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = calls.clone();
        let (internal, _) = http_server(axum::Router::new().route("/test", axum::routing::get(move || {
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async { "shouldn't be called" }
        }))).await;
        let s = testing::state_as(Identity { internal_url: internal, host_id: "desktop".into(), host_name: "desktop".into(),
            token: "host-token".into(), hub_token: String::new() });
        let app = axum::Router::new().route("/_broker/connect", axum::routing::get(|ws: axum::extract::WebSocketUpgrade| async {
            ws.on_upgrade(|mut ws| async move {
                let _ = ws.recv().await;
                for msg in [Ctl::Welcome { name: "desktop".into(), tunnel: Some(proto::Tunnel {
                    url: "https://desktop.example.com".into(), token: "connector-token".into() }) },
                    Ctl::Req { id: 1, method: "GET".into(), path: "/test".into(), headers: vec![], body: false, ws: false }] {
                    ws.send(axum::extract::ws::Message::Text(serde_json::to_string(&msg).unwrap().into())).await.unwrap();
                }
                let _ = ws.recv().await;
            })
        }));
        let (broker, _) = http_server(app).await;
        let (tx, _rx) = watch::channel(None);
        let error = session(&s, &broker, "broker-token", "desktop", "host-key", Some(12345), &tx).await.unwrap_err();
        assert!(error.to_string().contains("tried to relay application traffic"));
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
    });
}

#[cfg(unix)]
#[test]
fn connector_watchdog_stops_the_group_when_the_servers_pipe_closes() {
    testing::run(async || {
        use std::os::unix::{fs::PermissionsExt, process::ExitStatusExt};
        let dir = testing::temp_dir();
        // Spaces and shell metacharacters must be a literal executable name.
        let bin = dir.join("fake connector $literal");
        std::fs::write(&bin, "#!/bin/sh\nprintf ready > \"$(dirname \"$0\")/ready\"\nexec sleep 600\n").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).unwrap();
        let (mut child, alive) = spawn_connector(bin.as_os_str(), "connector-token").unwrap();
        for _ in 0..100 {
            if dir.join("ready").is_file() { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(dir.join("ready").is_file(), "literal connector path wasn't executed");
        // Models the kernel closing the server's descriptors on exec or forced exit.
        drop(alive);
        let status = tokio::time::timeout(Duration::from_secs(3), child.wait()).await.expect("orphaned connector").unwrap();
        assert_eq!(status.signal(), Some(libc::SIGKILL));
    });
}

async fn http_server(app: axum::Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, task)
}

#[test]
fn private_tunnel_origin_never_exposes_open_token() {
    testing::run(async || {
        let app = axum::Router::new().route("/api/open-token", axum::routing::get(crate::open_token("secret".into())));
        let port = origin(app).await.unwrap();
        let client = reqwest::Client::new();
        for path in ["/api/open-token", "/api/%6fpen-token", "/api/open-token?token=x"] {
            let response = client.get(format!("http://127.0.0.1:{port}{path}")).send().await.unwrap();
            assert!(!response.status().is_success(), "{path}");
            assert!(!response.text().await.unwrap().contains("secret"));
        }
    });
}

#[test]
fn discovery_checks_identity_and_rejects_unsafe_or_redirected_endpoints() {
    testing::run(async || {
        let app = axum::Router::new().route("/_broker/resolve/{name}", axum::routing::get(
            |axum::extract::Path(name): axum::extract::Path<String>, headers: axum::http::HeaderMap| async move {
                assert!(!headers.contains_key("authorization"));
                if name == "legacy" { return axum::http::StatusCode::NOT_FOUND.into_response(); }
                if name == "redirect" { return axum::response::Redirect::temporary("https://evil.example.com").into_response(); }
                let url = match name.as_str() {
                    "plain" => "http://public.example.com",
                    "credentials" => "https://user:secret@public.example.com",
                    "query" => "https://public.example.com/?token=secret",
                    "path" => "https://public.example.com/other",
                    "missing" => "",
                    _ => "https://desktop.example.com",
                };
                axum::Json(json!({"host_id": "desktop", "url": url})).into_response()
            }));
        let (broker, _) = http_server(app).await;
        let address = |name| format!("{broker}/_broker/h/{name}");
        assert_eq!(resolve(&address("desktop"), Some("desktop")).await.unwrap(), "https://desktop.example.com");
        assert_eq!(resolve(&address("legacy"), Some("desktop")).await.unwrap(), address("legacy"));
        assert!(resolve(&address("desktop"), Some("different-host")).await.unwrap_err().to_string().contains("different host"));
        for name in ["plain", "credentials", "query", "path", "missing", "redirect"] {
            assert!(resolve(&address(name), None).await.is_err(), "{name}");
        }
        let (direct, _) = http_server(axum::Router::new().fallback(|| async { "<html>host UI</html>" })).await;
        assert_eq!(resolve(&direct, None).await.unwrap(), direct);
    });
}

#[test]
fn hub_links_resolve_before_authenticating_and_survive_a_broker_outage() {
    testing::run(async || {
        let remote = testing::state_as(Identity { host_id: "remote".into(), host_name: "remote".into(), token: "remote-tok".into(),
            hub_token: "remote-hub".into(), internal_url: String::new() });
        let (endpoint, _) = http_server(crate::api::router(remote.clone())).await;
        let hub = testing::state_as(Identity { host_id: "hub".into(), host_name: "hub".into(), token: "hub-tok".into(),
            hub_token: "hub-join".into(), internal_url: String::new() });
        let (hub_url, _) = http_server(crate::api::router(hub.clone())).await;
        let direct_hub = hub_url.clone();
        let default_hub = hub_url.clone();
        let app = axum::Router::new().route("/_broker/resolve", axum::routing::get(move || {
            let url = default_hub.clone();
            async move { ([("x-huntaway-broker", "1")], axum::Json(json!({"host_id": "hub", "url": url}))) }
        })).route("/_broker/resolve/{name}", axum::routing::get(
            move |axum::extract::Path(name): axum::extract::Path<String>, headers: axum::http::HeaderMap| {
                let endpoint = if name == "hub" { direct_hub.clone() } else { endpoint.clone() };
                async move {
                    assert!(!headers.contains_key("authorization"), "discovery received a host token");
                    axum::Json(json!({"host_id": name, "url": endpoint}))
                }
            }));
        let (broker, broker_task) = http_server(app).await;
        let client = reqwest::Client::new();
        let res = client.post(format!("{hub_url}/api/hosts")).bearer_auth("hub-tok")
            .json(&json!({"url": format!("{broker}/_broker/h/remote"), "token": "remote-tok"})).send().await.unwrap();
        assert_eq!(res.status(), 200, "{}", res.text().await.unwrap());
        // The saved URL remains the broker URL, so a future reconnect resolves the current endpoint.
        assert!(crate::db::list_links(&hub.db()).unwrap()[0].url.as_ref().unwrap().starts_with(&broker));
        let caller = testing::state_as(Identity { host_id: "caller".into(), host_name: "caller".into(), token: "caller-tok".into(),
            hub_token: String::new(), internal_url: String::new() });
        let _ = crate::api::router(caller.clone());
        crate::hosts::hub::dial_out(&caller, broker.clone(), "hub-join".into());
        for _ in 0..100 {
            if crate::hosts::hub::find_link(&hub, "remote").is_some() && crate::hosts::hub::find_link(&hub, "caller").is_some() { break; }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let link = crate::hosts::hub::find_link(&hub, "remote").expect("outbound link never connected");
        let inbound = crate::hosts::hub::find_link(&hub, "caller").expect("dial-in link never connected");
        let (_tx, mut events) = link.open_ws("/api/host/ws").await.unwrap();
        assert!(events.recv().await.is_some());
        broker_task.abort();
        let _ = broker_task.await;
        assert_eq!(link.request("GET", "/api/info", None).await.unwrap().1["host_id"], "remote");
        assert_eq!(inbound.request("GET", "/api/info", None).await.unwrap().1["host_id"], "caller");
        remote.events.send(json!({"type": "after_broker_stopped"})).unwrap();
        let event = events.recv().await.unwrap();
        assert!(matches!(event, crate::hosts::relay::Frame::Text(t) if t.contains("after_broker_stopped")));
    });
}

use axum::response::IntoResponse;

const BROKER_TOKEN: &str = "broker-token-0123456789";

/// The websockets the host is relaying to its own server, by path, so a test can see one end.
static LIVE_WS: Mutex<Vec<String>> = Mutex::new(Vec::new());

pub(super) struct LiveWs(String);

impl LiveWs {
    pub(super) fn new(path: &str) -> Self {
        LIVE_WS.lock().unwrap().push(path.into());
        LiveWs(path.into())
    }
}

impl Drop for LiveWs {
    fn drop(&mut self) {
        let mut live = LIVE_WS.lock().unwrap();
        if let Some(i) = live.iter().position(|p| *p == self.0) {
            live.remove(i);
        }
    }
}

fn live_ws(path: &str) -> usize {
    LIVE_WS.lock().unwrap().iter().filter(|p| *p == path).count()
}

/// A route for a websocket that never reads what it's sent.
fn ws_sink(router: axum::Router, path: &str) -> axum::Router {
    router.route(
        path,
        axum::routing::get(|ws: axum::extract::WebSocketUpgrade| async move {
            ws.on_upgrade(|socket| async move {
                let _keep = socket;
                std::future::pending::<()>().await
            })
        }),
    )
}

/// Sends window-sized messages through the broker to `path` until they stop going.
async fn flood_ws(b: &str, path: &str) -> tokio::task::JoinHandle<()> {
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("{}{path}", b.replacen("http", "ws", 1))).await.unwrap();
    tokio::spawn(async move {
        loop {
            if ws.send(TMessage::Binary(vec![0u8; proto::WINDOW].into())).await.is_err() {
                return;
            }
        }
    })
}

async fn until(what: &str, limit: Duration, mut done: impl FnMut() -> bool) {
    let started = std::time::Instant::now();
    while !done() {
        assert!(started.elapsed() < limit, "{what} after {limit:?}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[test]
fn a_websocket_stuck_writing_to_its_client_lets_go_of_its_stream() {
    testing::run(async || {
        use axum::extract::ws::{Message as AMessage, WebSocketUpgrade};
        let b = broker_with(huntaway_broker::Config { max_streams: 2, stall: Duration::from_millis(500), ..Default::default() }).await;
        // Sends messages a whole window in size, so the broker has none waiting while it writes one.
        let routes = axum::Router::new().route(
            "/test/ws-window",
            axum::routing::get(|ws: WebSocketUpgrade| async move {
                ws.on_upgrade(|mut socket| async move {
                    while socket.send(AMessage::Binary(vec![0u8; proto::WINDOW].into())).await.is_ok() {}
                })
            }),
        );
        host_with("desktop", &b, routes).await;
        // As many clients as the host may have streams, none of them reading.
        let mut clients = vec![];
        for _ in 0..2 {
            let sock = tokio::net::TcpSocket::new_v4().unwrap();
            sock.set_recv_buffer_size(4096).unwrap();
            let tcp = sock.connect(b.trim_start_matches("http://").parse().unwrap()).await.unwrap();
            let (ws, _) = tokio_tungstenite::client_async(format!("{}/test/ws-window", b.replacen("http", "ws", 1)), tcp).await.unwrap();
            clients.push(ws);
        }
        tokio::time::sleep(Duration::from_millis(2000)).await;
        assert_eq!(call("GET", &format!("{b}/api/info?token=desktop-tok"), &[]).await.0, 200);
        drop(clients);
    })
}

#[test]
fn a_websocket_stuck_on_our_server_is_cut_off_when_the_broker_closes_it() {
    testing::run(async || {
        let stall = Duration::from_secs(1);
        let b = broker_with(huntaway_broker::Config { stall, ..Default::default() }).await;
        host_with("desktop", &b, ws_sink(axum::Router::new(), "/test/ws-stuck")).await;
        let client = flood_ws(&b, "/test/ws-stuck").await;
        // Writing to our server, which reads nothing, gets stuck.
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert_eq!(live_ws("/test/ws-stuck"), 1);
        // The client goes. Its data waiting for the host makes no progress, so the broker closes the
        // stream, and the host lets go once it's had its grace.
        client.abort();
        until("the host still relays the websocket", stall * 2 + CLOSE_GRACE + Duration::from_secs(2), || live_ws("/test/ws-stuck") == 0).await;
    })
}

#[test]
fn a_websocket_stuck_on_our_server_is_cut_off_when_the_broker_goes() {
    testing::run(async || {
        let b = broker().await;
        let s = host_with("desktop", &b, ws_sink(axum::Router::new(), "/test/ws-stuck-2")).await;
        let client = flood_ws(&b, "/test/ws-stuck-2").await;
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert_eq!(live_ws("/test/ws-stuck-2"), 1);
        // Connecting again under the same name makes the broker hang up on the first connection.
        dial_out(&s, b.clone(), BROKER_TOKEN.into(), "desktop".into(), "desktop-key".into());
        until("the host still relays the websocket", Duration::from_secs(1), || live_ws("/test/ws-stuck-2") == 0).await;
        client.abort();
    })
}

async fn broker() -> String {
    broker_with(huntaway_broker::Config::default()).await
}

async fn broker_with(cfg: huntaway_broker::Config) -> String {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", l.local_addr().unwrap());
    let app = huntaway_broker::router(huntaway_broker::Config { token: BROKER_TOKEN.into(), ..cfg }).unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    url
}

/// A host (`id`, token `<id>-tok`) served on a free port and dialled out to `broker` as `id`.
async fn host(id: &str, broker: &str) -> Shared {
    host_with(id, broker, axum::Router::new()).await
}

/// `host`, also serving `extra`. Every test host serves `/api/open-token` as `--open-token` does,
/// which no client of the broker may reach.
async fn host_with(id: &str, broker: &str, extra: axum::Router) -> Shared {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let internal_url = format!("http://{}", l.local_addr().unwrap());
    let s = testing::state_as(Identity { host_id: id.into(), host_name: id.into(), token: format!("{id}-tok"), hub_token: format!("{id}-hub"), internal_url });
    let app = crate::api::router(s.clone()).route("/api/open-token", axum::routing::get(crate::open_token(s.token.clone()))).merge(extra);
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    dial_out(&s, broker.into(), BROKER_TOKEN.into(), id.into(), format!("{id}-key"));
    // Connected once the broker passes a request to it.
    for _ in 0..100 {
        if call("GET", &format!("{broker}/_broker/h/{id}/api/health"), &[]).await.0 == 200 {
            return s;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("host {id} didn't connect to the broker");
}

/// A request with these headers (`body` is a JSON body).
async fn call(method: &str, url: &str, headers: &[(&str, &str)]) -> (u16, Value) {
    let mut req = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap().request(method.parse().unwrap(), url);
    for (k, v) in headers {
        req = if *k == "body" { req.header("content-type", "application/json").body(v.to_string()) } else { req.header(*k, *v) };
    }
    let res = req.send().await.unwrap();
    let status = res.status().as_u16();
    let text = res.text().await.unwrap();
    (status, serde_json::from_str(&text).unwrap_or(Value::String(text)))
}

#[test]
fn relays_requests_to_a_host() {
    testing::run(async || {
        let b = broker().await;
        host("desktop", &b).await;
        let auth = ("authorization", "Bearer desktop-tok");
        // The host's token still guards its API.
        assert_eq!(call("GET", &format!("{b}/api/info"), &[]).await, (401, json!({"error": "unauthorized"})));
        assert_eq!(call("GET", &format!("{b}/api/info"), &[("authorization", "Bearer nope")]).await.0, 401);
        let (status, info) = call("GET", &format!("{b}/api/info"), &[auth]).await;
        assert_eq!((status, &info["host_id"]), (200, &json!("desktop")));
        assert_eq!(call("GET", &format!("{b}/api/info?token=desktop-tok"), &[]).await.0, 200);
        // Request bodies get there.
        let (status, p) = call("POST", &format!("{b}/api/profiles"), &[auth, ("body", r#"{"name": "remote"}"#)]).await;
        assert_eq!((status, &p["name"]), (200, &json!("remote")), "{p}");
        let (status, err) = call("POST", &format!("{b}/api/profiles"), &[auth, ("body", r#"{"name": 5}"#)]).await;
        assert!(status == 422 && err.to_string().contains("invalid type"), "{status} {err}");
        // By path, which hubs use.
        assert_eq!(call("GET", &format!("{b}/_broker/h/desktop/api/info"), &[auth]).await.1["host_id"], "desktop");
        assert_eq!(
            call("GET", &format!("{b}/_broker/h/laptop/api/info"), &[auth]).await,
            (502, json!({"error": "host laptop isn't connected to the broker"}))
        );
        assert_eq!(call("GET", &format!("{b}/_broker/nope"), &[]).await.0, 404);
        // The path goes on as it was sent: `%2F` isn't a `/`.
        let raw = call("GET", &format!("{b}/_broker/h/desktop/api/tasks/a%2Fb"), &[auth]).await;
        assert_eq!(raw, call("GET", &format!("{b}/api/tasks/a%2Fb"), &[auth]).await);
        assert_ne!(raw, call("GET", &format!("{b}/api/tasks/a/b"), &[auth]).await);
        // The root of a host, as hubs ask for it.
        assert_eq!(call("GET", &format!("{b}/_broker/h/desktop"), &[]).await, call("GET", &format!("{b}/"), &[]).await);
        // The broker's own token, for hosts to connect.
        let mut req = format!("{}/_broker/connect", b.replacen("http", "ws", 1)).into_client_request().unwrap();
        req.headers_mut().insert("Authorization", "Bearer desktop-tok".parse().unwrap());
        match tokio_tungstenite::connect_async(req).await {
            Err(tokio_tungstenite::tungstenite::Error::Http(res)) => assert_eq!(res.status(), 401),
            other => panic!("connected with the wrong token: {:?}", other.map(|_| ())),
        }
    })
}

/// A request sent as it's written (clients like reqwest resolve dot segments before sending).
async fn raw(base: &str, path: &str) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut c = tokio::net::TcpStream::connect(base.trim_start_matches("http://")).await.unwrap();
    c.write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
    let mut out = Vec::new();
    c.read_to_end(&mut out).await.unwrap();
    String::from_utf8_lossy(&out).into_owned()
}

#[test]
fn keeps_the_open_token_from_clients_of_the_broker() {
    testing::run(async || {
        let b = broker().await;
        let s = host("desktop", &b).await;
        // The host does hand it out, to whoever reaches it directly, but not for the broker's clients.
        assert!(raw(&s.internal_url, "/api/open-token").await.contains("desktop-tok"));
        let marked = call("GET", &format!("{}/api/open-token", s.internal_url), &[(VIA_BROKER, "1")]).await;
        assert_eq!(marked, (404, json!({"error": "no such API route: GET /api/open-token"})));
        for p in ["/api/open-token", "/api/./open-token", "/api/%2e/open-token", "/api/x/../open-token", "/api/%2E%2E/api/open-token", "/api\\open-token", "/api/open-token/"] {
            for path in [p.to_string(), format!("/_broker/h/desktop{p}")] {
                let res = raw(&b, &path).await;
                assert!(!res.contains("desktop-tok"), "{path} gave the token away: {res}");
                assert!(res.starts_with("HTTP/1.1 4"), "{path}: {res}");
            }
        }
    })
}

/// A body of 128 MiB, counting the bytes it has given out in `sent`.
fn big_body(sent: Arc<std::sync::atomic::AtomicUsize>) -> impl futures::Stream<Item = std::io::Result<Vec<u8>>> + Send + 'static {
    futures::stream::iter(0..2048).map(move |_| {
        sent.fetch_add(64 << 10, std::sync::atomic::Ordering::SeqCst);
        Ok(vec![0u8; 64 << 10])
    })
}

const MIB: usize = 1 << 20;

/// Counts the big bodies the host is serving: one is dropped when its request stops.
struct Live(Arc<std::sync::atomic::AtomicUsize>);

impl Drop for Live {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Asks for `path` and never reads the response, with a small receive buffer so it stalls soon.
async fn unread(base: &str, path: &str) -> tokio::net::TcpStream {
    use tokio::io::AsyncWriteExt;
    let sock = tokio::net::TcpSocket::new_v4().unwrap();
    sock.set_recv_buffer_size(4096).unwrap();
    let mut c = sock.connect(base.trim_start_matches("http://").parse().unwrap()).await.unwrap();
    c.write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes()).await.unwrap();
    c
}

#[test]
fn clients_that_stop_reading_cant_keep_others_out() {
    testing::run(async || {
        let b = broker_with(huntaway_broker::Config { max_streams: 8, stall: Duration::from_secs(3), ..Default::default() }).await;
        let live = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let l2 = live.clone();
        let big = axum::Router::new().route(
            "/test/big",
            axum::routing::get(move || {
                let l2 = l2.clone();
                async move {
                    l2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let guard = Live(l2);
                    let body = big_body(Arc::default()).map(move |c| {
                        let _ = &guard;
                        c
                    });
                    axum::body::Body::from_stream(body)
                }
            }),
        );
        host_with("desktop", &b, big).await;
        // More downloads than the host may have in flight, none of them read.
        let mut conns = vec![];
        for _ in 0..12 {
            conns.push(unread(&b, "/test/big").await);
        }
        tokio::time::sleep(Duration::from_millis(1500)).await;
        // A request still gets through, in place of one of them, at once.
        let started = std::time::Instant::now();
        assert_eq!(call("GET", &format!("{b}/api/info?token=desktop-tok"), &[]).await.0, 200);
        assert!(started.elapsed() < Duration::from_secs(1));
        // And once they've stalled for long enough, the host stops serving every one of them.
        for _ in 0..100 {
            if live.load(std::sync::atomic::Ordering::SeqCst) == 0 {
                return drop(conns);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("the host is still serving {} downloads nobody reads", live.load(std::sync::atomic::Ordering::SeqCst));
    })
}

#[test]
fn a_websocket_that_isnt_read_holds_up_only_itself() {
    testing::run(async || {
        use axum::extract::ws::{Message as AMessage, WebSocketUpgrade};
        let b = broker().await;
        let flooded = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let f2 = flooded.clone();
        let routes = axum::Router::new()
            // Never reads what it's sent.
            .route(
                "/test/ws-sink",
                axum::routing::get(|ws: WebSocketUpgrade| async move {
                    ws.on_upgrade(|socket| async move {
                        let _keep = socket;
                        std::future::pending::<()>().await
                    })
                }),
            )
            // Sends 128 MiB as fast as it's let.
            .route(
                "/test/ws-flood",
                axum::routing::get(move |ws: WebSocketUpgrade| async move {
                    ws.on_upgrade(move |mut socket| async move {
                        for _ in 0..2048 {
                            if socket.send(AMessage::Binary(vec![0u8; 64 << 10].into())).await.is_err() {
                                return;
                            }
                            f2.fetch_add(64 << 10, std::sync::atomic::Ordering::SeqCst);
                        }
                    })
                }),
            );
        host_with("desktop", &b, routes).await;
        let ws = b.replacen("http", "ws", 1);
        // Up: the client sends 128 MiB to a websocket on the host that reads none of it.
        let (mut up, _) = tokio_tungstenite::connect_async(format!("{ws}/test/ws-sink")).await.unwrap();
        let uploaded = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let u2 = uploaded.clone();
        let sender = tokio::spawn(async move {
            for _ in 0..2048 {
                if up.send(TMessage::Binary(vec![0u8; 64 << 10].into())).await.is_err() {
                    return;
                }
                u2.fetch_add(64 << 10, std::sync::atomic::Ordering::SeqCst);
            }
        });
        // Down: the host's websocket sends 128 MiB to a client that reads none of it.
        let (down, _) = tokio_tungstenite::connect_async(format!("{ws}/test/ws-flood")).await.unwrap();
        tokio::time::sleep(Duration::from_millis(2000)).await;
        let (u, f) = (uploaded.load(std::sync::atomic::Ordering::SeqCst), flooded.load(std::sync::atomic::Ordering::SeqCst));
        assert!(u < 48 * MIB, "{} MiB of 128 went towards a websocket that reads none of it", u / MIB);
        assert!(f < 48 * MIB, "the host's websocket sent {} MiB of 128 towards a client that reads none of it", f / MIB);
        assert_eq!(call("GET", &format!("{b}/api/info?token=desktop-tok"), &[]).await.0, 200);
        sender.abort();
        drop(down);
    })
}

#[test]
fn a_client_that_doesnt_read_holds_up_only_its_own_download() {
    testing::run(async || {
        let b = broker().await;
        let sent = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let s2 = sent.clone();
        let big = axum::Router::new().route("/test/big", axum::routing::get(move || async move { axum::body::Body::from_stream(big_body(s2)) }));
        host_with("desktop", &b, big).await;
        // Asks for it, and never reads the response.
        use tokio::io::AsyncWriteExt;
        let mut c = tokio::net::TcpStream::connect(b.trim_start_matches("http://")).await.unwrap();
        c.write_all(b"GET /test/big HTTP/1.1\r\nHost: x\r\n\r\n").await.unwrap();
        tokio::time::sleep(Duration::from_millis(1500)).await;
        // What the host could send is the window plus what the sockets in between hold, not all of it.
        let n = sent.load(std::sync::atomic::Ordering::SeqCst);
        assert!(n < 48 * MIB, "the host sent {} MiB of 128 to a client that reads none of it", n / MIB);
        // Other requests still go through.
        assert_eq!(call("GET", &format!("{b}/api/info?token=desktop-tok"), &[]).await.0, 200);
        drop(c);
    })
}

#[test]
fn a_host_that_doesnt_read_holds_up_only_its_own_upload() {
    testing::run(async || {
        let b = broker().await;
        // Takes the body, and never reads it.
        let stall = axum::Router::new().route("/test/stall", axum::routing::post(|_body: axum::body::Body| std::future::pending::<&'static str>()));
        host_with("desktop", &b, stall).await;
        let sent = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let body = reqwest::Body::wrap_stream(big_body(sent.clone()));
        let upload = tokio::spawn(reqwest::Client::new().post(format!("{b}/test/stall")).body(body).send());
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let n = sent.load(std::sync::atomic::Ordering::SeqCst);
        assert!(n < 48 * MIB, "the broker took {} MiB of 128 for a host that reads none of it", n / MIB);
        assert_eq!(call("GET", &format!("{b}/api/info?token=desktop-tok"), &[]).await.0, 200);
        upload.abort();
    })
}

#[test]
fn picks_a_host_by_header_cookie_or_path() {
    testing::run(async || {
        let b = broker().await;
        host("desktop", &b).await;
        // The only host gets the requests that don't pick one.
        assert_eq!(call("GET", &format!("{b}/api/info?token=desktop-tok"), &[]).await.1["host_id"], "desktop");
        host("laptop", &b).await;
        let (status, err) = call("GET", &format!("{b}/api/info?token=desktop-tok"), &[]).await;
        assert!(status == 502 && err["error"].as_str().unwrap().contains("several hosts"), "{err}");
        assert_eq!(call("GET", &format!("{b}/api/info?token=laptop-tok"), &[("x-huntaway-host", "laptop")]).await.1["host_id"], "laptop");
        assert_eq!(call("GET", &format!("{b}/api/info?token=desktop-tok"), &[("cookie", "a=b; huntaway_host=desktop")]).await.1["host_id"], "desktop");
        assert_eq!(call("GET", &format!("{b}/_broker/h/laptop/api/info?token=laptop-tok"), &[]).await.1["host_id"], "laptop");
        // Opening /_broker/use/<name> sets the cookie, and keeps ?token= for the board.
        let res = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap().get(format!("{b}/_broker/use/laptop?token=x")).send().await.unwrap();
        assert_eq!(res.status(), 302);
        assert_eq!(res.headers()["location"], "/?token=x");
        assert!(res.headers()["set-cookie"].to_str().unwrap().starts_with("huntaway_host=laptop;"));
    })
}

#[test]
fn relays_websockets() {
    testing::run(async || {
        let b = broker().await;
        let s = host("desktop", &b).await;
        let ws = b.replacen("http", "ws", 1);
        match tokio_tungstenite::connect_async(format!("{ws}/api/host/ws")).await {
            Err(tokio_tungstenite::tungstenite::Error::Http(res)) => assert_eq!(res.status(), 401),
            other => panic!("opened the events without the token: {:?}", other.map(|_| ())),
        }
        let (mut events, _) = tokio_tungstenite::connect_async(format!("{ws}/api/host/ws?token=desktop-tok")).await.unwrap();
        let mut next = async || loop {
            match events.next().await.unwrap().unwrap() {
                TMessage::Text(t) => return serde_json::from_str::<Value>(&t).unwrap(),
                _ => continue,
            }
        };
        assert_eq!(next().await, json!({"type": "hello"}));
        s.events.send(json!({"type": "test", "n": 1})).unwrap();
        assert_eq!(next().await, json!({"type": "test", "n": 1}));
    })
}

#[test]
fn links_a_host_to_a_hub_through_the_broker() {
    testing::run(async || {
        let b = broker().await;
        // The hub is behind the broker, and the host dials in to it there (`--hub <broker>/_broker/h/<hub>`).
        let hub = host("desktop", &b).await;
        let laptop = testing::state_as(Identity { host_id: "laptop".into(), host_name: "laptop".into(), token: "laptop-tok".into(), hub_token: String::new(), internal_url: String::new() });
        let _ = crate::api::router(laptop.clone());
        crate::hosts::hub::dial_out(&laptop, format!("{b}/_broker/h/desktop"), "desktop-hub".into());
        for _ in 0..100 {
            if let Some(link) = crate::hosts::hub::find_link(&hub, "laptop") {
                let (status, info) = link.request("GET", "/api/info", None).await.unwrap();
                assert_eq!((status, &info["host_id"]), (200, &json!("laptop")));
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("the host didn't link to the hub");
    })
}

#[test]
fn blocks_the_open_token_however_its_written() {
    let base = "http://127.0.0.1:7878";
    for p in [
        "/api/open-token",
        "/api/open-token?x=1",
        "/api/open-token/",
        "/api/./open-token",
        "/api/%2e/open-token",
        "/api/%2E%2E/api/open-token",
        "/api/x/../open-token",
        "/api/x/%2e%2e/open-token",
        "/api\\open-token",
        "//api//open-token",
        "/api/%6Fpen-token",
        "/api/%252e/open-token",
        "/x/../../api/open-token",
        "/API/Open-Token",
    ] {
        assert_eq!(local_url(base, p), None, "{p}");
    }
    // Not on our server.
    for p in ["@example.com/", "", "?x=1", "x"] {
        assert_eq!(local_url(base, p), None, "{p:?}");
    }
    assert_eq!(local_url(base, "/api/info?a=1").unwrap().as_str(), "http://127.0.0.1:7878/api/info?a=1");
    assert_eq!(local_url(base, "/").unwrap().as_str(), "http://127.0.0.1:7878/");
    // Escapes go on as they were.
    assert_eq!(local_url(base, "/api/tasks/a%2Fb").unwrap().as_str(), "http://127.0.0.1:7878/api/tasks/a%2Fb");
    assert_eq!(local_url(base, "//example.com/x").unwrap().host_str(), Some("127.0.0.1"));
}
