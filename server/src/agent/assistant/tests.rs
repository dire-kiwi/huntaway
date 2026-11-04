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
fn a_database_at_version_87_frees_the_key_a() {
    let path = testing::temp_dir().join("huntaway.db");
    {
        let c = db::open(&path).unwrap();
        let p = insert_profile(&c, "p", &[], None).unwrap();
        let new = NewProject { id: "apps", profile_id: &p.id, name: "Apps", key: "A", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
        insert_project(&c, new).unwrap();
        c.execute_batch("DROP INDEX tasks_one_assistant; PRAGMA user_version=87;").unwrap();
    }
    let c = db::open(&path).unwrap();
    assert_eq!(db::get_project(&c, "apps").unwrap().unwrap().key, "AP");
    let index: i64 = c.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='tasks_one_assistant'", [], |r| r.get(0)).unwrap();
    assert_eq!(index, 1);
}

#[test]
fn an_assistant_host_must_be_a_linked_host_with_assistants() {
    testing::run(async || {
        use crate::hosts::uplink::tests::{api, link_by_url, node};
        let (hub, host) = (node("hub", "desktop"), node("host", "homeserver"));
        let p = insert_profile(&hub.db(), "personal", &[], None).unwrap();
        link_by_url(&hub, &host).await;
        // A host with assistants but from before assistant hosts (API 107), which is connected, so it can tell.
        crate::hosts::hub::link_http(&hub, "old", axum::Router::new(), ASSISTANT_HOST_API - 1).await;
        db::upsert_link(&hub.db(), "old", "old", "outbound", Some("http://x"), None).unwrap();
        let path = format!("/api/profiles/{}", p.id);
        let set = |v: Value| {
            let (hub, path) = (hub.clone(), path.clone());
            async move { api(&hub, "PATCH", &path, Some(json!({"assistant_host": v}))).await }
        };
        for (bad, why) in [(json!("nope"), "must be a linked host"), (json!(5), "must be a linked host's id or null"), (json!("old"), "older build that can't be an assistant host")] {
            let (status, v) = set(bad.clone()).await;
            assert_eq!(status, 400, "{bad}");
            assert!(v["error"].as_str().unwrap().contains(why), "{bad}: {v}");
        }
        assert_eq!(set(json!("host")).await.1["assistant_host"], "host");
        // Unchanged by a save that doesn't send it, as from an older UI.
        assert_eq!(api(&hub, "PATCH", &path, Some(json!({"default_model": "haiku"}))).await.1["assistant_host"], "host");
        // This host is the same as none.
        for none in [json!("hub"), json!(""), Value::Null] {
            assert_eq!(set(json!("host")).await.0, 200);
            assert_eq!(set(none.clone()).await.1["assistant_host"], Value::Null, "{none}");
        }
        // An offline host can't say, so it's taken.
        hub.links.lock().unwrap().remove("old");
        assert_eq!(set(json!("old")).await.1["assistant_host"], "old");
        // Or given when the profile's made.
        let (status, made) = api(&hub, "POST", "/api/profiles", Some(json!({"name": "other", "assistant_host": "host"}))).await;
        assert_eq!((status, &made["assistant_host"]), (200, &json!("host")));
        assert_eq!(api(&hub, "POST", "/api/profiles", Some(json!({"name": "third", "assistant_host": "nope"}))).await.0, 400);
        assert!(db::list_profiles(&hub.db()).unwrap().iter().all(|p| p.name != "third"));
        // Removing the host takes it off the profiles that named it.
        assert_eq!(api(&hub, "DELETE", "/api/hosts/host", None).await.0, 200);
        assert!(db::list_profiles(&hub.db()).unwrap().iter().all(|p| p.assistant_host.as_deref() != Some("host")));
        assert_eq!(db::get_profile(&hub.db(), &p.id).unwrap().unwrap().assistant_host.as_deref(), Some("old"));
    });
}

#[test]
fn the_hub_sends_a_profiles_assistant_to_its_host() {
    testing::run(async || {
        use crate::hosts::uplink::tests::{api, link_by_url, node};
        let (hub, host) = (node("hub", "desktop"), node("host", "homeserver"));
        let p = insert_profile(&hub.db(), "personal", &[], None).unwrap();
        link_by_url(&hub, &host).await;
        db::update_profile(&hub.db(), &p.id, &[("assistant_host", json!("host"))]).unwrap();
        let path = format!("/api/profiles/{}/assistant", p.id);
        // The host has no personal profile yet.
        let (status, v) = api(&hub, "GET", &path, None).await;
        assert_eq!(status, 409);
        assert!(v["error"].as_str().unwrap().contains("homeserver has no profile named personal"), "{v}");
        let there = insert_profile(&host.db(), "personal", &[], None).unwrap();
        // Its own profile's, on that host, which says so; none is made on the hub.
        let (status, a) = api(&hub, "GET", &path, None).await;
        assert_eq!((status, &a["host_id"], &a["task_type"]), (200, &json!("host"), &json!("assistant")));
        assert_eq!(db::assistant_task(&host.db(), &there.id).unwrap().unwrap().id, a["id"].as_str().unwrap());
        assert_eq!(count(&hub, &p.id), 0);
        // Through the hub's proxy, as a client that's told the host goes on to the task there.
        let (status, t) = api(&hub, "GET", &format!("/api/h/host/tasks/{}", a["id"].as_str().unwrap()), None).await;
        assert_eq!((status, &t["task"]["id"]), (200, &a["id"]));
        // Without the setting, it's the hub's own.
        db::update_profile(&hub.db(), &p.id, &[("assistant_host", Value::Null)]).unwrap();
        let (_, own) = api(&hub, "GET", &path, None).await;
        assert_eq!((&own["host_id"], count(&hub, &p.id)), (&json!("hub"), 1));
        // A host's profile that names the hub as its assistant's host doesn't send a routed request back.
        db::upsert_link(&host.db(), "hub", "desktop", "outbound", Some("http://x"), None).unwrap();
        db::update_profile(&host.db(), &there.id, &[("assistant_host", json!("hub"))]).unwrap();
        db::update_profile(&hub.db(), &p.id, &[("assistant_host", json!("host"))]).unwrap();
        let (status, a2) = api(&hub, "GET", &path, None).await;
        assert_eq!((status, &a2["id"]), (200, &a["id"]));
        // Offline: says so, rather than making one here.
        hub.links.lock().unwrap().remove("host");
        let (status, v) = api(&hub, "GET", &path, None).await;
        assert_eq!(status, 503);
        assert_eq!(v["error"], "personal's assistant runs on homeserver, which is offline");
        let (status, _) = api(&hub, "POST", &path, Some(json!({"text": "hello"}))).await;
        assert_eq!(status, 503);
        assert_eq!(count(&hub, &p.id), 1);
    });
}

#[test]
fn a_message_to_the_assistant_goes_to_its_host() {
    testing::run(async || {
        use crate::hosts::uplink::tests::{api, node};
        let hub = node("hub", "desktop");
        let p = insert_profile(&hub.db(), "personal", &[], None).unwrap();
        // A host that records what it's sent rather than starting an agent.
        let sent = std::sync::Arc::new(std::sync::Mutex::new(Vec::<(String, Value)>::new()));
        let log = sent.clone();
        let host = axum::Router::new()
            .route("/api/profiles", axum::routing::get(|| async { axum::Json(json!([{"id": "pp", "name": "personal"}])) }))
            .route(
                "/api/profiles/{id}/assistant",
                axum::routing::post(move |uri: axum::http::Uri, axum::Json(b): axum::Json<Value>| {
                    let log = log.clone();
                    async move {
                        log.lock().unwrap().push((uri.to_string(), b));
                        axum::Json(json!({"id": "a1", "task_type": "assistant"}))
                    }
                }),
            );
        crate::hosts::hub::link_http(&hub, "host", host, crate::hosts::proto::API_VERSION).await;
        db::upsert_link(&hub.db(), "host", "homeserver", "outbound", Some("http://x"), None).unwrap();
        db::update_profile(&hub.db(), &p.id, &[("assistant_host", json!("host"))]).unwrap();
        let (status, t) = api(&hub, "POST", &format!("/api/profiles/{}/assistant", p.id), Some(json!({"text": "Remind me at 5"}))).await;
        assert_eq!((status, &t["id"], &t["host_id"]), (200, &json!("a1"), &json!("host")));
        assert_eq!(*sent.lock().unwrap(), [("/api/profiles/pp/assistant?local=1".to_string(), json!({"text": "Remind me at 5"}))]);
    });
}
