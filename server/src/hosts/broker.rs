//! Dialling out to a broker (`serve --broker <url>`, see `server/broker`), so this host can be
//! reached through it from anywhere: its board in a browser, and its API from hubs.
//!
//! A managed broker sends a connector token and public endpoint; cloudflared carries application
//! traffic to our private origin listener, independently of the broker connection. A legacy broker
//! sends requests down our websocket instead, answered over loopback with the client's headers.
//! Both public transports still require our token and must never expose --open-token.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use huntaway_broker::proto::{self, Ctl};
use futures::{SinkExt, StreamExt};
use serde_json::json;
use tokio::sync::{mpsc, watch};
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

/// Resolve an explicit broker host URL before sending a host/hub token or opening a websocket.
/// 404 means an older relay broker. Discovery itself carries no credential and follows no redirects.
pub async fn resolve(url: &str, expected_host: Option<&str>) -> Result<String> {
    let base = reqwest::Url::parse(url).context("bad host URL")?;
    let path = base.path().trim_end_matches('/');
    let explicit = path.strip_prefix("/_broker/h/").filter(|n| proto::valid_name(n));
    if explicit.is_none() && !path.is_empty() { return Ok(url.to_string()); }
    let mut discovery = base.clone();
    discovery.set_path(&explicit.map(|name| format!("/_broker/resolve/{name}")).unwrap_or_else(|| "/_broker/resolve".into()));
    discovery.set_query(None);
    discovery.set_fragment(None);
    static DISCOVERY: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    // Never reuse a discovery socket: the last one may belong to the network that just died.
    let client = DISCOVERY.get_or_init(|| reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
        .pool_max_idle_per_host(0).timeout(Duration::from_secs(10)).build().expect("discovery client"));
    let res = client.get(discovery).send().await.context("discovering the host endpoint")?;
    // A normal host serves its UI fallback here. Only a broker identifies its default discovery route.
    if explicit.is_none() && !res.headers().contains_key("x-huntaway-broker") { return Ok(url.to_string()); }
    if res.status() == reqwest::StatusCode::NOT_FOUND { return Ok(url.to_string()); }
    let res = res.error_for_status().context("broker couldn't resolve the host endpoint")?;
    let info: serde_json::Value = res.json().await.context("bad broker discovery response")?;
    let host_id = info["host_id"].as_str().filter(|id| !id.is_empty()).context("broker discovery has no host id")?;
    if expected_host.is_some_and(|id| id != host_id) { bail!("broker name now belongs to a different host; link it again"); }
    let endpoint = reqwest::Url::parse(info["url"].as_str().context("broker discovery has no endpoint")?).context("invalid broker endpoint")?;
    let loopback = matches!(endpoint.host_str(), Some("127.0.0.1" | "[::1]" | "localhost"));
    if !(endpoint.scheme() == "https" || (endpoint.scheme() == "http" && loopback)) || endpoint.host().is_none()
        || !endpoint.username().is_empty() || endpoint.password().is_some() || endpoint.query().is_some() || endpoint.fragment().is_some()
        || endpoint.path() != "/" {
        bail!("broker returned an unsafe endpoint (expected a plain HTTPS origin)");
    }
    Ok(endpoint.to_string().trim_end_matches('/').into())
}

/// Our streams by id.
type Streams = Arc<Mutex<HashMap<u64, Entry>>>;

/// Keep a connection to the broker at `url`, as `name`. `key` is our secret on the broker: it keeps
/// `name` for whoever took it first with theirs.
#[cfg(test)]
pub fn dial_out(s: &Shared, url: String, token: String, name: String, key: String) {
    dial_with_origin(s, url, token, name, key, None);
}

/// A tunnel must reach this listener, rather than the LAN listener: --open-token must stay private.
pub async fn origin(app: axum::Router) -> Result<u16> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let app = app.layer(axum::middleware::from_fn(|mut req: axum::extract::Request, next: axum::middleware::Next| async move {
        req.headers_mut().insert(VIA_BROKER, axum::http::HeaderValue::from_static("1"));
        next.run(req).await
    }));
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await { tracing::warn!("tunnel origin: {e}"); }
    });
    Ok(port)
}

pub fn dial_with_origin(s: &Shared, url: String, token: String, name: String, key: String, origin_port: Option<u16>) {
    let _ = s.broker_url.set(format!("{}/_broker/h/{name}", url.trim_end_matches('/')));
    let s = s.clone();
    let (connector, updates) = watch::channel(None);
    let connector_bin = std::env::var_os("IA_CLOUDFLARED_BIN").unwrap_or_else(|| "cloudflared".into());
    tokio::spawn(connect_tunnel(updates, connector_bin));
    tokio::spawn(async move {
        let mut backoff = 1;
        loop {
            let started = std::time::Instant::now();
            if let Err(e) = session(&s, &url, &token, &name, &key, origin_port, &connector).await {
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

/// The connector outlives broker sessions. A broker outage must not interrupt board traffic.
/// Tokens use the environment, never command arguments or logs; cloudflared owns its own retries.
async fn connect_tunnel(mut updates: watch::Receiver<Option<proto::Tunnel>>, bin: std::ffi::OsString) {
    loop {
        let tunnel = updates.borrow_and_update().clone();
        let Some(tunnel) = tunnel else {
            if updates.changed().await.is_err() { return; }
            continue;
        };
        match spawn_connector(&bin, &tunnel.token) {
            Ok((mut child, _alive)) => tokio::select! {
                _ = updates.changed() => { let _ = child.kill().await; if updates.has_changed().is_err() { return; } },
                result = child.wait() => tracing::warn!("cloudflared exited ({result:?}); check its installation/connectivity; restarting in five seconds"),
            },
            Err(e) => tracing::warn!("couldn't start cloudflared: {e}; install it on this host or set IA_CLOUDFLARED_BIN"),
        }
        tokio::select! {
            _ = updates.changed() => { if updates.has_changed().is_err() { return; } },
            _ = tokio::time::sleep(Duration::from_secs(5)) => {},
        }
    }
}

/// The watchdog owns the connector's process group and watches a pipe held only by this server
/// (close-on-exec). It kills the group on exec, forced exit or a crash, where kill_on_drop cannot
/// run. Arguments are positional, never interpreted as shell code (same pattern as wait::LAUNCH).
fn spawn_connector(bin: &std::ffi::OsStr, token: &str) -> Result<(tokio::process::Child, std::io::PipeWriter)> {
    const LAUNCH: &str = r#"exec 3<&0 </dev/null; (read -r _ <&3; kill -KILL 0) & exec 3<&-; exec "$@""#;
    let (watched, alive) = std::io::pipe().context("creating the tunnel watchdog")?;
    let child = tokio::process::Command::new("bash")
        .args(["-c", LAUNCH, "huntaway-tunnel"]).arg(bin).args(["tunnel", "--no-autoupdate", "run"])
        .env("TUNNEL_TOKEN", token).stdin(watched)
        .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
        .process_group(0).kill_on_drop(true).spawn().context("starting the tunnel connector")?;
    Ok((child, alive))
}

async fn session(s: &Shared, url: &str, token: &str, name: &str, key: &str, origin_port: Option<u16>, connector: &watch::Sender<Option<proto::Tunnel>>) -> Result<()> {
    let ws_url = format!("{}/_broker/connect", url.trim_end_matches('/').replacen("http", "ws", 1));
    let mut req = ws_url.into_client_request()?;
    req.headers_mut().insert("Authorization", format!("Bearer {token}").parse()?);
    let (ws, _) = tokio_tungstenite::connect_async(req).await.context("connecting")?;
    let (mut sink, mut stream) = ws.split();
    let hello = Ctl::Hello { name: name.into(), host_id: s.host_id.clone(), version: env!("CARGO_PKG_VERSION").into(), protocol: proto::PROTOCOL, key: Some(key.into()), origin_port };
    sink.send(TMessage::Text(serde_json::to_string(&hello)?.into())).await?;
    let relaying = match tokio::time::timeout(Duration::from_secs(120), stream.next()).await {
        Ok(Some(Ok(TMessage::Text(t)))) => match serde_json::from_str::<Ctl>(&t)? {
            Ctl::Welcome { name, tunnel } => {
                if let Some(t) = &tunnel { tracing::info!("host {name} tunnel endpoint {} (broker handles setup only)", t.url); }
                else { tracing::info!("reachable through the broker {url} as {name}"); }
                let relaying = tunnel.is_none();
                connector.send_if_modified(|old| { if *old == tunnel { false } else { *old = tunnel; true } });
                relaying
            }
            Ctl::Refused { error } => bail!("refused: {error}"),
            other => bail!("expected a welcome, got {other:?}"),
        },
        _ => bail!("no welcome"),
    };
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
                    Ok(Ctl::Req { .. }) if !relaying => bail!("the broker tried to relay application traffic in managed tunnel mode"),
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
mod tests;
