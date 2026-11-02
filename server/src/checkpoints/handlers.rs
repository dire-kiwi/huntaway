//! The API: a task's turns, a turn's diff, and rewinding.

use super::*;

/// The text a message starts with, for a turn's label.
fn message_label(data: &Value) -> String {
    let text = data["user_text"].as_str().or(data["text"].as_str()).unwrap_or("");
    truncate(text.trim(), 300)
}

/// `GET /tasks/{id}/turns`: the task's turns with checkpoints, oldest first, what each changed,
/// and whether each can be rewound to (and its conversation with it).
pub async fn turns(State(s): State<Shared>, UrlPath(id): UrlPath<String>) -> ApiResult<Json<Value>> {
    let task = db::get_task(&s.db(), &id)?.ok_or_else(|| ApiError::not_found("task"))?;
    let Some(top) = worktree_top(&s, &id).await? else {
        let reason = if task.use_worktree { "the task's worktree isn't set up" } else { "the task works in its project's repository, not a worktree of its own" };
        return Ok(Json(json!({"available": false, "reason": reason, "turns": [], "rewind": task.rewind})));
    };
    let rows = list(&s.db(), &id)?;
    let have: HashSet<i64> = {
        let o = run(&top, &["for-each-ref", "--format=%(refname:lstrip=-1)", &ref_prefix(&id)], &[], None).await?;
        String::from_utf8_lossy(&o.stdout).lines().filter_map(|l| l.trim().parse().ok()).collect()
    };
    let ids: Vec<i64> = rows.iter().filter_map(|r| r.message_id).collect();
    let messages: HashMap<i64, Value> = {
        let c = s.db();
        let mut st = c.prepare("SELECT data FROM messages WHERE id=?1 AND task_id=?2")?;
        ids.iter().filter_map(|m| st.query_row(params![m, id], |r| r.get::<_, String>(0)).ok().map(|d| (*m, serde_json::from_str(&d).unwrap_or(Value::Null)))).collect()
    };
    let first_user: Option<i64> = s.db().query_row("SELECT MIN(id) FROM messages WHERE task_id=?1 AND kind='user'", [&id], |r| r.get(0))?;
    let codex = db::task_is_codex(&s.db(), &task)?;
    let running = s.is_running(&id);
    let turns: Vec<Value> = rows
        .iter()
        .filter(|r| r.kind == "turn")
        .map(|r| {
            let before = r.before_n.filter(|b| have.contains(b) && rows.iter().any(|x| x.n == *b));
            let diff = before.is_some() && have.contains(&r.n);
            let m = r.message_id.and_then(|m| messages.get(&m));
            let files = match (before, r.message_id, r.stale) {
                _ if running => Err("the agent is running"),
                (_, _, stale) if stale > 0 => Err("a rewind has gone back to before this turn"),
                (None, _, _) => Err("there's no checkpoint from before this turn"),
                (_, None, _) => Err("the message this turn started with isn't known"),
                _ => Ok(()),
            };
            let conversation = match conversation(&task, &rows, r, codex, first_user) {
                Ok(c) => json!({"ok": true, "fresh": matches!(c, Convo::Fresh)}),
                Err(why) => json!({"ok": false, "reason": why}),
            };
            json!({
                "turn": r.turn,
                "n": r.n,
                "before_n": before,
                "run_id": r.run_id,
                "message_id": r.message_id,
                "text": m.map(message_label).unwrap_or_default(),
                "auto": m.is_some_and(|m| m["auto"] == true),
                "review_round": m.and_then(|m| m["review_round"].as_u64()),
                "status": r.status,
                "stale": r.stale > 0,
                "at": r.created_at,
                "head": r.head,
                "before_head": before.and_then(|b| rows.iter().find(|x| x.n == b)).and_then(|b| b.head.clone()),
                "stats": r.stats,
                "diff": diff,
                "rewind": match files { Ok(()) => json!({"ok": true, "conversation": conversation}), Err(why) => json!({"ok": false, "reason": why}) },
            })
        })
        .collect();
    let head = head(&top).await?;
    Ok(Json(json!({"available": true, "turns": turns, "head": head, "rewind": task.rewind, "agent": if codex { "codex" } else { "claude" }})))
}

#[derive(Deserialize)]
pub struct DiffQuery {
    pub(super) from: i64,
    pub(super) to: i64,
}

/// `GET /tasks/{id}/turns/diff?from=&to=`: the changes from checkpoint `from` to `to` (a turn's,
/// or several turns' together), without the files git brought in.
pub async fn diff(State(s): State<Shared>, UrlPath(id): UrlPath<String>, Query(q): Query<DiffQuery>) -> ApiResult<Json<Value>> {
    let top = worktree_top(&s, &id).await?.ok_or_else(|| ApiError::bad("the task has no worktree"))?;
    let rows = list(&s.db(), &id)?;
    let find = |n: i64| rows.iter().find(|r| r.n == n).ok_or_else(|| ApiError::not_found(&format!("checkpoint {n}")));
    let (from, to) = (find(q.from)?, find(q.to)?);
    for r in [from, to] {
        let o = run(&top, &["rev-parse", "-q", "--verify", &format!("{}^{{commit}}", ref_name(&id, r.n))], &[], None).await?;
        if !o.ok || o.text() != r.sha {
            return Err(ApiError::conflict(format!("checkpoint {} is gone from the repository", r.n)));
        }
    }
    let excluded = brought_in(&top, from.head.as_deref(), to.head.as_deref(), &to.tree).await?;
    let (stats, left_out) = numstat(&top, &from.sha, &to.sha, &excluded).await?;
    let o = run_ok(&top, &["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", &from.sha, &to.sha, "--"], &[], None).await?;
    let patch = without(&String::from_utf8_lossy(&o.stdout), &left_out.iter().cloned().collect());
    let too_large = patch.len() > MAX_DIFF;
    Ok(Json(json!({
        "patch": if too_large { String::new() } else { patch },
        "too_large": too_large,
        "stats": stats,
        "excluded": left_out,
    })))
}

/// What a rewind does to the agent's conversation.
#[derive(Debug, PartialEq)]
pub(super) enum Convo {
    /// There's none yet.
    Nothing,
    /// The message started it: the next one starts a new one.
    Fresh,
    /// Its next run takes it back.
    Back(Rewind),
}

/// How the agent's conversation goes back to before turn `turn` of `rows` (the task's
/// checkpoints), or why it can't. `first_user` is the thread's first user message.
pub(super) fn conversation(task: &Task, rows: &[Checkpoint], turn: &Checkpoint, codex: bool, first_user: Option<i64>) -> Result<Convo, String> {
    let Some(session) = task.session_id.clone() else { return Ok(Convo::Nothing) };
    let (Some(n), Some(message_id)) = (turn.turn, turn.message_id) else { return Err("the message this turn started with isn't known".into()) };
    let back = |resume_at: Option<String>, before_turn: Option<String>| Convo::Back(Rewind { turn: n, message_id, session: session.clone(), resume_at, before_turn });
    let changed = "the agent's conversation has changed since this message (a new session)";
    // The message started it: the next one starts a new one (with the task's description, as the first does).
    if first_user == Some(message_id) {
        return Ok(Convo::Fresh);
    }
    if codex {
        // Codex reverts the thread to before the turn itself.
        return match (&turn.session, &turn.agent_at) {
            (Some(s), Some(t)) if *s == session => Ok(back(None, Some(t.clone()))),
            (Some(s), _) if *s != session => Err(changed.into()),
            _ => Err("Codex didn't say which of its turns this was".into()),
        };
    }
    // Claude resumes its session at the last message of the turn before, skipping turns already taken out of it.
    for r in rows.iter().rev().filter(|r| r.kind == "turn" && r.n < turn.n && r.stale < 2) {
        if r.session.as_deref() != Some(&session) {
            return Err(changed.into());
        }
        if let Some(at) = &r.agent_at {
            return Ok(back(Some(at.clone()), None));
        }
    }
    Err("the conversation from before this message wasn't recorded (it's from before checkpoints were taken)".into())
}

#[derive(Deserialize)]
pub struct RewindBody {
    /// The user message to rewind to before.
    pub(super) message_id: i64,
    /// Take the agent's conversation back too.
    #[serde(default)]
    pub(super) conversation: bool,
    /// Move the branch back to where it was, if commits have been made since.
    #[serde(default)]
    pub(super) branch: bool,
}

/// `POST /tasks/{id}/rewind {message_id, conversation, branch}`: restore the task's files to the
/// checkpoint from before the turn `message_id` started, and optionally its branch and its agent's
/// conversation (on its next run). Refused while its agent or a review of it is running.
pub async fn rewind(State(s): State<Shared>, UrlPath(id): UrlPath<String>, Json(b): Json<RewindBody>) -> ApiResult<Json<Value>> {
    db::get_task(&s.db(), &id)?.ok_or_else(|| ApiError::not_found("task"))?;
    let task_id = id.clone();
    let out = queued(&s, &id, move |s| async move { rewind_now(&s, &task_id, &b).await }).await??;
    Ok(Json(out))
}

fn busy(state: &Shared, task_id: &str) -> Result<Option<&'static str>> {
    if state.is_running(task_id) {
        return Ok(Some("The agent is running: stop it before rewinding"));
    }
    let reviews = db::review_threads(&state.db(), task_id)?;
    if reviews.iter().any(|r| r.running || state.is_running(&r.id)) {
        return Ok(Some("A review of the task is running in its worktree: wait for it or stop it first"));
    }
    Ok(None)
}

async fn rewind_now(state: &Shared, task_id: &str, b: &RewindBody) -> ApiResult<Value> {
    let task = db::get_task(&state.db(), task_id)?.ok_or_else(|| ApiError::not_found("task"))?;
    if let Some(why) = busy(state, task_id)? {
        return Err(ApiError::conflict(why));
    }
    let top = worktree_top(state, task_id).await?.ok_or_else(|| ApiError::bad("the task has no worktree of its own to rewind"))?;
    let git_dir = PathBuf::from(run_ok(&top, &["rev-parse", "--absolute-git-dir"], &[], None).await?.text());
    if ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD"].iter().any(|f| git_dir.join(f).exists()) {
        return Err(ApiError::conflict("A merge, rebase or cherry-pick is in progress in the worktree: finish or abort it first"));
    }
    let rows = list(&state.db(), task_id)?;
    // The first turn the message started (the agent may have gone on by itself after it).
    let turn = rows
        .iter()
        .find(|r| r.kind == "turn" && r.message_id == Some(b.message_id) && r.stale == 0)
        .ok_or_else(|| ApiError::bad("there's no checkpoint for this message's turn (or a rewind has gone back past it)"))?;
    let before = turn.before_n.and_then(|n| rows.iter().find(|r| r.n == n)).ok_or_else(|| ApiError::conflict("there's no checkpoint from before this turn"))?;
    let o = run(&top, &["rev-parse", "-q", "--verify", &format!("{}^{{commit}}", ref_name(task_id, before.n))], &[], None).await?;
    if !o.ok || o.text() != before.sha {
        return Err(ApiError::conflict("the checkpoint from before this turn is gone from the repository"));
    }
    let convo = if b.conversation {
        let first_user: Option<i64> = state.db().query_row("SELECT MIN(id) FROM messages WHERE task_id=?1 AND kind='user'", [task_id], |r| r.get(0))?;
        let codex = db::task_is_codex(&state.db(), &task)?;
        conversation(&task, &rows, turn, codex, first_user).map_err(|why| ApiError::conflict(format!("Can't take the conversation back: {why}")))?
    } else {
        Convo::Nothing
    };

    // The files as they are now, kept (stale) so the rewind can be undone by hand.
    let last = latest(&state.db(), task_id)?;
    let snap = snapshot(&top, last.as_ref()).await?;
    let kept = keep(state, task_id, &top, &snap, |n| Checkpoint {
        n,
        kind: "rewind".into(),
        sha: snap.sha.clone(),
        tree: snap.tree.clone(),
        head: snap.head.clone(),
        before_n: None,
        run_id: None,
        turn: None,
        message_id: None,
        status: None,
        session: task.session_id.clone(),
        agent_at: None,
        stats: None,
        stale: 1,
        created_at: now(),
    })
    .await?;

    // The branch goes back once the files have: checked first, so a refusal leaves everything as it was.
    let moved = match (&before.head, &snap.head) {
        (Some(old), Some(cur)) if b.branch && old != cur => {
            let ancestor = run(&top, &["merge-base", "--is-ancestor", old, cur], &[], None).await?.ok;
            if !ancestor {
                return Err(ApiError::conflict("The branch has been rewritten since (a rebase or reset), so it can't be moved back: rewind the files only"));
            }
            Some((old.clone(), cur.clone()))
        }
        _ => None,
    };
    let kept_ref = ref_name(task_id, kept.n);
    let failed = |e: anyhow::Error| ApiError::conflict(format!("The rewind stopped part way: {e:#}. The files as they were are kept in {kept_ref} ({}).", kept.sha));
    let restored = restore(&top, &snap.tree, &before.tree).await.map_err(failed)?;
    let mut unstage = restored.changed.clone();
    if let Some((old, cur)) = &moved {
        run_ok(&top, &["reset", "-q", "--soft", old], &[], None).await.map_err(failed)?;
        unstage.extend(names(&top, old, cur).await.map_err(failed)?.into_iter().filter(|p| !restored.hidden.contains(p)));
    }
    unstaged(&top, &unstage).await.map_err(failed)?;

    let stale = if matches!(convo, Convo::Nothing) { 1 } else { 2 };
    state.db().execute("UPDATE checkpoints SET stale=MAX(stale, ?3) WHERE task_id=?1 AND n>?2 AND n<>?4", params![task_id, before.n, stale, kept.n])?;
    let n = turn.turn.unwrap_or(0);
    let said_convo = match &convo {
        Convo::Nothing if b.conversation => "; the agent had no conversation to take back",
        Convo::Nothing => "; the agent's conversation is kept as it is",
        Convo::Fresh => "; the next message starts a new conversation",
        Convo::Back(_) => "; the agent's next run goes on from before that message",
    };
    let fields: Vec<(&str, Value)> = match convo {
        Convo::Nothing => vec![],
        Convo::Fresh => vec![("session_id", Value::Null), ("rewind", Value::Null), ("context", Value::Null)],
        Convo::Back(r) => vec![("rewind", serde_json::to_value(r).unwrap_or(Value::Null))],
    };
    state.update_task(task_id, &fields)?;
    let branch = moved.as_ref().map(|(old, cur)| format!("; the branch is back at {} (from {})", &old[..old.len().min(8)], &cur[..cur.len().min(8)])).unwrap_or_default();
    let mut detail = format!("The files as they were are kept in {} ({}).", ref_name(task_id, kept.n), kept.sha);
    if !restored.skipped.is_empty() {
        detail.push_str(&format!(
            "\nLeft as they are (submodules and other repositories, files marked skip-worktree or assume-unchanged, and files or folders the \
             checkpoints don't have, such as ignored ones): {}",
            restored.skipped.join(", ")
        ));
    }
    state.add_event(
        task_id,
        "info",
        format!("Rewound to before turn {n}: {} restored, {} removed{branch}{said_convo}", plural(restored.written, "file"), plural(restored.removed, "file")),
        Some(detail),
    );
    state.emit(json!({"type": "checkpoints", "task_id": task_id}));
    let task = db::get_task(&state.db(), task_id)?;
    // The message, for the user to edit and send again.
    let message: Option<String> = state.db().query_row("SELECT data FROM messages WHERE id=?1 AND task_id=?2", params![b.message_id, task_id], |r| r.get(0)).optional()?;
    let message = message.and_then(|d| serde_json::from_str::<Value>(&d).ok()).unwrap_or(Value::Null);
    Ok(json!({
        "message": {"text": message["user_text"].as_str().or(message["text"].as_str()), "auto": message["auto"] == true},
        "task": task,
        "written": restored.written,
        "removed": restored.removed,
        "skipped": restored.skipped,
        "branch": moved.map(|(old, cur)| json!({"from": cur, "to": old})),
        "kept": ref_name(task_id, kept.n),
    }))
}

fn plural(n: usize, what: &str) -> String {
    format!("{n} {what}{}", if n == 1 { "" } else { "s" })
}

/// `DELETE /tasks/{id}/rewind`: the agent's next run keeps its conversation as it is.
pub async fn cancel_rewind(State(s): State<Shared>, UrlPath(id): UrlPath<String>) -> ApiResult<Json<Value>> {
    let task = s.update_task(&id, &[("rewind", Value::Null)])?.ok_or_else(|| ApiError::not_found("task"))?;
    Ok(Json(json!(task)))
}
