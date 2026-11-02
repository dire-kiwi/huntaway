//! Sending a message on a thread, and what holds a run back: dependencies, usage limits and
//! compaction.

use super::*;

/// `/compact [instructions]`: Claude Code summarises the conversation so far, shrinking the
/// context later prompts start from.
pub(super) fn is_compact(text: &str) -> bool {
    text.trim().strip_prefix("/compact").is_some_and(|rest| rest.is_empty() || rest.starts_with(char::is_whitespace))
}

/// `auto` marks the message as sent by the board rather than typed by the user.
pub fn send_as(state: &Shared, task_id: &str, text: &str, auto: bool) -> ApiResult<Task> {
    send_run(state, task_id, text, auto, false, "prompt")
}

/// Send a review's issues back to the task's agent to fix: round `round` of fixes, which the
/// message is marked with (`review_round`, see checkpoints.rs).
pub fn send_fixes(state: &Shared, task_id: &str, text: &str, round: u32) -> ApiResult<Task> {
    send_message(state, task_id, Some(db::Queued::new(text, false)), true, "prompt", Some(round))
}

/// Like `send`, for a message another thread's agent sent (MCP `send_to_task`). It's marked so
/// prompt analytics don't count it as the user's.
pub fn send_from_agent(state: &Shared, task_id: &str, text: &str) -> ApiResult<Task> {
    send_run(state, task_id, text, false, true, "prompt")
}

/// Start a review round on a review thread (see review.rs): a prompt whose outcome is the review's.
pub fn send_review(state: &Shared, thread_id: &str, text: &str) -> ApiResult<Task> {
    send_run(state, thread_id, text, true, false, "review")
}

fn send_run(state: &Shared, task_id: &str, text: &str, auto: bool, from_agent: bool, kind: &str) -> ApiResult<Task> {
    let mut task = send_message(state, task_id, Some(db::Queued::new(text, from_agent)), auto, kind, None)?;
    // `/plan` gives the task the plan label now, so it shows the Plan tab whether the message
    // starts a run, goes to the one going or waits.
    if kind == "prompt" && task.kind == "task" && crate::documents::plan_command(text).is_some() {
        task = crate::documents::add_plan(state, &task)?;
    }
    // The user's prompt may have moved the task on, so its title follows (see title::refresh).
    if kind == "prompt" && !auto && !from_agent && crate::title::worth_asking(text) && !is_compact(text) {
        crate::title::refresh(state, task_id);
    }
    Ok(task)
}

/// Send `message` on a thread. A message the user (or another agent) sent goes with the one
/// queued there, if any. Without one, it sends just that, and nothing if another run has (see
/// `send_queued`).
pub(super) fn send_message(state: &Shared, task_id: &str, message: Option<db::Queued>, auto: bool, kind: &str, review_round: Option<u32>) -> ApiResult<Task> {
    let only_queued = message.is_none();
    let message = message.unwrap_or_else(db::Queued::empty);
    let task = db::get_task(&state.db(), task_id)?.ok_or_else(|| ApiError::not_found("task"))?;
    // Sending what's queued: it may be a `/compact`, which is queued for after the run it came in.
    let queued = (!auto && message.text.trim().is_empty()).then_some(task.queued_message.as_deref()).flatten();
    let compact = is_compact(&message.text) || queued.is_some_and(is_compact);
    // Before the message is queued for later (behind dependencies, say), where nothing would send it.
    check_not_archived(state, &task)?;
    // One waiting for the user's approval isn't in the queue yet, so it can be talked to.
    if task.merging && !auto && !crate::merge_gate::is_pending(&task) {
        // A merge waiting for its turn can't run alongside the one in progress.
        let active = db::active_merge(&state.db(), task.project_id.as_deref(), task.parent_id.as_deref())?;
        if let Some(other) = active.filter(|o| o.id != task.id) {
            return Err(ApiError::conflict(format!(
                "this task is queued to merge after \"{}\"; move it out of Ready for merge to talk to its agent now",
                other.title
            )));
        }
    }
    if !auto {
        if let Some(task) = steer_or_queue(state, task_id, &message)? {
            return Ok(task);
        }
    }
    if !auto && !compact && kind == "prompt" && task.kind == "task" && !task.merging && runs::can_run_agents(state) {
        let unmet = db::unmet_dependencies(&state.db(), &task)?;
        if !unmet.is_empty() {
            return wait_for_dependencies(state, &task, &unmet, (!only_queued).then_some(message));
        }
    }
    // A config that's out of usage would refuse the run (see usage.rs).
    if !compact && kind == "prompt" && task.kind == "task" && !task.merging && runs::can_run_agents(state) && !state.is_running(task_id) {
        if let Some(t) = crate::usage::before_run(state, &task, (!only_queued).then(|| message.clone()))? {
            return Ok(t);
        }
    }
    // A message left queued on a thread that isn't running (e.g. one sent while it waited for
    // its dependencies, before it was moved out of "In progress") goes with this one, unless
    // this one compacts the conversation first.
    let take = match only_queued {
        true => Take::Only,
        false if !auto && (!is_compact(&message.text) || queued.is_some()) => Take::Ahead,
        false => Take::No,
    };
    let kind = if compact { "compact" } else { kind };
    let task = start_run(state, task_id, message, kind, take, |c, task, message| {
        let (text, from_agent) = (message.text.as_str(), message.from_agent);
        let first_run = task.session_id.is_none();
        if !text.trim().is_empty() {
            let mut msg = json!({"text": text});
            if auto {
                msg["auto"] = json!(true);
            }
            if let Some(round) = review_round {
                msg["review_round"] = json!(round);
            }
            if from_agent {
                msg["from_agent"] = json!(true);
            } else if message.user_text.as_deref().is_some_and(|u| u != text) {
                // Sent with other agents' messages queued alongside (see db::user_replies).
                msg["user_text"] = json!(message.user_text);
            }
            return Ok(vec![db::insert_message(c, task_id, "user", &msg)?]);
        } else if first_run && task.kind == "task" {
            let project = task.project_id.as_deref().map(|p| db::get_project(c, p)).transpose()?.flatten();
            let text = crate::prompts::start_task(task, project.as_ref());
            return Ok(vec![db::insert_message(c, task_id, "user", &json!({"text": text, "auto": true, "start": true}))?]);
        }
        Ok(Vec::new())
    })?;
    if kind == "prompt" && task.kind == "task" {
        // The agent is changing the work under review; it's reviewed again when it finishes.
        crate::review::supersede(state, &task);
        crate::summary::supersede(state, &task);
    }
    Ok(task)
}

/// Queue a task whose agent was asked to start while tasks it depends on aren't merged yet:
/// it waits in "In progress", keeping `text` as its queued message, and starts once they're
/// merged (see `start_unblocked`).
pub fn wait_for_dependencies(state: &Shared, task: &Task, unmet: &[Task], message: Option<db::Queued>) -> ApiResult<Task> {
    if let Some(message) = message.as_ref().filter(|m| !m.text.trim().is_empty()) {
        db::queue(&state.db(), &task.id, db::Queued { text: message.text.trim().to_string(), ..message.clone() })?;
    }
    // Without a message, for the one queued: unless it was sent or taken back meanwhile (checked
    // as the task is changed, so neither can slip in between).
    let only_queued = message.is_none();
    let queued = |c: &rusqlite::Connection| Ok(!only_queued || db::get_task(c, &task.id)?.and_then(|t| t.queued_message).is_some_and(|q| !q.trim().is_empty()));
    let fields = [("waiting", json!(true)), ("status", json!("in_progress")), ("attention_reason", Value::Null)];
    let updated = match state.update_task_if(&task.id, &fields, queued)? {
        Some(t) => t,
        None if only_queued => return Err(ApiError::conflict("nothing is queued to send")),
        None => return Err(ApiError::not_found("task")),
    };
    if !task.waiting {
        let key = task_key_prefix(state, task);
        let list: Vec<String> = unmet.iter().map(|t| format!("{key}-{}", t.number)).collect();
        state.add_event(&task.id, "info", format!("Queued until {} {} merged", list.join(", "), if list.len() == 1 { "is" } else { "are" }), None);
    }
    // Reached from `finish` (a message queued during a run, sent as it ends) before the run's
    // end is written: unless another has started since, no run goes on, so the task isn't
    // running any more.
    let stopped = state.update_task_if(&task.id, &[("running", json!(false))], |c| Ok(updated.running && !db::has_active_run(c, &task.id)?))?;
    Ok(stopped.unwrap_or(updated))
}

/// Queue a task whose config (`config_name`) is out of usage until `until`: like
/// `wait_for_dependencies`, it waits in "In progress", keeping `message` as its queued message,
/// and its agent carries on once the limit resets (see usage::resume_loop).
pub fn wait_for_limit(state: &Shared, task: &Task, config_name: &str, until: &str, message: Option<db::Queued>) -> ApiResult<Task> {
    if let Some(message) = message.as_ref().filter(|m| !m.text.trim().is_empty()) {
        db::queue(&state.db(), &task.id, db::Queued { text: message.text.trim().to_string(), ..message.clone() })?;
    }
    let fields = [("waiting", json!(true)), ("limit_reset_at", json!(until)), ("status", json!("in_progress")), ("attention_reason", Value::Null)];
    let updated = state.update_task_if(&task.id, &fields, |c| Ok(!db::has_active_run(c, &task.id)?))?;
    let Some(updated) = updated else { return Err(ApiError::conflict("an agent is already running on this thread")) };
    if !(task.waiting && task.limit_reset_at.as_deref() == Some(until)) {
        state.add_event(&task.id, "info", format!("Waiting for {config_name}'s usage limit to reset"), Some(format!("It resets at {until}")));
    }
    let stopped = state.update_task_if(&task.id, &[("running", json!(false))], |c| Ok(updated.running && !db::has_active_run(c, &task.id)?))?;
    Ok(stopped.unwrap_or(updated))
}

/// A task waiting for its config's usage limit to reset was moved to another config before its
/// agent started: it no longer waits for that reset, and starts on the new config, unless that
/// one holds it too (see usage::before_run) or what it depends on isn't merged yet.
pub fn config_changed(state: &Shared, task_id: &str) {
    let Ok(Some(t)) = db::get_task(&state.db(), task_id) else { return };
    if !(t.waiting && t.limit_reset_at.is_some()) || state.is_running(task_id) {
        return;
    }
    // Still waiting, for start_unblocked to start it (or leave it for its dependencies).
    let _ = state.update_task(task_id, &[("limit_reset_at", Value::Null)]);
    state.add_event(task_id, "info", "Its config changed, so it no longer waits for the old one's usage limit", None);
    start_unblocked(state, t.project_id.as_deref());
}

pub fn task_key_prefix(state: &Shared, task: &Task) -> String {
    let project = task.project_id.as_deref().and_then(|pid| db::get_project(&state.db(), pid).ok().flatten());
    key_prefix(task, project.as_ref()).to_string()
}

/// Start the agents of tasks queued for their dependencies whose dependencies are now all
/// merged, in a project (every project for None). Call whenever a task may have been merged,
/// deleted, or had its dependencies changed.
pub fn start_unblocked(state: &Shared, project_id: Option<&str>) {
    if !runs::can_run_agents(state) {
        return;
    }
    // So two callers can't both start the same task.
    static UNBLOCKING: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _one = UNBLOCKING.lock().unwrap_or_else(|e| e.into_inner());
    let ready: Vec<Task> = {
        let c = state.db();
        let waiting = db::waiting_tasks(&c, project_id).unwrap_or_else(|e| {
            tracing::error!("checking queued tasks: {e:#}");
            Vec::new()
        });
        waiting
            .into_iter()
            .filter(|t| t.limit_reset_at.as_deref().is_none_or(crate::usage::reset_due))
            .filter(|t| db::unmet_dependencies(&c, t).is_ok_and(|u| u.is_empty()))
            .collect()
    };
    for t in ready {
        start_waiting(state, &t);
    }
}

/// Start the agent of a task picked by `start_unblocked`. If its project has been archived
/// since, it goes back to waiting, queued message and all, for when the project is unarchived.
pub(super) fn start_waiting(state: &Shared, t: &Task) {
    if state.is_running(&t.id) {
        return;
    }
    let _ = state.update_task(&t.id, &[("waiting", json!(false)), ("limit_reset_at", Value::Null)]);
    let limit = t.limit_reset_at.is_some();
    let why = if limit {
        "Its usage limit has reset, so its agent is carrying on"
    } else if t.depends_on.is_empty() {
        "Its agent is starting"
    } else {
        "Nothing it depends on is left to merge, so its agent is starting"
    };
    state.add_event(&t.id, "info", why, None);
    // Bound first: the db lock can't be held while sending.
    let queued = db::get_task(&state.db(), &t.id).map(|t| t.and_then(|t| t.queued_message).is_some_and(|q| !q.trim().is_empty()));
    let sent = match queued {
        // It stays queued until the run's start takes it.
        Ok(true) => send_message(state, &t.id, None, false, "prompt", None),
        Ok(false) if t.session_id.is_none() => send_as(state, &t.id, "", true),
        Ok(false) if limit => send_as(state, &t.id, "The usage limit you ran into has reset, so carry on where you left off.", true),
        Ok(false) => send_as(state, &t.id, "The tasks this one was waiting for are merged (or no longer needed), so carry on with it.", true),
        Err(e) => Err(e.into()),
    };
    let Err(e) = sent else { return };
    // (send refuses an archived project's thread before it changes anything.)
    if check_not_archived(state, t).is_err() {
        let _ = state.update_task(&t.id, &[("waiting", json!(true)), ("limit_reset_at", json!(t.limit_reset_at))]);
        state.add_event(&t.id, "info", "Its project was archived, so it waits until the project is unarchived", None);
        return;
    }
    let reason = format!("Couldn't start the agent: {}", e.1);
    state.add_event(&t.id, "error", reason.clone(), None);
    let _ = state.update_task(&t.id, &[("status", json!("needs_attention")), ("attention_reason", json!(reason))]);
}

/// Queue `text` on a thread again, ahead of anything queued since it was taken.
pub(super) fn requeue_ahead(state: &Shared, task_id: &str, queued: db::Queued) -> Result<()> {
    let c = state.db();
    let later = db::take_queued(&c, task_id)?;
    db::queue(&c, task_id, queued)?;
    if let Some(later) = later {
        db::queue(&c, task_id, later)?;
    }
    Ok(())
}

/// Compact the conversation on a thread. Unlike a prompt, this leaves the task in its column.
pub(super) fn compact(state: &Shared, task_id: &str, why: &str) -> ApiResult<Task> {
    start_run(state, task_id, db::Queued::new("/compact", false), "compact", Take::No, |c, _, _| {
        Ok(vec![db::insert_message(c, task_id, "event", &json!({"level": "info", "text": why, "detail": null}))?])
    })
}

/// Background loop: compact sessions that have been idle for `AUTO_COMPACT_AFTER`.
pub fn auto_compact(state: &Shared) {
    let state = state.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            tick.tick().await;
            if !runs::can_run_agents(&state) {
                continue;
            }
            let now = chrono::Utc::now();
            let ts = |d: chrono::Duration| (now - d).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            let idle = match db::idle_sessions(&state.db(), &ts(AUTO_COMPACT_AFTER), &ts(AUTO_COMPACT_UNTIL)) {
                Ok(ids) => ids,
                Err(e) => {
                    tracing::warn!("finding idle sessions failed: {e:#}");
                    continue;
                }
            };
            for id in idle {
                // Compacting while the prompt cache is warm is a Claude saving.
                let codex = {
                    let c = state.db();
                    db::get_task(&c, &id).ok().flatten().is_some_and(|t| db::task_is_codex(&c, &t).unwrap_or(false))
                };
                if codex {
                    continue;
                }
                let why = format!("Compacting the conversation after {} minutes idle", AUTO_COMPACT_AFTER.num_minutes());
                if let Err(e) = compact(&state, &id, &why) {
                    tracing::warn!(task = %id, "auto-compact failed: {}", e.1);
                }
            }
        }
    });
}

/// Refuses a thread in an archived project: its tasks are off the board, so its agents would
/// work out of sight.
pub(super) fn check_not_archived(state: &Shared, task: &Task) -> ApiResult<()> {
    let project = task.project_id.as_deref().map(|p| db::get_project(&state.db(), p)).transpose()?.flatten();
    match project.filter(|p| p.archived_at.is_some()) {
        Some(p) => Err(ApiError::conflict(format!("the project \"{}\" is archived; unarchive it in the board's settings to run its agents", p.name))),
        None => Ok(()),
    }
}
