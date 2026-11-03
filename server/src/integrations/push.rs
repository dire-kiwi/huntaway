//! Web Push: the board's notifications (a task needs attention, is ready to review, and so on; the
//! same events and words as the UI's, in app/src/notifications.ts) sent to the devices that turned
//! push on in Settings → Notifications, such as a phone with the board installed on its home screen.
//!
//! Each device's browser gives a subscription (an endpoint at its push service, and keys), which is
//! kept with the events it wants. This board watches the task events of every host on it (as the UI
//! does), and sends each subscription the ones it wants, encrypted for it (RFC 8291) and signed with
//! the board's VAPID key (RFC 8292), whose public half the browser subscribed with. Tapping one opens
//! the task (app/public/sw.js).
//!
//! A permission prompt is pushed too (the assistant's, or any task's, as each device chooses), with
//! a one-time token (push_answers.rs) for its Allow and Deny actions, which answer it from the
//! notification without the board's token.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, Weak, atomic::{AtomicBool, Ordering}};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use aws_lc_rs::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_128_GCM};
use aws_lc_rs::agreement::{self, UnparsedPublicKey, ECDH_P256};
use aws_lc_rs::encoding::AsBigEndian;
use aws_lc_rs::hkdf::{self, HKDF_SHA256};
use aws_lc_rs::signature::{EcdsaKeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
use aws_lc_rs::{digest, rand};
use axum::extract::{Path, State};
use axum::Json;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

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
    key: EcdsaKeyPair,
    /// The public key, an uncompressed point (65 bytes), as browsers take it (`applicationServerKey`).
    public: Vec<u8>,
}

impl Vapid {
    /// From its private key, a P-256 scalar (32 bytes).
    fn from_private(private: &[u8]) -> Result<Self> {
        let public = public_key(&agreement::PrivateKey::from_private_key(&ECDH_P256, private).map_err(|_| anyhow!("not a P-256 private key"))?)?;
        let key = EcdsaKeyPair::from_private_key_and_public_key(&ECDSA_P256_SHA256_FIXED_SIGNING, private, &public).map_err(|e| anyhow!("{e}"))?;
        Ok(Self { key, public })
    }

    pub fn public_key(&self) -> String {
        B64.encode(&self.public)
    }
}

/// A key's public half, an uncompressed point.
fn public_key(k: &agreement::PrivateKey) -> Result<Vec<u8>> {
    Ok(k.compute_public_key().map_err(|_| anyhow!("computing a public key"))?.as_ref().to_vec())
}

/// The board's VAPID key, made and stored the first time.
pub fn vapid(c: &Connection) -> Result<Vapid> {
    if let Some(saved) = db::get_setting(c, KEY_SETTING)? {
        return Vapid::from_private(&B64.decode(saved.trim()).context("reading the VAPID key")?).context("reading the VAPID key");
    }
    let key = agreement::PrivateKey::generate(&ECDH_P256).map_err(|_| anyhow!("making a key"))?;
    let private: aws_lc_rs::encoding::EcPrivateKeyBin = key.as_be_bytes().map_err(|_| anyhow!("making a key"))?;
    db::set_setting(c, KEY_SETTING, Some(&B64.encode(private.as_ref())))?;
    Vapid::from_private(private.as_ref())
}

// ---------- encryption (RFC 8291) ----------

/// The size of the one record a push message is (RFC 8188's `rs`), which is at most 4096.
const RECORD_SIZE: u32 = 4096;

/// `plaintext` encrypted for a subscription, with its public key (`p256dh`, an uncompressed point)
/// and its authentication secret: the body of the push request (`Content-Encoding: aes128gcm`).
pub fn encrypt(ua_public: &[u8], auth: &[u8], plaintext: &[u8]) -> Result<Vec<u8>> {
    let mut salt = [0u8; 16];
    rand::fill(&mut salt).map_err(|_| anyhow!("no random numbers"))?;
    encrypt_with(&agreement::PrivateKey::generate(&ECDH_P256).map_err(|_| anyhow!("making a key"))?, &salt, ua_public, auth, plaintext)
}

/// HKDF-SHA-256: `len` bytes from `ikm` with `salt` and `info`.
fn hkdf(salt: &[u8], ikm: &[u8], info: &[u8], len: usize) -> Vec<u8> {
    struct Len(usize);
    impl hkdf::KeyType for Len {
        fn len(&self) -> usize {
            self.0
        }
    }
    let mut out = vec![0u8; len];
    // Only fails for a length over 255 hashes.
    hkdf::Salt::new(HKDF_SHA256, salt).extract(ikm).expand(&[info], Len(len)).and_then(|okm| okm.fill(&mut out)).expect("HKDF");
    out
}

/// The ECDH secret of `key` and the public key `peer`, if it's one.
fn ecdh(key: &agreement::PrivateKey, peer: &[u8]) -> Result<Vec<u8>> {
    agreement::agree(key, UnparsedPublicKey::new(&ECDH_P256, peer), anyhow!("the subscription's key isn't a P-256 public key"), |s| Ok(s.to_vec()))
}

/// The content encryption key and nonce of a message with `salt`, for the subscription's key and auth secret.
fn content_keys(ecdh: &[u8], auth: &[u8], ua_public: &[u8], as_public: &[u8], salt: &[u8]) -> Result<(LessSafeKey, Nonce)> {
    // IKM = HKDF(auth secret, ECDH secret, "WebPush: info" 0 ua_public as_public), then the key and nonce from the salt (RFC 8188).
    let key_info = [b"WebPush: info\0".as_slice(), ua_public, as_public].concat();
    let ikm = hkdf(auth, ecdh, &key_info, 32);
    let cek = hkdf(salt, &ikm, b"Content-Encoding: aes128gcm\0", 16);
    let nonce = hkdf(salt, &ikm, b"Content-Encoding: nonce\0", 12);
    let key = LessSafeKey::new(UnboundKey::new(&AES_128_GCM, &cek).map_err(|_| anyhow!("AES key"))?);
    Ok((key, Nonce::try_assume_unique_for_key(&nonce).map_err(|_| anyhow!("nonce"))?))
}

/// `encrypt` with the sender's (one-off) key and the salt given.
fn encrypt_with(as_key: &agreement::PrivateKey, salt: &[u8; 16], ua_public: &[u8], auth: &[u8], plaintext: &[u8]) -> Result<Vec<u8>> {
    let as_public = public_key(as_key)?;
    let (key, nonce) = content_keys(&ecdh(as_key, ua_public)?, auth, ua_public, &as_public, salt)?;
    // One record, the last: the text and its padding delimiter (2), and no padding.
    if plaintext.len() + 1 + 16 > RECORD_SIZE as usize - 86 {
        bail!("the message is too long to push");
    }
    let mut record = [plaintext, &[2]].concat();
    key.seal_in_place_append_tag(nonce, Aad::empty(), &mut record).map_err(|_| anyhow!("encrypting the message"))?;
    // salt, record size, the sender's public key as the key id, then the record.
    Ok([salt.as_slice(), &RECORD_SIZE.to_be_bytes(), &[as_public.len() as u8], &as_public, &record].concat())
}

// ---------- VAPID (RFC 8292) ----------

/// The `Authorization` header for a push to `endpoint`: a token signed with the board's key, for
/// the push service's origin, valid for 12 hours from `now` (a Unix time).
fn authorization(v: &Vapid, endpoint: &str, sub: &str, now: i64) -> Result<String> {
    let url = reqwest::Url::parse(endpoint).context("the endpoint isn't a URL")?;
    let header = B64.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
    let claims = B64.encode(json!({"aud": url.origin().ascii_serialization(), "exp": now + 12 * 3600, "sub": sub}).to_string());
    let signed = format!("{header}.{claims}");
    let sig = v.key.sign(&rand::SystemRandom::new(), signed.as_bytes()).map_err(|_| anyhow!("signing the token"))?;
    Ok(format!("vapid t={signed}.{}, k={}", B64.encode(sig.as_ref()), v.public_key()))
}

// ---------- subscriptions ----------

/// Which events a device gets: HA-8's (app/src/notifications.ts), with the same defaults, and
/// permission prompts.
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
    /// Whose permission prompts it gets, with Allow and Deny (API 96).
    #[serde(default)]
    pub prompts: Prompts,
}

/// Whose permission prompts a device gets pushed.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Prompts {
    Off,
    /// The assistant's (its thread's, and its routines'), whose prompts are for actions outside the
    /// board, and which isn't on the board's columns to notify otherwise.
    #[default]
    Assistant,
    /// Every task's.
    All,
}

fn yes() -> bool {
    true
}

impl Default for Events {
    fn default() -> Self {
        Self { attention: true, review: true, merge: false, done: false, prompts: Prompts::Assistant }
    }
}

impl Events {
    fn wants(&self, e: Event) -> bool {
        match e {
            Event::Attention => self.attention,
            Event::Review => self.review,
            Event::Merge => self.merge,
            Event::Done => self.done,
            // Depends on the task: see wants_prompt.
            Event::Prompt => false,
        }
    }

    /// Whether it wants task `t`'s permission prompts.
    fn wants_prompt(&self, t: &Value) -> bool {
        match self.prompts {
            Prompts::Off => false,
            Prompts::Assistant => is_assistant(t),
            Prompts::All => t["kind"] == "task",
        }
    }
}

/// Whether task `t` is the assistant's (personal mode): its thread, or one of its routines' runs.
fn is_assistant(t: &Value) -> bool {
    t["kind"] == "task" && matches!(t["task_type"].as_str(), Some("assistant" | "routine"))
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
    /// For a permission prompt, the request.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    /// For a prompt that can be answered from the notification: where its Allow and Deny post, with
    /// the token that answers it (see push_answers.rs).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer: Option<Answer>,
}

/// How a notification answers its prompt: `POST url` with `{"token", "decision"}`.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Answer {
    pub url: String,
    pub token: String,
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
    let topic = hex(&digest::digest(&digest::SHA256, msg.tag.as_bytes()).as_ref()[..16]);
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
    /// A permission prompt was raised.
    Prompt,
}

impl Event {
    /// The column it's about, where a move the user made doesn't notify (see `PushState::moved`).
    fn status(self) -> &'static str {
        match self {
            Event::Attention | Event::Prompt => "needs_attention",
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

/// How long a move the user made keeps its notification away (`MOVE_MS` in app/src/api/tasks.ts).
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
        Event::Prompt => "Waiting for your answer".into(),
    };
    let body = if body.chars().count() > 200 { format!("{}…", body.chars().take(199).collect::<String>()) } else { body };
    (format!("{key} {}", t["title"].as_str().unwrap_or("")), body)
}

/// What goes before a task's number (`keyPrefix`): its project's key, `G` for a group task, `S` for
/// a scratch task.
async fn task_key(s: &Shared, host_id: &str, t: &Value) -> String {
    let prefix = match t["project_id"].as_str() {
        Some(p) if host_id == s.host_id => local_project_key(s, p),
        Some(p) => crate::hosts::hub::host_request(s, host_id, "GET", &format!("/api/projects/{p}"), None).await.ok().and_then(|p| p["key"].as_str().map(String::from)),
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
    /// A link is presented as connected after its initial task snapshot has been processed.
    watching: AtomicBool,
    ready: Mutex<HashMap<String, Weak<crate::hosts::hub::LinkConn>>>,
    client: reqwest::Client,
    /// The latest state of every task on the board, by `<host>:<id>`, to tell what changed.
    tasks: Mutex<HashMap<String, Value>>,
    /// The tasks whose "ready to review" waits out its grace period.
    pending: Mutex<HashSet<String>>,
    /// The columns tasks were moved to by the user lately (through this board's API), by `<host>:<id>`.
    moves: Mutex<HashMap<String, (String, Instant)>>,
    /// The permission prompts raised while the board watched that are still waiting, by `<host>:<task id>`.
    prompts: Mutex<HashMap<String, HashSet<String>>>,
}

impl Default for PushState {
    fn default() -> Self {
        Self {
            watching: AtomicBool::new(false),
            ready: Default::default(),
            client: reqwest::Client::builder().timeout(Duration::from_secs(30)).build().unwrap_or_default(),
            tasks: Default::default(),
            pending: Default::default(),
            moves: Default::default(),
            prompts: Default::default(),
        }
    }
}

impl PushState {
    pub(crate) fn link_ready(&self, link: &crate::hosts::hub::LinkHandle) -> bool {
        !self.watching.load(Ordering::Relaxed) || self.ready.lock().unwrap().get(&link.id)
            .and_then(Weak::upgrade).is_some_and(|old| std::sync::Arc::ptr_eq(&old, link))
    }

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
    s.push.watching.store(true, Ordering::Relaxed);
    if let Err(e) = super::push_answers::recover(&s.db()) {
        tracing::warn!("push: recovering prompts' answers: {e:#}");
    }
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
                        sync_host(&st, &h).await;
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
                Some("message") => observe_prompt(&st, &host, &ev["message"]),
                Some("message_updated") => prompt_settled(&st, &host, &ev["message"]),
                Some("resync") => sync_host(&st, &host).await,
                Some("hosts_changed") => {
                    let now = linked(&st);
                    st.push.ready.lock().unwrap().retain(|id, _| now.contains(id));
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

/// Both kinds of link announce an initial resync after hosts_changed. Publishing connected before
/// that snapshot completed let a first change be swallowed into the baseline, rather than pushed.
async fn sync_host(s: &Shared, host: &str) {
    let link = crate::hosts::hub::find_link(s, host);
    load_host(s, host).await;
    if let Some(link) = link.filter(|link| crate::hosts::hub::find_link(s, host).is_some_and(|now| std::sync::Arc::ptr_eq(link, &now))) {
        let was_ready = s.push.link_ready(&link);
        s.push.ready.lock().unwrap().insert(host.into(), std::sync::Arc::downgrade(&link));
        if !was_ready { let _ = s.hub_events.send(json!({"type": "hosts_changed"})); }
    }
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
        let profiles = match crate::hosts::hub::host_request(s, host, "GET", "/api/profiles", None).await {
            Ok(p) => p,
            Err(e) => return tracing::warn!("push: reading {host}'s profiles: {}", e.1),
        };
        for p in profiles.as_array().into_iter().flatten() {
            let Some(id) = p["id"].as_str() else { continue };
            if let Ok(Value::Array(ts)) = crate::hosts::hub::host_request(s, host, "GET", &format!("/api/profiles/{id}/tasks"), None).await {
                all.extend(ts);
            }
        }
        all
    };
    // Prompts it raised that the board heard of may have been answered while it wasn't listening.
    s.push.prompts.lock().unwrap().retain(|k, _| !k.starts_with(&format!("{host}:")));
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
    // Its prompts end with its run (if the board missed hearing so).
    if t["running"] == json!(false) {
        s.push.prompts.lock().unwrap().remove(&key);
    }
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
    let id = t["id"].as_str().unwrap_or_default();
    // Waiting on a prompt the devices that want it were pushed already, with its Allow and Deny.
    let prompted = e == Event::Attention && s.push.prompts.lock().unwrap().get(&format!("{host}:{id}")).is_some_and(|p| !p.is_empty());
    let subs = match list(&s.db()) {
        Ok(subs) => subs.into_iter().filter(|x| x.events.wants(e) && !(prompted && x.events.wants_prompt(t))).collect::<Vec<_>>(),
        Err(e) => return tracing::warn!("push: reading the subscriptions: {e:#}"),
    };
    if subs.is_empty() {
        return;
    }
    let (title, body) = notification_text(e, t, &task_key(s, host, t).await);
    let msg = Message { title, body, url: format!("/t/{id}"), tag: format!("{host}:{id}"), task_id: Some(id.into()), event: Some(e), request_id: None, answer: None };
    for sub in subs {
        let _ = send(s, &sub, &msg, e == Event::Attention).await;
    }
}

// ---------- permission prompts ----------

/// A thread message as it is now: a permission prompt that has just been raised is pushed.
fn observe_prompt(s: &Shared, host: &str, m: &Value) {
    let data = &m["data"];
    if m["kind"] != "permission" || data["status"] != "pending" {
        return;
    }
    let (Some(task_id), Some(request)) = (m["task_id"].as_str(), data["request_id"].as_str()) else { return };
    s.push.prompts.lock().unwrap().entry(format!("{host}:{task_id}")).or_default().insert(request.into());
    let (st, host, task_id, data) = (s.clone(), host.to_string(), task_id.to_string(), data.clone());
    tokio::spawn(async move { notify_prompt(&st, &host, &task_id, &data).await });
}

/// A thread message changed: a prompt answered or expired is no longer waiting, and the tokens that
/// would answer it from a notification stop working.
fn prompt_settled(s: &Shared, host: &str, m: &Value) {
    let data = &m["data"];
    let (Some(task_id), Some(request), Some(status)) = (m["task_id"].as_str(), data["request_id"].as_str(), data["status"].as_str()) else { return };
    if m["kind"] != "permission" || status == "pending" {
        return;
    }
    let key = format!("{host}:{task_id}");
    let mut prompts = s.push.prompts.lock().unwrap();
    if let Some(p) = prompts.get_mut(&key) {
        p.remove(request);
        if p.is_empty() {
            prompts.remove(&key);
        }
    }
    drop(prompts);
    if let Err(e) = super::push_answers::settle(&s.db(), host, request, status) {
        tracing::warn!("push: settling prompt {request}'s tokens: {e:#}");
    }
}

/// The task with id `id` on `host`, as the board last saw it or else as it is now.
async fn find_task(s: &Shared, host: &str, id: &str) -> Option<Value> {
    if let Some(t) = s.push.tasks.lock().unwrap().get(&format!("{host}:{id}")) {
        return Some(t.clone());
    }
    if host == s.host_id {
        return db::get_task(&s.db(), id).ok().flatten().map(|t| json!(t));
    }
    crate::hosts::hub::host_request(s, host, "GET", &format!("/api/tasks/{id}"), None).await.ok().map(|v| v["task"].clone()).filter(Value::is_object)
}

/// What a prompt's notification says it asks (not what the tool would do: pushes pass through push
/// services, so they carry no tool inputs).
fn prompt_text(data: &Value) -> String {
    let tool = data["tool_name"].as_str().unwrap_or("a tool");
    match data["kind"].as_str() {
        Some("project") => "Approve a project change?".into(),
        Some("delete_task") => "Delete a task?".into(),
        Some("automation") => "Approve an automation?".into(),
        _ if crate::mcp::permissions::is_question(tool) => "The agent has questions for you".into(),
        _ if tool == crate::mcp::permissions::EXIT_PLAN => "Plan ready for approval".into(),
        _ => format!("Approve {tool}?"),
    }
}

/// Pushes prompt `data` (its thread message's) of task `task_id` to the devices that want it, with
/// a token for its Allow and Deny if it can be answered from the notification.
async fn notify_prompt(s: &Shared, host: &str, task_id: &str, data: &Value) {
    let Some(request) = data["request_id"].as_str() else { return };
    let Some(t) = find_task(s, host, task_id).await else { return };
    let subs = match list(&s.db()) {
        Ok(subs) => subs.into_iter().filter(|x| x.events.wants_prompt(&t)).collect::<Vec<_>>(),
        Err(e) => return tracing::warn!("push: reading the subscriptions: {e:#}"),
    };
    if subs.is_empty() {
        return;
    }
    let answer = if super::push_answers::answerable(data) {
        match super::push_answers::mint(&s.db(), host, request, task_id) {
            Ok(token) => Some(Answer { url: format!("/api/permissions/{request}/push-answer"), token }),
            Err(e) => {
                tracing::warn!("push: minting a token for prompt {request}: {e:#}");
                None
            }
        }
    } else {
        None
    };
    let key = task_key(s, host, &t).await;
    let msg = Message {
        title: format!("{key} {}", t["title"].as_str().unwrap_or("")),
        body: prompt_text(data),
        url: format!("/t/{task_id}"),
        // Each prompt its own, so that two at once can each be answered.
        tag: format!("{host}:{task_id}:{request}"),
        task_id: Some(task_id.into()),
        event: Some(Event::Prompt),
        request_id: Some(request.into()),
        answer,
    };
    for sub in subs {
        let _ = send(s, &sub, &msg, true).await;
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
    let valid = |k: &[u8]| k.len() == 65 && agreement::PrivateKey::generate(&ECDH_P256).is_ok_and(|key| ecdh(&key, k).is_ok());
    let p256dh = B64.decode(b.keys.p256dh.trim_end_matches('=')).ok().filter(|k| valid(k));
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
        request_id: None,
        answer: None,
    };
    send(&s, &sub, &msg, true).await.map_err(|e| ApiError(axum::http::StatusCode::BAD_GATEWAY, format!("{e:#}")))?;
    Ok(Json(json!({"ok": true})))
}

#[cfg(test)]
mod tests;
