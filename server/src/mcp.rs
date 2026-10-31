//! `huntaway mcp`: the stdio MCP server that `claude -p` launches for each run. It lists
//! the board tools and relays every call to the server that started the run. Each call keeps
//! one id across retries, so a server restart mid-call is harmless.

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

use crate::util::new_id;

/// A run's line to the server that started it: board tool calls and permission prompts.
pub struct Ctx {
    url: String,
    token: String,
    run_id: String,
    review: bool,
    http: reqwest::Client,
}

impl Ctx {
    pub fn new(url: String, token: String, run_id: String) -> Self {
        Self { url, token, run_id, review: false, http: reqwest::Client::new() }
    }

    pub async fn call(&self, tool: &str, args: &Value) -> Result<Value> {
        let call_id = new_id();
        // Only helpers whose schema offers get_task_field may receive bounded task details.
        let body = json!({"run_id": self.run_id, "call_id": call_id, "tool": tool, "args": args, "task_fields": true});
        // Since the server stopped answering; a call can take long (`wait`) before that.
        let mut failing_since: Option<Instant> = None;
        let mut delay = Duration::from_millis(500);
        loop {
            let attempt = async {
                let res = self.http.post(format!("{}/api/internal/mcp", self.url)).bearer_auth(&self.token).json(&body).send().await?;
                let status = res.status();
                if !status.is_success() {
                    // A 4xx (other than a timeout or rate limit) is the server's answer, not it being down:
                    // a stale token, say, would otherwise be retried for half an hour.
                    let permanent = status.is_client_error() && status.as_u16() != 408 && status.as_u16() != 429;
                    return Ok(Err((permanent, anyhow!("server returned {status}"))));
                }
                Ok::<Result<Value, (bool, anyhow::Error)>, anyhow::Error>(Ok(res.json().await?))
            };
            match attempt.await.unwrap_or_else(|e| Err((false, e))) {
                Ok(v) => {
                    return match v.get("error").and_then(|e| e.as_str()) {
                        Some(e) => Err(anyhow!("{e}")),
                        None => Ok(v["result"].clone()),
                    };
                }
                Err((true, e)) => return Err(e.context("huntaway server refused the call")),
                // The server is restarting; retry with the same call id so nothing runs twice.
                Err((false, e)) if failing_since.get_or_insert_with(Instant::now).elapsed() < Duration::from_secs(1800) => {
                    tracing::debug!("call to server failed, retrying: {e:#}");
                    tokio::time::sleep(delay).await;
                    delay = (delay * 2).min(Duration::from_secs(5));
                }
                Err((false, e)) => return Err(e.context("huntaway server unreachable")),
            }
        }
    }
}


/// Sent with `initialize`; Claude Code adds it to the agent's system prompt.
const INSTRUCTIONS: &str = "Tools for the Huntaway board, a kanban board where each task is worked by its own Claude agent. \
The board has a profile for each Claude login (e.g. work, personal), each with its own projects and tasks. Besides your own \
profile's, you can use the boards of the profiles that let your agents in (each profile chooses which, in Settings → Profiles). \
list_projects shows every project you can use, labelled with its profile and host. The other tools take a project or task \
from any of them by id or key; an unqualified key means your own profile's board first, and one used on several other boards \
must be qualified as <profile>:<key> (e.g. work:SD-3) or with the profile argument. A task created in another profile's \
project runs under that profile's Claude login. Don't create a project the user refers to as if it existed: if \
list_projects doesn't show it, it may be on a profile's board you can't use, so ask the user.";

/// What a reviewer reports (offered to review threads only).
fn submit_review_tool() -> Value {
    json!({
        "name": "submit_review",
        "description": "Report the outcome of your review. Call it once, when the review is complete. Serious issues are sent to the task's agent to fix.",
        "inputSchema": {"type": "object", "properties": {
            "verdict": {
                "type": "string",
                "enum": ["pass", "needs_fixes"],
                "description": "needs_fixes if anything must be fixed before merging (list it in serious_issues); pass if it's ready to merge as far as correctness goes"
            },
            "summary": {"type": "string", "description": "A few sentences: what you reviewed and what you found, including minor issues and suggestions worth mentioning"},
            "serious_issues": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Problems that must be fixed before merging: bugs that cause wrong behaviour, crashes, data loss, security holes, or a broken build or tests. One entry per issue: where (file:line), what goes wrong, and how to fix it. Empty if there are none. Style, nits and optional suggestions don't belong here."
            }
        }, "required": ["verdict", "summary", "serious_issues"]}
    })
}

/// The only tools review threads get: they read untrusted content (diffs, pull requests, the
/// repository), so they read the board, wait, ask and report, but don't create, change, start,
/// message or delete tasks or projects. The server checks it (tools::execute_mcp), not just this list.
const FOR_REVIEWERS: &[&str] = &["list_projects", "list_tasks", "get_task", "get_task_field", "get_project", "wait", "request_user_input", "submit_review"];

/// Whether a review thread may call `tool`. permission_prompt is Claude Code's own, for the
/// reviewer's other tools.
pub fn for_reviewers(tool: &str) -> bool {
    tool == "permission_prompt" || FOR_REVIEWERS.contains(&tool)
}

/// The board's tools, and for a review thread only those `for_reviewers`, with `submit_review`.
fn tools(review: bool) -> Value {
    let mut tools = board_tools();
    if review {
        let list = tools.as_array_mut().unwrap();
        list.push(submit_review_tool());
        list.retain(|t| t["name"].as_str().is_some_and(for_reviewers));
    }
    tools
}

/// The names of the tools in `tools(review)`.
pub fn tool_names(review: bool) -> Vec<String> {
    tools(review).as_array().into_iter().flatten().filter_map(|t| t["name"].as_str().map(String::from)).collect()
}

fn board_tools() -> Value {
    let status_enum = json!(crate::db::STATUSES);
    let permission_modes = json!(crate::db::PERMISSION_MODES.iter().copied().chain([""]).collect::<Vec<_>>());
    let resolution = json!({
        "type": "string", "enum": crate::db::RESOLUTIONS,
        "description": "How a done task ended. Only with status done; defaults to done."
    });
    let profile = json!({
        "type": "string",
        "description": "The profile whose board to use (e.g. work), if not your own; must be one that lets your agents in (see list_projects)"
    });
    let task_ref = json!({
        "type": "string",
        "description": "Task id or key like ABC-12; <profile>:ABC-12 for a task on another profile's board whose key is also used elsewhere"
    });
    let labels = json!({
        "type": "array", "items": {"type": "string", "enum": crate::db::LABELS},
        "description": "Documents the task's agent writes besides its other work, each shown in a tab of the task (get_task gives their files): 'plan', an HTML plan it writes first and iterates on with the user before doing the work; 'artifact', an HTML page (an explainer, dashboard or prototype); 'diagram', a Mermaid diagram. On update_task it replaces the task's labels; [] clears them."
    });
    let depends_on = json!({
        "type": "array", "items": {"type": "string"},
        "description": "Tasks in the same project (ids or keys like ABC-12) that have to be merged (done) before this task's agent starts. Until then, starting it queues it in in_progress. Replaces the task's current list; [] clears it."
    });
    let starred = json!({"type": "boolean", "description": "Star the task (true) or unstar it (false): starred tasks are listed in the board's sidebar"});
    let remind_at = json!({
        "type": "string",
        "description": "Remind the user of the task later: it's listed under Reminders in the board's sidebar, and shows as due from this time on. A delay from now (30m, 2h, 1d 12h, 1w), a time like 2026-05-01T09:00:00Z, or a date and time in the host's time zone (2026-05-01 09:00; a date alone means 9:00). Replaces any reminder it has; an empty string clears it."
    });
    let reminder = json!({"type": "string", "description": "What the reminder is for, shown with it (with remind_at, or to change the note of the reminder the task has)"});
    let project_ref = "Project id, key or name (<profile>:<key> for another profile's board), or 'all'";
    let project_one = "Project id, key or name (<profile>:<key> for another profile's board); defaults to the current project";
    let mut tools = json!([
        {
            "name": "permission_prompt",
            "description": "Internal: asks the user to approve a tool call.",
            "inputSchema": {"type": "object", "properties": {
                "tool_name": {"type": "string"}, "input": {"type": "object"}, "tool_use_id": {"type": "string"}
            }, "required": ["tool_name", "input"]}
        },
        {
            "name": "request_user_input",
            "description": format!("Flag this task as 'Needs attention' because you need an answer, decision or information from the user. \
                The board shows your question as a card in the thread. When the possible answers are known (a choice between approaches, \
                yes or no, which of several things to do), give them as options: the user then answers with a click (or keys 1-9), and \
                can still write their own answer unless allow_other is false. After calling it, end your turn with the question (and \
                what the user needs to know to answer it); the user's reply (the options they picked, or what they wrote) will resume \
                the conversation. Up to {} options.", crate::questions::MAX_OPTIONS),
            "inputSchema": {"type": "object", "properties": {
                "question": {"type": "string", "description": "The question, short enough to show on the task's card (e.g. 'Which database should the cache use?')"},
                "options": {
                    "type": "array",
                    "maxItems": crate::questions::MAX_OPTIONS,
                    "description": "The answers to pick from, if they're known; put the one you recommend first",
                    "items": {"type": "object", "properties": {
                        "label": {"type": "string", "description": "The answer, in a few words"},
                        "description": {"type": "string", "description": "What picking it means, or its trade-offs"}
                    }, "required": ["label"]}
                },
                "multi_select": {"type": "boolean", "description": "Let the user pick more than one option (default false)"},
                "allow_other": {"type": "boolean", "description": "Offer a free-text answer besides the options (default true)"}
            }, "required": ["question"]}
        },
        {
            "name": "wait",
            "description": format!("Wait without doing anything, e.g. for the tasks you created to finish, for a pull request's checks or reviews, or for a deploy or a background command. \
                The call blocks until the wait period is over, one of the listed tasks changes status, there's news about your pull_request, a subagent completes, fails or stops, your command exits, a message is sent to you, the run is \
                stopped, or you make another tool call (your subagents' tool calls other than board tools don't count), and says which. Meanwhile your task stays where it is (it doesn't need the user's attention) and the board shows it \
                as waiting rather than working, with your reason. Use it instead of sleeping or polling in a loop; call it again to keep \
                waiting. Without tasks, a command or a pull request, a wait lasts {} seconds at most, as little but a message or a subagent can end it early: for CI \
                or reviews on a pull request, give pull_request; for a deploy, give a command that exits once it's ready, or check and wait again. To wait for the user, use request_user_input instead.",
                crate::wait::UNWATCHED_MAX_SECS),
            "inputSchema": {"type": "object", "properties": {
                "reason": {"type": "string", "description": "What you're waiting for, shown on the board (e.g. 'waiting on OBP-1 and OWC-1', 'waiting for CI and review')"},
                "seconds": {"type": "number", "minimum": 1, "maximum": crate::wait::MAX_SECS, "description": format!(
                    "How long to wait at most (with tasks, a command or a pull request: default {}, at most {}; without them: default and at most {})",
                    crate::wait::DEFAULT_SECS, crate::wait::MAX_SECS, crate::wait::UNWATCHED_MAX_SECS
                )},
                "tasks": {"type": "array", "items": {"type": "string"}, "description": "Tasks (ids or keys like ABC-12, on this host) to watch: the wait ends as soon as one of them changes status"},
                "pull_request": {"type": "string", "description": "A pull request to watch: its number (in your task's repository), OWNER/REPO#NUMBER or URL. The wait ends on news about it you haven't been told yet (see pull_request_events): its head commit's checks finished (one failed, or all the required ones passed), someone other than your GitHub account commented or reviewed, it started to conflict with its base branch, or it was merged or closed. It says what happened in pull_request: the failed checks with their links, new comments with their author, file, line and text, and its merge state. What you've been told is remembered across waits, so after acting on the news wait on it again: a comment made meanwhile ends that wait straight away. The first wait on a pull request reports how its checks ended and a conflict, but not its earlier comments. GitHub is read every minute or so, as your GitHub account."},
                "pull_request_events": {"type": "array", "items": {"type": "string", "enum": crate::pr_watch::EVENTS}, "description": "With pull_request, the news that ends the wait (default all of it): checks_failed, checks_passed, comments (comments and reviews), conflicts. Its being merged or closed always does."},
                "command": {"type": "string", "description": "A shell command (bash) to run in your working directory while you wait: the wait ends as soon as it exits, and returns its exit code and the end of its output. Use one that blocks until what you're waiting for is ready (e.g. 'gh run watch 123'), or loop until it is (e.g. 'until curl -sf https://example.com/health; do sleep 15; done'). It's approved like your Bash calls, and stopped with everything it started if the wait ends first. For a pull request, give pull_request instead."}
            }, "required": ["reason"]}
        },
        {
            "name": "list_projects",
            "description": "List projects (id, key, name, repository path, profile, host) on every board you can use: your own profile's and those of other profiles (e.g. work, personal) that let your agents in, on every linked host. Projects the user has archived are left out. Check here before creating a project: one the user names may be on another profile's board.",
            "inputSchema": {"type": "object", "properties": {"profile": profile}}
        },
        {
            "name": "list_tasks",
            "description": "List tasks. Defaults to the current project (or, for a subproject and its tasks, the subproject's tasks); pass project_id='all' for every project on your profile's board (with profile, on that board; profile='all' for every board you can use).",
            "inputSchema": {"type": "object", "properties": {
                "project_id": {"type": "string", "description": project_ref},
                "profile": profile,
                "status": {"type": "string", "enum": status_enum},
                "subproject": {"type": "string", "description": "Only the tasks of this subproject (task id or key), 'none' for top-level tasks only, or 'all'"}
            }}
        },
        {
            "name": "get_task",
            "description": "Get a bounded overview of a task. Small fields are included inline; field_lengths lists every available field's length in Unicode characters, and omitted_fields names fields too large to include. Read any field (e.g. description, last_message, review, created_tasks) with get_task_field. Lengths count plain text for strings and pretty JSON for other values, including null.",
            "inputSchema": {"type": "object", "properties": {"task_id": task_ref, "profile": profile}, "required": ["task_id"]}
        },
        {
            "name": "get_task_field",
            "description": "Read one task field in bounded pages. Use a field name from get_task's field_lengths. Strings return plain text; other values return pretty JSON (format says which). offset, limit, length and total_length count Unicode characters, starting at offset 0. Follow next_offset until null; an offset at or past the end returns empty content. Reads use the current field value, so a task changing between calls may change the pages.",
            "inputSchema": {"type": "object", "properties": {
                "task_id": task_ref, "profile": profile,
                "field": {"type": "string", "description": "Top-level field name from get_task's field_lengths (e.g. description, last_message, review or created_tasks)"},
                "offset": {"type": "integer", "minimum": 0, "default": 0, "description": "Zero-based character offset"},
                "limit": {"type": "integer", "minimum": 1, "maximum": crate::tools::TASK_FIELD_MAX_LIMIT, "default": crate::tools::TASK_FIELD_DEFAULT_LIMIT, "description": "Maximum number of characters to return"}
            }, "required": ["task_id", "field"]}
        },
        {
            "name": "create_task",
            "description": "Create a task on the board. Set start=true to immediately launch an agent on it (in its own git worktree by default); with depends_on, it's queued in in_progress and its agent starts once those tasks are merged. A task in another profile's project runs under that profile's Claude config and login.",
            "inputSchema": {"type": "object", "properties": {
                "title": {"type": "string"},
                "description": {"type": "string", "description": "Full instructions for the agent that will work on it (markdown)"},
                "project_id": {"type": "string", "description": "Defaults to the current project. Also takes a key or name, or <profile>:<key> for a project on another profile's board (e.g. work:SD)"},
                "profile": profile,
                "status": {"type": "string", "enum": status_enum},
                "resolution": resolution,
                "use_worktree": {"type": "boolean"},
                "start": {"type": "boolean"},
                "subproject": {"type": "string", "description": "Add the task to this subproject (task id or key): it branches from the subproject's branch and merges back into it. Defaults to your own subproject, if you're in one; 'none' for a top-level task."},
                "is_subproject": {"type": "boolean", "description": "Make the new task a subproject, with its own board of tasks that merge into its branch"},
                "labels": labels,
                "type": {"type": "string", "enum": ["scratch", "subproject"], "description": "'scratch' for a scratch task, whose agent works in its own folder for whatever the user asks, without a worktree, branch or merge: in no project (keyed S-<n>) unless you give project_id or subproject, where it can read the repository (and the subproject's worktree). Or 'subproject', the same as is_subproject. Leave out for a normal task."},
                "depends_on": depends_on,
                "starred": starred,
                "remind_at": remind_at,
                "reminder": reminder
            }, "required": ["title"]}
        },
        {
            "name": "update_task",
            "description": "Update a task's title, description, status (and, for a done task, its resolution), pull request, preview URL, labels or dependencies, star it, or set a reminder to come back to it later (remind_at, e.g. when the user asks to be reminded or work has to wait until a later date). Moving a task to ready_for_merge asks its agent to merge its work, after which the agent sets it to done (a task with no changes to merge goes straight to done). Tasks merge one at a time: a merge that needs changes moves its task to in_progress with remerge, to let the next task merge while it makes them.",
            "inputSchema": {"type": "object", "properties": {
                "task_id": task_ref,
                "profile": profile,
                "title": {"type": "string"},
                "description": {"type": "string"},
                "status": {"type": "string", "enum": status_enum},
                "resolution": resolution,
                "pr_url": {"type": "string", "description": "The task's pull request; the board links it from the task's card. Empty string clears it."},
                "preview_url": {"type": "string", "description": "Where the task's work can be tried (e.g. its PR's preview deployment); the board shows whether it's up. A project that previews its pull requests fills it in from pr_url. Empty string clears it."},
                "labels": labels,
                "remerge": {"type": "boolean", "description": "With status in_progress, on a task that's merging: it steps out of the merge queue so the next task can merge, and rejoins the end of the queue when its agent's run ends, rather than going to in_review."},
                "depends_on": depends_on,
                "starred": starred,
                "remind_at": remind_at,
                "reminder": reminder
            }, "required": ["task_id"]}
        },
        {
            "name": "delete_task",
            "description": "Delete a task: stop its agent, delete its thread and remove its worktree, discarding uncommitted changes (a subproject's tasks go with it). \
                It asks the user to confirm first (say why in reason): the call waits for their answer, and if they don't confirm, nothing is deleted. \
                Only when the user asks for it, or a task you created is no longer wanted; you can't delete your own task or the subproject you're in. \
                To close a task while keeping it, set it to done (with a resolution) with update_task instead.",
            "inputSchema": {"type": "object", "properties": {
                "task_id": task_ref,
                "profile": profile,
                "delete_branch": {"type": "boolean", "description": "Also delete the task's git branch (and its tasks' branches, for a subproject); kept by default"},
                "reason": {"type": "string", "description": "Why it should be deleted, shown to the user when they're asked to confirm"}
            }, "required": ["task_id"]}
        },
        {
            "name": "send_to_task",
            "description": "Send a message to a task's agent, starting or resuming it. If that agent is currently running, the message goes to it straight away and it reads it after its current step (or, if it can't take messages while it works, it's queued and delivered when its run ends).",
            "inputSchema": {"type": "object", "properties": {
                "task_id": task_ref, "profile": profile, "message": {"type": "string"}
            }, "required": ["task_id", "message"]}
        },
        {
            "name": "get_project",
            "description": "Get a project's settings, including its prompt instructions (see update_project).",
            "inputSchema": {"type": "object", "properties": {
                "project_id": {"type": "string", "description": project_one},
                "profile": profile
            }}
        },
        {
            "name": "update_project",
            "description": "Change a project's settings; leave out the ones to keep. The prompt instructions are what the board tells agents as a task moves across the board, \
                and each replaces a default: start_prompt is sent to a task's agent when it starts (moving to in_progress), after the task's \
                title and description; review_prompt tells the reviewer what to look for when the task moves to in_review, after where its \
                changes are (the board adds how to report the verdict); merge_prompt tells the agent how to merge when the task moves to \
                ready_for_merge, after which branch to merge into which (the board adds asking the user if it can't, stepping out of the merge queue to make changes, and setting the task to \
                done). An empty string resets a prompt, base_branch, model or permission_mode to the default. Only change these when the user asks. \
                Changing permission_mode, a script, repo_path (and move_repo), use_worktrees or worktrees_root asks the user to approve the whole change first \
                (say why in reason): the call waits for their answer, and if they don't approve it nothing changes. A project's agent configs \
                can only be changed by the user.",
            "inputSchema": {"type": "object", "properties": {
                "project_id": {"type": "string", "description": project_one},
                "profile": profile,
                "name": {"type": "string", "description": "The project's display name"},
                "key": {"type": "string", "description": "The prefix of the project's task keys (e.g. ABC for ABC-12), letters and digits. Its tasks' keys change with it; the old keys still find them, and stay the project's."},
                "base_branch": {"type": "string", "description": "The branch new task branches start from and merge into"},
                "model": {"type": "string", "description": "The model the project's agents use, over the profile's and host's default"},
                "start_prompt": {"type": "string"},
                "review_prompt": {"type": "string"},
                "merge_prompt": {"type": "string"},
                "auto_review": {"type": "boolean", "description": "Review each task's changes when it moves to in_review"},
                "review_rounds": {"type": "integer", "minimum": 0, "maximum": 20, "description": "How many times in a row a review's serious issues go back to the agent to fix before the task is left for the user"},
                "group_name": {"type": "string", "description": "The sidebar group the project is in, shared with the host's other projects of that group name; an empty string takes it out of its group"},
                "reviewers": {"type": "array", "maxItems": 6, "description": "Who reviews each task, each in its own review thread; their serious issues are combined. An empty list is one reviewer with the task's own config. claude_config_id is an agent config's id (omit it for the task's config), model and effort override the defaults.",
                    "items": {"type": "object", "properties": {"claude_config_id": {"type": "string"}, "model": {"type": "string"}, "effort": {"type": "string"}}}},
                "permission_mode": {"type": "string", "enum": permission_modes, "description": "Needs approval. What the project's agents may do without asking the user, over the host's default"},
                "setup_script": {"type": "string", "description": "Needs approval. Runs in a task's new worktree"},
                "teardown_script": {"type": "string", "description": "Needs approval. Runs in a task's worktree before it's removed"},
                "status_script": {"type": "string", "description": "Needs approval. Runs whenever one of the project's tasks changes status"},
                "status_scripts": {"type": "object", "additionalProperties": {"type": "string"}, "description": "Needs approval. A script per status (the keys), run when a task moves into it; replaces them all, and a blank script is none"},
                "repo_path": {"type": "string", "description": "Needs approval. The project's repository folder, e.g. after the folder was moved or renamed: it must be the same repository (or, with move_repo, a path that doesn't exist yet). Task worktrees are reconnected to it."},
                "move_repo": {"type": "boolean", "description": "Needs approval. With repo_path, move the repository folder from where it is now to repo_path, rather than pointing the project at a folder that has already moved. The project's agents must not be running."},
                "use_worktrees": {"type": "boolean", "description": "Needs approval. Whether new tasks get a git worktree of their own"},
                "worktrees_root": {"type": "string", "description": "Needs approval. The folder tasks' worktrees go in"},
                "reason": {"type": "string", "description": "Why you're making the change, shown to the user when it needs their approval"}
            }}
        },
        {
            "name": "create_project",
            "description": "Add a project (a local repository directory) to your profile's board (or, with profile, to that profile's). A missing directory is created. Only when the user asks for a new project: first check list_projects, since the project may already be on another profile's board, and if it might be on a board you can't use, ask the user instead. \
                It asks the user to approve the folder first (say why in reason): the call waits for their answer, and if they don't approve it nothing is added.",
            "inputSchema": {"type": "object", "properties": {
                "name": {"type": "string"},
                "repo_path": {"type": "string", "description": "The folder, as an absolute path or starting with ~/"},
                "profile": profile,
                "reason": {"type": "string", "description": "Why you're adding it, shown to the user when they're asked to approve it"}
            }, "required": ["repo_path"]}
        }
    ]);
    tools.as_array_mut().unwrap().extend(automation_tools(&profile, project_one));
    tools
}

/// The tools for a project's automations (see automations.rs).
fn automation_tools(profile: &Value, project_one: &str) -> Vec<Value> {
    let automation_ref = json!({
        "type": "string",
        "description": "The automation's id, or its name in project_id (see list_automations)"
    });
    let trigger = json!({
        "type": "object",
        "description": format!("What starts it: {{kind: 'interval', every_minutes}} ({} minutes to 31 days, counted from when it's turned on or changed); \
            {{kind: 'daily', time: 'HH:MM', weekdays}} (in the host's time zone, on those weekdays, or every day with none); \
            or {{kind: 'webhook', filters, coalesce_seconds, coalesce_key}}: each POST to its URL that passes all the filters. \
            Use the fields of its kind.", crate::automations::MIN_INTERVAL_MINUTES),
        "properties": {
            "kind": {"type": "string", "enum": ["interval", "daily", "webhook"]},
            "every_minutes": {"type": "integer", "minimum": crate::automations::MIN_INTERVAL_MINUTES},
            "time": {"type": "string", "description": "A time of day like 09:30"},
            "weekdays": {"type": "array", "items": {"type": "string", "enum": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]}},
            "filters": {"type": "array", "description": "Conditions a delivery must meet: path names a value as templates do (event, action, labels, body.issue.user.login…)",
                "items": {"type": "object", "properties": {
                    "path": {"type": "string"},
                    "op": {"type": "string", "enum": ["equals", "not_equals", "starts_with", "contains", "in", "not_in", "exists", "not_exists"]},
                    "value": {"description": "A string, or a list for in and not_in; none for exists and not_exists"}
                }, "required": ["path", "op"]}},
            "coalesce_seconds": {"type": "integer", "minimum": 0, "maximum": 3600, "description": "Deliveries within this many seconds of the first make one run, with the latest one's values (0: each runs by itself)"},
            "coalesce_key": {"type": "string", "description": "With coalescing, only deliveries with the same key (a template such as {{body.issue.number}}) go together"}
        },
        "required": ["kind"]
    });
    let action = json!({
        "type": "object",
        "description": "What it does: {kind: 'create_task', title, description, task_type, labels, claude_config_id, model, effort, status, start} creates a task in the automation's project, \
            or {kind: 'send_to_task', task_id, message} sends a message to one of the project's tasks. Title, description and message are templates: \
            {{body.<path>}}, {{headers.<name>}}, {{query.<name>}}, {{event}}, {{action}}, {{labels}} and {{delivery}} from a webhook delivery \
            (marked as untrusted data for the agent), and {{date}}, {{time}}, {{now}}, {{automation}} and {{count}} from the board.",
        "properties": {
            "kind": {"type": "string", "enum": ["create_task", "send_to_task"]},
            "title": {"type": "string"},
            "description": {"type": "string", "description": "Instructions for the new task's agent (markdown)"},
            "task_type": {"type": "string", "enum": crate::db::TASK_TYPES, "description": "Leave out for a code task"},
            "labels": {"type": "array", "items": {"type": "string", "enum": crate::db::LABELS}, "description": "Documents the task's agent writes besides its other work: a plan, an artifact (an HTML page) or a diagram"},
            "claude_config_id": {"type": "string", "description": "One of the project's agent configs; leave out for its default"},
            "model": {"type": "string"},
            "effort": {"type": "string", "enum": crate::db::THREAD_EFFORTS},
            "status": {"type": "string", "enum": ["todo", "backlog"], "description": "Where the task goes (default todo); a started task moves to in_progress"},
            "start": {"type": "boolean", "description": "Start the new task's agent straight away"},
            "task_id": {"type": "string", "description": "The task to message: an id or key of a task in the same project"},
            "message": {"type": "string"}
        },
        "required": ["kind"]
    });
    let asks = "It asks the user to approve it first (say why in reason): the call waits for their answer, and if they don't approve it nothing changes.";
    let tools = json!([
        {
            "name": "list_automations",
            "description": "List a project's automations: what starts each one (an interval, a time of day or a webhook), what it does (create a task or message one), whether it's on, when it next runs, and its latest run. The time zone the times of day are in comes with them.",
            "inputSchema": {"type": "object", "properties": {"project_id": {"type": "string", "description": project_one}, "profile": profile}}
        },
        {
            "name": "create_automation",
            "description": format!("Add an automation to a project: it creates a task there, or sends a message to one of its tasks, on a schedule or whenever its webhook URL gets a delivery \
                (e.g. from GitHub). Only when the user asks for one. {asks} \
                For a webhook, the result has its hook_path (and webhook_url, if the host's public address is set), which lets whoever has it start runs, so only give it to \
                where the deliveries come from; with generate_secret, the secret to sign deliveries with is in the result, once."),
            "inputSchema": {"type": "object", "properties": {
                "project_id": {"type": "string", "description": project_one},
                "profile": profile,
                "name": {"type": "string"},
                "trigger": trigger,
                "action": action,
                "enabled": {"type": "boolean", "description": "On straight away (default true)"},
                "generate_secret": {"type": "boolean", "description": "For a webhook: make a secret that deliveries must be signed with (X-Hub-Signature-256, as GitHub's webhook Secret does)"},
                "reason": {"type": "string", "description": "Why, shown to the user when they're asked to approve it"}
            }, "required": ["name", "trigger", "action"]}
        },
        {
            "name": "update_automation",
            "description": format!("Change a project's automation; leave out what to keep. Turning it off (enabled false) or renaming it is done straight away; any other change, \
                including turning it on, asks the user. {asks}"),
            "inputSchema": {"type": "object", "properties": {
                "automation_id": automation_ref,
                "project_id": {"type": "string", "description": project_one},
                "profile": profile,
                "name": {"type": "string"},
                "trigger": trigger,
                "action": action,
                "enabled": {"type": "boolean"},
                "generate_secret": {"type": "boolean", "description": "For a webhook: a new signing secret, returned once in the result"},
                "remove_secret": {"type": "boolean", "description": "For a webhook: stop checking deliveries' signatures"},
                "rotate_url": {"type": "boolean", "description": "For a webhook: a new URL (the old one stops working)"},
                "reason": {"type": "string", "description": "Why, shown to the user when they're asked to approve it"}
            }, "required": ["automation_id"]}
        },
        {
            "name": "delete_automation",
            "description": format!("Delete a project's automation (its run history goes with it; the tasks it made stay). Only when the user asks for it. {asks}"),
            "inputSchema": {"type": "object", "properties": {
                "automation_id": automation_ref,
                "project_id": {"type": "string", "description": project_one},
                "profile": profile,
                "reason": {"type": "string", "description": "Why, shown to the user when they're asked to confirm"}
            }, "required": ["automation_id"]}
        },
        {
            "name": "run_automation",
            "description": "Run an automation once now, on or off, as its Run now (or, for a webhook, Test) does on the board: a webhook's run is a test delivery of payload (else the latest delivery's body) through its filters and templates, without the signature check, duplicate check or coalescing. Returns the run: its status, detail and task.",
            "inputSchema": {"type": "object", "properties": {
                "automation_id": automation_ref,
                "project_id": {"type": "string", "description": project_one},
                "profile": profile,
                "payload": {"description": "For a webhook: the test delivery's JSON body"},
                "event": {"type": "string", "description": "For a webhook: the test delivery's event (X-GitHub-Event), e.g. issues"}
            }, "required": ["automation_id"]}
        }
    ]);
    tools.as_array().cloned().unwrap_or_default()
}

/// Checks an agent's arguments against the tool's schema: an argument the tool doesn't have, or
/// a missing required one, is an error that names the tool's arguments. Claude Code doesn't
/// check them itself for a deferred tool whose schema the agent never loaded (with ToolSearch),
/// and an agent that guesses (`task` for `task_id`) would otherwise get "not found" or, where
/// the argument is optional, the default (its own project) instead.
pub fn check_args(tool: &str, args: &Value) -> std::result::Result<(), String> {
    let all = json!([board_tools(), [submit_review_tool()]]);
    // Internal, and filled in by Claude Code.
    let Some(schema) = all.as_array().unwrap().iter().flat_map(|l| l.as_array().unwrap()).find(|t| t["name"] == tool && tool != "permission_prompt") else {
        return Ok(());
    };
    let props = schema["inputSchema"]["properties"].as_object().unwrap();
    let names = || props.keys().map(String::as_str).collect::<Vec<_>>().join(", ");
    let hint = "If you haven't loaded this tool's schema (e.g. with ToolSearch), load it first.";
    let empty = serde_json::Map::new();
    let given = match args {
        Value::Null => &empty,
        Value::Object(m) => m,
        _ => return Err(format!("{tool}'s arguments must be an object")),
    };
    // `host` picks a linked host (see tools::dispatch).
    if let Some(k) = given.keys().find(|k| !props.contains_key(*k) && *k != "host") {
        return Err(format!("{tool} has no argument {k:?}; its arguments are {}. {hint}", names()));
    }
    for r in schema["inputSchema"]["required"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        if given.get(r).is_none_or(|v| v.is_null() || v == "") {
            return Err(format!("{tool} needs {r} (its arguments are {}). {hint}", names()));
        }
    }
    Ok(())
}

async fn handle(ctx: &Ctx, req: &Value) -> Option<Value> {
    let id = req.get("id").cloned()?; // notifications get no response
    let method = req["method"].as_str().unwrap_or("");
    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": req["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "huntaway", "version": env!("CARGO_PKG_VERSION")},
            "instructions": INSTRUCTIONS,
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools": tools(ctx.review)})),
        "tools/call" => {
            let name = req["params"]["name"].as_str().unwrap_or("");
            let args = req["params"]["arguments"].clone();
            Ok(match ctx.call(name, &args).await {
                // permission_prompt must return the raw decision JSON as text.
                Ok(v) => json!({"content": [{"type": "text", "text": if name == "permission_prompt" { v.to_string() } else { serde_json::to_string_pretty(&v).unwrap() }}]}),
                Err(e) => json!({"content": [{"type": "text", "text": format!("Error: {e:#}")}], "isError": true}),
            })
        }
        _ => Err(json!({"code": -32601, "message": format!("method not found: {method}")})),
    };
    Some(match result {
        Ok(r) => json!({"jsonrpc": "2.0", "id": id, "result": r}),
        Err(e) => json!({"jsonrpc": "2.0", "id": id, "error": e}),
    })
}

pub async fn serve_stdio() -> Result<()> {
    let ctx = Arc::new(Ctx {
        url: std::env::var("IA_URL").context("IA_URL not set")?,
        token: std::env::var("IA_TOKEN").context("IA_TOKEN not set")?,
        run_id: std::env::var("IA_RUN_ID").context("IA_RUN_ID not set")?,
        review: std::env::var("IA_REVIEW").is_ok_and(|v| v == "1"),
        http: reqwest::Client::new(),
    });
    let stdout = Arc::new(Mutex::new(tokio::io::stdout()));
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        let Ok(req) = serde_json::from_str::<Value>(&line) else { continue };
        let ctx = ctx.clone();
        let stdout = stdout.clone();
        // Requests are handled concurrently: permission prompts can block for a long time.
        tokio::spawn(async move {
            if let Some(resp) = handle(&ctx, &req).await {
                let mut out = stdout.lock().await;
                let _ = out.write_all(format!("{resp}\n").as_bytes()).await;
                let _ = out.flush().await;
            }
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helper_advertises_task_field_support_outside_the_tool_arguments() {
        crate::testing::run(async || {
            let app = axum::Router::new().route("/api/internal/mcp", axum::routing::post(
                |axum::Json(body): axum::Json<Value>| async move { axum::Json(json!({"result": body})) }
            ));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let ctx = Ctx::new(url, String::new(), "run".into());
            let args = json!({"task_id": "IA-1"});
            let sent = ctx.call("get_task", &args).await.unwrap();
            assert_eq!(sent["task_fields"], true);
            assert_eq!(sent["args"], args);
            assert_eq!(sent["run_id"], "run");
            assert!(tool_names(false).contains(&"get_task_field".into()));
            server.abort();
        });
    }

    #[test]
    fn reviewers_only_get_the_read_only_tools_and_submit_review() {
        let (task, review) = (tool_names(false), tool_names(true));
        assert!(task.contains(&"update_project".into()) && !task.contains(&"submit_review".into()));
        let mut review: Vec<&str> = review.iter().map(String::as_str).collect();
        review.sort();
        let want = ["get_project", "get_task", "get_task_field", "list_projects", "list_tasks", "permission_prompt", "request_user_input", "submit_review", "wait"];
        assert_eq!(review, want);
        assert!(task.contains(&"delete_task".into()));
    }

    #[test]
    fn checks_arguments_against_the_schema() {
        assert_eq!(check_args("get_task", &json!({"task_id": "IA-1", "profile": "work"})), Ok(()));
        assert_eq!(check_args("get_task_field", &json!({"task_id": "IA-1", "field": "description", "offset": 2, "limit": 10})), Ok(()));
        assert!(check_args("get_task_field", &json!({"task_id": "IA-1"})).unwrap_err().contains("needs field"));
        assert!(check_args("get_task_field", &json!({"task_id": "IA-1", "field": "description", "start": 1})).unwrap_err().contains("has no argument"));
        assert_eq!(check_args("list_projects", &Value::Null), Ok(()));
        assert_eq!(check_args("list_tasks", &json!({"project_id": "all", "host": "laptop"})), Ok(()));
        assert!(check_args("get_task", &json!({"task": "IA-1"})).unwrap_err().contains("its arguments are profile, task_id"));
        assert!(check_args("update_task", &json!({"task_id": "", "status": "done"})).unwrap_err().starts_with("update_task needs task_id"));
        assert!(check_args("list_tasks", &json!({"project": "issue-agent"})).is_err());
        assert!(check_args("submit_review", &json!({"verdict": "pass", "summary": "ok"})).unwrap_err().contains("serious_issues"));
        // Claude Code's own; and unknown tools are left to the server to refuse.
        assert_eq!(check_args("permission_prompt", &json!({"tool_name": "Bash", "input": {}, "extra": 1})), Ok(()));
        assert_eq!(check_args("no_such_tool", &json!({"x": 1})), Ok(()));
    }
}
