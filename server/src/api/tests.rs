use super::*;
use tower::ServiceExt;

/// Status and body (JSON, or the text if it isn't) of a request to `app`.
pub(crate) async fn call(app: &Router, method: &str, path: &str) -> (u16, Value) {
    // The test state's token is empty.
    let req = Request::builder().method(method).uri(path).header("authorization", "Bearer ").body(axum::body::Body::empty()).unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status().as_u16();
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into())))
}

#[test]
fn unknown_api_routes_get_a_json_404_not_the_ui() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        // As in `serve`, which hands everything else to the UI.
        let app = router(s.clone()).fallback(|| async { "<!doctype html>" });
        assert_eq!(call(&app, "GET", "/board").await, (200, json!("<!doctype html>")));
        assert_eq!(call(&app, "GET", "/api/profiles").await, (200, json!([])));
        for (method, path, missing) in [
            ("GET", "/api/projects", "GET /api/projects"),
            ("POST", "/api/tasks?x=1", "POST /api/tasks"),
            ("GET", "/api/tasks/t1/nope", "GET /api/tasks/t1/nope"),
            ("GET", "/api/", "GET /api/"),
            ("GET", "/api", "GET /api"),
            // Through the hub, to this host.
            ("GET", "/api/h/h/projects", "GET /api/projects"),
            ("DELETE", "/api/h/h/profiles/p/nope", "DELETE /api/profiles/p/nope"),
        ] {
            assert_eq!(call(&app, method, path).await, (404, json!({"error": format!("no such API route: {missing}")})), "{method} {path}");
        }
        // A known route with the wrong method is still a 405.
        assert_eq!(call(&app, "DELETE", "/api/profiles").await, (405, json!({"error": "no such API route: DELETE /api/profiles"})));
        assert_eq!(call(&app, "DELETE", "/api/h/h/profiles").await, (405, json!({"error": "no such API route: DELETE /api/profiles"})));
    })
}

#[test]
fn threads_are_listed_whole_or_in_pages() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let app = router(s.clone());
        let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let t = db::NewTask { profile_id: &profile.id, project_id: None, kind: "task", title: "t", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let t = db::insert_task(&s.db(), t).unwrap();
        let add = |data: Value| db::insert_message(&s.db(), &t.id, "claude", &data).unwrap().id;
        let call_id = add(json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "a1", "name": "Agent", "input": {}}]}}));
        let ids: Vec<i64> = (0..4).map(|i| add(json!({"type": "assistant", "message": {"content": [{"type": "text", "text": i.to_string()}]}}))).collect();
        let ids_of = |v: &Value| v.as_array().unwrap().iter().map(|m| m["id"].as_i64().unwrap()).collect::<Vec<_>>();

        // Without paging, a list (as hosts before API 56 answer), here and through the hub.
        for base in ["/api", "/api/h/h"] {
            let (status, all) = call(&app, "GET", &format!("{base}/tasks/{}/messages", t.id)).await;
            assert_eq!((status, all.as_array().map(Vec::len)), (200, Some(5)));
        }
        // The latest page, with the subagent started before it.
        let (_, page) = call(&app, "GET", &format!("/api/h/h/tasks/{}/messages?limit=2", t.id)).await;
        assert_eq!((ids_of(&page["messages"]), &page["more"]), (ids[2..].to_vec(), &json!(true)));
        assert_eq!(ids_of(&page["subagents"]), [call_id]);
        // Older ones, and newer ones than a message, without it.
        let (_, page) = call(&app, "GET", &format!("/api/tasks/{}/messages?before={}&limit=2", t.id, ids[2])).await;
        assert_eq!((ids_of(&page["messages"]), &page["more"], &page["subagents"]), (vec![ids[0], ids[1]], &json!(true), &json!([])));
        let (_, page) = call(&app, "GET", &format!("/api/tasks/{}/messages?after={}", t.id, ids[1])).await;
        assert_eq!((ids_of(&page["messages"]), &page["more"], &page["subagents"]), (ids[2..].to_vec(), &json!(false), &json!([])));
        assert_eq!(call(&app, "GET", &format!("/api/tasks/{}/messages?limit=x", t.id)).await.0, 400);
    })
}

#[test]
fn checks_github_accounts() {
    assert_eq!(check_github_account(&json!(" octocat ")).unwrap(), json!("octocat"));
    assert_eq!(check_github_account(&json!("ghe.example.com/me")).unwrap(), json!("ghe.example.com/me"));
    assert_eq!(check_github_account(&json!("")).unwrap(), Value::Null);
    assert_eq!(check_github_account(&Value::Null).unwrap(), Value::Null);
    assert!(check_github_account(&json!("--user=x")).is_err());
    assert!(check_github_account(&json!(3)).is_err());
}

#[test]
fn profiles_keep_their_github_account() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let create = |b: Value| create_profile(State(s.clone()), Json(serde_json::from_value(b).unwrap()));
        let Json(p) = create(json!({"name": "work", "github_account": " work-me "})).await.unwrap();
        assert_eq!(p["github_account"], "work-me");
        assert_eq!(db::get_profile(&s.db(), p["id"].as_str().unwrap()).unwrap().unwrap().github_account.as_deref(), Some("work-me"));
        let Json(other) = create(json!({"name": "personal"})).await.unwrap();
        assert_eq!(other["github_account"], Value::Null);
        assert!(create(json!({"name": "bad", "github_account": "--user=x"})).await.is_err());
        let id = p["id"].as_str().unwrap().to_string();
        let update = |b: Value| update_profile(State(s.clone()), Path(id.clone()), Json(b.as_object().unwrap().clone()));
        assert_eq!(update(json!({"github_account": "ghe.example.com/me"})).await.unwrap().0["github_account"], "ghe.example.com/me");
        assert_eq!(update(json!({"github_account": ""})).await.unwrap().0["github_account"], Value::Null);
    })
}

#[test]
fn profiles_choose_reviewers_and_a_summarizer_that_projects_can_override() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let codex = db::insert_claude_config(&s.db(), "Codex", "", "codex").unwrap();
        let create = |b: Value| create_profile(State(s.clone()), Json(serde_json::from_value(b).unwrap()));
        let Json(p) = create(json!({"name": "work", "reviewers": [{"claude_config_id": codex.id, "model": " "}], "summarizer": {"model": "haiku"}})).await.unwrap();
        assert_eq!(p["reviewers"], json!([{"claude_config_id": codex.id, "model": null, "effort": null}]));
        assert_eq!(p["summarizer"], json!({"claude_config_id": null, "model": "haiku", "effort": null}));
        assert_eq!(create(json!({"name": "home"})).await.unwrap().0["reviewers"], json!([]));
        assert!(create(json!({"name": "bad", "reviewers": [{"claude_config_id": "nope"}]})).await.is_err());
        assert!(create(json!({"name": "bad", "summarizer": "haiku"})).await.is_err());
        let id = p["id"].as_str().unwrap().to_string();
        let np = db::NewProject { id: "pr", profile_id: &id, name: "x", key: "X", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
        db::insert_project(&s.db(), np).unwrap();
        let project = || db::get_project(&s.db(), "pr").unwrap().unwrap();
        let reviewers = || {
            let p = project();
            db::reviewers_for(&s.db(), &p).unwrap()
        };
        let summarizer = || {
            let p = project();
            db::summarizer_for(&s.db(), &p).unwrap()
        };
        let codex_reviewer = db::Reviewer { claude_config_id: Some(codex.id.clone()), ..Default::default() };
        let haiku = db::Reviewer { model: Some("haiku".into()), ..Default::default() };
        // A project with none of its own uses the profile's.
        assert_eq!(reviewers(), [codex_reviewer.clone()]);
        assert_eq!(summarizer(), haiku);
        // One with the defaults is a project's own choice, the task's config, over the profile's.
        let body = json!({"reviewers": [{}], "summarizer": {"claude_config_id": "", "model": null}});
        update_project_inner(&s, "pr", body.as_object().unwrap()).await.unwrap();
        assert_eq!(reviewers(), [db::Reviewer::default()]);
        assert_eq!(summarizer(), db::Reviewer::default());
        // Back to the profile's.
        update_project_inner(&s, "pr", json!({"reviewers": [], "summarizer": null}).as_object().unwrap()).await.unwrap();
        assert_eq!((project().reviewers, project().summarizer), (vec![], None));
        assert_eq!(reviewers(), [codex_reviewer]);
        // A profile's with just the defaults is none, which is the same.
        let update = |b: Value| update_profile(State(s.clone()), Path(id.clone()), Json(b.as_object().unwrap().clone()));
        let Json(p) = update(json!({"reviewers": [{"model": ""}], "summarizer": {}})).await.unwrap();
        assert_eq!((&p["reviewers"], &p["summarizer"]), (&json!([]), &Value::Null));
        assert_eq!(reviewers(), [db::Reviewer::default()]);
        assert_eq!(summarizer(), db::Reviewer::default());
        assert_eq!(update(json!({"summarizer": {"effort": "low"}})).await.unwrap().0["reviewers"], json!([]), "kept when other fields change");
        let seven = vec![json!({}); crate::review::MAX_REVIEWERS + 1];
        assert!(update(json!({"reviewers": seven})).await.is_err());
    })
}

#[test]
fn a_deleted_reviewer_config_doesnt_stop_saving_other_settings() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let gone = db::insert_claude_config(&s.db(), "Gone", "", "claude").unwrap();
        let other = db::insert_claude_config(&s.db(), "Other", "", "claude").unwrap();
        let spec = json!({"claude_config_id": gone.id, "model": "haiku", "effort": null});
        let both = json!({"name": "work", "reviewers": [spec], "summarizer": spec});
        let Json(p) = create_profile(State(s.clone()), Json(serde_json::from_value(both).unwrap())).await.unwrap();
        let id = p["id"].as_str().unwrap().to_string();
        let np = db::NewProject { id: "pr", profile_id: &id, name: "x", key: "X", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
        db::insert_project(&s.db(), np).unwrap();
        update_project_inner(&s, "pr", json!({"reviewers": [spec], "summarizer": spec}).as_object().unwrap()).await.unwrap();
        db::delete_claude_config(&s.db(), &gone.id).unwrap();
        // The forms send them unchanged with every save, as they were saved.
        let update = |b: Value| update_profile(State(s.clone()), Path(id.clone()), Json(b.as_object().unwrap().clone()));
        let Json(p) = update(json!({"name": "job", "reviewers": [spec], "summarizer": spec})).await.unwrap();
        assert_eq!((&p["name"], &p["reviewers"], &p["summarizer"]), (&json!("job"), &json!([spec]), &spec));
        let body = json!({"name": "y", "reviewers": [spec, {"claude_config_id": other.id}], "summarizer": spec});
        let project = update_project_inner(&s, "pr", body.as_object().unwrap()).await.unwrap();
        assert_eq!((project.name.as_str(), project.reviewers.len()), ("y", 2));
        // A project taking its own, starting from the profile's, keeps the profile's too.
        update_project_inner(&s, "pr", json!({"reviewers": [], "summarizer": null}).as_object().unwrap()).await.unwrap();
        let edited = json!({"claude_config_id": gone.id, "model": "sonnet", "effort": "low"});
        let project = update_project_inner(&s, "pr", json!({"reviewers": [edited]}).as_object().unwrap()).await.unwrap();
        assert_eq!(project.reviewers[0].model.as_deref(), Some("sonnet"));
        let project = update_project_inner(&s, "pr", json!({"summarizer": edited}).as_object().unwrap()).await.unwrap();
        assert_eq!(project.summarizer.unwrap().claude_config_id, Some(gone.id.clone()));
        // A config that was never saved there still has to exist.
        let unknown = json!({"claude_config_id": "nope"});
        assert!(update(json!({"summarizer": unknown})).await.is_err());
        assert!(update(json!({"reviewers": [unknown]})).await.is_err());
        assert!(update_project_inner(&s, "pr", json!({"summarizer": unknown}).as_object().unwrap()).await.is_err());
    })
}

#[test]
fn profiles_keep_their_clone_folder() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let create = |b: Value| create_profile(State(s.clone()), Json(serde_json::from_value(b).unwrap()));
        let Json(p) = create(json!({"name": "work", "clone_dir": " ~/src/work "})).await.unwrap();
        assert_eq!(p["clone_dir"], "~/src/work");
        let Json(p) = create(json!({"name": "personal"})).await.unwrap();
        assert_eq!((&p["clone_dir"], &p["asana_enabled"]), (&Value::Null, &json!(true)));
        assert_eq!(create(json!({"name": "home", "asana_enabled": false})).await.unwrap().0["asana_enabled"], false);
        for bad in [json!("src"), json!("~work"), json!(3)] {
            assert!(create(json!({"name": "bad", "clone_dir": bad})).await.is_err(), "{bad}");
        }
        let id = p["id"].as_str().unwrap().to_string();
        let update = |b: Value| update_profile(State(s.clone()), Path(id.clone()), Json(b.as_object().unwrap().clone()));
        assert_eq!(update(json!({"clone_dir": "/srv/repos"})).await.unwrap().0["clone_dir"], "/srv/repos");
        assert!(update(json!({"clone_dir": "repos"})).await.is_err());
        assert_eq!(update(json!({"name": "job"})).await.unwrap().0["clone_dir"], "/srv/repos", "kept when other fields change");
        let Json(p) = update(json!({"clone_dir": " "})).await.unwrap();
        assert_eq!(p["clone_dir"], Value::Null);
        assert_eq!(db::get_profile(&s.db(), &id).unwrap().unwrap().clone_dir_or_default(), "~/job");
    })
}

#[test]
fn profiles_connect_to_asana_and_search_it() {
    crate::testing::run(async || {
        crate::asana::tests::fake().await;
        let s = crate::testing::state();
        let app = router(s.clone());
        let p = db::insert_profile(&s.db(), "work", &[], None).unwrap();
        let update = |b: Value| update_profile(State(s.clone()), Path(p.id.clone()), Json(b.as_object().unwrap().clone()));
        let search = format!("/api/profiles/{}/asana/tasks?q=fix", p.id);
        let (status, body) = call(&app, "GET", &search).await;
        assert_eq!((status, body["error"].as_str()), (409, Some("the work profile isn't connected to Asana")));

        // A token Asana turns down isn't kept.
        let err = update(json!({"asana_token": "nope"})).await.unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert!(err.1.contains("didn't accept the token"), "{}", err.1);
        assert_eq!(db::get_profile(&s.db(), &p.id).unwrap().unwrap().asana_token, None);

        // One it takes is, with who it's for; the board sees only that.
        let Json(v) = update(json!({"asana_token": format!(" {} ", crate::asana::tests::TOKEN)})).await.unwrap();
        assert_eq!(v["asana_user"], "Ivy (ivy@example.com)");
        assert!(v.get("asana_token").is_none(), "{v}");
        assert_eq!(db::get_profile(&s.db(), &p.id).unwrap().unwrap().asana_token.as_deref(), Some(crate::asana::tests::TOKEN));
        let (_, list) = call(&app, "GET", "/api/profiles").await;
        assert!(!list.to_string().contains(crate::asana::tests::TOKEN));
        assert_eq!(update(json!({"name": "job"})).await.unwrap().0["asana_user"], "Ivy (ivy@example.com)", "kept when other fields change");

        let (status, found) = call(&app, "GET", &search).await;
        assert_eq!(status, 200);
        let names: Vec<&str> = found.as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["Fix signup", "Fix login"]);
        assert_eq!(found[0]["url"], "https://app.asana.com/0/1/1002");
        // Through the hub too, and a URL for a task the token can't see finds nothing.
        let (status, found) = call(&app, "GET", &format!("/api/h/h/profiles/{}/asana/tasks?q=https%3A%2F%2Fapp.asana.com%2F0%2F1%2F7777", p.id)).await;
        assert_eq!((status, found), (200, json!([])));

        // Turned off, it keeps its token but finds nothing, until it's turned on again.
        assert!(update(json!({"asana_enabled": "no"})).await.is_err());
        let Json(v) = update(json!({"asana_enabled": false})).await.unwrap();
        assert_eq!((&v["asana_enabled"], &v["asana_user"]), (&json!(false), &json!("Ivy (ivy@example.com)")));
        let (status, body) = call(&app, "GET", &search).await;
        assert_eq!((status, body["error"].as_str()), (409, Some("Asana is turned off for the job profile (Settings → Profiles)")));
        assert_eq!(update(json!({"name": "work"})).await.unwrap().0["asana_enabled"], false, "kept when other fields change");
        assert_eq!(update(json!({"asana_enabled": true})).await.unwrap().0["asana_enabled"], true);
        assert_eq!(call(&app, "GET", &search).await.0, 200);

        let Json(v) = update(json!({"asana_token": null})).await.unwrap();
        assert_eq!(v["asana_user"], Value::Null);
        assert_eq!(db::get_profile(&s.db(), &p.id).unwrap().unwrap().asana_token, None);
        assert_eq!(call(&app, "GET", &search).await.0, 409);
    })
}

#[test]
fn a_tasks_fields_are_checked_for_type_before_theyre_stored() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let p = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let project = NewProject { id: "pr", profile_id: &p.id, name: "Web", key: "WEB", repo_path: "/src/web", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
        let project = db::insert_project(&s.db(), project).unwrap();
        let t = create_task_inner(&s, &project.id, serde_json::from_value(json!({"title": "Fix it", "description": "How"})).unwrap()).unwrap();
        let set = async |v: Value| update_task_inner(&s, &t.id, v.as_object().unwrap()).await;
        for bad in [
            json!({"title": null}),
            json!({"title": ""}),
            json!({"title": "  "}),
            json!({"title": {"a": 1}}),
            json!({"title": 7}),
            json!({"description": 42}),
            json!({"description": ["x"]}),
            // Stored as text in a REAL or INTEGER column, these would make the row unreadable.
            json!({"position": "top"}),
            json!({"position": null}),
            json!({"use_worktree": "yes"}),
            json!({"use_worktree": 1}),
            json!({"model": 3}),
            json!({"base_branch": ["main"]}),
        ] {
            let err = set(bad.clone()).await.unwrap_err();
            assert_eq!(err.0, StatusCode::BAD_REQUEST, "{bad}: {}", err.1);
        }
        // Nothing stuck: the task reads back as it was, in every list.
        let t = db::get_task(&s.db(), &t.id).unwrap().unwrap();
        assert_eq!((t.title.as_str(), t.description.as_str(), t.position, t.use_worktree), ("Fix it", "How", t.position, false));
        assert_eq!(db::list_tasks_for_project(&s.db(), &project.id, "task").unwrap().len(), 1);
        assert_eq!(set(json!({"position": 2.5, "use_worktree": true, "model": "haiku", "base_branch": null})).await.unwrap().position, 2.5);
        let t = set(json!({"title": " Fixed ", "description": null})).await.unwrap();
        assert_eq!((t.title.as_str(), t.description.as_str()), ("Fixed", ""));
    })
}

#[test]
fn a_setting_of_the_wrong_type_is_refused_rather_than_cleared() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let set = async |v: Value| update_settings(State(s.clone()), Json(v.as_object().unwrap().clone())).await.map(|j| j.0);
        let out = set(json!({"default_model": "haiku", "default_effort": "high"})).await.unwrap();
        assert_eq!((out["default_model"].as_str(), out["default_effort"].as_str()), (Some("haiku"), Some("high")));
        for bad in [json!({"default_model": 123}), json!({"default_permission_mode": 5}), json!({"default_effort": ["high"]}), json!({"scratch_host": true})] {
            let err = set(bad.clone()).await.unwrap_err();
            assert_eq!(err.0, StatusCode::BAD_REQUEST, "{bad}: {}", err.1);
        }
        let out = set(json!({})).await.unwrap();
        assert_eq!((out["default_model"].as_str(), out["default_effort"].as_str()), (Some("haiku"), Some("high")), "nothing cleared");
        let out = set(json!({"default_model": null, "default_effort": ""})).await.unwrap();
        assert!(out["default_model"].is_null() && out["default_effort"].is_null(), "null and blank clear: {out}");
    })
}

#[test]
fn tasks_link_to_asana_tasks() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let p = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let project = NewProject { id: "pr", profile_id: &p.id, name: "Web", key: "WEB", repo_path: "/src/web", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
        let project = db::insert_project(&s.db(), project).unwrap();
        let link = |id: &str, title: &str| json!({"provider": "asana", "id": id, "url": format!("https://app.asana.com/0/1/{id}"), "title": title});
        let body = |v: Value| serde_json::from_value::<CreateTask>(v).unwrap();

        let t = create_task_inner(&s, &project.id, body(json!({"title": "Fix it", "external_links": [link("1002", " Fix signup ")]}))).unwrap();
        assert_eq!(t.external_links, vec![db::ExternalLink { provider: "asana".into(), id: "1002".into(), url: "https://app.asana.com/0/1/1002".into(), title: "Fix signup".into() }]);
        assert!(create_task_inner(&s, &project.id, body(json!({"title": "x", "external_links": [{"provider": "jira", "id": "1", "url": "https://x"}]}))).is_err());
        let scratch = create_scratch_task_inner(&s, &p.id, body(json!({"title": "Ask", "external_links": [link("1", "One")]}))).unwrap();
        assert_eq!(scratch.external_links.len(), 1);
        assert!(create_task_inner(&s, &project.id, body(json!({"title": "Plain"}))).unwrap().external_links.is_empty());

        // Each task once, and only with an id and a web link.
        let set = async |v: Value| update_task_inner(&s, &t.id, json!({"external_links": v}).as_object().unwrap()).await;
        let t = set(json!([link("1002", "Fix signup"), link("2001", "Write docs"), link("1002", "again")])).await.unwrap();
        assert_eq!(t.external_links.iter().map(|l| l.id.as_str()).collect::<Vec<_>>(), ["1002", "2001"]);
        for bad in [json!("x"), json!([{"provider": "asana", "id": "", "url": "https://x"}]), json!([{"provider": "asana", "id": "1", "url": "javascript:x"}])] {
            assert!(set(bad.clone()).await.is_err(), "{bad}");
        }
        assert!(set(json!((0..=db::MAX_LINKS).map(|i| link(&i.to_string(), "t")).collect::<Vec<_>>())).await.is_err());
        assert!(set(Value::Null).await.unwrap().external_links.is_empty());
    })
}

#[test]
fn cloning_adds_a_clone_thats_there_already_and_checks_what_it_can_first() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let dir = crate::testing::temp_dir();
        let clone = |b: Value| clone_project(State(s.clone()), Path(profile.id.clone()), Json(serde_json::from_value(b).unwrap()));
        let path = |name: &str| path_str(&dir.join(name));
        let message = |r: ApiResult<Json<Value>>| r.unwrap_err().1;

        assert!(message(clone(json!({"repo": "nope"})).await).contains("OWNER/REPO"));
        assert!(message(clone(json!({"repo": "o/r", "repo_path": "rel/r"})).await).contains("absolute"));
        // A folder that's in the way isn't cloned into, nor taken for a clone.
        std::fs::create_dir_all(dir.join("full")).unwrap();
        std::fs::write(dir.join("full/notes.txt"), "mine").unwrap();
        assert!(message(clone(json!({"repo": "o/r", "repo_path": path("full")})).await).contains("already exists"));
        assert_eq!(std::fs::read_to_string(dir.join("full/notes.txt")).unwrap(), "mine");

        // A clone of the repository there already is added as it is, named after the folder.
        let r = dir.join("r");
        std::fs::create_dir_all(&r).unwrap();
        worktree::git(&r, &["init", "-q"]).await.unwrap();
        worktree::git(&r, &["remote", "add", "origin", "git@github.com:o/r.git"]).await.unwrap();
        let Json(p) = clone(json!({"repo": "o/r", "repo_path": path("r"), "key": "rr"})).await.unwrap();
        assert_eq!((p["name"].as_str(), p["key"].as_str(), p["repo_path"].as_str()), (Some("r"), Some("RR"), Some(path("r").as_str())));
        // But only once.
        let again = message(clone(json!({"repo": "o/r", "repo_path": format!("{}/", path("r"))})).await);
        assert!(again.contains("already the project \"r\""), "{again}");
        // Its key is checked before cloning anything.
        let taken = message(clone(json!({"repo": "o/other", "repo_path": path("other"), "key": "RR"})).await);
        assert!(taken.contains("already has the key RR"), "{taken}");
        assert!(message(clone(json!({"repo": "o/other", "repo_path": path("other"), "key": "S"})).await).contains("scratch tasks"));
        assert!(!dir.join("other").exists());
        assert!(message(clone_project(State(s.clone()), Path("nope".into()), Json(serde_json::from_value(json!({"repo": "o/r"})).unwrap())).await).contains("profile"));
        std::fs::remove_dir_all(&dir).unwrap();
    })
}

#[test]
fn a_folder_being_cloned_into_waits_for_that_clone_and_isnt_added_twice() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let github = crate::github::tests::fake_github();
        let gh = path_str(&github.join("gh"));
        // Also as a path through a symlink to a folder above it, below which there's a folder
        // that isn't there until the clone makes it, and with the symlink after a folder that
        // isn't there and `..`.
        std::fs::create_dir_all(github.join("real")).unwrap();
        std::os::unix::fs::symlink(github.join("real"), github.join("alias")).unwrap();
        let paths = [("clones/slow", "clones/slow"), ("alias/new/slow", "real/new/slow"), ("missing/../alias/other/slow", "real/other/slow")];
        for (dest, folder) in paths {
            let dest = path_str(&github.join(dest));
            let clone = || clone_project_inner(&s, &profile.id, serde_json::from_value(json!({"repo": "o/slow", "repo_path": dest})).unwrap(), gh.clone());
            // The second comes while the first is cloning, with the folder a clone of it by then.
            let (first, second) = tokio::join!(clone(), async {
                tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                clone().await
            });
            let folder = path_str(&github.join(folder));
            let projects: Vec<db::Project> = db::list_projects(&s.db(), &profile.id).unwrap().into_iter().filter(|p| p.repo_path == folder).collect();
            assert_eq!(projects.len(), 1, "{dest}");
            assert_eq!(first.unwrap().id, projects[0].id);
            let err = second.unwrap_err();
            assert_eq!(err.0, StatusCode::CONFLICT, "{dest}: {}", err.1);
            assert!(err.1.contains("already the project \"slow\""), "{}", err.1);
        }
        std::fs::remove_dir_all(&github).unwrap();
    })
}

#[test]
fn tidies_agent_access() {
    assert_eq!(check_agent_access("work", &json!([" personal ", "work", "", "lab", "personal"])).unwrap(), ["lab", "personal"]);
    assert_eq!(check_agent_access("work", &json!(["lab", "*"])).unwrap(), ["*"]);
    assert!(check_agent_access("work", &json!("personal")).is_err());
}

#[test]
fn worktrees_start_once_the_folder_is_a_git_repo() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let dir = crate::testing::temp_dir().join("x");
        let b = CreateProject { name: "x".into(), repo_path: path_str(&dir), key: None, base_branch: None, use_worktrees: None };
        let p = create_project_inner(&s, &profile.id, b).await.unwrap();
        assert!(p.use_worktrees && !p.is_git);
        let task = |title: &str| CreateTask { title: title.into(), ..Default::default() };
        assert!(!create_task_inner(&s, &p.id, task("before")).unwrap().use_worktree);

        assert!(std::process::Command::new("git").arg("init").arg("-q").arg(&dir).status().unwrap().success());
        assert!(create_task_inner(&s, &p.id, task("after")).unwrap().use_worktree);
        std::fs::remove_dir_all(&dir).ok();
    })
}

#[test]
fn projects_turn_their_tasks_pull_requests_on_and_off() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let dir = crate::testing::temp_dir().join("x");
        let b = CreateProject { name: "x".into(), repo_path: path_str(&dir), key: None, base_branch: None, use_worktrees: None };
        let p = create_project_inner(&s, &profile.id, b).await.unwrap();
        assert!(p.pull_requests && p.subproject_pull_requests);
        let set = async |b: Value| update_project_inner(&s, &p.id, b.as_object().unwrap()).await;
        let p = set(json!({"subproject_pull_requests": false})).await.unwrap();
        assert!(p.pull_requests && !p.subproject_pull_requests);
        let p = set(json!({"pull_requests": false, "subproject_pull_requests": true})).await.unwrap();
        assert!(!p.pull_requests && p.subproject_pull_requests);
        for bad in [json!("no"), Value::Null, json!(0)] {
            assert!(set(json!({ "pull_requests": bad })).await.is_err());
        }
    })
}

#[test]
fn projects_watch_pull_requests_in_review_once_asked_to() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let dir = crate::testing::temp_dir().join("x");
        let b = CreateProject { name: "x".into(), repo_path: path_str(&dir), key: None, base_branch: None, use_worktrees: None };
        let p = create_project_inner(&s, &profile.id, b).await.unwrap();
        assert_eq!(p.watch_pull_requests, "off");
        let set = async |v: Value| update_project_inner(&s, &p.id, json!({ "watch_pull_requests": v }).as_object().unwrap()).await;
        for mode in ["failures", "all", "off"] {
            assert_eq!(set(json!(mode)).await.unwrap().watch_pull_requests, mode);
        }
        for bad in [json!("everything"), Value::Null, json!(true)] {
            assert!(set(bad).await.is_err());
        }
        std::fs::remove_dir_all(&dir).ok();
    })
}

/// A git repository with a commit on master, and a project on it: (folder, project).
async fn git_project(s: &Shared) -> (PathBuf, db::Project) {
    let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
    let dir = crate::testing::temp_dir();
    let git = |args: &[&str]| assert!(std::process::Command::new("git").arg("-C").arg(&dir).args(["-c", "user.name=t", "-c", "user.email=t@t"]).args(args).status().unwrap().success());
    git(&["init", "-q", "-b", "master"]);
    git(&["commit", "-q", "--allow-empty", "-m", "first"]);
    let b = CreateProject { name: "x".into(), repo_path: path_str(&dir), key: Some("X".into()), base_branch: None, use_worktrees: None };
    (dir.clone(), create_project_inner(s, &profile.id, b).await.unwrap())
}

// HA-42: a relative worktrees_root put worktrees in the main checkout, and base branches weren't checked.
#[test]
fn worktree_settings_are_checked() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (dir, p) = git_project(&s).await;
        let set = async |v: Value| update_project_inner(&s, &p.id, v.as_object().unwrap()).await;
        for bad in [
            json!({"worktrees_root": "worktrees"}),
            json!({"worktrees_root": "./w"}),
            json!({"worktrees_root": path_str(&dir)}),
            json!({"worktrees_root": format!("{}/", path_str(&dir))}),
            json!({"worktrees_root": format!("{}/../{}", path_str(&dir), dir.file_name().unwrap().to_string_lossy())}),
            json!({"base_branch": "a..b"}),
            json!({"base_branch": "-x"}),
            json!({"base_branch": "@{-1}"}),
            json!({"base_branch": "with space"}),
            json!({"base_branch": "main.lock"}),
            json!({"base_branch": 3}),
        ] {
            let err = set(bad.clone()).await.unwrap_err();
            assert_eq!(err.0, StatusCode::BAD_REQUEST, "{bad}: {}", err.1);
        }
        let p2 = db::get_project(&s.db(), &p.id).unwrap().unwrap();
        assert_eq!((p2.worktrees_root.as_str(), p2.base_branch.as_deref()), (p.worktrees_root.as_str(), Some("master")));
        let inside = dir.join(".worktrees");
        let p2 = set(json!({"worktrees_root": path_str(&inside), "base_branch": " feature/x "})).await.unwrap();
        assert_eq!((p2.worktrees_root, p2.base_branch.as_deref()), (path_str(&inside), Some("feature/x")));
        assert_eq!(set(json!({"base_branch": ""})).await.unwrap().base_branch, None);

        // A task's too, which its agent may set.
        let t = create_task_inner(&s, &p.id, CreateTask { title: "x".into(), ..Default::default() }).unwrap();
        let task = async |v: Value| update_task_inner(&s, &t.id, v.as_object().unwrap()).await;
        for bad in ["a..b", "-x", "HEAD:x", "x~1"] {
            assert_eq!(task(json!({"base_branch": bad})).await.unwrap_err().0, StatusCode::BAD_REQUEST, "{bad}");
        }
        assert_eq!(task(json!({"base_branch": "release/1.2"})).await.unwrap().base_branch.as_deref(), Some("release/1.2"));
        assert_eq!(task(json!({"base_branch": " "})).await.unwrap().base_branch, None);
        let b = CreateProject { name: "y".into(), repo_path: path_str(&dir), key: Some("Y".into()), base_branch: Some("no..pe".into()), use_worktrees: None };
        assert_eq!(create_project_inner(&s, &p.profile_id, b).await.unwrap_err().0, StatusCode::BAD_REQUEST);
        std::fs::remove_dir_all(&dir).ok();
    })
}

// HA-42: setting up or tearing down a worktree checked only the task's own agent, not its reviewers'.
#[test]
fn a_worktree_isnt_torn_down_or_set_up_under_a_reviewer() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (dir, p) = git_project(&s).await;
        let t = create_task_inner(&s, &p.id, CreateTask { title: "x".into(), ..Default::default() }).unwrap();
        let t = worktree::setup(&s, &t.id).await.unwrap();
        let r = NewTask { profile_id: &t.profile_id, project_id: t.project_id.as_deref(), kind: "review", title: "Review", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let r = db::insert_task(&s.db(), r).unwrap();
        db::update_task(&s.db(), &r.id, &[("parent_id", json!(t.id)), ("running", json!(true))]).unwrap();
        let teardown = async || teardown_worktree(State(s.clone()), Path(t.id.clone()), None).await;
        assert_eq!(teardown().await.unwrap_err().0, StatusCode::CONFLICT);
        assert_eq!(setup_worktree(State(s.clone()), Path(t.id.clone())).await.unwrap_err().0, StatusCode::CONFLICT);
        assert!(std::path::Path::new(t.worktree_path.as_deref().unwrap()).exists());
        db::update_task(&s.db(), &r.id, &[("running", json!(false))]).unwrap();
        assert_eq!(teardown().await.unwrap().0["worktree_state"], "none");
        std::fs::remove_dir_all(&dir).ok();
    })
}

// HA-42: moved to Ready for merge where agents couldn't run, a task never joined the merge queue.
#[test]
fn ready_for_merge_queues_the_merge_even_before_agents_can_run() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (dir, p) = git_project(&s).await;
        let t = create_task_inner(&s, &p.id, CreateTask { title: "x".into(), ..Default::default() }).unwrap();
        let t = worktree::setup(&s, &t.id).await.unwrap();
        let wt = PathBuf::from(t.worktree_path.as_deref().unwrap());
        assert!(std::process::Command::new("git").arg("-C").arg(&wt).args(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "work"]).status().unwrap().success());
        assert!(!crate::runs::can_run_agents(&s));
        let t = update_task_inner(&s, &t.id, json!({"status": "ready_for_merge"}).as_object().unwrap()).await.unwrap();
        assert_eq!((t.status.as_str(), t.merging), ("ready_for_merge", true));
        assert_eq!(db::queued_merges(&s.db(), Some(&p.id), None).unwrap().len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    })
}

#[test]
fn a_folder_not_ready_for_worktrees_gets_one_setup_thread() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let dir = crate::testing::temp_dir().join("x");
        let b = CreateProject { name: "x".into(), repo_path: path_str(&dir), key: None, base_branch: None, use_worktrees: None };
        let p = create_project_inner(&s, &profile.id, b).await.unwrap();
        assert!(!p.is_git && !p.has_commits && p.setup_task_id.is_none());
        // This host can't run agents, so its agent doesn't start, but the thread is kept to try again from.
        let e = start_setup_thread_inner(&s, &p.id, StartSetupThread { message: "Use trunk".into() }).await.unwrap_err();
        assert!(e.1.contains("can't run agents"), "{}", e.1);
        let p = db::get_project(&s.db(), &p.id).unwrap().unwrap();
        let id = p.setup_task_id.clone().unwrap();
        let t = db::get_task(&s.db(), &id).unwrap().unwrap();
        assert_eq!((t.project_id.as_deref(), t.use_worktree, t.task_type.as_deref()), (Some(p.id.as_str()), false, None));
        assert!(t.description.contains("isn't a git repository yet") && t.description.contains(&p.repo_path), "{}", t.description);
        // Asked again (from another tab, say), it's the same thread.
        crate::runs::TEST_CAN_RUN.set(true);
        assert_eq!(start_setup_thread_inner(&s, &p.id, StartSetupThread::default()).await.unwrap().id, id);
        assert_eq!(db::list_tasks_for_project(&s.db(), &p.id, "task").unwrap().len(), 1);
        crate::runs::TEST_CAN_RUN.set(false);

        let git = |args: &[&str]| assert!(std::process::Command::new("git").arg("-C").arg(&dir).args(args).status().unwrap().success());
        git(&["init", "-q"]);
        let p = db::get_project(&s.db(), &p.id).unwrap().unwrap();
        assert!(p.is_git && !p.has_commits);
        git(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"]);
        assert!(db::get_project(&s.db(), &p.id).unwrap().unwrap().has_commits);
        // One that's ready gets no new thread.
        db::update_project(&s.db(), &p.id, &[("setup_task_id", Value::Null)]).unwrap();
        let e = start_setup_thread_inner(&s, &p.id, StartSetupThread::default()).await.unwrap_err();
        assert!(e.1.contains("ready for worktrees already"), "{}", e.1);
        std::fs::remove_dir_all(&dir).ok();
    })
}

#[test]
fn tasks_get_their_pull_requests_previews() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let p = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let project = NewProject { id: "pr", profile_id: &p.id, name: "Web", key: "WEB", repo_path: "/src/web", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
        let project = db::insert_project(&s.db(), project).unwrap();
        let body = |v: Value| serde_json::from_value::<CreateTask>(v).unwrap();
        let task = |title: &str| create_task_inner(&s, &project.id, body(json!({"title": title}))).unwrap().id;
        let update = async |id: &str, v: Value| update_task_inner(&s, id, v.as_object().unwrap()).await.unwrap();
        let set = async |v: Value| update_project_inner(&s, &project.id, json!({"pr_preview_url": v}).as_object().unwrap()).await;
        let preview = |id: &str| db::get_task(&s.db(), id).unwrap().unwrap().preview_url;
        let pr = |n: u32| json!(format!("https://github.com/o/web/pull/{n}"));

        // Before the project has one, from the pull requests they already had.
        let (open, own, done, none) = (task("Open"), task("Own"), task("Done"), task("No PR"));
        update(&open, json!({"pr_url": pr(4)})).await;
        update(&own, json!({"pr_url": pr(5), "preview_url": "https://staging.example.com/"})).await;
        update(&done, json!({"pr_url": pr(6), "status": "done"})).await;
        assert_eq!(preview(&open), None);
        for bad in [json!("https://pr.example.com/"), json!("pr{pr}.example.com"), json!(3)] {
            assert!(set(bad.clone()).await.is_err(), "{bad}");
        }
        assert_eq!(set(json!(" https://pr{pr}.example.com/b ")).await.unwrap().pr_preview_url.as_deref(), Some("https://pr{pr}.example.com/b"));
        assert_eq!(preview(&open).as_deref(), Some("https://pr4.example.com/b"));
        // One set otherwise stays, a done task's preview is gone, and without a PR there's none.
        assert_eq!(preview(&own).as_deref(), Some("https://staging.example.com/"));
        assert_eq!((preview(&done), preview(&none)), (None, None));

        // Its new pull request's, from then on.
        update(&none, json!({"pr_url": pr(7)})).await;
        assert_eq!(preview(&none).as_deref(), Some("https://pr7.example.com/b"));
        update(&none, json!({"pr_url": pr(8)})).await;
        assert_eq!(preview(&none).as_deref(), Some("https://pr8.example.com/b"));
        s.update_task(&task("Found"), &[("pr_url", pr(9))]).unwrap();
        let found = db::list_tasks_for_project(&s.db(), &project.id, "task").unwrap().into_iter().find(|t| t.title == "Found").unwrap();
        assert_eq!(found.preview_url.as_deref(), Some("https://pr9.example.com/b"));
        update(&none, json!({"pr_url": ""})).await;
        assert_eq!(preview(&none), None);
        update(&own, json!({"pr_url": pr(10)})).await;
        assert_eq!(preview(&own).as_deref(), Some("https://staging.example.com/"));
        // One given with it wins.
        update(&none, json!({"pr_url": pr(11), "preview_url": "https://mine.example.com/"})).await;
        assert_eq!(preview(&none).as_deref(), Some("https://mine.example.com/"));

        // Changing it moves those it made, and clearing it takes them off.
        set(json!("https://{pr}.preview.example.com/")).await.unwrap();
        assert_eq!(preview(&open).as_deref(), Some("https://4.preview.example.com/"));
        assert_eq!(preview(&own).as_deref(), Some("https://staging.example.com/"));
        assert_eq!(preview(&none).as_deref(), Some("https://mine.example.com/"));
        assert_eq!(set(json!("")).await.unwrap().pr_preview_url, None);
        assert_eq!((preview(&open), preview(&found.id)), (None, None));
        assert_eq!(preview(&own).as_deref(), Some("https://staging.example.com/"));
        update(&open, json!({"pr_url": pr(12)})).await;
        assert_eq!(preview(&open), None);
    })
}

#[test]
fn groups_projects() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let dir = crate::testing::temp_dir().join("x");
        let b = CreateProject { name: "x".into(), repo_path: path_str(&dir), key: None, base_branch: None, use_worktrees: None };
        let p = create_project_inner(&s, &profile.id, b).await.unwrap();
        assert_eq!(p.group_name, None);
        let set = async |v: Value| update_project_inner(&s, &p.id, json!({ "group_name": v }).as_object().unwrap()).await;
        assert_eq!(set(json!("  Work  ")).await.unwrap().group_name.as_deref(), Some("Work"));
        assert_eq!(db::get_project(&s.db(), &p.id).unwrap().unwrap().group_name.as_deref(), Some("Work"));
        assert_eq!(set(json!(" ")).await.unwrap().group_name, None);
        set(json!("Work")).await.unwrap();
        assert_eq!(set(Value::Null).await.unwrap().group_name, None);
        assert!(set(json!(3)).await.is_err());
        assert!(set(json!("x".repeat(101))).await.is_err());
        std::fs::remove_dir_all(&dir).ok();
    })
}

#[test]
fn scratch_tasks_are_in_no_project_and_work_in_their_own_folder() {
    crate::testing::run(async || {
        crate::runs::TEST_CAN_RUN.set(true);
        let s = crate::testing::state();
        let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let t = create_scratch_task_inner(&s, &profile.id, CreateTask::default()).unwrap();
        assert_eq!((t.title.as_str(), t.number, t.project_id.as_deref(), t.is_scratch()), ("New scratch task", 1, None, true));
        assert_eq!(runner::task_key_prefix(&s, &t), "S");
        let t2 = create_scratch_task_inner(&s, &profile.id, CreateTask { title: "Notes".into(), task_type: Some("scratch".into()), ..Default::default() }).unwrap();
        assert_eq!(t2.number, 2);
        assert_eq!(crate::documents::work_dir(&s, &t2), Some(crate::documents::dir(&s, &t2.id)));
        assert_eq!(runner::work_dir(&s, &t2).unwrap(), crate::documents::dir(&s, &t2.id));
        // It can have labels too, also given as a type as before API 71.
        let planned = create_scratch_task_inner(&s, &profile.id, CreateTask { task_type: Some("plan".into()), ..Default::default() }).unwrap();
        assert_eq!((planned.task_type.as_deref(), planned.labels.as_slice()), (Some("scratch"), ["plan".to_string()].as_slice()));
        for bad in [
            CreateTask { task_type: Some("essay".into()), ..Default::default() },
            CreateTask { labels: Some(json!(["essay"])), ..Default::default() },
            CreateTask { use_worktree: Some(true), ..Default::default() },
            CreateTask { subproject: Some(true), ..Default::default() },
            CreateTask { kind: Some("review".into()), ..Default::default() },
        ] {
            assert!(create_scratch_task_inner(&s, &profile.id, bad).is_err());
        }
        assert!(create_scratch_task_inner(&s, "nobody", CreateTask::default()).is_err());
        // Nothing to merge, so Ready for merge marks it done.
        let done = update_task_inner(&s, &t.id, json!({"status": "ready_for_merge"}).as_object().unwrap()).await.unwrap();
        assert_eq!((done.status.as_str(), done.merging), ("done", false));

        // No project can take the key its tasks use.
        let dir = crate::testing::temp_dir().join("x");
        let b = |key: Option<&str>| CreateProject { name: "Shop".into(), repo_path: path_str(&dir), key: key.map(String::from), base_branch: None, use_worktrees: None };
        let err = create_project_inner(&s, &profile.id, b(Some("s"))).await.unwrap_err();
        assert!(format!("{err:?}").contains("scratch tasks"), "{err:?}");
        let p = create_project_inner(&s, &profile.id, b(None)).await.unwrap();
        assert!(update_project_inner(&s, &p.id, json!({"key": "S"}).as_object().unwrap()).await.is_err());
        std::fs::remove_dir_all(&dir).ok();
        crate::runs::TEST_CAN_RUN.set(false);
    })
}

#[test]
fn archives_projects() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let dir = crate::testing::temp_dir();
        let new = |name: &str| CreateProject { name: name.into(), repo_path: path_str(&dir.join(name)), key: None, base_branch: None, use_worktrees: None };
        let p = create_project_inner(&s, &profile.id, new("x")).await.unwrap();
        let other = create_project_inner(&s, &profile.id, new("y")).await.unwrap();
        for id in [&p.id, &other.id] {
            update_project_inner(&s, id, json!({"group_name": "Shop"}).as_object().unwrap()).await.unwrap();
        }
        let task = create_task_inner(&s, &p.id, CreateTask { title: "t".into(), ..Default::default() }).unwrap();
        let set = async |v: Value| update_project_inner(&s, &p.id, json!({ "archived": v }).as_object().unwrap()).await;
        let listed = async |archived: bool| {
            let Json(v) = list_projects(State(s.clone()), Path(profile.id.clone()), Query(ProjectListQuery { archived })).await.unwrap();
            v.as_array().unwrap().iter().map(|p| p["name"].as_str().unwrap().to_string()).collect::<Vec<_>>()
        };
        assert_eq!(listed(false).await, ["x", "y"]);
        assert!(listed(true).await.is_empty());

        // Not while one of its agents is running.
        s.runs.lock().unwrap().insert(task.id.clone(), crate::state::RunHandle { run_id: "r".into(), cancel: None });
        let err = set(json!(true)).await.unwrap_err();
        assert!(err.1.contains("1 of the project's agents is running"), "{}", err.1);
        s.runs.lock().unwrap().clear();

        let archived = set(json!(true)).await.unwrap().archived_at.expect("archived");
        assert_eq!((listed(false).await, listed(true).await), (vec!["y".to_string()], vec!["x".to_string()]));
        // Out of its group, and no new tasks.
        assert_eq!(db::group_projects(&s.db(), &profile.id, "Shop").unwrap().iter().map(|p| &p.name).collect::<Vec<_>>(), ["y"]);
        let err = create_task_inner(&s, &p.id, CreateTask { title: "u".into(), ..Default::default() }).unwrap_err();
        assert!(err.1.contains("is archived"), "{}", err.1);
        // Archiving again keeps when it was archived.
        assert_eq!(set(json!(true)).await.unwrap().archived_at.as_deref(), Some(archived.as_str()));
        assert!(set(json!("yes")).await.is_err());

        assert_eq!(set(json!(false)).await.unwrap().archived_at, None);
        assert_eq!(listed(false).await, ["x", "y"]);
        create_task_inner(&s, &p.id, CreateTask { title: "u".into(), ..Default::default() }).unwrap();
        std::fs::remove_dir_all(&dir).ok();
    })
}

#[test]
fn a_done_task_can_be_given_when_it_was_done() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let new = db::NewTask { profile_id: &profile.id, project_id: None, kind: "task", title: "t", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let t = db::insert_task(&s.db(), new).unwrap();
        let set = |b: Value| {
            let (s, id) = (s.clone(), t.id.clone());
            async move { update_task_inner(&s, &id, b.as_object().unwrap()).await }
        };
        // Only a done task has one, and only a time will do.
        assert!(set(json!({"done_at": "2026-01-01T00:00:00Z"})).await.is_err());
        assert!(set(json!({"status": "done", "done_at": "yesterday"})).await.is_err());
        assert!(set(json!({"status": "done", "done_at": null})).await.is_err());
        assert_eq!(set(json!({"status": "todo"})).await.unwrap().done_at, None);
        // Moved into done with one, it keeps it, in UTC; a new one replaces it.
        let done = set(json!({"status": "done", "done_at": "2026-01-01T13:00:00+13:00"})).await.unwrap();
        assert_eq!(done.done_at.as_deref(), Some("2026-01-01T00:00:00.000Z"));
        assert_eq!(set(json!({"done_at": "2026-02-01T00:00:00Z"})).await.unwrap().done_at.as_deref(), Some("2026-02-01T00:00:00.000Z"));
        // Moving it out of done in the same request isn't allowed, and moving it out clears it.
        assert!(set(json!({"status": "in_review", "done_at": "2026-02-01T00:00:00Z"})).await.is_err());
        assert_eq!(set(json!({"status": "in_review"})).await.unwrap().done_at, None);
    })
}

#[test]
fn any_task_can_have_labels() {
    crate::testing::run(async || {
        crate::runs::TEST_CAN_RUN.set(true);
        let s = crate::testing::state();
        let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let dir = crate::testing::temp_dir();
        assert!(std::process::Command::new("git").arg("init").arg("-q").arg(&dir).status().unwrap().success());
        let b = CreateProject { name: "x".into(), repo_path: path_str(&dir), key: None, base_branch: None, use_worktrees: None };
        let p = create_project_inner(&s, &profile.id, b).await.unwrap();
        let labelled = |l: Value| CreateTask { title: "Draw it".into(), labels: Some(l), ..Default::default() };
        let typed = |t: &str| CreateTask { title: "Draw it".into(), task_type: Some(t.into()), ..Default::default() };
        let labels = |t: &db::Task| t.labels.iter().map(String::as_str).collect::<Vec<_>>().join(",");

        // A code task, in a worktree, with a plan and a diagram.
        let plan = create_task_inner(&s, &p.id, labelled(json!(["diagram", "plan"]))).unwrap();
        assert_eq!((plan.task_type.as_deref(), labels(&plan).as_str(), plan.use_worktree), (None, "plan,diagram", true));
        // A type that's a label, as before API 71, is that label.
        let old = create_task_inner(&s, &p.id, CreateTask { labels: Some(json!(["artifact"])), ..typed("plan") }).unwrap();
        assert_eq!((old.task_type.as_deref(), labels(&old).as_str(), old.use_worktree), (None, "plan,artifact", true));
        assert!(create_task_inner(&s, &p.id, typed("essay")).is_err());
        assert!(create_task_inner(&s, &p.id, labelled(json!(["essay"]))).is_err());
        assert!(create_task_inner(&s, &p.id, labelled(json!("plan"))).is_err());
        let sp = create_task_inner(&s, &p.id, CreateTask { subproject: Some(true), ..typed("plan") }).unwrap();
        assert_eq!((sp.subproject, labels(&sp).as_str()), (true, "plan"));
        assert!(create_task_inner(&s, &p.id, CreateTask { kind: Some("review".into()), ..typed("plan") }).is_err());
        assert_eq!(labels(&create_task_inner(&s, &p.id, typed(" ")).unwrap()), "");

        // Labels can be added and taken off.
        let set = |id: &str, b: Value| {
            let (s, id) = (s.clone(), id.to_string());
            async move { update_task_inner(&s, &id, b.as_object().unwrap()).await }
        };
        assert_eq!(labels(&set(&plan.id, json!({"labels": ["artifact", "plan"]})).await.unwrap()), "plan,artifact");
        assert!(set(&plan.id, json!({"labels": ["poem"]})).await.is_err());
        assert!(set(&plan.id, json!({"labels": "plan"})).await.is_err());
        assert_eq!(labels(&set(&plan.id, json!({"labels": []})).await.unwrap()), "");
        // A labelled task without changes has nothing to merge, as any task.
        set(&plan.id, json!({"labels": ["plan"], "use_worktree": false})).await.unwrap();
        let merged = set(&plan.id, json!({"status": "ready_for_merge"})).await.unwrap();
        assert_eq!(merged.status, "done");

        // A plan task from before labels (as the migration leaves it) still works in its own folder.
        let fields = [("labels", json!(["plan"])), ("use_worktree", json!(false)), ("work_dir", json!(format!("documents/{}", old.id)))];
        let old = db::update_task(&s.db(), &old.id, &fields).unwrap().unwrap();
        assert_eq!(runner::work_dir(&s, &old).unwrap(), crate::documents::dir(&s, &old.id));
        assert!(set(&old.id, json!({"use_worktree": true})).await.is_err());
        assert!(set(&old.id, json!({"subproject": true})).await.is_err());
        // The board keeps the document, so there's nothing to merge.
        let done = set(&old.id, json!({"status": "ready_for_merge"})).await.unwrap();
        assert_eq!((done.status.as_str(), done.resolution.as_deref(), done.merging), ("done", Some("done"), false));

        // A group task can have them too.
        update_project_inner(&s, &p.id, json!({"group_name": "Shop"}).as_object().unwrap()).await.unwrap();
        let b = CreateGroupTask { group: "Shop".into(), task: labelled(json!(["diagram"])) };
        let Json(g) = create_group_task(State(s.clone()), Path(profile.id.clone()), Json(b)).await.unwrap();
        assert_eq!((&g["task_type"], &g["labels"], g["group_name"].as_str()), (&Value::Null, &json!(["diagram"]), Some("Shop")));
        let b = CreateGroupTask { group: "Shop".into(), task: typed("poem") };
        assert!(create_group_task(State(s.clone()), Path(profile.id.clone()), Json(b)).await.is_err());
        let b = CreateGroupTask { group: "Shop".into(), task: typed("scratch") };
        assert!(create_group_task(State(s.clone()), Path(profile.id.clone()), Json(b)).await.is_err());

        // Its folder goes with it.
        let folder = crate::documents::dir(&s, &done.id);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("plan.html"), "<h1>Plan</h1>").unwrap();
        // So do its finished runs' folders; one still stopping is left for runs::prune.
        let run = |exit: bool| {
            let run = db::insert_run(&s.db(), &done.id, "prompt").unwrap();
            let dir = crate::runs::run_dir(&s, &run.id);
            std::fs::create_dir_all(&dir).unwrap();
            if exit {
                std::fs::write(dir.join("exit"), "{}").unwrap();
            }
            dir
        };
        let (finished, stopping) = (run(true), run(false));
        delete_one(&s, &done, false).await.unwrap();
        assert!(!folder.exists());
        assert!(!finished.exists() && stopping.exists());
        std::fs::remove_dir_all(&s.data_dir).ok();
        std::fs::remove_dir_all(&dir).ok();
        crate::runs::TEST_CAN_RUN.set(false);
    })
}

#[test]
fn tasks_made_from_one_prompt_share_a_fanout_id() {
    crate::testing::run(async || {
        crate::runs::TEST_CAN_RUN.set(true);
        let s = crate::testing::state();
        let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let dir = crate::testing::temp_dir();
        let b = CreateProject { name: "x".into(), repo_path: path_str(&dir), key: Some("WEB".into()), base_branch: None, use_worktrees: None };
        let p = create_project_inner(&s, &profile.id, b).await.unwrap();
        let fanned = |id: &str| CreateTask { title: "Look".into(), fanout_id: Some(id.into()), ..Default::default() };
        let a = create_task_inner(&s, &p.id, fanned("f-1")).unwrap();
        let b = create_task_inner(&s, &p.id, CreateTask { model: Some("opus".into()), ..fanned("f-1") }).unwrap();
        assert_eq!((a.fanout_id.as_deref(), b.fanout_id.as_deref()), (Some("f-1"), Some("f-1")));
        let scratch = create_scratch_task_inner(&s, &profile.id, CreateTask { title: "Ask".into(), fanout_id: Some("f_2".into()), ..Default::default() }).unwrap();
        assert_eq!(scratch.fanout_id.as_deref(), Some("f_2"));
        // On its own, or with a blank one, it has none.
        assert_eq!(create_task_inner(&s, &p.id, CreateTask { title: "Alone".into(), ..Default::default() }).unwrap().fanout_id, None);
        assert_eq!(create_task_inner(&s, &p.id, fanned(" ")).unwrap().fanout_id, None);
        // A group's plans made from one prompt are linked too.
        update_project_inner(&s, &p.id, json!({"group_name": "Shop"}).as_object().unwrap()).await.unwrap();
        let grouped = |id: &str| CreateGroupTask { group: "Shop".into(), task: CreateTask { task_type: Some("plan".into()), ..fanned(id) } };
        let Json(g) = create_group_task(State(s.clone()), Path(profile.id.clone()), Json(grouped("f-3"))).await.unwrap();
        assert_eq!((&g["labels"], g["fanout_id"].as_str()), (&json!(["plan"]), Some("f-3")));
        for bad in ["a b", "x/y", &"z".repeat(65)] {
            assert!(create_task_inner(&s, &p.id, fanned(bad)).is_err(), "{bad}");
            assert!(create_scratch_task_inner(&s, &profile.id, fanned(bad)).is_err(), "{bad}");
            assert!(create_group_task(State(s.clone()), Path(profile.id.clone()), Json(grouped(bad))).await.is_err(), "{bad}");
        }
    })
}

#[test]
fn scratch_tasks_and_subprojects_are_task_types_in_a_project() {
    crate::testing::run(async || {
        crate::runs::TEST_CAN_RUN.set(true);
        let s = crate::testing::state();
        let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let dir = crate::testing::temp_dir();
        assert!(std::process::Command::new("git").arg("init").arg("-q").arg(&dir).status().unwrap().success());
        let b = CreateProject { name: "x".into(), repo_path: path_str(&dir), key: Some("WEB".into()), base_branch: None, use_worktrees: None };
        let p = create_project_inner(&s, &profile.id, b).await.unwrap();
        let typed = |t: &str| CreateTask { title: "Look".into(), task_type: Some(t.into()), ..Default::default() };

        // A subproject is a type of task, though it's kept as the subproject flag.
        let sp = create_task_inner(&s, &p.id, typed("subproject")).unwrap();
        assert_eq!((sp.subproject, sp.task_type.as_deref(), sp.use_worktree), (true, None, true));

        // A scratch task in the project is numbered with its tasks and works in its own folder.
        let scratch = create_task_inner(&s, &p.id, typed("scratch")).unwrap();
        assert!(scratch.is_scratch());
        assert_eq!((scratch.project_id.as_deref(), scratch.number, scratch.use_worktree), (Some(p.id.as_str()), 2, false));
        assert_eq!(runner::task_key_prefix(&s, &scratch), "WEB");
        assert_eq!(runner::work_dir(&s, &scratch).unwrap(), crate::documents::dir(&s, &scratch.id));
        assert!(create_task_inner(&s, &p.id, CreateTask { use_worktree: Some(true), ..typed("scratch") }).unwrap().is_scratch());
        assert!(create_task_inner(&s, &p.id, CreateTask { subproject: Some(true), ..typed("scratch") }).is_err());

        // And in a subproject, where it isn't part of the subproject's work: its column
        // doesn't follow it, and the subproject merges without asking about it.
        let inner = create_task_inner(&s, &p.id, CreateTask { parent_id: Some(sp.id.clone()), ..typed("scratch") }).unwrap();
        assert_eq!((inner.parent_id.as_deref(), inner.use_worktree, inner.is_scratch()), (Some(sp.id.as_str()), false, true));
        s.update_task(&inner.id, &[("status", json!("in_progress"))]).unwrap();
        assert_eq!(db::get_task(&s.db(), &sp.id).unwrap().unwrap().status, "todo");
        assert!(create_task_inner(&s, &p.id, CreateTask { parent_id: Some(sp.id.clone()), ..typed("subproject") }).is_err());

        // Nothing to merge, so Ready for merge marks it done.
        let done = update_task_inner(&s, &scratch.id, json!({"status": "ready_for_merge"}).as_object().unwrap()).await.unwrap();
        assert_eq!((done.status.as_str(), done.merging), ("done", false));
        // Nor does its scratch task give the subproject anything to merge: never started, it's
        // done without a merge run (IA-129 review).
        let done = update_task_inner(&s, &sp.id, json!({"status": "ready_for_merge"}).as_object().unwrap()).await.unwrap();
        assert_eq!((done.status.as_str(), done.merging, done.running), ("done", false, false));
        std::fs::remove_dir_all(&dir).ok();
        crate::runs::TEST_CAN_RUN.set(false);
    })
}

#[test]
fn sets_a_script_per_status() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let dir = crate::testing::temp_dir().join("x");
        let b = CreateProject { name: "x".into(), repo_path: path_str(&dir), key: None, base_branch: None, use_worktrees: None };
        let p = create_project_inner(&s, &profile.id, b).await.unwrap();
        assert!(p.status_scripts.is_empty());
        let set = async |v: Value| update_project_inner(&s, &p.id, json!({ "status_scripts": v }).as_object().unwrap()).await;
        // Blank scripts are dropped.
        let p = set(json!({ "done": "make clean", "todo": "  " })).await.unwrap();
        assert_eq!(p.status_scripts, BTreeMap::from([("done".to_string(), "make clean".to_string())]));
        assert_eq!(db::get_project(&s.db(), &p.id).unwrap().unwrap().status_scripts, p.status_scripts);
        assert!(set(json!({ "finished": "x" })).await.is_err());
        assert!(set(json!({ "done": 3 })).await.is_err());
        assert!(set(json!("make clean")).await.is_err());
        assert!(set(Value::Null).await.unwrap().status_scripts.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    })
}

#[test]
fn deleting_a_running_task_lets_go_of_its_run() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let p = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let t = db::NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "t", description: "", status: "in_progress", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let task = db::insert_task(&s.db(), t).unwrap();
        let run = db::insert_run(&s.db(), &task.id, "prompt").unwrap();
        s.db().execute("UPDATE runs SET status='running' WHERE id=?1", [&run.id]).unwrap();
        let dir = crate::runs::run_dir(&s, &run.id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("out.jsonl"), "").unwrap();
        s.runs.lock().unwrap().insert(task.id.clone(), crate::state::RunHandle { run_id: run.id.clone(), cancel: None });
        delete_one(&s, &task, false).await.unwrap();
        // The agent exits after its task (and with it the run's row) is gone.
        runner::on_exit(&s, &run.id, None, Some(15), None, "");
        assert!(!s.is_running(&task.id));
    })
}

// HA-37: deleting a profile left its worktrees registered in their repositories, and its
// folders, runs and documents behind.
#[test]
fn deleting_a_profile_cleans_up_after_its_projects_and_threads() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let app = router(s.clone());
        let (dir, p) = git_project(&s).await;
        let t = create_task_inner(&s, &p.id, CreateTask { title: "x".into(), ..Default::default() }).unwrap();
        let t = worktree::setup(&s, &t.id).await.unwrap();
        let wt = t.worktree_path.clone().unwrap();
        let worktrees = || String::from_utf8(std::process::Command::new("git").arg("-C").arg(&dir).args(["worktree", "list"]).output().unwrap().stdout).unwrap();
        assert!(worktrees().contains(&wt));
        // A finished run, and a scratch task's documents.
        let run = db::insert_run(&s.db(), &t.id, "prompt").unwrap();
        s.db().execute("UPDATE runs SET status='exited' WHERE id=?1", [&run.id]).unwrap();
        let run_dir = crate::runs::run_dir(&s, &run.id);
        std::fs::create_dir_all(&run_dir).unwrap();
        std::fs::write(run_dir.join("exit"), "0").unwrap();
        let scratch = create_scratch_task_inner(&s, &p.profile_id, CreateTask::default()).unwrap();
        let docs = crate::documents::dir(&s, &scratch.id);
        std::fs::create_dir_all(&docs).unwrap();
        std::fs::write(docs.join("notes.md"), "x").unwrap();
        std::fs::create_dir_all(s.profile_scratch_dir(&p.profile_id)).unwrap();
        let project_dir = s.data_dir.join("projects").join(&p.id);
        assert!(project_dir.is_dir());

        assert_eq!(call(&app, "DELETE", &format!("/api/profiles/{}", p.profile_id)).await, (200, json!({"ok": true})));
        assert!(!worktrees().contains(&wt), "{}", worktrees());
        assert!(!std::path::Path::new(&wt).exists());
        assert!(!project_dir.exists() && !run_dir.exists() && !docs.exists());
        assert!(!s.data_dir.join("profiles").join(&p.profile_id).exists());
        assert!(db::get_task(&s.db(), &scratch.id).unwrap().is_none());
        // The branch is kept.
        assert!(std::process::Command::new("git").arg("-C").arg(&dir).args(["rev-parse", "--verify", "-q", t.branch.as_deref().unwrap()]).status().unwrap().success());
        assert_eq!(call(&app, "DELETE", &format!("/api/profiles/{}", p.profile_id)).await.0, 404);
        std::fs::remove_dir_all(&dir).ok();
    })
}

#[test]
fn deleting_a_project_keeps_its_folder_if_another_uses_it() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (dir, a) = git_project(&s).await;
        let (dir_b, b) = git_project(&s).await;
        let shared = s.data_dir.join("projects").join(&a.id).join("shared");
        update_project_inner(&s, &b.id, json!({"worktrees_root": path_str(&shared)}).as_object().unwrap()).await.unwrap();
        delete_project_inner(&s, &a.id).await.unwrap();
        assert!(s.data_dir.join("projects").join(&a.id).is_dir());
        delete_project_inner(&s, &b.id).await.unwrap();
        assert!(!s.data_dir.join("projects").join(&b.id).exists());
        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&dir_b).ok();
    })
}

#[test]
fn unknown_ids_get_a_404() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let app = router(s.clone());
        for (method, path) in [
            ("DELETE", "/api/profiles/nope"),
            ("DELETE", "/api/claude-configs/nope"),
            ("DELETE", "/api/tasks/nope/terminal"),
            ("POST", "/api/tasks/nope/terminal/keepalive?tool=x"),
            ("GET", "/api/projects/nope/tasks"),
        ] {
            assert_eq!(call(&app, method, path).await.0, 404, "{method} {path}");
        }
    })
}

// HA-37: a blank name made a profile's clone folder ~, and one renamed to another's took its grants.
#[test]
fn profile_names_are_required_and_unique() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let create = async |name: Value| create_profile(State(s.clone()), Json(serde_json::from_value(json!({"name": name})).unwrap())).await;
        let personal = create(json!(" personal ")).await.unwrap().0;
        assert_eq!(personal["name"], "personal");
        let work = create(json!("work")).await.unwrap().0;
        assert_eq!(create(json!("Personal")).await.unwrap_err().0, StatusCode::CONFLICT);
        assert_eq!(create(json!(" ")).await.unwrap_err().0, StatusCode::BAD_REQUEST);
        let rename = async |id: &Value, name: Value| update_profile(State(s.clone()), Path(id.as_str().unwrap().into()), Json(json!({"name": name}).as_object().unwrap().clone())).await;
        for (bad, status) in [(json!(""), StatusCode::BAD_REQUEST), (json!(" "), StatusCode::BAD_REQUEST), (json!(3), StatusCode::BAD_REQUEST), (Value::Null, StatusCode::BAD_REQUEST), (json!(" PERSONAL"), StatusCode::CONFLICT)] {
            assert_eq!(rename(&work["id"], bad.clone()).await.unwrap_err().0, status, "{bad}");
        }
        assert_eq!(db::get_profile(&s.db(), work["id"].as_str().unwrap()).unwrap().unwrap().name, "work");
        // Its own name in another case is fine.
        assert_eq!(rename(&personal["id"], json!("Personal")).await.unwrap().0["name"], "Personal");
        assert_eq!(rename(&work["id"], json!(" office ")).await.unwrap().0["name"], "office");
    })
}

// HA-47: two profiles named in different cases before HA-37 got a 409 on every save of either.
#[test]
fn profiles_sharing_a_name_in_another_case_can_still_be_saved() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let upper = db::insert_profile(&s.db(), "Work", &[], None).unwrap();
        let lower = db::insert_profile(&s.db(), "work", &[], None).unwrap();
        let save = async |id: &str, body: Value| update_profile(State(s.clone()), Path(id.into()), Json(body.as_object().unwrap().clone())).await;
        for p in [&upper, &lower] {
            let saved = save(&p.id, json!({"name": format!(" {} ", p.name), "default_model": "haiku"})).await.unwrap().0;
            assert_eq!((saved["name"].as_str(), saved["default_model"].as_str()), (Some(p.name.as_str()), Some("haiku")));
        }
        // A change of case is still checked.
        assert_eq!(save(&lower.id, json!({"name": "WORK"})).await.unwrap_err().0, StatusCode::CONFLICT);
        assert_eq!(save(&lower.id, json!({"name": "office"})).await.unwrap().0["name"], "office");
    })
}

// HA-47: deleting a profile removed its folder even with another project's worktrees in it.
#[test]
fn deleting_a_profile_keeps_its_folder_if_a_project_uses_it() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let gone = db::insert_profile(&s.db(), "gone", &[], None).unwrap();
        let folder = s.data_dir.join("profiles").join(&gone.id);
        std::fs::create_dir_all(folder.join("scratch")).unwrap();
        let (dir, p) = git_project(&s).await;
        s.db().execute("UPDATE projects SET worktrees_root=?1 WHERE id=?2", [&path_str(&folder.join("worktrees")), &p.id]).unwrap();
        let _ = delete_profile(State(s.clone()), Path(gone.id.clone())).await.unwrap();
        assert!(folder.is_dir());
        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&s.data_dir).ok();
    })
}

// HA-47: through a symlinked data dir, a used path that didn't exist yet didn't keep its folder.
#[test]
fn a_folder_is_kept_for_a_path_in_it_through_a_symlink() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let tmp = crate::testing::temp_dir();
        std::fs::create_dir_all(tmp.join("real/projects/x")).unwrap();
        std::os::unix::fs::symlink(tmp.join("real"), tmp.join("link")).unwrap();
        let dir = tmp.join("link/projects/x");
        let (repo, p) = git_project(&s).await;
        s.db().execute("UPDATE projects SET worktrees_root=?1 WHERE id=?2", [&path_str(&dir.join("worktrees")), &p.id]).unwrap();
        remove_unused_dir(&s, &dir, "project").unwrap();
        assert!(tmp.join("real/projects/x").is_dir());
        s.db().execute("UPDATE projects SET worktrees_root=?1 WHERE id=?2", [&path_str(&tmp.join("elsewhere")), &p.id]).unwrap();
        remove_unused_dir(&s, &dir, "project").unwrap();
        assert!(!tmp.join("real/projects/x").exists());
        std::fs::remove_dir_all(&repo).ok();
        std::fs::remove_dir_all(&tmp).ok();
    })
}

#[test]
fn claude_config_fields_must_be_strings() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let cfg = db::insert_claude_config(&s.db(), "c", "/claude/c", "claude").unwrap();
        for bad in [json!({"config_dir": 3}), json!({"config_dir": null}), json!({"name": false}), json!({"agent": 1})] {
            let res = update_claude_config(State(s.clone()), Path(cfg.id.clone()), Json(bad.as_object().unwrap().clone())).await;
            assert_eq!(res.unwrap_err().0, StatusCode::BAD_REQUEST, "{bad}");
        }
        assert_eq!(db::get_claude_config(&s.db(), &cfg.id).unwrap().unwrap().config_dir, "/claude/c");
        let res = update_claude_config(State(s.clone()), Path(cfg.id.clone()), Json(json!({"config_dir": ""}).as_object().unwrap().clone())).await;
        assert_eq!(res.unwrap().0["config_dir"], "");
    })
}

// HA-37: two moves to Ready for merge at once both started a merge.
#[test]
fn two_moves_to_ready_for_merge_at_once_queue_one_merge() {
    crate::testing::run(async || {
        let s = crate::testing::state();
        let (dir, p) = git_project(&s).await;
        let t = create_task_inner(&s, &p.id, CreateTask { title: "x".into(), ..Default::default() }).unwrap();
        let t = worktree::setup(&s, &t.id).await.unwrap();
        let wt = PathBuf::from(t.worktree_path.as_deref().unwrap());
        assert!(std::process::Command::new("git").arg("-C").arg(&wt).args(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "work"]).status().unwrap().success());
        let body = json!({"status": "ready_for_merge"});
        let (a, b) = tokio::join!(update_task_inner(&s, &t.id, body.as_object().unwrap()), update_task_inner(&s, &t.id, body.as_object().unwrap()));
        let codes: Vec<Option<StatusCode>> = [&a, &b].iter().map(|r| r.as_ref().err().map(|e| e.0)).collect();
        assert!(codes.contains(&None) && codes.contains(&Some(StatusCode::CONFLICT)), "{codes:?}");
        std::fs::remove_dir_all(&dir).ok();
    })
}

/// A task in project `p` with a commit to merge.
async fn task_with_work(s: &Shared, p: &db::Project, title: &str) -> db::Task {
    let t = create_task_inner(s, &p.id, CreateTask { title: title.into(), ..Default::default() }).unwrap();
    let t = worktree::setup(s, &t.id).await.unwrap();
    let wt = PathBuf::from(t.worktree_path.as_deref().unwrap());
    assert!(std::process::Command::new("git").arg("-C").arg(&wt).args(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "work"]).status().unwrap().success());
    t
}

/// Until the launch of `id`'s run is over: it fails, as there's no agent here.
async fn idle(s: &Shared, id: &str) {
    while s.is_running(id) {
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

/// The agent's run on `id` ends, having answered (after its launch here failed).
async fn run_ends(s: &Shared, id: &str) {
    idle(s, id).await;
    let run = db::insert_run(&s.db(), id, "prompt").unwrap();
    s.db().execute("UPDATE runs SET status='running', saw_result=1 WHERE id=?1", [&run.id]).unwrap();
    s.runs.lock().unwrap().insert(id.into(), crate::state::RunHandle { run_id: run.id.clone(), cancel: None });
    s.update_task(id, &[("running", json!(true))]).unwrap();
    crate::runner::on_exit(s, &run.id, Some(0), None, None, "");
}

fn last_prompt(s: &Shared, id: &str) -> String {
    let m = db::list_messages(&s.db(), id).unwrap().into_iter().rfind(|m| m.kind == "user").unwrap();
    m.data["text"].as_str().unwrap().to_string()
}

fn approval_cards(s: &Shared, id: &str) -> Vec<db::Message> {
    db::list_messages(&s.db(), id).unwrap().into_iter().filter(|m| m.kind == "question" && m.data["merge_approval"] == true).collect()
}

fn pick(choice: &str) -> crate::questions::Answer {
    crate::questions::Answer { choices: vec![choice.into()], text: None }
}

// HA-86: a merge waits for the user's approval of its agent's summary.
#[test]
fn a_merge_waits_for_the_users_approval_of_its_summary() {
    crate::testing::run(async || {
        crate::runs::TEST_CAN_RUN.set(true);
        let s = crate::testing::state();
        let (dir, p) = git_project(&s).await;
        db::update_profile(&s.db(), &p.profile_id, &[("merge_approval", json!(true))]).unwrap();
        let t = task_with_work(&s, &p, "a").await;
        let blocked = |id: &str| {
            let t = db::get_task(&s.db(), id).unwrap().unwrap();
            crate::merge_gate::blocked(&s.db(), &t).unwrap()
        };
        // Not merging, it can't merge either.
        assert!(blocked(&t.id).is_some());

        // Moved to Ready for merge, its agent summarises the merge, out of the merge queue.
        let t = update_task_inner(&s, &t.id, json!({"status": "ready_for_merge"}).as_object().unwrap()).await.unwrap();
        assert_eq!((t.status.as_str(), t.merging, t.merge_approval.as_deref(), t.running), ("ready_for_merge", true, Some("pending"), true));
        assert!(last_prompt(&s, &t.id).contains("Do not merge yet"), "{}", last_prompt(&s, &t.id));
        assert!(blocked(&t.id).unwrap().contains("hasn't approved"));
        let run = db::latest_run(&s.db(), &t.id, None).unwrap().unwrap();
        let gate = internal_merge_gate(State(s.clone()), Path(run)).await.unwrap().0;
        assert!(gate["blocked"].as_str().unwrap().starts_with("Merging is disabled"), "{gate}");
        assert!(db::active_merge(&s.db(), Some(&p.id), None).unwrap().is_none());

        // Once it's done, the user is asked.
        run_ends(&s, &t.id).await;
        let t = db::get_task(&s.db(), &t.id).unwrap().unwrap();
        assert_eq!((t.status.as_str(), t.merging, t.merge_approval.as_deref()), ("needs_attention", true, Some("pending")));
        let cards = approval_cards(&s, &t.id);
        assert_eq!((cards.len(), &cards[0].data["status"]), (1, &json!("pending")));
        // It doesn't hold the merge slot meanwhile: another task merges.
        let other = task_with_work(&s, &p, "b").await;
        db::update_task(&s.db(), &other.id, &[("status", json!("ready_for_merge")), ("merging", json!(true)), ("merge_approval", json!("approved"))]).unwrap();
        crate::runner::start_next_merge(&s, Some(&p.id));
        assert!(s.is_running(&other.id));
        assert!(last_prompt(&s, &other.id).contains("The user approved the merge."));
        idle(&s, &other.id).await;
        update_task_inner(&s, &other.id, json!({"status": "done"}).as_object().unwrap()).await.unwrap();

        // Approved, it merges.
        let t = crate::questions::answer(&s, &t.id, cards[0].id, pick("Approve")).unwrap();
        assert_eq!((t.status.as_str(), t.merging, t.merge_approval.as_deref(), t.running), ("ready_for_merge", true, Some("approved"), true));
        assert!(last_prompt(&s, &t.id).contains("The user approved the merge."), "{}", last_prompt(&s, &t.id));
        assert_eq!(approval_cards(&s, &t.id)[0].data["answer"]["choices"], json!(["Approve"]));
        assert_eq!(blocked(&t.id), None);
        assert!(crate::questions::answer(&s, &t.id, cards[0].id, pick("Deny")).is_err(), "answered once");
        // The run's gh server asks the board.
        let run = db::latest_run(&s.db(), &t.id, None).unwrap().unwrap();
        assert_eq!(internal_merge_gate(State(s.clone()), Path(run)).await.unwrap().0, json!({"blocked": null}));
        // Leaving the merge, it needs approving again.
        idle(&s, &t.id).await;
        let t = update_task_inner(&s, &t.id, json!({"status": "in_review"}).as_object().unwrap()).await.unwrap();
        assert_eq!(t.merge_approval, None);
        assert!(blocked(&t.id).is_some());
        crate::runs::TEST_CAN_RUN.set(false);
        std::fs::remove_dir_all(&dir).ok();
    })
}

// HA-86: denied, a merge goes back to review; moved again, it's summarised again.
#[test]
fn a_denied_merge_goes_back_to_review() {
    crate::testing::run(async || {
        crate::runs::TEST_CAN_RUN.set(true);
        let s = crate::testing::state();
        let (dir, p) = git_project(&s).await;
        // The project's setting wins over the profile's.
        db::update_profile(&s.db(), &p.profile_id, &[("merge_approval", json!(false))]).unwrap();
        update_project_inner(&s, &p.id, json!({"merge_approval": true}).as_object().unwrap()).await.unwrap();
        let t = task_with_work(&s, &p, "a").await;
        let to_merge = json!({"status": "ready_for_merge"});
        update_task_inner(&s, &t.id, to_merge.as_object().unwrap()).await.unwrap();
        // It can't step out of a queue it isn't in.
        let out = json!({"status": "in_progress", "remerge": true});
        assert_eq!(update_task_inner(&s, &t.id, out.as_object().unwrap()).await.unwrap_err().0, StatusCode::BAD_REQUEST);
        run_ends(&s, &t.id).await;
        let card = approval_cards(&s, &t.id)[0].id;
        let t = crate::questions::answer(&s, &t.id, card, pick("Deny")).unwrap();
        assert_eq!((t.status.as_str(), t.merging, t.merge_approval.as_deref(), t.running), ("in_review", false, None, false));

        // Moved there again while waiting, the old card goes and it's summarised again.
        update_task_inner(&s, &t.id, to_merge.as_object().unwrap()).await.unwrap();
        run_ends(&s, &t.id).await;
        update_task_inner(&s, &t.id, to_merge.as_object().unwrap()).await.unwrap();
        let t = db::get_task(&s.db(), &t.id).unwrap().unwrap();
        assert_eq!((t.status.as_str(), t.merge_approval.as_deref(), t.running), ("ready_for_merge", Some("pending"), true));
        let cards = approval_cards(&s, &t.id);
        assert_eq!(cards.iter().map(|c| c.data["status"].as_str().unwrap()).collect::<Vec<_>>(), ["answered", "replaced"]);
        assert_eq!(crate::questions::answer(&s, &t.id, cards[1].id, pick("Approve")).unwrap_err().0, StatusCode::CONFLICT);
        idle(&s, &t.id).await;

        // Turned off, merges go straight to the queue.
        update_project_inner(&s, &p.id, json!({"merge_approval": false}).as_object().unwrap()).await.unwrap();
        let u = task_with_work(&s, &p, "b").await;
        let u = update_task_inner(&s, &u.id, to_merge.as_object().unwrap()).await.unwrap();
        assert_eq!((u.merge_approval.as_deref(), u.running), (None, true));
        assert!(last_prompt(&s, &u.id).starts_with("The user moved this task to \"Ready for merge\". Merge branch"), "{}", last_prompt(&s, &u.id));
        idle(&s, &u.id).await;
        crate::runs::TEST_CAN_RUN.set(false);
        std::fs::remove_dir_all(&dir).ok();
    })
}
