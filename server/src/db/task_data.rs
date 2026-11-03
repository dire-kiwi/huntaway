//! Values kept on a task as JSON: its external links, its pull request's checks, context, the agent's wait, steers, reviewers
//! and reviews.

use super::*;

/// A task in another tracker that a task is for (stored on its task as JSON). Only Asana's for now.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ExternalLink {
    /// Which tracker: `asana`.
    pub provider: String,
    /// The task's id there (an Asana task's gid).
    pub id: String,
    pub url: String,
    /// Its name there, when it was linked.
    #[serde(default)]
    pub title: String,
}

pub const LINK_PROVIDERS: &[&str] = &["asana"];

/// How many external links a task can have.
pub const MAX_LINKS: usize = 20;

/// How a task's pull request's checks stood on its head commit when the board last read them:
/// by a `wait` on it, while it's watched in review, when its state is read for *Done when merged*,
/// or for *Fix broken checks* (see mcp/pr_watch.rs's record_checks). Stored on its task as JSON.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct PrChecks {
    /// The pull request read (see pr_watch::Target::url).
    pub url: String,
    /// The head commit whose checks these are.
    pub head: String,
    /// `failed` (one or more did), `passed` (all those that have to), `pending` or `none`.
    pub outcome: String,
    /// The checks that failed (`FAILED_MAX` at most).
    #[serde(default)]
    pub failed: Vec<FailedCheck>,
    /// How many more failed than are listed.
    #[serde(default)]
    pub more_failed: usize,
    #[serde(default)]
    pub pending: usize,
    #[serde(default)]
    pub passed: usize,
    /// When a read first found them like this.
    pub since: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct FailedCheck {
    /// `Workflow / job` for GitHub Actions, the check's or status's name otherwise.
    pub name: String,
    /// How it ended: `failure`, `cancelled`, `timed_out`…
    pub conclusion: String,
    pub url: Option<String>,
}

/// How much of a thread's context window its agent's session uses (see agent/context.rs), stored on
/// its task as JSON.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Context {
    /// Tokens in the context window as of the agent's latest reply.
    pub tokens: u64,
    /// The model's context window, once known.
    #[serde(default)]
    pub max_tokens: Option<u64>,
    /// Where Claude Code compacts the session by itself, if it does.
    #[serde(default)]
    pub compact_at: Option<u64>,
    #[serde(default)]
    pub model: Option<String>,
    pub updated_at: String,
    /// When the breakdown of what's in it (`GET /tasks/{id}/context`) was taken, if there is one.
    #[serde(default)]
    pub detail_at: Option<String>,
}

/// What a task's worktree starts from instead of the project's base branch (API 96), stored on
/// it as JSON. Set before the worktree is made; worktree::setup turns it into the task's base
/// branch (which its pull request targets and its changes are compared with) and the commit its
/// branch starts at.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StartFrom {
    /// A branch, local or on the remote, which becomes the task's base branch.
    Branch { branch: String },
    /// Another task in the project (by id): its branch, so the task is stacked on it.
    Task { task_id: String },
    /// A pull request in the project's GitHub repository: its branch, as for a task. `repo`
    /// (`OWNER/REPO`) is the repository its URL named, if it was given one.
    PullRequest {
        number: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        repo: Option<String>,
    },
    /// A commit (its SHA, in full when it was found in the repository); the base branch stays
    /// the project's.
    Commit { commit: String },
}

impl StartFrom {
    /// What it is, as people and agents read it: `task ABC-12` (`key` is its project's key),
    /// `branch feature`, `pull request #12` or `commit 0123abcd`.
    pub fn describe(&self, c: &Connection, key: &str) -> String {
        match self {
            StartFrom::Branch { branch } => format!("branch {branch}"),
            StartFrom::Task { task_id } => match get_task(c, task_id).ok().flatten() {
                Some(t) => format!("task {key}-{}", t.number),
                None => "a deleted task".into(),
            },
            StartFrom::PullRequest { number, repo } => format!("pull request {}#{number}", repo.as_deref().unwrap_or_default()),
            StartFrom::Commit { commit } => format!("commit {}", &commit[..commit.len().min(12)]),
        }
    }
}

/// What an agent in the `wait` tool is waiting for (see mcp/wait.rs), stored on its task as JSON.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AgentWait {
    /// What it's waiting on, in the agent's words.
    #[serde(default)]
    pub reason: Option<String>,
    pub since: String,
    /// When the wait ends at the latest.
    pub until: String,
    /// Tasks whose next change of status ends the wait, with the status each had.
    #[serde(default)]
    pub tasks: Vec<WaitTask>,
    /// A shell command run while waiting, whose exit ends the wait.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// The tool call that's waiting, and its run.
    pub call_id: String,
    pub run_id: String,
    /// Set as the task is moved to this column (from the board or `update_task`), which ends
    /// the wait. Recorded with the move, so the wait can tell it from the status changes the
    /// board makes itself (a subagent's permission prompt and its answer).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub moved_to: Option<String>,
    /// The first subagent that finished during the wait, kept until the call returns (also
    /// across a server restart).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_finished: Option<Value>,
    /// A pull request whose news ends the wait (API 62, see mcp/pr_watch.rs).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pull_request: Option<WaitPr>,
}

/// The pull request a wait watches.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct WaitPr {
    pub url: String,
    /// `OWNER/REPO`, or `HOST/OWNER/REPO` off github.com.
    pub repo: String,
    pub number: u64,
    /// What ends the wait (see pr_watch::EVENTS); its being merged or closed always does.
    pub events: Vec<String>,
    /// What a read found that ends the wait, kept until the call returns (also across a server
    /// restart), with what the agent has been told once it has (see pr_watch::News).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub news: Option<Value>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct WaitTask {
    pub id: String,
    pub key: String,
    pub status: String,
}

/// A message sent to a running agent, kept until the agent takes it in (see runner::steer).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Steer {
    /// Also the stream-json message's uuid, which the agent echoes back when it takes it in.
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub from_agent: bool,
    /// The run it was sent to.
    pub run_id: String,
    /// Written to the run's input. Until then it's waiting for the run to start.
    #[serde(default)]
    pub written: bool,
}

/// One of a project's reviewers: the agent that reviews, in a review thread of its own.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Reviewer {
    /// None uses the reviewed task's config.
    #[serde(default)]
    pub claude_config_id: Option<String>,
    /// None uses the default (the project's, profile's or host's, as for any thread).
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    /// This reviewer's own instructions (API 102), replacing the project's *In review* prompt for it (what to look
    /// for), or the default summary instructions for a summarizer. None follows the project's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    /// Names of board skills (a project's own or global ones) that are on in this reviewer's thread whether or not they
    /// are for the project (API 102).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<String>,
}

/// A task's latest review (see review.rs), stored on the task as JSON. With several reviewers,
/// `reviewers` has each one's part and the rest combines them.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Review {
    /// The (first) review thread: a `review` task whose parent is this task.
    pub thread_id: String,
    /// running, passed, issues, failed or stopped
    pub state: String,
    /// The commit reviewed.
    pub head: Option<String>,
    /// What the reviewer reported (or why the review failed).
    pub summary: Option<String>,
    /// Serious issues the reviewer found, which go back to the task's agent to fix.
    #[serde(default)]
    pub issues: Vec<String>,
    /// Set by `submit_review` while the review is running: pass or issues.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict: Option<String>,
    /// Reviews in a row that sent issues back to the agent (capped by the project's review_rounds, plus `extra_rounds`).
    #[serde(default)]
    pub fixes: u32,
    /// Rounds of fixes the user added after the task ran out of them (API 93, see review::extend).
    #[serde(default)]
    pub extra_rounds: u32,
    pub updated_at: String,
    /// When this round of review started: the round each reviewer's submission is kept with, for
    /// statistics (see review/stats.rs). Missing on reviews started before it was kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    /// Each reviewer's part (API 29). Empty in reviews from before there could be several.
    #[serde(default)]
    pub reviewers: Vec<ReviewerRun>,
}

/// A summary of a task's changes (see review/summary.rs), stored on the task as JSON.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ChangeSummary {
    /// The summary thread: a `review` task of type `summary` whose parent is this task.
    pub thread_id: String,
    /// Who writes it, e.g. "Claude · haiku".
    #[serde(default)]
    pub label: String,
    /// running, done, failed or stopped
    pub state: String,
    /// The commit summarised.
    pub head: Option<String>,
    /// The summary (Markdown), or why there's none.
    pub text: Option<String>,
    /// The thread's last run before this one (empty if it had none), as ReviewerRun::after_run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_run: Option<String>,
    pub updated_at: String,
}

/// One reviewer's part of a review.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ReviewerRun {
    pub thread_id: String,
    /// Which agent reviews, e.g. "Codex · gpt-5.1".
    pub label: String,
    /// running, passed, issues, failed or stopped
    pub state: String,
    pub summary: Option<String>,
    #[serde(default)]
    pub issues: Vec<String>,
    /// Set by `submit_review` while it's running: pass or issues.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict: Option<String>,
    /// The thread's last run before this round (empty if it had none): the round's reviewer is
    /// a later one, so an earlier run's late verdict or end doesn't end this part. Missing on
    /// parts recorded before this was kept, which any run of the thread ends.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_run: Option<String>,
}
