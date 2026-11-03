//! Moving the board's threads onto agent-threads (docs/agent-threads-feasibility.md, option B, and
//! docs/agent-threads-migration.md):
//!
//! - `store`: agent-threads' `Store` on the board's database, in tables of its own.
//! - `import`: a thread's stored messages converted into agent-threads items and events, and checked,
//!   without changing anything.
//! - `engine`: running a task's agent on agent-threads rather than the board's own runner, for the tasks
//!   whose `run_engine` is `agent_threads`.
//! - `live`: the backend in the server's state.
//! - `report`: `huntaway threads-import`, a dry run of `import` over a board's tasks, which reports
//!   what converts, what doesn't, and which tasks couldn't be switched over now.

pub mod engine;
pub mod import;
pub mod live;
pub mod report;
pub mod store;
