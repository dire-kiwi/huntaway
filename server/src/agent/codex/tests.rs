use super::*;

#[test]
fn rate_limit_windows_go_by_their_length() {
    let ids = |rl: Value| limits(&rl).into_iter().map(|l| (l.id, l.label)).collect::<Vec<_>>();
    let pair = |a: &str, b: &str| (a.to_string(), b.to_string());
    let w = |mins: Option<i64>| json!({"usedPercent": 10, "windowDurationMins": mins, "resetsAt": 1793521800});
    assert_eq!(ids(json!({"primary": w(Some(300)), "secondary": w(Some(10080))})), [pair("session", "Session"), pair("weekly", "Weekly")]);
    // A weekly-only plan's primary window is its weekly one.
    assert_eq!(ids(json!({"primary": w(Some(10080)), "secondary": null})), [pair("weekly", "Weekly")]);
    assert_eq!(ids(json!({"primary": w(None), "secondary": w(None)})), [pair("session", "Session"), pair("weekly", "Weekly")]);
    assert_eq!(ids(json!({"primary": w(Some(120)), "secondary": w(Some(43200))})), [pair("window:120", "2-hour"), pair("window:43200", "30-day")]);
}

#[test]
fn unwraps_shell_commands() {
    assert_eq!(display_command("/usr/bin/bash -lc 'ls -la && printf hi > hello.txt'"), "ls -la && printf hi > hello.txt");
    assert_eq!(display_command("/bin/zsh -lc 'echo '\\''hi'\\'''"), "echo 'hi'");
    assert_eq!(display_command("bash -c \"make\""), "make");
    assert_eq!(
        display_command(r#"/usr/bin/bash -lc "printf 'hi\\n' && git commit -m \"Add it\"""#),
        r#"printf 'hi\n' && git commit -m "Add it""#
    );
    assert_eq!(display_command("git status"), "git status");
    assert_eq!(display_command("python -c 'print(1)'"), "python -c 'print(1)'");
    assert_eq!(display_command(r#"/usr/bin/bash -lc "cat <<'EOF'
#"'!/bin/sh'"
EOF""#), "cat <<'EOF'\n#!/bin/sh\nEOF");
    assert_eq!(display_command("bash -lc 'a' 'b'"), "bash -lc 'a' 'b'");
}

#[test]
fn maps_permission_modes() {
    assert_eq!(policy("default", false), ("untrusted", "user", "workspace-write"));
    assert_eq!(policy("bypassPermissions", true), ("never", "user", "danger-full-access"));
    assert_eq!(policy("acceptEdits", true), ("never", "user", "read-only"));
    assert_eq!(policy("plan", false).2, "read-only");
}

#[test]
fn a_reviewer_writes_only_its_build_output_and_temp_directories() {
    let spec = |sandbox: &str, fs: &[(&str, &str)]| Spec {
        sandbox: sandbox.into(),
        approval_policy: "never".into(),
        writable_roots: vec!["/repo/.git".into()],
        filesystem: fs.iter().map(|(p, a)| (p.to_string(), a.to_string())).collect(),
        ..Default::default()
    };
    let p = thread_params(&spec("read-only", &[("/w", "read"), ("/w/target", "write"), ("/home/me/.npm", "write")]), Path::new("/w"), Map::new());
    assert_eq!(p.get("sandbox"), None);
    assert_eq!(p["config"].get("sandbox_workspace_write"), None);
    assert_eq!(p["config"]["default_permissions"], REVIEW_PROFILE);
    assert_eq!(
        p["config"]["permissions"][REVIEW_PROFILE],
        json!({
            "extends": ":read-only",
            "filesystem": {":tmpdir": "write", ":slash_tmp": "write", "/w": "read", "/w/target": "write", "/home/me/.npm": "write"},
            "network": {"enabled": true},
        })
    );
    // Without anything to write, or in another sandbox, it's the sandbox as given.
    let p = thread_params(&spec("read-only", &[]), Path::new("/w"), Map::new());
    assert_eq!((p["sandbox"].as_str(), p["config"].get("permissions")), (Some("read-only"), None));
    let p = thread_params(&spec("workspace-write", &[("/w/target", "write")]), Path::new("/w"), Map::new());
    assert_eq!(p["sandbox"], "workspace-write");
    assert_eq!(p["config"]["sandbox_workspace_write"], json!({"network_access": true, "writable_roots": ["/repo/.git"]}));
    assert_eq!(p["config"].get("default_permissions"), None);
}

#[test]
fn converts_mcp_servers() {
    let stdio = json!({"type": "stdio", "command": "x", "args": ["mcp"], "env": {"A": "1"}});
    assert_eq!(mcp_server_config("s", &stdio, false, &[], false).unwrap(), json!({"command": "x", "args": ["mcp"], "env": {"A": "1"}}));
    assert_eq!(mcp_server_config("s", &stdio, true, &[], false).unwrap()["default_tools_approval_mode"], "approve");
    let http = json!({"type": "http", "url": "https://h/mcp", "headers": {"Authorization": "Bearer t"}});
    assert_eq!(mcp_server_config("h", &http, false, &[], false).unwrap(), json!({"url": "https://h/mcp", "http_headers": {"Authorization": "Bearer t"}}));
    assert!(mcp_server_config("e", &json!({"type": "sse", "url": "u"}), false, &[], false).is_none());
    assert_eq!(mcp_server_config(MCP_SERVER_NAME, &json!({"command": "ia"}), false, &[], false).unwrap()["tool_timeout_sec"], 3900);
    assert_eq!(mcp_server_config("s", &stdio, false, &["w".into()], false).unwrap()["disabled_tools"], json!(["w"]));
    // In auto mode the board's tools stay approved but wait, which Codex's reviewer reviews.
    let board = mcp_server_config(MCP_SERVER_NAME, &json!({"command": "ia"}), false, &[], true).unwrap();
    assert_eq!((&board["default_tools_approval_mode"], &board["tools"]), (&json!("approve"), &json!({"wait": {"approval_mode": "prompt"}})));
    assert_eq!(mcp_server_config(MCP_SERVER_NAME, &json!({"command": "ia"}), false, &[], false).unwrap().get("tools"), None);
    assert_eq!(mcp_server_config("s", &stdio, true, &[], true).unwrap().get("tools"), None);
}

#[test]
fn asks_about_a_wait_codex_leaves_to_the_user_as_its_command() {
    crate::testing::run(async || {
        // A board that records the prompts it's asked and denies them.
        let asked = Arc::new(std::sync::Mutex::new(Vec::new()));
        let record = asked.clone();
        let app = axum::Router::new().route(
            "/api/internal/mcp",
            axum::routing::post(move |axum::Json(body): axum::Json<Value>| async move {
                record.lock().unwrap().push(body["args"].clone());
                axum::Json(json!({"result": {"behavior": "deny"}}))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await });
        let board = Arc::new(crate::mcp::Ctx::new(url, "t".into(), "r".into()));
        let elicit = async |tool: &str, params: Value| {
            let (tx, mut rx) = mpsc::unbounded_channel();
            let message = format!("Allow the {MCP_SERVER_NAME} MCP server to run tool \"{tool}\"?");
            let schema = json!({"type": "object", "properties": {}});
            let params = json!({"serverName": MCP_SERVER_NAME, "mode": "form", "message": message, "requestedSchema": schema, "_meta": {"tool_params": params}});
            answer(board.clone(), Responder(tx), json!({"id": 1, "method": "mcpServer/elicitation/request", "params": params}), None).await;
            serde_json::from_str::<Value>(&rx.recv().await.unwrap()).unwrap()["result"]["action"].clone()
        };

        // Codex asks only if its reviewer didn't take the call (see Spec::review_waits).
        assert_eq!(elicit("wait", json!({"reason": "waiting for CI", "command": " gh pr checks 1 "})).await, "decline");
        let prompt = json!({"command": "gh pr checks 1", "description": "Run while waiting: waiting for CI"});
        assert_eq!(*asked.lock().unwrap(), [json!({"tool_name": "Bash", "input": prompt, "tool_use_id": null})]);
        // A wait without a command, and the board's other tools, need no approval.
        assert_eq!(elicit("wait", json!({"seconds": 60, "command": ""})).await, "accept");
        assert_eq!(elicit("get_task", json!({"task": "IA-1"})).await, "accept");
        assert_eq!(asked.lock().unwrap().len(), 1);
        // Without its arguments, a wait is asked about as itself.
        assert_eq!(elicit("wait", Value::Null).await, "decline");
        assert_eq!(asked.lock().unwrap()[1]["tool_name"], format!("mcp__{MCP_SERVER_NAME}__wait"));
    });
}

#[test]
fn spots_claude_models() {
    assert!(is_claude_model("opus"));
    assert!(is_claude_model("claude-sonnet-5-5"));
    assert!(!is_claude_model("gpt-6.1-sol"));
}

#[test]
fn shows_items_as_tools() {
    let cmd = json!({"type": "commandExecution", "id": "e1", "command": "/usr/bin/bash -lc 'false'", "status": "completed", "exitCode": 1, "aggregatedOutput": "nope\n"});
    assert_eq!(tool_use(&cmd).unwrap().0, "Bash");
    assert_eq!(tool_output(&cmd), ("nope\n(exit code 1)".to_string(), true));
    let mcp = json!({"type": "mcpToolCall", "server": "huntaway", "tool": "get_task", "arguments": {"task_id": "IA-1"}, "status": "completed", "result": {"content": [{"type": "text", "text": "ok"}]}});
    assert_eq!(tool_use(&mcp).unwrap().0, "mcp__huntaway__get_task");
    assert_eq!(tool_output(&mcp), ("ok".to_string(), false));
    assert!(tool_use(&json!({"type": "userMessage"})).is_none());
}
