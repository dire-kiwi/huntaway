//! Projects: creating, importing, editing, archiving and relocating them.

use super::*;

// ---------- projects ----------

#[derive(Deserialize)]
pub(super) struct ProjectListQuery {
    /// Lists the archived projects instead of the others (API 46).
    #[serde(default)]
    pub(super) archived: bool,
}

pub(super) async fn list_projects(State(s): State<Shared>, Path(id): Path<String>, Query(q): Query<ProjectListQuery>) -> ApiResult<Json<Value>> {
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

pub(super) async fn create_project(State(s): State<Shared>, Path(profile_id): Path<String>, Json(b): Json<CreateProject>) -> ApiResult<Json<Value>> {
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

pub(super) async fn clone_project(State(s): State<Shared>, Path(profile_id): Path<String>, Json(b): Json<CloneProject>) -> ApiResult<Json<Value>> {
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

pub(super) async fn get_project(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let p = db::get_project(&s.db(), &id)?.ok_or_else(|| ApiError::not_found("project"))?;
    Ok(Json(json!(p)))
}

pub(super) async fn update_project(State(s): State<Shared>, Path(id): Path<String>, Json(b): Json<Map<String, Value>>) -> ApiResult<Json<Value>> {
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
            "worktrees_root", "auto_review", "review_rounds", "reviewers", "auto_summary", "summarizer", "claude_config_ids", "start_prompt", "review_prompt", "merge_prompt", "group_name",
            "archived",
            "merge_approval",
            "github_account",
            "done_when_merged",
            "pull_requests",
            "subproject_pull_requests",
            "watch_pull_requests",
            "pr_preview_url",
            "copy_files",
            "link_folders",
        ],
    );
    // Configs deleted since they were saved, here or in the profile's (which the project's
    // settings start from when it takes its own), are kept (see check_reviewers).
    let profile = db::get_profile(&s.db(), &before.profile_id)?;
    let from_profile = profile.iter().flat_map(|p| p.reviewers.iter().chain(&p.summarizer));
    let saved_reviewers: Vec<&db::Reviewer> = before.reviewers.iter().chain(&before.summarizer).chain(from_profile).collect();
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
            // null follows the profile's.
            "merge_approval" if !(v.is_null() || v.is_boolean()) => return Err(ApiError::bad("merge_approval must be null, true or false")),
            "use_worktrees" | "auto_review" | "auto_summary" | "done_when_merged" | "pull_requests" | "subproject_pull_requests" if !v.is_boolean() => {
                return Err(ApiError::bad(format!("{k} must be true or false")));
            }
            "review_rounds" if !v.as_u64().is_some_and(|n| n <= 20) => {
                return Err(ApiError::bad("review_rounds must be a whole number from 0 to 20"));
            }
            // null (or an empty list) uses the profile's reviewers.
            "reviewers" => *v = reviewers_value(&s.db(), v, false, &saved_reviewers)?,
            // null uses the profile's summarizer.
            "summarizer" => *v = summarizer_value(&s.db(), v, false, &saved_reviewers)?,
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

pub(super) async fn delete_project(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
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
pub(super) fn remove_unused_dir(s: &Shared, dir: &std::path::Path, what: &str) -> ApiResult<()> {
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
