//! The hub side of a node: one board over this host and any linked hosts.
//!
//! Every host keeps its own database; nothing about another host is stored here beyond how
//! to reach it. The UI addresses a host as `/api/h/<host_id>/...`, which runs against this
//! node's own API (for the local host) or is relayed over a link:
//!
//! * outbound: we call the host's URL with its token, and follow its `/api/host/ws` events;
//! * inbound: the host dials `/api/hub/connect` (`serve --hub`), and requests are tunnelled
//!   back over that websocket.
//!
//! Events from every host reach the UI on `/api/ws`, tagged with `host_id`.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use axum::body::Body;
use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts, Path, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message as TMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tower::ServiceExt;

use crate::db::{self, Link};
use crate::hosts::proto::{API_COMPAT, API_VERSION, BUILD_ID, Down, PROTOCOL, ToolAnswer, ToolCall, Up};
use crate::hosts::relay::{self, Frame, PING, Pipe, SILENCE};
use crate::state::{ApiError, ApiResult, Shared};

mod inbound;
mod dial_out;
mod endpoints;
mod manage;

pub use inbound::*;
pub use dial_out::*;
pub use endpoints::*;
pub use manage::*;

/// A live connection to a linked host.
pub struct LinkConn {
    pub id: String,
    pub name: String,
    pub mode: String,
    /// What the host reported; 0 for builds that predate API versioning.
    pub version: Mutex<Version>,
    /// When we last heard anything from the host (a pong counts), in Unix milliseconds.
    heard: AtomicI64,
    kind: Kind,
}

#[derive(Clone, Default, serde::Serialize)]
pub struct Version {
    pub version: String,
    pub api_version: u32,
    pub api_compat: u32,
    /// Commit the host is running, if it runs from a checkout.
    pub commit: Option<String>,
    /// Whether it can run agents (hosts that don't say are assumed to).
    pub agents: bool,
    /// How an Update reaches it (API 89): `checkout` or `releases`, or none.
    pub updates_from: Option<String>,
}

impl Version {
    fn from_info(info: &Value) -> Self {
        Version {
            version: info["version"].as_str().unwrap_or("").into(),
            api_version: info["api_version"].as_u64().unwrap_or(0) as u32,
            api_compat: info["api_compat"].as_u64().unwrap_or(0) as u32,
            commit: info["commit"].as_str().map(String::from),
            agents: info["agents"].as_bool().unwrap_or(true),
            updates_from: info["updates_from"].as_str().map(String::from),
        }
    }
}

enum Kind {
    /// With a client of its own, so its connections go with it: a connection that died without
    /// closing would otherwise be kept for the next one, and hold up its requests.
    Http { url: String, token: String, client: reqwest::Client },
    Tunnel {
        tx: mpsc::UnboundedSender<Down>,
        pending: Mutex<HashMap<u64, oneshot::Sender<(u16, Value)>>>,
        /// Websockets relayed over the tunnel, by id.
        streams: Mutex<HashMap<u64, mpsc::UnboundedSender<Frame>>>,
        next: AtomicU64,
    },
}

pub type LinkHandle = Arc<LinkConn>;

pub(crate) fn http() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// A client for one connection to a host. TCP keepalive is a backstop for the pings on its events.
fn link_client() -> reqwest::Client {
    reqwest::Client::builder()
        .tcp_keepalive(PING)
        .tcp_keepalive_interval(PING)
        .tcp_keepalive_retries(3)
        .build()
        .unwrap_or_default()
}

impl LinkConn {
    fn new(id: &str, name: &str, mode: &str, version: Version, kind: Kind) -> Self {
        let heard = AtomicI64::new(chrono::Utc::now().timestamp_millis());
        LinkConn { id: id.into(), name: name.into(), mode: mode.into(), version: Mutex::new(version), heard, kind }
    }

    fn heard(&self) {
        self.heard.store(chrono::Utc::now().timestamp_millis(), Ordering::Relaxed);
    }

    /// When we last heard from the host, as `util::now` formats it.
    pub fn last_message_at(&self) -> String {
        let at = chrono::DateTime::from_timestamp_millis(self.heard.load(Ordering::Relaxed)).unwrap_or_default();
        at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    /// Call the host's API. `path` starts with `/api/` and may carry a query string.
    ///
    /// The host turning down the link's token (its own changed since it was linked: its data dir was made again, say) is
    /// a 502, not its 401, which the UI takes to mean the board's own token is wrong.
    pub async fn request(&self, method: &str, path: &str, body: Option<Value>) -> Result<(u16, Value)> {
        Ok(match self.send(method, path, body).await? {
            (401, _) => (502, json!({"error": format!("host {} didn't accept this hub's token for it; link it again", self.name)})),
            r => r,
        })
    }

    async fn send(&self, method: &str, path: &str, body: Option<Value>) -> Result<(u16, Value)> {
        match &self.kind {
            Kind::Http { url, token, client } => {
                let m = reqwest::Method::from_bytes(method.as_bytes())?;
                let mut req = client.request(m, format!("{}{path}", url.trim_end_matches('/'))).bearer_auth(token).timeout(Duration::from_secs(300));
                if let Some(b) = body {
                    req = req.json(&b);
                }
                let res = req.send().await.with_context(|| format!("host {} unreachable", self.name))?;
                // The API only answers in JSON: a page is an older host's UI, served for a route it doesn't have.
                if is_html(&res) {
                    return Ok((404, crate::api::no_route_error(method, path)));
                }
                let status = res.status().as_u16();
                let text = res.text().await?;
                // An older host's UI also answers a route it doesn't have with an empty 405 for methods other than GET,
                // the same as the API does for a route without this method. The UI's page for a HEAD tells them apart.
                if status == 405 && text.is_empty() {
                    let head = client.head(format!("{}{path}", url.trim_end_matches('/'))).bearer_auth(token).timeout(Duration::from_secs(30));
                    if head.send().await.is_ok_and(|r| is_html(&r)) {
                        return Ok((404, crate::api::no_route_error(method, path)));
                    }
                }
                Ok((status, serde_json::from_str(&text).unwrap_or(Value::String(text))))
            }
            Kind::Tunnel { tx, pending, next, .. } => {
                let id = next.fetch_add(1, Ordering::Relaxed);
                let (rtx, rrx) = oneshot::channel();
                pending.lock().unwrap().insert(id, rtx);
                tx.send(Down::Req { id, method: method.into(), path: path.into(), body }).map_err(|_| anyhow!("host {} disconnected", self.name))?;
                match tokio::time::timeout(Duration::from_secs(300), rrx).await {
                    Ok(Ok(r)) => Ok(r),
                    Ok(Err(_)) => bail!("host {} disconnected", self.name),
                    Err(_) => {
                        pending.lock().unwrap().remove(&id);
                        bail!("host {} did not respond in time", self.name)
                    }
                }
            }
        }
    }
}

impl LinkConn {
    /// Open a websocket to `path` (starting with `/api/`) on the host.
    pub async fn open_ws(self: &Arc<Self>, path: &str) -> Result<Pipe> {
        match &self.kind {
            Kind::Http { url, token, .. } => {
                let url = format!("{}{path}", url.trim_end_matches('/').replacen("http", "ws", 1));
                relay::connect(&url, token).await.with_context(|| format!("host {} unreachable", self.name))
            }
            Kind::Tunnel { tx, streams, next, .. } => {
                let id = next.fetch_add(1, Ordering::Relaxed);
                let (in_tx, in_rx) = mpsc::unbounded_channel();
                streams.lock().unwrap().insert(id, in_tx);
                tx.send(Down::WsOpen { id, path: path.into() }).map_err(|_| anyhow!("host {} disconnected", self.name))?;
                let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Frame>();
                let conn = self.clone();
                tokio::spawn(async move {
                    let Kind::Tunnel { tx, streams, .. } = &conn.kind else { return };
                    while let Some(f) = out_rx.recv().await {
                        if matches!(f, Frame::Close(_)) {
                            break;
                        }
                        let (text, data) = f.to_wire();
                        if tx.send(Down::WsMsg { id, text, data }).is_err() {
                            break;
                        }
                    }
                    let _ = tx.send(Down::WsClose { id });
                    streams.lock().unwrap().remove(&id);
                });
                Ok((out_tx, in_rx))
            }
        }
    }
}

fn is_html(res: &reqwest::Response) -> bool {
    res.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|v| v.starts_with("text/html"))
}

pub fn connected_links(s: &Shared) -> Vec<LinkHandle> {
    s.links.lock().unwrap().values().cloned().collect()
}

/// A connected link by id or (case-insensitive) name.
pub fn find_link(s: &Shared, id_or_name: &str) -> Option<LinkHandle> {
    let links = s.links.lock().unwrap();
    links.get(id_or_name).cloned().or_else(|| links.values().find(|l| l.name.eq_ignore_ascii_case(id_or_name)).cloned())
}

/// Run a board tool on a linked host (see `tools::handle_remote`).
pub async fn call_tool(_s: &Shared, link: &LinkConn, tool: &str, profile: &str, args: &Value, task_fields: bool) -> std::result::Result<Value, String> {
    let mut args = args.clone();
    if let Some(o) = args.as_object_mut() {
        o.remove("host");
    }
    match link.request("POST", &format!("/api/tools/{tool}"), Some(json!({"profile": profile, "args": args, "task_fields": task_fields}))).await {
        Ok((200, body)) => Ok(body["result"].clone()),
        Ok((_, body)) => Err(body["error"].as_str().map(String::from).unwrap_or_else(|| body.to_string())),
        Err(e) => Err(format!("{e:#}")),
    }
}

/// A board tool call that linked host `host_id` passed up its link (see hosts/uplink.rs): run only if
/// the user lets that host's agents use this board.
pub async fn run_up_call(s: &Shared, host_id: &str, c: ToolCall) -> ToolAnswer {
    let allowed = db::get_link(&s.db(), host_id).ok().flatten().is_some_and(|l| l.uplink);
    if !allowed {
        return ToolAnswer { id: c.id, result: None, error: None, off: true };
    }
    match crate::mcp::tools::handle_up_call(s, host_id, &c).await {
        Ok(v) => ToolAnswer { id: c.id, result: Some(v), error: None, off: false },
        Err(e) => ToolAnswer { id: c.id, result: None, error: Some(e), off: false },
    }
}

fn changed(s: &Shared) {
    let _ = s.hub_events.send(json!({"type": "hosts_changed"}));
}

/// A link counted as connected, until this is dropped: however its loop ends, by an error or by an
/// abort when the link is added again or removed.
struct Registered {
    s: Shared,
    conn: LinkHandle,
}

impl Drop for Registered {
    fn drop(&mut self) {
        let (s, conn) = (&self.s, &self.conn);
        let mut links = s.links.lock().unwrap();
        if links.get(&conn.id).is_some_and(|c| Arc::ptr_eq(c, conn)) {
            links.remove(&conn.id);
        }
        drop(links);
        // Last seen when we last heard from it, which for a connection that died without closing is
        // a while before we gave up on it.
        let _ = s.db().execute("UPDATE links SET last_seen=?1 WHERE id=?2", rusqlite::params![conn.last_message_at(), conn.id]);
        changed(s);
    }
}

/// Count `conn` as connected, in place of any other connection to its host, except that a host
/// that dials in while it's already connected in is refused (two hosts with the same id would
/// otherwise take each other's place for as long as both run).
fn register(s: &Shared, conn: LinkHandle) -> Option<Registered> {
    let mut links = s.links.lock().unwrap();
    let tunnel = |c: &LinkConn| matches!(c.kind, Kind::Tunnel { .. });
    if tunnel(&conn) && links.get(&conn.id).is_some_and(|c| tunnel(c)) {
        return None;
    }
    links.insert(conn.id.clone(), conn.clone());
    drop(links);
    changed(s);
    Some(Registered { s: s.clone(), conn })
}

fn forward_event(s: &Shared, host_id: &str, mut ev: Value) {
    if let Some(o) = ev.as_object_mut() {
        o.insert("host_id".into(), json!(host_id));
    }
    let _ = s.hub_events.send(ev);
}

// ---------- startup ----------

/// Relay this host's own events to the UI stream, and connect outbound links.
pub fn start(s: &Shared) -> Result<()> {
    let st = s.clone();
    tokio::spawn(async move {
        let mut rx = st.events.subscribe();
        loop {
            match rx.recv().await {
                Ok(ev) => forward_event(&st, &st.host_id, ev),
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    let _ = st.hub_events.send(json!({"type": "resync", "host_id": st.host_id}));
                }
                Err(_) => break,
            }
        }
    });
    for link in db::list_links(&s.db())?.into_iter().filter(|l| l.mode == "outbound" || l.mode == "ssh") {
        spawn_outbound(s, link);
    }
    Ok(())
}

fn spawn_outbound(s: &Shared, link: Link) {
    let st = s.clone();
    let id = link.id.clone();
    if link.mode == "ssh" {
        let task = tokio::spawn(crate::hosts::ssh::run(st, link));
        if let Some(old) = s.link_tasks.lock().unwrap().insert(id, task) {
            old.abort();
        }
        return;
    }
    let task = tokio::spawn(async move {
        let mut backoff = 1;
        loop {
            match run_outbound(&st, &link, "outbound").await {
                Ok(()) => backoff = 1,
                Err(e) => tracing::debug!("link {}: {e:#}", link.name),
            }
            tokio::time::sleep(Duration::from_secs(backoff)).await;
            backoff = (backoff * 2).min(30);
        }
    });
    if let Some(old) = s.link_tasks.lock().unwrap().insert(id, task) {
        old.abort();
    }
}

/// Follow an outbound link's events; the link counts as connected while this is up.
pub async fn run_outbound(s: &Shared, link: &Link, mode: &str) -> Result<()> {
    let token = link.token.clone().context("link has no token")?;
    let url = crate::hosts::broker::resolve(link.url.as_deref().context("link has no url")?, Some(&link.id)).await?;
    // The token goes in a header rather than the URL, which proxies and brokers on the way log.
    let ws_url = format!("{}/api/host/ws", url.trim_end_matches('/').replacen("http", "ws", 1));
    let mut ws_req = ws_url.into_client_request()?;
    ws_req.headers_mut().insert("Authorization", format!("Bearer {token}").parse()?);
    let ws = relay::open(ws_req).await?;
    let conn = LinkConn::new(&link.id, &link.name, mode, Version::default(), Kind::Http { url, token, client: link_client() });
    if let Ok((200, info)) = conn.request("GET", "/api/info", None).await {
        *conn.version.lock().unwrap() = Version::from_info(&info);
    }
    let conn = Arc::new(conn);
    let _registered = register(s, conn.clone());
    tracing::info!("connected to host {}", link.name);
    let (mut sink, mut stream) = ws.split();
    // Who we are, so the host can pass its agents' board tool calls up (hosts before API 98 ignore it).
    sink.send(TMessage::Text(crate::hosts::uplink::hub_hello(s).to_string().into())).await?;
    let (answers_tx, mut answers) = mpsc::unbounded_channel::<ToolAnswer>();
    // Anything missed while disconnected: tell the UI to reload this host.
    forward_event(s, &link.id, json!({"type": "resync"}));
    // Hosts answer websocket pings whatever their version, which keeps the events coming or ends the link.
    let mut ping = tokio::time::interval(PING);
    let quiet = tokio::time::sleep(SILENCE);
    tokio::pin!(quiet);
    loop {
        tokio::select! {
            msg = stream.next() => {
                conn.heard();
                quiet.as_mut().reset(tokio::time::Instant::now() + SILENCE);
                match msg {
                    Some(Ok(TMessage::Text(t))) => match serde_json::from_str::<Value>(&t) {
                        Ok(v) if v["type"] == "hub_call" => {
                            if let Ok(c) = serde_json::from_value::<ToolCall>(v) {
                                let (s, id, tx) = (s.clone(), link.id.clone(), answers_tx.clone());
                                tokio::spawn(async move {
                                    let _ = tx.send(run_up_call(&s, &id, c).await);
                                });
                            }
                        }
                        Ok(ev) => forward_event(s, &link.id, ev),
                        Err(_) => {}
                    },
                    Some(Ok(TMessage::Close(_)) | Err(_)) | None => break,
                    _ => {}
                }
            }
            Some(a) = answers.recv() => {
                if sink.send(TMessage::Text(crate::hosts::uplink::answer_frame(&a).to_string().into())).await.is_err() {
                    break;
                }
            }
            _ = ping.tick() => {
                if sink.send(TMessage::Ping(Default::default())).await.is_err() {
                    break;
                }
            }
            _ = &mut quiet => {
                tracing::info!("nothing from host {} for {}s", link.name, SILENCE.as_secs());
                break;
            }
        }
    }
    tracing::info!("lost host {}", link.name);
    Ok(())
}

/// Links `s` over HTTP to a host served by `app`, which reports API `api_version`.
#[cfg(test)]
pub(crate) async fn link_http(s: &Shared, id: &str, app: Router, api_version: u32) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await });
    let kind = Kind::Http { url, token: String::new(), client: link_client() };
    let conn = LinkConn::new(id, id, "http", Version { api_version, ..Default::default() }, kind);
    s.links.lock().unwrap().insert(id.into(), Arc::new(conn));
}

#[cfg(test)]
mod tests;
