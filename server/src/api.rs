use std::collections::BTreeMap;
use std::io::Write;
use std::path::PathBuf;

use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Path, Query, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use axum::{Json, Router};
use base64::Engine;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::db::{self, NewProject, NewTask, PERMISSION_MODES, STATUSES};
use crate::state::{ApiError, ApiResult, Shared};
use crate::util::{derive_key, expand_tilde, new_id, path_str, same_secret};
use crate::{admin, agent_tools, git_view, github, hub, permissions, relocate, runner, terminal, title, tools, worktree};

/// This host's API (`/api/...`) plus the hub endpoints that span hosts.
pub fn router(state: Shared) -> Router {
    let host_api = host_routes().layer(middleware::from_fn_with_state(state.clone(), auth));
    let local: Router = Router::new().nest("/api", host_api.clone().fallback(no_route).method_not_allowed_fallback(wrong_method)).with_state(state.clone());
    let _ = state.local_router.set(local);
    let hub_api = Router::new()
        .route("/hosts", get(hub::list_hosts).post(hub::add_host))
        .route("/hosts/join", get(hub::join_info))
        .route("/hosts/ssh-key", get(hub::ssh_key))
        .route("/hosts/ssh", post(hub::add_ssh_host))
        .route("/hosts/copy-claude-config", post(hub::copy_claude_config))
        .route("/hosts/{id}", axum::routing::patch(hub::rename_host).delete(hub::remove_host))
        .route("/hosts/{id}/update", post(hub::update_host))
        .route("/preview-status", get(preview_status))
        .route("/push", get(crate::push::info))
        .route("/push/subscriptions", post(crate::push::subscribe))
        .route("/push/subscriptions/{id}", axum::routing::patch(crate::push::update).delete(crate::push::unsubscribe))
        .route("/push/subscriptions/{id}/test", post(crate::push::test))
        .route("/h/{host_id}/{*rest}", any(hub::proxy))
        .route("/ws", get(hub::ws))
        .layer(middleware::from_fn_with_state(state.clone(), auth));
    Router::new()
        .route("/api/health", get(health))
        .route("/api/hub/connect", get(hub::accept))
        // Without the board's token: the token in its path reaches only its own automation.
        .route("/api/hooks/{id}/{token}", post(crate::automations::webhook).layer(DefaultBodyLimit::max(crate::automations::MAX_BODY)))
        .nest("/api", host_api.merge(hub_api).fallback(no_route).method_not_allowed_fallback(wrong_method))
        // The nested fallback covers `/api` but not `/api/`.
        .route("/api/", any(no_route))
        .with_state(state)
}

/// The start of the error for an `/api/...` path with no route (so it isn't served the UI).
pub const NO_ROUTE: &str = "no such API route";

/// The body for an unknown route (or a known one without this method), and what the hub makes of an
/// older host's empty 404 or 405 or UI page.
pub fn no_route_error(method: &str, path: &str) -> Value {
    json!({"error": format!("{NO_ROUTE}: {method} {}", path.split('?').next().unwrap_or_default())})
}

async fn no_route(method: axum::http::Method, axum::extract::OriginalUri(uri): axum::extract::OriginalUri) -> Response {
    (StatusCode::NOT_FOUND, Json(no_route_error(method.as_str(), uri.path()))).into_response()
}

async fn wrong_method(method: axum::http::Method, axum::extract::OriginalUri(uri): axum::extract::OriginalUri) -> Response {
    (StatusCode::METHOD_NOT_ALLOWED, Json(no_route_error(method.as_str(), uri.path()))).into_response()
}

/// Everything about this host's own board.
fn host_routes() -> Router<Shared> {
    Router::new()
        .route("/info", get(info))
        .route("/default-prompts", get(|| async { Json(crate::prompts::defaults()) }))
        .route("/profiles", get(list_profiles).post(create_profile))
        .route("/profiles/{id}", axum::routing::patch(update_profile).delete(delete_profile))
        .route("/github-accounts", get(github_accounts))
        .route("/github-repos", get(github_repos))
        .route("/claude-configs", get(list_claude_configs).post(create_claude_config))
        .route("/claude-configs/{id}", axum::routing::patch(update_claude_config).delete(delete_claude_config))
        .route("/profiles/{id}/projects", get(list_projects).post(create_project))
        .route("/profiles/{id}/projects/clone", post(clone_project))
        .route("/profiles/{id}/tasks", get(list_profile_tasks).post(create_scratch_task))
        // Scratch chats, of which there are none since they became scratch tasks (for older boards).
        .route("/profiles/{id}/scratch", get(list_profile_scratch))
        .route("/profiles/{id}/group-tasks", get(list_group_tasks).post(create_group_task))
        .route("/profiles/{id}/analytics", get(crate::analytics::get))
        .route("/profiles/{id}/disk-usage", get(crate::disk::get))
        .route("/profiles/{id}/asana/tasks", get(asana_tasks))
        .route("/projects/{id}", get(get_project).patch(update_project).delete(delete_project))
        .route("/projects/{id}/tasks", get(list_project_tasks).post(create_task))
        .route("/projects/{id}/remove-merged-worktrees", post(remove_merged_worktrees))
        .route("/projects/{id}/setup-thread", post(start_setup_thread))
        .route("/projects/{id}/system-prompt", get(system_prompt_preview))
        .route("/projects/{id}/automations", get(crate::automations::list_handler).post(crate::automations::create_handler))
        .route(
            "/automations/{id}",
            get(crate::automations::get_handler).patch(crate::automations::update_handler).delete(crate::automations::delete_handler),
        )
        .route("/automations/{id}/run", post(crate::automations::run_handler))
        .route("/automations/{id}/runs", get(crate::automations::runs_handler))
        .route("/agent-tools", get(agent_tools::get_global))
        .route("/agent-tools/switches", post(agent_tools::set_switch))
        .route("/agent-tools/skills", post(agent_tools::create_global_skill))
        .route("/agent-tools/skills/{skill}", axum::routing::patch(agent_tools::update_global_skill).delete(agent_tools::delete_global_skill))
        .route("/agent-tools/mcp-servers", post(agent_tools::create_global_mcp_server))
        .route(
            "/agent-tools/mcp-servers/{server}",
            axum::routing::patch(agent_tools::update_global_mcp_server).delete(agent_tools::delete_global_mcp_server),
        )
        .route("/projects/{id}/agent-tools", get(agent_tools::get).patch(agent_tools::patch))
        .route("/projects/{id}/agent-tools/skills", post(agent_tools::create_skill))
        .route("/projects/{id}/agent-tools/skills/{skill}", axum::routing::patch(agent_tools::update_skill).delete(agent_tools::delete_skill))
        .route("/projects/{id}/agent-tools/mcp-servers", post(agent_tools::create_mcp_server))
        .route(
            "/projects/{id}/agent-tools/mcp-servers/{server}",
            axum::routing::patch(agent_tools::update_mcp_server).delete(agent_tools::delete_mcp_server),
        )
        .route("/tasks/{id}", get(get_task).patch(update_task).delete(delete_task))
        .route("/tasks/{id}/messages", get(list_messages).post(send_message))
        .route("/tasks/{id}/questions/{message_id}", post(answer_question))
        .route("/tasks/{id}/stop", post(stop_task))
        .route("/tasks/{id}/queue", axum::routing::delete(unqueue_message))
        .route("/tasks/{id}/wait-for-limit", post(crate::usage::wait_for_reset))
        .route("/tasks/{id}/review", post(review_task))
        .route("/tasks/{id}/worktree/setup", post(setup_worktree))
        .route("/tasks/{id}/worktree/teardown", post(teardown_worktree))
        .route("/tasks/{id}/diff", get(task_diff))
        .route("/tasks/{id}/unmerged", get(task_unmerged))
        .route("/tasks/{id}/git", get(git_view::status))
        .route("/tasks/{id}/git/diff", get(git_view::diff))
        .route("/tasks/{id}/git/show", get(git_view::show))
        .route("/tasks/{id}/git/stage", post(git_view::stage))
        .route("/tasks/{id}/git/unstage", post(git_view::unstage))
        .route("/tasks/{id}/git/discard", post(git_view::discard))
        // A patch of a big file's lines is past the default 2 MB body limit.
        .route("/tasks/{id}/git/apply", post(git_view::apply).layer(DefaultBodyLimit::max(32 << 20)))
        .route("/tasks/{id}/git/commit", post(git_view::commit))
        .route("/tasks/{id}/git/stash", post(git_view::stash))
        .route("/tasks/{id}/git/reset", post(git_view::reset))
        .route("/tasks/{id}/turns", get(crate::checkpoints::turns))
        .route("/tasks/{id}/turns/diff", get(crate::checkpoints::diff))
        .route("/tasks/{id}/rewind", post(crate::checkpoints::rewind).delete(crate::checkpoints::cancel_rewind))
        .route("/tasks/{id}/context", get(crate::context::get))
        .route("/tasks/{id}/skills", get(agent_tools::for_task))
        .route("/tasks/{id}/document", get(crate::documents::get))
        .route("/tasks/{id}/terminal", get(terminal_status).delete(kill_terminal))
        .route("/tasks/{id}/terminal/ws", get(terminal_ws))
        .route("/tasks/{id}/terminal/keepalive", post(terminal_keepalive))
        // A config with plugins and skills is easily past the default 2 MB body limit.
        .route("/claude-configs/{id}/models", get(claude_config_models))
        .route(
            "/claude-configs/{id}/archive",
            get(export_claude_config).post(import_claude_config).layer(DefaultBodyLimit::max(256 << 20)),
        )
        // The same for a profile's default config, for hubs from before configs were separate.
        .route(
            "/profiles/{id}/claude-config",
            get(export_profile_config).post(import_profile_config).layer(DefaultBodyLimit::max(256 << 20)),
        )
        .route("/attachments", post(crate::attachments::upload).layer(DefaultBodyLimit::max(16 << 20)))
        .route("/attachments/{id}/{name}", get(crate::attachments::download))
        .route("/permissions", get(list_permissions))
        .route("/permissions/{id}", post(resolve_permission))
        .route("/project-approvals", get(project_approvals))
        .route("/internal/mcp", post(internal_mcp))
        .route("/tools/{tool}", post(remote_tool))
        .route("/usage", get(crate::usage::list))
        .route("/settings", get(get_settings).patch(update_settings))
        .route("/fs/dirs", get(fs_dirs))
        .route("/admin/server", get(server_status))
        .route("/admin/restart", post(restart_server))
        .route("/admin/update", post(update_from_hub))
        .route("/admin/release/check", post(check_releases))
        .route("/admin/release/update", post(update_to_release))
        .route("/admin/release/rollback", post(roll_back_release))
        .route("/host/ws", get(ws))
}

async fn auth(State(s): State<Shared>, headers: HeaderMap, req: Request, next: Next) -> Response {
    let header_ok = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|t| same_secret(t, &s.token));
    let query_ok = req
        .uri()
        .query()
        .map(|q| q.split('&').any(|kv| kv.strip_prefix("token=").is_some_and(|t| same_secret(t, &s.token))))
        .unwrap_or(false);
    if header_ok || query_ok {
        next.run(req).await
    } else {
        (StatusCode::UNAUTHORIZED, Json(json!({"error": "unauthorized"}))).into_response()
    }
}

/// Pick known keys out of a JSON body as (column, value) pairs.
fn pick<'a>(body: &Map<String, Value>, keys: &[&'a str]) -> Vec<(&'a str, Value)> {
    keys.iter().filter_map(|k| body.get(*k).map(|v| (*k, v.clone()))).collect()
}

/// Unauthenticated. API 65: with the commit it runs, for hosts that follow it with `--update-from`.
async fn health(State(s): State<Shared>) -> Json<Value> {
    Json(json!({"ok": true, "commit": s.meta.running_commit}))
}

async fn info(State(s): State<Shared>) -> Json<Value> {
    let hostname = std::fs::read_to_string("/proc/sys/kernel/hostname").unwrap_or_default().trim().to_string();
    Json(json!({
        "host_id": s.host_id,
        "host_name": s.host_name,
        "build_id": crate::proto::BUILD_ID,
        "api_version": crate::proto::API_VERSION,
        "api_compat": crate::proto::API_COMPAT,
        "commit": s.meta.running_commit,
        "agents": crate::runs::can_run_agents(&s),
        // API 25: which agent CLIs it has.
        "agent_clis": db::AGENTS.iter().filter(|a| crate::runs::has_agent(a)).collect::<Vec<_>>(),
        "version": env!("CARGO_PKG_VERSION"),
        "data_dir": path_str(&s.data_dir),
        "hostname": hostname,
        "home": dirs::home_dir().map(|h| path_str(&h)),
    }))
}

// ---------- profiles ----------

async fn list_profiles(State(s): State<Shared>) -> ApiResult<Json<Value>> {
    Ok(Json(json!(db::list_profiles(&s.db())?)))
}

#[derive(Deserialize)]
struct CreateProfile {
    name: String,
    /// The Claude configs it can use, the default first.
    claude_config_ids: Option<Vec<String>>,
    /// Instead of `claude_config_ids`: use the config with this directory, creating it if
    /// needed (clients from before configs were separate).
    claude_config_dir: Option<String>,
    default_model: Option<String>,
    /// See `db::Profile::agent_access`.
    agent_access: Option<Value>,
    /// See `db::Profile::github_account`.
    #[serde(default)]
    github_account: Value,
    /// See `db::Profile::clone_dir` (API 55).
    #[serde(default)]
    clone_dir: Value,
    /// See `db::Profile::asana_enabled` (API 60).
    #[serde(default = "yes")]
    asana_enabled: bool,
    /// See `db::Profile::limit_wait` (API 81).
    #[serde(default)]
    limit_wait: bool,
    /// See `db::Profile::limit_switch` (API 81).
    #[serde(default)]
    limit_switch: bool,
}

async fn create_profile(State(s): State<Shared>, Json(b): Json<CreateProfile>) -> ApiResult<Json<Value>> {
    let c = s.db();
    let name = &check_profile_name(&c, None, &json!(b.name))?;
    let ids = match (b.claude_config_ids, b.claude_config_dir) {
        (Some(ids), _) => check_config_ids(&c, ids)?,
        (None, Some(dir)) => vec![db::config_for_dir(&c, name, &dir)?],
        (None, None) => vec![],
    };
    let access = b.agent_access.as_ref().map(|v| check_agent_access(name, v)).transpose()?;
    let github_account = check_github_account(&b.github_account)?;
    let clone_dir = check_clone_dir(&b.clone_dir)?;
    let mut p = db::insert_profile(&c, name, &ids, b.default_model.as_deref())?;
    let mut fields = vec![("github_account", github_account), ("clone_dir", clone_dir), ("asana_enabled", json!(b.asana_enabled))];
    fields.extend([("limit_wait", json!(b.limit_wait)), ("limit_switch", json!(b.limit_switch))]);
    fields.extend(access.map(|a| ("agent_access", json!(a))));
    p = db::update_profile(&c, &p.id, &fields)?.ok_or_else(|| ApiError::not_found("profile"))?;
    drop(c);
    std::fs::create_dir_all(s.profile_scratch_dir(&p.id)).ok();
    s.emit(json!({"type": "profiles_changed"}));
    Ok(Json(json!(p)))
}

async fn update_profile(State(s): State<Shared>, Path(id): Path<String>, Json(b): Json<Map<String, Value>>) -> ApiResult<Json<Value>> {
    if db::get_profile(&s.db(), &id)?.is_none() {
        return Err(ApiError::not_found("profile"));
    }
    // Checked with Asana before the database is locked.
    let asana = match b.get("asana_token") {
        Some(v) => Some(check_asana_token(v).await?),
        None => None,
    };
    let c = s.db();
    let current = db::get_profile(&c, &id)?.ok_or_else(|| ApiError::not_found("profile"))?;
    let mut fields = pick(&b, &["default_model"]);
    if let Some(v) = b.get("name") {
        // Its name unchanged passes even if another profile has it in another case (allowed
        // before HA-37), since the profile form sends it with every save.
        let name = match v.as_str().map(str::trim) {
            Some(n) if n == current.name => n.to_string(),
            _ => check_profile_name(&c, Some(&id), v)?,
        };
        fields.push(("name", json!(name)));
    }
    if let Some((token, user)) = asana {
        fields.push(("asana_token", token));
        fields.push(("asana_user", user));
    }
    if let Some(v) = b.get("agent_access") {
        let name = fields.iter().find(|(k, _)| *k == "name").and_then(|(_, v)| v.as_str()).unwrap_or(&current.name);
        let access = check_agent_access(name, v)?;
        fields.push(("agent_access", json!(access)));
    }
    if let Some(v) = b.get("github_account") {
        fields.push(("github_account", check_github_account(v)?));
    }
    if let Some(v) = b.get("clone_dir") {
        fields.push(("clone_dir", check_clone_dir(v)?));
    }
    if let Some(v) = b.get("asana_enabled") {
        fields.push(("asana_enabled", json!(v.as_bool().ok_or_else(|| ApiError::bad("asana_enabled must be true or false"))?)));
    }
    for key in ["limit_wait", "limit_switch"] {
        if let Some(v) = b.get(key) {
            fields.push((key, json!(v.as_bool().ok_or_else(|| ApiError::bad(format!("{key} must be true or false")))?)));
        }
    }
    if let Some(v) = b.get("claude_config_ids") {
        let ids: Vec<String> = serde_json::from_value(v.clone()).map_err(|_| ApiError::bad("claude_config_ids must be a list of config ids"))?;
        fields.push(("claude_config_ids", json!(check_config_ids(&c, ids)?)));
    } else if let Some(dir) = b.get("claude_config_dir").and_then(Value::as_str) {
        // An older client changing the directory: switch the default to that directory's config.
        let first = db::config_for_dir(&c, &current.name, dir)?;
        let mut ids = vec![first.clone()];
        ids.extend(current.claude_config_ids.into_iter().filter(|x| *x != first));
        fields.push(("claude_config_ids", json!(ids)));
    }
    let p = db::update_profile(&c, &id, &fields)?.ok_or_else(|| ApiError::not_found("profile"))?;
    drop(c);
    s.emit(json!({"type": "profiles_changed"}));
    Ok(Json(json!(p)))
}

/// A profile's Asana token as it's stored, with who it's for (see asana.rs): null (or blank)
/// disconnects it, and a token is checked with Asana first.
async fn check_asana_token(v: &Value) -> ApiResult<(Value, Value)> {
    let token = match v {
        Value::Null => "",
        Value::String(t) => t.trim(),
        _ => return Err(ApiError::bad("asana_token must be null or a string")),
    };
    if token.is_empty() {
        return Ok((Value::Null, Value::Null));
    }
    let user = crate::asana::me(token).await.map_err(|e| ApiError::bad(e.to_string()))?;
    Ok((json!(token), json!(user.label())))
}

#[derive(Deserialize)]
struct AsanaSearch {
    #[serde(default)]
    q: String,
}

/// `GET /profiles/{id}/asana/tasks?q=`: the Asana tasks the profile's token finds for `q` (a
/// search, or a task's URL), for linking a task to one (API 57).
async fn asana_tasks(State(s): State<Shared>, Path(id): Path<String>, Query(q): Query<AsanaSearch>) -> ApiResult<Json<Value>> {
    let p = db::get_profile(&s.db(), &id)?.ok_or_else(|| ApiError::not_found("profile"))?;
    if !p.asana_enabled {
        return Err(ApiError::conflict(format!("Asana is turned off for the {} profile (Settings → Profiles)", p.name)));
    }
    let token = p.asana_token.filter(|t| !t.is_empty()).ok_or_else(|| ApiError::conflict(format!("the {} profile isn't connected to Asana", p.name)))?;
    match crate::asana::search(&token, &q.q).await {
        Ok(tasks) => Ok(Json(json!(tasks))),
        Err(crate::asana::Error::NotFound) if crate::asana::task_gid(q.q.trim()).is_some() => Ok(Json(json!([]))),
        Err(e) => Err(ApiError(StatusCode::BAD_GATEWAY, e.to_string())),
    }
}

/// A profile's or project's GitHub account as it's stored: null (or blank) for the default.
fn check_github_account(v: &Value) -> ApiResult<Value> {
    let account = match v {
        Value::Null => return Ok(Value::Null),
        Value::String(a) => a.trim(),
        _ => return Err(ApiError::bad("github_account must be null or a string")),
    };
    if account.is_empty() {
        return Ok(Value::Null);
    }
    if crate::gh_mcp::Account::parse(account).is_none() {
        return Err(ApiError::bad("github_account must be a GitHub login, or HOST/LOGIN for another GitHub host"));
    }
    Ok(json!(account))
}

/// The GitHub accounts gh is signed in to on this host (see gh_mcp::accounts).
async fn github_accounts() -> ApiResult<Json<Value>> {
    Ok(Json(json!(crate::gh_mcp::accounts().await)))
}

#[derive(Deserialize)]
struct GithubReposQuery {
    /// The GitHub account to act as (see `check_github_account`); gh's active one without it.
    account: Option<String>,
    /// Finds the repositories named like this, its organizations' too (see github::list).
    q: Option<String>,
}

/// The GitHub repositories an account can clone, for adding one as a project (API 55).
async fn github_repos(Query(q): Query<GithubReposQuery>) -> ApiResult<Json<Value>> {
    let account = check_github_account(&json!(q.account))?;
    Ok(Json(github::list(account.as_str(), q.q.as_deref()).await))
}

/// A profile's clone folder as it's stored: null (or blank) for the default, else a folder on
/// this host, absolute or in the home folder (`~/…`).
fn check_clone_dir(v: &Value) -> ApiResult<Value> {
    let dir = match v {
        Value::Null => return Ok(Value::Null),
        Value::String(d) => d.trim(),
        _ => return Err(ApiError::bad("clone_dir must be null or a string")),
    };
    if dir.is_empty() {
        return Ok(Value::Null);
    }
    if !expand_tilde(dir).is_absolute() {
        return Err(ApiError::bad("clone_dir must be an absolute path, or start with ~/"));
    }
    Ok(json!(dir))
}

/// A project's or task's base branch: null (or blank) for the default, else a name git takes for a
/// branch, as an agent may set it to anything.
async fn check_base_branch(v: &Value) -> ApiResult<Value> {
    let name = match v {
        Value::Null => return Ok(Value::Null),
        Value::String(b) => b.trim(),
        _ => return Err(ApiError::bad("base_branch must be null or a string")),
    };
    if name.is_empty() {
        return Ok(Value::Null);
    }
    if !worktree::valid_branch_name(name).await {
        return Err(ApiError::bad(format!("base_branch {name:?} isn't a valid branch name")));
    }
    Ok(json!(name))
}

/// Profile names whose agents may use a profile's board, tidied (`*` for every profile).
/// A profile's name, trimmed: required, and not another profile's in any case, as other profiles
/// grant access by name (see `check_agent_access`). `own` is the profile it's for, if it exists.
fn check_profile_name(c: &rusqlite::Connection, own: Option<&str>, v: &Value) -> ApiResult<String> {
    let name = v.as_str().map(str::trim).unwrap_or_default();
    if name.is_empty() {
        return Err(ApiError::bad("name is required"));
    }
    if let Some(p) = db::list_profiles(c)?.into_iter().find(|p| Some(p.id.as_str()) != own && p.name.eq_ignore_ascii_case(name)) {
        return Err(ApiError::conflict(format!("there's a profile named {} already", p.name)));
    }
    Ok(name.to_string())
}

fn check_agent_access(own_name: &str, v: &Value) -> ApiResult<Vec<String>> {
    let names: Vec<String> = serde_json::from_value(v.clone()).map_err(|_| ApiError::bad("agent_access must be a list of profile names"))?;
    let mut names: Vec<String> = names.into_iter().map(|n| n.trim().to_string()).filter(|n| !n.is_empty() && n != own_name).collect();
    names.sort();
    names.dedup();
    if names.iter().any(|n| n == "*") {
        names = vec!["*".into()];
    }
    Ok(names)
}

/// Config ids that exist, without repeats, in the order given.
fn check_config_ids(c: &rusqlite::Connection, ids: Vec<String>) -> ApiResult<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        if db::get_claude_config(c, &id)?.is_none() {
            return Err(ApiError::bad(format!("no Claude config {id}")));
        }
        if !out.contains(&id) {
            out.push(id);
        }
    }
    Ok(out)
}

/// A project's reviewers, with blank fields as None and each config checked.
fn check_reviewers(c: &rusqlite::Connection, list: Vec<db::Reviewer>) -> ApiResult<Vec<db::Reviewer>> {
    if list.len() > crate::review::MAX_REVIEWERS {
        return Err(ApiError::bad(format!("a project can have at most {} reviewers", crate::review::MAX_REVIEWERS)));
    }
    let blank = |v: Option<String>| v.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    let mut out = Vec::new();
    for r in list {
        let r = db::Reviewer { claude_config_id: blank(r.claude_config_id), model: blank(r.model), effort: blank(r.effort) };
        if let Some(id) = &r.claude_config_id {
            if db::get_claude_config(c, id)?.is_none() {
                return Err(ApiError::bad(format!("no Claude config {id}")));
            }
        }
        out.push(r);
    }
    Ok(out)
}

// ---------- Claude configs ----------

async fn list_claude_configs(State(s): State<Shared>) -> ApiResult<Json<Value>> {
    Ok(Json(json!(db::list_claude_configs(&s.db())?)))
}

#[derive(Deserialize)]
struct CreateClaudeConfig {
    name: String,
    #[serde(default)]
    config_dir: String,
    /// One of db::AGENTS (API 25); Claude Code by default.
    agent: Option<String>,
}

fn check_agent(agent: &str) -> ApiResult<()> {
    if !db::AGENTS.contains(&agent) {
        return Err(ApiError::bad(format!("agent must be one of {}", db::AGENTS.join(", "))));
    }
    Ok(())
}

async fn create_claude_config(State(s): State<Shared>, Json(b): Json<CreateClaudeConfig>) -> ApiResult<Json<Value>> {
    if b.name.trim().is_empty() {
        return Err(ApiError::bad("name is required"));
    }
    let agent = b.agent.as_deref().unwrap_or("claude");
    check_agent(agent)?;
    let cfg = db::insert_claude_config(&s.db(), b.name.trim(), &b.config_dir, agent)?;
    s.emit(json!({"type": "profiles_changed"}));
    Ok(Json(json!(cfg)))
}

async fn update_claude_config(State(s): State<Shared>, Path(id): Path<String>, Json(b): Json<Map<String, Value>>) -> ApiResult<Json<Value>> {
    let mut fields = pick(&b, &["name", "config_dir", "agent"]);
    for (k, v) in fields.iter_mut() {
        let t = v.as_str().ok_or_else(|| ApiError::bad(format!("{k} must be a string")))?.trim().to_string();
        if *k == "name" && t.is_empty() {
            return Err(ApiError::bad("name is required"));
        }
        *v = json!(t);
    }
    if let Some(v) = b.get("show_usage") {
        fields.push(("show_usage", json!(v.as_bool().ok_or_else(|| ApiError::bad("show_usage must be true or false"))?)));
    }
    let c = s.db();
    let current = db::get_claude_config(&c, &id)?.ok_or_else(|| ApiError::not_found("Claude config"))?;
    if let Some((_, agent)) = fields.iter().find(|(k, _)| *k == "agent") {
        let agent = agent.as_str().unwrap_or("");
        check_agent(agent)?;
        let sql = "SELECT COUNT(*) FROM tasks WHERE claude_config_id=?1 AND session_id IS NOT NULL";
        let started: i64 = c.query_row(sql, [&id], |r| r.get(0))?;
        if agent != current.agent && started > 0 {
            return Err(ApiError::conflict("threads have conversations in this config; add another config for the other agent"));
        }
    }
    let cfg = db::update_claude_config(&c, &id, &fields)?.ok_or_else(|| ApiError::not_found("Claude config"))?;
    drop(c);
    s.emit(json!({"type": "profiles_changed"}));
    Ok(Json(json!(cfg)))
}

async fn delete_claude_config(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    if db::get_claude_config(&s.db(), &id)?.is_none() {
        return Err(ApiError::not_found("Claude config"));
    }
    let running: i64 = s.db().query_row("SELECT COUNT(*) FROM tasks WHERE claude_config_id=?1 AND running=1", [&id], |r| r.get(0))?;
    if running > 0 {
        return Err(ApiError::conflict("agents are running with this config; stop them first"));
    }
    db::delete_claude_config(&s.db(), &id)?;
    s.usage.lock().unwrap().remove(&id);
    s.emit(json!({"type": "profiles_changed"}));
    Ok(Json(json!({"ok": true})))
}

/// Deletes a profile with its projects (see delete_project_inner), its threads in no project, and
/// its folder in the data dir.
async fn delete_profile(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    if db::get_profile(&s.db(), &id)?.is_none() {
        return Err(ApiError::not_found("profile"));
    }
    // Archived ones too.
    let projects = db::list_projects(&s.db(), &id)?;
    for p in projects {
        delete_project_inner(&s, &p.id).await?;
    }
    // Its scratch and group tasks, and their review threads.
    let rest: Vec<String> = {
        let c = s.db();
        let mut st = c.prepare("SELECT id FROM tasks WHERE profile_id=?1 ORDER BY kind='review' DESC, created_at")?;
        st.query_map([&id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?
    };
    for t in rest {
        // Review threads go first, so each is cleaned up on its own rather than in its task's
        // cascade. One may have been deleted meanwhile.
        let Some(t) = db::get_task(&s.db(), &t)? else { continue };
        delete_one(&s, &t, false).await?;
    }
    s.db().execute("DELETE FROM profiles WHERE id=?1", [&id])?;
    remove_unused_dir(&s, &s.data_dir.join("profiles").join(&id), "profile")?;
    s.emit(json!({"type": "profiles_changed"}));
    Ok(Json(json!({"ok": true})))
}

// ---------- projects ----------

#[derive(Deserialize)]
struct ProjectListQuery {
    /// Lists the archived projects instead of the others (API 46).
    #[serde(default)]
    archived: bool,
}

async fn list_projects(State(s): State<Shared>, Path(id): Path<String>, Query(q): Query<ProjectListQuery>) -> ApiResult<Json<Value>> {
    let list: Vec<db::Project> = db::list_projects(&s.db(), &id)?.into_iter().filter(|p| p.archived_at.is_some() == q.archived).collect();
    Ok(Json(json!(list)))
}

#[derive(Deserialize)]
pub struct CreateProject {
    #[serde(default)]
    pub name: String,
    pub repo_path: String,
    pub key: Option<String>,
    pub base_branch: Option<String>,
    pub use_worktrees: Option<bool>,
}

async fn create_project(State(s): State<Shared>, Path(profile_id): Path<String>, Json(b): Json<CreateProject>) -> ApiResult<Json<Value>> {
    Ok(Json(json!(create_project_inner(&s, &profile_id, b).await?)))
}

pub async fn create_project_inner(s: &Shared, profile_id: &str, b: CreateProject) -> ApiResult<db::Project> {
    if db::get_profile(&s.db(), profile_id)?.is_none() {
        return Err(ApiError::not_found("profile"));
    }
    let repo = expand_tilde(&b.repo_path);
    if !repo.exists() {
        // A new project folder: create it, but only somewhere unambiguous.
        if !repo.is_absolute() {
            return Err(ApiError::bad(format!("{} does not exist", repo.display())));
        }
        std::fs::create_dir_all(&repo).map_err(|e| ApiError::bad(format!("creating {}: {e}", repo.display())))?;
    }
    if !repo.is_dir() {
        return Err(ApiError::bad(format!("{} is not a directory", repo.display())));
    }
    let repo = repo.canonicalize().unwrap_or(repo);
    let is_git = worktree::is_git_repo(&repo).await;
    let base_branch = match check_base_branch(&json!(b.base_branch)).await?.as_str() {
        Some(b) => Some(b.to_string()),
        None if is_git => worktree::current_branch(&repo).await,
        None => None,
    };
    let name = if b.name.trim().is_empty() {
        repo.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "Project".into())
    } else {
        b.name.trim().to_string()
    };
    // Until it's stored, so no change takes its key meanwhile (see update_project_inner).
    let changing = s.project_changes.lock().await;
    let key = match b.key.filter(|k| !k.trim().is_empty()).map(|k| k.trim().to_uppercase()) {
        Some(k) if reserved(&k) => return Err(reserved_key(&k)),
        Some(k) => {
            check_key(s, profile_id, None, &k)?;
            k
        }
        None => new_project_key(s, profile_id, &name)?,
    };
    let id = new_id();
    let base = s.data_dir.join("projects").join(&id);
    let scratch = base.join("scratch");
    let worktrees = base.join("worktrees");
    std::fs::create_dir_all(&scratch).map_err(anyhow::Error::from)?;
    let p = db::insert_project(
        &s.db(),
        NewProject {
            id: &id,
            profile_id,
            name: &name,
            key: &key,
            repo_path: &path_str(&repo),
            scratch_path: &path_str(&scratch),
            worktrees_root: &path_str(&worktrees),
            base_branch: base_branch.as_deref(),
            // Kept for a folder that isn't a git repository yet, for when it becomes one.
            use_worktrees: b.use_worktrees.unwrap_or(true),
        },
    )?;
    drop(changing);
    let repo_root = relocate::fingerprint(&repo).await;
    let p = db::update_project(&s.db(), &p.id, &[("repo_root", json!(repo_root))])?.unwrap_or(p);
    s.emit(json!({"type": "project", "project": p}));
    Ok(p)
}

/// The key a new project named `name` gets on profile `profile_id` if it isn't given one. A
/// derived key steers clear of the group and scratch tasks' ones, and of the profile's projects' keys.
pub fn new_project_key(s: &Shared, profile_id: &str, name: &str) -> anyhow::Result<String> {
    let base = Some(derive_key(name)).filter(|k| !reserved(k)).unwrap_or_else(|| format!("{}P", derive_key(name)));
    let projects = db::list_projects(&s.db(), profile_id)?;
    Ok((1..).map(|n| if n == 1 { base.clone() } else { format!("{base}{n}") }).find(|k| key_owner(&projects, None, k).is_none()).unwrap_or(base))
}

#[derive(Deserialize)]
pub struct CloneProject {
    /// The GitHub repository, as `OWNER/REPO`.
    pub repo: String,
    /// Where to clone it to: by default a folder named after it in the profile's clone folder.
    pub repo_path: Option<String>,
    #[serde(default)]
    pub name: String,
    pub key: Option<String>,
}

async fn clone_project(State(s): State<Shared>, Path(profile_id): Path<String>, Json(b): Json<CloneProject>) -> ApiResult<Json<Value>> {
    Ok(Json(json!(clone_project_inner(&s, &profile_id, b, crate::gh_mcp::gh_program()).await?)))
}

/// Clones a GitHub repository with `gh` as the profile's GitHub account, and adds it as a project
/// (API 55). A clone of it that's where it would go already is added as it is, unless it's one of
/// the profile's projects already.
pub async fn clone_project_inner(s: &Shared, profile_id: &str, b: CloneProject, gh: String) -> ApiResult<db::Project> {
    let profile = db::get_profile(&s.db(), profile_id)?.ok_or_else(|| ApiError::not_found("profile"))?;
    let repo = github::check_repo(&b.repo).ok_or_else(|| ApiError::bad("repo must be a GitHub repository, as OWNER/REPO"))?;
    let dest = match b.repo_path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => expand_tilde(p),
        None => expand_tilde(&profile.clone_dir_or_default()).join(repo.split_once('/').map_or("", |(_, name)| name)),
    };
    if !dest.is_absolute() {
        return Err(ApiError::bad("repo_path must be an absolute path, or start with ~/"));
    }
    // A key that would stop the project being added stops the clone first (and is checked again then).
    let key = b.key.map(|k| k.trim().to_uppercase()).filter(|k| !k.is_empty());
    if let Some(k) = &key {
        if reserved(k) {
            return Err(reserved_key(k));
        }
        check_key(s, profile_id, None, k)?;
    }
    // Carries on without the request (the dialog closed, a hub gave up on a slow clone), so the
    // project is added once it's cloned.
    let job = tokio::spawn({
        let (s, profile_id) = (s.clone(), profile_id.to_string());
        async move {
            // Until the project is added, so a request for the folder meanwhile (the dialog opened
            // again) waits for this one, and then finds the project rather than a clone to add again.
            let _folder = github::reserve(&dest).await;
            let dir = github::folder(&dest);
            if let Some(p) = db::list_projects(&s.db(), &profile_id)?.into_iter().find(|p| std::path::Path::new(&p.repo_path) == dir) {
                return Err(ApiError::conflict(format!("{} is already the project \"{}\"", dest.display(), p.name)));
            }
            github::clone(&gh, profile.github_account.as_deref(), &repo, &dest).await.map_err(ApiError::bad)?;
            let b = CreateProject { name: b.name, repo_path: path_str(&dest), key, base_branch: None, use_worktrees: None };
            create_project_inner(&s, &profile_id, b).await
        }
    });
    job.await.map_err(|e| anyhow::anyhow!("cloning stopped: {e}"))?
}

async fn get_project(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let p = db::get_project(&s.db(), &id)?.ok_or_else(|| ApiError::not_found("project"))?;
    Ok(Json(json!(p)))
}

async fn update_project(State(s): State<Shared>, Path(id): Path<String>, Json(b): Json<Map<String, Value>>) -> ApiResult<Json<Value>> {
    Ok(Json(json!(update_project_inner(&s, &id, &b).await?)))
}

/// `move_repo: true` with a new `repo_path` moves the repository folder there; a `repo_path`
/// alone points the project at where its folder is now (see relocate.rs).
pub async fn update_project_inner(s: &Shared, id: &str, b: &Map<String, Value>) -> ApiResult<db::Project> {
    // One at a time: moving the folder takes a while, and meanwhile another change mustn't take
    // the key this one checked, or store old keys this one would overwrite.
    let _changing = s.project_changes.lock().await;
    let before = db::get_project(&s.db(), id)?.ok_or_else(|| ApiError::not_found("project"))?;
    let mut fields = project_fields(s, &before, b).await?;
    // Archiving is stored on its own, once the other changes check out (see archive).
    let mut archive_now = false;
    if let Some(i) = fields.iter().position(|(k, _)| *k == "archived") {
        let (_, archive) = fields.remove(i);
        let archive = archive.as_bool().ok_or_else(|| ApiError::bad("archived must be true or false"))?;
        if archive && before.archived_at.is_none() {
            archive_now = true;
        } else if !archive {
            fields.push(("archived_at", Value::Null));
        }
    }
    // The old key keeps naming the project's tasks (e.g. OS-2 after OS became OMS).
    if let Some((_, key)) = fields.iter().find(|(k, _)| *k == "key")
        && *key != json!(before.key)
    {
        let mut former = before.former_keys.clone();
        former.retain(|k| *key != json!(k) && *k != before.key);
        former.push(before.key.clone());
        fields.push(("former_keys", json!(json!(former).to_string())));
    }
    let move_repo = b.get("move_repo").and_then(Value::as_bool).unwrap_or(false);
    let new_repo = fields.iter().position(|(k, _)| *k == "repo_path").filter(|i| fields[*i].1 != json!(before.repo_path));
    if move_repo && new_repo.is_none() {
        return Err(ApiError::bad("move_repo needs a new repo_path to move the folder to"));
    }
    // Tried (and rolled back) before the folder moves, so a change that can't be stored doesn't
    // leave the folder somewhere the project doesn't say.
    db::preview_project_update(&s.db(), id, &fields)?.ok_or_else(|| ApiError::not_found("project"))?;
    if archive_now {
        archive(s, &before)?;
    }
    // Where the folder and what was in it are now, once they've moved.
    let mut relocated = Vec::new();
    // (Dropped before _changing, so agents waiting for the move see it done.)
    let _moving = new_repo.map(|_| relocate::Moving::new(s, id)).transpose()?;
    if let Some(i) = new_repo {
        let new = PathBuf::from(fields[i].1.as_str().unwrap_or_default());
        let moved = relocate::change(s, &before, &new, move_repo).await?;
        fields[i].1 = json!(moved.repo_path);
        relocated.push(("repo_path", json!(moved.repo_path)));
        relocated.push(("repo_root", json!(moved.repo_root)));
        // Folders kept inside the repository moved with it, unless they're being set too.
        for (k, v) in [("worktrees_root", moved.worktrees_root), ("scratch_path", moved.scratch_path)] {
            if let Some(v) = v {
                relocated.push((k, json!(v)));
            }
        }
        for (k, v) in &relocated {
            if !fields.iter().any(|(f, _)| f == k) {
                fields.push((k, v.clone()));
            }
        }
    }
    let p = match db::update_project(&s.db(), id, &fields) {
        Ok(p) => p.ok_or_else(|| ApiError::not_found("project"))?,
        Err(e) => {
            // The folder has moved all the same, so the project says where it is now.
            if !relocated.is_empty()
                && let Ok(Some(p)) = db::update_project(&s.db(), id, &relocated)
            {
                s.emit(json!({"type": "project", "project": p}));
            }
            return Err(e.into());
        }
    };
    s.emit(json!({"type": "project", "project": p}));
    if p.pr_preview_url != before.pr_preview_url
        && let Err(e) = follow_pr_previews(s, &before, &p)
    {
        tracing::error!(project = %p.id, "updating its tasks' preview URLs: {e:#}");
    }
    // Its tasks waiting for their dependencies or a merge slot while it was archived can go now.
    if before.archived_at.is_some() && p.archived_at.is_none() {
        runner::start_next_merge(s, Some(&p.id));
        runner::start_unblocked(s, Some(&p.id));
    }
    // The last of a group's projects to move to another group takes its group tasks along.
    if let Some(from) = before.group_name.as_deref().filter(|g| p.group_name.as_deref() != Some(g)) {
        let moved = db::rename_group_tasks(&s.db(), &p.profile_id, from, p.group_name.as_deref())?;
        for tid in moved {
            let t = db::get_task(&s.db(), &tid)?;
            if let Some(t) = t {
                s.emit_task(&t);
            }
        }
    }
    Ok(p)
}

/// Gives project `p`'s tasks their pull requests' previews from its new `pr_preview_url`, in
/// place of those from the old one (`before`'s). A preview URL set otherwise stays, and done
/// tasks without one get none: their previews are gone.
fn follow_pr_previews(s: &Shared, before: &db::Project, p: &db::Project) -> anyhow::Result<()> {
    let tasks = db::list_tasks_for_project(&s.db(), &p.id, "task")?;
    for t in tasks {
        let ours = match &t.preview_url {
            Some(_) => t.preview_url == before.preview_for(t.pr_url.as_deref()),
            None => t.status != "done",
        };
        let preview = p.preview_for(t.pr_url.as_deref());
        if ours && preview != t.preview_url {
            // Unless the task changed meanwhile.
            let unchanged = |c: &rusqlite::Connection| Ok(db::get_task(c, &t.id)?.is_some_and(|now| now.preview_url == t.preview_url && now.pr_url == t.pr_url));
            s.update_task_if(&t.id, &[("preview_url", json!(preview))], unchanged)?;
        }
    }
    Ok(())
}

/// Archives `p`, unless one of its agents is running: their tasks would be off the board.
/// Under the runs lock, which runner::start_run checks archived projects under, so no agent
/// starts in the project between the check and the change.
fn archive(s: &Shared, p: &db::Project) -> ApiResult<()> {
    let runs = s.runs.lock().unwrap();
    let c = s.db();
    let ids: Vec<String> = {
        let mut st = c.prepare("SELECT id FROM tasks WHERE project_id=?1").map_err(anyhow::Error::from)?;
        st.query_map([&p.id], |r| r.get(0)).and_then(|rows| rows.collect()).map_err(anyhow::Error::from)?
    };
    match ids.iter().filter(|id| runs.contains_key(*id)).count() {
        0 => {
            db::update_project(&c, &p.id, &[("archived_at", json!(crate::util::now()))])?;
            Ok(())
        }
        n => Err(ApiError::conflict(format!(
            "{n} of the project's agents {} running; stop {} before archiving it",
            if n == 1 { "is" } else { "are" },
            if n == 1 { "it" } else { "them" }
        ))),
    }
}

/// The project fields in `b`, checked and as they're stored, for a change to `before`.
/// `archived` stays as given, for update_project_inner to turn into `archived_at`.
pub async fn project_fields(s: &Shared, before: &db::Project, b: &Map<String, Value>) -> ApiResult<Vec<(&'static str, Value)>> {
    let mut fields = pick(
        b,
        &[
            "name", "key", "repo_path", "base_branch", "setup_script", "teardown_script", "status_script", "status_scripts", "use_worktrees", "permission_mode", "model",
            "worktrees_root", "auto_review", "review_rounds", "reviewers", "claude_config_ids", "start_prompt", "review_prompt", "merge_prompt", "group_name",
            "archived",
            "github_account",
            "done_when_merged",
            "watch_pull_requests",
            "pr_preview_url",
            "copy_files",
            "link_folders",
        ],
    );
    for (k, v) in fields.iter_mut() {
        match *k {
            // null (or blank) uses the default (see prompts.rs).
            "start_prompt" | "review_prompt" | "merge_prompt" => {
                if !(v.is_null() || v.is_string()) {
                    return Err(ApiError::bad(format!("{k} must be null or a string")));
                }
                let text = v.as_str().map(str::trim).unwrap_or_default();
                *v = if text.is_empty() { Value::Null } else { json!(text) };
            }
            // null (or blank) takes the project out of its group.
            "group_name" => {
                if !(v.is_null() || v.is_string()) {
                    return Err(ApiError::bad("group_name must be null or a string"));
                }
                let name = v.as_str().map(str::trim).unwrap_or_default();
                if name.chars().count() > 100 {
                    return Err(ApiError::bad("group_name can be at most 100 characters"));
                }
                *v = if name.is_empty() { Value::Null } else { json!(name) };
            }
            // null (or blank) uses the profile's.
            "github_account" => *v = check_github_account(v)?,
            // null (or blank) previews none.
            "pr_preview_url" => {
                let url = v.as_str().map(str::trim).unwrap_or_default();
                let ok = (url.starts_with("http://") || url.starts_with("https://")) && url.contains("{pr}");
                if !(v.is_null() || v.is_string()) || !(url.is_empty() || ok) {
                    return Err(ApiError::bad("pr_preview_url must be null or an http(s) URL with {pr} for the pull request's number"));
                }
                *v = if url.is_empty() { Value::Null } else { json!(url) };
            }
            // One per line; null is none.
            "copy_files" | "link_folders" => {
                if !(v.is_null() || v.is_string()) {
                    return Err(ApiError::bad(format!("{k} must be a string, one entry per line")));
                }
                let text = v.as_str().map(str::trim).unwrap_or_default();
                crate::worktree_files::check(k, text).map_err(ApiError::bad)?;
                *v = json!(text);
            }
            // null falls back to the host's default mode.
            "permission_mode" if !(v.is_null() || v.as_str().is_some_and(|m| PERMISSION_MODES.contains(&m))) => {
                return Err(ApiError::bad(format!("permission_mode must be null or one of {PERMISSION_MODES:?}")));
            }
            "repo_path" | "worktrees_root" => {
                let path = v.as_str().map(str::trim).unwrap_or_default();
                if path.is_empty() {
                    return Err(ApiError::bad(format!("{k} can't be empty")));
                }
                *v = json!(path_str(&expand_tilde(path)));
            }
            "base_branch" => *v = check_base_branch(v).await?,
            "name" => {
                let name = v.as_str().map(str::trim).unwrap_or_default();
                if name.is_empty() {
                    return Err(ApiError::bad("name can't be empty"));
                }
                if name.chars().count() > 100 {
                    return Err(ApiError::bad("name can be at most 100 characters"));
                }
                *v = json!(name);
            }
            "key" => {
                let key = v.as_str().unwrap_or("").trim().to_uppercase();
                if reserved(&key) {
                    return Err(reserved_key(&key));
                }
                if key != before.key {
                    check_key(s, &before.profile_id, Some(&before.id), &key)?;
                }
                *v = json!(key);
            }
            "watch_pull_requests" if !v.as_str().is_some_and(|m| crate::pr_watch::WATCH_MODES.contains(&m)) => {
                return Err(ApiError::bad(format!("watch_pull_requests must be one of {:?}", crate::pr_watch::WATCH_MODES)));
            }
            "use_worktrees" | "auto_review" | "done_when_merged" if !v.is_boolean() => {
                return Err(ApiError::bad(format!("{k} must be true or false")));
            }
            "review_rounds" if !v.as_u64().is_some_and(|n| n <= 20) => {
                return Err(ApiError::bad("review_rounds must be a whole number from 0 to 20"));
            }
            // null (or an empty list, or just one reviewer with the defaults) is one reviewer
            // with the task's config.
            "reviewers" => {
                let list: Option<Vec<db::Reviewer>> = serde_json::from_value(v.clone())
                    .map_err(|_| ApiError::bad("reviewers must be null or a list of {claude_config_id, model, effort}"))?;
                let list = list.map(|l| check_reviewers(&s.db(), l)).transpose()?.filter(|l| !l.is_empty() && *l != [db::Reviewer::default()]);
                *v = json!(list.map(|l| json!(l).to_string()));
            }
            // A script per status; null or a blank script is none.
            "status_scripts" => {
                let scripts: Option<BTreeMap<String, String>> =
                    serde_json::from_value(v.clone()).map_err(|_| ApiError::bad("status_scripts must be null or an object of status: script"))?;
                let mut scripts = scripts.unwrap_or_default();
                if let Some(bad) = scripts.keys().find(|k| !db::STATUSES.contains(&k.as_str())) {
                    return Err(ApiError::bad(format!("unknown status {bad:?} in status_scripts; statuses are {:?}", db::STATUSES)));
                }
                scripts.retain(|_, script| !script.trim().is_empty());
                *v = json!(json!(scripts).to_string());
            }
            // null (or an empty list) uses the profile's configs.
            "claude_config_ids" => {
                let ids: Option<Vec<String>> = serde_json::from_value(v.clone()).map_err(|_| ApiError::bad("claude_config_ids must be null or a list of config ids"))?;
                let ids = ids.map(|ids| check_config_ids(&s.db(), ids)).transpose()?.filter(|ids| !ids.is_empty());
                *v = json!(ids.map(|ids| json!(ids).to_string()));
            }
            _ => {}
        }
    }
    // A relative worktrees folder would be made against the server's folder but used by git from
    // the repository's, which puts worktrees in the main checkout; and it can't be the checkout.
    if let Some((_, root)) = fields.iter().find(|(k, _)| *k == "worktrees_root") {
        let root = PathBuf::from(root.as_str().unwrap_or_default());
        let repo = fields.iter().find(|(k, _)| *k == "repo_path").and_then(|(_, v)| v.as_str()).unwrap_or(&before.repo_path);
        if !root.is_absolute() {
            return Err(ApiError::bad("worktrees_root must be an absolute path, or start with ~/"));
        }
        let canon = |p: &std::path::Path| p.canonicalize().unwrap_or_else(|_| p.components().collect());
        if canon(&root) == canon(std::path::Path::new(repo)) {
            return Err(ApiError::bad("worktrees_root can't be the repository folder: give it a folder of its own"));
        }
    }
    Ok(fields)
}

/// A project's new key: letters and digits, and neither another of the profile's projects'
/// key nor one it had before, which its old task keys still use (a project may take back its own).
fn check_key(s: &Shared, profile_id: &str, project_id: Option<&str>, key: &str) -> ApiResult<()> {
    if key.is_empty() || key.len() > 10 || !key.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(ApiError::bad("the key must be 1 to 10 letters or digits"));
    }
    match key_owner(&db::list_projects(&s.db(), profile_id)?, project_id, key) {
        Some(other) if other.key.eq_ignore_ascii_case(key) => Err(ApiError::bad(format!("the project \"{}\" already has the key {key}", other.name))),
        Some(other) => Err(ApiError::bad(format!("the key {key} was the project \"{}\"'s, and its old task keys still use it", other.name))),
        None => Ok(()),
    }
}

/// Which of `projects`, other than `project_id`, has or had `key`.
fn key_owner<'a>(projects: &'a [db::Project], project_id: Option<&str>, key: &str) -> Option<&'a db::Project> {
    let uses = |p: &db::Project| p.key.eq_ignore_ascii_case(key) || p.former_keys.iter().any(|k| k.eq_ignore_ascii_case(key));
    projects.iter().find(|p| Some(p.id.as_str()) != project_id && uses(p))
}

/// Group tasks' keys are `G-<n>` and scratch tasks' `S-<n>`, so no project can have the key G or S.
fn reserved(key: &str) -> bool {
    key == runner::GROUP_TASK_KEY || key == db::SCRATCH_TASK_KEY
}

fn reserved_key(key: &str) -> ApiError {
    let by = if key == db::SCRATCH_TASK_KEY { "scratch tasks" } else { "group tasks" };
    ApiError::bad(format!("the key {key} is used by {by}; pick another"))
}

async fn delete_project(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    delete_project_inner(&s, &id).await?;
    Ok(Json(json!({"ok": true})))
}

/// Deletes a project with its tasks and their threads and worktrees (not their branches), and
/// its folder in the data dir.
pub async fn delete_project_inner(s: &Shared, id: &str) -> ApiResult<()> {
    let project = db::get_project(&s.db(), id)?.ok_or_else(|| ApiError::not_found("project"))?;
    // All its threads: tasks, review threads and any other kind.
    let tasks = db::project_threads(&s.db(), id)?;
    // Settled before the threads go, so the dialog asking about them (or this project) goes too.
    permissions::expire_for_project(s, id);
    let repo = PathBuf::from(&project.repo_path);
    let mut files = std::collections::HashSet::new();
    for t in &tasks {
        runner::abort(s, &t.id);
        permissions::expire_for_task(s, &t.id);
        terminal::kill_all(s, &t.id).await;
        files.extend(crate::attachments::of_task(&s.db(), &t.id)?);
        // Remove worktrees but keep branches so no committed work is lost.
        if let Some(wt) = &t.worktree_path {
            crate::checkpoints::forget(s, &t.id, &repo).await;
            let _ = worktree::git(&repo, &["worktree", "remove", "--force", wt]).await;
        }
    }
    if tasks.iter().any(|t| t.worktree_path.is_some()) {
        let _ = worktree::git(&repo, &["worktree", "prune"]).await;
    }
    let runs: Vec<String> = {
        let c = s.db();
        let mut st = c.prepare("SELECT r.id FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.project_id=?1")?;
        st.query_map([id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?
    };
    s.db().execute("DELETE FROM projects WHERE id=?1", [id])?;
    crate::runs::remove_finished(s, &runs);
    for t in &tasks {
        // Any agent asking to delete one is told it's gone (see tools::delete_task).
        permissions::expire_deletions_of(s, &t.id);
        crate::documents::remove(s, &t.id);
    }
    // Unless another task refers to them too.
    if let Err(e) = crate::attachments::remove_unreferenced(s, &files) {
        tracing::warn!("removing attachments while deleting project {id} failed: {e:#}");
    }
    remove_project_dir(s, id)?;
    s.emit(json!({"type": "project_deleted", "id": id}));
    Ok(())
}

/// Removes a deleted project's folder in the data dir (its scratch and worktrees folders, unless
/// they were moved, and its skills), unless what's left on the host is in it (see remove_unused_dir).
fn remove_project_dir(s: &Shared, id: &str) -> ApiResult<()> {
    remove_unused_dir(s, &s.data_dir.join("projects").join(id), "project")
}

/// Removes a deleted project's or profile's (`what`) folder in the data dir, unless what's left on
/// the host is in it: a repository, a worktree, or a folder another project or task was pointed at.
fn remove_unused_dir(s: &Shared, dir: &std::path::Path, what: &str) -> ApiResult<()> {
    let Ok(meta) = std::fs::symlink_metadata(dir) else { return Ok(()) };
    if !meta.is_dir() {
        return Ok(());
    }
    let canonical = |p: &std::path::Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    // A path that doesn't exist yet isn't resolved, so through a symlinked data dir it can only
    // match the folder as it's named.
    let roots = [canonical(dir), dir.to_path_buf()];
    let used: Vec<String> = {
        let c = s.db();
        let mut st = c.prepare(
            "SELECT repo_path FROM projects UNION SELECT scratch_path FROM projects UNION SELECT worktrees_root FROM projects
             UNION SELECT worktree_path FROM tasks WHERE worktree_path IS NOT NULL UNION SELECT work_dir FROM tasks WHERE work_dir IS NOT NULL",
        )?;
        st.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?
    };
    let inside = |p: &std::path::Path| p.is_absolute() && roots.iter().any(|r| canonical(p).starts_with(r) || p.starts_with(r));
    if let Some(p) = used.iter().map(PathBuf::from).find(|p| inside(p)) {
        tracing::warn!("keeping {} after deleting its {what}: {} is in it", dir.display(), p.display());
        return Ok(());
    }
    if let Err(e) = std::fs::remove_dir_all(dir) {
        tracing::warn!("removing {} after deleting its {what}: {e}", dir.display());
    }
    Ok(())
}

// ---------- tasks ----------

#[derive(Deserialize)]
struct TaskListQuery {
    kind: Option<String>,
}

async fn list_project_tasks(State(s): State<Shared>, Path(id): Path<String>, Query(q): Query<TaskListQuery>) -> ApiResult<Json<Value>> {
    let kind = q.kind.unwrap_or_else(|| "task".into());
    let c = s.db();
    if db::get_project(&c, &id)?.is_none() {
        return Err(ApiError::not_found("project"));
    }
    Ok(Json(json!(db::list_tasks_for_project(&c, &id, &kind)?)))
}

async fn list_profile_tasks(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(json!(db::list_tasks_for_profile(&s.db(), &id)?)))
}

async fn list_profile_scratch(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(json!(db::list_profile_scratch(&s.db(), &id)?)))
}

async fn list_group_tasks(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(json!(db::list_group_tasks(&s.db(), &id)?)))
}

#[derive(Deserialize, Default)]
pub struct CreateTask {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub status: Option<String>,
    /// How a done task ended (see db::RESOLUTIONS); only with status done.
    pub resolution: Option<String>,
    pub use_worktree: Option<bool>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub kind: Option<String>,
    /// Start an agent immediately; the string (if any) is sent as an extra prompt.
    pub start: Option<Value>,
    /// The subproject to add the task to (a task id).
    pub parent_id: Option<String>,
    /// Make the task a subproject.
    pub subproject: Option<bool>,
    /// The Claude config to run with, one of those its project (or profile) offers. Unset
    /// uses the first of them.
    pub claude_config_id: Option<String>,
    /// Tasks (ids) in the project that have to be merged before its agent starts.
    #[serde(default)]
    pub depends_on: Option<Vec<String>>,
    /// What the task is, if not a code task: one of db::TASK_TYPES. In a project, also
    /// `subproject` (db::SUBPROJECT), the same as `subproject: true`. One of db::LABELS (a task
    /// type before API 71) gives the task that label.
    #[serde(default)]
    pub task_type: Option<String>,
    /// Some of db::LABELS, each a document its agent writes besides its other work (see
    /// documents.rs).
    #[serde(default)]
    pub labels: Option<Value>,
    /// The tasks elsewhere it's for (see `check_external_links`).
    #[serde(default)]
    pub external_links: Option<Value>,
    /// Shared by the tasks made together from one prompt, each run by another agent (see
    /// db::Task::fanout_id).
    #[serde(default)]
    pub fanout_id: Option<String>,
}

/// A task's external links as they're stored (see db::ExternalLink): a list of
/// `{provider, id, url, title}`, each task once.
pub fn check_external_links(v: &Value) -> ApiResult<Value> {
    if v.is_null() {
        return Ok(json!([]));
    }
    let bad = |m: &str| ApiError::bad(format!("external_links {m}"));
    let links: Vec<db::ExternalLink> =
        serde_json::from_value(v.clone()).map_err(|_| bad("must be a list of {provider, id, url, title}"))?;
    let mut out: Vec<db::ExternalLink> = Vec::new();
    for mut l in links {
        l.provider = l.provider.trim().to_string();
        l.id = l.id.trim().to_string();
        l.url = l.url.trim().to_string();
        l.title = l.title.trim().chars().take(500).collect();
        if !db::LINK_PROVIDERS.contains(&l.provider.as_str()) {
            return Err(bad(&format!("provider must be one of {:?}", db::LINK_PROVIDERS)));
        }
        if l.id.is_empty() || l.id.len() > 100 {
            return Err(bad("need an id"));
        }
        if !(l.url.starts_with("https://") || l.url.starts_with("http://")) {
            return Err(bad("need an http(s) url"));
        }
        if !out.iter().any(|o| o.provider == l.provider && o.id == l.id) {
            out.push(l);
        }
    }
    if out.len() > db::MAX_LINKS {
        return Err(bad(&format!("can have at most {}", db::MAX_LINKS)));
    }
    Ok(json!(out))
}

/// The external links a new task asks for, as an update to make once it's created.
fn new_task_links(b: &CreateTask) -> ApiResult<Option<(&'static str, Value)>> {
    Ok(match &b.external_links {
        Some(v) if !v.is_null() => Some(("external_links", check_external_links(v)?)),
        _ => None,
    })
}

/// A new task's fanout id (blank for none): letters, digits, `-` and `_`, as an id is.
fn new_task_fanout(b: &CreateTask) -> ApiResult<Option<(&'static str, Value)>> {
    match b.fanout_id.as_deref().map(str::trim).filter(|f| !f.is_empty()) {
        Some(f) if f.len() > 64 || !f.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') => {
            Err(ApiError::bad("fanout_id must be up to 64 letters, digits, - or _"))
        }
        f => Ok(f.map(|f| ("fanout_id", json!(f)))),
    }
}

/// Check a new task's requested type (blank for none). A label (a type before API 71) is
/// none: see new_task_labels.
fn check_task_type(task_type: Option<&str>) -> ApiResult<Option<&str>> {
    match task_type.map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) if db::LABELS.contains(&t) => Ok(None),
        Some(t) if !db::TASK_TYPES.contains(&t) => Err(ApiError::bad(format!("task_type must be one of {:?}", db::TASK_TYPES))),
        t => Ok(t),
    }
}

/// The labels a new task asks for, as an update to make once it's created: its `labels`, and a
/// `task_type` that's one of them, as it was before API 71.
fn new_task_labels(b: &CreateTask) -> ApiResult<Option<(&'static str, Value)>> {
    let mut asked: Vec<Value> = match &b.labels {
        Some(Value::Array(a)) => a.clone(),
        Some(Value::Null) | None => Vec::new(),
        Some(_) => return Err(ApiError::bad("labels must be a list of strings")),
    };
    asked.extend(b.task_type.as_deref().map(str::trim).filter(|t| db::LABELS.contains(t)).map(|t| json!(t)));
    let labels = crate::documents::check_labels(&Value::Array(asked)).map_err(ApiError::bad)?;
    Ok((!labels.is_empty()).then(|| ("labels", json!(labels))))
}

async fn create_scratch_task(State(s): State<Shared>, Path(id): Path<String>, Json(b): Json<CreateTask>) -> ApiResult<Json<Value>> {
    Ok(Json(json!(create_scratch_task_inner(&s, &id, b)?)))
}

/// `POST /profiles/{id}/tasks`: a scratch task (see db::Task::is_scratch), which is in no
/// project. Without a title or description it's called "New scratch task".
pub fn create_scratch_task_inner(s: &Shared, profile_id: &str, b: CreateTask) -> ApiResult<db::Task> {
    if db::get_profile(&s.db(), profile_id)?.is_none() {
        return Err(ApiError::not_found("profile"));
    }
    if b.kind.as_deref().is_some_and(|k| k != "task") || check_task_type(b.task_type.as_deref())?.is_some_and(|t| t != db::SCRATCH) {
        return Err(ApiError::bad("a task in no project is a scratch task"));
    }
    if b.parent_id.is_some() || b.subproject == Some(true) || b.use_worktree == Some(true) || b.depends_on.as_ref().is_some_and(|d| !d.is_empty()) {
        return Err(ApiError::bad("a scratch task can't be a subproject, be in one, have a worktree or have dependencies"));
    }
    let generate_title = b.title.trim().is_empty() && !b.description.trim().is_empty();
    let title = match b.title.trim() {
        "" if generate_title => title::placeholder(&b.description),
        "" => "New scratch task".to_string(),
        t => t.to_string(),
    };
    let status = b.status.as_deref().unwrap_or("todo");
    if !STATUSES.contains(&status) {
        return Err(ApiError::bad(format!("status must be one of {STATUSES:?}")));
    }
    let resolution = b.resolution.as_deref().filter(|r| !r.is_empty());
    db::check_resolution(status, &json!(resolution)).map_err(ApiError::bad)?;
    let effort = b.effort.as_deref().filter(|e| !e.is_empty());
    if effort.is_some_and(|e| !db::THREAD_EFFORTS.contains(&e)) {
        return Err(ApiError::bad(format!("effort must be one of {:?}", db::THREAD_EFFORTS)));
    }
    let config = pick_config(&s.db(), profile_id, None, b.claude_config_id.as_deref())?;
    let links = new_task_links(&b)?;
    let fanout = new_task_fanout(&b)?;
    let labels = new_task_labels(&b)?;
    let t = db::insert_scratch_task(
        &s.db(),
        NewTask {
            profile_id,
            project_id: None,
            kind: "task",
            title: &title,
            description: &b.description,
            status,
            use_worktree: false,
            model: b.model.as_deref().filter(|m| !m.is_empty()),
            effort,
            claude_config_id: config.as_deref(),
        },
    )?;
    let fields: Vec<_> = resolution.map(|r| ("resolution", json!(r))).into_iter().chain(links).chain(fanout).chain(labels).collect();
    let t = db::update_task(&s.db(), &t.id, &fields)?.ok_or_else(|| ApiError::not_found("task"))?;
    s.emit_task(&t);
    let start = match b.start {
        Some(Value::Bool(true)) => Some(String::new()),
        Some(Value::String(p)) => Some(p),
        _ => None,
    };
    if generate_title {
        title::generate(s, &t, start);
        return Ok(t);
    }
    Ok(match start {
        Some(p) => runner::send(s, &t.id, &p)?,
        None => t,
    })
}

#[derive(Deserialize)]
struct CreateGroupTask {
    /// The group (of the profile's projects) the task plans for.
    group: String,
    #[serde(flatten)]
    task: CreateTask,
}

/// `POST /profiles/{id}/group-tasks`: a group task, which plans work across a group's projects
/// and creates their tasks (see db::Task::group_name).
async fn create_group_task(State(s): State<Shared>, Path(id): Path<String>, Json(b): Json<CreateGroupTask>) -> ApiResult<Json<Value>> {
    if db::get_profile(&s.db(), &id)?.is_none() {
        return Err(ApiError::not_found("profile"));
    }
    let group = b.group.trim();
    if group.is_empty() || db::group_projects(&s.db(), &id, group)?.is_empty() {
        return Err(ApiError::bad("group must name a group of the profile's projects"));
    }
    let b = b.task;
    if b.kind.as_deref().is_some_and(|k| k != "task") || b.parent_id.is_some() || b.subproject == Some(true) || b.depends_on.as_ref().is_some_and(|d| !d.is_empty()) {
        return Err(ApiError::bad("a group task can't be a subproject, be in one, or have dependencies"));
    }
    let generate_title = b.title.trim().is_empty() && !b.description.trim().is_empty();
    let title = match b.title.trim() {
        "" if generate_title => title::placeholder(&b.description),
        "" => return Err(ApiError::bad("title or description is required")),
        t => t.to_string(),
    };
    let status = b.status.as_deref().unwrap_or("todo");
    if !STATUSES.contains(&status) {
        return Err(ApiError::bad(format!("status must be one of {STATUSES:?}")));
    }
    let effort = b.effort.as_deref().filter(|e| !e.is_empty());
    if effort.is_some_and(|e| !db::THREAD_EFFORTS.contains(&e)) {
        return Err(ApiError::bad(format!("effort must be one of {:?}", db::THREAD_EFFORTS)));
    }
    let task_type = check_task_type(b.task_type.as_deref())?;
    if task_type == Some(db::SCRATCH) {
        return Err(ApiError::bad("a group task can't be a scratch task"));
    }
    let config = pick_config(&s.db(), &id, None, b.claude_config_id.as_deref())?;
    let fanout = new_task_fanout(&b)?;
    let links = new_task_links(&b)?;
    let labels = new_task_labels(&b)?;
    let t = db::insert_group_task(
        &s.db(),
        NewTask {
            profile_id: &id,
            project_id: None,
            kind: "task",
            title: &title,
            description: &b.description,
            status,
            use_worktree: false,
            model: b.model.as_deref().filter(|m| !m.is_empty()),
            effort,
            claude_config_id: config.as_deref(),
        },
        group,
    )?;
    let fields: Vec<_> = task_type.map(|tt| ("task_type", json!(tt))).into_iter().chain(links).chain(fanout).chain(labels).collect();
    let t = db::update_task(&s.db(), &t.id, &fields)?.ok_or_else(|| ApiError::not_found("task"))?;
    std::fs::create_dir_all(s.profile_scratch_dir(&id)).ok();
    s.emit_task(&t);
    let start = match b.start {
        Some(Value::Bool(true)) => Some(String::new()),
        Some(Value::String(p)) => Some(p),
        _ => None,
    };
    if generate_title {
        title::generate(&s, &t, start);
        return Ok(Json(json!(t)));
    }
    Ok(Json(json!(match start {
        Some(p) => runner::send(&s, &t.id, &p)?,
        None => t,
    })))
}

async fn create_task(State(s): State<Shared>, Path(project_id): Path<String>, Json(b): Json<CreateTask>) -> ApiResult<Json<Value>> {
    Ok(Json(json!(create_task_inner(&s, &project_id, b)?)))
}

pub fn create_task_inner(s: &Shared, project_id: &str, b: CreateTask) -> ApiResult<db::Task> {
    let project = db::get_project(&s.db(), project_id)?.ok_or_else(|| ApiError::not_found("project"))?;
    if project.archived_at.is_some() {
        return Err(ApiError::bad(format!("the project \"{}\" is archived; unarchive it in the board's settings first", project.name)));
    }
    let kind = b.kind.as_deref().unwrap_or("task");
    if kind != "task" {
        return Err(ApiError::bad("kind must be task"));
    }
    // A task described but not titled gets a placeholder now and a generated title shortly.
    let generate_title = b.title.trim().is_empty() && !b.description.trim().is_empty();
    let title = match b.title.trim() {
        "" if generate_title => title::placeholder(&b.description),
        "" => return Err(ApiError::bad("title or description is required")),
        t => t.to_string(),
    };
    let status = b.status.as_deref().unwrap_or("todo");
    if !STATUSES.contains(&status) {
        return Err(ApiError::bad(format!("status must be one of {STATUSES:?}")));
    }
    let resolution = b.resolution.as_deref().filter(|r| !r.is_empty());
    db::check_resolution(status, &json!(resolution)).map_err(ApiError::bad)?;
    // Held until the task is in its subproject, so one being deleted can't gain a task that
    // its deletion would take with it, unasked (see Deleting).
    let deleting = s.deleting.lock().unwrap();
    let parent = match b.parent_id.as_deref().filter(|p| !p.is_empty()) {
        Some(pid) => {
            if deleting.contains_key(pid) {
                return Err(ApiError::conflict("the subproject is being deleted"));
            }
            let p = db::get_task(&s.db(), pid)?.ok_or_else(|| ApiError::not_found("subproject"))?;
            if !p.subproject || p.project_id.as_deref() != Some(&project.id) {
                return Err(ApiError::bad("parent_id must be a subproject in the same project"));
            }
            if kind != "task" {
                return Err(ApiError::bad("only tasks can be added to a subproject"));
            }
            Some(p)
        }
        None => None,
    };
    // `subproject` is a task type too (API 51), though it's kept as the task's subproject flag.
    let as_subproject = b.task_type.as_deref().map(str::trim) == Some(db::SUBPROJECT);
    let subproject = b.subproject.unwrap_or(false) || as_subproject;
    if subproject && (kind != "task" || parent.is_some()) {
        return Err(ApiError::bad("only a top-level task can be a subproject"));
    }
    let task_type = if as_subproject { None } else { check_task_type(b.task_type.as_deref())? };
    if task_type.is_some() && (kind != "task" || subproject) {
        return Err(ApiError::bad("only a task that isn't a subproject can be a scratch task"));
    }
    let labels = new_task_labels(&b)?;
    if labels.is_some() && kind != "task" {
        return Err(ApiError::bad("only a task can have labels"));
    }
    // A subproject's branch is what its tasks branch from, so it and they work in worktrees. A
    // scratch task works in its own folder instead (see documents.rs).
    let use_worktree =
        kind == "task" && task_type.is_none() && (subproject || parent.is_some() || b.use_worktree.unwrap_or(project.use_worktrees && project.is_git));
    let effort = b.effort.as_deref().filter(|e| !e.is_empty());
    if effort.is_some_and(|e| !db::THREAD_EFFORTS.contains(&e)) {
        return Err(ApiError::bad(format!("effort must be one of {:?}", db::THREAD_EFFORTS)));
    }
    let config = pick_config(&s.db(), &project.profile_id, Some(&project), b.claude_config_id.as_deref())?;
    let depends_on = match b.depends_on.as_deref().filter(|ids| !ids.is_empty()) {
        Some(_) if kind != "task" => return Err(ApiError::bad("only tasks can have dependencies")),
        Some(ids) => Some(db::check_dependencies(&s.db(), None, Some(&project.id), ids).map_err(ApiError::bad)?),
        None => None,
    };
    let links = new_task_links(&b)?;
    let fanout = new_task_fanout(&b)?;
    let t = db::insert_task(
        &s.db(),
        NewTask {
            profile_id: &project.profile_id,
            project_id: Some(&project.id),
            kind,
            title: &title,
            description: &b.description,
            status,
            use_worktree,
            model: b.model.as_deref().filter(|m| !m.is_empty()),
            effort,
            claude_config_id: config.as_deref(),
        },
    )?;
    let mut fields = Vec::new();
    if let Some(r) = resolution {
        fields.push(("resolution", json!(r)));
    }
    if let Some(p) = &parent {
        fields.push(("parent_id", json!(p.id)));
        // Known once the subproject's worktree exists; otherwise worktree::setup works it out.
        if let Some(b) = &p.branch {
            fields.push(("base_branch", json!(b)));
        }
    }
    if subproject {
        fields.push(("subproject", json!(true)));
    }
    if let Some(ids) = &depends_on {
        fields.push(("depends_on", json!(ids)));
    }
    if let Some(tt) = task_type {
        fields.push(("task_type", json!(tt)));
    }
    fields.extend(labels);
    fields.extend(links);
    fields.extend(fanout);
    let t = db::update_task(&s.db(), &t.id, &fields)?.ok_or_else(|| ApiError::not_found("task"))?;
    drop(deleting);
    s.emit_task(&t);
    if let Some(p) = &parent {
        s.sync_subproject(&p.id)?;
    }
    let start = match b.start {
        Some(Value::Bool(true)) => Some(String::new()),
        Some(Value::String(p)) => Some(p),
        _ => None,
    };
    if generate_title {
        // Starts the agent once the title is in, since it names the branch.
        title::generate(s, &t, start);
        return Ok(t);
    }
    Ok(match start {
        Some(p) => runner::send(s, &t.id, &p)?,
        None => t,
    })
}

/// Check a new thread's requested Claude config against those it can use (None for the default).
pub fn pick_config(c: &rusqlite::Connection, profile_id: &str, project: Option<&db::Project>, id: Option<&str>) -> ApiResult<Option<String>> {
    let Some(id) = id.filter(|id| !id.is_empty()) else { return Ok(None) };
    if !db::available_configs(c, profile_id, project)?.iter().any(|cfg| cfg.id == id) {
        return Err(ApiError::bad("claude_config_id must be one of the project's (or profile's) Claude configs"));
    }
    Ok(Some(id.to_string()))
}

async fn get_task(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let c = s.db();
    let t = db::get_task(&c, &id)?.ok_or_else(|| ApiError::not_found("task"))?;
    let last = db::last_assistant_text(&c, &id)?;
    let pending: i64 = c.query_row(
        "SELECT COUNT(*) FROM permission_requests WHERE task_id=?1 AND status='pending'",
        [&id],
        |r| r.get(0),
    )?;
    Ok(Json(json!({"task": t, "last_message": last, "pending_permissions": pending})))
}

async fn update_task(State(s): State<Shared>, Path(id): Path<String>, Json(b): Json<Map<String, Value>>) -> ApiResult<Json<Value>> {
    Ok(Json(json!(update_task_inner(&s, &id, &b).await?)))
}

pub async fn update_task_inner(s: &Shared, id: &str, b: &Map<String, Value>) -> ApiResult<db::Task> {
    let current = db::get_task(&s.db(), id)?.ok_or_else(|| ApiError::not_found("task"))?;
    // A task with no changes to merge (and so no pull request) skips the merge and is done.
    let to_merge = b.get("status").and_then(Value::as_str) == Some("ready_for_merge") && current.status != "ready_for_merge" && current.kind == "task";
    // A scratch task, or one that makes only documents (which the board keeps), has nothing to merge.
    let own_folder = current.is_scratch() || crate::documents::documents_only(&current);
    let nothing_to_merge = to_merge && (own_folder || !worktree::has_work_to_merge(s, &current).await);
    let mut fields = pick(
        b,
        &[
            "title", "title_pinned", "description", "status", "resolution", "position", "use_worktree", "model", "effort", "base_branch", "permission_mode",
            "preview_url", "pr_url", "external_links", "subproject", "claude_config_id", "depends_on", "starred", "remind_at", "reminder", "done_at",
        ],
    );
    check_reminder(Some(&current), &mut fields)?;
    // A title is text that isn't blank, and a description is text (null clears it): anything else is
    // turned away rather than kept as JSON text, or left to the database to refuse with a 500.
    if let Some((_, v)) = fields.iter_mut().find(|(k, _)| *k == "title") {
        let title = v.as_str().map(str::trim).filter(|t| !t.is_empty()).ok_or_else(|| ApiError::bad("title must be a non-empty string"))?;
        *v = json!(title);
    }
    if let Some((_, v)) = fields.iter_mut().find(|(k, _)| *k == "description") {
        match v {
            Value::String(_) => {}
            Value::Null => *v = json!(""),
            _ => return Err(ApiError::bad("description must be a string")),
        }
    }
    // SQLite keeps a value of the wrong type as it is (text in a REAL column, say), and the row
    // can't be read back after: every list with the task in it would fail until it's repaired by hand.
    if fields.iter().any(|(k, v)| *k == "position" && !v.is_number()) {
        return Err(ApiError::bad("position must be a number"));
    }
    if fields.iter().any(|(k, v)| *k == "use_worktree" && !v.is_boolean()) {
        return Err(ApiError::bad("use_worktree must be true or false"));
    }
    if fields.iter().any(|(k, v)| *k == "model" && !(v.is_null() || v.is_string())) {
        return Err(ApiError::bad("model must be a string or null"));
    }
    if let Some((_, v)) = fields.iter_mut().find(|(k, _)| *k == "base_branch") {
        *v = check_base_branch(v).await?;
    }
    if let Some(v) = b.get("labels") {
        if current.kind != "task" {
            return Err(ApiError::bad("only a task can have labels"));
        }
        fields.push(("labels", json!(crate::documents::check_labels(v).map_err(ApiError::bad)?)));
    }
    if fields.iter().any(|(k, v)| *k == "title_pinned" && !v.is_boolean()) {
        return Err(ApiError::bad("title_pinned must be true or false"));
    }
    // A title renamed by hand stays as it is, rather than following the user's prompts (see
    // title::refresh), unless the same request says otherwise.
    if fields.iter().any(|(k, v)| *k == "title" && v.as_str() != Some(&current.title)) && !fields.iter().any(|(k, _)| *k == "title_pinned") {
        fields.push(("title_pinned", json!(true)));
    }
    let unpinned = current.title_pinned && fields.iter().any(|(k, v)| *k == "title_pinned" && *v == json!(false));
    // Without a project (a group task) there's no repository to branch from.
    if current.project_id.is_none() && fields.iter().any(|(k, v)| ["subproject", "use_worktree"].contains(k) && *v == json!(true)) {
        return Err(ApiError::bad("a task without a project can't have a worktree or be a subproject"));
    }
    // Nor does one that works in its own folder.
    if own_folder && fields.iter().any(|(k, v)| ["subproject", "use_worktree"].contains(k) && *v == json!(true)) {
        return Err(ApiError::bad("a scratch task, or one that makes only documents, can't have a worktree or be a subproject"));
    }
    if let Some(v) = fields.iter().find(|(k, _)| *k == "subproject").map(|(_, v)| v.clone()) {
        let on = v.as_bool().ok_or_else(|| ApiError::bad("subproject must be true or false"))?;
        if on && (current.kind != "task" || db::subproject_of(&s.db(), &current)?.is_some()) {
            return Err(ApiError::bad("only a top-level task can be a subproject"));
        }
        if !on && current.subproject && !db::subproject_tasks(&s.db(), id)?.is_empty() {
            return Err(ApiError::conflict("the subproject still has tasks; delete them first"));
        }
        // Its tasks branch from its branch, so it needs a worktree.
        if on && !current.use_worktree && current.worktree_state == "none" {
            fields.push(("use_worktree", json!(true)));
        }
    }
    for (k, v) in fields.iter_mut().filter(|(k, _)| ["preview_url", "pr_url"].contains(k)) {
        // Blank clears it.
        let url = v.as_str().map(str::trim).unwrap_or_default().to_string();
        let ok = v.is_null() || url.is_empty() || url.starts_with("http://") || url.starts_with("https://");
        if !ok || !(v.is_null() || v.is_string()) {
            return Err(ApiError::bad(format!("{k} must be null or an http(s) URL")));
        }
        *v = if url.is_empty() { Value::Null } else { json!(url) };
    }
    if let Some((_, v)) = fields.iter_mut().find(|(k, _)| *k == "external_links") {
        *v = check_external_links(v)?;
    }
    if let Some((_, v)) = fields.iter_mut().find(|(k, _)| *k == "effort") {
        // null (or blank) falls back to the host's default.
        if v.as_str() == Some("") {
            *v = Value::Null;
        }
        if !(v.is_null() || v.as_str().is_some_and(|e| db::THREAD_EFFORTS.contains(&e))) {
            return Err(ApiError::bad(format!("effort must be null or one of {:?}", db::THREAD_EFFORTS)));
        }
    }
    if let Some((_, v)) = fields.iter().find(|(k, _)| *k == "permission_mode") {
        // null falls back to the project's mode, then the host's.
        if !(v.is_null() || v.as_str().is_some_and(|m| PERMISSION_MODES.contains(&m))) {
            return Err(ApiError::bad(format!("permission_mode must be null or one of {PERMISSION_MODES:?}")));
        }
    }
    if let Some((_, v)) = fields.iter().find(|(k, _)| *k == "claude_config_id") {
        // Its conversation is kept in the config it started in, so it can only move before then.
        if current.session_id.is_some() || s.is_running(id) {
            return Err(ApiError::conflict("the agent has already started with its Claude config"));
        }
        let c = s.db();
        let project = current.project_id.as_deref().map(|p| db::get_project(&c, p)).transpose()?.flatten();
        let id = v.as_str().ok_or_else(|| ApiError::bad("claude_config_id must be a config id"))?;
        pick_config(&c, &current.profile_id, project.as_ref(), Some(id))?;
    }
    if let Some((_, v)) = fields.iter_mut().find(|(k, _)| *k == "depends_on") {
        if current.kind != "task" {
            return Err(ApiError::bad("only tasks can have dependencies"));
        }
        let ids: Vec<String> = serde_json::from_value(v.clone()).map_err(|_| ApiError::bad("depends_on must be a list of task ids"))?;
        *v = json!(db::check_dependencies(&s.db(), Some(&current.id), current.project_id.as_deref(), &ids).map_err(ApiError::bad)?);
    }
    if let Some((_, v)) = fields.iter().find(|(k, _)| *k == "resolution") {
        // Checked against where the task ends up; moving it in or out of done sets or clears
        // it (see db::update_task).
        let status = fields.iter().find(|(k, _)| *k == "status").and_then(|(_, v)| v.as_str()).unwrap_or(&current.status);
        db::check_resolution(status, v).map_err(ApiError::bad)?;
    }
    if let Some((_, v)) = fields.iter_mut().find(|(k, _)| *k == "done_at") {
        // When a done task was done, in UTC: the board archives it two days after (and a new time
        // brings it back from the archive). Moving a task into or out of done sets or clears it.
        let status = b.get("status").and_then(Value::as_str).unwrap_or(&current.status);
        if status != "done" {
            return Err(ApiError::bad("done_at can only be set on a done task"));
        }
        let at = v.as_str().and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok()).ok_or_else(|| ApiError::bad("done_at must be an RFC 3339 time"))?;
        *v = json!(at.with_timezone(&chrono::Utc).to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    }
    // A merging task's agent can step out of the merge queue to fix what the merge turned up,
    // and the task rejoins the queue when its run ends (see Task::remerge).
    let remerge = match b.get("remerge") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(on)) => *on,
        Some(_) => return Err(ApiError::bad("remerge must be true or false")),
    };
    // Its agent's run ending is what brings it back, so the agent has to be at work.
    if remerge && !(current.merging && s.is_running(id) && b.get("status").and_then(Value::as_str) == Some("in_progress")) {
        return Err(ApiError::bad("remerge only takes a task out of the merge queue while its agent is merging it, with status in_progress"));
    }
    // Moving a task to "Ready for merge" asks its agent to merge it, once no other task in its
    // project is merging. On a host that can't run agents it joins the queue all the same, and
    // its merge starts once they can (see runner::start_queued_merges).
    let mut merge = false;
    if let Some(v) = fields.iter().find(|(k, _)| *k == "status").map(|(_, v)| v.clone()) {
        let st = v.as_str().filter(|st| STATUSES.contains(st)).ok_or_else(|| ApiError::bad(format!("status must be one of {STATUSES:?}")))?;
        merge = st == "ready_for_merge" && current.status != st && current.kind == "task";
        if st != "needs_attention" {
            fields.push(("attention_reason", Value::Null));
        }
        // Only "In progress" holds a task queued for its dependencies.
        if st != "in_progress" && current.waiting {
            fields.push(("waiting", json!(false)));
        }
        // Anywhere but "Ready for merge" (or waiting on the user while merging) ends a merge.
        if merge || !["ready_for_merge", "needs_attention"].contains(&st) {
            fields.push(("merging", json!(merge)));
        }
        // Anywhere but "In progress" (or waiting on the user) drops its place to rejoin the queue (see db::update_task).
        if remerge {
            fields.push(("remerge", json!(true)));
        }
        // Moving it ends its agent's wait (see wait.rs), told so in the same write.
        if let Some(w) = current.agent_wait.clone().filter(|_| st != current.status) {
            fields.push(("agent_wait", json!(db::AgentWait { moved_to: Some(st.to_string()), ..w })));
        }
    }
    if fields.iter().any(|(k, _)| *k == "use_worktree" || *k == "base_branch") && current.worktree_state != "none" {
        return Err(ApiError::conflict("tear down the worktree before changing worktree settings"));
    }
    if merge && s.is_running(id) {
        return Err(ApiError::conflict("the agent is still running; wait for it to finish before moving the task to Ready for merge"));
    }
    if merge && nothing_to_merge {
        merge = false;
        fields.retain(|(k, _)| !["status", "merging", "position"].contains(k));
        fields.extend([("status", json!("done")), ("merging", json!(false))]);
        let why = if current.is_scratch() {
            "Nothing to merge (a scratch task has no repository), so it's done"
        } else if own_folder {
            "Nothing to merge (the board keeps the task's documents), so it's done"
        } else {
            "Nothing to merge (the task has no changes), so it's done"
        };
        s.add_event(id, "info", why, None);
    }
    // Moved without a position (e.g. by an agent), it joins the back of the merge queue.
    if merge && !fields.iter().any(|(k, _)| *k == "position") {
        let end = db::end_position(&s.db(), current.project_id.as_deref(), "ready_for_merge", "task")?;
        fields.push(("position", json!(end)));
    }
    // What was checked against the task as it was read is checked again under the lock the change
    // is made with, so that two requests at once can't both pass (and, say, both start a merge).
    let worktree_settings = fields.iter().any(|(k, _)| *k == "use_worktree" || *k == "base_branch");
    let config = fields.iter().any(|(k, _)| *k == "claude_config_id");
    let unsubproject = current.subproject && fields.iter().any(|(k, v)| *k == "subproject" && *v == json!(false));
    let mut refused = None;
    let still = |c: &rusqlite::Connection| -> anyhow::Result<bool> {
        let Some(now) = db::get_task(c, id)? else { return Ok(true) };
        let running = now.running || db::has_active_run(c, id)?;
        refused = if to_merge && now.status != current.status {
            Some(ApiError::conflict(format!("the task was moved to {} meanwhile", now.status)))
        } else if merge && running {
            Some(ApiError::conflict("the agent is still running; wait for it to finish before moving the task to Ready for merge"))
        } else if worktree_settings && now.worktree_state != "none" {
            Some(ApiError::conflict("tear down the worktree before changing worktree settings"))
        } else if config && (now.session_id.is_some() || running) {
            Some(ApiError::conflict("the agent has already started with its Claude config"))
        } else if remerge && !(now.merging && running) {
            Some(ApiError::bad("remerge only takes a task out of the merge queue while its agent is merging it, with status in_progress"))
        } else if unsubproject && !db::subproject_tasks(c, id)?.is_empty() {
            Some(ApiError::conflict("the subproject still has tasks; delete them first"))
        } else {
            None
        };
        Ok(refused.is_none())
    };
    let updated = s.update_task_if(id, &fields, still)?;
    if let Some(e) = refused {
        return Err(e);
    }
    let t = updated.ok_or_else(|| ApiError::not_found("task"))?;
    if remerge {
        s.add_event(id, "info", "Stepped out of the merge queue to make changes; it rejoins the queue when its agent is done", None);
    }
    if merge && !crate::runs::can_run_agents(s) {
        s.add_event(id, "warn", "Agents can't run on this host yet (no Claude Code or Codex found), so the task waits in the merge queue until they can", None);
    }
    // Unpinned, the title catches up with what the task is about now.
    if unpinned {
        title::refresh(s, id);
    }
    if fields.iter().any(|(k, _)| *k == "permission_mode") {
        permissions::apply_mode_to_pending(s, &t)?;
    }
    // Moved into "In progress" before what it depends on is merged, it's queued until it is.
    if t.status == "in_progress" && current.status != "in_progress" && t.kind == "task" && !t.waiting && !s.is_running(id) && crate::runs::can_run_agents(s) {
        let unmet = db::unmet_dependencies(&s.db(), &t)?;
        if !unmet.is_empty() {
            runner::wait_for_dependencies(s, &t, &unmet, Some(db::Queued::new("", false)))?;
        }
    }
    // Waiting for its old config's usage limit, it doesn't any more.
    if config {
        runner::config_changed(s, id);
    }
    // This may have merged a task others wait for, or dropped what this one waits for.
    if fields.iter().any(|(k, _)| ["status", "resolution", "depends_on"].contains(k)) {
        runner::start_unblocked(s, t.project_id.as_deref());
    }
    if fields.iter().any(|(k, _)| *k == "status") {
        // This may have queued a merge or ended one.
        runner::start_next_merge(s, t.project_id.as_deref());
        if t.status == "in_review" && current.status != "in_review" && t.kind == "task" {
            crate::review::on_in_review(s, &t);
        }
        // A finished task's terminal and tools aren't needed any more.
        if t.status == "done" && current.status != "done" {
            let (s, id) = (s.clone(), t.id.clone());
            tokio::spawn(async move { terminal::kill_all(&s, &id).await });
        }
        return db::get_task(&s.db(), id)?.ok_or_else(|| ApiError::not_found("task"));
    }
    Ok(t)
}

/// Longest a reminder's note can be.
const MAX_REMINDER: usize = 500;

/// The fields `check_reminder` takes.
pub const MARK_FIELDS: &[&str] = &["starred", "remind_at", "reminder"];

/// Checks `starred`, `remind_at` and `reminder` in an update of task `current` (None for one
/// about to be created), and puts the time in UTC. Clearing `remind_at` (null or blank) clears
/// the note too; a note needs a time.
pub fn check_reminder(current: Option<&db::Task>, fields: &mut Vec<(&str, Value)>) -> ApiResult<()> {
    if fields.iter().any(|(k, v)| *k == "starred" && !v.is_boolean()) {
        return Err(ApiError::bad("starred must be true or false"));
    }
    if let Some((_, v)) = fields.iter_mut().find(|(k, _)| *k == "remind_at") {
        let bad = || ApiError::bad("remind_at must be null or a time like 2026-05-01T09:00:00Z");
        *v = match v.as_str().map(str::trim) {
            None if v.is_null() => Value::Null,
            None => return Err(bad()),
            Some("") => Value::Null,
            Some(at) => {
                let t = chrono::DateTime::parse_from_rfc3339(at).map_err(|_| bad())?;
                json!(t.with_timezone(&chrono::Utc).to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
            }
        };
    }
    let timed = fields.iter().find(|(k, _)| *k == "remind_at").map_or(current.is_some_and(|t| t.remind_at.is_some()), |(_, v)| !v.is_null());
    match fields.iter_mut().find(|(k, _)| *k == "reminder") {
        Some((_, v)) => {
            let note = match v.as_str() {
                Some(n) => n.trim(),
                None if v.is_null() => "",
                None => return Err(ApiError::bad("reminder must be null or text")),
            };
            if note.chars().count() > MAX_REMINDER {
                return Err(ApiError::bad(format!("reminder must be at most {MAX_REMINDER} characters")));
            }
            if !note.is_empty() && !timed {
                return Err(ApiError::bad("a reminder needs remind_at, the time to remind you"));
            }
            *v = if note.is_empty() { Value::Null } else { json!(note) };
        }
        None if !timed && current.is_some_and(|t| t.reminder.is_some()) => fields.push(("reminder", Value::Null)),
        None => {}
    }
    Ok(())
}

#[derive(Deserialize)]
struct PreviewQuery {
    url: String,
}

/// Whether a task's preview URL answers 200. Checked from here rather than the browser,
/// which can't read the status of a cross-origin response.
async fn preview_status(Query(q): Query<PreviewQuery>) -> ApiResult<Json<Value>> {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    if !(q.url.starts_with("http://") || q.url.starts_with("https://")) {
        return Err(ApiError::bad("url must be http(s)"));
    }
    let http = CLIENT.get_or_init(|| reqwest::Client::builder().timeout(std::time::Duration::from_secs(5)).build().unwrap_or_default());
    Ok(Json(match http.get(&q.url).send().await {
        Ok(r) => json!({"up": r.status() == reqwest::StatusCode::OK, "status": r.status().as_u16()}),
        Err(e) => json!({"up": false, "status": null, "error": format!("{e}")}),
    }))
}

#[derive(Deserialize)]
struct DeleteQuery {
    #[serde(default)]
    delete_branch: bool,
}

async fn delete_task(State(s): State<Shared>, Path(id): Path<String>, Query(q): Query<DeleteQuery>) -> ApiResult<Json<Value>> {
    let t = db::get_task(&s.db(), &id)?.ok_or_else(|| ApiError::not_found("task"))?;
    delete_task_inner(&s, &t, q.delete_branch).await?;
    Ok(Json(json!({"ok": true})))
}

/// Delete task `t`, and if it's a subproject, its tasks.
pub async fn delete_task_inner(s: &Shared, t: &db::Task, delete_branch: bool) -> ApiResult<()> {
    let _deleting = Deleting::new(s, &t.id);
    // A subproject's tasks go with it.
    if t.subproject {
        let children = db::subproject_tasks(&s.db(), &t.id)?;
        for child in children {
            delete_one(s, &child, delete_branch).await?;
        }
    }
    delete_last(s, t, delete_branch).await
}

/// Marks a task as being deleted until it's dropped: no task can be added to it meanwhile (see
/// create_task_inner), since deleting it would take that task too (`parent_id` cascades), and
/// one added after its tasks were looked up would go without being stopped or torn down, or asked
/// about (see tools::delete_task).
pub struct Deleting<'a> {
    s: &'a Shared,
    id: String,
}

impl<'a> Deleting<'a> {
    pub fn new(s: &'a Shared, id: &str) -> Self {
        *s.deleting.lock().unwrap().entry(id.to_string()).or_default() += 1;
        Deleting { s, id: id.to_string() }
    }
}

impl Drop for Deleting<'_> {
    fn drop(&mut self) {
        let mut deleting = self.s.deleting.lock().unwrap();
        if let Some(n) = deleting.get_mut(&self.id) {
            *n -= 1;
            if *n == 0 {
                deleting.remove(&self.id);
            }
        }
    }
}

/// Delete task `t` once a subproject's tasks are gone, and catch up what it leaves behind: its
/// own subproject, and the merges and tasks it held up.
pub async fn delete_last(s: &Shared, t: &db::Task, delete_branch: bool) -> ApiResult<()> {
    delete_one(s, t, delete_branch).await?;
    let subproject = db::subproject_of(&s.db(), t)?;
    if let Some(sp) = subproject {
        s.sync_subproject(&sp.id)?;
    }
    runner::start_next_merge(s, t.project_id.as_deref());
    runner::start_unblocked(s, t.project_id.as_deref());
    Ok(())
}

/// Stop a task's agents, remove its worktree and delete it.
pub(crate) async fn delete_one(s: &Shared, t: &db::Task, delete_branch: bool) -> ApiResult<()> {
    runner::abort(s, &t.id);
    // Settled before the thread goes, so the dialog asking about them goes too.
    permissions::expire_for_task(s, &t.id);
    // Its review threads go with it.
    let reviews = db::review_threads(&s.db(), &t.id)?;
    for r in &reviews {
        runner::abort(s, &r.id);
        permissions::expire_for_task(s, &r.id);
    }
    terminal::kill_all(s, &t.id).await;
    let mut files = crate::attachments::of_task(&s.db(), &t.id)?;
    for r in &reviews {
        files.extend(crate::attachments::of_task(&s.db(), &r.id)?);
    }
    if t.worktree_path.is_some() {
        if let Err(e) = worktree::teardown(s, &t.id, true, delete_branch).await {
            tracing::warn!("teardown during delete failed: {e:#}");
        }
    }
    let runs = {
        let c = s.db();
        let mut st = c.prepare("SELECT id FROM runs WHERE task_id=?1")?;
        let mut runs = Vec::new();
        for id in std::iter::once(&t.id).chain(reviews.iter().map(|r| &r.id)) {
            runs.extend(st.query_map([id], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?);
        }
        runs
    };
    s.db().execute("DELETE FROM tasks WHERE id=?1", [&t.id])?;
    crate::runs::remove_finished(s, &runs);
    // Any agent asking to delete it is told it's gone (see tools::delete_task), so after that.
    permissions::expire_deletions_of(s, &t.id);
    crate::documents::remove(s, &t.id);
    let dependents = db::drop_dependency(&s.db(), &t.id)?;
    for id in dependents {
        if let Some(d) = db::get_task(&s.db(), &id)? {
            s.emit_task(&d);
        }
    }
    // Unless another task refers to them too.
    if let Err(e) = crate::attachments::remove_unreferenced(s, &files) {
        tracing::warn!("removing attachments during delete failed: {e:#}");
    }
    for r in reviews {
        s.emit(json!({"type": "task_deleted", "id": r.id, "project_id": r.project_id}));
    }
    s.emit(json!({"type": "task_deleted", "id": t.id, "project_id": t.project_id}));
    Ok(())
}

#[derive(Deserialize)]
struct MessagesQuery {
    before: Option<i64>,
    after: Option<i64>,
    limit: Option<usize>,
}

/// A thread's messages: all of them as a list, or with any of `before`, `after` (message ids) and
/// `limit`, one page of them (API 56, see db::message_page) as `{messages, more, subagents}`. The latest
/// page (without `before` or `after`) has, in `subagents`, what lists the subagents started before it.
/// Read on a blocking thread: a long thread takes a while, and the async workers serve everything else.
async fn list_messages(State(s): State<Shared>, Path(id): Path<String>, Query(q): Query<MessagesQuery>) -> ApiResult<Json<Value>> {
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
struct SendBody {
    #[serde(default)]
    text: String,
}

async fn send_message(State(s): State<Shared>, Path(id): Path<String>, Json(b): Json<SendBody>) -> ApiResult<Json<Value>> {
    let t = runner::send(&s, &id, &b.text)?;
    // The user's reply answers the questions the agent asked (see questions.rs).
    if !b.text.trim().is_empty() {
        crate::questions::replied(&s, &t.id);
    }
    Ok(Json(json!(t)))
}

/// Answer a question an agent asked with request_user_input, from its card (API 64): the answer
/// is sent as the user's message.
async fn answer_question(
    State(s): State<Shared>,
    Path((id, message_id)): Path<(String, i64)>,
    Json(b): Json<crate::questions::Answer>,
) -> ApiResult<Json<Value>> {
    let task = db::get_task(&s.db(), &id)?.ok_or_else(|| ApiError::not_found("task"))?;
    Ok(Json(json!(crate::questions::answer(&s, &task.id, message_id, b)?)))
}

/// Drop the queued message. Returns the task as it was, queued message included.
async fn unqueue_message(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(json!(runner::unqueue(&s, &id)?)))
}

/// Stop the thread's agent, and the task's review if one is in progress.
async fn stop_task(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let agent = runner::stop(&s, &id);
    let review = crate::review::stop(&s, &id);
    Ok(Json(json!({"stopped": agent || review})))
}

/// Review the task's work now (see review.rs).
async fn review_task(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let t = crate::review::start(&s, &id, true).await?;
    Ok(Json(json!(t)))
}

async fn setup_worktree(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    // Reviewers work in the worktree too.
    if worktree::agent_in_worktree(&s, &id) {
        return Err(ApiError::conflict("an agent is working in the worktree (the task's or a reviewer's); wait for it to finish or stop it"));
    }
    let t = worktree::setup(&s, &id).await.map_err(|e| ApiError::bad(format!("{e:#}")))?;
    Ok(Json(json!(t)))
}

#[derive(Deserialize, Default)]
struct TeardownBody {
    #[serde(default)]
    force: bool,
    #[serde(default)]
    delete_branch: bool,
}

async fn teardown_worktree(State(s): State<Shared>, Path(id): Path<String>, body: Option<Json<TeardownBody>>) -> ApiResult<Json<Value>> {
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
async fn system_prompt_preview(State(s): State<Shared>, Path(id): Path<String>, Query(q): Query<runner::PreviewOptions>) -> ApiResult<Json<Value>> {
    let project = db::get_project(&s.db(), &id)?.ok_or_else(|| ApiError::not_found("project"))?;
    let (text, codex, mode) = runner::preview(&s, &project, &q).await?;
    Ok(Json(json!({"text": text, "runtime": if codex { "codex" } else { "claude" }, "permission_mode": mode})))
}

/// Remove the worktrees of the project's done tasks that are merged and have nothing
/// uncommitted (see worktree::remove_if_merged): `{"results": [{task_id, number, title, removed,
/// detail}]}`, one for each done task that had a worktree.
async fn remove_merged_worktrees(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
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

async fn start_setup_thread(State(s): State<Shared>, Path(id): Path<String>, Json(b): Json<StartSetupThread>) -> ApiResult<Json<Value>> {
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

async fn task_diff(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(worktree::diff(&s, &id).await?))
}

/// Whether moving the task to Done would leave work of its unmerged (see worktree::unmerged).
async fn task_unmerged(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let t = db::get_task(&s.db(), &id)?.ok_or_else(|| ApiError::not_found("task"))?;
    Ok(Json(json!({"unmerged": worktree::unmerged(&s, &t).await})))
}

// ---------- terminal ----------

/// `?tool=<id>` picks one of the host's terminal tools instead of the task's shell.
#[derive(Deserialize)]
struct ToolQuery {
    tool: Option<String>,
}

fn find_tool(s: &Shared, id: Option<&str>) -> ApiResult<Option<terminal::Tool>> {
    let Some(id) = id.filter(|t| !t.is_empty()) else { return Ok(None) };
    let tool = terminal::tools(&s.db()).into_iter().find(|t| t.id == id);
    tool.map(Some).ok_or_else(|| ApiError::not_found("terminal tool"))
}

async fn terminal_status(State(s): State<Shared>, Path(id): Path<String>, Query(q): Query<ToolQuery>) -> ApiResult<Json<Value>> {
    let t = db::get_task(&s.db(), &id)?.ok_or_else(|| ApiError::not_found("task"))?;
    let tool = find_tool(&s, q.tool.as_deref())?;
    Ok(Json(terminal::status(&s, &t, tool.as_ref()).await))
}

async fn kill_terminal(State(s): State<Shared>, Path(id): Path<String>, Query(q): Query<ToolQuery>) -> ApiResult<Json<Value>> {
    if db::get_task(&s.db(), &id)?.is_none() {
        return Err(ApiError::not_found("task"));
    }
    // A tool that was removed from the settings can still be ended.
    terminal::kill(&s, &id, q.tool.as_deref().filter(|t| !t.is_empty())).await;
    Ok(Json(json!({"ok": true})))
}

/// The board still has this tool open: keep its session (see `terminal::start_reaper`).
async fn terminal_keepalive(State(s): State<Shared>, Path(id): Path<String>, Query(q): Query<ToolQuery>) -> ApiResult<Json<Value>> {
    let tool = q.tool.filter(|t| !t.is_empty()).ok_or_else(|| ApiError::bad("tool is required"))?;
    if db::get_task(&s.db(), &id)?.is_none() {
        return Err(ApiError::not_found("task"));
    }
    terminal::keepalive(&id, &tool);
    Ok(Json(json!({"ok": true})))
}

#[derive(Deserialize)]
struct TerminalQuery {
    cols: Option<u16>,
    rows: Option<u16>,
    tool: Option<String>,
}

async fn terminal_ws(State(s): State<Shared>, Path(id): Path<String>, Query(q): Query<TerminalQuery>, upgrade: WebSocketUpgrade) -> ApiResult<Response> {
    let t = db::get_task(&s.db(), &id)?.ok_or_else(|| ApiError::not_found("task"))?;
    if !terminal::available() {
        return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "tmux is not installed on this host".into()));
    }
    let tool = find_tool(&s, q.tool.as_deref())?;
    let size = |v: Option<u16>, d: u16| v.filter(|v| (2..=1000).contains(v)).unwrap_or(d);
    let (cols, rows) = (size(q.cols, 80), size(q.rows, 24));
    Ok(upgrade.on_upgrade(move |ws| terminal::serve(s, t, tool, cols, rows, ws)))
}

// ---------- permissions ----------

#[derive(Deserialize)]
struct PermissionsQuery {
    task_id: Option<String>,
}

/// Pending permission prompts (`?task_id=` for one task's), so scripts can answer them.
async fn list_permissions(State(s): State<Shared>, Query(q): Query<PermissionsQuery>) -> ApiResult<Json<Value>> {
    Ok(Json(json!(permissions::pending(&s, q.task_id.as_deref())?)))
}

#[derive(Deserialize)]
struct ResolveBody {
    decision: String,
    message: Option<String>,
    /// The answers to a question, or how a plan is approved or what to change in it (API 64).
    #[serde(flatten)]
    reply: permissions::Reply,
}

async fn resolve_permission(State(s): State<Shared>, Path(id): Path<String>, Json(b): Json<ResolveBody>) -> ApiResult<Json<Value>> {
    let allow = match b.decision.as_str() {
        "allow" | "allow_always" => true,
        "deny" => false,
        _ => return Err(ApiError::bad("decision must be allow, allow_always or deny")),
    };
    let status = permissions::answer(&s, &id, allow, b.decision == "allow_always", b.message, b.reply)?;
    Ok(Json(json!({"ok": true, "status": status})))
}

#[derive(Deserialize)]
struct ApprovalsQuery {
    /// Deletions too (API 58); older hosts ignore it and list project changes only.
    #[serde(default)]
    all: bool,
    /// Automations too (API 67).
    #[serde(default)]
    automations: bool,
}

/// Project changes (and with `?all=true`, task deletions, and with `?automations=true`,
/// automations) agents are waiting for the user to approve (see permissions::approve).
async fn project_approvals(State(s): State<Shared>, Query(q): Query<ApprovalsQuery>) -> ApiResult<Json<Value>> {
    Ok(Json(json!(permissions::pending_approvals(&s, q.all, q.automations)?)))
}

// ---------- host settings ----------

async fn get_settings(State(s): State<Shared>) -> ApiResult<Json<Value>> {
    let c = s.db();
    Ok(Json(json!({
        "default_model": db::get_setting(&c, "default_model")?,
        "default_effort": db::get_setting(&c, "default_effort")?,
        "default_permission_mode": db::get_setting(&c, "default_permission_mode")?,
        "scratch_host": db::get_setting(&c, "scratch_host")?,
        "terminal_tools": terminal::tools(&c),
        "public_url": db::get_setting(&c, "public_url")?,
        "release_prereleases": db::get_setting(&c, crate::release::PRERELEASES)?.as_deref() == Some("true"),
    })))
}

/// Agent defaults for this host: the model and permission mode (when nothing more specific is
/// set) and effort. Also, for a board that can't run agents itself, the linked host its
/// workspace scratch chats go to (`scratch_host`, a link id). And the TUI programs offered as
/// shortcuts in task terminals (`terminal_tools`, a list of `{id?, name, command}`). And the
/// address it's reached at from outside (`public_url`, API 63), which its automations' webhook
/// URLs are shown with. And whether release checks include prereleases (`release_prereleases`,
/// API 83), which checks again when it changes.
async fn update_settings(State(s): State<Shared>, Json(b): Json<Map<String, Value>>) -> ApiResult<Json<Value>> {
    // Null (or blank) clears a setting; a value of another type is a mistake, not a clearing.
    for key in ["default_model", "default_effort", "default_permission_mode", "scratch_host", "public_url"] {
        if b.get(key).is_some_and(|v| !(v.is_null() || v.is_string())) {
            return Err(ApiError::bad(format!("{key} must be a string or null")));
        }
    }
    if let Some(e) = b.get("default_effort").and_then(|v| v.as_str()).filter(|e| !e.is_empty()) {
        if !db::EFFORTS.contains(&e) {
            return Err(ApiError::bad(format!("default_effort must be one of {:?}", db::EFFORTS)));
        }
    }
    if let Some(m) = b.get("default_permission_mode").and_then(|v| v.as_str()).filter(|m| !m.is_empty()) {
        if !PERMISSION_MODES.contains(&m) {
            return Err(ApiError::bad(format!("default_permission_mode must be one of {PERMISSION_MODES:?}")));
        }
    }
    if let Some(h) = b.get("scratch_host").and_then(|v| v.as_str()).filter(|h| !h.is_empty()) {
        if db::get_link(&s.db(), h)?.is_none() {
            return Err(ApiError::bad("scratch_host must be a linked host"));
        }
    }
    let mut b = b;
    if let Some(v) = b.get("public_url").filter(|v| !v.is_null()) {
        let url = v.as_str().map(|u| u.trim().trim_end_matches('/')).ok_or_else(|| ApiError::bad("public_url must be a string"))?;
        if (!url.is_empty() && !(url.starts_with("https://") || url.starts_with("http://"))) || url.contains(char::is_whitespace) || url.len() > 500 {
            return Err(ApiError::bad("public_url must be an http(s) URL, like https://board.example.com"));
        }
        let url = url.to_string();
        b.insert("public_url".into(), json!(url));
    }
    let prereleases = match b.get(crate::release::PRERELEASES) {
        Some(v) if !(v.is_null() || v.is_boolean()) => return Err(ApiError::bad("release_prereleases must be true, false or null")),
        Some(v) => Some(v.as_bool() == Some(true)),
        None => None,
    };
    let tools = match b.get("terminal_tools").filter(|v| !v.is_null()) {
        Some(v) => Some(terminal::parse_tools(v).map_err(ApiError::bad)?),
        None => None,
    };
    for key in ["default_model", "default_effort", "default_permission_mode", "scratch_host", "public_url"] {
        if let Some(v) = b.get(key) {
            db::set_setting(&s.db(), key, v.as_str())?;
        }
    }
    if let Some(tools) = tools {
        let v = (!tools.is_empty()).then(|| json!(tools).to_string());
        db::set_setting(&s.db(), "terminal_tools", v.as_deref())?;
    }
    if let Some(on) = prereleases {
        if crate::release::prereleases(&s)? != on {
            db::set_setting(&s.db(), crate::release::PRERELEASES, on.then_some("true"))?;
            crate::release::check_soon(&s);
        }
    }
    s.emit(json!({"type": "settings_changed"}));
    get_settings(State(s)).await
}

// ---------- agent tools ----------

/// From an agent's MCP helper; may block (permission prompts) until the user answers.
async fn internal_mcp(State(s): State<Shared>, Json(call): Json<tools::McpCall>) -> Json<Value> {
    Json(match tools::handle_mcp(&s, call).await {
        Ok(v) => json!({"result": v}),
        Err(e) => json!({"error": e}),
    })
}

#[derive(Deserialize)]
struct RemoteTool {
    profile: String,
    #[serde(default)]
    args: Value,
    /// Original helper capability, absent on hosts before paginated task fields.
    #[serde(default)]
    task_fields: bool,
}

/// A board tool forwarded from an agent on another host.
async fn remote_tool(State(s): State<Shared>, Path(tool): Path<String>, Json(b): Json<RemoteTool>) -> Response {
    match tools::handle_remote(&s, &tool, &b.profile, b.args, b.task_fields).await {
        Ok(v) => Json(json!({"result": v})).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({"error": e}))).into_response(),
    }
}

/// `GET /claude-configs/{id}/models` (API 25): the models a Codex config offers, with their
/// efforts. Claude configs have none listed (the UI suggests Claude's aliases).
async fn claude_config_models(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let cfg = db::get_claude_config(&s.db(), &id)?.ok_or_else(|| ApiError::not_found("Claude config"))?;
    if !cfg.is_codex() {
        return Ok(Json(json!([])));
    }
    let models = crate::codex::models(cfg.dir()).await.map_err(|e| ApiError::bad(format!("couldn't list Codex models: {e:#}")))?;
    Ok(Json(json!(models)))
}

// ---------- Claude config (login + settings) transfer ----------

/// What makes a Claude config dir usable elsewhere. History, caches and snapshots stay put.
const CLAUDE_CONFIG_ENTRIES: &[&str] = &[
    ".credentials.json",
    ".claude.json",
    "settings.json",
    "settings.local.json",
    "CLAUDE.md",
    "keybindings.json",
    "agents",
    "commands",
    "skills",
    "plugins",
    "hooks",
    "output-styles",
];

/// The same for a Codex home. Sessions, logs and its databases stay put.
const CODEX_CONFIG_ENTRIES: &[&str] = &["auth.json", "config.toml", "AGENTS.md", "skills", "rules", "prompts"];

/// Where a config's files are, and which of them a copy takes.
struct ConfigFiles {
    dir: PathBuf,
    entries: &'static [&'static str],
    /// The file holding the login.
    login: &'static str,
}

fn config_path(dir: &str) -> PathBuf {
    expand_tilde(if dir.trim().is_empty() { "~/.claude" } else { dir })
}

fn claude_config_files(s: &Shared, id: &str) -> ApiResult<ConfigFiles> {
    let cfg = db::get_claude_config(&s.db(), id)?.ok_or_else(|| ApiError::not_found("Claude config"))?;
    Ok(if cfg.is_codex() {
        ConfigFiles { dir: expand_tilde(cfg.dir()), entries: CODEX_CONFIG_ENTRIES, login: "auth.json" }
    } else {
        ConfigFiles { dir: config_path(&cfg.config_dir), entries: CLAUDE_CONFIG_ENTRIES, login: ".credentials.json" }
    })
}

/// A profile's default config directory.
fn profile_config_files(s: &Shared, profile_id: &str) -> ApiResult<ConfigFiles> {
    let p = db::get_profile(&s.db(), profile_id)?.ok_or_else(|| ApiError::not_found("profile"))?;
    Ok(ConfigFiles { dir: config_path(&p.claude_config_dir), entries: CLAUDE_CONFIG_ENTRIES, login: ".credentials.json" })
}

async fn export_claude_config(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(export_config(claude_config_files(&s, &id)?).await?))
}

async fn import_claude_config(State(s): State<Shared>, Path(id): Path<String>, Json(b): Json<ImportConfig>) -> ApiResult<Json<Value>> {
    Ok(Json(import_config(claude_config_files(&s, &id)?, b)?))
}

async fn export_profile_config(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(export_config(profile_config_files(&s, &id)?).await?))
}

async fn import_profile_config(State(s): State<Shared>, Path(id): Path<String>, Json(b): Json<ImportConfig>) -> ApiResult<Json<Value>> {
    Ok(Json(import_config(profile_config_files(&s, &id)?, b)?))
}

async fn export_config(cf: ConfigFiles) -> ApiResult<Value> {
    let dir = cf.dir;
    let files: Vec<&str> = cf.entries.iter().copied().filter(|e| dir.join(e).exists()).collect();
    if files.is_empty() {
        return Err(ApiError::bad(format!("nothing to copy in {}", dir.display())));
    }
    let out = tokio::process::Command::new("tar")
        .arg("czf")
        .arg("-")
        .arg("-C")
        .arg(&dir)
        .args(&files)
        .output()
        .await
        .map_err(|e| ApiError::bad(format!("tar: {e}")))?;
    if !out.status.success() {
        return Err(ApiError::bad(format!("tar failed: {}", String::from_utf8_lossy(&out.stderr))));
    }
    Ok(json!({
        "archive": base64::engine::general_purpose::STANDARD.encode(&out.stdout),
        "files": files,
        "bytes": out.stdout.len(),
    }))
}

#[derive(Deserialize)]
struct ImportConfig {
    archive: String,
    #[serde(default)]
    overwrite: bool,
}

fn import_config(cf: ConfigFiles, b: ImportConfig) -> ApiResult<Value> {
    let dir = cf.dir;
    if dir.join(cf.login).exists() && !b.overwrite {
        return Err(ApiError::conflict(format!("{} already has a login; choose overwrite to replace it", dir.display())));
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(b.archive.trim()).map_err(|e| ApiError::bad(format!("bad archive: {e}")))?;
    std::fs::create_dir_all(&dir).map_err(anyhow::Error::from)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    let mut child = std::process::Command::new("tar")
        .arg("xzf")
        .arg("-")
        .arg("-C")
        .arg(&dir)
        .stdin(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| ApiError::bad(format!("tar: {e}")))?;
    child.stdin.take().unwrap().write_all(&bytes).map_err(anyhow::Error::from)?;
    let out = child.wait_with_output().map_err(anyhow::Error::from)?;
    if !out.status.success() {
        return Err(ApiError::bad(format!("tar failed: {}", String::from_utf8_lossy(&out.stderr))));
    }
    Ok(json!({"ok": true, "dir": path_str(&dir)}))
}

// ---------- server admin ----------

async fn server_status(State(s): State<Shared>) -> ApiResult<Json<Value>> {
    Ok(Json(admin::status(&s).await?))
}

#[derive(Deserialize)]
struct RestartBody {
    #[serde(default = "yes")]
    rebuild: bool,
}

fn yes() -> bool {
    true
}

async fn restart_server(State(s): State<Shared>, Json(b): Json<RestartBody>) -> ApiResult<Json<Value>> {
    admin::start(&s, b.rebuild)?;
    Ok(Json(json!({"ok": true})))
}

/// Check for releases now (with `--release-updates`), and return the server's status after.
async fn check_releases(State(s): State<Shared>) -> ApiResult<Json<Value>> {
    if s.meta.release.is_none() {
        return Err(ApiError::bad("this server doesn't check for releases (start it with --release-updates OWNER/REPO)"));
    }
    crate::release::check(&s).await;
    Ok(Json(admin::status(&s).await?))
}

#[derive(Deserialize)]
struct ReleaseUpdateBody {
    version: String,
}

/// Restart onto a release (staged, or downloaded first), as a restart job.
async fn update_to_release(State(s): State<Shared>, Json(b): Json<ReleaseUpdateBody>) -> ApiResult<Json<Value>> {
    crate::release::update(&s, &b.version)?;
    Ok(Json(json!({"ok": true})))
}

/// Mark the running release bad and restart onto the one before it, as a restart job.
async fn roll_back_release(State(s): State<Shared>) -> ApiResult<Json<Value>> {
    crate::release::rollback(&s)?;
    Ok(Json(json!({"ok": true})))
}

#[derive(Deserialize)]
struct UpdateBody {
    commit: String,
    /// With a bundle (a hub that has a checkout), update from it; otherwise fetch the
    /// commit from this host's own `origin` (API 3+).
    bundle: Option<String>,
    branch: Option<String>,
}

/// A hub asking this host to update to its commit.
async fn update_from_hub(State(s): State<Shared>, Json(b): Json<UpdateBody>) -> ApiResult<Json<Value>> {
    Ok(Json(match (&b.bundle, &b.branch) {
        (Some(bundle), Some(branch)) => admin::update_from_bundle(&s, branch, &b.commit, bundle).await?,
        _ => admin::update_from_origin(&s, &b.commit).await?,
    }))
}

// ---------- filesystem browser (for picking repos remotely) ----------

#[derive(Deserialize)]
struct DirsQuery {
    path: Option<String>,
}

async fn fs_dirs(Query(q): Query<DirsQuery>) -> ApiResult<Json<Value>> {
    let path = q
        .path
        .filter(|p| !p.trim().is_empty())
        .map(|p| expand_tilde(&p))
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("/"));
    // A missing folder is listed as empty, so the picker can offer to create it.
    if !path.exists() && path.is_absolute() {
        return Ok(Json(json!({
            "path": path_str(&path),
            "parent": path.parent().map(path_str),
            "exists": false,
            "is_git": false,
            "entries": [],
        })));
    }
    let mut entries = Vec::new();
    let rd = std::fs::read_dir(&path).map_err(|e| ApiError::bad(format!("{}: {e}", path.display())))?;
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let p = e.path();
        if p.is_dir() {
            // Hidden folders are included (flagged) so the picker can complete them.
            entries.push(json!({"name": name, "path": path_str(&p), "is_git": p.join(".git").exists(), "hidden": name.starts_with('.')}));
        }
    }
    entries.sort_by_key(|e| e["name"].as_str().unwrap_or("").to_lowercase());
    Ok(Json(json!({
        "path": path_str(&path),
        "parent": path.parent().map(path_str),
        "exists": true,
        "is_git": path.join(".git").exists(),
        "entries": entries,
    })))
}

// ---------- websocket ----------

async fn ws(State(s): State<Shared>, upgrade: WebSocketUpgrade) -> Response {
    upgrade.on_upgrade(move |socket| ws_loop(s, socket))
}

async fn ws_loop(s: Shared, mut socket: WebSocket) {
    let mut rx = s.events.subscribe();
    let _ = socket.send(WsMessage::Text(json!({"type": "hello"}).to_string().into())).await;
    loop {
        tokio::select! {
            ev = rx.recv() => match ev {
                Ok(v) => {
                    if socket.send(WsMessage::Text(v.to_string().into())).await.is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    // Client fell behind; ask it to refetch everything.
                    if socket.send(WsMessage::Text(json!({"type": "resync"}).to_string().into())).await.is_err() {
                        break;
                    }
                }
                Err(_) => break,
            },
            msg = socket.recv() => match msg {
                Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use tower::ServiceExt;

    /// Status and body (JSON, or the text if it isn't) of a request to `app`.
    pub(crate) async fn call(app: &Router, method: &str, path: &str) -> (u16, Value) {
        // The test state's token is empty.
        let req = Request::builder().method(method).uri(path).header("authorization", "Bearer ").body(axum::body::Body::empty()).unwrap();
        let res = app.clone().oneshot(req).await.unwrap();
        let status = res.status().as_u16();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into())))
    }

    #[test]
    fn unknown_api_routes_get_a_json_404_not_the_ui() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            // As in `serve`, which hands everything else to the UI.
            let app = router(s.clone()).fallback(|| async { "<!doctype html>" });
            assert_eq!(call(&app, "GET", "/board").await, (200, json!("<!doctype html>")));
            assert_eq!(call(&app, "GET", "/api/profiles").await, (200, json!([])));
            for (method, path, missing) in [
                ("GET", "/api/projects", "GET /api/projects"),
                ("POST", "/api/tasks?x=1", "POST /api/tasks"),
                ("GET", "/api/tasks/t1/nope", "GET /api/tasks/t1/nope"),
                ("GET", "/api/", "GET /api/"),
                ("GET", "/api", "GET /api"),
                // Through the hub, to this host.
                ("GET", "/api/h/h/projects", "GET /api/projects"),
                ("DELETE", "/api/h/h/profiles/p/nope", "DELETE /api/profiles/p/nope"),
            ] {
                assert_eq!(call(&app, method, path).await, (404, json!({"error": format!("no such API route: {missing}")})), "{method} {path}");
            }
            // A known route with the wrong method is still a 405.
            assert_eq!(call(&app, "DELETE", "/api/profiles").await, (405, json!({"error": "no such API route: DELETE /api/profiles"})));
            assert_eq!(call(&app, "DELETE", "/api/h/h/profiles").await, (405, json!({"error": "no such API route: DELETE /api/profiles"})));
        })
    }

    #[test]
    fn threads_are_listed_whole_or_in_pages() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let app = router(s.clone());
            let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
            let t = db::NewTask { profile_id: &profile.id, project_id: None, kind: "task", title: "t", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
            let t = db::insert_task(&s.db(), t).unwrap();
            let add = |data: Value| db::insert_message(&s.db(), &t.id, "claude", &data).unwrap().id;
            let call_id = add(json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "a1", "name": "Agent", "input": {}}]}}));
            let ids: Vec<i64> = (0..4).map(|i| add(json!({"type": "assistant", "message": {"content": [{"type": "text", "text": i.to_string()}]}}))).collect();
            let ids_of = |v: &Value| v.as_array().unwrap().iter().map(|m| m["id"].as_i64().unwrap()).collect::<Vec<_>>();

            // Without paging, a list (as hosts before API 56 answer), here and through the hub.
            for base in ["/api", "/api/h/h"] {
                let (status, all) = call(&app, "GET", &format!("{base}/tasks/{}/messages", t.id)).await;
                assert_eq!((status, all.as_array().map(Vec::len)), (200, Some(5)));
            }
            // The latest page, with the subagent started before it.
            let (_, page) = call(&app, "GET", &format!("/api/h/h/tasks/{}/messages?limit=2", t.id)).await;
            assert_eq!((ids_of(&page["messages"]), &page["more"]), (ids[2..].to_vec(), &json!(true)));
            assert_eq!(ids_of(&page["subagents"]), [call_id]);
            // Older ones, and newer ones than a message, without it.
            let (_, page) = call(&app, "GET", &format!("/api/tasks/{}/messages?before={}&limit=2", t.id, ids[2])).await;
            assert_eq!((ids_of(&page["messages"]), &page["more"], &page["subagents"]), (vec![ids[0], ids[1]], &json!(true), &json!([])));
            let (_, page) = call(&app, "GET", &format!("/api/tasks/{}/messages?after={}", t.id, ids[1])).await;
            assert_eq!((ids_of(&page["messages"]), &page["more"], &page["subagents"]), (ids[2..].to_vec(), &json!(false), &json!([])));
            assert_eq!(call(&app, "GET", &format!("/api/tasks/{}/messages?limit=x", t.id)).await.0, 400);
        })
    }

    #[test]
    fn checks_github_accounts() {
        assert_eq!(check_github_account(&json!(" octocat ")).unwrap(), json!("octocat"));
        assert_eq!(check_github_account(&json!("ghe.example.com/me")).unwrap(), json!("ghe.example.com/me"));
        assert_eq!(check_github_account(&json!("")).unwrap(), Value::Null);
        assert_eq!(check_github_account(&Value::Null).unwrap(), Value::Null);
        assert!(check_github_account(&json!("--user=x")).is_err());
        assert!(check_github_account(&json!(3)).is_err());
    }

    #[test]
    fn profiles_keep_their_github_account() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let create = |b: Value| create_profile(State(s.clone()), Json(serde_json::from_value(b).unwrap()));
            let Json(p) = create(json!({"name": "work", "github_account": " work-me "})).await.unwrap();
            assert_eq!(p["github_account"], "work-me");
            assert_eq!(db::get_profile(&s.db(), p["id"].as_str().unwrap()).unwrap().unwrap().github_account.as_deref(), Some("work-me"));
            let Json(other) = create(json!({"name": "personal"})).await.unwrap();
            assert_eq!(other["github_account"], Value::Null);
            assert!(create(json!({"name": "bad", "github_account": "--user=x"})).await.is_err());
            let id = p["id"].as_str().unwrap().to_string();
            let update = |b: Value| update_profile(State(s.clone()), Path(id.clone()), Json(b.as_object().unwrap().clone()));
            assert_eq!(update(json!({"github_account": "ghe.example.com/me"})).await.unwrap().0["github_account"], "ghe.example.com/me");
            assert_eq!(update(json!({"github_account": ""})).await.unwrap().0["github_account"], Value::Null);
        })
    }

    #[test]
    fn profiles_keep_their_clone_folder() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let create = |b: Value| create_profile(State(s.clone()), Json(serde_json::from_value(b).unwrap()));
            let Json(p) = create(json!({"name": "work", "clone_dir": " ~/src/work "})).await.unwrap();
            assert_eq!(p["clone_dir"], "~/src/work");
            let Json(p) = create(json!({"name": "personal"})).await.unwrap();
            assert_eq!((&p["clone_dir"], &p["asana_enabled"]), (&Value::Null, &json!(true)));
            assert_eq!(create(json!({"name": "home", "asana_enabled": false})).await.unwrap().0["asana_enabled"], false);
            for bad in [json!("src"), json!("~work"), json!(3)] {
                assert!(create(json!({"name": "bad", "clone_dir": bad})).await.is_err(), "{bad}");
            }
            let id = p["id"].as_str().unwrap().to_string();
            let update = |b: Value| update_profile(State(s.clone()), Path(id.clone()), Json(b.as_object().unwrap().clone()));
            assert_eq!(update(json!({"clone_dir": "/srv/repos"})).await.unwrap().0["clone_dir"], "/srv/repos");
            assert!(update(json!({"clone_dir": "repos"})).await.is_err());
            assert_eq!(update(json!({"name": "job"})).await.unwrap().0["clone_dir"], "/srv/repos", "kept when other fields change");
            let Json(p) = update(json!({"clone_dir": " "})).await.unwrap();
            assert_eq!(p["clone_dir"], Value::Null);
            assert_eq!(db::get_profile(&s.db(), &id).unwrap().unwrap().clone_dir_or_default(), "~/job");
        })
    }

    #[test]
    fn profiles_connect_to_asana_and_search_it() {
        crate::testing::run(async || {
            crate::asana::tests::fake().await;
            let s = crate::testing::state();
            let app = router(s.clone());
            let p = db::insert_profile(&s.db(), "work", &[], None).unwrap();
            let update = |b: Value| update_profile(State(s.clone()), Path(p.id.clone()), Json(b.as_object().unwrap().clone()));
            let search = format!("/api/profiles/{}/asana/tasks?q=fix", p.id);
            let (status, body) = call(&app, "GET", &search).await;
            assert_eq!((status, body["error"].as_str()), (409, Some("the work profile isn't connected to Asana")));

            // A token Asana turns down isn't kept.
            let err = update(json!({"asana_token": "nope"})).await.unwrap_err();
            assert_eq!(err.0, StatusCode::BAD_REQUEST);
            assert!(err.1.contains("didn't accept the token"), "{}", err.1);
            assert_eq!(db::get_profile(&s.db(), &p.id).unwrap().unwrap().asana_token, None);

            // One it takes is, with who it's for; the board sees only that.
            let Json(v) = update(json!({"asana_token": format!(" {} ", crate::asana::tests::TOKEN)})).await.unwrap();
            assert_eq!(v["asana_user"], "Ivy (ivy@example.com)");
            assert!(v.get("asana_token").is_none(), "{v}");
            assert_eq!(db::get_profile(&s.db(), &p.id).unwrap().unwrap().asana_token.as_deref(), Some(crate::asana::tests::TOKEN));
            let (_, list) = call(&app, "GET", "/api/profiles").await;
            assert!(!list.to_string().contains(crate::asana::tests::TOKEN));
            assert_eq!(update(json!({"name": "job"})).await.unwrap().0["asana_user"], "Ivy (ivy@example.com)", "kept when other fields change");

            let (status, found) = call(&app, "GET", &search).await;
            assert_eq!(status, 200);
            let names: Vec<&str> = found.as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
            assert_eq!(names, ["Fix signup", "Fix login"]);
            assert_eq!(found[0]["url"], "https://app.asana.com/0/1/1002");
            // Through the hub too, and a URL for a task the token can't see finds nothing.
            let (status, found) = call(&app, "GET", &format!("/api/h/h/profiles/{}/asana/tasks?q=https%3A%2F%2Fapp.asana.com%2F0%2F1%2F7777", p.id)).await;
            assert_eq!((status, found), (200, json!([])));

            // Turned off, it keeps its token but finds nothing, until it's turned on again.
            assert!(update(json!({"asana_enabled": "no"})).await.is_err());
            let Json(v) = update(json!({"asana_enabled": false})).await.unwrap();
            assert_eq!((&v["asana_enabled"], &v["asana_user"]), (&json!(false), &json!("Ivy (ivy@example.com)")));
            let (status, body) = call(&app, "GET", &search).await;
            assert_eq!((status, body["error"].as_str()), (409, Some("Asana is turned off for the job profile (Settings → Profiles)")));
            assert_eq!(update(json!({"name": "work"})).await.unwrap().0["asana_enabled"], false, "kept when other fields change");
            assert_eq!(update(json!({"asana_enabled": true})).await.unwrap().0["asana_enabled"], true);
            assert_eq!(call(&app, "GET", &search).await.0, 200);

            let Json(v) = update(json!({"asana_token": null})).await.unwrap();
            assert_eq!(v["asana_user"], Value::Null);
            assert_eq!(db::get_profile(&s.db(), &p.id).unwrap().unwrap().asana_token, None);
            assert_eq!(call(&app, "GET", &search).await.0, 409);
        })
    }

    #[test]
    fn a_tasks_fields_are_checked_for_type_before_theyre_stored() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let p = db::insert_profile(&s.db(), "p", &[], None).unwrap();
            let project = NewProject { id: "pr", profile_id: &p.id, name: "Web", key: "WEB", repo_path: "/src/web", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
            let project = db::insert_project(&s.db(), project).unwrap();
            let t = create_task_inner(&s, &project.id, serde_json::from_value(json!({"title": "Fix it", "description": "How"})).unwrap()).unwrap();
            let set = async |v: Value| update_task_inner(&s, &t.id, v.as_object().unwrap()).await;
            for bad in [
                json!({"title": null}),
                json!({"title": ""}),
                json!({"title": "  "}),
                json!({"title": {"a": 1}}),
                json!({"title": 7}),
                json!({"description": 42}),
                json!({"description": ["x"]}),
                // Stored as text in a REAL or INTEGER column, these would make the row unreadable.
                json!({"position": "top"}),
                json!({"position": null}),
                json!({"use_worktree": "yes"}),
                json!({"use_worktree": 1}),
                json!({"model": 3}),
                json!({"base_branch": ["main"]}),
            ] {
                let err = set(bad.clone()).await.unwrap_err();
                assert_eq!(err.0, StatusCode::BAD_REQUEST, "{bad}: {}", err.1);
            }
            // Nothing stuck: the task reads back as it was, in every list.
            let t = db::get_task(&s.db(), &t.id).unwrap().unwrap();
            assert_eq!((t.title.as_str(), t.description.as_str(), t.position, t.use_worktree), ("Fix it", "How", t.position, false));
            assert_eq!(db::list_tasks_for_project(&s.db(), &project.id, "task").unwrap().len(), 1);
            assert_eq!(set(json!({"position": 2.5, "use_worktree": true, "model": "haiku", "base_branch": null})).await.unwrap().position, 2.5);
            let t = set(json!({"title": " Fixed ", "description": null})).await.unwrap();
            assert_eq!((t.title.as_str(), t.description.as_str()), ("Fixed", ""));
        })
    }

    #[test]
    fn a_setting_of_the_wrong_type_is_refused_rather_than_cleared() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let set = async |v: Value| update_settings(State(s.clone()), Json(v.as_object().unwrap().clone())).await.map(|j| j.0);
            let out = set(json!({"default_model": "haiku", "default_effort": "high"})).await.unwrap();
            assert_eq!((out["default_model"].as_str(), out["default_effort"].as_str()), (Some("haiku"), Some("high")));
            for bad in [json!({"default_model": 123}), json!({"default_permission_mode": 5}), json!({"default_effort": ["high"]}), json!({"scratch_host": true})] {
                let err = set(bad.clone()).await.unwrap_err();
                assert_eq!(err.0, StatusCode::BAD_REQUEST, "{bad}: {}", err.1);
            }
            let out = set(json!({})).await.unwrap();
            assert_eq!((out["default_model"].as_str(), out["default_effort"].as_str()), (Some("haiku"), Some("high")), "nothing cleared");
            let out = set(json!({"default_model": null, "default_effort": ""})).await.unwrap();
            assert!(out["default_model"].is_null() && out["default_effort"].is_null(), "null and blank clear: {out}");
        })
    }

    #[test]
    fn tasks_link_to_asana_tasks() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let p = db::insert_profile(&s.db(), "p", &[], None).unwrap();
            let project = NewProject { id: "pr", profile_id: &p.id, name: "Web", key: "WEB", repo_path: "/src/web", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
            let project = db::insert_project(&s.db(), project).unwrap();
            let link = |id: &str, title: &str| json!({"provider": "asana", "id": id, "url": format!("https://app.asana.com/0/1/{id}"), "title": title});
            let body = |v: Value| serde_json::from_value::<CreateTask>(v).unwrap();

            let t = create_task_inner(&s, &project.id, body(json!({"title": "Fix it", "external_links": [link("1002", " Fix signup ")]}))).unwrap();
            assert_eq!(t.external_links, vec![db::ExternalLink { provider: "asana".into(), id: "1002".into(), url: "https://app.asana.com/0/1/1002".into(), title: "Fix signup".into() }]);
            assert!(create_task_inner(&s, &project.id, body(json!({"title": "x", "external_links": [{"provider": "jira", "id": "1", "url": "https://x"}]}))).is_err());
            let scratch = create_scratch_task_inner(&s, &p.id, body(json!({"title": "Ask", "external_links": [link("1", "One")]}))).unwrap();
            assert_eq!(scratch.external_links.len(), 1);
            assert!(create_task_inner(&s, &project.id, body(json!({"title": "Plain"}))).unwrap().external_links.is_empty());

            // Each task once, and only with an id and a web link.
            let set = async |v: Value| update_task_inner(&s, &t.id, json!({"external_links": v}).as_object().unwrap()).await;
            let t = set(json!([link("1002", "Fix signup"), link("2001", "Write docs"), link("1002", "again")])).await.unwrap();
            assert_eq!(t.external_links.iter().map(|l| l.id.as_str()).collect::<Vec<_>>(), ["1002", "2001"]);
            for bad in [json!("x"), json!([{"provider": "asana", "id": "", "url": "https://x"}]), json!([{"provider": "asana", "id": "1", "url": "javascript:x"}])] {
                assert!(set(bad.clone()).await.is_err(), "{bad}");
            }
            assert!(set(json!((0..=db::MAX_LINKS).map(|i| link(&i.to_string(), "t")).collect::<Vec<_>>())).await.is_err());
            assert!(set(Value::Null).await.unwrap().external_links.is_empty());
        })
    }

    #[test]
    fn cloning_adds_a_clone_thats_there_already_and_checks_what_it_can_first() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
            let dir = std::env::temp_dir().join(format!("ia-clone-{}", new_id()));
            let clone = |b: Value| clone_project(State(s.clone()), Path(profile.id.clone()), Json(serde_json::from_value(b).unwrap()));
            let path = |name: &str| path_str(&dir.join(name));
            let message = |r: ApiResult<Json<Value>>| r.unwrap_err().1;

            assert!(message(clone(json!({"repo": "nope"})).await).contains("OWNER/REPO"));
            assert!(message(clone(json!({"repo": "o/r", "repo_path": "rel/r"})).await).contains("absolute"));
            // A folder that's in the way isn't cloned into, nor taken for a clone.
            std::fs::create_dir_all(dir.join("full")).unwrap();
            std::fs::write(dir.join("full/notes.txt"), "mine").unwrap();
            assert!(message(clone(json!({"repo": "o/r", "repo_path": path("full")})).await).contains("already exists"));
            assert_eq!(std::fs::read_to_string(dir.join("full/notes.txt")).unwrap(), "mine");

            // A clone of the repository there already is added as it is, named after the folder.
            let r = dir.join("r");
            std::fs::create_dir_all(&r).unwrap();
            worktree::git(&r, &["init", "-q"]).await.unwrap();
            worktree::git(&r, &["remote", "add", "origin", "git@github.com:o/r.git"]).await.unwrap();
            let Json(p) = clone(json!({"repo": "o/r", "repo_path": path("r"), "key": "rr"})).await.unwrap();
            assert_eq!((p["name"].as_str(), p["key"].as_str(), p["repo_path"].as_str()), (Some("r"), Some("RR"), Some(path("r").as_str())));
            // But only once.
            let again = message(clone(json!({"repo": "o/r", "repo_path": format!("{}/", path("r"))})).await);
            assert!(again.contains("already the project \"r\""), "{again}");
            // Its key is checked before cloning anything.
            let taken = message(clone(json!({"repo": "o/other", "repo_path": path("other"), "key": "RR"})).await);
            assert!(taken.contains("already has the key RR"), "{taken}");
            assert!(message(clone(json!({"repo": "o/other", "repo_path": path("other"), "key": "S"})).await).contains("scratch tasks"));
            assert!(!dir.join("other").exists());
            assert!(message(clone_project(State(s.clone()), Path("nope".into()), Json(serde_json::from_value(json!({"repo": "o/r"})).unwrap())).await).contains("profile"));
            std::fs::remove_dir_all(&dir).unwrap();
        })
    }

    #[test]
    fn a_folder_being_cloned_into_waits_for_that_clone_and_isnt_added_twice() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
            let github = crate::github::tests::fake_github();
            let gh = path_str(&github.join("gh"));
            // Also as a path through a symlink to a folder above it, below which there's a folder
            // that isn't there until the clone makes it, and with the symlink after a folder that
            // isn't there and `..`.
            std::fs::create_dir_all(github.join("real")).unwrap();
            std::os::unix::fs::symlink(github.join("real"), github.join("alias")).unwrap();
            let paths = [("clones/slow", "clones/slow"), ("alias/new/slow", "real/new/slow"), ("missing/../alias/other/slow", "real/other/slow")];
            for (dest, folder) in paths {
                let dest = path_str(&github.join(dest));
                let clone = || clone_project_inner(&s, &profile.id, serde_json::from_value(json!({"repo": "o/slow", "repo_path": dest})).unwrap(), gh.clone());
                // The second comes while the first is cloning, with the folder a clone of it by then.
                let (first, second) = tokio::join!(clone(), async {
                    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                    clone().await
                });
                let folder = path_str(&github.join(folder));
                let projects: Vec<db::Project> = db::list_projects(&s.db(), &profile.id).unwrap().into_iter().filter(|p| p.repo_path == folder).collect();
                assert_eq!(projects.len(), 1, "{dest}");
                assert_eq!(first.unwrap().id, projects[0].id);
                let err = second.unwrap_err();
                assert_eq!(err.0, StatusCode::CONFLICT, "{dest}: {}", err.1);
                assert!(err.1.contains("already the project \"slow\""), "{}", err.1);
            }
            std::fs::remove_dir_all(&github).unwrap();
        })
    }

    #[test]
    fn tidies_agent_access() {
        assert_eq!(check_agent_access("work", &json!([" personal ", "work", "", "lab", "personal"])).unwrap(), ["lab", "personal"]);
        assert_eq!(check_agent_access("work", &json!(["lab", "*"])).unwrap(), ["*"]);
        assert!(check_agent_access("work", &json!("personal")).is_err());
    }

    #[test]
    fn worktrees_start_once_the_folder_is_a_git_repo() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
            let dir = std::env::temp_dir().join(format!("ia-api-{}", new_id()));
            let b = CreateProject { name: "x".into(), repo_path: path_str(&dir), key: None, base_branch: None, use_worktrees: None };
            let p = create_project_inner(&s, &profile.id, b).await.unwrap();
            assert!(p.use_worktrees && !p.is_git);
            let task = |title: &str| CreateTask { title: title.into(), ..Default::default() };
            assert!(!create_task_inner(&s, &p.id, task("before")).unwrap().use_worktree);

            assert!(std::process::Command::new("git").arg("init").arg("-q").arg(&dir).status().unwrap().success());
            assert!(create_task_inner(&s, &p.id, task("after")).unwrap().use_worktree);
            std::fs::remove_dir_all(&dir).ok();
        })
    }

    #[test]
    fn projects_watch_pull_requests_in_review_once_asked_to() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
            let dir = std::env::temp_dir().join(format!("ia-api-{}", new_id()));
            let b = CreateProject { name: "x".into(), repo_path: path_str(&dir), key: None, base_branch: None, use_worktrees: None };
            let p = create_project_inner(&s, &profile.id, b).await.unwrap();
            assert_eq!(p.watch_pull_requests, "off");
            let set = async |v: Value| update_project_inner(&s, &p.id, json!({ "watch_pull_requests": v }).as_object().unwrap()).await;
            for mode in ["failures", "all", "off"] {
                assert_eq!(set(json!(mode)).await.unwrap().watch_pull_requests, mode);
            }
            for bad in [json!("everything"), Value::Null, json!(true)] {
                assert!(set(bad).await.is_err());
            }
            std::fs::remove_dir_all(&dir).ok();
        })
    }

    /// A git repository with a commit on master, and a project on it: (folder, project).
    async fn git_project(s: &Shared) -> (PathBuf, db::Project) {
        let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let dir = std::env::temp_dir().join(format!("ia-api-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| assert!(std::process::Command::new("git").arg("-C").arg(&dir).args(["-c", "user.name=t", "-c", "user.email=t@t"]).args(args).status().unwrap().success());
        git(&["init", "-q", "-b", "master"]);
        git(&["commit", "-q", "--allow-empty", "-m", "first"]);
        let b = CreateProject { name: "x".into(), repo_path: path_str(&dir), key: Some("X".into()), base_branch: None, use_worktrees: None };
        (dir.clone(), create_project_inner(s, &profile.id, b).await.unwrap())
    }

    // HA-42: a relative worktrees_root put worktrees in the main checkout, and base branches weren't checked.
    #[test]
    fn worktree_settings_are_checked() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (dir, p) = git_project(&s).await;
            let set = async |v: Value| update_project_inner(&s, &p.id, v.as_object().unwrap()).await;
            for bad in [
                json!({"worktrees_root": "worktrees"}),
                json!({"worktrees_root": "./w"}),
                json!({"worktrees_root": path_str(&dir)}),
                json!({"worktrees_root": format!("{}/", path_str(&dir))}),
                json!({"worktrees_root": format!("{}/../{}", path_str(&dir), dir.file_name().unwrap().to_string_lossy())}),
                json!({"base_branch": "a..b"}),
                json!({"base_branch": "-x"}),
                json!({"base_branch": "@{-1}"}),
                json!({"base_branch": "with space"}),
                json!({"base_branch": "main.lock"}),
                json!({"base_branch": 3}),
            ] {
                let err = set(bad.clone()).await.unwrap_err();
                assert_eq!(err.0, StatusCode::BAD_REQUEST, "{bad}: {}", err.1);
            }
            let p2 = db::get_project(&s.db(), &p.id).unwrap().unwrap();
            assert_eq!((p2.worktrees_root.as_str(), p2.base_branch.as_deref()), (p.worktrees_root.as_str(), Some("master")));
            let inside = dir.join(".worktrees");
            let p2 = set(json!({"worktrees_root": path_str(&inside), "base_branch": " feature/x "})).await.unwrap();
            assert_eq!((p2.worktrees_root, p2.base_branch.as_deref()), (path_str(&inside), Some("feature/x")));
            assert_eq!(set(json!({"base_branch": ""})).await.unwrap().base_branch, None);

            // A task's too, which its agent may set.
            let t = create_task_inner(&s, &p.id, CreateTask { title: "x".into(), ..Default::default() }).unwrap();
            let task = async |v: Value| update_task_inner(&s, &t.id, v.as_object().unwrap()).await;
            for bad in ["a..b", "-x", "HEAD:x", "x~1"] {
                assert_eq!(task(json!({"base_branch": bad})).await.unwrap_err().0, StatusCode::BAD_REQUEST, "{bad}");
            }
            assert_eq!(task(json!({"base_branch": "release/1.2"})).await.unwrap().base_branch.as_deref(), Some("release/1.2"));
            assert_eq!(task(json!({"base_branch": " "})).await.unwrap().base_branch, None);
            let b = CreateProject { name: "y".into(), repo_path: path_str(&dir), key: Some("Y".into()), base_branch: Some("no..pe".into()), use_worktrees: None };
            assert_eq!(create_project_inner(&s, &p.profile_id, b).await.unwrap_err().0, StatusCode::BAD_REQUEST);
            std::fs::remove_dir_all(&dir).ok();
        })
    }

    // HA-42: setting up or tearing down a worktree checked only the task's own agent, not its reviewers'.
    #[test]
    fn a_worktree_isnt_torn_down_or_set_up_under_a_reviewer() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (dir, p) = git_project(&s).await;
            let t = create_task_inner(&s, &p.id, CreateTask { title: "x".into(), ..Default::default() }).unwrap();
            let t = worktree::setup(&s, &t.id).await.unwrap();
            let r = NewTask { profile_id: &t.profile_id, project_id: t.project_id.as_deref(), kind: "review", title: "Review", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
            let r = db::insert_task(&s.db(), r).unwrap();
            db::update_task(&s.db(), &r.id, &[("parent_id", json!(t.id)), ("running", json!(true))]).unwrap();
            let teardown = async || teardown_worktree(State(s.clone()), Path(t.id.clone()), None).await;
            assert_eq!(teardown().await.unwrap_err().0, StatusCode::CONFLICT);
            assert_eq!(setup_worktree(State(s.clone()), Path(t.id.clone())).await.unwrap_err().0, StatusCode::CONFLICT);
            assert!(std::path::Path::new(t.worktree_path.as_deref().unwrap()).exists());
            db::update_task(&s.db(), &r.id, &[("running", json!(false))]).unwrap();
            assert_eq!(teardown().await.unwrap().0["worktree_state"], "none");
            std::fs::remove_dir_all(&dir).ok();
        })
    }

    // HA-42: moved to Ready for merge where agents couldn't run, a task never joined the merge queue.
    #[test]
    fn ready_for_merge_queues_the_merge_even_before_agents_can_run() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (dir, p) = git_project(&s).await;
            let t = create_task_inner(&s, &p.id, CreateTask { title: "x".into(), ..Default::default() }).unwrap();
            let t = worktree::setup(&s, &t.id).await.unwrap();
            let wt = PathBuf::from(t.worktree_path.as_deref().unwrap());
            assert!(std::process::Command::new("git").arg("-C").arg(&wt).args(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "work"]).status().unwrap().success());
            assert!(!crate::runs::can_run_agents(&s));
            let t = update_task_inner(&s, &t.id, json!({"status": "ready_for_merge"}).as_object().unwrap()).await.unwrap();
            assert_eq!((t.status.as_str(), t.merging), ("ready_for_merge", true));
            assert_eq!(db::queued_merges(&s.db(), Some(&p.id), None).unwrap().len(), 1);
            std::fs::remove_dir_all(&dir).ok();
        })
    }

    #[test]
    fn a_folder_not_ready_for_worktrees_gets_one_setup_thread() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
            let dir = std::env::temp_dir().join(format!("ia-api-{}", new_id()));
            let b = CreateProject { name: "x".into(), repo_path: path_str(&dir), key: None, base_branch: None, use_worktrees: None };
            let p = create_project_inner(&s, &profile.id, b).await.unwrap();
            assert!(!p.is_git && !p.has_commits && p.setup_task_id.is_none());
            // This host can't run agents, so its agent doesn't start, but the thread is kept to try again from.
            let e = start_setup_thread_inner(&s, &p.id, StartSetupThread { message: "Use trunk".into() }).await.unwrap_err();
            assert!(e.1.contains("can't run agents"), "{}", e.1);
            let p = db::get_project(&s.db(), &p.id).unwrap().unwrap();
            let id = p.setup_task_id.clone().unwrap();
            let t = db::get_task(&s.db(), &id).unwrap().unwrap();
            assert_eq!((t.project_id.as_deref(), t.use_worktree, t.task_type.as_deref()), (Some(p.id.as_str()), false, None));
            assert!(t.description.contains("isn't a git repository yet") && t.description.contains(&p.repo_path), "{}", t.description);
            // Asked again (from another tab, say), it's the same thread.
            crate::runs::TEST_CAN_RUN.set(true);
            assert_eq!(start_setup_thread_inner(&s, &p.id, StartSetupThread::default()).await.unwrap().id, id);
            assert_eq!(db::list_tasks_for_project(&s.db(), &p.id, "task").unwrap().len(), 1);
            crate::runs::TEST_CAN_RUN.set(false);

            let git = |args: &[&str]| assert!(std::process::Command::new("git").arg("-C").arg(&dir).args(args).status().unwrap().success());
            git(&["init", "-q"]);
            let p = db::get_project(&s.db(), &p.id).unwrap().unwrap();
            assert!(p.is_git && !p.has_commits);
            git(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"]);
            assert!(db::get_project(&s.db(), &p.id).unwrap().unwrap().has_commits);
            // One that's ready gets no new thread.
            db::update_project(&s.db(), &p.id, &[("setup_task_id", Value::Null)]).unwrap();
            let e = start_setup_thread_inner(&s, &p.id, StartSetupThread::default()).await.unwrap_err();
            assert!(e.1.contains("ready for worktrees already"), "{}", e.1);
            std::fs::remove_dir_all(&dir).ok();
        })
    }

    #[test]
    fn tasks_get_their_pull_requests_previews() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let p = db::insert_profile(&s.db(), "p", &[], None).unwrap();
            let project = NewProject { id: "pr", profile_id: &p.id, name: "Web", key: "WEB", repo_path: "/src/web", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
            let project = db::insert_project(&s.db(), project).unwrap();
            let body = |v: Value| serde_json::from_value::<CreateTask>(v).unwrap();
            let task = |title: &str| create_task_inner(&s, &project.id, body(json!({"title": title}))).unwrap().id;
            let update = async |id: &str, v: Value| update_task_inner(&s, id, v.as_object().unwrap()).await.unwrap();
            let set = async |v: Value| update_project_inner(&s, &project.id, json!({"pr_preview_url": v}).as_object().unwrap()).await;
            let preview = |id: &str| db::get_task(&s.db(), id).unwrap().unwrap().preview_url;
            let pr = |n: u32| json!(format!("https://github.com/o/web/pull/{n}"));

            // Before the project has one, from the pull requests they already had.
            let (open, own, done, none) = (task("Open"), task("Own"), task("Done"), task("No PR"));
            update(&open, json!({"pr_url": pr(4)})).await;
            update(&own, json!({"pr_url": pr(5), "preview_url": "https://staging.example.com/"})).await;
            update(&done, json!({"pr_url": pr(6), "status": "done"})).await;
            assert_eq!(preview(&open), None);
            for bad in [json!("https://pr.example.com/"), json!("pr{pr}.example.com"), json!(3)] {
                assert!(set(bad.clone()).await.is_err(), "{bad}");
            }
            assert_eq!(set(json!(" https://pr{pr}.example.com/b ")).await.unwrap().pr_preview_url.as_deref(), Some("https://pr{pr}.example.com/b"));
            assert_eq!(preview(&open).as_deref(), Some("https://pr4.example.com/b"));
            // One set otherwise stays, a done task's preview is gone, and without a PR there's none.
            assert_eq!(preview(&own).as_deref(), Some("https://staging.example.com/"));
            assert_eq!((preview(&done), preview(&none)), (None, None));

            // Its new pull request's, from then on.
            update(&none, json!({"pr_url": pr(7)})).await;
            assert_eq!(preview(&none).as_deref(), Some("https://pr7.example.com/b"));
            update(&none, json!({"pr_url": pr(8)})).await;
            assert_eq!(preview(&none).as_deref(), Some("https://pr8.example.com/b"));
            s.update_task(&task("Found"), &[("pr_url", pr(9))]).unwrap();
            let found = db::list_tasks_for_project(&s.db(), &project.id, "task").unwrap().into_iter().find(|t| t.title == "Found").unwrap();
            assert_eq!(found.preview_url.as_deref(), Some("https://pr9.example.com/b"));
            update(&none, json!({"pr_url": ""})).await;
            assert_eq!(preview(&none), None);
            update(&own, json!({"pr_url": pr(10)})).await;
            assert_eq!(preview(&own).as_deref(), Some("https://staging.example.com/"));
            // One given with it wins.
            update(&none, json!({"pr_url": pr(11), "preview_url": "https://mine.example.com/"})).await;
            assert_eq!(preview(&none).as_deref(), Some("https://mine.example.com/"));

            // Changing it moves those it made, and clearing it takes them off.
            set(json!("https://{pr}.preview.example.com/")).await.unwrap();
            assert_eq!(preview(&open).as_deref(), Some("https://4.preview.example.com/"));
            assert_eq!(preview(&own).as_deref(), Some("https://staging.example.com/"));
            assert_eq!(preview(&none).as_deref(), Some("https://mine.example.com/"));
            assert_eq!(set(json!("")).await.unwrap().pr_preview_url, None);
            assert_eq!((preview(&open), preview(&found.id)), (None, None));
            assert_eq!(preview(&own).as_deref(), Some("https://staging.example.com/"));
            update(&open, json!({"pr_url": pr(12)})).await;
            assert_eq!(preview(&open), None);
        })
    }

    #[test]
    fn groups_projects() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
            let dir = std::env::temp_dir().join(format!("ia-api-{}", new_id()));
            let b = CreateProject { name: "x".into(), repo_path: path_str(&dir), key: None, base_branch: None, use_worktrees: None };
            let p = create_project_inner(&s, &profile.id, b).await.unwrap();
            assert_eq!(p.group_name, None);
            let set = async |v: Value| update_project_inner(&s, &p.id, json!({ "group_name": v }).as_object().unwrap()).await;
            assert_eq!(set(json!("  Work  ")).await.unwrap().group_name.as_deref(), Some("Work"));
            assert_eq!(db::get_project(&s.db(), &p.id).unwrap().unwrap().group_name.as_deref(), Some("Work"));
            assert_eq!(set(json!(" ")).await.unwrap().group_name, None);
            set(json!("Work")).await.unwrap();
            assert_eq!(set(Value::Null).await.unwrap().group_name, None);
            assert!(set(json!(3)).await.is_err());
            assert!(set(json!("x".repeat(101))).await.is_err());
            std::fs::remove_dir_all(&dir).ok();
        })
    }

    #[test]
    fn scratch_tasks_are_in_no_project_and_work_in_their_own_folder() {
        crate::testing::run(async || {
            crate::runs::TEST_CAN_RUN.set(true);
            let s = crate::testing::state();
            let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
            let t = create_scratch_task_inner(&s, &profile.id, CreateTask::default()).unwrap();
            assert_eq!((t.title.as_str(), t.number, t.project_id.as_deref(), t.is_scratch()), ("New scratch task", 1, None, true));
            assert_eq!(runner::task_key_prefix(&s, &t), "S");
            let t2 = create_scratch_task_inner(&s, &profile.id, CreateTask { title: "Notes".into(), task_type: Some("scratch".into()), ..Default::default() }).unwrap();
            assert_eq!(t2.number, 2);
            assert_eq!(crate::documents::work_dir(&s, &t2), Some(crate::documents::dir(&s, &t2.id)));
            assert_eq!(runner::work_dir(&s, &t2).unwrap(), crate::documents::dir(&s, &t2.id));
            // It can have labels too, also given as a type as before API 71.
            let planned = create_scratch_task_inner(&s, &profile.id, CreateTask { task_type: Some("plan".into()), ..Default::default() }).unwrap();
            assert_eq!((planned.task_type.as_deref(), planned.labels.as_slice()), (Some("scratch"), ["plan".to_string()].as_slice()));
            for bad in [
                CreateTask { task_type: Some("essay".into()), ..Default::default() },
                CreateTask { labels: Some(json!(["essay"])), ..Default::default() },
                CreateTask { use_worktree: Some(true), ..Default::default() },
                CreateTask { subproject: Some(true), ..Default::default() },
                CreateTask { kind: Some("review".into()), ..Default::default() },
            ] {
                assert!(create_scratch_task_inner(&s, &profile.id, bad).is_err());
            }
            assert!(create_scratch_task_inner(&s, "nobody", CreateTask::default()).is_err());
            // Nothing to merge, so Ready for merge marks it done.
            let done = update_task_inner(&s, &t.id, json!({"status": "ready_for_merge"}).as_object().unwrap()).await.unwrap();
            assert_eq!((done.status.as_str(), done.merging), ("done", false));

            // No project can take the key its tasks use.
            let dir = std::env::temp_dir().join(format!("ia-api-{}", new_id()));
            let b = |key: Option<&str>| CreateProject { name: "Shop".into(), repo_path: path_str(&dir), key: key.map(String::from), base_branch: None, use_worktrees: None };
            let err = create_project_inner(&s, &profile.id, b(Some("s"))).await.unwrap_err();
            assert!(format!("{err:?}").contains("scratch tasks"), "{err:?}");
            let p = create_project_inner(&s, &profile.id, b(None)).await.unwrap();
            assert!(update_project_inner(&s, &p.id, json!({"key": "S"}).as_object().unwrap()).await.is_err());
            std::fs::remove_dir_all(&dir).ok();
            crate::runs::TEST_CAN_RUN.set(false);
        })
    }

    #[test]
    fn archives_projects() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
            let dir = std::env::temp_dir().join(format!("ia-api-{}", new_id()));
            let new = |name: &str| CreateProject { name: name.into(), repo_path: path_str(&dir.join(name)), key: None, base_branch: None, use_worktrees: None };
            let p = create_project_inner(&s, &profile.id, new("x")).await.unwrap();
            let other = create_project_inner(&s, &profile.id, new("y")).await.unwrap();
            for id in [&p.id, &other.id] {
                update_project_inner(&s, id, json!({"group_name": "Shop"}).as_object().unwrap()).await.unwrap();
            }
            let task = create_task_inner(&s, &p.id, CreateTask { title: "t".into(), ..Default::default() }).unwrap();
            let set = async |v: Value| update_project_inner(&s, &p.id, json!({ "archived": v }).as_object().unwrap()).await;
            let listed = async |archived: bool| {
                let Json(v) = list_projects(State(s.clone()), Path(profile.id.clone()), Query(ProjectListQuery { archived })).await.unwrap();
                v.as_array().unwrap().iter().map(|p| p["name"].as_str().unwrap().to_string()).collect::<Vec<_>>()
            };
            assert_eq!(listed(false).await, ["x", "y"]);
            assert!(listed(true).await.is_empty());

            // Not while one of its agents is running.
            s.runs.lock().unwrap().insert(task.id.clone(), crate::state::RunHandle { run_id: "r".into(), cancel: None });
            let err = set(json!(true)).await.unwrap_err();
            assert!(err.1.contains("1 of the project's agents is running"), "{}", err.1);
            s.runs.lock().unwrap().clear();

            let archived = set(json!(true)).await.unwrap().archived_at.expect("archived");
            assert_eq!((listed(false).await, listed(true).await), (vec!["y".to_string()], vec!["x".to_string()]));
            // Out of its group, and no new tasks.
            assert_eq!(db::group_projects(&s.db(), &profile.id, "Shop").unwrap().iter().map(|p| &p.name).collect::<Vec<_>>(), ["y"]);
            let err = create_task_inner(&s, &p.id, CreateTask { title: "u".into(), ..Default::default() }).unwrap_err();
            assert!(err.1.contains("is archived"), "{}", err.1);
            // Archiving again keeps when it was archived.
            assert_eq!(set(json!(true)).await.unwrap().archived_at.as_deref(), Some(archived.as_str()));
            assert!(set(json!("yes")).await.is_err());

            assert_eq!(set(json!(false)).await.unwrap().archived_at, None);
            assert_eq!(listed(false).await, ["x", "y"]);
            create_task_inner(&s, &p.id, CreateTask { title: "u".into(), ..Default::default() }).unwrap();
            std::fs::remove_dir_all(&dir).ok();
        })
    }

    #[test]
    fn a_done_task_can_be_given_when_it_was_done() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
            let new = db::NewTask { profile_id: &profile.id, project_id: None, kind: "task", title: "t", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
            let t = db::insert_task(&s.db(), new).unwrap();
            let set = |b: Value| {
                let (s, id) = (s.clone(), t.id.clone());
                async move { update_task_inner(&s, &id, b.as_object().unwrap()).await }
            };
            // Only a done task has one, and only a time will do.
            assert!(set(json!({"done_at": "2026-01-01T00:00:00Z"})).await.is_err());
            assert!(set(json!({"status": "done", "done_at": "yesterday"})).await.is_err());
            assert!(set(json!({"status": "done", "done_at": null})).await.is_err());
            assert_eq!(set(json!({"status": "todo"})).await.unwrap().done_at, None);
            // Moved into done with one, it keeps it, in UTC; a new one replaces it.
            let done = set(json!({"status": "done", "done_at": "2026-01-01T13:00:00+13:00"})).await.unwrap();
            assert_eq!(done.done_at.as_deref(), Some("2026-01-01T00:00:00.000Z"));
            assert_eq!(set(json!({"done_at": "2026-02-01T00:00:00Z"})).await.unwrap().done_at.as_deref(), Some("2026-02-01T00:00:00.000Z"));
            // Moving it out of done in the same request isn't allowed, and moving it out clears it.
            assert!(set(json!({"status": "in_review", "done_at": "2026-02-01T00:00:00Z"})).await.is_err());
            assert_eq!(set(json!({"status": "in_review"})).await.unwrap().done_at, None);
        })
    }

    #[test]
    fn any_task_can_have_labels() {
        crate::testing::run(async || {
            crate::runs::TEST_CAN_RUN.set(true);
            let s = crate::testing::state();
            let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
            let dir = std::env::temp_dir().join(format!("ia-api-{}", new_id()));
            std::fs::create_dir_all(&dir).unwrap();
            assert!(std::process::Command::new("git").arg("init").arg("-q").arg(&dir).status().unwrap().success());
            let b = CreateProject { name: "x".into(), repo_path: path_str(&dir), key: None, base_branch: None, use_worktrees: None };
            let p = create_project_inner(&s, &profile.id, b).await.unwrap();
            let labelled = |l: Value| CreateTask { title: "Draw it".into(), labels: Some(l), ..Default::default() };
            let typed = |t: &str| CreateTask { title: "Draw it".into(), task_type: Some(t.into()), ..Default::default() };
            let labels = |t: &db::Task| t.labels.iter().map(String::as_str).collect::<Vec<_>>().join(",");

            // A code task, in a worktree, with a plan and a diagram.
            let plan = create_task_inner(&s, &p.id, labelled(json!(["diagram", "plan"]))).unwrap();
            assert_eq!((plan.task_type.as_deref(), labels(&plan).as_str(), plan.use_worktree), (None, "plan,diagram", true));
            // A type that's a label, as before API 71, is that label.
            let old = create_task_inner(&s, &p.id, CreateTask { labels: Some(json!(["artifact"])), ..typed("plan") }).unwrap();
            assert_eq!((old.task_type.as_deref(), labels(&old).as_str(), old.use_worktree), (None, "plan,artifact", true));
            assert!(create_task_inner(&s, &p.id, typed("essay")).is_err());
            assert!(create_task_inner(&s, &p.id, labelled(json!(["essay"]))).is_err());
            assert!(create_task_inner(&s, &p.id, labelled(json!("plan"))).is_err());
            let sp = create_task_inner(&s, &p.id, CreateTask { subproject: Some(true), ..typed("plan") }).unwrap();
            assert_eq!((sp.subproject, labels(&sp).as_str()), (true, "plan"));
            assert!(create_task_inner(&s, &p.id, CreateTask { kind: Some("review".into()), ..typed("plan") }).is_err());
            assert_eq!(labels(&create_task_inner(&s, &p.id, typed(" ")).unwrap()), "");

            // Labels can be added and taken off.
            let set = |id: &str, b: Value| {
                let (s, id) = (s.clone(), id.to_string());
                async move { update_task_inner(&s, &id, b.as_object().unwrap()).await }
            };
            assert_eq!(labels(&set(&plan.id, json!({"labels": ["artifact", "plan"]})).await.unwrap()), "plan,artifact");
            assert!(set(&plan.id, json!({"labels": ["poem"]})).await.is_err());
            assert!(set(&plan.id, json!({"labels": "plan"})).await.is_err());
            assert_eq!(labels(&set(&plan.id, json!({"labels": []})).await.unwrap()), "");
            // A labelled task without changes has nothing to merge, as any task.
            set(&plan.id, json!({"labels": ["plan"], "use_worktree": false})).await.unwrap();
            let merged = set(&plan.id, json!({"status": "ready_for_merge"})).await.unwrap();
            assert_eq!(merged.status, "done");

            // A plan task from before labels (as the migration leaves it) still works in its own folder.
            let fields = [("labels", json!(["plan"])), ("use_worktree", json!(false)), ("work_dir", json!(format!("documents/{}", old.id)))];
            let old = db::update_task(&s.db(), &old.id, &fields).unwrap().unwrap();
            assert_eq!(runner::work_dir(&s, &old).unwrap(), crate::documents::dir(&s, &old.id));
            assert!(set(&old.id, json!({"use_worktree": true})).await.is_err());
            assert!(set(&old.id, json!({"subproject": true})).await.is_err());
            // The board keeps the document, so there's nothing to merge.
            let done = set(&old.id, json!({"status": "ready_for_merge"})).await.unwrap();
            assert_eq!((done.status.as_str(), done.resolution.as_deref(), done.merging), ("done", Some("done"), false));

            // A group task can have them too.
            update_project_inner(&s, &p.id, json!({"group_name": "Shop"}).as_object().unwrap()).await.unwrap();
            let b = CreateGroupTask { group: "Shop".into(), task: labelled(json!(["diagram"])) };
            let Json(g) = create_group_task(State(s.clone()), Path(profile.id.clone()), Json(b)).await.unwrap();
            assert_eq!((&g["task_type"], &g["labels"], g["group_name"].as_str()), (&Value::Null, &json!(["diagram"]), Some("Shop")));
            let b = CreateGroupTask { group: "Shop".into(), task: typed("poem") };
            assert!(create_group_task(State(s.clone()), Path(profile.id.clone()), Json(b)).await.is_err());
            let b = CreateGroupTask { group: "Shop".into(), task: typed("scratch") };
            assert!(create_group_task(State(s.clone()), Path(profile.id.clone()), Json(b)).await.is_err());

            // Its folder goes with it.
            let folder = crate::documents::dir(&s, &done.id);
            std::fs::create_dir_all(&folder).unwrap();
            std::fs::write(folder.join("plan.html"), "<h1>Plan</h1>").unwrap();
            // So do its finished runs' folders; one still stopping is left for runs::prune.
            let run = |exit: bool| {
                let run = db::insert_run(&s.db(), &done.id, "prompt").unwrap();
                let dir = crate::runs::run_dir(&s, &run.id);
                std::fs::create_dir_all(&dir).unwrap();
                if exit {
                    std::fs::write(dir.join("exit"), "{}").unwrap();
                }
                dir
            };
            let (finished, stopping) = (run(true), run(false));
            delete_one(&s, &done, false).await.unwrap();
            assert!(!folder.exists());
            assert!(!finished.exists() && stopping.exists());
            std::fs::remove_dir_all(&s.data_dir).ok();
            std::fs::remove_dir_all(&dir).ok();
            crate::runs::TEST_CAN_RUN.set(false);
        })
    }

    #[test]
    fn tasks_made_from_one_prompt_share_a_fanout_id() {
        crate::testing::run(async || {
            crate::runs::TEST_CAN_RUN.set(true);
            let s = crate::testing::state();
            let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
            let dir = std::env::temp_dir().join(format!("ia-api-{}", new_id()));
            std::fs::create_dir_all(&dir).unwrap();
            let b = CreateProject { name: "x".into(), repo_path: path_str(&dir), key: Some("WEB".into()), base_branch: None, use_worktrees: None };
            let p = create_project_inner(&s, &profile.id, b).await.unwrap();
            let fanned = |id: &str| CreateTask { title: "Look".into(), fanout_id: Some(id.into()), ..Default::default() };
            let a = create_task_inner(&s, &p.id, fanned("f-1")).unwrap();
            let b = create_task_inner(&s, &p.id, CreateTask { model: Some("opus".into()), ..fanned("f-1") }).unwrap();
            assert_eq!((a.fanout_id.as_deref(), b.fanout_id.as_deref()), (Some("f-1"), Some("f-1")));
            let scratch = create_scratch_task_inner(&s, &profile.id, CreateTask { title: "Ask".into(), fanout_id: Some("f_2".into()), ..Default::default() }).unwrap();
            assert_eq!(scratch.fanout_id.as_deref(), Some("f_2"));
            // On its own, or with a blank one, it has none.
            assert_eq!(create_task_inner(&s, &p.id, CreateTask { title: "Alone".into(), ..Default::default() }).unwrap().fanout_id, None);
            assert_eq!(create_task_inner(&s, &p.id, fanned(" ")).unwrap().fanout_id, None);
            // A group's plans made from one prompt are linked too.
            update_project_inner(&s, &p.id, json!({"group_name": "Shop"}).as_object().unwrap()).await.unwrap();
            let grouped = |id: &str| CreateGroupTask { group: "Shop".into(), task: CreateTask { task_type: Some("plan".into()), ..fanned(id) } };
            let Json(g) = create_group_task(State(s.clone()), Path(profile.id.clone()), Json(grouped("f-3"))).await.unwrap();
            assert_eq!((&g["labels"], g["fanout_id"].as_str()), (&json!(["plan"]), Some("f-3")));
            for bad in ["a b", "x/y", &"z".repeat(65)] {
                assert!(create_task_inner(&s, &p.id, fanned(bad)).is_err(), "{bad}");
                assert!(create_scratch_task_inner(&s, &profile.id, fanned(bad)).is_err(), "{bad}");
                assert!(create_group_task(State(s.clone()), Path(profile.id.clone()), Json(grouped(bad))).await.is_err(), "{bad}");
            }
        })
    }

    #[test]
    fn scratch_tasks_and_subprojects_are_task_types_in_a_project() {
        crate::testing::run(async || {
            crate::runs::TEST_CAN_RUN.set(true);
            let s = crate::testing::state();
            let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
            let dir = std::env::temp_dir().join(format!("ia-api-{}", new_id()));
            std::fs::create_dir_all(&dir).unwrap();
            assert!(std::process::Command::new("git").arg("init").arg("-q").arg(&dir).status().unwrap().success());
            let b = CreateProject { name: "x".into(), repo_path: path_str(&dir), key: Some("WEB".into()), base_branch: None, use_worktrees: None };
            let p = create_project_inner(&s, &profile.id, b).await.unwrap();
            let typed = |t: &str| CreateTask { title: "Look".into(), task_type: Some(t.into()), ..Default::default() };

            // A subproject is a type of task, though it's kept as the subproject flag.
            let sp = create_task_inner(&s, &p.id, typed("subproject")).unwrap();
            assert_eq!((sp.subproject, sp.task_type.as_deref(), sp.use_worktree), (true, None, true));

            // A scratch task in the project is numbered with its tasks and works in its own folder.
            let scratch = create_task_inner(&s, &p.id, typed("scratch")).unwrap();
            assert!(scratch.is_scratch());
            assert_eq!((scratch.project_id.as_deref(), scratch.number, scratch.use_worktree), (Some(p.id.as_str()), 2, false));
            assert_eq!(runner::task_key_prefix(&s, &scratch), "WEB");
            assert_eq!(runner::work_dir(&s, &scratch).unwrap(), crate::documents::dir(&s, &scratch.id));
            assert!(create_task_inner(&s, &p.id, CreateTask { use_worktree: Some(true), ..typed("scratch") }).unwrap().is_scratch());
            assert!(create_task_inner(&s, &p.id, CreateTask { subproject: Some(true), ..typed("scratch") }).is_err());

            // And in a subproject, where it isn't part of the subproject's work: its column
            // doesn't follow it, and the subproject merges without asking about it.
            let inner = create_task_inner(&s, &p.id, CreateTask { parent_id: Some(sp.id.clone()), ..typed("scratch") }).unwrap();
            assert_eq!((inner.parent_id.as_deref(), inner.use_worktree, inner.is_scratch()), (Some(sp.id.as_str()), false, true));
            s.update_task(&inner.id, &[("status", json!("in_progress"))]).unwrap();
            assert_eq!(db::get_task(&s.db(), &sp.id).unwrap().unwrap().status, "todo");
            assert!(create_task_inner(&s, &p.id, CreateTask { parent_id: Some(sp.id.clone()), ..typed("subproject") }).is_err());

            // Nothing to merge, so Ready for merge marks it done.
            let done = update_task_inner(&s, &scratch.id, json!({"status": "ready_for_merge"}).as_object().unwrap()).await.unwrap();
            assert_eq!((done.status.as_str(), done.merging), ("done", false));
            // Nor does its scratch task give the subproject anything to merge: never started, it's
            // done without a merge run (IA-129 review).
            let done = update_task_inner(&s, &sp.id, json!({"status": "ready_for_merge"}).as_object().unwrap()).await.unwrap();
            assert_eq!((done.status.as_str(), done.merging, done.running), ("done", false, false));
            std::fs::remove_dir_all(&dir).ok();
            crate::runs::TEST_CAN_RUN.set(false);
        })
    }

    #[test]
    fn sets_a_script_per_status() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
            let dir = std::env::temp_dir().join(format!("ia-api-{}", new_id()));
            let b = CreateProject { name: "x".into(), repo_path: path_str(&dir), key: None, base_branch: None, use_worktrees: None };
            let p = create_project_inner(&s, &profile.id, b).await.unwrap();
            assert!(p.status_scripts.is_empty());
            let set = async |v: Value| update_project_inner(&s, &p.id, json!({ "status_scripts": v }).as_object().unwrap()).await;
            // Blank scripts are dropped.
            let p = set(json!({ "done": "make clean", "todo": "  " })).await.unwrap();
            assert_eq!(p.status_scripts, BTreeMap::from([("done".to_string(), "make clean".to_string())]));
            assert_eq!(db::get_project(&s.db(), &p.id).unwrap().unwrap().status_scripts, p.status_scripts);
            assert!(set(json!({ "finished": "x" })).await.is_err());
            assert!(set(json!({ "done": 3 })).await.is_err());
            assert!(set(json!("make clean")).await.is_err());
            assert!(set(Value::Null).await.unwrap().status_scripts.is_empty());
            std::fs::remove_dir_all(&dir).ok();
        })
    }

    #[test]
    fn deleting_a_running_task_lets_go_of_its_run() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let p = db::insert_profile(&s.db(), "p", &[], None).unwrap();
            let t = db::NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "t", description: "", status: "in_progress", use_worktree: false, model: None, effort: None, claude_config_id: None };
            let task = db::insert_task(&s.db(), t).unwrap();
            let run = db::insert_run(&s.db(), &task.id, "prompt").unwrap();
            s.db().execute("UPDATE runs SET status='running' WHERE id=?1", [&run.id]).unwrap();
            let dir = crate::runs::run_dir(&s, &run.id);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("out.jsonl"), "").unwrap();
            s.runs.lock().unwrap().insert(task.id.clone(), crate::state::RunHandle { run_id: run.id.clone(), cancel: None });
            delete_one(&s, &task, false).await.unwrap();
            // The agent exits after its task (and with it the run's row) is gone.
            runner::on_exit(&s, &run.id, None, Some(15), None, "");
            assert!(!s.is_running(&task.id));
        })
    }

    // HA-37: deleting a profile left its worktrees registered in their repositories, and its
    // folders, runs and documents behind.
    #[test]
    fn deleting_a_profile_cleans_up_after_its_projects_and_threads() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let app = router(s.clone());
            let (dir, p) = git_project(&s).await;
            let t = create_task_inner(&s, &p.id, CreateTask { title: "x".into(), ..Default::default() }).unwrap();
            let t = worktree::setup(&s, &t.id).await.unwrap();
            let wt = t.worktree_path.clone().unwrap();
            let worktrees = || String::from_utf8(std::process::Command::new("git").arg("-C").arg(&dir).args(["worktree", "list"]).output().unwrap().stdout).unwrap();
            assert!(worktrees().contains(&wt));
            // A finished run, and a scratch task's documents.
            let run = db::insert_run(&s.db(), &t.id, "prompt").unwrap();
            s.db().execute("UPDATE runs SET status='exited' WHERE id=?1", [&run.id]).unwrap();
            let run_dir = crate::runs::run_dir(&s, &run.id);
            std::fs::create_dir_all(&run_dir).unwrap();
            std::fs::write(run_dir.join("exit"), "0").unwrap();
            let scratch = create_scratch_task_inner(&s, &p.profile_id, CreateTask::default()).unwrap();
            let docs = crate::documents::dir(&s, &scratch.id);
            std::fs::create_dir_all(&docs).unwrap();
            std::fs::write(docs.join("notes.md"), "x").unwrap();
            std::fs::create_dir_all(s.profile_scratch_dir(&p.profile_id)).unwrap();
            let project_dir = s.data_dir.join("projects").join(&p.id);
            assert!(project_dir.is_dir());

            assert_eq!(call(&app, "DELETE", &format!("/api/profiles/{}", p.profile_id)).await, (200, json!({"ok": true})));
            assert!(!worktrees().contains(&wt), "{}", worktrees());
            assert!(!std::path::Path::new(&wt).exists());
            assert!(!project_dir.exists() && !run_dir.exists() && !docs.exists());
            assert!(!s.data_dir.join("profiles").join(&p.profile_id).exists());
            assert!(db::get_task(&s.db(), &scratch.id).unwrap().is_none());
            // The branch is kept.
            assert!(std::process::Command::new("git").arg("-C").arg(&dir).args(["rev-parse", "--verify", "-q", t.branch.as_deref().unwrap()]).status().unwrap().success());
            assert_eq!(call(&app, "DELETE", &format!("/api/profiles/{}", p.profile_id)).await.0, 404);
            std::fs::remove_dir_all(&dir).ok();
        })
    }

    #[test]
    fn deleting_a_project_keeps_its_folder_if_another_uses_it() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (dir, a) = git_project(&s).await;
            let (dir_b, b) = git_project(&s).await;
            let shared = s.data_dir.join("projects").join(&a.id).join("shared");
            update_project_inner(&s, &b.id, json!({"worktrees_root": path_str(&shared)}).as_object().unwrap()).await.unwrap();
            delete_project_inner(&s, &a.id).await.unwrap();
            assert!(s.data_dir.join("projects").join(&a.id).is_dir());
            delete_project_inner(&s, &b.id).await.unwrap();
            assert!(!s.data_dir.join("projects").join(&b.id).exists());
            std::fs::remove_dir_all(&dir).ok();
            std::fs::remove_dir_all(&dir_b).ok();
        })
    }

    #[test]
    fn unknown_ids_get_a_404() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let app = router(s.clone());
            for (method, path) in [
                ("DELETE", "/api/profiles/nope"),
                ("DELETE", "/api/claude-configs/nope"),
                ("DELETE", "/api/tasks/nope/terminal"),
                ("POST", "/api/tasks/nope/terminal/keepalive?tool=x"),
                ("GET", "/api/projects/nope/tasks"),
            ] {
                assert_eq!(call(&app, method, path).await.0, 404, "{method} {path}");
            }
        })
    }

    // HA-37: a blank name made a profile's clone folder ~, and one renamed to another's took its grants.
    #[test]
    fn profile_names_are_required_and_unique() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let create = async |name: Value| create_profile(State(s.clone()), Json(serde_json::from_value(json!({"name": name})).unwrap())).await;
            let personal = create(json!(" personal ")).await.unwrap().0;
            assert_eq!(personal["name"], "personal");
            let work = create(json!("work")).await.unwrap().0;
            assert_eq!(create(json!("Personal")).await.unwrap_err().0, StatusCode::CONFLICT);
            assert_eq!(create(json!(" ")).await.unwrap_err().0, StatusCode::BAD_REQUEST);
            let rename = async |id: &Value, name: Value| update_profile(State(s.clone()), Path(id.as_str().unwrap().into()), Json(json!({"name": name}).as_object().unwrap().clone())).await;
            for (bad, status) in [(json!(""), StatusCode::BAD_REQUEST), (json!(" "), StatusCode::BAD_REQUEST), (json!(3), StatusCode::BAD_REQUEST), (Value::Null, StatusCode::BAD_REQUEST), (json!(" PERSONAL"), StatusCode::CONFLICT)] {
                assert_eq!(rename(&work["id"], bad.clone()).await.unwrap_err().0, status, "{bad}");
            }
            assert_eq!(db::get_profile(&s.db(), work["id"].as_str().unwrap()).unwrap().unwrap().name, "work");
            // Its own name in another case is fine.
            assert_eq!(rename(&personal["id"], json!("Personal")).await.unwrap().0["name"], "Personal");
            assert_eq!(rename(&work["id"], json!(" office ")).await.unwrap().0["name"], "office");
        })
    }

    // HA-47: two profiles named in different cases before HA-37 got a 409 on every save of either.
    #[test]
    fn profiles_sharing_a_name_in_another_case_can_still_be_saved() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let upper = db::insert_profile(&s.db(), "Work", &[], None).unwrap();
            let lower = db::insert_profile(&s.db(), "work", &[], None).unwrap();
            let save = async |id: &str, body: Value| update_profile(State(s.clone()), Path(id.into()), Json(body.as_object().unwrap().clone())).await;
            for p in [&upper, &lower] {
                let saved = save(&p.id, json!({"name": format!(" {} ", p.name), "default_model": "haiku"})).await.unwrap().0;
                assert_eq!((saved["name"].as_str(), saved["default_model"].as_str()), (Some(p.name.as_str()), Some("haiku")));
            }
            // A change of case is still checked.
            assert_eq!(save(&lower.id, json!({"name": "WORK"})).await.unwrap_err().0, StatusCode::CONFLICT);
            assert_eq!(save(&lower.id, json!({"name": "office"})).await.unwrap().0["name"], "office");
        })
    }

    // HA-47: deleting a profile removed its folder even with another project's worktrees in it.
    #[test]
    fn deleting_a_profile_keeps_its_folder_if_a_project_uses_it() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let gone = db::insert_profile(&s.db(), "gone", &[], None).unwrap();
            let folder = s.data_dir.join("profiles").join(&gone.id);
            std::fs::create_dir_all(folder.join("scratch")).unwrap();
            let (dir, p) = git_project(&s).await;
            s.db().execute("UPDATE projects SET worktrees_root=?1 WHERE id=?2", [&path_str(&folder.join("worktrees")), &p.id]).unwrap();
            let _ = delete_profile(State(s.clone()), Path(gone.id.clone())).await.unwrap();
            assert!(folder.is_dir());
            std::fs::remove_dir_all(&dir).ok();
            std::fs::remove_dir_all(&s.data_dir).ok();
        })
    }

    // HA-47: through a symlinked data dir, a used path that didn't exist yet didn't keep its folder.
    #[test]
    fn a_folder_is_kept_for_a_path_in_it_through_a_symlink() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let tmp = std::env::temp_dir().join(format!("ia-api-{}", new_id()));
            std::fs::create_dir_all(tmp.join("real/projects/x")).unwrap();
            std::os::unix::fs::symlink(tmp.join("real"), tmp.join("link")).unwrap();
            let dir = tmp.join("link/projects/x");
            let (repo, p) = git_project(&s).await;
            s.db().execute("UPDATE projects SET worktrees_root=?1 WHERE id=?2", [&path_str(&dir.join("worktrees")), &p.id]).unwrap();
            remove_unused_dir(&s, &dir, "project").unwrap();
            assert!(tmp.join("real/projects/x").is_dir());
            s.db().execute("UPDATE projects SET worktrees_root=?1 WHERE id=?2", [&path_str(&tmp.join("elsewhere")), &p.id]).unwrap();
            remove_unused_dir(&s, &dir, "project").unwrap();
            assert!(!tmp.join("real/projects/x").exists());
            std::fs::remove_dir_all(&repo).ok();
            std::fs::remove_dir_all(&tmp).ok();
        })
    }

    #[test]
    fn claude_config_fields_must_be_strings() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let cfg = db::insert_claude_config(&s.db(), "c", "/claude/c", "claude").unwrap();
            for bad in [json!({"config_dir": 3}), json!({"config_dir": null}), json!({"name": false}), json!({"agent": 1})] {
                let res = update_claude_config(State(s.clone()), Path(cfg.id.clone()), Json(bad.as_object().unwrap().clone())).await;
                assert_eq!(res.unwrap_err().0, StatusCode::BAD_REQUEST, "{bad}");
            }
            assert_eq!(db::get_claude_config(&s.db(), &cfg.id).unwrap().unwrap().config_dir, "/claude/c");
            let res = update_claude_config(State(s.clone()), Path(cfg.id.clone()), Json(json!({"config_dir": ""}).as_object().unwrap().clone())).await;
            assert_eq!(res.unwrap().0["config_dir"], "");
        })
    }

    // HA-37: two moves to Ready for merge at once both started a merge.
    #[test]
    fn two_moves_to_ready_for_merge_at_once_queue_one_merge() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (dir, p) = git_project(&s).await;
            let t = create_task_inner(&s, &p.id, CreateTask { title: "x".into(), ..Default::default() }).unwrap();
            let t = worktree::setup(&s, &t.id).await.unwrap();
            let wt = PathBuf::from(t.worktree_path.as_deref().unwrap());
            assert!(std::process::Command::new("git").arg("-C").arg(&wt).args(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "work"]).status().unwrap().success());
            let body = json!({"status": "ready_for_merge"});
            let (a, b) = tokio::join!(update_task_inner(&s, &t.id, body.as_object().unwrap()), update_task_inner(&s, &t.id, body.as_object().unwrap()));
            let codes: Vec<Option<StatusCode>> = [&a, &b].iter().map(|r| r.as_ref().err().map(|e| e.0)).collect();
            assert!(codes.contains(&None) && codes.contains(&Some(StatusCode::CONFLICT)), "{codes:?}");
            std::fs::remove_dir_all(&dir).ok();
        })
    }
}
