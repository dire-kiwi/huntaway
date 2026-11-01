//! Disk usage analytics: how much space each project's repository, task worktrees, scratch
//! folders and agents' runs take up on this host, and the database.
//!
//! Sizes are what the files take on disk (allocated blocks, like `du`), each hard-linked file
//! counted once per folder. Nothing is cached: the folders are walked when the report is asked
//! for, several at a time.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use axum::Json;
use axum::extract::{Path as UrlPath, State};
use rusqlite::Connection;
use serde::Serialize;

use crate::db;
use crate::state::{ApiResult, Shared};
use crate::util::path_str;

#[derive(Serialize, Debug, Clone, Copy, Default, PartialEq)]
pub struct Size {
    pub bytes: u64,
    pub files: u64,
}

impl Size {
    fn add(self, o: Size) -> Size {
        Size { bytes: self.bytes + o.bytes, files: self.files + o.files }
    }
}

#[derive(Serialize, Debug)]
pub struct Worktree {
    /// None for a worktree of the project's repository in its worktrees folder that no task or
    /// project on the host has (left behind by a failed teardown, say).
    pub task_id: Option<String>,
    pub kind: Option<String>,
    pub number: Option<i64>,
    pub title: Option<String>,
    pub status: Option<String>,
    pub path: String,
    pub size: Size,
}

#[derive(Serialize, Debug)]
pub struct ProjectUsage {
    pub id: String,
    pub name: String,
    pub key: String,
    pub repo_path: String,
    /// The repository folder, worktrees and the data dir inside it aside. None when it's gone.
    pub repo: Option<Size>,
    /// The part of `repo` in its `.git` folder.
    pub git: Option<Size>,
    /// Biggest first.
    pub worktrees: Vec<Worktree>,
    /// The project's scratch folder and the rest of its folder in the data dir.
    pub other: Size,
    /// The folders of its tasks' runs (see runs.rs), kept `runs::KEEP_DAYS` after they finish (API 59).
    pub runs: Size,
}

#[derive(Serialize, Debug)]
pub struct Filesystem {
    pub total: u64,
    pub free: u64,
}

#[derive(Serialize, Debug)]
pub struct Report {
    pub projects: Vec<ProjectUsage>,
    /// The profile's own scratch folder (scratch chats and group tasks).
    pub scratch: Size,
    /// The folders of the runs of the profile's tasks in no project (API 59).
    pub runs: Size,
    /// How many days a finished run's folder is kept (API 59).
    pub runs_kept_days: i64,
    /// What the host's database takes up, all profiles' data together (API 59).
    pub database: Option<u64>,
    /// The disk the data dir (and so, usually, the worktrees) is on.
    pub filesystem: Option<Filesystem>,
    pub elapsed_ms: u64,
}

/// `GET /profiles/{id}/disk-usage`: the profile's projects' disk usage on this host.
pub async fn get(State(s): State<Shared>, UrlPath(profile_id): UrlPath<String>) -> ApiResult<Json<Report>> {
    // Only the reading is done under the database lock: looking at the folders can take a while.
    let rows = read(&s.db(), &profile_id)?;
    let data_dir = s.data_dir.clone();
    let report = tokio::task::spawn_blocking(move || measure(plan(rows, &data_dir), &data_dir)).await.map_err(anyhow::Error::from)?;
    Ok(Json(report))
}

/// A folder to measure, leaving out the folders under it that are measured on their own.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct Walk {
    root: PathBuf,
    skip: Vec<PathBuf>,
}

struct TaskRow {
    id: String,
    kind: String,
    number: i64,
    title: String,
    status: String,
    path: PathBuf,
}

struct ProjectPlan {
    project: db::Project,
    repo: Walk,
    git: Walk,
    tasks: Vec<TaskRow>,
    /// Worktrees of the repository in the worktrees folder that nothing on the host has.
    stray: Vec<PathBuf>,
    other: Vec<Walk>,
    runs: Vec<PathBuf>,
}

/// What `plan` needs from the database.
struct Rows {
    /// The worktrees of all tasks on the host, and all projects' repositories.
    owned: Vec<String>,
    /// The profile's runs, with their tasks' projects.
    runs: Vec<(String, Option<String>)>,
    /// The profile's projects, in the order analytics lists them, with their tasks that have worktrees.
    projects: Vec<(db::Project, Vec<TaskRow>)>,
    profile_id: String,
    /// The main database's file (blank in memory).
    database: String,
}

struct Plan {
    projects: Vec<ProjectPlan>,
    scratch: Walk,
    /// The runs of the profile's tasks in no project.
    runs: Vec<PathBuf>,
    /// The database's files.
    database: Vec<PathBuf>,
}

/// `inner` is `outer` or inside it.
fn within(inner: &Path, outer: &Path) -> bool {
    inner.starts_with(outer)
}

/// The folders under `root` (not `root` itself) among `others`.
fn nested(root: &Path, others: &[&Path]) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = others.iter().filter(|o| within(o, root) && **o != root).map(|o| o.to_path_buf()).collect();
    v.sort();
    v.dedup();
    v
}

/// Reads what `plan` needs from the database.
fn read(c: &Connection, profile_id: &str) -> anyhow::Result<Rows> {
    let mut st = c.prepare(
        "SELECT id, kind, number, title, status, worktree_path FROM tasks
         WHERE project_id=?1 AND worktree_path IS NOT NULL AND worktree_path<>'' ORDER BY number",
    )?;
    // Folders a task or project on this host has, whatever its profile: the worktrees folder is
    // a setting, so projects can share one (or point it at the folder their repos are in).
    let owned = c
        .prepare("SELECT worktree_path FROM tasks WHERE worktree_path IS NOT NULL AND worktree_path<>'' UNION SELECT repo_path FROM projects")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let runs = c
        .prepare("SELECT r.id, t.project_id FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.profile_id=?1")?
        .query_map([profile_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut list = db::list_projects(c, profile_id)?;
    // In the order analytics lists them, which the UI's colours follow.
    list.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    let mut projects = Vec::new();
    for p in list {
        let tasks = st
            .query_map([&p.id], |r| {
                Ok(TaskRow {
                    id: r.get(0)?,
                    kind: r.get(1)?,
                    number: r.get(2)?,
                    title: r.get(3)?,
                    status: r.get(4)?,
                    path: PathBuf::from(r.get::<_, String>(5)?),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        projects.push((p, tasks));
    }
    let database: String = c.query_row("SELECT file FROM pragma_database_list WHERE name='main'", [], |r| r.get(0))?;
    Ok(Rows { owned, runs, projects, profile_id: profile_id.to_string(), database })
}

/// Works out what to walk, from what's in the database and the worktrees folders' listings.
fn plan(rows: Rows, data_dir: &Path) -> Plan {
    let owned: HashSet<PathBuf> = rows.owned.iter().map(|p| canonical(Path::new(p))).collect();
    // Each run's folder, by its task's project.
    let mut runs: HashMap<Option<String>, Vec<PathBuf>> = HashMap::new();
    for (id, project) in rows.runs {
        let dir = data_dir.join("runs").join(id);
        if dir.is_dir() {
            runs.entry(project).or_default().push(dir);
        }
    }
    let mut projects = Vec::new();
    for (p, tasks) in rows.projects {
        let tasks: Vec<TaskRow> = tasks.into_iter().filter(|t| t.path.is_dir()).collect();
        let worktrees_root = PathBuf::from(&p.worktrees_root);
        let repo = PathBuf::from(&p.repo_path);
        let mut stray: Vec<PathBuf> = match git_common_dir(&repo) {
            Some(common) => std::fs::read_dir(&worktrees_root)
                .into_iter()
                .flatten()
                .flatten()
                .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
                .map(|e| e.path())
                .filter(|d| !owned.contains(&canonical(d)) && is_linked_worktree_of(d, &common))
                .collect(),
            None => vec![],
        };
        stray.sort();

        let project_dir = data_dir.join("projects").join(&p.id);
        let scratch = PathBuf::from(&p.scratch_path);
        let wt_paths: Vec<&Path> = tasks.iter().map(|t| t.path.as_path()).chain(stray.iter().map(|p| p.as_path())).collect();
        // Everything measured on its own, so the folders that hold them leave them out.
        let mut separate: Vec<&Path> = wt_paths.clone();
        separate.extend([worktrees_root.as_path(), data_dir, project_dir.as_path(), scratch.as_path()]);
        let git_dir = repo.join(".git");
        let mut repo_skip = nested(&repo, &separate);
        repo_skip.push(git_dir.clone());
        let in_project_dir: Vec<&Path> = wt_paths.iter().copied().chain([worktrees_root.as_path()]).collect();
        let mut other = vec![Walk { root: project_dir.clone(), skip: nested(&project_dir, &in_project_dir) }];
        if !within(&scratch, &project_dir) {
            other.push(Walk { root: scratch.clone(), skip: nested(&scratch, &wt_paths) });
        }
        projects.push(ProjectPlan {
            repo: Walk { root: repo, skip: repo_skip },
            git: Walk { skip: nested(&git_dir, &separate), root: git_dir },
            tasks,
            stray,
            other,
            runs: runs.remove(&Some(p.id.clone())).unwrap_or_default(),
            project: p,
        });
    }
    let scratch = data_dir.join("profiles").join(&rows.profile_id).join("scratch");
    // The main database's file (none in memory), and its write-ahead log.
    let file = rows.database;
    let database = if file.is_empty() { vec![] } else { vec![PathBuf::from(&file), PathBuf::from(format!("{file}-wal"))] };
    Plan { projects, scratch: Walk { root: scratch, skip: vec![] }, runs: runs.remove(&None).unwrap_or_default(), database }
}

/// The path with symlinks resolved, or as given when it can't be.
fn canonical(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// The git dir of the checkout at `dir`: its `.git` folder, or where its `.git` file points.
fn git_dir(dir: &Path) -> Option<PathBuf> {
    let dot_git = dir.join(".git");
    let meta = std::fs::symlink_metadata(&dot_git).ok()?;
    if meta.is_dir() {
        return std::fs::canonicalize(&dot_git).ok();
    }
    let text = std::fs::read_to_string(&dot_git).ok()?;
    let target = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
    std::fs::canonicalize(dir.join(target)).ok()
}

/// The repository's own git dir (the one its linked worktrees share), from a checkout's git dir.
fn common_dir(git_dir: &Path) -> PathBuf {
    match std::fs::read_to_string(git_dir.join("commondir")) {
        Ok(c) => canonical(&git_dir.join(c.trim())),
        Err(_) => git_dir.to_path_buf(),
    }
}

fn git_common_dir(repo: &Path) -> Option<PathBuf> {
    git_dir(repo).map(|d| common_dir(&d))
}

/// `dir` is a linked worktree (not a main checkout) of the repository whose git dir is `common`.
fn is_linked_worktree_of(dir: &Path, common: &Path) -> bool {
    match git_dir(dir) {
        Some(g) => g.starts_with(common.join("worktrees")) && common_dir(&g) == common,
        None => false,
    }
}

/// Walks every folder in the plan, a few at a time.
fn measure(plan: Plan, data_dir: &Path) -> Report {
    let started = Instant::now();
    let leaf = |root: &Path| Walk { root: root.to_path_buf(), skip: vec![] };
    let mut walks: Vec<Walk> = vec![plan.scratch.clone()];
    for p in &plan.projects {
        walks.extend([p.repo.clone(), p.git.clone()]);
        walks.extend(p.tasks.iter().map(|t| leaf(&t.path)));
        walks.extend(p.stray.iter().map(|s| leaf(s)));
        walks.extend(p.other.iter().cloned());
        walks.extend(p.runs.iter().map(|r| leaf(r)));
    }
    walks.extend(plan.runs.iter().map(|r| leaf(r)));
    let sizes = walk_all(walks);
    let size = |w: &Walk| sizes.get(w).copied().flatten();
    let runs = |dirs: &[PathBuf]| dirs.iter().filter_map(|d| size(&leaf(d))).fold(Size::default(), Size::add);

    let projects = plan
        .projects
        .iter()
        .map(|p| {
            let git = size(&p.git);
            let mut worktrees: Vec<Worktree> = p
                .tasks
                .iter()
                .map(|t| Worktree {
                    task_id: Some(t.id.clone()),
                    kind: Some(t.kind.clone()),
                    number: Some(t.number),
                    title: Some(t.title.clone()),
                    status: Some(t.status.clone()),
                    path: path_str(&t.path),
                    size: size(&leaf(&t.path)).unwrap_or_default(),
                })
                .chain(p.stray.iter().map(|s| Worktree {
                    task_id: None,
                    kind: None,
                    number: None,
                    title: None,
                    status: None,
                    path: path_str(s),
                    size: size(&leaf(s)).unwrap_or_default(),
                }))
                .collect();
            worktrees.sort_by(|a, b| b.size.bytes.cmp(&a.size.bytes));
            ProjectUsage {
                id: p.project.id.clone(),
                name: p.project.name.clone(),
                key: p.project.key.clone(),
                repo_path: p.project.repo_path.clone(),
                repo: size(&p.repo).map(|r| r.add(git.unwrap_or_default())),
                git,
                worktrees,
                other: p.other.iter().filter_map(size).fold(Size::default(), Size::add),
                runs: runs(&p.runs),
            }
        })
        .collect();
    Report {
        projects,
        scratch: size(&plan.scratch).unwrap_or_default(),
        runs: runs(&plan.runs),
        runs_kept_days: crate::runs::KEEP_DAYS,
        database: (!plan.database.is_empty())
            .then(|| plan.database.iter().filter_map(|f| std::fs::metadata(f).ok()).map(|m| allocated(&m)).sum()),
        filesystem: filesystem(data_dir),
        elapsed_ms: started.elapsed().as_millis() as u64,
    }
}

/// Sizes of each distinct walk, None for a folder that isn't there.
fn walk_all(mut walks: Vec<Walk>) -> HashMap<Walk, Option<Size>> {
    walks.sort_by(|a, b| a.root.cmp(&b.root));
    walks.dedup();
    let next = AtomicUsize::new(0);
    let out = Mutex::new(HashMap::new());
    let threads = std::thread::available_parallelism().map_or(2, |n| n.get()).clamp(1, 8).min(walks.len().max(1));
    std::thread::scope(|sc| {
        for _ in 0..threads {
            sc.spawn(|| {
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some(w) = walks.get(i) else { break };
                    let size = dir_size(&w.root, &w.skip);
                    out.lock().unwrap().insert(w.clone(), size);
                }
            });
        }
    });
    out.into_inner().unwrap()
}

/// What `root` takes up on disk, leaving out `skip` (and what's under it). Symlinks aren't
/// followed; unreadable folders count as empty.
fn dir_size(root: &Path, skip: &[PathBuf]) -> Option<Size> {
    let meta = std::fs::symlink_metadata(root).ok()?;
    if !meta.is_dir() {
        return None;
    }
    let mut seen = HashSet::new();
    let mut total = Size::default();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let Ok(m) = e.metadata() else { continue };
            if m.is_dir() {
                let p = e.path();
                if !skip.iter().any(|s| *s == p) {
                    stack.push(p);
                }
                total.bytes += allocated(&m);
                continue;
            }
            if !first_link(&m, &mut seen) {
                continue;
            }
            total.bytes += allocated(&m);
            total.files += 1;
        }
    }
    Some(total)
}

#[cfg(unix)]
fn allocated(m: &std::fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    m.blocks() * 512
}

#[cfg(not(unix))]
fn allocated(m: &std::fs::Metadata) -> u64 {
    m.len()
}

/// False for a hard link to a file already counted.
#[cfg(unix)]
fn first_link(m: &std::fs::Metadata, seen: &mut HashSet<(u64, u64)>) -> bool {
    use std::os::unix::fs::MetadataExt;
    m.nlink() <= 1 || seen.insert((m.dev(), m.ino()))
}

#[cfg(not(unix))]
fn first_link(_: &std::fs::Metadata, _: &mut HashSet<(u64, u64)>) -> bool {
    true
}

#[cfg(unix)]
fn filesystem(dir: &Path) -> Option<Filesystem> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `c` is a valid C string and `st` a writable statvfs.
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return None;
    }
    let frsize = st.f_frsize as u64;
    Some(Filesystem { total: st.f_blocks as u64 * frsize, free: st.f_bavail as u64 * frsize })
}

#[cfg(not(unix))]
fn filesystem(_: &Path) -> Option<Filesystem> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(p: &Path, bytes: usize) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, vec![b'x'; bytes]).unwrap();
    }

    #[test]
    fn sizes_skip_nested_folders_and_count_hard_links_once() {
        let tmp = crate::testing::temp_dir();
        let root = tmp.join("r");
        write(&root.join("a"), 10_000);
        write(&root.join("sub/b"), 10_000);
        write(&root.join("skipme/c"), 50_000);
        std::fs::hard_link(root.join("a"), root.join("sub/a-link")).unwrap();
        let all = dir_size(&root, &[]).unwrap();
        let part = dir_size(&root, &[root.join("skipme")]).unwrap();
        assert_eq!(all.files, 3);
        assert_eq!(part.files, 2);
        assert!(part.bytes >= 20_000 && part.bytes < all.bytes, "{part:?} {all:?}");
        assert_eq!(dir_size(&tmp.join("missing"), &[]), None);
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn reports_repos_worktrees_and_stray_folders() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let tmp = crate::testing::temp_dir();
            let repo = tmp.join("repo");
            write(&repo.join("src/main.rs"), 8_000);
            write(&repo.join(".git/objects/pack"), 40_000);
            let pid = {
                let c = s.db();
                let profile = db::insert_profile(&c, "me", &[], None).unwrap().id;
                let wts = tmp.join("data/projects/p1/worktrees");
                db::insert_project(
                    &c,
                    db::NewProject {
                        id: "p1",
                        profile_id: &profile,
                        name: "Proj",
                        key: "PRJ",
                        repo_path: &path_str(&repo),
                        scratch_path: &path_str(&tmp.join("data/projects/p1/scratch")),
                        worktrees_root: &path_str(&wts),
                        base_branch: None,
                        use_worktrees: true,
                    },
                )
                .unwrap();
                write(&wts.join("1-one/big"), 100_000);
                fake_worktree(&repo, &wts.join("old"), 20_000);
                // Not a worktree, so not the project's to clear up.
                write(&wts.join("notes/todo"), 1_000);
                write(&tmp.join("data/projects/p1/scratch/notes"), 4_000);
                c.execute(
                    "INSERT INTO tasks (id, profile_id, project_id, kind, number, title, status, worktree_path,
                       last_activity_at, created_at, updated_at)
                     VALUES ('t1', ?1, 'p1', 'task', 1, 'One', 'done', ?2, '', '', ''),
                       ('t2', ?1, 'p1', 'task', 2, 'Gone', 'todo', ?3, '', '', '')",
                    rusqlite::params![profile, path_str(&wts.join("1-one")), path_str(&wts.join("2-gone"))],
                )
                .unwrap();
                // Runs of its tasks, and of a scratch task in no project.
                c.execute(
                    "INSERT INTO tasks (id, profile_id, project_id, kind, number, title, status, last_activity_at, created_at, updated_at)
                     VALUES ('t3', ?1, NULL, 'scratch', 3, 'Chat', 'todo', '', '', '')",
                    [&profile],
                )
                .unwrap();
                c.execute(
                    "INSERT INTO runs (id, task_id, kind, status, created_at) VALUES ('r1', 't1', 'prompt', 'exited', ''),
                       ('r2', 't1', 'prompt', 'exited', ''), ('r3', 't3', 'prompt', 'exited', ''), ('r4', 't2', 'prompt', 'exited', '')",
                    [],
                )
                .unwrap();
                write(&tmp.join("data/runs/r1/out.jsonl"), 30_000);
                write(&tmp.join("data/runs/r2/out.jsonl"), 1_000);
                write(&tmp.join("data/runs/r2/err.log"), 1_000);
                write(&tmp.join("data/runs/r3/out.jsonl"), 5_000);
                profile
            };
            let plan = plan(read(&s.db(), &pid).unwrap(), &tmp.join("data"));
            let r = measure(plan, &tmp.join("data"));
            assert_eq!(r.projects.len(), 1);
            let p = &r.projects[0];
            assert_eq!(p.repo.unwrap().files, 3);
            // The pack, and the stray worktree's commondir.
            assert_eq!(p.git.unwrap().files, 2);
            assert!(p.git.unwrap().bytes >= 40_000);
            let wts: Vec<_> = p.worktrees.iter().map(|w| (w.task_id.as_deref(), w.size.files)).collect();
            assert_eq!(wts, vec![(Some("t1"), 1), (None, 2)]);
            assert!(p.worktrees[0].size.bytes >= 100_000);
            assert_eq!(p.other.files, 1);
            // r4's folder is gone.
            assert_eq!(p.runs.files, 3);
            assert!(p.runs.bytes >= 32_000);
            assert_eq!(r.runs.files, 1);
            assert_eq!((r.runs_kept_days, r.database), (crate::runs::KEEP_DAYS, None));
            std::fs::remove_dir_all(&tmp).unwrap();
        })
    }

    /// A linked worktree of `repo` at `dir`, as `git worktree add` leaves it, holding `bytes`.
    fn fake_worktree(repo: &Path, dir: &Path, bytes: usize) {
        let name = dir.file_name().unwrap().to_str().unwrap();
        write(&repo.join(".git/worktrees").join(name).join("commondir"), 0);
        std::fs::write(repo.join(".git/worktrees").join(name).join("commondir"), "../..\n").unwrap();
        write(&dir.join("file"), bytes);
        std::fs::write(dir.join(".git"), format!("gitdir: {}\n", path_str(&repo.join(".git/worktrees").join(name)))).unwrap();
    }

    #[test]
    fn shared_worktrees_folders_only_count_unowned_worktrees_of_the_repo_as_stray() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let tmp = crate::testing::temp_dir();
            // One folder holds both repos and both projects' worktrees.
            let shared = tmp.join("code");
            let (repo_a, repo_b) = (shared.join("a"), shared.join("b"));
            write(&repo_a.join(".git/HEAD"), 10);
            write(&repo_b.join(".git/HEAD"), 10);
            fake_worktree(&repo_a, &shared.join("a-1"), 1_000);
            fake_worktree(&repo_b, &shared.join("b-1"), 1_000);
            fake_worktree(&repo_a, &shared.join("a-old"), 1_000);
            let profile_a = {
                let c = s.db();
                let profile_a = db::insert_profile(&c, "me", &[], None).unwrap().id;
                let profile_b = db::insert_profile(&c, "work", &[], None).unwrap().id;
                for (id, profile, repo, key) in [("pa", &profile_a, &repo_a, "A"), ("pb", &profile_b, &repo_b, "B")] {
                    db::insert_project(
                        &c,
                        db::NewProject {
                            id,
                            profile_id: profile,
                            name: key,
                            key,
                            repo_path: &path_str(repo),
                            scratch_path: &path_str(&tmp.join("data/projects").join(id).join("scratch")),
                            worktrees_root: &path_str(&shared),
                            base_branch: None,
                            use_worktrees: true,
                        },
                    )
                    .unwrap();
                }
                c.execute(
                    "INSERT INTO tasks (id, profile_id, project_id, kind, number, title, status, worktree_path,
                       last_activity_at, created_at, updated_at)
                     VALUES ('ta', ?1, 'pa', 'task', 1, 'A one', 'in_progress', ?3, '', '', ''),
                       ('tb', ?2, 'pb', 'task', 1, 'B one', 'in_progress', ?4, '', '', '')",
                    rusqlite::params![profile_a, profile_b, path_str(&shared.join("a-1")), path_str(&shared.join("b-1"))],
                )
                .unwrap();
                profile_a
            };
            let r = measure(plan(read(&s.db(), &profile_a).unwrap(), &tmp.join("data")), &tmp.join("data"));
            let mut wts: Vec<_> = r.projects[0].worktrees.iter().map(|w| (w.task_id.clone(), path_str(Path::new(&w.path)))).collect();
            wts.sort();
            assert_eq!(wts, vec![(None, path_str(&shared.join("a-old"))), (Some("ta".into()), path_str(&shared.join("a-1")))]);
            std::fs::remove_dir_all(&tmp).unwrap();
        })
    }
}
