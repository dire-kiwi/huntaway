//! Devices paired with this board, such as the mobile app on a phone (API 100). Each has a token of its own, kept only
//! as its SHA-256 in `device_tokens`, which the API takes as well as the board's own token (`auth_token`), and which
//! can be revoked: that cuts the device off at once, open websockets included. A lost phone is then no reason to
//! replace `auth_token`.
//!
//! A device pairs from Settings → Network access, which shows a QR code of `huntaway://pair?url=<board>&code=<code>`.
//! The code is good for five minutes and one pairing (`POST /devices/pair` swaps it and the device's name for its
//! token), and is only kept in memory, so a restart forgets it. The QR code never holds `auth_token`.
//!
//! Paired devices can only use the routes the mobile app needs (see `HUB`): profiles, projects, tasks and their
//! threads, each profile's assistant, attachments, permission prompts, the board's events and hosts, and the devices
//! list, from which they may only unpair themselves. Nothing that would outlast revoking them: not the routes that hand out the board's or hub's
//! token or a Claude login, linking hosts, terminals (a shell on the host), settings or admin.
//!
//! Revoking a device stops the device. It doesn't undo what was done with it before: whoever held it could have had an
//! agent read the board's files (its `auth_token` among them), as any agent run can. After a phone is lost and may
//! have been used, replace `auth_token` too (delete the file and restart: a new one is made).

use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::watch;

use crate::state::{ApiError, ApiResult, Shared};
use crate::util::now;

/// How long a pairing code is good for.
pub const CODE_TTL: Duration = Duration::from_secs(5 * 60);

/// Codes waiting to be used at once, at most (older ones go first).
const MAX_CODES: usize = 20;

/// A device's last use is written at most this often.
const LAST_USED_EVERY: chrono::TimeDelta = chrono::TimeDelta::seconds(60);

/// What the board keeps about pairing besides the table: the codes waiting to be used, and a counter that goes up
/// whenever a device is revoked, which the open websockets of paired devices watch.
pub struct Devices {
    codes: Mutex<HashMap<String, Instant>>,
    revoked: watch::Sender<u64>,
}

impl Default for Devices {
    fn default() -> Self {
        Self { codes: Mutex::new(HashMap::new()), revoked: watch::Sender::new(0) }
    }
}

/// A request made with a device's token (a request extension, set by the auth middleware).
#[derive(Clone)]
pub struct DeviceAuth {
    pub id: String,
    /// Subscribed before the token was checked, so a revocation after that is seen.
    revoked: watch::Receiver<u64>,
}

impl DeviceAuth {
    /// Resolves once this device is revoked.
    pub async fn revoked(mut self, s: &Shared) {
        loop {
            if self.revoked.changed().await.is_err() {
                return std::future::pending().await;
            }
            let gone = s.db().query_row("SELECT COUNT(*) = 0 FROM device_tokens WHERE id=?1", [&self.id], |r| r.get::<_, bool>(0)).unwrap_or(false);
            if gone {
                return;
            }
        }
    }
}

/// Runs `work` (a websocket's loop) until it ends or, for a paired device's request, until that device is revoked,
/// when it's dropped, which closes the connection.
pub async fn until_revoked(s: Shared, device: Option<DeviceAuth>, work: impl Future<Output = ()>) {
    match device {
        None => work.await,
        Some(d) => {
            let id = d.id.clone();
            tokio::select! {
                _ = work => {}
                _ = d.revoked(&s) => tracing::info!("closed a websocket of device {id}, which was revoked"),
            }
        }
    }
}

/// What a paired device may do: the routes the mobile app uses, by method and path after `/api`, with `*` for one path
/// parameter. Everything else gets a 403, so a route added to the API is closed to devices until it's added here. It's
/// an allowlist rather than a list of what to refuse because that list missed routes twice (`hosts/copy-claude-config`
/// moves a Claude login to another host, and an encoded path got past it), and what a device must not reach (tokens,
/// Claude logins, terminals, host linking, settings, admin) is most of the API.
///
/// `HUB` routes are the board's own (`/api/<route>`), `HOST` routes a host's, also reached through the hub as
/// `/api/h/<host>/<route>`, where the request is made with the board's or the link's token.
const HUB: &[(&str, &str)] = &[
    ("GET", "ws"),
    ("GET", "hosts"),
    ("GET", "devices"),
    // Only itself (see `revoke`).
    ("DELETE", "devices/*"),
];
const HOST: &[(&str, &str)] = &[
    ("GET", "profiles"),
    ("GET", "profiles/*/projects"),
    ("GET", "profiles/*/tasks"),
    // The profile's assistant (API 101), which the app's Assistant tab opens; its thread is a task's. Not its memory.
    ("GET", "profiles/*/assistant"),
    ("POST", "profiles/*/assistant"),
    ("GET", "projects/*"),
    ("GET", "projects/*/tasks"),
    ("POST", "projects/*/tasks"),
    ("GET", "tasks/*"),
    ("PATCH", "tasks/*"),
    ("GET", "tasks/*/messages"),
    ("POST", "tasks/*/messages"),
    ("POST", "tasks/*/questions/*"),
    ("POST", "tasks/*/stop"),
    ("POST", "attachments"),
    ("GET", "attachments/*/*"),
    ("GET", "permissions"),
    ("POST", "permissions/*"),
];

/// The segments of `path` (an `/api/...` path as the client sent it) as the router sees them, percent-decoded, or
/// `None` where that's in doubt: an encoded `/`, `\` or `%` (a proxied request is decoded once more on its host, so
/// `%252F` would become a `/` there), an encoded `?` or `#` (the hub's proxy puts the decoded path back in a URL, where
/// either would cut it short), an empty segment, `.` or `..`, or bytes that aren't UTF-8.
fn segments(path: &str) -> Option<Vec<String>> {
    path.strip_prefix("/api/")?
        .split('/')
        .map(|raw| percent_decode(raw).filter(|seg| !seg.is_empty() && seg != "." && seg != ".." && !seg.contains(['/', '\\', '%', '?', '#'])))
        .collect()
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match (b[i] == b'%').then(|| b.get(i + 1..i + 3)).flatten().and_then(|h| u8::from_str_radix(std::str::from_utf8(h).ok()?, 16).ok()) {
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
    String::from_utf8(out).ok()
}

/// Whether segments match a route pattern of `HUB` or `HOST`.
fn matches(segs: &[String], pattern: &str) -> bool {
    let pattern: Vec<&str> = pattern.split('/').collect();
    pattern.len() == segs.len() && pattern.iter().zip(segs).all(|(p, s)| *p == "*" || p == s)
}

/// Why a paired device can't make this request, if it can't (see `HUB`): `path` is the whole path, as the client sent
/// it, `/api/...` or `/api/h/<host>/...`. The auth middleware checks it, and the hub's proxy again on the path it
/// forwards with its own token.
pub fn refused(method: &str, path: &str) -> Option<&'static str> {
    let Some(segs) = segments(path) else {
        return Some("a paired device's request must be a plain path: no encoded '/', '\\', '%', '?' or '#', empty segments, '.' or '..'");
    };
    let allowed = match segs.as_slice() {
        [h, _host, rest @ ..] if h == "h" => HOST.iter().any(|(m, p)| *m == method && matches(rest, p)),
        _ => HUB.iter().chain(HOST).any(|(m, p)| *m == method && matches(&segs, p)),
    };
    (!allowed).then_some("a paired device can't use this part of the API (tokens, Claude logins, terminals, hosts, settings): use the web board")
}

/// `refused` for the path the hub's proxy forwards to a host (`rest`, after `/api/h/<host>/`, as decoded by the router).
pub fn refused_on_host(method: &str, rest: &str) -> Option<&'static str> {
    refused(method, &format!("/api/h/-/{rest}"))
}

/// The second check, in the handlers of what must never reach a device whatever `refused` lets through: the board's
/// tokens, Claude logins, terminals and linking hosts. Through the hub's proxy, the request to this host carries the
/// device too (but a linked host's, made with the link's token, doesn't: there it's `refused` alone).
pub fn board_only(device: &Option<Extension<DeviceAuth>>, what: &str) -> ApiResult<()> {
    match device {
        Some(_) => Err(ApiError(StatusCode::FORBIDDEN, format!("a paired device can't {what}: use the web board"))),
        None => Ok(()),
    }
}

pub const TABLE: &str = "
CREATE TABLE IF NOT EXISTS device_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);";

fn hash(token: &str) -> String {
    aws_lc_rs::digest::digest(&aws_lc_rs::digest::SHA256, token.as_bytes()).as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

/// The device whose token this is, if it's one (and notes that it was used).
pub fn authenticate(s: &Shared, token: &str) -> Option<DeviceAuth> {
    if token.is_empty() {
        return None;
    }
    let revoked = s.devices.revoked.subscribe();
    let c = s.db();
    let (id, last): (String, Option<String>) = c
        .query_row("SELECT id, last_used_at FROM device_tokens WHERE token_hash=?1", [hash(token)], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .ok()
        .flatten()?;
    let stale = last.and_then(|l| chrono::DateTime::parse_from_rfc3339(&l).ok()).is_none_or(|l| chrono::Utc::now() - l.to_utc() >= LAST_USED_EVERY);
    if stale {
        let _ = c.execute("UPDATE device_tokens SET last_used_at=?1 WHERE id=?2", params![now(), id]);
    }
    Some(DeviceAuth { id, revoked })
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

fn list(c: &Connection) -> rusqlite::Result<Vec<Device>> {
    let mut st = c.prepare("SELECT id, name, created_at, last_used_at FROM device_tokens ORDER BY created_at, rowid")?;
    let rows = st.query_map([], |r| Ok(Device { id: r.get(0)?, name: r.get(1)?, created_at: r.get(2)?, last_used_at: r.get(3)? }))?;
    rows.collect()
}

fn get(c: &Connection, id: &str) -> rusqlite::Result<Option<Device>> {
    Ok(list(c)?.into_iter().find(|d| d.id == id))
}

fn clean_name(name: &str) -> String {
    let name: String = name.trim().chars().filter(|c| !c.is_control()).take(100).collect();
    if name.is_empty() { "Phone".into() } else { name }
}

fn not_from_device(device: &Option<Extension<DeviceAuth>>) -> ApiResult<()> {
    match device {
        Some(_) => Err(ApiError(StatusCode::FORBIDDEN, "paired devices can't pair or manage devices: do it from the board".into())),
        None => Ok(()),
    }
}

/// `POST /devices/pairing`: a new one-time code for Settings → Network access's QR code.
pub async fn new_code(State(s): State<Shared>, device: Option<Extension<DeviceAuth>>) -> ApiResult<Json<Value>> {
    not_from_device(&device)?;
    let code = uuid::Uuid::new_v4().simple().to_string();
    let now_i = Instant::now();
    let mut codes = s.devices.codes.lock().unwrap();
    codes.retain(|_, until| *until > now_i);
    while codes.len() >= MAX_CODES {
        let oldest = codes.iter().min_by_key(|(_, until)| **until).map(|(c, _)| c.clone()).unwrap();
        codes.remove(&oldest);
    }
    codes.insert(code.clone(), now_i + CODE_TTL);
    let expires_at = (chrono::Utc::now() + CODE_TTL).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    Ok(Json(json!({"code": code, "expires_at": expires_at, "ttl_secs": CODE_TTL.as_secs()})))
}

#[derive(Deserialize)]
pub struct Pair {
    code: String,
    #[serde(default)]
    name: String,
}

/// `POST /devices/pair`, without the board's token: swaps a pairing code (once) and the device's name for a token.
pub async fn pair(State(s): State<Shared>, Json(b): Json<Pair>) -> ApiResult<Json<Value>> {
    let valid = {
        let mut codes = s.devices.codes.lock().unwrap();
        codes.remove(b.code.trim()).is_some_and(|until| until > Instant::now())
    };
    if !valid {
        return Err(ApiError(StatusCode::FORBIDDEN, "this pairing code has expired or was already used: show a new one on the board".into()));
    }
    let token = crate::util::new_token();
    let id = crate::util::new_id();
    let c = s.db();
    c.execute(
        "INSERT INTO device_tokens (id, name, token_hash, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![id, clean_name(&b.name), hash(&token), now()],
    )?;
    let device = get(&c, &id)?.ok_or_else(|| ApiError::not_found("device"))?;
    drop(c);
    tracing::info!("paired device {:?}", device.name);
    Ok(Json(json!({"token": token, "device": device, "host_id": s.host_id, "host_name": s.host_name, "api_version": crate::hosts::proto::API_VERSION})))
}

/// `GET /devices`: the paired devices, and which one asked (`current`, for a device).
pub async fn list_handler(State(s): State<Shared>, device: Option<Extension<DeviceAuth>>) -> ApiResult<Json<Value>> {
    let devices = list(&s.db())?;
    Ok(Json(json!({"devices": devices, "current": device.map(|d| d.0.id)})))
}

#[derive(Deserialize)]
pub struct Rename {
    name: String,
}

pub async fn rename(State(s): State<Shared>, device: Option<Extension<DeviceAuth>>, Path(id): Path<String>, Json(b): Json<Rename>) -> ApiResult<Json<Value>> {
    not_from_device(&device)?;
    let c = s.db();
    if c.execute("UPDATE device_tokens SET name=?1 WHERE id=?2", params![clean_name(&b.name), id])? == 0 {
        return Err(ApiError::not_found("device"));
    }
    Ok(Json(json!(get(&c, &id)?.ok_or_else(|| ApiError::not_found("device"))?)))
}

/// `DELETE /devices/{id}`: revokes a device (from the board, or the device itself when it's removed from the app).
pub async fn revoke(State(s): State<Shared>, device: Option<Extension<DeviceAuth>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    if device.as_ref().is_some_and(|d| d.id != id) {
        not_from_device(&device)?;
    }
    let n = s.db().execute("DELETE FROM device_tokens WHERE id=?1", [&id])?;
    if n == 0 {
        return Err(ApiError::not_found("device"));
    }
    s.devices.revoked.send_modify(|n| *n += 1);
    tracing::info!("revoked device {id}");
    Ok(Json(json!({"ok": true})))
}

#[cfg(test)]
mod tests;
