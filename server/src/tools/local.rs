//! The tools, as run on this host (`local`).

use super::*;

pub(super) async fn local(s: &Shared, ctx: &Ctx, tool: &str, args: &Value) -> ToolResult {
    let str_arg = |k: &str| args[k].as_str().filter(|v| !v.is_empty()).map(String::from);
    let profile = str_arg("profile");
    let profile = profile.as_deref();
    // The caller's own project and subproject are defaults only on its own board.
    let own_task = ctx.task.as_ref().filter(|_| profile.is_none());
    let own_project = own_task.and_then(|t| t.project_id.clone());
    // The subproject the caller is (or works in): where its new tasks go by default.
    let own_subproject = match own_task {
        Some(t) if t.subproject => Some(t.clone()),
        Some(t) => db::subproject_of(&s.db(), t)?,
        None => None,
    };
    match tool {
        "list_projects" => {
            let mut out = Vec::new();
            for b in pick_boards(s, ctx, profile)? {
                // Archived ones are off the board until the user unarchives them.
                for p in db::list_projects(&s.db(), &b.id)?.into_iter().filter(|p| p.archived_at.is_none()) {
                    out.push(project_json(s, &p, &b));
                }
            }
            Ok(json!(out))
        }
        "list_tasks" => {
            let in_subproject = match str_arg("subproject").as_deref() {
                Some("all") => None,
                Some("none") => Some(None),
                Some(k) => Some(Some(subproject_arg(s, ctx, k, profile)?)),
                // A subproject's agents see its tasks unless they ask for more.
                None if str_arg("project_id").is_none() => own_subproject.clone().map(Some),
                None => None,
            };
            let pid = str_arg("project_id").or_else(|| in_subproject.clone().flatten().and_then(|p| p.project_id)).or(own_project);
            let tasks = match pid.as_deref() {
                // Every task on the named board(s), else on the caller's own.
                None | Some("all") => {
                    let all = pick_boards(s, ctx, profile)?;
                    let boards: Vec<_> = match profile {
                        None if all.iter().any(|b| ctx.is_own(b)) => all.into_iter().filter(|b| ctx.is_own(b)).collect(),
                        _ => all,
                    };
                    let mut tasks = Vec::new();
                    for b in boards {
                        let archived: Vec<String> = db::list_projects(&s.db(), &b.id)?.into_iter().filter(|p| p.archived_at.is_some()).map(|p| p.id).collect();
                        let list = db::list_tasks_for_profile(&s.db(), &b.id)?;
                        tasks.extend(list.into_iter().filter(|t| t.project_id.as_ref().is_none_or(|p| !archived.contains(p))));
                    }
                    tasks
                }
                Some(pid) => {
                    let p = resolve_project(s, ctx, pid, profile)?;
                    db::list_tasks_for_project(&s.db(), &p.id, "task")?
                }
            };
            let status = str_arg("status");
            Ok(json!(tasks
                .iter()
                .filter(|t| status.as_deref().is_none_or(|st| t.status == st))
                .filter(|t| in_subproject.as_ref().is_none_or(|sp| t.parent_id.as_deref() == sp.as_ref().map(|p| p.id.as_str())))
                .map(|t| summarize(s, t))
                .collect::<Vec<_>>()))
        }
        "get_task" | "get_task_field" => {
            let t = resolve_task(s, ctx, &str_arg("task_id").unwrap_or_default(), profile)?;
            let details = task_details(s, ctx, &t)?;
            if tool == "get_task_field" {
                task_field(&details, args)
            } else if ctx.task_fields {
                Ok(task_overview(details))
            } else {
                // Old helpers and linked hosts cannot offer the field tool. Keep all details
                // available to them, including calls forwarded by an upgraded host.
                Ok(details)
            }
        }
        // A scratch task is in no project unless it's given one (or a subproject); the
        // caller's own project isn't a default for it, as it wasn't before scratch tasks could be in one.
        "create_task" if str_arg("type").as_deref() == Some(db::SCRATCH) && str_arg("project_id").is_none() && str_arg("subproject").is_none_or(|sp| sp == "none") => {
            if args["is_subproject"].as_bool() == Some(true) {
                return Err(ToolError::Other("a scratch task can't be a subproject".into()));
            }
            // On the caller's own board unless it names another.
            let boards = pick_boards(s, ctx, profile)?;
            let board = match profile {
                None => boards.iter().find(|b| ctx.is_own(b)).or(boards.first()),
                Some(_) => boards.first(),
            }
            .ok_or_else(|| ToolError::NotFound("your profile's board".into()))?;
            let body = CreateTask {
                title: str_arg("title").unwrap_or_default(),
                description: str_arg("description").unwrap_or_default(),
                status: str_arg("status"),
                resolution: str_arg("resolution"),
                start: args["start"].as_bool().filter(|b| *b).map(Value::Bool),
                labels: Some(args["labels"].clone()),
                ..Default::default()
            };
            let marks = new_task_marks(args)?;
            let t = api::create_scratch_task_inner(s, &board.id, body)?;
            Ok(summarize(s, &created(s, ctx, t, &marks)?))
        }
        "create_task" => {
            let parent = match str_arg("subproject").as_deref() {
                Some("none") => None,
                Some(k) => Some(subproject_arg(s, ctx, k, profile)?),
                None => None,
            };
            let project = match str_arg("project_id") {
                Some(pid) => resolve_project(s, ctx, &pid, profile)?,
                None => {
                    let pid = parent
                        .as_ref()
                        .and_then(|p| p.project_id.clone())
                        .or(own_project)
                        .ok_or_else(|| ToolError::Other("project_id is required (use list_projects)".into()))?;
                    db::get_project(&s.db(), &pid)?.ok_or_else(|| ToolError::NotFound(format!("project {pid}")))?
                }
            };
            // Tasks created from a subproject (or one of its tasks) go in it, unless they're for another project.
            let parent = match str_arg("subproject") {
                Some(_) => parent,
                None => own_subproject.filter(|sp| sp.project_id.as_deref() == Some(project.id.as_str())),
            };
            let body = CreateTask {
                parent_id: parent.map(|p| p.id),
                subproject: args["is_subproject"].as_bool(),
                title: str_arg("title").unwrap_or_default(),
                description: str_arg("description").unwrap_or_default(),
                status: str_arg("status"),
                resolution: str_arg("resolution"),
                use_worktree: args["use_worktree"].as_bool(),
                model: None,
                effort: None,
                kind: None,
                start: args["start"].as_bool().filter(|b| *b).map(Value::Bool),
                // The project's profile's default, so its agent runs with that profile's login.
                claude_config_id: None,
                depends_on: dependency_ids(s, ctx, &args["depends_on"], profile)?,
                task_type: str_arg("type"),
                labels: Some(args["labels"].clone()),
                external_links: None,
                fanout_id: None,
            };
            let marks = new_task_marks(args)?;
            let t = api::create_task_inner(s, &project.id, body)?;
            Ok(summarize(s, &created(s, ctx, t, &marks)?))
        }
        "update_task" => {
            let t = resolve_task(s, ctx, &str_arg("task_id").unwrap_or_default(), profile)?;
            let mut body = Map::new();
            for k in ["title", "description", "status", "resolution", "preview_url", "pr_url", "remerge", "labels"] {
                if !args[k].is_null() {
                    body.insert(k.into(), args[k].clone());
                }
            }
            if let Some(ids) = dependency_ids(s, ctx, &args["depends_on"], profile)? {
                body.insert("depends_on".into(), json!(ids));
            }
            body.extend(reminder_args(args)?);
            let t = api::update_task_inner(s, &t.id, &body).await?;
            Ok(summarize(s, &t))
        }
        "delete_task" => {
            // A call retried after a restart carries on with the deletion it asked about.
            let input = match ctx.call_id.as_deref().map(|c| permissions::asked(s, c)).transpose()?.flatten() {
                Some(saved) => saved,
                None => {
                    let t = resolve_task(s, ctx, &str_arg("task_id").unwrap_or_default(), profile)?;
                    deletion(s, ctx, &t, args["delete_branch"].as_bool().unwrap_or(false), str_arg("reason"))?
                }
            };
            delete_task(s, ctx, &input).await
        }
        "send_to_task" => {
            let t = resolve_task(s, ctx, &str_arg("task_id").unwrap_or_default(), profile)?;
            if ctx.task.as_ref().is_some_and(|own| own.id == t.id) {
                return Err(ToolError::Other("cannot send a message to your own task".into()));
            }
            let t = runner::send_from_agent(s, &t.id, &str_arg("message").unwrap_or_default())?;
            Ok(summarize(s, &t))
        }
        "get_project" | "update_project" => {
            // A call retried after a restart carries on with the approval it asked for, and the
            // project it was for, whatever has changed since.
            if tool == "update_project"
                && let Some(saved) = ctx.call_id.as_deref().map(|c| permissions::asked(s, c)).transpose()?.flatten()
            {
                return resume_approval(s, ctx, &saved).await;
            }
            let p = match str_arg("project_id") {
                Some(pid) => resolve_project(s, ctx, &pid, profile)?,
                None => {
                    let pid = own_project.ok_or_else(|| ToolError::Other("project_id is required (use list_projects)".into()))?;
                    db::get_project(&s.db(), &pid)?.ok_or_else(|| ToolError::NotFound(format!("project {pid}")))?
                }
            };
            let board = db::get_profile(&s.db(), &p.profile_id)?.ok_or_else(|| ToolError::NotFound("profile".into()))?;
            let p = if tool == "update_project" { update_project(s, ctx, &p, args, str_arg("reason")).await? } else { p };
            Ok(project_settings_json(s, &p, &board))
        }
        "create_project" => {
            // A call retried after a restart carries on with the approval it asked for.
            if let Some(saved) = ctx.call_id.as_deref().map(|c| permissions::asked(s, c)).transpose()?.flatten() {
                return create_project(s, ctx, &saved).await;
            }
            let boards = pick_boards(s, ctx, profile)?;
            let board = match profile {
                Some(_) => boards.into_iter().next(),
                None => boards.into_iter().find(|b| ctx.is_own(b)),
            };
            let board = board.ok_or_else(|| ToolError::NotFound(format!("profile {} on host {}", ctx.profile_name, s.host_name)))?;
            let input = project_creation(s, ctx, &board, str_arg("name"), &str_arg("repo_path").unwrap_or_default(), str_arg("reason")).await?;
            create_project(s, ctx, &input).await
        }
        "list_automations" => {
            let p = project_or_own(s, ctx, str_arg("project_id"), profile, own_project)?;
            let list = crate::automations::list(&s.db(), &p.id)?;
            let list: Vec<Value> = list.iter().map(|a| automation_json(s, a)).collect();
            Ok(json!({"project": {"id": p.id, "key": p.key, "name": p.name}, "automations": list, "time_zone": crate::automations::time_zone()}))
        }
        "create_automation" | "update_automation" | "delete_automation" => {
            // A call retried after a restart carries on with the approval it asked for.
            if let Some(saved) = ctx.call_id.as_deref().map(|c| permissions::asked(s, c)).transpose()?.flatten() {
                return change_automation(s, ctx, &saved).await;
            }
            let input = match tool {
                "create_automation" => {
                    let p = project_or_own(s, ctx, str_arg("project_id"), profile, own_project)?;
                    automation_creation(s, ctx, &p, args, profile)?
                }
                "update_automation" => {
                    let (a, p) = resolve_automation(s, ctx, args, profile, own_project)?;
                    match automation_update(s, ctx, &a, &p, args, profile)? {
                        Ok(input) => input,
                        // Nothing that needs asking: turning it off, or renaming it.
                        Err(apply) => {
                            let a = crate::automations::update(s, &a.id, &apply)?;
                            return Ok(automation_json(s, &a));
                        }
                    }
                }
                _ => {
                    let (a, p) = resolve_automation(s, ctx, args, profile, own_project)?;
                    let mut input = automation_input(s, ctx, "delete", &p, automation_view(s, &a.id, &a.name, a.enabled, &a.trigger, &a.action, has_secret(&a)));
                    input["reason"] = json!(str_arg("reason"));
                    input
                }
            };
            change_automation(s, ctx, &input).await
        }
        "run_automation" => {
            let (a, _) = resolve_automation(s, ctx, args, profile, own_project)?;
            let event = str_arg("event");
            let run = crate::automations::run_now(s, &a, crate::automations::RunNow { payload: args.get("payload").filter(|p| !p.is_null()).cloned(), event }).await?;
            Ok(crate::automations::run_json(&s.db(), &run))
        }
        other => Err(ToolError::Other(format!("unknown tool {other}"))),
    }
}
