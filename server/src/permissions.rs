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
/// What Codex's questions (`item/tool/requestUserInput`, see codex.rs) are asked as: AskUserQuestion's
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
    // A plan, artifact or diagram task's agent writes its document in its own folder.
    if !question && (task.auto_allow.iter().any(|t| t == tool_name) || crate::documents::writes_own_folder(s, task, tool_name, input)) {
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

/// Ask the user to approve what an agent asked for with `tool` (see tools.rs), a request of
/// `kind`: a change to a project (`project`, from update_project) or deleting a task
/// (`delete_task`). Only the user decides these, whatever the thread's permission mode: Ok(Ok(input)) once they
/// approve it, with the input they approved (the first asked for this call, if it's retried), or
/// Ok(Err(reason)) if they deny it or the run ends first.
pub async fn approve(s: &Shared, task: &Task, call_id: &str, kind: &str, tool: &str, input: &Value) -> anyhow::Result<Result<Value, String>> {
    let data = json!({"kind": kind, "tool_name": tool, "input": input});
    let question = if kind == "delete_task" { "Delete a task?" } else { "Approve a project change?" };
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

/// What MCP call `call_id` asked the user to approve (a project change or a deletion), if it asked.
pub fn asked(s: &Shared, call_id: &str) -> anyhow::Result<Option<Value>> {
    let input: Option<String> = s
        .db()
        .query_row("SELECT input FROM permission_requests WHERE call_id=?1 AND kind IN ('project','delete_task')", [call_id], |r| r.get(0))
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

/// What the user answered a question or a plan with, besides allowing or denying it (API 63).
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
            if let Err(e) = crate::runner::send(s, &task_id, &text) {
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
/// the thread that asked, and with `deletions` the tasks they're waiting to delete too (older
/// UIs only know project changes).
pub fn pending_approvals(s: &Shared, deletions: bool) -> anyhow::Result<Vec<Value>> {
    let c = s.db();
    let mut st = c.prepare(
        "SELECT p.task_id, p.created_at, m.data FROM permission_requests p JOIN messages m ON m.id=p.message_id
         WHERE (p.kind='project' OR (?1 AND p.kind='delete_task')) AND p.status='pending' ORDER BY p.created_at",
    )?;
    let rows = st.query_map([deletions], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?;
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
/// deleting its tasks), asked from any thread.
pub fn expire_for_project(s: &Shared, project_id: &str) {
    expire(
        s,
        "SELECT id, message_id FROM permission_requests WHERE kind IN ('project','delete_task') AND status='pending' AND json_extract(input, '$.project.id')=?1",
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
    use crate::runner;

    /// A task (in the profile's default config, or `config`'s), and a run of it that's going (so a message sent to it is
    /// queued for it, as no agent reads its input).
    fn running_task(s: &Shared, config: Option<&str>) -> (Task, db::Run) {
        let ids: Vec<String> = config.into_iter().map(String::from).collect();
        let profile = db::insert_profile(&s.db(), &format!("p{}", new_id()), &ids, None).unwrap();
        let t = db::NewTask {
            profile_id: &profile.id,
            project_id: None,
            kind: "task",
            title: "t",
            description: "",
            status: "in_progress",
            use_worktree: false,
            model: None,
            effort: None,
            claude_config_id: config,
        };
        let task = db::insert_task(&s.db(), t).unwrap();
        let run = db::insert_run(&s.db(), &task.id, "prompt").unwrap();
        s.db().execute("UPDATE runs SET status='running' WHERE id=?1", [&run.id]).unwrap();
        s.runs.lock().unwrap().insert(task.id.clone(), crate::state::RunHandle { run_id: run.id.clone(), cancel: None });
        let task = s.update_task(&task.id, &[("running", json!(true))]).unwrap().unwrap();
        (task, run)
    }

    /// Raise a prompt for `tool` from `task` (as MCP call `call_id`) and wait until it's asked. Returns its request id
    /// and what the agent is told once it's answered.
    async fn asked(s: &Shared, task: &Task, call_id: &str, tool: &str, input: Value) -> (String, tokio::task::JoinHandle<Value>) {
        let (s2, t2, call, tool2) = (s.clone(), task.clone(), call_id.to_string(), tool.to_string());
        let answer = tokio::spawn(async move { prompt(&s2, &t2, &call, &tool2, &input, None).await.unwrap() });
        loop {
            let id: Option<String> = s.db().query_row("SELECT id FROM permission_requests WHERE call_id=?1", [call_id], |r| r.get(0)).ok();
            if let Some(id) = id {
                return (id, answer);
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }

    fn prompt_message(s: &Shared, id: &str) -> Value {
        let mid: i64 = s.db().query_row("SELECT message_id FROM permission_requests WHERE id=?1", [id], |r| r.get(0)).unwrap();
        s.db().query_row("SELECT data FROM messages WHERE id=?1", [mid], |r| r.get::<_, String>(0)).map(|d| serde_json::from_str(&d).unwrap()).unwrap()
    }

    fn two_questions() -> Value {
        json!({"questions": [
            {"question": "Which season?", "header": "Season", "multiSelect": false, "options": [{"label": "Summer", "description": "Warm"}, {"label": "Winter"}]},
            {"question": "Which pets?", "header": "Pets", "multiSelect": true, "options": [{"label": "Cats"}, {"label": "Dogs"}, {"label": "Birds"}]}
        ]})
    }

    fn answers(a: Vec<Vec<&str>>) -> Reply {
        Reply { answers: Some(a.into_iter().map(|q| q.into_iter().map(String::from).collect()).collect()), ..Default::default() }
    }

    #[test]
    fn answers_to_claudes_questions_go_back_as_its_tool_takes_them() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (task, _) = running_task(&s, None);
            let input = two_questions();
            let (id, told) = asked(&s, &task, "c1", ASK_USER, input.clone()).await;
            // The task says what it's waiting for: a question, not a permission.
            let t = db::get_task(&s.db(), &task.id).unwrap().unwrap();
            assert_eq!((t.status.as_str(), t.attention_reason.as_deref()), ("needs_attention", Some("Which season? (and 1 more question)")));
            // Answers are checked against the questions.
            assert_eq!(answer(&s, &id, true, false, None, answers(vec![vec!["Summer"]])).unwrap_err().0, axum::http::StatusCode::BAD_REQUEST);
            assert_eq!(answer(&s, &id, true, false, None, answers(vec![vec!["Summer", "Winter"], vec![]])).unwrap_err().0, axum::http::StatusCode::BAD_REQUEST);

            assert_eq!(answer(&s, &id, true, false, None, answers(vec![vec![" Summer "], vec!["Cats", "Birds", "a lizard"]])).unwrap(), "allowed");
            let mut updated = input.clone();
            updated["answers"] = json!({"Which season?": "Summer", "Which pets?": "Cats, Birds, a lizard"});
            assert_eq!(told.await.unwrap(), json!({"behavior": "allow", "updatedInput": updated}));
            let shown = prompt_message(&s, &id);
            assert_eq!((&shown["status"], &shown["answers"]), (&json!("allowed"), &json!([["Summer"], ["Cats", "Birds", "a lizard"]])));
            let t = db::get_task(&s.db(), &task.id).unwrap().unwrap();
            assert_eq!((t.status.as_str(), t.attention_reason), ("in_progress", None));
            // Not as an always-allowed tool.
            assert!(t.auto_allow.is_empty());
        });
    }

    #[test]
    fn answers_to_codexs_questions_go_back_by_question_id() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let codex = db::insert_claude_config(&s.db(), "Codex", "", "codex").unwrap();
            let (task, _) = running_task(&s, Some(&codex.id));
            let input = json!({"questions": [
                {"id": "name", "question": "Which name?", "options": [{"label": "a.txt", "description": ""}], "isOther": true, "isSecret": false},
                {"id": "token", "question": "Your token?", "options": [], "isOther": true, "isSecret": true},
                {"id": "skip", "question": "Anything else?", "options": [{"label": "No", "description": ""}], "isOther": false, "isSecret": false}
            ]});
            let (id, told) = asked(&s, &task, "c1", CODEX_QUESTIONS, input.clone()).await;
            // The thread says it's Codex asking.
            assert_eq!(prompt_message(&s, &id)["agent"], "codex");
            answer(&s, &id, true, true, None, answers(vec![vec!["b.txt"], vec!["s3cret"], vec![]])).unwrap();
            let told = told.await.unwrap();
            assert_eq!(told["updatedInput"]["answers"], json!({"name": {"answers": ["b.txt"]}, "token": {"answers": ["s3cret"]}}));
            // The thread doesn't show a secret.
            assert_eq!(prompt_message(&s, &id)["answers"], json!([["b.txt"], ["(hidden)"], []]));
        });
    }

    #[test]
    fn questions_are_asked_whatever_the_threads_mode_unless_it_asks_nothing() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (task, _) = running_task(&s, None);
            let task = s.update_task(&task.id, &[("permission_mode", json!("bypassPermissions")), ("auto_allow", json!(r#"["AskUserQuestion"]"#))]).unwrap().unwrap();
            // Bypass allows a tool call, but a question is still the user's to answer.
            assert_eq!(prompt(&s, &task, "b", "Bash", &json!({"command": "ls"}), None).await.unwrap()["behavior"], "allow");
            let (id, told) = asked(&s, &task, "q", ASK_USER, two_questions()).await;
            let (bash, bash_told) = asked(&s, &s.update_task(&task.id, &[("permission_mode", json!("default"))]).unwrap().unwrap(), "b2", "Bash", json!({})).await;
            // Switching to Bypass settles the tool call, not the question.
            let t = s.update_task(&task.id, &[("permission_mode", json!("bypassPermissions"))]).unwrap().unwrap();
            apply_mode_to_pending(&s, &t).unwrap();
            assert_eq!(bash_told.await.unwrap()["behavior"], "allow");
            let status = |id: &str| s.db().query_row("SELECT status FROM permission_requests WHERE id=?1", [id], |r| r.get::<_, String>(0)).unwrap();
            assert_eq!((status(&bash), status(&id)), ("allowed".into(), "pending".into()));
            // Don't ask denies it, as it does every prompt.
            let t = s.update_task(&task.id, &[("permission_mode", json!("dontAsk"))]).unwrap().unwrap();
            apply_mode_to_pending(&s, &t).unwrap();
            assert_eq!(told.await.unwrap(), json!({"behavior": "deny", "message": DONT_ASK_DENIAL}));
            assert_eq!(prompt(&s, &t, "q2", ASK_USER, &two_questions(), None).await.unwrap()["behavior"], "deny");
        });
    }

    #[test]
    fn only_the_first_answer_counts() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (task, _) = running_task(&s, None);
            let (id, told) = asked(&s, &task, "c1", ASK_USER, two_questions()).await;
            // Two tabs answering at once.
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
            let tabs: Vec<_> = [vec!["Summer"], vec!["Winter"]]
                .into_iter()
                .map(|season| {
                    let (s, id, barrier) = (s.clone(), id.clone(), barrier.clone());
                    std::thread::spawn(move || {
                        barrier.wait();
                        answer(&s, &id, true, false, None, answers(vec![season, vec![]]))
                    })
                })
                .collect();
            let results: Vec<_> = tabs.into_iter().map(|t| t.join().unwrap()).collect();
            assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1, "{results:?}");
            let refused = results.iter().find_map(|r| r.as_ref().err()).unwrap();
            assert_eq!(refused.0, axum::http::StatusCode::CONFLICT);
            let given = told.await.unwrap()["updatedInput"]["answers"]["Which season?"].clone();
            assert_eq!(prompt_message(&s, &id)["answers"][0][0], given);
            // Nor can it be denied after.
            assert!(decide(&s, &id, false, false, None).is_err());
        });
    }

    #[test]
    fn an_approved_plan_carries_on_in_the_mode_picked() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (task, _) = running_task(&s, None);
            let task = s.update_task(&task.id, &[("permission_mode", json!("plan"))]).unwrap().unwrap();
            let plan = json!({"plan": "# Plan: add a cache\n\n1. Do it", "planFilePath": "/p.md"});
            let (id, told) = asked(&s, &task, "p1", EXIT_PLAN, plan.clone()).await;
            assert_eq!(db::get_task(&s.db(), &task.id).unwrap().unwrap().attention_reason.as_deref(), Some("Plan ready for approval: add a cache"));
            // Sent back with feedback.
            let reply = Reply { feedback: Some(" Add tests too. ".into()), ..Default::default() };
            assert_eq!(answer(&s, &id, false, false, None, reply).unwrap(), "denied");
            let told = told.await.unwrap();
            assert_eq!(told["behavior"], "deny");
            assert!(told["message"].as_str().unwrap().ends_with("Their feedback:\n\nAdd tests too."), "{told}");
            assert_eq!(prompt_message(&s, &id)["feedback"], "Add tests too.");
            assert_eq!(db::get_task(&s.db(), &task.id).unwrap().unwrap().permission_mode.as_deref(), Some("plan"));

            // Approved, into Accept edits: the agent's Claude Code switches to it too.
            let (id, told) = asked(&s, &task, "p2", EXIT_PLAN, plan.clone()).await;
            let bad = Reply { mode: Some("plan".into()), ..Default::default() };
            assert_eq!(answer(&s, &id, true, false, None, bad).unwrap_err().0, axum::http::StatusCode::BAD_REQUEST);
            answer(&s, &id, true, false, None, Reply { mode: Some("acceptEdits".into()), ..Default::default() }).unwrap();
            assert_eq!(
                told.await.unwrap(),
                json!({"behavior": "allow", "updatedInput": plan, "updatedPermissions": [{"type": "setMode", "mode": "acceptEdits", "destination": "session"}]})
            );
            assert_eq!(db::get_task(&s.db(), &task.id).unwrap().unwrap().permission_mode.as_deref(), Some("acceptEdits"));
            assert_eq!(prompt_message(&s, &id)["mode"], "acceptEdits");

            // Into the thread's default (Ask): its own mode is cleared, and Claude Code goes to Ask by itself.
            let task = s.update_task(&task.id, &[("permission_mode", json!("plan"))]).unwrap().unwrap();
            let (id, told) = asked(&s, &task, "p3", EXIT_PLAN, plan.clone()).await;
            answer(&s, &id, true, false, None, Reply { mode: Some("default".into()), ..Default::default() }).unwrap();
            assert_eq!(told.await.unwrap(), json!({"behavior": "allow", "updatedInput": plan}));
            assert_eq!(db::get_task(&s.db(), &task.id).unwrap().unwrap().permission_mode, None);

            // From a UI that doesn't pick: out of Plan, as before.
            let task = s.update_task(&task.id, &[("permission_mode", json!("plan"))]).unwrap().unwrap();
            let (id, told) = asked(&s, &task, "p4", EXIT_PLAN, plan.clone()).await;
            decide(&s, &id, true, false, None).unwrap();
            assert_eq!(told.await.unwrap()["behavior"], "allow");
            assert_eq!(db::get_task(&s.db(), &task.id).unwrap().unwrap().permission_mode, None);
        });
    }

    #[test]
    fn a_question_or_plan_whose_run_ended_is_answered_by_message() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (task, run) = running_task(&s, None);
            let (id, told) = asked(&s, &task, "c1", ASK_USER, two_questions()).await;
            let (bash, _) = asked(&s, &task, "c2", "Bash", json!({"command": "ls"})).await;
            let (plan, _) = asked(&s, &task, "c3", EXIT_PLAN, json!({"plan": "Do it"})).await;
            // Its run ended (see runner::finish).
            expire_for_task(&s, &task.id);
            assert_eq!(told.await.unwrap(), json!({"behavior": "deny", "message": EXPIRED}));
            // A tool call can't be allowed once its run has ended.
            assert_eq!(decide(&s, &bash, true, false, None).unwrap_err().0, axum::http::StatusCode::CONFLICT);

            // Without a run to take it (and no agents here to start one), the answer isn't sent, and can be given again.
            s.runs.lock().unwrap().remove(&task.id);
            assert!(answer(&s, &id, true, false, None, answers(vec![vec!["Winter"], vec!["Dogs"]])).is_err());
            assert_eq!(prompt_message(&s, &id)["status"], "expired");

            s.runs.lock().unwrap().insert(task.id.clone(), crate::state::RunHandle { run_id: run.id.clone(), cancel: None });
            assert_eq!(answer(&s, &id, true, false, None, answers(vec![vec!["Winter"], vec!["Dogs"]])).unwrap(), "allowed");
            let queued = db::get_task(&s.db(), &task.id).unwrap().unwrap().queued_message.unwrap();
            assert_eq!(queued, "My answers to the questions you asked:\n\n- Which season?\n  Winter\n- Which pets?\n  Dogs");
            let shown = prompt_message(&s, &id);
            assert_eq!((&shown["status"], &shown["late"], &shown["answers"]), (&json!("allowed"), &json!(true), &json!([["Winter"], ["Dogs"]])));
            assert!(answer(&s, &id, true, false, None, answers(vec![vec!["Summer"], vec![]])).is_err());

            // The plan, approved: out of Plan mode, with a message to carry on.
            s.update_task(&task.id, &[("permission_mode", json!("plan")), ("queued_message", Value::Null)]).unwrap();
            answer(&s, &id_of(&s, "c3"), true, false, None, Reply { mode: Some("acceptEdits".into()), ..Default::default() }).unwrap();
            let t = db::get_task(&s.db(), &task.id).unwrap().unwrap();
            assert_eq!((t.permission_mode.as_deref(), t.queued_message.as_deref()), (Some("acceptEdits"), Some("Your plan is approved: go ahead and implement it.")));
            assert_eq!(prompt_message(&s, &plan)["status"], "allowed");
        });
    }

    #[test]
    fn a_question_or_plan_the_conversation_has_moved_past_isnt_answered() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (task, _) = running_task(&s, None);
            s.update_task(&task.id, &[("permission_mode", json!("plan"))]).unwrap();
            let (question, _) = asked(&s, &task, "c1", ASK_USER, two_questions()).await;
            let (plan, _) = asked(&s, &task, "c2", EXIT_PLAN, json!({"plan": "Do it"})).await;
            expire_for_task(&s, &task.id);
            // The user carries on in the thread (here, steering the next run).
            let m = db::insert_message(&s.db(), &task.id, "user", &json!({"text": "Never mind, do this instead"})).unwrap();
            s.emit_message(&m);

            let refused = answer(&s, &question, true, false, None, answers(vec![vec!["Summer"], vec![]])).unwrap_err();
            assert_eq!(refused.0, axum::http::StatusCode::CONFLICT, "{}", refused.1);
            let refused = answer(&s, &plan, true, false, None, Reply { mode: Some("acceptEdits".into()), ..Default::default() }).unwrap_err();
            assert_eq!(refused.0, axum::http::StatusCode::CONFLICT);
            assert!(answer(&s, &plan, false, false, None, Reply { feedback: Some("More".into()), ..Default::default() }).is_err());
            // Nothing was sent, and the thread's still planning.
            let t = db::get_task(&s.db(), &task.id).unwrap().unwrap();
            assert_eq!((t.queued_message, t.permission_mode.as_deref()), (None, Some("plan")));
            assert_eq!((prompt_message(&s, &question)["status"].clone(), prompt_message(&s, &plan)["status"].clone()), (json!("expired"), json!("expired")));
        });
    }

    #[test]
    fn approving_a_plan_in_the_threads_own_mode_keeps_it() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (task, _) = running_task(&s, None);
            // Its own mode is Accept edits (the host's default is Ask), and the agent went into plan mode by itself.
            let task = s.update_task(&task.id, &[("permission_mode", json!("acceptEdits"))]).unwrap().unwrap();
            let plan = json!({"plan": "Do it"});
            let (id, told) = asked(&s, &task, "p1", EXIT_PLAN, plan.clone()).await;
            answer(&s, &id, true, false, None, Reply { mode: Some("acceptEdits".into()), ..Default::default() }).unwrap();
            assert_eq!(told.await.unwrap()["updatedPermissions"], json!([{"type": "setMode", "mode": "acceptEdits", "destination": "session"}]));
            assert_eq!(db::get_task(&s.db(), &task.id).unwrap().unwrap().permission_mode.as_deref(), Some("acceptEdits"));
            // Approved without a pick, as before: it's left alone too.
            let (id, _) = asked(&s, &task, "p2", EXIT_PLAN, plan.clone()).await;
            decide(&s, &id, true, false, None).unwrap();
            assert_eq!(db::get_task(&s.db(), &task.id).unwrap().unwrap().permission_mode.as_deref(), Some("acceptEdits"));
            // Picking the default is a change back to it.
            let (id, _) = asked(&s, &task, "p3", EXIT_PLAN, plan.clone()).await;
            answer(&s, &id, true, false, None, Reply { mode: Some("default".into()), ..Default::default() }).unwrap();
            assert_eq!(db::get_task(&s.db(), &task.id).unwrap().unwrap().permission_mode, None);
            // A thread set to Ask itself stays so (rather than following the host's default from now on).
            let task = s.update_task(&task.id, &[("permission_mode", json!("default"))]).unwrap().unwrap();
            let (id, _) = asked(&s, &task, "p4", EXIT_PLAN, plan).await;
            answer(&s, &id, true, false, None, Reply { mode: Some("default".into()), ..Default::default() }).unwrap();
            assert_eq!(db::get_task(&s.db(), &task.id).unwrap().unwrap().permission_mode.as_deref(), Some("default"));
        });
    }

    #[test]
    fn a_late_approval_leaves_plan_mode_before_its_message_starts_a_run() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (task, run) = running_task(&s, None);
            s.update_task(&task.id, &[("permission_mode", json!("plan"))]).unwrap();
            let (id, _) = asked(&s, &task, "p1", EXIT_PLAN, json!({"plan": "Do it"})).await;
            s.runs.lock().unwrap().remove(&task.id);
            s.db().execute("UPDATE runs SET status='exited' WHERE id=?1", [&run.id]).unwrap();
            expire_for_task(&s, &task.id);
            s.update_task(&task.id, &[("running", json!(false))]).unwrap();

            // No agent can start: the approval isn't taken, and the thread's still planning.
            let approve = || Reply { mode: Some("auto".into()), ..Default::default() };
            assert!(answer(&s, &id, true, false, None, approve()).is_err());
            assert_eq!(db::get_task(&s.db(), &task.id).unwrap().unwrap().permission_mode.as_deref(), Some("plan"));
            assert_eq!(prompt_message(&s, &id)["status"], "expired");

            // One that starts runs with the mode picked, from the run the approval starts.
            crate::runs::TEST_CAN_RUN.set(true);
            let mode = std::rc::Rc::new(std::cell::RefCell::new(None));
            crate::testing::when("run:started", {
                let (s, task_id, mode) = (s.clone(), task.id.clone(), mode.clone());
                move || *mode.borrow_mut() = db::get_task(&s.db(), &task_id).unwrap().unwrap().permission_mode
            });
            let answered = answer(&s, &id, true, false, None, approve());
            crate::runs::TEST_CAN_RUN.set(false);
            answered.unwrap();
            assert_eq!(mode.borrow().as_deref(), Some("auto"));
            runner::stop(&s, &task.id);
        });
    }

    fn id_of(s: &Shared, call_id: &str) -> String {
        s.db().query_row("SELECT id FROM permission_requests WHERE call_id=?1", [call_id], |r| r.get(0)).unwrap()
    }

    #[test]
    fn a_prompt_from_before_answers_were_taken_can_be_answered() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (task, _) = running_task(&s, None);
            // As an older build raised it: no agent in its message, and the MCP call retried after the upgrade finds it.
            let input = two_questions();
            let data = json!({"tool_name": ASK_USER, "input": input, "tool_use_id": null, "request_id": "old", "status": "pending"});
            let msg = s.add_message(&task.id, "permission", data).unwrap();
            s.db()
                .execute(
                    "INSERT INTO permission_requests (id,task_id,message_id,tool_name,input,status,created_at,call_id) VALUES ('old',?1,?2,?3,?4,'pending',?5,'c1')",
                    rusqlite::params![task.id, msg.id, ASK_USER, input.to_string(), now()],
                )
                .unwrap();
            let (id, told) = asked(&s, &task, "c1", ASK_USER, input.clone()).await;
            assert_eq!(id, "old");
            answer(&s, &id, true, false, None, answers(vec![vec!["Summer"], vec!["Cats"]])).unwrap();
            assert_eq!(told.await.unwrap()["updatedInput"]["answers"], json!({"Which season?": "Summer", "Which pets?": "Cats"}));
        });
    }

    #[test]
    fn says_what_a_question_or_plan_waits_for() {
        assert_eq!(reason(ASK_USER, &json!({"questions": [{"question": "Which\n  one?"}]})), "Which one?");
        assert_eq!(reason(CODEX_QUESTIONS, &json!({"questions": [{"question": "A?"}, {"question": "B?"}, {"question": "C?"}]})), "A? (and 2 more questions)");
        assert_eq!(reason(ASK_USER, &json!({})), "The agent has questions for you");
        assert_eq!(reason(EXIT_PLAN, &json!({"plan": "\n## Plan: Add a cache\nSteps"})), "Plan ready for approval: Add a cache");
        assert_eq!(reason(EXIT_PLAN, &json!({"plan": "Just do it"})), "Plan ready for approval");
        assert_eq!(reason("Bash", &json!({})), "Approve Bash?");
    }

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
