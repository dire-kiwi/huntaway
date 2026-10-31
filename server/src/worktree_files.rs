//! The repository's ignored files a project brings into each new task worktree (API 82), before
//! its setup script runs, so the script and the agent can rely on them: `.env` files, local
//! config, credentials, big caches.
//!
//! - `copy_files` (and the repository's `.worktreeinclude`, as Claude Code and Orca read it) are
//!   .gitignore-style patterns (`.env` at any depth, `/.env` only at the top, `config/*.local.json`,
//!   `!` to leave one out). Each untracked file of the repository folder they match is copied when
//!   git ignores it, both there and on the task's branch; a file the worktree already has is never
//!   overwritten.
//! - `link_folders` are folders, relative to the repository, symlinked into the worktree instead
//!   (a model cache, say). Each must be ignored by git with nothing tracked in it. A link isn't a
//!   folder to git, so a `node_modules/` pattern doesn't ignore it: when nothing else does, it's
//!   added to the repository's `info/exclude`, so the link isn't committed, doesn't show as
//!   untracked, and doesn't keep the worktree from being removed. Removing the worktree removes
//!   the link, not what it points to.
//!
//! Nothing is read through a symlink in the repository (one could lead out of it, to its `.git`,
//! or to tracked files under an ignored name), nor from outside it (no `..`, no absolute paths),
//! and nothing is written through a symlink in the worktree. The links made in each worktree are
//! kept in its git folder (`huntaway-links`), so they're pointed at the repository's new place if
//! it moves, whatever the setting says by then.

use std::ffi::OsStr;
use std::io::Write;
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;

use anyhow::{Context, Result, bail};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::db::Project;

/// The repository's own list of files to copy, as other tools read it.
pub const INCLUDE_FILE: &str = ".worktreeinclude";

/// What `bring_in` did, for the task's log.
#[derive(Default, Debug)]
pub struct Report {
    pub copied: Vec<String>,
    pub linked: Vec<String>,
    /// Already in the worktree (checked out, or from an earlier setup), so left as they are.
    pub existing: Vec<String>,
    /// What was asked for but not brought in, and why.
    pub skipped: Vec<String>,
    /// Whether the repository's `.worktreeinclude` was read.
    pub include_file: bool,
}

impl Report {
    /// The event for the task's log (level, text, detail), or None when nothing was asked for.
    pub fn event(&self) -> Option<(&'static str, String, String)> {
        let (c, l, e, s) = (self.copied.len(), self.linked.len(), self.existing.len(), self.skipped.len());
        if c + l + e + s == 0 && !self.include_file {
            return None;
        }
        let mut parts = Vec::new();
        if c > 0 || l == 0 {
            parts.push(format!("Copied {c} file{}", plural(c)));
        }
        if l > 0 {
            parts.push(format!("linked {l} folder{}", plural(l)));
        }
        let mut text = format!("{} from the repository", sentence(&parts.join(" and ")));
        if s > 0 {
            text.push_str(&format!(" ({s} left out)"));
        }
        let mut detail = Vec::new();
        if self.include_file {
            detail.push(format!("Read {INCLUDE_FILE}"));
        }
        detail.extend(self.copied.iter().map(|p| format!("copied {p}")));
        detail.extend(self.linked.iter().map(|p| format!("linked {p}")));
        detail.extend(self.existing.iter().map(|p| format!("already there: {p}")));
        detail.extend(self.skipped.iter().map(|p| format!("left out: {p}")));
        Some((if s > 0 { "warn" } else { "info" }, text, detail.join("\n")))
    }
}

fn plural(n: usize) -> &'static str {
    if n == 1 { "" } else { "s" }
}

fn sentence(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
}

/// The lines of a list that count: trimmed, without blank lines and `#` comments.
pub fn entries(text: &str) -> impl Iterator<Item = &str> {
    text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#'))
}

/// Why a `copy_files` pattern can't be used, if it can't: it mustn't climb out with `..`.
pub fn check_pattern(p: &str) -> Result<(), String> {
    let p = p.strip_prefix('!').unwrap_or(p);
    if p.split('/').any(|c| c == "..") {
        return Err(format!("{p}: patterns are relative to the repository, without .."));
    }
    Ok(())
}

/// A `link_folders` entry as a path relative to the repository, or why it isn't one.
pub fn link_path(p: &str) -> Result<PathBuf, String> {
    let path = Path::new(p.trim_end_matches('/'));
    if path.is_absolute() || p.starts_with('~') {
        return Err(format!("{p}: folders are relative to the repository"));
    }
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::Normal(n) if n != ".git" => out.push(n),
            _ => return Err(format!("{p}: folders are relative to the repository, inside it, without .. or .git")),
        }
    }
    if out.as_os_str().is_empty() {
        return Err(format!("{p}: name a folder inside the repository"));
    }
    Ok(out)
}

/// Checks a `copy_files` or `link_folders` value, as the API stores it.
pub fn check(field: &str, text: &str) -> Result<(), String> {
    let lines: Vec<&str> = entries(text).collect();
    if lines.len() > 200 {
        return Err(format!("{field} can have at most 200 entries"));
    }
    for l in lines {
        if field == "link_folders" { link_path(l).map(|_| ()) } else { check_pattern(l) }.map_err(|e| format!("{field}: {e}"))?;
    }
    Ok(())
}

/// Copy and link `project`'s files into its task worktree `wt` (see the module's comment).
pub async fn bring_in(project: &Project, wt: &Path) -> Result<Report> {
    let mut report = Report::default();
    let top = PathBuf::from(git_text(Path::new(&project.repo_path), &["rev-parse", "--show-toplevel"]).await?.trim());
    let canon_top = top.canonicalize().with_context(|| format!("resolving {}", top.display()))?;
    let mut links = Vec::new();
    for l in entries(&project.link_folders) {
        match link_path(l) {
            Ok(p) => links.push(p),
            Err(e) => report.skipped.push(e),
        }
    }
    let mut patterns: Vec<String> = entries(&project.copy_files).map(str::to_string).collect();
    match include_file(&top) {
        Ok(Some(text)) => {
            report.include_file = true;
            patterns.extend(entries(&text).map(str::to_string));
        }
        Ok(None) => {}
        Err(why) => report.skipped.push(format!("{INCLUDE_FILE}: {why}, not read")),
    }
    patterns.retain(|p| match check_pattern(p) {
        Ok(()) => true,
        Err(e) => {
            report.skipped.push(e);
            false
        }
    });
    if patterns.iter().any(|p| !p.starts_with('!')) {
        let worktrees = Path::new(&project.worktrees_root).canonicalize().ok();
        copy(&mut report, &top, &canon_top, worktrees.as_deref(), wt, &patterns, &links).await?;
    }
    for rel in links {
        let shown = rel.display().to_string();
        match link(&top, &canon_top, wt, &rel).await {
            Ok(Linked::New(to)) => report.linked.push(format!("{shown} -> {}", to.display())),
            Ok(Linked::Existing) => report.existing.push(shown),
            Err(why) => report.skipped.push(format!("{shown}: {why}")),
        }
    }
    Ok(report)
}

/// The repository's `.worktreeinclude`, if it has one: a file of its own, not a symlink (which
/// could lead anywhere, and its lines end up in the task's log).
fn include_file(top: &Path) -> Result<Option<String>, String> {
    let path = top.join(INCLUDE_FILE);
    let meta = match path.symlink_metadata() {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("can't read it ({e})")),
    };
    if meta.is_symlink() {
        return Err("a symbolic link".into());
    }
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if meta.len() > 64 * 1024 {
        return Err("bigger than 64 KiB".into());
    }
    std::fs::read_to_string(&path).map(Some).map_err(|e| format!("can't read it ({e})"))
}

/// Copies the files `patterns` match (see the module's comment), except those under `links`
/// (which are linked instead) and the project's worktrees folder `worktrees`.
async fn copy(report: &mut Report, top: &Path, canon_top: &Path, worktrees: Option<&Path>, wt: &Path, patterns: &[String], links: &[PathBuf]) -> Result<()> {
    let mut args: Vec<&OsStr> = ["ls-files", "-z", "--others", "--ignored"].map(OsStr::new).to_vec();
    for p in patterns {
        args.extend([OsStr::new("-x"), OsStr::new(p)]);
    }
    let out = git_bytes(top, &args, None).await?;
    let found: Vec<PathBuf> = out
        .split(|b| *b == 0)
        // A nested repository (a worktree kept in the repository, say) is listed as a folder.
        .filter(|p| !p.is_empty() && !p.ends_with(b"/"))
        .map(|p| PathBuf::from(OsStr::from_bytes(p)))
        .collect();
    for p in patterns.iter().filter(|p| is_literal(p)) {
        if !found.iter().any(|f| literal_matches(p, f)) {
            let why = if top.join(p.trim_start_matches('/')).exists() { "tracked by git, not copied" } else { "not in the repository" };
            report.skipped.push(format!("{p}: {why}"));
        }
    }
    let mut wanted: Vec<PathBuf> = found
        .into_iter()
        // What's in a folder that's linked comes with it.
        .filter(|f| !links.iter().any(|l| f.starts_with(l) && top.join(l).is_dir()))
        .filter(|f| !worktrees.is_some_and(|w| canon_top.join(f).starts_with(w)))
        .collect();
    // Not into the worktree through a symlink (which git can't say it ignores, either).
    wanted.retain(|f| match not_a_folder(wt, f) {
        Some(why) => {
            report.skipped.push(format!("{}: {why}", f.display()));
            false
        }
        None => true,
    });
    let in_repo = ignored(top, &wanted).await?;
    let in_wt = ignored(wt, &wanted).await?;
    let mut not_ignored = Vec::new();
    let mut todo = Vec::new();
    for f in wanted {
        if !in_repo.contains(&f) {
            not_ignored.push(f.display().to_string());
        } else if !in_wt.contains(&f) {
            report.skipped.push(format!("{}: not ignored by git on the task's branch", f.display()));
        } else {
            todo.push(f);
        }
    }
    if !not_ignored.is_empty() {
        let n = not_ignored.len();
        let more = if n > 10 { format!(" and {} more", n - 10) } else { String::new() };
        not_ignored.truncate(10);
        report.skipped.push(format!("{n} matching file{} git doesn't ignore (only ignored files are copied): {}{more}", plural(n), not_ignored.join(", ")));
    }
    let (top, canon_top, wt) = (top.to_path_buf(), canon_top.to_path_buf(), wt.to_path_buf());
    let done = tokio::task::spawn_blocking(move || todo.into_iter().map(|f| (copy_one(&top, &canon_top, &wt, &f), f)).collect::<Vec<_>>()).await?;
    for (r, f) in done {
        let shown = f.display().to_string();
        match r {
            Ok(true) => report.copied.push(shown),
            Ok(false) => report.existing.push(shown),
            Err(why) => report.skipped.push(format!("{shown}: {why}")),
        }
    }
    Ok(())
}

/// Whether a pattern names a path rather than matching several (no wildcards, not a negation).
fn is_literal(p: &str) -> bool {
    !p.starts_with('!') && !p.contains(['*', '?', '[', '\\'])
}

/// Whether file `f` is (or is in) what literal pattern `p` names, as git would match it: a
/// pattern with a slash before its end is anchored at the top, one without matches at any depth.
fn literal_matches(p: &str, f: &Path) -> bool {
    let name = p.trim_end_matches('/');
    let anchored = name.contains('/');
    let name = Path::new(name.trim_start_matches('/'));
    if anchored {
        return f.starts_with(name);
    }
    (0..f.components().count()).any(|skip| f.components().skip(skip).collect::<PathBuf>().starts_with(name))
}

/// Copies `rel` from the repository at `top` into the worktree `wt`: true if copied, false if the
/// worktree has it already, or why it can't be.
fn copy_one(top: &Path, canon_top: &Path, wt: &Path, rel: &Path) -> Result<bool, String> {
    symlink_in(top, rel)?;
    let src = top.join(rel);
    let meta = src.symlink_metadata().map_err(|e| format!("can't read it ({e})"))?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if !src.canonicalize().is_ok_and(|real| real.starts_with(canon_top)) {
        return Err("not in the repository".into());
    }
    let dest = wt.join(rel);
    if dest.symlink_metadata().is_ok() {
        return Ok(false);
    }
    make_parents(wt, rel)?;
    // Copy-on-write where the filesystem has it (std uses clonefile on macOS, copy_file_range on Linux).
    std::fs::copy(&src, &dest).map_err(|e| format!("copying it failed ({e})"))?;
    Ok(true)
}

/// Refuses `rel` of the repository at `top` if it, or a folder it's in, is a symlink: the git
/// checks that it's ignored and untracked are of its own path, not of where a link leads.
fn symlink_in(top: &Path, rel: &Path) -> Result<(), String> {
    let mut path = top.to_path_buf();
    let n = rel.components().count();
    for (i, c) in rel.components().enumerate() {
        path.push(c);
        match path.symlink_metadata() {
            Ok(m) if m.is_symlink() && i + 1 == n => return Err("a symbolic link".into()),
            Ok(m) if m.is_symlink() => return Err(format!("{} is a symbolic link", path.strip_prefix(top).unwrap_or(&path).display())),
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(format!("can't read it ({e})")),
        }
    }
    Ok(())
}

/// Why `rel` can't go in the worktree `wt`, if it can't: one of the folders it's in there is a
/// symlink, or something else that isn't a folder.
fn not_a_folder(wt: &Path, rel: &Path) -> Option<String> {
    let mut dir = wt.to_path_buf();
    for c in rel.parent()?.components() {
        dir.push(c);
        match dir.symlink_metadata() {
            Ok(m) if m.is_dir() => {}
            Ok(_) => return Some(format!("{} in the worktree isn't a folder", dir.strip_prefix(wt).unwrap_or(&dir).display())),
            Err(_) => return None,
        }
    }
    None
}

/// Creates the folders `rel` is in inside the worktree `wt`, refusing to go through a symlink
/// (or anything else that isn't a folder) on the way.
fn make_parents(wt: &Path, rel: &Path) -> Result<(), String> {
    let mut dir = wt.to_path_buf();
    let Some(parent) = rel.parent() else { return Ok(()) };
    for c in parent.components() {
        dir.push(c);
        match dir.symlink_metadata() {
            Ok(m) if m.is_dir() => {}
            Ok(_) => return Err(format!("{} in the worktree isn't a folder", dir.strip_prefix(wt).unwrap_or(&dir).display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&dir).map_err(|e| format!("creating {} failed ({e})", dir.display()))?;
            }
            Err(e) => return Err(format!("checking {} failed ({e})", dir.display())),
        }
    }
    Ok(())
}

enum Linked {
    /// Linked now, to this.
    New(PathBuf),
    /// The worktree has something there already.
    Existing,
}

/// Links folder `rel` of the repository at `top` into the worktree `wt`, or says why it can't.
async fn link(top: &Path, canon_top: &Path, wt: &Path, rel: &Path) -> Result<Linked, String> {
    symlink_in(top, rel)?;
    let src = top.join(rel);
    match src.symlink_metadata() {
        Ok(m) if m.is_dir() => {}
        Ok(_) => return Err("not a folder".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err("not in the repository".into()),
        Err(e) => return Err(format!("can't read it ({e})")),
    }
    let real = src.canonicalize().map_err(|e| format!("can't read it ({e})"))?;
    if !real.starts_with(canon_top) || real == canon_top {
        return Err("not in the repository".into());
    }
    if wt.canonicalize().is_ok_and(|w| w.starts_with(&real)) {
        return Err("the worktree is inside it".into());
    }
    let literal = literal_spec(rel);
    let tracked = git_bytes(top, &[OsStr::new("ls-files"), OsStr::new("-z"), OsStr::new("--"), &literal], None).await.map_err(|e| format!("{e:#}"))?;
    if !tracked.is_empty() {
        return Err("git tracks files in it".into());
    }
    if !is_ignored(top, rel).await {
        return Err("not ignored by git".into());
    }
    let dest = wt.join(rel);
    if dest.symlink_metadata().is_ok() {
        return Ok(Linked::Existing);
    }
    make_parents(wt, rel)?;
    std::os::unix::fs::symlink(&src, &dest).map_err(|e| format!("linking it failed ({e})"))?;
    if !is_ignored(wt, rel).await {
        let excluded = exclude(wt, rel).await;
        if excluded.is_err() || !is_ignored(wt, rel).await {
            let _ = std::fs::remove_file(&dest);
            let why = excluded.err().map_or("the repository's .gitignore files say not to ignore it".into(), |e| format!("{e:#}"));
            return Err(format!("the link would be an untracked file in the worktree ({why})"));
        }
    }
    if let Err(e) = record(wt, rel).await {
        tracing::warn!("recording the link {} in {}: {e:#}", rel.display(), wt.display());
    }
    Ok(Linked::New(src))
}

/// `rel` as a pathspec that matches only it.
fn literal_spec(rel: &Path) -> std::ffi::OsString {
    let mut s = std::ffi::OsString::from(":(literal)");
    s.push(rel);
    s
}

/// Whether git ignores `rel` in the checkout at `dir`.
async fn is_ignored(dir: &Path, rel: &Path) -> bool {
    let args = [OsStr::new("check-ignore"), OsStr::new("-q"), OsStr::new("--"), rel.as_os_str()];
    git_output(dir, &args, None).await.is_ok_and(|o| o.status.success())
}

/// Which of `files` git ignores in the checkout at `dir` (tracked files aren't).
async fn ignored(dir: &Path, files: &[PathBuf]) -> Result<std::collections::HashSet<PathBuf>> {
    if files.is_empty() {
        return Ok(Default::default());
    }
    let mut input = Vec::new();
    for f in files {
        input.extend_from_slice(f.as_os_str().as_bytes());
        input.push(0);
    }
    let out = git_output(dir, &["check-ignore", "-z", "--stdin"].map(OsStr::new), Some(input)).await?;
    // 1 is none of them.
    if !out.status.success() && out.status.code() != Some(1) {
        bail!("git check-ignore failed: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(out.stdout.split(|b| *b == 0).filter(|p| !p.is_empty()).map(|p| PathBuf::from(OsStr::from_bytes(p))).collect())
}

/// Held while `info/exclude` is read and added to, so links set up at once don't lose each other's lines.
static EXCLUDE: Mutex<()> = Mutex::new(());

const EXCLUDE_HEADER: &str = "# Folders Huntaway links into task worktrees (a project's Folders to link). Git doesn't take a\n\
# symbolic link for a folder, so a `name/` pattern doesn't ignore the link.\n";

/// Adds `/<rel>` to the `info/exclude` of the repository that worktree `wt` is of (shared by all
/// its worktrees), once.
async fn exclude(wt: &Path, rel: &Path) -> Result<()> {
    let file = PathBuf::from(git_text(wt, &["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]).await?.trim());
    let mut line = b"/".to_vec();
    for &b in rel.as_os_str().as_bytes() {
        if matches!(b, b'\\' | b'*' | b'?' | b'[') {
            line.push(b'\\');
        }
        line.push(b);
    }
    if line.ends_with(b" ") {
        line.insert(line.len() - 1, b'\\');
    }
    let _held = EXCLUDE.lock().unwrap();
    let text = match std::fs::read(&file) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(e).with_context(|| format!("reading {}", file.display())),
    };
    if text.split(|b| *b == b'\n').any(|l| l == line.as_slice()) {
        return Ok(());
    }
    let mut add = Vec::new();
    if !text.is_empty() && !text.ends_with(b"\n") {
        add.push(b'\n');
    }
    if !text.windows(EXCLUDE_HEADER.len()).any(|w| w == EXCLUDE_HEADER.as_bytes()) {
        add.extend_from_slice(EXCLUDE_HEADER.as_bytes());
    }
    add.extend_from_slice(&line);
    add.push(b'\n');
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&file).with_context(|| format!("opening {}", file.display()))?;
    f.write_all(&add).with_context(|| format!("adding to {}", file.display()))?;
    Ok(())
}

/// The file in a worktree's git folder that lists the links made in it, one path per line. It
/// goes with the worktree when git removes it.
const RECORD: &str = "huntaway-links";

async fn record_file(wt: &Path) -> Result<PathBuf> {
    Ok(PathBuf::from(git_text(wt, &["rev-parse", "--absolute-git-dir"]).await?.trim()).join(RECORD))
}

/// Adds `rel` to the links recorded for worktree `wt`.
async fn record(wt: &Path, rel: &Path) -> Result<()> {
    let file = record_file(wt).await?;
    let text = std::fs::read(&file).unwrap_or_default();
    let line = rel.as_os_str().as_bytes();
    if text.split(|b| *b == b'\n').any(|l| l == line) {
        return Ok(());
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&file).with_context(|| format!("opening {}", file.display()))?;
    f.write_all(&[line, b"\n"].concat())?;
    Ok(())
}

/// The links recorded for worktree `wt`, as paths inside it.
async fn recorded(wt: &Path) -> Vec<PathBuf> {
    let Ok(file) = record_file(wt).await else { return Vec::new() };
    let text = std::fs::read(&file).unwrap_or_default();
    text.split(|b| *b == b'\n')
        .map(|l| PathBuf::from(OsStr::from_bytes(l)))
        .filter(|p| !p.as_os_str().is_empty() && p.components().all(|c| matches!(c, Component::Normal(n) if n != ".git")))
        .collect()
}

/// Points the folder links in worktree `wt` that lead into the repository's old folder at its
/// new one, after the repository moved and the worktree was repaired (`map` gives a path's new
/// place, see relocate.rs): those recorded for it, and those the project's `link_folders` name.
pub async fn relink(wt: &Path, link_folders: &str, map: impl Fn(&Path) -> Option<PathBuf>) {
    let mut links = recorded(wt).await;
    links.extend(entries(link_folders).filter_map(|l| link_path(l).ok()));
    links.sort();
    links.dedup();
    for rel in links {
        // Not through a symlink in the worktree.
        if not_a_folder(wt, &rel).is_some() {
            continue;
        }
        let dest = wt.join(&rel);
        let Ok(old) = std::fs::read_link(&dest) else { continue };
        let Some(new) = map(&old).filter(|n| *n != old) else { continue };
        let swapped = std::fs::remove_file(&dest).and_then(|_| std::os::unix::fs::symlink(&new, &dest));
        if let Err(e) = swapped {
            tracing::warn!("pointing {} at {}: {e}", dest.display(), new.display());
        }
    }
}

async fn git_output(dir: &Path, args: &[&OsStr], input: Option<Vec<u8>>) -> Result<std::process::Output> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GIT_TERMINAL_PROMPT", "0")
        .kill_on_drop(true)
        .spawn()
        .context("failed to run git")?;
    if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
        // Written alongside reading its output, which it may start before it has read all of it.
        tokio::spawn(async move {
            let _ = stdin.write_all(&input).await;
        });
    }
    child.wait_with_output().await.context("failed to run git")
}

async fn git_bytes(dir: &Path, args: &[&OsStr], input: Option<Vec<u8>>) -> Result<Vec<u8>> {
    let out = git_output(dir, args, input).await?;
    if !out.status.success() {
        let args: Vec<_> = args.iter().map(|a| a.to_string_lossy()).collect();
        bail!("git {} failed: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(out.stdout)
}

async fn git_text(dir: &Path, args: &[&str]) -> Result<String> {
    let out = git_bytes(dir, &args.iter().map(OsStr::new).collect::<Vec<_>>(), None).await?;
    Ok(String::from_utf8_lossy(&out).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{CreateProject, CreateTask, create_project_inner, create_task_inner};
    use crate::db;
    use crate::state::Shared;
    use crate::util::path_str;
    use crate::worktree::{Removal, remove_if_merged, remove_merged, setup, teardown};
    use serde_json::json;

    fn sh(dir: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@t"])
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout).unwrap()
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn read(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    }

    /// A repository with ignored files and folders, a folder outside it, and a project on it.
    struct Fixture {
        root: PathBuf,
        repo: PathBuf,
        outside: PathBuf,
        project_id: String,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    async fn fixture(s: &Shared, copy_files: &str, link_folders: &str) -> Fixture {
        let root = std::env::temp_dir().join(format!("ia-wf-{}", crate::util::new_id()));
        let (repo, outside) = (root.join("repo"), root.join("outside"));
        std::fs::create_dir_all(&repo).unwrap();
        write(&outside.join("passwd"), "outside");
        sh(&repo, &["init", "-q", "-b", "master"]);
        write(&repo.join(".gitignore"), ".env\nnode_modules/\ncache/\nbuild/\n*.local.json\nleak\nout-dir\nlinked-file\n");
        write(&repo.join("README"), "readme");
        write(&repo.join("config/app.local.json"), "tracked");
        write(&repo.join(INCLUDE_FILE), "# from the repository\n/config/*.local.json\n");
        sh(&repo, &["add", "."]);
        sh(&repo, &["add", "-f", "config/app.local.json"]);
        sh(&repo, &["commit", "-qm", "init"]);
        // Ignored, untracked: copied or linked.
        write(&repo.join(".env"), "secret");
        write(&repo.join("sub/.env"), "sub secret");
        write(&repo.join("config/dev.local.json"), "dev");
        write(&repo.join("build/out.txt"), "built");
        write(&repo.join("node_modules/pkg/index.js"), "module");
        write(&repo.join("cache/model.bin"), "weights");
        // The tracked file, changed in the repository folder: the worktree keeps its own.
        write(&repo.join("config/app.local.json"), "changed");
        // Untracked but not ignored: never copied.
        write(&repo.join("notes.txt"), "notes");
        // Ignored symlinks leading out of the repository.
        std::os::unix::fs::symlink(outside.join("passwd"), repo.join("leak")).unwrap();
        std::os::unix::fs::symlink(&outside, repo.join("out-dir")).unwrap();
        let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let b = CreateProject { name: "x".into(), repo_path: path_str(&repo), key: Some("X".into()), base_branch: Some("master".into()), use_worktrees: None };
        let p = create_project_inner(s, &profile.id, b).await.unwrap();
        db::update_project(&s.db(), &p.id, &[("copy_files", json!(copy_files)), ("link_folders", json!(link_folders))]).unwrap();
        Fixture { root, repo, outside, project_id: p.id }
    }

    async fn new_task(s: &Shared, f: &Fixture, title: &str) -> (db::Task, PathBuf) {
        let t = create_task_inner(s, &f.project_id, CreateTask { title: title.into(), ..Default::default() }).unwrap();
        let t = setup(s, &t.id).await.unwrap();
        let wt = PathBuf::from(t.worktree_path.clone().unwrap());
        (t, wt)
    }

    fn events(s: &Shared, task_id: &str) -> Vec<serde_json::Value> {
        db::list_messages(&s.db(), task_id).unwrap().into_iter().filter(|m| m.kind == "event").map(|m| m.data).collect()
    }

    /// The originals the worktree's links lead to are all still there.
    fn originals_intact(f: &Fixture) {
        assert_eq!(read(&f.repo.join("node_modules/pkg/index.js")), "module");
        assert_eq!(read(&f.repo.join("cache/model.bin")), "weights");
        assert_eq!(read(&f.repo.join(".env")), "secret");
        assert_eq!(read(&f.outside.join("passwd")), "outside");
    }

    const COPY: &str = ".env\n# a comment\nbuild/out.txt\nleak\nnotes.txt\nREADME\nmissing.txt\n../escape\n";
    const LINK: &str = "node_modules\n./cache/\nmissing-dir\n.env\nout-dir\nREADME\n/etc\n";

    #[test]
    fn copies_ignored_files_and_links_ignored_folders_before_the_setup_script() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let f = fixture(&s, COPY, LINK).await;
            // The setup script sees them.
            s.db().execute("UPDATE projects SET setup_script='cat .env node_modules/pkg/index.js > seen' WHERE id=?1", [&f.project_id]).unwrap();
            let t = create_task_inner(&s, &f.project_id, CreateTask { title: "Do it".into(), ..Default::default() }).unwrap();
            if let Err(e) = setup(&s, &t.id).await {
                panic!("{e:#}\n{:#?}", events(&s, &t.id));
            }
            let t = db::get_task(&s.db(), &t.id).unwrap().unwrap();
            let wt = PathBuf::from(t.worktree_path.clone().unwrap());
            assert_eq!(read(&wt.join("seen")), "secretmodule");
            std::fs::remove_file(wt.join("seen")).unwrap();

            // Ignored files matching the patterns, at any depth unless anchored, and from .worktreeinclude.
            assert_eq!(read(&wt.join(".env")), "secret");
            assert_eq!(read(&wt.join("sub/.env")), "sub secret");
            assert_eq!(read(&wt.join("build/out.txt")), "built");
            assert_eq!(read(&wt.join("config/dev.local.json")), "dev");
            // Not tracked files (the branch's own is kept), not untracked ones git doesn't ignore,
            // and nothing from outside the repository.
            assert_eq!(read(&wt.join("config/app.local.json")), "tracked");
            for not in ["notes.txt", "leak", "out-dir", "missing.txt", "missing-dir"] {
                assert!(wt.join(not).symlink_metadata().is_err(), "{not}");
            }
            // The folders are links to the repository's.
            assert_eq!(std::fs::read_link(wt.join("node_modules")).unwrap(), f.repo.join("node_modules"));
            assert_eq!(std::fs::read_link(wt.join("cache")).unwrap(), f.repo.join("cache"));
            assert_eq!(read(&wt.join("cache/model.bin")), "weights");
            // None of it is a change to commit: the links are excluded, since `node_modules/` doesn't
            // ignore a symlink.
            assert_eq!(sh(&wt, &["status", "--porcelain", "--untracked-files=all"]), "");
            let exclude = read(&f.repo.join(".git/info/exclude"));
            assert!(exclude.contains("\n/node_modules\n/cache\n"), "{exclude}");

            let events = events(&s, &t.id);
            let e = events.iter().find(|e| e["text"].as_str().unwrap().contains("from the repository")).expect("an event for the files");
            assert_eq!((e["level"].as_str().unwrap(), e["text"].as_str().unwrap()), ("warn", "Copied 4 files and linked 2 folders from the repository (10 left out)"));
            let detail = e["detail"].as_str().unwrap();
            for line in [
                "Read .worktreeinclude",
                "copied .env",
                "copied sub/.env",
                "copied config/dev.local.json",
                &format!("linked node_modules -> {}", f.repo.join("node_modules").display()),
                "left out: leak: a symbolic link",
                "left out: 1 matching file git doesn't ignore (only ignored files are copied): notes.txt",
                "left out: README: tracked by git, not copied",
                "left out: missing.txt: not in the repository",
                "left out: ../escape: patterns are relative to the repository, without ..",
                "left out: missing-dir: not in the repository",
                "left out: .env: not a folder",
                "left out: out-dir: a symbolic link",
                "left out: README: not a folder",
                "left out: /etc: folders are relative to the repository",
            ] {
                assert!(detail.lines().any(|l| l == line), "{line:?} not in:\n{detail}");
            }
            // Before the setup script ran.
            let at = |text: &str| events.iter().position(|e| e["text"].as_str().unwrap().starts_with(text)).unwrap();
            assert!(at("Copied") < at("Running setup script"));

            // Writing through a link changes the original (that's what linking is for).
            write(&wt.join("node_modules/pkg/new.js"), "new");
            assert_eq!(read(&f.repo.join("node_modules/pkg/new.js")), "new");

            // A second task adds no second exclude line.
            let (_, wt2) = new_task(&s, &f, "Another").await;
            assert!(wt2.join("node_modules").is_symlink());
            assert_eq!(read(&f.repo.join(".git/info/exclude")).matches("/node_modules\n").count(), 1);
        })
    }

    #[test]
    fn removing_a_worktree_removes_its_links_not_what_they_lead_to() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let f = fixture(&s, ".env\n", "node_modules\ncache\n").await;

            // Plain teardown (git's own check, then `git worktree remove`).
            let (t, wt) = new_task(&s, &f, "Plain").await;
            assert!(wt.join("node_modules").is_symlink());
            teardown(&s, &t.id, false, false).await.unwrap();
            assert!(!wt.exists());
            originals_intact(&f);

            // Forced teardown.
            let (t, wt) = new_task(&s, &f, "Forced").await;
            write(&wt.join("uncommitted"), "u");
            teardown(&s, &t.id, true, true).await.unwrap();
            assert!(!wt.exists());
            originals_intact(&f);

            // Removed by hand when git won't (a locked worktree), from another working directory.
            let (t, wt) = new_task(&s, &f, "Locked").await;
            sh(&f.repo, &["worktree", "lock", &path_str(&wt)]);
            teardown(&s, &t.id, true, false).await.unwrap();
            assert!(!wt.exists());
            originals_intact(&f);

            // Remove merged worktrees: copied files and links don't count as work that would be lost.
            let (t, wt) = new_task(&s, &f, "Merged").await;
            write(&wt.join("a"), "a");
            sh(&wt, &["add", "a"]);
            sh(&wt, &["commit", "-qm", "a"]);
            sh(&f.repo, &["merge", "-q", "--no-ff", "-m", "merge", t.branch.as_deref().unwrap()]);
            db::update_task(&s.db(), &t.id, &[("status", json!("done"))]).unwrap();
            let results = remove_merged(&s, &f.project_id).await.unwrap();
            assert_eq!((&results[0]["removed"], &results[0]["detail"]), (&json!(true), &json!("merged into master")), "{results:?}");
            assert!(!wt.exists());
            originals_intact(&f);

            // And when merged on its own.
            let (t, wt) = new_task(&s, &f, "Merged too").await;
            db::update_task(&s.db(), &t.id, &[("status", json!("done"))]).unwrap();
            assert_eq!(remove_if_merged(&s, &t.id, false).await.unwrap(), Removal::Removed("master".into()));
            assert!(!wt.exists());
            originals_intact(&f);
            assert!(f.repo.join("node_modules").is_dir() && !f.repo.join("node_modules").is_symlink());
        })
    }

    #[test]
    fn never_overwrites_or_writes_through_a_symlink_in_the_worktree() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let f = fixture(&s, ".env\nbuild/\n", "node_modules\n").await;
            let (_, wt) = new_task(&s, &f, "Do it").await;
            let project = db::get_project(&s.db(), &f.project_id).unwrap().unwrap();
            // Changed in the worktree, and the link replaced by a folder of its own.
            write(&wt.join(".env"), "mine");
            std::fs::remove_file(wt.join("node_modules")).unwrap();
            write(&wt.join("node_modules/own.js"), "own");
            // A symlink in the worktree where a copy would go.
            std::fs::remove_dir_all(wt.join("build")).unwrap();
            std::os::unix::fs::symlink(&f.outside, wt.join("build")).unwrap();
            let report = bring_in(&project, &wt).await.unwrap();
            assert_eq!(read(&wt.join(".env")), "mine");
            assert!(!wt.join("node_modules").is_symlink());
            assert!(!f.outside.join("out.txt").exists());
            assert!(report.copied.is_empty() && report.linked.is_empty(), "{report:?}");
            assert_eq!(report.existing, [".env", "config/dev.local.json", "sub/.env", "node_modules"]);
            assert_eq!(report.skipped, ["build/out.txt: build in the worktree isn't a folder"]);
        })
    }

    #[test]
    fn a_task_branch_that_doesnt_ignore_a_file_doesnt_get_it() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let f = fixture(&s, ".env\n", "").await;
            sh(&f.repo, &["checkout", "-q", "-b", "old"]);
            write(&f.repo.join(".gitignore"), "node_modules/\n");
            sh(&f.repo, &["commit", "-qam", "unignore"]);
            sh(&f.repo, &["checkout", "-q", "master"]);
            let t = create_task_inner(&s, &f.project_id, CreateTask { title: "Old".into(), ..Default::default() }).unwrap();
            db::update_task(&s.db(), &t.id, &[("base_branch", json!("old"))]).unwrap();
            let t = setup(&s, &t.id).await.unwrap();
            let wt = PathBuf::from(t.worktree_path.unwrap());
            assert!(!wt.join(".env").exists());
            assert_eq!(sh(&wt, &["status", "--porcelain"]), "");
        })
    }

    #[test]
    fn a_repository_with_nothing_to_bring_in_logs_nothing() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let f = fixture(&s, "", "").await;
            std::fs::remove_file(f.repo.join(INCLUDE_FILE)).unwrap();
            let (t, _) = new_task(&s, &f, "Do it").await;
            assert!(!events(&s, &t.id).iter().any(|e| e["text"].as_str().unwrap().contains("from the repository")));
        })
    }

    #[test]
    fn checks_what_the_settings_name() {
        assert_eq!(link_path("./models/cache/").unwrap(), Path::new("models/cache"));
        for bad in ["/etc", "~/x", "../x", "a/../../x", ".", ".git", "a/.git/hooks"] {
            assert!(link_path(bad).is_err(), "{bad}");
        }
        assert!(check_pattern("!/config/*.json").is_ok());
        assert!(check_pattern("a/../b").is_err() && check_pattern("!../b").is_err());
        assert!(check("copy_files", ".env\n# ../comment\n").is_ok());
        assert!(check("link_folders", "models\n/abs\n").unwrap_err().contains("link_folders: /abs"));
        assert!(check("copy_files", &"x\n".repeat(201)).is_err());
    }

    #[test]
    fn literal_patterns_match_as_git_would() {
        let m = |p: &str, f: &str| literal_matches(p, Path::new(f));
        assert!(m(".env", ".env") && m(".env", "a/b/.env") && m("build/", "build/x") && m("build", "a/build/x"));
        assert!(m("/.env", ".env") && !m("/.env", "a/.env") && m("a/b", "a/b/c") && !m("a/b", "x/a/b"));
        assert!(!m(".env", ".env.local") && !m("build", "builder/x"));
    }

    #[test]
    fn relinks_folders_after_the_repository_moves() {
        crate::testing::run(async || {
        let root = std::env::temp_dir().join(format!("ia-wf-{}", crate::util::new_id()));
        let wt = root.join("wt");
        std::fs::create_dir_all(wt.join("a")).unwrap();
        std::os::unix::fs::symlink(root.join("old/models"), wt.join("models")).unwrap();
        std::os::unix::fs::symlink(root.join("elsewhere"), wt.join("a/b")).unwrap();
        let map = |p: &Path| p.strip_prefix(root.join("old")).ok().map(|r| root.join("new").join(r));
        relink(&wt, "models\na/b\n", map).await;
        assert_eq!(std::fs::read_link(wt.join("models")).unwrap(), root.join("new/models"));
        assert_eq!(std::fs::read_link(wt.join("a/b")).unwrap(), root.join("elsewhere"));
        std::fs::remove_dir_all(&root).unwrap();
        })
    }

    // HA-52 review: the git checks were of a symlink's own (ignored, untracked) path, while the
    // copy or link led to tracked files or the repository's .git.
    #[test]
    fn symlinks_in_the_repository_are_neither_copied_nor_linked() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let f = fixture(&s, "alias-file\nvia/x.env\n", "alias-dir\ngit-alias\nvia/inner\n").await;
            write(&f.repo.join("src/app.txt"), "tracked app");
            write(&f.repo.join("src/inner/x.env"), "tracked env");
            write(&f.repo.join("src/x.env"), "tracked env");
            sh(&f.repo, &["add", "src"]);
            sh(&f.repo, &["commit", "-qm", "src"]);
            for (name, to) in [("alias-file", "src/app.txt"), ("alias-dir", "src"), ("git-alias", ".git"), ("via", "src")] {
                std::os::unix::fs::symlink(f.repo.join(to), f.repo.join(name)).unwrap();
            }
            std::fs::write(f.repo.join(".git/info/exclude"), "alias-file\nalias-dir\ngit-alias\nvia\n").unwrap();
            let (t, wt) = new_task(&s, &f, "Do it").await;
            for name in ["alias-file", "alias-dir", "git-alias", "via"] {
                assert!(wt.join(name).symlink_metadata().is_err(), "{name}");
            }
            let detail = events(&s, &t.id).into_iter().find_map(|e| e["detail"].as_str().filter(|d| d.contains("left out")).map(str::to_string)).unwrap();
            for line in ["left out: alias-file: a symbolic link", "left out: alias-dir: a symbolic link", "left out: git-alias: a symbolic link", "left out: via/inner: via is a symbolic link"] {
                assert!(detail.lines().any(|l| l == line), "{line:?} not in:\n{detail}");
            }
            assert_eq!(read(&f.repo.join("src/app.txt")), "tracked app");
        })
    }

    #[test]
    fn a_worktreeinclude_that_is_a_symlink_isnt_read() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let f = fixture(&s, "", "").await;
            write(&f.outside.join("private"), "CANARY-SECRET\n");
            std::fs::remove_file(f.repo.join(INCLUDE_FILE)).unwrap();
            std::os::unix::fs::symlink(f.outside.join("private"), f.repo.join(INCLUDE_FILE)).unwrap();
            let (t, wt) = new_task(&s, &f, "Do it").await;
            let events = serde_json::to_string(&events(&s, &t.id)).unwrap();
            assert!(!events.contains("CANARY"), "{events}");
            assert!(events.contains("left out: .worktreeinclude: a symbolic link, not read"), "{events}");
            // Nor is it copied from the folder it leads to.
            assert!(!wt.join("config/dev.local.json").exists());
        })
    }

    #[test]
    fn links_are_moved_with_the_repository_even_once_out_of_the_setting() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let f = fixture(&s, "", "node_modules\n").await;
            let (_, wt) = new_task(&s, &f, "Do it").await;
            assert_eq!(std::fs::read_link(wt.join("node_modules")).unwrap(), f.repo.join("node_modules"));
            let body = json!({"link_folders": ""});
            crate::api::update_project_inner(&s, &f.project_id, body.as_object().unwrap()).await.unwrap();
            let moved = f.root.join("moved");
            let body = json!({"repo_path": path_str(&moved), "move_repo": true});
            crate::api::update_project_inner(&s, &f.project_id, body.as_object().unwrap()).await.unwrap();
            assert_eq!(std::fs::read_link(wt.join("node_modules")).unwrap(), moved.join("node_modules"));
            assert_eq!(read(&wt.join("node_modules/pkg/index.js")), "module");
        })
    }
}
