//! Test helpers.

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
    let c = crate::db::open(std::path::Path::new(":memory:")).unwrap();
    let data_dir = std::env::temp_dir().join(format!("ia-test-{}", crate::util::new_id()));
    AppState::new(c, data_dir, id, meta)
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
}
