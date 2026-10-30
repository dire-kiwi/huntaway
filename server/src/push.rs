//! Web Push: the board's notifications (a task needs attention, is ready to review, and so on; the
//! same events and words as the UI's, in app/src/notifications.ts) sent to the devices that turned
//! push on in Settings → Notifications, such as a phone with the board installed on its home screen.
//!
//! Each device's browser gives a subscription (an endpoint at its push service, and keys), which is
//! kept with the events it wants. This board watches the task events of every host on it (as the UI
//! does), and sends each subscription the ones it wants, encrypted for it (RFC 8291) and signed with
//! the board's VAPID key (RFC 8292), whose public half the browser subscribed with. Tapping one opens
//! the task (app/public/sw.js).

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes128Gcm, Nonce};
use anyhow::{anyhow, bail, Context, Result};
use axum::extract::{Path, State};
use axum::Json;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use hkdf::Hkdf;
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{PublicKey, SecretKey};
use rand_core::{OsRng, RngCore};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::db;
use crate::state::{ApiError, ApiResult, Shared};
use crate::util::now;

/// Where the board's VAPID private key is kept (in the settings table), made the first time it's needed.
const KEY_SETTING: &str = "vapid_private_key";

/// Who runs the board, for push services to contact (RFC 8292's `sub`): `IA_PUSH_SUBJECT`, a
/// `mailto:` or `https:` URL. Apple's push service turns away a token without one.
fn subject() -> String {
    std::env::var("IA_PUSH_SUBJECT").ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "https://github.com/dire-kiwi/huntaway".into())
}

// ---------- keys ----------

/// The board's VAPID key pair: subscriptions are made for its public key, and pushes signed with it.
pub struct Vapid {
    key: SigningKey,
    /// The public key, an uncompressed point (65 bytes), as browsers take it (`applicationServerKey`).
    public: Vec<u8>,
}

impl Vapid {
    fn from_secret(secret: &SecretKey) -> Self {
        Self { key: SigningKey::from(secret), public: secret.public_key().to_encoded_point(false).as_bytes().to_vec() }
    }

    pub fn public_key(&self) -> String {
        B64.encode(&self.public)
    }
}

/// The board's VAPID key, made and stored the first time.
pub fn vapid(c: &Connection) -> Result<Vapid> {
    if let Some(saved) = db::get_setting(c, KEY_SETTING)? {
        let bytes = B64.decode(saved.trim()).context("reading the VAPID key")?;
        return Ok(Vapid::from_secret(&SecretKey::from_slice(&bytes).context("reading the VAPID key")?));
    }
    let secret = SecretKey::random(&mut OsRng);
    db::set_setting(c, KEY_SETTING, Some(&B64.encode(secret.to_bytes())))?;
    Ok(Vapid::from_secret(&secret))
}

// ---------- encryption (RFC 8291) ----------

/// The size of the one record a push message is (RFC 8188's `rs`), which is at most 4096.
const RECORD_SIZE: u32 = 4096;

/// `plaintext` encrypted for a subscription, with its public key (`p256dh`, an uncompressed point)
/// and its authentication secret: the body of the push request (`Content-Encoding: aes128gcm`).
pub fn encrypt(ua_public: &[u8], auth: &[u8], plaintext: &[u8]) -> Result<Vec<u8>> {
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    encrypt_with(&SecretKey::random(&mut OsRng), &salt, ua_public, auth, plaintext)
}

/// `encrypt` with the sender's (one-off) key and the salt given.
fn encrypt_with(as_secret: &SecretKey, salt: &[u8; 16], ua_public: &[u8], auth: &[u8], plaintext: &[u8]) -> Result<Vec<u8>> {
    let ua = PublicKey::from_sec1_bytes(ua_public).map_err(|_| anyhow!("the subscription's key isn't a P-256 public key"))?;
    let as_public = as_secret.public_key().to_encoded_point(false);
    let ecdh = p256::ecdh::diffie_hellman(as_secret.to_nonzero_scalar(), ua.as_affine());
    // IKM = HKDF(auth secret, ECDH secret, "WebPush: info" 0 ua_public as_public)
    let mut key_info = b"WebPush: info\0".to_vec();
    key_info.extend_from_slice(ua_public);
    key_info.extend_from_slice(as_public.as_bytes());
    let mut ikm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(auth), ecdh.raw_secret_bytes()).expand(&key_info, &mut ikm).map_err(|_| anyhow!("HKDF"))?;
    // The content encryption key and nonce, from the salt (RFC 8188).
    let prk = Hkdf::<Sha256>::new(Some(&salt[..]), &ikm);
    let (mut cek, mut nonce) = ([0u8; 16], [0u8; 12]);
    prk.expand(b"Content-Encoding: aes128gcm\0", &mut cek).map_err(|_| anyhow!("HKDF"))?;
    prk.expand(b"Content-Encoding: nonce\0", &mut nonce).map_err(|_| anyhow!("HKDF"))?;
    // One record, the last: the text and its padding delimiter (2), and no padding.
    if plaintext.len() + 1 + 16 > RECORD_SIZE as usize - 86 {
        bail!("the message is too long to push");
    }
    let mut record = plaintext.to_vec();
    record.push(2);
    let sealed = Aes128Gcm::new_from_slice(&cek).unwrap().encrypt(Nonce::from_slice(&nonce), record.as_slice()).map_err(|_| anyhow!("encrypting the message"))?;
    // salt, record size, the sender's public key as the key id, then the record.
    let mut body = salt.to_vec();
    body.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    body.push(as_public.as_bytes().len() as u8);
    body.extend_from_slice(as_public.as_bytes());
    body.extend_from_slice(&sealed);
    Ok(body)
}

// ---------- VAPID (RFC 8292) ----------

/// The `Authorization` header for a push to `endpoint`: a token signed with the board's key, for
/// the push service's origin, valid for 12 hours from `now` (a Unix time).
fn authorization(v: &Vapid, endpoint: &str, sub: &str, now: i64) -> Result<String> {
    let url = reqwest::Url::parse(endpoint).context("the endpoint isn't a URL")?;
    let header = B64.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
    let claims = B64.encode(json!({"aud": url.origin().ascii_serialization(), "exp": now + 12 * 3600, "sub": sub}).to_string());
    let signed = format!("{header}.{claims}");
    let sig: Signature = v.key.sign(signed.as_bytes());
    Ok(format!("vapid t={signed}.{}, k={}", B64.encode(sig.to_bytes()), v.public_key()))
}

// ---------- subscriptions ----------

/// Which events a device gets: HA-8's (app/src/notifications.ts), with the same defaults.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Events {
    #[serde(default = "yes")]
    pub attention: bool,
    #[serde(default = "yes")]
    pub review: bool,
    #[serde(default)]
    pub merge: bool,
    #[serde(default)]
    pub done: bool,
}

fn yes() -> bool {
    true
}

impl Default for Events {
    fn default() -> Self {
        Self { attention: true, review: true, merge: false, done: false }
    }
}

impl Events {
    fn wants(&self, e: Event) -> bool {
        match e {
            Event::Attention => self.attention,
            Event::Review => self.review,
            Event::Merge => self.merge,
            Event::Done => self.done,
        }
    }
}

/// A device's subscription, as the API shows it: its endpoint's push service, but not its keys.
#[derive(Serialize, Clone, Debug)]
pub struct Subscription {
    pub id: String,
    pub endpoint: String,
    /// What the device calls itself ("Chrome on Android"), to tell them apart.
    pub name: String,
    pub events: Events,
    pub created_at: String,
    pub last_sent_at: Option<String>,
    /// Why the last push to it failed, until one works.
    pub last_error: Option<String>,
    #[serde(skip)]
    p256dh: Vec<u8>,
    #[serde(skip)]
    auth: Vec<u8>,
}

impl Subscription {
    fn from_row(r: &rusqlite::Row) -> rusqlite::Result<Self> {
        let events: String = r.get("events")?;
        Ok(Self {
            id: r.get("id")?,
            endpoint: r.get("endpoint")?,
            name: r.get("name")?,
            events: serde_json::from_str(&events).unwrap_or_default(),
            created_at: r.get("created_at")?,
            last_sent_at: r.get("last_sent_at")?,
            last_error: r.get("last_error")?,
            p256dh: B64.decode(r.get::<_, String>("p256dh")?).unwrap_or_default(),
            auth: B64.decode(r.get::<_, String>("auth")?).unwrap_or_default(),
        })
    }
}

pub fn list(c: &Connection) -> Result<Vec<Subscription>> {
    let mut st = c.prepare("SELECT * FROM push_subscriptions ORDER BY created_at")?;
    let rows = st.query_map([], Subscription::from_row)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

fn get(c: &Connection, id: &str) -> Result<Option<Subscription>> {
    Ok(c.query_row("SELECT * FROM push_subscriptions WHERE id=?1", [id], Subscription::from_row).optional()?)
}

/// Push services' endpoints are HTTPS; plain HTTP only to this machine (for tests).
fn check_endpoint(endpoint: &str) -> ApiResult<()> {
    let url = reqwest::Url::parse(endpoint).map_err(|_| ApiError::bad("endpoint must be a URL"))?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if url.scheme() == "https" || (url.scheme() == "http" && local) {
        Ok(())
    } else {
        Err(ApiError::bad("endpoint must be an https: URL"))
    }
}

// ---------- sending ----------

/// What a push says: the notification's title and text, the page tapping it opens, and its tag (a
/// task's notification replaces the one before it).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Message {
    pub title: String,
    pub body: String,
    pub url: String,
    pub tag: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<Event>,
}

/// Sends `msg` to `sub`, and notes how it went. A subscription its push service says is gone (the
/// device unsubscribed, or the browser's data was cleared) is deleted.
pub async fn send(s: &Shared, sub: &Subscription, msg: &Message, urgent: bool) -> Result<()> {
    let result = deliver(s, sub, msg, urgent).await;
    let c = s.db();
    match &result {
        Ok(()) => {
            c.execute("UPDATE push_subscriptions SET last_sent_at=?1, last_error=NULL WHERE id=?2", params![now(), sub.id])?;
        }
        Err(Gone(_)) => {
            tracing::info!("push subscription {} ({}) is gone; deleting it", sub.id, sub.name);
            c.execute("DELETE FROM push_subscriptions WHERE id=?1", [&sub.id])?;
        }
        Err(Failed(e)) => {
            tracing::warn!("push to {} ({}) failed: {e}", sub.id, sub.name);
            c.execute("UPDATE push_subscriptions SET last_error=?1 WHERE id=?2", params![e, sub.id])?;
        }
    }
    drop(c);
    result.map_err(|e| anyhow!("{}", e.message()))
}

enum Undelivered {
    /// The push service no longer has the subscription.
    Gone(String),
    Failed(String),
}
use Undelivered::{Failed, Gone};

impl Undelivered {
    fn message(&self) -> &str {
        match self {
            Gone(e) | Failed(e) => e,
        }
    }
}

async fn deliver(s: &Shared, sub: &Subscription, msg: &Message, urgent: bool) -> std::result::Result<(), Undelivered> {
    let body = encrypt(&sub.p256dh, &sub.auth, json!(msg).to_string().as_bytes()).map_err(|e| Failed(format!("{e:#}")))?;
    let auth = {
        let v = vapid(&s.db()).map_err(|e| Failed(format!("{e:#}")))?;
        authorization(&v, &sub.endpoint, &subject(), chrono::Utc::now().timestamp()).map_err(|e| Failed(format!("{e:#}")))?
    };
    // A newer message about the same task replaces one still waiting to be delivered.
    let topic = hex(&Sha256::digest(msg.tag.as_bytes())[..16]);
    let res = s
        .push
        .client
        .post(&sub.endpoint)
        .header("Authorization", auth)
        .header("Content-Encoding", "aes128gcm")
        .header("Content-Type", "application/octet-stream")
        // Kept for a day while the device is offline.
        .header("TTL", "86400")
        .header("Urgency", if urgent { "high" } else { "normal" })
        .header("Topic", topic)
        .body(body)
        .send()
        .await
        .map_err(|e| Failed(format!("couldn't reach the push service: {e}")))?;
    let status = res.status();
    if status.is_success() {
        return Ok(());
    }
    let text: String = res.text().await.unwrap_or_default().chars().take(300).collect();
    let e = format!("the push service answered {status}{}", if text.trim().is_empty() { String::new() } else { format!(": {}", text.trim()) });
    Err(if matches!(status.as_u16(), 404 | 410) { Gone(e) } else { Failed(e) })
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ---------- events ----------

/// HA-8's events (`NotifyEvent` in app/src/notifications.ts).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Event {
    Attention,
    Review,
    Merge,
    Done,
}

impl Event {
    /// The column it's about, where a move the user made doesn't notify (see `PushState::moved`).
    fn status(self) -> &'static str {
        match self {
            Event::Attention => "needs_attention",
            Event::Review => "in_review",
            Event::Merge => "ready_for_merge",
            Event::Done => "done",
        }
    }
}

/// What the server says when the user stopped the run: their own doing, so it doesn't notify.
const STOPPED: &str = "Stopped by user";

/// How long a task that's ready to review has to stay so before it notifies (`REVIEW_GRACE_MS`).
const REVIEW_GRACE: Duration = Duration::from_secs(5);

/// How long a move the user made keeps its notification away (`MOVE_MS` in app/src/api.ts).
const MOVE_GRACE: Duration = Duration::from_secs(15);

fn status(t: &Value) -> &str {
    t["status"].as_str().unwrap_or("")
}

/// In review, with its agent stopped and its review passed or none running (`readyToCheck`).
fn ready_to_check(t: &Value) -> bool {
    status(t) == "in_review" && t["running"] != json!(true) && (t["review"].is_null() || t["review"]["state"] == "passed")
}

/// What a change of task `prev` to `next` notifies of, if anything (`taskEvent`).
pub fn task_event(prev: &Value, next: &Value) -> Option<Event> {
    if next["kind"] != "task" {
        return None;
    }
    if status(next) == "needs_attention" && status(prev) != "needs_attention" {
        return (next["attention_reason"] != STOPPED).then_some(Event::Attention);
    }
    if ready_to_check(next) && !ready_to_check(prev) {
        return Some(Event::Review);
    }
    if status(next) == "ready_for_merge" && status(prev) != "ready_for_merge" {
        return Some(Event::Merge);
    }
    if status(next) == "done" && status(prev) != "done" {
        return Some(Event::Done);
    }
    None
}

/// Whether task `t` is still as event `e` said (`stillApplies`).
fn still_applies(e: Event, t: &Value) -> bool {
    if e == Event::Review { ready_to_check(t) } else { status(t) == e.status() }
}

/// A notification's title and text: the task's key and title, and what happened (`notificationText`).
pub fn notification_text(e: Event, t: &Value, key: &str) -> (String, String) {
    let body = match e {
        Event::Attention => match t["attention_reason"].as_str().filter(|r| !r.is_empty()) {
            Some(r) => format!("Needs attention: {r}"),
            None => "Needs attention".into(),
        },
        Event::Review if t["review"]["state"] == "passed" => "Ready to review: its review passed".into(),
        Event::Review => "Ready to review".into(),
        Event::Merge => "Ready for merge".into(),
        Event::Done => match t["resolution"].as_str().unwrap_or("done") {
            "not_done" => "Closed: not done".into(),
            "wont_fix" => "Closed: won't fix".into(),
            _ => "Done".into(),
        },
    };
    let body = if body.chars().count() > 200 { format!("{}…", body.chars().take(199).collect::<String>()) } else { body };
    (format!("{key} {}", t["title"].as_str().unwrap_or("")), body)
}

/// What goes before a task's number (`keyPrefix`): its project's key, `G` for a group task, `S` for
/// a scratch task.
async fn task_key(s: &Shared, host_id: &str, t: &Value) -> String {
    let prefix = match t["project_id"].as_str() {
        Some(p) if host_id == s.host_id => local_project_key(s, p),
        Some(p) => crate::hub::host_request(s, host_id, "GET", &format!("/api/projects/{p}"), None).await.ok().and_then(|p| p["key"].as_str().map(String::from)),
        None if t["group_name"].is_string() => Some("G".into()),
        None if t["task_type"] == "scratch" => Some("S".into()),
        None => None,
    };
    format!("{}-{}", prefix.unwrap_or_else(|| "T".into()), t["number"])
}

fn local_project_key(s: &Shared, id: &str) -> Option<String> {
    db::get_project(&s.db(), id).ok().flatten().map(|p| p.key)
}

// ---------- watching the board ----------

/// What the board keeps for push while it runs.
pub struct PushState {
    client: reqwest::Client,
    /// The latest state of every task on the board, by `<host>:<id>`, to tell what changed.
    tasks: Mutex<HashMap<String, Value>>,
    /// The tasks whose "ready to review" waits out its grace period.
    pending: Mutex<HashSet<String>>,
    /// The columns tasks were moved to by the user lately (through this board's API), by `<host>:<id>`.
    moves: Mutex<HashMap<String, (String, Instant)>>,
}

impl Default for PushState {
    fn default() -> Self {
        Self {
            client: reqwest::Client::builder().timeout(Duration::from_secs(30)).build().unwrap_or_default(),
            tasks: Default::default(),
            pending: Default::default(),
            moves: Default::default(),
        }
    }
}

impl PushState {
    /// The user moved task `id` on `host_id` to `status` themselves (from the UI), so that doesn't notify them.
    pub fn note_move(&self, host_id: &str, id: &str, status: &str) {
        let mut moves = self.moves.lock().unwrap();
        moves.retain(|_, (_, at)| at.elapsed() < MOVE_GRACE);
        moves.insert(format!("{host_id}:{id}"), (status.to_string(), Instant::now()));
    }

    fn moved(&self, key: &str, e: Event) -> bool {
        self.moves.lock().unwrap().get(key).is_some_and(|(s, at)| s == e.status() && at.elapsed() < MOVE_GRACE)
    }
}

/// Watches the task events of every host on the board and pushes the ones devices want.
pub fn start(s: &Shared) {
    let st = s.clone();
    let mut rx = s.hub_events.subscribe();
    tokio::spawn(async move {
        // What the tasks are now: what they change from. Linked hosts' as they connect.
        let mut known: HashSet<String> = HashSet::new();
        load_host(&st, &st.host_id.clone()).await;
        known.insert(st.host_id.clone());
        loop {
            let ev = match rx.recv().await {
                Ok(ev) => ev,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    // Missed some: start again from how things are now.
                    known.clear();
                    known.insert(st.host_id.clone());
                    load_host(&st, &st.host_id.clone()).await;
                    for h in linked(&st) {
                        load_host(&st, &h).await;
                        known.insert(h);
                    }
                    continue;
                }
                Err(_) => break,
            };
            let host = ev["host_id"].as_str().unwrap_or(&st.host_id).to_string();
            match ev["type"].as_str() {
                Some("task") => observe(&st, &host, &ev["task"]),
                Some("task_deleted") => {
                    if let Some(id) = ev["id"].as_str() {
                        st.push.tasks.lock().unwrap().remove(&format!("{host}:{id}"));
                    }
                }
                Some("resync") => load_host(&st, &host).await,
                Some("hosts_changed") => {
                    let now = linked(&st);
                    // Gone hosts are loaded again when they're back.
                    known.retain(|h| *h == st.host_id || now.contains(h));
                    for h in now {
                        if known.insert(h.clone()) {
                            load_host(&st, &h).await;
                        }
                    }
                }
                _ => {}
            }
        }
    });
}

/// The linked hosts that are connected.
fn linked(s: &Shared) -> Vec<String> {
    s.links.lock().unwrap().keys().cloned().collect()
}

/// Takes host `host`'s tasks as they are, without notifying of them: they were so before anything here could tell.
async fn load_host(s: &Shared, host: &str) {
    let tasks: Vec<Value> = if host == s.host_id {
        match local_tasks(s) {
            Ok(ts) => ts,
            Err(e) => return tracing::warn!("push: reading the tasks: {e:#}"),
        }
    } else {
        let mut all = vec![];
        let profiles = match crate::hub::host_request(s, host, "GET", "/api/profiles", None).await {
            Ok(p) => p,
            Err(e) => return tracing::warn!("push: reading {host}'s profiles: {}", e.1),
        };
        for p in profiles.as_array().into_iter().flatten() {
            let Some(id) = p["id"].as_str() else { continue };
            if let Ok(Value::Array(ts)) = crate::hub::host_request(s, host, "GET", &format!("/api/profiles/{id}/tasks"), None).await {
                all.extend(ts);
            }
        }
        all
    };
    let mut known = s.push.tasks.lock().unwrap();
    for t in tasks {
        if let Some(id) = t["id"].as_str() {
            known.insert(format!("{host}:{id}"), t);
        }
    }
}

fn local_tasks(s: &Shared) -> Result<Vec<Value>> {
    Ok(db::list_all_tasks(&s.db())?.iter().map(|t| json!(t)).collect())
}

/// A task as it is now: notifies of what changed since it was last seen (nothing for one first seen).
fn observe(s: &Shared, host: &str, t: &Value) {
    let Some(id) = t["id"].as_str() else { return };
    let key = format!("{host}:{id}");
    let Some(prev) = s.push.tasks.lock().unwrap().insert(key.clone(), t.clone()) else { return };
    let Some(e) = task_event(&prev, t) else { return };
    if s.push.moved(&key, e) {
        return;
    }
    if e != Event::Review {
        return spawn_notify(s, host, t.clone(), e);
    }
    // A review starts a moment after the run ends, and a run can carry on straight away: ready to
    // review only once it has stayed so for a few seconds.
    if !s.push.pending.lock().unwrap().insert(key.clone()) {
        return;
    }
    let (st, host) = (s.clone(), host.to_string());
    tokio::spawn(async move {
        tokio::time::sleep(REVIEW_GRACE).await;
        st.push.pending.lock().unwrap().remove(&key);
        let now = st.push.tasks.lock().unwrap().get(&key).cloned();
        if let Some(t) = now.filter(|t| still_applies(Event::Review, t)) {
            notify(&st, &host, &t, Event::Review).await;
        }
    });
}

fn spawn_notify(s: &Shared, host: &str, t: Value, e: Event) {
    let (st, host) = (s.clone(), host.to_string());
    tokio::spawn(async move { notify(&st, &host, &t, e).await });
}

/// Pushes event `e` of task `t` to the devices that want it.
async fn notify(s: &Shared, host: &str, t: &Value, e: Event) {
    let subs = match list(&s.db()) {
        Ok(subs) => subs.into_iter().filter(|x| x.events.wants(e)).collect::<Vec<_>>(),
        Err(e) => return tracing::warn!("push: reading the subscriptions: {e:#}"),
    };
    if subs.is_empty() {
        return;
    }
    let (title, body) = notification_text(e, t, &task_key(s, host, t).await);
    let id = t["id"].as_str().unwrap_or_default();
    let msg = Message { title, body, url: format!("/t/{id}"), tag: format!("{host}:{id}"), task_id: Some(id.into()), event: Some(e) };
    for sub in subs {
        let _ = send(s, &sub, &msg, e == Event::Attention).await;
    }
}

// ---------- API ----------

/// The board's public key, to subscribe with, and the devices that have.
pub async fn info(State(s): State<Shared>) -> ApiResult<Json<Value>> {
    let c = s.db();
    Ok(Json(json!({"public_key": vapid(&c)?.public_key(), "subscriptions": list(&c)?})))
}

#[derive(Deserialize)]
pub struct Subscribe {
    endpoint: String,
    keys: Keys,
    #[serde(default)]
    name: String,
    #[serde(default)]
    events: Option<Events>,
}

#[derive(Deserialize)]
pub struct Keys {
    p256dh: String,
    auth: String,
}

/// Adds a device's subscription (`PushSubscription.toJSON()`), or updates the one with its endpoint.
pub async fn subscribe(State(s): State<Shared>, Json(b): Json<Subscribe>) -> ApiResult<Json<Value>> {
    check_endpoint(&b.endpoint)?;
    let p256dh = B64.decode(b.keys.p256dh.trim_end_matches('=')).ok().filter(|k| PublicKey::from_sec1_bytes(k).is_ok() && k.len() == 65);
    let auth = B64.decode(b.keys.auth.trim_end_matches('=')).ok().filter(|a| a.len() == 16);
    let (Some(p256dh), Some(auth)) = (p256dh, auth) else {
        return Err(ApiError::bad("keys must have the subscription's p256dh public key and 16-byte auth secret"));
    };
    let name: String = b.name.trim().chars().take(100).collect();
    let c = s.db();
    let old = c.query_row("SELECT id FROM push_subscriptions WHERE endpoint=?1", [&b.endpoint], |r| r.get::<_, String>(0)).optional()?;
    let id = match old {
        Some(id) => {
            c.execute(
                "UPDATE push_subscriptions SET p256dh=?1, auth=?2, name=?3, events=COALESCE(?4, events), last_error=NULL WHERE id=?5",
                params![B64.encode(&p256dh), B64.encode(&auth), name, b.events.map(|e| json!(e).to_string()), id],
            )?;
            id
        }
        None => {
            let id = crate::util::new_id();
            c.execute(
                "INSERT INTO push_subscriptions (id,endpoint,p256dh,auth,name,events,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![id, b.endpoint, B64.encode(&p256dh), B64.encode(&auth), name, json!(b.events.unwrap_or_default()).to_string(), now()],
            )?;
            id
        }
    };
    Ok(Json(json!(get(&c, &id)?.ok_or_else(|| ApiError::not_found("subscription"))?)))
}

#[derive(Deserialize)]
pub struct Change {
    name: Option<String>,
    events: Option<Events>,
}

/// Changes a device's name or the events it gets.
pub async fn update(State(s): State<Shared>, Path(id): Path<String>, Json(b): Json<Change>) -> ApiResult<Json<Value>> {
    let c = s.db();
    if get(&c, &id)?.is_none() {
        return Err(ApiError::not_found("subscription"));
    }
    if let Some(name) = b.name {
        c.execute("UPDATE push_subscriptions SET name=?1 WHERE id=?2", params![name.trim().chars().take(100).collect::<String>(), id])?;
    }
    if let Some(events) = b.events {
        c.execute("UPDATE push_subscriptions SET events=?1 WHERE id=?2", params![json!(events).to_string(), id])?;
    }
    Ok(Json(json!(get(&c, &id)?.ok_or_else(|| ApiError::not_found("subscription"))?)))
}

pub async fn unsubscribe(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let n = s.db().execute("DELETE FROM push_subscriptions WHERE id=?1", [&id])?;
    if n == 0 {
        return Err(ApiError::not_found("subscription"));
    }
    Ok(Json(json!({"ok": true})))
}

/// Pushes a test notification to a device, and says whether its push service took it.
pub async fn test(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let sub = get(&s.db(), &id)?.ok_or_else(|| ApiError::not_found("subscription"))?;
    let msg = Message {
        title: "Huntaway".into(),
        body: "Push notifications work on this device.".into(),
        url: "/settings".into(),
        tag: "test".into(),
        task_id: None,
        event: None,
    };
    send(&s, &sub, &msg, true).await.map_err(|e| ApiError(axum::http::StatusCode::BAD_GATEWAY, format!("{e:#}")))?;
    Ok(Json(json!({"ok": true})))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing;
    use axum::body::Bytes;
    use axum::http::HeaderMap;
    use p256::ecdsa::signature::Verifier;
    use p256::ecdsa::VerifyingKey;
    use std::sync::atomic::{AtomicU16, Ordering};
    use std::sync::Arc;
    use tokio::sync::mpsc;
    use tower::ServiceExt;

    fn b64(s: &str) -> Vec<u8> {
        B64.decode(s).unwrap()
    }

    /// What a browser does with a push it gets (RFC 8291 section 3.4, the other way round).
    fn decrypt(ua: &SecretKey, auth: &[u8], body: &[u8]) -> Vec<u8> {
        let (salt, rest) = body.split_at(16);
        assert_eq!(u32::from_be_bytes(rest[..4].try_into().unwrap()), RECORD_SIZE);
        let idlen = rest[4] as usize;
        let (as_public, sealed) = rest[5..].split_at(idlen);
        let ecdh = p256::ecdh::diffie_hellman(ua.to_nonzero_scalar(), PublicKey::from_sec1_bytes(as_public).unwrap().as_affine());
        let mut key_info = b"WebPush: info\0".to_vec();
        key_info.extend_from_slice(ua.public_key().to_encoded_point(false).as_bytes());
        key_info.extend_from_slice(as_public);
        let mut ikm = [0u8; 32];
        Hkdf::<Sha256>::new(Some(auth), ecdh.raw_secret_bytes()).expand(&key_info, &mut ikm).unwrap();
        let prk = Hkdf::<Sha256>::new(Some(salt), &ikm);
        let (mut cek, mut nonce) = ([0u8; 16], [0u8; 12]);
        prk.expand(b"Content-Encoding: aes128gcm\0", &mut cek).unwrap();
        prk.expand(b"Content-Encoding: nonce\0", &mut nonce).unwrap();
        let mut plain = Aes128Gcm::new_from_slice(&cek).unwrap().decrypt(Nonce::from_slice(&nonce), sealed).unwrap();
        // The last record ends in 2, then any padding of zeros.
        while plain.last() == Some(&0) {
            plain.pop();
        }
        assert_eq!(plain.pop(), Some(2));
        plain
    }

    #[test]
    fn encryption_matches_the_rfc_8291_example() {
        // RFC 8291, section 5 and appendix A.
        let as_secret = SecretKey::from_slice(&b64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")).unwrap();
        let salt: [u8; 16] = b64("DGv6ra1nlYgDCS1FRnbzlw").try_into().unwrap();
        let ua_public = b64("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
        let auth = b64("BTBZMqHH6r4Tts7J_aSIgg");
        let body = encrypt_with(&as_secret, &salt, &ua_public, &auth, b"When I grow up, I want to be a watermelon").unwrap();
        let expected = concat!(
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95",
            "bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
        );
        assert_eq!(B64.encode(&body), expected);
        // And the user agent's key reads it.
        let ua = SecretKey::from_slice(&b64("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94")).unwrap();
        assert_eq!(decrypt(&ua, &auth, &body), b"When I grow up, I want to be a watermelon");
    }

    #[test]
    fn each_message_gets_its_own_key_and_salt() {
        let ua = SecretKey::random(&mut OsRng);
        let ua_public = ua.public_key().to_encoded_point(false).as_bytes().to_vec();
        let auth = [7u8; 16];
        let (a, b) = (encrypt(&ua_public, &auth, b"hello").unwrap(), encrypt(&ua_public, &auth, b"hello").unwrap());
        assert_ne!(a[..86], b[..86]);
        assert_eq!(decrypt(&ua, &auth, &a), b"hello");
        assert_eq!(decrypt(&ua, &auth, &b), b"hello");
        // Too long for one record, or a key that isn't one.
        assert!(encrypt(&ua_public, &auth, &[b'x'; 4000]).is_err());
        assert!(encrypt(&[4u8; 65], &auth, b"hello").is_err());
    }

    #[test]
    fn the_vapid_key_is_made_once_and_signs_tokens_for_the_push_service() {
        let s = testing::state();
        let v = vapid(&s.db()).unwrap();
        assert_eq!(vapid(&s.db()).unwrap().public_key(), v.public_key());
        assert_eq!(v.public.len(), 65);
        let header = authorization(&v, "https://fcm.googleapis.com/fcm/send/abc:def", "mailto:me@example.com", 1_000_000).unwrap();
        let (t, k) = header.strip_prefix("vapid t=").unwrap().split_once(", k=").unwrap();
        assert_eq!(k, v.public_key());
        let parts: Vec<&str> = t.split('.').collect();
        assert_eq!(serde_json::from_slice::<Value>(&b64(parts[0])).unwrap(), json!({"typ": "JWT", "alg": "ES256"}));
        assert_eq!(
            serde_json::from_slice::<Value>(&b64(parts[1])).unwrap(),
            json!({"aud": "https://fcm.googleapis.com", "exp": 1_000_000 + 12 * 3600, "sub": "mailto:me@example.com"})
        );
        let key = VerifyingKey::from_sec1_bytes(&b64(k)).unwrap();
        let sig = Signature::from_slice(&b64(parts[2])).unwrap();
        key.verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &sig).unwrap();
    }

    fn task(status: &str) -> Value {
        json!({"id": "t1", "kind": "task", "number": 3, "title": "Fix the login", "status": status, "running": false, "review": null, "attention_reason": null})
    }

    fn with(mut t: Value, fields: Value) -> Value {
        for (k, v) in fields.as_object().unwrap() {
            t[k] = v.clone();
        }
        t
    }

    #[test]
    fn task_changes_notify_as_the_ui_does() {
        let working = with(task("in_progress"), json!({"running": true}));
        let asks = with(task("needs_attention"), json!({"running": true, "attention_reason": "Approve Bash?"}));
        assert_eq!(task_event(&working, &asks), Some(Event::Attention));
        // Not again while it stays there, nor for a run the user stopped, nor for a review thread.
        assert_eq!(task_event(&asks, &with(asks.clone(), json!({"attention_reason": "Approve Write?"}))), None);
        assert_eq!(task_event(&working, &with(task("needs_attention"), json!({"attention_reason": STOPPED}))), None);
        assert_eq!(task_event(&working, &with(asks.clone(), json!({"kind": "review"}))), None);
        // In review: once its agent stopped and its review passed (or with none).
        let reviewing = with(task("in_review"), json!({"review": {"state": "running"}}));
        assert_eq!(task_event(&working, &reviewing), None);
        assert_eq!(task_event(&reviewing, &with(task("in_review"), json!({"review": {"state": "issues"}}))), None);
        let passed = with(task("in_review"), json!({"review": {"state": "passed"}}));
        assert_eq!(task_event(&reviewing, &passed), Some(Event::Review));
        assert_eq!(task_event(&working, &task("in_review")), Some(Event::Review));
        assert_eq!(task_event(&working, &with(task("in_review"), json!({"running": true}))), None);
        assert_eq!(task_event(&passed, &task("ready_for_merge")), Some(Event::Merge));
        assert_eq!(task_event(&task("ready_for_merge"), &task("done")), Some(Event::Done));
        assert_eq!(task_event(&task("done"), &task("done")), None);

        assert_eq!(notification_text(Event::Attention, &asks, "WEB-3"), ("WEB-3 Fix the login".into(), "Needs attention: Approve Bash?".into()));
        assert_eq!(notification_text(Event::Review, &passed, "WEB-3").1, "Ready to review: its review passed");
        assert_eq!(notification_text(Event::Done, &with(task("done"), json!({"resolution": "wont_fix"})), "WEB-3").1, "Closed: won't fix");
        let long = notification_text(Event::Attention, &with(asks, json!({"attention_reason": "x".repeat(300)})), "WEB-3").1;
        assert_eq!(long.chars().count(), 200);
        assert!(long.ends_with('…'));
    }

    /// A push service on this machine: it takes what's posted to it, answering with `status`.
    async fn push_service(status: Arc<AtomicU16>) -> (String, mpsc::UnboundedReceiver<(HeaderMap, Bytes)>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let app = axum::Router::new().route(
            "/push/{id}",
            axum::routing::post(move |headers: HeaderMap, body: Bytes| {
                let (tx, status) = (tx.clone(), status.clone());
                async move {
                    let _ = tx.send((headers, body));
                    axum::http::StatusCode::from_u16(status.load(Ordering::SeqCst)).unwrap()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/push/device-1", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (url, rx)
    }

    async fn api(s: &Shared, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
        let req = axum::http::Request::builder()
            .method(method)
            .uri(path)
            .header("authorization", "Bearer ")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(body.map(|b| b.to_string()).unwrap_or_default()))
            .unwrap();
        let res = crate::api::router(s.clone()).oneshot(req).await.unwrap();
        let status = res.status().as_u16();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    fn device() -> (SecretKey, Value) {
        let ua = SecretKey::random(&mut OsRng);
        let keys = json!({"p256dh": B64.encode(ua.public_key().to_encoded_point(false).as_bytes()), "auth": B64.encode([9u8; 16])});
        (ua, keys)
    }

    #[test]
    fn devices_subscribe_change_their_events_and_unsubscribe() {
        testing::run(async || {
            let s = testing::state();
            let (status, info) = api(&s, "GET", "/api/push", None).await;
            assert_eq!(status, 200);
            assert_eq!(b64(info["public_key"].as_str().unwrap()).len(), 65);
            assert_eq!(info["subscriptions"], json!([]));

            let (_, keys) = device();
            let endpoint = "https://push.example.com/send/abc";
            let (status, sub) = api(&s, "POST", "/api/push/subscriptions", Some(json!({"endpoint": endpoint, "keys": keys, "name": "Pixel"}))).await;
            assert_eq!(status, 200, "{sub}");
            assert_eq!(sub["events"], json!({"attention": true, "review": true, "merge": false, "done": false}));
            assert_eq!(sub["name"], "Pixel");
            assert!(sub.get("auth").is_none() && sub.get("p256dh").is_none());
            let id = sub["id"].as_str().unwrap().to_string();

            // The same endpoint again (a browser that subscribed again) is the same device, keeping its events.
            let events = json!({"events": {"attention": true, "review": false, "merge": true, "done": false}});
            let (_, events) = api(&s, "PATCH", &format!("/api/push/subscriptions/{id}"), Some(events)).await;
            assert_eq!(events["events"]["merge"], true);
            let (_, again) = api(&s, "POST", "/api/push/subscriptions", Some(json!({"endpoint": endpoint, "keys": keys, "name": "Pixel 8"}))).await;
            assert_eq!((again["id"].as_str(), again["name"].as_str(), again["events"]["merge"].as_bool()), (Some(id.as_str()), Some("Pixel 8"), Some(true)));
            assert_eq!(api(&s, "GET", "/api/push", None).await.1["subscriptions"].as_array().unwrap().len(), 1);

            // Endpoints are HTTPS (HTTP only on this machine), and keys have to be real.
            for (body, why) in [
                (json!({"endpoint": "http://push.example.com/x", "keys": keys}), "https"),
                (json!({"endpoint": "not a url", "keys": keys}), "URL"),
                (json!({"endpoint": endpoint, "keys": {"p256dh": B64.encode([4u8; 65]), "auth": B64.encode([1u8; 16])}}), "p256dh"),
                (json!({"endpoint": endpoint, "keys": {"p256dh": keys["p256dh"], "auth": B64.encode([1u8; 8])}}), "auth"),
            ] {
                let (status, err) = api(&s, "POST", "/api/push/subscriptions", Some(body)).await;
                assert_eq!(status, 400);
                assert!(err["error"].as_str().unwrap().contains(why), "{err}");
            }

            assert_eq!(api(&s, "DELETE", &format!("/api/push/subscriptions/{id}"), None).await.0, 200);
            assert_eq!(api(&s, "DELETE", &format!("/api/push/subscriptions/{id}"), None).await.0, 404);
            assert_eq!(api(&s, "GET", "/api/push", None).await.1["subscriptions"], json!([]));
        })
    }

    /// The board's task event for task `t` on this host.
    fn emit(s: &Shared, t: &Value) {
        let _ = s.hub_events.send(json!({"type": "task", "task": t, "host_id": s.host_id}));
    }

    #[test]
    fn task_events_are_pushed_encrypted_to_the_devices_that_want_them() {
        testing::run(async || {
            let s = testing::state();
            let (url, mut got) = push_service(Arc::new(AtomicU16::new(201))).await;
            let (ua, keys) = device();
            let events = json!({"attention": true, "review": false, "merge": true, "done": true});
            let (_, sub) = api(&s, "POST", "/api/push/subscriptions", Some(json!({"endpoint": url, "keys": keys, "name": "phone", "events": events}))).await;
            // A device that only wants reviews gets none of these.
            let (_, other) = device();
            let none = json!({"attention": false, "review": true, "merge": false, "done": false});
            api(&s, "POST", "/api/push/subscriptions", Some(json!({"endpoint": format!("{url}-other"), "keys": other, "events": none}))).await;
            let profile = db::insert_profile(&s.db(), "work", &[], None).unwrap();
            let x = "/x";
            let p = db::NewProject {
                id: "p1",
                profile_id: &profile.id,
                name: "Web",
                key: "WEB",
                repo_path: x,
                scratch_path: x,
                worktrees_root: x,
                base_branch: None,
                use_worktrees: false,
            };
            let project = db::insert_project(&s.db(), p).unwrap();
            let new = db::NewTask {
                profile_id: &profile.id,
                project_id: Some(&project.id),
                kind: "task",
                title: "Fix the login",
                description: "",
                status: "in_progress",
                use_worktree: false,
                model: None,
                effort: None,
                claude_config_id: None,
            };
            let t = json!(db::insert_task(&s.db(), new).unwrap());
            start(&s);

            emit(&s, &with(t.clone(), json!({"status": "needs_attention", "attention_reason": "Approve Bash?", "running": true})));
            let (headers, body) = got.recv().await.unwrap();
            let msg: Value = serde_json::from_slice(&decrypt(&ua, &[9u8; 16], &body)).unwrap();
            let id = t["id"].as_str().unwrap();
            let title = format!("WEB-{} Fix the login", t["number"]);
            let (url, tag) = (format!("/t/{id}"), format!("h:{id}"));
            let want = json!({"title": title, "body": "Needs attention: Approve Bash?", "url": url, "tag": tag, "task_id": id, "event": "attention"});
            assert_eq!(msg, want);
            let header = |k: &str| headers.get(k).unwrap().to_str().unwrap().to_string();
            assert_eq!((header("content-encoding"), header("ttl"), header("urgency")), ("aes128gcm".into(), "86400".into(), "high".into()));
            let public = api(&s, "GET", "/api/push", None).await.1["public_key"].as_str().unwrap().to_string();
            assert!(header("authorization").starts_with("vapid t=") && header("authorization").ends_with(&format!(", k={public}")));
            assert_eq!(header("topic").len(), 32);
            // Noted once the push service has answered.
            let sent = async || {
                let subs = api(&s, "GET", "/api/push", None).await.1["subscriptions"].clone();
                subs.as_array().unwrap().iter().find(|x| x["id"] == sub["id"]).unwrap()["last_sent_at"].is_string()
            };
            while !sent().await {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }

            // A move the user made doesn't notify them; the agent's next one does.
            s.push.note_move("h", id, "ready_for_merge");
            emit(&s, &with(t.clone(), json!({"status": "ready_for_merge"})));
            emit(&s, &with(t.clone(), json!({"status": "done", "resolution": "done"})));
            let (headers, body) = got.recv().await.unwrap();
            let msg: Value = serde_json::from_slice(&decrypt(&ua, &[9u8; 16], &body)).unwrap();
            assert_eq!((msg["body"].as_str(), msg["event"].as_str()), (Some("Done"), Some("done")));
            assert_eq!(headers.get("urgency").unwrap(), "normal");
            assert!(got.try_recv().is_err(), "the device that only wants reviews got one");
        })
    }

    #[test]
    fn a_move_the_user_makes_through_the_board_is_noted() {
        testing::run(async || {
            let s = testing::state();
            let profile = db::insert_profile(&s.db(), "work", &[], None).unwrap();
            let new = db::NewTask {
                profile_id: &profile.id,
                project_id: None,
                kind: "task",
                title: "Scratch",
                description: "",
                status: "todo",
                use_worktree: false,
                model: None,
                effort: None,
                claude_config_id: None,
            };
            let id = db::insert_task(&s.db(), new).unwrap().id;
            let key = format!("h:{id}");
            assert!(!s.push.moved(&key, Event::Merge));
            // The UI's requests for a host go through the hub's proxy.
            let (status, t) = api(&s, "PATCH", &format!("/api/h/h/tasks/{id}"), Some(json!({"status": "ready_for_merge"}))).await;
            assert_eq!(status, 200, "{t}");
            assert!(s.push.moved(&key, Event::Merge));
            assert!(!s.push.moved(&key, Event::Done));
            // Other changes aren't moves.
            api(&s, "PATCH", &format!("/api/h/h/tasks/{id}"), Some(json!({"title": "Renamed"}))).await;
            assert!(s.push.moved(&key, Event::Merge));
        })
    }

    #[test]
    fn ready_to_review_waits_to_see_that_it_stays_so() {
        testing::run(async || {
            let s = testing::state();
            let (url, mut got) = push_service(Arc::new(AtomicU16::new(201))).await;
            let (ua, keys) = device();
            api(&s, "POST", "/api/push/subscriptions", Some(json!({"endpoint": url, "keys": keys}))).await;
            start(&s);
            let working = with(task("in_progress"), json!({"running": true, "id": "t2"}));
            emit(&s, &working);
            // Its review starts straight after: nothing.
            emit(&s, &with(working.clone(), json!({"status": "in_review", "running": false})));
            emit(&s, &with(working.clone(), json!({"status": "in_review", "running": false, "review": {"state": "running"}})));
            // Then it passes, and stays passed.
            emit(&s, &with(working.clone(), json!({"status": "in_review", "running": false, "review": {"state": "passed"}})));
            let started = Instant::now();
            let (_, body) = got.recv().await.unwrap();
            assert!(started.elapsed() >= Duration::from_secs(4));
            let msg: Value = serde_json::from_slice(&decrypt(&ua, &[9u8; 16], &body)).unwrap();
            assert_eq!(msg["body"], "Ready to review: its review passed");
            assert!(got.try_recv().is_err());
        })
    }

    #[test]
    fn a_subscription_its_push_service_has_dropped_is_deleted() {
        testing::run(async || {
            let s = testing::state();
            let status = Arc::new(AtomicU16::new(500));
            let (url, mut got) = push_service(status.clone()).await;
            let (_, keys) = device();
            let (_, sub) = api(&s, "POST", "/api/push/subscriptions", Some(json!({"endpoint": url, "keys": keys}))).await;
            let id = sub["id"].as_str().unwrap();
            let (code, err) = api(&s, "POST", &format!("/api/push/subscriptions/{id}/test"), None).await;
            assert_eq!(code, 502);
            assert!(err["error"].as_str().unwrap().contains("500"), "{err}");
            got.recv().await.unwrap();
            assert!(api(&s, "GET", "/api/push", None).await.1["subscriptions"][0]["last_error"].as_str().unwrap().contains("500"));

            status.store(410, Ordering::SeqCst);
            assert_eq!(api(&s, "POST", &format!("/api/push/subscriptions/{id}/test"), None).await.0, 502);
            assert_eq!(api(&s, "GET", "/api/push", None).await.1["subscriptions"], json!([]));
        })
    }
}
