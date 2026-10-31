//! Summaries of a task's changes. Once a task's review passes (see review.rs), an agent of the
//! project's choosing (its `summarizer`, or the task's own config) reads the work and writes a
//! summary of what changed for the user to read before merging it. It works read-only in the
//! task's worktree, in a thread of its own: a `review` task of type `summary` whose `parent_id`
//! is the task, so it's run like a reviewer (see runner.rs) but isn't one of its reviewers. Its
//! last message is the summary, kept in the task's `summary` with the commit it describes, which
//! the task's sidebar opens on while the task waits in "In review".
//!
//! A summary in progress is stopped when the task's agent starts working again, and a new one
//! is written when the next review passes.

use serde_json::{Value, json};

use crate::db::{self, ChangeSummary, NewTask, Task};
use crate::runner::Outcome;
use crate::state::{ApiError, ApiResult, Shared};
use crate::util::now;
use crate::worktree;

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
    if !crate::runs::can_run_agents(state) {
        return skip(manual, "this host can't run agents");
    }
    let (Some(dir), Some(branch)) = (task.worktree_path.clone().filter(|_| task.worktree_state == "ready"), task.branch.clone()) else {
        return skip(manual, "the task has no worktree branch to summarise");
    };
    let previous = task.summary.clone();
    if previous.as_ref().is_some_and(|s| s.state == "running") {
        return skip(manual, "a summary is already being written");
    }
    let dir = std::path::PathBuf::from(dir);
    let o = worktree::git(&dir, &["rev-parse", "--verify", "HEAD"]).await.ok().filter(|o| o.ok);
    let head = o.map(|o| o.stdout.trim().to_string()).filter(|h| !h.is_empty()).ok_or_else(|| ApiError::bad("couldn't read the worktree's HEAD commit"))?;
    if !manual && previous.as_ref().is_some_and(|s| s.state == "done" && s.head.as_deref() == Some(head.as_str())) {
        return Ok(None);
    }
    let base = match task.base_branch.clone().or(project.base_branch.clone()).filter(|b| !b.is_empty()) {
        Some(b) => Some(worktree::compare_ref(&dir, &b).await),
        None => None,
    };
    let mut elsewhere = false;
    if let Some(b) = &base {
        let merge_base = worktree::git(&dir, &["merge-base", b, "HEAD"]).await.ok().filter(|o| o.ok).map(|o| o.stdout.trim().to_string());
        elsewhere = merge_base.as_deref() == Some(head.as_str());
    }

    // The summarizer writes in a thread of its own, kept from one summary to the next while
    // its config, model and effort stay the same.
    let spec = project.summarizer.clone().unwrap_or_default();
    let task_config = db::task_claude_config(&state.db(), &task)?;
    let config = match spec.claude_config_id.as_deref() {
        // A summarizer whose config was deleted writes with the task's.
        Some(id) => db::get_claude_config(&state.db(), id)?.or_else(|| task_config.clone()),
        None => task_config.clone(),
    };
    let config_id = config.as_ref().map(|c| c.id.clone());
    let model = spec.model.clone().filter(|m| !m.trim().is_empty());
    let effort = spec.effort.clone().filter(|e| !e.trim().is_empty());
    let label = crate::review::label(config.as_ref(), model.as_deref(), effort.as_deref());
    let key = format!("{}-{}", project.key, task.number);
    let threads = db::summary_threads(&state.db(), &task.id)?;
    let thread = match threads.into_iter().find(|t| t.claude_config_id == config_id && t.model == model && t.effort == effort) {
        Some(t) => t,
        None => {
            let t = db::insert_task(
                &state.db(),
                NewTask {
                    profile_id: &task.profile_id,
                    project_id: Some(&project.id),
                    kind: "review",
                    title: &format!("Summary of {key}"),
                    description: "",
                    status: "todo",
                    use_worktree: false,
                    model: model.as_deref(),
                    effort: effort.as_deref(),
                    claude_config_id: config_id.as_deref(),
                },
            )?;
            let fields = [("parent_id", json!(task.id)), ("task_type", json!(SUMMARY))];
            state.update_task(&t.id, &fields)?.ok_or_else(|| ApiError::not_found("summary thread"))?
        }
    };
    if state.is_running(&thread.id) {
        return Err(ApiError::conflict(format!("the summary thread's agent ({label}) is busy; wait for it to finish or stop it")));
    }
    let after_run = Some(db::latest_run(&state.db(), &thread.id, None)?.unwrap_or_default());
    let summary = ChangeSummary {
        thread_id: thread.id.clone(),
        label,
        state: "running".into(),
        head: Some(head.clone()),
        text: None,
        after_run,
        updated_at: now(),
    };
    let commit = &head[..head.len().min(10)];
    let last_message = if elsewhere { db::last_assistant_text(&state.db(), &task.id)? } else { None };
    let text = prompt(&key, &task, &branch, base.as_deref(), commit, elsewhere, last_message.as_deref());
    // A fresh conversation for each summary; the thread keeps every one's messages.
    state.update_task(&thread.id, &[("session_id", Value::Null)])?;
    crate::context::clear(state, &thread.id)?;
    let sent = {
        let _g = updating();
        // The agent may have started again meanwhile (and `supersede` found nothing to stop).
        let later = db::later_run(&state.db(), &task.id, last_run.as_deref().unwrap_or_default())?;
        if later || state.is_running(&task.id) {
            return skip(manual, "the agent is working again");
        }
        set_summary(state, &task.id, Some(&summary))?;
        state.add_event(&thread.id, "info", format!("Summarising commit {commit}"), None);
        crate::runner::send_review(state, &thread.id, &text)
    };
    if let Err(e) = sent {
        let _g = updating();
        let failed = ChangeSummary { state: "failed".into(), text: Some(format!("Couldn't start the summary: {}", e.1)), updated_at: now(), ..summary };
        set_summary(state, &task.id, Some(&failed))?;
        return Err(e);
    }
    state.add_event(&task.id, "info", format!("Summarising the changes (commit {commit})"), None);
    Ok(db::get_task(&state.db(), &task.id)?)
}

/// How much of the agent's last message goes in the prompt.
const LAST_MESSAGE_CHARS: usize = 6000;

/// Where the work is (on the branch, or `elsewhere` when the branch has no commits of its own and
/// the agent's `last_message` says where), and how to write the summary.
fn prompt(key: &str, task: &Task, branch: &str, base: Option<&str>, commit: &str, elsewhere: bool, last_message: Option<&str>) -> String {
    let mut p = format!("Summarise the changes made for task {key}: \"{}\".\n", task.title);
    if !task.description.trim().is_empty() {
        p.push_str(&format!("\nThe task's description:\n\n{}\n", task.description.trim()));
    }
    if !elsewhere {
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
    p.push_str(
        "\nThe user reads your summary before they merge the work, to see what it does without reading the whole diff. Write \
         it in Markdown, briefly: start with a sentence or two on what changed and why, then the main changes (grouped by \
         area, naming the files or modules where it helps), any decisions or behaviour changes worth knowing about, and \
         how to try it if that isn't obvious. Leave out what the diff makes plain at a glance, and don't review the work or \
         pad it out. Don't change anything. Your last message is the summary, shown as it is on the task: end your turn \
         with only the summary, without a preamble.",
    );
    p
}

fn set_summary(state: &Shared, task_id: &str, summary: Option<&ChangeSummary>) -> anyhow::Result<()> {
    state.update_task(task_id, &[("summary", json!(summary))])?;
    Ok(())
}

/// The task's summary, if `thread_id`'s is in progress.
fn in_progress(state: &Shared, task_id: &str, thread_id: &str) -> Option<ChangeSummary> {
    let task = db::get_task(&state.db(), task_id).ok().flatten()?;
    task.summary.filter(|s| s.state == "running" && s.thread_id == thread_id)
}

/// The summary thread's run `run_id` ended: its last message is the summary.
pub fn finished(state: &Shared, thread: &Task, run_id: &str, outcome: &Outcome, attention: Option<&str>) {
    let Some(parent_id) = thread.parent_id.as_deref() else { return };
    let _g = updating();
    let Some(mut summary) = in_progress(state, parent_id, &thread.id) else { return };
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
    if let Err(e) = set_summary(state, parent_id, Some(&summary)) {
        tracing::error!("failed to record a summary: {e:#}");
        return;
    }
    match st {
        "done" => state.add_event(parent_id, "info", "Changes summarised", None),
        "stopped" => {}
        _ => state.add_event(parent_id, "warn", "Couldn't summarise the changes", summary.text.clone()),
    }
}

/// The task's agent started working again: the summary in progress is out of date.
pub fn supersede(state: &Shared, task: &Task) {
    stop_summary(state, &task.id, "Stopped because the agent started working on the task again.");
}

/// The user stopped the task: stop its summary too, if one is being written. Returns whether one was.
pub fn stop(state: &Shared, task_id: &str) -> bool {
    stop_summary(state, task_id, "Stopped by the user.")
}

fn stop_summary(state: &Shared, task_id: &str, why: &str) -> bool {
    let thread = {
        let _g = updating();
        let current = db::get_task(&state.db(), task_id).ok().flatten().and_then(|t| t.summary);
        let Some(mut summary) = current.filter(|s| s.state == "running") else { return false };
        summary.state = "stopped".into();
        summary.text = Some(why.into());
        summary.updated_at = now();
        if let Err(e) = set_summary(state, task_id, Some(&summary)) {
            tracing::warn!("failed to update a summary: {e:#}");
        }
        summary.thread_id
    };
    crate::runner::stop(state, &thread);
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
        let text = prompt("X-1", &task, "ia/x-1", Some("master"), "abc", false, None);
        for want in ["task X-1: \"Fix it\"", "`pr_view` tool (pr `ia/x-1`)", "`git diff master...HEAD`", "> Looks good.", "end your turn with only the summary"] {
            assert!(text.contains(want), "{want:?} not in {text}");
        }
        let text = prompt("X-1", &task, "ia/x-1", Some("master"), "abc", true, Some("Done in o/deploy#4."));
        assert!(text.contains("no commits of its own") && text.contains("> Done in o/deploy#4."), "{text}");
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
        crate::runner::on_exit(s, &run, Some(0), None, None, "");
    }

    #[test]
    fn a_passed_review_is_summarised_by_the_projects_summarizer() {
        crate::testing::run(async || {
            crate::runs::TEST_CAN_RUN.set(true);
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
            assert!(crate::worktree::agent_in_worktree(&s, &task.id));
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
            crate::runs::TEST_CAN_RUN.set(false);
        })
    }

    #[test]
    fn only_a_passed_review_in_a_project_that_summarises_is_summarised() {
        crate::testing::run(async || {
            crate::runs::TEST_CAN_RUN.set(true);
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
            crate::runs::TEST_CAN_RUN.set(false);
        })
    }

    #[test]
    fn the_agent_working_again_stops_the_summary() {
        crate::testing::run(async || {
            crate::runs::TEST_CAN_RUN.set(true);
            let s = crate::testing::state();
            let task = passed(&s);
            start(&s, &task.id, false).await.map_err(|e| e.1).unwrap().unwrap();
            let thread = db::summary_threads(&s.db(), &task.id).unwrap().remove(0);
            crate::runner::send(&s, &task.id, "one more thing").unwrap();
            let sum = summary_of(&s, &task).unwrap();
            assert_eq!(sum.state, "stopped");
            // Its run ending afterwards doesn't change that.
            reply(&s, &thread, Some("A summary."));
            assert_eq!(summary_of(&s, &task).unwrap().state, "stopped");
            crate::runs::TEST_CAN_RUN.set(false);
        })
    }

    #[test]
    fn a_review_doesnt_take_the_summary_thread_for_a_reviewers() {
        crate::testing::run(async || {
            crate::runs::TEST_CAN_RUN.set(true);
            let s = crate::testing::state();
            let task = passed(&s);
            start(&s, &task.id, false).await.map_err(|e| e.1).unwrap().unwrap();
            let thread = db::summary_threads(&s.db(), &task.id).unwrap().remove(0);
            reply(&s, &thread, Some("A summary."));
            crate::review::start(&s, &task.id, true).await.map_err(|e| e.1).unwrap().unwrap();
            let review = db::get_task(&s.db(), &task.id).unwrap().unwrap().review.unwrap();
            assert_ne!(review.reviewers[0].thread_id, thread.id);
            crate::runs::TEST_CAN_RUN.set(false);
        })
    }
}
