//! Answering a permission prompt from a notification (Allow and Deny on a push, see push.rs and
//! app/public/sw.js), without the board's token: each push about a prompt carries a token that can
//! only answer that one prompt, once (`POST /api/permissions/{id}/push-answer`).
//!
//! The board that sends the push (the hub, which watches every host's events) mints the token and
//! keeps its hash, so the hub is also where it's checked: the prompt itself may be on a linked host,
//! which the hub then answers through the link as the board's UI would (`/api/h/<host>/permissions/{id}`).
//! Nothing here depends on how the token reaches the device, so a native app's push can carry one too.
//!
//! A token stops working once its prompt has been answered (from the notification or anywhere
//! else) or has expired, which the hub learns from the host's events, or from the host's answer
//! when it missed them (a link that was down).

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::state::{ApiError, Shared};
use crate::util::{new_token, now};

/// How long a token is kept after it's minted, at most: prompts end with their run long before.
const KEEP_DAYS: i64 = 30;

fn hash(token: &str) -> String {
    aws_lc_rs::digest::digest(&aws_lc_rs::digest::SHA256, token.as_bytes()).as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

/// A new token that answers prompt `request_id` (of task `task_id`) on host `host_id`. A prompt can
/// have several (each push about it gets one), and the first answer with any of them settles it.
/// A prompt that expires (`expires_at`, from a routine run, see permissions::expiry) can't be
/// answered from its notifications after that, even if the hub hasn't heard yet.
pub fn mint(c: &Connection, host_id: &str, request_id: &str, task_id: &str, expires_at: Option<&str>) -> anyhow::Result<String> {
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(KEEP_DAYS)).to_rfc3339();
    c.execute("DELETE FROM push_answer_tokens WHERE created_at < ?1", [cutoff])?;
    let token = new_token();
    // A prompt already settled stays so for its new tokens too.
    let status: String = c
        .query_row("SELECT status FROM push_answer_tokens WHERE request_id=?1 AND host_id=?2 LIMIT 1", [request_id, host_id], |r| r.get(0))
        .optional()?
        .unwrap_or_else(|| "pending".into());
    c.execute(
        "INSERT INTO push_answer_tokens (token_hash, request_id, host_id, task_id, status, created_at, expires_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![hash(&token), request_id, host_id, task_id, status, now(), expires_at],
    )?;
    Ok(token)
}

/// Prompt `request_id` on `host_id` was answered or expired (`status`, as its thread message says):
/// its tokens don't answer it any more.
pub fn settle(c: &Connection, host_id: &str, request_id: &str, status: &str) -> anyhow::Result<()> {
    c.execute(
        "UPDATE push_answer_tokens SET status=?1 WHERE request_id=?2 AND host_id=?3 AND status IN ('pending','answering')",
        params![status, request_id, host_id],
    )?;
    Ok(())
}

#[derive(Deserialize)]
pub struct AnswerBody {
    token: String,
    decision: String,
}

/// What an answer from a notification came to: `result` is `allowed` or `denied`, or why it wasn't
/// taken (`answered`, `expired`, `closed`, `invalid`, `offline` or `failed`), with `message` to show.
fn reply(status: StatusCode, result: &str, message: &str) -> Response {
    (status, Json(json!({"result": result, "message": message, "error": (!status.is_success()).then_some(message)}))).into_response()
}

/// Why a settled prompt can't be answered.
fn settled(status: &str) -> Response {
    match status {
        "allowed" => reply(StatusCode::CONFLICT, "answered", "It was already allowed."),
        "denied" => reply(StatusCode::CONFLICT, "answered", "It was already denied."),
        "answering" => reply(StatusCode::CONFLICT, "answered", "It's being answered from another notification."),
        "expired" => reply(StatusCode::CONFLICT, "expired", "It expired: the agent's run ended before it was answered."),
        "timed_out" => reply(StatusCode::CONFLICT, "expired", "It expired: nobody answered it in time, so it was denied."),
        _ => reply(StatusCode::CONFLICT, "closed", "It isn't waiting for an answer any more."),
    }
}

/// `POST /api/permissions/{id}/push-answer` with `{token, decision}` (`allow` or `deny`), without the
/// board's token: answers prompt `id` if `token` is one of its own and it's still waiting.
pub async fn answer(State(s): State<Shared>, Path(id): Path<String>, Json(b): Json<AnswerBody>) -> Response {
    let allow = match b.decision.as_str() {
        "allow" => true,
        "deny" => false,
        _ => return reply(StatusCode::BAD_REQUEST, "invalid", "decision must be allow or deny"),
    };
    let row: rusqlite::Result<Option<(String, String, Option<String>)>> = s
        .db()
        .query_row("SELECT host_id, status, expires_at FROM push_answer_tokens WHERE token_hash=?1 AND request_id=?2", [hash(b.token.trim()), id.clone()], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .optional();
    let host = match row {
        // Its prompt expired, though its host may not have said so yet.
        Ok(Some((_, status, Some(at)))) if (status == "pending" || status == "answering") && at <= now() => return settled("timed_out"),
        Ok(Some((host, status, _))) if status == "pending" || status == "answering" => host,
        Ok(Some((_, status, _))) => return settled(&status),
        Ok(None) => return reply(StatusCode::FORBIDDEN, "invalid", "This notification can't answer that prompt."),
        Err(e) => return ApiError::from(anyhow::Error::from(e)).into_response(),
    };
    // Taken by one answer at a time: a second tap, or another device's, finds it answering. A claim
    // older than any answer takes was abandoned (see CLAIM_LEASE) and can be taken again.
    let stale = (chrono::Utc::now() - CLAIM_LEASE).to_rfc3339();
    let claim = s.db().execute(
        "UPDATE push_answer_tokens SET status='answering', claimed_at=?3 WHERE request_id=?1 AND host_id=?2
         AND (status='pending' OR (status='answering' AND (claimed_at IS NULL OR claimed_at < ?4)))",
        params![id, host, now(), stale],
    );
    match claim {
        Ok(0) => {
            let now: Option<String> = s.db().query_row("SELECT status FROM push_answer_tokens WHERE request_id=?1 AND host_id=?2", [&id, &host], |r| r.get(0)).ok();
            return settled(now.as_deref().unwrap_or(""));
        }
        Ok(_) => {}
        Err(e) => return ApiError::from(anyhow::Error::from(e)).into_response(),
    }
    // Carried through in a task of its own, so that a device that gives up waiting (the connection
    // dropped) doesn't leave the claim behind it.
    let st = s.clone();
    match tokio::spawn(async move { forward(&st, &host, &id, allow).await }).await {
        Ok(res) => res,
        Err(e) => reply(StatusCode::INTERNAL_SERVER_ERROR, "failed", &format!("It couldn't be answered: {e}")),
    }
}

/// How long a claim on a prompt holds (see `answer`): longer than a request to a host can take (5
/// minutes), so only an answer that was abandoned (its hub stopped part-way) runs out.
const CLAIM_LEASE: chrono::Duration = chrono::Duration::minutes(6);

/// Abandoned claims: once the board starts again, no answer is under way any more.
pub fn recover(c: &Connection) -> anyhow::Result<()> {
    c.execute("UPDATE push_answer_tokens SET status='pending', claimed_at=NULL WHERE status='answering'", [])?;
    Ok(())
}

/// Answers prompt `id` on `host` (which the caller has claimed), and settles or releases the claim.
async fn forward(s: &Shared, host: &str, id: &str, allow: bool) -> Response {
    let release = |status: &str| {
        let _ = s.db().execute(
            "UPDATE push_answer_tokens SET status=?1, claimed_at=NULL WHERE request_id=?2 AND host_id=?3 AND status='answering'",
            params![status, id, host],
        );
    };
    let offline = || reply(StatusCode::SERVICE_UNAVAILABLE, "offline", "Its host is offline: try again once it's back, or answer it on the board.");
    let linked = || host == s.host_id || s.links.lock().unwrap().contains_key(host);
    let decision = if allow { "allow" } else { "deny" };
    let path = format!("/api/permissions/{}", urlencoding(id));
    match crate::hosts::hub::host_request(s, host, "POST", &path, Some(json!({"decision": decision, "via": "push"}))).await {
        Ok(_) => {
            let status = if allow { "allowed" } else { "denied" };
            release(status);
            reply(StatusCode::OK, status, if allow { "Allowed." } else { "Denied." })
        }
        // Its host isn't linked (host_request says so with a 409, as a prompt that's no longer pending
        // does): the prompt still waits, and the token keeps working.
        Err(ApiError(StatusCode::CONFLICT, e)) if !linked() || e.ends_with("is offline") => {
            release("pending");
            offline()
        }
        // Answered on the board meanwhile, expired, or gone with its thread.
        Err(ApiError(code, _)) if matches!(code, StatusCode::CONFLICT | StatusCode::NOT_FOUND) => {
            release("closed");
            settled("closed")
        }
        Err(ApiError(_, e)) => {
            release("pending");
            tracing::warn!("answering prompt {id} on {host} from a notification: {e}");
            reply(StatusCode::BAD_GATEWAY, "failed", &format!("It couldn't be answered: {e}"))
        }
    }
}

/// A path segment as it goes in a URL.
fn urlencoding(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

/// Whether Allow and Deny can answer a prompt from a notification, by its thread message (`data`,
/// see mcp/permissions.rs): tool permissions can. Questions (which need answers), plans (worth reading first) and approvals of changes to the
/// board (projects, deletions, automations) open the thread instead.
pub fn answerable(data: &Value) -> bool {
    let tool = data["tool_name"].as_str().unwrap_or_default();
    data["kind"].as_str().is_none_or(|k| k == "tool") && !crate::mcp::permissions::is_question(tool) && tool != crate::mcp::permissions::EXIT_PLAN
}

#[cfg(test)]
pub(crate) fn status_of(c: &Connection, request_id: &str) -> Option<String> {
    c.query_row("SELECT status FROM push_answer_tokens WHERE request_id=?1 LIMIT 1", [request_id], |r| r.get(0)).ok()
}

