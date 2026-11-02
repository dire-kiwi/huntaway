//! Messages for a task's agent while it runs: steering them into its turn, or queueing them for the
//! next run, which starts once this one ends.

use super::*;

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
pub(super) fn steer_or_queue(state: &Shared, task_id: &str, message: &db::Queued) -> ApiResult<Option<Task>> {
    let runs = state.runs.lock().unwrap();
    let Some(handle) = runs.get(task_id) else { return Ok(None) };
    let task = db::get_task(&state.db(), task_id)?.ok_or_else(|| ApiError::not_found("task"))?;
    let (text, from_agent) = (message.text.trim(), message.from_agent);
    if text.is_empty() {
        return Ok(Some(task));
    }
    let plan = task.kind == "task" && crate::documents::plan_command(text).is_some();
    let run = db::get_run(&state.db(), &handle.run_id)?.filter(|r| !is_compact(text) && !(plan && !writes_documents(&r.id)) && can_steer(state, r));
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

/// The runs that can write their task's own folder (see documents.rs), as they started with labels
/// or work in it. A `/plan` sent to any other run waits for the next instead: its sandbox (Codex's
/// writable roots, Claude Code's directories) may not let it write the plan.
static WRITE_DOCUMENTS: std::sync::Mutex<std::collections::BTreeSet<String>> = std::sync::Mutex::new(std::collections::BTreeSet::new());

pub(super) fn writes_documents(run_id: &str) -> bool {
    WRITE_DOCUMENTS.lock().unwrap_or_else(|e| e.into_inner()).contains(run_id)
}

pub(super) fn set_writes_documents(run_id: &str, writes: bool) {
    let mut runs = WRITE_DOCUMENTS.lock().unwrap_or_else(|e| e.into_inner());
    if writes { runs.insert(run_id.to_string()) } else { runs.remove(run_id) };
}

/// A stream-json user message, as the agent's input takes it.
pub(super) fn user_input(id: &str, text: &str) -> String {
    json!({"type": "user", "uuid": id, "message": {"role": "user", "content": text}}).to_string()
}

/// Write the steered messages the thread's run hasn't been sent yet to its input. Call with
/// the runs lock held.
pub(super) fn write_steers(state: &Shared, task_id: &str) -> Result<Option<Task>> {
    let Some(mut task) = db::get_task(&state.db(), task_id)? else { return Ok(None) };
    let mut wrote = false;
    // `/plan` (only steered into a run that can write the plan, see WRITE_DOCUMENTS): the run may
    // have started without the plan label, so its system prompt may not say how.
    let plan_file = crate::documents::path(state, &task, "plan").filter(|_| task.kind == "task").map(|p| path_str(&p));
    for s in task.steering.iter_mut().filter(|s| !s.written) {
        let plan = plan_file.as_deref().zip(crate::documents::plan_command(&s.text)).map(|(f, rest)| crate::documents::plan_prompt(f, rest, false));
        if !runs::write_input(state, &s.run_id, &user_input(&s.id, plan.as_deref().unwrap_or(&s.text)))? {
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
pub(super) fn steered(state: &Shared, run: &Run, id: &str) -> Result<()> {
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
    let new_turn: bool = state.db().query_row("SELECT between_turns FROM runs WHERE id=?1", [&run.id], |r| r.get(0))?;
    state.db().execute(
        "UPDATE runs SET attention=NULL, between_turns=0, stop_requested = CASE WHEN stop_requested=2 THEN 0 ELSE stop_requested END WHERE id=?1",
        [&run.id],
    )?;
    let mut msg = json!({"text": steer.text, "steered": true});
    if steer.from_agent {
        msg["from_agent"] = json!(true);
    }
    let message = state.add_message(task_id, "user", msg)?;
    if new_turn {
        state.db().execute("UPDATE runs SET turn_message_id=?1 WHERE id=?2", rusqlite::params![message.id, run.id])?;
    }
    if let Some(t) = task {
        state.emit_task(&t);
    }
    Ok(())
}

/// The agent ended a turn. Unless it has messages waiting, which start its next turn, its input
/// is closed so it exits and the run ends.
pub(super) fn turn_ended(state: &Shared, run: &Run) {
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
pub(super) fn close_unless_taken_in(state: &Shared, run: &Run, waiting: Vec<String>) {
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
pub(super) fn requeue_steers(state: &Shared, task_id: &str, run_id: &str) -> Result<()> {
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
pub(super) fn has_queued(state: &Shared, runs: &std::collections::HashMap<String, RunHandle>, task_id: &str) -> bool {
    if runs.contains_key(task_id) {
        return false; // another run already took over the thread
    }
    db::get_task(&state.db(), task_id).ok().flatten().is_some_and(|t| t.queued_message.is_some_and(|q| !q.trim().is_empty()))
}

/// Send the message that was queued while the last run went. It stays queued until the next
/// run's start takes it (see `start_run`), so it isn't lost if the server stops in between.
/// Returns whether a new run started.
pub(super) fn send_queued(state: &Shared, task_id: &str) -> bool {
    match send_message(state, task_id, None, false, "prompt", None) {
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
