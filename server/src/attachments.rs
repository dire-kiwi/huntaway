//! Files attached to prompts (pasted, dropped or picked in the UI). Each is saved on the host
//! that runs the agent, under `<data-dir>/attachments/<id>/<name>`, and the UI lists their
//! paths at the end of the message; agents get read access to the folder (`--add-dir`).
//! Uploads and downloads are JSON with base64 data, so they travel through a hub like any
//! other request.
//!
//! A task's files are removed with it, and files nothing refers to any more (abandoned drafts,
//! removed chips) are pruned after a while.

use std::collections::HashSet;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use axum::Json;
use axum::extract::{Path, State};
use base64::Engine;
use serde::Deserialize;
use serde_json::{Value, json};

use anyhow::Result;
use rusqlite::Connection;

use crate::state::{ApiError, ApiResult, Shared};
use crate::util::path_str;

/// Heads the list of files at the end of a message (app: attachments.ts).
pub const HEADER: &str = "Attached files:";

/// Largest file we take. Its base64 has to fit in one hub tunnel frame (16 MB).
pub const MAX_BYTES: usize = 10 << 20;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

pub fn dir(state: &Shared) -> PathBuf {
    state.data_dir.join("attachments")
}

#[derive(Deserialize)]
pub struct Upload {
    name: String,
    /// The file's contents, base64.
    data: String,
}

/// A name that's safe as a path segment and easy to quote: letters, digits, `.`, `-`, `_`.
fn clean_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let mut out: String = base.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' }).collect();
    out = out.trim_start_matches('.').to_string();
    if out.len() > 100 {
        // Keep the extension.
        let ext = out.rfind('.').map(|i| out[i..].to_string()).filter(|e| e.len() <= 10).unwrap_or_default();
        out = format!("{}{ext}", &out[..100 - ext.len()]);
    }
    if out.is_empty() { "file".into() } else { out }
}

fn mime(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "txt" | "md" | "log" | "csv" | "diff" | "patch" => "text/plain",
        _ => "application/octet-stream",
    }
}

/// `POST /attachments`: save a file and return where it is.
pub async fn upload(State(s): State<Shared>, Json(b): Json<Upload>) -> ApiResult<Json<Value>> {
    let data = B64.decode(b.data.trim()).map_err(|_| ApiError::bad("data must be base64"))?;
    if data.len() > MAX_BYTES {
        return Err(ApiError::bad(format!("{} is larger than {} MB", b.name, MAX_BYTES >> 20)));
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    let name = clean_name(&b.name);
    let folder = dir(&s).join(&id);
    let path = folder.join(&name);
    tokio::fs::create_dir_all(&folder).await.map_err(|e| ApiError::bad(format!("saving {name}: {e}")))?;
    tokio::fs::write(&path, &data).await.map_err(|e| ApiError::bad(format!("saving {name}: {e}")))?;
    Ok(Json(json!({"id": id, "name": name, "path": path_str(&path), "size": data.len(), "mime": mime(&name)})))
}

/// `GET /attachments/{id}/{name}`: a saved file, base64.
pub async fn download(State(s): State<Shared>, Path((id, name)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    if !id.chars().all(|c| c.is_ascii_hexdigit()) || id.is_empty() || name != clean_name(&name) {
        return Err(ApiError::not_found("attachment"));
    }
    let data = tokio::fs::read(dir(&s).join(&id).join(&name)).await.map_err(|_| ApiError::not_found("attachment"))?;
    Ok(Json(json!({"name": name, "size": data.len(), "mime": mime(&name), "data": B64.encode(&data)})))
}

/// Ids of the attachments `text` refers to (`…/attachments/<id>/…`).
fn ids_in(text: &str) -> impl Iterator<Item = &str> {
    text.match_indices("attachments").filter_map(move |(i, m)| {
        // In JSON a Windows path's separators are doubled.
        let rest = text[i + m.len()..].trim_start_matches(['/', '\\']);
        let id = rest.get(..32)?;
        let sep = rest[32..].starts_with(['/', '\\']);
        (sep && id.bytes().all(|b| b.is_ascii_hexdigit())).then_some(id)
    })
}

/// Collect the ids that a query's text column refers to.
fn collect(c: &Connection, sql: &str, args: impl rusqlite::Params, out: &mut HashSet<String>) -> Result<()> {
    let mut st = c.prepare(sql)?;
    let mut rows = st.query(args)?;
    while let Some(r) = rows.next()? {
        let text: Option<String> = r.get(0)?;
        out.extend(text.as_deref().into_iter().flat_map(ids_in).map(str::to_string));
    }
    Ok(())
}

/// Attachments referred to by a task: its description, queued message, messages its agent
/// hasn't read yet (`steering`) and thread.
pub fn of_task(c: &Connection, task_id: &str) -> Result<HashSet<String>> {
    let mut ids = HashSet::new();
    collect(
        c,
        "SELECT description FROM tasks WHERE id=?1 UNION ALL SELECT queued_message FROM tasks WHERE id=?1 UNION ALL SELECT steering FROM tasks WHERE id=?1",
        [task_id],
        &mut ids,
    )?;
    collect(c, "SELECT data FROM messages WHERE task_id=?1 AND instr(data, 'attachments') > 0", [task_id], &mut ids)?;
    Ok(ids)
}

/// Attachments referred to by any task.
fn referenced(c: &Connection) -> Result<HashSet<String>> {
    let mut ids = HashSet::new();
    collect(c, "SELECT description FROM tasks WHERE instr(description, 'attachments') > 0", [], &mut ids)?;
    collect(c, "SELECT queued_message FROM tasks WHERE instr(queued_message, 'attachments') > 0", [], &mut ids)?;
    collect(c, "SELECT steering FROM tasks WHERE instr(steering, 'attachments') > 0", [], &mut ids)?;
    collect(c, "SELECT data FROM messages WHERE instr(data, 'attachments') > 0", [], &mut ids)?;
    Ok(ids)
}

/// Remove those of `ids` that no task refers to any more (after deleting the tasks that did).
pub fn remove_unreferenced(state: &Shared, ids: &HashSet<String>) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let keep = referenced(&state.db())?;
    for id in ids.difference(&keep) {
        let path = dir(state).join(id);
        if path.is_dir() {
            std::fs::remove_dir_all(&path)?;
        }
    }
    Ok(())
}

/// How long a file nothing refers to is kept: long enough for a draft to be sent.
const UNUSED_FOR: Duration = Duration::from_secs(7 * 24 * 3600);
const PRUNE_EVERY: Duration = Duration::from_secs(6 * 3600);

/// Remove files that no task has referred to for a while. Returns how many.
fn prune(state: &Shared) -> Result<usize> {
    let Ok(entries) = std::fs::read_dir(dir(state)) else { return Ok(0) };
    let cutoff = SystemTime::now() - UNUSED_FOR;
    let old: Vec<_> = entries
        .flatten()
        .filter(|e| e.metadata().and_then(|m| m.modified()).is_ok_and(|t| t < cutoff))
        .filter_map(|e| Some((e.file_name().into_string().ok()?, e.path())))
        .collect();
    if old.is_empty() {
        return Ok(0);
    }
    let keep = referenced(&state.db())?;
    let mut removed = 0;
    for (id, path) in old.into_iter().filter(|(id, _)| !keep.contains(id)) {
        match std::fs::remove_dir_all(&path) {
            Ok(()) => removed += 1,
            Err(e) => tracing::warn!("attachments: removing {id}: {e}"),
        }
    }
    Ok(removed)
}

/// Prune unused attachments now and every few hours.
pub fn start_pruner(state: &Shared) {
    let s = state.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(PRUNE_EVERY);
        loop {
            tick.tick().await;
            let st = s.clone();
            match tokio::task::spawn_blocking(move || prune(&st)).await {
                Ok(Ok(0)) => {}
                Ok(Ok(n)) => tracing::info!("attachments: removed {n} no longer referred to"),
                Ok(Err(e)) => tracing::warn!("attachments: pruning failed: {e:#}"),
                Err(e) => tracing::warn!("attachments: pruning failed: {e}"),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_found_in_messages() {
        let a = "0123456789abcdef0123456789abcdef";
        let b = "fedcba9876543210fedcba9876543210";
        let text = format!(
            "Attached files:\n- /home/me/.local/share/huntaway/attachments/{a}/x.png\n{{\"text\":\"C:\\\\data\\\\attachments\\\\{b}\\\\y.txt\"}}"
        );
        assert_eq!(ids_in(&text).collect::<Vec<_>>(), [a, b]);
        assert_eq!(ids_in("attachments/0123/x attachments attachments/").count(), 0);
    }

    #[test]
    fn messages_the_agent_hasnt_read_yet_are_referred_to() {
        let state = crate::testing::state();
        let p = crate::db::insert_profile(&state.db(), "p", &[], None).unwrap();
        let t = crate::db::NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "t", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let task = crate::db::insert_task(&state.db(), t).unwrap();
        let a = "0123456789abcdef0123456789abcdef";
        let steer = serde_json::json!([{"id": "s", "text": format!("Attached files:\n- /data/attachments/{a}/x.png"), "from_agent": false, "run_id": "r", "written": true}]);
        crate::db::update_task(&state.db(), &task.id, &[("steering", steer)]).unwrap();
        assert!(of_task(&state.db(), &task.id).unwrap().contains(a));
        assert!(referenced(&state.db()).unwrap().contains(a));
    }

    #[test]
    fn names_are_cleaned() {
        assert_eq!(clean_name("Screenshot 2026-10-24 at 10.00.png"), "Screenshot_2026-10-24_at_10.00.png");
        assert_eq!(clean_name("../../etc/passwd"), "passwd");
        assert_eq!(clean_name("..\\x.txt"), "x.txt");
        assert_eq!(clean_name(".."), "file");
        assert_eq!(clean_name(".env"), "env");
        assert_eq!(clean_name("ü.png"), "_.png");
        let long = format!("{}.png", "a".repeat(200));
        assert_eq!(clean_name(&long).len(), 100);
        assert!(clean_name(&long).ends_with(".png"));
    }
}
