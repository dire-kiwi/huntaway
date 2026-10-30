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

use std::time::Duration;

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
        let (quiet, news) = compare(row.map(|r| r.seen).as_ref(), &pr, events);
        let pending = news.as_ref().map(|(_, told)| Pending { call_id: call_id.into(), told: told.clone() });
        let row = Row { seen: quiet, pending, last: summary(&pr), polled_at: crate::util::now() };
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
    let key = target.key();
    let r = (|| -> anyhow::Result<()> {
        let c = s.db();
        let Some(mut row) = load(&c, task_id, &key)? else { return Ok(()) };
        if let Some(p) = row.pending.take().filter(|p| p.call_id == call_id) {
            row.seen = p.told;
            store(&c, task_id, &key, &row)?;
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
#[derive(Serialize, Deserialize, Debug)]
struct Row {
    seen: Seen,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending: Option<Pending>,
    /// What the last read found (see `summary`), and when.
    #[serde(default)]
    last: Value,
    #[serde(default)]
    polled_at: String,
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
      comments(last: 50) { nodes { id author { login } body url createdAt } }
      reviews(last: 50) { nodes { id author { login } state body url submittedAt } }
      reviewThreads(first: 100) { nodes { path comments(last: 20) { nodes { id author { login } body url createdAt path line originalLine } } } }
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
        for n in pr["comments"]["nodes"].as_array().into_iter().flatten() {
            remarks.push(Remark {
                id: n["id"].as_str().unwrap_or_default().into(), author: author(n), kind: "comment", review_state: None, path: None, line: None,
                body: n["body"].as_str().unwrap_or_default().into(), url: string(&n["url"]), at: string(&n["createdAt"]),
            });
        }
        for n in pr["reviews"]["nodes"].as_array().into_iter().flatten() {
            // A review being written is its author's own.
            if n["state"] == "PENDING" {
                continue;
            }
            remarks.push(Remark {
                id: n["id"].as_str().unwrap_or_default().into(), author: author(n), kind: "review", review_state: lower(&n["state"]), path: None,
                line: None, body: n["body"].as_str().unwrap_or_default().into(), url: string(&n["url"]), at: string(&n["submittedAt"]),
            });
        }
        for t in pr["reviewThreads"]["nodes"].as_array().into_iter().flatten() {
            for n in t["comments"]["nodes"].as_array().into_iter().flatten() {
                remarks.push(Remark {
                    id: n["id"].as_str().unwrap_or_default().into(), author: author(n), kind: "review_comment", review_state: None,
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
        return format!("{}. Check it yourself (pr_view), and wait on it again once it can be read.", news["error"].as_str().unwrap_or("The pull request couldn't be read"));
    }
    let names = |list: &Value| list.as_array().into_iter().flatten().filter_map(|c| c["name"].as_str()).collect::<Vec<_>>().join(", ");
    let mut parts = Vec::new();
    for e in &events {
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
                let mut who: Vec<&str> = list.iter().filter_map(|c| c["author"].as_str()).collect();
                who.dedup();
                format!("{n} new comment{} or review{} from {}", if n == 1 { "" } else { "s" }, if n == 1 { "" } else { "s" }, who.join(", "))
            }
            "conflicts" => format!("it conflicts with {}", news["base_branch"].as_str().unwrap_or("its base branch")),
            "merged" => "it was merged".into(),
            "closed" => "it was closed".into(),
            other => other.to_string(),
        });
    }
    format!("Pull request {label}: {} (see pull_request).", parts.join("; "))
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
        let v: Value = serde_json::from_str(r#"{"data":{"viewer":{"login":"imeredith"},"repository":{"pullRequest":{"url":"https://github.com/dire-kiwi/huntaway/pull/2","number":2,"title":"One prompt, several agents","state":"MERGED","isDraft":false,"baseRefName":"master","headRefOid":"efcf49d5e5b97253016fb1fb7775829dd6e38f71","mergeable":"UNKNOWN","mergeStateStatus":"UNKNOWN","reviewDecision":null,"commits":{"nodes":[{"commit":{"statusCheckRollup":{"contexts":{"nodes":[
            {"__typename":"CheckRun","databaseId":123802950792,"name":"server","status":"COMPLETED","conclusion":"SUCCESS","detailsUrl":"https://github.com/dire-kiwi/huntaway/actions/runs/40975665970/job/123802950792","isRequired":false,"checkSuite":{"workflowRun":{"workflow":{"name":"Tests"}}}},
            {"__typename":"CheckRun","databaseId":123802951119,"name":"app","status":"COMPLETED","conclusion":"SUCCESS","detailsUrl":"https://github.com/dire-kiwi/huntaway/actions/runs/40975665970/job/123802951119","isRequired":false,"checkSuite":{"workflowRun":{"workflow":{"name":"Tests"}}}},
            {"__typename":"StatusContext","context":"Vercel","state":"PENDING","targetUrl":"https://vercel.com/x","createdAt":"2026-10-30T20:00:00Z","isRequired":false}
        ]}}}}]},"comments":{"nodes":[]},"reviews":{"nodes":[]},"reviewThreads":{"nodes":[]}}}}}"#).unwrap();
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
        let v = json!({"data": {"viewer": {"login": "me"}, "repository": null}, "errors": [{"type": "NOT_FOUND", "message": "Could not resolve to a Repository with the name 'o/r'."}]});
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

    #[test]
    fn reads_back_off_after_failures() {
        assert_eq!(backoff(1), POLL * 2);
        assert_eq!(backoff(2), POLL * 4);
        assert_eq!(backoff(9), POLL * 10);
    }
}
