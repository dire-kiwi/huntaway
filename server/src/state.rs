use std::collections::HashMap;
use std::ops::{Deref, DerefMut};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};

use axum::Router;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use rusqlite::Connection;
use serde_json::{Value, json};
use tokio::sync::{broadcast, oneshot};
use tokio::task::JoinHandle;

use crate::admin::{RestartJob, ServerMeta};
use crate::db::{self, Message, Task};
use crate::hub::LinkHandle;

/// A run that hasn't finished. Its durable state lives in the `runs` table.
pub struct RunHandle {
    pub run_id: String,
    /// Aborts the run while it is still being prepared (before claude starts).
    pub cancel: Option<oneshot::Sender<()>>,
}

pub struct Identity {
    pub host_id: String,
    pub host_name: String,
    /// API token for this host (UI, hubs linking to us, agents' MCP helper).
    pub token: String,
    /// Lets other hosts dial in to this node as a hub.
    pub hub_token: String,
    /// Loopback URL agents' MCP helper uses to reach us.
    pub internal_url: String,
}

pub struct AppState {
    /// This state's own `Shared`, for work it starts in the background.
    me: Weak<AppState>,
    db: Mutex<Connection>,
    pub data_dir: PathBuf,
    pub host_id: String,
    pub host_name: String,
    pub token: String,
    pub hub_token: String,
    pub internal_url: String,
    pub exe: PathBuf,
    /// This host's events (threads, tasks, projects).
    pub events: broadcast::Sender<Value>,
    /// Events from every host on the board, tagged with host_id, for the UI.
    pub hub_events: broadcast::Sender<Value>,
    /// Active runs by task id.
    pub runs: Mutex<HashMap<String, RunHandle>>,
    /// Connected linked hosts by host id.
    pub links: Mutex<HashMap<String, LinkHandle>>,
    /// Connection loops for outbound links, by host id.
    pub link_tasks: Mutex<HashMap<String, JoinHandle<()>>>,
    /// This host's API, for answering tunnelled and proxied requests in-process.
    pub local_router: OnceLock<Router>,
    /// Where this host is reached through the broker it dials (`<broker>/_broker/h/<name>`), if any.
    pub broker_url: OnceLock<String>,
    /// Calls waiting on a permission request's decision, by request id.
    pub perm_waiters: Mutex<HashMap<String, Vec<oneshot::Sender<()>>>>,
    /// MCP calls being executed, with duplicate deliveries waiting on the result.
    pub calls_inflight: Mutex<HashMap<String, Vec<oneshot::Sender<Result<Value, String>>>>>,
    pub meta: ServerMeta,
    pub restart: Mutex<Option<RestartJob>>,
    /// What `--update-from` last reported (see admin::start_update_check).
    pub deployed: Mutex<Option<crate::admin::Deployed>>,
    /// Claude usage limits by Claude config id.
    pub usage: Mutex<HashMap<String, crate::usage::Usage>>,
    /// Held while a project is created or changed, so a key is checked against the keys as they
    /// are when it's stored, and a change works from the project as the one before left it (see
    /// api::update_project_inner).
    pub project_changes: tokio::sync::Mutex<()>,
    /// The projects whose folders are moving, which hold project_changes until they have, and
    /// those whose folders are kept where they are meanwhile (see relocate::Moving and Holding).
    pub relocating: Mutex<crate::relocate::Relocations>,
    /// The tasks being deleted (by how many deletions), which no task can be added to meanwhile
    /// (see api::Deleting).
    pub deleting: Mutex<HashMap<String, usize>>,
    /// Web Push to devices (see push.rs).
    pub push: crate::push::PushState,
    /// A test state's `data_dir`, removed when the state goes (see testing::state).
    #[cfg(test)]
    pub test_dir: OnceLock<crate::testing::TempDir>,
}

pub type Shared = Arc<AppState>;

impl AppState {
    pub fn new(db: Connection, data_dir: PathBuf, id: Identity, meta: ServerMeta) -> Shared {
        let (events, _) = broadcast::channel(1024);
        let (hub_events, _) = broadcast::channel(4096);
        Arc::new_cyclic(|me| Self {
            me: me.clone(),
            db: Mutex::new(db),
            data_dir,
            host_id: id.host_id,
            host_name: id.host_name,
            token: id.token,
            hub_token: id.hub_token,
            internal_url: id.internal_url,
            exe: std::env::current_exe().unwrap_or_else(|_| PathBuf::from("huntaway")),
            events,
            hub_events,
            runs: Mutex::new(HashMap::new()),
            links: Mutex::new(HashMap::new()),
            link_tasks: Mutex::new(HashMap::new()),
            local_router: OnceLock::new(),
            broker_url: OnceLock::new(),
            perm_waiters: Mutex::new(HashMap::new()),
            calls_inflight: Mutex::new(HashMap::new()),
            meta,
            restart: Mutex::new(None),
            deployed: Mutex::new(None),
            usage: Mutex::new(HashMap::new()),
            project_changes: tokio::sync::Mutex::new(()),
            relocating: Mutex::new(Default::default()),
            deleting: Mutex::new(HashMap::new()),
            push: Default::default(),
            #[cfg(test)]
            test_dir: OnceLock::new(),
        })
    }

    /// The database. The lock isn't reentrant: drop the guard before calling `db()` again, or
    /// the second call waits forever. Tests and debug builds panic instead of hanging.
    pub fn db(&self) -> DbGuard<'_> {
        #[cfg(any(test, debug_assertions))]
        let key = held::claim(&self.db);
        DbGuard {
            guard: self.db.lock().unwrap_or_else(|e| e.into_inner()),
            #[cfg(any(test, debug_assertions))]
            key,
        }
    }

    pub fn emit(&self, ev: Value) {
        let _ = self.events.send(ev);
    }

    pub fn emit_task(&self, t: &Task) {
        self.emit(json!({"type": "task", "task": t}));
    }

    pub fn emit_message(&self, m: &Message) {
        self.emit(json!({"type": "message", "task_id": m.task_id, "message": m}));
    }

    /// Insert a message and broadcast it.
    pub fn add_message(&self, task_id: &str, kind: &str, data: Value) -> anyhow::Result<Message> {
        let m = db::insert_message(&self.db(), task_id, kind, &data)?;
        self.emit_message(&m);
        Ok(m)
    }

    /// Informational line in a thread (worktree setup, errors, status changes).
    pub fn add_event(&self, task_id: &str, level: &str, text: impl Into<String>, detail: Option<String>) {
        let _ = self.add_message(task_id, "event", json!({"level": level, "text": text.into(), "detail": detail}));
    }

    pub fn update_task(&self, id: &str, fields: &[(&str, Value)]) -> anyhow::Result<Option<Task>> {
        self.update_task_if(id, fields, |_| Ok(true))
    }

    /// `update_task`, if `when` holds: it's checked under the lock the change is made with, so
    /// nothing can change what it checks in between. None if it doesn't hold (or there's no task).
    pub fn update_task_if(&self, id: &str, fields: &[(&str, Value)], when: impl FnOnce(&Connection) -> anyhow::Result<bool>) -> anyhow::Result<Option<Task>> {
        let t = {
            let c = self.db();
            if !when(&c)? {
                return Ok(None);
            }
            let old_status = match fields.iter().any(|(k, _)| *k == "status") {
                true => db::get_task(&c, id)?.map(|t| t.status),
                false => None,
            };
            let mut fields = fields.to_vec();
            if let Some(preview) = preview_following_pr(&c, id, &fields)? {
                fields.push(("preview_url", preview));
            }
            let Some(t) = db::update_task(&c, id, &fields)? else { return Ok(None) };
            if let Some(old) = &old_status {
                self.status_changed(&c, &t, old);
            }
            // Under the lock, so two changes are broadcast in the order they were made.
            self.emit_task(&t);
            t
        };
        // A task done with its agents gives up its temp folder.
        if fields.iter().any(|(k, _)| ["status", "running"].contains(k)) {
            self.task_changed(&t);
        }
        // A subproject follows its tasks' columns (and its own agent's).
        if t.kind == "task" && fields.iter().any(|(k, _)| ["status", "running", "attention_reason", "merging", "subproject"].contains(k)) {
            // The task itself is updated either way, so a failure here is only logged.
            let sync = |id: &str| self.sync_subproject(id).unwrap_or_else(|e| {
                tracing::error!("updating subproject {id}'s status: {e:#}");
                None
            });
            if let Some(pid) = &t.parent_id {
                sync(pid);
            }
            if t.subproject {
                return Ok(Some(sync(&t.id).unwrap_or(t)));
            }
        }
        Ok(Some(t))
    }

    /// Move a subproject to the column its tasks put it in (see db::subproject_status). Call
    /// whenever its tasks change other than through `update_task`, e.g. when one is added or deleted.
    /// Returns the subproject if it moved.
    pub fn sync_subproject(&self, id: &str) -> anyhow::Result<Option<Task>> {
        let moved = {
            // One lock for the read and the write, so a concurrent change can't be overwritten.
            let c = self.db();
            let Some(sp) = db::get_task(&c, id)? else { return Ok(None) };
            match db::subproject_status(&sp, &db::subproject_tasks(&c, id)?) {
                Some(st) if st != sp.status => {
                    let moved = db::update_task(&c, id, &[("status", json!(st))])?;
                    if let Some(t) = &moved {
                        self.status_changed(&c, t, &sp.status);
                        self.emit_task(t);
                    }
                    moved
                }
                _ => None,
            }
        };
        if let Some(t) = &moved {
            self.task_changed(t);
        }
        Ok(moved)
    }

    /// Queue the project's status script (see status_script.rs) if the task's status moved,
    /// under the database lock `c` the change was made with.
    fn status_changed(&self, c: &Connection, t: &Task, old: &str) {
        if let Some(me) = self.me.upgrade() {
            crate::status_script::status_changed(&me, c, t, old);
        }
    }

    /// Task `t`'s status or running state changed (see task_tmp::changed), with the database unlocked.
    fn task_changed(&self, t: &Task) {
        if let Some(me) = self.me.upgrade() {
            crate::task_tmp::changed(&me, t);
        }
    }

    pub fn is_running(&self, task_id: &str) -> bool {
        self.runs.lock().unwrap().contains_key(task_id)
    }

    /// App-level scratch folder for a profile.
    pub fn profile_scratch_dir(&self, profile_id: &str) -> PathBuf {
        self.data_dir.join("profiles").join(profile_id).join("scratch")
    }
}

/// The preview URL task `id` gets with `fields`' change to its pull request, when its project
/// previews pull requests (`Project::pr_preview_url`) and the task has no preview URL or the
/// one its old pull request got: one set otherwise (by hand, or in `fields`) stays.
fn preview_following_pr(c: &Connection, id: &str, fields: &[(&str, Value)]) -> anyhow::Result<Option<Value>> {
    let Some((_, pr)) = fields.iter().find(|(k, _)| *k == "pr_url") else { return Ok(None) };
    if fields.iter().any(|(k, _)| *k == "preview_url") {
        return Ok(None);
    }
    let Some(t) = db::get_task(c, id)? else { return Ok(None) };
    let Some(p) = t.project_id.as_deref().map(|pid| db::get_project(c, pid)).transpose()?.flatten() else { return Ok(None) };
    if p.pr_preview_url.is_none() || t.preview_url.is_some() && t.preview_url != p.preview_for(t.pr_url.as_deref()) {
        return Ok(None);
    }
    let preview = p.preview_for(pr.as_str());
    Ok((preview != t.preview_url).then(|| json!(preview)))
}

/// The lock on `AppState`'s database. Derefs to the connection.
pub struct DbGuard<'a> {
    guard: MutexGuard<'a, Connection>,
    #[cfg(any(test, debug_assertions))]
    key: usize,
}

impl Deref for DbGuard<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        &self.guard
    }
}

impl DerefMut for DbGuard<'_> {
    fn deref_mut(&mut self) -> &mut Connection {
        &mut self.guard
    }
}

#[cfg(any(test, debug_assertions))]
impl Drop for DbGuard<'_> {
    fn drop(&mut self) {
        held::release(self.key);
    }
}

/// Which databases this thread has locked. A guard can't move to another thread (it isn't
/// `Send`), so it's released on the thread that claimed it.
#[cfg(any(test, debug_assertions))]
mod held {
    use std::cell::RefCell;

    thread_local! {
        static HELD: RefCell<Vec<usize>> = const { RefCell::new(Vec::new()) };
    }

    pub fn claim<T>(lock: &T) -> usize {
        let key = lock as *const T as usize;
        HELD.with_borrow_mut(|held| {
            if held.contains(&key) {
                panic!("db() locked twice on this thread: drop the first guard before calling db() again");
            }
            held.push(key);
        });
        key
    }

    pub fn release(key: usize) {
        HELD.with_borrow_mut(|held| held.retain(|k| *k != key));
    }
}

// ---------- API errors ----------

#[derive(Debug)]
pub struct ApiError(pub StatusCode, pub String);

pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub fn bad(msg: impl Into<String>) -> Self {
        Self(StatusCode::BAD_REQUEST, msg.into())
    }
    pub fn not_found(what: &str) -> Self {
        Self(StatusCode::NOT_FOUND, format!("{what} not found"))
    }
    pub fn conflict(msg: impl Into<String>) -> Self {
        Self(StatusCode::CONFLICT, msg.into())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, axum::Json(json!({"error": self.1}))).into_response()
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        Self(StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}"))
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(e: rusqlite::Error) -> Self {
        Self(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use crate::testing;

    #[test]
    fn db_locks_one_at_a_time() {
        let s = testing::state();
        let a = s.db().query_row("SELECT 1", [], |r| r.get::<_, i64>(0)).unwrap();
        let b = s.db().query_row("SELECT 2", [], |r| r.get::<_, i64>(0)).unwrap();
        assert_eq!((a, b), (1, 2));
        // Another thread waits for the lock rather than panicking.
        let c = s.db();
        let other = std::thread::spawn({
            let s = s.clone();
            move || s.db().query_row("SELECT 3", [], |r| r.get::<_, i64>(0)).unwrap()
        });
        drop(c);
        assert_eq!(other.join().unwrap(), 3);
    }

    #[test]
    fn locking_db_twice_on_a_thread_panics_instead_of_hanging() {
        testing::run(async || {
            let s = testing::state();
            // Both guards live until the end of the statement. Caught here rather than with `should_panic`, so that
            // IA_KEEP_TEST_DIRS doesn't count the test as failed.
            let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _ = (s.db().is_autocommit(), s.db().is_autocommit());
            }))
            .unwrap_err();
            assert_eq!(panic.downcast_ref::<&str>(), Some(&"db() locked twice on this thread: drop the first guard before calling db() again"));
        });
    }
}
