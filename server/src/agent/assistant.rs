//! Each profile's assistant: one long-lived thread in no project, keyed `A-<n>`, that the user talks
//! to from the board's sidebar. It's a task (see db::Task::is_assistant), so it has the thread UI,
//! runs, steering, compaction, prompts and the board tools of any other, but it works in a
//! workspace of its own (`assistants/<task id>` in the data dir) and never goes to review or merge.
//!
//! `get_or_create` is the one place a profile's assistant is found. A later step routes it to a
//! linked host of its own (an *Assistant host* setting per profile), which goes there.

use crate::agent::runner;
use crate::db::{self, NewTask, Task};
use crate::state::{ApiError, ApiResult, Shared};

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
    // Its workspace, which later steps keep memory files in. Made again if it went missing.
    if let Some(dir) = crate::agent::documents::work_dir(s, &task) {
        if let Err(e) = std::fs::create_dir_all(&dir) {
            tracing::warn!(task = %task.id, "making the assistant's folder {}: {e}", dir.display());
        }
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

/// Statuses the assistant can't be moved to: it never goes to review or merge, nor is it done
/// or parked, since it lasts.
pub const NOT_FOR_ASSISTANT: &[&str] = &["in_review", "ready_for_merge", "done", "backlog"];

#[cfg(test)]
mod tests;
