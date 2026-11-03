//! The HTTP API. `router` and `host_routes` list every route; the handlers are in the submodules, by what
//! they act on.

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

use crate::agent::{agent_tools, approval_rules, assistant, runner, title};
use crate::db::{self, NewProject, NewTask, PERMISSION_MODES, STATUSES};
use crate::git::{git_view, relocate, worktree};
use crate::hosts::{hub, terminal};
use crate::integrations::{automations, github, telegram};
use crate::mcp::{permissions, tools};
use crate::state::{ApiError, ApiResult, Shared};
use crate::update::admin;
use crate::util::{derive_key, expand_tilde, new_id, path_str, same_secret};

mod claude_configs;
mod host;
mod new_task;
mod profiles;
mod projects;
mod tasks;
mod thread;

pub use new_task::*;
pub use projects::*;
pub use tasks::*;
pub use thread::*;

use claude_configs::*;
use host::*;
use profiles::*;

#[cfg(test)]
pub(crate) mod tests;

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
        .route("/hosts/{id}", axum::routing::patch(hub::change_host).delete(hub::remove_host))
        .route("/hosts/{id}/update", post(hub::update_host))
        .route("/preview-status", get(preview_status))
        .route("/push", get(crate::integrations::push::info))
        .route("/push/subscriptions", post(crate::integrations::push::subscribe))
        .route("/push/subscriptions/{id}", axum::routing::patch(crate::integrations::push::update).delete(crate::integrations::push::unsubscribe))
        .route("/push/subscriptions/{id}/test", post(crate::integrations::push::test))
        .route("/devices", get(crate::devices::list_handler))
        .route("/devices/pairing", post(crate::devices::new_code))
        .route("/devices/{id}", axum::routing::patch(crate::devices::rename).delete(crate::devices::revoke))
        .route("/h/{host_id}/{*rest}", any(hub::proxy))
        .route("/ws", get(hub::ws))
        .layer(middleware::from_fn_with_state(state.clone(), auth));
    Router::new()
        .route("/api/health", get(health))
        .route("/api/hub/connect", get(hub::accept))
        // Without the board's token: the one-time code from Settings → Network access is swapped for a device's own.
        .route("/api/devices/pair", post(crate::devices::pair))
        // Without the board's token: the token in its path reaches only its own automation.
        .route("/api/hooks/{id}/{token}", post(automations::webhook).layer(DefaultBodyLimit::max(automations::MAX_BODY)))
        // Without the board's token: the token in its body answers only its own prompt, once (from a notification).
        .route("/api/permissions/{id}/push-answer", post(crate::integrations::push_answers::answer))
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
        .route("/default-prompts", get(|| async { Json(crate::agent::prompts::defaults()) }))
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
        .route("/profiles/{id}/assistant", get(get_assistant).post(send_to_assistant))
        .route("/profiles/{id}/assistant/memory", get(assistant::memory::overview))
        .route("/profiles/{id}/assistant/memory/file", get(assistant::memory::read).post(assistant::memory::write))
        .route("/profiles/{id}/assistant/memory/history", get(assistant::memory::history))
        .route("/profiles/{id}/assistant/memory/diff", get(assistant::memory::diff))
        .route("/profiles/{id}/assistant/memory/restore", post(assistant::memory::restore))
        .route("/profiles/{id}/assistant/memory/import", post(assistant::memory::import))
        .route("/profiles/{id}/approval-rules", get(get_approval_rules).post(set_approval_rules))
        .route("/profiles/{id}/approval-log", get(approval_log))
        .route("/profiles/{id}/telegram", get(telegram::get).patch(telegram::update))
        .route("/profiles/{id}/telegram/link", post(telegram::new_link))
        .route("/profiles/{id}/telegram/owner", axum::routing::delete(telegram::unlink))
        .route("/profiles/{id}/assistant/google", get(assistant::google::get).post(assistant::google::setup))
        .route("/profiles/{id}/assistant/brief", post(assistant::brief::create))
        .route("/profiles/{id}/assistant/brief/feedback", post(assistant::brief::feedback))
        .route("/profiles/{id}/group-tasks", get(list_group_tasks).post(create_group_task))
        .route("/profiles/{id}/analytics", get(crate::analytics::get))
        .route("/profiles/{id}/context-stats", get(crate::analytics::context))
        .route("/profiles/{id}/disk-usage", get(crate::disk::get))
        .route("/profiles/{id}/asana/tasks", get(asana_tasks))
        .route("/projects/{id}", get(get_project).patch(update_project).delete(delete_project))
        .route("/projects/{id}/tasks", get(list_project_tasks).post(create_task))
        .route("/projects/{id}/remove-merged-worktrees", post(remove_merged_worktrees))
        .route("/projects/{id}/setup-thread", post(start_setup_thread))
        .route("/projects/{id}/system-prompt", get(system_prompt_preview))
        .route("/projects/{id}/automations", get(automations::list_handler).post(automations::create_handler))
        .route("/profiles/{id}/automations", get(automations::list_routines_handler).post(automations::create_routine_handler))
        .route(
            "/automations/{id}",
            get(automations::get_handler).patch(automations::update_handler).delete(automations::delete_handler),
        )
        .route("/automations/{id}/run", post(automations::run_handler))
        .route("/automations/{id}/runs", get(automations::runs_handler))
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
        .route("/tasks/{id}/wait-for-limit", post(crate::agent::usage::wait_for_reset))
        .route("/tasks/{id}/review", post(review_task))
        .route("/tasks/{id}/review/extend", post(extend_review))
        .route("/tasks/{id}/summary", post(summarise_task))
        .route("/tasks/{id}/fix_checks", post(fix_checks))
        .route("/tasks/{id}/worktree/setup", post(setup_worktree))
        .route("/tasks/{id}/worktree/teardown", post(teardown_worktree))
        .route("/tasks/{id}/diff", get(task_diff))
        .route("/tasks/{id}/unmerged", get(task_unmerged))
        .route("/tasks/{id}/fanout", get(crate::review::fanout::get))
        .route("/tasks/{id}/fanout/pick", post(crate::review::fanout::pick))
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
        .route("/tasks/{id}/turns", get(crate::git::checkpoints::turns))
        .route("/tasks/{id}/turns/diff", get(crate::git::checkpoints::diff))
        .route("/tasks/{id}/rewind", post(crate::git::checkpoints::rewind).delete(crate::git::checkpoints::cancel_rewind))
        .route("/tasks/{id}/context", get(crate::agent::context::get))
        .route("/tasks/{id}/skills", get(agent_tools::for_task))
        .route("/tasks/{id}/document", get(crate::agent::documents::get))
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
        .route("/internal/merge-gate/{run_id}", get(internal_merge_gate))
        .route("/tools/{tool}", post(remote_tool))
        .route("/usage", get(crate::agent::usage::list))
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

/// Lets in requests with the board's token, or a paired device's (see devices.rs), as a bearer token or `?token=`.
/// A device's request carries a `DeviceAuth`, which its websockets use to close when it's revoked.
async fn auth(State(s): State<Shared>, headers: HeaderMap, mut req: Request, next: Next) -> Response {
    let bearer = headers.get("authorization").and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).map(str::to_string);
    let query: Vec<String> = req.uri().query().unwrap_or("").split('&').filter_map(|kv| kv.strip_prefix("token=")).map(|t| t.to_string()).collect();
    let mut tokens = bearer.into_iter().chain(query);
    if tokens.clone().any(|t| same_secret(&t, &s.token)) {
        return next.run(req).await;
    }
    if let Some(device) = tokens.find_map(|t| crate::devices::authenticate(&s, &t)) {
        // The whole path: a nested router's own has its prefix taken off.
        let path = req.extensions().get::<axum::extract::OriginalUri>().map_or_else(|| req.uri().path().to_string(), |u| u.path().to_string());
        if let Some(why) = crate::devices::refused(req.method().as_str(), &path) {
            return (StatusCode::FORBIDDEN, Json(json!({"error": why}))).into_response();
        }
        req.extensions_mut().insert(device);
        return next.run(req).await;
    }
    (StatusCode::UNAUTHORIZED, Json(json!({"error": "unauthorized"}))).into_response()
}

/// Pick known keys out of a JSON body as (column, value) pairs.
fn pick<'a>(body: &Map<String, Value>, keys: &[&'a str]) -> Vec<(&'a str, Value)> {
    keys.iter().filter_map(|k| body.get(*k).map(|v| (*k, v.clone()))).collect()
}

/// Unauthenticated. API 65: with the commit it runs, for hosts that follow it with `--update-from`.
async fn health(State(s): State<Shared>) -> Json<Value> {
    // API 100: and its API version, which the mobile app checks before pairing.
    Json(json!({"ok": true, "commit": s.meta.running_commit, "api_version": crate::hosts::proto::API_VERSION}))
}

async fn info(State(s): State<Shared>) -> Json<Value> {
    let hostname = std::fs::read_to_string("/proc/sys/kernel/hostname").unwrap_or_default().trim().to_string();
    Json(json!({
        "host_id": s.host_id,
        "host_name": s.host_name,
        "build_id": crate::hosts::proto::BUILD_ID,
        "api_version": crate::hosts::proto::API_VERSION,
        "api_compat": crate::hosts::proto::API_COMPAT,
        "commit": s.meta.running_commit,
        // API 89: how a hub's Update reaches it.
        "updates_from": admin::updates_from(&s.meta),
        "agents": crate::agent::runs::can_run_agents(&s),
        // API 25: which agent CLIs it has.
        "agent_clis": db::AGENTS.iter().filter(|a| crate::agent::runs::has_agent(a)).collect::<Vec<_>>(),
        "version": env!("CARGO_PKG_VERSION"),
        "data_dir": path_str(&s.data_dir),
        "hostname": hostname,
        "home": dirs::home_dir().map(|h| path_str(&h)),
    }))
}

// ---------- websocket ----------

async fn ws(State(s): State<Shared>, device: Option<axum::Extension<crate::devices::DeviceAuth>>, upgrade: WebSocketUpgrade) -> Response {
    upgrade.on_upgrade(move |socket| crate::devices::until_revoked(s.clone(), device.map(|d| d.0), ws_loop(s, socket)))
}

async fn ws_loop(s: Shared, mut socket: WebSocket) {
    let mut rx = s.events.subscribe();
    let _ = socket.send(WsMessage::Text(json!({"type": "hello"}).to_string().into())).await;
    // A hub that says hello here takes our agents' board tool calls (see hosts/uplink.rs), while this lasts.
    let mut uplink: Option<(crate::hosts::uplink::Registered, tokio::sync::mpsc::UnboundedReceiver<crate::hosts::proto::ToolCall>)> = None;
    loop {
        let call = async {
            match uplink.as_mut() {
                Some((_, calls)) => calls.recv().await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            Some(c) = call => {
                if socket.send(WsMessage::Text(crate::hosts::uplink::call_frame(&c).to_string().into())).await.is_err() {
                    break;
                }
            }
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
                Some(Ok(WsMessage::Text(t))) => {
                    let Ok(v) = serde_json::from_str::<Value>(&t) else { continue };
                    match v["type"].as_str() {
                        Some("hub_hello") => {
                            if let (Some(id), Some(name)) = (v["hub_id"].as_str(), v["name"].as_str()) {
                                if id != s.host_id {
                                    uplink = Some(crate::hosts::uplink::register(&s, id, name));
                                }
                            }
                        }
                        Some("hub_result") => {
                            if let (Some((up, _)), Ok(a)) = (&uplink, serde_json::from_value(v)) {
                                up.link.answer(a);
                            }
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
    }
}
