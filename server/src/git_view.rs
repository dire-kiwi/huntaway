//! The Changes tab, a lazygit-style view of a task's repository (API 66): the working tree's files,
//! the commits on the task's branch and the stashes, the diff of a file, commit or stash, and what
//! can be done from there: staging and unstaging whole files or chosen lines (a patch the UI makes
//! from a file's diff, applied to the index), discarding, committing, amending, stashing and
//! resetting. Everything runs at the top of the folder `worktree::diff` shows: the task's worktree
//! once it's ready, else its project's repository.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;

use anyhow::{Context, Result};
use axum::Json;
use axum::extract::{Path as UrlPath, Query, State};
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::db::{Project, Task};
use crate::state::{ApiError, ApiResult, Shared};
use crate::util::{path_str, truncate};
use crate::worktree;

/// Past this a file's diff isn't sent, and only the whole file can be staged.
const MAX_DIFF: usize = 4 << 20;
/// Files listed at most (an untracked folder that should have been ignored can hold many).
const MAX_FILES: usize = 5000;
/// Commits listed on the branch, and from its base before it.
const MAX_COMMITS: usize = 300;
const BASE_COMMITS: usize = 30;

/// What a git command did. Its output is decoded lossily, so `utf8` says whether it was text a patch can be made from.
struct Out {
    ok: bool,
    stdout: String,
    stderr: String,
    utf8: bool,
}

/// Runs git in `dir` with paths unquoted and no editor, with `input` on its stdin.
async fn run(dir: &Path, args: &[&str], input: Option<&str>) -> Result<Out> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(dir)
        .args(["-c", "core.quotePath=false"])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        // Polling the status mustn't take the index lock an agent's git command may want.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().context("failed to run git")?;
    let stdin = child.stdin.take();
    let write = async {
        if let (Some(mut w), Some(text)) = (stdin, input) {
            // Git may stop reading early (a bad patch); what it says about it is what matters.
            let _ = w.write_all(text.as_bytes()).await;
        }
    };
    let (_, out) = tokio::join!(write, child.wait_with_output());
    let out = out.context("failed to run git")?;
    Ok(Out {
        ok: out.status.success(),
        stdout: String::from_utf8_lossy(&out.stdout).to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).to_string(),
        utf8: std::str::from_utf8(&out.stdout).is_ok(),
    })
}

/// Git's own message for a command that failed (a 409: the repository isn't in a state for it).
fn failed(o: &Out) -> ApiError {
    let msg = [o.stderr.trim(), o.stdout.trim()].into_iter().find(|m| !m.is_empty()).unwrap_or("git failed");
    ApiError::conflict(msg.to_string())
}

/// `run`, failing with git's own message when git does.
async fn run_ok(dir: &Path, args: &[&str], input: Option<&str>) -> ApiResult<String> {
    let o = run(dir, args, input).await?;
    if !o.ok {
        return Err(failed(&o));
    }
    Ok(o.stdout)
}

/// The task's changes: the top of the working tree they're in, and the folder, task and project it's for.
struct Repo {
    top: PathBuf,
    dir: PathBuf,
    task: Task,
    project: Project,
}

/// The task's working tree, if it's in one.
async fn repo(s: &Shared, task_id: &str) -> ApiResult<Option<Repo>> {
    let (dir, task, project) = worktree::changes_dir(s, task_id).map_err(|e| ApiError(StatusCode::NOT_FOUND, format!("{e:#}")))?;
    let o = run(&dir, &["rev-parse", "--show-toplevel"], None).await?;
    Ok(o.ok.then(|| Repo { top: PathBuf::from(o.stdout.trim()), dir, task, project }))
}

async fn top(s: &Shared, task_id: &str) -> ApiResult<PathBuf> {
    repo(s, task_id).await?.map(|r| r.top).ok_or_else(|| ApiError::bad("not a git repository"))
}

/// A path in the repository, from its top: not absolute and not leaving it.
fn check_path(p: &str) -> ApiResult<()> {
    let path = Path::new(p);
    if p.is_empty() || path.is_absolute() || path.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
        return Err(ApiError::bad(format!("not a path in the repository: {p}")));
    }
    Ok(())
}

/// A commit given by its hash (so never taken for an option or a path).
fn check_rev(rev: &str) -> ApiResult<()> {
    if !(4..=64).contains(&rev.len()) || !rev.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ApiError::bad(format!("not a commit hash: {rev}")));
    }
    Ok(())
}

#[derive(Default, Debug, PartialEq)]
struct Status {
    head: Option<String>,
    branch: Option<String>,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    files: Vec<Value>,
    truncated: bool,
}

/// `git status --porcelain=v2 -z --branch`. Each file has its index (`x`) and working tree (`y`)
/// state as `git status --short` shows them: `M`, `A`, `D`, `R`, `C`, `T`, a space for unchanged,
/// `??` for untracked, and the two sides of a conflict (`UU`, `AA`, …).
fn parse_status(out: &str) -> Status {
    let mut st = Status::default();
    let mut it = out.split('\0');
    let side = |c: char| if c == '.' { ' ' } else { c };
    while let Some(rec) = it.next() {
        if let Some(h) = rec.strip_prefix("# ") {
            let (k, v) = h.split_once(' ').unwrap_or((h, ""));
            match k {
                "branch.oid" if v != "(initial)" => st.head = Some(v.to_string()),
                "branch.head" if v != "(detached)" => st.branch = Some(v.to_string()),
                "branch.upstream" => st.upstream = Some(v.to_string()),
                "branch.ab" => {
                    for n in v.split(' ') {
                        if let Some(a) = n.strip_prefix('+') {
                            st.ahead = a.parse().unwrap_or(0);
                        } else if let Some(b) = n.strip_prefix('-') {
                            st.behind = b.parse().unwrap_or(0);
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        // Ordinary (1), renamed or copied (2, followed by the path it came from), unmerged (u), untracked (?).
        let (xy, path, orig) = match rec.as_bytes().first() {
            Some(b'1') => match rec.splitn(9, ' ').collect::<Vec<_>>()[..] {
                [_, xy, .., path] => (xy, path, None),
                _ => continue,
            },
            Some(b'2') => match rec.splitn(10, ' ').collect::<Vec<_>>()[..] {
                [_, xy, .., path] => (xy, path, it.next()),
                _ => continue,
            },
            Some(b'u') => match rec.splitn(11, ' ').collect::<Vec<_>>()[..] {
                [_, xy, .., path] => (xy, path, None),
                _ => continue,
            },
            Some(b'?') => ("??", &rec[2..], None),
            _ => continue,
        };
        if st.files.len() >= MAX_FILES {
            st.truncated = true;
            continue;
        }
        let mut c = xy.chars();
        let (x, y) = (side(c.next().unwrap_or(' ')), side(c.next().unwrap_or(' ')));
        st.files.push(json!({"path": path, "orig_path": orig, "x": x.to_string(), "y": y.to_string()}));
    }
    st
}

fn parse_log(out: &str, on_branch: bool, unpushed: &HashSet<&str>) -> Vec<Value> {
    out.lines()
        .filter_map(|l| {
            let [sha, author, time, subject] = l.splitn(4, '\x1f').collect::<Vec<_>>()[..] else { return None };
            let time: i64 = time.parse().unwrap_or(0);
            Some(json!({"sha": sha, "author": author, "time": time, "subject": subject, "on_branch": on_branch, "unpushed": unpushed.contains(sha)}))
        })
        .collect()
}

const LOG_FORMAT: &str = "--format=%H%x1f%an%x1f%at%x1f%s";

/// The commits on the branch since `merge_base`, then a few from before it; without one, the latest.
async fn commits(dir: &Path, merge_base: Option<&str>, upstream: bool) -> Result<Vec<Value>> {
    let max = MAX_COMMITS.to_string();
    let unpushed = if upstream { run(dir, &["rev-list", "-n", &max, "@{upstream}..HEAD"], None).await?.stdout } else { String::new() };
    let unpushed: HashSet<&str> = unpushed.lines().collect();
    let log = |range: String, n: usize| async move {
        let n = n.to_string();
        let o = run(dir, &["log", "--no-show-signature", LOG_FORMAT, "-n", &n, &range, "--"], None).await?;
        anyhow::Ok(if o.ok { o.stdout } else { String::new() })
    };
    Ok(match merge_base {
        Some(mb) => {
            let mut all = parse_log(&log(format!("{mb}..HEAD"), MAX_COMMITS).await?, true, &unpushed);
            all.extend(parse_log(&log(mb.to_string(), BASE_COMMITS).await?, false, &unpushed));
            all
        }
        None => parse_log(&log("HEAD".into(), MAX_COMMITS).await?, false, &unpushed),
    })
}

async fn stashes(dir: &Path) -> Result<Vec<Value>> {
    let out = run(dir, &["stash", "list", "--no-show-signature", "--format=%H%x1f%ct%x1f%gs"], None).await?.stdout;
    Ok(out
        .lines()
        .enumerate()
        .filter_map(|(index, l)| {
            let [sha, time, subject] = l.splitn(3, '\x1f').collect::<Vec<_>>()[..] else { return None };
            Some(json!({"index": index, "sha": sha, "time": time.parse::<i64>().unwrap_or(0), "subject": subject}))
        })
        .collect())
}

/// What the repository is in the middle of, if anything.
async fn repo_state(dir: &Path) -> Option<&'static str> {
    let o = run(dir, &["rev-parse", "--absolute-git-dir"], None).await.ok().filter(|o| o.ok)?;
    let git_dir = PathBuf::from(o.stdout.trim());
    [("rebase-merge", "rebasing"), ("rebase-apply", "rebasing"), ("MERGE_HEAD", "merging"), ("CHERRY_PICK_HEAD", "cherry-picking"), ("REVERT_HEAD", "reverting")]
        .into_iter()
        .find(|(f, _)| git_dir.join(f).exists())
        .map(|(_, state)| state)
}

/// `GET /tasks/{id}/git`: the files with changes, the branch, its commits and the stashes.
pub async fn status(State(s): State<Shared>, UrlPath(id): UrlPath<String>) -> ApiResult<Json<Value>> {
    let Some(Repo { top, dir, task, project }) = repo(&s, &id).await? else {
        return Ok(Json(json!({"available": false, "reason": "not a git repository"})));
    };
    let out = run_ok(&top, &["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"], None).await?;
    let st = parse_status(&out);
    let (base_branch, merge_base) = worktree::changes_base(&dir, &task, &project).await;
    let commits = if st.head.is_some() { commits(&top, merge_base.as_deref(), st.upstream.is_some()).await? } else { vec![] };
    Ok(Json(json!({
        "available": true,
        "dir": path_str(&top),
        "head": st.head,
        "branch": st.branch,
        "upstream": st.upstream,
        "ahead": st.ahead,
        "behind": st.behind,
        "base": base_branch,
        "merge_base": merge_base,
        "state": repo_state(&top).await,
        "files": st.files,
        "truncated": st.truncated,
        "commits": commits,
        "stashes": stashes(&top).await?,
    })))
}

#[derive(Deserialize)]
pub struct DiffQuery {
    path: String,
    /// The index against HEAD, rather than the working tree against the index.
    #[serde(default)]
    staged: bool,
    /// An untracked file, as if it were added.
    #[serde(default)]
    untracked: bool,
}

const DIFF_ARGS: [&str; 4] = ["--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"];

/// `GET /tasks/{id}/git/diff?path=&staged=&untracked=`: a file's (or folder's) unstaged or staged
/// changes, without rename detection, for the UI to make patches of chosen lines from. A diff that
/// isn't UTF-8 (a file in another encoding) comes as a `preview` with `not_utf8` and no `patch`: a
/// patch made from it would have U+FFFD where its other bytes were, and `git apply` would write those
/// into the file wherever they're in added lines, so such a file is only staged or discarded whole.
pub async fn diff(State(s): State<Shared>, UrlPath(id): UrlPath<String>, Query(q): Query<DiffQuery>) -> ApiResult<Json<Value>> {
    check_path(&q.path)?;
    let top = top(&s, &id).await?;
    let mut args = vec!["--literal-pathspecs", "diff"];
    args.extend(DIFF_ARGS);
    let o = if q.untracked {
        args.extend(["--no-index", "--", "/dev/null", &q.path]);
        run(&top, &args, None).await?
    } else {
        args.push("--no-renames");
        if q.staged {
            args.push("--cached");
        }
        args.extend(["--", &q.path]);
        run(&top, &args, None).await?
    };
    // `--no-index` exits 1 when there's a difference.
    if !o.ok && !(q.untracked && !o.stdout.is_empty()) {
        return Err(failed(&o));
    }
    if o.stdout.len() > MAX_DIFF {
        return Ok(Json(json!({"patch": "", "too_large": true})));
    }
    if !o.utf8 {
        return Ok(Json(json!({"patch": "", "not_utf8": true, "preview": o.stdout})));
    }
    Ok(Json(json!({"patch": o.stdout})))
}

#[derive(Deserialize)]
pub struct ShowQuery {
    rev: String,
    /// A stash, with its untracked files.
    #[serde(default)]
    stash: bool,
}

/// `GET /tasks/{id}/git/show?rev=&stash=`: a commit's message and changes (a merge's against its
/// first parent), or a stash's.
pub async fn show(State(s): State<Shared>, UrlPath(id): UrlPath<String>, Query(q): Query<ShowQuery>) -> ApiResult<Json<Value>> {
    check_rev(&q.rev)?;
    let top = top(&s, &id).await?;
    if q.stash {
        let mut args = vec!["stash", "show", "-p", "--include-untracked"];
        args.extend(DIFF_ARGS);
        args.push(&q.rev);
        let mut o = run(&top, &args, None).await?;
        // `--include-untracked` is git 2.32's.
        if !o.ok {
            args.retain(|a| *a != "--include-untracked");
            o = run(&top, &args, None).await?;
        }
        if !o.ok {
            return Err(ApiError::conflict(o.stderr.trim().to_string()));
        }
        return Ok(Json(json!({"patch": truncate(&o.stdout, MAX_DIFF)})));
    }
    let meta = run_ok(&top, &["show", "-s", "--no-show-signature", "--format=%H%x1f%an%x1f%ae%x1f%at%x1f%B", &q.rev, "--"], None).await?;
    let [sha, author, email, time, message] = meta.splitn(5, '\x1f').collect::<Vec<_>>()[..] else {
        return Err(ApiError::conflict(format!("can't read commit {}", q.rev)));
    };
    let mut args = vec!["show", "--format=", "--no-show-signature", "-M", "-m", "--first-parent"];
    args.extend(DIFF_ARGS);
    args.extend([q.rev.as_str(), "--"]);
    let patch = run_ok(&top, &args, None).await?;
    Ok(Json(json!({
        "sha": sha,
        "author": author,
        "email": email,
        "time": time.parse::<i64>().unwrap_or(0),
        "message": message.trim_end(),
        "patch": truncate(&patch, MAX_DIFF),
    })))
}

#[derive(Deserialize)]
pub struct Paths {
    /// None for every file.
    #[serde(default)]
    paths: Vec<String>,
}

/// A git command on `paths`, taken literally (not for commands that run others, as `stash`'s
/// `git clean -- :/` would be taken literally too).
fn with_paths<'a>(args: Vec<&'a str>, paths: &'a [String]) -> ApiResult<Vec<&'a str>> {
    for p in paths {
        check_path(p)?;
    }
    let mut args = [vec!["--literal-pathspecs"], args].concat();
    args.push("--");
    args.extend(paths.iter().map(String::as_str));
    Ok(args)
}

/// `POST /tasks/{id}/git/stage {paths}`: stages the files as they are (removed ones too), or everything.
pub async fn stage(State(s): State<Shared>, UrlPath(id): UrlPath<String>, Json(b): Json<Paths>) -> ApiResult<Json<Value>> {
    let top = top(&s, &id).await?;
    run_ok(&top, &with_paths(vec!["add", "-A"], &b.paths)?, None).await?;
    Ok(Json(json!({"ok": true})))
}

async fn has_head(dir: &Path) -> Result<bool> {
    Ok(run(dir, &["rev-parse", "-q", "--verify", "HEAD^{commit}"], None).await?.ok)
}

/// `POST /tasks/{id}/git/unstage {paths}`: puts the files (or everything) in the index back as they are in HEAD.
pub async fn unstage(State(s): State<Shared>, UrlPath(id): UrlPath<String>, Json(b): Json<Paths>) -> ApiResult<Json<Value>> {
    let top = top(&s, &id).await?;
    if has_head(&top).await? {
        run_ok(&top, &with_paths(vec!["reset", "-q", "HEAD"], &b.paths)?, None).await?;
    } else {
        // Before the first commit, there's nothing to go back to: they're taken out of the index.
        let all = [".".to_string()];
        run_ok(&top, &with_paths(vec!["rm", "-r", "-q", "--cached", "--ignore-unmatch"], if b.paths.is_empty() { &all } else { &b.paths })?, None).await?;
    }
    Ok(Json(json!({"ok": true})))
}

#[derive(Deserialize)]
pub struct Discard {
    paths: Vec<String>,
    /// Staged changes too, back to HEAD; otherwise just what isn't staged, back to the index.
    #[serde(default)]
    staged: bool,
}

/// Which of `paths` are in `out`, a NUL-separated list of paths.
fn listed<'a>(out: &str, paths: &'a [String]) -> Vec<&'a str> {
    let have: HashSet<&str> = out.split('\0').collect();
    paths.iter().map(String::as_str).filter(|p| have.contains(p)).collect()
}

/// `POST /tasks/{id}/git/discard {paths, staged}`: throws away the files' changes, deleting
/// untracked ones (and, with `staged`, ones that are only in the index).
pub async fn discard(State(s): State<Shared>, UrlPath(id): UrlPath<String>, Json(b): Json<Discard>) -> ApiResult<Json<Value>> {
    if b.paths.is_empty() {
        return Err(ApiError::bad("no files to discard"));
    }
    let top = top(&s, &id).await?;
    let in_index = run_ok(&top, &with_paths(vec!["ls-files", "-z"], &b.paths)?, None).await?;
    let in_index = listed(&in_index, &b.paths);
    let in_head = if b.staged && has_head(&top).await? {
        let out = run_ok(&top, &with_paths(vec!["ls-tree", "-r", "-z", "--name-only", "HEAD"], &b.paths)?, None).await?;
        listed(&out, &b.paths)
    } else {
        vec![]
    };
    let untracked: Vec<String> = b.paths.iter().filter(|p| !in_index.contains(&p.as_str()) && !in_head.contains(&p.as_str())).cloned().collect();
    let owned = |v: &[&str]| v.iter().map(|p| p.to_string()).collect::<Vec<_>>();
    if b.staged {
        let added: Vec<String> = in_index.iter().filter(|p| !in_head.contains(p)).map(|p| p.to_string()).collect();
        if !in_head.is_empty() {
            run_ok(&top, &with_paths(vec!["restore", "--source=HEAD", "--staged", "--worktree"], &owned(&in_head))?, None).await?;
        }
        if !added.is_empty() {
            run_ok(&top, &with_paths(vec!["rm", "-q", "-f"], &added)?, None).await?;
        }
    } else if !in_index.is_empty() {
        run_ok(&top, &with_paths(vec!["restore", "--worktree"], &owned(&in_index))?, None).await?;
    }
    if !untracked.is_empty() {
        run_ok(&top, &with_paths(vec!["clean", "-f", "-q"], &untracked)?, None).await?;
    }
    Ok(Json(json!({"ok": true})))
}

#[derive(Deserialize)]
pub struct Apply {
    patch: String,
    /// To the index (staging or unstaging lines) rather than the working tree (discarding them).
    #[serde(default)]
    cached: bool,
    #[serde(default)]
    reverse: bool,
}

/// `POST /tasks/{id}/git/apply {patch, cached, reverse}`: applies a patch of chosen lines.
pub async fn apply(State(s): State<Shared>, UrlPath(id): UrlPath<String>, Json(b): Json<Apply>) -> ApiResult<Json<Value>> {
    let top = top(&s, &id).await?;
    let mut args = vec!["apply", "--whitespace=nowarn"];
    if b.cached {
        args.push("--cached");
    }
    if b.reverse {
        args.push("-R");
    }
    args.push("-");
    run_ok(&top, &args, Some(&b.patch)).await?;
    Ok(Json(json!({"ok": true})))
}

#[derive(Deserialize)]
pub struct Commit {
    #[serde(default)]
    message: String,
    /// Into the last commit, with its message unless one is given.
    #[serde(default)]
    amend: bool,
    /// Just the last commit's message, leaving out what's staged.
    #[serde(default)]
    reword: bool,
}

/// `POST /tasks/{id}/git/commit {message, amend, reword}`: commits what's staged.
pub async fn commit(State(s): State<Shared>, UrlPath(id): UrlPath<String>, Json(b): Json<Commit>) -> ApiResult<Json<Value>> {
    let top = top(&s, &id).await?;
    let message = b.message.trim();
    if message.is_empty() && !(b.amend && !b.reword) {
        return Err(ApiError::bad("the commit needs a message"));
    }
    let mut args = vec!["commit", "-q"];
    if b.reword {
        args.extend(["--amend", "--only", "--allow-empty"]);
    } else if b.amend {
        args.push("--amend");
    }
    if message.is_empty() {
        args.push("--no-edit");
    } else {
        args.extend(["-F", "-"]);
    }
    run_ok(&top, &args, (!message.is_empty()).then_some(message)).await?;
    let head = run_ok(&top, &["rev-parse", "HEAD"], None).await?;
    Ok(Json(json!({"ok": true, "head": head.trim()})))
}

#[derive(Deserialize)]
pub struct Stash {
    /// `push`, `apply`, `pop` or `drop`.
    action: String,
    /// For `push`: `all` (untracked files too), `staged`, or `unstaged` (all but what's staged, which stays).
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    message: String,
    /// For the others: which stash, and its commit, so that a list that changed since doesn't pick another.
    index: Option<usize>,
    sha: Option<String>,
}

/// `POST /tasks/{id}/git/stash {action, …}`: stashes changes, or applies, pops or drops a stash.
pub async fn stash(State(s): State<Shared>, UrlPath(id): UrlPath<String>, Json(b): Json<Stash>) -> ApiResult<Json<Value>> {
    let top = top(&s, &id).await?;
    let message = b.message.trim();
    let out = if b.action == "push" {
        let mut args = vec!["stash", "push"];
        let mode: &[&str] = match b.mode.as_deref().unwrap_or("all") {
            "all" => &["--include-untracked"],
            "staged" => &["--staged"],
            "unstaged" => &["--keep-index", "--include-untracked"],
            m => return Err(ApiError::bad(format!("unknown stash mode: {m}"))),
        };
        args.extend(mode);
        if !message.is_empty() {
            args.extend(["-m", message]);
        }
        run_ok(&top, &args, None).await?
    } else {
        if !matches!(b.action.as_str(), "apply" | "pop" | "drop") {
            return Err(ApiError::bad(format!("unknown stash action: {}", b.action)));
        }
        let (Some(index), Some(sha)) = (b.index, b.sha.as_deref()) else { return Err(ApiError::bad("which stash?")) };
        let name = format!("stash@{{{index}}}");
        let at = run(&top, &["rev-parse", "-q", "--verify", &name], None).await?.stdout;
        if at.trim() != sha {
            return Err(ApiError::conflict("the stashes have changed: refresh and try again"));
        }
        run_ok(&top, &["stash", &b.action, "-q", &name], None).await?
    };
    Ok(Json(json!({"ok": true, "output": out.trim()})))
}

#[derive(Deserialize)]
pub struct Reset {
    rev: String,
    /// `soft`, `mixed` or `hard`.
    mode: String,
}

/// `POST /tasks/{id}/git/reset {rev, mode}`: moves the branch to a commit.
pub async fn reset(State(s): State<Shared>, UrlPath(id): UrlPath<String>, Json(b): Json<Reset>) -> ApiResult<Json<Value>> {
    check_rev(&b.rev)?;
    if !matches!(b.mode.as_str(), "soft" | "mixed" | "hard") {
        return Err(ApiError::bad(format!("unknown reset mode: {}", b.mode)));
    }
    let top = top(&s, &id).await?;
    let mode = format!("--{}", b.mode);
    run_ok(&top, &["reset", "-q", &mode, &format!("{}^{{commit}}", b.rev)], None).await?;
    Ok(Json(json!({"ok": true})))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{CreateProject, CreateTask, create_project_inner, create_task_inner};
    use crate::db;

    fn sh(dir: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).to_string()
    }

    #[test]
    fn reads_the_porcelain_status() {
        let out = "# branch.oid 0123abcd\0# branch.head ia/x-1\0# branch.upstream origin/ia/x-1\0# branch.ab +2 -1\0\
            1 .M N... 100644 100644 100644 aa aa src/a b.rs\0\
            2 R. N... 100644 100644 100644 aa aa R100 new name\0old name\0\
            u UU N... 100644 100644 100644 100644 aa bb cc both\0\
            ? new dir/x\0";
        let st = parse_status(out);
        assert_eq!((st.head.as_deref(), st.branch.as_deref(), st.upstream.as_deref()), (Some("0123abcd"), Some("ia/x-1"), Some("origin/ia/x-1")));
        assert_eq!((st.ahead, st.behind, st.truncated), (2, 1, false));
        let f = |path: &str, orig: Option<&str>, x: &str, y: &str| json!({"path": path, "orig_path": orig, "x": x, "y": y});
        assert_eq!(st.files, [f("src/a b.rs", None, " ", "M"), f("new name", Some("old name"), "R", " "), f("both", None, "U", "U"), f("new dir/x", None, "?", "?")]);
        // Before the first commit, and detached.
        let st = parse_status("# branch.oid (initial)\0# branch.head (detached)\0");
        assert_eq!((st.head, st.branch, st.files.len()), (None, None, 0));
    }

    #[test]
    fn checks_paths_and_hashes() {
        for ok in ["a", "a/b c", "./a", ".hidden/x"] {
            assert!(check_path(ok).is_ok(), "{ok}");
        }
        for bad in ["", "/etc/passwd", "../x", "a/../../x"] {
            assert!(check_path(bad).is_err(), "{bad}");
        }
        assert!(check_rev("0123abcdef").is_ok());
        for bad in ["--hard", "HEAD", "abc", "0123abcz", &"a".repeat(65)] {
            assert!(check_rev(bad).is_err(), "{bad}");
        }
    }

    /// A task with a worktree on a branch with one commit ("branch work"), in a repository whose
    /// master has `f.txt` (20 numbered lines) and `gone.txt`: the task and its worktree.
    async fn task_repo(s: &Shared) -> (String, PathBuf) {
        let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let repo = std::env::temp_dir().join(format!("ia-gv-{}", crate::util::new_id()));
        std::fs::create_dir_all(&repo).unwrap();
        sh(&repo, &["init", "-q", "-b", "master"]);
        sh(&repo, &["config", "user.name", "t"]);
        sh(&repo, &["config", "user.email", "t@t"]);
        std::fs::write(repo.join("f.txt"), (1..=20).map(|i| format!("{i}\n")).collect::<String>()).unwrap();
        std::fs::write(repo.join("gone.txt"), "bye\n").unwrap();
        sh(&repo, &["add", "."]);
        sh(&repo, &["commit", "-qm", "init"]);
        let b = CreateProject { name: "x".into(), repo_path: path_str(&repo), key: Some("X".into()), base_branch: Some("master".into()), use_worktrees: None };
        let p = create_project_inner(s, &profile.id, b).await.unwrap();
        let t = create_task_inner(s, &p.id, CreateTask { title: "Do it".into(), ..Default::default() }).unwrap();
        let t = worktree::setup(s, &t.id).await.unwrap();
        let wt = PathBuf::from(t.worktree_path.clone().unwrap());
        std::fs::write(wt.join("b.txt"), "b\n").unwrap();
        sh(&wt, &["add", "b.txt"]);
        sh(&wt, &["commit", "-qm", "branch work"]);
        (t.id, wt)
    }

    async fn get_status(s: &Shared, id: &str) -> Value {
        status(State(s.clone()), UrlPath(id.to_string())).await.unwrap().0
    }

    async fn get_diff(s: &Shared, id: &str, path: &str, staged: bool, untracked: bool) -> String {
        let q = DiffQuery { path: path.into(), staged, untracked };
        diff(State(s.clone()), UrlPath(id.to_string()), Query(q)).await.unwrap().0["patch"].as_str().unwrap().to_string()
    }

    fn paths(p: &[&str]) -> Json<Paths> {
        Json(Paths { paths: p.iter().map(|p| p.to_string()).collect() })
    }

    #[test]
    fn stages_lines_and_files_and_discards_them() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (id, wt) = task_repo(&s).await;
            let at = |s: &Shared| (State(s.clone()), UrlPath(id.clone()));
            let f = (1..=20).map(|i| if i == 2 { "two\n".into() } else if i == 15 { "fifteen\n".into() } else { format!("{i}\n") }).collect::<String>();
            std::fs::write(wt.join("f.txt"), &f).unwrap();
            std::fs::remove_file(wt.join("gone.txt")).unwrap();
            std::fs::create_dir_all(wt.join("new")).unwrap();
            std::fs::write(wt.join("new/u.txt"), "u1\nu2\n").unwrap();

            let st = get_status(&s, &id).await;
            let files: Vec<_> = st["files"].as_array().unwrap().iter().map(|f| format!("{}{} {}", f["x"].as_str().unwrap(), f["y"].as_str().unwrap(), f["path"].as_str().unwrap())).collect();
            assert_eq!(files, [" M f.txt", " D gone.txt", "?? new/u.txt"]);
            assert_eq!((st["base"].as_str(), st["branch"].as_str()), (Some("master"), Some(sh(&wt, &["branch", "--show-current"]).trim())));
            let commits: Vec<_> = st["commits"].as_array().unwrap().iter().map(|c| (c["subject"].as_str().unwrap(), c["on_branch"].as_bool().unwrap())).collect();
            assert_eq!(commits, [("branch work", true), ("init", false)]);

            // Two hunks: staging a patch of the first stages just that.
            let patch = get_diff(&s, &id, "f.txt", false, false).await;
            assert_eq!(patch.matches("\n@@ ").count(), 2, "{patch}");
            let first = &patch[..patch.rfind("\n@@ ").unwrap() + 1];
            let _ = apply(at(&s).0, at(&s).1, Json(Apply { patch: first.into(), cached: true, reverse: false })).await.unwrap();
            let staged = get_diff(&s, &id, "f.txt", true, false).await;
            assert!(staged.contains("+two\n") && !staged.contains("fifteen"), "{staged}");
            // …and its reverse unstages it again.
            let _ = apply(at(&s).0, at(&s).1, Json(Apply { patch: staged, cached: true, reverse: true })).await.unwrap();
            assert_eq!(get_diff(&s, &id, "f.txt", true, false).await, "");
            // A patch that no longer fits is refused, with git's reason.
            let err = apply(at(&s).0, at(&s).1, Json(Apply { patch: first.replace("-2\n", "-3\n"), cached: true, reverse: false })).await.unwrap_err();
            assert_eq!(err.0, StatusCode::CONFLICT, "{}", err.1);

            // An untracked file's diff is as if it were added.
            let u = get_diff(&s, &id, "new/u.txt", false, true).await;
            assert!(u.contains("new file mode") && u.contains("+++ b/new/u.txt") && u.contains("+u2\n"), "{u}");
            assert_eq!(diff(at(&s).0, at(&s).1, Query(DiffQuery { path: "../x".into(), staged: false, untracked: true })).await.unwrap_err().0, StatusCode::BAD_REQUEST);

            // Whole files, and everything.
            let _ = stage(at(&s).0, at(&s).1, paths(&["gone.txt"])).await.unwrap();
            assert_eq!(get_status(&s, &id).await["files"][1]["x"], "D");
            let _ = stage(at(&s).0, at(&s).1, paths(&[])).await.unwrap();
            let xy: Vec<_> = get_status(&s, &id).await["files"].as_array().unwrap().iter().map(|f| format!("{}{}", f["x"].as_str().unwrap(), f["y"].as_str().unwrap())).collect();
            assert_eq!(xy, ["M ", "D ", "A "]);
            let _ = unstage(at(&s).0, at(&s).1, paths(&["f.txt"])).await.unwrap();
            assert_eq!(get_status(&s, &id).await["files"][0]["x"], " ");
            let _ = unstage(at(&s).0, at(&s).1, paths(&[])).await.unwrap();
            assert_eq!(get_diff(&s, &id, ".", true, false).await, "");

            // Discarding what isn't staged goes back to the index; with `staged`, to HEAD.
            sh(&wt, &["add", "new/u.txt"]);
            std::fs::write(wt.join("new/u.txt"), "changed\n").unwrap();
            let _ = discard(at(&s).0, at(&s).1, Json(Discard { paths: vec!["gone.txt".into(), "new/u.txt".into()], staged: false })).await.unwrap();
            assert_eq!(std::fs::read_to_string(wt.join("gone.txt")).unwrap(), "bye\n");
            assert_eq!(std::fs::read_to_string(wt.join("new/u.txt")).unwrap(), "u1\nu2\n");
            sh(&wt, &["add", "f.txt"]);
            std::fs::write(wt.join("untracked.txt"), "x\n").unwrap();
            let _ = discard(at(&s).0, at(&s).1, Json(Discard { paths: vec!["f.txt".into(), "new/u.txt".into(), "untracked.txt".into()], staged: true })).await.unwrap();
            assert_eq!(get_status(&s, &id).await["files"], json!([]));
            assert!(!wt.join("new/u.txt").exists() && !wt.join("untracked.txt").exists());
            assert_eq!(std::fs::read_to_string(wt.join("f.txt")).unwrap(), (1..=20).map(|i| format!("{i}\n")).collect::<String>());
        })
    }

    #[test]
    fn commits_stashes_and_resets() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (id, wt) = task_repo(&s).await;
            let at = |s: &Shared| (State(s.clone()), UrlPath(id.clone()));
            let subjects = async |s: &Shared| -> Vec<String> {
                get_status(s, &id).await["commits"].as_array().unwrap().iter().map(|c| c["subject"].as_str().unwrap().to_string()).collect()
            };
            let commit_with = async |s: &Shared, message: &str, amend: bool, reword: bool| {
                commit(at(s).0, at(s).1, Json(Commit { message: message.into(), amend, reword })).await
            };

            assert_eq!(commit_with(&s, " ", false, false).await.unwrap_err().0, StatusCode::BAD_REQUEST);
            std::fs::write(wt.join("c.txt"), "c\n").unwrap();
            let _ = stage(at(&s).0, at(&s).1, paths(&[])).await.unwrap();
            let _ = commit_with(&s, "add c\n\nwith a body", false, false).await.unwrap();
            assert_eq!(subjects(&s).await, ["add c", "branch work", "init"]);
            // Amending keeps the message; rewording leaves what's staged.
            std::fs::write(wt.join("c.txt"), "cc\n").unwrap();
            let _ = stage(at(&s).0, at(&s).1, paths(&[])).await.unwrap();
            let _ = commit_with(&s, "", true, false).await.unwrap();
            assert_eq!(subjects(&s).await, ["add c", "branch work", "init"]);
            assert_eq!(sh(&wt, &["show", "HEAD:c.txt"]), "cc\n");
            std::fs::write(wt.join("c.txt"), "ccc\n").unwrap();
            let _ = stage(at(&s).0, at(&s).1, paths(&[])).await.unwrap();
            let _ = commit_with(&s, "reworded", true, true).await.unwrap();
            assert_eq!(subjects(&s).await, ["reworded", "branch work", "init"]);
            assert_eq!((sh(&wt, &["show", "HEAD:c.txt"]).as_str(), sh(&wt, &["show", ":c.txt"]).as_str()), ("cc\n", "ccc\n"));

            // A commit's message and changes.
            let head = get_status(&s, &id).await["commits"][0]["sha"].as_str().unwrap().to_string();
            let shown = show(at(&s).0, at(&s).1, Query(ShowQuery { rev: head.clone(), stash: false })).await.unwrap().0;
            assert_eq!((shown["message"].as_str(), shown["sha"].as_str()), (Some("reworded"), Some(head.as_str())));
            assert!(shown["patch"].as_str().unwrap().contains("+cc\n"));

            // Stash everything (untracked files too), then pop it, given the stash's commit.
            std::fs::write(wt.join("u.txt"), "u\n").unwrap();
            let push = Stash { action: "push".into(), mode: None, message: "wip".into(), index: None, sha: None };
            let _ = stash(at(&s).0, at(&s).1, Json(push)).await.unwrap();
            let st = get_status(&s, &id).await;
            assert_eq!(st["files"], json!([]));
            let sha = st["stashes"][0]["sha"].as_str().unwrap().to_string();
            assert!(st["stashes"][0]["subject"].as_str().unwrap().ends_with(": wip"));
            let stashed = show(at(&s).0, at(&s).1, Query(ShowQuery { rev: sha.clone(), stash: true })).await.unwrap().0;
            assert!(stashed["patch"].as_str().unwrap().contains("+u\n"), "{stashed}");
            let pop = |sha: &str| Stash { action: "pop".into(), mode: None, message: String::new(), index: Some(0), sha: Some(sha.into()) };
            assert_eq!(stash(at(&s).0, at(&s).1, Json(pop(&head))).await.unwrap_err().0, StatusCode::CONFLICT);
            let _ = stash(at(&s).0, at(&s).1, Json(pop(&sha))).await.unwrap();
            let st = get_status(&s, &id).await;
            assert_eq!((st["files"].as_array().unwrap().len(), st["stashes"].as_array().unwrap().len()), (2, 0));

            // A soft reset keeps the undone commit's changes staged.
            let work = get_status(&s, &id).await["commits"][1]["sha"].as_str().unwrap().to_string();
            assert_eq!(reset(at(&s).0, at(&s).1, Json(Reset { rev: work.clone(), mode: "sideways".into() })).await.unwrap_err().0, StatusCode::BAD_REQUEST);
            let _ = reset(at(&s).0, at(&s).1, Json(Reset { rev: work, mode: "soft".into() })).await.unwrap();
            assert_eq!(subjects(&s).await, ["branch work", "init"]);
            assert_eq!(sh(&wt, &["diff", "--cached", "--name-only"]), "c.txt\n");
        })
    }

    #[test]
    fn unstages_before_the_first_commit() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
            let repo = std::env::temp_dir().join(format!("ia-gv-{}", crate::util::new_id()));
            std::fs::create_dir_all(&repo).unwrap();
            sh(&repo, &["init", "-q", "-b", "master"]);
            let b = CreateProject { name: "x".into(), repo_path: path_str(&repo), key: Some("X".into()), base_branch: None, use_worktrees: Some(false) };
            let p = create_project_inner(&s, &profile.id, b).await.unwrap();
            let id = create_task_inner(&s, &p.id, CreateTask { title: "Do it".into(), ..Default::default() }).unwrap().id;
            let at = |s: &Shared| (State(s.clone()), UrlPath(id.clone()));
            std::fs::write(repo.join("a"), "a\n").unwrap();
            std::fs::write(repo.join("b"), "b\n").unwrap();
            let _ = stage(at(&s).0, at(&s).1, paths(&[])).await.unwrap();
            let st = get_status(&s, &id).await;
            assert_eq!((st["head"].clone(), st["commits"].clone(), st["files"][0]["x"].clone()), (Value::Null, json!([]), json!("A")));
            let _ = unstage(at(&s).0, at(&s).1, paths(&["a"])).await.unwrap();
            assert_eq!(sh(&repo, &["diff", "--cached", "--name-only"]), "b\n");
            let _ = unstage(at(&s).0, at(&s).1, paths(&[])).await.unwrap();
            assert_eq!(sh(&repo, &["diff", "--cached", "--name-only"]), "");
        })
    }

    // A patch made from a lossily decoded diff wrote U+FFFD into the index in place of a Latin-1 byte.
    #[test]
    fn files_not_in_utf8_are_staged_whole_not_by_line() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (id, wt) = task_repo(&s).await;
            let at = |s: &Shared| (State(s.clone()), UrlPath(id.clone()));
            let raw = |rev: &str| std::process::Command::new("git").arg("-C").arg(&wt).args(["show", rev]).output().unwrap().stdout;
            let get = async |s: &Shared, path: &str, staged: bool, untracked: bool| {
                diff(at(s).0, at(s).1, Query(DiffQuery { path: path.into(), staged, untracked })).await.unwrap().0
            };
            // A Latin-1 line added to f.txt, and an untracked Latin-1 file.
            let mut f = std::fs::read(wt.join("f.txt")).unwrap();
            f.extend_from_slice(b"caf\xe9\n");
            std::fs::write(wt.join("f.txt"), &f).unwrap();
            std::fs::write(wt.join("latin.txt"), b"na\xefve\n").unwrap();
            for (path, untracked, line) in [("f.txt", false, "+caf\u{fffd}\n"), ("latin.txt", true, "+na\u{fffd}ve\n")] {
                let d = get(&s, path, false, untracked).await;
                assert_eq!((d["patch"].as_str(), d["not_utf8"].as_bool()), (Some(""), Some(true)), "{path}: {d}");
                assert!(d["preview"].as_str().unwrap().contains(line), "{path}: {d}");
            }
            // Staged whole, their bytes are kept; and the staged diff isn't for staging by line either.
            let _ = stage(at(&s).0, at(&s).1, paths(&["f.txt", "latin.txt"])).await.unwrap();
            assert_eq!((raw(":f.txt"), raw(":latin.txt")), (f, b"na\xefve\n".to_vec()));
            assert_eq!(get(&s, "f.txt", true, false).await["not_utf8"], true);
            // UTF-8 text that isn't ASCII is staged by line as before.
            std::fs::write(wt.join("utf8.txt"), "café\n").unwrap();
            let d = get(&s, "utf8.txt", false, true).await;
            assert!(d["patch"].as_str().unwrap().contains("+café\n") && d.get("not_utf8").is_none(), "{d}");
        })
    }
}
