//! A `wait` on a pull request (`pull_request`, API 62): the wait ends on news about it that the
//! agent hasn't been told yet (`EVENTS`, all of them unless it picks some):
//! - `checks_failed`: a check on its head commit failed (or was cancelled or timed out);
//! - `checks_passed`: all of its head commit's required checks passed (all of its checks, when
//!   none is required);
//! - `comments`: someone other than the agent's own GitHub account commented or reviewed;
//! - `conflicts`: it started to conflict with its base branch;
//! - and, whatever it picked, its being merged or closed.
//!
//! The server reads it with one GraphQL query every `POLL` (and one more for each page of review
//! threads past the first, see `Watcher::read_all`), as the GitHub account the task's gh
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
use crate::mcp::gh_mcp::{Account, GhEnv};
use crate::state::{ApiError, ApiResult, Shared};

mod read;
mod seen;
mod pr;
mod in_review;
mod failed;

pub use read::*;
use seen::*;
pub use pr::*;
pub use in_review::*;
pub use failed::*;

/// What can end a wait on a pull request, besides its being merged or closed.
pub const EVENTS: &[&str] = &["checks_failed", "checks_passed", "comments", "conflicts"];

/// How often a pull request is read.
pub const POLL: Duration = Duration::from_millis(if cfg!(test) { 100 } else { 60_000 });

/// How many failed reads in a row end the wait.
pub const GIVE_UP: u32 = 5;

/// How long a gh call may take.
const GH_TIMEOUT: Duration = Duration::from_secs(60);

/// The most pages of review threads (100 each) a read goes through.
const THREAD_PAGES: usize = 10;

/// The most comments a wait lists, and how much of each one's text.
const LISTED: usize = 20;
const BODY_MAX: usize = 800;

/// How many comment ids are kept as seen (the reads see the latest ones only), besides those the
/// latest read still sees, which are always kept (see `compare`).
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
    pub fn parse(given: &str, default: Option<&(String, String)>) -> Result<Self, String> {
        let given = given.trim();
        let number = |n: &str| {
            // A whole number written as a float (`7.0`, as agents send numbers sometimes) is that number.
            let n = n.split_once('.').filter(|(_, zeros)| !zeros.is_empty() && zeros.bytes().all(|b| b == b'0')).map_or(n, |(whole, _)| whole);
            n.parse::<u64>().ok().filter(|&n| n > 0)
        };
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
                let host = if crate::git::worktree::is_github_com(&host.to_ascii_lowercase()) { "github.com" } else { host };
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
    let account = crate::agent::runner::task_github_account(s, task).map_err(|e| format!("{e:#}"))?;
    if let Some(a) = account.as_deref().and_then(Account::parse)
        && a.host != target.host
    {
        // Its host came from the task's remote, which may name it in a way that isn't GitHub's.
        if !given.trim().starts_with("http") {
            return Err(format!(
                "this task's repository is pushed to {}, but its GitHub account {a} is on {}: give the pull request's URL (https://{}/OWNER/REPO/pull/NUMBER)",
                target.host, a.host, a.host
            ));
        }
        return Err(format!("{} is on {}, but this task's GitHub account {a} is on {}, so it can't be read", target.label(), target.host, a.host));
    }
    Ok(Request { target, events })
}

/// The host and `OWNER/REPO` of the repository `task`'s branch is pushed to, if it has one.
async fn task_repo(s: &Shared, task: &Task) -> Option<(String, String)> {
    let project = db::get_project(&s.db(), task.project_id.as_deref()?).ok().flatten()?;
    let base = crate::git::worktree::remote_base(s, task, &project).await;
    let (host, repo) = crate::git::worktree::push_repo(&crate::util::expand_tilde(&project.repo_path), base.as_deref()).await?;
    Some((if crate::git::worktree::is_github_com(&host) { "github.com".into() } else { host }, repo))
}

// ---------- a fake GitHub, for tests ----------

#[cfg(test)]
type Fake = Box<dyn Fn(Option<&str>, &Target, Option<&str>) -> Result<Value, String>>;

#[cfg(test)]
thread_local! {
    /// A fake GitHub for this thread's test: what each query gets, given the account it's read as
    /// and the cursor a query for more review threads gives.
    static FAKE: std::cell::RefCell<Option<Fake>> = const { std::cell::RefCell::new(None) };
}

/// Answer this thread's reads with `f` (given the account and the pull request) rather than GitHub.
#[cfg(test)]
pub fn fake(f: impl Fn(Option<&str>, &Target) -> Result<Value, String> + 'static) {
    fake_pages(move |account, target, _| f(account, target));
}

/// As `fake`, given the cursor of each query for more review threads too.
#[cfg(test)]
fn fake_pages(f: impl Fn(Option<&str>, &Target, Option<&str>) -> Result<Value, String> + 'static) {
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
mod tests;
