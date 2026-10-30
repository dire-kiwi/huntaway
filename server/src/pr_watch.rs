//! A `wait` on a pull request (`pull_request`, API 62): the wait ends on news about it that the
//! agent hasn't been told yet (`EVENTS`, all of them unless it picks some):
//! - `checks_failed`: a check on its head commit failed (or was cancelled or timed out);
//! - `checks_passed`: all of its head commit's required checks passed (all of its checks, when
//!   none is required);
//! - `comments`: someone other than the agent's own GitHub account commented or reviewed;
//! - `conflicts`: it started to conflict with its base branch;
//! - and, whatever it picked, its being merged or closed.
//!
//! The server reads it with one GraphQL query every `POLL`, as the GitHub account the task's gh
//! tools act as (its project's or profile's, see runner::github_account; gh's active account when
//! neither picks one), and never as another: an account that isn't signed in fails the read, and
//! one on another host than the pull request's doesn't start the wait. A read that fails is tried
//! again later and later (`backoff`), and after `GIVE_UP` failures in a row the wait ends saying
//! so (`unreadable`). The first read is made before the wait starts, so a pull request that can't
//! be read (a typo, no access) fails the call straight away.
//!
//! What the agent has been told about each pull request is kept for its task (`pr_watches`),
//! across its waits and server restarts: the comments and reviews seen, the head commit whose
//! checks' outcome it was told, and whether it was told of a conflict. So a wait reports what
//! happened since the last one on that pull request: a review that arrives while the agent works
//! between two waits ends the second one straight away, and a restart doesn't report old comments
//! again. The first wait on a pull request counts the comments it has as seen, but reports how its
//! checks ended and a conflict. News counts as told once a call returns it to the agent: one that
//! ends without reaching it (the run stopped, or carried on with something else) leaves it for the
//! next wait.
//!
//! The board also reads the pull request of a task in "In review" while its agent is idle, in
//! projects that ask for it, and sends the agent its news (see `watch_in_review`), with the same
//! record of what it has been told.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use anyhow::Context;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::db::{self, Task, WaitPr};
use crate::gh_mcp::{Account, GhEnv};
use crate::state::Shared;

/// What can end a wait on a pull request, besides its being merged or closed.
pub const EVENTS: &[&str] = &["checks_failed", "checks_passed", "comments", "conflicts"];

/// How often a pull request is read.
pub const POLL: Duration = Duration::from_millis(if cfg!(test) { 100 } else { 60_000 });

/// How many failed reads in a row end the wait.
pub const GIVE_UP: u32 = 5;

/// How long a gh call may take.
const GH_TIMEOUT: Duration = Duration::from_secs(60);

/// The most comments a wait lists, and how much of each one's text.
const LISTED: usize = 20;
const BODY_MAX: usize = 800;

/// How many comment ids are kept as seen (the reads see the latest ones only).
const SEEN_MAX: usize = 2000;

/// A pull request on a GitHub host.
#[derive(Debug, Clone, PartialEq)]
pub struct Target {
    pub host: String,
    pub owner: String,
    pub name: String,
    pub number: u64,
}

impl Target {
    /// `OWNER/REPO`, or `HOST/OWNER/REPO` off github.com.
    pub fn repo(&self) -> String {
        match self.host.as_str() {
            "github.com" => format!("{}/{}", self.owner, self.name),
            host => format!("{host}/{}/{}", self.owner, self.name),
        }
    }

    pub fn url(&self) -> String {
        format!("https://{}/{}/{}/pull/{}", self.host, self.owner, self.name, self.number)
    }

    /// `OWNER/REPO#N` (with the host off github.com).
    pub fn label(&self) -> String {
        format!("{}#{}", self.repo(), self.number)
    }

    /// What the agent's been told about it is kept under (see `pr_watches`).
    fn key(&self) -> String {
        format!("{}/{}/{}#{}", self.host, self.owner, self.name, self.number).to_ascii_lowercase()
    }

    /// The pull request a stored wait watches.
    pub fn of(w: &WaitPr) -> Option<Self> {
        let parts: Vec<&str> = w.repo.split('/').collect();
        let (host, owner, name) = match parts[..] {
            [owner, name] => ("github.com", owner, name),
            [host, owner, name] => (host, owner, name),
            _ => return None,
        };
        Some(Self { host: host.into(), owner: owner.into(), name: name.into(), number: w.number })
    }

    /// The pull request a wait was given: its number (`12`, `#12`), `OWNER/REPO#12` or URL. A
    /// number is in `default` (the task's repository: its host and `OWNER/REPO`), and `OWNER/REPO`
    /// on its host.
    fn parse(given: &str, default: Option<&(String, String)>) -> Result<Self, String> {
        let given = given.trim();
        let number = |n: &str| n.parse::<u64>().ok().filter(|&n| n > 0);
        let in_repo = |host: &str, repo: &str, n: u64| {
            let (owner, name) = repo.split_once('/').filter(|(o, n)| ok_name(o) && ok_name(n))?;
            Some(Self { host: host.to_ascii_lowercase(), owner: owner.into(), name: name.into(), number: n })
        };
        if let Some(rest) = given.strip_prefix("https://").or_else(|| given.strip_prefix("http://")) {
            // Its page or one of its tabs (`/files`), with or without an anchor.
            let rest = rest.split(['#', '?']).next().unwrap_or_default();
            let parts: Vec<&str> = rest.split('/').collect();
            if let [host, owner, name, "pull", n, ..] = parts[..]
                && let Some(n) = number(n)
            {
                let host = if crate::worktree::is_github_com(&host.to_ascii_lowercase()) { "github.com" } else { host };
                return in_repo(host, &format!("{owner}/{name}"), n).ok_or_else(|| format!("{given} isn't a pull request's URL"));
            }
            return Err(format!("{given} isn't a pull request's URL (https://github.com/OWNER/REPO/pull/NUMBER)"));
        }
        let no_repo = || {
            "this task's repository has no remote on GitHub to find the pull request in: give its URL (https://github.com/OWNER/REPO/pull/NUMBER)".to_string()
        };
        if let Some((repo, n)) = given.split_once('#').filter(|(r, _)| !r.is_empty())
            && let Some(n) = number(n)
        {
            let host = default.map_or("github.com", |(h, _)| h.as_str());
            return in_repo(host, repo, n).ok_or_else(|| format!("{given} isn't a pull request (OWNER/REPO#NUMBER)"));
        }
        match number(given.trim_start_matches('#')) {
            Some(n) => {
                let (host, repo) = default.ok_or_else(no_repo)?;
                in_repo(host, repo, n).ok_or_else(no_repo)
            }
            None => Err(format!("{given} isn't a pull request: give its number, OWNER/REPO#NUMBER or its URL")),
        }
    }
}

/// An owner's or repository's name as GitHub has them.
fn ok_name(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
}

/// What a wait's `pull_request` and `pull_request_events` ask for.
#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub target: Target,
    pub events: Vec<String>,
}

impl Request {
    /// How the wait keeps it.
    pub fn stored(&self, news: Option<Value>) -> WaitPr {
        WaitPr { url: self.target.url(), repo: self.target.repo(), number: self.target.number, events: self.events.clone(), news }
    }
}

/// The pull request `pr` (a number or a string, see `Target::parse`) that `task`'s agent asked to
/// wait on, and `events` (null for all of them, see `EVENTS`).
pub async fn request(s: &Shared, task: &Task, pr: &Value, events: &Value) -> Result<Request, String> {
    let events = match events {
        Value::Null => EVENTS.iter().map(|e| e.to_string()).collect(),
        Value::Array(list) => {
            let mut out = Vec::new();
            for e in list {
                match e.as_str().filter(|e| EVENTS.contains(e)) {
                    Some(e) if !out.iter().any(|o| o == e) => out.push(e.to_string()),
                    Some(_) => {}
                    None => return Err(format!("pull_request_events takes {} (got {e})", EVENTS.join(", "))),
                }
            }
            out
        }
        _ => return Err(format!("pull_request_events must be a list of {}", EVENTS.join(", "))),
    };
    let given = match pr {
        Value::Number(n) => n.to_string(),
        Value::String(p) => p.clone(),
        _ => return Err("pull_request must be a pull request's number or URL".into()),
    };
    let default = task_repo(s, task).await;
    let target = Target::parse(&given, default.as_ref())?;
    let account = crate::runner::task_github_account(s, task).map_err(|e| format!("{e:#}"))?;
    if let Some(a) = account.as_deref().and_then(Account::parse)
        && a.host != target.host
    {
        return Err(format!("{} is on {}, but this task's GitHub account {a} is on {}, so it can't be read", target.label(), target.host, a.host));
    }
    Ok(Request { target, events })
}

/// The host and `OWNER/REPO` of the repository `task`'s branch is pushed to, if it has one.
async fn task_repo(s: &Shared, task: &Task) -> Option<(String, String)> {
    let project = db::get_project(&s.db(), task.project_id.as_deref()?).ok().flatten()?;
    let base = task.base_branch.as_deref().or(project.base_branch.as_deref()).filter(|b| !b.is_empty());
    let (host, repo) = crate::worktree::push_repo(&crate::util::expand_tilde(&project.repo_path), base).await?;
    Some((if crate::worktree::is_github_com(&host) { "github.com".into() } else { host }, repo))
}

// ---------- reading ----------

/// Reads one pull request for a task, as its GitHub account.
pub struct Watcher {
    pub target: Target,
    account: Option<String>,
    /// gh's environment for the account, kept between reads (and made again after one fails).
    env: Option<GhEnv>,
}

impl Watcher {
    pub fn new(s: &Shared, task: &Task, target: Target) -> anyhow::Result<Self> {
        Ok(Self { target, account: crate::runner::task_github_account(s, task)?, env: None })
    }

    /// The pull request as GitHub has it now.
    async fn read(&mut self) -> Result<Pr, String> {
        let r = self.query().await;
        if r.is_err() {
            self.env = None;
        }
        Pr::parse(&r?)
    }

    /// The GraphQL query's response.
    async fn query(&mut self) -> Result<Value, String> {
        #[cfg(test)]
        if let Some(r) = FAKE.with_borrow(|f| f.as_ref().map(|f| f(self.account.as_deref(), &self.target))) {
            return r;
        }
        let t = &self.target;
        let mut args: Vec<String> = vec![
            "api".into(),
            "graphql".into(),
            "-f".into(),
            format!("query={QUERY}"),
            "-f".into(),
            format!("owner={}", t.owner),
            "-f".into(),
            format!("name={}", t.name),
            "-F".into(),
            format!("number={}", t.number),
        ];
        if t.host != "github.com" {
            args.extend(["--hostname".into(), t.host.clone()]);
        }
        let mut cmd = tokio::process::Command::new(crate::gh_mcp::gh_program());
        if let Some(account) = &self.account {
            if self.env.is_none() {
                self.env = crate::gh_mcp::account_env(Some(account)).await.map_err(|e| format!("{e:#}"))?;
            }
            let env = self.env.as_ref().with_context(|| format!("{account} isn't a GitHub account")).map_err(|e| format!("{e:#}"))?;
            let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
            env.check(&arg_refs, None).map_err(|e| format!("{e:#}"))?;
            env.apply(&mut cmd);
        } else {
            cmd.env_remove("GH_REPO");
        }
        cmd.args(&args)
            .env("GH_PROMPT_DISABLED", "1")
            .env("GH_NO_UPDATE_NOTIFIER", "1")
            .env("NO_COLOR", "1")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let out = tokio::time::timeout(GH_TIMEOUT, cmd.output())
            .await
            .map_err(|_| format!("gh timed out after {} seconds", GH_TIMEOUT.as_secs()))?
            .map_err(|e| format!("couldn't run gh: {e}"))?;
        // gh prints GraphQL errors' response too, and exits with 1.
        match serde_json::from_slice::<Value>(&out.stdout) {
            Ok(v) if v.is_object() => Ok(v),
            _ => {
                let err = String::from_utf8_lossy(&out.stderr);
                Err(format!("gh failed: {}", err.trim().trim_start_matches("gh: ")))
            }
        }
    }

    /// Read the pull request and see what's news to the agent of `task_id` since it was last told
    /// (`events` only, see `compare`). What isn't news (its own comments, a conflict that's
    /// gone) is stored as seen now; news, for the call `call_id` to report, is stored apart until
    /// it does (see `delivered`). Returns the news, if any.
    pub async fn poll(&mut self, s: &Shared, task_id: &str, call_id: &str, events: &[String]) -> Result<Option<Value>, String> {
        let pr = self.read().await?;
        let key = self.target.key();
        let c = s.db();
        let row = load(&c, task_id, &key).map_err(|e| format!("{e:#}"))?;
        let first = row.is_none();
        let mut row = row.unwrap_or_default();
        let (quiet, news) = compare((!first).then_some(&row.seen), &pr, events);
        row.pending = news.as_ref().map(|(_, told)| Pending { call_id: call_id.into(), told: told.clone() });
        (row.seen, row.last, row.polled_at) = (quiet, summary(&pr), crate::util::now());
        store(&c, task_id, &key, &row).map_err(|e| format!("{e:#}"))?;
        Ok(news.map(|(report, _)| report))
    }
}

/// Poll `w` for the wait `call_id` of `task_id` (after `delay`, then every `POLL`) until there's
/// news, which it records in the wait, or it has failed `GIVE_UP` times in a row.
pub async fn watch(s: &Shared, task_id: &str, call_id: &str, events: &[String], mut w: Watcher, mut delay: Duration) {
    let mut failures = 0;
    loop {
        tokio::time::sleep(delay).await;
        match w.poll(s, task_id, call_id, events).await {
            Ok(Some(news)) => return record(s, task_id, call_id, news),
            Ok(None) => {
                failures = 0;
                delay = POLL;
            }
            Err(e) => {
                failures += 1;
                tracing::warn!(task = task_id, pr = %w.target.label(), failures, "reading a pull request: {e}");
                if failures >= GIVE_UP {
                    let news = json!({
                        "events": ["unreadable"],
                        "url": w.target.url(),
                        "number": w.target.number,
                        "error": format!("{} couldn't be read {GIVE_UP} times in a row: {e}", w.target.label()),
                    });
                    return record(s, task_id, call_id, news);
                }
                delay = backoff(failures);
            }
        }
    }
}

/// How long to wait before reading again after `failures` failed reads in a row.
pub fn backoff(failures: u32) -> Duration {
    POLL.saturating_mul(1 << failures.min(4)).min(POLL * 10)
}

/// Keep `news` in the wait `call_id` (if it's still waiting), which ends it.
fn record(s: &Shared, task_id: &str, call_id: &str, news: Value) {
    let changed = (|| -> anyhow::Result<Option<Task>> {
        // One lock for the read and write, as for a subagent's completion (see wait.rs).
        let c = s.db();
        let waiting = db::get_task(&c, task_id)?.and_then(|t| t.agent_wait);
        let Some(mut w) = waiting.filter(|w| w.call_id == call_id) else { return Ok(None) };
        let Some(pr) = w.pull_request.as_mut().filter(|p| p.news.is_none()) else { return Ok(None) };
        pr.news = Some(news);
        db::update_task(&c, task_id, &[("agent_wait", json!(w))])
    })();
    match changed {
        Ok(Some(t)) => s.emit_task(&t),
        Ok(None) => {}
        Err(e) => tracing::error!(task = task_id, "recording a pull request's news: {e:#}"),
    }
}

/// The news that the wait `call_id` on `w` found has reached the agent: it's been told.
pub fn delivered(s: &Shared, task_id: &str, call_id: &str, w: &WaitPr) {
    let Some(target) = Target::of(w) else { return };
    told(s, task_id, &target.key(), call_id, |_| {});
}

/// The news that `call_id` found about the pull request `key` has reached `task_id`'s agent, if
/// it's still the news kept for it: it's been told. `also` changes the row with it.
fn told(s: &Shared, task_id: &str, key: &str, call_id: &str, also: impl FnOnce(&mut Row)) {
    let r = (|| -> anyhow::Result<()> {
        let c = s.db();
        let Some(mut row) = load(&c, task_id, key)? else { return Ok(()) };
        if let Some(p) = row.pending.take().filter(|p| p.call_id == call_id) {
            row.seen = p.told;
            also(&mut row);
            store(&c, task_id, key, &row)?;
        }
        Ok(())
    })();
    if let Err(e) = r {
        tracing::error!(task = task_id, "recording what the agent was told about a pull request: {e:#}");
    }
}

/// What the last read of `w` for `task_id` found, for a wait that ended otherwise.
pub fn last(s: &Shared, task_id: &str, w: &WaitPr) -> Option<Value> {
    let row = load(&s.db(), task_id, &Target::of(w)?.key()).ok().flatten()?;
    let mut last = row.last;
    last["read_at"] = json!(row.polled_at);
    Some(last)
}

// ---------- what the agent's been told ----------

/// What the agent has been told about a pull request.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
struct Seen {
    /// The head commit whose checks it was told about.
    #[serde(default)]
    head: Option<String>,
    /// That commit's failed checks it was told of (see `Check::key`).
    #[serde(default)]
    failed: Vec<String>,
    /// Whether it was told that commit's checks passed.
    #[serde(default)]
    passed: bool,
    /// The comments and reviews it has seen (ids), the latest last.
    #[serde(default)]
    remarks: Vec<String>,
    /// Whether it was told the pull request conflicts with its base (and it still does).
    #[serde(default)]
    conflicting: bool,
}

/// What a call found and hasn't returned yet: what the agent will have been told once it has.
#[derive(Serialize, Deserialize, Clone, Debug)]
struct Pending {
    call_id: String,
    told: Seen,
}

/// A `pr_watches` row.
#[derive(Serialize, Deserialize, Debug, Default)]
struct Row {
    seen: Seen,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending: Option<Pending>,
    /// What the last read found (see `summary`), and when.
    #[serde(default)]
    last: Value,
    #[serde(default)]
    polled_at: String,
    /// How many times in a row news of comments alone woke the agent while its task was in
    /// review (see `watch_in_review`), when it last woke it, and whether comments stopped waking
    /// it after `COMMENT_WAKES` of those.
    #[serde(default)]
    comment_wakes: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    woke_at: Option<String>,
    #[serde(default)]
    comments_paused: bool,
}

fn load(c: &Connection, task_id: &str, key: &str) -> anyhow::Result<Option<Row>> {
    let state: Option<String> =
        c.query_row("SELECT state FROM pr_watches WHERE task_id=?1 AND pr=?2", [task_id, key], |r| r.get(0)).optional()?;
    Ok(state.and_then(|s| serde_json::from_str(&s).ok()))
}

fn store(c: &Connection, task_id: &str, key: &str, row: &Row) -> anyhow::Result<()> {
    c.execute(
        "INSERT INTO pr_watches (task_id, pr, state, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(task_id, pr) DO UPDATE SET state=?3, updated_at=?4",
        rusqlite::params![task_id, key, serde_json::to_string(row)?, crate::util::now()],
    )?;
    Ok(())
}

// ---------- the pull request ----------

/// The query a read makes: the pull request's state, its head commit's checks, and its latest
/// comments, reviews and review comments, with who's asking (`viewer`).
const QUERY: &str = "query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      url number title state isDraft baseRefName headRefOid mergeable mergeStateStatus reviewDecision
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { databaseId name status conclusion detailsUrl isRequired(pullRequestNumber: $number) checkSuite { workflowRun { workflow { name } } } }
        ... on StatusContext { context state targetUrl createdAt isRequired(pullRequestNumber: $number) }
      } } } } } }
      comments(last: 50) { nodes { id author { __typename login } body url createdAt } }
      reviews(last: 50) { nodes { id author { __typename login } state body url submittedAt } }
      reviewThreads(first: 100) { nodes { path comments(last: 20) { nodes { id author { __typename login } body url createdAt path line originalLine } } } }
    }
  }
}";

#[derive(Debug, Clone, Copy, PartialEq)]
enum CheckState {
    Pending,
    Passed,
    Failed,
}

#[derive(Debug, Clone)]
struct Check {
    /// One run of it: a check run's id, or a status's context and time.
    key: String,
    name: String,
    state: CheckState,
    /// How it ended (`failure`, `cancelled`…), or its status while it runs.
    conclusion: String,
    url: Option<String>,
    required: bool,
}

/// A comment, review or review comment.
#[derive(Debug, Clone)]
struct Remark {
    id: String,
    author: Option<String>,
    /// Whether a GitHub App (a bot) wrote it.
    bot: bool,
    kind: &'static str,
    review_state: Option<String>,
    path: Option<String>,
    line: Option<u64>,
    body: String,
    url: Option<String>,
    at: Option<String>,
}

impl Remark {
    /// A review that only says it commented, whose comments say what it did.
    fn is_bare_review(&self) -> bool {
        self.kind == "review" && self.review_state.as_deref() == Some("commented") && self.body.trim().is_empty()
    }
}

/// A pull request as a read found it.
#[derive(Debug, Clone)]
struct Pr {
    viewer: String,
    url: String,
    number: u64,
    title: String,
    /// open, merged or closed.
    state: String,
    draft: bool,
    base: String,
    head: String,
    /// mergeable, conflicting or unknown (GitHub hasn't worked it out yet).
    mergeable: String,
    merge_state: Option<String>,
    review_decision: Option<String>,
    checks: Vec<Check>,
    remarks: Vec<Remark>,
}

fn lower(v: &Value) -> Option<String> {
    v.as_str().map(str::to_ascii_lowercase)
}

fn string(v: &Value) -> Option<String> {
    v.as_str().map(String::from)
}

impl Pr {
    /// From the query's response.
    fn parse(v: &Value) -> Result<Self, String> {
        let pr = &v["data"]["repository"]["pullRequest"];
        if !pr.is_object() {
            let errors: Vec<&str> = v["errors"].as_array().into_iter().flatten().filter_map(|e| e["message"].as_str()).collect();
            return Err(if errors.is_empty() { "GitHub didn't return the pull request".into() } else { errors.join("; ") });
        }
        let mut checks = Vec::new();
        let contexts = &pr["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["contexts"]["nodes"];
        for c in contexts.as_array().into_iter().flatten() {
            let required = c["isRequired"] == true;
            if c["__typename"] == "CheckRun" {
                let status = lower(&c["status"]).unwrap_or_default();
                let conclusion = lower(&c["conclusion"]).unwrap_or_default();
                let state = match (status.as_str(), conclusion.as_str()) {
                    (s, _) if s != "completed" => CheckState::Pending,
                    (_, "failure" | "cancelled" | "timed_out" | "action_required" | "startup_failure") => CheckState::Failed,
                    _ => CheckState::Passed,
                };
                let name = c["name"].as_str().unwrap_or("check");
                let name = match c["checkSuite"]["workflowRun"]["workflow"]["name"].as_str() {
                    Some(w) if !w.is_empty() => format!("{w} / {name}"),
                    _ => name.to_string(),
                };
                let conclusion = if state == CheckState::Pending { status } else { conclusion };
                let id = c["databaseId"].as_u64().map(|n| n.to_string()).or_else(|| string(&c["databaseId"])).unwrap_or_default();
                checks.push(Check { key: format!("run:{id}"), name, state, conclusion, url: string(&c["detailsUrl"]), required });
            } else if c["__typename"] == "StatusContext" {
                let status = lower(&c["state"]).unwrap_or_default();
                let state = match status.as_str() {
                    "success" => CheckState::Passed,
                    "failure" | "error" => CheckState::Failed,
                    _ => CheckState::Pending,
                };
                let name = c["context"].as_str().unwrap_or("status").to_string();
                let key = format!("status:{name}:{}", c["createdAt"].as_str().unwrap_or_default());
                checks.push(Check { key, name, state, conclusion: status, url: string(&c["targetUrl"]), required });
            }
        }
        let mut remarks = Vec::new();
        let author = |n: &Value| string(&n["author"]["login"]);
        let bot = |n: &Value| n["author"]["__typename"] == "Bot";
        for n in pr["comments"]["nodes"].as_array().into_iter().flatten() {
            remarks.push(Remark {
                id: n["id"].as_str().unwrap_or_default().into(), author: author(n), bot: bot(n), kind: "comment", review_state: None, path: None, line: None,
                body: n["body"].as_str().unwrap_or_default().into(), url: string(&n["url"]), at: string(&n["createdAt"]),
            });
        }
        for n in pr["reviews"]["nodes"].as_array().into_iter().flatten() {
            // A review being written is its author's own.
            if n["state"] == "PENDING" {
                continue;
            }
            remarks.push(Remark {
                id: n["id"].as_str().unwrap_or_default().into(), author: author(n), bot: bot(n), kind: "review", review_state: lower(&n["state"]), path: None,
                line: None, body: n["body"].as_str().unwrap_or_default().into(), url: string(&n["url"]), at: string(&n["submittedAt"]),
            });
        }
        for t in pr["reviewThreads"]["nodes"].as_array().into_iter().flatten() {
            for n in t["comments"]["nodes"].as_array().into_iter().flatten() {
                remarks.push(Remark {
                    id: n["id"].as_str().unwrap_or_default().into(), author: author(n), bot: bot(n), kind: "review_comment", review_state: None,
                    path: string(&n["path"]).or_else(|| string(&t["path"])), line: n["line"].as_u64().or_else(|| n["originalLine"].as_u64()),
                    body: n["body"].as_str().unwrap_or_default().into(), url: string(&n["url"]), at: string(&n["createdAt"]),
                });
            }
        }
        remarks.retain(|r| !r.id.is_empty());
        remarks.sort_by(|a, b| a.at.cmp(&b.at));
        Ok(Self {
            viewer: v["data"]["viewer"]["login"].as_str().unwrap_or_default().to_string(),
            url: pr["url"].as_str().unwrap_or_default().to_string(),
            number: pr["number"].as_u64().unwrap_or_default(),
            title: pr["title"].as_str().unwrap_or_default().to_string(),
            state: lower(&pr["state"]).unwrap_or_else(|| "open".into()),
            draft: pr["isDraft"] == true,
            base: pr["baseRefName"].as_str().unwrap_or_default().to_string(),
            head: pr["headRefOid"].as_str().unwrap_or_default().to_string(),
            mergeable: lower(&pr["mergeable"]).unwrap_or_else(|| "unknown".into()),
            merge_state: lower(&pr["mergeStateStatus"]),
            review_decision: lower(&pr["reviewDecision"]),
            checks,
            remarks,
        })
    }

    fn is_own(&self, r: &Remark) -> bool {
        r.author.as_deref().is_some_and(|a| !self.viewer.is_empty() && a.eq_ignore_ascii_case(&self.viewer))
    }

    /// The checks that have to pass: the required ones, or all of them if none is.
    fn gate(&self) -> Vec<&Check> {
        let required: Vec<&Check> = self.checks.iter().filter(|c| c.required).collect();
        if required.is_empty() { self.checks.iter().collect() } else { required }
    }

    fn passed(&self) -> bool {
        let gate = self.gate();
        !gate.is_empty() && gate.iter().all(|c| c.state == CheckState::Passed)
    }
}

/// What's news in `pr` to an agent that was told `seen` (none for its first wait on it), of
/// `events`: what to store as seen meanwhile (its own comments, a conflict that's gone), and the
/// news, if any, with what it will have been told once it gets it.
fn compare(seen: Option<&Seen>, pr: &Pr, events: &[String]) -> (Seen, Option<(Value, Seen)>) {
    let wants = |e: &str| events.iter().any(|x| x == e);
    let first = seen.is_none();
    let mut quiet = seen.cloned().unwrap_or_default();
    // Never news: the agent's own comments, those from before its first wait, and reviews that
    // only say their comments were made.
    for r in &pr.remarks {
        if (first || pr.is_own(r) || r.is_bare_review()) && !quiet.remarks.contains(&r.id) {
            quiet.remarks.push(r.id.clone());
        }
    }
    // Unknown while GitHub works it out (after a push): only a clean answer ends a conflict.
    let conflicting = match pr.mergeable.as_str() {
        "conflicting" => Some(true),
        "mergeable" => Some(false),
        _ => None,
    };
    if conflicting == Some(false) {
        quiet.conflicting = false;
    }
    let trim = |remarks: &mut Vec<String>| {
        let extra = remarks.len().saturating_sub(SEEN_MAX);
        remarks.drain(..extra);
    };
    trim(&mut quiet.remarks);

    let mut told = quiet.clone();
    let mut found = Vec::new();
    // The head's checks: what the agent was told of them, if it's the head it was told about.
    let same_head = quiet.head.as_deref() == Some(pr.head.as_str());
    let (mut failed, mut passed) = if same_head { (quiet.failed.clone(), quiet.passed) } else { (Vec::new(), false) };
    let new_failed: Vec<&Check> = pr.checks.iter().filter(|c| c.state == CheckState::Failed && !failed.contains(&c.key)).collect();
    let mut checks_news = false;
    if wants("checks_failed") && !new_failed.is_empty() {
        found.push("checks_failed");
        failed.extend(new_failed.iter().map(|c| c.key.clone()));
        checks_news = true;
    }
    if wants("checks_passed") && pr.passed() && !passed {
        found.push("checks_passed");
        passed = true;
        checks_news = true;
    }
    if checks_news {
        (told.head, told.failed, told.passed) = (Some(pr.head.clone()), failed, passed);
    }
    let new_remarks: Vec<&Remark> = pr.remarks.iter().filter(|r| !quiet.remarks.contains(&r.id)).collect();
    if wants("comments") && !new_remarks.is_empty() {
        found.push("comments");
        told.remarks.extend(new_remarks.iter().map(|r| r.id.clone()));
        trim(&mut told.remarks);
    }
    if wants("conflicts") && conflicting == Some(true) && !quiet.conflicting {
        found.push("conflicts");
        told.conflicting = true;
    }
    if pr.state == "merged" || pr.state == "closed" {
        found.push(if pr.state == "merged" { "merged" } else { "closed" });
    }
    if found.is_empty() {
        return (quiet, None);
    }
    let mut report = summary(pr);
    report["events"] = json!(found);
    if found.contains(&"comments") {
        report["comments"] = json!(new_remarks.iter().take(LISTED).map(|r| remark(r)).collect::<Vec<_>>());
        if new_remarks.len() > LISTED {
            report["more_comments"] = json!(new_remarks.len() - LISTED);
        }
    }
    (quiet, Some((report, told)))
}

/// The pull request's state, for the agent.
fn summary(pr: &Pr) -> Value {
    let failed: Vec<Value> = pr
        .checks
        .iter()
        .filter(|c| c.state == CheckState::Failed)
        .map(|c| json!({"name": c.name, "conclusion": c.conclusion, "url": c.url, "required": c.required}))
        .collect();
    let pending: Vec<&str> = pr.checks.iter().filter(|c| c.state == CheckState::Pending).map(|c| c.name.as_str()).collect();
    let outcome = match () {
        _ if pr.checks.is_empty() => "none",
        _ if !failed.is_empty() => "failed",
        _ if pr.passed() => "passed",
        _ => "pending",
    };
    let passed = pr.checks.iter().filter(|c| c.state == CheckState::Passed).count();
    let required = pr.checks.iter().any(|c| c.required);
    json!({
        "url": pr.url,
        "number": pr.number,
        "title": pr.title,
        "state": pr.state,
        "draft": pr.draft,
        "base_branch": pr.base,
        "head": pr.head,
        "mergeable": pr.mergeable,
        "merge_state": pr.merge_state,
        "review_decision": pr.review_decision,
        "checks": {"outcome": outcome, "required_checks": required, "failed": failed, "pending": pending, "passed": passed},
    })
}

/// A comment for the agent, its text trimmed.
fn remark(r: &Remark) -> Value {
    let mut v = json!({"author": r.author, "kind": r.kind, "body": trimmed(&r.body), "url": r.url, "at": r.at});
    if let Some(s) = &r.review_state {
        v["review_state"] = json!(s);
    }
    if let Some(p) = &r.path {
        v["path"] = json!(p);
        v["line"] = json!(r.line);
    }
    v
}

/// A comment's text without HTML comments (bots' metadata), and cut short if it's long.
fn trimmed(body: &str) -> String {
    let mut text = String::new();
    let mut rest = body;
    while let Some(i) = rest.find("<!--") {
        text.push_str(&rest[..i]);
        rest = rest[i..].find("-->").map_or("", |j| &rest[i + j + 3..]);
    }
    text.push_str(rest);
    let text = text.trim();
    match text.char_indices().nth(BODY_MAX) {
        Some((i, _)) => format!("{}… [{} more characters]", &text[..i], text[i..].chars().count()),
        None => text.to_string(),
    }
}

/// What the tool tells the agent about `news` (see `compare`) on its pull request.
pub fn note(news: &Value) -> String {
    let label = news["number"].as_u64().map(|n| format!("#{n}")).unwrap_or_else(|| "The pull request".into());
    let events: Vec<&str> = news["events"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    if events.contains(&"unreadable") {
        let error = news["error"].as_str().unwrap_or("The pull request couldn't be read");
        return format!("{error}. Check it yourself (pr_view), and wait on it again once it can be read.");
    }
    format!("Pull request {label}: {} (see pull_request).", what(news, &events).join("; "))
}

/// What happened, for each of `events` in `news`.
fn what(news: &Value, events: &[&str]) -> Vec<String> {
    let names = |list: &Value| list.as_array().into_iter().flatten().filter_map(|c| c["name"].as_str()).collect::<Vec<_>>().join(", ");
    let mut parts = Vec::new();
    for e in events {
        parts.push(match *e {
            "checks_failed" => format!("checks failed ({})", names(&news["checks"]["failed"])),
            "checks_passed" => format!(
                "all {}checks passed{}",
                if news["checks"]["required_checks"] == true { "required " } else { "" },
                match news["checks"]["pending"].as_array().map_or(0, Vec::len) {
                    0 => String::new(),
                    n => format!(" ({n} other still running)"),
                }
            ),
            "comments" => {
                let list = news["comments"].as_array().map_or(&[][..], Vec::as_slice);
                let n = list.len() + news["more_comments"].as_u64().unwrap_or(0) as usize;
                let mut who: Vec<&str> = Vec::new();
                for a in list.iter().filter_map(|c| c["author"].as_str()) {
                    if !who.contains(&a) {
                        who.push(a);
                    }
                }
                format!("{n} new comment{} or review{} from {}", if n == 1 { "" } else { "s" }, if n == 1 { "" } else { "s" }, who.join(", "))
            }
            "conflicts" => format!("it conflicts with {}", news["base_branch"].as_str().unwrap_or("its base branch")),
            "merged" => "it was merged".into(),
            "closed" => "it was closed".into(),
            other => other.to_string(),
        });
    }
    parts
}

// ---------- watching tasks in review ----------

/// What a project's `watch_pull_requests` can be: its tasks' pull requests aren't watched while
/// they're in review, or failed checks and conflicts wake their agents, or comments and reviews
/// do too.
pub const WATCH_MODES: &[&str] = &["off", "failures", "all"];

/// How often the pull request of a task in review is read, from when the board first sees the
/// task there (so a review or checks just started have a moment).
pub const REVIEW_POLL: Duration = Duration::from_millis(if cfg!(test) { 100 } else { 120_000 });

/// How often the board looks for tasks in review whose pull request is due a read.
const REVIEW_TICK: Duration = Duration::from_secs(15);

/// How many times in a row news of comments alone wakes an agent. After that, comments wait
/// (and go with the next news of checks or a conflict) until the user writes to the agent, so a
/// bot or a reply loop can't keep it working.
pub const COMMENT_WAKES: u32 = 10;

/// The news that wakes an agent in a project that watches its pull requests `mode`.
fn wake_events(mode: &str) -> Vec<String> {
    let events: &[&str] = match mode {
        "all" => &["checks_failed", "conflicts", "comments"],
        "failures" => &["checks_failed", "conflicts"],
        _ => &[],
    };
    events.iter().map(|e| e.to_string()).collect()
}

/// A task in review whose pull request is watched.
struct Watched {
    /// Its pull request, as the task has it.
    url: String,
    /// Made at its first read; None until then.
    watcher: Option<Watcher>,
    /// When it's next read.
    next: Instant,
    /// Reads (or wakes) that failed in a row.
    failures: u32,
}

/// Background loop: while a task is in "In review" with a pull request, in a project that
/// watches them (`Project::watch_pull_requests`), read its pull request every `REVIEW_POLL`, as
/// a wait does (the same query, as the same GitHub account, with the same record of what its
/// agent has been told: what a wait reported isn't news again, and what this reports isn't news
/// to a later wait). News that the project wakes agents for (see `wake_events`), from a read
/// while the agent is idle, goes to the agent in a message (see `wake_message`), all of it
/// together, which starts its turn: the task goes back to "In progress" and, when the agent
/// finishes, to "In review" again. Nothing is read while the agent works or waits, the user
/// has a message queued for it, or the task is being reviewed; it's read at its next turn.
/// Tasks in "Ready for merge" aren't watched: their agent is merging.
///
/// Bots' comments (GitHub Apps') don't wake the agent, nor do its own GitHub account's (which
/// are the user's too when they share it), and comments alone wake it `COMMENT_WAKES` times in
/// a row at most. A merged or closed pull request isn't read again.
pub fn watch_in_review(s: &Shared) {
    let s = s.clone();
    tokio::spawn(async move {
        let mut watched = HashMap::new();
        let mut tick = tokio::time::interval(REVIEW_TICK);
        loop {
            tick.tick().await;
            sweep(&s, &mut watched, Instant::now()).await;
        }
    });
}

/// One look at the tasks in review (`now` being now): read the pull requests that are due, and
/// wake the agents they have news for.
async fn sweep(s: &Shared, watched: &mut HashMap<String, Watched>, now: Instant) {
    // No agent could be woken.
    if !crate::runs::can_run_agents(s) {
        return;
    }
    let tasks = match db::tasks_to_watch(&s.db()) {
        Ok(t) => t,
        Err(e) => return tracing::error!("finding tasks in review to watch: {e:#}"),
    };
    // Those that moved on, or whose pull request changed, start over if they're back.
    watched.retain(|id, w| tasks.iter().any(|(t, _)| &t.id == id && t.pr_url.as_deref() == Some(w.url.as_str())));
    let mut reads = Vec::new();
    for (task, mode) in tasks {
        let url = task.pr_url.clone().unwrap_or_default();
        let w = watched.entry(task.id.clone()).or_insert_with(|| Watched { url, watcher: None, next: now + REVIEW_POLL, failures: 0 });
        if w.next > now || !idle(&task) || s.is_running(&task.id) {
            continue;
        }
        let Some(mut w) = watched.remove(&task.id) else { continue };
        reads.push(async move {
            check(s, &task, &mode, &mut w, now).await;
            (task.id, w)
        });
    }
    for (id, w) in futures::future::join_all(reads).await {
        watched.insert(id, w);
    }
}

/// Whether `t`'s agent is idle, so that news would wake it: not working, waiting or merging,
/// with no message from the user waiting for it and no review in progress.
fn idle(t: &Task) -> bool {
    t.session_id.is_some()
        && !t.running
        && !t.waiting
        && !t.merging
        && t.agent_wait.is_none()
        && t.steering.is_empty()
        && t.queued_message.as_deref().is_none_or(|q| q.trim().is_empty())
        && !t.review.as_ref().is_some_and(|r| r.state == "running")
}

/// Read the pull request of `task` (in review, in a project that watches pull requests `mode`)
/// and wake its agent if there's news for it.
async fn check(s: &Shared, task: &Task, mode: &str, w: &mut Watched, now: Instant) {
    w.next = now + REVIEW_POLL;
    let failed = |w: &mut Watched, e: String| {
        w.failures += 1;
        w.next = now + REVIEW_POLL.saturating_mul(1 << w.failures.min(4)).min(REVIEW_POLL * 10);
        tracing::warn!(task = %task.id, pr = %w.url, failures = w.failures, "watching a pull request in review: {e}");
        if w.failures == GIVE_UP {
            let why = format!("Watching its pull request while the task is in review failed {GIVE_UP} times in a row; still trying");
            s.add_event(&task.id, "warn", why, Some(e));
        }
    };
    if w.watcher.is_none() {
        match watcher_for(s, task, &w.url) {
            Ok(x) => w.watcher = Some(x),
            // Not a pull request it can read: it isn't watched until it changes.
            Err(e) => {
                tracing::info!(task = %task.id, pr = %w.url, "not watching a pull request in review: {e}");
                w.next = now + Duration::from_secs(365 * 24 * 3600);
                return;
            }
        }
    }
    let Some(watcher) = w.watcher.as_mut() else { return };
    let pr = match watcher.read().await {
        Ok(pr) => pr,
        Err(e) => return failed(w, e),
    };
    let key = watcher.target.key();
    if pr.state != "open" {
        w.next = now + Duration::from_secs(365 * 24 * 3600);
    }
    let wake = match news_to_wake(s, &task.id, mode, &key, &pr) {
        Ok(wake) => wake,
        Err(e) => return failed(w, format!("{e:#}")),
    };
    let Some(wake) = wake else {
        w.failures = 0;
        return;
    };
    match crate::runner::send_as(s, &task.id, &wake_message(&wake.news), true) {
        Ok(_) => {
            w.failures = 0;
            let at = crate::util::now();
            told(s, &task.id, &key, &wake.call_id, |row| {
                match wake.comments_only {
                    true => row.comment_wakes += 1,
                    false => (row.comment_wakes, row.comments_paused) = (0, false),
                }
                row.woke_at = Some(at);
            });
        }
        // Started meanwhile, say: the news waits for the next read.
        Err(e) => failed(w, format!("couldn't wake the agent: {}", e.1)),
    }
}

/// The watcher of the pull request `url` of `task`, unless it can't be read as the task's
/// GitHub account.
fn watcher_for(s: &Shared, task: &Task, url: &str) -> Result<Watcher, String> {
    let target = Target::parse(url, None)?;
    let account = crate::runner::task_github_account(s, task).map_err(|e| format!("{e:#}"))?;
    if let Some(a) = account.as_deref().and_then(Account::parse)
        && a.host != target.host
    {
        return Err(format!("it's on {}, but the task's GitHub account {a} is on {}", target.host, a.host));
    }
    Watcher::new(s, task, target).map_err(|e| format!("{e:#}"))
}

/// News to wake an agent with, kept as `call_id`'s until it's sent (see `told`).
struct Wake {
    news: Value,
    call_id: String,
    comments_only: bool,
}

/// What's news in `pr` (the pull request `key`) to wake `task_id`'s agent with, in a project
/// that watches pull requests `mode`, unless the task moved on or its agent started meanwhile.
/// What isn't news is stored as seen now, as for a wait (see `Watcher::poll`).
fn news_to_wake(s: &Shared, task_id: &str, mode: &str, key: &str, pr: &Pr) -> anyhow::Result<Option<Wake>> {
    let c = s.db();
    // Checked under the same lock as the row is written, so a wait can't start in between.
    if !db::get_task(&c, task_id)?.is_some_and(|t| t.status == "in_review" && idle(&t)) {
        return Ok(None);
    }
    let row = load(&c, task_id, key)?;
    let first = row.is_none();
    let mut row = row.unwrap_or_default();
    let mut pr = pr.clone();
    // Bots' comments stay news for a wait. A first read counts them as seen with the rest.
    if !first {
        pr.remarks.retain(|r| !r.bot);
    }
    let (quiet, news) = compare((!first).then_some(&row.seen), &pr, &wake_events(mode));
    (row.seen, row.last, row.polled_at) = (quiet, summary(&pr), crate::util::now());
    // The user writing to the agent lets comments wake it again.
    if row.comment_wakes > 0 && row.woke_at.as_deref().is_some_and(|at| db::user_wrote_since(&c, task_id, at).unwrap_or(false)) {
        (row.comment_wakes, row.comments_paused) = (0, false);
    }
    // Being merged or closed isn't for the agent to deal with.
    let news = news.filter(|_| pr.state == "open");
    let events: Vec<String> = news.iter().flat_map(|(n, _)| n["events"].as_array().cloned().unwrap_or_default()).filter_map(|e| e.as_str().map(String::from)).collect();
    let comments_only = events == ["comments"];
    let (mut wake, mut paused) = (None, false);
    match news {
        // They stay news, for the next wake or a wait.
        Some(_) if comments_only && row.comment_wakes >= COMMENT_WAKES => {
            paused = !row.comments_paused;
            row.comments_paused = true;
        }
        Some((news, told)) => {
            let call_id = format!("in_review:{}", crate::util::new_id());
            row.pending = Some(Pending { call_id: call_id.clone(), told });
            wake = Some(Wake { news, call_id, comments_only });
        }
        None => {}
    }
    store(&c, task_id, key, &row)?;
    drop(c);
    if paused {
        let why = format!(
            "New comments on its pull request woke the agent {COMMENT_WAKES} times in a row, so more won't until you write to it (failed checks and conflicts still do, and bring the comments with them)"
        );
        s.add_event(task_id, "info", why, None);
    }
    Ok(wake)
}

/// The message that wakes an agent with `news` (see `compare`) about its task's pull request.
fn wake_message(news: &Value) -> String {
    let events: Vec<&str> = news["events"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    let label = news["number"].as_u64().map(|n| format!("#{n}")).unwrap_or_else(|| "pull request".into());
    let url = news["url"].as_str().unwrap_or_default();
    let mut text = format!("While this task was in review, its pull request {label} ({url}) had news: {}.", what(news, &events).join("; "));
    if events.contains(&"checks_failed") {
        text.push_str("\n\nFailed checks:");
        for c in news["checks"]["failed"].as_array().into_iter().flatten() {
            let name = c["name"].as_str().unwrap_or("check");
            let conclusion = c["conclusion"].as_str().unwrap_or("failed");
            text.push_str(&format!("\n- {name} ({conclusion})"));
            if let Some(u) = c["url"].as_str() {
                text.push_str(&format!(": {u}"));
            }
        }
    }
    if events.contains(&"conflicts") {
        let base = news["base_branch"].as_str().filter(|b| !b.is_empty()).unwrap_or("its base branch");
        text.push_str(&format!("\n\nIt conflicts with `{base}`: bring the branch up to date with it and resolve the conflicts."));
    }
    if events.contains(&"comments") {
        text.push_str("\n\nNew comments and reviews:");
        for c in news["comments"].as_array().into_iter().flatten() {
            let author = c["author"].as_str().unwrap_or("someone");
            let what = match (c["kind"].as_str(), c["review_state"].as_str()) {
                (Some("review"), Some(state)) => format!("review ({})", state.replace('_', " ")),
                (Some("review_comment"), _) => match (c["path"].as_str(), c["line"].as_u64()) {
                    (Some(p), Some(l)) => format!("review comment on {p}:{l}"),
                    (Some(p), None) => format!("review comment on {p}"),
                    _ => "review comment".into(),
                },
                (Some(kind), _) => kind.replace('_', " "),
                _ => "comment".into(),
            };
            text.push_str(&format!("\n- {author}'s {what}"));
            if let Some(u) = c["url"].as_str() {
                text.push_str(&format!(": {u}"));
            }
            for line in c["body"].as_str().unwrap_or_default().lines() {
                text.push_str(&format!("\n  > {line}"));
            }
        }
        if let Some(n) = news["more_comments"].as_u64() {
            text.push_str(&format!("\n- and {n} more on the pull request"));
        }
    }
    text.push_str(
        "\n\nDeal with this as you would if the user had passed it on: fix what fails or what's asked for and push, and reply on the pull \
         request where that helps. If nothing needs doing, say why. The board sent this because it watches the pull request while the \
         task is in review (the project's settings change that), and it moves the task back to In review when you finish.",
    );
    text
}

// ---------- tests ----------

#[cfg(test)]
type Fake = Box<dyn Fn(Option<&str>, &Target) -> Result<Value, String>>;

#[cfg(test)]
thread_local! {
    /// A fake GitHub for this thread's test: what each read gets, given the account it's read as.
    static FAKE: std::cell::RefCell<Option<Fake>> = const { std::cell::RefCell::new(None) };
}

/// Answer this thread's reads with `f` (given the account and the pull request) rather than GitHub.
#[cfg(test)]
pub fn fake(f: impl Fn(Option<&str>, &Target) -> Result<Value, String> + 'static) {
    FAKE.set(Some(Box::new(f)));
}

/// A query's response for tests: a pull request `number` in `o/r`, open and mergeable, with
/// `checks` (`(name, state, conclusion, required)`), `comments` (`(id, author, body)`), read as
/// `viewer`.
#[cfg(test)]
pub fn response(viewer: &str, head: &str, checks: &[(&str, &str, &str, bool)], comments: &[(&str, &str, &str)]) -> Value {
    let contexts: Vec<Value> = checks
        .iter()
        .enumerate()
        .map(|(i, (name, status, conclusion, required))| {
            json!({"__typename": "CheckRun", "databaseId": format!("{head}{i}"), "name": name, "status": status,
                "conclusion": if conclusion.is_empty() { Value::Null } else { json!(conclusion) },
                "detailsUrl": format!("https://github.com/o/r/actions/runs/{i}"), "isRequired": required})
        })
        .collect();
    let comments: Vec<Value> = comments
        .iter()
        .map(|(id, author, body)| json!({"id": id, "author": {"login": author}, "body": body, "url": format!("https://github.com/o/r/pull/7#{id}"), "createdAt": format!("2026-10-31T00:00:{id}Z")}))
        .collect();
    json!({"data": {"viewer": {"login": viewer}, "repository": {"pullRequest": {
        "url": "https://github.com/o/r/pull/7", "number": 7, "title": "A change", "state": "OPEN", "isDraft": false, "baseRefName": "main",
        "headRefOid": head, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN", "reviewDecision": null,
        "commits": {"nodes": [{"commit": {"statusCheckRollup": {"contexts": {"nodes": contexts}}}}]},
        "comments": {"nodes": comments}, "reviews": {"nodes": []}, "reviewThreads": {"nodes": []}
    }}}})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all() -> Vec<String> {
        EVENTS.iter().map(|e| e.to_string()).collect()
    }

    fn pr(v: Value) -> Pr {
        Pr::parse(&v).unwrap()
    }

    fn events(news: &Option<(Value, Seen)>) -> Vec<String> {
        news.as_ref().map(|(r, _)| r["events"].as_array().unwrap().iter().map(|e| e.as_str().unwrap().to_string()).collect()).unwrap_or_default()
    }

    #[test]
    fn takes_a_number_a_repository_and_number_or_a_url() {
        let repo = ("github.com".to_string(), "o/r".to_string());
        let t = |host: &str, owner: &str, name: &str, number| Target { host: host.into(), owner: owner.into(), name: name.into(), number };
        assert_eq!(Target::parse("12", Some(&repo)), Ok(t("github.com", "o", "r", 12)));
        assert_eq!(Target::parse(" #12 ", Some(&repo)), Ok(t("github.com", "o", "r", 12)));
        assert_eq!(Target::parse("other/thing#3", Some(&repo)), Ok(t("github.com", "other", "thing", 3)));
        assert_eq!(Target::parse("https://github.com/a/b/pull/9/files#diff-1", None), Ok(t("github.com", "a", "b", 9)));
        assert_eq!(Target::parse("https://www.github.com/a/b/pull/9", None), Ok(t("github.com", "a", "b", 9)));
        let ghe = ("acme.ghe.com".to_string(), "o/r".to_string());
        assert_eq!(Target::parse("5", Some(&ghe)), Ok(t("acme.ghe.com", "o", "r", 5)));
        assert_eq!(Target::parse("https://ACME.ghe.com/o/r/pull/5", None).unwrap().label(), "acme.ghe.com/o/r#5");
        assert!(Target::parse("12", None).unwrap_err().contains("give its URL"));
        for bad in ["", "0", "abc", "https://github.com/a/b/issues/9", "https://github.com/a/b/pull/x", "a/b/c#1", "o/r#"] {
            assert!(Target::parse(bad, Some(&repo)).is_err(), "{bad}");
        }
        let w = Request { target: t("acme.ghe.com", "o", "r", 5), events: all() }.stored(None);
        assert_eq!((w.url.as_str(), w.repo.as_str()), ("https://acme.ghe.com/o/r/pull/5", "acme.ghe.com/o/r"));
        assert_eq!(Target::of(&w), Some(t("acme.ghe.com", "o", "r", 5)));
    }

    #[test]
    fn a_first_wait_reports_how_checks_ended_but_not_old_comments() {
        let p = pr(response("bot", "a1", &[("test", "COMPLETED", "FAILURE", false), ("lint", "COMPLETED", "SUCCESS", false)], &[("01", "alice", "old")]));
        let (quiet, news) = compare(None, &p, &all());
        assert_eq!(events(&news), ["checks_failed"]);
        assert_eq!(quiet.remarks, ["01"]);
        let (report, told) = news.unwrap();
        assert_eq!(report["checks"]["failed"][0]["name"], "test");
        assert_eq!(report["checks"]["outcome"], "failed");
        assert_eq!((told.head.as_deref(), told.failed.len()), (Some("a1"), 1));
        // Told, the same failure isn't news again.
        assert!(compare(Some(&told), &p, &all()).1.is_none());
        // Nor are checks that are still running.
        let running = pr(response("bot", "a1", &[("test", "IN_PROGRESS", "", false)], &[]));
        assert!(compare(None, &running, &all()).1.is_none());
    }

    #[test]
    fn checks_pass_once_per_head_and_required_ones_are_enough() {
        let checks = |head| pr(response("bot", head, &[("req", "COMPLETED", "SUCCESS", true), ("slow", "IN_PROGRESS", "", false)], &[]));
        let (_, news) = compare(Some(&Seen::default()), &checks("a1"), &all());
        assert_eq!(events(&news), ["checks_passed"]);
        let (report, told) = news.unwrap();
        assert_eq!(note(&report), "Pull request #7: all required checks passed (1 other still running) (see pull_request).");
        assert!(compare(Some(&told), &checks("a1"), &all()).1.is_none());
        // A new commit's checks are news again.
        assert_eq!(events(&compare(Some(&told), &checks("b2"), &all()).1), ["checks_passed"]);
        // Without required checks, all of them have to pass.
        let p = pr(response("bot", "a1", &[("a", "COMPLETED", "SUCCESS", false), ("b", "QUEUED", "", false)], &[]));
        assert!(compare(Some(&Seen::default()), &p, &all()).1.is_none());
        // A re-run that fails again is news (a new run).
        let told = Seen { head: Some("a1".into()), failed: vec!["run:a10".into()], ..Default::default() };
        let rerun = pr(response("bot", "a1", &[("x", "COMPLETED", "FAILURE", false)], &[]));
        assert!(compare(Some(&told), &rerun, &all()).1.is_none());
        let mut v = response("bot", "a1", &[("x", "COMPLETED", "FAILURE", false)], &[]);
        v["data"]["repository"]["pullRequest"]["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["contexts"]["nodes"][0]["databaseId"] = json!(99);
        assert_eq!(events(&compare(Some(&told), &pr(v), &all()).1), ["checks_failed"]);
    }

    #[test]
    fn others_comments_and_reviews_are_news_but_not_the_agents_own() {
        let seen = Seen { remarks: vec!["01".into()], ..Default::default() };
        let mut v = response("me", "a1", &[], &[("01", "alice", "old"), ("02", "me", "my reply"), ("03", "bob", "<!-- bot -->Please fix")]);
        let p = &mut v["data"]["repository"]["pullRequest"];
        p["reviews"]["nodes"] = json!([
            {"id": "R1", "author": {"login": "carol"}, "state": "CHANGES_REQUESTED", "body": "", "url": "u", "submittedAt": "2026-10-31T00:01:00Z"},
            {"id": "R2", "author": {"login": "carol"}, "state": "COMMENTED", "body": "", "url": "u", "submittedAt": "2026-10-31T00:01:00Z"},
            {"id": "R3", "author": {"login": "me"}, "state": "PENDING", "body": "draft", "url": "u", "submittedAt": null},
        ]);
        p["reviewThreads"]["nodes"] = json!([{"path": "src/a.rs", "comments": {"nodes": [
            {"id": "T1", "author": {"login": "carol"}, "body": "Off by one", "url": "u", "createdAt": "2026-10-31T00:00:59Z", "path": "src/a.rs", "line": null, "originalLine": 12}
        ]}}]);
        let (quiet, news) = compare(Some(&seen), &pr(v), &all());
        assert_eq!(events(&news), ["comments"]);
        // Its own and a bare review are seen without being news.
        assert_eq!(quiet.remarks, ["01", "02", "R2"]);
        let (report, told) = news.unwrap();
        let comments = report["comments"].as_array().unwrap();
        let ids: Vec<(&str, &str)> = comments.iter().map(|c| (c["author"].as_str().unwrap(), c["kind"].as_str().unwrap())).collect();
        assert_eq!(ids, [("bob", "comment"), ("carol", "review_comment"), ("carol", "review")]);
        assert_eq!(comments[0]["body"], "Please fix");
        assert_eq!((comments[1]["path"].as_str(), comments[1]["line"].as_u64()), (Some("src/a.rs"), Some(12)));
        assert_eq!(comments[2]["review_state"], "changes_requested");
        assert_eq!(note(&report), "Pull request #7: 3 new comments or reviews from bob, carol (see pull_request).");
        assert_eq!(told.remarks, ["01", "02", "R2", "03", "T1", "R1"]);
        // Not wanted, it stays news for a later wait that wants it.
        let (quiet2, none) = compare(Some(&seen), &pr(response("me", "a1", &[], &[("03", "bob", "x")])), &["conflicts".to_string()]);
        assert!(none.is_none() && !quiet2.remarks.contains(&"03".to_string()));
    }

    #[test]
    fn a_conflict_is_news_once_until_it_clears() {
        let with = |m: &str| {
            let mut v = response("me", "a1", &[], &[]);
            v["data"]["repository"]["pullRequest"]["mergeable"] = json!(m);
            pr(v)
        };
        let (_, news) = compare(None, &with("CONFLICTING"), &all());
        assert_eq!(events(&news), ["conflicts"]);
        let told = news.unwrap().1;
        assert!(told.conflicting);
        assert!(compare(Some(&told), &with("CONFLICTING"), &all()).1.is_none());
        // Unknown (after a push) keeps it; mergeable clears it, so a new conflict is news.
        let (quiet, _) = compare(Some(&told), &with("UNKNOWN"), &all());
        assert!(quiet.conflicting);
        let (quiet, _) = compare(Some(&told), &with("MERGEABLE"), &all());
        assert!(!quiet.conflicting);
        assert_eq!(events(&compare(Some(&quiet), &with("CONFLICTING"), &all()).1), ["conflicts"]);
    }

    #[test]
    fn merged_or_closed_always_ends_it() {
        for (state, event) in [("MERGED", "merged"), ("CLOSED", "closed")] {
            let mut v = response("me", "a1", &[], &[]);
            v["data"]["repository"]["pullRequest"]["state"] = json!(state);
            let (_, news) = compare(Some(&Seen::default()), &pr(v), &[]);
            assert_eq!(events(&news), [event]);
            assert_eq!(note(&news.unwrap().0), format!("Pull request #7: it was {event} (see pull_request)."));
        }
    }

    #[test]
    fn reads_githubs_response() {
        // dire-kiwi/huntaway#2 as GitHub had it, with a commit status added.
        let v: Value = serde_json::from_str(
            r#"{"data":{"viewer":{"login":"imeredith"},"repository":{"pullRequest":{
              "url":"https://github.com/dire-kiwi/huntaway/pull/2","number":2,"title":"One prompt, several agents","state":"MERGED",
              "isDraft":false,"baseRefName":"master","headRefOid":"efcf49d5e5b97253016fb1fb7775829dd6e38f71","mergeable":"UNKNOWN",
              "mergeStateStatus":"UNKNOWN","reviewDecision":null,"commits":{"nodes":[{"commit":{"statusCheckRollup":{"contexts":{"nodes":[
                {"__typename":"CheckRun","databaseId":123802950792,"name":"server","status":"COMPLETED","conclusion":"SUCCESS",
                 "detailsUrl":"https://github.com/dire-kiwi/huntaway/actions/runs/40975665970/job/123802950792","isRequired":false,
                 "checkSuite":{"workflowRun":{"workflow":{"name":"Tests"}}}},
                {"__typename":"CheckRun","databaseId":123802951119,"name":"app","status":"COMPLETED","conclusion":"SUCCESS",
                 "detailsUrl":"https://github.com/dire-kiwi/huntaway/actions/runs/40975665970/job/123802951119","isRequired":false,
                 "checkSuite":{"workflowRun":{"workflow":{"name":"Tests"}}}},
                {"__typename":"StatusContext","context":"Vercel","state":"PENDING","targetUrl":"https://vercel.com/x",
                 "createdAt":"2026-10-30T20:00:00Z","isRequired":false}
              ]}}}}]},"comments":{"nodes":[]},"reviews":{"nodes":[]},"reviewThreads":{"nodes":[]}}}}}"#,
        )
        .unwrap();
        let p = pr(v);
        let checks: Vec<(&str, CheckState, &str)> = p.checks.iter().map(|c| (c.name.as_str(), c.state, c.key.as_str())).collect();
        assert_eq!(checks, [
            ("Tests / server", CheckState::Passed, "run:123802950792"),
            ("Tests / app", CheckState::Passed, "run:123802951119"),
            ("Vercel", CheckState::Pending, "status:Vercel:2026-10-30T20:00:00Z"),
        ]);
        let s = summary(&p);
        assert_eq!((s["state"].as_str(), s["mergeable"].as_str(), s["checks"]["outcome"].as_str()), (Some("merged"), Some("unknown"), Some("pending")));
        assert_eq!(s["checks"]["pending"], json!(["Vercel"]));
        assert_eq!(events(&compare(None, &p, &all()).1), ["merged"]);
    }

    #[test]
    fn a_missing_pull_request_is_an_error() {
        let not_found = json!({"type": "NOT_FOUND", "message": "Could not resolve to a Repository with the name 'o/r'."});
        let v = json!({"data": {"viewer": {"login": "me"}, "repository": null}, "errors": [not_found]});
        assert_eq!(Pr::parse(&v).unwrap_err(), "Could not resolve to a Repository with the name 'o/r'.");
        // Fields it isn't allowed to read don't make it one.
        let mut v = response("me", "a1", &[], &[]);
        v["errors"] = json!([{"message": "Resource not accessible by integration"}]);
        assert!(Pr::parse(&v).is_ok());
    }

    #[test]
    fn long_comments_and_bots_metadata_are_trimmed() {
        assert_eq!(trimmed("<!-- a -->Hi<!-- b --> there <!-- unclosed"), "Hi there");
        let long = "é".repeat(BODY_MAX + 5);
        assert_eq!(trimmed(&long), format!("{}… [5 more characters]", "é".repeat(BODY_MAX)));
    }

    /// A task in review on pull request o/r#7, in a project that watches pull requests `mode`,
    /// with a fake GitHub that answers with what `gh` holds.
    fn in_review(s: &Shared, mode: &str) -> (Task, std::rc::Rc<std::cell::RefCell<Value>>) {
        let p = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let np = db::NewProject { id: "pr", profile_id: &p.id, name: "P", key: "P", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
        db::insert_project(&s.db(), np).unwrap();
        db::update_project(&s.db(), "pr", &[("watch_pull_requests", json!(mode))]).unwrap();
        let t = db::NewTask { profile_id: &p.id, project_id: Some("pr"), kind: "task", title: "t", description: "", status: "in_review", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let t = db::insert_task(&s.db(), t).unwrap();
        let fields = [("session_id", json!("sess")), ("pr_url", json!("https://github.com/o/r/pull/7"))];
        let t = db::update_task(&s.db(), &t.id, &fields).unwrap().unwrap();
        let gh = std::rc::Rc::new(std::cell::RefCell::new(response("me", "a1", &[], &[])));
        let gh2 = gh.clone();
        fake(move |_, target| {
            assert_eq!(target.label(), "o/r#7");
            Ok(gh2.borrow().clone())
        });
        (t, gh)
    }

    /// Sweep the tasks in review as though `polls` reads' time had gone by since `start`.
    async fn sweep_at(s: &Shared, watched: &mut HashMap<String, Watched>, start: Instant, polls: u32) {
        sweep(s, watched, start + REVIEW_POLL * polls).await;
    }

    /// The messages the board sent the agent of `id` to wake it.
    fn wakes(s: &Shared, id: &str) -> Vec<String> {
        let c = s.db();
        let mut st = c.prepare("SELECT data FROM messages WHERE task_id=?1 AND kind='user' ORDER BY id").unwrap();
        let rows = st.query_map([id], |r| r.get::<_, String>(0)).unwrap();
        rows.map(|d| serde_json::from_str::<Value>(&d.unwrap()).unwrap()).filter(|m| m["auto"] == true).map(|m| m["text"].as_str().unwrap().to_string()).collect()
    }

    /// Once the run a wake started is over (it can't launch in a test), the task is back in review.
    async fn settle(s: &Shared, id: &str) {
        for _ in 0..250 {
            if !s.is_running(id) && !db::get_task(&s.db(), id).unwrap().unwrap().running {
                db::update_task(&s.db(), id, &[("status", json!("in_review")), ("attention_reason", Value::Null)]).unwrap();
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("the run didn't end");
    }

    fn set_comments(gh: &std::cell::RefCell<Value>, comments: Value) {
        gh.borrow_mut()["data"]["repository"]["pullRequest"]["comments"]["nodes"] = comments;
    }

    fn comment(id: &str, login: &str, kind: &str, body: &str) -> Value {
        json!({"id": id, "author": {"__typename": kind, "login": login}, "body": body, "url": format!("https://github.com/o/r/pull/7#{id}"), "createdAt": format!("2026-10-31T00:{id}Z")})
    }

    #[test]
    fn a_failure_or_a_comment_on_a_task_in_reviews_pull_request_wakes_its_agent() {
        crate::testing::run(async || {
            crate::runs::TEST_CAN_RUN.set(true);
            let s = crate::testing::state();
            let (t, gh) = in_review(&s, "all");
            set_comments(&gh, json!([comment("01:01", "alice", "User", "From before")]));
            let (start, mut watched) = (Instant::now(), HashMap::new());
            // Not read until it's been in review a while.
            sweep_at(&s, &mut watched, start, 0).await;
            assert!(load(&s.db(), &t.id, "github.com/o/r#7").unwrap().is_none());
            // The first read counts the comments it has as seen.
            sweep_at(&s, &mut watched, start, 1).await;
            assert!(wakes(&s, &t.id).is_empty());
            assert_eq!(load(&s.db(), &t.id, "github.com/o/r#7").unwrap().unwrap().seen.remarks, ["01:01"]);

            // A failed check, a reviewer's comment and a bot's, and its own reply.
            *gh.borrow_mut() = response("me", "b2", &[("Tests / server", "COMPLETED", "FAILURE", true)], &[]);
            set_comments(&gh, json!([
                comment("01:01", "alice", "User", "From before"),
                comment("02:01", "alice", "User", "Why this?\nAnd that?"),
                comment("02:02", "coverage", "Bot", "Coverage went down"),
                comment("02:03", "me", "User", "Fixing it"),
            ]));
            sweep_at(&s, &mut watched, start, 2).await;
            let sent = wakes(&s, &t.id);
            assert_eq!(sent.len(), 1, "{sent:?}");
            assert!(sent[0].starts_with("While this task was in review, its pull request #7 (https://github.com/o/r/pull/7) had news: checks failed (Tests / server); 1 new comment or review from alice."), "{}", sent[0]);
            assert!(sent[0].contains("Failed checks:\n- Tests / server (failure): https://github.com/o/r/actions/runs/0"), "{}", sent[0]);
            assert!(sent[0].contains("- alice's comment: https://github.com/o/r/pull/7#02:01\n  > Why this?\n  > And that?"), "{}", sent[0]);
            assert!(!sent[0].contains("Coverage"), "{}", sent[0]);
            // It's woken: the task's back in progress, with the news told.
            assert_eq!(db::get_task(&s.db(), &t.id).unwrap().unwrap().status, "in_progress");
            let row = load(&s.db(), &t.id, "github.com/o/r#7").unwrap().unwrap();
            assert!(row.pending.is_none());
            assert_eq!((row.seen.head.as_deref(), row.comment_wakes), (Some("b2"), 0));
            assert!(row.seen.remarks.contains(&"02:01".to_string()) && !row.seen.remarks.contains(&"02:02".to_string()));
            // Nothing's read while it works.
            sweep_at(&s, &mut watched, start, 3).await;
            settle(&s, &t.id).await;

            // Back in review, the same news isn't news again, and the bot's comment stays news
            // for a wait.
            sweep_at(&s, &mut watched, start, 4).await;
            assert_eq!(wakes(&s, &t.id).len(), 1);
            let row = load(&s.db(), &t.id, "github.com/o/r#7").unwrap().unwrap();
            let (_, news) = compare(Some(&row.seen), &pr(gh.borrow().clone()), &all());
            assert_eq!(events(&news), ["comments"]);

            // A conflict wakes it.
            gh.borrow_mut()["data"]["repository"]["pullRequest"]["mergeable"] = json!("CONFLICTING");
            sweep_at(&s, &mut watched, start, 5).await;
            let sent = wakes(&s, &t.id);
            assert_eq!(sent.len(), 2);
            assert!(sent[1].contains("had news: it conflicts with main.") && sent[1].contains("It conflicts with `main`"), "{}", sent[1]);
            settle(&s, &t.id).await;
            crate::runs::TEST_CAN_RUN.set(false);
        });
    }

    #[test]
    fn only_failures_wake_it_when_the_project_says_so_and_nothing_does_in_other_columns_or_projects() {
        crate::testing::run(async || {
            crate::runs::TEST_CAN_RUN.set(true);
            let s = crate::testing::state();
            let (t, gh) = in_review(&s, "failures");
            let (start, mut watched) = (Instant::now(), HashMap::new());
            sweep_at(&s, &mut watched, start, 0).await;
            sweep_at(&s, &mut watched, start, 1).await;
            set_comments(&gh, json!([comment("02:01", "alice", "User", "Please rename it")]));
            sweep_at(&s, &mut watched, start, 2).await;
            assert!(wakes(&s, &t.id).is_empty());
            // Still news for a wait.
            let row = load(&s.db(), &t.id, "github.com/o/r#7").unwrap().unwrap();
            assert!(row.seen.remarks.is_empty());

            // Not while a message from the user waits for it, or it's being reviewed, or in another column.
            *gh.borrow_mut() = response("me", "a1", &[("test", "COMPLETED", "FAILURE", false)], &[]);
            db::update_task(&s.db(), &t.id, &[("queued_message", json!("Hold on"))]).unwrap();
            sweep_at(&s, &mut watched, start, 3).await;
            db::update_task(&s.db(), &t.id, &[("queued_message", Value::Null)]).unwrap();
            let review = json!({"thread_id": "r", "state": "running", "head": null, "summary": null, "updated_at": "1"});
            db::update_task(&s.db(), &t.id, &[("review", review)]).unwrap();
            sweep_at(&s, &mut watched, start, 4).await;
            db::update_task(&s.db(), &t.id, &[("review", Value::Null), ("status", json!("ready_for_merge"))]).unwrap();
            sweep_at(&s, &mut watched, start, 5).await;
            assert!(wakes(&s, &t.id).is_empty());
            // Off, nothing's read.
            db::update_task(&s.db(), &t.id, &[("status", json!("in_review"))]).unwrap();
            db::update_project(&s.db(), "pr", &[("watch_pull_requests", json!("off"))]).unwrap();
            for n in 6..9 {
                sweep_at(&s, &mut watched, start, n).await;
            }
            assert!(wakes(&s, &t.id).is_empty());
            // On again, its failed check wakes it.
            db::update_project(&s.db(), "pr", &[("watch_pull_requests", json!("failures"))]).unwrap();
            sweep_at(&s, &mut watched, start, 9).await;
            sweep_at(&s, &mut watched, start, 10).await;
            let sent = wakes(&s, &t.id);
            assert_eq!(sent.len(), 1);
            assert!(sent[0].contains("had news: checks failed (test).") && !sent[0].contains("rename"), "{}", sent[0]);
            settle(&s, &t.id).await;
            crate::runs::TEST_CAN_RUN.set(false);
        });
    }

    #[test]
    fn comments_alone_wake_it_ten_times_in_a_row_until_the_user_writes() {
        crate::testing::run(async || {
            crate::runs::TEST_CAN_RUN.set(true);
            let s = crate::testing::state();
            let (t, gh) = in_review(&s, "all");
            let (start, mut watched) = (Instant::now(), HashMap::new());
            sweep_at(&s, &mut watched, start, 0).await;
            sweep_at(&s, &mut watched, start, 1).await;
            let mut list = Vec::new();
            let mut n = 1;
            let mut another = |gh: &std::cell::RefCell<Value>, n: &mut u32| {
                list.push(comment(&format!("{:02}:00", *n), "alice", "User", &format!("Comment {n}")));
                set_comments(gh, json!(list));
                *n += 1;
            };
            for i in 0..COMMENT_WAKES {
                another(&gh, &mut n);
                sweep_at(&s, &mut watched, start, 2 + 2 * i).await;
                settle(&s, &t.id).await;
            }
            assert_eq!(wakes(&s, &t.id).len(), COMMENT_WAKES as usize);
            // The next one waits, saying why once.
            another(&gh, &mut n);
            sweep_at(&s, &mut watched, start, 30).await;
            sweep_at(&s, &mut watched, start, 31).await;
            assert_eq!(wakes(&s, &t.id).len(), COMMENT_WAKES as usize);
            let said = |s: &Shared| s.db().query_row("SELECT COUNT(*) FROM messages WHERE task_id=?1 AND kind='event' AND data LIKE '%times in a row%'", [&t.id], |r| r.get::<_, i64>(0)).unwrap();
            assert_eq!(said(&s), 1);
            // Once the user writes to the agent, it goes with the next.
            tokio::time::sleep(Duration::from_millis(5)).await;
            db::insert_message(&s.db(), &t.id, "user", &json!({"text": "Thanks, carry on"})).unwrap();
            another(&gh, &mut n);
            sweep_at(&s, &mut watched, start, 32).await;
            let sent = wakes(&s, &t.id);
            assert_eq!(sent.len(), COMMENT_WAKES as usize + 1);
            assert!(sent.last().unwrap().contains("2 new comments or reviews from alice"), "{}", sent.last().unwrap());
            settle(&s, &t.id).await;
            crate::runs::TEST_CAN_RUN.set(false);
        });
    }

    #[test]
    fn a_merged_pull_request_isnt_read_again() {
        crate::testing::run(async || {
            crate::runs::TEST_CAN_RUN.set(true);
            let s = crate::testing::state();
            let (t, gh) = in_review(&s, "all");
            let (start, mut watched) = (Instant::now(), HashMap::new());
            sweep_at(&s, &mut watched, start, 1).await;
            *gh.borrow_mut() = response("me", "a1", &[("test", "COMPLETED", "FAILURE", false)], &[]);
            gh.borrow_mut()["data"]["repository"]["pullRequest"]["state"] = json!("MERGED");
            sweep_at(&s, &mut watched, start, 2).await;
            assert!(wakes(&s, &t.id).is_empty());
            let read_at = load(&s.db(), &t.id, "github.com/o/r#7").unwrap().unwrap().polled_at;
            tokio::time::sleep(Duration::from_millis(5)).await;
            sweep_at(&s, &mut watched, start, 50).await;
            assert_eq!(load(&s.db(), &t.id, "github.com/o/r#7").unwrap().unwrap().polled_at, read_at);
            // A new pull request on the task is watched afresh.
            db::update_task(&s.db(), &t.id, &[("pr_url", json!("https://github.com/o/r/pull/8"))]).unwrap();
            fake(|_, target| {
                assert_eq!(target.label(), "o/r#8");
                Ok(response("me", "c3", &[("test", "COMPLETED", "FAILURE", false)], &[]))
            });
            sweep_at(&s, &mut watched, start, 51).await;
            sweep_at(&s, &mut watched, start, 52).await;
            assert_eq!(wakes(&s, &t.id).len(), 1);
            settle(&s, &t.id).await;
            crate::runs::TEST_CAN_RUN.set(false);
        });
    }

    #[test]
    fn reads_bots_comments() {
        let mut v = response("me", "a1", &[], &[]);
        v["data"]["repository"]["pullRequest"]["comments"]["nodes"] = json!([comment("01:00", "renovate", "Bot", "x"), comment("02:00", "bob", "User", "y")]);
        let bots: Vec<bool> = pr(v).remarks.iter().map(|r| r.bot).collect();
        assert_eq!(bots, [true, false]);
        assert_eq!(wake_events("failures"), ["checks_failed", "conflicts"]);
        assert!(wake_events("off").is_empty());
    }

    #[test]
    fn reads_back_off_after_failures() {
        assert_eq!(backoff(1), POLL * 2);
        assert_eq!(backoff(2), POLL * 4);
        assert_eq!(backoff(9), POLL * 10);
    }
}
