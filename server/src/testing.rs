//! Test helpers.

use std::fs::File;
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;

use crate::state::{AppState, Identity, Shared};

/// How long an async test may take before it fails.
pub const LIMIT: Duration = Duration::from_secs(30);

/// Runs an async test body, failing it if it runs longer than `LIMIT`. Use it instead of
/// `#[tokio::test]`, which waits forever on a hang:
///
/// ```ignore
/// #[test]
/// fn creates_a_task() {
///     testing::run(async || { ... })
/// }
/// ```
pub fn run(body: impl AsyncFnOnce() + Send + 'static) {
    run_within(LIMIT, body)
}

/// The body runs on its own thread and runtime, so the limit holds even when the body blocks its
/// thread (on a std mutex, say), which `tokio::time::timeout` can't catch.
pub fn run_within(limit: Duration, body: impl AsyncFnOnce() + Send + 'static) {
    let (done, finished) = mpsc::channel();
    let name = std::thread::current().name().unwrap_or("test").to_string();
    let worker = std::thread::Builder::new()
        .name(name)
        .spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            rt.block_on(body());
            let _ = done.send(());
        })
        .unwrap();
    match finished.recv_timeout(limit) {
        // Finished, or panicked (dropping `done`): pass the panic on.
        Ok(()) | Err(RecvTimeoutError::Disconnected) => {
            if let Err(panic) = worker.join() {
                std::panic::resume_unwind(panic);
            }
        }
        // The stuck thread is left behind; it ends with the test process.
        Err(RecvTimeoutError::Timeout) => {
            panic!("test still running after {limit:?}: something is stuck (a lock that is never released, or a future that never resolves)")
        }
    }
}

thread_local! {
    static HOOKS: std::cell::RefCell<Vec<(&'static str, Box<dyn FnOnce()>)>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Run `f` the next time code on this thread reaches `point` (see `reached`), to make a race
/// happen at the point where it can.
pub fn when(point: &'static str, f: impl FnOnce() + 'static) {
    HOOKS.with_borrow_mut(|h| h.push((point, Box::new(f))));
}

/// A point in the code a test can run something at (see `when`).
pub fn reached(point: &str) {
    let hook = HOOKS.with_borrow_mut(|h| h.iter().position(|(p, _)| *p == point).map(|i| h.remove(i).1));
    if let Some(f) = hook {
        f();
    }
}

/// An `AppState` on an in-memory database.
pub fn state() -> Shared {
    state_with(meta())
}

fn meta() -> crate::admin::ServerMeta {
    crate::admin::ServerMeta { boot_id: String::new(), started_at: String::new(), source_dir: None, running_commit: None, update_from: None, args: vec![] }
}

fn identity() -> Identity {
    Identity { host_id: "h".into(), host_name: "desktop".into(), token: String::new(), hub_token: String::new(), internal_url: String::new() }
}

/// `state()` with this process's `meta`.
pub fn state_with(meta: crate::admin::ServerMeta) -> Shared {
    state_of(identity(), meta)
}

/// An `AppState` on an in-memory database, for a host with these ids, tokens and URL.
pub fn state_as(id: Identity) -> Shared {
    state_of(id, meta())
}

fn state_of(id: Identity, meta: crate::admin::ServerMeta) -> Shared {
    let c = crate::db::open(Path::new(":memory:")).unwrap();
    let dir = TempDir::new();
    let s = AppState::new(c, dir.to_path_buf(), id, meta);
    // The state can outlive the thread that made it (a test that "restarts" the server).
    let _ = s.test_dir.set(dir);
    s
}

/// Set (to anything but `0`) to keep the folders of tests that fail, rather than remove them.
const KEEP: &str = "IA_KEEP_TEST_DIRS";

fn keep() -> bool {
    std::env::var_os(KEEP).is_some_and(|v| v != "0")
}

/// A new, empty folder for this test, named after it, which is removed with whatever the test
/// made in it (repositories, worktrees, runs) when the test ends, panics included: when the
/// thread that asked for it exits. Use it rather than `std::env::temp_dir()`, which test runs
/// used to fill. With `IA_KEEP_TEST_DIRS=1`, a failing test's folders are kept, and their paths
/// printed.
pub fn temp_dir() -> PathBuf {
    let dir = TempDir::new();
    let path = dir.to_path_buf();
    DIRS.with_borrow_mut(|d| d.push(dir));
    path
}

thread_local! {
    /// The folders this thread's test made (see `temp_dir`).
    static DIRS: std::cell::RefCell<Vec<TempDir>> = const { std::cell::RefCell::new(Vec::new()) };
    /// Whether this thread has panicked (see `temp_root`).
    static PANICKED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// A folder in this run's `temp_root()`, removed when it's dropped. Tests get one from
/// `temp_dir`, which drops it when the test ends; an `AppState` from `state()` owns its own.
pub struct TempDir(PathBuf);

impl TempDir {
    /// A new, empty folder, named after the test.
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        let test = std::thread::current().name().unwrap_or("test").replace("::", ".");
        let dir = temp_root().join(format!("{test}-{}", &crate::util::new_id()[..8]));
        std::fs::create_dir(&dir).unwrap();
        TempDir(dir)
    }
}

impl std::ops::Deref for TempDir {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        // By the time a thread's `temp_dir`s go, it has finished unwinding.
        let failed = std::thread::panicking() || PANICKED.try_with(|p| p.get()).unwrap_or(false);
        if failed && keep() {
            eprintln!("kept the failing test's folder {}", self.0.display());
        } else {
            remove(&self.0);
        }
    }
}

/// `remove_dir_all`, after making folders writable again if a test left one read-only.
fn remove(dir: &Path) {
    if std::fs::remove_dir_all(dir).is_ok() || !dir.exists() {
        return;
    }
    fn writable(dir: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o755));
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            if e.file_type().is_ok_and(|t| t.is_dir()) {
                writable(&e.path());
            }
        }
    }
    writable(dir);
    let _ = std::fs::remove_dir_all(dir);
}

/// This test run's folder and the lock it holds on it while it lasts (see `temp_root`).
static ROOT: OnceLock<(PathBuf, File)> = OnceLock::new();

/// This test run's folder, `$TMPDIR/ia-tests-<id>`, which `temp_dir`s are made in. It's removed
/// when the run exits, with whatever is left in it (a test that's still stuck, or one run with
/// `--test-threads=1`, whose main thread doesn't exit first). A run that's killed can't remove
/// it, so each run removes those of runs that have ended: a run holds a lock on its folder's
/// `.lock` while it lasts.
fn temp_root() -> &'static Path {
    &ROOT
        .get_or_init(|| {
            let tmp = std::env::temp_dir();
            remove_ended_runs(&tmp);
            let root = tmp.join(format!("ia-tests-{}", crate::util::new_id()));
            std::fs::create_dir(&root).unwrap();
            // Locked before it's named `.lock`, so no other run sees it unlocked.
            let lock = File::create(root.join(".lock-new")).unwrap();
            assert_eq!(unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) }, 0, "locking {}", root.display());
            std::fs::rename(root.join(".lock-new"), root.join(".lock")).unwrap();
            unsafe { libc::atexit(remove_root) };
            // Notes which threads panicked, for `TempDir` to keep their folders with IA_KEEP_TEST_DIRS.
            let hook = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                let _ = PANICKED.try_with(|p| p.set(true));
                hook(info)
            }));
            (root, lock)
        })
        .0
}

/// Removes this run's folder as the process exits. With `IA_KEEP_TEST_DIRS` it keeps the folder
/// if failing tests' folders are in it, without its `.lock`, so later runs leave it alone.
extern "C" fn remove_root() {
    let Some((root, _)) = ROOT.get() else { return };
    if keep() && std::fs::read_dir(root).is_ok_and(|d| d.flatten().any(|e| e.file_name() != ".lock")) {
        let _ = std::fs::remove_file(root.join(".lock"));
    } else {
        remove(root);
    }
}

/// Removes the folders of earlier test runs that were killed before they could remove their own:
/// those whose `.lock` no run holds.
fn remove_ended_runs(tmp: &Path) {
    let Ok(entries) = std::fs::read_dir(tmp) else { return };
    for e in entries.flatten() {
        if !e.file_name().to_string_lossy().starts_with("ia-tests-") {
            continue;
        }
        let Ok(lock) = File::open(e.path().join(".lock")) else { continue };
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            remove(&e.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passes_a_finished_body() {
        run(async || tokio::task::yield_now().await);
    }

    #[test]
    #[should_panic(expected = "boom")]
    fn passes_on_a_panic() {
        run(async || panic!("boom"));
    }

    #[test]
    #[should_panic(expected = "test still running after")]
    fn fails_a_body_that_hangs() {
        run_within(Duration::from_millis(200), async || std::future::pending::<()>().await);
    }

    #[test]
    #[should_panic(expected = "test still running after")]
    fn fails_a_body_that_blocks_its_thread() {
        run_within(Duration::from_millis(200), async || std::thread::sleep(Duration::from_secs(3600)));
    }

    #[test]
    fn a_tests_folders_go_when_it_ends_even_if_it_fails() {
        let dir = std::thread::spawn(|| {
            let dir = temp_dir();
            std::fs::create_dir_all(dir.join("repo/.git")).unwrap();
            // One a test left read-only goes too.
            let ro = dir.join("ro");
            std::fs::create_dir(&ro).unwrap();
            std::fs::write(ro.join("f"), "f").unwrap();
            std::fs::set_permissions(&ro, std::os::unix::fs::PermissionsExt::from_mode(0o555)).unwrap();
            dir
        })
        .join()
        .unwrap();
        assert!(dir.starts_with(temp_root()) && !dir.exists(), "{}", dir.display());

        let (tx, rx) = mpsc::channel();
        let failed = std::thread::spawn(move || {
            tx.send(temp_dir()).unwrap();
            panic!("failed");
        })
        .join();
        assert!(failed.is_err());
        let dir = rx.recv().unwrap();
        assert_eq!(dir.exists(), keep(), "{}", dir.display());
    }

    #[test]
    fn a_states_folder_goes_with_the_state() {
        let s = std::thread::spawn(state).join().unwrap();
        let dir = s.data_dir.clone();
        // Not with the thread that made it: tests carry a state over to another `run`.
        assert!(dir.is_dir(), "{}", dir.display());
        drop(s);
        assert!(!dir.exists(), "{}", dir.display());
    }

    #[test]
    fn removes_the_folders_of_runs_that_ended() {
        let tmp = temp_dir();
        for d in ["ia-tests-ended", "ia-tests-running", "ia-tests-unlocked", "other"] {
            std::fs::create_dir(tmp.join(d)).unwrap();
        }
        for d in ["ia-tests-ended", "ia-tests-running", "other"] {
            std::fs::write(tmp.join(d).join(".lock"), "").unwrap();
        }
        let running = File::open(tmp.join("ia-tests-running/.lock")).unwrap();
        assert_eq!(unsafe { libc::flock(running.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) }, 0);
        remove_ended_runs(&tmp);
        let mut left: Vec<_> = std::fs::read_dir(&tmp).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        left.sort();
        // A folder without a `.lock` is one being made, or kept for a failing test.
        assert_eq!(left, ["ia-tests-running", "ia-tests-unlocked", "other"]);
        // This run's own is locked.
        remove_ended_runs(temp_root().parent().unwrap());
        assert!(temp_root().join(".lock").exists());
    }
}
