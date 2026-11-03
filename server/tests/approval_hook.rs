//! `huntaway approval-hook`, the PreToolUse hook that holds the assistant's approval rules in Claude
//! runs, through the real binary: what it decides, and that it fails closed.

use std::io::Write;
use std::process::{Command, Output, Stdio};

use serde_json::{Value, json};

fn hook(rules: &str, input: &str) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_huntaway"))
        .args(["approval-hook", rules])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
    child.wait_with_output().unwrap()
}

fn decision(out: &Output) -> Option<String> {
    let v: Value = serde_json::from_slice(&out.stdout).ok()?;
    v["hookSpecificOutput"]["permissionDecision"].as_str().map(String::from)
}

const STRICT: &str = r#"[{"tool": "mcp__google__*send*", "decision": "ask"}, {"tool": "mcp__google__*delete*", "decision": "never"}]"#;

fn call(tool: &str) -> String {
    json!({"hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": {}}).to_string()
}

#[test]
fn the_hook_decides_by_the_rules() {
    for (tool, want) in [("mcp__google__send_mail", Some("ask")), ("mcp__google__delete_mail", Some("deny")), ("mcp__google__get_mail", None)] {
        let out = hook(STRICT, &call(tool));
        assert_eq!(out.status.code(), Some(0), "{tool}");
        assert_eq!(decision(&out).as_deref(), want, "{tool}");
    }
}

#[test]
fn the_hook_refuses_what_it_cant_check_while_rules_ask_or_refuse() {
    // Input it can't read, rules it can't read: refused, which exit code 2 is for a PreToolUse hook.
    for (rules, input) in [(STRICT, "not json"), (STRICT, "{}"), ("not rules", &call("mcp__google__get_mail"))] {
        let out = hook(rules, input);
        assert_eq!(out.status.code(), Some(2), "{rules} {input}");
        assert!(String::from_utf8_lossy(&out.stderr).contains("couldn't be checked"), "{}", String::from_utf8_lossy(&out.stderr));
    }
    // With only allow rules, the call is left to the run's own permissions.
    let out = hook(r#"[{"tool": "mcp__google__get*", "decision": "allow"}]"#, "not json");
    assert_eq!((out.status.code(), decision(&out)), (Some(0), None));
}
