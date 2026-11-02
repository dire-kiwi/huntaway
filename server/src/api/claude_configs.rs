//! Claude configs (the config folders agents run with), their models, and moving a config's login and
//! settings to another host.

use super::*;

pub(super) async fn list_claude_configs(State(s): State<Shared>) -> ApiResult<Json<Value>> {
    Ok(Json(json!(db::list_claude_configs(&s.db())?)))
}

#[derive(Deserialize)]
pub(super) struct CreateClaudeConfig {
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

pub(super) async fn create_claude_config(State(s): State<Shared>, Json(b): Json<CreateClaudeConfig>) -> ApiResult<Json<Value>> {
    if b.name.trim().is_empty() {
        return Err(ApiError::bad("name is required"));
    }
    let agent = b.agent.as_deref().unwrap_or("claude");
    check_agent(agent)?;
    let cfg = db::insert_claude_config(&s.db(), b.name.trim(), &b.config_dir, agent)?;
    s.emit(json!({"type": "profiles_changed"}));
    Ok(Json(json!(cfg)))
}

pub(super) async fn update_claude_config(State(s): State<Shared>, Path(id): Path<String>, Json(b): Json<Map<String, Value>>) -> ApiResult<Json<Value>> {
    let mut fields = pick(&b, &["name", "config_dir", "agent"]);
    for (k, v) in fields.iter_mut() {
        let t = v.as_str().ok_or_else(|| ApiError::bad(format!("{k} must be a string")))?.trim().to_string();
        if *k == "name" && t.is_empty() {
            return Err(ApiError::bad("name is required"));
        }
        *v = json!(t);
    }
    for key in ["show_usage", "restart_window"] {
        if let Some(v) = b.get(key) {
            fields.push((key, json!(v.as_bool().ok_or_else(|| ApiError::bad(format!("{key} must be true or false")))?)));
        }
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

pub(super) async fn delete_claude_config(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
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
pub(super) async fn delete_profile(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
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

/// `GET /claude-configs/{id}/models` (API 25): the models a Codex config offers, with their
/// efforts. Claude configs have none listed (the UI suggests Claude's aliases).
pub(super) async fn claude_config_models(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
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

pub(super) async fn export_claude_config(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(export_config(claude_config_files(&s, &id)?).await?))
}

pub(super) async fn import_claude_config(State(s): State<Shared>, Path(id): Path<String>, Json(b): Json<ImportConfig>) -> ApiResult<Json<Value>> {
    Ok(Json(import_config(claude_config_files(&s, &id)?, b)?))
}

pub(super) async fn export_profile_config(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(export_config(profile_config_files(&s, &id)?).await?))
}

pub(super) async fn import_profile_config(State(s): State<Shared>, Path(id): Path<String>, Json(b): Json<ImportConfig>) -> ApiResult<Json<Value>> {
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
pub(super) struct ImportConfig {
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
