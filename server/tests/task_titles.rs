//! Exercise title generation and refresh through the real binary, not the unit-test model stub.
mod common;

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, Output};

use rusqlite::{Connection, params};
use serde_json::{Value, json};

fn check(dir: &Path, tasks: &[&str], mode: &str) -> Output {
    Command::new("timeout").arg("20").arg(env!("CARGO_BIN_EXE_huntaway"))
        .args(["title-check", "--db"]).arg(dir.join("board.db")).arg("--steps").args(tasks)
        .env("IA_CLAUDE_BIN", dir.join("agent")).env("IA_CODEX_BIN", dir.join("agent"))
        .env("IA_TITLE_LOG", dir.join("calls.jsonl")).env("IA_TITLE_MODE", mode)
        // Don't let the test inherit the running agent's login directory.
        .env_remove("CODEX_HOME").env_remove("CLAUDE_CONFIG_DIR")
        .output().unwrap()
}

#[test]
fn titles_use_the_tasks_runtime_and_login_for_generation_and_refresh() {
    let dir = common::TempDir::new("ia175-titles");
    std::fs::write(dir.join("agent"), include_str!("fixtures/task-titles.py")).unwrap();
    std::fs::set_permissions(dir.join("agent"), std::fs::Permissions::from_mode(0o700)).unwrap();
    // Opening title-check without task ids creates a current, isolated schema.
    assert!(check(&dir, &[], "success").status.success());
    let c = Connection::open(dir.join("board.db")).unwrap();
    c.execute_batch("INSERT INTO claude_configs (id,name,config_dir,agent,created_at) VALUES
        ('codex','Codex','~/.codex-title-test','codex','now'),
        ('default-codex','Default Codex','','codex','now'),
        ('claude','Claude','~/.claude-title-test','claude','now');
        INSERT INTO profiles (id,name,claude_config_ids,created_at) VALUES ('p','Test','[\"codex\"]','now');").unwrap();
    for (id, config) in [("inherited", None), ("default-codex", Some("default-codex")), ("override", Some("claude"))] {
        c.execute("INSERT INTO tasks (id,profile_id,title,description,claude_config_id,last_activity_at,created_at,updated_at)
            VALUES (?1,'p','Original title','Fix task naming',?2,'now','now','now')", params![id, config]).unwrap();
        c.execute("INSERT INTO messages (task_id,kind,data,created_at) VALUES (?1,'user',?2,'now')",
            params![id, json!({"text": "Also support Codex"}).to_string()]).unwrap();
    }
    let out = check(&dir, &["inherited", "default-codex", "override"], "success");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert_eq!(stdout.matches("description: Fix Codex task naming").count(), 2, "{stdout}");
    assert_eq!(stdout.matches("message 1 (Also support Codex): Fix Codex task naming").count(), 2, "{stdout}");
    assert!(stdout.contains("description: Fix the Claude title"), "{stdout}");
    let calls: Vec<Value> = std::fs::read_to_string(dir.join("calls.jsonl")).unwrap().lines()
        .map(|l| serde_json::from_str(l).unwrap()).collect();
    let homes: Vec<_> = calls.iter().filter(|v| v["agent"] == "codex").map(|v| v["home"].as_str().unwrap()).collect();
    let home = std::env::var("HOME").unwrap();
    assert_eq!(homes, [format!("{home}/.codex-title-test"), format!("{home}/.codex-title-test"),
        format!("{home}/.codex"), format!("{home}/.codex")]);
    let starts: Vec<_> = calls.iter().filter(|v| v["request"]["method"] == "thread/start")
        .map(|v| &v["request"]["params"]).collect();
    assert_eq!(starts.len(), 4);
    for p in &starts {
        assert_eq!(p["ephemeral"], true);
        assert_eq!(p["sandbox"], "read-only");
        assert_eq!(p["approvalPolicy"], "never");
        assert_eq!(p["config"]["mcp_servers"], json!({"user-tools": {"enabled": false}}));
    }
    assert!(starts[0]["baseInstructions"].as_str().unwrap().contains("write titles"));
    assert!(starts[1]["baseInstructions"].as_str().unwrap().contains("KEEP"));
    let turns: Vec<_> = calls.iter().filter(|v| v["request"]["method"] == "turn/start")
        .map(|v| v["request"]["params"]["input"][0]["text"].as_str().unwrap()).collect();
    assert!(turns[0].contains("<task>\nFix task naming"));
    assert!(turns[1].contains("<message>\nAlso support Codex"));
    for call in calls.iter().filter(|v| v["agent"] == "claude") {
        assert_eq!(call["home"], format!("{home}/.claude-title-test"));
        assert!(call["args"].as_array().unwrap().windows(2).any(|a| a == [json!("--model"), json!("haiku")]));
    }
    for mode in ["empty", "failed"] {
        let out = check(&dir, &["inherited"], mode);
        assert!(!out.status.success(), "{mode} must not produce a title");
        assert!(String::from_utf8_lossy(&out.stderr).contains(if mode == "empty" { "no title" } else { "test failure" }));
    }
    drop(c);
}
