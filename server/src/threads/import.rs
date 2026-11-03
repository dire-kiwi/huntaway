//! A thread's stored messages as agent-threads items and saved events (docs/agent-threads-migration.md,
//! "What survives conversion"). It only reads: nothing is launched, answered or written, and the
//! messages stay the source. `convert` takes every message of a task, in id order, and gives:
//!
//! - the thread, and its saved events from seq 1 (a `thread.updated`, then `item.added`,
//!   `item.updated`, `request.opened` and `request.resolved`), which the crate's types parse and its
//!   reducer folds into the snapshot;
//! - for each message, what became of it (`Row`): converted into items or requests, redundant (what
//!   it says is in other items already, like a Bash call's `task_started`), or kept only in the
//!   source, with a warning saying why;
//! - warnings about what the history doesn't say, like calls with no result, which are cancelled.
//!
//! Ids are stable, so converting the same messages again gives the same events: tool calls keep
//! Claude's (or Codex's) ids, other items are `legacy:<message id>` or `legacy:<message id>:<block>`,
//! and requests keep the board's request ids. Turns aren't made up: items have no `turn_id`, and there
//! are no turn events.

use std::collections::{BTreeMap, HashMap, HashSet};

use agent_threads::protocol::{Snapshot, Thread, ThreadEvent};
use agent_threads::reducer;
use serde::Serialize;
use serde_json::{Map, Value, json};

use super::history::Origin;
use super::store::{Db, HuntawayStore};
use crate::db::{Message, Task};

/// Changes when what `convert` makes of the same messages does: imported threads record it.
pub const CONVERTER_VERSION: u32 = 6;

/// Tool results longer than this were cut short when they were stored (runner/output.rs's `slim`).
const STORED_RESULT_MAX: usize = 30_000;

/// What a stored message became.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Disposition {
    /// Items, updates to items, or requests.
    Converted,
    /// Nothing: other items say what it does (a Bash call's task_* messages, a `/compact` run's result).
    Redundant,
    /// Nothing: there's no place for it in the new thread. It stays in the source, with a warning.
    Retained,
}

#[derive(Clone, Debug, Serialize)]
pub struct Row {
    pub message_id: i64,
    pub disposition: Disposition,
    /// The items it made or changed, and the requests it made.
    pub ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Warning {
    pub message_id: Option<i64>,
    pub code: &'static str,
    pub text: String,
}

/// What the board knows about the task, besides its messages.
pub struct Source<'a> {
    pub task: &'a Task,
    /// "claude" or "codex": which runtime the task's next turn would run on.
    pub harness: &'a str,
    pub messages: &'a [Message],
}

#[derive(Debug, Serialize)]
pub struct Conversion {
    pub thread: Thread,
    /// The saved events, seqs from 1.
    pub events: Vec<ThreadEvent>,
    /// What folding the events gives.
    pub snapshot: Snapshot,
    pub rows: Vec<Row>,
    /// What the board knows about each item that the item doesn't say (history::Origin), by its id.
    pub origins: BTreeMap<String, Origin>,
    pub warnings: Vec<Warning>,
    /// The source's fingerprint (its messages' ids, kinds and data): a source edited since shows.
    pub fingerprint: String,
}

impl Conversion {
    pub fn count(&self, d: Disposition) -> usize {
        self.rows.iter().filter(|r| r.disposition == d).count()
    }
}

/// The messages of `source` as an agent-threads thread. Fails only when what it made doesn't parse
/// as the protocol's events, which is a bug in it: what the messages don't say is a warning.
pub fn convert(source: &Source) -> anyhow::Result<Conversion> {
    let task = source.task;
    let mut b = Builder::new(source.messages);
    for m in source.messages {
        b.row(m);
    }
    b.finish();
    let fingerprint = fingerprint(source.messages);
    let mut thread = json!({
        "id": task.id,
        "harness": source.harness,
        "status": "idle",
        "title": task.title,
        "created_at": task.created_at,
        "updated_at": task.updated_at,
        "metadata": {"task_id": task.id, "imported": {"converter": CONVERTER_VERSION, "fingerprint": fingerprint}},
    });
    if let Some(s) = &task.session_id {
        thread["session_id"] = json!(s);
    }
    if let Some(m) = &task.model {
        thread["model"] = json!(m);
    }
    if let Some(mode) = task.permission_mode.as_deref().and_then(permission_mode) {
        thread["permission_mode"] = json!(mode);
    }
    if let Some(cwd) = task.worktree_path.as_ref().or(task.work_dir.as_ref()) {
        thread["cwd"] = json!(cwd);
    }
    if let (Some(last), Some(task_session)) = (&b.last_session, &task.session_id)
        && last != task_session
    {
        b.warn(None, "session_mismatch", format!("the messages' last session is {last}, the task's is {task_session}"));
    }
    let thread: Thread = serde_json::from_value(thread)?;
    let mut events = Vec::with_capacity(b.events.len() + 1);
    let mut raw = vec![json!({"type": "thread.updated", "thread": thread})];
    raw.append(&mut b.events);
    for (i, mut e) in raw.into_iter().enumerate() {
        e["thread_id"] = json!(task.id);
        e["seq"] = json!(i + 1);
        let event: ThreadEvent = serde_json::from_value(e.clone()).map_err(|err| anyhow::anyhow!("event {} doesn't parse ({err}): {e}", i + 1))?;
        events.push(event);
    }
    let mut snapshot = reducer::initial_state(thread.clone());
    for e in &events {
        reducer::apply_event(&mut snapshot, e);
    }
    Ok(Conversion { thread, events, snapshot, rows: b.rows, origins: b.origins, warnings: b.warnings, fingerprint })
}

/// What `stage` did.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Staged {
    /// Wrote the thread (replacing an older import of it).
    Staged,
    /// The same conversion was there already, whole.
    Unchanged,
}

/// Writes `conv` to `store` as its own thread: the thread, its events, its items' origins (those that say
/// more than their message, which an imported item's id says: see history::Origin), then (once the saved events fold into it) its snapshot, which
/// is what says a staged import is whole. Staging the same
/// conversion again changes nothing; an import of an older source or converter is replaced. A thread
/// with the id that wasn't imported is left as it is. It's only staged: nothing reads these threads yet.
pub async fn stage<D: Db>(store: &HuntawayStore<D>, conv: &Conversion) -> anyhow::Result<Staged> {
    use agent_threads::Store;
    let id = conv.thread.id.as_str();
    let events = conv.events.iter().map(serde_json::to_value).collect::<Result<Vec<_>, _>>()?;
    let snapshot = serde_json::to_value(&conv.snapshot)?;
    if let Some(existing) = store.get_thread(id).await? {
        let imported = &existing["metadata"]["imported"];
        if imported.is_null() {
            anyhow::bail!("thread {id} is there already, and wasn't imported");
        }
        if conv.thread.metadata.get("imported") == Some(imported) && store.load_snapshot(id).await?.as_ref() == Some(&snapshot) {
            return Ok(Staged::Unchanged);
        }
        store.delete_thread(id).await?;
    }
    store.create_thread(&serde_json::to_value(&conv.thread)?).await?;
    store.append_events(id, &events, &[]).await?;
    store.save_origins(id, conv.origins.iter().filter(|(_, o)| o.says_more()))?;
    let mut state = reducer::initial_state(conv.thread.clone());
    for e in store.read_events(id, 0, None).await? {
        reducer::apply_event(&mut state, &serde_json::from_value(e)?);
    }
    anyhow::ensure!(serde_json::to_value(&state)? == snapshot, "thread {id}'s saved events don't fold into its snapshot");
    store.save_snapshot(id, &snapshot).await?;
    Ok(Staged::Staged)
}

/// A hash of the messages' ids, kinds and data.
pub fn fingerprint(messages: &[Message]) -> String {
    let mut ctx = aws_lc_rs::digest::Context::new(&aws_lc_rs::digest::SHA256);
    for m in messages {
        for part in [m.id.to_string().as_str(), &m.kind, &m.data.to_string()] {
            ctx.update(&(part.len() as u64).to_le_bytes());
            ctx.update(part.as_bytes());
        }
    }
    ctx.finish().as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

/// The board's permission mode in agent-threads' terms. `auto` (Claude Code's classifier) has none.
fn permission_mode(mode: &str) -> Option<&'static str> {
    Some(match mode {
        "default" => "default",
        "acceptEdits" => "accept_edits",
        "plan" => "plan",
        "dontAsk" => "dont_ask",
        "bypassPermissions" => "bypass",
        _ => return None,
    })
}

/// A tool call so far.
struct Call {
    kind: String,
    status: &'static str,
    subagent: Option<Value>,
    /// The model its input asks for (a subagent's).
    model: Option<String>,
}

/// A tool_use block: the item its call is, and what tells it from others with its id.
#[derive(Clone)]
struct Occurrence {
    item: String,
    /// The subagent call (tool_use id) it was made in.
    parent: Option<String>,
    session: Option<String>,
    input: Value,
}

/// Whether two sessions can be the same one: they are, or one isn't known.
fn same_session(a: Option<&str>, b: Option<&str>) -> bool {
    a.zip(b).is_none_or(|(a, b)| a == b)
}

/// What a claude task_* message's `task_id` is about.
enum Job {
    /// A subagent: its call's item.
    Agent(String),
    /// Something other items show already (a Bash command's run).
    Shown,
}

struct Builder {
    events: Vec<Value>,
    rows: Vec<Row>,
    warnings: Vec<Warning>,
    /// Every item's id, so none is added twice.
    items: HashSet<String>,
    /// The tool calls' items, by id.
    call_items: BTreeMap<String, Call>,
    /// Claude's task ids (task_started) → what they are.
    jobs: HashMap<String, Job>,
    /// The calls (items) whose permission prompt was denied: their error results are denials.
    denied: HashSet<String>,
    /// Every tool_use block with each id, in order: a thread can have several with one id.
    occurrences: HashMap<String, Vec<Occurrence>>,
    /// How many of each id's occurrences the thread has come to.
    seen: HashMap<String, usize>,
    /// The tool_use ids some tool_result names.
    with_results: HashSet<String>,
    /// Results that came before their call, by the call's item: added with it. With the message's id and its
    /// tool_use_result.
    early: HashMap<String, (i64, Value, Value)>,
    /// By parent (None: the main conversation), the latest item if it's a compaction, which a synthetic
    /// summary goes into.
    compaction: HashMap<Option<String>, String>,
    /// The session the messages were last in.
    last_session: Option<String>,
    /// The row being converted.
    current: Option<Row>,
    origins: BTreeMap<String, Origin>,
    /// The text of the main conversation's latest message with some, since the last turn ended or the
    /// user's last message: what a turn's result usually says again.
    last_text: Option<String>,
}

fn str_arg<'a>(v: &'a Value, name: &str) -> Option<&'a str> {
    v.get(name).and_then(Value::as_str).filter(|s| !s.is_empty())
}

impl Builder {
    fn new(messages: &[Message]) -> Self {
        let mut b = Builder {
            events: Vec::new(),
            rows: Vec::with_capacity(messages.len()),
            warnings: Vec::new(),
            items: HashSet::new(),
            call_items: BTreeMap::new(),
            jobs: HashMap::new(),
            denied: HashSet::new(),
            occurrences: HashMap::new(),
            seen: HashMap::new(),
            with_results: HashSet::new(),
            early: HashMap::new(),
            compaction: HashMap::new(),
            last_session: None,
            current: None,
            origins: BTreeMap::new(),
            last_text: None,
        };
        // Prompts and results can be stored before their call: index the calls first. A call keeps its id
        // as its item's, but for the first; one with an id an earlier call has is `legacy:<message>:<block>`.
        for m in messages.iter().filter(|m| m.kind == "claude") {
            let blocks = m.data["message"]["content"].as_array().into_iter().flatten();
            match m.data["type"].as_str() {
                Some("assistant") => {
                    for (i, block) in blocks.enumerate().filter(|(_, x)| x["type"] == "tool_use") {
                        let id = block["id"].as_str().unwrap_or_default();
                        let list = b.occurrences.entry(id.to_string()).or_default();
                        let item = if list.is_empty() && !id.is_empty() { id.to_string() } else { format!("legacy:{}:{i}", m.id) };
                        let parent = str_arg(&m.data, "parent_tool_use_id").map(String::from);
                        let session = str_arg(&m.data, "session_id").map(String::from);
                        list.push(Occurrence { item, parent, session, input: block["input"].clone() });
                    }
                }
                Some("user") => {
                    b.with_results.extend(blocks.filter(|x| x["type"] == "tool_result").filter_map(|x| x["tool_use_id"].as_str()).map(String::from));
                }
                _ => {}
            }
        }
        b
    }

    fn warn(&mut self, message_id: Option<i64>, code: &'static str, text: impl Into<String>) {
        self.warnings.push(Warning { message_id, code, text: text.into() });
    }

    fn touch(&mut self, id: &str) {
        if let Some(r) = self.current.as_mut()
            && !r.ids.iter().any(|x| x == id)
        {
            r.ids.push(id.to_string());
        }
    }

    fn add(&mut self, item: Value) {
        let id = item["id"].as_str().unwrap_or_default().to_string();
        assert!(self.items.insert(id.clone()), "item {id} added twice");
        self.origins.insert(id.clone(), Origin { message_id: self.current.as_ref().map(|r| r.message_id), ..Default::default() });
        let parent = item["parent_id"].as_str().map(String::from);
        if item["type"] == "compaction" {
            self.compaction.insert(parent, id.clone());
        } else {
            self.compaction.remove(&parent);
        }
        self.touch(&id);
        self.events.push(json!({"type": "item.added", "item": item}));
    }

    fn update(&mut self, id: &str, patch: Value) {
        self.touch(id);
        self.events.push(json!({"type": "item.updated", "item_id": id, "patch": patch}));
    }

    fn request(&mut self, request: Value, resolution: Value) {
        let id = request["id"].as_str().unwrap_or_default().to_string();
        self.touch(&id);
        self.events.push(json!({"type": "request.opened", "request": request}));
        self.events.push(json!({"type": "request.resolved", "request_id": id, "resolution": resolution}));
    }

    /// The calls with tool_use id `id` that `keep` keeps (it's told whether the thread has come to each).
    ///
    /// A thread can have several calls with one id (a resumed session, say). Prompts, results and a
    /// subagent's messages are matched to them by what they have in common (parent, session, input),
    /// and where more than one call is left there's no telling: they're linked to none, with a warning.
    fn candidates(&self, id: &str, keep: impl Fn(&Occurrence, bool) -> bool) -> Vec<(Occurrence, bool)> {
        let seen = self.seen.get(id).copied().unwrap_or(0);
        let all = self.occurrences.get(id).map(Vec::as_slice).unwrap_or_default();
        all.iter().enumerate().filter(|(i, o)| keep(o, *i < seen)).map(|(i, o)| (o.clone(), i < seen)).collect()
    }

    /// Whether call `o` can still get a result: it has none, or (before the thread comes to it) none is waiting for it.
    fn waiting(&self, o: &Occurrence, seen: bool) -> bool {
        if seen { self.call_items.get(&o.item).is_some_and(|c| c.status == "running") } else { !self.early.contains_key(&o.item) }
    }

    /// The call a tool_result in message `m` is for: one with its id, in the same subagent and session,
    /// still waiting for its result (or, a result stored before its call, the next such one the thread
    /// hasn't come to).
    fn resulted(&mut self, m: &Message, id: &str) -> Option<(Occurrence, bool)> {
        let (parent, session) = (str_arg(&m.data, "parent_tool_use_id"), str_arg(&m.data, "session_id"));
        let mut found = self.candidates(id, |o, seen| o.parent.as_deref() == parent && same_session(o.session.as_deref(), session) && self.waiting(o, seen));
        if let Some(later) = found.iter().position(|(_, seen)| !seen) {
            found.truncate(later + 1);
        }
        match found.len() {
            1 => return found.pop(),
            0 if self.occurrences.contains_key(id) => {
                self.warn(Some(m.id), "unmatched_result", format!("a result for call {id}, which no call with the id is waiting for"))
            }
            0 => self.warn(Some(m.id), "orphan_result", format!("a result for call {id:?}, which isn't in the thread")),
            n => self.warn(Some(m.id), "ambiguous_call", format!("a result for call {id}, which {n} calls with the id are waiting for")),
        }
        None
    }

    /// The call a prompt for tool_use id `id` (with `input`) is for: the only one with the id, or else, of
    /// those that could still ask (waiting in the current session, or not come to yet: prompts can come
    /// before their call), the one with its input. None, with a warning, if there's no telling.
    fn prompted(&mut self, message_id: i64, id: &str, input: &Value) -> Option<Occurrence> {
        if let [only] = self.occurrences.get(id)?.as_slice() {
            return Some(only.clone());
        }
        let session = self.last_session.clone();
        let mut found = self.candidates(id, |o, seen| !seen || (self.waiting(o, true) && same_session(o.session.as_deref(), session.as_deref())));
        found.retain(|(o, _)| o.input == *input);
        if let [(o, _)] = found.as_slice() {
            return Some(o.clone());
        }
        let text = format!("a prompt for call {id}, which {} calls with the id and its input could have asked", found.len());
        self.warn(Some(message_id), "ambiguous_call", text);
        None
    }

    /// The item of the subagent call that `parent` (a tool_use id) names, for an item's `parent_id`, made
    /// in `session`: the one with the id in the same session the thread has come to, or else (a subagent's
    /// messages can be stored before its call) the one it hasn't. A call that isn't in the thread keeps its
    /// id, with a warning. Err (with a warning) if there's no telling which call it is: the item can't be
    /// put in the main conversation instead.
    fn parent(&mut self, message_id: i64, parent: Option<&str>, session: Option<&str>) -> Result<Option<String>, ()> {
        let Some(parent) = parent else { return Ok(None) };
        if !self.occurrences.contains_key(parent) {
            self.warn(Some(message_id), "missing_parent", format!("its parent call {parent} isn't in the thread"));
            return Ok(Some(parent.to_string()));
        }
        let found = self.candidates(parent, |o, _| same_session(o.session.as_deref(), session));
        let seen: Vec<&Occurrence> = found.iter().filter(|(_, s)| *s).map(|(o, _)| o).collect();
        let pick: Vec<&Occurrence> = if seen.is_empty() { found.iter().map(|(o, _)| o).collect() } else { seen };
        let [o] = pick.as_slice() else {
            let text = format!("its parent call {parent} could be any of {} calls with the id", pick.len());
            self.warn(Some(message_id), "ambiguous_parent", text);
            return Err(());
        };
        let item = o.item.clone();
        if let Some(kind) = self.call_items.get(&item).map(|c| c.kind.clone()).filter(|k| k != "subagent") {
            self.warn(Some(message_id), "parent_not_subagent", format!("its parent {parent} is a {kind} call, not a subagent's"));
        }
        Ok(Some(item))
    }

    /// Message `m`'s parent (see `parent`).
    fn parent_of(&mut self, m: &Message) -> Result<Option<String>, ()> {
        self.parent(m.id, str_arg(&m.data, "parent_tool_use_id"), str_arg(&m.data, "session_id"))
    }

    /// The thread has come to `m`'s calls, which it doesn't convert.
    fn skip_calls(&mut self, m: &Message) {
        for block in m.data["message"]["content"].as_array().into_iter().flatten().filter(|b| b["type"] == "tool_use") {
            *self.seen.entry(block["id"].as_str().unwrap_or_default().to_string()).or_default() += 1;
        }
    }

    fn row(&mut self, m: &Message) {
        self.current = Some(Row { message_id: m.id, disposition: Disposition::Converted, ids: Vec::new() });
        let disposition = match m.kind.as_str() {
            "user" => self.user(m),
            "event" => self.event(m),
            "permission" => self.permission(m),
            "question" => self.question(m),
            "claude" => self.claude(m),
            kind => self.retain(m, "unknown_kind", format!("a message of kind {kind}")),
        };
        let mut row = self.current.take().unwrap();
        row.disposition = disposition;
        self.rows.push(row);
    }

    fn retain(&mut self, m: &Message, code: &'static str, text: String) -> Disposition {
        self.warn(Some(m.id), code, text);
        Disposition::Retained
    }

    fn user(&mut self, m: &Message) -> Disposition {
        self.last_text = None;
        let mut item = json!({"id": format!("legacy:{}", m.id), "type": "user_message", "text": m.data["text"].as_str().unwrap_or_default(), "created_at": m.created_at});
        if m.data["steered"] == true {
            item["steered"] = json!(true);
        }
        self.add(item);
        let o = self.origins.get_mut(&format!("legacy:{}", m.id)).unwrap();
        o.auto = m.data["auto"] == true;
        o.from_agent = m.data["from_agent"] == true;
        o.user_text = m.data["user_text"].as_str().map(String::from);
        Disposition::Converted
    }

    fn event(&mut self, m: &Message) -> Disposition {
        let level = match m.data["level"].as_str() {
            Some("error") => "error",
            Some("warn" | "warning") => "warning",
            Some("info") => "info",
            other => {
                self.warn(Some(m.id), "unknown_level", format!("an event of level {other:?}, shown as info"));
                "info"
            }
        };
        let mut item = json!({"id": format!("legacy:{}", m.id), "type": "notice", "level": level, "text": m.data["text"].as_str().unwrap_or_default(), "created_at": m.created_at});
        if let Some(d) = str_arg(&m.data, "detail") {
            item["detail"] = json!(d);
        }
        self.add(item);
        Disposition::Converted
    }

    /// A prompt's resolution from its stored status. A prompt still pending from a run that has ended
    /// isn't made an approval or a live request: it's cancelled.
    fn resolution(&mut self, m: &Message, request: &str) -> Value {
        let note = str_arg(&m.data, "note");
        let with_note = |outcome: &str| match note {
            Some(n) => json!({"outcome": outcome, "message": n}),
            None => json!({"outcome": outcome}),
        };
        match m.data["status"].as_str() {
            Some("allowed") => with_note("allow"),
            Some("denied") => with_note("deny"),
            Some("expired") => json!({"outcome": "cancel", "message": "Expired: its run ended before it was answered"}),
            Some("pending") => {
                self.warn(Some(m.id), "open_prompt", format!("{request} is still waiting for an answer; imported as cancelled"));
                json!({"outcome": "cancel", "message": "Not answered before the thread was imported"})
            }
            other => {
                self.warn(Some(m.id), "unknown_status", format!("{request} has status {other:?}; imported as cancelled"));
                json!({"outcome": "cancel"})
            }
        }
    }

    fn permission(&mut self, m: &Message) -> Disposition {
        let d = &m.data;
        let id = str_arg(d, "request_id").map_or_else(|| format!("legacy:{}", m.id), String::from);
        let tool = d["tool_name"].as_str().unwrap_or_default();
        let input = d.get("input").cloned().unwrap_or(json!({}));
        let call = str_arg(d, "tool_use_id").map(String::from);
        let mut request = json!({"id": id, "created_at": m.created_at});
        if let Some(c) = &call {
            if !self.occurrences.contains_key(c) {
                // A call the thread doesn't have (an ExitPlanMode Claude Code didn't store, say).
                request["tool_call_id"] = json!(c);
            } else if let Some(o) = self.prompted(m.id, c, &input) {
                request["tool_call_id"] = json!(o.item);
                if let Ok(Some(p)) = self.parent(m.id, o.parent.as_deref(), o.session.as_deref()) {
                    request["parent_id"] = json!(p);
                }
                if d["status"] == "denied" {
                    self.denied.insert(o.item);
                }
            }
        }
        let mut resolution = self.resolution(m, "a prompt");
        match tool {
            crate::mcp::permissions::EXIT_PLAN => {
                request["type"] = json!("plan");
                request["plan"] = json!(input["plan"].as_str().unwrap_or_default());
            }
            crate::mcp::permissions::ASK_USER | crate::mcp::permissions::CODEX_QUESTIONS => {
                let questions: Vec<Value> = input["questions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .enumerate()
                    .map(|(i, q)| question(q, str_arg(q, "id").map_or_else(|| i.to_string(), String::from)))
                    .collect();
                if questions.is_empty() {
                    return self.retain(m, "empty_question", "a question prompt with no questions".into());
                }
                if resolution["outcome"] == "allow" {
                    let answers = answers(&d["answers"], &questions);
                    if answers.is_none() {
                        self.warn(Some(m.id), "missing_answers", "an answered question prompt whose answers can't be read");
                    }
                    resolution = json!({"outcome": "answer", "answers": answers.unwrap_or_default()});
                } else if resolution["outcome"] == "deny" {
                    resolution["outcome"] = json!("cancel");
                }
                request["type"] = json!("question");
                request["questions"] = json!(questions);
            }
            _ => {
                let fields = tool_fields(tool, &input);
                request["type"] = json!("permission");
                // The board's own approvals (a project change, deleting a task, an automation) are for its tools.
                let kind = if d["kind"].as_str().is_some_and(|k| k != "tool") { "app" } else { fields["kind"].as_str().unwrap_or("other") };
                request["kind"] = json!(kind);
                request["name"] = fields["name"].clone();
                request["input"] = input;
                if let Some(s) = fields.get("server").filter(|_| kind == "mcp") {
                    request["server"] = s.clone();
                }
                request["title"] = json!(title(&fields));
            }
        }
        self.request(request, resolution);
        Disposition::Converted
    }

    /// A question asked with the board's request_user_input.
    fn question(&mut self, m: &Message) -> Disposition {
        let d = &m.data;
        let id = format!("legacy:{}", m.id);
        let q = question(d, "q".into());
        let resolution = match d["status"].as_str() {
            Some("answered") => {
                let mut answer: Vec<Value> = d["answer"]["choices"].as_array().cloned().unwrap_or_default();
                if let Some(t) = str_arg(&d["answer"], "text") {
                    answer.push(json!(t));
                }
                json!({"outcome": "answer", "answers": {"q": answer}})
            }
            Some("replied") => json!({"outcome": "cancel", "message": "Answered with a message instead"}),
            _ => self.resolution(m, "a question"),
        };
        self.request(json!({"id": id, "type": "question", "questions": [q], "created_at": m.created_at}), resolution);
        Disposition::Converted
    }

    fn claude(&mut self, m: &Message) -> Disposition {
        let d = &m.data;
        if let Some(s) = str_arg(d, "session_id") {
            self.last_session = Some(s.to_string());
        }
        match (d["type"].as_str(), d["subtype"].as_str()) {
            (Some("assistant"), _) => self.assistant(m),
            (Some("user"), _) => self.claude_user(m),
            (Some("system"), Some("compact_boundary")) => {
                let meta = &d["compact_metadata"];
                let mut item = json!({"id": format!("legacy:{}", m.id), "type": "compaction", "created_at": m.created_at});
                // A subagent's own conversation compacted (Codex's children).
                match self.parent_of(m) {
                    Ok(Some(p)) => item["parent_id"] = json!(p),
                    Ok(None) => {}
                    Err(()) => return Disposition::Retained,
                }
                if let Some(t) = meta["trigger"].as_str().filter(|t| matches!(*t, "auto" | "manual")) {
                    item["trigger"] = json!(t);
                }
                if let Some(n) = meta["pre_tokens"].as_u64() {
                    item["tokens_before"] = json!(n);
                }
                self.add(item);
                Disposition::Converted
            }
            (Some("system"), Some(sub)) if sub.starts_with("task_") => self.job(m, sub),
            (Some("result"), _) => self.result(m),
            (t, sub) => self.retain(m, "unknown_claude", format!("a Claude message of type {t:?}, subtype {sub:?}")),
        }
    }

    fn assistant(&mut self, m: &Message) -> Disposition {
        let d = &m.data;
        let Ok(parent) = self.parent_of(m) else {
            self.skip_calls(m);
            return Disposition::Retained;
        };
        let with_parent = |mut item: Value| {
            if let Some(p) = &parent {
                item["parent_id"] = json!(p);
            }
            item
        };
        let blocks = d["message"]["content"].as_array().cloned().unwrap_or_default();
        // An API error (a usage limit, say) Claude Code shows as the assistant's text.
        if d["is_api_error_message"] == true {
            let text: Vec<&str> = blocks.iter().filter_map(|b| b["text"].as_str()).collect();
            let mut item = json!({"id": format!("legacy:{}", m.id), "type": "notice", "level": "error", "text": text.join("\n"), "created_at": m.created_at});
            if let Some(e) = str_arg(d, "api_error").or_else(|| str_arg(d, "error")) {
                item["code"] = json!(e);
            }
            self.add(with_parent(item));
            return Disposition::Converted;
        }
        let mut any = false;
        let mut texts: Vec<&str> = Vec::new();
        for (i, block) in blocks.iter().enumerate() {
            let key = format!("legacy:{}:{i}", m.id);
            match block["type"].as_str() {
                Some("text") => {
                    let Some(text) = block["text"].as_str().filter(|t| !t.trim().is_empty()) else { continue };
                    self.add(with_parent(json!({"id": key, "type": "assistant_message", "text": text, "created_at": m.created_at})));
                    texts.push(text);
                    any = true;
                }
                Some("thinking") => {
                    let Some(text) = block["thinking"].as_str().filter(|t| !t.trim().is_empty()) else { continue };
                    self.add(with_parent(json!({"id": key, "type": "reasoning", "text": text, "created_at": m.created_at})));
                    any = true;
                }
                Some("redacted_thinking") => {}
                Some("tool_use") => {
                    let call_id = block["id"].as_str().unwrap_or_default();
                    let n = self.seen.entry(call_id.to_string()).or_default();
                    let occurrence = self.occurrences[call_id][*n].clone();
                    let id = occurrence.item;
                    *n += 1;
                    if id != call_id {
                        self.warn(Some(m.id), "duplicate_call", format!("tool call {call_id:?} is there twice; this one is {key}"));
                    }
                    let name = block["name"].as_str().unwrap_or_default();
                    let mut item = Value::Object(tool_fields(name, &block["input"]));
                    let kind = item["kind"].as_str().unwrap_or("other").to_string();
                    item["id"] = json!(id);
                    item["type"] = json!("tool_call");
                    item["status"] = json!("running");
                    item["created_at"] = json!(m.created_at);
                    self.add(with_parent(item));
                    if id != call_id {
                        self.origins.get_mut(&id).unwrap().call_id = Some(call_id.to_string());
                    }
                    let model = str_arg(&block["input"], "model").map(String::from);
                    self.call_items.insert(id.clone(), Call { kind, status: "running", subagent: None, model });
                    if let Some((at, result, meta)) = self.early.remove(&id) {
                        self.tool_result(at, &id, &result, &meta);
                    }
                    any = true;
                }
                other => self.warn(Some(m.id), "unknown_block", format!("an assistant block of type {other:?}")),
            }
        }
        if parent.is_none() && !texts.is_empty() {
            self.last_text = Some(texts.join("\n"));
        }
        if any { Disposition::Converted } else { Disposition::Redundant }
    }

    fn claude_user(&mut self, m: &Message) -> Disposition {
        let d = &m.data;
        let content = &d["message"]["content"];
        if let Some(text) = content.as_str() {
            // The summary a compacted conversation goes on from: the latest compaction of the same conversation.
            let Ok(parent) = self.parent_of(m) else { return Disposition::Retained };
            if d["isSynthetic"] == true
                && let Some(id) = self.compaction.get(&parent).cloned()
            {
                self.update(&id, json!({"summary": text}));
                return Disposition::Converted;
            }
            return self.retain(m, "unplaced_text", "user text from Claude Code that isn't a compaction's summary".into());
        }
        let (mut any, warned) = (false, self.warnings.len());
        for block in content.as_array().into_iter().flatten() {
            match block["type"].as_str() {
                Some("tool_result") => {
                    let call = block["tool_use_id"].as_str().unwrap_or_default();
                    match self.resulted(m, call) {
                        Some((o, true)) => self.tool_result(m.id, &o.item, block, &d["tool_use_result"]),
                        // Stored before its call: given to it when it comes.
                        Some((o, false)) => {
                            self.early.insert(o.item, (m.id, block.clone(), d["tool_use_result"].clone()));
                        }
                        None => continue,
                    }
                    any = true;
                }
                // What Claude Code adds for the model after an image, say.
                Some("text") if d["isSynthetic"] == true => {}
                // A subagent's prompt, which its call's input has.
                Some("text")
                    if str_arg(d, "parent_tool_use_id").is_some_and(|p| self.occurrences.contains_key(p))
                        && !block["text"].as_str().is_some_and(|t| t.starts_with("[Request interrupted")) => {}
                Some("text") => {
                    let text = block["text"].as_str().unwrap_or_default();
                    if text.starts_with("[Request interrupted") {
                        let mut item = json!({"id": format!("legacy:{}", m.id), "type": "notice", "level": "info", "code": "interrupted", "text": text, "created_at": m.created_at});
                        match self.parent_of(m) {
                            Ok(p) => {
                                if let Some(p) = p {
                                    item["parent_id"] = json!(p);
                                }
                                self.add(item);
                                any = true;
                            }
                            Err(()) => {}
                        }
                    } else {
                        self.warn(Some(m.id), "unplaced_text", "user text from Claude Code that isn't a tool's result");
                    }
                }
                other => self.warn(Some(m.id), "unknown_block", format!("a user block of type {other:?}")),
            }
        }
        if any {
            Disposition::Converted
        } else if self.warnings.len() > warned {
            Disposition::Retained
        } else {
            Disposition::Redundant
        }
    }

    /// A tool_result block for call `id`, an item the thread has (`meta`: the message's tool_use_result).
    fn tool_result(&mut self, message_id: i64, id: &str, block: &Value, meta: &Value) {
        let call = block["tool_use_id"].as_str().unwrap_or_default();
        let id = id.to_string();
        let text = result_text(&block["content"]);
        let is_error = block["is_error"] == true;
        let status = match is_error {
            true if self.denied.contains(&id) => "denied",
            true => "failed",
            false => "completed",
        };
        let mut result = json!({"content": text});
        // Cut short when it was stored (runner/output.rs's slim and util::truncate).
        if text.len() > STORED_RESULT_MAX && text.contains("\n… [truncated ") {
            result["truncated"] = json!(true);
        }
        let mut patch = json!({"status": status, "result": result});
        let c = self.call_items.get_mut(&id).unwrap();
        if c.status != "running" {
            self.warn(Some(message_id), "second_result", format!("call {call} has a result already; this one replaces it"));
        }
        let c = self.call_items.get_mut(&id).unwrap();
        c.status = status;
        if c.kind == "subagent" {
            let interrupted = text.starts_with("[Request interrupted");
            if let Some(s) = subagent_result(c.subagent.as_ref(), is_error, interrupted, meta, &text) {
                patch["subagent"] = s.clone();
                c.subagent = Some(s);
            }
        }
        self.update(&id, patch);
    }

    /// A task_* system message: how a subagent (or a Bash command's run) is getting on. Claude Code's
    /// say which task by `task_id` (and started ones which call, by `tool_use_id`); the ones the board
    /// writes for Codex's subagents (agent/codex/output.rs) have no `task_type`, and say which call by
    /// `tool_use_id` alone.
    fn job(&mut self, m: &Message, subtype: &str) -> Disposition {
        let d = &m.data;
        let task = d["task_id"].as_str().unwrap_or_default().to_string();
        let call = d["tool_use_id"].as_str().unwrap_or_default().to_string();
        // The call it's about: one with the id the thread has come to, in the same session.
        let session = str_arg(d, "session_id");
        let calls: Vec<String> = self
            .candidates(&call, |o, seen| seen && same_session(o.session.as_deref(), session) && self.call_items.contains_key(&o.item))
            .into_iter()
            .map(|(o, _)| o.item)
            .collect();
        if subtype == "task_started" {
            match d["task_type"].as_str() {
                None | Some("local_agent") => {
                    let id = match calls.as_slice() {
                        [id] => id.clone(),
                        [] => {
                            self.jobs.insert(task, Job::Shown);
                            return self.retain(m, "missing_parent", format!("a subagent started by call {call:?}, which isn't in the thread"));
                        }
                        many => {
                            self.jobs.insert(task, Job::Shown);
                            return self.retain(m, "ambiguous_call", format!("a subagent started by call {call}, which {} calls have as their id", many.len()));
                        }
                    };
                    let c = self.call_items.get_mut(&id).unwrap();
                    // Started again (Codex says so when a child's details come late): how it's getting on stays.
                    let mut s = subagent_started(c.subagent.as_ref(), d, c.model.as_deref());
                    if let Some(was) = &c.subagent {
                        s["status"] = was["status"].clone();
                    }
                    c.subagent = Some(s.clone());
                    let mut patch = json!({"subagent": s});
                    // A Skill forked into an agent has no Agent call: its call becomes the subagent's.
                    if c.kind != "subagent" {
                        c.kind = "subagent".into();
                        patch["kind"] = json!("subagent");
                    }
                    // A background subagent's call is done once it has started it. Claude Code says so with a
                    // result; the board's Codex children have none.
                    if s["background"] == true && c.status == "running" && !self.with_results.contains(&call) {
                        c.status = "completed";
                        patch["status"] = json!("completed");
                    }
                    if !task.is_empty() {
                        self.origins.get_mut(&id).unwrap().subagent_task = Some(task.clone());
                        self.jobs.insert(task, Job::Agent(id.clone()));
                    }
                    self.update(&id, patch);
                    return Disposition::Converted;
                }
                Some("local_bash") => {
                    self.jobs.insert(task, Job::Shown);
                    return Disposition::Redundant;
                }
                other => {
                    self.jobs.insert(task, Job::Shown);
                    return self.retain(m, "unknown_task_type", format!("a background task of type {other:?}"));
                }
            }
        }
        let by_call = || {
            let [item] = calls.as_slice() else { return None };
            self.call_items[item].subagent.is_some().then(|| Job::Agent(item.clone()))
        };
        let job = match self.jobs.get(&task) {
            Some(Job::Agent(id)) => Some(Job::Agent(id.clone())),
            Some(Job::Shown) => Some(Job::Shown),
            None => by_call(),
        };
        match job {
            Some(Job::Agent(id)) => {
                let c = self.call_items.get_mut(&id).unwrap();
                let Some(s) = c.subagent.as_ref() else { return Disposition::Redundant };
                let next = subagent_task(s, d);
                if &next == s {
                    return Disposition::Redundant;
                }
                c.subagent = Some(next.clone());
                self.update(&id, json!({"subagent": next}));
                Disposition::Converted
            }
            Some(Job::Shown) => Disposition::Redundant,
            None => self.retain(m, "unknown_task", format!("a {subtype} for a background task that never started ({task:?})")),
        }
    }

    fn result(&mut self, m: &Message) -> Disposition {
        let d = &m.data;
        let ok = d["subtype"] == "success" && d["is_error"] != true;
        // A `/compact` run's turn is just its compaction.
        if ok && d["num_turns"] == 0 && self.compaction.contains_key(&None) {
            return Disposition::Redundant;
        }
        // What the turn ended by saying, if no message of its said it (Claude Code gives the result of a turn
        // that a background subagent's report started that way, say).
        let said = std::mem::take(&mut self.last_text);
        if let Some(text) = str_arg(d, "result").filter(|t| ok && !t.trim().is_empty() && said.as_deref().map(str::trim) != Some(t.trim())) {
            self.add(json!({"id": format!("legacy:{}:result", m.id), "type": "assistant_message", "text": text, "created_at": m.created_at}));
        }
        let mut item = json!({"id": format!("legacy:{}", m.id), "type": "turn_result", "ok": ok, "created_at": m.created_at});
        if d["interrupted"] == true {
            item["interrupted"] = json!(true);
        }
        if !ok {
            let error = str_arg(d, "result").or_else(|| str_arg(d, "subtype")).unwrap_or("error");
            item["error"] = json!(error);
        }
        if let Some(ms) = d["duration_ms"].as_u64() {
            item["duration_ms"] = json!(ms);
        }
        self.add(item);
        Disposition::Converted
    }

    /// The thread has ended: calls still waiting for a result never got one.
    fn finish(&mut self) {
        let open: Vec<(String, Option<Value>, bool)> = self
            .call_items
            .iter()
            .filter(|(_, c)| c.status == "running" || c.subagent.as_ref().is_some_and(|s| s["status"] == "running"))
            .map(|(id, c)| (id.clone(), c.subagent.clone(), c.status == "running"))
            .collect();
        let (mut calls, mut agents) = (0, 0);
        for (id, subagent, running) in open {
            let mut patch = Map::new();
            if running {
                patch.insert("status".into(), json!("cancelled"));
                calls += 1;
            }
            if let Some(mut s) = subagent.filter(|s| s["status"] == "running") {
                s["status"] = json!("stopped");
                patch.insert("subagent".into(), s);
                agents += 1;
            }
            self.events.push(json!({"type": "item.updated", "item_id": id, "patch": patch}));
        }
        if calls > 0 {
            self.warn(None, "no_result", format!("{calls} tool calls have no result; imported as cancelled"));
        }
        if agents > 0 {
            self.warn(None, "subagent_running", format!("{agents} subagents never said they ended; imported as stopped"));
        }
        let early: Vec<i64> = self.early.values().map(|(id, _, _)| *id).collect();
        for id in early {
            self.warn(Some(id), "orphan_result", "a result whose call never came");
        }
    }
}

/// The answers stored on an answered question prompt, by the converted questions' ids. The board keeps
/// them as a list of answers for each question, in order (permissions.rs's `shown_answers`: a secret's
/// are "(hidden)"); a map of each question's text (or id) to its answers is read too. None if they're
/// neither.
fn answers(stored: &Value, questions: &[Value]) -> Option<Map<String, Value>> {
    let strings = |v: &Value| -> Option<Vec<Value>> {
        match v {
            Value::String(s) => Some(vec![json!(s)]),
            Value::Array(a) => a.iter().map(|x| x.as_str().map(|s| json!(s))).collect(),
            // Codex's answers by id, as its tool takes them.
            Value::Object(o) => o.get("answers").and_then(|a| a.as_array()).and_then(|a| a.iter().map(|x| x.as_str().map(|s| json!(s))).collect()),
            _ => None,
        }
    };
    let id = |q: &Value| q["id"].as_str().unwrap_or_default().to_string();
    let mut out = Map::new();
    match stored {
        Value::Array(lists) => {
            for (q, list) in questions.iter().zip(lists) {
                let list = strings(list)?;
                if !list.is_empty() {
                    out.insert(id(q), Value::Array(list));
                }
            }
        }
        Value::Object(map) => {
            for q in questions {
                let found = q["question"].as_str().and_then(|t| map.get(t)).or_else(|| map.get(&id(q)));
                if let Some(list) = found.map(strings) {
                    out.insert(id(q), Value::Array(list?));
                }
            }
        }
        _ => return None,
    }
    Some(out)
}

/// A protocol Question from an AskUserQuestion question, or a request_user_input card.
fn question(q: &Value, id: String) -> Value {
    let mut out = json!({"id": id, "question": q["question"].as_str().unwrap_or_default()});
    if let Some(h) = str_arg(q, "header") {
        out["header"] = json!(h);
    }
    let options: Vec<Value> = q["options"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|o| {
            let label = o.as_str().or_else(|| o["label"].as_str())?;
            let mut option = json!({"label": label});
            if let Some(d) = str_arg(o, "description") {
                option["description"] = json!(d);
            }
            Some(option)
        })
        .collect();
    if !options.is_empty() {
        out["options"] = json!(options);
    }
    if q["multi_select"] == true || q["multiSelect"] == true {
        out["multi_select"] = json!(true);
    }
    if q["allow_other"] == true || q["isOther"] == true {
        out["allow_other"] = json!(true);
    }
    if q["isSecret"] == true || q["secret"] == true {
        out["secret"] = json!(true);
    }
    out
}

/// A tool result's content as text: text blocks joined by newlines (images were stored as [image]).
fn result_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| match b["type"].as_str() {
                Some("text") => Some(b["text"].as_str().unwrap_or_default().to_string()),
                Some("image") => Some("[image]".into()),
                Some("tool_reference") => b["tool_name"].as_str().map(String::from),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Null => String::new(),
        v => v.to_string(),
    }
}

/// What a tool does, by its name, as agent-threads' Claude driver says it.
fn kind_of(name: &str) -> &'static str {
    match name {
        "Bash" | "BashOutput" => "shell",
        "Read" | "NotebookRead" => "read",
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" | "ApplyPatch" => "edit",
        "Glob" | "Grep" => "search",
        "WebFetch" | "WebSearch" => "web",
        "Task" | "Agent" => "subagent",
        "TodoWrite" => "todo",
        _ => "other",
    }
}

/// A tool_call's fields (name, kind, input and what its kind has) for a stored tool_use: the same as
/// agent-threads' Claude driver makes, and Codex's file changes (stored as ApplyPatch) as edits.
fn tool_fields(name: &str, input: &Value) -> Map<String, Value> {
    let input = if input.is_null() { json!({}) } else { input.clone() };
    let mut t = Map::new();
    let (mut tool, mut kind, mut server) = (name.to_string(), kind_of(name), None);
    if let Some(rest) = name.strip_prefix("mcp__") {
        let mut parts = rest.splitn(2, "__");
        server = parts.next().filter(|s| !s.is_empty()).map(String::from);
        tool = parts.next().unwrap_or_default().to_string();
        kind = "mcp";
    }
    t.insert("name".into(), json!(tool));
    t.insert("kind".into(), json!(kind));
    if let Some(s) = server {
        t.insert("server".into(), json!(s));
    }
    let mut set = |k: &str, v: Option<&str>| {
        if let Some(v) = v {
            t.insert(k.into(), json!(v));
        }
    };
    match kind {
        "shell" => set("command", input["command"].as_str()),
        "read" => set("path", str_arg(&input, "file_path")),
        "search" => {
            set("query", str_arg(&input, "pattern"));
            set("path", str_arg(&input, "path"));
        }
        "web" => {
            set("url", str_arg(&input, "url"));
            set("query", str_arg(&input, "query"));
        }
        "subagent" => set("title", str_arg(&input, "description")),
        _ => {}
    }
    match kind {
        "edit" if name == "ApplyPatch" => {
            let changes: Vec<Value> = input["changes"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|c| {
                    let op = match c["kind"].as_str() {
                        Some("add") => "add",
                        Some("delete") => "delete",
                        _ => "update",
                    };
                    let mut change = json!({"path": str_arg(c, "path")?, "op": op});
                    if let Some(d) = str_arg(c, "diff") {
                        change["diff"] = json!(d);
                    }
                    if let Some(p) = str_arg(c, "move_path") {
                        change["move_to"] = json!(p);
                    }
                    Some(change)
                })
                .collect();
            t.insert("changes".into(), json!(changes));
        }
        "edit" => {
            if let Some(p) = str_arg(&input, "file_path").or_else(|| str_arg(&input, "notebook_path")) {
                t.insert("changes".into(), json!([{"path": p, "op": "update"}]));
            }
        }
        "todo" => {
            let todos: Vec<Value> = input["todos"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|x| {
                    let text = match &x["content"] {
                        Value::String(s) => s.clone(),
                        Value::Null => String::new(),
                        v => v.to_string(),
                    };
                    let status = x["status"].as_str().filter(|s| matches!(*s, "in_progress" | "completed")).unwrap_or("pending");
                    json!({"text": text, "status": status})
                })
                .collect();
            t.insert("todos".into(), json!(todos));
        }
        _ => {}
    }
    t.insert("input".into(), input);
    t
}

/// A permission's title: what it's about, in a few words.
fn title(t: &Map<String, Value>) -> String {
    let s = |k: &str| t.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from);
    if let Some(c) = s("command").or_else(|| s("path")) {
        return c;
    }
    if let Some(changes) = t.get("changes").and_then(Value::as_array).filter(|c| !c.is_empty()) {
        return changes.iter().filter_map(|c| c["path"].as_str()).collect::<Vec<_>>().join(", ");
    }
    s("name").unwrap_or_default()
}

/// How Claude says a subagent ended, as a SubagentStatus; none if what it says isn't an end.
fn subagent_end(status: &Value) -> Option<&'static str> {
    match status.as_str()? {
        "completed" | "success" => Some("completed"),
        "failed" | "error" => Some("failed"),
        "killed" | "stopped" | "cancelled" | "interrupted" => Some("stopped"),
        _ => None,
    }
}

/// A subagent call's subagent, as a task_started (of a local_agent) says it has started.
fn subagent_started(s: Option<&Value>, m: &Value, model: Option<&str>) -> Value {
    let mut s = s.cloned().unwrap_or_else(|| json!({"status": "running"}));
    s["status"] = json!("running");
    if m["is_backgrounded"] == true {
        s["background"] = json!(true);
    }
    if let Some(t) = str_arg(m, "subagent_type") {
        s["agent_type"] = json!(t);
    }
    if let Some(model) = str_arg(m, "model").or(model) {
        s["model"] = json!(model);
    }
    s
}

/// A subagent after a task_progress, task_updated or task_notification about it.
fn subagent_task(s: &Value, m: &Value) -> Value {
    let mut next = s.clone();
    let running = s["status"] == "running";
    match m["subtype"].as_str() {
        Some("task_progress") => {
            if let Some(d) = str_arg(m, "description") {
                next["activity"] = json!(d);
            }
            if let Some(n) = m["usage"]["tool_uses"].as_u64() {
                next["tool_uses"] = json!(n);
            }
        }
        Some("task_updated") => {
            // Continued (with SendMessage) after it ended, it runs again.
            if m["patch"]["status"] == "running" {
                next["status"] = json!("running");
                next.as_object_mut().unwrap().remove("summary");
            } else if let Some(end) = subagent_end(&m["patch"]["status"]).filter(|_| running) {
                next["status"] = json!(end);
            }
        }
        Some("task_notification") => {
            if let Some(end) = subagent_end(&m["status"]).filter(|_| running) {
                next["status"] = json!(end);
            }
            if let Some(n) = m["usage"]["tool_uses"].as_u64() {
                next["tool_uses"] = json!(n);
            }
            // A foreground subagent's report is its call's result.
            if s["background"] == true
                && let Some(summary) = str_arg(m, "summary")
            {
                next["summary"] = json!(summary);
            }
        }
        _ => {}
    }
    next
}

/// A subagent call's subagent, as its result says (`meta`: the result's tool_use_result, which the
/// board keeps for Agent calls); none for a call whose subagent never started.
fn subagent_result(s: Option<&Value>, is_error: bool, interrupted: bool, meta: &Value, text: &str) -> Option<Value> {
    if s.is_none() && is_error {
        return None;
    }
    let mut s = s.cloned().unwrap_or_else(|| json!({"status": "running"}));
    if let Some(m) = str_arg(meta, "resolvedModel") {
        s["model"] = json!(m);
    }
    if let Some(t) = str_arg(meta, "agentType") {
        s["agent_type"] = json!(t);
    }
    if let Some(n) = meta["totalToolUseCount"].as_u64() {
        s["tool_uses"] = json!(n);
    }
    // A background subagent's call returns as soon as it has started it.
    if meta["isAsync"] == true || meta["status"] == "async_launched" || text.trim_start().starts_with("Async agent launched") {
        s["background"] = json!(true);
    } else if s["status"] == "running" {
        s["status"] = json!(match (is_error, interrupted) {
            (true, true) => "stopped",
            (true, false) => "failed",
            _ => subagent_end(&meta["status"]).unwrap_or("completed"),
        });
    }
    Some(s)
}

#[cfg(test)]
mod tests;
