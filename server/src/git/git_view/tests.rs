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
    let repo = crate::testing::temp_dir();
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

// HA-42: a project folder inside a bigger repository (a home folder kept as a dotfiles
// repository) staged, stashed and reset that whole repository.
#[test]
fn a_folder_inside_a_bigger_repository_is_all_that_is_touched() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let home = crate::testing::temp_dir();
        let proj = home.join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        sh(&home, &["init", "-q", "-b", "master"]);
        sh(&home, &["config", "user.name", "t"]);
        sh(&home, &["config", "user.email", "t@t"]);
        std::fs::write(home.join(".bashrc"), "rc\n").unwrap();
        std::fs::write(proj.join("a.txt"), "a\n").unwrap();
        sh(&home, &["add", "."]);
        sh(&home, &["commit", "-qm", "dotfiles"]);
        std::fs::write(home.join(".bashrc"), "rc\nmine\n").unwrap();
        sh(&home, &["commit", "-qam", "outside only"]);
        let b = CreateProject { name: "x".into(), repo_path: path_str(&proj), key: Some("X".into()), base_branch: None, use_worktrees: Some(false) };
        let p = create_project_inner(&s, &profile.id, b).await.unwrap();
        let id = create_task_inner(&s, &p.id, CreateTask { title: "Do it".into(), ..Default::default() }).unwrap().id;
        let at = |s: &Shared| (State(s.clone()), UrlPath(id.clone()));
        std::fs::write(home.join(".bashrc"), "rc\nmine\nmore\n").unwrap();
        std::fs::write(proj.join("a.txt"), "a\nb\n").unwrap();

        // Only the folder's files and commits.
        let st = get_status(&s, &id).await;
        assert_eq!(st["folder"], "proj/");
        let files: Vec<_> = st["files"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap().to_string()).collect();
        assert_eq!(files, ["proj/a.txt"]);
        let subjects: Vec<_> = st["commits"].as_array().unwrap().iter().map(|c| c["subject"].as_str().unwrap().to_string()).collect();
        assert_eq!(subjects, ["dotfiles"]);
        // Staging everything stages the folder's; files outside it can't be named.
        let _ = stage(at(&s).0, at(&s).1, paths(&[])).await.unwrap();
        assert_eq!(sh(&home, &["diff", "--cached", "--name-only"]), "proj/a.txt\n");
        assert_eq!(stage(at(&s).0, at(&s).1, paths(&[".bashrc"])).await.unwrap_err().0, StatusCode::BAD_REQUEST);
        let discarded = discard(at(&s).0, at(&s).1, Json(Discard { paths: vec![".bashrc".into()], staged: true })).await;
        assert_eq!(discarded.unwrap_err().0, StatusCode::BAD_REQUEST);
        let rc = sh(&home, &["diff", "--", ".bashrc"]);
        let err = apply(at(&s).0, at(&s).1, Json(Apply { patch: rc.clone(), cached: true, reverse: false })).await.unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST, "{}", err.1);
        let renamed = "diff --git a/proj/a.txt b/.profile\nsimilarity index 100%\nrename from proj/a.txt\nrename to .profile\n";
        assert_eq!(apply(at(&s).0, at(&s).1, Json(Apply { patch: renamed.into(), cached: true, reverse: false })).await.unwrap_err().0, StatusCode::BAD_REQUEST);
        // What would act on the whole repository is refused.
        let head = sh(&home, &["rev-parse", "HEAD"]).trim().to_string();
        let first = sh(&home, &["rev-parse", "HEAD~"]).trim().to_string();
        assert_eq!(reset(at(&s).0, at(&s).1, Json(Reset { rev: first, mode: "hard".into() })).await.unwrap_err().0, StatusCode::CONFLICT);
        let push = Stash { action: "push".into(), mode: None, message: String::new(), index: None, sha: None };
        assert_eq!(stash(at(&s).0, at(&s).1, Json(push)).await.unwrap_err().0, StatusCode::CONFLICT);
        let amend = Commit { message: String::new(), amend: true, reword: false };
        assert_eq!(commit(at(&s).0, at(&s).1, Json(amend)).await.unwrap_err().0, StatusCode::CONFLICT);
        // A commit would take what's staged outside the folder too.
        sh(&home, &["add", ".bashrc"]);
        let c = commit(at(&s).0, at(&s).1, Json(Commit { message: "a".into(), amend: false, reword: false })).await.unwrap_err();
        assert!(c.0 == StatusCode::CONFLICT && c.1.contains(".bashrc"), "{}", c.1);
        sh(&home, &["reset", "-q", "--", ".bashrc"]);
        let _ = commit(at(&s).0, at(&s).1, Json(Commit { message: "a".into(), amend: false, reword: false })).await.unwrap();
        assert_eq!(sh(&home, &["show", "--name-only", "--format=", "HEAD"]), "proj/a.txt\n");
        assert_eq!(sh(&home, &["rev-parse", "HEAD~"]).trim(), head);
        assert_eq!(std::fs::read_to_string(home.join(".bashrc")).unwrap(), "rc\nmine\nmore\n");
        std::fs::remove_dir_all(&home).ok();
    })
}

#[test]
fn unstages_before_the_first_commit() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let repo = crate::testing::temp_dir();
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
