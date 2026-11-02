//! The `huntaway` MCP tools that agents call, executed here on behalf of the agent's MCP
//! helper (`POST /api/internal/mcp`). Calls are deduplicated by call id, so a helper that
//! retries across a server restart never runs a tool twice.
//!
//! Tools act on the caller's profile's board and on the boards of the other profiles that let
//! its agents in (`Profile::agent_access`). `list_projects` covers all of them, labelled with
//! their profile; projects and tasks can be named by id, by key (`SD`, `SD-3`), or by key
//! qualified with a profile (`work:SD-3`) or the `profile` argument. An unqualified key means
//! the caller's own board if it has it there, else the one other board that has it; a key on
//! several other boards must be qualified.
//!
//! A project or task that isn't found here is looked up on linked hosts (`POST
//! /api/tools/<tool>` there), and `list_projects` covers every host, so an orchestrating agent
//! can work across machines.

use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;

use crate::api::{self, CreateProject, CreateTask};
use crate::db::{self, Task};
use crate::state::Shared;
use crate::{hub, mcp, permissions, relocate, runner};

mod approvals;
mod automations;
mod dispatch;
mod local;
mod projects;
mod resolve;
mod tasks;

pub use dispatch::*;
pub use projects::*;

use approvals::*;
use automations::*;
use local::*;
use resolve::*;
use tasks::*;

#[cfg(test)]
mod tests;

/// Who is calling. The caller's profile picks the boards it can use: its own (`profile_id`,
/// unset when this host has no profile by its name) and those whose profiles let it in. The
/// task is set for agent calls, with the call's id: a change the user has to approve is asked
/// in the task's thread, once per call.
pub struct Ctx {
    pub profile_id: Option<String>,
    pub profile_name: String,
    pub task: Option<Task>,
    pub call_id: Option<String>,
    /// The original caller's helper advertises get_task_field (not just this host's build).
    pub task_fields: bool,
}

impl Ctx {
    fn is_own(&self, p: &db::Profile) -> bool {
        self.profile_id.as_deref() == Some(p.id.as_str())
    }
}

enum ToolError {
    NotFound(String),
    Other(String),
}

impl From<anyhow::Error> for ToolError {
    fn from(e: anyhow::Error) -> Self {
        ToolError::Other(format!("{e:#}"))
    }
}

impl From<rusqlite::Error> for ToolError {
    fn from(e: rusqlite::Error) -> Self {
        ToolError::Other(e.to_string())
    }
}

impl From<crate::state::ApiError> for ToolError {
    fn from(e: crate::state::ApiError) -> Self {
        if e.0 == axum::http::StatusCode::NOT_FOUND { ToolError::NotFound(e.1) } else { ToolError::Other(e.1) }
    }
}

type ToolResult = std::result::Result<Value, ToolError>;

fn msg(e: ToolError) -> String {
    match e {
        ToolError::NotFound(m) | ToolError::Other(m) => m,
    }
}
