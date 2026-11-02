//! Taking checkpoints: before each run and after each turn, and dropping a task's.

use super::*;

/// Whether a run of `task` takes checkpoints.
fn wanted(state: &Shared, task: &Task, run: &Run) -> bool {
    run.kind != "compact" && own_worktree(state, task).is_some()
}

/// Before a run of `task` starts (its worktree set up): a checkpoint, if the files or HEAD have
/// changed since the last one.
pub async fn before_run(state: &Shared, task: &Task, run: &Run) {
    if !wanted(state, task, run) {
        return;
    }
    let (task_id, run_id, session) = (task.id.clone(), run.id.clone(), task.session_id.clone());
    let done = queued(state, &task.id, move |s| async move {
        let top = worktree_top(&s, &task_id).await?.context("no worktree")?;
        let last = latest(&s.db(), &task_id)?;
        let snap = snapshot(&top, last.as_ref()).await?;
        if last.as_ref().is_some_and(|l| l.tree == snap.tree && l.head == snap.head) {
            return Ok(());
        }
        keep(&s, &task_id, &top, &snap, |n| Checkpoint {
            n,
            kind: "start".into(),
            sha: snap.sha.clone(),
            tree: snap.tree.clone(),
            head: snap.head.clone(),
            before_n: None,
            run_id: Some(run_id),
            turn: None,
            message_id: None,
            status: None,
            session,
            agent_at: None,
            stats: None,
            stale: 0,
            created_at: now(),
        })
        .await?;
        prune(&s, &task_id, &top).await
    })
    .await;
    if let Err(e) = done.and_then(|r| r) {
        tracing::warn!(task = %task.id, "couldn't take a checkpoint before the run: {e:#}");
    }
}

/// One of the agent's turns in run `run_id` ended (`status`: done, stopped or failed): a checkpoint
/// of what it left, taken in the background.
pub fn after_turn(state: &Shared, run_id: &str, status: &str) {
    let found = (|| {
        let c = state.db();
        let Some(run) = db::get_run(&c, run_id)? else { return Ok(None) };
        let task = db::get_task(&c, &run.task_id)?;
        anyhow::Ok(task.map(|t| (run, t)))
    })();
    let (run, task) = match found {
        Ok(Some(found)) => found,
        Ok(None) => return,
        Err(e) => return tracing::warn!(run = run_id, "couldn't look up a run for its checkpoint: {e:#}"),
    };
    // A turn the agent starts by itself (a background task finishing, say) didn't start with a message.
    let _ = state.db().execute("UPDATE runs SET turn_message_id=NULL WHERE id=?1", [run_id]);
    if !wanted(state, &task, &run) {
        return;
    }
    let task_id = task.id.clone();
    let status = status.to_string();
    let job = move |s: Shared| async move {
        let taken = async {
            let top = worktree_top(&s, &task_id).await?.context("no worktree")?;
            let before = latest(&s.db(), &task_id)?;
            let snap = snapshot(&top, before.as_ref()).await?;
            let stats = match &before {
                Some(b) => match stats(&top, b, &snap).await {
                    Ok(st) => Some(st),
                    Err(e) => {
                        tracing::warn!(task = %task_id, "couldn't count a turn's changes: {e:#}");
                        None
                    }
                },
                None => None,
            };
            let turn: i64 = s.db().query_row("SELECT COALESCE(MAX(turn), 0) + 1 FROM checkpoints WHERE task_id=?1", [&task_id], |r| r.get(0))?;
            keep(&s, &task_id, &top, &snap, |n| Checkpoint {
                n,
                kind: "turn".into(),
                sha: snap.sha.clone(),
                tree: snap.tree.clone(),
                head: snap.head.clone(),
                before_n: before.map(|b| b.n),
                run_id: Some(run.id),
                turn: Some(turn),
                message_id: run.turn_message_id,
                status: Some(status),
                session: task.session_id,
                agent_at: run.agent_at,
                stats,
                stale: 0,
                created_at: now(),
            })
            .await?;
            prune(&s, &task_id, &top).await?;
            s.emit(json!({"type": "checkpoints", "task_id": task_id}));
            anyhow::Ok(())
        };
        if let Err(e) = taken.await {
            tracing::warn!(task = %task_id, "couldn't take a checkpoint after a turn: {e:#}");
        }
    };
    enqueue(state, &task.id, Box::new(move |s| Box::pin(job(s))));
}

/// Drop the task's checkpoints (its worktree at `dir` is going), after any being taken.
pub async fn forget(state: &Shared, task_id: &str, dir: &Path) {
    let id = task_id.to_string();
    let dir = dir.to_path_buf();
    let done = queued(state, task_id, move |s| async move {
        let refs = run_ok(&dir, &["for-each-ref", "--format=delete %(refname)", &ref_prefix(&id)], &[], None).await?;
        if !refs.stdout.is_empty() {
            run_ok(&dir, &["update-ref", "--stdin"], &[], Some(&refs.stdout)).await?;
        }
        s.db().execute("DELETE FROM checkpoints WHERE task_id=?1", [&id])?;
        anyhow::Ok(())
    })
    .await;
    if let Err(e) = done.and_then(|r| r) {
        tracing::warn!(task = task_id, "couldn't drop the task's checkpoints: {e:#}");
    }
}
