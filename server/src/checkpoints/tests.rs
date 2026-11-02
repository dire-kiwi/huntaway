use super::*;
use crate::api::{CreateProject, CreateTask, create_project_inner, create_task_inner};
use crate::util::path_str;

fn sh(dir: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git").arg("-C").arg(dir).args(["-c", "protocol.file.allow=always"]).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).to_string()
}

fn write(dir: &Path, path: &str, text: &str) {
    let p = dir.join(path);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, text).unwrap();
}

fn read(dir: &Path, path: &str) -> Option<String> {
    std::fs::read_to_string(dir.join(path)).ok()
}

/// A task with a worktree, in a repository whose master has `f.txt`, `gone.txt` and a
/// `.gitignore` for `*.log`, reached through `repo_link` (a symlink to it) if given.
async fn task_repo(s: &Shared, link: bool) -> (Task, PathBuf, PathBuf) {
    let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
    let repo = crate::testing::temp_dir();
    sh(&repo, &["init", "-q", "-b", "master"]);
    sh(&repo, &["config", "user.name", "t"]);
    sh(&repo, &["config", "user.email", "t@t"]);
    write(&repo, "f.txt", &(1..=20).map(|i| format!("{i}\n")).collect::<String>());
    write(&repo, "gone.txt", "bye\n");
    write(&repo, ".gitignore", "*.log\n");
    sh(&repo, &["add", "."]);
    sh(&repo, &["commit", "-qm", "init"]);
    let path = if link {
        let l = crate::testing::temp_dir().join("link");
        std::os::unix::fs::symlink(&repo, &l).unwrap();
        l
    } else {
        repo.clone()
    };
    let b = CreateProject { name: "x".into(), repo_path: path_str(&path), key: Some("X".into()), base_branch: Some("master".into()), use_worktrees: None };
    let p = create_project_inner(s, &profile.id, b).await.unwrap();
    let t = create_task_inner(s, &p.id, CreateTask { title: "Do it".into(), ..Default::default() }).unwrap();
    let t = crate::worktree::setup(s, &t.id).await.unwrap();
    let wt = PathBuf::from(t.worktree_path.clone().unwrap());
    (t, wt, repo)
}

/// A run of the task that's started with a message `text`: the run and the message's id.
fn start(s: &Shared, task_id: &str, text: &str) -> (Run, i64) {
    let c = s.db();
    let run = db::insert_run(&c, task_id, "prompt").unwrap();
    let m = db::insert_message(&c, task_id, "user", &json!({"text": text})).unwrap();
    c.execute("UPDATE runs SET status='running', turn_message_id=?1, agent_at=?2 WHERE id=?3", params![m.id, format!("at-{}", m.id), run.id]).unwrap();
    (db::get_run(&c, &run.id).unwrap().unwrap(), m.id)
}

/// A turn of the agent's: its run starts (with its checkpoint), `work` changes the files, and the turn ends.
async fn turn(s: &Shared, task_id: &str, text: &str, work: impl FnOnce()) -> i64 {
    let (run, m) = start(s, task_id, text);
    let task = db::get_task(&s.db(), task_id).unwrap().unwrap();
    before_run(s, &task, &run).await;
    work();
    after_turn(s, &run.id, "done");
    settled(s, task_id).await;
    m
}

async fn get_turns(s: &Shared, id: &str) -> Value {
    turns(State(s.clone()), UrlPath(id.to_string())).await.unwrap().0
}

async fn get_diff(s: &Shared, id: &str, from: i64, to: i64) -> Value {
    diff(State(s.clone()), UrlPath(id.to_string()), Query(DiffQuery { from, to })).await.unwrap().0
}

async fn do_rewind(s: &Shared, id: &str, message_id: i64, conversation: bool, branch: bool) -> ApiResult<Value> {
    rewind(State(s.clone()), UrlPath(id.to_string()), Json(RewindBody { message_id, conversation, branch })).await.map(|j| j.0)
}

fn files(dir: &Path) -> String {
    sh(dir, &["status", "--porcelain", "--untracked-files=all"])
}

#[test]
fn a_checkpoint_leaves_the_index_branch_and_stashes_alone() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (t, wt, _) = task_repo(&s, false).await;
        write(&wt, "f.txt", "stashed\n");
        sh(&wt, &["stash", "push", "-q", "-m", "mine"]);
        write(&wt, "staged.txt", "s\n");
        sh(&wt, &["add", "staged.txt"]);
        write(&wt, "f.txt", "changed\n");
        write(&wt, "new/untracked.txt", "u\n");
        write(&wt, "build.log", "ignored\n");
        let git_dir = PathBuf::from(sh(&wt, &["rev-parse", "--absolute-git-dir"]).trim());
        let index = std::fs::read(git_dir.join("index")).unwrap();
        let before = (sh(&wt, &["rev-parse", "HEAD"]), sh(&wt, &["branch", "--show-current"]), sh(&wt, &["stash", "list", "--format=%H %gs"]), files(&wt));

        let (run, _) = start(&s, &t.id, "go");
        before_run(&s, &t, &run).await;
        let cps = list(&s.db(), &t.id).unwrap();
        assert_eq!(cps.len(), 1);
        assert_eq!((cps[0].kind.as_str(), cps[0].head.as_deref()), ("start", Some(before.0.trim())));

        assert_eq!(std::fs::read(git_dir.join("index")).unwrap(), index, "the index is untouched");
        assert_eq!((sh(&wt, &["rev-parse", "HEAD"]), sh(&wt, &["branch", "--show-current"]), sh(&wt, &["stash", "list", "--format=%H %gs"]), files(&wt)), before);
        // Everything but ignored files, as it is on disk.
        let tree = sh(&wt, &["ls-tree", "-r", "--name-only", &ref_name(&t.id, 0)]);
        assert_eq!(tree.lines().collect::<Vec<_>>(), [".gitignore", "f.txt", "gone.txt", "new/untracked.txt", "staged.txt"]);
        assert_eq!(sh(&wt, &["show", &format!("{}:f.txt", ref_name(&t.id, 0))]), "changed\n");
        assert!(std::fs::read_dir(&git_dir).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().starts_with("huntaway-")), "no scratch index left");

        // Nothing new since: no second one.
        let (run, _) = start(&s, &t.id, "again");
        before_run(&s, &t, &run).await;
        assert_eq!(list(&s.db(), &t.id).unwrap().len(), 1);
    })
}

#[test]
fn turns_show_their_own_changes_and_rewind_restores_the_files() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (t, wt, _) = task_repo(&s, false).await;
        s.update_task(&t.id, &[("session_id", json!("sess"))]).unwrap();
        write(&wt, "build.log", "ignored\n");
        let m1 = turn(&s, &t.id, "one", || {
            write(&wt, "f.txt", "one\n");
            write(&wt, "a.txt", "a\n");
            sh(&wt, &["add", "-A"]);
            sh(&wt, &["commit", "-qm", "turn one"]);
            std::fs::remove_file(wt.join("gone.txt")).unwrap();
        })
        .await;
        let after_one = files(&wt);
        let head_one = sh(&wt, &["rev-parse", "HEAD"]);
        let m2 = turn(&s, &t.id, "two", || {
            write(&wt, "f.txt", "two\n");
            write(&wt, "dir/u.txt", "untracked\n");
            write(&wt, "build.log", "ignored, changed\n");
            sh(&wt, &["add", "f.txt"]);
            sh(&wt, &["commit", "-qm", "turn two"]);
            write(&wt, "a.txt", "a, changed\n");
        })
        .await;

        let ts = get_turns(&s, &t.id).await;
        let list = ts["turns"].as_array().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!((list[0]["turn"].as_i64(), list[0]["message_id"].as_i64(), list[0]["text"].as_str()), (Some(1), Some(m1), Some("one")));
        assert_eq!((list[1]["turn"].as_i64(), list[1]["stats"]["files"].as_u64()), (Some(2), Some(3)));
        assert_eq!(list[1]["rewind"]["ok"], true);
        assert_eq!(list[1]["rewind"]["conversation"], json!({"ok": true, "fresh": false}));
        // Turn 1 started the conversation: going back before it starts a new one.
        assert_eq!(list[0]["rewind"]["conversation"], json!({"ok": true, "fresh": true}));

        let d = get_diff(&s, &t.id, list[1]["before_n"].as_i64().unwrap(), list[1]["n"].as_i64().unwrap()).await;
        let patch = d["patch"].as_str().unwrap();
        assert!(patch.contains("+two") && patch.contains("dir/u.txt") && patch.contains("a, changed"), "{patch}");
        assert!(!patch.contains("gone.txt") && !patch.contains("build.log"), "{patch}");

        // Back to before turn 2, with its conversation.
        let r = do_rewind(&s, &t.id, m2, true, false).await.unwrap();
        assert_eq!((r["written"].as_u64(), r["removed"].as_u64()), (Some(2), Some(1)));
        assert_eq!((read(&wt, "f.txt").as_deref(), read(&wt, "a.txt").as_deref()), (Some("one\n"), Some("a\n")));
        assert!(!wt.join("dir").exists(), "the folder it left empty goes too");
        assert_eq!(read(&wt, "build.log").as_deref(), Some("ignored, changed\n"), "ignored files are left alone");
        // The branch stays where it was: turn 2's commit is undone in the working tree.
        assert_eq!(sh(&wt, &["rev-parse", "HEAD^"]), head_one);
        assert_eq!(files(&wt), " M f.txt\n D gone.txt\n");
        let task = db::get_task(&s.db(), &t.id).unwrap().unwrap();
        assert_eq!(task.rewind, Some(Rewind { turn: 2, message_id: m2, session: "sess".into(), resume_at: Some(format!("at-{m1}")), before_turn: None }));
        let cps = super::list(&s.db(), &t.id).unwrap();
        let stale: Vec<(String, i64)> = cps.iter().map(|c| (c.kind.clone(), c.stale)).collect();
        assert_eq!(stale, [("start".into(), 0), ("turn".into(), 0), ("turn".into(), 2), ("rewind".into(), 1)]);
        // The files the rewind replaced are kept.
        assert_eq!(sh(&wt, &["show", &format!("{}:a.txt", r["kept"].as_str().unwrap())]), "a, changed\n");
        assert!(do_rewind(&s, &t.id, m2, false, false).await.is_err(), "a stale turn can't be rewound to again");

        // The next turn starts from the rewound files.
        let m3 = turn(&s, &t.id, "three", || write(&wt, "c.txt", "c\n")).await;
        let ts = get_turns(&s, &t.id).await;
        let three = &ts["turns"][2];
        assert_eq!((three["turn"].as_i64(), three["stats"]["files"].as_u64(), three["stale"].as_bool()), (Some(3), Some(1), Some(false)));
        assert_eq!(ts["turns"][1]["rewind"]["ok"], false);

        // Back before turn 1 with the branch: the baseline, on its commit, and a new conversation.
        do_rewind(&s, &t.id, m1, true, true).await.unwrap();
        assert_ne!(sh(&wt, &["rev-parse", "HEAD"]), head_one);
        assert_eq!(files(&wt), "");
        assert_eq!(read(&wt, "gone.txt").as_deref(), Some("bye\n"));
        assert!(!wt.join("c.txt").exists() && !wt.join("a.txt").exists());
        let task = db::get_task(&s.db(), &t.id).unwrap().unwrap();
        assert_eq!((task.session_id, task.rewind), (None, None));
        let _ = (after_one, m3);
    })
}

#[test]
fn rewinding_waits_for_the_agent_and_its_reviews() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (t, wt, _) = task_repo(&s, false).await;
        let m = turn(&s, &t.id, "one", || write(&wt, "a.txt", "a\n")).await;
        s.runs.lock().unwrap().insert(t.id.clone(), crate::state::RunHandle { run_id: "r".into(), cancel: None });
        let e = do_rewind(&s, &t.id, m, false, false).await.unwrap_err();
        assert!(e.1.contains("running"), "{}", e.1);
        assert_eq!(get_turns(&s, &t.id).await["turns"][0]["rewind"]["ok"], false);
        s.runs.lock().unwrap().clear();
        assert!(wt.join("a.txt").exists());
        do_rewind(&s, &t.id, m, false, false).await.unwrap();
        assert!(!wt.join("a.txt").exists());
    })
}

#[test]
fn files_git_hides_are_left_alone() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (t, wt, _) = task_repo(&s, false).await;
        // A submodule, a file marked skip-worktree and one marked assume-unchanged, each changed locally.
        let sub = crate::testing::temp_dir();
        sh(&sub, &["init", "-q", "-b", "master"]);
        sh(&sub, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one"]);
        sh(&wt, &["submodule", "add", "-q", &path_str(&sub), "sub"]);
        write(&wt, "local.cfg", "shared\n");
        write(&wt, "au.txt", "shared\n");
        sh(&wt, &["add", "-A"]);
        sh(&wt, &["commit", "-qm", "setup"]);
        sh(&wt, &["update-index", "--skip-worktree", "local.cfg"]);
        sh(&wt, &["update-index", "--assume-unchanged", "au.txt"]);
        write(&wt, "local.cfg", "mine\n");
        write(&wt, "au.txt", "mine\n");
        let m = turn(&s, &t.id, "one", || {
            sh(&wt.join("sub"), &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "two"]);
            write(&wt, "a.txt", "a\n");
            write(&wt, "local.cfg", "mine, changed\n");
        })
        .await;
        let sub_head = sh(&wt.join("sub"), &["rev-parse", "HEAD"]);
        let r = do_rewind(&s, &t.id, m, false, false).await.unwrap();
        assert!(!wt.join("a.txt").exists());
        assert_eq!(r["skipped"], json!(["sub"]));
        assert_eq!(sh(&wt.join("sub"), &["rev-parse", "HEAD"]), sub_head, "the submodule's checkout is its own");
        assert_eq!((read(&wt, "local.cfg").as_deref(), read(&wt, "au.txt").as_deref()), (Some("mine, changed\n"), Some("mine\n")));
        let flags = sh(&wt, &["ls-files", "-v", "local.cfg", "au.txt"]);
        assert_eq!(flags, "h au.txt\nS local.cfg\n");
    })
}

#[test]
fn a_rewind_never_writes_over_what_the_checkpoints_dont_have() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (t, wt, _) = task_repo(&s, false).await;
        write(&wt, "x", "a file\n");
        write(&wt, "sub/file", "a folder\n");
        write(&wt, "local.cfg", "old\n");
        let git = |dir: &Path, args: &[&str]| sh(dir, &[&["-c", "user.name=t", "-c", "user.email=t@t"][..], args].concat());
        let m = turn(&s, &t.id, "one", || {
            // A file becomes a folder, with an ignored file and another repository in it.
            std::fs::remove_file(wt.join("x")).unwrap();
            write(&wt, "x/a", "a\n");
            write(&wt, "x/keep.log", "ignored\n");
            write(&wt, "x/vendor/f", "theirs\n");
            git(&wt.join("x/vendor"), &["init", "-q"]);
            git(&wt.join("x/vendor"), &["add", "f"]);
            git(&wt.join("x/vendor"), &["commit", "-qm", "v"]);
            write(&wt, "x/vendor/wip", "uncommitted\n");
            // A folder becomes another repository.
            std::fs::remove_dir_all(wt.join("sub")).unwrap();
            write(&wt, "sub/mine", "mine\n");
            git(&wt.join("sub"), &["init", "-q"]);
            git(&wt.join("sub"), &["add", "mine"]);
            git(&wt.join("sub"), &["commit", "-qm", "s"]);
            // A file the checkpoints had becomes ignored, and changes.
            write(&wt, ".gitignore", "*.log\nlocal.cfg\n");
            write(&wt, "local.cfg", "new\n");
        })
        .await;
        let r = do_rewind(&s, &t.id, m, false, false).await.unwrap();
        let mut skipped: Vec<String> = serde_json::from_value(r["skipped"].clone()).unwrap();
        skipped.sort();
        assert_eq!(skipped, ["local.cfg", "sub", "sub/file", "x", "x/vendor"]);
        assert!(!wt.join("x/a").exists());
        assert_eq!(read(&wt, "x/keep.log").as_deref(), Some("ignored\n"));
        assert_eq!(read(&wt, "x/vendor/wip").as_deref(), Some("uncommitted\n"));
        assert!(wt.join("x/vendor/.git").is_dir());
        assert_eq!((read(&wt, "sub/mine").as_deref(), read(&wt, "sub/file")), (Some("mine\n"), None));
        assert_eq!(read(&wt, "local.cfg").as_deref(), Some("new\n"));
        assert_eq!(read(&wt, ".gitignore").as_deref(), Some("*.log\n"));
    })
}

#[test]
fn a_rewind_that_fails_part_way_leaves_the_branch_alone() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (t, wt, _) = task_repo(&s, false).await;
        let m = turn(&s, &t.id, "one", || {
            write(&wt, "a.txt", "a\n");
            sh(&wt, &["add", "a.txt"]);
            sh(&wt, &["commit", "-qm", "a"]);
            write(&wt, "ro/f.txt", "f\n");
        })
        .await;
        let head = sh(&wt, &["rev-parse", "HEAD"]);
        // A file it can't remove.
        let ro = wt.join("ro");
        std::fs::set_permissions(&ro, std::os::unix::fs::PermissionsExt::from_mode(0o555)).unwrap();
        let e = do_rewind(&s, &t.id, m, false, true).await.unwrap_err();
        std::fs::set_permissions(&ro, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        assert!(e.1.contains("part way") && e.1.contains(&ref_prefix(&t.id)), "{}", e.1);
        assert_eq!(sh(&wt, &["rev-parse", "HEAD"]), head);
        // Once it can, it goes through, branch and all.
        do_rewind(&s, &t.id, m, false, true).await.unwrap();
        assert_eq!(sh(&wt, &["rev-parse", "HEAD"]), sh(&wt, &["rev-parse", "master"]));
        assert_eq!(files(&wt), "");
    })
}

#[test]
fn a_rewind_goes_to_before_the_first_turn_a_message_started() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (t, wt, _) = task_repo(&s, false).await;
        let (run, m) = start(&s, &t.id, "go");
        let task = db::get_task(&s.db(), &t.id).unwrap().unwrap();
        before_run(&s, &task, &run).await;
        write(&wt, "a.txt", "a\n");
        after_turn(&s, &run.id, "done");
        // The agent goes on by itself (a background task finished), with no message of the user's.
        write(&wt, "b.txt", "b\n");
        after_turn(&s, &run.id, "done");
        let cps = settled(&s, &t.id).await;
        let turns: Vec<(Option<i64>, Option<i64>)> = cps.iter().filter(|c| c.kind == "turn").map(|c| (c.turn, c.message_id)).collect();
        assert_eq!(turns, [(Some(1), Some(m)), (Some(2), None)]);
        do_rewind(&s, &t.id, m, false, false).await.unwrap();
        assert!(!wt.join("a.txt").exists() && !wt.join("b.txt").exists());
    })
}

#[test]
fn a_rewind_never_follows_a_symlink_out_of_the_worktree() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (t, wt, _) = task_repo(&s, false).await;
        let outside = crate::testing::temp_dir();
        write(&outside, "keep.txt", "keep\n");
        let m = turn(&s, &t.id, "one", || {
            std::os::unix::fs::symlink(&outside, wt.join("out")).unwrap();
            write(&wt, "d/x.txt", "x\n");
        })
        .await;
        // A folder the turn made becomes a symlink to the outside afterwards.
        std::fs::remove_dir_all(wt.join("d")).unwrap();
        std::os::unix::fs::symlink(&outside, wt.join("d")).unwrap();
        write(&outside, "x.txt", "outside\n");
        do_rewind(&s, &t.id, m, false, false).await.unwrap();
        assert!(std::fs::symlink_metadata(wt.join("out")).is_err());
        assert_eq!(read(&outside, "keep.txt").as_deref(), Some("keep\n"));
        assert_eq!(read(&outside, "x.txt").as_deref(), Some("outside\n"));
    })
}

#[test]
fn files_a_merge_brought_in_are_left_out_of_a_turn() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (t, wt, repo) = task_repo(&s, false).await;
        write(&wt, "mine.txt", "mine\n");
        sh(&wt, &["add", "-A"]);
        sh(&wt, &["commit", "-qm", "mine"]);
        // Master moves on meanwhile, in the main checkout.
        write(&repo, "theirs.txt", "theirs\n");
        write(&repo, "f.txt", "master's\n");
        sh(&repo, &["add", "-A"]);
        sh(&repo, &["commit", "-qm", "theirs"]);
        turn(&s, &t.id, "merge", || {
            // A merge with a conflict, resolved, and a change of its own.
            write(&wt, "f.txt", "branch's\n");
            sh(&wt, &["commit", "-qam", "branch f"]);
            let out = std::process::Command::new("git").arg("-C").arg(&wt).args(["merge", "-q", "master"]).output().unwrap();
            assert!(!out.status.success());
            write(&wt, "f.txt", "resolved\n");
            sh(&wt, &["add", "f.txt"]);
            sh(&wt, &["commit", "-q", "--no-edit"]);
            write(&wt, "own.txt", "own\n");
        })
        .await;
        let ts = get_turns(&s, &t.id).await;
        let one = &ts["turns"][0];
        assert_eq!(one["stats"]["excluded"], json!(["theirs.txt"]));
        let d = get_diff(&s, &t.id, one["before_n"].as_i64().unwrap(), one["n"].as_i64().unwrap()).await;
        let patch = d["patch"].as_str().unwrap();
        assert!(patch.contains("+resolved") && patch.contains("own.txt") && !patch.contains("theirs.txt"), "{patch}");
        assert_eq!(d["excluded"], json!(["theirs.txt"]));

    })
}

#[test]
fn files_a_rebase_went_onto_are_left_out_of_a_turn() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (t, wt, repo) = task_repo(&s, false).await;
        write(&wt, "mine.txt", "mine\n");
        sh(&wt, &["add", "-A"]);
        sh(&wt, &["commit", "-qm", "mine"]);
        write(&repo, "more.txt", "more\n");
        sh(&repo, &["add", "-A"]);
        sh(&repo, &["commit", "-qm", "more"]);
        turn(&s, &t.id, "rebase", || {
            write(&wt, "own.txt", "own\n");
            sh(&wt, &["add", "-A"]);
            sh(&wt, &["commit", "-qm", "own"]);
            sh(&wt, &["rebase", "-q", "master"]);
        })
        .await;
        let ts = get_turns(&s, &t.id).await;
        let one = &ts["turns"][0];
        assert_eq!(one["stats"]["excluded"], json!(["more.txt"]), "{one}");
        assert_eq!(one["stats"]["files"], 1);
        // Pulled in by a fast-forward: all of it is left out.
        write(&repo, "ff.txt", "ff\n");
        sh(&repo, &["add", "-A"]);
        sh(&repo, &["commit", "-qm", "ff"]);
        let master = sh(&repo, &["rev-parse", "master"]);
        turn(&s, &t.id, "ff", || {
            sh(&wt, &["reset", "-q", "--hard", master.trim()]);
        })
        .await;
        let ts = get_turns(&s, &t.id).await;
        let two = &ts["turns"][1];
        assert_eq!(two["stats"]["files"], 2, "{two}");
        let _ = two;
    })
}

#[test]
fn checkpoints_go_with_the_worktree() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        // The project's repository is reached through a symlink.
        let (t, wt, repo) = task_repo(&s, true).await;
        turn(&s, &t.id, "one", || write(&wt, "a.txt", "a\n")).await;
        assert_eq!(sh(&repo, &["for-each-ref", "--format=%(refname)", &ref_prefix(&t.id)]).lines().count(), 2);
        crate::worktree::teardown(&s, &t.id, true, false).await.unwrap();
        assert_eq!(sh(&repo, &["for-each-ref", &ref_prefix(&t.id)]), "");
        assert!(list(&s.db(), &t.id).unwrap().is_empty());
        // Nothing landed in the repository the tests run in.
        let here = std::process::Command::new("git").args(["for-each-ref", &ref_prefix(&t.id)]).output().unwrap();
        assert!(here.stdout.is_empty());
    })
}

#[test]
fn checkpoints_stay_while_the_worktree_does() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (t, wt, repo) = task_repo(&s, false).await;
        turn(&s, &t.id, "one", || {
            write(&wt, "a.txt", "a\n");
            sh(&wt, &["add", "a.txt"]);
            sh(&wt, &["commit", "-qm", "a"]);
        })
        .await;
        let refs = || sh(&repo, &["for-each-ref", "--format=%(refname)", &ref_prefix(&t.id)]).lines().count();
        let rows = || list(&s.db(), &t.id).unwrap().len();
        assert_eq!((refs(), rows()), (2, 2));
        // A teardown script that fails, or leaves changes, keeps the worktree: its checkpoints stay.
        for script in ["exit 1", "echo left > left.txt"] {
            let project = t.project_id.as_deref().unwrap();
            s.db().execute("UPDATE projects SET teardown_script=?1 WHERE id=?2", params![script, project]).unwrap();
            assert!(crate::worktree::teardown(&s, &t.id, false, false).await.is_err(), "{script}");
            assert!(wt.is_dir());
            assert_eq!((refs(), rows()), (2, 2), "{script}");
            let _ = std::fs::remove_file(wt.join("left.txt"));
        }
        // A worktree folder deleted by hand: they go with it.
        s.db().execute("UPDATE projects SET teardown_script='' WHERE id=?1", [t.project_id.as_deref().unwrap()]).unwrap();
        std::fs::remove_dir_all(&wt).unwrap();
        crate::worktree::teardown(&s, &t.id, false, false).await.unwrap();
        assert_eq!((refs(), rows()), (0, 0));
    })
}

#[test]
fn the_oldest_checkpoints_go_past_the_cap() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (t, wt, _) = task_repo(&s, false).await;
        for i in 0..MAX_CHECKPOINTS + 3 {
            let (run, _) = start(&s, &t.id, "go");
            let _ = &run;
            write(&wt, "n.txt", &format!("{i}\n"));
            after_turn(&s, &run.id, "done");
        }
        let cps = settled(&s, &t.id).await;
        assert_eq!(cps.len(), MAX_CHECKPOINTS);
        assert_eq!(cps[0].n, 3);
        let refs = sh(&wt, &["for-each-ref", "--format=%(refname)", &ref_prefix(&t.id)]);
        assert_eq!(refs.lines().count(), MAX_CHECKPOINTS);
        assert!(!refs.contains(&format!("{}\n", ref_name(&t.id, 2))));
    })
}

fn cp(n: i64, turn: Option<i64>, session: &str, at: Option<&str>, stale: i64) -> Checkpoint {
    Checkpoint {
        n,
        kind: if turn.is_some() { "turn" } else { "start" }.into(),
        sha: String::new(),
        tree: String::new(),
        head: None,
        before_n: Some(n - 1),
        run_id: None,
        turn,
        message_id: turn.map(|t| t * 10),
        status: None,
        session: Some(session.into()),
        agent_at: at.map(String::from),
        stats: None,
        stale,
        created_at: String::new(),
    }
}

#[test]
fn the_conversation_goes_back_to_the_turn_before_still_in_it() {
    let c = db::open(Path::new(":memory:")).unwrap();
    let p = db::insert_profile(&c, "p", &[], None).unwrap();
    let t = db::NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "t", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
    let task = Task { session_id: Some("s".into()), ..db::insert_task(&c, t).unwrap() };
    let rows = [cp(0, None, "s", None, 0), cp(1, Some(1), "s", Some("u1"), 0), cp(2, Some(2), "s", Some("u2"), 2), cp(3, Some(3), "s", Some("u3"), 1), cp(4, Some(4), "s", Some("u4"), 0)];
    let back = |turn: &Checkpoint, codex: bool| conversation(&task, &rows, turn, codex, Some(10));
    let resume = |at: &str, turn: i64| Ok(Convo::Back(Rewind { turn, message_id: turn * 10, session: "s".into(), resume_at: Some(at.into()), before_turn: None }));
    // Turn 2 was taken out of the conversation already; turn 3 only had its files rewound.
    assert_eq!(back(&rows[4], false), resume("u3", 4));
    assert_eq!(back(&rows[3], false), resume("u1", 3));
    assert_eq!(back(&rows[1], false), Ok(Convo::Fresh));
    assert_eq!(back(&rows[4], true), Ok(Convo::Back(Rewind { turn: 4, message_id: 40, session: "s".into(), resume_at: None, before_turn: Some("u4".into()) })));
    assert_eq!(back(&rows[1], true), Ok(Convo::Fresh));
    // A new session since, or no record of where the conversation was.
    let other = Task { session_id: Some("other".into()), ..task.clone() };
    assert!(conversation(&other, &rows, &rows[4], false, Some(10)).is_err());
    assert!(conversation(&other, &rows, &rows[4], true, Some(10)).is_err());
    assert!(conversation(&task, &rows, &rows[1], false, Some(5)).is_err());
    assert_eq!(conversation(&Task { session_id: None, ..task }, &rows, &rows[4], false, Some(10)), Ok(Convo::Nothing));
}

#[test]
fn reads_diff_headers() {
    assert_eq!(header_path("diff --git a/x y b/x y").as_deref(), Some("x y"));
    assert_eq!(header_path("diff --git a/a b/c b/a b/c").as_deref(), Some("a b/c"));
    assert_eq!(header_path("diff --git \"a/t\\tab\" \"b/t\\tab\"").as_deref(), Some("t\tab"));
    assert_eq!(header_path("diff --git \"a/\\303\\251\" \"b/\\303\\251\"").as_deref(), Some("é"));
    let patch = "diff --git a/k b/k\n+k\ndiff --git a/x b/x\n+x\ndiff --git a/k2 b/k2\n+k2\n";
    assert_eq!(without(patch, &["x".to_string()].into()), "diff --git a/k b/k\n+k\ndiff --git a/k2 b/k2\n+k2\n");
    for (subject, made) in [
        ("commit: x", true),
        ("commit (amend): x", true),
        ("commit (merge): Merge branch 'master'", true),
        ("merge master: Merge made by the 'ort' strategy.", true),
        ("rebase (pick): x", true),
        ("pull --rebase (pick): x", true),
        ("cherry-pick: x", true),
        ("merge master: Fast-forward", false),
        ("pull: Fast-forward", false),
        ("rebase (finish): returning to refs/heads/x", false),
        ("rebase (start): checkout master", false),
        ("reset: moving to HEAD~1", false),
        ("checkout: moving from a to b", false),
    ] {
        assert_eq!(creates_commit(subject), made, "{subject}");
    }
}
