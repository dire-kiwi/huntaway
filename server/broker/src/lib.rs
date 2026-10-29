//! The broker: a public relay for Huntaway hosts that can't be reached directly (at home, behind
//! NAT, without Tailscale).
//!
//! A host dials out to `/_broker/connect` (`huntaway serve --broker <url>`) and keeps that
//! websocket open. Every other request the broker gets is passed down it to a host, which answers
//! it from its own server: the board's UI, its API and its websockets. The broker keeps nothing
//! but the list of connected hosts. It doesn't sign anyone in: the host's own token still guards
//! its API, and the broker's token only says which hosts may connect.
//!
//! Which host a request goes to:
//!
//! * `/_broker/h/<name>/<path>` goes to `<path>` on that host. Hubs use it to link a host through
//!   the broker (`--hub https://broker/_broker/h/<name>`, or Add host with that URL).
//! * Anything else goes to the host named by the `X-Huntaway-Host` header, else by the
//!   `huntaway_host` cookie (set by opening `/_broker/use/<name>`), else the broker's default host
//!   (`--default-host`), else the only host connected. A browser opens the board at the root, as
//!   it would on the host itself.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::{Body, Bytes, HttpBody};
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts, Path, Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::{Json, Router};
use futures::{SinkExt, StreamExt};
use serde_json::json;
use tokio::sync::mpsc;

pub mod proto;

use proto::Ctl;

/// The broker sends a `Ping` this often, so proxies in between keep the host's websocket open.
const PING: Duration = Duration::from_secs(20);
/// A host we've heard nothing from (not even a `Pong`) for this long is gone.
const SILENCE: Duration = Duration::from_secs(60);
/// How long a request waits for the host to start answering.
const HEAD_TIMEOUT: Duration = Duration::from_secs(300);
/// The cookie that picks a host for a browser.
const COOKIE: &str = "huntaway_host";
/// The header that picks a host for a request.
const HOST_HEADER: &str = "x-huntaway-host";

#[derive(Clone, Debug, Default)]
pub struct Config {
    /// What hosts present to connect (as a bearer token).
    pub token: String,
    /// The host for requests that don't pick one.
    pub default_host: Option<String>,
}

struct Broker {
    cfg: Config,
    hosts: Mutex<HashMap<String, Arc<Host>>>,
}

/// A connected host.
struct Host {
    name: String,
    tx: mpsc::UnboundedSender<Message>,
    /// Requests in flight, by stream id.
    streams: Mutex<HashMap<u64, mpsc::UnboundedSender<Event>>>,
    next: AtomicU64,
}

/// What a host sent on one stream.
#[derive(Debug)]
enum Event {
    Head(u16, Vec<(String, String)>),
    Data(Bytes),
    Text(String),
    End,
    Close(Option<u16>, Option<String>),
}

impl Host {
    fn send(&self, ctl: &Ctl) -> bool {
        self.tx.send(Message::Text(serde_json::to_string(ctl).unwrap_or_default().into())).is_ok()
    }

    fn send_data(&self, id: u64, kind: u8, bytes: &[u8]) -> bool {
        self.tx.send(Message::Binary(proto::encode(id, kind, bytes).into())).is_ok()
    }

    /// Start a stream: its id, what the host sends on it, and a guard that ends it.
    fn open(self: &Arc<Self>) -> (Stream, mpsc::UnboundedReceiver<Event>) {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::unbounded_channel();
        self.streams.lock().unwrap().insert(id, tx);
        (Stream { host: self.clone(), id, done: false }, rx)
    }
}

/// One request on a host. Dropped before it's done (the client went away), it tells the host to
/// stop.
struct Stream {
    host: Arc<Host>,
    id: u64,
    done: bool,
}

impl Drop for Stream {
    fn drop(&mut self) {
        self.host.streams.lock().unwrap().remove(&self.id);
        if !self.done {
            self.host.send(&Ctl::Close { id: self.id, code: None, reason: None });
        }
    }
}

pub fn router(cfg: Config) -> Router {
    let b = Arc::new(Broker { cfg, hosts: Mutex::new(HashMap::new()) });
    Router::new()
        .route("/_broker/connect", get(connect))
        .route("/_broker/health", get(|| async { Json(json!({"ok": true})) }))
        .route("/_broker/use/{name}", get(use_host))
        .route("/_broker/h/{name}", any(prefixed))
        .route("/_broker/h/{name}/", any(prefixed))
        .route("/_broker/h/{name}/{*rest}", any(prefixed))
        .route("/_broker/{*rest}", any(|req: Request| async move { fail(req.uri().path(), StatusCode::NOT_FOUND, "no such broker route") }))
        .fallback(picked)
        .with_state(b)
}

// ---------- hosts ----------

async fn connect(State(b): State<Arc<Broker>>, headers: HeaderMap, upgrade: WebSocketUpgrade) -> Response {
    let token = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer "));
    if b.cfg.token.is_empty() || !token.is_some_and(|t| same(t.as_bytes(), b.cfg.token.as_bytes())) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    upgrade.on_upgrade(move |ws| serve_host(b, ws))
}

/// Compare secrets in time that doesn't depend on where they differ.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn serve_host(b: Arc<Broker>, ws: WebSocket) {
    let (mut sink, mut stream) = ws.split();
    let hello = match tokio::time::timeout(Duration::from_secs(10), stream.next()).await {
        Ok(Some(Ok(Message::Text(t)))) => serde_json::from_str::<Ctl>(&t).ok(),
        _ => None,
    };
    let refuse = |error: String| Message::Text(serde_json::to_string(&Ctl::Refused { error }).unwrap_or_default().into());
    let (name, host_id) = match hello {
        Some(Ctl::Hello { protocol, .. }) if protocol != proto::PROTOCOL => {
            let _ = sink.send(refuse(format!("the broker speaks protocol {}, the host {protocol}", proto::PROTOCOL))).await;
            return;
        }
        Some(Ctl::Hello { name, .. }) if !proto::valid_name(&name) => {
            let _ = sink.send(refuse(format!("bad host name {name:?}: use up to 48 lowercase letters, digits and hyphens"))).await;
            return;
        }
        Some(Ctl::Hello { name, host_id, .. }) => (name, host_id),
        _ => return,
    };
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let writer = tokio::spawn(async move {
        let mut ping = tokio::time::interval(PING);
        loop {
            let msg = tokio::select! {
                m = rx.recv() => match m {
                    Some(m) => m,
                    None => break,
                },
                _ = ping.tick() => Message::Text(serde_json::to_string(&Ctl::Ping).unwrap_or_default().into()),
            };
            let close = matches!(msg, Message::Close(_));
            if sink.send(msg).await.is_err() || close {
                break;
            }
        }
    });
    let host = Arc::new(Host { name: name.clone(), tx, streams: Mutex::new(HashMap::new()), next: AtomicU64::new(1) });
    // A host that reconnects (its old connection not yet seen to drop) takes its name back.
    if let Some(old) = b.hosts.lock().unwrap().insert(name.clone(), host.clone()) {
        let _ = old.tx.send(Message::Close(Some(CloseFrame { code: 4000, reason: "replaced by a newer connection".into() })));
    }
    host.send(&Ctl::Welcome { name: name.clone() });
    tracing::info!("host {name} ({host_id}) connected");
    loop {
        let msg = match tokio::time::timeout(SILENCE, stream.next()).await {
            Ok(Some(Ok(m))) => m,
            Ok(_) => break,
            Err(_) => {
                tracing::info!("host {name} went quiet");
                break;
            }
        };
        match msg {
            Message::Text(t) => match serde_json::from_str::<Ctl>(&t) {
                Ok(Ctl::Head { id, status, headers }) => to_stream(&host, id, Event::Head(status, headers), false),
                Ok(Ctl::End { id }) => to_stream(&host, id, Event::End, false),
                Ok(Ctl::Close { id, code, reason }) => to_stream(&host, id, Event::Close(code, reason), true),
                Ok(_) => {}
                Err(e) => tracing::warn!("bad message from host {name}: {e}"),
            },
            Message::Binary(b) => match proto::decode(&b) {
                Some((id, proto::TEXT, bytes)) => to_stream(&host, id, Event::Text(String::from_utf8_lossy(bytes).into()), false),
                Some((id, _, bytes)) => to_stream(&host, id, Event::Data(Bytes::copy_from_slice(bytes)), false),
                None => {}
            },
            Message::Close(_) => break,
            _ => {}
        }
    }
    {
        let mut hosts = b.hosts.lock().unwrap();
        if hosts.get(&name).is_some_and(|h| Arc::ptr_eq(h, &host)) {
            hosts.remove(&name);
        }
    }
    // Dropping the senders ends the requests in flight.
    host.streams.lock().unwrap().clear();
    writer.abort();
    tracing::info!("host {name} disconnected");
}

fn to_stream(host: &Host, id: u64, ev: Event, last: bool) {
    let mut streams = host.streams.lock().unwrap();
    let tx = if last { streams.remove(&id) } else { streams.get(&id).cloned() };
    if let Some(tx) = tx {
        let _ = tx.send(ev);
    }
}

// ---------- clients ----------

/// `/_broker/use/<name>`: send this browser to that host from now on.
async fn use_host(Path(name): Path<String>, req: Request) -> Response {
    if !proto::valid_name(&name) {
        return fail(req.uri().path(), StatusCode::BAD_REQUEST, "bad host name");
    }
    // The query goes along, so `?token=` signs the board in.
    let to = match req.uri().query() {
        Some(q) => format!("/?{q}"),
        None => "/".into(),
    };
    let cookie = format!("{COOKIE}={name}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax");
    (StatusCode::FOUND, [(header::LOCATION, to), (header::SET_COOKIE, cookie)]).into_response()
}

/// `/_broker/h/<name>/<rest>`: `/<rest>` on that host.
async fn prefixed(State(b): State<Arc<Broker>>, Path(params): Path<HashMap<String, String>>, req: Request) -> Response {
    let name = params.get("name").cloned().unwrap_or_default();
    // The rest of the path as the client sent it: the extracted one is decoded, which would turn `%2F` into `/`.
    let rest = req.uri().path().strip_prefix("/_broker/h/").and_then(|p| p.strip_prefix(name.as_str())).filter(|_| proto::valid_name(&name));
    let Some(rest) = rest else {
        return fail(req.uri().path(), StatusCode::BAD_REQUEST, "bad host name");
    };
    let path = match (rest.is_empty(), req.uri().query()) {
        (true, Some(q)) => format!("/?{q}"),
        (true, None) => "/".into(),
        (false, Some(q)) => format!("{rest}?{q}"),
        (false, None) => rest.into(),
    };
    let Some(host) = b.hosts.lock().unwrap().get(&name).cloned() else {
        return fail(&path, StatusCode::BAD_GATEWAY, &format!("host {name} isn't connected to the broker"));
    };
    forward(host, path, req).await
}

/// Any other path: on the host the request picks (see the module's comment).
async fn picked(State(b): State<Arc<Broker>>, req: Request) -> Response {
    let path = req.uri().path_and_query().map(|p| p.to_string()).unwrap_or_else(|| "/".into());
    let wanted = req
        .headers()
        .get(HOST_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(String::from)
        .or_else(|| cookie(req.headers(), COOKIE))
        .or_else(|| b.cfg.default_host.clone());
    let host = {
        let hosts = b.hosts.lock().unwrap();
        match &wanted {
            Some(name) => hosts.get(name).cloned().ok_or_else(|| format!("host {name} isn't connected to the broker")),
            None if hosts.len() == 1 => Ok(hosts.values().next().unwrap().clone()),
            None if hosts.is_empty() => Err("no host is connected to the broker".into()),
            None => Err("several hosts are connected to the broker: open /_broker/use/<name> to pick one".into()),
        }
    };
    match host {
        Ok(h) => forward(h, path, req).await,
        Err(e) => fail(req.uri().path(), StatusCode::BAD_GATEWAY, &e),
    }
}

fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .find_map(|kv| kv.trim().strip_prefix(name)?.strip_prefix('=').map(String::from))
        .filter(|v| proto::valid_name(v))
}

/// An error the broker answers itself: JSON for the API (which the board reads errors from), text
/// for anything else.
fn fail(path: &str, status: StatusCode, msg: &str) -> Response {
    if path.starts_with("/api/") || path == "/api" {
        (status, Json(json!({"error": msg}))).into_response()
    } else {
        (status, format!("{msg}\n")).into_response()
    }
}

fn is_websocket(req: &Request) -> bool {
    req.headers().get(header::UPGRADE).and_then(|v| v.to_str().ok()).is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
}

/// Pass a request to `host` and its answer back.
async fn forward(host: Arc<Host>, path: String, req: Request) -> Response {
    let ws = is_websocket(&req);
    let (mut parts, body) = req.into_parts();
    let upgrade = if ws {
        match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
            Ok(u) => Some(u),
            Err(e) => return e.into_response(),
        }
    } else {
        None
    };
    let headers: Vec<(String, String)> = parts
        .headers
        .iter()
        .filter(|(k, _)| !proto::hop_by_hop(k.as_str()) && *k != HOST_HEADER)
        .filter_map(|(k, v)| Some((k.to_string(), v.to_str().ok()?.to_string())))
        .collect();
    let has_body = !ws && !body.is_end_stream();
    let (mut stream, mut rx) = host.open();
    let id = stream.id;
    if !host.send(&Ctl::Req { id, method: parts.method.to_string(), path: path.clone(), headers, body: has_body, ws }) {
        stream.done = true;
        return fail(&path, StatusCode::BAD_GATEWAY, &format!("host {} disconnected", host.name));
    }
    if has_body {
        let host = host.clone();
        tokio::spawn(async move {
            let mut body = body.into_data_stream();
            while let Some(chunk) = body.next().await {
                match chunk {
                    Ok(c) => {
                        if !host.send_data(id, proto::DATA, &c) {
                            return;
                        }
                    }
                    // The response (if any) says what the host made of it; the stream's guard tells it to stop.
                    Err(_) => return,
                }
            }
            host.send(&Ctl::End { id });
        });
    }
    let (status, headers) = match tokio::time::timeout(HEAD_TIMEOUT, rx.recv()).await {
        Ok(Some(Event::Head(status, headers))) => (status, headers),
        Ok(Some(Event::Close(_, reason))) => {
            stream.done = true;
            return fail(&path, StatusCode::BAD_GATEWAY, &reason.unwrap_or_else(|| "the host dropped the request".into()));
        }
        Ok(_) => return fail(&path, StatusCode::BAD_GATEWAY, &format!("host {} disconnected", host.name)),
        Err(_) => return fail(&path, StatusCode::GATEWAY_TIMEOUT, &format!("host {} didn't answer in time", host.name)),
    };
    if let (Some(upgrade), 101) = (upgrade, status) {
        return upgrade.on_upgrade(move |socket| bridge(socket, stream, rx)).into_response();
    }
    let mut res = Response::new(Body::from_stream(body_stream(stream, rx)));
    *res.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
    for (k, v) in headers {
        if proto::hop_by_hop(&k) {
            continue;
        }
        if let (Ok(k), Ok(v)) = (HeaderName::try_from(k), HeaderValue::try_from(v)) {
            res.headers_mut().append(k, v);
        }
    }
    res
}

/// A response body from what the host sends, until `End`. A stream the host drops ends in an
/// error, so the client sees an incomplete response rather than a short one.
fn body_stream(stream: Stream, rx: mpsc::UnboundedReceiver<Event>) -> impl futures::Stream<Item = std::io::Result<Bytes>> {
    futures::stream::unfold(Some((stream, rx)), |state| async move {
        let (mut stream, mut rx) = state?;
        loop {
            match rx.recv().await {
                Some(Event::Data(b)) => return Some((Ok(b), Some((stream, rx)))),
                Some(Event::End) => {
                    stream.done = true;
                    return None;
                }
                Some(Event::Head(..) | Event::Text(_)) => continue,
                Some(Event::Close(..)) | None => {
                    stream.done = true;
                    return Some((Err(std::io::Error::other("the host dropped the response")), None));
                }
            }
        }
    })
}

/// Relay a client's websocket to the host's until either side closes it.
async fn bridge(mut socket: WebSocket, mut stream: Stream, mut rx: mpsc::UnboundedReceiver<Event>) {
    let (host, id) = (stream.host.clone(), stream.id);
    loop {
        tokio::select! {
            m = socket.recv() => {
                let sent = match m {
                    Some(Ok(Message::Text(t))) => host.send_data(id, proto::TEXT, t.as_bytes()),
                    Some(Ok(Message::Binary(b))) => host.send_data(id, proto::DATA, &b),
                    Some(Ok(Message::Close(c))) => {
                        stream.done = true;
                        host.send(&Ctl::Close { id, code: c.as_ref().map(|c| c.code), reason: c.map(|c| c.reason.to_string()) });
                        return;
                    }
                    Some(Ok(_)) => true,
                    None | Some(Err(_)) => return,
                };
                if !sent {
                    break;
                }
            }
            ev = rx.recv() => {
                let msg = match ev {
                    Some(Event::Data(b)) => Message::Binary(b),
                    Some(Event::Text(t)) => Message::Text(t.into()),
                    Some(Event::Close(code, reason)) => {
                        stream.done = true;
                        let frame = code.map(|code| CloseFrame { code, reason: reason.unwrap_or_default().into() });
                        let _ = socket.send(Message::Close(frame)).await;
                        return;
                    }
                    Some(_) => continue,
                    None => break,
                };
                if socket.send(msg).await.is_err() {
                    return;
                }
            }
        }
    }
    let _ = socket.send(Message::Close(Some(CloseFrame { code: 1011, reason: "host disconnected".into() }))).await;
}
