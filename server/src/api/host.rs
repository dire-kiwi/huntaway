//! Host-wide routes: settings, the agents' MCP endpoints, server admin and updates, and the folder
//! browser.

use super::*;

pub(super) async fn get_settings(State(s): State<Shared>) -> ApiResult<Json<Value>> {
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
/// API 88), which checks again when it changes.
pub(super) async fn update_settings(State(s): State<Shared>, Json(b): Json<Map<String, Value>>) -> ApiResult<Json<Value>> {
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
pub(super) async fn internal_mcp(State(s): State<Shared>, Json(call): Json<tools::McpCall>) -> Json<Value> {
    Json(match tools::handle_mcp(&s, call).await {
        Ok(v) => json!({"result": v}),
        Err(e) => json!({"error": e}),
    })
}

/// From a run's gh server, before it merges a pull request: why it can't, if it can't (see merge_gate.rs).
pub(super) async fn internal_merge_gate(State(s): State<Shared>, Path(run_id): Path<String>) -> ApiResult<Json<Value>> {
    let c = s.db();
    let run = db::get_run(&c, &run_id)?.ok_or_else(|| ApiError::not_found("run"))?;
    let blocked = match db::get_task(&c, &run.task_id)? {
        Some(task) => crate::merge_gate::blocked(&c, &task)?,
        None => None,
    };
    Ok(Json(json!({"blocked": blocked})))
}

#[derive(Deserialize)]
pub(super) struct RemoteTool {
    profile: String,
    #[serde(default)]
    args: Value,
    /// Original helper capability, absent on hosts before paginated task fields.
    #[serde(default)]
    task_fields: bool,
}

/// A board tool forwarded from an agent on another host.
pub(super) async fn remote_tool(State(s): State<Shared>, Path(tool): Path<String>, Json(b): Json<RemoteTool>) -> Response {
    match tools::handle_remote(&s, &tool, &b.profile, b.args, b.task_fields).await {
        Ok(v) => Json(json!({"result": v})).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({"error": e}))).into_response(),
    }
}

// ---------- server admin ----------

pub(super) async fn server_status(State(s): State<Shared>) -> ApiResult<Json<Value>> {
    Ok(Json(admin::status(&s).await?))
}

#[derive(Deserialize)]
pub(super) struct RestartBody {
    #[serde(default = "yes")]
    rebuild: bool,
}

pub(super) fn yes() -> bool {
    true
}

pub(super) async fn restart_server(State(s): State<Shared>, Json(b): Json<RestartBody>) -> ApiResult<Json<Value>> {
    admin::start(&s, b.rebuild)?;
    Ok(Json(json!({"ok": true})))
}

/// Check for releases now (with `--release-updates`), and return the server's status after.
pub(super) async fn check_releases(State(s): State<Shared>) -> ApiResult<Json<Value>> {
    if s.meta.release.is_none() {
        return Err(ApiError::bad("this server doesn't check for releases (start it with --release-updates OWNER/REPO)"));
    }
    crate::release::check(&s).await;
    Ok(Json(admin::status(&s).await?))
}

#[derive(Deserialize)]
pub(super) struct ReleaseUpdateBody {
    version: String,
}

/// Restart onto a release (staged, or downloaded first), as a restart job.
pub(super) async fn update_to_release(State(s): State<Shared>, Json(b): Json<ReleaseUpdateBody>) -> ApiResult<Json<Value>> {
    crate::release::update(&s, &b.version)?;
    Ok(Json(json!({"ok": true})))
}

/// Mark the running release bad and restart onto the one before it, as a restart job.
pub(super) async fn roll_back_release(State(s): State<Shared>) -> ApiResult<Json<Value>> {
    crate::release::rollback(&s)?;
    Ok(Json(json!({"ok": true})))
}

#[derive(Deserialize)]
pub(super) struct UpdateBody {
    /// Missing from a hub that runs a release, which only release hosts can update from.
    #[serde(default)]
    commit: String,
    /// With a bundle (a hub that has a checkout), update from it; otherwise fetch the
    /// commit from this host's own `origin` (API 3+).
    bundle: Option<String>,
    branch: Option<String>,
    /// The hub's version (API 89), which a release install updates to instead.
    version: Option<String>,
}

/// A hub asking this host to update to its commit, or a release install to its version.
pub(super) async fn update_from_hub(State(s): State<Shared>, Json(b): Json<UpdateBody>) -> ApiResult<Json<Value>> {
    if admin::updates_from(&s.meta) == Some("releases") {
        let version = b.version.as_deref().ok_or_else(|| ApiError::bad("this host updates from releases, and the board didn't say which version it runs (it needs API 89)"))?;
        return Ok(Json(crate::release::update_from_hub(&s, version).await?));
    }
    if b.commit.is_empty() {
        return Err(ApiError::bad("the board runs a release rather than a checkout, so it can't say which commit to update this host to"));
    }
    Ok(Json(match (&b.bundle, &b.branch) {
        (Some(bundle), Some(branch)) => admin::update_from_bundle(&s, branch, &b.commit, bundle).await?,
        _ => admin::update_from_origin(&s, &b.commit).await?,
    }))
}

// ---------- filesystem browser (for picking repos remotely) ----------

#[derive(Deserialize)]
pub(super) struct DirsQuery {
    path: Option<String>,
}

pub(super) async fn fs_dirs(Query(q): Query<DirsQuery>) -> ApiResult<Json<Value>> {
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
