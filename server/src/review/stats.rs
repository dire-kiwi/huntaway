//! What reviewers reported, kept for statistics (`GET /profiles/{id}/token-stats`, see
//! analytics.rs): a row in `review_stats` for each `submit_review`, for the task reviewed, with how
//! many serious and minor issues it listed, and the effort the task's agent was set to work at (`task_effort`),
//! so issues can be told by model and effort. A task's `review` only has its latest round.
//!
//! Each row has its review's `round`: when the round started (Review::started_at), which every
//! reviewer's submission in it shares, so a round's outcome is its reviewers' together. A reviewer
//! that submits twice in a run is kept once, with what it submitted last.
//!
//! Reviews from before this was kept are read from their threads, where each `submit_review` call
//! is (see `backfill`). They didn't list minor issues: only whether their summary mentions any. Their
//! rounds are worked out from their reviewers' runs: a round's reviewers start together, so runs
//! started within `ROUND_GAP` of each other are one round's, but for two runs of one reviewer.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use crate::util::now;

/// Reviewer runs of a task started within this many seconds of the one before are one round's.
const ROUND_GAP: i64 = 120;

/// What one `submit_review` reported.
pub struct Submission<'a> {
    pub task_id: &'a str,
    pub thread_id: &'a str,
    /// When its round started.
    pub round: Option<&'a str>,
    pub run_id: Option<&'a str>,
    /// pass or issues
    pub verdict: &'a str,
    pub serious: usize,
    /// None for reviews from before minor issues were listed.
    pub minor: Option<usize>,
    pub summary: Option<&'a str>,
    /// Which agent reviewed, e.g. "Codex · gpt-5.1".
    pub label: Option<&'a str>,
}

pub fn record(c: &Connection, s: &Submission, at: &str) -> rusqlite::Result<()> {
    let noted = s.minor.is_some_and(|n| n > 0) || s.summary.is_some_and(mentions_minor);
    // What the run submitted before: this replaces it.
    if let Some(run_id) = s.run_id {
        c.execute("DELETE FROM review_stats WHERE thread_id=?1 AND run_id=?2", params![s.thread_id, run_id])?;
    }
    let effort = task_effort(c, s.task_id)?;
    c.execute(
        "INSERT INTO review_stats (task_id, thread_id, round, run_id, at, verdict, serious, minor, minor_noted, label, effort) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        params![
            s.task_id,
            s.thread_id,
            s.round.unwrap_or(at),
            s.run_id,
            at,
            s.verdict,
            s.serious as i64,
            s.minor.map(|n| n as i64),
            noted,
            s.label.filter(|l| !l.is_empty()),
            effort
        ],
    )?;
    Ok(())
}

/// The effort a task's agent is set to work at: its own, else the host's default, as a run starts with
/// (see runner/launch.rs). None is the agent's own default.
pub fn task_effort(c: &Connection, task_id: &str) -> rusqlite::Result<Option<String>> {
    let own: Option<String> = c.query_row("SELECT effort FROM tasks WHERE id=?1", [task_id], |r| r.get(0)).optional()?.flatten();
    let effort = match own.filter(|e| !e.trim().is_empty()) {
        Some(e) => Some(e),
        None => c.query_row("SELECT value FROM settings WHERE key='default_effort'", [], |r| r.get::<_, String>(0)).optional()?,
    };
    Ok(effort.map(|e| e.trim().to_string()).filter(|e| !e.is_empty()))
}

/// Give the rows of `review_stats` the effort their task has now (see migration 82).
pub fn backfill_efforts(c: &Connection) -> rusqlite::Result<()> {
    let mut tasks = c.prepare("SELECT DISTINCT task_id FROM review_stats")?;
    let ids: Vec<String> = tasks.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    for id in ids {
        c.execute("UPDATE review_stats SET effort=?2 WHERE task_id=?1", params![id, task_effort(c, &id)?])?;
    }
    Ok(())
}

/// Record a submission made now.
pub fn record_now(c: &Connection, s: &Submission) {
    if let Err(e) = record(c, s, &now()) {
        tracing::warn!(task = s.task_id, "recording a review's outcome: {e:#}");
    }
}

/// Whether a review's summary says it found minor issues: "minor", "nit" or "nitpick", or
/// "suggestion", as words, unless only to say there are none ("no minor issues"): a "no", "any"
/// and the like a few words before it in the same clause.
pub fn mentions_minor(summary: &str) -> bool {
    let lower = summary.to_lowercase();
    lower.split(['.', ',', ';', ':', '!', '?', '\n']).any(|clause| {
        let words: Vec<&str> = clause.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).collect();
        words.iter().enumerate().any(|(i, w)| {
            let minor = matches!(*w, "minor" | "nit" | "nits" | "nitpick" | "nitpicks" | "suggestion" | "suggestions");
            let denied = words[i.saturating_sub(4)..i].iter().any(|p| matches!(*p, "no" | "without" | "nor" | "any" | "zero"));
            minor && !denied
        })
    })
}

/// The serious issues a submission lists, as review::submit counts them.
pub fn serious_count(args: &Value) -> usize {
    let n = match &args["serious_issues"] {
        Value::Array(a) => a.iter().filter_map(|i| i.as_str()).filter(|i| !i.trim().is_empty()).count(),
        Value::String(s) if !s.trim().is_empty() => 1,
        _ => 0,
    };
    // A reviewer that wants fixes but didn't list them described them in its summary.
    if n == 0 && args["verdict"] == "needs_fixes" { 1 } else { n }
}

/// The minor issues a submission lists, if it has the field.
pub fn minor_list(args: &Value) -> Option<Vec<String>> {
    match &args["minor_issues"] {
        Value::Array(a) => Some(a.iter().filter_map(|i| i.as_str()).map(str::trim).filter(|i| !i.is_empty()).map(String::from).collect()),
        Value::String(s) => Some(if s.trim().is_empty() { vec![] } else { vec![s.trim().to_string()] }),
        _ => None,
    }
}

/// Every `submit_review` in review threads (Claude Code's tool calls, and Codex's as the board
/// shows them), but those the board refused (a round that had ended), for the task each reviews.
/// The run is the thread's latest to start before the call, and the reviewer's label the one the
/// task's latest review has for the thread, if it's in it.
pub fn backfill(c: &Connection) -> anyhow::Result<()> {
    let done: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM review_stats)", [], |r| r.get(0))?;
    if done {
        return Ok(());
    }
    let mut st = c.prepare(
        "SELECT m.task_id, t.parent_id, m.created_at, m.data FROM messages m JOIN tasks t ON t.id=m.task_id
         WHERE t.kind='review' AND COALESCE(t.task_type, '') != 'summary' AND t.parent_id IS NOT NULL
           AND m.kind='claude' AND m.data LIKE '%submit_review%'
         ORDER BY m.id",
    )?;
    let rows: Vec<(String, String, String, String)> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?.collect::<rusqlite::Result<_>>()?;
    // The calls the board refused: its answer says so.
    let mut st = c.prepare(
        "SELECT m.task_id, m.data FROM messages m JOIN tasks t ON t.id=m.task_id
         WHERE t.kind='review' AND m.kind='claude' AND m.data LIKE '%nothing to submit%'",
    )?;
    let mut refused = std::collections::HashSet::new();
    for row in st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        let (thread_id, data) = row?;
        let Ok(m) = serde_json::from_str::<Value>(&data) else { continue };
        for id in refusals(&m) {
            refused.insert((thread_id.clone(), id));
        }
    }
    let mut run = c.prepare("SELECT id FROM runs WHERE task_id=?1 AND created_at <= ?2 ORDER BY created_at DESC LIMIT 1")?;
    // Each task's reviewer runs' rounds, worked out once.
    let mut rounds: std::collections::HashMap<String, std::collections::HashMap<String, String>> = Default::default();
    let mut parent_exists = c.prepare("SELECT review FROM tasks WHERE id=?1")?;
    for (thread_id, parent_id, at, data) in rows {
        let Ok(v) = serde_json::from_str::<Value>(&data) else { continue };
        let Some(blocks) = v["message"]["content"].as_array() else { continue };
        for b in blocks.iter().filter(|b| b["type"] == "tool_use" && b["name"].as_str().is_some_and(|n| n.ends_with("submit_review"))) {
            let id = b["id"].as_str().unwrap_or("").to_string();
            if refused.contains(&(thread_id.clone(), id)) {
                continue;
            }
            let Some(review) = parent_exists.query_row([&parent_id], |r| r.get::<_, Option<String>>(0)).optional()? else { continue };
            let label = review
                .and_then(|r| serde_json::from_str::<crate::db::Review>(&r).ok())
                .and_then(|r| r.reviewers.into_iter().find(|p| p.thread_id == thread_id).map(|p| p.label));
            let run_id: Option<String> = run.query_row(params![thread_id, at], |r| r.get(0)).optional()?;
            if !rounds.contains_key(&parent_id) {
                rounds.insert(parent_id.clone(), run_rounds(c, &parent_id)?);
            }
            let round = run_id.as_ref().and_then(|r| rounds[&parent_id].get(r)).cloned();
            let input = &b["input"];
            let serious = serious_count(input);
            let minor = minor_list(input).map(|m| m.len());
            let s = Submission {
                task_id: &parent_id,
                thread_id: &thread_id,
                round: round.as_deref(),
                run_id: run_id.as_deref(),
                verdict: if serious > 0 { "issues" } else { "pass" },
                serious,
                minor,
                summary: input["summary"].as_str(),
                label: label.as_deref(),
            };
            record(c, &s, &at)?;
        }
    }
    Ok(())
}

/// The round reviewer run `run_id` of `task_id` is in, worked out as `backfill` does: for a review
/// started before rounds were kept, which has no start of its own.
pub fn run_round(c: &Connection, task_id: &str, run_id: &str) -> rusqlite::Result<Option<String>> {
    Ok(run_rounds(c, task_id)?.remove(run_id))
}

/// The round each of the runs of `task_id`'s review threads (not its summaries) was in, by when
/// the round started: runs started within `ROUND_GAP` of the one before are in its round, unless
/// their thread has a run in it already (a reviewer runs once a round).
fn run_rounds(c: &Connection, task_id: &str) -> rusqlite::Result<std::collections::HashMap<String, String>> {
    let mut st = c.prepare(
        "SELECT r.id, r.task_id, r.created_at FROM runs r JOIN tasks t ON t.id=r.task_id
         WHERE t.parent_id=?1 AND t.kind='review' AND COALESCE(t.task_type, '') != 'summary' AND r.kind='review'
         ORDER BY r.created_at",
    )?;
    let runs: Vec<(String, String, String)> = st.query_map([task_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<_>>()?;
    let mut out = std::collections::HashMap::new();
    let mut rounds = Rounds::default();
    for (id, thread, at) in runs {
        out.insert(id, rounds.place(&thread, &at).to_string());
    }
    Ok(out)
}

/// Puts reviewers' runs, in the order they started, in rounds (see `run_rounds`).
#[derive(Default)]
struct Rounds {
    start: String,
    last: Option<chrono::DateTime<chrono::FixedOffset>>,
    threads: std::collections::HashSet<String>,
}

impl Rounds {
    /// The start of the round that `thread`'s run starting at `at` is in.
    fn place(&mut self, thread: &str, at: &str) -> &str {
        self.place_new(thread, at).0
    }

    /// The same, and whether it's a new round. One that starts at the round's own start is in it.
    fn place_new(&mut self, thread: &str, at: &str) -> (&str, bool) {
        let t = chrono::DateTime::parse_from_rfc3339(at).ok();
        let near = matches!((self.last, t), (Some(l), Some(t)) if (t - l).num_seconds() <= ROUND_GAP);
        let new = self.start.is_empty() || (at != self.start && (!near || self.threads.contains(thread)));
        if new {
            self.start = at.to_string();
            self.threads.clear();
        }
        self.threads.insert(thread.to_string());
        self.last = t.or(self.last);
        (&self.start, new)
    }
}

/// The tool calls thread message `m` has the board refusing.
fn refusals(m: &Value) -> Vec<String> {
    let blocks = m["message"]["content"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    blocks
        .iter()
        .filter(|b| b["type"] == "tool_result" && b.to_string().contains("nothing to submit"))
        .filter_map(|b| b["tool_use_id"].as_str().map(String::from))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tells_summaries_that_mention_minor_issues() {
        assert!(mentions_minor("One minor issue: the label is cut off."));
        assert!(mentions_minor("Nits: rename `x`."));
        assert!(mentions_minor("A few suggestions, none blocking."));
        assert!(!mentions_minor("No minor issues either."));
        assert!(!mentions_minor("I didn't find any minor problems or nits worth raising, nor any suggestions."));
        assert!(!mentions_minor("Everything checks out; tests pass."));
        assert!(!mentions_minor("Dominoes fell"));
    }

    #[test]
    fn reviews_are_read_from_their_threads_in_rounds() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let p = crate::db::insert_profile(&s.db(), "p", &[], None).unwrap();
            let new = |kind| crate::db::NewTask { profile_id: &p.id, project_id: None, kind, title: "t", description: "", status: "in_review", use_worktree: false, model: None, effort: None, claude_config_id: None };
            let task = crate::db::insert_task(&s.db(), new("task")).unwrap();
            // Two reviewers, each with a thread of its own.
            let threads: Vec<String> = (0..2)
                .map(|_| {
                    let t = crate::db::insert_task(&s.db(), new("review")).unwrap();
                    s.update_task(&t.id, &[("parent_id", json!(task.id))]).unwrap();
                    t.id
                })
                .collect();
            let run = |thread: &str, at: &str| {
                let r = crate::db::insert_run(&s.db(), thread, "review").unwrap();
                s.db().execute("UPDATE runs SET created_at=?1 WHERE id=?2", [at, &r.id]).unwrap();
                r.id
            };
            let say = |thread: &str, at: &str, data: Value| {
                let m = s.add_message(thread, "claude", data).unwrap();
                s.db().execute("UPDATE messages SET created_at=?1 WHERE id=?2", rusqlite::params![at, m.id]).unwrap();
            };
            let call = |id: &str, input: Value| json!({"type": "assistant", "message": {"content": [
                {"type": "text", "text": "Done."},
                {"type": "tool_use", "id": id, "name": "mcp__huntaway__submit_review", "input": input},
            ]}});
            // Round 1: the first reviewer finds issues; the second's call is refused (its round had
            // ended), so it has no submission.
            let a1 = run(&threads[0], "2026-10-01T10:00:00.000Z");
            run(&threads[1], "2026-10-01T10:00:30.000Z");
            say(&threads[0], "2026-10-01T10:05:00.000Z", call("a", json!({"verdict": "needs_fixes", "summary": "A bug.", "serious_issues": ["x", "y"]})));
            say(&threads[1], "2026-10-01T10:06:00.000Z", call("b", json!({"verdict": "pass", "summary": "Fine."})));
            say(&threads[1], "2026-10-01T10:06:01.000Z", json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "b", "is_error": true,
                "content": "the review this run was asked for has ended, so there's nothing to submit"}]}}));
            // Round 2, after the fixes: the first reviewer submits twice (its last counts); the
            // second uses the board's tools' name from before the rename.
            let a2 = run(&threads[0], "2026-10-01T11:00:00.000Z");
            let b2 = run(&threads[1], "2026-10-01T11:00:10.000Z");
            say(&threads[0], "2026-10-01T11:04:00.000Z", call("c", json!({"verdict": "needs_fixes", "summary": "Hmm.", "serious_issues": ["z"]})));
            say(&threads[0], "2026-10-01T11:05:00.000Z", call("d", json!({"verdict": "pass", "summary": "Two minor issues remain.", "serious_issues": []})));
            let old = json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "e", "name": "mcp__issue_agent__submit_review",
                "input": {"verdict": "needs_fixes", "summary": "Broken.", "serious_issues": []}}]}});
            say(&threads[1], "2026-10-01T11:06:00.000Z", old);

            let c = s.db();
            c.execute("DELETE FROM review_stats", []).unwrap();
            backfill(&c).unwrap();
            let mut st = c.prepare("SELECT run_id, round, verdict, serious, minor, minor_noted FROM review_stats ORDER BY at").unwrap();
            type Row = (String, String, String, i64, Option<i64>, bool);
            let rows: Vec<Row> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))).unwrap().map(Result::unwrap).collect();
            let (r1, r2) = ("2026-10-01T10:00:00.000Z".to_string(), "2026-10-01T11:00:00.000Z".to_string());
            assert_eq!(
                rows,
                vec![
                    (a1, r1, "issues".into(), 2, None, false),
                    (a2, r2.clone(), "pass".into(), 0, None, true),
                    (b2, r2, "issues".into(), 1, None, false),
                ]
            );
            // Once only.
            backfill(&c).unwrap();
            assert_eq!(c.query_row("SELECT COUNT(*) FROM review_stats", [], |r| r.get::<_, i64>(0)).unwrap(), 3);
        })
    }

    #[test]
    fn a_reviewer_runs_once_a_round() {
        let mut r = Rounds::default();
        let mut place = |thread: &str, at: &str| r.place_new(thread, at).1;
        // Two reviewers starting together.
        assert!(place("A", "2026-10-01T10:00:00.000Z"));
        assert!(!place("B", "2026-10-01T10:00:20.000Z"));
        // A quick fix: the first reviewer runs again within the gap, in a round of its own.
        assert!(place("A", "2026-10-01T10:01:30.000Z"));
        assert!(!place("B", "2026-10-01T10:01:35.000Z"));
        // A round long after.
        assert!(place("B", "2026-10-01T12:00:00.000Z"));
        // Another submission of a round kept with its start (a reviewer run again in it).
        assert!(!place("B", "2026-10-01T12:00:00.000Z"));
    }

    #[test]
    fn counts_issues_as_submit_does() {
        assert_eq!(serious_count(&json!({"verdict": "pass", "serious_issues": []})), 0);
        assert_eq!(serious_count(&json!({"verdict": "needs_fixes", "serious_issues": ["a", " ", "b"]})), 2);
        assert_eq!(serious_count(&json!({"verdict": "needs_fixes", "serious_issues": []})), 1);
        assert_eq!(serious_count(&json!({"verdict": "needs_fixes", "serious_issues": "one"})), 1);
        assert_eq!(minor_list(&json!({"minor_issues": ["x", ""]})), Some(vec!["x".to_string()]));
        assert_eq!(minor_list(&json!({})), None);
    }
}
