use std::time::Duration;

use axum::Router;
use serde_json::{Value, json};
use tower::ServiceExt;

use super::*;
use crate::db::{self, NewProject, Task, insert_profile, insert_project};
use crate::hosts::hub;
use crate::hosts::proto::ToolCall;
use crate::mcp::tools::{McpCall, handle_mcp, handle_up_call};

pub(crate) fn node(id: &str, name: &str) -> Shared {
    crate::testing::state_as(crate::state::Identity {
        host_id: id.into(),
        host_name: name.into(),
        token: format!("{id}-tok"),
        hub_token: format!("{id}-hub"),
        internal_url: String::new(),
    })
}

/// Serve a node's API, returning its URL.
async fn serve(s: &Shared) -> String {
    let app = crate::api::router(s.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).await });
    format!("http://{addr}")
}

async fn until<T>(what: &str, f: impl Fn() -> Option<T>) -> T {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(v) = f() {
            return v;
        }
        assert!(tokio::time::Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// A request with a JSON body to a node's API, as its own UI makes it.
pub(crate) async fn api(s: &Shared, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
    let app = crate::api::router(s.clone());
    let req = axum::http::Request::builder()
        .method(method)
        .uri(path)
        .header("authorization", format!("Bearer {}", s.token))
        .header("content-type", "application/json")
        .body(axum::body::Body::from(body.map(|b| b.to_string()).unwrap_or_default()))
        .unwrap();
    let res: axum::response::Response = Router::oneshot(app, req).await.unwrap();
    let status = res.status().as_u16();
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

fn project(s: &Shared, profile: &db::Profile, id: &str, key: &str) {
    let p = NewProject { id, profile_id: &profile.id, name: id, key, repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
    insert_project(&s.db(), p).unwrap();
}

fn task(s: &Shared, project: &str, title: &str) -> Task {
    let body = crate::api::CreateTask { title: title.into(), use_worktree: Some(false), ..Default::default() };
    crate::api::create_task_inner(s, project, body).map_err(|e| e.1).unwrap()
}

/// The hub links the host by URL (as an SSH link does, through its tunnel), and the host's ws says who the hub is.
pub(crate) async fn link_by_url(hub: &Shared, host: &Shared) {
    let url = serve(host).await;
    let link = db::upsert_link(&hub.db(), &host.host_id, &host.host_name, "outbound", Some(&url), Some(&host.token)).unwrap();
    let h = hub.clone();
    tokio::spawn(async move {
        let _ = hub::run_outbound(&h, &link, "outbound").await;
    });
    until("the link", || hub::find_link(hub, &host.host_id)).await;
    until("the up-link", || host.uplinks.lock().unwrap().get(&hub.host_id).cloned()).await;
}

/// An agent's tool call on `s`, from a run of `caller`.
async fn agent_call(s: &Shared, run: &db::Run, call_id: &str, tool: &str, args: Value) -> std::result::Result<Value, String> {
    handle_mcp(s, McpCall { run_id: run.id.clone(), call_id: call_id.into(), tool: tool.into(), args, task_fields: true }).await
}

struct Boards {
    hub: Shared,
    host: Shared,
    /// A run of the assistant on the host, whose calls these are.
    run: db::Run,
    hub_task: Task,
    work_task: Task,
}

/// A hub with a personal and a work board, and a host (the assistant's) with a personal profile.
fn boards() -> Boards {
    let (hub, host) = (node("hub", "desktop"), node("host", "homeserver"));
    let personal = insert_profile(&hub.db(), "personal", &[], None).unwrap();
    let work = insert_profile(&hub.db(), "work", &[], None).unwrap();
    project(&hub, &personal, "hub-p", "HUB");
    project(&hub, &work, "hub-w", "WRK");
    let hub_task = task(&hub, "hub-p", "On the hub");
    let work_task = task(&hub, "hub-w", "Work only");
    let mine = insert_profile(&host.db(), "personal", &[], None).unwrap();
    project(&host, &mine, "host-p", "LAP");
    task(&host, "host-p", "On the host");
    let assistant = crate::agent::assistant::get_or_create(&host, &mine.id).unwrap();
    let run = db::insert_run(&host.db(), &assistant.id, "prompt").unwrap();
    Boards { hub, host, run, hub_task, work_task }
}

async fn let_in(hub: &Shared, host: &str, on: bool) {
    assert_eq!(api(hub, "PATCH", &format!("/api/hosts/{host}"), Some(json!({"uplink": on}))).await.0, 200);
}

#[test]
fn a_hosts_agents_use_the_hubs_board_only_when_it_lets_them() {
    crate::testing::run(async || {
        let b = boards();
        let (hub, host, run) = (&b.hub, &b.host, &b.run);
        link_by_url(hub, host).await;
        let hosts = api(hub, "GET", "/api/hosts", None).await.1;
        assert_eq!(hosts[1]["uplink"], false, "{hosts}");

        // Off by default: not found, saying why it may be.
        let e = agent_call(host, run, "c1", "get_task", json!({"task_id": "HUB-1"})).await.unwrap_err();
        assert!(e.starts_with("not found") && e.contains("desktop doesn't let this host's agents use its board"), "{e}");
        assert!(e.contains("Let this host's agents use this board"), "{e}");
        let projects = agent_call(host, run, "c2", "list_projects", json!({})).await.unwrap();
        assert_eq!(projects.as_array().unwrap().iter().map(|p| p["key"].as_str().unwrap()).collect::<Vec<_>>(), ["LAP"]);

        let_in(hub, "host", true).await;
        assert_eq!(api(hub, "GET", "/api/hosts", None).await.1[1]["uplink"], true);
        let t = agent_call(host, run, "c3", "get_task", json!({"task_id": "HUB-1"})).await.unwrap();
        assert_eq!((t["key"].as_str(), t["id"].as_str()), (Some("HUB-1"), Some(b.hub_task.id.as_str())));
        // By id too, and its own tasks are still its own.
        assert_eq!(agent_call(host, run, "c4", "get_task", json!({"task_id": b.hub_task.id})).await.unwrap()["key"], "HUB-1");
        assert_eq!(agent_call(host, run, "c5", "get_task", json!({"task_id": "LAP-1"})).await.unwrap()["title"], "On the host");
        // It creates and changes tasks there.
        let made = agent_call(host, run, "c6", "create_task", json!({"project_id": "HUB", "title": "From the assistant"})).await.unwrap();
        let made_id = made["id"].as_str().unwrap().to_string();
        assert_eq!(db::get_task(&hub.db(), &made_id).unwrap().unwrap().title, "From the assistant");
        assert!(db::get_task(&host.db(), &made_id).unwrap().is_none());
        agent_call(host, run, "c7", "update_task", json!({"task_id": "HUB-1", "title": "Renamed"})).await.unwrap();
        assert_eq!(db::get_task(&hub.db(), &b.hub_task.id).unwrap().unwrap().title, "Renamed");
        // Every board it can reach, each project once.
        let projects = agent_call(host, run, "c8", "list_projects", json!({})).await.unwrap();
        let mut keys: Vec<&str> = projects.as_array().unwrap().iter().map(|p| p["key"].as_str().unwrap()).collect();
        keys.sort();
        assert_eq!(keys, ["HUB", "LAP"]);
        // With `host`, the hub's board by its name.
        let listed = agent_call(host, run, "c9", "list_tasks", json!({"project_id": "HUB", "host": "desktop"})).await.unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 2, "{listed}");

        // The work board doesn't let personal agents in: not by key, by id, or in lists.
        for (i, r) in ["WRK-1", b.work_task.id.as_str()].into_iter().enumerate() {
            let e = agent_call(host, run, &format!("w{i}"), "get_task", json!({"task_id": r})).await.unwrap_err();
            assert!(e.starts_with("not found"), "{r}: {e}");
            let e = agent_call(host, run, &format!("u{i}"), "update_task", json!({"task_id": r, "title": "Mine now"})).await.unwrap_err();
            assert!(e.starts_with("not found"), "{r}: {e}");
            let e = agent_call(host, run, &format!("s{i}"), "send_to_task", json!({"task_id": r, "message": "hi"})).await.unwrap_err();
            assert!(e.starts_with("not found"), "{r}: {e}");
        }
        assert_eq!(db::get_task(&hub.db(), &b.work_task.id).unwrap().unwrap().title, "Work only");
        let e = agent_call(host, run, "w9", "create_task", json!({"project_id": "WRK", "title": "Sneaky"})).await.unwrap_err();
        assert!(e.starts_with("not found"), "{e}");
        let all = agent_call(host, run, "w10", "list_tasks", json!({"project_id": "all"})).await.unwrap();
        assert!(!all.to_string().contains("Work only"), "{all}");
        // Until it does.
        let work = db::list_profiles(&hub.db()).unwrap().into_iter().find(|p| p.name == "work").unwrap();
        db::update_profile(&hub.db(), &work.id, &[("agent_access", json!(["personal"]))]).unwrap();
        assert_eq!(agent_call(host, run, "w11", "get_task", json!({"task_id": "work:WRK-1"})).await.unwrap()["title"], "Work only");

        // Switched off again, it's refused at once.
        let_in(hub, "host", false).await;
        let e = agent_call(host, run, "c10", "get_task", json!({"task_id": "HUB-1"})).await.unwrap_err();
        assert!(e.contains("doesn't let this host's agents use its board"), "{e}");
    })
}

#[test]
fn calls_up_a_link_run_once_and_never_go_back_down_or_up() {
    crate::testing::run(async || {
        let b = boards();
        let (hub, host) = (&b.hub, &b.host);
        link_by_url(hub, host).await;
        let_in(hub, "host", true).await;
        let call = |call_id: &str, tool: &str, args: Value| ToolCall { id: 1, call_id: call_id.into(), tool: tool.into(), profile: "personal".into(), args, task_fields: true };
        let tasks = || hub.db().query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get::<_, i64>(0)).unwrap();
        // Delivered twice, at once and again after: one task.
        let before = tasks();
        let c = call("dup", "create_task", json!({"project_id": "HUB", "title": "Once"}));
        let (a, b2) = tokio::join!(handle_up_call(hub, "host", &c), handle_up_call(hub, "host", &c));
        let again = handle_up_call(hub, "host", &c).await.unwrap();
        assert_eq!((a.unwrap()["id"].clone(), b2.unwrap()["id"].clone()), (again["id"].clone(), again["id"].clone()));
        assert_eq!(tasks(), before + 1);
        // The same call id from another host is another call.
        let other = handle_up_call(hub, "elsewhere", &c).await.unwrap();
        assert_ne!(other["id"], again["id"]);
        assert_eq!(tasks(), before + 2);

        // The host's own task isn't looked for back on the host (hub → host → hub would go round).
        let e = handle_up_call(hub, "host", &call("back", "get_task", json!({"task_id": "LAP-1"}))).await.unwrap_err();
        assert!(e.starts_with("not found"), "{e}");
        // Nor are its lists asked of it again.
        let listed = handle_up_call(hub, "host", &call("list", "list_projects", json!({}))).await.unwrap();
        assert!(!listed.to_string().contains("LAP"), "{listed}");
        // Nor does the hub pass it up a link of its own.
        assert!(hub.uplinks.lock().unwrap().is_empty());
        // Tools for the agent's own thread stay on its own host.
        for tool in ["wait", "request_user_input", "permission_prompt", "submit_review"] {
            let e = handle_up_call(hub, "host", &call(&format!("t-{tool}"), tool, json!({}))).await.unwrap_err();
            assert_eq!(e, format!("{tool} only works on the host the agent runs on"));
        }
        // A profile the hub doesn't have, which nothing there lets in.
        let mut stranger = call("x", "list_projects", json!({}));
        stranger.profile = "stranger".into();
        assert!(handle_up_call(hub, "host", &stranger).await.unwrap_err().starts_with("not found"));
    })
}

#[test]
fn a_host_that_dials_in_takes_the_hub_as_an_up_link_too() {
    crate::testing::run(async || {
        let b = boards();
        let (hub, host, run) = (&b.hub, &b.host, &b.run);
        let url = serve(hub).await;
        let _ = crate::api::router(host.clone());
        hub::dial_out(host, url, "hub-hub".into());
        until("the host to dial in", || hub::find_link(hub, "host")).await;
        until("the up-link", || host.uplinks.lock().unwrap().get("hub").cloned()).await;
        let e = agent_call(host, run, "c1", "get_task", json!({"task_id": "HUB-1"})).await.unwrap_err();
        assert!(e.contains("doesn't let this host's agents use its board"), "{e}");
        let_in(hub, "host", true).await;
        assert_eq!(agent_call(host, run, "c2", "get_task", json!({"task_id": "HUB-1"})).await.unwrap()["title"], "On the hub");
    })
}

#[test]
fn a_hub_the_host_links_itself_is_asked_the_usual_way_not_up_the_link() {
    crate::testing::run(async || {
        let b = boards();
        let (hub, host) = (&b.hub, &b.host);
        link_by_url(hub, host).await;
        assert_eq!(hubs(host).len(), 1);
        // The host links the hub as well: its board is asked over that link, with the hub's token.
        let url = serve(hub).await;
        let link = db::upsert_link(&host.db(), "hub", "desktop", "outbound", Some(&url), Some(&hub.token)).unwrap();
        let h = host.clone();
        tokio::spawn(async move {
            let _ = hub::run_outbound(&h, &link, "outbound").await;
        });
        until("the host's link to the hub", || hub::find_link(host, "hub")).await;
        assert!(hubs(host).is_empty());
    })
}

#[test]
fn an_up_link_goes_with_its_connection() {
    crate::testing::run(async || {
        let s = node("host", "homeserver");
        let (first, mut calls) = register(&s, "hub", "desktop");
        let link = first.link.clone();
        // A call waiting for its answer when the connection goes fails, rather than waiting on.
        let pending = tokio::spawn(async move { link.call("c1", "get_task", "personal", &json!({}), true).await });
        let c = calls.recv().await.unwrap();
        assert_eq!((c.call_id.as_str(), c.tool.as_str(), c.profile.as_str()), ("c1", "get_task", "personal"));
        // The hub connecting again takes its place; the old one going then leaves the new one.
        let (second, _calls) = register(&s, "hub", "desktop");
        drop(first);
        assert!(matches!(pending.await.unwrap(), Outcome::Err(_)));
        assert!(Arc::ptr_eq(&s.uplinks.lock().unwrap()["hub"], &second.link));
        drop(second);
        assert!(s.uplinks.lock().unwrap().is_empty());
    })
}
