//! Profiles: one per Claude login, each with its own board.

use super::*;

// ---------- profiles ----------

pub(super) async fn list_profiles(State(s): State<Shared>) -> ApiResult<Json<Value>> {
    Ok(Json(json!(db::list_profiles(&s.db())?)))
}

#[derive(Deserialize)]
pub(super) struct CreateProfile {
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
    /// See `db::Profile::reviewers` (API 87).
    #[serde(default)]
    reviewers: Value,
    /// See `db::Profile::summarizer` (API 87).
    #[serde(default)]
    summarizer: Value,
    /// See `db::Profile::merge_approval` (API 92).
    #[serde(default)]
    merge_approval: bool,
}

pub(super) async fn create_profile(State(s): State<Shared>, Json(b): Json<CreateProfile>) -> ApiResult<Json<Value>> {
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
    let (reviewers, summarizer) = (reviewers_value(&c, &b.reviewers, true, &[])?, summarizer_value(&c, &b.summarizer, true, &[])?);
    let mut p = db::insert_profile(&c, name, &ids, b.default_model.as_deref())?;
    let mut fields = vec![("github_account", github_account), ("clone_dir", clone_dir), ("asana_enabled", json!(b.asana_enabled))];
    fields.extend([("limit_wait", json!(b.limit_wait)), ("limit_switch", json!(b.limit_switch)), ("reviewers", reviewers), ("summarizer", summarizer)]);
    fields.push(("merge_approval", json!(b.merge_approval)));
    fields.extend(access.map(|a| ("agent_access", json!(a))));
    p = db::update_profile(&c, &p.id, &fields)?.ok_or_else(|| ApiError::not_found("profile"))?;
    drop(c);
    std::fs::create_dir_all(s.profile_scratch_dir(&p.id)).ok();
    s.emit(json!({"type": "profiles_changed"}));
    Ok(Json(json!(p)))
}

pub(super) async fn update_profile(State(s): State<Shared>, Path(id): Path<String>, Json(b): Json<Map<String, Value>>) -> ApiResult<Json<Value>> {
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
    for key in ["limit_wait", "limit_switch", "merge_approval"] {
        if let Some(v) = b.get(key) {
            fields.push((key, json!(v.as_bool().ok_or_else(|| ApiError::bad(format!("{key} must be true or false")))?)));
        }
    }
    // Either may name a config deleted since it was saved, as both are sent with every save.
    let saved: Vec<&db::Reviewer> = current.reviewers.iter().chain(&current.summarizer).collect();
    if let Some(v) = b.get("reviewers") {
        fields.push(("reviewers", reviewers_value(&c, v, true, &saved)?));
    }
    if let Some(v) = b.get("summarizer") {
        fields.push(("summarizer", summarizer_value(&c, v, true, &saved)?));
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
pub(super) struct AsanaSearch {
    #[serde(default)]
    q: String,
}

/// `GET /profiles/{id}/asana/tasks?q=`: the Asana tasks the profile's token finds for `q` (a
/// search, or a task's URL), for linking a task to one (API 57).
pub(super) async fn asana_tasks(State(s): State<Shared>, Path(id): Path<String>, Query(q): Query<AsanaSearch>) -> ApiResult<Json<Value>> {
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
pub(super) fn check_github_account(v: &Value) -> ApiResult<Value> {
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
pub(super) async fn github_accounts() -> ApiResult<Json<Value>> {
    Ok(Json(json!(crate::gh_mcp::accounts().await)))
}

#[derive(Deserialize)]
pub(super) struct GithubReposQuery {
    /// The GitHub account to act as (see `check_github_account`); gh's active one without it.
    account: Option<String>,
    /// Finds the repositories named like this, its organizations' too (see github::list).
    q: Option<String>,
}

/// The GitHub repositories an account can clone, for adding one as a project (API 55).
pub(super) async fn github_repos(Query(q): Query<GithubReposQuery>) -> ApiResult<Json<Value>> {
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
pub(super) async fn check_base_branch(v: &Value) -> ApiResult<Value> {
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

pub(super) fn check_agent_access(own_name: &str, v: &Value) -> ApiResult<Vec<String>> {
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
pub(super) fn check_config_ids(c: &rusqlite::Connection, ids: Vec<String>) -> ApiResult<Vec<String>> {
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

/// Reviewers, with blank fields as None and each config checked, except those in `saved` (the
/// ones already saved), which may have been deleted since: their reviews fall back to the task's
/// config, and saving other changes keeps them.
fn check_reviewers(c: &rusqlite::Connection, list: Vec<db::Reviewer>, saved: &[&db::Reviewer]) -> ApiResult<Vec<db::Reviewer>> {
    if list.len() > crate::review::MAX_REVIEWERS {
        return Err(ApiError::bad(format!("there can be at most {} reviewers", crate::review::MAX_REVIEWERS)));
    }
    let blank = |v: Option<String>| v.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    let mut out = Vec::new();
    for r in list {
        let r = db::Reviewer { claude_config_id: blank(r.claude_config_id), model: blank(r.model), effort: blank(r.effort) };
        if let Some(id) = &r.claude_config_id {
            if !saved.iter().any(|s| s.claude_config_id.as_ref() == Some(id)) && db::get_claude_config(c, id)?.is_none() {
                return Err(ApiError::bad(format!("no Claude config {id}")));
            }
        }
        out.push(r);
    }
    Ok(out)
}

/// A project's or profile's `reviewers` as saved: checked, and null when it's empty. With
/// `defaults_too`, just one reviewer with the defaults is null too (a profile's, which is the same);
/// a project's is kept, so it reviews with the task's config rather than the profile's reviewers.
pub(super) fn reviewers_value(c: &rusqlite::Connection, v: &Value, defaults_too: bool, saved: &[&db::Reviewer]) -> ApiResult<Value> {
    let list: Option<Vec<db::Reviewer>> =
        serde_json::from_value(v.clone()).map_err(|_| ApiError::bad("reviewers must be null or a list of {claude_config_id, model, effort}"))?;
    let list = list.map(|l| check_reviewers(c, l, saved)).transpose()?.filter(|l| !l.is_empty() && !(defaults_too && *l == [db::Reviewer::default()]));
    Ok(json!(list.map(|l| json!(l).to_string())))
}

/// A project's or profile's `summarizer` as saved, checked. With `defaults_too`, one with the
/// defaults is null (a profile's); a project's is kept, so it summarises with the task's config
/// rather than the profile's summarizer.
pub(super) fn summarizer_value(c: &rusqlite::Connection, v: &Value, defaults_too: bool, saved: &[&db::Reviewer]) -> ApiResult<Value> {
    let spec: Option<db::Reviewer> =
        serde_json::from_value(v.clone()).map_err(|_| ApiError::bad("summarizer must be null or {claude_config_id, model, effort}"))?;
    let spec = spec.map(|r| check_reviewers(c, vec![r], saved)).transpose()?.and_then(|l| l.into_iter().next()).filter(|r| !(defaults_too && *r == db::Reviewer::default()));
    Ok(json!(spec.map(|r| json!(r).to_string())))
}
