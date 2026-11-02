//! Changing a project's repository folder: pointing the project at where its folder is now
//! (after it was moved or renamed outside the board), or moving the folder there. Either way
//! the paths stored inside the folder (worktrees kept in it, the worktrees folder) move along,
//! the task worktrees are reconnected to the repository (`git worktree repair`), and Claude
//! conversations that ran in the old folders are copied to where Claude looks for them in the
//! new ones, so those tasks can still be resumed.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde_json::json;

use crate::db::{self, Project, Task};
use crate::state::{ApiError, ApiResult, Shared};
use crate::util::{expand_tilde, is_git_root, path_str};
use crate::worktree;

/// The project's paths after its folder moved, to store.
pub struct Relocated {
    pub repo_path: String,
    /// The worktrees and scratch folders, when they were inside the repository folder.
    pub worktrees_root: Option<String>,
    pub scratch_path: Option<String>,
    /// See Project::repo_root.
    pub repo_root: String,
}

/// Paths inside the old folder (by the path stored or the one it really was at) and where
/// they are now.
struct Mapping {
    from: Vec<PathBuf>,
    to: PathBuf,
}

impl Mapping {
    fn map(&self, p: &Path) -> Option<PathBuf> {
        self.from.iter().find_map(|f| p.strip_prefix(f).ok()).map(|rest| self.to.join(rest))
    }
}

/// Checks that `project`'s folder can change to `new` (see change) without changing anything.
pub async fn check(s: &Shared, project: &Project, new: &Path, move_folder: bool) -> ApiResult<()> {
    if !new.is_absolute() {
        return Err(ApiError::bad(format!("the repository path must be absolute (got {})", new.display())));
    }
    let old = PathBuf::from(&project.repo_path);
    let tasks = project_tasks(s, &project.id)?;
    if move_folder {
        return check_move(s, &old, new, &tasks);
    }
    if !new.is_dir() {
        return Err(ApiError::bad(format!("{} isn't a folder", new.display())));
    }
    let new = canonical(new);
    check_same_repo(project, &old, &new, &tasks, &Mapping { from: old_folders(&old), to: new.clone() }).await
}

/// The paths `old` goes by: as stored, and where the folder really is, which is where Claude
/// has kept the conversations run in it.
fn old_folders(old: &Path) -> Vec<PathBuf> {
    let mut from = vec![old.to_path_buf()];
    from.extend(old.canonicalize().ok().filter(|real| real != old));
    from
}

/// Changes `project`'s folder to `new` (moving the folder there first when `move_folder`). Updates
/// the tasks' worktree paths, and returns the project's paths to store.
pub async fn change(s: &Shared, project: &Project, new: &Path, move_folder: bool) -> ApiResult<Relocated> {
    check(s, project, new, move_folder).await?;
    let old = PathBuf::from(&project.repo_path);
    let from = old_folders(&old);
    let tasks = project_tasks(s, &project.id)?;
    if move_folder {
        move_dir(&old, new)?;
    }
    let new = canonical(new);
    let mapping = Mapping { from, to: new.clone() };
    // Worktrees kept inside the repository moved along with it.
    let mut moved = Vec::new();
    for t in &tasks {
        let Some(wt) = t.worktree_path.as_deref() else { continue };
        let Some(to) = mapping.map(Path::new(wt)).filter(|to| to != Path::new(wt)) else { continue };
        s.update_task(&t.id, &[("worktree_path", json!(path_str(&to)))])?;
        moved.push((t, PathBuf::from(wt), to));
    }
    if is_git_root(&new) {
        // Points the worktrees' .git files at the repository's new place, and the repository at
        // the worktrees that moved.
        let paths: Vec<String> = moved.iter().map(|(_, _, to)| path_str(to)).collect();
        let mut args = vec!["worktree", "repair"];
        args.extend(paths.iter().map(String::as_str));
        match worktree::git(&new, &args).await {
            Ok(o) if !o.ok => tracing::warn!("git worktree repair in {}: {}", new.display(), o.stderr.trim()),
            Err(e) => tracing::warn!("git worktree repair in {}: {e:#}", new.display()),
            Ok(_) => {}
        }
        let worktrees: Vec<PathBuf> = tasks.iter().filter_map(|t| t.worktree_path.as_deref()).map(|wt| mapping.map(Path::new(wt)).unwrap_or_else(|| wt.into())).collect();
        let common = common_dir(&new).await.unwrap_or_else(|| new.join(".git"));
        relink(&common, &mapping, &worktrees);
        // The folders linked into them lead into the old folder.
        for wt in &worktrees {
            crate::worktree_files::relink(wt, &project.link_folders, |p| mapping.map(p)).await;
        }
        relink_submodules(&new, &common, &mapping).await;
    }
    let inside = |p: &str| mapping.map(Path::new(p)).map(|to| path_str(&to)).filter(|to| to != p);
    let scratch_path = inside(&project.scratch_path);
    // Each thread's conversation, from the folder it ran in: the repository, or its worktree (a
    // review thread's is the task's it reviews).
    let from_repo: Vec<&Path> = mapping.from.iter().map(PathBuf::as_path).collect();
    for t in &tasks {
        copy_session(s, t, &from_repo, &new);
        let owner = if t.kind == "review" { t.parent_id.as_deref() } else { Some(t.id.as_str()) };
        let owner = tasks.iter().find(|o| Some(o.id.as_str()) == owner);
        if let Some((from, to)) = owner.and_then(|o| worktree_folder(project, o)).and_then(|from| mapping.map(&from).filter(|to| *to != from).map(|to| (from, to))) {
            copy_session(s, t, &[&from], &to);
        }
    }
    // Scratch tasks that were the project's scratch chats work in its scratch folder.
    if let Some(to) = &scratch_path {
        let chats = db::tasks_in_work_dir(&s.db(), &project.scratch_path)?;
        for t in chats {
            copy_session(s, &t, &[Path::new(&project.scratch_path)], Path::new(to));
            s.update_task(&t.id, &[("work_dir", json!(to))])?;
        }
    }
    Ok(Relocated {
        repo_path: path_str(&new),
        worktrees_root: inside(&project.worktrees_root),
        scratch_path,
        repo_root: fingerprint(&new).await,
    })
}

/// The git folder that `repo` and its worktrees share: its .git, or for a linked checkout, its
/// main checkout's (which doesn't move with it).
async fn common_dir(repo: &Path) -> Option<PathBuf> {
    match worktree::git(repo, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).await {
        Ok(o) if o.ok => Some(PathBuf::from(o.stdout.trim())),
        _ => None,
    }
}

/// Points git's links between the worktrees and their git folder `common` (see common_dir) at
/// where they are now when they still name an old folder: older versions of `git worktree
/// repair` leave a link alone while its old path still leads to the right place (through a
/// symlink, say).
fn relink(common: &Path, mapping: &Mapping, worktrees: &[PathBuf]) {
    let fix = |file: PathBuf, prefix: &str| {
        let Ok(text) = std::fs::read_to_string(&file) else { return };
        let Some(old) = text.trim_end().strip_prefix(prefix) else { return };
        let Some(new) = mapping.map(Path::new(old)).filter(|new| new != Path::new(old)) else { return };
        if let Err(e) = std::fs::write(&file, format!("{prefix}{}\n", new.display())) {
            tracing::warn!("pointing {} at {}: {e}", file.display(), new.display());
        }
    };
    // Each worktree's .git file names its folder in the git folder's worktrees, and that
    // folder's gitdir file names the worktree's .git file (the project's own too, when it's a
    // linked checkout).
    for wt in worktrees {
        fix(wt.join(".git"), "gitdir: ");
    }
    for dir in std::fs::read_dir(common.join("worktrees")).into_iter().flatten().flatten() {
        fix(dir.path().join("gitdir"), "");
    }
}

/// Reconnects the submodules checked out in the moved repository folder `repo` and its
/// worktrees with their git folders, in the git folder `common` (see common_dir). Git links the
/// two with paths relative to each other, which no longer lead there once only one of them has
/// moved: a task worktree's submodules, whose git folders are in the repository's .git/worktrees,
/// or a linked checkout's, whose git folders stay in its main checkout's. Links that still lead
/// to the right place are left as they are.
async fn relink_submodules(repo: &Path, common: &Path, mapping: &Mapping) {
    let mut modules = Vec::new();
    find_modules(&common.join("modules"), &mut modules);
    for dir in std::fs::read_dir(common.join("worktrees")).into_iter().flatten().flatten() {
        find_modules(&dir.path().join("modules"), &mut modules);
    }
    // Where the repository was, as git saw it.
    let Some(old) = mapping.from.last() else { return };
    for module in modules {
        let config = path_str(&module.join("config"));
        let worktree = match worktree::git(repo, &["config", "-f", &config, "--get", "core.worktree"]).await {
            Ok(o) if o.ok => o.stdout.trim().to_string(),
            _ => continue,
        };
        // The checkout, from where the module's folder was (moved along if it's in the folder),
        // and where it is now.
        let was = module.strip_prefix(repo).map(|inside| old.join(inside)).unwrap_or_else(|_| module.clone());
        let checkout = normalize(&was.join(&worktree));
        let checkout = mapping.map(&checkout).unwrap_or(checkout);
        let gitfile = checkout.join(".git");
        let Some(linked) = std::fs::read_to_string(&gitfile).ok().and_then(|t| t.trim_end().strip_prefix("gitdir: ").map(PathBuf::from)) else { continue };
        if normalize(&checkout.join(linked)) != module {
            if let Err(e) = std::fs::write(&gitfile, format!("gitdir: {}\n", relative(&checkout, &module).display())) {
                tracing::warn!("pointing {} at {}: {e}", gitfile.display(), module.display());
            }
        }
        if normalize(&module.join(&worktree)) != checkout {
            let to = path_str(&relative(&module, &checkout));
            if let Ok(o) = worktree::git(repo, &["config", "-f", &config, "core.worktree", &to]).await
                && !o.ok
            {
                tracing::warn!("pointing {} at {}: {}", module.display(), checkout.display(), o.stderr.trim());
            }
        }
    }
}

/// The submodules' git folders in `dir` (a .git/modules), theirs included, into `out`. A
/// submodule's name may have slashes in it, so a folder that isn't a git folder is looked in.
fn find_modules(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        if path.join("HEAD").is_file() && path.join("config").is_file() {
            find_modules(&path.join("modules"), out);
            out.push(path);
        } else {
            find_modules(&path, out);
        }
    }
}

/// `path` without its `.` and `..` parts, worked out from the path alone.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            part => out.push(part),
        }
    }
    out
}

/// The path to `to` from the folder `from` (both absolute and normalized).
fn relative(from: &Path, to: &Path) -> PathBuf {
    let (from, to): (Vec<_>, Vec<_>) = (from.components().collect(), to.components().collect());
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut out: PathBuf = std::iter::repeat_n("..", from.len() - common).collect();
    out.extend(&to[common..]);
    out
}

/// The folder a task's worktree is in, or was in before it was removed (once merged, say),
/// which is where setting it up again puts it back (see worktree::folder_name).
fn worktree_folder(project: &Project, task: &Task) -> Option<PathBuf> {
    match (&task.worktree_path, &task.branch) {
        (Some(wt), _) => Some(PathBuf::from(wt)),
        (None, Some(_)) => Some(Path::new(&project.worktrees_root).join(worktree::folder_name(project, task))),
        (None, None) => None,
    }
}

/// What the folder `dir` is (see Project::repo_root).
pub async fn fingerprint(dir: &Path) -> String {
    if !is_git_root(dir) {
        return String::new();
    }
    match worktree::git(dir, &["rev-list", "--max-parents=0", "HEAD"]).await {
        Ok(o) if o.ok && !o.stdout.trim().is_empty() => {
            let mut roots: Vec<&str> = o.stdout.split_whitespace().collect();
            roots.sort_unstable();
            roots.join(" ")
        }
        _ => "git".into(),
    }
}

/// Whether a fingerprint is the commits a repository's history started from, which tell it
/// apart from others (unlike `git`, a repository without commits yet, or an empty one, a
/// folder that wasn't a repository when it was looked at but may be one now).
fn is_history(fingerprint: &str) -> bool {
    !fingerprint.is_empty() && fingerprint != "git"
}

/// Looks again, every hour, at what the projects' folders are (see record_fingerprints).
pub fn start_recording(s: &Shared) {
    let s = s.clone();
    tokio::spawn(async move {
        loop {
            record_fingerprints(&s).await;
            tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
        }
    });
}

/// Records `project`'s fingerprint if it doesn't have its history yet (e.g. once its folder
/// has become a git repository, or has its first commit).
pub async fn record_fingerprint(s: &Shared, project: &Project) {
    if project.repo_root.as_deref().is_some_and(is_history) {
        return;
    }
    let path = PathBuf::from(&project.repo_path);
    if !path.is_dir() {
        return;
    }
    let now = fingerprint(&path).await;
    if project.repo_root.as_deref() != Some(now.as_str()) {
        store_fingerprint(s, &project.id, &project.repo_path, &now);
    }
}

/// Records that project `id`'s folder `repo_path` is `fingerprint`, unless the project has moved
/// to another folder meanwhile.
fn store_fingerprint(s: &Shared, id: &str, repo_path: &str, fingerprint: &str) {
    let stored = s.db().execute("UPDATE projects SET repo_root=?1 WHERE id=?2 AND repo_path=?3", rusqlite::params![fingerprint, id, repo_path]);
    if let Err(e) = stored {
        tracing::warn!("recording project {id}'s repository: {e:#}");
    }
}

/// Records what each project's folder is, for those whose history it doesn't have yet, while
/// the folders are where the board expects them.
pub async fn record_fingerprints(s: &Shared) {
    let projects: Vec<(String, String, Option<String>)> = {
        let c = s.db();
        let Ok(mut st) = c.prepare("SELECT id, repo_path, repo_root FROM projects WHERE repo_root IS NULL OR repo_root IN ('', 'git')") else { return };
        let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)));
        rows.map(|rows| rows.filter_map(Result::ok).collect()).unwrap_or_default()
    };
    for (id, repo_path, before) in projects {
        let path = PathBuf::from(&repo_path);
        if !path.is_dir() {
            continue;
        }
        let now = fingerprint(&path).await;
        if before.as_deref() != Some(now.as_str()) {
            store_fingerprint(s, &id, &repo_path, &now);
        }
    }
}

/// The project's tasks and review threads.
fn project_tasks(s: &Shared, project_id: &str) -> ApiResult<Vec<Task>> {
    let c = s.db();
    let mut all = db::list_tasks_for_project(&c, project_id, "task")?;
    all.extend(db::list_tasks_for_project(&c, project_id, "review")?);
    Ok(all)
}

/// Checks that the folder `old` can move to `new`.
fn check_move(s: &Shared, old: &Path, new: &Path, tasks: &[Task]) -> ApiResult<()> {
    if std::fs::symlink_metadata(old).is_ok_and(|m| m.file_type().is_symlink()) {
        let target = old.canonicalize().map(|t| t.display().to_string()).unwrap_or_else(|_| "a missing folder".into());
        return Err(ApiError::bad(format!(
            "{} is a link to {target}; set the repository path to the folder itself instead of moving the link",
            old.display()
        )));
    }
    if !old.is_dir() {
        return Err(ApiError::bad(format!(
            "{} doesn't exist, so there's nothing to move; if the folder has already moved, set its new path without moving",
            old.display()
        )));
    }
    if new.exists() {
        return Err(ApiError::bad(format!("{} already exists", new.display())));
    }
    if !new.parent().is_some_and(Path::is_dir) {
        return Err(ApiError::bad(format!("{}'s parent folder doesn't exist", new.display())));
    }
    if new.starts_with(old) {
        return Err(ApiError::bad(format!("{} is inside {}", new.display(), old.display())));
    }
    // Their agents are in the folder, or run git in it.
    let running: Vec<&Task> = tasks.iter().filter(|t| s.is_running(&t.id)).collect();
    if !running.is_empty() {
        let n = running.len();
        return Err(ApiError::conflict(format!(
            "{n} of the project's agents {} running; stop {} before moving its folder",
            if n == 1 { "is" } else { "are" },
            if n == 1 { "it" } else { "them" }
        )));
    }
    Ok(())
}

/// Moves the folder `old` to `new` (see check_move).
fn move_dir(old: &Path, new: &Path) -> ApiResult<()> {
    std::fs::rename(old, new).map_err(|e| {
        let hint = if e.raw_os_error() == Some(libc::EXDEV) { " (it's on another filesystem: move it yourself, then set the new path)" } else { "" };
        ApiError::bad(format!("moving {} to {}: {e}{hint}", old.display(), new.display()))
    })?;
    Ok(())
}

/// Checks that `new` is the project's repository (after it was moved there, or by another path
/// to it), so its tasks' worktrees and branches are still there and its agents work on it.
async fn check_same_repo(project: &Project, old: &Path, new: &Path, tasks: &[Task], mapping: &Mapping) -> ApiResult<()> {
    if same_dir(old, new) {
        return Ok(());
    }
    let not_it = |why: &str| Err(ApiError::bad(format!("{} doesn't look like the project's repository: {why}", new.display())));
    if old.exists() && is_git_root(old) {
        // The folder is still there, so it hasn't moved, and `new` (which isn't it, or a link to
        // it) is another folder, even if it's a checkout of the same repository.
        return Err(ApiError::bad(format!(
            "{} isn't the project's repository folder, which is still at {}",
            new.display(),
            project.repo_path
        )));
    }
    // The folder has moved: the repository there has the project's worktrees (those kept inside
    // it moved along, and it still knows them by their old paths)…
    let worktrees: Vec<&str> = tasks
        .iter()
        .filter_map(|t| t.worktree_path.as_deref())
        .filter(|wt| Path::new(wt).exists() || mapping.map(Path::new(wt)).is_some_and(|to| to.exists()))
        .collect();
    if !worktrees.is_empty() {
        if !is_git_root(new) {
            return not_it("it isn't a git repository");
        }
        let listed = worktree_list(new).await;
        // By its old path, or its new one if it has been repaired already.
        let known = |wt: &str| {
            let new_path = mapping.map(Path::new(wt)).map(|to| canonical(&to));
            listed.contains(&canonical(Path::new(wt))) || listed.contains(Path::new(wt)) || new_path.is_some_and(|to| listed.contains(&to))
        };
        let missing: Vec<&str> = worktrees.into_iter().filter(|wt| !known(wt)).collect();
        if missing.is_empty() {
            return Ok(());
        }
        let s = if missing.len() == 1 { "" } else { "s" };
        return not_it(&format!("it doesn't have the task worktree{s} {}", missing.join(", ")));
    }
    // …or the history it started from…
    if let Some(roots) = project.repo_root.as_deref().filter(|r| is_history(r)) {
        if !is_git_root(new) {
            return not_it("it isn't a git repository, and the project's was");
        }
        let theirs = fingerprint(new).await;
        if !is_history(&theirs) {
            return not_it("it has no commits, and the project's repository had");
        }
        if roots.split(' ').any(|r| theirs.split(' ').any(|o| o == r)) {
            return Ok(());
        }
        // A shallow clone's history starts where it was cut off, which is no root once the rest is
        // fetched: the commit is in the history all the same.
        for r in roots.split(' ') {
            if worktree::git(new, &["merge-base", "--is-ancestor", r, "HEAD"]).await.is_ok_and(|o| o.ok) {
                return Ok(());
            }
        }
        return not_it("it has none of the commits the project's history started from");
    }
    // …or, when the board doesn't know its history, its tasks' branches.
    let branches: HashSet<&str> = tasks.iter().filter_map(|t| t.branch.as_deref()).collect();
    if branches.is_empty() {
        let fix = if old.exists() {
            "To move the project's folder, move it with the board to a path that doesn't exist yet; to use that folder, add it as a new project"
        } else {
            "Move the folder back and move it with the board instead, or add it as a new project"
        };
        return Err(ApiError::bad(format!(
            "can't tell whether {} is the same folder as the project's ({}): the board has no record of its git history. {fix}",
            new.display(),
            project.repo_path
        )));
    }
    for b in &branches {
        let r = format!("refs/heads/{b}");
        if worktree::git(new, &["rev-parse", "--verify", "--quiet", &r]).await.is_ok_and(|o| o.ok) {
            return Ok(());
        }
    }
    not_it("it has none of its tasks' branches")
}

fn canonical(p: &Path) -> PathBuf {
    p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
}

fn same_dir(a: &Path, b: &Path) -> bool {
    matches!((a.canonicalize(), b.canonicalize()), (Ok(a), Ok(b)) if a == b)
}

/// The worktrees registered in `repo`.
async fn worktree_list(repo: &Path) -> HashSet<PathBuf> {
    let Ok(o) = worktree::git(repo, &["worktree", "list", "--porcelain"]).await else { return HashSet::new() };
    o.stdout.lines().filter_map(|l| l.strip_prefix("worktree ")).map(|p| canonical(Path::new(p))).collect()
}

/// Claude Code keeps a conversation under its config's `projects/<folder>`, named after the
/// folder it ran in, and only resumes it from there. Copies the thread's, if it ran in one of
/// `from`, to `to`'s, leaving the original. A copy there from before (the project was there
/// before, and has since carried on elsewhere) is brought up to date.
fn copy_session(s: &Shared, t: &Task, from: &[&Path], to: &Path) {
    let Some(sid) = t.session_id.as_deref() else { return };
    let (dir, codex) = {
        let c = s.db();
        let dir = db::task_config_dir(&c, t).ok().flatten();
        (dir, db::task_is_codex(&c, t).unwrap_or(false))
    };
    if codex {
        return;
    }
    let projects = config_dir(dir.as_deref()).join("projects");
    let dest = projects.join(claude_project_dir(to));
    for f in from {
        let src = projects.join(claude_project_dir(f));
        if src == dest || !src.join(format!("{sid}.jsonl")).exists() {
            continue;
        }
        // The transcript, and its folder of subagents' transcripts and tool results.
        for name in [format!("{sid}.jsonl"), sid.to_string()] {
            let (a, b) = (src.join(&name), dest.join(&name));
            if a.exists()
                && let Err(e) = copy_newer(&a, &b)
            {
                tracing::warn!("copying {} to {}: {e}", a.display(), b.display());
            }
        }
        return;
    }
}

fn config_dir(dir: Option<&str>) -> PathBuf {
    match dir {
        Some(d) => expand_tilde(d),
        None => std::env::var("CLAUDE_CONFIG_DIR").map(|d| expand_tilde(&d)).unwrap_or_else(|_| expand_tilde("~/.claude")),
    }
}

/// The name of the folder Claude Code keeps the conversations run in `cwd` in.
fn claude_project_dir(cwd: &Path) -> String {
    path_str(cwd).chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// Copies the files in `from` that `to` doesn't have, or has an older copy of. Copies keep
/// their original's time, so one that hasn't changed on either side since isn't copied again.
fn copy_newer(from: &Path, to: &Path) -> std::io::Result<()> {
    if from.is_dir() {
        std::fs::create_dir_all(to)?;
        for e in std::fs::read_dir(from)? {
            let e = e?;
            copy_newer(&e.path(), &to.join(e.file_name()))?;
        }
        return Ok(());
    }
    let modified = std::fs::metadata(from)?.modified()?;
    if std::fs::metadata(to).and_then(|m| m.modified()).is_ok_and(|theirs| theirs >= modified) {
        return Ok(());
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(from, to)?;
    std::fs::File::options().write(true).open(to)?.set_modified(modified)
}
/// The projects whose folders are moving, and those being worked in in ways that keep them
/// where they are (see Holding).
#[derive(Default)]
pub struct Relocations {
    moving: HashSet<String>,
    holds: HashMap<String, usize>,
}

/// Marks a project's folder as moving until it's dropped, while project_changes is held, so
/// agents of the project wait to start until the project says where it is now (see settled).
pub struct Moving {
    s: Shared,
    project_id: String,
}

impl Moving {
    /// Refused while a Holding keeps the folder where it is.
    pub fn new(s: &Shared, project_id: &str) -> ApiResult<Self> {
        let mut r = s.relocating.lock().unwrap();
        if r.holds.get(project_id).is_some_and(|n| *n > 0) {
            return Err(ApiError::conflict("one of the project's task worktrees is being set up; move its folder once that's done"));
        }
        r.moving.insert(project_id.to_string());
        Ok(Moving { s: s.clone(), project_id: project_id.to_string() })
    }
}

impl Drop for Moving {
    fn drop(&mut self) {
        self.s.relocating.lock().unwrap().moving.remove(&self.project_id);
    }
}

/// Keeps a project's folder where it is until it's dropped: a task's worktree is being set up
/// in it, and stored once it is.
pub struct Holding {
    s: Shared,
    project_id: String,
}

impl Drop for Holding {
    fn drop(&mut self) {
        let mut r = self.s.relocating.lock().unwrap();
        if let Some(n) = r.holds.get_mut(&self.project_id) {
            *n -= 1;
            if *n == 0 {
                r.holds.remove(&self.project_id);
            }
        }
    }
}

/// Holds project `project_id`'s folder where it is (see Holding), once a move under way is done.
pub async fn hold(s: &Shared, project_id: &str) -> Holding {
    loop {
        settled(s, project_id).await;
        let mut r = s.relocating.lock().unwrap();
        if !r.moving.contains(project_id) {
            *r.holds.entry(project_id.to_string()).or_default() += 1;
            return Holding { s: s.clone(), project_id: project_id.to_string() };
        }
    }
}

/// Waits while project `project_id`'s folder is moving, so what's read of the project
/// afterwards says where it is. An agent that started before is running, so the folder won't
/// move from under it (see check_move).
pub async fn settled(s: &Shared, project_id: &str) {
    let moving = s.relocating.lock().unwrap().moving.contains(project_id);
    if moving {
        drop(s.project_changes.lock().await);
    }
}

#[cfg(test)]
mod tests;
