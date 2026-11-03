//! Summaries of a task's changes. Once a task's review passes (see review.rs), an agent of the
//! project's choosing (its `summarizer`, or else its profile's, or the task's own config) reads the work and writes a
//! summary of what changed for the user to read before merging it. It works read-only in the
//! task's worktree, in a thread of its own: a `review` task of type `summary` whose `parent_id`
//! is the task, so it's run like a reviewer (see agent/runner.rs) but isn't one of its reviewers. Its
//! last message is the summary, kept in the task's `summary` with the commit it describes, which
//! the task's sidebar opens on while the task waits in "In review".
//!
//! A summary in progress is stopped when the task's agent starts working again, and a new one
//! is written when the next review passes.

use serde_json::{Value, json};

use crate::agent::runner::Outcome;
use crate::db::{self, ChangeSummary, NewTask, Task};
use crate::git::worktree;
use crate::state::{ApiError, ApiResult, Shared};
use crate::util::now;

/// The task type of a summary thread.
pub const SUMMARY: &str = "summary";

/// Held while starting a summary, so two can't start on one task at once.
static STARTING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Held while changing a summary in progress (starting, ending or stopping it), never while
/// stopping an agent, which can end up back here.
static UPDATING: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn updating() -> std::sync::MutexGuard<'static, ()> {
    UPDATING.lock().unwrap_or_else(|e| e.into_inner())
}

/// Whether `thread` is a summary thread.
pub fn is_summary(thread: &Task) -> bool {
    thread.kind == "review" && thread.task_type.as_deref() == Some(SUMMARY)
}

/// The task's review passed: summarise its changes in the background, if its project wants that.
pub fn on_review_passed(state: &Shared, task_id: &str) {
    let state = state.clone();
    let id = task_id.to_string();
    tokio::spawn(async move {
        if let Err(e) = start(&state, &id, false).await {
            tracing::warn!(task = %id, "couldn't start a summary: {}", e.1);
            state.add_event(&id, "warn", "Couldn't summarise the changes", Some(e.1));
        }
    });
}

fn skip<T>(manual: bool, why: &str) -> ApiResult<Option<T>> {
    if manual { Err(ApiError::conflict(format!("Can't summarise: {why}"))) } else { Ok(None) }
}

/// Summarise a task's changes. `manual` (the user asked for it) summarises whatever the task's
/// review and column, even when the project doesn't summarise or this commit has a summary
/// already, and says why when it can't. Returns the task, or None when there was nothing to do.
pub async fn start(state: &Shared, task_id: &str, manual: bool) -> ApiResult<Option<Task>> {
    let _starting = STARTING.lock().await;
    let task = db::get_task(&state.db(), task_id)?.ok_or_else(|| ApiError::not_found("task"))?;
    let project = match (&task.project_id, task.kind.as_str()) {
        (Some(pid), "task") => db::get_project(&state.db(), pid)?,
        _ => None,
    };
    let Some(project) = project else { return skip(manual, "only tasks in a project have their changes summarised") };
    if !manual {
        // Only a review that has passed (and the task's agent hasn't gone back to work since).
        let passed = task.review.as_ref().is_some_and(|r| r.state == "passed");
        if !project.auto_summary || !passed || task.status != "in_review" {
            return Ok(None);
        }
    }
    let last_run = db::latest_run(&state.db(), &task.id, None)?;
    if state.is_running(&task.id) {
        return skip(manual, "the agent is still working");
    }
    if !crate::agent::runs::can_run_agents(state) {
        return skip(manual, "this host can't run agents");
    }
    let (Some(dir), Some(branch)) = (task.worktree_path.clone().filter(|_| task.worktree_state == "ready"), task.branch.clone()) else {
        return skip(manual, "the task has no worktree branch to summarise");
    };
    let previous = task.summaries.clone();
    if previous.iter().any(|s| s.state == "running") {
        return skip(manual, "a summary is already being written");
    }
    let dir = std::path::PathBuf::from(dir);
    let o = worktree::git(&dir, &["rev-parse", "--verify", "HEAD"]).await.ok().filter(|o| o.ok);
    let head = o.map(|o| o.stdout.trim().to_string()).filter(|h| !h.is_empty()).ok_or_else(|| ApiError::bad("couldn't read the worktree's HEAD commit"))?;
    // What the reviewers had as its work, too.
    let (base, own_start) = worktree::work_scope(state, &dir, &task, &project).await;
    let mut elsewhere = false;
    if let Some(b) = &base {
        let merge_base = worktree::git(&dir, &["merge-base", b, "HEAD"]).await.ok().filter(|o| o.ok).map(|o| o.stdout.trim().to_string());
        elsewhere = merge_base.as_deref() == Some(head.as_str());
    }

    // Each summarizer writes in a thread of its own, kept from one summary to the next while
    // its config, model, effort, name, skills and prompt stay the same.
    let task_config = db::task_claude_config(&state.db(), &task)?;
    let key = format!("{}-{}", project.key, task.number);
    let mut plans: Vec<Plan> = Vec::new();
    for spec in db::summarizers_for(&state.db(), &project)? {
        let config = match spec.claude_config_id.as_deref() {
            // A summarizer whose config was deleted writes with the task's.
            Some(id) => db::get_claude_config(&state.db(), id)?.or_else(|| task_config.clone()),
            None => task_config.clone(),
        };
        let config_id = config.as_ref().map(|c| c.id.clone());
        let model = spec.model.clone().filter(|m| !m.trim().is_empty());
        let effort = spec.effort.clone().filter(|e| !e.trim().is_empty());
        let variant = variant_key(&spec);
        // Two the same would share a thread.
        if plans.iter().any(|p| p.config_id == config_id && p.model == model && p.effort == effort && p.variant == variant) {
            continue;
        }
        let label = crate::review::label(config.as_ref(), model.as_deref(), effort.as_deref());
        plans.push(Plan { spec, codex: config.as_ref().is_some_and(|c| c.is_codex()), config_id, model, effort, variant, label });
    }
    let threads = db::summary_threads(&state.db(), &task.id)?;
    let mut writing: Vec<(Plan, Task)> = Vec::new();
    let mut summaries: Vec<ChangeSummary> = Vec::new();
    for plan in plans {
        let title = match plan.spec.name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
            Some(name) => format!("Summary of {key} · {name}"),
            None => format!("Summary of {key}"),
        };
        let thread = match threads.iter().find(|t| t.claude_config_id == plan.config_id && t.model == plan.model && t.effort == plan.effort && t.description == plan.variant) {
            Some(t) => t.clone(),
            None => {
                let t = db::insert_task(
                    &state.db(),
                    NewTask {
                        profile_id: &task.profile_id,
                        project_id: Some(&project.id),
                        kind: "review",
                        title: &title,
                        description: &plan.variant,
                        status: "todo",
                        use_worktree: false,
                        model: plan.model.as_deref(),
                        effort: plan.effort.as_deref(),
                        claude_config_id: plan.config_id.as_deref(),
                    },
                )?;
                let fields = [("parent_id", json!(task.id)), ("task_type", json!(SUMMARY))];
                state.update_task(&t.id, &fields)?.ok_or_else(|| ApiError::not_found("summary thread"))?
            }
        };
        // Already summarised at this commit, and not asked for again.
        if !manual {
            if let Some(done) = previous.iter().find(|s| s.thread_id == thread.id && s.state == "done" && s.head.as_deref() == Some(head.as_str())) {
                summaries.push(done.clone());
                continue;
            }
        }
        if thread.title != title {
            state.update_task(&thread.id, &[("title", json!(title))])?;
        }
        if state.is_running(&thread.id) {
            return Err(ApiError::conflict(format!("the summary thread's agent ({}) is busy; wait for it to finish or stop it", plan.label)));
        }
        let after_run = Some(db::latest_run(&state.db(), &thread.id, None)?.unwrap_or_default());
        summaries.push(ChangeSummary {
            thread_id: thread.id.clone(),
            label: plan.label.clone(),
            name: plan.spec.name.clone().filter(|n| !n.trim().is_empty()),
            skills: plan.spec.skills.clone(),
            custom_prompt: plan.spec.prompt.is_some(),
            state: "running".into(),
            head: Some(head.clone()),
            text: None,
            after_run,
            updated_at: now(),
        });
        writing.push((plan, thread));
    }
    if writing.is_empty() {
        return Ok(None);
    }
    let commit = &head[..head.len().min(10)];
    let last_message = if elsewhere { db::last_assistant_text(&state.db(), &task.id)? } else { None };
    let mut texts = Vec::new();
    for (plan, thread) in &writing {
        texts.push(prompt(&key, &task, &branch, base.as_deref(), commit, elsewhere, own_start, last_message.as_deref(), &plan.spec, plan.codex));
        // A fresh conversation for each summary; the thread keeps every one's messages.
        state.update_task(&thread.id, &[("session_id", Value::Null)])?;
        crate::agent::context::clear(state, &thread.id)?;
    }
    let sent: Vec<Result<Task, ApiError>> = {
        let _g = updating();
        // The agent may have started again meanwhile (and `supersede` found nothing to stop).
        let later = db::later_run(&state.db(), &task.id, last_run.as_deref().unwrap_or_default())?;
        if later || state.is_running(&task.id) {
            return skip(manual, "the agent is working again");
        }
        set_summaries(state, &task.id, &summaries)?;
        let sent = writing
            .iter()
            .zip(&texts)
            .map(|((_, thread), text)| {
                state.add_event(&thread.id, "info", format!("Summarising commit {commit}"), None);
                crate::agent::runner::send_review(state, &thread.id, text)
            })
            .collect::<Vec<_>>();
        // Those that couldn't start have failed.
        let failed: Vec<(&str, String)> = writing.iter().zip(&sent).filter_map(|((_, t), r)| r.as_ref().err().map(|e| (t.id.as_str(), e.1.clone()))).collect();
        if !failed.is_empty() {
            for s in summaries.iter_mut() {
                if let Some((_, why)) = failed.iter().find(|(id, _)| *id == s.thread_id) {
                    s.state = "failed".into();
                    s.text = Some(format!("Couldn't start the summary: {why}"));
                    s.updated_at = now();
                }
            }
            set_summaries(state, &task.id, &summaries)?;
        }
        sent
    };
    if sent.iter().all(Result::is_err) {
        return Err(sent.into_iter().find_map(Result::err).expect("one failed"));
    }
    state.add_event(&task.id, "info", format!("Summarising the changes (commit {commit})"), None);
    Ok(db::get_task(&state.db(), &task.id)?)
}

/// One summarizer's part of a summary being started.
struct Plan {
    spec: db::Reviewer,
    /// Whether its agent is Codex, which is asked for skills differently.
    codex: bool,
    config_id: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    /// What tells its thread from the others' with the same agent (see `variant_key`).
    variant: String,
    label: String,
}

/// What, besides its agent, tells a summarizer's thread from another's: its name, skills and prompt
/// as text (empty if it has none, as the threads written before there could be several).
fn variant_key(spec: &db::Reviewer) -> String {
    let name = spec.name.as_deref().map(str::trim).unwrap_or_default();
    let prompt = spec.prompt.as_deref().map(str::trim).unwrap_or_default();
    if name.is_empty() && prompt.is_empty() && spec.skills.is_empty() {
        return String::new();
    }
    json!({"name": name, "skills": spec.skills, "prompt": prompt}).to_string()
}

/// How the board asks for a summary to be written, unless the summarizer has a prompt of its own.
const DEFAULT_WRITING: &str = "\nThe user reads your summary before they merge the work, to see what it does without reading the whole diff. Write \
     it in Markdown, briefly: start with a sentence or two on what changed and why, then the main changes (grouped by \
     area, naming the files or modules where it helps), any decisions or behaviour changes worth knowing about, and \
     how to try it if that isn't obvious. Leave out what the diff makes plain at a glance, and don't review the work or \
     pad it out.\n";

/// How much of the agent's last message goes in the prompt.
const LAST_MESSAGE_CHARS: usize = 6000;

/// Where the work is (on the branch, or `elsewhere` when the branch has no commits of its own and
/// the agent's `last_message` says where; `own_start` when it starts after where it left its base
/// branch, at `base`, see worktree::work_scope), and how to write the summary.
#[allow(clippy::too_many_arguments)]
fn prompt(key: &str, task: &Task, branch: &str, base: Option<&str>, commit: &str, elsewhere: bool, own_start: bool, last_message: Option<&str>, spec: &db::Reviewer, codex: bool) -> String {
    let mut p = format!("Summarise the changes made for task {key}: \"{}\".\n", task.title);
    if !task.description.trim().is_empty() {
        p.push_str(&format!("\nThe task's description:\n\n{}\n", task.description.trim()));
    }
    if let (false, true, Some(b)) = (elsewhere, own_start, base) {
        p.push_str(&format!(
            "\nThe work is on branch `{branch}` (commit {commit}), checked out in your working directory. It started from \
             commit {b}, after where it left its base branch, so its pull request's diff (if it has one) also has commits \
             that aren't its own: read the branch's changes (`git diff {b}...HEAD`, and `git log {b}..HEAD`) rather than \
             `pr_diff`. Read its pull request with the gh MCP server's `pr_view` tool (pr `{branch}`) only for its description.\n"
        ));
    } else if !elsewhere {
        let fallback = match base {
            Some(b) => format!("the branch's changes (`git diff {b}...HEAD`, and `git log {b}..HEAD`)"),
            None => "the branch's commits".into(),
        };
        p.push_str(&format!(
            "\nThe work is on branch `{branch}` (commit {commit}), checked out in your working directory. Find its pull \
             request with the gh MCP server's `pr_view` tool (pr `{branch}`) and read its changes (`pr_diff`). If it has no \
             pull request, read {fallback} instead.\n"
        ));
    } else {
        p.push_str(&format!(
            "\nThe task's branch `{branch}`, checked out in your working directory, has no commits of its own (it's still at \
             commit {commit}), so the agent made its changes somewhere else, such as in another repository. Find them from \
             what it says it did"
        ));
        if let Some(url) = task.pr_url.as_deref().filter(|u| !u.is_empty()) {
            p.push_str(&format!(" and from the task's pull request, {url}"));
        }
        p.push_str(".\n");
        match last_message.map(str::trim).filter(|m| !m.is_empty()) {
            Some(m) => {
                let mut m = m.to_string();
                if let Some((i, _)) = m.char_indices().nth(LAST_MESSAGE_CHARS) {
                    m.truncate(i);
                    m.push_str(" [...]");
                }
                p.push_str(&format!("\nThe agent's last message:\n\n{}\n", m.lines().map(|l| format!("> {l}")).collect::<Vec<_>>().join("\n")));
            }
            None => p.push_str("\nThe agent didn't leave a message saying what it did.\n"),
        }
    }
    if let Some(r) = task.review.as_ref().and_then(|r| r.summary.as_deref()).map(str::trim).filter(|s| !s.is_empty()) {
        p.push_str(&format!("\nIts review passed. The reviewer said:\n\n{}\n", r.lines().map(|l| format!("> {l}")).collect::<Vec<_>>().join("\n")));
    }
    match spec.prompt.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        Some(custom) => p.push_str(&format!("\nThe user reads your summary before they merge the work. Write it as they ask:\n\n{custom}\n")),
        None => p.push_str(DEFAULT_WRITING),
    }
    if !spec.skills.is_empty() {
        let named: Vec<String> = spec.skills.iter().map(|s| format!("`{}{s}`", if codex { '$' } else { '/' })).collect();
        p.push_str(&format!(
            "\nUse {} while you write the summary: {}{}. If a skill asks for something against the rest of this message \
             (changing files, or ending with more than the summary), follow this message instead.\n",
            if spec.skills.len() == 1 { "this skill" } else { "these skills" },
            named.join(", "),
            if codex { "" } else { " (invoke each with the `Skill` tool)" },
        ));
    }
    p.push_str(
        "\nDon't change anything. Your last message is the summary, shown as it is on the task: end your turn with only the \
         summary, without a preamble.",
    );
    p
}

fn set_summaries(state: &Shared, task_id: &str, summaries: &[ChangeSummary]) -> anyhow::Result<()> {
    let value = if summaries.is_empty() { Value::Null } else { json!(summaries) };
    state.update_task(task_id, &[("summary", value)])?;
    Ok(())
}

/// The summary `thread_id` is writing for the task, if it is.
fn in_progress(state: &Shared, task_id: &str, thread_id: &str) -> Option<Vec<ChangeSummary>> {
    let task = db::get_task(&state.db(), task_id).ok().flatten()?;
    task.summaries.iter().any(|s| s.state == "running" && s.thread_id == thread_id).then_some(task.summaries)
}

/// The summary thread's run `run_id` ended: its last message is the summary.
pub fn finished(state: &Shared, thread: &Task, run_id: &str, outcome: &Outcome, attention: Option<&str>) {
    let Some(parent_id) = thread.parent_id.as_deref() else { return };
    let _g = updating();
    let Some(mut all) = in_progress(state, parent_id, &thread.id) else { return };
    let Some(summary) = all.iter_mut().find(|s| s.thread_id == thread.id) else { return };
    // From an earlier run of the thread (one stopped late, say): this summary isn't its.
    if summary.after_run.as_deref().is_some_and(|after| !db::run_after(&state.db(), &thread.id, run_id, after).unwrap_or(false)) {
        return;
    }
    let written = || -> Option<String> {
        // What it said after it was asked for this summary.
        let asked: i64 = state
            .db()
            .query_row("SELECT COALESCE(MAX(id), 0) FROM messages WHERE task_id=?1 AND kind='user'", [&thread.id], |r| r.get(0))
            .ok()?;
        db::last_assistant_text_after(&state.db(), &thread.id, asked).ok().flatten().map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
    };
    let (st, text) = match outcome {
        Outcome::Cancelled => ("stopped", Some("The summary was stopped.".to_string())),
        Outcome::Failed(e) => ("failed", Some(format!("The summary failed: {}", e.lines().next().unwrap_or("")))),
        Outcome::Ok if attention.is_some() => ("failed", attention.map(|q| format!("The summarizer asked: {q}"))),
        Outcome::Ok => match written() {
            Some(t) => ("done", Some(t)),
            None => ("failed", Some("The summarizer finished without writing a summary.".to_string())),
        },
    };
    summary.state = st.into();
    summary.text = text;
    summary.updated_at = now();
    let (label, failed) = (summary.label.clone(), summary.text.clone());
    if let Err(e) = set_summaries(state, parent_id, &all) {
        tracing::error!("failed to record a summary: {e:#}");
        return;
    }
    // With several, the event says whose it is.
    let several = all.len() > 1;
    let title = |what: &str| if several { format!("{what} ({label})") } else { what.to_string() };
    match st {
        "done" => state.add_event(parent_id, "info", title("Changes summarised"), None),
        "stopped" => {}
        _ => state.add_event(parent_id, "warn", title("Couldn't summarise the changes"), failed),
    }
}

/// The task's agent started working again: the summaries in progress are out of date.
pub fn supersede(state: &Shared, task: &Task) {
    stop_summary(state, &task.id, "Stopped because the agent started working on the task again.");
}

/// The user stopped the task: stop its summaries too, if any are being written. Returns whether any was.
pub fn stop(state: &Shared, task_id: &str) -> bool {
    stop_summary(state, task_id, "Stopped by the user.")
}

fn stop_summary(state: &Shared, task_id: &str, why: &str) -> bool {
    let threads: Vec<String> = {
        let _g = updating();
        let mut all = db::get_task(&state.db(), task_id).ok().flatten().map(|t| t.summaries).unwrap_or_default();
        let mut running = Vec::new();
        for summary in all.iter_mut().filter(|s| s.state == "running") {
            summary.state = "stopped".into();
            summary.text = Some(why.into());
            summary.updated_at = now();
            running.push(summary.thread_id.clone());
        }
        if running.is_empty() {
            return false;
        }
        if let Err(e) = set_summaries(state, task_id, &all) {
            tracing::warn!("failed to update a summary: {e:#}");
        }
        running
    };
    for thread in threads {
        crate::agent::runner::stop(state, &thread);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_prompt_locates_the_work_and_asks_for_only_the_summary() {
        let c = db::open(std::path::Path::new(":memory:")).unwrap();
        let p = db::insert_profile(&c, "p", &[], None).unwrap();
        let t = NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "Fix it", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let mut task = db::insert_task(&c, t).unwrap();
        task.review = Some(db::Review { state: "passed".into(), summary: Some("Looks good.".into()), ..Default::default() });
        let text = prompt("X-1", &task, "ia/x-1", Some("master"), "abc", false, false, None, &db::Reviewer::default(), false);
        for want in ["task X-1: \"Fix it\"", "`pr_view` tool (pr `ia/x-1`)", "`git diff master...HEAD`", "> Looks good.", "end your turn with only the summary"] {
            assert!(text.contains(want), "{want:?} not in {text}");
        }
        let text = prompt("X-1", &task, "ia/x-1", Some("master"), "abc", true, false, Some("Done in o/deploy#4."), &db::Reviewer::default(), false);
        assert!(text.contains("no commits of its own") && text.contains("> Done in o/deploy#4."), "{text}");
        assert!(!text.contains("skill"), "{text}");
    }

    #[test]
    fn the_prompt_asks_for_a_summarizers_skills_and_prompt() {
        let c = db::open(std::path::Path::new(":memory:")).unwrap();
        let p = db::insert_profile(&c, "p", &[], None).unwrap();
        let t = NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "Fix it", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let task = db::insert_task(&c, t).unwrap();
        let spec = db::Reviewer { skills: vec!["tldr".into(), "changelog".into()], prompt: Some("  Two bullets, no more.  ".into()), ..Default::default() };
        let text = prompt("X-1", &task, "ia/x-1", Some("master"), "abc", false, false, None, &spec, false);
        assert!(text.contains("these skills while you write the summary: `/tldr`, `/changelog` (invoke each with the `Skill` tool)"), "{text}");
        // Its prompt is the board's instead of the default, and the board still asks for only the summary.
        assert!(text.contains("Write it as they ask:\n\nTwo bullets, no more.\n") && !text.contains("Write it in Markdown, briefly"), "{text}");
        assert!(text.contains("end your turn with only the summary"), "{text}");
        let codex = prompt("X-1", &task, "ia/x-1", Some("master"), "abc", false, false, None, &db::Reviewer { skills: vec!["tldr".into()], ..Default::default() }, true);
        assert!(codex.contains("this skill while you write the summary: `$tldr`.") && codex.contains("Write it in Markdown, briefly"), "{codex}");
    }

    /// A task in review whose review passed, in a project that summarises, with a worktree branch with a commit.
    fn passed(s: &Shared) -> Task {
        let p = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let np = db::NewProject { id: "pr", profile_id: &p.id, name: "x", key: "X", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: true };
        db::insert_project(&s.db(), np).unwrap();
        let new = NewTask { profile_id: &p.id, project_id: Some("pr"), kind: "task", title: "t", description: "", status: "in_review", use_worktree: true, model: None, effort: None, claude_config_id: None };
        let task = db::insert_task(&s.db(), new).unwrap();
        let dir = crate::testing::temp_dir();
        for args in [&["init", "-q"][..], &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "work"]] {
            assert!(std::process::Command::new("git").arg("-C").arg(&dir).args(args).status().unwrap().success());
        }
        let review = db::Review { thread_id: "r".into(), state: "passed".into(), summary: Some("Fine.".into()), updated_at: now(), ..Default::default() };
        let fields = [("worktree_path", json!(crate::util::path_str(&dir))), ("worktree_state", json!("ready")), ("branch", json!("ia/x")), ("review", json!(review))];
        db::update_task(&s.db(), &task.id, &fields).unwrap().unwrap()
    }

    fn summary_of(s: &Shared, task: &Task) -> Option<ChangeSummary> {
        db::get_task(&s.db(), &task.id).unwrap().unwrap().summary
    }

    /// End the thread's run as a finished turn whose last message was `said`.
    fn reply(s: &Shared, thread: &Task, said: Option<&str>) {
        let run = s.runs.lock().unwrap().get(&thread.id).expect("the summarizer is running").run_id.clone();
        if let Some(said) = said {
            s.add_message(&thread.id, "claude", json!({"type": "result", "subtype": "success", "result": said})).unwrap();
        }
        s.db().execute("UPDATE runs SET saw_result=1 WHERE id=?1", [&run]).unwrap();
        crate::agent::runner::on_exit(s, &run, Some(0), None, None, "");
    }

    #[test]
    fn a_passed_review_is_summarised_by_the_projects_summarizer() {
        crate::testing::run(async || {
            crate::agent::runs::TEST_CAN_RUN.set(true);
            let s = crate::testing::state();
            let task = passed(&s);
            let haiku = db::Reviewer { model: Some("haiku".into()), ..Default::default() };
            db::update_project(&s.db(), "pr", &[("summarizer", json!(json!(haiku).to_string()))]).unwrap();
            start(&s, &task.id, false).await.map_err(|e| e.1).unwrap().expect("it starts");
            let sum = summary_of(&s, &task).unwrap();
            assert_eq!((sum.state.as_str(), sum.label.as_str()), ("running", "Claude · haiku"));
            let threads = db::summary_threads(&s.db(), &task.id).unwrap();
            assert_eq!(threads.len(), 1);
            let thread = &threads[0];
            assert_eq!((thread.id.as_str(), thread.model.as_deref(), thread.parent_id.as_deref()), (sum.thread_id.as_str(), Some("haiku"), Some(task.id.as_str())));
            assert!(is_summary(thread));
            // It isn't one of the task's reviewers, though it works in the worktree as they do.
            assert!(crate::git::worktree::agent_in_worktree(&s, &task.id));
            let prompt = db::list_messages(&s.db(), &thread.id).unwrap().into_iter().find(|m| m.kind == "user").unwrap();
            assert!(prompt.data["text"].as_str().unwrap().contains("Summarise the changes made for task X-1"), "{}", prompt.data);

            reply(&s, thread, Some("  ## What changed\n\nA fix.  "));
            let sum = summary_of(&s, &task).unwrap();
            assert_eq!((sum.state.as_str(), sum.text.as_deref()), ("done", Some("## What changed\n\nA fix.")));
            // The task stays where it is.
            assert_eq!(db::get_task(&s.db(), &task.id).unwrap().unwrap().status, "in_review");
            // This commit has its summary; asked for, it's written again, in the same thread.
            assert!(start(&s, &task.id, false).await.map_err(|e| e.1).unwrap().is_none());
            start(&s, &task.id, true).await.map_err(|e| e.1).unwrap().unwrap();
            assert_eq!(db::summary_threads(&s.db(), &task.id).unwrap().len(), 1);
            // A run that says nothing new doesn't pass off the last summary as its own.
            reply(&s, thread, None);
            let sum = summary_of(&s, &task).unwrap();
            assert_eq!(sum.state, "failed", "{:?}", sum.text);
            crate::agent::runs::TEST_CAN_RUN.set(false);
        })
    }

    #[test]
    fn a_task_that_started_after_its_base_branch_is_summarised_from_where_it_started() {
        crate::testing::run(async || {
            crate::agent::runs::TEST_CAN_RUN.set(true);
            let s = crate::testing::state();
            let task = passed(&s);
            let dir = std::path::PathBuf::from(task.worktree_path.clone().unwrap());
            let git = |args: &[&str]| {
                let mut cmd = std::process::Command::new("git");
                cmd.arg("-C").arg(&dir).args(["-c", "user.name=t", "-c", "user.email=t@t"]).args(args);
                assert!(cmd.status().unwrap().success());
                String::from_utf8(cmd.output().unwrap().stdout).unwrap().trim().to_string()
            };
            // It starts at a commit master doesn't have, with someone else's work, and has a pull request into master.
            git(&["branch", "-q", "-m", "master"]);
            git(&["commit", "-q", "--allow-empty", "-m", "someone else's"]);
            let start_at = git(&["rev-parse", "HEAD"]);
            git(&["checkout", "-q", "-b", "ia/x"]);
            git(&["branch", "-q", "-f", "master", "HEAD~1"]);
            git(&["update-ref", &format!("refs/huntaway/start/{}", task.id), "HEAD"]);
            git(&["commit", "-q", "--allow-empty", "-m", "its own"]);
            let fields = [
                ("base_branch", json!("master")),
                ("start_from", json!(db::StartFrom::Commit { commit: start_at.clone() })),
                ("pr_url", json!("https://github.com/o/r/pull/3")),
            ];
            db::update_task(&s.db(), &task.id, &fields).unwrap();
            start(&s, &task.id, true).await.map_err(|e| e.1).unwrap().expect("it starts");
            let thread = db::summary_threads(&s.db(), &task.id).unwrap().remove(0);
            let prompt = db::list_messages(&s.db(), &thread.id).unwrap().into_iter().find(|m| m.kind == "user").unwrap();
            let text = prompt.data["text"].as_str().unwrap();
            assert!(text.contains(&format!("`git diff {start_at}...HEAD`, and `git log {start_at}..HEAD`) rather than `pr_diff`")), "{text}");
            assert!(!text.contains("master...HEAD") && !text.contains("read its changes (`pr_diff`)"), "{text}");
            reply(&s, &thread, Some("A summary."));
            crate::agent::runs::TEST_CAN_RUN.set(false);
        })
    }

    #[test]
    fn a_project_without_a_summarizer_uses_its_profiles() {
        crate::testing::run(async || {
            crate::agent::runs::TEST_CAN_RUN.set(true);
            let s = crate::testing::state();
            let task = passed(&s);
            let haiku = db::Reviewer { model: Some("haiku".into()), ..Default::default() };
            db::update_profile(&s.db(), &task.profile_id, &[("summarizer", json!(json!(haiku).to_string()))]).unwrap();
            start(&s, &task.id, false).await.map_err(|e| e.1).unwrap().expect("it starts");
            assert_eq!(summary_of(&s, &task).unwrap().label, "Claude · haiku");
            let thread = db::summary_threads(&s.db(), &task.id).unwrap().remove(0);
            reply(&s, &thread, Some("A summary."));
            // The project's own is used over it, in a thread of its own.
            let sonnet = db::Reviewer { model: Some("sonnet".into()), ..Default::default() };
            db::update_project(&s.db(), "pr", &[("summarizer", json!(json!(sonnet).to_string()))]).unwrap();
            start(&s, &task.id, true).await.map_err(|e| e.1).unwrap().unwrap();
            assert_eq!(summary_of(&s, &task).unwrap().label, "Claude · sonnet");
            assert_eq!(db::summary_threads(&s.db(), &task.id).unwrap().len(), 2);
            crate::agent::runs::TEST_CAN_RUN.set(false);
        })
    }

    #[test]
    fn only_a_passed_review_in_a_project_that_summarises_is_summarised() {
        crate::testing::run(async || {
            crate::agent::runs::TEST_CAN_RUN.set(true);
            let s = crate::testing::state();
            let task = passed(&s);
            db::update_project(&s.db(), "pr", &[("auto_summary", json!(false))]).unwrap();
            assert!(start(&s, &task.id, false).await.map_err(|e| e.1).unwrap().is_none());
            db::update_project(&s.db(), "pr", &[("auto_summary", json!(true))]).unwrap();
            let issues = db::Review { state: "issues".into(), updated_at: now(), ..Default::default() };
            s.update_task(&task.id, &[("review", json!(issues))]).unwrap();
            assert!(start(&s, &task.id, false).await.map_err(|e| e.1).unwrap().is_none());
            let review = db::Review { state: "passed".into(), updated_at: now(), ..Default::default() };
            s.update_task(&task.id, &[("review", json!(review)), ("status", json!("ready_for_merge"))]).unwrap();
            assert!(start(&s, &task.id, false).await.map_err(|e| e.1).unwrap().is_none());
            assert!(summary_of(&s, &task).is_none() && db::summary_threads(&s.db(), &task.id).unwrap().is_empty());
            crate::agent::runs::TEST_CAN_RUN.set(false);
        })
    }

    #[test]
    fn the_agent_working_again_stops_the_summary() {
        crate::testing::run(async || {
            crate::agent::runs::TEST_CAN_RUN.set(true);
            let s = crate::testing::state();
            let task = passed(&s);
            start(&s, &task.id, false).await.map_err(|e| e.1).unwrap().unwrap();
            let thread = db::summary_threads(&s.db(), &task.id).unwrap().remove(0);
            crate::agent::runner::send(&s, &task.id, "one more thing").unwrap();
            let sum = summary_of(&s, &task).unwrap();
            assert_eq!(sum.state, "stopped");
            // Its run ending afterwards doesn't change that.
            reply(&s, &thread, Some("A summary."));
            assert_eq!(summary_of(&s, &task).unwrap().state, "stopped");
            crate::agent::runs::TEST_CAN_RUN.set(false);
        })
    }

    #[test]
    fn a_review_doesnt_take_the_summary_thread_for_a_reviewers() {
        crate::testing::run(async || {
            crate::agent::runs::TEST_CAN_RUN.set(true);
            let s = crate::testing::state();
            let task = passed(&s);
            start(&s, &task.id, false).await.map_err(|e| e.1).unwrap().unwrap();
            let thread = db::summary_threads(&s.db(), &task.id).unwrap().remove(0);
            reply(&s, &thread, Some("A summary."));
            crate::review::start(&s, &task.id, true).await.map_err(|e| e.1).unwrap().unwrap();
            let review = db::get_task(&s.db(), &task.id).unwrap().unwrap().review.unwrap();
            assert_ne!(review.reviewers[0].thread_id, thread.id);
            crate::agent::runs::TEST_CAN_RUN.set(false);
        })
    }

    /// Both of a task's summarizers' threads, in the order of its summaries.
    fn both(s: &Shared, task: &Task) -> Vec<Task> {
        let summaries = db::get_task(&s.db(), &task.id).unwrap().unwrap().summaries;
        let threads = db::summary_threads(&s.db(), &task.id).unwrap();
        summaries.iter().map(|sum| threads.iter().find(|t| t.id == sum.thread_id).unwrap().clone()).collect()
    }

    fn two_summarizers(s: &Shared) {
        let plain = db::Reviewer { name: Some("Plain".into()), ..Default::default() };
        let skilled = db::Reviewer { name: Some("Skilled".into()), skills: vec!["tldr".into()], prompt: Some("Be brief.".into()), ..Default::default() };
        db::update_project(&s.db(), "pr", &[("summarizers", json!(json!([plain, skilled]).to_string()))]).unwrap();
    }

    #[test]
    fn each_summarizer_writes_a_summary_in_a_thread_of_its_own() {
        crate::testing::run(async || {
            crate::agent::runs::TEST_CAN_RUN.set(true);
            let s = crate::testing::state();
            let task = passed(&s);
            two_summarizers(&s);
            start(&s, &task.id, false).await.map_err(|e| e.1).unwrap().expect("it starts");
            let threads = both(&s, &task);
            assert_eq!(threads.len(), 2);
            assert_ne!(threads[0].id, threads[1].id);
            let t = db::get_task(&s.db(), &task.id).unwrap().unwrap();
            let names: Vec<_> = t.summaries.iter().map(|x| (x.name.as_deref(), x.state.as_str(), x.skills.clone(), x.custom_prompt)).collect();
            assert_eq!(names, vec![(Some("Plain"), "running", vec![], false), (Some("Skilled"), "running", vec!["tldr".to_string()], true)]);
            // What older clients read is the first.
            assert_eq!(t.summary.as_ref().map(|x| x.thread_id.as_str()), Some(threads[0].id.as_str()));
            assert_eq!(threads[1].title, "Summary of X-1 · Skilled");
            let asked = |th: &Task| db::list_messages(&s.db(), &th.id).unwrap().into_iter().find(|m| m.kind == "user").unwrap().data["text"].as_str().unwrap().to_string();
            assert!(!asked(&threads[0]).contains("/tldr") && asked(&threads[1]).contains("`/tldr`") && asked(&threads[1]).contains("Be brief."));

            // They finish on their own.
            reply(&s, &threads[1], Some("Short."));
            let t = db::get_task(&s.db(), &task.id).unwrap().unwrap();
            assert_eq!((t.summaries[0].state.as_str(), t.summaries[1].state.as_str()), ("running", "done"));
            assert_eq!(t.summaries[1].text.as_deref(), Some("Short."));
            reply(&s, &threads[0], Some("Long."));
            let t = db::get_task(&s.db(), &task.id).unwrap().unwrap();
            assert_eq!((t.summaries[0].text.as_deref(), t.summaries[1].text.as_deref()), (Some("Long."), Some("Short.")));

            // Both have this commit's summary; asked for, both are written again in the same threads.
            assert!(start(&s, &task.id, false).await.map_err(|e| e.1).unwrap().is_none());
            start(&s, &task.id, true).await.map_err(|e| e.1).unwrap().unwrap();
            assert_eq!(db::summary_threads(&s.db(), &task.id).unwrap().len(), 2);
            crate::agent::runs::TEST_CAN_RUN.set(false);
        })
    }

    #[test]
    fn a_summarizer_added_later_is_written_without_redoing_the_others() {
        crate::testing::run(async || {
            crate::agent::runs::TEST_CAN_RUN.set(true);
            let s = crate::testing::state();
            let task = passed(&s);
            start(&s, &task.id, false).await.map_err(|e| e.1).unwrap().unwrap();
            let first = db::summary_threads(&s.db(), &task.id).unwrap().remove(0);
            reply(&s, &first, Some("First."));
            let skilled = db::Reviewer { skills: vec!["tldr".into()], ..Default::default() };
            db::update_project(&s.db(), "pr", &[("summarizers", json!(json!([db::Reviewer::default(), skilled]).to_string()))]).unwrap();
            start(&s, &task.id, false).await.map_err(|e| e.1).unwrap().expect("the new one starts");
            let t = db::get_task(&s.db(), &task.id).unwrap().unwrap();
            assert_eq!((t.summaries.len(), t.summaries[0].state.as_str(), t.summaries[0].text.as_deref(), t.summaries[1].state.as_str()), (2, "done", Some("First."), "running"));
            // The first's thread wasn't asked again.
            assert_eq!(db::list_messages(&s.db(), &first.id).unwrap().iter().filter(|m| m.kind == "user").count(), 1);
            // Without it, its summary goes.
            let second = both(&s, &task).remove(1);
            reply(&s, &second, Some("Second."));
            db::update_project(&s.db(), "pr", &[("summarizers", json!(json!([skilled]).to_string()))]).unwrap();
            start(&s, &task.id, true).await.map_err(|e| e.1).unwrap().unwrap();
            assert_eq!(db::get_task(&s.db(), &task.id).unwrap().unwrap().summaries.len(), 1);
            crate::agent::runs::TEST_CAN_RUN.set(false);
        })
    }

    #[test]
    fn stopping_or_working_again_stops_every_summary_in_progress() {
        crate::testing::run(async || {
            crate::agent::runs::TEST_CAN_RUN.set(true);
            let s = crate::testing::state();
            let task = passed(&s);
            two_summarizers(&s);
            start(&s, &task.id, false).await.map_err(|e| e.1).unwrap().unwrap();
            let threads = both(&s, &task);
            reply(&s, &threads[0], Some("Done."));
            assert!(stop(&s, &task.id));
            let t = db::get_task(&s.db(), &task.id).unwrap().unwrap();
            // Only the one still being written is stopped.
            assert_eq!((t.summaries[0].state.as_str(), t.summaries[1].state.as_str()), ("done", "stopped"));
            assert!(!stop(&s, &task.id));
            crate::agent::runs::TEST_CAN_RUN.set(false);
        })
    }

    #[test]
    fn a_summary_saved_before_there_could_be_several_is_its_tasks_only_one() {
        let s = crate::testing::state();
        let task = passed(&s);
        let old = json!({"thread_id": "t", "label": "Claude · haiku", "state": "done", "head": "abc", "text": "Old.", "updated_at": "1"});
        s.db().execute("UPDATE tasks SET summary=?2 WHERE id=?1", [&task.id, &old.to_string()]).unwrap();
        let t = db::get_task(&s.db(), &task.id).unwrap().unwrap();
        assert_eq!((t.summaries.len(), t.summary.as_ref().and_then(|x| x.text.as_deref())), (1, Some("Old.")));
        // And a project's one `summarizer` is its only summarizer.
        let haiku = db::Reviewer { model: Some("haiku".into()), ..Default::default() };
        s.db().execute("UPDATE projects SET summarizer=?1, summarizers=NULL WHERE id='pr'", [json!(haiku).to_string()]).unwrap();
        let p = db::get_project(&s.db(), "pr").unwrap().unwrap();
        assert_eq!(db::summarizers_for(&s.db(), &p).unwrap(), vec![haiku]);
    }
}
