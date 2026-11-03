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
//! - news about the pull request it was given (`pull_request`): its checks finished, someone
//!   commented or reviewed, it conflicts with its base, or it was merged or closed. The server
//!   reads it from GitHub every minute or so as the task's GitHub account (see mcp/pr_watch.rs);
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
//! stored wait and its deadline (running its command again from the start, and reading its pull
//! request again straight away).

use std::collections::HashSet;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use chrono::{DateTime, Utc};
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
    /// There's news about the wait's pull request (see pr_watch::compare), or it couldn't be read.
    PullRequest(Value),
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
            Ended::PullRequest(_) => "pull_request",
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
    /// A pull request whose news ends the wait.
    pub pull_request: Option<crate::mcp::pr_watch::Request>,
}

/// Wait in the call `call_id` of `run` (on `task`) until the period is over or something
/// happens, showing the task as waiting meanwhile. A call that's `resuming` keeps the tasks,
/// command and pull request it started with. Returns how the wait ended and the wait as it was
/// then (with the tasks it watched, and its pull request's news).
pub async fn wait(s: &Shared, run: &Run, task: &Task, call_id: &str, req: Request) -> Result<(Ended, AgentWait)> {
    // Subscribed before anything is read, so no change can slip in between.
    let events = s.events.subscribe();
    let mut watcher = None;
    let wait = match resuming(task, call_id).cloned() {
        Some(w) => w,
        None => {
            let secs = period(&req).map_err(anyhow::Error::msg)?;
            let Request { reason, tasks, command, pull_request, .. } = req;
            // Read before the wait starts, so a pull request that can't be read doesn't start it.
            let pull_request = match pull_request {
                Some(pr) => {
                    let mut w = crate::mcp::pr_watch::Watcher::new(s, task, pr.target.clone())?;
                    let news = w.poll(s, &task.id, call_id, &pr.events).await.map_err(|e| {
                        // A host from the task's remote may be an SSH alias that couldn't be looked up.
                        let hint = match pr.target.host.as_str() {
                            "github.com" => String::new(),
                            host => format!(" (if {host} isn't a GitHub host, give the pull request's URL)"),
                        };
                        anyhow!("The wait didn't start: {} couldn't be read: {e}{hint}", pr.target.label())
                    })?;
                    watcher = Some(w);
                    Some(pr.stored(news))
                }
                None => None,
            };
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
                pull_request,
            };
            s.update_task(&task.id, &[("agent_wait", json!(w))])?;
            w
        }
    };
    let ended = wait_out(s, task, &wait, events, watcher).await;
    // As it is now, with what came in meanwhile (a pull request's news), before it's cleared.
    let last = db::get_task(&s.db(), &task.id).ok().flatten().and_then(|t| t.agent_wait).filter(|w| w.call_id == call_id).unwrap_or(wait);
    clear(s, &task.id, Some(call_id));
    let ended = ended?;
    // The call returns its pull request's news (whatever ended it), unless the agent won't see it.
    if let Some(pr) = last.pull_request.as_ref().filter(|p| p.news.is_some())
        && !matches!(ended, Ended::Stopped | Ended::Resumed)
    {
        crate::mcp::pr_watch::delivered(s, &task.id, call_id, pr);
    }
    Ok((ended, last))
}

/// How long a new wait asked for lasts (in seconds), or why it doesn't start: see
/// `UNWATCHED_MAX_SECS`.
pub fn period(req: &Request) -> std::result::Result<f64, String> {
    let unwatched = req.tasks.is_empty() && req.command.as_deref().is_none_or(|c| c.trim().is_empty()) && req.pull_request.is_none();
    let max = if unwatched { UNWATCHED_MAX_SECS } else { MAX_SECS };
    match req.seconds {
        Some(secs) if unwatched && secs > max as f64 => Err(format!(
            "The wait didn't start: without a command, tasks or a pull request, a wait lasts {max} seconds at most, because little but a \
             message or a subagent can end it early, so it would carry on long after what you're waiting for is ready. Either give the \
             pull_request you're waiting on (its checks, reviews or merge), a command that exits once it's ready (e.g. 'until curl -sf \
             https://example.com/health; do sleep 15; done'), list the tasks you're waiting for in tasks, or wait {max} seconds at a \
             time, checking in between."
        )),
        Some(secs) => Ok(secs.clamp(1.0, max as f64)),
        None => Ok((if unwatched { UNWATCHED_MAX_SECS } else { DEFAULT_SECS }) as f64),
    }
}

async fn wait_out(
    s: &Shared,
    task: &Task,
    wait: &AgentWait,
    mut events: tokio::sync::broadcast::Receiver<Value>,
    watcher: Option<crate::mcp::pr_watch::Watcher>,
) -> Result<Ended> {
    let until = DateTime::parse_from_rfc3339(&wait.until).map(|d| d.with_timezone(&Utc)).unwrap_or_else(|_| Utc::now());
    let mut ids: HashSet<&str> = wait.tasks.iter().map(|t| t.id.as_str()).collect();
    ids.insert(&task.id);
    // In the agent's working directory; stopped (with everything it started) when dropped, if
    // the wait ends some other way first.
    let cwd = match wait.command {
        Some(_) => crate::agent::runner::work_dir(s, task)?,
        None => Default::default(),
    };
    // gh in it acts as the task's GitHub account, as the gh tools do, and it doesn't run as
    // another one when that account isn't signed in.
    let env = match wait.command {
        Some(_) => match crate::agent::runner::task_gh_env(s, task).await? {
            Some(gh) => gh.shell_env(&s.exe, &s.data_dir.join("gh-shim"))?,
            None => Vec::new(),
        },
        None => Vec::new(),
    };
    let mut command = wait.command.as_deref().map(|c| Box::pin(run_command(c, &cwd, &env)));
    // Reads the pull request until there's news, which it records in the wait (see `check`). A
    // wait carried on after a restart reads it straight away.
    let mut watch = match &wait.pull_request {
        Some(pr) if pr.news.is_none() => {
            let (w, delay) = match watcher {
                Some(w) => (w, crate::mcp::pr_watch::POLL),
                None => {
                    let target = crate::mcp::pr_watch::Target::of(pr).with_context(|| format!("the wait's pull request {}", pr.url))?;
                    (crate::mcp::pr_watch::Watcher::new(s, task, target)?, Duration::ZERO)
                }
            };
            Some(Box::pin(crate::mcp::pr_watch::watch(s, &task.id, &wait.call_id, &pr.events, w, delay)))
        }
        _ => None,
    };
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
        let read = async {
            match watch.as_mut() {
                Some(w) => w.await,
                None => std::future::pending().await,
            }
        };
        let mut news = false;
        tokio::select! {
            _ = next => {}
            r = exited => {
                let (code, output) = r?;
                break Ended::Command { code, output };
            }
            _ = read => news = true,
        }
        if news {
            watch = None;
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
    let group = crate::git::worktree::KillGroup(child.id().context("running the command")? as i32);
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
    if let Some(news) = current.pull_request.and_then(|p| p.news) {
        return Ok(Some(Ended::PullRequest(news)));
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
        let Some(id) = crate::threads::history::subagent_call(&c, &run.task_id, event)? else { return Ok(()) };
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
    name.strip_prefix("mcp__").and_then(|n| n.strip_suffix("__wait")).is_some_and(crate::agent::runner::is_board_server)
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
        Ended::PullRequest(news) => crate::mcp::pr_watch::note(news),
    }
}

#[cfg(test)]
mod tests;
