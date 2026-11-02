//! Agent runs (see runner.rs and runs.rs).

use super::*;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Run {
    pub id: String,
    pub task_id: String,
    /// prompt, or compact (summarising the conversation, see runner::compact)
    pub kind: String,
    /// preparing (worktree setup etc.), running, exited
    pub status: String,
    pub out_offset: i64,
    pub stop_requested: bool,
    pub attention: Option<String>,
    pub result_error: Option<String>,
    pub saw_result: bool,
    /// What the agent has cost so far, as it last reported.
    pub cost_usd: f64,
    /// Its last turn has ended, and no message has started another yet.
    #[serde(default)]
    pub between_turns: bool,
    /// The user message its turn started with (see checkpoints.rs).
    #[serde(default)]
    pub turn_message_id: Option<i64>,
    /// Where its conversation is (see checkpoints::Checkpoint::agent_at).
    #[serde(default)]
    pub agent_at: Option<String>,
    pub created_at: String,
    pub ended_at: Option<String>,
}

impl Run {
    fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get("id")?,
            task_id: r.get("task_id")?,
            kind: r.get("kind")?,
            status: r.get("status")?,
            out_offset: r.get("out_offset")?,
            stop_requested: r.get("stop_requested")?,
            attention: r.get("attention")?,
            result_error: r.get("result_error")?,
            saw_result: r.get("saw_result")?,
            cost_usd: r.get("cost_usd")?,
            between_turns: r.get("between_turns")?,
            turn_message_id: r.get("turn_message_id")?,
            agent_at: r.get("agent_at")?,
            created_at: r.get("created_at")?,
            ended_at: r.get("ended_at")?,
        })
    }
}

pub fn insert_run(c: &Connection, task_id: &str, kind: &str) -> Result<Run> {
    let id = new_id();
    c.execute(
        "INSERT INTO runs (id,task_id,kind,status,created_at) VALUES (?1,?2,?3,'preparing',?4)",
        params![id, task_id, kind, now()],
    )?;
    Ok(get_run(c, &id)?.unwrap())
}

pub fn get_run(c: &Connection, id: &str) -> Result<Option<Run>> {
    Ok(c.query_row("SELECT * FROM runs WHERE id=?1", [id], Run::from_row).optional()?)
}

/// The task's latest run (of `kind`, if given).
pub fn latest_run(c: &Connection, task_id: &str, kind: Option<&str>) -> Result<Option<String>> {
    Ok(c.query_row("SELECT id FROM runs WHERE task_id=?1 AND (?2 IS NULL OR kind=?2) ORDER BY rowid DESC LIMIT 1", rusqlite::params![task_id, kind], |r| r.get(0))
        .optional()?)
}

/// Whether `run_id` is a run of the task started after run `after` (any of its runs if `after` isn't one).
pub fn run_after(c: &Connection, task_id: &str, run_id: &str, after: &str) -> Result<bool> {
    Ok(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM runs WHERE id=?1 AND task_id=?2 AND rowid > COALESCE((SELECT rowid FROM runs WHERE id=?3), -1))",
        [run_id, task_id, after],
        |r| r.get(0),
    )?)
}

/// Whether a run has been started on the task since `run_id` was. The latest run's start and end
/// set the task's running state and column; an earlier run that ends after it must leave them.
pub fn later_run(c: &Connection, task_id: &str, run_id: &str) -> Result<bool> {
    Ok(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM runs WHERE task_id=?1 AND rowid > COALESCE((SELECT rowid FROM runs WHERE id=?2), -1))",
        [task_id, run_id],
        |r| r.get(0),
    )?)
}

/// Whether a run on the task hasn't exited yet.
pub fn has_active_run(c: &Connection, task_id: &str) -> Result<bool> {
    Ok(c.query_row("SELECT EXISTS(SELECT 1 FROM runs WHERE task_id=?1 AND status != 'exited')", [task_id], |r| r.get(0))?)
}

/// Runs that haven't exited, oldest first.
pub fn active_runs(c: &Connection) -> Result<Vec<Run>> {
    let mut st = c.prepare("SELECT * FROM runs WHERE status != 'exited' ORDER BY created_at")?;
    let rows = st.query_map([], Run::from_row)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// Threads to compact because they've been idle since `idle_since`, but not since before
/// `not_before`: their last run was a prompt that ended in that window, and nothing has
/// happened on them since. Finished tasks, merges waiting for their turn, tasks being
/// reviewed and archived projects' threads are left alone.
pub fn idle_sessions(c: &Connection, idle_since: &str, not_before: &str) -> Result<Vec<String>> {
    let mut st = c.prepare(
        "SELECT t.id FROM tasks t JOIN runs r ON r.id = (SELECT id FROM runs WHERE task_id=t.id ORDER BY created_at DESC LIMIT 1)
         WHERE t.session_id IS NOT NULL AND t.running=0 AND t.status != 'done' AND t.last_activity_at <= ?1
           AND NOT (t.merging=1 AND t.status='ready_for_merge')
           AND (t.review IS NULL OR json_extract(t.review, '$.state') != 'running')
           AND (t.project_id IS NULL OR t.project_id NOT IN (SELECT id FROM projects WHERE archived_at IS NOT NULL))
           AND r.kind='prompt' AND r.status='exited' AND r.ended_at <= ?1 AND r.ended_at > ?2",
    )?;
    let rows = st.query_map(params![idle_since, not_before], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}
