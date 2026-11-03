//! `huntaway threads-import --db <file>`: a dry run of the history import (see import.rs) over a
//! board's tasks. It opens the database read-only and changes nothing (no import, no migration), so
//! it can run on a copy of a live board (scripts/copy-live-board.sh makes a scrubbed one). It
//! reports how each task's messages convert, the warnings, which tasks couldn't be switched over now
//! (docs/agent-threads-migration.md, "Switch one quiescent task atomically"), and how big the events
//! are.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::Instant;

use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;

use super::import::{self, Conversion, Disposition, Source, Staged};
use super::store::HuntawayStore;
use crate::db;

/// Why a task couldn't be switched over to the new thread layer now.
fn blockers(c: &Connection, task: &db::Task) -> Result<Vec<&'static str>> {
    let mut out = Vec::new();
    if task.running {
        out.push("running");
    }
    // A run's process can be alive between turns.
    if db::has_active_run(c, &task.id)? {
        out.push("active_run");
    }
    if task.queued_message.as_deref().is_some_and(|q| !q.trim().is_empty()) || !task.steering.is_empty() {
        out.push("queued_input");
    }
    if task.merging {
        out.push("merging");
    }
    let prompts: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM permission_requests WHERE task_id=?1 AND status='pending')
         OR EXISTS(SELECT 1 FROM messages WHERE task_id=?1 AND kind='question' AND json_extract(data, '$.status')='pending')",
        [&task.id],
        |r| r.get(0),
    )?;
    if prompts {
        out.push("open_prompt");
    }
    Ok(out)
}

#[derive(Serialize)]
pub struct TaskReport {
    pub task_id: String,
    pub key: String,
    pub harness: String,
    pub messages: usize,
    pub events: usize,
    /// The events' size as JSON, as a store would keep them.
    pub event_bytes: usize,
    /// The source messages' data, for comparison.
    pub message_bytes: usize,
    pub items: BTreeMap<String, usize>,
    pub requests: usize,
    pub rows: BTreeMap<Disposition, usize>,
    pub warnings: Vec<import::Warning>,
    pub blockers: Vec<&'static str>,
    pub fingerprint: String,
    /// Why it didn't convert (or stage), if it didn't.
    pub error: Option<String>,
    /// With --stage, what staging it did.
    pub staged: Option<Staged>,
}

impl TaskReport {
    fn new(task: &db::Task, key: String, harness: &str, messages: &[db::Message]) -> Self {
        TaskReport {
            task_id: task.id.clone(),
            key,
            harness: harness.into(),
            messages: messages.len(),
            events: 0,
            event_bytes: 0,
            message_bytes: messages.iter().map(|m| m.data.to_string().len()).sum(),
            items: BTreeMap::new(),
            requests: 0,
            rows: BTreeMap::new(),
            warnings: Vec::new(),
            blockers: Vec::new(),
            fingerprint: import::fingerprint(messages),
            error: None,
            staged: None,
        }
    }

    fn add(&mut self, conv: &Conversion) {
        self.events = conv.events.len();
        self.event_bytes = conv.events.iter().map(|e| serde_json::to_string(e).map_or(0, |s| s.len())).sum();
        for item in &conv.snapshot.items {
            let kind = serde_json::to_value(item).ok().and_then(|v| v["type"].as_str().map(String::from)).unwrap_or_default();
            *self.items.entry(kind).or_default() += 1;
        }
        self.requests = conv.snapshot.requests.len();
        for d in [Disposition::Converted, Disposition::Redundant, Disposition::Retained] {
            self.rows.insert(d, conv.count(d));
        }
        self.warnings = conv.warnings.clone();
    }
}

/// Every task's id and key (`<project key>-<number>`, or the id for a task with no project).
pub(super) fn task_keys(c: &Connection) -> Result<Vec<(String, String)>> {
    let mut st = c.prepare(
        "SELECT t.id, COALESCE(p.key || '-' || t.number, t.id) FROM tasks t LEFT JOIN projects p ON p.id = t.project_id ORDER BY t.created_at, t.id",
    )?;
    let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// The report for `task`, and its conversion if it converted.
pub fn task_report(c: &Connection, task: &db::Task, key: String) -> Result<(TaskReport, Option<Conversion>)> {
    let messages = db::list_messages(c, &task.id)?;
    let harness = if db::task_is_codex(c, task)? { "codex" } else { "claude" };
    let mut report = TaskReport::new(task, key, harness, &messages);
    report.blockers = blockers(c, task)?;
    // A panic is a bug in the converter: report it with the task, and go on with the others.
    let conv = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| import::convert(&Source { task, harness, messages: &messages })));
    match conv {
        Ok(Ok(conv)) => {
            report.add(&conv);
            return Ok((report, Some(conv)));
        }
        Ok(Err(e)) => report.error = Some(format!("{e:#}")),
        Err(p) => report.error = Some(p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default()),
    }
    Ok((report, None))
}

/// Opens `path` (read-only unless `write`), at the version this build would migrate it to. A data dir is its
/// `db::file::FILE`.
pub(super) fn open(path: &Path, write: bool) -> Result<Connection> {
    let in_dir = path.join(db::file::FILE);
    let path = if path.is_dir() { in_dir.as_path() } else { path };
    let flags = if write { OpenFlags::SQLITE_OPEN_READ_WRITE } else { OpenFlags::SQLITE_OPEN_READ_ONLY } | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let c = Connection::open_with_flags(path, flags).with_context(|| format!("opening {}", path.display()))?;
    c.execute_batch(if write { "PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;" } else { "PRAGMA busy_timeout=5000;" })?;
    let version: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version != db::VERSION {
        bail!(
            "{} is at database version {version}, and this build reads version {}: run it on a copy that this build has opened (a test server's {}, say)",
            path.display(),
            db::VERSION,
            db::file::FILE
        );
    }
    Ok(c)
}

/// `huntaway threads-import`: reports on the tasks `ids` (ids or keys; all of them if none), and with
/// `stage`, writes their conversions to the database's agent-threads tables (see import::stage).
pub async fn run(path: &Path, ids: &[String], json: bool, examples: usize, stage: bool) -> Result<()> {
    let c = open(path, false)?;
    let store = stage.then(|| open(path, true).map(|w| HuntawayStore::new(Mutex::new(w)))).transpose()?;
    let started = Instant::now();
    let keys = task_keys(&c)?;
    let wanted: Vec<&(String, String)> = if ids.is_empty() {
        keys.iter().collect()
    } else {
        ids.iter()
            .map(|id| keys.iter().find(|(i, k)| i == id || k.eq_ignore_ascii_case(id)).with_context(|| format!("no task {id}")))
            .collect::<Result<_>>()?
    };
    let mut reports = Vec::with_capacity(wanted.len());
    for (id, key) in wanted {
        let task = db::get_task(&c, id)?.with_context(|| format!("no task {id}"))?;
        let (mut report, conv) = task_report(&c, &task, key.clone())?;
        if let (Some(store), Some(conv)) = (&store, &conv) {
            match import::stage(store, conv).await {
                Ok(s) => report.staged = Some(s),
                Err(e) => report.error = Some(format!("staging: {e:#}")),
            }
        }
        reports.push(report);
    }
    if json {
        println!("{}", serde_json::to_string_pretty(&reports)?);
    } else {
        print!("{}", summary(&reports, started.elapsed().as_secs_f64(), examples));
    }
    Ok(())
}

fn n(x: usize) -> String {
    let s = x.to_string();
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

fn mb(bytes: usize) -> String {
    format!("{:.1} MB", bytes as f64 / 1e6)
}

/// The report as text: totals, then each warning's count with some examples.
pub fn summary(reports: &[TaskReport], seconds: f64, examples: usize) -> String {
    use std::fmt::Write;
    let mut out = String::new();
    let sum = |f: &dyn Fn(&TaskReport) -> usize| reports.iter().map(f).sum::<usize>();
    let failed: Vec<&TaskReport> = reports.iter().filter(|r| r.error.is_some()).collect();
    let _ = writeln!(
        out,
        "{} tasks, {} messages ({}), converted in {seconds:.1}s: {} failed.",
        n(reports.len()),
        n(sum(&|r| r.messages)),
        mb(sum(&|r| r.message_bytes)),
        n(failed.len())
    );
    let rows = |d| sum(&|r: &TaskReport| r.rows.get(&d).copied().unwrap_or(0));
    let _ = writeln!(
        out,
        "Messages: {} converted, {} redundant, {} retained (in the source only).",
        n(rows(Disposition::Converted)),
        n(rows(Disposition::Redundant)),
        n(rows(Disposition::Retained))
    );
    let mut items = BTreeMap::<&str, usize>::new();
    for r in reports {
        for (k, v) in &r.items {
            *items.entry(k).or_default() += v;
        }
    }
    let items: Vec<String> = items.iter().map(|(k, v)| format!("{} {k}", n(*v))).collect();
    let _ = writeln!(out, "Items: {}; {} requests.", items.join(", "), n(sum(&|r| r.requests)));
    let _ = writeln!(out, "Events: {} ({}).", n(sum(&|r| r.events)), mb(sum(&|r| r.event_bytes)));
    let staged = |s| reports.iter().filter(|r| r.staged == Some(s)).count();
    if reports.iter().any(|r| r.staged.is_some()) {
        let _ = writeln!(out, "Staged: {} threads written, {} unchanged.", n(staged(Staged::Staged)), n(staged(Staged::Unchanged)));
    }
    let mut blocked = BTreeMap::<&str, Vec<&str>>::new();
    for r in reports {
        for b in &r.blockers {
            blocked.entry(b).or_default().push(&r.key);
        }
    }
    let n_blocked = reports.iter().filter(|r| !r.blockers.is_empty()).count();
    let _ = writeln!(out, "\nCan't be switched over now: {} tasks.", n(n_blocked));
    for (b, keys) in &blocked {
        let _ = writeln!(out, "  {b}: {} ({})", n(keys.len()), keys.iter().take(examples).copied().collect::<Vec<_>>().join(", "));
    }
    let mut warnings = BTreeMap::<&str, (usize, Vec<String>, std::collections::BTreeSet<&str>)>::new();
    for r in reports {
        for w in &r.warnings {
            let e = warnings.entry(w.code).or_default();
            e.0 += 1;
            e.2.insert(&r.key);
            if e.1.len() < examples {
                let at = w.message_id.map(|id| format!(" #{id}")).unwrap_or_default();
                e.1.push(format!("{}{at}: {}", r.key, w.text));
            }
        }
    }
    let _ = writeln!(out, "\nWarnings:{}", if warnings.is_empty() { " none." } else { "" });
    for (code, (count, ex, tasks)) in &warnings {
        let _ = writeln!(out, "  {code}: {} in {} tasks", n(*count), n(tasks.len()));
        for e in ex {
            let _ = writeln!(out, "    {e}");
        }
    }
    if !failed.is_empty() {
        let _ = writeln!(out, "\nFailed:");
        for r in failed.iter().take(examples.max(1) * 4) {
            let _ = writeln!(out, "  {}: {}", r.key, r.error.as_deref().unwrap_or_default());
        }
    }
    let mut largest: Vec<&TaskReport> = reports.iter().collect();
    largest.sort_by_key(|r| std::cmp::Reverse(r.event_bytes));
    let _ = writeln!(out, "\nLargest threads:");
    for r in largest.iter().take(examples) {
        let _ = writeln!(out, "  {}: {} messages ({}) → {} events ({})", r.key, n(r.messages), mb(r.message_bytes), n(r.events), mb(r.event_bytes));
    }
    out
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::testing;

    #[test]
    fn reports_what_stops_a_switch_over() {
        let s = testing::state();
        let task = testing::task(&s);
        let add = |kind: &str, data: serde_json::Value| db::insert_message(&s.db(), &task.id, kind, &data).unwrap();
        add("user", json!({"text": "hi"}));
        add("claude", json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "x", "name": "Bash", "input": {}}]}}));
        add("question", json!({"question": "Which?", "status": "pending"}));
        let report = |s: &crate::state::Shared| {
            let task = db::get_task(&s.db(), &task.id).unwrap().unwrap();
            task_report(&s.db(), &task, "T-1".into()).unwrap().0
        };
        let r = report(&s);
        assert_eq!(r.blockers, ["open_prompt"]);
        assert_eq!((r.messages, r.harness.as_str(), r.items["tool_call"], r.requests), (3, "claude", 1, 1));
        assert_eq!(r.warnings.iter().map(|w| w.code).collect::<Vec<_>>(), ["open_prompt", "no_result"]);
        db::queue(&s.db(), &task.id, db::Queued::new("next", false)).unwrap();
        s.db().execute("UPDATE tasks SET running=1 WHERE id=?1", [&task.id]).unwrap();
        db::insert_run(&s.db(), &task.id, "prompt").unwrap();
        assert_eq!(report(&s).blockers, ["running", "active_run", "queued_input", "open_prompt"]);
        let text = summary(&[report(&s)], 1.0, 2);
        assert!(text.starts_with("1 tasks, 3 messages"), "{text}");
        assert!(text.contains("  open_prompt: 1 (T-1)"), "{text}");
        assert!(text.contains("  no_result: 1 in 1 tasks\n    T-1: 1 tool calls have no result"), "{text}");
    }

    #[test]
    fn reads_only_a_database_at_its_version() {
        let dir = testing::temp_dir();
        let path = dir.join("old.db");
        Connection::open(&path).unwrap().execute_batch("PRAGMA user_version=3;").unwrap();
        assert!(format!("{:#}", open(&path, false).unwrap_err()).contains("at database version 3"));
        let path = dir.join("now.db");
        drop(db::open(&path).unwrap());
        let c = open(&path, false).unwrap();
        assert!(c.execute_batch("CREATE TABLE x (y)").is_err());
    }
}
