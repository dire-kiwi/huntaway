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
use crate::relay::{self, Frame, PING, Pipe, SILENCE};
use crate::proto::{API_COMPAT, API_VERSION, BUILD_ID, Down, PROTOCOL, Up};
use crate::state::{ApiError, ApiResult, Shared};

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
}

impl Version {
    fn from_info(info: &Value) -> Self {
        Version {
            version: info["version"].as_str().unwrap_or("").into(),
            api_version: info["api_version"].as_u64().unwrap_or(0) as u32,
            api_compat: info["api_compat"].as_u64().unwrap_or(0) as u32,
            commit: info["commit"].as_str().map(String::from),
            agents: info["agents"].as_bool().unwrap_or(true),
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
        let task = tokio::spawn(crate::ssh::run(st, link));
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
    let url = crate::broker::resolve(link.url.as_deref().context("link has no url")?, Some(&link.id)).await?;
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
                    Some(Ok(TMessage::Text(t))) => {
                        if let Ok(ev) = serde_json::from_str::<Value>(&t) {
                            forward_event(s, &link.id, ev);
                        }
                    }
                    Some(Ok(TMessage::Close(_)) | Err(_)) | None => break,
                    _ => {}
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

// ---------- inbound tunnel (hosts started with --hub) ----------

/// The close code a hub refuses a host's tunnel with (a policy violation).
const REFUSED: u16 = 1008;

pub async fn accept(State(s): State<Shared>, headers: HeaderMap, upgrade: WebSocketUpgrade) -> Response {
    let token = headers.get("authorization").and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer "));
    if !token.is_some_and(|t| crate::util::same_secret(t, &s.hub_token)) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    upgrade.on_upgrade(move |ws| async move {
        if let Err(e) = serve_tunnel(s, ws).await {
            tracing::warn!("hosted tunnel ended: {e:#}");
        }
    })
}

async fn serve_tunnel(s: Shared, ws: WebSocket) -> Result<()> {
    let (mut sink, mut stream) = ws.split();
    let hello = tokio::time::timeout(Duration::from_secs(10), stream.next()).await.context("no hello")?;
    let (host_id, name, version) = match hello {
        Some(Ok(WsMessage::Text(t))) => match serde_json::from_str::<Up>(&t)? {
            Up::Hello { host_id, name, protocol, version, api_version, api_compat } if protocol == PROTOCOL => {
                (host_id, name, Version { version, api_version, api_compat, commit: None, agents: true })
            }
            Up::Hello { protocol, .. } => bail!("host speaks protocol {protocol}, we speak {PROTOCOL}"),
            _ => bail!("expected hello"),
        },
        _ => bail!("expected hello"),
    };
    if host_id == s.host_id {
        bail!("a host can't link to itself");
    }
    let (tx, mut rx) = mpsc::unbounded_channel::<Down>();
    let kind = Kind::Tunnel { tx, pending: Mutex::new(HashMap::new()), streams: Mutex::new(HashMap::new()), next: AtomicU64::new(1) };
    let conn = Arc::new(LinkConn::new(&host_id, &name, "inbound", version, kind));
    let Some(_registered) = register(&s, conn.clone()) else {
        let reason = format!("host {host_id} is already connected to this hub");
        let _ = sink.send(WsMessage::Close(Some(axum::extract::ws::CloseFrame { code: REFUSED, reason: reason.clone().into() }))).await;
        bail!("{name}: {reason}");
    };
    db::note_inbound_link(&s.db(), &host_id, &name)?;
    let writer = tokio::spawn(async move {
        let mut ping = tokio::time::interval(PING);
        loop {
            let msgs = tokio::select! {
                msg = rx.recv() => match msg {
                    Some(msg) => vec![WsMessage::Text(serde_json::to_string(&msg).unwrap_or_default().into())],
                    None => break,
                },
                // A websocket ping for hosts from before `Down::Ping`, which answer it whatever their
                // version; `Down::Ping` for the others, which gets through a broker.
                _ = ping.tick() => vec![WsMessage::Ping(Default::default()), WsMessage::Text(serde_json::to_string(&Down::Ping).unwrap_or_default().into())],
            };
            for msg in msgs {
                if sink.send(msg).await.is_err() {
                    return;
                }
            }
        }
    });
    forward_event(&s, &host_id, json!({"type": "resync"}));
    tracing::info!("host {name} connected in");
    // The hello doesn't carry the commit; ask once the tunnel is up.
    {
        let (s, conn) = (s.clone(), conn.clone());
        tokio::spawn(async move {
            if let Ok((200, info)) = conn.request("GET", "/api/info", None).await {
                *conn.version.lock().unwrap() = Version::from_info(&info);
                changed(&s);
            }
        });
    }
    // A websocket pong needn't come from the host: through a broker, it's our own relay to the broker that
    // answers our pings. So once the host has answered a `Down::Ping`, only its messages count.
    let mut answers_pings = false;
    let mut deadline = tokio::time::Instant::now() + SILENCE;
    loop {
        let msg = match tokio::time::timeout_at(deadline, stream.next()).await {
            Ok(msg) => msg,
            Err(_) => {
                tracing::info!("nothing from host {name} for {}s", SILENCE.as_secs());
                break;
            }
        };
        let text = match msg {
            Some(Ok(WsMessage::Text(t))) => Some(t.to_string()),
            Some(Ok(WsMessage::Close(_)) | Err(_)) | None => break,
            _ => None,
        };
        if text.is_some() || !answers_pings {
            conn.heard();
            deadline = tokio::time::Instant::now() + SILENCE;
        }
        let Some(text) = text else { continue };
        match serde_json::from_str::<Up>(&text) {
            Ok(Up::Res { id, status, body }) => {
                if let Kind::Tunnel { pending, .. } = &conn.kind {
                    if let Some(w) = pending.lock().unwrap().remove(&id) {
                        let _ = w.send((status, body));
                    }
                }
            }
            Ok(Up::Event { event }) => forward_event(&s, &host_id, event),
            Ok(Up::WsMsg { id, text, data }) => {
                if let (Kind::Tunnel { streams, .. }, Some(f)) = (&conn.kind, Frame::from_wire(text, data)) {
                    if let Some(w) = streams.lock().unwrap().get(&id) {
                        let _ = w.send(f);
                    }
                }
            }
            Ok(Up::WsClose { id, code, reason }) => {
                if let Kind::Tunnel { streams, .. } = &conn.kind {
                    if let Some(w) = streams.lock().unwrap().remove(&id) {
                        let _ = w.send(Frame::Close(code.map(|c| (c, reason.unwrap_or_default()))));
                    }
                }
            }
            Ok(Up::Pong) => answers_pings = true,
            Ok(Up::Hello { .. }) => {}
            Err(e) => tracing::warn!("bad tunnel message from {name}: {e}"),
        }
    }
    writer.abort();
    // Requests and websockets in flight hold the connection, so they'd wait for answers that won't come.
    if let Kind::Tunnel { pending, streams, .. } = &conn.kind {
        pending.lock().unwrap().clear();
        streams.lock().unwrap().clear();
    }
    tracing::info!("host {name} disconnected");
    Ok(())
}

// ---------- dial-out (this node is a host of someone else's hub) ----------

/// Keep a tunnel open to `hub`, answering its requests from our own API.
pub fn dial_out(s: &Shared, hub: String, token: String) {
    let s = s.clone();
    tokio::spawn(async move {
        let mut backoff = 1;
        loop {
            match tunnel_to(&s, &hub, &token).await {
                Ok(()) => backoff = 1,
                Err(e) => tracing::warn!("hub {hub}: {e:#}"),
            }
            tokio::time::sleep(Duration::from_secs(backoff)).await;
            backoff = (backoff * 2).min(30);
        }
    });
}

async fn tunnel_to(s: &Shared, hub: &str, token: &str) -> Result<()> {
    let hub = crate::broker::resolve(hub, None).await?;
    let url = format!("{}/api/hub/connect", hub.trim_end_matches('/').replacen("http", "ws", 1));
    let mut req = url.into_client_request()?;
    req.headers_mut().insert("Authorization", format!("Bearer {token}").parse()?);
    let (mut sink, mut stream) = relay::open(req).await?.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Up>();
    tx.send(Up::Hello {
        host_id: s.host_id.clone(),
        name: s.host_name.clone(),
        version: env!("CARGO_PKG_VERSION").into(),
        protocol: PROTOCOL,
        api_version: API_VERSION,
        api_compat: API_COMPAT,
    })?;
    // Websocket pings rather than a message of the tunnel's own, which hubs from before `Down::Ping`
    // would log as bad. Through a broker that answers them, we hear from the hub by its `Down::Ping`.
    let writer = tokio::spawn(async move {
        let mut ping = tokio::time::interval(PING);
        loop {
            let msg = tokio::select! {
                msg = rx.recv() => match msg {
                    Some(msg) => TMessage::Text(serde_json::to_string(&msg).unwrap_or_default().into()),
                    None => break,
                },
                _ = ping.tick() => TMessage::Ping(Default::default()),
            };
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });
    let events = {
        let (s, tx) = (s.clone(), tx.clone());
        tokio::spawn(async move {
            let mut ev = s.events.subscribe();
            loop {
                match ev.recv().await {
                    Ok(event) => {
                        if tx.send(Up::Event { event }).is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        let _ = tx.send(Up::Event { event: json!({"type": "resync"}) });
                    }
                    Err(_) => break,
                }
            }
        })
    };
    tracing::info!("connected to hub {hub}");
    let streams: HubStreams = Arc::default();
    let result = async {
        loop {
            let text = match tokio::time::timeout(SILENCE, stream.next()).await {
                Err(_) => bail!("nothing from the hub for {}s", SILENCE.as_secs()),
                Ok(None) => return Ok(()),
                Ok(Some(msg)) => match msg? {
                    TMessage::Text(t) => t.to_string(),
                    TMessage::Close(Some(f)) if u16::from(f.code) == REFUSED => bail!("refused: {}", f.reason),
                    TMessage::Close(_) => return Ok(()),
                    _ => continue,
                },
            };
            tunnel_message(s, &text, &tx, &streams);
        }
    }
    .await;
    // Dropping the senders closes the relayed websockets.
    streams.lock().unwrap().clear();
    events.abort();
    writer.abort();
    result
}

/// Websockets the hub opened on our API, by id.
type HubStreams = Arc<Mutex<HashMap<u64, mpsc::UnboundedSender<Frame>>>>;

/// Act on a message from the hub.
fn tunnel_message(s: &Shared, text: &str, tx: &mpsc::UnboundedSender<Up>, streams: &HubStreams) {
    match serde_json::from_str::<Down>(text) {
        Ok(Down::Req { id, method, path, body }) => {
            let (s, tx) = (s.clone(), tx.clone());
            tokio::spawn(async move {
                let (status, body) = match local_request(&s, &method, &path, body.map(|b| b.to_string().into_bytes())).await {
                    Ok(r) => r,
                    Err(e) => (500, json!({"error": format!("{e:#}")})),
                };
                let _ = tx.send(Up::Res { id, status, body });
            });
        }
        Ok(Down::WsOpen { id, path }) => {
            // Registered right away: the hub's first messages can arrive while we connect.
            let (hub_tx, hub_rx) = mpsc::unbounded_channel();
            streams.lock().unwrap().insert(id, hub_tx);
            let (s, tx, streams) = (s.clone(), tx.clone(), streams.clone());
            tokio::spawn(async move {
                relay_local(&s, id, &path, hub_rx, &tx).await;
                streams.lock().unwrap().remove(&id);
            });
        }
        Ok(Down::WsMsg { id, text, data }) => {
            if let (Some(w), Some(f)) = (streams.lock().unwrap().get(&id), Frame::from_wire(text, data)) {
                let _ = w.send(f);
            }
        }
        Ok(Down::WsClose { id }) => {
            if let Some(w) = streams.lock().unwrap().remove(&id) {
                let _ = w.send(Frame::Close(None));
            }
        }
        Ok(Down::Ping) => {
            let _ = tx.send(Up::Pong);
        }
        Err(_) => {}
    }
}

/// Open a websocket on our own API for the hub and relay it until either side closes.
async fn relay_local(s: &Shared, id: u64, path: &str, mut from_hub: mpsc::UnboundedReceiver<Frame>, to_hub: &mpsc::UnboundedSender<Up>) {
    let url = format!("{}{path}", s.internal_url.replacen("http", "ws", 1));
    let (local_tx, mut local_rx) = match relay::connect(&url, &s.token).await {
        Ok(p) => p,
        Err(e) => {
            let _ = to_hub.send(Up::WsClose { id, code: Some(1011), reason: Some(format!("{e:#}")) });
            return;
        }
    };
    loop {
        tokio::select! {
            f = from_hub.recv() => {
                let f = f.unwrap_or(Frame::Close(None));
                let close = matches!(f, Frame::Close(_));
                if local_tx.send(f).is_err() || close {
                    break;
                }
            }
            f = local_rx.recv() => match f.unwrap_or(Frame::Close(None)) {
                Frame::Close(c) => {
                    let (code, reason) = c.unzip();
                    let _ = to_hub.send(Up::WsClose { id, code, reason });
                    break;
                }
                f => {
                    let (text, data) = f.to_wire();
                    if to_hub.send(Up::WsMsg { id, text, data }).is_err() {
                        break;
                    }
                }
            },
        }
    }
}

/// Run a request against this node's own host API (as an authenticated caller).
async fn local_request(s: &Shared, method: &str, path: &str, body: Option<Vec<u8>>) -> Result<(u16, Value)> {
    let router: Router = s.local_router.get().context("router not ready")?.clone();
    let mut req = axum::http::Request::builder()
        .method(method)
        .uri(path)
        .header("authorization", format!("Bearer {}", s.token))
        .header("content-type", "application/json")
        .body(Body::from(body.unwrap_or_default()))?;
    req.extensions_mut().insert(axum::extract::ConnectInfo(std::net::SocketAddr::from(([127, 0, 0, 1], 0))));
    let res = router.oneshot(req).await?;
    let status = res.status().as_u16();
    let bytes = axum::body::to_bytes(res.into_body(), 64 << 20).await?;
    let text = String::from_utf8_lossy(&bytes).to_string();
    Ok((status, serde_json::from_str(&text).unwrap_or(Value::String(text))))
}

// ---------- HTTP endpoints ----------

/// `/api/h/{host_id}/{*rest}`: the UI's way of talking to any host.
pub async fn proxy(State(s): State<Shared>, Path((host_id, rest)): Path<(String, String)>, req: Request) -> Response {
    if is_websocket(&req) {
        return proxy_ws(s, host_id, rest, req).await;
    }
    let method = req.method().as_str().to_string();
    let path = host_path(&rest, req.uri().query());
    let bytes = match axum::body::to_bytes(req.into_body(), 64 << 20).await {
        Ok(b) => b,
        Err(e) => return (StatusCode::BAD_REQUEST, Json(json!({"error": e.to_string()}))).into_response(),
    };
    // A task the user moves to another column doesn't push them a notification of it (see push.rs).
    if method == "PATCH"
        && let Some(id) = rest.strip_prefix("tasks/").filter(|id| !id.contains('/'))
        && let Some(status) = serde_json::from_slice::<Value>(&bytes).ok().and_then(|b| b["status"].as_str().map(String::from))
    {
        s.push.note_move(&host_id, id, &status);
    }
    let result = if host_id == s.host_id {
        local_request(&s, &method, &path, (!bytes.is_empty()).then(|| bytes.to_vec())).await
    } else {
        let Some(link) = s.links.lock().unwrap().get(&host_id).cloned() else {
            let name = db::get_link(&s.db(), &host_id).ok().flatten().map(|l| l.name).unwrap_or(host_id);
            return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error": format!("host {name} is offline")}))).into_response();
        };
        let body = (!bytes.is_empty()).then(|| serde_json::from_slice(&bytes).unwrap_or(Value::Null));
        link.request(&method, &path, body).await
    };
    match result {
        // Hosts from before the JSON 404 answer an unknown route (or method) with an empty 404 or 405.
        Ok((status @ (404 | 405), Value::String(_))) => {
            (StatusCode::from_u16(status).unwrap(), Json(crate::api::no_route_error(&method, &path))).into_response()
        }
        Ok((status, body)) => (StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY), Json(body)).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({"error": format!("{e:#}")}))).into_response(),
    }
}

/// The path a proxied request takes on its host. A client may authenticate to us with `?token=`;
/// that token is ours, not the host's, so it isn't passed on (a linked host gets the link's token).
fn host_path(rest: &str, query: Option<&str>) -> String {
    let query: Vec<&str> = query.unwrap_or("").split('&').filter(|kv| !kv.is_empty() && !kv.starts_with("token=")).collect();
    if query.is_empty() { format!("/api/{rest}") } else { format!("/api/{rest}?{}", query.join("&")) }
}

fn is_websocket(req: &Request) -> bool {
    req.headers().get(axum::http::header::UPGRADE).and_then(|v| v.to_str().ok()).is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
}

/// A websocket for a host (a terminal): handled by our own router for this host, relayed
/// to a linked one.
async fn proxy_ws(s: Shared, host_id: String, rest: String, req: Request) -> Response {
    let path = host_path(&rest, req.uri().query());
    let (mut parts, body) = req.into_parts();
    if host_id == s.host_id {
        let Some(router) = s.local_router.get().cloned() else {
            return (StatusCode::SERVICE_UNAVAILABLE, "router not ready").into_response();
        };
        // A fresh request (without this route's path parameters) that takes the upgrade
        // handle along, so the local handler can take the connection over.
        let mut local = Request::new(body);
        *local.method_mut() = parts.method;
        *local.headers_mut() = parts.headers;
        let Ok(uri) = path.parse() else { return (StatusCode::BAD_REQUEST, "bad path").into_response() };
        *local.uri_mut() = uri;
        local.headers_mut().insert(axum::http::header::AUTHORIZATION, format!("Bearer {}", s.token).parse().unwrap());
        if let Some(upgrade) = parts.extensions.remove::<hyper::upgrade::OnUpgrade>() {
            local.extensions_mut().insert(upgrade);
        }
        return router.oneshot(local).await.into_response();
    }
    let upgrade = match WebSocketUpgrade::from_request_parts(&mut parts, &s).await {
        Ok(u) => u,
        Err(e) => return e.into_response(),
    };
    let Some(link) = s.links.lock().unwrap().get(&host_id).cloned() else {
        return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error": "host is offline"}))).into_response();
    };
    match link.open_ws(&path).await {
        Ok(pipe) => upgrade.on_upgrade(move |ws| relay::bridge(ws, pipe)),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({"error": format!("{e:#}")}))).into_response(),
    }
}

/// This host plus every linked host, with live status.
pub async fn list_hosts(State(s): State<Shared>) -> ApiResult<Json<Value>> {
    let mut out = vec![json!({
        "id": s.host_id,
        "name": s.host_name,
        "local": true,
        "connected": true,
        "mode": "local",
        "version": env!("CARGO_PKG_VERSION"),
        "build_id": BUILD_ID,
        "api_version": API_VERSION,
        "api_compat": API_COMPAT,
        "commit": s.meta.running_commit,
        "agents": crate::runs::can_run_agents(&s),
    })];
    for l in db::list_links(&s.db())? {
        let live = s.links.lock().unwrap().get(&l.id).cloned();
        let mut v = serde_json::to_value(&l).unwrap();
        v["local"] = json!(false);
        v["connected"] = json!(live.as_ref().is_some_and(|link| s.push.link_ready(link)));
        if let Some(c) = live {
            v["mode"] = json!(c.mode);
            let ver = c.version.lock().unwrap().clone();
            v["version"] = json!(ver.version);
            v["api_version"] = json!(ver.api_version);
            v["api_compat"] = json!(ver.api_compat);
            v["commit"] = json!(ver.commit);
            v["agents"] = json!(ver.agents);
            // Pings keep this recent on a live link: a while ago means the link is about to be dropped.
            v["last_message_at"] = json!(c.last_message_at());
        }
        if let Some(t) = l.ssh.as_deref().and_then(|j| serde_json::from_str::<crate::ssh::Target>(j).ok()) {
            v["url"] = json!(format!("ssh://{}", t.target));
        }
        if let Some(o) = v.as_object_mut() {
            o.remove("ssh");
        }
        out.push(v);
    }
    Ok(Json(json!(out)))
}

#[derive(Deserialize)]
pub struct AddHost {
    url: String,
    token: String,
}

/// Link a host we can reach directly.
pub async fn add_host(State(s): State<Shared>, Json(b): Json<AddHost>) -> ApiResult<Json<Value>> {
    let url = b.url.trim().trim_end_matches('/').to_string();
    let endpoint = crate::broker::resolve(&url, None).await.map_err(|e| ApiError::bad(format!("can't resolve {url}: {e:#}")))?;
    let info: Value = http()
        .get(format!("{endpoint}/api/info"))
        .bearer_auth(b.token.trim())
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| ApiError::bad(format!("can't reach {url}: {e}")))?
        .error_for_status()
        .map_err(|e| ApiError::bad(format!("{url} refused the token: {e}")))?
        .json()
        .await
        .map_err(|e| ApiError::bad(format!("{url} isn't a Huntaway host: {e}")))?;
    let host_id = info["host_id"].as_str().ok_or_else(|| ApiError::bad(format!("{url} is too old to be linked (no host_id)")))?;
    if host_id == s.host_id {
        return Err(ApiError::bad("that's this host"));
    }
    let name = info["host_name"].as_str().unwrap_or(host_id);
    let link = db::upsert_link(&s.db(), host_id, name, "outbound", Some(&url), Some(b.token.trim()))?;
    spawn_outbound(&s, link.clone());
    changed(&s);
    Ok(Json(json!(link)))
}

#[derive(Deserialize)]
pub struct RenameHost {
    name: String,
}

pub async fn rename_host(State(s): State<Shared>, Path(id): Path<String>, Json(b): Json<RenameHost>) -> ApiResult<Json<Value>> {
    s.db().execute("UPDATE links SET name=?1 WHERE id=?2", rusqlite::params![b.name.trim(), id])?;
    changed(&s);
    Ok(Json(json!({"ok": true})))
}

/// Forget a link. Its data stays on that host.
pub async fn remove_host(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    s.db().execute("DELETE FROM links WHERE id=?1", [&id])?;
    if let Some(t) = s.link_tasks.lock().unwrap().remove(&id) {
        t.abort();
    }
    s.links.lock().unwrap().remove(&id);
    changed(&s);
    Ok(Json(json!({"ok": true})))
}

/// What a host needs to dial in to this hub.
pub async fn join_info(State(s): State<Shared>, headers: HeaderMap) -> Json<Value> {
    Json(json!({
        "hub_token": s.hub_token,
        "host_token": s.token,
        "command": format!("huntaway serve --hub {} --hub-token {}", hub_url(&s, &headers), s.hub_token),
    }))
}

/// The URL hosts dial this hub at, as the browser asking reaches it.
fn hub_url(s: &Shared, headers: &HeaderMap) -> String {
    // Through a broker, whose request comes from loopback without the client's Host: at the broker.
    if headers.contains_key(crate::broker::VIA_BROKER)
        && let Some(url) = s.broker_url.get()
    {
        return url.clone();
    }
    let header = |name: &str| headers.get(name).and_then(|h| h.to_str().ok()).and_then(|h| h.split(',').next()).map(str::trim).filter(|h| !h.is_empty());
    // Behind a TLS proxy (Caddy sets X-Forwarded-Proto), hosts must dial https: they don't follow redirects.
    let scheme = match header("x-forwarded-proto") {
        Some("https") => "https",
        _ => "http",
    };
    let host = header("x-forwarded-host").or_else(|| header("host")).unwrap_or("this-hub:7878");
    format!("{scheme}://{host}")
}

/// Merged events from every host, for the UI.
pub async fn ws(State(s): State<Shared>, upgrade: WebSocketUpgrade) -> Response {
    upgrade.on_upgrade(move |socket| ui_loop(s, socket))
}

async fn ui_loop(s: Shared, mut socket: WebSocket) {
    let mut rx = s.hub_events.subscribe();
    let _ = socket.send(WsMessage::Text(json!({"type": "hello", "host_id": s.host_id}).to_string().into())).await;
    loop {
        tokio::select! {
            ev = rx.recv() => match ev {
                Ok(v) => {
                    if socket.send(WsMessage::Text(v.to_string().into())).await.is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    if socket.send(WsMessage::Text(json!({"type": "resync"}).to_string().into())).await.is_err() {
                        break;
                    }
                }
                Err(_) => break,
            },
            msg = socket.recv() => match msg {
                Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            }
        }
    }
}

// ---------- copying Claude config between hosts ----------

#[derive(Deserialize)]
pub struct CopyConfig {
    /// The Claude config to copy, by name (API 20).
    config: Option<String>,
    /// Or the default config of the profile with this name (hosts before API 20).
    profile: Option<String>,
    from_host: String,
    to_host: String,
    /// Where to put it on the target if it has no config (or profile) with this name yet
    /// (default: same path).
    config_dir: Option<String>,
    #[serde(default)]
    overwrite: bool,
}

/// Call any host's API (this one or a linked one).
pub(crate) async fn host_request(s: &Shared, host_id: &str, method: &str, path: &str, body: Option<Value>) -> ApiResult<Value> {
    let (status, body) = if host_id == s.host_id {
        local_request(s, method, path, body.map(|b| b.to_string().into_bytes())).await?
    } else {
        let link = s.links.lock().unwrap().get(host_id).cloned().ok_or_else(|| ApiError::conflict(format!("host {host_id} is offline")))?;
        link.request(method, path, body).await?
    };
    if !(200..300).contains(&status) {
        let msg = match body["error"].as_str() {
            // No such route (a bare 404 from older hosts) means the host's build predates this endpoint.
            e if matches!(status, 404 | 405) && e.is_none_or(|e| e.starts_with(crate::api::NO_ROUTE)) => "this host's version doesn't support that yet; update it".into(),
            Some(e) => e.to_string(),
            None => body.to_string(),
        };
        return Err(ApiError(StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY), msg));
    }
    Ok(body)
}

async fn named(s: &Shared, host_id: &str, list: &str, name: &str) -> ApiResult<Option<Value>> {
    let items = host_request(s, host_id, "GET", list, None).await?;
    Ok(items.as_array().into_iter().flatten().find(|p| p["name"] == name).cloned())
}

/// Copy a Claude config's login and settings from one host to another, creating the config
/// on the target if needed.
pub async fn copy_claude_config(State(s): State<Shared>, Json(b): Json<CopyConfig>) -> ApiResult<Json<Value>> {
    if b.from_host == b.to_host {
        return Err(ApiError::bad("pick two different hosts"));
    }
    let dir = |source: &Value, key: &str| b.config_dir.clone().filter(|d| !d.trim().is_empty()).unwrap_or_else(|| source[key].as_str().unwrap_or("").to_string());
    let (from, to) = match (&b.config, &b.profile) {
        (Some(name), _) => {
            let source = named(&s, &b.from_host, "/api/claude-configs", name).await?.ok_or_else(|| ApiError::not_found("Claude config on the source host"))?;
            let target = match named(&s, &b.to_host, "/api/claude-configs", name).await? {
                Some(c) => c,
                None => {
                    let body = json!({"name": name, "config_dir": dir(&source, "config_dir"), "agent": source["agent"]});
                    host_request(&s, &b.to_host, "POST", "/api/claude-configs", Some(body)).await?
                }
            };
            let path = |c: &Value| format!("/api/claude-configs/{}/archive", c["id"].as_str().unwrap_or(""));
            (path(&source), path(&target))
        }
        (None, Some(name)) => {
            let source = named(&s, &b.from_host, "/api/profiles", name).await?.ok_or_else(|| ApiError::not_found("profile on the source host"))?;
            let target = match named(&s, &b.to_host, "/api/profiles", name).await? {
                Some(p) => p,
                None => {
                    let body = json!({"name": name, "claude_config_dir": dir(&source, "claude_config_dir"), "default_model": source["default_model"]});
                    host_request(&s, &b.to_host, "POST", "/api/profiles", Some(body)).await?
                }
            };
            let path = |p: &Value| format!("/api/profiles/{}/claude-config", p["id"].as_str().unwrap_or(""));
            (path(&source), path(&target))
        }
        (None, None) => return Err(ApiError::bad("config (or profile) is required")),
    };
    let archive = host_request(&s, &b.from_host, "GET", &from, None).await?;
    let result = host_request(&s, &b.to_host, "POST", &to, Some(json!({"archive": archive["archive"], "overwrite": b.overwrite}))).await?;
    Ok(Json(json!({"ok": true, "files": archive["files"], "target": result})))
}

/// Send this hub's code to a linked host, which fast-forwards its checkout and restarts.
pub async fn update_host(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    if id == s.host_id {
        return Err(ApiError::bad("use Rebuild & restart for this host"));
    }
    // A hub with a checkout sends its code; one deployed without (a container) sends its
    // commit and the host fetches it from its own origin.
    let body = if s.meta.source_dir.is_some() {
        crate::admin::bundle(&s).await?
    } else {
        let commit = s.meta.running_commit.clone().ok_or_else(|| ApiError::bad("this hub doesn't know which commit it runs (set IA_COMMIT)"))?;
        json!({"commit": commit})
    };
    Ok(Json(host_request(&s, &id, "POST", "/api/admin/update", Some(body)).await?))
}

// ---------- hosts over SSH ----------

/// The hub's SSH public key, for the target's authorized_keys.
pub async fn ssh_key(State(s): State<Shared>) -> ApiResult<Json<Value>> {
    Ok(Json(json!({"public_key": crate::ssh::public_key(&s).await?})))
}

/// Link a host over SSH: starts it on the target if needed, then keeps a tunnel to it.
pub async fn add_ssh_host(State(s): State<Shared>, Json(t): Json<crate::ssh::Target>) -> ApiResult<Json<Value>> {
    let t = crate::ssh::Target { target: t.target.trim().to_string(), ..t };
    if !t.target.contains('@') {
        return Err(ApiError::bad("enter the target as user@host"));
    }
    let details = crate::ssh::ensure(&s, &t).await.map_err(|e| ApiError::bad(format!("{e:#}")))?;
    let info = &details["info"];
    let host_id = info["host_id"].as_str().ok_or_else(|| ApiError::bad("the host didn't report an id"))?;
    if host_id == s.host_id {
        return Err(ApiError::bad("that's this host"));
    }
    let name = info["host_name"].as_str().unwrap_or(host_id);
    let link = db::upsert_link(&s.db(), host_id, name, "ssh", None, details["token"].as_str())?;
    s.db().execute("UPDATE links SET ssh=?1 WHERE id=?2", rusqlite::params![serde_json::to_string(&t).unwrap(), host_id])?;
    let link = db::get_link(&s.db(), host_id)?.unwrap_or(link);
    spawn_outbound(&s, link.clone());
    changed(&s);
    Ok(Json(json!({"id": link.id, "name": link.name, "started": details["started"]})))
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
mod tests {
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
            crate::broker::dial_out(&hub, format!("http://{broker}"), BROKER_TOKEN.into(), "hub".into(), "hub-key".into());

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
        let brokered = headers(&[("host", "127.0.0.1:7878"), (crate::broker::VIA_BROKER, "1")]);
        assert_eq!(hub_url(&s, &brokered), "http://127.0.0.1:7878");
        s.broker_url.set("https://broker.example.com/_broker/h/hub".into()).unwrap();
        assert_eq!(hub_url(&s, &brokered), "https://broker.example.com/_broker/h/hub");
    }
}
