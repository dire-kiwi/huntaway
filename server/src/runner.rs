//! Agent runs. A run is `claude -p` (or Codex, see codex.rs) under an ia-shim (see `runs`); its output is followed from
//! disk (resuming from a saved offset after a restart), becomes thread messages, and its
//! outcome moves the task between board columns. Runs outlive server restarts: their durable
//! state is the `runs` table plus the run's files.

use anyhow::{Context, Result, anyhow};
use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::db::{self, Profile, Project, Run, Task};
use crate::permissions;
use crate::runs::{self, Launch};
use crate::state::{ApiError, ApiResult, RunHandle, Shared};
use crate::util::{path_str, truncate};
use crate::worktree;

pub const MCP_SERVER_NAME: &str = "huntaway";
/// The board's MCP server name before the rename to Huntaway. Runs started by an older build, and
/// their transcripts, still call its tools `mcp__issue_agent__<tool>`.
pub const LEGACY_MCP_SERVER_NAME: &str = "issue_agent";

/// Whether an MCP server name is the board's own server, under its current or old name.
pub fn is_board_server(name: &str) -> bool {
    name == MCP_SERVER_NAME || name == LEGACY_MCP_SERVER_NAME
}

/// How long a stopped agent has to end its turn before its process is stopped.
const STOP_GRACE: std::time::Duration = std::time::Duration::from_millis(if cfg!(test) { 1000 } else { 10_000 });
/// How long an agent that ended its turn with messages still waiting for it has to start the
/// next turn with them. If it doesn't, its input is closed (it exits) and they're sent to the
/// next run instead.
const STEER_GRACE: std::time::Duration = std::time::Duration::from_millis(if cfg!(test) { 1000 } else { 30_000 });

/// A session idle this long is compacted while its prompt cache (1 hour) is still warm, so
/// compacting is cheap and the next prompt starts from a small context.
const AUTO_COMPACT_AFTER: chrono::Duration = chrono::Duration::minutes(50);
/// Past this, the cache has expired: compacting would cost as much as it saves.
const AUTO_COMPACT_UNTIL: chrono::Duration = chrono::Duration::minutes(60);

/// Send a user message on a thread and start an agent run for it. Returns immediately; the
/// run continues in the background. While an agent is running the message goes to it straight
/// away instead (see `steer`), or, for runs that can't take it, is queued (added to any already
/// queued) and sent once that run ends, including when it's stopped.
pub fn send(state: &Shared, task_id: &str, text: &str) -> ApiResult<Task> {
    send_as(state, task_id, text, false)
}

/// Steering: an agent run reads stream-json input while it works (Claude Code's
/// `--input-format stream-json`, or the Codex adapter's `turn/steer`). A message sent while
/// it runs is written to its input at once, and the agent takes it in at its next step (after
/// the tool call it's in), in the same turn. It's kept on the task (`steering`) until the agent
/// echoes it back, and goes in the thread at that point. Claude Code echoes a message when it
/// takes it in, not when it receives it (checked with 2.1.306): one that arrives as a turn ends,
/// during the final reply, is echoed after that turn's `result`, and starts the next turn of
/// the same process. When a turn ends with nothing waiting, the input
/// is closed so the agent exits and the run ends; whatever the agent never took in is sent as
/// the next prompt (see `finish`).
fn can_steer(state: &Shared, run: &Run) -> bool {
    // A run being prepared will take input once it starts (see `started`).
    run.kind != "compact" && (run.status == "preparing" || runs::accepts_input(state, &run.id))
}

/// Send `text` to the agent running on the thread, if there is one: into its current turn if
/// it takes input as it works (see `can_steer`), else queued for when the run ends. Under the
/// runs lock, so a run can't end between the check and the write without picking the message
/// up (see `finish`).
fn steer_or_queue(state: &Shared, task_id: &str, message: &db::Queued) -> ApiResult<Option<Task>> {
    let runs = state.runs.lock().unwrap();
    let Some(handle) = runs.get(task_id) else { return Ok(None) };
    let task = db::get_task(&state.db(), task_id)?.ok_or_else(|| ApiError::not_found("task"))?;
    let (text, from_agent) = (message.text.trim(), message.from_agent);
    if text.is_empty() {
        return Ok(Some(task));
    }
    let run = db::get_run(&state.db(), &handle.run_id)?.filter(|r| !is_compact(text) && can_steer(state, r));
    let task = match run {
        Some(run) => {
            let mut steering = task.steering;
            let id = crate::util::new_id();
            steering.push(db::Steer { id, text: text.to_string(), from_agent, run_id: run.id, written: false });
            db::update_task(&state.db(), task_id, &[("steering", json!(steering))])?;
            write_steers(state, task_id)?
        }
        None => db::queue(&state.db(), task_id, db::Queued { text: text.to_string(), ..message.clone() })?,
    };
    let task = task.ok_or_else(|| ApiError::not_found("task"))?;
    drop(runs);
    state.emit_task(&task);
    Ok(Some(task))
}

/// A stream-json user message, as the agent's input takes it.
fn user_input(id: &str, text: &str) -> String {
    json!({"type": "user", "uuid": id, "message": {"role": "user", "content": text}}).to_string()
}

/// Write the steered messages the thread's run hasn't been sent yet to its input. Call with
/// the runs lock held.
fn write_steers(state: &Shared, task_id: &str) -> Result<Option<Task>> {
    let Some(mut task) = db::get_task(&state.db(), task_id)? else { return Ok(None) };
    let mut wrote = false;
    for s in task.steering.iter_mut().filter(|s| !s.written) {
        if !runs::write_input(state, &s.run_id, &user_input(&s.id, &s.text))? {
            break; // keep the order: the rest wait with it
        }
        s.written = true;
        wrote = true;
    }
    if wrote {
        return db::update_task(&state.db(), task_id, &[("steering", json!(task.steering))]);
    }
    Ok(Some(task))
}

/// The agent took in a message sent to it while it worked (its input echoed back): the
/// message goes in the thread here.
fn steered(state: &Shared, run: &Run, id: &str) -> Result<()> {
    let task_id = run.task_id.as_str();
    let (steer, task) = {
        let _runs = state.runs.lock().unwrap();
        let Some(task) = db::get_task(&state.db(), task_id)? else { return Ok(()) };
        // Anything else is the prompt, or a message replayed after a restart.
        let Some(steer) = task.steering.iter().find(|s| s.id == id).cloned() else { return Ok(()) };
        let rest: Vec<&db::Steer> = task.steering.iter().filter(|s| s.id != id).collect();
        (steer, db::update_task(&state.db(), task_id, &[("steering", json!(rest))])?)
    };
    // It answers a question the agent asked. Taken in after a turn ended, it starts a new one;
    // after a stop ended the turn, the run is then no longer stopped (see `stop`).
    state.db().execute(
        "UPDATE runs SET attention=NULL, between_turns=0, stop_requested = CASE WHEN stop_requested=2 THEN 0 ELSE stop_requested END WHERE id=?1",
        [&run.id],
    )?;
    let mut msg = json!({"text": steer.text, "steered": true});
    if steer.from_agent {
        msg["from_agent"] = json!(true);
    }
    state.add_message(task_id, "user", msg)?;
    if let Some(t) = task {
        state.emit_task(&t);
    }
    Ok(())
}

/// The agent ended a turn. Unless it has messages waiting, which start its next turn, its input
/// is closed so it exits and the run ends.
fn turn_ended(state: &Shared, run: &Run) {
    let waiting: Vec<String> = {
        let _runs = state.runs.lock().unwrap();
        let task = db::get_task(&state.db(), &run.task_id).ok().flatten();
        let waiting: Vec<String> = task.into_iter().flat_map(|t| t.steering).filter(|s| s.run_id == run.id).map(|s| s.id).collect();
        if waiting.is_empty() {
            runs::close_input(state, &run.id);
            return;
        }
        waiting
    };
    close_unless_taken_in(state, run, waiting);
}

/// The messages `waiting` should start the agent's next turn right away; if they don't, its
/// input is closed so the run ends and they go to the next one instead of waiting forever.
fn close_unless_taken_in(state: &Shared, run: &Run, waiting: Vec<String>) {
    let (st, run_id, task_id) = (state.clone(), run.id.clone(), run.task_id.clone());
    tokio::spawn(async move {
        tokio::time::sleep(STEER_GRACE).await;
        let _runs = st.runs.lock().unwrap();
        let task = db::get_task(&st.db(), &task_id).ok().flatten();
        if task.is_some_and(|t| t.steering.iter().any(|s| waiting.contains(&s.id))) {
            tracing::warn!(run = %run_id, "the agent didn't take in the messages sent to it; ending its run");
            runs::close_input(&st, &run_id);
        }
    });
}

/// Requeue the messages a run that ended never took in, ahead of anything queued since. Call
/// with the runs lock held.
fn requeue_steers(state: &Shared, task_id: &str, run_id: &str) -> Result<()> {
    let Some(task) = db::get_task(&state.db(), task_id)? else { return Ok(()) };
    let (mine, rest): (Vec<db::Steer>, Vec<db::Steer>) = task.steering.into_iter().partition(|s| s.run_id == run_id);
    if mine.is_empty() {
        return Ok(());
    }
    let c = state.db();
    let later = db::take_queued(&c, task_id)?;
    for s in &mine {
        db::queue(&c, task_id, db::Queued::new(&s.text, s.from_agent))?;
    }
    if let Some(later) = later {
        db::queue(&c, task_id, later)?;
    }
    db::update_task(&c, task_id, &[("steering", json!(rest))])?;
    Ok(())
}

/// Drop the message queued on a thread, if any. Returns the task as it was, so the text can be
/// given back to the user.
pub fn unqueue(state: &Shared, task_id: &str) -> ApiResult<Task> {
    let _runs = state.runs.lock().unwrap();
    let task = db::get_task(&state.db(), task_id)?.ok_or_else(|| ApiError::not_found("task"))?;
    if task.queued_message.is_some() {
        if let Some(t) = db::clear_queued(&state.db(), task_id)? {
            state.emit_task(&t);
        }
    }
    Ok(task)
}

/// Whether a message is queued on a thread whose run has ended. `runs` is the held runs lock.
fn has_queued(state: &Shared, runs: &std::collections::HashMap<String, RunHandle>, task_id: &str) -> bool {
    if runs.contains_key(task_id) {
        return false; // another run already took over the thread
    }
    db::get_task(&state.db(), task_id).ok().flatten().is_some_and(|t| t.queued_message.is_some_and(|q| !q.trim().is_empty()))
}

/// Send the message that was queued while the last run went. It stays queued until the next
/// run's start takes it (see `start_run`), so it isn't lost if the server stops in between.
/// Returns whether a new run started.
fn send_queued(state: &Shared, task_id: &str) -> bool {
    match send_message(state, task_id, None, false, "prompt") {
        Ok(_) => true,
        Err(e) => {
            // Unless another run has taken it, or is going to.
            let queued = db::get_task(&state.db(), task_id).ok().flatten().and_then(|t| t.queued_message).filter(|q| !q.trim().is_empty());
            if queued.is_some() && !state.is_running(task_id) {
                state.add_event(task_id, "error", format!("Couldn't send the queued message: {}", e.1), queued);
            }
            false
        }
    }
}

/// Ask the agent on a task that was moved to "Ready for merge" to merge its work. The task
/// stays in that column while it does; the agent moves it to "Done" once merged.
pub fn request_merge(state: &Shared, task: &Task) -> ApiResult<Task> {
    let (project, open) = {
        let c = state.db();
        let project = match &task.project_id {
            Some(pid) => db::get_project(&c, pid)?,
            None => None,
        };
        let open: Vec<Task> = if task.subproject {
            db::subproject_tasks(&c, &task.id)?.into_iter().filter(|t| t.status != "done" && !t.is_scratch()).collect()
        } else {
            Vec::new()
        };
        (project, open)
    };
    let base = task.base_branch.clone().or_else(|| project.as_ref().and_then(|p| p.base_branch.clone()));
    let into = base.map(|b| format!("`{b}`")).unwrap_or_else(|| "the base branch".into());
    let what = match &task.branch {
        Some(br) => format!("Merge branch `{br}` into {into}"),
        None => format!("Merge this task's work into {into}"),
    };
    let mut text = format!(
        "The user moved this task to \"Ready for merge\". {what}.\n\n{}\n\nIf you can't merge, call `request_user_input` \
         explaining why. Once it is merged, call `update_task` to set this task's status to `done`.",
        crate::prompts::merge(project.as_ref())
    );
    if task.subproject {
        let key = project.as_ref().map(|p| p.key.as_str()).unwrap_or("T");
        text.push_str(" This is a subproject: its tasks were merged into its branch, so bring the branch up to date first (pull it if it's on the remote, where their pull requests were merged).");
        if !open.is_empty() {
            let list: Vec<String> = open.iter().map(|t| format!("{key}-{} ({}, {})", t.number, t.title, t.status.replace('_', " "))).collect();
            text.push_str(&format!(
                " Some of its tasks aren't done yet: {}. Ask the user (with `request_user_input`) whether to merge without them before you merge.",
                list.join("; ")
            ));
        }
    }
    send_as(state, &task.id, &text, true)
}

/// Held while picking a project's next merge, so two merges can't take its slot at once.
static MERGE_SLOT: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Merges run one at a time per branch they merge into: the project's top-level tasks share one
/// slot, and each subproject's tasks share another. A task moved to "Ready for merge" waits
/// there, in column order, while another task in its slot is merging (running, or waiting on
/// the user in "Needs attention"). Call this whenever a merge may have ended or been queued: it
/// asks the next waiting task's agent to merge wherever a slot in the project is free.
pub fn start_next_merge(state: &Shared, project_id: Option<&str>) {
    if !runs::can_run_agents(state) {
        return;
    }
    let _slot = MERGE_SLOT.lock().unwrap_or_else(|e| e.into_inner());
    let lanes = match db::merge_lanes(&state.db(), project_id) {
        Ok(l) => l,
        Err(e) => return tracing::error!("checking the merge queue: {e:#}"),
    };
    for lane in lanes {
        let next = {
            let c = state.db();
            match db::active_merge(&c, project_id, lane.as_deref()) {
                Ok(None) => db::queued_merges(&c, project_id, lane.as_deref()).map(|q| q.into_iter().next()),
                Ok(Some(_)) => Ok(None),
                Err(e) => Err(e),
            }
        };
        let next = match next {
            Ok(Some(t)) => t,
            Ok(None) => continue,
            Err(e) => {
                tracing::error!("checking the merge queue: {e:#}");
                continue;
            }
        };
        if let Err(e) = request_merge(state, &next) {
            // Stays merging, so the queue waits for the user to sort it out.
            let reason = format!("Couldn't start the merge: {}", e.1);
            state.add_event(&next.id, "error", reason.clone(), None);
            let _ = state.update_task(&next.id, &[("status", json!("needs_attention")), ("attention_reason", json!(reason))]);
        }
    }
}

/// Start the merges that were waiting when the server stopped.
fn start_queued_merges(state: &Shared) {
    let projects = db::projects_with_queued_merges(&state.db());
    match projects {
        Ok(projects) => projects.iter().for_each(|p| start_next_merge(state, p.as_deref())),
        Err(e) => tracing::error!("checking the merge queue: {e:#}"),
    }
}

/// `/compact [instructions]`: Claude Code summarises the conversation so far, shrinking the
/// context later prompts start from.
fn is_compact(text: &str) -> bool {
    text.trim().strip_prefix("/compact").is_some_and(|rest| rest.is_empty() || rest.starts_with(char::is_whitespace))
}

/// `auto` marks the message as sent by the board rather than typed by the user.
pub fn send_as(state: &Shared, task_id: &str, text: &str, auto: bool) -> ApiResult<Task> {
    send_run(state, task_id, text, auto, false, "prompt")
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
    let task = send_message(state, task_id, Some(db::Queued::new(text, from_agent)), auto, kind)?;
    // The user's prompt may have moved the task on, so its title follows (see title::refresh).
    if kind == "prompt" && !auto && !from_agent && crate::title::worth_asking(text) && !is_compact(text) {
        crate::title::refresh(state, task_id);
    }
    Ok(task)
}

/// Send `message` on a thread. A message the user (or another agent) sent goes with the one
/// queued there, if any. Without one, it sends just that, and nothing if another run has (see
/// `send_queued`).
fn send_message(state: &Shared, task_id: &str, message: Option<db::Queued>, auto: bool, kind: &str) -> ApiResult<Task> {
    let only_queued = message.is_none();
    let message = message.unwrap_or_else(db::Queued::empty);
    let task = db::get_task(&state.db(), task_id)?.ok_or_else(|| ApiError::not_found("task"))?;
    // Sending what's queued: it may be a `/compact`, which is queued for after the run it came in.
    let queued = (!auto && message.text.trim().is_empty()).then_some(task.queued_message.as_deref()).flatten();
    let compact = is_compact(&message.text) || queued.is_some_and(is_compact);
    // Before the message is queued for later (behind dependencies, say), where nothing would send it.
    check_not_archived(state, &task)?;
    if task.merging && !auto {
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
        waiting.into_iter().filter(|t| db::unmet_dependencies(&c, t).is_ok_and(|u| u.is_empty())).collect()
    };
    for t in ready {
        start_waiting(state, &t);
    }
}

/// Start the agent of a task picked by `start_unblocked`. If its project has been archived
/// since, it goes back to waiting, queued message and all, for when the project is unarchived.
fn start_waiting(state: &Shared, t: &Task) {
    if state.is_running(&t.id) {
        return;
    }
    let _ = state.update_task(&t.id, &[("waiting", json!(false))]);
    state.add_event(&t.id, "info", "Nothing it depends on is left to merge, so its agent is starting", None);
    // Bound first: the db lock can't be held while sending.
    let queued = db::get_task(&state.db(), &t.id).map(|t| t.and_then(|t| t.queued_message).is_some_and(|q| !q.trim().is_empty()));
    let sent = match queued {
        // It stays queued until the run's start takes it.
        Ok(true) => send_message(state, &t.id, None, false, "prompt"),
        Ok(false) if t.session_id.is_none() => send_as(state, &t.id, "", true),
        Ok(false) => send_as(state, &t.id, "The tasks this one was waiting for are merged (or no longer needed), so carry on with it.", true),
        Err(e) => Err(e.into()),
    };
    let Err(e) = sent else { return };
    // (send refuses an archived project's thread before it changes anything.)
    if check_not_archived(state, t).is_err() {
        let _ = state.update_task(&t.id, &[("waiting", json!(true))]);
        state.add_event(&t.id, "info", "Its project was archived, so it waits until the project is unarchived", None);
        return;
    }
    let reason = format!("Couldn't start the agent: {}", e.1);
    state.add_event(&t.id, "error", reason.clone(), None);
    let _ = state.update_task(&t.id, &[("status", json!("needs_attention")), ("attention_reason", json!(reason))]);
}

/// Queue `text` on a thread again, ahead of anything queued since it was taken.
fn requeue_ahead(state: &Shared, task_id: &str, queued: db::Queued) -> Result<()> {
    let c = state.db();
    let later = db::take_queued(&c, task_id)?;
    db::queue(&c, task_id, queued)?;
    if let Some(later) = later {
        db::queue(&c, task_id, later)?;
    }
    Ok(())
}

/// Compact the conversation on a thread. Unlike a prompt, this leaves the task in its column.
fn compact(state: &Shared, task_id: &str, why: &str) -> ApiResult<Task> {
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
fn check_not_archived(state: &Shared, task: &Task) -> ApiResult<()> {
    let project = task.project_id.as_deref().map(|p| db::get_project(&state.db(), p)).transpose()?.flatten();
    match project.filter(|p| p.archived_at.is_some()) {
        Some(p) => Err(ApiError::conflict(format!("the project \"{}\" is archived; unarchive it in the board's settings to run its agents", p.name))),
        None => Ok(()),
    }
}

/// What a run's start does with the message queued on its thread.
#[derive(Clone, Copy, PartialEq)]
enum Take {
    No,
    /// It goes ahead of the run's message.
    Ahead,
    /// The run is for it: it doesn't start if there's none (another run took it).
    Only,
}

/// Register a run on a thread and start it in the background. `kind` is the run's: prompt,
/// compact or review. `take` says what happens to the message queued on the thread. `record` adds the thread messages that explain the run, in the transaction that
/// registers it: if the server stops part way, either the queued message is still queued, or
/// the run, its messages and the queue's being emptied are all recorded.
fn start_run(
    state: &Shared,
    task_id: &str,
    message: db::Queued,
    kind: &str,
    take: Take,
    record: impl FnOnce(&rusqlite::Connection, &Task, &db::Queued) -> anyhow::Result<Vec<db::Message>>,
) -> ApiResult<Task> {
    let compact = kind == "compact";
    if !runs::can_run_agents(state) {
        return Err(ApiError::bad("This host can't run agents (it has no claude or codex CLI, or no ia-shim)"));
    }
    let task = db::get_task(&state.db(), task_id)?.ok_or_else(|| ApiError::not_found("task"))?;
    let agent = if db::task_is_codex(&state.db(), &task)? { "codex" } else { "claude" };
    if !runs::has_agent(agent) {
        return Err(ApiError::bad(format!("This host has no {agent} CLI for this thread's config")));
    }
    if compact && task.session_id.is_none() {
        return Err(ApiError::bad("There's no conversation to compact yet"));
    }
    let (cancel_tx, cancel_rx) = oneshot::channel();
    let (run, text, taken, recorded) = {
        let mut runs = state.runs.lock().unwrap();
        if runs.contains_key(task_id) {
            return Err(ApiError::conflict("an agent is already running on this thread"));
        }
        // Checked under the runs lock, as archiving is (see api::archive).
        check_not_archived(state, &task)?;
        let c = state.db();
        let tx = c.unchecked_transaction()?;
        let taken = if take == Take::No { None } else { db::take_queued(&tx, task_id)? };
        if take == Take::Only && taken.is_none() {
            return Err(ApiError::conflict("nothing is queued to send"));
        }
        let message = match &taken {
            Some(queued) => queued.clone().then(message),
            None => message,
        };
        let run = db::insert_run(&tx, task_id, kind)?;
        let recorded = record(&tx, &task, &message)?;
        tx.commit()?;
        runs.insert(task_id.to_string(), RunHandle { run_id: run.id.clone(), cancel: Some(cancel_tx) });
        (run, message.text, taken, recorded)
    };
    for m in &recorded {
        state.emit_message(m);
    }
    #[cfg(test)]
    crate::testing::reached("run:started");
    let mut fields = vec![("running", json!(true)), ("steerable", json!(!compact))];
    // A queued message sent as the last run ends carries on the same stretch of work.
    if !task.running {
        fields.push(("run_started_at", json!(crate::util::now())));
    }
    if !compact {
        fields.push(("attention_reason", Value::Null));
        fields.push(("waiting", json!(false)));
        if task.kind == "task" {
            fields.push(("status", json!(task.working_status())));
        }
    }
    let task = match state.update_task(task_id, &fields) {
        Ok(Some(task)) => task,
        failed => {
            // Deleted meanwhile, say: the run never starts, and what it took goes back.
            abandon(state, &run, taken);
            return Err(match failed {
                Err(e) => e.into(),
                _ => ApiError::not_found("task"),
            });
        }
    };

    let st = state.clone();
    tokio::spawn(async move {
        let launched = tokio::select! {
            r = launch(&st, &run, &text) => r.map(|_| true),
            _ = cancel_rx => Ok(false),
        };
        launch_ended(&st, &run, launched);
    });
    Ok(task)
}

/// Drop a run that was registered but can't start: its handle and row go, and the messages it
/// took (queued, or sent to it meanwhile) are queued again.
fn abandon(state: &Shared, run: &Run, taken: Option<db::Queued>) {
    let task_id = run.task_id.as_str();
    let mut runs = state.runs.lock().unwrap();
    let ended = (|| {
        if let Some(queued) = taken {
            requeue_ahead(state, task_id, queued)?;
        }
        requeue_steers(state, task_id, &run.id)?;
        // Without its row, the run before it writes its end as it would have (see end_run).
        state.db().execute("DELETE FROM runs WHERE id=?1", [&run.id])?;
        // Unless that run has ended already, and left its end to this one: the task isn't
        // running. (Under the runs lock, so no other run starts meanwhile.)
        let idle = |c: &rusqlite::Connection| Ok(db::get_task(c, task_id)?.is_some_and(|t| t.running) && !db::has_active_run(c, task_id)?);
        state.update_task_if(task_id, &[("running", json!(false))], idle)?;
        anyhow::Ok(())
    })();
    if let Err(e) = ended {
        tracing::error!(task = task_id, run = %run.id, "dropping a run that couldn't start: {e:#}");
    }
    if runs.get(task_id).is_some_and(|h| h.run_id == run.id) {
        runs.remove(task_id);
    }
}

/// A run's launch is over: it started (`Ok(true)`), was stopped while it was being prepared
/// (`Ok(false)`) or failed. Unless it started, nothing it launched may go on: an agent that
/// reads its input as it works would wait for more forever, and one started after the launch
/// gave up on it would work unseen.
fn launch_ended(state: &Shared, run: &Run, launched: Result<bool>) {
    match launched {
        Ok(true) => {} // output now arrives from the host
        Ok(false) => {
            runs::reap(state, &run.id);
            finish(state, &run.id, Outcome::Cancelled);
        }
        Err(e) => {
            runs::reap(state, &run.id);
            finish(state, &run.id, Outcome::Failed(format!("{e:#}")));
        }
    }
}

/// Stop the run on this thread at once and drop any queued message, e.g. before deleting the
/// thread.
pub fn abort(state: &Shared, task_id: &str) -> bool {
    let _ = db::clear_queued(&state.db(), task_id);
    let _ = db::update_task(&state.db(), task_id, &[("steering", json!([]))]);
    stop_run(state, task_id, true)
}

/// Ask the run on this thread to stop. An agent that takes input while it works is asked to
/// end its turn (like Esc in Claude Code), so its session stays resumable; any message it
/// hasn't taken in yet then starts its next turn. Others are stopped. Their exit is picked up
/// from the run's files, and a queued message is sent as soon as it has stopped.
pub fn stop(state: &Shared, task_id: &str) -> bool {
    stop_run(state, task_id, false)
}

fn stop_run(state: &Shared, task_id: &str, kill: bool) -> bool {
    let (run_id, cancel) = {
        let mut runs = state.runs.lock().unwrap();
        match runs.get_mut(task_id) {
            Some(h) => (h.run_id.clone(), h.cancel.take()),
            None => return false,
        }
    };
    // 1 until the turn it interrupts ends, then 2 (see `record_result`). A later stop gets its
    // own id, so the timer of an earlier one (see `stop_unless_interrupted`) leaves it alone.
    let stop_id = format!("stop-{}", crate::util::new_id());
    let _ = state.db().execute("UPDATE runs SET stop_requested=1, stop_id=?2 WHERE id=?1", [&run_id, &stop_id]);
    if let Some(tx) = cancel {
        if tx.send(()).is_ok() {
            return true;
        }
    }
    if !kill && interrupt(state, &run_id, &stop_id) {
        return true;
    }
    runs::close_input(state, &run_id);
    if !runs::kill(state, &run_id) && !runs::exists(state, &run_id) {
        // Never got as far as starting claude.
        finish(state, &run_id, Outcome::Cancelled);
    }
    true
}

/// Ask the agent to end its turn now, for the stop `stop_id`. Returns false if it doesn't take
/// input any more.
fn interrupt(state: &Shared, run_id: &str, stop_id: &str) -> bool {
    let line = json!({"type": "control_request", "request_id": stop_id, "request": {"subtype": "interrupt"}});
    match runs::write_input(state, run_id, &line.to_string()) {
        Ok(true) => {}
        Ok(false) => return false,
        Err(e) => {
            tracing::warn!(run = run_id, "couldn't interrupt the agent: {e:#}");
            return false;
        }
    }
    stop_unless_interrupted(state, run_id, stop_id);
    true
}

/// Stop the run's process if the turn the stop `stop_id` interrupts hasn't ended within
/// STOP_GRACE.
fn stop_unless_interrupted(state: &Shared, run_id: &str, stop_id: &str) {
    let (st, run_id, stop_id) = (state.clone(), run_id.to_string(), stop_id.to_string());
    tokio::spawn(async move {
        tokio::time::sleep(STOP_GRACE).await;
        let stopping: Option<i64> = st
            .db()
            .query_row("SELECT stop_requested FROM runs WHERE id=?1 AND COALESCE(stop_id, '')=?2 AND status != 'exited'", [&run_id, &stop_id], |r| r.get(0))
            .ok();
        if stopping == Some(1) {
            tracing::warn!(run = %run_id, "the agent didn't end its turn when stopped; stopping its process");
            runs::close_input(&st, &run_id);
            runs::kill(&st, &run_id);
        }
    });
}

pub enum Outcome {
    Ok,
    Cancelled,
    Failed(String),
}

fn load(state: &Shared, task_id: &str) -> Result<(Task, Option<Project>, Profile)> {
    let c = state.db();
    let task = db::get_task(&c, task_id)?.ok_or_else(|| anyhow!("task not found"))?;
    let project = match &task.project_id {
        Some(pid) => db::get_project(&c, pid)?,
        None => None,
    };
    let profile = db::get_profile(&c, &task.profile_id)?.ok_or_else(|| anyhow!("profile not found"))?;
    Ok((task, project, profile))
}

/// Where the running agent of `task` works, as `launch` picked it (its worktree is set up by now).
pub fn work_dir(state: &Shared, task: &Task) -> Result<std::path::PathBuf> {
    if let Some(d) = crate::documents::work_dir(state, task) {
        return Ok(d);
    }
    let project = match &task.project_id {
        Some(pid) => db::get_project(&state.db(), pid)?,
        None => None,
    };
    let dir = match (task.kind.as_str(), &project) {
        ("review", Some(p)) => {
            let parent = match &task.parent_id {
                Some(id) => db::get_task(&state.db(), id)?,
                None => None,
            };
            match parent {
                Some(t) if t.use_worktree => t.worktree_path.context("the task's worktree isn't set up")?,
                _ => p.repo_path.clone(),
            }
        }
        (_, Some(_)) if task.use_worktree => task.worktree_path.clone().context("worktree path missing")?,
        (_, Some(p)) => p.repo_path.clone(),
        (_, None) => return Ok(state.profile_scratch_dir(&task.profile_id)),
    };
    Ok(crate::util::expand_tilde(&dir))
}

/// Prepare the working directory and start claude.
async fn launch(state: &Shared, run: &Run, text: &str) -> Result<()> {
    let task_id = run.task_id.as_str();
    // Not in the folder the project is moving from.
    let project_id = db::get_task(&state.db(), task_id)?.and_then(|t| t.project_id);
    if let Some(pid) = &project_id {
        crate::relocate::settled(state, pid).await;
    }
    let (mut task, project, profile) = load(state, task_id)?;
    // A thread created while its profile had no configs takes the default it has now, and
    // keeps it from here on with its conversation.
    if task.claude_config_id.is_none() && task.session_id.is_none() {
        let config = db::task_claude_config(&state.db(), &task)?;
        if let Some(config) = config {
            task = state.update_task(task_id, &[("claude_config_id", json!(config.id))])?.ok_or_else(|| anyhow!("task not found"))?;
        }
    }
    // A review thread works on the task it reviews; a task may be part of a subproject.
    let parent = match &task.parent_id {
        Some(id) => db::get_task(&state.db(), id)?,
        None => None,
    };

    // Resolve the working directory for this thread.
    let mut add_dirs: Vec<String> = Vec::new();
    // (`work_dir` says the same for a thread whose run is going.)
    let doc_dir = crate::documents::work_dir(state, &task);
    let cwd: String = match (task.kind.as_str(), &project) {
        // A plan, artifact or diagram is written in the task's own folder, reading the project.
        // A scratch task works there too, reading its project if it's in one. One in a
        // subproject reads the subproject's worktree as well.
        (_, p) if doc_dir.is_some() => {
            add_dirs.extend(p.as_ref().map(|p| p.repo_path.clone()));
            if let Some(sp) = parent.as_ref().filter(|t| task.kind == "task" && t.subproject && t.worktree_state == "ready") {
                add_dirs.extend(sp.worktree_path.clone());
            }
            doc_dir.as_deref().map(path_str).unwrap_or_default()
        }
        ("review", Some(p)) => match &parent {
            Some(t) if t.worktree_state == "ready" => t.worktree_path.clone().context("worktree path missing")?,
            Some(t) if t.use_worktree => anyhow::bail!("the task's worktree isn't set up"),
            _ => p.repo_path.clone(),
        },
        (_, Some(_)) if task.use_worktree => {
            if task.worktree_state != "ready" {
                state.add_event(task_id, "info", "Setting up worktree…", None);
            }
            task = worktree::setup(state, task_id).await?;
            task.worktree_path.clone().context("worktree path missing")?
        }
        (_, Some(p)) => p.repo_path.clone(),
        (_, None) => path_str(&state.profile_scratch_dir(&profile.id)),
    };
    // A group task plans across its group's projects, so it can read their repositories.
    let group = match (&task.group_name, &project) {
        (Some(g), None) if task.kind == "task" => db::group_projects(&state.db(), &task.profile_id, g)?,
        _ => Vec::new(),
    };
    add_dirs.extend(group.iter().map(|p| p.repo_path.clone()));
    tokio::fs::create_dir_all(crate::util::expand_tilde(&cwd)).await.ok();
    // Setting up a subproject task's worktree may have set up the subproject's too.
    let parent = match (&task.parent_id, task.kind.as_str()) {
        (Some(id), "task") => db::get_task(&state.db(), id)?,
        _ => parent,
    };
    // A task with its own branch in a repository on GitHub opens a pull request for it.
    let github = match (&project, &task.branch) {
        (Some(p), Some(_)) if task.kind == "task" => {
            let base = task.base_branch.as_deref().or(p.base_branch.as_deref()).filter(|b| !b.is_empty());
            worktree::github(std::path::Path::new(&p.repo_path), base).await
        }
        _ => None,
    };

    let document = crate::documents::path(state, &task).map(|p| path_str(&p));
    let prompt = if task.session_id.is_none() && task.kind == "task" && run.kind != "compact" {
        start_prompt(&task, project.as_ref(), text)
    } else {
        text.to_string()
    };
    // Every run but a `/compact` takes messages while it works (see `can_steer`); the prompt is
    // its first.
    let input = run.kind != "compact";
    let prompt = if input { format!("{}\n", user_input(&crate::util::new_id(), &prompt)) } else { prompt };

    let permission_mode = task.effective_permission_mode(&state.db(), project.as_ref())?;
    let blank = |m: &Option<String>| m.as_deref().is_none_or(|m| m.trim().is_empty());
    let host_model = db::get_setting(&state.db(), "default_model")?;
    let model = [task.model.clone(), project.as_ref().and_then(|p| p.model.clone()), profile.default_model.clone(), host_model]
        .into_iter()
        .find(|m| !blank(m))
        .flatten();
    let effort = match task.effort.clone().filter(|e| !e.trim().is_empty()) {
        Some(e) => Some(e),
        None => db::get_setting(&state.db(), "default_effort")?,
    };

    let github_account = github_account(project.as_ref(), &profile);

    let config = db::task_claude_config(&state.db(), &task)?;
    let codex = config.as_ref().is_some_and(|c| c.is_codex());
    if codex {
        // Claude's models don't run on Codex; a thread's own pick is used as given.
        let inherited = [project.as_ref().and_then(|p| p.model.clone()), profile.default_model.clone(), db::get_setting(&state.db(), "default_model")?];
        let model = task.model.clone().filter(|m| !m.trim().is_empty()).or_else(|| {
            inherited.into_iter().flatten().find(|m| !m.trim().is_empty() && !crate::codex::is_claude_model(m))
        });
        // Not every Codex model takes every effort, and the effort can come from elsewhere than the model (the host's
        // default is Claude's and Codex's both, and a task on its default model inherits a model it wasn't picked for):
        // one the model doesn't take gives way to the model's own default (when its models can be listed).
        let effort = match config.as_ref() {
            Some(cfg) => codex_run_effort(cfg, model.as_deref(), effort.clone()).await,
            None => effort.clone(),
        };
        let (approval_policy, approvals_reviewer, sandbox) = crate::codex::policy(&permission_mode, task.kind == "review");
        let tools = match &project {
            Some(p) => crate::agent_tools::for_run(state, &p.id)?,
            None => Default::default(),
        };
        let gh_tools = uses_gh_server(&tools);
        let mut instructions = system_prompt(&task, project.as_ref(), parent.as_ref(), &group, document.as_deref(), github.as_ref(), gh_tools);
        if permission_mode == "plan" {
            instructions.push_str(
                " You are in plan mode: investigate and propose a plan, but don't change any files. The user will \
                 switch modes once they approve it.",
            );
        }
        let own_gh = tools.mcp_servers.contains_key(crate::gh_mcp::SERVER_NAME);
        if gh_tools {
            // Codex's sandbox may keep `gh` in the shell off the network, and its GitHub app (the
            // codex_apps server's github tools) may not reach the user's repositories. Codex has
            // no hook to turn gh in the shell away, so it's only told.
            instructions.push_str(&format!(
                " For GitHub, use the `{0}` MCP server's tools (e.g. `{0}.pr_view`, `{0}.pr_diff`), which run gh with \
                 the user's login{1}: don't run `gh` in your shell, which may not reach GitHub{2}, and the codex_apps \
                 GitHub tools may not have access to this repository.",
                crate::gh_mcp::SERVER_NAME,
                github_account.as_ref().map(|a| format!(" as the GitHub account {a}")).unwrap_or_default(),
                if github_account.is_some() { " or would act as another account" } else { "" },
            ));
        }
        // Reviewers read and report (see the Claude arguments below).
        let mut disabled_mcp_tools = std::collections::HashMap::new();
        if task.kind == "review" && !own_gh {
            disabled_mcp_tools.insert(crate::gh_mcp::SERVER_NAME.to_string(), crate::gh_mcp::WRITES.iter().map(|t| t.to_string()).collect());
        }
        // In their read-only sandbox, reviewers can still build and run the tests to check what
        // they find, as long as it doesn't change the work.
        let git_dir = git_common_dir(&cwd).await;
        let mut filesystem = std::collections::BTreeMap::new();
        if task.kind == "review" && sandbox == "read-only" {
            let work = [path_str(&crate::util::expand_tilde(&cwd))].into_iter().chain(git_dir.clone()).collect();
            filesystem = review_filesystem(cache_dirs().into_iter().chain(ignored_dirs(&cwd).await).collect(), work);
            instructions.push_str(
                " Your sandbox can't change the work: its files are read-only. You can write to the temp directories (/tmp), \
                 package caches and the working directory's git-ignored directories, such as build output, so you can build it \
                 and run its tests to check what you find. If a build needs to write anywhere else in the working directory, \
                 point it at /tmp instead (e.g. `CARGO_TARGET_DIR`).",
            );
        }
        let mut writable_roots: Vec<String> = git_dir.into_iter().collect();
        writable_roots.extend(cache_dirs());
        let spec = crate::codex::Spec {
            cwd: cwd.clone(),
            thread_id: task.session_id.clone(),
            model,
            effort,
            approval_policy: approval_policy.into(),
            approvals_reviewer: approvals_reviewer.into(),
            sandbox: sandbox.into(),
            plan: permission_mode == "plan",
            compact: run.kind == "compact",
            developer_instructions: instructions,
            input,
            writable_roots,
            filesystem,
            skills_dir: tools.skills_dir.as_ref().map(|d| format!("{d}/.claude/skills")),
            approved_mcp_servers: tools.mcp_servers.keys().filter(|n| tools.allowed.contains(&crate::agent_tools::tool_prefix(n))).cloned().collect(),
            disabled_mcp_tools,
            review_waits: approvals_reviewer == "auto_review",
        };
        let launch = Launch {
            run_id: run.id.clone(),
            cwd: cwd.clone(),
            args: vec![],
            env: vec![],
            config_dir: db::task_config_dir(&state.db(), &task)?,
            prompt,
            input,
            review: task.kind == "review",
            mcp_servers: tools.mcp_servers,
            github_account: github_account.clone(),
            codex: Some(spec),
        };
        tracing::info!(task = task_id, run = %run.id, kind = %run.kind, %cwd, resume = task.session_id.is_some(), "starting codex");
        return started(state, run, launch).await;
    }

    let mut args: Vec<String> = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]
        .into_iter()
        .map(String::from)
        .collect();
    if input {
        // Echoed back, the messages show where in the turn the agent took them in.
        args.extend(["--input-format", "stream-json", "--replay-user-messages"].map(String::from));
    }
    // The project's own skills and MCP servers, and the ones it turns off.
    let tools = match &project {
        Some(p) => crate::agent_tools::for_run(state, &p.id)?,
        None => Default::default(),
    };
    let gh_tools = uses_gh_server(&tools);
    let mut push = |a: &str, b: &str| args.extend([a.to_string(), b.to_string()]);
    let mut prompt_extra = system_prompt(&task, project.as_ref(), parent.as_ref(), &group, document.as_deref(), github.as_ref(), gh_tools);
    if gh_tools {
        prompt_extra.push_str(&gh_note(github_account.as_deref()));
    }
    if task.kind != "review" {
        prompt_extra.push_str(&profiles_note(&db::list_profiles(&state.db())?, &profile));
    }
    push("--append-system-prompt", &prompt_extra);
    push("--permission-mode", &permission_mode);
    if permission_mode != "bypassPermissions" {
        push("--permission-prompt-tool", &format!("mcp__{MCP_SERVER_NAME}__permission_prompt"));
    }
    if gh_tools {
        push("--settings", &gh_hook_settings(&state.exe));
    }
    // Our board tools never need approval, nor do some of the gh server's (see gh_allowed).
    args.push("--allowedTools".to_string());
    args.extend(board_tools_allowed(&permission_mode, task.kind == "review"));
    let own_gh = tools.mcp_servers.contains_key(crate::gh_mcp::SERVER_NAME);
    let gh_tool = |t: &str| format!("mcp__{}__{t}", crate::gh_mcp::SERVER_NAME);
    if !own_gh {
        args.extend(gh_allowed(&task).iter().map(|t| gh_tool(t)));
    }
    args.extend(tools.allowed.iter().cloned());
    let mut disallowed = tools.disallowed.clone();
    if task.kind == "review" {
        // Reviewers read and report; they don't change the work.
        args.extend(crate::review::ALLOWED_TOOLS.iter().map(|t| t.to_string()));
        disallowed.extend(crate::review::DISALLOWED_TOOLS.iter().map(|t| t.to_string()));
        if !own_gh {
            disallowed.extend(crate::gh_mcp::WRITES.iter().map(|t| gh_tool(t)));
        }
    }
    if !disallowed.is_empty() {
        args.extend(["--disallowedTools".to_string(), disallowed.join(" ")]);
    }
    add_dirs.extend(tools.skills_dir.clone());
    let mut push = |a: &str, b: &str| args.extend([a.to_string(), b.to_string()]);
    if let Some(sid) = &task.session_id {
        push("--resume", sid);
    }
    if let Some(m) = &model {
        push("--model", m);
    }
    if let Some(e) = &effort {
        // The nearest Claude has to an effort only Codex models offer.
        push("--effort", match e.as_str() {
            "ultra" => "max",
            "minimal" => "low",
            e => e,
        });
    }
    // Files attached to prompts (see attachments.rs).
    let attachments = crate::attachments::dir(state);
    if attachments.is_dir() {
        add_dirs.push(path_str(&attachments));
    }
    for d in &add_dirs {
        push("--add-dir", d);
    }
    let launch = Launch {
        run_id: run.id.clone(),
        cwd: cwd.clone(),
        args,
        // Permission prompts block until the user answers in the UI.
        env: vec![("MCP_TOOL_TIMEOUT".into(), "86400000".into())],
        config_dir: db::task_config_dir(&state.db(), &task)?,
        prompt,
        input,
        review: task.kind == "review",
        mcp_servers: tools.mcp_servers,
        github_account,
        codex: None,
    };
    tracing::info!(task = task_id, run = %run.id, kind = %run.kind, %cwd, resume = task.session_id.is_some(), "starting claude");
    started(state, run, launch).await
}

/// The board tools a Claude run gets without asking (`--allowedTools`). In auto mode that's all
/// but `wait`, so Claude's classifier reviews each wait as it does the agent's Bash calls: a
/// wait's command runs like one of them (see tools.rs).
fn board_tools_allowed(permission_mode: &str, review: bool) -> Vec<String> {
    if permission_mode != "auto" {
        return vec![format!("mcp__{MCP_SERVER_NAME}")];
    }
    crate::mcp::tool_names(review).into_iter().filter(|t| t != "wait").map(|t| format!("mcp__{MCP_SERVER_NAME}__{t}")).collect()
}

/// Whether Claude itself approved the `wait` calls of the run with these launch arguments (in
/// auto mode, see `board_tools_allowed`), so a wait's command needs no prompt of ours. Not for a
/// Codex run, one in another mode, or one that pre-approves `wait` under the board's current or
/// old server name, like an auto run started by an older build.
pub fn approves_own_waits(args: &[String]) -> bool {
    let auto = args.windows(2).any(|w| w[0] == "--permission-mode" && w[1] == "auto");
    let Some(i) = args.iter().position(|a| a == "--allowedTools").filter(|_| auto) else { return false };
    let pre_approved = [MCP_SERVER_NAME, LEGACY_MCP_SERVER_NAME].map(|n| [format!("mcp__{n}"), format!("mcp__{n}__wait")]);
    let mut allowed = args[i + 1..].iter().take_while(|a| !a.starts_with("--")).flat_map(|a| a.split([',', ' ']));
    !allowed.any(|t| pre_approved.iter().flatten().any(|p| p == t))
}

/// A Codex run's effort, as `codex_effort` has it with the config's models (as it is if they can't be listed).
async fn codex_run_effort(config: &db::ClaudeConfig, model: Option<&str>, effort: Option<String>) -> Option<String> {
    if effort.is_none() {
        return None;
    }
    match crate::codex::models(config.dir()).await {
        Ok(models) => codex_effort(effort, model, &models),
        Err(_) => effort,
    }
}

/// A Codex run's effort, if its model (or the default model) takes it; otherwise that model's own default. Models
/// that don't say which efforts they take take any.
fn codex_effort(effort: Option<String>, model: Option<&str>, models: &[crate::codex::Model]) -> Option<String> {
    let m = match model {
        Some(id) => models.iter().find(|m| m.id == id),
        None => models.iter().find(|m| m.is_default).or(models.first()),
    };
    match (effort, m) {
        (Some(e), Some(m)) if !m.efforts.is_empty() && !m.efforts.contains(&e) => m.default_effort.clone(),
        (e, _) => e,
    }
}

/// Whether the agent's own reviewer approved the `wait` calls of a run, command included:
/// Claude's classifier (see `approves_own_waits`) or Codex's reviewer (`codex::Spec::review_waits`).
pub fn agent_reviews_waits(state: &Shared, run_id: &str) -> bool {
    match crate::runs::codex_spec(state, run_id) {
        Some(spec) => spec.review_waits,
        None => approves_own_waits(&crate::runs::launch_args(state, run_id)),
    }
}

/// The git directory a worktree shares with its repository, where commits are written.
/// The gh server's tools a Claude run uses without asking: the read-only ones, and `pr_merge`
/// while its task is merging, since moving the task to "Ready for merge" was the user's say-so.
/// Allowed tools skip auto mode's classifier too, so a merge doesn't stall when it fails.
fn gh_allowed(task: &Task) -> Vec<&'static str> {
    let mut tools = crate::gh_mcp::READ_ONLY.to_vec();
    if task.merging && task.kind == "task" {
        tools.push("pr_merge");
    }
    tools
}

/// Whether a run gets our gh server: unless the project turns it off or has its own by that name.
fn uses_gh_server(tools: &crate::agent_tools::RunTools) -> bool {
    let name = crate::gh_mcp::SERVER_NAME;
    !tools.mcp_servers.contains_key(name) && !tools.disallowed.contains(&crate::agent_tools::tool_prefix(name))
}

/// The GitHub account a run's gh tools act as: the project's, or else its profile's.
pub fn github_account(project: Option<&Project>, profile: &Profile) -> Option<String> {
    let set = |a: &Option<String>| a.as_deref().map(str::trim).filter(|a| !a.is_empty()).map(String::from);
    project.and_then(|p| set(&p.github_account)).or_else(|| set(&profile.github_account))
}

/// The environment that makes gh act as the GitHub account `task`'s runs use (see
/// `github_account`), for the host's own gh calls about the task (see gh_mcp::account_env). None
/// when no account is set, which leaves gh's active account. Fails when the account set isn't
/// signed in to gh, so nothing runs as another account instead.
pub async fn task_gh_env(state: &Shared, task: &Task) -> Result<Option<crate::gh_mcp::GhEnv>> {
    crate::gh_mcp::account_env(task_github_account(state, task)?.as_deref()).await
}

/// The GitHub account `task`'s runs use (see `github_account`), if one is set.
pub fn task_github_account(state: &Shared, task: &Task) -> Result<Option<String>> {
    let c = state.db();
    let project = match &task.project_id {
        Some(id) => Some(db::get_project(&c, id)?.context("project not found")?),
        None => None,
    };
    let profile = db::get_profile(&c, &task.profile_id)?.context("profile not found")?;
    Ok(github_account(project.as_ref(), &profile))
}

/// What a Claude run with our gh server is told about GitHub. gh in Bash is turned away (see
/// `gh_hook_settings`).
fn gh_note(account: Option<&str>) -> String {
    format!(
        " For GitHub (pull requests, issues, CI runs, the API), use the `{0}` MCP server's tools (mcp__{0}__pr_view, \
         pr_create, pr_checks and so on; mcp__{0}__gh runs any other gh command) rather than the gh CLI in Bash, which is \
         blocked here. They run gh outside the sandbox{1}.",
        crate::gh_mcp::SERVER_NAME,
        account.map(|a| format!(" as the GitHub account {a}")).unwrap_or_default()
    )
}

/// `--settings` for a Claude run with our gh server: a PreToolUse hook that turns away gh in
/// Bash (`huntaway gh-hook`), which may not reach GitHub from the sandbox or would act as gh's
/// active account rather than the run's.
fn gh_hook_settings(exe: &std::path::Path) -> String {
    let command = format!("'{}' gh-hook", path_str(exe).replace('\'', r"'\''"));
    json!({"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": command, "timeout": 10}]}]}}).to_string()
}

async fn git_common_dir(cwd: &str) -> Option<String> {
    let out = tokio::process::Command::new("git")
        .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .current_dir(crate::util::expand_tilde(cwd))
        .output()
        .await
        .ok()?;
    let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !dir.is_empty()).then_some(dir)
}

/// Package managers' caches, which Codex's `workspace-write` sandbox would otherwise keep
/// read-only (so `npm ci`, say, fails). Each is made first if it's missing, parents and all, as
/// the sandbox would keep its tool from making it on first use. In the home directory, or where
/// the environment says (`env`, e.g. `CARGO_HOME` for a system-wide Cargo).
fn cache_dirs() -> Vec<String> {
    dirs::home_dir().map(|h| cache_dirs_in(&h, |k| std::env::var(k).ok())).unwrap_or_default()
}

fn cache_dirs_in(home: &std::path::Path, env: impl Fn(&str) -> Option<String>) -> Vec<String> {
    let base = |var: &str, default: &str| env(var).filter(|v| v.starts_with('/')).map(std::path::PathBuf::from).unwrap_or_else(|| home.join(default));
    let (cargo, data) = (base("CARGO_HOME", ".cargo"), base("XDG_DATA_HOME", ".local/share"));
    let dirs = [base("XDG_CACHE_HOME", ".cache"), home.join(".npm"), cargo.join("registry"), cargo.join("git"), data.join("pnpm")];
    dirs.into_iter().filter(|p| std::fs::create_dir_all(p).is_ok()).map(|p| path_str(&p)).collect()
}

/// A reviewer's `codex::Spec::filesystem`: it writes `write` and reads `work` (its working and
/// git directories), which stay read-only even inside a cache or temp directory (a test server's).
fn review_filesystem(write: Vec<String>, work: Vec<String>) -> std::collections::BTreeMap<String, String> {
    let write = write.into_iter().map(|p| (p, "write".to_string()));
    write.chain(work.into_iter().map(|p| (p, "read".to_string()))).collect()
}

/// Agents' own settings, which stay read-only to a reviewer even when git ignores them.
const AGENT_DIRS: &[&str] = &[".git", ".claude", ".codex", ".agents"];

/// Most git-ignored directories a reviewer may write.
const MAX_IGNORED_DIRS: usize = 200;

/// The directories in `cwd` that git ignores as a whole (build output, installed packages): a
/// reviewer may write them without changing the work, which they hold none of. Absolute paths.
async fn ignored_dirs(cwd: &str) -> Vec<String> {
    let dir = crate::util::expand_tilde(cwd);
    let git = |args: &[&str], input: Option<String>| {
        let mut cmd = tokio::process::Command::new("git");
        cmd.args(args).current_dir(&dir).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
        async move {
            let mut child = cmd.spawn().ok()?;
            let mut stdin = child.stdin.take()?;
            // Written while the output is read, which check-ignore writes as it goes.
            let write = async move {
                if let Some(input) = input {
                    let _ = tokio::io::AsyncWriteExt::write_all(&mut stdin, input.as_bytes()).await;
                }
            };
            let (_, out) = tokio::join!(write, child.wait_with_output());
            let out = out.ok()?;
            Some((out.status.code(), String::from_utf8_lossy(&out.stdout).into_owned()))
        }
    };
    let Some((Some(0), listed)) = git(&["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], None).await else {
        return Vec::new();
    };
    // That lists untracked directories with only ignored files in them too.
    let candidates: Vec<&str> =
        listed.split('\0').filter_map(|p| p.strip_suffix('/')).filter(|p| !p.split('/').any(|c| AGENT_DIRS.contains(&c))).take(MAX_IGNORED_DIRS).collect();
    if candidates.is_empty() {
        return Vec::new();
    }
    // Exits with 1 when none of them is ignored.
    let Some((Some(0), ignored)) = git(&["check-ignore", "-z", "--stdin"], Some(candidates.join("\0"))).await else { return Vec::new() };
    ignored.split('\0').filter(|p| !p.is_empty()).map(|p| path_str(&dir.join(p))).collect()
}

async fn started(state: &Shared, run: &Run, launch: Launch) -> Result<()> {
    let task_id = run.task_id.as_str();
    runs::start(state, launch).await?;
    state.db().execute("UPDATE runs SET status='running' WHERE id=?1", [&run.id])?;
    // Preparing is over; from here a stop goes to the agent. Messages sent meanwhile go to it now.
    {
        let mut runs = state.runs.lock().unwrap();
        if let Some(h) = runs.get_mut(task_id) {
            h.cancel = None;
            if let Some(t) = write_steers(state, task_id)? {
                state.emit_task(&t);
            }
        }
    }
    runs::follow(state, &run.id, 0);
    Ok(())
}

/// Startup: resume following runs that were active when the server stopped.
pub fn load_active(state: &Shared) -> Result<()> {
    runs::resume_reaping(state);
    // Not in the loop head: that would hold the db lock for the whole loop.
    let active = db::active_runs(&state.db())?;
    for run in active {
        state.runs.lock().unwrap().insert(run.task_id.clone(), RunHandle { run_id: run.id.clone(), cancel: None });
        if runs::exists(state, &run.id) && runs::format(state, &run.id) > runs::RUN_FORMAT {
            // Written by a newer build (a downgrade); we can't follow it safely.
            finish(state, &run.id, Outcome::Failed("This run was started by a newer huntaway; update this host to follow it".into()));
        } else if runs::exists(state, &run.id) {
            if run.status == "preparing" {
                state.db().execute("UPDATE runs SET status='running' WHERE id=?1", [&run.id])?;
            }
            tracing::info!(run = %run.id, offset = run.out_offset, "resuming run");
            runs::follow(state, &run.id, run.out_offset as u64);
            let takes_input = runs::accepts_input(state, &run.id);
            let task = db::get_task(&state.db(), &run.task_id)?;
            // A run started before steering, or by a build that queued its messages, doesn't.
            let steerable = run.kind != "compact" && takes_input;
            if task.as_ref().is_some_and(|t| t.steerable != steerable) {
                state.update_task(&run.task_id, &[("steerable", json!(steerable))])?;
            }
            let (stopping, stop_id, between_turns): (i64, Option<String>, bool) = state.db().query_row(
                "SELECT stop_requested, stop_id, between_turns FROM runs WHERE id=?1",
                [&run.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?;
            if stopping == 1 && takes_input {
                stop_unless_interrupted(state, &run.id, stop_id.as_deref().unwrap_or(""));
            }
            // Its turn ended with messages it has been sent waiting to start the next one.
            if between_turns && takes_input {
                let waiting: Vec<String> = task.into_iter().flat_map(|t| t.steering).filter(|s| s.run_id == run.id && s.written).map(|s| s.id).collect();
                if !waiting.is_empty() {
                    close_unless_taken_in(state, &run, waiting);
                }
            }
        } else {
            // We stopped while preparing (e.g. setting up the worktree), before claude started,
            // or before ia-shim wrote its output: an agent it starts now is stopped.
            runs::reap(state, &run.id);
            finish(state, &run.id, Outcome::Failed("Interrupted by a server restart before the agent started".into()));
        }
    }
    // Threads marked running without a run: their last one ended as the server stopped, before
    // its end was written (or they're from a build that predates durable runs).
    let orphans: Vec<String> = {
        let c = state.db();
        let mut st = c.prepare("SELECT id FROM tasks WHERE running=1")?;
        st.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?
    };
    for id in orphans.into_iter().filter(|id| !state.is_running(id)) {
        // What was queued for after it goes now, as it would have.
        let queued = has_queued(state, &state.runs.lock().unwrap(), &id);
        if queued && send_queued(state, &id) {
            continue;
        }
        state.add_event(&id, "warn", "Run interrupted by server restart", None);
        let t = db::get_task(&state.db(), &id)?;
        let mut fields = vec![("running", json!(false))];
        if t.is_some_and(|t| t.kind == "task") {
            fields.push(("status", json!("needs_attention")));
            fields.push(("attention_reason", json!("Interrupted by server restart")));
        }
        state.update_task(&id, &fields)?;
    }
    // Prompts from runs that no longer exist can never be answered.
    let stale: Vec<String> = {
        let c = state.db();
        let mut st = c.prepare(
            "SELECT DISTINCT p.task_id FROM permission_requests p WHERE p.status='pending'
             AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.task_id=p.task_id AND r.status != 'exited')",
        )?;
        st.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?
    };
    for task_id in stale {
        permissions::expire_for_task(state, &task_id);
    }
    // Subprojects from before their status followed their tasks.
    let subprojects = db::subprojects(&state.db())?;
    for sp in subprojects {
        state.sync_subproject(&sp)?;
    }
    start_queued_merges(state);
    start_unblocked(state, None);
    Ok(())
}

/// The key a group task's number goes with, in place of a project's key.
pub const GROUP_TASK_KEY: &str = "G";

/// What goes before a task's number in its key: its project's key, for a group task `G`, or
/// for a scratch task `S`.
pub fn key_prefix<'a>(task: &Task, project: Option<&'a Project>) -> &'a str {
    match project {
        Some(p) => &p.key,
        None if task.group_name.is_some() => GROUP_TASK_KEY,
        None if task.is_scratch() => db::SCRATCH_TASK_KEY,
        None => "T",
    }
}

/// A task's first prompt: the task, the project's instructions for starting (see prompts.rs),
/// then any message it was started with (e.g. from `create_task`). A message that calls a skill
/// (`/name …`) goes first instead, since Claude Code only expands a command at the start of a
/// prompt, and the task becomes part of its arguments.
fn start_prompt(task: &Task, project: Option<&Project>, text: &str) -> String {
    let key = key_prefix(task, project);
    let text = text.trim();
    let mut p = String::new();
    if is_slash_command(text) {
        p.push_str(&format!("{text}\n\n"));
    }
    p.push_str(&format!("# {key}-{}: {}\n", task.number, task.title));
    if !task.description.trim().is_empty() {
        p.push_str(&format!("\n{}\n", task.description.trim()));
    }
    p.push_str(&external_links_note(&task.external_links));
    p.push_str(&format!("\n---\n\n{}\n", crate::prompts::start_task(task, project)));
    if !text.is_empty() && !is_slash_command(text) {
        p.push_str(&format!("\n{text}\n"));
    }
    p
}

/// The tasks elsewhere a task is for, as its first prompt lists them.
fn external_links_note(links: &[db::ExternalLink]) -> String {
    if links.is_empty() {
        return String::new();
    }
    let mut s = String::from("\nThis task is for:\n");
    for l in links {
        let provider = if l.provider == "asana" { "Asana" } else { &l.provider };
        let title = if l.title.is_empty() { &l.url } else { &l.title };
        s.push_str(&format!("- {provider} task: {title} ({})\n", l.url));
    }
    s
}

/// Whether a message starts with a command, such as a skill (`/name`, or `/plugin:name`), rather
/// than, say, a path.
fn is_slash_command(text: &str) -> bool {
    let name = text.strip_prefix('/').map(|r| r.split(char::is_whitespace).next().unwrap_or(""));
    name.is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.')))
}

/// Which other profiles' boards on this host the agent's tools reach, so it looks there before
/// adding a project that may already be on one.
fn profiles_note(profiles: &[db::Profile], own: &db::Profile) -> String {
    let (shared, closed): (Vec<&db::Profile>, Vec<&db::Profile>) = profiles.iter().filter(|p| p.id != own.id).partition(|p| p.grants(&own.name));
    let names = |ps: &[&db::Profile]| ps.iter().map(|p| p.name.as_str()).collect::<Vec<_>>().join(", ");
    let mut s = format!(" Your profile on the board is \"{}\".", own.name);
    if !shared.is_empty() {
        s.push_str(&format!(" Your board tools also reach these profiles' boards: {}.", names(&shared)));
    }
    if !closed.is_empty() {
        s.push_str(&format!(
            " These profiles' boards don't let your agents in, so their projects aren't listed: {}. If the user mentions a \
             project you can't find, it may be on one of them: ask the user rather than creating it.",
            names(&closed)
        ));
    }
    s
}

/// `group`: for a group task, its group's projects. `document`: for a plan, artifact or diagram
/// task, the file it writes (see documents.rs). `github`: where a task with its own branch opens
/// its pull request, if its repository is on GitHub.
fn system_prompt(
    task: &Task,
    project: Option<&Project>,
    parent: Option<&Task>,
    group: &[Project],
    document: Option<&str>,
    github: Option<&worktree::Github>,
    gh_tools: bool,
) -> String {
    let tools = format!(
        "You have access to the `{MCP_SERVER_NAME}` MCP tools for the Huntaway board \
         (list_projects, list_tasks, get_task, get_task_field, create_task, update_task, send_to_task, request_user_input, wait). \
         They also reach other profiles' boards that let your agents in: list_projects shows each project's profile. \
         When you have nothing to do until something happens (other tasks, CI, reviews, a deploy), call `wait` rather than \
         sleeping or polling: the board then shows you as waiting rather than working. For CI or reviews on a pull \
         request, give it the `pull_request` (its number or URL): it ends when the checks fail or pass, someone \
         comments or reviews, the branch conflicts with its base, or it's merged or closed, and says what happened. For \
         a deploy, give it a `command` that exits once it's done."
    );
    match (task.kind.as_str(), project) {
        ("task", p) if task.is_scratch() => {
            // One from a scratch chat works in the chat's folder, which may be shared.
            let dir = match &task.work_dir {
                Some(_) => "a scratch folder, for notes and experiments",
                None => "the task's own folder, for notes and experiments, where you can write freely",
            };
            let key = key_prefix(task, p);
            // In a project (API 51) it reads the repository; in a subproject, the subproject's worktree too.
            let place = match (p, parent.filter(|t| t.subproject)) {
                (None, _) => "A scratch task isn't in a project or a repository: it's for whatever the user asks, such as \
                     answering questions, trying things out, or planning and running work across the board."
                    .to_string(),
                (Some(p), sp) => {
                    let mut s = format!(
                        "This scratch task is in the project {} (key {}, id {}, repository {}, which you can read). It has no \
                         worktree or branch of its own: it's for whatever the user asks about the project, such as answering \
                         questions, looking into the code, trying things out, or planning and running the project's work. \
                         Don't change the repository, commit, push or open pull requests: create a task for changes.",
                        p.name, p.key, p.id, p.repo_path
                    );
                    if let Some(sp) = sp {
                        s.push_str(&format!(
                            " It's part of the subproject {key}-{} (\"{}\"), whose branch `{}` collects the work of its tasks{}. \
                             Tasks you create are added to the subproject.",
                            sp.number,
                            sp.title,
                            sp.branch.as_deref().unwrap_or("?"),
                            sp.worktree_path
                                .as_ref()
                                .filter(|_| sp.worktree_state == "ready")
                                .map(|w| format!(" and is checked out in the subproject's worktree at {w}, which you can read"))
                                .unwrap_or_default()
                        ));
                    }
                    s
                }
            };
            format!(
                "You are an agent working on scratch task {key}-{} (\"{}\", id {}) on the Huntaway board, a kanban board where \
                 each task is worked by its own Claude agent, grouped into projects. {place} Your working directory is {dir}. {tools} \
                 Use them to look across projects, create and update tasks, and start agents on \
                 tasks (create_task with start=true, or send_to_task) when the user asks for that. Tasks you create are \
                 recorded as this task's. If you are blocked or need a decision or information from the user, call \
                 `request_user_input` with your question (and its `options`, when the choices are known) and then end your \
                 turn — the task is flagged \"Needs attention\" \
                 and the user's reply resumes this conversation. When you finish, end with a concise summary of what you \
                 did; the task then moves to \"In review\".",
                task.number, task.title, task.id
            )
        }
        ("review", p) => {
            let key = p.map(|p| p.key.as_str()).unwrap_or("T");
            let (number, title) = parent.map(|t| (t.number, t.title.as_str())).unwrap_or((0, "?"));
            let mut s = format!(
                "You are the code reviewer for task {key}-{number} (\"{title}\") on the Huntaway board, a kanban \
                 board where each task is worked by its own Claude agent."
            );
            if let Some(t) = parent.filter(|t| t.worktree_state == "ready") {
                s.push_str(&format!(
                    " Your working directory is that task's git worktree at {}{}.",
                    t.worktree_path.as_deref().unwrap_or("?"),
                    t.branch.as_ref().map(|b| format!(" on branch `{b}`")).unwrap_or_default()
                ));
            }
            s.push_str(
                " Review only: don't edit files, commit, push, merge, comment on pull requests, or change tasks on the \
                 board. Don't call `request_user_input`. When the review is complete, call `submit_review` exactly once \
                 with your verdict, then end your turn with a short summary of the review.",
            );
            s
        }
        ("task", p) if task.task_type.is_some() => {
            let key = key_prefix(task, p);
            let mut s = format!(
                "You are an agent working on task {key}-{} (\"{}\", id {}) on the Huntaway board, a kanban board where each \
                 task is worked by its own Claude agent.",
                task.number, task.title, task.id
            );
            s.push_str(&crate::documents::system_prompt(task, document.unwrap_or("?"), p, group));
            s.push_str(&format!(
                " {tools} If you are blocked or need a decision or information from the user, call `request_user_input` \
                 with your question (and its `options`, when the choices are known) and then end your turn — the task is \
                 flagged \"Needs attention\" and the user's reply \
                 resumes this conversation. When you finish, end with a concise summary of what you made or changed; the \
                 task then moves to \"In review\"."
            ));
            s
        }
        ("task", None) if task.group_name.is_some() => {
            let name = task.group_name.as_deref().unwrap_or_default();
            let projects = if group.is_empty() {
                " The group has no projects at the moment (it may have been renamed or ungrouped): ask the user which \
                 projects to use."
                    .to_string()
            } else {
                let list: Vec<String> = group.iter().map(|p| format!("{} (key {}, id {}, repository {})", p.name, p.key, p.id, p.repo_path)).collect();
                format!(" The group's projects: {}. You can read their repositories.", list.join("; "))
            };
            format!(
                "You are the planning agent for task {}-{} (\"{}\", id {}) on the Huntaway board, a kanban board where each \
                 task is worked by its own Claude agent. This is a group task: it isn't in a project but plans work across \
                 the projects of the group \"{name}\".{projects} Your working directory is a scratch folder for notes. \
                 {tools} Your job is to plan and coordinate, not to change the repositories yourself: break the work into \
                 tasks in the right projects with `create_task` (always give its project_id; start=true launches an agent \
                 on one, and depends_on orders tasks within a project), follow them with `list_tasks` and `get_task`, and \
                 guide their agents with `send_to_task`. While they work, wait for them with `wait` (listing them in `tasks`) \
                 rather than ending your turn. Tasks you create are recorded as this task's: the board shows how \
                 many are done, and `get_task` on this task lists them. Run tasks that build on each other one after the other, and independent ones in \
                 parallel. If you are blocked or need a decision or information from the user, call `request_user_input` \
                 with your question (and its `options`, when the choices are known) and then end your turn — the task is \
                 flagged \"Needs attention\" and the user's reply \
                 resumes this conversation. When you finish, end with a concise summary of the tasks you created and where \
                 they stand; the task then moves to \"In review\".",
                GROUP_TASK_KEY, task.number, task.title, task.id
            )
        }
        (_, p) => {
            let key = p.map(|p| p.key.as_str()).unwrap_or("T");
            let mut s = format!(
                "You are an agent working on task {key}-{} (\"{}\") on the Huntaway board.",
                task.number, task.title
            );
            if let Some(p) = p {
                s.push_str(&format!(" Project: {} (repository {}).", p.name, p.repo_path));
            }
            if let (Some(wt), Some(br)) = (&task.worktree_path, &task.branch) {
                s.push_str(&format!(
                    " You are in a dedicated git worktree at {wt} on branch `{br}`{}. Make all changes here. \
                     When you complete a meaningful unit of work, commit it to this branch with a clear message. \
                     Do not {} unless asked.",
                    task.base_branch.as_ref().map(|b| format!(" (branched from `{b}`)")).unwrap_or_default(),
                    // It pushes the branch for its pull request.
                    if github.is_some() { "merge or switch branches" } else { "push, merge, or switch branches" }
                ));
            }
            if task.subproject {
                let br = task.branch.as_deref().unwrap_or("this task's branch");
                let base = task.base_branch.as_deref().or(p.and_then(|p| p.base_branch.as_deref())).unwrap_or("the base branch");
                s.push_str(&format!(
                    " This task is a subproject: it has its own board of tasks, each worked by its own agent in a worktree \
                     branched from `{br}`, and their work is merged back into `{br}` (through pull requests that target it, \
                     if the project uses them). The subproject as a whole is then merged into `{base}`, so its tasks add up \
                     to a series of small, reviewable changes instead of one big one. Your job is mostly to plan and \
                     coordinate: break the work into small tasks with `create_task` (they're added to this subproject; \
                     start=true launches an agent on one), follow them with `list_tasks` and `get_task`, and guide their \
                     agents with `send_to_task`. While they work, wait for them with `wait` (listing them in `tasks`) \
                     rather than ending your turn. Run tasks that build on each other one after the other, and independent \
                     ones in parallel. Their merges land on `{br}` on the remote, so pull before working in your worktree."
                ));
            }
            if let Some(sp) = parent.filter(|t| t.subproject) {
                let sp_branch = task.base_branch.as_deref().or(sp.branch.as_deref()).unwrap_or("the subproject's branch");
                s.push_str(&format!(
                    " This task is part of the subproject {key}-{} (\"{}\"), whose branch `{sp_branch}` collects the work of \
                     its tasks: your branch starts from `{sp_branch}` and is merged back into it, not into the project's main \
                     branch. If you open a pull request, target `{sp_branch}` (e.g. {}), \
                     pushing `{sp_branch}` first if the remote doesn't have it yet. If you merge without a pull request, \
                     merge into `{sp_branch}`{}. Tasks you create are added to the subproject too.",
                    sp.number,
                    sp.title,
                    if gh_tools { format!("pr_create with base `{sp_branch}`") } else { format!("`gh pr create --base {sp_branch}`") },
                    sp.worktree_path.as_ref().map(|w| format!(", which is checked out in the subproject's worktree at {w}")).unwrap_or_default()
                ));
            }
            if let (Some(gh), Some(br)) = (github, &task.branch) {
                let base = task.base_branch.as_deref().or(p.and_then(|p| p.base_branch.as_deref())).filter(|b| !b.is_empty());
                // The repository is named, as gh would pick one from the remotes' fetch URLs.
                let repo = &gh.repo;
                let open = if gh_tools {
                    format!("the gh tools' pr_create with repo `{repo}`, head `{br}`{}", base.map(|b| format!(" and base `{b}`")).unwrap_or_default())
                } else {
                    format!(
                        "`gh pr create --repo {repo} --head {br}{}`, or the gh tools' git_push and pr_create with the same repo, \
                         head and base",
                        base.map(|b| format!(" --base {b}")).unwrap_or_default()
                    )
                };
                s.push_str(&format!(
                    " The repository is on GitHub ({repo}), so before you finish, open a pull request for this task's work \
                     unless the project's own instructions (e.g. in CLAUDE.md) say otherwise: commit everything, push the \
                     branch (`git push -u {} {br}`{}) and open the pull request{} in {repo} ({open}), with a title and a \
                     body that say what changed and how to try it. If the branch has a pull request already, push to it \
                     instead. Put the pull request's link in your summary. A task with no changes on its branch doesn't need one.",
                    gh.remote,
                    if gh_tools { ", or the gh tools' git_push if that fails" } else { "" },
                    base.map(|b| format!(" into `{b}`")).unwrap_or_default(),
                ));
            }
            s.push_str(&format!(
                " {tools} If you are blocked or need a decision or information from the user, call `request_user_input` \
                 with your question (and its `options`, when the choices are known) and then end your turn — the task is \
                 flagged \"Needs attention\" and the user's reply \
                 resumes this conversation. When you finish, end with a concise summary of what you did; the task then \
                 moves to \"In review\". You may create follow-up tasks with `create_task`."
            ));
            s
        }
    }
}

const SUBAGENT_EVENTS: [&str; 4] = ["task_started", "task_progress", "task_updated", "task_notification"];

/// Strip bulky fields we never render from a stream-json event.
fn slim(mut v: Value) -> Value {
    if let Some(obj) = v.as_object_mut() {
        // An Agent/Task result says whether the subagent went to the background and which
        // model ran it; keep just that.
        let agent = obj.get("tool_use_result").filter(|r| r.get("agentId").is_some()).map(|r| {
            const KEEP: [&str; 8] =
                ["status", "isAsync", "agentId", "agentType", "resolvedModel", "totalDurationMs", "totalTokens", "totalToolUseCount"];
            Value::Object(KEEP.iter().filter_map(|k| r.get(*k).map(|x| (k.to_string(), x.clone()))).collect())
        });
        obj.remove("tool_use_result");
        obj.remove("tool_result_meta");
        if let Some(a) = agent {
            obj.insert("tool_use_result".into(), a);
        }
    }
    if let Some(blocks) = v["message"]["content"].as_array_mut() {
        blocks.retain(|b| !(b["type"] == "thinking" && b["thinking"].as_str().unwrap_or("").is_empty()));
        for b in blocks.iter_mut() {
            if let Some(o) = b.as_object_mut() {
                o.remove("signature");
                o.remove("caller");
            }
            if b["type"] == "tool_result" {
                match &b["content"] {
                    Value::String(s) if s.len() > 30_000 => b["content"] = json!(truncate(s, 30_000)),
                    Value::Array(parts) => {
                        let parts: Vec<Value> = parts
                            .iter()
                            .map(|p| match p["text"].as_str() {
                                Some(t) if t.len() > 30_000 => json!({"type": "text", "text": truncate(t, 30_000)}),
                                _ if p["type"] == "image" => json!({"type": "text", "text": "[image]"}),
                                _ => p.clone(),
                            })
                            .collect();
                        b["content"] = Value::Array(parts);
                    }
                    _ => {}
                }
            }
        }
    }
    if let Some(m) = v["message"].as_object_mut() {
        m.remove("usage");
        m.remove("container");
        m.remove("stop_details");
    }
    v
}

/// Apply a chunk of a run's output (complete stream-json lines starting at byte `offset`).
/// Chunks can repeat after a reconnect; anything before the saved offset is skipped.
pub fn on_output(state: &Shared, run_id: &str, offset: u64, data: &str) {
    let Ok(Some(run)) = db::get_run(&state.db(), run_id) else { return };
    if run.status == "exited" {
        return;
    }
    let saved = run.out_offset as u64;
    let end = offset + data.len() as u64;
    if end <= saved {
        return;
    }
    let fresh = if offset < saved { data.get((saved - offset) as usize..).unwrap_or("") } else { data };
    if offset > saved {
        tracing::warn!(run = run_id, "output gap: expected offset {saved}, got {offset}");
    }
    for line in fresh.lines() {
        if let Err(e) = handle_line(state, &run, line) {
            tracing::warn!("failed to handle claude output: {e:#}");
        }
    }
    let _ = state.db().execute("UPDATE runs SET out_offset=?1 WHERE id=?2", rusqlite::params![end as i64, run_id]);
}

pub fn on_exit(state: &Shared, run_id: &str, code: Option<i32>, signal: Option<i32>, error: Option<String>, stderr_tail: &str) {
    let Ok(Some(run)) = db::get_run(&state.db(), run_id) else { return forget(state, run_id) };
    if run.status == "exited" {
        return;
    }
    let outcome = if run.stop_requested {
        Outcome::Cancelled
    } else if let Some(e) = run.result_error {
        Outcome::Failed(e)
    } else if code == Some(0) && run.saw_result {
        Outcome::Ok
    } else {
        let how = match (error, code, signal) {
            (Some(e), _, _) => e,
            (None, Some(c), _) => format!("the agent exited with code {c}"),
            (None, None, Some(sig)) => format!("the agent was killed by signal {sig}"),
            _ => "the agent exited unexpectedly".into(),
        };
        let stderr = stderr_tail.trim();
        Outcome::Failed(if stderr.is_empty() { how } else { format!("{how}\n{}", truncate(stderr, 4000)) })
    };
    finish(state, run_id, outcome);
}

fn handle_line(state: &Shared, run: &Run, line: &str) -> Result<()> {
    let task_id = run.task_id.as_str();
    let v: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return Ok(()),
    };
    // Codex runs write app-server notifications; Claude Code's stream-json has no `method`.
    if v.get("method").is_some() {
        return crate::codex::handle_line(state, run, &v);
    }
    match v["type"].as_str().unwrap_or("") {
        "system" if v["subtype"] == "init" => {
            if let Some(sid) = v["session_id"].as_str() {
                state.update_task(task_id, &[("session_id", json!(sid))])?;
            }
            let c = state.db();
            if let Some(t) = db::get_task(&c, task_id)?.filter(|t| t.project_id.is_some()) {
                let config = db::task_claude_config(&c, &t)?;
                crate::agent_tools::record_seen(&c, t.project_id.as_deref().unwrap(), config.as_ref().map(|c| c.id.as_str()), &v)?;
            }
        }
        // From `/compact`, or Claude Code compacting by itself when the context fills up.
        "system" if v["subtype"] == "compact_boundary" => {
            state.add_message(task_id, "claude", json!({"type": "system", "subtype": "compact_boundary", "compact_metadata": v["compact_metadata"]}))?;
            crate::context::on_compacted(state, task_id, &v["compact_metadata"])?;
        }
        // Subagent lifecycle (Agent/Task tool), keyed by the launching `tool_use_id`.
        "system" if v["subtype"].as_str().is_some_and(|s| SUBAGENT_EVENTS.contains(&s)) => {
            let mut v = v;
            if let Some(obj) = v.as_object_mut() {
                obj.remove("output_file");
                obj.remove("uuid");
                obj.remove("session_id");
                if let Some(u) = obj.get("usage").cloned() {
                    obj.insert("usage".into(), json!({"total_tokens": u["total_tokens"], "tool_uses": u["tool_uses"], "duration_ms": u["duration_ms"]}));
                }
            }
            let message = state.add_message(task_id, "claude", v)?;
            crate::wait::subagent_finished(state, run, &message.data)?;
        }
        "rate_limit_event" => {
            let config = {
                let c = state.db();
                db::get_task(&c, task_id)?.map(|t| db::task_claude_config(&c, &t)).transpose()?.flatten()
            };
            if let Some(config) = config {
                crate::usage::on_rate_limit_event(state, &config.id, &v);
            }
        }
        "stream_event" => {
            // Only the top-level thread streams a preview.
            if !v["parent_tool_use_id"].is_null() {
                return Ok(());
            }
            let ev = &v["event"];
            if ev["type"] == "content_block_delta" && ev["delta"]["type"] == "text_delta" {
                if let Some(t) = ev["delta"]["text"].as_str() {
                    state.emit(json!({"type": "delta", "task_id": task_id, "text": t}));
                }
            } else if ev["type"] == "message_start" {
                state.emit(json!({"type": "delta_reset", "task_id": task_id}));
            }
        }
        "assistant" | "user" => {
            if v["type"] == "user" && v["isReplay"] == true {
                if let Some(id) = v["uuid"].as_str() {
                    steered(state, run, id)?;
                }
                return Ok(());
            }
            if crate::wait::is_activity(&v) {
                crate::wait::resumed(state, task_id, &run.id);
            }
            if v["type"] == "assistant" {
                crate::context::on_assistant(state, task_id, &v)?;
            }
            let v = slim(v);
            if v["message"]["content"].as_array().is_some_and(|c| c.is_empty()) {
                return Ok(());
            }
            let tool_result = v["type"] == "user" && v["message"]["content"].as_array().is_some_and(|c| c.iter().any(|b| b["type"] == "tool_result"));
            state.add_message(task_id, "claude", v)?;
            // A tool call may have changed the task's document: the task shows it as it's written.
            if tool_result {
                crate::documents::follow(state, task_id);
            }
        }
        "control_response" => crate::context::on_control_response(state, task_id, &v)?,
        "result" => {
            crate::context::on_result(state, task_id, &v)?;
            // Before the turn's end closes its input (see `turn_ended`).
            crate::context::request(state, run);
            // A running total for the agent's process, which may go on for several turns.
            let total = v["total_cost_usd"].as_f64().unwrap_or(0.0);
            let so_far: f64 = state.db().query_row("SELECT cost_usd FROM runs WHERE id=?1", [&run.id], |r| r.get(0))?;
            let cost = (total - so_far).max(0.0);
            state.db().execute("UPDATE runs SET cost_usd=?1 WHERE id=?2", rusqlite::params![total.max(so_far), run.id])?;
            let task = db::get_task(&state.db(), task_id)?;
            if let Some(t) = task {
                let mut fields = vec![("cost_usd", json!(t.cost_usd + cost))];
                if let Some(sid) = v["session_id"].as_str() {
                    fields.push(("session_id", json!(sid)));
                }
                state.update_task(task_id, &fields)?;
            }
            let mut result_error = None;
            if v["is_error"] == true || v["subtype"].as_str().is_some_and(|s| s != "success") {
                result_error = Some(
                    v["result"]
                        .as_str()
                        .map(String::from)
                        .or_else(|| v["errors"].as_array().map(|e| e.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join("\n")))
                        .unwrap_or_else(|| format!("run ended with {}", v["subtype"])),
                );
            }
            let slimmed = json!({
                "type": "result",
                "subtype": v["subtype"],
                "is_error": v["is_error"],
                "result": v["result"],
                "duration_ms": v["duration_ms"],
                "num_turns": v["num_turns"],
                "total_cost_usd": cost,
            });
            record_result(state, run, result_error, slimmed)?;
        }
        _ => {}
    }
    Ok(())
}

/// The end of one of the agent's turns (Claude Code's `result`, or a Codex turn completing):
/// record its outcome and add `result` (shaped like Claude Code's) to the thread. The last
/// turn's outcome is the run's.
pub fn record_result(state: &Shared, run: &Run, error: Option<String>, mut result: Value) -> Result<()> {
    let stopping: i64 = state.db().query_row("SELECT stop_requested FROM runs WHERE id=?1", [&run.id], |r| r.get(0))?;
    if stopping == 1 {
        // The turn a stop interrupted: from here, a message it takes in starts a new one.
        state.db().execute("UPDATE runs SET stop_requested=2 WHERE id=?1", [&run.id])?;
        if error.is_some() {
            result["interrupted"] = json!(true);
        }
    }
    state.db().execute("UPDATE runs SET saw_result=1, between_turns=1, result_error=?1 WHERE id=?2", rusqlite::params![error, run.id])?;
    // A turn that ended isn't waiting any more, even if the agent gave up on the call.
    crate::wait::ended(state, &run.task_id, &run.id);
    crate::documents::turn_ended(state, &run.task_id);
    state.add_message(&run.task_id, "claude", result)?;
    turn_ended(state, run);
    Ok(())
}

/// Forget a run whose row is gone (its task was deleted while it ran).
fn forget(state: &Shared, run_id: &str) {
    state.runs.lock().unwrap().retain(|_, h| h.run_id != run_id);
}

/// Write the end of run `run_id` to its task, unless a run has started on it since: the task's
/// running state and column are then that run's (see db::later_run).
fn end_run(state: &Shared, task_id: &str, run_id: &str, fields: &[(&str, Value)]) -> Result<Option<Task>> {
    state.update_task_if(task_id, fields, |c| Ok(!db::later_run(c, task_id, run_id)?))
}

fn finish(state: &Shared, run_id: &str, outcome: Outcome) {
    let Ok(Some(run)) = db::get_run(&state.db(), run_id) else { return forget(state, run_id) };
    let task_id = run.task_id.as_str();
    let queued = {
        let mut runs = state.runs.lock().unwrap();
        if runs.get(task_id).is_some_and(|h| h.run_id == run_id) {
            runs.remove(task_id);
        }
        // What the agent never took in goes with the next prompt.
        if let Err(e) = requeue_steers(state, task_id, run_id) {
            tracing::error!(task = task_id, "requeueing messages the agent didn't take in: {e:#}");
        }
        // Under the lock, so no run starts meanwhile: once one has, the thread's prompts may be its.
        let later = db::later_run(&state.db(), task_id, run_id);
        match later {
            Ok(false) => permissions::expire_for_task(state, task_id),
            _ => permissions::expire_for_run(state, run_id),
        }
        crate::wait::ended(state, task_id, run_id);
        has_queued(state, &runs, task_id)
    };
    #[cfg(test)]
    crate::testing::reached("finish:released");
    let _ = state.db().execute(
        "UPDATE runs SET status='exited', ended_at=?1 WHERE id=?2",
        rusqlite::params![crate::util::now(), run_id],
    );
    #[cfg(test)]
    crate::testing::reached("finish:exited");
    // What a stopped or failed run had written of its document.
    crate::documents::turn_ended(state, task_id);
    state.emit(json!({"type": "delta_reset", "task_id": task_id}));
    let Ok(Some(task)) = db::get_task(&state.db(), task_id) else { return };
    if run.kind == "review" {
        crate::review::finished(state, &task, run_id, &outcome, run.attention.as_deref());
    }
    if run.kind == "compact" {
        match &outcome {
            Outcome::Ok => {}
            Outcome::Cancelled => state.add_event(task_id, "warn", "Compacting stopped", None),
            Outcome::Failed(e) => state.add_event(task_id, "error", "Compacting failed", Some(e.clone())),
        }
        if queued && send_queued(state, task_id) {
            return;
        }
        if let Err(e) = end_run(state, task_id, run_id, &[("running", json!(false))]) {
            tracing::error!("failed to finalize run: {e:#}");
        }
        start_next_merge(state, task.project_id.as_deref());
        return;
    }
    let is_task = task.kind == "task";
    let (status, reason): (Option<&str>, Option<String>) = match (&outcome, run.attention) {
        (Outcome::Cancelled, _) => {
            state.add_event(task_id, "warn", "Run stopped", None);
            (Some("needs_attention"), Some("Stopped by user".into()))
        }
        (Outcome::Failed(e), _) => {
            state.add_event(task_id, "error", "Run failed", Some(e.clone()));
            (Some("needs_attention"), Some(format!("Run failed: {}", e.lines().next().unwrap_or(""))))
        }
        (Outcome::Ok, Some(q)) => (Some("needs_attention"), Some(q)),
        // The agent marked its own task done (e.g. after merging it).
        (Outcome::Ok, None) if task.status == "done" => (None, None),
        (Outcome::Ok, None) if task.merging => (Some("needs_attention"), Some("The agent finished without marking the task merged".into())),
        (Outcome::Ok, None) => (Some("in_review"), None),
    };
    // The queued message carries on the conversation, so the task stays where it is.
    if queued && send_queued(state, task_id) {
        return;
    }
    let mut fields = vec![("running", json!(false)), ("attention_reason", json!(reason))];
    if is_task {
        if let Some(s) = status {
            fields.push(("status", json!(s)));
        }
    }
    let updated = match end_run(state, task_id, run_id, &fields) {
        Ok(t) => t,
        Err(e) => {
            tracing::error!("failed to finalize run: {e:#}");
            None
        }
    };
    if is_task {
        start_next_merge(state, task.project_id.as_deref());
        crate::worktree::find_pr(state, &task);
    }
    if let Some(t) = updated.filter(|t| is_task && t.status == "in_review" && status == Some("in_review")) {
        crate::review::on_in_review(state, &t);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caches_are_writable_before_their_first_use() {
        let home = std::env::temp_dir().join(format!("ia-home-{}", crate::util::new_id()));
        std::fs::create_dir_all(&home).unwrap();
        // A bare home directory: no `~/.cargo` (a system Cargo) or `~/.local/share` yet.
        let found = cache_dirs_in(&home, |_| None);
        assert_eq!(found, [".cache", ".npm", ".cargo/registry", ".cargo/git", ".local/share/pnpm"].map(|d| path_str(&home.join(d))));
        assert!(found.iter().all(|d| std::path::Path::new(d).is_dir()));
        // Where the environment moves them.
        let env = |k: &str| match k {
            "XDG_CACHE_HOME" => Some(path_str(&home.join("xdg/cache"))),
            "XDG_DATA_HOME" => Some(path_str(&home.join("xdg/data"))),
            "CARGO_HOME" => Some(path_str(&home.join("cargo"))),
            _ => Some(String::new()),
        };
        let found = cache_dirs_in(&home, env);
        assert_eq!(found, ["xdg/cache", ".npm", "cargo/registry", "cargo/git", "xdg/data/pnpm"].map(|d| path_str(&home.join(d))));
        assert!(found.iter().all(|d| std::path::Path::new(d).is_dir()));
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn many_long_ignored_directories_dont_block_the_launch() {
        crate::testing::run(async || {
            let dir = std::env::temp_dir().join(format!("ia-ignored-{}", crate::util::new_id()));
            // More than check-ignore's input and output pipes hold together (64 KiB each): 200
            // paths of ~730 bytes.
            let long = "x".repeat(240);
            let mut expected = Vec::new();
            for i in 0..10 {
                for j in 0..20 {
                    let parent = dir.join(format!("{i}{long}/{j}{long}"));
                    std::fs::create_dir_all(&parent).unwrap();
                    std::fs::write(parent.join("tracked"), "1").unwrap();
                    let d = parent.join(format!("{long}.ign"));
                    std::fs::create_dir_all(&d).unwrap();
                    std::fs::write(d.join("f"), "1").unwrap();
                    expected.push(path_str(&d));
                }
            }
            std::fs::write(dir.join(".gitignore"), "*.ign\n").unwrap();
            let git = |args: &[&str]| assert!(std::process::Command::new("git").args(args).current_dir(&dir).output().unwrap().status.success());
            git(&["init", "-q", "."]);
            git(&["add", "."]);
            let mut found = ignored_dirs(&path_str(&dir)).await;
            found.sort();
            expected.sort();
            let base = path_str(&dir).len();
            assert!(expected.iter().map(|p| p.len() - base).sum::<usize>() > 140 * 1024);
            assert_eq!(found, expected);
            std::fs::remove_dir_all(&dir).unwrap();
        })
    }

    #[test]
    fn a_reviewers_work_stays_read_only_inside_a_cache() {
        let write = vec!["/home/me/.cache".to_string(), "/home/me/.cache/w/target".to_string()];
        let fs = review_filesystem(write, vec!["/home/me/.cache/w".into(), "/home/me/.cache/repo/.git".into()]);
        let fs: Vec<(&str, &str)> = fs.iter().map(|(p, a)| (p.as_str(), a.as_str())).collect();
        assert_eq!(
            fs,
            [("/home/me/.cache", "write"), ("/home/me/.cache/repo/.git", "read"), ("/home/me/.cache/w", "read"), ("/home/me/.cache/w/target", "write")]
        );
    }

    #[test]
    fn a_reviewer_may_write_the_directories_git_ignores_whole() {
        crate::testing::run(async || {
            let dir = std::env::temp_dir().join(format!("ia-ignored-{}", crate::util::new_id()));
            for d in ["target/debug", "app/node_modules/x", "build", ".claude", "src"] {
                std::fs::create_dir_all(dir.join(d)).unwrap();
            }
            std::fs::write(dir.join(".gitignore"), "target\nnode_modules\nbuild\n.claude\n.env\n").unwrap();
            for f in ["build/tracked", "build/untracked", ".env", "src/a.rs", "app/node_modules/x/i", ".claude/settings.local.json"] {
                std::fs::write(dir.join(f), "1").unwrap();
            }
            let git = |args: &[&str]| assert!(std::process::Command::new("git").args(args).current_dir(&dir).output().unwrap().status.success());
            git(&["init", "-q", "."]);
            git(&["add", ".gitignore", "src"]);
            git(&["add", "-f", "build/tracked"]);
            let mut found = ignored_dirs(&path_str(&dir)).await;
            found.sort();
            // Not `build`, which holds a tracked file, nor the agents' settings.
            assert_eq!(found, vec![path_str(&dir.join("app/node_modules")), path_str(&dir.join("target"))]);
            assert_eq!(ignored_dirs(&path_str(&std::env::temp_dir().join("ia-no-such-dir"))).await, Vec::<String>::new());
            std::fs::remove_dir_all(&dir).unwrap();
        })
    }

    #[test]
    fn only_merging_tasks_merge_without_asking() {
        let c = db::open(std::path::Path::new(":memory:")).unwrap();
        let p = db::insert_profile(&c, "p", &[], None).unwrap();
        let np = db::NewProject { id: "pr", profile_id: &p.id, name: "x", key: "X", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
        db::insert_project(&c, np).unwrap();
        let t = db::NewTask { profile_id: &p.id, project_id: Some("pr"), kind: "task", title: "t", description: "", status: "in_review", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let task = db::insert_task(&c, t).unwrap();
        assert_eq!(gh_allowed(&task), crate::gh_mcp::READ_ONLY);
        let merging = Task { merging: true, status: "ready_for_merge".into(), ..task.clone() };
        assert_eq!(gh_allowed(&merging), [crate::gh_mcp::READ_ONLY, &["pr_merge"]].concat());
        // Still merging while it waits on the user, so their reply's run can merge too.
        assert!(gh_allowed(&Task { status: "needs_attention".into(), ..merging.clone() }).contains(&"pr_merge"));
        assert!(!gh_allowed(&Task { kind: "review".into(), ..merging }).contains(&"pr_merge"));
    }

    #[test]
    fn a_message_queued_during_a_run_waits_for_new_dependencies() {
        let c = db::open(std::path::Path::new(":memory:")).unwrap();
        let p = db::insert_profile(&c, "p", &[], None).unwrap();
        let np = db::NewProject { id: "pr", profile_id: &p.id, name: "x", key: "X", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
        db::insert_project(&c, np).unwrap();
        let task = |title: &str| {
            let t = db::NewTask { profile_id: &p.id, project_id: Some("pr"), kind: "task", title, description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
            db::insert_task(&c, t).unwrap()
        };
        let (a, b) = (task("a"), task("b"));
        let id = crate::state::Identity { host_id: "h".into(), host_name: "h".into(), token: String::new(), hub_token: String::new(), internal_url: String::new() };
        let meta = crate::admin::ServerMeta { boot_id: String::new(), started_at: String::new(), source_dir: None, running_commit: None, args: vec![] };
        let dir = std::env::temp_dir().join(format!("ia-runner-{}", crate::util::new_id()));
        let state: Shared = crate::state::AppState::new(c, dir, id, meta);
        runs::TEST_CAN_RUN.set(true);

        // B's agent is running; it gets a dependency on A and a message is queued meanwhile.
        let run = db::insert_run(&state.db(), &b.id, "prompt").unwrap();
        state.runs.lock().unwrap().insert(b.id.clone(), RunHandle { run_id: run.id.clone(), cancel: None });
        state.update_task(&b.id, &[("running", json!(true)), ("status", json!("in_progress")), ("depends_on", json!([a.id]))]).unwrap();
        send(&state, &b.id, "and then this").unwrap();
        finish(&state, &run.id, Outcome::Ok);

        let b = db::get_task(&state.db(), &b.id).unwrap().unwrap();
        assert!(!state.is_running(&b.id));
        assert_eq!((b.running, b.waiting, b.status.as_str()), (false, true, "in_progress"));
        assert_eq!(b.queued_message.as_deref(), Some("and then this"));
        runs::TEST_CAN_RUN.set(false);
    }

    #[test]
    fn an_effort_a_codex_model_doesnt_take_gives_way_to_its_default() {
        let model = |id: &str, default: bool, efforts: &[&str], effort: Option<&str>| crate::codex::Model {
            id: id.into(),
            name: id.into(),
            is_default: default,
            efforts: efforts.iter().map(|e| e.to_string()).collect(),
            default_effort: effort.map(String::from),
        };
        let models = [model("gpt-5.5", true, &["low", "medium", "high", "xhigh"], Some("medium")), model("gpt-6", false, &["low", "max"], None), model("odd", false, &[], None)];
        let e = |effort: &str, m: Option<&str>| codex_effort(Some(effort.into()), m, &models);
        assert_eq!(e("max", Some("gpt-5.5")).as_deref(), Some("medium"));
        assert_eq!(e("high", Some("gpt-5.5")).as_deref(), Some("high"));
        // No model: the default one's.
        assert_eq!(e("max", None).as_deref(), Some("medium"));
        assert_eq!(e("max", Some("gpt-6")).as_deref(), Some("max"));
        assert_eq!(e("high", Some("gpt-6")), None, "no default of its own: Codex picks");
        // A model it doesn't know, or one that doesn't list its efforts, keeps it.
        assert_eq!(e("max", Some("gpt-7")).as_deref(), Some("max"));
        assert_eq!(e("max", Some("odd")).as_deref(), Some("max"));
        assert_eq!(codex_effort(None, Some("gpt-5.5"), &models), None);

        // A run checks the model it runs with, its own or inherited, with the config's models (as Codex lists them).
        let listed = models.to_vec();
        crate::testing::run(async move || {
            let home = format!("/tmp/ia-codex-{}", crate::util::new_id());
            crate::codex::set_test_models(&home, listed.clone());
            let c = crate::testing::state();
            let cfg = db::insert_claude_config(&c.db(), "Codex", &home, "codex").unwrap();
            assert_eq!(codex_run_effort(&cfg, Some("gpt-5.5"), Some("max".into())).await.as_deref(), Some("medium"));
            assert_eq!(codex_run_effort(&cfg, Some("gpt-6"), Some("max".into())).await.as_deref(), Some("max"));
            assert_eq!(codex_run_effort(&cfg, None, Some("max".into())).await.as_deref(), Some("medium"));
            assert_eq!(codex_run_effort(&cfg, Some("gpt-5.5"), None).await, None);
        })
    }

    /// A task whose agent is running a run that takes input (or not), with no process behind it.
    fn running(input: bool) -> (Shared, Task, Run) {
        let state = crate::testing::state();
        let p = db::insert_profile(&state.db(), "p", &[], None).unwrap();
        let t = db::NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "t", description: "", status: "in_progress", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let task = db::insert_task(&state.db(), t).unwrap();
        let run = db::insert_run(&state.db(), &task.id, "prompt").unwrap();
        state.db().execute("UPDATE runs SET status='running' WHERE id=?1", [&run.id]).unwrap();
        let dir = runs::run_dir(&state, &run.id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("out.jsonl"), "").unwrap();
        if input {
            std::fs::write(dir.join("input.jsonl"), "").unwrap();
        }
        state.runs.lock().unwrap().insert(task.id.clone(), RunHandle { run_id: run.id.clone(), cancel: None });
        let task = state.update_task(&task.id, &[("running", json!(true))]).unwrap().unwrap();
        (state, task, run)
    }

    /// The agent writes `lines` to its output.
    fn output(state: &Shared, run: &Run, lines: &[Value]) {
        let offset = db::get_run(&state.db(), &run.id).unwrap().unwrap().out_offset as u64;
        let data: String = lines.iter().map(|l| format!("{l}\n")).collect();
        on_output(state, &run.id, offset, &data);
    }

    /// What the agent has been sent after its prompt.
    fn input(state: &Shared, run: &Run) -> Vec<Value> {
        let text = std::fs::read_to_string(runs::run_dir(state, &run.id).join("input.jsonl")).unwrap();
        text.lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }

    fn input_closed(state: &Shared, run: &Run) -> bool {
        runs::run_dir(state, &run.id).join("input.closed").exists()
    }

    fn reload(state: &Shared, id: &str) -> Task {
        db::get_task(&state.db(), id).unwrap().unwrap()
    }

    fn user_messages(state: &Shared, id: &str) -> Vec<Value> {
        db::list_messages(&state.db(), id).unwrap().into_iter().filter(|m| m.kind == "user").map(|m| m.data).collect()
    }

    fn replay(id: &str, text: &str) -> Value {
        json!({"type": "user", "isReplay": true, "uuid": id, "message": {"role": "user", "content": text}})
    }

    fn result(subtype: &str, total_cost: f64) -> Value {
        json!({"type": "result", "subtype": subtype, "is_error": subtype != "success", "total_cost_usd": total_cost, "num_turns": 1})
    }

    #[test]
    fn steers_a_message_into_the_running_turn() {
        crate::testing::run(async || {
            let (state, task, run) = running(true);
            let t = send(&state, &task.id, "  also do this  ").unwrap();
            assert_eq!(t.queued_message, None);
            assert_eq!(t.steering.len(), 1);
            let steer = t.steering[0].clone();
            assert!(steer.written);
            assert_eq!(input(&state, &run), vec![json!({"type": "user", "uuid": steer.id, "message": {"role": "user", "content": "also do this"}})]);
            // Nothing in the thread until the agent takes it in.
            assert!(user_messages(&state, &task.id).is_empty());

            output(&state, &run, &[replay("the prompt's id", "the prompt"), replay(&steer.id, "also do this")]);
            assert_eq!(user_messages(&state, &task.id), vec![json!({"text": "also do this", "steered": true})]);
            assert!(task_steering_is_empty(&state, &task.id));
            assert!(!input_closed(&state, &run));

            // Nothing left waiting, so the turn's end ends the run.
            output(&state, &run, &[result("success", 0.5)]);
            assert!(input_closed(&state, &run));
            // A message sent now can't reach this run any more: it waits for the next.
            let t = send(&state, &task.id, "too late").unwrap();
            assert_eq!(t.queued_message.as_deref(), Some("too late"));
            assert!(t.steering.is_empty());
        });
    }

    #[test]
    fn the_end_of_a_turn_or_run_ends_a_wait() {
        crate::testing::run(async || {
            let (state, task, run) = running(true);
            let wait = |call_id: &str| {
                let w = db::AgentWait { reason: None, since: crate::util::now(), until: crate::util::now(), tasks: vec![], command: None, call_id: call_id.into(), run_id: run.id.clone(), moved_to: None, subagent_finished: None, pull_request: None };
                state.update_task(&task.id, &[("agent_wait", json!(w))]).unwrap();
            };
            // Its own thread calling another tool means it's working again; a subagent's doesn't.
            let tool_use = |parent: Value| json!({"type": "assistant", "parent_tool_use_id": parent, "message": {"content": [{"type": "tool_use", "id": "t", "name": "Bash", "input": {}}]}});
            wait("c0");
            output(&state, &run, &[tool_use(json!("toolu_sub"))]);
            assert!(reload(&state, &task.id).agent_wait.is_some());
            output(&state, &run, &[tool_use(Value::Null)]);
            assert_eq!(reload(&state, &task.id).agent_wait, None);
            // The agent gave up on the call (it was interrupted, say): the turn's end clears it.
            wait("c1");
            output(&state, &run, &[result("success", 0.1)]);
            assert_eq!(reload(&state, &task.id).agent_wait, None);
            wait("c2");
            finish(&state, &run.id, Outcome::Ok);
            let t = reload(&state, &task.id);
            assert_eq!((t.agent_wait, t.running), (None, false));
        });
    }

    fn task_steering_is_empty(state: &Shared, id: &str) -> bool {
        reload(state, id).steering.is_empty()
    }

    #[test]
    fn a_message_that_misses_the_turn_starts_the_next() {
        crate::testing::run(async || {
            let (state, task, run) = running(true);
            let steer = send(&state, &task.id, "one more thing").unwrap().steering[0].clone();
            // The turn ends before the agent took it in: it starts the next turn instead.
            output(&state, &run, &[result("success", 0.1)]);
            assert!(!input_closed(&state, &run));
            output(&state, &run, &[replay(&steer.id, "one more thing"), result("success", 0.25)]);
            assert!(input_closed(&state, &run));
            assert_eq!(user_messages(&state, &task.id).len(), 1);
            // Each turn's result shows that turn's cost; the task adds them up.
            let costs: Vec<Value> = db::list_messages(&state.db(), &task.id)
                .unwrap()
                .into_iter()
                .filter(|m| m.data["type"] == "result")
                .map(|m| m.data["total_cost_usd"].clone())
                .collect();
            assert_eq!(costs.len(), 2);
            assert!((costs[1].as_f64().unwrap() - 0.15).abs() < 1e-9, "{costs:?}");
            assert!((reload(&state, &task.id).cost_usd - 0.25).abs() < 1e-9);
        });
    }

    #[test]
    fn messages_the_agent_never_took_in_go_to_the_next_run() {
        crate::testing::run(async || {
            let (state, task, run) = running(true);
            send(&state, &task.id, "first").unwrap();
            send_from_agent(&state, &task.id, "second").unwrap();
            // Closed meanwhile (e.g. the agent exited), so this one is queued behind them.
            runs::close_input(&state, &run.id);
            send(&state, &task.id, "third").unwrap();
            {
                let _runs = state.runs.lock().unwrap();
                requeue_steers(&state, &task.id, &run.id).unwrap();
            }
            let t = reload(&state, &task.id);
            assert!(t.steering.is_empty());
            assert_eq!(t.queued_message.as_deref(), Some("first\n\nsecond\n\nthird"));
            // Not all of it came from other agents, so it counts as the user's.
            assert_eq!(db::take_queued(&state.db(), &task.id).unwrap(), Some(db::Queued { text: "first\n\nsecond\n\nthird".into(), from_agent: false, user_text: Some("first\n\nthird".into()) }));
        });
    }

    #[test]
    fn the_users_messages_retitle_the_task() {
        crate::testing::run(async || {
            let (state, task, run) = running(true);
            crate::title::TEST_REPLY.set(Some("Deploy the fix".into()));
            send_from_agent(&state, &task.id, "from another agent").unwrap();
            crate::title::tests::settle().await;
            assert_eq!(reload(&state, &task.id).title, "t");
            assert!(crate::title::TEST_ASKED.with_borrow(Vec::is_empty));

            send(&state, &task.id, "now deploy it").unwrap();
            crate::title::tests::settle().await;
            assert_eq!(reload(&state, &task.id).title, "Deploy the fix");
            let asked = crate::title::TEST_ASKED.with_borrow(Vec::clone);
            // Still waiting for the agent to take it in, it counts all the same; other agents' messages don't.
            assert!(asked.len() == 1 && asked[0].contains("now deploy it") && !asked[0].contains("another agent"), "{asked:?}");

            // Queued for the next run, it counts too.
            runs::close_input(&state, &run.id);
            crate::title::TEST_REPLY.set(Some("Deploy and tag the fix".into()));
            assert_eq!(send(&state, &task.id, "and tag it").unwrap().queued_message.as_deref(), Some("and tag it"));
            crate::title::tests::settle().await;
            assert_eq!(reload(&state, &task.id).title, "Deploy and tag the fix");
            assert!(crate::title::TEST_ASKED.with_borrow(|a| a.len() == 2 && a[1].contains("and tag it")));
        });
    }

    #[test]
    fn a_reply_the_agent_hasnt_taken_in_yet_goes_with_what_it_answers() {
        crate::testing::run(async || {
            let (state, task, run) = running(true);
            let said = |text: &str| json!({"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}});
            output(&state, &run, &[said("A: add a search cache; B: replace the database index")]);
            crate::title::TEST_REPLY.set(Some("Replace the database index".into()));
            let t = send(&state, &task.id, "Use option B").unwrap();
            assert_eq!(t.steering.len(), 1);
            crate::title::tests::settle().await;
            let asked = crate::title::TEST_ASKED.with_borrow(Vec::clone);
            assert!(asked[0].contains("<agent>A: add a search cache; B: replace the database index</agent>\nUse option B"), "{asked:?}");
            assert_eq!(reload(&state, &task.id).title, "Replace the database index");
        });
    }

    #[test]
    fn keeps_marking_messages_from_other_agents() {
        crate::testing::run(async || {
            let (state, task, run) = running(true);
            let steer = send_from_agent(&state, &task.id, "from another agent").unwrap().steering[0].clone();
            assert!(steer.from_agent);
            output(&state, &run, &[replay(&steer.id, "from another agent")]);
            assert_eq!(user_messages(&state, &task.id), vec![json!({"text": "from another agent", "steered": true, "from_agent": true})]);
        });
    }

    #[test]
    fn stop_interrupts_the_turn() {
        crate::testing::run(async || {
            let (state, task, run) = running(true);
            assert!(stop(&state, &task.id));
            let sent = input(&state, &run);
            assert_eq!((sent.len(), &sent[0]["type"], &sent[0]["request"]["subtype"]), (1, &json!("control_request"), &json!("interrupt")));
            assert!(!input_closed(&state, &run));
            output(&state, &run, &[result("error_during_execution", 0.0)]);
            assert!(input_closed(&state, &run));
            let r = db::get_run(&state.db(), &run.id).unwrap().unwrap();
            assert!(r.stop_requested);
            let last = db::list_messages(&state.db(), &task.id).unwrap().pop().unwrap();
            assert_eq!(last.data["interrupted"], true);
        });
    }

    #[test]
    fn a_message_waiting_when_stopped_starts_the_next_turn() {
        crate::testing::run(async || {
            let (state, task, run) = running(true);
            let steer = send(&state, &task.id, "do this instead").unwrap().steering[0].clone();
            state.db().execute("UPDATE runs SET attention='a question' WHERE id=?1", [&run.id]).unwrap();
            stop(&state, &task.id);
            // The agent ends the interrupted turn, then starts the next with the message.
            output(&state, &run, &[result("error_during_execution", 0.0)]);
            assert!(!input_closed(&state, &run));
            output(&state, &run, &[replay(&steer.id, "do this instead")]);
            let r = db::get_run(&state.db(), &run.id).unwrap().unwrap();
            // That turn goes ahead, so the run isn't stopped any more (and the user answered).
            assert!(!r.stop_requested);
            assert_eq!(r.attention, None);
            output(&state, &run, &[result("success", 0.0)]);
            assert!(input_closed(&state, &run));
            assert_eq!(db::get_run(&state.db(), &run.id).unwrap().unwrap().result_error, None);
        });
    }

    #[test]
    fn a_message_taken_in_before_a_stop_doesnt_undo_it() {
        crate::testing::run(async || {
            let (state, task, run) = running(true);
            let steer = send(&state, &task.id, "and this").unwrap().steering[0].clone();
            stop(&state, &task.id);
            // Taken in before the interrupt landed: the stop still ends the turn and the run.
            output(&state, &run, &[replay(&steer.id, "and this"), result("error_during_execution", 0.0)]);
            assert!(db::get_run(&state.db(), &run.id).unwrap().unwrap().stop_requested);
            assert!(input_closed(&state, &run));
        });
    }

    #[test]
    fn an_earlier_stop_doesnt_cut_a_later_one_short() {
        crate::testing::run(async || {
            let (state, task, run) = running(true);
            let steer = send(&state, &task.id, "do this instead").unwrap().steering[0].clone();
            stop(&state, &task.id);
            // The stop ends the turn, and the waiting message starts the next.
            output(&state, &run, &[result("error_during_execution", 0.0), replay(&steer.id, "do this instead")]);
            tokio::time::sleep(STOP_GRACE / 2).await;
            // Stopped again: the first stop's time is up before this one's.
            stop(&state, &task.id);
            tokio::time::sleep(STOP_GRACE * 3 / 4).await;
            assert!(!input_closed(&state, &run));
            // This one's isn't, and its turn hasn't ended.
            tokio::time::sleep(STOP_GRACE / 2).await;
            assert!(input_closed(&state, &run));
        });
    }

    /// The server restarts while the run is in `state`.
    fn restart(state: &Shared, task: &Task) {
        state.runs.lock().unwrap().remove(&task.id);
        load_active(state).unwrap();
    }

    #[test]
    fn after_a_restart_messages_still_have_to_start_the_next_turn() {
        crate::testing::run(async || {
            let (state, task, run) = running(true);
            send(&state, &task.id, "one more thing").unwrap();
            // The turn ended (before the restart) and the agent never took it in.
            state.db().execute("UPDATE runs SET saw_result=1, between_turns=1 WHERE id=?1", [&run.id]).unwrap();
            restart(&state, &task);
            assert!(reload(&state, &task.id).steerable);
            tokio::time::sleep(STEER_GRACE / 2).await;
            assert!(!input_closed(&state, &run));
            tokio::time::sleep(STEER_GRACE).await;
            assert!(input_closed(&state, &run));
        });
    }

    #[test]
    fn after_a_restart_a_message_can_wait_for_the_agents_next_step() {
        crate::testing::run(async || {
            let (state, task, run) = running(true);
            // Mid-turn, in a later turn than the one that ended.
            state.db().execute("UPDATE runs SET saw_result=1 WHERE id=?1", [&run.id]).unwrap();
            send(&state, &task.id, "when you get to it").unwrap();
            restart(&state, &task);
            tokio::time::sleep(STEER_GRACE * 2).await;
            assert!(!input_closed(&state, &run));
        });
    }

    #[test]
    fn follows_how_full_the_context_is() {
        crate::testing::run(async || {
            let (state, task, run) = running(true);
            let context = || reload(&state, &task.id).context.unwrap();
            let reply = |parent: Value, written: u64| {
                let usage = json!({"input_tokens": 2, "cache_creation_input_tokens": written, "cache_read_input_tokens": 1000, "output_tokens": 50});
                json!({"type": "assistant", "parent_tool_use_id": parent, "message": {"model": "claude-x", "content": [{"type": "text", "text": "hi"}], "usage": usage}})
            };
            output(&state, &run, &[reply(Value::Null, 500)]);
            assert_eq!((context().tokens, context().max_tokens), (1502, None));
            // A subagent's context is its own.
            output(&state, &run, &[reply(json!("toolu_sub"), 90_000)]);
            assert_eq!(context().tokens, 1502);

            // The turn's end gives the model's window, and asks for the breakdown before the
            // input is closed.
            let mut end = result("success", 0.1);
            end["modelUsage"] = json!({"claude-haiku": {"contextWindow": 1000}, "claude-x": {"contextWindow": 200_000}});
            output(&state, &run, &[end]);
            assert_eq!(context().max_tokens, Some(200_000));
            assert!(input_closed(&state, &run));
            let sent = input(&state, &run);
            let ask = sent.last().unwrap();
            assert_eq!((&ask["type"], &ask["request"]["subtype"]), (&json!("control_request"), &json!("get_context_usage")));
            // Not the full recount, which calls the token-counting API.
            assert_eq!(ask["request"]["detail"], "summary");
            assert_eq!(context().detail_at, None);

            // Other control responses aren't breakdowns.
            output(&state, &run, &[json!({"type": "control_response", "response": {"subtype": "success", "request_id": "stop-1", "response": {"totalTokens": 5}}})]);
            assert_eq!(context().tokens, 1502);
            let breakdown = json!({
                "categories": [{"id": "messages", "name": "Messages", "tokens": 600, "kind": "used"}],
                "totalTokens": 1600, "maxTokens": 1_000_000, "autoCompactThreshold": 967_000, "isAutoCompactEnabled": true,
                "model": "claude-x", "gridRows": [[{"color": "x"}]],
            });
            output(&state, &run, &[json!({"type": "control_response", "response": {"subtype": "success", "request_id": ask["request_id"], "response": breakdown}})]);
            let ctx = context();
            assert_eq!((ctx.tokens, ctx.max_tokens, ctx.compact_at, ctx.model.as_deref()), (1600, Some(1_000_000), Some(967_000), Some("claude-x")));
            assert!(ctx.detail_at.is_some());
            let got = crate::context::get(axum::extract::State(state.clone()), axum::extract::Path(task.id.clone())).await.unwrap().0;
            assert_eq!(got["detail"]["categories"][0]["tokens"], 600);
            assert!(got["detail"].get("gridRows").is_none());

            // Compacting starts again from the summary.
            output(&state, &run, &[json!({"type": "system", "subtype": "compact_boundary", "compact_metadata": {"trigger": "auto", "pre_tokens": 1600, "post_tokens": 300}})]);
            assert_eq!((context().tokens, context().max_tokens), (300, Some(1_000_000)));
        });
    }

    #[test]
    fn says_whether_the_running_agent_takes_messages() {
        crate::testing::run(async || {
            let (state, task, _run) = running(false);
            let task = state.update_task(&task.id, &[("steerable", json!(true))]).unwrap().unwrap();
            // Started by an older build, whose agents read only their prompt.
            restart(&state, &task);
            assert!(!reload(&state, &task.id).steerable);
        });
    }

    #[test]
    fn messages_sent_while_preparing_go_once_the_agent_starts() {
        crate::testing::run(async || {
            let (state, task, run) = running(true);
            state.db().execute("UPDATE runs SET status='preparing' WHERE id=?1", [&run.id]).unwrap();
            let dir = runs::run_dir(&state, &run.id);
            std::fs::remove_dir_all(&dir).unwrap();
            let t = send(&state, &task.id, "early").unwrap();
            assert!(!t.steering[0].written);
            // `started`, once the shim is up.
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("input.jsonl"), "").unwrap();
            let t = {
                let _runs = state.runs.lock().unwrap();
                write_steers(&state, &task.id).unwrap().unwrap()
            };
            assert!(t.steering[0].written);
            assert_eq!(input(&state, &run)[0]["message"]["content"], "early");
        });
    }

    #[test]
    fn queues_for_runs_that_cant_take_messages() {
        crate::testing::run(async || {
            // Started by an older build, whose agents read only their prompt.
            let (state, task, _run) = running(false);
            let t = send(&state, &task.id, "later").unwrap();
            assert_eq!((t.queued_message.as_deref(), t.steering.len()), (Some("later"), 0));
            // `/compact` can't go into a turn.
            let (state, task, run) = running(true);
            let t = send(&state, &task.id, "/compact").unwrap();
            assert_eq!((t.queued_message.as_deref(), t.steering.len()), (Some("/compact"), 0));
            assert!(input(&state, &run).is_empty());
        });
    }

    #[test]
    fn tells_agents_which_boards_they_reach() {
        let c = db::open(std::path::Path::new(":memory:")).unwrap();
        let [personal, work, lab] = ["personal", "work", "lab"].map(|n| db::insert_profile(&c, n, &[], None).unwrap());
        db::update_profile(&c, &work.id, &[("agent_access", serde_json::json!(["personal"]))]).unwrap();
        let note = profiles_note(&db::list_profiles(&c).unwrap(), &personal);
        assert!(note.contains("also reach these profiles' boards: work."), "{note}");
        assert!(note.contains("their projects aren't listed: lab."), "{note}");
        let note = profiles_note(&db::list_profiles(&c).unwrap(), &lab);
        assert!(!note.contains("also reach") && note.contains("personal, work"), "{note}");
    }

    #[test]
    fn an_archived_projects_agents_dont_start() {
        crate::testing::run(async || {
            crate::runs::TEST_CAN_RUN.set(true);
            let state = crate::testing::state();
            let p = db::insert_profile(&state.db(), "p", &[], None).unwrap();
            let np = db::NewProject { id: "pr", profile_id: &p.id, name: "Old", key: "OLD", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
            db::insert_project(&state.db(), np).unwrap();
            let t = db::NewTask { profile_id: &p.id, project_id: Some("pr"), kind: "task", title: "Fix it", description: "", status: "in_review", use_worktree: false, model: None, effort: None, claude_config_id: None };
            let task = db::insert_task(&state.db(), t).unwrap();
            db::update_task(&state.db(), &task.id, &[("session_id", serde_json::json!("sess"))]).unwrap();
            db::update_project(&state.db(), "pr", &[("archived_at", serde_json::json!("2026-01-01T00:00:00.000Z"))]).unwrap();
            // Neither a message (from the user or another agent) nor a compaction starts one.
            for err in [send(&state, &task.id, "Carry on").unwrap_err(), compact(&state, &task.id, "idle").unwrap_err()] {
                assert!(err.1.contains("\"Old\" is archived"), "{}", err.1);
            }
            assert!(!state.is_running(&task.id));
            assert!(!db::get_task(&state.db(), &task.id).unwrap().unwrap().running);
            let runs: i64 = state.db().query_row("SELECT COUNT(*) FROM runs WHERE task_id=?1", [&task.id], |r| r.get(0)).unwrap();
            assert_eq!(runs, 0, "no run was registered");
            crate::runs::TEST_CAN_RUN.set(false);
        })
    }

    #[test]
    fn an_archived_projects_queued_messages_wait_for_it() {
        crate::testing::run(async || {
            crate::runs::TEST_CAN_RUN.set(true);
            let state = crate::testing::state();
            let p = db::insert_profile(&state.db(), "p", &[], None).unwrap();
            let np = db::NewProject { id: "pr", profile_id: &p.id, name: "Old", key: "OLD", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
            db::insert_project(&state.db(), np).unwrap();
            let new = |title: &str| {
                let t = db::NewTask { profile_id: &p.id, project_id: Some("pr"), kind: "task", title, description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
                db::insert_task(&state.db(), t).unwrap()
            };
            let (first, waits, blocked) = (new("First"), new("Waits"), new("Blocked"));
            for t in [&waits, &blocked] {
                state.update_task(&t.id, &[("depends_on", json!([first.id]))]).unwrap();
            }
            // One already waiting for its dependency, with what it was asked queued.
            send(&state, &waits.id, "Do the thing").unwrap();
            let get = |id: &str| db::get_task(&state.db(), id).unwrap().unwrap();
            assert!(get(&waits.id).waiting);
            db::update_project(&state.db(), "pr", &[("archived_at", json!("2026-01-01T00:00:00.000Z"))]).unwrap();

            // A message behind dependencies is refused rather than queued where nothing sends it.
            let err = send(&state, &blocked.id, "Go").unwrap_err();
            assert!(err.1.contains("is archived"), "{}", err.1);
            let b = get(&blocked.id);
            assert_eq!((b.status.as_str(), b.waiting, b.queued_message), ("todo", false, None));

            // Its dependency merged, the waiting one keeps waiting with its message.
            state.update_task(&first.id, &[("status", json!("done"))]).unwrap();
            start_unblocked(&state, Some("pr"));
            let w = get(&waits.id);
            assert_eq!((w.waiting, w.status.as_str(), w.queued_message.as_deref()), (true, "in_progress", Some("Do the thing")));
            // A message to it now is refused, and leaves the queued one.
            assert!(send(&state, &waits.id, "And this").is_err());
            assert_eq!(get(&waits.id).queued_message.as_deref(), Some("Do the thing"));

            // Archived after start_unblocked picked it: it waits again, message and all.
            db::update_project(&state.db(), "pr", &[("archived_at", Value::Null)]).unwrap();
            db::queue(&state.db(), &blocked.id, db::Queued::new("Go", false)).unwrap();
            state.update_task(&blocked.id, &[("waiting", json!(true)), ("status", json!("in_progress"))]).unwrap();
            let picked = get(&blocked.id);
            db::update_project(&state.db(), "pr", &[("archived_at", json!("2026-01-02T00:00:00.000Z"))]).unwrap();
            start_waiting(&state, &picked);
            let b = get(&blocked.id);
            assert_eq!((b.waiting, b.status.as_str(), b.attention_reason, b.queued_message.as_deref()), (true, "in_progress", None, Some("Go")));
            crate::runs::TEST_CAN_RUN.set(false);
        })
    }

    #[test]
    fn a_queued_message_stays_when_its_run_cant_start() {
        crate::testing::run(async || {
            // This host can't run agents, which start_run finds after the queued message is taken.
            let state = crate::testing::state();
            let p = db::insert_profile(&state.db(), "p", &[], None).unwrap();
            let t = db::NewTask { profile_id: &p.id, project_id: None, kind: "scratch", title: "t", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
            let t = db::insert_task(&state.db(), t).unwrap();
            db::queue(&state.db(), &t.id, db::Queued::new("First", true)).unwrap();
            assert!(send(&state, &t.id, "Second").is_err());
            assert_eq!(db::take_queued(&state.db(), &t.id).unwrap(), Some(db::Queued::new("First", true)));
        })
    }

    #[test]
    fn starts_with_the_projects_instructions() {
        let c = db::open(std::path::Path::new(":memory:")).unwrap();
        let p = db::insert_profile(&c, "p", &[], None).unwrap();
        let np = db::NewProject { id: "pr", profile_id: &p.id, name: "x", key: "X", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
        let mut project = db::insert_project(&c, np).unwrap();
        let t = db::NewTask { profile_id: &p.id, project_id: Some("pr"), kind: "task", title: "Fix it", description: "It's broken.", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let task = db::insert_task(&c, t).unwrap();
        let text = start_prompt(&task, Some(&project), "");
        assert_eq!(text, format!("# X-1: Fix it\n\nIt's broken.\n\n---\n\n{}\n", crate::prompts::DEFAULT_START));
        project.start_prompt = Some("Write a plan and ask me about it first.".into());
        let text = start_prompt(&task, Some(&project), "Only the server.");
        assert!(text.ends_with("---\n\nWrite a plan and ask me about it first.\n\nOnly the server.\n"), "{text}");
        // A skill's command goes first, where Claude Code expands it, with the task as its arguments.
        let text = start_prompt(&task, Some(&project), " /code-review the server\n");
        assert_eq!(text, "/code-review the server\n\n# X-1: Fix it\n\nIt's broken.\n\n---\n\nWrite a plan and ask me about it first.\n");
        let text = start_prompt(&task, Some(&project), "/plugin:skill");
        assert!(text.starts_with("/plugin:skill\n\n# X-1"), "{text}");
        // A path isn't a command.
        let text = start_prompt(&task, Some(&project), "/home/me/x.log has the error");
        assert!(text.starts_with("# X-1") && text.ends_with("\n/home/me/x.log has the error\n"), "{text}");
        // Followed by what it's for elsewhere.
        let links = serde_json::json!([{"provider": "asana", "id": "12", "url": "https://app.asana.com/0/1/12", "title": "Fix signup"}]);
        let task = db::update_task(&c, &task.id, &[("external_links", links)]).unwrap().unwrap();
        let text = start_prompt(&task, Some(&project), "");
        assert!(text.starts_with("# X-1: Fix it\n\nIt's broken.\n\nThis task is for:\n- Asana task: Fix signup (https://app.asana.com/0/1/12)\n\n---\n"), "{text}");
    }

    #[test]
    fn a_group_task_is_told_its_groups_projects() {
        let c = db::open(std::path::Path::new(":memory:")).unwrap();
        let p = db::insert_profile(&c, "p", &[], None).unwrap();
        let np = db::NewProject { id: "pr", profile_id: &p.id, name: "Web", key: "WEB", repo_path: "/src/web", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
        db::insert_project(&c, np).unwrap();
        db::update_project(&c, "pr", &[("group_name", serde_json::json!("Shop"))]).unwrap();
        let t = db::NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "Plan it", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let task = db::insert_group_task(&c, t, "Shop").unwrap();
        let group = db::group_projects(&c, &p.id, "Shop").unwrap();
        let text = system_prompt(&task, None, None, &group, None, None, true);
        assert!(text.contains("task G-1 (\"Plan it\"") && text.contains("Web (key WEB, id pr, repository /src/web)"), "{text}");
        assert!(start_prompt(&task, None, "").starts_with("# G-1: Plan it\n"));
    }

    #[test]
    fn a_task_on_github_is_told_to_open_a_pull_request() {
        let c = db::open(std::path::Path::new(":memory:")).unwrap();
        let p = db::insert_profile(&c, "p", &[], None).unwrap();
        let np = db::NewProject { id: "pr", profile_id: &p.id, name: "Web", key: "WEB", repo_path: "/src/web", scratch_path: "/s", worktrees_root: "/w", base_branch: Some("main"), use_worktrees: true };
        let project = db::insert_project(&c, np).unwrap();
        let t = db::NewTask { profile_id: &p.id, project_id: Some("pr"), kind: "task", title: "Fix it", description: "", status: "todo", use_worktree: true, model: None, effort: None, claude_config_id: None };
        let mut task = db::insert_task(&c, t).unwrap();
        (task.worktree_path, task.branch) = (Some("/w/1-fix-it".into()), Some("ia/web-1-fix-it".into()));
        // Pushed to a mirror: gh is told which repository, as it would pick the fetch remote's.
        let gh = worktree::Github { remote: "origin".into(), repo: "o/web-mirror".into() };
        let text = system_prompt(&task, Some(&project), None, &[], None, Some(&gh), false);
        assert!(text.contains("Do not merge or switch branches unless asked."), "{text}");
        assert!(text.contains("on GitHub (o/web-mirror)") && text.contains("`git push -u origin ia/web-1-fix-it`"), "{text}");
        assert!(text.contains("into `main` in o/web-mirror (`gh pr create --repo o/web-mirror --head ia/web-1-fix-it --base main`"), "{text}");
        // With the gh server, which turns away gh in Bash, through its tools.
        let text = system_prompt(&task, Some(&project), None, &[], None, Some(&gh), true);
        assert!(text.contains("in o/web-mirror (the gh tools' pr_create with repo `o/web-mirror`, head `ia/web-1-fix-it` and base `main`)"), "{text}");
        assert!(!text.contains("gh pr create"), "{text}");

        // Without GitHub (or a branch of its own), it leaves pushing to the user.
        let text = system_prompt(&task, Some(&project), None, &[], None, None, false);
        assert!(text.contains("Do not push, merge, or switch branches unless asked.") && !text.contains("open a pull request"), "{text}");
        task.branch = None;
        assert!(!system_prompt(&task, Some(&project), None, &[], None, Some(&gh), false).contains("open a pull request"));
        // Every agent is told it can wait on one, though.
        assert!(text.contains("For CI or reviews on a pull request, give it the `pull_request`"), "{text}");
    }

    #[test]
    fn the_github_account_is_the_projects_or_the_profiles() {
        let c = db::open(std::path::Path::new(":memory:")).unwrap();
        let mut profile = db::insert_profile(&c, "p", &[], None).unwrap();
        let np = db::NewProject { id: "pr", profile_id: &profile.id, name: "Web", key: "WEB", repo_path: "/src/web", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
        let mut project = db::insert_project(&c, np).unwrap();
        assert_eq!(github_account(Some(&project), &profile), None);
        profile.github_account = Some("me".into());
        assert_eq!(github_account(Some(&project), &profile).as_deref(), Some("me"));
        assert_eq!(github_account(None, &profile).as_deref(), Some("me"));
        project.github_account = Some("work-me".into());
        assert_eq!(github_account(Some(&project), &profile).as_deref(), Some("work-me"));
        project.github_account = Some(" ".into());
        assert_eq!(github_account(Some(&project), &profile).as_deref(), Some("me"));
        assert!(gh_note(Some("work-me")).contains("as the GitHub account work-me") && !gh_note(None).contains("account"));
    }

    #[test]
    fn the_gh_hook_runs_this_binary() {
        let settings: Value = serde_json::from_str(&gh_hook_settings(std::path::Path::new("/opt/it's here/huntaway"))).unwrap();
        let hook = &settings["hooks"]["PreToolUse"][0];
        assert_eq!(hook["matcher"], "Bash");
        assert_eq!(hook["hooks"][0]["command"], r"'/opt/it'\''s here/huntaway' gh-hook");
        // A project that turns the gh server off, or has its own, gets neither.
        let mut tools = crate::agent_tools::RunTools::default();
        assert!(uses_gh_server(&tools));
        tools.disallowed.push("mcp__gh".into());
        assert!(!uses_gh_server(&tools));
        tools.disallowed.clear();
        tools.mcp_servers.insert("gh".into(), json!({}));
        assert!(!uses_gh_server(&tools));
    }

    #[test]
    fn a_plan_task_is_told_where_to_write_its_plan() {
        let c = db::open(std::path::Path::new(":memory:")).unwrap();
        let p = db::insert_profile(&c, "p", &[], None).unwrap();
        let np = db::NewProject { id: "pr", profile_id: &p.id, name: "Web", key: "WEB", repo_path: "/src/web", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
        let mut project = db::insert_project(&c, np).unwrap();
        project.start_prompt = Some("Write a failing test first.".into());
        let t = db::NewTask { profile_id: &p.id, project_id: Some("pr"), kind: "task", title: "Plan search", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let task = db::insert_task(&c, t).unwrap();
        let task = db::update_task(&c, &task.id, &[("task_type", serde_json::json!("plan"))]).unwrap().unwrap();
        let text = system_prompt(&task, Some(&project), None, &[], Some("/data/documents/t/plan.html"), None, true);
        assert!(text.contains("task WEB-1 (\"Plan search\"") && text.contains("Write it to /data/documents/t/plan.html"), "{text}");
        assert!(text.contains("repository /src/web, which you can read") && !text.contains("worktree"), "{text}");
        // It's told about the plan theme's components.
        assert!(text.contains("<ia-steps>") && text.contains("<ia-html><template>"), "{text}");
        // The project's start instructions are for its code tasks.
        assert!(start_prompt(&task, Some(&project), "").contains(crate::prompts::DEFAULT_START));
    }

    #[test]
    fn a_scratch_task_is_told_it_has_no_repository() {
        let c = db::open(std::path::Path::new(":memory:")).unwrap();
        let p = db::insert_profile(&c, "p", &[], None).unwrap();
        let t = db::NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "Ask", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let mut task = db::insert_scratch_task(&c, t).unwrap();
        let text = system_prompt(&task, None, None, &[], None, None, true);
        assert!(text.contains("scratch task S-1 (\"Ask\"") && text.contains("isn't in a project or a repository"), "{text}");
        assert!(text.contains("the task's own folder") && text.contains("write freely") && !text.contains("worktree"), "{text}");
        // One from a scratch chat isn't told its (maybe shared) folder is free to write in.
        task.work_dir = Some("/data/profiles/p/scratch".into());
        let text = system_prompt(&task, None, None, &[], None, None, true);
        assert!(text.contains("a scratch folder") && !text.contains("write freely"), "{text}");
        assert!(start_prompt(&task, None, "").starts_with("# S-1: Ask"));
    }

    #[test]
    fn a_scratch_task_in_a_project_reads_it() {
        let c = db::open(std::path::Path::new(":memory:")).unwrap();
        let p = db::insert_profile(&c, "p", &[], None).unwrap();
        let np = db::NewProject { id: "pr", profile_id: &p.id, name: "Web", key: "WEB", repo_path: "/src/web", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: true };
        let project = db::insert_project(&c, np).unwrap();
        let t = |title| db::NewTask { profile_id: &p.id, project_id: Some("pr"), kind: "task", title, description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let mut sp = db::insert_task(&c, t("Search")).unwrap();
        (sp.subproject, sp.branch, sp.worktree_path, sp.worktree_state) = (true, Some("ia/web-1-search".into()), Some("/w/1".into()), "ready".into());
        let task = db::insert_task(&c, t("Ask")).unwrap();
        let task = db::update_task(&c, &task.id, &[("task_type", serde_json::json!("scratch"))]).unwrap().unwrap();
        let text = system_prompt(&task, Some(&project), None, &[], None, None, true);
        assert!(text.contains("scratch task WEB-2 (\"Ask\"") && text.contains("in the project Web") && text.contains("repository /src/web, which you can read"), "{text}");
        assert!(text.contains("Don't change the repository") && !text.contains("subproject") && !text.contains("isn't in a project"), "{text}");
        // In a subproject, it's told about the subproject's branch and worktree.
        let text = system_prompt(&task, Some(&project), Some(&sp), &[], None, None, true);
        assert!(text.contains("part of the subproject WEB-1 (\"Search\"), whose branch `ia/web-1-search`") && text.contains("worktree at /w/1, which you can read"), "{text}");
        assert!(start_prompt(&task, Some(&project), "").starts_with("# WEB-2: Ask"));
    }

    #[test]
    fn in_auto_mode_claude_reviews_waits_itself() {
        let args = |mode: &str, review: bool| {
            let mut a: Vec<String> = ["-p", "--permission-mode", mode, "--allowedTools"].map(String::from).into();
            a.extend(board_tools_allowed(mode, review));
            a.extend(["mcp__gh__pr_view", "--disallowedTools", "mcp__gh__pr_merge", "--add-dir", "/a"].map(String::from));
            a
        };
        for mode in ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"] {
            assert_eq!(board_tools_allowed(mode, false), ["mcp__huntaway"]);
            assert!(!approves_own_waits(&args(mode, false)), "{mode}");
        }
        for review in [false, true] {
            let auto = board_tools_allowed("auto", review);
            assert!(auto.contains(&"mcp__huntaway__get_task".into()) && auto.contains(&"mcp__huntaway__permission_prompt".into()));
            assert!(auto.contains(&"mcp__huntaway__get_task_field".into()));
            assert!(!auto.iter().any(|t| t == "mcp__huntaway__wait" || t == "mcp__huntaway"), "{auto:?}");
            assert_eq!(auto.contains(&"mcp__huntaway__submit_review".into()), review);
            assert!(approves_own_waits(&args("auto", review)));
        }
        // Runs started by an older build had every board tool pre-approved, under the board's
        // current or (before the rename) old server name, whatever their mode.
        let old = |mode: &str, allowed: &str| -> Vec<String> {
            ["-p", "--permission-mode", mode, "--allowedTools", allowed, "mcp__gh__pr_view", "--add-dir", "/a"].map(String::from).into()
        };
        for mode in ["auto", "default", "dontAsk", "plan"] {
            for allowed in ["mcp__huntaway", "mcp__issue_agent", "mcp__issue_agent__wait", "mcp__gh__pr_list,mcp__issue_agent"] {
                assert!(!approves_own_waits(&old(mode, allowed)), "{mode} {allowed}");
            }
        }
        // Only auto mode leaves waits to Claude, however the board tools are listed.
        assert!(approves_own_waits(&old("auto", "mcp__huntaway__get_task")));
        for mode in ["default", "dontAsk", "plan", "acceptEdits", "bypassPermissions"] {
            assert!(!approves_own_waits(&old(mode, "mcp__huntaway__get_task")), "{mode}");
        }
        // A Codex run's arguments are the adapter's.
        assert!(!approves_own_waits(&["codex-run".into(), "/runs/r/codex.json".into()]));
        assert!(!approves_own_waits(&[]));
    }

    /// Run `b` starts on `task`, asks permission (as call `call`) and waits.
    fn start_next(state: &Shared, task_id: &str, call: &str) -> String {
        let b = db::insert_run(&state.db(), task_id, "prompt").unwrap();
        state.runs.lock().unwrap().insert(task_id.to_string(), RunHandle { run_id: b.id.clone(), cancel: None });
        state.update_task(task_id, &[("running", json!(true)), ("status", json!("in_progress"))]).unwrap();
        ask(state, task_id, &b.id, call);
        let wait = json!({"since": "", "until": "", "call_id": format!("{call}-wait"), "run_id": b.id});
        state.update_task(task_id, &[("agent_wait", wait)]).unwrap();
        b.id
    }

    /// Run `run_id` asks permission, as call `call`.
    fn ask(state: &Shared, task_id: &str, run_id: &str, call: &str) {
        state
            .db()
            .execute(
                "INSERT INTO mcp_calls (id,run_id,task_id,tool,args,status,created_at) VALUES (?1,?2,?3,'permission_prompt','{}','executing','')",
                [call, run_id, task_id],
            )
            .unwrap();
        state
            .db()
            .execute(
                "INSERT INTO permission_requests (id,task_id,message_id,tool_name,input,status,created_at,call_id) VALUES (?1,?2,0,'Bash','{}','pending','',?1)",
                [call, task_id],
            )
            .unwrap();
    }

    fn prompt_status(state: &Shared, call: &str) -> String {
        state.db().query_row("SELECT status FROM permission_requests WHERE call_id=?1", [call], |r| r.get(0)).unwrap()
    }

    #[test]
    fn a_run_that_starts_as_the_last_one_ends_keeps_the_task_running() {
        crate::testing::run(async || {
            let (state, task, run) = running(false);
            // A message starts the next run once the last one's handle is gone, before its end is written.
            let next = std::rc::Rc::new(std::cell::RefCell::new(String::new()));
            crate::testing::when("finish:released", {
                let (st, id, next) = (state.clone(), task.id.clone(), next.clone());
                move || *next.borrow_mut() = start_next(&st, &id, "b1")
            });
            finish(&state, &run.id, Outcome::Ok);
            let t = reload(&state, &task.id);
            assert_eq!((t.running, t.status.as_str(), t.attention_reason), (true, "in_progress", None));
            assert_eq!(state.runs.lock().unwrap().get(&task.id).map(|h| h.run_id.clone()), Some(next.borrow().clone()));
            // Its prompt and wait are left alone.
            assert_eq!(prompt_status(&state, "b1"), "pending");
            assert_eq!(t.agent_wait.map(|w| w.run_id), Some(next.borrow().clone()));

            // Started before the last one's end is handled at all (a stop, then a message): the
            // last one's prompt expires, the next one's doesn't.
            let (state, task, run) = running(false);
            ask(&state, &task.id, &run.id, "a2");
            state.runs.lock().unwrap().remove(&task.id);
            let next = start_next(&state, &task.id, "b2");
            finish(&state, &run.id, Outcome::Cancelled);
            let t = reload(&state, &task.id);
            assert_eq!((t.running, t.status.as_str()), (true, "in_progress"));
            assert_eq!((prompt_status(&state, "a2").as_str(), prompt_status(&state, "b2").as_str()), ("expired", "pending"));
            assert_eq!(t.agent_wait.map(|w| w.run_id), Some(next.clone()));
            // Its own end clears them.
            finish(&state, &next, Outcome::Ok);
            let t = reload(&state, &task.id);
            assert_eq!((t.running, prompt_status(&state, "b2").as_str(), t.agent_wait), (false, "expired", None));
        })
    }

    #[test]
    fn a_reviewer_that_exits_late_doesnt_end_the_next_round() {
        crate::testing::run(async || {
            let (s, thread, run) = running(false);
            let dir = std::env::temp_dir().join(format!("ia-review-round-{}", crate::util::new_id()));
            std::fs::create_dir_all(&dir).unwrap();
            let git = |args: &[&str]| assert!(std::process::Command::new("git").arg("-C").arg(&dir).args(args).status().unwrap().success());
            git(&["init", "-q"]);
            git(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "work"]);
            let path = crate::util::path_str(&dir);
            let np = db::NewProject { id: "pr", profile_id: &thread.profile_id, name: "x", key: "X", repo_path: &path, scratch_path: &path, worktrees_root: &path, base_branch: None, use_worktrees: true };
            db::insert_project(&s.db(), np).unwrap();
            let t = db::NewTask { profile_id: &thread.profile_id, project_id: Some("pr"), kind: "task", title: "parent", description: "", status: "in_review", use_worktree: false, model: None, effort: None, claude_config_id: None };
            let parent = db::insert_task(&s.db(), t).unwrap();
            s.update_task(&parent.id, &[("worktree_path", json!(path)), ("worktree_state", json!("ready")), ("branch", json!("ia/x"))]).unwrap();
            s.db().execute("UPDATE tasks SET kind='review', parent_id=?1, project_id='pr' WHERE id=?2", [&parent.id, &thread.id]).unwrap();
            s.db().execute("UPDATE runs SET kind='review' WHERE id=?1", [&run.id]).unwrap();
            // A round from before reviewers' runs were kept.
            let part = db::ReviewerRun { thread_id: thread.id.clone(), state: "running".into(), ..Default::default() };
            let old = db::Review { thread_id: thread.id.clone(), state: "running".into(), reviewers: vec![part], ..Default::default() };
            s.update_task(&parent.id, &[("review", json!(old))]).unwrap();
            // The user stops it and starts another as soon as the reviewer's handle goes, before its end is recorded.
            crate::review::stop(&s, &parent.id);
            crate::testing::when("finish:released", {
                let (s, parent) = (s.clone(), parent.clone());
                move || {
                    crate::testing::run(async move || {
                        runs::TEST_CAN_RUN.set(true);
                        crate::review::start(&s, &parent.id, true).await.map_err(|e| e.1).unwrap().unwrap();
                    })
                }
            });
            finish(&s, &run.id, Outcome::Cancelled);
            let newer = s.runs.lock().unwrap().get(&thread.id).unwrap().run_id.clone();
            assert_ne!(newer, run.id);
            let r = reload(&s, &parent.id).review.unwrap();
            assert_eq!((r.state.as_str(), r.reviewers[0].state.as_str(), r.reviewers[0].after_run.as_deref()), ("running", "running", Some(run.id.as_str())));
            // Its own end does.
            finish(&s, &newer, Outcome::Cancelled);
            assert_eq!(reload(&s, &parent.id).review.unwrap().state, "stopped");
            std::fs::remove_dir_all(&dir).unwrap();
        });
    }

    #[test]
    fn a_message_queued_as_a_run_ends_is_sent_after_a_restart() {
        crate::testing::run(async || {
            runs::TEST_CAN_RUN.set(true);
            let (state, task, run) = running(false);
            state.update_task(&task.id, &[("steerable", json!(false))]).unwrap();
            send(&state, &task.id, "and then this").unwrap();
            // The server stops once the run is recorded as ended, before the message is sent.
            crate::testing::when("finish:exited", || panic!("the server stopped"));
            assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| finish(&state, &run.id, Outcome::Ok))).is_err());
            assert_eq!(reload(&state, &task.id).queued_message.as_deref(), Some("and then this"));
            load_active(&state).unwrap();
            let t = reload(&state, &task.id);
            assert!(state.is_running(&task.id));
            assert_eq!((t.running, t.queued_message, t.status.as_str()), (true, None, "in_progress"));
        });
    }

    #[test]
    fn a_run_that_cant_start_as_the_last_one_ends_leaves_the_task_idle() {
        crate::testing::run(async || {
            runs::TEST_CAN_RUN.set(true);
            // The next run is registered once the last one's handle is gone, but can't be marked running.
            let fail_next = |state: &Shared, task: &Task| {
                let (state, task) = (state.clone(), task.clone());
                move || {
                    state.db().execute_batch("CREATE TRIGGER no_start BEFORE UPDATE OF running ON tasks WHEN NEW.running=1 BEGIN SELECT RAISE(ABORT, 'disk full'); END").unwrap();
                    assert!(send(&state, &task.id, "next").unwrap_err().1.contains("disk full"));
                    state.db().execute_batch("DROP TRIGGER no_start").unwrap();
                }
            };
            let (state, task, run) = running(false);
            crate::testing::when("finish:released", fail_next(&state, &task));
            finish(&state, &run.id, Outcome::Ok);
            let t = reload(&state, &task.id);
            // (Its sender hears that it failed.)
            assert_eq!((t.running, t.status.as_str()), (false, "in_review"));
            assert!(!state.is_running(&task.id));
            // Or once the last one has ended, leaving its end to the next.
            let (state, task, run) = running(false);
            let next = std::rc::Rc::new(std::cell::RefCell::new(None));
            crate::testing::when("finish:released", {
                let (state, task, next) = (state.clone(), task.clone(), next.clone());
                move || {
                    let b = db::insert_run(&state.db(), &task.id, "prompt").unwrap();
                    state.runs.lock().unwrap().insert(task.id.clone(), RunHandle { run_id: b.id.clone(), cancel: None });
                    *next.borrow_mut() = Some(b);
                }
            });
            finish(&state, &run.id, Outcome::Ok);
            assert!(reload(&state, &task.id).running);
            abandon(&state, &next.borrow().clone().unwrap(), None);
            assert!(!reload(&state, &task.id).running);
            assert!(!state.is_running(&task.id));
        });
    }

    #[test]
    fn a_queued_message_another_run_sent_isnt_sent_again() {
        crate::testing::run(async || {
            runs::TEST_CAN_RUN.set(true);
            let (s, task, a) = running(false);
            send(&s, &task.id, "queued").unwrap();
            // Once A's handle goes, another message starts B with what's queued, and B ends, before A carries on.
            crate::testing::when("finish:released", {
                let (s, task) = (s.clone(), task.clone());
                move || {
                    send(&s, &task.id, "and this").unwrap();
                    let b = s.runs.lock().unwrap().get(&task.id).unwrap().run_id.clone();
                    finish(&s, &b, Outcome::Ok);
                }
            });
            finish(&s, &a.id, Outcome::Ok);
            let t = reload(&s, &task.id);
            let count: i64 = s.db().query_row("SELECT COUNT(*) FROM runs WHERE task_id=?1", [&task.id], |r| r.get(0)).unwrap();
            assert_eq!((t.running, t.status.as_str(), t.queued_message, count), (false, "in_review", None, 2));
            assert!(!s.is_running(&task.id));
            let events: i64 = s.db().query_row("SELECT COUNT(*) FROM messages WHERE task_id=?1 AND data LIKE '%queued message%'", [&task.id], |r| r.get(0)).unwrap();
            assert_eq!(events, 0);
        });
    }

    #[test]
    fn an_agent_that_starts_late_is_stopped_after_a_restart() {
        use std::os::unix::process::CommandExt;
        let (tx, rx) = std::sync::mpsc::channel();
        crate::testing::run(async move || {
            let (s, _, run) = running(true);
            std::fs::write(runs::run_dir(&s, &run.id).join("spec.json"), "{}").unwrap();
            launch_ended(&s, &run, Err(anyhow!("the agent didn't start in time")));
            tx.send((s, run)).unwrap();
        });
        // The server stops (with its watch for the agent), and ia-shim starts the agent once it's back.
        let (s, run) = rx.recv().unwrap();
        crate::testing::run(async move || {
            load_active(&s).unwrap();
            let mut agent = std::process::Command::new("sleep").arg("30").process_group(0).spawn().unwrap();
            std::fs::write(runs::run_dir(&s, &run.id).join("pid"), agent.id().to_string()).unwrap();
            let since = std::time::Instant::now();
            while agent.try_wait().unwrap().is_none() && since.elapsed() < std::time::Duration::from_secs(3) {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            let stopped = agent.try_wait().unwrap().is_some();
            if !stopped {
                unsafe { libc::kill(-(agent.id() as i32), libc::SIGKILL) };
                agent.wait().unwrap();
            }
            assert!(stopped, "the agent was left running");
            assert!(input_closed(&s, &run));
            // Done with it: a later restart doesn't watch it again.
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            assert!(!runs::run_dir(&s, &run.id).join("reap").exists());
        });
    }

    #[test]
    fn an_agent_being_stopped_is_killed_after_a_restart() {
        use std::os::unix::process::CommandExt;
        let (tx, rx) = std::sync::mpsc::channel();
        crate::testing::run(async move || {
            let (s, _, run) = running(true);
            let dir = runs::run_dir(&s, &run.id);
            std::fs::write(dir.join("spec.json"), "{}").unwrap();
            launch_ended(&s, &run, Err(anyhow!("the agent didn't start in time")));
            // The agent starts late, and ignores being asked to stop.
            let ready = dir.join("ready");
            let script = "import signal, sys, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); open(sys.argv[1], 'w').close(); time.sleep(30)";
            let agent = std::process::Command::new("python3").args(["-c", script]).arg(&ready).process_group(0).spawn().unwrap();
            let since = std::time::Instant::now();
            while !ready.exists() && since.elapsed() < std::time::Duration::from_secs(3) {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            std::fs::write(dir.join("pid"), agent.id().to_string()).unwrap();
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            assert!(dir.join("reap").exists());
            tx.send((s, run, agent)).unwrap();
        });
        // The server stops before killing it.
        let (s, run, mut agent) = rx.recv().unwrap();
        crate::testing::run(async move || {
            assert!(agent.try_wait().unwrap().is_none());
            load_active(&s).unwrap();
            let since = std::time::Instant::now();
            while agent.try_wait().unwrap().is_none() && since.elapsed() < std::time::Duration::from_secs(5) {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            let stopped = agent.try_wait().unwrap().is_some();
            if !stopped {
                unsafe { libc::kill(-(agent.id() as i32), libc::SIGKILL) };
                agent.wait().unwrap();
            }
            assert!(stopped, "the agent was left running");
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            assert!(!runs::run_dir(&s, &run.id).join("reap").exists());
        });
    }

    #[test]
    fn a_queued_message_taken_back_as_its_run_ends_doesnt_wait_for_dependencies() {
        crate::testing::run(async || {
            runs::TEST_CAN_RUN.set(true);
            let (s, task, run) = running(false);
            let np = db::NewProject { id: "pr", profile_id: &task.profile_id, name: "x", key: "X", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
            db::insert_project(&s.db(), np).unwrap();
            let nt = db::NewTask { profile_id: &task.profile_id, project_id: Some("pr"), kind: "task", title: "dependency", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
            let dependency = db::insert_task(&s.db(), nt).unwrap();
            s.db().execute("UPDATE tasks SET project_id='pr' WHERE id=?1", [&task.id]).unwrap();
            s.update_task(&task.id, &[("depends_on", json!([dependency.id]))]).unwrap();
            send(&s, &task.id, "queued").unwrap();
            // The user takes the message back as the run ends.
            crate::testing::when("finish:released", {
                let (s, task) = (s.clone(), task.clone());
                move || {
                    unqueue(&s, &task.id).unwrap();
                }
            });
            finish(&s, &run.id, Outcome::Ok);
            let t = reload(&s, &task.id);
            assert_eq!((t.waiting, t.running, t.status.as_str(), t.queued_message), (false, false, "in_review", None));
            // Nothing starts once the dependency is merged.
            s.update_task(&dependency.id, &[("status", json!("done"))]).unwrap();
            start_unblocked(&s, Some("pr"));
            let count: i64 = s.db().query_row("SELECT COUNT(*) FROM runs WHERE task_id=?1", [&task.id], |r| r.get(0)).unwrap();
            assert_eq!(count, 1);
            assert!(!s.is_running(&task.id));
        });
    }

    #[test]
    fn an_agent_launched_just_before_a_restart_is_stopped() {
        crate::testing::run(async || {
            use std::os::unix::process::CommandExt;
            // ia-shim was launched as the server stopped, and hasn't written its output yet.
            let (s, task, run) = running(true);
            let dir = runs::run_dir(&s, &run.id);
            std::fs::remove_file(dir.join("out.jsonl")).unwrap();
            std::fs::write(dir.join("spec.json"), "{}").unwrap();
            s.runs.lock().unwrap().clear();
            load_active(&s).unwrap();
            let t = reload(&s, &task.id);
            assert_eq!((t.running, t.status.as_str()), (false, "needs_attention"));
            assert!(input_closed(&s, &run));
            // Then it starts the agent.
            let mut agent = std::process::Command::new("sleep").arg("30").process_group(0).spawn().unwrap();
            std::fs::write(dir.join("pid"), agent.id().to_string()).unwrap();
            let since = std::time::Instant::now();
            while agent.try_wait().unwrap().is_none() && since.elapsed() < std::time::Duration::from_secs(3) {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            let stopped = agent.try_wait().unwrap().is_some();
            if !stopped {
                unsafe { libc::kill(-(agent.id() as i32), libc::SIGKILL) };
                agent.wait().unwrap();
            }
            assert!(stopped, "the agent was left running");
        });
    }

    #[test]
    fn a_run_that_cant_be_recorded_isnt_left_running() {
        crate::testing::run(async || {
            runs::TEST_CAN_RUN.set(true);
            let state = crate::testing::state();
            let p = db::insert_profile(&state.db(), "p", &[], None).unwrap();
            let t = db::NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "t", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
            let task = db::insert_task(&state.db(), t).unwrap();
            let active = |id: &str| state.db().query_row("SELECT COUNT(*) FROM runs WHERE task_id=?1 AND status != 'exited'", [id], |r| r.get::<_, i64>(0)).unwrap();
            db::queue(&state.db(), &task.id, db::Queued::new("queued", false)).unwrap();
            let err = start_run(&state, &task.id, db::Queued::new("go", false), "prompt", Take::Ahead, |_, _, _| Err(anyhow!("disk full"))).unwrap_err();
            assert!(err.1.contains("disk full"), "{}", err.1);
            assert!(!state.is_running(&task.id));
            assert_eq!(active(&task.id), 0);
            let t = reload(&state, &task.id);
            assert_eq!((t.running, t.queued_message.as_deref()), (false, Some("queued")));
            // Deleted meanwhile: an error, not a panic, and nothing left behind.
            let err = start_run(&state, &task.id, db::Queued::new("go", false), "prompt", Take::Ahead, |c, t, _| {
                c.execute("DELETE FROM tasks WHERE id=?1", [&t.id])?;
                Ok(Vec::new())
            })
            .unwrap_err();
            assert_eq!(err.0, axum::http::StatusCode::NOT_FOUND);
            assert!(!state.is_running(&task.id));
            runs::TEST_CAN_RUN.set(false);
        })
    }

    #[test]
    fn a_queued_message_survives_a_crash_as_its_run_ends() {
        crate::testing::run(async || {
            let (state, task, run) = running(false);
            state.update_task(&task.id, &[("steerable", json!(false))]).unwrap();
            send(&state, &task.id, "and then this").unwrap();
            assert_eq!(reload(&state, &task.id).queued_message.as_deref(), Some("and then this"));
            // The server goes down (a crash, or a restart's exec) as the run ends.
            crate::testing::when("finish:released", || panic!("the server stopped"));
            let crashed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| finish(&state, &run.id, Outcome::Ok)));
            assert!(crashed.is_err());
            assert_eq!(reload(&state, &task.id).queued_message.as_deref(), Some("and then this"));
        })
    }

    #[test]
    fn a_launch_that_fails_leaves_no_agent_behind() {
        crate::testing::run(async || {
            use std::os::unix::process::CommandExt;
            for outcome in [Err(anyhow!("the run did not start within 5s")), Ok(false)] {
                let stopped = outcome.is_ok();
                let (state, task, run) = running(true);
                let dir = runs::run_dir(&state, &run.id);
                std::fs::write(dir.join("spec.json"), "{}").unwrap();
                // Given up on (or stopped) before ia-shim had started the agent, which it does after.
                launch_ended(&state, &run, outcome);
                assert!(input_closed(&state, &run), "an agent that reads its input as it works isn't left waiting for more");
                let mut agent = std::process::Command::new("sleep").arg("30").process_group(0).spawn().unwrap();
                std::fs::write(dir.join("pid"), agent.id().to_string()).unwrap();
                let since = std::time::Instant::now();
                while agent.try_wait().unwrap().is_none() {
                    assert!(since.elapsed() < std::time::Duration::from_secs(3), "the agent was left running");
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
                let t = reload(&state, &task.id);
                assert!(!state.is_running(&task.id) && !t.running);
                assert_eq!(t.attention_reason.as_deref().map(|r| r.starts_with(if stopped { "Stopped" } else { "Run failed" })), Some(true));
            }
        })
    }
}
