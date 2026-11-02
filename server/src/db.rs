//! The board's SQLite database: `open` (see schema.rs) creates or migrates it, and the other submodules
//! have the rows and queries of each table. Host-wide settings, and the values task fields can take, are here.

use std::collections::BTreeMap;

use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::util::{new_id, now, path_str};

mod links;
mod messages;
mod profiles;
mod projects;
mod runs;
mod schema;
mod task_data;
mod tasks;

pub use links::*;
pub use messages::*;
pub use profiles::*;
pub use projects::*;
pub use runs::*;
pub use schema::*;
pub use task_data::*;
pub use tasks::*;

#[cfg(test)]
mod tests;

pub const EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];
/// A thread's own effort can also be one only Codex models have (API 25).
pub const THREAD_EFFORTS: &[&str] = &["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/// Host-wide settings (agent defaults).
pub fn get_setting(c: &Connection, key: &str) -> Result<Option<String>> {
    Ok(c.query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get(0)).optional()?)
}

pub fn set_setting(c: &Connection, key: &str, value: Option<&str>) -> Result<()> {
    match value.filter(|v| !v.trim().is_empty()) {
        Some(v) => c.execute("INSERT INTO settings (key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=?2", params![key, v.trim()])?,
        None => c.execute("DELETE FROM settings WHERE key=?1", [key])?,
    };
    Ok(())
}

pub const STATUSES: &[&str] = &["todo", "in_progress", "needs_attention", "in_review", "ready_for_merge", "done", "backlog"];
/// What a task can be besides a code task: `scratch`, for a scratch task (see Task::is_scratch).
pub const TASK_TYPES: &[&str] = &[SCRATCH];
/// The labels a task can have, each a document its agent writes besides its other work (see
/// Task::labels and documents.rs), in the order the task shows them. They were task types of their
/// own before API 71, which still accepts them as a new task's `task_type`.
pub const LABELS: &[&str] = &["plan", "artifact", "diagram"];
/// The task type of a scratch task.
pub const SCRATCH: &str = "scratch";
/// What a new task's type can also be, to make it a subproject (API 51). It's kept as
/// Task::subproject rather than in `task_type`, which is for tasks with no worktree.
pub const SUBPROJECT: &str = "subproject";
/// How a task in "Done" ended. Only done tasks have one (see update_task).
pub const RESOLUTIONS: &[&str] = &["done", "not_done", "wont_fix"];

/// Check a requested resolution for a task that has (or is moving to) `status`. Null asks for
/// the default.
pub fn check_resolution(status: &str, resolution: &Value) -> std::result::Result<(), String> {
    if resolution.is_null() {
        return Ok(());
    }
    if !resolution.as_str().is_some_and(|r| RESOLUTIONS.contains(&r)) {
        return Err(format!("resolution must be null or one of {RESOLUTIONS:?}"));
    }
    if status != "done" {
        return Err("resolution can only be set on a done task".into());
    }
    Ok(())
}

pub const PERMISSION_MODES: &[&str] = &["default", "acceptEdits", "auto", "plan", "dontAsk", "bypassPermissions"];

/// The agent CLIs a config can be for: Claude Code (`claude -p`) and Codex (`codex app-server`,
/// see codex.rs).
pub const AGENTS: &[&str] = &["claude", "codex"];

fn json_list(v: String) -> Vec<String> {
    serde_json::from_str(&v).unwrap_or_default()
}

fn json_or_default<T: serde::de::DeserializeOwned + Default>(v: Option<String>) -> T {
    v.and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default()
}

fn update_generic(c: &Connection, table: &str, allowed: &[&str], id: &str, fields: &[(&str, Value)]) -> Result<()> {
    if fields.is_empty() {
        return Ok(());
    }
    let mut sets = Vec::new();
    let mut vals: Vec<rusqlite::types::Value> = Vec::new();
    for (col, v) in fields {
        anyhow::ensure!(allowed.contains(col), "unknown column {col}");
        sets.push(format!("{col}=?{}", vals.len() + 1));
        vals.push(json_to_sql(v));
    }
    let sql = format!("UPDATE {table} SET {} WHERE id=?{}", sets.join(","), vals.len() + 1);
    vals.push(rusqlite::types::Value::Text(id.to_string()));
    c.execute(&sql, rusqlite::params_from_iter(vals))?;
    Ok(())
}

fn json_to_sql(v: &Value) -> rusqlite::types::Value {
    use rusqlite::types::Value as S;
    match v {
        Value::Null => S::Null,
        Value::Bool(b) => S::Integer(*b as i64),
        Value::Number(n) => n.as_i64().map(S::Integer).unwrap_or_else(|| S::Real(n.as_f64().unwrap_or(0.0))),
        Value::String(s) => S::Text(s.clone()),
        other => S::Text(other.to_string()),
    }
}
