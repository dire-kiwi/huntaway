//! Codex agents. A thread whose config is for Codex (see db::AGENTS) runs `huntaway
//! codex-run` under ia-shim instead of `claude -p`. That adapter starts `codex app-server`,
//! speaks its JSON-RPC protocol (JSONL over stdio), and runs one turn: it starts or resumes the
//! thread, sends the prompt, answers approval requests by asking the board (the same
//! `permission_prompt` call the MCP helper makes for Claude), and exits once the turn ends.
//!
//! With `Spec::input`, its stdin takes the same stream-json input as Claude Code's (see
//! runner::steer): the prompt is the first user message, a message that arrives during the
//! turn is steered into it (`turn/steer`), one that arrives between turns starts the next turn,
//! and an `interrupt` control request interrupts the turn. It echoes each message back (as
//! `--replay-user-messages` does) once the model has taken it in, and exits when its input
//! ends with no turn going.
//!
//! It writes the app-server's notifications to stdout as they are (`out.jsonl`), and the server
//! turns them into thread messages shaped like Claude Code's stream-json (`handle_line`), so the
//! thread view shows both agents the same way. Like the rest of a run directory these lines are
//! a stable format: they're Codex's own protocol, which a newer server must keep reading.
//!
//! `codex.json` in the run directory holds what the runner decided for the run (see `Spec`);
//! the MCP servers come from the same `mcp.json` Claude gets, converted to Codex's config.

use std::collections::BTreeSet;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};

use crate::db::{self, Run};
use crate::runner::MCP_SERVER_NAME;
use crate::state::Shared;
use crate::util::{expand_tilde, path_str, truncate};

pub fn program() -> String {
    std::env::var("IA_CODEX_BIN").unwrap_or_else(|_| "codex".into())
}

/// What a run needs from the runner, saved as `codex.json` in the run directory.
#[derive(Serialize, Deserialize, Default, Debug, Clone)]
pub struct Spec {
    pub cwd: String,
    /// The Codex thread to resume (the task's session id).
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    pub approval_policy: String,
    pub approvals_reviewer: String,
    /// `read-only`, `workspace-write` or `danger-full-access`.
    pub sandbox: String,
    /// Codex's plan mode (collaboration mode `plan`).
    #[serde(default)]
    pub plan: bool,
    /// Compact the conversation instead of running a prompt.
    #[serde(default)]
    pub compact: bool,
    #[serde(default)]
    pub developer_instructions: String,
    /// Stdin is stream-json input (see the module docs), not just the prompt.
    #[serde(default)]
    pub input: bool,
    /// Writable on top of the working directory (e.g. a worktree's git directory).
    #[serde(default)]
    pub writable_roots: Vec<String>,
    /// With a `read-only` sandbox, paths to `write` besides the temp directories (a reviewer's
    /// build output and caches) and paths inside those to keep `read`, through a permission
    /// profile (see `REVIEW_PROFILE`). The most specific path wins.
    #[serde(default)]
    pub filesystem: BTreeMap<String, String>,
    /// Holds the project's skills, one directory each.
    #[serde(default)]
    pub skills_dir: Option<String>,
    /// MCP servers whose tools run without asking (the board's always does).
    #[serde(default)]
    pub approved_mcp_servers: Vec<String>,
    /// MCP tools the agent doesn't get, by server (e.g. a reviewer's gh tools that write).
    #[serde(default)]
    pub disabled_mcp_tools: HashMap<String, Vec<String>>,
    /// Codex's reviewer reviews the board's `wait` calls (auto mode), command included, so the
    /// board runs a wait's command without asking. A run from an older build pre-approved them.
    #[serde(default)]
    pub review_waits: bool,
    /// Revert the thread to before this turn first (a rewind's, see checkpoints::Rewind).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revert_before_turn: Option<String>,
}

/// How a permission mode runs under Codex: (approval policy, approvals reviewer, sandbox).
/// Reviewers get a read-only sandbox (they read and report) and run what fits in it unasked;
/// `Spec::filesystem` lets them build and test in it.
pub fn policy(mode: &str, review: bool) -> (&'static str, &'static str, &'static str) {
    match mode {
        "bypassPermissions" => ("never", "user", "danger-full-access"),
        _ if review => ("never", "user", "read-only"),
        "dontAsk" => ("never", "user", "workspace-write"),
        "acceptEdits" => ("on-request", "user", "workspace-write"),
        // Codex's own reviewer decides, like Claude's auto mode.
        "auto" => ("on-request", "auto_review", "workspace-write"),
        "plan" => ("untrusted", "user", "read-only"),
        _ => ("untrusted", "user", "workspace-write"),
    }
}

/// The permission profile of a read-only sandbox with `Spec::filesystem`: it reads everything and
/// writes only the temp directories and the paths given, so a reviewer can run the tests without
/// being able to change the work. (Codex's `workspace-write` always lets the working directory be
/// written.)
pub const REVIEW_PROFILE: &str = "huntaway-review";

/// The `thread/start` (and `thread/resume`) parameters for a run.
fn thread_params(spec: &Spec, cwd: &Path, servers: Map<String, Value>) -> Value {
    let mut config = json!({
        "mcp_servers": servers,
        // The plan tool, shown as a todo list.
        "tools.update_plan.enabled": true,
    });
    let profile = uses_profile(spec);
    if profile {
        // A profile replaces the sandbox settings, which mustn't be given alongside it.
        let mut fs = Map::new();
        fs.insert(":tmpdir".into(), json!("write"));
        fs.insert(":slash_tmp".into(), json!("write"));
        for (path, access) in &spec.filesystem {
            fs.insert(path.clone(), json!(access));
        }
        config["default_permissions"] = json!(REVIEW_PROFILE);
        config["permissions"] = json!({REVIEW_PROFILE: {"extends": ":read-only", "filesystem": fs, "network": {"enabled": true}}});
    } else {
        // Agents need the network (git push, gh, package managers), as Claude's do.
        config["sandbox_workspace_write"] = json!({"network_access": true});
        if !spec.writable_roots.is_empty() {
            config["sandbox_workspace_write"]["writable_roots"] = json!(spec.writable_roots);
        }
    }
    let mut params = json!({
        "cwd": crate::util::path_str(cwd),
        "approvalPolicy": spec.approval_policy,
        "approvalsReviewer": spec.approvals_reviewer,
        "config": config,
        "developerInstructions": spec.developer_instructions,
    });
    if !profile {
        params["sandbox"] = json!(spec.sandbox);
    }
    if let Some(m) = &spec.model {
        params["model"] = json!(m);
    }
    params
}

fn uses_profile(spec: &Spec) -> bool {
    spec.sandbox == "read-only" && !spec.filesystem.is_empty()
}

/// Whether `model` names a Claude model, so a Codex thread shouldn't inherit it from its
/// project, profile or host.
pub fn is_claude_model(model: &str) -> bool {
    let m = model.trim().to_ascii_lowercase();
    ["fable", "opus", "sonnet", "haiku", "default", "opusplan"].contains(&m.as_str()) || m.starts_with("claude")
}

// ---------- JSON-RPC client ----------

type Pending = Arc<std::sync::Mutex<HashMap<i64, oneshot::Sender<Result<Value>>>>>;

/// One `codex app-server` process. Messages are JSON lines without a `jsonrpc` field.
struct Rpc {
    child: Child,
    out: mpsc::UnboundedSender<String>,
    pending: Pending,
    next: AtomicI64,
    /// Notifications and requests from the server, in order.
    incoming: mpsc::UnboundedReceiver<Value>,
}

impl Rpc {
    fn start(codex_home: Option<&str>, cwd: &Path) -> Result<Self> {
        let mut cmd = Command::new(program());
        cmd.arg("app-server").current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).kill_on_drop(true);
        if let Some(home) = codex_home.filter(|h| !h.trim().is_empty()) {
            cmd.env("CODEX_HOME", expand_tilde(home));
        }
        let mut child = cmd.spawn().with_context(|| format!("failed to start {} app-server", program()))?;
        let mut stdin = child.stdin.take().context("no stdin")?;
        let stdout = child.stdout.take().context("no stdout")?;
        let (out, mut out_rx) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            while let Some(line) = out_rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err() || stdin.write_all(b"\n").await.is_err() {
                    break;
                }
                let _ = stdin.flush().await;
            }
        });
        let pending: Pending = Default::default();
        let (in_tx, incoming) = mpsc::unbounded_channel();
        let p = pending.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                if v.get("method").is_none() {
                    // A response to one of our requests.
                    let Some(id) = v["id"].as_i64() else { continue };
                    if let Some(tx) = p.lock().unwrap().remove(&id) {
                        let r = match v.get("error") {
                            Some(e) => Err(anyhow!("{}", e["message"].as_str().unwrap_or("request failed"))),
                            None => Ok(v["result"].clone()),
                        };
                        let _ = tx.send(r);
                    }
                } else if in_tx.send(v).is_err() {
                    break;
                }
            }
            // The process is gone: fail whatever is still waiting.
            p.lock().unwrap().clear();
        });
        Ok(Self { child, out, pending, next: AtomicI64::new(1), incoming })
    }

    fn sender(&self) -> Responder {
        Responder(self.out.clone())
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        self.out.send(json!({"id": id, "method": method, "params": params}).to_string()).map_err(|_| anyhow!("codex app-server exited"))?;
        rx.await.map_err(|_| anyhow!("codex app-server exited during {method}"))?.with_context(|| method.to_string())
    }

    fn notify(&self, method: &str) {
        let _ = self.out.send(json!({"method": method}).to_string());
    }

    /// The handshake every client starts with.
    async fn initialize(&self) -> Result<Value> {
        let info = json!({"name": "huntaway", "title": "Huntaway", "version": env!("CARGO_PKG_VERSION")});
        let r = self.request("initialize", json!({"clientInfo": info, "capabilities": {"experimentalApi": true}})).await?;
        self.notify("initialized");
        Ok(r)
    }
}

/// Answers the server's requests; cloneable into the tasks that wait on the board.
#[derive(Clone)]
struct Responder(mpsc::UnboundedSender<String>);

impl Responder {
    fn result(&self, id: &Value, result: Value) {
        let _ = self.0.send(json!({"id": id, "result": result}).to_string());
    }

    fn error(&self, id: &Value, message: &str) {
        let _ = self.0.send(json!({"id": id, "error": {"code": -32601, "message": message}}).to_string());
    }
}

// ---------- the adapter (`huntaway codex-run`) ----------

/// Notifications worth keeping in `out.jsonl`; the rest (output deltas, moderation, read
/// state…) are noise or too bulky.
const KEEP: &[&str] = &[
    "thread/started",
    "thread/status/changed",
    "thread/closed",
    "turn/started",
    "turn/completed",
    "turn/plan/updated",
    "item/started",
    "item/completed",
    "item/agentMessage/delta",
    "thread/compacted",
    "thread/tokenUsage/updated",
    "account/rateLimits/updated",
    "error",
    "warning",
    "model/rerouted",
    "mcpServer/startupStatus/updated",
];

/// Translate a Claude-style `mcpServers` entry into Codex's `mcp_servers` config.
fn mcp_server_config(name: &str, c: &Value, approved: bool, disabled: &[String], review_waits: bool) -> Option<Value> {
    let mut out = Map::new();
    match c["type"].as_str().unwrap_or("stdio") {
        "stdio" => {
            out.insert("command".into(), c.get("command")?.clone());
            for k in ["args", "env"] {
                if let Some(v) = c.get(k).filter(|v| !v.is_null()) {
                    out.insert(k.into(), v.clone());
                }
            }
        }
        "http" | "streamable-http" => {
            out.insert("url".into(), c.get("url")?.clone());
            if let Some(h) = c.get("headers").filter(|h| h.as_object().is_some_and(|o| !o.is_empty())) {
                out.insert("http_headers".into(), h.clone());
            }
        }
        other => {
            eprintln!("skipping MCP server {name}: Codex doesn't support {other} servers");
            return None;
        }
    }
    if name == MCP_SERVER_NAME {
        // send_to_task and friends can take a while (e.g. setting up a worktree), and wait
        // blocks for as long as it's asked to.
        out.insert("tool_timeout_sec".into(), json!(crate::wait::MAX_SECS + 300));
    } else if name == crate::gh_mcp::SERVER_NAME {
        // As can gh.
        out.insert("tool_timeout_sec".into(), json!(600));
    }
    if approved || name == MCP_SERVER_NAME {
        out.insert("default_tools_approval_mode".into(), json!("approve"));
    }
    if name == MCP_SERVER_NAME && review_waits {
        // Every wait goes to the reviewer, which sees its arguments: a wait's command runs as
        // the agent's own commands would (see tools.rs).
        out.insert("tools".into(), json!({"wait": {"approval_mode": "prompt"}}));
    }
    if !disabled.is_empty() {
        out.insert("disabled_tools".into(), json!(disabled));
    }
    Some(Value::Object(out))
}

/// `huntaway codex-run <run-dir>/codex.json`, with the prompt on stdin.
pub async fn run_adapter(spec_path: &str) -> Result<()> {
    let spec: Spec = serde_json::from_str(&std::fs::read_to_string(spec_path).context("reading codex.json")?)?;
    let dir = Path::new(spec_path).parent().context("codex.json has no directory")?;
    let mcp: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("mcp.json")).context("reading mcp.json")?)?;
    let board_env = &mcp["mcpServers"][MCP_SERVER_NAME]["env"];
    let env = |k: &str| board_env[k].as_str().map(String::from).with_context(|| format!("{k} missing from mcp.json"));
    let board = Arc::new(crate::mcp::Ctx::new(env("IA_URL")?, env("IA_TOKEN")?, env("IA_RUN_ID")?));
    let mut input = if spec.input { Some(read_input()) } else { None };
    let prompt = match &mut input {
        Some(rx) => match rx.recv().await {
            Some(Input::User { text, .. }) => text,
            _ => bail!("the run's input didn't start with the prompt"),
        },
        None => {
            let mut prompt = String::new();
            tokio::io::stdin().read_to_string(&mut prompt).await?;
            prompt
        }
    };

    let mut servers = Map::new();
    for (name, c) in mcp["mcpServers"].as_object().into_iter().flatten() {
        let disabled = spec.disabled_mcp_tools.get(name).map(Vec::as_slice).unwrap_or_default();
        if let Some(cfg) = mcp_server_config(name, c, spec.approved_mcp_servers.contains(name), disabled, spec.review_waits) {
            servers.insert(name.clone(), cfg);
        }
    }
    let cwd = expand_tilde(&spec.cwd);
    // CODEX_HOME comes from the shim's environment, if the config has its own.
    let mut rpc = Rpc::start(None, &cwd)?;
    rpc.initialize().await?;
    if let Some(skills) = &spec.skills_dir {
        if let Err(e) = rpc.request("skills/extraRoots/set", json!({"extraRoots": [skills]})).await {
            eprintln!("couldn't add the project's skills: {e:#}");
        }
    }

    let mut params = thread_params(&spec, &cwd, servers);
    let started = match &spec.thread_id {
        Some(id) => {
            params["threadId"] = json!(id);
            params["excludeTurns"] = json!(true);
            rpc.request("thread/resume", params).await?
        }
        None => rpc.request("thread/start", params).await?,
    };
    let thread_id = started["thread"]["id"].as_str().context("no thread id")?.to_string();
    if let (Some(turn), Some(_)) = (&spec.revert_before_turn, &spec.thread_id) {
        rpc.request("thread/revert", json!({"threadId": thread_id, "beforeTurnId": turn}))
            .await
            .context("couldn't take the conversation back to before the turn a rewind went back to")?;
    }
    // A Codex without permission profiles ignores ours: its turns are made read-only instead.
    let read_only = uses_profile(&spec) && started["activePermissionProfile"]["id"] != REVIEW_PROFILE;
    if read_only {
        eprintln!("codex didn't take the {REVIEW_PROFILE} permission profile, so the sandbox is read-only");
    }
    if spec.thread_id.is_none() {
        // So the session is known even if `thread/started` is missed.
        emit(&json!({"method": "thread/started", "params": {"thread": {"id": thread_id}}}));
    }

    let reply = rpc.sender();
    // Items seen so far, for approvals that only name theirs.
    let mut items: HashMap<String, Value> = HashMap::new();
    let mut children = ChildThreads { main: thread_id.clone(), ids: BTreeSet::new() };
    if spec.compact {
        rpc.request("thread/compact/start", json!({"threadId": thread_id})).await?;
        while let Some(msg) = rpc.incoming.recv().await {
            let method = msg["method"].as_str().unwrap_or("");
            if on_incoming(&board, &reply, &mut items, &mut children, &msg) {
                continue;
            }
            if (method == "turn/completed" || method == "thread/compacted") && own_thread(&msg["params"], Some(&thread_id)) {
                let _ = rpc.child.start_kill();
                return Ok(());
            }
        }
        bail!("codex app-server exited before compacting the conversation");
    }

    let model = spec.model.clone().or_else(|| started["model"].as_str().map(String::from));
    let turn = Turn { thread_id: &thread_id, spec: &spec, model, read_only };
    let mut turn_id = Some(turn.start(&rpc, &prompt).await?);
    // Steered into the turn, but the model hasn't acted since: (uuid, text).
    let mut steered: Vec<(String, String)> = Vec::new();
    let mut input_open = input.is_some();
    loop {
        tokio::select! {
            msg = rpc.incoming.recv() => {
                let Some(msg) = msg else {
                    let status = rpc.child.try_wait().ok().flatten();
                    bail!("codex app-server exited before the turn ended{}", status.map(|s| format!(" ({s})")).unwrap_or_default());
                };
                let method = msg["method"].as_str().unwrap_or("");
                // The model has moved on, so it has seen what was steered in before.
                if method == "item/started" && own_thread(&msg["params"], Some(&thread_id)) && msg["params"]["item"]["type"] != "userMessage" {
                    steered.drain(..).for_each(|(id, text)| replay(&id, &text));
                }
                if on_incoming(&board, &reply, &mut items, &mut children, &msg) {
                    continue;
                }
                if method == "turn/completed" && own_thread(&msg["params"], Some(&thread_id))
                    && turn_id.is_some() && msg["params"]["turn"]["id"].as_str() == turn_id.as_deref() {
                    turn_id = None;
                    // Steered in too late to be acted on (or the turn was interrupted): they start
                    // the next turn, as Claude Code does with messages still queued.
                    if !steered.is_empty() {
                        let (ids, texts): (Vec<String>, Vec<String>) = steered.drain(..).unzip();
                        turn_id = Some(turn.start(&rpc, &texts.join("\n\n")).await?);
                        ids.iter().zip(&texts).for_each(|(id, text)| replay(id, text));
                    } else if !input_open {
                        break;
                    }
                }
            }
            line = async { input.as_mut().unwrap().recv().await }, if input_open => match line {
                None => {
                    input_open = false;
                    if turn_id.is_none() {
                        break;
                    }
                }
                Some(Input::User { id, text }) => match &turn_id {
                    Some(t) => {
                        let params = json!({
                            "threadId": thread_id,
                            "expectedTurnId": t,
                            "clientUserMessageId": id,
                            "input": [{"type": "text", "text": text, "text_elements": []}],
                        });
                        match rpc.request("turn/steer", params).await {
                            Ok(_) => steered.push((id, text)),
                            // The turn is over already: this starts the next one, below.
                            Err(e) => {
                                eprintln!("steering failed, sending it as the next turn: {e:#}");
                                steered.push((id, text));
                            }
                        }
                    }
                    None => {
                        turn_id = Some(turn.start(&rpc, &text).await?);
                        replay(&id, &text);
                    }
                },
                Some(Input::Interrupt) => {
                    if let Some(t) = &turn_id {
                        if let Err(e) = rpc.request("turn/interrupt", json!({"threadId": thread_id, "turnId": t})).await {
                            eprintln!("interrupting the turn failed: {e:#}");
                        }
                    }
                }
            },
        }
    }
    let _ = rpc.child.start_kill();
    Ok(())
}

/// Starts the run's turns.
struct Turn<'a> {
    thread_id: &'a str,
    spec: &'a Spec,
    model: Option<String>,
    /// Override the thread's sandbox with a read-only one.
    read_only: bool,
}

impl Turn<'_> {
    /// Start a turn with `text` as its input. Returns its id.
    async fn start(&self, rpc: &Rpc, text: &str) -> Result<String> {
        let mut turn = json!({
            "threadId": self.thread_id,
            "input": [{"type": "text", "text": text, "text_elements": []}],
            "summary": "detailed",
        });
        if let Some(e) = &self.spec.effort {
            turn["effort"] = json!(e);
        }
        if self.read_only {
            turn["sandboxPolicy"] = json!({"type": "readOnly"});
        }
        if let (true, Some(model)) = (self.spec.plan, &self.model) {
            turn["collaborationMode"] = json!({"mode": "plan", "settings": {"model": model, "reasoning_effort": self.spec.effort}});
        }
        let r = rpc.request("turn/start", turn).await?;
        r["turn"]["id"].as_str().map(String::from).context("turn/start returned no turn id")
    }
}

/// Handle a notification or request from the app-server: answer requests (approvals) and write
/// the notifications worth keeping to stdout. Returns true for requests.
fn on_incoming(board: &Arc<crate::mcp::Ctx>, reply: &Responder, items: &mut HashMap<String, Value>, children: &mut ChildThreads, msg: &Value) -> bool {
    children.observe(msg);
    let method = msg["method"].as_str().unwrap_or("");
    if msg.get("id").is_some() {
        let item = msg["params"]["itemId"].as_str().and_then(|id| items.get(id)).cloned();
        tokio::spawn(answer(board.clone(), reply.clone(), msg.clone(), item));
        return true;
    }
    if method == "item/started" {
        if let Some(id) = msg["params"]["item"]["id"].as_str() {
            items.insert(id.to_string(), msg["params"]["item"].clone());
        }
    }
    if KEEP.contains(&method) {
        emit(msg);
    }
    false
}

/// Killing the app-server stops its children too, but it can't report their closure after it
/// exits. Keep that outcome in the transcript so old children stay stopped on the next run.
struct ChildThreads {
    main: String,
    ids: BTreeSet<String>,
}

impl ChildThreads {
    fn observe(&mut self, msg: &Value) {
        let p = &msg["params"];
        let item = &p["item"];
        for id in [p["threadId"].as_str(), p["thread"]["id"].as_str(), item["agentThreadId"].as_str()].into_iter().flatten()
            .chain(item["receiverThreadIds"].as_array().into_iter().flatten().filter_map(Value::as_str)) {
            if id != self.main {
                self.ids.insert(id.to_string());
            }
        }
        if msg["method"] == "thread/closed" {
            if let Some(id) = p["threadId"].as_str() {
                self.ids.remove(id);
            }
        }
    }
}

impl Drop for ChildThreads {
    fn drop(&mut self) {
        for id in &self.ids {
            emit(&json!({"method": "thread/closed", "params": {"threadId": id}}));
        }
    }
}

/// A line of the adapter's stream-json input.
enum Input {
    User { id: String, text: String },
    Interrupt,
}

/// Read stdin's stream-json lines until it ends.
fn read_input() -> mpsc::UnboundedReceiver<Input> {
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        let mut lines = BufReader::new(tokio::io::stdin()).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            let input = match v["type"].as_str() {
                Some("user") => Input::User { id: v["uuid"].as_str().unwrap_or_default().to_string(), text: user_text(&v["message"]["content"]) },
                Some("control_request") if v["request"]["subtype"] == "interrupt" => Input::Interrupt,
                _ => continue,
            };
            if tx.send(input).is_err() {
                break;
            }
        }
    });
    rx
}

/// A stream-json user message's text: a string, or text blocks.
fn user_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n\n"),
        _ => String::new(),
    }
}

/// Echo a message back once the model has taken it in, shaped like Claude Code's
/// `--replay-user-messages`.
fn replay(id: &str, text: &str) {
    emit(&json!({"type": "user", "isReplay": true, "uuid": id, "message": {"role": "user", "content": text}}));
}

fn emit(v: &Value) {
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

/// `/usr/bin/bash -lc 'ls -la'` → `ls -la`: the command as the agent wrote it.
pub fn display_command(cmd: &str) -> String {
    for flag in [" -lc ", " -c "] {
        let Some((shell, rest)) = cmd.split_once(flag) else { continue };
        if shell.ends_with("sh") && !shell.contains(' ') {
            if let Some(script) = shell_word(rest.trim()) {
                return script;
            }
        }
    }
    cmd.to_string()
}

/// `s` unquoted, if it is exactly one shell word (e.g. `'a b'"c"\'d`).
fn shell_word(s: &str) -> Option<String> {
    let mut out = String::new();
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        match c {
            '\'' => loop {
                match chars.next()? {
                    '\'' => break,
                    c => out.push(c),
                }
            },
            '"' => loop {
                match chars.next()? {
                    '"' => break,
                    '\\' => match chars.next()? {
                        n @ ('"' | '\\' | '$' | '`') => out.push(n),
                        '\n' => {}
                        n => {
                            out.push('\\');
                            out.push(n);
                        }
                    },
                    c => out.push(c),
                }
            },
            '\\' => out.push(chars.next()?),
            c if c.is_whitespace() => return None,
            c => out.push(c),
        }
    }
    Some(out)
}

fn file_changes(item: Option<&Value>) -> Value {
    let changes = item.and_then(|i| i["changes"].as_array()).cloned().unwrap_or_default();
    json!(changes
        .iter()
        .map(|c| json!({"path": c["path"], "kind": c["kind"]["type"], "move_path": c["kind"]["move_path"], "diff": c["diff"]}))
        .collect::<Vec<_>>())
}

/// Answer one of the app-server's requests: approvals go to the board like Claude's
/// permission prompts, so the user approves them in the thread.
async fn answer(board: Arc<crate::mcp::Ctx>, reply: Responder, msg: Value, item: Option<Value>) {
    let id = &msg["id"];
    let p = &msg["params"];
    let ask = |tool: &str, input: Value| {
        let board = board.clone();
        let args = json!({"tool_name": tool, "input": input, "tool_use_id": p["itemId"]});
        async move {
            match board.call("permission_prompt", &args).await {
                Ok(v) => v["behavior"] == "allow",
                Err(e) => {
                    eprintln!("permission prompt failed: {e:#}");
                    false
                }
            }
        }
    };
    let decision = |ok: bool| json!({"decision": if ok { "accept" } else { "decline" }});
    match msg["method"].as_str().unwrap_or("") {
        "item/commandExecution/requestApproval" => {
            let command = p["command"].as_str().map(display_command).unwrap_or_default();
            let mut input = json!({"command": command, "cwd": p["cwd"]});
            if let Some(r) = p["reason"].as_str() {
                input["description"] = json!(r);
            }
            let ok = ask("Bash", input).await;
            reply.result(id, decision(ok));
        }
        "item/fileChange/requestApproval" => {
            let mut input = json!({"changes": file_changes(item.as_ref())});
            if let Some(r) = p["reason"].as_str() {
                input["reason"] = json!(r);
            }
            if let Some(r) = p["grantRoot"].as_str() {
                input["grant_root"] = json!(r);
            }
            let ok = ask("ApplyPatch", input).await;
            reply.result(id, decision(ok));
        }
        "item/permissions/requestApproval" => {
            let ok = ask("Permissions", json!({"permissions": p["permissions"], "reason": p["reason"], "cwd": p["cwd"]})).await;
            let granted = if ok { p["permissions"].clone() } else { json!({}) };
            reply.result(id, json!({"permissions": granted, "scope": "turn"}));
        }
        "mcpServer/elicitation/request" => {
            // Only forms that need nothing filled in (e.g. "allow this tool call?") can be accepted.
            let fields = p["requestedSchema"]["properties"].as_object().map(|o| o.len()).unwrap_or(0);
            let server = p["serverName"].as_str().unwrap_or("mcp");
            let message = p["message"].as_str().unwrap_or("");
            // "Allow the x MCP server to run tool "y"?" asks about a tool call.
            let tool = message.split_once("tool \"").and_then(|(_, r)| r.split_once('"')).map(|(t, _)| t).unwrap_or("elicitation");
            let board = crate::runner::is_board_server(server);
            let params = &p["_meta"]["tool_params"];
            let command = params["command"].as_str().map(str::trim).filter(|c| !c.is_empty());
            if p["mode"] == "url" || fields > 0 {
                reply.result(id, json!({"action": "decline"}));
            } else if board && tool == "wait" && (command.is_some() || !params.is_object()) {
                // A wait Codex's reviewer didn't take (see Spec::review_waits) is asked about as
                // the command it runs, as the board would (or, without its arguments, as itself).
                let ok = match command {
                    Some(command) => {
                        let reason = params["reason"].as_str().map(|r| format!(": {r}")).unwrap_or_default();
                        ask("Bash", json!({"command": command, "description": format!("Run while waiting{reason}")})).await
                    }
                    None => ask(&format!("{}__wait", crate::agent_tools::tool_prefix(server)), json!({"message": message})).await,
                };
                reply.result(id, json!({"action": if ok { "accept" } else { "decline" }, "content": if ok { json!({}) } else { Value::Null }}));
            } else if board {
                // The board's own tools never need approval.
                reply.result(id, json!({"action": "accept", "content": {}}));
            } else {
                let tool = format!("{}__{tool}", crate::agent_tools::tool_prefix(server));
                let ok = ask(&tool, json!({"message": message})).await;
                reply.result(id, json!({"action": if ok { "accept" } else { "decline" }, "content": if ok { json!({}) } else { Value::Null }}));
            }
        }
        // Its questions (in plan mode) are asked in the thread as Claude's AskUserQuestion is, and
        // answered with the user's answers by question id. Unanswered, the agent carries on with its own judgement.
        "item/tool/requestUserInput" => {
            let questions: Vec<Value> = p["questions"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|q| {
                    json!({
                        "id": q["id"], "header": q["header"], "question": q["question"], "multiSelect": false,
                        "options": q["options"].as_array().cloned().unwrap_or_default(),
                        "isOther": q["isOther"], "isSecret": q["isSecret"],
                    })
                })
                .collect();
            let args = json!({"tool_name": crate::permissions::CODEX_QUESTIONS, "input": {"questions": questions}, "tool_use_id": p["itemId"]});
            let answers = match board.call("permission_prompt", &args).await {
                Ok(v) if v["behavior"] == "allow" => v["updatedInput"]["answers"].clone(),
                Ok(_) => json!({}),
                Err(e) => {
                    eprintln!("asking the user failed: {e:#}");
                    json!({})
                }
            };
            reply.result(id, json!({"answers": if answers.is_object() { answers } else { json!({}) }}));
        }
        m => reply.error(id, &format!("Method not supported by Huntaway: {m}")),
    }
}

// ---------- one-off queries (models, usage) ----------

/// A short-lived title query using this config's model and login, without a task session.
pub async fn task_title(codex_home: &str, cwd: &Path, instructions: &str, input: &str) -> Result<String> {
    let mut rpc = Rpc::start(Some(codex_home), cwd)?;
    let work = async {
        rpc.initialize().await?;
        // Config overrides merge maps, so an empty map alone would keep the user's servers.
        let config = rpc.request("config/read", json!({"includeLayers": false, "cwd": crate::util::path_str(cwd)})).await?;
        let servers: Map<String, Value> = config["config"]["mcp_servers"].as_object().into_iter().flatten()
            .map(|(name, _)| (name.clone(), json!({"enabled": false}))).collect();
        let started = rpc.request("thread/start", json!({
            "cwd": crate::util::path_str(cwd), "ephemeral": true,
            "approvalPolicy": "never", "sandbox": "read-only",
            "baseInstructions": instructions, "developerInstructions": "",
            "config": {"mcp_servers": servers, "project_doc_max_bytes": 0, "web_search": "disabled",
                "features.shell_tool": false, "features.apply_patch_freeform": false, "features.multi_agent": false, "features.apps": false},
        })).await?;
        let thread = started["thread"]["id"].as_str().context("no title thread id")?;
        rpc.request("turn/start", json!({"threadId": thread, "effort": "low",
            "input": [{"type": "text", "text": input, "text_elements": []}]})).await?;
        let mut title = String::new();
        while let Some(msg) = rpc.incoming.recv().await {
            if let Some(id) = msg.get("id") {
                // A title never needs tools or approvals.
                rpc.sender().error(id, "Tools are unavailable while writing a task title");
                continue;
            }
            let p = &msg["params"];
            if p["threadId"].as_str() != Some(thread) { continue }
            match msg["method"].as_str() {
                Some("item/completed") if p["item"]["type"] == "agentMessage" => {
                    title = p["item"]["text"].as_str().unwrap_or("").to_string();
                }
                Some("turn/completed") => {
                    if p["turn"]["status"] != "completed" {
                        bail!("codex title turn failed: {}", p["turn"]);
                    }
                    return Ok(title);
                }
                _ => {}
            }
        }
        bail!("codex app-server exited before writing a title")
    };
    tokio::time::timeout(Duration::from_secs(60), work).await.context("codex title timed out")?
}

/// Run a few requests against a short-lived app-server for the config at `codex_home`.
async fn query(codex_home: &str, requests: &[(&str, Value)]) -> Result<Vec<Value>> {
    let rpc = Rpc::start(Some(codex_home), &std::env::temp_dir())?;
    let work = async {
        rpc.initialize().await?;
        let mut out = Vec::new();
        for (m, p) in requests {
            out.push(rpc.request(m, p.clone()).await?);
        }
        Ok::<_, anyhow::Error>(out)
    };
    tokio::time::timeout(Duration::from_secs(20), work).await.map_err(|_| anyhow!("codex app-server didn't answer"))?
}

#[derive(Serialize, Clone, Debug)]
pub struct Model {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub efforts: Vec<String>,
    pub default_effort: Option<String>,
}

static MODELS: std::sync::Mutex<Option<HashMap<String, (Instant, Vec<Model>)>>> = std::sync::Mutex::new(None);

/// The models a Codex config can use (cached for 10 minutes).
pub async fn models(codex_home: &str) -> Result<Vec<Model>> {
    if let Some((at, m)) = MODELS.lock().unwrap().get_or_insert_default().get(codex_home) {
        if at.elapsed() < Duration::from_secs(600) {
            return Ok(m.clone());
        }
    }
    let r = query(codex_home, &[("model/list", json!({}))]).await?;
    let list: Vec<Model> = r[0]["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["hidden"] != true)
        .map(|m| Model {
            id: m["model"].as_str().or(m["id"].as_str()).unwrap_or("").to_string(),
            name: m["displayName"].as_str().or(m["model"].as_str()).unwrap_or("").to_string(),
            is_default: m["isDefault"] == true,
            efforts: m["supportedReasoningEfforts"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|e| e["reasoningEffort"].as_str().map(String::from))
                .collect(),
            default_effort: m["defaultReasoningEffort"].as_str().map(String::from),
        })
        .filter(|m| !m.id.is_empty())
        .collect();
    MODELS.lock().unwrap().get_or_insert_default().insert(codex_home.to_string(), (Instant::now(), list.clone()));
    Ok(list)
}

/// Lists `models` for a Codex config, as if its app-server had (for tests).
#[cfg(test)]
pub fn set_test_models(codex_home: &str, models: Vec<Model>) {
    MODELS.lock().unwrap().get_or_insert_default().insert(codex_home.to_string(), (Instant::now(), models));
}

type SkillCache = HashMap<(String, Option<PathBuf>), (Instant, Vec<crate::agent_tools::TaskSkill>)>;
static SKILLS: std::sync::Mutex<Option<SkillCache>> = std::sync::Mutex::new(None);

/// The skills a Codex config has in a working directory, for the composer (cached for a minute).
pub async fn skills(codex_home: &str, cwd: Option<&Path>) -> Result<Vec<crate::agent_tools::TaskSkill>> {
    let key = (codex_home.to_string(), cwd.map(Path::to_path_buf));
    if let Some((at, s)) = SKILLS.lock().unwrap().get_or_insert_default().get(&key) {
        if at.elapsed() < Duration::from_secs(60) {
            return Ok(s.clone());
        }
    }
    let cwds: Vec<String> = cwd.map(path_str).into_iter().collect();
    let r = query(codex_home, &[("skills/list", json!({"cwds": cwds}))]).await?;
    let list: Vec<_> = r[0]["data"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|e| e["skills"].as_array().into_iter().flatten())
        .filter(|s| s["enabled"] != false)
        .filter_map(|s| {
            let description = s["shortDescription"].as_str().filter(|d| !d.is_empty()).or(s["description"].as_str()).unwrap_or("");
            Some(crate::agent_tools::TaskSkill { name: s["name"].as_str()?.to_string(), description: description.to_string() })
        })
        .collect();
    SKILLS.lock().unwrap().get_or_insert_default().insert(key, (Instant::now(), list.clone()));
    Ok(list)
}

/// The account's plan and rate limits, for the usage page.
pub async fn rate_limits(codex_home: &str) -> Result<(Option<String>, Vec<crate::usage::Limit>), String> {
    let r = query(codex_home, &[("account/rateLimits/read", Value::Null)]).await.map_err(|e| format!("{e:#}"))?;
    let rl = &r[0]["rateLimits"];
    Ok((rl["planType"].as_str().map(String::from), limits(rl)))
}

/// Codex's windows: `primary` is the session (5-hour) one, `secondary` the weekly one.
pub fn limits(rl: &Value) -> Vec<crate::usage::Limit> {
    let mut out = Vec::new();
    for (key, id, label) in [("primary", "session", "Session"), ("secondary", "weekly", "Weekly")] {
        let w = &rl[key];
        let Some(used) = w["usedPercent"].as_f64() else { continue };
        let resets_at = w["resetsAt"].as_i64().and_then(|t| chrono::DateTime::from_timestamp(t, 0)).map(|t| t.to_rfc3339());
        out.push(crate::usage::Limit { id: id.into(), label: label.into(), percent: used, resets_at });
    }
    out
}

// ---------- output → thread messages ----------

fn assistant(content: Value) -> Value {
    json!({"type": "assistant", "message": {"role": "assistant", "content": content}, "parent_tool_use_id": null})
}

fn tool_result(id: &str, content: String, is_error: bool) -> Value {
    json!({
        "type": "user",
        "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": id, "content": truncate(&content, 30_000), "is_error": is_error}]},
        "parent_tool_use_id": null,
    })
}

/// A child keeps the same row across spawn, wait, follow-up and resumed runs. Its messages can
/// arrive before the spawn call returns, so use its thread id rather than the spawn's item id.
fn subagent_id(thread_id: &str) -> String {
    format!("codex-agent-{thread_id}")
}

fn own_thread(params: &Value, session: Option<&str>) -> bool {
    params["threadId"].as_str().is_none_or(|id| session.is_some_and(|s| s == id))
}

fn thread_message(state: &Shared, task_id: &str, parent: Option<&str>, mut message: Value) -> Result<()> {
    message["parent_tool_use_id"] = json!(parent);
    state.add_message(task_id, "claude", message)?;
    Ok(())
}

fn subagent_started(state: &Shared, task_id: &str, session: Option<&str>, thread: &str, sender: Option<&str>, meta: Value) -> Result<()> {
    if Some(thread) == session {
        return Ok(());
    }
    let id = subagent_id(thread);
    let exists: bool = state.db().query_row(
        "SELECT EXISTS(SELECT 1 FROM messages WHERE task_id=?1 AND kind='claude'
         AND json_extract(data,'$.type')='assistant' AND json_extract(data,'$.message.content[0].id')=?2)",
        rusqlite::params![task_id, id], |r| r.get(0),
    )?;
    let parent = sender.filter(|s| Some(*s) != session).map(subagent_id);
    let prompt = meta["prompt"].as_str().unwrap_or("");
    let description = truncate(if prompt.is_empty() { meta["description"].as_str().unwrap_or("") } else { prompt }, 200);
    if !exists {
        let input = json!({"description": description, "prompt": prompt, "model": meta["model"], "subagent_type": meta["subagent_type"], "run_in_background": true});
        thread_message(state, task_id, parent.as_deref(), assistant(json!([{"type": "tool_use", "id": id, "name": "Agent", "input": input}])))?;
    }
    // Metadata can arrive after the row (thread/started and the spawn's completion can race).
    let mut started = json!({"type": "system", "subtype": "task_started", "tool_use_id": id, "task_id": thread,
        "prompt": prompt, "description": description, "model": meta["model"], "subagent_type": meta["subagent_type"], "is_backgrounded": true});
    if sender.is_some() {
        started["parent_tool_use_id"] = json!(parent);
    }
    state.add_message(task_id, "claude", started)?;
    Ok(())
}

fn subagent_status(state: &Shared, run: &Run, thread: &str, status: &str, summary: Option<&str>) -> Result<()> {
    let message = if status == "running" {
        json!({"type": "system", "subtype": "task_updated", "tool_use_id": subagent_id(thread), "patch": {"status": status}})
    } else {
        json!({"type": "system", "subtype": "task_notification", "tool_use_id": subagent_id(thread), "status": status,
            "summary": summary.map(|s| truncate(s, 30_000))})
    };
    let message = state.add_message(&run.task_id, "claude", message)?;
    crate::wait::subagent_finished(state, run, &message.data)?;
    Ok(())
}

/// The older collab tool items and newer hosted subAgentActivity items describe the same
/// children. Normalize both to the lifecycle used by Claude's Agent/Task calls.
fn subagent_item(state: &Shared, run: &Run, session: Option<&str>, params: &Value) -> Result<()> {
    let task_id = run.task_id.as_str();
    let item = &params["item"];
    let sender = item["senderThreadId"].as_str().or_else(|| params["threadId"].as_str());
    if item["type"] == "subAgentActivity" {
        let Some(thread) = item["agentThreadId"].as_str().filter(|id| Some(*id) != session) else { return Ok(()) };
        if item["kind"] == "started" {
            subagent_started(state, task_id, session, thread, sender, json!({"model": item["model"], "description": item["agentPath"]}))?;
        }
        let status = match item["kind"].as_str() {
            Some("started") => "running",
            Some("completed") => "completed",
            Some("interrupted") => "stopped",
            _ => return Ok(()),
        };
        return subagent_status(state, run, thread, status, None);
    }
    if item["type"] != "collabAgentToolCall" {
        return Ok(());
    }
    let tool = item["tool"].as_str().unwrap_or("");
    for thread in item["receiverThreadIds"].as_array().into_iter().flatten().filter_map(Value::as_str).filter(|id| Some(*id) != session) {
        if tool == "spawnAgent" && item["status"] != "failed" {
            subagent_started(state, task_id, session, thread, sender, json!({"prompt": item["prompt"], "model": item["model"]}))?;
        }
        if item["status"] != "failed" {
            let status = match tool {
                "resumeAgent" | "sendInput" | "followupTask" => Some("running"),
                "closeAgent" | "interruptAgent" => Some("stopped"),
                _ => None,
            };
            if let Some(status) = status {
                subagent_status(state, run, thread, status, None)?;
            }
        }
    }
    for (thread, status) in item["agentsStates"].as_object().into_iter().flatten() {
        if Some(thread.as_str()) == session {
            continue;
        }
        let normalized = match status["status"].as_str() {
            Some("pendingInit" | "running") => "running",
            Some("completed") => "completed",
            Some("errored" | "notFound") => "failed",
            Some("shutdown" | "interrupted") => "stopped",
            _ => continue,
        };
        subagent_status(state, run, thread, normalized, status["message"].as_str())?;
    }
    Ok(())
}

/// The tool call an item shows as: (name, input). None for items that aren't tool calls.
fn tool_use(item: &Value) -> Option<(String, Value)> {
    Some(match item["type"].as_str()? {
        "commandExecution" => {
            ("Bash".into(), json!({"command": display_command(item["command"].as_str().unwrap_or("")), "cwd": item["cwd"]}))
        }
        "fileChange" => ("ApplyPatch".into(), json!({"changes": file_changes(Some(item))})),
        "mcpToolCall" => {
            let name = format!("{}__{}", crate::agent_tools::tool_prefix(item["server"].as_str().unwrap_or("")), item["tool"].as_str().unwrap_or(""));
            (name, item["arguments"].clone())
        }
        "dynamicToolCall" => (item["tool"].as_str().unwrap_or("tool").to_string(), item["arguments"].clone()),
        "webSearch" => {
            let url = item["action"]["url"].as_str();
            match url {
                Some(u) => ("WebFetch".into(), json!({"url": u})),
                None => ("WebSearch".into(), json!({"query": item["query"]})),
            }
        }
        "imageView" => ("Read".into(), json!({"file_path": item["path"]})),
        // Spawning succeeds before the child finishes. Its row is created from the child's
        // thread, not from this short-lived tool call; other collab calls aren't new agents.
        "collabAgentToolCall" if item["tool"] == "spawnAgent" && item["status"] != "failed" => return None,
        "collabAgentToolCall" => (item["tool"].as_str().unwrap_or("collab").into(), json!({"prompt": item["prompt"], "receiver_thread_ids": item["receiverThreadIds"]})),
        _ => return None,
    })
}

/// Items whose call is shown when they start; the others only once they're done.
fn shown_at_start(kind: &str) -> bool {
    matches!(kind, "commandExecution" | "fileChange" | "mcpToolCall" | "dynamicToolCall" | "collabAgentToolCall")
}

/// What a finished tool item returned: (output, is_error).
fn tool_output(item: &Value) -> (String, bool) {
    let status = item["status"].as_str().unwrap_or("completed");
    match item["type"].as_str().unwrap_or("") {
        "commandExecution" => {
            let mut out = item["aggregatedOutput"].as_str().unwrap_or("").to_string();
            let code = item["exitCode"].as_i64();
            if status == "declined" {
                return ("The command was declined.".into(), true);
            }
            if let Some(c) = code.filter(|c| *c != 0) {
                out.push_str(&format!("{}(exit code {c})", if out.is_empty() || out.ends_with('\n') { "" } else { "\n" }));
            }
            (out, status == "failed" || code.is_some_and(|c| c != 0))
        }
        "fileChange" => match status {
            "declined" => ("The change was declined.".into(), true),
            "failed" => ("The change couldn't be applied.".into(), true),
            _ => ("Applied.".into(), false),
        },
        "mcpToolCall" => {
            if let Some(e) = item["error"]["message"].as_str() {
                return (e.to_string(), true);
            }
            let text: Vec<String> = item["result"]["content"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|c| match c["text"].as_str() {
                    Some(t) => t.to_string(),
                    None => format!("[{}]", c["type"].as_str().unwrap_or("content")),
                })
                .collect();
            (text.join("\n"), status == "failed")
        }
        "dynamicToolCall" => {
            let text: Vec<String> =
                item["contentItems"].as_array().into_iter().flatten().filter_map(|c| c["text"].as_str().map(String::from)).collect();
            (text.join("\n"), item["success"] == false || status == "failed")
        }
        "webSearch" => {
            let n = item["results"].as_array().map(|r| r.len());
            (n.map(|n| format!("{n} results")).unwrap_or_default(), false)
        }
        "collabAgentToolCall" => (serde_json::to_string_pretty(&item["agentsStates"]).unwrap_or_default(), status == "failed"),
        _ => (String::new(), status == "failed"),
    }
}

/// Apply one line of a Codex run's output (an app-server notification).
pub fn handle_line(state: &Shared, run: &Run, v: &Value) -> Result<()> {
    let task_id = run.task_id.as_str();
    let p = &v["params"];
    let session = db::get_task(&state.db(), task_id)?.and_then(|t| t.session_id);
    let own = own_thread(p, session.as_deref());
    let parent = p["threadId"].as_str().filter(|_| !own).map(subagent_id);
    match v["method"].as_str().unwrap_or("") {
        "thread/started" => {
            let thread = &p["thread"];
            if let Some(id) = thread["id"].as_str() {
                // v2 uses subAgent; older notifications used subagent. Normalize both before
                // extracting a spawned thread's parent or excluding an internal subagent.
                let subagent = thread["source"].get("subAgent").or_else(|| thread["source"].get("subagent"));
                let source = &subagent.unwrap_or(&Value::Null)["thread_spawn"];
                let sender = thread["parentThreadId"].as_str().or_else(|| source["parent_thread_id"].as_str());
                if sender.is_some() {
                    let role = thread["agentRole"].as_str().or_else(|| source["agent_role"].as_str());
                    subagent_started(state, task_id, session.as_deref(), id, sender,
                        json!({"prompt": thread["preview"], "description": thread["agentNickname"], "subagent_type": role}))?;
                } else if subagent.is_none() && session.as_deref() != Some(id) {
                    state.update_task(task_id, &[("session_id", json!(id))])?;
                }
            }
        }
        "turn/started" if !own => {
            if let Some(thread) = p["threadId"].as_str() {
                subagent_status(state, run, thread, "running", None)?;
            }
        }
        "turn/started" => {
            // Where a rewind to before this turn takes the thread back to (see checkpoints::Rewind).
            if let Some(turn) = p["turn"]["id"].as_str() {
                state.db().execute("UPDATE runs SET agent_at=?1 WHERE id=?2", rusqlite::params![turn, run.id])?;
            }
            state.emit(json!({"type": "delta_reset", "task_id": task_id}));
        }
        "item/agentMessage/delta" if own => {
            if let Some(t) = p["delta"].as_str() {
                state.emit(json!({"type": "delta", "task_id": task_id, "text": t}));
            }
        }
        "item/started" => {
            let item = &p["item"];
            let kind = item["type"].as_str().unwrap_or("");
            // A tool call of its own thread means it's working again (see wait.rs). Hosted
            // subAgentActivity items are notifications, not the parent calling a tool.
            if own && (kind == "collabAgentToolCall"
                || tool_use(item).is_some_and(|(name, _)| !crate::wait::is_wait_tool(&name))) {
                crate::wait::resumed(state, task_id, &run.id);
            }
            if kind == "agentMessage" && own {
                state.emit(json!({"type": "delta_reset", "task_id": task_id}));
            } else if shown_at_start(kind) && !(kind == "collabAgentToolCall" && item["tool"] == "spawnAgent") {
                if let (Some(id), Some((name, input))) = (item["id"].as_str(), tool_use(item)) {
                    thread_message(state, task_id, parent.as_deref(), assistant(json!([{"type": "tool_use", "id": id, "name": name, "input": input}])))?;
                }
            }
        }
        "item/completed" => {
            let item = &p["item"];
            let kind = item["type"].as_str().unwrap_or("");
            let id = item["id"].as_str().unwrap_or("");
            subagent_item(state, run, session.as_deref(), p)?;
            match kind {
                "agentMessage" | "plan" => {
                    if own {
                        state.emit(json!({"type": "delta_reset", "task_id": task_id}));
                    }
                    if let Some(text) = item["text"].as_str().filter(|t| !t.trim().is_empty()) {
                        thread_message(state, task_id, parent.as_deref(), assistant(json!([{"type": "text", "text": text}])))?;
                    }
                }
                "reasoning" => {
                    let parts = |k: &str| -> Vec<String> { item[k].as_array().into_iter().flatten().filter_map(|s| s.as_str().map(String::from)).collect() };
                    let mut text = parts("summary");
                    if text.is_empty() {
                        text = parts("content");
                    }
                    let text = text.join("\n\n");
                    if !text.trim().is_empty() {
                        thread_message(state, task_id, parent.as_deref(), assistant(json!([{"type": "thinking", "thinking": text}])))?;
                    }
                }
                "contextCompaction" => {
                    thread_message(state, task_id, parent.as_deref(), json!({"type": "system", "subtype": "compact_boundary", "compact_metadata": {"trigger": if run.kind == "compact" { "manual" } else { "auto" }}}))?;
                }
                _ => {
                    let Some((name, input)) = tool_use(item) else { return Ok(()) };
                    if !shown_at_start(kind) || (kind == "collabAgentToolCall" && item["tool"] == "spawnAgent") {
                        thread_message(state, task_id, parent.as_deref(), assistant(json!([{"type": "tool_use", "id": id, "name": name, "input": input}])))?;
                    }
                    let (out, is_error) = tool_output(item);
                    thread_message(state, task_id, parent.as_deref(), tool_result(id, out, is_error))?;
                    // A tool call may have changed the task's document: the task shows it as it's written.
                    crate::documents::follow(state, task_id);
                }
            }
        }
        "turn/plan/updated" => {
            let todos: Vec<Value> = p["plan"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|s| {
                    let status = match s["status"].as_str() {
                        Some("inProgress") => "in_progress",
                        Some("completed") => "completed",
                        _ => "pending",
                    };
                    json!({"content": s["step"], "status": status})
                })
                .collect();
            let id = format!("plan-{}-{}", p["threadId"].as_str().unwrap_or(""), v["emittedAtMs"].as_i64().unwrap_or_else(|| chrono::Utc::now().timestamp_millis()));
            thread_message(state, task_id, parent.as_deref(), assistant(json!([{"type": "tool_use", "id": id, "name": "TodoWrite", "input": {"todos": todos}}])))?;
            thread_message(state, task_id, parent.as_deref(), tool_result(&id, String::new(), false))?;
        }
        "error" if p["willRetry"] == true => {
            state.add_event(task_id, "warn", format!("Codex: {} (retrying)", p["error"]["message"].as_str().unwrap_or("error")), None);
        }
        "warning" => {
            if let Some(m) = p["message"].as_str() {
                state.add_event(task_id, "warn", format!("Codex: {m}"), None);
            }
        }
        "mcpServer/startupStatus/updated" if p["status"] == "failed" => {
            let name = p["name"].as_str().unwrap_or("?");
            let detail = p["error"].as_str().map(String::from);
            state.add_event(task_id, "warn", format!("MCP server {name} failed to start"), detail);
        }
        "account/rateLimits/updated" => {
            let config = {
                let c = state.db();
                db::get_task(&c, task_id)?.map(|t| db::task_claude_config(&c, &t)).transpose()?.flatten()
            };
            if let Some(config) = config {
                crate::usage::set_limits(state, &config.id, limits(&p["rateLimits"]), p["rateLimits"]["planType"].as_str());
            }
        }
        "thread/tokenUsage/updated" => crate::context::on_codex_usage(state, task_id, p)?,
        "turn/completed" if !own => {
            if let Some(thread) = p["threadId"].as_str() {
                let status = match p["turn"]["status"].as_str() {
                    Some("completed") => "completed",
                    Some("interrupted") => "stopped",
                    _ => "failed",
                };
                subagent_status(state, run, thread, status, p["turn"]["error"]["message"].as_str())?;
            }
        }
        "thread/status/changed" if !own && p["status"]["type"] == "systemError" => {
            if let Some(thread) = p["threadId"].as_str() {
                subagent_status(state, run, thread, "failed", None)?;
            }
        }
        "thread/closed" if !own => {
            if let Some(thread) = p["threadId"].as_str() {
                subagent_status(state, run, thread, "stopped", None)?;
            }
        }
        "turn/completed" => finish_turn(state, run, &p["turn"])?,
        // `/compact` ends here when its turn isn't reported.
        "thread/compacted" if own && run.kind == "compact" => finish_turn(state, run, &json!({"status": "completed"}))?,
        _ => {}
    }
    Ok(())
}

fn finish_turn(state: &Shared, run: &Run, turn: &Value) -> Result<()> {
    let status = turn["status"].as_str().unwrap_or("completed");
    let error = match status {
        "completed" => None,
        "interrupted" => Some("The turn was interrupted".to_string()),
        _ => Some(turn["error"]["message"].as_str().map(String::from).unwrap_or_else(|| format!("the turn ended as {status}"))),
    };
    // Refused for the account's usage limit (see usage.rs).
    if turn["error"]["codexErrorInfo"] == "usageLimitExceeded" {
        let config = {
            let c = state.db();
            db::get_task(&c, &run.task_id)?.map(|t| db::task_claude_config(&c, &t)).transpose()?.flatten()
        };
        if let Some(config) = config {
            crate::usage::codex_refused(state, &config.id);
            crate::usage::ran_out(state, &run.task_id, &config.id);
        }
    }
    // `/compact` may report its end twice (see handle_line); other runs can go several turns.
    let saw: bool = state.db().query_row("SELECT saw_result FROM runs WHERE id=?1", [&run.id], |r| r.get(0))?;
    if saw && run.kind == "compact" {
        return Ok(());
    }
    let result = json!({
        "type": "result",
        "subtype": if error.is_some() { "error_during_execution" } else { "success" },
        "is_error": error.is_some(),
        "result": error,
        "duration_ms": turn["durationMs"],
        "num_turns": if run.kind == "compact" { 0 } else { 1 },
    });
    crate::runner::record_result(state, run, error, result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unwraps_shell_commands() {
        assert_eq!(display_command("/usr/bin/bash -lc 'ls -la && printf hi > hello.txt'"), "ls -la && printf hi > hello.txt");
        assert_eq!(display_command("/bin/zsh -lc 'echo '\\''hi'\\'''"), "echo 'hi'");
        assert_eq!(display_command("bash -c \"make\""), "make");
        assert_eq!(
            display_command(r#"/usr/bin/bash -lc "printf 'hi\\n' && git commit -m \"Add it\"""#),
            r#"printf 'hi\n' && git commit -m "Add it""#
        );
        assert_eq!(display_command("git status"), "git status");
        assert_eq!(display_command("python -c 'print(1)'"), "python -c 'print(1)'");
        assert_eq!(display_command(r#"/usr/bin/bash -lc "cat <<'EOF'
#"'!/bin/sh'"
EOF""#), "cat <<'EOF'\n#!/bin/sh\nEOF");
        assert_eq!(display_command("bash -lc 'a' 'b'"), "bash -lc 'a' 'b'");
    }

    #[test]
    fn maps_permission_modes() {
        assert_eq!(policy("default", false), ("untrusted", "user", "workspace-write"));
        assert_eq!(policy("bypassPermissions", true), ("never", "user", "danger-full-access"));
        assert_eq!(policy("acceptEdits", true), ("never", "user", "read-only"));
        assert_eq!(policy("plan", false).2, "read-only");
    }

    #[test]
    fn a_reviewer_writes_only_its_build_output_and_temp_directories() {
        let spec = |sandbox: &str, fs: &[(&str, &str)]| Spec {
            sandbox: sandbox.into(),
            approval_policy: "never".into(),
            writable_roots: vec!["/repo/.git".into()],
            filesystem: fs.iter().map(|(p, a)| (p.to_string(), a.to_string())).collect(),
            ..Default::default()
        };
        let p = thread_params(&spec("read-only", &[("/w", "read"), ("/w/target", "write"), ("/home/me/.npm", "write")]), Path::new("/w"), Map::new());
        assert_eq!(p.get("sandbox"), None);
        assert_eq!(p["config"].get("sandbox_workspace_write"), None);
        assert_eq!(p["config"]["default_permissions"], REVIEW_PROFILE);
        assert_eq!(
            p["config"]["permissions"][REVIEW_PROFILE],
            json!({
                "extends": ":read-only",
                "filesystem": {":tmpdir": "write", ":slash_tmp": "write", "/w": "read", "/w/target": "write", "/home/me/.npm": "write"},
                "network": {"enabled": true},
            })
        );
        // Without anything to write, or in another sandbox, it's the sandbox as given.
        let p = thread_params(&spec("read-only", &[]), Path::new("/w"), Map::new());
        assert_eq!((p["sandbox"].as_str(), p["config"].get("permissions")), (Some("read-only"), None));
        let p = thread_params(&spec("workspace-write", &[("/w/target", "write")]), Path::new("/w"), Map::new());
        assert_eq!(p["sandbox"], "workspace-write");
        assert_eq!(p["config"]["sandbox_workspace_write"], json!({"network_access": true, "writable_roots": ["/repo/.git"]}));
        assert_eq!(p["config"].get("default_permissions"), None);
    }

    #[test]
    fn converts_mcp_servers() {
        let stdio = json!({"type": "stdio", "command": "x", "args": ["mcp"], "env": {"A": "1"}});
        assert_eq!(mcp_server_config("s", &stdio, false, &[], false).unwrap(), json!({"command": "x", "args": ["mcp"], "env": {"A": "1"}}));
        assert_eq!(mcp_server_config("s", &stdio, true, &[], false).unwrap()["default_tools_approval_mode"], "approve");
        let http = json!({"type": "http", "url": "https://h/mcp", "headers": {"Authorization": "Bearer t"}});
        assert_eq!(mcp_server_config("h", &http, false, &[], false).unwrap(), json!({"url": "https://h/mcp", "http_headers": {"Authorization": "Bearer t"}}));
        assert!(mcp_server_config("e", &json!({"type": "sse", "url": "u"}), false, &[], false).is_none());
        assert_eq!(mcp_server_config(MCP_SERVER_NAME, &json!({"command": "ia"}), false, &[], false).unwrap()["tool_timeout_sec"], 3900);
        assert_eq!(mcp_server_config("s", &stdio, false, &["w".into()], false).unwrap()["disabled_tools"], json!(["w"]));
        // In auto mode the board's tools stay approved but wait, which Codex's reviewer reviews.
        let board = mcp_server_config(MCP_SERVER_NAME, &json!({"command": "ia"}), false, &[], true).unwrap();
        assert_eq!((&board["default_tools_approval_mode"], &board["tools"]), (&json!("approve"), &json!({"wait": {"approval_mode": "prompt"}})));
        assert_eq!(mcp_server_config(MCP_SERVER_NAME, &json!({"command": "ia"}), false, &[], false).unwrap().get("tools"), None);
        assert_eq!(mcp_server_config("s", &stdio, true, &[], true).unwrap().get("tools"), None);
    }

    #[test]
    fn asks_about_a_wait_codex_leaves_to_the_user_as_its_command() {
        crate::testing::run(async || {
            // A board that records the prompts it's asked and denies them.
            let asked = Arc::new(std::sync::Mutex::new(Vec::new()));
            let record = asked.clone();
            let app = axum::Router::new().route(
                "/api/internal/mcp",
                axum::routing::post(move |axum::Json(body): axum::Json<Value>| async move {
                    record.lock().unwrap().push(body["args"].clone());
                    axum::Json(json!({"result": {"behavior": "deny"}}))
                }),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            tokio::spawn(async move { axum::serve(listener, app).await });
            let board = Arc::new(crate::mcp::Ctx::new(url, "t".into(), "r".into()));
            let elicit = async |tool: &str, params: Value| {
                let (tx, mut rx) = mpsc::unbounded_channel();
                let message = format!("Allow the {MCP_SERVER_NAME} MCP server to run tool \"{tool}\"?");
                let schema = json!({"type": "object", "properties": {}});
                let params = json!({"serverName": MCP_SERVER_NAME, "mode": "form", "message": message, "requestedSchema": schema, "_meta": {"tool_params": params}});
                answer(board.clone(), Responder(tx), json!({"id": 1, "method": "mcpServer/elicitation/request", "params": params}), None).await;
                serde_json::from_str::<Value>(&rx.recv().await.unwrap()).unwrap()["result"]["action"].clone()
            };

            // Codex asks only if its reviewer didn't take the call (see Spec::review_waits).
            assert_eq!(elicit("wait", json!({"reason": "waiting for CI", "command": " gh pr checks 1 "})).await, "decline");
            let prompt = json!({"command": "gh pr checks 1", "description": "Run while waiting: waiting for CI"});
            assert_eq!(*asked.lock().unwrap(), [json!({"tool_name": "Bash", "input": prompt, "tool_use_id": null})]);
            // A wait without a command, and the board's other tools, need no approval.
            assert_eq!(elicit("wait", json!({"seconds": 60, "command": ""})).await, "accept");
            assert_eq!(elicit("get_task", json!({"task": "IA-1"})).await, "accept");
            assert_eq!(asked.lock().unwrap().len(), 1);
            // Without its arguments, a wait is asked about as itself.
            assert_eq!(elicit("wait", Value::Null).await, "decline");
            assert_eq!(asked.lock().unwrap()[1]["tool_name"], format!("mcp__{MCP_SERVER_NAME}__wait"));
        });
    }

    #[test]
    fn spots_claude_models() {
        assert!(is_claude_model("opus"));
        assert!(is_claude_model("claude-sonnet-5-5"));
        assert!(!is_claude_model("gpt-6.1-sol"));
    }

    #[test]
    fn shows_items_as_tools() {
        let cmd = json!({"type": "commandExecution", "id": "e1", "command": "/usr/bin/bash -lc 'false'", "status": "completed", "exitCode": 1, "aggregatedOutput": "nope\n"});
        assert_eq!(tool_use(&cmd).unwrap().0, "Bash");
        assert_eq!(tool_output(&cmd), ("nope\n(exit code 1)".to_string(), true));
        let mcp = json!({"type": "mcpToolCall", "server": "huntaway", "tool": "get_task", "arguments": {"task_id": "IA-1"}, "status": "completed", "result": {"content": [{"type": "text", "text": "ok"}]}});
        assert_eq!(tool_use(&mcp).unwrap().0, "mcp__huntaway__get_task");
        assert_eq!(tool_output(&mcp), ("ok".to_string(), false));
        assert!(tool_use(&json!({"type": "userMessage"})).is_none());
    }
}

#[cfg(test)]
mod subagent_tests {
    use super::*;

    fn running() -> (Shared, Run) {
        let state = crate::testing::state();
        let profile = db::insert_profile(&state.db(), "p", &[], None).unwrap();
        let task = db::insert_task(&state.db(), db::NewTask { profile_id: &profile.id, project_id: None, kind: "scratch", title: "Codex",
            description: "", status: "in_progress", use_worktree: false, model: None, effort: None, claude_config_id: None }).unwrap();
        let run = db::insert_run(&state.db(), &task.id, "prompt").unwrap();
        handle_line(&state, &run, &json!({"method": "thread/started", "params": {"thread": {"id": "main"}}})).unwrap();
        (state, run)
    }

    fn event(state: &Shared, run: &Run, method: &str, thread: &str, extra: Value) {
        let mut params = extra;
        params["threadId"] = json!(thread);
        handle_line(state, run, &json!({"method": method, "params": params})).unwrap();
    }

    fn item(state: &Shared, run: &Run, thread: &str, item: Value) {
        event(state, run, "item/started", thread, json!({"item": item}));
        event(state, run, "item/completed", thread, json!({"item": item}));
    }

    fn messages(state: &Shared, run: &Run) -> Vec<Value> {
        db::list_messages(&state.db(), &run.task_id).unwrap().into_iter().filter(|m| m.kind == "claude").map(|m| m.data).collect()
    }

    fn calls(state: &Shared, run: &Run) -> Vec<Value> {
        messages(state, run).into_iter().filter(|m| m["type"] == "assistant" && m["message"]["content"][0]["type"] == "tool_use").collect()
    }

    #[test]
    fn codex_subagents_keep_the_main_session_turn_and_stream_separate() {
        crate::testing::run(async || {
            let (state, run) = running();
            let mut events = state.events.subscribe();
            // Both parentThreadId and v2's source.subAgent identify the parent before spawn returns.
            for thread in [
                json!({"id": "child", "parentThreadId": "main", "preview": "Inspect config", "agentRole": "explorer"}),
                json!({"id": "nested", "source": {"subAgent": {"thread_spawn": {"parent_thread_id": "child"}}}, "preview": "Check env"}),
            ] {
                handle_line(&state, &run, &json!({"method": "thread/started", "params": {"thread": thread}})).unwrap();
            }
            item(&state, &run, "main", json!({"type": "collabAgentToolCall", "id": "spawn", "tool": "spawnAgent", "status": "completed",
                "senderThreadId": "main", "receiverThreadIds": ["child"], "prompt": "Inspect config", "model": "gpt-6.1-sol", "agentsStates": {"child": {"status": "running"}}}));
            // A child starting, streaming or compacting mustn't reset the main preview.
            event(&state, &run, "turn/started", "child", json!({"turn": {"id": "child-turn"}}));
            event(&state, &run, "item/agentMessage/delta", "main", json!({"delta": "Main preview"}));
            event(&state, &run, "item/agentMessage/delta", "child", json!({"delta": "Child preview"}));
            item(&state, &run, "child", json!({"type": "agentMessage", "id": "text", "text": "Config report"}));
            item(&state, &run, "child", json!({"type": "commandExecution", "id": "bash", "command": "ls", "status": "completed", "aggregatedOutput": "config.rs"}));
            item(&state, &run, "nested", json!({"type": "reasoning", "id": "think", "summary": ["Check environment"]}));
            event(&state, &run, "turn/plan/updated", "nested", json!({"plan": [{"step": "Read env", "status": "inProgress"}]}));
            event(&state, &run, "turn/completed", "child", json!({"turn": {"id": "child-turn", "status": "completed"}}));
            assert_eq!(db::get_task(&state.db(), &run.task_id).unwrap().unwrap().session_id.as_deref(), Some("main"));
            let r = db::get_run(&state.db(), &run.id).unwrap().unwrap();
            assert!(!r.saw_result && r.result_error.is_none(), "a child's completion isn't the run's result");
            let emitted: Vec<Value> = std::iter::from_fn(|| events.try_recv().ok()).collect();
            let deltas: Vec<_> = emitted.iter().filter(|v| v["type"] == "delta" || v["type"] == "delta_reset").collect();
            assert_eq!(deltas.len(), 1);
            assert_eq!(deltas[0]["text"], "Main preview");
            let all = messages(&state, &run);
            assert!(all.iter().any(|m| m["parent_tool_use_id"] == "codex-agent-child" && m["message"]["content"][0]["text"] == "Config report"));
            assert!(all.iter().any(|m| m["parent_tool_use_id"] == "codex-agent-child" && m["message"]["content"][0]["content"] == "config.rs"));
            assert!(all.iter().any(|m| m["parent_tool_use_id"] == "codex-agent-nested" && m["message"]["content"][0]["thinking"] == "Check environment"));
            let agents: Vec<_> = calls(&state, &run).into_iter().filter(|m| m["message"]["content"][0]["name"] == "Agent").collect();
            assert_eq!(agents.len(), 2);
            assert_eq!(agents[1]["parent_tool_use_id"], "codex-agent-child");
            assert!(agents[0]["message"]["content"][0]["input"]["run_in_background"] == true);
        });
    }

    #[test]
    fn codex_source_only_children_accept_v2_and_legacy_spelling() {
        crate::testing::run(async || {
            for spelling in ["subAgent", "subagent"] {
                let (state, run) = running();
                let mut source = json!({});
                source[spelling] = json!({"thread_spawn": {"parent_thread_id": "main", "agent_role": "explorer"}});
                let thread = json!({"id": "child", "source": source, "preview": "Inspect config"});
                handle_line(&state, &run, &json!({"method": "thread/started", "params": {"thread": thread}})).unwrap();
                assert_eq!(db::get_task(&state.db(), &run.task_id).unwrap().unwrap().session_id.as_deref(), Some("main"));
                let calls = calls(&state, &run);
                assert_eq!(calls.len(), 1);
                assert_eq!(calls[0]["message"]["content"][0]["input"]["subagent_type"], "explorer");
                assert!(calls[0]["parent_tool_use_id"].is_null());
                for kind in ["review", "compact"] {
                    let mut source = json!({});
                    source[spelling] = json!(kind);
                    let thread = json!({"id": kind, "source": source});
                    handle_line(&state, &run, &json!({"method": "thread/started", "params": {"thread": thread}})).unwrap();
                    event(&state, &run, "turn/completed", kind, json!({"turn": {"id": kind, "status": "completed"}}));
                    assert_eq!(db::get_task(&state.db(), &run.task_id).unwrap().unwrap().session_id.as_deref(), Some("main"));
                    assert!(!db::get_run(&state.db(), &run.id).unwrap().unwrap().saw_result);
                }
            }
        });
    }

    #[test]
    fn codex_collab_actions_update_existing_children_instead_of_spawning_rows() {
        crate::testing::run(async || {
            let (state, run) = running();
            for (n, tool, status) in [(1, "spawnAgent", "running"), (2, "wait", "completed"), (3, "followupTask", "running"),
                (4, "sendMessage", "running"), (5, "wait", "errored"), (6, "resumeAgent", "running"), (7, "closeAgent", "shutdown")] {
                item(&state, &run, "main", json!({"type": "collabAgentToolCall", "id": format!("call{n}"), "tool": tool, "status": "completed",
                    "senderThreadId": "main", "receiverThreadIds": ["child"], "prompt": "Inspect config", "model": "gpt-6.1-sol",
                    "agentsStates": {"child": {"status": status, "message": "Child report"}}}));
            }
            let calls = calls(&state, &run);
            assert_eq!(calls.len(), 7);
            assert_eq!(calls.iter().filter(|m| m["message"]["content"][0]["name"] == "Agent").count(), 1);
            let all = messages(&state, &run);
            let statuses: Vec<_> = all.iter().filter(|m| m["subtype"] == "task_notification").map(|m| m["status"].as_str().unwrap()).collect();
            assert_eq!(statuses, ["completed", "failed", "stopped", "stopped"]);
            assert!(all.iter().any(|m| m["subtype"] == "task_updated" && m["patch"]["status"] == "running"));
            assert!(all.iter().filter(|m| m["subtype"] == "task_notification").all(|m| m["tool_use_id"] == "codex-agent-child"));
        });
    }

    #[test]
    fn codex_hosted_activity_and_late_metadata_share_one_row() {
        crate::testing::run(async || {
            let (state, run) = running();
            item(&state, &run, "main", json!({"type": "subAgentActivity", "id": "hosted1", "kind": "started", "agentThreadId": "hosted", "model": "gpt-6.1-sol"}));
            handle_line(&state, &run, &json!({"method": "thread/started", "params": {"thread": {"id": "hosted", "parentThreadId": "main", "preview": "Find tests"}}})).unwrap();
            item(&state, &run, "hosted", json!({"type": "subAgentActivity", "id": "hosted2", "kind": "started", "agentThreadId": "nested"}));
            item(&state, &run, "main", json!({"type": "subAgentActivity", "id": "hosted3", "kind": "completed", "agentThreadId": "hosted"}));
            item(&state, &run, "hosted", json!({"type": "subAgentActivity", "id": "hosted4", "kind": "interrupted", "agentThreadId": "nested"}));
            let agents = calls(&state, &run);
            assert_eq!(agents.len(), 2);
            assert_eq!(agents[0]["message"]["content"][0]["input"]["model"], "gpt-6.1-sol");
            assert_eq!(agents[1]["parent_tool_use_id"], "codex-agent-hosted");
            let all = messages(&state, &run);
            assert!(all.iter().any(|m| m["subtype"] == "task_started" && m["prompt"] == "Find tests"));
            assert_eq!(all.last().unwrap()["status"], "stopped");
        });
    }

    #[test]
    fn codex_failed_spawns_and_child_failures_dont_finish_the_parent() {
        crate::testing::run(async || {
            let (state, run) = running();
            item(&state, &run, "main", json!({"type": "collabAgentToolCall", "id": "bad-spawn", "tool": "spawnAgent", "status": "failed", "receiverThreadIds": [],
                "agentsStates": {"missing": {"status": "notFound", "message": "No agent available"}}}));
            assert_eq!(calls(&state, &run)[0]["message"]["content"][0]["name"], "spawnAgent");
            assert!(messages(&state, &run).iter().any(|m| m["message"]["content"][0]["is_error"] == true));
            // Internal compact/review agents must never become the main session.
            handle_line(&state, &run, &json!({"method": "thread/started", "params": {"thread": {"id": "review", "source": {"subAgent": "review"}}}})).unwrap();
            event(&state, &run, "turn/completed", "child", json!({"turn": {"id": "child-turn", "status": "failed", "error": {"message": "Child failed"}}}));
            assert!(!db::get_run(&state.db(), &run.id).unwrap().unwrap().saw_result);
            assert_eq!(db::get_task(&state.db(), &run.task_id).unwrap().unwrap().session_id.as_deref(), Some("main"));
            event(&state, &run, "turn/completed", "main", json!({"turn": {"id": "main-turn", "status": "completed"}}));
            assert!(db::get_run(&state.db(), &run.id).unwrap().unwrap().saw_result);
        });
    }
}
