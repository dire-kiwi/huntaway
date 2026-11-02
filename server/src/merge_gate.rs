//! Merges that wait for the user's approval (API 92), for profiles and projects that ask for it
//! (`merge_approval`). A task moved to "Ready for merge" first has its agent summarise what it
//! would merge, without merging, outside the merge queue (see runner::start_next_merge). When
//! that run ends, the board asks the user to approve or deny the merge with a question card in
//! the thread (a `question` message with `merge_approval`, kept with its answer). Approved, the
//! task rejoins the merge queue and its agent gets the merge prompt when its turn comes; denied,
//! it goes back to "In review". Until then, the gh server's merges (pr_merge, and `gh pr merge`
//! or the merge API through its other tools) are refused (see `blocked`, gh_mcp::merge_gate).
//! A task's `merge_approval` is `pending` meanwhile, and `approved` after.

use serde_json::{Value, json};

use crate::db::{self, Task};
use crate::state::{ApiError, ApiResult, Shared};

pub const PENDING: &str = "pending";
pub const APPROVED: &str = "approved";

pub const APPROVE: &str = "Approve";
pub const DENY: &str = "Deny";

/// Whether `task`'s merges wait for the user's approval: its project's setting, or else its profile's.
pub fn required(c: &rusqlite::Connection, task: &Task) -> anyhow::Result<bool> {
    let project = match &task.project_id {
        Some(id) => db::get_project(c, id)?,
        None => None,
    };
    if let Some(on) = project.and_then(|p| p.merge_approval) {
        return Ok(on);
    }
    Ok(db::get_profile(c, &task.profile_id)?.is_some_and(|p| p.merge_approval))
}

pub fn is_pending(task: &Task) -> bool {
    task.merge_approval.as_deref() == Some(PENDING)
}

/// A task waiting in the merge queue that has to be summarised and approved before it merges:
/// one that joined the queue (or whose project started asking) without its approval.
pub fn needs_summary(c: &rusqlite::Connection, task: &Task) -> anyhow::Result<bool> {
    Ok(task.merge_approval.is_none() && required(c, task)?)
}

/// Why `task`'s runs can't merge, if they can't: its merge is waiting for the user's approval,
/// or its project asks for approval and it isn't merging (a merge already under way when the
/// setting was turned on carries on). A review thread goes by its task.
pub fn blocked(c: &rusqlite::Connection, task: &Task) -> anyhow::Result<Option<String>> {
    let task = match (task.kind.as_str(), &task.parent_id) {
        ("review", Some(parent)) => match db::get_task(c, parent)? {
            Some(t) => t,
            None => return Ok(None),
        },
        _ => task.clone(),
    };
    Ok(match task.merge_approval.as_deref() {
        Some(APPROVED) => None,
        Some(_) => Some(
            "Merging is disabled: the user hasn't approved this merge yet. Don't merge: summarize what will be merged and end your turn, \
             and the board asks the user to approve it. Once they do, you're asked to merge."
                .into(),
        ),
        None if !task.merging && required(c, &task)? => Some(
            "Merging is disabled: merges in this project need the user's approval, and it hasn't been given. The user approves a merge \
             after the task is moved to \"Ready for merge\" (with update_task, when you're asked to merge it) and its agent has summarized \
             what will be merged."
                .into(),
        ),
        None => None,
    })
}

/// Ask `task`'s agent to summarise what its merge would bring in, without merging.
pub fn request_summary(s: &Shared, task: &Task) -> ApiResult<Task> {
    let project = match &task.project_id {
        Some(pid) => db::get_project(&s.db(), pid)?,
        None => None,
    };
    let base = task.base_branch.clone().or_else(|| project.as_ref().and_then(|p| p.base_branch.clone()));
    let into = base.map(|b| format!("`{b}`")).unwrap_or_else(|| "the base branch".into());
    let what = match &task.branch {
        Some(br) => format!("branch `{br}` into {into}"),
        None => format!("this task's work into {into}"),
    };
    let text = format!(
        "The user moved this task to \"Ready for merge\", and approves each merge before it happens. Summarize what will be merged \
         ({what}): what changes, what it fixes or adds, how it was checked, anything left out or still uncertain, and the pull \
         request if it has one. If there's work the merge would include that isn't committed or pushed yet, commit and push it first, \
         so the summary covers what will be merged.\n\nDo not merge yet: merging is disabled until the user approves. End your turn \
         with the summary, and the board asks the user to approve or deny the merge. Once they approve it, you're asked to merge."
    );
    crate::runner::send_as(s, &task.id, &text, true)
}

/// The summary run ended: ask the user to approve the merge, with a card in the thread.
pub fn ask(s: &Shared, task_id: &str) -> anyhow::Result<()> {
    settle(s, task_id, "replaced");
    let card = json!({
        "question": "Merge this task? Its agent summarized what will be merged above.",
        "options": [
            {"label": APPROVE, "description": "Its agent merges it, once no other task in the project is merging"},
            {"label": DENY, "description": "It isn't merged, and goes back to In review"},
        ],
        "multi_select": false,
        "allow_other": false,
        "merge_approval": true,
        "status": "pending",
    });
    s.add_message(task_id, "question", card)?;
    Ok(())
}

/// Settle `task_id`'s approval cards still waiting for an answer, as `status`: the merge they
/// asked about was left, or a new card replaces them.
pub fn settle(s: &Shared, task_id: &str, status: &str) {
    let pending: Vec<(i64, String)> = {
        let c = s.db();
        let Ok(mut st) = c.prepare(
            "SELECT id, data FROM messages WHERE task_id=?1 AND kind='question' AND json_extract(data, '$.merge_approval')=1
               AND json_extract(data, '$.status')='pending'",
        ) else {
            return;
        };
        st.query_map([task_id], |r| Ok((r.get(0)?, r.get(1)?))).map(|it| it.filter_map(Result::ok).collect()).unwrap_or_default()
    };
    for (id, data) in pending {
        let mut v: Value = serde_json::from_str(&data).unwrap_or(json!({}));
        v["status"] = json!(status);
        let n = s.db().execute(
            "UPDATE messages SET data=?1 WHERE id=?2 AND json_extract(data, '$.status')='pending'",
            rusqlite::params![v.to_string(), id],
        );
        if n.is_ok_and(|n| n > 0) {
            crate::questions::emit(s, id);
        }
    }
}

/// The user's answer to an approval card: approved, the task rejoins the merge queue (and its
/// agent is asked to merge when its turn comes); denied, it goes back to "In review".
pub fn decide(s: &Shared, task_id: &str, approve: bool) -> ApiResult<Task> {
    let mut refused = None;
    let still = |c: &rusqlite::Connection| -> anyhow::Result<bool> {
        let now = db::get_task(c, task_id)?;
        refused = match &now {
            None => Some(ApiError::not_found("task")),
            Some(t) if !is_pending(t) || !t.merging => Some(ApiError::conflict("the task isn't waiting for its merge to be approved any more")),
            Some(t) if t.running || db::has_active_run(c, task_id)? => {
                Some(ApiError::conflict("its agent is still running; approve the merge once it's done"))
            }
            Some(_) => None,
        };
        Ok(refused.is_none())
    };
    let fields: Vec<(&str, Value)> = if approve {
        vec![("merge_approval", json!(APPROVED)), ("status", json!("ready_for_merge")), ("attention_reason", Value::Null)]
    } else {
        vec![("merging", json!(false)), ("status", json!("in_review")), ("attention_reason", Value::Null)]
    };
    let updated = s.update_task_if(task_id, &fields, still)?;
    if let Some(e) = refused {
        return Err(e);
    }
    let t = updated.ok_or_else(|| ApiError::not_found("task"))?;
    if approve {
        s.add_event(task_id, "info", "Merge approved: it merges once no other task in the project is merging", None);
    } else {
        s.add_event(task_id, "info", "Merge denied: back in review", None);
    }
    crate::runner::start_next_merge(s, t.project_id.as_deref());
    Ok(db::get_task(&s.db(), task_id)?.unwrap_or(t))
}
