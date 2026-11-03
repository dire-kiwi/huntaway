//! agent-threads' `Store` on the board's database, in tables of its own (`at_threads`, `at_events`,
//! `at_snapshots`, `at_runs`, see `SCHEMA_V84` in db/schema.rs): the crate's `SqliteStore` would make a
//! `runs` table, which is Huntaway's, so it mustn't be opened on huntaway.db. Being in the same database
//! lets a thread's events and its task's state change in one transaction.
//!
//! It passes the crate's store conformance cases (spec/conformance/store.json, see the tests). Values
//! are kept as the JSON text they were given, so fields this build doesn't know survive.

use std::sync::{Mutex, Weak};

use agent_threads::{RunRecord, Store, StoreError, StoreErrorKind, StoreResult};
use async_trait::async_trait;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use crate::state::AppState;

/// Where a store gets its connection: the server's database, or one opened for a command or a test.
pub trait Db: Send + Sync + 'static {
    /// Runs `f` with the connection locked.
    fn with<T>(&self, f: impl FnOnce(&mut Connection) -> StoreResult<T>) -> StoreResult<T>;
}

/// The server's database. Weak, so a store kept in the state doesn't keep the state alive.
impl Db for Weak<AppState> {
    fn with<T>(&self, f: impl FnOnce(&mut Connection) -> StoreResult<T>) -> StoreResult<T> {
        let s = self.upgrade().ok_or_else(|| StoreError::failed("the server has stopped"))?;
        let mut db = s.db();
        f(&mut db)
    }
}

impl Db for Mutex<Connection> {
    fn with<T>(&self, f: impl FnOnce(&mut Connection) -> StoreResult<T>) -> StoreResult<T> {
        f(&mut self.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

/// agent-threads' store in the board's database (see the module's doc).
pub struct HuntawayStore<D: Db> {
    db: D,
}

impl<D: Db> HuntawayStore<D> {
    pub fn new(db: D) -> Self {
        Self { db }
    }
}

fn failed(e: impl std::fmt::Display) -> StoreError {
    StoreError::failed(e)
}

fn not_found(id: &str) -> StoreError {
    StoreError::new(StoreErrorKind::NotFound, format!("no thread {id}"))
}

fn parse<T: serde::de::DeserializeOwned>(text: String) -> StoreResult<T> {
    serde_json::from_str(&text).map_err(failed)
}

fn str_field<'a>(v: &'a Value, name: &str) -> &'a str {
    v.get(name).and_then(Value::as_str).unwrap_or("")
}

/// The task a thread belongs to (its `metadata.task_id`), which it's deleted with.
fn task_of(thread: &Value) -> Option<&str> {
    thread.pointer("/metadata/task_id").and_then(Value::as_str)
}

fn known(c: &Connection, id: &str) -> StoreResult<()> {
    let found = c.prepare_cached("SELECT 1 FROM at_threads WHERE id=?1").and_then(|mut s| s.exists([id])).map_err(failed)?;
    if found { Ok(()) } else { Err(not_found(id)) }
}

fn last(c: &Connection, id: &str) -> StoreResult<u64> {
    c.prepare_cached("SELECT MAX(seq) FROM at_events WHERE thread_id=?1")
        .and_then(|mut s| s.query_row([id], |r| r.get::<_, Option<i64>>(0)))
        .map(|n| n.unwrap_or(0) as u64)
        .map_err(failed)
}

fn put_run(c: &Connection, run: &RunRecord) -> StoreResult<()> {
    let data = serde_json::to_string(run).map_err(failed)?;
    c.prepare_cached(
        "INSERT INTO at_runs (id, thread_id, started_at, active, data) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (id) DO UPDATE SET thread_id=excluded.thread_id, started_at=excluded.started_at, active=excluded.active, data=excluded.data",
    )
    .and_then(|mut s| s.execute(params![run.id, run.thread_id, run.started_at, run.is_active(), data]))
    .map(|_| ())
    .map_err(failed)
}

/// Whether `events` (and `runs`) can be appended to thread `id`, whose last seq is `last`: the same
/// checks as the crate's own stores.
fn check_events(id: &str, last: u64, events: &[Value], runs: &[RunRecord]) -> StoreResult<()> {
    if let Some(r) = runs.iter().find(|r| r.thread_id != id) {
        return Err(StoreError::new(StoreErrorKind::Invalid, format!("thread {}'s run appended to {id}", r.thread_id)));
    }
    let mut seq = last;
    for e in events {
        if str_field(e, "type") == "delta" {
            return Err(StoreError::new(StoreErrorKind::Invalid, "deltas aren't saved"));
        }
        let thread = e.get("thread_id").and_then(Value::as_str);
        if thread != Some(id) {
            return Err(StoreError::new(StoreErrorKind::Invalid, format!("an event for thread {} appended to {id}", thread.unwrap_or("?"))));
        }
        seq += 1;
        if e.get("seq").and_then(Value::as_u64) != Some(seq) {
            return Err(StoreError::new(StoreErrorKind::Seq, format!("event seq {}, where {seq} comes next", e.get("seq").unwrap_or(&Value::Null))));
        }
    }
    Ok(())
}

#[async_trait]
impl<D: Db> Store for HuntawayStore<D> {
    async fn create_thread(&self, thread: &Value) -> StoreResult<()> {
        let id = str_field(thread, "id");
        self.db.with(|c| {
            let added = c
                .execute(
                    "INSERT INTO at_threads (id, task_id, created_at, data) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (id) DO NOTHING",
                    params![id, task_of(thread), str_field(thread, "created_at"), thread.to_string()],
                )
                .map_err(failed)?;
            if added == 0 {
                return Err(StoreError::new(StoreErrorKind::Exists, format!("there's a thread {id} already")));
            }
            Ok(())
        })
    }

    async fn get_thread(&self, id: &str) -> StoreResult<Option<Value>> {
        self.db.with(|c| {
            let data: Option<String> = c.query_row("SELECT data FROM at_threads WHERE id=?1", [id], |r| r.get(0)).optional().map_err(failed)?;
            data.map(parse).transpose()
        })
    }

    async fn list_threads(&self) -> StoreResult<Vec<Value>> {
        self.db.with(|c| {
            let mut st = c.prepare("SELECT data FROM at_threads ORDER BY created_at, id").map_err(failed)?;
            let rows = st.query_map([], |r| r.get::<_, String>(0)).map_err(failed)?;
            rows.map(|r| r.map_err(failed).and_then(parse)).collect()
        })
    }

    async fn update_thread(&self, thread: &Value) -> StoreResult<()> {
        let id = str_field(thread, "id");
        self.db.with(|c| {
            let changed = c
                .execute(
                    "UPDATE at_threads SET task_id=?2, created_at=?3, data=?4 WHERE id=?1",
                    params![id, task_of(thread), str_field(thread, "created_at"), thread.to_string()],
                )
                .map_err(failed)?;
            if changed == 0 { Err(not_found(id)) } else { Ok(()) }
        })
    }

    async fn delete_thread(&self, id: &str) -> StoreResult<bool> {
        self.db.with(|c| {
            let tx = c.transaction().map_err(failed)?;
            // Not left to ON DELETE CASCADE, which needs foreign_keys on.
            for table in ["at_events", "at_snapshots", "at_runs"] {
                tx.execute(&format!("DELETE FROM {table} WHERE thread_id=?1"), [id]).map_err(failed)?;
            }
            let deleted = tx.execute("DELETE FROM at_threads WHERE id=?1", [id]).map_err(failed)?;
            tx.commit().map_err(failed)?;
            Ok(deleted > 0)
        })
    }

    async fn append_events(&self, id: &str, events: &[Value], runs: &[RunRecord]) -> StoreResult<()> {
        self.db.with(|c| {
            // Immediate, so two appends can't both read the same last seq.
            let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(failed)?;
            known(&tx, id)?;
            check_events(id, last(&tx, id)?, events, runs)?;
            {
                let mut st = tx.prepare_cached("INSERT INTO at_events (thread_id, seq, data) VALUES (?1, ?2, ?3)").map_err(failed)?;
                for e in events {
                    st.execute(params![id, e["seq"].as_i64(), e.to_string()]).map_err(failed)?;
                }
            }
            for r in runs {
                put_run(&tx, r)?;
            }
            tx.commit().map_err(failed)
        })
    }

    async fn read_events(&self, id: &str, after: u64, limit: Option<usize>) -> StoreResult<Vec<Value>> {
        self.db.with(|c| {
            known(c, id)?;
            let limit = limit.map_or(-1, |l| l.min(i64::MAX as usize) as i64);
            let mut st = c.prepare_cached("SELECT data FROM at_events WHERE thread_id=?1 AND seq>?2 ORDER BY seq LIMIT ?3").map_err(failed)?;
            let rows = st.query_map(params![id, after.min(i64::MAX as u64) as i64, limit], |r| r.get::<_, String>(0)).map_err(failed)?;
            rows.map(|r| r.map_err(failed).and_then(parse)).collect()
        })
    }

    async fn last_seq(&self, id: &str) -> StoreResult<u64> {
        self.db.with(|c| {
            known(c, id)?;
            last(c, id)
        })
    }

    async fn save_snapshot(&self, id: &str, snapshot: &Value) -> StoreResult<()> {
        self.db.with(|c| {
            known(c, id)?;
            c.execute(
                "INSERT INTO at_snapshots (thread_id, data) VALUES (?1, ?2) ON CONFLICT (thread_id) DO UPDATE SET data=excluded.data",
                params![id, snapshot.to_string()],
            )
            .map(|_| ())
            .map_err(failed)
        })
    }

    async fn load_snapshot(&self, id: &str) -> StoreResult<Option<Value>> {
        self.db.with(|c| {
            known(c, id)?;
            let data: Option<String> = c.query_row("SELECT data FROM at_snapshots WHERE thread_id=?1", [id], |r| r.get(0)).optional().map_err(failed)?;
            data.map(parse).transpose()
        })
    }

    async fn put_run(&self, run: &RunRecord) -> StoreResult<()> {
        self.db.with(|c| {
            known(c, &run.thread_id)?;
            put_run(c, run)
        })
    }

    async fn get_run(&self, id: &str) -> StoreResult<Option<RunRecord>> {
        self.db.with(|c| {
            let data: Option<String> = c.query_row("SELECT data FROM at_runs WHERE id=?1", [id], |r| r.get(0)).optional().map_err(failed)?;
            data.map(parse).transpose()
        })
    }

    async fn active_runs(&self) -> StoreResult<Vec<RunRecord>> {
        self.db.with(|c| {
            let mut st = c.prepare("SELECT data FROM at_runs WHERE active=1 ORDER BY started_at, id").map_err(failed)?;
            let rows = st.query_map([], |r| r.get::<_, String>(0)).map_err(failed)?;
            rows.map(|r| r.map_err(failed).and_then(parse)).collect()
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;

    use super::*;
    use crate::testing;

    /// {"$": "NAME"} replaced with a copy of the value NAME (spec/conformance/store.md).
    fn resolve(v: &Value, values: &Value) -> Value {
        match v {
            Value::Array(a) => Value::Array(a.iter().map(|x| resolve(x, values)).collect()),
            Value::Object(o) if o.len() == 1 && o.get("$").is_some_and(Value::is_string) => values[o["$"].as_str().unwrap()].clone(),
            Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), resolve(x, values))).collect()),
            _ => v.clone(),
        }
    }

    fn kind_name(k: &StoreErrorKind) -> &'static str {
        match k {
            StoreErrorKind::Exists => "exists",
            StoreErrorKind::NotFound => "not_found",
            StoreErrorKind::Invalid => "invalid",
            StoreErrorKind::Seq => "seq",
            StoreErrorKind::Failed => "failed",
        }
    }

    /// Calls the operation `op` with `args`: its result as JSON, or the error's kind.
    async fn call(store: &dyn Store, op: &str, args: &[Value]) -> Result<Value, String> {
        let s = |i: usize| args[i].as_str().unwrap().to_string();
        let run = |v: &Value| serde_json::from_value::<RunRecord>(v.clone()).unwrap();
        let r = match op {
            "createThread" => store.create_thread(&args[0]).await.map(|_| Value::Null),
            "getThread" => store.get_thread(&s(0)).await.map(|t| t.unwrap_or(Value::Null)),
            "listThreads" => store.list_threads().await.map(Value::from),
            "updateThread" => store.update_thread(&args[0]).await.map(|_| Value::Null),
            "deleteThread" => store.delete_thread(&s(0)).await.map(Value::from),
            "appendEvents" => {
                let events = args[1].as_array().unwrap().clone();
                let runs: Vec<RunRecord> = args.get(2).and_then(Value::as_array).map(|a| a.iter().map(run).collect()).unwrap_or_default();
                store.append_events(&s(0), &events, &runs).await.map(|_| Value::Null)
            }
            "readEvents" => {
                let o = args.get(1).cloned().unwrap_or(json!({}));
                let limit = o.get("limit").and_then(Value::as_u64).map(|l| l as usize);
                store.read_events(&s(0), o.get("after").and_then(Value::as_u64).unwrap_or(0), limit).await.map(Value::from)
            }
            "lastSeq" => store.last_seq(&s(0)).await.map(Value::from),
            "saveSnapshot" => store.save_snapshot(&s(0), &args[1]).await.map(|_| Value::Null),
            "loadSnapshot" => store.load_snapshot(&s(0)).await.map(|t| t.unwrap_or(Value::Null)),
            "putRun" => store.put_run(&run(&args[0])).await.map(|_| Value::Null),
            "getRun" => store.get_run(&s(0)).await.map(|r| serde_json::to_value(r).unwrap()),
            "activeRuns" => store.active_runs().await.map(|r| serde_json::to_value(r).unwrap()),
            _ => panic!("unknown op {op}"),
        };
        r.map_err(|e| kind_name(&e.kind).to_string())
    }

    /// The cases from agent-threads' spec/conformance/store.json, at the revision Cargo.toml pins.
    const CASES: &str = include_str!("store_conformance.json");

    #[test]
    fn passes_the_store_conformance_cases() {
        testing::run(async || {
            let suite: Value = serde_json::from_str(CASES).unwrap();
            let values = &suite["values"];
            let mut failures = Vec::new();
            for case in suite["cases"].as_array().unwrap() {
                // On the server's database, a store made again on it is the reopened one.
                let s = testing::state();
                let open = || Arc::new(HuntawayStore::new(Arc::downgrade(&s))) as Arc<dyn Store>;
                let mut store = open();
                for (i, step) in case["steps"].as_array().unwrap().iter().enumerate() {
                    let op = step["op"].as_str().unwrap();
                    let at = format!("{}: step {} ({op})", case["name"], i + 1);
                    if op == "reopen" {
                        store.close().await.unwrap();
                        store = open();
                        continue;
                    }
                    let args = resolve(step.get("args").unwrap_or(&json!([])), values);
                    let got = call(&*store, op, args.as_array().unwrap()).await;
                    match (step.get("error").and_then(Value::as_str), got) {
                        (Some(want), Err(kind)) if kind == want => {}
                        (Some(want), other) => failures.push(format!("{at}: expected a {want} error, got {other:?}")),
                        (None, Err(kind)) => failures.push(format!("{at}: unexpected {kind} error")),
                        (None, Ok(v)) => {
                            let want = resolve(step.get("result").unwrap_or(&Value::Null), values);
                            if v != want {
                                failures.push(format!("{at}: got {v}, expected {want}"));
                            }
                        }
                    }
                }
            }
            assert!(failures.is_empty(), "{}", failures.join("\n"));
        })
    }

    #[test]
    fn a_tasks_thread_goes_with_it() {
        testing::run(async || {
            let s = testing::state();
            let task = testing::task(&s);
            let store = HuntawayStore::new(Arc::downgrade(&s));
            let thread = json!({"id": "th_1", "harness": "claude", "status": "idle", "created_at": "2026-11-01T00:00:00Z", "metadata": {"task_id": task.id}});
            store.create_thread(&thread).await.unwrap();
            let e1 = json!({"type": "turn.started", "thread_id": "th_1", "seq": 1, "turn_id": "t1"});
            store.append_events("th_1", &[e1], &[]).await.unwrap();
            store.save_snapshot("th_1", &json!({"seq": 1})).await.unwrap();
            let task_of = |s: &crate::state::Shared| s.db().query_row("SELECT task_id FROM at_threads WHERE id='th_1'", [], |r| r.get::<_, String>(0)).unwrap();
            assert_eq!(task_of(&s), task.id);
            s.db().execute("DELETE FROM tasks WHERE id=?1", [&task.id]).unwrap();
            assert_eq!(store.get_thread("th_1").await.unwrap(), None);
            let left: i64 = s.db().query_row("SELECT (SELECT COUNT(*) FROM at_events) + (SELECT COUNT(*) FROM at_snapshots)", [], |r| r.get(0)).unwrap();
            assert_eq!(left, 0);
            // A task that isn't there can't have a thread.
            let orphan = json!({"id": "th_2", "harness": "claude", "status": "idle", "created_at": "2026-11-01T00:00:00Z", "metadata": {"task_id": "gone"}});
            assert_eq!(store.create_thread(&orphan).await.unwrap_err().kind, StoreErrorKind::Failed);
        })
    }

    #[test]
    fn a_store_on_a_stopped_server_fails() {
        testing::run(async || {
            let store = HuntawayStore::new(Arc::downgrade(&testing::state()));
            assert_eq!(store.list_threads().await.unwrap_err().kind, StoreErrorKind::Failed);
        })
    }
}
