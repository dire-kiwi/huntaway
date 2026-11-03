//! Routines: a profile's automations, which wake its assistant (see agent/assistant.rs).
//!
//! A routine's message goes either to the assistant's own thread (`thread`, as `send_to_task`
//! does), or by default (`fresh`) to a new thread under it (`parent_id`, `task_type` `routine`,
//! off the board), which works in the assistant's workspace with its tools, config and model.
//! When that thread's agent stops, its last message is posted in the assistant's thread as a
//! report (a `report` message), unless it's `NO_REPLY` or empty: a quiet run says nothing. The
//! assistant reads the reports it hasn't seen with the user's next message (see `unread_reports`),
//! so the routine's work stays out of its context. Routine threads are pruned after `KEEP_THREAD_DAYS`.

use super::*;
use crate::agent::runner::Outcome as RunOutcome;
use crate::db::Task;

/// What a routine's agent says when it has nothing to report.
pub const NO_REPLY: &str = "NO_REPLY";
/// How long a precheck may run before it's stopped (and the run fails).
const PRECHECK_LIMIT: Duration = Duration::from_secs(120);
/// What a precheck prints that a template gets, at most.
const MAX_PRECHECK_CHARS: usize = 20_000;
/// Finished routine threads older than this are deleted (their runs and reports stay).
pub const KEEP_THREAD_DAYS: i64 = 14;
/// A report in the assistant's thread is cut to this.
const MAX_REPORT_CHARS: usize = 20_000;

/// Sends routine `a`'s message to its profile's assistant, `mode` deciding where: the thread it
/// made or messaged.
pub(super) fn message(s: &Shared, a: &Automation, vars: &Vars, how: &str, message: &str, mode: AssistantMode) -> Result<Option<String>, Outcome> {
    let fail = |e: ApiError| Outcome::Failed(None, e.1);
    let assistant = assistant::get_or_create(s, &a.profile_id).map_err(fail)?;
    let (body, untrusted) = render(message, vars, Out::Text);
    let note = if untrusted { untrusted_note(vars, false) } else { String::new() };
    match mode {
        AssistantMode::Thread => {
            let text = format!("From your routine \"{}\", {how}:\n\n{note}{}", a.name, body.trim());
            crate::agent::runner::send_from_agent(s, &assistant.id, &text).map_err(|e| Outcome::Failed(Some(assistant.id.clone()), e.1))?;
            Ok(Some(assistant.id))
        }
        AssistantMode::Fresh => {
            let when = vars.now.with_timezone(&Local).format("%a %-d %b %H:%M");
            let thread = db::insert_routine_task(&s.db(), &assistant, &format!("{} · {when}", a.name)).map_err(|e| Outcome::Failed(None, format!("{e:#}")))?;
            s.emit_task(&thread);
            #[cfg(test)]
            crate::testing::reached("routine:thread");
            let text = format!(
                "This is a run of your routine \"{}\", {how} ({when}), in a thread of its own (A-{}).\n\n{note}{}\n\n\
                 When you're done, reply with a short report for the user: it's posted to your main thread. If there's nothing \
                 new or worth telling them, reply with just {NO_REPLY}, and nothing is posted.",
                a.name,
                thread.number,
                body.trim()
            );
            if let Err(e) = crate::agent::runner::send_from_agent(s, &thread.id, &text) {
                // It never started (the host can't run agents, say): an empty thread would only be in the way.
                let _ = s.db().execute("DELETE FROM tasks WHERE id=?1 AND running=0", [&thread.id]);
                s.emit(json!({"type": "task_deleted", "id": thread.id, "project_id": Value::Null}));
                return Err(Outcome::Failed(None, e.1));
            }
            Ok(Some(thread.id))
        }
    }
}

/// Whether a routine's last message says it has nothing to report: empty, or `NO_REPLY` (on its
/// own, or as its last line, in backticks or bold or not).
pub fn is_quiet(text: &str) -> bool {
    let last = text.lines().map(str::trim).rfind(|l| !l.is_empty());
    last.is_none_or(|l| l.trim_matches(|c: char| "`*_.\"' ".contains(c)) == NO_REPLY)
}

/// The start of `day` in `tz`, as a UTC time (the first moment of it, past any gap).
fn day_start<Tz: TimeZone>(now: DateTime<Utc>, tz: &Tz) -> DateTime<Utc> {
    let date = now.with_timezone(tz).date_naive();
    (0..24 * 60)
        .find_map(|m| tz.from_local_datetime(&(date.and_time(NaiveTime::MIN) + chrono::TimeDelta::minutes(m))).earliest())
        .map(|t| t.with_timezone(&Utc))
        .unwrap_or(now)
}

/// What an automation's runs today (in `tz`) have cost: those that have ended as they recorded
/// it, and those whose thread is still working, as far as they've got.
pub fn spent_today<Tz: TimeZone>(c: &Connection, automation_id: &str, now: DateTime<Utc>, tz: &Tz) -> rusqlite::Result<f64> {
    c.query_row(
        "SELECT COALESCE(SUM(COALESCE(r.cost_usd, t.cost_usd, 0)), 0) FROM automation_runs r
           LEFT JOIN tasks t ON t.id = r.task_id AND t.task_type = 'routine'
         WHERE r.automation_id = ?1 AND r.created_at >= ?2",
        params![automation_id, fmt(day_start(now, tz))],
        |r| r.get(0),
    )
}

/// What all of an automation's runs kept have cost.
pub fn spent(c: &Connection, automation_id: &str) -> rusqlite::Result<f64> {
    c.query_row(
        "SELECT COALESCE(SUM(COALESCE(r.cost_usd, t.cost_usd, 0)), 0) FROM automation_runs r
           LEFT JOIN tasks t ON t.id = r.task_id AND t.task_type = 'routine'
         WHERE r.automation_id = ?1",
        [automation_id],
        |r| r.get(0),
    )
}

/// A routine's thread from an earlier run that's still working, if any: another run waits for it.
pub(super) fn still_running(c: &Connection, a: &Automation) -> rusqlite::Result<Option<Task>> {
    if !matches!(a.action, Action::MessageAssistant { mode: AssistantMode::Fresh, .. }) {
        return Ok(None);
    }
    let id: Option<String> = c
        .query_row(
            "SELECT t.id FROM automation_runs r JOIN tasks t ON t.id = r.task_id
             WHERE r.automation_id = ?1 AND t.task_type = 'routine' AND t.running = 1 ORDER BY r.created_at DESC LIMIT 1",
            [&a.id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(id.and_then(|id| db::get_task(c, &id).ok().flatten()))
}

/// Where a precheck runs: the assistant's workspace for a routine, the project's folder for a
/// project's automation.
fn precheck_dir(s: &Shared, a: &Automation) -> Result<std::path::PathBuf, Outcome> {
    let fail = |e: String| Outcome::Failed(None, format!("couldn't run its precheck: {e}"));
    match &a.project_id {
        Some(id) => {
            let p = db::get_project(&s.db(), id).map_err(|e| fail(format!("{e:#}")))?.ok_or_else(|| fail("the project is gone".into()))?;
            Ok(crate::util::expand_tilde(&p.repo_path))
        }
        None => {
            let t = assistant::get_or_create(s, &a.profile_id).map_err(|e| fail(e.1))?;
            crate::agent::documents::work_dir(s, &t).ok_or_else(|| fail("the assistant has no workspace".into()))
        }
    }
}

/// Runs an automation's precheck (with bash, in `precheck_dir`, for up to `PRECHECK_LIMIT`):
/// exit 0 goes on, with what it printed for `{{precheck}}`; exit 1 skips the run; anything else fails it.
pub(super) async fn precheck(s: &Shared, a: &Automation, cmd: &str) -> Result<String, Outcome> {
    let dir = precheck_dir(s, a)?;
    let mut c = tokio::process::Command::new("bash");
    c.arg("-c").arg(cmd).current_dir(&dir).stdin(std::process::Stdio::null());
    let out = crate::git::worktree::run_limited(c, PRECHECK_LIMIT).await.map_err(|e| Outcome::Failed(None, format!("its precheck failed: {e:#}")))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let tail = |t: &str| crate::util::truncate(t, 2000);
    match out.status.code() {
        Some(0) => Ok(cut(&stdout, MAX_PRECHECK_CHARS)),
        Some(1) => {
            let said = [stdout.as_str(), stderr.as_str()].into_iter().find(|t| !t.is_empty()).map(|t| format!(": {}", tail(t))).unwrap_or_default();
            Err(Outcome::Skipped(format!("Skipped: its precheck found nothing to do (exit 1){said}")))
        }
        _ => {
            let said = if stderr.is_empty() { tail(&stdout) } else { tail(&stderr) };
            Err(Outcome::Failed(None, format!("its precheck failed ({}){}", out.status, if said.is_empty() { String::new() } else { format!(": {said}") })))
        }
    }
}

/// The run a routine thread is for.
fn run_of(c: &Connection, task_id: &str) -> rusqlite::Result<Option<Run>> {
    c.query_row("SELECT * FROM automation_runs WHERE task_id=?1 ORDER BY created_at DESC, rowid DESC LIMIT 1", [task_id], Run::from_row).optional()
}

/// A routine thread's agent stopped (see runner::output): its report goes to the assistant,
/// unless it had nothing to say, and its run records how it ended and what it cost.
pub fn finished(s: &Shared, thread: &Task, outcome: &RunOutcome, attention: Option<&str>) {
    let Some(assistant_id) = thread.parent_id.as_deref() else { return };
    let run = match run_of(&s.db(), &thread.id) {
        Ok(r) => r,
        Err(e) => return tracing::error!(task = %thread.id, "finding a routine thread's run: {e}"),
    };
    let automation = run.as_ref().and_then(|r| get(&s.db(), &r.automation_id).ok().flatten());
    let name = automation.as_ref().map(|a| a.name.clone()).unwrap_or_else(|| thread.title.split(" · ").next().unwrap_or(&thread.title).to_string());
    let (kind, text) = match (outcome, attention) {
        (RunOutcome::Cancelled, _) => ("stopped", None),
        (RunOutcome::Failed(e), _) => ("failed", Some(e.lines().next().unwrap_or("").to_string())),
        (RunOutcome::Ok, Some(q)) => ("asked", Some(q.to_string())),
        (RunOutcome::Ok, None) => {
            let asked: i64 = s.db().query_row("SELECT COALESCE(MAX(id), 0) FROM messages WHERE task_id=?1 AND kind='user'", [&thread.id], |r| r.get(0)).unwrap_or(0);
            let said = db::last_assistant_text_after(&s.db(), &thread.id, asked).ok().flatten().unwrap_or_default();
            if is_quiet(&said) { ("quiet", None) } else { ("reported", Some(cut(said.trim(), MAX_REPORT_CHARS))) }
        }
    };
    if let Some(text) = &text {
        let data = json!({
            "automation_id": automation.as_ref().map(|a| a.id.clone()),
            "automation": name,
            "task_id": thread.id,
            "key": format!("{}-{}", db::ASSISTANT_TASK_KEY, thread.number),
            "outcome": kind,
            "text": text,
        });
        if let Err(e) = s.add_message(assistant_id, "report", data) {
            tracing::error!(task = %thread.id, "posting a routine's report: {e:#}");
        }
    }
    if let Some(run) = run {
        let cost = db::get_task(&s.db(), &thread.id).ok().flatten().map(|t| t.cost_usd).unwrap_or(thread.cost_usd);
        let _ = s.db().execute("UPDATE automation_runs SET outcome=?2, cost_usd=?3 WHERE id=?1", params![run.id, kind, cost]);
        if let Some(a) = &automation {
            changed(s, a);
        }
    }
}

/// The reports posted in the assistant's thread since it last read them, as a preface for its
/// next prompt, and marks them read; none if there are none.
pub fn unread_reports(s: &Shared, assistant_id: &str) -> Option<String> {
    let reports: Vec<db::Message> = {
        let c = s.db();
        let mut st = c
            .prepare("SELECT * FROM messages WHERE task_id=?1 AND kind='report' AND json_extract(data,'$.read') IS NOT 1 ORDER BY id")
            .ok()?;
        st.query_map([assistant_id], db::Message::from_row).ok()?.filter_map(Result::ok).collect()
    };
    if reports.is_empty() {
        return None;
    }
    let mut text = String::from("Since your last turn, your routines posted these in this thread (the user has seen them):\n");
    for m in &reports {
        let d = &m.data;
        let at = parse_time(&m.created_at).map(|t| t.with_timezone(&Local).format("%a %H:%M").to_string()).unwrap_or_default();
        let what = match d["outcome"].as_str() {
            Some("failed") => "failed",
            Some("asked") => "is waiting for the user",
            _ => "reported",
        };
        text.push_str(&format!(
            "\n### \"{}\" {what} ({}, {at})\n\n{}\n",
            d["automation"].as_str().unwrap_or("A routine"),
            d["key"].as_str().unwrap_or(""),
            d["text"].as_str().unwrap_or("").trim()
        ));
        let mut read = d.clone();
        read["read"] = json!(true);
        let _ = db::update_message_data(&s.db(), m.id, &read);
    }
    text.push_str("\n---\n\n");
    Some(text)
}

/// Deletes routine threads that finished more than KEEP_THREAD_DAYS ago (their runs and reports
/// stay; the assistant's workspace, which they worked in, is the assistant's).
pub async fn prune_threads(s: &Shared, now: DateTime<Utc>) {
    let cutoff = fmt(now - chrono::TimeDelta::days(KEEP_THREAD_DAYS));
    let old = match db::old_routine_tasks(&s.db(), &cutoff) {
        Ok(t) => t,
        Err(e) => return tracing::error!("finding old routine threads: {e:#}"),
    };
    for t in old {
        if let Err(e) = crate::api::delete_one(s, &t, false).await {
            tracing::warn!(task = %t.id, "pruning an old routine thread: {}", e.1);
        }
    }
}
