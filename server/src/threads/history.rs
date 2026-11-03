//! A task's thread as agent-threads items and requests, in thread order, whichever thread layer the
//! task is on: what the board's features that read a thread (review, summaries, titles, the wait
//! tool and tasks' `last_message`) read, rather than Claude-shaped messages, so they work the same
//! for a legacy task and an agent-threads one.
//!
//! - A legacy task's stored messages are converted as they're read (`import::convert`). A whole
//!   thread can be thousands of messages and megabytes of tool results, so the readers that want its
//!   end (most) read a window of its latest messages, and a bigger one only if that doesn't settle
//!   it (`read_back`). A window's calls whose results come after it, and results whose calls came
//!   before it, are left unmatched, as a whole conversion leaves those it doesn't have: the readers
//!   here don't count on them.
//! - An agent-threads task's thread is the store's snapshot, with the saved events after it folded in.
//!
//! What the board knows about an item that the protocol has no place for (who sent a user message:
//! the user, the board itself or another agent) is its `Origin`. On a legacy thread it's in the
//! messages the items came from; on an agent-threads thread, it's in `at_item_origins`, where the
//! board records it when it sends a message (`record_origin`) and an import saves it (import::stage).

use std::collections::HashMap;

use agent_threads::protocol::{Item, NoticeLevel, Snapshot, Thread, ThreadEvent, ThreadRequest, ToolCall, ToolKind};
use agent_threads::reducer;
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::import::{self, Source};
use crate::db::{self, Message};

/// Which thread layer a task is on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Engine {
    /// The board's own runner, which stores Claude-shaped messages.
    Legacy,
    /// agent-threads: the thread is in the store (threads/store.rs).
    #[cfg_attr(not(test), allow(dead_code))]
    AgentThreads,
}

/// The thread layer `task` is on. This is the one place that tells: until tasks can run on
/// agent-threads (the task's `run_engine`, from the engine work in HA-128), every task is legacy.
/// A staged import (import::stage) isn't read: the messages are still the source.
pub fn engine(_task: &db::Task) -> Engine {
    #[cfg(test)]
    if let Some(e) = ENGINE.get() {
        return e;
    }
    Engine::Legacy
}

#[cfg(test)]
thread_local! {
    /// The thread layer every task is on, in a test that says.
    static ENGINE: std::cell::Cell<Option<Engine>> = const { std::cell::Cell::new(None) };
}

/// What the board knows about an item besides what the item says.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Origin {
    /// The stored message it came from, on a legacy thread (or one imported from it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<i64>,
    /// A user_message the board sent for itself (the start of a task, review issues to fix, a merge).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub auto: bool,
    /// A user_message that other agents sent all of (`send_to_task`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub from_agent: bool,
    /// Of a user_message sent along with other agents' messages, the user's own part.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_text: Option<String>,
    /// Of a tool_call, the harness's id for the call where the item's isn't it (a thread with two
    /// calls with one id, see import.rs).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    /// Of a subagent's tool_call, Claude's id for the subagent (its task_started's `task_id`), which
    /// its lifecycle notifications name it by.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_task: Option<String>,
}

impl Origin {
    /// What an item's id says of its origin: an imported item's `legacy:<message id>` (or
    /// `legacy:<message id>:<block>`) says its message.
    pub fn implied(item_id: &str) -> Origin {
        let message_id = item_id.strip_prefix("legacy:").and_then(|rest| rest.split(':').next()).and_then(|m| m.parse().ok());
        Origin { message_id, ..Default::default() }
    }

    /// Whether it says more than its message, which is all an imported item's id doesn't say (but a tool
    /// call's, whose id is the harness's), and which none of the readers here need of a tool call.
    pub fn says_more(&self) -> bool {
        *self != Origin { message_id: self.message_id, ..Default::default() }
    }
}

#[derive(Clone, Debug)]
pub struct Entry {
    pub item: Item,
    pub origin: Origin,
}

impl Entry {
    /// The user's own words, if it's a message the user sent: not the board's, nor other agents'.
    pub fn users_text(&self) -> Option<&str> {
        let Item::UserMessage(m) = &self.item else { return None };
        let o = &self.origin;
        let text = o.user_text.as_deref().unwrap_or(&m.text).trim();
        (!o.auto && !o.from_agent && !text.is_empty()).then_some(text)
    }

    /// The harness's id for a tool call.
    pub fn call_id(&self) -> Option<&str> {
        let Item::ToolCall(t) = &self.item else { return None };
        Some(self.origin.call_id.as_deref().unwrap_or(&t.id))
    }
}

/// A task's items, and their requests, in thread order (see the module's doc).
#[derive(Clone, Debug, Default)]
pub struct History {
    pub entries: Vec<Entry>,
    /// Oldest first, open and resolved. (None of the readers here needs them yet.)
    #[allow(dead_code)]
    pub requests: Vec<ThreadRequest>,
    /// Claude's ids for the subagents that started in it (`Origin::subagent_task`), and their calls'
    /// items (the latest, for an id given twice).
    pub subagent_tasks: HashMap<String, String>,
    /// It has the whole thread: it's no window, or a window that reaches the thread's start.
    pub whole: bool,
}

/// Which part of a thread to read.
#[derive(Clone, Copy, Debug)]
pub enum Window<'a> {
    All,
    /// What was added after a time (an RFC 3339 timestamp, as the board writes them).
    Since(&'a str),
    /// The latest messages, about this many (a legacy thread's; an agent-threads thread is read whole), of
    /// the part of the thread given.
    Latest(usize, Part),
    /// Only the user's messages (user_message items), all of them.
    UserMessages,
}

/// Which items to read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Part {
    Everything,
    /// What was said: the user_message, assistant_message, turn_result and notice items, which is all
    /// some readers need. On a legacy thread, they're from a fraction of its messages (most of a thread is
    /// tool calls and their results, which needn't be read).
    Said,
}

impl Part {
    fn has(self, item: &Item) -> bool {
        self == Part::Everything || matches!(item, Item::UserMessage(_) | Item::AssistantMessage(_) | Item::TurnResult(_) | Item::Notice(_))
    }
}

/// When an item was made, if it says.
fn created_at(item: &Item) -> Option<&str> {
    match item {
        Item::UserMessage(i) => i.created_at.as_deref(),
        Item::AssistantMessage(i) => i.created_at.as_deref(),
        Item::Reasoning(i) => i.created_at.as_deref(),
        Item::ToolCall(i) => i.created_at.as_deref(),
        Item::Compaction(i) => i.created_at.as_deref(),
        Item::Notice(i) => i.created_at.as_deref(),
        Item::TurnResult(i) => i.created_at.as_deref(),
    }
}

/// Part of `task_id`'s thread (see `Window`). A task that isn't there has an empty, whole one.
pub fn read(c: &Connection, task_id: &str, window: Window) -> Result<History> {
    let Some(task) = db::get_task(c, task_id)? else { return Ok(History { whole: true, ..Default::default() }) };
    read_on(c, &task, engine(&task), window)
}

/// `read`, on the thread layer given.
fn read_on(c: &Connection, task: &db::Task, engine: Engine, window: Window) -> Result<History> {
    match engine {
        Engine::Legacy => legacy(c, task, window),
        Engine::AgentThreads => stored(c, task, window),
    }
}

/// How many of the latest messages `read_back` reads first, and how many times more each time after.
const FIRST_WINDOW: usize = 25;
const GROWTH: usize = 8;

/// Reads back from the end of `task_id`'s thread (`part` of it) until `f` has what it wants: it's
/// given the latest messages' history, and the latest of more of them each time it returns None, until
/// it has the whole thread. It must answer then (its None is the answer).
pub fn read_back<T>(c: &Connection, task_id: &str, part: Part, mut f: impl FnMut(&History) -> Option<T>) -> Result<Option<T>> {
    let Some(task) = db::get_task(c, task_id)? else { return Ok(f(&History { whole: true, ..Default::default() })) };
    read_back_on(c, &task, engine(&task), part, &mut f)
}

fn read_back_on<T>(c: &Connection, task: &db::Task, engine: Engine, part: Part, f: &mut dyn FnMut(&History) -> Option<T>) -> Result<Option<T>> {
    let mut n = FIRST_WINDOW;
    loop {
        let h = read_on(c, task, engine, Window::Latest(n, part))?;
        if let Some(answer) = f(&h) {
            return Ok(Some(answer));
        }
        if h.whole {
            return Ok(None);
        }
        n = n.saturating_mul(GROWTH);
    }
}

fn legacy(c: &Connection, task: &db::Task, window: Window) -> Result<History> {
    let rows = |sql: &str, p: &[&dyn rusqlite::ToSql]| -> Result<Vec<Message>> {
        let mut st = c.prepare_cached(sql)?;
        let rows = st.query_map(p, Message::from_row)?.collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    };
    let id = task.id.as_str();
    let (messages, whole) = match window {
        Window::All => (rows("SELECT * FROM messages WHERE task_id=?1 ORDER BY id", &[&id])?, true),
        Window::Since(at) => (rows("SELECT * FROM messages WHERE task_id=?1 AND created_at>?2 ORDER BY id", &[&id, &at])?, false),
        Window::UserMessages => (rows("SELECT * FROM messages WHERE task_id=?1 AND kind='user' ORDER BY id", &[&id])?, false),
        Window::Latest(n, part) => {
            // What was said is in user messages, the agent's messages with text, and results (which can say
            // what a turn ended by saying, see import.rs). Claude's are stored as compact JSON.
            let only = match part {
                Part::Everything => "",
                Part::Said => {
                    "AND (kind='user' OR (kind='claude' AND ((instr(data, '\"type\":\"text\"') > 0 AND json_extract(data, '$.type')='assistant')
                       OR (instr(data, '\"type\":\"result\"') > 0 AND json_extract(data, '$.type')='result'))))"
                }
            };
            let limit = n.min(i64::MAX as usize) as i64;
            let mut m = rows(&format!("SELECT * FROM messages WHERE task_id=?1 {only} ORDER BY id DESC LIMIT ?2"), &[&id, &limit])?;
            m.reverse();
            let first = m.first().map_or(i64::MAX, |m| m.id);
            let whole = (m.len() as i64) < limit || !c.prepare_cached(&format!("SELECT 1 FROM messages WHERE task_id=?1 AND id<?2 {only}"))?.exists(params![id, first])?;
            (m, whole)
        }
    };
    let mut h = from_messages(task, &messages)?;
    h.whole = whole;
    Ok(h)
}

/// The history `messages` (a legacy thread's, or a window of them) convert into.
pub fn from_messages(task: &db::Task, messages: &[Message]) -> Result<History> {
    // The harness is only the converted thread's, which isn't kept.
    let mut conv = import::convert_as(&Source { task, harness: "claude", messages }, false)?;
    Ok(History::new(conv.snapshot.items, conv.snapshot.requests, |id| conv.origins.remove(id).unwrap_or_default()))
}

impl History {
    fn new(items: Vec<Item>, requests: Vec<ThreadRequest>, mut origin: impl FnMut(&str) -> Origin) -> History {
        let entries: Vec<Entry> = items.into_iter().map(|item| Entry { origin: origin(item.id()), item }).collect();
        let subagent_tasks = entries.iter().filter_map(|e| Some((e.origin.subagent_task.clone()?, e.item.id().to_string()))).collect();
        History { entries, requests, subagent_tasks, whole: true }
    }
}

/// Records what the board knows about item `item_id` of agent-threads thread `thread_id` (who sent
/// a user message, say) for the readers here. The engine calls it as it sends a message.
#[cfg_attr(not(test), allow(dead_code))]
pub fn record_origin(c: &Connection, thread_id: &str, item_id: &str, origin: &Origin) -> Result<()> {
    c.execute(
        "INSERT INTO at_item_origins (thread_id, item_id, data) VALUES (?1, ?2, ?3) ON CONFLICT (thread_id, item_id) DO UPDATE SET data=excluded.data",
        params![thread_id, item_id, serde_json::to_string(origin)?],
    )?;
    Ok(())
}

/// An agent-threads task's thread: its latest snapshot, and the saved events after it.
fn stored(c: &Connection, task: &db::Task, window: Window) -> Result<History> {
    let thread: Option<String> = c.query_row("SELECT data FROM at_threads WHERE id=?1", [&task.id], |r| r.get(0)).optional()?;
    let Some(thread) = thread else { return Ok(History { whole: true, ..Default::default() }) };
    let snapshot: Option<String> = c.query_row("SELECT data FROM at_snapshots WHERE thread_id=?1", [&task.id], |r| r.get(0)).optional()?;
    let mut state: Snapshot = match snapshot {
        Some(s) => serde_json::from_str(&s)?,
        None => reducer::initial_state(serde_json::from_str::<Thread>(&thread)?),
    };
    let mut st = c.prepare_cached("SELECT data FROM at_events WHERE thread_id=?1 AND seq>?2 ORDER BY seq")?;
    for e in st.query_map(params![task.id, state.seq.min(i64::MAX as u64) as i64], |r| r.get::<_, String>(0))? {
        reducer::apply_event(&mut state, &serde_json::from_str::<ThreadEvent>(&e?)?);
    }
    let keep = |item: &Item| match window {
        Window::All => true,
        Window::Latest(_, part) => part.has(item),
        Window::Since(at) => created_at(item).is_some_and(|t| t > at),
        Window::UserMessages => matches!(item, Item::UserMessage(_)),
    };
    let mut st = c.prepare_cached("SELECT item_id, data FROM at_item_origins WHERE thread_id=?1")?;
    let mut origins: HashMap<String, Origin> = HashMap::new();
    for row in st.query_map([&task.id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        let (item, data) = row?;
        origins.insert(item, serde_json::from_str(&data)?);
    }
    let items = state.items.into_iter().filter(keep).collect();
    let mut h = History::new(items, state.requests, |id| origins.remove(id).unwrap_or_else(|| Origin::implied(id)));
    h.whole = matches!(window, Window::All | Window::Latest(..));
    Ok(h)
}

// ---------- readers ----------

/// Something said in a thread, as the readers here see it.
#[derive(Debug, PartialEq)]
enum Said {
    /// The user's own words (`Entry::users_text`).
    User(String),
    /// One of the agent's messages (a legacy message's text blocks, joined by newlines), or an error
    /// the harness gave in its place (an error notice with a code: Claude's API errors, a usage limit).
    Agent(String),
    /// The error a turn of the agent's ended with (see `turn_error`).
    Failed(String),
}

impl History {
    /// What was said in it at or after entry `from`, newest first, with the index of the entry each starts at.
    fn said(&self, from: usize) -> Vec<(usize, Said)> {
        let mut out = Vec::new();
        let mut i = self.entries.len();
        while i > from {
            i -= 1;
            let e = &self.entries[i];
            match &e.item {
                Item::UserMessage(_) => out.extend(e.users_text().map(|t| (i, Said::User(t.to_string())))),
                Item::TurnResult(r) => out.extend(turn_error(r).map(|t| (i, Said::Failed(t.to_string())))),
                Item::Notice(n) if n.level == NoticeLevel::Error && n.code.is_some() => out.push((i, Said::Agent(n.text.clone()))),
                Item::AssistantMessage(m) => {
                    let mut texts = vec![m.text.as_str()];
                    // The rest of its message's text: a message's items are together, with its other blocks among
                    // them. (An imported thread's tool calls keep the harness's ids, which don't say their message.)
                    if let Some(message) = e.origin.message_id {
                        let mut j = i;
                        while j > from {
                            j -= 1;
                            let other = &self.entries[j];
                            match other.origin.message_id {
                                Some(m) if m == message => {}
                                None if matches!(other.item, Item::ToolCall(_)) => continue,
                                _ => break,
                            }
                            if let Item::AssistantMessage(m) = &other.item {
                                texts.push(&m.text);
                                i = j;
                            }
                        }
                    }
                    texts.reverse();
                    out.push((i, Said::Agent(texts.join("\n"))));
                }
                _ => {}
            }
        }
        out
    }

    /// The last thing the agent said after entry `after` (an index; in all of it if None): its latest
    /// message, or the error a turn ended with after it. None if it said nothing there (in a window:
    /// nothing there, which doesn't say it said nothing before).
    pub fn last_said(&self, after: Option<usize>) -> Option<String> {
        self.said(after.map_or(0, |a| a + 1)).into_iter().find_map(|(_, s)| match s {
            Said::Agent(t) | Said::Failed(t) => Some(t),
            Said::User(_) => None,
        })
    }

    /// The index of the latest user_message (from anyone), if it has one.
    pub fn last_user_message(&self) -> Option<usize> {
        self.entries.iter().rposition(|e| matches!(e.item, Item::UserMessage(_)))
    }

    /// The tool calls in it (subagents' too), in order.
    pub fn tool_calls(&self) -> impl Iterator<Item = &ToolCall> {
        self.entries.iter().filter_map(|e| if let Item::ToolCall(t) = &e.item { Some(t) } else { None })
    }

    /// The latest Agent or Task call with the harness's id `call_id`, if it has one (a forked Skill's isn't).
    pub fn subagent_call(&self, call_id: &str) -> Option<&Entry> {
        self.entries.iter().rev().find(|e| {
            e.call_id() == Some(call_id) && matches!(&e.item, Item::ToolCall(t) if t.kind == ToolKind::Subagent && matches!(t.name.as_str(), "Agent" | "Task"))
        })
    }
}

/// A failed turn's error, as the last thing the agent said: what went wrong. Not when all that's
/// known is how it ended (with no text in Claude's result, the converter gives its subtype, such as
/// `error_during_execution`).
fn turn_error(r: &agent_threads::protocol::TurnResult) -> Option<&str> {
    let e = r.error.as_deref().filter(|_| !r.ok && r.parent_id.is_none())?;
    let t = e.trim();
    let subtype = t == "error" || (t.starts_with("error_") && !t.contains(char::is_whitespace));
    (!t.is_empty() && !subtype).then_some(e)
}

/// The last thing the agent said in `task_id`'s thread: its latest message, or the error its last
/// turn ended with (the API's and MCP tools' `last_message`, and what review and summaries go on
/// when the work is somewhere else).
pub fn last_said(c: &Connection, task_id: &str) -> Result<Option<String>> {
    read_back(c, task_id, Part::Said, |h| h.last_said(None))
}

/// What the agent said after the latest message it was sent (the answer to it, such as a summary
/// it was asked for), trimmed; None if nothing.
pub fn said_since_asked(c: &Connection, task_id: &str) -> Result<Option<String>> {
    let said = read_back(c, task_id, Part::Said, |h| {
        let asked = h.last_user_message();
        match h.last_said(asked) {
            Some(text) => Some(Some(text)),
            // Nothing since it. (A window with no user message: perhaps before the window.)
            None if asked.is_some() => Some(None),
            None => None,
        }
    })?;
    Ok(said.flatten().map(|t| t.trim().to_string()).filter(|t| !t.is_empty()))
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

/// Where a limit cut the user's replies: at an item, which is left out too, or the earliest kept.
struct Cut {
    item: String,
    left_out: bool,
}

impl History {
    /// The user's replies (see `UserReplies`, but for `earlier`), the latest `limit` of them if given,
    /// and where the limit cut them if it did. None if a window doesn't tell.
    fn user_replies(&self, limit: Option<usize>) -> Option<(UserReplies, Option<Cut>)> {
        let mut out = UserReplies::default();
        // Nothing from the user yet (going back), so what the agent says is what it said `since`.
        let mut latest = true;
        // The reply found last (its entry and text), until what the agent said before it is.
        let mut pending: Option<(usize, String)> = None;
        let full = |out: &UserReplies| limit.is_some_and(|n| out.replies.len() >= n);
        let id = |i: usize| self.entries[i].item.id().to_string();
        for (i, said) in self.said(0) {
            match said {
                Said::User(text) => {
                    latest = false;
                    // Nothing from the agent between the two.
                    out.replies.extend(pending.take().map(|(_, p)| (None, p)));
                    if full(&out) {
                        return Some((out.reversed(), Some(Cut { item: id(i), left_out: true })));
                    }
                    pending = Some((i, text));
                }
                Said::Agent(text) if latest => {
                    out.since = Some(text);
                    latest = false;
                }
                Said::Agent(text) => {
                    if let Some((at, p)) = pending.take() {
                        out.replies.push((Some(text), p));
                        if full(&out) {
                            return Some((out.reversed(), Some(Cut { item: id(at), left_out: false })));
                        }
                    }
                }
                Said::Failed(_) => {}
            }
        }
        if !self.whole {
            return None;
        }
        out.replies.extend(pending.map(|(_, p)| (None, p)));
        Some((out.reversed(), None))
    }
}

impl UserReplies {
    fn reversed(mut self) -> Self {
        self.replies.reverse();
        self
    }
}

/// The user's own messages in `task_id`'s thread (`UserReplies`), the latest `limit` of them if given.
/// Read back from the end, so a long thread is only read as far as those.
pub fn user_replies(c: &Connection, task_id: &str, limit: Option<usize>) -> Result<UserReplies> {
    let Some((mut out, cut)) = read_back(c, task_id, Part::Said, |h| h.user_replies(limit))? else { return Ok(UserReplies::default()) };
    // How many it left out, from the user's messages alone.
    if let Some(cut) = cut {
        let users = read(c, task_id, Window::UserMessages)?;
        let at = users.entries.iter().position(|e| e.item.id() == cut.item).map_or(users.entries.len(), |at| at + cut.left_out as usize);
        out.earlier = users.entries[..at].iter().filter(|e| e.users_text().is_some()).count();
    }
    Ok(out)
}

/// The tool calls the agent made in `task_id`'s thread (subagents' included) after `since`, a
/// timestamp (all of them if None), oldest first.
pub fn tool_calls_since(c: &Connection, task_id: &str, since: Option<&str>) -> Result<Vec<ToolCall>> {
    Ok(read(c, task_id, since.map_or(Window::All, Window::Since))?.tool_calls().cloned().collect())
}

/// Whether the user (not the board or another agent) sent `task_id`'s agent a message after `since`.
pub fn user_wrote_since(c: &Connection, task_id: &str, since: &str) -> Result<bool> {
    let h = read(c, task_id, Window::Since(since))?;
    Ok(h.entries.iter().any(|e| matches!(e.item, Item::UserMessage(_)) && !e.origin.auto && !e.origin.from_agent))
}

/// The Agent or Task call (the harness's id for it) that a subagent's lifecycle notification
/// (`event`, a task_* message) in `task_id`'s thread is about: the call it names, or the one Claude's
/// task_started for its `task_id` started. None if the thread has no such call (a forked Skill, a
/// background shell job).
pub fn subagent_call(c: &Connection, task_id: &str, event: &Value) -> Result<Option<String>> {
    let (call, task) = (event["tool_use_id"].as_str(), event["task_id"].as_str());
    if call.is_none() && task.is_none() {
        return Ok(None);
    }
    let found = read_back(c, task_id, Part::Everything, |h| {
        let named = |call: &str| h.subagent_call(call).and_then(Entry::call_id).map(String::from);
        match (call, task.and_then(|t| h.subagent_tasks.get(t))) {
            (Some(call), _) => named(call).map(Some).or_else(|| h.whole.then_some(None)),
            // The call its task_started started (in the window, then): a forked Skill's isn't an Agent call.
            (None, Some(item)) => Some(h.entries.iter().find(|e| e.item.id() == item).and_then(Entry::call_id).and_then(named)),
            (None, None) => h.whole.then_some(None),
        }
    })?;
    Ok(found.flatten())
}

#[cfg(test)]
mod tests;
