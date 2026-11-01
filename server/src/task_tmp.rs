//! Each task's agents get a temp folder of their own, `$TMPDIR` for its runs and terminals, so what
//! they leave in it (test servers' data, build output, logs, browsers' profiles) goes with the task
//! rather than piling up in /tmp: `<system temp>/ha-<data dir's hash>/<start of the task id>`. A
//! review thread uses the folder of the task it reviews, as it works in that task's worktree.
//!
//! The path is kept short (`/tmp/ha-0123abcd/0123456789ab`) because programs put sockets in their
//! TMPDIR, whose paths can't be longer than 107 bytes: Chromium's ProcessSingleton socket is
//! `$TMPDIR/org.chromium.Chromium.XXXXXX/SingletonSocket`, 46 bytes more, and scripts/ui-check.mjs
//! puts the browser's TMPDIR in a folder of its own in the agent's (20 more). A folder is named after
//! the first 12 hex digits of its task's id, so it's found by those; two tasks that share them (1 in
//! 2^48) share a folder, which goes once both are done.
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
    root_in(&std::env::temp_dir(), &state.data_dir)
}

/// The root for data dir `data` in the system's temp folder `temp`.
fn root_in(temp: &Path, data: &Path) -> PathBuf {
    temp.join(format!("ha-{:08x}", fnv1a(crate::util::path_str(data).as_bytes()) as u32))
}

/// The name of task `id`'s folder: the first 12 hex digits of its id (a UUID, see util::new_id).
pub fn folder(id: &str) -> String {
    id.chars().filter(char::is_ascii_alphanumeric).take(12).collect()
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
    root(state).join(folder(owner(task)))
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
    use std::os::unix::fs::DirBuilderExt;
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
/// (see `folder`) or being removed.
fn ours(e: &std::fs::DirEntry) -> bool {
    let name = e.file_name().to_string_lossy().into_owned();
    let task = name.len() == 12 && name.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    e.file_type().is_ok_and(|t| t.is_dir()) && (name.starts_with(REMOVING) || task)
}

/// Call when task `t`'s status or running state changed: once it's done and its agents have
/// stopped, its folder goes (off this thread). A review thread's change may be the last of the
/// task's agents stopping.
pub fn changed(state: &Shared, t: &Task) {
    if t.kind == "task" && t.status != "done" {
        return;
    }
    let Ok(rt) = tokio::runtime::Handle::try_current() else { return };
    let (s, name) = (state.clone(), folder(owner(t)));
    if !root(&s).join(&name).exists() {
        return;
    }
    rt.spawn(async move {
        remove(&s, &name).await;
    });
}

/// Call once task `id` has been deleted (with its agents stopped): its folder goes.
pub async fn deleted(state: &Shared, id: &str) {
    remove(state, &folder(id)).await;
}

/// The tasks whose folder is `name` (see `folder`): usually one, none once it's deleted.
fn tasks_of(state: &Shared, name: &str) -> anyhow::Result<Vec<Task>> {
    let c = state.db();
    let mut st = c.prepare("SELECT id FROM tasks WHERE kind != 'review' AND substr(replace(id, '-', ''), 1, 12) = ?1")?;
    let ids = st.query_map([name], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ids.iter().filter_map(|id| db::get_task(&c, id).transpose()).collect::<anyhow::Result<Vec<_>>>()?)
}

/// Whether folder `name` can go: its tasks are done (or deleted) and no agent works in them.
fn removable(state: &Shared, name: &str) -> bool {
    // Read (and the database unlocked) before agent_in_worktree reads it again.
    match tasks_of(state, name) {
        Ok(tasks) => tasks.iter().all(|t| t.status == "done" && !t.running && !crate::worktree::agent_in_worktree(state, &t.id)),
        Err(e) => {
            tracing::warn!(folder = name, "reading the tasks of a temp folder: {e:#}");
            false
        }
    }
}

/// Remove folder `name` (see `folder`) if it can go (see `removable`). Returns whether it went.
async fn remove(state: &Shared, name: &str) -> bool {
    let Some(away) = take(state, name) else { return false };
    let id = name.to_string();
    match tokio::task::spawn_blocking(move || remove_all(&away)).await {
        Ok(Ok(())) => tracing::info!(folder = id, "removed a task's temp folder"),
        Ok(Err(e)) => tracing::warn!(folder = id, "removing a task's temp folder: {e:#}"),
        Err(e) => tracing::warn!(folder = id, "removing a task's temp folder: {e}"),
    }
    true
}

/// Rename folder `id` away, if it can go, under `LOCK`: a run that starts later sets up a new one.
/// Returns where it went.
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
        assert_eq!(dir(&s, &t), root(&s).join(&t.id.replace('-', "")[..12]));
    }

    #[test]
    fn the_path_leaves_room_for_sockets_in_it() {
        let dir = root_in(Path::new("/tmp"), Path::new("/home/someone-with-a-long-name/.local/share/issue-agent")).join(folder(&crate::util::new_id()));
        let len = crate::util::path_str(&dir).len();
        assert_eq!(len, "/tmp/ha-0123abcd/0123456789ab".len(), "{}", dir.display());
        // Chromium's socket (46 bytes), in ui-check.mjs's folder for the browser (20), fits in a
        // socket path (107 bytes), with room to spare.
        assert!(len + "/ia-ui-check-XXXXXX".len() + "/org.chromium.Chromium.XXXXXX/SingletonSocket".len() <= 100);
    }

    #[test]
    fn tasks_whose_ids_start_alike_share_a_folder_until_both_are_done() {
        testing::run(async || {
            let s = testing::state();
            let (a, b) = (task(&s), task(&s));
            let b_id = format!("{}{}", &a.id[..14], &b.id[14..]);
            s.db().execute("UPDATE tasks SET id=?1 WHERE id=?2", [&b_id, &b.id]).unwrap();
            let b = db::get_task(&s.db(), &b_id).unwrap().unwrap();
            let d = ensure(&s, &a).unwrap();
            assert_eq!(ensure(&s, &b), Some(d.clone()));
            db::update_task(&s.db(), &a.id, &[("status", json!("done"))]).unwrap();
            assert_eq!(sweep(&s).await, 0);
            db::update_task(&s.db(), &b.id, &[("status", json!("done"))]).unwrap();
            assert_eq!(sweep(&s).await, 1);
            assert!(!d.exists());
        })
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
            let deleted = root(&s).join(folder(&crate::util::new_id()));
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
            std::os::unix::fs::symlink(&elsewhere, r.join(folder(&crate::util::new_id()))).unwrap();
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
            for d in [folder(&t.id), folder(&crate::util::new_id()), format!("{REMOVING}x"), "docs".into()] {
                std::fs::create_dir_all(elsewhere.join(&d)).unwrap();
                std::fs::write(elsewhere.join(&d).join("important.txt"), "x").unwrap();
            }
            let count = || std::fs::read_dir(&elsewhere).unwrap().count();
            std::fs::create_dir_all(root(&s).parent().unwrap()).unwrap();
            std::os::unix::fs::symlink(&elsewhere, root(&s)).unwrap();
            assert_eq!(sweep(&s).await, 0);
            assert!(!remove(&s, &folder(&t.id)).await);
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
