//! Following a run: its stream-json output becomes thread messages, and its result or exit finishes
//! the run and moves the task on.

use super::*;

const SUBAGENT_EVENTS: [&str; 4] = ["task_started", "task_progress", "task_updated", "task_notification"];

/// Strip bulky fields we never render from a stream-json event.
fn slim(mut v: Value) -> Value {
    if let Some(obj) = v.as_object_mut() {
        // An Agent/Task result says whether the subagent went to the background and which
        // model ran it; keep just that.
        let agent = obj.get("tool_use_result").filter(|r| r.get("agentId").is_some()).map(|r| {
            const KEEP: [&str; 8] =
                ["status", "isAsync", "agentId", "agentType", "resolvedModel", "totalDurationMs", "totalTokens", "totalToolUseCount"];
            Value::Object(KEEP.iter().filter_map(|k| r.get(*k).map(|x| (k.to_string(), x.clone()))).collect())
        });
        obj.remove("tool_use_result");
        obj.remove("tool_result_meta");
        if let Some(a) = agent {
            obj.insert("tool_use_result".into(), a);
        }
    }
    if let Some(blocks) = v["message"]["content"].as_array_mut() {
        blocks.retain(|b| !(b["type"] == "thinking" && b["thinking"].as_str().unwrap_or("").is_empty()));
        for b in blocks.iter_mut() {
            if let Some(o) = b.as_object_mut() {
                o.remove("signature");
                o.remove("caller");
            }
            if b["type"] == "tool_result" {
                match &b["content"] {
                    Value::String(s) if s.len() > 30_000 => b["content"] = json!(truncate(s, 30_000)),
                    Value::Array(parts) => {
                        let parts: Vec<Value> = parts
                            .iter()
                            .map(|p| match p["text"].as_str() {
                                Some(t) if t.len() > 30_000 => json!({"type": "text", "text": truncate(t, 30_000)}),
                                _ if p["type"] == "image" => json!({"type": "text", "text": "[image]"}),
                                _ => p.clone(),
                            })
                            .collect();
                        b["content"] = Value::Array(parts);
                    }
                    _ => {}
                }
            }
        }
    }
    if let Some(m) = v["message"].as_object_mut() {
        m.remove("usage");
        m.remove("container");
        m.remove("stop_details");
    }
    v
}

/// Apply a chunk of a run's output (complete stream-json lines starting at byte `offset`).
/// Chunks can repeat after a reconnect; anything before the saved offset is skipped.
pub fn on_output(state: &Shared, run_id: &str, offset: u64, data: &str) {
    let Ok(Some(run)) = db::get_run(&state.db(), run_id) else { return };
    if run.status == "exited" {
        return;
    }
    let saved = run.out_offset as u64;
    let end = offset + data.len() as u64;
    if end <= saved {
        return;
    }
    let fresh = if offset < saved { data.get((saved - offset) as usize..).unwrap_or("") } else { data };
    if offset > saved {
        tracing::warn!(run = run_id, "output gap: expected offset {saved}, got {offset}");
    }
    for line in fresh.lines() {
        if let Err(e) = handle_line(state, &run, line) {
            tracing::warn!("failed to handle claude output: {e:#}");
        }
    }
    let _ = state.db().execute("UPDATE runs SET out_offset=?1 WHERE id=?2", rusqlite::params![end as i64, run_id]);
}

pub fn on_exit(state: &Shared, run_id: &str, code: Option<i32>, signal: Option<i32>, error: Option<String>, stderr_tail: &str) {
    let Ok(Some(run)) = db::get_run(&state.db(), run_id) else { return forget(state, run_id) };
    if run.status == "exited" {
        return;
    }
    let outcome = if run.stop_requested {
        Outcome::Cancelled
    } else if let Some(e) = run.result_error {
        Outcome::Failed(e)
    } else if code == Some(0) && run.saw_result {
        Outcome::Ok
    } else {
        let how = match (error, code, signal) {
            (Some(e), _, _) => e,
            (None, Some(c), _) => format!("the agent exited with code {c}"),
            (None, None, Some(sig)) => format!("the agent was killed by signal {sig}"),
            _ => "the agent exited unexpectedly".into(),
        };
        let stderr = stderr_tail.trim();
        Outcome::Failed(if stderr.is_empty() { how } else { format!("{how}\n{}", truncate(stderr, 4000)) })
    };
    finish(state, run_id, outcome);
}

fn task_config(state: &Shared, task_id: &str) -> Result<Option<db::ClaudeConfig>> {
    let c = state.db();
    Ok(db::get_task(&c, task_id)?.map(|t| db::task_claude_config(&c, &t)).transpose()?.flatten())
}

pub(super) fn handle_line(state: &Shared, run: &Run, line: &str) -> Result<()> {
    let task_id = run.task_id.as_str();
    let v: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return Ok(()),
    };
    // Codex runs write app-server notifications; Claude Code's stream-json has no `method`.
    if v.get("method").is_some() {
        return crate::codex::handle_line(state, run, &v);
    }
    match v["type"].as_str().unwrap_or("") {
        "system" if v["subtype"] == "init" => {
            if let Some(sid) = v["session_id"].as_str() {
                state.update_task(task_id, &[("session_id", json!(sid))])?;
            }
            let c = state.db();
            if let Some(t) = db::get_task(&c, task_id)?.filter(|t| t.project_id.is_some()) {
                let config = db::task_claude_config(&c, &t)?;
                crate::agent_tools::record_seen(&c, t.project_id.as_deref().unwrap(), config.as_ref().map(|c| c.id.as_str()), &v)?;
            }
        }
        // From `/compact`, or Claude Code compacting by itself when the context fills up.
        "system" if v["subtype"] == "compact_boundary" => {
            state.add_message(task_id, "claude", json!({"type": "system", "subtype": "compact_boundary", "compact_metadata": v["compact_metadata"]}))?;
            crate::context::on_compacted(state, run, &v["compact_metadata"])?;
        }
        // Subagent lifecycle (Agent/Task tool), keyed by the launching `tool_use_id`.
        "system" if v["subtype"].as_str().is_some_and(|s| SUBAGENT_EVENTS.contains(&s)) => {
            let mut v = v;
            if let Some(obj) = v.as_object_mut() {
                obj.remove("output_file");
                obj.remove("uuid");
                obj.remove("session_id");
                if let Some(u) = obj.get("usage").cloned() {
                    obj.insert("usage".into(), json!({"total_tokens": u["total_tokens"], "tool_uses": u["tool_uses"], "duration_ms": u["duration_ms"]}));
                }
            }
            let message = state.add_message(task_id, "claude", v)?;
            crate::wait::subagent_finished(state, run, &message.data)?;
        }
        "rate_limit_event" => {
            if let Some(config) = task_config(state, task_id)? {
                crate::usage::on_rate_limit_event(state, &config.id, &v);
            }
        }
        "stream_event" => {
            // Only the top-level thread streams a preview.
            if !v["parent_tool_use_id"].is_null() {
                return Ok(());
            }
            let ev = &v["event"];
            if ev["type"] == "content_block_delta" && ev["delta"]["type"] == "text_delta" {
                if let Some(t) = ev["delta"]["text"].as_str() {
                    state.emit(json!({"type": "delta", "task_id": task_id, "text": t}));
                }
            } else if ev["type"] == "message_start" {
                state.emit(json!({"type": "delta_reset", "task_id": task_id}));
            }
        }
        "assistant" | "user" => {
            // Claude Code's message for a turn refused for the usage limit says when it resets.
            if v["api_error"] == "usage_limit_reached" && v["api_error_params"]["rate_limit_info"].is_object() {
                if let Some(config) = task_config(state, task_id)? {
                    crate::usage::on_rate_limit_event(state, &config.id, &json!({"rate_limit_info": v["api_error_params"]["rate_limit_info"]}));
                }
            }
            if v["type"] == "user" && v["isReplay"] == true {
                if let Some(id) = v["uuid"].as_str() {
                    steered(state, run, id)?;
                }
                return Ok(());
            }
            if crate::wait::is_activity(&v) {
                crate::wait::resumed(state, task_id, &run.id);
            }
            if v["type"] == "assistant" {
                crate::context::on_assistant(state, run, &v)?;
            }
            let v = slim(v);
            if v["message"]["content"].as_array().is_some_and(|c| c.is_empty()) {
                return Ok(());
            }
            let tool_result = v["type"] == "user" && v["message"]["content"].as_array().is_some_and(|c| c.iter().any(|b| b["type"] == "tool_result"));
            // The conversation's latest message, where a rewind can resume it (see checkpoints::Rewind).
            if let Some(uuid) = v["uuid"].as_str().filter(|_| v["parent_tool_use_id"].is_null()) {
                state.db().execute("UPDATE runs SET agent_at=?1 WHERE id=?2", rusqlite::params![uuid, run.id])?;
            }
            state.add_message(task_id, "claude", v)?;
            // A tool call may have changed the task's document: the task shows it as it's written.
            if tool_result {
                crate::documents::follow(state, task_id);
            }
        }
        "control_response" => crate::context::on_control_response(state, task_id, &v)?,
        "result" => {
            let recorded = claude_result(state, run, &v);
            // Whatever of it failed to be recorded (see `record_result`).
            turn_ended(state, run);
            recorded?;
        }
        _ => {}
    }
    Ok(())
}

/// The end of one of Claude Code's turns (its `result`, `v`), but for closing its input (see `turn_ended`).
fn claude_result(state: &Shared, run: &Run, v: &Value) -> Result<()> {
    let task_id = run.task_id.as_str();
    // The turn was refused: its config is out of usage (see usage.rs).
    if v["api_error"] == "usage_limit_reached" {
        if let Some(config) = task_config(state, task_id)? {
            crate::usage::ran_out(state, task_id, &config.id);
        }
    }
    crate::context::on_result(state, task_id, v)?;
    // Before the turn's end closes its input (see `turn_ended`).
    crate::context::request(state, run);
    // A running total for the agent's process, which may go on for several turns.
    let total = v["total_cost_usd"].as_f64().unwrap_or(0.0);
    let so_far: f64 = state.db().query_row("SELECT cost_usd FROM runs WHERE id=?1", [&run.id], |r| r.get(0))?;
    let cost = (total - so_far).max(0.0);
    state.db().execute("UPDATE runs SET cost_usd=?1 WHERE id=?2", rusqlite::params![total.max(so_far), run.id])?;
    let task = db::get_task(&state.db(), task_id)?;
    if let Some(t) = task {
        let mut fields = vec![("cost_usd", json!(t.cost_usd + cost))];
        if let Some(sid) = v["session_id"].as_str() {
            fields.push(("session_id", json!(sid)));
        }
        state.update_task(task_id, &fields)?;
    }
    let mut result_error = None;
    if v["is_error"] == true || v["subtype"].as_str().is_some_and(|s| s != "success") {
        result_error = Some(
            v["result"]
                .as_str()
                .map(String::from)
                .or_else(|| v["errors"].as_array().map(|e| e.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join("\n")))
                .unwrap_or_else(|| format!("run ended with {}", v["subtype"])),
        );
    }
    let slimmed = json!({
        "type": "result",
        "subtype": v["subtype"],
        "is_error": v["is_error"],
        "result": v["result"],
        "duration_ms": v["duration_ms"],
        "num_turns": v["num_turns"],
        "total_cost_usd": cost,
    });
    record_turn_end(state, run, result_error, slimmed)
}

/// The end of one of the agent's turns (Claude Code's `result`, or a Codex turn completing):
/// record its outcome and add `result` (shaped like Claude Code's) to the thread. The last
/// turn's outcome is the run's.
pub fn record_result(state: &Shared, run: &Run, error: Option<String>, result: Value) -> Result<()> {
    let recorded = record_turn_end(state, run, error, result);
    // Even if that failed (the disk is full, say): the result's line has been read, so it isn't
    // seen again, and an input left open would keep the agent (and the run) waiting for good.
    turn_ended(state, run);
    recorded
}

fn record_turn_end(state: &Shared, run: &Run, error: Option<String>, mut result: Value) -> Result<()> {
    let stopping: i64 = state.db().query_row("SELECT stop_requested FROM runs WHERE id=?1", [&run.id], |r| r.get(0))?;
    if stopping == 1 {
        // The turn a stop interrupted: from here, a message it takes in starts a new one.
        state.db().execute("UPDATE runs SET stop_requested=2 WHERE id=?1", [&run.id])?;
        if error.is_some() {
            result["interrupted"] = json!(true);
        }
    }
    state.db().execute("UPDATE runs SET saw_result=1, between_turns=1, result_error=?1 WHERE id=?2", rusqlite::params![error, run.id])?;
    let status = if stopping == 1 { "stopped" } else if error.is_some() { "failed" } else { "done" };
    crate::checkpoints::after_turn(state, &run.id, status);
    // A turn that ended isn't waiting any more, even if the agent gave up on the call.
    crate::wait::ended(state, &run.task_id, &run.id);
    crate::documents::turn_ended(state, &run.task_id);
    crate::context::record_turn(state, run, result["total_cost_usd"].as_f64())?;
    state.add_message(&run.task_id, "claude", result)?;
    Ok(())
}

/// Forget a run whose row is gone (its task was deleted while it ran).
fn forget(state: &Shared, run_id: &str) {
    state.runs.lock().unwrap().retain(|_, h| h.run_id != run_id);
}

/// Write the end of run `run_id` to its task, unless a run has started on it since: the task's
/// running state and column are then that run's (see db::later_run).
fn end_run(state: &Shared, task_id: &str, run_id: &str, fields: &[(&str, Value)]) -> Result<Option<Task>> {
    state.update_task_if(task_id, fields, |c| Ok(!db::later_run(c, task_id, run_id)?))
}

pub(crate) fn finish(state: &Shared, run_id: &str, outcome: Outcome) {
    set_writes_documents(run_id, false);
    let Ok(Some(run)) = db::get_run(&state.db(), run_id) else { return forget(state, run_id) };
    let task_id = run.task_id.as_str();
    let queued = {
        let mut runs = state.runs.lock().unwrap();
        // A turn the agent never ended (stopped, failed or killed) gets its checkpoint here, while
        // the run still holds the thread: before a rewind or the next run (a queued message) can
        // ask for theirs.
        if run.status == "running" && !run.between_turns && run.kind != "compact" {
            crate::checkpoints::after_turn(state, run_id, if matches!(outcome, Outcome::Failed(_)) { "failed" } else { "stopped" });
        }
        if runs.get(task_id).is_some_and(|h| h.run_id == run_id) {
            runs.remove(task_id);
        }
        // What the agent never took in goes with the next prompt.
        if let Err(e) = requeue_steers(state, task_id, run_id) {
            tracing::error!(task = task_id, "requeueing messages the agent didn't take in: {e:#}");
        }
        // Under the lock, so no run starts meanwhile: once one has, the thread's prompts may be its.
        let later = db::later_run(&state.db(), task_id, run_id);
        match later {
            Ok(false) => permissions::expire_for_task(state, task_id),
            _ => permissions::expire_for_run(state, run_id),
        }
        crate::wait::ended(state, task_id, run_id);
        has_queued(state, &runs, task_id)
    };
    #[cfg(test)]
    crate::testing::reached("finish:released");
    let _ = state.db().execute(
        "UPDATE runs SET status='exited', ended_at=?1 WHERE id=?2",
        rusqlite::params![crate::util::now(), run_id],
    );
    #[cfg(test)]
    crate::testing::reached("finish:exited");
    // What a stopped or failed run had written of its document.
    crate::documents::turn_ended(state, task_id);
    state.emit(json!({"type": "delta_reset", "task_id": task_id}));
    let Ok(Some(task)) = db::get_task(&state.db(), task_id) else { return };
    if run.kind == "review" && crate::summary::is_summary(&task) {
        crate::summary::finished(state, &task, run_id, &outcome, run.attention.as_deref());
    } else if run.kind == "review" {
        crate::review::finished(state, &task, run_id, &outcome, run.attention.as_deref());
    }
    if run.kind == "compact" {
        match &outcome {
            Outcome::Ok => {}
            Outcome::Cancelled => state.add_event(task_id, "warn", "Compacting stopped", None),
            Outcome::Failed(e) => state.add_event(task_id, "error", "Compacting failed", Some(e.clone())),
        }
        if queued && send_queued(state, task_id) {
            return;
        }
        if let Err(e) = end_run(state, task_id, run_id, &[("running", json!(false))]) {
            tracing::error!("failed to finalize run: {e:#}");
        }
        start_next_merge(state, task.project_id.as_deref());
        return;
    }
    let is_task = task.kind == "task";
    // It stopped because its config is out of usage, which resets then (see usage::ran_out).
    let limit = match &outcome {
        Outcome::Failed(_) => task.limit_reset_at.clone().filter(|t| !crate::usage::reset_due(t)),
        _ => None,
    };
    // Its profile has it wait for the reset rather than need attention.
    let wait = limit.is_some() && is_task && !task.merging && db::get_profile(&state.db(), &task.profile_id).ok().flatten().is_some_and(|p| p.limit_wait);
    let (status, reason): (Option<&str>, Option<String>) = match (&outcome, run.attention) {
        (Outcome::Cancelled, _) => {
            state.add_event(task_id, "warn", "Run stopped", None);
            (Some("needs_attention"), Some("Stopped by user".into()))
        }
        (Outcome::Failed(e), _) if limit.is_some() => {
            let config = task_config(state, task_id).ok().flatten().map(|c| c.name).unwrap_or_else(|| "Its config".into());
            state.add_event(task_id, "warn", format!("{config} is out of usage"), Some(e.clone()));
            if wait {
                state.add_event(task_id, "info", format!("Waiting for {config}'s usage limit to reset"), limit.as_ref().map(|t| format!("It resets at {t}")));
                (Some("in_progress"), None)
            } else {
                (Some("needs_attention"), Some(e.lines().next().unwrap_or("Out of usage").to_string()))
            }
        }
        (Outcome::Failed(e), _) => {
            state.add_event(task_id, "error", "Run failed", Some(e.clone()));
            (Some("needs_attention"), Some(format!("Run failed: {}", e.lines().next().unwrap_or(""))))
        }
        (Outcome::Ok, Some(q)) => (Some("needs_attention"), Some(q)),
        // The agent marked its own task done (e.g. after merging it).
        (Outcome::Ok, None) if task.status == "done" => (None, None),
        // It summarised the merge, which waits for the user's approval (see merge_gate.rs).
        (Outcome::Ok, None) if task.merging && crate::merge_gate::is_pending(&task) => (Some("needs_attention"), Some(APPROVAL.into())),
        (Outcome::Ok, None) if task.merging => (Some("needs_attention"), Some("The agent finished without marking the task merged".into())),
        // It stepped out of the merge queue to make changes, and now rejoins it.
        (Outcome::Ok, None) if task.remerge => (Some("ready_for_merge"), None),
        (Outcome::Ok, None) => (Some("in_review"), None),
    };
    // The queued message carries on the conversation, so the task stays where it is. Out of
    // usage, it would only be refused too: it stays queued for when the limit resets.
    if queued && limit.is_none() && send_queued(state, task_id) {
        return;
    }
    let mut fields = vec![("running", json!(false)), ("attention_reason", json!(reason))];
    if wait {
        fields.push(("waiting", json!(true)));
    }
    if is_task {
        if let Some(s) = status {
            fields.push(("status", json!(s)));
        }
        if status == Some("ready_for_merge") {
            // At the back of the queue, as the tasks behind it moved up while it was away.
            let end = db::end_position(&state.db(), task.project_id.as_deref(), "ready_for_merge", "task").unwrap_or(task.position);
            fields.extend([("merging", json!(true)), ("remerge", json!(false)), ("position", json!(end))]);
            state.add_event(task_id, "info", "Back in the merge queue", None);
        }
    }
    let updated = match end_run(state, task_id, run_id, &fields) {
        Ok(t) => t,
        Err(e) => {
            tracing::error!("failed to finalize run: {e:#}");
            None
        }
    };
    if is_task && reason.as_deref() == Some(APPROVAL) {
        if let Err(e) = crate::merge_gate::ask(state, task_id) {
            tracing::error!(task = task_id, "asking for a merge's approval: {e:#}");
        }
    }
    if is_task {
        start_next_merge(state, task.project_id.as_deref());
        crate::worktree::find_pr(state, &task);
    }
    if let Some(t) = updated.filter(|t| is_task && t.status == "in_review" && status == Some("in_review")) {
        crate::review::on_in_review(state, &t);
    }
}
