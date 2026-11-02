//! The pull request as a read finds it (`QUERY`, `Pr`), and what in it is news to the agent
//! (`compare`, `note`).

use super::*;

/// The review threads a read gets (100 at a time, the oldest first, so that new ones on a busy pull
/// request are on later pages), with the latest comments of each.
macro_rules! threads {
    ($args:literal) => {
        concat!(
            "reviewThreads(first: 100",
            $args,
            ") { pageInfo { hasNextPage endCursor } nodes { path comments(last: 20) { nodes { id author { __typename login } authorAssociation body url createdAt path line originalLine } } } }"
        )
    };
}

/// A pull request's head commit's checks (see `checks_of`), for a query whose pull request's
/// number is `$number`.
macro_rules! checks {
    () => {
        "commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { databaseId name status conclusion detailsUrl isRequired(pullRequestNumber: $number) checkSuite { workflowRun { workflow { name } } } }
        ... on StatusContext { context state targetUrl createdAt isRequired(pullRequestNumber: $number) }
      } } } } } }"
    };
}

/// The fields of a pull request that `checks_of` reads (with `headRefOid`), for another query
/// (see merged.rs), whose pull request's number is `$number`.
pub const CHECKS: &str = concat!("headRefOid ", checks!());

/// The query a read makes: the pull request's state, its head commit's checks, and its latest
/// comments, reviews and review comments, with who's asking (`viewer`).
pub(super) const QUERY: &str = concat!(
    "query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      url number title state isDraft baseRefName headRefOid mergeable mergeStateStatus reviewDecision
      ",
    checks!(),
    "
      comments(last: 50) { nodes { id author { __typename login } authorAssociation body url createdAt } }
      reviews(last: 50) { nodes { id author { __typename login } authorAssociation state body url submittedAt } }
      ",
    threads!(""),
    "
    }
  }
}"
);

/// The query for the review threads after the first page's (see `Watcher::read_all`).
pub(super) const THREADS: &str = concat!(
    "query($owner: String!, $name: String!, $number: Int!, $after: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      ",
    threads!(", after: $after"),
    "
    }
  }
}"
);

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum CheckState {
    Pending,
    Passed,
    Failed,
}

#[derive(Debug, Clone)]
pub struct Check {
    /// One run of it: a check run's id, or a status's context and time.
    pub(super) key: String,
    pub(super) name: String,
    pub(super) state: CheckState,
    /// How it ended (`failure`, `cancelled`…), or its status while it runs.
    pub(super) conclusion: String,
    pub(super) url: Option<String>,
    required: bool,
    /// The GitHub Actions job it is (a check run's id is its job's), whose log can be read.
    pub(super) job: Option<u64>,
}

/// A comment, review or review comment.
#[derive(Debug, Clone)]
pub(super) struct Remark {
    pub(super) id: String,
    author: Option<String>,
    /// Whether a GitHub App (a bot) wrote it.
    pub(super) bot: bool,
    /// Its author's association with the repository (owner, member, collaborator, contributor,
    /// none…), as GitHub has it.
    association: Option<String>,
    kind: &'static str,
    review_state: Option<String>,
    path: Option<String>,
    line: Option<u64>,
    body: String,
    url: Option<String>,
    at: Option<String>,
}

impl Remark {
    /// Whether its author can push to the repository (its owner, or a member or collaborator):
    /// only their comments wake an agent whose task is in review (see `watch_in_review`).
    pub(super) fn by_maintainer(&self) -> bool {
        matches!(self.association.as_deref(), Some("owner" | "member" | "collaborator"))
    }

    /// A review that only says it commented, whose comments say what it did.
    fn is_bare_review(&self) -> bool {
        self.kind == "review" && self.review_state.as_deref() == Some("commented") && self.body.trim().is_empty()
    }
}

/// A pull request as a read found it.
#[derive(Debug, Clone)]
pub(super) struct Pr {
    viewer: String,
    pub(super) url: String,
    pub(super) number: u64,
    title: String,
    /// open, merged or closed.
    pub(super) state: String,
    draft: bool,
    base: String,
    pub(super) head: String,
    /// mergeable, conflicting or unknown (GitHub hasn't worked it out yet).
    mergeable: String,
    merge_state: Option<String>,
    review_decision: Option<String>,
    pub(super) checks: Vec<Check>,
    pub(super) remarks: Vec<Remark>,
}

fn lower(v: &Value) -> Option<String> {
    v.as_str().map(str::to_ascii_lowercase)
}

fn string(v: &Value) -> Option<String> {
    v.as_str().map(String::from)
}

/// The checks of a pull request read with `CHECKS`.
pub fn checks_of(pr: &Value) -> Vec<Check> {
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
            let job = c["checkSuite"]["workflowRun"].is_object().then(|| id.parse().ok()).flatten();
            checks.push(Check { key: format!("run:{id}"), name, state, conclusion, url: string(&c["detailsUrl"]), required, job });
        } else if c["__typename"] == "StatusContext" {
            let status = lower(&c["state"]).unwrap_or_default();
            let state = match status.as_str() {
                "success" => CheckState::Passed,
                "failure" | "error" => CheckState::Failed,
                _ => CheckState::Pending,
            };
            let name = c["context"].as_str().unwrap_or("status").to_string();
            let key = format!("status:{name}:{}", c["createdAt"].as_str().unwrap_or_default());
            checks.push(Check { key, name, state, conclusion: status, url: string(&c["targetUrl"]), required, job: None });
        }
    }
    checks
}

impl Pr {
    /// From the query's response.
    pub(super) fn parse(v: &Value) -> Result<Self, String> {
        let pr = &v["data"]["repository"]["pullRequest"];
        if !pr.is_object() {
            let errors: Vec<&str> = v["errors"].as_array().into_iter().flatten().filter_map(|e| e["message"].as_str()).collect();
            return Err(if errors.is_empty() { "GitHub didn't return the pull request".into() } else { errors.join("; ") });
        }
        let checks = checks_of(pr);
        let mut remarks = Vec::new();
        let author = |n: &Value| string(&n["author"]["login"]);
        let bot = |n: &Value| n["author"]["__typename"] == "Bot";
        let association = |n: &Value| lower(&n["authorAssociation"]);
        for n in pr["comments"]["nodes"].as_array().into_iter().flatten() {
            remarks.push(Remark {
                id: n["id"].as_str().unwrap_or_default().into(), author: author(n), bot: bot(n), association: association(n), kind: "comment", review_state: None, path: None, line: None,
                body: n["body"].as_str().unwrap_or_default().into(), url: string(&n["url"]), at: string(&n["createdAt"]),
            });
        }
        for n in pr["reviews"]["nodes"].as_array().into_iter().flatten() {
            // A review being written is its author's own.
            if n["state"] == "PENDING" {
                continue;
            }
            remarks.push(Remark {
                id: n["id"].as_str().unwrap_or_default().into(), author: author(n), bot: bot(n), association: association(n), kind: "review", review_state: lower(&n["state"]), path: None,
                line: None, body: n["body"].as_str().unwrap_or_default().into(), url: string(&n["url"]), at: string(&n["submittedAt"]),
            });
        }
        for t in pr["reviewThreads"]["nodes"].as_array().into_iter().flatten() {
            for n in t["comments"]["nodes"].as_array().into_iter().flatten() {
                remarks.push(Remark {
                    id: n["id"].as_str().unwrap_or_default().into(), author: author(n), bot: bot(n), association: association(n), kind: "review_comment", review_state: None,
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

    fn passed(&self) -> bool {
        passed(&self.checks)
    }
}

/// Whether the checks that have to pass did: the required ones, or all of them if none is.
fn passed(checks: &[Check]) -> bool {
    let required: Vec<&Check> = checks.iter().filter(|c| c.required).collect();
    let gate: Vec<&Check> = if required.is_empty() { checks.iter().collect() } else { required };
    !gate.is_empty() && gate.iter().all(|c| c.state == CheckState::Passed)
}

/// How `checks` stand: `none`, `failed` (any of them), `passed` (see `passed`) or `pending`.
pub(super) fn outcome(checks: &[Check]) -> &'static str {
    match () {
        _ if checks.is_empty() => "none",
        _ if checks.iter().any(|c| c.state == CheckState::Failed) => "failed",
        _ if passed(checks) => "passed",
        _ => "pending",
    }
}

/// What's news in `pr` to an agent that was told `seen` (none for its first wait on it), of
/// `events`: what to store as seen meanwhile (its own comments, a conflict that's gone), and the
/// news, if any, with what it will have been told once it gets it.
pub(super) fn compare(seen: Option<&Seen>, pr: &Pr, events: &[String]) -> (Seen, Option<(Value, Seen)>) {
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
    // Over SEEN_MAX, the oldest ids that this read doesn't see go: one it sees would be news again.
    let visible: std::collections::HashSet<&str> = pr.remarks.iter().map(|r| r.id.as_str()).collect();
    let trim = |remarks: &mut Vec<String>| {
        let mut extra = remarks.len().saturating_sub(SEEN_MAX);
        remarks.retain(|id| {
            let drop = extra > 0 && !visible.contains(id.as_str());
            extra -= drop as usize;
            !drop
        });
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
pub(super) fn summary(pr: &Pr) -> Value {
    let failed: Vec<Value> = pr
        .checks
        .iter()
        .filter(|c| c.state == CheckState::Failed)
        .map(|c| json!({"name": c.name, "conclusion": c.conclusion, "url": c.url, "required": c.required}))
        .collect();
    let pending: Vec<&str> = pr.checks.iter().filter(|c| c.state == CheckState::Pending).map(|c| c.name.as_str()).collect();
    let outcome = outcome(&pr.checks);
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
    if let Some(a) = &r.association {
        v["author_association"] = json!(a);
    }
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
pub(super) fn trimmed(body: &str) -> String {
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
pub(super) fn what(news: &Value, events: &[&str]) -> Vec<String> {
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
                // Deleted users' (GitHub's "ghost") comments have no author.
                let who = if who.is_empty() { "someone".to_string() } else { who.join(", ") };
                format!("{n} new comment{} or review{} from {who}", if n == 1 { "" } else { "s" }, if n == 1 { "" } else { "s" })
            }
            "conflicts" => format!("it conflicts with {}", news["base_branch"].as_str().unwrap_or("its base branch")),
            "merged" => "it was merged".into(),
            "closed" => "it was closed".into(),
            other => other.to_string(),
        });
    }
    parts
}
