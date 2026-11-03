//! Approval rules: for each tool or MCP server, the assistant may use it (allow), asks the user
//! first (ask) or never does (never), whatever its thread's permission mode. They're its profile's
//! (`approval_rules:<profile id>` in the settings), and they hold for the profile's assistant and the
//! threads under it (see `applies_to`).
//!
//! How each runtime holds them (checked with Claude Code 2.1.317 and Codex 0.166):
//!
//! - **Claude:** a PreToolUse hook (`huntaway approval-hook`) decides every call a rule matches. A
//!   hook's `ask` reaches the permission prompt tool in every mode, Bypass, Don't ask and Auto included
//!   (and even for a tool in `--allowedTools`), so the board passes `--permission-prompt-tool` in
//!   Bypass too, and its prompt (mcp/permissions.rs) asks the user whatever the mode, but denies in
//!   Don't ask. Its `deny` holds in Bypass. Tools a rule names exactly that are *never* go in
//!   `--disallowedTools` as well, so the agent doesn't see them.
//! - **Codex:** a PreToolUse hook's `ask` fails open there, and hooks it hasn't been told to trust
//!   don't run, so the rules go in each MCP server's config instead: a server a rule may match asks
//!   about every call (`default_tools_approval_mode = "prompt"`), and the board's prompt decides by the
//!   rules (allow, ask the user, or deny); tools named exactly are approved or disabled up front.
//!   Codex's own reviewer would answer in Auto, so the assistant's Codex runs in Auto have the user
//!   as reviewer instead (they ask as in Ask). With an approval policy of `never` (Bypass and Don't
//!   ask), Codex refuses a call that asks: *ask* and *never* still hold, as refusals, but a tool
//!   allowed only by a pattern is refused too. Codex's own tools (Bash, ApplyPatch) can't be stopped
//!   before they run: an *ask* rule on them has it ask about everything it doesn't take as safe, and a
//!   *never* rule on them keeps the run from starting (see `codex_policy`).
//! - **The board's own tools** (create_task, wait and the rest) are decided by the board as it runs
//!   them (see mcp/tools/dispatch.rs's check_rules), for both. Those that always ask the user
//!   themselves (`ASKS_ITSELF`) aren't asked about again.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::agent::runner::{LEGACY_MCP_SERVER_NAME, MCP_SERVER_NAME};
use crate::db::{self, Task};
use crate::state::Shared;
use crate::util::{new_id, now};

/// What a rule does with the calls it matches, weakest first: when several match, the strongest wins.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Allow,
    Ask,
    Never,
}

impl Decision {
    pub fn name(self) -> &'static str {
        match self {
            Decision::Allow => "allow",
            Decision::Ask => "ask",
            Decision::Never => "never",
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
pub struct Rule {
    /// A tool's name (`mcp__google__send_gmail_message`, `Bash`), an MCP server's prefix for all its
    /// tools (`mcp__google`), or a pattern where `*` stands for anything (`mcp__google__*delete*`),
    /// matched without regard to case.
    pub tool: String,
    pub decision: Decision,
}

fn rule(tool: &str, decision: Decision) -> Rule {
    Rule { tool: tool.into(), decision }
}

/// How long a prompt from a routine run waits for an answer by default, in minutes.
pub const DEFAULT_EXPIRY_MINUTES: u32 = 30;
/// The longest a prompt from a routine run can be set to wait: a week.
pub const MAX_EXPIRY_MINUTES: u32 = 7 * 24 * 60;
const MAX_RULES: usize = 200;

/// A profile's rules, and how long its routine runs' prompts wait (see permissions::expiry).
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
pub struct Rules {
    pub rules: Vec<Rule>,
    /// Minutes until a prompt raised by a routine run is denied; 0 never.
    #[serde(default = "default_expiry")]
    pub expiry_minutes: u32,
}

fn default_expiry() -> u32 {
    DEFAULT_EXPIRY_MINUTES
}

impl Default for Rules {
    fn default() -> Self {
        Self { rules: default_rules(), expiry_minutes: DEFAULT_EXPIRY_MINUTES }
    }
}

/// The MCP server name the Google defaults are written for: the Google Workspace server the
/// assistant is given (Gmail, Calendar and Drive) goes by it.
pub const GOOGLE_SERVER: &str = "google";

/// The rules a profile starts with: for the Google server, reading, searching and drafting are
/// allowed; sending mail, making, changing or deleting events, sharing files or handing them over,
/// changing files, mail filters and mail's labels (which is how mail goes to the trash) ask; deleting
/// or trashing mail and files is never.
/// The patterns fit the tool names of the Google Workspace MCP server (`search_gmail_messages`,
/// `send_gmail_message`, `create_event`, `share_drive_file` and so on) and names like them.
pub fn default_rules() -> Vec<Rule> {
    use Decision::*;
    let g = |p: &str| format!("mcp__{GOOGLE_SERVER}__{p}");
    let allow = ["search*", "get*", "list*", "read*", "check*", "*draft*"].map(|p| rule(&g(p), Allow));
    let ask = [
        "*send*", "create*event*", "modify*event*", "update*event*", "delete*event*", "*share*", "*add*permission*", "*update*permission*",
        "*remove*permission*", "*message*label*", "manage*", "update*file*", "create*filter*", "*transfer*",
    ]
    .map(|p| rule(&g(p), Ask));
    let never = ["*trash*", "*delete*mail*", "*mail*delete*", "*delete*message*", "*delete*file*", "*delete*drive*", "*drive*delete*"].map(|p| rule(&g(p), Never));
    allow.into_iter().chain(ask).chain(never).collect()
}

/// The board tools that create tasks, which an optional rule asks about (`create_task` makes
/// scratch tasks too).
pub const CREATE_TASK_TOOLS: &[&str] = &["create_task"];

/// Whether `pattern` matches tool `tool` (see Rule::tool).
pub fn matches(pattern: &str, tool: &str) -> bool {
    let (p, t) = (pattern.trim().to_lowercase(), tool.to_lowercase());
    if p.is_empty() {
        return false;
    }
    if !p.contains('*') {
        return t == p || (p.starts_with("mcp__") && !p[5..].contains("__") && t.strip_prefix(&p).is_some_and(|r| r.starts_with("__")));
    }
    glob(p.as_bytes(), t.as_bytes())
}

/// `*` matches any run of characters, everything else itself.
fn glob(p: &[u8], t: &[u8]) -> bool {
    let (mut pi, mut ti) = (0, 0);
    let (mut star, mut mark) = (None, 0);
    while ti < t.len() {
        if pi < p.len() && p[pi] == b'*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if pi < p.len() && p[pi] == t[ti] {
            pi += 1;
            ti += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|&c| c == b'*')
}

/// The names the board's MCP server goes by, now and before (a rule may use any).
pub const BOARD_SERVER_NAMES: [&str; 3] = [MCP_SERVER_NAME, LEGACY_MCP_SERVER_NAME, "issue-agent"];

/// The board's tools that ask the user to approve what they do whatever the thread's mode (see
/// mcp/tools/approvals.rs): an ask rule doesn't ask about them again (a never rule still refuses them).
/// update_project asks only for some settings, so an ask rule asks about it too.
pub const ASKS_ITSELF: &[&str] = &["delete_task", "create_project", "create_automation", "update_automation", "delete_automation"];

/// Whether `tool` is one of the board's own (decided by the board as it runs them, see
/// mcp/tools/dispatch.rs's check_rules).
pub fn is_board_tool(tool: &str) -> bool {
    let t = tool.to_lowercase();
    BOARD_SERVER_NAMES.iter().any(|n| t.starts_with(&format!("mcp__{n}__")) || t == format!("mcp__{n}"))
}

/// Whether rules hold for `tool` at all: questions and plans only ever go to the user.
fn ruled(tool: &str) -> bool {
    !crate::mcp::permissions::is_question(tool) && tool != crate::mcp::permissions::EXIT_PLAN
}

impl Rules {
    /// The rule that decides `tool`: the strongest of those that match it (never, then ask, then
    /// allow), the first of those given.
    pub fn decide(&self, tool: &str) -> Option<&Rule> {
        if !ruled(tool) {
            return None;
        }
        let mut best: Option<&Rule> = None;
        for r in self.rules.iter().filter(|r| matches(&r.tool, tool)) {
            if best.is_none_or(|b| r.decision > b.decision) {
                best = Some(r);
            }
        }
        best
    }

    /// Checked and tidied for saving: patterns trimmed, empty ones dropped, each at most once.
    pub fn checked(mut self) -> Result<Self, String> {
        let mut seen = std::collections::HashSet::new();
        self.rules = self
            .rules
            .into_iter()
            .map(|r| Rule { tool: r.tool.trim().to_string(), ..r })
            .filter(|r| !r.tool.is_empty())
            .filter(|r| seen.insert(r.tool.to_lowercase()))
            .collect();
        if self.rules.len() > MAX_RULES {
            return Err(format!("at most {MAX_RULES} rules"));
        }
        if let Some(r) = self.rules.iter().find(|r| r.tool.len() > 200 || r.tool.chars().any(|c| c.is_whitespace() || c.is_control())) {
            return Err(format!("\"{}\" isn't a tool name or pattern: no spaces, and at most 200 characters", r.tool));
        }
        if self.expiry_minutes > MAX_EXPIRY_MINUTES {
            return Err(format!("expiry_minutes is at most {MAX_EXPIRY_MINUTES} (a week)"));
        }
        Ok(self)
    }

    /// The rules for a run in `mode`: plan mode doesn't take allow rules, which would let a tool
    /// that changes things run while the agent is only meant to plan.
    pub fn for_mode(&self, mode: &str) -> Rules {
        let rules = self.rules.iter().filter(|r| mode != "plan" || r.decision != Decision::Allow).cloned().collect();
        Rules { rules, expiry_minutes: self.expiry_minutes }
    }

    fn has(&self, d: Decision) -> bool {
        self.rules.iter().any(|r| r.decision == d)
    }
}

fn setting_key(profile_id: &str) -> String {
    format!("approval_rules:{profile_id}")
}

/// A profile's rules: the ones saved, or else the defaults.
pub fn get(c: &Connection, profile_id: &str) -> Result<Rules> {
    Ok(saved(c, profile_id)?.unwrap_or_default())
}

/// The rules a profile saved, if it has.
pub fn saved(c: &Connection, profile_id: &str) -> Result<Option<Rules>> {
    Ok(db::get_setting(c, &setting_key(profile_id))?.and_then(|v| serde_json::from_str(&v).ok()))
}

/// Save a profile's rules; None goes back to the defaults.
pub fn set(c: &Connection, profile_id: &str, rules: Option<&Rules>) -> Result<()> {
    let value = rules.map(serde_json::to_string).transpose()?;
    db::set_setting(c, &setting_key(profile_id), value.as_deref())
}

/// Whether the rules hold for `task`'s runs: its profile's assistant, and threads under it.
pub fn applies_to(c: &Connection, task: &Task) -> Result<bool> {
    if task.is_assistant() {
        return Ok(true);
    }
    match &task.parent_id {
        Some(p) => Ok(db::get_task(c, p)?.is_some_and(|p| p.is_assistant())),
        None => Ok(false),
    }
}

/// The rules for `task`'s runs, if they hold for it (see `applies_to`).
pub fn for_task(c: &Connection, task: &Task) -> Result<Option<Rules>> {
    if !applies_to(c, task)? {
        return Ok(None);
    }
    Ok(Some(get(c, &task.profile_id)?))
}

// ---------- Claude ----------

/// What a blocked call's result starts with (see `hook_decision`), by which the runner finds it in
/// the agent's output and logs it (see `on_tool_results`).
pub const BLOCKED: &str = "Blocked by the user's approval rules";

/// The reason a call that rule `pattern` sets to never is turned away with.
pub fn blocked_reason(pattern: &str) -> String {
    format!(
        "{BLOCKED} (never: {pattern}). Don't retry it or try another way to do the same thing: carry on without it, and tell the user \
         what you couldn't do."
    )
}

/// The hook's rules: those it decides, which are all but the board's tools' (see `is_board_tool`).
fn hook_rules(rules: &Rules) -> Vec<&Rule> {
    rules.rules.iter().filter(|r| !is_board_tool(&r.tool)).collect()
}

/// The PreToolUse hook entry for a Claude run with `rules` (already for its mode, see
/// `Rules::for_mode`), if it has any for the hook: `'<exe>' approval-hook '<rules>'`.
pub fn claude_hook(exe: &std::path::Path, rules: &Rules) -> Option<Value> {
    let own = hook_rules(rules);
    if own.is_empty() {
        return None;
    }
    let quote = |s: &str| format!("'{}'", s.replace('\'', r"'\''"));
    let command = format!("{} approval-hook {}", quote(&crate::util::path_str(exe)), quote(&json!(own).to_string()));
    // Only MCP tools, unless a rule is for another tool. The hook checks the name again.
    let matcher = if own.iter().all(|r| r.tool.to_lowercase().starts_with("mcp__")) { "mcp__.*" } else { "*" };
    // It answers at once: asking is the permission prompt's (the board's), not the hook's.
    Some(json!({"matcher": matcher, "hooks": [{"type": "command", "command": command, "timeout": 10}]}))
}

/// `--disallowedTools` for a Claude run with `rules`: the tools and servers a rule names exactly
/// that are never, so the agent doesn't get them at all.
pub fn claude_disallowed(rules: &Rules) -> Vec<String> {
    hook_rules(rules).into_iter().filter(|r| r.decision == Decision::Never && !r.tool.contains('*')).map(|r| r.tool.clone()).collect()
}

/// Whether a Claude run with `rules` needs the board's permission prompt even in Bypass, where it
/// otherwise has none: a hook's ask goes to it.
pub fn needs_prompt_tool(rules: &Rules) -> bool {
    hook_rules(rules).iter().any(|r| r.decision == Decision::Ask)
}

/// `huntaway approval-hook <rules>`: Claude Code's PreToolUse hook for the assistant's runs, which
/// decides the calls the rules match (`<rules>` is their JSON list).
pub fn hook(rules: &str) -> Result<()> {
    let mut input = String::new();
    std::io::Read::read_to_string(&mut std::io::stdin(), &mut input)?;
    let rules: Vec<Rule> = serde_json::from_str(rules)?;
    let call: Value = serde_json::from_str(&input).unwrap_or_default();
    if let Some(out) = hook_decision(&Rules { rules, expiry_minutes: 0 }, &call) {
        println!("{out}");
    }
    Ok(())
}

/// What the hook answers for a call (its input), if a rule decides it.
pub fn hook_decision(rules: &Rules, call: &Value) -> Option<Value> {
    let tool = call["tool_name"].as_str()?;
    if is_board_tool(tool) {
        return None;
    }
    let r = rules.decide(tool)?;
    let (decision, reason) = match r.decision {
        Decision::Allow => ("allow", format!("Allowed by the user's approval rules ({})", r.tool)),
        Decision::Ask => ("ask", format!("The user's approval rules ask them first ({})", r.tool)),
        Decision::Never => ("deny", blocked_reason(&r.tool)),
    };
    Some(json!({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": decision, "permissionDecisionReason": reason}}))
}

/// A Claude message with tool results (`v`, as the run streamed it): the calls the hook blocked go
/// in the action log.
pub fn on_tool_results(s: &Shared, task: &Task, v: &Value) {
    let blocks = v["message"]["content"].as_array().map(Vec::as_slice).unwrap_or_default();
    for b in blocks.iter().filter(|b| b["type"] == "tool_result" && b["is_error"] == true) {
        let text = match &b["content"] {
            Value::String(t) => t.clone(),
            Value::Array(parts) => parts.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("\n"),
            _ => continue,
        };
        if !text.contains(BLOCKED) {
            continue;
        }
        let Some(id) = b["tool_use_id"].as_str() else { continue };
        let Some((tool, input)) = tool_use(s, &task.id, id) else { continue };
        // Only a call the hook blocked: one a never rule decides, of a tool the hook decides (the
        // board logs its own), and not some other tool's output that happens to quote the reason.
        let rules = match for_task(&s.db(), task) {
            Ok(Some(r)) => r,
            _ => continue,
        };
        let Some(rule) = rules.decide(&tool).filter(|r| r.decision == Decision::Never && !is_board_tool(&tool)) else { continue };
        if let Err(e) = log_blocked(s, task, &tool, &input, &rule.tool) {
            tracing::warn!(task = %task.id, "logging a blocked call: {e:#}");
        }
    }
}

/// The name and input of tool call `id` in `task_id`'s thread.
fn tool_use(s: &Shared, task_id: &str, id: &str) -> Option<(String, Value)> {
    let c = s.db();
    let mut st = c.prepare("SELECT data FROM messages WHERE task_id=?1 AND kind='claude' AND instr(data, ?2) > 0 ORDER BY id DESC LIMIT 5").ok()?;
    let rows: Vec<String> = st.query_map(params![task_id, id], |r| r.get(0)).ok()?.filter_map(Result::ok).collect();
    rows.iter().filter_map(|d| serde_json::from_str::<Value>(d).ok()).find_map(|v| {
        let blocks = v["message"]["content"].as_array()?.clone();
        blocks.into_iter().find(|b| b["type"] == "tool_use" && b["id"] == id).map(|b| (b["name"].as_str().unwrap_or("unknown").to_string(), b["input"].clone()))
    })
}

// ---------- Codex ----------

/// Server `server`'s config for a Codex run with `rules` (already for its mode), changed to hold
/// them (see the module docs). False if a rule turns the whole server off.
pub fn codex_server(rules: &Rules, server: &str, cfg: &mut Map<String, Value>) -> bool {
    if server == MCP_SERVER_NAME || server == LEGACY_MCP_SERVER_NAME {
        return true;
    }
    let prefix = crate::agent::agent_tools::tool_prefix(server).to_lowercase();
    let mine: Vec<&Rule> = rules.rules.iter().filter(|r| may_match_server(&r.tool.to_lowercase(), &prefix)).collect();
    if mine.iter().any(|r| r.decision == Decision::Never && r.tool.to_lowercase() == prefix) {
        return false;
    }
    if mine.is_empty() {
        return true;
    }
    let exact = |d: Decision| -> Vec<String> {
        mine.iter()
            .filter(|r| r.decision == d && !r.tool.contains('*'))
            .filter_map(|r| r.tool.to_lowercase().strip_prefix(&format!("{prefix}__")).map(String::from))
            .collect()
    };
    let strict = mine.iter().any(|r| r.decision != Decision::Allow);
    if strict {
        // Every call asks, and the board answers by the rules.
        cfg.insert("default_tools_approval_mode".into(), json!("prompt"));
    }
    let tools = cfg.entry("tools").or_insert_with(|| json!({}));
    for (d, mode) in [(Decision::Allow, "approve"), (Decision::Ask, "prompt")] {
        for t in exact(d) {
            // Unless a stronger rule matches it too.
            if rules.decide(&format!("{prefix}__{t}")).is_some_and(|r| r.decision == d) {
                tools[t.as_str()] = json!({"approval_mode": mode});
            }
        }
    }
    let never = exact(Decision::Never);
    if !never.is_empty() {
        let mut disabled: Vec<Value> = cfg.get("disabled_tools").and_then(|d| d.as_array().cloned()).unwrap_or_default();
        disabled.extend(never.into_iter().map(Value::String));
        cfg.insert("disabled_tools".into(), Value::Array(disabled));
    }
    true
}

/// Whether a pattern (lowercase) may match a tool of the server with tool prefix `prefix`.
fn may_match_server(pattern: &str, prefix: &str) -> bool {
    let literal = pattern.split('*').next().unwrap_or_default();
    let own = format!("{prefix}__");
    if !pattern.contains('*') {
        return pattern == prefix || pattern.starts_with(&own);
    }
    own.starts_with(literal) || literal.starts_with(&own)
}

/// Whether the assistant's Codex runs in `mode` with `rules` have the user rather than Codex's
/// reviewer answer its approvals: the reviewer would answer ask rules itself.
pub fn codex_needs_user_reviewer(rules: &Rules) -> bool {
    rules.has(Decision::Ask) || rules.has(Decision::Never)
}

/// A Codex run's (approval policy, approvals reviewer, sandbox) with `rules` (already for its mode),
/// from what its mode gives (see codex::policy): the user rather than Codex's reviewer answers when
/// a rule asks or refuses (the reviewer would answer them itself), and with a rule asking about its
/// own tools it asks about every command and file change it doesn't take as safe, never with full
/// access (see `codex_own_tools`, which also says when it can't run at all).
pub fn codex_policy(rules: Option<&Rules>, mode: (&'static str, &'static str, &'static str)) -> Result<(&'static str, &'static str, &'static str), String> {
    let (mut policy, mut reviewer, mut sandbox) = mode;
    let Some(rules) = rules else { return Ok(mode) };
    if codex_needs_user_reviewer(rules) && reviewer == "auto_review" {
        reviewer = "user";
    }
    if codex_own_tools(rules)? {
        (policy, reviewer) = ("untrusted", "user");
        if sandbox == "danger-full-access" {
            sandbox = "workspace-write";
        }
    }
    Ok((policy, reviewer, sandbox))
}

/// Whether a rule may match one of an agent's own tools rather than an MCP server's (Bash, and
/// Codex's ApplyPatch, as the board asks about them).
fn for_own_tools(r: &Rule) -> bool {
    !r.tool.trim().to_lowercase().starts_with("mcp__")
}

/// What a Codex run needs for the rules (already for its mode) on its own tools, which nothing can
/// stop before they run: Ok(true) for an ask rule, so Codex asks about every command and file change
/// it doesn't take as safe (approval policy `untrusted`, never full access), and the board answers by
/// the rules; or Err, why it can't run, for a never rule, which Codex can't hold (it runs the
/// commands it takes as read-only without asking, and has other ways to run code, such as its
/// JavaScript tool, checked with Codex 0.166).
pub fn codex_own_tools(rules: &Rules) -> Result<bool, String> {
    if let Some(r) = rules.rules.iter().find(|r| r.decision == Decision::Never && for_own_tools(r)) {
        return Err(format!(
            "The assistant's approval rule \"{}: never\" is for the agent's own tools, which Codex can't be stopped from using: \
             it runs commands it takes as safe without asking. Change the rule to ask, or give the assistant a Claude config.",
            r.tool
        ));
    }
    Ok(rules.rules.iter().any(|r| r.decision == Decision::Ask && for_own_tools(r)))
}

// ---------- the action log ----------

/// A call that hit an ask or never rule.
#[derive(Serialize, Debug, Clone)]
pub struct Action {
    pub id: String,
    pub task_id: String,
    pub request_id: Option<String>,
    pub tool_name: String,
    /// What it was called with, in a line.
    pub summary: String,
    /// The rule that matched it.
    pub rule: String,
    /// ask or never.
    pub decision: String,
    /// pending, allowed, denied, expired or blocked.
    pub outcome: String,
    /// Who answered: `user` (on the board), `push` (from a notification), `expiry` (nobody, in
    /// time), `mode` (Don't ask), `rule` (a never rule), or `ended` (its run ended first).
    pub answered_by: Option<String>,
    pub created_at: String,
    pub decided_at: Option<String>,
}

/// Most entries listed at once.
pub const MAX_LISTED: i64 = 500;
/// How many entries a profile keeps: older ones go.
const KEEP: i64 = 5000;

/// A tool input in a line: its fields and values, each cut short. Codex's prompts for an MCP tool
/// (see codex/adapter.rs) give the tool's arguments beside its question, and only those are shown.
pub fn summarize(input: &Value) -> String {
    if let (Some(args), Some(_)) = (input.get("arguments").filter(|a| a.is_object()), input.get("message")) {
        return summarize(args);
    }
    let cut = |s: &str, n: usize| {
        let one: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
        if one.chars().count() > n { format!("{}…", one.chars().take(n).collect::<String>()) } else { one }
    };
    let text = match input {
        Value::Object(o) => o
            .iter()
            .filter(|(_, v)| !v.is_null())
            .map(|(k, v)| match v {
                Value::String(s) => format!("{k}: {}", cut(s, 80)),
                v => format!("{k}: {}", cut(&v.to_string(), 80)),
            })
            .collect::<Vec<_>>()
            .join(", "),
        Value::Null => String::new(),
        v => v.to_string(),
    };
    cut(&text, 300)
}

/// Log a call that rule `r` asked about, raised as prompt `request_id`.
pub fn log_asked(c: &Connection, task: &Task, request_id: &str, tool: &str, input: &Value, r: &Rule) -> Result<()> {
    insert(c, task, Some(request_id), tool, input, &r.tool, r.decision, "pending", None)
}

/// Log a call a never rule (`pattern`) turned away.
pub fn log_blocked(s: &Shared, task: &Task, tool: &str, input: &Value, pattern: &str) -> Result<()> {
    insert(&s.db(), task, None, tool, input, pattern, Decision::Never, "blocked", Some("rule"))?;
    emit(s, task);
    Ok(())
}

/// Log a call that rule `r` decided without asking (a never, or an ask that the mode denied).
pub fn log_decided(s: &Shared, task: &Task, tool: &str, input: &Value, r: &Rule, outcome: &str, by: &str) -> Result<()> {
    insert(&s.db(), task, None, tool, input, &r.tool, r.decision, outcome, Some(by))?;
    emit(s, task);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn insert(c: &Connection, task: &Task, request_id: Option<&str>, tool: &str, input: &Value, rule: &str, d: Decision, outcome: &str, by: Option<&str>) -> Result<()> {
    let at = now();
    let decided = (outcome != "pending").then_some(at.as_str());
    c.execute(
        "INSERT INTO approval_log (id,profile_id,task_id,request_id,tool_name,summary,rule,decision,outcome,answered_by,created_at,decided_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        params![new_id(), task.profile_id, task.id, request_id, tool, summarize(input), rule, d.name(), outcome, by, at, decided],
    )?;
    c.execute(
        "DELETE FROM approval_log WHERE profile_id=?1 AND id NOT IN (SELECT id FROM approval_log WHERE profile_id=?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2)",
        params![task.profile_id, KEEP],
    )?;
    Ok(())
}

/// Prompt `request_id` was answered (`outcome`: allowed, denied or expired) by `by`: its log entry
/// says so. Returns the task it's in, if it has one.
pub fn settle(s: &Shared, request_id: &str, outcome: &str, by: &str) -> Result<()> {
    let task_id: Option<String> = {
        let c = s.db();
        let n = c.execute(
            "UPDATE approval_log SET outcome=?2, answered_by=?3, decided_at=?4 WHERE request_id=?1 AND outcome='pending'",
            params![request_id, outcome, by, now()],
        )?;
        if n == 0 {
            return Ok(());
        }
        c.query_row("SELECT task_id FROM approval_log WHERE request_id=?1", [request_id], |r| r.get(0)).optional()?
    };
    if let Some(t) = task_id.and_then(|id| db::get_task(&s.db(), &id).ok().flatten()) {
        emit(s, &t);
    }
    Ok(())
}

/// The UI's action log changed for `task`'s profile.
fn emit(s: &Shared, task: &Task) {
    s.emit(json!({"type": "approval_log", "profile_id": task.profile_id, "task_id": task.id}));
}

/// A profile's action log, newest first.
pub fn list(c: &Connection, profile_id: &str, limit: i64) -> Result<Vec<Action>> {
    let mut st = c.prepare(
        "SELECT id,task_id,request_id,tool_name,summary,rule,decision,outcome,answered_by,created_at,decided_at FROM approval_log
         WHERE profile_id=?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2",
    )?;
    let rows = st.query_map(params![profile_id, limit.clamp(1, MAX_LISTED)], |r| {
        Ok(Action {
            id: r.get(0)?,
            task_id: r.get(1)?,
            request_id: r.get(2)?,
            tool_name: r.get(3)?,
            summary: r.get(4)?,
            rule: r.get(5)?,
            decision: r.get(6)?,
            outcome: r.get(7)?,
            answered_by: r.get(8)?,
            created_at: r.get(9)?,
            decided_at: r.get(10)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

#[cfg(test)]
mod tests;
