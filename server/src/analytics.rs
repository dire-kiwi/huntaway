//! Prompt analytics: when the user prompted which task, and when agents ran, for time tracking;
//! and the tokens agents used, and what reviews found (`token_report`).
//!
//! Built from what threads already record (user messages and runs), so it covers history from
//! before it existed. The UI turns the events into active time and calendar views; this only
//! picks them out. Review threads count towards the task they review.

use axum::Json;
use axum::extract::{Path, Query, State};
use chrono::{DateTime, SecondsFormat, Utc};
use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, params};
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

/// A turn's end or a compaction (see db::SCHEMA_V69).
#[derive(Serialize, Debug)]
pub struct ContextStat {
    pub at: String,
    pub task_id: String,
    /// `turn` or `compact`.
    pub kind: String,
    /// A turn's: the context it left. A compaction's: the context before it.
    pub tokens: Option<i64>,
    /// A turn's: what its first request to the model held, so a session started afresh starts small.
    pub start_tokens: Option<i64>,
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
        "SELECT s.at, s.task_id, s.kind, s.tokens, s.post_tokens, s.max_tokens, s.model, s.source, s.cost_usd, s.duration_ms, s.start_tokens
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
                start_tokens: r.get(10)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let (tasks, projects) = tasks_and_projects(c, profile_id, stats.iter().map(|s| s.task_id.as_str()))?;
    Ok(ContextReport { stats, tasks, projects })
}

/// What one run used of one model (see agent/tokens.rs), or one model call that isn't a run (see
/// agent/tokens/calls.rs).
#[derive(Serialize, Debug)]
pub struct UsageRow {
    /// Null for a call that isn't a run.
    pub run_id: Option<String>,
    /// A call's that isn't a run (API 100): the rows of a call, one for each model it used, share it.
    pub call_id: Option<String>,
    /// The thread the run was in: a task, or a review or summary thread. A title's task; null for a window's restart.
    pub task_id: Option<String>,
    /// The run's: `prompt`, `compact` or `review`; or the call's: `title` or `window`.
    pub kind: String,
    pub at: String,
    pub model: String,
    /// `claude` or `codex`.
    pub runtime: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub reasoning_tokens: i64,
    /// Claude Code's; Codex doesn't say.
    pub cost_usd: Option<f64>,
    /// A guess: from its cost alone, or scaled to it.
    pub estimated: bool,
}

/// What a reviewer reported (see review/stats.rs).
#[derive(Serialize, Debug)]
pub struct ReviewRow {
    /// The task reviewed.
    pub task_id: String,
    pub thread_id: String,
    pub at: String,
    /// `pass` or `issues`.
    pub verdict: String,
    pub serious: i64,
    /// Null for reviews from before minor issues were listed.
    pub minor: Option<i64>,
    /// It listed minor issues, or its summary mentions some.
    pub minor_noted: bool,
    pub label: Option<String>,
    /// The model the reviewer's run used most, once its tokens are counted.
    pub model: Option<String>,
    /// Which of its task's review rounds it was in, from 1 (see `rounds`).
    pub round: i64,
    /// The effort the reviewed task's agent was set to work at when this was submitted (API 101); null is the agent's own default.
    pub effort: Option<String>,
    /// The model the reviewed task's agent used most in the run before this review (API 101), if its tokens are counted.
    pub task_model: Option<String>,
}

/// One round of review of a task: its reviewers' submissions together.
#[derive(Serialize, Debug, PartialEq)]
pub struct RoundRow {
    pub task_id: String,
    /// From 1, in the order the task's rounds started.
    pub round: i64,
    /// When it started.
    pub at: String,
    /// `issues` if a reviewer found serious issues, else `pass`.
    pub verdict: String,
    pub serious: i64,
    /// How many reviewers submitted in it.
    pub reviewers: i64,
}

/// A task created by another's agent.
#[derive(Serialize, Debug)]
pub struct FollowUp {
    pub task_id: String,
    pub created_by: String,
    pub at: String,
}

#[derive(Serialize, Debug)]
pub struct UsageTask {
    #[serde(flatten)]
    pub info: TaskInfo,
    /// A review thread's task, or a subproject task's subproject.
    pub parent_id: Option<String>,
    pub task_type: Option<String>,
    pub subproject: bool,
    pub group_name: Option<String>,
    /// The model its own runs used most (by output), of those counted.
    pub model: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct TokenReport {
    pub usage: Vec<UsageRow>,
    pub reviews: Vec<ReviewRow>,
    /// Every round of review of the tasks `reviews` are for, those outside the range included, so
    /// a task's first round is its first.
    pub rounds: Vec<RoundRow>,
    /// Tasks created by the agents of the tasks in `tasks`.
    pub follow_ups: Vec<FollowUp>,
    /// Every task the rows refer to, the parents of those, and the follow-ups.
    pub tasks: Vec<UsageTask>,
    pub projects: Vec<ProjectInfo>,
    /// The profile's runs that have ended but whose tokens aren't counted yet.
    pub pending: i64,
}

/// `GET /profiles/{id}/token-stats?from=&to=`: the tokens the profile's runs that started in
/// `[from, to)` used, the reviews then and the follow-up tasks their tasks' agents created.
pub async fn tokens(State(s): State<Shared>, Path(profile_id): Path<String>, Query(q): Query<RangeQuery>) -> ApiResult<Json<TokenReport>> {
    let from = parse_ts(&q.from, "from")?;
    let to = parse_ts(&q.to, "to")?;
    let report = tokio::task::spawn_blocking(move || token_report(&s.db(), &profile_id, &from, &to)).await.map_err(|e| anyhow::anyhow!(e))??;
    Ok(Json(report))
}

/// The model a run used most, by output.
const RUN_MODEL: &str = "(SELECT u.model FROM token_usage u WHERE u.run_id=?1 ORDER BY u.output_tokens DESC, u.cost_usd DESC LIMIT 1)";

/// The model task `?1`'s own agent used most in its latest counted run that started before `?2`: the one whose work was reviewed.
const TASK_MODEL: &str = "(SELECT u.model FROM token_usage u WHERE u.run_id=(
    SELECT r.id FROM runs r WHERE r.task_id=?1 AND r.kind='prompt' AND r.created_at < ?2 AND EXISTS (SELECT 1 FROM token_usage x WHERE x.run_id=r.id)
    ORDER BY r.created_at DESC LIMIT 1) ORDER BY u.output_tokens DESC, u.cost_usd DESC LIMIT 1)";

pub fn token_report(c: &Connection, profile_id: &str, from: &str, to: &str) -> anyhow::Result<TokenReport> {
    let mut st = c.prepare(
        "SELECT u.run_id, r.task_id, r.kind, r.created_at, u.model, u.runtime, u.input_tokens, u.output_tokens, u.cache_read_tokens,
           u.cache_write_tokens, u.reasoning_tokens, u.cost_usd, u.estimated
         FROM token_usage u JOIN runs r ON r.id=u.run_id JOIN tasks t ON t.id=r.task_id
         WHERE t.profile_id=?1 AND r.created_at >= ?2 AND r.created_at < ?3 ORDER BY r.created_at",
    )?;
    let mut usage = st
        .query_map(params![profile_id, from, to], |r| {
            Ok(UsageRow {
                run_id: r.get(0)?,
                call_id: None,
                task_id: r.get(1)?,
                kind: r.get(2)?,
                at: r.get(3)?,
                model: r.get(4)?,
                runtime: r.get(5)?,
                input_tokens: r.get(6)?,
                output_tokens: r.get(7)?,
                cache_read_tokens: r.get(8)?,
                cache_write_tokens: r.get(9)?,
                reasoning_tokens: r.get(10)?,
                cost_usd: r.get(11)?,
                estimated: r.get(12)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    usage.extend(call_usage(c, profile_id, from, to)?);
    usage.sort_by(|a, b| a.at.cmp(&b.at));

    let mut st = c.prepare(
        "SELECT s.task_id, s.thread_id, s.at, s.verdict, s.serious, s.minor, s.minor_noted, s.label, s.run_id, s.round, s.effort
         FROM review_stats s JOIN tasks t ON t.id=s.task_id
         WHERE t.profile_id=?1 AND s.at >= ?2 AND s.at < ?3 ORDER BY s.at",
    )?;
    let mut model = c.prepare(&format!("SELECT {RUN_MODEL}"))?;
    let mut task_model = c.prepare(&format!("SELECT {TASK_MODEL}"))?;
    let mut reviews = Vec::new();
    let mut round_of = Vec::new();
    let mut rows = st.query(params![profile_id, from, to])?;
    while let Some(r) = rows.next()? {
        let run_id: Option<String> = r.get(8)?;
        round_of.push(r.get::<_, String>(9)?);
        let model = match &run_id {
            Some(id) => model.query_row([id], |r| r.get(0))?,
            None => None,
        };
        let (task_id, at): (String, String) = (r.get(0)?, r.get(2)?);
        let worked: Option<String> = task_model.query_row(params![task_id, at], |r| r.get(0))?;
        reviews.push(ReviewRow {
            task_id,
            thread_id: r.get(1)?,
            at,
            verdict: r.get(3)?,
            serious: r.get(4)?,
            minor: r.get(5)?,
            minor_noted: r.get(6)?,
            label: r.get(7)?,
            model,
            round: 0,
            effort: r.get(10)?,
            task_model: worked,
        });
    }
    drop(rows);
    let (rounds, numbers) = review_rounds(c, reviews.iter().map(|r| r.task_id.as_str()))?;
    for (r, round) in reviews.iter_mut().zip(&round_of) {
        r.round = numbers.get(&(r.task_id.clone(), round.clone())).copied().unwrap_or(0);
    }

    // The tasks the rows are for, with the tasks their threads review and the subprojects they're in.
    let mut ids: Vec<String> = usage.iter().filter_map(|u| u.task_id.clone()).chain(reviews.iter().flat_map(|r| [r.task_id.clone(), r.thread_id.clone()])).collect();
    let mut seen: std::collections::HashSet<String> = ids.iter().cloned().collect();
    let mut parent = c.prepare("SELECT parent_id FROM tasks WHERE id=?1 AND parent_id IS NOT NULL")?;
    let mut i = 0;
    while i < ids.len() {
        if let Some(p) = parent.query_row([&ids[i]], |r| r.get::<_, String>(0)).optional()? {
            if seen.insert(p.clone()) {
                ids.push(p);
            }
        }
        i += 1;
    }

    let mut st = c.prepare("SELECT id, created_by, created_at FROM tasks WHERE created_by IS NOT NULL AND profile_id=?1")?;
    let follow_ups: Vec<FollowUp> = st
        .query_map([profile_id], |r| Ok(FollowUp { task_id: r.get(0)?, created_by: r.get(1)?, at: r.get(2)? }))?
        .filter(|f| f.as_ref().map_or(true, |f| seen.contains(&f.created_by)))
        .collect::<rusqlite::Result<_>>()?;
    let ids: Vec<&str> = ids.iter().map(String::as_str).chain(follow_ups.iter().map(|f| f.task_id.as_str())).collect();
    let (infos, projects) = tasks_and_projects(c, profile_id, ids.into_iter())?;
    let mut st = c.prepare(
        "SELECT parent_id, task_type, subproject, group_name,
           (SELECT u.model FROM token_usage u JOIN runs r ON r.id=u.run_id WHERE r.task_id=tasks.id
            GROUP BY u.model ORDER BY SUM(u.output_tokens) DESC, SUM(u.cost_usd) DESC LIMIT 1)
         FROM tasks WHERE id=?1",
    )?;
    let mut tasks = Vec::new();
    for info in infos {
        let (parent_id, task_type, subproject, group_name, model) = st.query_row([&info.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?;
        tasks.push(UsageTask { info, parent_id, task_type, subproject, group_name, model });
    }

    let pending = c.query_row(
        "SELECT COUNT(*) FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.profile_id=?1 AND r.status='exited' AND r.usage_at IS NULL",
        [profile_id],
        |r| r.get(0),
    )?;
    Ok(TokenReport { usage, reviews, rounds, follow_ups, tasks, projects, pending })
}

/// The model calls that weren't runs (see agent/tokens/calls.rs) in `[from, to)`: titles of the
/// profile's tasks, and the restarts of the windows of the configs it's the first profile to use
/// (each config's in one profile's report, though several use it; a config none uses, in the first
/// profile's).
fn call_usage(c: &Connection, profile_id: &str, from: &str, to: &str) -> anyhow::Result<Vec<UsageRow>> {
    let mut st = c.prepare(
        "SELECT u.task_id, u.purpose, u.at, u.model, u.runtime, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens,
           u.reasoning_tokens, u.cost_usd, u.call_id
         FROM call_usage u LEFT JOIN tasks t ON t.id=u.task_id
         WHERE u.at >= ?2 AND u.at < ?3 AND (t.profile_id=?1 OR (u.task_id IS NULL AND ?1=COALESCE(
           (SELECT p.id FROM profiles p WHERE EXISTS (SELECT 1 FROM json_each(p.claude_config_ids) j WHERE j.value=u.config_id)
            ORDER BY p.created_at, p.id LIMIT 1),
           (SELECT id FROM profiles ORDER BY created_at, id LIMIT 1))))
         ORDER BY u.at",
    )?;
    let rows = st
        .query_map(params![profile_id, from, to], |r| {
            Ok(UsageRow {
                run_id: None,
                call_id: r.get(11)?,
                task_id: r.get(0)?,
                kind: r.get(1)?,
                at: r.get(2)?,
                model: r.get(3)?,
                runtime: r.get(4)?,
                input_tokens: r.get(5)?,
                output_tokens: r.get(6)?,
                cache_read_tokens: r.get(7)?,
                cache_write_tokens: r.get(8)?,
                reasoning_tokens: r.get(9)?,
                cost_usd: r.get(10)?,
                estimated: false,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Every round of review of `tasks`, and the number of each task's rounds by when they started.
/// A round is its submissions' `round` (see review/stats.rs).
#[allow(clippy::type_complexity)]
fn review_rounds<'a>(c: &Connection, tasks: impl Iterator<Item = &'a str>) -> anyhow::Result<(Vec<RoundRow>, HashMap<(String, String), i64>)> {
    let mut tasks: Vec<&str> = tasks.collect();
    tasks.sort_unstable();
    tasks.dedup();
    let mut st = c.prepare("SELECT round, verdict, serious FROM review_stats WHERE task_id=?1 ORDER BY round")?;
    let (mut rounds, mut numbers) = (Vec::new(), HashMap::new());
    for task in tasks {
        let subs: Vec<(String, String, i64)> = st.query_map([task], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<_>>()?;
        let mut n = 0;
        for (round, verdict, serious) in subs {
            if rounds.last().is_none_or(|r: &RoundRow| r.task_id != task || r.at != round) {
                n += 1;
                rounds.push(RoundRow { task_id: task.to_string(), round: n, at: round.clone(), verdict: "pass".into(), serious: 0, reviewers: 0 });
            }
            let r = rounds.last_mut().unwrap();
            r.reviewers += 1;
            r.serious += serious;
            if verdict == "issues" {
                r.verdict = "issues".into();
            }
            numbers.insert((task.to_string(), round), r.round);
        }
    }
    Ok((rounds, numbers))
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

    #[test]
    fn reports_tokens_reviews_and_follow_ups() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let c = s.db();
            let p = crate::db::insert_profile(&c, "p", &[], None).unwrap();
            let other = crate::db::insert_profile(&c, "o", &[], None).unwrap();
            let new = |profile, kind| crate::db::NewTask { profile_id: profile, project_id: None, kind, title: "t", description: "", status: "in_review", use_worktree: false, model: None, effort: None, claude_config_id: None };
            let sub = crate::db::insert_task(&c, new(&p.id, "task")).unwrap();
            let child = crate::db::insert_task(&c, new(&p.id, "task")).unwrap();
            let thread = crate::db::insert_task(&c, new(&p.id, "review")).unwrap();
            let follow = crate::db::insert_task(&c, new(&p.id, "task")).unwrap();
            let theirs = crate::db::insert_task(&c, new(&other.id, "task")).unwrap();
            c.execute("UPDATE tasks SET subproject=1 WHERE id=?1", [&sub.id]).unwrap();
            c.execute("UPDATE tasks SET parent_id=?1 WHERE id=?2", [&sub.id, &child.id]).unwrap();
            c.execute("UPDATE tasks SET parent_id=?1 WHERE id=?2", [&child.id, &thread.id]).unwrap();
            c.execute("UPDATE tasks SET created_by=?1 WHERE id=?2", [&child.id, &follow.id]).unwrap();
            let run = |task: &str, at: &str, model: &str, out: i64| {
                let r = crate::db::insert_run(&c, task, "prompt").unwrap();
                c.execute("UPDATE runs SET created_at=?1, status='exited', usage_at=?1 WHERE id=?2", [at, &r.id]).unwrap();
                c.execute("INSERT INTO token_usage (run_id, model, runtime, output_tokens, cost_usd) VALUES (?1, ?2, 'claude', ?3, 0.5)", rusqlite::params![r.id, model, out]).unwrap();
                r.id
            };
            run(&child.id, "2026-10-01T01:00:00.000Z", "opus", 100);
            run(&child.id, "2026-10-01T02:00:00.000Z", "haiku", 300);
            run(&child.id, "2026-10-01T03:00:00.000Z", "opus", 250);
            let review_run = run(&thread.id, "2026-10-01T04:00:00.000Z", "gpt", 50);
            run(&child.id, "2026-09-01T00:00:00.000Z", "opus", 1);
            run(&theirs.id, "2026-10-01T01:00:00.000Z", "opus", 1);
            // Ended, not counted yet.
            let r = crate::db::insert_run(&c, &child.id, "prompt").unwrap();
            c.execute("UPDATE runs SET created_at='2026-10-01T05:00:00.000Z', status='exited' WHERE id=?1", [&r.id]).unwrap();
            let sub_ = crate::review::stats::Submission {
                task_id: &child.id, thread_id: &thread.id, round: None, run_id: Some(&review_run), verdict: "issues", serious: 2, minor: Some(1), summary: None, label: Some("Codex · gpt"),
            };
            crate::review::stats::record(&c, &sub_, "2026-10-01T04:30:00.000Z").unwrap();

            let r = token_report(&c, &p.id, "2026-10-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z").unwrap();
            assert_eq!(r.usage.len(), 4);
            assert_eq!(r.pending, 1);
            assert_eq!(r.reviews.len(), 1);
            assert_eq!((r.reviews[0].serious, r.reviews[0].minor, r.reviews[0].model.as_deref()), (2, Some(1), Some("gpt")));
            let ids: Vec<&str> = r.tasks.iter().map(|t| t.info.id.as_str()).collect();
            for t in [&sub, &child, &thread, &follow] {
                assert!(ids.contains(&t.id.as_str()), "{} missing", t.id);
            }
            assert!(!ids.contains(&theirs.id.as_str()));
            assert_eq!(r.follow_ups.iter().map(|f| (f.task_id.as_str(), f.created_by.as_str())).collect::<Vec<_>>(), [(follow.id.as_str(), child.id.as_str())]);
            let task = |id: &str| r.tasks.iter().find(|t| t.info.id == id).unwrap();
            // The model it used most, its earlier runs' included.
            assert_eq!(task(&child.id).model.as_deref(), Some("opus"));
            assert_eq!(task(&child.id).parent_id.as_deref(), Some(sub.id.as_str()));
            assert!(task(&sub.id).subproject);
        })
    }


    #[test]
    fn review_rounds_are_numbered_from_the_tasks_first_whatever_the_range() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let c = s.db();
            let p = crate::db::insert_profile(&c, "p", &[], None).unwrap();
            let new = crate::db::NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "t", description: "", status: "in_review", use_worktree: false, model: None, effort: None, claude_config_id: None };
            let task = crate::db::insert_task(&c, new).unwrap();
            let sub = |thread: &str, round: &str, at: &str, verdict: &str, serious: usize| {
                let s = crate::review::stats::Submission {
                    task_id: &task.id, thread_id: thread, round: Some(round), run_id: None, verdict, serious, minor: Some(0), summary: None, label: Some(thread),
                };
                crate::review::stats::record(&c, &s, at).unwrap();
            };
            // Round 1, the day before: A found issues, B passed.
            sub("A", "2026-10-01T10:00:00.000Z", "2026-10-01T10:05:00.000Z", "issues", 2);
            sub("B", "2026-10-01T10:00:00.000Z", "2026-10-01T10:06:00.000Z", "pass", 0);
            // Round 2.
            sub("A", "2026-10-02T09:00:00.000Z", "2026-10-02T09:05:00.000Z", "pass", 0);
            sub("B", "2026-10-02T09:00:00.000Z", "2026-10-02T09:06:00.000Z", "issues", 1);
            // Round 3: a reviewer added since (another thread); A didn't submit.
            sub("C", "2026-10-02T12:00:00.000Z", "2026-10-02T12:05:00.000Z", "issues", 1);
            // Round 4, a minute after: C didn't submit, and B did. Rounds are kept apart however
            // close they started.
            sub("B", "2026-10-02T12:01:00.000Z", "2026-10-02T12:03:00.000Z", "issues", 1);

            let r = token_report(&c, &p.id, "2026-10-02T00:00:00.000Z", "2026-10-03T00:00:00.000Z").unwrap();
            assert_eq!(r.reviews.iter().map(|v| (v.label.as_deref().unwrap(), v.round)).collect::<Vec<_>>(), [("A", 2), ("B", 2), ("B", 4), ("C", 3)]);
            let rounds: Vec<(i64, &str, i64, i64)> = r.rounds.iter().map(|x| (x.round, x.verdict.as_str(), x.serious, x.reviewers)).collect();
            assert_eq!(rounds, [(1, "issues", 2, 2), (2, "issues", 1, 2), (3, "issues", 1, 1), (4, "issues", 1, 1)]);
        })
    }

}
