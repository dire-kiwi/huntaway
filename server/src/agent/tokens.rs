//! The tokens each run used, per model, for statistics (`GET /profiles/{id}/token-stats`, see
//! analytics.rs), in `token_usage` (see db::SCHEMA_V79).
//!
//! They're counted from the run's output (`runs/<id>/out.jsonl`) once it has ended, rather than as
//! it streams in, so runs from before this was kept are counted the same way while their folders
//! are kept (see runs::KEEP_DAYS): at startup, and before each prune (see runs::start_pruner).
//!
//! - Claude Code's `result` at the end of each turn has `modelUsage`: the session's totals for each
//!   model so far, its subagents' included. Like its `total_cost_usd` (see db::add_cost), they go
//!   on over the runs that resume the session, so a run used what they went up by: from its task's
//!   latest earlier run in the session (`usage_session`, `usage_snapshot`), or from nothing in a
//!   new session or one whose totals went down (Claude Code started counting again). A run's cost
//!   is also what the board charged it: one counted from nothing because its earlier runs' output
//!   was gone is scaled down to that, and estimated. Requests after a run's last `result` are
//!   counted from their own messages (see `count_claude`).
//! - Codex's `thread/tokenUsage/updated` has each thread's totals (subagents' threads are their
//!   own) and its latest request's (`last`). Threads keep their totals when they're resumed, so a
//!   run used what they went up by too. A thread whose earlier totals aren't known, or that went
//!   down (rolled back), adds just its latest request. Codex counts cached input as part of the
//!   input: here `input_tokens` is what wasn't cached, as for Claude. The model is the one the
//!   adapter says it started the thread with (`huntaway/model`), else the run's, else the one the
//!   thread's rollout file says, else the task's; a subagent's thread's is the one it was spawned
//!   with, when that's in the run's output.
//! - A run whose folder is gone gets a row with what it cost and no tokens, `estimated`.

use std::collections::BTreeMap;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::Result;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agent::runs::run_dir;
use crate::db;
use crate::state::Shared;
use crate::util::{expand_tilde, now};

/// Held while counting, so two runs ending together don't count one run twice or out of order.
static COUNTING: Mutex<()> = Mutex::new(());

/// What a model used, as totals or as what they went up by.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq)]
pub struct Counts {
    #[serde(default)]
    pub input: i64,
    #[serde(default)]
    pub output: i64,
    #[serde(default)]
    pub cache_read: i64,
    #[serde(default)]
    pub cache_write: i64,
    #[serde(default)]
    pub reasoning: i64,
    #[serde(default)]
    pub cost: f64,
}

impl Counts {
    fn total(&self) -> i64 {
        self.input + self.output + self.cache_read + self.cache_write
    }

    /// The tokens fed in, which a Claude Code request's message has in full (its output count can be short).
    fn fed(&self) -> i64 {
        self.input + self.cache_read + self.cache_write
    }

    /// Whether every count is at least `o`'s: the same totals, gone on from there.
    fn covers(&self, o: &Counts) -> bool {
        self.input >= o.input && self.output >= o.output && self.cache_read >= o.cache_read && self.cache_write >= o.cache_write
    }

    fn minus(&self, o: &Counts) -> Counts {
        Counts {
            input: self.input - o.input,
            output: self.output - o.output,
            cache_read: self.cache_read - o.cache_read,
            cache_write: self.cache_write - o.cache_write,
            reasoning: (self.reasoning - o.reasoning).max(0),
            cost: (self.cost - o.cost).max(0.0),
        }
    }

    fn add(&mut self, o: &Counts) {
        self.input += o.input;
        self.output += o.output;
        self.cache_read += o.cache_read;
        self.cache_write += o.cache_write;
        self.reasoning += o.reasoning;
        self.cost += o.cost;
    }

    fn scale(&mut self, f: f64) {
        let s = |n: &mut i64| *n = (*n as f64 * f).round() as i64;
        s(&mut self.input);
        s(&mut self.output);
        s(&mut self.cache_read);
        s(&mut self.cache_write);
        s(&mut self.reasoning);
        self.cost *= f;
    }

    /// One model's part of a Claude Code `modelUsage`.
    pub(crate) fn from_claude(m: &Value) -> Counts {
        let n = |k: &str| m[k].as_i64().unwrap_or(0);
        Counts {
            input: n("inputTokens"),
            output: n("outputTokens"),
            cache_read: n("cacheReadInputTokens"),
            cache_write: n("cacheCreationInputTokens"),
            reasoning: n("thinkingTokens"),
            cost: m["costUSD"].as_f64().unwrap_or(0.0),
        }
    }

    /// A Codex `tokenUsage`'s `total` or `last`.
    pub(crate) fn from_codex(u: &Value) -> Counts {
        let n = |k: &str| u[k].as_i64().unwrap_or(0);
        Counts {
            input: (n("inputTokens") - n("cachedInputTokens")).max(0),
            output: n("outputTokens"),
            cache_read: n("cachedInputTokens"),
            cache_write: n("cacheWriteInputTokens"),
            reasoning: n("reasoningOutputTokens"),
            cost: 0.0,
        }
    }
}

/// What a run used, by model, and the totals its agent's session (`session`) or threads had reached.
#[derive(Debug, Default, PartialEq)]
pub struct Counted {
    pub runtime: &'static str,
    pub models: BTreeMap<String, Counts>,
    pub session: Option<String>,
    pub snapshot: BTreeMap<String, Counts>,
    /// The part of `snapshot` a Claude Code run's requests after its last `result` add, counted
    /// from their own usage (see `count_claude`).
    pub tail: BTreeMap<String, Counts>,
    /// Some of it is a guess (see the module's docs).
    pub estimated: bool,
}

/// The totals a run's agent started from: its task's latest earlier counted run's for session (or
/// thread) `key`, and the part of them that run's requests after its last `result` add.
type Earlier<'a> = dyn FnMut(&str) -> Option<Before> + 'a;

#[derive(Debug, Default, Clone)]
pub struct Before {
    pub totals: BTreeMap<String, Counts>,
    pub tail: BTreeMap<String, Counts>,
}

/// One Claude Code request's usage, from an `assistant` message (`v`), and its model and id.
fn request_usage(v: &Value) -> Option<(String, String, Counts)> {
    let m = &v["message"];
    let model = m["model"].as_str().filter(|m| !m.starts_with('<'))?;
    let id = m["id"].as_str()?;
    let u = &m["usage"];
    let n = |k: &str| u[k].as_i64().unwrap_or(0);
    let c = Counts {
        input: n("input_tokens"),
        output: n("output_tokens"),
        cache_read: n("cache_read_input_tokens"),
        cache_write: n("cache_creation_input_tokens"),
        ..Default::default()
    };
    Some((id.to_string(), model.to_string(), c))
}

/// The requests Claude Code `assistant` messages (`lines`) are of, by id, with their model: each request once, though its
/// message comes once for each content block, with the most output any of them says.
fn requests_of(lines: &[String]) -> BTreeMap<String, (String, Counts)> {
    let mut requests: BTreeMap<String, (String, Counts)> = BTreeMap::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if v["type"] != "assistant" {
            continue;
        }
        let Some((id, model, c)) = request_usage(&v) else { continue };
        let r = requests.entry(id).or_insert((model, c));
        r.1.output = r.1.output.max(c.output);
    }
    requests.retain(|_, (_, c)| c.total() > 0);
    requests
}

/// Whether Claude Code didn't keep an earlier run's tail in a session's `totals`, which go on from both the totals with it
/// (`with`) and those without it (`without`): which of them the requests the run made before its first result (`made`) are
/// closer to having fed in, on the models the tail used. A guess (`estimated`) unless one is exact: the totals also have
/// requests that print no message.
fn tail_was_lost(totals: &BTreeMap<String, Counts>, with: &BTreeMap<String, Counts>, without: &BTreeMap<String, Counts>, made: &BTreeMap<String, (String, Counts)>, estimated: &mut bool) -> bool {
    let tail_models: Vec<&String> = with.iter().filter(|(m, c)| without.get(*m) != Some(*c)).map(|(m, _)| m).collect();
    let zero = Counts::default();
    let fed_since = |from: &BTreeMap<String, Counts>| -> i64 { tail_models.iter().map(|m| totals.get(*m).unwrap_or(&zero).minus(from.get(*m).unwrap_or(&zero)).fed()).sum() };
    let (from_with, from_without) = (fed_since(with), fed_since(without));
    let fed: i64 = made.values().filter(|(m, _)| tail_models.contains(&m)).map(|(_, c)| c.fed()).sum();
    if fed != from_with && fed != from_without {
        *estimated = true;
    }
    (from_without - fed).abs() < (from_with - fed).abs()
}

/// What a Claude Code run used, from its output's lines.
///
/// Requests after the run's last `result` (a turn stopped, or a run that failed or was killed
/// before its result) aren't in any totals: they're counted from their `assistant` messages' own
/// usage, each request once (its message comes once for each content block), subagents' included,
/// and estimated (a message's output count can be short of the request's). They go in the
/// session's totals too, as `tail`: Claude Code keeps them in its totals if it saved them as the
/// run ended, so a run that resumes the session goes on from the totals with them, or else from
/// the totals without them; when its totals go on from both, its own requests before its first
/// result say which (see `tail_was_lost`). A run with no result at all goes on from its earlier run's totals,
/// and its tail adds to that run's.
pub fn count_claude(lines: impl Iterator<Item = String>, earlier: &mut Earlier) -> Counted {
    let mut out = Counted { runtime: "claude", ..Default::default() };
    let mut session: Option<String> = None;
    // The session the totals in `out.snapshot` are for, and those totals without the earlier
    // run's tail, if it had one.
    let mut base_session: Option<String> = None;
    let mut have_base = false;
    let mut without_tail: Option<BTreeMap<String, Counts>> = None;
    // The assistant messages since the latest result, which no result's totals have.
    let mut since: Vec<String> = Vec::new();
    for line in lines {
        let (assistant, other) = (line.contains("\"assistant\""), line.contains("\"result\"") || line.contains("\"init\""));
        if !other {
            // Read once it's known whether a result comes after it.
            if assistant {
                since.push(line);
            }
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if v["type"] == "assistant" {
            since.push(line);
            continue;
        }
        if v["type"] == "system" && v["subtype"] == "init" {
            session = v["session_id"].as_str().map(String::from).or(session);
            continue;
        }
        if v["type"] != "result" {
            continue;
        }
        let Some(usage) = v["modelUsage"].as_object().filter(|m| !m.is_empty()) else { continue };
        let made = requests_of(&since);
        since.clear();
        let sid = v["session_id"].as_str().map(String::from).or(session.clone());
        if !have_base || base_session != sid {
            let before = sid.as_deref().and_then(&mut *earlier).unwrap_or_default();
            without_tail = (!before.tail.is_empty()).then(|| {
                let mut t = before.totals.clone();
                for (m, tail) in &before.tail {
                    if let Some(c) = t.get_mut(m) {
                        *c = c.minus(tail);
                    }
                }
                // A model only the tail used isn't in totals that don't have it.
                t.retain(|_, c| c.total() > 0);
                t
            });
            out.snapshot = before.totals;
            base_session = sid.clone();
            have_base = true;
        }
        let totals: BTreeMap<String, Counts> = usage.iter().map(|(m, u)| (m.clone(), Counts::from_claude(u))).collect();
        let covered = |before: &BTreeMap<String, Counts>| before.iter().all(|(m, b)| totals.get(m).is_some_and(|now| now.covers(b)));
        match without_tail.take() {
            // Claude Code didn't keep the earlier run's tail: the totals don't go on from it, or they go on from both and
            // the run's own requests say which.
            Some(t) if covered(&t) && (!covered(&out.snapshot) || tail_was_lost(&totals, &out.snapshot, &t, &made, &mut out.estimated)) => out.snapshot = t,
            // Counting started again: a model it had is gone, or went down.
            _ if !covered(&out.snapshot) => out.snapshot.clear(),
            _ => {}
        }
        for (model, now) in &totals {
            let used = now.minus(out.snapshot.get(model).unwrap_or(&Counts::default()));
            out.models.entry(model.clone()).or_default().add(&used);
        }
        out.snapshot = totals;
        out.session = sid;
    }
    // The requests after the last result.
    let requests = requests_of(&since);
    // No result set where the session's totals were: the run's requests go on from its earlier
    // run's (and from its tail, if that had one too, which a run that resumes it may not find).
    if !requests.is_empty() && !have_base {
        if let Some(before) = session.as_deref().and_then(&mut *earlier) {
            out.snapshot = before.totals;
            out.tail = before.tail;
        }
        out.session = session.clone();
    }
    for (model, c) in requests.into_values() {
        out.estimated = true;
        out.models.entry(model.clone()).or_default().add(&c);
        out.snapshot.entry(model.clone()).or_default().add(&c);
        out.tail.entry(model).or_default().add(&c);
    }
    out.models.retain(|_, c| c.total() > 0 || c.cost > 0.0);
    out
}

/// What a Codex run used, from its output's lines, with `model` unless the output names it. A
/// subagent's thread counts towards the model it was started with, if its start says (Codex's
/// `collabAgentToolCall` spawning it, or its `subAgentActivity`), else the run's.
pub fn count_codex(lines: impl Iterator<Item = String>, model: &str, earlier: &mut Earlier) -> Counted {
    let mut out = Counted { runtime: "codex", ..Default::default() };
    let mut model = model.to_string();
    // Threads' models, where they're known, and what each thread used.
    let mut models: std::collections::HashMap<String, String> = Default::default();
    let mut used: Vec<(String, Counts)> = Vec::new();
    for line in lines {
        let starts = line.contains("collabAgentToolCall") || line.contains("subAgentActivity");
        if !starts && !line.contains("thread/tokenUsage/updated") && !line.contains("huntaway/model") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        let p = &v["params"];
        if v["method"] == "huntaway/model" {
            if let Some(m) = p["model"].as_str().filter(|m| !m.is_empty()) {
                model = m.to_string();
            }
            continue;
        }
        let item = &p["item"];
        let started = |m: &Value| m.as_str().filter(|m| !m.is_empty()).map(String::from);
        if item["type"] == "collabAgentToolCall" && item["tool"] == "spawnAgent" {
            if let Some(m) = started(&item["model"]) {
                for t in item["receiverThreadIds"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                    models.insert(t.to_string(), m.clone());
                }
            }
            continue;
        }
        if item["type"] == "subAgentActivity" {
            if let (Some(t), Some(m)) = (item["agentThreadId"].as_str(), started(&item["model"])) {
                models.insert(t.to_string(), m);
            }
            continue;
        }
        if v["method"] != "thread/tokenUsage/updated" {
            continue;
        }
        let Some(thread) = p["threadId"].as_str() else { continue };
        let total = Counts::from_codex(&p["tokenUsage"]["total"]);
        let last = Counts::from_codex(&p["tokenUsage"]["last"]);
        if !out.snapshot.contains_key(thread) {
            if let Some(before) = earlier(thread).and_then(|mut s| s.totals.remove(thread)) {
                out.snapshot.insert(thread.to_string(), before);
            }
        }
        let add = match out.snapshot.get(thread) {
            Some(before) if total.covers(before) => total.minus(before),
            // Its earlier totals aren't known, or it was rolled back.
            Some(_) => last,
            None if total.total() == last.total() => total,
            None => last,
        };
        used.push((thread.to_string(), add));
        out.snapshot.insert(thread.to_string(), total);
    }
    // Once the run's own model is known (the adapter says it as the thread starts).
    for (thread, add) in used {
        let m = models.get(&thread).cloned().unwrap_or_else(|| model.clone());
        out.models.entry(m).or_default().add(&add);
    }
    out.models.retain(|_, c| c.total() > 0);
    out
}

/// Lines of a file, or none if it can't be read.
fn lines_of(path: &Path) -> Box<dyn Iterator<Item = String>> {
    match std::fs::File::open(path) {
        Ok(f) => Box::new(std::io::BufReader::new(f).lines().map_while(|l| l.ok())),
        Err(_) => Box::new(std::iter::empty()),
    }
}

struct RunRow {
    id: String,
    task_id: String,
    rowid: i64,
    cost_usd: f64,
    created_at: String,
}

/// Count the runs that have ended and haven't been counted (only `task_id`'s, if given), oldest
/// first for each task, so each goes on from its task's earlier runs. Returns how many it counted.
pub fn count_pending(state: &Shared, task_id: Option<&str>) -> Result<usize> {
    let _g = COUNTING.lock().unwrap_or_else(|e| e.into_inner());
    let runs: Vec<RunRow> = {
        let c = state.db();
        let mut st = c.prepare(
            "SELECT id, task_id, rowid, cost_usd, created_at FROM runs WHERE status='exited' AND usage_at IS NULL AND (?1 IS NULL OR task_id=?1)
             ORDER BY task_id, rowid",
        )?;
        st.query_map([task_id], |r| Ok(RunRow { id: r.get(0)?, task_id: r.get(1)?, rowid: r.get(2)?, cost_usd: r.get(3)?, created_at: r.get(4)? }))?
            .collect::<rusqlite::Result<_>>()?
    };
    for run in &runs {
        if let Err(e) = count_run(state, run) {
            tracing::warn!(run = %run.id, "counting the run's tokens: {e:#}");
            // So it isn't tried again and again.
            state.db().execute("UPDATE runs SET usage_at=?1 WHERE id=?2", params![now(), run.id])?;
        }
    }
    Ok(runs.len())
}

fn count_run(state: &Shared, run: &RunRow) -> Result<()> {
    let dir = run_dir(state, &run.id);
    let out_file = dir.join("out.jsonl");
    // The totals the task's latest earlier counted run had reached for a session or thread.
    let mut earlier = |key: &str| -> Option<Before> {
        let c = state.db();
        let snap: Option<(String, Option<String>)> = c
            .query_row(
                "SELECT usage_snapshot, usage_tail FROM runs WHERE task_id=?1 AND rowid < ?2 AND usage_snapshot IS NOT NULL
                   AND (usage_session=?3 OR (usage_session IS NULL AND instr(usage_snapshot, ?4) > 0))
                 ORDER BY rowid DESC LIMIT 1",
                params![run.task_id, run.rowid, key, format!("\"{key}\"")],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .ok()
            .flatten();
        let (totals, tail) = snap?;
        Some(Before {
            totals: serde_json::from_str(&totals).ok()?,
            tail: tail.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default(),
        })
    };
    let counted = if !out_file.exists() {
        estimate(state, run)?
    } else if dir.join("codex.json").exists() {
        let model = codex_model(state, run, &dir);
        count_codex(lines_of(&out_file), &model, &mut earlier)
    } else {
        let mut counted = count_claude(lines_of(&out_file), &mut earlier);
        // More than the board charged the run: it was counted from nothing, its session's earlier
        // runs' totals being gone.
        let cost: f64 = counted.models.values().map(|c| c.cost).sum();
        if run.cost_usd > 0.0 && cost > run.cost_usd * 1.05 + 0.01 {
            let f = run.cost_usd / cost;
            counted.models.values_mut().for_each(|c| c.scale(f));
            counted.estimated = true;
        }
        counted
    };
    save(state, &run.id, &counted)
}

/// A run whose output is gone: what it cost, on the model its turns or its task say.
fn estimate(state: &Shared, run: &RunRow) -> Result<Counted> {
    let c = state.db();
    let mut out = Counted { estimated: true, runtime: "claude", ..Default::default() };
    let task = db::get_task(&c, &run.task_id)?;
    if task.as_ref().and_then(|t| db::task_claude_config(&c, t).ok().flatten()).is_some_and(|cfg| cfg.is_codex()) {
        out.runtime = "codex";
    }
    if run.cost_usd <= 0.0 {
        return Ok(out);
    }
    let model: Option<String> = c
        .query_row("SELECT model FROM context_stats WHERE run_id=?1 AND model IS NOT NULL ORDER BY id DESC LIMIT 1", [&run.id], |r| r.get(0))
        .optional()?;
    let model = model.or_else(|| task.and_then(|t| t.model)).unwrap_or_else(|| "unknown".into());
    out.models.insert(model, Counts { cost: run.cost_usd, ..Default::default() });
    Ok(out)
}

/// The model a Codex run's thread was started with, before its output says (see the module's docs).
fn codex_model(state: &Shared, run: &RunRow, dir: &Path) -> String {
    let spec: Value = std::fs::read_to_string(dir.join("codex.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    if let Some(m) = spec["model"].as_str().filter(|m| !m.is_empty()) {
        return m.to_string();
    }
    let launch: Value = std::fs::read_to_string(dir.join("spec.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    let thread = spec["thread_id"].as_str().map(String::from).or_else(|| {
        lines_of(&dir.join("out.jsonl"))
            .filter(|l| l.contains("thread/started"))
            .find_map(|l| serde_json::from_str::<Value>(&l).ok()?["params"]["thread"]["id"].as_str().map(String::from))
    });
    let config_dir = launch["config_dir"].as_str().unwrap_or("~/.codex");
    if let Some(m) = thread.and_then(|t| rollout_model(&expand_tilde(config_dir), &t, &run.created_at)) {
        return m;
    }
    let task = db::get_task(&state.db(), &run.task_id).ok().flatten();
    task.and_then(|t| t.model).unwrap_or_else(|| "codex".into())
}

/// The model in Codex's rollout file for `thread` (`sessions/YYYY/MM/DD/rollout-…-<thread>.jsonl`
/// under its config folder), looked for in the days around `at`, the run's start.
fn rollout_model(config_dir: &Path, thread: &str, at: &str) -> Option<String> {
    let at = chrono::DateTime::parse_from_rfc3339(at).ok()?.with_timezone(&chrono::Local);
    let suffix = format!("-{thread}.jsonl");
    for days in [0, -1, 1] {
        let day = at + chrono::Duration::days(days);
        let folder: PathBuf = config_dir.join("sessions").join(day.format("%Y/%m/%d").to_string());
        let Ok(entries) = std::fs::read_dir(&folder) else { continue };
        let Some(file) = entries.flatten().map(|e| e.path()).find(|p| p.to_str().is_some_and(|s| s.ends_with(&suffix))) else { continue };
        return lines_of(&file).filter(|l| l.contains("\"turn_context\"")).find_map(|l| {
            let v: Value = serde_json::from_str(&l).ok()?;
            v["payload"]["model"].as_str().map(String::from)
        });
    }
    None
}

fn save(state: &Shared, run_id: &str, counted: &Counted) -> Result<()> {
    let mut c = state.db();
    let tx = c.transaction()?;
    // Counted already, by a count that started before this one finished: leave it.
    let pending: bool = tx.query_row("SELECT usage_at IS NULL FROM runs WHERE id=?1", [run_id], |r| r.get(0)).optional()?.unwrap_or(false);
    if !pending {
        return Ok(());
    }
    for (model, n) in &counted.models {
        tx.execute(
            "INSERT OR REPLACE INTO token_usage (run_id, model, runtime, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd, estimated)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![
                run_id,
                model,
                counted.runtime,
                n.input,
                n.output,
                n.cache_read,
                n.cache_write,
                n.reasoning,
                (counted.runtime == "claude").then_some(n.cost),
                counted.estimated
            ],
        )?;
    }
    let snapshot = (!counted.snapshot.is_empty()).then(|| serde_json::to_string(&counted.snapshot)).transpose()?;
    let tail = (!counted.tail.is_empty()).then(|| serde_json::to_string(&counted.tail)).transpose()?;
    tx.execute(
        "UPDATE runs SET usage_at=?1, usage_session=?2, usage_snapshot=?3, usage_tail=?4 WHERE id=?5",
        params![now(), counted.session, snapshot, tail, run_id],
    )?;
    tx.commit()?;
    Ok(())
}

/// A run of `task_id` ended: count it, and any of the task's before it, in the background.
pub fn on_run_ended(state: &Shared, task_id: &str) {
    let Ok(handle) = tokio::runtime::Handle::try_current() else { return };
    let (s, task_id) = (state.clone(), task_id.to_string());
    handle.spawn_blocking(move || {
        if let Err(e) = count_pending(&s, Some(&task_id)) {
            tracing::warn!(task = %task_id, "counting tokens: {e:#}");
        }
    });
}

pub mod calls;
#[cfg(test)]
mod tests;
