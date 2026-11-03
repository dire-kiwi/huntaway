//! Clients' view of a task's agent-threads thread (docs/agent-threads-api.md): windows of it, pages of
//! earlier items, its saved events after a seq, the commands that aren't the board's own routes, and
//! every thread's events on the server's event broadcast.
//!
//! A task's thread is the one whose id is the task's (as the engine and the import make them), or else
//! its latest. It's read from the backend (`AppState::agent_threads`) when it's live there: the backend
//! is running, and the thread is the engine's own, or an import the task has been switched over to
//! (`tasks.run_engine`). Otherwise it's read from the store, so looking at a staged import doesn't load
//! it into the backend (which would pick up its requests and runs).

use std::collections::HashMap;
use std::sync::{Arc, Weak};

use agent_threads::reducer::{apply_event, initial_state};
use agent_threads::window::{item_page, snapshot_window};
use agent_threads::{AgentThreads, Command, ItemPage, Snapshot, Store, Thread, ThreadEvent};
use axum::http::StatusCode;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value, json};
use tokio::sync::broadcast;

use crate::state::{ApiError, ApiResult, AppState, Shared};
use crate::threads::store::HuntawayStore;

/// Makes `backend` the server's, and sends its events (deltas included) to clients as `thread_event`s:
/// `{"type": "thread_event", "task_id", "event"}`, for threads that belong to a task. Call it once,
/// before the backend's `recover()`, so what recovery does reaches clients too. False (and nothing
/// done) if the server has one already.
// The engine (HA-143) calls it as the server starts.
#[cfg_attr(not(test), allow(dead_code))]
pub fn install(s: &Shared, backend: AgentThreads) -> bool {
    let rx = backend.subscribe();
    if s.agent_threads.set(backend).is_err() {
        return false;
    }
    tokio::spawn(forward(Arc::downgrade(s), rx));
    true
}

/// Sends the backend's events to the server's broadcast, until the backend or the server goes. A
/// subscription that falls behind (it missed some) sends `thread_resync`, after which clients catch up
/// on the threads they show from their seqs.
async fn forward(s: Weak<AppState>, mut rx: broadcast::Receiver<ThreadEvent>) {
    // Each thread's task, which never changes.
    let mut tasks: HashMap<String, String> = HashMap::new();
    loop {
        let ev = rx.recv().await;
        let Some(s) = s.upgrade() else { return };
        match ev {
            Ok(ev) => {
                let thread = ev.thread_id();
                let task = match tasks.get(thread) {
                    Some(t) => Some(t.clone()),
                    None => task_of(&s.db(), thread),
                };
                // Not a task's (or deleted meanwhile): no client shows it.
                let Some(task) = task else { continue };
                tasks.entry(thread.to_string()).or_insert_with(|| task.clone());
                s.emit(json!({"type": "thread_event", "task_id": task, "event": ev}));
            }
            Err(broadcast::error::RecvError::Lagged(n)) => {
                tracing::debug!("thread events: missed {n}");
                s.emit(json!({"type": "thread_resync"}));
            }
            Err(broadcast::error::RecvError::Closed) => return,
        }
    }
}

/// The task thread `id` belongs to.
fn task_of(c: &Connection, id: &str) -> Option<String> {
    c.query_row("SELECT task_id FROM at_threads WHERE id=?1", [id], |r| r.get(0)).optional().ok().flatten().flatten()
}

/// Task `task_id`'s thread: the one with its id, or else its latest.
pub fn thread_of(c: &Connection, task_id: &str) -> rusqlite::Result<Option<String>> {
    c.query_row("SELECT id FROM at_threads WHERE task_id=?1 ORDER BY id=?1 DESC, created_at DESC, rowid DESC LIMIT 1", [task_id], |r| r.get(0))
        .optional()
}

/// Whether thread `id` (of task `task_id`) is the backend's to serve: the engine's own thread, or an
/// import the task was switched over to.
fn is_live(c: &Connection, task_id: &str, id: &str) -> rusqlite::Result<bool> {
    let imported: bool = c.query_row("SELECT json_extract(data, '$.metadata.imported') IS NOT NULL FROM at_threads WHERE id=?1", [id], |r| r.get(0))?;
    if !imported {
        return Ok(true);
    }
    // `run_engine` is the engine's column; a database without it has no switched-over tasks.
    let engine: Option<String> = c.query_row("SELECT run_engine FROM tasks WHERE id=?1", [task_id], |r| r.get(0)).optional().unwrap_or(None);
    Ok(engine.as_deref() == Some("agent_threads"))
}

/// A page of a thread's saved events (see TaskThread::events_since).
#[derive(serde::Serialize)]
pub struct Events {
    pub events: Vec<Value>,
    /// Whether there are more after these: ask again after `seq`.
    pub more: bool,
    /// The seq these go up to, unknown events after the last of them included: where the next page
    /// starts, and (once they're applied) the client's state's seq.
    pub seq: u64,
}

/// A task's thread, and where it's read from.
pub struct TaskThread {
    pub task_id: String,
    pub thread_id: String,
    /// The backend, when the thread is live there.
    backend: Option<AgentThreads>,
    /// Whether it's the backend's, running or not.
    live: bool,
    store: HuntawayStore<Weak<AppState>>,
}

impl TaskThread {
    /// Task `task_id`'s thread: a 404 if there's no such task, or it has none (it runs on the legacy
    /// runner, whose messages are at `/tasks/{id}/messages`).
    pub fn open(s: &Shared, task_id: &str) -> ApiResult<TaskThread> {
        let c = s.db();
        let task = crate::db::get_task(&c, task_id)?.ok_or_else(|| ApiError::not_found("task"))?;
        let thread_id = thread_of(&c, &task.id)?.ok_or_else(|| ApiError(StatusCode::NOT_FOUND, format!("task {} has no agent-threads thread", task.id)))?;
        let live = is_live(&c, &task.id, &thread_id)?;
        drop(c);
        let backend = s.agent_threads.get().filter(|_| live).cloned();
        Ok(TaskThread { task_id: task.id, thread_id, backend, live, store: HuntawayStore::new(Arc::downgrade(s)) })
    }

    /// The thread's state, or (with a `limit` it's over) a window of its last `limit` items.
    pub async fn window(&self, limit: Option<usize>) -> ApiResult<Snapshot> {
        match (&self.backend, limit) {
            (Some(b), Some(l)) => b.snapshot_window(&self.thread_id, l).await.map_err(read_error),
            (Some(b), None) => b.snapshot(&self.thread_id).await.map_err(read_error),
            (None, l) => {
                let state = self.stored().await?;
                Ok(match l {
                    Some(l) => snapshot_window(&state, l),
                    None => state,
                })
            }
        }
    }

    /// The thread's items before index `before`, at most `limit` of them.
    pub async fn items_before(&self, before: u64, limit: usize) -> ApiResult<ItemPage> {
        match &self.backend {
            Some(b) => b.items_before(&self.thread_id, before, limit).await.map_err(read_error),
            None => Ok(item_page(&self.stored().await?, before, limit)),
        }
    }

    /// The thread's saved events after `seq` that this build knows, at most `limit` of them. Event types
    /// it doesn't know (a newer build's) are left out, but gone past: the store's limit counts them, so
    /// it reads on until it has `limit` and one more, or there are no more.
    pub async fn events_since(&self, seq: u64, limit: usize) -> ApiResult<Events> {
        if let Some(b) = &self.backend {
            // Waits for the thread's events so far to be saved (reading none of them), then they're read
            // from the store as for any thread.
            b.events_since(&self.thread_id, seq, Some(0)).await.map_err(read_error)?;
        }
        let (mut events, mut scanned) = (Vec::new(), seq);
        while events.len() <= limit {
            let want = limit + 1 - events.len();
            let batch = self.store.read_events(&self.thread_id, scanned, Some(want)).await.map_err(store_error)?;
            let end = batch.len() < want;
            for e in batch {
                scanned = e["seq"].as_u64().unwrap_or(scanned).max(scanned);
                if serde_json::from_value::<ThreadEvent>(e.clone()).is_ok() {
                    events.push(e);
                }
            }
            if end {
                break;
            }
        }
        let more = events.len() > limit;
        events.truncate(limit);
        // With more to come, they start after the last event given; otherwise after all it read.
        let seq = if more { events.last().and_then(|e| e["seq"].as_u64()).unwrap_or(scanned) } else { scanned };
        Ok(Events { events, more, seq })
    }

    /// Carries out `command` (whose `thread_id` is this thread's) on the backend: a 409 if the thread
    /// isn't the backend's (a staged import), a 503 if the backend isn't running.
    pub async fn handle(&self, command: Command) -> ApiResult<()> {
        let Some(b) = &self.backend else {
            return Err(if self.live {
                ApiError(StatusCode::SERVICE_UNAVAILABLE, "this host isn't running agent-threads threads".into())
            } else {
                ApiError::conflict(format!("task {}'s thread is an import it hasn't been switched over to", self.task_id))
            });
        };
        b.handle(command).await.map_err(|e| match e {
            agent_threads::Error::Command(m) => ApiError::conflict(m),
            e => ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        })
    }

    /// The thread's saved state, from its snapshot and the saved events after it, as the backend loads
    /// it (without taking up its run or requests).
    async fn stored(&self) -> ApiResult<Snapshot> {
        let id = &self.thread_id;
        let thread = self.store.get_thread(id).await.map_err(store_error)?.ok_or_else(|| ApiError::not_found("thread"))?;
        let thread: Thread = serde_json::from_value(thread).map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, format!("thread {id} can't be read: {e}")))?;
        let snapshot = self.store.load_snapshot(id).await.map_err(store_error)?.and_then(|s| serde_json::from_value::<Snapshot>(s).ok());
        let mut state = snapshot.unwrap_or_else(|| initial_state(thread.clone()));
        for e in self.store.read_events(id, state.seq, None).await.map_err(store_error)? {
            match serde_json::from_value::<ThreadEvent>(e.clone()) {
                Ok(e) => apply_event(&mut state, &e),
                // A newer build's event: its seq is gone past, and nothing else.
                Err(_) => state.seq = e["seq"].as_u64().unwrap_or(state.seq).max(state.seq),
            }
        }
        if state.seq == 0 {
            state = initial_state(thread);
        }
        Ok(state)
    }
}

fn read_error(e: agent_threads::Error) -> ApiError {
    match e {
        agent_threads::Error::Command(m) => ApiError(StatusCode::NOT_FOUND, m),
        e => ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

fn store_error(e: agent_threads::StoreError) -> ApiError {
    match e.kind {
        agent_threads::StoreErrorKind::NotFound => ApiError::not_found("thread"),
        _ => ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// The commands a client sends to a task's thread here: answering a request (`respond`), and
/// `compact` and `new_session`. The others have the board's own routes, which keep its gates (queued
/// messages, the merge queue, checkpoints) and its task in step: `send` is POST /tasks/{id}/messages,
/// `interrupt` /tasks/{id}/stop, `set_options` PATCH /tasks/{id}, and `rewind` /tasks/{id}/rewind.
pub fn parse_command(thread_id: &str, mut body: Value) -> ApiResult<Command> {
    let o = body.as_object_mut().ok_or_else(|| ApiError::bad("a command is a JSON object"))?;
    match o.get("thread_id") {
        None | Some(Value::Null) => {
            o.insert("thread_id".into(), json!(thread_id));
        }
        Some(t) if t == thread_id => {}
        Some(t) => return Err(ApiError::bad(format!("thread {t} isn't this task's (its thread is {thread_id})"))),
    }
    let kind = o.get("type").and_then(Value::as_str).unwrap_or_default();
    let route = match kind {
        "respond" | "compact" | "new_session" => None,
        "send" => Some("POST /api/tasks/{id}/messages"),
        "interrupt" => Some("POST /api/tasks/{id}/stop"),
        "set_options" => Some("PATCH /api/tasks/{id}"),
        "rewind" => Some("POST /api/tasks/{id}/rewind"),
        _ => return Err(ApiError::bad("type must be respond, compact or new_session")),
    };
    if let Some(route) = route {
        return Err(ApiError::bad(format!("{kind} goes through {route}, which keeps the board's task in step")));
    }
    serde_json::from_value(body).map_err(|e| ApiError::bad(format!("that isn't a valid command: {e}")))
}

#[cfg(test)]
pub(crate) mod tests;
