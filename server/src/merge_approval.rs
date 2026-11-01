//! Approval for a particular trip through the merge queue. Decisions live on the task;
//! the summary, question and answer remain in its thread across restarts.
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::db::{self, Task};
use crate::state::{ApiError, ApiResult, Shared};

pub const DISABLED: &str = "pr_merge is disabled: the merge has not been approved yet. Summarise what will be merged and call request_merge_approval with the current merge_approval.id from get_task. Ordinary request_user_input questions do not approve merges. Wait for the user to approve the merge card before merging.";
pub const PROMPT: &str = "The user moved this task to \"Ready for merge\". Summarise what will be merged, including the target branch, the changes and their impact, validation, and any risks or outstanding work. Do not merge yet. Call `request_merge_approval` with your summary and the merge attempt ID below, then end your turn. Use `request_user_input` for any ordinary clarification or permission questions; their answers do not approve the merge. The board stores the decision and will send the merge instructions only after the user approves. pr_merge is disabled until then.";

pub fn prompt(approval: &Approval) -> String {
    format!("{PROMPT}\n\nMerge attempt ID (`attempt_id`): `{}`.", approval.id)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Approval {
    pub id: String,
    pub decision: String,
}

impl Approval {
    pub fn pending() -> Self {
        Self { id: crate::util::new_id(), decision: "pending".into() }
    }
}

pub fn enabled(c: &Connection, task: &Task) -> anyhow::Result<bool> {
    if let Some(p) = task.project_id.as_deref().map(|id| db::get_project(c, id)).transpose()?.flatten() {
        if let Some(on) = p.summarize_merge { return Ok(on); }
    }
    Ok(db::get_profile(c, &task.profile_id)?.is_some_and(|p| p.summarize_merge))
}

pub fn disabled(c: &Connection, task: &Task) -> anyhow::Result<bool> {
    if let Some(a) = &task.merge_approval {
        return Ok(!task.merging || a.decision != "approved");
    }
    enabled(c, task)
}

/// Also cover a merge already queued/running when the user enables the setting.
pub fn ensure(s: &Shared, task: &Task) -> anyhow::Result<Task> {
    if task.merging && task.merge_approval.is_none() && enabled(&s.db(), task)? {
        let pending = Approval::pending();
        s.update_task_if(&task.id, &[("merge_approval", json!(pending))], |c| {
            Ok(db::get_task(c, &task.id)?.is_some_and(|t| t.merging && t.merge_approval.is_none()) && enabled(c, task)?)
        })?;
        return Ok(db::get_task(&s.db(), &task.id)?.unwrap_or_else(|| task.clone()));
    }
    Ok(task.clone())
}

/// Only this explicit tool makes a merge approval card. Ordinary questions remain ordinary,
/// even when they happen to offer Approve / Deny while a merge is pending.
pub fn card(task: &Task, args: &Value) -> Result<Value, String> {
    let approval = task.merge_approval.as_ref().filter(|a| task.merging && a.decision == "pending")
        .ok_or("this task has no pending merge approval; move it to Ready for merge first")?;
    if args["attempt_id"].as_str() != Some(approval.id.as_str()) {
        return Err(format!("this merge attempt is no longer current; the pending attempt_id is {}", approval.id));
    }
    let summary = args["summary"].as_str().map(str::trim).filter(|s| !s.is_empty()).ok_or("request_merge_approval needs a non-empty merge summary")?;
    Ok(json!({
        "question": format!("Approve this merge?\n\n{summary}"),
        "purpose": "merge_approval",
        "merge_approval_id": approval.id,
        "options": [{"label": "Approve"}, {"label": "Deny"}],
        "allow_other": false,
        "multi_select": false,
    }))
}

/// Called only from the user's answer route, never from agent tools or a free-text reply.
pub fn answer(s: &Shared, task_id: &str, attempt: &str, approve: bool) -> ApiResult<Task> {
    let t = db::get_task(&s.db(), task_id)?.ok_or_else(|| ApiError::not_found("task"))?;
    let mut approval = t.merge_approval.clone().ok_or_else(|| ApiError::conflict("this merge approval is no longer current"))?;
    approval.decision = if approve { "approved" } else { "denied" }.into();
    // Compute instructions before committing the answer, so a failed read leaves it answerable.
    let prompt = if approve { Some(crate::runner::merge_prompt(s, &t)?) } else { None };
    let mut fields = vec![("merge_approval", json!(approval))];
    if !approve {
        fields.extend([("status", json!("in_review")), ("merging", json!(false)), ("attention_reason", Value::Null)]);
    }
    let changed = s.update_task_if(task_id, &fields, |c| {
        Ok(db::get_task(c, task_id)?.is_some_and(|t| t.merging && t.merge_approval.is_some_and(|a| a.id == attempt && a.decision == "pending")))
    })?.ok_or_else(|| ApiError::conflict("this merge approval is no longer current"))?;
    if let Some(prompt) = prompt {
        match crate::runner::send(s, task_id, &prompt) {
            Ok(t) => Ok(t),
            Err(e) => {
                // A stopped/offline agent can be retried without granting a stranded approval.
                let _ = s.update_task_if(task_id, &[("merge_approval", json!(t.merge_approval))], |c| {
                    Ok(db::get_task(c, task_id)?.is_some_and(|t| t.merge_approval.is_some_and(|a| a.id == attempt && a.decision == "approved")))
                });
                Err(e)
            }
        }
    } else {
        s.db().execute("UPDATE runs SET attention=NULL WHERE task_id=?1 AND status IN ('preparing','running')", [task_id])?;
        crate::runner::start_next_merge(s, changed.project_id.as_deref());
        Ok(changed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{questions, testing, tools};

    fn setup(s: &Shared) -> (Task, db::Run) {
        let c = s.db();
        let p = db::insert_profile(&c, "p", &[], None).unwrap();
        db::update_profile(&c, &p.id, &[("summarize_merge", json!(true))]).unwrap();
        db::insert_project(&c, db::NewProject { id: "pr", profile_id: &p.id, name: "P", key: "P", repo_path: "/x",
            scratch_path: "/s", worktrees_root: "/w", base_branch: Some("master"), use_worktrees: false }).unwrap();
        let t = db::insert_task(&c, db::NewTask { profile_id: &p.id, project_id: Some("pr"), kind: "task", title: "t", description: "",
            status: "in_review", use_worktree: false, model: None, effort: None, claude_config_id: None }).unwrap();
        let t = db::update_task(&c, &t.id, &[("status", json!("ready_for_merge")), ("merging", json!(true))]).unwrap().unwrap();
        let run = db::insert_run(&c, &t.id, "prompt").unwrap();
        c.execute("UPDATE runs SET status='running' WHERE id=?1", [&run.id]).unwrap();
        s.runs.lock().unwrap().insert(t.id.clone(), crate::state::RunHandle { run_id: run.id.clone(), cancel: None });
        (t, run)
    }

    async fn ask(s: &Shared, run: &db::Run, call_id: &str) -> db::Message {
        let task = db::get_task(&s.db(), &run.task_id).unwrap().unwrap();
        tools::handle_mcp(s, tools::McpCall { run_id: run.id.clone(), call_id: call_id.into(), tool: "request_merge_approval".into(),
            args: json!({"summary": "Merge into master: adds merge approval. Tests pass.", "attempt_id": task.merge_approval.unwrap().id}), task_fields: true }).await.unwrap();
        db::list_messages(&s.db(), &run.task_id).unwrap().into_iter().filter(|m| m.kind == "question").last().unwrap()
    }

    fn pick(s: &Shared, task: &Task, question: &db::Message, choice: &str) -> ApiResult<Task> {
        questions::answer(s, &task.id, question.id, questions::Answer { choices: vec![choice.into()], text: None })
    }

    #[test]
    fn ordinary_questions_keep_their_answers_and_do_not_approve_a_merge() {
        testing::run(async || {
            for (question, options, choice) in [
                ("May I enable network access to fetch the PR before writing the merge summary?", json!([{"label": "Approve"}, {"label": "Deny"}]), "Approve"),
                ("Which target branch should I inspect?", json!([{"label": "master", "description": "Default branch"}, {"label": "release"}]), "release"),
            ] {
                let s = testing::state();
                let (t, run) = setup(&s);
                tools::handle_mcp(&s, tools::McpCall { run_id: run.id.clone(), call_id: "ordinary".into(), tool: "request_user_input".into(),
                    args: json!({"question": question, "options": options, "allow_other": true}), task_fields: true }).await.unwrap();
                let q = db::list_messages(&s.db(), &t.id).unwrap().into_iter().find(|m| m.kind == "question").unwrap();
                assert_eq!(q.data["options"], options);
                assert!(q.data["merge_approval_id"].is_null());
                assert_eq!(q.data["allow_other"], true);
                let answered = pick(&s, &t, &q, choice).unwrap();
                assert_eq!(answered.merge_approval.as_ref().unwrap().decision, "pending");
                assert!(disabled(&s.db(), &answered).unwrap());
                assert_eq!(answered.queued_message.as_deref(), Some(questions::reply_text(question, &[choice.into()], None).as_str()));
            }
        });
    }

    #[test]
    fn explicit_approvals_require_a_summary_and_the_current_pending_attempt() {
        testing::run(async || {
            let s = testing::state();
            let (t, run) = setup(&s);
            let attempt = t.merge_approval.as_ref().unwrap().id.clone();
            for (i, args) in [
                json!({"summary": "Merge this change into master."}),
                json!({"attempt_id": attempt, "summary": "  "}),
                json!({"attempt_id": "old-attempt", "summary": "Merge this change into master."}),
            ].into_iter().enumerate() {
                assert!(tools::handle_mcp(&s, tools::McpCall { run_id: run.id.clone(), call_id: format!("invalid-{i}"), tool: "request_merge_approval".into(),
                    args, task_fields: true }).await.is_err());
            }
            assert!(!db::list_messages(&s.db(), &t.id).unwrap().iter().any(|m| m.kind == "question"));
            let q = ask(&s, &run, "valid").await;
            assert_eq!(q.data["purpose"], "merge_approval");
            assert!(q.data["question"].as_str().unwrap().starts_with("Approve this merge?"));
            assert!(prompt(t.merge_approval.as_ref().unwrap()).contains(&attempt));
            // Retrying a tool call after a restart still produces only one card.
            s.db().execute("UPDATE mcp_calls SET status='executing' WHERE id='valid'", []).unwrap();
            ask(&s, &run, "valid").await;
            assert_eq!(db::list_messages(&s.db(), &t.id).unwrap().iter().filter(|m| m.kind == "question").count(), 1);
            s.update_task(&t.id, &[("merging", json!(false))]).unwrap();
            s.update_task(&t.id, &[("merging", json!(true))]).unwrap();
            assert!(pick(&s, &t, &q, "Approve").is_err());
            let current = db::get_task(&s.db(), &t.id).unwrap().unwrap();
            assert!(card(&current, &json!({"attempt_id": attempt, "summary": "Old summary"})).is_err());
            let leaving = s.update_task(&t.id, &[("merging", json!(false))]).unwrap().unwrap();
            assert!(card(&leaving, &json!({"attempt_id": leaving.merge_approval.as_ref().unwrap().id, "summary": "Summary"})).is_err());
        });
    }

    #[test]
    fn legacy_implicitly_tagged_questions_cannot_grant_merge_approval() {
        testing::run(async || {
            let s = testing::state();
            let (t, _) = setup(&s);
            let mut legacy = questions::card(&json!({"question": "May I enable network access?", "options": ["Approve", "Deny"], "allow_other": false})).unwrap();
            legacy["merge_approval_id"] = json!(t.merge_approval.as_ref().unwrap().id);
            questions::ask(&s, &t, "legacy", legacy).unwrap();
            let q = db::list_messages(&s.db(), &t.id).unwrap().into_iter().find(|m| m.kind == "question").unwrap();
            assert!(pick(&s, &t, &q, "Approve").unwrap_err().1.contains("predates explicit merge summaries"));
            let reloaded = db::get_task(&s.db(), &t.id).unwrap().unwrap();
            assert_eq!(reloaded.merge_approval.as_ref().unwrap().decision, "pending");
            assert!(disabled(&s.db(), &reloaded).unwrap());
            assert!(reloaded.queued_message.is_none());
        });
    }

    #[test]
    fn approval_is_stored_and_only_the_card_releases_the_merge_prompt() {
        testing::run(async || {
            let s = testing::state();
            let (t, run) = setup(&s);
            assert!(disabled(&s.db(), &t).unwrap());
            let q = ask(&s, &run, "q").await;
            assert_eq!(q.data["options"], json!([{"label": "Approve"}, {"label": "Deny"}]));
            assert_eq!(q.data["merge_approval_id"], json!(t.merge_approval.as_ref().unwrap().id));
            assert!(questions::answer(&s, &t.id, q.id, questions::Answer { choices: vec![], text: Some("Approve".into()) }).is_err());
            let approved = pick(&s, &t, &q, "Approve").unwrap();
            assert!(!disabled(&s.db(), &approved).unwrap());
            let prompt = approved.queued_message.as_deref().unwrap();
            assert!(prompt.contains("Merge this task's work into `master`"), "{prompt}");
            assert!(prompt.contains(crate::prompts::DEFAULT_MERGE));
            assert_eq!(db::get_task(&s.db(), &t.id).unwrap().unwrap().merge_approval.unwrap().decision, "approved");
            let q = db::list_messages(&s.db(), &t.id).unwrap().into_iter().find(|m| m.id == q.id).unwrap();
            assert_eq!(q.data["answer"]["choices"], json!(["Approve"]));
            assert!(pick(&s, &t, &q, "Approve").is_err());
            // Stepping out for changes and rejoining creates a new attempt, never reuses consent.
            s.update_task(&t.id, &[("status", json!("in_progress")), ("merging", json!(false))]).unwrap();
            let again = s.update_task(&t.id, &[("status", json!("ready_for_merge")), ("merging", json!(true))]).unwrap().unwrap();
            assert!(disabled(&s.db(), &again).unwrap());
            assert_ne!(again.merge_approval.unwrap().id, t.merge_approval.unwrap().id);
        });
    }

    #[test]
    fn denial_frees_the_queue_and_stale_questions_cannot_approve_another_attempt() {
        testing::run(async || {
            let s = testing::state();
            let (t, run) = setup(&s);
            let q = ask(&s, &run, "q").await;
            let stale = ask(&s, &run, "q2").await;
            let denied = pick(&s, &t, &q, "Deny").unwrap();
            assert_eq!((denied.status.as_str(), denied.merging, denied.queued_message.clone()), ("in_review", false, None));
            assert_eq!(denied.merge_approval.as_ref().unwrap().decision, "denied");
            assert!(disabled(&s.db(), &denied).unwrap());
            let again = s.update_task(&t.id, &[("status", json!("ready_for_merge")), ("merging", json!(true))]).unwrap().unwrap();
            assert!(answer(&s, &t.id, stale.data["merge_approval_id"].as_str().unwrap(), true).is_err());
            assert!(disabled(&s.db(), &again).unwrap());
        });
    }

    #[test]
    fn free_reply_and_failed_send_never_grant_approval() {
        testing::run(async || {
            let s = testing::state();
            let (t, run) = setup(&s);
            let q = ask(&s, &run, "q").await;
            questions::replied(&s, &t.id);
            assert!(pick(&s, &t, &q, "Approve").is_err());
            let reloaded = db::get_task(&s.db(), &t.id).unwrap().unwrap();
            assert!(disabled(&s.db(), &reloaded).unwrap());
            let q = ask(&s, &run, "q2").await;
            s.runs.lock().unwrap().remove(&t.id);
            assert!(pick(&s, &t, &q, "Approve").is_err());
            let reloaded = db::get_task(&s.db(), &t.id).unwrap().unwrap();
            assert_eq!(reloaded.merge_approval.unwrap().decision, "pending");
            let q = db::list_messages(&s.db(), &t.id).unwrap().into_iter().find(|m| m.id == q.id).unwrap();
            assert_eq!(q.data["status"], "pending");
        });
    }

    #[test]
    fn projects_inherit_or_override_the_profile_and_disabled_projects_keep_the_old_flow() {
        testing::run(async || {
            let s = testing::state();
            let (t, _) = setup(&s);
            assert!(enabled(&s.db(), &t).unwrap());
            db::update_project(&s.db(), "pr", &[("summarize_merge", json!(false))]).unwrap();
            assert!(!enabled(&s.db(), &t).unwrap());
            // A pending attempt remains gated even when the setting is turned off.
            assert!(disabled(&s.db(), &t).unwrap());
            s.update_task(&t.id, &[("merging", json!(false))]).unwrap();
            let legacy = s.update_task(&t.id, &[("merging", json!(true))]).unwrap().unwrap();
            assert!(legacy.merge_approval.is_none());
            assert!(!disabled(&s.db(), &legacy).unwrap());
            db::update_project(&s.db(), "pr", &[("summarize_merge", Value::Null)]).unwrap();
            assert!(enabled(&s.db(), &t).unwrap());
            db::update_profile(&s.db(), &t.profile_id, &[("summarize_merge", json!(false))]).unwrap();
            assert!(!enabled(&s.db(), &t).unwrap());
            db::update_project(&s.db(), "pr", &[("summarize_merge", json!(true))]).unwrap();
            assert!(enabled(&s.db(), &t).unwrap());
            // Turning it on during a previously ungated merge must still offer a usable card.
            let pending = ensure(&s, &legacy).unwrap();
            assert_eq!(pending.merge_approval.unwrap().decision, "pending");
        });
    }
}
