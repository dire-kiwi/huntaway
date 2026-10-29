//! Plan, artifact and diagram tasks (see db::Task::task_type) make a document rather than code
//! changes: an HTML page (a plan to iterate on, or an artifact) or a Mermaid diagram. The agent
//! writes it to a file in the task's own folder, which is its working directory, and the board
//! keeps each version in the database and shows it in the task (`GET /tasks/{id}/document`).
//!
//! A version follows the file while the agent's turn goes on, so the task shows the document as
//! it's written, and is closed when the turn ends: the next change starts a new version, so
//! there's one per turn that changed it.

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

/// The file a task of this type writes its document to, in its folder.
pub fn file_name(task_type: &str) -> Option<&'static str> {
    match task_type {
        "plan" => Some("plan.html"),
        "artifact" => Some("artifact.html"),
        "diagram" => Some("diagram.mmd"),
        _ => None,
    }
}

/// A task's own folder: its agent's working directory, which holds its document (a scratch
/// task's holds whatever its agent writes).
pub fn dir(state: &Shared, task_id: &str) -> PathBuf {
    state.data_dir.join("documents").join(task_id)
}

/// Where a plan, artifact, diagram or scratch task's agent works (and its shell and wait
/// commands run): the task's own folder, or for a scratch task that was a scratch chat, the
/// chat's. None for any other thread, which works where its kind and project say (see
/// runner::work_dir).
pub fn work_dir(state: &Shared, task: &Task) -> Option<PathBuf> {
    (task.kind == "task" && task.task_type.is_some()).then(|| match &task.work_dir {
        Some(d) => crate::util::expand_tilde(d),
        None => dir(state, &task.id),
    })
}

/// Where a task's agent writes its document, if it makes one.
pub fn path(state: &Shared, task: &Task) -> Option<PathBuf> {
    let name = file_name(task.task_type.as_deref()?)?;
    Some(dir(state, &task.id).join(name))
}

/// Remove a deleted task's folder (its versions go with the task's row).
pub fn remove(state: &Shared, task_id: &str) {
    if let Some(seen) = SEEN.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        seen.remove(task_id);
    }
    let d = dir(state, task_id);
    if d.exists() {
        if let Err(e) = std::fs::remove_dir_all(&d) {
            tracing::warn!(task = task_id, "removing the task's document folder failed: {e}");
        }
    }
}

/// Whether a tool call only writes to files in the task's own folder, which its agent may do
/// without asking: that's where it writes its document.
pub fn writes_own_folder(state: &Shared, task: &Task, tool_name: &str, input: &Value) -> bool {
    if task.task_type.is_none() || !["Write", "Edit", "MultiEdit", "NotebookEdit"].contains(&tool_name) {
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

/// The size and modification time each task's document file had when last looked at, so
/// following it during a turn doesn't read an unchanged file again.
static SEEN: Mutex<Option<HashMap<String, (u64, SystemTime)>>> = Mutex::new(None);

/// During a turn, after a tool call: keep the document if the agent changed it.
pub fn follow(state: &Shared, task_id: &str) {
    keep(state, task_id, false);
}

/// At the end of a turn (or of the run): keep the document if it changed, and close its version.
pub fn turn_ended(state: &Shared, task_id: &str) {
    keep(state, task_id, true);
}

fn keep(state: &Shared, task_id: &str, end_of_turn: bool) {
    if let Err(e) = try_keep(state, task_id, end_of_turn) {
        tracing::warn!(task = task_id, "keeping the task's document failed: {e:#}");
    }
}

fn try_keep(state: &Shared, task_id: &str, end_of_turn: bool) -> anyhow::Result<()> {
    let Some(task) = db::get_task(&state.db(), task_id)? else { return Ok(()) };
    let Some(file) = path(state, &task) else { return Ok(()) };
    let stamp = std::fs::metadata(&file).ok().map(|m| (m.len(), m.modified().unwrap_or(SystemTime::UNIX_EPOCH)));
    let unchanged = {
        let mut seen = SEEN.lock().unwrap_or_else(|e| e.into_inner());
        let seen = seen.get_or_insert_with(HashMap::new);
        let same = stamp.is_some() && seen.get(task_id) == stamp.as_ref();
        match stamp {
            Some(st) => seen.insert(task_id.to_string(), st),
            None => seen.remove(task_id),
        };
        same
    };
    let content = match stamp {
        _ if unchanged && !end_of_turn => return Ok(()),
        None => None,
        Some((len, _)) if len > MAX_SIZE => {
            if end_of_turn {
                let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                state.add_event(task_id, "warn", format!("{name} is over {} MB, so this version isn't kept", MAX_SIZE >> 20), None);
            }
            None
        }
        Some(_) => std::fs::read(&file).ok().map(|b| String::from_utf8_lossy(&b).into_owned()),
    };
    let ts = now();
    let changed = {
        let c = state.db();
        let latest: Option<(i64, String, bool)> = c
            .query_row(
                "SELECT version, content, open FROM documents WHERE task_id=?1 ORDER BY version DESC LIMIT 1",
                [task_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        match (content, latest) {
            (Some(new), Some((_, old, open))) if new == old => {
                if end_of_turn && open {
                    c.execute("UPDATE documents SET open=0 WHERE task_id=?1 AND open=1", [task_id])?;
                }
                false
            }
            // The turn's version follows the file.
            (Some(new), Some((v, _, true))) => {
                c.execute(
                    "UPDATE documents SET content=?3, open=?4, updated_at=?5 WHERE task_id=?1 AND version=?2",
                    params![task_id, v, new, !end_of_turn, ts],
                )?;
                true
            }
            (Some(new), latest) => {
                let v = latest.map_or(1, |(v, _, _)| v + 1);
                c.execute(
                    "INSERT INTO documents (task_id, version, content, open, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?5)",
                    params![task_id, v, new, !end_of_turn, ts],
                )?;
                true
            }
            (None, _) => {
                if end_of_turn {
                    c.execute("UPDATE documents SET open=0 WHERE task_id=?1 AND open=1", [task_id])?;
                }
                false
            }
        }
    };
    if changed {
        state.update_task(task_id, &[("document_at", json!(ts))])?;
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct DocumentQuery {
    version: Option<i64>,
}

/// `GET /tasks/{id}/document[?version=N]`: a version of the task's document (the latest unless
/// asked for another), and the list of its versions. A version that's `open` is still being
/// written in the agent's current turn.
pub async fn get(State(s): State<Shared>, Path(id): Path<String>, Query(q): Query<DocumentQuery>) -> ApiResult<Json<Value>> {
    let task = db::get_task(&s.db(), &id)?.ok_or_else(|| ApiError::not_found("task"))?;
    let c = s.db();
    let mut st = c.prepare("SELECT version, open, created_at, updated_at, length(content) FROM documents WHERE task_id=?1 ORDER BY version")?;
    let versions: Vec<Value> = st
        .query_map([&id], |r| {
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
        Some(v) => c.query_row("SELECT content FROM documents WHERE task_id=?1 AND version=?2", params![id, v], |r| r.get(0)).optional()?,
        None => None,
    };
    if q.version.is_some() && content.is_none() {
        return Err(ApiError::not_found("version"));
    }
    Ok(Json(json!({
        "task_type": task.task_type,
        "file": path(&s, &task).map(|p| path_str(&p)),
        "versions": versions,
        "version": version.filter(|_| content.is_some()),
        "content": content,
    })))
}

/// What a plan, artifact or diagram task's agent is told about its job, after who it is and
/// where (`project`, or for a group task its group's `group_projects`).
pub fn system_prompt(task: &Task, file: &str, project: Option<&Project>, group_projects: &[Project]) -> String {
    let kind = task.task_type.as_deref().unwrap_or_default();
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
    let what = match kind {
        "plan" => "a plan, in HTML",
        "artifact" => "an artifact, as an HTML page",
        _ => "a Mermaid diagram",
    };
    s.push_str(&format!(
        " This is a {kind} task: rather than changing code, you make {what}. Write it to {file}; your working directory \
         is the task's own folder, where you can write freely. The board shows that file in the task as it changes, \
         and keeps a version of it from each turn. Don't change the repositories, commit, push or open pull requests."
    ));
    s.push_str(match kind {
        "plan" => {
            " The plan is HTML that the user reads and iterates on with you. Investigate before you write, so it's \
             grounded in specifics: read the code and name the files, modules, interfaces and data involved. Structure it \
             so it's easy to review: the goal and what's out of scope, how things work today, the approach (with the \
             alternatives you weighed and why not), the steps in order, each small enough to be one task for an agent, then \
             risks and open questions. Keep it easy to scan: clear headings, tables and lists where they help, and a \
             diagram where a picture says it better. Each message from the user is feedback on the plan: update the file \
             in place (edit it rather than rewriting it whole) and say briefly what changed. Put the questions you \
             need answered in the plan as <ia-question>s (below), with choices to pick from where you can suggest \
             them, and mention them at the end of your turn. The user answers them in the plan and sends the answers \
             when they're ready, as a message listing each question's answer by its name; then fold the answers into \
             the plan, and take the questions they settle out (or keep one with its answer as its default, if it's \
             still worth showing). When the user approves the plan and asks you to, \
             break it into tasks with `create_task`: they're recorded as this task's, and the board shows how many are \
             done.\n\n\
             The board shows the plan in its own theme (dark) with a readable column, and gives you components for it. \
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
             - <ia-diagram><svg viewBox=\"…\">…</svg></ia-diagram>: an inline SVG diagram; give shapes class \"box\" \
             (\"box accent\" to highlight), lines class \"edge\" (and arrowhead paths class \"arrow\"), and text is \
             themed already\n\
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
             --ok, --warn, --danger, --info, --font-sans, --font-mono."
        }
        "artifact" => {
            " The artifact is a single self-contained HTML page, the kind you'd make as an artifact on claude.ai: a \
             document, a visual explainer, a dashboard, an interactive tool or a prototype. Before you write it, load the \
             `artifact-design` skill if you have it and follow its design guidance (and the `dataviz` skill for charts), \
             but don't publish with the Artifact tool or upload it anywhere: this board stores and shows the page. Without \
             that skill, design with the same care: a clear visual hierarchy, a restrained palette, generous spacing, \
             legible type, and a layout that works from narrow to wide. Keep CSS and JavaScript inline; if you need a \
             library, load it from a well-known CDN (cdnjs, jsDelivr or unpkg). The page is shown in a sandboxed frame: \
             scripts run, but it has no cookies or local storage and can't reach the board. Each message from the user is \
             feedback: update the page in place (edit it rather than rewriting it whole) and say briefly what changed."
        }
        _ => {
            " The file holds just the diagram's Mermaid source, without Markdown fences, and the board renders it. Pick \
             the diagram type that fits what it shows (flowchart, sequenceDiagram, classDiagram, stateDiagram-v2, \
             erDiagram, gantt, mindmap, timeline, …), and ground it in the real thing: read the code and use the actual \
             names of components, calls and data. Keep it legible: a title (in `---\\ntitle: …\\n---` front matter), short \
             labels, subgraphs to group related parts, and no more than about 30 nodes; if there's more to show, say \
             which further diagrams would help rather than cramming them in. Make sure it parses: quote labels that \
             contain punctuation such as parentheses, brackets, colons or quotes. Each message from the user is feedback: \
             update the diagram in place and say briefly what changed."
        }
    });
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task_of(state: &Shared, task_type: Option<&str>) -> Task {
        let p = db::insert_profile(&state.db(), "p", &[], None).unwrap();
        let t = db::NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "t", description: "", status: "in_progress", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let t = db::insert_task(&state.db(), t).unwrap();
        db::update_task(&state.db(), &t.id, &[("task_type", json!(task_type))]).unwrap().unwrap()
    }

    fn versions(state: &Shared, id: &str) -> Vec<(i64, String, bool)> {
        let c = state.db();
        let mut st = c.prepare("SELECT version, content, open FROM documents WHERE task_id=?1 ORDER BY version").unwrap();
        st.query_map([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap().collect::<rusqlite::Result<_>>().unwrap()
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
        let task = task_of(&state, Some("diagram"));
        let file = path(&state, &task).unwrap();
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

        // A task that makes code has no document.
        let code = task_of(&state, None);
        assert!(path(&state, &code).is_none());
        follow(&state, &code.id);
        assert!(versions(&state, &code.id).is_empty());
    }

    #[test]
    fn its_shell_and_wait_commands_run_in_its_folder() {
        let state = crate::testing::state();
        let p = db::insert_profile(&state.db(), "p", &[], None).unwrap();
        let np = db::NewProject { id: "pr", profile_id: &p.id, name: "Web", key: "WEB", repo_path: "/src/web", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
        db::insert_project(&state.db(), np).unwrap();
        db::update_project(&state.db(), "pr", &[("group_name", json!("Shop"))]).unwrap();
        let new = |project_id| db::NewTask { profile_id: &p.id, project_id, kind: "task", title: "t", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let typed = |t: Task| db::update_task(&state.db(), &t.id, &[("task_type", json!("diagram"))]).unwrap().unwrap();
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
        let code = db::insert_task(&state.db(), new(Some("pr"))).unwrap();
        assert_eq!(work_dir(&state, &code), None);
        assert_eq!(crate::runner::work_dir(&state, &code).unwrap(), PathBuf::from("/src/web"));
    }

    #[test]
    fn a_codex_edit_shows_before_its_turn_ends() {
        let state = crate::testing::state();
        let task = task_of(&state, Some("plan"));
        let run = db::insert_run(&state.db(), &task.id, "prompt").unwrap();
        let file = path(&state, &task).unwrap();
        write(&file, "<h1>Plan</h1>", 1);
        let item = json!({"type": "fileChange", "id": "f1", "status": "completed", "changes": [{"path": path_str(&file), "kind": {"type": "add"}, "diff": "+<h1>Plan</h1>"}]});
        crate::codex::handle_line(&state, &run, &json!({"method": "item/completed", "params": {"item": item}})).unwrap();
        assert_eq!(versions(&state, &task.id), vec![(1, "<h1>Plan</h1>".into(), true)]);
        assert!(db::get_task(&state.db(), &task.id).unwrap().unwrap().document_at.is_some());
    }

    #[test]
    fn the_agent_writes_its_own_folder_without_asking() {
        let state = crate::testing::state();
        let task = task_of(&state, Some("plan"));
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
        let code = task_of(&state, None);
        assert!(!writes_own_folder(&state, &code, "Write", &json!({"file_path": path_str(&dir(&state, &code.id).join("a"))})));
    }
}
