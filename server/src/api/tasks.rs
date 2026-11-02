//! Tasks: listing, reading, updating and deleting them.

use super::*;

// ---------- tasks ----------

#[derive(Deserialize)]
pub(super) struct TaskListQuery {
    kind: Option<String>,
}

pub(super) async fn list_project_tasks(State(s): State<Shared>, Path(id): Path<String>, Query(q): Query<TaskListQuery>) -> ApiResult<Json<Value>> {
    let kind = q.kind.unwrap_or_else(|| "task".into());
    let c = s.db();
    if db::get_project(&c, &id)?.is_none() {
        return Err(ApiError::not_found("project"));
    }
    Ok(Json(json!(db::list_tasks_for_project(&c, &id, &kind)?)))
}

pub(super) async fn list_profile_tasks(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(json!(db::list_tasks_for_profile(&s.db(), &id)?)))
}

pub(super) async fn list_profile_scratch(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(json!(db::list_profile_scratch(&s.db(), &id)?)))
}

pub(super) async fn list_group_tasks(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(json!(db::list_group_tasks(&s.db(), &id)?)))
}

pub(super) async fn get_task(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
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

pub(super) async fn update_task(State(s): State<Shared>, Path(id): Path<String>, Json(b): Json<Map<String, Value>>) -> ApiResult<Json<Value>> {
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
    // Waiting for the user's approval, it isn't in the queue to step out of.
    if remerge && crate::merge_gate::is_pending(&current) {
        return Err(ApiError::bad("the merge hasn't been approved yet, so it isn't in the merge queue to step out of: summarize what will be merged and end your turn"));
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
        // Moved there again, a merge that needs approval is summarised again (see merge_gate.rs),
        // unless it's approved already (stepping out to make changes keeps it).
        if merge && current.merge_approval.as_deref() != Some(crate::merge_gate::APPROVED) {
            fields.push(("merge_approval", Value::Null));
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
    // The approval it waited for is asked again, or not at all.
    if crate::merge_gate::is_pending(&current) && !crate::merge_gate::is_pending(&t) {
        crate::merge_gate::settle(s, id, "replaced");
    }
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
pub(super) struct PreviewQuery {
    url: String,
}

/// Whether a task's preview URL answers 200. Checked from here rather than the browser,
/// which can't read the status of a cross-origin response.
pub(super) async fn preview_status(Query(q): Query<PreviewQuery>) -> ApiResult<Json<Value>> {
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
pub(super) struct DeleteQuery {
    #[serde(default)]
    delete_branch: bool,
}

pub(super) async fn delete_task(State(s): State<Shared>, Path(id): Path<String>, Query(q): Query<DeleteQuery>) -> ApiResult<Json<Value>> {
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
    crate::task_tmp::deleted(s, &t.id).await;
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
