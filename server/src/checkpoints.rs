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

// ---------- git ----------

struct Out {
    ok: bool,
    stdout: Vec<u8>,
    stderr: String,
}

impl Out {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).trim().to_string()
    }
}

/// Runs git at `dir` with `env` and `input` on its stdin, never with a git environment the server
/// may have been started with.
async fn run(dir: &Path, args: &[&str], env: &[(&str, &OsStr)], input: Option<&[u8]>) -> Result<Out> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir).args(args);
    for k in ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR", "GIT_NAMESPACE"] {
        cmd.env_remove(k);
    }
    cmd.env("GIT_TERMINAL_PROMPT", "0").env("GIT_OPTIONAL_LOCKS", "0");
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = cmd.spawn().context("failed to run git")?;
    let stdin = child.stdin.take();
    let write = async {
        if let (Some(mut w), Some(bytes)) = (stdin, input) {
            let _ = w.write_all(bytes).await;
        }
    };
    let (_, out) = tokio::join!(write, child.wait_with_output());
    let out = out.context("failed to run git")?;
    Ok(Out { ok: out.status.success(), stdout: out.stdout, stderr: String::from_utf8_lossy(&out.stderr).trim().to_string() })
}

async fn run_ok(dir: &Path, args: &[&str], env: &[(&str, &OsStr)], input: Option<&[u8]>) -> Result<Out> {
    let o = run(dir, args, env, input).await?;
    if !o.ok {
        bail!("git {} failed: {}", args.first().copied().unwrap_or(""), o.stderr);
    }
    Ok(o)
}

fn split_nul(bytes: &[u8]) -> impl Iterator<Item = &[u8]> {
    bytes.split(|b| *b == 0).filter(|p| !p.is_empty())
}

fn lossy(p: &[u8]) -> String {
    String::from_utf8_lossy(p).into_owned()
}

/// NUL-terminated paths, as `--stdin -z` and `--pathspec-file-nul` take them.
fn nul_list<'a>(paths: impl IntoIterator<Item = &'a [u8]>) -> Vec<u8> {
    let mut out = Vec::new();
    for p in paths {
        out.extend_from_slice(p);
        out.push(0);
    }
    out
}

/// An index of our own in the worktree's git directory, removed once dropped.
struct ScratchIndex(PathBuf);

impl ScratchIndex {
    /// A copy of the worktree's index (so `git add` only looks again at what changed), or an empty one.
    async fn new(top: &Path, copy: bool) -> Result<Self> {
        let index = PathBuf::from(run_ok(top, &["rev-parse", "--path-format=absolute", "--git-path", "index"], &[], None).await?.text());
        let dir = index.parent().context("the worktree's index has no folder")?;
        let path = dir.join(format!("huntaway-checkpoint-{}.index", new_id()));
        let scratch = Self(path);
        if copy {
            match tokio::fs::copy(&index, &scratch.0).await {
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e).context("copying the worktree's index"),
            }
        }
        Ok(scratch)
    }

    fn env(&self) -> [(&'static str, &OsStr); 1] {
        [("GIT_INDEX_FILE", self.0.as_os_str())]
    }
}

impl Drop for ScratchIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        let mut lock = self.0.clone().into_os_string();
        lock.push(".lock");
        let _ = std::fs::remove_file(lock);
    }
}

/// A snapshot of a worktree's files.
#[derive(Clone, Debug, PartialEq)]
pub struct Snap {
    pub sha: String,
    pub tree: String,
    pub head: Option<String>,
}

const IDENTITY: [(&str, &str); 4] =
    [("GIT_AUTHOR_NAME", "Huntaway"), ("GIT_AUTHOR_EMAIL", "huntaway@localhost"), ("GIT_COMMITTER_NAME", "Huntaway"), ("GIT_COMMITTER_EMAIL", "huntaway@localhost")];

async fn head(top: &Path) -> Result<Option<String>> {
    let o = run(top, &["rev-parse", "-q", "--verify", "HEAD^{commit}"], &[], None).await?;
    Ok(o.ok.then(|| o.text()).filter(|h| !h.is_empty()))
}

/// The tree of everything in the worktree at `top` that git doesn't ignore, and its HEAD, as a
/// commit (`last`'s, when nothing has changed since it).
async fn snapshot(top: &Path, last: Option<&Checkpoint>) -> Result<Snap> {
    // Before the files, so a commit made meanwhile shows up in the files rather than only in HEAD.
    let head = head(top).await?;
    let scratch = ScratchIndex::new(top, true).await?;
    let env = scratch.env();
    let untracked = run_ok(top, &["ls-files", "-z", "--others", "--exclude-standard"], &env, None).await?;
    let untracked: Vec<&[u8]> = split_nul(&untracked.stdout).collect();
    if untracked.len() > MAX_UNTRACKED {
        bail!("the worktree has {} untracked files, too many to take a checkpoint of (should some be ignored?)", untracked.len());
    }
    let mut spec = b".\0".to_vec();
    for p in untracked {
        let big = std::fs::symlink_metadata(top.join(OsStr::from_bytes(p))).is_ok_and(|m| m.is_file() && m.len() > MAX_UNTRACKED_FILE);
        if big {
            spec.extend_from_slice(b":(exclude,literal)");
            spec.extend_from_slice(p);
            spec.push(0);
        }
    }
    // A file that can't be read is left out, rather than the whole checkpoint.
    let added = run(top, &["-c", "core.splitIndex=false", "add", "-A", "--ignore-errors", "--pathspec-from-file=-", "--pathspec-file-nul"], &env, Some(&spec)).await?;
    if !added.ok {
        tracing::warn!(dir = %top.display(), "git add for a checkpoint: {}", added.stderr);
    }
    let tree = run_ok(top, &["write-tree"], &env, None).await?.text();
    drop(scratch);
    if let Some(l) = last.filter(|l| l.tree == tree && l.head == head) {
        return Ok(Snap { sha: l.sha.clone(), tree, head });
    }
    let mut args = vec!["commit-tree", "--no-gpg-sign", "-m", "Huntaway checkpoint"];
    if let Some(h) = &head {
        args.extend(["-p", h.as_str()]);
    }
    args.push(&tree);
    let env: Vec<(&str, &OsStr)> = IDENTITY.iter().map(|(k, v)| (*k, OsStr::new(*v))).collect();
    let sha = run_ok(top, &args, &env, None).await?.text();
    Ok(Snap { sha, tree, head })
}

/// The top of a task's own worktree, if it has one that's ready.
async fn worktree_top(state: &Shared, task_id: &str) -> Result<Option<PathBuf>> {
    let Some(task) = db::get_task(&state.db(), task_id)? else { return Ok(None) };
    let Some(wt) = own_worktree(state, &task) else { return Ok(None) };
    let o = run(&wt, &["rev-parse", "--show-toplevel"], &[], None).await?;
    Ok(o.ok.then(|| PathBuf::from(o.text())))
}

/// The worktree a task's checkpoints are of: its own, once it's set up. Not a review thread's (it
/// works in its task's) nor a document's or scratch task's (they work in folders of their own).
fn own_worktree(state: &Shared, task: &Task) -> Option<PathBuf> {
    if task.kind != "task" || !task.use_worktree || task.worktree_state != "ready" || crate::documents::work_dir(state, task).is_some() {
        return None;
    }
    task.worktree_path.as_deref().map(crate::util::expand_tilde).filter(|p| p.is_dir())
}

/// Store `snap` as the task's next checkpoint: its ref, then its row.
async fn keep(state: &Shared, task_id: &str, top: &Path, snap: &Snap, cp: impl FnOnce(i64) -> Checkpoint) -> Result<Checkpoint> {
    let n: i64 = state.db().query_row("SELECT COALESCE(MAX(n), -1) + 1 FROM checkpoints WHERE task_id=?1", [task_id], |r| r.get(0))?;
    let name = ref_name(task_id, n);
    run_ok(top, &["update-ref", &name, &snap.sha], &[], None).await?;
    let cp = cp(n);
    let inserted = insert(&state.db(), task_id, &cp);
    if let Err(e) = inserted {
        let _ = run(top, &["update-ref", "-d", &name], &[], None).await;
        return Err(e);
    }
    Ok(cp)
}

/// Drop a task's oldest checkpoints past MAX_CHECKPOINTS.
async fn prune(state: &Shared, task_id: &str, top: &Path) -> Result<()> {
    let old: Vec<i64> = {
        let c = state.db();
        let mut st = c.prepare("SELECT n FROM checkpoints WHERE task_id=?1 ORDER BY n DESC LIMIT -1 OFFSET ?2")?;
        st.query_map(params![task_id, MAX_CHECKPOINTS as i64], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?
    };
    if old.is_empty() {
        return Ok(());
    }
    let input: String = old.iter().map(|n| format!("delete {}\n", ref_name(task_id, *n))).collect();
    run_ok(top, &["update-ref", "--stdin"], &[], Some(input.as_bytes())).await?;
    let c = state.db();
    for n in old {
        c.execute("DELETE FROM checkpoints WHERE task_id=?1 AND n=?2", params![task_id, n])?;
    }
    Ok(())
}

// ---------- taking them ----------

/// Whether a run of `task` takes checkpoints.
fn wanted(state: &Shared, task: &Task, run: &Run) -> bool {
    run.kind != "compact" && own_worktree(state, task).is_some()
}

/// Before a run of `task` starts (its worktree set up): a checkpoint, if the files or HEAD have
/// changed since the last one.
pub async fn before_run(state: &Shared, task: &Task, run: &Run) {
    if !wanted(state, task, run) {
        return;
    }
    let (task_id, run_id, session) = (task.id.clone(), run.id.clone(), task.session_id.clone());
    let done = queued(state, &task.id, move |s| async move {
        let top = worktree_top(&s, &task_id).await?.context("no worktree")?;
        let last = latest(&s.db(), &task_id)?;
        let snap = snapshot(&top, last.as_ref()).await?;
        if last.as_ref().is_some_and(|l| l.tree == snap.tree && l.head == snap.head) {
            return Ok(());
        }
        keep(&s, &task_id, &top, &snap, |n| Checkpoint {
            n,
            kind: "start".into(),
            sha: snap.sha.clone(),
            tree: snap.tree.clone(),
            head: snap.head.clone(),
            before_n: None,
            run_id: Some(run_id),
            turn: None,
            message_id: None,
            status: None,
            session,
            agent_at: None,
            stats: None,
            stale: 0,
            created_at: now(),
        })
        .await?;
        prune(&s, &task_id, &top).await
    })
    .await;
    if let Err(e) = done.and_then(|r| r) {
        tracing::warn!(task = %task.id, "couldn't take a checkpoint before the run: {e:#}");
    }
}

/// One of the agent's turns in run `run_id` ended (`status`: done, stopped or failed): a checkpoint
/// of what it left, taken in the background.
pub fn after_turn(state: &Shared, run_id: &str, status: &str) {
    let found = (|| {
        let c = state.db();
        let Some(run) = db::get_run(&c, run_id)? else { return Ok(None) };
        let task = db::get_task(&c, &run.task_id)?;
        anyhow::Ok(task.map(|t| (run, t)))
    })();
    let (run, task) = match found {
        Ok(Some(found)) => found,
        Ok(None) => return,
        Err(e) => return tracing::warn!(run = run_id, "couldn't look up a run for its checkpoint: {e:#}"),
    };
    // A turn the agent starts by itself (a background task finishing, say) didn't start with a message.
    let _ = state.db().execute("UPDATE runs SET turn_message_id=NULL WHERE id=?1", [run_id]);
    if !wanted(state, &task, &run) {
        return;
    }
    let task_id = task.id.clone();
    let status = status.to_string();
    let job = move |s: Shared| async move {
        let taken = async {
            let top = worktree_top(&s, &task_id).await?.context("no worktree")?;
            let before = latest(&s.db(), &task_id)?;
            let snap = snapshot(&top, before.as_ref()).await?;
            let stats = match &before {
                Some(b) => match stats(&top, b, &snap).await {
                    Ok(st) => Some(st),
                    Err(e) => {
                        tracing::warn!(task = %task_id, "couldn't count a turn's changes: {e:#}");
                        None
                    }
                },
                None => None,
            };
            let turn: i64 = s.db().query_row("SELECT COALESCE(MAX(turn), 0) + 1 FROM checkpoints WHERE task_id=?1", [&task_id], |r| r.get(0))?;
            keep(&s, &task_id, &top, &snap, |n| Checkpoint {
                n,
                kind: "turn".into(),
                sha: snap.sha.clone(),
                tree: snap.tree.clone(),
                head: snap.head.clone(),
                before_n: before.map(|b| b.n),
                run_id: Some(run.id),
                turn: Some(turn),
                message_id: run.turn_message_id,
                status: Some(status),
                session: task.session_id,
                agent_at: run.agent_at,
                stats,
                stale: 0,
                created_at: now(),
            })
            .await?;
            prune(&s, &task_id, &top).await?;
            s.emit(json!({"type": "checkpoints", "task_id": task_id}));
            anyhow::Ok(())
        };
        if let Err(e) = taken.await {
            tracing::warn!(task = %task_id, "couldn't take a checkpoint after a turn: {e:#}");
        }
    };
    enqueue(state, &task.id, Box::new(move |s| Box::pin(job(s))));
}

/// Drop the task's checkpoints (its worktree at `dir` is going), after any being taken.
pub async fn forget(state: &Shared, task_id: &str, dir: &Path) {
    let id = task_id.to_string();
    let dir = dir.to_path_buf();
    let done = queued(state, task_id, move |s| async move {
        let refs = run_ok(&dir, &["for-each-ref", "--format=delete %(refname)", &ref_prefix(&id)], &[], None).await?;
        if !refs.stdout.is_empty() {
            run_ok(&dir, &["update-ref", "--stdin"], &[], Some(&refs.stdout)).await?;
        }
        s.db().execute("DELETE FROM checkpoints WHERE task_id=?1", [&id])?;
        anyhow::Ok(())
    })
    .await;
    if let Err(e) = done.and_then(|r| r) {
        tracing::warn!(task = task_id, "couldn't drop the task's checkpoints: {e:#}");
    }
}

// ---------- what turns changed ----------

/// What the reflog says about how HEAD got to each commit: whether it was made in this worktree
/// (committed, amended, picked, merged) rather than moved to (a fast-forward, reset or checkout).
fn creates_commit(subject: &str) -> bool {
    let action = subject.split(':').next().unwrap_or("");
    action.starts_with("commit")
        || action.starts_with("cherry-pick")
        || action.starts_with("revert")
        || action == "am"
        || ["(pick)", "(reword)", "(edit)", "(squash)", "(fixup)", "(continue)"].iter().any(|a| action.ends_with(a))
        || subject.contains(": Merge made by")
}

/// The commits made in the worktree at `top`, from its HEAD's reflog (None if it has none).
async fn made_here(top: &Path) -> Result<Option<HashSet<String>>> {
    let o = run(top, &["log", "-g", "-n", "20000", "--format=%H%x1f%gs", "HEAD", "--"], &[], None).await?;
    if !o.ok {
        return Ok(None);
    }
    let text = String::from_utf8_lossy(&o.stdout);
    let made: HashSet<String> = text.lines().filter_map(|l| l.split_once('\x1f')).filter(|(_, s)| creates_commit(s)).map(|(h, _)| h.to_string()).collect();
    Ok((!text.trim().is_empty()).then_some(made))
}

/// The paths each commit changed against the parent given with it (`commit [parent]` lines).
async fn changed_by(top: &Path, pairs: &[(String, Option<String>)]) -> Result<BTreeSet<Vec<u8>>> {
    if pairs.is_empty() {
        return Ok(BTreeSet::new());
    }
    let input: String = pairs.iter().map(|(c, p)| format!("{c}{}\n", p.as_ref().map(|p| format!(" {p}")).unwrap_or_default())).collect();
    let o = run_ok(top, &["diff-tree", "--stdin", "-r", "--root", "--name-only", "-z", "--no-commit-id", "--no-renames"], &[], Some(input.as_bytes())).await?;
    Ok(split_nul(&o.stdout).map(<[u8]>::to_vec).collect())
}

async fn names(top: &Path, from: &str, to: &str) -> Result<BTreeSet<Vec<u8>>> {
    let o = run_ok(top, &["diff-tree", "-r", "-z", "--name-only", "--no-renames", from, to], &[], None).await?;
    Ok(split_nul(&o.stdout).map(<[u8]>::to_vec).collect())
}

/// The files git brought in between two checkpoints of the worktree at `top` (from HEAD
/// `from_head` to HEAD `to_head` and the files `to_tree`) that weren't changed in the worktree
/// itself: those changed by commits HEAD moved to rather than made here (a pull, a fast-forward
/// merge, the commits a rebase went onto) and by merges made here, except where a merge's result
/// isn't git's own (conflicts resolved), where a commit made here changed them too, or where
/// they're changed and not committed.
async fn brought_in(top: &Path, from_head: Option<&str>, to_head: Option<&str>, to_tree: &str) -> Result<BTreeSet<Vec<u8>>> {
    let (Some(hb), Some(ha)) = (from_head, to_head) else { return Ok(BTreeSet::new()) };
    if hb == ha {
        return Ok(BTreeSet::new());
    }
    let max = format!("--max-count={}", MAX_COMMITS + 1);
    let list = run_ok(top, &["rev-list", "--parents", &max, ha, &format!("^{hb}"), "--"], &[], None).await?;
    let commits: Vec<Vec<String>> = String::from_utf8_lossy(&list.stdout).lines().map(|l| l.split_whitespace().map(String::from).collect()).filter(|c: &Vec<String>| !c.is_empty()).collect();
    if commits.is_empty() || commits.len() > MAX_COMMITS {
        return Ok(BTreeSet::new());
    }
    // Without a reflog it can't tell: nothing is left out.
    let Some(made) = made_here(top).await? else { return Ok(BTreeSet::new()) };
    let pair = |c: &Vec<String>| (c[0].clone(), c.get(1).cloned());
    let (own, other): (Vec<&Vec<String>>, Vec<&Vec<String>>) = commits.iter().partition(|c| made.contains(&c[0]));
    let merges: Vec<&Vec<String>> = own.iter().copied().filter(|c| c.len() > 2).collect();
    if other.is_empty() && merges.is_empty() {
        return Ok(BTreeSet::new());
    }
    let mut touched = changed_by(top, &own.iter().filter(|c| c.len() <= 2).map(|c| pair(c)).collect::<Vec<_>>()).await?;
    for m in &merges {
        let o = run(top, &["show", "--remerge-diff", "--format=", "--name-only", "-z", &m[0], "--"], &[], None).await?;
        if o.ok {
            touched.extend(split_nul(&o.stdout).map(<[u8]>::to_vec));
        } else {
            // A git from before remerge diffs (2.36): all of the merge counts as the turn's.
            touched.extend(changed_by(top, &[pair(m)]).await?);
        }
    }
    touched.extend(names(top, ha, to_tree).await?);
    let mut pairs: Vec<(String, Option<String>)> = other.iter().map(|c| pair(c)).collect();
    pairs.extend(merges.iter().map(|c| pair(c)));
    let brought = changed_by(top, &pairs).await?;
    Ok(brought.difference(&touched).cloned().collect())
}

/// `git diff --numstat` from `from` to `to` (commits), without `excluded`.
async fn numstat(top: &Path, from: &str, to: &str, excluded: &BTreeSet<Vec<u8>>) -> Result<(Stats, Vec<String>)> {
    let o = run_ok(top, &["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", from, to, "--"], &[], None).await?;
    let mut stats = Stats::default();
    let mut left_out = Vec::new();
    for entry in split_nul(&o.stdout) {
        let mut parts = entry.splitn(3, |b| *b == b'\t');
        let (Some(a), Some(d), Some(path)) = (parts.next(), parts.next(), parts.next()) else { continue };
        if excluded.contains(path) {
            left_out.push(lossy(path));
            continue;
        }
        stats.files += 1;
        stats.additions += std::str::from_utf8(a).ok().and_then(|a| a.parse().ok()).unwrap_or(0);
        stats.deletions += std::str::from_utf8(d).ok().and_then(|d| d.parse().ok()).unwrap_or(0);
    }
    Ok((stats, left_out))
}

/// What a turn changed, from checkpoint `before` to `after`.
async fn stats(top: &Path, before: &Checkpoint, after: &Snap) -> Result<Stats> {
    let excluded = brought_in(top, before.head.as_deref(), after.head.as_deref(), &after.tree).await?;
    let (mut stats, left_out) = numstat(top, &before.sha, &after.sha, &excluded).await?;
    stats.excluded_count = left_out.len();
    stats.excluded = left_out.into_iter().take(200).collect();
    Ok(stats)
}

/// A C-quoted path from a diff header (`"a/x\ty"`), unquoted.
fn unquote(s: &str) -> Option<(String, &str)> {
    let rest = s.strip_prefix('"')?;
    let mut out = Vec::new();
    let mut chars = rest.char_indices();
    while let Some((i, c)) = chars.next() {
        match c {
            '"' => return Some((String::from_utf8_lossy(&out).into_owned(), &rest[i + 1..])),
            '\\' => {
                let (_, e) = chars.next()?;
                match e {
                    'n' => out.push(b'\n'),
                    't' => out.push(b'\t'),
                    'r' => out.push(b'\r'),
                    'a' => out.push(7),
                    'b' => out.push(8),
                    'f' => out.push(12),
                    'v' => out.push(11),
                    '0'..='7' => {
                        let mut v = e.to_digit(8)?;
                        for _ in 0..2 {
                            let (_, d) = chars.next()?;
                            v = v * 8 + d.to_digit(8)?;
                        }
                        out.push(v as u8);
                    }
                    other => {
                        let mut b = [0; 4];
                        out.extend_from_slice(other.encode_utf8(&mut b).as_bytes());
                    }
                }
            }
            c => {
                let mut b = [0; 4];
                out.extend_from_slice(c.encode_utf8(&mut b).as_bytes());
            }
        }
    }
    None
}

/// The path a `diff --git a/<path> b/<path>` line (without renames, so both are the same) is for.
fn header_path(line: &str) -> Option<String> {
    let rest = line.strip_prefix("diff --git ")?;
    if rest.starts_with('"') {
        let (a, _) = unquote(rest)?;
        return a.strip_prefix("a/").map(String::from);
    }
    // `a/<p> b/<p>`: the same path twice.
    let len = rest.len().checked_sub(5)? / 2;
    rest.get(2..2 + len).map(String::from)
}

/// `patch` without the files in `excluded`.
fn without(patch: &str, excluded: &HashSet<String>) -> String {
    if excluded.is_empty() {
        return patch.to_string();
    }
    let mut out = String::with_capacity(patch.len());
    let mut keep = true;
    for line in patch.split_inclusive('\n') {
        if line.starts_with("diff --git ") {
            keep = header_path(line.trim_end_matches('\n')).is_none_or(|p| !excluded.contains(&p));
        }
        if keep {
            out.push_str(line);
        }
    }
    out
}

// ---------- the API ----------

/// The text a message starts with, for a turn's label.
fn message_label(data: &Value) -> String {
    let text = data["user_text"].as_str().or(data["text"].as_str()).unwrap_or("");
    truncate(text.trim(), 300)
}

/// `GET /tasks/{id}/turns`: the task's turns with checkpoints, oldest first, what each changed,
/// and whether each can be rewound to (and its conversation with it).
pub async fn turns(State(s): State<Shared>, UrlPath(id): UrlPath<String>) -> ApiResult<Json<Value>> {
    let task = db::get_task(&s.db(), &id)?.ok_or_else(|| ApiError::not_found("task"))?;
    let Some(top) = worktree_top(&s, &id).await? else {
        let reason = if task.use_worktree { "the task's worktree isn't set up" } else { "the task works in its project's repository, not a worktree of its own" };
        return Ok(Json(json!({"available": false, "reason": reason, "turns": [], "rewind": task.rewind})));
    };
    let rows = list(&s.db(), &id)?;
    let have: HashSet<i64> = {
        let o = run(&top, &["for-each-ref", "--format=%(refname:lstrip=-1)", &ref_prefix(&id)], &[], None).await?;
        String::from_utf8_lossy(&o.stdout).lines().filter_map(|l| l.trim().parse().ok()).collect()
    };
    let ids: Vec<i64> = rows.iter().filter_map(|r| r.message_id).collect();
    let messages: HashMap<i64, Value> = {
        let c = s.db();
        let mut st = c.prepare("SELECT data FROM messages WHERE id=?1 AND task_id=?2")?;
        ids.iter().filter_map(|m| st.query_row(params![m, id], |r| r.get::<_, String>(0)).ok().map(|d| (*m, serde_json::from_str(&d).unwrap_or(Value::Null)))).collect()
    };
    let first_user: Option<i64> = s.db().query_row("SELECT MIN(id) FROM messages WHERE task_id=?1 AND kind='user'", [&id], |r| r.get(0))?;
    let codex = db::task_is_codex(&s.db(), &task)?;
    let running = s.is_running(&id);
    let turns: Vec<Value> = rows
        .iter()
        .filter(|r| r.kind == "turn")
        .map(|r| {
            let before = r.before_n.filter(|b| have.contains(b) && rows.iter().any(|x| x.n == *b));
            let diff = before.is_some() && have.contains(&r.n);
            let m = r.message_id.and_then(|m| messages.get(&m));
            let files = match (before, r.message_id, r.stale) {
                _ if running => Err("the agent is running"),
                (_, _, stale) if stale > 0 => Err("a rewind has gone back to before this turn"),
                (None, _, _) => Err("there's no checkpoint from before this turn"),
                (_, None, _) => Err("the message this turn started with isn't known"),
                _ => Ok(()),
            };
            let conversation = match conversation(&task, &rows, r, codex, first_user) {
                Ok(c) => json!({"ok": true, "fresh": matches!(c, Convo::Fresh)}),
                Err(why) => json!({"ok": false, "reason": why}),
            };
            json!({
                "turn": r.turn,
                "n": r.n,
                "before_n": before,
                "run_id": r.run_id,
                "message_id": r.message_id,
                "text": m.map(message_label).unwrap_or_default(),
                "auto": m.is_some_and(|m| m["auto"] == true),
                "review_round": m.and_then(|m| m["review_round"].as_u64()),
                "status": r.status,
                "stale": r.stale > 0,
                "at": r.created_at,
                "head": r.head,
                "before_head": before.and_then(|b| rows.iter().find(|x| x.n == b)).and_then(|b| b.head.clone()),
                "stats": r.stats,
                "diff": diff,
                "rewind": match files { Ok(()) => json!({"ok": true, "conversation": conversation}), Err(why) => json!({"ok": false, "reason": why}) },
            })
        })
        .collect();
    let head = head(&top).await?;
    Ok(Json(json!({"available": true, "turns": turns, "head": head, "rewind": task.rewind, "agent": if codex { "codex" } else { "claude" }})))
}

#[derive(Deserialize)]
pub struct DiffQuery {
    from: i64,
    to: i64,
}

/// `GET /tasks/{id}/turns/diff?from=&to=`: the changes from checkpoint `from` to `to` (a turn's,
/// or several turns' together), without the files git brought in.
pub async fn diff(State(s): State<Shared>, UrlPath(id): UrlPath<String>, Query(q): Query<DiffQuery>) -> ApiResult<Json<Value>> {
    let top = worktree_top(&s, &id).await?.ok_or_else(|| ApiError::bad("the task has no worktree"))?;
    let rows = list(&s.db(), &id)?;
    let find = |n: i64| rows.iter().find(|r| r.n == n).ok_or_else(|| ApiError::not_found(&format!("checkpoint {n}")));
    let (from, to) = (find(q.from)?, find(q.to)?);
    for r in [from, to] {
        let o = run(&top, &["rev-parse", "-q", "--verify", &format!("{}^{{commit}}", ref_name(&id, r.n))], &[], None).await?;
        if !o.ok || o.text() != r.sha {
            return Err(ApiError::conflict(format!("checkpoint {} is gone from the repository", r.n)));
        }
    }
    let excluded = brought_in(&top, from.head.as_deref(), to.head.as_deref(), &to.tree).await?;
    let (stats, left_out) = numstat(&top, &from.sha, &to.sha, &excluded).await?;
    let o = run_ok(&top, &["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", &from.sha, &to.sha, "--"], &[], None).await?;
    let patch = without(&String::from_utf8_lossy(&o.stdout), &left_out.iter().cloned().collect());
    let too_large = patch.len() > MAX_DIFF;
    Ok(Json(json!({
        "patch": if too_large { String::new() } else { patch },
        "too_large": too_large,
        "stats": stats,
        "excluded": left_out,
    })))
}

/// What a rewind does to the agent's conversation.
#[derive(Debug, PartialEq)]
enum Convo {
    /// There's none yet.
    Nothing,
    /// The message started it: the next one starts a new one.
    Fresh,
    /// Its next run takes it back.
    Back(Rewind),
}

/// How the agent's conversation goes back to before turn `turn` of `rows` (the task's
/// checkpoints), or why it can't. `first_user` is the thread's first user message.
fn conversation(task: &Task, rows: &[Checkpoint], turn: &Checkpoint, codex: bool, first_user: Option<i64>) -> Result<Convo, String> {
    let Some(session) = task.session_id.clone() else { return Ok(Convo::Nothing) };
    let (Some(n), Some(message_id)) = (turn.turn, turn.message_id) else { return Err("the message this turn started with isn't known".into()) };
    let back = |resume_at: Option<String>, before_turn: Option<String>| Convo::Back(Rewind { turn: n, message_id, session: session.clone(), resume_at, before_turn });
    let changed = "the agent's conversation has changed since this message (a new session)";
    // The message started it: the next one starts a new one (with the task's description, as the first does).
    if first_user == Some(message_id) {
        return Ok(Convo::Fresh);
    }
    if codex {
        // Codex reverts the thread to before the turn itself.
        return match (&turn.session, &turn.agent_at) {
            (Some(s), Some(t)) if *s == session => Ok(back(None, Some(t.clone()))),
            (Some(s), _) if *s != session => Err(changed.into()),
            _ => Err("Codex didn't say which of its turns this was".into()),
        };
    }
    // Claude resumes its session at the last message of the turn before, skipping turns already taken out of it.
    for r in rows.iter().rev().filter(|r| r.kind == "turn" && r.n < turn.n && r.stale < 2) {
        if r.session.as_deref() != Some(&session) {
            return Err(changed.into());
        }
        if let Some(at) = &r.agent_at {
            return Ok(back(Some(at.clone()), None));
        }
    }
    Err("the conversation from before this message wasn't recorded (it's from before checkpoints were taken)".into())
}

#[derive(Deserialize)]
pub struct RewindBody {
    /// The user message to rewind to before.
    message_id: i64,
    /// Take the agent's conversation back too.
    #[serde(default)]
    conversation: bool,
    /// Move the branch back to where it was, if commits have been made since.
    #[serde(default)]
    branch: bool,
}

/// `POST /tasks/{id}/rewind {message_id, conversation, branch}`: restore the task's files to the
/// checkpoint from before the turn `message_id` started, and optionally its branch and its agent's
/// conversation (on its next run). Refused while its agent or a review of it is running.
pub async fn rewind(State(s): State<Shared>, UrlPath(id): UrlPath<String>, Json(b): Json<RewindBody>) -> ApiResult<Json<Value>> {
    db::get_task(&s.db(), &id)?.ok_or_else(|| ApiError::not_found("task"))?;
    let task_id = id.clone();
    let out = queued(&s, &id, move |s| async move { rewind_now(&s, &task_id, &b).await }).await??;
    Ok(Json(out))
}

fn busy(state: &Shared, task_id: &str) -> Result<Option<&'static str>> {
    if state.is_running(task_id) {
        return Ok(Some("The agent is running: stop it before rewinding"));
    }
    let reviews = db::review_threads(&state.db(), task_id)?;
    if reviews.iter().any(|r| r.running || state.is_running(&r.id)) {
        return Ok(Some("A review of the task is running in its worktree: wait for it or stop it first"));
    }
    Ok(None)
}

async fn rewind_now(state: &Shared, task_id: &str, b: &RewindBody) -> ApiResult<Value> {
    let task = db::get_task(&state.db(), task_id)?.ok_or_else(|| ApiError::not_found("task"))?;
    if let Some(why) = busy(state, task_id)? {
        return Err(ApiError::conflict(why));
    }
    let top = worktree_top(state, task_id).await?.ok_or_else(|| ApiError::bad("the task has no worktree of its own to rewind"))?;
    let git_dir = PathBuf::from(run_ok(&top, &["rev-parse", "--absolute-git-dir"], &[], None).await?.text());
    if ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD"].iter().any(|f| git_dir.join(f).exists()) {
        return Err(ApiError::conflict("A merge, rebase or cherry-pick is in progress in the worktree: finish or abort it first"));
    }
    let rows = list(&state.db(), task_id)?;
    // The first turn the message started (the agent may have gone on by itself after it).
    let turn = rows
        .iter()
        .find(|r| r.kind == "turn" && r.message_id == Some(b.message_id) && r.stale == 0)
        .ok_or_else(|| ApiError::bad("there's no checkpoint for this message's turn (or a rewind has gone back past it)"))?;
    let before = turn.before_n.and_then(|n| rows.iter().find(|r| r.n == n)).ok_or_else(|| ApiError::conflict("there's no checkpoint from before this turn"))?;
    let o = run(&top, &["rev-parse", "-q", "--verify", &format!("{}^{{commit}}", ref_name(task_id, before.n))], &[], None).await?;
    if !o.ok || o.text() != before.sha {
        return Err(ApiError::conflict("the checkpoint from before this turn is gone from the repository"));
    }
    let convo = if b.conversation {
        let first_user: Option<i64> = state.db().query_row("SELECT MIN(id) FROM messages WHERE task_id=?1 AND kind='user'", [task_id], |r| r.get(0))?;
        let codex = db::task_is_codex(&state.db(), &task)?;
        conversation(&task, &rows, turn, codex, first_user).map_err(|why| ApiError::conflict(format!("Can't take the conversation back: {why}")))?
    } else {
        Convo::Nothing
    };

    // The files as they are now, kept (stale) so the rewind can be undone by hand.
    let last = latest(&state.db(), task_id)?;
    let snap = snapshot(&top, last.as_ref()).await?;
    let kept = keep(state, task_id, &top, &snap, |n| Checkpoint {
        n,
        kind: "rewind".into(),
        sha: snap.sha.clone(),
        tree: snap.tree.clone(),
        head: snap.head.clone(),
        before_n: None,
        run_id: None,
        turn: None,
        message_id: None,
        status: None,
        session: task.session_id.clone(),
        agent_at: None,
        stats: None,
        stale: 1,
        created_at: now(),
    })
    .await?;

    // The branch goes back once the files have: checked first, so a refusal leaves everything as it was.
    let moved = match (&before.head, &snap.head) {
        (Some(old), Some(cur)) if b.branch && old != cur => {
            let ancestor = run(&top, &["merge-base", "--is-ancestor", old, cur], &[], None).await?.ok;
            if !ancestor {
                return Err(ApiError::conflict("The branch has been rewritten since (a rebase or reset), so it can't be moved back: rewind the files only"));
            }
            Some((old.clone(), cur.clone()))
        }
        _ => None,
    };
    let kept_ref = ref_name(task_id, kept.n);
    let failed = |e: anyhow::Error| ApiError::conflict(format!("The rewind stopped part way: {e:#}. The files as they were are kept in {kept_ref} ({}).", kept.sha));
    let restored = restore(&top, &snap.tree, &before.tree).await.map_err(failed)?;
    let mut unstage = restored.changed.clone();
    if let Some((old, cur)) = &moved {
        run_ok(&top, &["reset", "-q", "--soft", old], &[], None).await.map_err(failed)?;
        unstage.extend(names(&top, old, cur).await.map_err(failed)?.into_iter().filter(|p| !restored.hidden.contains(p)));
    }
    unstaged(&top, &unstage).await.map_err(failed)?;

    let stale = if matches!(convo, Convo::Nothing) { 1 } else { 2 };
    state.db().execute("UPDATE checkpoints SET stale=MAX(stale, ?3) WHERE task_id=?1 AND n>?2 AND n<>?4", params![task_id, before.n, stale, kept.n])?;
    let n = turn.turn.unwrap_or(0);
    let said_convo = match &convo {
        Convo::Nothing if b.conversation => "; the agent had no conversation to take back",
        Convo::Nothing => "; the agent's conversation is kept as it is",
        Convo::Fresh => "; the next message starts a new conversation",
        Convo::Back(_) => "; the agent's next run goes on from before that message",
    };
    let fields: Vec<(&str, Value)> = match convo {
        Convo::Nothing => vec![],
        Convo::Fresh => vec![("session_id", Value::Null), ("rewind", Value::Null), ("context", Value::Null)],
        Convo::Back(r) => vec![("rewind", serde_json::to_value(r).unwrap_or(Value::Null))],
    };
    state.update_task(task_id, &fields)?;
    let branch = moved.as_ref().map(|(old, cur)| format!("; the branch is back at {} (from {})", &old[..old.len().min(8)], &cur[..cur.len().min(8)])).unwrap_or_default();
    let mut detail = format!("The files as they were are kept in {} ({}).", ref_name(task_id, kept.n), kept.sha);
    if !restored.skipped.is_empty() {
        detail.push_str(&format!(
            "\nLeft as they are (submodules and other repositories, files marked skip-worktree or assume-unchanged, and files or folders the \
             checkpoints don't have, such as ignored ones): {}",
            restored.skipped.join(", ")
        ));
    }
    state.add_event(
        task_id,
        "info",
        format!("Rewound to before turn {n}: {} restored, {} removed{branch}{said_convo}", plural(restored.written, "file"), plural(restored.removed, "file")),
        Some(detail),
    );
    state.emit(json!({"type": "checkpoints", "task_id": task_id}));
    let task = db::get_task(&state.db(), task_id)?;
    // The message, for the user to edit and send again.
    let message: Option<String> = state.db().query_row("SELECT data FROM messages WHERE id=?1 AND task_id=?2", params![b.message_id, task_id], |r| r.get(0)).optional()?;
    let message = message.and_then(|d| serde_json::from_str::<Value>(&d).ok()).unwrap_or(Value::Null);
    Ok(json!({
        "message": {"text": message["user_text"].as_str().or(message["text"].as_str()), "auto": message["auto"] == true},
        "task": task,
        "written": restored.written,
        "removed": restored.removed,
        "skipped": restored.skipped,
        "branch": moved.map(|(old, cur)| json!({"from": cur, "to": old})),
        "kept": ref_name(task_id, kept.n),
    }))
}

fn plural(n: usize, what: &str) -> String {
    format!("{n} {what}{}", if n == 1 { "" } else { "s" })
}

/// `DELETE /tasks/{id}/rewind`: the agent's next run keeps its conversation as it is.
pub async fn cancel_rewind(State(s): State<Shared>, UrlPath(id): UrlPath<String>) -> ApiResult<Json<Value>> {
    let task = s.update_task(&id, &[("rewind", Value::Null)])?.ok_or_else(|| ApiError::not_found("task"))?;
    Ok(Json(json!(task)))
}

// ---------- restoring ----------

#[derive(Debug, Default, PartialEq)]
pub struct Restored {
    pub written: usize,
    pub removed: usize,
    /// Files left as they are: submodules and other repositories, files the index marks
    /// skip-worktree or assume-unchanged, and files the checkpoints don't have (see `safe_to_write`).
    pub skipped: Vec<String>,
    /// The files written or removed.
    changed: BTreeSet<Vec<u8>>,
    /// The files marked skip-worktree or assume-unchanged.
    hidden: HashSet<Vec<u8>>,
}

/// Make the worktree at `top`, whose files are `now` (a tree from `snapshot`), have the files of
/// tree `to`: only the files that differ are written or removed, and only where nothing else would
/// go with them (ignored files and the rest are left alone).
async fn restore(top: &Path, now: &str, to: &str) -> Result<Restored> {
    let raw = run_ok(top, &["diff-tree", "-r", "-z", "--no-renames", now, to], &[], None).await?;
    let mut out = Restored::default();
    out.hidden = {
        let o = run_ok(top, &["ls-files", "-v", "-z"], &[], None).await?;
        split_nul(&o.stdout).filter(|e| e.len() > 2 && (e[0] == b'S' || e[0].is_ascii_lowercase())).map(|e| e[2..].to_vec()).collect()
    };
    // (path, whether `now` has it)
    let (mut write, mut remove): (Vec<(Vec<u8>, bool)>, Vec<Vec<u8>>) = (Vec::new(), Vec::new());
    let mut fields = raw.stdout.split(|b| *b == 0);
    while let Some(meta) = fields.next() {
        if meta.is_empty() {
            continue;
        }
        let Some(path) = fields.next() else { break };
        // `:<old mode> <new mode> <old sha> <new sha> <status>`
        let meta = String::from_utf8_lossy(meta);
        let mut m = meta.trim_start_matches(':').split(' ');
        let (old_mode, new_mode) = (m.next().unwrap_or(""), m.next().unwrap_or(""));
        if old_mode == "160000" || new_mode == "160000" || out.hidden.contains(path) {
            out.skipped.push(lossy(path));
        } else if new_mode == "000000" {
            remove.push(path.to_vec());
        } else {
            write.push((path.to_vec(), old_mode != "000000"));
        }
    }
    for p in remove {
        if remove_file(top, &p)? {
            out.removed += 1;
            out.changed.insert(p);
        }
    }
    let (write, left): (Vec<_>, Vec<_>) = write.into_iter().partition(|(p, in_now)| safe_to_write(top, p, *in_now));
    out.skipped.extend(left.iter().map(|(p, _)| lossy(p)));
    if !write.is_empty() {
        let scratch = ScratchIndex::new(top, false).await?;
        run_ok(top, &["read-tree", to], &scratch.env(), None).await?;
        run_ok(top, &["checkout-index", "-f", "-z", "--stdin"], &scratch.env(), Some(&nul_list(write.iter().map(|(p, _)| p.as_slice())))).await?;
        out.written = write.len();
        out.changed.extend(write.into_iter().map(|(p, _)| p));
    }
    Ok(out)
}

/// Whether the file `rel` can be written in the worktree at `top` without losing anything that
/// isn't in the checkpoint taken just before (`in_now`: that has the file): `checkout-index -f`
/// would remove a folder in its way with all that's in it, and overwrite whatever is there.
/// So not where a folder is (one the restore didn't empty: it holds ignored files, say), not
/// inside another repository or through a symlink, and not over a file the checkpoint doesn't
/// have (one ignored since, too big, or unreadable).
fn safe_to_write(top: &Path, rel: &[u8], in_now: bool) -> bool {
    let rel = Path::new(OsStr::from_bytes(rel));
    let Some(parts) = rel.components().map(|c| if let Component::Normal(p) = c { Some(p) } else { None }).collect::<Option<Vec<_>>>() else { return false };
    let Some((name, dirs)) = parts.split_last() else { return false };
    let mut dir = top.to_path_buf();
    for d in dirs {
        dir.push(d);
        match std::fs::symlink_metadata(&dir) {
            Ok(m) if m.is_dir() => {
                if std::fs::symlink_metadata(dir.join(".git")).is_ok() {
                    return false;
                }
            }
            Ok(_) => return false,
            // Not there: nothing below it is either.
            Err(_) => return true,
        }
    }
    match std::fs::symlink_metadata(dir.join(name)) {
        Err(_) => true,
        Ok(m) if m.is_dir() => false,
        Ok(_) => in_now,
    }
}

/// Put `paths` back in the index as they are in HEAD.
async fn unstaged(top: &Path, paths: &BTreeSet<Vec<u8>>) -> Result<()> {
    if !paths.is_empty() && head(top).await?.is_some() {
        run_ok(top, &["--literal-pathspecs", "reset", "-q", "--pathspec-from-file=-", "--pathspec-file-nul"], &[], Some(&nul_list(paths.iter().map(Vec::as_slice)))).await?;
    }
    Ok(())
}

/// Remove the file `rel` from the worktree at `top` (not a folder, and nothing through a symlink),
/// then the folders it leaves empty. Whether there was one to remove.
fn remove_file(top: &Path, rel: &[u8]) -> Result<bool> {
    let rel = Path::new(OsStr::from_bytes(rel));
    let parts: Vec<&OsStr> = rel.components().map(|c| match c {
        Component::Normal(p) => Some(p),
        _ => None,
    }).collect::<Option<_>>().context("not a path in the worktree")?;
    let Some((name, dirs)) = parts.split_last() else { return Ok(false) };
    let mut dir = top.to_path_buf();
    for d in dirs {
        dir.push(d);
        match std::fs::symlink_metadata(&dir) {
            Ok(m) if m.is_dir() => {}
            _ => return Ok(false),
        }
    }
    let path = dir.join(name);
    match std::fs::symlink_metadata(&path) {
        Ok(m) if !m.is_dir() => std::fs::remove_file(&path).with_context(|| format!("removing {}", path.display()))?,
        _ => return Ok(false),
    }
    let mut d = path.parent();
    while let Some(dir) = d.filter(|d| *d != top && d.starts_with(top)) {
        if std::fs::remove_dir(dir).is_err() {
            break;
        }
        d = dir.parent();
    }
    Ok(true)
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
