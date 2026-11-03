//! Devices paired with this board, such as the mobile app on a phone (API 98). Each has a token of its own, kept only
//! as its SHA-256 in `device_tokens`, which the API takes as well as the board's own token (`auth_token`), and which
//! can be revoked: that cuts the device off at once, open websockets included. A lost phone is then no reason to
//! replace `auth_token`.
//!
//! A device pairs from Settings → Network access, which shows a QR code of `huntaway://pair?url=<board>&code=<code>`.
//! The code is good for five minutes and one pairing (`POST /devices/pair` swaps it and the device's name for its
//! token), and is only kept in memory, so a restart forgets it. The QR code never holds `auth_token`.
//!
//! Paired devices can use the board as its token can, except what would outlast revoking them (see `forbidden`):
//! the routes that hand out the board's or hub's token or a Claude login, and terminals, which are a shell on the host.
//! Nor can they pair more devices or manage the others: they may only list them and unpair themselves.
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

/// Why a paired device can't make a request to `path` (an `/api/...` path, maybe through the hub as
/// `/api/h/<host>/...`), if it can't: what it would get outlasts revoking the device.
pub fn forbidden(path: &str) -> Option<&'static str> {
    let path = path.strip_prefix("/api").unwrap_or(path);
    // Through the hub, to a host: the host's own route.
    let path = match path.strip_prefix("/h/") {
        Some(rest) => rest.find('/').map_or("", |i| &rest[i..]),
        None => path,
    };
    let parts: Vec<&str> = path.trim_end_matches('/').split('/').skip(1).collect();
    match parts.as_slice() {
        // The board's token and the hub's, which a host joins with.
        ["hosts", "join", ..] => Some("a paired device can't get the board's tokens: link hosts from the board"),
        // A shell on the host, which can read anything the board can.
        ["tasks", _, "terminal", ..] => Some("a paired device can't open terminals: use the web board"),
        // A Claude login, with its credentials.
        ["claude-configs", _, "archive"] | ["profiles", _, "claude-config"] => Some("a paired device can't export or import Claude logins: use the web board"),
        _ => None,
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
