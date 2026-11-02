//! `huntaway gh-mcp`: a stdio MCP server that runs the GitHub CLI for agents. Claude Code can
//! sandbox Bash, and there `gh` (and `git push`) often can't reach GitHub or the user's stored
//! login. MCP servers run outside the sandbox, so going through these tools works either way.
//! Every run gets it as the `gh` server (see `runs::start`), working in the run's directory.
//!
//! A profile (on each host) can pick the GitHub account its agents act as, and a project can
//! pick its own (`github_account`). The run passes it as `IA_GH_ACCOUNT`, and each call then runs
//! with that account's token from gh's own logins (`gh auth token --user`), whichever account is
//! active in gh, and with no other credentials (see `GhEnv`). Claude runs also get `huntaway gh-hook`, which turns away `gh` in Bash in favour
//! of these tools.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;

mod account;
mod targets;
mod env;

pub use account::*;
pub use env::*;
use targets::*;

pub const SERVER_NAME: &str = "gh";

/// Tools that only read, so they run without asking (`--allowedTools mcp__gh__<name>`).
pub const READ_ONLY: &[&str] = &["pr_view", "pr_list", "pr_checks", "pr_diff", "issue_view", "issue_list", "run_list", "run_view"];

/// The rest, which reviewers don't get.
pub const WRITES: &[&str] = &["pr_create", "pr_comment", "pr_edit", "pr_merge", "issue_create", "issue_comment", "api", "gh", "git_push"];

/// Sent with `initialize`; Claude Code adds it to the agent's system prompt.
const INSTRUCTIONS: &str = "GitHub through the gh CLI, run outside any sandbox with the user's GitHub login. Use these \
tools instead of running gh in Bash (where it may not reach GitHub or its login, or act as the wrong account), and \
git_push instead of `git push` if that fails. They work in your working directory's repository by default; pass repo \
(OWNER/REPO) for another one, or dir to run in another checkout. pr_* tools take a pull request number, URL or branch, \
defaulting to the current branch's PR. For anything else, call the gh tool with gh's arguments.";

/// The environment variable a run's account comes in (see `Account`).
pub const ACCOUNT_ENV: &str = "IA_GH_ACCOUNT";

/// `huntaway gh-hook`: Claude Code's PreToolUse hook for Bash in runs that have this server.
/// Turns away commands that run gh, saying to use these tools instead: gh in Bash may not reach
/// GitHub from the sandbox, and would act as gh's active account rather than the run's.
pub fn bash_hook() -> Result<()> {
    let mut input = String::new();
    std::io::Read::read_to_string(&mut std::io::stdin(), &mut input)?;
    let call: Value = serde_json::from_str(&input).unwrap_or_default();
    if let Some(reason) = hook_denial(&call) {
        println!("{}", json!({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason}}));
    }
    Ok(())
}

/// Why a tool call (a hook's input) is turned away, if it is.
fn hook_denial(call: &Value) -> Option<String> {
    let command = call["tool_input"]["command"].as_str().filter(|_| call["tool_name"] == "Bash")?;
    // A command the check can't read (it panics) is turned away too, rather than let through.
    let runs_gh = std::panic::catch_unwind(|| crate::changes::runs_program(command, "gh")).unwrap_or(true);
    runs_gh.then(|| {
        format!(
            "Don't run the GitHub CLI (gh) in Bash here: use the `{SERVER_NAME}` MCP server's tools instead (mcp__{SERVER_NAME}__pr_view, \
             pr_create, pr_checks, pr_merge, issue_view, api and the others; mcp__{SERVER_NAME}__gh runs any other gh command, with \
             gh's arguments). They run gh outside the sandbox as the GitHub account this project uses. Run the rest of the \
             command on its own."
        )
    })
}

/// Output beyond this is cut from the middle.
const MAX_OUTPUT: usize = 60_000;
const TIMEOUT: Duration = Duration::from_secs(600);

fn tools() -> Value {
    let repo = json!({"type": "string", "description": "OWNER/REPO, if not the working directory's repository"});
    let dir = json!({"type": "string", "description": "Directory to run in (defaults to your working directory)"});
    let pr = json!({"type": "string", "description": "Pull request number, URL or branch; defaults to the current branch's"});
    let issue = json!({"type": "string", "description": "Issue number or URL"});
    let limit = json!({"type": "integer", "minimum": 1, "maximum": 1000, "description": "At most this many (default 30)"});
    let tool = |name: &str, description: &str, mut props: Value, required: &[&str]| {
        props["repo"] = repo.clone();
        props["dir"] = dir.clone();
        // Codex runs tools marked read-only without asking, and asks for the rest.
        let annotations = json!({"readOnlyHint": READ_ONLY.contains(&name)});
        json!({"name": name, "description": description, "annotations": annotations, "inputSchema": {"type": "object", "properties": props, "required": required}})
    };
    json!([
        tool("pr_create", "Open a pull request for the current branch (push it first, e.g. with git_push). Without a title, gh fills the title and body from the commits.", json!({
            "title": {"type": "string"},
            "body": {"type": "string", "description": "Markdown"},
            "base": {"type": "string", "description": "Branch to merge into (defaults to the repository's default branch)"},
            "head": {"type": "string", "description": "Branch to merge from (defaults to the current branch)"},
            "draft": {"type": "boolean"}
        }), &[]),
        tool("pr_view", "A pull request's details as JSON: state, branches, mergeability, review decision, checks and body; with comments, its comments and reviews too.", json!({
            "pr": pr, "comments": {"type": "boolean"}
        }), &[]),
        tool("pr_list", "List pull requests as JSON.", json!({
            "state": {"type": "string", "enum": ["open", "closed", "merged", "all"], "description": "Default open"},
            "head": {"type": "string", "description": "Only PRs from this branch"},
            "base": {"type": "string", "description": "Only PRs into this branch"},
            "author": {"type": "string", "description": "Only PRs by this user (@me for yourself)"},
            "search": {"type": "string", "description": "GitHub search query"},
            "limit": limit
        }), &[]),
        tool("pr_checks", "A pull request's CI checks as JSON (name, state, bucket pass/fail/pending/skipping, link).", json!({"pr": pr}), &[]),
        tool("pr_diff", "A pull request's diff.", json!({
            "pr": pr, "name_only": {"type": "boolean", "description": "Only the names of the changed files"}
        }), &[]),
        tool("pr_comment", "Comment on a pull request.", json!({"pr": pr, "body": {"type": "string", "description": "Markdown"}}), &["body"]),
        tool("pr_edit", "Change a pull request's title, body or base branch.", json!({
            "pr": pr, "title": {"type": "string"}, "body": {"type": "string"}, "base": {"type": "string"}
        }), &[]),
        tool("pr_merge", "Merge a pull request on GitHub. This doesn't touch local branches or worktrees.", json!({
            "pr": pr,
            "method": {"type": "string", "enum": ["merge", "squash", "rebase"], "description": "Default merge"},
            "auto": {"type": "boolean", "description": "Merge once the required checks pass, instead of now"},
            "delete_branch": {"type": "boolean", "description": "Delete the PR's branch on GitHub after merging (not with auto, or for a PR from a fork)"}
        }), &[]),
        tool("issue_view", "An issue's details as JSON; with comments, its comments too.", json!({
            "issue": issue, "comments": {"type": "boolean"}
        }), &["issue"]),
        tool("issue_list", "List issues as JSON.", json!({
            "state": {"type": "string", "enum": ["open", "closed", "all"], "description": "Default open"},
            "label": {"type": "string"},
            "assignee": {"type": "string", "description": "@me for yourself"},
            "search": {"type": "string", "description": "GitHub search query"},
            "limit": limit
        }), &[]),
        tool("issue_create", "Open an issue.", json!({
            "title": {"type": "string"},
            "body": {"type": "string", "description": "Markdown"},
            "labels": {"type": "array", "items": {"type": "string"}}
        }), &["title"]),
        tool("issue_comment", "Comment on an issue.", json!({"issue": issue, "body": {"type": "string", "description": "Markdown"}}), &["issue", "body"]),
        tool("run_list", "List recent GitHub Actions workflow runs as JSON.", json!({
            "branch": {"type": "string"},
            "workflow": {"type": "string", "description": "Workflow name or file"},
            "limit": limit
        }), &[]),
        tool("run_view", "A workflow run's jobs and steps, or with log_failed, the logs of its failed steps.", json!({
            "run_id": {"type": "string", "description": "The run's id (databaseId in run_list)"},
            "log_failed": {"type": "boolean"}
        }), &["run_id"]),
        tool("api", "Call the GitHub REST API (gh api). {owner} and {repo} in the endpoint are filled in from the repository.", json!({
            "endpoint": {"type": "string", "description": "e.g. repos/{owner}/{repo}/pulls/1/comments, or graphql"},
            "method": {"type": "string", "enum": ["GET", "POST", "PATCH", "PUT", "DELETE"], "description": "Default GET (POST when there are fields)"},
            "fields": {"type": "object", "description": "Parameters: query parameters for GET, otherwise the request body. Strings are sent as they are; numbers, booleans and null as JSON."},
            "jq": {"type": "string", "description": "jq expression to filter the response with"},
            "paginate": {"type": "boolean", "description": "Fetch every page"}
        }), &["endpoint"]),
        tool("gh", "Run any gh command, for what the other tools don't cover. Nothing is interactive: pass everything as arguments.", json!({
            "args": {"type": "array", "items": {"type": "string"}, "description": "gh's arguments, e.g. [\"release\", \"list\"]"}
        }), &["args"]),
        tool("git_push", "Push a branch with git, outside the sandbox and with the user's git credentials.", json!({
            "remote": {"type": "string", "description": "Default origin"},
            "branch": {"type": "string", "description": "Default the current branch"},
            "force_with_lease": {"type": "boolean", "description": "Overwrite the remote branch if it hasn't changed since you last fetched it"}
        }), &[]),
    ])
}

/// A command to run for a tool call.
#[derive(Debug, PartialEq)]
struct Command {
    program: &'static str,
    args: Vec<String>,
    /// Exit codes that aren't failures (`gh pr checks` exits 8 while checks are pending).
    ok_codes: &'static [i32],
    /// The call's `repo`, given to gh as `GH_REPO`: not every gh command takes `--repo` (`gh
    /// api` doesn't).
    repo: Option<String>,
}

fn command(tool: &str, a: &Value) -> Result<Command> {
    let s = |k: &str| a[k].as_str().map(str::trim).filter(|v| !v.is_empty());
    let text = |k: &str| a[k].as_str(); // bodies keep their whitespace
    let yes = |k: &str| a[k].as_bool() == Some(true);
    let mut args: Vec<String> = Vec::new();
    // `--flag=value`, so a value starting with `-` isn't taken for a flag.
    let flag = |args: &mut Vec<String>, f: &str, v: Option<&str>| {
        if let Some(v) = v {
            args.push(format!("--{f}={v}"));
        }
    };
    let words = |args: &mut Vec<String>, w: &[&str]| args.extend(w.iter().map(|w| w.to_string()));
    let target = |args: &mut Vec<String>, k: &str| {
        if let Some(v) = s(k) {
            if v.starts_with('-') {
                return Err(anyhow!("bad {k}: {v}"));
            }
            args.push(v.to_string());
        }
        Ok(())
    };
    let limit = |args: &mut Vec<String>| {
        if let Some(n) = a["limit"].as_u64() {
            args.push(format!("--limit={n}"));
        }
    };
    let mut ok_codes: &'static [i32] = &[0];
    match tool {
        "pr_create" => {
            words(&mut args, &["pr", "create"]);
            match s("title") {
                Some(t) => {
                    flag(&mut args, "title", Some(t));
                    flag(&mut args, "body", Some(text("body").unwrap_or("")));
                }
                None if text("body").is_some() => bail!("give a title with the body, or neither to fill both from the commits"),
                None => args.push("--fill".into()),
            }
            flag(&mut args, "base", s("base"));
            flag(&mut args, "head", s("head"));
            if yes("draft") {
                args.push("--draft".into());
            }
        }
        "pr_view" => {
            words(&mut args, &["pr", "view"]);
            target(&mut args, "pr")?;
            let mut fields = "number,title,state,isDraft,url,author,headRefName,baseRefName,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,body".to_string();
            if yes("comments") {
                fields.push_str(",comments,reviews");
            }
            flag(&mut args, "json", Some(&fields));
        }
        "pr_list" => {
            words(&mut args, &["pr", "list"]);
            for k in ["state", "head", "base", "author", "search"] {
                flag(&mut args, k, s(k));
            }
            limit(&mut args);
            flag(&mut args, "json", Some("number,title,state,isDraft,url,author,headRefName,baseRefName,updatedAt"));
        }
        "pr_checks" => {
            words(&mut args, &["pr", "checks"]);
            target(&mut args, "pr")?;
            flag(&mut args, "json", Some("name,state,bucket,workflow,link,startedAt,completedAt"));
            ok_codes = &[0, 8];
        }
        "pr_diff" => {
            words(&mut args, &["pr", "diff"]);
            target(&mut args, "pr")?;
            if yes("name_only") {
                args.push("--name-only".into());
            }
        }
        "pr_comment" | "issue_comment" => {
            words(&mut args, &[if tool == "pr_comment" { "pr" } else { "issue" }, "comment"]);
            target(&mut args, if tool == "pr_comment" { "pr" } else { "issue" })?;
            flag(&mut args, "body", Some(text("body").context("body is required")?));
        }
        "pr_edit" => {
            words(&mut args, &["pr", "edit"]);
            target(&mut args, "pr")?;
            let before = args.len();
            flag(&mut args, "title", s("title"));
            flag(&mut args, "body", text("body"));
            flag(&mut args, "base", s("base"));
            if args.len() == before {
                bail!("nothing to change: give a title, body or base");
            }
        }
        "pr_merge" => {
            // `--repo` keeps gh from cleaning up locally (switching branches, deleting the head
            // branch and any worktree it's checked out in), so `run` resolves the PR to its
            // number and repository first.
            words(&mut args, &["pr", "merge"]);
            let (Some(number), Some(repo)) = (s("pr").filter(|n| n.chars().all(|c| c.is_ascii_digit())), s("repo")) else {
                bail!("pr_merge needs the PR's number and repository");
            };
            args.push(number.into());
            flag(&mut args, "repo", Some(repo));
            args.push(match s("method").unwrap_or("merge") {
                "merge" => "--merge".into(),
                "squash" => "--squash".into(),
                "rebase" => "--rebase".into(),
                m => bail!("unknown merge method {m}"),
            });
            if yes("auto") {
                args.push("--auto".into());
            }
            if yes("delete_branch") {
                args.push("--delete-branch".into());
            }
        }
        "issue_view" => {
            words(&mut args, &["issue", "view"]);
            target(&mut args, "issue")?;
            let mut fields = "number,title,state,url,author,assignees,labels,createdAt,body".to_string();
            if yes("comments") {
                fields.push_str(",comments");
            }
            flag(&mut args, "json", Some(&fields));
        }
        "issue_list" => {
            words(&mut args, &["issue", "list"]);
            for k in ["state", "label", "assignee", "search"] {
                flag(&mut args, k, s(k));
            }
            limit(&mut args);
            flag(&mut args, "json", Some("number,title,state,url,author,assignees,labels,updatedAt"));
        }
        "issue_create" => {
            words(&mut args, &["issue", "create"]);
            flag(&mut args, "title", Some(s("title").context("title is required")?));
            flag(&mut args, "body", Some(text("body").unwrap_or("")));
            for l in a["labels"].as_array().into_iter().flatten().filter_map(|l| l.as_str()) {
                flag(&mut args, "label", Some(l));
            }
        }
        "run_list" => {
            words(&mut args, &["run", "list"]);
            flag(&mut args, "branch", s("branch"));
            flag(&mut args, "workflow", s("workflow"));
            limit(&mut args);
            flag(&mut args, "json", Some("databaseId,workflowName,displayTitle,headBranch,event,status,conclusion,url,createdAt"));
        }
        "run_view" => {
            words(&mut args, &["run", "view"]);
            let id = s("run_id").context("run_id is required")?;
            if !id.chars().all(|c| c.is_ascii_digit()) {
                bail!("bad run_id: {id}");
            }
            args.push(id.into());
            if yes("log_failed") {
                args.push("--log-failed".into());
            }
        }
        "api" => {
            words(&mut args, &["api"]);
            let endpoint = s("endpoint").context("endpoint is required")?;
            if endpoint.starts_with('-') {
                bail!("bad endpoint: {endpoint}");
            }
            args.push(endpoint.into());
            flag(&mut args, "method", s("method"));
            for (k, v) in a["fields"].as_object().into_iter().flatten() {
                match v {
                    Value::String(v) => args.extend(["--raw-field".into(), format!("{k}={v}")]),
                    // -F reads `@file` values from disk; JSON scalars never start with `@`.
                    Value::Number(_) | Value::Bool(_) | Value::Null => args.extend(["--field".into(), format!("{k}={v}")]),
                    _ => bail!("field {k}: only strings, numbers, booleans and null (use graphql variables or a string for more)"),
                }
            }
            flag(&mut args, "jq", s("jq"));
            if yes("paginate") {
                args.push("--paginate".into());
            }
        }
        "gh" => {
            let list = a["args"].as_array().context("args must be a list of strings")?;
            for v in list {
                args.push(v.as_str().context("args must be a list of strings")?.to_string());
            }
            if args.is_empty() {
                bail!("args is empty");
            }
            refuse(&args)?;
        }
        "git_push" => {
            args.push("push".into());
            if yes("force_with_lease") {
                args.push("--force-with-lease".into());
            }
            let remote = s("remote").unwrap_or("origin");
            let branch = s("branch").unwrap_or("HEAD");
            if remote.starts_with('-') || branch.starts_with('-') {
                bail!("bad remote or branch");
            }
            // A branch name, not a refspec: `+HEAD:refs/heads/master` would force-push master.
            if !branch_name(branch) {
                bail!("branch must be a branch name");
            }
            // HEAD pushes the current branch under its own name, and -u makes it the upstream.
            args.extend(["-u".into(), remote.into(), branch.into()]);
            return Ok(Command { program: "git", args, ok_codes, repo: None });
        }
        _ => bail!("unknown tool {tool}"),
    }
    Ok(Command { program: "gh", args, ok_codes, repo: s("repo").map(String::from) })
}

/// Whether git_push's `branch` is a branch name git would take (`git check-ref-format --branch`)
/// rather than a refspec: a leading `+` forces the push and a `:` names another ref to push to.
/// A `+` further in is part of the name (`feature/c++`).
fn branch_name(branch: &str) -> bool {
    !branch.is_empty()
        && !branch.starts_with(['-', '+', '/'])
        && !branch.ends_with(['/', '.'])
        && branch != "@"
        && !["..", "//", "@{"].iter().any(|s| branch.contains(s))
        && !branch.contains(|c: char| c.is_whitespace() || c.is_control() || [':', '^', '~', '*', '?', '[', '\\'].contains(&c))
        && branch.split('/').all(|part| !part.starts_with('.') && !part.ends_with(".lock"))
}

/// Fails for gh commands no agent gets, whatever its permission mode (the gh tool's approval
/// doesn't apply in auto or bypass): `gh auth` (`gh auth token` would put the account's token in
/// the thread, as would `config get` of a host's `oauth_token`), and those that change what later
/// gh commands run (extensions, aliases, settings).
/// gh's command comes first: a flag before it could take the next argument as its value, so
/// only `--help` and `--version` may.
fn refuse<S: AsRef<str>>(args: &[S]) -> Result<()> {
    let args: Vec<&str> = args.iter().map(AsRef::as_ref).skip_while(|a| ["--help", "-h", "--version"].contains(a)).collect();
    let refused = match args[..] {
        [first, ..] if first.starts_with('-') => bail!("put gh's command first, e.g. [\"release\", \"list\", {first:?}]"),
        ["auth", ..] => "gh auth",
        ["extension" | "extensions" | "ext", ..] => "gh extension",
        // Their subcommands come first too, for the same reason.
        ["alias" | "config", second, ..] if second.starts_with('-') => bail!("put the subcommand straight after {:?}", args[0]),
        ["alias", "set" | "import" | "delete", ..] => "changing gh's aliases",
        ["config", "set" | "clear-cache", ..] => "changing gh's settings",
        // A host's settings are its login, token and all (`config get -h HOST oauth_token` prints it).
        ["config", ref rest @ ..] if rest.iter().any(|a| a.contains("oauth_token") || a.starts_with("-h") || a.starts_with("--host")) => {
            "reading a host's gh settings"
        }
        _ => return Ok(()),
    };
    bail!("{refused} isn't available to agents; ask the user to run it")
}

/// A PR's number and `[HOST/]OWNER/REPO`, from its URL.
fn pr_from_url(url: &str) -> Option<(String, String)> {
    let rest = url.trim().strip_prefix("https://").or_else(|| url.trim().strip_prefix("http://"))?;
    let parts: Vec<&str> = rest.split('/').collect();
    let [host, owner, name, "pull", number] = parts[..] else { return None };
    if number.is_empty() || !number.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let repo = if host == "github.com" { format!("{owner}/{name}") } else { format!("{host}/{owner}/{name}") };
    Some((number.to_string(), repo))
}

/// pr_merge's arguments with `pr` and `repo` resolved to the PR's number and repository.
async fn resolve_pr(a: &Value) -> Result<Value> {
    let mut args = vec!["pr".to_string(), "view".into()];
    if let Some(pr) = a["pr"].as_str().map(str::trim).filter(|p| !p.is_empty()) {
        if pr.starts_with('-') {
            bail!("bad pr: {pr}");
        }
        args.push(pr.into());
    }
    args.extend(["--json=url".into(), "--jq=.url".into()]);
    let c = Command { program: "gh", args, ok_codes: &[0], repo: a["repo"].as_str().map(str::trim).filter(|r| !r.is_empty()).map(String::from) };
    let (text, failed) = exec(&c, a).await?;
    if failed {
        bail!("couldn't find the pull request: {text}");
    }
    let (number, repo) = pr_from_url(&text).with_context(|| format!("unexpected pull request URL {text}"))?;
    let mut a = a.clone();
    a["pr"] = json!(number);
    a["repo"] = json!(repo);
    Ok(a)
}

/// Where a call runs: its `dir`, or the run's directory.
fn work_dir(a: &Value) -> Option<PathBuf> {
    let dir = a["dir"].as_str().filter(|d| !d.trim().is_empty()).map(String::from).or_else(|| std::env::var("IA_CWD").ok())?;
    Some(crate::util::expand_tilde(&dir))
}

/// Keep the start and end of long output (a log's failure is usually at the end).
fn clip(s: &str) -> String {
    if s.len() <= MAX_OUTPUT {
        return s.to_string();
    }
    let floor = |mut i: usize| {
        while !s.is_char_boundary(i) {
            i -= 1;
        }
        i
    };
    let head = floor(MAX_OUTPUT / 2);
    let tail = floor(s.len() - MAX_OUTPUT / 2);
    format!("{}\n\n[… {} bytes cut …]\n\n{}", &s[..head], tail - head, &s[tail..])
}

/// Run a tool call: its output, and whether it failed.
async fn run(tool: &str, a: &Value) -> Result<(String, bool)> {
    if merges(tool, a) {
        if let Some(why) = merge_gate().await? {
            return Ok((why, true));
        }
    }
    let a = if tool == "pr_merge" { resolve_pr(a).await? } else { a.clone() };
    exec(&command(tool, &a)?, &a).await
}

/// The board's line to the run this server is for, which the commands it runs don't get.
const BOARD_ENV: [&str; 3] = ["IA_URL", "IA_TOKEN", "IA_RUN_ID"];

/// Whether call `a` to `tool` may merge a pull request: pr_merge, `gh pr merge`, or GitHub's API
/// (REST or GraphQL) with "merge" anywhere in the call, or with a request read from a file, which
/// can't be seen. It errs on the side of asking the board: a call that only reads (a PR's
/// mergeability, say) is refused too while a merge waits for approval, and pr_view has that.
fn merges(tool: &str, a: &Value) -> bool {
    match tool {
        "pr_merge" => true,
        // Wherever its words are: flags (and their values) can come between a command and its
        // subcommand (`pr --repo o/r merge`), so any call with both words counts.
        "gh" => {
            let args: Vec<&str> = a["args"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
            let has = |w: &str| args.iter().any(|a| a.eq_ignore_ascii_case(w));
            // `--input FILE` (or `-`) is the request body, and `-F key=@FILE` a field's value.
            let from_file = args.iter().any(|a| a.starts_with("--input") || a.starts_with('@') || a.contains("=@"));
            (has("pr") && has("merge")) || (has("api") && (from_file || mentions_merge(&args.join(" "))))
        }
        // Its string fields are sent as they are (--raw-field), never read from files.
        "api" => mentions_merge(&a.to_string()),
        _ => false,
    }
}

fn mentions_merge(call: &str) -> bool {
    call.to_ascii_lowercase().contains("merge")
}

/// Why the board won't let this run merge, if it won't (see merge_gate.rs). A server started
/// without the board's address (by hand, say) has no say from it.
async fn merge_gate() -> Result<Option<String>> {
    let board = BOARD_ENV.map(std::env::var);
    #[cfg(test)]
    let board = TEST_BOARD.with_borrow(Clone::clone).map(|b| b.map(Ok)).unwrap_or(board);
    let [Ok(url), Ok(token), Ok(run_id)] = board else { return Ok(None) };
    let check = async {
        let res = reqwest::Client::new().get(format!("{url}/api/internal/merge-gate/{run_id}")).bearer_auth(token).send().await?.error_for_status()?;
        anyhow::Ok(res.json::<Value>().await?)
    };
    let v = tokio::time::timeout(std::time::Duration::from_secs(30), check)
        .await
        .map_err(|_| anyhow!("timed out"))
        .and_then(|r| r)
        .context("couldn't ask the board whether this merge is approved, so it wasn't merged (try again)")?;
    Ok(v["blocked"].as_str().map(String::from))
}

/// Run a command where call `a` runs, as the run's account if it has one: its output, and
/// whether it failed.
async fn exec(c: &Command, a: &Value) -> Result<(String, bool)> {
    let mut cmd = tokio::process::Command::new(if c.program == "gh" { gh_program() } else { c.program.to_string() });
    // Kept until gh is done with it.
    let mut _gh_env = None;
    if let Some(account) = Account::from_env() {
        if c.program == "git" {
            // To another host, the push would go as whoever git's credentials (or SSH keys) there
            // are. So it's to a remote by name, all of whose push URLs (as git rewrites them) are
            // checked: a URL given as the remote would be rewritten when pushing.
            let remote = c.args.iter().position(|a| a == "-u").and_then(|i| c.args.get(i + 1)).map_or("origin", String::as_str);
            let Some(urls) = push_urls(work_dir(a).as_deref(), remote).await else {
                bail!("there's no remote named {remote}: with a GitHub account set, git_push takes a remote's name (add one with git remote add)");
            };
            account.check_git_urls(&urls)?;
            let token = account.token().await?;
            cmd.args(extra_header_resets(work_dir(a).as_deref()).await).args(account.git_config()).env("IA_GH_GIT_TOKEN", &token);
        } else {
            account.check_targets(&c.args, c.repo.as_deref())?;
            let env = account.env(&account.token().await?)?;
            env.apply(&mut cmd);
            _gh_env = Some(env);
        }
    }
    cmd.args(&c.args)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_PAGER", "cat")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for k in BOARD_ENV {
        cmd.env_remove(k);
    }
    // Only the call's own repository, which was checked.
    cmd.env_remove("GH_REPO");
    if let Some(r) = &c.repo {
        cmd.env("GH_REPO", r);
    }
    if let Some(d) = work_dir(a) {
        if !d.is_dir() {
            bail!("{} is not a directory", d.display());
        }
        cmd.current_dir(d);
    }
    let child = cmd.spawn().with_context(|| format!("couldn't run {}", c.program))?;
    let out = tokio::time::timeout(TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| anyhow!("{} timed out after {} seconds", c.program, TIMEOUT.as_secs()))??;
    let (stdout, stderr) = (String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    let failed = !out.status.code().is_some_and(|code| c.ok_codes.contains(&code));
    let mut text = stdout.trim_end().to_string();
    if !stderr.trim().is_empty() {
        if !text.is_empty() {
            text.push_str("\n\n");
        }
        text.push_str(stderr.trim_end());
    }
    if failed {
        text.push_str(&format!("\n\n({} exited with {})", c.program, out.status));
    } else if text.is_empty() {
        text = "Done.".into();
    }
    Ok((clip(text.trim_start()), failed))
}

async fn handle(req: Value) -> Option<Value> {
    let id = req.get("id").cloned()?; // notifications get no response
    let method = req["method"].as_str().unwrap_or("");
    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": req["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "huntaway-gh", "version": env!("CARGO_PKG_VERSION")},
            "instructions": match Account::from_env() {
                Some(a) => format!("{INSTRUCTIONS} They act as the GitHub account {a}."),
                None => INSTRUCTIONS.to_string(),
            },
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools": tools()})),
        "tools/call" => {
            let name = req["params"]["name"].as_str().unwrap_or("");
            Ok(match run(name, &req["params"]["arguments"]).await {
                Ok((text, failed)) => json!({"content": [{"type": "text", "text": text}], "isError": failed}),
                Err(e) => json!({"content": [{"type": "text", "text": format!("Error: {e:#}")}], "isError": true}),
            })
        }
        _ => Err(json!({"code": -32601, "message": format!("method not found: {method}")})),
    };
    Some(match result {
        Ok(r) => json!({"jsonrpc": "2.0", "id": id, "result": r}),
        Err(e) => json!({"jsonrpc": "2.0", "id": id, "error": e}),
    })
}

pub async fn serve_stdio() -> Result<()> {
    let stdout = std::sync::Arc::new(tokio::sync::Mutex::new(tokio::io::stdout()));
    let mut lines = tokio::io::AsyncBufReadExt::lines(tokio::io::BufReader::new(tokio::io::stdin()));
    // Calls run concurrently, and the ones still running when stdin closes get to finish.
    let mut calls = tokio::task::JoinSet::new();
    while let Some(line) = lines.next_line().await? {
        let Ok(req) = serde_json::from_str::<Value>(&line) else { continue };
        let stdout = stdout.clone();
        calls.spawn(async move {
            if let Some(resp) = handle(req).await {
                let mut out = stdout.lock().await;
                let _ = out.write_all(format!("{resp}\n").as_bytes()).await;
                let _ = out.flush().await;
            }
        });
    }
    calls.join_all().await;
    Ok(())
}

#[cfg(test)]
mod tests;
