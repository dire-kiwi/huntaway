//! The merge queue: tasks moved to "Ready for merge" merge one at a time (see `request_merge`).

use super::*;

/// Other tasks wait to merge while this one does, so a merge that turns out to need changes
/// steps out of the queue to make them (see Task::remerge).
const STEP_OUT: &str = "Tasks queued to merge after this one wait while you merge it. Bringing the branch up to date, resolving \
    simple conflicts, waiting for checks and re-running flaky ones are part of merging. But if the merge needs changes to this task's \
    work (checks that fail because of it, review comments to address, conflicts that need more than a simple resolution), step out of \
    the merge queue first so the next task can merge meanwhile: call `update_task` to set this task's status to `in_progress`, with \
    `remerge` true. Then make the changes, check them, commit and push, and end your turn without merging: the board puts the task \
    back at the end of the merge queue and asks you to merge again when its turn comes.";

/// Why a task whose merge waits for the user's approval needs attention.
pub(super) const APPROVAL: &str = "Approve or deny the merge";

/// Ask the agent on a task that was moved to "Ready for merge" to merge its work. The task
/// stays in that column while it does; the agent moves it to "Done" once merged.
pub fn request_merge(state: &Shared, task: &Task) -> ApiResult<Task> {
    let (project, open) = {
        let c = state.db();
        let project = match &task.project_id {
            Some(pid) => db::get_project(&c, pid)?,
            None => None,
        };
        let open: Vec<Task> = if task.subproject {
            db::subproject_tasks(&c, &task.id)?.into_iter().filter(|t| t.status != "done" && !t.is_scratch()).collect()
        } else {
            Vec::new()
        };
        (project, open)
    };
    let base = task.base_branch.clone().or_else(|| project.as_ref().and_then(|p| p.base_branch.clone()));
    let into = base.map(|b| format!("`{b}`")).unwrap_or_else(|| "the base branch".into());
    let what = match &task.branch {
        Some(br) => format!("Merge branch `{br}` into {into}"),
        None => format!("Merge this task's work into {into}"),
    };
    let approved = if task.merge_approval.as_deref() == Some(crate::merge_gate::APPROVED) { " The user approved the merge." } else { "" };
    let mut text = format!(
        "The user moved this task to \"Ready for merge\".{approved} {what}.\n\n{}\n\nIf you can't merge, call `request_user_input` \
         explaining why. Once it is merged, call `update_task` to set this task's status to `done`.\n\n{STEP_OUT}",
        crate::prompts::merge(project.as_ref())
    );
    if task.subproject {
        let key = project.as_ref().map(|p| p.key.as_str()).unwrap_or("T");
        text.push_str(" This is a subproject: its tasks were merged into its branch, so bring the branch up to date first (pull it if it's on the remote, where their pull requests were merged).");
        if !open.is_empty() {
            let list: Vec<String> = open.iter().map(|t| format!("{key}-{} ({}, {})", t.number, t.title, t.status.replace('_', " "))).collect();
            text.push_str(&format!(
                " Some of its tasks aren't done yet: {}. Ask the user (with `request_user_input`) whether to merge without them before you merge.",
                list.join("; ")
            ));
        }
    }
    send_as(state, &task.id, &text, true)
}

/// Held while picking a project's next merge, so two merges can't take its slot at once.
static MERGE_SLOT: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Merges run one at a time per branch they merge into: the project's top-level tasks share one
/// slot, and each subproject's tasks share another. A task moved to "Ready for merge" waits
/// there, in column order, while another task in its slot is merging (running, or waiting on
/// the user in "Needs attention"). Call this whenever a merge may have ended or been queued: it
/// asks the next waiting task's agent to merge wherever a slot in the project is free. A task
/// whose merge needs the user's approval first has its agent summarise it straight away, without
/// waiting for the slot, and waits for the approval out of the queue (see merge_gate.rs).
pub fn start_next_merge(state: &Shared, project_id: Option<&str>) {
    if !runs::can_run_agents(state) {
        return;
    }
    let _slot = MERGE_SLOT.lock().unwrap_or_else(|e| e.into_inner());
    let lanes = match db::merge_lanes(&state.db(), project_id) {
        Ok(l) => l,
        Err(e) => return tracing::error!("checking the merge queue: {e:#}"),
    };
    for lane in lanes {
        // The tasks to summarise for approval, and the next to merge if the slot is free.
        let next = (|| -> anyhow::Result<(Vec<Task>, Option<Task>)> {
            let c = state.db();
            let free = db::active_merge(&c, project_id, lane.as_deref())?.is_none();
            let (mut summarise, mut next) = (Vec::new(), None);
            for t in db::queued_merges(&c, project_id, lane.as_deref())? {
                if crate::merge_gate::needs_summary(&c, &t)? {
                    summarise.push(t);
                } else if free && next.is_none() {
                    next = Some(t);
                }
            }
            Ok((summarise, next))
        })();
        let (summarise, next) = match next {
            Ok(n) => n,
            Err(e) => {
                tracing::error!("checking the merge queue: {e:#}");
                continue;
            }
        };
        for t in summarise {
            // Out of the queue until the user decides (see db::queued_merges).
            if let Err(e) = state.update_task(&t.id, &[("merge_approval", json!(crate::merge_gate::PENDING))]) {
                tracing::error!(task = t.id, "asking for a merge's approval: {e:#}");
                continue;
            }
            state.add_event(&t.id, "info", "The merge waits for your approval: its agent summarizes what will be merged first", None);
            if let Err(e) = crate::merge_gate::request_summary(state, &t) {
                let reason = format!("Couldn't ask for a summary of the merge: {}", e.1);
                state.add_event(&t.id, "error", reason.clone(), None);
                let _ = state.update_task(&t.id, &[("status", json!("needs_attention")), ("attention_reason", json!(reason))]);
            }
        }
        let Some(next) = next else { continue };
        if let Err(e) = request_merge(state, &next) {
            // Stays merging, so the queue waits for the user to sort it out.
            let reason = format!("Couldn't start the merge: {}", e.1);
            state.add_event(&next.id, "error", reason.clone(), None);
            let _ = state.update_task(&next.id, &[("status", json!("needs_attention")), ("attention_reason", json!(reason))]);
        }
    }
}

/// Start the merges that were waiting when the server stopped.
pub(super) fn start_queued_merges(state: &Shared) {
    let projects = db::projects_with_queued_merges(&state.db());
    match projects {
        Ok(projects) => projects.iter().for_each(|p| start_next_merge(state, p.as_deref())),
        Err(e) => tracing::error!("checking the merge queue: {e:#}"),
    }
}
