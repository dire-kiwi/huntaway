//! `huntaway threads-readers --db <file>`: what the board's features that read a thread (review,
//! summaries, titles, the wait tool's subagents and tasks' `last_message`) make of tasks' threads,
//! and how long each took. It only reads, so it can run on a copy of a live board
//! (scripts/copy-live-board.sh): run it before and after a change to the readers and compare the
//! answers (`--json`, with `--no-times` to leave out the times).

use std::path::Path;
use std::time::Instant;

use anyhow::{Context, Result};
use rusqlite::Connection;
use serde_json::{Value, json};

use super::history;
use super::report::{open, task_keys};
use crate::db;

/// How many of a thread's subagents are looked up as the wait tool does (each lookup used to read the whole thread).
const SUBAGENTS: usize = 20;

/// The answers of every reader for one task, and what each took (in ms).
fn readers(c: &Connection, task: &db::Task) -> Result<(Value, Value)> {
    let id = task.id.as_str();
    let mut answers = serde_json::Map::new();
    let mut times = serde_json::Map::new();
    let mut time = |name: &str, f: &mut dyn FnMut() -> Result<Value>| -> Result<()> {
        let started = Instant::now();
        let v = f()?;
        times.insert(name.into(), json!((started.elapsed().as_secs_f64() * 1e4).round() / 10.0));
        answers.insert(name.into(), v);
        Ok(())
    };
    let replies = |r: history::UserReplies| json!({"replies": r.replies, "since": r.since, "earlier": r.earlier});
    time("last_message", &mut || Ok(json!(history::last_said(c, id)?)))?;
    time("summary_written", &mut || Ok(json!(history::said_since_asked(c, id)?)))?;
    time("replies_review", &mut || Ok(replies(history::user_replies(c, id, Some(100))?)))?;
    time("replies_title", &mut || Ok(replies(history::user_replies(c, id, Some(30))?)))?;
    time("replies_all", &mut || Ok(replies(history::user_replies(c, id, None)?)))?;
    let since = task.review.as_ref().filter(|r| ["passed", "issues"].contains(&r.state.as_str())).map(|r| r.updated_at.clone());
    let calls = |since: Option<&str>| -> Result<Value> {
        let calls = history::tool_calls_since(c, id, since)?;
        let changing: Vec<&str> = calls.iter().filter(|t| crate::git::changes::changes_code(t)).map(|t| t.id.as_str()).collect();
        Ok(json!({"calls": calls.len(), "changing": changing}))
    };
    time("tool_calls", &mut || calls(None))?;
    time("tool_calls_since_review", &mut || calls(since.as_deref()))?;
    // The latest subagents task_* messages name (by Claude's task id and by call), as many as `SUBAGENTS`.
    let named = |field: &str| -> Result<Vec<String>> {
        let mut st = c.prepare(&format!(
            "SELECT json_extract(data, '$.{field}') FROM messages WHERE task_id=?1 AND kind='claude' AND data LIKE '%\"subtype\":\"task\\_%' ESCAPE '\\'
             AND json_type(data, '$.{field}')='text' ORDER BY id DESC"
        ))?;
        let mut rows: Vec<String> = Vec::new();
        for r in st.query_map([id], |r| r.get::<_, String>(0))? {
            let r = r?;
            if !rows.contains(&r) {
                rows.push(r);
            }
            if rows.len() == SUBAGENTS {
                break;
            }
        }
        rows.sort();
        Ok(rows)
    };
    let (by_task, by_call) = (named("task_id")?, named("tool_use_id")?);
    time("subagent_calls", &mut || {
        let mut out = serde_json::Map::new();
        for t in &by_task {
            out.insert(format!("task:{t}"), json!(history::subagent_call(c, id, &json!({"task_id": t}))?));
        }
        for call in &by_call {
            out.insert(format!("call:{call}"), json!(history::subagent_call(c, id, &json!({"tool_use_id": call}))?));
        }
        Ok(Value::Object(out))
    })?;
    Ok((Value::Object(answers), Value::Object(times)))
}

/// `huntaway threads-readers`: the readers' answers for the tasks `ids` (ids or keys; all of them if
/// none), as JSON lines (one task each) or a summary of the times.
pub fn run(path: &Path, ids: &[String], json: bool, times: bool) -> Result<()> {
    let c = open(path, false)?;
    let keys = task_keys(&c)?;
    let wanted: Vec<&(String, String)> = if ids.is_empty() {
        keys.iter().collect()
    } else {
        ids.iter()
            .map(|id| keys.iter().find(|(i, k)| i == id || k.eq_ignore_ascii_case(id)).with_context(|| format!("no task {id}")))
            .collect::<Result<_>>()?
    };
    // Each reader's times, with the task's message count.
    let mut all: Vec<(String, i64, Value)> = Vec::new();
    for (id, key) in wanted {
        let task = db::get_task(&c, id)?.with_context(|| format!("no task {id}"))?;
        let messages: i64 = c.query_row("SELECT COUNT(*) FROM messages WHERE task_id=?1", [id], |r| r.get(0))?;
        let (answers, ms) = readers(&c, &task)?;
        if json {
            let mut line = json!({"task": key, "messages": messages, "answers": answers});
            if times {
                line["ms"] = ms.clone();
            }
            println!("{line}");
        }
        all.push((key.clone(), messages, ms));
    }
    if !json {
        all.sort_by_key(|(_, n, _)| -n);
        let names: Vec<String> = all.first().and_then(|(_, _, ms)| ms.as_object()).map(|m| m.keys().cloned().collect()).unwrap_or_default();
        println!("{:<10} {:>8}  {}", "task", "messages", names.iter().map(|n| format!("{n:>24}")).collect::<String>());
        for (key, n, ms) in all.iter().take(15) {
            println!("{key:<10} {n:>8}  {}", names.iter().map(|k| format!("{:>21.1} ms", ms[k].as_f64().unwrap_or(0.0))).collect::<String>());
        }
        let total = |k: &str| all.iter().map(|(_, _, ms)| ms[k].as_f64().unwrap_or(0.0)).sum::<f64>();
        println!("{:<10} {:>8}  {}", "total", all.iter().map(|(_, n, _)| n).sum::<i64>(), names.iter().map(|k| format!("{:>21.0} ms", total(k))).collect::<String>());
    }
    Ok(())
}
