use super::*;
use crate::db::{NewProject, insert_profile, insert_project};
use crate::testing::{self, state};

fn project(s: &Shared, profile: &db::Profile, id: &str, key: &str) {
    let p = NewProject { id, profile_id: &profile.id, name: id, key, repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
    insert_project(&s.db(), p).unwrap();
}

fn task(s: &Shared, project: &str, title: &str) -> Task {
    let body = CreateTask {
        parent_id: None,
        subproject: None,
        title: title.into(),
        description: String::new(),
        status: None,
        resolution: None,
        use_worktree: Some(false),
        model: None,
        effort: None,
        kind: None,
        start: None,
        claude_config_id: None,
        depends_on: None,
        task_type: None,
        labels: None,
        external_links: None,
        fanout_id: None,
    };
    api::create_task_inner(s, project, body).map_err(|e| e.1).unwrap()
}

fn grant(s: &Shared, p: &db::Profile, names: &[&str]) {
    db::update_profile(&s.db(), &p.id, &[("agent_access", json!(names))]).unwrap();
}

/// A run of `task_id` that holds its thread, as a started one does (see runner::start_run).
fn started_run(s: &Shared, task_id: &str) -> db::Run {
    let run = db::insert_run(&s.db(), task_id, "prompt").unwrap();
    s.runs.lock().unwrap().insert(task_id.to_string(), crate::state::RunHandle { run_id: run.id.clone(), cancel: None });
    run
}

fn ctx(p: &db::Profile) -> Ctx {
    Ctx { profile_id: Some(p.id.clone()), profile_name: p.name.clone(), task: None, call_id: None, task_fields: true }
}

async fn call(s: &Shared, ctx: &Ctx, tool: &str, args: Value) -> std::result::Result<Value, String> {
    local(s, ctx, tool, &args).await.map_err(msg)
}

fn keys(v: &Value, field: &str) -> Vec<String> {
    v.as_array().unwrap().iter().map(|p| format!("{}:{}", p["profile"].as_str().unwrap(), p[field].as_str().unwrap())).collect()
}

async fn post_tool(s: &Shared, path: &str, body: Value) -> Value {
    use tower::ServiceExt;
    let req = axum::http::Request::builder().method("POST").uri(path)
        .header("authorization", "Bearer ").header("content-type", "application/json")
        .body(axum::body::Body::from(body.to_string())).unwrap();
    let res = api::router(s.clone()).oneshot(req).await.unwrap();
    assert_eq!(res.status(), axum::http::StatusCode::OK);
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
    let result: Value = serde_json::from_slice(&bytes).unwrap();
    assert!(result.get("error").is_none(), "{result}");
    result["result"].clone()
}

#[test]
fn legacy_helper_keeps_full_details_after_server_upgrade() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "ia", "IA");
        let t = task(&s, "ia", "Existing thread");
        let description = "Description ā🙂\n".repeat(160);
        let review = db::Review { state: "issues".into(), summary: Some("Review\n".repeat(400)), ..Default::default() };
        db::update_task(&s.db(), &t.id, &[("description", json!(description)), ("review", json!(review))]).unwrap();
        let run = db::insert_run(&s.db(), &t.id, "prompt").unwrap();
        // An already-running helper keeps its API 58 schema and sends the same request
        // shape after reconnecting to the upgraded daemon. No get_task_field capability.
        let request = json!({"run_id": run.id, "call_id": "old-helper", "tool": "get_task", "args": {"task_id": "IA-1"}});
        let full = post_tool(&s, "/api/internal/mcp", request.clone()).await;
        assert!(full["description"] == description, "legacy helper lost its description");
        assert_eq!(full["review"]["summary"], review.summary.as_ref().unwrap().as_str());
        assert!(full.get("omitted_fields").is_none());
        // Its retried call remains idempotent across the upgrade too.
        assert_eq!(post_tool(&s, "/api/internal/mcp", request.clone()).await, full);

        let mut current = request;
        current["call_id"] = json!("new-helper");
        current["task_fields"] = json!(true);
        let overview = post_tool(&s, "/api/internal/mcp", current.clone()).await;
        assert!(overview.get("description").is_none());
        assert_eq!(overview["field_lengths"]["description"], description.chars().count());
        current["call_id"] = json!("new-helper-field");
        current["tool"] = json!("get_task_field");
        current["args"] = json!({"task_id": "IA-1", "field": "description", "limit": TASK_FIELD_MAX_LIMIT});
        assert_eq!(post_tool(&s, "/api/internal/mcp", current).await["content"], description);
    });
}

#[test]
fn legacy_host_keeps_full_details_from_upgraded_host() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "ia", "IA");
        let t = task(&s, "ia", "Remote task");
        let description = "Remote description\n".repeat(160);
        db::update_task(&s.db(), &t.id, &[("description", json!(description))]).unwrap();
        // API 58 call_tool sends only profile and args. It cannot offer or forward
        // get_task_field, so it must receive full details from an API 59 linked host.
        let request = json!({"profile": "personal", "args": {"task_id": "IA-1"}});
        let full = post_tool(&s, "/api/tools/get_task", request.clone()).await;
        assert!(full["description"] == description, "API 58 caller lost its description");
        assert!(full.get("omitted_fields").is_none());

        let mut current = request;
        current["task_fields"] = json!(true);
        let overview = post_tool(&s, "/api/tools/get_task", current.clone()).await;
        assert!(overview.get("description").is_none());
        assert_eq!(overview["field_lengths"]["description"], description.chars().count());
        current["task_fields"] = json!(false);
        assert_eq!(post_tool(&s, "/api/tools/get_task", current).await, full);
    });
}

#[test]
fn large_task_fields_are_summarized_and_can_be_reassembled() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "ia", "IA");
        let t = task(&s, "ia", "A large task");
        let me = ctx(&p);
        let description = "A lengthy description\n".repeat(5000);
        let message = "Latest reply: ā🙂\n\"quoted\"\\\t".repeat(4000);
        let review = db::Review { state: "issues".into(), summary: Some("Review\n".repeat(2000)), issues: vec!["Fix it".repeat(1000)], ..Default::default() };
        db::update_task(&s.db(), &t.id, &[("description", json!(description)), ("review", json!(review))]).unwrap();
        db::insert_message(&s.db(), &t.id, "claude", &json!({"type": "result", "result": message})).unwrap();
        // Arrays can grow too; no unbounded review is smuggled in through created_tasks.
        let child = task(&s, "ia", "Child");
        db::update_task(&s.db(), &child.id, &[("created_by", json!(t.id)), ("review", json!(review))]).unwrap();
        let overview = call(&s, &me, "get_task", json!({"task_id": "IA-1"})).await.unwrap();
        let serialized = serde_json::to_string_pretty(&overview).unwrap();
        assert!(serialized.len() < 10000, "overview was {} bytes", serialized.len());
        assert_eq!((overview["key"].as_str(), overview["title"].as_str()), (Some("IA-1"), Some("A large task")));
        for field in ["description", "last_message", "review", "created_tasks"] {
            assert!(overview.get(field).is_none(), "{field} was inlined");
            assert!(overview["omitted_fields"].as_array().unwrap().contains(&json!(field)));
        }
        assert_eq!(overview["field_lengths"]["description"], description.chars().count());
        assert_eq!(overview["field_lengths"]["last_message"], message.chars().count());
        for (field, expected) in [("description", description), ("last_message", message)] {
            let mut offset = 0;
            let mut assembled = String::new();
            loop {
                let page = call(&s, &me, "get_task_field", json!({"task_id": t.id, "field": field, "offset": offset})).await.unwrap();
                let content = page["content"].as_str().unwrap();
                assert_eq!(page["format"], "text");
                assert_eq!(page["total_length"], overview["field_lengths"][field]);
                assert!(content.chars().count() <= TASK_FIELD_DEFAULT_LIMIT);
                assembled.push_str(content);
                match page["next_offset"].as_u64() {
                    Some(next) => { assert!(next > offset); offset = next; }
                    None => break,
                }
            }
            assert_eq!(assembled, expected);
        }
        let page = call(&s, &me, "get_task_field", json!({"task_id": "IA-1", "field": "review"})).await.unwrap();
        assert_eq!(page["format"], "json");
        assert_eq!(page["total_length"], overview["field_lengths"]["review"]);
        assert!(page["next_offset"].is_number());
    });
}

#[test]
fn task_field_pages_count_characters_and_validate_ranges() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "ia", "IA");
        let t = task(&s, "ia", "Small task");
        let me = ctx(&p);
        db::update_task(&s.db(), &t.id, &[("description", json!("aā🙂\n\"\\\u{0000}z"))]).unwrap();
        let args = json!({"task_id": "IA-1", "field": "description"});
        let page = async |extra: Value| {
            let mut args = args.clone();
            args.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            call(&s, &me, "get_task_field", args).await
        };
        let v = page(json!({"offset": 1, "limit": 3})).await.unwrap();
        assert_eq!((v["content"].as_str(), &v["length"], &v["total_length"], &v["next_offset"]), (Some("ā🙂\n"), &json!(3), &json!(8), &json!(4)));
        let v = page(json!({"offset": 7, "limit": TASK_FIELD_MAX_LIMIT})).await.unwrap();
        assert_eq!(v["content"], "z");
        assert!(v["next_offset"].is_null());
        for offset in [8, 9, u64::MAX] {
            let v = page(json!({"offset": offset})).await.unwrap();
            assert_eq!(v["content"], "");
            assert_eq!(v["length"], 0);
            assert!(v["next_offset"].is_null());
        }
        for extra in [
            json!({"offset": -1}), json!({"offset": 1.5}), json!({"offset": "1"}), json!({"offset": null}),
            json!({"limit": -1}), json!({"limit": 0}), json!({"limit": TASK_FIELD_MAX_LIMIT + 1}),
            json!({"limit": 1.5}), json!({"limit": "1"}), json!({"limit": null}), json!({"field": "session_id"}),
        ] {
            assert!(page(extra.clone()).await.is_err(), "accepted {extra}");
        }
        // Null, scalar and empty fields have exact lengths matching their paginated representation.
        let overview = call(&s, &me, "get_task", json!({"task_id": "IA-1"})).await.unwrap();
        assert_eq!(overview["description"], "aā🙂\n\"\\\u{0000}z");
        for (field, content, format) in [("last_message", "null", "json"), ("running", "false", "json"), ("title", "Small task", "text")] {
            let v = page(json!({"field": field})).await.unwrap();
            assert_eq!(v["content"], content);
            assert_eq!(v["format"], format);
            assert_eq!(overview["field_lengths"][field], content.chars().count());
        }
        db::update_task(&s.db(), &t.id, &[("description", json!(""))]).unwrap();
        let v = page(json!({})).await.unwrap();
        assert_eq!(v["total_length"], 0);
        assert_eq!(v["content"], "");
        assert!(v["next_offset"].is_null());
    });
}

#[test]
fn overview_bounds_escaped_values_and_the_total_inline_size() {
    let details: Map<String, Value> = (0..30).map(|i| (format!("field_{i}"), json!("x".repeat(900)))).collect();
    let v = task_overview(json!(details));
    assert!(serde_json::to_string_pretty(&v).unwrap().len() < 10000);
    assert_eq!(v["field_lengths"].as_object().unwrap().len(), 30);
    assert!(v["omitted_fields"].as_array().unwrap().len() >= 24);
    // Control characters expand sixfold in JSON; characters alone aren't an output bound.
    let v = task_overview(json!({"description": "\u{0000}".repeat(900)}));
    assert!(v.get("description").is_none());
    assert_eq!(v["field_lengths"]["description"], 900);
}

#[test]
fn task_fields_use_the_same_profile_access_and_key_resolution() {
    testing::run(async || {
        let s = state();
        let [personal, work, lab] = ["personal", "work", "lab"].map(|n| insert_profile(&s.db(), n, &[], None).unwrap());
        for (p, id, key) in [(&personal, "own", "IA"), (&work, "work", "IA"), (&lab, "lab", "LAB")] {
            project(&s, p, id, key);
            let t = task(&s, id, id);
            db::update_task(&s.db(), &t.id, &[("description", json!(id))]).unwrap();
        }
        let me = ctx(&personal);
        let get = async |extra: Value| {
            let mut args = json!({"task_id": "IA-1", "field": "description"});
            args.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            call(&s, &me, "get_task_field", args).await
        };
        let work_id = db::list_tasks_for_project(&s.db(), "work", "task").unwrap()[0].id.clone();
        assert!(get(json!({"task_id": work_id})).await.is_err());
        assert!(get(json!({"profile": "work"})).await.is_err());
        assert!(get(json!({"task_id": "work:IA-1"})).await.is_err());
        grant(&s, &work, &["personal"]);
        assert_eq!(get(json!({})).await.unwrap()["content"], "own");
        assert_eq!(get(json!({"profile": "work"})).await.unwrap()["content"], "work");
        assert_eq!(get(json!({"task_id": "work:ia-1"})).await.unwrap()["content"], "work");
        assert_eq!(get(json!({"task_id": work_id})).await.unwrap()["content"], "work");
        // The remote entry point enforces access too, and resolves the same qualified keys.
        assert_eq!(handle_remote(&s, "get_task_field", "personal", json!({"task_id": "work:IA-1", "field": "description"}), true).await.unwrap()["content"], "work");
        grant(&s, &work, &[]);
        assert!(handle_remote(&s, "get_task_field", "personal", json!({"task_id": work_id, "field": "description"}), true).await.is_err());
        assert!(get(json!({"task_id": "LAB-1"})).await.is_err());
    });
}

#[test]
fn reads_task_fields_on_new_and_legacy_linked_hosts() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        let me = ctx(&p);
        let calls: std::sync::Arc<std::sync::Mutex<Vec<(String, String, Value)>>> = Default::default();
        for (name, api) in [("old", TASK_FIELDS_API - 1), ("new", TASK_FIELDS_API)] {
            let calls = calls.clone();
            let app = axum::Router::new().route("/api/tools/{tool}", axum::routing::post(
                move |axum::extract::Path(tool): axum::extract::Path<String>, axum::Json(body): axum::Json<Value>| {
                    let calls = calls.clone();
                    async move {
                        calls.lock().unwrap().push((name.to_string(), tool.clone(), body.clone()));
                        let details = json!({"id": "remote", "description": "ā🙂x".repeat(10000), "title": "Remote task"});
                        let result = match (api, tool.as_str()) {
                            (TASK_FIELDS_API, "get_task") if body["task_fields"] == true => task_overview(details),
                            (TASK_FIELDS_API, "get_task_field") => task_field(&details, &body["args"]).map_err(msg).unwrap(),
                            (_, "get_task") => details,
                            _ => panic!("sent {tool} to a legacy host"),
                        };
                        axum::Json(json!({"result": result}))
                    }
                }
            ));
            hub::link_http(&s, name, app, api).await;
        }
        // An explicit host and fallback lookup both pass through compatibility handling.
        for host in [Some("old"), Some("new"), None] {
            let mut args = json!({"task_id": "work:REMOTE-1", "profile": "work"});
            if let Some(host) = host { args["host"] = json!(host); }
            let overview = dispatch(&s, &me, "get_task", args.clone()).await.unwrap();
            assert_eq!(overview["field_lengths"]["description"], 30000);
            assert!(overview.get("description").is_none());
            args["field"] = json!("description");
            args["offset"] = json!(1);
            args["limit"] = json!(2);
            let page = dispatch(&s, &me, "get_task_field", args).await.unwrap();
            assert_eq!(page["content"], "🙂x");
            assert_eq!(page["next_offset"], 3);
        }
        // An old helper on an upgraded calling host still needs full details from both
        // old and upgraded destinations; the forwarding host's version is not a capability.
        let legacy = Ctx { task_fields: false, ..ctx(&p) };
        for host in [Some("old"), Some("new"), None] {
            let mut args = json!({"task_id": "work:REMOTE-1", "profile": "work"});
            if let Some(host) = host { args["host"] = json!(host); }
            let full = dispatch(&s, &legacy, "get_task", args).await.unwrap();
            assert!(full["description"] == "ā🙂x".repeat(10000), "forwarding hid legacy details");
            assert!(full.get("omitted_fields").is_none());
        }
        let sent = calls.lock().unwrap();
        assert!(sent.iter().any(|(host, tool, _)| host == "new" && tool == "get_task_field"));
        for (host, tool, body) in sent.iter() {
            assert_eq!(body["profile"], "personal");
            assert_eq!(body["args"]["task_id"], "work:REMOTE-1");
            assert_eq!(body["args"]["profile"], "work");
            if host == "old" {
                assert_eq!(tool, "get_task");
                assert!(body["args"].get("offset").is_none());
                assert_eq!(body["task_fields"], false);
            }
        }
    });
}

#[test]
fn leaves_archived_projects_out_of_lists() {
    testing::run(async || {
        let s = state();
        let me = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &me, "ia", "IA");
        project(&s, &me, "old", "OLD");
        task(&s, "ia", "live");
        task(&s, "old", "shelved");
        db::update_project(&s.db(), "old", &[("archived_at", json!("2026-01-01T00:00:00Z"))]).unwrap();
        let me = ctx(&me);
        assert_eq!(keys(&call(&s, &me, "list_projects", json!({})).await.unwrap(), "key"), ["personal:IA"]);
        assert_eq!(keys(&call(&s, &me, "list_tasks", json!({"project_id": "all"})).await.unwrap(), "key"), ["personal:IA-1"]);
        // Still found when named, and says it's archived.
        assert_eq!(call(&s, &me, "get_project", json!({"project_id": "OLD"})).await.unwrap()["archived"], true);
        assert_eq!(call(&s, &me, "get_project", json!({"project_id": "IA"})).await.unwrap()["archived"], false);
        let err = call(&s, &me, "create_task", json!({"project_id": "OLD", "title": "more"})).await.unwrap_err();
        assert!(err.contains("is archived"), "{err}");
    });
}

#[test]
fn lists_other_profiles_boards_that_let_it_in() {
    testing::run(async || {
        let s = state();
        let [personal, work] = ["personal", "work"].map(|n| insert_profile(&s.db(), n, &[], None).unwrap());
        project(&s, &personal, "ia", "IA");
        project(&s, &work, "sd", "SD");
        task(&s, "sd", "deploy");
        let me = ctx(&personal);
        // Opt-in: other boards are closed until they let the profile in.
        assert_eq!(keys(&call(&s, &me, "list_projects", json!({})).await.unwrap(), "key"), ["personal:IA"]);
        let err = call(&s, &me, "get_task", json!({"task_id": "SD-1"})).await.unwrap_err();
        assert!(err.contains("task SD-1"), "{err}");
        let err = call(&s, &me, "list_tasks", json!({"profile": "work", "project_id": "all"})).await.unwrap_err();
        assert!(err.contains("Settings → Profiles"), "{err}");

        grant(&s, &work, &["personal"]);
        assert_eq!(keys(&call(&s, &me, "list_projects", json!({})).await.unwrap(), "key"), ["personal:IA", "work:SD"]);
        assert_eq!(keys(&call(&s, &me, "list_projects", json!({"profile": "work"})).await.unwrap(), "key"), ["work:SD"]);
        // 'all' is the caller's own board unless it names another (or every one).
        assert!(call(&s, &me, "list_tasks", json!({"project_id": "all"})).await.unwrap().as_array().unwrap().is_empty());
        assert_eq!(keys(&call(&s, &me, "list_tasks", json!({"project_id": "all", "profile": "all"})).await.unwrap(), "key"), ["work:SD-1"]);
        assert_eq!(keys(&call(&s, &me, "list_tasks", json!({"project_id": "SD"})).await.unwrap(), "key"), ["work:SD-1"]);
        assert_eq!(call(&s, &me, "get_task", json!({"task_id": "SD-1"})).await.unwrap()["title"], "deploy");
        // Access is one way.
        assert_eq!(keys(&call(&s, &ctx(&work), "list_projects", json!({})).await.unwrap(), "key"), ["work:SD"]);
        // `*` lets every profile in.
        let lab = insert_profile(&s.db(), "lab", &[], None).unwrap();
        grant(&s, &personal, &["*"]);
        assert_eq!(keys(&call(&s, &ctx(&lab), "list_projects", json!({})).await.unwrap(), "key"), ["personal:IA"]);
    });
}

#[test]
fn keys_used_on_several_boards_need_a_profile() {
    testing::run(async || {
        let s = state();
        let [personal, work, lab] = ["personal", "work", "lab"].map(|n| insert_profile(&s.db(), n, &[], None).unwrap());
        grant(&s, &work, &["personal"]);
        grant(&s, &lab, &["personal"]);
        project(&s, &personal, "ia-personal", "IA");
        project(&s, &work, "ia-work", "IA");
        project(&s, &work, "sd-work", "SD");
        project(&s, &lab, "sd-lab", "SD");
        for p in ["ia-personal", "ia-work", "sd-work", "sd-lab"] {
            task(&s, p, p);
        }
        let me = ctx(&personal);
        let title = async |args: Value| call(&s, &me, "get_task", args).await.map(|t| t["title"].as_str().unwrap().to_string());
        // The caller's own board wins.
        assert_eq!(title(json!({"task_id": "IA-1"})).await.unwrap(), "ia-personal");
        assert_eq!(title(json!({"task_id": "work:IA-1"})).await.unwrap(), "ia-work");
        // On two other boards, the key must say which.
        let err = title(json!({"task_id": "SD-1"})).await.unwrap_err();
        assert!(err.contains("work:SD-1") && err.contains("lab:SD-1"), "{err}");
        assert_eq!(title(json!({"task_id": "lab:SD-1"})).await.unwrap(), "sd-lab");
        assert_eq!(title(json!({"task_id": "SD-1", "profile": "work"})).await.unwrap(), "sd-work");
        // Ids need no profile.
        let id = db::list_tasks_for_project(&s.db(), "sd-lab", "task").unwrap()[0].id.clone();
        assert_eq!(title(json!({"task_id": id})).await.unwrap(), "sd-lab");
        // Projects too, by key or name.
        let err = call(&s, &me, "list_tasks", json!({"project_id": "SD"})).await.unwrap_err();
        assert!(err.contains("work:SD"), "{err}");
        assert_eq!(keys(&call(&s, &me, "list_tasks", json!({"project_id": "sd-work"})).await.unwrap(), "title"), ["work:sd-work"]);
    });
}

#[test]
fn creates_tasks_on_other_boards_under_their_profile() {
    testing::run(async || {
        let s = state();
        let (mine, theirs) = {
            let c = s.db();
            let mine = db::insert_claude_config(&c, "personal", "~/.claude-personal", "claude").unwrap();
            let theirs = db::insert_claude_config(&c, "work", "~/.claude-work", "claude").unwrap();
            (mine, theirs)
        };
        let personal = insert_profile(&s.db(), "personal", std::slice::from_ref(&mine.id), None).unwrap();
        let work = insert_profile(&s.db(), "work", &[theirs.id.clone(), mine.id.clone()], None).unwrap();
        project(&s, &personal, "kiwicd", "KIW");
        project(&s, &work, "site-deploy", "SD");
        let caller = task(&s, "kiwicd", "orchestrate");
        let me = Ctx { task: Some(caller), ..ctx(&personal) };
        let err = call(&s, &me, "create_task", json!({"title": "x", "project_id": "work:SD"})).await.unwrap_err();
        assert!(err.contains("doesn't let agents in profile personal"), "{err}");
        grant(&s, &work, &["personal"]);
        let t = call(&s, &me, "create_task", json!({"title": "Follow-up", "project_id": "SD"})).await.unwrap();
        assert_eq!((t["key"].as_str(), t["profile"].as_str()), (Some("SD-1"), Some("work")));
        let t = db::get_task(&s.db(), t["id"].as_str().unwrap()).unwrap().unwrap();
        assert_eq!(t.profile_id, work.id);
        assert_eq!(t.claude_config_id.as_deref(), Some(theirs.id.as_str()));
        // Without a project the caller's own is used, and a profile alone isn't enough.
        let t = call(&s, &me, "create_task", json!({"title": "Here"})).await.unwrap();
        assert_eq!(t["key"], "KIW-2");
        assert!(call(&s, &me, "create_task", json!({"title": "?", "profile": "work"})).await.is_err());
        // And it can be updated and messaged from there.
        let t = call(&s, &me, "update_task", json!({"task_id": "work:SD-1", "title": "Renamed"})).await.unwrap();
        assert_eq!(t["title"], "Renamed");
    });
}
#[tokio::test]
async fn sets_dependencies_by_key() {
    let s = state();
    let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
    project(&s, &p, "kiwicd", "KIW");
    project(&s, &p, "other", "OT");
    let me = ctx(&p);
    call(&s, &me, "create_task", json!({"title": "Base", "project_id": "KIW"})).await.unwrap();
    call(&s, &me, "create_task", json!({"title": "Elsewhere", "project_id": "OT"})).await.unwrap();
    let t = call(&s, &me, "create_task", json!({"title": "After", "project_id": "KIW", "depends_on": ["KIW-1"]})).await.unwrap();
    assert_eq!(t["depends_on"][0]["key"], "KIW-1");
    assert_eq!(t["depends_on"][0]["merged"], false);
    let err = call(&s, &me, "update_task", json!({"task_id": "KIW-1", "depends_on": ["KIW-2"]})).await.unwrap_err();
    assert!(err.contains("already depends"), "{err}");
    let err = call(&s, &me, "update_task", json!({"task_id": "KIW-2", "depends_on": ["OT-1"]})).await.unwrap_err();
    assert!(err.contains("same project"), "{err}");
    let t = call(&s, &me, "update_task", json!({"task_id": "KIW-2", "depends_on": []})).await.unwrap();
    assert!(t["depends_on"].is_null());
}

#[test]
fn sets_a_pull_request() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "kiwicd", "KIW");
        let me = ctx(&p);
        call(&s, &me, "create_task", json!({"title": "Base", "project_id": "KIW"})).await.unwrap();
        let url = "https://github.com/dire-kiwi/kiwicd/pull/7";
        let t = call(&s, &me, "update_task", json!({"task_id": "KIW-1", "pr_url": format!(" {url} ")})).await.unwrap();
        assert_eq!(t["pr_url"], url);
        let err = call(&s, &me, "update_task", json!({"task_id": "KIW-1", "pr_url": "#7"})).await.unwrap_err();
        assert!(err.contains("pr_url must be"), "{err}");
        let t = call(&s, &me, "update_task", json!({"task_id": "KIW-1", "pr_url": ""})).await.unwrap();
        assert!(t["pr_url"].is_null());
    });
}

#[test]
fn stars_and_sets_reminders() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "kiwicd", "KIW");
        let me = ctx(&p);
        // Set as it's created, the reminder a delay from now.
        // Times are kept to the millisecond, so less a millisecond.
        let before = chrono::Utc::now() - chrono::TimeDelta::milliseconds(1);
        let t = call(&s, &me, "create_task", json!({"title": "Later", "project_id": "KIW", "starred": true, "remind_at": "2h", "reminder": " Check CI "})).await.unwrap();
        assert_eq!((t["starred"].as_bool(), t["reminder"].as_str()), (Some(true), Some("Check CI")));
        let at = chrono::DateTime::parse_from_rfc3339(t["remind_at"].as_str().unwrap()).unwrap();
        assert!(at >= before + chrono::TimeDelta::hours(2) && at <= chrono::Utc::now() + chrono::TimeDelta::hours(2), "{at}");
        // An absolute time is kept in UTC, and the note stays when only the time changes.
        let t = call(&s, &me, "update_task", json!({"task_id": "KIW-1", "remind_at": "2030-01-02T09:00:00+13:00", "starred": false})).await.unwrap();
        assert_eq!((t["remind_at"].as_str(), t["reminder"].as_str()), (Some("2030-01-01T20:00:00.000Z"), Some("Check CI")));
        assert!(t["starred"].is_null());
        let err = call(&s, &me, "update_task", json!({"task_id": "KIW-1", "starred": "yes"})).await.unwrap_err();
        assert!(err.contains("starred must be"), "{err}");
        let err = call(&s, &me, "update_task", json!({"task_id": "KIW-1", "remind_at": 5})).await.unwrap_err();
        assert!(err.contains("remind_at must be"), "{err}");
        let err = call(&s, &me, "update_task", json!({"task_id": "KIW-1", "remind_at": "soon"})).await.unwrap_err();
        assert!(err.contains("remind_at must be"), "{err}");
        // Clearing the time clears the note, and a note needs a time.
        let t = call(&s, &me, "update_task", json!({"task_id": "KIW-1", "remind_at": ""})).await.unwrap();
        assert!(t["remind_at"].is_null());
        let t = db::get_task(&s.db(), t["id"].as_str().unwrap()).unwrap().unwrap();
        assert_eq!((t.remind_at, t.reminder), (None, None));
        let err = call(&s, &me, "update_task", json!({"task_id": "KIW-1", "reminder": "Why"})).await.unwrap_err();
        assert!(err.contains("needs remind_at"), "{err}");
        // A bad time doesn't leave a task behind.
        assert!(call(&s, &me, "create_task", json!({"title": "Bad", "remind_at": "whenever", "project_id": "KIW"})).await.is_err());
        assert_eq!(db::list_tasks_for_project(&s.db(), "kiwicd", "task").unwrap().len(), 1);
    });
}

#[test]
fn a_create_task_with_bad_marks_leaves_no_task() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "kiwicd", "KIW");
        let me = ctx(&p);
        let long = "x".repeat(501);
        for (args, why) in [
            (json!({"reminder": "Check CI"}), "needs remind_at"),
            (json!({"starred": "yes"}), "starred must be"),
            (json!({"remind_at": "2h", "reminder": long}), "at most 500"),
            (json!({"remind_at": 5}), "remind_at must be"),
            (json!({"remind_at": "whenever"}), "remind_at must be"),
        ] {
            let mut args = args;
            args["title"] = json!("Bad");
            args["project_id"] = json!("KIW");
            let err = call(&s, &me, "create_task", args.clone()).await.unwrap_err();
            assert!(err.contains(why), "{args}: {err}");
            assert!(db::list_tasks_for_project(&s.db(), "kiwicd", "task").unwrap().is_empty(), "{args} left a task");
        }
        let t = call(&s, &me, "create_task", json!({"title": "Good", "project_id": "KIW", "remind_at": "1d", "reminder": "Look again"})).await.unwrap();
        assert_eq!(t["reminder"], "Look again");
    });
}

#[test]
fn scratch_tasks_get_their_marks_too() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        let me = ctx(&p);
        let scratch = |extra: Value| {
            let mut args = json!({"type": "scratch", "title": "Scratch with reminder"});
            args.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            args
        };
        let t = call(&s, &me, "create_task", scratch(json!({"starred": true, "remind_at": "2h", "reminder": "Come back to this"}))).await.unwrap();
        let t = db::get_task(&s.db(), t["id"].as_str().unwrap()).unwrap().unwrap();
        assert!(t.starred && t.remind_at.is_some(), "{t:?}");
        assert_eq!(t.reminder.as_deref(), Some("Come back to this"));
        // Bad ones fail before it's made.
        let count = || db::list_tasks_for_profile(&s.db(), &p.id).unwrap().len();
        let before = count();
        for bad in [json!({"remind_at": "whenever"}), json!({"reminder": "No time"}), json!({"starred": "yes"})] {
            assert!(call(&s, &me, "create_task", scratch(bad.clone())).await.is_err(), "{bad}");
            assert_eq!(count(), before, "{bad} left a task");
        }
    });
}

#[test]
fn marks_only_go_to_hosts_that_can_set_them() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        let me = ctx(&p);
        // Linked hosts that answer every tool call, and note which they were sent.
        let calls: std::sync::Arc<std::sync::Mutex<Vec<(String, String)>>> = Default::default();
        for (name, api) in [("old", MARKS_API - 1), ("new", MARKS_API)] {
            let calls = calls.clone();
            let app = axum::Router::new().route(
                "/api/tools/{tool}",
                axum::routing::post(move |axum::extract::Path(tool): axum::extract::Path<String>| async move {
                    calls.lock().unwrap().push((name.to_string(), tool));
                    axum::Json(json!({"result": {"ok": true}}))
                }),
            );
            hub::link_http(&s, name, app, api).await;
        }
        let sent = || std::mem::take(&mut *calls.lock().unwrap());
        // Named, an older host is refused, clearing a mark too; anything else still goes.
        for marks in [json!({"remind_at": "2h"}), json!({"starred": false}), json!({"reminder": ""})] {
            let mut args = marks.clone();
            args["task_id"] = json!("OLD-1");
            args["host"] = json!("old");
            let err = dispatch(&s, &me, "update_task", args).await.unwrap_err();
            assert!(err.contains("old runs an older build"), "{marks}: {err}");
        }
        let err = dispatch(&s, &me, "create_task", json!({"title": "T", "host": "old", "starred": true})).await.unwrap_err();
        assert!(err.contains("older build"), "{err}");
        assert_eq!(sent(), vec![]);
        dispatch(&s, &me, "update_task", json!({"task_id": "OLD-1", "host": "old", "title": "T"})).await.unwrap();
        dispatch(&s, &me, "update_task", json!({"task_id": "NEW-1", "host": "new", "remind_at": "2h"})).await.unwrap();
        assert_eq!(sent(), vec![("old".into(), "update_task".into()), ("new".into(), "update_task".into())]);
        // Not found here, it's only tried on the hosts that can do it.
        dispatch(&s, &me, "update_task", json!({"task_id": "ELSE-1", "starred": true})).await.unwrap();
        assert_eq!(sent(), vec![("new".into(), "update_task".into())]);
    });
}

#[test]
fn reads_reminder_times() {
    let now = chrono::DateTime::parse_from_rfc3339("2026-10-26T10:00:00Z").unwrap().with_timezone(&chrono::Utc);
    let at = |v: &str| reminder_time(v, now);
    assert_eq!(at("30m").as_deref(), Some("2026-10-26T10:30:00.000Z"));
    assert_eq!(at("in 2 hours").as_deref(), Some("2026-10-26T12:00:00.000Z"));
    assert_eq!(at("1d 12h").as_deref(), Some("2026-10-27T22:00:00.000Z"));
    assert_eq!(at("1w").as_deref(), Some("2026-11-02T10:00:00.000Z"));
    assert_eq!(at("2026-12-01T09:00:00Z").as_deref(), Some("2026-12-01T09:00:00Z"));
    assert_eq!(at(" ").as_deref(), Some(""));
    // In the host's time zone, whatever that is.
    for v in ["2026-12-01 09:00", "2026-12-01T09:00", "2026-12-01"] {
        assert!(chrono::DateTime::parse_from_rfc3339(&at(v).unwrap()).is_ok(), "{v}");
    }
    for v in ["soon", "2", "h", "3 fortnights", "99999d", "tomorrow"] {
        assert_eq!(at(v), None, "{v}");
    }
}

#[test]
fn a_repository_path_it_cant_have_is_refused_before_asking() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "os", "OS");
        let me = ctx(&p);
        // Without a thread to ask in, a change it could make would say it needs approval.
        for (args, err) in [
            (json!({"project_id": "OS", "repo_path": "/nowhere"}), "/nowhere isn't a folder"),
            (json!({"project_id": "OS", "repo_path": "/nowhere", "move_repo": true}), "/x doesn't exist, so there's nothing to move"),
            (json!({"project_id": "OS", "move_repo": true}), "move_repo needs a new repo_path"),
            (json!({"project_id": "OS", "repo_path": "/x", "move_repo": true}), "move_repo needs a new repo_path"),
        ] {
            let e = call(&s, &me, "update_project", args).await.unwrap_err();
            assert!(e.contains(err), "{e}");
        }
        assert_eq!(db::get_project(&s.db(), "os").unwrap().unwrap().repo_path, "/x");
    })
}

#[test]
fn a_renamed_projects_old_key_still_names_its_tasks() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "os", "OS");
        project(&s, &p, "web", "WEB");
        task(&s, "os", "Sandbox");
        let me = ctx(&p);
        let v = call(&s, &me, "update_project", json!({"project_id": "OS", "name": " omarchy-sandbox ", "key": "oms"})).await.unwrap();
        assert_eq!((v["name"].as_str(), v["key"].as_str(), v["former_keys"].clone()), (Some("omarchy-sandbox"), Some("OMS"), json!(["OS"])));
        assert_eq!(call(&s, &me, "get_task", json!({"task_id": "OMS-1"})).await.unwrap()["key"], "OMS-1");
        assert_eq!(call(&s, &me, "get_task", json!({"task_id": "os-1"})).await.unwrap()["key"], "OMS-1");
        assert_eq!(call(&s, &me, "get_project", json!({"project_id": "OS"})).await.unwrap()["key"], "OMS");
        // Keys are checked, and are the project's alone.
        for (args, err) in [
            (json!({"project_id": "OMS", "key": "WEB"}), "already has the key WEB"),
            (json!({"project_id": "OMS", "key": "O-S"}), "letters or digits"),
            (json!({"project_id": "OMS", "name": "  "}), "name can't be blank"),
        ] {
            let e = call(&s, &me, "update_project", args).await.unwrap_err();
            assert!(e.contains(err), "{e}");
        }
        // Changing back drops it from the old keys.
        let v = call(&s, &me, "update_project", json!({"project_id": "OMS", "key": "OSX"})).await.unwrap();
        assert_eq!(v["former_keys"], json!(["OS", "OMS"]));
        let v = call(&s, &me, "update_project", json!({"project_id": "OSX", "key": "OS"})).await.unwrap();
        assert_eq!(v["former_keys"], json!(["OMS", "OSX"]));
        // Its old keys stay its own, so they keep naming its tasks.
        let e = call(&s, &me, "update_project", json!({"project_id": "WEB", "key": "OMS"})).await.unwrap_err();
        assert!(e.contains("old task keys still use it"), "{e}");
        let e = api::create_project_inner(&s, &p.id, api::CreateProject { name: "x".into(), repo_path: "/".into(), key: Some("OSX".into()), base_branch: None, use_worktrees: None })
            .await
            .unwrap_err();
        assert!(e.1.contains("old task keys still use it"), "{}", e.1);
        assert_eq!(call(&s, &me, "get_task", json!({"task_id": "OMS-1"})).await.unwrap()["title"], "Sandbox");
        assert_eq!(call(&s, &me, "get_task", json!({"task_id": "OSX-1"})).await.unwrap()["title"], "Sandbox");
        // A derived key steers clear of them too.
        let site = api::create_project_inner(&s, &p.id, api::CreateProject { name: "Oms".into(), repo_path: "/".into(), key: None, base_branch: None, use_worktrees: None }).await.unwrap();
        assert_eq!(site.key, "OMS2");
        // Projects that shared a key before it was checked: their tasks are named by id instead.
        db::update_project(&s.db(), "web", &[("former_keys", json!(json!(["OS"]).to_string()))]).unwrap();
        task(&s, "web", "Site");
        let e = call(&s, &me, "get_task", json!({"task_id": "OS-1"})).await.unwrap_err();
        assert!(e.contains("more than one task"), "{e}");
    });
}

#[test]
fn agents_read_and_change_a_projects_prompts() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "kiwicd", "KIW");
        let me = Ctx { task: Some(task(&s, "kiwicd", "Caller")), ..ctx(&p) };
        // The caller's own project by default, with every prompt the default.
        let v = call(&s, &me, "get_project", json!({})).await.unwrap();
        assert_eq!(v["key"], "KIW");
        assert_eq!(v["merge_prompt"], json!({"instructions": crate::prompts::DEFAULT_MERGE, "default": true}));
        let v = call(&s, &me, "update_project", json!({"merge_prompt": "  Squash-merge it.  ", "review_rounds": 3})).await.unwrap();
        assert_eq!(v["merge_prompt"], json!({"instructions": "Squash-merge it.", "default": false}));
        assert_eq!(v["start_prompt"]["default"], true);
        assert_eq!(v["review_rounds"], 3);
        let project = db::get_project(&s.db(), "kiwicd").unwrap().unwrap();
        assert_eq!(project.merge_prompt.as_deref(), Some("Squash-merge it."));
        // An empty string goes back to the default.
        let v = call(&s, &me, "update_project", json!({"project_id": "KIW", "merge_prompt": "", "name": "Kiwi CD", "model": "opus"})).await.unwrap();
        assert_eq!((&v["merge_prompt"]["default"], &v["name"], &v["model"]), (&json!(true), &json!("Kiwi CD"), &json!("opus")));
        assert_eq!(call(&s, &me, "update_project", json!({"model": ""})).await.unwrap()["model"], Value::Null);
        assert!(db::get_project(&s.db(), "kiwicd").unwrap().unwrap().merge_prompt.is_none());
        // Changes that need the user's approval can't be asked for without a call to ask in
        // (from another host), and none of the call's changes are made.
        let err = call(&s, &me, "update_project", json!({"permission_mode": "bypassPermissions", "name": "Other"})).await.unwrap_err();
        assert!(err.contains("needs the user's approval"), "{err}");
        let project = db::get_project(&s.db(), "kiwicd").unwrap().unwrap();
        assert_eq!((project.name.as_str(), project.permission_mode), ("Kiwi CD", None));
        // Setting one to what it already is doesn't need it.
        call(&s, &me, "update_project", json!({"setup_script": "", "use_worktrees": false})).await.unwrap();
        // The agent configs are the user's to change.
        let err = call(&s, &me, "update_project", json!({"claude_config_ids": []})).await.unwrap_err();
        assert!(err.contains("only be changed by the user"), "{err}");
        assert!(call(&s, &me, "update_project", json!({"name": " "})).await.is_err());
        // Reviewers: blanks dropped, configs checked, an empty list back to the task's own.
        let codex = db::insert_claude_config(&s.db(), "Codex", "", "codex").unwrap();
        let two = json!([{"claude_config_id": codex.id, "model": "gpt-5"}, {"model": " opus ", "effort": ""}]);
        let v = call(&s, &me, "update_project", json!({"reviewers": two})).await.unwrap();
        assert_eq!(v["reviewers"], json!([{"claude_config_id": codex.id, "model": "gpt-5", "effort": null}, {"claude_config_id": null, "model": "opus", "effort": null}]));
        assert_eq!(db::get_project(&s.db(), "kiwicd").unwrap().unwrap().reviewers.len(), 2);
        assert!(call(&s, &me, "update_project", json!({"reviewers": [{"claude_config_id": "nope"}]})).await.is_err());
        call(&s, &me, "update_project", json!({"reviewers": []})).await.unwrap();
        // A summarizer of its own, over the profile's, and back to the profile's with null.
        let v = call(&s, &me, "update_project", json!({"summarizer": {"model": "sonnet"}})).await.unwrap();
        assert_eq!(v["summarizer"]["model"], "sonnet");
        let v = call(&s, &me, "update_project", json!({"summarizer": null})).await.unwrap();
        assert_eq!(v["summarizer"], Value::Null);
        assert_eq!(db::get_project(&s.db(), "kiwicd").unwrap().unwrap().summarizer, None);
        call(&s, &me, "update_project", json!({"reviewers": [{"model": "opus"}]})).await.unwrap();
        call(&s, &me, "update_project", json!({"reviewers": null})).await.unwrap();
        assert!(db::get_project(&s.db(), "kiwicd").unwrap().unwrap().reviewers.is_empty());
        assert_eq!(call(&s, &me, "update_project", json!({"group_name": "Kiwi"})).await.unwrap()["group_name"], "Kiwi");
        assert_eq!(call(&s, &me, "update_project", json!({"group_name": ""})).await.unwrap()["group_name"], Value::Null);
    });
}

/// The next project change or deletion waiting for approval, once there is one.
async fn approval_asked(s: &Shared) -> Value {
    loop {
        if let Some(a) = permissions::pending_approvals(s, true, true).unwrap().into_iter().next() {
            return a;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
}

/// Answers the next project change or deletion waiting for approval, once there is one, and returns it.
async fn answer_approval(s: &Shared, allow: bool) -> Value {
    let a = approval_asked(s).await;
    // "Always" doesn't apply to project changes or deletions.
    permissions::decide(s, a["request_id"].as_str().unwrap(), allow, true, None).unwrap();
    a
}

#[test]
fn only_new_hosts_get_calls_older_ones_would_half_do() {
    // There's no tool to delete a project.
    assert!(!needs_project_settings_api("delete_project", &json!({"project_id": "KIW"})));
    assert!(needs_project_settings_api("update_project", &json!({"name": "Kiwi", "auto_review": true})));
    assert!(needs_project_settings_api("update_project", &json!({"setup_script": ""})));
    assert!(!needs_project_settings_api("update_project", &json!({"auto_review": true, "merge_prompt": "", "group_name": "Kiwi"})));
    assert!(!needs_project_settings_api("get_project", &json!({"name": "Kiwi"})));
    // A host on API 42 or 43 (task types, JSON 404s, but not these settings) would make the
    // old ones and drop the rest, so it isn't sent a mix; one on 44 is.
    let mixed = json!({"project_id": "KIW", "setup_script": "npm ci", "auto_review": false});
    for old in [42, 43] {
        assert!(too_old("laptop", old, "update_project", &mixed).is_some_and(|e| e.contains("laptop runs an older build")));
    }
    assert!(too_old("laptop", 44, "update_project", &mixed).is_none());
    assert!(too_old("laptop", 43, "update_project", &json!({"auto_review": false})).is_none());
    // One from before delete_task would only say it doesn't know it.
    assert!(too_old("laptop", 57, "delete_task", &json!({"task_id": "KIW-2"})).is_some_and(|e| e.contains("can't delete tasks")));
    assert!(too_old("laptop", 58, "delete_task", &json!({"task_id": "KIW-2"})).is_none());
}

#[test]
fn agents_delete_tasks_only_once_the_user_confirms() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "kiwicd", "KIW");
        // Even a thread that may do anything without asking asks first.
        let caller = task(&s, "kiwicd", "Caller");
        s.update_task(&caller.id, &[("permission_mode", json!("bypassPermissions"))]).unwrap();
        let caller = db::get_task(&s.db(), &caller.id).unwrap().unwrap();
        let me = |call_id: &str| Ctx { task: Some(caller.clone()), call_id: Some(call_id.into()), ..ctx(&p) };
        let (doomed, kept) = (task(&s, "kiwicd", "Doomed"), task(&s, "kiwicd", "Kept"));
        let exists = |t: &Task| db::get_task(&s.db(), &t.id).unwrap().is_some();

        let err = call(&s, &me("c0"), "delete_task", json!({"task_id": "KIW-1"})).await.unwrap_err();
        assert!(err.contains("can't delete your own task"), "{err}");
        assert!(permissions::pending_approvals(&s, true, true).unwrap().is_empty());

        // Denied: nothing is deleted.
        let args = json!({"task_id": "KIW-3", "reason": "A duplicate of KIW-2"});
        let (c1, c2, c3) = (me("c1"), me("c2"), me("c3"));
        let (res, asked) = tokio::join!(call(&s, &c1, "delete_task", args), answer_approval(&s, false));
        let err = res.unwrap_err();
        assert!(err.contains("didn't approve deleting KIW-3, so nothing was deleted"), "{err}");
        assert!(exists(&kept));
        let input = &asked["input"];
        assert_eq!((&asked["kind"], &asked["tool_name"]), (&json!("delete_task"), &json!("delete_task")));
        assert_eq!((&input["delete"]["key"], &input["delete"]["title"], &input["task"]["key"]), (&json!("KIW-3"), &json!("Kept"), &json!("KIW-1")));
        assert_eq!((&input["project"]["key"], &input["reason"], &input["delete_branch"]), (&json!("KIW"), &json!("A duplicate of KIW-2"), &json!(false)));
        // It flagged the asking task, and only the UIs that know deletions are shown it.
        let flagged = db::get_task(&s.db(), &caller.id).unwrap().unwrap();
        assert_eq!(flagged.attention_reason.as_deref(), Some("Delete a task?"));

        // Confirmed: it's deleted.
        let asked = async {
            let a = approval_asked(&s).await;
            assert!(permissions::pending_approvals(&s, false, false).unwrap().is_empty());
            assert_eq!(permissions::pending(&s, Some(&caller.id)).unwrap().len(), 1);
            answer_approval(&s, true).await;
            a
        };
        let (res, _) = tokio::join!(call(&s, &c2, "delete_task", json!({"task_id": "KIW-2"})), asked);
        let res = res.unwrap();
        assert_eq!((&res["deleted"], &res["key"]), (&json!(true), &json!("KIW-2")));
        assert!(!exists(&doomed) && exists(&kept));

        // Deleted by someone else while the user is asked: the question goes, and the call says so.
        let delete = async {
            approval_asked(&s).await;
            api::delete_task_inner(&s, &kept, false).await.unwrap();
        };
        let (res, _) = tokio::join!(call(&s, &c3, "delete_task", json!({"task_id": "KIW-3"})), delete);
        assert_eq!(res.unwrap()["deleted"], false);
        assert!(permissions::pending_approvals(&s, true, true).unwrap().is_empty());

        // An agent on another host has no thread here to ask in.
        let other = task(&s, "kiwicd", "Other");
        let err = call(&s, &ctx(&p), "delete_task", json!({"task_id": "KIW-4"})).await.unwrap_err();
        assert!(err.contains("deleting KIW-4 needs the user's approval"), "{err}");
        assert!(exists(&other));
    });
}

#[test]
fn a_retried_delete_deletes_what_it_asked_about() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "kiwicd", "KIW");
        let caller = task(&s, "kiwicd", "Caller");
        let me = Ctx { task: Some(caller.clone()), call_id: Some("c1".into()), ..ctx(&p) };
        let (doomed, kept) = (task(&s, "kiwicd", "Doomed"), task(&s, "kiwicd", "Kept"));
        // The server stops while the user is asked.
        let first = tokio::time::timeout(std::time::Duration::from_millis(100), call(&s, &me, "delete_task", json!({"task_id": "KIW-2"}))).await;
        assert!(first.is_err());
        // Redelivered, the call waits for the same question, and deletes the task it named.
        let (res, _) = tokio::join!(call(&s, &me, "delete_task", json!({"task_id": "KIW-3"})), answer_approval(&s, true));
        assert_eq!(res.unwrap()["key"], "KIW-2");
        assert!(db::get_task(&s.db(), &doomed.id).unwrap().is_none());
        assert!(db::get_task(&s.db(), &kept.id).unwrap().is_some());
    });
}

#[test]
fn tasks_added_while_the_user_is_asked_are_not_deleted_unasked() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "kiwicd", "KIW");
        let new = |title: &str, parent: Option<&Task>, subproject: bool| {
            let body = CreateTask { parent_id: parent.map(|t| t.id.clone()), subproject: Some(subproject), title: title.into(), use_worktree: Some(false), ..Default::default() };
            api::create_task_inner(&s, "kiwicd", body).map_err(|e| e.1).unwrap()
        };
        let caller = new("Caller", None, false);
        let me = |call_id: &str| Ctx { task: Some(caller.clone()), call_id: Some(call_id.into()), ..ctx(&p) };
        let exists = |t: &Task| db::get_task(&s.db(), &t.id).unwrap().is_some();
        // A subproject gets a task while the user looks at what it has.
        let sp = new("Subproject", None, true);
        let shown = new("Shown", Some(&sp), false);
        let c1 = me("c1");
        let answer = async {
            approval_asked(&s).await;
            let late = new("Late", Some(&sp), false);
            answer_approval(&s, true).await;
            late
        };
        let (res, late) = tokio::join!(call(&s, &c1, "delete_task", json!({"task_id": "KIW-2"})), answer);
        let err = res.unwrap_err();
        assert!(err.contains("KIW-4 became tasks of KIW-2 while the user was asked, so nothing was deleted"), "{err}");
        assert!(exists(&sp) && exists(&shown) && exists(&late));
        // An ordinary task is made a subproject with a task meanwhile.
        let plain = new("Plain", None, false);
        let c2 = me("c2");
        let answer = async {
            approval_asked(&s).await;
            s.update_task(&plain.id, &[("subproject", json!(true))]).unwrap();
            let child = new("Child", Some(&plain), false);
            answer_approval(&s, true).await;
            child
        };
        let (res, child) = tokio::join!(call(&s, &c2, "delete_task", json!({"task_id": "KIW-5"})), answer);
        assert!(res.unwrap_err().contains("nothing was deleted"));
        assert!(exists(&plain) && exists(&child));
        // Asked again, the user sees them all, and they all go.
        let c3 = me("c3");
        let (res, asked) = tokio::join!(call(&s, &c3, "delete_task", json!({"task_id": "KIW-2"})), answer_approval(&s, true));
        assert_eq!(res.unwrap()["tasks_deleted_with_it"], 2);
        assert_eq!(asked["input"]["tasks_with_it"].as_array().unwrap().len(), 2);
        assert!(!exists(&sp) && !exists(&shown) && !exists(&late));
    });
}

#[test]
fn no_task_joins_a_subproject_while_its_deleted() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        let dir = crate::testing::temp_dir();
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git").arg("-C").arg(&repo).args(["-c", "user.name=t", "-c", "user.email=t@t"]).args(args).output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        };
        git(&["init", "-q", "-b", "master"]);
        git(&["commit", "-q", "--allow-empty", "-m", "init"]);
        let body = CreateProject { name: "Kiwi".into(), repo_path: crate::util::path_str(&repo), key: Some("KIW".into()), base_branch: Some("master".into()), use_worktrees: None };
        let project = api::create_project_inner(&s, &p.id, body).await.unwrap();
        // The subproject's teardown holds it until the test lets it go.
        let (started, go) = (dir.join("started"), dir.join("go"));
        let script = format!("touch '{}'; while [ ! -e '{}' ]; do sleep 0.05; done", started.display(), go.display());
        s.db().execute("UPDATE projects SET teardown_script=?1 WHERE id=?2", [&script, &project.id]).unwrap();
        let new = |title: &str, parent: Option<&Task>, subproject: bool| {
            let body = CreateTask { parent_id: parent.map(|t| t.id.clone()), subproject: Some(subproject), title: title.into(), use_worktree: Some(false), ..Default::default() };
            api::create_task_inner(&s, &project.id, body).map_err(|e| e.1)
        };
        let caller = new("Caller", None, false).unwrap();
        let sp = new("Subproject", None, true).unwrap();
        crate::worktree::setup(&s, &sp.id).await.unwrap();
        let shown = new("Shown", Some(&sp), false).unwrap();
        let me = Ctx { task: Some(caller.clone()), call_id: Some("c1".into()), ..ctx(&p) };
        let during = async {
            answer_approval(&s, true).await;
            while !started.exists() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            // Mid-teardown: the subproject is still there, but takes no new tasks.
            assert!(db::get_task(&s.db(), &sp.id).unwrap().is_some());
            let late = new("Late", Some(&sp), false);
            std::fs::write(&go, "").unwrap();
            late
        };
        let (res, late) = tokio::join!(call(&s, &me, "delete_task", json!({"task_id": "KIW-2"})), during);
        assert_eq!(res.unwrap()["tasks_deleted_with_it"], 1);
        assert!(late.unwrap_err().contains("being deleted"));
        assert!(db::get_task(&s.db(), &sp.id).unwrap().is_none() && db::get_task(&s.db(), &shown.id).unwrap().is_none());
        // Once it's gone, nothing stays held.
        assert!(s.deleting.lock().unwrap().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    });
}

#[test]
fn deleting_a_subproject_lists_its_tasks_and_spares_the_callers() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "kiwicd", "KIW");
        let new = |title: &str, parent: Option<&Task>, subproject: bool| {
            let body = CreateTask { parent_id: parent.map(|t| t.id.clone()), subproject: Some(subproject), title: title.into(), use_worktree: Some(false), ..Default::default() };
            api::create_task_inner(&s, "kiwicd", body).map_err(|e| e.1).unwrap()
        };
        let sp = new("Subproject", None, true);
        let (inside, child) = (new("Inside", Some(&sp), false), new("Child", Some(&sp), false));
        let outside = new("Outside", None, false);
        let ctx_of = |t: &Task| Ctx { task: Some(t.clone()), call_id: Some(format!("{}-call", t.title)), ..ctx(&p) };
        let err = call(&s, &ctx_of(&inside), "delete_task", json!({"task_id": "KIW-1"})).await.unwrap_err();
        assert!(err.contains("can't delete the subproject you're in"), "{err}");
        let from_outside = ctx_of(&outside);
        let (res, asked) = tokio::join!(call(&s, &from_outside, "delete_task", json!({"task_id": "KIW-1", "delete_branch": true})), answer_approval(&s, true));
        assert_eq!(res.unwrap()["tasks_deleted_with_it"], 2);
        let with_it: Vec<&str> = asked["input"]["tasks_with_it"].as_array().unwrap().iter().map(|t| t["key"].as_str().unwrap()).collect();
        assert_eq!((with_it, &asked["input"]["delete"]["subproject"], &asked["input"]["delete_branch"]), (vec!["KIW-2", "KIW-3"], &json!(true), &json!(true)));
        for t in [&sp, &inside, &child] {
            assert!(db::get_task(&s.db(), &t.id).unwrap().is_none());
        }
    });
}

#[test]
fn deleting_a_thread_or_project_settles_its_approvals() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "kiwicd", "KIW");
        project(&s, &p, "other", "OTH");
        let (asker, other_asker) = (task(&s, "kiwicd", "Asker"), task(&s, "kiwicd", "Other asker"));
        let c1 = Ctx { task: Some(asker.clone()), call_id: Some("c1".into()), ..ctx(&p) };
        let c2 = Ctx { task: Some(other_asker), call_id: Some("c2".into()), ..ctx(&p) };
        // The thread that asked is deleted.
        let delete = async {
            approval_asked(&s).await;
            api::delete_one(&s, &asker, false).await.unwrap();
        };
        let (res, _) = tokio::join!(call(&s, &c1, "update_project", json!({"setup_script": "make"})), delete);
        assert!(res.unwrap_err().contains("Request expired"));
        assert!(permissions::pending_approvals(&s, true, true).unwrap().is_empty());
        // The project the change is for is deleted, from another project's thread.
        let delete = async {
            approval_asked(&s).await;
            api::delete_project_inner(&s, "other").await.unwrap();
        };
        let (res, _) = tokio::join!(call(&s, &c2, "update_project", json!({"project_id": "OTH", "setup_script": "make"})), delete);
        assert!(res.unwrap_err().contains("Request expired"));
        assert!(permissions::pending_approvals(&s, true, true).unwrap().is_empty());
    });
}

#[test]
fn a_retried_call_carries_on_with_its_approval() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "kiwicd", "KIW");
        project(&s, &p, "old", "OLD");
        let caller = task(&s, "kiwicd", "Caller");
        let me = |call_id: &str| Ctx { task: Some(caller.clone()), call_id: Some(call_id.into()), ..ctx(&p) };
        let (c1, c2) = (me("c1"), me("c2"));
        // The server stops while the user is asked about the script (the name is as it was).
        let change = json!({"name": "kiwicd", "setup_script": "npm ci"});
        let first = tokio::time::timeout(std::time::Duration::from_millis(100), call(&s, &c1, "update_project", change.clone())).await;
        assert!(first.is_err());
        // Meanwhile the user renames the project and sets the script themselves.
        api::update_project_inner(&s, "kiwicd", json!({"name": "Kiwi", "setup_script": "npm ci"}).as_object().unwrap()).await.unwrap();
        // Redelivered, the call waits for the same approval and makes only what it showed.
        let (res, asked) = tokio::join!(call(&s, &c1, "update_project", change.clone()), answer_approval(&s, true));
        assert_eq!(res.unwrap()["name"], "Kiwi");
        assert_eq!(asked["input"]["changes"].as_array().unwrap().len(), 1);
        assert_eq!(permissions::pending_approvals(&s, true, true).unwrap().len(), 0);
        // Answered already: a denial stands, without asking again.
        let first = tokio::time::timeout(std::time::Duration::from_millis(100), call(&s, &c2, "update_project", json!({"setup_script": "make"}))).await;
        assert!(first.is_err());
        answer_approval(&s, false).await;
        api::update_project_inner(&s, "kiwicd", json!({"setup_script": ""}).as_object().unwrap()).await.unwrap();
        let err = call(&s, &c2, "update_project", json!({"setup_script": "make"})).await.unwrap_err();
        assert!(err.contains("didn't approve changing setup_script"), "{err}");
        assert_eq!(db::get_project(&s.db(), "kiwicd").unwrap().unwrap().setup_script, "");
        // There's no tool to delete a project.
        let err = call(&s, &me("c3"), "delete_project", json!({"project_id": "OLD"})).await.unwrap_err();
        assert!(err.contains("unknown tool"), "{err}");
        assert!(db::get_project(&s.db(), "old").unwrap().is_some());
    });
}

#[test]
fn the_user_approves_risky_project_changes() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "kiwicd", "KIW");
        // Even a thread that may do anything without asking asks for these.
        let caller = task(&s, "kiwicd", "Caller");
        s.update_task(&caller.id, &[("permission_mode", json!("bypassPermissions"))]).unwrap();
        let caller = db::get_task(&s.db(), &caller.id).unwrap().unwrap();
        let me = |call_id: &str| Ctx { task: Some(caller.clone()), call_id: Some(call_id.into()), ..ctx(&p) };
        let (c1, c2) = (me("c1"), me("c2"));
        let change = json!({"permission_mode": "bypassPermissions", "setup_script": "npm ci", "base_branch": "main", "reason": "Faster setup"});

        // Denied: nothing changes, and the agent hears why.
        let (res, asked) = tokio::join!(call(&s, &c1, "update_project", change.clone()), answer_approval(&s, false));
        let err = res.unwrap_err();
        assert!(err.contains("didn't approve changing setup_script, permission_mode"), "{err}");
        let project = db::get_project(&s.db(), "kiwicd").unwrap().unwrap();
        assert_eq!((project.permission_mode, project.setup_script.as_str(), project.base_branch), (None, "", None));
        assert_eq!(asked["tool_name"], "update_project");
        assert_eq!(asked["task_id"], json!(caller.id));
        let input = &asked["input"];
        assert_eq!((&input["project"]["key"], &input["task"]["key"], &input["reason"]), (&json!("KIW"), &json!("KIW-1"), &json!("Faster setup")));
        let field = |f: &str| input["changes"].as_array().unwrap().iter().find(|c| c["field"] == f).cloned().unwrap();
        assert_eq!(field("permission_mode"), json!({"field": "permission_mode", "from": null, "to": "bypassPermissions", "needs_approval": true}));
        assert_eq!(field("base_branch")["needs_approval"], false);

        // A changed thread mode doesn't settle it either; approved, the whole call is made.
        let dont_ask = Task { permission_mode: Some("dontAsk".into()), ..caller.clone() };
        let approve = async {
            approval_asked(&s).await;
            permissions::apply_mode_to_pending(&s, &dont_ask).unwrap();
            answer_approval(&s, true).await
        };
        let (res, _) = tokio::join!(call(&s, &c2, "update_project", change.clone()), approve);
        let v = res.unwrap();
        assert_eq!((&v["permission_mode"], &v["setup_script"], &v["base_branch"]), (&json!("bypassPermissions"), &json!("npm ci"), &json!("main")));
        assert!(db::get_task(&s.db(), &caller.id).unwrap().unwrap().auto_allow.is_empty());

        // Only what differs is shown and made: a setting the call leaves as it was isn't
        // written back over a change made while the user decides.
        let c5 = me("c5");
        let again = json!({"permission_mode": "bypassPermissions", "setup_script": "npm install"});
        let approve = async {
            approval_asked(&s).await;
            api::update_project_inner(&s, "kiwicd", json!({"permission_mode": "default"}).as_object().unwrap()).await.unwrap();
            answer_approval(&s, true).await
        };
        let (res, asked) = tokio::join!(call(&s, &c5, "update_project", again), approve);
        let fields: Vec<&str> = asked["input"]["changes"].as_array().unwrap().iter().filter_map(|c| c["field"].as_str()).collect();
        assert_eq!(fields, ["setup_script"]);
        assert_eq!((&res.unwrap()["permission_mode"], &db::get_project(&s.db(), "kiwicd").unwrap().unwrap().setup_script), (&json!("default"), &"npm install".to_string()));

        // Settings given in another form than they're kept in, but that come to what they are
        // (a blank column script is none, no reviewers is the profile's), aren't changes, so
        // nothing is asked.
        let same = json!({"status_scripts": {"done": "  "}, "reviewers": [], "use_worktrees": false, "repo_path": "/x"});
        let v = call(&s, &me("c6"), "update_project", same).await.unwrap();
        assert_eq!((&v["status_scripts"], &v["reviewers"]), (&json!({}), &json!([])));
        assert!(permissions::pending_approvals(&s, true, true).unwrap().is_empty());
    });
}

#[test]
fn files_brought_into_worktrees_need_the_users_approval() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "kiwicd", "KIW");
        let caller = task(&s, "kiwicd", "Caller");
        let me = |call_id: &str| Ctx { task: Some(caller.clone()), call_id: Some(call_id.into()), ..ctx(&p) };
        let change = json!({"copy_files": ".env", "link_folders": "models"});
        let (c1, c2) = (me("c1"), me("c2"));
        let (res, asked) = tokio::join!(call(&s, &c1, "update_project", change.clone()), answer_approval(&s, false));
        assert!(res.unwrap_err().contains("didn't approve changing copy_files, link_folders"));
        let fields: Vec<&str> = asked["input"]["changes"].as_array().unwrap().iter().filter_map(|c| c["field"].as_str()).collect();
        assert_eq!(fields, ["copy_files", "link_folders"]);
        let project = db::get_project(&s.db(), "kiwicd").unwrap().unwrap();
        assert_eq!((project.copy_files.as_str(), project.link_folders.as_str()), ("", ""));
        let (res, _) = tokio::join!(call(&s, &c2, "update_project", change), answer_approval(&s, true));
        let v = res.unwrap();
        assert_eq!((&v["copy_files"], &v["link_folders"]), (&json!(".env"), &json!("models")));
        // Checked like the API checks them, before asking.
        let err = call(&s, &me("c3"), "update_project", json!({"link_folders": "../elsewhere"})).await.unwrap_err();
        assert!(err.contains("link_folders: ../elsewhere"), "{err}");
    });
}

#[test]
fn agents_add_projects_only_once_the_user_approves_the_folder() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "kiwicd", "KIW");
        // Even a thread that may do anything without asking asks first.
        let caller = task(&s, "kiwicd", "Caller");
        s.update_task(&caller.id, &[("permission_mode", json!("bypassPermissions"))]).unwrap();
        let caller = db::get_task(&s.db(), &caller.id).unwrap().unwrap();
        let me = |call_id: &str| Ctx { task: Some(caller.clone()), call_id: Some(call_id.into()), ..ctx(&p) };
        let root = crate::testing::temp_dir();
        std::fs::create_dir_all(root.join("home")).unwrap();
        let root = root.canonicalize().unwrap();
        let home = root.join("home");
        let projects = || db::list_projects(&s.db(), &p.id).unwrap().len();

        // Denied: no project, and no folder made.
        let new = root.join("new").join("site");
        let args = json!({"repo_path": new, "name": "Site", "reason": "The user asked for one"});
        let (c1, c2, c3) = (me("c1"), me("c2"), me("c3"));
        let (res, asked) = tokio::join!(call(&s, &c1, "create_project", args.clone()), answer_approval(&s, false));
        let err = res.unwrap_err();
        assert!(err.contains(&format!("didn't approve adding {} as a project, so nothing was added", new.display())), "{err}");
        assert_eq!((projects(), root.join("new").exists()), (1, false));
        assert_eq!((&asked["kind"], &asked["tool_name"]), (&json!("project"), &json!("create_project")));
        let input = &asked["input"];
        assert_eq!((&input["op"], &input["repo_path"], &input["exists"], &input["git"]), (&json!("create"), &json!(new), &json!(false), &json!(false)));
        assert_eq!((&input["project"]["name"], &input["project"]["key"], &input["board"]), (&json!("Site"), &json!("SIT"), &json!("personal")));
        assert_eq!((&input["task"]["key"], &input["reason"], &input["permission_mode"]), (&json!("KIW-1"), &json!("The user asked for one"), &json!("default")));
        assert_eq!(db::get_task(&s.db(), &caller.id).unwrap().unwrap().attention_reason.as_deref(), Some("Add a project?"));

        // Approved: it's added where the user saw, with symlinks and `..` resolved first.
        std::os::unix::fs::symlink(&home, root.join("link")).unwrap();
        let (res, asked) = tokio::join!(call(&s, &c2, "create_project", json!({"repo_path": root.join("link").join("..").join("link")})), answer_approval(&s, true));
        let v = res.unwrap();
        assert_eq!((&asked["input"]["repo_path"], &asked["input"]["exists"], &asked["input"]["project"]["name"]), (&json!(home), &json!(true), &json!("home")));
        assert_eq!((&v["repo_path"], &v["name"], &v["profile"]), (&json!(home), &json!("home"), &json!("personal")));
        assert_eq!(projects(), 2);

        // Paths that aren't plainly somewhere aren't asked about.
        for bad in ["relative/path", "", "/nonexistent-ia/../x"] {
            let err = call(&s, &c3, "create_project", json!({"repo_path": bad})).await.unwrap_err();
            assert!(err.contains("absolute path") || err.contains("can be created"), "{bad}: {err}");
        }
        std::fs::write(root.join("file"), "").unwrap();
        assert!(call(&s, &c3, "create_project", json!({"repo_path": root.join("file")})).await.unwrap_err().contains("is not a directory"));
        assert!(permissions::pending_approvals(&s, true, true).unwrap().is_empty());

        // An agent on another host has no thread here to ask in.
        let err = call(&s, &ctx(&p), "create_project", json!({"repo_path": root.join("remote")})).await.unwrap_err();
        assert!(err.contains("needs the user's approval, which only an agent on the board's own host can ask for"), "{err}");
        assert_eq!((projects(), root.join("remote").exists()), (2, false));

        // Cut short by a restart while the user is asked, the retried call waits for the same answer.
        let run = started_run(&s, &caller.id);
        let later = root.join("later");
        let mcp = || McpCall { task_fields: true, run_id: run.id.clone(), call_id: "m1".into(), tool: "create_project".into(), args: json!({"repo_path": later}) };
        assert!(tokio::time::timeout(std::time::Duration::from_millis(100), handle_mcp(&s, mcp())).await.is_err());
        let (res, _) = tokio::join!(handle_mcp(&s, mcp()), answer_approval(&s, true));
        assert_eq!(res.unwrap()["repo_path"], json!(later));
        assert_eq!((projects(), later.is_dir()), (3, true));
        std::fs::remove_dir_all(&root).unwrap();
    });
}

#[test]
fn scratch_tasks_are_made_in_no_project_unless_given_one() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "web", "WEB");
        let me = ctx(&p);
        let t = call(&s, &me, "create_task", json!({"title": "Try it", "type": "scratch"})).await.unwrap();
        assert_eq!((t["key"].as_str(), t["type"].as_str(), &t["project_id"]), (Some("S-1"), Some("scratch"), &Value::Null));
        let err = call(&s, &me, "create_task", json!({"title": "x", "type": "scratch", "is_subproject": true})).await.unwrap_err();
        assert!(err.contains("can't be a subproject"), "{err}");
        assert_eq!(call(&s, &me, "get_task", json!({"task_id": "s-1"})).await.unwrap()["title"], "Try it");
        assert!(call(&s, &me, "get_task", json!({"task_id": "S-2"})).await.is_err());
        // On its profile's board with the rest.
        let all = call(&s, &me, "list_tasks", json!({"project_id": "all"})).await.unwrap();
        assert_eq!(keys(&all, "key"), ["personal:S-1"]);

        // Given a project (API 51), it's in that project.
        let t = call(&s, &me, "create_task", json!({"title": "Ask", "type": "scratch", "project_id": "WEB"})).await.unwrap();
        assert_eq!((t["key"].as_str(), t["type"].as_str(), t["project_id"].as_str()), (Some("WEB-1"), Some("scratch"), Some("web")));
        // A subproject is a type too, and a scratch task can be in one.
        let sp = call(&s, &me, "create_task", json!({"title": "Search", "type": "subproject", "project_id": "WEB"})).await.unwrap();
        assert_eq!((sp["key"].as_str(), sp["is_subproject"].as_bool()), (Some("WEB-2"), Some(true)));
        let t = call(&s, &me, "create_task", json!({"title": "Ask", "type": "scratch", "subproject": "WEB-2"})).await.unwrap();
        assert_eq!((t["key"].as_str(), t["type"].as_str(), t["subproject"].as_str()), (Some("WEB-3"), Some("scratch"), Some("WEB-2")));
        // An agent in a project still makes one in no project unless it says otherwise.
        let worker = db::get_task(&s.db(), t["id"].as_str().unwrap()).unwrap().unwrap();
        let them = Ctx { task: Some(worker), ..ctx(&p) };
        let t = call(&s, &them, "create_task", json!({"title": "Elsewhere", "type": "scratch"})).await.unwrap();
        assert_eq!((t["key"].as_str(), &t["project_id"]), (Some("S-2"), &Value::Null));
    });
}

#[test]
fn a_group_task_creates_tasks_in_its_groups_projects() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "web", "WEB");
        project(&s, &p, "api", "API");
        for id in ["web", "api"] {
            db::update_project(&s.db(), id, &[("group_name", json!("Shop"))]).unwrap();
        }
        let new = |title| db::NewTask { profile_id: &p.id, project_id: None, kind: "task", title, description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let planner = db::insert_group_task(&s.db(), new("Plan checkout"), "Shop").unwrap();
        assert_eq!((planner.number, planner.group_name.as_deref()), (1, Some("Shop")));
        // Numbered across the profile's groups, so each key names one task.
        let blog = db::insert_group_task(&s.db(), new("Plan posts"), "Blog").unwrap();
        assert_eq!(blog.number, 2);
        assert_eq!(db::insert_group_task(&s.db(), new("Plan search"), "Shop").unwrap().number, 3);

        let me = Ctx { task: Some(planner.clone()), ..ctx(&p) };
        // It's in no project, so each task needs one.
        let err = call(&s, &me, "create_task", json!({"title": "x"})).await.unwrap_err();
        assert!(err.contains("project_id is required"), "{err}");
        let t = call(&s, &me, "create_task", json!({"title": "Cart API", "project_id": "API"})).await.unwrap();
        assert_eq!(t["key"], "API-1");
        assert_eq!(db::get_task(&s.db(), t["id"].as_str().unwrap()).unwrap().unwrap().created_by.as_deref(), Some(planner.id.as_str()));
        let got = call(&s, &me, "get_task", json!({"task_id": planner.id})).await.unwrap();
        assert_eq!((got["key"].as_str(), got["group_task"].as_str()), (Some("G-1"), Some("Shop")));
        assert_eq!(got["created_tasks"][0]["key"], "API-1");

        // Their keys name them to the board tools.
        let me = ctx(&p);
        assert_eq!(call(&s, &me, "get_task", json!({"task_id": "G-2"})).await.unwrap()["title"], "Plan posts");
        let v = call(&s, &me, "update_task", json!({"task_id": "g-2", "title": "Plan the blog"})).await.unwrap();
        assert_eq!((v["id"].as_str(), v["key"].as_str()), (Some(blog.id.as_str()), Some("G-2")));
        assert!(call(&s, &me, "get_task", json!({"task_id": "G-9"})).await.is_err());

        // No project can take the key now, and one that had it from before moves to a free
        // one (as the migration does), so both keep keys that name them.
        let err = api::update_project_inner(&s, "web", json!({"key": "g"}).as_object().unwrap()).await.unwrap_err();
        assert!(err.1.contains("used by group tasks"), "{}", err.1);
        project(&s, &p, "old", "G");
        project(&s, &p, "gp", "GP");
        task(&s, "old", "Old work");
        db::free_group_task_key(&s.db()).unwrap();
        assert_eq!(db::get_project(&s.db(), "old").unwrap().unwrap().key, "GP2");
        assert_eq!(call(&s, &me, "get_task", json!({"task_id": "G-1"})).await.unwrap()["title"], "Plan checkout");
        assert_eq!(call(&s, &me, "get_task", json!({"task_id": "GP2-1"})).await.unwrap()["title"], "Old work");
        let v = call(&s, &me, "update_task", json!({"task_id": "G-1", "title": "Plan the checkout"})).await.unwrap();
        assert_eq!(v["id"].as_str(), Some(planner.id.as_str()));
        let v = call(&s, &me, "update_task", json!({"task_id": "GP2-1", "status": "backlog"})).await.unwrap();
        assert_eq!((v["key"].as_str(), v["status"].as_str()), (Some("GP2-1"), Some("backlog")));
    });
}

#[test]
fn lists_only_the_created_tasks_the_caller_can_reach() {
    testing::run(async || {
        let s = state();
        let [personal, work, lab] = ["personal", "work", "lab"].map(|n| insert_profile(&s.db(), n, &[], None).unwrap());
        project(&s, &personal, "web", "WEB");
        project(&s, &work, "sd", "SD");
        db::update_project(&s.db(), "web", &[("group_name", json!("Shop"))]).unwrap();
        let new = db::NewTask { profile_id: &personal.id, project_id: None, kind: "task", title: "Plan", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let planner = db::insert_group_task(&s.db(), new, "Shop").unwrap();
        grant(&s, &work, &["personal"]);
        grant(&s, &personal, &["lab"]);
        let me = Ctx { task: Some(planner.clone()), ..ctx(&personal) };
        call(&s, &me, "create_task", json!({"title": "Mine", "project_id": "WEB"})).await.unwrap();
        call(&s, &me, "create_task", json!({"title": "Theirs", "project_id": "work:SD"})).await.unwrap();
        let titles = |v: &Value| {
            let created: Value = serde_json::from_str(v["content"].as_str().unwrap()).unwrap();
            created.as_array().unwrap().iter().map(|t| t["title"].as_str().unwrap().to_string()).collect::<Vec<_>>()
        };
        let get = json!({"task_id": planner.id, "field": "created_tasks", "limit": TASK_FIELD_MAX_LIMIT});
        assert_eq!(titles(&call(&s, &ctx(&personal), "get_task_field", get.clone()).await.unwrap()), ["Mine", "Theirs"]);
        // Lab reaches personal's board but not work's.
        assert_eq!(titles(&call(&s, &ctx(&lab), "get_task_field", get.clone()).await.unwrap()), ["Mine"]);
        // Nor does personal once work stops letting it in.
        grant(&s, &work, &[]);
        assert_eq!(titles(&call(&s, &ctx(&personal), "get_task_field", get.clone()).await.unwrap()), ["Mine"]);
    });
}

#[test]
fn group_tasks_have_no_dependencies() {
    testing::run(async || {
        let s = state();
        let [personal, work, lab] = ["personal", "work", "lab"].map(|n| insert_profile(&s.db(), n, &[], None).unwrap());
        for (p, id) in [(&personal, "web"), (&work, "sd")] {
            project(&s, p, id, &id.to_uppercase());
            db::update_project(&s.db(), id, &[("group_name", json!("Shop"))]).unwrap();
        }
        let planner = |p: &db::Profile, title| {
            let new = db::NewTask { profile_id: &p.id, project_id: None, kind: "task", title, description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
            db::insert_group_task(&s.db(), new, "Shop").unwrap()
        };
        let mine = planner(&personal, "Mine");
        let theirs = planner(&work, "Theirs");
        grant(&s, &work, &["personal"]);
        grant(&s, &personal, &["lab"]);
        let err = call(&s, &ctx(&personal), "update_task", json!({"task_id": mine.id, "depends_on": ["work:G-1"]})).await.unwrap_err();
        assert!(err.contains("only tasks in a project"), "{err}");
        let err = api::update_task_inner(&s, &mine.id, json!({"depends_on": [theirs.id]}).as_object().unwrap()).await.unwrap_err();
        assert!(err.1.contains("only tasks in a project"), "{}", err.1);
        // Clearing them is fine.
        call(&s, &ctx(&personal), "update_task", json!({"task_id": mine.id, "depends_on": []})).await.unwrap();

        // A link made before this was checked shows to no one, and the migration drops it.
        db::update_task(&s.db(), &mine.id, &[("depends_on", json!([theirs.id])), ("waiting", json!(true))]).unwrap();
        let get = json!({"task_id": mine.id});
        assert!(call(&s, &ctx(&lab), "get_task", get.clone()).await.unwrap()["depends_on"].is_null());
        grant(&s, &work, &[]);
        assert!(call(&s, &ctx(&personal), "get_task", get.clone()).await.unwrap()["depends_on"].is_null());
        db::clear_projectless_dependencies(&s.db()).unwrap();
        let t = db::get_task(&s.db(), &mine.id).unwrap().unwrap();
        assert!(t.depends_on.is_empty() && !t.waiting);
    });
}

#[test]
fn group_tasks_follow_their_group_when_its_renamed() {
    let c = db::open(std::path::Path::new(":memory:")).unwrap();
    let p = insert_profile(&c, "me", &[], None).unwrap();
    for id in ["a", "b"] {
        let np = NewProject { id, profile_id: &p.id, name: id, key: id, repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
        insert_project(&c, np).unwrap();
        db::update_project(&c, id, &[("group_name", json!("Old"))]).unwrap();
    }
    let new = db::NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "Plan", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
    let t = db::insert_group_task(&c, new, "Old").unwrap();
    db::update_project(&c, "a", &[("group_name", json!("New"))]).unwrap();
    // "b" is still in the old group.
    assert!(db::rename_group_tasks(&c, &p.id, "Old", Some("New")).unwrap().is_empty());
    db::update_project(&c, "b", &[("group_name", json!("New"))]).unwrap();
    assert_eq!(db::rename_group_tasks(&c, &p.id, "Old", Some("New")).unwrap(), [t.id.clone()]);
    assert_eq!(db::get_task(&c, &t.id).unwrap().unwrap().group_name.as_deref(), Some("New"));
    // Ungrouped, they keep the name.
    db::update_project(&c, "a", &[("group_name", Value::Null)]).unwrap();
    db::update_project(&c, "b", &[("group_name", Value::Null)]).unwrap();
    assert!(db::rename_group_tasks(&c, &p.id, "New", None).unwrap().is_empty());
    assert_eq!(db::list_group_tasks(&c, &p.id).unwrap()[0].group_name.as_deref(), Some("New"));
}

#[test]
fn an_agent_waits_for_the_tasks_it_watches() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "kiwicd", "KIW");
        let (planner, worker) = (task(&s, "kiwicd", "Plan"), task(&s, "kiwicd", "Build"));
        let run = db::insert_run(&s.db(), &planner.id, "prompt").unwrap();
        let mcp = |call_id: &str, args: Value| McpCall { task_fields: true, run_id: run.id.clone(), call_id: call_id.into(), tool: "wait".into(), args };

        let err = handle_mcp(&s, mcp("c0", json!({"reason": "r", "tasks": ["KIW-9"]}))).await.unwrap_err();
        assert!(err.contains("KIW-9 not found on this host"), "{err}");

        let (s2, id) = (s.clone(), worker.id.clone());
        tokio::spawn(async move {
            while db::get_task(&s2.db(), &id).unwrap().unwrap().status == "todo"
                && db::get_task(&s2.db(), &planner.id).unwrap().unwrap().agent_wait.is_none()
            {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            s2.update_task(&id, &[("status", json!("in_review"))]).unwrap();
        });
        let v = handle_mcp(&s, mcp("c1", json!({"reason": "waiting on KIW-2", "tasks": ["KIW-2"], "seconds": 60}))).await.unwrap();
        assert_eq!(v["ended"], "tasks_changed");
        assert_eq!(v["note"], "KIW-2 changed status (see tasks).");
        assert_eq!((v["tasks"][0]["key"].as_str(), v["tasks"][0]["status"].as_str()), (Some("KIW-2"), Some("in_review")));
    });
}

#[test]
fn another_call_from_the_run_ends_its_wait() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "kiwicd", "KIW");
        let planner = task(&s, "kiwicd", "Plan");
        let run = db::insert_run(&s.db(), &planner.id, "prompt").unwrap();
        let mcp = |call_id: &str, tool: &str, args: Value| McpCall { task_fields: true, run_id: run.id.clone(), call_id: call_id.into(), tool: tool.into(), args };
        let (s2, id, other) = (s.clone(), planner.id.clone(), mcp("c2", "get_task", json!({"task_id": "KIW-1"})));
        let busy = tokio::spawn(async move {
            while db::get_task(&s2.db(), &id).unwrap().unwrap().agent_wait.is_none() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            // The helper runs calls concurrently: the agent works on while the wait is pending.
            handle_mcp(&s2, other).await.unwrap();
        });
        // Without tasks or a command, a long wait is turned down.
        let err = handle_mcp(&s, mcp("c0", "wait", json!({"reason": "r", "seconds": 600}))).await.unwrap_err();
        assert!(err.contains("30 seconds at most"), "{err}");
        let v = handle_mcp(&s, mcp("c1", "wait", json!({"reason": "r", "seconds": 30}))).await.unwrap();
        busy.await.unwrap();
        assert_eq!(v["ended"], "resumed");
        assert_eq!(db::get_task(&s.db(), &planner.id).unwrap().unwrap().agent_wait, None);
    });
}

#[test]
fn a_subagents_completion_wakes_its_agents_wait() {
    testing::run(async || {
        let codex = |method: &str, params: Value| json!({"method": method, "params": params});
        let mut endings = Vec::new();
        for status in ["completed", "failed", "interrupted"] {
            endings.push((true, codex("turn/completed", json!({"threadId": "child", "turn": {"status": status}}))));
        }
        for kind in ["completed", "interrupted"] {
            endings.push((true, codex("item/completed", json!({"threadId": "main", "item": {
                "type": "subAgentActivity", "id": "activity", "kind": kind, "agentThreadId": "child"
            }}))));
        }
        endings.push((true, codex("item/completed", json!({"threadId": "main", "item": {
            "type": "collabAgentToolCall", "id": "native-wait", "tool": "wait", "status": "completed",
            "agentsStates": {"child": {"status": "completed", "message": "Child report"}}
        }}))));
        endings.push((false, json!({"type": "system", "subtype": "task_notification", "tool_use_id": "child",
            "task_id": "background", "status": "completed", "summary": "Child report"})));
        endings.push((false, json!({"type": "system", "subtype": "task_updated", "tool_use_id": "child", "patch": {"status": "failed"}})));

        for (n, (is_codex, ending)) in endings.into_iter().enumerate() {
            let s = state();
            let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
            project(&s, &p, "kiwicd", "KIW");
            let planner = task(&s, "kiwicd", "Plan");
            s.update_task(&planner.id, &[("session_id", json!("main"))]).unwrap();
            let run = db::insert_run(&s.db(), &planner.id, "prompt").unwrap();
            let start = if is_codex {
                codex("thread/started", json!({"thread": {"id": "child", "parentThreadId": "main", "preview": "Inspect config"}}))
            } else {
                json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "child", "name": "Agent",
                    "input": {"description": "Inspect config", "run_in_background": true}}]}})
            };
            runner::on_output(&s, &run.id, 0, &format!("{start}\n"));
            let (s2, task_id, run_id) = (s.clone(), planner.id.clone(), run.id.clone());
            let finish = tokio::spawn(async move {
                while db::get_task(&s2.db(), &task_id).unwrap().unwrap().agent_wait.is_none() {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
                if ending["params"]["item"]["type"] == "subAgentActivity" {
                    let mut started = ending.clone();
                    started["method"] = json!("item/started");
                    let offset = db::get_run(&s2.db(), &run_id).unwrap().unwrap().out_offset as u64;
                    runner::on_output(&s2, &run_id, offset, &format!("{started}\n"));
                    assert!(db::get_task(&s2.db(), &task_id).unwrap().unwrap().agent_wait.is_some());
                }
                let offset = db::get_run(&s2.db(), &run_id).unwrap().unwrap().out_offset as u64;
                runner::on_output(&s2, &run_id, offset, &format!("{ending}\n"));
            });
            let call = McpCall { task_fields: true, run_id: run.id.clone(), call_id: "wait".into(), tool: "wait".into(), args: json!({"reason": "waiting for child", "seconds": 1}) };
            let result = handle_mcp(&s, call).await.unwrap();
            finish.await.unwrap();
            assert_eq!(result["ended"], "subagent_finished", "case {n}: {result}");
            assert_eq!(result["subagent"]["tool_use_id"], if is_codex { "codex-agent-child" } else { "child" });
            assert_eq!(db::get_task(&s.db(), &planner.id).unwrap().unwrap().agent_wait, None);
            assert!(!db::get_run(&s.db(), &run.id).unwrap().unwrap().saw_result, "the parent's turn must stay running");
        }
    });
}

#[test]
fn a_waits_command_is_approved_like_a_bash_call() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "kiwicd", "KIW");
        let repo = crate::testing::temp_dir();
        db::update_project(&s.db(), "kiwicd", &[("repo_path", json!(repo))]).unwrap();
        let planner = task(&s, "kiwicd", "Plan");
        let run = started_run(&s, &planner.id);
        let mcp = |call_id: &str, args: Value| McpCall { task_fields: true, run_id: run.id.clone(), call_id: call_id.into(), tool: "wait".into(), args };
        // Answers the call's prompt once it's raised.
        let answer = |call_id: &'static str, allow: bool| {
            let s = s.clone();
            tokio::spawn(async move {
                loop {
                    let r: Option<(String, String)> = s.db().query_row("SELECT id, input FROM permission_requests WHERE call_id=?1", [call_id], |r| Ok((r.get(0)?, r.get(1)?))).ok();
                    if let Some((id, input)) = r {
                        crate::permissions::decide(&s, &id, allow, false, None).unwrap();
                        break serde_json::from_str::<Value>(&input).unwrap();
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            })
        };

        let asked = answer("c1", true);
        let v = handle_mcp(&s, mcp("c1", json!({"reason": "waiting for the build", "command": "pwd; exit 1", "seconds": 60}))).await.unwrap();
        assert_eq!(asked.await.unwrap(), json!({"command": "pwd; exit 1", "cwd": repo, "description": "Run while waiting: waiting for the build"}));
        assert_eq!((v["ended"].as_str(), v["note"].as_str()), (Some("command_exited"), Some("Your command exited with code 1 (see command.output).")));
        assert_eq!(v["command"], json!({"exit_code": 1, "output": format!("{}\n", repo.display())}));

        let asked = answer("c2", false);
        let err = handle_mcp(&s, mcp("c2", json!({"reason": "r", "command": "true"}))).await.unwrap_err();
        asked.await.unwrap();
        assert!(err.starts_with("The command wasn't approved, so the wait didn't start"), "{err}");
        assert_eq!(db::get_task(&s.db(), &planner.id).unwrap().unwrap().agent_wait, None);
    });
}

#[test]
fn a_waits_command_runs_unasked_when_the_agents_reviewer_approved_the_call() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "kiwicd", "KIW");
        let repo = crate::testing::temp_dir();
        db::update_project(&s.db(), "kiwicd", &[("repo_path", json!(repo))]).unwrap();
        let planner = task(&s, "kiwicd", "Plan");
        let launched = |mode: &str, allowed: &str| {
            let run = started_run(&s, &planner.id);
            let dir = crate::runs::run_dir(&s, &run.id);
            std::fs::create_dir_all(&dir).unwrap();
            let args = ["-p", "--permission-mode", mode, "--allowedTools", allowed, "mcp__gh__pr_view", "--add-dir", "/a"];
            std::fs::write(dir.join("spec.json"), json!({"cwd": repo, "args": args}).to_string()).unwrap();
            run
        };
        // A Codex run in auto mode, from this build (whose reviewer reviews waits) or an older one.
        let codex_launched = |review_waits: Option<bool>| {
            let run = started_run(&s, &planner.id);
            let dir = crate::runs::run_dir(&s, &run.id);
            std::fs::create_dir_all(&dir).unwrap();
            let spec_path = dir.join("codex.json");
            let mut spec = json!({"cwd": repo, "approval_policy": "on-request", "approvals_reviewer": "auto_review", "sandbox": "workspace-write"});
            if let Some(r) = review_waits {
                spec["review_waits"] = json!(r);
            }
            std::fs::write(&spec_path, spec.to_string()).unwrap();
            std::fs::write(dir.join("spec.json"), json!({"cwd": repo, "args": ["codex-run", spec_path]}).to_string()).unwrap();
            run
        };
        let mcp = |run_id: &str, call_id: &str| McpCall {
            task_fields: true,
            run_id: run_id.into(),
            call_id: call_id.into(),
            tool: "wait".into(),
            args: json!({"reason": "waiting for CI", "command": "exit 3"}),
        };
        let request = |call_id: &str| s.db().query_row("SELECT id FROM permission_requests WHERE call_id=?1", [call_id], |r| r.get::<_, String>(0)).ok();

        // Claude's auto mode classifier approved the call before the agent made it.
        let run = launched("auto", "mcp__huntaway__get_task");
        let v = handle_mcp(&s, mcp(&run.id, "c1")).await.unwrap();
        assert_eq!((v["ended"].as_str(), &v["command"]["exit_code"]), (Some("command_exited"), &json!(3)));
        assert_eq!(request("c1"), None);
        // As did Codex's reviewer.
        let run = codex_launched(Some(true));
        let v = handle_mcp(&s, mcp(&run.id, "c2")).await.unwrap();
        assert_eq!((v["ended"].as_str(), &v["command"]["exit_code"]), (Some("command_exited"), &json!(3)));
        assert_eq!(request("c2"), None);

        // A run that pre-approves every board tool (one from an older build, before or after
        // the rename, Claude or Codex) is still asked, in auto mode as in Ask.
        let runs = [launched("auto", "mcp__huntaway"), launched("auto", "mcp__issue_agent"), launched("default", "mcp__issue_agent")];
        let runs = runs.into_iter().chain([codex_launched(None), codex_launched(Some(false))]);
        for (n, run) in runs.enumerate() {
            let call_id = format!("asked{n}");
            s.runs.lock().unwrap().insert(planner.id.clone(), crate::state::RunHandle { run_id: run.id.clone(), cancel: None });
            let call = tokio::spawn({
                let (s, call) = (s.clone(), mcp(&run.id, &call_id));
                async move { handle_mcp(&s, call).await }
            });
            let id = loop {
                match request(&call_id) {
                    Some(id) => break id,
                    None => tokio::time::sleep(std::time::Duration::from_millis(10)).await,
                }
            };
            crate::permissions::decide(&s, &id, false, false, None).unwrap();
            let err = call.await.unwrap().unwrap_err();
            assert!(err.starts_with("The command wasn't approved"), "{n}: {err}");
        }

        // And in Don't ask its command is refused without asking.
        db::update_task(&s.db(), &planner.id, &[("permission_mode", json!("dontAsk"))]).unwrap();
        let run = launched("dontAsk", "mcp__issue_agent");
        let err = handle_mcp(&s, mcp(&run.id, "c3")).await.unwrap_err();
        assert!(err.contains(crate::permissions::DONT_ASK_DENIAL), "{err}");
        assert_eq!(request("c3"), None);
    });
}

#[test]
fn an_agent_waits_on_its_pull_request() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "kiwicd", "KIW");
        // The project's repository, on GitHub as o/r.
        let repo = crate::testing::temp_dir();
        for args in [&["init", "-q"][..], &["remote", "add", "origin", "git@github.com:o/r.git"]] {
            assert!(std::process::Command::new("git").args(args).current_dir(&repo).status().unwrap().success());
        }
        db::update_project(&s.db(), "kiwicd", &[("repo_path", json!(repo))]).unwrap();
        let t = task(&s, "kiwicd", "Build");
        let failed = crate::pr_watch::response("me", "a1", &[("Tests / server", "COMPLETED", "FAILURE", true)], &[]);
        crate::pr_watch::fake(move |_, target| {
            assert_eq!(target.label(), "o/r#7");
            Ok(failed.clone())
        });
        // A Claude run and a Codex run (in auto mode, whose reviewer reviews waits) call it alike.
        let claude = db::insert_run(&s.db(), &t.id, "prompt").unwrap();
        let codex = db::insert_run(&s.db(), &t.id, "prompt").unwrap();
        let dir = crate::runs::run_dir(&s, &codex.id);
        std::fs::create_dir_all(&dir).unwrap();
        let spec = json!({"cwd": repo, "approval_policy": "on-request", "approvals_reviewer": "auto_review", "sandbox": "workspace-write", "review_waits": true});
        std::fs::write(dir.join("codex.json"), spec.to_string()).unwrap();
        std::fs::write(dir.join("spec.json"), json!({"cwd": repo, "args": ["codex-run", dir.join("codex.json")]}).to_string()).unwrap();
        let mcp = |run: &db::Run, call_id: &str, args: Value| McpCall { task_fields: true, run_id: run.id.clone(), call_id: call_id.into(), tool: "wait".into(), args };

        let v = handle_mcp(&s, mcp(&claude, "c1", json!({"reason": "waiting for CI", "pull_request": "7"}))).await.unwrap();
        assert_eq!(v["ended"], "pull_request");
        assert_eq!(v["note"], "Pull request #7: checks failed (Tests / server) (see pull_request).");
        assert_eq!(v["pull_request"]["checks"]["failed"][0]["name"], "Tests / server");
        assert_eq!(v["pull_request"]["events"], json!(["checks_failed"]));
        // Told, a later wait (by URL) times out, saying how it was when last read.
        let v = handle_mcp(&s, mcp(&codex, "c2", json!({"reason": "waiting for review", "pull_request": "https://github.com/o/r/pull/7", "seconds": 1}))).await.unwrap();
        assert_eq!(v["ended"], "timeout");
        assert_eq!((v["pull_request"]["checks"]["outcome"].as_str(), v["pull_request"]["number"].as_u64()), (Some("failed"), Some(7)));
        assert!(v["pull_request"]["read_at"].is_string(), "{v}");
        assert_eq!(s.db().query_row("SELECT COUNT(*) FROM permission_requests", [], |r| r.get::<_, i64>(0)).unwrap(), 0);

        let err = handle_mcp(&s, mcp(&claude, "c3", json!({"reason": "r", "pull_request": 7, "pull_request_events": ["reviews"]}))).await.unwrap_err();
        assert!(err.starts_with("pull_request_events takes checks_failed, checks_passed, comments, conflicts"), "{err}");
        let err = handle_mcp(&s, mcp(&claude, "c4", json!({"reason": "r", "pull_request": "the PR"}))).await.unwrap_err();
        assert!(err.contains("the PR isn't a pull request"), "{err}");
        // A whole number sent as a float (or written as one) is a number.
        for (call, pr) in [("c5", json!(7.0)), ("c5b", json!("7.0"))] {
            let v = handle_mcp(&s, mcp(&claude, call, json!({"reason": "r", "pull_request": pr, "seconds": 1}))).await.unwrap();
            assert_eq!((v["ended"].as_str(), v["pull_request"]["number"].as_u64()), (Some("timeout"), Some(7)), "{pr}");
        }
        let err = handle_mcp(&s, mcp(&claude, "c6", json!({"reason": "r", "pull_request": 7.5}))).await.unwrap_err();
        assert!(err.contains("7.5 isn't a pull request"), "{err}");
        // A remote's host that isn't its account's (an SSH alias ssh doesn't know) asks for the URL.
        assert!(std::process::Command::new("git").args(["remote", "set-url", "origin", "git@github-work:o/r.git"]).current_dir(&repo).status().unwrap().success());
        db::update_profile(&s.db(), &p.id, &[("github_account", json!("me"))]).unwrap();
        let err = handle_mcp(&s, mcp(&claude, "c7", json!({"reason": "r", "pull_request": 7}))).await.unwrap_err();
        assert!(err.contains("this task's repository is pushed to github-work, but its GitHub account me is on github.com: give the pull request's URL"), "{err}");
        // The pull request's state is kept with the task, and goes with it.
        assert_eq!(s.db().query_row("SELECT COUNT(*) FROM pr_watches WHERE task_id=?1", [&t.id], |r| r.get::<_, i64>(0)).unwrap(), 1);
        s.db().execute("DELETE FROM tasks WHERE id=?1", [&t.id]).unwrap();
        assert_eq!(s.db().query_row("SELECT COUNT(*) FROM pr_watches", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        std::fs::remove_dir_all(&repo).unwrap();
    });
}

#[test]
fn a_retried_wait_wakes_for_a_watched_task_deleted_meanwhile() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "kiwicd", "KIW");
        let (planner, worker) = (task(&s, "kiwicd", "Plan"), task(&s, "kiwicd", "Build"));
        let run = db::insert_run(&s.db(), &planner.id, "prompt").unwrap();
        // The call was waiting on KIW-2 when the server went down, and KIW-2 was deleted since.
        let w = db::AgentWait {
            reason: Some("waiting on KIW-2".into()),
            since: crate::util::now(),
            until: (chrono::Utc::now() + chrono::Duration::seconds(60)).to_rfc3339(),
            tasks: vec![db::WaitTask { id: worker.id.clone(), key: "KIW-2".into(), status: worker.status.clone() }],
            command: None,
            call_id: "c1".into(),
            run_id: run.id.clone(),
            moved_to: None,
            subagent_finished: None,
            pull_request: None,
        };
        s.update_task(&planner.id, &[("agent_wait", json!(w))]).unwrap();
        s.db().execute("DELETE FROM tasks WHERE id=?1", [&worker.id]).unwrap();
        let retry = McpCall { task_fields: true, run_id: run.id.clone(), call_id: "c1".into(), tool: "wait".into(), args: json!({"reason": "waiting on KIW-2", "tasks": ["KIW-2"], "seconds": 60}) };
        let v = handle_mcp(&s, retry).await.unwrap();
        assert_eq!(v["ended"], "tasks_changed");
        assert_eq!(v["tasks"], json!([{"id": worker.id, "key": "KIW-2", "deleted": true}]));
        assert_eq!(db::get_task(&s.db(), &planner.id).unwrap().unwrap().agent_wait, None);
    });
}

#[test]
fn a_subagents_permission_prompt_doesnt_end_its_agents_wait() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "kiwicd", "KIW");
        let planner = task(&s, "kiwicd", "Plan");
        db::update_task(&s.db(), &planner.id, &[("auto_allow", json!(r#"["Bash"]"#))]).unwrap();
        let run = db::insert_run(&s.db(), &planner.id, "prompt").unwrap();
        let mcp = |call_id: &str, tool: &str, args: Value| McpCall { task_fields: true, run_id: run.id.clone(), call_id: call_id.into(), tool: tool.into(), args };
        let prompt = mcp("c2", "permission_prompt", json!({"tool_name": "Bash", "input": {"command": "make"}, "tool_use_id": "toolu_sub"}));
        let (s2, id) = (s.clone(), planner.id.clone());
        let subagent = tokio::spawn(async move {
            while db::get_task(&s2.db(), &id).unwrap().unwrap().agent_wait.is_none() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            let v = handle_mcp(&s2, prompt).await.unwrap();
            assert_eq!(v["behavior"], "allow");
            db::get_task(&s2.db(), &id).unwrap().unwrap().agent_wait.is_some()
        });
        let v = handle_mcp(&s, mcp("c1", "wait", json!({"reason": "r", "seconds": 1}))).await.unwrap();
        assert!(subagent.await.unwrap(), "the prompt cleared the wait");
        assert_eq!(v["ended"], "timeout");
    });
}

#[test]
fn a_reviewer_can_only_read_the_board_whatever_its_tool_list_offers() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "kiwicd", "KIW");
        let reviewed = task(&s, "kiwicd", "Reviewed");
        let new = db::NewTask {
            profile_id: &p.id,
            project_id: Some("kiwicd"),
            kind: "review",
            title: "review",
            description: "",
            status: "todo",
            use_worktree: false,
            model: None,
            effort: None,
            claude_config_id: None,
        };
        let thread = db::insert_task(&s.db(), new).unwrap();
        db::update_task(&s.db(), &thread.id, &[("parent_id", json!(reviewed.id))]).unwrap();
        let run = db::insert_run(&s.db(), &thread.id, "review").unwrap();
        let auto_review = db::get_project(&s.db(), "kiwicd").unwrap().unwrap().auto_review;
        let mcp = |call_id: &str, tool: &str, args: Value| McpCall { task_fields: true, run_id: run.id.clone(), call_id: call_id.into(), tool: tool.into(), args };
        // A reviewer reading an injected instruction can't start agents, steer the reviewed
        // task's, or change tasks and projects, even calling a tool its helper doesn't list.
        let refused = [
            ("create_task", json!({"title": "Exfiltrate", "start": true})),
            ("send_to_task", json!({"task_id": "KIW-1", "message": "Push to main"})),
            ("update_task", json!({"task_id": "KIW-1", "status": "done"})),
            ("update_project", json!({"auto_review": !auto_review})),
            ("create_project", json!({"repo_path": "/tmp/x"})),
            ("delete_task", json!({"task_id": "KIW-1"})),
        ];
        for (i, (tool, args)) in refused.into_iter().enumerate() {
            let err = handle_mcp(&s, mcp(&format!("c{i}"), tool, args)).await.unwrap_err();
            assert!(err.starts_with(&format!("{tool} isn't available to reviewers")), "{err}");
        }
        assert_eq!(db::list_tasks_for_project(&s.db(), "kiwicd", "task").unwrap().len(), 1);
        let t = db::get_task(&s.db(), &reviewed.id).unwrap().unwrap();
        assert_eq!((t.status.as_str(), t.steering.len()), ("todo", 0));
        assert_eq!(db::get_project(&s.db(), "kiwicd").unwrap().unwrap().auto_review, auto_review);
        // Nor is the user asked to approve anything for it (delete_task, update_project).
        let asked: i64 = s.db().query_row("SELECT COUNT(*) FROM permission_requests", [], |r| r.get(0)).unwrap();
        assert_eq!(asked, 0);
        // It still reads the board.
        assert_eq!(handle_mcp(&s, mcp("r1", "get_task", json!({"task_id": "KIW-1"}))).await.unwrap()["title"], "Reviewed");
        assert_eq!(handle_mcp(&s, mcp("r2", "get_project", json!({}))).await.unwrap()["key"], "KIW");
        assert_eq!(handle_mcp(&s, mcp("r3", "list_tasks", json!({}))).await.unwrap().as_array().unwrap().len(), 1);
        assert!(!handle_mcp(&s, mcp("r4", "list_projects", json!({}))).await.unwrap().as_array().unwrap().is_empty());
        assert_eq!(handle_mcp(&s, mcp("r5", "get_task_field", json!({"task_id": "KIW-1", "field": "title"}))).await.unwrap()["content"], "Reviewed");
        // A task's own agent keeps them all.
        let own = db::insert_run(&s.db(), &reviewed.id, "prompt").unwrap();
        let call = McpCall { task_fields: true, run_id: own.id, call_id: "t1".into(), tool: "create_task".into(), args: json!({"title": "Follow-up"}) };
        handle_mcp(&s, call).await.unwrap();
        assert_eq!(db::list_tasks_for_project(&s.db(), "kiwicd", "task").unwrap().len(), 2);
    });
}

#[test]
fn a_run_the_board_has_ended_gets_nothing_done() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "kiwicd", "KIW");
        let t = task(&s, "kiwicd", "Work");
        // Its supervisor vanished and the board ended it, but its agent's helper still calls.
        let run = db::insert_run(&s.db(), &t.id, "prompt").unwrap();
        s.db().execute("UPDATE runs SET status='exited' WHERE id=?1", [&run.id]).unwrap();
        s.update_task(&t.id, &[("status", json!("in_review"))]).unwrap();
        let mcp = |call_id: &str, tool: &str, args: Value| McpCall { task_fields: true, run_id: run.id.clone(), call_id: call_id.into(), tool: tool.into(), args };
        let calls = [
            ("create_task", json!({"title": "Follow-up", "start": true})),
            ("update_task", json!({"task_id": "KIW-1", "status": "done"})),
            ("send_to_task", json!({"task_id": "KIW-1", "message": "Carry on"})),
            ("permission_prompt", json!({"tool_name": "Bash", "input": {"command": "make"}})),
            ("get_task", json!({"task_id": "KIW-1"})),
        ];
        for (i, (tool, args)) in calls.into_iter().enumerate() {
            let err = handle_mcp(&s, mcp(&format!("c{i}"), tool, args)).await.unwrap_err();
            assert!(err.starts_with("This run has ended on the board"), "{tool}: {err}");
        }
        let t = db::get_task(&s.db(), &t.id).unwrap().unwrap();
        assert_eq!((t.status.as_str(), t.steering.len(), t.queued_message), ("in_review", 0, None));
        assert_eq!(db::list_tasks_for_project(&s.db(), "kiwicd", "task").unwrap().len(), 1);
        let asked: i64 = s.db().query_row("SELECT COUNT(*) FROM permission_requests", [], |r| r.get(0)).unwrap();
        assert_eq!(asked, 0);
    });
}

#[test]
fn a_prompt_from_a_run_that_has_let_go_of_its_thread_isnt_raised() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "kiwicd", "KIW");
        let t = task(&s, "kiwicd", "Work");
        let run = db::insert_run(&s.db(), &t.id, "prompt").unwrap();
        s.db().execute("UPDATE runs SET status='running' WHERE id=?1", [&run.id]).unwrap();
        s.update_task(&t.id, &[("status", json!("in_review"))]).unwrap();
        // The run is ending (runner::finish has let go of the thread and expired its prompts,
        // but not yet marked it exited) as its prompt comes in.
        let prompt = McpCall {
            task_fields: true, run_id: run.id.clone(), call_id: "p1".into(), tool: "permission_prompt".into(),
            args: json!({"tool_name": "Bash", "input": {"command": "make"}}),
        };
        let err = handle_mcp(&s, prompt).await.unwrap_err();
        assert!(err.contains("run has ended"), "{err}");
        assert_eq!(db::get_task(&s.db(), &t.id).unwrap().unwrap().status, "in_review");
        let asked: i64 = s.db().query_row("SELECT COUNT(*) FROM permission_requests", [], |r| r.get(0)).unwrap();
        assert_eq!(asked, 0);
        // While it holds the thread, it's asked.
        s.runs.lock().unwrap().insert(t.id.clone(), crate::state::RunHandle { run_id: run.id.clone(), cancel: None });
        let prompt = McpCall {
            task_fields: true, run_id: run.id.clone(), call_id: "p2".into(), tool: "permission_prompt".into(),
            args: json!({"tool_name": "Bash", "input": {"command": "make"}}),
        };
        let asking = tokio::spawn({
            let s = s.clone();
            async move { handle_mcp(&s, prompt).await }
        });
        while db::get_task(&s.db(), &t.id).unwrap().unwrap().status != "needs_attention" {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        permissions::expire_for_task(&s, &t.id);
        assert_eq!(asking.await.unwrap().unwrap()["behavior"], "deny");
    });
}

#[test]
fn a_thread_in_plan_mode_only_reads_the_board() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "kiwicd", "KIW");
        let planner = task(&s, "kiwicd", "Plan");
        s.update_task(&planner.id, &[("permission_mode", json!("plan"))]).unwrap();
        let run = db::insert_run(&s.db(), &planner.id, "prompt").unwrap();
        let mcp = |call_id: &str, tool: &str, args: Value| McpCall { task_fields: true, run_id: run.id.clone(), call_id: call_id.into(), tool: tool.into(), args };
        let refused = [
            ("create_task", json!({"title": "Do it now", "start": true})),
            ("send_to_task", json!({"task_id": "KIW-1", "message": "Go"})),
            ("update_task", json!({"task_id": "KIW-1", "status": "done"})),
            ("run_automation", json!({"automation_id": "nightly"})),
        ];
        for (i, (tool, args)) in refused.into_iter().enumerate() {
            let err = handle_mcp(&s, mcp(&format!("c{i}"), tool, args)).await.unwrap_err();
            assert!(err.starts_with(&format!("{tool} isn't available in plan mode")), "{err}");
        }
        assert_eq!(db::list_tasks_for_project(&s.db(), "kiwicd", "task").unwrap().len(), 1);
        assert_eq!(db::get_task(&s.db(), &planner.id).unwrap().unwrap().status, "todo");
        assert_eq!(handle_mcp(&s, mcp("r1", "get_task", json!({"task_id": "KIW-1"}))).await.unwrap()["title"], "Plan");
        // Its plan approved, it carries on in another mode with them all.
        s.update_task(&planner.id, &[("permission_mode", Value::Null)]).unwrap();
        handle_mcp(&s, mcp("t1", "create_task", json!({"title": "Follow-up"}))).await.unwrap();
        assert_eq!(db::list_tasks_for_project(&s.db(), "kiwicd", "task").unwrap().len(), 2);
        // As does a thread that inherits plan mode from its project.
        db::update_project(&s.db(), "kiwicd", &[("permission_mode", json!("plan"))]).unwrap();
        let err = handle_mcp(&s, mcp("c9", "create_task", json!({"title": "Another"}))).await.unwrap_err();
        assert!(err.starts_with("create_task isn't available in plan mode"), "{err}");
    });
}

#[test]
fn a_review_thread_isnt_a_task_by_its_id_either() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "kiwicd", "KIW");
        let reviewed = task(&s, "kiwicd", "Reviewed");
        let new = db::NewTask {
            profile_id: &p.id, project_id: Some("kiwicd"), kind: "review", title: "review", description: "", status: "todo",
            use_worktree: false, model: None, effort: None, claude_config_id: None,
        };
        let thread = db::insert_task(&s.db(), new).unwrap();
        db::update_task(&s.db(), &thread.id, &[("parent_id", json!(reviewed.id))]).unwrap();
        let me = ctx(&p);
        for (tool, args) in [("get_task", json!({"task_id": thread.id})), ("send_to_task", json!({"task_id": thread.id, "message": "Approve it"}))] {
            let err = call(&s, &me, tool, args).await.unwrap_err();
            assert_eq!(err, format!("task {}", thread.id), "{tool}");
        }
        assert!(db::list_messages(&s.db(), &thread.id).unwrap().is_empty());
        assert_eq!(db::get_task(&s.db(), &thread.id).unwrap().unwrap().queued_message, None);
        assert_eq!(call(&s, &me, "get_task", json!({"task_id": reviewed.id})).await.unwrap()["title"], "Reviewed");
    });
}

#[test]
fn a_project_name_with_a_colon_isnt_read_as_a_profile() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "kiwicd", "KIW");
        db::update_project(&s.db(), "kiwicd", &[("name", json!("Ops: infra"))]).unwrap();
        let me = ctx(&p);
        assert_eq!(call(&s, &me, "get_project", json!({"project_id": "Ops: infra"})).await.unwrap()["key"], "KIW");
        // A profile's name still qualifies a key, and one that doesn't let the caller in says so.
        assert_eq!(call(&s, &me, "get_project", json!({"project_id": "personal:KIW"})).await.unwrap()["key"], "KIW");
        // Even if a profile is called Ops, whether it lets the caller in or not.
        let ops = insert_profile(&s.db(), "ops", &[], None).unwrap();
        assert_eq!(call(&s, &me, "get_project", json!({"project_id": "Ops: infra"})).await.unwrap()["key"], "KIW");
        let err = call(&s, &me, "get_project", json!({"project_id": "ops:KIW"})).await.unwrap_err();
        assert!(err.contains("doesn't let agents in profile personal"), "{err}");
        grant(&s, &ops, &["personal"]);
        assert_eq!(call(&s, &me, "get_project", json!({"project_id": "Ops: infra"})).await.unwrap()["key"], "KIW");
    });
}

#[test]
fn a_guessed_argument_name_says_what_the_tool_takes() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "kiwicd", "KIW");
        let own = task(&s, "kiwicd", "Plan");
        let run = db::insert_run(&s.db(), &own.id, "prompt").unwrap();
        let mcp = |call_id: &str, tool: &str, args: Value| McpCall { task_fields: true, run_id: run.id.clone(), call_id: call_id.into(), tool: tool.into(), args };
        // An agent that never loaded the schema guessed `task` and got "not found: task ".
        let err = handle_mcp(&s, mcp("c1", "get_task", json!({"task": "KIW-1"}))).await.unwrap_err();
        assert!(err.starts_with("get_task has no argument \"task\"; its arguments are ") && err.contains("task_id"), "{err}");
        let err = handle_mcp(&s, mcp("c2", "update_task", json!({"status": "done"}))).await.unwrap_err();
        assert!(err.starts_with("update_task needs task_id"), "{err}");
        // `project` was ignored, so the task went to the caller's project whatever was named.
        let err = handle_mcp(&s, mcp("c3", "create_task", json!({"title": "t", "project": "OTHER"}))).await.unwrap_err();
        assert!(err.contains("no argument \"project\""), "{err}");
        assert_eq!(handle_mcp(&s, mcp("c4", "get_task", json!({"task_id": "KIW-1"}))).await.unwrap()["title"], "Plan");
        assert_eq!(db::list_tasks_for_project(&s.db(), "kiwicd", "task").unwrap().len(), 1);
    });
}

#[test]
fn a_call_cut_short_by_a_restart_doesnt_run_again() {
    testing::run(async || {
        use futures::FutureExt;
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "kiwicd", "KIW");
        let planner = task(&s, "kiwicd", "Plan");
        let run = db::insert_run(&s.db(), &planner.id, "prompt").unwrap();
        let call = |id: &str| McpCall { task_fields: true, run_id: run.id.clone(), call_id: id.into(), tool: "create_task".into(), args: json!({"title": "Child"}) };
        let children = || s.db().query_row("SELECT COUNT(*) FROM tasks WHERE title='Child'", [], |r| r.get::<_, i64>(0)).unwrap();
        // The server goes down after creating the task, before recording that it did.
        testing::when("mcp:executed", || panic!("the server stopped"));
        let crashed = std::panic::AssertUnwindSafe(handle_mcp(&s, call("c1"))).catch_unwind().await;
        assert!(crashed.is_err());
        assert_eq!(children(), 1);
        // The helper retries the call with its id once the server is back.
        let err = handle_mcp(&s, call("c1")).await.unwrap_err();
        assert!(err.contains("interrupted"), "{err}");
        assert_eq!(children(), 1);
        // A call that can safely run again does.
        let get = McpCall { task_fields: true, run_id: run.id.clone(), call_id: "c2".into(), tool: "get_task".into(), args: json!({"task_id": "KIW-1"}) };
        testing::when("mcp:executed", || panic!("the server stopped"));
        assert!(std::panic::AssertUnwindSafe(handle_mcp(&s, get)).catch_unwind().await.is_err());
        let get = McpCall { task_fields: true, run_id: run.id.clone(), call_id: "c2".into(), tool: "get_task".into(), args: json!({"task_id": "KIW-1"}) };
        assert_eq!(handle_mcp(&s, get).await.unwrap()["title"], "Plan");
    });
}

#[test]
fn a_call_the_board_cant_record_isnt_run() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "kiwicd", "KIW");
        let planner = task(&s, "kiwicd", "Plan");
        let run = db::insert_run(&s.db(), &planner.id, "prompt").unwrap();
        let call = || McpCall { task_fields: true, run_id: run.id.clone(), call_id: "c1".into(), tool: "create_task".into(), args: json!({"title": "Child"}) };
        let children = || s.db().query_row("SELECT COUNT(*) FROM tasks WHERE title='Child'", [], |r| r.get::<_, i64>(0)).unwrap();
        // Recording it fails (a full disk, say), twice.
        s.db().execute_batch("CREATE TRIGGER no_calls BEFORE INSERT ON mcp_calls BEGIN SELECT RAISE(ABORT, 'disk full'); END").unwrap();
        for _ in 0..2 {
            let err = handle_mcp(&s, call()).await.unwrap_err();
            assert!(err.contains("couldn't record") && err.contains("disk full"), "{err}");
        }
        assert_eq!(children(), 0);
        // So does finding out whether it ran.
        s.db().execute_batch("DROP TRIGGER no_calls; ALTER TABLE mcp_calls RENAME TO calls").unwrap();
        assert!(handle_mcp(&s, call()).await.unwrap_err().contains("couldn't record"));
        assert_eq!(children(), 0);
        s.db().execute_batch("ALTER TABLE calls RENAME TO mcp_calls").unwrap();
        handle_mcp(&s, call()).await.unwrap();
        assert_eq!(children(), 1);
    });
}

#[test]
fn an_approval_cut_short_by_a_restart_is_still_waited_for() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "kiwicd", "KIW");
        let caller = task(&s, "kiwicd", "Caller");
        let run = started_run(&s, &caller.id);
        let call = |id: &str, script: &str| McpCall { task_fields: true, run_id: run.id.clone(), call_id: id.into(), tool: "update_project".into(), args: json!({"setup_script": script}) };
        let script = || db::get_project(&s.db(), "kiwicd").unwrap().unwrap().setup_script;
        let cut_short = async |c: McpCall| assert!(tokio::time::timeout(std::time::Duration::from_millis(100), handle_mcp(&s, c)).await.is_err());
        // The server restarts while the user is asked; retried, the call waits for their answer and makes the change once.
        cut_short(call("c1", "npm ci")).await;
        let (res, _) = tokio::join!(handle_mcp(&s, call("c1", "npm ci")), answer_approval(&s, true));
        res.unwrap();
        assert_eq!(script(), "npm ci");
        assert_eq!(handle_mcp(&s, call("c1", "npm ci")).await.unwrap()["setup_script"], json!("npm ci"));
        // Denied before the retry: still nothing changed.
        cut_short(call("c2", "make")).await;
        answer_approval(&s, false).await;
        assert!(handle_mcp(&s, call("c2", "make")).await.unwrap_err().contains("didn't approve"));
        assert_eq!(script(), "npm ci");
        // Approved before the retry: the change may have been made as the server stopped, so it isn't made again.
        cut_short(call("c3", "make")).await;
        answer_approval(&s, true).await;
        assert!(handle_mcp(&s, call("c3", "make")).await.unwrap_err().contains("interrupted"));
        // So does a deletion's.
        let (doomed, kept) = (task(&s, "kiwicd", "Doomed"), task(&s, "kiwicd", "Kept"));
        let delete = |id: &str, key: &str| McpCall { task_fields: true, run_id: run.id.clone(), call_id: id.into(), tool: "delete_task".into(), args: json!({"task_id": key}) };
        let exists = |t: &Task| db::get_task(&s.db(), &t.id).unwrap().is_some();
        cut_short(delete("c4", "KIW-2")).await;
        let (res, _) = tokio::join!(handle_mcp(&s, delete("c4", "KIW-2")), answer_approval(&s, true));
        assert_eq!(res.unwrap()["deleted"], json!(true));
        assert!(!exists(&doomed));
        cut_short(delete("c5", "KIW-3")).await;
        answer_approval(&s, true).await;
        assert!(handle_mcp(&s, delete("c5", "KIW-3")).await.unwrap_err().contains("interrupted"));
        assert!(exists(&kept));
    });
}
fn automations(s: &Shared, project: &str) -> Vec<crate::automations::Automation> {
    crate::automations::list(&s.db(), project).unwrap()
}

fn webhook_args(name: &str) -> Value {
    json!({
        "name": name,
        "trigger": {"kind": "webhook", "filters": [{"path": "event", "op": "equals", "value": "issues"}]},
        "action": {"kind": "create_task", "title": "Triage: {{body.issue.title}}", "description": "Look at {{body.issue.html_url}}", "start": true},
        "generate_secret": true,
        "reason": "Triage new issues",
    })
}

#[test]
fn agents_create_automations_only_once_the_user_approves() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "kiwicd", "KIW");
        project(&s, &p, "other", "OTH");
        // Even a thread that may do anything without asking asks first.
        let caller = task(&s, "kiwicd", "Caller");
        s.update_task(&caller.id, &[("permission_mode", json!("bypassPermissions"))]).unwrap();
        let caller = db::get_task(&s.db(), &caller.id).unwrap().unwrap();
        let me = |call_id: &str| Ctx { task: Some(caller.clone()), call_id: Some(call_id.into()), ..ctx(&p) };
        let elsewhere = task(&s, "other", "Elsewhere");

        // Denied: nothing is made.
        let (c1, c2) = (me("c1"), me("c2"));
        let (res, asked) = tokio::join!(call(&s, &c1, "create_automation", webhook_args("Triage")), answer_approval(&s, false));
        let err = res.unwrap_err();
        assert!(err.contains("didn't approve creating the automation \"Triage\", so nothing was created"), "{err}");
        assert!(automations(&s, "kiwicd").is_empty());
        // The approval shows what would run, and who asked.
        assert_eq!((&asked["kind"], &asked["tool_name"]), (&json!("automation"), &json!("create_automation")));
        let input = &asked["input"];
        assert_eq!((&input["op"], &input["project"]["key"], &input["task"]["key"]), (&json!("create"), &json!("KIW"), &json!("KIW-1")));
        assert_eq!(input["reason"], "Triage new issues");
        let a = &input["automation"];
        assert_eq!((&a["name"], &a["enabled"], &a["signed"]), (&json!("Triage"), &json!(true), &json!(true)));
        assert_eq!((&a["trigger"]["kind"], &a["trigger"]["filters"][0]["value"]), (&json!("webhook"), &json!("issues")));
        assert_eq!((&a["action"]["title"], &a["action"]["start"], &a["action"]["status"]), (&json!("Triage: {{body.issue.title}}"), &json!(true), &json!("todo")));
        assert_eq!(db::get_task(&s.db(), &caller.id).unwrap().unwrap().attention_reason.as_deref(), Some("Approve an automation?"));
        // Only UIs that know automations are shown it.
        let shown = async {
            let a = approval_asked(&s).await;
            assert!(permissions::pending_approvals(&s, true, false).unwrap().is_empty());
            answer_approval(&s, true).await;
            a
        };
        // Approved: it's made as it was shown, with a new secret that's returned once.
        let (res, _) = tokio::join!(call(&s, &c2, "create_automation", webhook_args("Triage")), shown);
        let res = res.unwrap();
        let made = automations(&s, "kiwicd");
        assert_eq!(made.len(), 1);
        assert_eq!((made[0].name.as_str(), made[0].enabled), ("Triage", true));
        assert_eq!(made[0].secret.as_deref(), res["secret"].as_str());
        assert!(res["secret"].as_str().is_some_and(|s| s.len() > 20));
        assert_eq!(res["hook_path"], json!(made[0].hook_path()));
        assert!(res["webhook_note"].is_string());
        // With the host's public address, the full URL.
        db::set_setting(&s.db(), "public_url", Some("https://board.example.com")).unwrap();
        let list = call(&s, &me("c3"), "list_automations", json!({})).await.unwrap();
        assert_eq!(list["automations"][0]["webhook_url"], json!(format!("https://board.example.com{}", made[0].hook_path())));
        assert!(list["automations"][0].get("secret").is_none());

        // A message goes to a task named by key, and only one of the project's own.
        let message = |task: &str| json!({
            "name": "Nudge", "trigger": {"kind": "daily", "time": "9:00", "weekdays": ["fri", "mon"]},
            "action": {"kind": "send_to_task", "task_id": task, "message": "Anything new?"},
        });
        let err = call(&s, &me("c4"), "create_automation", message(&format!("OTH-{}", elsewhere.number))).await.unwrap_err();
        assert!(err.contains("only send messages to tasks in its own project"), "{err}");
        let err = call(&s, &me("c5"), "create_automation", message("KIW-99")).await.unwrap_err();
        assert!(err.contains("not found"), "{err}");
        // Bad settings are refused before the user is asked.
        let mut fast = message("KIW-1");
        fast["trigger"] = json!({"kind": "interval", "every_minutes": 1});
        assert!(call(&s, &me("c6"), "create_automation", fast).await.unwrap_err().contains("every_minutes"));
        let mut signed = message("KIW-1");
        signed["generate_secret"] = json!(true);
        assert!(call(&s, &me("c7"), "create_automation", signed).await.unwrap_err().contains("only a webhook"));
        assert!(permissions::pending_approvals(&s, true, true).unwrap().is_empty());
        let c8 = me("c8");
        let (res, asked) = tokio::join!(call(&s, &c8, "create_automation", message("KIW-1")), answer_approval(&s, true));
        res.unwrap();
        let view = &asked["input"]["automation"];
        assert_eq!((&view["target"]["key"], &view["target"]["title"]), (&json!("KIW-1"), &json!("Caller")));
        assert_eq!(view["trigger"], json!({"kind": "daily", "time": "09:00", "weekdays": ["mon", "fri"]}));
        assert_eq!(view["action"]["task_id"], json!(caller.id));
        assert_eq!(automations(&s, "kiwicd").len(), 2);

        // An agent on another host has no thread here to ask in.
        let mut remote = webhook_args("Remote");
        remote["project_id"] = json!("KIW");
        let err = call(&s, &ctx(&p), "create_automation", remote).await.unwrap_err();
        assert!(err.contains("creating the automation \"Remote\" needs the user's approval"), "{err}");
        assert_eq!(automations(&s, "kiwicd").len(), 2);
    });
}

#[test]
fn agents_change_run_and_delete_automations() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "kiwicd", "KIW");
        let caller = task(&s, "kiwicd", "Caller");
        let me = |call_id: &str| Ctx { task: Some(caller.clone()), call_id: Some(call_id.into()), ..ctx(&p) };
        let body = json!({"name": "Weekly", "trigger": {"kind": "interval", "every_minutes": 60}, "action": {"kind": "create_task", "title": "Update deps {{date}}"}});
        let a = crate::automations::create(&s, "kiwicd", body.as_object().unwrap()).unwrap();
        let get = || crate::automations::get(&s.db(), &a.id).unwrap().unwrap();

        // Turning it off or renaming it isn't asked about.
        let res = call(&s, &me("c1"), "update_automation", json!({"automation_id": "weekly", "enabled": false, "name": "Weekly deps"})).await.unwrap();
        assert_eq!((&res["enabled"], &res["name"]), (&json!(false), &json!("Weekly deps")));
        assert!(permissions::pending_approvals(&s, true, true).unwrap().is_empty());
        assert!(call(&s, &me("c2"), "update_automation", json!({"automation_id": a.id, "enabled": false})).await.unwrap_err().contains("nothing to change"));
        // Turning it on is.
        let c3 = me("c3");
        let (res, asked) = tokio::join!(call(&s, &c3, "update_automation", json!({"automation_id": a.id, "enabled": true})), answer_approval(&s, false));
        assert!(res.unwrap_err().contains("didn't approve changing the automation \"Weekly deps\""));
        assert!(!get().enabled);
        assert_eq!(asked["input"]["changes"], json!(["enabled"]));
        // So is a new action; only what it changes is changed, though the user renames it meanwhile.
        let c4 = me("c4");
        let change = json!({"automation_id": a.id, "name": "Weekly deps", "action": {"kind": "create_task", "title": "Bump deps", "status": "backlog"}});
        let approve = async {
            let asked = approval_asked(&s).await;
            crate::automations::update(&s, &a.id, json!({"name": "Deps"}).as_object().unwrap()).unwrap();
            answer_approval(&s, true).await;
            asked
        };
        let (res, asked) = tokio::join!(call(&s, &c4, "update_automation", change), approve);
        res.unwrap();
        let input = &asked["input"];
        assert_eq!((&input["op"], &input["changes"]), (&json!("update"), &json!(["action"])));
        assert_eq!((&input["before"]["action"]["title"], &input["automation"]["action"]["title"]), (&json!("Update deps {{date}}"), &json!("Bump deps")));
        assert_eq!(input["automation"]["action"]["status"], json!("backlog"));
        let now = get();
        assert_eq!(now.name, "Deps");
        assert!(matches!(&now.action, crate::automations::Action::CreateTask { title, status, .. } if title == "Bump deps" && status == "backlog"));

        // Run now makes its task.
        let run = call(&s, &me("c5"), "run_automation", json!({"automation_id": "Deps"})).await.unwrap();
        assert_eq!(run["status"], "ok", "{run}");
        let made = db::get_task(&s.db(), run["task_id"].as_str().unwrap()).unwrap().unwrap();
        assert_eq!(made.title, "Bump deps");

        // Deleted by the user while an agent asks to change it: the question goes, and the call says so.
        let c6 = me("c6");
        let delete = async {
            approval_asked(&s).await;
            crate::automations::delete(&s, &a.id).unwrap();
        };
        let (res, _) = tokio::join!(call(&s, &c6, "update_automation", json!({"automation_id": a.id, "trigger": {"kind": "interval", "every_minutes": 30}})), delete);
        assert!(res.unwrap_err().contains("was deleted meanwhile"));
        assert!(permissions::pending_approvals(&s, true, true).unwrap().is_empty());

        // Deleting one is asked about too.
        let b = crate::automations::create(&s, "kiwicd", body.as_object().unwrap()).unwrap();
        let (c7, c8) = (me("c7"), me("c8"));
        let (res, asked) = tokio::join!(call(&s, &c7, "delete_automation", json!({"automation_id": b.id, "reason": "Not needed"})), answer_approval(&s, false));
        assert!(res.unwrap_err().contains("didn't approve deleting the automation \"Weekly\""));
        assert_eq!((&asked["input"]["op"], &asked["input"]["reason"]), (&json!("delete"), &json!("Not needed")));
        assert_eq!(automations(&s, "kiwicd").len(), 1);
        let flagged = db::get_task(&s.db(), &caller.id).unwrap().unwrap();
        assert_eq!(flagged.attention_reason.as_deref(), Some("Delete an automation?"));
        let (res, _) = tokio::join!(call(&s, &c8, "delete_automation", json!({"automation_id": "Weekly"})), answer_approval(&s, true));
        assert_eq!(res.unwrap()["deleted"], json!(true));
        assert!(automations(&s, "kiwicd").is_empty());
    });
}

#[test]
fn agents_only_reach_automations_on_boards_they_can_use() {
    testing::run(async || {
        let s = state();
        let me = insert_profile(&s.db(), "personal", &[], None).unwrap();
        let work = insert_profile(&s.db(), "work", &[], None).unwrap();
        project(&s, &me, "kiwicd", "KIW");
        project(&s, &work, "secret", "SEC");
        let body = json!({"name": "Nightly", "trigger": {"kind": "daily", "time": "02:00"}, "action": {"kind": "create_task", "title": "Nightly"}});
        let theirs = crate::automations::create(&s, "secret", body.as_object().unwrap()).unwrap();
        let caller = task(&s, "kiwicd", "Caller");
        let c = Ctx { task: Some(caller.clone()), call_id: Some("c1".into()), ..ctx(&me) };
        // Not found here, as if it weren't there (so linked hosts are asked instead).
        let not_found = async |tool: &str, args: Value| {
            let r = local(&s, &c, tool, &args).await;
            assert!(matches!(r, Err(ToolError::NotFound(_))), "{tool}: {:?}", r.map_err(msg));
        };
        not_found("list_automations", json!({"project_id": "SEC"})).await;
        not_found("list_automations", json!({"project_id": "work:SEC"})).await;
        not_found("create_automation", json!({"project_id": "SEC", "name": "x", "trigger": body["trigger"], "action": body["action"]})).await;
        for tool in ["update_automation", "delete_automation", "run_automation"] {
            let mut args = json!({"automation_id": theirs.id});
            if tool == "update_automation" {
                args["enabled"] = json!(false);
            }
            not_found(tool, args).await;
        }
        assert!(crate::automations::get(&s.db(), &theirs.id).unwrap().unwrap().enabled);
        assert!(crate::automations::runs(&s.db(), &theirs.id, 10).unwrap().is_empty());
        assert!(permissions::pending_approvals(&s, true, true).unwrap().is_empty());
        // A task of theirs can't be messaged from an automation here, by id either.
        let hidden = task(&s, "secret", "Hidden");
        let args = json!({"name": "x", "trigger": body["trigger"], "action": {"kind": "send_to_task", "task_id": hidden.id, "message": "hi"}});
        assert!(call(&s, &c, "create_automation", args).await.unwrap_err().contains(&format!("task {} not found in KIW", hidden.id)));
        // Once their board lets this profile's agents in, its automations are there to use.
        grant(&s, &work, &["personal"]);
        let list = call(&s, &c, "list_automations", json!({"project_id": "SEC"})).await.unwrap();
        assert_eq!(list["automations"][0]["id"], json!(theirs.id));
        // And a message still only goes to a task in the automation's own project.
        let args = json!({"name": "x", "trigger": body["trigger"], "action": {"kind": "send_to_task", "task_id": hidden.id, "message": "hi"}});
        assert!(call(&s, &c, "create_automation", args).await.unwrap_err().contains("its own project"));
        // Older hosts aren't sent automation calls.
        assert!(too_old("laptop", 66, "create_automation", &json!({})).is_some_and(|e| e.contains("without the automation tools")));
        assert!(too_old("laptop", 67, "list_automations", &json!({})).is_none());
    });
}

#[test]
fn an_automation_approval_cut_short_by_a_restart_is_still_waited_for() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        project(&s, &p, "kiwicd", "KIW");
        let caller = task(&s, "kiwicd", "Caller");
        let run = started_run(&s, &caller.id);
        let call = |id: &str, args: Value| McpCall { task_fields: true, run_id: run.id.clone(), call_id: id.into(), tool: "create_automation".into(), args };
        let cut_short = async |c: McpCall| assert!(tokio::time::timeout(std::time::Duration::from_millis(100), handle_mcp(&s, c)).await.is_err());
        let asks = || s.db().query_row("SELECT COUNT(*) FROM permission_requests WHERE kind='automation'", [], |r| r.get::<_, i64>(0)).unwrap();
        // The server restarts while the user is asked; retried (even with other arguments), the
        // call waits for the same answer and makes what it asked about, once.
        cut_short(call("c1", webhook_args("Triage"))).await;
        let (res, _) = tokio::join!(handle_mcp(&s, call("c1", webhook_args("Other"))), answer_approval(&s, true));
        assert_eq!(res.unwrap()["name"], "Triage");
        assert_eq!((asks(), automations(&s, "kiwicd").len()), (1, 1));
        assert_eq!(handle_mcp(&s, call("c1", webhook_args("Triage"))).await.unwrap()["name"], "Triage");
        assert_eq!(automations(&s, "kiwicd").len(), 1);
        // Denied before the retry: nothing is made.
        cut_short(call("c2", webhook_args("Second"))).await;
        answer_approval(&s, false).await;
        assert!(handle_mcp(&s, call("c2", webhook_args("Second"))).await.unwrap_err().contains("didn't approve"));
        assert_eq!(automations(&s, "kiwicd").len(), 1);
        // Approved before the retry: it may have been made as the server stopped, so it isn't made again.
        cut_short(call("c3", webhook_args("Third"))).await;
        answer_approval(&s, true).await;
        assert!(handle_mcp(&s, call("c3", webhook_args("Third"))).await.unwrap_err().contains("interrupted"));
        assert_eq!(automations(&s, "kiwicd").len(), 1);
        assert_eq!(asks(), 3);
    });
}
