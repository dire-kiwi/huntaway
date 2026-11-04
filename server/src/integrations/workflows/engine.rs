//! Running a workflow on a task: starting a run from its trigger, following the graph from node to node, and the
//! agent steps' threads (their verdicts, their ends, and stopping them).

use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;

use super::prompt::{self, Work};
use super::*;
use crate::agent::runner::{self, Outcome};
use crate::git::worktree;

/// Held while starting a run, so two can't start for one workflow on one task at once.
static STARTING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Held while changing a run (never while stopping an agent, which can end up back here, or across an await).
static UPDATING: Mutex<()> = Mutex::new(());

fn updating() -> std::sync::MutexGuard<'static, ()> {
    UPDATING.lock().unwrap_or_else(|e| e.into_inner())
}

/// (task, workflow) pairs whose move step is moving the task, so the move doesn't start the same workflow again.
static MOVING: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

/// Whether `thread` is a workflow's agent thread.
pub fn is_workflow(thread: &db::Task) -> bool {
    thread.kind == "review" && thread.task_type.as_deref() == Some(WORKFLOW)
}

/// The task's workflow runs changed: the board reads them again.
pub fn runs_changed(s: &Shared, task_id: &str) {
    s.emit(json!({"type": "workflow_runs_changed", "task_id": task_id}));
}

fn task_key(c: &Connection, t: &db::Task) -> String {
    let key = t.project_id.as_deref().and_then(|p| db::get_project(c, p).ok().flatten()).map(|p| p.key).unwrap_or_else(|| "T".into());
    format!("{key}-{}", t.number)
}

/// The task entered the column it's in: start the project's workflows that trigger on that, in the background.
pub fn on_status(s: &Shared, task: &db::Task) {
    if task.kind != "task" {
        return;
    }
    let Some(pid) = task.project_id.as_deref() else { return };
    let moving: Vec<String> = MOVING.lock().unwrap_or_else(|e| e.into_inner()).iter().filter(|(t, _)| *t == task.id).map(|(_, w)| w.clone()).collect();
    let due: Vec<Workflow> = match list(&s.db(), pid) {
        Ok(all) => all.into_iter().filter(|w| w.enabled && w.graph.trigger_status() == Some(task.status.as_str()) && !moving.contains(&w.id)).collect(),
        Err(e) => {
            tracing::error!(task = %task.id, "reading workflows: {e}");
            return;
        }
    };
    for w in due {
        let (s, id, name) = (s.clone(), task.id.clone(), w.name.clone());
        tokio::spawn(async move {
            if let Err(e) = start(&s, &w.id, &id, false).await {
                s.add_event(&id, "warn", format!("Couldn't run the workflow \"{name}\""), Some(e.1));
            }
        });
    }
}

fn skip<T>(manual: bool, why: impl Into<String>) -> ApiResult<Option<T>> {
    if manual { Err(ApiError::conflict(format!("Can't run the workflow: {}", why.into()))) } else { Ok(None) }
}

async fn rev_parse(dir: &Path, rev: &str) -> Option<String> {
    let o = worktree::git(dir, &["rev-parse", "--verify", rev]).await.ok()?;
    o.ok.then(|| o.stdout.trim().to_string()).filter(|s| !s.is_empty())
}

/// Run workflow `workflow_id` on task `task_id`. `manual` (the user, or an agent, asked for it) runs it whether or not
/// it's on or its trigger matches, with fresh rounds, and says why when it can't. Returns the run, or None when there was
/// nothing to do.
pub async fn start(s: &Shared, workflow_id: &str, task_id: &str, manual: bool) -> ApiResult<Option<Run>> {
    let _starting = STARTING.lock().await;
    let w = get(&s.db(), workflow_id)?.ok_or_else(|| ApiError::not_found("workflow"))?;
    let task = db::get_task(&s.db(), task_id)?.ok_or_else(|| ApiError::not_found("task"))?;
    if task.kind != "task" || task.project_id.as_deref() != Some(w.project_id.as_str()) {
        return Err(ApiError::bad("a workflow runs only on its own project's tasks"));
    }
    let project = db::get_project(&s.db(), &w.project_id)?.ok_or_else(|| ApiError::not_found("project"))?;
    if project.archived_at.is_some() {
        return skip(manual, "the project is archived");
    }
    if !manual && (!w.enabled || w.graph.trigger_status() != Some(task.status.as_str())) {
        return Ok(None);
    }
    // Read before the check that it isn't running, so a run that starts in between counts as later (see below).
    let task_run = db::latest_run(&s.db(), &task.id, None)?;
    if s.is_running(&task.id) {
        return skip(manual, "the task's agent is still working");
    }
    let previous = latest_run(&s.db(), &w.id, &task.id)?;
    if previous.as_ref().is_some_and(|r| r.state == "running") {
        return skip(manual, "it's already running on this task");
    }
    let head = match task.worktree_path.as_deref().filter(|_| task.worktree_state == "ready") {
        Some(dir) => rev_parse(Path::new(dir), "HEAD").await,
        None => None,
    };
    let at = now();
    let mut nodes = BTreeMap::new();
    for n in &w.graph.nodes {
        let r = match n.kind {
            NodeKind::Trigger { .. } => NodeRun { state: "done".into(), port: Some("out".into()), started_at: Some(at.clone()), finished_at: Some(at.clone()), ..Default::default() },
            _ => NodeRun { state: "pending".into(), ..Default::default() },
        };
        nodes.insert(n.id.clone(), r);
    }
    let run = Run {
        id: new_id(),
        workflow_id: w.id.clone(),
        task_id: task.id.clone(),
        source: if manual { "manual" } else { "status" }.into(),
        state: "running".into(),
        head,
        task_run: task_run.clone(),
        graph: w.graph.clone(),
        nodes,
        rounds: if manual { BTreeMap::new() } else { previous.map(|p| p.rounds).unwrap_or_default() },
        detail: None,
        created_at: at.clone(),
        updated_at: at.clone(),
        finished_at: None,
    };
    {
        let _g = updating();
        // The agent may have started again while git was read: `supersede` found no run to stop then.
        let c = s.db();
        if db::later_run(&c, &task.id, task_run.as_deref().unwrap_or_default())? || s.is_running(&task.id) {
            return skip(manual, "the task's agent is working again");
        }
        insert_run(&c, &run)?;
    }
    s.add_event(&task.id, "info", format!("Running the workflow \"{}\"", w.name), None);
    runs_changed(s, &task.id);
    advance(s, &run.id).await;
    Ok(get_run(&s.db(), &run.id)?)
}

/// Marks the nodes whose inputs have all settled as running (to run now) or skipped, until none are left to decide.
/// Returns those to run.
pub(super) fn plan(run: &mut Run) -> Vec<String> {
    let at = now();
    loop {
        let (mut ready, mut changed) = (Vec::new(), false);
        for n in &run.graph.nodes {
            if run.node(&n.id).state != "pending" {
                continue;
            }
            let incoming: Vec<&Edge> = run.graph.edges.iter().filter(|e| e.to == n.id).collect();
            if !incoming.iter().all(|e| run.node(&e.from).settled()) {
                continue;
            }
            let taken = incoming
                .iter()
                .filter(|e| {
                    let from = run.node(&e.from);
                    from.state != "skipped" && from.port.as_deref() == Some(e.port.as_str())
                })
                .count();
            let go = taken > 0 && (n.join == Join::Any || taken == incoming.len());
            let r = run.nodes.entry(n.id.clone()).or_default();
            if go {
                r.state = "running".into();
                r.started_at = Some(at.clone());
                ready.push(n.id.clone());
            } else {
                r.state = "skipped".into();
            }
            changed = true;
        }
        if !ready.is_empty() || !changed {
            return ready;
        }
    }
}

/// Ends the run once no node is left to run: its sends that weren't reached give their rounds back.
fn settle(run: &mut Run) -> bool {
    if run.state != "running" || run.graph.nodes.iter().any(|n| !run.node(&n.id).settled()) {
        return false;
    }
    for n in &run.graph.nodes {
        if matches!(n.kind, NodeKind::SendToTask { .. }) && run.node(&n.id).state == "skipped" {
            run.rounds.remove(&n.id);
        }
    }
    run.state = "done".into();
    run.finished_at = Some(now());
    run.updated_at = now();
    true
}

/// What a node did.
pub(super) struct Done {
    pub state: &'static str,
    pub port: Option<&'static str>,
    pub text: Option<String>,
}

impl Done {
    fn port(port: &'static str) -> Self {
        Done { state: "done", port: Some(port), text: None }
    }

    fn failed(why: impl Into<String>) -> Self {
        Done { state: "failed", port: Some("failed"), text: Some(why.into()) }
    }
}

/// Records what node `id` did, if the run is still going and the node still running. Returns the run as saved.
fn record(s: &Shared, run_id: &str, id: &str, done: Done) -> Option<Run> {
    let _g = updating();
    let mut run = get_run(&s.db(), run_id).ok().flatten()?;
    if run.state != "running" || run.node(id).state != "running" {
        return None;
    }
    let r = run.nodes.entry(id.to_string()).or_default();
    // A node that has no such port (a condition can't fail) only ends.
    r.state = done.state.into();
    r.port = done.port.map(String::from);
    if done.text.is_some() {
        r.text = done.text;
    }
    r.finished_at = Some(now());
    run.updated_at = now();
    save(s, &run);
    Some(run)
}

fn save(s: &Shared, run: &Run) {
    if let Err(e) = save_run(&s.db(), run) {
        tracing::error!(run = %run.id, "saving a workflow run: {e}");
    }
    runs_changed(s, &run.task_id);
}

/// Runs what's ready to run, until the run waits only on its agents or has ended.
pub(super) async fn advance(s: &Shared, run_id: &str) {
    loop {
        let (run, ready) = {
            let _g = updating();
            let Some(mut run) = get_run(&s.db(), run_id).ok().flatten() else { return };
            if run.state != "running" {
                return;
            }
            let ready = plan(&mut run);
            let ended = settle(&mut run);
            save(s, &run);
            if ended {
                drop(_g);
                ended_run(s, &run);
                return;
            }
            (run, ready)
        };
        if ready.is_empty() {
            return;
        }
        for id in ready {
            let Some(node) = run.graph.node(&id).cloned() else { continue };
            let done = match &node.kind {
                NodeKind::Trigger { .. } => Some(Done::port("out")),
                NodeKind::Condition { check, value } => Some(match condition(s, &run, *check, value.as_deref()).await {
                    Ok(yes) => Done::port(if yes { "yes" } else { "no" }),
                    Err(e) => Done { state: "failed", port: None, text: Some(e) },
                }),
                NodeKind::Agent { .. } => start_agent(s, &run, &node).await.err().map(Done::failed),
                NodeKind::SendToTask { message, max_rounds } => send(s, &run, &node, message, *max_rounds),
                NodeKind::SetStatus { status } => Some(move_task(s, &run, status).await),
            };
            if let Some(done) = done {
                record(s, run_id, &id, done);
            }
        }
    }
}

/// The run has ended: say how on the task.
fn ended_run(s: &Shared, run: &Run) {
    let name = get(&s.db(), &run.workflow_id).ok().flatten().map(|w| w.name).unwrap_or_default();
    let failed: Vec<String> = run
        .graph
        .nodes
        .iter()
        .filter(|n| run.node(&n.id).state == "failed")
        .map(|n| format!("{}: {}", node_name(n), run.node(&n.id).text.unwrap_or_default()))
        .collect();
    if failed.is_empty() {
        s.add_event(&run.task_id, "info", format!("The workflow \"{name}\" finished"), None);
    } else {
        s.add_event(&run.task_id, "warn", format!("The workflow \"{name}\" finished with steps that failed"), Some(failed.join("\n")));
    }
}

/// How a node reads in events: an agent step's name, or its kind.
pub fn node_name(n: &Node) -> String {
    match &n.kind {
        NodeKind::Agent { name, .. } => name.clone(),
        NodeKind::Trigger { .. } => "Trigger".into(),
        NodeKind::Condition { .. } => "Condition".into(),
        NodeKind::SendToTask { .. } => "Send to the task's agent".into(),
        NodeKind::SetStatus { .. } => "Move the task".into(),
    }
}

async fn condition(s: &Shared, run: &Run, check: Check, value: Option<&str>) -> Result<bool, String> {
    let task = db::get_task(&s.db(), &run.task_id).map_err(|e| format!("{e:#}"))?.ok_or("the task is gone")?;
    match check {
        Check::HasPr => Ok(task.pr_url.as_deref().is_some_and(|u| !u.trim().is_empty())),
        Check::TaskType => Ok(task.task_type.as_deref().unwrap_or("code") == value.unwrap_or("code")),
        Check::Label => Ok(value.is_some_and(|l| task.labels.iter().any(|t| t == l))),
        Check::HasCommits => Ok(!elsewhere(s, &task).await?.1),
        // A run by hand is asked for whatever changed.
        Check::Changed if run.source == "manual" => Ok(true),
        Check::Changed => {
            // Since the latest of its runs on the task that finished.
            let c = s.db();
            let mut st = c
                .prepare("SELECT * FROM workflow_runs WHERE workflow_id=?1 AND task_id=?2 AND id!=?3 AND state='done' ORDER BY rowid DESC LIMIT 1")
                .map_err(|e| e.to_string())?;
            let last = st.query_row([&run.workflow_id, &run.task_id, &run.id], Run::from_row).optional().map_err(|e| e.to_string())?;
            Ok(match last {
                None => true,
                Some(last) => last.head != run.head || last.task_run != run.task_run,
            })
        }
    }
}

/// Where the task's work is (its worktree, branch, base and whether it starts later than its base), and whether its
/// branch has no commits of its own.
async fn elsewhere(s: &Shared, task: &db::Task) -> Result<(Work, bool), String> {
    let project = task.project_id.as_deref().and_then(|p| db::get_project(&s.db(), p).ok().flatten()).ok_or("the task has no project")?;
    let (Some(dir), Some(branch)) = (task.worktree_path.clone().filter(|_| task.worktree_state == "ready"), task.branch.clone()) else {
        return Err("the task has no worktree".into());
    };
    let dir = std::path::PathBuf::from(dir);
    let head = rev_parse(&dir, "HEAD").await.ok_or("couldn't read the worktree's HEAD commit")?;
    let (base, own_start) = worktree::work_scope(s, &dir, task, &project).await;
    let mut elsewhere = false;
    if let Some(b) = &base {
        let merge_base = worktree::git(&dir, &["merge-base", b, "HEAD"]).await.ok().filter(|o| o.ok).map(|o| o.stdout.trim().to_string());
        elsewhere = merge_base.as_deref() == Some(head.as_str());
    }
    let work = Work {
        key: task_key(&s.db(), task),
        branch,
        base,
        commit: head[..head.len().min(10)].to_string(),
        elsewhere,
        own_start,
        last_message: None,
    };
    Ok((work, elsewhere))
}

/// The thread an agent step works in: the one it had in an earlier run on the task, while its agent is the same.
fn thread_for(s: &Shared, run: &Run, node_id: &str, config: Option<&str>, model: Option<&str>, effort: Option<&str>) -> ApiResult<Option<db::Task>> {
    let c = s.db();
    let mut st = c.prepare("SELECT * FROM workflow_runs WHERE workflow_id=?1 AND task_id=?2 AND id!=?3 ORDER BY rowid DESC LIMIT 20")?;
    let earlier: Vec<Run> = st.query_map([&run.workflow_id, &run.task_id, &run.id], Run::from_row)?.collect::<rusqlite::Result<_>>()?;
    for r in earlier {
        let Some(id) = r.nodes.get(node_id).and_then(|n| n.thread_id.clone()) else { continue };
        let t = db::get_task(&c, &id)?;
        if let Some(t) = t.filter(|t| is_workflow(t) && t.parent_id.as_deref() == Some(run.task_id.as_str())) {
            if t.claude_config_id.as_deref() == config && t.model.as_deref() == model && t.effort.as_deref() == effort {
                return Ok(Some(t));
            }
        }
        return Ok(None);
    }
    Ok(None)
}

/// Starts an agent step's thread on its prompt. It ends in `finished`.
async fn start_agent(s: &Shared, run: &Run, node: &Node) -> Result<(), String> {
    let NodeKind::Agent { name, prompt: instructions, output, claude_config_id, model, effort, skills, .. } = &node.kind else { return Ok(()) };
    if !crate::agent::runs::can_run_agents(s) {
        return Err("this host can't run agents".into());
    }
    let e = |e: anyhow::Error| format!("{e:#}");
    let task = db::get_task(&s.db(), &run.task_id).map_err(e)?.ok_or("the task is gone")?;
    let project = task.project_id.as_deref().and_then(|p| db::get_project(&s.db(), p).ok().flatten()).ok_or("the task has no project")?;
    let workflow = get(&s.db(), &run.workflow_id).ok().flatten().map(|w| w.name).unwrap_or_default();
    let (mut work, elsewhere) = elsewhere(s, &task).await?;
    if elsewhere {
        work.last_message = db::last_assistant_text(&s.db(), &task.id).map_err(e)?;
    }
    let task_config = db::task_claude_config(&s.db(), &task).map_err(e)?;
    let config = match claude_config_id.as_deref() {
        // A step whose config was deleted works with the task's.
        Some(id) => db::get_claude_config(&s.db(), id).map_err(e)?.or_else(|| task_config.clone()),
        None => task_config.clone(),
    };
    let config_id = config.as_ref().map(|c| c.id.clone());
    let label = crate::review::label(config.as_ref(), model.as_deref(), effort.as_deref());
    let codex = config.as_ref().is_some_and(|c| c.is_codex());
    // What the steps before it in the run said.
    let earlier: Vec<(String, String)> = run
        .graph
        .nodes
        .iter()
        .filter_map(|n| match &n.kind {
            NodeKind::Agent { name, .. } => {
                let r = run.nodes.get(&n.id)?;
                (r.state == "done").then(|| r.text.clone()).flatten().map(|t| (name.clone(), t))
            }
            _ => None,
        })
        .collect();
    let replies = match output {
        Output::Verdict => Some(db::user_replies(&s.db(), &task.id, Some(crate::review::REPLIES)).map_err(e)?),
        Output::Text => None,
    };
    let thread = thread_for(s, run, &node.id, config_id.as_deref(), model.as_deref(), effort.as_deref()).map_err(|e| e.1)?;
    // Issues it found last time, if the agent was sent them since.
    let recheck: Vec<String> = match output {
        Output::Verdict if !run.rounds.is_empty() => {
            let c = s.db();
            let last: Option<Run> = c
                .query_row(
                    "SELECT * FROM workflow_runs WHERE workflow_id=?1 AND task_id=?2 AND id!=?3 AND state='done' ORDER BY rowid DESC LIMIT 1",
                    [&run.workflow_id, &run.task_id, &run.id],
                    Run::from_row,
                )
                .optional()
                .map_err(|e| e.to_string())?;
            last.and_then(|l| l.nodes.get(&node.id).filter(|n| n.port.as_deref() == Some("issues")).map(|n| n.issues.clone())).unwrap_or_default()
        }
        _ => Vec::new(),
    };
    let rendered = prompt::render(instructions, &task, &work.key, &workflow, run);
    let instructions = match (rendered.trim().is_empty(), output) {
        (true, Output::Verdict) => crate::agent::prompts::review(Some(&project)).to_string(),
        (true, Output::Text) => format!("Read the work, and report on it as \"{name}\"."),
        (false, _) => rendered,
    };
    let text = prompt::agent(&task, &work, &workflow, name, &instructions, *output, skills, codex, &earlier, replies.as_ref(), &recheck);
    let title = format!("{name} ({workflow}) of {}", work.key);
    let thread = match thread {
        Some(t) => {
            if t.title != title {
                s.update_task(&t.id, &[("title", json!(title))]).map_err(e)?;
            }
            t
        }
        None => {
            let t = db::insert_task(
                &s.db(),
                db::NewTask {
                    profile_id: &task.profile_id,
                    project_id: Some(&project.id),
                    kind: "review",
                    title: &title,
                    description: "",
                    status: "todo",
                    use_worktree: false,
                    model: model.as_deref(),
                    effort: effort.as_deref(),
                    claude_config_id: config_id.as_deref(),
                },
            )
            .map_err(e)?;
            s.update_task(&t.id, &[("parent_id", json!(task.id)), ("task_type", json!(WORKFLOW))]).map_err(e)?.ok_or("the thread is gone")?
        }
    };
    if s.is_running(&thread.id) {
        return Err(format!("its thread's agent ({label}) is busy"));
    }
    let after_run = db::latest_run(&s.db(), &thread.id, None).map_err(e)?.unwrap_or_default();
    db::set_thread_skills(&s.db(), &thread.id, skills).map_err(e)?;
    // A fresh conversation each run; the thread keeps every one's messages.
    s.update_task(&thread.id, &[("session_id", Value::Null)]).map_err(e)?;
    crate::agent::context::clear(s, &thread.id).map_err(e)?;
    // Under the lock `supersede` stops runs with: a step of a run it has stopped doesn't start, and one that starts
    // first is stopped with it.
    let _g = updating();
    let mut current = get_run(&s.db(), &run.id).map_err(|e| e.to_string())?.ok_or("the run is gone")?;
    if current.state != "running" || current.node(&node.id).state != "running" {
        return Ok(());
    }
    let r = current.nodes.entry(node.id.clone()).or_default();
    r.thread_id = Some(thread.id.clone());
    r.label = Some(label);
    r.after_run = Some(after_run);
    current.updated_at = now();
    save(s, &current);
    s.add_event(&thread.id, "info", format!("Running \"{name}\" on commit {}", work.commit), None);
    runner::send_review(s, &thread.id, &text).map(|_| ()).map_err(|e| e.1)
}

/// A send step: the message to the task's agent, if it has rounds left. Ends the run once it's sent (None), as the
/// agent's work changes under it.
fn send(s: &Shared, run: &Run, node: &Node, message: &str, max_rounds: u32) -> Option<Done> {
    let task = match db::get_task(&s.db(), &run.task_id) {
        Ok(Some(t)) => t,
        _ => return Some(Done::failed("the task is gone")),
    };
    let workflow = get(&s.db(), &run.workflow_id).ok().flatten().map(|w| w.name).unwrap_or_default();
    let key = task_key(&s.db(), &task);
    let issues = prompt::issues(run);
    let text = if message.trim().is_empty() {
        if issues.is_empty() {
            return Some(Done::failed("there are no issues to send (and the step has no message of its own)"));
        }
        prompt::fixes(&workflow, &issues)
    } else {
        prompt::render(message, &task, &key, &workflow, run)
    };
    let used = run.rounds.get(&node.id).copied().unwrap_or(0);
    let exhausted = used >= max_rounds;
    if exhausted {
        let has_next = run.graph.edges.iter().any(|e| e.from == node.id && e.port == "exhausted");
        let reason = match (used, issues.len()) {
            (_, 0) => format!("The workflow \"{workflow}\" is out of rounds"),
            (0, n) => format!("The workflow \"{workflow}\" found {n} serious issue{}", if n == 1 { "" } else { "s" }),
            (1, n) => format!("The workflow \"{workflow}\" found {n} serious issue{} after a round of fixes", if n == 1 { "" } else { "s" }),
            (k, n) => format!("The workflow \"{workflow}\" found {n} serious issue{} after {k} rounds of fixes", if n == 1 { "" } else { "s" }),
        };
        s.add_event(&task.id, "warn", reason.clone(), (!issues.is_empty()).then(|| issues.join("\n\n")));
        if !has_next && !s.is_running(&task.id) && task.status != "done" && !task.merging {
            if let Err(e) = s.update_task(&task.id, &[("status", json!("needs_attention")), ("attention_reason", json!(reason))]) {
                tracing::error!("flagging a task: {e:#}");
            }
        }
        return Some(Done::port("exhausted"));
    }
    if s.is_running(&task.id) || task.status == "done" || task.merging {
        // The user (or the agent) has moved on: the findings are left for them.
        s.add_event(&task.id, "warn", format!("The workflow \"{workflow}\" didn't send its message: the task has moved on"), Some(text));
        return Some(Done::failed("the task has moved on (its agent is working, or it's done or merging)"));
    }
    // Ends the run, and stops its other steps: the agent's work is about to change.
    let round = used + 1;
    let threads = {
        let _g = updating();
        let Some(mut current) = get_run(&s.db(), &run.id).ok().flatten().filter(|r| r.state == "running") else { return None };
        let at = now();
        current.rounds.insert(node.id.clone(), round);
        let r = current.nodes.entry(node.id.clone()).or_default();
        r.state = "done".into();
        r.port = Some("sent".into());
        r.text = Some(text.clone());
        r.finished_at = Some(at.clone());
        let threads = end_nodes(&mut current, "Stopped because the task's agent was sent a message.");
        current.state = "done".into();
        current.finished_at = Some(at.clone());
        current.updated_at = at;
        save(s, &current);
        threads
    };
    for t in threads {
        runner::stop(s, &t);
    }
    if let Err(e) = runner::send_fixes(s, &task.id, &text, round) {
        s.add_event(&task.id, "error", format!("The workflow \"{workflow}\" couldn't send its message to the agent"), Some(e.1));
    }
    None
}

/// Marks a run's nodes still to run as skipped and those running as stopped, saying `why`. Returns the threads to stop.
fn end_nodes(run: &mut Run, why: &str) -> Vec<String> {
    let mut threads = Vec::new();
    let at = now();
    for n in &run.graph.nodes {
        let r = run.nodes.entry(n.id.clone()).or_default();
        match r.state.as_str() {
            "pending" => r.state = "skipped".into(),
            "running" => {
                r.state = "stopped".into();
                r.port = None;
                r.text = Some(why.into());
                r.finished_at = Some(at.clone());
                threads.extend(r.thread_id.clone());
            }
            _ => {}
        }
    }
    threads
}

async fn move_task(s: &Shared, run: &Run, status: &str) -> Done {
    let key = (run.task_id.clone(), run.workflow_id.clone());
    MOVING.lock().unwrap_or_else(|e| e.into_inner()).push(key.clone());
    let mut b = Map::new();
    b.insert("status".into(), json!(status));
    let moved = crate::api::update_task_inner(s, &run.task_id, &b).await;
    MOVING.lock().unwrap_or_else(|e| e.into_inner()).retain(|k| *k != key);
    match moved {
        Ok(_) => Done::port("out"),
        Err(e) => Done::failed(e.1),
    }
}

/// The running run and node agent thread `thread` works for, if any.
fn step_of(s: &Shared, thread: &db::Task) -> Option<(Run, String)> {
    let parent = thread.parent_id.as_deref()?;
    let runs = running(&s.db(), Some(parent)).ok()?;
    runs.into_iter().find_map(|r| {
        let id = r.nodes.iter().find(|(_, n)| n.state == "running" && n.thread_id.as_deref() == Some(thread.id.as_str())).map(|(id, _)| id.clone())?;
        Some((r, id))
    })
}

/// Whether run `run_id` of the thread is the one its step asked for (not an earlier one ending late).
fn asked(s: &Shared, thread: &db::Task, r: &NodeRun, run_id: &str) -> bool {
    match r.after_run.as_deref() {
        Some(after) => db::run_after(&s.db(), &thread.id, run_id, after).unwrap_or(false),
        None => false,
    }
}

/// `submit_review` from a workflow's verdict step: its verdict, acted on when its run ends.
pub fn submit(s: &Shared, thread: &db::Task, run_id: &str, args: &Value) -> ApiResult<Value> {
    let _g = updating();
    let (mut run, id) = step_of(s, thread).ok_or_else(|| ApiError::conflict("no workflow step is running in this thread, so there's nothing to submit"))?;
    if !matches!(run.graph.node(&id).map(|n| &n.kind), Some(NodeKind::Agent { output: Output::Verdict, .. })) {
        return Err(ApiError::conflict("this step reports with its last message, not submit_review: end your turn with its output"));
    }
    if !asked(s, thread, &run.node(&id), run_id) {
        return Err(ApiError::conflict("the step this run was asked for has ended, so there's nothing to submit"));
    }
    let mut issues: Vec<String> = match &args["serious_issues"] {
        Value::Array(a) => a.iter().filter_map(|i| i.as_str()).map(str::trim).filter(|i| !i.is_empty()).map(String::from).collect(),
        Value::String(t) if !t.trim().is_empty() => vec![t.trim().to_string()],
        _ => Vec::new(),
    };
    let summary = args["summary"].as_str().map(str::trim).filter(|t| !t.is_empty()).map(String::from);
    if args["verdict"] == "needs_fixes" && issues.is_empty() {
        issues.push(summary.clone().unwrap_or_else(|| "The step asked for fixes without saying what they are; see its thread.".into()));
    }
    let r = run.nodes.entry(id).or_default();
    r.verdict = Some(if issues.is_empty() { "pass" } else { "issues" }.into());
    r.issues = issues;
    r.text = summary;
    run.updated_at = now();
    save(s, &run);
    Ok(json!({"ok": true, "note": "Recorded. End your turn now with a short summary."}))
}

/// Agent thread `thread`'s run `run_id` ended: its step's output, and on from there.
pub fn finished(s: &Shared, thread: &db::Task, run_id: &str, outcome: &Outcome, attention: Option<&str>) {
    if let Some(id) = step_ended(s, thread, run_id, outcome, attention) {
        let s = s.clone();
        tokio::spawn(async move { advance(&s, &id).await });
    }
}

/// Records how the step thread `thread` worked for ended, if its run `run_id` was the step's. Returns the workflow run's id.
pub(super) fn step_ended(s: &Shared, thread: &db::Task, run_id: &str, outcome: &Outcome, attention: Option<&str>) -> Option<String> {
    {
        let _g = updating();
        let (mut run, id) = step_of(s, thread)?;
        let r = run.node(&id);
        if !asked(s, thread, &r, run_id) {
            return None;
        }
        let verdict = matches!(run.graph.node(&id).map(|n| &n.kind), Some(NodeKind::Agent { output: Output::Verdict, .. }));
        let written = || -> Option<String> {
            let c = s.db();
            let asked: i64 = c.query_row("SELECT COALESCE(MAX(id), 0) FROM messages WHERE task_id=?1 AND kind='user'", [&thread.id], |r| r.get(0)).ok()?;
            db::last_assistant_text_after(&c, &thread.id, asked).ok().flatten().map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
        };
        let (state, port, text): (&str, Option<&str>, Option<String>) = match (outcome, verdict, r.verdict.as_deref()) {
            (Outcome::Cancelled, ..) => ("stopped", None, Some("The step was stopped.".into())),
            (Outcome::Failed(e), ..) => ("failed", Some("failed"), Some(format!("The step failed: {}", e.lines().next().unwrap_or("")))),
            (Outcome::Ok, ..) if attention.is_some() => ("failed", Some("failed"), attention.map(|q| format!("The step's agent asked: {q}"))),
            (Outcome::Ok, true, None) => ("failed", Some("failed"), Some("The step finished without submitting a verdict.".into())),
            (Outcome::Ok, true, Some(v)) => ("done", Some(if v == "pass" { "pass" } else { "issues" }), r.text.clone().or_else(written)),
            (Outcome::Ok, false, _) => match written() {
                Some(t) => ("done", Some("done"), Some(t)),
                None => ("failed", Some("failed"), Some("The step finished without writing its output.".into())),
            },
        };
        let n = run.nodes.entry(id).or_default();
        n.state = state.into();
        n.port = port.map(String::from);
        n.text = text;
        n.finished_at = Some(now());
        run.updated_at = now();
        save(s, &run);
        Some(run.id)
    }
}

/// Stops a run in progress, saying `why`. Returns whether it was in progress.
pub fn stop_run(s: &Shared, run_id: &str, why: &str) -> bool {
    let threads = {
        let _g = updating();
        let Some(mut run) = get_run(&s.db(), run_id).ok().flatten().filter(|r| r.state == "running") else { return false };
        let threads = end_nodes(&mut run, why);
        run.state = "stopped".into();
        run.detail = Some(why.into());
        run.finished_at = Some(now());
        run.updated_at = now();
        save(s, &run);
        threads
    };
    for t in threads {
        runner::stop(s, &t);
    }
    true
}

fn stop_all(s: &Shared, task_id: &str, why: &str) -> bool {
    let runs = running(&s.db(), Some(task_id)).unwrap_or_default();
    let mut any = false;
    for r in runs {
        any |= stop_run(s, &r.id, why);
    }
    any
}

/// The task's agent started working again: its workflows' runs in progress are out of date.
pub fn supersede(s: &Shared, task: &db::Task) {
    stop_all(s, &task.id, "Stopped because the agent started working on the task again.");
}

/// The user stopped the task: stop its workflows' runs too. Returns whether any was running.
pub fn stop(s: &Shared, task_id: &str) -> bool {
    let stopped = stop_all(s, task_id, "Stopped by the user.");
    if stopped {
        s.add_event(task_id, "warn", "Workflow stopped", None);
    }
    stopped
}

/// On start: steps that were running on the board itself when the server stopped (not agents, which carry on) failed,
/// and the runs go on from there.
pub fn resume(s: &Shared) {
    let runs = running(&s.db(), None).unwrap_or_default();
    let mut ids = HashSet::new();
    for mut run in runs {
        let mut changed = false;
        for n in &run.graph.nodes {
            if matches!(n.kind, NodeKind::Agent { .. }) {
                continue;
            }
            let r = run.nodes.entry(n.id.clone()).or_default();
            if r.state == "running" {
                r.state = "failed".into();
                r.port = Some("failed".into());
                r.text = Some("Interrupted: the server stopped while this ran.".into());
                changed = true;
            }
        }
        if changed {
            save(s, &run);
        }
        ids.insert(run.id);
    }
    for id in ids {
        let s = s.clone();
        tokio::spawn(async move { advance(&s, &id).await });
    }
}
