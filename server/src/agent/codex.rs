//! Codex agents. A thread whose config is for Codex (see db::AGENTS) runs `huntaway
//! codex-run` under ia-shim instead of `claude -p`. That adapter starts `codex app-server`,
//! speaks its JSON-RPC protocol (JSONL over stdio), and runs one turn: it starts or resumes the
//! thread, sends the prompt, answers approval requests by asking the board (the same
//! `permission_prompt` call the MCP helper makes for Claude), and exits once the turn ends.
//!
//! With `Spec::input`, its stdin takes the same stream-json input as Claude Code's (see
//! runner::steer): the prompt is the first user message, a message that arrives during the
//! turn is steered into it (`turn/steer`), one that arrives between turns starts the next turn,
//! and an `interrupt` control request interrupts the turn. It echoes each message back (as
//! `--replay-user-messages` does) once the model has taken it in, and exits when its input
//! ends with no turn going.
//!
//! It writes the app-server's notifications to stdout as they are (`out.jsonl`), and the server
//! turns them into thread messages shaped like Claude Code's stream-json (`handle_line`), so the
//! thread view shows both agents the same way. Like the rest of a run directory these lines are
//! a stable format: they're Codex's own protocol, which a newer server must keep reading.
//!
//! `codex.json` in the run directory holds what the runner decided for the run (see `Spec`);
//! the MCP servers come from the same `mcp.json` Claude gets, converted to Codex's config.

use std::collections::BTreeSet;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};

use crate::agent::runner::MCP_SERVER_NAME;
use crate::db::{self, Run};
use crate::state::Shared;
use crate::util::{expand_tilde, path_str, truncate};

mod rpc;
mod adapter;
mod queries;
mod output;

pub use adapter::*;
pub use queries::*;
pub use output::*;
use rpc::*;

pub fn program() -> String {
    std::env::var("IA_CODEX_BIN").unwrap_or_else(|_| "codex".into())
}

/// What a run needs from the runner, saved as `codex.json` in the run directory.
#[derive(Serialize, Deserialize, Default, Debug, Clone)]
pub struct Spec {
    pub cwd: String,
    /// The Codex thread to resume (the task's session id).
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    pub approval_policy: String,
    pub approvals_reviewer: String,
    /// `read-only`, `workspace-write` or `danger-full-access`.
    pub sandbox: String,
    /// Codex's plan mode (collaboration mode `plan`).
    #[serde(default)]
    pub plan: bool,
    /// Compact the conversation instead of running a prompt.
    #[serde(default)]
    pub compact: bool,
    #[serde(default)]
    pub developer_instructions: String,
    /// Stdin is stream-json input (see the module docs), not just the prompt.
    #[serde(default)]
    pub input: bool,
    /// Writable on top of the working directory (e.g. a worktree's git directory).
    #[serde(default)]
    pub writable_roots: Vec<String>,
    /// With a `read-only` sandbox, paths to `write` besides the temp directories (a reviewer's
    /// build output and caches) and paths inside those to keep `read`, through a permission
    /// profile (see `REVIEW_PROFILE`). The most specific path wins.
    #[serde(default)]
    pub filesystem: BTreeMap<String, String>,
    /// Holds the project's skills, one directory each.
    #[serde(default)]
    pub skills_dir: Option<String>,
    /// MCP servers whose tools run without asking (the board's always does).
    #[serde(default)]
    pub approved_mcp_servers: Vec<String>,
    /// MCP tools the agent doesn't get, by server (e.g. a reviewer's gh tools that write).
    #[serde(default)]
    pub disabled_mcp_tools: HashMap<String, Vec<String>>,
    /// Codex's reviewer reviews the board's `wait` calls (auto mode), command included, so the
    /// board runs a wait's command without asking. A run from an older build pre-approved them.
    #[serde(default)]
    pub review_waits: bool,
    /// Revert the thread to before this turn first (a rewind's, see checkpoints::Rewind).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revert_before_turn: Option<String>,
}

/// How a permission mode runs under Codex: (approval policy, approvals reviewer, sandbox).
/// Reviewers get a read-only sandbox (they read and report) and run what fits in it unasked;
/// `Spec::filesystem` lets them build and test in it.
pub fn policy(mode: &str, review: bool) -> (&'static str, &'static str, &'static str) {
    match mode {
        "bypassPermissions" => ("never", "user", "danger-full-access"),
        _ if review => ("never", "user", "read-only"),
        "dontAsk" => ("never", "user", "workspace-write"),
        "acceptEdits" => ("on-request", "user", "workspace-write"),
        // Codex's own reviewer decides, like Claude's auto mode.
        "auto" => ("on-request", "auto_review", "workspace-write"),
        "plan" => ("untrusted", "user", "read-only"),
        _ => ("untrusted", "user", "workspace-write"),
    }
}

/// The permission profile of a read-only sandbox with `Spec::filesystem`: it reads everything and
/// writes only the temp directories and the paths given, so a reviewer can run the tests without
/// being able to change the work. (Codex's `workspace-write` always lets the working directory be
/// written.)
pub const REVIEW_PROFILE: &str = "huntaway-review";

/// The `thread/start` (and `thread/resume`) parameters for a run.
fn thread_params(spec: &Spec, cwd: &Path, servers: Map<String, Value>) -> Value {
    let mut config = json!({
        "mcp_servers": servers,
        // The plan tool, shown as a todo list.
        "tools.update_plan.enabled": true,
    });
    let profile = uses_profile(spec);
    if profile {
        // A profile replaces the sandbox settings, which mustn't be given alongside it.
        let mut fs = Map::new();
        fs.insert(":tmpdir".into(), json!("write"));
        fs.insert(":slash_tmp".into(), json!("write"));
        for (path, access) in &spec.filesystem {
            fs.insert(path.clone(), json!(access));
        }
        config["default_permissions"] = json!(REVIEW_PROFILE);
        config["permissions"] = json!({REVIEW_PROFILE: {"extends": ":read-only", "filesystem": fs, "network": {"enabled": true}}});
    } else {
        // Agents need the network (git push, gh, package managers), as Claude's do.
        config["sandbox_workspace_write"] = json!({"network_access": true});
        if !spec.writable_roots.is_empty() {
            config["sandbox_workspace_write"]["writable_roots"] = json!(spec.writable_roots);
        }
    }
    let mut params = json!({
        "cwd": crate::util::path_str(cwd),
        "approvalPolicy": spec.approval_policy,
        "approvalsReviewer": spec.approvals_reviewer,
        "config": config,
        "developerInstructions": spec.developer_instructions,
    });
    if !profile {
        params["sandbox"] = json!(spec.sandbox);
    }
    if let Some(m) = &spec.model {
        params["model"] = json!(m);
    }
    params
}

fn uses_profile(spec: &Spec) -> bool {
    spec.sandbox == "read-only" && !spec.filesystem.is_empty()
}

/// Whether `model` names a Claude model, so a Codex thread shouldn't inherit it from its
/// project, profile or host.
pub fn is_claude_model(model: &str) -> bool {
    let m = model.trim().to_ascii_lowercase();
    ["fable", "opus", "sonnet", "haiku", "default", "opusplan"].contains(&m.as_str()) || m.starts_with("claude")
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod subagent_tests;
