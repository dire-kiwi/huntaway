//! What the agent has been told about each pull request: its task's `pr_watches` rows.

use super::*;

/// What the agent has been told about a pull request.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
pub(super) struct Seen {
    /// The head commit whose checks it was told about.
    #[serde(default)]
    pub(super) head: Option<String>,
    /// That commit's failed checks it was told of (see `Check::key`).
    #[serde(default)]
    pub(super) failed: Vec<String>,
    /// Whether it was told that commit's checks passed.
    #[serde(default)]
    pub(super) passed: bool,
    /// The comments and reviews it has seen (ids), the latest last.
    #[serde(default)]
    pub(super) remarks: Vec<String>,
    /// Whether it was told the pull request conflicts with its base (and it still does).
    #[serde(default)]
    pub(super) conflicting: bool,
}

/// What a call found and hasn't returned yet: what the agent will have been told once it has.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub(super) struct Pending {
    pub(super) call_id: String,
    pub(super) told: Seen,
    /// Whether the failures in an in-review wake's news were sent by hand (see `told_failures`)
    /// before the wake was: it isn't sent then, and the next read works out what's still news.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(super) superseded: bool,
}

/// A `pr_watches` row.
#[derive(Serialize, Deserialize, Debug, Default)]
pub(super) struct Row {
    pub(super) seen: Seen,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) pending: Option<Pending>,
    /// What the last read found (see `summary`), and when.
    #[serde(default)]
    pub(super) last: Value,
    #[serde(default)]
    pub(super) polled_at: String,
    /// How many times in a row news of comments alone woke the agent while its task was in
    /// review (see `watch_in_review`), when it last woke it, and whether comments stopped waking
    /// it after `COMMENT_WAKES` of those.
    #[serde(default)]
    pub(super) comment_wakes: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) woke_at: Option<String>,
    #[serde(default)]
    pub(super) comments_paused: bool,
}

pub(super) fn load(c: &Connection, task_id: &str, key: &str) -> anyhow::Result<Option<Row>> {
    let state: Option<String> =
        c.query_row("SELECT state FROM pr_watches WHERE task_id=?1 AND pr=?2", [task_id, key], |r| r.get(0)).optional()?;
    Ok(state.and_then(|s| serde_json::from_str(&s).ok()))
}

pub(super) fn store(c: &Connection, task_id: &str, key: &str, row: &Row) -> anyhow::Result<()> {
    c.execute(
        "INSERT INTO pr_watches (task_id, pr, state, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(task_id, pr) DO UPDATE SET state=?3, updated_at=?4",
        rusqlite::params![task_id, key, serde_json::to_string(row)?, crate::util::now()],
    )?;
    Ok(())
}
