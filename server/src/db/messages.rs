//! A thread's messages, and the message queued for its next run.

use super::*;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Message {
    pub id: i64,
    pub task_id: String,
    pub kind: String,
    pub data: Value,
    pub created_at: String,
}

impl Message {
    pub fn from_row(r: &Row) -> rusqlite::Result<Self> {
        let data: String = r.get("data")?;
        Ok(Self {
            id: r.get("id")?,
            task_id: r.get("task_id")?,
            kind: r.get("kind")?,
            data: serde_json::from_str(&data).unwrap_or(Value::Null),
            created_at: r.get("created_at")?,
        })
    }
}

// ---------- queued messages ----------

/// A message to send, or queued for an agent: the user's, other agents' (MCP `send_to_task`),
/// or both together.
#[derive(Clone, Debug, PartialEq)]
pub struct Queued {
    pub text: String,
    /// Other agents sent all of it, so analytics don't take it for the user's.
    pub from_agent: bool,
    /// The parts the user sent, if any.
    pub user_text: Option<String>,
}

impl Queued {
    pub fn new(text: &str, from_agent: bool) -> Self {
        Self { text: text.to_string(), from_agent, user_text: (!from_agent).then(|| text.to_string()) }
    }

    /// Nothing: what's queued goes as it is (see runner::send_queued).
    pub fn empty() -> Self {
        Self { text: String::new(), from_agent: true, user_text: None }
    }

    /// This message, then `next` after it.
    pub fn then(self, next: Queued) -> Self {
        let join = |a: String, b: String| match (a.trim().is_empty(), b.trim().is_empty()) {
            (true, _) => b,
            (_, true) => a,
            _ => format!("{a}\n\n{b}"),
        };
        let user_text = match (self.user_text, next.user_text) {
            (Some(a), Some(b)) => Some(join(a, b)),
            (a, b) => a.or(b),
        };
        Self { text: join(self.text, next.text), from_agent: self.from_agent && next.from_agent, user_text }
    }
}

/// Add a message to the one queued on a thread.
pub fn queue(c: &Connection, task_id: &str, message: Queued) -> Result<Option<Task>> {
    let Some(task) = get_task(c, task_id)? else { return Ok(None) };
    let queued = match task.queued_message.filter(|q| !q.trim().is_empty()) {
        Some(text) => Queued { text, from_agent: queued_from_agent(c, task_id)?, user_text: task.queued_user_text }.then(message),
        None => message,
    };
    c.execute(
        "UPDATE tasks SET queued_message=?2, queued_from_agent=?3, queued_user_text=?4, updated_at=?5 WHERE id=?1",
        params![task_id, queued.text, queued.from_agent, queued.user_text, now()],
    )?;
    get_task(c, task_id)
}

fn queued_from_agent(c: &Connection, task_id: &str) -> Result<bool> {
    Ok(c.query_row("SELECT queued_from_agent FROM tasks WHERE id=?1", [task_id], |r| r.get(0))?)
}

/// Take the message queued on a thread.
pub fn take_queued(c: &Connection, task_id: &str) -> Result<Option<Queued>> {
    let queued = get_task(c, task_id)?
        .and_then(|t| Some((t.queued_message.filter(|q| !q.trim().is_empty())?, t.queued_user_text)))
        .map(|(text, user_text)| Ok::<_, anyhow::Error>(Queued { text, from_agent: queued_from_agent(c, task_id)?, user_text }))
        .transpose()?;
    clear_queued(c, task_id)?;
    Ok(queued)
}

pub fn clear_queued(c: &Connection, task_id: &str) -> Result<Option<Task>> {
    c.execute("UPDATE tasks SET queued_message=NULL, queued_from_agent=0, queued_user_text=NULL, updated_at=?2 WHERE id=?1", params![task_id, now()])?;
    get_task(c, task_id)
}

// ---------- messages ----------

pub fn insert_message(c: &Connection, task_id: &str, kind: &str, data: &Value) -> Result<Message> {
    let ts = now();
    c.execute(
        "INSERT INTO messages (task_id,kind,data,created_at) VALUES (?1,?2,?3,?4)",
        params![task_id, kind, data.to_string(), ts],
    )?;
    let id = c.last_insert_rowid();
    c.execute("UPDATE tasks SET last_activity_at=?1 WHERE id=?2", params![ts, task_id])?;
    Ok(Message { id, task_id: task_id.to_string(), kind: kind.to_string(), data: data.clone(), created_at: ts })
}

pub fn update_message_data(c: &Connection, id: i64, data: &Value) -> Result<Option<Message>> {
    c.execute("UPDATE messages SET data=?1 WHERE id=?2", params![data.to_string(), id])?;
    Ok(c.query_row("SELECT * FROM messages WHERE id=?1", [id], Message::from_row).optional()?)
}

pub fn list_messages(c: &Connection, task_id: &str) -> Result<Vec<Message>> {
    let mut st = c.prepare("SELECT * FROM messages WHERE task_id=?1 ORDER BY id")?;
    let rows = st.query_map([task_id], Message::from_row)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// A page stops once it has this much message data, even short of its limit (some tool results are huge).
pub(super) const PAGE_BYTES: usize = 1 << 20;

/// The latest messages of a thread with ids between `after` and `before` (both exclusive, if given),
/// oldest first, and whether there are older ones in that range. With a `limit`, the page holds that
/// many of the main conversation's messages (or about a megabyte of messages), with the subagents'
/// own messages among them; it starts with a main-conversation message.
pub fn message_page(c: &Connection, task_id: &str, after: Option<i64>, before: Option<i64>, limit: Option<usize>) -> Result<(Vec<Message>, bool)> {
    let mut st = c.prepare("SELECT * FROM messages WHERE task_id=?1 AND id>?2 AND id<?3 ORDER BY id DESC")?;
    let mut rows = st.query(params![task_id, after.unwrap_or(i64::MIN), before.unwrap_or(i64::MAX)])?;
    let (mut page, mut main, mut bytes) = (Vec::<Message>::new(), 0, 0);
    while let Some(r) = rows.next()? {
        // Subagents' messages carry the call that started them. Those don't count, and a page doesn't stop among them.
        let full = limit.is_some_and(|n| main >= n.max(1) || bytes >= PAGE_BYTES);
        if full && page.last().is_some_and(|m| m.data["parent_tool_use_id"].is_null()) {
            page.reverse();
            return Ok((page, true));
        }
        bytes += r.get_ref("data")?.as_str().map_or(0, str::len);
        let m = Message::from_row(r)?;
        main += m.data["parent_tool_use_id"].is_null() as usize;
        page.push(m);
    }
    page.reverse();
    Ok((page, false))
}

/// What the UI needs to list a thread's subagents from before message `before` (it shows their
/// count and state with only the latest messages loaded): the messages with their launching calls,
/// the results of those calls, and their task_* system messages (only the latest progress of each).
/// They're cut down to the parts about subagents, with their prompts and reports clipped: the
/// thread loads back to a subagent to show it in full.
pub fn subagent_messages(c: &Connection, task_id: &str, before: i64) -> Result<Vec<Message>> {
    // Forked Skills have no Agent/Task call: their local_agent lifecycle identifies the call.
    // Look beyond `before` too, as a page can start between the launch and task_started.
    let mut starts = c.prepare(
        "SELECT json_extract(data, '$.tool_use_id') FROM messages WHERE task_id=?1 AND kind='claude'
         AND data LIKE '%\"task_started\"%' AND json_extract(data, '$.type')='system'
         AND json_extract(data, '$.subtype')='task_started' AND json_extract(data, '$.task_type')='local_agent'
         AND json_type(data, '$.tool_use_id')='text'",
    )?;
    let mut calls = starts.query_map([task_id], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<std::collections::HashSet<_>>>()?;
    let mut st = c.prepare("SELECT * FROM messages WHERE task_id=?1 AND id<?2 AND kind='claude' ORDER BY id")?;
    let mut rows = st.query(params![task_id, before])?;
    // The ids Claude's task_* messages give subagents, besides the calls.
    let mut task_ids = std::collections::HashSet::<String>::new();
    let mut progress = std::collections::HashMap::<String, usize>::new();
    let mut out: Vec<Option<Message>> = Vec::new();
    let clip = |v: &mut Value| {
        if let Some(s) = v.as_str().filter(|s| s.chars().count() > 200) {
            *v = Value::String(s.chars().take(200).collect());
        }
    };
    while let Some(r) = rows.next()? {
        let data = r.get_ref("data")?.as_str()?;
        let call = data.contains("\"tool_use\"") && (data.contains("\"name\":\"Agent\"") || data.contains("\"name\":\"Task\"") || calls.iter().any(|id| data.contains(id.as_str())));
        let result = !calls.is_empty() && data.contains("\"tool_result\"") && calls.iter().any(|id| data.contains(id.as_str()));
        let system = data.contains("\"subtype\":\"task_");
        if !call && !result && !system {
            continue;
        }
        let mut m = Message::from_row(r)?;
        let d = &mut m.data;
        match d["type"].as_str() {
            Some("assistant") if call => {
                let mut blocks: Vec<Value> = d["message"]["content"].as_array().into_iter().flatten().filter(|b| {
                    b["type"] == "tool_use" && (b["name"] == "Agent" || b["name"] == "Task" || b["id"].as_str().is_some_and(|id| calls.contains(id)))
                }).cloned().collect();
                if blocks.is_empty() {
                    continue;
                }
                blocks.iter_mut().filter_map(|b| b.pointer_mut("/input/prompt")).for_each(clip);
                calls.extend(blocks.iter().filter_map(|b| b["id"].as_str().map(String::from)));
                d["message"] = json!({"content": blocks});
            }
            Some("user") if result => {
                let blocks: Vec<Value> = d["message"]["content"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|b| b["type"] == "tool_result" && b["tool_use_id"].as_str().is_some_and(|id| calls.contains(id)))
                    .map(|b| {
                        // The start of the report is enough to tell a background subagent's launch.
                        let text = match &b["content"] {
                            Value::String(s) => s.clone(),
                            Value::Array(a) => a.iter().filter_map(|c| c["text"].as_str()).collect::<Vec<_>>().join("\n"),
                            _ => String::new(),
                        };
                        let mut text = Value::String(text);
                        clip(&mut text);
                        json!({"type": "tool_result", "tool_use_id": b["tool_use_id"], "is_error": b["is_error"], "content": text})
                    })
                    .collect();
                if blocks.is_empty() {
                    continue;
                }
                let meta = &d["tool_use_result"];
                let keep = ["resolvedModel", "agentType", "totalToolUseCount", "isAsync", "status"];
                let meta: serde_json::Map<String, Value> = keep.iter().filter(|k| !meta[**k].is_null()).map(|k| (k.to_string(), meta[*k].clone())).collect();
                *d = json!({"type": "user", "parent_tool_use_id": d["parent_tool_use_id"], "message": {"content": blocks}, "tool_use_result": meta});
            }
            Some("system") if system => {
                let task = d["task_id"].as_str().map(String::from);
                match d["tool_use_id"].as_str() {
                    Some(id) if calls.contains(id) => task_ids.extend(task.clone()),
                    None if task.as_ref().is_some_and(|t| task_ids.contains(t)) => {}
                    _ => continue,
                }
                d.get_mut("prompt").into_iter().for_each(clip);
                d.get_mut("summary").into_iter().for_each(clip);
                if d["subtype"] == "task_progress" {
                    let key = d["tool_use_id"].as_str().map(String::from).or(task).unwrap_or_default();
                    if let Some(i) = progress.insert(key, out.len()) {
                        out[i] = None;
                    }
                }
            }
            _ => continue,
        }
        out.push(Some(m));
    }
    Ok(out.into_iter().flatten().collect())
}

/// The tool calls (`tool_use` blocks) an agent made in a thread, each with its result
/// (`tool_result` block) if it has one, after `since` (a timestamp) if given, oldest first.
pub fn tool_calls_since(c: &Connection, task_id: &str, since: Option<&str>) -> Result<Vec<(Value, Option<Value>)>> {
    let mut st =
        c.prepare("SELECT data FROM messages WHERE task_id=?1 AND kind='claude' AND created_at>?2 AND data LIKE '%tool\\_use%' ESCAPE '\\' ORDER BY id")?;
    let mut rows = st.query(params![task_id, since.unwrap_or("")])?;
    let mut calls = Vec::new();
    let mut results = std::collections::HashMap::new();
    while let Some(r) = rows.next()? {
        let data: String = r.get(0)?;
        let v: Value = serde_json::from_str(&data).unwrap_or(Value::Null);
        let Some(blocks) = v["message"]["content"].as_array() else { continue };
        for b in blocks {
            match (v["type"].as_str(), b["type"].as_str()) {
                (Some("assistant"), Some("tool_use")) => calls.push(b.clone()),
                (Some("user"), Some("tool_result")) => {
                    if let Some(id) = b["tool_use_id"].as_str() {
                        results.insert(id.to_string(), b.clone());
                    }
                }
                _ => {}
            }
        }
    }
    Ok(calls
        .into_iter()
        .map(|call| {
            let result = call["id"].as_str().and_then(|id| results.remove(id));
            (call, result)
        })
        .collect())
}

/// The most recent assistant text in a thread (used for summaries in MCP tools).
pub fn last_assistant_text(c: &Connection, task_id: &str) -> Result<Option<String>> {
    last_assistant_text_after(c, task_id, 0)
}

/// The most recent assistant text in a thread after message `after` (an id).
pub fn last_assistant_text_after(c: &Connection, task_id: &str, after: i64) -> Result<Option<String>> {
    let mut st = c.prepare("SELECT data FROM messages WHERE task_id=?1 AND kind='claude' AND id > ?2 ORDER BY id DESC LIMIT 50")?;
    let mut rows = st.query(params![task_id, after])?;
    while let Some(r) = rows.next()? {
        let data: String = r.get(0)?;
        let v: Value = serde_json::from_str(&data).unwrap_or(Value::Null);
        if v["type"] == "result" {
            if let Some(s) = v["result"].as_str() {
                if !s.is_empty() {
                    return Ok(Some(s.to_string()));
                }
            }
        }
        if v["type"] == "assistant" {
            if let Some(blocks) = v["message"]["content"].as_array() {
                let text: Vec<&str> = blocks.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect();
                if !text.is_empty() {
                    return Ok(Some(text.join("\n")));
                }
            }
        }
    }
    Ok(None)
}

/// What the user said in a thread themselves (not the board's messages, nor other agents'): see `user_replies`.
#[derive(Debug, PartialEq, Default)]
pub struct UserReplies {
    /// Oldest first, each with what the agent said last before it (the question it answers, say), if anything.
    pub replies: Vec<(Option<String>, String)>,
    /// What the agent has said since the last of them, if anything.
    pub since: Option<String>,
    /// How many earlier ones a `limit` left out.
    pub earlier: usize,
}

/// The user's own messages in a thread (`UserReplies`), the latest `limit` of them if given.
/// Read newest first, so a long thread is only read back as far as those, and the agent's
/// messages are only parsed while looking for what it said before one (tool results can be big).
pub fn user_replies(c: &Connection, task_id: &str, limit: Option<usize>) -> Result<UserReplies> {
    let mut st = c.prepare("SELECT id, kind, data FROM messages WHERE task_id=?1 AND kind IN ('claude','user') ORDER BY id DESC")?;
    let mut rows = st.query([task_id])?;
    let mut out = UserReplies::default();
    // Nothing from the user yet (going back), so what the agent says is what it said `since`.
    let mut latest = true;
    // The reply found last (id and text), until what the agent said before it is.
    let mut pending: Option<(i64, String)> = None;
    // The id of a reply past the limit: it and those before it are left out.
    let mut cut = None;
    while let Some(r) = rows.next()? {
        let (id, kind) = (r.get::<_, i64>(0)?, r.get_ref(1)?.as_str()?);
        if kind == "user" {
            let Some(text) = reply_text(r.get_ref(2)?.as_str()?) else { continue };
            latest = false;
            // Nothing from the agent between the two.
            out.replies.extend(pending.take().map(|(_, p)| (None, p)));
            if limit.is_some_and(|n| out.replies.len() >= n) {
                cut = Some(id + 1);
                break;
            }
            pending = Some((id, text));
        } else if latest || pending.is_some() {
            let Some(text) = agent_text(r.get_ref(2)?.as_str()?) else { continue };
            if latest {
                out.since = Some(text);
                latest = false;
            } else if let Some((id, p)) = pending.take() {
                out.replies.push((Some(text), p));
                if limit.is_some_and(|n| out.replies.len() >= n) {
                    cut = Some(id);
                    break;
                }
            }
        }
    }
    out.replies.extend(pending.map(|(_, p)| (None, p)));
    out.replies.reverse();
    if let Some(before) = cut {
        drop(rows);
        let mut st = c.prepare("SELECT data FROM messages WHERE task_id=?1 AND kind='user' AND id<?2")?;
        let mut rows = st.query(params![task_id, before])?;
        while let Some(r) = rows.next()? {
            out.earlier += reply_text(r.get_ref(0)?.as_str()?).is_some() as usize;
        }
    }
    Ok(out)
}

/// A user message's text, if the user wrote it themselves.
fn reply_text(data: &str) -> Option<String> {
    let v: Value = serde_json::from_str(data).ok()?;
    // A message sent with other agents' (queued together) has the user's part apart.
    let text = v["user_text"].as_str().or(v["text"].as_str()).map(str::trim).unwrap_or("");
    (v["auto"] != true && v["from_agent"] != true && !text.is_empty()).then(|| text.to_string())
}

/// The text of one of the agent's messages, if it has any.
fn agent_text(data: &str) -> Option<String> {
    // Most of a thread is tool calls and their results, which needn't be parsed.
    if !data.contains("\"assistant\"") || !data.contains("\"text\"") {
        return None;
    }
    let v: Value = serde_json::from_str(data).ok()?;
    if v["type"] != "assistant" {
        return None;
    }
    let blocks = v["message"]["content"].as_array()?;
    let text: Vec<&str> = blocks.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect();
    (!text.is_empty()).then(|| text.join("\n"))
}
