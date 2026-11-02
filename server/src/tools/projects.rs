//! The project tools: creating projects and changing their settings.

use super::*;

/// The project an agent names (on a board it can use), or its own.
pub(super) fn project_or_own(s: &Shared, ctx: &Ctx, pid: Option<String>, profile: Option<&str>, own: Option<String>) -> std::result::Result<db::Project, ToolError> {
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
pub(super) const AGENT_FIELDS: &[&str] = &[
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
pub(super) async fn update_project(s: &Shared, ctx: &Ctx, p: &db::Project, args: &Value, reason: Option<String>) -> std::result::Result<db::Project, ToolError> {
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
pub(super) async fn project_creation(s: &Shared, ctx: &Ctx, board: &db::Profile, name: Option<String>, repo_path: &str, reason: Option<String>) -> ToolResult {
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
pub(super) async fn create_project(s: &Shared, ctx: &Ctx, input: &Value) -> ToolResult {
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
pub(super) async fn apply_changes(s: &Shared, p: &db::Project, apply: &Value) -> std::result::Result<db::Project, ToolError> {
    match apply.as_object() {
        Some(apply) if !apply.is_empty() => Ok(api::update_project_inner(s, &p.id, apply).await?),
        _ => Ok(p.clone()),
    }
}
