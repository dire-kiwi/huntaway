//! Agent runs. A run is `claude -p` (or Codex, see codex.rs) under an ia-shim (see `runs`); its output is followed from
//! disk (resuming from a saved offset after a restart), becomes thread messages, and its
//! outcome moves the task between board columns. Runs outlive server restarts: their durable
//! state is the `runs` table plus the run's files.

use anyhow::{Context, Result, anyhow};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::db::{self, Profile, Project, Run, Task};
use crate::permissions;
use crate::runs::{self, Launch};
use crate::state::{ApiError, ApiResult, RunHandle, Shared};
use crate::util::{path_str, truncate};
use crate::worktree;

mod access;
mod launch;
mod merge;
mod output;
mod prompt;
mod queue;
mod send;

pub use access::*;
use launch::*;
pub use merge::*;
pub use output::*;
pub use prompt::*;
pub use queue::*;
pub use send::*;

#[cfg(test)]
mod tests;

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
    // The message its first turn starts with (see checkpoints.rs).
    if let Some(m) = recorded.iter().find(|m| m.kind == "user") {
        let _ = state.db().execute("UPDATE runs SET turn_message_id=?1 WHERE id=?2", rusqlite::params![m.id, run.id]);
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
        fields.push(("limit_reset_at", Value::Null));
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
    set_writes_documents(&run.id, false);
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

/// Startup: resume following runs that were active when the server stopped.
pub fn load_active(state: &Shared) -> Result<()> {
    runs::resume_reaping(state);
    // Not in the loop head: that would hold the db lock for the whole loop.
    let active = db::active_runs(&state.db())?;
    for run in active {
        state.runs.lock().unwrap().insert(run.task_id.clone(), RunHandle { run_id: run.id.clone(), cancel: None });
        if runs::exists(state, &run.id) && runs::format(state, &run.id) > runs::RUN_FORMAT {
            // Written by a newer build (a downgrade); we can't follow it safely, so its agent is
            // stopped rather than left working (and calling the board's tools) unfollowed.
            runs::reap(state, &run.id);
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
            // Its turn ended, maybe before the end was seen to (see `turn_ended`): the messages it has been
            // sent start the next one, written now if they weren't, or else its input is closed so it exits.
            if between_turns && takes_input {
                let waiting: Vec<String> = {
                    let _runs = state.runs.lock().unwrap();
                    // Those it can't be sent are taken back once it doesn't take them in (see `finish`).
                    let task = write_steers(state, &run.task_id).unwrap_or_else(|e| {
                        tracing::error!(run = %run.id, "sending the agent the messages it was sent: {e:#}");
                        task
                    });
                    task.into_iter().flat_map(|t| t.steering).filter(|s| s.run_id == run.id).map(|s| s.id).collect()
                };
                if waiting.is_empty() {
                    runs::close_input(state, &run.id);
                } else {
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
