//! Running a tool call: deduplicating the MCP helper's calls, and sending each to this host or to the
//! linked host that has its project or task (with the API version each tool needs there).

use super::*;

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
pub(super) async fn dispatch(s: &Shared, ctx: &Ctx, tool: &str, args: Value) -> std::result::Result<Value, String> {
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
pub(super) const MARKS_API: u32 = 48;

/// The API version from which hosts have delete_task.
const DELETE_TASK_API: u32 = 58;

/// The API version from which task details are bounded and get_task_field is available.
pub(super) const TASK_FIELDS_API: u32 = 59;

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
pub(super) fn too_old(host: &str, api_version: u32, tool: &str, args: &Value) -> Option<String> {
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
pub(super) fn needs_project_settings_api(tool: &str, args: &Value) -> bool {
    const OLD_FIELDS: &[&str] = &["start_prompt", "review_prompt", "merge_prompt", "auto_review", "review_rounds", "reviewers", "group_name"];
    tool == "update_project" && AGENT_FIELDS.iter().chain(APPROVAL_FIELDS).any(|k| !OLD_FIELDS.contains(k) && !args[*k].is_null())
}
