//! Telegram: talking to a profile's assistant from a Telegram bot, and the assistant reaching you there.
//!
//! It runs on the host the assistant runs on (its assistant host, see agent/assistant.rs), and long-polls
//! the Bot API's `getUpdates`, so it needs no inbound port, and carries on while that host's link to the
//! hub is down. Each profile can have a bot of its own:
//!
//! - **The bot token** is a secret in the settings (`telegram_token:<profile id>`), set in the assistant's
//!   details and never returned by the API. It goes in the Bot API's URLs, so it must look like one.
//! - **Linking:** the board shows a one-time code (`POST /profiles/{id}/telegram/link`, ten minutes), and
//!   `/start <code>` sent to the bot from a private chat makes that chat the owner. Messages and button
//!   presses from anyone else are dropped, logged and counted.
//! - **In:** the owner's messages go to the assistant thread as theirs (`assistant::send`), with photos,
//!   voice notes and files saved as attachments, listed as the board lists them.
//! - **Out:** the assistant's replies to them (or to every message, as chosen), its routines' reports, its
//!   questions and its permission prompts, the last with Allow and Deny buttons. Those are answered as the
//!   board's own buttons answer (permissions::answer_by, `telegram` in the action log), so the approval
//!   rules and expiry hold the same; the message is edited to say how the prompt ended, however it did.
//!   Each kind of message can be turned off (`events`). Push (push.rs, chosen per device) can send each of them
//!   too: the replies it's told of here (`announce_reply`), as only this host knows which were asked for on
//!   Telegram, and those go back there alone.
//! - **Sending** goes through a queue per profile, kept in the settings until Telegram takes each item:
//!   one that fails for a while (Telegram unreachable, failing or rate-limiting) is tried again, waiting
//!   longer each time, and after a restart; one Telegram refuses outright is dropped. One profile's queue
//!   doesn't hold up another's.
//! - **Moving the assistant** to another host removes the bot from the one it left (`assistant_moved`).
//!
//! Nothing here takes an address or a token from what arrives in a chat: the API's address is fixed (or
//! `IA_TELEGRAM_API` in the server's environment, for tests), files are fetched by the ids Telegram gives,
//! and replies go only to the owner's chat.
//!
//! Settings, by profile: the secret token; `telegram:<id>` (the bot, owner, events, pending code and the
//! last error), `telegram_state:<id>` (the update offset, so a restart carries on where it was, and the
//! prompts sent with buttons, to edit when they end) and `telegram_outbox:<id>` (what's waiting to be sent).

pub mod format;
#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use axum::Json;
use axum::extract::{Path, State};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Notify;

use crate::agent::assistant;
use crate::db::{self, Task};
use crate::mcp::permissions;
use crate::state::{ApiError, ApiResult, Shared};
use crate::util::{now, same_secret};

use format::{PIECE_CHARS, cut, escape, split, to_html};

/// The Bot API's address.
const API: &str = "https://api.telegram.org";

/// How long each `getUpdates` waits for something to arrive, in seconds.
const POLL_SECS: u64 = 50;

/// How long a linking code lasts.
const CODE_MINUTES: i64 = 10;

/// Prompts sent with buttons that are remembered (to edit when they end), at most.
const MAX_PROMPTS: usize = 200;

/// What `getUpdates` asks for.
const UPDATES: [&str; 2] = ["message", "callback_query"];

fn token_key(profile_id: &str) -> String {
    format!("telegram_token:{profile_id}")
}

fn config_key(profile_id: &str) -> String {
    format!("telegram:{profile_id}")
}

fn progress_key(profile_id: &str) -> String {
    format!("telegram_state:{profile_id}")
}

fn outbox_key(profile_id: &str) -> String {
    format!("telegram_outbox:{profile_id}")
}

/// Every setting a profile's bot keeps.
fn keys(profile_id: &str) -> [String; 4] {
    [token_key(profile_id), config_key(profile_id), progress_key(profile_id), outbox_key(profile_id)]
}

// ---------- settings ----------

/// A profile's bot and who it talks to.
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct Config {
    /// The bot the token is for, from `getMe` when the token was set.
    pub bot: Option<Bot>,
    /// The chat that linked with a code: the only one the bot listens to and writes to.
    pub owner: Option<Owner>,
    #[serde(default)]
    pub events: Events,
    /// The linking code waiting to be sent, by its hash.
    pub link: Option<Link>,
    /// Why talking to Telegram last failed, until it works again.
    pub last_error: Option<String>,
    /// Messages and button presses from others, dropped.
    pub dropped: Option<Dropped>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Bot {
    pub id: i64,
    pub username: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Owner {
    pub chat_id: i64,
    pub user_id: i64,
    pub name: String,
    pub username: Option<String>,
    pub linked_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Link {
    pub code_hash: String,
    pub expires_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Dropped {
    pub count: u64,
    /// Who sent the last one: their name and Telegram id.
    pub last_from: String,
    pub last_at: String,
}

/// What the bot sends you, besides the replies to what you send it (which always come back).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Events {
    /// The assistant's replies to messages sent from the board too.
    #[serde(default)]
    pub replies: bool,
    /// Its routines' reports.
    #[serde(default = "yes")]
    pub reports: bool,
    /// Its permission prompts (with Allow and Deny) and its questions, and its routines' prompts.
    #[serde(default = "yes")]
    pub prompts: bool,
    /// It needs attention (its run failed, say).
    #[serde(default = "yes")]
    pub attention: bool,
}

fn yes() -> bool {
    true
}

impl Default for Events {
    fn default() -> Self {
        Self { replies: false, reports: true, prompts: true, attention: true }
    }
}

/// Where the poller and the outbox are, kept apart from `Config` as it changes with each update.
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct Progress {
    /// The next update to ask for: the ones before it have been handled.
    #[serde(default)]
    pub offset: i64,
    /// A message from Telegram went to the assistant, and its reply goes back.
    #[serde(default)]
    pub awaiting: bool,
    /// The last turn's end (a `result` message's id) whose reply was looked at.
    #[serde(default)]
    pub replied: i64,
    /// The prompts sent with buttons, by request id: their Telegram message and text.
    #[serde(default)]
    pub prompts: BTreeMap<String, SentPrompt>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SentPrompt {
    pub message_id: i64,
    pub html: String,
}

fn read<T: for<'de> Deserialize<'de> + Default>(c: &Connection, key: &str) -> T {
    db::get_setting(c, key).ok().flatten().and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default()
}

fn write<T: Serialize>(c: &Connection, key: &str, v: &T) -> anyhow::Result<()> {
    db::set_setting(c, key, Some(&serde_json::to_string(v)?))
}

pub fn config(c: &Connection, profile_id: &str) -> Config {
    read(c, &config_key(profile_id))
}

pub fn progress(c: &Connection, profile_id: &str) -> Progress {
    read(c, &progress_key(profile_id))
}

fn token(c: &Connection, profile_id: &str) -> Option<String> {
    db::get_setting(c, &token_key(profile_id)).ok().flatten()
}

/// Changes profile `profile_id`'s config with `f`, under one lock: what `f` returns.
fn update_config<R>(s: &Shared, profile_id: &str, f: impl FnOnce(&mut Config) -> R) -> anyhow::Result<R> {
    let c = s.db();
    let mut cfg = config(&c, profile_id);
    let r = f(&mut cfg);
    write(&c, &config_key(profile_id), &cfg)?;
    Ok(r)
}

/// Changes profile `profile_id`'s progress with `f`, under one lock: what `f` returns.
fn update_progress<R>(s: &Shared, profile_id: &str, f: impl FnOnce(&mut Progress) -> R) -> anyhow::Result<R> {
    let c = s.db();
    let mut p = progress(&c, profile_id);
    let r = f(&mut p);
    write(&c, &progress_key(profile_id), &p)?;
    Ok(r)
}

/// The token and owner of profile `profile_id`'s bot, if it has both: the bot is linked.
fn linked(c: &Connection, profile_id: &str) -> Option<(String, Config, Owner)> {
    let token = token(c, profile_id)?;
    let cfg = config(c, profile_id);
    let owner = cfg.owner.clone()?;
    Some((token, cfg, owner))
}

/// Whether `token` looks like a bot token (`<bot id>:<secret>`), which goes in the API's URLs as it is.
pub fn valid_token(token: &str) -> bool {
    let Some((id, secret)) = token.split_once(':') else { return false };
    !id.is_empty() && id.len() <= 20 && id.bytes().all(|b| b.is_ascii_digit()) && (20..=100).contains(&secret.len())
        && secret.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn hash(code: &str) -> String {
    aws_lc_rs::digest::digest(&aws_lc_rs::digest::SHA256, code.as_bytes()).as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

/// Tells the board's UI that profile `profile_id`'s Telegram settings changed (linked, say).
fn changed(s: &Shared, profile_id: &str) {
    s.emit(json!({"type": "telegram", "profile_id": profile_id}));
}

// ---------- the Bot API ----------

/// What the board keeps for Telegram while it runs.
pub struct TelegramState {
    /// Each profile's poller and sender, while it has a token.
    pollers: Mutex<HashMap<String, [tokio::task::AbortHandle; 2]>>,
    /// What wakes each profile's sender when something is queued for it.
    wakers: Mutex<HashMap<String, Arc<Notify>>>,
    started: OnceLock<()>,
    /// The Bot API's address: `API`, or `IA_TELEGRAM_API` (a fake one, in tests).
    api: Mutex<String>,
    poll_secs: AtomicU64,
    client: reqwest::Client,
}

impl Default for TelegramState {
    fn default() -> Self {
        let api = std::env::var("IA_TELEGRAM_API").ok().filter(|a| !a.trim().is_empty()).unwrap_or_else(|| API.into());
        Self {
            pollers: Default::default(),
            wakers: Default::default(),
            started: OnceLock::new(),
            api: Mutex::new(api.trim_end_matches('/').to_string()),
            poll_secs: AtomicU64::new(POLL_SECS),
            client: reqwest::Client::builder().connect_timeout(Duration::from_secs(15)).build().unwrap_or_default(),
        }
    }
}

impl TelegramState {
    fn api(&self) -> String {
        self.api.lock().unwrap().clone()
    }

    fn waker(&self, profile_id: &str) -> Arc<Notify> {
        self.wakers.lock().unwrap().entry(profile_id.to_string()).or_default().clone()
    }

    /// Talks to a fake Bot API at `url` instead, polling for `poll_secs` at a time.
    #[cfg(test)]
    pub fn use_api(&self, url: &str, poll_secs: u64) {
        *self.api.lock().unwrap() = url.trim_end_matches('/').into();
        self.poll_secs.store(poll_secs, Ordering::Relaxed);
    }
}

/// Why a call to the Bot API failed. Never with its URL, which has the token in it.
#[derive(Debug)]
pub enum CallError {
    /// Telegram said no (`error_code` and `description`).
    Api { code: i64, description: String, retry_after: Option<u64> },
    /// It couldn't be reached, or answered with something else.
    Net(String),
}

impl std::fmt::Display for CallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CallError::Api { code: 401, .. } => write!(f, "Telegram doesn't know this bot token (it may have been revoked): set it again"),
            CallError::Api { code: 409, .. } => write!(f, "something else is reading this bot's messages (another board, or a webhook): a bot can be read by one at a time"),
            CallError::Api { code, description, .. } => write!(f, "Telegram said {code}: {description}"),
            CallError::Net(e) => write!(f, "couldn't reach Telegram: {e}"),
        }
    }
}

/// Calls `method` with `body`, as bot `token`: its `result`.
pub async fn call(s: &Shared, token: &str, method: &str, body: &Value, timeout: Duration) -> Result<Value, CallError> {
    let url = format!("{}/bot{token}/{method}", s.telegram.api());
    let res = s.telegram.client.post(&url).timeout(timeout).json(body).send().await.map_err(|e| CallError::Net(e.without_url().to_string()))?;
    let status = res.status();
    let v: Value = res.json().await.map_err(|e| CallError::Net(format!("{status}: {}", e.without_url())))?;
    if v["ok"] == json!(true) {
        return Ok(v["result"].clone());
    }
    Err(CallError::Api {
        code: v["error_code"].as_i64().unwrap_or(status.as_u16() as i64),
        description: v["description"].as_str().unwrap_or("no reason given").to_string(),
        retry_after: v["parameters"]["retry_after"].as_u64(),
    })
}

/// `call`, trying once more after the wait Telegram asks for when there are too many requests.
async fn call_patiently(s: &Shared, token: &str, method: &str, body: &Value) -> Result<Value, CallError> {
    match call(s, token, method, body, Duration::from_secs(30)).await {
        Err(CallError::Api { retry_after: Some(secs), .. }) if secs <= 60 => {
            tokio::time::sleep(Duration::from_secs(secs)).await;
            call(s, token, method, body, Duration::from_secs(30)).await
        }
        r => r,
    }
}

/// Sends `html` to `chat`, with `markup` (buttons) if any: its message id. Telegram refusing the
/// HTML sends `plain` instead, if there is one.
async fn send_html(s: &Shared, token: &str, chat: i64, html: &str, plain: Option<&str>, markup: Option<Value>) -> Result<i64, CallError> {
    let mut body = json!({"chat_id": chat, "text": html, "parse_mode": "HTML", "link_preview_options": {"is_disabled": true}});
    if let Some(m) = &markup {
        body["reply_markup"] = m.clone();
    }
    let sent = match call_patiently(s, token, "sendMessage", &body).await {
        Err(CallError::Api { code: 400, description, .. }) if description.contains("parse entities") || description.contains("can't parse") => {
            let Some(plain) = plain else { return Err(CallError::Api { code: 400, description, retry_after: None }) };
            let mut body = json!({"chat_id": chat, "text": cut(plain, format::MAX_CHARS), "link_preview_options": {"is_disabled": true}});
            if let Some(m) = markup {
                body["reply_markup"] = m;
            }
            call_patiently(s, token, "sendMessage", &body).await?
        }
        r => r?,
    };
    Ok(sent["message_id"].as_i64().unwrap_or_default())
}

/// Sends plain `text` to `chat`, noting a failure.
async fn say(s: &Shared, profile_id: &str, token: &str, chat: i64, text: &str) {
    if let Err(e) = send_html(s, token, chat, &escape(text), None, None).await {
        note_error(s, profile_id, &e);
    }
}

/// Notes that talking to Telegram failed (or with None, that it works again): whether that's news.
fn set_error(s: &Shared, profile_id: &str, error: Option<String>) -> bool {
    // Read first, as most polls have nothing to change.
    if config(&s.db(), profile_id).last_error == error {
        return false;
    }
    let news = update_config(s, profile_id, |c| {
        let news = c.last_error != error;
        c.last_error = error;
        news
    });
    let news = news.unwrap_or(false);
    if news {
        changed(s, profile_id);
    }
    news
}

/// Notes a failure, logged when it's a new one (not each retry of the same).
fn note_error(s: &Shared, profile_id: &str, e: &CallError) {
    if set_error(s, profile_id, Some(e.to_string())) {
        tracing::warn!(profile = profile_id, "telegram: {e}");
    }
}

// ---------- polling ----------

/// Starts Telegram for every profile with a bot: their pollers, and what passes the assistants'
/// messages on to them.
pub fn start(s: &Shared) {
    if s.telegram.started.set(()).is_err() {
        return;
    }
    tokio::spawn(watch(s.clone(), s.events.subscribe()));
    let profiles: Vec<String> = db::list_profiles(&s.db()).map(|ps| ps.into_iter().map(|p| p.id).collect()).unwrap_or_default();
    for p in profiles {
        restart(s, &p);
    }
}

/// (Re)starts profile `profile_id`'s poller and sender, or stops them if it has no token.
pub fn restart(s: &Shared, profile_id: &str) {
    let has_token = token(&s.db(), profile_id).is_some();
    let mut pollers = s.telegram.pollers.lock().unwrap();
    if let Some(old) = pollers.remove(profile_id) {
        old.iter().for_each(|h| h.abort());
    }
    if has_token {
        let poller = tokio::spawn(poll(s.clone(), profile_id.to_string()));
        let sender = tokio::spawn(sender(s.clone(), profile_id.to_string()));
        pollers.insert(profile_id.to_string(), [poller.abort_handle(), sender.abort_handle()]);
    }
}

/// Whether profile `profile_id`'s poller is running.
fn polling(s: &Shared, profile_id: &str) -> bool {
    s.telegram.pollers.lock().unwrap().get(profile_id).is_some_and(|h| !h[0].is_finished())
}

/// Profile `profile_id` was deleted: its bot stops and its settings go.
pub fn forget_profile(s: &Shared, profile_id: &str) {
    if let Some(h) = s.telegram.pollers.lock().unwrap().remove(profile_id) {
        h.iter().for_each(|h| h.abort());
    }
    let c = s.db();
    for key in keys(profile_id) {
        let _ = db::set_setting(&c, &key, None);
    }
}

/// Removes profile `profile_id`'s bot from this host: its token, chat, offset and queued sends (its
/// choice of events stays), and stops it.
pub fn remove_bot(s: &Shared, profile_id: &str) -> anyhow::Result<()> {
    {
        let c = s.db();
        let events = config(&c, profile_id).events;
        for key in keys(profile_id) {
            db::set_setting(&c, &key, None)?;
        }
        write(&c, &config_key(profile_id), &Config { events, ..Default::default() })?;
    }
    restart(s, profile_id);
    changed(s, profile_id);
    Ok(())
}

/// Profile `profile_id`'s assistant moved off `old_host` (None: this host): its bot there is removed, so
/// that it doesn't go on reading the owner's messages for an assistant that's no longer there. It's set
/// up again on the assistant's new host. A host that's offline (or too old for Telegram) keeps it.
pub async fn assistant_moved(s: &Shared, name: &str, profile_id: &str, old_host: Option<String>) {
    let Some(host) = old_host.filter(|h| !h.is_empty() && *h != s.host_id) else {
        let has_token = token(&s.db(), profile_id).is_some();
        if has_token {
            tracing::info!(profile = profile_id, "telegram: the assistant moved to another host: removing its bot here");
            if let Err(e) = remove_bot(s, profile_id) {
                tracing::warn!(profile = profile_id, "telegram: removing the bot: {e:#}");
            }
        }
        return;
    };
    let link = s.links.lock().unwrap().get(&host).cloned();
    let api = link.map(|l| l.version.lock().unwrap().api_version);
    if api.is_none_or(|v| v < TELEGRAM_API) {
        if api.is_none() {
            tracing::warn!(profile = profile_id, "telegram: {host}, which the assistant moved off, is offline: remove its bot there");
        }
        return;
    }
    let profiles = match crate::hosts::hub::host_request(s, &host, "GET", "/api/profiles", None).await {
        Ok(p) => p,
        Err(e) => return tracing::warn!(profile = profile_id, "telegram: reading {host}'s profiles to remove its bot: {}", e.1),
    };
    let Some(there) = profiles.as_array().into_iter().flatten().find(|r| r["name"] == name).and_then(|r| r["id"].as_str().map(String::from)) else { return };
    let path = format!("/api/profiles/{there}/telegram");
    if let Err(e) = crate::hosts::hub::host_request(s, &host, "PATCH", &path, Some(json!({"token": null}))).await {
        tracing::warn!(profile = profile_id, "telegram: removing the bot on {host}: {}", e.1);
    }
}

/// The API version from which a host has Telegram.
pub const TELEGRAM_API: u32 = 104;

/// Reads profile `profile_id`'s bot's updates for as long as it has its token, handling each in turn
/// and noting after each that it's done, so that a restart carries on after it.
async fn poll(s: Shared, profile_id: String) {
    let mut backoff = 1;
    loop {
        let Some(token) = token(&s.db(), &profile_id) else { return };
        let offset = progress(&s.db(), &profile_id).offset;
        let wait = s.telegram.poll_secs.load(Ordering::Relaxed);
        let body = json!({"offset": offset, "timeout": wait, "allowed_updates": UPDATES});
        match call(&s, &token, "getUpdates", &body, Duration::from_secs(wait + 15)).await {
            Ok(Value::Array(updates)) => {
                backoff = 1;
                set_error(&s, &profile_id, None);
                for u in updates {
                    let Some(id) = u["update_id"].as_i64() else { continue };
                    if id < offset {
                        continue;
                    }
                    handle(&s, &profile_id, &token, &u).await;
                    let _ = update_progress(&s, &profile_id, |p| p.offset = p.offset.max(id + 1));
                }
            }
            Ok(_) => {}
            Err(e) => {
                note_error(&s, &profile_id, &e);
                // A token Telegram doesn't know won't start working: wait longer.
                let secs = match &e {
                    CallError::Api { code: 401, .. } => 300,
                    CallError::Api { retry_after: Some(r), .. } => (*r).min(300),
                    _ => backoff,
                };
                tokio::time::sleep(Duration::from_secs(secs)).await;
                backoff = (backoff * 2).min(60);
            }
        }
    }
}

/// The code in a `/start <code>` (or `/start@bot <code>`), if it's one.
fn start_code(text: &str) -> Option<&str> {
    let rest = text.trim().strip_prefix("/start")?;
    let rest = match rest.strip_prefix('@') {
        Some(r) => r.split_once(char::is_whitespace).map_or("", |(_, r)| r),
        None if rest.is_empty() || rest.starts_with(char::is_whitespace) => rest,
        None => return None,
    };
    Some(rest.trim())
}

/// Someone's name, as Telegram gives it.
fn name_of(user: &Value) -> String {
    let name = [user["first_name"].as_str(), user["last_name"].as_str()].into_iter().flatten().collect::<Vec<_>>().join(" ");
    if name.trim().is_empty() { user["username"].as_str().unwrap_or("someone").to_string() } else { name }
}

/// A message or a button press from someone other than the owner: dropped, logged and counted.
fn drop_stranger(s: &Shared, profile_id: &str, user: &Value, chat: &Value, what: &str) {
    let who = format!("{} ({})", name_of(user), user["id"].as_i64().unwrap_or_default());
    tracing::warn!(profile = profile_id, chat = chat["id"].as_i64().unwrap_or_default(), "telegram: dropped a {what} from {who}, who isn't linked to this bot");
    let _ = update_config(s, profile_id, |c| {
        let d = c.dropped.get_or_insert_with(Default::default);
        d.count += 1;
        d.last_from = who;
        d.last_at = now();
    });
    changed(s, profile_id);
}

/// Handles one update.
async fn handle(s: &Shared, profile_id: &str, token: &str, u: &Value) {
    if let Some(cb) = u.get("callback_query") {
        return button(s, profile_id, token, cb).await;
    }
    let Some(m) = u.get("message") else { return };
    let (chat, from) = (&m["chat"], &m["from"]);
    let (Some(chat_id), Some(user_id)) = (chat["id"].as_i64(), from["id"].as_i64()) else { return };
    let text = m["text"].as_str().or_else(|| m["caption"].as_str()).unwrap_or("");
    let cfg = config(&s.db(), profile_id);
    let is_owner = cfg.owner.as_ref().is_some_and(|o| o.chat_id == chat_id && o.user_id == user_id);
    if let Some(code) = start_code(text).filter(|c| !c.is_empty()) {
        if link(s, profile_id, token, m, code).await {
            return;
        }
        if !is_owner {
            // Silently, as anything else from a stranger: the bot doesn't say whose it is.
            return drop_stranger(s, profile_id, from, chat, "linking code that isn't valid");
        }
    }
    if !is_owner {
        return drop_stranger(s, profile_id, from, chat, "message");
    }
    if start_code(text).is_some() {
        return say(s, profile_id, token, chat_id, "This chat is linked to your assistant: what you send here goes to it.").await;
    }
    forward(s, profile_id, token, chat_id, m, text).await;
}

/// `/start <code>` from message `m`: links its chat if the code is the one waiting. Whether it did.
async fn link(s: &Shared, profile_id: &str, token: &str, m: &Value, code: &str) -> bool {
    let chat_id = m["chat"]["id"].as_i64().unwrap_or_default();
    let private = m["chat"]["type"] == "private";
    let owner = Owner {
        chat_id,
        user_id: m["from"]["id"].as_i64().unwrap_or_default(),
        name: name_of(&m["from"]),
        username: m["from"]["username"].as_str().map(String::from),
        linked_at: now(),
    };
    let linked = update_config(s, profile_id, |c| {
        let ok = c.link.as_ref().is_some_and(|l| l.expires_at > now() && same_secret(&l.code_hash, &hash(code)));
        if ok && private {
            c.link = None;
            c.owner = Some(owner.clone());
        }
        ok
    });
    match linked {
        Ok(true) if !private => {
            say(s, profile_id, token, chat_id, "Link your assistant from a private chat with this bot, not a group.").await;
            true
        }
        Ok(true) => {
            tracing::info!(profile = profile_id, chat = chat_id, "telegram: linked to {}", owner.name);
            // What was sent or queued for a chat before isn't for this one.
            let _ = update_progress(s, profile_id, |p| {
                p.prompts.clear();
                p.awaiting = false;
            });
            let _ = update_outbox(s, profile_id, |o| o.items.clear());
            changed(s, profile_id);
            let name = db::get_profile(&s.db(), profile_id).ok().flatten().map(|p| p.name).unwrap_or_default();
            let text = format!("Linked to the {name} profile's assistant. What you send here goes to it, and it can reach you here.");
            say(s, profile_id, token, chat_id, &text).await;
            true
        }
        _ => false,
    }
}

/// The files in message `m`: each one's Telegram id, a name to save it as, and its size if known.
fn files_of(m: &Value) -> Vec<(String, String, Option<u64>)> {
    let mut out = Vec::new();
    let mut add = |f: &Value, name: String| {
        if let Some(id) = f["file_id"].as_str() {
            out.push((id.to_string(), name, f["file_size"].as_u64()));
        }
    };
    // Its sizes, smallest first.
    if let Some(p) = m["photo"].as_array().and_then(|p| p.last()) {
        add(p, "photo.jpg".into());
    }
    let named = |f: &Value, default: &str| f["file_name"].as_str().filter(|n| !n.trim().is_empty()).unwrap_or(default).to_string();
    for (field, default) in [("voice", "voice-note.ogg"), ("audio", "audio.mp3"), ("document", "file"), ("video", "video.mp4"), ("video_note", "video-note.mp4")] {
        if m[field].is_object() {
            add(&m[field], named(&m[field], default));
        }
    }
    out
}

/// Fetches file `file_id` from Telegram, if it's no bigger than an attachment can be.
async fn download(s: &Shared, token: &str, file_id: &str) -> Result<Vec<u8>, String> {
    let f = call(s, token, "getFile", &json!({"file_id": file_id}), Duration::from_secs(30)).await.map_err(|e| e.to_string())?;
    let path = f["file_path"].as_str().unwrap_or_default();
    // A path on Telegram's file server, as it gave it: nothing that could lead elsewhere.
    if path.is_empty() || path.starts_with('/') || path.split('/').any(|p| p == ".." || p.is_empty()) || path.contains(['?', '#', '\\', '%']) {
        return Err("Telegram gave no file to fetch".into());
    }
    if f["file_size"].as_u64().is_some_and(|n| n as usize > crate::attachments::MAX_BYTES) {
        return Err(too_big());
    }
    let url = format!("{}/file/bot{token}/{path}", s.telegram.api());
    let mut res = s.telegram.client.get(&url).timeout(Duration::from_secs(120)).send().await.map_err(|e| e.without_url().to_string())?;
    if !res.status().is_success() {
        return Err(format!("Telegram answered {}", res.status()));
    }
    let mut data = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(|e| e.without_url().to_string())? {
        data.extend_from_slice(&chunk);
        if data.len() > crate::attachments::MAX_BYTES {
            return Err(too_big());
        }
    }
    Ok(data)
}

fn too_big() -> String {
    format!("it's larger than {} MB", crate::attachments::MAX_BYTES >> 20)
}

/// The owner's message `m` (`text`, and its files) goes to the assistant as theirs.
async fn forward(s: &Shared, profile_id: &str, token: &str, chat_id: i64, m: &Value, text: &str) {
    let mut paths: Vec<PathBuf> = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    for (id, name, size) in files_of(m) {
        if size.is_some_and(|n| n as usize > crate::attachments::MAX_BYTES) {
            notes.push(format!("({name} wasn't passed on: {})", too_big()));
            continue;
        }
        let saved = match download(s, token, &id).await {
            Ok(data) => crate::attachments::save(s, &name, &data).await.map_err(|e| e.1),
            Err(e) => Err(e),
        };
        match saved {
            Ok((_, _, path)) => paths.push(path),
            Err(e) => notes.push(format!("({name} wasn't passed on: {e})")),
        }
    }
    let mut body = text.trim().to_string();
    for n in &notes {
        body = if body.is_empty() { n.clone() } else { format!("{body}\n\n{n}") };
    }
    let message = crate::attachments::listed(&body, &paths);
    if message.trim().is_empty() {
        return say(s, profile_id, token, chat_id, "Send text, photos, voice notes or files: they go to your assistant.").await;
    }
    // Before it's sent, so a reply that comes at once still goes back.
    let _ = update_progress(s, profile_id, |p| p.awaiting = true);
    match assistant::send(s, profile_id, &message) {
        Ok(_) => {
            if !notes.is_empty() {
                say(s, profile_id, token, chat_id, &notes.join("\n")).await;
            }
            let _ = call(s, token, "sendChatAction", &json!({"chat_id": chat_id, "action": "typing"}), Duration::from_secs(10)).await;
        }
        Err(e) => {
            let _ = update_progress(s, profile_id, |p| p.awaiting = false);
            tracing::warn!(profile = profile_id, "telegram: passing a message on to the assistant: {}", e.1);
            say(s, profile_id, token, chat_id, &format!("That didn't reach the assistant: {}", e.1)).await;
        }
    }
}

/// A press of a prompt's Allow or Deny (`allow:<request id>` or `deny:<request id>`), answered as the
/// board's buttons answer it, if it's the owner's.
async fn button(s: &Shared, profile_id: &str, token: &str, cb: &Value) {
    let reply = |text: &str| json!({"callback_query_id": cb["id"], "text": text});
    let cfg = config(&s.db(), profile_id);
    let (user, chat) = (cb["from"]["id"].as_i64(), cb["message"]["chat"]["id"].as_i64());
    if !cfg.owner.as_ref().is_some_and(|o| Some(o.user_id) == user && Some(o.chat_id) == chat) {
        drop_stranger(s, profile_id, &cb["from"], &cb["message"]["chat"], "button press");
        let _ = call(s, token, "answerCallbackQuery", &reply("Only the person this bot is linked to can answer."), Duration::from_secs(10)).await;
        return;
    }
    let data = cb["data"].as_str().unwrap_or_default();
    let (allow, id) = match data.split_once(':') {
        Some(("allow", id)) => (true, id),
        Some(("deny", id)) => (false, id),
        _ => return,
    };
    let text = match answer(s, profile_id, id, allow) {
        Ok(_) if allow => "Allowed.".to_string(),
        Ok(_) => "Denied.".to_string(),
        Err(e) => {
            // It ended some other way: say how on its message, if it hasn't been.
            if let Some(settled) = settled_prompt(s, id) {
                queue(profile_id, s, Item::Settled { request_id: id.to_string(), outcome: settled });
            }
            e
        }
    };
    let _ = call(s, token, "answerCallbackQuery", &reply(&text), Duration::from_secs(10)).await;
}

/// Answers prompt `id` of profile `profile_id`'s assistant (or one of its routines), as the board's
/// buttons do: a prompt that has expired by now is expired first, so it can't be allowed late.
pub fn answer(s: &Shared, profile_id: &str, id: &str, allow: bool) -> Result<&'static str, String> {
    let row: Option<(String, String, String)> =
        s.db().query_row("SELECT task_id, tool_name, kind FROM permission_requests WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).ok();
    let Some((task_id, tool, kind)) = row else { return Err("That prompt isn't this assistant's.".into()) };
    let task = db::get_task(&s.db(), &task_id).ok().flatten();
    if !task.is_some_and(|t| t.profile_id == profile_id && t.is_assistants()) {
        return Err("That prompt isn't this assistant's.".into());
    }
    // Only what its buttons were offered for: questions, plans and changes to the board are answered there.
    if !super::push_answers::answerable(&json!({"tool_name": tool, "kind": kind})) {
        return Err("Answer this one on the board.".into());
    }
    permissions::expire_due(s, chrono::Utc::now());
    permissions::answer_by(s, id, allow, false, None, permissions::Reply::default(), "telegram").map_err(|e| match e.0.as_u16() {
        409 => "It isn't waiting for an answer any more.".to_string(),
        _ => format!("It couldn't be answered: {}", e.1),
    })
}

/// How prompt `id` ended, as its message is edited to say, if it has.
fn settled_prompt(s: &Shared, id: &str) -> Option<String> {
    let (status, note): (String, Option<String>) =
        s.db().query_row("SELECT status, note FROM permission_requests WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).ok()?;
    (status != "pending").then(|| outcome(&status, note.as_deref()))
}

/// What a prompt that ended with `status` says at its end.
fn outcome(status: &str, note: Option<&str>) -> String {
    match status {
        "allowed" => "✅ Allowed".into(),
        "denied" => "❌ Denied".into(),
        "expired" if note == Some(permissions::EXPIRED_UNANSWERED) => "⌛ Expired: nobody answered in time, so it was denied".into(),
        "expired" => "⌛ Ended: the run stopped before it was answered".into(),
        other => format!("Ended ({other})"),
    }
}

// ---------- what goes out ----------

/// Something to send to a profile's owner.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Item {
    /// The assistant's words, in Markdown.
    Markdown { md: String },
    /// Made here, in Telegram's HTML.
    Html { html: String },
    /// A permission prompt, with Allow and Deny if `buttons`.
    Prompt { request_id: String, html: String, buttons: bool },
    /// A prompt sent before ended (`outcome`): its message is edited to say so.
    Settled { request_id: String, outcome: String },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Queued {
    pub id: u64,
    pub item: Item,
    /// The pieces of a long message sent already.
    #[serde(default)]
    pub sent: usize,
}

/// A profile's sends that haven't gone yet, oldest first: kept (in `telegram_outbox:<id>`) until
/// Telegram takes each, so that a failure or a restart doesn't lose them.
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct Outbox {
    #[serde(default)]
    pub next: u64,
    #[serde(default)]
    pub items: std::collections::VecDeque<Queued>,
}

/// The most sends kept for a profile while Telegram can't be reached: the oldest go past it.
const MAX_QUEUED: usize = 300;

/// The longest wait between tries of a send that failed.
const MAX_BACKOFF: u64 = 300;

pub fn outbox(c: &Connection, profile_id: &str) -> Outbox {
    read(c, &outbox_key(profile_id))
}

fn update_outbox<R>(s: &Shared, profile_id: &str, f: impl FnOnce(&mut Outbox) -> R) -> anyhow::Result<R> {
    let c = s.db();
    let mut o = outbox(&c, profile_id);
    let r = f(&mut o);
    write(&c, &outbox_key(profile_id), &o)?;
    Ok(r)
}

/// Queues `item` for profile `profile`'s owner, and wakes its sender.
fn queue(profile: &str, s: &Shared, item: Item) {
    let queued = update_outbox(s, profile, |o| {
        o.next += 1;
        o.items.push_back(Queued { id: o.next, item, sent: 0 });
        while o.items.len() > MAX_QUEUED {
            o.items.pop_front();
        }
    });
    match queued {
        Ok(()) => s.telegram.waker(profile).notify_one(),
        Err(e) => tracing::warn!(profile, "telegram: queueing a send: {e:#}"),
    }
}

/// Whether a failed call may work if tried again later: Telegram unreachable or failing, too many
/// requests, or a token that may be set again.
fn transient(e: &CallError) -> bool {
    match e {
        CallError::Net(_) => true,
        CallError::Api { code, .. } => *code == 429 || *code == 401 || *code >= 500,
    }
}

/// Sends profile `profile_id`'s queue, in order (a prompt's edit after the prompt), for as long as it has
/// a bot: each item stays queued until Telegram takes it, and one that failed for a while is tried again
/// later, waiting longer each time. One Telegram refuses outright is dropped.
async fn sender(s: Shared, profile_id: String) {
    reconcile(&s, &profile_id);
    let waker = s.telegram.waker(&profile_id);
    let mut backoff = 1;
    loop {
        let next = outbox(&s.db(), &profile_id).items.front().cloned();
        let Some(q) = next else {
            waker.notified().await;
            continue;
        };
        let Some((token, _, owner)) = linked(&s.db(), &profile_id) else {
            // Nobody to send to: what was queued was for a chat that's gone.
            let _ = update_outbox(&s, &profile_id, |o| o.items.clear());
            continue;
        };
        match deliver(&s, &profile_id, &token, owner.chat_id, &q).await {
            Ok(()) => {
                backoff = 1;
                set_error(&s, &profile_id, None);
                let _ = update_outbox(&s, &profile_id, |o| o.items.retain(|x| x.id != q.id));
            }
            Err(e) if transient(&e) => {
                note_error(&s, &profile_id, &e);
                let wait = match &e {
                    CallError::Api { retry_after: Some(r), .. } => (*r).clamp(1, MAX_BACKOFF),
                    CallError::Api { code: 401, .. } => MAX_BACKOFF,
                    _ => backoff,
                };
                backoff = (backoff * 2).min(MAX_BACKOFF);
                // Something newly queued doesn't hurry it: the queue goes in order.
                tokio::time::sleep(Duration::from_secs(wait)).await;
            }
            Err(e) => {
                note_error(&s, &profile_id, &e);
                tracing::warn!(profile = profile_id, "telegram: dropped a send Telegram refused: {e}");
                let _ = update_outbox(&s, &profile_id, |o| o.items.retain(|x| x.id != q.id));
                if let Item::Settled { request_id, .. } = &q.item {
                    let _ = update_progress(&s, &profile_id, |p| p.prompts.remove(request_id));
                }
            }
        }
    }
}

/// Sends one queued item.
async fn deliver(s: &Shared, profile_id: &str, token: &str, chat: i64, q: &Queued) -> Result<(), CallError> {
    match &q.item {
        Item::Markdown { md } => {
            // Carrying on after the pieces sent already.
            for (i, piece) in split(md, PIECE_CHARS).iter().enumerate().skip(q.sent) {
                send_html(s, token, chat, &to_html(piece), Some(piece), None).await?;
                let _ = update_outbox(s, profile_id, |o| o.items.iter_mut().filter(|x| x.id == q.id).for_each(|x| x.sent = i + 1));
            }
            Ok(())
        }
        Item::Html { html } => send_html(s, token, chat, html, None, None).await.map(|_| ()),
        Item::Prompt { request_id, html, buttons } => {
            let markup = buttons.then(|| {
                json!({"inline_keyboard": [[
                    {"text": "✅ Allow", "callback_data": format!("allow:{request_id}")},
                    {"text": "❌ Deny", "callback_data": format!("deny:{request_id}")},
                ]]})
            });
            let message_id = send_html(s, token, chat, html, None, markup).await?;
            if *buttons {
                let _ = update_progress(s, profile_id, |p| {
                    p.prompts.insert(request_id.clone(), SentPrompt { message_id, html: html.clone() });
                    while p.prompts.len() > MAX_PROMPTS {
                        let oldest = p.prompts.iter().min_by_key(|(_, v)| v.message_id).map(|(k, _)| k.clone());
                        oldest.map(|k| p.prompts.remove(&k));
                    }
                });
            }
            Ok(())
        }
        Item::Settled { request_id, outcome } => {
            // Its message is forgotten only once it's edited, so a failed edit is tried again.
            let Some(sent) = progress(&s.db(), profile_id).prompts.get(request_id).cloned() else { return Ok(()) };
            let body = json!({
                "chat_id": chat,
                "message_id": sent.message_id,
                "text": format!("{}\n\n<b>{}</b>", sent.html, escape(outcome)),
                "parse_mode": "HTML",
                "reply_markup": {"inline_keyboard": []},
            });
            match call_patiently(s, token, "editMessageText", &body).await {
                Err(CallError::Api { code: 400, description, .. }) if description.contains("not modified") => {}
                r => {
                    r?;
                }
            }
            let _ = update_progress(s, profile_id, |p| p.prompts.remove(request_id));
            Ok(())
        }
    }
}

/// Prompts whose messages still have their buttons but that ended while nobody was sending (the board
/// was down, say): their edits are queued.
fn reconcile(s: &Shared, profile_id: &str) {
    let sent: Vec<String> = progress(&s.db(), profile_id).prompts.into_keys().collect();
    let queued: Vec<String> = outbox(&s.db(), profile_id)
        .items
        .into_iter()
        .filter_map(|q| match q.item {
            Item::Prompt { request_id, .. } | Item::Settled { request_id, .. } => Some(request_id),
            _ => None,
        })
        .collect();
    for id in sent.into_iter().filter(|id| !queued.contains(id)) {
        let row: Option<(String, Option<String>)> =
            s.db().query_row("SELECT status, note FROM permission_requests WHERE id=?1", [&id], |r| Ok((r.get(0)?, r.get(1)?))).ok();
        let ended = match row {
            Some((status, _)) if status == "pending" => continue,
            Some((status, note)) => outcome(&status, note.as_deref()),
            // Gone with its thread.
            None => "Ended".to_string(),
        };
        queue(profile_id, s, Item::Settled { request_id: id, outcome: ended });
    }
}

/// Watches this host's events for what the assistants' owners hear of on Telegram.
async fn watch(s: Shared, mut rx: tokio::sync::broadcast::Receiver<Value>) {
    // The assistants' statuses and whether they run, to tell when one comes to need attention or stops.
    let mut statuses: HashMap<String, (String, bool)> = HashMap::new();
    loop {
        let ev = match rx.recv().await {
            Ok(ev) => ev,
            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                tracing::warn!("telegram: missed {n} events");
                continue;
            }
            Err(_) => return,
        };
        observe(&s, &ev, &mut statuses);
    }
}

/// What event `ev` sends to Telegram, if anything.
pub(crate) fn observe(s: &Shared, ev: &Value, statuses: &mut HashMap<String, (String, bool)>) {
    match ev["type"].as_str() {
        Some("message") => on_message(s, &ev["message"]),
        Some("message_updated") => {
            let m = &ev["message"];
            let status = m["data"]["status"].as_str().unwrap_or("pending");
            if m["kind"] != "permission" || status == "pending" {
                return;
            }
            let (Some(task_id), Some(request)) = (m["task_id"].as_str(), m["data"]["request_id"].as_str()) else { return };
            let Some(t) = assistants_task(s, task_id) else { return };
            let note = m["data"]["note"].as_str();
            queue(&t.profile_id, s, Item::Settled { request_id: request.into(), outcome: outcome(status, note) });
        }
        Some("task") => {
            let t = &ev["task"];
            if t["task_type"] != "assistant" {
                return;
            }
            let (Some(id), Some(status)) = (t["id"].as_str(), t["status"].as_str()) else { return };
            let running = t["running"] == json!(true);
            let before = statuses.insert(id.to_string(), (status.to_string(), running));
            let Some((was, ran)) = before else { return };
            if ran && !running {
                let task = db::get_task(&s.db(), id).ok().flatten();
                if let Some(task) = task {
                    run_ended(s, &task);
                }
            }
            if status != "needs_attention" || was == "needs_attention" {
                return;
            }
            let Ok(Some(task)) = db::get_task(&s.db(), id) else { return };
            on_attention(s, &task);
        }
        Some("task_deleted") => {
            if let Some(id) = ev["id"].as_str() {
                statuses.remove(id);
            }
        }
        _ => {}
    }
}

/// Task `task_id`, if it's an assistant's or its routine's and its profile's bot is linked.
fn assistants_task(s: &Shared, task_id: &str) -> Option<Task> {
    let t = db::get_task(&s.db(), task_id).ok().flatten().filter(Task::is_assistants)?;
    linked(&s.db(), &t.profile_id).map(|_| t)
}

fn events_of(s: &Shared, profile_id: &str) -> Events {
    config(&s.db(), profile_id).events
}

/// The key a task goes by (`A-3`).
fn key(t: &Task) -> String {
    format!("{}-{}", db::ASSISTANT_TASK_KEY, t.number)
}

fn on_message(s: &Shared, m: &Value) {
    let kind = m["kind"].as_str().unwrap_or_default();
    let data = &m["data"];
    let relevant = match kind {
        "claude" => data["type"] == "result",
        "report" => true,
        "permission" | "question" => data["status"] == "pending",
        _ => false,
    };
    if !relevant {
        return;
    }
    if kind == "claude" {
        // Every assistant's, for push (push::REPLY_EVENT), whether or not it has a bot.
        let task = m["task_id"].as_str().and_then(|id| db::get_task(&s.db(), id).ok().flatten()).filter(Task::is_assistant);
        if let Some(task) = task {
            on_turn_end(s, &task, m["id"].as_i64().unwrap_or_default(), TurnEnd::of(data));
        }
        return;
    }
    let Some(task) = m["task_id"].as_str().and_then(|id| assistants_task(s, id)) else { return };
    let events = events_of(s, &task.profile_id);
    match kind {
        "report" if events.reports && task.is_assistant() => {
            let name = data["automation"].as_str().unwrap_or("A routine");
            let text = data["text"].as_str().unwrap_or_default();
            let head = match data["outcome"].as_str() {
                Some("failed") => format!("⚠️ **{name}** failed:"),
                Some("asked") => format!("❓ **{name}** needs you:"),
                _ => format!("📋 **{name}**"),
            };
            queue(&task.profile_id, s, Item::Markdown { md: format!("{head}\n\n{text}") });
        }
        "permission" if events.prompts => on_prompt(s, &task, data),
        "question" if events.prompts && task.is_assistant() => {
            let mut html = format!("❓ <b>{}</b> asks:\n\n{}", escape(&key(&task)), escape(data["question"].as_str().unwrap_or_default()));
            for (i, o) in data["options"].as_array().into_iter().flatten().enumerate() {
                html.push_str(&format!("\n{}. {}", i + 1, escape(o["label"].as_str().unwrap_or_default())));
            }
            html.push_str("\n\n<i>Reply here to answer.</i>");
            queue(&task.profile_id, s, Item::Html { html });
        }
        _ => {}
    }
}

/// How the assistant's turn ended, from its `result`: only a turn that went as it should is a reply.
#[derive(Clone, Copy, PartialEq, Debug)]
enum TurnEnd {
    Reply,
    /// A compaction's end (a `/compact` run's, the user's or the board's after the thread was idle a while), which
    /// answers nothing.
    Compact,
    /// It failed (an error, or the usage limit) or was stopped part way: its needs attention says so.
    Failed,
}

impl TurnEnd {
    fn of(result: &Value) -> Self {
        if result["compact"] == json!(true) {
            TurnEnd::Compact
        } else if result["is_error"] == json!(true) || result["interrupted"] == json!(true) || result["subtype"].as_str().is_some_and(|t| t.starts_with("error")) {
            TurnEnd::Failed
        } else {
            TurnEnd::Reply
        }
    }
}

/// The assistant's turn ended (its `result`, message `message_id`): its reply goes back if a message
/// from Telegram was waiting for one, or if every reply is to. Either way it's announced for push
/// (`announce_reply`), which sends the replies that weren't asked for on Telegram. A turn that isn't a reply
/// (`TurnEnd`) is only noted as looked at: a compaction leaves a message from Telegram waiting for the next turn, and a
/// failed turn has answered it (with the attention it needs, see `on_attention`).
fn on_turn_end(s: &Shared, task: &Task, message_id: i64, end: TurnEnd) {
    let text = if end == TurnEnd::Reply { reply_text(s, task, message_id) } else { None };
    let Some((_, cfg, _)) = linked(&s.db(), &task.profile_id) else {
        // No bot: nothing came from Telegram, and the turn's result comes once.
        if text.is_some() {
            announce_reply(s, task, message_id, false);
        }
        return;
    };
    // A message queued or steered in that this turn didn't take is answered by the next.
    let more = db::get_task(&s.db(), &task.id).ok().flatten().is_some_and(|t| t.queued_message.is_some() || !t.steering.is_empty());
    let seen = update_progress(s, &task.profile_id, |p| {
        if message_id <= p.replied {
            return None;
        }
        p.replied = message_id;
        if end == TurnEnd::Compact {
            return None;
        }
        let asked = p.awaiting;
        p.awaiting = asked && more;
        (end == TurnEnd::Reply).then_some((asked || cfg.events.replies, asked))
    });
    let Ok(Some((send, asked))) = seen else { return };
    let Some(text) = text else { return };
    announce_reply(s, task, message_id, asked);
    if send {
        queue(&task.profile_id, s, Item::Markdown { md: text });
    }
}

/// What the assistant said in the turn that ended with message `message_id`: since the user's last message, and
/// since the turn before ended (so a turn that said nothing doesn't say the last one's reply again). None if it said
/// nothing.
fn reply_text(s: &Shared, task: &Task, message_id: i64) -> Option<String> {
    let c = s.db();
    let asked: i64 = c
        .query_row(
            "SELECT COALESCE(MAX(id), 0) FROM messages WHERE task_id=?1 AND id < ?2
               AND (kind='user' OR (kind='claude' AND json_extract(data,'$.type')='result'))",
            rusqlite::params![task.id, message_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    db::last_assistant_text_after(&c, &task.id, asked).ok().flatten().filter(|t| !t.trim().is_empty())
}

/// Tells the board (its push, push::REPLY_EVENT) that the assistant replied, and whether to a message sent on
/// Telegram, which is the one thing only this host knows: the board's push sends the others.
fn announce_reply(s: &Shared, task: &Task, message_id: i64, telegram: bool) {
    s.emit(json!({"type": super::push::REPLY_EVENT, "task_id": task.id, "profile_id": task.profile_id, "message_id": message_id, "telegram": telegram}));
}

/// The assistant's run ended. A turn it ended with is answered as its `result` comes (once, whichever is
/// seen first), and a run that stopped without one (it failed, or was stopped) leaves nothing to answer:
/// a message from Telegram no longer waits for a reply, so the next turn's isn't sent for it.
fn run_ended(s: &Shared, task: &Task) {
    if !task.is_assistant() || linked(&s.db(), &task.profile_id).is_none() {
        return;
    }
    let (last_result, data): (i64, String) = s
        .db()
        .query_row(
            "SELECT id, data FROM messages WHERE task_id=?1 AND kind='claude' AND json_extract(data,'$.type')='result' ORDER BY id DESC LIMIT 1",
            [&task.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or((0, String::new()));
    let replied = progress(&s.db(), &task.profile_id).replied;
    if last_result > replied {
        let end = TurnEnd::of(&serde_json::from_str(&data).unwrap_or(Value::Null));
        on_turn_end(s, task, last_result, end);
        // A compaction answered nothing: as a run that stopped without a turn's end.
        if end != TurnEnd::Compact {
            return;
        }
    }
    let more = task.queued_message.is_some() || !task.steering.is_empty();
    if !more {
        let _ = update_progress(s, &task.profile_id, |p| p.awaiting = false);
    }
}

/// A prompt the assistant (or one of its routines) raised: with Allow and Deny if those can answer it.
fn on_prompt(s: &Shared, task: &Task, data: &Value) {
    let Some(request) = data["request_id"].as_str() else { return };
    let buttons = super::push_answers::answerable(data);
    let mut html = format!("🔐 <b>{} {}</b>\n{}", escape(&key(task)), escape(&cut(&task.title, 80)), escape(&super::push::prompt_text(data)));
    if buttons {
        let summary = crate::agent::approval_rules::summarize(&data["input"]);
        if !summary.trim().is_empty() {
            html.push_str(&format!("\n<code>{}</code>", escape(&cut(&summary, 500))));
        }
        if let Some(rule) = data["rule"]["tool"].as_str() {
            html.push_str(&format!("\n<i>Asked by the rule {}</i>", escape(rule)));
        }
        if let Some(at) = data["expires_at"].as_str().and_then(|a| chrono::DateTime::parse_from_rfc3339(a).ok()) {
            html.push_str(&format!("\n<i>Denied if not answered by {}</i>", at.with_timezone(&chrono::Local).format("%H:%M")));
        }
    } else {
        html.push_str("\n<i>Answer it on the board.</i>");
    }
    queue(&task.profile_id, s, Item::Prompt { request_id: request.into(), html, buttons });
}

/// The assistant came to need attention: said, unless it's for a prompt or question that was sent
/// already, or the user stopped it.
fn on_attention(s: &Shared, task: &Task) {
    if !linked(&s.db(), &task.profile_id).is_some() || !events_of(s, &task.profile_id).attention {
        return;
    }
    let reason = task.attention_reason.clone().unwrap_or_default();
    if reason == "Stopped by user" {
        return;
    }
    let waiting: i64 = s
        .db()
        .query_row(
            "SELECT (SELECT COUNT(*) FROM permission_requests WHERE task_id=?1 AND status='pending')
                  + (SELECT COUNT(*) FROM messages WHERE task_id=?1 AND kind='question' AND json_extract(data,'$.status')='pending')",
            [&task.id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if waiting > 0 {
        return;
    }
    let reason = if reason.is_empty() { String::new() } else { format!(": {}", escape(&cut(&reason, 300))) };
    queue(&task.profile_id, s, Item::Html { html: format!("⚠️ <b>{}</b> needs attention{reason}", escape(&key(task))) });
}

// ---------- API ----------

/// What the API shows of profile `profile_id`'s bot: never its token.
fn view(s: &Shared, profile_id: &str) -> Value {
    let (has_token, cfg) = {
        let c = s.db();
        (token(&c, profile_id).is_some(), config(&c, profile_id))
    };
    let linking = cfg.link.as_ref().filter(|l| l.expires_at > now()).map(|l| json!({"expires_at": l.expires_at}));
    json!({
        "configured": has_token,
        "bot": cfg.bot,
        "owner": cfg.owner.as_ref().map(|o| json!({"name": o.name, "username": o.username, "linked_at": o.linked_at})),
        "events": cfg.events,
        "linking": linking,
        "last_error": cfg.last_error,
        "dropped": cfg.dropped,
        "polling": has_token && polling(s, profile_id),
        "queued": outbox(&s.db(), profile_id).items.len(),
    })
}

fn check_profile(s: &Shared, id: &str) -> ApiResult<()> {
    db::get_profile(&s.db(), id)?.map(|_| ()).ok_or_else(|| ApiError::not_found("profile"))
}

/// `GET /profiles/{id}/telegram` (API 104): the profile's bot, who it's linked to and what it sends.
pub async fn get(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    check_profile(&s, &id)?;
    Ok(Json(view(&s, &id)))
}

#[derive(Deserialize)]
pub struct Change {
    /// A bot token from @BotFather, or null to remove the bot. Left out, it stays.
    #[serde(default, deserialize_with = "some")]
    token: Option<Option<String>>,
    events: Option<Events>,
}

/// A field that's there (null included) as Some.
fn some<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

/// `PATCH /profiles/{id}/telegram`: sets the bot's token (checked with Telegram) or removes the bot,
/// and what it sends. A new bot is linked again.
pub async fn update(State(s): State<Shared>, Path(id): Path<String>, Json(b): Json<Change>) -> ApiResult<Json<Value>> {
    check_profile(&s, &id)?;
    match b.token {
        Some(Some(t)) => {
            let t = t.trim().to_string();
            if !valid_token(&t) {
                return Err(ApiError::bad("that isn't a bot token: @BotFather gives one like 123456789:AAH…"));
            }
            // Another of this host's profiles already reads this bot (by its id, the token's first part, as a
            // bot's token can be replaced): only one can.
            let bot_id = |t: &str| t.split(':').next().unwrap_or_default().to_string();
            let profiles = db::list_profiles(&s.db())?;
            if profiles.iter().any(|p| p.id != id && token(&s.db(), &p.id).is_some_and(|o| bot_id(&o) == bot_id(&t))) {
                return Err(ApiError::conflict("another profile's assistant already uses this bot: make one for each"));
            }
            let me = call(&s, &t, "getMe", &json!({}), Duration::from_secs(20)).await.map_err(|e| ApiError::bad(format!("checking the token: {e}")))?;
            let bot = Bot { id: me["id"].as_i64().unwrap_or_default(), username: me["username"].as_str().unwrap_or_default().to_string() };
            {
                let c = s.db();
                let same_bot = config(&c, &id).bot.as_ref().is_some_and(|old| old.id == bot.id);
                db::set_setting(&c, &token_key(&id), Some(&t))?;
                let mut cfg = config(&c, &id);
                if !same_bot {
                    // Another bot: its chats and updates are its own.
                    cfg.owner = None;
                    cfg.link = None;
                    cfg.dropped = None;
                    write(&c, &progress_key(&id), &Progress::default())?;
                    db::set_setting(&c, &outbox_key(&id), None)?;
                }
                cfg.bot = Some(bot);
                cfg.last_error = None;
                write(&c, &config_key(&id), &cfg)?;
            }
            restart(&s, &id);
        }
        Some(None) => remove_bot(&s, &id)?,
        None => {}
    }
    if let Some(events) = b.events {
        update_config(&s, &id, |c| c.events = events)?;
    }
    changed(&s, &id);
    Ok(Json(view(&s, &id)))
}

/// `POST /profiles/{id}/telegram/link`: a new one-time code to send the bot as `/start <code>`, which
/// links the chat it's sent from (in place of the one linked before, if any).
pub async fn new_link(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    check_profile(&s, &id)?;
    if token(&s.db(), &id).is_none() {
        return Err(ApiError::conflict("set the bot's token first"));
    }
    let code: String = crate::util::new_token().chars().filter(char::is_ascii_alphanumeric).take(16).collect();
    let expires_at = (chrono::Utc::now() + chrono::Duration::minutes(CODE_MINUTES)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let bot = update_config(&s, &id, |c| {
        c.link = Some(Link { code_hash: hash(&code), expires_at: expires_at.clone() });
        c.bot.clone()
    })?;
    changed(&s, &id);
    let url = bot.filter(|b| !b.username.is_empty()).map(|b| format!("https://t.me/{}?start={code}", b.username));
    Ok(Json(json!({"code": code, "command": format!("/start {code}"), "url": url, "expires_at": expires_at})))
}

/// `DELETE /profiles/{id}/telegram/owner`: unlinks the chat; the bot then listens to nobody until it's
/// linked again.
pub async fn unlink(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    check_profile(&s, &id)?;
    update_config(&s, &id, |c| {
        c.owner = None;
        c.link = None;
    })?;
    update_progress(&s, &id, |p| {
        p.prompts.clear();
        p.awaiting = false;
    })?;
    update_outbox(&s, &id, |o| o.items.clear())?;
    changed(&s, &id);
    Ok(Json(view(&s, &id)))
}
