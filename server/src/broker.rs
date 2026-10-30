//! Dialling out to a broker (`serve --broker <url>`, see `server/broker`), so this host can be
//! reached through it from anywhere: its board in a browser, and its API from hubs.
//!
//! The broker passes each client's request down our websocket, and we make it against our own
//! server over loopback, with the client's own headers. The broker is no more trusted than the
//! client: requests need our token as they would anywhere else.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use huntaway_broker::proto::{self, Ctl};
use futures::{SinkExt, StreamExt};
use serde_json::json;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message as TMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;

use crate::state::Shared;

/// Paths a client mustn't reach through the broker: `--open-token` hands the token to whoever asks.
const BLOCKED: &[&str] = &["/api/open-token"];

/// Marks the requests we make on our own server for the broker's clients, so a route that mustn't
/// be reached through the broker can refuse them however their path is spelled.
pub const VIA_BROKER: &str = "x-huntaway-via-broker";

/// The broker sends a `Ping` every 20s; one we hear nothing from for this long is gone.
const SILENCE: Duration = Duration::from_secs(60);

/// What the broker sent on one of our streams.
enum Incoming {
    Data(Vec<u8>),
    Text(String),
    End,
    Close(Option<u16>, Option<String>),
}

/// One of our streams: where what the broker sends on it goes, our room to send it data, and for a
/// request, how to stop it when the client goes away.
struct Entry {
    tx: mpsc::UnboundedSender<Incoming>,
    window: proto::Window,
    /// Stops the stream's task, which may be waiting on our server however long.
    abort: Option<tokio::task::AbortHandle>,
    ws: bool,
}

/// How long a websocket the broker closed has to close on our server before it's cut off.
const CLOSE_GRACE: Duration = Duration::from_secs(2);

impl Entry {
    /// The stream is over. A request stops at once. A websocket gets the close it was sent through
    /// `tx`, with `CLOSE_GRACE` to pass it on, unless it's to stop at once too (we lost the broker).
    fn end(self, at_once: bool) {
        self.window.close();
        let Some(a) = self.abort else { return };
        if self.ws && !at_once {
            tokio::spawn(async move {
                tokio::time::sleep(CLOSE_GRACE).await;
                a.abort();
            });
        } else {
            a.abort();
        }
    }
}

/// Our streams by id.
type Streams = Arc<Mutex<HashMap<u64, Entry>>>;

/// Keep a connection to the broker at `url`, as `name`.
pub fn dial_out(s: &Shared, url: String, token: String, name: String) {
    let s = s.clone();
    tokio::spawn(async move {
        let mut backoff = 1;
        loop {
            let started = std::time::Instant::now();
            if let Err(e) = session(&s, &url, &token, &name).await {
                tracing::warn!("broker {url}: {e:#}");
            }
            // A connection that lasted a while starts over at a quick retry.
            if started.elapsed() > Duration::from_secs(60) {
                backoff = 1;
            }
            tokio::time::sleep(Duration::from_secs(backoff)).await;
            backoff = (backoff * 2).min(30);
        }
    });
}

async fn session(s: &Shared, url: &str, token: &str, name: &str) -> Result<()> {
    let ws_url = format!("{}/_broker/connect", url.trim_end_matches('/').replacen("http", "ws", 1));
    let mut req = ws_url.into_client_request()?;
    req.headers_mut().insert("Authorization", format!("Bearer {token}").parse()?);
    let (ws, _) = tokio_tungstenite::connect_async(req).await.context("connecting")?;
    let (mut sink, mut stream) = ws.split();
    let hello = Ctl::Hello { name: name.into(), host_id: s.host_id.clone(), version: env!("CARGO_PKG_VERSION").into(), protocol: proto::PROTOCOL };
    sink.send(TMessage::Text(serde_json::to_string(&hello)?.into())).await?;
    match tokio::time::timeout(Duration::from_secs(10), stream.next()).await {
        Ok(Some(Ok(TMessage::Text(t)))) => match serde_json::from_str::<Ctl>(&t)? {
            Ctl::Welcome { name } => tracing::info!("reachable through the broker {url} as {name}"),
            Ctl::Refused { error } => bail!("refused: {error}"),
            other => bail!("expected a welcome, got {other:?}"),
        },
        _ => bail!("no welcome"),
    }
    let (tx, mut rx) = mpsc::unbounded_channel::<TMessage>();
    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });
    let streams: Streams = Arc::default();
    let result = async {
        loop {
            let msg = match tokio::time::timeout(SILENCE, stream.next()).await {
                Ok(Some(m)) => m?,
                Ok(None) => return Ok(()),
                Err(_) => bail!("the broker went quiet"),
            };
            match msg {
                TMessage::Text(t) => match serde_json::from_str::<Ctl>(&t) {
                    Ok(Ctl::Req { id, method, path, headers, body, ws }) => {
                        let (in_tx, in_rx) = mpsc::unbounded_channel();
                        let window = proto::Window::default();
                        // Registered right away: the request body follows at once.
                        streams.lock().unwrap().insert(id, Entry { tx: in_tx, window: window.clone(), abort: None, ws });
                        let (s, tx, streams2) = (s.clone(), Out { id, tx: tx.clone(), window }, streams.clone());
                        let task = tokio::spawn(async move {
                            if ws {
                                websocket(&s, &path, headers, in_rx, &tx).await;
                            } else {
                                request(&s, &method, &path, headers, body.then_some(in_rx), &tx).await;
                            }
                            streams2.lock().unwrap().remove(&tx.id);
                        });
                        if let Some(entry) = streams.lock().unwrap().get_mut(&id) {
                            entry.abort = Some(task.abort_handle());
                        }
                    }
                    Ok(Ctl::Ping) => {
                        let _ = tx.send(TMessage::Text(serde_json::to_string(&Ctl::Pong)?.into()));
                    }
                    Ok(Ctl::End { id }) => incoming(&streams, id, Incoming::End, false),
                    Ok(Ctl::Close { id, code, reason }) => incoming(&streams, id, Incoming::Close(code, reason), true),
                    Ok(Ctl::Credit { id, bytes }) => {
                        if let Some(e) = streams.lock().unwrap().get(&id) {
                            e.window.credit(bytes);
                        }
                    }
                    Ok(_) => {}
                    Err(e) => tracing::warn!("bad message from the broker: {e}"),
                },
                TMessage::Binary(b) => match proto::decode(&b) {
                    Some((id, proto::TEXT, bytes)) => incoming(&streams, id, Incoming::Text(String::from_utf8_lossy(bytes).into()), false),
                    Some((id, _, bytes)) => incoming(&streams, id, Incoming::Data(bytes.to_vec()), false),
                    None => {}
                },
                TMessage::Close(f) => {
                    if let Some(f) = f {
                        tracing::info!("the broker hung up: {}", f.reason);
                    }
                    return Ok(());
                }
                _ => {}
            }
        }
    }
    .await;
    // Dropping the senders closes the websockets in flight; requests are stopped.
    for (_, e) in streams.lock().unwrap().drain() {
        e.end(true);
    }
    writer.abort();
    result
}

fn incoming(streams: &Streams, id: u64, msg: Incoming, last: bool) {
    let mut streams = streams.lock().unwrap();
    if last {
        if let Some(e) = streams.remove(&id) {
            let _ = e.tx.send(msg);
            e.end(false);
        }
    } else if let Some(e) = streams.get(&id) {
        let _ = e.tx.send(msg);
    }
}

/// Sending on one stream.
#[derive(Clone)]
struct Out {
    id: u64,
    tx: mpsc::UnboundedSender<TMessage>,
    /// Our room to send its data.
    window: proto::Window,
}

impl Out {
    fn ctl(&self, ctl: Ctl) -> bool {
        self.tx.send(TMessage::Text(serde_json::to_string(&ctl).unwrap_or_default().into())).is_ok()
    }

    /// Data sent whatever the window: only for a short body we make up ourselves, in place of a response.
    fn data(&self, kind: u8, bytes: &[u8]) -> bool {
        self.tx.send(TMessage::Binary(proto::encode(self.id, kind, bytes).into())).is_ok()
    }

    /// Send body bytes as the window has room for them.
    async fn body(&self, bytes: &[u8]) -> bool {
        for piece in bytes.chunks(proto::WINDOW) {
            if !self.window.take(piece.len()).await || !self.data(proto::DATA, piece) {
                return false;
            }
        }
        true
    }

    /// Send a websocket message once the window has room for it.
    async fn message(&self, kind: u8, bytes: &[u8]) -> bool {
        self.window.take(bytes.len()).await && self.data(kind, bytes)
    }

    /// Tell the broker we passed on `bytes` of what it sent.
    fn credit(&self, bytes: usize) {
        if bytes > 0 {
            self.ctl(Ctl::Credit { id: self.id, bytes: bytes as u64 });
        }
    }

    fn head(&self, status: u16, headers: Vec<(String, String)>) -> bool {
        self.ctl(Ctl::Head { id: self.id, status, headers })
    }

    fn end(&self) {
        self.ctl(Ctl::End { id: self.id });
    }

    /// A whole JSON response, as the API answers errors.
    fn json(&self, status: u16, body: serde_json::Value) {
        self.head(status, vec![("content-type".into(), "application/json".into())]);
        self.data(proto::DATA, body.to_string().as_bytes());
        self.end();
    }
}

/// The URL on our server (`base`) for a path the broker passes on. None for one a client mustn't
/// reach through the broker: one that isn't on our server (`@other.host/` after our URL would be
/// another server), or one that's blocked, however it's written (`/api/./open-token`, `%2e`, `\`).
/// The URL is checked as it's parsed, which resolves dot segments, and then decoded on top, so it's
/// what gets requested that's checked.
fn local_url(base: &str, path: &str) -> Option<reqwest::Url> {
    if !path.starts_with('/') {
        return None;
    }
    let base = reqwest::Url::parse(base).ok()?;
    let url = reqwest::Url::parse(&format!("{}{path}", base.as_str().trim_end_matches('/'))).ok()?;
    if url.origin() != base.origin() || BLOCKED.contains(&normalized(url.path()).as_str()) {
        return None;
    }
    Some(url)
}

/// A path decoded and resolved until it doesn't change: no escapes, dot segments, backslashes,
/// empty segments, trailing slash or capitals. More than a server would make of it, so nothing that
/// routes to a blocked path gets past.
fn normalized(path: &str) -> String {
    let mut p = path.to_lowercase();
    for _ in 0..8 {
        let decoded = percent_decode(&p).replace('\\', "/").to_lowercase();
        let mut segs: Vec<&str> = vec![];
        for seg in decoded.split('/') {
            match seg {
                "" | "." => {}
                ".." => {
                    segs.pop();
                }
                s => segs.push(s),
            }
        }
        let next = format!("/{}", segs.join("/"));
        if next == p {
            break;
        }
        p = next;
    }
    p
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = (b[i] == b'%').then(|| b.get(i + 1..i + 3)).flatten().and_then(|h| u8::from_str_radix(std::str::from_utf8(h).ok()?, 16).ok());
        match hex {
            Some(c) => {
                out.push(c);
                i += 3;
            }
            None => {
                out.push(b[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn local() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    // Redirects go back to the client as they are, and loopback never goes through a proxy.
    CLIENT.get_or_init(|| reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).no_proxy().build().expect("http client"))
}

/// Pass the client's headers on, but not the ones that belong to the hop to the broker.
fn passed_on(headers: Vec<(String, String)>) -> impl Iterator<Item = (String, String)> {
    // A client's own is dropped: ours says the request came through the broker.
    headers
        .into_iter()
        .filter(|(k, _)| !proto::hop_by_hop(k) && !k.eq_ignore_ascii_case("content-length") && !k.eq_ignore_ascii_case(VIA_BROKER))
        .chain([(VIA_BROKER.to_string(), "1".to_string())])
}

/// Make an HTTP request on our own server and send the response back.
async fn request(s: &Shared, method: &str, path: &str, headers: Vec<(String, String)>, body: Option<mpsc::UnboundedReceiver<Incoming>>, out: &Out) {
    let Some(url) = local_url(&s.internal_url, path) else {
        return out.json(404, crate::api::no_route_error(method, path));
    };
    let Ok(m) = reqwest::Method::from_bytes(method.as_bytes()) else {
        return out.json(400, json!({"error": format!("bad method {method}")}));
    };
    let mut req = local().request(m, url);
    for (k, v) in passed_on(headers) {
        req = req.header(k, v);
    }
    if let Some(rx) = body {
        // The body as the broker sends it, giving it room for more as our server takes it; a client
        // that went away fails the request.
        let chunks = futures::stream::unfold(Some((rx, out.clone())), |state| async move {
            let (mut rx, out) = state?;
            match rx.recv().await {
                Some(Incoming::Data(b)) => {
                    out.credit(b.len());
                    Some((Ok(b), Some((rx, out))))
                }
                Some(Incoming::Text(t)) => {
                    out.credit(t.len());
                    Some((Ok(t.into_bytes()), Some((rx, out))))
                }
                Some(Incoming::End) => None,
                Some(Incoming::Close(..)) | None => Some((Err(std::io::Error::other("the client went away")), None)),
            }
        });
        req = req.body(reqwest::Body::wrap_stream(chunks));
    }
    let res = match req.send().await {
        Ok(r) => r,
        Err(e) => return out.json(502, json!({"error": format!("{e:#}")})),
    };
    let headers = res.headers().iter().filter_map(|(k, v)| Some((k.to_string(), v.to_str().ok()?.to_string()))).collect();
    if !out.head(res.status().as_u16(), headers) {
        return;
    }
    let mut body = res.bytes_stream();
    while let Some(chunk) = body.next().await {
        match chunk {
            Ok(c) => {
                if !out.body(&c).await {
                    return;
                }
            }
            Err(e) => {
                out.ctl(Ctl::Close { id: out.id, code: None, reason: Some(format!("{e:#}")) });
                return;
            }
        }
    }
    out.end();
}

/// Open a websocket on our own server and relay it until either side closes it.
async fn websocket(s: &Shared, path: &str, headers: Vec<(String, String)>, mut from_broker: mpsc::UnboundedReceiver<Incoming>, out: &Out) {
    #[cfg(test)]
    let _live = tests::LiveWs::new(path);
    let Some(mut url) = local_url(&s.internal_url, path) else {
        return out.json(404, crate::api::no_route_error("GET", path));
    };
    let _ = url.set_scheme("ws");
    let req = url.as_str().into_client_request().map(|mut req| {
        for (k, v) in passed_on(headers) {
            if let (Ok(k), Ok(v)) = (axum::http::HeaderName::try_from(k), axum::http::HeaderValue::try_from(v)) {
                req.headers_mut().append(k, v);
            }
        }
        req
    });
    // The websocket itself rather than a relay with queues of its own: we read a message from our
    // server only once there's room to send it on, and give the broker room back only once one is
    // written, so neither way piles up here.
    let (mut sink, mut source) = match req {
        Ok(req) => match tokio_tungstenite::connect_async(req).await {
            Ok((ws, _)) => ws.split(),
            // Not a websocket after all (unauthorized, say): the client gets that response.
            Err(tokio_tungstenite::tungstenite::Error::Http(res)) => {
                let headers = res.headers().iter().filter_map(|(k, v)| Some((k.to_string(), v.to_str().ok()?.to_string()))).collect();
                out.head(res.status().as_u16(), headers);
                if let Some(b) = res.body() {
                    out.data(proto::DATA, b);
                }
                return out.end();
            }
            Err(e) => return out.json(502, json!({"error": format!("{e:#}")})),
        },
        Err(e) => return out.json(400, json!({"error": format!("{e:#}")})),
    };
    out.head(101, vec![]);
    // The two ways go on side by side, so one waiting for room doesn't hold up the other.
    let up = async {
        loop {
            let (msg, n) = match from_broker.recv().await {
                Some(Incoming::Data(b)) => {
                    let n = b.len();
                    (TMessage::Binary(b.into()), n)
                }
                Some(Incoming::Text(t)) => {
                    let n = t.len();
                    (TMessage::Text(t.into()), n)
                }
                Some(Incoming::End) => continue,
                Some(Incoming::Close(code, reason)) => {
                    let frame = code.map(|c| CloseFrame { code: c.into(), reason: reason.unwrap_or_default().into() });
                    let _ = sink.send(TMessage::Close(frame)).await;
                    return;
                }
                None => {
                    let _ = sink.send(TMessage::Close(None)).await;
                    return;
                }
            };
            if sink.send(msg).await.is_err() {
                return;
            }
            out.credit(n);
        }
    };
    let down = async {
        loop {
            let sent = match source.next().await {
                Some(Ok(TMessage::Text(t))) => out.message(proto::TEXT, t.as_bytes()).await,
                Some(Ok(TMessage::Binary(b))) => out.message(proto::DATA, &b).await,
                Some(Ok(TMessage::Close(c))) => {
                    out.ctl(Ctl::Close { id: out.id, code: c.as_ref().map(|c| c.code.into()), reason: c.map(|c| c.reason.to_string()) });
                    return;
                }
                Some(Ok(_)) => true,
                None | Some(Err(_)) => {
                    out.ctl(Ctl::Close { id: out.id, code: None, reason: None });
                    return;
                }
            };
            if !sent {
                return;
            }
        }
    };
    tokio::select! { _ = up => {}, _ = down => {} }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::Identity;
    use crate::testing;
    use serde_json::Value;

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
            dial_out(&s, b.clone(), BROKER_TOKEN.into(), "desktop".into());
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
        let app = huntaway_broker::router(huntaway_broker::Config { token: BROKER_TOKEN.into(), ..cfg });
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
        dial_out(&s, broker.into(), BROKER_TOKEN.into(), id.into());
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
            crate::hub::dial_out(&laptop, format!("{b}/_broker/h/desktop"), "desktop-hub".into());
            for _ in 0..100 {
                if let Some(link) = crate::hub::find_link(&hub, "laptop") {
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
}
