use super::*;

#[test]
fn reads_skill_frontmatter() {
    let f = frontmatter("---\nname: deploy\ndescription: \"Deploy the app\"\nallowed-tools: Bash\n---\n\nBody\n").unwrap();
    assert_eq!(f, Frontmatter { name: "deploy".into(), description: "Deploy the app".into(), user_invocable: true });
    let f = frontmatter("---\nname: 'x'\ndescription: >\n  Folded\n  text\nother: 1\nuser-invocable: false\n---\n").unwrap();
    assert_eq!(f, Frontmatter { name: "x".into(), description: "Folded text".into(), user_invocable: false });
    // As Claude Code reads it.
    let invocable = |v: &str| frontmatter(&format!("---\nname: x\nuser-invocable: {v}\n---\n")).unwrap().user_invocable;
    for v in ["true", "TRUE", "Yes", "on", "1", "true # x", "\"true\"", "'yes' # x"] {
        assert!(invocable(v), "{v}");
    }
    for v in ["false", "FALSE", "no", "off", "0", "false # Only the model", "'false'", "\"true # x\"", "", "# x", "maybe", "true maybe"] {
        assert!(!invocable(v), "{v}");
    }
    assert!(frontmatter("---\nname: x\n---\n").unwrap().user_invocable);
    assert!(frontmatter("no frontmatter").is_none());
    assert!(frontmatter("---\nname: unterminated\n").is_none());
}

#[test]
fn checks_skills() {
    assert!(check_skill("---\nname: ok-1\ndescription: d\n---\n").is_ok());
    assert!(check_skill("---\nname: Bad Name\ndescription: d\n---\n").is_err());
    assert!(check_skill("---\nname: ok\n---\n").is_err());
    assert!(check_skill("# just markdown").is_err());
    let long = |n: usize| format!("---\nname: ok\ndescription: {}\n---\n", "é".repeat(n));
    assert!(check_skill(&long(MAX_DESCRIPTION)).is_ok());
    assert!(check_skill(&long(MAX_DESCRIPTION + 1)).is_err());
    assert!(valid_other_skill("pdf") && valid_other_skill("my-plugin:do_it") && valid_other_skill("Legacy.Command"));
    assert!(!valid_other_skill("two words") && !valid_other_skill("x)") && !valid_other_skill("a,b") && !valid_other_skill(""));
}

#[test]
fn saved_bad_skill_names_dont_block_toggles() {
    let names = |v: &[&str]| v.iter().map(|n| n.to_string()).collect::<Vec<_>>();
    let saved = names(&["old one", "other bad", "pdf"]);
    // Toggling another skill keeps the saved bad names instead of failing, and switching one
    // back on still works while the other is sent.
    assert_eq!(check_disabled_skills(&saved, names(&["docx", "old one", "other bad", "pdf"])).unwrap(), ["docx", "old one", "other bad", "pdf"]);
    assert_eq!(check_disabled_skills(&saved, names(&["other bad"])).unwrap(), ["other bad"]);
    // New bad names are still refused.
    assert!(check_disabled_skills(&saved, names(&["new bad", "pdf"])).is_err());
}

#[test]
fn checks_server_configs() {
    assert_eq!(check_server_config(&json!({"url": "https://x"})).unwrap()["type"], "http");
    assert_eq!(check_server_config(&json!({"command": "npx", "args": ["-y", "pkg"]})).unwrap()["type"], "stdio");
    assert!(check_server_config(&json!({"type": "stdio"})).is_err());
    assert!(check_server_config(&json!({"command": "x", "args": "-y"})).is_err());
    assert!(check_server_config(&json!({"url": "https://x", "headers": {"a": 1}})).is_err());
    assert!(check_server_config(&json!({"type": "ws", "url": "x"})).is_err());
    assert!(check_server_name(MCP_SERVER_NAME).is_err());
    assert!(check_server_name("has space").is_err());
}

#[test]
fn names_server_tools_like_claude_code() {
    assert_eq!(tool_prefix("claude.ai Google Drive"), "mcp__claude_ai_Google_Drive");
    assert_eq!(tool_prefix("my-server_2"), "mcp__my-server_2");
}

#[test]
fn syncs_the_skills_dir() {
    let dir = crate::testing::temp_dir().join("skills");
    let skill = |name: &str, content: &str| Skill {
        id: name.into(),
        project_id: Some("p".into()),
        name: name.into(),
        description: String::new(),
        content: content.into(),
        enabled: true,
        created_at: String::new(),
        updated_at: String::new(),
    };
    let (a, b) = (skill("a", "A"), skill("b", "B"));
    sync_skills(&dir, &[&a, &b]).unwrap();
    assert_eq!(std::fs::read_to_string(dir.join("b/SKILL.md")).unwrap(), "B");
    let a2 = skill("a", "A2");
    sync_skills(&dir, &[&a2]).unwrap();
    assert_eq!(std::fs::read_to_string(dir.join("a/SKILL.md")).unwrap(), "A2");
    assert!(!dir.join("b").exists());
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn lists_a_claude_tasks_skills() {
    let root = crate::testing::temp_dir();
    let (config, repo) = (root.join("config"), root.join("repo"));
    let skill = |dir: PathBuf, name: &str, description: &str, extra: &str| {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), format!("---\nname: {name}\ndescription: {description}\n{extra}---\n")).unwrap();
    };
    let (personal, project) = (config.join("skills"), repo.join(".claude/skills"));
    skill(personal.join("mine"), "mine", "My own", "");
    skill(project.join("repo-skill"), "repo-skill", "From the repository", "");
    skill(project.join("user-only"), "user-only", "User only", "disable-model-invocation: true\n");
    // Changed since the last run so that only the model can call it.
    skill(project.join("hidden"), "hidden", "Hidden", "user-invocable: false\n");
    // A frontmatter name that's another skill's folder doesn't hide or describe that skill,
    // whether it sorts before it, can be called or is in another folder.
    skill(project.join("aaa-draft"), "deploy", "Draft", "");
    skill(project.join("deploy"), "deploy", "Deploy", "");
    skill(project.join("aab-hidden"), "deploy2", "Hidden draft", "user-invocable: false\n");
    skill(project.join("deploy2"), "deploy2", "Deploy 2", "");
    skill(personal.join("x"), "review", "Personal x", "");
    skill(project.join("review"), "review", "Review", "");
    // Plugins' skills are read from the versions installed, not older ones in the cache.
    let cache = config.join("plugins/cache/market");
    skill(cache.join("plug/1.0.0/skills/lint"), "lint", "Old lints", "user-invocable: false\n");
    skill(cache.join("plug/2.0.0/skills/lint"), "lint", "Lints", "");
    skill(cache.join("upgraded/1.0.0/skills/review"), "review", "Old review", "");
    skill(cache.join("upgraded/2.0.0/skills/review"), "review", "Review", "user-invocable: false\n");
    skill(cache.join("upgraded/1.0.0/skills/fixed"), "fixed", "Old fixed", "user-invocable: false\n");
    skill(cache.join("upgraded/2.0.0/skills/fixed"), "fixed", "Fixed", "");
    let install = |v: &str| json!([{"scope": "user", "installPath": crate::util::path_str(&cache.join(v))}]);
    let main = root.join("main");
    let scoped = |v: &str, scope: &str, project: &FsPath| {
        json!({"scope": scope, "projectPath": crate::util::path_str(project), "installPath": crate::util::path_str(&cache.join(v))})
    };
    let scoped = json!([
        scoped("scoped/2.0.0", "project", &main),
        scoped("scoped/1.0.0", "project", &root.join("elsewhere")),
        {"scope": "user", "installPath": crate::util::path_str(&cache.join("scoped/0.9.0"))},
    ]);
    let installed =
        json!({"version": 2, "plugins": {"plug@market": install("plug/2.0.0"), "upgraded@market": install("upgraded/2.0.0"), "scoped@market": scoped}});
    std::fs::write(config.join("plugins/installed_plugins.json"), installed.to_string()).unwrap();
    // Hidden since the last run, which reported them by their frontmatter names.
    skill(project.join("source"), "alias-hidden", "Hidden", "user-invocable: false\n");
    skill(cache.join("plug/2.0.0/skills/source-qualified"), "plug:alias-qualified", "Hidden", "user-invocable: false\n");
    skill(cache.join("plug/2.0.0/skills/psrc"), "alias-plugin", "Hidden", "user-invocable: no\n");
    // A plugin installed for this project is read from that installation, not another project's or the user's.
    skill(cache.join("scoped/0.9.0/skills/review"), "review", "User's", "user-invocable: false\n");
    skill(cache.join("scoped/1.0.0/skills/review"), "review", "Elsewhere", "user-invocable: false\n");
    skill(cache.join("scoped/2.0.0/skills/review"), "review", "Here", "");
    skill(cache.join("scoped/1.0.0/skills/hidden"), "hidden", "Elsewhere", "");
    skill(cache.join("scoped/2.0.0/skills/hidden"), "hidden", "Here", "user-invocable: false\n");
    skill(personal.join("synced/bucket/pdf"), "pdf", "PDFs", "");
    std::fs::create_dir_all(personal.join("not-a-skill")).unwrap();
    let last_run = [
        "code-review", "anthropic-skills:pdf", "plug:lint", "upgraded:review", "upgraded:fixed", "hidden", "user-only", "deploy", "alias-hidden",
        "plug:alias-qualified", "plug:alias-plugin", "scoped:review", "scoped:hidden",
    ]
    .map(String::from);
    // The task works in `repo` (a worktree, say) of the project checked out at `main`.
    let got = claude_skills(&config, &[repo.clone()], Some(&main), &last_run);
    let got: Vec<(&str, &str)> = got.iter().map(|s| (s.name.as_str(), s.description.as_str())).collect();
    assert_eq!(
        got,
        [
            ("aaa-draft", "Draft"),
            ("anthropic-skills:pdf", "PDFs"),
            ("code-review", ""),
            ("deploy", "Deploy"),
            ("deploy2", "Deploy 2"),
            ("mine", "My own"),
            ("plug:lint", "Lints"),
            ("repo-skill", "From the repository"),
            ("review", "Review"),
            ("scoped:review", "Here"),
            ("upgraded:fixed", "Fixed"),
            ("user-only", "User only"),
            ("x", "Personal x"),
        ]
    );
    // Before any run has reported them, the folders' skills are still there.
    let got = claude_skills(&config, &[], None, &[]);
    assert_eq!(got, [TaskSkill { name: "mine".into(), description: "My own".into() }, TaskSkill { name: "x".into(), description: "Personal x".into() }]);
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn finds_skills_where_the_agent_runs() {
    let state = crate::testing::state();
    let c = state.db();
    let p = crate::db::insert_profile(&c, "p", &[], None).unwrap();
    let np = crate::db::NewProject {
        id: "pr", profile_id: &p.id, name: "x", key: "X", repo_path: "/main", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: true,
    };
    let project = crate::db::insert_project(&c, np).unwrap();
    let new = |project_id: Option<&'static str>, kind: &'static str| crate::db::NewTask {
        profile_id: &p.id, project_id, kind, title: "t", description: "", status: "todo", use_worktree: kind == "task" && project_id.is_some(), model: None,
        effort: None, claude_config_id: None,
    };
    let places = |t: &crate::db::Task| {
        let (cwd, add) = skill_places(&state, &c, t, t.project_id.as_ref().map(|_| &project)).unwrap();
        (cwd.map(|d| crate::util::path_str(&d)).unwrap_or_default(), add.iter().map(|d| crate::util::path_str(d)).collect::<Vec<_>>())
    };
    let task = crate::db::insert_task(&c, new(Some("pr"), "task")).unwrap();
    let review = crate::db::insert_task(&c, new(Some("pr"), "review")).unwrap();
    let review = crate::db::update_task(&c, &review.id, &[("parent_id", json!(task.id))]).unwrap().unwrap();
    // Before the worktree is set up, both run in the main checkout; then in the task's worktree.
    assert_eq!(places(&review), ("/main".into(), vec![]));
    let task = crate::db::update_task(&c, &task.id, &[("worktree_path", json!("/w/1")), ("worktree_state", json!("ready"))]).unwrap().unwrap();
    assert_eq!(places(&task), ("/w/1".into(), vec![]));
    assert_eq!(places(&review), ("/w/1".into(), vec![]));
    // A plan task from before labels works in its own folder, reading the project's checkout.
    let plan = crate::db::insert_task(&c, new(Some("pr"), "task")).unwrap();
    let plan = crate::db::update_task(&c, &plan.id, &[("labels", json!(["plan"])), ("work_dir", json!(format!("documents/{}", plan.id)))]).unwrap().unwrap();
    let doc = crate::util::path_str(&crate::documents::work_dir(&state, &plan).unwrap());
    assert_eq!(places(&plan), (doc, vec!["/main".to_string()]));
    // A scratch task in no project works in its own folder (or its chat's), one without a type in the profile's.
    let scratch = crate::db::insert_task(&c, new(None, "task")).unwrap();
    assert_eq!(places(&scratch).0, crate::util::path_str(&state.profile_scratch_dir(&p.id)));
    let scratch = crate::db::update_task(&c, &scratch.id, &[("task_type", json!("scratch")), ("work_dir", json!("/chat"))]).unwrap().unwrap();
    assert_eq!(places(&scratch), ("/chat".into(), vec![]));
}

#[test]
fn leaves_out_board_skills_turned_off_since() {
    use crate::db::{NewProject, insert_profile, insert_project};
    let c = crate::db::open(FsPath::new(":memory:")).unwrap();
    let profile = insert_profile(&c, "p", &[], None).unwrap();
    let np = NewProject { id: "a", profile_id: &profile.id, name: "a", key: "X", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
    let a = insert_project(&c, np).unwrap();
    let skill = |project: Option<&str>, name: &str| create_skill_in(&c, project, SkillBody { content: Some(format!("---\nname: {name}\ndescription: d\n---\n")), enabled: None }).unwrap();
    let own = skill(Some("a"), "own");
    let global = skill(None, "global");
    skill(None, "never-on");
    let set = |item: &str, v: bool| c.execute("INSERT OR REPLACE INTO agent_tool_switches VALUES ('project','a',?1,?2)", params![item, v]).unwrap();
    set(&global.id, true);
    let off = || board_skills_off(&c, &a, &effective(&c, &a).unwrap().0).unwrap();
    assert_eq!(off(), ["never-on"]);
    // Turned off after a run had them: the project's own one, and a global one switched off for the project.
    update_skill_in(&c, Some("a"), &own.id, SkillBody { content: None, enabled: Some(false) }).unwrap();
    set(&global.id, false);
    let mut got = off();
    got.sort();
    assert_eq!(got, ["global", "never-on", "own"]);
}

#[test]
fn leaves_out_board_skills_deleted_or_renamed_since() {
    use crate::db::{NewProject, insert_profile, insert_project};
    let c = crate::db::open(FsPath::new(":memory:")).unwrap();
    let profile = insert_profile(&c, "p", &[], None).unwrap();
    let np = NewProject { id: "a", profile_id: &profile.id, name: "a", key: "X", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
    let a = insert_project(&c, np).unwrap();
    let content = |name: &str| Some(format!("---\nname: {name}\ndescription: d\n---\n"));
    let skill = |project: Option<&str>, name: &str| create_skill_in(&c, project, SkillBody { content: content(name), enabled: None }).unwrap();
    let (own, renamed, disabled, global) = (skill(Some("a"), "own"), skill(Some("a"), "renamed"), skill(Some("a"), "disabled"), skill(None, "global"));
    c.execute("INSERT INTO agent_tool_switches VALUES ('project','a',?1,1)", [&global.id]).unwrap();
    record_seen(&c, "a", None, &json!({"skills": ["own", "renamed", "disabled", "global", "external"]})).unwrap();
    let reported = || {
        let on = effective(&c, &a).unwrap().0;
        let off = board_skills_off(&c, &a, &on).unwrap();
        reported_skills(get_overrides(&c, "a").unwrap().seen.get(""), &on, &off)
    };
    assert_eq!(reported(), ["disabled", "external", "global", "own", "renamed"]);
    update_skill_in(&c, Some("a"), &disabled.id, SkillBody { content: None, enabled: Some(false) }).unwrap();
    update_skill_in(&c, Some("a"), &renamed.id, SkillBody { content: content("new-name"), enabled: None }).unwrap();
    assert_eq!(reported(), ["external", "global", "own"]);
    // Deleted, after being turned off or not; a run's own skill of the same name would still be found in its folder.
    for id in [&own.id, &disabled.id, &global.id] {
        c.execute("DELETE FROM agent_skills WHERE id=?1", [id]).unwrap();
    }
    assert_eq!(reported(), ["external"]);
}

#[test]
fn forgets_board_skills_deleted_or_renamed_from_runs_recorded_before() {
    use crate::db::{NewProject, insert_profile, insert_project};
    let c = crate::db::open(FsPath::new(":memory:")).unwrap();
    let profile = insert_profile(&c, "p", &[], None).unwrap();
    let new = |id| NewProject { id, profile_id: &profile.id, name: id, key: "X", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
    let (a, b) = (insert_project(&c, new("a")).unwrap(), insert_project(&c, new("b")).unwrap());
    let content = |name: &str| Some(format!("---\nname: {name}\ndescription: d\n---\n"));
    let skill = |project: Option<&str>, name: &str| create_skill_in(&c, project, SkillBody { content: content(name), enabled: None }).unwrap();
    let (own, renamed, disabled, global) = (skill(Some("a"), "own"), skill(Some("a"), "renamed"), skill(Some("a"), "disabled"), skill(None, "global"));
    // Project b has its own skill named like the global one, which stays.
    skill(Some("b"), "global");
    for p in ["a", "b"] {
        c.execute("INSERT INTO agent_tool_switches VALUES ('project',?1,?2,1)", params![p, global.id]).unwrap();
    }
    // Saved as runs recorded them before the board noted which skills were its own.
    let at = "2026-10-01T00:00:00.000Z";
    let names = ["disabled", "external", "global", "own", "renamed"];
    for p in ["a", "b"] {
        let mut o = get_overrides(&c, p).unwrap();
        let skills: Vec<Value> = names.iter().map(|n| json!({"name": n, "at": at})).collect();
        o.seen.insert("cfg".into(), json!({"skills": skills, "mcp_servers": [], "at": at}));
        set_overrides(&c, p, &o).unwrap();
    }
    let reported = |p: &crate::db::Project| {
        let on = effective(&c, p).unwrap().0;
        let off = board_skills_off(&c, p, &on).unwrap();
        reported_skills(get_overrides(&c, &p.id).unwrap().seen.get("cfg"), &on, &off)
    };
    assert_eq!(reported(&a), names);
    update_skill_in(&c, Some("a"), &disabled.id, SkillBody { content: None, enabled: Some(false) }).unwrap();
    update_skill_in(&c, Some("a"), &renamed.id, SkillBody { content: content("new-name"), enabled: None }).unwrap();
    assert_eq!(reported(&a), ["external", "global", "own"]);
    // Deleted, the disabled one too.
    for (project, id) in [(Some("a"), &own.id), (Some("a"), &disabled.id), (None, &global.id)] {
        assert_eq!(delete_in(&c, "agent_skills", project, id).unwrap().0["ok"], true);
    }
    assert_eq!(reported(&a), ["external"]);
    assert_eq!(reported(&b), ["disabled", "external", "global", "own", "renamed"]);
}

#[test]
fn lists_the_skills_the_last_run_reported() {
    let c = crate::db::open(FsPath::new(":memory:")).unwrap();
    c.execute_batch("PRAGMA foreign_keys=OFF;").unwrap();
    record_seen(&c, "p", Some("cfg"), &json!({"skills": ["kept", "hidden-later"]})).unwrap();
    // An earlier run's, which Claude Code stopped reporting once a user couldn't call it.
    let mut o = get_overrides(&c, "p").unwrap();
    for s in o.seen["cfg"]["skills"].as_array_mut().unwrap() {
        s["at"] = json!("2000-01-01T00:00:00.000Z");
    }
    set_overrides(&c, "p", &o).unwrap();
    record_seen(&c, "p", Some("cfg"), &json!({"skills": ["kept"]})).unwrap();
    let o = get_overrides(&c, "p").unwrap();
    assert_eq!(last_run_skills(o.seen.get("cfg")), ["kept"]);
    assert!(last_run_skills(o.seen.get("other")).is_empty());
}

#[test]
fn adds_the_boards_skills_a_user_can_call() {
    let skill = |name: &str, extra: &str| Skill {
        id: name.into(),
        project_id: Some("p".into()),
        name: name.into(),
        description: format!("{name} (board)"),
        content: format!("---\nname: {name}\ndescription: d\n{extra}---\n"),
        enabled: true,
        created_at: String::new(),
        updated_at: String::new(),
    };
    let found = |names: &[&str]| names.iter().map(|n| TaskSkill { name: n.to_string(), description: String::new() }).collect::<Vec<_>>();
    let board = || {
        vec![
            skill("deploy", ""),
            skill("hidden", "user-invocable: false # Only the model\n"),
            skill("no", "user-invocable: No\n"),
            skill("user-only", "disable-model-invocation: true\n"),
        ]
    };
    let names = |s: Vec<TaskSkill>| s.into_iter().map(|s| s.name).collect::<Vec<_>>();
    // Claude Code won't run `/hidden`, even if a run reported a skill by that name.
    let got = with_board_skills(found(&["zeta", "hidden", "deploy"]), board(), false, &["zeta".into()]);
    assert_eq!(got[0], TaskSkill { name: "deploy".into(), description: "deploy (board)".into() });
    assert_eq!(names(got), ["deploy", "user-only"]);
    // Codex has no such setting.
    assert_eq!(names(with_board_skills(Vec::new(), board(), true, &[])), ["deploy", "hidden", "no", "user-only"]);
}

#[test]
fn global_ones_follow_the_profile_unless_the_project_overrides() {
    use crate::db::{NewProject, insert_profile, insert_project};
    let c = crate::db::open(FsPath::new(":memory:")).unwrap();
    let profile = insert_profile(&c, "p", &[], None).unwrap();
    let new = |id| NewProject { id, profile_id: &profile.id, name: id, key: "X", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
    let (a, b) = (insert_project(&c, new("a")).unwrap(), insert_project(&c, new("b")).unwrap());
    let skill = |project: Option<&str>, name: &str| create_skill_in(&c, project, SkillBody { content: Some(format!("---\nname: {name}\ndescription: d\n---\n")), enabled: None }).unwrap();
    let (on, off) = (skill(None, "on"), skill(None, "off"));
    skill(Some("a"), "own");
    let set = |scope: &str, scope_id: &str, item: &str, v: bool| {
        c.execute("INSERT OR REPLACE INTO agent_tool_switches VALUES (?1,?2,?3,?4)", params![scope, scope_id, item, v]).unwrap();
    };
    set("profile", &profile.id, &on.id, true);
    set("project", "b", &on.id, false);
    set("project", "b", &off.id, true);
    let names = |p: &crate::db::Project| effective(&c, p).unwrap().0.into_iter().map(|s| s.name).collect::<Vec<_>>();
    assert_eq!(names(&a), ["own", "on"]);
    assert_eq!(names(&b), ["off"]);
    // A project's own one takes the name while it's on, and the global one is used while it's off.
    let mine = skill(Some("a"), "on");
    let owners = |p: &crate::db::Project| effective(&c, p).unwrap().0.into_iter().map(|s| s.project_id).collect::<Vec<_>>();
    assert_eq!(owners(&a), [Some("a".to_string()), Some("a".to_string())]);
    update_skill_in(&c, Some("a"), &mine.id, SkillBody { content: None, enabled: Some(false) }).unwrap();
    assert_eq!(names(&a), ["own", "on"]);
    assert_eq!(owners(&a), [Some("a".to_string()), None]);
    // Deleting a global skill drops its switches.
    c.execute("DELETE FROM agent_skills WHERE id=?1", [&off.id]).unwrap();
    assert!(switches(&c, "project", "b").unwrap().get(&off.id).is_none());
}

#[test]
fn records_what_runs_had() {
    let c = crate::db::open(FsPath::new(":memory:")).unwrap();
    c.execute_batch("PRAGMA foreign_keys=OFF;").unwrap();
    let init = json!({
        "skills": ["zeta", "alpha"],
        "mcp_servers": [{"name": MCP_SERVER_NAME, "status": "connected"}, {"name": "claude.ai Gmail", "status": "needs-auth", "source": "claudeai"}],
    });
    record_seen(&c, "p", Some("cfg"), &init).unwrap();
    let names = |key: &str| -> Vec<String> {
        let o = get_overrides(&c, "p").unwrap();
        o.seen["cfg"][key].as_array().unwrap().iter().map(|v| v["name"].as_str().unwrap().to_string()).collect()
    };
    assert_eq!(names("skills"), ["alpha", "zeta"]);
    assert_eq!(names("mcp_servers"), ["claude.ai Gmail"]);
    // A later run that doesn't report everything keeps what earlier ones had...
    record_seen(&c, "p", Some("cfg"), &json!({"skills": ["beta"], "mcp_servers": []})).unwrap();
    assert_eq!(names("skills"), ["alpha", "beta", "zeta"]);
    assert_eq!(names("mcp_servers"), ["claude.ai Gmail"]);
    // ...until it's old.
    let mut o = get_overrides(&c, "p").unwrap();
    o.seen["cfg"]["skills"][0]["at"] = json!("2000-01-01T00:00:00.000Z");
    set_overrides(&c, "p", &o).unwrap();
    record_seen(&c, "p", Some("cfg"), &json!({"skills": ["beta"]})).unwrap();
    assert_eq!(names("skills"), ["beta", "zeta"]);
}
