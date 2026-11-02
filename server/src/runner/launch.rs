//! Launching a run: preparing its worktree, prompt, MCP config and sandbox, then starting the agent.

use super::*;

/// Prepare the working directory and start claude.
pub(super) async fn launch(state: &Shared, run: &Run, text: &str) -> Result<()> {
    let task_id = run.task_id.as_str();
    // Not in the folder the project is moving from.
    let project_id = db::get_task(&state.db(), task_id)?.and_then(|t| t.project_id);
    if let Some(pid) = &project_id {
        crate::relocate::settled(state, pid).await;
    }
    let (mut task, project, profile) = load(state, task_id)?;
    // `/plan` gives the task the plan label, if it was sent some other way than `send_run`.
    if task.kind == "task" && run.kind != "compact" && crate::documents::plan_command(text).is_some() {
        task = crate::documents::add_plan(state, &task)?;
    }
    // A thread created while its profile had no configs takes the default it has now, and
    // keeps it from here on with its conversation.
    if task.claude_config_id.is_none() && task.session_id.is_none() {
        let config = db::task_claude_config(&state.db(), &task)?;
        if let Some(config) = config {
            task = state.update_task(task_id, &[("claude_config_id", json!(config.id))])?.ok_or_else(|| anyhow!("task not found"))?;
        }
    }
    // A review thread works on the task it reviews; a task may be part of a subproject.
    let parent = match &task.parent_id {
        Some(id) => db::get_task(&state.db(), id)?,
        None => None,
    };

    // Resolve the working directory for this thread.
    let mut add_dirs: Vec<String> = Vec::new();
    // (`work_dir` says the same for a thread whose run is going.)
    let doc_dir = crate::documents::work_dir(state, &task);
    let cwd: String = match (task.kind.as_str(), &project) {
        // A scratch task works in its own folder, reading its project if it's in one, as does a
        // task that makes only documents (see documents::documents_only). One in a subproject
        // reads the subproject's worktree as well.
        (_, p) if doc_dir.is_some() => {
            add_dirs.extend(p.as_ref().map(|p| p.repo_path.clone()));
            if let Some(sp) = parent.as_ref().filter(|t| task.kind == "task" && t.subproject && t.worktree_state == "ready") {
                add_dirs.extend(sp.worktree_path.clone());
            }
            doc_dir.as_deref().map(path_str).unwrap_or_default()
        }
        ("review", Some(p)) => match &parent {
            Some(t) if t.worktree_state == "ready" => t.worktree_path.clone().context("worktree path missing")?,
            Some(t) if t.use_worktree => anyhow::bail!("the task's worktree isn't set up"),
            _ => p.repo_path.clone(),
        },
        (_, Some(_)) if task.use_worktree => {
            if task.worktree_state != "ready" {
                state.add_event(task_id, "info", "Setting up worktree…", None);
            }
            task = worktree::setup(state, task_id).await?;
            task.worktree_path.clone().context("worktree path missing")?
        }
        (_, Some(p)) => p.repo_path.clone(),
        (_, None) => path_str(&state.profile_scratch_dir(&profile.id)),
    };
    // A group task plans across its group's projects, so it can read their repositories.
    let group = match (&task.group_name, &project) {
        (Some(g), None) if task.kind == "task" => db::group_projects(&state.db(), &task.profile_id, g)?,
        _ => Vec::new(),
    };
    add_dirs.extend(group.iter().map(|p| p.repo_path.clone()));
    tokio::fs::create_dir_all(crate::util::expand_tilde(&cwd)).await.ok();
    // A checkpoint of the worktree before the agent changes it (see checkpoints.rs), taken after
    // any rewind asked for meanwhile, whose conversation rollback this run makes.
    crate::checkpoints::before_run(state, &task, run).await;
    task = db::get_task(&state.db(), task_id)?.ok_or_else(|| anyhow!("task not found"))?;
    let rewind = crate::checkpoints::pending_rewind(&task).cloned();
    // A labelled task's agent writes its documents in the task's own folder, wherever it works.
    let documents: Vec<(&str, String)> = crate::documents::paths(state, &task).into_iter().map(|(l, p)| (l, path_str(&p))).collect();
    let own_dir = crate::documents::dir(state, &task.id);
    let own_dir = (!documents.is_empty() && doc_dir.as_ref() != Some(&own_dir)).then(|| path_str(&own_dir));
    if let Some(d) = &own_dir {
        tokio::fs::create_dir_all(d).await.ok();
        add_dirs.push(d.clone());
    }
    set_writes_documents(&run.id, own_dir.is_some() || doc_dir.as_ref() == Some(&crate::documents::dir(state, &task.id)));
    // Setting up a subproject task's worktree may have set up the subproject's too.
    let parent = match (&task.parent_id, task.kind.as_str()) {
        (Some(id), "task") => db::get_task(&state.db(), id)?,
        _ => parent,
    };
    // A task with its own branch in a repository on GitHub opens a pull request for it.
    let github = match (&project, &task.branch) {
        (Some(p), Some(_)) if task.kind == "task" => {
            let base = task.base_branch.as_deref().or(p.base_branch.as_deref()).filter(|b| !b.is_empty());
            worktree::github(std::path::Path::new(&p.repo_path), base).await
        }
        _ => None,
    };

    // `/plan`: the system prompt has the plan's instructions, as the task has the label (see above).
    let plan = crate::documents::plan_command(text).filter(|_| task.kind == "task" && run.kind != "compact");
    let text = match (plan, documents.iter().find(|(l, _)| *l == "plan")) {
        (Some(rest), Some((_, file))) => crate::documents::plan_prompt(file, rest, true),
        _ => text.to_string(),
    };
    let text = text.as_str();
    let prompt = if task.session_id.is_none() && task.kind == "task" && run.kind != "compact" {
        start_prompt(&task, project.as_ref(), text)
    } else {
        text.to_string()
    };
    // Every run but a `/compact` takes messages while it works (see `can_steer`); the prompt is
    // its first.
    let input = run.kind != "compact";
    let prompt = if input { format!("{}\n", user_input(&crate::util::new_id(), &prompt)) } else { prompt };

    let permission_mode = task.effective_permission_mode(&state.db(), project.as_ref())?;
    let blank = |m: &Option<String>| m.as_deref().is_none_or(|m| m.trim().is_empty());
    let host_model = db::get_setting(&state.db(), "default_model")?;
    let model = [task.model.clone(), project.as_ref().and_then(|p| p.model.clone()), profile.default_model.clone(), host_model]
        .into_iter()
        .find(|m| !blank(m))
        .flatten();
    let effort = match task.effort.clone().filter(|e| !e.trim().is_empty()) {
        Some(e) => Some(e),
        None => db::get_setting(&state.db(), "default_effort")?,
    };

    let github_account = github_account(project.as_ref(), &profile);
    // The task's own temp folder, its TMPDIR, which goes once it's done (see task_tmp.rs).
    let tmp = crate::task_tmp::ensure(state, &task).map(|d| path_str(&d));
    let tmp_env: Vec<(String, String)> = tmp.iter().map(|d| ("TMPDIR".to_string(), d.clone())).collect();

    let config = db::task_claude_config(&state.db(), &task)?;
    let codex = config.as_ref().is_some_and(|c| c.is_codex());
    if codex {
        // Claude's models don't run on Codex; a thread's own pick is used as given.
        let inherited = [project.as_ref().and_then(|p| p.model.clone()), profile.default_model.clone(), db::get_setting(&state.db(), "default_model")?];
        let model = task.model.clone().filter(|m| !m.trim().is_empty()).or_else(|| {
            inherited.into_iter().flatten().find(|m| !m.trim().is_empty() && !crate::codex::is_claude_model(m))
        });
        // Not every Codex model takes every effort, and the effort can come from elsewhere than the model (the host's
        // default is Claude's and Codex's both, and a task on its default model inherits a model it wasn't picked for):
        // one the model doesn't take gives way to the model's own default (when its models can be listed).
        let effort = match config.as_ref() {
            Some(cfg) => codex_run_effort(cfg, model.as_deref(), effort.clone()).await,
            None => effort.clone(),
        };
        let (approval_policy, approvals_reviewer, sandbox) = crate::codex::policy(&permission_mode, task.kind == "review");
        let tools = match &project {
            Some(p) => crate::agent_tools::for_run(state, &p.id)?,
            None => Default::default(),
        };
        let gh_tools = uses_gh_server(&tools);
        let base = system_prompt(&task, project.as_ref(), parent.as_ref(), &group, &documents, github.as_ref(), gh_tools);
        let profiles = db::list_profiles(&state.db())?;
        let to = Told {
            codex: true,
            plan: permission_mode == "plan",
            gh_tools,
            github_account: github_account.as_deref(),
            profiles: &profiles,
            profile: &profile,
            tmp: tmp.as_deref(),
        };
        let mut instructions = instructions(base, &task, &to);
        let own_gh = tools.mcp_servers.contains_key(crate::gh_mcp::SERVER_NAME);
        // Reviewers read and report (see the Claude arguments below).
        let mut disabled_mcp_tools = std::collections::HashMap::new();
        if task.kind == "review" && !own_gh {
            disabled_mcp_tools.insert(crate::gh_mcp::SERVER_NAME.to_string(), crate::gh_mcp::WRITES.iter().map(|t| t.to_string()).collect());
        }
        // In their read-only sandbox, reviewers can still build and run the tests to check what
        // they find, as long as it doesn't change the work.
        let git_dir = git_common_dir(&cwd).await;
        let mut filesystem = std::collections::BTreeMap::new();
        if task.kind == "review" && sandbox == "read-only" {
            let work = [path_str(&crate::util::expand_tilde(&cwd))].into_iter().chain(git_dir.clone()).collect();
            filesystem = review_filesystem(cache_dirs().into_iter().chain(ignored_dirs(&cwd).await).collect(), work);
            instructions.push_str(
                "\n\nYour sandbox can't change the work: its files are read-only. You can write to the temp directories (/tmp), \
                 package caches and the working directory's git-ignored directories, such as build output, so you can build it \
                 and run its tests to check what you find. If a build needs to write anywhere else in the working directory, \
                 point it at /tmp instead (e.g. `CARGO_TARGET_DIR`).",
            );
        }
        let mut writable_roots: Vec<String> = git_dir.into_iter().collect();
        writable_roots.extend(cache_dirs());
        writable_roots.extend(own_dir.clone());
        writable_roots.extend(tmp.clone());
        let spec = crate::codex::Spec {
            cwd: cwd.clone(),
            thread_id: task.session_id.clone(),
            model,
            effort,
            approval_policy: approval_policy.into(),
            approvals_reviewer: approvals_reviewer.into(),
            sandbox: sandbox.into(),
            plan: permission_mode == "plan",
            compact: run.kind == "compact",
            developer_instructions: instructions,
            input,
            writable_roots,
            filesystem,
            skills_dir: tools.skills_dir.as_ref().map(|d| format!("{d}/.claude/skills")),
            approved_mcp_servers: tools.mcp_servers.keys().filter(|n| tools.allowed.contains(&crate::agent_tools::tool_prefix(n))).cloned().collect(),
            disabled_mcp_tools,
            review_waits: approvals_reviewer == "auto_review",
            revert_before_turn: rewind.as_ref().and_then(|r| r.before_turn.clone()),
        };
        let launch = Launch {
            run_id: run.id.clone(),
            cwd: cwd.clone(),
            args: vec![],
            env: tmp_env,
            config_dir: db::task_config_dir(&state.db(), &task)?,
            prompt,
            input,
            review: task.kind == "review",
            mcp_servers: tools.mcp_servers,
            github_account: github_account.clone(),
            codex: Some(spec),
        };
        tracing::info!(task = task_id, run = %run.id, kind = %run.kind, %cwd, resume = task.session_id.is_some(), "starting codex");
        started(state, run, launch).await?;
        rewound(state, task_id, rewind);
        return Ok(());
    }

    let mut args: Vec<String> = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]
        .into_iter()
        .map(String::from)
        .collect();
    if input {
        // Echoed back, the messages show where in the turn the agent took them in.
        args.extend(["--input-format", "stream-json", "--replay-user-messages"].map(String::from));
    }
    // The project's own skills and MCP servers, and the ones it turns off.
    let tools = match &project {
        Some(p) => crate::agent_tools::for_run(state, &p.id)?,
        None => Default::default(),
    };
    let gh_tools = uses_gh_server(&tools);
    let mut push = |a: &str, b: &str| args.extend([a.to_string(), b.to_string()]);
    let base = system_prompt(&task, project.as_ref(), parent.as_ref(), &group, &documents, github.as_ref(), gh_tools);
    let profiles = db::list_profiles(&state.db())?;
    let to = Told {
        codex: false,
        plan: permission_mode == "plan",
        gh_tools,
        github_account: github_account.as_deref(),
        profiles: &profiles,
        profile: &profile,
        tmp: tmp.as_deref(),
    };
    push("--append-system-prompt", &instructions(base, &task, &to));
    push("--permission-mode", &permission_mode);
    if permission_mode != "bypassPermissions" {
        push("--permission-prompt-tool", &format!("mcp__{MCP_SERVER_NAME}__permission_prompt"));
    }
    if gh_tools {
        push("--settings", &gh_hook_settings(&state.exe));
    }
    // Our board tools never need approval, nor do some of the gh server's (see gh_allowed).
    args.push("--allowedTools".to_string());
    args.extend(board_tools_allowed(&permission_mode, task.kind == "review"));
    let own_gh = tools.mcp_servers.contains_key(crate::gh_mcp::SERVER_NAME);
    let gh_tool = |t: &str| format!("mcp__{}__{t}", crate::gh_mcp::SERVER_NAME);
    if !own_gh {
        args.extend(gh_allowed(&task).iter().map(|t| gh_tool(t)));
    }
    args.extend(tools.allowed.iter().cloned());
    let mut disallowed = tools.disallowed.clone();
    if task.kind == "review" {
        // Reviewers read and report; they don't change the work.
        args.extend(crate::review::ALLOWED_TOOLS.iter().map(|t| t.to_string()));
        disallowed.extend(crate::review::DISALLOWED_TOOLS.iter().map(|t| t.to_string()));
        if !own_gh {
            disallowed.extend(crate::gh_mcp::WRITES.iter().map(|t| gh_tool(t)));
        }
    }
    if !disallowed.is_empty() {
        args.extend(["--disallowedTools".to_string(), disallowed.join(" ")]);
    }
    add_dirs.extend(tools.skills_dir.clone());
    let mut push = |a: &str, b: &str| args.extend([a.to_string(), b.to_string()]);
    if let Some(sid) = &task.session_id {
        push("--resume", sid);
        if let Some(at) = rewind.as_ref().and_then(|r| r.resume_at.as_deref()) {
            push("--resume-session-at", at);
        }
    }
    if let Some(m) = &model {
        push("--model", m);
    }
    if let Some(e) = &effort {
        // The nearest Claude has to an effort only Codex models offer.
        push("--effort", match e.as_str() {
            "ultra" => "max",
            "minimal" => "low",
            e => e,
        });
    }
    // Files attached to prompts (see attachments.rs).
    let attachments = crate::attachments::dir(state);
    if attachments.is_dir() {
        add_dirs.push(path_str(&attachments));
    }
    add_dirs.extend(tmp.clone());
    for d in &add_dirs {
        push("--add-dir", d);
    }
    let launch = Launch {
        run_id: run.id.clone(),
        cwd: cwd.clone(),
        args,
        // Permission prompts block until the user answers in the UI.
        env: [("MCP_TOOL_TIMEOUT".to_string(), "86400000".to_string())].into_iter().chain(tmp_env).collect(),
        config_dir: db::task_config_dir(&state.db(), &task)?,
        prompt,
        input,
        review: task.kind == "review",
        mcp_servers: tools.mcp_servers,
        github_account,
        codex: None,
    };
    tracing::info!(task = task_id, run = %run.id, kind = %run.kind, %cwd, resume = task.session_id.is_some(), "starting claude");
    started(state, run, launch).await?;
    rewound(state, task_id, rewind);
    Ok(())
}

/// A run started with the conversation rollback a rewind asked for (see checkpoints.rs): it's done
/// with. One for another session than the run's is dropped too.
fn rewound(state: &Shared, task_id: &str, rewind: Option<crate::checkpoints::Rewind>) {
    let cleared = state.update_task_if(task_id, &[("rewind", Value::Null)], |c| Ok(db::get_task(c, task_id)?.is_some_and(|t| t.rewind.is_some())));
    if let Err(e) = cleared {
        tracing::warn!(task = task_id, "clearing the conversation rollback: {e:#}");
    }
    if let Some(r) = rewind {
        state.add_event(task_id, "info", format!("The conversation goes on from before turn {}", r.turn), None);
    }
}

async fn started(state: &Shared, run: &Run, launch: Launch) -> Result<()> {
    let task_id = run.task_id.as_str();
    runs::start(state, launch).await?;
    state.db().execute("UPDATE runs SET status='running' WHERE id=?1", [&run.id])?;
    // Preparing is over; from here a stop goes to the agent. Messages sent meanwhile go to it now.
    {
        let mut runs = state.runs.lock().unwrap();
        if let Some(h) = runs.get_mut(task_id) {
            h.cancel = None;
            if let Some(t) = write_steers(state, task_id)? {
                state.emit_task(&t);
            }
        }
    }
    runs::follow(state, &run.id, 0);
    Ok(())
}
