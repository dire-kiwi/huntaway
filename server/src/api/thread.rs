//! A task's thread and agent: its messages, sending, stopping and reviewing, its worktree, diff and
//! terminal, and agents' permission prompts.

use super::*;

#[derive(Deserialize)]
pub(super) struct MessagesQuery {
    before: Option<i64>,
    after: Option<i64>,
    limit: Option<usize>,
}

/// A thread's messages: all of them as a list, or with any of `before`, `after` (message ids) and
/// `limit`, one page of them (API 56, see db::message_page) as `{messages, more, subagents}`. The latest
/// page (without `before` or `after`) has, in `subagents`, what lists the subagents started before it.
/// Read on a blocking thread: a long thread takes a while, and the async workers serve everything else.
pub(super) async fn list_messages(State(s): State<Shared>, Path(id): Path<String>, Query(q): Query<MessagesQuery>) -> ApiResult<Json<Value>> {
    let read = move || -> anyhow::Result<Value> {
        let c = s.db();
        if q.before.is_none() && q.after.is_none() && q.limit.is_none() {
            return Ok(json!(db::list_messages(&c, &id)?));
        }
        let (messages, more) = db::message_page(&c, &id, q.after, q.before, q.limit)?;
        let subagents = match messages.first() {
            Some(first) if more && q.before.is_none() && q.after.is_none() => db::subagent_messages(&c, &id, first.id)?,
            _ => Vec::new(),
        };
        Ok(json!({"messages": messages, "more": more, "subagents": subagents}))
    };
    Ok(Json(tokio::task::spawn_blocking(read).await.map_err(anyhow::Error::from)??))
}

#[derive(Deserialize)]
pub(super) struct SendBody {
    #[serde(default)]
    pub(super) text: String,
}

pub(super) async fn send_message(State(s): State<Shared>, Path(id): Path<String>, Json(b): Json<SendBody>) -> ApiResult<Json<Value>> {
    let t = runner::send(&s, &id, &b.text)?;
    // The user's reply answers the questions the agent asked (see mcp/questions.rs).
    if !b.text.trim().is_empty() {
        crate::mcp::questions::replied(&s, &t.id);
    }
    Ok(Json(json!(t)))
}

#[derive(Deserialize)]
pub(super) struct AssistantQuery {
    /// Set by a hub that routed the request here (API 98): it's this host's, whatever its profile's `assistant_host`.
    #[serde(default)]
    local: Option<String>,
}

/// `GET /profiles/{id}/assistant` (API 97): the profile's assistant (see agent/assistant.rs),
/// made the first time it's asked for. API 98: with its `host_id`, which is the profile's assistant host's
/// when it has one, where the request goes (see assistant::on_its_host).
pub(super) async fn get_assistant(State(s): State<Shared>, Path(id): Path<String>, Query(q): Query<AssistantQuery>) -> ApiResult<Json<Value>> {
    if q.local.is_none()
        && let Some(t) = assistant::on_its_host(&s, &id, "GET", None).await?
    {
        return Ok(Json(t));
    }
    Ok(Json(assistant::with_host(&s, &assistant::get_or_create(&s, &id)?)))
}

/// `POST /profiles/{id}/assistant` (API 97): send the user's message to the profile's assistant,
/// as `POST /tasks/{id}/messages` does to its thread, making it first if it has none. Returns the task,
/// on its assistant host if it has one, as `GET` does.
pub(super) async fn send_to_assistant(
    State(s): State<Shared>,
    Path(id): Path<String>,
    Query(q): Query<AssistantQuery>,
    Json(b): Json<SendBody>,
) -> ApiResult<Json<Value>> {
    if q.local.is_none()
        && let Some(t) = assistant::on_its_host(&s, &id, "POST", Some(json!({"text": b.text}))).await?
    {
        return Ok(Json(t));
    }
    Ok(Json(assistant::with_host(&s, &assistant::send(&s, &id, &b.text)?)))
}

/// A profile's approval rules as the UI shows them: the ones in force, whether they're the
/// defaults, and the defaults to go back to.
fn rules_view(c: &rusqlite::Connection, profile_id: &str) -> anyhow::Result<Value> {
    let saved = approval_rules::saved(c, profile_id)?;
    let defaults = approval_rules::Rules::default();
    Ok(json!({
        "rules": saved.as_ref().unwrap_or(&defaults).rules,
        "expiry_minutes": saved.as_ref().unwrap_or(&defaults).expiry_minutes,
        "is_default": saved.is_none(),
        "defaults": defaults,
        "board_server": runner::MCP_SERVER_NAME,
        "google_server": approval_rules::GOOGLE_SERVER,
        "create_task_tools": approval_rules::CREATE_TASK_TOOLS,
    }))
}

/// `GET /profiles/{id}/approval-rules` (API 101): what the profile's assistant may do outside the
/// board, asks first or never does (see agent/approval_rules.rs).
pub(super) async fn get_approval_rules(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let c = s.db();
    if db::get_profile(&c, &id)?.is_none() {
        return Err(ApiError::not_found("profile"));
    }
    Ok(Json(rules_view(&c, &id)?))
}

#[derive(Deserialize)]
pub(super) struct RulesBody {
    #[serde(default)]
    rules: Option<Vec<approval_rules::Rule>>,
    #[serde(default)]
    expiry_minutes: Option<u32>,
    /// Back to the defaults.
    #[serde(default)]
    reset: bool,
}

/// `POST /profiles/{id}/approval-rules` (API 101) with `{rules, expiry_minutes}` (either may be left
/// out, keeping it as it is), or `{reset: true}` for the defaults. They hold from the next run on.
pub(super) async fn set_approval_rules(State(s): State<Shared>, Path(id): Path<String>, Json(b): Json<RulesBody>) -> ApiResult<Json<Value>> {
    let c = s.db();
    if db::get_profile(&c, &id)?.is_none() {
        return Err(ApiError::not_found("profile"));
    }
    if b.reset {
        approval_rules::set(&c, &id, None)?;
    } else {
        let now = approval_rules::get(&c, &id)?;
        let rules = approval_rules::Rules { rules: b.rules.unwrap_or(now.rules), expiry_minutes: b.expiry_minutes.unwrap_or(now.expiry_minutes) };
        let rules = rules.checked().map_err(ApiError::bad)?;
        approval_rules::set(&c, &id, Some(&rules))?;
    }
    let view = rules_view(&c, &id)?;
    drop(c);
    s.emit(json!({"type": "approval_rules", "profile_id": id}));
    Ok(Json(view))
}

#[derive(Deserialize)]
pub(super) struct LogQuery {
    limit: Option<i64>,
}

/// `GET /profiles/{id}/approval-log` (API 101): the calls the profile's rules asked about or turned
/// away, newest first (see approval_rules::Action).
pub(super) async fn approval_log(State(s): State<Shared>, Path(id): Path<String>, Query(q): Query<LogQuery>) -> ApiResult<Json<Value>> {
    let c = s.db();
    if db::get_profile(&c, &id)?.is_none() {
        return Err(ApiError::not_found("profile"));
    }
    Ok(Json(json!(approval_rules::list(&c, &id, q.limit.unwrap_or(200))?)))
}

/// Answer a question an agent asked with request_user_input, from its card (API 64): the answer
/// is sent as the user's message.
pub(super) async fn answer_question(
    State(s): State<Shared>,
    Path((id, message_id)): Path<(String, i64)>,
    Json(b): Json<crate::mcp::questions::Answer>,
) -> ApiResult<Json<Value>> {
    let task = db::get_task(&s.db(), &id)?.ok_or_else(|| ApiError::not_found("task"))?;
    Ok(Json(json!(crate::mcp::questions::answer(&s, &task.id, message_id, b)?)))
}

/// Drop the queued message. Returns the task as it was, queued message included.
pub(super) async fn unqueue_message(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(json!(runner::unqueue(&s, &id)?)))
}

/// Stop the thread's agent, and the task's review if one is in progress.
pub(super) async fn stop_task(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let agent = runner::stop(&s, &id);
    let review = crate::review::stop(&s, &id);
    let summary = crate::review::summary::stop(&s, &id);
    Ok(Json(json!({"stopped": agent || review || summary})))
}

/// Summarise the task's changes now (see review/summary.rs).
pub(super) async fn summarise_task(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let t = crate::review::summary::start(&s, &id, true).await?;
    Ok(Json(json!(t)))
}

/// Review the task's work now (see review.rs).
pub(super) async fn review_task(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let t = crate::review::start(&s, &id, true).await?;
    Ok(Json(json!(t)))
}

/// Give a task that ran out of rounds of fixes as many again (API 93, see review::extend).
pub(super) async fn extend_review(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let t = crate::review::extend(&s, &id)?;
    Ok(Json(json!(t)))
}

/// Send the agent its pull request's failed checks, with the ends of their logs (API 94, see
/// mcp/pr_watch.rs's fix_checks).
pub(super) async fn fix_checks(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(json!(crate::mcp::pr_watch::fix_checks(&s, &id).await?)))
}

pub(super) async fn setup_worktree(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    // Reviewers work in the worktree too.
    if worktree::agent_in_worktree(&s, &id) {
        return Err(ApiError::conflict("an agent is working in the worktree (the task's or a reviewer's); wait for it to finish or stop it"));
    }
    let t = worktree::setup(&s, &id).await.map_err(|e| ApiError::bad(format!("{e:#}")))?;
    Ok(Json(json!(t)))
}

#[derive(Deserialize, Default)]
pub(super) struct TeardownBody {
    #[serde(default)]
    force: bool,
    #[serde(default)]
    delete_branch: bool,
}

pub(super) async fn teardown_worktree(State(s): State<Shared>, Path(id): Path<String>, body: Option<Json<TeardownBody>>) -> ApiResult<Json<Value>> {
    // Reviewers work in the worktree too.
    if worktree::agent_in_worktree(&s, &id) {
        return Err(ApiError::conflict("an agent is working in the worktree (the task's or a reviewer's); wait for it to finish or stop it"));
    }
    let b = body.map(|b| b.0).unwrap_or_default();
    let t = worktree::teardown(&s, &id, b.force, b.delete_branch).await.map_err(|e| ApiError::conflict(format!("{e:#}")))?;
    Ok(Json(json!(t)))
}

/// `GET /projects/{id}/system-prompt` (API 80): what the agent of a new thread in the project is told on top of its
/// agent's own system prompt, for the options given (see runner::preview): `{text, runtime, permission_mode}`.
pub(super) async fn system_prompt_preview(State(s): State<Shared>, Path(id): Path<String>, Query(q): Query<runner::PreviewOptions>) -> ApiResult<Json<Value>> {
    let project = db::get_project(&s.db(), &id)?.ok_or_else(|| ApiError::not_found("project"))?;
    let (text, codex, mode) = runner::preview(&s, &project, &q).await?;
    Ok(Json(json!({"text": text, "runtime": if codex { "codex" } else { "claude" }, "permission_mode": mode})))
}

/// Remove the worktrees of the project's done tasks that are merged and have nothing
/// uncommitted (see worktree::remove_if_merged): `{"results": [{task_id, number, title, removed,
/// detail}]}`, one for each done task that had a worktree.
pub(super) async fn remove_merged_worktrees(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    if db::get_project(&s.db(), &id)?.is_none() {
        return Err(ApiError::not_found("project"));
    }
    Ok(Json(json!({"results": worktree::remove_merged(&s, &id).await?})))
}

#[derive(Deserialize, Default)]
pub struct StartSetupThread {
    /// What the user adds to the agent's instructions, if anything.
    #[serde(default)]
    pub message: String,
}

pub(super) async fn start_setup_thread(State(s): State<Shared>, Path(id): Path<String>, Json(b): Json<StartSetupThread>) -> ApiResult<Json<Value>> {
    Ok(Json(json!(start_setup_thread_inner(&s, &id, b).await?)))
}

/// `POST /projects/{id}/setup-thread` (API 73): the project's setup thread (see
/// db::Project::setup_task_id), whose agent helps the user make its folder a git repository with
/// a commit, so its tasks can have worktrees. A new one is started with `message` after its
/// instructions; one the project has already is returned as it is.
pub async fn start_setup_thread_inner(s: &Shared, project_id: &str, b: StartSetupThread) -> ApiResult<db::Task> {
    // So two at once make one thread.
    let _changing = s.project_changes.lock().await;
    let project = db::get_project(&s.db(), project_id)?.ok_or_else(|| ApiError::not_found("project"))?;
    let existing = match &project.setup_task_id {
        Some(t) => db::get_task(&s.db(), t)?,
        None => None,
    };
    if let Some(t) = existing {
        return Ok(t);
    }
    if project.is_git && project.has_commits {
        return Err(ApiError::conflict(format!("{} is ready for worktrees already", project.repo_path)));
    }
    let setup = CreateTask {
        title: "Get the folder ready for worktrees".into(),
        description: setup_instructions(&project),
        use_worktree: Some(false),
        ..Default::default()
    };
    let t = create_task_inner(s, &project.id, setup)?;
    let p = db::update_project(&s.db(), &project.id, &[("setup_task_id", json!(t.id))])?.ok_or_else(|| ApiError::not_found("project"))?;
    s.emit(json!({"type": "project", "project": p}));
    // Kept as the project's thread even if its agent can't start, to try again from.
    runner::send(s, &t.id, b.message.trim())
}

/// What a project's setup thread's agent is asked to do (see start_setup_thread_inner).
fn setup_instructions(p: &db::Project) -> String {
    let now = if !p.is_git {
        "It isn't a git repository yet."
    } else {
        "It's a git repository, but it has no commits yet (or the branch checked out has none)."
    };
    format!(
        "Huntaway runs each of this project's tasks in a git worktree of its own, on a branch of its own, so several agents can \
         work on the project at once without getting in each other's way. For that, the project's folder `{}` has to be the top \
         folder of a git repository, with a commit checked out for the tasks' branches to start from. {now} Until it is, the \
         board shows this thread in place of the project's tasks.\n\n\
         Help me get it ready:\n\n\
         1. Look at what's in the folder and tell me briefly what you find. If it's inside another git repository (such as a \
         home folder kept in git), say so, and ask me before making a repository of its own in it.\n\
         2. If it isn't a repository yet, run `git init` there (with `main` as the branch, unless I say otherwise).\n\
         3. Before the first commit, add a `.gitignore` for what shouldn't be committed, such as dependencies, build output, \
         local environment files and secrets. Ask me when you're unsure whether something belongs in the repository.\n\
         4. Make the first commit.\n\
         5. Ask me whether to put the repository on GitHub (or another remote), and if I want to, set that up and push.\n\n\
         Ask me before anything that's hard to undo, such as deleting or moving files, rewriting history or pushing. Once the \
         repository has a commit, the board shows the project's tasks again, and new tasks get their own worktrees. End with \
         a short summary of what you set up.",
        p.repo_path
    )
}

pub(super) async fn task_diff(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(worktree::diff(&s, &id).await?))
}

/// Whether moving the task to Done would leave work of its unmerged (see worktree::unmerged).
pub(super) async fn task_unmerged(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let t = db::get_task(&s.db(), &id)?.ok_or_else(|| ApiError::not_found("task"))?;
    Ok(Json(json!({"unmerged": worktree::unmerged(&s, &t).await})))
}

// ---------- terminal ----------

/// `?tool=<id>` picks one of the host's terminal tools instead of the task's shell.
#[derive(Deserialize)]
pub(super) struct ToolQuery {
    tool: Option<String>,
}

fn find_tool(s: &Shared, id: Option<&str>) -> ApiResult<Option<terminal::Tool>> {
    let Some(id) = id.filter(|t| !t.is_empty()) else { return Ok(None) };
    let tool = terminal::tools(&s.db()).into_iter().find(|t| t.id == id);
    tool.map(Some).ok_or_else(|| ApiError::not_found("terminal tool"))
}

pub(super) async fn terminal_status(State(s): State<Shared>, device: Option<axum::Extension<crate::devices::DeviceAuth>>, Path(id): Path<String>, Query(q): Query<ToolQuery>) -> ApiResult<Json<Value>> {
    crate::devices::board_only(&device, "use terminals")?;
    let t = db::get_task(&s.db(), &id)?.ok_or_else(|| ApiError::not_found("task"))?;
    let tool = find_tool(&s, q.tool.as_deref())?;
    Ok(Json(terminal::status(&s, &t, tool.as_ref()).await))
}

pub(super) async fn kill_terminal(State(s): State<Shared>, device: Option<axum::Extension<crate::devices::DeviceAuth>>, Path(id): Path<String>, Query(q): Query<ToolQuery>) -> ApiResult<Json<Value>> {
    crate::devices::board_only(&device, "use terminals")?;
    if db::get_task(&s.db(), &id)?.is_none() {
        return Err(ApiError::not_found("task"));
    }
    // A tool that was removed from the settings can still be ended.
    terminal::kill(&s, &id, q.tool.as_deref().filter(|t| !t.is_empty())).await;
    Ok(Json(json!({"ok": true})))
}

/// The board still has this tool open: keep its session (see `terminal::start_reaper`).
pub(super) async fn terminal_keepalive(State(s): State<Shared>, device: Option<axum::Extension<crate::devices::DeviceAuth>>, Path(id): Path<String>, Query(q): Query<ToolQuery>) -> ApiResult<Json<Value>> {
    crate::devices::board_only(&device, "use terminals")?;
    let tool = q.tool.filter(|t| !t.is_empty()).ok_or_else(|| ApiError::bad("tool is required"))?;
    if db::get_task(&s.db(), &id)?.is_none() {
        return Err(ApiError::not_found("task"));
    }
    terminal::keepalive(&id, &tool);
    Ok(Json(json!({"ok": true})))
}

#[derive(Deserialize)]
pub(super) struct TerminalQuery {
    cols: Option<u16>,
    rows: Option<u16>,
    tool: Option<String>,
}

pub(super) async fn terminal_ws(
    State(s): State<Shared>,
    device: Option<axum::Extension<crate::devices::DeviceAuth>>,
    Path(id): Path<String>,
    Query(q): Query<TerminalQuery>,
    upgrade: WebSocketUpgrade,
) -> ApiResult<Response> {
    crate::devices::board_only(&device, "open terminals")?;
    let t = db::get_task(&s.db(), &id)?.ok_or_else(|| ApiError::not_found("task"))?;
    if !terminal::available() {
        return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "tmux is not installed on this host".into()));
    }
    let tool = find_tool(&s, q.tool.as_deref())?;
    let size = |v: Option<u16>, d: u16| v.filter(|v| (2..=1000).contains(v)).unwrap_or(d);
    let (cols, rows) = (size(q.cols, 80), size(q.rows, 24));
    Ok(upgrade.on_upgrade(move |ws| crate::devices::until_revoked(s.clone(), device.map(|d| d.0), terminal::serve(s, t, tool, cols, rows, ws))))
}

// ---------- permissions ----------

#[derive(Deserialize)]
pub(super) struct PermissionsQuery {
    task_id: Option<String>,
    /// API 100: only one profile's (the mobile app's inbox).
    profile_id: Option<String>,
}

/// Pending permission prompts (`?task_id=` for one task's, `?profile_id=` for a profile's), so scripts and the mobile
/// app can answer them.
pub(super) async fn list_permissions(State(s): State<Shared>, Query(q): Query<PermissionsQuery>) -> ApiResult<Json<Value>> {
    Ok(Json(json!(permissions::pending(&s, q.task_id.as_deref(), q.profile_id.as_deref())?)))
}

#[derive(Deserialize)]
pub(super) struct ResolveBody {
    decision: String,
    message: Option<String>,
    /// The answers to a question, or how a plan is approved or what to change in it (API 64).
    #[serde(flatten)]
    reply: permissions::Reply,
    /// `push` for an answer from a notification, which the hub passes on (API 101), for the action log.
    #[serde(default)]
    via: Option<String>,
}

pub(super) async fn resolve_permission(State(s): State<Shared>, Path(id): Path<String>, Json(b): Json<ResolveBody>) -> ApiResult<Json<Value>> {
    let allow = match b.decision.as_str() {
        "allow" | "allow_always" => true,
        "deny" => false,
        _ => return Err(ApiError::bad("decision must be allow, allow_always or deny")),
    };
    let by = if b.via.as_deref() == Some("push") { "push" } else { "user" };
    let status = permissions::answer_by(&s, &id, allow, b.decision == "allow_always", b.message, b.reply, by)?;
    Ok(Json(json!({"ok": true, "status": status})))
}

#[derive(Deserialize)]
pub(super) struct ApprovalsQuery {
    /// Deletions too (API 58); older hosts ignore it and list project changes only.
    #[serde(default)]
    all: bool,
    /// Automations too (API 67).
    #[serde(default)]
    automations: bool,
}

/// Project changes (and with `?all=true`, task deletions, and with `?automations=true`,
/// automations) agents are waiting for the user to approve (see permissions::approve).
pub(super) async fn project_approvals(State(s): State<Shared>, Query(q): Query<ApprovalsQuery>) -> ApiResult<Json<Value>> {
    Ok(Json(json!(permissions::pending_approvals(&s, q.all, q.automations)?)))
}
