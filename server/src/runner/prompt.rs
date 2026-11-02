//! What a run is told: the task's prompt, and the system prompt about the board, its tools and the
//! task's settings (see `preview`).

use super::*;

/// What else decides what a run is told (see `instructions`).
pub(super) struct Told<'a> {
    /// It runs on Codex rather than Claude Code.
    pub(super) codex: bool,
    /// In plan mode, which Codex is told of (Claude Code tells Claude itself).
    pub(super) plan: bool,
    /// It has our gh server (see uses_gh_server).
    pub(super) gh_tools: bool,
    pub(super) github_account: Option<&'a str>,
    /// The host's profiles, and the run's own.
    pub(super) profiles: &'a [Profile],
    pub(super) profile: &'a Profile,
    /// Its temp folder (see task_tmp.rs), if it has one.
    pub(super) tmp: Option<&'a str>,
}

/// What a run is told on top of its agent's own system prompt: Claude Code's `--append-system-prompt`, or Codex's
/// developer instructions (to which `launch` adds a reviewer's sandbox). `base`: what system_prompt says.
pub(super) fn instructions(mut s: String, task: &Task, to: &Told) -> String {
    if to.codex && to.plan {
        s.push_str(
            "\n\nYou are in plan mode: investigate and propose a plan, but don't change any files. The user will \
             switch modes once they approve it.",
        );
    }
    if to.gh_tools && to.codex {
        // Codex's sandbox may keep `gh` in the shell off the network, and its GitHub app (the
        // codex_apps server's github tools) may not reach the user's repositories. Codex has
        // no hook to turn gh in the shell away, so it's only told.
        s.push_str(&format!(
            "\n\nFor GitHub, use the `{0}` MCP server's tools (e.g. `{0}.pr_view`, `{0}.pr_diff`), which run gh with \
             the user's login{1}: don't run `gh` in your shell, which may not reach GitHub{2}, and the codex_apps \
             GitHub tools may not have access to this repository.",
            crate::gh_mcp::SERVER_NAME,
            to.github_account.map(|a| format!(" as the GitHub account {a}")).unwrap_or_default(),
            if to.github_account.is_some() { " or would act as another account" } else { "" },
        ));
    } else if to.gh_tools {
        s.push_str(&gh_note(to.github_account));
    }
    if let Some(d) = to.tmp {
        s.push_str(&format!(
            "\n\nYour temp folder is {d} (`$TMPDIR` in your shell{}). Put scratch files, logs and test data there rather \
             than directly in /tmp. It's deleted once the task is done, so don't keep anything there that's needed after that.",
            if task.kind == "review" { ", shared with the task's agent" } else { "" }
        ));
    }
    // Which profiles' boards it can't use, so it asks rather than make a project that may be there.
    if task.kind != "review" {
        s.push_str(&profiles_note(to.profiles, to.profile));
    }
    s
}

/// The options of a new thread that change what it's told (see `preview`).
#[derive(Deserialize, Default)]
pub struct PreviewOptions {
    /// `task` (the default), `subproject` or `scratch`.
    #[serde(default)]
    pub r#type: Option<String>,
    /// Some of db::LABELS, comma-separated.
    #[serde(default)]
    pub labels: Option<String>,
    /// For a task: whether it has its own worktree (by default, as the project's new tasks do).
    #[serde(default)]
    pub worktree: Option<bool>,
    /// `claude` or `codex` (by default, what a new task in the project runs on).
    #[serde(default)]
    pub runtime: Option<String>,
    /// Its permission mode (by default, the project's).
    #[serde(default)]
    pub permission_mode: Option<String>,
}

/// What the agent of a new thread in `project` would be told on top of its agent's own system prompt (see
/// `instructions`), for the project's settings to show: a task numbered as the project's next, with the options given
/// and the project's settings as they are now. Its title and id are placeholders. Also gives whether it's on Codex, and its
/// permission mode (the one given, or else the one it inherits).
pub async fn preview(state: &Shared, project: &Project, o: &PreviewOptions) -> ApiResult<(String, bool, String)> {
    let kind = o.r#type.as_deref().unwrap_or("task");
    if !["task", "subproject", "scratch"].contains(&kind) {
        return Err(ApiError::bad(format!("unknown type {kind:?}: it's task, subproject or scratch")));
    }
    let given: Vec<&str> = o.labels.as_deref().unwrap_or("").split(',').filter(|l| !l.trim().is_empty()).collect();
    let labels = crate::documents::check_labels(&json!(given)).map_err(ApiError::bad)?;
    if o.permission_mode.as_deref().is_some_and(|m| !db::PERMISSION_MODES.contains(&m)) {
        return Err(ApiError::bad(format!("permission_mode must be one of {:?}", db::PERMISSION_MODES)));
    }
    let (number, profile, profiles) = {
        let c = state.db();
        let number: i64 = c.query_row("SELECT next_number FROM projects WHERE id=?1", [&project.id], |r| r.get(0))?;
        (number, db::get_profile(&c, &project.profile_id)?.ok_or_else(|| ApiError::not_found("profile"))?, db::list_profiles(&c)?)
    };
    let use_worktree = match kind {
        "subproject" => true,
        "scratch" => false,
        _ => o.worktree.unwrap_or(project.use_worktrees),
    } && project.is_git;
    let mut task: Task = serde_json::from_value(json!({
        "id": "<task id>", "profile_id": profile.id, "project_id": project.id, "kind": "task", "subproject": kind == "subproject",
        "task_type": (kind == "scratch").then_some(db::SCRATCH), "labels": labels, "number": number, "title": "Task title",
        "description": "", "status": "in_progress", "position": 0.0, "use_worktree": use_worktree, "worktree_state": "none",
        "running": false, "merging": false, "auto_allow": [], "cost_usd": 0.0,
        "last_activity_at": "", "created_at": "", "updated_at": "", "permission_mode": o.permission_mode,
    }))
    .map_err(anyhow::Error::from)?;
    // Where `worktree::setup` would put it.
    if use_worktree {
        let name = worktree::folder_name(project, &task);
        let repo = crate::util::expand_tilde(&project.repo_path);
        let base = match project.base_branch.as_deref().filter(|b| !b.is_empty()) {
            Some(b) => b.to_string(),
            None => worktree::current_branch(&repo).await.unwrap_or_else(|| "HEAD".into()),
        };
        task.worktree_path = Some(path_str(&std::path::PathBuf::from(&project.worktrees_root).join(&name)));
        task.branch = Some(format!("ia/{}-{name}", project.key.to_lowercase()));
        task.base_branch = Some(base);
    }
    let github = match &task.branch {
        Some(_) => worktree::github(&crate::util::expand_tilde(&project.repo_path), task.base_branch.as_deref()).await,
        None => None,
    };
    let documents: Vec<(&str, String)> = crate::documents::paths(state, &task).into_iter().map(|(l, p)| (l, path_str(&p))).collect();
    let tools = crate::agent_tools::for_preview(state, &project.id)?;
    let (permission_mode, codex) = {
        let c = state.db();
        let codex = match o.runtime.as_deref() {
            Some("codex") => true,
            Some("claude") => false,
            Some(r) => return Err(ApiError::bad(format!("unknown runtime {r:?}: it's claude or codex"))),
            None => db::task_is_codex(&c, &task)?,
        };
        (task.effective_permission_mode(&c, Some(project))?, codex)
    };
    let gh_tools = uses_gh_server(&tools);
    let account = github_account(Some(project), &profile);
    let base = system_prompt(&task, Some(project), None, &[], &documents, github.as_ref(), gh_tools);
    let tmp = path_str(&crate::task_tmp::dir(state, &task));
    let to = Told { codex, plan: permission_mode == "plan", gh_tools, github_account: account.as_deref(), profiles: &profiles, profile: &profile, tmp: Some(&tmp) };
    Ok((instructions(base, &task, &to), codex, permission_mode))
}

/// The key a group task's number goes with, in place of a project's key.
pub const GROUP_TASK_KEY: &str = "G";

/// What goes before a task's number in its key: its project's key, for a group task `G`, or
/// for a scratch task `S`.
pub fn key_prefix<'a>(task: &Task, project: Option<&'a Project>) -> &'a str {
    match project {
        Some(p) => &p.key,
        None if task.group_name.is_some() => GROUP_TASK_KEY,
        None if task.is_scratch() => db::SCRATCH_TASK_KEY,
        None => "T",
    }
}

/// A task's first prompt: the task, the project's instructions for starting (see prompts.rs),
/// then any message it was started with (e.g. from `create_task`). A message that calls a skill
/// (`/name …`) goes first instead, since Claude Code only expands a command at the start of a
/// prompt, and the task becomes part of its arguments.
pub(super) fn start_prompt(task: &Task, project: Option<&Project>, text: &str) -> String {
    let key = key_prefix(task, project);
    let text = text.trim();
    let mut p = String::new();
    if is_slash_command(text) {
        p.push_str(&format!("{text}\n\n"));
    }
    p.push_str(&format!("# {key}-{}: {}\n", task.number, task.title));
    if !task.description.trim().is_empty() {
        p.push_str(&format!("\n{}\n", task.description.trim()));
    }
    p.push_str(&external_links_note(&task.external_links));
    p.push_str(&format!("\n---\n\n{}\n", crate::prompts::start_task(task, project)));
    if !text.is_empty() && !is_slash_command(text) {
        p.push_str(&format!("\n{text}\n"));
    }
    p
}

/// The tasks elsewhere a task is for, as its first prompt lists them.
fn external_links_note(links: &[db::ExternalLink]) -> String {
    if links.is_empty() {
        return String::new();
    }
    let mut s = String::from("\nThis task is for:\n");
    for l in links {
        let provider = if l.provider == "asana" { "Asana" } else { &l.provider };
        let title = if l.title.is_empty() { &l.url } else { &l.title };
        s.push_str(&format!("- {provider} task: {title} ({})\n", l.url));
    }
    s
}

/// Whether a message starts with a command, such as a skill (`/name`, or `/plugin:name`), rather
/// than, say, a path.
fn is_slash_command(text: &str) -> bool {
    let name = text.strip_prefix('/').map(|r| r.split(char::is_whitespace).next().unwrap_or(""));
    name.is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.')))
}

/// Which other profiles' boards on this host the agent's tools reach, so it looks there before
/// adding a project that may already be on one.
pub(super) fn profiles_note(profiles: &[db::Profile], own: &db::Profile) -> String {
    let (shared, closed): (Vec<&db::Profile>, Vec<&db::Profile>) = profiles.iter().filter(|p| p.id != own.id).partition(|p| p.grants(&own.name));
    let names = |ps: &[&db::Profile]| ps.iter().map(|p| p.name.as_str()).collect::<Vec<_>>().join(", ");
    let mut s = format!("\n\nYour profile on the board is \"{}\".", own.name);
    if !shared.is_empty() {
        s.push_str(&format!(" Your board tools also reach these profiles' boards: {}.", names(&shared)));
    }
    if !closed.is_empty() {
        s.push_str(&format!(
            " These profiles' boards don't let your agents in, so their projects aren't listed: {}. If the user mentions a \
             project you can't find, it may be on one of them: ask the user rather than creating it.",
            names(&closed)
        ));
    }
    s
}

/// How an agent asks the user for input, then how it finishes: with a summary of `done`.
fn ask_and_finish(done: &str) -> String {
    format!(
        "If you are blocked or need a decision or information from the user, call `request_user_input` with your question \
         (and its `options`, when the choices are known), then end your turn. The task is flagged \"Needs attention\", and \
         the user's reply resumes this conversation.\n\n\
         When you finish, end with a concise summary of {done}; the task then moves to \"In review\"."
    )
}

/// What a task's agent is told on top of its agent's own system prompt, in paragraphs separated by blank lines (`instructions`
/// adds more). `group`: for a group task, its group's projects. `documents`: the files its labels ask it to
/// write, by label (see documents.rs). `github`: where a task with its own branch opens
/// its pull request, if its repository is on GitHub.
pub(super) fn system_prompt(
    task: &Task,
    project: Option<&Project>,
    parent: Option<&Task>,
    group: &[Project],
    documents: &[(&str, String)],
    github: Option<&worktree::Github>,
    gh_tools: bool,
) -> String {
    let tools = format!(
        "You have access to the `{MCP_SERVER_NAME}` MCP tools for the Huntaway board \
         (list_projects, list_tasks, get_task, get_task_field, create_task, update_task, send_to_task, request_user_input, wait). \
         They also reach other profiles' boards that let your agents in: list_projects shows each project's profile.\n\n\
         When you have nothing to do until something happens (other tasks, CI, reviews, a deploy), call `wait` rather than \
         sleeping or polling: the board then shows you as waiting rather than working.\n\
         - For CI or reviews on a pull request, give it the `pull_request` (its number or URL). It ends when the checks fail \
         or pass, someone comments or reviews, the branch conflicts with its base, or it's merged or closed, and says what \
         happened.\n\
         - For a deploy, give it a `command` that exits once it's done."
    );
    // How a group task or a subproject runs its tasks.
    let coordinate = "- Follow them with `list_tasks` and `get_task`, and guide their agents with `send_to_task`.\n\
         - While they work, wait for them with `wait` (listing them in `tasks`) rather than ending your turn.\n\
         - Run tasks that build on each other one after the other, and independent ones in parallel.";
    let mut s = match (task.kind.as_str(), project) {
        ("task", p) if task.is_scratch() => {
            // One from a scratch chat works in the chat's folder, which may be shared.
            let dir = match &task.work_dir {
                Some(_) => "a scratch folder, for notes and experiments",
                None => "the task's own folder, for notes and experiments, where you can write freely",
            };
            let key = key_prefix(task, p);
            // In a project (API 51) it reads the repository; in a subproject, the subproject's worktree too.
            let place = match (p, parent.filter(|t| t.subproject)) {
                (None, _) => "A scratch task isn't in a project or a repository: it's for whatever the user asks, such as \
                     answering questions, trying things out, or planning and running work across the board."
                    .to_string(),
                (Some(p), sp) => {
                    let mut s = format!(
                        "This scratch task is in the project {} (key {}, id {}, repository {}, which you can read). It has no \
                         worktree or branch of its own: it's for whatever the user asks about the project, such as answering \
                         questions, looking into the code, trying things out, or planning and running the project's work. \
                         Don't change the repository, commit, push or open pull requests: create a task for changes.",
                        p.name, p.key, p.id, p.repo_path
                    );
                    if let Some(sp) = sp {
                        s.push_str(&format!(
                            "\n\nIt's part of the subproject {key}-{} (\"{}\"), whose branch `{}` collects the work of its tasks{}. \
                             Tasks you create are added to the subproject.",
                            sp.number,
                            sp.title,
                            sp.branch.as_deref().unwrap_or("?"),
                            sp.worktree_path
                                .as_ref()
                                .filter(|_| sp.worktree_state == "ready")
                                .map(|w| format!(" and is checked out in the subproject's worktree at {w}, which you can read"))
                                .unwrap_or_default()
                        ));
                    }
                    s
                }
            };
            format!(
                "You are an agent working on scratch task {key}-{} (\"{}\", id {}) on the Huntaway board, a kanban board where \
                 each task is worked by its own Claude agent, grouped into projects. Your working directory is {dir}.\n\n\
                 {place}\n\n\
                 {tools}\n\n\
                 Use the board tools to look across projects, create and update tasks, and start agents on tasks (create_task \
                 with start=true, or send_to_task) when the user asks for that. Tasks you create are recorded as this task's.\n\n\
                 {}",
                task.number,
                task.title,
                task.id,
                ask_and_finish("what you did")
            )
        }
        ("review", p) => {
            let key = p.map(|p| p.key.as_str()).unwrap_or("T");
            let (number, title) = parent.map(|t| (t.number, t.title.as_str())).unwrap_or((0, "?"));
            let summary = crate::summary::is_summary(task);
            let role = if summary { "You summarise the changes made" } else { "You are the code reviewer" };
            let mut s = format!(
                "{role} for task {key}-{number} (\"{title}\") on the Huntaway board, a kanban \
                 board where each task is worked by its own Claude agent."
            );
            if let Some(t) = parent.filter(|t| t.worktree_state == "ready") {
                s.push_str(&format!(
                    " Your working directory is that task's git worktree at {}{}.",
                    t.worktree_path.as_deref().unwrap_or("?"),
                    t.branch.as_ref().map(|b| format!(" on branch `{b}`")).unwrap_or_default()
                ));
            }
            s.push_str(if summary {
                "\n\nRead only: don't edit files, commit, push, merge, comment on pull requests, or change tasks on the \
                 board. Don't call `request_user_input` or `submit_review`. Your last message is the summary of the changes \
                 the user reads before merging them."
            } else {
                "\n\nReview only: don't edit files, commit, push, merge, comment on pull requests, or change tasks on the \
                 board. Don't call `request_user_input`. When the review is complete, call `submit_review` exactly once \
                 with your verdict, then end your turn with a short summary of the review."
            });
            s
        }
        ("task", p) if crate::documents::documents_only(task) => {
            let key = key_prefix(task, p);
            format!(
                "You are an agent working on task {key}-{} (\"{}\", id {}) on the Huntaway board, a kanban board where each \
                 task is worked by its own Claude agent.{}\n\n{tools}\n\n{}",
                task.number,
                task.title,
                task.id,
                crate::documents::system_prompt(task, documents, p, group),
                ask_and_finish("what you made or changed")
            )
        }
        ("task", None) if task.group_name.is_some() => {
            let name = task.group_name.as_deref().unwrap_or_default();
            let projects = if group.is_empty() {
                " The group has no projects at the moment (it may have been renamed or ungrouped): ask the user which \
                 projects to use."
                    .to_string()
            } else {
                let list: Vec<String> = group.iter().map(|p| format!("- {} (key {}, id {}, repository {})", p.name, p.key, p.id, p.repo_path)).collect();
                format!(" The group's projects, whose repositories you can read:\n{}", list.join("\n"))
            };
            format!(
                "You are the planning agent for task {}-{} (\"{}\", id {}) on the Huntaway board, a kanban board where each \
                 task is worked by its own Claude agent. Your working directory is a scratch folder for notes.\n\n\
                 This is a group task: it isn't in a project but plans work across the projects of the group \"{name}\".{projects}\n\n\
                 {tools}\n\n\
                 Your job is to plan and coordinate, not to change the repositories yourself:\n\
                 - Break the work into tasks in the right projects with `create_task` (always give its project_id; start=true \
                 launches an agent on one, and depends_on orders tasks within a project).\n\
                 {coordinate}\n\n\
                 Tasks you create are recorded as this task's: the board shows how many are done, and `get_task` on this task \
                 lists them.\n\n\
                 {}",
                GROUP_TASK_KEY,
                task.number,
                task.title,
                task.id,
                ask_and_finish("the tasks you created and where they stand")
            )
        }
        (_, p) => {
            let key = p.map(|p| p.key.as_str()).unwrap_or("T");
            let subproject = parent.filter(|t| t.subproject);
            // Whether it opens a pull request, as its project's settings say (a subproject's tasks have one of their own).
            let prs = p.is_none_or(|p| p.pull_requests(subproject.is_some()));
            let github = github.filter(|_| prs);
            let mut s = format!(
                "You are an agent working on task {key}-{} (\"{}\") on the Huntaway board.",
                task.number, task.title
            );
            if let Some(p) = p {
                s.push_str(&format!(" Project: {} (repository {}).", p.name, p.repo_path));
            }
            if let (Some(wt), Some(br)) = (&task.worktree_path, &task.branch) {
                s.push_str(&format!(
                    "\n\nYou are in a dedicated git worktree at {wt} on branch `{br}`{}. Make all changes here. \
                     When you complete a meaningful unit of work, commit it to this branch with a clear message. \
                     Do not {} unless asked.",
                    task.base_branch.as_ref().map(|b| format!(" (branched from `{b}`)")).unwrap_or_default(),
                    // It pushes the branch for its pull request.
                    if github.is_some() { "merge or switch branches" } else { "push, merge, or switch branches" }
                ));
            }
            if task.subproject {
                let br = task.branch.as_deref().unwrap_or("this task's branch");
                let base = task.base_branch.as_deref().or(p.and_then(|p| p.base_branch.as_deref())).unwrap_or("the base branch");
                let how = if p.is_none_or(|p| p.subproject_pull_requests) {
                    "through pull requests that target it, if the project uses them"
                } else {
                    "without pull requests, which the project's settings turn off for subprojects' tasks"
                };
                s.push_str(&format!(
                    "\n\nThis task is a subproject: it has its own board of tasks, each worked by its own agent in a worktree \
                     branched from `{br}`, and their work is merged back into `{br}` ({how}). The subproject as a whole is then merged into `{base}`, so its tasks add up \
                     to a series of small, reviewable changes instead of one big one. Their merges land on `{br}` on the \
                     remote, so pull before working in your worktree.\n\n\
                     Your job is mostly to plan and coordinate:\n\
                     - Break the work into small tasks with `create_task` (they're added to this subproject; start=true \
                     launches an agent on one).\n\
                     {coordinate}"
                ));
            }
            if let Some(sp) = subproject {
                let sp_branch = task.base_branch.as_deref().or(sp.branch.as_deref()).unwrap_or("the subproject's branch");
                let merge = if prs {
                    let open = if gh_tools { format!("pr_create with base `{sp_branch}`") } else { format!("`gh pr create --base {sp_branch}`") };
                    format!(
                        "If you open a pull request, target `{sp_branch}` (e.g. {open}), pushing `{sp_branch}` first if the remote doesn't \
                         have it yet. If you merge without a pull request, merge"
                    )
                } else {
                    "When you merge, merge".to_string()
                };
                s.push_str(&format!(
                    "\n\nThis task is part of the subproject {key}-{} (\"{}\"), whose branch `{sp_branch}` collects the work of \
                     its tasks: your branch starts from `{sp_branch}` and is merged back into it, not into the project's main \
                     branch. {merge} into `{sp_branch}`{}. Tasks you create are added to the subproject too.",
                    sp.number,
                    sp.title,
                    sp.worktree_path.as_ref().map(|w| format!(", which is checked out in the subproject's worktree at {w}")).unwrap_or_default()
                ));
            }
            if let (Some(gh), Some(br)) = (github, &task.branch) {
                let base = task.base_branch.as_deref().or(p.and_then(|p| p.base_branch.as_deref())).filter(|b| !b.is_empty());
                // The repository is named, as gh would pick one from the remotes' fetch URLs.
                let repo = &gh.repo;
                let open = if gh_tools {
                    format!("the gh tools' pr_create with repo `{repo}`, head `{br}`{}", base.map(|b| format!(" and base `{b}`")).unwrap_or_default())
                } else {
                    format!(
                        "`gh pr create --repo {repo} --head {br}{}`, or the gh tools' git_push and pr_create with the same repo, \
                         head and base",
                        base.map(|b| format!(" --base {b}")).unwrap_or_default()
                    )
                };
                s.push_str(&format!(
                    "\n\nThe repository is on GitHub ({repo}), so before you finish, open a pull request for this task's work \
                     unless the project's own instructions (e.g. in CLAUDE.md) say otherwise:\n\
                     1. Commit everything.\n\
                     2. Push the branch: `git push -u {} {br}`{}.\n\
                     3. Open the pull request{} in {repo} ({open}), with a title and a body that say what changed and how to \
                     try it.\n\
                     If the branch has a pull request already, push to it instead. Put the pull request's link in your summary. \
                     A task with no changes on its branch doesn't need one.",
                    gh.remote,
                    if gh_tools { ", or the gh tools' git_push if that fails" } else { "" },
                    base.map(|b| format!(" into `{b}`")).unwrap_or_default(),
                ));
            } else if !prs && task.branch.is_some() {
                // Turned off: project instructions that say to open one don't apply.
                s.push_str(&format!(
                    "\n\nThis project's settings turn off pull requests for its {}, so don't push this task's branch or open a \
                     pull request for it unless the user asks, even if the project's own instructions (e.g. in CLAUDE.md) say to.",
                    if subproject.is_some() { "subprojects' tasks" } else { "tasks" }
                ));
            }
            s.push_str(&format!(
                "\n\n{tools}\n\n{} You may create follow-up tasks with `create_task`.",
                ask_and_finish("what you did")
            ));
            s
        }
    };
    // What its labels ask for (a task that makes only documents was told already).
    if !crate::documents::documents_only(task) {
        s.push_str(&crate::documents::labels_prompt(documents));
    }
    s
}
