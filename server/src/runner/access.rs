//! What a run may use: the board's tools, GitHub, and the folders its sandbox lets it write.

use super::*;

/// The board tools a Claude run gets without asking (`--allowedTools`). In auto mode that's all
/// but `wait`, so Claude's classifier reviews each wait as it does the agent's Bash calls: a
/// wait's command runs like one of them (see tools.rs).
pub(super) fn board_tools_allowed(permission_mode: &str, review: bool) -> Vec<String> {
    if permission_mode != "auto" {
        return vec![format!("mcp__{MCP_SERVER_NAME}")];
    }
    crate::mcp::tool_names(review).into_iter().filter(|t| t != "wait").map(|t| format!("mcp__{MCP_SERVER_NAME}__{t}")).collect()
}

/// Whether Claude itself approved the `wait` calls of the run with these launch arguments (in
/// auto mode, see `board_tools_allowed`), so a wait's command needs no prompt of ours. Not for a
/// Codex run, one in another mode, or one that pre-approves `wait` under the board's current or
/// old server name, like an auto run started by an older build.
pub fn approves_own_waits(args: &[String]) -> bool {
    let auto = args.windows(2).any(|w| w[0] == "--permission-mode" && w[1] == "auto");
    let Some(i) = args.iter().position(|a| a == "--allowedTools").filter(|_| auto) else { return false };
    let pre_approved = [MCP_SERVER_NAME, LEGACY_MCP_SERVER_NAME].map(|n| [format!("mcp__{n}"), format!("mcp__{n}__wait")]);
    let mut allowed = args[i + 1..].iter().take_while(|a| !a.starts_with("--")).flat_map(|a| a.split([',', ' ']));
    !allowed.any(|t| pre_approved.iter().flatten().any(|p| p == t))
}

/// A Codex run's effort, as `codex_effort` has it with the config's models (as it is if they can't be listed).
pub(super) async fn codex_run_effort(config: &db::ClaudeConfig, model: Option<&str>, effort: Option<String>) -> Option<String> {
    if effort.is_none() {
        return None;
    }
    match crate::codex::models(config.dir()).await {
        Ok(models) => codex_effort(effort, model, &models),
        Err(_) => effort,
    }
}

/// A Codex run's effort, if its model (or the default model) takes it; otherwise that model's own default. Models
/// that don't say which efforts they take take any.
pub(super) fn codex_effort(effort: Option<String>, model: Option<&str>, models: &[crate::codex::Model]) -> Option<String> {
    let m = match model {
        Some(id) => models.iter().find(|m| m.id == id),
        None => models.iter().find(|m| m.is_default).or(models.first()),
    };
    match (effort, m) {
        (Some(e), Some(m)) if !m.efforts.is_empty() && !m.efforts.contains(&e) => m.default_effort.clone(),
        (e, _) => e,
    }
}

/// Whether the agent's own reviewer approved the `wait` calls of a run, command included:
/// Claude's classifier (see `approves_own_waits`) or Codex's reviewer (`codex::Spec::review_waits`).
pub fn agent_reviews_waits(state: &Shared, run_id: &str) -> bool {
    match crate::runs::codex_spec(state, run_id) {
        Some(spec) => spec.review_waits,
        None => approves_own_waits(&crate::runs::launch_args(state, run_id)),
    }
}

/// The git directory a worktree shares with its repository, where commits are written.
/// The gh server's tools a Claude run uses without asking: the read-only ones, and `pr_merge`
/// while its task is merging, since moving the task to "Ready for merge" was the user's say-so.
/// Allowed tools skip auto mode's classifier too, so a merge doesn't stall when it fails.
pub(super) fn gh_allowed(task: &Task) -> Vec<&'static str> {
    let mut tools = crate::gh_mcp::READ_ONLY.to_vec();
    if task.merging && task.kind == "task" {
        tools.push("pr_merge");
    }
    tools
}

/// Whether a run gets our gh server: unless the project turns it off or has its own by that name.
pub(super) fn uses_gh_server(tools: &crate::agent_tools::RunTools) -> bool {
    let name = crate::gh_mcp::SERVER_NAME;
    !tools.mcp_servers.contains_key(name) && !tools.disallowed.contains(&crate::agent_tools::tool_prefix(name))
}

/// The GitHub account a run's gh tools act as: the project's, or else its profile's.
pub fn github_account(project: Option<&Project>, profile: &Profile) -> Option<String> {
    let set = |a: &Option<String>| a.as_deref().map(str::trim).filter(|a| !a.is_empty()).map(String::from);
    project.and_then(|p| set(&p.github_account)).or_else(|| set(&profile.github_account))
}

/// The environment that makes gh act as the GitHub account `task`'s runs use (see
/// `github_account`), for the host's own gh calls about the task (see gh_mcp::account_env). None
/// when no account is set, which leaves gh's active account. Fails when the account set isn't
/// signed in to gh, so nothing runs as another account instead.
pub async fn task_gh_env(state: &Shared, task: &Task) -> Result<Option<crate::gh_mcp::GhEnv>> {
    crate::gh_mcp::account_env(task_github_account(state, task)?.as_deref()).await
}

/// The GitHub account `task`'s runs use (see `github_account`), if one is set.
pub fn task_github_account(state: &Shared, task: &Task) -> Result<Option<String>> {
    let c = state.db();
    let project = match &task.project_id {
        Some(id) => Some(db::get_project(&c, id)?.context("project not found")?),
        None => None,
    };
    let profile = db::get_profile(&c, &task.profile_id)?.context("profile not found")?;
    Ok(github_account(project.as_ref(), &profile))
}

/// What a Claude run with our gh server is told about GitHub. gh in Bash is turned away (see
/// `gh_hook_settings`).
pub(super) fn gh_note(account: Option<&str>) -> String {
    format!(
        "\n\nFor GitHub (pull requests, issues, CI runs, the API), use the `{0}` MCP server's tools (mcp__{0}__pr_view, \
         pr_create, pr_checks and so on; mcp__{0}__gh runs any other gh command) rather than the gh CLI in Bash, which is \
         blocked here. They run gh outside the sandbox{1}.",
        crate::gh_mcp::SERVER_NAME,
        account.map(|a| format!(" as the GitHub account {a}")).unwrap_or_default()
    )
}

/// `--settings` for a Claude run with our gh server: a PreToolUse hook that turns away gh in
/// Bash (`huntaway gh-hook`), which may not reach GitHub from the sandbox or would act as gh's
/// active account rather than the run's.
pub(super) fn gh_hook_settings(exe: &std::path::Path) -> String {
    let command = format!("'{}' gh-hook", path_str(exe).replace('\'', r"'\''"));
    json!({"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": command, "timeout": 10}]}]}}).to_string()
}

pub(super) async fn git_common_dir(cwd: &str) -> Option<String> {
    let out = tokio::process::Command::new("git")
        .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .current_dir(crate::util::expand_tilde(cwd))
        .output()
        .await
        .ok()?;
    let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !dir.is_empty()).then_some(dir)
}

/// Package managers' caches, which Codex's `workspace-write` sandbox would otherwise keep
/// read-only (so `npm ci`, say, fails). Each is made first if it's missing, parents and all, as
/// the sandbox would keep its tool from making it on first use. In the home directory, or where
/// the environment says (`env`, e.g. `CARGO_HOME` for a system-wide Cargo).
pub(super) fn cache_dirs() -> Vec<String> {
    dirs::home_dir().map(|h| cache_dirs_in(&h, |k| std::env::var(k).ok())).unwrap_or_default()
}

pub(super) fn cache_dirs_in(home: &std::path::Path, env: impl Fn(&str) -> Option<String>) -> Vec<String> {
    let base = |var: &str, default: &str| env(var).filter(|v| v.starts_with('/')).map(std::path::PathBuf::from).unwrap_or_else(|| home.join(default));
    let (cargo, data) = (base("CARGO_HOME", ".cargo"), base("XDG_DATA_HOME", ".local/share"));
    let dirs = [base("XDG_CACHE_HOME", ".cache"), home.join(".npm"), cargo.join("registry"), cargo.join("git"), data.join("pnpm")];
    dirs.into_iter().filter(|p| std::fs::create_dir_all(p).is_ok()).map(|p| path_str(&p)).collect()
}

/// A reviewer's `codex::Spec::filesystem`: it writes `write` and reads `work` (its working and
/// git directories), which stay read-only even inside a cache or temp directory (a test server's).
pub(super) fn review_filesystem(write: Vec<String>, work: Vec<String>) -> std::collections::BTreeMap<String, String> {
    let write = write.into_iter().map(|p| (p, "write".to_string()));
    write.chain(work.into_iter().map(|p| (p, "read".to_string()))).collect()
}

/// Agents' own settings, which stay read-only to a reviewer even when git ignores them.
const AGENT_DIRS: &[&str] = &[".git", ".claude", ".codex", ".agents"];

/// Most git-ignored directories a reviewer may write.
const MAX_IGNORED_DIRS: usize = 200;

/// The directories in `cwd` that git ignores as a whole (build output, installed packages): a
/// reviewer may write them without changing the work, which they hold none of. Absolute paths.
pub(super) async fn ignored_dirs(cwd: &str) -> Vec<String> {
    let dir = crate::util::expand_tilde(cwd);
    let git = |args: &[&str], input: Option<String>| {
        let mut cmd = tokio::process::Command::new("git");
        cmd.args(args).current_dir(&dir).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
        async move {
            let mut child = cmd.spawn().ok()?;
            let mut stdin = child.stdin.take()?;
            // Written while the output is read, which check-ignore writes as it goes.
            let write = async move {
                if let Some(input) = input {
                    let _ = tokio::io::AsyncWriteExt::write_all(&mut stdin, input.as_bytes()).await;
                }
            };
            let (_, out) = tokio::join!(write, child.wait_with_output());
            let out = out.ok()?;
            Some((out.status.code(), String::from_utf8_lossy(&out.stdout).into_owned()))
        }
    };
    let Some((Some(0), listed)) = git(&["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], None).await else {
        return Vec::new();
    };
    // That lists untracked directories with only ignored files in them too.
    let candidates: Vec<&str> =
        listed.split('\0').filter_map(|p| p.strip_suffix('/')).filter(|p| !p.split('/').any(|c| AGENT_DIRS.contains(&c))).take(MAX_IGNORED_DIRS).collect();
    if candidates.is_empty() {
        return Vec::new();
    }
    // Exits with 1 when none of them is ignored.
    let Some((Some(0), ignored)) = git(&["check-ignore", "-z", "--stdin"], Some(candidates.join("\0"))).await else { return Vec::new() };
    ignored.split('\0').filter(|p| !p.is_empty()).map(|p| path_str(&dir.join(p))).collect()
}
