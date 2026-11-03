use super::*;
use axum::http::StatusCode;

fn git(dir: &FsPath, args: &[&str]) {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"])
        .args(args)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

fn write(path: PathBuf, content: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
}

fn skill_md(name: &str, description: &str) -> String {
    format!("---\nname: {name}\ndescription: {description}\n---\n\nUse {name}.\n")
}

/// A repository with a skill of its own (with a script) at its root, like asd-ste100-skill.
fn root_skill_repo(dir: &FsPath) {
    std::fs::create_dir_all(dir).unwrap();
    git(dir, &["init", "-q", "-b", "main"]);
    write(dir.join("SKILL.md"), &skill_md("ste-writer", "Writes in STE"));
    write(dir.join("scripts/lint.py"), "print('lint')\n");
    write(dir.join("references/rules.md"), "rules\n");
    git(dir, &["add", "."]);
    git(dir, &["commit", "-q", "-m", "init"]);
}

#[test]
fn normalizes_what_to_clone() {
    let ok = |u: &str| normalize_url(u).unwrap();
    assert_eq!(ok("danyuchn/asd-ste100-skill"), "https://github.com/danyuchn/asd-ste100-skill");
    assert_eq!(ok(" owner/repo.git "), "https://github.com/owner/repo");
    assert_eq!(ok("https://github.com/o/r"), "https://github.com/o/r");
    assert_eq!(ok("git@github.com:o/r.git"), "git@github.com:o/r.git");
    assert_eq!(ok("ssh://git@host/o/r"), "ssh://git@host/o/r");
    assert_eq!(ok("/srv/repo"), "/srv/repo");
    for bad in ["", "  ", "--upload-pack=x", "-c", "ext::sh -c id", "ext::sh%20-c%20id", "fd::3", "ftp://x/y", "a/b/c", "../x", "owner", "https://x y", "a/b\nc", "./rel/path"] {
        assert!(normalize_url(bad).is_err(), "{bad:?}");
    }
    assert_eq!(check_ref(None).unwrap(), None);
    assert_eq!(check_ref(Some("  ".into())).unwrap(), None);
    assert_eq!(check_ref(Some("v1.2/x".into())).unwrap(), Some("v1.2/x".into()));
    for bad in ["--foo", "a b", "a..b", "/x", "a;b"] {
        assert!(check_ref(Some(bad.into())).is_err(), "{bad:?}");
    }
    assert_eq!(source_name("https://github.com/o/my-skills.git"), "my-skills");
    assert_eq!(source_name("git@host:o/r"), "r");
    assert_eq!(source_name("/srv/repos/skills/"), "skills");
}

#[test]
fn finds_the_skills_in_a_repository() {
    let root = crate::testing::temp_dir();
    write(root.join("skills/alpha/SKILL.md"), &skill_md("alpha", "A"));
    // Inside a skill: part of it.
    write(root.join("skills/alpha/nested/SKILL.md"), &skill_md("inside-alpha", "Belongs to alpha"));
    write(root.join("skills/beta/SKILL.md"), &skill_md("beta", "B"));
    // The same skill mirrored for another agent: the visible folder wins.
    write(root.join(".claude/skills/alpha/SKILL.md"), &skill_md("alpha", "A again"));
    write(root.join(".claude/skills/gamma/SKILL.md"), &skill_md("gamma", "G"));
    write(root.join("skills/bad/SKILL.md"), "no frontmatter");
    write(root.join("skills/Upper/SKILL.md"), &skill_md("Upper Case", "x"));
    write(root.join("node_modules/pkg/SKILL.md"), &skill_md("from-node-modules", "x"));
    write(root.join(".git/hooks/SKILL.md"), &skill_md("from-git", "x"));
    write(root.join(".hidden/SKILL.md"), &skill_md("from-hidden", "x"));
    let (found, notes) = discover(&root);
    let names: Vec<(&str, &str)> = found.iter().map(|f| (f.path.as_str(), f.name.as_str())).collect();
    assert_eq!(names, [("skills/alpha", "alpha"), ("skills/beta", "beta"), (".claude/skills/gamma", "gamma")]);
    assert_eq!(found[0].content, skill_md("alpha", "A"));
    assert!(notes.iter().any(|n| n.starts_with("skills/bad:")), "{notes:?}");
    assert!(notes.iter().any(|n| n.starts_with("skills/Upper:")), "{notes:?}");
    assert!(notes.iter().any(|n| n.starts_with(".claude/skills/alpha:") && n.contains("another skill is named alpha")), "{notes:?}");
    assert_eq!(notes.len(), 3);

    // A skill at the root owns the whole repository.
    let single = crate::testing::temp_dir();
    root_skill_repo(&single);
    let (found, notes) = discover(&single);
    assert_eq!(found.len(), 1);
    assert_eq!((found[0].path.as_str(), found[0].name.as_str()), ("", "ste-writer"));
    assert!(notes.is_empty());

    // A link to a SKILL.md elsewhere isn't a skill.
    let linked = crate::testing::temp_dir();
    std::fs::create_dir_all(linked.join("s")).unwrap();
    write(linked.join("elsewhere/SKILL.md"), &skill_md("linked", "x"));
    std::os::unix::fs::symlink(linked.join("elsewhere/SKILL.md"), linked.join("s/SKILL.md")).unwrap();
    std::os::unix::fs::symlink(linked.join("elsewhere"), linked.join("dir-link")).unwrap();
    let names: Vec<String> = discover(&linked).0.into_iter().map(|f| f.path).collect();
    assert_eq!(names, ["elsewhere"]);
}

#[test]
fn copies_a_skill_folder_and_keeps_to_it() {
    let root = crate::testing::temp_dir();
    let (from, to) = (root.join("from"), root.join("to"));
    write(from.join("SKILL.md"), "skill");
    write(from.join("scripts/run.sh"), "#!/bin/sh\n");
    write(from.join(".git/config"), "secret");
    std::os::unix::fs::symlink("/etc/hostname", from.join("link")).unwrap();
    std::os::unix::fs::symlink("/etc", from.join("linked-dir")).unwrap();
    // What an earlier copy left: a file that has gone, a file where there's a folder now.
    write(to.join("gone.txt"), "x");
    write(to.join("scripts"), "was a file");
    copy_skill(&from, &to).unwrap();
    assert_eq!(std::fs::read_to_string(to.join("SKILL.md")).unwrap(), "skill");
    assert_eq!(std::fs::read_to_string(to.join("scripts/run.sh")).unwrap(), "#!/bin/sh\n");
    for gone in ["gone.txt", ".git", "link", "linked-dir"] {
        assert!(std::fs::symlink_metadata(to.join(gone)).is_err(), "{gone}");
    }
    // Files that are right aren't rewritten.
    let before = std::fs::metadata(to.join("SKILL.md")).unwrap().modified().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(20));
    copy_skill(&from, &to).unwrap();
    assert_eq!(std::fs::metadata(to.join("SKILL.md")).unwrap().modified().unwrap(), before);
    write(from.join("SKILL.md"), "skill 2");
    copy_skill(&from, &to).unwrap();
    assert_eq!(std::fs::read_to_string(to.join("SKILL.md")).unwrap(), "skill 2");

    // A change that's only to a script's permissions reaches the copy, both ways.
    let (script, copy) = (from.join("scripts/run.sh"), to.join("scripts/run.sh"));
    let mode = |p: &FsPath| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o644)).unwrap();
    copy_skill(&from, &to).unwrap();
    assert_eq!(mode(&copy), 0o644);
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    copy_skill(&from, &to).unwrap();
    assert_eq!(mode(&copy), 0o755);
}

#[test]
fn adds_updates_and_removes_a_skill_source() {
    crate::testing::run(async || {
        let state = crate::testing::state();
        let repo = crate::testing::temp_dir().join("repo");
        root_skill_repo(&repo);
        let url = crate::util::path_str(&repo);
        let add = |url: &str, r: Option<&str>| add_source(State(state.clone()), Json(AddSource { url: Some(url.into()), git_ref: r.map(String::from) }));

        // Added, its skill is off everywhere.
        let Json(v) = add(&url, None).await.unwrap();
        let (source_id, skill_id) = (v["source"]["id"].as_str().unwrap().to_string(), v["skills"][0]["id"].as_str().unwrap().to_string());
        assert_eq!(v["source"]["name"], "repo");
        assert_eq!(v["skills"][0]["name"], "ste-writer");
        assert_eq!(v["skills"][0]["source_id"], source_id);
        assert_eq!(v["skills"][0]["description"], "Writes in STE");
        assert!(state.data_dir.join("skill-sources").join(&source_id).join("scripts/lint.py").is_file());
        assert!(!state.data_dir.join("skill-sources").join(format!("{source_id}.new")).exists());
        // Not twice, not with a ref that isn't there, and not with something that isn't a repository.
        assert_eq!(add(&url, None).await.unwrap_err().0, StatusCode::CONFLICT);
        assert_eq!(add(&url, Some("nope")).await.unwrap_err().0, StatusCode::BAD_GATEWAY);
        assert_eq!(add("ext::sh -c id", None).await.unwrap_err().0, StatusCode::BAD_REQUEST);
        assert_eq!(add(&crate::util::path_str(&crate::testing::temp_dir()), None).await.unwrap_err().0, StatusCode::BAD_GATEWAY);
        assert_eq!(list_sources(&state.db()).unwrap().len(), 1);

        // A project of a profile switched on for it runs with the skill's whole folder.
        let (profile, project) = {
            let c = state.db();
            let profile = crate::db::insert_profile(&c, "p", &[], None).unwrap();
            let np = crate::db::NewProject {
                id: "pr", profile_id: &profile.id, name: "x", key: "X", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false,
            };
            let project = crate::db::insert_project(&c, np).unwrap();
            (profile, project)
        };
        let skills_dir = state.data_dir.join("projects/pr/agent/.claude/skills/ste-writer");
        assert!(for_run(&state, "pr", None).unwrap().skills_dir.is_none());
        let on = |scope: &str, scope_id: &str, source: Option<&str>, item: Option<&str>, enabled: Option<bool>| {
            set_switch(
                State(state.clone()),
                Json(SwitchBody { scope: scope.into(), scope_id: scope_id.into(), item_id: item.map(String::from), source_id: source.map(String::from), enabled }),
            )
        };
        let _ = on("profile", &profile.id, Some(&source_id), None, Some(true)).await.unwrap();
        assert_eq!(switches(&state.db(), "profile", &profile.id).unwrap().get(&skill_id), Some(&Value::Bool(true)));
        assert!(for_run(&state, "pr", None).unwrap().skills_dir.is_some());
        assert_eq!(std::fs::read_to_string(skills_dir.join("scripts/lint.py")).unwrap(), "print('lint')\n");
        assert_eq!(std::fs::read_to_string(skills_dir.join("references/rules.md")).unwrap(), "rules\n");
        assert!(!skills_dir.join(".git").exists());
        // The project can turn it off.
        let _ = on("project", &project.id, None, Some(&skill_id), Some(false)).await.unwrap();
        assert!(for_run(&state, "pr", None).unwrap().skills_dir.is_none());
        let _ = on("project", &project.id, None, Some(&skill_id), None).await.unwrap();
        assert!(on("profile", &profile.id, None, None, Some(true)).await.is_err());
        assert!(on("profile", &profile.id, Some("missing"), None, Some(true)).await.is_err());

        // A source's skill is changed in its repository, not by itself.
        let edit = SkillBody { content: Some(skill_md("ste-writer", "mine")), enabled: None };
        assert_eq!(update_skill_in(&state.db(), None, &skill_id, edit).unwrap_err().0, StatusCode::BAD_REQUEST);
        assert_eq!(delete_in(&state.db(), "agent_skills", None, &skill_id).err().unwrap().0, StatusCode::BAD_REQUEST);
        let name_taken = create_skill_in(&state.db(), None, SkillBody { content: Some(skill_md("ste-writer", "x")), enabled: None });
        assert_eq!(name_taken.unwrap_err().0, StatusCode::CONFLICT);

        // The repository changes: a changed script and skill, and a file less.
        write(repo.join("scripts/lint.py"), "print('lint 2')\n");
        std::fs::remove_file(repo.join("references/rules.md")).unwrap();
        write(repo.join("SKILL.md"), &skill_md("ste-writer", "Writes better"));
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-q", "-m", "more"]);
        let Json(v) = update_source(State(state.clone()), Path(source_id.clone())).await.unwrap();
        assert_eq!(v["skills"].as_array().unwrap().len(), 1);
        assert_eq!(v["skills"][0]["id"], skill_id, "the skill keeps its id, and so its switches");
        assert_eq!(v["skills"][0]["description"], "Writes better");
        assert_eq!(v["source"]["error"], Value::Null);
        for_run(&state, "pr", None).unwrap();
        assert_eq!(std::fs::read_to_string(skills_dir.join("scripts/lint.py")).unwrap(), "print('lint 2')\n");
        assert!(!skills_dir.join("references/rules.md").exists());

        // The repository goes away: the update fails, and what was there stays.
        std::fs::rename(&repo, repo.with_file_name("moved")).unwrap();
        let err = update_source(State(state.clone()), Path(source_id.clone())).await.unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_GATEWAY);
        let source = get_source(&state.db(), &source_id).unwrap().unwrap();
        assert!(source.error.is_some_and(|e| e.contains("couldn't clone")));
        assert_eq!(skills_of(&state.db(), &source_id).unwrap().len(), 1);
        assert!(state.data_dir.join("skill-sources").join(&source_id).join("scripts/lint.py").is_file());
        assert!(!state.data_dir.join("skill-sources").join(format!("{source_id}.new")).exists());
        std::fs::rename(repo.with_file_name("moved"), &repo).unwrap();

        // The skill's folder moves, as it does once a repository has a second skill: the same skill, with its switches.
        std::fs::create_dir_all(repo.join("skills/ste-writer")).unwrap();
        for entry in ["SKILL.md", "scripts"] {
            git(&repo, &["mv", entry, &format!("skills/ste-writer/{entry}")]);
        }
        git(&repo, &["commit", "-q", "-m", "move"]);
        let Json(v) = update_source(State(state.clone()), Path(source_id.clone())).await.unwrap();
        assert_eq!(v["skills"].as_array().unwrap().len(), 1, "{v}");
        assert_eq!(v["skills"][0]["id"], skill_id);
        assert_eq!(v["source"]["notes"], json!([]));
        assert_eq!(switches(&state.db(), "profile", &profile.id).unwrap().get(&skill_id), Some(&Value::Bool(true)));
        assert!(for_run(&state, "pr", None).unwrap().skills_dir.is_some());
        assert_eq!(std::fs::read_to_string(skills_dir.join("scripts/lint.py")).unwrap(), "print('lint 2')\n");
        git(&repo, &["mv", "skills/ste-writer/SKILL.md", "SKILL.md"]);
        git(&repo, &["mv", "skills/ste-writer/scripts", "scripts"]);
        git(&repo, &["commit", "-q", "-m", "move back"]);
        let Json(v) = update_source(State(state.clone()), Path(source_id.clone())).await.unwrap();
        assert_eq!(v["skills"][0]["id"], skill_id);

        // The skill goes from the repository and a new one comes: the old one is removed with its switches.
        std::fs::remove_file(repo.join("SKILL.md")).unwrap();
        write(repo.join("skills/fresh/SKILL.md"), &skill_md("fresh", "New"));
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-q", "-m", "restructure"]);
        let Json(v) = update_source(State(state.clone()), Path(source_id.clone())).await.unwrap();
        let names: Vec<&str> = v["skills"].as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["fresh"]);
        assert_eq!(v["source"]["error"], Value::Null);
        assert!(switches(&state.db(), "profile", &profile.id).unwrap().is_empty());
        assert!(for_run(&state, "pr", None).unwrap().skills_dir.is_none());
        assert!(!skills_dir.exists());

        // Removing the source takes its skills and clone.
        let _ = delete_source(State(state.clone()), Path(source_id.clone())).await.unwrap();
        assert!(list_sources(&state.db()).unwrap().is_empty());
        assert!(list_skills(&state.db(), None).unwrap().is_empty());
        assert!(!state.data_dir.join("skill-sources").join(&source_id).exists());
        assert_eq!(delete_source(State(state.clone()), Path(source_id)).await.unwrap_err().0, StatusCode::NOT_FOUND);
    })
}

#[test]
fn a_source_whose_skills_names_are_taken_isnt_added() {
    crate::testing::run(async || {
        let state = crate::testing::state();
        create_skill_in(&state.db(), None, SkillBody { content: Some(skill_md("ste-writer", "mine")), enabled: None }).unwrap();
        let repo = crate::testing::temp_dir().join("repo");
        root_skill_repo(&repo);
        let err = add_source(State(state.clone()), Json(AddSource { url: Some(crate::util::path_str(&repo)), git_ref: None })).await.unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert!(err.1.contains("no skills found") && err.1.contains("already on this host"), "{}", err.1);
        assert!(list_sources(&state.db()).unwrap().is_empty());
        let clones = state.data_dir.join("skill-sources");
        assert!(!clones.exists() || std::fs::read_dir(clones).unwrap().count() == 0);
    })
}

/// A source's skills trade names, or pass them along, in one commit: they stay the same skills, with their switches.
#[test]
fn a_source_whose_skills_swap_or_pass_on_names_keeps_them() {
    crate::testing::run(async || {
        let state = crate::testing::state();
        let repo = crate::testing::temp_dir().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        for name in ["alpha", "beta", "gamma"] {
            write(repo.join(format!("skills/{name}/SKILL.md")), &skill_md(name, name));
        }
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "init"]);
        let Json(v) = add_source(State(state.clone()), Json(AddSource { url: Some(crate::util::path_str(&repo)), git_ref: None })).await.unwrap();
        let source_id = v["source"]["id"].as_str().unwrap().to_string();
        let ids = |v: &Value| -> Vec<(String, String)> {
            v["skills"].as_array().unwrap().iter().map(|s| (s["name"].as_str().unwrap().to_string(), s["id"].as_str().unwrap().to_string())).collect()
        };
        let before = ids(&v);
        let id_of = |name: &str| before.iter().find(|(n, _)| n == name).unwrap().1.clone();
        let profile = crate::db::insert_profile(&state.db(), "p", &[], None).unwrap();
        set_switch(
            State(state.clone()),
            Json(SwitchBody { scope: "profile".into(), scope_id: profile.id.clone(), item_id: None, source_id: Some(source_id.clone()), enabled: Some(true) }),
        )
        .await
        .unwrap();

        // alpha → beta, beta → gamma (a chain), and gamma → alpha: a cycle.
        let rename = |dir: &str, name: &str| write(repo.join(format!("skills/{dir}/SKILL.md")), &skill_md(name, "renamed"));
        rename("alpha", "beta");
        rename("beta", "gamma");
        rename("gamma", "alpha");
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-q", "-m", "rotate"]);
        let Json(v) = update_source(State(state.clone()), Path(source_id.clone())).await.unwrap();
        assert_eq!(v["source"]["notes"], json!([]), "{v}");
        let now = ids(&v);
        // Each folder's skill keeps its id (matched by folder) under its new name.
        assert_eq!(now, [("alpha".to_string(), id_of("gamma")), ("beta".to_string(), id_of("alpha")), ("gamma".to_string(), id_of("beta"))]);
        let on = switches(&state.db(), "profile", &profile.id).unwrap();
        assert!(before.iter().all(|(_, id)| on.get(id) == Some(&Value::Bool(true))));

        // A swap of two: the folders of alpha and gamma (named beta and alpha now) trade names.
        rename("alpha", "alpha");
        rename("gamma", "beta");
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-q", "-m", "swap"]);
        let Json(v) = update_source(State(state.clone()), Path(source_id.clone())).await.unwrap();
        assert_eq!(v["source"]["notes"], json!([]), "{v}");
        assert_eq!(v["skills"].as_array().unwrap().len(), 3);
        assert!(switches(&state.db(), "profile", &profile.id).unwrap().len() == 3);

        // A name another global skill has still leaves out the one that wants it, and only that one.
        create_skill_in(&state.db(), None, SkillBody { content: Some(skill_md("delta", "mine")), enabled: None }).unwrap();
        rename("alpha", "delta");
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-q", "-m", "clash"]);
        let Json(v) = update_source(State(state.clone()), Path(source_id)).await.unwrap();
        assert_eq!(v["skills"].as_array().unwrap().len(), 2);
        assert!(v["source"]["notes"][0].as_str().unwrap().contains("already on this host"));
    })
}
