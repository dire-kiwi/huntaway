//! Finding the boards, projects and tasks a call names: by id or key, on the caller's board or another
//! profile's.

use super::*;

pub(super) fn project_json(s: &Shared, p: &db::Project, board: &db::Profile) -> Value {
    json!({"id": p.id, "key": p.key, "name": p.name, "repo_path": p.repo_path, "profile": board.name, "host": s.host_name})
}

/// `get_project`: a project's settings, with each prompt's instructions in effect and whether
/// they're the default.
pub(super) fn project_settings_json(s: &Shared, p: &db::Project, board: &db::Profile) -> Value {
    let mut out = project_json(s, p, board);
    out["former_keys"] = json!(p.former_keys);
    out["base_branch"] = json!(p.base_branch);
    out["model"] = json!(p.model);
    out["permission_mode"] = json!(p.permission_mode);
    out["use_worktrees"] = json!(p.use_worktrees);
    out["worktrees_root"] = json!(p.worktrees_root);
    out["setup_script"] = json!(p.setup_script);
    out["teardown_script"] = json!(p.teardown_script);
    out["copy_files"] = json!(p.copy_files);
    out["link_folders"] = json!(p.link_folders);
    out["status_script"] = json!(p.status_script);
    out["status_scripts"] = json!(p.status_scripts);
    out["is_git"] = json!(p.is_git);
    out["auto_review"] = json!(p.auto_review);
    out["review_rounds"] = json!(p.review_rounds);
    out["pull_requests"] = json!(p.pull_requests);
    out["subproject_pull_requests"] = json!(p.subproject_pull_requests);
    out["watch_pull_requests"] = json!(p.watch_pull_requests);
    out["pr_preview_url"] = json!(p.pr_preview_url);
    out["reviewers"] = json!(p.reviewers);
    out["auto_summary"] = json!(p.auto_summary);
    out["summarizer"] = json!(p.summarizer);
    // What the project's empty reviewers and null summarizer use.
    out["profile_reviewers"] = json!(board.reviewers);
    out["profile_summarizer"] = json!(board.summarizer);
    out["group_name"] = json!(p.group_name);
    out["archived"] = json!(p.archived_at.is_some());
    let own = [&p.start_prompt, &p.review_prompt, &p.merge_prompt];
    let texts = [crate::prompts::start(Some(p)), crate::prompts::review(Some(p)), crate::prompts::merge(Some(p))];
    for (((k, _), own), text) in crate::prompts::FIELDS.iter().zip(own).zip(texts) {
        out[*k] = json!({"instructions": text, "default": own.is_none()});
    }
    out
}

/// The boards the caller can use on this host: its own profile's first, then the profiles
/// that let its agents in.
pub(super) fn boards(s: &Shared, ctx: &Ctx) -> std::result::Result<Vec<db::Profile>, ToolError> {
    let mut all: Vec<db::Profile> = db::list_profiles(&s.db())?.into_iter().filter(|p| ctx.is_own(p) || p.grants(&ctx.profile_name)).collect();
    all.sort_by_key(|p| !ctx.is_own(p));
    Ok(all)
}

/// The board named by a `profile` argument or prefix (all of them for none or "all").
pub(super) fn pick_boards(s: &Shared, ctx: &Ctx, profile: Option<&str>) -> std::result::Result<Vec<db::Profile>, ToolError> {
    let all = boards(s, ctx)?;
    let Some(name) = profile.filter(|p| *p != "all") else { return Ok(all) };
    let named = |p: &db::Profile| p.name.eq_ignore_ascii_case(name) || p.id == name;
    if let Some(b) = all.into_iter().find(named) {
        return Ok(vec![b]);
    }
    // Not found, so that linked hosts are tried too.
    Err(ToolError::NotFound(if db::list_profiles(&s.db())?.iter().any(named) {
        format!(
            "profile {name}'s board on {} doesn't let agents in profile {} use it. Ask the user: they can allow it in Settings → Profiles (edit {name}, \"Agents from other profiles\")",
            s.host_name, ctx.profile_name
        )
    } else {
        format!("profile {name}")
    }))
}

/// `work:SD-3` → (Some("work"), "SD-3"), if a profile here is named `work` (or it's `all`). Ids and
/// keys have no colons, but a project's name may: "Ops: infra" is a name unless there's a profile `Ops`.
fn split_ref<'a>(s: &Shared, r: &'a str) -> std::result::Result<(Option<&'a str>, &'a str), ToolError> {
    let Some((p, rest)) = r.split_once(':').filter(|(p, _)| !p.is_empty()) else { return Ok((None, r)) };
    // Any profile here, not only those that let the caller in, so pick_boards can say it doesn't.
    // One only on a linked host isn't found here either way, so the call goes on to that host.
    let profile = p == "all" || db::list_profiles(&s.db())?.iter().any(|b| b.name.eq_ignore_ascii_case(p) || b.id == p);
    Ok(if profile { (Some(p), rest) } else { (None, r) })
}

/// One of the matches on the caller's boards: on its own board if it's there, else the only one.
fn pick_one<T>(ctx: &Ctx, what: &str, mut found: Vec<(db::Profile, T)>, qualified: impl Fn(&db::Profile) -> String) -> std::result::Result<T, ToolError> {
    if let Some(i) = found.iter().position(|(b, _)| ctx.is_own(b)) {
        return Ok(found.swap_remove(i).1);
    }
    match found.len() {
        0 => Err(ToolError::NotFound(what.to_string())),
        1 => Ok(found.remove(0).1),
        _ => {
            let names: Vec<String> = found.iter().map(|(b, _)| qualified(b)).collect();
            Err(ToolError::Other(format!("{what} is on more than one profile's board: name one of {} (or pass profile)", names.join(", "))))
        }
    }
}

/// A project named by an agent: its id, key or name, optionally as `<profile>:<key>`.
pub(super) fn resolve_project(s: &Shared, ctx: &Ctx, r: &str, profile: Option<&str>) -> std::result::Result<db::Project, ToolError> {
    // A name with a colon ("Ops: infra") is a project's on the caller's boards before it's a key on
    // profile Ops's, which they may not even reach.
    if r.contains(':')
        && let Ok(boards) = pick_boards(s, ctx, profile)
    {
        let mut found = Vec::new();
        for b in boards {
            let named = db::list_projects(&s.db(), &b.id)?.into_iter().find(|p| p.name.eq_ignore_ascii_case(r));
            found.extend(named.map(|p| (b, p)));
        }
        if !found.is_empty() {
            return pick_one(ctx, &format!("project {r}"), found, |b| format!("{}:{r}", b.name));
        }
    }
    let (prefix, key) = split_ref(s, r)?;
    let boards = pick_boards(s, ctx, prefix.or(profile))?;
    if let Some(p) = db::get_project(&s.db(), key)?.filter(|p| boards.iter().any(|b| b.id == p.profile_id)) {
        return Ok(p);
    }
    let mut found = Vec::new();
    for b in boards {
        let projects = db::list_projects(&s.db(), &b.id)?;
        let p = projects.iter().find(|p| p.key.eq_ignore_ascii_case(key) || p.name.eq_ignore_ascii_case(key));
        let p = p.or_else(|| projects.iter().find(|p| p.former_keys.iter().any(|f| f.eq_ignore_ascii_case(key))));
        if let Some(p) = p.cloned() {
            found.push((b, p));
        }
    }
    pick_one(ctx, &format!("project {r}"), found, |b| format!("{}:{key}", b.name))
}

pub(super) fn project_key(s: &Shared, t: &Task) -> String {
    runner::task_key_prefix(s, t)
}

/// A subproject named by an agent (task id or key).
pub(super) fn subproject_arg(s: &Shared, ctx: &Ctx, id: &str, profile: Option<&str>) -> std::result::Result<Task, ToolError> {
    let t = resolve_task(s, ctx, id, profile)?;
    if !t.subproject {
        return Err(ToolError::Other(format!("{id} is not a subproject")));
    }
    Ok(t)
}

/// The tasks named in a `depends_on` argument (ids or keys), as ids. None if it wasn't given.
pub(super) fn dependency_ids(s: &Shared, ctx: &Ctx, v: &Value, profile: Option<&str>) -> std::result::Result<Option<Vec<String>>, ToolError> {
    if v.is_null() {
        return Ok(None);
    }
    let refs = v.as_array().ok_or_else(|| ToolError::Other("depends_on must be a list of task ids or keys".into()))?;
    let mut ids = Vec::new();
    for r in refs {
        let r = r.as_str().ok_or_else(|| ToolError::Other("depends_on must be a list of task ids or keys".into()))?;
        ids.push(resolve_task(s, ctx, r, profile)?.id);
    }
    Ok(Some(ids))
}

/// A task named by an agent: its id or a key like `ABC-12`, optionally as `<profile>:ABC-12`.
pub(super) fn resolve_task(s: &Shared, ctx: &Ctx, r: &str, profile: Option<&str>) -> std::result::Result<Task, ToolError> {
    let (prefix, id) = split_ref(s, r)?;
    let boards = pick_boards(s, ctx, prefix.or(profile))?;
    // Not a review thread, as by its key: an agent's tools only reach tasks.
    if let Some(t) = db::get_task(&s.db(), id)?.filter(|t| t.kind == "task" && boards.iter().any(|b| b.id == t.profile_id)) {
        return Ok(t);
    }
    let mut found = Vec::new();
    if let Some((k, n)) = id.rsplit_once('-')
        && let Ok(n) = n.parse::<i64>()
    {
        for b in boards {
            // No project has the group or scratch tasks' keys (see db::free_task_key).
            if k.eq_ignore_ascii_case(runner::GROUP_TASK_KEY) {
                let t = db::group_task_by_number(&s.db(), &b.id, n)?;
                found.extend(t.map(|t| (b, t)));
                continue;
            }
            if k.eq_ignore_ascii_case(db::SCRATCH_TASK_KEY) {
                let t = db::scratch_task_by_number(&s.db(), &b.id, n)?;
                found.extend(t.map(|t| (b, t)));
                continue;
            }
            // A key a project had before still names its tasks. No other project can take it (see
            // api::check_key), so more than one is from before that, and naming either would be a guess.
            let projects = db::list_projects(&s.db(), &b.id)?;
            let mut here = Vec::new();
            for p in projects.iter().filter(|p| p.key.eq_ignore_ascii_case(k) || p.former_keys.iter().any(|f| f.eq_ignore_ascii_case(k))) {
                if let Some(t) = db::list_tasks_for_project(&s.db(), &p.id, "task")?.into_iter().find(|t| t.number == n) {
                    here.push((p, t));
                }
            }
            if here.len() > 1 {
                let ids: Vec<String> = here.iter().map(|(p, t)| format!("{} (id {}, in {})", t.title, t.id, p.name)).collect();
                return Err(ToolError::Other(format!("task {r} could be more than one task: {}; name it by its id", ids.join(", "))));
            }
            found.extend(here.into_iter().map(|(_, t)| (b.clone(), t)));
        }
    }
    pick_one(ctx, &format!("task {r}"), found, |b| format!("{}:{id}", b.name))
}
