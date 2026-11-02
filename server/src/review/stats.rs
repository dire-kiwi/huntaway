//! What reviewers reported, kept for statistics (`GET /profiles/{id}/token-stats`, see
//! analytics.rs): a row in `review_stats` for each `submit_review`, for the task reviewed, with how
//! many serious and minor issues it listed. A task's `review` only has its latest round.
//!
//! Reviews from before this was kept are read from their threads, where each `submit_review` call
//! is (see `backfill`). They didn't list minor issues: only whether their summary mentions any.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use crate::util::now;

/// What one `submit_review` reported.
pub struct Submission<'a> {
    pub task_id: &'a str,
    pub thread_id: &'a str,
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
    c.execute(
        "INSERT INTO review_stats (task_id, thread_id, run_id, at, verdict, serious, minor, minor_noted, label) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![s.task_id, s.thread_id, s.run_id, at, s.verdict, s.serious as i64, s.minor.map(|n| n as i64), noted, s.label.filter(|l| !l.is_empty())],
    )?;
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
            let input = &b["input"];
            let serious = serious_count(input);
            let minor = minor_list(input).map(|m| m.len());
            let s = Submission {
                task_id: &parent_id,
                thread_id: &thread_id,
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
    fn reviews_are_read_from_their_threads() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let p = crate::db::insert_profile(&s.db(), "p", &[], None).unwrap();
            let new = |kind| crate::db::NewTask { profile_id: &p.id, project_id: None, kind, title: "t", description: "", status: "in_review", use_worktree: false, model: None, effort: None, claude_config_id: None };
            let task = crate::db::insert_task(&s.db(), new("task")).unwrap();
            let thread = crate::db::insert_task(&s.db(), new("review")).unwrap();
            s.update_task(&thread.id, &[("parent_id", json!(task.id))]).unwrap();
            let run = crate::db::insert_run(&s.db(), &thread.id, "review").unwrap();
            let call = |id: &str, input: Value| json!({"type": "assistant", "message": {"content": [
                {"type": "text", "text": "Done."},
                {"type": "tool_use", "id": id, "name": "mcp__huntaway__submit_review", "input": input},
            ]}});
            s.add_message(&thread.id, "claude", call("a", json!({"verdict": "needs_fixes", "summary": "A bug.", "serious_issues": ["x", "y"]}))).unwrap();
            // Refused: the round had ended.
            s.add_message(&thread.id, "claude", call("b", json!({"verdict": "pass", "summary": "Fine."}))).unwrap();
            let refused = json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "b", "is_error": true,
                "content": "the review this run was asked for has ended, so there's nothing to submit"}]}});
            s.add_message(&thread.id, "claude", refused).unwrap();
            s.add_message(&thread.id, "claude", call("c", json!({"verdict": "pass", "summary": "Two minor issues remain.", "serious_issues": []}))).unwrap();
            // The board's tools had another name before the rename (Claude Code and Codex alike).
            let codex = json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "d", "name": "mcp__issue_agent__submit_review",
                "input": {"verdict": "needs_fixes", "summary": "Broken.", "serious_issues": []}}]}});
            s.add_message(&thread.id, "claude", codex).unwrap();

            let c = s.db();
            backfill(&c).unwrap();
            let mut st = c.prepare("SELECT task_id, run_id, verdict, serious, minor, minor_noted FROM review_stats ORDER BY id").unwrap();
            type Row = (String, Option<String>, String, i64, Option<i64>, bool);
            let rows: Vec<Row> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))).unwrap().map(Result::unwrap).collect();
            let r = |verdict: &str, serious, noted| (task.id.clone(), Some(run.id.clone()), verdict.to_string(), serious, None, noted);
            assert_eq!(rows, vec![r("issues", 2, false), r("pass", 0, true), r("issues", 1, false)]);
            // Once only.
            backfill(&c).unwrap();
            assert_eq!(c.query_row("SELECT COUNT(*) FROM review_stats", [], |r| r.get::<_, i64>(0)).unwrap(), 3);
        })
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
