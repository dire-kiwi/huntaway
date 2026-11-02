//! Changes that wait for the user's approval in the agent's thread: asking, carrying on once
//! answered, and deleting tasks.

use super::*;

/// Carries on with the approval `saved` that this call asked for before it was retried: waits
/// for the answer if there isn't one yet, then makes exactly what was asked, if approved.
pub(super) async fn resume_approval(s: &Shared, ctx: &Ctx, saved: &Value) -> ToolResult {
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
pub(super) async fn ask_user(s: &Shared, ctx: &Ctx, tool: &str, input: &Value) -> std::result::Result<Value, ToolError> {
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
pub(super) fn deletion(s: &Shared, ctx: &Ctx, t: &Task, delete_branch: bool, reason: Option<String>) -> ToolResult {
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
pub(super) async fn delete_task(s: &Shared, ctx: &Ctx, input: &Value) -> ToolResult {
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

/// The project a change is to, as the approval shows it.
pub(super) fn approval_project(s: &Shared, p: &db::Project) -> Value {
    json!({"id": p.id, "key": p.key, "name": p.name, "host": s.host_name})
}

/// The thread asking for a change, as the approval shows it.
pub(super) fn approval_task(s: &Shared, ctx: &Ctx) -> Value {
    match &ctx.task {
        Some(t) if t.kind == "task" => json!({"id": t.id, "key": format!("{}-{}", project_key(s, t), t.number), "title": t.title}),
        Some(t) => json!({"id": t.id, "title": t.title}),
        None => Value::Null,
    }
}
