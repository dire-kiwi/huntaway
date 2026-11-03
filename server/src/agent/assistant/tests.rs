use serde_json::{Value, json};

use super::*;
use crate::db::{NewProject, insert_profile, insert_project};
use crate::testing::{self, state};

fn count(s: &Shared, profile_id: &str) -> i64 {
    s.db().query_row("SELECT COUNT(*) FROM tasks WHERE profile_id=?1 AND task_type='assistant'", [profile_id], |r| r.get(0)).unwrap()
}

#[test]
fn a_profiles_assistant_is_made_once_on_first_open() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        let a = get_or_create(&s, &p.id).unwrap();
        assert_eq!((a.is_assistant(), a.is_scratch(), a.project_id.as_deref(), a.number, a.status.as_str()), (true, false, None, 1, "todo"));
        assert_eq!((a.title.as_str(), a.title_pinned, a.use_worktree), ("Assistant", true, false));
        assert_eq!(runner::task_key_prefix(&s, &a), "A");
        // Its workspace is in the data dir, by its id, and made with it.
        assert_eq!(a.work_dir, Some(format!("assistants/{}", a.id)));
        let dir = crate::agent::documents::work_dir(&s, &a).unwrap();
        assert_eq!(dir, s.data_dir.join("assistants").join(&a.id));
        assert!(dir.is_dir());
        assert_eq!(runner::work_dir(&s, &a).unwrap(), dir);
        assert!(!crate::agent::documents::documents_only(&a));
        // Opening it again gives the same one, and makes its folder again if it went.
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(get_or_create(&s, &p.id).unwrap().id, a.id);
        assert!(dir.is_dir());
        assert_eq!(count(&s, &p.id), 1);
        // Another profile has one of its own, also A-1.
        let work = insert_profile(&s.db(), "work", &[], None).unwrap();
        let b = get_or_create(&s, &work.id).unwrap();
        assert_ne!(b.id, a.id);
        assert_eq!((b.number, b.profile_id.as_str()), (1, work.id.as_str()));
        assert!(get_or_create(&s, "nope").is_err());
    });
}

#[test]
fn a_profile_has_one_assistant_at_most() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        let a = get_or_create(&s, &p.id).unwrap();
        let new = db::NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "x", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
        // The database refuses a second, and the failed insert leaves nothing behind.
        let tasks = || s.db().query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get::<_, i64>(0)).unwrap();
        let before = tasks();
        assert!(db::insert_assistant_task(&s.db(), new, work_dir).is_err());
        assert_eq!(tasks(), before);
        // Nor can a task become one, as its type isn't one a task can be given.
        let t = crate::api::create_scratch_task_inner(&s, &p.id, crate::api::CreateTask { task_type: Some("assistant".into()), ..Default::default() });
        assert!(t.is_err());
        // Once it's deleted, the next open makes another, numbered after it.
        crate::api::delete_task_inner(&s, &a, false).await.unwrap();
        let b = get_or_create(&s, &p.id).unwrap();
        assert_ne!(b.id, a.id);
        assert_eq!(count(&s, &p.id), 1);
    });
}

#[test]
fn first_opens_at_once_make_one_assistant() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        let opens: Vec<_> = (0..8)
            .map(|_| {
                let (s, id) = (s.clone(), p.id.clone());
                std::thread::spawn(move || get_or_create(&s, &id).map(|t| t.id).map_err(|e| e.1))
            })
            .collect();
        let ids: std::collections::BTreeSet<String> = opens.into_iter().map(|h| h.join().unwrap().unwrap()).collect();
        assert_eq!(ids.len(), 1);
        assert_eq!(count(&s, &p.id), 1);
    });
}

#[test]
fn the_assistant_is_off_the_board_unless_asked_for() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        let scratch = crate::api::create_scratch_task_inner(&s, &p.id, crate::api::CreateTask::default()).unwrap();
        let a = get_or_create(&s, &p.id).unwrap();
        let ids = |l: Vec<db::Task>| l.into_iter().map(|t| t.id).collect::<Vec<_>>();
        // The board's tasks in no project (group and scratch tasks).
        assert_eq!(ids(db::list_group_tasks(&s.db(), &p.id, false).unwrap()), [scratch.id.clone()]);
        assert_eq!(ids(db::list_group_tasks(&s.db(), &p.id, true).unwrap()), [scratch.id.clone(), a.id.clone()]);
        assert_eq!(ids(db::list_tasks_for_profile(&s.db(), &p.id, false).unwrap()), [scratch.id.clone()]);
        assert_eq!(db::list_tasks_for_profile(&s.db(), &p.id, true).unwrap().len(), 2);
        // Over the API.
        let app = crate::api::router(s.clone());
        let (status, list) = crate::api::tests::call(&app, "GET", &format!("/api/profiles/{}/tasks", p.id)).await;
        assert_eq!((status, list.as_array().unwrap().len()), (200, 1));
        let (_, list) = crate::api::tests::call(&app, "GET", &format!("/api/profiles/{}/tasks?include_assistant=true", p.id)).await;
        assert_eq!(list.as_array().unwrap().len(), 2);
        let (_, list) = crate::api::tests::call(&app, "GET", &format!("/api/profiles/{}/group-tasks", p.id)).await;
        assert_eq!(list.as_array().unwrap().iter().map(|t| t["id"].clone()).collect::<Vec<_>>(), [json!(scratch.id)]);
        let (_, list) = crate::api::tests::call(&app, "GET", &format!("/api/profiles/{}/group-tasks?include_assistant=true", p.id)).await;
        assert_eq!(list.as_array().unwrap().len(), 2);
        let (status, got) = crate::api::tests::call(&app, "GET", &format!("/api/profiles/{}/assistant", p.id)).await;
        assert_eq!((status, &got["id"], &got["task_type"]), (200, &json!(a.id), &json!("assistant")));
        assert_eq!(crate::api::tests::call(&app, "GET", "/api/profiles/nope/assistant").await.0, 404);
    });
}

#[test]
fn the_assistant_never_goes_to_review_or_merge() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        let a = get_or_create(&s, &p.id).unwrap();
        for status in ["in_review", "ready_for_merge", "done", "backlog"] {
            let err = crate::api::update_task_inner(&s, &a.id, json!({"status": status}).as_object().unwrap()).await.unwrap_err();
            assert_eq!(err.0, axum::http::StatusCode::BAD_REQUEST, "{status}");
        }
        for (field, on) in [("use_worktree", json!(true)), ("subproject", json!(true))] {
            assert!(crate::api::update_task_inner(&s, &a.id, json!({field: on}).as_object().unwrap()).await.is_err(), "{field}");
        }
        let t = crate::api::update_task_inner(&s, &a.id, json!({"status": "needs_attention", "starred": true}).as_object().unwrap()).await.unwrap();
        assert_eq!((t.status.as_str(), t.starred), ("needs_attention", true));
    });
}

#[test]
fn the_assistant_writes_its_workspace_without_asking() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        let a = get_or_create(&s, &p.id).unwrap();
        let dir = crate::agent::documents::work_dir(&s, &a).unwrap();
        let write = |f: &std::path::Path| crate::agent::documents::writes_own_folder(&s, &a, "Write", &json!({"file_path": f}));
        assert!(write(&dir.join("MEMORY.md")));
        assert!(write(&dir.join("memory").join("2026-11-03.md")));
        assert!(!write(&s.data_dir.join("huntaway.db")));
        assert!(!write(&dir.join("..").join("x")));
        // A scratch task still writes only its own folder.
        let t = crate::api::create_scratch_task_inner(&s, &p.id, crate::api::CreateTask::default()).unwrap();
        assert!(!crate::agent::documents::writes_own_folder(&s, &t, "Write", &json!({"file_path": dir.join("MEMORY.md")})));
    });
}

#[test]
fn no_project_can_have_the_assistants_key() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        let app = crate::api::router(s.clone());
        let body = json!({"name": "Apps", "key": "A", "repo_path": crate::util::path_str(&testing::temp_dir())});
        let req = axum::http::Request::builder()
            .method("POST")
            .uri(format!("/api/profiles/{}/projects", p.id))
            .header("authorization", "Bearer ")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(body.to_string()))
            .unwrap();
        use tower::ServiceExt;
        let res = app.oneshot(req).await.unwrap();
        let status = res.status().as_u16();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(status, 400, "{v}");
        assert!(v["error"].as_str().unwrap().contains("the assistant"), "{v}");
    });
}

#[test]
fn a_database_at_version_76_frees_the_key_a() {
    let path = testing::temp_dir().join("huntaway.db");
    {
        let c = db::open(&path).unwrap();
        let p = insert_profile(&c, "p", &[], None).unwrap();
        let new = NewProject { id: "apps", profile_id: &p.id, name: "Apps", key: "A", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
        insert_project(&c, new).unwrap();
        c.execute_batch("DROP INDEX tasks_one_assistant; PRAGMA user_version=76;").unwrap();
    }
    let c = db::open(&path).unwrap();
    assert_eq!(db::get_project(&c, "apps").unwrap().unwrap().key, "AP");
    let index: i64 = c.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='tasks_one_assistant'", [], |r| r.get(0)).unwrap();
    assert_eq!(index, 1);
}
