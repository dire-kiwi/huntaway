//! The broker: a public relay for Huntaway hosts that can't be reached directly (at home, behind
//! NAT, without Tailscale).
//!
//! A host dials out to `/_broker/connect` (`huntaway serve --broker <url>`) and keeps that
//! websocket open. Every other request the broker gets is passed down it to a host, which answers
//! it from its own server: the board's UI, its API and its websockets. The broker keeps nothing
//! but the list of connected hosts and the names they took. It doesn't sign anyone in: the host's own token
//! still guards its API.
//!
//! The broker's token lets a host connect, under the name it asks for. Clients pick a host by its
//! name, so a name stays with the first host that took it (the `host_id` and secret `key` of its
//! `Hello`): another host asking for it is refused while that one is connected, and for `HOLD`
//! after it goes. With a state file (`--state`), the broker keeps these across restarts (the key
//! as a hash), and a host connected when it stopped has its name kept for `HOLD` from when it
//! starts again. Without one, a broker that restarts forgets them, and the first host to connect
//! again under a name has it.
//!
//! Which host a request goes to:
//!
//! * `/_broker/h/<name>/<path>` goes to `<path>` on that host. Hubs use it to link a host through
//!   the broker (`--hub https://broker/_broker/h/<name>`, or Add host with that URL).
//! * Anything else goes to the host named by the `X-Huntaway-Host` header, else by the
//!   `huntaway_host` cookie (set by opening `/_broker/use/<name>`), else the broker's default host
//!   (`--default-host`), else the only host connected. A browser opens the board at the root, as
//!   it would on the host itself.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::{Path as FsPath, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::Context;

use axum::body::{Body, Bytes, HttpBody};
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts, Path, Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::{Json, Router};
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
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
/// Requests (and websockets) a host may have in flight through the broker at once. With each
/// stream's window, this bounds what the broker can hold for a host. A host that has as many takes
/// a new request in place of the one whose client has left data waiting longest (`EVICT_AFTER` at
/// least), so clients that stop reading can't keep others out.
const MAX_STREAMS: usize = 128;
/// How long a client must have left a stream's data waiting before a new request takes its place.
const EVICT_AFTER: Duration = Duration::from_secs(1);
/// How long a client's websocket has to take what the host sent before the host's close (or the host
/// going) before it's cut off.
const CLOSE_GRACE: Duration = Duration::from_secs(2);
/// A stream whose client takes none of what's waiting for it for this long is closed, and so is one
/// whose data waits that long for the host to take it.
const STALL: Duration = Duration::from_secs(60);
/// How long a name is kept for its host after it goes, so another can't take it meanwhile.
const HOLD: Duration = Duration::from_secs(60 * 60);

#[derive(Clone, Debug)]
pub struct Config {
    /// What hosts present to connect (as a bearer token).
    pub token: String,
    /// The host for requests that don't pick one.
    pub default_host: Option<String>,
    /// Streams a host may have in flight (`MAX_STREAMS`).
    pub max_streams: usize,
    /// How long a client may leave a stream's data waiting before it's closed (`STALL`).
    pub stall: Duration,
    /// How long a name is kept for its host after it goes (`HOLD`).
    pub hold: Duration,
    /// Where the names taken are kept across restarts (`--state`). Without it they're kept in memory only.
    pub state: Option<PathBuf>,
}

impl Default for Config {
    fn default() -> Self {
        Config { token: String::new(), default_host: None, max_streams: MAX_STREAMS, stall: STALL, hold: HOLD, state: None }
    }
}

struct Broker {
    cfg: Config,
    names: Mutex<HashMap<String, Name>>,
}

impl Broker {
    /// The host connected as `name`.
    fn host(&self, name: &str) -> Option<Arc<Host>> {
        self.names.lock().unwrap().get(name)?.host.clone()
    }

    /// Write the names taken to the state file, if there is one. Called with `names` locked, so
    /// writes happen in the order the changes did.
    fn save(&self, names: &HashMap<String, Name>) -> anyhow::Result<()> {
        let Some(path) = &self.cfg.state else { return Ok(()) };
        let now = unix_now();
        let saved = Saved {
            names: names
                .iter()
                .map(|(name, n)| {
                    let left = n.host.is_none().then(|| now.saturating_sub(n.left.elapsed().as_secs()));
                    (name.clone(), SavedName { host_id: n.owner.host_id.clone(), key_sha256: n.owner.key.map(hex), left })
                })
                .collect(),
        };
        // Written beside it and renamed over it, so a crash meanwhile leaves the old one whole.
        let tmp = path.with_file_name(format!(".{}.tmp", path.file_name().and_then(|f| f.to_str()).unwrap_or("state")));
        std::fs::write(&tmp, serde_json::to_vec_pretty(&saved)?).with_context(|| format!("writing {}", tmp.display()))?;
        std::fs::rename(&tmp, path).with_context(|| format!("renaming {} to {}", tmp.display(), path.display()))?;
        Ok(())
    }

    fn save_or_warn(&self, names: &HashMap<String, Name>) {
        if let Err(e) = self.save(names) {
            tracing::warn!("saving the names taken: {e:#}");
        }
    }
}

/// The state file (`--state`): the names taken, and who they're kept for.
#[derive(Serialize, Deserialize, Default)]
struct Saved {
    names: BTreeMap<String, SavedName>,
}

#[derive(Serialize, Deserialize)]
struct SavedName {
    host_id: String,
    /// The SHA-256 of the host's key, in hex: the file doesn't give away what to connect with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    key_sha256: Option<String>,
    /// When the host went, in seconds since 1970; none if it was connected when this was written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    left: Option<u64>,
}

/// The names in the state file at `path` (none if there's no file yet), with those whose hold ran
/// out left out. A host that was connected when it was written has its name kept for `hold` from now.
fn load(path: &FsPath, hold: Duration) -> anyhow::Result<HashMap<String, Name>> {
    let saved: Saved = match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).with_context(|| format!("reading {}", path.display()))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Saved::default(),
        Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
    };
    let now = unix_now();
    let mut names = HashMap::new();
    for (name, n) in saved.names {
        let key = match n.key_sha256.as_deref().map(unhex) {
            Some(None) => anyhow::bail!("reading {}: bad key_sha256 for {name}", path.display()),
            Some(Some(k)) => Some(k),
            None => None,
        };
        let gone = Duration::from_secs(n.left.map_or(0, |t| now.saturating_sub(t)));
        if !proto::valid_name(&name) || gone >= hold {
            continue;
        }
        let left = Instant::now().checked_sub(gone).unwrap_or_else(Instant::now);
        names.insert(name, Name { owner: Owner { host_id: n.host_id, key }, host: None, left });
    }
    Ok(names)
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

fn hash(key: &str) -> [u8; 32] {
    Sha256::digest(key.as_bytes()).into()
}

fn hex(bytes: [u8; 32]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Option<[u8; 32]> {
    let mut out = [0u8; 32];
    if s.len() != 64 {
        return None;
    }
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(s.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

/// A name taken on the broker: the host it's kept for, and that host's connection while it has one.
struct Name {
    owner: Owner,
    host: Option<Arc<Host>>,
    /// When the host went, while it isn't connected: the name is kept for it until `hold` after.
    left: Instant,
}

/// Who a host says it is: its id, and the hash of its key.
struct Owner {
    host_id: String,
    key: Option<[u8; 32]>,
}

impl Owner {
    /// Whether `other` is the host a name is kept for.
    fn admits(&self, other: &Owner) -> bool {
        match (&self.key, &other.key) {
            (Some(a), Some(b)) => self.host_id == other.host_id && same(a, b),
            (Some(_), None) => false,
            // A host from before keys is known by its id alone, and keeps its name when it comes back with a key.
            (None, _) => self.host_id == other.host_id,
        }
    }
}

/// How long `d` is, in words, rounded up to minutes.
fn minutes(d: Duration) -> String {
    match d.as_secs().div_ceil(60) {
        0 | 1 => "a minute".into(),
        n => format!("{n} minutes"),
    }
}

/// A connected host.
struct Host {
    name: String,
    max_streams: usize,
    tx: mpsc::UnboundedSender<Message>,
    /// Requests in flight, by stream id.
    streams: Mutex<HashMap<u64, Entry>>,
    next: AtomicU64,
}

/// A stream in flight: what the host sent on it, waiting for the client, and our room to send it data.
struct Entry {
    queue: Arc<Queue>,
    window: proto::Window,
}

impl Entry {
    /// How long the stream has made no progress: its client taking none of what the host sent, or
    /// the host none of what the client sent. (A client that went away while its data waits for
    /// the host isn't read meanwhile, so this is how it's noticed.)
    fn stuck(&self) -> Option<Duration> {
        self.queue.waited().max(self.window.blocked_for())
    }
}

/// What the host sent on a stream, waiting for the client to take it. At most a window's worth of
/// data, as the host sends only that much ahead of what the client takes.
#[derive(Default)]
struct Queue {
    state: Mutex<QueueState>,
    notify: tokio::sync::Notify,
    /// Woken when the stream ends, or is dropped.
    over: tokio::sync::Notify,
}

#[derive(Default)]
struct QueueState {
    items: VecDeque<Event>,
    /// Nothing more is coming.
    ended: bool,
    /// The stream was dropped: its client should be let go of too.
    dropped: bool,
    /// The consumer has data it took out and hasn't passed on yet (it's writing it to the client).
    in_hand: bool,
    /// Since when the client has taken nothing of what's waiting or in hand.
    waiting_since: Option<Instant>,
}

impl Queue {
    fn push(&self, ev: Event) {
        let mut q = self.state.lock().unwrap();
        if q.ended {
            return;
        }
        if q.items.is_empty() && !q.in_hand {
            q.waiting_since = Some(Instant::now());
        }
        q.items.push_back(ev);
        drop(q);
        self.notify.notify_one();
    }

    /// Nothing more is coming: what's waiting still goes to the client, unless `drop_waiting`.
    fn end(&self, drop_waiting: bool) {
        let mut q = self.state.lock().unwrap();
        q.ended = true;
        if drop_waiting {
            q.items.clear();
            q.waiting_since = None;
            q.dropped = true;
        }
        drop(q);
        self.notify.notify_one();
        self.over.notify_waiters();
    }

    /// Wait until a websocket's client is to be let go of: at once when the stream is dropped (its
    /// client stopped reading, say), `grace` after it ends (the host closed it, or went), so the
    /// client can take what was sent before and the close.
    async fn until_cut_off(&self, grace: Duration) {
        loop {
            let woken = self.over.notified();
            tokio::pin!(woken);
            // Registered before looking, so an end in between isn't missed.
            woken.as_mut().enable();
            let (ended, dropped) = {
                let q = self.state.lock().unwrap();
                (q.ended, q.dropped)
            };
            if dropped {
                return;
            }
            if ended {
                // Dropped meanwhile cuts it short.
                tokio::select! { _ = tokio::time::sleep(grace) => {}, _ = woken => {} }
                return;
            }
            woken.await;
        }
    }

    /// The next thing the host sent; None once the stream is over. Asking for more says the data
    /// taken last was passed on: until then, a client that doesn't take it (a write that doesn't
    /// finish) counts as leaving it waiting.
    async fn recv(&self) -> Option<Event> {
        loop {
            {
                let mut q = self.state.lock().unwrap();
                if q.in_hand {
                    q.in_hand = false;
                    q.waiting_since = if q.items.is_empty() { None } else { Some(Instant::now()) };
                }
                if let Some(ev) = q.items.pop_front() {
                    if matches!(ev, Event::Data(_) | Event::Text(_)) {
                        q.in_hand = true;
                        q.waiting_since = Some(Instant::now());
                    } else {
                        q.waiting_since = if q.items.is_empty() { None } else { Some(Instant::now()) };
                    }
                    return Some(ev);
                }
                if q.ended {
                    return None;
                }
            }
            // A notification while we weren't waiting is kept, so none is missed.
            self.notify.notified().await;
        }
    }

    /// How long the client has left data waiting.
    fn waited(&self) -> Option<Duration> {
        self.state.lock().unwrap().waiting_since.map(|t| t.elapsed())
    }
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

    /// Send body bytes as the stream's window has room for them.
    async fn send_body(&self, window: &proto::Window, id: u64, bytes: &[u8]) -> bool {
        for piece in bytes.chunks(proto::WINDOW) {
            if !window.take(piece.len()).await || !self.send_data(id, proto::DATA, piece) {
                return false;
            }
        }
        true
    }

    /// Send a websocket message once the stream's window has room for it.
    async fn send_message(&self, window: &proto::Window, id: u64, kind: u8, bytes: &[u8]) -> bool {
        window.take(bytes.len()).await && self.send_data(id, kind, bytes)
    }

    /// Tell the host we passed on `bytes` of what it sent on a stream.
    fn credit(&self, id: u64, bytes: usize) {
        if bytes > 0 {
            self.send(&Ctl::Credit { id, bytes: bytes as u64 });
        }
    }

    /// Start a stream: its id, what the host sends on it, and a guard that ends it. None when the
    /// host has as many in flight as it may, and all their clients are taking what's sent.
    fn open(self: &Arc<Self>) -> Option<(Stream, Arc<Queue>)> {
        let mut streams = self.streams.lock().unwrap();
        if streams.len() >= self.max_streams {
            let stalest = streams.iter().filter_map(|(id, e)| Some((*id, e.stuck()?))).filter(|(_, w)| *w >= EVICT_AFTER).max_by_key(|(_, w)| *w);
            let (id, _) = stalest?;
            self.drop_stream(&mut streams, id);
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let queue = Arc::new(Queue::default());
        let window = proto::Window::default();
        streams.insert(id, Entry { queue: queue.clone(), window: window.clone() });
        Some((Stream { host: self.clone(), id, done: false, window, upload: None }, queue))
    }

    /// Close a stream whose client stopped taking what's sent: what's waiting is dropped, and the
    /// host told to stop.
    fn drop_stream(&self, streams: &mut HashMap<u64, Entry>, id: u64) {
        if let Some(e) = streams.remove(&id) {
            e.queue.end(true);
            e.window.close();
            self.send(&Ctl::Close { id, code: None, reason: Some("the client stopped reading".into()) });
        }
    }

    /// Close the streams that have been stuck for `stall`.
    fn drop_stalled(&self, stall: Duration) {
        let mut streams = self.streams.lock().unwrap();
        let stalled: Vec<u64> = streams.iter().filter(|(_, e)| e.stuck().is_some_and(|w| w >= stall)).map(|(id, _)| *id).collect();
        for id in stalled {
            tracing::info!("host {}: closing stream {id}, which has made no progress", self.name);
            self.drop_stream(&mut streams, id);
        }
    }
}

/// One request on a host. Dropped before it's done (the client went away), it tells the host to
/// stop.
struct Stream {
    host: Arc<Host>,
    id: u64,
    done: bool,
    /// Our room to send the host this stream's data.
    window: proto::Window,
    /// Passing the request body on, which stops with the stream.
    upload: Option<tokio::task::AbortHandle>,
}

impl Drop for Stream {
    fn drop(&mut self) {
        self.host.streams.lock().unwrap().remove(&self.id);
        self.window.close();
        if let Some(u) = &self.upload {
            u.abort();
        }
        if !self.done {
            self.host.send(&Ctl::Close { id: self.id, code: None, reason: None });
        }
    }
}

/// The broker's routes. Err if its state file (`Config::state`) can't be read, or written.
pub fn router(cfg: Config) -> anyhow::Result<Router> {
    let names = match &cfg.state {
        Some(path) => load(path, cfg.hold)?,
        None => HashMap::new(),
    };
    if !names.is_empty() {
        tracing::info!("keeping {} names for the hosts that had them", names.len());
    }
    let b = Arc::new(Broker { cfg, names: Mutex::new(names) });
    // Written back at once, so a file that can't be written is found now rather than at the first host.
    b.save(&b.names.lock().unwrap())?;
    Ok(Router::new()
        .route("/_broker/connect", get(connect))
        .route("/_broker/health", get(|| async { Json(json!({"ok": true})) }))
        .route("/_broker/use/{name}", get(use_host))
        .route("/_broker/h/{name}", any(prefixed))
        .route("/_broker/h/{name}/", any(prefixed))
        .route("/_broker/h/{name}/{*rest}", any(prefixed))
        .route("/_broker/{*rest}", any(|req: Request| async move { fail(req.uri().path(), StatusCode::NOT_FOUND, "no such broker route") }))
        .fallback(picked)
        .with_state(b))
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
    let (name, owner) = match hello {
        Some(Ctl::Hello { protocol, .. }) if protocol != proto::PROTOCOL => {
            let _ = sink.send(refuse(format!("the broker speaks protocol {}, the host {protocol}", proto::PROTOCOL))).await;
            return;
        }
        Some(Ctl::Hello { name, .. }) if !proto::valid_name(&name) => {
            let _ = sink.send(refuse(format!("bad host name {name:?}: use up to 48 lowercase letters, digits and hyphens"))).await;
            return;
        }
        Some(Ctl::Hello { host_id, .. }) if host_id.is_empty() || host_id.len() > 128 => {
            let _ = sink.send(refuse("bad host id".into())).await;
            return;
        }
        Some(Ctl::Hello { key: Some(key), .. }) if key.len() > 256 => {
            let _ = sink.send(refuse("bad key".into())).await;
            return;
        }
        Some(Ctl::Hello { name, host_id, key, .. }) => (name, Owner { host_id, key: key.filter(|k| !k.is_empty()).map(|k| hash(&k)) }),
        _ => return,
    };
    let host_id = owner.host_id.clone();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let host = Arc::new(Host { name: name.clone(), max_streams: b.cfg.max_streams, tx, streams: Mutex::new(HashMap::new()), next: AtomicU64::new(1) });
    if let Err(error) = take_name(&b, &name, owner, &host) {
        let _ = sink.send(refuse(error)).await;
        return;
    }
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
    let watchdog = {
        let (host, stall) = (host.clone(), b.cfg.stall);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval((stall / 4).max(Duration::from_millis(50)));
            loop {
                tick.tick().await;
                host.drop_stalled(stall);
            }
        })
    };
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
                Ok(Ctl::Credit { id, bytes }) => {
                    if let Some(e) = host.streams.lock().unwrap().get(&id) {
                        e.window.credit(bytes);
                    }
                }
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
    // The name is kept for the host a while, unless it connected again meanwhile.
    {
        let mut names = b.names.lock().unwrap();
        if let Some(n) = names.get_mut(&name).filter(|n| n.host.as_ref().is_some_and(|h| Arc::ptr_eq(h, &host))) {
            n.host = None;
            n.left = Instant::now();
            b.save_or_warn(&names);
        }
    }
    // The requests in flight end (with what the host sent of them).
    for (_, e) in host.streams.lock().unwrap().drain() {
        e.queue.end(false);
        e.window.close();
    }
    watchdog.abort();
    writer.abort();
    tracing::info!("host {name} disconnected");
}

/// Take `name` for `host`, unless it's kept for another. A host that connects again (its old
/// connection not yet seen to drop) takes its name back, and the old connection is closed. With a
/// state file, a name that can't be saved isn't taken: a host welcomed without it on disk could
/// lose its name to another when the broker restarts.
fn take_name(b: &Broker, name: &str, owner: Owner, host: &Arc<Host>) -> Result<(), String> {
    let mut names = b.names.lock().unwrap();
    let hold = b.cfg.hold;
    names.retain(|_, n| n.host.is_some() || n.left.elapsed() < hold);
    if let Some(n) = names.get(name).filter(|n| !n.owner.admits(&owner)) {
        tracing::info!("host {name}: refused host id {}, as the name is kept for {}", owner.host_id, n.owner.host_id);
        let why = match n.host {
            Some(_) => "another host is connected under it".into(),
            None => format!("it's kept for the host that had it for {} more", minutes(hold.saturating_sub(n.left.elapsed()))),
        };
        return Err(format!("the name {name} is taken: {why}. Give this host another name (--broker-name)"));
    }
    let old = names.insert(name.into(), Name { owner, host: Some(host.clone()), left: Instant::now() });
    if let Err(e) = b.save(&names) {
        tracing::warn!("host {name}: refused, as the name couldn't be saved: {e:#}");
        match old {
            Some(old) => names.insert(name.into(), old),
            None => names.remove(name),
        };
        return Err(format!("the broker couldn't save the name {name} for this host (see its log), so it can't take it now. It will try again"));
    }
    if let Some(old) = old.and_then(|n| n.host) {
        let _ = old.tx.send(Message::Close(Some(CloseFrame { code: 4000, reason: "replaced by a newer connection".into() })));
    }
    Ok(())
}

fn to_stream(host: &Host, id: u64, ev: Event, last: bool) {
    let mut streams = host.streams.lock().unwrap();
    if last {
        if let Some(e) = streams.remove(&id) {
            e.window.close();
            e.queue.push(ev);
            e.queue.end(false);
        }
    } else if let Some(e) = streams.get(&id) {
        e.queue.push(ev);
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
    let Some(host) = b.host(&name) else {
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
    let host = match &wanted {
        Some(name) => b.host(name).ok_or_else(|| format!("host {name} isn't connected to the broker")),
        None => {
            let names = b.names.lock().unwrap();
            let mut hosts = names.values().filter_map(|n| n.host.clone());
            match (hosts.next(), hosts.next()) {
                (Some(h), None) => Ok(h),
                (None, _) => Err("no host is connected to the broker".into()),
                (Some(_), Some(_)) => Err("several hosts are connected to the broker: open /_broker/use/<name> to pick one".into()),
            }
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
    let Some((mut stream, rx)) = host.open() else {
        return fail(&path, StatusCode::SERVICE_UNAVAILABLE, &format!("host {} has too many requests in flight", host.name));
    };
    let id = stream.id;
    if !host.send(&Ctl::Req { id, method: parts.method.to_string(), path: path.clone(), headers, body: has_body, ws }) {
        stream.done = true;
        return fail(&path, StatusCode::BAD_GATEWAY, &format!("host {} disconnected", host.name));
    }
    if has_body {
        // As fast as the host takes it: a client can't upload faster than that into our memory.
        let (host, window) = (host.clone(), stream.window.clone());
        let upload = tokio::spawn(async move {
            let mut body = body.into_data_stream();
            while let Some(chunk) = body.next().await {
                match chunk {
                    Ok(c) => {
                        if !host.send_body(&window, id, &c).await {
                            return;
                        }
                    }
                    // The response (if any) says what the host made of it; the stream's guard tells it to stop.
                    Err(_) => return,
                }
            }
            host.send(&Ctl::End { id });
        });
        stream.upload = Some(upload.abort_handle());
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
fn body_stream(stream: Stream, rx: Arc<Queue>) -> impl futures::Stream<Item = std::io::Result<Bytes>> {
    futures::stream::unfold(Some((stream, rx)), |state| async move {
        let (mut stream, rx) = state?;
        loop {
            match rx.recv().await {
                // Taken by the client's connection: the host may send as much more.
                Some(Event::Data(b)) => {
                    stream.host.credit(stream.id, b.len());
                    return Some((Ok(b), Some((stream, rx))));
                }
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

/// Relay a client's websocket to the host's until either side closes it. The two ways go on
/// side by side, so one waiting for room doesn't hold up the other.
async fn bridge(socket: WebSocket, mut stream: Stream, rx: Arc<Queue>) {
    let (host, id, window) = (stream.host.clone(), stream.id, stream.window.clone());
    let (mut sink, mut source) = socket.split();
    // Each way says whether the host knows the stream is over.
    let up = async {
        while let Some(m) = source.next().await {
            let sent = match m {
                Ok(Message::Text(t)) => host.send_message(&window, id, proto::TEXT, t.as_bytes()).await,
                Ok(Message::Binary(b)) => host.send_message(&window, id, proto::DATA, &b).await,
                Ok(Message::Close(c)) => {
                    host.send(&Ctl::Close { id, code: c.as_ref().map(|c| c.code), reason: c.map(|c| c.reason.to_string()) });
                    return true;
                }
                Ok(_) => true,
                Err(_) => return false,
            };
            if !sent {
                return false;
            }
        }
        false
    };
    let down = async {
        loop {
            let (msg, len) = match rx.recv().await {
                Some(Event::Data(b)) => {
                    let n = b.len();
                    (Message::Binary(b), n)
                }
                Some(Event::Text(t)) => {
                    let n = t.len();
                    (Message::Text(t.into()), n)
                }
                Some(Event::Close(code, reason)) => {
                    let frame = code.map(|code| CloseFrame { code, reason: reason.unwrap_or_default().into() });
                    let _ = sink.send(Message::Close(frame)).await;
                    return true;
                }
                Some(_) => continue,
                None => {
                    let _ = sink.send(Message::Close(Some(CloseFrame { code: 1011, reason: "host disconnected".into() }))).await;
                    return true;
                }
            };
            if sink.send(msg).await.is_err() {
                return false;
            }
            host.credit(id, len);
        }
    };
    // A stream that's over lets go of the client in the end, whatever either way waits on (a write
    // to a client that doesn't read, say). The host knows it's over.
    #[cfg(test)]
    let _live = tests::Live::new(&host.name);
    stream.done = tokio::select! { d = up => d, d = down => d, _ = rx.until_cut_off(CLOSE_GRACE) => true };
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::tungstenite::Message as TMessage;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    /// The websocket bridges running, by host name, so a test can see one end.
    static LIVE: Mutex<Vec<String>> = Mutex::new(Vec::new());

    pub(super) struct Live(String);

    impl Live {
        pub(super) fn new(host: &str) -> Self {
            LIVE.lock().unwrap().push(host.into());
            Live(host.into())
        }
    }

    impl Drop for Live {
        fn drop(&mut self) {
            let mut live = LIVE.lock().unwrap();
            if let Some(i) = live.iter().position(|h| *h == self.0) {
                live.remove(i);
            }
        }
    }

    fn live(host: &str) -> usize {
        LIVE.lock().unwrap().iter().filter(|h| *h == host).count()
    }

    const TOKEN: &str = "broker-token-0123456789";

    fn run(body: impl Future<Output = ()>) {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async { tokio::time::timeout(Duration::from_secs(30), body).await.expect("test still running after 30s") });
    }

    async fn broker() -> String {
        broker_with(Config::default()).await
    }

    async fn broker_with(cfg: Config) -> String {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        let app = router(Config { token: TOKEN.into(), ..cfg }).unwrap();
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        addr.to_string()
    }

    /// A host speaking the protocol by hand. It answers a websocket with window-sized messages, one
    /// more each time the broker gives room back. Returns where to send it control messages, when
    /// it last sent a message, and the websocket's stream id.
    async fn fake_host(b: &str, name: &str) -> (mpsc::UnboundedSender<Ctl>, Arc<Mutex<Instant>>, Arc<AtomicU64>, tokio::task::JoinHandle<()>) {
        let mut req = format!("ws://{b}/_broker/connect").into_client_request().unwrap();
        req.headers_mut().insert("Authorization", format!("Bearer {TOKEN}").parse().unwrap());
        let (ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
        let (mut sink, mut source) = ws.split();
        let hello = Ctl::Hello { name: name.into(), host_id: name.into(), version: "0".into(), protocol: proto::PROTOCOL, key: Some(format!("{name}-key")) };
        sink.send(TMessage::Text(serde_json::to_string(&hello).unwrap().into())).await.unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel::<Ctl>();
        let (sent, ws_id) = (Arc::new(Mutex::new(Instant::now())), Arc::new(AtomicU64::new(0)));
        let (sent2, ws_id2) = (sent.clone(), ws_id.clone());
        let task = tokio::spawn(async move {
            let text = |c: &Ctl| TMessage::Text(serde_json::to_string(c).unwrap().into());
            let message = |id| TMessage::Binary(proto::encode(id, proto::DATA, &vec![0u8; proto::WINDOW]).into());
            loop {
                tokio::select! {
                    c = rx.recv() => {
                        let Some(c) = c else { return };
                        sink.send(text(&c)).await.unwrap();
                    }
                    m = source.next() => {
                        let Some(Ok(TMessage::Text(t))) = m else { continue };
                        match serde_json::from_str::<Ctl>(&t).unwrap() {
                            Ctl::Req { id, ws: true, .. } => {
                                ws_id2.store(id, Ordering::SeqCst);
                                sink.send(text(&Ctl::Head { id, status: 101, headers: vec![] })).await.unwrap();
                                sink.send(message(id)).await.unwrap();
                                *sent2.lock().unwrap() = Instant::now();
                            }
                            Ctl::Credit { id, .. } => {
                                sink.send(message(id)).await.unwrap();
                                *sent2.lock().unwrap() = Instant::now();
                            }
                            Ctl::Ping => sink.send(text(&Ctl::Pong)).await.unwrap(),
                            _ => {}
                        }
                    }
                }
            }
        });
        (tx, sent, ws_id, task)
    }

    /// A client's websocket on the broker's only host, which never reads, with a small receive
    /// buffer, once the broker is stuck writing to it.
    async fn stuck_client(b: &str, sent: &Mutex<Instant>) -> impl Sized {
        let sock = tokio::net::TcpSocket::new_v4().unwrap();
        sock.set_recv_buffer_size(4096).unwrap();
        let tcp = sock.connect(b.parse().unwrap()).await.unwrap();
        let (ws, _) = tokio_tungstenite::client_async(format!("ws://{b}/x"), tcp).await.unwrap();
        while sent.lock().unwrap().elapsed() < Duration::from_millis(500) {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        ws
    }

    async fn until_gone(host: &str) {
        let started = Instant::now();
        while live(host) > 0 {
            assert!(started.elapsed() < CLOSE_GRACE + Duration::from_secs(2), "the bridge is still there after the host's close");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    #[test]
    fn a_websocket_stuck_writing_to_its_client_ends_after_the_hosts_close() {
        run(async {
            let b = broker().await;
            let (tx, sent, id, _host) = fake_host(&b, "close-host").await;
            let _client = stuck_client(&b, &sent).await;
            assert_eq!(live("close-host"), 1);
            tx.send(Ctl::Close { id: id.load(Ordering::SeqCst), code: Some(1000), reason: None }).unwrap();
            until_gone("close-host").await;
        })
    }

    #[test]
    fn a_websocket_stuck_writing_to_its_client_ends_when_its_host_goes() {
        run(async {
            let b = broker().await;
            let (_tx, sent, _id, host) = fake_host(&b, "gone-host").await;
            let _client = stuck_client(&b, &sent).await;
            assert_eq!(live("gone-host"), 1);
            host.abort();
            until_gone("gone-host").await;
        })
    }

    /// A host saying hello as `name`, with `host_id` and `key`, that answers each request with its
    /// `host_id` in an `x-who` header. Err with what the broker said if it was refused.
    async fn named_host(b: &str, name: &str, host_id: &str, key: Option<&str>) -> Result<tokio::task::JoinHandle<()>, String> {
        let mut req = format!("ws://{b}/_broker/connect").into_client_request().unwrap();
        req.headers_mut().insert("Authorization", format!("Bearer {TOKEN}").parse().unwrap());
        let (ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
        let (mut sink, mut source) = ws.split();
        let text = |c: &Ctl| TMessage::Text(serde_json::to_string(c).unwrap().into());
        let hello = Ctl::Hello { name: name.into(), host_id: host_id.into(), version: "0".into(), protocol: proto::PROTOCOL, key: key.map(String::from) };
        sink.send(text(&hello)).await.unwrap();
        match source.next().await {
            Some(Ok(TMessage::Text(t))) => match serde_json::from_str::<Ctl>(&t).unwrap() {
                Ctl::Welcome { .. } => {}
                Ctl::Refused { error } => {
                    // The broker hangs up after it.
                    assert!(!matches!(source.next().await, Some(Ok(TMessage::Text(_)))), "the broker kept talking after refusing");
                    return Err(error);
                }
                other => panic!("expected a welcome, got {other:?}"),
            },
            other => panic!("expected a welcome, got {other:?}"),
        }
        let host_id = host_id.to_string();
        Ok(tokio::spawn(async move {
            while let Some(Ok(m)) = source.next().await {
                let TMessage::Text(t) = m else { continue };
                match serde_json::from_str::<Ctl>(&t).unwrap() {
                    Ctl::Req { id, .. } => {
                        let _ = sink.send(text(&Ctl::Head { id, status: 200, headers: vec![("x-who".into(), host_id.clone())] })).await;
                        let _ = sink.send(text(&Ctl::End { id })).await;
                    }
                    Ctl::Ping => {
                        let _ = sink.send(text(&Ctl::Pong)).await;
                    }
                    _ => {}
                }
            }
        }))
    }

    /// The host id of the host that answers for `name`, or the broker's error.
    async fn who(b: &str, name: &str) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut tcp = tokio::net::TcpStream::connect(b).await.unwrap();
        tcp.write_all(format!("GET /_broker/h/{name}/ HTTP/1.1\r\nHost: b\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
        let mut res = String::new();
        tcp.read_to_string(&mut res).await.unwrap();
        match res.lines().find_map(|l| l.strip_prefix("x-who: ")) {
            Some(who) => who.into(),
            None => res.split("\r\n\r\n").nth(1).unwrap_or_default().trim().into(),
        }
    }

    async fn until_who(b: &str, name: &str, want: &str) {
        let started = Instant::now();
        loop {
            let got = who(b, name).await;
            if got.contains(want) {
                return;
            }
            assert!(started.elapsed() < Duration::from_secs(5), "{name} still answers with {got:?}, not {want:?}");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    #[test]
    fn a_host_cant_take_another_hosts_name() {
        run(async {
            let b = broker().await;
            let _desktop = named_host(&b, "desktop", "desktop-id", Some("desktop-key")).await.unwrap();
            assert_eq!(who(&b, "desktop").await, "desktop-id");
            // Knowing its host id isn't enough, nor is leaving the key out.
            for (id, key) in [("other-id", Some("other-key")), ("desktop-id", Some("other-key")), ("desktop-id", None), ("other-id", None)] {
                let error = named_host(&b, "desktop", id, key).await.unwrap_err();
                assert!(error.contains("the name desktop is taken: another host is connected under it"), "{error}");
                assert_eq!(who(&b, "desktop").await, "desktop-id", "after a hello from {id} with {key:?}");
            }
            // The host itself connecting again takes its name back.
            let _again = named_host(&b, "desktop", "desktop-id", Some("desktop-key")).await.unwrap();
            assert_eq!(who(&b, "desktop").await, "desktop-id");
        })
    }

    #[test]
    fn a_second_host_with_the_same_name_is_refused_until_the_first_has_been_gone_a_while() {
        run(async {
            let b = broker_with(Config { hold: Duration::from_millis(1500), ..Default::default() }).await;
            let first = named_host(&b, "desktop", "first", Some("first-key")).await.unwrap();
            // Refused rather than each replacing the other in turn.
            for _ in 0..3 {
                let error = named_host(&b, "desktop", "second", Some("second-key")).await.unwrap_err();
                assert!(error.contains("another host is connected under it") && error.contains("--broker-name"), "{error}");
                assert_eq!(who(&b, "desktop").await, "first");
            }
            first.abort();
            until_who(&b, "desktop", "host desktop isn't connected to the broker").await;
            let error = named_host(&b, "desktop", "second", Some("second-key")).await.unwrap_err();
            assert!(error.contains("it's kept for the host that had it for a minute more"), "{error}");
            // The first comes back to it meanwhile.
            let first = named_host(&b, "desktop", "first", Some("first-key")).await.unwrap();
            assert_eq!(who(&b, "desktop").await, "first");
            first.abort();
            until_who(&b, "desktop", "isn't connected").await;
            tokio::time::sleep(Duration::from_millis(1600)).await;
            let _second = named_host(&b, "desktop", "second", Some("second-key")).await.unwrap();
            assert_eq!(who(&b, "desktop").await, "second");
            let error = named_host(&b, "desktop", "first", Some("first-key")).await.unwrap_err();
            assert!(error.contains("taken"), "{error}");
        })
    }

    #[test]
    fn a_host_from_before_keys_is_known_by_its_id() {
        run(async {
            let b = broker().await;
            let old = named_host(&b, "desktop", "desktop-id", None).await.unwrap();
            named_host(&b, "desktop", "other-id", None).await.unwrap_err();
            named_host(&b, "desktop", "other-id", Some("other-key")).await.unwrap_err();
            // Updated, it comes back with a key, which it's then held to.
            old.abort();
            let _new = named_host(&b, "desktop", "desktop-id", Some("desktop-key")).await.unwrap();
            assert_eq!(who(&b, "desktop").await, "desktop-id");
            named_host(&b, "desktop", "desktop-id", None).await.unwrap_err();
        })
    }

    /// A state file in a new directory of its own.
    fn state_file(test: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("huntaway-broker-{test}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("state.json")
    }

    #[test]
    fn a_broker_with_a_state_file_keeps_names_across_a_restart() {
        run(async {
            let state = state_file("restart");
            let b = broker_with(Config { state: Some(state.clone()), ..Default::default() }).await;
            let desktop = named_host(&b, "desktop", "desktop-id", Some("desktop-key")).await.unwrap();
            let laptop = named_host(&b, "laptop", "laptop-id", Some("laptop-key")).await.unwrap();
            laptop.abort();
            until_who(&b, "laptop", "isn't connected").await;
            let saved = std::fs::read_to_string(&state).unwrap();
            assert!(!saved.contains("desktop-key") && saved.contains(&hex(hash("desktop-key"))), "{saved}");
            // Another broker on the same file, as the broker would be after a restart: desktop was
            // connected when it stopped, and laptop had gone.
            let b2 = broker_with(Config { state: Some(state.clone()), ..Default::default() }).await;
            for name in ["desktop", "laptop"] {
                let error = named_host(&b2, name, "other-id", Some("other-key")).await.unwrap_err();
                assert!(error.contains("it's kept for the host that had it for 60 minutes more"), "{name}: {error}");
                named_host(&b2, name, &format!("{name}-id"), Some("other-key")).await.unwrap_err();
            }
            let _desktop = named_host(&b2, "desktop", "desktop-id", Some("desktop-key")).await.unwrap();
            assert_eq!(who(&b2, "desktop").await, "desktop-id");
            let _laptop = named_host(&b2, "laptop", "laptop-id", Some("laptop-key")).await.unwrap();
            assert_eq!(who(&b2, "laptop").await, "laptop-id");
            drop(desktop);
            let _ = std::fs::remove_dir_all(state.parent().unwrap());
        })
    }

    #[test]
    fn names_kept_in_the_state_file_run_out_after_the_hold() {
        run(async {
            let state = state_file("hold");
            let now = unix_now();
            let names = json!({"names": {
                // Gone half an hour ago, two hours ago, and connected when the broker stopped.
                "recent": {"host_id": "recent-id", "key_sha256": hex(hash("recent-key")), "left": now - 30 * 60},
                "old": {"host_id": "old-id", "key_sha256": hex(hash("old-key")), "left": now - 2 * 60 * 60},
                "connected": {"host_id": "connected-id", "key_sha256": hex(hash("connected-key"))},
                // From a host from before keys.
                "keyless": {"host_id": "keyless-id", "left": now - 60},
            }});
            std::fs::write(&state, names.to_string()).unwrap();
            let b = broker_with(Config { state: Some(state.clone()), ..Default::default() }).await;
            let error = named_host(&b, "recent", "other-id", Some("other-key")).await.unwrap_err();
            assert!(error.contains("for 30 minutes more"), "{error}");
            let error = named_host(&b, "connected", "other-id", Some("other-key")).await.unwrap_err();
            assert!(error.contains("for 60 minutes more"), "{error}");
            named_host(&b, "keyless", "other-id", Some("other-key")).await.unwrap_err();
            let _other = named_host(&b, "old", "other-id", Some("other-key")).await.unwrap();
            assert_eq!(who(&b, "old").await, "other-id");
            let _keyless = named_host(&b, "keyless", "keyless-id", Some("keyless-key")).await.unwrap();
            // The old one's hold ran out, and it's gone from the file; the keyless host is now held to its key.
            let saved: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&state).unwrap()).unwrap();
            assert_eq!(saved["names"]["old"]["host_id"], "other-id");
            assert_eq!(saved["names"]["keyless"]["key_sha256"], hex(hash("keyless-key")));
            let _ = std::fs::remove_dir_all(state.parent().unwrap());
        })
    }

    #[test]
    fn a_name_that_cant_be_saved_isnt_taken() {
        run(async {
            let state = state_file("unsaved");
            let b = broker_with(Config { state: Some(state.clone()), ..Default::default() }).await;
            let _desktop = named_host(&b, "desktop", "desktop-id", Some("desktop-key")).await.unwrap();
            // The file can't be written from now on (as on a full disk): its temporary file's name is taken by a directory.
            let tmp = state.with_file_name(".state.json.tmp");
            std::fs::create_dir(&tmp).unwrap();
            let error = named_host(&b, "laptop", "laptop-id", Some("laptop-key")).await.unwrap_err();
            assert!(error.contains("couldn't save the name laptop"), "{error}");
            assert!(who(&b, "laptop").await.contains("isn't connected"));
            // A host connecting again is refused too, and its connection carries on.
            named_host(&b, "desktop", "desktop-id", Some("desktop-key")).await.unwrap_err();
            assert_eq!(who(&b, "desktop").await, "desktop-id");
            // After a restart, desktop is still kept for its host, and laptop was never taken.
            std::fs::remove_dir(&tmp).unwrap();
            let b2 = broker_with(Config { state: Some(state.clone()), ..Default::default() }).await;
            named_host(&b2, "desktop", "other-id", Some("other-key")).await.unwrap_err();
            let _laptop = named_host(&b2, "laptop", "other-id", Some("other-key")).await.unwrap();
            let _ = std::fs::remove_dir_all(state.parent().unwrap());
        })
    }

    #[test]
    fn a_state_file_that_cant_be_read_or_written_stops_the_broker() {
        let state = state_file("bad");
        std::fs::write(&state, "{not json").unwrap();
        let error = router(Config { token: TOKEN.into(), state: Some(state.clone()), ..Default::default() }).err().unwrap();
        assert!(format!("{error:#}").contains("reading"), "{error:#}");
        std::fs::write(&state, r#"{"names": {"desktop": {"host_id": "d", "key_sha256": "zz"}}}"#).unwrap();
        assert!(router(Config { token: TOKEN.into(), state: Some(state.clone()), ..Default::default() }).is_err());
        let missing = state.parent().unwrap().join("no-such-dir").join("state.json");
        let error = router(Config { token: TOKEN.into(), state: Some(missing), ..Default::default() }).err().unwrap();
        assert!(format!("{error:#}").contains("writing"), "{error:#}");
        // No file yet is a broker with no names taken.
        std::fs::remove_file(&state).unwrap();
        let _ = router(Config { token: TOKEN.into(), state: Some(state.clone()), ..Default::default() }).unwrap();
        assert!(std::fs::read_to_string(&state).unwrap().contains("\"names\""));
        let _ = std::fs::remove_dir_all(state.parent().unwrap());
    }
}
