//! Git worktree lifecycle for tasks: setup (worktree add, ignored files, setup script),
//! teardown (teardown script + worktree remove), and diffs for review.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Value, json};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::db::{self, Project, Task};
use crate::state::Shared;
use crate::util::{path_str, slugify, truncate};

mod upstream;
mod scripts;
mod setup;
mod start;
mod remove;
mod pr;
mod remote;
mod changes;

pub use upstream::*;
pub use scripts::*;
pub use setup::*;
pub use start::*;
pub use remove::*;
pub use pr::*;
pub use remote::*;
pub use changes::*;

pub struct Output {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

pub async fn git(dir: &Path, args: &[&str]) -> Result<Output> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .stdin(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0")
        .kill_on_drop(true)
        .output()
        .await
        .context("failed to run git")?;
    Ok(Output {
        ok: out.status.success(),
        stdout: String::from_utf8_lossy(&out.stdout).to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).to_string(),
    })
}

async fn git_ok(dir: &Path, args: &[&str]) -> Result<String> {
    let o = git(dir, args).await?;
    if !o.ok {
        bail!("git {} failed: {}", args.join(" "), o.stderr.trim());
    }
    Ok(o.stdout)
}

pub async fn is_git_repo(dir: &Path) -> bool {
    matches!(git(dir, &["rev-parse", "--git-dir"]).await, Ok(o) if o.ok)
}

pub async fn current_branch(dir: &Path) -> Option<String> {
    let o = git(dir, &["symbolic-ref", "--short", "HEAD"]).await.ok()?;
    o.ok.then(|| o.stdout.trim().to_string()).filter(|s| !s.is_empty())
}

/// Whether git takes `name` for a branch name (`git check-ref-format --branch`), run outside any
/// repository so that `@{-1}` (the branch checked out before) isn't taken for the one it names.
pub fn valid_branch_name(name: &str) -> bool {
    let run = std::process::Command::new("git")
        .args(["check-ref-format", "--branch", name])
        .current_dir("/")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    !name.contains("@{") && run.is_ok_and(|st| st.success())
}

/// The worktree (main checkout included) that has `branch_ref` checked out, if any.
async fn checked_out_in(repo: &Path, branch_ref: &str) -> Option<PathBuf> {
    let list = git_ok(repo, &["worktree", "list", "--porcelain"]).await.ok()?;
    let mut dir = None;
    for line in list.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            dir = Some(PathBuf::from(p));
        } else if line.strip_prefix("branch ") == Some(branch_ref) {
            return dir;
        }
    }
    None
}

/// Whether `dir` is one of `repo`'s worktrees (the main checkout included), by git's own list.
async fn is_worktree_of(repo: &Path, dir: &Path) -> bool {
    let Ok(list) = git_ok(repo, &["worktree", "list", "--porcelain"]).await else { return false };
    let dir = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
    list.lines()
        .filter_map(|l| l.strip_prefix("worktree "))
        .any(|p| PathBuf::from(p).canonicalize().map(|p| p == dir).unwrap_or(false))
}

/// The commit `rev` names, if it names one.
async fn commit(repo: &Path, rev: &str) -> Option<String> {
    git_ok(repo, &["rev-parse", "--verify", "--quiet", &format!("{rev}^{{commit}}")]).await.ok().map(|s| s.trim().to_string())
}

/// Whether commit `a` is in `b`'s history (or is `b`).
async fn is_ancestor(repo: &Path, a: &str, b: &str) -> bool {
    git(repo, &["merge-base", "--is-ancestor", a, b]).await.is_ok_and(|o| o.ok)
}

fn plural(n: &str) -> &'static str {
    if n == "1" { "" } else { "s" }
}

fn load(state: &Shared, task_id: &str) -> Result<(Task, Project)> {
    let c = state.db();
    let task = db::get_task(&c, task_id)?.ok_or_else(|| anyhow!("task not found"))?;
    let pid = task.project_id.clone().ok_or_else(|| anyhow!("task has no project"))?;
    let project = db::get_project(&c, &pid)?.ok_or_else(|| anyhow!("project not found"))?;
    Ok((task, project))
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod approval_tests;
