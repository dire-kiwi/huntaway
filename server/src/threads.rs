//! Moving the board's threads onto agent-threads (docs/agent-threads-feasibility.md, option B, and
//! docs/agent-threads-migration.md). So far, the parts that don't change how agents run:
//!
//! - `store`: agent-threads' `Store` on the board's database, in tables of its own.
//! - `import`: a thread's stored messages converted into agent-threads items and events, and checked,
//!   without changing anything.
//! - `live`: clients' view of a task's thread (the API's windows, pages, events and commands), and
//!   the backend's events on the server's event broadcast.
//! - `report`: `huntaway threads-import`, a dry run of `import` over a board's tasks, which reports
//!   what converts, what doesn't, and which tasks couldn't be switched over now.
//! - `check`: `huntaway threads-readers`, what the board's thread readers make of tasks' threads, and
//!   how long they take.

pub mod check;
pub mod history;
pub mod import;
pub mod live;
pub mod report;
pub mod store;
