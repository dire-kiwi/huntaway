//! Prompt analytics: when the user prompted which task, and when agents ran, for time tracking.
//!
//! Built from what threads already record (user messages and runs), so it covers history from
//! before it existed. The UI turns the events into active time and calendar views; this only
//! picks them out. Review threads count towards the task they review.

use axum::Json;
use axum::extract::{Path, Query, State};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::state::{ApiError, ApiResult, Shared};

/// The board's own prompt when a task is started, before those messages were marked `start` (see
/// runner::send_run).
const START_TEXT: &str = "Start working on this task.";
/// The board's prompt when the user moves a task to "Ready for merge" (see runner::request_merge).
const MERGE_PREFIX: &str = "The user moved this task to \"Ready for merge\"";
/// Prompts are cut to this many characters; the dashboard only shows a preview.
const TEXT_LIMIT: usize = 280;

#[derive(Serialize, Debug, PartialEq)]
pub struct Event {
    pub at: String,
    pub task_id: String,
    /// `prompt` (typed by the user), `start` (the task was started) or `merge` (moved to
    /// Ready for merge).
    pub kind: &'static str,
    pub text: String,
}

#[derive(Serialize, Debug)]
pub struct Run {
    pub task_id: String,
    /// `prompt`, `compact` or `review`.
    pub kind: String,
    pub started_at: String,
    /// None while the run is going.
    pub ended_at: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct TaskInfo {
    pub id: String,
    pub project_id: Option<String>,
    pub kind: String,
    pub number: i64,
    pub title: String,
    pub status: String,
}

#[derive(Serialize, Debug)]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    pub key: String,
}

#[derive(Serialize, Debug)]
pub struct Report {
    pub events: Vec<Event>,
    pub runs: Vec<Run>,
    /// Every task the events and runs refer to.
    pub tasks: Vec<TaskInfo>,
    pub projects: Vec<ProjectInfo>,
}

#[derive(Deserialize)]
pub struct RangeQuery {
    from: String,
    to: String,
}

fn parse_ts(s: &str, what: &str) -> ApiResult<String> {
    let t: DateTime<Utc> = DateTime::parse_from_rfc3339(s).map_err(|_| ApiError::bad(format!("{what} must be an RFC 3339 time")))?.into();
    // Stored times are all in this form, so they compare as strings.
    Ok(t.to_rfc3339_opts(SecondsFormat::Millis, true))
}

/// `GET /profiles/{id}/analytics?from=&to=`: the profile's activity in `[from, to)`.
pub async fn get(State(s): State<Shared>, Path(profile_id): Path<String>, Query(q): Query<RangeQuery>) -> ApiResult<Json<Report>> {
    let from = parse_ts(&q.from, "from")?;
    let to = parse_ts(&q.to, "to")?;
    Ok(Json(report(&s.db(), &profile_id, &from, &to)?))
}

/// What a user message on a thread counts as, if anything.
fn classify(data: &Value) -> Option<&'static str> {
    if data["from_agent"] == true {
        return None;
    }
    let text = data["text"].as_str().unwrap_or("");
    if data["auto"] != true {
        Some("prompt")
    } else if data["start"] == true || text == START_TEXT {
        Some("start")
    } else if text.starts_with(MERGE_PREFIX) {
        Some("merge")
    } else {
        None
    }
}

fn clip(text: &str) -> String {
    match text.char_indices().nth(TEXT_LIMIT) {
        Some((i, _)) => format!("{}…", text[..i].trim_end()),
        None => text.to_string(),
    }
}

pub fn report(c: &Connection, profile_id: &str, from: &str, to: &str) -> anyhow::Result<Report> {
    // A review thread's activity belongs to the task under review.
    const OWNER: &str = "COALESCE(CASE WHEN t.kind='review' THEN t.parent_id END, t.id)";

    let mut st = c.prepare(&format!(
        "SELECT m.created_at, {OWNER}, m.data FROM messages m JOIN tasks t ON t.id=m.task_id
         WHERE m.kind='user' AND m.created_at >= ?2 AND m.created_at < ?3 AND t.profile_id=?1
         ORDER BY m.created_at"
    ))?;
    let mut events = Vec::new();
    let mut rows = st.query(params![profile_id, from, to])?;
    while let Some(r) = rows.next()? {
        let data: Value = serde_json::from_str(&r.get::<_, String>(2)?).unwrap_or(Value::Null);
        if let Some(kind) = classify(&data) {
            let text = if kind == "prompt" { clip(data["text"].as_str().unwrap_or("")) } else { String::new() };
            events.push(Event { at: r.get(0)?, task_id: r.get(1)?, kind, text });
        }
    }

    let mut st = c.prepare(&format!(
        "SELECT {OWNER}, r.kind, r.created_at, r.ended_at FROM runs r JOIN tasks t ON t.id=r.task_id
         WHERE t.profile_id=?1 AND r.created_at < ?3 AND (r.ended_at IS NULL OR r.ended_at > ?2)
         ORDER BY r.created_at"
    ))?;
    let runs = st
        .query_map(params![profile_id, from, to], |r| {
            Ok(Run { task_id: r.get(0)?, kind: r.get(1)?, started_at: r.get(2)?, ended_at: r.get(3)? })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let ids = events.iter().map(|e| e.task_id.as_str()).chain(runs.iter().map(|r| r.task_id.as_str()));
    let (tasks, projects) = tasks_and_projects(c, profile_id, ids)?;
    Ok(Report { events, runs, tasks, projects })
}

/// The tasks `ids` refer to, and the profile's projects.
fn tasks_and_projects<'a>(c: &Connection, profile_id: &str, ids: impl Iterator<Item = &'a str>) -> anyhow::Result<(Vec<TaskInfo>, Vec<ProjectInfo>)> {
    let mut ids: Vec<&str> = ids.collect();
    ids.sort_unstable();
    ids.dedup();
    let mut tasks = Vec::new();
    let mut st = c.prepare("SELECT id, project_id, kind, number, title, status FROM tasks WHERE id=?1")?;
    for id in ids {
        let mut rows = st.query_map([id], |r| {
            Ok(TaskInfo {
                id: r.get(0)?,
                project_id: r.get(1)?,
                kind: r.get(2)?,
                number: r.get(3)?,
                title: r.get(4)?,
                status: r.get(5)?,
            })
        })?;
        if let Some(t) = rows.next() {
            tasks.push(t?);
        }
    }

    let mut st = c.prepare("SELECT id, name, key FROM projects WHERE profile_id=?1 ORDER BY created_at")?;
    let projects = st
        .query_map([profile_id], |r| Ok(ProjectInfo { id: r.get(0)?, name: r.get(1)?, key: r.get(2)? }))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok((tasks, projects))
}

/// A turn's end or a compaction (see db::SCHEMA_V68).
#[derive(Serialize, Debug)]
pub struct ContextStat {
    pub at: String,
    pub task_id: String,
    /// `turn` or `compact`.
    pub kind: String,
    /// A turn's: the context it left. A compaction's: the context before it.
    pub tokens: Option<i64>,
    /// A compaction's: the context after it, if the agent says.
    pub post_tokens: Option<i64>,
    /// The model's context window, if it was known.
    pub max_tokens: Option<i64>,
    pub model: Option<String>,
    /// A compaction's: `auto` (the agent's own, as its context filled up), `user` (`/compact`)
    /// or `idle` (the board's, after the session sat idle).
    pub source: Option<String>,
    /// A turn's cost, if the agent reports it (Claude Code does).
    pub cost_usd: Option<f64>,
    /// How long a compaction took, if the agent says.
    pub duration_ms: Option<i64>,
}

#[derive(Serialize, Debug)]
pub struct ContextReport {
    pub stats: Vec<ContextStat>,
    pub tasks: Vec<TaskInfo>,
    pub projects: Vec<ProjectInfo>,
}

/// `GET /profiles/{id}/context-stats?from=&to=`: how big the profile's threads' contexts were
/// at the end of each turn in `[from, to)`, and the compactions then.
pub async fn context(State(s): State<Shared>, Path(profile_id): Path<String>, Query(q): Query<RangeQuery>) -> ApiResult<Json<ContextReport>> {
    let from = parse_ts(&q.from, "from")?;
    let to = parse_ts(&q.to, "to")?;
    Ok(Json(context_report(&s.db(), &profile_id, &from, &to)?))
}

pub fn context_report(c: &Connection, profile_id: &str, from: &str, to: &str) -> anyhow::Result<ContextReport> {
    // Review threads count as themselves here: their contexts are their own.
    let mut st = c.prepare(
        "SELECT s.at, s.task_id, s.kind, s.tokens, s.post_tokens, s.max_tokens, s.model, s.source, s.cost_usd, s.duration_ms
         FROM context_stats s JOIN tasks t ON t.id=s.task_id
         WHERE t.profile_id=?1 AND s.at >= ?2 AND s.at < ?3 ORDER BY s.at",
    )?;
    let stats = st
        .query_map(params![profile_id, from, to], |r| {
            Ok(ContextStat {
                at: r.get(0)?,
                task_id: r.get(1)?,
                kind: r.get(2)?,
                tokens: r.get(3)?,
                post_tokens: r.get(4)?,
                max_tokens: r.get(5)?,
                model: r.get(6)?,
                source: r.get(7)?,
                cost_usd: r.get(8)?,
                duration_ms: r.get(9)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let (tasks, projects) = tasks_and_projects(c, profile_id, stats.iter().map(|s| s.task_id.as_str()))?;
    Ok(ContextReport { stats, tasks, projects })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn classifies_user_messages() {
        assert_eq!(classify(&json!({"text": "fix the bug"})), Some("prompt"));
        assert_eq!(classify(&json!({"text": START_TEXT, "auto": true})), Some("start"));
        assert_eq!(classify(&json!({"text": "Plan first.", "auto": true, "start": true})), Some("start"));
        assert_eq!(classify(&json!({"text": format!("{MERGE_PREFIX}. Merge branch `x`"), "auto": true})), Some("merge"));
        assert_eq!(classify(&json!({"text": "Address the review", "auto": true})), None);
        assert_eq!(classify(&json!({"text": "please rebase", "from_agent": true})), None);
    }

    #[test]
    fn clips_long_prompts() {
        assert_eq!(clip("short"), "short");
        let long = "é".repeat(TEXT_LIMIT + 5);
        assert_eq!(clip(&long).chars().count(), TEXT_LIMIT + 1);
    }

    #[test]
    fn reports_a_profiles_activity_in_range() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE projects (id TEXT, profile_id TEXT, name TEXT, key TEXT, created_at TEXT);
             CREATE TABLE tasks (id TEXT, profile_id TEXT, project_id TEXT, kind TEXT, number INTEGER, title TEXT,
               status TEXT, parent_id TEXT);
             CREATE TABLE messages (task_id TEXT, kind TEXT, data TEXT, created_at TEXT);
             CREATE TABLE runs (task_id TEXT, kind TEXT, created_at TEXT, ended_at TEXT);
             INSERT INTO projects VALUES ('p1','me','Proj','PRJ','2026-01-01T00:00:00.000Z');
             INSERT INTO tasks VALUES ('t1','me','p1','task',1,'One','in_review',NULL),
               ('r1','me','p1','review',0,'Review','done','t1'),
               ('x1','other','p9','task',1,'Not mine','todo',NULL);
             INSERT INTO messages VALUES
               ('t1','user','{\"text\":\"Start working on this task.\",\"auto\":true}','2026-10-01T09:00:00.000Z'),
               ('t1','user','{\"text\":\"looks good\"}','2026-10-01T10:00:00.000Z'),
               ('t1','claude','{}','2026-10-01T10:00:01.000Z'),
               ('r1','user','{\"text\":\"why?\"}','2026-10-01T11:00:00.000Z'),
               ('t1','user','{\"text\":\"too late\"}','2026-10-02T00:00:00.000Z'),
               ('x1','user','{\"text\":\"someone else\"}','2026-10-01T10:00:00.000Z');
             INSERT INTO runs VALUES ('t1','prompt','2026-09-30T23:50:00.000Z','2026-10-01T00:10:00.000Z'),
               ('r1','review','2026-10-01T12:00:00.000Z',NULL),
               ('t1','prompt','2026-09-30T20:00:00.000Z','2026-09-30T21:00:00.000Z');",
        )
        .unwrap();
        let r = report(&c, "me", "2026-10-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z").unwrap();
        let ev: Vec<_> = r.events.iter().map(|e| (e.kind, e.task_id.as_str(), e.text.as_str())).collect();
        assert_eq!(ev, vec![("start", "t1", ""), ("prompt", "t1", "looks good"), ("prompt", "t1", "why?")]);
        let runs: Vec<_> = r.runs.iter().map(|r| (r.task_id.as_str(), r.kind.as_str())).collect();
        assert_eq!(runs, vec![("t1", "prompt"), ("t1", "review")]);
        assert_eq!(r.tasks.len(), 1);
        assert_eq!(r.projects.len(), 1);
    }
}
