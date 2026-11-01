//! Exercise the actual codex-run process against a deterministic app-server, without a model.
mod common;

use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::process::{Command, Stdio};

use serde_json::{Value, json};

#[test]
fn a_child_turn_cannot_finish_the_main_turn_or_acknowledge_its_steered_input() {
    let dir = common::TempDir::new("ia152-adapter");
    let fake = dir.join("codex");
    std::fs::write(&fake, include_str!("fixtures/codex-subagents.py")).unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o700)).unwrap();
    let log = dir.join("requests.jsonl");
    std::fs::write(dir.join("codex.json"), json!({"cwd": &*dir, "input": true, "approval_policy": "untrusted",
        "approvals_reviewer": "user", "sandbox": "workspace-write"}).to_string()).unwrap();
    std::fs::write(dir.join("mcp.json"), json!({"mcpServers": {"huntaway": {"command": "unused", "env": {
        "IA_URL": "http://127.0.0.1:1", "IA_TOKEN": "test", "IA_RUN_ID": "test"
    }}}}).to_string()).unwrap();
    // Bounds blocking reads too: a protocol regression must fail rather than hang cargo test.
    let mut child = Command::new("timeout").arg("20").arg(env!("CARGO_BIN_EXE_huntaway"))
        .arg("codex-run").arg(dir.join("codex.json")).env("IA_CODEX_BIN", &fake).env("IA_FAKE_CODEX_LOG", &log)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    let mut input = child.stdin.take().unwrap();
    writeln!(input, "{}", json!({"type": "user", "uuid": "initial", "message": {"content": "Inspect config"}})).unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut lines = Vec::<Value>::new();
    loop {
        let mut line = String::new();
        assert_ne!(output.read_line(&mut line).unwrap(), 0, "adapter exited before the child completed");
        let value: Value = serde_json::from_str(&line).unwrap();
        let done = value["method"] == "turn/completed" && value["params"]["threadId"] == "child";
        lines.push(value);
        if done { break }
    }
    writeln!(input, "{}", json!({"type": "user", "uuid": "steered", "message": {"content": "Also check env"}})).unwrap();
    drop(input);
    for line in output.lines() {
        lines.push(serde_json::from_str(&line.unwrap()).unwrap());
    }
    let status = child.wait().unwrap();
    let requests: Vec<Value> = std::fs::read_to_string(log).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    assert!(status.success(), "adapter exited with {status}");
    assert_eq!(requests.iter().filter(|v| v["method"] == "turn/start").count(), 1);
    assert_eq!(requests.iter().filter(|v| v["method"] == "turn/steer").count(), 1);
    let marker = lines.iter().position(|v| v["method"] == "warning").unwrap();
    let replay = lines.iter().position(|v| v["isReplay"] == true && v["uuid"] == "steered").unwrap();
    let main_item = lines.iter().position(|v| v["method"] == "item/started" && v["params"]["threadId"] == "main").unwrap();
    assert!(marker < replay && replay < main_item, "only the main agent's activity acknowledges its steering");
    for thread in ["child", "review", "compact"] {
        assert!(lines.iter().any(|v| v == &json!({"method": "thread/closed", "params": {"threadId": thread}})));
    }
}
