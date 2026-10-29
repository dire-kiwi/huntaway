//! The `wait` tool: an agent with nothing to do until something happens (the tasks it created
//! move on, CI finishes, a deploy comes up) waits in the tool call, rather than polling or
//! ending its turn. Meanwhile its task stays in its column, and the board shows it as waiting
//! rather than working (`Task::agent_wait`), with the reason the agent gave. This isn't
//! `Task::waiting`, which is a task queued for its dependencies before its agent starts.
//!
//! The call returns at the first of:
//! - the end of the wait period (`seconds`, `DEFAULT_SECS` unless given, at most `MAX_SECS`;
//!   `UNWATCHED_MAX_SECS`, by default and at most, for a wait with neither `tasks` nor a `command`);
//! - a change of status of one of the tasks it watches (`tasks`), or one being deleted;
//! - one of its subagents completing, failing or stopping;
//! - the exit of the shell command it was given (`command`), which runs in the agent's working
//!   directory while it waits: that can check on anything the board can't see (CI, a deploy, a
//!   file), by blocking until it's ready or looping until it is. It's approved like the agent's
//!   own Bash calls, and stopped with everything it started once the wait ends;
//! - a message sent to the agent (by the user or `send_to_task`), which it reads after the call;
//! - the run being stopped, or the task moved to another column, from the board or with
//!   `update_task` ("Needs attention" included; the board's own moves there and back for a
//!   subagent's permission prompt don't count);
//! - the run carrying on with other work: another board tool call (the helper runs calls
//!   concurrently, and a subagent's calls come through it too) or a tool call of the agent's
//!   own thread (Claude's stream-json or Codex's items). Subagents' tool calls don't count, so
//!   an agent can wait for its subagents, and neither do permission prompts, which subagents
//!   raise through the helper too (the agent's own tool calls show up before their prompts).
//!
//! The task shows as waiting exactly as long as the call: that ends when the call returns
//! (whichever way, errors included), and failing that (the agent gave up on the call) when its
//! turn or run ends. A server restart
//! doesn't start a wait over: the helper retries the same call, which carries on with the
//! stored wait and its deadline (running its command again from the start).

use std::collections::HashSet;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use rusqlite::OptionalExtension;
use serde_json::{Value, json};
use tokio::sync::broadcast::error::RecvError;

use crate::db::{self, AgentWait, Run, Task, WaitTask};
use crate::state::Shared;
use crate::util::{new_id, now};

pub const DEFAULT_SECS: u64 = 600;
pub const MAX_SECS: u64 = 3600;

/// The longest a wait with neither tasks to watch nor a command can be (and its default). Only
/// a message or a subagent can end one early, so agents waiting for CI or a deploy that way
/// would sleep on long after it's ready: they wait again (and check) every so often instead,
/// or give a command that exits once it's ready.
pub const UNWATCHED_MAX_SECS: u64 = 30;

/// How much of the end of a command's output the tool returns.
const OUTPUT_MAX: u64 = 4000;

/// How often a wait checks for what no task event announces (its run being stopped).
const TICK: Duration = Duration::from_millis(if cfg!(test) { 200 } else { 5000 });

/// Why a wait ended.
#[derive(Debug, PartialEq)]
pub enum Ended {
    /// The wait period is over.
    Timeout,
    /// These watched tasks (ids) changed status or were deleted.
    Tasks(Vec<String>),
    /// A subagent finished, with its id, status and summary.
    Subagent(Value),
    /// A message was sent to the agent.
    Message,
    /// The run was stopped.
    Stopped,
    /// The run carried on with other work (see `resumed`), or the wait was cleared under it.
    Resumed,
    /// The task was moved to this column.
    Moved(String),
    /// The wait's command exited, with this code (none if a signal ended it) and the end of
    /// its output.
    Command { code: Option<i32>, output: String },
}

impl Ended {
    pub fn name(&self) -> &'static str {
        match self {
            Ended::Timeout => "timeout",
            Ended::Tasks(_) => "tasks_changed",
            Ended::Subagent(_) => "subagent_finished",
            Ended::Message => "message",
            Ended::Stopped => "stopped",
            Ended::Resumed => "resumed",
            Ended::Moved(_) => "task_moved",
            Ended::Command { .. } => "command_exited",
        }
    }
}

/// The wait stored for the call `call_id`, if it's that call again (retried after a restart),
/// which carries on with it rather than starting over.
pub fn resuming<'a>(task: &'a Task, call_id: &str) -> Option<&'a AgentWait> {
    task.agent_wait.as_ref().filter(|w| w.call_id == call_id)
}

/// What a `wait` call asks for.
#[derive(Default)]
pub struct Request {
    pub reason: Option<String>,
    pub seconds: Option<f64>,
    /// The tasks to watch, with their keys and current status.
    pub tasks: Vec<WaitTask>,
    /// A shell command to run while waiting (already approved), in the agent's working directory.
    pub command: Option<String>,
}

/// Wait in the call `call_id` of `run` (on `task`) until the period is over or something
/// happens, showing the task as waiting meanwhile. A call that's `resuming` keeps the tasks and
/// command it started with. Returns how the wait ended and the tasks it watched.
pub async fn wait(s: &Shared, run: &Run, task: &Task, call_id: &str, req: Request) -> Result<(Ended, Vec<WaitTask>)> {
    // Subscribed before anything is read, so no change can slip in between.
    let events = s.events.subscribe();
    let wait = match resuming(task, call_id).cloned() {
        Some(w) => w,
        None => {
            let secs = period(&req).map_err(anyhow::Error::msg)?;
            let Request { reason, tasks, command, .. } = req;
            let until = Utc::now() + chrono::Duration::milliseconds((secs * 1000.0) as i64);
            let w = AgentWait {
                reason: reason.map(|r| r.trim().to_string()).filter(|r| !r.is_empty()),
                since: now(),
                until: until.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                tasks,
                command: command.map(|c| c.trim().to_string()).filter(|c| !c.is_empty()),
                call_id: call_id.to_string(),
                run_id: run.id.clone(),
                moved_to: None,
                subagent_finished: None,
            };
            s.update_task(&task.id, &[("agent_wait", json!(w))])?;
            w
        }
    };
    let ended = wait_out(s, task, &wait, events).await;
    clear(s, &task.id, Some(call_id));
    Ok((ended?, wait.tasks))
}

/// How long a new wait asked for lasts (in seconds), or why it doesn't start: see
/// `UNWATCHED_MAX_SECS`.
pub fn period(req: &Request) -> std::result::Result<f64, String> {
    let unwatched = req.tasks.is_empty() && req.command.as_deref().is_none_or(|c| c.trim().is_empty());
    let max = if unwatched { UNWATCHED_MAX_SECS } else { MAX_SECS };
    match req.seconds {
        Some(secs) if unwatched && secs > max as f64 => Err(format!(
            "The wait didn't start: without a command or tasks, a wait lasts {max} seconds at most, because little but a message or a \
             subagent can end it early, so it would carry on long after what you're waiting for is ready. Either give a command that \
             exits once it's ready (e.g. 'gh pr checks 12 --watch', or 'until curl -sf https://example.com/health; do sleep 15; done'), \
             list the tasks you're waiting for in tasks, or wait {max} seconds at a time, checking in between."
        )),
        Some(secs) => Ok(secs.clamp(1.0, max as f64)),
        None => Ok((if unwatched { UNWATCHED_MAX_SECS } else { DEFAULT_SECS }) as f64),
    }
}

async fn wait_out(s: &Shared, task: &Task, wait: &AgentWait, mut events: tokio::sync::broadcast::Receiver<Value>) -> Result<Ended> {
    let until = DateTime::parse_from_rfc3339(&wait.until).map(|d| d.with_timezone(&Utc)).unwrap_or_else(|_| Utc::now());
    let mut ids: HashSet<&str> = wait.tasks.iter().map(|t| t.id.as_str()).collect();
    ids.insert(&task.id);
    // In the agent's working directory; stopped (with everything it started) when dropped, if
    // the wait ends some other way first.
    let cwd = match wait.command {
        Some(_) => crate::runner::work_dir(s, task)?,
        None => Default::default(),
    };
    // gh in it acts as the task's GitHub account, as the gh tools do, and it doesn't run as
    // another one when that account isn't signed in.
    let env = match wait.command {
        Some(_) => match crate::runner::task_gh_env(s, task).await? {
            Some(gh) => gh.shell_env(&s.exe, &s.data_dir.join("gh-shim"))?,
            None => Vec::new(),
        },
        None => Vec::new(),
    };
    let mut command = wait.command.as_deref().map(|c| Box::pin(run_command(c, &cwd, &env)));
    let ended = loop {
        if let Some(e) = check(s, &task.id, wait)? {
            break e;
        }
        let left = (until - Utc::now()).to_std().unwrap_or_default();
        if left.is_zero() {
            break Ended::Timeout;
        }
        // Until a change to one of the tasks involved, the next tick or the deadline.
        let next = tokio::time::timeout(left.min(TICK), async {
            loop {
                match events.recv().await {
                    Ok(ev) if ev["type"] == "task" && ev["task"]["id"].as_str().is_some_and(|id| ids.contains(id)) => return,
                    Ok(_) => {}
                    Err(RecvError::Lagged(_)) => return,
                    // Never, while the state is alive; leave it to the tick.
                    Err(RecvError::Closed) => std::future::pending::<()>().await,
                }
            }
        });
        let exited = async {
            match command.as_mut() {
                Some(c) => c.await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            _ = next => {}
            r = exited => {
                let (code, output) = r?;
                break Ended::Command { code, output };
            }
        }
    };
    Ok(ended)
}

/// Run a wait's command with bash in `cwd`, in a process group of its own that's killed once
/// the command exits, or if it's dropped before (the wait ended some other way), so nothing it
/// started outlives it. Returns its exit code (none if a signal ended it) and the end of its
/// output (stdout and stderr together).
async fn run_command(command: &str, cwd: &Path, env: &[(&str, String)]) -> Result<(Option<i32>, String)> {
    // The output goes to a file rather than a pipe, so what the command leaves running can't
    // keep it from being read. Unlinked right away, it goes once it's closed.
    let path = std::env::temp_dir().join(format!("issue-agent-wait-{}.log", new_id()));
    let mut log = std::fs::OpenOptions::new().read(true).write(true).create_new(true).open(&path).context("creating the command's log")?;
    let _ = std::fs::remove_file(&path);
    let (mut child, _alive) = spawn_command(command, cwd, &log, env)?;
    // If the wait ends first, dropped before `child`, while the shell isn't reaped, so its group
    // id can't have been reused; once the shell is reaped, what's left in the group keeps it.
    let group = crate::worktree::KillGroup(child.id().context("running the command")? as i32);
    let status = child.wait().await.context("running the command")?;
    drop(group);
    let len = log.metadata()?.len();
    log.seek(SeekFrom::Start(len.saturating_sub(OUTPUT_MAX)))?;
    let mut out = Vec::new();
    log.read_to_end(&mut out)?;
    let out = String::from_utf8_lossy(&out);
    let output = match len.checked_sub(OUTPUT_MAX).filter(|&n| n > 0) {
        Some(n) => format!("… [{n} bytes before this]\n{out}"),
        None => out.into_owned(),
    };
    Ok((status.code(), output))
}

/// Starts a wait's command in a process group with a watchdog: a subshell that waits on its stdin and
/// kills the group once that closes. Its other end is held by the server only (close-on-exec),
/// so the kernel closes it however the server goes (restarting with exec, exiting, crashing),
/// none of which run the destructors that kill the group otherwise. The command itself runs in
/// a bash of its own (exec'd), which doesn't count the watchdog among its jobs.
const LAUNCH: &str = r#"exec 3<&0 </dev/null; (read -r _ <&3; kill -KILL 0) & exec 3<&-; exec bash -c "$1""#;

/// Start `command` (see LAUNCH) with its output going to `log`. Returns the child and the pipe
/// end that keeps it alive: once that's closed, the watchdog kills the command's group.
fn spawn_command(command: &str, cwd: &Path, log: &std::fs::File, env: &[(&str, String)]) -> Result<(tokio::process::Child, std::io::PipeWriter)> {
    let (watched, alive) = std::io::pipe().context("running the command")?;
    let mut cmd = tokio::process::Command::new("bash");
    cmd.arg("-c").arg(LAUNCH).arg("issue-agent-wait").arg(command);
    cmd.envs(env.iter().map(|(k, v)| (k, v)));
    cmd.current_dir(cwd).stdin(watched).stdout(log.try_clone()?).stderr(log.try_clone()?).process_group(0).kill_on_drop(true);
    let child = cmd.spawn().with_context(|| format!("running the command in {}", cwd.display()))?;
    Ok((child, alive))
}

/// Whether the wait is over, other than by its deadline.
fn check(s: &Shared, task_id: &str, wait: &AgentWait) -> Result<Option<Ended>> {
    let run = db::get_run(&s.db(), &wait.run_id)?;
    if run.is_none_or(|r| r.stop_requested || r.status == "exited") {
        return Ok(Some(Ended::Stopped));
    }
    let Some(task) = db::get_task(&s.db(), task_id)? else { return Ok(Some(Ended::Stopped)) };
    // Cleared under it: the run carried on with something else (or its turn ended).
    let Some(current) = task.agent_wait.filter(|w| w.call_id == wait.call_id) else { return Ok(Some(Ended::Resumed)) };
    // Only an explicit move counts (see AgentWait::moved_to): the board moves the task to "Needs
    // attention" and back by itself for a subagent's permission prompt.
    if let Some(column) = current.moved_to {
        return Ok(Some(Ended::Moved(column)));
    }
    if task.queued_message.is_some() || task.steering.iter().any(|m| m.run_id == wait.run_id) {
        return Ok(Some(Ended::Message));
    }
    if let Some(agent) = current.subagent_finished {
        return Ok(Some(Ended::Subagent(agent)));
    }
    let mut changed = Vec::new();
    for w in &wait.tasks {
        if db::get_task(&s.db(), &w.id)?.is_none_or(|t| t.status != w.status) {
            changed.push(w.id.clone());
        }
    }
    Ok((!changed.is_empty()).then_some(Ended::Tasks(changed)))
}

/// The task's agent isn't waiting any more: in the call `call_id` if given, else in any.
pub fn clear(s: &Shared, task_id: &str, call_id: Option<&str>) {
    let waiting = db::get_task(&s.db(), task_id).ok().flatten().and_then(|t| t.agent_wait);
    if waiting.is_some_and(|w| call_id.is_none_or(|c| c == w.call_id))
        && let Err(e) = s.update_task(task_id, &[("agent_wait", Value::Null)])
    {
        tracing::error!(task = task_id, "clearing the agent's wait: {e:#}");
    }
}

/// Run `run_id` ended: its wait is over (a later run's isn't).
pub fn ended(s: &Shared, task_id: &str, run_id: &str) {
    let its = |c: &rusqlite::Connection| Ok(db::get_task(c, task_id)?.and_then(|t| t.agent_wait).is_some_and(|w| w.run_id == run_id));
    if let Err(e) = s.update_task_if(task_id, &[("agent_wait", Value::Null)], its) {
        tracing::error!(task = task_id, "clearing the agent's wait: {e:#}");
    }
}

/// `run` carried on with other work (a board tool call, or a tool call of the agent's own
/// thread): if it was waiting, it isn't any more, and its wait call returns.
pub fn resumed(s: &Shared, task_id: &str, run_id: &str) {
    let waiting = db::get_task(&s.db(), task_id).ok().flatten().and_then(|t| t.agent_wait);
    if let Some(w) = waiting.filter(|w| w.run_id == run_id) {
        clear(s, task_id, Some(&w.call_id));
    }
}

/// A lifecycle notification from Claude or Codex. A terminal status of an Agent/Task child
/// ends this run's wait, but progress, background shell jobs and internal agents don't.
pub fn subagent_finished(s: &Shared, run: &Run, event: &Value) -> Result<()> {
    let status = match event["subtype"].as_str() {
        Some("task_notification") => event["status"].as_str(),
        Some("task_updated") => event["patch"]["status"].as_str(),
        _ => return Ok(()),
    };
    let status = match status {
        Some("completed" | "success") => "completed",
        Some("failed" | "error") => "failed",
        Some("killed" | "stopped" | "cancelled" | "interrupted") => "stopped",
        _ => return Ok(()),
    };
    let changed = {
        // One lock for the read and write: another call can resume the agent or start a new
        // wait while output arrives. Don't overwrite that wait or a concurrent board move.
        let c = s.db();
        let waiting = db::get_task(&c, &run.task_id)?.and_then(|t| t.agent_wait);
        let Some(mut w) = waiting.filter(|w| w.run_id == run.id && w.subagent_finished.is_none()) else { return Ok(()) };
        let id = match event["tool_use_id"].as_str() {
            Some(id) => Some(id.to_string()),
            None => c.query_row(
                "SELECT json_extract(data,'$.tool_use_id') FROM messages WHERE task_id=?1 AND kind='claude'
                 AND json_extract(data,'$.subtype')='task_started' AND json_extract(data,'$.task_id')=?2 ORDER BY id DESC LIMIT 1",
                rusqlite::params![run.task_id, event["task_id"].as_str()], |r| r.get::<_, Option<String>>(0),
            ).optional()?.flatten(),
        };
        let Some(id) = id else { return Ok(()) };
        let known: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM messages m, json_each(m.data,'$.message.content') b
             WHERE m.task_id=?1 AND m.kind='claude' AND json_extract(m.data,'$.type')='assistant'
             AND json_extract(b.value,'$.type')='tool_use' AND json_extract(b.value,'$.name') IN ('Agent','Task')
             AND json_extract(b.value,'$.id')=?2)",
            rusqlite::params![run.task_id, id], |r| r.get(0),
        )?;
        if !known {
            return Ok(());
        }
        w.subagent_finished = Some(json!({"tool_use_id": id, "task_id": event["task_id"], "status": status, "summary": event["summary"]}));
        db::update_task(&c, &run.task_id, &[("agent_wait", json!(w))])?
    };
    if let Some(task) = changed {
        s.emit_task(&task);
    }
    Ok(())
}

/// Whether a stream-json event from the agent is its own thread (not a subagent) calling a
/// tool other than `wait`.
pub fn is_activity(v: &Value) -> bool {
    v["type"] == "assistant"
        && v["parent_tool_use_id"].is_null()
        && v["message"]["content"].as_array().is_some_and(|c| {
            c.iter().any(|b| b["type"] == "tool_use" && !b["name"].as_str().is_some_and(is_wait_tool))
        })
}

/// Whether a tool, as an agent's tool calls name it, is this one.
pub fn is_wait_tool(name: &str) -> bool {
    name.strip_prefix("mcp__").and_then(|n| n.strip_suffix("__wait")).is_some_and(crate::runner::is_board_server)
}

/// What the tool tells the agent about how its wait ended.
pub fn note(ended: &Ended, keys: &[String]) -> String {
    match ended {
        Ended::Timeout => "The wait period is over. Check on what you were waiting for, and wait again if it isn't ready yet.".into(),
        Ended::Tasks(_) => format!("{} changed status (see tasks).", keys.join(", ")),
        Ended::Subagent(_) => "A subagent finished (see subagent).".into(),
        Ended::Message => "A message was sent to you; you'll read it once this call returns.".into(),
        Ended::Stopped => "The run was stopped.".into(),
        Ended::Resumed => "The wait ended because you carried on with other work (another tool call).".into(),
        Ended::Moved(status) => format!("The task was moved to {status} on the board."),
        Ended::Command { code: Some(code), .. } => format!("Your command exited with code {code} (see command.output)."),
        Ended::Command { code: None, .. } => "Your command was ended by a signal (see command.output).".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::RunHandle;
    use crate::testing;

    /// A task whose agent is running, with another task it can watch.
    fn running() -> (Shared, Task, Run, Task) {
        let s = testing::state();
        let p = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let new = |title| db::NewTask { profile_id: &p.id, project_id: None, kind: "task", title, description: "", status: "in_progress", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let task = db::insert_task(&s.db(), new("planner")).unwrap();
        let other = db::insert_task(&s.db(), new("other")).unwrap();
        let run = db::insert_run(&s.db(), &task.id, "prompt").unwrap();
        s.db().execute("UPDATE runs SET status='running' WHERE id=?1", [&run.id]).unwrap();
        s.runs.lock().unwrap().insert(task.id.clone(), RunHandle { run_id: run.id.clone(), cancel: None });
        let task = s.update_task(&task.id, &[("running", json!(true))]).unwrap().unwrap();
        (s, task, run, other)
    }

    fn secs(seconds: f64) -> Request {
        Request { seconds: Some(seconds), ..Default::default() }
    }

    fn reload(s: &Shared, id: &str) -> Task {
        db::get_task(&s.db(), id).unwrap().unwrap()
    }

    /// Run `then` once the task shows as waiting.
    fn when_waiting(s: &Shared, id: &str, then: impl FnOnce(&Shared) + Send + 'static) {
        let (s, id) = (s.clone(), id.to_string());
        tokio::spawn(async move {
            while reload(&s, &id).agent_wait.is_none() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            then(&s);
        });
    }

    #[test]
    fn waits_out_the_period_showing_as_waiting() {
        testing::run(async || {
            let (s, task, run, _) = running();
            let seen = std::sync::Arc::new(std::sync::Mutex::new(None));
            let seen2 = seen.clone();
            let id = task.id.clone();
            when_waiting(&s, &task.id, move |s| *seen2.lock().unwrap() = reload(s, &id).agent_wait);
            let started = std::time::Instant::now();
            let ended = wait(&s, &run, &task, "c1", Request { reason: Some(" waiting for CI ".into()), ..secs(1.0) }).await.unwrap().0;
            assert_eq!(ended, Ended::Timeout);
            assert!(started.elapsed() >= Duration::from_millis(900));
            let w = seen.lock().unwrap().clone().unwrap();
            assert_eq!((w.reason.as_deref(), w.call_id.as_str(), w.run_id.as_str()), (Some("waiting for CI"), "c1", run.id.as_str()));
            // Still in progress, and working again.
            let t = reload(&s, &task.id);
            assert_eq!((t.status.as_str(), t.running, t.agent_wait), ("in_progress", true, None));
        });
    }

    #[test]
    fn ends_when_a_watched_task_changes_status() {
        testing::run(async || {
            let (s, task, run, other) = running();
            let id = other.id.clone();
            when_waiting(&s, &task.id, move |s| {
                s.update_task(&id, &[("status", json!("in_review"))]).unwrap();
            });
            let ended = wait(&s, &run, &task, "c1", Request { tasks: vec![WaitTask { id: other.id.clone(), key: "T-2".into(), status: other.status.clone() }], ..secs(30.0) }).await.unwrap().0;
            assert_eq!(ended, Ended::Tasks(vec![other.id.clone()]));
            assert_eq!(reload(&s, &task.id).agent_wait, None);
        });
    }

    #[test]
    fn ends_when_a_message_is_sent_to_the_agent() {
        testing::run(async || {
            let (s, task, run, _) = running();
            let id = task.id.clone();
            // The run takes no input, so the message is queued for when it ends.
            when_waiting(&s, &task.id, move |s| {
                crate::runner::send(s, &id, "come back").unwrap();
            });
            let ended = wait(&s, &run, &task, "c1", secs(30.0)).await.unwrap().0;
            assert_eq!(ended, Ended::Message);
        });
    }

    #[test]
    fn ends_when_the_run_is_stopped_or_the_task_moved() {
        testing::run(async || {
            let (s, task, run, _) = running();
            let run_id = run.id.clone();
            when_waiting(&s, &task.id, move |s| {
                s.db().execute("UPDATE runs SET stop_requested=1 WHERE id=?1", [&run_id]).unwrap();
            });
            assert_eq!(wait(&s, &run, &task, "c1", secs(30.0)).await.unwrap().0, Ended::Stopped);

            // Moved from the board or with update_task, to "Needs attention" too.
            for status in ["done", "needs_attention"] {
                let (s, task, run, _) = running();
                move_when_waiting(&s, &task.id, status);
                assert_eq!(wait(&s, &run, &task, "c1", secs(30.0)).await.unwrap().0, Ended::Moved(status.into()));
            }
        });
    }

    /// Move the task to `status` as the board does, once it shows as waiting.
    fn move_when_waiting(s: &Shared, id: &str, status: &str) {
        let (s, id, body) = (s.clone(), id.to_string(), json!({"status": status}));
        tokio::spawn(async move {
            while reload(&s, &id).agent_wait.is_none() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            crate::api::update_task_inner(&s, &id, body.as_object().unwrap()).await.unwrap();
        });
    }

    #[test]
    fn a_subagents_permission_prompt_isnt_a_move() {
        testing::run(async || {
            let (s, task, run, _) = running();
            let (s2, id) = (s.clone(), task.id.clone());
            let subagent = tokio::spawn(async move {
                while reload(&s2, &id).agent_wait.is_none() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                // The prompt moves the task to "Needs attention", and answering it (Always allow)
                // moves it back.
                let t = reload(&s2, &id);
                let asking = tokio::spawn({
                    let s = s2.clone();
                    async move { crate::permissions::prompt(&s, &t, "call-1", "Bash", &json!({"command": "make"}), Some("toolu_sub")).await.unwrap() }
                });
                let request = loop {
                    let r: Option<String> = s2.db().query_row("SELECT id FROM permission_requests WHERE call_id='call-1'", [], |r| r.get(0)).ok();
                    match r {
                        Some(r) => break r,
                        None => tokio::time::sleep(Duration::from_millis(10)).await,
                    }
                };
                assert_eq!(reload(&s2, &id).status, "needs_attention");
                tokio::time::sleep(TICK * 2).await;
                crate::permissions::decide(&s2, &request, true, true, None).unwrap();
                assert_eq!(asking.await.unwrap()["behavior"], "allow");
                let t = reload(&s2, &id);
                (t.status, t.agent_wait.is_some())
            });
            assert_eq!(wait(&s, &run, &task, "c1", secs(1.5)).await.unwrap().0, Ended::Timeout);
            assert_eq!(subagent.await.unwrap(), ("in_progress".to_string(), true));
        });
    }

    #[test]
    fn its_own_threads_other_tool_calls_end_a_wait() {
        let call = |name: &str, parent: Value| json!({"type": "assistant", "parent_tool_use_id": parent, "message": {"content": [{"type": "tool_use", "name": name}]}});
        assert!(is_activity(&call("Bash", Value::Null)));
        assert!(!is_activity(&call("mcp__huntaway__wait", Value::Null)));
        // A subagent working doesn't: its agent may be waiting for it.
        assert!(!is_activity(&call("Bash", json!("toolu_1"))));
        assert!(!is_activity(&json!({"type": "assistant", "parent_tool_use_id": null, "message": {"content": [{"type": "text", "text": "hi"}]}})));
        testing::run(async || {
            let (s, task, run, _) = running();
            let (id, run_id) = (task.id.clone(), run.id.clone());
            when_waiting(&s, &task.id, move |s| resumed(s, &id, &run_id));
            assert_eq!(wait(&s, &run, &task, "c1", secs(30.0)).await.unwrap().0, Ended::Resumed);
            assert_eq!(reload(&s, &task.id).agent_wait, None);
        });
    }

    #[test]
    fn a_codex_agents_own_tool_calls_end_a_wait() {
        testing::run(async || {
            let (s, task, run, _) = running();
            let task = s.update_task(&task.id, &[("session_id", json!("main"))]).unwrap().unwrap();
            let (id, run_id) = (task.id.clone(), run.id.clone());
            when_waiting(&s, &task.id, move |s| {
                let started = |thread: &str| {
                    let item = json!({"type": "commandExecution", "id": "e1", "command": "make", "status": "inProgress"});
                    format!("{}\n", json!({"method": "item/started", "params": {"threadId": thread, "turnId": "t", "item": item}}))
                };
                let offset = |s: &Shared| db::get_run(&s.db(), &run_id).unwrap().unwrap().out_offset as u64;
                // A subagent's thread working doesn't end it.
                crate::runner::on_output(s, &run_id, offset(s), &started("sub"));
                assert!(reload(s, &id).agent_wait.is_some());
                crate::runner::on_output(s, &run_id, offset(s), &started("main"));
            });
            assert_eq!(wait(&s, &run, &task, "c1", secs(30.0)).await.unwrap().0, Ended::Resumed);
            assert_eq!(reload(&s, &task.id).agent_wait, None);
        });
        assert!(is_wait_tool("mcp__huntaway__wait") && !is_wait_tool("mcp__huntaway__wait_for") && !is_wait_tool("mcp__other__wait"));
        assert!(is_wait_tool("mcp__issue_agent__wait"), "runs from before the rename");
    }

    #[test]
    fn only_a_subagents_terminal_status_wakes_its_own_run() {
        testing::run(async || {
            let (s, task, run, other) = running();
            // An Agent call needn't be the first content block.
            s.add_message(&task.id, "claude", json!({"type": "assistant", "message": {"content": [
                {"type": "text", "text": "Starting a worker"}, {"type": "tool_use", "name": "Agent", "id": "child"}
            ]}})).unwrap();
            let other_run = db::insert_run(&s.db(), &other.id, "prompt").unwrap();
            let stale_run = db::insert_run(&s.db(), &task.id, "prompt").unwrap();
            let (id, run2) = (task.id.clone(), run.clone());
            let done = json!({"type": "system", "subtype": "task_notification", "tool_use_id": "child", "status": "completed", "summary": "Ready"});
            let done2 = done.clone();
            when_waiting(&s, &task.id, move |s| {
                let original = reload(s, &id).agent_wait.unwrap();
                for event in [
                    json!({"subtype": "task_started", "tool_use_id": "child"}),
                    json!({"subtype": "task_progress", "tool_use_id": "child", "description": "Working"}),
                    json!({"subtype": "task_updated", "tool_use_id": "child", "patch": {"status": "running"}}),
                    json!({"subtype": "task_notification", "tool_use_id": "shell-or-internal-agent", "status": "completed"}),
                ] {
                    subagent_finished(s, &run2, &event).unwrap();
                    assert_eq!(reload(s, &id).agent_wait.as_ref(), Some(&original));
                }
                subagent_finished(s, &stale_run, &done2).unwrap();
                subagent_finished(s, &other_run, &done2).unwrap();
                assert_eq!(reload(s, &id).agent_wait.as_ref(), Some(&original));
                subagent_finished(s, &run2, &done2).unwrap();
                // The first completion wins even if several children finish together.
                subagent_finished(s, &run2, &json!({"subtype": "task_notification", "tool_use_id": "child", "status": "failed"})).unwrap();
            });
            let ended = wait(&s, &run, &task, "c1", secs(30.0)).await.unwrap().0;
            assert_eq!(ended, Ended::Subagent(json!({"tool_use_id": "child", "task_id": null, "status": "completed", "summary": "Ready"})));
            assert_eq!(reload(&s, &task.id).agent_wait, None);
        });
    }

    #[test]
    fn a_subagents_completion_is_kept_until_a_retried_wait_returns() {
        testing::run(async || {
            let (s, task, run, _) = running();
            s.add_message(&task.id, "claude", json!({"type": "assistant", "message": {"content": [
                {"type": "tool_use", "name": "Task", "id": "child"}
            ]}})).unwrap();
            s.add_message(&task.id, "claude", json!({"type": "system", "subtype": "task_started", "tool_use_id": "child", "task_id": "background"})).unwrap();
            // A stored wait from before this field existed can be resumed too.
            let w = json!({"since": now(), "until": (Utc::now() + chrono::Duration::seconds(60)).to_rfc3339(),
                "call_id": "c1", "run_id": run.id});
            s.update_task(&task.id, &[("agent_wait", w)]).unwrap();
            // Claude can identify a background child by task_id instead of tool_use_id.
            subagent_finished(&s, &run, &json!({"subtype": "task_notification", "task_id": "background", "status": "completed", "summary": "Report"})).unwrap();
            let task = reload(&s, &task.id);
            assert!(task.agent_wait.as_ref().unwrap().subagent_finished.is_some());
            let ended = wait(&s, &run, &task, "c1", secs(30.0)).await.unwrap().0;
            assert_eq!(ended, Ended::Subagent(json!({"tool_use_id": "child", "task_id": "background", "status": "completed", "summary": "Report"})));
            assert_eq!(ended.name(), "subagent_finished");
            assert_eq!(note(&ended, &[]), "A subagent finished (see subagent).");
            // A new wait doesn't replay an old completion.
            let task = reload(&s, &task.id);
            assert_eq!(wait(&s, &run, &task, "c2", secs(1.0)).await.unwrap().0, Ended::Timeout);
        });
    }

    #[test]
    fn a_wait_without_tasks_or_a_command_is_short() {
        let watching = || vec![WaitTask { id: "t".into(), key: "T-2".into(), status: "todo".into() }];
        let command = |c: &str| Request { command: Some(c.into()), ..Default::default() };
        assert_eq!(period(&Request::default()), Ok(30.0));
        assert_eq!(period(&secs(30.0)), Ok(30.0));
        assert_eq!(period(&secs(0.1)), Ok(1.0));
        assert_eq!(period(&Request { tasks: watching(), ..Default::default() }), Ok(600.0));
        assert_eq!(period(&Request { tasks: watching(), ..secs(7200.0) }), Ok(3600.0));
        assert_eq!(period(&command("gh pr checks 1 --watch")), Ok(600.0));
        assert_eq!(period(&Request { seconds: Some(1800.0), ..command("gh pr checks 1 --watch") }), Ok(1800.0));
        // A blank command is none.
        let err = period(&Request { seconds: Some(1800.0), ..command("  ") }).unwrap_err();
        assert!(err.contains("30 seconds at most") && err.contains("give a command"), "{err}");
        testing::run(async || {
            let (s, task, run, _) = running();
            let err = wait(&s, &run, &task, "c1", secs(30.5)).await.unwrap_err().to_string();
            assert!(err.starts_with("The wait didn't start"), "{err}");
            assert_eq!(reload(&s, &task.id).agent_wait, None);
        });
    }

    /// A wait running `command` in the task's working directory (its profile's scratch folder).
    fn with_command(s: &Shared, task: &Task, command: &str, seconds: f64) -> Request {
        std::fs::create_dir_all(s.profile_scratch_dir(&task.profile_id)).unwrap();
        Request { command: Some(command.into()), ..secs(seconds) }
    }

    #[test]
    fn ends_when_its_command_exits() {
        testing::run(async || {
            let (s, task, run, _) = running();
            let started = std::time::Instant::now();
            let req = with_command(&s, &task, "sleep 0.3; touch here; echo ready; echo oops >&2; exit 3", 60.0);
            let ended = wait(&s, &run, &task, "c1", req).await.unwrap().0;
            assert_eq!(ended, Ended::Command { code: Some(3), output: "ready\noops\n".into() });
            assert!(started.elapsed() >= Duration::from_millis(300));
            assert!(s.profile_scratch_dir(&task.profile_id).join("here").exists());
            assert_eq!(reload(&s, &task.id).agent_wait, None);

            // Only the end of a long output.
            let req = with_command(&s, &task, "head -c 10000 /dev/zero | tr '\\0' x; echo; echo end", 60.0);
            let Ended::Command { code, output } = wait(&s, &run, &task, "c2", req).await.unwrap().0 else { panic!() };
            assert_eq!(code, Some(0));
            assert!(output.starts_with("… [6005 bytes before this]\n") && output.ends_with("xx\nend\n"), "{output}");
        });
    }

    #[test]
    fn its_command_doesnt_run_as_another_github_account() {
        testing::run(async || {
            // The profile picked an account gh isn't signed in to (or gh isn't installed): the
            // command would run as gh's active account, so it doesn't run at all.
            let (s, task, run, _) = running();
            db::update_profile(&s.db(), &task.profile_id, &[("github_account", json!("not-signed-in-ia123"))]).unwrap();
            let req = with_command(&s, &task, "touch ran", 60.0);
            let err = wait(&s, &run, &task, "c1", req).await.unwrap_err();
            assert!(format!("{err:#}").contains("not-signed-in-ia123"), "{err:#}");
            assert!(!s.profile_scratch_dir(&task.profile_id).join("ran").exists());
            assert_eq!(reload(&s, &task.id).agent_wait, None);
        });
    }

    #[test]
    fn its_command_is_stopped_when_the_wait_ends_otherwise() {
        testing::run(async || {
            let (s, task, run, _) = running();
            let pid_file = s.profile_scratch_dir(&task.profile_id).join("pid");
            // Something it started in the background, as well as the shell itself.
            let req = with_command(&s, &task, &format!("sleep 30 & echo $! > {}; sleep 30", pid_file.display()), 1.0);
            assert_eq!(wait(&s, &run, &task, "c1", req).await.unwrap().0, Ended::Timeout);
            let pid: i32 = std::fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();
            assert!(gone(pid).await, "the command's background process is still running");
        });
    }

    /// Whether a process is running (not gone, nor a zombie waiting to be reaped).
    fn alive(pid: i32) -> bool {
        std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|st| !st.contains(") Z "))
    }

    /// Wait (a while at most) for `pid` to be gone.
    async fn gone(pid: i32) -> bool {
        for _ in 0..100 {
            if !alive(pid) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        false
    }

    #[test]
    fn its_command_is_stopped_when_the_server_goes_without_cleaning_up() {
        testing::run(async || {
            let dir = std::env::temp_dir().join(format!("ia-test-{}", new_id()));
            std::fs::create_dir_all(&dir).unwrap();
            let log = std::fs::File::create(dir.join("log")).unwrap();
            let pid_file = dir.join("pid");
            // `wait` waits for its own jobs only, not the watchdog.
            let command = format!("sleep 30 & echo $! > {}; wait", pid_file.display());
            let (child, alive_end) = spawn_command(&command, &dir, &log, &[]).unwrap();
            // An exec doesn't pass the server's end on to the new server.
            use std::os::fd::AsRawFd;
            let flags = unsafe { libc::fcntl(alive_end.as_raw_fd(), libc::F_GETFD) };
            assert!(flags & libc::FD_CLOEXEC != 0);
            let shell = child.id().unwrap() as i32;
            while std::fs::read_to_string(&pid_file).map_or(true, |p| p.trim().is_empty()) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let background: i32 = std::fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();
            tokio::time::sleep(Duration::from_millis(200)).await;
            assert!(alive(shell) && alive(background));
            // The server goes (exec, exit or crash): no destructors run, but the kernel closes its
            // files.
            std::mem::forget(child);
            drop(alive_end);
            assert!(gone(shell).await, "the command is still running");
            assert!(gone(background).await, "the command's background process is still running");
            std::fs::remove_dir_all(&dir).unwrap();
        });
    }

    #[test]
    fn a_retried_call_carries_on_with_its_deadline() {
        testing::run(async || {
            let (s, task, run, other) = running();
            // As if the server restarted with the call waiting since a while ago.
            let w = AgentWait {
                reason: Some("r".into()),
                since: now(),
                until: (Utc::now() + chrono::Duration::milliseconds(300)).to_rfc3339(),
                tasks: vec![WaitTask { id: other.id.clone(), key: "T-2".into(), status: "in_progress".into() }],
                command: None,
                call_id: "c1".into(),
                run_id: run.id.clone(),
                moved_to: None,
                subagent_finished: None,
            };
            let task = s.update_task(&task.id, &[("agent_wait", json!(w))]).unwrap().unwrap();
            let started = std::time::Instant::now();
            assert_eq!(wait(&s, &run, &task, "c1", secs(30.0)).await.unwrap().0, Ended::Timeout);
            assert!(started.elapsed() < Duration::from_secs(5));
            // The watched task changed while the server was down.
            s.update_task(&other.id, &[("status", json!("done"))]).unwrap();
            let task = s.update_task(&task.id, &[("agent_wait", json!(w))]).unwrap().unwrap();
            assert_eq!(wait(&s, &run, &task, "c1", secs(30.0)).await.unwrap().0, Ended::Tasks(vec![other.id.clone()]));
        });
    }
}
