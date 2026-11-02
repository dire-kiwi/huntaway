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

/// Claude Code's tool for asking the user multiple-choice questions. Allowed with the user's
/// answers in its input (`answers`, each question's text to its answer), it gives them to the agent.
pub const ASK_USER: &str = "AskUserQuestion";
/// What Codex's questions (`item/tool/requestUserInput`, see agent/codex.rs) are asked as: AskUserQuestion's
/// input, with each question's `id`, and answered with Codex's answers in `answers`.
pub const CODEX_QUESTIONS: &str = "request_user_input";
/// Claude Code's tool for presenting a plan in plan mode (its input's `plan`, in Markdown): allowed,
/// the agent carries on with it; denied, it keeps planning.
pub const EXIT_PLAN: &str = "ExitPlanMode";

/// Whether prompts for `tool` ask the user questions rather than for permission. Only the user
/// can answer them: they're asked whatever the thread's mode (except Don't ask) or always-allowed tools.
pub fn is_question(tool: &str) -> bool {
    tool == ASK_USER || tool == CODEX_QUESTIONS
}

/// Answer a permission prompt for `task`, asking the user if its mode requires it.
/// `tool_use_id` lets the UI tell which subagent (if any) made the call.
pub async fn prompt(s: &Shared, task: &Task, call_id: &str, tool_name: &str, input: &Value, tool_use_id: Option<&str>) -> anyhow::Result<Value> {
    let question = is_question(tool_name);
    // A labelled task's agent writes its documents in its own folder.
    if !question && (task.auto_allow.iter().any(|t| t == tool_name) || crate::agent::documents::writes_own_folder(s, task, tool_name, input)) {
        return Ok(allow(input));
    }
    // The run was started under an older mode; honour the one selected now.
    match live_decision(s, task)? {
        Some(true) if !question => return Ok(allow(input)),
        Some(false) => return Ok(deny(DONT_ASK_DENIAL)),
        _ => {}
    }
    let data = json!({"tool_name": tool_name, "input": input, "tool_use_id": tool_use_id});
    let id = request(s, task, call_id, "tool", tool_name, input, data, &reason(tool_name, input))?;
    Ok(match decision(s, &id).await? {
        Ok(()) => allowed(s, &id, &task.id, tool_name, input)?,
        Err(note) => deny(&note),
    })
}

/// What a task waiting on a prompt for `tool_name` says it's waiting for (its attention reason).
fn reason(tool_name: &str, input: &Value) -> String {
    let one_line = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    if is_question(tool_name) {
        let questions = input["questions"].as_array().map(Vec::as_slice).unwrap_or_default();
        let first = questions.iter().find_map(|q| q["question"].as_str()).map(one_line).filter(|q| !q.is_empty());
        return match (first, questions.len()) {
            (None, _) => "The agent has questions for you".into(),
            (Some(q), 0 | 1) => q,
            (Some(q), n) => format!("{q} (and {} more question{})", n - 1, if n == 2 { "" } else { "s" }),
        };
    }
    if tool_name == EXIT_PLAN {
        // The plan's title, if it starts with one ("# Plan: add a cache").
        let title = input["plan"].as_str().and_then(|p| p.lines().map(str::trim).find(|l| !l.is_empty())).and_then(|l| l.strip_prefix('#'));
        let title = title.map(|t| one_line(t.trim_start_matches('#'))).map(|t| t.strip_prefix("Plan:").map(str::trim).unwrap_or(&t).to_string());
        return match title.filter(|t| !t.is_empty()) {
            Some(t) => format!("Plan ready for approval: {t}"),
            None => "Plan ready for approval".into(),
        };
    }
    format!("Approve {tool_name}?")
}

/// What the agent is told when the user allowed request `id`: its input as the user approved it
/// (with their answers, for a question), and for an approved plan, the mode the thread carries on in.
fn allowed(s: &Shared, id: &str, task_id: &str, tool_name: &str, input: &Value) -> anyhow::Result<Value> {
    let stored: Option<String> = s.db().query_row("SELECT input FROM permission_requests WHERE id=?1", [id], |r| r.get(0)).optional()?;
    let input = stored.and_then(|i| serde_json::from_str(&i).ok()).unwrap_or_else(|| input.clone());
    let mut answer = allow(&input);
    // Claude Code leaves plan mode for Ask: another mode it can switch to is set for the rest of the run
    // (Bypass can't be switched to, but the board allows everything for it, see live_decision).
    if tool_name == EXIT_PLAN {
        let task = db::get_task(&s.db(), task_id)?;
        let mode = match task {
            Some(t) => {
                let project = match &t.project_id {
                    Some(pid) => db::get_project(&s.db(), pid)?,
                    None => None,
                };
                Some(t.effective_permission_mode(&s.db(), project.as_ref())?)
            }
            None => None,
        };
        if let Some(mode) = mode.filter(|m| ["acceptEdits", "auto"].contains(&m.as_str())) {
            answer["updatedPermissions"] = json!([{"type": "setMode", "mode": mode, "destination": "session"}]);
        }
    }
    Ok(answer)
}

/// Ask the user to approve what an agent asked for with `tool` (see mcp/tools.rs), a request of
/// `kind`: a new project or a change to one (`project`, from create_project and update_project), deleting a task
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
        "project" if tool == "create_project" => "Add a project?",
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
    // Raised under the runs lock, so that the call's run can't end in between: runner::finish expires
    // its thread's prompts under it. One from a run that has ended would flag its thread for nothing.
    let runs = s.runs.lock().unwrap();
    let run_id: Option<String> = s.db().query_row("SELECT run_id FROM mcp_calls WHERE id=?1", [call_id], |r| r.get(0)).optional()?;
    if run_id.is_some_and(|r| runs.get(&task.id).is_none_or(|h| h.run_id != r)) {
        anyhow::bail!("this call's run has ended on the board");
    }
    let id = new_id();
    data["request_id"] = json!(id);
    data["status"] = json!("pending");
    // So the thread names the agent that asked.
    let config = db::task_claude_config(&s.db(), task)?;
    if config.is_some_and(|c| c.agent == "codex") {
        data["agent"] = json!("codex");
    }
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
        let mut st = c.prepare("SELECT id, tool_name FROM permission_requests WHERE task_id=?1 AND status='pending' AND kind='tool'")?;
        let rows = st.query_map([&task.id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        // Bypass doesn't answer questions for the user (see prompt).
        rows.filter(|r| r.as_ref().map_or(true, |(_, tool)| !(allow && is_question(tool)))).map(|r| r.map(|(id, _)| id)).collect::<rusqlite::Result<_>>()?
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
    answer(s, id, allow, always, message, Reply::default())
}

/// What the user answered a question or a plan with, besides allowing or denying it (API 64).
#[derive(Default, Debug, serde::Deserialize)]
pub struct Reply {
    /// For a question (see is_question), allowed: each question's answers, in order. An answer is a
    /// chosen option's label or what the user typed; a question with none is left unanswered.
    #[serde(default)]
    pub answers: Option<Vec<Vec<String>>>,
    /// For a plan (ExitPlanMode), approved: the permission mode the thread carries on in.
    #[serde(default)]
    pub mode: Option<String>,
    /// For a plan, denied: what the user wants changed, sent to the agent as it keeps planning.
    #[serde(default)]
    pub feedback: Option<String>,
}

/// Allow or deny request `id`, with what the user answered (see Reply). Answering a question or a
/// plan whose run ended first (expired) sends the answer to the agent as the user's message instead.
/// Only the first answer counts: another (from another tab, say) is refused.
pub fn answer(s: &Shared, id: &str, allow: bool, always: bool, message: Option<String>, reply: Reply) -> ApiResult<&'static str> {
    let (task_id, message_id, tool_name, current, kind, input): (String, i64, String, String, String, String) = s
        .db()
        .query_row("SELECT task_id, message_id, tool_name, status, kind, input FROM permission_requests WHERE id=?1", [id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
        })
        .map_err(|_| ApiError::not_found("permission request"))?;
    let question = is_question(&tool_name);
    let plan = tool_name == EXIT_PLAN && kind == "tool";
    // Each project change and deletion is approved on its own, and each question answered.
    let always = always && kind == "tool" && !question;
    // A question or plan the agent's run ended on can still be answered, by message.
    let late = current == "expired" && (question || plan);
    if current != "pending" && !late {
        return Err(ApiError::conflict("this request is no longer pending"));
    }
    if late && moved_on(s, &task_id, message_id)? {
        return Err(ApiError::conflict("the conversation has moved on since this was asked: reply in the thread instead"));
    }
    if let Some(m) = reply.mode.as_deref().filter(|_| plan && allow)
        && (m == "plan" || !db::PERMISSION_MODES.contains(&m))
    {
        return Err(ApiError::bad("mode must be one of the permission modes other than plan"));
    }
    let mut input: Value = serde_json::from_str(&input).unwrap_or(Value::Null);
    let answers = match reply.answers.as_ref().filter(|_| question && allow) {
        Some(a) => Some(check_answers(&input, a)?),
        None => None,
    };
    if let Some(a) = &answers {
        input["answers"] = tool_answers(&tool_name, &input, a);
    }
    let feedback = reply.feedback.as_deref().map(str::trim).filter(|f| plan && !allow && !f.is_empty());
    let note = match (message, feedback) {
        (Some(m), _) => Some(m),
        (None, Some(f)) => Some(format!("The user wants you to keep planning rather than start on this plan. Their feedback:\n\n{f}")),
        (None, None) if plan && !allow => Some("The user wants you to keep planning rather than start on this plan.".into()),
        (None, None) => None,
    };
    let status = if allow { "allowed" } else { "denied" };
    // In one statement, so of two answers at once only one is taken.
    let taken = s.db().execute(
        "UPDATE permission_requests SET status=?1, note=?2, input=?3 WHERE id=?4 AND status=?5",
        rusqlite::params![status, note, input.to_string(), id, current],
    )?;
    if taken == 0 {
        return Err(ApiError::conflict("this request is no longer pending"));
    }
    let task = db::get_task(&s.db(), &task_id)?;
    // Approving a plan ends plan mode for this thread, otherwise the next run would plan again (as the
    // one a late approval's message starts would).
    let mode = match (&task, allow && plan) {
        (Some(t), true) => mode_after_plan(s, t, reply.mode.as_deref())?,
        _ => None,
    };
    if let Some(next) = &mode {
        set_mode(s, &task_id, next.clone())?;
    }
    if late {
        // Its run is over: what the user answered goes to the agent as their message.
        let text = match (question, allow) {
            (true, true) => answers.as_ref().map(|a| late_answers(&input, a)),
            // Dismissed: nothing to tell it.
            (true, false) => None,
            (false, true) => Some("Your plan is approved: go ahead and implement it.".to_string()),
            (false, false) => Some(match feedback {
                Some(f) => format!("Keep planning: don't start on the plan yet.\n\n{f}"),
                None => "Keep planning: don't start on the plan yet.".to_string(),
            }),
        };
        if let Some(text) = text {
            if let Err(e) = crate::agent::runner::send(s, &task_id, &text) {
                // Answerable again, as it was.
                let _ = s.db().execute("UPDATE permission_requests SET status='expired', note=NULL WHERE id=?1", [id]);
                if let (Some(t), Some(_)) = (&task, &mode) {
                    let _ = s.update_task(&task_id, &[("permission_mode", json!(t.permission_mode))]);
                }
                return Err(e);
            }
        }
    }
    update_message(s, message_id, |v| {
        v["status"] = json!(status);
        if let Some(n) = &note {
            v["note"] = json!(n);
        }
        if let Some(a) = &answers {
            v["answers"] = json!(shown_answers(&input, a));
        }
        if let Some(f) = feedback {
            v["feedback"] = json!(f);
        }
        if let Some(m) = reply.mode.as_deref().filter(|_| plan && allow) {
            v["mode"] = json!(m);
        }
        if late {
            v["late"] = json!(true);
        }
    })?;
    // The user's answers to the agent's questions are a prompt to it: they put the task in "now", like a message does
    // (not the other permission decisions, which only let the agent carry on).
    if answers.is_some() {
        crate::agent::focus::put_in_now(s, &task_id);
    }
    if let (true, Some(t)) = (always, &task) {
        let mut list = t.auto_allow.clone();
        if !list.contains(&tool_name) {
            list.push(tool_name.clone());
        }
        s.update_task(&task_id, &[("auto_allow", json!(serde_json::to_string(&list).unwrap()))])?;
    }
    wake(s, id);
    if late {
        return Ok(status);
    }
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

/// The permission mode thread `t` carries on in once its plan is approved, if it changes: the one the user
/// picked (or the thread's default, if that's it), or else the thread's default if it's planning (Ask if
/// that's Plan too).
fn mode_after_plan(s: &Shared, t: &Task, picked: Option<&str>) -> anyhow::Result<Option<Value>> {
    let project = match &t.project_id {
        Some(pid) => db::get_project(&s.db(), pid)?,
        None => None,
    };
    let inherited = db::inherited_permission_mode(&s.db(), project.as_ref())?;
    let current = t.permission_mode.as_deref().unwrap_or(&inherited);
    Ok(match picked {
        // The mode it's in (the agent went into plan mode by itself): a thread's own mode stays its own.
        Some(m) if m == current && current != "plan" => None,
        Some(m) if m == inherited => Some(Value::Null),
        Some(m) => Some(json!(m)),
        None if current == "plan" => Some(if inherited == "plan" { json!("default") } else { Value::Null }),
        None => None,
    })
}

/// Whether the conversation in `task_id`'s thread has moved on since message `message_id`: a message
/// has been sent to the agent after it (by the user, the board or another agent). A question or plan
/// asked before then isn't answered any more.
pub fn moved_on(s: &Shared, task_id: &str, message_id: i64) -> anyhow::Result<bool> {
    Ok(s.db().query_row(
        "SELECT EXISTS(SELECT 1 FROM messages WHERE task_id=?1 AND kind='user' AND id>?2)",
        rusqlite::params![task_id, message_id],
        |r| r.get(0),
    )?)
}

fn set_mode(s: &Shared, task_id: &str, mode: Value) -> ApiResult<()> {
    if let Some(t) = s.update_task(task_id, &[("permission_mode", mode)])? {
        apply_mode_to_pending(s, &t)?;
    }
    Ok(())
}

/// A question prompt's questions (see is_question).
fn questions(input: &Value) -> &[Value] {
    input["questions"].as_array().map(Vec::as_slice).unwrap_or_default()
}

/// The answers to a question prompt's questions, trimmed, checked against them: one list per
/// question, and a question that takes one answer (a Codex question) gets at most one.
fn check_answers(input: &Value, answers: &[Vec<String>]) -> ApiResult<Vec<Vec<String>>> {
    let questions = questions(input);
    if answers.len() != questions.len() {
        return Err(ApiError::bad(format!("answers must have one list for each of the {} questions", questions.len())));
    }
    let mut out = Vec::new();
    for (q, a) in questions.iter().zip(answers) {
        let a: Vec<String> = a.iter().map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect();
        if a.len() > 1 && q["multiSelect"] != true {
            return Err(ApiError::bad(format!("\"{}\" takes one answer", q["question"].as_str().unwrap_or("?"))));
        }
        out.push(a);
    }
    Ok(out)
}

/// The answers as the agent's tool takes them in its input's `answers`: Claude Code's by question,
/// with the answers to one question joined by commas; Codex's by question id.
fn tool_answers(tool_name: &str, input: &Value, answers: &[Vec<String>]) -> Value {
    let pairs = questions(input).iter().zip(answers).filter(|(_, a)| !a.is_empty());
    if tool_name == CODEX_QUESTIONS {
        return json!(pairs.map(|(q, a)| (q["id"].as_str().unwrap_or_default().to_string(), json!({"answers": a}))).collect::<serde_json::Map<_, _>>());
    }
    json!(pairs.map(|(q, a)| (q["question"].as_str().unwrap_or_default().to_string(), json!(a.join(", ")))).collect::<serde_json::Map<_, _>>())
}

/// The answers as the thread shows them: a secret's hidden (Codex can ask for one).
fn shown_answers(input: &Value, answers: &[Vec<String>]) -> Vec<Vec<String>> {
    questions(input)
        .iter()
        .zip(answers)
        .map(|(q, a)| if q["isSecret"] == true && !a.is_empty() { vec!["(hidden)".to_string()] } else { a.clone() })
        .collect()
}

/// The user's message with the answers to questions asked in a run that ended first.
fn late_answers(input: &Value, answers: &[Vec<String>]) -> String {
    let lines: Vec<String> = questions(input)
        .iter()
        .zip(shown_answers(input, answers))
        .map(|(q, a)| {
            let asked = q["question"].as_str().unwrap_or("?");
            if a.is_empty() { format!("- {asked}\n  (no answer)") } else { format!("- {asked}\n  {}", a.join(", ")) }
        })
        .collect();
    let what = if lines.len() == 1 { "answer to the question" } else { "answers to the questions" };
    format!("My {what} you asked:\n\n{}", lines.join("\n"))
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
    update_message(s, message_id, |v| {
        v["status"] = json!(status);
        if let Some(n) = note {
            v["note"] = json!(n);
        }
    })
}

/// Change message `message_id`'s data with `f`, and tell the UI.
fn update_message(s: &Shared, message_id: i64, f: impl FnOnce(&mut Value)) -> anyhow::Result<()> {
    let data: Option<String> = s
        .db()
        .query_row("SELECT data FROM messages WHERE id=?1", [message_id], |r| r.get(0))
        .ok();
    if let Some(data) = data {
        let mut v: Value = serde_json::from_str(&data).unwrap_or(json!({}));
        f(&mut v);
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
mod tests;
