//! Creating tasks: a project's, scratch tasks and group tasks.

use super::*;

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
    /// agent/documents.rs).
    #[serde(default)]
    pub labels: Option<Value>,
    /// The tasks elsewhere it's for (see `check_external_links`).
    #[serde(default)]
    pub external_links: Option<Value>,
    /// Shared by the tasks made together from one prompt, each run by another agent (see
    /// db::Task::fanout_id).
    #[serde(default)]
    pub fanout_id: Option<String>,
    /// What its worktree starts from, if not the project's base branch (see `check_start_from`).
    #[serde(default)]
    pub start_from: Option<Value>,
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
    let labels = crate::agent::documents::check_labels(&Value::Array(asked)).map_err(ApiError::bad)?;
    Ok((!labels.is_empty()).then(|| ("labels", json!(labels))))
}

pub(super) async fn create_scratch_task(State(s): State<Shared>, Path(id): Path<String>, Json(b): Json<CreateTask>) -> ApiResult<Json<Value>> {
    let prompted = is_prompt(&b);
    Ok(Json(json!(prompted_now(&s, prompted, create_scratch_task_inner(&s, &id, b)?))))
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

/// Whether the task starts with a prompt the user wrote: a `start` that's text, or `start: true` (what the board's
/// new task dialog sends) to start from the description they typed. Not a bare start with nothing to say.
fn is_prompt(b: &CreateTask) -> bool {
    match &b.start {
        Some(Value::String(p)) => !p.trim().is_empty(),
        Some(Value::Bool(true)) => !b.description.trim().is_empty(),
        _ => false,
    }
}

/// A task made with the user's own prompt, from the board, is in "now" like one they prompt later. Not the ones
/// automations make (they go through `create_task_inner` directly), which start in "later"; agents' `create_task` puts its tasks in "now"
/// itself (see mcp::tools::tasks::new_in_now).
fn prompted_now(s: &Shared, prompted: bool, t: db::Task) -> db::Task {
    if prompted { crate::agent::focus::put_in_now(s, &t.id).unwrap_or(t) } else { t }
}

#[derive(Deserialize)]
pub(super) struct CreateGroupTask {
    /// The group (of the profile's projects) the task plans for.
    pub(super) group: String,
    #[serde(flatten)]
    pub(super) task: CreateTask,
}

/// `POST /profiles/{id}/group-tasks`: a group task, which plans work across a group's projects
/// and creates their tasks (see db::Task::group_name).
pub(super) async fn create_group_task(State(s): State<Shared>, Path(id): Path<String>, Json(b): Json<CreateGroupTask>) -> ApiResult<Json<Value>> {
    if db::get_profile(&s.db(), &id)?.is_none() {
        return Err(ApiError::not_found("profile"));
    }
    let group = b.group.trim();
    if group.is_empty() || db::group_projects(&s.db(), &id, group)?.is_empty() {
        return Err(ApiError::bad("group must name a group of the profile's projects"));
    }
    let b = b.task;
    let prompted = is_prompt(&b);
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
        return Ok(Json(json!(prompted_now(&s, prompted, t))));
    }
    Ok(Json(json!(prompted_now(
        &s,
        prompted,
        match start {
            Some(p) => runner::send(&s, &t.id, &p)?,
            None => t,
        }
    ))))
}

pub(super) async fn create_task(State(s): State<Shared>, Path(project_id): Path<String>, Json(b): Json<CreateTask>) -> ApiResult<Json<Value>> {
    let prompted = is_prompt(&b);
    Ok(Json(json!(prompted_now(&s, prompted, create_task_inner(&s, &project_id, b)?))))
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
    // scratch task works in its own folder instead (see agent/documents.rs).
    let use_worktree =
        kind == "task" && task_type.is_none() && (subproject || parent.is_some() || b.use_worktree.unwrap_or(project.use_worktrees && project.is_git));
    let effort = b.effort.as_deref().filter(|e| !e.is_empty());
    if effort.is_some_and(|e| !db::THREAD_EFFORTS.contains(&e)) {
        return Err(ApiError::bad(format!("effort must be one of {:?}", db::THREAD_EFFORTS)));
    }
    let config = pick_config(&s.db(), &project.profile_id, Some(&project), b.claude_config_id.as_deref())?;
    let start_from = match &b.start_from {
        Some(v) => check_start_from(&s.db(), &project, None, v)?,
        None => None,
    };
    if start_from.is_some() && parent.is_some() {
        return Err(ApiError::bad("start_from: a subproject's tasks start from its branch"));
    }
    if start_from.is_some() && !use_worktree {
        return Err(ApiError::bad("start_from is for a task with a worktree"));
    }
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
    if let Some(sf) = &start_from {
        fields.push(("start_from", json!(sf)));
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

/// What a task's worktree starts from (see db::StartFrom), as `start_from` gives it for a task
/// in `project` (`task_id`, if it exists): null (or blank) for the project's base branch, an
/// object as tasks have it, or text. Text is `task:`, `branch:`, `pr:` or `commit:` and what it
/// names, or without one of those: a task's key (or id) in the project, `#12` or a pull
/// request's URL, a commit's SHA (7 to 40 hex digits), or else a branch, local or on a remote
/// (`origin/feature`). Whether the branch or commit is there is found out as the worktree is
/// made, after fetching.
pub fn check_start_from(c: &rusqlite::Connection, project: &db::Project, task_id: Option<&str>, v: &Value) -> ApiResult<Option<db::StartFrom>> {
    use db::StartFrom;
    let bad = |m: String| ApiError::bad(format!("start_from: {m}"));
    let sf = match v {
        Value::Null => return Ok(None),
        Value::String(text) => {
            let text = text.trim();
            if text.is_empty() {
                return Ok(None);
            }
            let (kind, what) = match text.split_once(':') {
                Some((k, rest)) if ["task", "branch", "pr", "commit"].contains(&k) => (Some(k), rest.trim()),
                _ => (None, text),
            };
            let hex = |w: &str| (7..=40).contains(&w.len()) && w.bytes().all(|b| b.is_ascii_hexdigit());
            let pr = |w: &str| -> Option<(u64, Option<String>)> {
                if let Some(n) = w.strip_prefix('#').or(Some(w).filter(|_| kind == Some("pr"))) {
                    return n.parse().ok().map(|n| (n, None));
                }
                // https://github.com/OWNER/REPO/pull/12, with anything after it (`/files`, `#discussion…`).
                let path = w.strip_prefix("https://").or_else(|| w.strip_prefix("http://"))?.split_once('/')?.1;
                let parts: Vec<&str> = path.split(['/', '#', '?']).collect();
                match parts[..] {
                    [owner, repo, "pull", n, ..] if !owner.is_empty() && !repo.is_empty() => n.parse().ok().map(|n| (n, Some(format!("{owner}/{repo}")))),
                    _ => None,
                }
            };
            match kind {
                Some("task") => StartFrom::Task { task_id: find_task(c, project, what)?.ok_or_else(|| bad(format!("no task {what} in {}", project.name)))?.id },
                Some("pr") => {
                    let (number, repo) = pr(what).ok_or_else(|| bad(format!("{what:?} isn't a pull request's number or URL")))?;
                    StartFrom::PullRequest { number, repo }
                }
                Some("commit") if hex(what) => StartFrom::Commit { commit: what.to_ascii_lowercase() },
                Some("commit") => return Err(bad(format!("{what:?} isn't a commit's SHA (7 to 40 hex digits)"))),
                Some(_) => StartFrom::Branch { branch: what.to_string() },
                None => match (find_task(c, project, what)?, pr(what)) {
                    (Some(t), _) => StartFrom::Task { task_id: t.id },
                    (None, Some((number, repo))) => StartFrom::PullRequest { number, repo },
                    _ if hex(what) => StartFrom::Commit { commit: what.to_ascii_lowercase() },
                    _ => StartFrom::Branch { branch: what.to_string() },
                },
            }
        }
        Value::Object(_) => serde_json::from_value(v.clone()).map_err(|e| bad(format!("{e}")))?,
        _ => return Err(bad("must be null, a string or an object".into())),
    };
    match &sf {
        StartFrom::Branch { branch } if !worktree::valid_branch_name(branch) => return Err(bad(format!("{branch:?} isn't a valid branch name"))),
        StartFrom::Commit { commit } if !((7..=40).contains(&commit.len()) && commit.bytes().all(|b| b.is_ascii_hexdigit())) => {
            return Err(bad(format!("{commit:?} isn't a commit's SHA (7 to 40 hex digits)")));
        }
        StartFrom::PullRequest { number: 0, .. } => return Err(bad("a pull request's number starts at 1".into())),
        StartFrom::Task { task_id: other } => {
            let t = db::get_task(c, other)?.ok_or_else(|| bad(format!("no task {other}")))?;
            if t.kind != "task" || t.project_id.as_deref() != Some(&project.id) {
                return Err(bad(format!("\"{}\" isn't a task in the same project", t.title)));
            }
            if Some(t.id.as_str()) == task_id {
                return Err(bad("a task can't start from itself".into()));
            }
            if t.is_scratch() || crate::agent::documents::documents_only(&t) || !(t.use_worktree || t.branch.is_some()) {
                return Err(bad(format!("\"{}\" has no branch of its own to start from", t.title)));
            }
            // Nor from a task whose worktree (by way of others) needs this one's first: one that
            // starts from it, or is in it as a subproject (each sets the other up first, see
            // worktree::setup).
            if let Some(task_id) = task_id {
                let mut stack = vec![t.clone()];
                let mut seen = vec![t.id.clone()];
                while let Some(next) = stack.pop() {
                    let needs = [
                        match &next.start_from {
                            Some(StartFrom::Task { task_id: id }) => Some(id.clone()),
                            _ => None,
                        },
                        next.parent_id.clone(),
                    ];
                    for id in needs.into_iter().flatten() {
                        if id == task_id {
                            return Err(bad(format!("\"{}\" needs this task's worktree first (it starts from it, or is in it)", t.title)));
                        }
                        if !seen.contains(&id) {
                            seen.push(id.clone());
                            stack.extend(db::get_task(c, &id)?);
                        }
                    }
                }
            }
        }
        _ => {}
    }
    Ok(Some(sf))
}

/// The task in `project` that `word` names: its id, or its key (with the project's key, or one it
/// had before), in any case.
fn find_task(c: &rusqlite::Connection, project: &db::Project, word: &str) -> ApiResult<Option<db::Task>> {
    if let Some(t) = db::get_task(c, word)?.filter(|t| t.project_id.as_deref() == Some(&project.id)) {
        return Ok(Some(t));
    }
    let Some((key, n)) = word.rsplit_once('-') else { return Ok(None) };
    let (Ok(n), true) = (n.parse::<i64>(), std::iter::once(&project.key).chain(&project.former_keys).any(|k| k.eq_ignore_ascii_case(key))) else {
        return Ok(None);
    };
    Ok(db::list_tasks_for_project(c, &project.id, "task")?.into_iter().find(|t| t.number == n))
}
