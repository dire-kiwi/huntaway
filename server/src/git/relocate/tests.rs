use std::process::Stdio;

use serde_json::{Map, Value};

use super::*;
use crate::api::{CreateProject, CreateTask, create_project_inner, create_task_inner, update_project_inner};
use crate::testing;

fn sh(dir: &Path, args: &[&str]) {
    let ok = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "user.name=t", "-c", "user.email=t@t"])
        .args(args)
        .stdout(Stdio::null())
        .status()
        .unwrap()
        .success();
    assert!(ok, "git {args:?}");
}

fn temp(name: &str) -> PathBuf {
    let dir = crate::testing::temp_dir();
    dir.canonicalize().unwrap().join(name)
}

fn repo(path: &Path) {
    std::fs::create_dir_all(path).unwrap();
    sh(path, &["init", "-q", "-b", "master"]);
    // (Unlike another made in the same second, which would be the same commit.)
    sh(path, &["commit", "-q", "--allow-empty", "-m", &format!("init {}", path.display())]);
}

/// A project in a new repository at `<tmp>/<name>`, with a task in a worktree.
async fn project_with_worktree(s: &Shared, name: &str) -> (Project, Task) {
    project_with_worktree_in(s, name, None).await
}

/// … in the repository's folder `worktrees` (in the board's data otherwise).
async fn project_with_worktree_in(s: &Shared, name: &str, worktrees: Option<&str>) -> (Project, Task) {
    let p = git_project(s, name).await;
    let p = match worktrees {
        Some(w) => db::update_project(&s.db(), &p.id, &[("worktrees_root", json!(path_str(&Path::new(&p.repo_path).join(w))))]).unwrap().unwrap(),
        None => p,
    };
    let t = create_task_inner(s, &p.id, CreateTask { title: "Do it".into(), ..Default::default() }).unwrap();
    let t = worktree::setup(s, &t.id).await.unwrap();
    (p, t)
}

/// A project in a new repository at `<tmp>/<name>`.
async fn git_project(s: &Shared, name: &str) -> Project {
    let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
    let path = temp(name);
    repo(&path);
    let b = CreateProject { name: name.into(), repo_path: path_str(&path), key: Some("X".into()), base_branch: Some("master".into()), use_worktrees: None };
    create_project_inner(s, &profile.id, b).await.unwrap()
}

/// A Claude config in a new folder, and a thread of `t`'s in it that ran in `cwd`.
fn conversation(s: &Shared, t: &Task, cwd: &Path) -> PathBuf {
    let config_dir = temp("claude");
    let config = db::insert_claude_config(&s.db(), "Claude", &path_str(&config_dir), "claude").unwrap();
    db::update_task(&s.db(), &t.id, &[("session_id", json!("s1")), ("claude_config_id", json!(config.id))]).unwrap();
    let dir = config_dir.join("projects").join(claude_project_dir(cwd));
    std::fs::create_dir_all(dir.join("s1/subagents")).unwrap();
    std::fs::write(dir.join("s1.jsonl"), "{}\n").unwrap();
    std::fs::write(dir.join("s1/subagents/a.jsonl"), "{}\n").unwrap();
    config_dir
}

fn has_conversation(config_dir: &Path, cwd: &Path) -> bool {
    let dir = config_dir.join("projects").join(claude_project_dir(cwd));
    dir.join("s1.jsonl").exists() && dir.join("s1/subagents/a.jsonl").exists()
}

async fn update(s: &Shared, p: &Project, body: Value) -> ApiResult<Project> {
    let body: Map<String, Value> = body.as_object().unwrap().clone();
    update_project_inner(s, &p.id, &body).await
}

fn works(wt: &str) -> bool {
    std::process::Command::new("git").arg("-C").arg(wt).args(["status", "--short"]).output().unwrap().status.success()
}

#[test]
fn moves_the_folder_and_reconnects_its_worktrees() {
    testing::run(async || {
        let s = testing::state();
        let (p, t) = project_with_worktree(&s, "os-sandbox").await;
        let wt = t.worktree_path.clone().unwrap();
        let old = PathBuf::from(&p.repo_path);
        let new = old.with_file_name("omarchy-sandbox");

        // Not over another folder, and not without a path to move to.
        std::fs::create_dir_all(&new).unwrap();
        let e = update(&s, &p, json!({"repo_path": path_str(&new), "move_repo": true})).await.unwrap_err();
        assert!(e.1.contains("already exists"), "{}", e.1);
        std::fs::remove_dir(&new).unwrap();
        let e = update(&s, &p, json!({"name": "omarchy-sandbox", "move_repo": true})).await.unwrap_err();
        assert!(e.1.contains("needs a new repo_path"), "{}", e.1);

        let moved = update(&s, &p, json!({"name": "omarchy-sandbox", "repo_path": path_str(&new), "move_repo": true})).await.unwrap();
        assert_eq!((moved.name.as_str(), moved.repo_path.as_str()), ("omarchy-sandbox", path_str(&new).as_str()));
        assert!(!old.exists() && new.join(".git").is_dir());
        assert!(works(&wt));
        assert!(std::fs::read_to_string(Path::new(&wt).join(".git")).unwrap().contains(&path_str(&new)));
    });
}

#[test]
fn points_at_a_folder_moved_elsewhere() {
    testing::run(async || {
        let s = testing::state();
        let (p, t) = project_with_worktree(&s, "os-sandbox").await;
        let wt = t.worktree_path.clone().unwrap();
        let old = PathBuf::from(&p.repo_path);
        let new = old.with_file_name("omarchy-sandbox");
        std::fs::rename(&old, &new).unwrap();
        assert!(!works(&wt));

        // Another repository, or a folder that isn't one, isn't the project's.
        let other = old.with_file_name("other");
        repo(&other);
        let e = update(&s, &p, json!({"repo_path": path_str(&other)})).await.unwrap_err();
        assert!(e.1.contains("doesn't have the task worktree"), "{}", e.1);
        let e = update(&s, &p, json!({"repo_path": path_str(&old.with_file_name("missing"))})).await.unwrap_err();
        assert!(e.1.contains("isn't a folder"), "{}", e.1);
        let e = update(&s, &p, json!({"repo_path": "relative/path"})).await.unwrap_err();
        assert!(e.1.contains("absolute"), "{}", e.1);

        let p = update(&s, &p, json!({"repo_path": path_str(&new)})).await.unwrap();
        assert_eq!(p.repo_path, path_str(&new));
        assert!(works(&wt));
    });
}

#[test]
fn points_at_a_link_target_so_the_link_can_go() {
    testing::run(async || {
        let s = testing::state();
        let (p, t) = project_with_worktree(&s, "os-sandbox").await;
        let wt = t.worktree_path.clone().unwrap();
        let old = PathBuf::from(&p.repo_path);
        let new = old.with_file_name("omarchy-sandbox");
        std::fs::rename(&old, &new).unwrap();
        std::os::unix::fs::symlink(&new, &old).unwrap();
        assert!(works(&wt));

        // While the old folder is there, only the same repository will do.
        let other = old.with_file_name("other");
        repo(&other);
        let e = update(&s, &p, json!({"repo_path": path_str(&other)})).await.unwrap_err();
        assert!(e.1.contains("isn't the project's repository"), "{}", e.1);
        let e = update(&s, &p, json!({"repo_path": path_str(&other.with_file_name("elsewhere")), "move_repo": true})).await.unwrap_err();
        assert!(e.1.contains("is a link to"), "{}", e.1);

        update(&s, &p, json!({"repo_path": path_str(&new)})).await.unwrap();
        std::fs::remove_file(&old).unwrap();
        assert!(works(&wt));
    });
}

#[test]
fn copies_conversations_that_ran_in_the_folder() {
    testing::run(async || {
        let s = testing::state();
        let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let old = temp("notes");
        std::fs::create_dir_all(&old).unwrap();
        let b = CreateProject { name: "notes".into(), repo_path: path_str(&old), key: None, base_branch: None, use_worktrees: None };
        let p = create_project_inner(&s, &profile.id, b).await.unwrap();
        let t = create_task_inner(&s, &p.id, CreateTask { title: "Write".into(), ..Default::default() }).unwrap();
        let config_dir = conversation(&s, &t, &old);

        let new = old.with_file_name("journal");
        update(&s, &p, json!({"repo_path": path_str(&new), "move_repo": true})).await.unwrap();
        assert!(has_conversation(&config_dir, &new));
        assert!(has_conversation(&config_dir, &old));
    });
}

/// Moved back to where it was, a project's conversations carry on from where they got to.
#[test]
fn brings_conversations_up_to_date_when_moving_back() {
    testing::run(async || {
        let s = testing::state();
        let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let a = temp("notes");
        std::fs::create_dir_all(&a).unwrap();
        let b = CreateProject { name: "notes".into(), repo_path: path_str(&a), key: None, base_branch: None, use_worktrees: None };
        let p = create_project_inner(&s, &profile.id, b).await.unwrap();
        let t = create_task_inner(&s, &p.id, CreateTask { title: "Write".into(), ..Default::default() }).unwrap();
        let config_dir = conversation(&s, &t, &a);
        let b = a.with_file_name("journal");
        let p = update(&s, &p, json!({"repo_path": path_str(&b), "move_repo": true})).await.unwrap();

        // It carries on at B…
        let at = |dir: &Path| config_dir.join("projects").join(claude_project_dir(dir));
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(60);
        for (f, text) in [("s1.jsonl", "{}\n{\"more\": 1}\n"), ("s1/subagents/a.jsonl", "{\"sub\": 2}\n"), ("s1/subagents/b.jsonl", "{}\n")] {
            std::fs::write(at(&b).join(f), text).unwrap();
            std::fs::File::options().write(true).open(at(&b).join(f)).unwrap().set_modified(later).unwrap();
        }
        // …and moving back to A, which has the copy from before, brings that up to date.
        update(&s, &p, json!({"repo_path": path_str(&a), "move_repo": true})).await.unwrap();
        assert_eq!(std::fs::read_to_string(at(&a).join("s1.jsonl")).unwrap(), "{}\n{\"more\": 1}\n");
        assert_eq!(std::fs::read_to_string(at(&a).join("s1/subagents/a.jsonl")).unwrap(), "{\"sub\": 2}\n");
        assert!(at(&a).join("s1/subagents/b.jsonl").exists());
    });
}

/// Worktrees kept inside the repository move with it, whether the board moves it or it was
/// moved before, and so does the worktrees folder (or new tasks would recreate the old one).
#[test]
fn worktrees_inside_the_folder_move_with_it() {
    testing::run(async || {
        for move_folder in [true, false] {
            let s = testing::state();
            let (p, t) = project_with_worktree_in(&s, "os-sandbox", Some(".worktrees")).await;
            let old_wt = PathBuf::from(t.worktree_path.clone().unwrap());
            let old = PathBuf::from(&p.repo_path);
            assert!(old_wt.starts_with(old.join(".worktrees")));
            let config_dir = conversation(&s, &t, &old_wt);
            let new = old.with_file_name("omarchy-sandbox");
            if !move_folder {
                std::fs::rename(&old, &new).unwrap();
            }

            let p = update(&s, &p, json!({"repo_path": path_str(&new), "move_repo": move_folder})).await.unwrap();
            assert_eq!(p.worktrees_root, path_str(&new.join(".worktrees")));
            let t = db::get_task(&s.db(), &t.id).unwrap().unwrap();
            let wt = new.join(old_wt.strip_prefix(&old).unwrap());
            assert_eq!(t.worktree_path.as_deref(), Some(path_str(&wt).as_str()));
            assert!(works(&path_str(&wt)), "move_folder={move_folder}");
            assert!(worktree_list(&new).await.contains(&wt));
            assert!(has_conversation(&config_dir, &wt));
            assert!(!old.exists());
        }
    });
}

/// Without worktrees to go by, a moved repository is told by the history it started from.
#[test]
fn tells_a_moved_repository_by_its_history() {
    testing::run(async || {
        let s = testing::state();
        let p = git_project(&s, "os-sandbox").await;
        assert!(p.repo_root.as_deref().is_some_and(|r| r.len() == 40));
        let old = PathBuf::from(&p.repo_path);
        let new = old.with_file_name("omarchy-sandbox");
        std::fs::rename(&old, &new).unwrap();
        let other = old.with_file_name("other");
        repo(&other);
        let plain = old.with_file_name("plain");
        std::fs::create_dir_all(&plain).unwrap();
        let e = update(&s, &p, json!({"repo_path": path_str(&other)})).await.unwrap_err();
        assert!(e.1.contains("none of the commits"), "{}", e.1);
        let e = update(&s, &p, json!({"repo_path": path_str(&plain)})).await.unwrap_err();
        assert!(e.1.contains("isn't a git repository"), "{}", e.1);
        let p = update(&s, &p, json!({"repo_path": path_str(&new)})).await.unwrap();
        assert_eq!(p.repo_path, path_str(&new));

        // When the board didn't see what was there, it can't tell.
        db::update_project(&s.db(), &p.id, &[("repo_root", Value::Null)]).unwrap();
        let p = db::get_project(&s.db(), &p.id).unwrap().unwrap();
        std::fs::rename(&new, &old).unwrap();
        let e = update(&s, &p, json!({"repo_path": path_str(&old)})).await.unwrap_err();
        assert!(e.1.contains("can't tell"), "{}", e.1);
        // It looks while the folder is there.
        std::fs::rename(&old, &new).unwrap();
        record_fingerprints(&s).await;
        let p = db::get_project(&s.db(), &p.id).unwrap().unwrap();
        assert!(p.repo_root.is_some());
        std::fs::rename(&new, &old).unwrap();
        update(&s, &p, json!({"repo_path": path_str(&old)})).await.unwrap();

        // A repository without commits isn't the one that had them.
        std::fs::rename(&old, &new).unwrap();
        let empty = old.with_file_name("empty");
        std::fs::create_dir_all(&empty).unwrap();
        sh(&empty, &["init", "-q"]);
        let e = update(&s, &p, json!({"repo_path": path_str(&empty)})).await.unwrap_err();
        assert!(e.1.contains("has no commits"), "{}", e.1);
    });
}

// HA-42: a shallow clone's history starts where it was cut off, so once the rest was fetched
// its moved folder had none of the commits the board had seen it start from.
#[test]
fn tells_a_moved_shallow_clone_once_its_history_is_fetched() {
    testing::run(async || {
        let s = testing::state();
        let upstream = temp("upstream");
        repo(&upstream);
        for n in 1..=3 {
            sh(&upstream, &["commit", "-q", "--allow-empty", "-m", &format!("commit {n}")]);
        }
        let old = temp("shallow");
        let url = format!("file://{}", path_str(&upstream));
        sh(&upstream, &["clone", "-q", "--depth", "1", &url, &path_str(&old)]);
        let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let b = CreateProject { name: "s".into(), repo_path: path_str(&old), key: Some("X".into()), base_branch: Some("master".into()), use_worktrees: None };
        let p = create_project_inner(&s, &profile.id, b).await.unwrap();
        let new = old.with_file_name("unshallowed");
        std::fs::rename(&old, &new).unwrap();
        sh(&new, &["fetch", "-q", "--unshallow"]);
        assert_ne!(fingerprint(&new).await, p.repo_root.clone().unwrap());
        let p = update(&s, &p, json!({"repo_path": path_str(&new)})).await.unwrap();
        assert_eq!(p.repo_path, path_str(&new));
    });
}

/// A repository seen before its first commit is told by its history once it has one; until
/// the board has seen that, it can't tell.
#[test]
fn a_repository_without_commits_yet_is_no_proof() {
    testing::run(async || {
        let s = testing::state();
        let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let old = temp("fresh");
        std::fs::create_dir_all(&old).unwrap();
        sh(&old, &["init", "-q", "-b", "master"]);
        let b = CreateProject { name: "fresh".into(), repo_path: path_str(&old), key: None, base_branch: None, use_worktrees: None };
        let p = create_project_inner(&s, &profile.id, b).await.unwrap();
        assert_eq!(p.repo_root.as_deref(), Some("git"));
        sh(&old, &["commit", "-q", "--allow-empty", "-m", "first"]);
        let new = old.with_file_name("moved");
        let other = old.with_file_name("other");
        repo(&other);

        std::fs::rename(&old, &new).unwrap();
        let e = update(&s, &p, json!({"repo_path": path_str(&other)})).await.unwrap_err();
        assert!(e.1.contains("can't tell"), "{}", e.1);

        std::fs::rename(&new, &old).unwrap();
        record_fingerprints(&s).await;
        let p = db::get_project(&s.db(), &p.id).unwrap().unwrap();
        assert!(p.repo_root.as_deref().is_some_and(is_history));
        std::fs::rename(&old, &new).unwrap();
        let e = update(&s, &p, json!({"repo_path": path_str(&other)})).await.unwrap_err();
        assert!(e.1.contains("none of the commits"), "{}", e.1);
        update(&s, &p, json!({"repo_path": path_str(&new)})).await.unwrap();
    });
}

/// A folder that wasn't a repository when the board looked may be one by the time it moves,
/// so that's no proof either; setting up a worktree has the board look again.
#[test]
fn a_folder_that_wasnt_a_repository_is_no_proof() {
    testing::run(async || {
        let s = testing::state();
        let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let old = temp("notes");
        std::fs::create_dir_all(&old).unwrap();
        let b = CreateProject { name: "notes".into(), repo_path: path_str(&old), key: None, base_branch: Some("master".into()), use_worktrees: None };
        let p = create_project_inner(&s, &profile.id, b).await.unwrap();
        assert_eq!(p.repo_root.as_deref(), Some(""));
        sh(&old, &["init", "-q", "-b", "master"]);
        sh(&old, &["commit", "-q", "--allow-empty", "-m", "first"]);

        let new = old.with_file_name("moved");
        std::fs::rename(&old, &new).unwrap();
        let other = old.with_file_name("other");
        repo(&other);
        let plain = old.with_file_name("plain");
        std::fs::create_dir_all(&plain).unwrap();
        for wrong in [&other, &plain] {
            let e = update(&s, &p, json!({"repo_path": path_str(wrong)})).await.unwrap_err();
            assert!(e.1.contains("can't tell"), "{}", e.1);
        }

        std::fs::rename(&new, &old).unwrap();
        let t = create_task_inner(&s, &p.id, CreateTask { title: "Do it".into(), ..Default::default() }).unwrap();
        worktree::setup(&s, &t.id).await.unwrap();
        assert!(db::get_project(&s.db(), &p.id).unwrap().unwrap().repo_root.as_deref().is_some_and(is_history));
    });
}

/// A worktree moved with its repository may have been repaired before the board is told.
#[test]
fn knows_a_worktree_repaired_before_the_board_was_told() {
    testing::run(async || {
        let s = testing::state();
        let (p, t) = project_with_worktree_in(&s, "os-sandbox", Some(".worktrees")).await;
        let old_wt = PathBuf::from(t.worktree_path.clone().unwrap());
        let old = PathBuf::from(&p.repo_path);
        let new = old.with_file_name("omarchy-sandbox");
        std::fs::rename(&old, &new).unwrap();
        let wt = new.join(old_wt.strip_prefix(&old).unwrap());
        sh(&new, &["worktree", "repair", &path_str(&wt)]);
        assert!(works(&path_str(&wt)));

        update(&s, &p, json!({"repo_path": path_str(&new)})).await.unwrap();
        let t = db::get_task(&s.db(), &t.id).unwrap().unwrap();
        assert_eq!(t.worktree_path.as_deref(), Some(path_str(&wt).as_str()));
    });
}

/// A task whose worktree was removed (once merged, say) gets its folder back when it runs
/// again, in the worktrees folder's new place, and its conversation needs to be there.
#[test]
fn copies_conversations_of_removed_worktrees_to_where_they_come_back() {
    testing::run(async || {
        let s = testing::state();
        let (p, t) = project_with_worktree_in(&s, "os-sandbox", Some(".worktrees")).await;
        let old_wt = PathBuf::from(t.worktree_path.clone().unwrap());
        let config_dir = conversation(&s, &t, &old_wt);
        let t = worktree::teardown(&s, &t.id, false, false).await.unwrap();
        assert_eq!((t.worktree_path.as_deref(), t.branch.is_some()), (None, true));
        let old = PathBuf::from(&p.repo_path);
        let new = old.with_file_name("omarchy-sandbox");

        let p = update(&s, &p, json!({"repo_path": path_str(&new), "move_repo": true})).await.unwrap();
        let wt = new.join(old_wt.strip_prefix(&old).unwrap());
        assert!(has_conversation(&config_dir, &wt));
        // Even after the key changes, it comes back there.
        update(&s, &p, json!({"key": "Y"})).await.unwrap();
        let t = worktree::setup(&s, &t.id).await.unwrap();
        assert_eq!(t.worktree_path.as_deref(), Some(path_str(&wt).as_str()));
    });
}

/// Another checkout of the same repository is another folder: the project's hasn't moved.
#[test]
fn another_checkout_of_the_repository_isnt_the_folder() {
    testing::run(async || {
        let s = testing::state();
        let (p, t) = project_with_worktree_in(&s, "os-sandbox", Some(".worktrees")).await;
        let checkout = Path::new(&p.repo_path).with_file_name("checkout");
        sh(Path::new(&p.repo_path), &["worktree", "add", "-q", "-b", "other", &path_str(&checkout)]);
        let e = update(&s, &p, json!({"repo_path": path_str(&checkout)})).await.unwrap_err();
        assert!(e.1.contains("still at"), "{}", e.1);
        let after = db::get_task(&s.db(), &t.id).unwrap().unwrap();
        assert_eq!(after.worktree_path, t.worktree_path);
        assert_eq!(db::get_project(&s.db(), &p.id).unwrap().unwrap().worktrees_root, p.worktrees_root);
    });
}

/// A review thread works in the worktree of the task it reviews.
#[test]
fn copies_a_review_threads_conversation_from_the_worktree_it_reviewed() {
    testing::run(async || {
        let s = testing::state();
        let (p, t) = project_with_worktree_in(&s, "os-sandbox", Some(".worktrees")).await;
        let old_wt = PathBuf::from(t.worktree_path.clone().unwrap());
        let review = db::insert_task(
            &s.db(),
            db::NewTask {
                profile_id: &p.profile_id,
                project_id: Some(&p.id),
                kind: "review",
                title: "Review of X-1",
                description: "",
                status: "todo",
                use_worktree: false,
                model: None,
                effort: None,
                claude_config_id: None,
            },
        )
        .unwrap();
        let review = s.update_task(&review.id, &[("parent_id", json!(t.id))]).unwrap().unwrap();
        let config_dir = conversation(&s, &review, &old_wt);
        let old = PathBuf::from(&p.repo_path);
        let new = old.with_file_name("omarchy-sandbox");

        update(&s, &p, json!({"repo_path": path_str(&new), "move_repo": true})).await.unwrap();
        assert!(has_conversation(&config_dir, &new.join(old_wt.strip_prefix(&old).unwrap())));
    });
}

#[test]
fn a_change_that_cant_be_stored_leaves_the_folder_where_it_is() {
    testing::run(async || {
        let s = testing::state();
        let (p, t) = project_with_worktree(&s, "os-sandbox").await;
        let old = PathBuf::from(&p.repo_path);
        let new = old.with_file_name("omarchy-sandbox");
        let e = update(&s, &p, json!({"repo_path": path_str(&new), "move_repo": true, "use_worktrees": null})).await.unwrap_err();
        assert!(e.1.contains("use_worktrees"), "{}", e.1);
        assert!(old.is_dir() && !new.exists());
        let now = db::get_project(&s.db(), &p.id).unwrap().unwrap();
        assert_eq!((now.repo_path, now.use_worktrees), (p.repo_path.clone(), p.use_worktrees));
        assert!(works(t.worktree_path.as_deref().unwrap()));
    });
}

#[test]
fn a_key_taken_while_the_folder_moves_isnt_taken_twice() {
    testing::run(async || {
        let s = testing::state();
        let (p, _) = project_with_worktree(&s, "os-sandbox").await;
        let b = CreateProject { name: "q".into(), repo_path: path_str(&temp("q")), key: Some("Q".into()), base_branch: None, use_worktrees: None };
        let q = create_project_inner(&s, &p.profile_id, b).await.unwrap();
        let new = PathBuf::from(&p.repo_path).with_file_name("omarchy-sandbox");
        // The second starts while the first waits on git.
        let (moving, taking) = tokio::join!(
            update(&s, &p, json!({"repo_path": path_str(&new), "move_repo": true, "key": "NEW"})),
            update(&s, &q, json!({"key": "NEW"})),
        );
        assert_eq!(moving.unwrap().key, "NEW");
        let e = taking.unwrap_err();
        assert!(e.1.contains("already has the key NEW"), "{}", e.1);
        assert_eq!(db::get_project(&s.db(), &q.id).unwrap().unwrap().key, "Q");
    });
}

#[test]
fn a_rename_while_the_folder_moves_keeps_every_old_key() {
    testing::run(async || {
        let s = testing::state();
        let (p, _) = project_with_worktree(&s, "os-sandbox").await;
        let new = PathBuf::from(&p.repo_path).with_file_name("omarchy-sandbox");
        let (moving, renaming) = tokio::join!(
            update(&s, &p, json!({"repo_path": path_str(&new), "move_repo": true, "key": "NEW"})),
            update(&s, &p, json!({"key": "MIDDLE"})),
        );
        moving.unwrap();
        renaming.unwrap();
        let now = db::get_project(&s.db(), &p.id).unwrap().unwrap();
        let mut keys: Vec<String> = now.former_keys.iter().cloned().chain([now.key.clone()]).collect();
        keys.sort();
        assert_eq!(keys, ["MIDDLE", "NEW", "X"]);
        assert_eq!(now.repo_path, path_str(&new));
    });
}

#[test]
fn submodules_checked_out_in_worktrees_keep_working() {
    testing::run(async || {
        let s = testing::state();
        let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let lib = temp("lib");
        repo(&lib);
        let old = temp("os-sandbox");
        repo(&old);
        sh(&old, &["-c", "protocol.file.allow=always", "submodule", "add", "-q", &path_str(&lib), "lib"]);
        sh(&old, &["commit", "-q", "-m", "lib"]);
        let b = CreateProject { name: "os".into(), repo_path: path_str(&old), key: Some("X".into()), base_branch: Some("master".into()), use_worktrees: None };
        let p = create_project_inner(&s, &profile.id, b).await.unwrap();
        let t = create_task_inner(&s, &p.id, CreateTask { title: "Do it".into(), ..Default::default() }).unwrap();
        let wt = PathBuf::from(worktree::setup(&s, &t.id).await.unwrap().worktree_path.unwrap());
        sh(&wt, &["-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init"]);
        assert!(works(&path_str(&wt.join("lib"))));

        let new = old.with_file_name("omarchy-sandbox");
        update(&s, &p, json!({"repo_path": path_str(&new), "move_repo": true})).await.unwrap();
        for dir in [wt.clone(), wt.join("lib"), new.join("lib")] {
            assert!(works(&path_str(&dir)), "{}", dir.display());
        }
        // Still relative, as git keeps them, so they survive the folders moving together.
        assert!(std::fs::read_to_string(new.join("lib/.git")).unwrap().starts_with("gitdir: .."));
    });
}

#[test]
fn agents_start_once_the_folder_has_moved() {
    testing::run(async || {
        let s = testing::state();
        let (p, _) = project_with_worktree(&s, "os-sandbox").await;
        let new = PathBuf::from(&p.repo_path).with_file_name("omarchy-sandbox");
        // The second starts while the first waits on git, as launching an agent would.
        let (moving, starting) = tokio::join!(update(&s, &p, json!({"repo_path": path_str(&new), "move_repo": true})), async {
            settled(&s, &p.id).await;
            db::get_project(&s.db(), &p.id).unwrap().unwrap()
        });
        moving.unwrap();
        assert_eq!(starting.repo_path, path_str(&new));
    });
}

#[test]
fn a_worktree_being_set_up_keeps_the_folder_where_it_is() {
    testing::run(async || {
        let s = testing::state();
        let (p, _) = project_with_worktree_in(&s, "os-sandbox", Some(".worktrees")).await;
        let signals = temp("signals");
        std::fs::create_dir_all(&signals).unwrap();
        let (started, go) = (signals.join("started"), signals.join("go"));
        let script = format!("touch {}; while [ ! -e {} ]; do sleep 0.05; done", started.display(), go.display());
        db::update_project(&s.db(), &p.id, &[("setup_script", json!(script))]).unwrap();
        let t = create_task_inner(&s, &p.id, CreateTask { title: "Another".into(), ..Default::default() }).unwrap();
        let new = PathBuf::from(&p.repo_path).with_file_name("omarchy-sandbox");
        let (set_up, moving) = tokio::join!(worktree::setup(&s, &t.id), async {
            while !started.exists() {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            let moving = update(&s, &p, json!({"repo_path": path_str(&new), "move_repo": true})).await;
            std::fs::write(&go, "").unwrap();
            moving
        });
        let e = moving.unwrap_err();
        assert!(e.1.contains("being set up"), "{}", e.1);
        let wt = set_up.unwrap().worktree_path.unwrap();
        assert!(wt.starts_with(&p.repo_path) && works(&wt));
        // Once it's set up, the folder moves with it.
        update(&s, &p, json!({"repo_path": path_str(&new), "move_repo": true})).await.unwrap();
        let wt = db::get_task(&s.db(), &t.id).unwrap().unwrap().worktree_path.unwrap();
        assert!(wt.starts_with(&path_str(&new)) && works(&wt));
    });
}

#[test]
fn submodules_of_a_project_that_is_a_linked_checkout_keep_working() {
    testing::run(async || {
        let s = testing::state();
        let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let lib = temp("lib");
        repo(&lib);
        let main = temp("main");
        repo(&main);
        sh(&main, &["-c", "protocol.file.allow=always", "submodule", "add", "-q", &path_str(&lib), "lib"]);
        sh(&main, &["commit", "-q", "-m", "lib"]);
        let old = main.with_file_name("linked-old");
        sh(&main, &["worktree", "add", "-q", "-b", "linked", &path_str(&old)]);
        sh(&old, &["-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init"]);
        let b = CreateProject { name: "linked".into(), repo_path: path_str(&old), key: Some("X".into()), base_branch: Some("linked".into()), use_worktrees: None };
        let p = create_project_inner(&s, &profile.id, b).await.unwrap();
        let p = db::update_project(&s.db(), &p.id, &[("worktrees_root", json!(path_str(&old.join(".worktrees"))))]).unwrap().unwrap();
        let t = create_task_inner(&s, &p.id, CreateTask { title: "Do it".into(), ..Default::default() }).unwrap();
        let wt = PathBuf::from(worktree::setup(&s, &t.id).await.unwrap().worktree_path.unwrap());
        sh(&wt, &["-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init"]);

        let new = old.with_file_name("linked-new");
        update(&s, &p, json!({"repo_path": path_str(&new), "move_repo": true})).await.unwrap();
        let wt = new.join(wt.strip_prefix(&old).unwrap());
        for dir in [new.clone(), new.join("lib"), wt.clone(), wt.join("lib"), main.clone(), main.join("lib")] {
            assert!(works(&path_str(&dir)), "{}", dir.display());
        }
    });
}
