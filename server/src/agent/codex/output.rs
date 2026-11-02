//! Codex's output turned into thread messages shaped like Claude Code's stream-json, subagents'
//! included.

use super::*;

fn assistant(content: Value) -> Value {
    json!({"type": "assistant", "message": {"role": "assistant", "content": content}, "parent_tool_use_id": null})
}

fn tool_result(id: &str, content: String, is_error: bool) -> Value {
    json!({
        "type": "user",
        "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": id, "content": truncate(&content, 30_000), "is_error": is_error}]},
        "parent_tool_use_id": null,
    })
}

/// A child keeps the same row across spawn, wait, follow-up and resumed runs. Its messages can
/// arrive before the spawn call returns, so use its thread id rather than the spawn's item id.
fn subagent_id(thread_id: &str) -> String {
    format!("codex-agent-{thread_id}")
}

pub(super) fn own_thread(params: &Value, session: Option<&str>) -> bool {
    params["threadId"].as_str().is_none_or(|id| session.is_some_and(|s| s == id))
}

fn thread_message(state: &Shared, task_id: &str, parent: Option<&str>, mut message: Value) -> Result<()> {
    message["parent_tool_use_id"] = json!(parent);
    state.add_message(task_id, "claude", message)?;
    Ok(())
}

fn subagent_started(state: &Shared, task_id: &str, session: Option<&str>, thread: &str, sender: Option<&str>, meta: Value) -> Result<()> {
    if Some(thread) == session {
        return Ok(());
    }
    let id = subagent_id(thread);
    let exists: bool = state.db().query_row(
        "SELECT EXISTS(SELECT 1 FROM messages WHERE task_id=?1 AND kind='claude'
         AND json_extract(data,'$.type')='assistant' AND json_extract(data,'$.message.content[0].id')=?2)",
        rusqlite::params![task_id, id], |r| r.get(0),
    )?;
    let parent = sender.filter(|s| Some(*s) != session).map(subagent_id);
    let prompt = meta["prompt"].as_str().unwrap_or("");
    let description = truncate(if prompt.is_empty() { meta["description"].as_str().unwrap_or("") } else { prompt }, 200);
    if !exists {
        let input = json!({"description": description, "prompt": prompt, "model": meta["model"], "subagent_type": meta["subagent_type"], "run_in_background": true});
        thread_message(state, task_id, parent.as_deref(), assistant(json!([{"type": "tool_use", "id": id, "name": "Agent", "input": input}])))?;
    }
    // Metadata can arrive after the row (thread/started and the spawn's completion can race).
    let mut started = json!({"type": "system", "subtype": "task_started", "tool_use_id": id, "task_id": thread,
        "prompt": prompt, "description": description, "model": meta["model"], "subagent_type": meta["subagent_type"], "is_backgrounded": true});
    if sender.is_some() {
        started["parent_tool_use_id"] = json!(parent);
    }
    state.add_message(task_id, "claude", started)?;
    Ok(())
}

fn subagent_status(state: &Shared, run: &Run, thread: &str, status: &str, summary: Option<&str>) -> Result<()> {
    let message = if status == "running" {
        json!({"type": "system", "subtype": "task_updated", "tool_use_id": subagent_id(thread), "patch": {"status": status}})
    } else {
        json!({"type": "system", "subtype": "task_notification", "tool_use_id": subagent_id(thread), "status": status,
            "summary": summary.map(|s| truncate(s, 30_000))})
    };
    let message = state.add_message(&run.task_id, "claude", message)?;
    crate::mcp::wait::subagent_finished(state, run, &message.data)?;
    Ok(())
}

/// The older collab tool items and newer hosted subAgentActivity items describe the same
/// children. Normalize both to the lifecycle used by Claude's Agent/Task calls.
fn subagent_item(state: &Shared, run: &Run, session: Option<&str>, params: &Value) -> Result<()> {
    let task_id = run.task_id.as_str();
    let item = &params["item"];
    let sender = item["senderThreadId"].as_str().or_else(|| params["threadId"].as_str());
    if item["type"] == "subAgentActivity" {
        let Some(thread) = item["agentThreadId"].as_str().filter(|id| Some(*id) != session) else { return Ok(()) };
        if item["kind"] == "started" {
            subagent_started(state, task_id, session, thread, sender, json!({"model": item["model"], "description": item["agentPath"]}))?;
        }
        let status = match item["kind"].as_str() {
            Some("started") => "running",
            Some("completed") => "completed",
            Some("interrupted") => "stopped",
            _ => return Ok(()),
        };
        return subagent_status(state, run, thread, status, None);
    }
    if item["type"] != "collabAgentToolCall" {
        return Ok(());
    }
    let tool = item["tool"].as_str().unwrap_or("");
    for thread in item["receiverThreadIds"].as_array().into_iter().flatten().filter_map(Value::as_str).filter(|id| Some(*id) != session) {
        if tool == "spawnAgent" && item["status"] != "failed" {
            subagent_started(state, task_id, session, thread, sender, json!({"prompt": item["prompt"], "model": item["model"]}))?;
        }
        if item["status"] != "failed" {
            let status = match tool {
                "resumeAgent" | "sendInput" | "followupTask" => Some("running"),
                "closeAgent" | "interruptAgent" => Some("stopped"),
                _ => None,
            };
            if let Some(status) = status {
                subagent_status(state, run, thread, status, None)?;
            }
        }
    }
    for (thread, status) in item["agentsStates"].as_object().into_iter().flatten() {
        if Some(thread.as_str()) == session {
            continue;
        }
        let normalized = match status["status"].as_str() {
            Some("pendingInit" | "running") => "running",
            Some("completed") => "completed",
            Some("errored" | "notFound") => "failed",
            Some("shutdown" | "interrupted") => "stopped",
            _ => continue,
        };
        subagent_status(state, run, thread, normalized, status["message"].as_str())?;
    }
    Ok(())
}

/// The tool call an item shows as: (name, input). None for items that aren't tool calls.
pub(super) fn tool_use(item: &Value) -> Option<(String, Value)> {
    Some(match item["type"].as_str()? {
        "commandExecution" => {
            ("Bash".into(), json!({"command": display_command(item["command"].as_str().unwrap_or("")), "cwd": item["cwd"]}))
        }
        "fileChange" => ("ApplyPatch".into(), json!({"changes": file_changes(Some(item))})),
        "mcpToolCall" => {
            let name = format!("{}__{}", crate::agent::agent_tools::tool_prefix(item["server"].as_str().unwrap_or("")), item["tool"].as_str().unwrap_or(""));
            (name, item["arguments"].clone())
        }
        "dynamicToolCall" => (item["tool"].as_str().unwrap_or("tool").to_string(), item["arguments"].clone()),
        "webSearch" => {
            let url = item["action"]["url"].as_str();
            match url {
                Some(u) => ("WebFetch".into(), json!({"url": u})),
                None => ("WebSearch".into(), json!({"query": item["query"]})),
            }
        }
        "imageView" => ("Read".into(), json!({"file_path": item["path"]})),
        // Spawning succeeds before the child finishes. Its row is created from the child's
        // thread, not from this short-lived tool call; other collab calls aren't new agents.
        "collabAgentToolCall" if item["tool"] == "spawnAgent" && item["status"] != "failed" => return None,
        "collabAgentToolCall" => (item["tool"].as_str().unwrap_or("collab").into(), json!({"prompt": item["prompt"], "receiver_thread_ids": item["receiverThreadIds"]})),
        _ => return None,
    })
}

/// Items whose call is shown when they start; the others only once they're done.
fn shown_at_start(kind: &str) -> bool {
    matches!(kind, "commandExecution" | "fileChange" | "mcpToolCall" | "dynamicToolCall" | "collabAgentToolCall")
}

/// What a finished tool item returned: (output, is_error).
pub(super) fn tool_output(item: &Value) -> (String, bool) {
    let status = item["status"].as_str().unwrap_or("completed");
    match item["type"].as_str().unwrap_or("") {
        "commandExecution" => {
            let mut out = item["aggregatedOutput"].as_str().unwrap_or("").to_string();
            let code = item["exitCode"].as_i64();
            if status == "declined" {
                return ("The command was declined.".into(), true);
            }
            if let Some(c) = code.filter(|c| *c != 0) {
                out.push_str(&format!("{}(exit code {c})", if out.is_empty() || out.ends_with('\n') { "" } else { "\n" }));
            }
            (out, status == "failed" || code.is_some_and(|c| c != 0))
        }
        "fileChange" => match status {
            "declined" => ("The change was declined.".into(), true),
            "failed" => ("The change couldn't be applied.".into(), true),
            _ => ("Applied.".into(), false),
        },
        "mcpToolCall" => {
            if let Some(e) = item["error"]["message"].as_str() {
                return (e.to_string(), true);
            }
            let text: Vec<String> = item["result"]["content"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|c| match c["text"].as_str() {
                    Some(t) => t.to_string(),
                    None => format!("[{}]", c["type"].as_str().unwrap_or("content")),
                })
                .collect();
            (text.join("\n"), status == "failed")
        }
        "dynamicToolCall" => {
            let text: Vec<String> =
                item["contentItems"].as_array().into_iter().flatten().filter_map(|c| c["text"].as_str().map(String::from)).collect();
            (text.join("\n"), item["success"] == false || status == "failed")
        }
        "webSearch" => {
            let n = item["results"].as_array().map(|r| r.len());
            (n.map(|n| format!("{n} results")).unwrap_or_default(), false)
        }
        "collabAgentToolCall" => (serde_json::to_string_pretty(&item["agentsStates"]).unwrap_or_default(), status == "failed"),
        _ => (String::new(), status == "failed"),
    }
}

/// Apply one line of a Codex run's output (an app-server notification).
pub fn handle_line(state: &Shared, run: &Run, v: &Value) -> Result<()> {
    let task_id = run.task_id.as_str();
    let p = &v["params"];
    let session = db::get_task(&state.db(), task_id)?.and_then(|t| t.session_id);
    let own = own_thread(p, session.as_deref());
    let parent = p["threadId"].as_str().filter(|_| !own).map(subagent_id);
    match v["method"].as_str().unwrap_or("") {
        "thread/started" => {
            let thread = &p["thread"];
            if let Some(id) = thread["id"].as_str() {
                // v2 uses subAgent; older notifications used subagent. Normalize both before
                // extracting a spawned thread's parent or excluding an internal subagent.
                let subagent = thread["source"].get("subAgent").or_else(|| thread["source"].get("subagent"));
                let source = &subagent.unwrap_or(&Value::Null)["thread_spawn"];
                let sender = thread["parentThreadId"].as_str().or_else(|| source["parent_thread_id"].as_str());
                if sender.is_some() {
                    let role = thread["agentRole"].as_str().or_else(|| source["agent_role"].as_str());
                    subagent_started(state, task_id, session.as_deref(), id, sender,
                        json!({"prompt": thread["preview"], "description": thread["agentNickname"], "subagent_type": role}))?;
                } else if subagent.is_none() && session.as_deref() != Some(id) {
                    state.update_task(task_id, &[("session_id", json!(id))])?;
                }
            }
        }
        "turn/started" if !own => {
            if let Some(thread) = p["threadId"].as_str() {
                subagent_status(state, run, thread, "running", None)?;
            }
        }
        "turn/started" => {
            // Where a rewind to before this turn takes the thread back to (see checkpoints::Rewind).
            if let Some(turn) = p["turn"]["id"].as_str() {
                state.db().execute("UPDATE runs SET agent_at=?1 WHERE id=?2", rusqlite::params![turn, run.id])?;
            }
            state.emit(json!({"type": "delta_reset", "task_id": task_id}));
        }
        "item/agentMessage/delta" if own => {
            if let Some(t) = p["delta"].as_str() {
                state.emit(json!({"type": "delta", "task_id": task_id, "text": t}));
            }
        }
        "item/started" => {
            let item = &p["item"];
            let kind = item["type"].as_str().unwrap_or("");
            // A tool call of its own thread means it's working again (see mcp/wait.rs). Hosted
            // subAgentActivity items are notifications, not the parent calling a tool.
            if own && (kind == "collabAgentToolCall"
                || tool_use(item).is_some_and(|(name, _)| !crate::mcp::wait::is_wait_tool(&name))) {
                crate::mcp::wait::resumed(state, task_id, &run.id);
            }
            if kind == "agentMessage" && own {
                state.emit(json!({"type": "delta_reset", "task_id": task_id}));
            } else if shown_at_start(kind) && !(kind == "collabAgentToolCall" && item["tool"] == "spawnAgent") {
                if let (Some(id), Some((name, input))) = (item["id"].as_str(), tool_use(item)) {
                    thread_message(state, task_id, parent.as_deref(), assistant(json!([{"type": "tool_use", "id": id, "name": name, "input": input}])))?;
                }
            }
        }
        "item/completed" => {
            let item = &p["item"];
            let kind = item["type"].as_str().unwrap_or("");
            let id = item["id"].as_str().unwrap_or("");
            subagent_item(state, run, session.as_deref(), p)?;
            match kind {
                "agentMessage" | "plan" => {
                    if own {
                        state.emit(json!({"type": "delta_reset", "task_id": task_id}));
                    }
                    if let Some(text) = item["text"].as_str().filter(|t| !t.trim().is_empty()) {
                        thread_message(state, task_id, parent.as_deref(), assistant(json!([{"type": "text", "text": text}])))?;
                    }
                }
                "reasoning" => {
                    let parts = |k: &str| -> Vec<String> { item[k].as_array().into_iter().flatten().filter_map(|s| s.as_str().map(String::from)).collect() };
                    let mut text = parts("summary");
                    if text.is_empty() {
                        text = parts("content");
                    }
                    let text = text.join("\n\n");
                    if !text.trim().is_empty() {
                        thread_message(state, task_id, parent.as_deref(), assistant(json!([{"type": "thinking", "thinking": text}])))?;
                    }
                }
                "contextCompaction" => {
                    let meta = json!({"trigger": if run.kind == "compact" { "manual" } else { "auto" }});
                    thread_message(state, task_id, parent.as_deref(), json!({"type": "system", "subtype": "compact_boundary", "compact_metadata": meta}))?;
                    if parent.is_none() {
                        crate::agent::context::on_compacted(state, run, &meta)?;
                    }
                }
                _ => {
                    let Some((name, input)) = tool_use(item) else { return Ok(()) };
                    if !shown_at_start(kind) || (kind == "collabAgentToolCall" && item["tool"] == "spawnAgent") {
                        thread_message(state, task_id, parent.as_deref(), assistant(json!([{"type": "tool_use", "id": id, "name": name, "input": input}])))?;
                    }
                    let (out, is_error) = tool_output(item);
                    thread_message(state, task_id, parent.as_deref(), tool_result(id, out, is_error))?;
                    // A tool call may have changed the task's document: the task shows it as it's written.
                    crate::agent::documents::follow(state, task_id);
                }
            }
        }
        "turn/plan/updated" => {
            let todos: Vec<Value> = p["plan"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|s| {
                    let status = match s["status"].as_str() {
                        Some("inProgress") => "in_progress",
                        Some("completed") => "completed",
                        _ => "pending",
                    };
                    json!({"content": s["step"], "status": status})
                })
                .collect();
            let id = format!("plan-{}-{}", p["threadId"].as_str().unwrap_or(""), v["emittedAtMs"].as_i64().unwrap_or_else(|| chrono::Utc::now().timestamp_millis()));
            thread_message(state, task_id, parent.as_deref(), assistant(json!([{"type": "tool_use", "id": id, "name": "TodoWrite", "input": {"todos": todos}}])))?;
            thread_message(state, task_id, parent.as_deref(), tool_result(&id, String::new(), false))?;
        }
        "error" if p["willRetry"] == true => {
            state.add_event(task_id, "warn", format!("Codex: {} (retrying)", p["error"]["message"].as_str().unwrap_or("error")), None);
        }
        "warning" => {
            if let Some(m) = p["message"].as_str() {
                state.add_event(task_id, "warn", format!("Codex: {m}"), None);
            }
        }
        "mcpServer/startupStatus/updated" if p["status"] == "failed" => {
            let name = p["name"].as_str().unwrap_or("?");
            let detail = p["error"].as_str().map(String::from);
            state.add_event(task_id, "warn", format!("MCP server {name} failed to start"), detail);
        }
        "account/rateLimits/updated" => {
            let config = {
                let c = state.db();
                db::get_task(&c, task_id)?.map(|t| db::task_claude_config(&c, &t)).transpose()?.flatten()
            };
            if let Some(config) = config {
                crate::agent::usage::set_limits(state, &config.id, limits(&p["rateLimits"]), p["rateLimits"]["planType"].as_str());
            }
        }
        "thread/tokenUsage/updated" => crate::agent::context::on_codex_usage(state, run, p)?,
        "turn/completed" if !own => {
            if let Some(thread) = p["threadId"].as_str() {
                let status = match p["turn"]["status"].as_str() {
                    Some("completed") => "completed",
                    Some("interrupted") => "stopped",
                    _ => "failed",
                };
                subagent_status(state, run, thread, status, p["turn"]["error"]["message"].as_str())?;
            }
        }
        "thread/status/changed" if !own && p["status"]["type"] == "systemError" => {
            if let Some(thread) = p["threadId"].as_str() {
                subagent_status(state, run, thread, "failed", None)?;
            }
        }
        "thread/closed" if !own => {
            if let Some(thread) = p["threadId"].as_str() {
                subagent_status(state, run, thread, "stopped", None)?;
            }
        }
        "turn/completed" => finish_turn(state, run, &p["turn"])?,
        // `/compact` ends here when its turn isn't reported.
        "thread/compacted" if own && run.kind == "compact" => finish_turn(state, run, &json!({"status": "completed"}))?,
        _ => {}
    }
    Ok(())
}

fn finish_turn(state: &Shared, run: &Run, turn: &Value) -> Result<()> {
    let status = turn["status"].as_str().unwrap_or("completed");
    let error = match status {
        "completed" => None,
        "interrupted" => Some("The turn was interrupted".to_string()),
        _ => Some(turn["error"]["message"].as_str().map(String::from).unwrap_or_else(|| format!("the turn ended as {status}"))),
    };
    // Refused for the account's usage limit (see agent/usage.rs).
    if turn["error"]["codexErrorInfo"] == "usageLimitExceeded" {
        let config = {
            let c = state.db();
            db::get_task(&c, &run.task_id)?.map(|t| db::task_claude_config(&c, &t)).transpose()?.flatten()
        };
        if let Some(config) = config {
            crate::agent::usage::codex_refused(state, &config.id);
            crate::agent::usage::ran_out(state, &run.task_id, &config.id);
        }
    }
    // `/compact` may report its end twice (see handle_line); other runs can go several turns.
    let saw: bool = state.db().query_row("SELECT saw_result FROM runs WHERE id=?1", [&run.id], |r| r.get(0))?;
    if saw && run.kind == "compact" {
        return Ok(());
    }
    let result = json!({
        "type": "result",
        "subtype": if error.is_some() { "error_during_execution" } else { "success" },
        "is_error": error.is_some(),
        "result": error,
        "duration_ms": turn["durationMs"],
        "num_turns": if run.kind == "compact" { 0 } else { 1 },
    });
    crate::agent::runner::record_result(state, run, error, result)
}
