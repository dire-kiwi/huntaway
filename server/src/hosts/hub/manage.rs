//! Managing hosts: copying Claude config between them, updating them, and adding hosts over SSH.

use super::*;

#[derive(Deserialize)]
pub struct CopyConfig {
    /// The Claude config to copy, by name (API 20).
    config: Option<String>,
    /// Or the default config of the profile with this name (hosts before API 20).
    profile: Option<String>,
    from_host: String,
    to_host: String,
    /// Where to put it on the target if it has no config (or profile) with this name yet
    /// (default: same path).
    config_dir: Option<String>,
    #[serde(default)]
    overwrite: bool,
}

/// Call any host's API (this one or a linked one).
pub(crate) async fn host_request(s: &Shared, host_id: &str, method: &str, path: &str, body: Option<Value>) -> ApiResult<Value> {
    let (status, body) = if host_id == s.host_id {
        local_request(s, method, path, body.map(|b| b.to_string().into_bytes())).await?
    } else {
        let link = s.links.lock().unwrap().get(host_id).cloned().ok_or_else(|| ApiError::conflict(format!("host {host_id} is offline")))?;
        link.request(method, path, body).await?
    };
    if !(200..300).contains(&status) {
        let msg = match body["error"].as_str() {
            // No such route (a bare 404 from older hosts) means the host's build predates this endpoint.
            e if matches!(status, 404 | 405) && e.is_none_or(|e| e.starts_with(crate::api::NO_ROUTE)) => "this host's version doesn't support that yet; update it".into(),
            Some(e) => e.to_string(),
            None => body.to_string(),
        };
        return Err(ApiError(StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY), msg));
    }
    Ok(body)
}

async fn named(s: &Shared, host_id: &str, list: &str, name: &str) -> ApiResult<Option<Value>> {
    let items = host_request(s, host_id, "GET", list, None).await?;
    Ok(items.as_array().into_iter().flatten().find(|p| p["name"] == name).cloned())
}

/// Copy a Claude config's login and settings from one host to another, creating the config
/// on the target if needed.
pub async fn copy_claude_config(State(s): State<Shared>, Json(b): Json<CopyConfig>) -> ApiResult<Json<Value>> {
    if b.from_host == b.to_host {
        return Err(ApiError::bad("pick two different hosts"));
    }
    let dir = |source: &Value, key: &str| b.config_dir.clone().filter(|d| !d.trim().is_empty()).unwrap_or_else(|| source[key].as_str().unwrap_or("").to_string());
    let (from, to) = match (&b.config, &b.profile) {
        (Some(name), _) => {
            let source = named(&s, &b.from_host, "/api/claude-configs", name).await?.ok_or_else(|| ApiError::not_found("Claude config on the source host"))?;
            let target = match named(&s, &b.to_host, "/api/claude-configs", name).await? {
                Some(c) => c,
                None => {
                    let body = json!({"name": name, "config_dir": dir(&source, "config_dir"), "agent": source["agent"]});
                    host_request(&s, &b.to_host, "POST", "/api/claude-configs", Some(body)).await?
                }
            };
            let path = |c: &Value| format!("/api/claude-configs/{}/archive", c["id"].as_str().unwrap_or(""));
            (path(&source), path(&target))
        }
        (None, Some(name)) => {
            let source = named(&s, &b.from_host, "/api/profiles", name).await?.ok_or_else(|| ApiError::not_found("profile on the source host"))?;
            let target = match named(&s, &b.to_host, "/api/profiles", name).await? {
                Some(p) => p,
                None => {
                    let body = json!({"name": name, "claude_config_dir": dir(&source, "claude_config_dir"), "default_model": source["default_model"]});
                    host_request(&s, &b.to_host, "POST", "/api/profiles", Some(body)).await?
                }
            };
            let path = |p: &Value| format!("/api/profiles/{}/claude-config", p["id"].as_str().unwrap_or(""));
            (path(&source), path(&target))
        }
        (None, None) => return Err(ApiError::bad("config (or profile) is required")),
    };
    let archive = host_request(&s, &b.from_host, "GET", &from, None).await?;
    let result = host_request(&s, &b.to_host, "POST", &to, Some(json!({"archive": archive["archive"], "overwrite": b.overwrite}))).await?;
    Ok(Json(json!({"ok": true, "files": archive["files"], "target": result})))
}

/// Send this hub's code to a linked host, which fast-forwards its checkout and restarts. A host installed from a
/// release (API 89) goes by the version instead, and updates to that release.
pub async fn update_host(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    if id == s.host_id {
        return Err(ApiError::bad("use Rebuild & restart for this host"));
    }
    // A hub with a checkout sends its code; one deployed without (a container) sends its
    // commit and the host fetches it from its own origin.
    let mut body = if s.meta.source_dir.is_some() {
        crate::update::admin::bundle(&s).await?
    } else if let Some(commit) = &s.meta.running_commit {
        json!({"commit": commit})
    } else if crate::update::admin::updates_from(&s.meta) == Some("releases") {
        // A release install knows its version but not its commit, which only a release host can go by.
        json!({})
    } else {
        return Err(ApiError::bad("this hub doesn't know which commit it runs (set IA_COMMIT)"));
    };
    body["version"] = json!(env!("CARGO_PKG_VERSION"));
    Ok(Json(host_request(&s, &id, "POST", "/api/admin/update", Some(body)).await?))
}

// ---------- hosts over SSH ----------

/// The hub's SSH public key, for the target's authorized_keys.
pub async fn ssh_key(State(s): State<Shared>) -> ApiResult<Json<Value>> {
    Ok(Json(json!({"public_key": crate::hosts::ssh::public_key(&s).await?})))
}

/// Link a host over SSH: starts it on the target if needed, then keeps a tunnel to it.
pub async fn add_ssh_host(State(s): State<Shared>, Json(t): Json<crate::hosts::ssh::Target>) -> ApiResult<Json<Value>> {
    let t = crate::hosts::ssh::Target { target: t.target.trim().to_string(), ..t };
    if !t.target.contains('@') {
        return Err(ApiError::bad("enter the target as user@host"));
    }
    let details = crate::hosts::ssh::ensure(&s, &t).await.map_err(|e| ApiError::bad(format!("{e:#}")))?;
    let info = &details["info"];
    let host_id = info["host_id"].as_str().ok_or_else(|| ApiError::bad("the host didn't report an id"))?;
    if host_id == s.host_id {
        return Err(ApiError::bad("that's this host"));
    }
    let name = info["host_name"].as_str().unwrap_or(host_id);
    let link = db::upsert_link(&s.db(), host_id, name, "ssh", None, details["token"].as_str())?;
    s.db().execute("UPDATE links SET ssh=?1 WHERE id=?2", rusqlite::params![serde_json::to_string(&t).unwrap(), host_id])?;
    let link = db::get_link(&s.db(), host_id)?.unwrap_or(link);
    spawn_outbound(&s, link.clone());
    changed(&s);
    Ok(Json(json!({"id": link.id, "name": link.name, "started": details["started"]})))
}
