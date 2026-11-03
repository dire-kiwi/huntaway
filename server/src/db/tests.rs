use super::*;
use serde_json::json;

#[test]
fn commits_dont_sync_to_disk_one_by_one() {
    let dir = crate::testing::temp_dir();
    let c = open(&dir.join("huntaway.db")).unwrap();
    let mode: String = c.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
    assert_eq!(mode, "wal");
    // NORMAL
    assert_eq!(c.query_row("PRAGMA synchronous", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    drop(c);
    std::fs::remove_dir_all(&dir).unwrap();
}

// HA-37: a failed insert used up its project's next key number.
#[test]
fn a_task_that_cant_be_added_doesnt_use_up_a_number() {
    let c = open(std::path::Path::new(":memory:")).unwrap();
    let p = insert_profile(&c, "me", &[], None).unwrap();
    let np = NewProject { id: "pr", profile_id: &p.id, name: "x", key: "X", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
    insert_project(&c, np).unwrap();
    let t = |profile_id| NewTask { profile_id, project_id: Some("pr"), kind: "task", title: "t", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
    assert!(insert_task(&c, t("nobody")).is_err());
    assert_eq!(insert_task(&c, t(&p.id)).unwrap().number, 1);
    // Within a transaction too.
    let tx = c.unchecked_transaction().unwrap();
    assert!(insert_task(&tx, t("nobody")).is_err());
    assert_eq!(insert_task(&tx, t(&p.id)).unwrap().number, 2);
    tx.commit().unwrap();
    assert_eq!(insert_task(&c, t(&p.id)).unwrap().number, 3);
}

#[test]
fn ensure_profile_makes_a_profile_only_if_none_has_its_name() {
    let c = open(std::path::Path::new(":memory:")).unwrap();
    let p = ensure_profile(&c, "personal", "/claude/personal").unwrap().expect("made");
    assert_eq!(p.name, "personal");
    let configs = list_claude_configs(&c).unwrap();
    assert_eq!(configs.len(), 1);
    assert_eq!((configs[0].name.as_str(), configs[0].config_dir.as_str()), ("personal", "/claude/personal"));
    assert_eq!(p.claude_config_ids, vec![configs[0].id.clone()]);
    // On the next start, or with the name in another case, it's left as it is.
    assert!(ensure_profile(&c, "personal", "/claude/personal").unwrap().is_none());
    assert!(ensure_profile(&c, "Personal", "/elsewhere").unwrap().is_none());
    assert_eq!(list_profiles(&c).unwrap().len(), 1);
    assert_eq!(list_claude_configs(&c).unwrap().len(), 1);
    // A config with the directory already is shared, as when a profile is made with claude_config_dir.
    let work = ensure_profile(&c, "work", "/claude/personal").unwrap().expect("made");
    assert_eq!(work.claude_config_ids, p.claude_config_ids);
}

#[test]
fn archived_projects_threads_arent_compacted() {
    let c = open(std::path::Path::new(":memory:")).unwrap();
    let p = insert_profile(&c, "me", &[], None).unwrap();
    let np = NewProject { id: "pr", profile_id: &p.id, name: "x", key: "X", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
    insert_project(&c, np).unwrap();
    let t = NewTask { profile_id: &p.id, project_id: Some("pr"), kind: "task", title: "t", description: "", status: "in_review", use_worktree: false, model: None, effort: None, claude_config_id: None };
    let t = insert_task(&c, t).unwrap();
    // Its last prompt ended 55 minutes ago, and nothing has happened since.
    c.execute("UPDATE tasks SET session_id='s', last_activity_at='2026-01-01T10:05:00Z' WHERE id=?1", [&t.id]).unwrap();
    let run = insert_run(&c, &t.id, "prompt").unwrap();
    c.execute("UPDATE runs SET status='exited', ended_at='2026-01-01T10:05:00Z' WHERE id=?1", [&run.id]).unwrap();
    let idle = |c: &Connection| idle_sessions(c, "2026-01-01T10:10:00Z", "2026-01-01T09:00:00Z").unwrap();
    assert_eq!(idle(&c), [t.id.clone()]);
    update_project(&c, "pr", &[("archived_at", json!("2026-01-01T10:06:00Z"))]).unwrap();
    assert!(idle(&c).is_empty());
    update_project(&c, "pr", &[("archived_at", Value::Null)]).unwrap();
    assert_eq!(idle(&c), [t.id]);
}

fn thread(c: &Connection) -> String {
    let p = insert_profile(c, "me", &[], None).unwrap();
    let t = NewTask {
        profile_id: &p.id,
        project_id: None,
        kind: "scratch",
        title: "t",
        description: "",
        status: "todo",
        use_worktree: false,
        model: None,
        effort: None,
        claude_config_id: None,
    };
    insert_task(c, t).unwrap().id
}

#[test]
fn queued_messages_remember_whether_an_agent_sent_them() {
    let c = open(std::path::Path::new(":memory:")).unwrap();
    let id = thread(&c);
    assert_eq!(take_queued(&c, &id).unwrap(), None);
    let taken = |c: &Connection| take_queued(c, &id).unwrap().map(|q| (q.text, q.from_agent, q.user_text));
    let mine = |t: &str| Some(t.to_string());

    // From another agent, and it stays that way through the queue.
    queue(&c, &id, Queued::new("rebase please", true)).unwrap();
    queue(&c, &id, Queued::new("and run the tests", true)).unwrap();
    assert_eq!(taken(&c), Some(("rebase please\n\nand run the tests".into(), true, None)));
    assert_eq!(taken(&c), None);

    // Anything the user adds makes it the user's, whichever came first, and their parts are kept apart.
    queue(&c, &id, Queued::new("from an agent", true)).unwrap();
    queue(&c, &id, Queued::new("from me", false)).unwrap();
    assert_eq!(get_task(&c, &id).unwrap().unwrap().queued_user_text, mine("from me"));
    assert_eq!(taken(&c), Some(("from an agent\n\nfrom me".into(), false, mine("from me"))));
    queue(&c, &id, Queued::new("from me", false)).unwrap();
    queue(&c, &id, Queued::new("from an agent", true)).unwrap();
    queue(&c, &id, Queued::new("and me", false)).unwrap();
    assert_eq!(taken(&c), Some(("from me\n\nfrom an agent\n\nand me".into(), false, mine("from me\n\nand me"))));

    // Clearing the queue forgets where it came from.
    queue(&c, &id, Queued::new("dropped", true)).unwrap();
    let t = clear_queued(&c, &id).unwrap().unwrap();
    assert_eq!((t.queued_message, t.queued_user_text), (None, None));
    queue(&c, &id, Queued::new("mine", false)).unwrap();
    assert_eq!(taken(&c), Some(("mine".into(), false, mine("mine"))));
}

#[test]
fn subprojects_follow_their_tasks_by_priority() {
    let c = open(std::path::Path::new(":memory:")).unwrap();
    let id = thread(&c);
    let t = get_task(&c, &id).unwrap().unwrap();
    let sp = Task { kind: "task".into(), subproject: true, status: "in_progress".into(), ..t };
    let task = |status: &str| Task { status: status.into(), parent_id: Some(sp.id.clone()), subproject: false, ..sp.clone() };
    let tasks = |sts: &[&str]| sts.iter().map(|st| task(st)).collect::<Vec<_>>();

    // Nothing started yet: it stays put.
    assert_eq!(subproject_status(&sp, &[]), None);
    assert_eq!(subproject_status(&sp, &tasks(&["todo", "backlog"])), None);
    // Needs attention beats in progress, which beats in review.
    assert_eq!(subproject_status(&sp, &tasks(&["in_review", "in_progress", "needs_attention", "todo"])), Some("needs_attention"));
    assert_eq!(subproject_status(&sp, &tasks(&["in_review", "in_progress", "done"])), Some("in_progress"));
    assert_eq!(subproject_status(&sp, &tasks(&["in_review", "ready_for_merge", "done", "todo"])), Some("in_review"));
    // Still in review once everything's merged.
    assert_eq!(subproject_status(&sp, &tasks(&["done", "done"])), Some("in_review"));

    // Its own agent counts too.
    let busy = Task { running: true, ..sp.clone() };
    assert_eq!(subproject_status(&busy, &tasks(&["done"])), Some("in_progress"));
    let asking = Task { attention_reason: Some("Approve Bash?".into()), ..sp.clone() };
    assert_eq!(subproject_status(&asking, &tasks(&["in_progress"])), Some("needs_attention"));

    // Merging it or marking it done is left to the user.
    let merging = Task { merging: true, status: "ready_for_merge".into(), ..sp.clone() };
    assert_eq!(subproject_status(&merging, &tasks(&["in_progress"])), None);
    let done = Task { status: "done".into(), ..sp.clone() };
    assert_eq!(subproject_status(&done, &tasks(&["in_progress"])), None);
    // Its scratch tasks aren't part of its work, so they don't count.
    let scratch = |status: &str| Task { task_type: Some(SCRATCH.into()), ..task(status) };
    assert_eq!(subproject_status(&sp, &[scratch("needs_attention"), scratch("in_progress"), task("todo")]), None);
    assert_eq!(subproject_status(&sp, &[scratch("needs_attention"), task("in_review")]), Some("in_review"));
    // Only subprojects follow their tasks.
    let plain = Task { subproject: false, ..sp.clone() };
    assert_eq!(subproject_status(&plain, &tasks(&["in_progress"])), None);
}

#[test]
fn done_tasks_and_only_done_tasks_have_a_resolution() {
    let c = open(std::path::Path::new(":memory:")).unwrap();
    let id = thread(&c);
    let set = |fields: &[(&str, Value)]| update_task(&c, &id, fields).unwrap().unwrap().resolution;
    assert_eq!(get_task(&c, &id).unwrap().unwrap().resolution, None);

    // Done without saying how means done.
    assert_eq!(set(&[("status", json!("done"))]).as_deref(), Some("done"));
    // A done task's resolution can change, and stays put through other updates.
    assert_eq!(set(&[("resolution", json!("wont_fix"))]).as_deref(), Some("wont_fix"));
    assert_eq!(set(&[("status", json!("done")), ("title", json!("x"))]).as_deref(), Some("wont_fix"));
    // Clearing it falls back to done.
    assert_eq!(set(&[("resolution", Value::Null)]).as_deref(), Some("done"));
    // Out of done clears it, whatever it was.
    set(&[("resolution", json!("not_done"))]);
    assert_eq!(set(&[("status", json!("todo"))]), None);
    assert_eq!(set(&[("status", json!("done")), ("resolution", json!("not_done"))]).as_deref(), Some("not_done"));

    // Created done, it's done.
    let mut t = get_task(&c, &id).unwrap().unwrap();
    t = insert_task(&c, NewTask { profile_id: &t.profile_id, project_id: None, kind: "scratch", title: "t", description: "", status: "done", use_worktree: false, model: None, effort: None, claude_config_id: None }).unwrap();
    assert_eq!(t.resolution.as_deref(), Some("done"));
}

#[test]
fn done_tasks_keep_when_they_were_done() {
    let c = open(std::path::Path::new(":memory:")).unwrap();
    let id = thread(&c);
    let set = |fields: &[(&str, Value)]| update_task(&c, &id, fields).unwrap().unwrap().done_at;
    assert_eq!(get_task(&c, &id).unwrap().unwrap().done_at, None);

    let done = set(&[("status", json!("done"))]).expect("moving it into done sets the time");
    // Staying done keeps the time it was done, through other updates and a new resolution.
    update_task(&c, &id, &[("done_at", json!("2026-01-01T00:00:00Z"))]).unwrap();
    assert_eq!(set(&[("status", json!("done")), ("title", json!("x"))]).as_deref(), Some("2026-01-01T00:00:00Z"));
    assert_eq!(set(&[("resolution", json!("wont_fix"))]).as_deref(), Some("2026-01-01T00:00:00Z"));
    // Out of done clears it, and done again starts over.
    assert_eq!(set(&[("status", json!("in_review"))]), None);
    assert!(set(&[("status", json!("done"))]).is_some_and(|t| t >= done));

    // Created done, it's done from then.
    let t = get_task(&c, &id).unwrap().unwrap();
    let t = insert_task(&c, NewTask { profile_id: &t.profile_id, project_id: None, kind: "task", title: "t", description: "", status: "done", use_worktree: false, model: None, effort: None, claude_config_id: None }).unwrap();
    assert!(t.done_at.is_some_and(|d| d >= t.created_at));
}

#[test]
fn resolutions_are_checked_against_the_status() {
    assert!(check_resolution("done", &json!("wont_fix")).is_ok());
    assert!(check_resolution("todo", &Value::Null).is_ok());
    assert!(check_resolution("done", &json!("maybe")).is_err());
    assert!(check_resolution("done", &json!(1)).is_err());
    assert!(check_resolution("in_review", &json!("done")).is_err());
}

#[test]
fn a_database_from_version_58_has_its_plan_artifact_and_diagram_tasks_labelled() {
    let path = crate::testing::temp_dir().join("huntaway.db");
    {
        let c = open(&path).unwrap();
        c.execute_batch(
            "DROP INDEX documents_task;
                 ALTER TABLE documents DROP COLUMN label;
                 CREATE UNIQUE INDEX documents_task ON documents(task_id, version);
                 ALTER TABLE tasks DROP COLUMN labels;
                 PRAGMA user_version=58;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','work','1');
                 INSERT INTO tasks (id,profile_id,kind,task_type,work_dir,number,title,status,last_activity_at,created_at,updated_at)
                   VALUES ('plan','p','task','plan',NULL,1,'Plan','in_review','1','1','1'),
                          ('art','p','task','artifact',NULL,2,'Page','todo','1','1','1'),
                          ('chat','p','task','scratch','/chat',1,'Chat','done','1','1','1'),
                          ('code','p','task',NULL,NULL,3,'Code','todo','1','1','1');
                 INSERT INTO documents (task_id,version,content,open,created_at,updated_at)
                   VALUES ('plan',1,'<h1>1</h1>',0,'1','1'), ('plan',2,'<h1>2</h1>',0,'1','1'), ('art',1,'<p>',0,'1','1');",
        )
        .unwrap();
    }
    let c = open(&path).unwrap();
    assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
    let task = |id: &str| get_task(&c, id).unwrap().unwrap();
    let (plan, art, chat, code) = (task("plan"), task("art"), task("chat"), task("code"));
    assert_eq!((plan.task_type, plan.labels, plan.work_dir.as_deref()), (None, vec!["plan".to_string()], Some("documents/plan")));
    assert_eq!((art.task_type, art.labels, art.work_dir.as_deref()), (None, vec!["artifact".to_string()], Some("documents/art")));
    assert_eq!((chat.task_type.as_deref(), chat.labels.len(), chat.work_dir.as_deref()), (Some(SCRATCH), 0, Some("/chat")));
    assert_eq!((code.task_type, code.labels.len(), code.work_dir), (None, 0, None));
    let docs: Vec<(String, String, i64)> = c
        .prepare("SELECT task_id, label, version FROM documents ORDER BY task_id, version")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    let doc = |t: &str, l: &str, v| (t.to_string(), l.to_string(), v);
    assert_eq!(docs, vec![doc("art", "artifact", 1), doc("plan", "plan", 1), doc("plan", "plan", 2)]);
    // Another label's version 1 can sit beside the plan's.
    c.execute("INSERT INTO documents (task_id,label,version,content,created_at,updated_at) VALUES ('plan','diagram',1,'x','1','1')", []).unwrap();
    drop(c);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[test]
fn a_database_that_had_start_from_as_an_earlier_version_gets_the_columns_it_skipped() {
    // Builds of start_from had it as version 65 (skipping that version's limit columns), then 71
    // (skipping restart_window), then 73 (skipping the runs' sessions), then 74 (skipping pr_checks),
    // then 75 (skipping require_pr_approval); the first two had no merge_approval (72) either, and
    // none before 74 had pr_checks.
    let skipped = [
        (65, "ALTER TABLE tasks DROP COLUMN limit_reset_at; ALTER TABLE profiles DROP COLUMN limit_wait; ALTER TABLE profiles DROP COLUMN limit_switch; ALTER TABLE profiles DROP COLUMN merge_approval;"),
        (71, "ALTER TABLE claude_configs DROP COLUMN restart_window; ALTER TABLE profiles DROP COLUMN merge_approval;"),
        (73, "ALTER TABLE runs DROP COLUMN session_id; ALTER TABLE runs DROP COLUMN session_cost; ALTER TABLE tasks DROP COLUMN pr_checks;"),
        (74, "ALTER TABLE tasks DROP COLUMN pr_checks;"),
        (75, "ALTER TABLE profiles DROP COLUMN require_pr_approval; ALTER TABLE projects DROP COLUMN require_pr_approval;"),
    ];
    for (version, dropped) in skipped {
        let path = crate::testing::temp_dir().join("huntaway.db");
        {
            let c = open(&path).unwrap();
            c.execute_batch(&format!("{dropped} PRAGMA user_version={version};")).unwrap();
        }
        let c = open(&path).unwrap();
        assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
        let columns = [
            ("tasks", "start_from"),
            ("tasks", "limit_reset_at"),
            ("profiles", "limit_wait"),
            ("profiles", "limit_switch"),
            ("claude_configs", "restart_window"),
            ("profiles", "merge_approval"),
            ("runs", "session_id"),
            ("runs", "session_cost"),
            ("tasks", "pr_checks"),
            ("profiles", "require_pr_approval"),
            ("projects", "require_pr_approval"),
        ];
        for (table, column) in columns {
            let has: bool = c.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info(?1) WHERE name=?2", params![table, column], |r| r.get(0)).unwrap();
            assert!(has, "version {version}: {table}.{column}");
        }
        drop(c);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }
}

#[test]
fn a_database_that_had_the_agent_threads_tables_as_an_earlier_version_gets_what_it_skipped() {
    // Builds of the agent-threads store had its tables as version 80 (skipping call_usage), then 81 (skipping
    // call_usage's call ids), then 82 (skipping the review and run efforts), then 84 (skipping summarizers).
    let skipped = [
        (80, "DROP TABLE call_usage;"),
        (81, "INSERT INTO call_usage (at, purpose, model, runtime) VALUES ('2026-11-01T00:00:00Z', 'title', 'haiku', 'claude');
              ALTER TABLE call_usage DROP COLUMN call_id;"),
        (82, "ALTER TABLE review_stats DROP COLUMN effort; ALTER TABLE runs DROP COLUMN effort;"),
        (84, "ALTER TABLE projects DROP COLUMN summarizers; ALTER TABLE profiles DROP COLUMN summarizers;"),
    ];
    for (version, dropped) in skipped {
        let path = crate::testing::temp_dir().join("huntaway.db");
        {
            let c = open(&path).unwrap();
            c.execute_batch(&format!("{dropped} PRAGMA user_version={version};")).unwrap();
        }
        let c = open(&path).unwrap();
        assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
        let columns = [("call_usage", "call_id"), ("review_stats", "effort"), ("runs", "effort"), ("projects", "summarizers"), ("profiles", "summarizers")];
        for (table, column) in columns {
            let has: bool = c.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info(?1) WHERE name=?2", params![table, column], |r| r.get(0)).unwrap();
            assert!(has, "version {version}: {table}.{column}");
        }
        let unset: i64 = c.query_row("SELECT COUNT(*) FROM call_usage WHERE call_id IS NULL", [], |r| r.get(0)).unwrap();
        assert_eq!(unset, 0, "version {version}");
        let tables: i64 = c.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name LIKE 'at\\_%' ESCAPE '\\'", [], |r| r.get(0)).unwrap();
        assert_eq!(tables, 6, "version {version}");
        drop(c);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }
}

#[test]
fn a_database_from_version_54_gets_automations() {
    let path = crate::testing::temp_dir().join("huntaway.db");
    {
        let c = open(&path).unwrap();
        c.execute_batch("DROP TABLE automation_runs; DROP TABLE automations; PRAGMA user_version=54;").unwrap();
    }
    let c = open(&path).unwrap();
    assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
    for table in ["automations", "automation_runs"] {
        assert!(c.query_row("SELECT COUNT(*) FROM pragma_table_info(?1)", [table], |r| r.get::<_, i64>(0)).unwrap() > 0, "{table}");
    }
    drop(c);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[test]
fn a_database_from_version_60_gets_setup_threads() {
    let path = crate::testing::temp_dir().join("huntaway.db");
    {
        let c = open(&path).unwrap();
        c.execute_batch(
            "ALTER TABLE projects DROP COLUMN setup_task_id;
                 PRAGMA user_version=60;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','work','1');
                 INSERT INTO projects (id,profile_id,name,key,repo_path,scratch_path,worktrees_root,created_at)
                   VALUES ('pr','p','Web','WEB','/nowhere','/s','/w','1');",
        )
        .unwrap();
    }
    let c = open(&path).unwrap();
    assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
    // Master's version 60 stays (HA-15's watch_pull_requests), and projects from before have no setup thread yet.
    let p = get_project(&c, "pr").unwrap().unwrap();
    assert_eq!((p.watch_pull_requests.as_str(), p.setup_task_id), ("off", None));
    assert_eq!(update_project(&c, "pr", &[("setup_task_id", json!("t"))]).unwrap().unwrap().setup_task_id.as_deref(), Some("t"));
    drop(c);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[test]
fn a_database_from_version_48_has_its_done_tasks_done_since_they_last_changed() {
    let path = crate::testing::temp_dir().join("huntaway.db");
    {
        let c = open(&path).unwrap();
        c.execute_batch(
            "ALTER TABLE tasks DROP COLUMN done_at;
                 PRAGMA user_version=48;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','work','1');
                 INSERT INTO tasks (id,profile_id,kind,number,title,status,resolution,last_activity_at,created_at,updated_at)
                   VALUES ('d','p','task',1,'Done','done','done','1','1','2026-01-02T00:00:00Z'),
                          ('t','p','task',2,'To do','todo',NULL,'1','1','2026-01-03T00:00:00Z');",
        )
        .unwrap();
    }
    let c = open(&path).unwrap();
    assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
    assert_eq!(get_task(&c, "d").unwrap().unwrap().done_at.as_deref(), Some("2026-01-02T00:00:00Z"));
    assert_eq!(get_task(&c, "t").unwrap().unwrap().done_at, None);
    drop(c);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[test]
fn a_database_from_version_49_gets_profiles_cloning_into_their_own_folder() {
    let path = crate::testing::temp_dir().join("huntaway.db");
    {
        let c = open(&path).unwrap();
        c.execute_batch(
            "ALTER TABLE profiles DROP COLUMN clone_dir;
                 PRAGMA user_version=49;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','work','1');",
        )
        .unwrap();
    }
    let c = open(&path).unwrap();
    assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
    let p = get_profile(&c, "p").unwrap().unwrap();
    assert_eq!((p.clone_dir.as_deref(), p.clone_dir_or_default().as_str()), (None, "~/work"));
    let p = update_profile(&c, "p", &[("clone_dir", json!("~/src/work"))]).unwrap().unwrap();
    assert_eq!(p.clone_dir_or_default(), "~/src/work");
    drop(c);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[test]
fn a_database_from_version_50_gets_external_links_and_asana_tokens() {
    let path = crate::testing::temp_dir().join("huntaway.db");
    {
        let c = open(&path).unwrap();
        c.execute_batch(
            "ALTER TABLE tasks DROP COLUMN external_links;
                 ALTER TABLE profiles DROP COLUMN asana_token;
                 ALTER TABLE profiles DROP COLUMN asana_user;
                 PRAGMA user_version=50;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','work','1');
                 INSERT INTO tasks (id,profile_id,kind,number,title,description,status,position,last_activity_at,created_at,updated_at)
                   VALUES ('t','p','task',1,'t','','todo',0,'1','1','1');",
        )
        .unwrap();
    }
    let c = open(&path).unwrap();
    assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
    let p = get_profile(&c, "p").unwrap().unwrap();
    assert_eq!((p.asana_token, p.asana_user), (None, None));
    assert!(get_task(&c, "t").unwrap().unwrap().external_links.is_empty());
    drop(c);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[test]
fn a_database_from_version_51_keeps_asana_on_for_its_profiles() {
    let path = crate::testing::temp_dir().join("huntaway.db");
    {
        let c = open(&path).unwrap();
        c.execute_batch(
            "ALTER TABLE profiles DROP COLUMN asana_enabled;
                 PRAGMA user_version=51;
                 INSERT INTO profiles (id,name,created_at,asana_token,asana_user) VALUES ('p','work','1','tok','Ivy');",
        )
        .unwrap();
    }
    let c = open(&path).unwrap();
    assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
    let p = get_profile(&c, "p").unwrap().unwrap();
    assert!(p.asana_enabled);
    assert_eq!((p.asana_token.as_deref(), p.asana_user.as_deref()), (Some("tok"), Some("Ivy")));
    let p = update_profile(&c, "p", &[("asana_enabled", json!(false))]).unwrap().unwrap();
    assert!(!p.asana_enabled);
    assert!(insert_profile(&c, "personal", &[], None).unwrap().asana_enabled, "new profiles use Asana");
    drop(c);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[test]
fn a_database_from_version_56_gets_remerge() {
    let path = crate::testing::temp_dir().join("huntaway.db");
    {
        let c = open(&path).unwrap();
        c.execute_batch(
            "ALTER TABLE tasks DROP COLUMN remerge;
                 PRAGMA user_version=56;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','work','1');
                 INSERT INTO tasks (id,profile_id,kind,number,title,description,status,position,merging,last_activity_at,created_at,updated_at)
                   VALUES ('t','p','task',1,'t','','ready_for_merge',0,1,'1','1','1');",
        )
        .unwrap();
    }
    let c = open(&path).unwrap();
    assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
    // A merge from before keeps holding its place in the queue as it did.
    let t = get_task(&c, "t").unwrap().unwrap();
    assert_eq!((t.merging, t.remerge), (true, false));
    let t = update_task(&c, "t", &[("remerge", json!(true))]).unwrap().unwrap();
    assert!(t.remerge);
    drop(c);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[test]
fn a_database_from_version_52_gets_fanout_ids() {
    let path = crate::testing::temp_dir().join("huntaway.db");
    {
        let c = open(&path).unwrap();
        c.execute_batch(
            "ALTER TABLE tasks DROP COLUMN fanout_id;
                 PRAGMA user_version=52;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','work','1');
                 INSERT INTO tasks (id,profile_id,kind,number,title,description,status,position,last_activity_at,created_at,updated_at)
                   VALUES ('t','p','task',1,'t','','todo',0,'1','1','1');",
        )
        .unwrap();
    }
    let c = open(&path).unwrap();
    assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
    assert_eq!(get_task(&c, "t").unwrap().unwrap().fanout_id, None);
    let t = update_task(&c, "t", &[("fanout_id", json!("f1"))]).unwrap().unwrap();
    assert_eq!(t.fanout_id.as_deref(), Some("f1"));
    drop(c);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[test]
fn a_database_from_version_61_gets_push_subscriptions() {
    let path = crate::testing::temp_dir().join("huntaway.db");
    {
        let c = open(&path).unwrap();
        c.execute_batch("DROP TABLE push_subscriptions; PRAGMA user_version=61;").unwrap();
    }
    let c = open(&path).unwrap();
    assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
    c.execute("INSERT INTO push_subscriptions (id,endpoint,p256dh,auth,events,created_at) VALUES ('s','https://x/1','k','a','{}','1')", []).unwrap();
    // One per endpoint.
    assert!(c.execute("INSERT INTO push_subscriptions (id,endpoint,p256dh,auth,events,created_at) VALUES ('t','https://x/1','k','a','{}','1')", []).is_err());
    drop(c);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[test]
fn a_database_from_version_53_gets_pull_request_watches() {
    let path = crate::testing::temp_dir().join("huntaway.db");
    {
        let c = open(&path).unwrap();
        c.execute_batch(
            "DROP TABLE pr_watches;
                 PRAGMA user_version=53;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','work','1');
                 INSERT INTO tasks (id,profile_id,kind,number,title,description,status,position,last_activity_at,created_at,updated_at)
                   VALUES ('t','p','task',1,'t','','todo',0,'1','1','1');",
        )
        .unwrap();
    }
    let c = open(&path).unwrap();
    assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
    c.execute("INSERT INTO pr_watches (task_id,pr,state,updated_at) VALUES ('t','github.com/o/r#1','{}','1')", []).unwrap();
    // A stored wait from before it had a pull request is read as one without.
    let w = json!({"since": "1", "until": "2", "call_id": "c", "run_id": "r"});
    assert_eq!(update_task(&c, "t", &[("agent_wait", w)]).unwrap().unwrap().agent_wait.unwrap().pull_request, None);
    // They go with their task.
    c.execute("DELETE FROM tasks WHERE id='t'", []).unwrap();
    assert_eq!(c.query_row("SELECT COUNT(*) FROM pr_watches", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    drop(c);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[test]
fn profiles_clone_into_a_folder_named_after_them_by_default() {
    assert_eq!(default_clone_dir("personal"), "~/personal");
    assert_eq!(default_clone_dir(" a/b "), "~/a-b");
    for name in ["", " ", ".", ".."] {
        assert_eq!(default_clone_dir(name), "~", "{name:?}");
    }
}

#[test]
fn a_database_from_version_70_gets_restart_window_off() {
    let path = crate::testing::temp_dir().join("huntaway.db");
    {
        let c = open(&path).unwrap();
        c.execute_batch(
            "ALTER TABLE claude_configs DROP COLUMN restart_window; PRAGMA user_version=70;
                 INSERT INTO claude_configs (id,name,config_dir,created_at,show_usage) VALUES ('c','work','~/.claude','1',1);",
        )
        .unwrap();
    }
    let c = open(&path).unwrap();
    assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
    let cfg = get_claude_config(&c, "c").unwrap().unwrap();
    assert_eq!((cfg.show_usage, cfg.restart_window), (true, false));
    let cfg = update_claude_config(&c, "c", &[("restart_window", json!(true))]).unwrap().unwrap();
    assert!(cfg.restart_window);
}

#[test]
fn a_database_from_version_80_gets_call_ids_shared_by_each_calls_rows() {
    let path = crate::testing::temp_dir().join("huntaway.db");
    {
        let c = open(&path).unwrap();
        c.execute_batch(
            "ALTER TABLE call_usage DROP COLUMN call_id; PRAGMA user_version=80;
             INSERT INTO call_usage (at, purpose, task_id, config_id, model, runtime) VALUES
               ('1', 'window', NULL, 'c', 'opus', 'claude'), ('1', 'window', NULL, 'c', 'haiku', 'claude'),
               ('1', 'window', NULL, 'd', 'haiku', 'claude'), ('2', 'window', NULL, 'c', 'haiku', 'claude'), ('1', 'title', NULL, 'c', 'haiku', 'claude');",
        )
        .unwrap();
    }
    let c = open(&path).unwrap();
    assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
    let ids: Vec<String> = c.prepare("SELECT call_id FROM call_usage ORDER BY id").unwrap().query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
    assert_eq!(ids[0], ids[1]);
    let distinct: std::collections::HashSet<&String> = ids.iter().collect();
    assert_eq!(distinct.len(), 4, "{ids:?}");
}

#[test]
fn a_database_from_version_81_gets_its_reviews_the_efforts_of_their_tasks() {
    let path = crate::testing::temp_dir().join("huntaway.db");
    let (own, default) = {
        let c = open(&path).unwrap();
        let p = insert_profile(&c, "p", &[], None).unwrap();
        let new = || NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "t", description: "", status: "in_review", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let (a, b) = (insert_task(&c, new()).unwrap(), insert_task(&c, new()).unwrap());
        c.execute("UPDATE tasks SET effort='high' WHERE id=?1", [&a.id]).unwrap();
        set_setting(&c, "default_effort", Some("low")).unwrap();
        c.execute_batch("ALTER TABLE review_stats DROP COLUMN effort; PRAGMA user_version=81;").unwrap();
        for t in [&a, &b] {
            c.execute("INSERT INTO review_stats (task_id, thread_id, round, at, verdict) VALUES (?1, 'r', '1', '1', 'pass')", [&t.id]).unwrap();
        }
        (a.id, b.id)
    };
    let c = open(&path).unwrap();
    assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
    let effort = |id: &str| c.query_row("SELECT effort FROM review_stats WHERE task_id=?1", [id], |r| r.get::<_, Option<String>>(0)).unwrap();
    // Its own, or the host's default.
    assert_eq!((effort(&own).as_deref(), effort(&default).as_deref()), (Some("high"), Some("low")));
}

#[test]
fn a_database_at_version_73_gets_tasks_pr_checks() {
    let path = crate::testing::temp_dir().join("huntaway.db");
    let id = {
        let c = open(&path).unwrap();
        let p = insert_profile(&c, "p", &[], None).unwrap();
        let t = NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "t", description: "", status: "in_review", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let t = insert_task(&c, t).unwrap();
        c.execute_batch("ALTER TABLE tasks DROP COLUMN pr_checks; PRAGMA user_version=73;").unwrap();
        t.id
    };
    let c = open(&path).unwrap();
    assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
    assert_eq!(get_task(&c, &id).unwrap().unwrap().pr_checks, None);
    let checks = PrChecks { url: "https://github.com/o/r/pull/1".into(), head: "a1".into(), outcome: "failed".into(), since: "1".into(), ..Default::default() };
    let t = update_task(&c, &id, &[("pr_checks", json!(checks))]).unwrap().unwrap();
    assert_eq!(t.pr_checks, Some(checks));
}

#[test]
fn a_database_from_version_47_gets_show_usage_off() {
    let path = crate::testing::temp_dir().join("huntaway.db");
    {
        let c = open(&path).unwrap();
        c.execute_batch(
            "ALTER TABLE claude_configs DROP COLUMN show_usage; ALTER TABLE tasks DROP COLUMN done_at;
                 PRAGMA user_version=47;
                 INSERT INTO claude_configs (id,name,config_dir,created_at) VALUES ('c','personal','~/.claude-personal','1');",
        )
        .unwrap();
    }
    let c = open(&path).unwrap();
    assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
    let configs = list_claude_configs(&c).unwrap();
    assert_eq!(configs.iter().map(|c| (c.id.as_str(), c.show_usage)).collect::<Vec<_>>(), [("c", false)]);
    drop(c);
    for suffix in ["", "-wal", "-shm"] {
        std::fs::remove_file(format!("{}{suffix}", path.display())).ok();
    }
}

#[test]
fn a_database_at_version_59_gets_projects_watch_pull_requests() {
    // As master's build left it, with labels (59) and no watch_pull_requests yet.
    let path = crate::testing::temp_dir().join("huntaway.db");
    {
        let c = open(&path).unwrap();
        c.execute_batch(
            "ALTER TABLE projects DROP COLUMN watch_pull_requests;
                 PRAGMA user_version=59;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','p','1');
                 INSERT INTO projects (id,profile_id,name,key,repo_path,scratch_path,worktrees_root,created_at)
                   VALUES ('pr','p','P','P','/x','/s','/w','1');",
        )
        .unwrap();
    }
    let c = open(&path).unwrap();
    assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
    let p = get_project(&c, "pr").unwrap().unwrap();
    assert_eq!((p.watch_pull_requests.as_str(), p.done_when_merged), ("off", true));
    drop(c);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[test]
fn a_database_at_version_66_gets_the_summary_columns() {
    // As master's build left it, with copy_files and link_folders (66) and no summaries yet.
    let path = crate::testing::temp_dir().join("huntaway.db");
    {
        let c = open(&path).unwrap();
        c.execute_batch(
            "ALTER TABLE projects DROP COLUMN auto_summary;
                 ALTER TABLE projects DROP COLUMN summarizer;
                 ALTER TABLE tasks DROP COLUMN summary;
                 PRAGMA user_version=66;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','p','1');
                 INSERT INTO projects (id,profile_id,name,key,repo_path,scratch_path,worktrees_root,created_at)
                   VALUES ('pr','p','P','P','/x','/s','/w','1');",
        )
        .unwrap();
    }
    let c = open(&path).unwrap();
    assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
    let p = get_project(&c, "pr").unwrap().unwrap();
    assert!(p.auto_summary);
    assert_eq!(p.summarizer, None);
    let t = insert_task(&c, NewTask { profile_id: "p", project_id: Some("pr"), kind: "task", title: "t", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None }).unwrap();
    assert!(t.summary.is_none());
}

#[test]
fn a_database_at_version_83_keeps_its_summarizer_as_the_only_one() {
    // As master's build left it (83), with a project and a profile each with a summarizer and no list of them yet.
    let path = crate::testing::temp_dir().join("huntaway.db");
    {
        let c = open(&path).unwrap();
        c.execute_batch(
            "ALTER TABLE projects DROP COLUMN summarizers;
                 ALTER TABLE profiles DROP COLUMN summarizers;
                 PRAGMA user_version=83;
                 INSERT INTO profiles (id,name,created_at,summarizer) VALUES ('p','p','1','{\"model\":\"haiku\"}');
                 INSERT INTO projects (id,profile_id,name,key,repo_path,scratch_path,worktrees_root,created_at,summarizer)
                   VALUES ('pr','p','P','P','/x','/s','/w','1','{\"model\":\"sonnet\"}');",
        )
        .unwrap();
    }
    let c = open(&path).unwrap();
    assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
    let p = get_project(&c, "pr").unwrap().unwrap();
    assert_eq!(p.summarizers.iter().map(|r| r.model.as_deref()).collect::<Vec<_>>(), [Some("sonnet")]);
    assert_eq!(get_profile(&c, "p").unwrap().unwrap().summarizers.len(), 1);
    assert_eq!(summarizers_for(&c, &p).unwrap().len(), 1);
}

#[test]
fn a_database_at_version_67_gets_projects_pull_request_settings() {
    // As master's build left it, with summaries (67) and no pull request settings yet: its projects keep opening them.
    let path = crate::testing::temp_dir().join("huntaway.db");
    {
        let c = open(&path).unwrap();
        c.execute_batch(
            "ALTER TABLE projects DROP COLUMN pull_requests;
                 ALTER TABLE projects DROP COLUMN subproject_pull_requests;
                 PRAGMA user_version=67;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','p','1');
                 INSERT INTO projects (id,profile_id,name,key,repo_path,scratch_path,worktrees_root,created_at)
                   VALUES ('pr','p','P','P','/x','/s','/w','1');",
        )
        .unwrap();
    }
    let c = open(&path).unwrap();
    assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
    let p = get_project(&c, "pr").unwrap().unwrap();
    assert!(p.pull_requests && p.subproject_pull_requests);
    let p = update_project(&c, "pr", &[("pull_requests", json!(false))]).unwrap().unwrap();
    assert!(!p.pull_requests && p.subproject_pull_requests);
}

#[test]
fn a_database_at_version_76_has_every_task_in_later() {
    // As master's build left it, with a worktree start point (76) and no now/later split yet.
    let path = crate::testing::temp_dir().join("huntaway.db");
    {
        let c = open(&path).unwrap();
        c.execute_batch(
            "ALTER TABLE tasks DROP COLUMN now_at;
                 PRAGMA user_version=76;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','p','1');
                 INSERT INTO tasks (id,profile_id,kind,number,title,status,last_activity_at,created_at,updated_at)
                   VALUES ('t','p','task',1,'t','todo','1','1','1');",
        )
        .unwrap();
    }
    let c = open(&path).unwrap();
    assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
    assert_eq!(get_task(&c, "t").unwrap().unwrap().now_at, None);
    let t = update_task(&c, "t", &[("now_at", json!("2030-01-01T00:00:00.000Z"))]).unwrap().unwrap();
    assert_eq!(t.now_at.as_deref(), Some("2030-01-01T00:00:00.000Z"));
}

#[test]
fn a_database_that_had_token_usage_as_an_earlier_version_gets_the_columns_it_skipped() {
    // Builds of token_usage had it as version 74, then 75, then 76, then 78, so a database that ran them skipped
    // master's 74, 75 and 76 (pr_checks, require_pr_approval, start_from), and 77 (now_at) ran as master's. The
    // builds that had it as 78 didn't add those back (but start_from), nor the runs' usage_tail at first.
    for version in [76, 77, 78] {
        let path = crate::testing::temp_dir().join("huntaway.db");
        {
            let c = open(&path).unwrap();
            c.execute_batch(&format!(
                "ALTER TABLE tasks DROP COLUMN pr_checks; ALTER TABLE tasks DROP COLUMN start_from;
                 ALTER TABLE profiles DROP COLUMN require_pr_approval; ALTER TABLE projects DROP COLUMN require_pr_approval;
                 ALTER TABLE runs DROP COLUMN usage_tail;
                 PRAGMA user_version={version};"
            ))
            .unwrap();
        }
        let c = open(&path).unwrap();
        assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
        for (table, column) in [("tasks", "pr_checks"), ("tasks", "start_from"), ("profiles", "require_pr_approval"), ("projects", "require_pr_approval"), ("runs", "usage_tail")] {
            let has: bool = c.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info(?1) WHERE name=?2", params![table, column], |r| r.get(0)).unwrap();
            assert!(has, "version {version}: {table}.{column}");
        }
        // The demo seed, which is what failed on such a database.
        let p = insert_profile(&c, "p", &[], None).unwrap();
        assert!(!get_profile(&c, &p.id).unwrap().unwrap().require_pr_approval);
    }
}

#[test]
fn a_database_at_version_69_gets_profiles_reviewers_and_summarizer() {
    // As master's build left it, with context stats (69) and no profile reviewers yet.
    let path = crate::testing::temp_dir().join("huntaway.db");
    {
        let c = open(&path).unwrap();
        c.execute_batch(
            "ALTER TABLE profiles DROP COLUMN reviewers;
                 ALTER TABLE profiles DROP COLUMN summarizer;
                 PRAGMA user_version=69;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','p','1');",
        )
        .unwrap();
    }
    let c = open(&path).unwrap();
    assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
    let p = get_profile(&c, "p").unwrap().unwrap();
    assert_eq!((p.reviewers, p.summarizer), (vec![], None));
    let haiku = Reviewer { model: Some("haiku".into()), ..Default::default() };
    let p = update_profile(&c, "p", &[("summarizer", json!(json!(haiku).to_string()))]).unwrap().unwrap();
    assert_eq!(p.summarizer, Some(haiku));
}

#[test]
fn a_database_at_version_62_gets_projects_pr_preview_url() {
    // As master's build left it, with push_subscriptions (62) and no pr_preview_url yet.
    let path = crate::testing::temp_dir().join("huntaway.db");
    {
        let c = open(&path).unwrap();
        c.execute_batch(
            "ALTER TABLE projects DROP COLUMN pr_preview_url;
                 PRAGMA user_version=62;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','p','1');
                 INSERT INTO projects (id,profile_id,name,key,repo_path,scratch_path,worktrees_root,created_at)
                   VALUES ('pr','p','P','P','/x','/s','/w','1');",
        )
        .unwrap();
    }
    let c = open(&path).unwrap();
    assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
    let mut p = get_project(&c, "pr").unwrap().unwrap();
    assert_eq!(p.pr_preview_url, None);
    assert_eq!(p.preview_for(Some("https://github.com/o/r/pull/3")), None);
    p.pr_preview_url = Some("https://pr{pr}.example.com/".into());
    assert_eq!(p.preview_for(Some("https://github.com/o/r/pull/3/files")).as_deref(), Some("https://pr3.example.com/"));
    assert_eq!(p.preview_for(Some("https://example.com/o/r/issues/3")), None);
    assert_eq!(p.preview_for(None), None);
    drop(c);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[test]
fn a_database_at_version_65_gets_projects_copy_files_and_link_folders() {
    let path = crate::testing::temp_dir().join("huntaway.db");
    {
        let c = open(&path).unwrap();
        c.execute_batch(
            "ALTER TABLE projects DROP COLUMN copy_files;
                 ALTER TABLE projects DROP COLUMN link_folders;
                 PRAGMA user_version=65;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','p','1');
                 INSERT INTO projects (id,profile_id,name,key,repo_path,scratch_path,worktrees_root,created_at)
                   VALUES ('pr','p','P','P','/x','/s','/w','1');",
        )
        .unwrap();
    }
    let c = open(&path).unwrap();
    assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
    let p = get_project(&c, "pr").unwrap().unwrap();
    assert_eq!((p.copy_files.as_str(), p.link_folders.as_str()), ("", ""));
    let p = update_project(&c, "pr", &[("copy_files", json!(".env")), ("link_folders", json!("models"))]).unwrap().unwrap();
    assert_eq!((p.copy_files.as_str(), p.link_folders.as_str()), (".env", "models"));
    drop(c);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[test]
fn a_database_where_github_accounts_were_version_42_44_or_45_keeps_them() {
    // As PR previews of GitHub accounts left it: at 42, before archived projects and scratch
    // tasks took versions 42 and 43, at 44, before starred tasks took 44, and at 45, before
    // pinned titles and queued users' text took 45 and 46.
    let newer = "ALTER TABLE tasks DROP COLUMN title_pinned; ALTER TABLE tasks DROP COLUMN queued_user_text; ALTER TABLE claude_configs DROP COLUMN show_usage; ALTER TABLE tasks DROP COLUMN done_at;";
    for (version, before) in [
        (42, format!("ALTER TABLE projects DROP COLUMN archived_at; ALTER TABLE tasks DROP COLUMN work_dir; {newer}")),
        (44, format!("ALTER TABLE tasks DROP COLUMN starred; ALTER TABLE tasks DROP COLUMN remind_at; ALTER TABLE tasks DROP COLUMN reminder; {newer}")),
        (45, newer.to_string()),
    ] {
        let path = crate::testing::temp_dir().join("huntaway.db");
        {
            let c = open(&path).unwrap();
            c.execute_batch(&format!(
                "{before}
                     PRAGMA user_version={version};
                     INSERT INTO profiles (id,name,created_at,github_account) VALUES ('p','work','1','work-me');
                     INSERT INTO tasks (id,profile_id,kind,title,last_activity_at,created_at,updated_at) VALUES ('t','p','task','t','1','1','1');"
            ))
            .unwrap();
        }
        let c = open(&path).unwrap();
        assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
        assert_eq!(get_profile(&c, "p").unwrap().unwrap().github_account.as_deref(), Some("work-me"), "{version}");
        let t = get_task(&c, "t").unwrap().unwrap();
        assert!(!t.starred && !t.title_pinned && t.queued_user_text.is_none(), "{version}");
        drop(c);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }
}


#[test]
fn version_69_collects_the_compactions_threads_show() {
    let path = crate::testing::temp_dir().join("huntaway.db");
    {
        let c = open(&path).unwrap();
        let boundary = |trigger: &str, extra: &str| {
            format!(r#"{{"type":"system","subtype":"compact_boundary","compact_metadata":{{"trigger":"{trigger}","pre_tokens":900,"post_tokens":90,"duration_ms":5}}{extra}}}"#)
        };
        c.execute_batch(&format!(
            "DROP TABLE context_stats;
                 ALTER TABLE runs DROP COLUMN turn_start_tokens; ALTER TABLE runs DROP COLUMN turn_tokens;
                 PRAGMA user_version=68;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','work','1');
                 INSERT INTO tasks (id,profile_id,kind,number,title,status,last_activity_at,created_at,updated_at)
                   VALUES ('t','p','task',1,'One','in_progress','1','1','1');
                 INSERT INTO runs (id,task_id,kind,status,created_at) VALUES
                   ('prompt','t','prompt','done','2026-10-01T10:00:00.000Z'),
                   ('idle','t','compact','done','2026-10-01T11:00:00.000Z'),
                   ('user','t','compact','done','2026-10-01T12:00:00.000Z');
                 INSERT INTO messages (task_id,kind,data,created_at) VALUES
                   ('t','user','{{\"text\":\"go\"}}','2026-10-01T10:00:00.000Z'),
                   ('t','claude','{auto}','2026-10-01T10:30:00.000Z'),
                   ('t','event','{{\"text\":\"Compacting the conversation after 50 minutes idle\"}}','2026-10-01T11:00:00.000Z'),
                   ('t','claude','{idle}','2026-10-01T11:01:00.000Z'),
                   ('t','user','{{\"text\":\"/compact\"}}','2026-10-01T12:00:00.000Z'),
                   ('t','claude','{user}','2026-10-01T12:01:00.000Z'),
                   ('t','claude','{sub}','2026-10-01T12:02:00.000Z');",
            auto = boundary("auto", ""),
            idle = boundary("manual", ""),
            user = boundary("manual", ""),
            sub = boundary("auto", r#","parent_tool_use_id":"agent-1""#),
        ))
        .unwrap();
    }
    let c = open(&path).unwrap();
    assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
    let mut st = c.prepare("SELECT run_id, kind, source, tokens, post_tokens, duration_ms FROM context_stats ORDER BY at").unwrap();
    let rows: Vec<(String, String, String, i64, i64, i64)> =
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))).unwrap().map(|r| r.unwrap()).collect();
    let row = |run: &str, source: &str| (run.to_string(), "compact".to_string(), source.to_string(), 900, 90, 5);
    // A subagent's compaction isn't the thread's.
    assert_eq!(rows, vec![row("prompt", "auto"), row("idle", "idle"), row("user", "user")]);
    drop(st);
    drop(c);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[test]
fn a_database_where_scratch_tasks_were_version_42_gets_archived_projects() {
    let path = crate::testing::temp_dir().join("huntaway.db");
    {
        let c = open(&path).unwrap();
        // As a build of scratch tasks from before archived projects took version 42 left it.
        c.execute_batch(
            "ALTER TABLE projects DROP COLUMN archived_at;
                 ALTER TABLE tasks DROP COLUMN title_pinned;
                 ALTER TABLE tasks DROP COLUMN queued_user_text;
                 ALTER TABLE claude_configs DROP COLUMN show_usage; ALTER TABLE tasks DROP COLUMN done_at;
                 PRAGMA user_version=42;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','work','1');
                 INSERT INTO projects (id,profile_id,name,key,repo_path,scratch_path,worktrees_root,created_at)
                   VALUES ('pr','p','Site','SP','/src/site','/s','/w','1');
                 INSERT INTO tasks (id,profile_id,kind,task_type,number,title,status,work_dir,last_activity_at,created_at,updated_at)
                   VALUES ('s','p','task','scratch',1,'Chat','done','/old','1','1','1');",
        )
        .unwrap();
    }
    let c = open(&path).unwrap();
    assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
    let indexes: i64 = c
        .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name IN ('runs_task', 'permission_requests_task')", [], |r| r.get(0))
        .unwrap();
    assert_eq!(indexes, 2, "the indexes of version 64");
    assert_eq!(get_project(&c, "pr").unwrap().unwrap().archived_at, None);
    let t = get_task(&c, "s").unwrap().unwrap();
    assert_eq!((t.number, t.work_dir.as_deref(), t.is_scratch()), (1, Some("/old"), true));
    drop(c);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[test]
fn a_database_where_stars_and_reminders_were_version_42_keeps_them() {
    let path = crate::testing::temp_dir().join("huntaway.db");
    {
        let c = open(&path).unwrap();
        // As a build of stars and reminders from before archived projects and scratch tasks
        // took versions 42 and 43 left it.
        c.execute_batch(
            "ALTER TABLE projects DROP COLUMN archived_at;
                 ALTER TABLE tasks DROP COLUMN work_dir;
                 ALTER TABLE tasks DROP COLUMN title_pinned;
                 ALTER TABLE tasks DROP COLUMN queued_user_text;
                 ALTER TABLE claude_configs DROP COLUMN show_usage; ALTER TABLE tasks DROP COLUMN done_at;
                 PRAGMA user_version=42;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','work','1');
                 INSERT INTO tasks (id,profile_id,kind,number,title,status,starred,remind_at,reminder,queued_message,queued_from_agent,last_activity_at,created_at,updated_at)
                   VALUES ('t','p','task',1,'Later','todo',1,'2030-01-01T00:00:00.000Z','Look again','and the docs',0,'1','1','1'),
                          ('u','p','task',2,'Other','todo',0,NULL,NULL,'from an agent',1,'1','1','1');",
        )
        .unwrap();
    }
    let c = open(&path).unwrap();
    assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
    let t = get_task(&c, "t").unwrap().unwrap();
    assert_eq!((t.starred, t.remind_at.as_deref(), t.reminder.as_deref()), (true, Some("2030-01-01T00:00:00.000Z"), Some("Look again")));
    // A message queued before is the user's unless other agents sent all of it.
    assert_eq!(t.queued_user_text.as_deref(), Some("and the docs"));
    assert_eq!(get_task(&c, "u").unwrap().unwrap().queued_user_text, None);
    drop(c);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[test]
fn scratch_chats_become_scratch_tasks() {
    let dir = crate::testing::temp_dir();
    let path = dir.join("huntaway.db");
    {
        let c = open(&path).unwrap();
        // As version 41 left it, with a project's scratch chat, two of the profile's and a
        // project that has the key scratch tasks now use.
        c.execute_batch(
            "ALTER TABLE tasks DROP COLUMN work_dir;
                 ALTER TABLE projects DROP COLUMN archived_at;
                 ALTER TABLE tasks DROP COLUMN title_pinned;
                 ALTER TABLE tasks DROP COLUMN queued_user_text;
                 ALTER TABLE claude_configs DROP COLUMN show_usage; ALTER TABLE tasks DROP COLUMN done_at;
                 PRAGMA user_version=41;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','work','1');
                 INSERT INTO projects (id,profile_id,name,key,repo_path,scratch_path,worktrees_root,created_at)
                   VALUES ('pr','p','Site','S','/src/site','/data/projects/pr/scratch','/w','1');
                 INSERT INTO projects (id,profile_id,name,key,repo_path,scratch_path,worktrees_root,created_at)
                   VALUES ('sp','p','Spare','SP','/src/spare','/s','/w','1');
                 INSERT INTO projects (id,profile_id,name,key,repo_path,scratch_path,worktrees_root,former_keys,created_at)
                   VALUES ('aa','p','Again','AA','/src/again','/s','/w','[\"sp2\"]','1');
                 INSERT INTO tasks (id,profile_id,project_id,kind,number,title,status,last_activity_at,created_at,updated_at)
                   VALUES ('old','p','aa','task',1,'Old','todo','1','1','1');
                 INSERT INTO tasks (id,profile_id,project_id,kind,number,title,status,last_activity_at,created_at,updated_at)
                   VALUES ('code','p','pr','task',1,'Code','in_review','1','1','1');
                 INSERT INTO tasks (id,profile_id,project_id,kind,title,status,session_id,last_activity_at,created_at,updated_at)
                   VALUES ('b','p',NULL,'scratch','Second','todo','s2','3','3','3');
                 INSERT INTO tasks (id,profile_id,project_id,kind,title,status,last_activity_at,created_at,updated_at)
                   VALUES ('a','p','pr','scratch','First','todo','2','2','2');",
        )
        .unwrap();
    }
    let c = open(&path).unwrap();
    let a = get_task(&c, "a").unwrap().unwrap();
    let b = get_task(&c, "b").unwrap().unwrap();
    for t in [&a, &b] {
        assert!(t.is_scratch(), "{t:?}");
        assert_eq!((t.project_id.as_deref(), t.status.as_str(), t.resolution.as_deref()), (None, "done", Some("done")));
    }
    // Numbered in the order they were made, each working where its conversation is.
    assert_eq!((a.number, a.work_dir.as_deref()), (1, Some("/data/projects/pr/scratch")));
    let profile_dir = path_str(&dir.join("profiles").join("p").join("scratch"));
    assert_eq!((b.number, b.work_dir.as_deref(), b.session_id.as_deref()), (2, Some(profile_dir.as_str()), Some("s2")));
    assert_eq!(scratch_task_by_number(&c, "p", 2).unwrap().unwrap().id, "b");
    // The project's tasks stay as they were, and it gives up the key S, for one no other
    // project has now (SP) or had before (SP2, whose tasks it still names).
    assert_eq!(get_task(&c, "code").unwrap().unwrap().status, "in_review");
    assert_eq!(get_project(&c, "pr").unwrap().unwrap().key, "SP3");
    // New ones carry on the numbers.
    let p = get_profile(&c, "p").unwrap().unwrap();
    let new = NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "t", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
    let t = insert_scratch_task(&c, new).unwrap();
    assert_eq!((t.number, t.work_dir.as_deref(), t.is_scratch()), (3, None, true));
    drop(c);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_database_from_version_38_gets_permission_request_kinds() {
    let path = crate::testing::temp_dir().join("huntaway.db");
    {
        let c = open(&path).unwrap();
        // As version 38 (task documents) left it, before permission requests had a kind (and
        // projects their old keys, repository root and archived time, and tasks stars, reminders, pinned titles and queued users' text).
        c.execute_batch(
            "ALTER TABLE permission_requests DROP COLUMN kind;
                 ALTER TABLE projects DROP COLUMN former_keys;
                 ALTER TABLE projects DROP COLUMN repo_root;
                 ALTER TABLE tasks DROP COLUMN work_dir;
                 ALTER TABLE projects DROP COLUMN archived_at;
                 ALTER TABLE tasks DROP COLUMN starred;
                 ALTER TABLE tasks DROP COLUMN remind_at;
                 ALTER TABLE tasks DROP COLUMN reminder;
                 ALTER TABLE profiles DROP COLUMN github_account;
                 ALTER TABLE projects DROP COLUMN github_account;
                 ALTER TABLE tasks DROP COLUMN title_pinned;
                 ALTER TABLE tasks DROP COLUMN queued_user_text;
                 ALTER TABLE claude_configs DROP COLUMN show_usage; ALTER TABLE tasks DROP COLUMN done_at;
                 PRAGMA user_version=38;",
        )
        .unwrap();
        c.execute("INSERT INTO profiles (id,name,created_at) VALUES ('p','work','1')", []).unwrap();
        c.execute("INSERT INTO tasks (id,profile_id,kind,title,last_activity_at,created_at,updated_at) VALUES ('t','p','scratch','t','1','1','1')", []).unwrap();
        c.execute("INSERT INTO permission_requests (id,task_id,message_id,tool_name,input,created_at) VALUES ('r','t',1,'Bash','{}','1')", []).unwrap();
        c.execute(
            "INSERT INTO projects (id,profile_id,name,key,repo_path,scratch_path,worktrees_root,created_at) VALUES ('x','p','x','X','/x','/s','/w','1')",
            [],
        )
        .unwrap();
    }
    let c = open(&path).unwrap();
    let version: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    let kind: String = c.query_row("SELECT kind FROM permission_requests WHERE id='r'", [], |r| r.get(0)).unwrap();
    assert_eq!((version, kind.as_str()), (VERSION, "tool"));
    // Projects from before aren't archived.
    assert_eq!(get_project(&c, "x").unwrap().unwrap().archived_at, None);
    let t = get_task(&c, "t").unwrap().unwrap();
    assert_eq!((t.starred, t.remind_at, t.reminder), (false, None, None));
    drop(c);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[test]
fn profile_config_dirs_become_claude_configs() {
    let c = open(std::path::Path::new(":memory:")).unwrap();
    // Back to how version 17 left things.
    c.execute_batch(
        "DROP TABLE claude_configs;
             ALTER TABLE profiles DROP COLUMN claude_config_ids;
             ALTER TABLE projects DROP COLUMN claude_config_ids;
             ALTER TABLE tasks DROP COLUMN claude_config_id;
             PRAGMA user_version=17;",
    )
    .unwrap();
    for (id, name, dir, at) in [("a", "work", "~/.claude-work", "1"), ("b", "personal", "~/.claude-me", "2"), ("c", "work2", "~/.claude-work", "3")] {
        c.execute("INSERT INTO profiles (id,name,claude_config_dir,created_at) VALUES (?1,?2,?3,?4)", params![id, name, dir, at]).unwrap();
    }
    for (id, profile, session) in [("t1", "a", Some("s1")), ("t2", "b", None)] {
        c.execute(
            "INSERT INTO tasks (id,profile_id,kind,title,session_id,last_activity_at,created_at,updated_at) VALUES (?1,?2,'scratch','t',?3,'1','1','1')",
            params![id, profile, session],
        )
        .unwrap();
    }
    migrate_claude_configs(&c).unwrap();
    let configs = list_claude_configs(&c).unwrap();
    assert_eq!(configs.iter().map(|c| (c.name.as_str(), c.config_dir.as_str())).collect::<Vec<_>>(), [("personal", "~/.claude-me"), ("work", "~/.claude-work")]);
    let a = get_profile(&c, "a").unwrap().unwrap();
    // Profiles that shared a directory share its config.
    assert_eq!(a.claude_config_ids, get_profile(&c, "c").unwrap().unwrap().claude_config_ids);
    assert_eq!(a.claude_config_dir, "~/.claude-work");
    // Threads keep their profile's config, whatever the profile picks later.
    assert_eq!(get_task(&c, "t1").unwrap().unwrap().claude_config_id, a.claude_config_ids.first().cloned());
    update_profile(&c, "a", &[("claude_config_ids", json!(get_profile(&c, "b").unwrap().unwrap().claude_config_ids))]).unwrap();
    assert_eq!(task_config_dir(&c, &get_task(&c, "t1").unwrap().unwrap()).unwrap().as_deref(), Some("~/.claude-work"));
    assert_eq!(task_config_dir(&c, &get_task(&c, "t2").unwrap().unwrap()).unwrap().as_deref(), Some("~/.claude-me"));
    assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 18);
}

#[test]
fn threads_pick_their_project_or_profile_config() {
    let c = open(std::path::Path::new(":memory:")).unwrap();
    let work = insert_claude_config(&c, "work", "~/.claude-work", "claude").unwrap();
    let me = insert_claude_config(&c, "me", "~/.claude-me", "claude").unwrap();
    let p = insert_profile(&c, "p", &[work.id.clone(), me.id.clone()], None).unwrap();
    assert_eq!(p.claude_config_dir, "~/.claude-work");
    let project = insert_project(
        &c,
        NewProject { id: "pr", profile_id: &p.id, name: "x", key: "X", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false },
    )
    .unwrap();
    let task = |cfg: Option<&str>| {
        let t = NewTask {
            profile_id: &p.id,
            project_id: Some("pr"),
            kind: "task",
            title: "t",
            description: "",
            status: "todo",
            use_worktree: false,
            model: None,
            effort: None,
            claude_config_id: cfg,
        };
        insert_task(&c, t).unwrap()
    };
    let names = |p: &Project| available_configs(&c, &p.profile_id, Some(p)).unwrap().into_iter().map(|c| c.name).collect::<Vec<_>>();
    // The profile's configs, the default first.
    assert_eq!(names(&project), ["work", "me"]);
    let t = task(None);
    assert_eq!(t.claude_config_id.as_deref(), Some(work.id.as_str()));
    assert_eq!(task(Some(&me.id)).claude_config_id.as_deref(), Some(me.id.as_str()));

    // A project's own list overrides the profile's.
    let project = update_project(&c, "pr", &[("claude_config_ids", json!(json!([me.id]).to_string()))]).unwrap().unwrap();
    assert_eq!(names(&project), ["me"]);
    // A thread keeps the config it started with.
    assert_eq!(task_config_dir(&c, &t).unwrap().as_deref(), Some("~/.claude-work"));

    // Deleting a config takes it off the profile and the project, and its threads go to the default.
    delete_claude_config(&c, &me.id).unwrap();
    let project = get_project(&c, "pr").unwrap().unwrap();
    assert_eq!(project.claude_config_ids, None);
    assert_eq!(get_profile(&c, &p.id).unwrap().unwrap().claude_config_ids, [work.id.clone()]);
    let orphan = task(None);
    assert_eq!(task_claude_config(&c, &orphan).unwrap().map(|c| c.name).as_deref(), Some("work"));
    let mut t = t;
    t.claude_config_id = Some(me.id.clone());
    assert_eq!(task_claude_config(&c, &t).unwrap().map(|c| c.name).as_deref(), Some("work"));

    // A thread that started with no config at all stays in Claude's default one.
    t.claude_config_id = None;
    assert_eq!(task_claude_config(&c, &t).unwrap().map(|c| c.name).as_deref(), Some("work"));
    t.session_id = Some("s".into());
    assert!(task_claude_config(&c, &t).unwrap().is_none());
}
#[test]
fn threads_load_in_pages_of_main_conversation_messages() {
    let c = open(std::path::Path::new(":memory:")).unwrap();
    let p = insert_profile(&c, "p", &[], None).unwrap();
    let t = NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "t", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
    let t = insert_task(&c, t).unwrap();
    let add = |kind: &str, data: Value| insert_message(&c, &t.id, kind, &data).unwrap().id;
    let text = |s: &str| json!({"type": "assistant", "message": {"content": [{"type": "text", "text": s}]}});
    let first = add("user", json!({"text": "go"}));
    // A background subagent, then its own messages, a progress line from it and a shell's.
    add("claude", json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "on it"}, {"type": "tool_use", "id": "a1", "name": "Agent", "input": {"description": "look", "prompt": "p".repeat(300)}}]}}));
    let report = "Async agent launched successfully. ".repeat(20);
    add("claude", json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "a1", "content": report}]}, "tool_use_result": {"isAsync": true, "content": ["big"]}}));
    add("claude", json!({"type": "system", "subtype": "task_started", "task_id": "k1", "tool_use_id": "a1", "is_backgrounded": true}));
    add("claude", json!({"type": "system", "subtype": "task_started", "task_id": "sh", "tool_use_id": "b1"}));
    let child = add("claude", json!({"type": "assistant", "parent_tool_use_id": "a1", "message": {"content": [{"type": "text", "text": "reading"}]}}));
    add("claude", json!({"type": "system", "subtype": "task_progress", "task_id": "k1", "description": "Reading a"}));
    let main = add("claude", text("meanwhile"));
    add("claude", json!({"type": "assistant", "parent_tool_use_id": "a1", "message": {"content": [{"type": "text", "text": "still reading"}]}}));
    let progress = add("claude", json!({"type": "system", "subtype": "task_progress", "task_id": "k1", "description": "Reading b"}));
    let last = add("claude", text("done"));

    let ids = |(page, more): (Vec<Message>, bool)| (page.into_iter().map(|m| m.id).collect::<Vec<_>>(), more);
    let all: Vec<i64> = list_messages(&c, &t.id).unwrap().iter().map(|m| m.id).collect();
    assert_eq!(ids(message_page(&c, &t.id, None, None, None).unwrap()), (all.clone(), false));
    // Three of the main conversation's: the subagent's messages among them don't count.
    assert_eq!(ids(message_page(&c, &t.id, None, None, Some(3)).unwrap()), ((main..=last).collect(), true));
    // Older pages: the subagent's message is among the two before `main`, which start at a main-conversation one.
    assert_eq!(ids(message_page(&c, &t.id, None, Some(main), Some(1)).unwrap()), (vec![main - 1], true));
    assert_eq!(ids(message_page(&c, &t.id, None, Some(main), Some(2)).unwrap()), ((child - 1..main).collect(), true));
    assert_eq!(ids(message_page(&c, &t.id, None, Some(main), Some(100)).unwrap()), ((first..main).collect(), false));
    // Everything after a message, as a reload asks for.
    assert_eq!(ids(message_page(&c, &t.id, Some(main), None, None).unwrap()), ((main + 1..=last).collect(), false));
    assert!(message_page(&c, "nope", None, None, Some(5)).unwrap().0.is_empty());

    // The subagent from before `last`: its call alone, its result's start, its own task_* messages (the latest progress).
    let subs = subagent_messages(&c, &t.id, last).unwrap();
    assert_eq!(subs.len(), 4, "{subs:#?}");
    assert_eq!(subs[0].data["message"]["content"], json!([{"type": "tool_use", "id": "a1", "name": "Agent", "input": {"description": "look", "prompt": "p".repeat(200)}}]));
    let result = &subs[1].data;
    assert_eq!(result["message"]["content"][0]["content"].as_str().unwrap().len(), 200);
    assert_eq!(result["tool_use_result"], json!({"isAsync": true}));
    assert_eq!(subs[2].data["subtype"], "task_started");
    assert_eq!(subs[3].id, progress);
    assert!(subagent_messages(&c, &t.id, first).unwrap().is_empty());

    // A megabyte of a subagent's output ends the page, at the main-conversation message before it.
    let call = add("claude", json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "a2", "name": "Agent", "input": {}}]}}));
    add("claude", json!({"type": "user", "parent_tool_use_id": "a2", "message": {"content": [{"type": "tool_result", "tool_use_id": "r", "content": "x".repeat(PAGE_BYTES)}]}}));
    add("claude", json!({"type": "assistant", "parent_tool_use_id": "a2", "message": {"content": []}}));
    let end = add("claude", text("end"));
    assert_eq!(ids(message_page(&c, &t.id, None, None, Some(100)).unwrap()), ((call..=end).collect(), true));
}

#[test]
fn subagent_summaries_include_forked_skills_and_their_launch_calls() {
    let c = open(std::path::Path::new(":memory:")).unwrap();
    let p = insert_profile(&c, "p", &[], None).unwrap();
    let t = insert_task(&c, NewTask { profile_id: &p.id, project_id: None, kind: "review", title: "review", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None }).unwrap();
    let add = |data: Value| insert_message(&c, &t.id, "claude", &data).unwrap().id;
    let call = add(json!({"type": "assistant", "parent_tool_use_id": "outer", "message": {"content": [
        {"type": "tool_use", "id": "inline", "name": "Skill", "input": {"skill": "inline"}},
        {"type": "tool_use", "id": "fork", "name": "Skill", "input": {"skill": "code-review", "args": "low 139"}}
    ]}}));
    let start = add(json!({"type": "system", "subtype": "task_started", "task_type": "local_agent", "tool_use_id": "fork", "task_id": "child", "prompt": "p".repeat(300), "description": "/code-review"}));
    add(json!({"type": "assistant", "parent_tool_use_id": "fork", "message": {"content": [{"type": "text", "text": "child transcript"}]}}));
    add(json!({"type": "system", "subtype": "task_started", "task_type": "local_bash", "tool_use_id": "shell", "task_id": "shell-task"}));
    let end = add(json!({"type": "system", "subtype": "task_notification", "task_id": "child", "status": "completed", "summary": "done"}));
    let result = add(json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "fork", "content": "review report"}]}}));
    let last = add(json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "main summary"}]}}));
    let subs = subagent_messages(&c, &t.id, last).unwrap();
    assert_eq!(subs.iter().map(|m| m.id).collect::<Vec<_>>(), vec![call, start, end, result]);
    assert_eq!(subs[0].data["message"]["content"].as_array().unwrap().len(), 1);
    assert_eq!(subs[0].data["message"]["content"][0]["id"], "fork");
    assert_eq!(subs[0].data["parent_tool_use_id"], "outer");
    assert_eq!(subs[1].data["prompt"].as_str().unwrap().len(), 200);
    // A page can start between the Skill call and its task_started event.
    let split = subagent_messages(&c, &t.id, start).unwrap();
    assert_eq!(split.iter().map(|m| m.id).collect::<Vec<_>>(), vec![call]);
}

#[test]
fn dependencies_stay_in_the_project_and_never_loop() {
    let c = open(std::path::Path::new(":memory:")).unwrap();
    let p = insert_profile(&c, "p", &[], None).unwrap();
    for (id, key) in [("a", "A"), ("b", "B")] {
        let np = NewProject { id, profile_id: &p.id, name: id, key, repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
        insert_project(&c, np).unwrap();
    }
    let task = |project: &str| {
        let t = NewTask { profile_id: &p.id, project_id: Some(project), kind: "task", title: "t", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
        insert_task(&c, t).unwrap()
    };
    let (one, two, three, other) = (task("a"), task("a"), task("a"), task("b"));
    let check = |t: &Task, ids: &[&String]| check_dependencies(&c, Some(&t.id), t.project_id.as_deref(), &ids.iter().map(|s| s.to_string()).collect::<Vec<_>>());
    assert_eq!(check(&two, &[&one.id, &one.id]), Ok(vec![one.id.clone()]));
    assert!(check(&two, &[&two.id]).is_err());
    assert!(check(&two, &[&other.id]).is_err());
    assert!(check(&two, &[&"nope".to_string()]).is_err());
    update_task(&c, &two.id, &[("depends_on", json!([one.id]))]).unwrap();
    update_task(&c, &three.id, &[("depends_on", json!([two.id]))]).unwrap();
    // one → two → three, so one can't depend on three.
    assert!(check(&get_task(&c, &one.id).unwrap().unwrap(), &[&three.id]).unwrap_err().contains("already depends"));

    let unmet = |t: &Task| unmet_dependencies(&c, &get_task(&c, &t.id).unwrap().unwrap()).unwrap().into_iter().map(|t| t.id).collect::<Vec<_>>();
    assert_eq!(unmet(&three), [two.id.clone()]);
    // Closed without being merged doesn't count.
    update_task(&c, &two.id, &[("status", json!("done")), ("resolution", json!("wont_fix"))]).unwrap();
    assert_eq!(unmet(&three), [two.id.clone()]);
    update_task(&c, &two.id, &[("resolution", json!("done"))]).unwrap();
    assert!(unmet(&three).is_empty());

    // A deleted task comes off its dependents' lists.
    c.execute("DELETE FROM tasks WHERE id=?1", [&one.id]).unwrap();
    assert_eq!(drop_dependency(&c, &one.id).unwrap(), [two.id.clone()]);
    assert!(get_task(&c, &two.id).unwrap().unwrap().depends_on.is_empty());
    assert_eq!(get_task(&c, &three.id).unwrap().unwrap().depends_on, [two.id.clone()]);
}

// HA-108: a run that resumed a session was charged for the session's earlier runs again.
#[test]
fn a_database_from_version_72_counts_each_runs_cost_once() {
    let path = crate::testing::temp_dir().join("huntaway.db");
    let (task, thread) = {
        let c = open(&path).unwrap();
        let p = insert_profile(&c, "me", &[], None).unwrap();
        let new = |kind| NewTask { profile_id: &p.id, project_id: None, kind, title: "t", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let (task, thread) = (insert_task(&c, new("task")).unwrap().id, insert_task(&c, new("review")).unwrap().id);
        c.execute_batch("ALTER TABLE runs DROP COLUMN session_id; ALTER TABLE runs DROP COLUMN session_cost; PRAGMA user_version=72;").unwrap();
        // Each run's cost was its session's total, and the task was charged each run's whole total.
        // The task's runs: a session, then one that ended before its first result, then a new
        // session (its total is lower). The thread's: two review rounds, the first with a reply.
        let runs = [(&task, "a", "prompt", 1.0), (&task, "b", "prompt", 1.5), (&task, "c", "compact", 0.0), (&task, "d", "prompt", 0.4), (&task, "e", "prompt", 0.9)];
        let runs = runs.into_iter().chain([(&thread, "f", "review", 0.5), (&thread, "g", "prompt", 0.7), (&thread, "h", "review", 0.6)]);
        for (task_id, id, kind, cost) in runs {
            c.execute("INSERT INTO runs (id,task_id,kind,status,cost_usd,created_at) VALUES (?1,?2,?3,'exited',?4,'1')", params![id, task_id, kind, cost]).unwrap();
        }
        // 0.2 of the task's is from runs before runs had a cost.
        c.execute("UPDATE tasks SET cost_usd=4.0, session_id='s2' WHERE id=?1", [&task]).unwrap();
        c.execute("UPDATE tasks SET cost_usd=1.8, session_id='r2' WHERE id=?1", [&thread]).unwrap();
        for (run, cost) in [("b", 1.5), ("b", 0.1), ("e", 0.9)] {
            c.execute("INSERT INTO context_stats (task_id,run_id,kind,at,cost_usd) VALUES (?1,?2,'turn','1',?3)", params![task, run, cost]).unwrap();
        }
        (task, thread)
    };
    let c = open(&path).unwrap();
    assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
    let close = |a: f64, b: f64| (a - b).abs() < 1e-9;
    let costs = |sql: &str| -> Vec<f64> { c.prepare(sql).unwrap().query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect() };
    let runs = costs("SELECT cost_usd FROM runs ORDER BY rowid");
    assert!(runs.iter().zip([1.0, 0.5, 0.0, 0.4, 0.5, 0.5, 0.2, 0.6]).all(|(a, b)| close(*a, b)), "{runs:?}");
    let tasks = [get_task(&c, &task).unwrap().unwrap().cost_usd, get_task(&c, &thread).unwrap().unwrap().cost_usd];
    assert!(close(tasks[0], 2.6) && close(tasks[1], 1.3), "{tasks:?}");
    let turns = costs("SELECT cost_usd FROM context_stats ORDER BY id");
    assert!(turns.iter().zip([0.5, 0.1, 0.5]).all(|(a, b)| close(*a, b)), "{turns:?}");
    // The runs of each thread's current session are in it, for the next run's cost to go on from.
    let sessions: Vec<(String, Option<String>, Option<f64>)> =
        c.prepare("SELECT id, session_id, session_cost FROM runs ORDER BY rowid").unwrap().query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap().map(|r| r.unwrap()).collect();
    let s = |id: &str, session: Option<&str>, cost: Option<f64>| (id.to_string(), session.map(String::from), cost);
    let none = |id| s(id, None, None);
    assert_eq!(sessions, vec![none("a"), none("b"), none("c"), s("d", Some("s2"), Some(0.4)), s("e", Some("s2"), Some(0.9)), none("f"), none("g"), s("h", Some("r2"), Some(0.6))]);
    let next = insert_run(&c, &task, "prompt").unwrap();
    assert!(close(add_cost(&c, &next.id, Some("s2"), 1.2, true).unwrap(), 0.3));
    drop(c);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

// HA-108: a new session's runs that cost more than the old session's are a session of their own.
#[test]
fn a_database_from_version_72_keeps_new_sessions_apart() {
    let path = crate::testing::temp_dir().join("huntaway.db");
    let (rewound, checkpointed) = {
        let c = open(&path).unwrap();
        let p = insert_profile(&c, "me", &[], None).unwrap();
        let new = || NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "t", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let (rewound, checkpointed) = (insert_task(&c, new()).unwrap().id, insert_task(&c, new()).unwrap().id);
        c.execute_batch("ALTER TABLE runs DROP COLUMN session_id; ALTER TABLE runs DROP COLUMN session_cost; PRAGMA user_version=72;").unwrap();
        // One task rewound to its first message between its runs, which started a new conversation
        // (that cost more than the first); then a run of it that hadn't said its total yet. The
        // other's checkpoints say its runs were in different sessions, then the same.
        let runs = [(&rewound, "a", 1.0, "1"), (&rewound, "b", 2.0, "3"), (&rewound, "c", 0.0, "4"), (&checkpointed, "d", 1.0, "1"), (&checkpointed, "e", 2.0, "2")];
        for (task_id, id, cost, at) in runs.into_iter().chain([(&checkpointed, "f", 2.5, "3")]) {
            c.execute("INSERT INTO runs (id,task_id,kind,status,cost_usd,created_at) VALUES (?1,?2,'prompt','exited',?3,?4)", params![id, task_id, cost, at]).unwrap();
        }
        let text = "Rewound to before turn 1: 1 file restored, 0 files removed; the next message starts a new conversation";
        c.execute("INSERT INTO messages (task_id,kind,data,created_at) VALUES (?1,'event',?2,'2')", params![rewound, json!({"level": "info", "text": text}).to_string()]).unwrap();
        for (n, run, session) in [(1, "d", "k1"), (2, "e", "k2"), (3, "f", "k2")] {
            c.execute(
                "INSERT INTO checkpoints (task_id,n,kind,sha,tree,run_id,session,created_at) VALUES (?1,?2,'turn','s','t',?3,?4,'1')",
                params![checkpointed, n, run, session],
            )
            .unwrap();
        }
        c.execute("UPDATE tasks SET cost_usd=3.0, session_id='new' WHERE id=?1", [&rewound]).unwrap();
        c.execute("UPDATE tasks SET cost_usd=5.5, session_id='k2' WHERE id=?1", [&checkpointed]).unwrap();
        (rewound, checkpointed)
    };
    let c = open(&path).unwrap();
    let close = |a: f64, b: f64| (a - b).abs() < 1e-9;
    let runs: Vec<(String, f64, Option<String>, Option<f64>)> = c
        .prepare("SELECT id, cost_usd, session_id, session_cost FROM runs ORDER BY rowid")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    let want = [("a", 1.0, None, None), ("b", 2.0, Some("new"), Some(2.0)), ("c", 0.0, Some("new"), None), ("d", 1.0, None, None), ("e", 2.0, Some("k2"), Some(2.0)), ("f", 0.5, Some("k2"), Some(2.5))];
    assert_eq!(runs.len(), want.len());
    for (got, want) in runs.iter().zip(want) {
        assert!(got.0 == want.0 && close(got.1, want.1) && got.2.as_deref() == want.2 && got.3 == want.3, "{got:?} {want:?}");
    }
    let tasks = [get_task(&c, &rewound).unwrap().unwrap().cost_usd, get_task(&c, &checkpointed).unwrap().unwrap().cost_usd];
    assert!(close(tasks[0], 3.0) && close(tasks[1], 3.5), "{tasks:?}");
    // The run of the new conversation that was going during the upgrade starts from nothing.
    assert!(close(add_cost(&c, "c", Some("new"), 0.25, true).unwrap(), 0.25));
    drop(c);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}
