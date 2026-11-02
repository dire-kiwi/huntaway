//! Running git for checkpoints: scratch indexes, snapshots of the worktree, and keeping and pruning
//! checkpoint refs.

use super::*;

pub(super) struct Out {
    pub(super) ok: bool,
    pub(super) stdout: Vec<u8>,
    stderr: String,
}

impl Out {
    pub(super) fn text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).trim().to_string()
    }
}

/// Runs git at `dir` with `env` and `input` on its stdin, never with a git environment the server
/// may have been started with.
pub(super) async fn run(dir: &Path, args: &[&str], env: &[(&str, &OsStr)], input: Option<&[u8]>) -> Result<Out> {
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

pub(super) async fn run_ok(dir: &Path, args: &[&str], env: &[(&str, &OsStr)], input: Option<&[u8]>) -> Result<Out> {
    let o = run(dir, args, env, input).await?;
    if !o.ok {
        bail!("git {} failed: {}", args.first().copied().unwrap_or(""), o.stderr);
    }
    Ok(o)
}

pub(super) fn split_nul(bytes: &[u8]) -> impl Iterator<Item = &[u8]> {
    bytes.split(|b| *b == 0).filter(|p| !p.is_empty())
}

pub(super) fn lossy(p: &[u8]) -> String {
    String::from_utf8_lossy(p).into_owned()
}

/// NUL-terminated paths, as `--stdin -z` and `--pathspec-file-nul` take them.
pub(super) fn nul_list<'a>(paths: impl IntoIterator<Item = &'a [u8]>) -> Vec<u8> {
    let mut out = Vec::new();
    for p in paths {
        out.extend_from_slice(p);
        out.push(0);
    }
    out
}

/// An index of our own in the worktree's git directory, removed once dropped.
pub(super) struct ScratchIndex(PathBuf);

impl ScratchIndex {
    /// A copy of the worktree's index (so `git add` only looks again at what changed), or an empty one.
    pub(super) async fn new(top: &Path, copy: bool) -> Result<Self> {
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

    pub(super) fn env(&self) -> [(&'static str, &OsStr); 1] {
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

pub(super) async fn head(top: &Path) -> Result<Option<String>> {
    let o = run(top, &["rev-parse", "-q", "--verify", "HEAD^{commit}"], &[], None).await?;
    Ok(o.ok.then(|| o.text()).filter(|h| !h.is_empty()))
}

/// The tree of everything in the worktree at `top` that git doesn't ignore, and its HEAD, as a
/// commit (`last`'s, when nothing has changed since it).
pub(super) async fn snapshot(top: &Path, last: Option<&Checkpoint>) -> Result<Snap> {
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
pub(super) async fn worktree_top(state: &Shared, task_id: &str) -> Result<Option<PathBuf>> {
    let Some(task) = db::get_task(&state.db(), task_id)? else { return Ok(None) };
    let Some(wt) = own_worktree(state, &task) else { return Ok(None) };
    let o = run(&wt, &["rev-parse", "--show-toplevel"], &[], None).await?;
    Ok(o.ok.then(|| PathBuf::from(o.text())))
}

/// The worktree a task's checkpoints are of: its own, once it's set up. Not a review thread's (it
/// works in its task's) nor a document's or scratch task's (they work in folders of their own).
pub(super) fn own_worktree(state: &Shared, task: &Task) -> Option<PathBuf> {
    if task.kind != "task" || !task.use_worktree || task.worktree_state != "ready" || crate::documents::work_dir(state, task).is_some() {
        return None;
    }
    task.worktree_path.as_deref().map(crate::util::expand_tilde).filter(|p| p.is_dir())
}

/// Store `snap` as the task's next checkpoint: its ref, then its row.
pub(super) async fn keep(state: &Shared, task_id: &str, top: &Path, snap: &Snap, cp: impl FnOnce(i64) -> Checkpoint) -> Result<Checkpoint> {
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
pub(super) async fn prune(state: &Shared, task_id: &str, top: &Path) -> Result<()> {
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
