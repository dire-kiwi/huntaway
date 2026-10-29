//! How full each thread's context window is, like Claude Code's `/context`.
//!
//! The token count follows the agent's replies as it works: each reply's usage (Claude Code's
//! `assistant` messages, Codex's `thread/tokenUsage/updated`) says how much the session sent
//! the model. At the end of each Claude Code turn the board also asks the agent for the
//! breakdown `/context` shows (a `get_context_usage` control request on its input), and keeps
//! the latest one for `GET /tasks/{id}/context`. It asks for the summary: the total is the last
//! reply's usage and the parts are estimated locally. The full one counts each part with
//! Anthropic's token-counting API, which would be more requests every turn, and Claude Code waits
//! for it before exiting (up to 5 minutes), keeping a finished run going.

use axum::Json;
use axum::extract::{Path, State};
use serde_json::{Value, json};

use crate::db::{self, Context, Run};
use crate::runs;
use crate::state::{ApiError, ApiResult, Shared};
use crate::util::now;

/// Prefix of the control requests' ids, so their responses can be told from others.
const REQUEST_PREFIX: &str = "context-";

fn current(state: &Shared, task_id: &str) -> anyhow::Result<Option<Context>> {
    Ok(db::get_task(&state.db(), task_id)?.and_then(|t| t.context))
}

fn save(state: &Shared, task_id: &str, ctx: &Context, detail: Option<Value>) -> anyhow::Result<()> {
    let mut fields = vec![("context", json!(ctx))];
    if let Some(d) = detail {
        fields.push(("context_detail", d));
    }
    state.update_task(task_id, &fields)?;
    Ok(())
}

/// A Claude Code `assistant` message: its usage is what the session sent the model for it.
/// Subagents' messages are in their own context, not the thread's.
pub fn on_assistant(state: &Shared, task_id: &str, v: &Value) -> anyhow::Result<()> {
    if !v["parent_tool_use_id"].is_null() {
        return Ok(());
    }
    let u = &v["message"]["usage"];
    if !u.is_object() {
        return Ok(());
    }
    // Synthetic messages (an error, a stop) weren't sent to the model.
    if v["message"]["model"].as_str().is_some_and(|m| m.starts_with('<')) {
        return Ok(());
    }
    let n = |k: &str| u[k].as_u64().unwrap_or(0);
    // Counted as `/context` counts it.
    let tokens = n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens");
    if tokens == 0 {
        return Ok(());
    }
    set_tokens(state, task_id, tokens, None)
}

/// Codex's `thread/tokenUsage/updated`, for the thread's own session (not a subagent's).
pub fn on_codex_usage(state: &Shared, task_id: &str, p: &Value) -> anyhow::Result<()> {
    let session = db::get_task(&state.db(), task_id)?.and_then(|t| t.session_id);
    if p["threadId"].as_str().is_some_and(|t| session.is_some_and(|s| s != t)) {
        return Ok(());
    }
    let usage = &p["tokenUsage"];
    let Some(tokens) = usage["last"]["totalTokens"].as_u64() else { return Ok(()) };
    set_tokens(state, task_id, tokens, usage["modelContextWindow"].as_u64())
}

/// After compacting, the session starts again from the summary.
pub fn on_compacted(state: &Shared, task_id: &str, meta: &Value) -> anyhow::Result<()> {
    match meta["post_tokens"].as_u64() {
        Some(tokens) => set_tokens(state, task_id, tokens, None),
        None => Ok(()),
    }
}

fn set_tokens(state: &Shared, task_id: &str, tokens: u64, max_tokens: Option<u64>) -> anyhow::Result<()> {
    let old = current(state, task_id)?;
    let mut ctx = old.clone().unwrap_or_default();
    ctx.tokens = tokens;
    ctx.max_tokens = max_tokens.or(ctx.max_tokens);
    // One reply comes as several messages with the same usage.
    if old.is_some_and(|o| (o.tokens, o.max_tokens) == (ctx.tokens, ctx.max_tokens)) {
        return Ok(());
    }
    ctx.updated_at = now();
    save(state, task_id, &ctx, None)
}

/// The model's context window, from a Claude Code `result`'s `modelUsage`, until a breakdown
/// says it.
pub fn on_result(state: &Shared, task_id: &str, v: &Value) -> anyhow::Result<()> {
    let Some(mut ctx) = current(state, task_id)? else { return Ok(()) };
    if ctx.max_tokens.is_some() {
        return Ok(());
    }
    let Some(models) = v["modelUsage"].as_object() else { return Ok(()) };
    let window = match ctx.model.as_deref().and_then(|m| models.get(m)) {
        Some(m) => m["contextWindow"].as_u64(),
        // Otherwise the biggest: subagents may have run on smaller models.
        None => models.values().filter_map(|m| m["contextWindow"].as_u64()).max(),
    };
    if window.is_none() {
        return Ok(());
    }
    ctx.max_tokens = window;
    save(state, task_id, &ctx, None)
}

/// Ask the agent for the (summary) breakdown of its context, if it still takes input. It
/// answers once it's dealt with what it was sent before, even if its input is closed right after.
pub fn request(state: &Shared, run: &Run) {
    let line = json!({
        "type": "control_request",
        "request_id": format!("{REQUEST_PREFIX}{}", crate::util::new_id()),
        "request": {"subtype": "get_context_usage", "detail": "summary"},
    });
    if let Err(e) = runs::write_input(state, &run.id, &line.to_string()) {
        tracing::warn!(run = %run.id, "asking for the context breakdown: {e:#}");
    }
}

/// A `control_response`: the breakdown, if it answers `request`.
pub fn on_control_response(state: &Shared, task_id: &str, v: &Value) -> anyhow::Result<()> {
    let r = &v["response"];
    if !r["request_id"].as_str().is_some_and(|id| id.starts_with(REQUEST_PREFIX)) {
        return Ok(());
    }
    if r["subtype"] != "success" {
        // Claude Code versions without it say so; the token count still works.
        tracing::debug!(task = task_id, "no context breakdown: {}", r["error"]);
        return Ok(());
    }
    let mut detail = r["response"].clone();
    let Some(obj) = detail.as_object_mut() else { return Ok(()) };
    // The board draws its own grid from the categories.
    obj.remove("gridRows");
    let mut ctx = current(state, task_id)?.unwrap_or_default();
    if let Some(t) = detail["totalTokens"].as_u64() {
        ctx.tokens = t;
    }
    ctx.max_tokens = detail["maxTokens"].as_u64().or(ctx.max_tokens);
    ctx.compact_at = if detail["isAutoCompactEnabled"] == false { None } else { detail["autoCompactThreshold"].as_u64() };
    if let Some(m) = detail["model"].as_str() {
        ctx.model = Some(m.to_string());
    }
    let ts = now();
    ctx.updated_at = ts.clone();
    ctx.detail_at = Some(ts);
    save(state, task_id, &ctx, Some(json!(detail.to_string())))
}

/// Forget the session's context, when the thread starts a new one.
pub fn clear(state: &Shared, task_id: &str) -> anyhow::Result<()> {
    state.update_task(task_id, &[("context", Value::Null), ("context_detail", Value::Null)])?;
    Ok(())
}

/// `GET /tasks/{id}/context`: the summary on the task and the latest breakdown (shaped like
/// Claude Code's `get_context_usage` response, without `gridRows`), each null if there's none.
pub async fn get(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let c = s.db();
    let task = db::get_task(&c, &id)?.ok_or_else(|| ApiError::not_found("task"))?;
    let detail: Option<String> = c.query_row("SELECT context_detail FROM tasks WHERE id=?1", [&id], |r| r.get(0))?;
    let detail = detail.and_then(|d| serde_json::from_str::<Value>(&d).ok());
    Ok(Json(json!({"context": task.context, "detail": detail})))
}
