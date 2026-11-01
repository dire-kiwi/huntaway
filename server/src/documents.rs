//! A task's labels (see db::Task::labels) each ask its agent for a document besides its other
//! work: an HTML page (a plan to iterate on, or an artifact) or a Mermaid diagram. The agent
//! writes each to a file in the task's own folder, and the board keeps each version in the
//! database and shows it in a tab of the task (`GET /tasks/{id}/document?label=…`).
//!
//! A version follows the file while the agent's turn goes on, so the task shows the document as
//! it's written, and is closed when the turn ends: the next change starts a new version, so
//! there's one per turn that changed it.
//!
//! Plan, artifact and diagram were types of task before API 71, whose agents worked in the task's
//! own folder and made only the document. Those tasks have their type as their label now, and
//! keep working in their folder (see documents_only).

use std::collections::HashMap;
use std::path::{Component, Path as FsPath, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use axum::Json;
use axum::extract::{Path, Query, State};
use rusqlite::{OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::db::{self, Project, Task};
use crate::state::{ApiError, ApiResult, Shared};
use crate::util::{now, path_str};

/// A bigger file isn't kept, so a runaway agent can't fill the database.
const MAX_SIZE: u64 = 5 << 20;

/// The file a task with this label writes its document to, in its folder.
pub fn file_name(label: &str) -> Option<&'static str> {
    match label {
        "plan" => Some("plan.html"),
        "artifact" => Some("artifact.html"),
        "diagram" => Some("diagram.mmd"),
        _ => None,
    }
}

/// Labels as a new or changed task is given them: known ones (see db::LABELS), each once, in
/// the order the task shows them.
pub fn check_labels(v: &Value) -> Result<Vec<&'static str>, String> {
    let given: Vec<&str> = match v {
        Value::Null => Vec::new(),
        Value::Array(a) => a.iter().map(|l| l.as_str().map(str::trim).ok_or("labels must be a list of strings")).collect::<Result<_, _>>()?,
        _ => return Err("labels must be a list of strings".into()),
    };
    if let Some(bad) = given.iter().find(|l| !db::LABELS.contains(l)) {
        return Err(format!("unknown label {bad:?}: labels are some of {:?}", db::LABELS));
    }
    Ok(db::LABELS.iter().copied().filter(|l| given.contains(l)).collect())
}

/// The task's labels that ask for a document, in the order the task shows them.
pub fn labels(task: &Task) -> Vec<&'static str> {
    db::LABELS.iter().copied().filter(|l| task.kind == "task" && task.labels.iter().any(|t| t == l)).collect()
}

/// A task's own folder, which holds its documents: the working directory of a scratch task's
/// agent (which writes whatever it likes there) and of one that makes only documents.
pub fn dir(state: &Shared, task_id: &str) -> PathBuf {
    state.data_dir.join("documents").join(task_id)
}

/// Whether a task makes only its documents, rather than changing code: one made as a plan,
/// artifact or diagram task before they were labels, which works in its own folder.
pub fn documents_only(task: &Task) -> bool {
    task.kind == "task" && !task.is_scratch() && task.work_dir.is_some()
}

/// Where a scratch task's agent works (and its shell and wait commands run): the task's own
/// folder, or for a scratch task that was a scratch chat, the chat's; and where one that makes
/// only documents does (see documents_only). None for any other thread, which works where its kind
/// and project say (see runner::work_dir).
pub fn work_dir(state: &Shared, task: &Task) -> Option<PathBuf> {
    if task.kind != "task" {
        return None;
    }
    match task.work_dir.as_deref() {
        // A folder in the data dir, which can move.
        Some(d) if !d.starts_with('~') && FsPath::new(d).is_relative() => Some(state.data_dir.join(d)),
        Some(d) => Some(crate::util::expand_tilde(d)),
        None => task.is_scratch().then(|| dir(state, &task.id)),
    }
}

/// Where a task's agent writes the document for one of its labels.
pub fn path(state: &Shared, task: &Task, label: &str) -> Option<PathBuf> {
    Some(dir(state, &task.id).join(file_name(label)?))
}

/// The documents a task's agent writes, by label.
pub fn paths(state: &Shared, task: &Task) -> Vec<(&'static str, PathBuf)> {
    labels(task).into_iter().filter_map(|l| Some((l, path(state, task, l)?))).collect()
}

/// Remove a deleted task's folder (its versions go with the task's row).
pub fn remove(state: &Shared, task_id: &str) {
    if let Some(seen) = SEEN.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        seen.retain(|(t, _), _| t != task_id);
    }
    let d = dir(state, task_id);
    if d.exists() {
        if let Err(e) = std::fs::remove_dir_all(&d) {
            tracing::warn!(task = task_id, "removing the task's document folder failed: {e}");
        }
    }
}

/// Whether a tool call only writes to files in the task's own folder, which its agent may do
/// without asking: that's where it writes its documents (and a scratch task its notes).
pub fn writes_own_folder(state: &Shared, task: &Task, tool_name: &str, input: &Value) -> bool {
    let own = task.kind == "task" && (!labels(task).is_empty() || task.is_scratch() || documents_only(task));
    if !own || !["Write", "Edit", "MultiEdit", "NotebookEdit"].contains(&tool_name) {
        return false;
    }
    let Some(file) = input["file_path"].as_str().or(input["notebook_path"].as_str()) else { return false };
    let file = FsPath::new(file);
    // A `..`, or a symlink in the folder, could lead back out of it.
    if !file.is_absolute() || file.components().any(|c| c == Component::ParentDir) {
        return false;
    }
    matches!((resolved(file), resolved(&dir(state, &task.id))), (Some(f), Some(d)) if f.starts_with(&d))
}

/// A path with its symlinks resolved, as far as it exists (a file about to be written doesn't).
/// None if it can't be: a symlink that leads nowhere (writing through it would create its
/// target, wherever that is), or anything but a missing part on the way.
fn resolved(p: &FsPath) -> Option<PathBuf> {
    let mut rest = Vec::new();
    let mut existing = p;
    loop {
        // Unlike `metadata`, this finds a dangling symlink rather than taking it for missing.
        match std::fs::symlink_metadata(existing) {
            Ok(_) => {
                let real = existing.canonicalize().ok()?;
                return Some(rest.iter().rev().fold(real, |acc: PathBuf, part| acc.join(part)));
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                rest.push(existing.file_name()?);
                existing = existing.parent()?;
            }
            Err(_) => return None,
        }
    }
}

/// The size and modification time each task's document file had when last looked at, by task
/// and label, so following it during a turn doesn't read an unchanged file again.
static SEEN: Mutex<Option<HashMap<(String, &'static str), (u64, SystemTime)>>> = Mutex::new(None);

/// During a turn, after a tool call: keep the task's documents that the agent changed.
pub fn follow(state: &Shared, task_id: &str) {
    keep(state, task_id, false);
}

/// At the end of a turn (or of the run): keep the documents that changed, and close their versions.
pub fn turn_ended(state: &Shared, task_id: &str) {
    keep(state, task_id, true);
}

fn keep(state: &Shared, task_id: &str, end_of_turn: bool) {
    if let Err(e) = try_keep(state, task_id, end_of_turn) {
        tracing::warn!(task = task_id, "keeping the task's documents failed: {e:#}");
    }
}

fn try_keep(state: &Shared, task_id: &str, end_of_turn: bool) -> anyhow::Result<()> {
    let Some(task) = db::get_task(&state.db(), task_id)? else { return Ok(()) };
    let mut changed = false;
    for (label, file) in paths(state, &task) {
        changed |= keep_one(state, task_id, label, &file, end_of_turn)?;
    }
    // A label taken off during the turn leaves its version as it was.
    if end_of_turn {
        state.db().execute("UPDATE documents SET open=0 WHERE task_id=?1 AND open=1", [task_id])?;
    }
    if changed {
        state.update_task(task_id, &[("document_at", json!(now()))])?;
    }
    Ok(())
}

/// Keep the document for one label if it changed: whether it did.
fn keep_one(state: &Shared, task_id: &str, label: &'static str, file: &FsPath, end_of_turn: bool) -> anyhow::Result<bool> {
    let stamp = std::fs::metadata(file).ok().map(|m| (m.len(), m.modified().unwrap_or(SystemTime::UNIX_EPOCH)));
    let unchanged = {
        let mut seen = SEEN.lock().unwrap_or_else(|e| e.into_inner());
        let seen = seen.get_or_insert_with(HashMap::new);
        let key = (task_id.to_string(), label);
        let same = stamp.is_some() && seen.get(&key) == stamp.as_ref();
        match stamp {
            Some(st) => seen.insert(key, st),
            None => seen.remove(&key),
        };
        same
    };
    let content = match stamp {
        _ if unchanged && !end_of_turn => return Ok(false),
        None => None,
        Some((len, _)) if len > MAX_SIZE => {
            if end_of_turn {
                let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                state.add_event(task_id, "warn", format!("{name} is over {} MB, so this version isn't kept", MAX_SIZE >> 20), None);
            }
            None
        }
        Some(_) => std::fs::read(file).ok().map(|b| String::from_utf8_lossy(&b).into_owned()),
    };
    let ts = now();
    let c = state.db();
    let latest: Option<(i64, String, bool)> = c
        .query_row(
            "SELECT version, content, open FROM documents WHERE task_id=?1 AND label=?2 ORDER BY version DESC LIMIT 1",
            [task_id, label],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    // (The end of the turn closes an open version that doesn't change, in try_keep.)
    Ok(match (content, latest) {
        (Some(new), Some((_, old, _))) if new == old => false,
        // The turn's version follows the file.
        (Some(new), Some((v, _, true))) => {
            c.execute(
                "UPDATE documents SET content=?4, open=?5, updated_at=?6 WHERE task_id=?1 AND label=?2 AND version=?3",
                params![task_id, label, v, new, !end_of_turn, ts],
            )?;
            true
        }
        (Some(new), latest) => {
            let v = latest.map_or(1, |(v, _, _)| v + 1);
            c.execute(
                "INSERT INTO documents (task_id, label, version, content, open, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?6)",
                params![task_id, label, v, new, !end_of_turn, ts],
            )?;
            true
        }
        (None, _) => false,
    })
}

#[derive(Deserialize)]
pub struct DocumentQuery {
    label: Option<String>,
    version: Option<i64>,
}

/// `GET /tasks/{id}/document[?label=L][&version=N]`: a version of the task's document for a label
/// (its first label's unless asked for another; the latest version unless asked for another), and
/// the list of its versions. A version that's `open` is still being written in the agent's current
/// turn.
pub async fn get(State(s): State<Shared>, Path(id): Path<String>, Query(q): Query<DocumentQuery>) -> ApiResult<Json<Value>> {
    let task = db::get_task(&s.db(), &id)?.ok_or_else(|| ApiError::not_found("task"))?;
    let label = match q.label.as_deref().map(str::trim).filter(|l| !l.is_empty()) {
        Some(l) => *db::LABELS.iter().find(|x| **x == l).ok_or_else(|| ApiError::bad(format!("unknown label {l:?}")))?,
        None => labels(&task).first().copied().unwrap_or(db::LABELS[0]),
    };
    let c = s.db();
    let mut st =
        c.prepare("SELECT version, open, created_at, updated_at, length(content) FROM documents WHERE task_id=?1 AND label=?2 ORDER BY version")?;
    let versions: Vec<Value> = st
        .query_map([&id, label], |r| {
            Ok(json!({
                "version": r.get::<_, i64>(0)?,
                "open": r.get::<_, bool>(1)?,
                "created_at": r.get::<_, String>(2)?,
                "updated_at": r.get::<_, String>(3)?,
                "size": r.get::<_, i64>(4)?,
            }))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let version = q.version.or_else(|| versions.last().and_then(|v| v["version"].as_i64()));
    let content: Option<String> = match version {
        Some(v) => c
            .query_row("SELECT content FROM documents WHERE task_id=?1 AND label=?2 AND version=?3", params![id, label, v], |r| r.get(0))
            .optional()?,
        None => None,
    };
    if q.version.is_some() && content.is_none() {
        return Err(ApiError::not_found("version"));
    }
    Ok(Json(json!({
        "label": label,
        "file": path(&s, &task, label).map(|p| path_str(&p)),
        "versions": versions,
        "version": version.filter(|_| content.is_some()),
        "content": content,
    })))
}

/// What a task's agent is told to write and where, for a task that makes only documents (see
/// documents_only), after who it is and where (`project`, or for a group task its group's
/// `group_projects`). `files`: the documents it writes, by label (see paths).
pub fn system_prompt(task: &Task, files: &[(&str, String)], project: Option<&Project>, group_projects: &[Project]) -> String {
    let mut s = match (project, &task.group_name) {
        (Some(p), _) => format!(" Project: {} (repository {}, which you can read).", p.name, p.repo_path),
        (None, Some(g)) if group_projects.is_empty() => {
            format!(" The task isn't in a project but is for the group \"{g}\", which has no projects at the moment.")
        }
        (None, Some(g)) => {
            let list: Vec<String> = group_projects.iter().map(|p| format!("{} (key {}, repository {})", p.name, p.key, p.repo_path)).collect();
            format!(" The task isn't in a project but is for the group \"{g}\", whose projects are: {}. You can read their repositories.", list.join("; "))
        }
        (None, None) => String::new(),
    };
    s.push_str(&format!(
        "\n\nRather than changing code, this task makes documents: you write {}. Your working directory is the task's own folder, where you can write \
         freely. The board shows {} in the task as it changes, and keeps a version from each turn. Don't change the \
         repositories, commit, push or open pull requests.",
        if files.is_empty() { "none at the moment, as it has no labels: ask the user what to make".to_string() } else { what(files) },
        if files.len() == 1 { "that file" } else { "each file" },
    ));
    for (label, _) in files {
        s.push_str(&guide(label, true));
    }
    s
}

/// What a task's agent is told about the documents its labels ask for, besides its other work
/// (nothing without labels): `files` by label (see paths).
pub fn labels_prompt(files: &[(&str, String)]) -> String {
    if files.is_empty() {
        return String::new();
    }
    let names: Vec<&str> = files.iter().map(|(l, _)| *l).collect();
    let mut s = format!(
        "\n\nThis task has the label{} {} on the board, so besides its other work you write {}. They're in the task's own \
         folder, outside any repository (don't commit them), where you can write freely. The board shows {} in a tab of \
         the task as it changes, and keeps a version from each turn.",
        if names.len() == 1 { "" } else { "s" },
        names.join(", "),
        what(files),
        if files.len() == 1 { "the file" } else { "each file" },
    );
    if names.contains(&"plan") {
        s.push_str(
            " The plan comes first: write it before you change anything else, and iterate on it with the user. Don't \
             start on the work until the user approves the plan and asks you to; then work from it, and keep it up to \
             date as you go (tick off its steps, and note where you strayed from it and why).",
        );
    }
    for (label, _) in files {
        s.push_str(&guide(label, false));
    }
    s
}

/// The documents, for the agent: "a plan (HTML) to /…/plan.html and …".
fn what(files: &[(&str, String)]) -> String {
    let each: Vec<String> = files
        .iter()
        .map(|(label, file)| {
            let what = match *label {
                "plan" => "a plan (HTML)",
                "artifact" => "an artifact (an HTML page)",
                _ => "a Mermaid diagram",
            };
            format!("{what} to {file}")
        })
        .collect();
    match each.split_last() {
        Some((last, [])) => last.clone(),
        Some((last, rest)) => format!("{} and {last}", rest.join("; ")),
        None => String::new(),
    }
}

/// How to make the document for a label. `only`: in a task that makes only documents (whose
/// plan is broken into tasks rather than carried out in the task).
fn guide(label: &str, only: bool) -> String {
    match label {
        "plan" => format!(
            "\n\nThe plan is HTML that the user reads and iterates on with you. {PLAN_FEEDBACK} {}\n\n{PLAN_FORMAT}",
            if only {
                "When the user approves the plan and asks you to, break it into tasks with `create_task`: they're recorded \
                 as this task's, and the board shows how many are done."
            } else {
                "When the user approves the plan, do what they ask with it: carry it out in this task, or break it into \
                 tasks with `create_task` (they're recorded as this task's, and the board shows how many are done)."
            }
        ),
        "artifact" => format!("\n\n{ARTIFACT}"),
        _ => format!("\n\n{DIAGRAM}"),
    }
}

/// How to go about a plan.
const PLAN_FEEDBACK: &str = "Investigate before you write, so it's \
    grounded in specifics: read the code and name the files, modules, interfaces and data involved. Structure it \
    so it's easy to review: the goal and what's out of scope, how things work today, the approach (with the \
    alternatives you weighed and why not), the steps in order, each small enough to be one task for an agent, then \
    risks and open questions. Keep it easy to scan: clear headings, tables and lists where they help, and a \
    diagram where a picture says it better.\n\nUntil the user approves it, each message from them is feedback on the \
    plan: update the file in place (edit it rather than rewriting it whole) and say briefly what changed. Put the questions you \
    need answered in the plan as <ia-question>s (below), with choices to pick from where you can suggest \
    them, and mention them at the end of your turn. The user answers them in the plan and sends the answers \
    when they're ready, as a message listing each question's answer by its name; then fold the answers into \
    the plan, and take the questions they settle out (or keep one with its answer as its default, if it's \
    still worth showing).";

/// How a plan is written, for the board to show it.
const PLAN_FORMAT: &str = "The board shows the plan in its own theme (dark) with a readable column, and gives you components for it. \
    So write only the content, starting with an <h1> title: no doctype, <html>, <head>, <body> or <style>, and no \
    colours or fonts of your own (a whole page is shown as it is, without the theme or the components). Plain \
    HTML (h2/h3 sections, p, ul/ol, table, dl, pre/code, blockquote, details) is already styled. The components:\n\
    - <ia-lede>One-line summary under the title</ia-lede>\n\
    - <ia-callout kind=\"note|tip|info|warn|risk|question|decision\" title=\"Optional heading\">…</ia-callout>\n\
    - <ia-steps><ia-step size=\"S|M|L\"><h3>Step title</h3><p>…</p></ia-step>…</ia-steps>: numbered steps \
    (size is optional)\n\
    - <ia-cards><ia-card kind=\"chosen|rejected\"><h3>Option</h3>…</ia-card>…</ia-cards>: a grid of cards, e.g. \
    the alternatives (kind is optional)\n\
    - <ia-columns>…</ia-columns>: its children side by side\n\
    - <ia-badge kind=\"accent|ok|warn|danger|info\">label</ia-badge>: inline, e.g. in table cells\n\
    - <ul class=\"pros\">, <ul class=\"cons\">, <ul class=\"checklist\"> (<li class=\"done\"> for ticked items), \
    <ul class=\"files\"> (<li><code>path</code> what changes</li>)\n\
    - <ia-diagram><pre>flowchart LR\nA[\"Start\"] --&gt; B[\"Finish\"]</pre></ia-diagram>: a Mermaid diagram, \
    rendered by the board in its dark theme. Always use Mermaid for plan diagrams, never hand-written SVG. \
    Put only Mermaid source inside the <pre>, without Markdown fences, scripts or a CDN. HTML-escape & and < \
    in the source (&amp; and &lt;); keep labels short and quote those with punctuation. Use the diagram type \
    that fits (flowchart, sequenceDiagram, stateDiagram-v2, etc.).\n\
    - <ia-question name=\"id\" type=\"radio|checkbox|select|text|textarea\" title=\"The question?\">…</ia-question>: \
    a question the user answers in the plan. Give each a unique name. Radio (one choice), checkbox (any \
    number, also for a checklist to tick) and select (a dropdown) take the choices as children, \
    <option value=\"id\">Label</option> (selected on the ones to start with: your recommendation); add \
    other (or other=\"Label\") for a free-text \"Other\" choice. Text and textarea take placeholder and value. \
    A <p> inside explains the question. Plain <input>, <select> and <textarea> fields with a name are \
    answered too (not those in an <ia-html>), with data-question=\"…\" on them or a wrapper for their question.\n\
    - <ia-html><template>…</template></ia-html>: anything the components can't do. The template's contents \
    are a page of their own, in a frame as tall as they are: any HTML, CSS and scripts work there as in a \
    page (`document` is that page, and libraries can come from a CDN), without affecting the rest of the \
    plan. Don't size it to the window (no vh units). The theme's CSS variables are set there, to match it: \
    --bg, --panel, --panel-2, --raised, --line, --line-strong, --fg, --heading, --muted, --faint, --accent, \
    --ok, --warn, --danger, --info, --font-sans, --font-mono.";

/// How to make an artifact.
const ARTIFACT: &str = "The artifact is a single self-contained HTML page, the kind you'd make as an artifact on claude.ai: a \
    document, a visual explainer, a dashboard, an interactive tool or a prototype. Before you write it, load the \
    `artifact-design` skill if you have it and follow its design guidance (and the `dataviz` skill for charts), \
    but don't publish with the Artifact tool or upload it anywhere: this board stores and shows the page. Without \
    that skill, design with the same care: a clear visual hierarchy, a restrained palette, generous spacing, \
    legible type, and a layout that works from narrow to wide. Keep CSS and JavaScript inline; if you need a \
    library, load it from a well-known CDN (cdnjs, jsDelivr or unpkg). The page is shown in a sandboxed frame: \
    scripts run, but it has no cookies or local storage and can't reach the board. When the user gives \
    feedback on it, update the page in place (edit it rather than rewriting it whole) and say briefly what changed.";

/// How to make a diagram.
const DIAGRAM: &str = "The file holds just the diagram's Mermaid source, without Markdown fences, and the board renders it. Pick \
    the diagram type that fits what it shows (flowchart, sequenceDiagram, classDiagram, stateDiagram-v2, \
    erDiagram, gantt, mindmap, timeline, …), and ground it in the real thing: read the code and use the actual \
    names of components, calls and data. Keep it legible: a title (in `---\\ntitle: …\\n---` front matter), short \
    labels, subgraphs to group related parts, and no more than about 30 nodes; if there's more to show, say \
    which further diagrams would help rather than cramming them in. Make sure it parses: quote labels that \
    contain punctuation such as parentheses, brackets, colons or quotes. When the user gives feedback on it, \
    update the diagram in place and say briefly what changed.";

#[cfg(test)]
mod tests {
    use super::*;

    fn task_of(state: &Shared, labels: &[&str]) -> Task {
        let p = db::insert_profile(&state.db(), "p", &[], None).unwrap();
        let t = db::NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "t", description: "", status: "in_progress", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let t = db::insert_task(&state.db(), t).unwrap();
        db::update_task(&state.db(), &t.id, &[("labels", json!(labels))]).unwrap().unwrap()
    }

    fn versions(state: &Shared, id: &str) -> Vec<(i64, String, bool)> {
        labelled(state, id).into_iter().map(|(_, v, c, o)| (v, c, o)).collect()
    }

    fn labelled(state: &Shared, id: &str) -> Vec<(String, i64, String, bool)> {
        let c = state.db();
        let mut st = c.prepare("SELECT label, version, content, open FROM documents WHERE task_id=?1 ORDER BY label, version").unwrap();
        st.query_map([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap().collect::<rusqlite::Result<_>>().unwrap()
    }

    /// Writes the file with a modification time of its own, as the next edit would have.
    fn write(file: &FsPath, text: &str, secs: u64) {
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, text).unwrap();
        let f = std::fs::File::options().write(true).open(file).unwrap();
        f.set_modified(SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000 + secs)).unwrap();
    }

    #[test]
    fn a_version_follows_the_file_during_a_turn_and_the_next_turn_starts_another() {
        let state = crate::testing::state();
        let task = task_of(&state, &["diagram"]);
        let file = path(&state, &task, "diagram").unwrap();
        assert!(file.ends_with("diagram.mmd"));

        // Nothing written yet: no version.
        follow(&state, &task.id);
        turn_ended(&state, &task.id);
        assert!(versions(&state, &task.id).is_empty());

        write(&file, "flowchart LR\n  a", 1);
        follow(&state, &task.id);
        write(&file, "flowchart LR\n  a --> b", 2);
        follow(&state, &task.id);
        assert_eq!(versions(&state, &task.id), vec![(1, "flowchart LR\n  a --> b".into(), true)]);
        let at = db::get_task(&state.db(), &task.id).unwrap().unwrap().document_at;
        assert!(at.is_some());
        turn_ended(&state, &task.id);
        assert_eq!(versions(&state, &task.id), vec![(1, "flowchart LR\n  a --> b".into(), false)]);

        // A turn that doesn't change it adds nothing; the next change is version 2.
        turn_ended(&state, &task.id);
        write(&file, "flowchart LR\n  a --> c", 3);
        turn_ended(&state, &task.id);
        let v = versions(&state, &task.id);
        assert_eq!(v.iter().map(|(n, _, open)| (*n, *open)).collect::<Vec<_>>(), vec![(1, false), (2, false)]);
        assert_eq!(v[1].1, "flowchart LR\n  a --> c");

        // A task with no labels has no documents.
        let code = task_of(&state, &[]);
        assert!(paths(&state, &code).is_empty());
        write(&path(&state, &code, "plan").unwrap(), "<h1>Plan</h1>", 1);
        turn_ended(&state, &code.id);
        assert!(versions(&state, &code.id).is_empty());
    }

    #[test]
    fn a_task_keeps_a_document_for_each_label() {
        let state = crate::testing::state();
        let task = task_of(&state, &["diagram", "plan"]);
        assert_eq!(labels(&task), ["plan", "diagram"]);
        let (plan, diagram) = (path(&state, &task, "plan").unwrap(), path(&state, &task, "diagram").unwrap());
        write(&plan, "<h1>Plan</h1>", 1);
        write(&diagram, "flowchart LR", 1);
        follow(&state, &task.id);
        let open = |l: &str, v: i64, c: &str, o: bool| (l.to_string(), v, c.to_string(), o);
        assert_eq!(labelled(&state, &task.id), vec![open("diagram", 1, "flowchart LR", true), open("plan", 1, "<h1>Plan</h1>", true)]);
        turn_ended(&state, &task.id);
        write(&plan, "<h1>Plan 2</h1>", 2);
        // Taking a label off mid-turn closes its version all the same, and stops following its file.
        follow(&state, &task.id);
        let task = db::update_task(&state.db(), &task.id, &[("labels", json!(["diagram"]))]).unwrap().unwrap();
        write(&plan, "<h1>Plan 3</h1>", 3);
        turn_ended(&state, &task.id);
        assert_eq!(
            labelled(&state, &task.id),
            vec![open("diagram", 1, "flowchart LR", false), open("plan", 1, "<h1>Plan</h1>", false), open("plan", 2, "<h1>Plan 2</h1>", false)]
        );
    }

    #[test]
    fn its_labels_are_known_ones_in_order() {
        assert_eq!(check_labels(&json!(["diagram", " plan", "plan"])), Ok(vec!["plan", "diagram"]));
        assert_eq!(check_labels(&json!(null)), Ok(vec![]));
        assert!(check_labels(&json!(["scratch"])).is_err());
        assert!(check_labels(&json!("plan")).is_err());
    }

    #[test]
    fn its_shell_and_wait_commands_run_in_its_folder() {
        let state = crate::testing::state();
        let p = db::insert_profile(&state.db(), "p", &[], None).unwrap();
        let np = db::NewProject { id: "pr", profile_id: &p.id, name: "Web", key: "WEB", repo_path: "/src/web", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
        db::insert_project(&state.db(), np).unwrap();
        db::update_project(&state.db(), "pr", &[("group_name", json!("Shop"))]).unwrap();
        let new = |project_id| db::NewTask { profile_id: &p.id, project_id, kind: "task", title: "t", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
        // A task made as a diagram task before they were labels, as the migration leaves it.
        let typed = |t: Task| {
            let fields = [("labels", json!(["diagram"])), ("work_dir", json!(format!("documents/{}", t.id)))];
            db::update_task(&state.db(), &t.id, &fields).unwrap().unwrap()
        };
        let in_project = db::insert_task(&state.db(), new(Some("pr"))).unwrap();
        let in_project = typed(in_project);
        let in_group = db::insert_group_task(&state.db(), new(None), "Shop").unwrap();
        let in_group = typed(in_group);
        for t in [&in_project, &in_group] {
            let d = dir(&state, &t.id);
            assert_eq!(work_dir(&state, t).as_ref(), Some(&d));
            // Where `wait` runs its command, and where the task's terminal opens.
            assert_eq!(crate::runner::work_dir(&state, t).unwrap(), d);
            assert_eq!(crate::terminal::working_dir(&state, t).unwrap(), path_str(&d));
        }
        // Labels don't move a task out of the repository.
        let code = db::insert_task(&state.db(), new(Some("pr"))).unwrap();
        let code = db::update_task(&state.db(), &code.id, &[("labels", json!(["diagram"]))]).unwrap().unwrap();
        assert!(!documents_only(&code));
        assert_eq!(work_dir(&state, &code), None);
        assert_eq!(crate::runner::work_dir(&state, &code).unwrap(), PathBuf::from("/src/web"));
    }

    #[test]
    fn a_codex_edit_shows_before_its_turn_ends() {
        let state = crate::testing::state();
        let task = task_of(&state, &["plan"]);
        let run = db::insert_run(&state.db(), &task.id, "prompt").unwrap();
        let file = path(&state, &task, "plan").unwrap();
        write(&file, "<h1>Plan</h1>", 1);
        let item = json!({"type": "fileChange", "id": "f1", "status": "completed", "changes": [{"path": path_str(&file), "kind": {"type": "add"}, "diff": "+<h1>Plan</h1>"}]});
        crate::codex::handle_line(&state, &run, &json!({"method": "item/completed", "params": {"item": item}})).unwrap();
        assert_eq!(versions(&state, &task.id), vec![(1, "<h1>Plan</h1>".into(), true)]);
        assert!(db::get_task(&state.db(), &task.id).unwrap().unwrap().document_at.is_some());
    }

    #[test]
    fn the_agent_writes_its_own_folder_without_asking() {
        let state = crate::testing::state();
        let task = task_of(&state, &["plan"]);
        let d = dir(&state, &task.id);
        let own = |tool: &str, file: PathBuf| writes_own_folder(&state, &task, tool, &json!({"file_path": path_str(&file)}));
        assert!(own("Write", d.join("plan.html")));
        assert!(own("Edit", d.join("notes/a.md")));
        assert!(!own("Bash", d.join("plan.html")));
        assert!(!own("Write", d.join("../other/plan.html")));
        assert!(!own("Write", state.data_dir.join("x.html")));
        assert!(!writes_own_folder(&state, &task, "Write", &json!({"file_path": "plan.html"})));
        // Not through a link out of the folder.
        std::fs::create_dir_all(&d).unwrap();
        let outside = state.data_dir.join("elsewhere");
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, d.join("out")).unwrap();
        assert!(!own("Write", d.join("out/x.html")));
        // Nor through one to a file that doesn't exist yet, which writing would create.
        std::os::unix::fs::symlink(outside.join("missing.html"), d.join("link.html")).unwrap();
        assert!(!own("Write", d.join("link.html")));
        std::os::unix::fs::symlink(outside.join("gone/x"), d.join("deep")).unwrap();
        assert!(!own("Write", d.join("deep/y.html")));
        assert!(!outside.join("missing.html").exists());
        assert!(own("Write", d.join("new/dir/x.html")));
        let code = task_of(&state, &[]);
        assert!(!writes_own_folder(&state, &code, "Write", &json!({"file_path": path_str(&dir(&state, &code.id).join("a"))})));
    }
}
