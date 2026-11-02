use super::*;
use crate::api::tests::call;

#[test]
fn older_hosts_unknown_routes_are_json_404s_through_the_proxy() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        // Hosts from before the JSON 404. Without a UI, an unknown route gets an empty 404 (as over a tunnel too);
        // with one, `serve` handed it to the UI: index.html for a GET, and an empty 405 for other methods.
        let old = || {
            Router::new()
                .route("/api/profiles", axum::routing::get(|| async { Json(json!([])) }))
                .route("/api/permissions/{id}", axum::routing::post(|| async { Json(json!({})) }))
        };
        link_http(&s, "old", old(), 0).await;
        let ui = crate::testing::temp_dir();
        std::fs::write(ui.join("index.html"), "<!doctype html>").unwrap();
        let files = tower_http::services::ServeDir::new(&ui).fallback(tower_http::services::ServeFile::new(ui.join("index.html")));
        link_http(&s, "old-ui", old().fallback_service(files), 0).await;

        let app = crate::api::router(s.clone());
        for host in ["old", "old-ui"] {
            assert_eq!(call(&app, "GET", &format!("/api/h/{host}/profiles")).await, (200, json!([])), "{host}");
            let missing = json!({"error": "no such API route: GET /api/claude-configs"});
            assert_eq!(call(&app, "GET", &format!("/api/h/{host}/claude-configs?x=1")).await, (404, missing), "{host}");
            let missing = json!({"error": "no such API route: POST /api/claude-configs"});
            assert_eq!(call(&app, "POST", &format!("/api/h/{host}/claude-configs?x=1")).await, (404, missing), "{host}");
            // A known route without this method stays a 405.
            let missing = json!({"error": "no such API route: DELETE /api/profiles"});
            assert_eq!(call(&app, "DELETE", &format!("/api/h/{host}/profiles")).await, (405, missing), "{host}");
            for method in ["GET", "DELETE"] {
                let missing = json!({"error": format!("no such API route: {method} /api/permissions/p1")});
                assert_eq!(call(&app, method, &format!("/api/h/{host}/permissions/p1")).await, (405, missing), "{method} on {host}");
            }
        }

        // The hub's own calls to a host say it needs an update, for older hosts and this one alike.
        for host in ["old", "old-ui", "h"] {
            for method in ["GET", "POST"] {
                let e = host_request(&s, host, method, "/api/nope", None).await.unwrap_err();
                assert_eq!(e.1, "this host's version doesn't support that yet; update it", "{method} on {host}");
            }
        }
        // Other 404s keep their message.
        let e = host_request(&s, "h", "GET", "/api/tasks/missing", None).await.unwrap_err();
        assert_eq!(e.0, StatusCode::NOT_FOUND);
        assert!(!e.1.contains("update it"), "{}", e.1);
        std::fs::remove_dir_all(&ui).ok();
    })
}

#[test]
fn update_sends_the_hubs_commit_and_version() {
    crate::testing::run(async || {
        let sent = Arc::new(Mutex::new(vec![]));
        let host = |sent: Arc<Mutex<Vec<Value>>>| {
            let update = move |Json(b): Json<Value>| async move {
                sent.lock().unwrap().push(b);
                Json(json!({"ok": true}))
            };
            Router::new().route("/api/admin/update", axum::routing::post(update))
        };
        let hub = |commit: Option<&str>, release: bool| {
            let mut meta = crate::testing::meta();
            meta.running_commit = commit.map(String::from);
            meta.release = release.then(|| crate::update::release::Config::from_env("o/r").unwrap());
            crate::testing::state_with(meta)
        };
        // A hub deployed without a checkout sends its commit, and its version for a release host.
        let s = hub(Some("abc"), false);
        link_http(&s, "host", host(sent.clone()), API_VERSION).await;
        let app = crate::api::router(s.clone());
        assert_eq!(call(&app, "POST", "/api/hosts/host/update").await, (200, json!({"ok": true})));
        // One that runs a release only has its version.
        let s = hub(None, true);
        link_http(&s, "host", host(sent.clone()), API_VERSION).await;
        assert_eq!(call(&crate::api::router(s.clone()), "POST", "/api/hosts/host/update").await.0, 200);
        let version = env!("CARGO_PKG_VERSION");
        assert_eq!(*sent.lock().unwrap(), [json!({"commit": "abc", "version": version}), json!({"version": version})]);
        // Neither: it can't say what to update to.
        let s = hub(None, false);
        link_http(&s, "host", host(sent.clone()), API_VERSION).await;
        let (code, v) = call(&crate::api::router(s.clone()), "POST", "/api/hosts/host/update").await;
        assert_eq!(code, 400);
        assert!(v["error"].as_str().unwrap().contains("set IA_COMMIT"), "{v}");
        assert_eq!(sent.lock().unwrap().len(), 2);
        // The hosts list says how each host updates.
        let s = hub(None, true);
        assert_eq!(call(&crate::api::router(s.clone()), "GET", "/api/hosts").await.1[0]["updates_from"], "releases");
    })
}

// HA-49: the UI took any 401 from its own host as the board's token being wrong, and ignored the rest, even
// while it didn't know yet which host was its own. Now only the board's token being wrong is a 401.
#[test]
fn only_the_boards_own_token_is_a_401_through_the_proxy() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        // A host whose token has changed since it was linked.
        let stale = Router::new().route("/api/profiles", axum::routing::get(|| async { (StatusCode::UNAUTHORIZED, Json(json!({"error": "unauthorized"}))) }));
        link_http(&s, "stale", stale, 0).await;
        let app = crate::api::router(s.clone());
        let err = json!({"error": "host stale didn't accept this hub's token for it; link it again"});
        assert_eq!(call(&app, "GET", "/api/h/stale/profiles").await, (502, err.clone()));
        assert_eq!(call(&app, "GET", "/api/h/h/profiles").await.0, 200);
        // The hub's own calls to it too.
        let e = host_request(&s, "stale", "GET", "/api/profiles", None).await.unwrap_err();
        assert_eq!((e.0, e.1.as_str()), (StatusCode::BAD_GATEWAY, err["error"].as_str().unwrap()));
        for host in ["h", "stale"] {
            let req = Request::builder().uri(format!("/api/h/{host}/profiles")).header("authorization", "Bearer wrong").body(Body::empty()).unwrap();
            assert_eq!(app.clone().oneshot(req).await.unwrap().status(), StatusCode::UNAUTHORIZED, "{host}");
        }
    })
}

fn node(id: &str, name: &str) -> Shared {
    crate::testing::state_as(crate::state::Identity {
        host_id: id.into(),
        host_name: name.into(),
        token: format!("{id}-tok"),
        hub_token: format!("{id}-hub"),
        internal_url: String::new(),
    })
}

/// Serve a node's API, returning its address.
async fn serve(s: &Shared) -> std::net::SocketAddr {
    let app = crate::api::router(s.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).await });
    addr
}

/// A TCP proxy to `to`. `freeze` makes the connections it has so far stop passing anything on, either
/// way, without closing them: what a NAT mapping that expired, or a laptop that went to sleep, does.
struct Proxy {
    addr: std::net::SocketAddr,
    conns: Arc<Mutex<Vec<Arc<std::sync::atomic::AtomicBool>>>>,
}

impl Proxy {
    async fn new(to: std::net::SocketAddr) -> Proxy {
        use std::sync::atomic::AtomicBool;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        async fn pipe(mut from: tokio::net::tcp::OwnedReadHalf, mut to: tokio::net::tcp::OwnedWriteHalf, frozen: Arc<AtomicBool>) {
            let mut buf = vec![0; 1 << 16];
            while let Ok(n @ 1..) = from.read(&mut buf).await {
                if !frozen.load(Ordering::Relaxed) && to.write_all(&buf[..n]).await.is_err() {
                    return;
                }
            }
            // Nor does a frozen connection pass on that one end closed.
            if frozen.load(Ordering::Relaxed) {
                std::future::pending::<()>().await;
            }
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let conns: Arc<Mutex<Vec<Arc<AtomicBool>>>> = Arc::default();
        let list = conns.clone();
        tokio::spawn(async move {
            while let Ok((a, _)) = listener.accept().await {
                let Ok(b) = tokio::net::TcpStream::connect(to).await else { continue };
                let frozen = Arc::new(AtomicBool::new(false));
                list.lock().unwrap().push(frozen.clone());
                let ((ar, aw), (br, bw)) = (a.into_split(), b.into_split());
                tokio::spawn(pipe(ar, bw, frozen.clone()));
                tokio::spawn(pipe(br, aw, frozen));
            }
        });
        Proxy { addr, conns }
    }

    fn freeze(&self) {
        for c in self.conns.lock().unwrap().iter() {
            c.store(true, Ordering::Relaxed);
        }
    }
}

/// Wait (up to 20s) for `f` to give something.
async fn until<T>(what: &str, mut f: impl FnMut() -> Option<T>) -> T {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(v) = f() {
            return v;
        }
        assert!(tokio::time::Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn outbound_link(id: &str, url: &str, token: &str) -> Link {
    Link {
        id: id.into(),
        name: id.into(),
        mode: "outbound".into(),
        url: Some(url.into()),
        token: Some(token.into()),
        ssh: None,
        last_seen: None,
        created_at: crate::util::now(),
    }
}

#[test]
fn a_host_dialled_in_over_a_dead_connection_reconnects() {
    crate::testing::run(async || {
        let (hub, host) = (node("hub", "hub"), node("host", "laptop"));
        let _ = crate::api::router(host.clone());
        let proxy = Proxy::new(serve(&hub).await).await;
        dial_out(&host, format!("http://{}", proxy.addr), "hub-hub".into());
        let first = until("the host to dial in", || find_link(&hub, "host")).await;
        assert_eq!(first.request("GET", "/api/info", None).await.unwrap().0, 200);

        // Both ends notice that they hear nothing, and the host dials in again. A request waiting on the
        // dead connection fails then, rather than after the request timeout.
        proxy.freeze();
        let waiting = tokio::time::timeout(SILENCE * 3, first.request("GET", "/api/info", None)).await.expect("the request still waits");
        assert!(format!("{:#}", waiting.unwrap_err()).contains("disconnected"));
        let second = until("the host to dial in again", || find_link(&hub, "host").filter(|l| !Arc::ptr_eq(l, &first))).await;
        assert_eq!(second.request("GET", "/api/info", None).await.unwrap().0, 200);
        // Pings keep it connected meanwhile.
        tokio::time::sleep(SILENCE * 2).await;
        assert!(find_link(&hub, "host").is_some_and(|l| Arc::ptr_eq(&l, &second)));
    })
}

#[test]
fn a_host_dialled_over_a_dead_connection_is_dialled_again() {
    crate::testing::run(async || {
        let (hub, host) = (node("hub", "hub"), node("host", "laptop"));
        let proxy = Proxy::new(serve(&host).await).await;
        let url = format!("http://{}", proxy.addr);
        db::upsert_link(&hub.db(), "host", "laptop", "outbound", Some(&url), Some("host-tok")).unwrap();
        spawn_outbound(&hub, outbound_link("host", &url, "host-tok"));
        let first = until("the hub to connect", || find_link(&hub, "host")).await;
        let hosts = list_hosts(State(hub.clone())).await.unwrap().0;
        assert!(hosts[1]["last_message_at"].as_str().is_some_and(|t| t.ends_with('Z')), "{hosts}");

        proxy.freeze();
        until("the hub to give up on it", || find_link(&hub, "host").is_none().then_some(())).await;
        let second = until("the hub to connect again", || find_link(&hub, "host")).await;
        assert!(!Arc::ptr_eq(&first, &second));
        tokio::time::sleep(SILENCE * 2).await;
        assert!(find_link(&hub, "host").is_some_and(|l| Arc::ptr_eq(&l, &second)));
    })
}

#[test]
fn a_host_dialled_in_through_a_broker_over_a_dead_connection_reconnects() {
    crate::testing::run(async || {
        const BROKER_TOKEN: &str = "broker-token-0123456789";
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let broker = l.local_addr().unwrap();
        let app = huntaway_broker::router(huntaway_broker::Config { token: BROKER_TOKEN.into(), ..Default::default() }).unwrap();
        tokio::spawn(async move { axum::serve(l, app).await });
        // The hub is on the broker, which it reaches its own API from.
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let internal_url = format!("http://{}", l.local_addr().unwrap());
        let id = crate::state::Identity { host_id: "hub".into(), host_name: "hub".into(), token: "hub-tok".into(), hub_token: "hub-hub".into(), internal_url };
        let hub = crate::testing::state_as(id);
        let app = crate::api::router(hub.clone());
        tokio::spawn(async move { axum::serve(l, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).await });
        crate::hosts::broker::dial_out(&hub, format!("http://{broker}"), BROKER_TOKEN.into(), "hub".into(), "hub-key".into());

        // The host dials the hub at the broker, over a connection that dies.
        let host = node("host", "laptop");
        let _ = crate::api::router(host.clone());
        let proxy = Proxy::new(broker).await;
        dial_out(&host, format!("http://{}/_broker/h/hub", proxy.addr), "hub-hub".into());
        let first = until("the host to dial in", || find_link(&hub, "host")).await;
        assert_eq!(first.request("GET", "/api/info", None).await.unwrap().0, 200);

        // The hub's relay to the broker answers its websocket pings, but the host doesn't answer its `Down::Ping`.
        proxy.freeze();
        let second = until("the host to dial in again", || find_link(&hub, "host").filter(|l| !Arc::ptr_eq(l, &first))).await;
        assert_eq!(second.request("GET", "/api/info", None).await.unwrap().0, 200);
    })
}

#[test]
fn a_host_added_again_drops_its_old_connection() {
    crate::testing::run(async || {
        let (hub, host) = (node("hub", "hub"), node("host", "laptop"));
        let addr = serve(&host).await;
        spawn_outbound(&hub, outbound_link("host", &format!("http://{addr}"), "host-tok"));
        until("the hub to connect", || find_link(&hub, "host")).await;
        // Added again at a URL where nothing answers: it's no longer connected.
        spawn_outbound(&hub, outbound_link("host", "http://127.0.0.1:1", "host-tok"));
        until("the old connection to go", || find_link(&hub, "host").is_none().then_some(())).await;
    })
}

#[test]
fn a_host_dialling_in_keeps_its_link_and_a_second_one_is_refused() {
    crate::testing::run(async || {
        let (hub, host) = (node("hub", "hub"), node("host", "laptop"));
        let _ = crate::api::router(host.clone());
        // The hub also dials this host (it isn't up at the moment).
        db::upsert_link(&hub.db(), "host", "laptop", "outbound", Some("http://127.0.0.1:1"), Some("host-tok")).unwrap();
        let url = format!("http://{}", serve(&hub).await);
        dial_out(&host, url.clone(), "hub-hub".into());
        let first = until("the host to dial in", || find_link(&hub, "host")).await;
        assert_eq!(first.mode, "inbound");
        let link = db::get_link(&hub.db(), "host").unwrap().unwrap();
        assert_eq!((link.mode.as_str(), link.url.as_deref()), ("outbound", Some("http://127.0.0.1:1")));

        // Another host with the same id is turned away, and the first stays connected.
        let twin = node("host", "twin");
        let refused = tokio::time::timeout(Duration::from_secs(5), tunnel_to(&twin, &url, "hub-hub")).await.expect("the twin's tunnel stays up");
        assert!(format!("{:#}", refused.unwrap_err()).contains("already connected"));
        assert!(find_link(&hub, "host").is_some_and(|l| Arc::ptr_eq(&l, &first)));
        assert_eq!(first.name, "laptop");

        // A host seen for the first time is noted as dialling in.
        let other = node("other", "desktop");
        let _ = crate::api::router(other.clone());
        dial_out(&other, url, "hub-hub".into());
        until("the other host to dial in", || find_link(&hub, "other")).await;
        assert_eq!(db::get_link(&hub.db(), "other").unwrap().unwrap().mode, "inbound");
    })
}

#[test]
fn the_join_command_dials_the_hub_where_the_browser_reached_it() {
    let s = node("hub", "hub");
    let headers = |pairs: &[(&'static str, &str)]| pairs.iter().map(|(k, v)| (axum::http::HeaderName::from_static(k), v.parse().unwrap())).collect::<HeaderMap>();
    assert_eq!(hub_url(&s, &headers(&[("host", "box:7878")])), "http://box:7878");
    let proxied = headers(&[("host", "127.0.0.1:7878"), ("x-forwarded-host", "board.example.com, inner"), ("x-forwarded-proto", "https")]);
    assert_eq!(hub_url(&s, &proxied), "https://board.example.com");
    // Through the broker, at the broker, once it's known.
    let brokered = headers(&[("host", "127.0.0.1:7878"), (crate::hosts::broker::VIA_BROKER, "1")]);
    assert_eq!(hub_url(&s, &brokered), "http://127.0.0.1:7878");
    s.broker_url.set("https://broker.example.com/_broker/h/hub".into()).unwrap();
    assert_eq!(hub_url(&s, &brokered), "https://broker.example.com/_broker/h/hub");
}
