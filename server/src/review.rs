//! Automatic code review. When a task moves to "In review" (usually because its agent
//! finished), each of the project's reviewers reviews the branch's pull request in the task's
//! worktree, in a review thread of its own (a `review` task whose `parent_id` is the task). The
//! task's `review` holds the latest review's state, each reviewer's part and their combined
//! outcome, which the board shows on the card. Once every reviewer has finished, the serious
//! issues they reported with `submit_review` go back to the task's agent to fix; when it
//! finishes, the new commit is reviewed again. After the project's `review_rounds` rounds of
//! that in a row, the task is left for the user. Only code changes are reviewed automatically:
//! a task whose branch has no commits of its own is skipped unless its agent changed code
//! somewhere else (see `changed_elsewhere`).
//!
//! The task stays in "In review" while it's reviewed, and only goes back to "In progress" when
//! its agent works on it again (to fix the issues found, or because it was sent a message).

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::db::{self, ClaudeConfig, NewTask, Review, Reviewer, ReviewerRun, Task};
use crate::runner::{self, Outcome};
use crate::state::{ApiError, ApiResult, Shared};
use crate::util::now;
use crate::worktree;

/// Read-only tools a reviewer may use without asking.
pub const ALLOWED_TOOLS: &[&str] = &[
    "Read",
    "Grep",
    "Glob",
    "Skill",
    "Agent",
    "Task",
    "Bash(git diff:*)",
    "Bash(git log:*)",
    "Bash(git show:*)",
    "Bash(git status:*)",
    "Bash(git merge-base:*)",
    "Bash(git rev-parse:*)",
    "Bash(gh pr view:*)",
    "Bash(gh pr diff:*)",
    "Bash(gh pr list:*)",
    "Bash(gh pr checks:*)",
];

/// Tools a reviewer never gets.
pub const DISALLOWED_TOOLS: &[&str] = &["Edit", "Write", "NotebookEdit"];

/// Held while starting a review, so two can't start on one task at once.
static STARTING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Held while changing a review in progress, so reviewers finishing together don't overwrite
/// each other's part, and while a reviewer starts (see `start`). Never held while stopping an
/// agent or while a run ends, which can end up back here.
static UPDATING: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn updating() -> std::sync::MutexGuard<'static, ()> {
    UPDATING.lock().unwrap_or_else(|e| e.into_inner())
}

/// Most reviewers a project can have.
pub const MAX_REVIEWERS: usize = 6;

/// A task moved to "In review": review its work in the background, if its project wants that
/// and this commit hasn't been reviewed yet.
pub fn on_in_review(state: &Shared, task: &Task) {
    let state = state.clone();
    let id = task.id.clone();
    tokio::spawn(async move {
        if let Err(e) = start(&state, &id, false).await {
            tracing::warn!(task = %id, "couldn't start a review: {}", e.1);
            state.add_event(&id, "warn", "Couldn't start the review", Some(e.1));
        }
    });
}

/// Review a task's work. `manual` (the user asked for it) reviews even when the project doesn't
/// review automatically or the commit was already reviewed, and says why when it can't.
/// Returns the task, or None when there was nothing to do.
pub async fn start(state: &Shared, task_id: &str, manual: bool) -> ApiResult<Option<Task>> {
    let _starting = STARTING.lock().await;
    let task = db::get_task(&state.db(), task_id)?.ok_or_else(|| ApiError::not_found("task"))?;
    let project = match (&task.project_id, task.kind.as_str()) {
        (Some(pid), "task") => db::get_project(&state.db(), pid)?,
        _ => None,
    };
    let Some(project) = project else { return skip(manual, "only tasks in a project can be reviewed") };
    // What's read of the work below is what this run left, unless another starts meanwhile:
    // read before the check that none is running, so one that starts in between counts as later.
    let last_run = db::latest_run(&state.db(), &task.id, None)?;
    #[cfg(test)]
    crate::testing::reached("review:last-run");
    if state.is_running(&task.id) {
        // A task its agent moved to "In review" mid-run is reviewed when the run ends.
        return skip(manual, "the agent is still working; its changes are reviewed when it finishes");
    }
    if !manual && !project.auto_review {
        return Ok(None);
    }
    if !crate::runs::can_run_agents(state) {
        return skip(manual, "this host can't run agents");
    }
    let (Some(dir), Some(branch)) = (task.worktree_path.clone().filter(|_| task.worktree_state == "ready"), task.branch.clone()) else {
        return skip(manual, "the task has no worktree branch to review");
    };
    let previous = task.review.clone();
    if previous.as_ref().is_some_and(|r| r.state == "running") {
        return skip(manual, "a review is already running");
    }
    let dir = PathBuf::from(dir);
    let head = rev_parse(&dir, "HEAD").await.ok_or_else(|| ApiError::bad("couldn't read the worktree's HEAD commit"))?;
    // What the branch is compared with: it may have started from the base branch's upstream.
    let base = match task.base_branch.clone().or(project.base_branch.clone()).filter(|b| !b.is_empty()) {
        Some(b) => Some(worktree::compare_ref(&dir, &b).await),
        None => None,
    };
    // Started from a commit its base branch doesn't have: its work is what's after that commit.
    let base = match (&task.start_from, base) {
        (Some(db::StartFrom::Commit { .. }), Some(b)) => worktree::changes_base(&dir, &task, &project).await.1.or(Some(b)),
        (_, b) => b,
    };
    let mut elsewhere = false;
    if let Some(b) = &base {
        let merge_base = worktree::git(&dir, &["merge-base", b, "HEAD"]).await.ok().filter(|o| o.ok).map(|o| o.stdout.trim().to_string());
        // The agent may have made its changes somewhere else, such as in another repository.
        elsewhere = merge_base.as_deref() == Some(head.as_str());
    }
    // Without commits of its own, the head doesn't change when the agent fixes the issues found
    // elsewhere, so it's reviewed again after a round of fixes (review_rounds still caps those).
    let done = if elsewhere { &["passed"][..] } else { &["passed", "issues"][..] };
    let reviewed = previous.as_ref().is_some_and(|r| r.head.as_deref() == Some(head.as_str()) && done.contains(&r.state.as_str()));
    if reviewed && !manual {
        return Ok(None);
    }
    if elsewhere && !manual && !changed_elsewhere(state, &task, &dir, previous.as_ref()).await? {
        state.add_event(
            &task.id,
            "info",
            "Not reviewed: no code changes",
            Some("The branch has no commits of its own, and the agent didn't edit files, commit, push or open a pull request. Use Review now to review it anyway.".into()),
        );
        return Ok(None);
    }

    // Each reviewer reviews in its own thread, kept from one review to the next.
    let specs = if project.reviewers.is_empty() { vec![Reviewer::default()] } else { project.reviewers.clone() };
    let task_config = db::task_claude_config(&state.db(), &task)?;
    let mut threads = db::review_threads(&state.db(), &task.id)?;
    let key = format!("{}-{}", project.key, task.number);
    let mut parts: Vec<ReviewerRun> = Vec::new();
    for spec in &specs {
        let config = match spec.claude_config_id.as_deref() {
            // A reviewer whose config was deleted reviews with the task's.
            Some(id) => db::get_claude_config(&state.db(), id)?.or_else(|| task_config.clone()),
            None => task_config.clone(),
        };
        let config_id = config.as_ref().map(|c| c.id.clone());
        let model = spec.model.clone().filter(|m| !m.trim().is_empty());
        let effort = spec.effort.clone().filter(|e| !e.trim().is_empty());
        let label = label(config.as_ref(), model.as_deref(), effort.as_deref());
        let found = threads.iter().position(|t| t.claude_config_id == config_id && t.model == model && t.effort == effort);
        let thread = match found {
            Some(i) => threads.remove(i),
            None => {
                let title = if specs.len() > 1 { format!("Review of {key} ({label})") } else { format!("Review of {key}") };
                let t = db::insert_task(
                    &state.db(),
                    NewTask {
                        profile_id: &task.profile_id,
                        project_id: Some(&project.id),
                        kind: "review",
                        title: &title,
                        description: "",
                        status: "todo",
                        use_worktree: false,
                        model: model.as_deref(),
                        effort: effort.as_deref(),
                        claude_config_id: config_id.as_deref(),
                    },
                )?;
                state.update_task(&t.id, &[("parent_id", json!(task.id))])?.ok_or_else(|| ApiError::not_found("review thread"))?
            }
        };
        if state.is_running(&thread.id) {
            return Err(ApiError::conflict(format!("the review thread's agent ({label}) is busy; wait for it to finish or stop it")));
        }
        let after_run = Some(db::latest_run(&state.db(), &thread.id, None)?.unwrap_or_default());
        parts.push(ReviewerRun { thread_id: thread.id, label, state: "running".into(), after_run, ..Default::default() });
    }

    // Issues the agent was asked to fix are checked again; a review the user asked for starts
    // a fresh round of fixes.
    let fixed = previous.as_ref().filter(|r| r.state == "issues").map(|r| r.issues.clone()).unwrap_or_default();
    let review = Review {
        thread_id: parts[0].thread_id.clone(),
        state: "running".into(),
        head: Some(head.clone()),
        summary: None,
        issues: Vec::new(),
        verdict: None,
        fixes: if manual { 0 } else { previous.map(|r| r.fixes).unwrap_or(0) },
        updated_at: now(),
        reviewers: parts.clone(),
    };
    #[cfg(test)]
    crate::testing::reached("review:recording");
    {
        let _g = updating();
        // The agent may have started again while git was read: `supersede` found no review to
        // stop then, so this one would review work that's changing, or has changed since it was
        // read if that run has ended too. Once this is recorded, a run that starts has it to stop.
        let later = db::later_run(&state.db(), &task.id, last_run.as_deref().unwrap_or_default())?;
        if later || state.is_running(&task.id) {
            return skip(manual, "the agent is working again; its changes are reviewed when it finishes");
        }
        set_review(state, &task.id, &review)?;
    }
    let commit = &head[..head.len().min(10)];
    let work = if elsewhere { Work::Elsewhere { last_message: db::last_assistant_text(&state.db(), &task.id)? } } else { Work::Branch };
    let replies = db::user_replies(&state.db(), &task.id, Some(REPLIES))?;
    let text = prompt(&key, &task, &branch, base.as_deref(), commit, &work, &fixed, &replies, crate::prompts::review(Some(&project)));
    let (mut started, mut failed) = (0, None);
    for part in &parts {
        // Each review starts from a clean slate; the thread keeps every round's messages.
        state.update_task(&part.thread_id, &[("session_id", Value::Null)])?;
        crate::context::clear(state, &part.thread_id)?;
        let sent = {
            // Under the lock `supersede` stops the review with: a reviewer of a review it has
            // stopped doesn't start, and one that starts first is stopped with it.
            let _g = updating();
            if in_progress(state, &task.id, &part.thread_id).is_none() {
                return Ok(db::get_task(&state.db(), &task.id)?);
            }
            state.add_event(&part.thread_id, "info", format!("Reviewing commit {commit}"), None);
            runner::send_review(state, &part.thread_id, &text)
        };
        #[cfg(test)]
        crate::testing::reached("review:reviewer-started");
        match sent {
            Ok(_) => started += 1,
            Err(e) => {
                let why = format!("Couldn't start the review: {}", e.1);
                let ended = end_part(state, &task.id, &part.thread_id, None, |p| {
                    p.state = "failed".into();
                    p.summary = Some(why);
                });
                if let Some((parent, review)) = ended.filter(|_| started > 0) {
                    // The others have already finished.
                    act(state, parent, review);
                }
                failed.get_or_insert(e);
            }
        }
    }
    if let Some(e) = failed.filter(|_| started == 0) {
        return Err(e);
    }
    let who = if parts.len() > 1 { format!(" with {} reviewers", parts.len()) } else { String::new() };
    state.add_event(&task.id, "info", format!("Reviewing the changes (commit {commit}){who}"), None);
    if ["in_progress", "needs_attention"].contains(&task.status.as_str()) && !task.merging {
        // A task under review sits in "In review" (e.g. one reviewed again from "Needs attention"
        // after its rounds of fixes), so the issues found can go back to its agent. Unless its
        // agent has started again since (stopping the review): its column is that run's.
        let fields = [("status", json!("in_review")), ("attention_reason", Value::Null)];
        state.update_task_if(&task.id, &fields, |c| Ok(!db::later_run(c, &task.id, last_run.as_deref().unwrap_or_default())?))?;
    }
    Ok(db::get_task(&state.db(), &task.id)?)
}

/// How a reviewer reads on the board: its config, model and effort.
fn label(config: Option<&ClaudeConfig>, model: Option<&str>, effort: Option<&str>) -> String {
    let name = config.map(|c| c.name.clone()).unwrap_or_else(|| "Claude".into());
    [Some(name.as_str()), model, effort].into_iter().flatten().collect::<Vec<_>>().join(" · ")
}

fn skip<T>(manual: bool, why: &str) -> ApiResult<Option<T>> {
    if manual { Err(ApiError::conflict(format!("Can't review: {why}"))) } else { Ok(None) }
}

async fn rev_parse(dir: &Path, rev: &str) -> Option<String> {
    let o = worktree::git(dir, &["rev-parse", "--verify", rev]).await.ok()?;
    o.ok.then(|| o.stdout.trim().to_string()).filter(|s| !s.is_empty())
}

/// Whether the agent of a task whose branch has no commits of its own changed code anywhere since
/// its last finished review (`previous`), so there's something to review: it edited files,
/// committed, pushed, opened a pull request or wrote files from the shell (see
/// `changes::changes_code`). Uncommitted changes in the worktree count too, and before the
/// first review, a pull request on the task.
async fn changed_elsewhere(state: &Shared, task: &Task, dir: &Path, previous: Option<&Review>) -> ApiResult<bool> {
    let since = previous.filter(|r| ["passed", "issues"].contains(&r.state.as_str())).map(|r| r.updated_at.clone());
    if db::tool_calls_since(&state.db(), &task.id, since.as_deref())?.iter().any(|(call, result)| crate::changes::changes_code(call, result.as_ref())) {
        return Ok(true);
    }
    if since.is_none() && task.pr_url.as_deref().is_some_and(|u| !u.trim().is_empty()) {
        return Ok(true);
    }
    let status = worktree::git(dir, &["status", "--porcelain"]).await.ok().filter(|o| o.ok);
    Ok(status.is_some_and(|o| !o.stdout.trim().is_empty()))
}

/// Where the work to review is.
enum Work {
    /// On the task's branch.
    Branch,
    /// The branch has no commits: the agent's changes, if any, are somewhere else (such as in
    /// another repository), which its last message should say.
    Elsewhere { last_message: Option<String> },
}

/// How much of the agent's last message goes in the prompt.
const LAST_MESSAGE_CHARS: usize = 6000;

/// How much of each message the user sent the task's agent goes in the prompt, of what the agent
/// said before it (its end, where a question usually is), and of all of them (the latest).
const REPLY_CHARS: usize = 2000;
const REPLY_CONTEXT_CHARS: usize = 1500;
const REPLIES_CHARS: usize = 12000;
/// How many of the user's latest messages are read for the prompt, at most (fewer fit when they're long).
const REPLIES: usize = 100;

/// `instructions` (the project's, or the default) say what to look for; the rest locates the
/// work, says what the user decided in the task's thread (`replies`, see `db::user_replies`) and
/// how to report the verdict.
#[allow(clippy::too_many_arguments)]
fn prompt(
    key: &str,
    task: &Task,
    branch: &str,
    base: Option<&str>,
    commit: &str,
    work: &Work,
    fixed: &[String],
    replies: &db::UserReplies,
    instructions: &str,
) -> String {
    let mut p = format!("Review the work on task {key}: \"{}\".\n", task.title);
    if !task.description.trim().is_empty() {
        p.push_str(&format!("\nThe task's description:\n\n{}\n", task.description.trim()));
    }
    match work {
        Work::Branch => {
            let fallback = match base {
                Some(b) => format!("the branch's changes (`git diff {b}...HEAD`)"),
                None => "the branch's commits".into(),
            };
            p.push_str(&format!(
                "\nThe work is on branch `{branch}` (commit {commit}), checked out in your working directory. Find its pull \
                 request with the gh MCP server's `pr_view` tool (pr `{branch}`) and review the pull request's changes \
                 (`pr_diff`). If it has no pull request, review {fallback} instead.\n"
            ));
        }
        Work::Elsewhere { last_message } => {
            p.push_str(&format!(
                "\nThe task's branch `{branch}`, checked out in your working directory, has no commits of its own (it's still at \
                 commit {commit}, where it started), so the agent made its changes somewhere else, such as in another \
                 repository, or made none. Find its changes from what it says it did"
            ));
            if let Some(url) = task.pr_url.as_deref().filter(|u| !u.is_empty()) {
                p.push_str(&format!(" and from the task's pull request, {url}"));
            }
            p.push_str(
                ", and review them: for a pull request in another repository, the gh MCP server's `pr_view` \
                 and `pr_diff` tools with its URL; for commits in another checkout, read its files and git history \
                 there. If the agent didn't change anything that needs reviewing, the verdict is `pass` and the summary says so.\n",
            );
            match last_message.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
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
    }
    p.push_str(&user_said(&replies.replies, replies.earlier > 0));
    p.push_str(&format!(
        "\n{instructions}\n\n\
         When you're done, call `submit_review` once. If anything must be fixed before merging (for example, a bug you confirmed), the \
         verdict is `needs_fixes` and each such problem goes in `serious_issues`, with where it is, what goes wrong and how \
         to fix it: they are sent to the task's agent to fix. Otherwise the verdict is `pass`. Put minor issues and \
         suggestions in the summary."
    ));
    if !fixed.is_empty() {
        p.push_str("\n\nThe previous review found these serious issues, and the agent was asked to fix them. Check that they're fixed:\n");
        for i in fixed {
            p.push_str(&format!("\n- {i}"));
        }
    }
    p
}

/// The prompt's part on what the user told the task's agent, so reviewers don't raise again what
/// they've decided. The latest messages, up to `REPLIES_CHARS`, after `earlier` ones left out if set.
fn user_said(replies: &[(Option<String>, String)], earlier: bool) -> String {
    let quote = |s: &str| s.lines().map(|l| format!("> {l}")).collect::<Vec<_>>().join("\n");
    let (mut parts, mut len, mut cut) = (Vec::new(), 0, earlier);
    for (said, text) in replies.iter().rev() {
        let mut part = String::new();
        if let Some(said) = said.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            part.push_str(&format!("The agent:\n\n{}\n\n", quote(&clip(said, REPLY_CONTEXT_CHARS, true))));
        }
        part.push_str(&format!("The user:\n\n{}\n", quote(&clip(text, REPLY_CHARS, false))));
        len += part.len();
        if len > REPLIES_CHARS && !parts.is_empty() {
            cut = true;
            break;
        }
        parts.push(part);
    }
    if parts.is_empty() {
        return String::new();
    }
    if cut {
        parts.push("[Earlier messages left out.]\n".to_string());
    }
    parts.reverse();
    format!(
        "\nWhat the user told the task's agent in its thread, after what the agent said before each message. The \
         decisions they made there stand, such as limitations they accepted and options they turned down: don't raise \
         those again as serious issues, unless you find something about them the user didn't know.\n\n{}",
        parts.join("\n")
    )
}

/// `s`'s first `n` characters, or its last with `end`, marked where it was cut.
fn clip(s: &str, n: usize, end: bool) -> String {
    let count = s.chars().count();
    if count <= n {
        return s.to_string();
    }
    if end {
        format!("[...] {}", s.chars().skip(count - n).collect::<String>())
    } else {
        format!("{} [...]", s.chars().take(n).collect::<String>())
    }
}

fn set_review(state: &Shared, task_id: &str, review: &Review) -> anyhow::Result<()> {
    state.update_task(task_id, &[("review", json!(review))])?;
    Ok(())
}

/// A task's review with each reviewer's part: one from before there could be several has just
/// its one, from its own fields.
fn with_parts(mut r: Review) -> Review {
    if r.reviewers.is_empty() && !r.thread_id.is_empty() {
        r.reviewers.push(ReviewerRun {
            thread_id: r.thread_id.clone(),
            label: String::new(),
            state: r.state.clone(),
            summary: r.summary.clone(),
            issues: r.issues.clone(),
            verdict: r.verdict.take(),
            after_run: None,
        });
    }
    r
}

/// The task a review thread reviews, with its review if the thread's part in it is in progress.
fn in_progress(state: &Shared, parent_id: &str, thread_id: &str) -> Option<(Task, Review)> {
    let parent = db::get_task(&state.db(), parent_id).ok().flatten()?;
    let review = parent.review.clone().filter(|r| r.state == "running").map(with_parts)?;
    review.reviewers.iter().any(|p| p.thread_id == thread_id && p.state == "running").then_some((parent, review))
}

/// Combine the reviewers' parts once none is running: the issues they all found (each with who
/// found it, when there are several), and issues if there are any, passed if they all passed,
/// else failed (or stopped if they all were).
fn combine(r: &mut Review) {
    if r.reviewers.iter().any(|p| p.state == "running") {
        r.state = "running".into();
        return;
    }
    let several = r.reviewers.len() > 1;
    r.issues = r.reviewers.iter().flat_map(|p| p.issues.iter().map(move |i| if several { format!("({}) {i}", p.label) } else { i.clone() })).collect();
    let all = |st: &str| r.reviewers.iter().all(|p| p.state == st);
    r.state = if !r.issues.is_empty() {
        "issues"
    } else if all("passed") {
        "passed"
    } else if all("stopped") {
        "stopped"
    } else {
        "failed"
    }
    .into();
    r.summary = match r.reviewers.as_slice() {
        [one] => one.summary.clone(),
        parts => {
            let each: Vec<String> = parts.iter().filter_map(|p| p.summary.as_ref().map(|s| format!("**{}:** {s}", p.label))).collect();
            (!each.is_empty()).then(|| each.join("\n\n"))
        }
    };
    r.verdict = None;
    if r.state == "passed" {
        r.fixes = 0;
    }
}

/// Whether run `run_id` of the part's thread is its reviewer (see ReviewerRun::after_run).
fn reviewed_by(state: &Shared, part: &ReviewerRun, run_id: &str) -> bool {
    let after = part.after_run.as_deref();
    after.is_none_or(|after| db::run_after(&state.db(), &part.thread_id, run_id, after).unwrap_or(false))
}

/// End a reviewer's part of the review in progress with `end`: the part of run `run_id`, if
/// given, else the thread's. Returns the review once that was the last part to finish,
/// combined, for the caller to act on.
fn end_part(state: &Shared, parent_id: &str, thread_id: &str, run_id: Option<&str>, end: impl FnOnce(&mut ReviewerRun)) -> Option<(Task, Review)> {
    let _g = updating();
    let (parent, mut review) = in_progress(state, parent_id, thread_id)?;
    let part = review.reviewers.iter_mut().find(|p| p.thread_id == thread_id)?;
    if run_id.is_some_and(|r| !reviewed_by(state, part, r)) {
        return None;
    }
    end(part);
    part.verdict = None;
    if part.state != "issues" {
        part.issues.clear();
    }
    combine(&mut review);
    review.updated_at = now();
    if let Err(e) = set_review(state, &parent.id, &review) {
        tracing::error!("failed to record a review: {e:#}");
        return None;
    }
    (review.state != "running").then_some((parent, review))
}

/// `submit_review` from a reviewer: record its verdict, acted on when its run ends.
pub fn submit(state: &Shared, thread: &Task, run_id: &str, args: &Value) -> ApiResult<Value> {
    if thread.kind != "review" {
        return Err(ApiError::bad("submit_review is only for review threads"));
    }
    let _g = updating();
    let found = thread.parent_id.as_deref().and_then(|p| in_progress(state, p, &thread.id));
    let (parent, mut review) = found.ok_or_else(|| ApiError::conflict("no review is in progress, so there's nothing to submit"))?;
    let part = review.reviewers.iter_mut().find(|p| p.thread_id == thread.id).ok_or_else(|| ApiError::conflict("no review is in progress"))?;
    // From a run of an earlier round (a call retried late, say): this round isn't its.
    if !reviewed_by(state, part, run_id) {
        return Err(ApiError::conflict("the review this run was asked for has ended, so there's nothing to submit"));
    }
    let mut issues: Vec<String> = match &args["serious_issues"] {
        Value::Array(a) => a.iter().filter_map(|i| i.as_str()).map(str::trim).filter(|i| !i.is_empty()).map(String::from).collect(),
        Value::String(s) if !s.trim().is_empty() => vec![s.trim().to_string()],
        _ => Vec::new(),
    };
    part.summary = args["summary"].as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    // A reviewer that wants fixes but didn't list them separately described them in its summary.
    if args["verdict"] == "needs_fixes" && issues.is_empty() {
        issues.push(part.summary.clone().unwrap_or_else(|| "The reviewer asked for fixes without saying what they are; see the review thread.".into()));
    }
    part.verdict = Some(if issues.is_empty() { "pass" } else { "issues" }.into());
    part.issues = issues;
    review.updated_at = now();
    set_review(state, &parent.id, &review)?;
    Ok(json!({"ok": true, "note": "Recorded. End your turn now with a short summary of the review."}))
}

/// The task's agent started working again: the review in progress is out of date. The task is
/// reviewed again when the agent finishes.
pub fn supersede(state: &Shared, task: &Task) {
    stop_review(state, &task.id, "Stopped because the agent started working on the task again.");
}

/// The user stopped the task: stop its review too, if one is in progress. Returns whether one was.
pub fn stop(state: &Shared, task_id: &str) -> bool {
    let stopped = stop_review(state, task_id, "Stopped by the user.");
    if stopped {
        state.add_event(task_id, "warn", "Review stopped", None);
    }
    stopped
}

/// Stop the task's review in progress, if there is one, saying `why`. Returns whether there was.
fn stop_review(state: &Shared, task_id: &str, why: &str) -> bool {
    let running: Vec<String> = {
        let _g = updating();
        let current = db::get_task(&state.db(), task_id).ok().flatten().and_then(|t| t.review);
        let Some(mut review) = current.filter(|r| r.state == "running").map(with_parts) else { return false };
        let running = review.reviewers.iter().filter(|p| p.state == "running").map(|p| p.thread_id.clone()).collect();
        for p in review.reviewers.iter_mut().filter(|p| p.state == "running") {
            p.state = "stopped".into();
            p.verdict = None;
            p.summary = Some(why.into());
        }
        review.state = "stopped".into();
        review.verdict = None;
        review.issues.clear();
        review.summary = Some(why.into());
        review.updated_at = now();
        if let Err(e) = set_review(state, task_id, &review) {
            tracing::warn!("failed to update a review: {e:#}");
        }
        running
    };
    for id in running {
        runner::stop(state, &id);
    }
    true
}

/// Reviewer run `run_id` ended: record its part of the review. Once they've all finished, record the
/// outcome on the task, and send serious issues to its agent.
pub fn finished(state: &Shared, thread: &Task, run_id: &str, outcome: &Outcome, attention: Option<&str>) {
    let Some(parent_id) = thread.parent_id.as_deref() else { return };
    let ended = end_part(state, parent_id, &thread.id, Some(run_id), |part| {
        let (st, summary) = match (outcome, part.verdict.as_deref()) {
            (Outcome::Cancelled, _) => ("stopped", Some("The review was stopped.".to_string())),
            (Outcome::Failed(e), _) => ("failed", Some(format!("The review failed: {}", e.lines().next().unwrap_or("")))),
            (Outcome::Ok, _) if attention.is_some() => ("failed", attention.map(|q| format!("The reviewer asked: {q}"))),
            (Outcome::Ok, None) => ("failed", Some("The reviewer finished without submitting a verdict.".to_string())),
            (Outcome::Ok, Some("pass")) => ("passed", part.summary.take()),
            (Outcome::Ok, Some(_)) => ("issues", part.summary.take()),
        };
        part.state = st.into();
        part.summary = summary;
    });
    if let Some((parent, review)) = ended {
        act(state, parent, review);
    }
}

/// Every reviewer has finished: act on their combined review.
fn act(state: &Shared, parent: Task, review: Review) {
    let save = |r: &Review| {
        let _g = updating();
        if let Err(e) = set_review(state, &parent.id, r) {
            tracing::error!("failed to record a review: {e:#}");
        }
    };
    match review.state.as_str() {
        "passed" => state.add_event(&parent.id, "info", "Review passed", review.summary.clone()),
        "issues" => {
            let rounds = parent.project_id.as_deref().and_then(|p| db::get_project(&state.db(), p).ok().flatten()).map(|p| p.review_rounds);
            send_issues(state, &parent, review, rounds.unwrap_or(0), save)
        }
        _ => state.add_event(&parent.id, "warn", "Review didn't finish", review.summary.clone()),
    }
}

/// Ask the task's agent to fix what the review found, if it's still waiting in "In review"
/// and hasn't had its `rounds` of fixes already. Otherwise it's flagged for the user.
fn send_issues(state: &Shared, task: &Task, mut review: Review, rounds: u32, save: impl Fn(&Review)) {
    let n = review.issues.len();
    let listed = review.issues.iter().enumerate().map(|(i, s)| format!("{}. {s}", i + 1)).collect::<Vec<_>>().join("\n\n");
    let issues = if n == 1 { "serious issue" } else { "serious issues" };
    let found = match review.reviewers.len() {
        0 | 1 => format!("The review found {n} {issues}"),
        k => format!("The {k} reviewers found {n} {issues}"),
    };
    if task.status != "in_review" || state.is_running(&task.id) {
        // The user (or the agent) has moved on; leave the findings for them.
        save(&review);
        state.add_event(&task.id, "warn", found, Some(listed));
        return;
    }
    if review.fixes >= rounds {
        save(&review);
        state.add_event(&task.id, "warn", found.clone(), Some(listed));
        let reason = match rounds {
            0 => found,
            1 => format!("{found} after a round of fixes"),
            n => format!("{found} after {n} rounds of fixes"),
        };
        if let Err(e) = state.update_task(&task.id, &[("status", json!("needs_attention")), ("attention_reason", json!(reason))]) {
            tracing::error!("failed to flag a task: {e:#}");
        }
        return;
    }
    review.fixes += 1;
    save(&review);
    // Each reviewer reports what it found, so two may describe the same problem.
    let overlap = if review.reviewers.len() > 1 { "Each issue says which reviewer found it, and some may be the same problem. " } else { "" };
    let text = format!(
        "{found} in your changes:\n\n{listed}\n\n{overlap}Fix them, then commit (and push, if the branch has a pull request), and end \
         with a summary of what you changed. You don't have to agree with the reviewer: if you think an issue is mistaken, or \
         fixing it needs a decision or information from the user, leave that issue alone and call `request_user_input` \
         explaining your reasoning or question, so the task moves to \"Needs attention\" for the user to decide."
    );
    if let Err(e) = runner::send_fixes(state, &task.id, &text, review.fixes) {
        state.add_event(&task.id, "error", "Couldn't send the review's issues to the agent", Some(e.1));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_projects_instructions_go_between_where_and_how_to_report() {
        let c = db::open(std::path::Path::new(":memory:")).unwrap();
        let p = db::insert_profile(&c, "p", &[], None).unwrap();
        let t = NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "Fix it", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let task = db::insert_task(&c, t).unwrap();
        let text = prompt("X-1", &task, "ia/x-1", Some("master"), "abc", &Work::Branch, &["the bug".into()], &Default::default(), "Check the docs too.");
        let at = |s: &str| text.find(s).unwrap_or_else(|| panic!("{s:?} not in {text}"));
        assert!(at("`pr_view` tool (pr `ia/x-1`)") < at("Check the docs too.") && at("Check the docs too.") < at("call `submit_review` once"));
        assert!(at("submit_review") < at("- the bug"));
    }

    #[test]
    fn what_the_user_decided_goes_before_the_instructions() {
        let c = db::open(std::path::Path::new(":memory:")).unwrap();
        let p = db::insert_profile(&c, "p", &[], None).unwrap();
        let t = NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "Fix it", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let task = db::insert_task(&c, t).unwrap();
        let replies = vec![(Some("Should it be A or B?\nB is faster.".to_string()), "A, the gap is fine".to_string()), (None, "thanks".to_string())];
        let replies = db::UserReplies { replies, ..Default::default() };
        let text = prompt("X-1", &task, "ia/x-1", Some("master"), "abc", &Work::Branch, &[], &replies, "Check the docs too.");
        let at = |s: &str| text.find(s).unwrap_or_else(|| panic!("{s:?} not in {text}"));
        assert!(at("`pr_view`") < at("decisions they made there stand") && at("decisions they made") < at("Check the docs too."));
        assert!(at("The agent:\n\n> Should it be A or B?\n> B is faster.\n\nThe user:\n\n> A, the gap is fine\n") < at("The user:\n\n> thanks"));
        let none = prompt("X-1", &task, "ia/x-1", Some("master"), "abc", &Work::Branch, &[], &Default::default(), "Check the docs too.");
        assert!(!none.contains("decisions they made"));
    }

    #[test]
    fn what_the_user_said_is_cut_to_the_latest() {
        let long = "x".repeat(REPLY_CHARS + 10);
        let said = format!("{} the question?", "y".repeat(REPLY_CONTEXT_CHARS));
        let text = user_said(&[(Some(said), long.clone())], false);
        assert!(text.contains(&format!("> {} [...]\n", "x".repeat(REPLY_CHARS))) && !text.contains(&long));
        assert!(text.contains("> [...] y") && text.contains("the question?") && !text.contains(&"y".repeat(REPLY_CONTEXT_CHARS)));
        // The latest messages, as many as fit.
        let many: Vec<(Option<String>, String)> = (0..20).map(|i| (None, format!("message {i} {}", "z".repeat(REPLY_CHARS - 20)))).collect();
        let text = user_said(&many, false);
        assert!(text.len() < REPLIES_CHARS + 1000 && text.contains("message 19") && !text.contains("message 0 "));
        let at = |s: &str| text.find(s).unwrap_or_else(|| panic!("{s:?} not in {text}"));
        assert!(at("[Earlier messages left out.]") < at("message 18") && at("message 18") < at("message 19"));
        assert_eq!(user_said(&[], false), "");
        // Those the board didn't read are left out too.
        let text = user_said(&many[18..], true);
        assert!(text.contains("[Earlier messages left out.]\n\nThe user:\n\n> message 18") && text.contains("message 19"), "{text}");
        assert!(!user_said(&many[18..], false).contains("left out"));
    }

    #[test]
    fn work_done_elsewhere_is_found_from_the_agents_last_message_and_pr() {
        let c = db::open(std::path::Path::new(":memory:")).unwrap();
        let p = db::insert_profile(&c, "p", &[], None).unwrap();
        let t = NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "Pin images", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let mut task = db::insert_task(&c, t).unwrap();
        task.pr_url = Some("https://github.com/o/deploy/pull/4".into());
        let work = Work::Elsewhere { last_message: Some("Done in o/deploy#4.\nBoth images build.".into()) };
        let text = prompt("X-1", &task, "ia/x-1", Some("master"), "abc", &work, &[], &Default::default(), "Check the docs too.");
        let at = |s: &str| text.find(s).unwrap_or_else(|| panic!("{s:?} not in {text}"));
        assert!(!text.contains("ia/x-1`)"));
        assert!(at("no commits of its own") < at("https://github.com/o/deploy/pull/4") && at("pull/4") < at("`pr_diff` tools with its URL"));
        assert!(at("> Done in o/deploy#4.\n> Both images build.") < at("Check the docs too.") && at("Check the docs too.") < at("submit_review"));

        let work = Work::Elsewhere { last_message: Some("x".repeat(LAST_MESSAGE_CHARS + 10)) };
        let text = prompt("X-1", &task, "ia/x-1", None, "abc", &work, &[], &Default::default(), "");
        assert!(text.contains(&format!("> {} [...]", "x".repeat(LAST_MESSAGE_CHARS))));
    }

    #[test]
    fn a_branch_without_commits_is_reviewed_only_when_the_agent_changed_code() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let p = db::insert_profile(&s.db(), "p", &[], None).unwrap();
            let task = db::insert_task(&s.db(), new_task(&p.id, "task")).unwrap();
            let dir = std::env::temp_dir().join(format!("ia-review-{}", crate::util::new_id()));
            std::fs::create_dir_all(&dir).unwrap();
            assert!(std::process::Command::new("git").arg("init").arg("-q").arg(&dir).status().unwrap().success());
            let n = std::cell::Cell::new(0);
            // A tool call, and its result unless `result` is None (declined or cut short).
            let tool = |name: &str, input: Value, result: Option<bool>| {
                n.set(n.get() + 1);
                let id = format!("t{}", n.get());
                let call = json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": id, "name": name, "input": input}]}});
                s.add_message(&task.id, "claude", call).unwrap();
                if let Some(is_error) = result {
                    let out = json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": id, "content": "", "is_error": is_error}]}});
                    s.add_message(&task.id, "claude", out).unwrap();
                }
            };
            // Only read and answered, and its edits failed or were declined.
            tool("Read", json!({"file_path": "README.md"}), Some(false));
            tool("Bash", json!({"command": "git log -3 > /tmp/log"}), Some(false));
            tool("ApplyPatch", json!({"changes": []}), Some(true));
            tool("Edit", json!({"file_path": "/src/deploy/a.yml"}), None);
            tool("Write", json!({"file_path": "/src/deploy/b.yml"}), Some(true));
            assert!(!changed_elsewhere(&s, &task, &dir, None).await.unwrap());
            let mut with_pr = task.clone();
            with_pr.pr_url = Some("https://github.com/o/deploy/pull/4".into());
            assert!(changed_elsewhere(&s, &with_pr, &dir, None).await.unwrap());

            tool("Bash", json!({"command": "git -C '../deploy repo' commit -am x"}), Some(false));
            assert!(changed_elsewhere(&s, &task, &dir, None).await.unwrap());
            // After a review, only what the agent did since counts, and uncommitted changes.
            std::thread::sleep(std::time::Duration::from_millis(5));
            let review = Review { state: "issues".into(), updated_at: now(), ..Default::default() };
            assert!(!changed_elsewhere(&s, &with_pr, &dir, Some(&review)).await.unwrap());
            std::fs::write(dir.join("a.txt"), "x").unwrap();
            assert!(changed_elsewhere(&s, &task, &dir, Some(&review)).await.unwrap());
            std::fs::remove_file(dir.join("a.txt")).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(5));
            tool("Bash", json!({"command": "sed -i 's/a/b/' /src/deploy/a.yml && false"}), Some(true));
            assert!(changed_elsewhere(&s, &task, &dir, Some(&review)).await.unwrap());
            // An unfinished review doesn't count.
            let stopped = Review { state: "stopped".into(), updated_at: now(), ..Default::default() };
            assert!(changed_elsewhere(&s, &task, &dir, Some(&stopped)).await.unwrap());
            std::fs::remove_dir_all(&dir).unwrap();
        })
    }

    fn new_task<'a>(profile: &'a str, kind: &'a str) -> NewTask<'a> {
        NewTask { profile_id: profile, project_id: None, kind, title: "t", description: "", status: "in_review", use_worktree: false, model: None, effort: None, claude_config_id: None }
    }

    /// A task in review with a review in progress by `n` reviewers, and their threads.
    fn reviewing(s: &Shared, n: usize) -> (Task, Vec<Task>) {
        let p = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let task = db::insert_task(&s.db(), new_task(&p.id, "task")).unwrap();
        let threads: Vec<Task> = (0..n)
            .map(|_| {
                let t = db::insert_task(&s.db(), new_task(&p.id, "review")).unwrap();
                s.update_task(&t.id, &[("parent_id", json!(task.id))]).unwrap().unwrap()
            })
            .collect();
        let parts = threads.iter().enumerate().map(|(i, t)| ReviewerRun { thread_id: t.id.clone(), label: format!("r{i}"), state: "running".into(), ..Default::default() });
        let review = Review { thread_id: threads[0].id.clone(), state: "running".into(), reviewers: parts.collect(), updated_at: now(), ..Default::default() };
        set_review(s, &task.id, &review).unwrap();
        (task, threads)
    }

    fn review_of(s: &Shared, task: &Task) -> Review {
        db::get_task(&s.db(), &task.id).unwrap().unwrap().review.unwrap()
    }

    #[test]
    fn the_review_waits_for_every_reviewer_and_combines_their_issues() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (task, threads) = reviewing(&s, 3);
            submit(&s, &threads[0], "run", &json!({"verdict": "pass", "summary": "Looks good."})).unwrap();
            finished(&s, &threads[0], "run", &Outcome::Ok, None);
            let r = review_of(&s, &task);
            assert_eq!((r.state.as_str(), r.reviewers[0].state.as_str()), ("running", "passed"));

            submit(&s, &threads[1], "run", &json!({"verdict": "needs_fixes", "summary": "One bug.", "serious_issues": ["the bug"]})).unwrap();
            finished(&s, &threads[1], "run", &Outcome::Ok, None);
            assert_eq!(review_of(&s, &task).state, "running");

            // The last one fails: the issues the others found still count.
            finished(&s, &threads[2], "run", &Outcome::Failed("boom".into()), None);
            let r = review_of(&s, &task);
            assert_eq!(r.state, "issues");
            assert_eq!(r.issues, vec!["(r1) the bug".to_string()]);
            assert_eq!(r.reviewers.iter().map(|p| p.state.as_str()).collect::<Vec<_>>(), ["passed", "issues", "failed"]);
            let summary = r.summary.unwrap();
            assert!(summary.contains("**r0:** Looks good.") && summary.contains("**r1:** One bug."), "{summary}");
            // No fix rounds (it has no project): left for the user.
            let t = db::get_task(&s.db(), &task.id).unwrap().unwrap();
            assert_eq!(t.status, "needs_attention");

            // A reviewer that has finished can't submit again.
            assert!(submit(&s, &threads[0], "run", &json!({"verdict": "pass"})).is_err());
        })
    }

    #[test]
    fn a_review_passes_when_every_reviewer_passes() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (task, threads) = reviewing(&s, 2);
            for t in &threads {
                submit(&s, t, "run", &json!({"verdict": "pass"})).unwrap();
                finished(&s, t, "run", &Outcome::Ok, None);
            }
            let r = review_of(&s, &task);
            assert_eq!(r.state, "passed");
            assert!(r.issues.is_empty());
            assert_eq!(db::get_task(&s.db(), &task.id).unwrap().unwrap().status, "in_review");
        })
    }

    #[test]
    fn superseding_stops_every_reviewer() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (task, threads) = reviewing(&s, 2);
            submit(&s, &threads[0], "run", &json!({"verdict": "pass"})).unwrap();
            finished(&s, &threads[0], "run", &Outcome::Ok, None);
            supersede(&s, &task);
            let r = review_of(&s, &task);
            assert_eq!(r.state, "stopped");
            assert_eq!(r.reviewers.iter().map(|p| p.state.as_str()).collect::<Vec<_>>(), ["passed", "stopped"]);
            // The stopped run ending doesn't change it.
            finished(&s, &threads[1], "run", &Outcome::Cancelled, None);
            assert_eq!(review_of(&s, &task).state, "stopped");
        })
    }

    #[test]
    fn stopping_the_task_stops_its_review() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (task, threads) = reviewing(&s, 2);
            assert!(stop(&s, &task.id));
            let r = review_of(&s, &task);
            assert_eq!((r.state.as_str(), r.summary.as_deref()), ("stopped", Some("Stopped by the user.")));
            assert!(r.reviewers.iter().all(|p| p.state == "stopped"));
            finished(&s, &threads[0], "run", &Outcome::Cancelled, None);
            assert_eq!(review_of(&s, &task).state, "stopped");
            // Nothing left to stop.
            assert!(!stop(&s, &task.id));
        })
    }

    #[test]
    fn a_review_from_before_several_reviewers_still_finishes() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (task, threads) = reviewing(&s, 1);
            let old = Review { thread_id: threads[0].id.clone(), state: "running".into(), updated_at: now(), ..Default::default() };
            set_review(&s, &task.id, &old).unwrap();
            submit(&s, &threads[0], "run", &json!({"verdict": "pass", "summary": "Fine."})).unwrap();
            finished(&s, &threads[0], "run", &Outcome::Ok, None);
            let r = review_of(&s, &task);
            assert_eq!((r.state.as_str(), r.summary.as_deref()), ("passed", Some("Fine.")));
        })
    }

    #[test]
    fn reviewers_are_labelled_by_config_model_and_effort() {
        let c = ClaudeConfig { id: "c".into(), name: "Codex".into(), config_dir: String::new(), agent: "codex".into(), show_usage: false, created_at: String::new() };
        assert_eq!(label(Some(&c), Some("gpt-5"), Some("high")), "Codex · gpt-5 · high");
        assert_eq!(label(None, None, None), "Claude");
    }

    /// A task in a project that reviews automatically, with a worktree branch with a commit.
    fn reviewable(s: &Shared) -> (Task, PathBuf) {
        let p = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let np = db::NewProject { id: "pr", profile_id: &p.id, name: "x", key: "X", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: true };
        db::insert_project(&s.db(), np).unwrap();
        let task = db::insert_task(&s.db(), NewTask { project_id: Some("pr"), ..new_task(&p.id, "task") }).unwrap();
        let dir = std::env::temp_dir().join(format!("ia-review-{}", crate::util::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        commit(&dir, &["init", "-q"]);
        commit(&dir, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "work"]);
        let fields = [("worktree_path", json!(crate::util::path_str(&dir))), ("worktree_state", json!("ready")), ("branch", json!("ia/x"))];
        let task = db::update_task(&s.db(), &task.id, &fields).unwrap().unwrap();
        (task, dir)
    }

    fn commit(dir: &Path, args: &[&str]) {
        assert!(std::process::Command::new("git").arg("-C").arg(dir).args(args).status().unwrap().success());
    }

    #[test]
    fn a_review_doesnt_start_once_the_agent_has_started_again() {
        crate::testing::run(async || {
            crate::runs::TEST_CAN_RUN.set(true);
            let s = crate::testing::state();
            let (task, dir) = reviewable(&s);
            // The agent starts again while the review reads the worktree's git state.
            crate::testing::when("review:recording", {
                let (s, task) = (s.clone(), task.clone());
                move || {
                    let run = db::insert_run(&s.db(), &task.id, "prompt").unwrap();
                    s.runs.lock().unwrap().insert(task.id.clone(), crate::state::RunHandle { run_id: run.id, cancel: None });
                    supersede(&s, &task);
                }
            });
            assert!(start(&s, &task.id, false).await.map_err(|e| e.1).unwrap().is_none());
            let t = db::get_task(&s.db(), &task.id).unwrap().unwrap();
            assert!(t.review.is_none(), "{:?}", t.review.map(|r| r.state));
            for thread in db::review_threads(&s.db(), &task.id).unwrap() {
                assert!(!s.is_running(&thread.id), "no reviewer started");
            }
            crate::runs::TEST_CAN_RUN.set(false);
            std::fs::remove_dir_all(&dir).unwrap();
        })
    }

    #[test]
    fn a_review_doesnt_start_on_work_changed_while_it_was_read() {
        crate::testing::run(async || {
            crate::runs::TEST_CAN_RUN.set(true);
            let s = crate::testing::state();
            let (task, dir) = reviewable(&s);
            // A run starts, commits and ends while the review reads the worktree's git state.
            crate::testing::when("review:recording", {
                let (s, task, dir) = (s.clone(), task.clone(), dir.clone());
                move || {
                    let run = db::insert_run(&s.db(), &task.id, "prompt").unwrap();
                    s.runs.lock().unwrap().insert(task.id.clone(), crate::state::RunHandle { run_id: run.id.clone(), cancel: None });
                    supersede(&s, &task);
                    commit(&dir, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "more work"]);
                    s.db().execute("UPDATE runs SET status='running', saw_result=1 WHERE id=?1", [&run.id]).unwrap();
                    runner::on_exit(&s, &run.id, Some(0), None, None, "");
                }
            });
            assert!(start(&s, &task.id, false).await.map_err(|e| e.1).unwrap().is_none());
            let t = db::get_task(&s.db(), &task.id).unwrap().unwrap();
            assert!(t.review.is_none(), "{:?}", t.review.map(|r| (r.state, r.head)));
            // The run's own end reviews it.
            let head = rev_parse(&dir, "HEAD").await;
            let review = loop {
                if let Some(r) = db::get_task(&s.db(), &task.id).unwrap().unwrap().review {
                    break r;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            };
            assert_eq!(review.head, head);
            crate::runs::TEST_CAN_RUN.set(false);
            std::fs::remove_dir_all(&dir).unwrap();
        })
    }

    #[test]
    fn a_review_doesnt_start_on_work_changed_by_a_run_that_started_as_it_did() {
        crate::testing::run(async || {
            crate::runs::TEST_CAN_RUN.set(true);
            let s = crate::testing::state();
            let (task, dir) = reviewable(&s);
            // A run starts as the review looks for the task's last one, then commits and ends while git is read.
            let run = db::insert_run(&s.db(), &task.id, "prompt").unwrap();
            crate::testing::when("review:last-run", {
                let (s, task, run) = (s.clone(), task.clone(), run.clone());
                move || {
                    s.runs.lock().unwrap().insert(task.id.clone(), crate::state::RunHandle { run_id: run.id, cancel: None });
                    supersede(&s, &task);
                }
            });
            crate::testing::when("review:recording", {
                let (s, dir) = (s.clone(), dir.clone());
                move || {
                    commit(&dir, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "more work"]);
                    s.db().execute("UPDATE runs SET status='running', saw_result=1 WHERE id=?1", [&run.id]).unwrap();
                    runner::on_exit(&s, &run.id, Some(0), None, None, "");
                }
            });
            assert!(start(&s, &task.id, false).await.map_err(|e| e.1).unwrap().is_none());
            let t = db::get_task(&s.db(), &task.id).unwrap().unwrap();
            assert!(t.review.is_none(), "{:?}", t.review.map(|r| (r.state, r.head)));
            crate::runs::TEST_CAN_RUN.set(false);
            std::fs::remove_dir_all(&dir).unwrap();
        })
    }

    #[test]
    fn a_review_superseded_as_it_starts_leaves_the_task_to_its_agent() {
        crate::testing::run(async || {
            crate::runs::TEST_CAN_RUN.set(true);
            for fails in [false, true] {
                let s = crate::testing::state();
                let (task, dir) = reviewable(&s);
                let task = s.update_task(&task.id, &[("status", json!("needs_attention"))]).unwrap().unwrap();
                // The user sends the agent more work once the reviewer has started; that run may fail at once.
                crate::testing::when("review:reviewer-started", {
                    let (s, task) = (s.clone(), task.clone());
                    move || {
                        runner::send(&s, &task.id, "more work").unwrap();
                        if fails {
                            let run = s.runs.lock().unwrap().get(&task.id).unwrap().run_id.clone();
                            runner::on_exit(&s, &run, None, None, Some("it didn't start".into()), "");
                        }
                    }
                });
                start(&s, &task.id, true).await.map_err(|e| e.1).unwrap();
                let t = db::get_task(&s.db(), &task.id).unwrap().unwrap();
                assert_eq!(t.review.map(|r| r.state).as_deref(), Some("stopped"));
                match fails {
                    false => assert_eq!((t.running, t.status.as_str()), (true, "in_progress")),
                    true => {
                        assert_eq!((t.running, t.status.as_str()), (false, "needs_attention"));
                        assert!(t.attention_reason.is_some_and(|r| r.contains("it didn't start")));
                    }
                }
                std::fs::remove_dir_all(&dir).unwrap();
            }
            crate::runs::TEST_CAN_RUN.set(false);
        })
    }

    #[test]
    fn a_verdict_from_an_earlier_round_doesnt_count() {
        crate::testing::run(async || {
            use futures::FutureExt;
            let s = crate::testing::state();
            let (task, threads) = reviewing(&s, 1);
            let thread = &threads[0];
            let round = |after: &str| {
                let mut r = review_of(&s, &task);
                r.state = "running".into();
                r.reviewers[0].state = "running".into();
                r.reviewers[0].after_run = Some(after.into());
                set_review(&s, &task.id, &r).unwrap();
            };
            round("");
            let a = db::insert_run(&s.db(), &thread.id, "review").unwrap();
            // A's verdict is cut short by a restart, then A ends and B starts the next round.
            let call = || crate::tools::McpCall { task_fields: true, run_id: a.id.clone(), call_id: "a".into(), tool: "submit_review".into(), args: json!({"verdict": "pass", "summary": "Fine.", "serious_issues": []}) };
            crate::testing::when("mcp:executed", || panic!("the server stopped"));
            assert!(std::panic::AssertUnwindSafe(crate::tools::handle_mcp(&s, call())).catch_unwind().await.is_err());
            finished(&s, thread, &a.id, &Outcome::Ok, None);
            round(&a.id);
            let b = db::insert_run(&s.db(), &thread.id, "review").unwrap();
            submit(&s, thread, &b.id, &json!({"verdict": "needs_fixes", "summary": "A bug.", "serious_issues": ["the bug"]})).unwrap();
            // A's verdict, retried, is turned away; B's stands.
            let err = crate::tools::handle_mcp(&s, call()).await.unwrap_err();
            assert!(err.contains("has ended"), "{err}");
            assert!(submit(&s, thread, &a.id, &json!({"verdict": "pass"})).is_err());
            finished(&s, thread, &b.id, &Outcome::Ok, None);
            let r = review_of(&s, &task);
            assert_eq!((r.state.as_str(), r.issues.clone()), ("issues", vec!["the bug".to_string()]));
        });
    }

    #[test]
    fn a_reviewer_started_just_before_a_restart_still_ends_its_part() {
        crate::testing::run(async || {
            use futures::FutureExt;
            crate::runs::TEST_CAN_RUN.set(true);
            let s = crate::testing::state();
            let (task, dir) = reviewable(&s);
            crate::testing::when("review:reviewer-started", || panic!("the server stopped"));
            assert!(std::panic::AssertUnwindSafe(start(&s, &task.id, true)).catch_unwind().await.is_err());
            assert_eq!(review_of(&s, &task).state, "running");
            // The restart fails the run, which hadn't started its agent: its part ends with it.
            s.runs.lock().unwrap().clear();
            runner::load_active(&s).unwrap();
            let r = review_of(&s, &task);
            assert_eq!((r.state.as_str(), r.reviewers[0].state.as_str()), ("failed", "failed"));
            crate::runs::TEST_CAN_RUN.set(false);
            std::fs::remove_dir_all(&dir).unwrap();
        })
    }
}
