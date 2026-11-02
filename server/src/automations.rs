//! Automations: a project's tasks created (or messages sent to one of its tasks) on a schedule or
//! when a webhook is delivered, so recurring work and outside events land on the board by themselves.
//!
//! **Triggers.** An interval (`every_minutes`, from when it's turned on), a time of day on some
//! weekdays in the host's time zone, or a webhook: `POST /api/hooks/<id>/<token>`, which is the
//! one route that doesn't take the board's token. It reaches nothing but its own automation: an
//! unknown id or a wrong token (compared in constant time) is the same 404, the payload only fills
//! in templates (it can't pick the project, the task, the agent config or anything else), and a
//! message goes only to a task in the automation's own project. Deliveries can be checked against
//! a secret (GitHub's `X-Hub-Signature-256`), filtered on their event, action, labels or any other
//! value (GitHub's `ping`, sent when a webhook is added, is ignored unless a filter asks for it),
//! are dropped when their `X-GitHub-Delivery` made a run in the last week, and can be
//! coalesced: those within a window (and with the same key) make one run, from the latest of them.
//! Bodies are at most `MAX_BODY`, and an automation takes at most `RATE_PER_MINUTE` deliveries a minute.
//!
//! **Actions.** Create a task from a template (title, description, type, agent config, model,
//! effort, status, and whether to start it), or send a message to a task. Templates take
//! `{{body.issue.title}}`-style values from a delivery (see `lookup`); in a description or
//! message each one is wrapped in `<untrusted-data>` tags, with a note telling the agent that
//! what's inside is data, not instructions.
//!
//! **Missed runs and restarts.** The scheduler (`tick`, every few seconds) claims a due run by
//! moving the automation's `next_run_at` on, and records it, in one transaction before it does
//! anything, so a restart can't run it twice. There's no backfill: an interval that came due while
//! the server was down runs once, late; a time of day more than `LATE_GRACE` late is skipped (and
//! recorded as missed). A run that was under way when the server stopped is marked as interrupted
//! on the next start, and isn't run again. Coalesced deliveries wait in the database, so they run
//! after a restart.

use std::collections::{HashMap, VecDeque};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Datelike, Local, NaiveTime, TimeZone, Utc, Weekday};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::api::{self, CreateTask};
use crate::db;
use crate::state::{ApiError, ApiResult, Shared};
use crate::util::{new_id, new_token, same_secret};

mod check;
mod delivery;
mod running;
mod handlers;

pub use check::*;
pub use delivery::*;
pub use running::*;
pub use handlers::*;

/// The shortest and longest intervals a schedule can have.
pub const MIN_INTERVAL_MINUTES: u32 = 5;
const MAX_INTERVAL_MINUTES: u32 = 60 * 24 * 31;
/// A time-of-day run this late (the server was down or asleep) is skipped rather than run.
const LATE_GRACE: chrono::TimeDelta = chrono::TimeDelta::minutes(10);
/// How often the scheduler looks for runs that are due.
const TICK: Duration = Duration::from_secs(5);
/// The largest webhook body taken (a bigger one gets a 413).
pub const MAX_BODY: usize = 1 << 20;
/// Deliveries an automation takes a minute; more get a 429.
const RATE_PER_MINUTE: usize = 60;
/// Coalesced runs an automation can have waiting at once.
const MAX_PENDING: i64 = 20;
const MAX_COALESCE_SECONDS: u32 = 3600;
/// How long a delivery's id is kept, so the same delivery sent again is dropped.
const DEDUPE_DAYS: i64 = 7;
const MAX_FILTERS: usize = 16;
/// Each value a template takes from a delivery, and the whole text it makes, are cut to these.
const MAX_VALUE_CHARS: usize = 20_000;
const MAX_TEXT_CHARS: usize = 100_000;
const MAX_TITLE_CHARS: usize = 200;
/// Runs kept per automation: everything from the last DEDUPE_DAYS up to KEEP_RUNS, and at least
/// KEEP_RECENT; payloads only for the latest KEEP_PAYLOADS (for the next test delivery).
const KEEP_RUNS: i64 = 1000;
const KEEP_RECENT: i64 = 50;
const KEEP_PAYLOADS: i64 = 5;
/// Headers a delivery keeps (for templates and filters) leave these out.
const SECRET_HEADERS: &[&str] = &["authorization", "proxy-authorization", "cookie", "x-hub-signature", "x-hub-signature-256"];
const WEEKDAYS: &[&str] = &["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
pub const UNTRUSTED_TAG: &str = "untrusted-data";

// ---------- what an automation is ----------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Trigger {
    /// Every `every_minutes`, from when it's turned on (or its schedule changes).
    Interval { every_minutes: u32 },
    /// At `time` (`HH:MM`, in the host's time zone) on `weekdays` (`mon` … `sun`; none is every day).
    Daily {
        time: String,
        #[serde(default)]
        weekdays: Vec<String>,
    },
    /// Each delivery to its URL that passes its `filters`.
    Webhook {
        #[serde(default)]
        filters: Vec<Filter>,
        /// Deliveries in this many seconds from the first make one run (0: each runs by itself).
        #[serde(default)]
        coalesce_seconds: u32,
        /// With coalescing, only deliveries whose key (a template, e.g. `{{body.issue.number}}`)
        /// is the same go together.
        #[serde(default)]
        coalesce_key: String,
    },
}

/// A condition on a delivery (see `matches`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Filter {
    /// What it looks at, as a template names it (see `lookup`), e.g. `event`, `action`, `labels`
    /// or `body.issue.user.login`.
    pub path: String,
    pub op: FilterOp,
    /// A string, or for `in` and `not_in` a list (or a comma-separated string).
    #[serde(default)]
    pub value: Value,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum FilterOp {
    Equals,
    NotEquals,
    StartsWith,
    Contains,
    In,
    NotIn,
    Exists,
    NotExists,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Action {
    /// A task in the automation's project, from these templates and settings.
    CreateTask {
        title: String,
        #[serde(default)]
        description: String,
        /// One of db::TASK_TYPES, or none for a code task. One of db::LABELS in an action stored
        /// before API 71, which gives the task that label.
        #[serde(default)]
        task_type: Option<String>,
        /// Some of db::LABELS.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        labels: Vec<String>,
        #[serde(default)]
        claude_config_id: Option<String>,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        effort: Option<String>,
        /// `todo` or `backlog` (a started task moves to In progress).
        #[serde(default = "todo")]
        status: String,
        /// Start its agent.
        #[serde(default)]
        start: bool,
    },
    /// A message to a task in the automation's project.
    SendToTask { task_id: String, message: String },
}

fn todo() -> String {
    "todo".into()
}

#[derive(Clone, Debug)]
pub struct Automation {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub enabled: bool,
    pub trigger: Trigger,
    pub action: Action,
    /// The secret part of its webhook URL.
    pub token: String,
    /// Deliveries must be signed with it (`X-Hub-Signature-256`), if set. Never sent back.
    pub secret: Option<String>,
    /// When its schedule next runs (UTC); none for a webhook, or while it's off.
    pub next_run_at: Option<String>,
    pub last_run_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

fn from_json<T: serde::de::DeserializeOwned>(r: &Row, col: &str) -> rusqlite::Result<T> {
    let s: String = r.get(col)?;
    serde_json::from_str(&s).map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))
}

impl Automation {
    fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get("id")?,
            project_id: r.get("project_id")?,
            name: r.get("name")?,
            enabled: r.get("enabled")?,
            trigger: from_json(r, "trigger")?,
            action: from_json(r, "action")?,
            token: r.get("token")?,
            secret: r.get("secret")?,
            next_run_at: r.get("next_run_at")?,
            last_run_at: r.get("last_run_at")?,
            created_at: r.get("created_at")?,
            updated_at: r.get("updated_at")?,
        })
    }

    pub fn is_webhook(&self) -> bool {
        matches!(self.trigger, Trigger::Webhook { .. })
    }

    /// Where deliveries go, on this host.
    pub fn hook_path(&self) -> String {
        format!("/api/hooks/{}/{}", self.id, self.token)
    }
}

/// A run, or a webhook delivery that didn't make one.
#[derive(Serialize, Clone, Debug)]
pub struct Run {
    pub id: String,
    pub automation_id: String,
    /// `schedule`, `webhook` or `manual` (Run now, or a test delivery).
    pub source: String,
    /// `pending` (waiting to coalesce), `coalesced` (into `batch_id`), `running`, `ok`, `failed`,
    /// `skipped` (missed, the automation was off, or too many coalesced runs were waiting), `filtered` (or an ignored ping), `duplicate` or `rejected` (a bad signature).
    pub status: String,
    pub detail: Option<String>,
    /// The task it created or messaged.
    pub task_id: Option<String>,
    pub delivery_id: Option<String>,
    /// A delivery's event, e.g. `issues.opened`.
    pub event: Option<String>,
    /// Deliveries in it (coalesced ones count).
    pub count: i64,
    pub batch_id: Option<String>,
    #[serde(skip)]
    pub batch_key: Option<String>,
    #[serde(skip)]
    pub payload: Option<String>,
    /// When it was due: a scheduled run's time, or when a coalesced one runs.
    pub due_at: Option<String>,
    pub created_at: String,
    pub finished_at: Option<String>,
}

impl Run {
    fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get("id")?,
            automation_id: r.get("automation_id")?,
            source: r.get("source")?,
            status: r.get("status")?,
            detail: r.get("detail")?,
            task_id: r.get("task_id")?,
            delivery_id: r.get("delivery_id")?,
            event: r.get("event")?,
            count: r.get("count")?,
            batch_id: r.get("batch_id")?,
            batch_key: r.get("batch_key")?,
            payload: r.get("payload")?,
            due_at: r.get("due_at")?,
            created_at: r.get("created_at")?,
            finished_at: r.get("finished_at")?,
        })
    }

    fn new(automation_id: &str, source: &str, status: &str, now: DateTime<Utc>) -> Self {
        Self {
            id: new_id(),
            automation_id: automation_id.into(),
            source: source.into(),
            status: status.into(),
            detail: None,
            task_id: None,
            delivery_id: None,
            event: None,
            count: 1,
            batch_id: None,
            batch_key: None,
            payload: None,
            due_at: None,
            created_at: fmt(now),
            finished_at: None,
        }
    }

    fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

/// Times are stored as UTC RFC 3339 with milliseconds (as util::now), so they sort as strings.
fn fmt(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn parse_time(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s).ok().map(|t| t.with_timezone(&Utc))
}

// ---------- the database ----------

pub fn get(c: &Connection, id: &str) -> rusqlite::Result<Option<Automation>> {
    c.query_row("SELECT * FROM automations WHERE id=?1", [id], Automation::from_row).optional()
}

pub fn list(c: &Connection, project_id: &str) -> rusqlite::Result<Vec<Automation>> {
    let mut st = c.prepare("SELECT * FROM automations WHERE project_id=?1 ORDER BY created_at, id")?;
    st.query_map([project_id], Automation::from_row)?.collect()
}

fn insert_run(c: &Connection, r: &Run) -> rusqlite::Result<()> {
    c.execute(
        "INSERT INTO automation_runs (id,automation_id,source,status,detail,task_id,delivery_id,event,count,batch_key,batch_id,payload,due_at,created_at,finished_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
        params![
            r.id, r.automation_id, r.source, r.status, r.detail, r.task_id, r.delivery_id, r.event, r.count, r.batch_key, r.batch_id, r.payload, r.due_at,
            r.created_at, r.finished_at
        ],
    )?;
    Ok(())
}

fn get_run(c: &Connection, id: &str) -> rusqlite::Result<Option<Run>> {
    c.query_row("SELECT * FROM automation_runs WHERE id=?1", [id], Run::from_row).optional()
}

/// An automation's latest runs, newest first.
pub fn runs(c: &Connection, automation_id: &str, limit: i64) -> rusqlite::Result<Vec<Run>> {
    let mut st = c.prepare("SELECT * FROM automation_runs WHERE automation_id=?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2")?;
    st.query_map(params![automation_id, limit], Run::from_row)?.collect()
}

/// Ends a run: what it did, or why it didn't.
fn finish(c: &Connection, run_id: &str, result: &Result<Option<String>, (Option<String>, String)>) -> rusqlite::Result<()> {
    let (status, task, detail) = match result {
        Ok(task) => ("ok", task.clone(), None),
        Err((task, e)) => ("failed", task.clone(), Some(e.clone())),
    };
    c.execute(
        "UPDATE automation_runs SET status=?2, task_id=COALESCE(?3, task_id), detail=?4, finished_at=?5 WHERE id=?1",
        params![run_id, status, task, detail, crate::util::now()],
    )?;
    Ok(())
}

/// Runs left `running` by a server that stopped: they may or may not have made their task, so
/// they aren't run again.
fn mark_interrupted(c: &Connection) -> rusqlite::Result<usize> {
    c.execute(
        "UPDATE automation_runs SET status='failed', finished_at=?1,
           detail='Interrupted: the server stopped while this ran, so it may or may not have taken effect. It is not run again.'
         WHERE status='running'",
        [crate::util::now()],
    )
}

/// Drops old runs (see KEEP_RUNS) and payloads.
fn prune(c: &Connection, now: DateTime<Utc>) -> rusqlite::Result<()> {
    let cutoff = fmt(now - chrono::TimeDelta::days(DEDUPE_DAYS));
    let ids: Vec<String> = c.prepare("SELECT id FROM automations")?.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    for id in ids {
        let newest = "SELECT id FROM automation_runs WHERE automation_id=?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2";
        c.execute(
            &format!("DELETE FROM automation_runs WHERE automation_id=?1 AND status NOT IN ('pending','running') AND id NOT IN ({newest})"),
            params![id, KEEP_RUNS],
        )?;
        c.execute(
            &format!(
                "DELETE FROM automation_runs WHERE automation_id=?1 AND status NOT IN ('pending','running') AND created_at < ?3 AND id NOT IN ({newest})"
            ),
            params![id, KEEP_RECENT, cutoff],
        )?;
        c.execute(
            "UPDATE automation_runs SET payload=NULL WHERE automation_id=?1 AND payload IS NOT NULL AND status NOT IN ('pending','running') AND id NOT IN
               (SELECT id FROM automation_runs WHERE automation_id=?1 AND payload IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT ?2)",
            params![id, KEEP_PAYLOADS],
        )?;
    }
    Ok(())
}

fn changed(s: &Shared, a: &Automation) {
    s.emit(json!({"type": "automations_changed", "project_id": a.project_id, "automation_id": a.id}));
}

#[cfg(test)]
mod tests;
