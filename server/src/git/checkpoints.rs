//! Checkpoints of a task's worktree (API 70), to see what each of its agent's turns changed and to
//! rewind the task to before one of them.
//!
//! A checkpoint is a commit of everything in the worktree that git doesn't ignore (tracked files as
//! they are on disk, and untracked ones), whose parent is the worktree's HEAD then, kept under
//! `refs/huntaway/checkpoints/<task>/<n>`. It's made with a scratch index (a copy of the worktree's
//! own, in `GIT_INDEX_FILE`), `git add -A`, `write-tree` and `commit-tree`, so the worktree's
//! index, branch and stashes are never touched. One is taken before each run starts, when the
//! files or HEAD have changed since the last one (the first run's is the task's baseline), and one
//! when each of the agent's turns ends, including turns that were stopped or failed. Each is a row
//! of `checkpoints`, which ties a turn's to its run, its number and the message that started it.
//! Only tasks with a worktree of their own get them: the others work in their project's repository.
//!
//! A turn's changes are what differs between the checkpoint it started from and its own, without
//! the files git brought in during the turn (a merge, pull or rebase) that the turn didn't change
//! itself (see `brought_in`).
//!
//! Rewinding to before one of the user's messages restores the files to the checkpoint its turn
//! started from (see `restore`), can move the branch back, and can have the agent's next run take
//! its conversation back to before that message (see `Rewind`). The checkpoints taken after it are
//! marked stale. Captures, rewinds and dropping a task's checkpoints run one at a time per task, in
//! the order they were asked for (see `enqueue`).

use std::collections::{BTreeSet, HashMap, HashSet};
use std::ffi::OsStr;
use std::future::Future;
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::{LazyLock, Mutex};

use anyhow::{Context, Result, anyhow, bail};
use axum::Json;
use axum::extract::{Path as UrlPath, Query, State};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};

use crate::db::{self, Run, Task};
use crate::state::{ApiError, ApiResult, Shared};
use crate::util::{new_id, now, truncate};

mod git;
mod capture;
mod changed;
mod handlers;
mod restore;

pub use git::*;
pub use capture::*;
pub use handlers::*;
pub use restore::*;
use changed::*;

/// Checkpoints a task keeps; the oldest go first.
pub const MAX_CHECKPOINTS: usize = 200;
/// Untracked files bigger than this are left out of checkpoints.
const MAX_UNTRACKED_FILE: u64 = 50 << 20;
/// With more untracked files than this (a folder that should be ignored, say), no checkpoint is taken.
const MAX_UNTRACKED: usize = 20_000;
/// Commits a turn can bring in before its changes are shown without leaving any out.
const MAX_COMMITS: usize = 5000;
/// Past this a diff isn't sent.
const MAX_DIFF: usize = 4 << 20;

pub fn ref_prefix(task_id: &str) -> String {
    format!("refs/huntaway/checkpoints/{task_id}/")
}

fn ref_name(task_id: &str, n: i64) -> String {
    format!("{}{n}", ref_prefix(task_id))
}

/// A conversation rollback that a task's next run makes, after a rewind (`tasks.rewind`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Rewind {
    /// The turn it goes back to before.
    pub turn: i64,
    /// The message that turn started with.
    pub message_id: i64,
    /// The agent's session (Claude) or thread (Codex) it's for: a run on another one leaves it.
    pub session: String,
    /// Claude: resume the session at this message (`--resume-session-at`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_at: Option<String>,
    /// Codex: revert the thread to before this turn (`thread/revert`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_turn: Option<String>,
}

/// A checkpoint, as `checkpoints` keeps it.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Checkpoint {
    pub n: i64,
    /// start (before a run), turn (after one of the agent's turns) or rewind (the files a rewind replaced).
    pub kind: String,
    pub sha: String,
    pub tree: String,
    /// The worktree's HEAD then (None before its first commit).
    pub head: Option<String>,
    /// A turn's: the checkpoint it started from.
    pub before_n: Option<i64>,
    pub run_id: Option<String>,
    /// A turn's number among the task's.
    pub turn: Option<i64>,
    /// A turn's: the user message it started with.
    pub message_id: Option<i64>,
    /// A turn's: done, stopped or failed.
    pub status: Option<String>,
    /// The agent's session (Claude) or thread (Codex) then.
    pub session: Option<String>,
    /// A turn's place in the agent's conversation: Claude's last message in it (to resume after the
    /// turn), Codex's id for the turn (to revert to before it).
    pub agent_at: Option<String>,
    pub stats: Option<Stats>,
    /// 0, 1 once a rewind has gone back to before it, 2 when that took the conversation back too.
    pub stale: i64,
    pub created_at: String,
}

/// What a turn changed, without the files git brought in.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Stats {
    pub files: usize,
    pub additions: u64,
    pub deletions: u64,
    /// Files git brought in that are left out (the first 200), and how many there are.
    #[serde(default)]
    pub excluded: Vec<String>,
    #[serde(default)]
    pub excluded_count: usize,
}

impl Checkpoint {
    fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            n: r.get("n")?,
            kind: r.get("kind")?,
            sha: r.get("sha")?,
            tree: r.get("tree")?,
            head: r.get("head")?,
            before_n: r.get("before_n")?,
            run_id: r.get("run_id")?,
            turn: r.get("turn")?,
            message_id: r.get("message_id")?,
            status: r.get("status")?,
            session: r.get("session")?,
            agent_at: r.get("agent_at")?,
            stats: r.get::<_, Option<String>>("stats")?.and_then(|s| serde_json::from_str(&s).ok()),
            stale: r.get("stale")?,
            created_at: r.get("created_at")?,
        })
    }
}

/// A task's checkpoints, oldest first.
pub fn list(c: &Connection, task_id: &str) -> Result<Vec<Checkpoint>> {
    let mut st = c.prepare("SELECT * FROM checkpoints WHERE task_id=?1 ORDER BY n")?;
    let rows = st.query_map([task_id], Checkpoint::from_row)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// The latest checkpoint a rewind hasn't gone back past: where the next turn starts from.
fn latest(c: &Connection, task_id: &str) -> Result<Option<Checkpoint>> {
    Ok(c.query_row("SELECT * FROM checkpoints WHERE task_id=?1 AND stale=0 ORDER BY n DESC LIMIT 1", [task_id], Checkpoint::from_row).optional()?)
}

fn insert(c: &Connection, task_id: &str, cp: &Checkpoint) -> Result<()> {
    c.execute(
        "INSERT INTO checkpoints (task_id,n,kind,sha,tree,head,before_n,run_id,turn,message_id,status,session,agent_at,stats,stale,created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
        params![
            task_id,
            cp.n,
            cp.kind,
            cp.sha,
            cp.tree,
            cp.head,
            cp.before_n,
            cp.run_id,
            cp.turn,
            cp.message_id,
            cp.status,
            cp.session,
            cp.agent_at,
            cp.stats.as_ref().map(|s| serde_json::to_string(s).unwrap_or_default()),
            cp.stale,
            cp.created_at,
        ],
    )?;
    Ok(())
}

// ---------- the queue ----------

type Job = Box<dyn FnOnce(Shared) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send>;

/// Each task's jobs waiting, and the worker taking them in turn.
static QUEUES: LazyLock<Mutex<HashMap<String, mpsc::UnboundedSender<Job>>>> = LazyLock::new(Default::default);

/// Run `job` after the task's jobs asked for before it.
fn enqueue(state: &Shared, task_id: &str, job: Job) {
    let mut queues = QUEUES.lock().unwrap();
    let job = match queues.get(task_id) {
        Some(tx) => match tx.send(job) {
            Ok(()) => return,
            // Its worker is gone (a job panicked).
            Err(e) => e.0,
        },
        None => job,
    };
    let (tx, rx) = mpsc::unbounded_channel();
    let _ = tx.send(job);
    queues.insert(task_id.to_string(), tx);
    tokio::spawn(work(state.clone(), task_id.to_string(), rx));
}

async fn work(state: Shared, task_id: String, mut rx: mpsc::UnboundedReceiver<Job>) {
    loop {
        let job = match rx.try_recv() {
            Ok(job) => job,
            Err(_) => {
                // Nothing waiting: the worker goes, unless a job came in meanwhile.
                let mut queues = QUEUES.lock().unwrap();
                match rx.try_recv() {
                    Ok(job) => job,
                    Err(_) => {
                        queues.remove(&task_id);
                        return;
                    }
                }
            }
        };
        job(state.clone()).await;
    }
}

/// Run `f` in the task's queue and wait for it.
async fn queued<T, F, Fut>(state: &Shared, task_id: &str, f: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(Shared) -> Fut + Send + 'static,
    Fut: Future<Output = T> + Send + 'static,
{
    let (tx, rx) = oneshot::channel();
    enqueue(
        state,
        task_id,
        Box::new(move |s| {
            Box::pin(async move {
                let _ = tx.send(f(s).await);
            })
        }),
    );
    rx.await.map_err(|_| anyhow!("the task's checkpoint work stopped"))
}

// ---------- runs ----------

/// The conversation rollback to make in a run of `task` on its session, if there's one for it.
pub fn pending_rewind(task: &Task) -> Option<&Rewind> {
    task.rewind.as_ref().filter(|r| task.session_id.as_deref() == Some(r.session.as_str()))
}

/// For tests: a task's checkpoints once the ones asked for are taken.
#[cfg(test)]
pub async fn settled(state: &Shared, task_id: &str) -> Vec<Checkpoint> {
    let id = task_id.to_string();
    queued(state, task_id, move |s| async move { list(&s.db(), &id).unwrap() }).await.unwrap()
}

#[cfg(test)]
mod tests;
