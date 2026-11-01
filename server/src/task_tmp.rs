//! Each task's agents get a temp folder of their own, `$TMPDIR` for its runs and terminals, so what
//! they leave in it (test servers' data, build output, logs, browsers' profiles) goes with the task
//! rather than piling up in /tmp: `<system temp>/huntaway-<data dir's hash>/<task id>`. A review
//! thread uses the folder of the task it reviews, as it works in that task's worktree.
//!
//! A task's folder is removed as soon as the task is done and no agent works in it (its own or a
//! reviewer), or when its run ends if the task went to *Done* while it ran, and when the task is
//! deleted; and every `SWEEP`, the folders of tasks that are done or deleted (e.g. while the server
//! was down). It's set up again if the task's agent runs again. Each data dir has its own root, so
//! a server only ever removes its own tasks' folders, not those of another server (such as a test
//! server) on the same machine.
//!
//! Nothing is removed unless the root is a folder (not a link) of this user's that nobody else can
//! write to, and only folders in it named like a task id (or being removed) are. Whether a folder
//! can go is decided, and the folder renamed away, under `LOCK`, which `ensure` takes too: as a run
//! is registered (`AppState::runs`) before it sets up its folder, a run starting meanwhile either
//! keeps the folder or gets a new one.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use crate::db::{self, Task};
use crate::state::{AppState, Shared};

/// How often the folders of done and deleted tasks are looked for.
const SWEEP: Duration = Duration::from_secs(600);

/// Prefix of a folder being removed: renamed first, so a run starting meanwhile gets a new one.
const REMOVING: &str = ".removing-";

/// Held while a folder is set up, and while one is checked and renamed away (see the module's doc).
static LOCK: Mutex<()> = Mutex::new(());

fn lock() -> std::sync::MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// The folder all of this server's tasks' temp folders are in.
pub fn root(state: &AppState) -> PathBuf {
    // A test's are in its own data dir, which goes when it ends.
    if cfg!(test) {
        return state.data_dir.join("task-tmp");
    }
    std::env::temp_dir().join(format!("huntaway-{:016x}", fnv1a(crate::util::path_str(&state.data_dir).as_bytes())))
}

/// FNV-1a: a hash that stays the same across builds (std's may not), so a new build finds the
/// folders an older one made.
fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325, |h, b| (h ^ *b as u64).wrapping_mul(0x100000001b3))
}

/// The task whose folder `task`'s agent uses: a review thread's is the task it reviews.
pub fn owner(task: &Task) -> &str {
    match (task.kind.as_str(), &task.parent_id) {
        ("review", Some(parent)) => parent,
        _ => &task.id,
    }
}

/// `task`'s temp folder (made or not).
pub fn dir(state: &AppState, task: &Task) -> PathBuf {
    root(state).join(owner(task))
}

/// Make `task`'s temp folder (readable only by this user) and return it. None, with a warning
/// logged, if it can't be: the agent then uses the system's temp folder, as it did before.
pub fn ensure(state: &AppState, task: &Task) -> Option<PathBuf> {
    let dir = dir(state, task);
    let _lock = lock();
    match make(&root(state), &dir) {
        Ok(()) => Some(dir),
        Err(e) => {
            tracing::warn!(task = %task.id, "couldn't set up the task's temp folder {}: {e:#}", dir.display());
            None
        }
    }
}

fn make(root: &Path, dir: &Path) -> anyhow::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    let mut b = std::fs::DirBuilder::new();
    b.recursive(true).mode(0o700);
    b.create(root)?;
    check_root(root)?;
    b.create(dir)?;
    Ok(())
}

/// In a temp folder others can write to, the root must be a folder of this user's, not a link
/// someone left there (to make us write to or empty another folder), and no one else may write to it.
fn check_root(root: &Path) -> anyhow::Result<()> {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::symlink_metadata(root)?;
    if !m.is_dir() || m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o022 != 0 {
        anyhow::bail!("{} isn't a folder of this user's that only they can write to", root.display());
    }
    Ok(())
}

/// Whether an entry of the root is one of our folders: a folder (not a link), named after a task
/// (a UUID, see util::new_id) or being removed.
fn ours(e: &std::fs::DirEntry) -> bool {
    let name = e.file_name().to_string_lossy().into_owned();
    e.file_type().is_ok_and(|t| t.is_dir()) && (name.starts_with(REMOVING) || uuid::Uuid::try_parse(&name).is_ok())
}

/// Call when task `t`'s status or running state changed: once it's done and its agents have
/// stopped, its folder goes (off this thread). A review thread's change may be the last of the
/// task's agents stopping.
pub fn changed(state: &Shared, t: &Task) {
    if t.kind == "task" && t.status != "done" {
        return;
    }
    let Ok(rt) = tokio::runtime::Handle::try_current() else { return };
    let (s, id) = (state.clone(), owner(t).to_string());
    if !root(&s).join(&id).exists() {
        return;
    }
    rt.spawn(async move {
        remove(&s, &id).await;
    });
}

/// Call once task `id` has been deleted (with its agents stopped): its folder goes.
pub async fn deleted(state: &Shared, id: &str) {
    remove(state, id).await;
}

/// Whether task `id`'s folder can go: the task is done (or deleted) and no agent works in it.
fn removable(state: &Shared, id: &str) -> bool {
    // Read (and the database unlocked) before agent_in_worktree reads it again.
    let task = db::get_task(&state.db(), id);
    match task {
        Ok(None) => true,
        Ok(Some(t)) => t.status == "done" && !t.running && !crate::worktree::agent_in_worktree(state, id),
        Err(e) => {
            tracing::warn!(task = id, "reading the task for its temp folder: {e:#}");
            false
        }
    }
}

/// Remove task `id`'s folder if it can go (see `removable`). Returns whether it went.
async fn remove(state: &Shared, id: &str) -> bool {
    let Some(away) = take(state, id) else { return false };
    let id = id.to_string();
    match tokio::task::spawn_blocking(move || remove_all(&away)).await {
        Ok(Ok(())) => tracing::info!(task = id, "removed the task's temp folder"),
        Ok(Err(e)) => tracing::warn!(task = id, "removing the task's temp folder: {e:#}"),
        Err(e) => tracing::warn!(task = id, "removing the task's temp folder: {e}"),
    }
    true
}

/// Rename task `id`'s folder away, if it can go, under `LOCK`: a run that starts later sets up a
/// new one. Returns where it went.
fn take(state: &Shared, id: &str) -> Option<PathBuf> {
    let _lock = lock();
    let root = root(state);
    if let Err(e) = check_root(&root) {
        tracing::warn!("not removing anything from the tasks' temp folders: {e:#}");
        return None;
    }
    let from = root.join(id);
    // Gone already (another removal got there first), or not one of ours?
    if !std::fs::symlink_metadata(&from).is_ok_and(|m| m.is_dir()) || !removable(state, id) {
        return None;
    }
    #[cfg(test)]
    crate::testing::reached("task_tmp:removable");
    let away = root.join(format!("{REMOVING}{id}-{}", crate::util::new_id()));
    std::fs::rename(&from, &away).ok()?;
    Some(away)
}

/// `remove_dir_all`, also when something in it took away its folders' write permission (as
/// Go's module cache does), which keeps their contents from being removed.
fn remove_all(dir: &Path) -> std::io::Result<()> {
    if std::fs::remove_dir_all(dir).is_ok() || !dir.exists() {
        return Ok(());
    }
    writable(dir);
    std::fs::remove_dir_all(dir)
}

fn writable(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        // Not following links out of the folder.
        if e.file_type().is_ok_and(|t| t.is_dir()) {
            writable(&e.path());
        }
    }
}

/// Remove the folders of tasks that are done (with no agent working in them) or deleted, and any
/// that a removal didn't finish. Returns how many went.
pub async fn sweep(state: &Shared) -> usize {
    let root = root(state);
    if !root.exists() {
        return 0;
    }
    if let Err(e) = check_root(&root) {
        tracing::warn!("not sweeping the tasks' temp folders: {e:#}");
        return 0;
    }
    let Ok(entries) = std::fs::read_dir(&root) else { return 0 };
    let mut n = 0;
    for e in entries.flatten().filter(ours) {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with(REMOVING) {
            let path = e.path();
            let _ = tokio::task::spawn_blocking(move || remove_all(&path)).await;
        } else if remove(state, &name).await {
            n += 1;
        }
    }
    n
}

/// Sweeps the folders when the server starts, then every `SWEEP`.
pub fn start_sweeper(state: &Shared) {
    let s = state.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(SWEEP);
        loop {
            tick.tick().await;
            let n = sweep(&s).await;
            if n > 0 {
                tracing::info!("removed {n} done or deleted tasks' temp folders");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing;
    use serde_json::json;

    fn task(s: &Shared) -> Task {
        let c = s.db();
        let p = match db::list_profiles(&c).unwrap().into_iter().next() {
            Some(p) => p,
            None => db::insert_profile(&c, "p", &[], None).unwrap(),
        };
        let t = db::NewTask {
            profile_id: &p.id,
            project_id: None,
            kind: "task",
            title: "t",
            description: "",
            status: "in_progress",
            use_worktree: false,
            model: None,
            effort: None,
            claude_config_id: None,
        };
        db::insert_task(&c, t).unwrap()
    }

    /// Waits (up to 5s) for `done`.
    async fn until(mut done: impl FnMut() -> bool) {
        for _ in 0..500 {
            if done() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("timed out");
    }

    #[test]
    fn a_review_thread_uses_its_tasks_folder() {
        let s = testing::state();
        let t = task(&s);
        let mut r = t.clone();
        (r.id, r.kind, r.parent_id) = ("r".into(), "review".into(), Some(t.id.clone()));
        assert_eq!(dir(&s, &r), dir(&s, &t));
        assert_eq!(dir(&s, &t), root(&s).join(&t.id));
    }

    #[test]
    fn the_root_is_per_data_dir_and_stable() {
        assert_eq!(fnv1a(b"/home/me/.local/share/huntaway"), fnv1a(b"/home/me/.local/share/huntaway"));
        assert_ne!(fnv1a(b"/home/me/.local/share/huntaway"), fnv1a(b"/tmp/ia-test-x"));
        assert_eq!(fnv1a(b""), 0xcbf29ce484222325);
    }

    #[test]
    fn the_folder_goes_once_the_task_is_done_and_idle() {
        testing::run(async || {
            let s = testing::state();
            let t = task(&s);
            let d = ensure(&s, &t).unwrap();
            std::fs::create_dir_all(d.join("ia-test-1/repo")).unwrap();
            std::fs::write(d.join("ia-test-1/repo/x"), "x").unwrap();
            // Not while the agent still runs, though the task is done.
            s.update_task(&t.id, &[("running", json!(true))]).unwrap();
            s.update_task(&t.id, &[("status", json!("done"))]).unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert!(d.exists());
            assert_eq!(sweep(&s).await, 0);
            // Its run ending takes it.
            s.update_task(&t.id, &[("running", json!(false))]).unwrap();
            until(|| std::fs::read_dir(root(&s)).unwrap().count() == 0).await;
            // It's set up again if the agent runs again.
            s.update_task(&t.id, &[("status", json!("in_progress"))]).unwrap();
            assert_eq!(ensure(&s, &t), Some(d.clone()));
            s.update_task(&t.id, &[("title", json!("renamed"))]).unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert!(d.exists());
        })
    }

    #[test]
    fn a_sweep_takes_done_and_deleted_tasks_folders() {
        testing::run(async || {
            let s = testing::state();
            let (open, done) = (task(&s), task(&s));
            let (open_dir, done_dir) = (ensure(&s, &open).unwrap(), ensure(&s, &done).unwrap());
            // Done while the server was down, so nothing saw it change.
            db::update_task(&s.db(), &done.id, &[("status", json!("done"))]).unwrap();
            let deleted = root(&s).join(crate::util::new_id());
            std::fs::create_dir_all(&deleted).unwrap();
            let unfinished = root(&s).join(format!("{REMOVING}x-1"));
            std::fs::create_dir_all(unfinished.join("y")).unwrap();
            assert_eq!(sweep(&s).await, 2);
            assert!(open_dir.exists() && !done_dir.exists() && !deleted.exists() && !unfinished.exists());
        })
    }

    #[test]
    fn only_folders_named_like_tasks_are_swept() {
        testing::run(async || {
            let s = testing::state();
            ensure(&s, &task(&s)).unwrap();
            let elsewhere = testing::temp_dir();
            std::fs::create_dir_all(elsewhere.join("docs")).unwrap();
            std::fs::write(elsewhere.join("docs/important.txt"), "x").unwrap();
            let r = root(&s);
            std::fs::create_dir(r.join("notes")).unwrap();
            std::os::unix::fs::symlink(&elsewhere, r.join(crate::util::new_id())).unwrap();
            assert_eq!(sweep(&s).await, 0);
            assert!(r.join("notes").is_dir() && elsewhere.join("docs/important.txt").exists());
        })
    }

    #[test]
    fn nothing_is_removed_through_a_root_that_isnt_ours_alone() {
        use std::os::unix::fs::PermissionsExt;
        testing::run(async || {
            let s = testing::state();
            let t = task(&s);
            db::update_task(&s.db(), &t.id, &[("status", json!("done"))]).unwrap();
            // Someone left a link where the root goes, to a folder with a done task's name in it.
            let elsewhere = testing::temp_dir();
            for d in [t.id.clone(), crate::util::new_id(), format!("{REMOVING}x"), "docs".into()] {
                std::fs::create_dir_all(elsewhere.join(&d)).unwrap();
                std::fs::write(elsewhere.join(&d).join("important.txt"), "x").unwrap();
            }
            let count = || std::fs::read_dir(&elsewhere).unwrap().count();
            std::fs::create_dir_all(root(&s).parent().unwrap()).unwrap();
            std::os::unix::fs::symlink(&elsewhere, root(&s)).unwrap();
            assert_eq!(sweep(&s).await, 0);
            assert!(!remove(&s, &t.id).await);
            assert_eq!(count(), 4);
            assert_eq!(ensure(&s, &task(&s)), None);
            // Nor through a root others can write to.
            std::fs::remove_file(root(&s)).unwrap();
            std::fs::rename(&elsewhere, root(&s)).unwrap();
            std::fs::set_permissions(root(&s), std::fs::Permissions::from_mode(0o777)).unwrap();
            assert_eq!(sweep(&s).await, 0);
            assert_eq!(std::fs::read_dir(root(&s)).unwrap().count(), 4);
            assert_eq!(ensure(&s, &task(&s)), None);
            // Once it's ours alone, the done task's folder goes.
            std::fs::set_permissions(root(&s), std::fs::Permissions::from_mode(0o700)).unwrap();
            assert_eq!(sweep(&s).await, 2);
            assert!(root(&s).join("docs/important.txt").exists());
        })
    }

    #[test]
    fn a_run_starting_as_the_folder_goes_keeps_its_own() {
        testing::run(async || {
            let s = testing::state();
            let t = task(&s);
            ensure(&s, &t).unwrap();
            db::update_task(&s.db(), &t.id, &[("status", json!("done"))]).unwrap();
            // Once the removal has found the task idle, a run starts: it's registered, then sets
            // up its folder and writes in it.
            let start = {
                let (s, t) = (s.clone(), t.clone());
                move || {
                    s.runs.lock().unwrap().insert(t.id.clone(), crate::state::RunHandle { run_id: "r".into(), cancel: None });
                    let d = ensure(&s, &t).unwrap();
                    std::fs::write(d.join("work"), "x").unwrap();
                }
            };
            let started = std::sync::Arc::new(Mutex::new(None));
            let handle = started.clone();
            testing::when("task_tmp:removable", move || {
                *handle.lock().unwrap() = Some(std::thread::spawn(start));
                // Time for it to get as far as it can before the folder is renamed away.
                std::thread::sleep(Duration::from_millis(200));
            });
            assert_eq!(sweep(&s).await, 1);
            let thread = started.lock().unwrap().take().unwrap();
            thread.join().unwrap();
            assert!(dir(&s, &t).join("work").exists());
            // And with it running, the folder stays.
            assert_eq!(sweep(&s).await, 0);
            assert!(dir(&s, &t).join("work").exists());
        })
    }

    #[test]
    fn deleting_a_task_takes_its_folder() {
        testing::run(async || {
            let s = testing::state();
            let (kept, gone) = (task(&s), task(&s));
            let (kept_dir, gone_dir) = (ensure(&s, &kept).unwrap(), ensure(&s, &gone).unwrap());
            std::fs::write(gone_dir.join("x"), "x").unwrap();
            crate::api::delete_one(&s, &gone, false).await.unwrap();
            assert!(kept_dir.exists() && !gone_dir.exists());
            assert_eq!(std::fs::read_dir(root(&s)).unwrap().count(), 1);
        })
    }

    #[test]
    fn folders_without_write_permission_are_removed_too() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = testing::temp_dir();
        let d = tmp.join("t");
        std::fs::create_dir_all(d.join("mod/pkg")).unwrap();
        std::fs::write(d.join("mod/pkg/f"), "x").unwrap();
        for p in ["mod/pkg", "mod"] {
            std::fs::set_permissions(d.join(p), std::fs::Permissions::from_mode(0o555)).unwrap();
        }
        remove_all(&d).unwrap();
        assert!(!d.exists());
    }
}
