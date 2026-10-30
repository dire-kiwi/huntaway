//! Tool-permission prompts from agents (`--permission-prompt-tool`).
//!
//! A request is keyed by the MCP call that raised it and its decision lives in the database,
//! so when a host or the server restarts mid-prompt the redelivered call finds the same
//! request (and its answer, if the user already gave one).

use rusqlite::OptionalExtension;
use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::db::{self, Task};
use crate::state::{ApiError, ApiResult, Shared};
use crate::util::{new_id, now};

/// Why a request wasn't answered: its run ended or its thread was deleted first.
const EXPIRED: &str = "Request expired";

pub const DONT_ASK_DENIAL: &str = "Denied automatically: this thread is in \"Don't ask\" mode.";

/// Answer a permission prompt for `task`, asking the user if its mode requires it.
/// `tool_use_id` lets the UI tell which subagent (if any) made the call.
pub async fn prompt(s: &Shared, task: &Task, call_id: &str, tool_name: &str, input: &Value, tool_use_id: Option<&str>) -> anyhow::Result<Value> {
    // A plan, artifact or diagram task's agent writes its document in its own folder.
    if task.auto_allow.iter().any(|t| t == tool_name) || crate::documents::writes_own_folder(s, task, tool_name, input) {
        return Ok(allow(input));
    }
    // The run was started under an older mode; honour the one selected now.
    match live_decision(s, task)? {
        Some(true) => return Ok(allow(input)),
        Some(false) => return Ok(deny(DONT_ASK_DENIAL)),
        None => {}
    }
    let data = json!({"tool_name": tool_name, "input": input, "tool_use_id": tool_use_id});
    let id = request(s, task, call_id, "tool", tool_name, input, data, &format!("Approve {tool_name}?"))?;
    Ok(match decision(s, &id).await? {
        Ok(()) => allow(input),
        Err(note) => deny(&note),
    })
}

/// Ask the user to approve what an agent asked for with `tool` (see tools.rs), a request of
/// `kind`: a change to a project (`project`, from update_project), deleting a task
/// (`delete_task`), or creating, changing or deleting one of a project's automations
/// (`automation`, from the automation tools). Only the user decides these, whatever the thread's permission mode: Ok(Ok(input)) once they
/// approve it, with the input they approved (the first asked for this call, if it's retried), or
/// Ok(Err(reason)) if they deny it or the run ends first.
pub async fn approve(s: &Shared, task: &Task, call_id: &str, kind: &str, tool: &str, input: &Value) -> anyhow::Result<Result<Value, String>> {
    let data = json!({"kind": kind, "tool_name": tool, "input": input});
    let question = match kind {
        "delete_task" => "Delete a task?",
        "automation" if input["op"] == "delete" => "Delete an automation?",
        "automation" => "Approve an automation?",
        _ => "Approve a project change?",
    };
    let id = request(s, task, call_id, kind, tool, input, data, question)?;
    if let Err(note) = decision(s, &id).await? {
        return Ok(Err(note));
    }
    let approved: Option<String> = s.db().query_row("SELECT input FROM permission_requests WHERE id=?1", [&id], |r| r.get(0)).optional()?;
    match approved {
        Some(input) => Ok(Ok(serde_json::from_str(&input)?)),
        None => Ok(Err(EXPIRED.into())),
    }
}

/// What MCP call `call_id` asked the user to approve (a project change, a deletion or an
/// automation), if it asked.
pub fn asked(s: &Shared, call_id: &str) -> anyhow::Result<Option<Value>> {
    let input: Option<String> = s
        .db()
        .query_row("SELECT input FROM permission_requests WHERE call_id=?1 AND kind IN ('project','delete_task','automation')", [call_id], |r| r.get(0))
        .ok();
    Ok(input.map(|i| serde_json::from_str(&i)).transpose()?)
}

/// The request for MCP call `call_id`, raised (with `data` as its thread message) if it's new.
#[allow(clippy::too_many_arguments)]
fn request(s: &Shared, task: &Task, call_id: &str, kind: &str, tool_name: &str, input: &Value, mut data: Value, reason: &str) -> anyhow::Result<String> {
    let existing: Option<String> = s
        .db()
        .query_row("SELECT id FROM permission_requests WHERE call_id=?1", [call_id], |r| r.get(0))
        .ok();
    if let Some(id) = existing {
        return Ok(id);
    }
    let id = new_id();
    data["request_id"] = json!(id);
    data["status"] = json!("pending");
    let msg = s.add_message(&task.id, "permission", data)?;
    s.db().execute(
        "INSERT INTO permission_requests (id,task_id,message_id,tool_name,input,status,created_at,call_id,kind) VALUES (?1,?2,?3,?4,?5,'pending',?6,?7,?8)",
        rusqlite::params![id, task.id, msg.id, tool_name, input.to_string(), now(), call_id, kind],
    )?;
    let mut fields = vec![("attention_reason", json!(reason))];
    if task.kind == "task" {
        fields.push(("status", json!("needs_attention")));
    }
    s.update_task(&task.id, &fields)?;
    Ok(id)
}

/// Waits for the user to decide request `id`: Ok(()) if they allowed it, else the reason.
async fn decision(s: &Shared, id: &str) -> anyhow::Result<Result<(), String>> {
    loop {
        // Register before reading so a decision can't slip in between.
        let (tx, rx) = oneshot::channel();
        s.perm_waiters.lock().unwrap().entry(id.to_string()).or_default().push(tx);
        let row: Option<(String, Option<String>)> =
            s.db().query_row("SELECT status, note FROM permission_requests WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
        // Gone with its thread (deleted, which expires it first, but may delete it before this
        // reads the expiry).
        let Some((status, note)) = row else {
            s.perm_waiters.lock().unwrap().remove(id);
            return Ok(Err(EXPIRED.into()));
        };
        match status.as_str() {
            "allowed" => return Ok(Ok(())),
            "pending" => {
                let _ = rx.await;
            }
            _ => return Ok(Err(note.unwrap_or_else(|| "The user denied this action.".into()))),
        }
    }
}

fn allow(input: &Value) -> Value {
    json!({"behavior": "allow", "updatedInput": input})
}

fn deny(message: &str) -> Value {
    json!({"behavior": "deny", "message": message})
}

/// What a thread's current permission mode decides for any prompt without asking the user:
/// approve everything (bypass), deny everything (don't ask), or ask (None).
pub fn live_decision(s: &Shared, task: &Task) -> anyhow::Result<Option<bool>> {
    let project = match &task.project_id {
        Some(pid) => db::get_project(&s.db(), pid)?,
        None => None,
    };
    Ok(match task.effective_permission_mode(&s.db(), project.as_ref())?.as_str() {
        "bypassPermissions" => Some(true),
        "dontAsk" => Some(false),
        _ => None,
    })
}

/// After a thread's mode changes, settle the prompts it is waiting on that the new mode decides
/// (not project changes or deletions, which only the user decides).
pub fn apply_mode_to_pending(s: &Shared, task: &Task) -> ApiResult<()> {
    let Some(allow) = live_decision(s, task)? else { return Ok(()) };
    let ids: Vec<String> = {
        let c = s.db();
        let mut st = c.prepare("SELECT id FROM permission_requests WHERE task_id=?1 AND status='pending' AND kind='tool'")?;
        st.query_map([&task.id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?
    };
    let message = (!allow).then(|| DONT_ASK_DENIAL.to_string());
    for id in ids {
        // Another client may have answered it in the meantime.
        if let Err(e) = decide(s, &id, allow, false, message.clone()) {
            tracing::debug!("skipping permission {id}: {}", e.1);
        }
    }
    Ok(())
}

/// Prompts waiting for an answer, oldest first: all of this host's, or one task's.
pub fn pending(s: &Shared, task_id: Option<&str>) -> ApiResult<Vec<Value>> {
    let c = s.db();
    let mut st = c.prepare(
        "SELECT id, task_id, tool_name, input, created_at FROM permission_requests
         WHERE status='pending' AND (?1 IS NULL OR task_id=?1) ORDER BY created_at, rowid",
    )?;
    let rows = st.query_map([task_id], |r| {
        let input: String = r.get(3)?;
        Ok(json!({
            "id": r.get::<_, String>(0)?,
            "task_id": r.get::<_, String>(1)?,
            "tool_name": r.get::<_, String>(2)?,
            "input": serde_json::from_str::<Value>(&input).unwrap_or(Value::String(input)),
            "created_at": r.get::<_, String>(4)?,
        }))
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn decide(s: &Shared, id: &str, allow: bool, always: bool, message: Option<String>) -> ApiResult<&'static str> {
    let (task_id, message_id, tool_name, current, kind): (String, i64, String, String, String) = s
        .db()
        .query_row("SELECT task_id, message_id, tool_name, status, kind FROM permission_requests WHERE id=?1", [id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .map_err(|_| ApiError::not_found("permission request"))?;
    // Each project change and deletion is approved on its own.
    let always = always && kind == "tool";
    if current != "pending" {
        return Err(ApiError::conflict("this request is no longer pending"));
    }
    let status = if allow { "allowed" } else { "denied" };
    s.db().execute("UPDATE permission_requests SET status=?1, note=?2 WHERE id=?3", rusqlite::params![status, message, id])?;
    set_message_status(s, message_id, status, message.as_deref())?;
    let task = db::get_task(&s.db(), &task_id)?;
    if let (true, Some(t)) = (always, &task) {
        let mut list = t.auto_allow.clone();
        if !list.contains(&tool_name) {
            list.push(tool_name.clone());
        }
        s.update_task(&task_id, &[("auto_allow", json!(serde_json::to_string(&list).unwrap()))])?;
    }
    // Approving a plan ends plan mode for this thread, otherwise the next run would plan again.
    if let (true, "ExitPlanMode", Some(t)) = (allow, tool_name.as_str(), &task) {
        let project = match &t.project_id {
            Some(pid) => db::get_project(&s.db(), pid)?,
            None => None,
        };
        let inherited = db::inherited_permission_mode(&s.db(), project.as_ref())?;
        if t.permission_mode.as_deref().unwrap_or(&inherited) == "plan" {
            // Back to the thread's default mode, or Ask if that's Plan too.
            let next = if inherited == "plan" { json!("default") } else { Value::Null };
            s.update_task(&task_id, &[("permission_mode", next)])?;
        }
    }
    wake(s, id);
    // Back to work if no other prompt is waiting.
    let still_pending: i64 = s.db().query_row(
        "SELECT COUNT(*) FROM permission_requests WHERE task_id=?1 AND status='pending'",
        [&task_id],
        |r| r.get(0),
    )?;
    if still_pending == 0 && s.is_running(&task_id) {
        let mut fields = vec![("attention_reason", Value::Null)];
        if let Some(t) = task.filter(|t| t.kind == "task") {
            fields.push(("status", json!(t.working_status())));
        }
        s.update_task(&task_id, &fields)?;
    }
    Ok(status)
}

/// The project changes agents are waiting for the user to approve, oldest first, each with
/// the thread that asked, with `deletions` the tasks they're waiting to delete too, and with
/// `automations` the automations they're waiting to create, change or delete (older UIs only
/// know project changes, or those and deletions).
pub fn pending_approvals(s: &Shared, deletions: bool, automations: bool) -> anyhow::Result<Vec<Value>> {
    let c = s.db();
    let mut st = c.prepare(
        "SELECT p.task_id, p.created_at, m.data FROM permission_requests p JOIN messages m ON m.id=p.message_id
         WHERE (p.kind='project' OR (?1 AND p.kind='delete_task') OR (?2 AND p.kind='automation')) AND p.status='pending' ORDER BY p.created_at",
    )?;
    let rows = st.query_map([deletions, automations], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?;
    let mut out = Vec::new();
    for row in rows {
        let (task_id, created_at, data) = row?;
        let mut v: Value = serde_json::from_str(&data).unwrap_or(json!({}));
        v["task_id"] = json!(task_id);
        v["created_at"] = json!(created_at);
        out.push(v);
    }
    Ok(out)
}

fn wake(s: &Shared, id: &str) {
    for w in s.perm_waiters.lock().unwrap().remove(id).unwrap_or_default() {
        let _ = w.send(());
    }
}

pub fn set_message_status(s: &Shared, message_id: i64, status: &str, note: Option<&str>) -> anyhow::Result<()> {
    let data: Option<String> = s
        .db()
        .query_row("SELECT data FROM messages WHERE id=?1", [message_id], |r| r.get(0))
        .ok();
    if let Some(data) = data {
        let mut v: Value = serde_json::from_str(&data).unwrap_or(json!({}));
        v["status"] = json!(status);
        if let Some(n) = note {
            v["note"] = json!(n);
        }
        let updated = db::update_message_data(&s.db(), message_id, &v)?;
        if let Some(m) = updated {
            s.emit(json!({"type": "message_updated", "task_id": m.task_id, "message": m}));
        }
    }
    Ok(())
}

/// Expire unanswered permission prompts for a thread whose run ended.
pub fn expire_for_task(s: &Shared, task_id: &str) {
    expire(s, "SELECT id, message_id FROM permission_requests WHERE task_id=?1 AND status='pending'", task_id);
}

/// Expire the unanswered prompts run `run_id` raised (a later run's on its thread stay).
pub fn expire_for_run(s: &Shared, run_id: &str) {
    expire(
        s,
        "SELECT id, message_id FROM permission_requests WHERE status='pending' AND call_id IN (SELECT id FROM mcp_calls WHERE run_id=?1)",
        run_id,
    );
}

/// Expire the unanswered approvals of changes to a project that's being deleted (and of
/// deleting its tasks, and of its automations), asked from any thread.
pub fn expire_for_project(s: &Shared, project_id: &str) {
    expire(
        s,
        "SELECT id, message_id FROM permission_requests WHERE kind IN ('project','delete_task','automation') AND status='pending' AND json_extract(input, '$.project.id')=?1",
        project_id,
    );
}

/// Expire the unanswered requests to delete a task that's being deleted anyway, asked from any
/// thread.
pub fn expire_deletions_of(s: &Shared, task_id: &str) {
    expire(
        s,
        "SELECT id, message_id FROM permission_requests WHERE kind='delete_task' AND status='pending' AND json_extract(input, '$.delete.id')=?1",
        task_id,
    );
}

/// Expire the unanswered requests to change or delete an automation that's been deleted, asked
/// from any thread.
pub fn expire_for_automation(s: &Shared, automation_id: &str) {
    expire(
        s,
        "SELECT id, message_id FROM permission_requests WHERE kind='automation' AND status='pending' AND json_extract(input, '$.automation.id')=?1",
        automation_id,
    );
}

fn expire(s: &Shared, query: &str, arg: &str) {
    let rows: Vec<(String, i64)> = {
        let c = s.db();
        let Ok(mut st) = c.prepare(query) else { return };
        st.query_map([arg], |r| Ok((r.get(0)?, r.get(1)?)))
            .map(|it| it.filter_map(Result::ok).collect())
            .unwrap_or_default()
    };
    for (id, mid) in rows {
        // Unless the user answered it since it was looked up.
        let expired = s.db().execute("UPDATE permission_requests SET status='expired', note=?2 WHERE id=?1 AND status='pending'", [id.as_str(), EXPIRED]);
        if expired.is_ok_and(|n| n > 0) {
            let _ = set_message_status(s, mid, "expired", None);
            wake(s, &id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_pending_prompts() {
        let s = crate::testing::state();
        let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let task = |title: &str| {
            let t = db::NewTask {
                profile_id: &profile.id,
                project_id: None,
                kind: "scratch",
                title,
                description: "",
                status: "todo",
                use_worktree: false,
                model: None,
                effort: None,
                claude_config_id: None,
            };
            db::insert_task(&s.db(), t).unwrap().id
        };
        let (a, b) = (task("a"), task("b"));
        let add = |id: &str, task: &str, input: &str, status: &str| {
            s.db()
                .execute(
                    "INSERT INTO permission_requests (id,task_id,message_id,tool_name,input,status,created_at) VALUES (?1,?2,0,'Bash',?3,?4,?5)",
                    rusqlite::params![id, task, input, status, now()],
                )
                .unwrap();
        };
        add("r1", &a, r#"{"command":"ls"}"#, "pending");
        add("r2", &b, "not json", "pending");
        add("r3", &a, "{}", "allowed");

        let ids = |v: Vec<Value>| v.iter().map(|r| r["id"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(ids(pending(&s, None).unwrap()), ["r1", "r2"]);
        let only_a = pending(&s, Some(&a)).unwrap();
        assert_eq!(ids(only_a.clone()), ["r1"]);
        assert_eq!(only_a[0]["input"]["command"], "ls");
        assert_eq!(only_a[0]["task_id"], a.as_str());
        assert_eq!(pending(&s, Some(&b)).unwrap()[0]["input"], "not json");
    }
}
