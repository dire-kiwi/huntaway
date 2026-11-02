//! The Changes tab, a lazygit-style view of a task's repository (API 66): the working tree's files,
//! the commits on the task's branch and the stashes, the diff of a file, commit or stash, and what
//! can be done from there: staging and unstaging whole files or chosen lines (a patch the UI makes
//! from a file's diff, applied to the index), discarding, committing, amending, stashing and
//! resetting. Everything runs at the top of the folder `worktree::diff` shows: the task's worktree
//! once it's ready, else its project's repository.
//!
//! A project's folder may be only part of a repository (a subfolder of a monorepo, or of a home
//! folder kept as a dotfiles repository). Then the view is of that folder's files and the commits
//! that touch them, staging and discarding is of its files only, and what would act on the whole
//! repository (committing what's staged outside it, amending, stashing and resetting) is refused.

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
use crate::git::worktree;
use crate::state::{ApiError, ApiResult, Shared};
use crate::util::{path_str, truncate};

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
    /// Where `dir` is from `top` (`web/`, with its slash) when it isn't the top: the view is of it only.
    folder: Option<String>,
    task: Task,
    project: Project,
}

impl Repo {
    /// Refuses what would act on the whole repository when the project's folder is only part of it.
    fn whole_repo(&self, what: &str) -> ApiResult<()> {
        match &self.folder {
            Some(f) => Err(ApiError::conflict(format!(
                "{what} would act on the whole repository at {}, and the project's folder is only its {f} folder: do it in a terminal there",
                self.top.display()
            ))),
            None => Ok(()),
        }
    }

    /// Checks paths from the top of the repository: in it, and in the project's folder.
    fn check_paths(&self, paths: &[String]) -> ApiResult<()> {
        for p in paths {
            check_path(p)?;
            if let Some(f) = &self.folder
                && !(p.starts_with(f.as_str()) || p == f.trim_end_matches('/'))
            {
                return Err(ApiError::bad(format!("{p} isn't in the project's folder ({f})")));
            }
        }
        Ok(())
    }

    /// The paths, or (none given) every file in the view.
    fn or_all(&self, paths: &[String]) -> Vec<String> {
        match (&self.folder, paths.is_empty()) {
            (Some(f), true) => vec![f.clone()],
            _ => paths.to_vec(),
        }
    }
}

/// The task's working tree, if it's in one.
async fn repo(s: &Shared, task_id: &str) -> ApiResult<Option<Repo>> {
    let (dir, task, project) = worktree::changes_dir(s, task_id).map_err(|e| ApiError(StatusCode::NOT_FOUND, format!("{e:#}")))?;
    let o = run(&dir, &["rev-parse", "--show-toplevel", "--show-prefix"], None).await?;
    if !o.ok {
        return Ok(None);
    }
    let mut lines = o.stdout.lines();
    let top = PathBuf::from(lines.next().unwrap_or_default());
    let folder = lines.next().filter(|p| !p.is_empty()).map(str::to_string);
    Ok(Some(Repo { top, dir, folder, task, project }))
}

async fn top(s: &Shared, task_id: &str) -> ApiResult<Repo> {
    repo(s, task_id).await?.ok_or_else(|| ApiError::bad("not a git repository"))
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
async fn commits(dir: &Path, merge_base: Option<&str>, upstream: bool, folder: Option<&str>) -> Result<Vec<Value>> {
    let max = MAX_COMMITS.to_string();
    let unpushed = if upstream { run(dir, &["rev-list", "-n", &max, "@{upstream}..HEAD"], None).await?.stdout } else { String::new() };
    let unpushed: HashSet<&str> = unpushed.lines().collect();
    let log = |range: String, n: usize| async move {
        let n = n.to_string();
        let mut args = vec!["--literal-pathspecs", "log", "--no-show-signature", LOG_FORMAT, "-n", &n, &range, "--"];
        args.extend(folder);
        let o = run(dir, &args, None).await?;
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
    let Some(Repo { top, dir, folder, task, project }) = repo(&s, &id).await? else {
        return Ok(Json(json!({"available": false, "reason": "not a git repository"})));
    };
    let mut args = vec!["--literal-pathspecs", "status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--"];
    args.extend(folder.as_deref());
    let out = run_ok(&top, &args, None).await?;
    let st = parse_status(&out);
    let (base_branch, merge_base) = worktree::changes_base(&s, &dir, &task, &project).await;
    let commits = if st.head.is_some() { commits(&top, merge_base.as_deref(), st.upstream.is_some(), folder.as_deref()).await? } else { vec![] };
    // The repository's stashes aren't the folder's, and can't be used from here.
    let stashes = if folder.is_some() { vec![] } else { stashes(&top).await? };
    Ok(Json(json!({
        "available": true,
        "dir": path_str(&top),
        "folder": folder,
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
        "stashes": stashes,
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
    let repo = top(&s, &id).await?;
    repo.check_paths(std::slice::from_ref(&q.path))?;
    let top = repo.top;
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
    let top = top(&s, &id).await?.top;
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
    let repo = top(&s, &id).await?;
    repo.check_paths(&b.paths)?;
    run_ok(&repo.top, &with_paths(vec!["add", "-A"], &repo.or_all(&b.paths))?, None).await?;
    Ok(Json(json!({"ok": true})))
}

async fn has_head(dir: &Path) -> Result<bool> {
    Ok(run(dir, &["rev-parse", "-q", "--verify", "HEAD^{commit}"], None).await?.ok)
}

/// `POST /tasks/{id}/git/unstage {paths}`: puts the files (or everything) in the index back as they are in HEAD.
pub async fn unstage(State(s): State<Shared>, UrlPath(id): UrlPath<String>, Json(b): Json<Paths>) -> ApiResult<Json<Value>> {
    let repo = top(&s, &id).await?;
    repo.check_paths(&b.paths)?;
    let (top, paths) = (&repo.top, repo.or_all(&b.paths));
    if has_head(top).await? {
        run_ok(top, &with_paths(vec!["reset", "-q", "HEAD"], &paths)?, None).await?;
    } else {
        // Before the first commit, there's nothing to go back to: they're taken out of the index.
        let all = [".".to_string()];
        run_ok(top, &with_paths(vec!["rm", "-r", "-q", "--cached", "--ignore-unmatch"], if paths.is_empty() { &all } else { &paths })?, None).await?;
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
    let repo = top(&s, &id).await?;
    repo.check_paths(&b.paths)?;
    let top = repo.top;
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
    let repo = top(&s, &id).await?;
    let top = &repo.top;
    if repo.folder.is_some() {
        // The files the patch is of, without applying it.
        let files = run_ok(top, &["apply", "--numstat", "-z", "-"], Some(&b.patch)).await?;
        repo.check_paths(&numstat_paths(&files))?;
    }
    let mut args = vec!["apply", "--whitespace=nowarn"];
    if b.cached {
        args.push("--cached");
    }
    if b.reverse {
        args.push("-R");
    }
    args.push("-");
    run_ok(top, &args, Some(&b.patch)).await?;
    Ok(Json(json!({"ok": true})))
}

/// The paths in `git apply --numstat -z`: `added\tdeleted\tpath`, or for a rename an empty path
/// followed by where it's from and to.
fn numstat_paths(out: &str) -> Vec<String> {
    let mut paths = Vec::new();
    let mut records = out.split('\0');
    while let Some(r) = records.next() {
        match r.splitn(3, '\t').nth(2) {
            Some("") => paths.extend(records.by_ref().take(2).map(str::to_string)),
            Some(p) => paths.push(p.to_string()),
            None => {}
        }
    }
    paths
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
    let repo = top(&s, &id).await?;
    let top = &repo.top;
    if b.amend || b.reword {
        repo.whole_repo("Changing the last commit")?;
    }
    // What's staged outside the project's folder would go in the commit too.
    if let Some(f) = &repo.folder {
        let exclude = format!(":(exclude,top,literal){f}");
        let outside = run_ok(top, &["diff", "--cached", "--name-only", "-z", "--", ":(top)", &exclude], None).await?;
        if let Some(file) = outside.split('\0').find(|p| !p.is_empty()) {
            return Err(ApiError::conflict(format!(
                "{file} is staged too, and isn't in the project's folder ({f}): unstage what's outside it in a terminal at {}, or commit it there",
                top.display()
            )));
        }
    }
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
    run_ok(top, &args, (!message.is_empty()).then_some(message)).await?;
    let head = run_ok(top, &["rev-parse", "HEAD"], None).await?;
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
    let repo = top(&s, &id).await?;
    repo.whole_repo("Stashing")?;
    let top = repo.top;
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
    let repo = top(&s, &id).await?;
    repo.whole_repo("Resetting")?;
    let top = repo.top;
    let mode = format!("--{}", b.mode);
    run_ok(&top, &["reset", "-q", &mode, &format!("{}^{{commit}}", b.rev)], None).await?;
    Ok(Json(json!({"ok": true})))
}

#[cfg(test)]
mod tests;
