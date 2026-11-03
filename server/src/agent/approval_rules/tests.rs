use super::*;
use Decision::*;

fn rules(list: &[(&str, Decision)]) -> Rules {
    Rules { rules: list.iter().map(|(t, d)| rule(t, *d)).collect(), expiry_minutes: 30 }
}

fn decided(r: &Rules, tool: &str) -> Option<Decision> {
    r.decide(tool).map(|r| r.decision)
}

#[test]
fn a_rule_names_a_tool_a_server_or_a_pattern() {
    assert!(matches("Bash", "Bash"));
    assert!(!matches("Bash", "BashOutput"));
    assert!(matches("mcp__google__send_gmail_message", "mcp__google__send_gmail_message"));
    // A server's prefix is all its tools, and only its.
    assert!(matches("mcp__google", "mcp__google__send_gmail_message"));
    assert!(!matches("mcp__google", "mcp__googlemaps__search"));
    assert!(!matches("mcp__google__send", "mcp__google__send_gmail_message"));
    // Patterns, without regard to case.
    assert!(matches("mcp__google__*delete*", "mcp__google__delete_event"));
    assert!(matches("mcp__google__*Delete*", "mcp__google__gmail_deleteMessage"));
    assert!(matches("mcp__*__send*", "mcp__mail__send_now"));
    assert!(!matches("mcp__google__*delete*", "mcp__other__delete_event"));
    assert!(matches("*", "anything"));
    assert!(!matches("", "anything"));
    assert!(!matches("a*b", "acbd"));
    assert!(matches("a*b*", "acbd"));
}

#[test]
fn the_strongest_matching_rule_decides() {
    let r = rules(&[("mcp__google", Allow), ("mcp__google__*send*", Ask), ("mcp__google__*delete*", Never)]);
    assert_eq!(decided(&r, "mcp__google__search"), Some(Allow));
    assert_eq!(decided(&r, "mcp__google__send_mail"), Some(Ask));
    assert_eq!(decided(&r, "mcp__google__send_then_delete"), Some(Never));
    assert_eq!(decided(&r, "Bash"), None);
    // Questions and plans are the user's whatever the rules.
    let all = rules(&[("*", Never)]);
    assert_eq!(decided(&all, "AskUserQuestion"), None);
    assert_eq!(decided(&all, "ExitPlanMode"), None);
    assert_eq!(decided(&all, "request_user_input"), None);
}

#[test]
fn the_google_defaults_read_and_draft_ask_to_send_and_never_delete() {
    let r = Rules::default();
    let g = |t: &str| decided(&r, &format!("mcp__google__{t}"));
    for t in ["search_gmail_messages", "get_gmail_message_content", "list_calendars", "get_events", "search_drive_files", "get_drive_file_content", "draft_gmail_message", "list_drive_items", "get_drive_file_permissions"] {
        assert_eq!(g(t), Some(Allow), "{t}");
    }
    for t in [
        "send_gmail_message", "create_event", "modify_event", "delete_event", "share_drive_file", "modify_gmail_message_labels", "batch_modify_gmail_message_labels",
        "update_drive_permission", "manage_event", "update_drive_file", "create_gmail_filter", "transfer_drive_ownership", "manage_gmail_label",
    ] {
        assert_eq!(g(t), Some(Ask), "{t}");
    }
    for t in ["delete_gmail_message", "trash_gmail_message", "delete_drive_file", "trash_drive_file", "gmail_deleteMessage"] {
        assert_eq!(g(t), Some(Never), "{t}");
    }
    // Another server's tools, and the board's, are left to the thread's mode.
    assert_eq!(decided(&r, "mcp__other__send_gmail_message"), None);
    assert_eq!(decided(&r, "mcp__huntaway__create_task"), None);
    assert_eq!(r.expiry_minutes, 30);
}

#[test]
fn rules_are_tidied_and_checked_for_saving() {
    let r = rules(&[(" mcp__a ", Allow), ("", Ask), ("MCP__A", Never), ("mcp__b", Ask)]).checked().unwrap();
    assert_eq!(r.rules, vec![rule("mcp__a", Allow), rule("mcp__b", Ask)]);
    assert!(rules(&[("send mail", Ask)]).checked().is_err());
    assert!(Rules { expiry_minutes: MAX_EXPIRY_MINUTES + 1, ..rules(&[]) }.checked().is_err());
    let many: Vec<(String, Decision)> = (0..=MAX_RULES).map(|i| (format!("t{i}"), Ask)).collect();
    let many: Vec<(&str, Decision)> = many.iter().map(|(t, d)| (t.as_str(), *d)).collect();
    assert!(rules(&many).checked().is_err());
}

#[test]
fn plan_mode_takes_no_allow_rules() {
    let r = rules(&[("mcp__g__get*", Allow), ("mcp__g__send*", Ask), ("mcp__g__del*", Never)]);
    assert_eq!(decided(&r.for_mode("plan"), "mcp__g__get_mail"), None);
    assert_eq!(decided(&r.for_mode("plan"), "mcp__g__send_mail"), Some(Ask));
    assert_eq!(decided(&r.for_mode("default"), "mcp__g__get_mail"), Some(Allow));
}

fn call(tool: &str) -> Value {
    json!({"hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": {"to": "bob@example.com"}})
}

#[test]
fn the_hook_allows_asks_or_blocks_by_the_rules() {
    let r = rules(&[("mcp__g__get*", Allow), ("mcp__g__send*", Ask), ("mcp__g__del*", Never), ("mcp__huntaway__create_task", Ask)]);
    let out = |tool: &str| hook_decision(&r, &call(tool)).map(|v| v["hookSpecificOutput"]["permissionDecision"].as_str().unwrap().to_string());
    assert_eq!(out("mcp__g__get_mail").as_deref(), Some("allow"));
    assert_eq!(out("mcp__g__send_mail").as_deref(), Some("ask"));
    assert_eq!(out("mcp__g__delete_mail").as_deref(), Some("deny"));
    // Nothing to say about the rest, nor about the board's tools, which the board decides itself.
    assert_eq!(out("mcp__g__other"), None);
    assert_eq!(out("mcp__huntaway__create_task"), None);
    let deny = hook_decision(&r, &call("mcp__g__delete_mail")).unwrap();
    let reason = deny["hookSpecificOutput"]["permissionDecisionReason"].as_str().unwrap();
    assert!(reason.starts_with(&format!("{BLOCKED} (never: mcp__g__del*)")), "{reason}");
    assert_eq!(deny["hookSpecificOutput"]["hookEventName"], "PreToolUse");
}

#[test]
fn claude_gets_the_hook_the_prompt_tool_and_the_tools_that_are_never() {
    let r = rules(&[("mcp__g__get*", Allow), ("mcp__g__send_mail", Ask), ("mcp__g__delete_mail", Never), ("mcp__x", Never), ("mcp__g__*trash*", Never)]);
    let hook = claude_hook(std::path::Path::new("/opt/it's/huntaway"), &r).unwrap();
    assert_eq!(hook["matcher"], "mcp__.*");
    let command = hook["hooks"][0]["command"].as_str().unwrap();
    assert!(command.starts_with(r"'/opt/it'\''s/huntaway' approval-hook '"), "{command}");
    // The command's last argument is the rules, as the hook reads them back.
    // (Then what refuses the call if the hook can't run at all.)
    let (arg, fallback) = command.rsplit_once(" approval-hook ").unwrap().1.split_once(" || ").unwrap();
    assert!(fallback.ends_with("exit 2; }"), "{fallback}");
    let arg = arg.strip_prefix('\'').unwrap().strip_suffix('\'').unwrap().replace(r"'\''", "'");
    assert_eq!(serde_json::from_str::<Vec<Rule>>(&arg).unwrap(), r.rules);
    assert_eq!(claude_disallowed(&r), vec!["mcp__g__delete_mail".to_string(), "mcp__x".to_string()]);
    assert!(needs_prompt_tool(&r));
    // A rule for a tool that isn't MCP's widens the matcher.
    assert_eq!(claude_hook(std::path::Path::new("/h"), &rules(&[("Bash", Ask)])).unwrap()["matcher"], "*");
    // Rules only for the board's tools need no hook (the board holds them).
    let board = rules(&[("mcp__huntaway__create_task", Ask)]);
    assert!(claude_hook(std::path::Path::new("/h"), &board).is_none());
    assert!(!needs_prompt_tool(&board) && claude_disallowed(&board).is_empty());
    assert!(!needs_prompt_tool(&rules(&[("mcp__g__get*", Allow), ("mcp__g__x", Never)])));
}

#[test]
fn codex_asks_about_every_call_of_a_server_a_rule_may_match() {
    let r = rules(&[("mcp__g__get*", Allow), ("mcp__g__read_mail", Allow), ("mcp__g__send_mail", Ask), ("mcp__g__delete_mail", Never), ("mcp__off", Never)]);
    let mut g = json!({"command": "g", "default_tools_approval_mode": "approve", "disabled_tools": ["x"]}).as_object().unwrap().clone();
    assert!(codex_server(&r, "g", &mut g));
    assert_eq!(g["default_tools_approval_mode"], "prompt");
    assert_eq!(g["tools"], json!({"read_mail": {"approval_mode": "approve"}, "send_mail": {"approval_mode": "prompt"}}));
    assert_eq!(g["disabled_tools"], json!(["x", "delete_mail"]));
    // A server a never rule names is left out.
    assert!(!codex_server(&r, "off", &mut Map::new()));
    // One no rule may match is as it was.
    let mut other = json!({"command": "o"}).as_object().unwrap().clone();
    assert!(codex_server(&r, "other", &mut other));
    assert_eq!(Value::Object(other), json!({"command": "o"}));
    // A pattern may match any server's tools.
    let mut any = Map::new();
    assert!(codex_server(&rules(&[("*delete*", Never)]), "other", &mut any));
    assert_eq!(any["default_tools_approval_mode"], "prompt");
    // Only allow rules: nothing asks that didn't before.
    let mut allowed = Map::new();
    assert!(codex_server(&rules(&[("mcp__g__get_mail", Allow), ("mcp__g__list*", Allow)]), "g", &mut allowed));
    assert_eq!(Value::Object(allowed), json!({"tools": {"get_mail": {"approval_mode": "approve"}}}));
    // An exact allow that a stronger pattern overrules isn't approved up front.
    let mut overruled = Map::new();
    assert!(codex_server(&rules(&[("mcp__g__delete_draft", Allow), ("mcp__g__*delete*", Never)]), "g", &mut overruled));
    assert_eq!(overruled["tools"], json!({}));
    // The board's own server is the board's to hold.
    let mut board = Map::new();
    assert!(codex_server(&rules(&[("*", Never)]), "huntaway", &mut board));
    assert!(board.is_empty());
    assert!(codex_needs_user_reviewer(&r) && !codex_needs_user_reviewer(&rules(&[("mcp__g__get*", Allow)])));
}

#[test]
fn inputs_are_summed_up_in_a_line() {
    assert_eq!(summarize(&json!({"to": "bob@example.com", "subject": "Hi\nthere", "cc": null, "n": 3})), "n: 3, subject: Hi there, to: bob@example.com");
    let long = summarize(&json!({"body": "x".repeat(500)}));
    assert_eq!(long, format!("body: {}…", "x".repeat(80)));
    assert_eq!(summarize(&Value::Null), "");
    // A Codex prompt's: the arguments, not its question.
    assert_eq!(summarize(&json!({"message": "Allow the google MCP server to run tool \"send\"?", "arguments": {"to": "bob"}})), "to: bob");
}

#[test]
fn rules_hold_for_the_assistant_and_threads_under_it() {
    let s = crate::testing::state();
    let profile = db::insert_profile(&s.db(), "me", &Vec::<String>::new(), None).unwrap();
    let assistant = crate::agent::assistant::get_or_create(&s, &profile.id).unwrap();
    let new = |parent: Option<&str>| {
        let t = db::insert_task(&s.db(), db::NewTask {
            profile_id: &profile.id, project_id: None, kind: "task", title: "t", description: "", status: "todo", use_worktree: false, model: None,
            effort: None, claude_config_id: None,
        })
        .unwrap();
        match parent {
            Some(p) => db::update_task(&s.db(), &t.id, &[("parent_id", json!(p))]).unwrap().unwrap(),
            None => t,
        }
    };
    let (child, other) = (new(Some(&assistant.id)), new(None));
    assert!(for_task(&s.db(), &assistant).unwrap().is_some_and(|r| r == Rules::default()));
    assert!(applies_to(&s.db(), &child).unwrap());
    assert!(for_task(&s.db(), &other).unwrap().is_none());
    // Saved, they're the profile's; reset, the defaults again.
    let mine = rules(&[("mcp__g", Ask)]);
    set(&s.db(), &profile.id, Some(&mine)).unwrap();
    assert_eq!(for_task(&s.db(), &child).unwrap(), Some(mine));
    set(&s.db(), &profile.id, None).unwrap();
    assert_eq!(get(&s.db(), &profile.id).unwrap(), Rules::default());
}

#[test]
fn calls_the_hook_blocked_go_in_the_action_log() {
    let s = crate::testing::state();
    let profile = db::insert_profile(&s.db(), "me", &Vec::<String>::new(), None).unwrap();
    let task = crate::agent::assistant::get_or_create(&s, &profile.id).unwrap();
    let call = json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "toolu_1", "name": "mcp__google__delete_drive_file", "input": {"file_id": "f1"}}]}});
    s.add_message(&task.id, "claude", call).unwrap();
    let reason = blocked_reason("mcp__google__*delete*file*");
    let result = json!({"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": "toolu_1", "is_error": true, "content": reason},
        // Another tool's failure isn't a block.
        {"type": "tool_result", "tool_use_id": "toolu_2", "is_error": true, "content": [{"type": "text", "text": "exit 1"}]}
    ]}});
    on_tool_results(&s, &task, &result);
    // Not another tool's output that quotes the reason (mail about the rules, say), nor a board tool's
    // refusal, which the board logs itself.
    for (id, name) in [("toolu_3", "mcp__google__search_gmail_messages"), ("toolu_4", "mcp__huntaway__delete_task")] {
        let call = json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": id, "name": name, "input": {}}]}});
        s.add_message(&task.id, "claude", call).unwrap();
    }
    set(&s.db(), &profile.id, Some(&Rules { rules: [default_rules(), vec![rule("mcp__huntaway__delete_task", Never)]].concat(), expiry_minutes: 30 })).unwrap();
    let quoted = json!({"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": "toolu_3", "is_error": true, "content": format!("Subject: {reason}")},
        {"type": "tool_result", "tool_use_id": "toolu_4", "is_error": true, "content": blocked_reason("mcp__huntaway__delete_task")}
    ]}});
    on_tool_results(&s, &task, &quoted);
    let log = list(&s.db(), &profile.id, 10).unwrap();
    assert_eq!(log.len(), 1);
    let a = &log[0];
    assert_eq!(
        (a.tool_name.as_str(), a.summary.as_str(), a.rule.as_str(), a.decision.as_str(), a.outcome.as_str(), a.answered_by.as_deref()),
        ("mcp__google__delete_drive_file", "file_id: f1", "mcp__google__*delete*file*", "never", "blocked", Some("rule"))
    );
}

#[test]
fn codex_asks_about_its_own_tools_for_an_ask_rule_and_wont_run_with_a_never_rule() {
    assert_eq!(codex_own_tools(&Rules::default()), Ok(false));
    assert_eq!(codex_own_tools(&rules(&[("mcp__g__x", Never), ("Bash", Ask)])), Ok(true));
    assert_eq!(codex_own_tools(&rules(&[("Bash", Allow)])), Ok(false));
    for never in ["Bash", "*", "ApplyPatch"] {
        let err = codex_own_tools(&rules(&[(never, Never)])).unwrap_err();
        assert!(err.contains(&format!("\"{never}: never\"")) && err.contains("Claude config"), "{err}");
    }
}

#[test]
fn codex_runs_with_rules_on_its_own_tools_ask_whatever_their_mode() {
    let policy = |r: Option<&Rules>, mode: &str| codex_policy(r, crate::agent::codex::policy(mode, false));
    // No rules: as the mode has it.
    assert_eq!(policy(None, "bypassPermissions"), Ok(("never", "user", "danger-full-access")));
    assert_eq!(policy(None, "auto"), Ok(("on-request", "auto_review", "workspace-write")));
    // Rules for MCP tools only: the user answers rather than Codex's reviewer, the policy stays.
    let mcp = rules(&[("mcp__g__send*", Ask)]);
    assert_eq!(policy(Some(&mcp), "auto"), Ok(("on-request", "user", "workspace-write")));
    assert_eq!(policy(Some(&mcp), "bypassPermissions"), Ok(("never", "user", "danger-full-access")));
    // An ask rule on Bash: Codex asks about every command it doesn't take as safe, in Bypass too, and
    // without full access; in plan mode its sandbox stays read-only.
    let bash = rules(&[("Bash", Ask)]);
    for mode in ["bypassPermissions", "dontAsk", "auto", "acceptEdits", "default"] {
        assert_eq!(policy(Some(&bash), mode), Ok(("untrusted", "user", "workspace-write")), "{mode}");
    }
    assert_eq!(policy(Some(&bash), "plan"), Ok(("untrusted", "user", "read-only")));
    // Never on Bash: it doesn't run.
    assert!(policy(Some(&rules(&[("Bash", Never)])), "default").is_err());
}

#[test]
fn a_hook_that_cant_run_refuses_calls_while_rules_ask_or_refuse() {
    let run = |rules: &Rules| {
        let hook = claude_hook(std::path::Path::new("/nonexistent/huntaway"), rules).unwrap();
        let command = hook["hooks"][0]["command"].as_str().unwrap().to_string();
        std::process::Command::new("sh").args(["-c", &command]).stdin(std::process::Stdio::null()).output().unwrap()
    };
    let out = run(&rules(&[("mcp__g__send*", Ask)]));
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).trim().ends_with(HOOK_FAILED));
    // Only allow rules: nothing to refuse.
    assert_ne!(run(&rules(&[("mcp__g__get*", Allow)])).status.code(), Some(2));
}
