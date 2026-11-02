use super::*;
use crate::api::{CreateProject, CreateTask, create_project_inner, create_task_inner};

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

/// `OWNER/REPO` from a remote URL on github.com.
fn github_repo(url: &str) -> Option<String> {
    remote_repo(url).filter(|(host, _)| is_github_com(host)).map(|(_, repo)| repo)
}

#[test]
fn reads_github_remotes() {
    for url in [
        "git@github.com:o/r.git",
        "github.com:o/r",
        "https://github.com/o/r",
        "https://github.com/o/r.git/",
        "https://x:token@github.com/o/r.git",
        "ssh://git@ssh.github.com:443/o/r.git",
        "git://GitHub.com/o/r",
    ] {
        assert_eq!(github_repo(url).as_deref(), Some("o/r"), "{url}");
    }
    for url in ["git@gitlab.com:o/r.git", "https://example.com/github.com/o/r", "/srv/git/o/r.git", "./github.com:o/r", "https://github.com/o", "https://github.com/o/r/pull/1"] {
        assert_eq!(github_repo(url), None, "{url}");
    }
}

#[test]
fn finds_the_github_remote_pull_requests_go_to() {
    crate::testing::run(async || {
        let repo = crate::testing::temp_dir();
        sh(&repo, &["init", "-q", "-b", "master"]);
        assert_eq!(github(&repo, Some("master")).await, None);
        sh(&repo, &["remote", "add", "history", "git@github.com:o/history.git"]);
        let only = Github { remote: "history".into(), repo: "o/history".into() };
        assert_eq!(github(&repo, Some("master")).await, Some(only));
        sh(&repo, &["remote", "add", "origin", "https://github.com/o/r.git"]);
        let origin = Github { remote: "origin".into(), repo: "o/r".into() };
        assert_eq!(github(&repo, Some("master")).await, Some(origin.clone()));
        assert_eq!(github(&repo, None).await, Some(origin));
        // The base branch's upstream comes first.
        sh(&repo, &["config", "branch.master.remote", "history"]);
        assert_eq!(github(&repo, Some("master")).await.map(|g| g.remote), Some("history".into()));
        sh(&repo, &["remote", "set-url", "history", "git@gitlab.com:o/history.git"]);
        assert_eq!(github(&repo, Some("master")).await, None);
        // It's where the branch is pushed that counts, not where it's fetched from.
        sh(&repo, &["remote", "set-url", "--push", "history", "git@github.com:o/mirror.git"]);
        assert_eq!(github(&repo, Some("master")).await.map(|g| g.repo), Some("o/mirror".into()));
        sh(&repo, &["remote", "set-url", "--push", "origin", "git@gitlab.com:o/r.git"]);
        assert_eq!(github(&repo, None).await, None);

        // The pull request is looked up where the branch is pushed, not where gh would look.
        let args = pr_view_args(&repo, Some("master"), "ia/x-1").await;
        assert_eq!(args, ["pr", "view", "ia/x-1", "--json", "url", "--repo", "o/mirror"]);
        sh(&repo, &["config", "--unset", "branch.master.remote"]);
        assert_eq!(pr_view_args(&repo, Some("master"), "ia/x-1").await, ["pr", "view", "ia/x-1", "--json", "url"]);
        std::fs::remove_dir_all(&repo).ok();
    })
}

#[test]
fn an_ssh_host_alias_is_the_host_it_stands_for() {
    crate::testing::run(async || {
        let dir = crate::testing::temp_dir();
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::write(dir.join("ssh_config"), "Host github-work\n  HostName github.com\n  IdentityFile ~/.ssh/work\nHost ghe\n  HostName GHE.acme.com\n").unwrap();
        SSH_CONFIG.set(Some(dir.join("ssh_config")));
        sh(&repo, &["init", "-q", "-b", "master"]);
        sh(&repo, &["remote", "add", "origin", "git@github-work:o/r.git"]);
        assert_eq!(push_repo(&repo, None).await, Some(("github.com".into(), "o/r".into())));
        assert_eq!(github(&repo, None).await.map(|g| g.repo), Some("o/r".into()));
        sh(&repo, &["remote", "set-url", "origin", "ssh://git@ghe/o/r.git"]);
        assert_eq!(push_repo(&repo, None).await, Some(("ghe.acme.com".into(), "o/r".into())));
        assert_eq!(github(&repo, None).await, None);
        // Only SSH remotes' hosts are aliases.
        sh(&repo, &["remote", "set-url", "origin", "https://github-work/o/r.git"]);
        assert_eq!(push_repo(&repo, None).await, Some(("github-work".into(), "o/r".into())));
        // A host the config doesn't name is as it is.
        sh(&repo, &["remote", "set-url", "origin", "git@gitlab.com:o/r.git"]);
        assert_eq!(push_repo(&repo, None).await, Some(("gitlab.com".into(), "o/r".into())));
        std::fs::remove_dir_all(&dir).ok();
    });
}

/// A repository (on master, ignoring target/) with a task whose worktree has a commit: the
/// repository, the task and its worktree and branch.
async fn task_with_work(s: &Shared) -> (PathBuf, Task, PathBuf, String) {
    let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
    let repo = crate::testing::temp_dir();
    sh(&repo, &["init", "-q", "-b", "master"]);
    std::fs::write(repo.join(".gitignore"), "target/\n").unwrap();
    sh(&repo, &["add", "."]);
    sh(&repo, &["commit", "-qm", "init"]);
    let b = CreateProject { name: "x".into(), repo_path: path_str(&repo), key: Some("X".into()), base_branch: Some("master".into()), use_worktrees: None };
    let p = create_project_inner(s, &profile.id, b).await.unwrap();
    let t = create_task_inner(s, &p.id, CreateTask { title: "Do it".into(), ..Default::default() }).unwrap();
    let t = setup(s, &t.id).await.unwrap();
    let (wt, branch) = (PathBuf::from(t.worktree_path.clone().unwrap()), t.branch.clone().unwrap());
    std::fs::write(wt.join("a"), "a").unwrap();
    sh(&wt, &["add", "a"]);
    sh(&wt, &["commit", "-qm", "a"]);
    (repo, t, wt, branch)
}

// HA-42: untracked files were listed without -z, so a name git quotes (not ASCII) or one starting
// with `-` dropped out of the branch's diff.
#[test]
fn the_diff_has_every_untracked_file_whatever_its_name() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (repo, t, wt, _) = task_with_work(&s).await;
        for name in ["café.txt", "-n.txt", "plain.txt"] {
            std::fs::write(wt.join(name), format!("in {name}\n")).unwrap();
        }
        let d = diff(&s, &t.id).await.unwrap();
        let mut untracked: Vec<&str> = d["untracked"].as_array().unwrap().iter().map(|f| f.as_str().unwrap()).collect();
        untracked.sort();
        assert_eq!(untracked, ["-n.txt", "café.txt", "plain.txt"]);
        let patch = d["patch"].as_str().unwrap();
        for name in ["café.txt", "-n.txt", "plain.txt"] {
            assert!(patch.contains(&format!("+in {name}\n")), "{name}: {patch}");
        }
        std::fs::remove_dir_all(&repo).ok();
    })
}

// HA-51: a task whose worktree was removed showed the project folder's changes as its own.
#[test]
fn without_its_worktree_the_diff_is_its_branchs() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (repo, t, _, branch) = task_with_work(&s).await;
        std::fs::write(repo.join("main-only"), "not the task's\n").unwrap();
        teardown(&s, &t.id, false, false).await.unwrap();
        let d = diff(&s, &t.id).await.unwrap();
        assert_eq!((&d["available"], d["branch"].as_str()), (&json!(true), Some(branch.as_str())));
        let patch = d["patch"].as_str().unwrap();
        assert!(patch.contains("+++ b/a") && !patch.contains("main-only"), "{patch}");
        assert!(d["commits"].as_str().unwrap().contains(" a\n"), "{d}");
        assert_eq!(d["untracked"], json!([]));
        sh(&repo, &["branch", "-D", &branch]);
        let d = diff(&s, &t.id).await.unwrap();
        assert_eq!(d["available"], json!(false));
        assert!(d["reason"].as_str().unwrap().contains("is gone"), "{d}");
        std::fs::remove_dir_all(&repo).ok();
    })
}

// HA-92: a worktree removed while its diff was being read (picking one of a set's tasks tears the others' down) failed
// the request with git's "cannot change to" the folder.
#[test]
fn a_worktree_removed_while_its_diff_is_read_gives_its_branchs() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (repo, t, wt, branch) = task_with_work(&s).await;
        // The task as the diff loaded it, still "ready", with the folder gone by the time git runs in it.
        sh(&repo, &["worktree", "remove", "--force", &path_str(&wt)]);
        let d = diff(&s, &t.id).await.unwrap();
        assert_eq!((&d["available"], d["branch"].as_str()), (&json!(true), Some(branch.as_str())));
        assert!(d["patch"].as_str().unwrap().contains("+++ b/a"), "{d}");
        std::fs::remove_dir_all(&repo).ok();
    })
}

// HA-90: the same, with the folder going after the diff checked for it, while git runs in it.
#[test]
fn a_worktree_removed_while_git_reads_its_diff_gives_its_branchs() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (repo, t, wt, branch) = task_with_work(&s).await;
        std::fs::write(wt.join("draft"), "uncommitted\n").unwrap();
        let gone = wt.with_extension("gone");
        let (from, to) = (wt.clone(), gone.clone());
        crate::testing::when("diff:read", move || std::fs::rename(&from, &to).unwrap());
        let d = diff(&s, &t.id).await.unwrap();
        assert_eq!((&d["available"], d["branch"].as_str()), (&json!(true), Some(branch.as_str())), "{d}");
        assert!(d["patch"].as_str().unwrap().contains("+++ b/a"), "{d}");
        // Back in place, it's the worktree's again, uncommitted work and all.
        std::fs::rename(&gone, &wt).unwrap();
        let d = diff(&s, &t.id).await.unwrap();
        assert!(d["branch"].is_null() && d["untracked"] == json!(["draft"]), "{d}");
        std::fs::remove_dir_all(&repo).ok();
    })
}

fn kept(why: &str) -> Removal {
    Removal::Kept(why.to_string())
}

#[test]
fn removes_a_done_tasks_worktree_once_merged_and_clean() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (repo, t, wt, branch) = task_with_work(&s).await;
        let remove = async || remove_if_merged(&s, &t.id, true).await.unwrap();

        assert_eq!(remove().await, kept("it isn't done"));
        db::update_task(&s.db(), &t.id, &[("status", json!("done"))]).unwrap();
        assert_eq!(remove().await, kept("its work isn't merged into master"));
        sh(&repo, &["merge", "-q", "--no-ff", "-m", "merge", &branch]);
        // Untracked files would be lost, even when git status is set not to show them; ignored
        // ones (build output) wouldn't matter.
        sh(&repo, &["config", "status.showUntrackedFiles", "no"]);
        std::fs::write(wt.join("notes"), "n").unwrap();
        assert_eq!(remove().await, kept("it has 1 uncommitted or untracked file"));
        std::fs::remove_file(wt.join("notes")).unwrap();
        std::fs::create_dir_all(wt.join("target")).unwrap();
        std::fs::write(wt.join("target/out"), "o").unwrap();
        assert_eq!(remove().await, Removal::Removed("master".into()));

        assert!(!wt.exists());
        let t = db::get_task(&s.db(), &t.id).unwrap().unwrap();
        assert_eq!((t.status.as_str(), t.worktree_state.as_str(), t.branch.as_deref()), ("done", "none", Some(branch.as_str())));
        assert!(git(&repo, &["rev-parse", "--verify", &format!("refs/heads/{branch}")]).await.unwrap().ok);
        assert_eq!(remove().await, kept("it has no worktree"));

        // Run again (after a rename), it gets its folder back, on its branch.
        db::update_task(&s.db(), &t.id, &[("title", json!("Renamed")), ("status", json!("in_progress"))]).unwrap();
        let t = setup(&s, &t.id).await.unwrap();
        assert_eq!(t.worktree_path.as_deref(), Some(path_str(&wt).as_str()));
        assert_eq!(current_branch(&wt).await.as_deref(), Some(branch.as_str()));

        // The project's sweep removes it once it's done again, and leaves other tasks alone.
        let pid = t.project_id.clone().unwrap();
        let other = create_task_inner(&s, &pid, CreateTask { title: "Other".into(), ..Default::default() }).unwrap();
        let other = setup(&s, &other.id).await.unwrap();
        assert!(remove_merged(&s, &pid).await.unwrap().is_empty());
        db::update_task(&s.db(), &t.id, &[("status", json!("done"))]).unwrap();
        let results = remove_merged(&s, &pid).await.unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!((&results[0]["task_id"], &results[0]["removed"], &results[0]["detail"]), (&json!(t.id), &json!(true), &json!("merged into master")));
        assert!(!wt.exists());
        assert!(Path::new(other.worktree_path.as_deref().unwrap()).exists());
        std::fs::remove_dir_all(&repo).ok();
    })
}

#[test]
fn a_branch_merged_upstream_counts_as_merged() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let root = crate::testing::temp_dir();
        let (origin, repo, other) = (root.join("origin"), root.join("repo"), root.join("other"));
        std::fs::create_dir_all(&root).unwrap();
        sh(&root, &["init", "-q", "--bare", "-b", "master", &path_str(&origin)]);
        sh(&root, &["clone", "-q", &path_str(&origin), &path_str(&repo)]);
        sh(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
        sh(&repo, &["push", "-q", "-u", "origin", "master"]);
        let b = CreateProject { name: "x".into(), repo_path: path_str(&repo), key: Some("X".into()), base_branch: Some("master".into()), use_worktrees: None };
        let p = create_project_inner(&s, &profile.id, b).await.unwrap();
        let t = create_task_inner(&s, &p.id, CreateTask { title: "Do it".into(), ..Default::default() }).unwrap();
        let t = setup(&s, &t.id).await.unwrap();
        let (wt, branch) = (PathBuf::from(t.worktree_path.clone().unwrap()), t.branch.clone().unwrap());
        sh(&wt, &["commit", "-q", "--allow-empty", "-m", "work"]);
        sh(&wt, &["push", "-q", "origin", &branch]);
        db::update_task(&s.db(), &t.id, &[("status", json!("done"))]).unwrap();
        assert_eq!(remove_if_merged(&s, &t.id, true).await.unwrap(), kept("its work isn't merged into master"));

        // Merged elsewhere (as a pull request is), so the local master is behind.
        sh(&root, &["clone", "-q", &path_str(&origin), &path_str(&other)]);
        sh(&other, &["merge", "-q", "--no-ff", "-m", "merge", &format!("origin/{branch}")]);
        sh(&other, &["push", "-q", "origin", "master"]);
        // The sweep fetches it.
        let results = remove_merged(&s, &p.id).await.unwrap();
        assert_eq!((&results[0]["removed"], &results[0]["detail"]), (&json!(true), &json!("merged into origin/master")));
        assert!(!wt.exists());
        std::fs::remove_dir_all(&root).ok();
    })
}

// HA-32: setup took over any folder at the worktree's path, and a forced teardown removed whatever was
// there when git wouldn't, so a shared or misconfigured worktrees folder could cost work kept elsewhere.
#[test]
fn a_folder_in_the_worktrees_way_is_neither_adopted_nor_removed() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let root = crate::testing::temp_dir();
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        sh(&repo, &["init", "-q", "-b", "master"]);
        std::fs::write(repo.join("notes"), "1").unwrap();
        sh(&repo, &["add", "notes"]);
        sh(&repo, &["commit", "-qm", "init"]);
        let b = CreateProject { name: "x".into(), repo_path: path_str(&repo), key: Some("X".into()), base_branch: Some("master".into()), use_worktrees: None };
        let p = create_project_inner(&s, &profile.id, b).await.unwrap();
        let t = create_task_inner(&s, &p.id, CreateTask { title: "fix it".into(), ..Default::default() }).unwrap();
        // Someone's folder where the task's worktree would go.
        let wt = PathBuf::from(&p.worktrees_root).join(folder_name(&p, &t));
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join("precious"), "mine").unwrap();
        let err = setup(&s, &t.id).await.unwrap_err().to_string();
        assert!(err.contains("in the way"), "{err}");
        assert_eq!(std::fs::read_to_string(wt.join("precious")).unwrap(), "mine");
        let t = db::get_task(&s.db(), &t.id).unwrap().unwrap();
        assert_eq!((t.worktree_state.as_str(), t.worktree_path), ("error", None), "the failure is the task's to show, the folder nobody's");

        // Only a folder inside the worktrees folder, other than a main checkout, is removed by hand.
        assert!(removable_by_hand(&p, &repo, &wt).await, "a stray folder in the worktrees folder");
        assert!(!removable_by_hand(&p, &repo, &repo).await, "the repository");
        assert!(!removable_by_hand(&p, &repo, &root).await, "outside the worktrees folder");
        assert!(!removable_by_hand(&p, &repo, Path::new(&p.worktrees_root)).await, "the worktrees folder itself");
        let checkout = PathBuf::from(&p.worktrees_root).join("checkout");
        sh(&root, &["clone", "-q", &path_str(&repo), &path_str(&checkout)]);
        assert!(!removable_by_hand(&p, &repo, &checkout).await, "another main checkout");
        std::fs::remove_dir_all(&root).ok();
    })
}

#[test]
fn a_task_with_commits_its_base_lacks_is_unmerged() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let repo = crate::testing::temp_dir();
        sh(&repo, &["init", "-q", "-b", "master"]);
        sh(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
        let b = CreateProject { name: "x".into(), repo_path: path_str(&repo), key: Some("X".into()), base_branch: Some("master".into()), use_worktrees: None };
        let p = create_project_inner(&s, &profile.id, b).await.unwrap();
        let t = create_task_inner(&s, &p.id, CreateTask { title: "Do it".into(), ..Default::default() }).unwrap();
        let t = setup(&s, &t.id).await.unwrap();
        let (wt, branch) = (PathBuf::from(t.worktree_path.clone().unwrap()), t.branch.clone().unwrap());
        // Nothing done yet.
        assert!(!unmerged(&s, &t).await);
        std::fs::write(wt.join("notes"), "1").unwrap();
        assert!(unmerged(&s, &t).await);
        sh(&wt, &["add", "notes"]);
        sh(&wt, &["commit", "-qm", "work"]);
        assert!(unmerged(&s, &t).await);
        // A document is kept by the board, not merged.
        let doc = db::update_task(&s.db(), &t.id, &[("task_type", json!("plan"))]).unwrap().unwrap();
        assert!(!unmerged(&s, &doc).await);
        let t = db::update_task(&s.db(), &t.id, &[("task_type", Value::Null)]).unwrap().unwrap();
        sh(&repo, &["merge", "-q", "--no-ff", "-m", "merge", &branch]);
        assert!(!unmerged(&s, &t).await);
        std::fs::remove_dir_all(&repo).ok();
    })
}

#[test]
fn task_branches_start_from_the_latest_base() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let root = crate::testing::temp_dir();
        let (origin, repo, other) = (root.join("origin"), root.join("repo"), root.join("other"));
        std::fs::create_dir_all(&root).unwrap();
        sh(&root, &["init", "-q", "--bare", "-b", "master", &path_str(&origin)]);
        sh(&root, &["clone", "-q", &path_str(&origin), &path_str(&repo)]);
        std::fs::write(repo.join("notes"), "1").unwrap();
        sh(&repo, &["add", "notes"]);
        sh(&repo, &["commit", "-qm", "init"]);
        sh(&repo, &["push", "-q", "-u", "origin", "master"]);
        sh(&root, &["clone", "-q", &path_str(&origin), &path_str(&other)]);
        // Someone else pushes to master.
        let push = |file: &str| {
            std::fs::write(other.join(file), crate::util::new_id()).unwrap();
            sh(&other, &["add", file]);
            sh(&other, &["commit", "-qm", file]);
            sh(&other, &["push", "-q", "origin", "HEAD"]);
            rev(&other, "HEAD")
        };
        let b = CreateProject { name: "x".into(), repo_path: path_str(&repo), key: Some("X".into()), base_branch: Some("master".into()), use_worktrees: None };
        let p = create_project_inner(&s, &profile.id, b).await.unwrap();
        // A task's worktree: the task, the commit it starts from, whether its branch tracks
        // anything, and its log's warnings and notes. It has nothing of its own to show or merge.
        let task = async |title: &str, base: Option<&str>| {
            let t = create_task_inner(&s, &p.id, CreateTask { title: title.into(), ..Default::default() }).unwrap();
            db::update_task(&s.db(), &t.id, &[("base_branch", json!(base))]).unwrap();
            let t = setup(&s, &t.id).await.unwrap();
            let wt = PathBuf::from(t.worktree_path.clone().unwrap());
            let tracks = git(&wt, &["rev-parse", "--abbrev-ref", "@{upstream}"]).await.unwrap().ok;
            let log: Vec<String> = db::list_messages(&s.db(), &t.id).unwrap().iter().filter(|m| m.kind == "event").map(|m| m.data["text"].as_str().unwrap().to_string()).collect();
            assert!(!has_work_to_merge(&s, &t).await, "{title}");
            let d = diff(&s, &t.id).await.unwrap();
            assert_eq!((&d["merge_base"], &d["commits"], &d["patch"]), (&json!(rev(&wt, "HEAD")), &json!(""), &json!("")), "{title}");
            (t, rev(&wt, "HEAD"), tracks, log.join("\n"))
        };
        let compared = async |base: &str| compare_ref(&repo, base).await;

        // The main checkout is on master, with a change in the way of pulling it.
        let latest = push("notes");
        std::fs::write(repo.join("notes"), "mine").unwrap();
        let (_, head, tracks, log) = task("Dirty", None).await;
        assert_eq!(head, latest, "{log}");
        assert_eq!(compared("master").await, "origin/master");
        assert!(!tracks);
        assert!(log.contains("Branching from origin/master, 1 commit ahead of master, which couldn't be fast-forwarded"), "{log}");
        assert!(log.contains("(from origin/master)"), "{log}");
        assert_ne!(rev(&repo, "master"), latest);
        assert_eq!(std::fs::read_to_string(repo.join("notes")).unwrap(), "mine");

        // Clean, it's pulled.
        sh(&repo, &["checkout", "-q", "notes"]);
        let latest = push("b");
        let (_, head, _, log) = task("Clean", None).await;
        assert_eq!((head, rev(&repo, "master")), (latest.clone(), latest.clone()));
        assert_eq!(compared("master").await, "master");
        assert!(log.contains("Pulled master from origin/master (2 new commits)"), "{log}");

        // Local commits that aren't pushed are kept.
        sh(&repo, &["commit", "-q", "--allow-empty", "-m", "local"]);
        let local = rev(&repo, "master");
        let (_, head, _, log) = task("Ahead", None).await;
        assert_eq!(head, local, "{log}");
        assert_eq!(compared("master").await, "master");

        // Diverged: the upstream, where its pull request goes.
        let latest = push("c");
        let (_, head, _, log) = task("Diverged", None).await;
        assert_eq!(head, latest);
        assert_eq!(compared("master").await, "origin/master");
        assert!(log.contains("master has diverged from origin/master; branching from origin/master, without the 1 commit only master has"), "{log}");
        assert_eq!(rev(&repo, "master"), local);

        // Pushed without -u, the branch of the same name on origin counts.
        sh(&repo, &["reset", "-q", "--hard", "origin/master"]);
        sh(&repo, &["branch", "-q", "--unset-upstream"]);
        let latest = push("d");
        let (_, head, _, log) = task("No upstream", None).await;
        assert_eq!(head, latest, "{log}");
        assert_eq!(compared("master").await, "master");

        // A base branch only on the remote.
        sh(&other, &["push", "-q", "origin", "HEAD:dev"]);
        let (t, head, tracks, log) = task("Remote only", Some("dev")).await;
        assert_eq!(head, latest, "{log}");
        assert!(!tracks && log.contains("(from origin/dev)"), "{log}");
        assert_eq!(compared("dev").await, "origin/dev");
        // Its work shows up in its diff.
        let wt = PathBuf::from(t.worktree_path.clone().unwrap());
        std::fs::write(wt.join("feature"), "f").unwrap();
        sh(&wt, &["add", "feature"]);
        sh(&wt, &["commit", "-qm", "feature"]);
        let d = diff(&s, &t.id).await.unwrap();
        assert_eq!(d["merge_base"], json!(latest));
        assert_eq!(d["commits"].as_str().unwrap().lines().count(), 1);
        assert!(d["patch"].as_str().unwrap().contains("+++ b/feature"));

        // Unreachable, it goes by the last fetch.
        sh(&repo, &["remote", "set-url", "origin", &path_str(&root.join("gone"))]);
        push("e");
        let (_, head, _, log) = task("Offline", None).await;
        assert_eq!(head, latest, "{log}");
        assert!(log.contains("Could not fetch origin/master; branching from the copy fetched before"), "{log}");
        std::fs::remove_dir_all(&root).ok();
    })
}

/// A repository cloned from a bare `origin`, with a commit on master pushed, and another clone
/// of it to push from as someone else would; a project on it with key X; and a task maker.
async fn stacking_repo(s: &Shared) -> (PathBuf, PathBuf, PathBuf, Project) {
    let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
    let root = std::env::temp_dir().join(format!("ia-wt-{}", crate::util::new_id()));
    let (origin, repo, other) = (root.join("origin"), root.join("repo"), root.join("other"));
    std::fs::create_dir_all(&root).unwrap();
    sh(&root, &["init", "-q", "--bare", "-b", "master", &path_str(&origin)]);
    sh(&root, &["clone", "-q", &path_str(&origin), &path_str(&repo)]);
    std::fs::write(repo.join("notes"), "1").unwrap();
    sh(&repo, &["add", "notes"]);
    sh(&repo, &["commit", "-qm", "init"]);
    sh(&repo, &["push", "-q", "-u", "origin", "master"]);
    sh(&root, &["clone", "-q", &path_str(&origin), &path_str(&other)]);
    let b = CreateProject { name: "x".into(), repo_path: path_str(&repo), key: Some("X".into()), base_branch: Some("master".into()), use_worktrees: None };
    let p = create_project_inner(s, &profile.id, b).await.unwrap();
    (root, repo, other, p)
}

/// Commit a new file `name` in `dir`, returning the commit.
fn commit_file(dir: &Path, name: &str) -> String {
    std::fs::write(dir.join(name), crate::util::new_id()).unwrap();
    sh(dir, &["add", name]);
    sh(dir, &["commit", "-qm", name]);
    rev(dir, "HEAD")
}

fn log_of(s: &Shared, task_id: &str) -> String {
    let events = db::list_messages(&s.db(), task_id).unwrap();
    events.iter().filter(|m| m.kind == "event").map(|m| m.data["text"].as_str().unwrap_or_default().to_string()).collect::<Vec<_>>().join("\n")
}

/// The files a task's Changes tab shows.
async fn changed_files(s: &Shared, task_id: &str) -> Vec<String> {
    let d = diff(s, task_id).await.unwrap();
    let patch = d["patch"].as_str().unwrap();
    patch.lines().filter_map(|l| l.strip_prefix("+++ b/")).map(str::to_string).collect()
}

#[test]
fn a_task_stacked_on_another_starts_from_its_branch_and_compares_with_it() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (root, repo, _, p) = stacking_repo(&s).await;
        let new = |title: &str, from: Option<Value>| create_task_inner(&s, &p.id, CreateTask { title: title.into(), start_from: from, ..Default::default() }).unwrap();

        let a = setup(&s, &new("First", None).id).await.unwrap();
        let a_wt = PathBuf::from(a.worktree_path.clone().unwrap());
        commit_file(&a_wt, "a-file");
        let a_branch = a.branch.clone().unwrap();

        // Stacked on it by its key: from its branch, which it's compared with (and its pull request targets).
        let b = new("Second", Some(json!("x-1")));
        assert_eq!(b.start_from, Some(db::StartFrom::Task { task_id: a.id.clone() }));
        let b = setup(&s, &b.id).await.unwrap();
        let b_wt = PathBuf::from(b.worktree_path.clone().unwrap());
        assert_eq!(rev(&b_wt, "HEAD"), rev(&a_wt, "HEAD"));
        assert_eq!(b.base_branch.as_deref(), Some(a_branch.as_str()));
        assert!(log_of(&s, &b.id).contains("Stacked on X-1: starting from its branch"), "{}", log_of(&s, &b.id));
        assert!(!has_work_to_merge(&s, &b).await);
        commit_file(&b_wt, "b-file");
        assert_eq!(changed_files(&s, &b.id).await, ["b-file"]);
        assert!(has_work_to_merge(&s, &b).await);
        // It started where it did: what it starts from can't change now, even once the worktree is gone.
        let patch = async |t: &str, body: Value| crate::api::update_task_inner(&s, t, body.as_object().unwrap()).await;
        assert!(patch(&b.id, json!({"start_from": null})).await.is_err());

        // A task to stack on with no branch yet has its worktree set up first.
        let c = new("Third", None);
        let d = setup(&s, &new("Fourth", Some(json!(format!("task:{}", c.id)))).id).await.unwrap();
        let c = db::get_task(&s.db(), &c.id).unwrap().unwrap();
        assert_eq!(c.worktree_state, "ready");
        assert_eq!(d.base_branch, c.branch);
        assert!(log_of(&s, &d.id).contains("Setting up X-3's worktree first"));

        // Merged into master by way of First's branch: Second's worktree goes, though First's
        // branch doesn't have its work.
        sh(&repo, &["merge", "-q", "--ff-only", &b.branch.clone().unwrap()]);
        db::update_task(&s.db(), &b.id, &[("status", json!("done"))]).unwrap();
        assert!(matches!(remove_if_merged(&s, &b.id, false).await.unwrap(), Removal::Removed(into) if into == "master"));

        // Once First is merged, a task stacked on it starts from where it went.
        db::update_task(&s.db(), &a.id, &[("status", json!("done"))]).unwrap();
        let e = setup(&s, &new("Fifth", Some(json!("X-1"))).id).await.unwrap();
        assert_eq!(e.base_branch.as_deref(), Some("master"));
        assert_eq!(rev(Path::new(e.worktree_path.as_deref().unwrap()), "HEAD"), rev(&repo, "master"));
        assert!(log_of(&s, &e.id).contains("X-1 is merged already, so starting from master"));
        std::fs::remove_dir_all(&root).ok();
    })
}

#[test]
fn a_stacked_task_keeps_its_base_when_its_setup_script_fails() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (root, _, _, p) = stacking_repo(&s).await;
        let a = setup(&s, &create_task_inner(&s, &p.id, CreateTask { title: "First".into(), ..Default::default() }).unwrap().id).await.unwrap();
        let b = create_task_inner(&s, &p.id, CreateTask { title: "Second".into(), start_from: Some(json!("X-1")), ..Default::default() }).unwrap();
        db::update_project(&s.db(), &p.id, &[("setup_script", json!("exit 1"))]).unwrap();
        assert!(setup(&s, &b.id).await.is_err());
        let failed = db::get_task(&s.db(), &b.id).unwrap().unwrap();
        assert_eq!((failed.worktree_state.as_str(), failed.base_branch.as_deref()), ("error", a.branch.as_deref()));
        // Its branch is made, so what it starts from can't change now.
        let patch = crate::api::update_task_inner(&s, &b.id, json!({"start_from": "master"}).as_object().unwrap()).await;
        assert_eq!(patch.unwrap_err().0, axum::http::StatusCode::CONFLICT);
        // Set up again once the script is fixed, it's still stacked on First.
        db::update_project(&s.db(), &p.id, &[("setup_script", json!(""))]).unwrap();
        let b = setup(&s, &b.id).await.unwrap();
        assert_eq!(b.base_branch, a.branch);
        std::fs::remove_dir_all(&root).ok();
    })
}

#[test]
fn a_subproject_cant_start_from_its_own_task() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (root, _, _, p) = stacking_repo(&s).await;
        let sp = create_task_inner(&s, &p.id, CreateTask { title: "Sub".into(), subproject: Some(true), ..Default::default() }).unwrap();
        let child = create_task_inner(&s, &p.id, CreateTask { title: "Part".into(), parent_id: Some(sp.id.clone()), ..Default::default() }).unwrap();
        let other = create_task_inner(&s, &p.id, CreateTask { title: "Other".into(), start_from: Some(json!(format!("task:{}", child.id))), ..Default::default() });
        let other = other.unwrap();
        let patch = async |t: &str, body: Value| crate::api::update_task_inner(&s, t, body.as_object().unwrap()).await;
        for from in [child.id.clone(), other.id.clone()] {
            let err = patch(&sp.id, json!({"start_from": format!("task:{from}")})).await.unwrap_err();
            assert!(err.1.contains("needs this task's worktree first"), "{}", err.1);
        }
        // Had it got there some other way, setting up says so rather than waiting on itself.
        db::update_task(&s.db(), &sp.id, &[("start_from", json!(db::StartFrom::Task { task_id: other.id.clone() }))]).unwrap();
        let err = format!("{:#}", setup(&s, &sp.id).await.unwrap_err());
        assert!(err.contains("start from it"), "{err}");
        std::fs::remove_dir_all(&root).ok();
    })
}

#[test]
fn a_stacked_task_merges_where_the_task_it_stacks_on_went() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (root, repo, _, p) = stacking_repo(&s).await;
        let a = setup(&s, &create_task_inner(&s, &p.id, CreateTask { title: "First".into(), ..Default::default() }).unwrap().id).await.unwrap();
        commit_file(Path::new(a.worktree_path.as_deref().unwrap()), "parent-file");
        let b = create_task_inner(&s, &p.id, CreateTask { title: "Second".into(), start_from: Some(json!("X-1")), ..Default::default() }).unwrap();
        let b = setup(&s, &b.id).await.unwrap();
        let b_wt = PathBuf::from(b.worktree_path.clone().unwrap());
        commit_file(&b_wt, "child-file");

        // First is squashed into master and done: Second now merges into master, and its changes
        // are still only its own, before and after it's rebased onto master.
        sh(&repo, &["merge", "-q", "--squash", a.branch.as_deref().unwrap()]);
        sh(&repo, &["commit", "-qm", "First"]);
        db::update_task(&s.db(), &a.id, &[("status", json!("done"))]).unwrap();
        assert_eq!(db::task_base(&s.db(), &b, Some(&p)).as_deref(), Some("master"));
        assert_eq!(changed_files(&s, &b.id).await, ["child-file"]);
        assert_eq!(diff(&s, &b.id).await.unwrap()["base"], "master");
        sh(&b_wt, &["rebase", "-q", "--onto", "master", a.branch.as_deref().unwrap()]);
        assert_eq!(changed_files(&s, &b.id).await, ["child-file"]);
        assert_eq!(diff(&s, &b.id).await.unwrap()["merge_base"], json!(rev(&repo, "master")));
        // And with First's branch gone too.
        sh(&repo, &["worktree", "remove", "--force", a.worktree_path.as_deref().unwrap()]);
        sh(&repo, &["branch", "-q", "-D", a.branch.as_deref().unwrap()]);
        assert_eq!(changed_files(&s, &b.id).await, ["child-file"]);
        std::fs::remove_dir_all(&root).ok();
    })
}

#[test]
fn a_task_started_from_a_merged_task_goes_where_that_went() {
    crate::testing::run(async || {
        // Third is made as Second is merged into First, or once First is merged into master too.
        for after_first in [false, true] {
            let s = crate::testing::state();
            let (root, repo, _, p) = stacking_repo(&s).await;
            let new = |title: &str, from: &str| create_task_inner(&s, &p.id, CreateTask { title: title.into(), start_from: Some(json!(from)), ..Default::default() }).unwrap();
            let a = setup(&s, &create_task_inner(&s, &p.id, CreateTask { title: "First".into(), ..Default::default() }).unwrap().id).await.unwrap();
            let (a_wt, a_branch) = (PathBuf::from(a.worktree_path.clone().unwrap()), a.branch.clone().unwrap());
            commit_file(&a_wt, "parent-file");
            let b = setup(&s, &new("Second", "X-1").id).await.unwrap();
            commit_file(Path::new(b.worktree_path.as_deref().unwrap()), "child-file");
            // Second is squashed into First and done.
            sh(&a_wt, &["merge", "-q", "--squash", b.branch.as_deref().unwrap()]);
            sh(&a_wt, &["commit", "-qm", "Second"]);
            db::update_task(&s.db(), &b.id, &[("status", json!("done"))]).unwrap();
            let first_merged = async || {
                sh(&repo, &["merge", "-q", "--squash", &a_branch]);
                sh(&repo, &["commit", "-qm", "First"]);
                db::update_task(&s.db(), &a.id, &[("status", json!("done"))]).unwrap();
                teardown(&s, &a.id, true, true).await.unwrap();
            };
            if after_first {
                first_merged().await;
            }
            let c = setup(&s, &new("Third", "X-2").id).await.unwrap();
            let c_wt = PathBuf::from(c.worktree_path.clone().unwrap());
            let went = if after_first { "master" } else { a_branch.as_str() };
            assert_eq!(c.base_branch.as_deref(), Some(went), "{after_first}");
            assert!(log_of(&s, &c.id).contains(&format!("X-2 is merged already, so starting from {went}")), "{}", log_of(&s, &c.id));
            assert_eq!(rev(&c_wt, "HEAD"), rev(&repo, went));
            commit_file(&c_wt, "third-file");
            if !after_first {
                // First is merged afterwards: Third goes to master too.
                first_merged().await;
            }
            let c = db::get_task(&s.db(), &c.id).unwrap().unwrap();
            assert_eq!(db::task_base(&s.db(), &c, Some(&p)).as_deref(), Some("master"), "{after_first}");
            assert_eq!(changed_files(&s, &c.id).await, ["third-file"], "{after_first}");
            std::fs::remove_dir_all(&root).ok();
        }
    })
}

#[test]
fn a_stacked_task_keeps_its_own_changes_when_the_branch_it_stacks_on_is_deleted() {
    crate::testing::run(async || {
        // Second takes in some of First's later work, and the board hears of it as Second's run ends, as First
        // is done or as First's worktree and branch are removed, without anyone reading Second's
        // changes before First's branch is gone.
        for how in ["run", "done", "teardown"] {
            let s = crate::testing::state();
            let (root, repo, _, p) = stacking_repo(&s).await;
            let a = setup(&s, &create_task_inner(&s, &p.id, CreateTask { title: "First".into(), ..Default::default() }).unwrap().id).await.unwrap();
            let a_wt = PathBuf::from(a.worktree_path.clone().unwrap());
            commit_file(&a_wt, "parent-file");
            let b = create_task_inner(&s, &p.id, CreateTask { title: "Second".into(), start_from: Some(json!("X-1")), ..Default::default() }).unwrap();
            let b = setup(&s, &b.id).await.unwrap();
            let b_wt = PathBuf::from(b.worktree_path.clone().unwrap());
            let a_branch = a.branch.clone().unwrap();
            let taken_in = commit_file(&a_wt, "more-parent-file");
            sh(&b_wt, &["merge", "-q", "--no-edit", &a_branch]);
            commit_file(&b_wt, "child-file");
            // First moves on again, past what Second took in.
            commit_file(&a_wt, "latest-parent-file");
            // Until the board has moved Second's start on to what it took in of First.
            let moved = async || {
                let moved = async { while commit(&repo, &start_ref(&b.id)).await.as_deref() != Some(taken_in.as_str()) { tokio::time::sleep(Duration::from_millis(20)).await } };
                tokio::time::timeout(Duration::from_secs(10), moved).await.unwrap_or_else(|_| panic!("Second's start didn't move on ({how})"));
            };
            if how == "run" {
                // Second's agent did that, and its run ends.
                crate::agent::runs::TEST_CAN_RUN.set(true);
                crate::agent::runner::send(&s, &b.id, "take in First's work").unwrap();
                let run = s.runs.lock().unwrap().get(&b.id).unwrap().run_id.clone();
                crate::agent::runner::on_exit(&s, &run, Some(0), None, None, "");
                crate::agent::runs::TEST_CAN_RUN.set(false);
                moved().await;
            }

            // First is squashed into master, done, and its branch deleted (pushed and fetched too),
            // before Second is brought up to date: its changes are still only its own.
            sh(&repo, &["merge", "-q", "--squash", &a_branch]);
            sh(&repo, &["commit", "-qm", "First"]);
            sh(&repo, &["push", "-q", "origin", "master", &format!("{a_branch}:{a_branch}")]);
            sh(&repo, &["fetch", "-q", "origin"]);
            if how == "done" {
                s.update_task(&a.id, &[("status", json!("done"))]).unwrap();
                moved().await;
            } else {
                db::update_task(&s.db(), &a.id, &[("status", json!("done"))]).unwrap();
            }
            if how == "teardown" {
                teardown(&s, &a.id, true, true).await.unwrap();
            } else {
                sh(&repo, &["worktree", "remove", "--force", &path_str(&a_wt)]);
                sh(&repo, &["branch", "-q", "-D", &a_branch]);
            }
            assert!(commit(&repo, &format!("refs/heads/{a_branch}")).await.is_none());
            sh(&repo, &["push", "-q", "origin", "--delete", &a_branch]);
            sh(&repo, &["fetch", "-q", "--prune", "origin"]);
            assert_eq!(changed_files(&s, &b.id).await, ["child-file"], "{how}");
            // So do a review and a summary, which compare with the same commit, rather than the pull
            // request's diff, which would have First's later work.
            let (_, start) = changes_base(&s, &b_wt, &b, &p).await;
            assert_eq!(start, Some(rev(&b_wt, "HEAD~1")), "{how}");
            assert_eq!(work_scope(&s, &b_wt, &b, &p).await, (Some(taken_in.clone()), true), "{how}");
            // And its branch's, with its worktree removed.
            teardown(&s, &b.id, false, false).await.unwrap();
            assert_eq!(changed_files(&s, &b.id).await, ["child-file"], "{how}");
            setup(&s, &b.id).await.unwrap();

            // Rebased onto master (First's commits dropped), it's compared with master.
            sh(&b_wt, &["rebase", "-q", "--onto", "master", "HEAD~1"]);
            assert_eq!(changed_files(&s, &b.id).await, ["child-file"], "{how}");
            assert_eq!(diff(&s, &b.id).await.unwrap()["merge_base"], json!(rev(&repo, "master")));
            let (_, start) = changes_base(&s, &b_wt, &b, &p).await;
            assert_eq!(start, Some(rev(&repo, "master")), "{how}");
            // And its pull request's diff is its own again.
            assert_eq!(work_scope(&s, &b_wt, &b, &p).await, (Some(rev(&repo, "master")), false), "{how}");

            // Deleting the task drops what it kept.
            crate::api::delete_task_inner(&s, &b, false).await.unwrap();
            assert!(commit(&repo, &start_ref(&b.id)).await.is_none());
            std::fs::remove_dir_all(&root).ok();
        }
    })
}

#[test]
fn a_remotes_branch_is_that_remotes() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (root, repo, other, p) = stacking_repo(&s).await;
        // Another remote with a feature branch of its own, and origin's, neither fetched.
        let fork = root.join("fork");
        sh(&root, &["clone", "-q", "--bare", &path_str(&root.join("origin")), &path_str(&fork)]);
        sh(&repo, &["remote", "add", "upstream", &path_str(&fork)]);
        sh(&other, &["checkout", "-q", "-b", "feature"]);
        let theirs = commit_file(&other, "fork-file");
        sh(&other, &["push", "-q", &path_str(&fork), "feature"]);
        sh(&other, &["reset", "-q", "--hard", "origin/master"]);
        let ours = commit_file(&other, "origin-file");
        sh(&other, &["push", "-q", "origin", "feature"]);
        let new = |title: &str, from: &str| create_task_inner(&s, &p.id, CreateTask { title: title.into(), start_from: Some(json!(from)), ..Default::default() }).unwrap();

        // Upstream's isn't a branch this task's pull request, which goes to origin's repository, can
        // target: it starts from its latest commit, and its pull request targets master.
        let t = setup(&s, &new("Fork's", "upstream/feature").id).await.unwrap();
        let wt = PathBuf::from(t.worktree_path.clone().unwrap());
        assert_eq!((rev(&wt, "HEAD"), t.base_branch.as_deref()), (theirs.clone(), Some("master")));
        assert!(log_of(&s, &t.id).contains("upstream/feature is on upstream, which this task's pull request doesn't go to"), "{}", log_of(&s, &t.id));
        commit_file(&wt, "mine");
        assert_eq!(changed_files(&s, &t.id).await, ["mine"]);
        let t = db::get_task(&s.db(), &t.id).unwrap().unwrap();
        assert!(has_work_to_merge(&s, &t).await);
        // What its agent is told, with origin and upstream different repositories on GitHub.
        sh(&repo, &["remote", "set-url", "--push", "origin", "https://github.com/o/origin.git"]);
        sh(&repo, &["remote", "set-url", "--push", "upstream", "https://github.com/o/upstream.git"]);
        let gh = github(&repo, t.base_branch.as_deref()).await.unwrap();
        let told = crate::agent::runner::system_prompt(&t, Some(&p), None, &[], &[], Some(&gh), true);
        let branch = t.branch.as_deref().unwrap();
        assert!(told.contains(&format!("pr_create with repo `o/origin`, head `{branch}` and base `master`")), "{told}");
        assert!(!told.contains("upstream/feature"), "{told}");
        // A review and a summary read its changes from where it started, not its pull request's diff.
        assert_eq!(work_scope(&s, &wt, &t, &p).await, (Some(theirs.clone()), true));

        // Origin's, never fetched: fetched, and its pull request goes to feature there.
        let t = setup(&s, &new("Origin's", "origin/feature").id).await.unwrap();
        assert_eq!((rev(Path::new(t.worktree_path.as_deref().unwrap()), "HEAD"), t.base_branch.as_deref()), (ours, Some("feature")));
        std::fs::remove_dir_all(&root).ok();
    })
}

#[test]
fn a_task_can_start_from_a_commit_or_a_remote_branch() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (root, repo, other, p) = stacking_repo(&s).await;
        let new = |title: &str, from: Value| create_task_inner(&s, &p.id, CreateTask { title: title.into(), start_from: Some(from), ..Default::default() }).unwrap();
        let first = rev(&repo, "master");
        commit_file(&repo, "later");

        // An older commit of master, by a short SHA: it starts there, and merges into master.
        let t = new("Old", json!(&first[..8]));
        assert_eq!(t.start_from, Some(db::StartFrom::Commit { commit: first[..8].to_string() }));
        let t = setup(&s, &t.id).await.unwrap();
        let wt = PathBuf::from(t.worktree_path.clone().unwrap());
        assert_eq!((rev(&wt, "HEAD"), t.base_branch.as_deref()), (first.clone(), Some("master")));
        assert!(log_of(&s, &t.id).contains(&format!("Starting from commit {}", &first[..12])));

        // A commit on a branch master doesn't have: its changes are only what's after it.
        sh(&repo, &["checkout", "-q", "-b", "side", &first]);
        let side = commit_file(&repo, "side-file");
        sh(&repo, &["checkout", "-q", "master"]);
        let t = setup(&s, &new("Side", json!(format!("commit:{side}"))).id).await.unwrap();
        let wt = PathBuf::from(t.worktree_path.clone().unwrap());
        commit_file(&wt, "mine");
        assert_eq!(changed_files(&s, &t.id).await, ["mine"]);
        assert_eq!(diff(&s, &t.id).await.unwrap()["merge_base"], json!(side));

        // A commit only on the remote, by its full SHA, is fetched.
        sh(&other, &["checkout", "-q", "-b", "elsewhere"]);
        let elsewhere = commit_file(&other, "elsewhere-file");
        sh(&other, &["push", "-q", "origin", "elsewhere"]);
        sh(&other, &["push", "-q", "origin", "--delete", "elsewhere"]);
        sh(&other, &["push", "-q", "origin", "elsewhere:refs/keep/elsewhere"]);
        let t = setup(&s, &new("Fetched", json!(elsewhere)).id).await.unwrap();
        assert_eq!(rev(Path::new(t.worktree_path.as_deref().unwrap()), "HEAD"), elsewhere);
        // One that's nowhere fails, saying so.
        let t = new("Nowhere", json!("deadbeefdeadbeef"));
        let err = setup(&s, &t.id).await.unwrap_err().to_string();
        assert!(err.contains("commit deadbeefdeadbeef isn't in the repository (give its full SHA to fetch it)"), "{err}");
        assert_eq!(db::get_task(&s.db(), &t.id).unwrap().unwrap().worktree_state, "error");
        // It can be put right, and set up again.
        let t = crate::api::update_task_inner(&s, &t.id, json!({"start_from": &first[..8]}).as_object().unwrap()).await.unwrap();
        assert_eq!((t.worktree_state.as_str(), t.worktree_error), ("none", None));
        assert_eq!(rev(Path::new(setup(&s, &t.id).await.unwrap().worktree_path.as_deref().unwrap()), "HEAD"), first);

        // A branch only on the remote, named with it, is that branch: fetched, and its base.
        sh(&other, &["checkout", "-q", "-b", "feature", "origin/master"]);
        let feature = commit_file(&other, "feature-file");
        sh(&other, &["push", "-q", "origin", "feature"]);
        sh(&repo, &["fetch", "-q", "origin"]);
        let t = setup(&s, &new("Feature", json!("origin/feature")).id).await.unwrap();
        assert_eq!((rev(Path::new(t.worktree_path.as_deref().unwrap()), "HEAD"), t.base_branch.as_deref()), (feature, Some("feature")));
        std::fs::remove_dir_all(&root).ok();
    })
}

#[test]
fn a_task_can_start_from_a_pull_request() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (root, repo, other, p) = stacking_repo(&s).await;
        // On GitHub as far as the board can tell, with gh faked.
        sh(&repo, &["remote", "set-url", "--push", "origin", "git@github.com:o/r.git"]);
        sh(&other, &["checkout", "-q", "-b", "feature"]);
        let feature = commit_file(&other, "feature-file");
        sh(&other, &["push", "-q", "origin", "feature"]);
        sh(&other, &["checkout", "-q", "-b", "fork", "master"]);
        let fork = commit_file(&other, "fork-file");
        sh(&other, &["push", "-q", "origin", "fork:refs/pull/8/head"]);
        let gh = root.join("gh");
        let pr = |state: &str, head: &str, oid: &str, cross: bool| {
            format!(r#"{{"state":"{state}","headRefName":"{head}","baseRefName":"master","headRefOid":"{oid}","isCrossRepository":{cross}}}"#)
        };
        let script = format!(
            "#!/bin/sh\necho \"$@\" >> {log}\ncase \"$3\" in\n7) echo '{}' ;;\n8) echo '{}' ;;\n9) echo '{}' ;;\n*) echo 'no such pull request' >&2; exit 1 ;;\nesac\n",
            pr("OPEN", "feature", &feature, false),
            pr("OPEN", "patch-1", &fork, true),
            pr("MERGED", "done", &feature, false),
            log = path_str(&root.join("gh.log")),
        );
        std::fs::write(&gh, script).unwrap();
        std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).unwrap();
        GH.set(Some(gh));
        let new = |title: &str, from: &str| create_task_inner(&s, &p.id, CreateTask { title: title.into(), start_from: Some(json!(from)), ..Default::default() }).unwrap();

        // An open one from the repository: its branch, which its pull request targets.
        let t = new("On a PR", "#7");
        assert_eq!(t.start_from, Some(db::StartFrom::PullRequest { number: 7, repo: None }));
        let t = setup(&s, &t.id).await.unwrap();
        let wt = PathBuf::from(t.worktree_path.clone().unwrap());
        assert_eq!((rev(&wt, "HEAD"), t.base_branch.as_deref()), (feature.clone(), Some("feature")));
        assert!(std::fs::read_to_string(root.join("gh.log")).unwrap().contains("pr view 7 --repo o/r --json"));
        commit_file(&wt, "mine");
        assert_eq!(changed_files(&s, &t.id).await, ["mine"]);

        // From a fork: its head commit, fetched, on top of its base.
        let t = setup(&s, &new("On a fork's PR", "https://github.com/o/r/pull/8/files").id).await.unwrap();
        assert_eq!((rev(Path::new(t.worktree_path.as_deref().unwrap()), "HEAD"), t.base_branch.as_deref()), (fork, Some("master")));
        assert!(log_of(&s, &t.id).contains("Pull request #8 is from a fork"));
        // Merged: where it went.
        let t = setup(&s, &new("On a merged PR", "pr:9").id).await.unwrap();
        assert_eq!(t.base_branch.as_deref(), Some("master"));
        // One in another repository, or that gh can't find, fails.
        let err = setup(&s, &new("Elsewhere", "https://github.com/o/other/pull/7").id).await.unwrap_err().to_string();
        assert!(err.contains("pull request #7 is in o/other, not in the project's repository o/r"), "{err}");
        let err = setup(&s, &new("Missing", "#10").id).await.unwrap_err().to_string();
        assert!(err.contains("couldn't read pull request #10 of o/r with gh"), "{err}");
        GH.set(None);
        std::fs::remove_dir_all(&root).ok();
    })
}

#[test]
fn a_pull_request_is_looked_up_where_the_projects_tasks_open_theirs() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (root, repo, other, p) = stacking_repo(&s).await;
        // Origin and upstream are different repositories on GitHub, and master follows upstream's, so
        // the project's tasks open their pull requests there.
        let up = root.join("upstream");
        sh(&root, &["clone", "-q", "--bare", &path_str(&root.join("origin")), &path_str(&up)]);
        sh(&repo, &["remote", "add", "upstream", &path_str(&up)]);
        sh(&repo, &["remote", "set-url", "--push", "origin", "git@github.com:o/origin.git"]);
        sh(&repo, &["remote", "set-url", "--push", "upstream", "git@github.com:o/upstream.git"]);
        sh(&repo, &["fetch", "-q", "upstream"]);
        sh(&repo, &["branch", "-q", "-u", "upstream/master", "master"]);
        sh(&other, &["checkout", "-q", "-b", "feature"]);
        let feature = commit_file(&other, "feature-file");
        sh(&other, &["push", "-q", &path_str(&up), "feature"]);
        let gh = root.join("gh");
        let pr = format!(r#"{{"state":"OPEN","headRefName":"feature","baseRefName":"master","headRefOid":"{feature}","isCrossRepository":false}}"#);
        let log = root.join("gh.log");
        let script = format!("#!/bin/sh\necho \"$@\" >> {}\ncase \"$3 $5\" in\n'7 o/upstream') echo '{pr}' ;;\n*) echo 'no such pull request' >&2; exit 1 ;;\nesac\n", path_str(&log));
        std::fs::write(&gh, script).unwrap();
        std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).unwrap();
        GH.set(Some(gh));
        let new = |title: &str, from: &str| create_task_inner(&s, &p.id, CreateTask { title: title.into(), start_from: Some(json!(from)), ..Default::default() }).unwrap();
        let told = async |t: &Task| {
            let gh = github(&repo, t.base_branch.as_deref()).await.unwrap();
            crate::agent::runner::system_prompt(t, Some(&p), None, &[], &[], Some(&gh), true)
        };

        // Its branch isn't one `feature` alone follows here (that would be origin's): its head commit,
        // fetched from upstream, on top of its base, where the task's pull request goes.
        for from in ["https://github.com/o/upstream/pull/7", "#7"] {
            let t = setup(&s, &new("On upstream's PR", from).id).await.unwrap();
            assert_eq!((rev(Path::new(t.worktree_path.as_deref().unwrap()), "HEAD"), t.base_branch.as_deref()), (feature.clone(), Some("master")), "{from}");
            assert!(log_of(&s, &t.id).contains("Pull request #7 has its branch on upstream"), "{}", log_of(&s, &t.id));
            let text = told(&t).await;
            assert!(text.contains(&format!("repo `o/upstream`, head `{}` and base `master`", t.branch.as_deref().unwrap())), "{text}");
        }
        assert!(std::fs::read_to_string(&log).unwrap().lines().all(|l| l.contains("--repo o/upstream")));
        // With a local feature that follows upstream's, it's that branch, and the task's pull request targets it there.
        sh(&repo, &["fetch", "-q", "upstream"]);
        sh(&repo, &["branch", "-q", "--track", "feature", "upstream/feature"]);
        let t = setup(&s, &new("On upstream's branch", "#7").id).await.unwrap();
        assert_eq!(t.base_branch.as_deref(), Some("feature"));
        let text = told(&t).await;
        assert!(text.contains(&format!("repo `o/upstream`, head `{}` and base `feature`", t.branch.as_deref().unwrap())), "{text}");
        GH.set(None);
        std::fs::remove_dir_all(&root).ok();
    })
}

#[test]
fn a_stacked_task_still_goes_where_its_merged_parent_went_once_that_is_deleted() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (root, repo, _, p) = stacking_repo(&s).await;
        sh(&repo, &["remote", "set-url", "--push", "origin", "git@github.com:o/r.git"]);
        let a = setup(&s, &create_task_inner(&s, &p.id, CreateTask { title: "First".into(), ..Default::default() }).unwrap().id).await.unwrap();
        let a_wt = PathBuf::from(a.worktree_path.clone().unwrap());
        let a_tip = commit_file(&a_wt, "parent-file");
        let new = |title: &str| create_task_inner(&s, &p.id, CreateTask { title: title.into(), start_from: Some(json!("X-1")), ..Default::default() }).unwrap();
        let b = setup(&s, &new("Second").id).await.unwrap();
        commit_file(Path::new(b.worktree_path.as_deref().unwrap()), "child-file");
        // Third isn't set up yet.
        let c = new("Third");

        // First is squashed into master, done, torn down with its branch, and deleted.
        sh(&repo, &["merge", "-q", "--squash", a.branch.as_deref().unwrap()]);
        sh(&repo, &["commit", "-qm", "First"]);
        s.update_task(&a.id, &[("status", json!("done"))]).unwrap();
        teardown(&s, &a.id, true, true).await.unwrap();
        let a = db::get_task(&s.db(), &a.id).unwrap().unwrap();
        crate::api::delete_task_inner(&s, &a, false).await.unwrap();

        // Second goes to master, its changes still only its own.
        let b = db::get_task(&s.db(), &b.id).unwrap().unwrap();
        assert_eq!((b.base_branch.as_deref(), b.start_from.clone()), (Some("master"), Some(db::StartFrom::Commit { commit: a_tip.clone() })));
        assert_eq!(db::task_base(&s.db(), &b, Some(&p)).as_deref(), Some("master"));
        assert_eq!(changed_files(&s, &b.id).await, ["child-file"]);
        assert!(log_of(&s, &b.id).contains("X-1, which this task was stacked on, was deleted: it's merged, so this task goes to master"), "{}", log_of(&s, &b.id));
        // Its agent is told its pull request targets master, and not that it's stacked.
        let gh = github(&repo, b.base_branch.as_deref()).await.unwrap();
        let told = crate::agent::runner::system_prompt(&b, Some(&p), None, &[], &[], Some(&gh), true);
        assert!(told.contains(&format!("head `{}` and base `master`", b.branch.as_deref().unwrap())) && !told.contains("stacked"), "{told}");
        // Third is a task on master.
        let c = db::get_task(&s.db(), &c.id).unwrap().unwrap();
        assert_eq!((c.base_branch.as_deref(), c.start_from), (Some("master"), None));
        let c = setup(&s, &c.id).await.unwrap();
        assert_eq!(rev(Path::new(c.worktree_path.as_deref().unwrap()), "HEAD"), rev(&repo, "master"));
        std::fs::remove_dir_all(&root).ok();
    })
}

#[test]
fn deleting_a_merged_middle_task_stacks_its_tasks_on_the_one_below() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (root, repo, _, p) = stacking_repo(&s).await;
        let new = |title: &str, from: Option<&str>| create_task_inner(&s, &p.id, CreateTask { title: title.into(), start_from: from.map(|f| json!(f)), ..Default::default() }).unwrap();
        let a = setup(&s, &new("First", None).id).await.unwrap();
        let a_wt = PathBuf::from(a.worktree_path.clone().unwrap());
        commit_file(&a_wt, "first-file");
        let b = setup(&s, &new("Second", Some("X-1")).id).await.unwrap();
        commit_file(Path::new(b.worktree_path.as_deref().unwrap()), "second-file");
        // Third has a branch on Second's, Fourth isn't set up yet.
        let c = setup(&s, &new("Third", Some("X-2")).id).await.unwrap();
        commit_file(Path::new(c.worktree_path.as_deref().unwrap()), "third-file");
        let d = new("Fourth", Some("X-2"));

        // Second is squashed into First, done and deleted with its branch, before First is merged.
        sh(&a_wt, &["merge", "-q", "--squash", b.branch.as_deref().unwrap()]);
        sh(&a_wt, &["commit", "-qm", "Second"]);
        s.update_task(&b.id, &[("status", json!("done"))]).unwrap();
        let b = db::get_task(&s.db(), &b.id).unwrap().unwrap();
        crate::api::delete_task_inner(&s, &b, true).await.unwrap();
        let task = |id: &str| db::get_task(&s.db(), id).unwrap().unwrap();
        let on_first = Some(db::StartFrom::Task { task_id: a.id.clone() });
        let (c, d) = (task(&c.id), task(&d.id));
        assert_eq!((c.start_from.clone(), c.base_branch.as_deref()), (on_first.clone(), a.branch.as_deref()));
        assert_eq!((d.start_from.clone(), d.base_branch.as_deref()), (on_first, None));
        assert!(log_of(&s, &c.id).contains("X-2, which this task was stacked on, was deleted: it's merged into X-1, so this task is stacked on that now"), "{}", log_of(&s, &c.id));
        assert_eq!(changed_files(&s, &c.id).await, ["third-file"]);

        // First is squashed into master, done and its branch deleted: both go to master.
        sh(&repo, &["merge", "-q", "--squash", a.branch.as_deref().unwrap()]);
        sh(&repo, &["commit", "-qm", "First"]);
        s.update_task(&a.id, &[("status", json!("done"))]).unwrap();
        teardown(&s, &a.id, true, true).await.unwrap();
        for t in [&c, &d] {
            let t = task(&t.id);
            assert_eq!(db::task_base(&s.db(), &t, Some(&p)).as_deref(), Some("master"), "{}", t.title);
        }
        assert_eq!(changed_files(&s, &c.id).await, ["third-file"]);
        assert_eq!(diff(&s, &c.id).await.unwrap()["base"], "master");
        let d = setup(&s, &d.id).await.unwrap();
        assert_eq!((rev(Path::new(d.worktree_path.as_deref().unwrap()), "HEAD"), d.base_branch.as_deref()), (rev(&repo, "master"), Some("master")));
        std::fs::remove_dir_all(&root).ok();
    })
}

#[test]
fn a_task_stacked_on_an_unpushed_branch_opens_its_pull_request_where_that_ones_goes() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (root, repo, _, p) = stacking_repo(&s).await;
        // Origin and upstream are different repositories on GitHub, and master follows upstream's.
        let up = root.join("upstream");
        sh(&root, &["clone", "-q", "--bare", &path_str(&root.join("origin")), &path_str(&up)]);
        sh(&repo, &["remote", "add", "upstream", &path_str(&up)]);
        sh(&repo, &["remote", "set-url", "--push", "origin", "git@github.com:o/origin.git"]);
        sh(&repo, &["remote", "set-url", "--push", "upstream", "git@github.com:o/upstream.git"]);
        sh(&repo, &["fetch", "-q", "upstream"]);
        sh(&repo, &["branch", "-q", "-u", "upstream/master", "master"]);
        let new = |title: &str, from: Option<&str>| create_task_inner(&s, &p.id, CreateTask { title: title.into(), start_from: from.map(|f| json!(f)), ..Default::default() }).unwrap();
        // Second stacks on First, which isn't set up yet: it is, without a remote of its own.
        let a = new("First", None);
        let b = setup(&s, &new("Second", Some("X-1")).id).await.unwrap();
        let a = db::get_task(&s.db(), &a.id).unwrap().unwrap();
        let a_branch = a.branch.clone().unwrap();
        assert_eq!(b.base_branch.as_deref(), Some(a_branch.as_str()));
        let told = async |t: &Task| {
            let gh = github(&repo, remote_base(&s, t, &p).await.as_deref()).await.unwrap();
            crate::agent::runner::system_prompt(t, Some(&p), None, &[], &[], Some(&gh), true)
        };
        let text = told(&a).await;
        assert!(text.contains(&format!("`git push -u upstream {a_branch}`")) && text.contains("repo `o/upstream`"), "{text}");
        let text = told(&b).await;
        let b_branch = b.branch.as_deref().unwrap();
        assert!(text.contains(&format!("`git push -u upstream {b_branch}`")), "{text}");
        assert!(text.contains(&format!("repo `o/upstream`, head `{b_branch}` and base `{a_branch}`")), "{text}");
        // Once First's branch has a remote of its own, that's where.
        sh(&repo, &["config", &format!("branch.{a_branch}.remote"), "origin"]);
        assert!(told(&b).await.contains("repo `o/origin`"));
        std::fs::remove_dir_all(&root).ok();
    })
}

#[test]
fn start_from_is_checked_and_only_changes_before_the_branch_exists() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (root, _, _, p) = stacking_repo(&s).await;
        let new = |from: Value| create_task_inner(&s, &p.id, CreateTask { title: "t".into(), start_from: Some(from), ..Default::default() });
        let a = new(json!(null)).unwrap();
        assert_eq!(a.start_from, None);
        let read = |v: Value| new(v).map(|t| t.start_from.unwrap()).map_err(|e| e.1);
        assert_eq!(read(json!("feature/x")), Ok(db::StartFrom::Branch { branch: "feature/x".into() }));
        assert_eq!(read(json!("branch:abcdef12")), Ok(db::StartFrom::Branch { branch: "abcdef12".into() }));
        assert_eq!(read(json!("ABCDEF12")), Ok(db::StartFrom::Commit { commit: "abcdef12".into() }));
        assert_eq!(read(json!({"type": "pull_request", "number": 3})), Ok(db::StartFrom::PullRequest { number: 3, repo: None }));
        assert_eq!(read(json!(" X-1 ")), Ok(db::StartFrom::Task { task_id: a.id.clone() }));
        for (bad, why) in [
            (json!("a..b"), "isn't a valid branch name"),
            (json!("task:X-99"), "no task X-99"),
            (json!("commit:xyz"), "isn't a commit's SHA"),
            (json!("pr:#0"), "starts at 1"),
            (json!(3), "must be null, a string or an object"),
        ] {
            let err = read(bad.clone()).unwrap_err();
            assert!(err.contains(why), "{bad}: {err}");
        }
        // Not without a worktree, nor in a subproject, nor round in a circle.
        let no_wt = create_task_inner(&s, &p.id, CreateTask { title: "t".into(), use_worktree: Some(false), start_from: Some(json!("dev")), ..Default::default() });
        assert!(no_wt.unwrap_err().1.contains("for a task with a worktree"));
        let sp = create_task_inner(&s, &p.id, CreateTask { title: "sp".into(), subproject: Some(true), ..Default::default() }).unwrap();
        let child = create_task_inner(&s, &p.id, CreateTask { title: "c".into(), parent_id: Some(sp.id.clone()), start_from: Some(json!("dev")), ..Default::default() });
        assert!(child.unwrap_err().1.contains("a subproject's tasks start from its branch"));
        let patch = async |t: &str, body: Value| crate::api::update_task_inner(&s, t, body.as_object().unwrap()).await;
        let b = new(json!(format!("task:{}", a.id))).unwrap();
        let err = patch(&a.id, json!({"start_from": format!("X-{}", b.number)})).await.unwrap_err();
        assert!(err.1.contains("needs this task's worktree first"), "{}", err.1);
        assert!(patch(&a.id, json!({"start_from": "X-1"})).await.unwrap_err().1.contains("can't start from itself"));

        // start_from and base_branch take each other's place.
        let t = patch(&a.id, json!({"base_branch": "dev"})).await.unwrap();
        assert_eq!((t.base_branch.as_deref(), t.start_from), (Some("dev"), None));
        let t = patch(&a.id, json!({"start_from": "#4"})).await.unwrap();
        assert_eq!((t.base_branch, t.start_from), (None, Some(db::StartFrom::PullRequest { number: 4, repo: None })));
        assert!(patch(&a.id, json!({"start_from": "x", "base_branch": "y"})).await.is_err());
        let t = patch(&a.id, json!({"start_from": ""})).await.unwrap();
        assert_eq!(t.start_from, None);

        // Once there's a worktree, it's what it started from.
        let a = setup(&s, &a.id).await.unwrap();
        let err = patch(&a.id, json!({"start_from": "dev"})).await.unwrap_err();
        assert_eq!(err.0, axum::http::StatusCode::CONFLICT);
        std::fs::remove_dir_all(&root).ok();
    })
}

#[test]
fn worktree_fetches_use_the_project_account_before_the_profile_account() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (repo, task, _, _) = task_with_work(&s).await;
        let gh = repo.join("fake-gh");
        // No real login or network: make gh fail and identify the account it was asked for.
        std::fs::write(&gh, "#!/bin/sh\necho \"$*\" >&2\nexit 1\n").unwrap();
        std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).unwrap();
        crate::mcp::gh_mcp::TEST_GH_PROGRAM.set(Some(path_str(&gh)));
        sh(&repo, &["remote", "add", "origin", "https://github.com/o/r.git"]);
        sh(&repo, &["update-ref", "refs/remotes/origin/master", "master"]);
        sh(&repo, &["branch", "--set-upstream-to=origin/master", "master"]);
        let pid = task.project_id.as_ref().unwrap();
        s.db().execute("UPDATE profiles SET github_account='profile-login' WHERE id=?1", [&task.profile_id]).unwrap();
        s.db().execute("UPDATE projects SET github_account='project-login' WHERE id=?1", [pid]).unwrap();
        for (title, expected) in [("Project account", "project-login"), ("Profile account", "profile-login")] {
            let t = create_task_inner(&s, pid, CreateTask { title: title.into(), ..Default::default() }).unwrap();
            let t = setup(&s, &t.id).await.unwrap();
            let log = db::list_messages(&s.db(), &t.id).unwrap();
            let warning = log.iter().find(|m| m.kind == "event" && m.data["level"] == "warn").unwrap();
            let detail = warning.data["detail"].as_str().unwrap();
            assert!(detail.contains(&format!("--user={expected}")), "{detail}");
            assert_eq!(rev(Path::new(t.worktree_path.as_ref().unwrap()), "HEAD"), rev(&repo, "master"));
            s.db().execute("UPDATE projects SET github_account=NULL WHERE id=?1", [pid]).unwrap();
        }
        crate::mcp::gh_mcp::TEST_GH_PROGRAM.set(None);
        std::fs::remove_dir_all(&repo).ok();
    })
}

fn rev(dir: &Path, rev: &str) -> String {
    let out = std::process::Command::new("git").arg("-C").arg(dir).args(["rev-parse", rev]).output().unwrap();
    String::from_utf8(out.stdout).unwrap().trim().to_string()
}

#[test]
fn keeps_what_the_teardown_script_leaves() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (repo, t, wt, branch) = task_with_work(&s).await;
        sh(&repo, &["merge", "-q", "--no-ff", "-m", "merge", &branch]);
        db::update_task(&s.db(), &t.id, &[("status", json!("done"))]).unwrap();
        let pid = t.project_id.clone().unwrap();
        s.db().execute("UPDATE projects SET teardown_script='printf backup > notes' WHERE id=?1", [&pid]).unwrap();

        let e = remove_if_merged(&s, &t.id, true).await.unwrap_err();
        assert!(format!("{e:#}").contains("notes"), "{e:#}");
        assert_eq!(std::fs::read_to_string(wt.join("notes")).unwrap(), "backup");
        assert_eq!(db::get_task(&s.db(), &t.id).unwrap().unwrap().worktree_state, "ready");
        // The sweep says why.
        std::fs::remove_file(wt.join("notes")).unwrap();
        let results = remove_merged(&s, &pid).await.unwrap();
        assert_eq!(results[0]["removed"], json!(false));
        assert!(results[0]["detail"].as_str().unwrap().contains("teardown script left uncommitted changes"));
        std::fs::remove_dir_all(&repo).ok();
    })
}

#[test]
fn keeps_it_while_a_reviewer_works_in_it() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (repo, t, wt, branch) = task_with_work(&s).await;
        sh(&repo, &["merge", "-q", "--no-ff", "-m", "merge", &branch]);
        let r = db::NewTask { profile_id: &t.profile_id, project_id: t.project_id.as_deref(), kind: "review", title: "Review", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let r = db::insert_task(&s.db(), r).unwrap();
        db::update_task(&s.db(), &r.id, &[("parent_id", json!(t.id)), ("running", json!(true))]).unwrap();
        db::update_task(&s.db(), &t.id, &[("status", json!("done"))]).unwrap();

        assert_eq!(remove_if_merged(&s, &t.id, true).await.unwrap(), kept("an agent is working in it"));
        assert!(wt.exists());
        db::update_task(&s.db(), &r.id, &[("running", json!(false))]).unwrap();
        assert_eq!(remove_if_merged(&s, &t.id, true).await.unwrap(), Removal::Removed("master".into()));
        std::fs::remove_dir_all(&repo).ok();
    })
}

#[test]
fn keeps_changes_git_status_is_told_to_skip() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (repo, t, wt, branch) = task_with_work(&s).await;
        sh(&repo, &["merge", "-q", "--no-ff", "-m", "merge", &branch]);
        db::update_task(&s.db(), &t.id, &[("status", json!("done"))]).unwrap();
        let remove = async || remove_if_merged(&s, &t.id, true).await.unwrap();

        // Marked but unchanged, it's clean.
        sh(&wt, &["update-index", "--assume-unchanged", "a"]);
        sh(&wt, &["update-index", "--skip-worktree", ".gitignore"]);
        assert_eq!(uncommitted(&wt).await.unwrap(), "");
        for (file, mark) in [("a", "assume-unchanged"), (".gitignore", "skip-worktree")] {
            std::fs::write(wt.join(file), "local edit").unwrap();
            assert!(uncommitted(&wt).await.unwrap().contains(&format!("{file} (marked {mark})")));
            assert_eq!(remove().await, kept("it has 1 uncommitted or untracked file"));
            assert_eq!(std::fs::read_to_string(wt.join(file)).unwrap(), "local edit");
            sh(&wt, &["update-index", &format!("--no-{mark}"), file]);
            sh(&wt, &["checkout", "--", file]);
        }
        // The sweep keeps it too.
        sh(&wt, &["update-index", "--assume-unchanged", "a"]);
        std::fs::write(wt.join("a"), "local edit").unwrap();
        let results = remove_merged(&s, t.project_id.as_deref().unwrap()).await.unwrap();
        assert_eq!((&results[0]["removed"], &results[0]["detail"]), (&json!(false), &json!("it has 1 uncommitted or untracked file")));
        assert_eq!(std::fs::read_to_string(wt.join("a")).unwrap(), "local edit");
        // A skip-worktree file that isn't there (as in a sparse checkout) has nothing to lose.
        sh(&wt, &["update-index", "--no-assume-unchanged", "a"]);
        sh(&wt, &["checkout", "--", "a"]);
        sh(&wt, &["update-index", "--skip-worktree", "a"]);
        std::fs::remove_file(wt.join("a")).unwrap();
        assert_eq!(remove().await, Removal::Removed("master".into()));
        std::fs::remove_dir_all(&repo).ok();
    })
}

#[test]
fn keeps_mode_changes_and_files_whatever_their_names() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (repo, t, wt, branch) = task_with_work(&s).await;
        let odd = OsStr::from_bytes(b"config-\xff");
        std::fs::write(wt.join(odd), "x").unwrap();
        sh(&wt, &["add", "."]);
        sh(&wt, &["commit", "-qm", "odd"]);
        sh(&repo, &["merge", "-q", "--no-ff", "-m", "merge", &branch]);
        db::update_task(&s.db(), &t.id, &[("status", json!("done"))]).unwrap();
        let pid = t.project_id.clone().unwrap();
        let mark = |file: &OsStr, flag: &str| {
            let ok = std::process::Command::new("git").arg("-C").arg(&wt).args(["update-index", flag, "--"]).arg(file).status().unwrap().success();
            assert!(ok, "git update-index {flag}");
        };
        let teardown_script = |script: &str| {
            s.db().execute("UPDATE projects SET teardown_script=?1 WHERE id=?2", [script, &pid]).unwrap();
        };
        let chmod = |file: &str, mode: u32| std::fs::set_permissions(wt.join(file), std::fs::Permissions::from_mode(mode)).unwrap();
        let sweep = async || {
            let results = remove_merged(&s, &pid).await.unwrap();
            (results[0]["removed"].clone(), results[0]["detail"].clone())
        };
        let one_file = (json!(false), json!("it has 1 uncommitted or untracked file"));

        // Only the executable bit of a marked file changed.
        mark(OsStr::new("a"), "--assume-unchanged");
        chmod("a", 0o755);
        assert_eq!(sweep().await, one_file);
        chmod("a", 0o644);
        assert_eq!(uncommitted(&wt).await.unwrap(), "");
        // ...by the teardown script.
        teardown_script("chmod +x a");
        let e = remove_if_merged(&s, &t.id, true).await.unwrap_err();
        assert!(format!("{e:#}").contains("a (marked assume-unchanged)"), "{e:#}");
        assert_eq!(db::get_task(&s.db(), &t.id).unwrap().unwrap().worktree_state, "ready");
        chmod("a", 0o644);
        teardown_script("");

        // A marked file whose name isn't UTF-8.
        mark(odd, "--skip-worktree");
        std::fs::write(wt.join(odd), "local edit").unwrap();
        assert_eq!(sweep().await, one_file);
        assert_eq!(std::fs::read_to_string(wt.join(odd)).unwrap(), "local edit");
        std::fs::write(wt.join(odd), "x").unwrap();
        assert_eq!(uncommitted(&wt).await.unwrap(), "");
        // ...edited by the teardown script.
        teardown_script(r"printf more >> config-$'\xff'");
        let e = remove_if_merged(&s, &t.id, true).await.unwrap_err();
        assert!(format!("{e:#}").contains("config-"), "{e:#}");
        assert_eq!(std::fs::read_to_string(wt.join(odd)).unwrap(), "xmore");
        assert!(wt.exists());
        std::fs::remove_dir_all(&repo).ok();
    })
}
