//! The `huntaway` MCP tools that agents call, executed here on behalf of the agent's MCP
//! helper (`POST /api/internal/mcp`). Calls are deduplicated by call id, so a helper that
//! retries across a server restart never runs a tool twice.
//!
//! Tools act on the caller's profile's board and on the boards of the other profiles that let
//! its agents in (`Profile::agent_access`). `list_projects` covers all of them, labelled with
//! their profile; projects and tasks can be named by id, by key (`SD`, `SD-3`), or by key
//! qualified with a profile (`work:SD-3`) or the `profile` argument. An unqualified key means
//! the caller's own board if it has it there, else the one other board that has it; a key on
//! several other boards must be qualified.
//!
//! A project or task that isn't found here is looked up on linked hosts (`POST
//! /api/tools/<tool>` there), and `list_projects` covers every host, so an orchestrating agent
//! can work across machines.

use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;

use crate::api::{self, CreateProject, CreateTask};
use crate::db::{self, Task};
use crate::state::Shared;
use crate::{hub, mcp, permissions, relocate, runner};

/// Who is calling. The caller's profile picks the boards it can use: its own (`profile_id`,
/// unset when this host has no profile by its name) and those whose profiles let it in. The
/// task is set for agent calls, with the call's id: a change the user has to approve is asked
/// in the task's thread, once per call.
pub struct Ctx {
    pub profile_id: Option<String>,
    pub profile_name: String,
    pub task: Option<Task>,
    pub call_id: Option<String>,
    /// The original caller's helper advertises get_task_field (not just this host's build).
    pub task_fields: bool,
}

impl Ctx {
    fn is_own(&self, p: &db::Profile) -> bool {
        self.profile_id.as_deref() == Some(p.id.as_str())
    }
}

enum ToolError {
    NotFound(String),
    Other(String),
}

impl From<anyhow::Error> for ToolError {
    fn from(e: anyhow::Error) -> Self {
        ToolError::Other(format!("{e:#}"))
    }
}

impl From<rusqlite::Error> for ToolError {
    fn from(e: rusqlite::Error) -> Self {
        ToolError::Other(e.to_string())
    }
}

impl From<crate::state::ApiError> for ToolError {
    fn from(e: crate::state::ApiError) -> Self {
        if e.0 == axum::http::StatusCode::NOT_FOUND { ToolError::NotFound(e.1) } else { ToolError::Other(e.1) }
    }
}

type ToolResult = std::result::Result<Value, ToolError>;

fn msg(e: ToolError) -> String {
    match e {
        ToolError::NotFound(m) | ToolError::Other(m) => m,
    }
}

// ---------- entry points ----------

/// What an agent's MCP helper sends. Helpers from older builds keep running after an
/// upgrade, so this shape must stay backwards compatible (only add optional fields).
#[derive(Deserialize)]
pub struct McpCall {
    pub run_id: String,
    pub call_id: String,
    pub tool: String,
    #[serde(default)]
    pub args: Value,
    /// Missing on helpers that predate get_task_field and survive a daemon upgrade.
    #[serde(default)]
    pub task_fields: bool,
}

/// The tools a call to which is run again when it's retried after being cut short (by a
/// restart, say): they only read, record what they're given, or pick up where they left off
/// (`wait` and `permission_prompt`, by their call id). A call to another tool that was cut short
/// may have taken effect, so it isn't run again.
const RERUNNABLE: &[&str] =
    &["permission_prompt", "request_user_input", "submit_review", "wait", "list_projects", "list_tasks", "get_task", "get_project", "list_automations"];

/// A call being executed, which duplicate deliveries wait on (see `handle_mcp`). Dropped without
/// `done`, as when its request is cut short, it lets them go: a retry then finds it recorded as
/// executing but not done.
struct InFlight<'a> {
    s: &'a Shared,
    id: &'a str,
}

impl InFlight<'_> {
    fn done(self, result: &std::result::Result<Value, String>) {
        for w in self.s.calls_inflight.lock().unwrap().remove(self.id).unwrap_or_default() {
            let _ = w.send(result.clone());
        }
        std::mem::forget(self);
    }
}

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        self.s.calls_inflight.lock().unwrap().remove(self.id);
    }
}

/// An agent's tool call, at most once per call id: it's recorded as executing before it runs,
/// and with its result once it has.
pub async fn handle_mcp(s: &Shared, c: McpCall) -> std::result::Result<Value, String> {
    // A duplicate delivery while the first is still executing waits for its result.
    let rx = {
        let mut inflight = s.calls_inflight.lock().unwrap();
        match inflight.get_mut(&c.call_id) {
            Some(waiters) => {
                let (tx, rx) = oneshot::channel();
                waiters.push(tx);
                Some(rx)
            }
            None => {
                inflight.insert(c.call_id.clone(), Vec::new());
                None
            }
        }
    };
    if let Some(rx) = rx {
        return rx.await.unwrap_or_else(|_| Err("call abandoned".into()));
    }
    let call = InFlight { s, id: &c.call_id };
    // Nothing runs unless the board knows it's running: a call it can't record may already have.
    let before: rusqlite::Result<Option<(String, Option<String>, Option<String>)>> = s
        .db()
        .query_row("SELECT status, result, error FROM mcp_calls WHERE id=?1", [&c.call_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional();
    let record = |status: &str, result: Option<&std::result::Result<Value, String>>| -> rusqlite::Result<()> {
        let (res, err) = match result {
            Some(Ok(v)) => (Some(v.to_string()), None),
            Some(Err(e)) => (None, Some(e.clone())),
            None => (None, None),
        };
        let task_id = db::get_run(&s.db(), &c.run_id).ok().flatten().map(|r| r.task_id).unwrap_or_default();
        s.db().execute(
            "INSERT INTO mcp_calls (id,run_id,task_id,tool,args,status,result,error,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
             ON CONFLICT(id) DO UPDATE SET status=?6, result=?7, error=?8",
            rusqlite::params![c.call_id, c.run_id, task_id, c.tool, c.args.to_string(), status, res, err, crate::util::now()],
        )?;
        Ok(())
    };
    let unrecorded = |e: rusqlite::Error| format!("The board couldn't record this {} call, so it wasn't run (call it again): {e}", c.tool);
    let done = |result: &std::result::Result<Value, String>| {
        if let Err(e) = record("done", Some(result)) {
            tracing::error!(call = c.call_id, tool = c.tool, "recording an MCP call's result: {e}");
        }
    };
    let result = match before {
        Err(e) => Err(unrecorded(e)),
        Ok(Some((status, result, error))) if status == "done" => match error {
            Some(e) => Err(e),
            None => Ok(result.and_then(|r| serde_json::from_str(&r).ok()).unwrap_or(Value::Null)),
        },
        // Executing when the server stopped.
        Ok(Some(_)) if !rerunnable(s, &c) => {
            let result = Err(format!(
                "This {} call was interrupted (the board's server restarted while it ran), so it isn't run again: it may or may not have \
                 taken effect. Check (with get_task or list_tasks, say) before you call it again.",
                c.tool
            ));
            done(&result);
            result
        }
        Ok(_) => match record("executing", None) {
            Err(e) => Err(unrecorded(e)),
            Ok(()) => {
                let result = execute_mcp(s, &c).await;
                #[cfg(test)]
                crate::testing::reached("mcp:executed");
                done(&result);
                result
            }
        },
    };
    call.done(&result);
    result
}

/// Whether call `c`, cut short, can run again. An `update_project`, `delete_task` or a change to
/// an automation can while the user hasn't approved what it asked (nothing is changed before
/// then): it carries on waiting for them.
fn rerunnable(s: &Shared, c: &McpCall) -> bool {
    let kind = match c.tool.as_str() {
        _ if RERUNNABLE.contains(&c.tool.as_str()) => return true,
        "update_project" | "create_project" => "project",
        "delete_task" => "delete_task",
        "create_automation" | "update_automation" | "delete_automation" => "automation",
        _ => return false,
    };
    s.db()
        .query_row("SELECT status FROM permission_requests WHERE call_id=?1 AND kind=?2", [&c.call_id, kind], |r| r.get::<_, String>(0))
        .is_ok_and(|status| status != "allowed")
}

async fn execute_mcp(s: &Shared, c: &McpCall) -> std::result::Result<Value, String> {
    crate::mcp::check_args(&c.tool, &c.args)?;
    let run = db::get_run(&s.db(), &c.run_id).map_err(|e| e.to_string())?.ok_or("unknown run")?;
    // The board has reported the run as over (its supervisor vanished, say, while the agent went
    // on), so its thread is no longer its own: nothing it asks for is done.
    if run.status == "exited" {
        return Err(format!("This run has ended on the board, so its {} call wasn't run. Stop here: the board no longer follows this run.", c.tool));
    }
    let task = db::get_task(&s.db(), &run.task_id).map_err(|e| e.to_string())?.ok_or("unknown task")?;
    // Whatever the run's tool list offers (see mcp::tools), a reviewer only reads.
    if task.kind == "review" && !mcp::for_reviewers(&c.tool) {
        return Err(format!("{} isn't available to reviewers: they can only read the board and submit_review", c.tool));
    }
    // Nor does a thread in plan mode, until its plan is approved (which changes its mode, see
    // permissions::mode_after_plan): the run's tool list was fixed when it started.
    if !mcp::for_planning(&c.tool) && planning(s, &task).map_err(|e| format!("{e:#}"))? {
        return Err(format!(
            "{} isn't available in plan mode: until the user approves your plan (present it with ExitPlanMode), you can only read the board, \
             wait and request_user_input",
            c.tool
        ));
    }
    let profile = db::get_profile(&s.db(), &task.profile_id).map_err(|e| e.to_string())?.ok_or("unknown profile")?;
    // Any other call means the run is working again (see wait.rs). Not a permission prompt:
    // subagents raise them too, and the agent's own tool calls end the wait before theirs.
    if !matches!(c.tool.as_str(), "wait" | "permission_prompt") {
        crate::wait::resumed(s, &task.id, &run.id);
    }
    match c.tool.as_str() {
        "permission_prompt" => {
            let tool_name = c.args["tool_name"].as_str().unwrap_or("").to_string();
            permissions::prompt(s, &task, &c.call_id, &tool_name, &c.args["input"], c.args["tool_use_id"].as_str()).await.map_err(|e| format!("{e:#}"))
        }
        "request_user_input" => {
            let card = crate::questions::card(&c.args)?;
            let question = card["question"].as_str().unwrap_or("The agent needs your input").to_string();
            s.db().execute("UPDATE runs SET attention=?1 WHERE id=?2", rusqlite::params![question, c.run_id]).map_err(|e| e.to_string())?;
            let options = card["options"].as_array().is_some_and(|o| !o.is_empty());
            crate::questions::ask(s, &task, &c.call_id, card).map_err(|e| format!("{e:#}"))?;
            let note = if options {
                "The user will be notified and shown your question with its options. End your turn now; their answer (the options \
                 they picked, or what they wrote) comes as their next message."
            } else {
                "The user will be notified. End your turn now with your question."
            };
            Ok(json!({"ok": true, "note": note}))
        }
        "submit_review" => crate::review::submit(s, &task, &run.id, &c.args).map_err(|e| e.1),
        "wait" => {
            let ctx = Ctx { profile_id: Some(profile.id), profile_name: profile.name, task: Some(task.clone()), call_id: None, task_fields: c.task_fields };
            let mut watched = Vec::new();
            // A call retried after a restart watches what it started with, even tasks since deleted.
            if crate::wait::resuming(&task, &c.call_id).is_none() {
                for r in c.args["tasks"].as_array().into_iter().flatten() {
                    let r = r.as_str().ok_or("tasks must be a list of task ids or keys")?;
                    let t = resolve_task(s, &ctx, r, None).map_err(|e| match e {
                        ToolError::NotFound(_) => format!("task {r} not found on this host (wait can only watch tasks on the host it runs on)"),
                        ToolError::Other(m) => m,
                    })?;
                    let key = format!("{}-{}", project_key(s, &t), t.number);
                    watched.push(db::WaitTask { id: t.id, key, status: t.status });
                }
            }
            let reason = c.args["reason"].as_str().map(String::from);
            let command = c.args["command"].as_str().map(str::trim).filter(|c| !c.is_empty()).map(String::from);
            // The command runs as the agent's own Bash calls would, so it's approved like them: in
            // auto mode the agent's reviewer (Claude's or Codex's) has already reviewed this call,
            // otherwise the user (or the mode) decides.
            if let (Some(cmd), None) = (&command, crate::wait::resuming(&task, &c.call_id))
                && !crate::runner::agent_reviews_waits(s, &run.id)
            {
                let cwd = crate::runner::work_dir(s, &task).map_err(|e| format!("{e:#}"))?;
                let description = format!("Run while waiting{}", reason.as_deref().map(|r| format!(": {r}")).unwrap_or_default());
                let input = json!({"command": cmd, "cwd": cwd, "description": description});
                let answer = permissions::prompt(s, &task, &c.call_id, "Bash", &input, None).await.map_err(|e| format!("{e:#}"))?;
                if answer["behavior"] != "allow" {
                    return Err(format!("The command wasn't approved, so the wait didn't start: {}", answer["message"].as_str().unwrap_or("denied")));
                }
            }
            // Read as the task's GitHub account, which isn't asked about: it only reads.
            let pull_request = match (&c.args["pull_request"], crate::wait::resuming(&task, &c.call_id)) {
                (Value::Null, _) | (_, Some(_)) => None,
                (Value::String(p), _) if p.trim().is_empty() => None,
                (pr, None) => Some(crate::pr_watch::request(s, &task, pr, &c.args["pull_request_events"]).await?),
            };
            let req = crate::wait::Request { reason, seconds: c.args["seconds"].as_f64(), tasks: watched, command, pull_request };
            let started = std::time::Instant::now();
            let (ended, wait) = crate::wait::wait(s, &run, &task, &c.call_id, req).await.map_err(|e| format!("{e:#}"))?;
            let changed: Vec<String> = match &ended {
                crate::wait::Ended::Tasks(ids) => wait.tasks.iter().filter(|w| ids.contains(&w.id)).map(|w| w.key.clone()).collect(),
                _ => Vec::new(),
            };
            let tasks: Vec<Value> = wait
                .tasks
                .iter()
                .map(|w| {
                    let t = db::get_task(&s.db(), &w.id).ok().flatten();
                    match t {
                        Some(t) => summary(s, &t),
                        None => json!({"id": w.id, "key": w.key, "deleted": true}),
                    }
                })
                .collect();
            let mut result = json!({
                "ended": ended.name(),
                "waited_seconds": started.elapsed().as_secs(),
                "note": crate::wait::note(&ended, &changed),
                "tasks": tasks,
            });
            if let crate::wait::Ended::Command { code, output } = &ended {
                result["command"] = json!({"exit_code": code, "output": output});
            }
            if let crate::wait::Ended::Subagent(agent) = &ended {
                result["subagent"] = agent.clone();
            }
            // Its news, whatever ended the wait, or else how it was when last read.
            if let Some(pr) = &wait.pull_request {
                result["pull_request"] = match &pr.news {
                    Some(news) => {
                        if !matches!(ended, crate::wait::Ended::PullRequest(_)) {
                            result["note"] = json!(format!("{} {}", result["note"].as_str().unwrap_or_default(), crate::pr_watch::note(news)));
                        }
                        news.clone()
                    }
                    None => crate::pr_watch::last(s, &task.id, pr).unwrap_or_else(|| json!({"url": pr.url, "number": pr.number})),
                };
            }
            Ok(result)
        }
        tool => {
            let ctx = Ctx {
                profile_id: Some(profile.id), profile_name: profile.name, task: Some(task), call_id: Some(c.call_id.clone()), task_fields: c.task_fields,
            };
            dispatch(s, &ctx, tool, c.args.clone()).await
        }
    }
}

/// Whether thread `task` is in plan mode now (its own mode, or the one it inherits).
fn planning(s: &Shared, task: &Task) -> anyhow::Result<bool> {
    let project = match &task.project_id {
        Some(pid) => db::get_project(&s.db(), pid)?,
        None => None,
    };
    let mode = task.effective_permission_mode(&s.db(), project.as_ref())?;
    Ok(mode == "plan")
}

/// A tool call forwarded from another host's agent in the profile named `profile_name`: run it
/// here only, on this host's profile of that name and those that let it in.
pub async fn handle_remote(s: &Shared, tool: &str, profile_name: &str, args: Value, task_fields: bool) -> std::result::Result<Value, String> {
    let profiles = db::list_profiles(&s.db()).map_err(|e| e.to_string())?;
    let own = profiles.iter().find(|p| p.name == profile_name);
    if own.is_none() && !profiles.iter().any(|p| p.grants(profile_name)) {
        return Err(format!("host {} has no profile named {profile_name}, and no profile there lets its agents in", s.host_name));
    }
    let ctx = Ctx { profile_id: own.map(|p| p.id.clone()), profile_name: profile_name.to_string(), task: None, call_id: None, task_fields };
    match local(s, &ctx, tool, &args).await {
        Ok(v) => Ok(v),
        Err(ToolError::NotFound(m)) => Err(format!("not found: {m}")),
        Err(ToolError::Other(m)) => Err(m),
    }
}

/// Run a board tool here, falling back to (or fanning out over) linked hosts.
async fn dispatch(s: &Shared, ctx: &Ctx, tool: &str, args: Value) -> std::result::Result<Value, String> {
    if let Some(h) = args["host"].as_str().filter(|h| !h.is_empty()) {
        if h != s.host_name && h != s.host_id {
            let link = hub::find_link(s, h).ok_or_else(|| format!("no linked host named {h}"))?;
            if let Some(e) = too_old(&link.name, link.version.lock().unwrap().api_version, tool, &args) {
                return Err(e);
            }
            return call_linked(s, &link, tool, &ctx.profile_name, &args, ctx.task_fields).await;
        }
        return local(s, ctx, tool, &args).await.map_err(msg);
    }
    let fan_out = tool == "list_projects" || (tool == "list_tasks" && (args["project_id"] == "all" || args["profile"] == "all"));
    if fan_out {
        // A profile that's only on other hosts isn't found here.
        let (mut all, mut missing) = match local(s, ctx, tool, &args).await {
            Ok(v) => (v.as_array().cloned().unwrap_or_default(), None),
            Err(ToolError::NotFound(m)) => (Vec::new(), Some(m)),
            Err(ToolError::Other(m)) => return Err(m),
        };
        for link in hub::connected_links(s) {
            match hub::call_tool(s, &link, tool, &ctx.profile_name, &args, ctx.task_fields).await {
                Ok(Value::Array(items)) => {
                    all.extend(items);
                    missing = None;
                }
                Ok(_) => {}
                Err(e) => tracing::debug!("{tool} on {}: {e}", link.name),
            }
        }
        return match missing {
            Some(m) if all.is_empty() => Err(format!("not found: {m}")),
            _ => Ok(Value::Array(all)),
        };
    }
    match local(s, ctx, tool, &args).await {
        Ok(v) => Ok(v),
        Err(ToolError::NotFound(m)) => {
            // Why a host that has it couldn't do it (e.g. a change that needs approval), rather
            // than "not found".
            let (mut refused, mut skipped) = (None, Vec::new());
            for link in hub::connected_links(s) {
                if too_old(&link.name, link.version.lock().unwrap().api_version, tool, &args).is_some() {
                    skipped.push(link.name.clone());
                    continue;
                }
                match call_linked(s, &link, tool, &ctx.profile_name, &args, ctx.task_fields).await {
                    Ok(v) => return Ok(v),
                    Err(e) if !e.starts_with("not found") => refused = refused.or(Some(e)),
                    Err(_) => {}
                }
            }
            Err(match (refused, skipped.is_empty()) {
                (Some(e), _) => e,
                (None, true) => format!("not found: {m}"),
                (None, false) => format!("not found: {m} ({} run an older build that can't do this, so they weren't asked)", skipped.join(", ")),
            })
        }
        Err(ToolError::Other(m)) => Err(m),
    }
}

/// The API version from which update_project takes every setting (and asks for approval).
const PROJECT_SETTINGS_API: u32 = 44;

/// The API version from which update_project can move a project's folder (move_repo).
const MOVE_REPO_API: u32 = 45;

/// The API version from which create_task and update_task take `starred`, `remind_at` and `reminder`.
const MARKS_API: u32 = 48;

/// The API version from which hosts have delete_task.
const DELETE_TASK_API: u32 = 58;

/// The API version from which task details are bounded and get_task_field is available.
const TASK_FIELDS_API: u32 = 59;

/// The API version from which hosts have the automation tools.
const AUTOMATIONS_API: u32 = 67;

const AUTOMATION_TOOLS: &[&str] = &["list_automations", "create_automation", "update_automation", "delete_automation", "run_automation"];

pub const TASK_FIELD_DEFAULT_LIMIT: usize = 2000;
pub const TASK_FIELD_MAX_LIMIT: usize = 4000;

/// Older hosts return the full details from get_task. Bound or page that response here so
/// agents can still read their tasks without exposing the oversized legacy tool result.
async fn call_linked(s: &Shared, link: &hub::LinkConn, tool: &str, profile: &str, args: &Value, task_fields: bool) -> std::result::Result<Value, String> {
    let legacy = link.version.lock().unwrap().api_version < TASK_FIELDS_API;
    if legacy && matches!(tool, "get_task" | "get_task_field") {
        let details = hub::call_tool(s, link, "get_task", profile, &json!({"task_id": args["task_id"], "profile": args["profile"]}), false).await?;
        return if tool == "get_task_field" { task_field(&details, args).map_err(msg) }
            else if task_fields { Ok(task_overview(details)) } else { Ok(details) };
    }
    hub::call_tool(s, link, tool, profile, args, task_fields).await
}

/// Why `tool` can't go to linked host `host`, on API `api_version`: it runs a build from before
/// it could do this (one that would ignore the settings it doesn't know rather than say so).
fn too_old(host: &str, api_version: u32, tool: &str, args: &Value) -> Option<String> {
    let move_repo = tool == "update_project" && !args["move_repo"].is_null();
    // Clearing them (false, "") too: an older host would say it had.
    let marks = ["create_task", "update_task"].contains(&tool) && api::MARK_FIELDS.iter().any(|k| !args[*k].is_null());
    if marks && api_version < MARKS_API {
        return Some(format!("{host} runs an older build that can't star tasks or set reminders; ask the user to update it"));
    }
    if tool == "delete_task" && api_version < DELETE_TASK_API {
        return Some(format!("{host} runs an older build that can't delete tasks; ask the user to delete it on the board"));
    }
    if AUTOMATION_TOOLS.contains(&tool) && api_version < AUTOMATIONS_API {
        return Some(format!("{host} runs an older build without the automation tools; ask the user to update it, or to set it up in the project's settings"));
    }
    (needs_project_settings_api(tool, args) && api_version < PROJECT_SETTINGS_API || move_repo && api_version < MOVE_REPO_API)
        .then(|| format!("{host} runs an older build that can't do this with {tool}; ask the user to update it, or to make the change in the project's settings"))
}

/// Whether a host needs PROJECT_SETTINGS_API for this call: update_project with a setting it
/// couldn't change before.
fn needs_project_settings_api(tool: &str, args: &Value) -> bool {
    const OLD_FIELDS: &[&str] = &["start_prompt", "review_prompt", "merge_prompt", "auto_review", "review_rounds", "reviewers", "group_name"];
    tool == "update_project" && AGENT_FIELDS.iter().chain(APPROVAL_FIELDS).any(|k| !OLD_FIELDS.contains(k) && !args[*k].is_null())
}

// ---------- the tools ----------

async fn local(s: &Shared, ctx: &Ctx, tool: &str, args: &Value) -> ToolResult {
    let str_arg = |k: &str| args[k].as_str().filter(|v| !v.is_empty()).map(String::from);
    let profile = str_arg("profile");
    let profile = profile.as_deref();
    // The caller's own project and subproject are defaults only on its own board.
    let own_task = ctx.task.as_ref().filter(|_| profile.is_none());
    let own_project = own_task.and_then(|t| t.project_id.clone());
    // The subproject the caller is (or works in): where its new tasks go by default.
    let own_subproject = match own_task {
        Some(t) if t.subproject => Some(t.clone()),
        Some(t) => db::subproject_of(&s.db(), t)?,
        None => None,
    };
    match tool {
        "list_projects" => {
            let mut out = Vec::new();
            for b in pick_boards(s, ctx, profile)? {
                // Archived ones are off the board until the user unarchives them.
                for p in db::list_projects(&s.db(), &b.id)?.into_iter().filter(|p| p.archived_at.is_none()) {
                    out.push(project_json(s, &p, &b));
                }
            }
            Ok(json!(out))
        }
        "list_tasks" => {
            let in_subproject = match str_arg("subproject").as_deref() {
                Some("all") => None,
                Some("none") => Some(None),
                Some(k) => Some(Some(subproject_arg(s, ctx, k, profile)?)),
                // A subproject's agents see its tasks unless they ask for more.
                None if str_arg("project_id").is_none() => own_subproject.clone().map(Some),
                None => None,
            };
            let pid = str_arg("project_id").or_else(|| in_subproject.clone().flatten().and_then(|p| p.project_id)).or(own_project);
            let tasks = match pid.as_deref() {
                // Every task on the named board(s), else on the caller's own.
                None | Some("all") => {
                    let all = pick_boards(s, ctx, profile)?;
                    let boards: Vec<_> = match profile {
                        None if all.iter().any(|b| ctx.is_own(b)) => all.into_iter().filter(|b| ctx.is_own(b)).collect(),
                        _ => all,
                    };
                    let mut tasks = Vec::new();
                    for b in boards {
                        let archived: Vec<String> = db::list_projects(&s.db(), &b.id)?.into_iter().filter(|p| p.archived_at.is_some()).map(|p| p.id).collect();
                        let list = db::list_tasks_for_profile(&s.db(), &b.id)?;
                        tasks.extend(list.into_iter().filter(|t| t.project_id.as_ref().is_none_or(|p| !archived.contains(p))));
                    }
                    tasks
                }
                Some(pid) => {
                    let p = resolve_project(s, ctx, pid, profile)?;
                    db::list_tasks_for_project(&s.db(), &p.id, "task")?
                }
            };
            let status = str_arg("status");
            Ok(json!(tasks
                .iter()
                .filter(|t| status.as_deref().is_none_or(|st| t.status == st))
                .filter(|t| in_subproject.as_ref().is_none_or(|sp| t.parent_id.as_deref() == sp.as_ref().map(|p| p.id.as_str())))
                .map(|t| summarize(s, t))
                .collect::<Vec<_>>()))
        }
        "get_task" | "get_task_field" => {
            let t = resolve_task(s, ctx, &str_arg("task_id").unwrap_or_default(), profile)?;
            let details = task_details(s, ctx, &t)?;
            if tool == "get_task_field" {
                task_field(&details, args)
            } else if ctx.task_fields {
                Ok(task_overview(details))
            } else {
                // Old helpers and linked hosts cannot offer the field tool. Keep all details
                // available to them, including calls forwarded by an upgraded host.
                Ok(details)
            }
        }
        // A scratch task is in no project unless it's given one (or a subproject); the
        // caller's own project isn't a default for it, as it wasn't before scratch tasks could be in one.
        "create_task" if str_arg("type").as_deref() == Some(db::SCRATCH) && str_arg("project_id").is_none() && str_arg("subproject").is_none_or(|sp| sp == "none") => {
            if args["is_subproject"].as_bool() == Some(true) {
                return Err(ToolError::Other("a scratch task can't be a subproject".into()));
            }
            // On the caller's own board unless it names another.
            let boards = pick_boards(s, ctx, profile)?;
            let board = match profile {
                None => boards.iter().find(|b| ctx.is_own(b)).or(boards.first()),
                Some(_) => boards.first(),
            }
            .ok_or_else(|| ToolError::NotFound("your profile's board".into()))?;
            let body = CreateTask {
                title: str_arg("title").unwrap_or_default(),
                description: str_arg("description").unwrap_or_default(),
                status: str_arg("status"),
                resolution: str_arg("resolution"),
                start: args["start"].as_bool().filter(|b| *b).map(Value::Bool),
                labels: Some(args["labels"].clone()),
                ..Default::default()
            };
            let marks = new_task_marks(args)?;
            let t = api::create_scratch_task_inner(s, &board.id, body)?;
            Ok(summarize(s, &created(s, ctx, t, &marks)?))
        }
        "create_task" => {
            let parent = match str_arg("subproject").as_deref() {
                Some("none") => None,
                Some(k) => Some(subproject_arg(s, ctx, k, profile)?),
                None => None,
            };
            let project = match str_arg("project_id") {
                Some(pid) => resolve_project(s, ctx, &pid, profile)?,
                None => {
                    let pid = parent
                        .as_ref()
                        .and_then(|p| p.project_id.clone())
                        .or(own_project)
                        .ok_or_else(|| ToolError::Other("project_id is required (use list_projects)".into()))?;
                    db::get_project(&s.db(), &pid)?.ok_or_else(|| ToolError::NotFound(format!("project {pid}")))?
                }
            };
            // Tasks created from a subproject (or one of its tasks) go in it, unless they're for another project.
            let parent = match str_arg("subproject") {
                Some(_) => parent,
                None => own_subproject.filter(|sp| sp.project_id.as_deref() == Some(project.id.as_str())),
            };
            let body = CreateTask {
                parent_id: parent.map(|p| p.id),
                subproject: args["is_subproject"].as_bool(),
                title: str_arg("title").unwrap_or_default(),
                description: str_arg("description").unwrap_or_default(),
                status: str_arg("status"),
                resolution: str_arg("resolution"),
                use_worktree: args["use_worktree"].as_bool(),
                model: None,
                effort: None,
                kind: None,
                start: args["start"].as_bool().filter(|b| *b).map(Value::Bool),
                // The project's profile's default, so its agent runs with that profile's login.
                claude_config_id: None,
                depends_on: dependency_ids(s, ctx, &args["depends_on"], profile)?,
                task_type: str_arg("type"),
                labels: Some(args["labels"].clone()),
                external_links: None,
                fanout_id: None,
            };
            let marks = new_task_marks(args)?;
            let t = api::create_task_inner(s, &project.id, body)?;
            Ok(summarize(s, &created(s, ctx, t, &marks)?))
        }
        "update_task" => {
            let t = resolve_task(s, ctx, &str_arg("task_id").unwrap_or_default(), profile)?;
            let mut body = Map::new();
            for k in ["title", "description", "status", "resolution", "preview_url", "pr_url", "remerge", "labels"] {
                if !args[k].is_null() {
                    body.insert(k.into(), args[k].clone());
                }
            }
            if let Some(ids) = dependency_ids(s, ctx, &args["depends_on"], profile)? {
                body.insert("depends_on".into(), json!(ids));
            }
            body.extend(reminder_args(args)?);
            let t = api::update_task_inner(s, &t.id, &body).await?;
            Ok(summarize(s, &t))
        }
        "delete_task" => {
            // A call retried after a restart carries on with the deletion it asked about.
            let input = match ctx.call_id.as_deref().map(|c| permissions::asked(s, c)).transpose()?.flatten() {
                Some(saved) => saved,
                None => {
                    let t = resolve_task(s, ctx, &str_arg("task_id").unwrap_or_default(), profile)?;
                    deletion(s, ctx, &t, args["delete_branch"].as_bool().unwrap_or(false), str_arg("reason"))?
                }
            };
            delete_task(s, ctx, &input).await
        }
        "send_to_task" => {
            let t = resolve_task(s, ctx, &str_arg("task_id").unwrap_or_default(), profile)?;
            if ctx.task.as_ref().is_some_and(|own| own.id == t.id) {
                return Err(ToolError::Other("cannot send a message to your own task".into()));
            }
            let t = runner::send_from_agent(s, &t.id, &str_arg("message").unwrap_or_default())?;
            Ok(summarize(s, &t))
        }
        "get_project" | "update_project" => {
            // A call retried after a restart carries on with the approval it asked for, and the
            // project it was for, whatever has changed since.
            if tool == "update_project"
                && let Some(saved) = ctx.call_id.as_deref().map(|c| permissions::asked(s, c)).transpose()?.flatten()
            {
                return resume_approval(s, ctx, &saved).await;
            }
            let p = match str_arg("project_id") {
                Some(pid) => resolve_project(s, ctx, &pid, profile)?,
                None => {
                    let pid = own_project.ok_or_else(|| ToolError::Other("project_id is required (use list_projects)".into()))?;
                    db::get_project(&s.db(), &pid)?.ok_or_else(|| ToolError::NotFound(format!("project {pid}")))?
                }
            };
            let board = db::get_profile(&s.db(), &p.profile_id)?.ok_or_else(|| ToolError::NotFound("profile".into()))?;
            let p = if tool == "update_project" { update_project(s, ctx, &p, args, str_arg("reason")).await? } else { p };
            Ok(project_settings_json(s, &p, &board))
        }
        "create_project" => {
            // A call retried after a restart carries on with the approval it asked for.
            if let Some(saved) = ctx.call_id.as_deref().map(|c| permissions::asked(s, c)).transpose()?.flatten() {
                return create_project(s, ctx, &saved).await;
            }
            let boards = pick_boards(s, ctx, profile)?;
            let board = match profile {
                Some(_) => boards.into_iter().next(),
                None => boards.into_iter().find(|b| ctx.is_own(b)),
            };
            let board = board.ok_or_else(|| ToolError::NotFound(format!("profile {} on host {}", ctx.profile_name, s.host_name)))?;
            let input = project_creation(s, ctx, &board, str_arg("name"), &str_arg("repo_path").unwrap_or_default(), str_arg("reason")).await?;
            create_project(s, ctx, &input).await
        }
        "list_automations" => {
            let p = project_or_own(s, ctx, str_arg("project_id"), profile, own_project)?;
            let list = crate::automations::list(&s.db(), &p.id)?;
            let list: Vec<Value> = list.iter().map(|a| automation_json(s, a)).collect();
            Ok(json!({"project": {"id": p.id, "key": p.key, "name": p.name}, "automations": list, "time_zone": crate::automations::time_zone()}))
        }
        "create_automation" | "update_automation" | "delete_automation" => {
            // A call retried after a restart carries on with the approval it asked for.
            if let Some(saved) = ctx.call_id.as_deref().map(|c| permissions::asked(s, c)).transpose()?.flatten() {
                return change_automation(s, ctx, &saved).await;
            }
            let input = match tool {
                "create_automation" => {
                    let p = project_or_own(s, ctx, str_arg("project_id"), profile, own_project)?;
                    automation_creation(s, ctx, &p, args, profile)?
                }
                "update_automation" => {
                    let (a, p) = resolve_automation(s, ctx, args, profile, own_project)?;
                    match automation_update(s, ctx, &a, &p, args, profile)? {
                        Ok(input) => input,
                        // Nothing that needs asking: turning it off, or renaming it.
                        Err(apply) => {
                            let a = crate::automations::update(s, &a.id, &apply)?;
                            return Ok(automation_json(s, &a));
                        }
                    }
                }
                _ => {
                    let (a, p) = resolve_automation(s, ctx, args, profile, own_project)?;
                    let mut input = automation_input(s, ctx, "delete", &p, automation_view(s, &a.id, &a.name, a.enabled, &a.trigger, &a.action, has_secret(&a)));
                    input["reason"] = json!(str_arg("reason"));
                    input
                }
            };
            change_automation(s, ctx, &input).await
        }
        "run_automation" => {
            let (a, _) = resolve_automation(s, ctx, args, profile, own_project)?;
            let event = str_arg("event");
            let run = crate::automations::run_now(s, &a, crate::automations::RunNow { payload: args.get("payload").filter(|p| !p.is_null()).cloned(), event }).await?;
            Ok(crate::automations::run_json(&s.db(), &run))
        }
        other => Err(ToolError::Other(format!("unknown tool {other}"))),
    }
}

/// The project an agent names (on a board it can use), or its own.
fn project_or_own(s: &Shared, ctx: &Ctx, pid: Option<String>, profile: Option<&str>, own: Option<String>) -> std::result::Result<db::Project, ToolError> {
    match pid {
        Some(pid) => resolve_project(s, ctx, &pid, profile),
        None => {
            let pid = own.ok_or_else(|| ToolError::Other("project_id is required (use list_projects)".into()))?;
            db::get_project(&s.db(), &pid)?.ok_or_else(|| ToolError::NotFound(format!("project {pid}")))
        }
    }
}

/// The settings `update_project` changes without asking: how the project's agents are
/// prompted and reviewed, and what it's called and where on the board it is.
const AGENT_FIELDS: &[&str] = &[
    "name", "key", "base_branch", "model", "start_prompt", "review_prompt", "merge_prompt", "auto_review", "review_rounds", "reviewers", "auto_summary",
    "summarizer", "group_name",
];

/// The settings it only changes once the user approves: they run commands on the host, decide
/// what agents may do without asking, move where the work happens, or bring the repository's
/// ignored files (secrets, say) into worktrees.
pub const APPROVAL_FIELDS: &[&str] =
    &["permission_mode", "setup_script", "teardown_script", "copy_files", "link_folders", "status_script", "status_scripts", "repo_path", "move_repo", "use_worktrees", "worktrees_root"];

/// `update_project`: the changes in `args`, asking the user first if any of them need it.
/// Nothing changes if they don't approve.
async fn update_project(s: &Shared, ctx: &Ctx, p: &db::Project, args: &Value, reason: Option<String>) -> std::result::Result<db::Project, ToolError> {
    if !args["claude_config_ids"].is_null() {
        return Err(ToolError::Other("a project's agent configs can only be changed by the user, in the project's settings".into()));
    }
    let mut body = Map::new();
    for k in AGENT_FIELDS.iter().chain(APPROVAL_FIELDS) {
        let v = &args[*k];
        // An explicit null summarizer or reviewers goes back to the profile's.
        if v.is_null() && !(["reviewers", "summarizer"].contains(k) && args.get(*k).is_some()) {
            continue;
        }
        if ["name", "key", "repo_path"].contains(k) && v.as_str().is_none_or(|v| v.trim().is_empty()) {
            return Err(ToolError::Other(format!("{k} can't be blank")));
        }
        // A blank one goes back to the default.
        let v = if ["base_branch", "model", "permission_mode"].contains(k) && v.as_str().is_some_and(|v| v.trim().is_empty()) { Value::Null } else { v.clone() };
        body.insert((*k).into(), v);
    }
    if body.is_empty() {
        return Err(ToolError::Other("nothing to change".into()));
    }
    // What would change, found by making the change and rolling it back, so it's judged on what
    // the project would be, however each setting is stored. Checked before asking, so the user
    // only sees changes that can be made.
    let fields = api::project_fields(s, p, &body).await?;
    let after = db::preview_project_update(&s.db(), &p.id, &fields)?.ok_or_else(|| ToolError::NotFound(format!("project {}", p.id)))?;
    let (before, after) = (json!(p), json!(after));
    let mut changed: Vec<&str> = fields.iter().map(|(k, _)| *k).filter(|k| before[*k] != after[*k]).collect();
    // A new repository path has to be the project's folder, or where it can move to.
    let move_repo = args["move_repo"].as_bool().unwrap_or(false);
    if changed.contains(&"repo_path") {
        relocate::check(s, p, std::path::Path::new(after["repo_path"].as_str().unwrap_or_default()), move_repo).await?;
        if move_repo {
            changed.push("move_repo");
        }
    } else if move_repo {
        return Err(ToolError::Other("move_repo needs a new repo_path to move the folder to".into()));
    }
    // Only what differs, so a setting left as it was can't overwrite a change made meanwhile;
    // with approval, exactly what the user saw.
    let apply: Map<String, Value> = changed.iter().map(|k| (k.to_string(), body[*k].clone())).collect();
    if changed.iter().any(|k| APPROVAL_FIELDS.contains(k)) {
        let change = |k: &str| match k {
            "move_repo" => json!({"field": k, "from": false, "to": true, "needs_approval": true}),
            _ => json!({"field": k, "from": before[k], "to": after[k], "needs_approval": APPROVAL_FIELDS.contains(&k)}),
        };
        let changes: Vec<Value> = changed.iter().map(|k| change(k)).collect();
        let input = json!({"project": approval_project(s, p), "task": approval_task(s, ctx), "changes": changes, "apply": apply, "reason": reason});
        let approved = ask_user(s, ctx, "update_project", &input).await?;
        return apply_changes(s, p, &approved["apply"]).await;
    }
    apply_changes(s, p, &json!(apply)).await
}

/// What `create_project` asks the user to approve: adding the folder `repo_path` (created if it's
/// missing) as a project named `name` on `board`. Its tasks' agents work in that folder, with the
/// host's default permission mode, so the user sees where it is first.
async fn project_creation(s: &Shared, ctx: &Ctx, board: &db::Profile, name: Option<String>, repo_path: &str, reason: Option<String>) -> ToolResult {
    let given = crate::util::expand_tilde(repo_path.trim());
    if !given.is_absolute() {
        return Err(ToolError::Other("repo_path must be an absolute path, or start with ~/".into()));
    }
    // The folder as it would be added: symlinks resolved, as far as it exists.
    let mut missing = Vec::new();
    let mut existing = given.as_path();
    while !existing.exists() {
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => {
                missing.push(name.to_owned());
                existing = parent;
            }
            // `..` in the part that doesn't exist yet would hide where it ends up.
            _ => return Err(ToolError::Other(format!("{} isn't a folder that exists or can be created", given.display()))),
        }
    }
    let path = missing.iter().rev().fold(existing.canonicalize().map_err(|e| ToolError::Other(format!("{}: {e}", existing.display())))?, |p, c| p.join(c));
    if missing.is_empty() && !path.is_dir() {
        return Err(ToolError::Other(format!("{} is not a directory", path.display())));
    }
    let name = name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
    let name = name.unwrap_or_else(|| path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "Project".into()));
    let key = api::new_project_key(s, &board.id, &name)?;
    let repo_path = path.to_string_lossy().to_string();
    let git = missing.is_empty() && crate::worktree::is_git_repo(&path).await;
    let permission_mode = db::get_setting(&s.db(), "default_permission_mode")?.unwrap_or_else(|| "default".into());
    Ok(json!({
        "op": "create",
        "project": {"id": "", "key": key, "name": name, "host": s.host_name},
        "task": approval_task(s, ctx),
        "board": board.name,
        "repo_path": repo_path,
        "exists": missing.is_empty(),
        "git": git,
        "permission_mode": permission_mode,
        // As a change from nothing, for UIs from before creations were asked about.
        "changes": [
            {"field": "name", "from": null, "to": name, "needs_approval": false},
            {"field": "repo_path", "from": null, "to": repo_path, "needs_approval": true},
        ],
        "apply": {"profile_id": board.id, "name": name, "repo_path": repo_path},
        "reason": reason,
    }))
}

/// Asks the user to approve the project `input` describes (see project_creation), or carries on
/// waiting for the answer if this call asked before it was retried, then adds it if they approve.
async fn create_project(s: &Shared, ctx: &Ctx, input: &Value) -> ToolResult {
    let approved = ask_user(s, ctx, "create_project", input).await?;
    let apply = &approved["apply"];
    let profile_id = apply["profile_id"].as_str().unwrap_or_default();
    let board = db::get_profile(&s.db(), profile_id)?.ok_or_else(|| ToolError::NotFound(format!("profile {profile_id}")))?;
    let body = CreateProject {
        name: apply["name"].as_str().unwrap_or_default().into(),
        repo_path: apply["repo_path"].as_str().unwrap_or_default().into(),
        key: None,
        base_branch: None,
        use_worktrees: None,
    };
    let p = api::create_project_inner(s, &board.id, body).await?;
    Ok(project_json(s, &p, &board))
}

/// Makes `apply` (update_project's arguments that change something) to project `p`.
async fn apply_changes(s: &Shared, p: &db::Project, apply: &Value) -> std::result::Result<db::Project, ToolError> {
    match apply.as_object() {
        Some(apply) if !apply.is_empty() => Ok(api::update_project_inner(s, &p.id, apply).await?),
        _ => Ok(p.clone()),
    }
}

/// Carries on with the approval `saved` that this call asked for before it was retried: waits
/// for the answer if there isn't one yet, then makes exactly what was asked, if approved.
async fn resume_approval(s: &Shared, ctx: &Ctx, saved: &Value) -> ToolResult {
    let approved = ask_user(s, ctx, "update_project", saved).await?;
    let pid = approved["project"]["id"].as_str().unwrap_or_default();
    let p = db::get_project(&s.db(), pid)?.ok_or_else(|| ToolError::NotFound(format!("project {pid}")))?;
    let p = apply_changes(s, &p, &approved["apply"]).await?;
    let board = db::get_profile(&s.db(), &p.profile_id)?.ok_or_else(|| ToolError::NotFound("profile".into()))?;
    Ok(project_settings_json(s, &p, &board))
}

/// What an approval asks for, for the agent, e.g. "changing setup_script" or "deleting KIW-2".
fn approval_what(tool: &str, input: &Value) -> String {
    if tool == "create_project" {
        return format!("adding {} as a project", input["repo_path"].as_str().unwrap_or("the folder"));
    }
    if tool == "delete_task" {
        return format!("deleting {}", input["delete"]["key"].as_str().unwrap_or("the task"));
    }
    if let Some(op) = tool.strip_suffix("_automation") {
        let verb = match op {
            "create" => "creating",
            "update" => "changing",
            _ => "deleting",
        };
        return format!("{verb} the automation \"{}\"", input["automation"]["name"].as_str().unwrap_or_default());
    }
    let fields: Vec<&str> = input["changes"].as_array().into_iter().flatten().filter(|c| c["needs_approval"] == true).filter_map(|c| c["field"].as_str()).collect();
    format!("changing {}", fields.join(", "))
}

/// Asks the user to approve what `input` describes for `tool` (update_project, delete_task or an
/// automation tool) in the calling agent's thread, and waits for their answer: the input they approved.
async fn ask_user(s: &Shared, ctx: &Ctx, tool: &str, input: &Value) -> std::result::Result<Value, ToolError> {
    let what = approval_what(tool, input);
    let (kind, of, instead, nothing) = match tool {
        "delete_task" => ("delete_task", "task", "ask the user to delete it on the board", "deleted"),
        "create_automation" => ("automation", "project", "ask the user to add it in the project's settings (Automations)", "created"),
        "update_automation" | "delete_automation" => ("automation", "project", "ask the user to do it in the project's settings (Automations)", "changed"),
        "create_project" => ("project", "board", "ask the user to add it on the board", "added"),
        _ => ("project", "project", "ask the user to do it in the project's settings", "changed"),
    };
    let (Some(task), Some(call_id)) = (&ctx.task, &ctx.call_id) else {
        // Agents on other hosts have no thread here to ask in.
        return Err(ToolError::Other(format!("{what} needs the user's approval, which only an agent on the {of}'s own host can ask for; {instead}")));
    };
    match permissions::approve(s, task, call_id, kind, tool, input).await? {
        Ok(approved) => Ok(approved),
        Err(note) => Err(ToolError::Other(format!("The user didn't approve {what}, so nothing was {nothing}: {note}"))),
    }
}

/// What `delete_task` asks the user to confirm: deleting `t`, and a subproject's tasks with it.
fn deletion(s: &Shared, ctx: &Ctx, t: &Task, delete_branch: bool, reason: Option<String>) -> ToolResult {
    let with_it = if t.subproject { db::subproject_tasks(&s.db(), &t.id)? } else { Vec::new() };
    if let Some(own) = &ctx.task {
        if own.id == t.id {
            return Err(ToolError::Other("you can't delete your own task".into()));
        }
        if with_it.iter().any(|c| c.id == own.id) {
            return Err(ToolError::Other("you can't delete the subproject you're in".into()));
        }
    }
    let project = t.project_id.as_deref().map(|pid| db::get_project(&s.db(), pid)).transpose()?.flatten();
    let item = |t: &Task| json!({"id": t.id, "key": format!("{}-{}", project_key(s, t), t.number), "title": t.title, "status": t.status});
    let mut delete = item(t);
    delete["branch"] = json!(t.branch);
    delete["running"] = json!(s.is_running(&t.id));
    delete["subproject"] = json!(t.subproject);
    Ok(json!({
        "project": project.map(|p| approval_project(s, &p)),
        "task": approval_task(s, ctx),
        "delete": delete,
        "tasks_with_it": with_it.iter().map(item).collect::<Vec<_>>(),
        "delete_branch": delete_branch,
        "reason": reason,
    }))
}

/// `delete_task`: deletes what `input` (see `deletion`) describes once the user confirms it.
async fn delete_task(s: &Shared, ctx: &Ctx, input: &Value) -> ToolResult {
    let (id, key) = (input["delete"]["id"].as_str().unwrap_or_default(), input["delete"]["key"].as_str().unwrap_or_default());
    let gone = |s: &Shared| db::get_task(&s.db(), id).map(|t| t.is_none());
    let already = json!({"deleted": false, "key": key, "note": "It was deleted meanwhile (not by this call)."});
    let approved = match ask_user(s, ctx, "delete_task", input).await {
        Ok(a) => a,
        // Deleted while the user was asked, which settles the question.
        Err(_) if gone(s)? => return Ok(already),
        Err(e) => return Err(e),
    };
    // No task can be added to it from here on, so what's checked below is what goes.
    let _deleting = api::Deleting::new(s, id);
    let Some(t) = db::get_task(&s.db(), id)? else { return Ok(already) };
    let delete_branch = approved["delete_branch"].as_bool().unwrap_or(false);
    // Only the tasks the user was shown go with it: a subproject's tasks added since (or an
    // ordinary task made a subproject since) need asking again.
    let shown: Vec<&str> = approved["tasks_with_it"].as_array().into_iter().flatten().filter_map(|c| c["id"].as_str()).collect();
    // Every task in it, whether or not it's (still) a subproject, as they'd all go with it.
    let children = db::subproject_tasks(&s.db(), &t.id)?;
    let unshown: Vec<String> = children.iter().filter(|c| !shown.contains(&c.id.as_str())).map(|c| format!("{}-{}", project_key(s, c), c.number)).collect();
    if !unshown.is_empty() {
        return Err(ToolError::Other(format!(
            "{} became tasks of {key} while the user was asked, so nothing was deleted; call delete_task again so the user can confirm deleting them too",
            unshown.join(", ")
        )));
    }
    for c in &children {
        api::delete_one(s, c, delete_branch).await?;
    }
    api::delete_last(s, &t, delete_branch).await?;
    Ok(json!({"deleted": true, "key": key, "title": t.title, "tasks_deleted_with_it": children.len()}))
}

// ---------- automations ----------

/// The automation an agent names in `automation_id`: its id, or its name in `project_id` (or
/// the agent's own project). Only one in a project on a board the agent can use.
fn resolve_automation(
    s: &Shared, ctx: &Ctx, args: &Value, profile: Option<&str>, own_project: Option<String>,
) -> std::result::Result<(crate::automations::Automation, db::Project), ToolError> {
    let r = args["automation_id"].as_str().map(str::trim).unwrap_or_default();
    let by_id = crate::automations::get(&s.db(), r)?;
    if let Some(a) = by_id {
        let p = db::get_project(&s.db(), &a.project_id)?;
        if let Some(p) = p.filter(|p| boards(s, ctx).is_ok_and(|b| b.iter().any(|b| b.id == p.profile_id))) {
            return Ok((a, p));
        }
        return Err(ToolError::NotFound(format!("automation {r}")));
    }
    let p = project_or_own(s, ctx, args["project_id"].as_str().filter(|p| !p.is_empty()).map(String::from), profile, own_project)?;
    let named: Vec<_> = crate::automations::list(&s.db(), &p.id)?.into_iter().filter(|a| a.name.eq_ignore_ascii_case(r)).collect();
    match named.len() {
        0 => Err(ToolError::NotFound(format!("automation {r} in {} (use list_automations)", p.key))),
        1 => Ok((named.into_iter().next().unwrap(), p)),
        _ => Err(ToolError::Other(format!("{} has several automations named {r}; give its id (see list_automations)", p.key))),
    }
}

fn has_secret(a: &crate::automations::Automation) -> bool {
    a.secret.as_deref().is_some_and(|s| !s.is_empty())
}

/// An automation as list_automations shows it, with its webhook's full URL when the host's
/// public_url is set.
fn automation_json(s: &Shared, a: &crate::automations::Automation) -> Value {
    let c = s.db();
    let mut v = crate::automations::to_json(&c, a);
    if a.is_webhook() {
        match db::get_setting(&c, "public_url").ok().flatten().filter(|u| !u.is_empty()) {
            Some(url) => v["webhook_url"] = json!(format!("{url}{}", a.hook_path())),
            None => v["webhook_note"] = json!("hook_path is on this host; the full URL depends on how it's reached from outside (the host's public_url setting isn't set)"),
        }
    }
    v
}

/// An automation as its approval shows it: what it is, and the task its message goes to and
/// the agent config its tasks use, by name.
#[allow(clippy::too_many_arguments)]
fn automation_view(
    s: &Shared, id: &str, name: &str, enabled: bool, trigger: &crate::automations::Trigger, action: &crate::automations::Action, signed: bool,
) -> Value {
    use crate::automations::Action;
    let mut v = json!({"id": id, "name": name, "enabled": enabled, "trigger": trigger, "action": action, "signed": signed});
    match action {
        Action::SendToTask { task_id, .. } => {
            let t = db::get_task(&s.db(), task_id).ok().flatten();
            if let Some(t) = t {
                v["target"] = json!({"id": t.id, "key": format!("{}-{}", project_key(s, &t), t.number), "title": t.title, "status": t.status});
            }
        }
        Action::CreateTask { claude_config_id: Some(id), .. } => {
            let c = db::get_claude_config(&s.db(), id).ok().flatten();
            if let Some(c) = c {
                v["config"] = json!({"id": c.id, "name": c.name, "agent": c.agent});
            }
        }
        Action::CreateTask { .. } => {}
    }
    v
}

/// What an automation approval asks: `op` (create, update or delete) on `automation` (see
/// automation_view) in project `p`, asked by the calling agent, with the time zone its times of
/// day are in.
fn automation_input(s: &Shared, ctx: &Ctx, op: &str, p: &db::Project, automation: Value) -> Value {
    let time_zone = crate::automations::time_zone();
    json!({"op": op, "project": approval_project(s, p), "task": approval_task(s, ctx), "automation": automation, "time_zone": time_zone})
}

/// An automation's action as an agent gives it, checked against project `p`: a message's task
/// can be named by key, and has to be one of the project's.
fn automation_action(s: &Shared, ctx: &Ctx, p: &db::Project, v: &Value, profile: Option<&str>) -> std::result::Result<crate::automations::Action, ToolError> {
    use crate::automations::{self as au, Action};
    let action = match au::parse::<Action>("action", v)? {
        Action::SendToTask { task_id, message } => {
            let t = resolve_task(s, ctx, task_id.trim(), profile).map_err(|e| match e {
                ToolError::NotFound(_) => ToolError::Other(format!("task {task_id} not found in {}", p.key)),
                e => e,
            })?;
            Action::SendToTask { task_id: t.id, message }
        }
        a => a,
    };
    Ok(au::check_action(&s.db(), p, action)?)
}

/// What `create_automation` asks the user to approve: the automation, checked.
fn automation_creation(s: &Shared, ctx: &Ctx, p: &db::Project, args: &Value, profile: Option<&str>) -> ToolResult {
    use crate::automations as au;
    let name = au::check_name(&args["name"])?;
    let trigger = au::check_trigger(au::parse("trigger", &args["trigger"])?)?;
    let action = automation_action(s, ctx, p, &args["action"], profile)?;
    let enabled = args["enabled"].as_bool().unwrap_or(true);
    let generate_secret = args["generate_secret"].as_bool().unwrap_or(false);
    if generate_secret && !matches!(trigger, au::Trigger::Webhook { .. }) {
        return Err(ToolError::Other("only a webhook can have a secret".into()));
    }
    let view = automation_view(s, "", &name, enabled, &trigger, &action, generate_secret);
    let mut input = automation_input(s, ctx, "create", p, view);
    input["apply"] = json!({"name": name, "enabled": enabled, "trigger": trigger, "action": action, "generate_secret": generate_secret});
    input["reason"] = args["reason"].clone();
    Ok(input)
}

/// What `update_automation` asks the user to approve (Ok), or the change to make without asking
/// (Err): turning the automation off, or renaming it. Only what differs is changed, so a
/// setting left as it was can't overwrite a change the user made meanwhile.
fn automation_update(
    s: &Shared, ctx: &Ctx, a: &crate::automations::Automation, p: &db::Project, args: &Value, profile: Option<&str>,
) -> std::result::Result<std::result::Result<Value, Map<String, Value>>, ToolError> {
    use crate::automations as au;
    let mut apply = Map::new();
    let name = match &args["name"] {
        Value::Null => a.name.clone(),
        v => au::check_name(v)?,
    };
    if name != a.name {
        apply.insert("name".into(), json!(name));
    }
    let trigger = match &args["trigger"] {
        Value::Null => a.trigger.clone(),
        v => au::check_trigger(au::parse("trigger", v)?)?,
    };
    if trigger != a.trigger {
        apply.insert("trigger".into(), json!(trigger));
    }
    let action = match &args["action"] {
        Value::Null => a.action.clone(),
        v => automation_action(s, ctx, p, v, profile)?,
    };
    if action != a.action {
        apply.insert("action".into(), json!(action));
    }
    let enabled = match &args["enabled"] {
        Value::Null => a.enabled,
        v => v.as_bool().ok_or_else(|| ToolError::Other("enabled must be true or false".into()))?,
    };
    if enabled != a.enabled {
        apply.insert("enabled".into(), json!(enabled));
    }
    let webhook = matches!(trigger, au::Trigger::Webhook { .. });
    let (generate, remove, rotate) = (args["generate_secret"] == true, args["remove_secret"] == true, args["rotate_url"] == true);
    if (generate || rotate) && !webhook {
        return Err(ToolError::Other("only a webhook has a secret or a URL".into()));
    }
    if generate && remove {
        return Err(ToolError::Other("generate_secret and remove_secret can't both be true".into()));
    }
    if generate {
        apply.insert("generate_secret".into(), json!(true));
    } else if remove && has_secret(a) {
        apply.insert("secret".into(), json!(""));
    }
    if rotate {
        apply.insert("rotate_token".into(), json!(true));
    }
    if apply.is_empty() {
        return Err(ToolError::Other("nothing to change".into()));
    }
    // Turning it off, or renaming it, doesn't make it do anything it didn't.
    if apply.keys().all(|k| k == "name" || k == "enabled") && enabled <= a.enabled {
        return Ok(Err(apply));
    }
    let signed = if generate { true } else if remove { false } else { has_secret(a) };
    let mut input = automation_input(s, ctx, "update", p, automation_view(s, &a.id, &name, enabled, &trigger, &action, signed));
    input["before"] = automation_view(s, &a.id, &a.name, a.enabled, &a.trigger, &a.action, has_secret(a));
    input["changes"] = json!(apply.keys().map(|k| k.as_str()).collect::<Vec<_>>());
    input["apply"] = json!(apply);
    input["reason"] = args["reason"].clone();
    Ok(Ok(input))
}

/// Asks the user to approve the automation change `input` describes (see automation_input),
/// then makes it, exactly as they saw it. A new secret is made once it's approved, and returned.
async fn change_automation(s: &Shared, ctx: &Ctx, input: &Value) -> ToolResult {
    use crate::automations as au;
    let op = input["op"].as_str().unwrap_or_default();
    let tool = format!("{op}_automation");
    let id = input["automation"]["id"].as_str().unwrap_or_default();
    let approved = match ask_user(s, ctx, &tool, input).await {
        Ok(a) => a,
        // Deleted while the user was asked.
        Err(_) if op != "create" && au::get(&s.db(), id)?.is_none() => {
            return Err(ToolError::Other(format!("the automation \"{}\" was deleted meanwhile, so nothing was changed", input["automation"]["name"].as_str().unwrap_or(id))));
        }
        Err(e) => return Err(e),
    };
    let mut apply = approved["apply"].as_object().cloned().unwrap_or_default();
    let secret = (apply.remove("generate_secret") == Some(json!(true))).then(crate::util::new_token);
    if let Some(secret) = &secret {
        apply.insert("secret".into(), json!(secret));
    }
    let a = match op {
        "create" => au::create(s, approved["project"]["id"].as_str().unwrap_or_default(), &apply)?,
        "update" => au::update(s, id, &apply)?,
        _ => {
            let a = au::delete(s, id)?;
            return Ok(json!({"deleted": true, "id": a.id, "name": a.name}));
        }
    };
    let mut out = automation_json(s, &a);
    if let Some(secret) = secret {
        out["secret"] = json!(secret);
        out["secret_note"] = json!("Deliveries must be signed with this secret (X-Hub-Signature-256, as GitHub does). It isn't shown again.");
    }
    Ok(out)
}

/// The project a change is to, as the approval shows it.
fn approval_project(s: &Shared, p: &db::Project) -> Value {
    json!({"id": p.id, "key": p.key, "name": p.name, "host": s.host_name})
}

/// The thread asking for a change, as the approval shows it.
fn approval_task(s: &Shared, ctx: &Ctx) -> Value {
    match &ctx.task {
        Some(t) if t.kind == "task" => json!({"id": t.id, "key": format!("{}-{}", project_key(s, t), t.number), "title": t.title}),
        Some(t) => json!({"id": t.id, "title": t.title}),
        None => Value::Null,
    }
}

fn project_json(s: &Shared, p: &db::Project, board: &db::Profile) -> Value {
    json!({"id": p.id, "key": p.key, "name": p.name, "repo_path": p.repo_path, "profile": board.name, "host": s.host_name})
}

/// `get_project`: a project's settings, with each prompt's instructions in effect and whether
/// they're the default.
fn project_settings_json(s: &Shared, p: &db::Project, board: &db::Profile) -> Value {
    let mut out = project_json(s, p, board);
    out["former_keys"] = json!(p.former_keys);
    out["base_branch"] = json!(p.base_branch);
    out["model"] = json!(p.model);
    out["permission_mode"] = json!(p.permission_mode);
    out["use_worktrees"] = json!(p.use_worktrees);
    out["worktrees_root"] = json!(p.worktrees_root);
    out["setup_script"] = json!(p.setup_script);
    out["teardown_script"] = json!(p.teardown_script);
    out["copy_files"] = json!(p.copy_files);
    out["link_folders"] = json!(p.link_folders);
    out["status_script"] = json!(p.status_script);
    out["status_scripts"] = json!(p.status_scripts);
    out["is_git"] = json!(p.is_git);
    out["auto_review"] = json!(p.auto_review);
    out["review_rounds"] = json!(p.review_rounds);
    out["pull_requests"] = json!(p.pull_requests);
    out["subproject_pull_requests"] = json!(p.subproject_pull_requests);
    out["watch_pull_requests"] = json!(p.watch_pull_requests);
    out["pr_preview_url"] = json!(p.pr_preview_url);
    out["reviewers"] = json!(p.reviewers);
    out["auto_summary"] = json!(p.auto_summary);
    out["summarizer"] = json!(p.summarizer);
    // What the project's empty reviewers and null summarizer use.
    out["profile_reviewers"] = json!(board.reviewers);
    out["profile_summarizer"] = json!(board.summarizer);
    out["group_name"] = json!(p.group_name);
    out["archived"] = json!(p.archived_at.is_some());
    let own = [&p.start_prompt, &p.review_prompt, &p.merge_prompt];
    let texts = [crate::prompts::start(Some(p)), crate::prompts::review(Some(p)), crate::prompts::merge(Some(p))];
    for (((k, _), own), text) in crate::prompts::FIELDS.iter().zip(own).zip(texts) {
        out[*k] = json!({"instructions": text, "default": own.is_none()});
    }
    out
}

/// The boards the caller can use on this host: its own profile's first, then the profiles
/// that let its agents in.
fn boards(s: &Shared, ctx: &Ctx) -> std::result::Result<Vec<db::Profile>, ToolError> {
    let mut all: Vec<db::Profile> = db::list_profiles(&s.db())?.into_iter().filter(|p| ctx.is_own(p) || p.grants(&ctx.profile_name)).collect();
    all.sort_by_key(|p| !ctx.is_own(p));
    Ok(all)
}

/// The board named by a `profile` argument or prefix (all of them for none or "all").
fn pick_boards(s: &Shared, ctx: &Ctx, profile: Option<&str>) -> std::result::Result<Vec<db::Profile>, ToolError> {
    let all = boards(s, ctx)?;
    let Some(name) = profile.filter(|p| *p != "all") else { return Ok(all) };
    let named = |p: &db::Profile| p.name.eq_ignore_ascii_case(name) || p.id == name;
    if let Some(b) = all.into_iter().find(named) {
        return Ok(vec![b]);
    }
    // Not found, so that linked hosts are tried too.
    Err(ToolError::NotFound(if db::list_profiles(&s.db())?.iter().any(named) {
        format!(
            "profile {name}'s board on {} doesn't let agents in profile {} use it. Ask the user: they can allow it in Settings → Profiles (edit {name}, \"Agents from other profiles\")",
            s.host_name, ctx.profile_name
        )
    } else {
        format!("profile {name}")
    }))
}

/// `work:SD-3` → (Some("work"), "SD-3"), if a profile here is named `work` (or it's `all`). Ids and
/// keys have no colons, but a project's name may: "Ops: infra" is a name unless there's a profile `Ops`.
fn split_ref<'a>(s: &Shared, r: &'a str) -> std::result::Result<(Option<&'a str>, &'a str), ToolError> {
    let Some((p, rest)) = r.split_once(':').filter(|(p, _)| !p.is_empty()) else { return Ok((None, r)) };
    // Any profile here, not only those that let the caller in, so pick_boards can say it doesn't.
    // One only on a linked host isn't found here either way, so the call goes on to that host.
    let profile = p == "all" || db::list_profiles(&s.db())?.iter().any(|b| b.name.eq_ignore_ascii_case(p) || b.id == p);
    Ok(if profile { (Some(p), rest) } else { (None, r) })
}

/// One of the matches on the caller's boards: on its own board if it's there, else the only one.
fn pick_one<T>(ctx: &Ctx, what: &str, mut found: Vec<(db::Profile, T)>, qualified: impl Fn(&db::Profile) -> String) -> std::result::Result<T, ToolError> {
    if let Some(i) = found.iter().position(|(b, _)| ctx.is_own(b)) {
        return Ok(found.swap_remove(i).1);
    }
    match found.len() {
        0 => Err(ToolError::NotFound(what.to_string())),
        1 => Ok(found.remove(0).1),
        _ => {
            let names: Vec<String> = found.iter().map(|(b, _)| qualified(b)).collect();
            Err(ToolError::Other(format!("{what} is on more than one profile's board: name one of {} (or pass profile)", names.join(", "))))
        }
    }
}

/// A project named by an agent: its id, key or name, optionally as `<profile>:<key>`.
fn resolve_project(s: &Shared, ctx: &Ctx, r: &str, profile: Option<&str>) -> std::result::Result<db::Project, ToolError> {
    let (prefix, key) = split_ref(s, r)?;
    let boards = pick_boards(s, ctx, prefix.or(profile))?;
    if let Some(p) = db::get_project(&s.db(), key)?.filter(|p| boards.iter().any(|b| b.id == p.profile_id)) {
        return Ok(p);
    }
    let mut found = Vec::new();
    for b in boards {
        let projects = db::list_projects(&s.db(), &b.id)?;
        let p = projects.iter().find(|p| p.key.eq_ignore_ascii_case(key) || p.name.eq_ignore_ascii_case(key));
        let p = p.or_else(|| projects.iter().find(|p| p.former_keys.iter().any(|f| f.eq_ignore_ascii_case(key))));
        if let Some(p) = p.cloned() {
            found.push((b, p));
        }
    }
    pick_one(ctx, &format!("project {r}"), found, |b| format!("{}:{key}", b.name))
}

fn project_key(s: &Shared, t: &Task) -> String {
    runner::task_key_prefix(s, t)
}

/// A subproject named by an agent (task id or key).
fn subproject_arg(s: &Shared, ctx: &Ctx, id: &str, profile: Option<&str>) -> std::result::Result<Task, ToolError> {
    let t = resolve_task(s, ctx, id, profile)?;
    if !t.subproject {
        return Err(ToolError::Other(format!("{id} is not a subproject")));
    }
    Ok(t)
}

/// The tasks named in a `depends_on` argument (ids or keys), as ids. None if it wasn't given.
fn dependency_ids(s: &Shared, ctx: &Ctx, v: &Value, profile: Option<&str>) -> std::result::Result<Option<Vec<String>>, ToolError> {
    if v.is_null() {
        return Ok(None);
    }
    let refs = v.as_array().ok_or_else(|| ToolError::Other("depends_on must be a list of task ids or keys".into()))?;
    let mut ids = Vec::new();
    for r in refs {
        let r = r.as_str().ok_or_else(|| ToolError::Other("depends_on must be a list of task ids or keys".into()))?;
        ids.push(resolve_task(s, ctx, r, profile)?.id);
    }
    Ok(Some(ids))
}

/// The fields offered to agents, shared by the overview and paginated reads. Do not serialize
/// the database Task here: it includes fields the tools don't expose (including private links).
fn task_details(s: &Shared, ctx: &Ctx, t: &Task) -> ToolResult {
    let mut out = summarize(s, t);
    out["description"] = json!(t.description);
    out["worktree_path"] = json!(t.worktree_path);
    out["last_message"] = json!(db::last_assistant_text(&s.db(), &t.id)?);
    // A task can create tasks on boards the caller cannot use (or no longer can use).
    let readable = boards(s, ctx)?;
    let created: Vec<Task> = db::created_tasks(&s.db(), &t.id)?.into_iter().filter(|c| readable.iter().any(|b| b.id == c.profile_id)).collect();
    if !created.is_empty() {
        out["created_tasks"] = json!(created.iter().map(|c| summary(s, c)).collect::<Vec<_>>());
    }
    Ok(out)
}

/// Strings are read as plain text; everything else is read as pretty JSON, including null.
fn field_text(value: &Value) -> String {
    value.as_str().map(String::from).unwrap_or_else(|| serde_json::to_string_pretty(value).unwrap())
}

fn task_overview(details: Value) -> Value {
    let mut out = Map::new();
    let mut lengths = Map::new();
    let mut omitted = Vec::new();
    // Bound both each value and the whole response, even if several metadata fields grow.
    // Count serialized bytes too: escapes and nested JSON can be much larger than plain text.
    let mut budget = 6000;
    for (name, value) in details.as_object().unwrap() {
        lengths.insert(name.clone(), json!(field_text(value).chars().count()));
        let size = serde_json::to_string_pretty(value).unwrap().len();
        if size <= 1000 && size <= budget {
            budget -= size;
            out.insert(name.clone(), value.clone());
        } else {
            omitted.push(name.clone());
        }
    }
    out.insert("field_lengths".into(), json!(lengths));
    out.insert("omitted_fields".into(), json!(omitted));
    Value::Object(out)
}

fn task_field(details: &Value, args: &Value) -> ToolResult {
    let fields = details.as_object().unwrap();
    let field = args["field"].as_str().unwrap_or_default();
    let value = fields.get(field).ok_or_else(|| ToolError::Other(format!(
        "unknown task field {field:?}; available fields: {} (see get_task's field_lengths)", fields.keys().cloned().collect::<Vec<_>>().join(", ")
    )))?;
    let number = |name: &str, default: usize| -> std::result::Result<usize, ToolError> {
        match args.get(name) {
            None => Ok(default),
            Some(v) => v.as_u64().and_then(|n| usize::try_from(n).ok())
                .ok_or_else(|| ToolError::Other(format!("{name} must be a non-negative integer"))),
        }
    };
    let offset = number("offset", 0)?;
    let limit = number("limit", TASK_FIELD_DEFAULT_LIMIT)?;
    if limit == 0 || limit > TASK_FIELD_MAX_LIMIT {
        return Err(ToolError::Other(format!("limit must be between 1 and {TASK_FIELD_MAX_LIMIT}")));
    }
    let text = field_text(value);
    let total_length = text.chars().count();
    let content: String = text.chars().skip(offset).take(limit).collect();
    let length = content.chars().count();
    let next = offset.saturating_add(length);
    Ok(json!({
        "task_id": details["id"], "field": field, "format": if value.is_string() { "text" } else { "json" },
        "offset": offset, "limit": limit, "length": length, "total_length": total_length,
        "next_offset": (next < total_length).then_some(next), "content": content,
    }))
}

fn summarize(s: &Shared, t: &Task) -> Value {
    let mut v = summary(s, t);
    if !t.depends_on.is_empty() {
        let key = project_key(s, t);
        let deps: Vec<Value> = t
            .depends_on
            .iter()
            .filter_map(|id| db::get_task(&s.db(), id).ok().flatten())
            // Only ever in its own project (and so on its board); anything else is left out.
            .filter(|d| d.project_id.is_some() && d.project_id == t.project_id)
            .map(|d| json!({"key": format!("{key}-{}", d.number), "title": d.title, "status": d.status, "merged": db::is_merged(&d)}))
            .collect();
        if !deps.is_empty() {
            v["depends_on"] = json!(deps);
        }
    }
    if t.waiting {
        v["queued_for_dependencies"] = json!(true);
    }
    if t.subproject {
        v["is_subproject"] = json!(true);
    }
    if let (None, Some(g)) = (&t.project_id, &t.group_name) {
        v["group_task"] = json!(g);
    }
    // Its labels, and where the plan, artifact or diagram each asks for is, for agents on this host to read.
    let documents = crate::documents::paths(s, t);
    if !documents.is_empty() {
        v["labels"] = json!(documents.iter().map(|(l, _)| l).collect::<Vec<_>>());
        v["documents"] = documents.iter().map(|(l, f)| (l.to_string(), json!(crate::util::path_str(f)))).collect::<serde_json::Map<_, _>>().into();
    }
    if t.is_scratch() {
        v["type"] = json!(db::SCRATCH);
    }
    if let Some(sp) = t.parent_id.as_deref().filter(|_| t.kind == "task").and_then(|id| db::get_task(&s.db(), id).ok().flatten()) {
        v["subproject"] = json!(format!("{}-{}", project_key(s, &sp), sp.number));
    }
    v
}

/// The star and reminder `create_task` gives the new task, checked in full before the task is
/// created (and its agent started), so a call that fails leaves no task behind for a retry to
/// duplicate.
fn new_task_marks(args: &Value) -> std::result::Result<Vec<(&'static str, Value)>, ToolError> {
    let given = reminder_args(args)?;
    let mut marks: Vec<(&str, Value)> = api::MARK_FIELDS.iter().filter_map(|k| given.get(*k).map(|v| (*k, v.clone()))).collect();
    api::check_reminder(None, &mut marks)?;
    Ok(marks)
}

/// Task `t`, just made by `create_task`, with who made it and the star and reminder it was given.
fn created(s: &Shared, ctx: &Ctx, mut t: Task, marks: &[(&str, Value)]) -> std::result::Result<Task, ToolError> {
    // Kept so a group task (or any task) can show how the tasks it created are doing.
    if let Some(own) = ctx.task.as_ref().filter(|own| own.kind == "task") {
        t = s.update_task(&t.id, &[("created_by", json!(own.id))])?.unwrap_or(t);
    }
    if !marks.is_empty() {
        t = s.update_task(&t.id, marks)?.unwrap_or(t);
    }
    Ok(t)
}

/// `starred`, `remind_at` and `reminder` from `create_task` or `update_task`, with the time made
/// absolute (see reminder_time). The API checks the rest.
fn reminder_args(args: &Value) -> std::result::Result<Map<String, Value>, ToolError> {
    let mut body = Map::new();
    for k in ["starred", "reminder"] {
        if !args[k].is_null() {
            body.insert(k.into(), args[k].clone());
        }
    }
    match &args["remind_at"] {
        Value::Null => {}
        Value::String(at) => {
            let at = reminder_time(at, chrono::Utc::now()).ok_or_else(|| {
                ToolError::Other(
                    "remind_at must be a delay like 30m, 2h, 3d or 1w, a time like 2026-05-01T09:00:00Z (or 2026-05-01 09:00 in the host's time zone), \
                     or an empty string to clear the reminder"
                        .into(),
                )
            })?;
            body.insert("remind_at".into(), json!(at));
        }
        other => {
            body.insert("remind_at".into(), other.clone());
        }
    }
    Ok(body)
}

/// A reminder's time as RFC 3339, from what an agent passes: a delay from `now` (`30m`, `2h`,
/// `1d 12h`, `in 3 days`, `1w`), an RFC 3339 time, or a date and time (or just a date, at 9:00)
/// in the host's time zone. Blank clears the reminder. None if it's none of those.
fn reminder_time(v: &str, now: chrono::DateTime<chrono::Utc>) -> Option<String> {
    use chrono::{Local, NaiveDate, NaiveDateTime, TimeDelta, TimeZone};
    let v = v.trim();
    if v.is_empty() {
        return Some(String::new());
    }
    if chrono::DateTime::parse_from_rfc3339(v).is_ok() {
        return Some(v.to_string());
    }
    let local = ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"]
        .iter()
        .find_map(|f| NaiveDateTime::parse_from_str(v, f).ok())
        .or_else(|| NaiveDate::parse_from_str(v, "%Y-%m-%d").ok().and_then(|d| d.and_hms_opt(9, 0, 0)));
    if let Some(t) = local {
        return Local.from_local_datetime(&t).earliest().map(|t| t.with_timezone(&chrono::Utc).to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    }
    // A delay: numbers each followed by a unit, e.g. "1h30m" or "in 2 days".
    let rest = v.strip_prefix("in ").unwrap_or(v).to_ascii_lowercase();
    let mut chars = rest.chars().filter(|c| !c.is_whitespace() && *c != ',').peekable();
    let mut total = TimeDelta::zero();
    let mut any = false;
    while chars.peek().is_some() {
        let n: String = std::iter::from_fn(|| chars.next_if(char::is_ascii_digit)).collect();
        let unit: String = std::iter::from_fn(|| chars.next_if(char::is_ascii_alphabetic)).collect();
        let n: i64 = n.parse().ok().filter(|n| *n <= 10_000)?;
        total += match unit.as_str() {
            "m" | "min" | "mins" | "minute" | "minutes" => TimeDelta::minutes(n),
            "h" | "hr" | "hrs" | "hour" | "hours" => TimeDelta::hours(n),
            "d" | "day" | "days" => TimeDelta::days(n),
            "w" | "wk" | "week" | "weeks" => TimeDelta::weeks(n),
            _ => return None,
        };
        any = true;
    }
    any.then(|| (now + total).to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

fn summary(s: &Shared, t: &Task) -> Value {
    let profile = db::get_profile(&s.db(), &t.profile_id).ok().flatten().map(|p| p.name);
    let mut v = json!({
        "id": t.id,
        "key": format!("{}-{}", project_key(s, t), t.number),
        "title": t.title,
        "status": t.status,
        "resolution": t.resolution,
        "running": t.running,
        "attention_reason": t.attention_reason,
        "branch": t.branch,
        "preview_url": t.preview_url,
        "pr_url": t.pr_url,
        "review": t.review.as_ref().map(|r| json!({"state": r.state, "summary": r.summary, "issues": r.issues})),
        "project_id": t.project_id,
        "profile": profile,
        "host": s.host_name,
    });
    if !t.external_links.is_empty() {
        v["external_links"] = json!(t.external_links);
    }
    if t.starred {
        v["starred"] = json!(true);
    }
    if let Some(at) = &t.remind_at {
        v["remind_at"] = json!(at);
        v["reminder"] = json!(t.reminder);
    }
    v
}

/// A task named by an agent: its id or a key like `ABC-12`, optionally as `<profile>:ABC-12`.
fn resolve_task(s: &Shared, ctx: &Ctx, r: &str, profile: Option<&str>) -> std::result::Result<Task, ToolError> {
    let (prefix, id) = split_ref(s, r)?;
    let boards = pick_boards(s, ctx, prefix.or(profile))?;
    // Not a review thread, as by its key: an agent's tools only reach tasks.
    if let Some(t) = db::get_task(&s.db(), id)?.filter(|t| t.kind == "task" && boards.iter().any(|b| b.id == t.profile_id)) {
        return Ok(t);
    }
    let mut found = Vec::new();
    if let Some((k, n)) = id.rsplit_once('-')
        && let Ok(n) = n.parse::<i64>()
    {
        for b in boards {
            // No project has the group or scratch tasks' keys (see db::free_task_key).
            if k.eq_ignore_ascii_case(runner::GROUP_TASK_KEY) {
                let t = db::group_task_by_number(&s.db(), &b.id, n)?;
                found.extend(t.map(|t| (b, t)));
                continue;
            }
            if k.eq_ignore_ascii_case(db::SCRATCH_TASK_KEY) {
                let t = db::scratch_task_by_number(&s.db(), &b.id, n)?;
                found.extend(t.map(|t| (b, t)));
                continue;
            }
            // A key a project had before still names its tasks. No other project can take it (see
            // api::check_key), so more than one is from before that, and naming either would be a guess.
            let projects = db::list_projects(&s.db(), &b.id)?;
            let mut here = Vec::new();
            for p in projects.iter().filter(|p| p.key.eq_ignore_ascii_case(k) || p.former_keys.iter().any(|f| f.eq_ignore_ascii_case(k))) {
                if let Some(t) = db::list_tasks_for_project(&s.db(), &p.id, "task")?.into_iter().find(|t| t.number == n) {
                    here.push((p, t));
                }
            }
            if here.len() > 1 {
                let ids: Vec<String> = here.iter().map(|(p, t)| format!("{} (id {}, in {})", t.title, t.id, p.name)).collect();
                return Err(ToolError::Other(format!("task {r} could be more than one task: {}; name it by its id", ids.join(", "))));
            }
            found.extend(here.into_iter().map(|(_, t)| (b.clone(), t)));
        }
    }
    pick_one(ctx, &format!("task {r}"), found, |b| format!("{}:{id}", b.name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{NewProject, insert_profile, insert_project};
    use crate::testing::{self, state};

    fn project(s: &Shared, profile: &db::Profile, id: &str, key: &str) {
        let p = NewProject { id, profile_id: &profile.id, name: id, key, repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
        insert_project(&s.db(), p).unwrap();
    }

    fn task(s: &Shared, project: &str, title: &str) -> Task {
        let body = CreateTask {
            parent_id: None,
            subproject: None,
            title: title.into(),
            description: String::new(),
            status: None,
            resolution: None,
            use_worktree: Some(false),
            model: None,
            effort: None,
            kind: None,
            start: None,
            claude_config_id: None,
            depends_on: None,
            task_type: None,
            labels: None,
            external_links: None,
            fanout_id: None,
        };
        api::create_task_inner(s, project, body).map_err(|e| e.1).unwrap()
    }

    fn grant(s: &Shared, p: &db::Profile, names: &[&str]) {
        db::update_profile(&s.db(), &p.id, &[("agent_access", json!(names))]).unwrap();
    }

    /// A run of `task_id` that holds its thread, as a started one does (see runner::start_run).
    fn started_run(s: &Shared, task_id: &str) -> db::Run {
        let run = db::insert_run(&s.db(), task_id, "prompt").unwrap();
        s.runs.lock().unwrap().insert(task_id.to_string(), crate::state::RunHandle { run_id: run.id.clone(), cancel: None });
        run
    }

    fn ctx(p: &db::Profile) -> Ctx {
        Ctx { profile_id: Some(p.id.clone()), profile_name: p.name.clone(), task: None, call_id: None, task_fields: true }
    }

    async fn call(s: &Shared, ctx: &Ctx, tool: &str, args: Value) -> std::result::Result<Value, String> {
        local(s, ctx, tool, &args).await.map_err(msg)
    }

    fn keys(v: &Value, field: &str) -> Vec<String> {
        v.as_array().unwrap().iter().map(|p| format!("{}:{}", p["profile"].as_str().unwrap(), p[field].as_str().unwrap())).collect()
    }

    async fn post_tool(s: &Shared, path: &str, body: Value) -> Value {
        use tower::ServiceExt;
        let req = axum::http::Request::builder().method("POST").uri(path)
            .header("authorization", "Bearer ").header("content-type", "application/json")
            .body(axum::body::Body::from(body.to_string())).unwrap();
        let res = api::router(s.clone()).oneshot(req).await.unwrap();
        assert_eq!(res.status(), axum::http::StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        let result: Value = serde_json::from_slice(&bytes).unwrap();
        assert!(result.get("error").is_none(), "{result}");
        result["result"].clone()
    }

    #[test]
    fn legacy_helper_keeps_full_details_after_server_upgrade() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "ia", "IA");
            let t = task(&s, "ia", "Existing thread");
            let description = "Description ā🙂\n".repeat(160);
            let review = db::Review { state: "issues".into(), summary: Some("Review\n".repeat(400)), ..Default::default() };
            db::update_task(&s.db(), &t.id, &[("description", json!(description)), ("review", json!(review))]).unwrap();
            let run = db::insert_run(&s.db(), &t.id, "prompt").unwrap();
            // An already-running helper keeps its API 58 schema and sends the same request
            // shape after reconnecting to the upgraded daemon. No get_task_field capability.
            let request = json!({"run_id": run.id, "call_id": "old-helper", "tool": "get_task", "args": {"task_id": "IA-1"}});
            let full = post_tool(&s, "/api/internal/mcp", request.clone()).await;
            assert!(full["description"] == description, "legacy helper lost its description");
            assert_eq!(full["review"]["summary"], review.summary.as_ref().unwrap().as_str());
            assert!(full.get("omitted_fields").is_none());
            // Its retried call remains idempotent across the upgrade too.
            assert_eq!(post_tool(&s, "/api/internal/mcp", request.clone()).await, full);

            let mut current = request;
            current["call_id"] = json!("new-helper");
            current["task_fields"] = json!(true);
            let overview = post_tool(&s, "/api/internal/mcp", current.clone()).await;
            assert!(overview.get("description").is_none());
            assert_eq!(overview["field_lengths"]["description"], description.chars().count());
            current["call_id"] = json!("new-helper-field");
            current["tool"] = json!("get_task_field");
            current["args"] = json!({"task_id": "IA-1", "field": "description", "limit": TASK_FIELD_MAX_LIMIT});
            assert_eq!(post_tool(&s, "/api/internal/mcp", current).await["content"], description);
        });
    }

    #[test]
    fn legacy_host_keeps_full_details_from_upgraded_host() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "ia", "IA");
            let t = task(&s, "ia", "Remote task");
            let description = "Remote description\n".repeat(160);
            db::update_task(&s.db(), &t.id, &[("description", json!(description))]).unwrap();
            // API 58 call_tool sends only profile and args. It cannot offer or forward
            // get_task_field, so it must receive full details from an API 59 linked host.
            let request = json!({"profile": "personal", "args": {"task_id": "IA-1"}});
            let full = post_tool(&s, "/api/tools/get_task", request.clone()).await;
            assert!(full["description"] == description, "API 58 caller lost its description");
            assert!(full.get("omitted_fields").is_none());

            let mut current = request;
            current["task_fields"] = json!(true);
            let overview = post_tool(&s, "/api/tools/get_task", current.clone()).await;
            assert!(overview.get("description").is_none());
            assert_eq!(overview["field_lengths"]["description"], description.chars().count());
            current["task_fields"] = json!(false);
            assert_eq!(post_tool(&s, "/api/tools/get_task", current).await, full);
        });
    }

    #[test]
    fn large_task_fields_are_summarized_and_can_be_reassembled() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "ia", "IA");
            let t = task(&s, "ia", "A large task");
            let me = ctx(&p);
            let description = "A lengthy description\n".repeat(5000);
            let message = "Latest reply: ā🙂\n\"quoted\"\\\t".repeat(4000);
            let review = db::Review { state: "issues".into(), summary: Some("Review\n".repeat(2000)), issues: vec!["Fix it".repeat(1000)], ..Default::default() };
            db::update_task(&s.db(), &t.id, &[("description", json!(description)), ("review", json!(review))]).unwrap();
            db::insert_message(&s.db(), &t.id, "claude", &json!({"type": "result", "result": message})).unwrap();
            // Arrays can grow too; no unbounded review is smuggled in through created_tasks.
            let child = task(&s, "ia", "Child");
            db::update_task(&s.db(), &child.id, &[("created_by", json!(t.id)), ("review", json!(review))]).unwrap();
            let overview = call(&s, &me, "get_task", json!({"task_id": "IA-1"})).await.unwrap();
            let serialized = serde_json::to_string_pretty(&overview).unwrap();
            assert!(serialized.len() < 10000, "overview was {} bytes", serialized.len());
            assert_eq!((overview["key"].as_str(), overview["title"].as_str()), (Some("IA-1"), Some("A large task")));
            for field in ["description", "last_message", "review", "created_tasks"] {
                assert!(overview.get(field).is_none(), "{field} was inlined");
                assert!(overview["omitted_fields"].as_array().unwrap().contains(&json!(field)));
            }
            assert_eq!(overview["field_lengths"]["description"], description.chars().count());
            assert_eq!(overview["field_lengths"]["last_message"], message.chars().count());
            for (field, expected) in [("description", description), ("last_message", message)] {
                let mut offset = 0;
                let mut assembled = String::new();
                loop {
                    let page = call(&s, &me, "get_task_field", json!({"task_id": t.id, "field": field, "offset": offset})).await.unwrap();
                    let content = page["content"].as_str().unwrap();
                    assert_eq!(page["format"], "text");
                    assert_eq!(page["total_length"], overview["field_lengths"][field]);
                    assert!(content.chars().count() <= TASK_FIELD_DEFAULT_LIMIT);
                    assembled.push_str(content);
                    match page["next_offset"].as_u64() {
                        Some(next) => { assert!(next > offset); offset = next; }
                        None => break,
                    }
                }
                assert_eq!(assembled, expected);
            }
            let page = call(&s, &me, "get_task_field", json!({"task_id": "IA-1", "field": "review"})).await.unwrap();
            assert_eq!(page["format"], "json");
            assert_eq!(page["total_length"], overview["field_lengths"]["review"]);
            assert!(page["next_offset"].is_number());
        });
    }

    #[test]
    fn task_field_pages_count_characters_and_validate_ranges() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "ia", "IA");
            let t = task(&s, "ia", "Small task");
            let me = ctx(&p);
            db::update_task(&s.db(), &t.id, &[("description", json!("aā🙂\n\"\\\u{0000}z"))]).unwrap();
            let args = json!({"task_id": "IA-1", "field": "description"});
            let page = async |extra: Value| {
                let mut args = args.clone();
                args.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
                call(&s, &me, "get_task_field", args).await
            };
            let v = page(json!({"offset": 1, "limit": 3})).await.unwrap();
            assert_eq!((v["content"].as_str(), &v["length"], &v["total_length"], &v["next_offset"]), (Some("ā🙂\n"), &json!(3), &json!(8), &json!(4)));
            let v = page(json!({"offset": 7, "limit": TASK_FIELD_MAX_LIMIT})).await.unwrap();
            assert_eq!(v["content"], "z");
            assert!(v["next_offset"].is_null());
            for offset in [8, 9, u64::MAX] {
                let v = page(json!({"offset": offset})).await.unwrap();
                assert_eq!(v["content"], "");
                assert_eq!(v["length"], 0);
                assert!(v["next_offset"].is_null());
            }
            for extra in [
                json!({"offset": -1}), json!({"offset": 1.5}), json!({"offset": "1"}), json!({"offset": null}),
                json!({"limit": -1}), json!({"limit": 0}), json!({"limit": TASK_FIELD_MAX_LIMIT + 1}),
                json!({"limit": 1.5}), json!({"limit": "1"}), json!({"limit": null}), json!({"field": "session_id"}),
            ] {
                assert!(page(extra.clone()).await.is_err(), "accepted {extra}");
            }
            // Null, scalar and empty fields have exact lengths matching their paginated representation.
            let overview = call(&s, &me, "get_task", json!({"task_id": "IA-1"})).await.unwrap();
            assert_eq!(overview["description"], "aā🙂\n\"\\\u{0000}z");
            for (field, content, format) in [("last_message", "null", "json"), ("running", "false", "json"), ("title", "Small task", "text")] {
                let v = page(json!({"field": field})).await.unwrap();
                assert_eq!(v["content"], content);
                assert_eq!(v["format"], format);
                assert_eq!(overview["field_lengths"][field], content.chars().count());
            }
            db::update_task(&s.db(), &t.id, &[("description", json!(""))]).unwrap();
            let v = page(json!({})).await.unwrap();
            assert_eq!(v["total_length"], 0);
            assert_eq!(v["content"], "");
            assert!(v["next_offset"].is_null());
        });
    }

    #[test]
    fn overview_bounds_escaped_values_and_the_total_inline_size() {
        let details: Map<String, Value> = (0..30).map(|i| (format!("field_{i}"), json!("x".repeat(900)))).collect();
        let v = task_overview(json!(details));
        assert!(serde_json::to_string_pretty(&v).unwrap().len() < 10000);
        assert_eq!(v["field_lengths"].as_object().unwrap().len(), 30);
        assert!(v["omitted_fields"].as_array().unwrap().len() >= 24);
        // Control characters expand sixfold in JSON; characters alone aren't an output bound.
        let v = task_overview(json!({"description": "\u{0000}".repeat(900)}));
        assert!(v.get("description").is_none());
        assert_eq!(v["field_lengths"]["description"], 900);
    }

    #[test]
    fn task_fields_use_the_same_profile_access_and_key_resolution() {
        testing::run(async || {
            let s = state();
            let [personal, work, lab] = ["personal", "work", "lab"].map(|n| insert_profile(&s.db(), n, &[], None).unwrap());
            for (p, id, key) in [(&personal, "own", "IA"), (&work, "work", "IA"), (&lab, "lab", "LAB")] {
                project(&s, p, id, key);
                let t = task(&s, id, id);
                db::update_task(&s.db(), &t.id, &[("description", json!(id))]).unwrap();
            }
            let me = ctx(&personal);
            let get = async |extra: Value| {
                let mut args = json!({"task_id": "IA-1", "field": "description"});
                args.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
                call(&s, &me, "get_task_field", args).await
            };
            let work_id = db::list_tasks_for_project(&s.db(), "work", "task").unwrap()[0].id.clone();
            assert!(get(json!({"task_id": work_id})).await.is_err());
            assert!(get(json!({"profile": "work"})).await.is_err());
            assert!(get(json!({"task_id": "work:IA-1"})).await.is_err());
            grant(&s, &work, &["personal"]);
            assert_eq!(get(json!({})).await.unwrap()["content"], "own");
            assert_eq!(get(json!({"profile": "work"})).await.unwrap()["content"], "work");
            assert_eq!(get(json!({"task_id": "work:ia-1"})).await.unwrap()["content"], "work");
            assert_eq!(get(json!({"task_id": work_id})).await.unwrap()["content"], "work");
            // The remote entry point enforces access too, and resolves the same qualified keys.
            assert_eq!(handle_remote(&s, "get_task_field", "personal", json!({"task_id": "work:IA-1", "field": "description"}), true).await.unwrap()["content"], "work");
            grant(&s, &work, &[]);
            assert!(handle_remote(&s, "get_task_field", "personal", json!({"task_id": work_id, "field": "description"}), true).await.is_err());
            assert!(get(json!({"task_id": "LAB-1"})).await.is_err());
        });
    }

    #[test]
    fn reads_task_fields_on_new_and_legacy_linked_hosts() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            let me = ctx(&p);
            let calls: std::sync::Arc<std::sync::Mutex<Vec<(String, String, Value)>>> = Default::default();
            for (name, api) in [("old", TASK_FIELDS_API - 1), ("new", TASK_FIELDS_API)] {
                let calls = calls.clone();
                let app = axum::Router::new().route("/api/tools/{tool}", axum::routing::post(
                    move |axum::extract::Path(tool): axum::extract::Path<String>, axum::Json(body): axum::Json<Value>| {
                        let calls = calls.clone();
                        async move {
                            calls.lock().unwrap().push((name.to_string(), tool.clone(), body.clone()));
                            let details = json!({"id": "remote", "description": "ā🙂x".repeat(10000), "title": "Remote task"});
                            let result = match (api, tool.as_str()) {
                                (TASK_FIELDS_API, "get_task") if body["task_fields"] == true => task_overview(details),
                                (TASK_FIELDS_API, "get_task_field") => task_field(&details, &body["args"]).map_err(msg).unwrap(),
                                (_, "get_task") => details,
                                _ => panic!("sent {tool} to a legacy host"),
                            };
                            axum::Json(json!({"result": result}))
                        }
                    }
                ));
                hub::link_http(&s, name, app, api).await;
            }
            // An explicit host and fallback lookup both pass through compatibility handling.
            for host in [Some("old"), Some("new"), None] {
                let mut args = json!({"task_id": "work:REMOTE-1", "profile": "work"});
                if let Some(host) = host { args["host"] = json!(host); }
                let overview = dispatch(&s, &me, "get_task", args.clone()).await.unwrap();
                assert_eq!(overview["field_lengths"]["description"], 30000);
                assert!(overview.get("description").is_none());
                args["field"] = json!("description");
                args["offset"] = json!(1);
                args["limit"] = json!(2);
                let page = dispatch(&s, &me, "get_task_field", args).await.unwrap();
                assert_eq!(page["content"], "🙂x");
                assert_eq!(page["next_offset"], 3);
            }
            // An old helper on an upgraded calling host still needs full details from both
            // old and upgraded destinations; the forwarding host's version is not a capability.
            let legacy = Ctx { task_fields: false, ..ctx(&p) };
            for host in [Some("old"), Some("new"), None] {
                let mut args = json!({"task_id": "work:REMOTE-1", "profile": "work"});
                if let Some(host) = host { args["host"] = json!(host); }
                let full = dispatch(&s, &legacy, "get_task", args).await.unwrap();
                assert!(full["description"] == "ā🙂x".repeat(10000), "forwarding hid legacy details");
                assert!(full.get("omitted_fields").is_none());
            }
            let sent = calls.lock().unwrap();
            assert!(sent.iter().any(|(host, tool, _)| host == "new" && tool == "get_task_field"));
            for (host, tool, body) in sent.iter() {
                assert_eq!(body["profile"], "personal");
                assert_eq!(body["args"]["task_id"], "work:REMOTE-1");
                assert_eq!(body["args"]["profile"], "work");
                if host == "old" {
                    assert_eq!(tool, "get_task");
                    assert!(body["args"].get("offset").is_none());
                    assert_eq!(body["task_fields"], false);
                }
            }
        });
    }

    #[test]
    fn leaves_archived_projects_out_of_lists() {
        testing::run(async || {
            let s = state();
            let me = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &me, "ia", "IA");
            project(&s, &me, "old", "OLD");
            task(&s, "ia", "live");
            task(&s, "old", "shelved");
            db::update_project(&s.db(), "old", &[("archived_at", json!("2026-01-01T00:00:00Z"))]).unwrap();
            let me = ctx(&me);
            assert_eq!(keys(&call(&s, &me, "list_projects", json!({})).await.unwrap(), "key"), ["personal:IA"]);
            assert_eq!(keys(&call(&s, &me, "list_tasks", json!({"project_id": "all"})).await.unwrap(), "key"), ["personal:IA-1"]);
            // Still found when named, and says it's archived.
            assert_eq!(call(&s, &me, "get_project", json!({"project_id": "OLD"})).await.unwrap()["archived"], true);
            assert_eq!(call(&s, &me, "get_project", json!({"project_id": "IA"})).await.unwrap()["archived"], false);
            let err = call(&s, &me, "create_task", json!({"project_id": "OLD", "title": "more"})).await.unwrap_err();
            assert!(err.contains("is archived"), "{err}");
        });
    }

    #[test]
    fn lists_other_profiles_boards_that_let_it_in() {
        testing::run(async || {
            let s = state();
            let [personal, work] = ["personal", "work"].map(|n| insert_profile(&s.db(), n, &[], None).unwrap());
            project(&s, &personal, "ia", "IA");
            project(&s, &work, "sd", "SD");
            task(&s, "sd", "deploy");
            let me = ctx(&personal);
            // Opt-in: other boards are closed until they let the profile in.
            assert_eq!(keys(&call(&s, &me, "list_projects", json!({})).await.unwrap(), "key"), ["personal:IA"]);
            let err = call(&s, &me, "get_task", json!({"task_id": "SD-1"})).await.unwrap_err();
            assert!(err.contains("task SD-1"), "{err}");
            let err = call(&s, &me, "list_tasks", json!({"profile": "work", "project_id": "all"})).await.unwrap_err();
            assert!(err.contains("Settings → Profiles"), "{err}");

            grant(&s, &work, &["personal"]);
            assert_eq!(keys(&call(&s, &me, "list_projects", json!({})).await.unwrap(), "key"), ["personal:IA", "work:SD"]);
            assert_eq!(keys(&call(&s, &me, "list_projects", json!({"profile": "work"})).await.unwrap(), "key"), ["work:SD"]);
            // 'all' is the caller's own board unless it names another (or every one).
            assert!(call(&s, &me, "list_tasks", json!({"project_id": "all"})).await.unwrap().as_array().unwrap().is_empty());
            assert_eq!(keys(&call(&s, &me, "list_tasks", json!({"project_id": "all", "profile": "all"})).await.unwrap(), "key"), ["work:SD-1"]);
            assert_eq!(keys(&call(&s, &me, "list_tasks", json!({"project_id": "SD"})).await.unwrap(), "key"), ["work:SD-1"]);
            assert_eq!(call(&s, &me, "get_task", json!({"task_id": "SD-1"})).await.unwrap()["title"], "deploy");
            // Access is one way.
            assert_eq!(keys(&call(&s, &ctx(&work), "list_projects", json!({})).await.unwrap(), "key"), ["work:SD"]);
            // `*` lets every profile in.
            let lab = insert_profile(&s.db(), "lab", &[], None).unwrap();
            grant(&s, &personal, &["*"]);
            assert_eq!(keys(&call(&s, &ctx(&lab), "list_projects", json!({})).await.unwrap(), "key"), ["personal:IA"]);
        });
    }

    #[test]
    fn keys_used_on_several_boards_need_a_profile() {
        testing::run(async || {
            let s = state();
            let [personal, work, lab] = ["personal", "work", "lab"].map(|n| insert_profile(&s.db(), n, &[], None).unwrap());
            grant(&s, &work, &["personal"]);
            grant(&s, &lab, &["personal"]);
            project(&s, &personal, "ia-personal", "IA");
            project(&s, &work, "ia-work", "IA");
            project(&s, &work, "sd-work", "SD");
            project(&s, &lab, "sd-lab", "SD");
            for p in ["ia-personal", "ia-work", "sd-work", "sd-lab"] {
                task(&s, p, p);
            }
            let me = ctx(&personal);
            let title = async |args: Value| call(&s, &me, "get_task", args).await.map(|t| t["title"].as_str().unwrap().to_string());
            // The caller's own board wins.
            assert_eq!(title(json!({"task_id": "IA-1"})).await.unwrap(), "ia-personal");
            assert_eq!(title(json!({"task_id": "work:IA-1"})).await.unwrap(), "ia-work");
            // On two other boards, the key must say which.
            let err = title(json!({"task_id": "SD-1"})).await.unwrap_err();
            assert!(err.contains("work:SD-1") && err.contains("lab:SD-1"), "{err}");
            assert_eq!(title(json!({"task_id": "lab:SD-1"})).await.unwrap(), "sd-lab");
            assert_eq!(title(json!({"task_id": "SD-1", "profile": "work"})).await.unwrap(), "sd-work");
            // Ids need no profile.
            let id = db::list_tasks_for_project(&s.db(), "sd-lab", "task").unwrap()[0].id.clone();
            assert_eq!(title(json!({"task_id": id})).await.unwrap(), "sd-lab");
            // Projects too, by key or name.
            let err = call(&s, &me, "list_tasks", json!({"project_id": "SD"})).await.unwrap_err();
            assert!(err.contains("work:SD"), "{err}");
            assert_eq!(keys(&call(&s, &me, "list_tasks", json!({"project_id": "sd-work"})).await.unwrap(), "title"), ["work:sd-work"]);
        });
    }

    #[test]
    fn creates_tasks_on_other_boards_under_their_profile() {
        testing::run(async || {
            let s = state();
            let (mine, theirs) = {
                let c = s.db();
                let mine = db::insert_claude_config(&c, "personal", "~/.claude-personal", "claude").unwrap();
                let theirs = db::insert_claude_config(&c, "work", "~/.claude-work", "claude").unwrap();
                (mine, theirs)
            };
            let personal = insert_profile(&s.db(), "personal", std::slice::from_ref(&mine.id), None).unwrap();
            let work = insert_profile(&s.db(), "work", &[theirs.id.clone(), mine.id.clone()], None).unwrap();
            project(&s, &personal, "kiwicd", "KIW");
            project(&s, &work, "site-deploy", "SD");
            let caller = task(&s, "kiwicd", "orchestrate");
            let me = Ctx { task: Some(caller), ..ctx(&personal) };
            let err = call(&s, &me, "create_task", json!({"title": "x", "project_id": "work:SD"})).await.unwrap_err();
            assert!(err.contains("doesn't let agents in profile personal"), "{err}");
            grant(&s, &work, &["personal"]);
            let t = call(&s, &me, "create_task", json!({"title": "Follow-up", "project_id": "SD"})).await.unwrap();
            assert_eq!((t["key"].as_str(), t["profile"].as_str()), (Some("SD-1"), Some("work")));
            let t = db::get_task(&s.db(), t["id"].as_str().unwrap()).unwrap().unwrap();
            assert_eq!(t.profile_id, work.id);
            assert_eq!(t.claude_config_id.as_deref(), Some(theirs.id.as_str()));
            // Without a project the caller's own is used, and a profile alone isn't enough.
            let t = call(&s, &me, "create_task", json!({"title": "Here"})).await.unwrap();
            assert_eq!(t["key"], "KIW-2");
            assert!(call(&s, &me, "create_task", json!({"title": "?", "profile": "work"})).await.is_err());
            // And it can be updated and messaged from there.
            let t = call(&s, &me, "update_task", json!({"task_id": "work:SD-1", "title": "Renamed"})).await.unwrap();
            assert_eq!(t["title"], "Renamed");
        });
    }
    #[tokio::test]
    async fn sets_dependencies_by_key() {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "kiwicd", "KIW");
        project(&s, &p, "other", "OT");
        let me = ctx(&p);
        call(&s, &me, "create_task", json!({"title": "Base", "project_id": "KIW"})).await.unwrap();
        call(&s, &me, "create_task", json!({"title": "Elsewhere", "project_id": "OT"})).await.unwrap();
        let t = call(&s, &me, "create_task", json!({"title": "After", "project_id": "KIW", "depends_on": ["KIW-1"]})).await.unwrap();
        assert_eq!(t["depends_on"][0]["key"], "KIW-1");
        assert_eq!(t["depends_on"][0]["merged"], false);
        let err = call(&s, &me, "update_task", json!({"task_id": "KIW-1", "depends_on": ["KIW-2"]})).await.unwrap_err();
        assert!(err.contains("already depends"), "{err}");
        let err = call(&s, &me, "update_task", json!({"task_id": "KIW-2", "depends_on": ["OT-1"]})).await.unwrap_err();
        assert!(err.contains("same project"), "{err}");
        let t = call(&s, &me, "update_task", json!({"task_id": "KIW-2", "depends_on": []})).await.unwrap();
        assert!(t["depends_on"].is_null());
    }

    #[test]
    fn sets_a_pull_request() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "kiwicd", "KIW");
            let me = ctx(&p);
            call(&s, &me, "create_task", json!({"title": "Base", "project_id": "KIW"})).await.unwrap();
            let url = "https://github.com/dire-kiwi/kiwicd/pull/7";
            let t = call(&s, &me, "update_task", json!({"task_id": "KIW-1", "pr_url": format!(" {url} ")})).await.unwrap();
            assert_eq!(t["pr_url"], url);
            let err = call(&s, &me, "update_task", json!({"task_id": "KIW-1", "pr_url": "#7"})).await.unwrap_err();
            assert!(err.contains("pr_url must be"), "{err}");
            let t = call(&s, &me, "update_task", json!({"task_id": "KIW-1", "pr_url": ""})).await.unwrap();
            assert!(t["pr_url"].is_null());
        });
    }

    #[test]
    fn stars_and_sets_reminders() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "kiwicd", "KIW");
            let me = ctx(&p);
            // Set as it's created, the reminder a delay from now.
            // Times are kept to the millisecond, so less a millisecond.
            let before = chrono::Utc::now() - chrono::TimeDelta::milliseconds(1);
            let t = call(&s, &me, "create_task", json!({"title": "Later", "project_id": "KIW", "starred": true, "remind_at": "2h", "reminder": " Check CI "})).await.unwrap();
            assert_eq!((t["starred"].as_bool(), t["reminder"].as_str()), (Some(true), Some("Check CI")));
            let at = chrono::DateTime::parse_from_rfc3339(t["remind_at"].as_str().unwrap()).unwrap();
            assert!(at >= before + chrono::TimeDelta::hours(2) && at <= chrono::Utc::now() + chrono::TimeDelta::hours(2), "{at}");
            // An absolute time is kept in UTC, and the note stays when only the time changes.
            let t = call(&s, &me, "update_task", json!({"task_id": "KIW-1", "remind_at": "2030-01-02T09:00:00+13:00", "starred": false})).await.unwrap();
            assert_eq!((t["remind_at"].as_str(), t["reminder"].as_str()), (Some("2030-01-01T20:00:00.000Z"), Some("Check CI")));
            assert!(t["starred"].is_null());
            let err = call(&s, &me, "update_task", json!({"task_id": "KIW-1", "starred": "yes"})).await.unwrap_err();
            assert!(err.contains("starred must be"), "{err}");
            let err = call(&s, &me, "update_task", json!({"task_id": "KIW-1", "remind_at": 5})).await.unwrap_err();
            assert!(err.contains("remind_at must be"), "{err}");
            let err = call(&s, &me, "update_task", json!({"task_id": "KIW-1", "remind_at": "soon"})).await.unwrap_err();
            assert!(err.contains("remind_at must be"), "{err}");
            // Clearing the time clears the note, and a note needs a time.
            let t = call(&s, &me, "update_task", json!({"task_id": "KIW-1", "remind_at": ""})).await.unwrap();
            assert!(t["remind_at"].is_null());
            let t = db::get_task(&s.db(), t["id"].as_str().unwrap()).unwrap().unwrap();
            assert_eq!((t.remind_at, t.reminder), (None, None));
            let err = call(&s, &me, "update_task", json!({"task_id": "KIW-1", "reminder": "Why"})).await.unwrap_err();
            assert!(err.contains("needs remind_at"), "{err}");
            // A bad time doesn't leave a task behind.
            assert!(call(&s, &me, "create_task", json!({"title": "Bad", "remind_at": "whenever", "project_id": "KIW"})).await.is_err());
            assert_eq!(db::list_tasks_for_project(&s.db(), "kiwicd", "task").unwrap().len(), 1);
        });
    }

    #[test]
    fn a_create_task_with_bad_marks_leaves_no_task() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "kiwicd", "KIW");
            let me = ctx(&p);
            let long = "x".repeat(501);
            for (args, why) in [
                (json!({"reminder": "Check CI"}), "needs remind_at"),
                (json!({"starred": "yes"}), "starred must be"),
                (json!({"remind_at": "2h", "reminder": long}), "at most 500"),
                (json!({"remind_at": 5}), "remind_at must be"),
                (json!({"remind_at": "whenever"}), "remind_at must be"),
            ] {
                let mut args = args;
                args["title"] = json!("Bad");
                args["project_id"] = json!("KIW");
                let err = call(&s, &me, "create_task", args.clone()).await.unwrap_err();
                assert!(err.contains(why), "{args}: {err}");
                assert!(db::list_tasks_for_project(&s.db(), "kiwicd", "task").unwrap().is_empty(), "{args} left a task");
            }
            let t = call(&s, &me, "create_task", json!({"title": "Good", "project_id": "KIW", "remind_at": "1d", "reminder": "Look again"})).await.unwrap();
            assert_eq!(t["reminder"], "Look again");
        });
    }

    #[test]
    fn scratch_tasks_get_their_marks_too() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            let me = ctx(&p);
            let scratch = |extra: Value| {
                let mut args = json!({"type": "scratch", "title": "Scratch with reminder"});
                args.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
                args
            };
            let t = call(&s, &me, "create_task", scratch(json!({"starred": true, "remind_at": "2h", "reminder": "Come back to this"}))).await.unwrap();
            let t = db::get_task(&s.db(), t["id"].as_str().unwrap()).unwrap().unwrap();
            assert!(t.starred && t.remind_at.is_some(), "{t:?}");
            assert_eq!(t.reminder.as_deref(), Some("Come back to this"));
            // Bad ones fail before it's made.
            let count = || db::list_tasks_for_profile(&s.db(), &p.id).unwrap().len();
            let before = count();
            for bad in [json!({"remind_at": "whenever"}), json!({"reminder": "No time"}), json!({"starred": "yes"})] {
                assert!(call(&s, &me, "create_task", scratch(bad.clone())).await.is_err(), "{bad}");
                assert_eq!(count(), before, "{bad} left a task");
            }
        });
    }

    #[test]
    fn marks_only_go_to_hosts_that_can_set_them() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            let me = ctx(&p);
            // Linked hosts that answer every tool call, and note which they were sent.
            let calls: std::sync::Arc<std::sync::Mutex<Vec<(String, String)>>> = Default::default();
            for (name, api) in [("old", MARKS_API - 1), ("new", MARKS_API)] {
                let calls = calls.clone();
                let app = axum::Router::new().route(
                    "/api/tools/{tool}",
                    axum::routing::post(move |axum::extract::Path(tool): axum::extract::Path<String>| async move {
                        calls.lock().unwrap().push((name.to_string(), tool));
                        axum::Json(json!({"result": {"ok": true}}))
                    }),
                );
                hub::link_http(&s, name, app, api).await;
            }
            let sent = || std::mem::take(&mut *calls.lock().unwrap());
            // Named, an older host is refused, clearing a mark too; anything else still goes.
            for marks in [json!({"remind_at": "2h"}), json!({"starred": false}), json!({"reminder": ""})] {
                let mut args = marks.clone();
                args["task_id"] = json!("OLD-1");
                args["host"] = json!("old");
                let err = dispatch(&s, &me, "update_task", args).await.unwrap_err();
                assert!(err.contains("old runs an older build"), "{marks}: {err}");
            }
            let err = dispatch(&s, &me, "create_task", json!({"title": "T", "host": "old", "starred": true})).await.unwrap_err();
            assert!(err.contains("older build"), "{err}");
            assert_eq!(sent(), vec![]);
            dispatch(&s, &me, "update_task", json!({"task_id": "OLD-1", "host": "old", "title": "T"})).await.unwrap();
            dispatch(&s, &me, "update_task", json!({"task_id": "NEW-1", "host": "new", "remind_at": "2h"})).await.unwrap();
            assert_eq!(sent(), vec![("old".into(), "update_task".into()), ("new".into(), "update_task".into())]);
            // Not found here, it's only tried on the hosts that can do it.
            dispatch(&s, &me, "update_task", json!({"task_id": "ELSE-1", "starred": true})).await.unwrap();
            assert_eq!(sent(), vec![("new".into(), "update_task".into())]);
        });
    }

    #[test]
    fn reads_reminder_times() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-26T10:00:00Z").unwrap().with_timezone(&chrono::Utc);
        let at = |v: &str| reminder_time(v, now);
        assert_eq!(at("30m").as_deref(), Some("2026-10-26T10:30:00.000Z"));
        assert_eq!(at("in 2 hours").as_deref(), Some("2026-10-26T12:00:00.000Z"));
        assert_eq!(at("1d 12h").as_deref(), Some("2026-10-27T22:00:00.000Z"));
        assert_eq!(at("1w").as_deref(), Some("2026-11-02T10:00:00.000Z"));
        assert_eq!(at("2026-12-01T09:00:00Z").as_deref(), Some("2026-12-01T09:00:00Z"));
        assert_eq!(at(" ").as_deref(), Some(""));
        // In the host's time zone, whatever that is.
        for v in ["2026-12-01 09:00", "2026-12-01T09:00", "2026-12-01"] {
            assert!(chrono::DateTime::parse_from_rfc3339(&at(v).unwrap()).is_ok(), "{v}");
        }
        for v in ["soon", "2", "h", "3 fortnights", "99999d", "tomorrow"] {
            assert_eq!(at(v), None, "{v}");
        }
    }

    #[test]
    fn a_repository_path_it_cant_have_is_refused_before_asking() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "os", "OS");
            let me = ctx(&p);
            // Without a thread to ask in, a change it could make would say it needs approval.
            for (args, err) in [
                (json!({"project_id": "OS", "repo_path": "/nowhere"}), "/nowhere isn't a folder"),
                (json!({"project_id": "OS", "repo_path": "/nowhere", "move_repo": true}), "/x doesn't exist, so there's nothing to move"),
                (json!({"project_id": "OS", "move_repo": true}), "move_repo needs a new repo_path"),
                (json!({"project_id": "OS", "repo_path": "/x", "move_repo": true}), "move_repo needs a new repo_path"),
            ] {
                let e = call(&s, &me, "update_project", args).await.unwrap_err();
                assert!(e.contains(err), "{e}");
            }
            assert_eq!(db::get_project(&s.db(), "os").unwrap().unwrap().repo_path, "/x");
        })
    }

    #[test]
    fn a_renamed_projects_old_key_still_names_its_tasks() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "os", "OS");
            project(&s, &p, "web", "WEB");
            task(&s, "os", "Sandbox");
            let me = ctx(&p);
            let v = call(&s, &me, "update_project", json!({"project_id": "OS", "name": " omarchy-sandbox ", "key": "oms"})).await.unwrap();
            assert_eq!((v["name"].as_str(), v["key"].as_str(), v["former_keys"].clone()), (Some("omarchy-sandbox"), Some("OMS"), json!(["OS"])));
            assert_eq!(call(&s, &me, "get_task", json!({"task_id": "OMS-1"})).await.unwrap()["key"], "OMS-1");
            assert_eq!(call(&s, &me, "get_task", json!({"task_id": "os-1"})).await.unwrap()["key"], "OMS-1");
            assert_eq!(call(&s, &me, "get_project", json!({"project_id": "OS"})).await.unwrap()["key"], "OMS");
            // Keys are checked, and are the project's alone.
            for (args, err) in [
                (json!({"project_id": "OMS", "key": "WEB"}), "already has the key WEB"),
                (json!({"project_id": "OMS", "key": "O-S"}), "letters or digits"),
                (json!({"project_id": "OMS", "name": "  "}), "name can't be blank"),
            ] {
                let e = call(&s, &me, "update_project", args).await.unwrap_err();
                assert!(e.contains(err), "{e}");
            }
            // Changing back drops it from the old keys.
            let v = call(&s, &me, "update_project", json!({"project_id": "OMS", "key": "OSX"})).await.unwrap();
            assert_eq!(v["former_keys"], json!(["OS", "OMS"]));
            let v = call(&s, &me, "update_project", json!({"project_id": "OSX", "key": "OS"})).await.unwrap();
            assert_eq!(v["former_keys"], json!(["OMS", "OSX"]));
            // Its old keys stay its own, so they keep naming its tasks.
            let e = call(&s, &me, "update_project", json!({"project_id": "WEB", "key": "OMS"})).await.unwrap_err();
            assert!(e.contains("old task keys still use it"), "{e}");
            let e = api::create_project_inner(&s, &p.id, api::CreateProject { name: "x".into(), repo_path: "/".into(), key: Some("OSX".into()), base_branch: None, use_worktrees: None })
                .await
                .unwrap_err();
            assert!(e.1.contains("old task keys still use it"), "{}", e.1);
            assert_eq!(call(&s, &me, "get_task", json!({"task_id": "OMS-1"})).await.unwrap()["title"], "Sandbox");
            assert_eq!(call(&s, &me, "get_task", json!({"task_id": "OSX-1"})).await.unwrap()["title"], "Sandbox");
            // A derived key steers clear of them too.
            let site = api::create_project_inner(&s, &p.id, api::CreateProject { name: "Oms".into(), repo_path: "/".into(), key: None, base_branch: None, use_worktrees: None }).await.unwrap();
            assert_eq!(site.key, "OMS2");
            // Projects that shared a key before it was checked: their tasks are named by id instead.
            db::update_project(&s.db(), "web", &[("former_keys", json!(json!(["OS"]).to_string()))]).unwrap();
            task(&s, "web", "Site");
            let e = call(&s, &me, "get_task", json!({"task_id": "OS-1"})).await.unwrap_err();
            assert!(e.contains("more than one task"), "{e}");
        });
    }

    #[test]
    fn agents_read_and_change_a_projects_prompts() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "kiwicd", "KIW");
            let me = Ctx { task: Some(task(&s, "kiwicd", "Caller")), ..ctx(&p) };
            // The caller's own project by default, with every prompt the default.
            let v = call(&s, &me, "get_project", json!({})).await.unwrap();
            assert_eq!(v["key"], "KIW");
            assert_eq!(v["merge_prompt"], json!({"instructions": crate::prompts::DEFAULT_MERGE, "default": true}));
            let v = call(&s, &me, "update_project", json!({"merge_prompt": "  Squash-merge it.  ", "review_rounds": 3})).await.unwrap();
            assert_eq!(v["merge_prompt"], json!({"instructions": "Squash-merge it.", "default": false}));
            assert_eq!(v["start_prompt"]["default"], true);
            assert_eq!(v["review_rounds"], 3);
            let project = db::get_project(&s.db(), "kiwicd").unwrap().unwrap();
            assert_eq!(project.merge_prompt.as_deref(), Some("Squash-merge it."));
            // An empty string goes back to the default.
            let v = call(&s, &me, "update_project", json!({"project_id": "KIW", "merge_prompt": "", "name": "Kiwi CD", "model": "opus"})).await.unwrap();
            assert_eq!((&v["merge_prompt"]["default"], &v["name"], &v["model"]), (&json!(true), &json!("Kiwi CD"), &json!("opus")));
            assert_eq!(call(&s, &me, "update_project", json!({"model": ""})).await.unwrap()["model"], Value::Null);
            assert!(db::get_project(&s.db(), "kiwicd").unwrap().unwrap().merge_prompt.is_none());
            // Changes that need the user's approval can't be asked for without a call to ask in
            // (from another host), and none of the call's changes are made.
            let err = call(&s, &me, "update_project", json!({"permission_mode": "bypassPermissions", "name": "Other"})).await.unwrap_err();
            assert!(err.contains("needs the user's approval"), "{err}");
            let project = db::get_project(&s.db(), "kiwicd").unwrap().unwrap();
            assert_eq!((project.name.as_str(), project.permission_mode), ("Kiwi CD", None));
            // Setting one to what it already is doesn't need it.
            call(&s, &me, "update_project", json!({"setup_script": "", "use_worktrees": false})).await.unwrap();
            // The agent configs are the user's to change.
            let err = call(&s, &me, "update_project", json!({"claude_config_ids": []})).await.unwrap_err();
            assert!(err.contains("only be changed by the user"), "{err}");
            assert!(call(&s, &me, "update_project", json!({"name": " "})).await.is_err());
            // Reviewers: blanks dropped, configs checked, an empty list back to the task's own.
            let codex = db::insert_claude_config(&s.db(), "Codex", "", "codex").unwrap();
            let two = json!([{"claude_config_id": codex.id, "model": "gpt-5"}, {"model": " opus ", "effort": ""}]);
            let v = call(&s, &me, "update_project", json!({"reviewers": two})).await.unwrap();
            assert_eq!(v["reviewers"], json!([{"claude_config_id": codex.id, "model": "gpt-5", "effort": null}, {"claude_config_id": null, "model": "opus", "effort": null}]));
            assert_eq!(db::get_project(&s.db(), "kiwicd").unwrap().unwrap().reviewers.len(), 2);
            assert!(call(&s, &me, "update_project", json!({"reviewers": [{"claude_config_id": "nope"}]})).await.is_err());
            call(&s, &me, "update_project", json!({"reviewers": []})).await.unwrap();
            // A summarizer of its own, over the profile's, and back to the profile's with null.
            let v = call(&s, &me, "update_project", json!({"summarizer": {"model": "sonnet"}})).await.unwrap();
            assert_eq!(v["summarizer"]["model"], "sonnet");
            let v = call(&s, &me, "update_project", json!({"summarizer": null})).await.unwrap();
            assert_eq!(v["summarizer"], Value::Null);
            assert_eq!(db::get_project(&s.db(), "kiwicd").unwrap().unwrap().summarizer, None);
            call(&s, &me, "update_project", json!({"reviewers": [{"model": "opus"}]})).await.unwrap();
            call(&s, &me, "update_project", json!({"reviewers": null})).await.unwrap();
            assert!(db::get_project(&s.db(), "kiwicd").unwrap().unwrap().reviewers.is_empty());
            assert_eq!(call(&s, &me, "update_project", json!({"group_name": "Kiwi"})).await.unwrap()["group_name"], "Kiwi");
            assert_eq!(call(&s, &me, "update_project", json!({"group_name": ""})).await.unwrap()["group_name"], Value::Null);
        });
    }

    /// The next project change or deletion waiting for approval, once there is one.
    async fn approval_asked(s: &Shared) -> Value {
        loop {
            if let Some(a) = permissions::pending_approvals(s, true, true).unwrap().into_iter().next() {
                return a;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }

    /// Answers the next project change or deletion waiting for approval, once there is one, and returns it.
    async fn answer_approval(s: &Shared, allow: bool) -> Value {
        let a = approval_asked(s).await;
        // "Always" doesn't apply to project changes or deletions.
        permissions::decide(s, a["request_id"].as_str().unwrap(), allow, true, None).unwrap();
        a
    }

    #[test]
    fn only_new_hosts_get_calls_older_ones_would_half_do() {
        // There's no tool to delete a project.
        assert!(!needs_project_settings_api("delete_project", &json!({"project_id": "KIW"})));
        assert!(needs_project_settings_api("update_project", &json!({"name": "Kiwi", "auto_review": true})));
        assert!(needs_project_settings_api("update_project", &json!({"setup_script": ""})));
        assert!(!needs_project_settings_api("update_project", &json!({"auto_review": true, "merge_prompt": "", "group_name": "Kiwi"})));
        assert!(!needs_project_settings_api("get_project", &json!({"name": "Kiwi"})));
        // A host on API 42 or 43 (task types, JSON 404s, but not these settings) would make the
        // old ones and drop the rest, so it isn't sent a mix; one on 44 is.
        let mixed = json!({"project_id": "KIW", "setup_script": "npm ci", "auto_review": false});
        for old in [42, 43] {
            assert!(too_old("laptop", old, "update_project", &mixed).is_some_and(|e| e.contains("laptop runs an older build")));
        }
        assert!(too_old("laptop", 44, "update_project", &mixed).is_none());
        assert!(too_old("laptop", 43, "update_project", &json!({"auto_review": false})).is_none());
        // One from before delete_task would only say it doesn't know it.
        assert!(too_old("laptop", 57, "delete_task", &json!({"task_id": "KIW-2"})).is_some_and(|e| e.contains("can't delete tasks")));
        assert!(too_old("laptop", 58, "delete_task", &json!({"task_id": "KIW-2"})).is_none());
    }

    #[test]
    fn agents_delete_tasks_only_once_the_user_confirms() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "kiwicd", "KIW");
            // Even a thread that may do anything without asking asks first.
            let caller = task(&s, "kiwicd", "Caller");
            s.update_task(&caller.id, &[("permission_mode", json!("bypassPermissions"))]).unwrap();
            let caller = db::get_task(&s.db(), &caller.id).unwrap().unwrap();
            let me = |call_id: &str| Ctx { task: Some(caller.clone()), call_id: Some(call_id.into()), ..ctx(&p) };
            let (doomed, kept) = (task(&s, "kiwicd", "Doomed"), task(&s, "kiwicd", "Kept"));
            let exists = |t: &Task| db::get_task(&s.db(), &t.id).unwrap().is_some();

            let err = call(&s, &me("c0"), "delete_task", json!({"task_id": "KIW-1"})).await.unwrap_err();
            assert!(err.contains("can't delete your own task"), "{err}");
            assert!(permissions::pending_approvals(&s, true, true).unwrap().is_empty());

            // Denied: nothing is deleted.
            let args = json!({"task_id": "KIW-3", "reason": "A duplicate of KIW-2"});
            let (c1, c2, c3) = (me("c1"), me("c2"), me("c3"));
            let (res, asked) = tokio::join!(call(&s, &c1, "delete_task", args), answer_approval(&s, false));
            let err = res.unwrap_err();
            assert!(err.contains("didn't approve deleting KIW-3, so nothing was deleted"), "{err}");
            assert!(exists(&kept));
            let input = &asked["input"];
            assert_eq!((&asked["kind"], &asked["tool_name"]), (&json!("delete_task"), &json!("delete_task")));
            assert_eq!((&input["delete"]["key"], &input["delete"]["title"], &input["task"]["key"]), (&json!("KIW-3"), &json!("Kept"), &json!("KIW-1")));
            assert_eq!((&input["project"]["key"], &input["reason"], &input["delete_branch"]), (&json!("KIW"), &json!("A duplicate of KIW-2"), &json!(false)));
            // It flagged the asking task, and only the UIs that know deletions are shown it.
            let flagged = db::get_task(&s.db(), &caller.id).unwrap().unwrap();
            assert_eq!(flagged.attention_reason.as_deref(), Some("Delete a task?"));

            // Confirmed: it's deleted.
            let asked = async {
                let a = approval_asked(&s).await;
                assert!(permissions::pending_approvals(&s, false, false).unwrap().is_empty());
                assert_eq!(permissions::pending(&s, Some(&caller.id)).unwrap().len(), 1);
                answer_approval(&s, true).await;
                a
            };
            let (res, _) = tokio::join!(call(&s, &c2, "delete_task", json!({"task_id": "KIW-2"})), asked);
            let res = res.unwrap();
            assert_eq!((&res["deleted"], &res["key"]), (&json!(true), &json!("KIW-2")));
            assert!(!exists(&doomed) && exists(&kept));

            // Deleted by someone else while the user is asked: the question goes, and the call says so.
            let delete = async {
                approval_asked(&s).await;
                api::delete_task_inner(&s, &kept, false).await.unwrap();
            };
            let (res, _) = tokio::join!(call(&s, &c3, "delete_task", json!({"task_id": "KIW-3"})), delete);
            assert_eq!(res.unwrap()["deleted"], false);
            assert!(permissions::pending_approvals(&s, true, true).unwrap().is_empty());

            // An agent on another host has no thread here to ask in.
            let other = task(&s, "kiwicd", "Other");
            let err = call(&s, &ctx(&p), "delete_task", json!({"task_id": "KIW-4"})).await.unwrap_err();
            assert!(err.contains("deleting KIW-4 needs the user's approval"), "{err}");
            assert!(exists(&other));
        });
    }

    #[test]
    fn a_retried_delete_deletes_what_it_asked_about() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "kiwicd", "KIW");
            let caller = task(&s, "kiwicd", "Caller");
            let me = Ctx { task: Some(caller.clone()), call_id: Some("c1".into()), ..ctx(&p) };
            let (doomed, kept) = (task(&s, "kiwicd", "Doomed"), task(&s, "kiwicd", "Kept"));
            // The server stops while the user is asked.
            let first = tokio::time::timeout(std::time::Duration::from_millis(100), call(&s, &me, "delete_task", json!({"task_id": "KIW-2"}))).await;
            assert!(first.is_err());
            // Redelivered, the call waits for the same question, and deletes the task it named.
            let (res, _) = tokio::join!(call(&s, &me, "delete_task", json!({"task_id": "KIW-3"})), answer_approval(&s, true));
            assert_eq!(res.unwrap()["key"], "KIW-2");
            assert!(db::get_task(&s.db(), &doomed.id).unwrap().is_none());
            assert!(db::get_task(&s.db(), &kept.id).unwrap().is_some());
        });
    }

    #[test]
    fn tasks_added_while_the_user_is_asked_are_not_deleted_unasked() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "kiwicd", "KIW");
            let new = |title: &str, parent: Option<&Task>, subproject: bool| {
                let body = CreateTask { parent_id: parent.map(|t| t.id.clone()), subproject: Some(subproject), title: title.into(), use_worktree: Some(false), ..Default::default() };
                api::create_task_inner(&s, "kiwicd", body).map_err(|e| e.1).unwrap()
            };
            let caller = new("Caller", None, false);
            let me = |call_id: &str| Ctx { task: Some(caller.clone()), call_id: Some(call_id.into()), ..ctx(&p) };
            let exists = |t: &Task| db::get_task(&s.db(), &t.id).unwrap().is_some();
            // A subproject gets a task while the user looks at what it has.
            let sp = new("Subproject", None, true);
            let shown = new("Shown", Some(&sp), false);
            let c1 = me("c1");
            let answer = async {
                approval_asked(&s).await;
                let late = new("Late", Some(&sp), false);
                answer_approval(&s, true).await;
                late
            };
            let (res, late) = tokio::join!(call(&s, &c1, "delete_task", json!({"task_id": "KIW-2"})), answer);
            let err = res.unwrap_err();
            assert!(err.contains("KIW-4 became tasks of KIW-2 while the user was asked, so nothing was deleted"), "{err}");
            assert!(exists(&sp) && exists(&shown) && exists(&late));
            // An ordinary task is made a subproject with a task meanwhile.
            let plain = new("Plain", None, false);
            let c2 = me("c2");
            let answer = async {
                approval_asked(&s).await;
                s.update_task(&plain.id, &[("subproject", json!(true))]).unwrap();
                let child = new("Child", Some(&plain), false);
                answer_approval(&s, true).await;
                child
            };
            let (res, child) = tokio::join!(call(&s, &c2, "delete_task", json!({"task_id": "KIW-5"})), answer);
            assert!(res.unwrap_err().contains("nothing was deleted"));
            assert!(exists(&plain) && exists(&child));
            // Asked again, the user sees them all, and they all go.
            let c3 = me("c3");
            let (res, asked) = tokio::join!(call(&s, &c3, "delete_task", json!({"task_id": "KIW-2"})), answer_approval(&s, true));
            assert_eq!(res.unwrap()["tasks_deleted_with_it"], 2);
            assert_eq!(asked["input"]["tasks_with_it"].as_array().unwrap().len(), 2);
            assert!(!exists(&sp) && !exists(&shown) && !exists(&late));
        });
    }

    #[test]
    fn no_task_joins_a_subproject_while_its_deleted() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            let dir = crate::testing::temp_dir();
            let repo = dir.join("repo");
            std::fs::create_dir_all(&repo).unwrap();
            let git = |args: &[&str]| {
                let out = std::process::Command::new("git").arg("-C").arg(&repo).args(["-c", "user.name=t", "-c", "user.email=t@t"]).args(args).output().unwrap();
                assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            };
            git(&["init", "-q", "-b", "master"]);
            git(&["commit", "-q", "--allow-empty", "-m", "init"]);
            let body = CreateProject { name: "Kiwi".into(), repo_path: crate::util::path_str(&repo), key: Some("KIW".into()), base_branch: Some("master".into()), use_worktrees: None };
            let project = api::create_project_inner(&s, &p.id, body).await.unwrap();
            // The subproject's teardown holds it until the test lets it go.
            let (started, go) = (dir.join("started"), dir.join("go"));
            let script = format!("touch '{}'; while [ ! -e '{}' ]; do sleep 0.05; done", started.display(), go.display());
            s.db().execute("UPDATE projects SET teardown_script=?1 WHERE id=?2", [&script, &project.id]).unwrap();
            let new = |title: &str, parent: Option<&Task>, subproject: bool| {
                let body = CreateTask { parent_id: parent.map(|t| t.id.clone()), subproject: Some(subproject), title: title.into(), use_worktree: Some(false), ..Default::default() };
                api::create_task_inner(&s, &project.id, body).map_err(|e| e.1)
            };
            let caller = new("Caller", None, false).unwrap();
            let sp = new("Subproject", None, true).unwrap();
            crate::worktree::setup(&s, &sp.id).await.unwrap();
            let shown = new("Shown", Some(&sp), false).unwrap();
            let me = Ctx { task: Some(caller.clone()), call_id: Some("c1".into()), ..ctx(&p) };
            let during = async {
                answer_approval(&s, true).await;
                while !started.exists() {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
                // Mid-teardown: the subproject is still there, but takes no new tasks.
                assert!(db::get_task(&s.db(), &sp.id).unwrap().is_some());
                let late = new("Late", Some(&sp), false);
                std::fs::write(&go, "").unwrap();
                late
            };
            let (res, late) = tokio::join!(call(&s, &me, "delete_task", json!({"task_id": "KIW-2"})), during);
            assert_eq!(res.unwrap()["tasks_deleted_with_it"], 1);
            assert!(late.unwrap_err().contains("being deleted"));
            assert!(db::get_task(&s.db(), &sp.id).unwrap().is_none() && db::get_task(&s.db(), &shown.id).unwrap().is_none());
            // Once it's gone, nothing stays held.
            assert!(s.deleting.lock().unwrap().is_empty());
            std::fs::remove_dir_all(&dir).ok();
        });
    }

    #[test]
    fn deleting_a_subproject_lists_its_tasks_and_spares_the_callers() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "kiwicd", "KIW");
            let new = |title: &str, parent: Option<&Task>, subproject: bool| {
                let body = CreateTask { parent_id: parent.map(|t| t.id.clone()), subproject: Some(subproject), title: title.into(), use_worktree: Some(false), ..Default::default() };
                api::create_task_inner(&s, "kiwicd", body).map_err(|e| e.1).unwrap()
            };
            let sp = new("Subproject", None, true);
            let (inside, child) = (new("Inside", Some(&sp), false), new("Child", Some(&sp), false));
            let outside = new("Outside", None, false);
            let ctx_of = |t: &Task| Ctx { task: Some(t.clone()), call_id: Some(format!("{}-call", t.title)), ..ctx(&p) };
            let err = call(&s, &ctx_of(&inside), "delete_task", json!({"task_id": "KIW-1"})).await.unwrap_err();
            assert!(err.contains("can't delete the subproject you're in"), "{err}");
            let from_outside = ctx_of(&outside);
            let (res, asked) = tokio::join!(call(&s, &from_outside, "delete_task", json!({"task_id": "KIW-1", "delete_branch": true})), answer_approval(&s, true));
            assert_eq!(res.unwrap()["tasks_deleted_with_it"], 2);
            let with_it: Vec<&str> = asked["input"]["tasks_with_it"].as_array().unwrap().iter().map(|t| t["key"].as_str().unwrap()).collect();
            assert_eq!((with_it, &asked["input"]["delete"]["subproject"], &asked["input"]["delete_branch"]), (vec!["KIW-2", "KIW-3"], &json!(true), &json!(true)));
            for t in [&sp, &inside, &child] {
                assert!(db::get_task(&s.db(), &t.id).unwrap().is_none());
            }
        });
    }

    #[test]
    fn deleting_a_thread_or_project_settles_its_approvals() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "kiwicd", "KIW");
            project(&s, &p, "other", "OTH");
            let (asker, other_asker) = (task(&s, "kiwicd", "Asker"), task(&s, "kiwicd", "Other asker"));
            let c1 = Ctx { task: Some(asker.clone()), call_id: Some("c1".into()), ..ctx(&p) };
            let c2 = Ctx { task: Some(other_asker), call_id: Some("c2".into()), ..ctx(&p) };
            // The thread that asked is deleted.
            let delete = async {
                approval_asked(&s).await;
                api::delete_one(&s, &asker, false).await.unwrap();
            };
            let (res, _) = tokio::join!(call(&s, &c1, "update_project", json!({"setup_script": "make"})), delete);
            assert!(res.unwrap_err().contains("Request expired"));
            assert!(permissions::pending_approvals(&s, true, true).unwrap().is_empty());
            // The project the change is for is deleted, from another project's thread.
            let delete = async {
                approval_asked(&s).await;
                api::delete_project_inner(&s, "other").await.unwrap();
            };
            let (res, _) = tokio::join!(call(&s, &c2, "update_project", json!({"project_id": "OTH", "setup_script": "make"})), delete);
            assert!(res.unwrap_err().contains("Request expired"));
            assert!(permissions::pending_approvals(&s, true, true).unwrap().is_empty());
        });
    }

    #[test]
    fn a_retried_call_carries_on_with_its_approval() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "kiwicd", "KIW");
            project(&s, &p, "old", "OLD");
            let caller = task(&s, "kiwicd", "Caller");
            let me = |call_id: &str| Ctx { task: Some(caller.clone()), call_id: Some(call_id.into()), ..ctx(&p) };
            let (c1, c2) = (me("c1"), me("c2"));
            // The server stops while the user is asked about the script (the name is as it was).
            let change = json!({"name": "kiwicd", "setup_script": "npm ci"});
            let first = tokio::time::timeout(std::time::Duration::from_millis(100), call(&s, &c1, "update_project", change.clone())).await;
            assert!(first.is_err());
            // Meanwhile the user renames the project and sets the script themselves.
            api::update_project_inner(&s, "kiwicd", json!({"name": "Kiwi", "setup_script": "npm ci"}).as_object().unwrap()).await.unwrap();
            // Redelivered, the call waits for the same approval and makes only what it showed.
            let (res, asked) = tokio::join!(call(&s, &c1, "update_project", change.clone()), answer_approval(&s, true));
            assert_eq!(res.unwrap()["name"], "Kiwi");
            assert_eq!(asked["input"]["changes"].as_array().unwrap().len(), 1);
            assert_eq!(permissions::pending_approvals(&s, true, true).unwrap().len(), 0);
            // Answered already: a denial stands, without asking again.
            let first = tokio::time::timeout(std::time::Duration::from_millis(100), call(&s, &c2, "update_project", json!({"setup_script": "make"}))).await;
            assert!(first.is_err());
            answer_approval(&s, false).await;
            api::update_project_inner(&s, "kiwicd", json!({"setup_script": ""}).as_object().unwrap()).await.unwrap();
            let err = call(&s, &c2, "update_project", json!({"setup_script": "make"})).await.unwrap_err();
            assert!(err.contains("didn't approve changing setup_script"), "{err}");
            assert_eq!(db::get_project(&s.db(), "kiwicd").unwrap().unwrap().setup_script, "");
            // There's no tool to delete a project.
            let err = call(&s, &me("c3"), "delete_project", json!({"project_id": "OLD"})).await.unwrap_err();
            assert!(err.contains("unknown tool"), "{err}");
            assert!(db::get_project(&s.db(), "old").unwrap().is_some());
        });
    }

    #[test]
    fn the_user_approves_risky_project_changes() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "kiwicd", "KIW");
            // Even a thread that may do anything without asking asks for these.
            let caller = task(&s, "kiwicd", "Caller");
            s.update_task(&caller.id, &[("permission_mode", json!("bypassPermissions"))]).unwrap();
            let caller = db::get_task(&s.db(), &caller.id).unwrap().unwrap();
            let me = |call_id: &str| Ctx { task: Some(caller.clone()), call_id: Some(call_id.into()), ..ctx(&p) };
            let (c1, c2) = (me("c1"), me("c2"));
            let change = json!({"permission_mode": "bypassPermissions", "setup_script": "npm ci", "base_branch": "main", "reason": "Faster setup"});

            // Denied: nothing changes, and the agent hears why.
            let (res, asked) = tokio::join!(call(&s, &c1, "update_project", change.clone()), answer_approval(&s, false));
            let err = res.unwrap_err();
            assert!(err.contains("didn't approve changing setup_script, permission_mode"), "{err}");
            let project = db::get_project(&s.db(), "kiwicd").unwrap().unwrap();
            assert_eq!((project.permission_mode, project.setup_script.as_str(), project.base_branch), (None, "", None));
            assert_eq!(asked["tool_name"], "update_project");
            assert_eq!(asked["task_id"], json!(caller.id));
            let input = &asked["input"];
            assert_eq!((&input["project"]["key"], &input["task"]["key"], &input["reason"]), (&json!("KIW"), &json!("KIW-1"), &json!("Faster setup")));
            let field = |f: &str| input["changes"].as_array().unwrap().iter().find(|c| c["field"] == f).cloned().unwrap();
            assert_eq!(field("permission_mode"), json!({"field": "permission_mode", "from": null, "to": "bypassPermissions", "needs_approval": true}));
            assert_eq!(field("base_branch")["needs_approval"], false);

            // A changed thread mode doesn't settle it either; approved, the whole call is made.
            let dont_ask = Task { permission_mode: Some("dontAsk".into()), ..caller.clone() };
            let approve = async {
                approval_asked(&s).await;
                permissions::apply_mode_to_pending(&s, &dont_ask).unwrap();
                answer_approval(&s, true).await
            };
            let (res, _) = tokio::join!(call(&s, &c2, "update_project", change.clone()), approve);
            let v = res.unwrap();
            assert_eq!((&v["permission_mode"], &v["setup_script"], &v["base_branch"]), (&json!("bypassPermissions"), &json!("npm ci"), &json!("main")));
            assert!(db::get_task(&s.db(), &caller.id).unwrap().unwrap().auto_allow.is_empty());

            // Only what differs is shown and made: a setting the call leaves as it was isn't
            // written back over a change made while the user decides.
            let c5 = me("c5");
            let again = json!({"permission_mode": "bypassPermissions", "setup_script": "npm install"});
            let approve = async {
                approval_asked(&s).await;
                api::update_project_inner(&s, "kiwicd", json!({"permission_mode": "default"}).as_object().unwrap()).await.unwrap();
                answer_approval(&s, true).await
            };
            let (res, asked) = tokio::join!(call(&s, &c5, "update_project", again), approve);
            let fields: Vec<&str> = asked["input"]["changes"].as_array().unwrap().iter().filter_map(|c| c["field"].as_str()).collect();
            assert_eq!(fields, ["setup_script"]);
            assert_eq!((&res.unwrap()["permission_mode"], &db::get_project(&s.db(), "kiwicd").unwrap().unwrap().setup_script), (&json!("default"), &"npm install".to_string()));

            // Settings given in another form than they're kept in, but that come to what they are
            // (a blank column script is none, no reviewers is the profile's), aren't changes, so
            // nothing is asked.
            let same = json!({"status_scripts": {"done": "  "}, "reviewers": [], "use_worktrees": false, "repo_path": "/x"});
            let v = call(&s, &me("c6"), "update_project", same).await.unwrap();
            assert_eq!((&v["status_scripts"], &v["reviewers"]), (&json!({}), &json!([])));
            assert!(permissions::pending_approvals(&s, true, true).unwrap().is_empty());
        });
    }

    #[test]
    fn files_brought_into_worktrees_need_the_users_approval() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "kiwicd", "KIW");
            let caller = task(&s, "kiwicd", "Caller");
            let me = |call_id: &str| Ctx { task: Some(caller.clone()), call_id: Some(call_id.into()), ..ctx(&p) };
            let change = json!({"copy_files": ".env", "link_folders": "models"});
            let (c1, c2) = (me("c1"), me("c2"));
            let (res, asked) = tokio::join!(call(&s, &c1, "update_project", change.clone()), answer_approval(&s, false));
            assert!(res.unwrap_err().contains("didn't approve changing copy_files, link_folders"));
            let fields: Vec<&str> = asked["input"]["changes"].as_array().unwrap().iter().filter_map(|c| c["field"].as_str()).collect();
            assert_eq!(fields, ["copy_files", "link_folders"]);
            let project = db::get_project(&s.db(), "kiwicd").unwrap().unwrap();
            assert_eq!((project.copy_files.as_str(), project.link_folders.as_str()), ("", ""));
            let (res, _) = tokio::join!(call(&s, &c2, "update_project", change), answer_approval(&s, true));
            let v = res.unwrap();
            assert_eq!((&v["copy_files"], &v["link_folders"]), (&json!(".env"), &json!("models")));
            // Checked like the API checks them, before asking.
            let err = call(&s, &me("c3"), "update_project", json!({"link_folders": "../elsewhere"})).await.unwrap_err();
            assert!(err.contains("link_folders: ../elsewhere"), "{err}");
        });
    }

    #[test]
    fn agents_add_projects_only_once_the_user_approves_the_folder() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "kiwicd", "KIW");
            // Even a thread that may do anything without asking asks first.
            let caller = task(&s, "kiwicd", "Caller");
            s.update_task(&caller.id, &[("permission_mode", json!("bypassPermissions"))]).unwrap();
            let caller = db::get_task(&s.db(), &caller.id).unwrap().unwrap();
            let me = |call_id: &str| Ctx { task: Some(caller.clone()), call_id: Some(call_id.into()), ..ctx(&p) };
            let root = crate::testing::temp_dir();
            std::fs::create_dir_all(root.join("home")).unwrap();
            let root = root.canonicalize().unwrap();
            let home = root.join("home");
            let projects = || db::list_projects(&s.db(), &p.id).unwrap().len();

            // Denied: no project, and no folder made.
            let new = root.join("new").join("site");
            let args = json!({"repo_path": new, "name": "Site", "reason": "The user asked for one"});
            let (c1, c2, c3) = (me("c1"), me("c2"), me("c3"));
            let (res, asked) = tokio::join!(call(&s, &c1, "create_project", args.clone()), answer_approval(&s, false));
            let err = res.unwrap_err();
            assert!(err.contains(&format!("didn't approve adding {} as a project, so nothing was added", new.display())), "{err}");
            assert_eq!((projects(), root.join("new").exists()), (1, false));
            assert_eq!((&asked["kind"], &asked["tool_name"]), (&json!("project"), &json!("create_project")));
            let input = &asked["input"];
            assert_eq!((&input["op"], &input["repo_path"], &input["exists"], &input["git"]), (&json!("create"), &json!(new), &json!(false), &json!(false)));
            assert_eq!((&input["project"]["name"], &input["project"]["key"], &input["board"]), (&json!("Site"), &json!("SIT"), &json!("personal")));
            assert_eq!((&input["task"]["key"], &input["reason"], &input["permission_mode"]), (&json!("KIW-1"), &json!("The user asked for one"), &json!("default")));
            assert_eq!(db::get_task(&s.db(), &caller.id).unwrap().unwrap().attention_reason.as_deref(), Some("Add a project?"));

            // Approved: it's added where the user saw, with symlinks and `..` resolved first.
            std::os::unix::fs::symlink(&home, root.join("link")).unwrap();
            let (res, asked) = tokio::join!(call(&s, &c2, "create_project", json!({"repo_path": root.join("link").join("..").join("link")})), answer_approval(&s, true));
            let v = res.unwrap();
            assert_eq!((&asked["input"]["repo_path"], &asked["input"]["exists"], &asked["input"]["project"]["name"]), (&json!(home), &json!(true), &json!("home")));
            assert_eq!((&v["repo_path"], &v["name"], &v["profile"]), (&json!(home), &json!("home"), &json!("personal")));
            assert_eq!(projects(), 2);

            // Paths that aren't plainly somewhere aren't asked about.
            for bad in ["relative/path", "", "/nonexistent-ia/../x"] {
                let err = call(&s, &c3, "create_project", json!({"repo_path": bad})).await.unwrap_err();
                assert!(err.contains("absolute path") || err.contains("can be created"), "{bad}: {err}");
            }
            std::fs::write(root.join("file"), "").unwrap();
            assert!(call(&s, &c3, "create_project", json!({"repo_path": root.join("file")})).await.unwrap_err().contains("is not a directory"));
            assert!(permissions::pending_approvals(&s, true, true).unwrap().is_empty());

            // An agent on another host has no thread here to ask in.
            let err = call(&s, &ctx(&p), "create_project", json!({"repo_path": root.join("remote")})).await.unwrap_err();
            assert!(err.contains("needs the user's approval, which only an agent on the board's own host can ask for"), "{err}");
            assert_eq!((projects(), root.join("remote").exists()), (2, false));

            // Cut short by a restart while the user is asked, the retried call waits for the same answer.
            let run = started_run(&s, &caller.id);
            let later = root.join("later");
            let mcp = || McpCall { task_fields: true, run_id: run.id.clone(), call_id: "m1".into(), tool: "create_project".into(), args: json!({"repo_path": later}) };
            assert!(tokio::time::timeout(std::time::Duration::from_millis(100), handle_mcp(&s, mcp())).await.is_err());
            let (res, _) = tokio::join!(handle_mcp(&s, mcp()), answer_approval(&s, true));
            assert_eq!(res.unwrap()["repo_path"], json!(later));
            assert_eq!((projects(), later.is_dir()), (3, true));
            std::fs::remove_dir_all(&root).unwrap();
        });
    }

    #[test]
    fn scratch_tasks_are_made_in_no_project_unless_given_one() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "web", "WEB");
            let me = ctx(&p);
            let t = call(&s, &me, "create_task", json!({"title": "Try it", "type": "scratch"})).await.unwrap();
            assert_eq!((t["key"].as_str(), t["type"].as_str(), &t["project_id"]), (Some("S-1"), Some("scratch"), &Value::Null));
            let err = call(&s, &me, "create_task", json!({"title": "x", "type": "scratch", "is_subproject": true})).await.unwrap_err();
            assert!(err.contains("can't be a subproject"), "{err}");
            assert_eq!(call(&s, &me, "get_task", json!({"task_id": "s-1"})).await.unwrap()["title"], "Try it");
            assert!(call(&s, &me, "get_task", json!({"task_id": "S-2"})).await.is_err());
            // On its profile's board with the rest.
            let all = call(&s, &me, "list_tasks", json!({"project_id": "all"})).await.unwrap();
            assert_eq!(keys(&all, "key"), ["personal:S-1"]);

            // Given a project (API 51), it's in that project.
            let t = call(&s, &me, "create_task", json!({"title": "Ask", "type": "scratch", "project_id": "WEB"})).await.unwrap();
            assert_eq!((t["key"].as_str(), t["type"].as_str(), t["project_id"].as_str()), (Some("WEB-1"), Some("scratch"), Some("web")));
            // A subproject is a type too, and a scratch task can be in one.
            let sp = call(&s, &me, "create_task", json!({"title": "Search", "type": "subproject", "project_id": "WEB"})).await.unwrap();
            assert_eq!((sp["key"].as_str(), sp["is_subproject"].as_bool()), (Some("WEB-2"), Some(true)));
            let t = call(&s, &me, "create_task", json!({"title": "Ask", "type": "scratch", "subproject": "WEB-2"})).await.unwrap();
            assert_eq!((t["key"].as_str(), t["type"].as_str(), t["subproject"].as_str()), (Some("WEB-3"), Some("scratch"), Some("WEB-2")));
            // An agent in a project still makes one in no project unless it says otherwise.
            let worker = db::get_task(&s.db(), t["id"].as_str().unwrap()).unwrap().unwrap();
            let them = Ctx { task: Some(worker), ..ctx(&p) };
            let t = call(&s, &them, "create_task", json!({"title": "Elsewhere", "type": "scratch"})).await.unwrap();
            assert_eq!((t["key"].as_str(), &t["project_id"]), (Some("S-2"), &Value::Null));
        });
    }

    #[test]
    fn a_group_task_creates_tasks_in_its_groups_projects() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "web", "WEB");
            project(&s, &p, "api", "API");
            for id in ["web", "api"] {
                db::update_project(&s.db(), id, &[("group_name", json!("Shop"))]).unwrap();
            }
            let new = |title| db::NewTask { profile_id: &p.id, project_id: None, kind: "task", title, description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
            let planner = db::insert_group_task(&s.db(), new("Plan checkout"), "Shop").unwrap();
            assert_eq!((planner.number, planner.group_name.as_deref()), (1, Some("Shop")));
            // Numbered across the profile's groups, so each key names one task.
            let blog = db::insert_group_task(&s.db(), new("Plan posts"), "Blog").unwrap();
            assert_eq!(blog.number, 2);
            assert_eq!(db::insert_group_task(&s.db(), new("Plan search"), "Shop").unwrap().number, 3);

            let me = Ctx { task: Some(planner.clone()), ..ctx(&p) };
            // It's in no project, so each task needs one.
            let err = call(&s, &me, "create_task", json!({"title": "x"})).await.unwrap_err();
            assert!(err.contains("project_id is required"), "{err}");
            let t = call(&s, &me, "create_task", json!({"title": "Cart API", "project_id": "API"})).await.unwrap();
            assert_eq!(t["key"], "API-1");
            assert_eq!(db::get_task(&s.db(), t["id"].as_str().unwrap()).unwrap().unwrap().created_by.as_deref(), Some(planner.id.as_str()));
            let got = call(&s, &me, "get_task", json!({"task_id": planner.id})).await.unwrap();
            assert_eq!((got["key"].as_str(), got["group_task"].as_str()), (Some("G-1"), Some("Shop")));
            assert_eq!(got["created_tasks"][0]["key"], "API-1");

            // Their keys name them to the board tools.
            let me = ctx(&p);
            assert_eq!(call(&s, &me, "get_task", json!({"task_id": "G-2"})).await.unwrap()["title"], "Plan posts");
            let v = call(&s, &me, "update_task", json!({"task_id": "g-2", "title": "Plan the blog"})).await.unwrap();
            assert_eq!((v["id"].as_str(), v["key"].as_str()), (Some(blog.id.as_str()), Some("G-2")));
            assert!(call(&s, &me, "get_task", json!({"task_id": "G-9"})).await.is_err());

            // No project can take the key now, and one that had it from before moves to a free
            // one (as the migration does), so both keep keys that name them.
            let err = api::update_project_inner(&s, "web", json!({"key": "g"}).as_object().unwrap()).await.unwrap_err();
            assert!(err.1.contains("used by group tasks"), "{}", err.1);
            project(&s, &p, "old", "G");
            project(&s, &p, "gp", "GP");
            task(&s, "old", "Old work");
            db::free_group_task_key(&s.db()).unwrap();
            assert_eq!(db::get_project(&s.db(), "old").unwrap().unwrap().key, "GP2");
            assert_eq!(call(&s, &me, "get_task", json!({"task_id": "G-1"})).await.unwrap()["title"], "Plan checkout");
            assert_eq!(call(&s, &me, "get_task", json!({"task_id": "GP2-1"})).await.unwrap()["title"], "Old work");
            let v = call(&s, &me, "update_task", json!({"task_id": "G-1", "title": "Plan the checkout"})).await.unwrap();
            assert_eq!(v["id"].as_str(), Some(planner.id.as_str()));
            let v = call(&s, &me, "update_task", json!({"task_id": "GP2-1", "status": "backlog"})).await.unwrap();
            assert_eq!((v["key"].as_str(), v["status"].as_str()), (Some("GP2-1"), Some("backlog")));
        });
    }

    #[test]
    fn lists_only_the_created_tasks_the_caller_can_reach() {
        testing::run(async || {
            let s = state();
            let [personal, work, lab] = ["personal", "work", "lab"].map(|n| insert_profile(&s.db(), n, &[], None).unwrap());
            project(&s, &personal, "web", "WEB");
            project(&s, &work, "sd", "SD");
            db::update_project(&s.db(), "web", &[("group_name", json!("Shop"))]).unwrap();
            let new = db::NewTask { profile_id: &personal.id, project_id: None, kind: "task", title: "Plan", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
            let planner = db::insert_group_task(&s.db(), new, "Shop").unwrap();
            grant(&s, &work, &["personal"]);
            grant(&s, &personal, &["lab"]);
            let me = Ctx { task: Some(planner.clone()), ..ctx(&personal) };
            call(&s, &me, "create_task", json!({"title": "Mine", "project_id": "WEB"})).await.unwrap();
            call(&s, &me, "create_task", json!({"title": "Theirs", "project_id": "work:SD"})).await.unwrap();
            let titles = |v: &Value| {
                let created: Value = serde_json::from_str(v["content"].as_str().unwrap()).unwrap();
                created.as_array().unwrap().iter().map(|t| t["title"].as_str().unwrap().to_string()).collect::<Vec<_>>()
            };
            let get = json!({"task_id": planner.id, "field": "created_tasks", "limit": TASK_FIELD_MAX_LIMIT});
            assert_eq!(titles(&call(&s, &ctx(&personal), "get_task_field", get.clone()).await.unwrap()), ["Mine", "Theirs"]);
            // Lab reaches personal's board but not work's.
            assert_eq!(titles(&call(&s, &ctx(&lab), "get_task_field", get.clone()).await.unwrap()), ["Mine"]);
            // Nor does personal once work stops letting it in.
            grant(&s, &work, &[]);
            assert_eq!(titles(&call(&s, &ctx(&personal), "get_task_field", get.clone()).await.unwrap()), ["Mine"]);
        });
    }

    #[test]
    fn group_tasks_have_no_dependencies() {
        testing::run(async || {
            let s = state();
            let [personal, work, lab] = ["personal", "work", "lab"].map(|n| insert_profile(&s.db(), n, &[], None).unwrap());
            for (p, id) in [(&personal, "web"), (&work, "sd")] {
                project(&s, p, id, &id.to_uppercase());
                db::update_project(&s.db(), id, &[("group_name", json!("Shop"))]).unwrap();
            }
            let planner = |p: &db::Profile, title| {
                let new = db::NewTask { profile_id: &p.id, project_id: None, kind: "task", title, description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
                db::insert_group_task(&s.db(), new, "Shop").unwrap()
            };
            let mine = planner(&personal, "Mine");
            let theirs = planner(&work, "Theirs");
            grant(&s, &work, &["personal"]);
            grant(&s, &personal, &["lab"]);
            let err = call(&s, &ctx(&personal), "update_task", json!({"task_id": mine.id, "depends_on": ["work:G-1"]})).await.unwrap_err();
            assert!(err.contains("only tasks in a project"), "{err}");
            let err = api::update_task_inner(&s, &mine.id, json!({"depends_on": [theirs.id]}).as_object().unwrap()).await.unwrap_err();
            assert!(err.1.contains("only tasks in a project"), "{}", err.1);
            // Clearing them is fine.
            call(&s, &ctx(&personal), "update_task", json!({"task_id": mine.id, "depends_on": []})).await.unwrap();

            // A link made before this was checked shows to no one, and the migration drops it.
            db::update_task(&s.db(), &mine.id, &[("depends_on", json!([theirs.id])), ("waiting", json!(true))]).unwrap();
            let get = json!({"task_id": mine.id});
            assert!(call(&s, &ctx(&lab), "get_task", get.clone()).await.unwrap()["depends_on"].is_null());
            grant(&s, &work, &[]);
            assert!(call(&s, &ctx(&personal), "get_task", get.clone()).await.unwrap()["depends_on"].is_null());
            db::clear_projectless_dependencies(&s.db()).unwrap();
            let t = db::get_task(&s.db(), &mine.id).unwrap().unwrap();
            assert!(t.depends_on.is_empty() && !t.waiting);
        });
    }

    #[test]
    fn group_tasks_follow_their_group_when_its_renamed() {
        let c = db::open(std::path::Path::new(":memory:")).unwrap();
        let p = insert_profile(&c, "me", &[], None).unwrap();
        for id in ["a", "b"] {
            let np = NewProject { id, profile_id: &p.id, name: id, key: id, repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
            insert_project(&c, np).unwrap();
            db::update_project(&c, id, &[("group_name", json!("Old"))]).unwrap();
        }
        let new = db::NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "Plan", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let t = db::insert_group_task(&c, new, "Old").unwrap();
        db::update_project(&c, "a", &[("group_name", json!("New"))]).unwrap();
        // "b" is still in the old group.
        assert!(db::rename_group_tasks(&c, &p.id, "Old", Some("New")).unwrap().is_empty());
        db::update_project(&c, "b", &[("group_name", json!("New"))]).unwrap();
        assert_eq!(db::rename_group_tasks(&c, &p.id, "Old", Some("New")).unwrap(), [t.id.clone()]);
        assert_eq!(db::get_task(&c, &t.id).unwrap().unwrap().group_name.as_deref(), Some("New"));
        // Ungrouped, they keep the name.
        db::update_project(&c, "a", &[("group_name", Value::Null)]).unwrap();
        db::update_project(&c, "b", &[("group_name", Value::Null)]).unwrap();
        assert!(db::rename_group_tasks(&c, &p.id, "New", None).unwrap().is_empty());
        assert_eq!(db::list_group_tasks(&c, &p.id).unwrap()[0].group_name.as_deref(), Some("New"));
    }

    #[test]
    fn an_agent_waits_for_the_tasks_it_watches() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "kiwicd", "KIW");
            let (planner, worker) = (task(&s, "kiwicd", "Plan"), task(&s, "kiwicd", "Build"));
            let run = db::insert_run(&s.db(), &planner.id, "prompt").unwrap();
            let mcp = |call_id: &str, args: Value| McpCall { task_fields: true, run_id: run.id.clone(), call_id: call_id.into(), tool: "wait".into(), args };

            let err = handle_mcp(&s, mcp("c0", json!({"reason": "r", "tasks": ["KIW-9"]}))).await.unwrap_err();
            assert!(err.contains("KIW-9 not found on this host"), "{err}");

            let (s2, id) = (s.clone(), worker.id.clone());
            tokio::spawn(async move {
                while db::get_task(&s2.db(), &id).unwrap().unwrap().status == "todo"
                    && db::get_task(&s2.db(), &planner.id).unwrap().unwrap().agent_wait.is_none()
                {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
                s2.update_task(&id, &[("status", json!("in_review"))]).unwrap();
            });
            let v = handle_mcp(&s, mcp("c1", json!({"reason": "waiting on KIW-2", "tasks": ["KIW-2"], "seconds": 60}))).await.unwrap();
            assert_eq!(v["ended"], "tasks_changed");
            assert_eq!(v["note"], "KIW-2 changed status (see tasks).");
            assert_eq!((v["tasks"][0]["key"].as_str(), v["tasks"][0]["status"].as_str()), (Some("KIW-2"), Some("in_review")));
        });
    }

    #[test]
    fn another_call_from_the_run_ends_its_wait() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "kiwicd", "KIW");
            let planner = task(&s, "kiwicd", "Plan");
            let run = db::insert_run(&s.db(), &planner.id, "prompt").unwrap();
            let mcp = |call_id: &str, tool: &str, args: Value| McpCall { task_fields: true, run_id: run.id.clone(), call_id: call_id.into(), tool: tool.into(), args };
            let (s2, id, other) = (s.clone(), planner.id.clone(), mcp("c2", "get_task", json!({"task_id": "KIW-1"})));
            let busy = tokio::spawn(async move {
                while db::get_task(&s2.db(), &id).unwrap().unwrap().agent_wait.is_none() {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
                // The helper runs calls concurrently: the agent works on while the wait is pending.
                handle_mcp(&s2, other).await.unwrap();
            });
            // Without tasks or a command, a long wait is turned down.
            let err = handle_mcp(&s, mcp("c0", "wait", json!({"reason": "r", "seconds": 600}))).await.unwrap_err();
            assert!(err.contains("30 seconds at most"), "{err}");
            let v = handle_mcp(&s, mcp("c1", "wait", json!({"reason": "r", "seconds": 30}))).await.unwrap();
            busy.await.unwrap();
            assert_eq!(v["ended"], "resumed");
            assert_eq!(db::get_task(&s.db(), &planner.id).unwrap().unwrap().agent_wait, None);
        });
    }

    #[test]
    fn a_subagents_completion_wakes_its_agents_wait() {
        testing::run(async || {
            let codex = |method: &str, params: Value| json!({"method": method, "params": params});
            let mut endings = Vec::new();
            for status in ["completed", "failed", "interrupted"] {
                endings.push((true, codex("turn/completed", json!({"threadId": "child", "turn": {"status": status}}))));
            }
            for kind in ["completed", "interrupted"] {
                endings.push((true, codex("item/completed", json!({"threadId": "main", "item": {
                    "type": "subAgentActivity", "id": "activity", "kind": kind, "agentThreadId": "child"
                }}))));
            }
            endings.push((true, codex("item/completed", json!({"threadId": "main", "item": {
                "type": "collabAgentToolCall", "id": "native-wait", "tool": "wait", "status": "completed",
                "agentsStates": {"child": {"status": "completed", "message": "Child report"}}
            }}))));
            endings.push((false, json!({"type": "system", "subtype": "task_notification", "tool_use_id": "child",
                "task_id": "background", "status": "completed", "summary": "Child report"})));
            endings.push((false, json!({"type": "system", "subtype": "task_updated", "tool_use_id": "child", "patch": {"status": "failed"}})));

            for (n, (is_codex, ending)) in endings.into_iter().enumerate() {
                let s = state();
                let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
                project(&s, &p, "kiwicd", "KIW");
                let planner = task(&s, "kiwicd", "Plan");
                s.update_task(&planner.id, &[("session_id", json!("main"))]).unwrap();
                let run = db::insert_run(&s.db(), &planner.id, "prompt").unwrap();
                let start = if is_codex {
                    codex("thread/started", json!({"thread": {"id": "child", "parentThreadId": "main", "preview": "Inspect config"}}))
                } else {
                    json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "child", "name": "Agent",
                        "input": {"description": "Inspect config", "run_in_background": true}}]}})
                };
                runner::on_output(&s, &run.id, 0, &format!("{start}\n"));
                let (s2, task_id, run_id) = (s.clone(), planner.id.clone(), run.id.clone());
                let finish = tokio::spawn(async move {
                    while db::get_task(&s2.db(), &task_id).unwrap().unwrap().agent_wait.is_none() {
                        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                    }
                    if ending["params"]["item"]["type"] == "subAgentActivity" {
                        let mut started = ending.clone();
                        started["method"] = json!("item/started");
                        let offset = db::get_run(&s2.db(), &run_id).unwrap().unwrap().out_offset as u64;
                        runner::on_output(&s2, &run_id, offset, &format!("{started}\n"));
                        assert!(db::get_task(&s2.db(), &task_id).unwrap().unwrap().agent_wait.is_some());
                    }
                    let offset = db::get_run(&s2.db(), &run_id).unwrap().unwrap().out_offset as u64;
                    runner::on_output(&s2, &run_id, offset, &format!("{ending}\n"));
                });
                let call = McpCall { task_fields: true, run_id: run.id.clone(), call_id: "wait".into(), tool: "wait".into(), args: json!({"reason": "waiting for child", "seconds": 1}) };
                let result = handle_mcp(&s, call).await.unwrap();
                finish.await.unwrap();
                assert_eq!(result["ended"], "subagent_finished", "case {n}: {result}");
                assert_eq!(result["subagent"]["tool_use_id"], if is_codex { "codex-agent-child" } else { "child" });
                assert_eq!(db::get_task(&s.db(), &planner.id).unwrap().unwrap().agent_wait, None);
                assert!(!db::get_run(&s.db(), &run.id).unwrap().unwrap().saw_result, "the parent's turn must stay running");
            }
        });
    }

    #[test]
    fn a_waits_command_is_approved_like_a_bash_call() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "kiwicd", "KIW");
            let repo = crate::testing::temp_dir();
            db::update_project(&s.db(), "kiwicd", &[("repo_path", json!(repo))]).unwrap();
            let planner = task(&s, "kiwicd", "Plan");
            let run = started_run(&s, &planner.id);
            let mcp = |call_id: &str, args: Value| McpCall { task_fields: true, run_id: run.id.clone(), call_id: call_id.into(), tool: "wait".into(), args };
            // Answers the call's prompt once it's raised.
            let answer = |call_id: &'static str, allow: bool| {
                let s = s.clone();
                tokio::spawn(async move {
                    loop {
                        let r: Option<(String, String)> = s.db().query_row("SELECT id, input FROM permission_requests WHERE call_id=?1", [call_id], |r| Ok((r.get(0)?, r.get(1)?))).ok();
                        if let Some((id, input)) = r {
                            crate::permissions::decide(&s, &id, allow, false, None).unwrap();
                            break serde_json::from_str::<Value>(&input).unwrap();
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                    }
                })
            };

            let asked = answer("c1", true);
            let v = handle_mcp(&s, mcp("c1", json!({"reason": "waiting for the build", "command": "pwd; exit 1", "seconds": 60}))).await.unwrap();
            assert_eq!(asked.await.unwrap(), json!({"command": "pwd; exit 1", "cwd": repo, "description": "Run while waiting: waiting for the build"}));
            assert_eq!((v["ended"].as_str(), v["note"].as_str()), (Some("command_exited"), Some("Your command exited with code 1 (see command.output).")));
            assert_eq!(v["command"], json!({"exit_code": 1, "output": format!("{}\n", repo.display())}));

            let asked = answer("c2", false);
            let err = handle_mcp(&s, mcp("c2", json!({"reason": "r", "command": "true"}))).await.unwrap_err();
            asked.await.unwrap();
            assert!(err.starts_with("The command wasn't approved, so the wait didn't start"), "{err}");
            assert_eq!(db::get_task(&s.db(), &planner.id).unwrap().unwrap().agent_wait, None);
        });
    }

    #[test]
    fn a_waits_command_runs_unasked_when_the_agents_reviewer_approved_the_call() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "kiwicd", "KIW");
            let repo = crate::testing::temp_dir();
            db::update_project(&s.db(), "kiwicd", &[("repo_path", json!(repo))]).unwrap();
            let planner = task(&s, "kiwicd", "Plan");
            let launched = |mode: &str, allowed: &str| {
                let run = started_run(&s, &planner.id);
                let dir = crate::runs::run_dir(&s, &run.id);
                std::fs::create_dir_all(&dir).unwrap();
                let args = ["-p", "--permission-mode", mode, "--allowedTools", allowed, "mcp__gh__pr_view", "--add-dir", "/a"];
                std::fs::write(dir.join("spec.json"), json!({"cwd": repo, "args": args}).to_string()).unwrap();
                run
            };
            // A Codex run in auto mode, from this build (whose reviewer reviews waits) or an older one.
            let codex_launched = |review_waits: Option<bool>| {
                let run = started_run(&s, &planner.id);
                let dir = crate::runs::run_dir(&s, &run.id);
                std::fs::create_dir_all(&dir).unwrap();
                let spec_path = dir.join("codex.json");
                let mut spec = json!({"cwd": repo, "approval_policy": "on-request", "approvals_reviewer": "auto_review", "sandbox": "workspace-write"});
                if let Some(r) = review_waits {
                    spec["review_waits"] = json!(r);
                }
                std::fs::write(&spec_path, spec.to_string()).unwrap();
                std::fs::write(dir.join("spec.json"), json!({"cwd": repo, "args": ["codex-run", spec_path]}).to_string()).unwrap();
                run
            };
            let mcp = |run_id: &str, call_id: &str| McpCall {
                task_fields: true,
                run_id: run_id.into(),
                call_id: call_id.into(),
                tool: "wait".into(),
                args: json!({"reason": "waiting for CI", "command": "exit 3"}),
            };
            let request = |call_id: &str| s.db().query_row("SELECT id FROM permission_requests WHERE call_id=?1", [call_id], |r| r.get::<_, String>(0)).ok();

            // Claude's auto mode classifier approved the call before the agent made it.
            let run = launched("auto", "mcp__huntaway__get_task");
            let v = handle_mcp(&s, mcp(&run.id, "c1")).await.unwrap();
            assert_eq!((v["ended"].as_str(), &v["command"]["exit_code"]), (Some("command_exited"), &json!(3)));
            assert_eq!(request("c1"), None);
            // As did Codex's reviewer.
            let run = codex_launched(Some(true));
            let v = handle_mcp(&s, mcp(&run.id, "c2")).await.unwrap();
            assert_eq!((v["ended"].as_str(), &v["command"]["exit_code"]), (Some("command_exited"), &json!(3)));
            assert_eq!(request("c2"), None);

            // A run that pre-approves every board tool (one from an older build, before or after
            // the rename, Claude or Codex) is still asked, in auto mode as in Ask.
            let runs = [launched("auto", "mcp__huntaway"), launched("auto", "mcp__issue_agent"), launched("default", "mcp__issue_agent")];
            let runs = runs.into_iter().chain([codex_launched(None), codex_launched(Some(false))]);
            for (n, run) in runs.enumerate() {
                let call_id = format!("asked{n}");
                s.runs.lock().unwrap().insert(planner.id.clone(), crate::state::RunHandle { run_id: run.id.clone(), cancel: None });
                let call = tokio::spawn({
                    let (s, call) = (s.clone(), mcp(&run.id, &call_id));
                    async move { handle_mcp(&s, call).await }
                });
                let id = loop {
                    match request(&call_id) {
                        Some(id) => break id,
                        None => tokio::time::sleep(std::time::Duration::from_millis(10)).await,
                    }
                };
                crate::permissions::decide(&s, &id, false, false, None).unwrap();
                let err = call.await.unwrap().unwrap_err();
                assert!(err.starts_with("The command wasn't approved"), "{n}: {err}");
            }

            // And in Don't ask its command is refused without asking.
            db::update_task(&s.db(), &planner.id, &[("permission_mode", json!("dontAsk"))]).unwrap();
            let run = launched("dontAsk", "mcp__issue_agent");
            let err = handle_mcp(&s, mcp(&run.id, "c3")).await.unwrap_err();
            assert!(err.contains(crate::permissions::DONT_ASK_DENIAL), "{err}");
            assert_eq!(request("c3"), None);
        });
    }

    #[test]
    fn an_agent_waits_on_its_pull_request() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "kiwicd", "KIW");
            // The project's repository, on GitHub as o/r.
            let repo = crate::testing::temp_dir();
            for args in [&["init", "-q"][..], &["remote", "add", "origin", "git@github.com:o/r.git"]] {
                assert!(std::process::Command::new("git").args(args).current_dir(&repo).status().unwrap().success());
            }
            db::update_project(&s.db(), "kiwicd", &[("repo_path", json!(repo))]).unwrap();
            let t = task(&s, "kiwicd", "Build");
            let failed = crate::pr_watch::response("me", "a1", &[("Tests / server", "COMPLETED", "FAILURE", true)], &[]);
            crate::pr_watch::fake(move |_, target| {
                assert_eq!(target.label(), "o/r#7");
                Ok(failed.clone())
            });
            // A Claude run and a Codex run (in auto mode, whose reviewer reviews waits) call it alike.
            let claude = db::insert_run(&s.db(), &t.id, "prompt").unwrap();
            let codex = db::insert_run(&s.db(), &t.id, "prompt").unwrap();
            let dir = crate::runs::run_dir(&s, &codex.id);
            std::fs::create_dir_all(&dir).unwrap();
            let spec = json!({"cwd": repo, "approval_policy": "on-request", "approvals_reviewer": "auto_review", "sandbox": "workspace-write", "review_waits": true});
            std::fs::write(dir.join("codex.json"), spec.to_string()).unwrap();
            std::fs::write(dir.join("spec.json"), json!({"cwd": repo, "args": ["codex-run", dir.join("codex.json")]}).to_string()).unwrap();
            let mcp = |run: &db::Run, call_id: &str, args: Value| McpCall { task_fields: true, run_id: run.id.clone(), call_id: call_id.into(), tool: "wait".into(), args };

            let v = handle_mcp(&s, mcp(&claude, "c1", json!({"reason": "waiting for CI", "pull_request": "7"}))).await.unwrap();
            assert_eq!(v["ended"], "pull_request");
            assert_eq!(v["note"], "Pull request #7: checks failed (Tests / server) (see pull_request).");
            assert_eq!(v["pull_request"]["checks"]["failed"][0]["name"], "Tests / server");
            assert_eq!(v["pull_request"]["events"], json!(["checks_failed"]));
            // Told, a later wait (by URL) times out, saying how it was when last read.
            let v = handle_mcp(&s, mcp(&codex, "c2", json!({"reason": "waiting for review", "pull_request": "https://github.com/o/r/pull/7", "seconds": 1}))).await.unwrap();
            assert_eq!(v["ended"], "timeout");
            assert_eq!((v["pull_request"]["checks"]["outcome"].as_str(), v["pull_request"]["number"].as_u64()), (Some("failed"), Some(7)));
            assert!(v["pull_request"]["read_at"].is_string(), "{v}");
            assert_eq!(s.db().query_row("SELECT COUNT(*) FROM permission_requests", [], |r| r.get::<_, i64>(0)).unwrap(), 0);

            let err = handle_mcp(&s, mcp(&claude, "c3", json!({"reason": "r", "pull_request": 7, "pull_request_events": ["reviews"]}))).await.unwrap_err();
            assert!(err.starts_with("pull_request_events takes checks_failed, checks_passed, comments, conflicts"), "{err}");
            let err = handle_mcp(&s, mcp(&claude, "c4", json!({"reason": "r", "pull_request": "the PR"}))).await.unwrap_err();
            assert!(err.contains("the PR isn't a pull request"), "{err}");
            // A whole number sent as a float (or written as one) is a number.
            for (call, pr) in [("c5", json!(7.0)), ("c5b", json!("7.0"))] {
                let v = handle_mcp(&s, mcp(&claude, call, json!({"reason": "r", "pull_request": pr, "seconds": 1}))).await.unwrap();
                assert_eq!((v["ended"].as_str(), v["pull_request"]["number"].as_u64()), (Some("timeout"), Some(7)), "{pr}");
            }
            let err = handle_mcp(&s, mcp(&claude, "c6", json!({"reason": "r", "pull_request": 7.5}))).await.unwrap_err();
            assert!(err.contains("7.5 isn't a pull request"), "{err}");
            // A remote's host that isn't its account's (an SSH alias ssh doesn't know) asks for the URL.
            assert!(std::process::Command::new("git").args(["remote", "set-url", "origin", "git@github-work:o/r.git"]).current_dir(&repo).status().unwrap().success());
            db::update_profile(&s.db(), &p.id, &[("github_account", json!("me"))]).unwrap();
            let err = handle_mcp(&s, mcp(&claude, "c7", json!({"reason": "r", "pull_request": 7}))).await.unwrap_err();
            assert!(err.contains("this task's repository is pushed to github-work, but its GitHub account me is on github.com: give the pull request's URL"), "{err}");
            // The pull request's state is kept with the task, and goes with it.
            assert_eq!(s.db().query_row("SELECT COUNT(*) FROM pr_watches WHERE task_id=?1", [&t.id], |r| r.get::<_, i64>(0)).unwrap(), 1);
            s.db().execute("DELETE FROM tasks WHERE id=?1", [&t.id]).unwrap();
            assert_eq!(s.db().query_row("SELECT COUNT(*) FROM pr_watches", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
            std::fs::remove_dir_all(&repo).unwrap();
        });
    }

    #[test]
    fn a_retried_wait_wakes_for_a_watched_task_deleted_meanwhile() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "kiwicd", "KIW");
            let (planner, worker) = (task(&s, "kiwicd", "Plan"), task(&s, "kiwicd", "Build"));
            let run = db::insert_run(&s.db(), &planner.id, "prompt").unwrap();
            // The call was waiting on KIW-2 when the server went down, and KIW-2 was deleted since.
            let w = db::AgentWait {
                reason: Some("waiting on KIW-2".into()),
                since: crate::util::now(),
                until: (chrono::Utc::now() + chrono::Duration::seconds(60)).to_rfc3339(),
                tasks: vec![db::WaitTask { id: worker.id.clone(), key: "KIW-2".into(), status: worker.status.clone() }],
                command: None,
                call_id: "c1".into(),
                run_id: run.id.clone(),
                moved_to: None,
                subagent_finished: None,
                pull_request: None,
            };
            s.update_task(&planner.id, &[("agent_wait", json!(w))]).unwrap();
            s.db().execute("DELETE FROM tasks WHERE id=?1", [&worker.id]).unwrap();
            let retry = McpCall { task_fields: true, run_id: run.id.clone(), call_id: "c1".into(), tool: "wait".into(), args: json!({"reason": "waiting on KIW-2", "tasks": ["KIW-2"], "seconds": 60}) };
            let v = handle_mcp(&s, retry).await.unwrap();
            assert_eq!(v["ended"], "tasks_changed");
            assert_eq!(v["tasks"], json!([{"id": worker.id, "key": "KIW-2", "deleted": true}]));
            assert_eq!(db::get_task(&s.db(), &planner.id).unwrap().unwrap().agent_wait, None);
        });
    }

    #[test]
    fn a_subagents_permission_prompt_doesnt_end_its_agents_wait() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "kiwicd", "KIW");
            let planner = task(&s, "kiwicd", "Plan");
            db::update_task(&s.db(), &planner.id, &[("auto_allow", json!(r#"["Bash"]"#))]).unwrap();
            let run = db::insert_run(&s.db(), &planner.id, "prompt").unwrap();
            let mcp = |call_id: &str, tool: &str, args: Value| McpCall { task_fields: true, run_id: run.id.clone(), call_id: call_id.into(), tool: tool.into(), args };
            let prompt = mcp("c2", "permission_prompt", json!({"tool_name": "Bash", "input": {"command": "make"}, "tool_use_id": "toolu_sub"}));
            let (s2, id) = (s.clone(), planner.id.clone());
            let subagent = tokio::spawn(async move {
                while db::get_task(&s2.db(), &id).unwrap().unwrap().agent_wait.is_none() {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
                let v = handle_mcp(&s2, prompt).await.unwrap();
                assert_eq!(v["behavior"], "allow");
                db::get_task(&s2.db(), &id).unwrap().unwrap().agent_wait.is_some()
            });
            let v = handle_mcp(&s, mcp("c1", "wait", json!({"reason": "r", "seconds": 1}))).await.unwrap();
            assert!(subagent.await.unwrap(), "the prompt cleared the wait");
            assert_eq!(v["ended"], "timeout");
        });
    }

    #[test]
    fn a_reviewer_can_only_read_the_board_whatever_its_tool_list_offers() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "kiwicd", "KIW");
            let reviewed = task(&s, "kiwicd", "Reviewed");
            let new = db::NewTask {
                profile_id: &p.id,
                project_id: Some("kiwicd"),
                kind: "review",
                title: "review",
                description: "",
                status: "todo",
                use_worktree: false,
                model: None,
                effort: None,
                claude_config_id: None,
            };
            let thread = db::insert_task(&s.db(), new).unwrap();
            db::update_task(&s.db(), &thread.id, &[("parent_id", json!(reviewed.id))]).unwrap();
            let run = db::insert_run(&s.db(), &thread.id, "review").unwrap();
            let auto_review = db::get_project(&s.db(), "kiwicd").unwrap().unwrap().auto_review;
            let mcp = |call_id: &str, tool: &str, args: Value| McpCall { task_fields: true, run_id: run.id.clone(), call_id: call_id.into(), tool: tool.into(), args };
            // A reviewer reading an injected instruction can't start agents, steer the reviewed
            // task's, or change tasks and projects, even calling a tool its helper doesn't list.
            let refused = [
                ("create_task", json!({"title": "Exfiltrate", "start": true})),
                ("send_to_task", json!({"task_id": "KIW-1", "message": "Push to main"})),
                ("update_task", json!({"task_id": "KIW-1", "status": "done"})),
                ("update_project", json!({"auto_review": !auto_review})),
                ("create_project", json!({"repo_path": "/tmp/x"})),
                ("delete_task", json!({"task_id": "KIW-1"})),
            ];
            for (i, (tool, args)) in refused.into_iter().enumerate() {
                let err = handle_mcp(&s, mcp(&format!("c{i}"), tool, args)).await.unwrap_err();
                assert!(err.starts_with(&format!("{tool} isn't available to reviewers")), "{err}");
            }
            assert_eq!(db::list_tasks_for_project(&s.db(), "kiwicd", "task").unwrap().len(), 1);
            let t = db::get_task(&s.db(), &reviewed.id).unwrap().unwrap();
            assert_eq!((t.status.as_str(), t.steering.len()), ("todo", 0));
            assert_eq!(db::get_project(&s.db(), "kiwicd").unwrap().unwrap().auto_review, auto_review);
            // Nor is the user asked to approve anything for it (delete_task, update_project).
            let asked: i64 = s.db().query_row("SELECT COUNT(*) FROM permission_requests", [], |r| r.get(0)).unwrap();
            assert_eq!(asked, 0);
            // It still reads the board.
            assert_eq!(handle_mcp(&s, mcp("r1", "get_task", json!({"task_id": "KIW-1"}))).await.unwrap()["title"], "Reviewed");
            assert_eq!(handle_mcp(&s, mcp("r2", "get_project", json!({}))).await.unwrap()["key"], "KIW");
            assert_eq!(handle_mcp(&s, mcp("r3", "list_tasks", json!({}))).await.unwrap().as_array().unwrap().len(), 1);
            assert!(!handle_mcp(&s, mcp("r4", "list_projects", json!({}))).await.unwrap().as_array().unwrap().is_empty());
            assert_eq!(handle_mcp(&s, mcp("r5", "get_task_field", json!({"task_id": "KIW-1", "field": "title"}))).await.unwrap()["content"], "Reviewed");
            // A task's own agent keeps them all.
            let own = db::insert_run(&s.db(), &reviewed.id, "prompt").unwrap();
            let call = McpCall { task_fields: true, run_id: own.id, call_id: "t1".into(), tool: "create_task".into(), args: json!({"title": "Follow-up"}) };
            handle_mcp(&s, call).await.unwrap();
            assert_eq!(db::list_tasks_for_project(&s.db(), "kiwicd", "task").unwrap().len(), 2);
        });
    }

    #[test]
    fn a_run_the_board_has_ended_gets_nothing_done() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "kiwicd", "KIW");
            let t = task(&s, "kiwicd", "Work");
            // Its supervisor vanished and the board ended it, but its agent's helper still calls.
            let run = db::insert_run(&s.db(), &t.id, "prompt").unwrap();
            s.db().execute("UPDATE runs SET status='exited' WHERE id=?1", [&run.id]).unwrap();
            s.update_task(&t.id, &[("status", json!("in_review"))]).unwrap();
            let mcp = |call_id: &str, tool: &str, args: Value| McpCall { task_fields: true, run_id: run.id.clone(), call_id: call_id.into(), tool: tool.into(), args };
            let calls = [
                ("create_task", json!({"title": "Follow-up", "start": true})),
                ("update_task", json!({"task_id": "KIW-1", "status": "done"})),
                ("send_to_task", json!({"task_id": "KIW-1", "message": "Carry on"})),
                ("permission_prompt", json!({"tool_name": "Bash", "input": {"command": "make"}})),
                ("get_task", json!({"task_id": "KIW-1"})),
            ];
            for (i, (tool, args)) in calls.into_iter().enumerate() {
                let err = handle_mcp(&s, mcp(&format!("c{i}"), tool, args)).await.unwrap_err();
                assert!(err.starts_with("This run has ended on the board"), "{tool}: {err}");
            }
            let t = db::get_task(&s.db(), &t.id).unwrap().unwrap();
            assert_eq!((t.status.as_str(), t.steering.len(), t.queued_message), ("in_review", 0, None));
            assert_eq!(db::list_tasks_for_project(&s.db(), "kiwicd", "task").unwrap().len(), 1);
            let asked: i64 = s.db().query_row("SELECT COUNT(*) FROM permission_requests", [], |r| r.get(0)).unwrap();
            assert_eq!(asked, 0);
        });
    }

    #[test]
    fn a_prompt_from_a_run_that_has_let_go_of_its_thread_isnt_raised() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "kiwicd", "KIW");
            let t = task(&s, "kiwicd", "Work");
            let run = db::insert_run(&s.db(), &t.id, "prompt").unwrap();
            s.db().execute("UPDATE runs SET status='running' WHERE id=?1", [&run.id]).unwrap();
            s.update_task(&t.id, &[("status", json!("in_review"))]).unwrap();
            // The run is ending (runner::finish has let go of the thread and expired its prompts,
            // but not yet marked it exited) as its prompt comes in.
            let prompt = McpCall {
                task_fields: true, run_id: run.id.clone(), call_id: "p1".into(), tool: "permission_prompt".into(),
                args: json!({"tool_name": "Bash", "input": {"command": "make"}}),
            };
            let err = handle_mcp(&s, prompt).await.unwrap_err();
            assert!(err.contains("run has ended"), "{err}");
            assert_eq!(db::get_task(&s.db(), &t.id).unwrap().unwrap().status, "in_review");
            let asked: i64 = s.db().query_row("SELECT COUNT(*) FROM permission_requests", [], |r| r.get(0)).unwrap();
            assert_eq!(asked, 0);
            // While it holds the thread, it's asked.
            s.runs.lock().unwrap().insert(t.id.clone(), crate::state::RunHandle { run_id: run.id.clone(), cancel: None });
            let prompt = McpCall {
                task_fields: true, run_id: run.id.clone(), call_id: "p2".into(), tool: "permission_prompt".into(),
                args: json!({"tool_name": "Bash", "input": {"command": "make"}}),
            };
            let asking = tokio::spawn({
                let s = s.clone();
                async move { handle_mcp(&s, prompt).await }
            });
            while db::get_task(&s.db(), &t.id).unwrap().unwrap().status != "needs_attention" {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            permissions::expire_for_task(&s, &t.id);
            assert_eq!(asking.await.unwrap().unwrap()["behavior"], "deny");
        });
    }

    #[test]
    fn a_thread_in_plan_mode_only_reads_the_board() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "kiwicd", "KIW");
            let planner = task(&s, "kiwicd", "Plan");
            s.update_task(&planner.id, &[("permission_mode", json!("plan"))]).unwrap();
            let run = db::insert_run(&s.db(), &planner.id, "prompt").unwrap();
            let mcp = |call_id: &str, tool: &str, args: Value| McpCall { task_fields: true, run_id: run.id.clone(), call_id: call_id.into(), tool: tool.into(), args };
            let refused = [
                ("create_task", json!({"title": "Do it now", "start": true})),
                ("send_to_task", json!({"task_id": "KIW-1", "message": "Go"})),
                ("update_task", json!({"task_id": "KIW-1", "status": "done"})),
                ("run_automation", json!({"automation_id": "nightly"})),
            ];
            for (i, (tool, args)) in refused.into_iter().enumerate() {
                let err = handle_mcp(&s, mcp(&format!("c{i}"), tool, args)).await.unwrap_err();
                assert!(err.starts_with(&format!("{tool} isn't available in plan mode")), "{err}");
            }
            assert_eq!(db::list_tasks_for_project(&s.db(), "kiwicd", "task").unwrap().len(), 1);
            assert_eq!(db::get_task(&s.db(), &planner.id).unwrap().unwrap().status, "todo");
            assert_eq!(handle_mcp(&s, mcp("r1", "get_task", json!({"task_id": "KIW-1"}))).await.unwrap()["title"], "Plan");
            // Its plan approved, it carries on in another mode with them all.
            s.update_task(&planner.id, &[("permission_mode", Value::Null)]).unwrap();
            handle_mcp(&s, mcp("t1", "create_task", json!({"title": "Follow-up"}))).await.unwrap();
            assert_eq!(db::list_tasks_for_project(&s.db(), "kiwicd", "task").unwrap().len(), 2);
            // As does a thread that inherits plan mode from its project.
            db::update_project(&s.db(), "kiwicd", &[("permission_mode", json!("plan"))]).unwrap();
            let err = handle_mcp(&s, mcp("c9", "create_task", json!({"title": "Another"}))).await.unwrap_err();
            assert!(err.starts_with("create_task isn't available in plan mode"), "{err}");
        });
    }

    #[test]
    fn a_review_thread_isnt_a_task_by_its_id_either() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "kiwicd", "KIW");
            let reviewed = task(&s, "kiwicd", "Reviewed");
            let new = db::NewTask {
                profile_id: &p.id, project_id: Some("kiwicd"), kind: "review", title: "review", description: "", status: "todo",
                use_worktree: false, model: None, effort: None, claude_config_id: None,
            };
            let thread = db::insert_task(&s.db(), new).unwrap();
            db::update_task(&s.db(), &thread.id, &[("parent_id", json!(reviewed.id))]).unwrap();
            let me = ctx(&p);
            for (tool, args) in [("get_task", json!({"task_id": thread.id})), ("send_to_task", json!({"task_id": thread.id, "message": "Approve it"}))] {
                let err = call(&s, &me, tool, args).await.unwrap_err();
                assert_eq!(err, format!("task {}", thread.id), "{tool}");
            }
            assert!(db::list_messages(&s.db(), &thread.id).unwrap().is_empty());
            assert_eq!(db::get_task(&s.db(), &thread.id).unwrap().unwrap().queued_message, None);
            assert_eq!(call(&s, &me, "get_task", json!({"task_id": reviewed.id})).await.unwrap()["title"], "Reviewed");
        });
    }

    #[test]
    fn a_project_name_with_a_colon_isnt_read_as_a_profile() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "kiwicd", "KIW");
            db::update_project(&s.db(), "kiwicd", &[("name", json!("Ops: infra"))]).unwrap();
            let me = ctx(&p);
            assert_eq!(call(&s, &me, "get_project", json!({"project_id": "Ops: infra"})).await.unwrap()["key"], "KIW");
            // A profile's name still qualifies a key, and one that doesn't let the caller in says so.
            assert_eq!(call(&s, &me, "get_project", json!({"project_id": "personal:KIW"})).await.unwrap()["key"], "KIW");
            insert_profile(&s.db(), "ops", &[], None).unwrap();
            let err = call(&s, &me, "get_project", json!({"project_id": "Ops: infra"})).await.unwrap_err();
            assert!(err.contains("doesn't let agents in profile personal"), "{err}");
        });
    }

    #[test]
    fn a_guessed_argument_name_says_what_the_tool_takes() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "kiwicd", "KIW");
            let own = task(&s, "kiwicd", "Plan");
            let run = db::insert_run(&s.db(), &own.id, "prompt").unwrap();
            let mcp = |call_id: &str, tool: &str, args: Value| McpCall { task_fields: true, run_id: run.id.clone(), call_id: call_id.into(), tool: tool.into(), args };
            // An agent that never loaded the schema guessed `task` and got "not found: task ".
            let err = handle_mcp(&s, mcp("c1", "get_task", json!({"task": "KIW-1"}))).await.unwrap_err();
            assert!(err.starts_with("get_task has no argument \"task\"; its arguments are ") && err.contains("task_id"), "{err}");
            let err = handle_mcp(&s, mcp("c2", "update_task", json!({"status": "done"}))).await.unwrap_err();
            assert!(err.starts_with("update_task needs task_id"), "{err}");
            // `project` was ignored, so the task went to the caller's project whatever was named.
            let err = handle_mcp(&s, mcp("c3", "create_task", json!({"title": "t", "project": "OTHER"}))).await.unwrap_err();
            assert!(err.contains("no argument \"project\""), "{err}");
            assert_eq!(handle_mcp(&s, mcp("c4", "get_task", json!({"task_id": "KIW-1"}))).await.unwrap()["title"], "Plan");
            assert_eq!(db::list_tasks_for_project(&s.db(), "kiwicd", "task").unwrap().len(), 1);
        });
    }

    #[test]
    fn a_call_cut_short_by_a_restart_doesnt_run_again() {
        testing::run(async || {
            use futures::FutureExt;
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "kiwicd", "KIW");
            let planner = task(&s, "kiwicd", "Plan");
            let run = db::insert_run(&s.db(), &planner.id, "prompt").unwrap();
            let call = |id: &str| McpCall { task_fields: true, run_id: run.id.clone(), call_id: id.into(), tool: "create_task".into(), args: json!({"title": "Child"}) };
            let children = || s.db().query_row("SELECT COUNT(*) FROM tasks WHERE title='Child'", [], |r| r.get::<_, i64>(0)).unwrap();
            // The server goes down after creating the task, before recording that it did.
            testing::when("mcp:executed", || panic!("the server stopped"));
            let crashed = std::panic::AssertUnwindSafe(handle_mcp(&s, call("c1"))).catch_unwind().await;
            assert!(crashed.is_err());
            assert_eq!(children(), 1);
            // The helper retries the call with its id once the server is back.
            let err = handle_mcp(&s, call("c1")).await.unwrap_err();
            assert!(err.contains("interrupted"), "{err}");
            assert_eq!(children(), 1);
            // A call that can safely run again does.
            let get = McpCall { task_fields: true, run_id: run.id.clone(), call_id: "c2".into(), tool: "get_task".into(), args: json!({"task_id": "KIW-1"}) };
            testing::when("mcp:executed", || panic!("the server stopped"));
            assert!(std::panic::AssertUnwindSafe(handle_mcp(&s, get)).catch_unwind().await.is_err());
            let get = McpCall { task_fields: true, run_id: run.id.clone(), call_id: "c2".into(), tool: "get_task".into(), args: json!({"task_id": "KIW-1"}) };
            assert_eq!(handle_mcp(&s, get).await.unwrap()["title"], "Plan");
        });
    }

    #[test]
    fn a_call_the_board_cant_record_isnt_run() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "kiwicd", "KIW");
            let planner = task(&s, "kiwicd", "Plan");
            let run = db::insert_run(&s.db(), &planner.id, "prompt").unwrap();
            let call = || McpCall { task_fields: true, run_id: run.id.clone(), call_id: "c1".into(), tool: "create_task".into(), args: json!({"title": "Child"}) };
            let children = || s.db().query_row("SELECT COUNT(*) FROM tasks WHERE title='Child'", [], |r| r.get::<_, i64>(0)).unwrap();
            // Recording it fails (a full disk, say), twice.
            s.db().execute_batch("CREATE TRIGGER no_calls BEFORE INSERT ON mcp_calls BEGIN SELECT RAISE(ABORT, 'disk full'); END").unwrap();
            for _ in 0..2 {
                let err = handle_mcp(&s, call()).await.unwrap_err();
                assert!(err.contains("couldn't record") && err.contains("disk full"), "{err}");
            }
            assert_eq!(children(), 0);
            // So does finding out whether it ran.
            s.db().execute_batch("DROP TRIGGER no_calls; ALTER TABLE mcp_calls RENAME TO calls").unwrap();
            assert!(handle_mcp(&s, call()).await.unwrap_err().contains("couldn't record"));
            assert_eq!(children(), 0);
            s.db().execute_batch("ALTER TABLE calls RENAME TO mcp_calls").unwrap();
            handle_mcp(&s, call()).await.unwrap();
            assert_eq!(children(), 1);
        });
    }

    #[test]
    fn an_approval_cut_short_by_a_restart_is_still_waited_for() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "kiwicd", "KIW");
            let caller = task(&s, "kiwicd", "Caller");
            let run = started_run(&s, &caller.id);
            let call = |id: &str, script: &str| McpCall { task_fields: true, run_id: run.id.clone(), call_id: id.into(), tool: "update_project".into(), args: json!({"setup_script": script}) };
            let script = || db::get_project(&s.db(), "kiwicd").unwrap().unwrap().setup_script;
            let cut_short = async |c: McpCall| assert!(tokio::time::timeout(std::time::Duration::from_millis(100), handle_mcp(&s, c)).await.is_err());
            // The server restarts while the user is asked; retried, the call waits for their answer and makes the change once.
            cut_short(call("c1", "npm ci")).await;
            let (res, _) = tokio::join!(handle_mcp(&s, call("c1", "npm ci")), answer_approval(&s, true));
            res.unwrap();
            assert_eq!(script(), "npm ci");
            assert_eq!(handle_mcp(&s, call("c1", "npm ci")).await.unwrap()["setup_script"], json!("npm ci"));
            // Denied before the retry: still nothing changed.
            cut_short(call("c2", "make")).await;
            answer_approval(&s, false).await;
            assert!(handle_mcp(&s, call("c2", "make")).await.unwrap_err().contains("didn't approve"));
            assert_eq!(script(), "npm ci");
            // Approved before the retry: the change may have been made as the server stopped, so it isn't made again.
            cut_short(call("c3", "make")).await;
            answer_approval(&s, true).await;
            assert!(handle_mcp(&s, call("c3", "make")).await.unwrap_err().contains("interrupted"));
            // So does a deletion's.
            let (doomed, kept) = (task(&s, "kiwicd", "Doomed"), task(&s, "kiwicd", "Kept"));
            let delete = |id: &str, key: &str| McpCall { task_fields: true, run_id: run.id.clone(), call_id: id.into(), tool: "delete_task".into(), args: json!({"task_id": key}) };
            let exists = |t: &Task| db::get_task(&s.db(), &t.id).unwrap().is_some();
            cut_short(delete("c4", "KIW-2")).await;
            let (res, _) = tokio::join!(handle_mcp(&s, delete("c4", "KIW-2")), answer_approval(&s, true));
            assert_eq!(res.unwrap()["deleted"], json!(true));
            assert!(!exists(&doomed));
            cut_short(delete("c5", "KIW-3")).await;
            answer_approval(&s, true).await;
            assert!(handle_mcp(&s, delete("c5", "KIW-3")).await.unwrap_err().contains("interrupted"));
            assert!(exists(&kept));
        });
    }
    fn automations(s: &Shared, project: &str) -> Vec<crate::automations::Automation> {
        crate::automations::list(&s.db(), project).unwrap()
    }

    fn webhook_args(name: &str) -> Value {
        json!({
            "name": name,
            "trigger": {"kind": "webhook", "filters": [{"path": "event", "op": "equals", "value": "issues"}]},
            "action": {"kind": "create_task", "title": "Triage: {{body.issue.title}}", "description": "Look at {{body.issue.html_url}}", "start": true},
            "generate_secret": true,
            "reason": "Triage new issues",
        })
    }

    #[test]
    fn agents_create_automations_only_once_the_user_approves() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "kiwicd", "KIW");
            project(&s, &p, "other", "OTH");
            // Even a thread that may do anything without asking asks first.
            let caller = task(&s, "kiwicd", "Caller");
            s.update_task(&caller.id, &[("permission_mode", json!("bypassPermissions"))]).unwrap();
            let caller = db::get_task(&s.db(), &caller.id).unwrap().unwrap();
            let me = |call_id: &str| Ctx { task: Some(caller.clone()), call_id: Some(call_id.into()), ..ctx(&p) };
            let elsewhere = task(&s, "other", "Elsewhere");

            // Denied: nothing is made.
            let (c1, c2) = (me("c1"), me("c2"));
            let (res, asked) = tokio::join!(call(&s, &c1, "create_automation", webhook_args("Triage")), answer_approval(&s, false));
            let err = res.unwrap_err();
            assert!(err.contains("didn't approve creating the automation \"Triage\", so nothing was created"), "{err}");
            assert!(automations(&s, "kiwicd").is_empty());
            // The approval shows what would run, and who asked.
            assert_eq!((&asked["kind"], &asked["tool_name"]), (&json!("automation"), &json!("create_automation")));
            let input = &asked["input"];
            assert_eq!((&input["op"], &input["project"]["key"], &input["task"]["key"]), (&json!("create"), &json!("KIW"), &json!("KIW-1")));
            assert_eq!(input["reason"], "Triage new issues");
            let a = &input["automation"];
            assert_eq!((&a["name"], &a["enabled"], &a["signed"]), (&json!("Triage"), &json!(true), &json!(true)));
            assert_eq!((&a["trigger"]["kind"], &a["trigger"]["filters"][0]["value"]), (&json!("webhook"), &json!("issues")));
            assert_eq!((&a["action"]["title"], &a["action"]["start"], &a["action"]["status"]), (&json!("Triage: {{body.issue.title}}"), &json!(true), &json!("todo")));
            assert_eq!(db::get_task(&s.db(), &caller.id).unwrap().unwrap().attention_reason.as_deref(), Some("Approve an automation?"));
            // Only UIs that know automations are shown it.
            let shown = async {
                let a = approval_asked(&s).await;
                assert!(permissions::pending_approvals(&s, true, false).unwrap().is_empty());
                answer_approval(&s, true).await;
                a
            };
            // Approved: it's made as it was shown, with a new secret that's returned once.
            let (res, _) = tokio::join!(call(&s, &c2, "create_automation", webhook_args("Triage")), shown);
            let res = res.unwrap();
            let made = automations(&s, "kiwicd");
            assert_eq!(made.len(), 1);
            assert_eq!((made[0].name.as_str(), made[0].enabled), ("Triage", true));
            assert_eq!(made[0].secret.as_deref(), res["secret"].as_str());
            assert!(res["secret"].as_str().is_some_and(|s| s.len() > 20));
            assert_eq!(res["hook_path"], json!(made[0].hook_path()));
            assert!(res["webhook_note"].is_string());
            // With the host's public address, the full URL.
            db::set_setting(&s.db(), "public_url", Some("https://board.example.com")).unwrap();
            let list = call(&s, &me("c3"), "list_automations", json!({})).await.unwrap();
            assert_eq!(list["automations"][0]["webhook_url"], json!(format!("https://board.example.com{}", made[0].hook_path())));
            assert!(list["automations"][0].get("secret").is_none());

            // A message goes to a task named by key, and only one of the project's own.
            let message = |task: &str| json!({
                "name": "Nudge", "trigger": {"kind": "daily", "time": "9:00", "weekdays": ["fri", "mon"]},
                "action": {"kind": "send_to_task", "task_id": task, "message": "Anything new?"},
            });
            let err = call(&s, &me("c4"), "create_automation", message(&format!("OTH-{}", elsewhere.number))).await.unwrap_err();
            assert!(err.contains("only send messages to tasks in its own project"), "{err}");
            let err = call(&s, &me("c5"), "create_automation", message("KIW-99")).await.unwrap_err();
            assert!(err.contains("not found"), "{err}");
            // Bad settings are refused before the user is asked.
            let mut fast = message("KIW-1");
            fast["trigger"] = json!({"kind": "interval", "every_minutes": 1});
            assert!(call(&s, &me("c6"), "create_automation", fast).await.unwrap_err().contains("every_minutes"));
            let mut signed = message("KIW-1");
            signed["generate_secret"] = json!(true);
            assert!(call(&s, &me("c7"), "create_automation", signed).await.unwrap_err().contains("only a webhook"));
            assert!(permissions::pending_approvals(&s, true, true).unwrap().is_empty());
            let c8 = me("c8");
            let (res, asked) = tokio::join!(call(&s, &c8, "create_automation", message("KIW-1")), answer_approval(&s, true));
            res.unwrap();
            let view = &asked["input"]["automation"];
            assert_eq!((&view["target"]["key"], &view["target"]["title"]), (&json!("KIW-1"), &json!("Caller")));
            assert_eq!(view["trigger"], json!({"kind": "daily", "time": "09:00", "weekdays": ["mon", "fri"]}));
            assert_eq!(view["action"]["task_id"], json!(caller.id));
            assert_eq!(automations(&s, "kiwicd").len(), 2);

            // An agent on another host has no thread here to ask in.
            let mut remote = webhook_args("Remote");
            remote["project_id"] = json!("KIW");
            let err = call(&s, &ctx(&p), "create_automation", remote).await.unwrap_err();
            assert!(err.contains("creating the automation \"Remote\" needs the user's approval"), "{err}");
            assert_eq!(automations(&s, "kiwicd").len(), 2);
        });
    }

    #[test]
    fn agents_change_run_and_delete_automations() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "kiwicd", "KIW");
            let caller = task(&s, "kiwicd", "Caller");
            let me = |call_id: &str| Ctx { task: Some(caller.clone()), call_id: Some(call_id.into()), ..ctx(&p) };
            let body = json!({"name": "Weekly", "trigger": {"kind": "interval", "every_minutes": 60}, "action": {"kind": "create_task", "title": "Update deps {{date}}"}});
            let a = crate::automations::create(&s, "kiwicd", body.as_object().unwrap()).unwrap();
            let get = || crate::automations::get(&s.db(), &a.id).unwrap().unwrap();

            // Turning it off or renaming it isn't asked about.
            let res = call(&s, &me("c1"), "update_automation", json!({"automation_id": "weekly", "enabled": false, "name": "Weekly deps"})).await.unwrap();
            assert_eq!((&res["enabled"], &res["name"]), (&json!(false), &json!("Weekly deps")));
            assert!(permissions::pending_approvals(&s, true, true).unwrap().is_empty());
            assert!(call(&s, &me("c2"), "update_automation", json!({"automation_id": a.id, "enabled": false})).await.unwrap_err().contains("nothing to change"));
            // Turning it on is.
            let c3 = me("c3");
            let (res, asked) = tokio::join!(call(&s, &c3, "update_automation", json!({"automation_id": a.id, "enabled": true})), answer_approval(&s, false));
            assert!(res.unwrap_err().contains("didn't approve changing the automation \"Weekly deps\""));
            assert!(!get().enabled);
            assert_eq!(asked["input"]["changes"], json!(["enabled"]));
            // So is a new action; only what it changes is changed, though the user renames it meanwhile.
            let c4 = me("c4");
            let change = json!({"automation_id": a.id, "name": "Weekly deps", "action": {"kind": "create_task", "title": "Bump deps", "status": "backlog"}});
            let approve = async {
                let asked = approval_asked(&s).await;
                crate::automations::update(&s, &a.id, json!({"name": "Deps"}).as_object().unwrap()).unwrap();
                answer_approval(&s, true).await;
                asked
            };
            let (res, asked) = tokio::join!(call(&s, &c4, "update_automation", change), approve);
            res.unwrap();
            let input = &asked["input"];
            assert_eq!((&input["op"], &input["changes"]), (&json!("update"), &json!(["action"])));
            assert_eq!((&input["before"]["action"]["title"], &input["automation"]["action"]["title"]), (&json!("Update deps {{date}}"), &json!("Bump deps")));
            assert_eq!(input["automation"]["action"]["status"], json!("backlog"));
            let now = get();
            assert_eq!(now.name, "Deps");
            assert!(matches!(&now.action, crate::automations::Action::CreateTask { title, status, .. } if title == "Bump deps" && status == "backlog"));

            // Run now makes its task.
            let run = call(&s, &me("c5"), "run_automation", json!({"automation_id": "Deps"})).await.unwrap();
            assert_eq!(run["status"], "ok", "{run}");
            let made = db::get_task(&s.db(), run["task_id"].as_str().unwrap()).unwrap().unwrap();
            assert_eq!(made.title, "Bump deps");

            // Deleted by the user while an agent asks to change it: the question goes, and the call says so.
            let c6 = me("c6");
            let delete = async {
                approval_asked(&s).await;
                crate::automations::delete(&s, &a.id).unwrap();
            };
            let (res, _) = tokio::join!(call(&s, &c6, "update_automation", json!({"automation_id": a.id, "trigger": {"kind": "interval", "every_minutes": 30}})), delete);
            assert!(res.unwrap_err().contains("was deleted meanwhile"));
            assert!(permissions::pending_approvals(&s, true, true).unwrap().is_empty());

            // Deleting one is asked about too.
            let b = crate::automations::create(&s, "kiwicd", body.as_object().unwrap()).unwrap();
            let (c7, c8) = (me("c7"), me("c8"));
            let (res, asked) = tokio::join!(call(&s, &c7, "delete_automation", json!({"automation_id": b.id, "reason": "Not needed"})), answer_approval(&s, false));
            assert!(res.unwrap_err().contains("didn't approve deleting the automation \"Weekly\""));
            assert_eq!((&asked["input"]["op"], &asked["input"]["reason"]), (&json!("delete"), &json!("Not needed")));
            assert_eq!(automations(&s, "kiwicd").len(), 1);
            let flagged = db::get_task(&s.db(), &caller.id).unwrap().unwrap();
            assert_eq!(flagged.attention_reason.as_deref(), Some("Delete an automation?"));
            let (res, _) = tokio::join!(call(&s, &c8, "delete_automation", json!({"automation_id": "Weekly"})), answer_approval(&s, true));
            assert_eq!(res.unwrap()["deleted"], json!(true));
            assert!(automations(&s, "kiwicd").is_empty());
        });
    }

    #[test]
    fn agents_only_reach_automations_on_boards_they_can_use() {
        testing::run(async || {
            let s = state();
            let me = insert_profile(&s.db(), "personal", &[], None).unwrap();
            let work = insert_profile(&s.db(), "work", &[], None).unwrap();
            project(&s, &me, "kiwicd", "KIW");
            project(&s, &work, "secret", "SEC");
            let body = json!({"name": "Nightly", "trigger": {"kind": "daily", "time": "02:00"}, "action": {"kind": "create_task", "title": "Nightly"}});
            let theirs = crate::automations::create(&s, "secret", body.as_object().unwrap()).unwrap();
            let caller = task(&s, "kiwicd", "Caller");
            let c = Ctx { task: Some(caller.clone()), call_id: Some("c1".into()), ..ctx(&me) };
            // Not found here, as if it weren't there (so linked hosts are asked instead).
            let not_found = async |tool: &str, args: Value| {
                let r = local(&s, &c, tool, &args).await;
                assert!(matches!(r, Err(ToolError::NotFound(_))), "{tool}: {:?}", r.map_err(msg));
            };
            not_found("list_automations", json!({"project_id": "SEC"})).await;
            not_found("list_automations", json!({"project_id": "work:SEC"})).await;
            not_found("create_automation", json!({"project_id": "SEC", "name": "x", "trigger": body["trigger"], "action": body["action"]})).await;
            for tool in ["update_automation", "delete_automation", "run_automation"] {
                let mut args = json!({"automation_id": theirs.id});
                if tool == "update_automation" {
                    args["enabled"] = json!(false);
                }
                not_found(tool, args).await;
            }
            assert!(crate::automations::get(&s.db(), &theirs.id).unwrap().unwrap().enabled);
            assert!(crate::automations::runs(&s.db(), &theirs.id, 10).unwrap().is_empty());
            assert!(permissions::pending_approvals(&s, true, true).unwrap().is_empty());
            // A task of theirs can't be messaged from an automation here, by id either.
            let hidden = task(&s, "secret", "Hidden");
            let args = json!({"name": "x", "trigger": body["trigger"], "action": {"kind": "send_to_task", "task_id": hidden.id, "message": "hi"}});
            assert!(call(&s, &c, "create_automation", args).await.unwrap_err().contains(&format!("task {} not found in KIW", hidden.id)));
            // Once their board lets this profile's agents in, its automations are there to use.
            grant(&s, &work, &["personal"]);
            let list = call(&s, &c, "list_automations", json!({"project_id": "SEC"})).await.unwrap();
            assert_eq!(list["automations"][0]["id"], json!(theirs.id));
            // And a message still only goes to a task in the automation's own project.
            let args = json!({"name": "x", "trigger": body["trigger"], "action": {"kind": "send_to_task", "task_id": hidden.id, "message": "hi"}});
            assert!(call(&s, &c, "create_automation", args).await.unwrap_err().contains("its own project"));
            // Older hosts aren't sent automation calls.
            assert!(too_old("laptop", 66, "create_automation", &json!({})).is_some_and(|e| e.contains("without the automation tools")));
            assert!(too_old("laptop", 67, "list_automations", &json!({})).is_none());
        });
    }

    #[test]
    fn an_automation_approval_cut_short_by_a_restart_is_still_waited_for() {
        testing::run(async || {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "kiwicd", "KIW");
            let caller = task(&s, "kiwicd", "Caller");
            let run = started_run(&s, &caller.id);
            let call = |id: &str, args: Value| McpCall { task_fields: true, run_id: run.id.clone(), call_id: id.into(), tool: "create_automation".into(), args };
            let cut_short = async |c: McpCall| assert!(tokio::time::timeout(std::time::Duration::from_millis(100), handle_mcp(&s, c)).await.is_err());
            let asks = || s.db().query_row("SELECT COUNT(*) FROM permission_requests WHERE kind='automation'", [], |r| r.get::<_, i64>(0)).unwrap();
            // The server restarts while the user is asked; retried (even with other arguments), the
            // call waits for the same answer and makes what it asked about, once.
            cut_short(call("c1", webhook_args("Triage"))).await;
            let (res, _) = tokio::join!(handle_mcp(&s, call("c1", webhook_args("Other"))), answer_approval(&s, true));
            assert_eq!(res.unwrap()["name"], "Triage");
            assert_eq!((asks(), automations(&s, "kiwicd").len()), (1, 1));
            assert_eq!(handle_mcp(&s, call("c1", webhook_args("Triage"))).await.unwrap()["name"], "Triage");
            assert_eq!(automations(&s, "kiwicd").len(), 1);
            // Denied before the retry: nothing is made.
            cut_short(call("c2", webhook_args("Second"))).await;
            answer_approval(&s, false).await;
            assert!(handle_mcp(&s, call("c2", webhook_args("Second"))).await.unwrap_err().contains("didn't approve"));
            assert_eq!(automations(&s, "kiwicd").len(), 1);
            // Approved before the retry: it may have been made as the server stopped, so it isn't made again.
            cut_short(call("c3", webhook_args("Third"))).await;
            answer_approval(&s, true).await;
            assert!(handle_mcp(&s, call("c3", webhook_args("Third"))).await.unwrap_err().contains("interrupted"));
            assert_eq!(automations(&s, "kiwicd").len(), 1);
            assert_eq!(asks(), 3);
        });
    }
}
