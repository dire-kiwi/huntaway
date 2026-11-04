//! Each profile's assistant: one long-lived thread in no project, keyed `A-<n>`, that the user talks
//! to from the board's sidebar. It's a task (see db::Task::is_assistant), so it has the thread UI,
//! runs, steering, compaction, prompts and the board tools of any other, but it works in a
//! workspace of its own (`assistants/<task id>` in the data dir) and never goes to review or merge.
//!
//! `get_or_create` is the one place a profile's assistant is found on a host. A profile can have it run
//! on a linked host of its own (`assistant_host`, API 108): the hub then sends `/profiles/{id}/assistant`
//! there (`on_its_host`), to that host's profile of the same name, so its credentials and its agents stay
//! on that machine. The board's sidebar goes there too (`assistantHome` in the UI).

use axum::http::StatusCode;
use serde_json::{Value, json};

use crate::agent::runner;

pub mod brief;
pub mod google;
pub mod memory;
use crate::db::{self, NewTask, Task};
use crate::state::{ApiError, ApiResult, Shared};

/// The API version from which a host can be a profile's assistant host: it takes the routed requests
/// (`?local=1`) and passes its agents' board tool calls up its link (see hosts/uplink.rs).
pub const ASSISTANT_HOST_API: u32 = 108;

/// The assistant whose workspace and memory a run of `task` has: the assistant's own, and a routine
/// thread's its parent's (`parent`), whose workspace it has to be in. None for any other thread.
pub fn whose_workspace(task: &Task, parent: Option<&Task>) -> anyhow::Result<Option<Task>> {
    if task.is_assistant() {
        return Ok(Some(task.clone()));
    }
    if !task.is_routine() {
        return Ok(None);
    }
    match parent {
        Some(p) if p.is_assistant() && p.work_dir == task.work_dir => Ok(Some(p.clone())),
        _ => anyhow::bail!("this routine thread's assistant, or its workspace, is gone"),
    }
}

/// Where an assistant works, relative to the data dir (see documents::work_dir), so it moves with it.
pub fn work_dir(task_id: &str) -> String {
    format!("assistants/{task_id}")
}

/// The profile's assistant, made the first time it's asked for. It's made with the database
/// locked from the check to the insert, so two first opens at once make one between them.
pub fn get_or_create(s: &Shared, profile_id: &str) -> ApiResult<Task> {
    let (task, made) = {
        let c = s.db();
        if db::get_profile(&c, profile_id)?.is_none() {
            return Err(ApiError::not_found("profile"));
        }
        match db::assistant_task(&c, profile_id)? {
            Some(t) => (t, false),
            None => {
                let new = NewTask {
                    profile_id,
                    project_id: None,
                    kind: "task",
                    title: "Assistant",
                    description: "",
                    status: "todo",
                    use_worktree: false,
                    model: None,
                    effort: None,
                    claude_config_id: None,
                };
                let t = db::insert_assistant_task(&c, new, work_dir)?;
                // Its title stays: it isn't renamed after the user's prompts (see title::refresh).
                (db::update_task(&c, &t.id, &[("title_pinned", serde_json::json!(true))])?.unwrap_or(t), true)
            }
        }
    };
    // Its workspace, with its memory files (see memory.rs). Made again if it went missing. It's made a git
    // repository before its first run, or when the Memory tab opens.
    match memory::checked(s, &task) {
        Ok(dir) => {
            if let Err(e) = memory::seed(&dir) {
                tracing::warn!(task = %task.id, "making the assistant's memory files in {}: {e}", dir.display());
            }
        }
        Err(e) => tracing::warn!(task = %task.id, "the assistant's folder: {e:#}"),
    }
    if made {
        s.emit_task(&task);
    }
    Ok(task)
}

/// Send the user's message to the profile's assistant (made if it has none yet), starting its
/// agent or steering the one that's running, as a message in its thread does.
pub fn send(s: &Shared, profile_id: &str, text: &str) -> ApiResult<Task> {
    let task = get_or_create(s, profile_id)?;
    let t = runner::send(s, &task.id, text)?;
    if !text.trim().is_empty() {
        crate::mcp::questions::replied(s, &t.id);
    }
    Ok(t)
}

/// The assistant as the API returns it: with the host it's on.
pub fn with_host(s: &Shared, t: &Task) -> Value {
    let mut v = json!(t);
    v["host_id"] = json!(s.host_id);
    v
}

/// What profile `profile_id`'s `assistant_host` may be set to, as it's stored: null for this host, else a
/// linked host that can be an assistant host (API 108).
pub fn check_host(s: &Shared, v: &Value) -> ApiResult<Value> {
    let id = match v {
        Value::Null => return Ok(Value::Null),
        Value::String(h) => h.trim(),
        _ => return Err(ApiError::bad("assistant_host must be a linked host's id or null")),
    };
    if id.is_empty() || id == s.host_id {
        return Ok(Value::Null);
    }
    let link = db::get_link(&s.db(), id)?.ok_or_else(|| ApiError::bad("assistant_host must be a linked host"))?;
    // One that's offline can't say; it's checked when it's used.
    let live = s.links.lock().unwrap().get(id).cloned();
    if let Some(l) = live {
        let api = l.version.lock().unwrap().api_version;
        if api < ASSISTANT_HOST_API {
            return Err(ApiError::bad(format!("{} runs an older build that can't be an assistant host; update it first", link.name)));
        }
    }
    Ok(json!(id))
}

/// Profile `profile_id`'s assistant on its assistant host, through `method` on `/profiles/{id}/assistant`
/// there (with the host's id): None when it has none, and it's on this host.
pub async fn on_its_host(s: &Shared, profile_id: &str, method: &str, body: Option<Value>) -> ApiResult<Option<Value>> {
    let p = db::get_profile(&s.db(), profile_id)?.ok_or_else(|| ApiError::not_found("profile"))?;
    let Some(host) = p.assistant_host.filter(|h| !h.is_empty() && *h != s.host_id) else { return Ok(None) };
    let name = db::get_link(&s.db(), &host)?.map(|l| l.name).unwrap_or_else(|| host.clone());
    let offline = || ApiError(StatusCode::SERVICE_UNAVAILABLE, format!("{}'s assistant runs on {name}, which is offline", p.name));
    let link = s.links.lock().unwrap().get(&host).cloned().ok_or_else(offline)?;
    if link.version.lock().unwrap().api_version < ASSISTANT_HOST_API {
        return Err(ApiError::conflict(format!("{}'s assistant runs on {name}, which runs an older build that can't be an assistant host; update it", p.name)));
    }
    // Its profile of the same name: profiles are matched by name across hosts.
    let profiles = crate::hosts::hub::host_request(s, &host, "GET", "/api/profiles", None).await?;
    let there = profiles.as_array().into_iter().flatten().find(|r| r["name"] == p.name.as_str()).and_then(|r| r["id"].as_str().map(String::from));
    let there = there.ok_or_else(|| ApiError::conflict(format!("{name} has no profile named {}, for its assistant; add one there", p.name)))?;
    let path = format!("/api/profiles/{}/assistant?local=1", there);
    let mut t = crate::hosts::hub::host_request(s, &host, method, &path, body).await?;
    t["host_id"] = json!(host);
    Ok(Some(t))
}

/// Statuses the assistant can't be moved to: it never goes to review or merge, nor is it done
/// or parked, since it lasts.
pub const NOT_FOR_ASSISTANT: &[&str] = &["in_review", "ready_for_merge", "done", "backlog"];

#[cfg(test)]
mod tests;
