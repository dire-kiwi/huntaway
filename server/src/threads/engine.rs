//! Running a task's agent on agent-threads (docs/agent-threads-feasibility.md, option B's first stage), for the
//! tasks whose `run_engine` is `agent_threads`: every other task's agent runs on the board's own runner as before.
//!
//! A task's engine is fixed when its first run starts (see `fix`): agent-threads if the host's setting
//! (`agent_threads_new_tasks`) is on then, else legacy. Tasks from before the setting are legacy.
//!
//! The board's gates around a run stay as they are (queued messages, dependencies, usage limits, the merge
//! queue, archived projects): `runner::start_run` registers a run in `runs` and the runs map for these tasks
//! too, and its preparation (worktree, prompt, tools, directories) is the same. Only the last step differs:
//! instead of starting `claude` (or the Codex adapter) under ia-shim, `launch` gives the task's thread (its id is
//! the task's) the run's launch options and capabilities, and sends it the message. A board run covers one
//! stretch of the thread's work: from that message until the thread stops running (it goes idle, or waits on a
//! question with no turn running). Messages sent meanwhile steer the turn, or the crate carries them into its
//! next turn (see `steer`); a stop interrupts it. `follow` mirrors the thread onto the task and ends the board's
//! run with the turn's outcome, through `runner::finish`, which moves the task on as a legacy run's end does.
//!
//! Tool permissions go to the board's own prompts (`mcp::permissions`, see `policy`), so they're answered as a
//! legacy run's are. The crate's questions and plans are its own requests, which the thread's API answers;
//! `follow` flags the task while one is open. The board's tools come from the `huntaway mcp` helper, as a
//! legacy run's do, attached to the thread as an MCP server.
//!
//! The backend's runs are under ia-shim (which writes the files agent-threads' shim does) in a directory of
//! their own, `<data>/at-runs`: the crate's run format is 1 against the board's 2, and its pruning must never see
//! the board's runs. They outlive the server as legacy runs do: `start` re-attaches to them.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex, Weak};

use agent_threads::protocol::{PermissionMode, ThreadRequest, ThreadStatus};
use agent_threads::{
    AgentThreads, Capabilities, CapabilitiesUpdate, ClaudeCodeOptions, CodexOptions, CreateOptions, HarnessMessage, Item, LaunchOptions, McpServer,
    Options, PermissionDecision, PermissionPolicy, SendOptions, ShimOptions, Skill, ThreadEvent, ThreadOptions,
};
use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Map, Value, json};
use tokio::sync::{broadcast, mpsc};

use crate::db::{self, Run, Task};
use crate::state::{AppState, Shared};
use crate::threads::store::HuntawayStore;
use crate::util::path_str;

/// A task whose agent runs on the board's own runner.
pub const LEGACY: &str = "legacy";
/// A task whose agent runs on agent-threads.
pub const AGENT_THREADS: &str = "agent_threads";
/// The host setting that has new tasks run on agent-threads.
pub const NEW_TASKS: &str = "agent_threads_new_tasks";

/// Whether the host's new tasks run on agent-threads.
pub fn new_tasks_on(c: &rusqlite::Connection) -> bool {
    db::get_setting(c, NEW_TASKS).ok().flatten().as_deref() == Some("true")
}

/// Whether the task's agent runs on agent-threads.
pub fn uses(task: &Task) -> bool {
    task.run_engine.as_deref() == Some(AGENT_THREADS)
}

/// The backend, once it's set up (see `start`).
pub fn backend(state: &AppState) -> Option<&AgentThreads> {
    state.agent_threads.get()
}

/// Where the backend's runs are: not `<data>/runs`, the board's own (see the module's doc).
pub fn runs_dir(state: &AppState) -> PathBuf {
    state.data_dir.join("at-runs")
}

/// Fixes the engine of a task whose first run is starting, if it isn't yet: agent-threads for a task (not a
/// review) with no conversation yet, when the host's setting is on and the backend is up; legacy otherwise.
pub fn fix(state: &Shared, task: Task) -> Result<Task> {
    if task.run_engine.is_some() {
        return Ok(task);
    }
    let on = new_tasks_on(&state.db()) && backend(state).is_some();
    let engine = if on && task.kind == "task" && task.session_id.is_none() { AGENT_THREADS } else { LEGACY };
    let unset = |c: &rusqlite::Connection| Ok(db::get_task(c, &task.id)?.is_some_and(|t| t.run_engine.is_none()));
    match state.update_task_if(&task.id, &[("run_engine", json!(engine))], unset)? {
        Some(t) => Ok(t),
        // Fixed meanwhile (or deleted).
        None => db::get_task(&state.db(), &task.id)?.ok_or_else(|| anyhow!("task not found")),
    }
}

// ---------- the backend ----------

/// Builds the backend on the board's database, with Claude Code and Codex under ia-shim (see the module's doc).
pub fn build(state: &Shared) -> AgentThreads {
    let claude = ClaudeCodeOptions {
        bin: crate::agent::runs::claude_program(),
        // The profile's CLAUDE.md, settings, hooks, plugins and skills, as a legacy run has them.
        user_settings: true,
        ..Default::default()
    };
    let codex = CodexOptions {
        bin: crate::agent::codex::program(),
        // The profile's CODEX_HOME (each thread's launch options give it), else the user's, as it is.
        user_config: true,
        login: None,
        config: codex_config(),
        ..Default::default()
    };
    let spawner = agent_threads::shim(state.exe.with_file_name("ia-shim"), ShimOptions::new(runs_dir(state)));
    build_with(state, spawner, claude, codex)
}

/// The config Codex threads start with, under the crate's own, as the board's Codex adapter has it (see
/// agent/codex.rs): agents need the network (git push, gh, package managers), as Claude's have it.
pub(crate) fn codex_config() -> Map<String, Value> {
    let mut config = Map::new();
    config.insert("sandbox_workspace_write.network_access".into(), json!(true));
    config
}

/// `build`, with these processes and harnesses (for tests).
pub(crate) fn build_with(state: &Shared, spawner: Arc<dyn agent_threads::Spawner>, claude: ClaudeCodeOptions, codex: CodexOptions) -> AgentThreads {
    let weak = Arc::downgrade(state);
    let on_error: Arc<dyn Fn(agent_threads::Error) + Send + Sync> = Arc::new(|e| match &e {
        // A thread whose task was deleted while its harness was being stopped (see `delete`) can't be saved.
        agent_threads::Error::Store(s) if s.kind == agent_threads::StoreErrorKind::NotFound => tracing::debug!("agent-threads: {e}"),
        _ => tracing::warn!("agent-threads: {e}"),
    });
    let handler = {
        let weak = weak.clone();
        Arc::new(move |m: &HarnessMessage| {
            if let Some(s) = weak.upgrade() {
                on_harness_message(&s, m);
            }
        })
    };
    AgentThreads::new(Options {
        store: Some(Arc::new(HuntawayStore::new(weak.clone()))),
        harnesses: vec![agent_threads::claude_code(claude), agent_threads::codex(codex)],
        spawner: Some(spawner),
        capabilities: Capabilities { permissions: Some(policy(weak)), ..Default::default() },
        on_error: Some(on_error),
        // A question left open when its turn ends stays answerable, as the board's are.
        late_answers: true,
        on_harness_message: Some(handler),
        ..Default::default()
    })
}

/// Sets up the backend in the state and starts following it, before the board's runs are loaded (see
/// runner::load_active), which may start runs on it.
pub fn start(state: &Shared) {
    start_with(state, build(state));
}

/// `start`, with this backend.
pub(crate) fn start_with(state: &Shared, backend: AgentThreads) {
    let events = backend.subscribe();
    if !crate::threads::live::install(state, backend) {
        tracing::warn!("the agent-threads backend was set up twice; keeping the first");
        return;
    }
    if let Err(e) = write_token_file(state) {
        tracing::error!("writing the agents' token file {}: {e:#}", token_file(state).display());
    }
    let (tx, rx) = mpsc::unbounded_channel();
    SENDS.lock().unwrap().insert(key(state), tx);
    tokio::spawn(sender(Arc::downgrade(state), rx));
    tokio::spawn(follow(Arc::downgrade(state), events));
}

/// Re-attaches to the backend's runs that went on while the server was down, then ends the board's runs whose
/// threads aren't running any more. After runner::load_active, which registers those runs again.
pub async fn recover(state: &Shared) {
    let Some(backend) = backend(state) else { return };
    match backend.recover().await {
        Ok(r) if !(r.reattached.is_empty() && r.lost.is_empty()) => {
            tracing::info!(reattached = r.reattached.len(), lost = r.lost.len(), "agent-threads runs recovered")
        }
        Ok(_) => {}
        Err(e) => tracing::error!("recovering agent-threads runs: {e}"),
    }
    let tasks: Vec<String> = state.runs.lock().unwrap().keys().cloned().collect();
    for id in tasks {
        if db::get_task(&state.db(), &id).ok().flatten().is_some_and(|t| uses(&t)) {
            settle(state, &id, None).await;
        }
    }
}

/// Stops following the backend's runs as the server stops, and leaves them going, to re-attach to them when
/// it starts again.
pub async fn close(state: &Shared) {
    if let Some(b) = backend(state)
        && let Err(e) = b.close(false).await
    {
        tracing::error!("closing the agent-threads backend: {e}");
    }
}

// ---------- launching ----------

/// What a run of an agent-threads task is started with: what runner/launch.rs works out for a legacy run.
pub struct Spec {
    pub codex: bool,
    pub cwd: String,
    /// The message to send (with the task's start for its first run).
    pub text: String,
    /// The run compacts the conversation rather than sending a message.
    pub compact: bool,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// The board's permission mode (default, acceptEdits, plan, auto, dontAsk, bypassPermissions).
    pub permission_mode: String,
    pub system_prompt: String,
    /// More arguments for Claude Code: `--settings`, `--allowedTools`, `--disallowedTools`.
    pub args: Vec<String>,
    /// The tools that need no approval (`--allowedTools`'s), which the policy allows for Codex.
    pub allowed: Vec<String>,
    /// More directories the agent may use: `--add-dir` for Claude Code, writable roots for Codex.
    pub add_dirs: Vec<String>,
    pub env: Vec<(String, String)>,
    /// CLAUDE_CONFIG_DIR, or CODEX_HOME; may start with `~`.
    pub config_dir: Option<String>,
    /// The project's own MCP servers (see agent/agent_tools.rs).
    pub mcp_servers: Map<String, Value>,
    /// Codex's skills, the project's (Claude Code finds them in `add_dirs`).
    pub skills: Vec<PathBuf>,
    pub github_account: Option<String>,
}

/// What `policy` needs of a thread's latest run.
#[derive(Clone, Default)]
struct Allowed {
    tools: Vec<String>,
}

/// The tools each thread's latest run may use without asking, by task id.
static ALLOWED: LazyLock<Mutex<HashMap<String, Allowed>>> = LazyLock::new(Default::default);

/// The board's permission mode as agent-threads has it. Auto is Claude's own (`--permission-mode auto`, see
/// `launch`) on top of the default.
fn mode(m: &str) -> PermissionMode {
    match m {
        "acceptEdits" => PermissionMode::AcceptEdits,
        "plan" => PermissionMode::Plan,
        "bypassPermissions" => PermissionMode::Bypass,
        "dontAsk" => PermissionMode::DontAsk,
        _ => PermissionMode::Default,
    }
}

/// The run id a thread's MCP helpers call the board as: the thread's, `thread:<task id>`, which the board takes
/// as the task's run at the time of each call (see `current_run_id`). The helpers outlive a board run (a turn the
/// thread starts by itself has a run of its own, see `adopt`), so they can't be given one.
pub fn helper_run_id(task_id: &str) -> String {
    format!("{THREAD_RUN}{task_id}")
}

const THREAD_RUN: &str = "thread:";

/// The board run that a helper's run id (see `helper_run_id`) stands for now: the task's run, or, for a turn the
/// thread started by itself that the follower hasn't caught up with yet, the run it's given now (see `adopt`).
/// None for a thread with no turn running. Another run id is itself.
pub async fn current_run_id(state: &Shared, run_id: &str) -> Option<String> {
    let Some(task_id) = run_id.strip_prefix(THREAD_RUN) else { return Some(run_id.to_string()) };
    let current = || state.runs.lock().unwrap().get(task_id).map(|h| h.run_id.clone());
    if let Some(r) = current() {
        return Some(r);
    }
    let task = task_of(state, task_id).ok().flatten()?;
    running_turn(backend(state)?, task_id).await?;
    if let Err(e) = adopt(state, &task) {
        tracing::warn!(task = task_id, "starting a run for the agent's turn: {e:#}");
    }
    current()
}

/// The file the board's helpers read its token from (`IA_TOKEN_FILE`, see mcp::board_token), private to this
/// user: Claude Code gets its MCP servers on its command line, which other users can read.
pub fn token_file(state: &AppState) -> PathBuf {
    state.data_dir.join("helper_token")
}

/// Writes the token file (see `token_file`), readable only by this user.
fn write_token_file(state: &AppState) -> Result<()> {
    use std::io::Write;
    let path = token_file(state);
    let tmp = path.with_extension("tmp");
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let _ = std::fs::remove_file(&tmp);
    opts.open(&tmp)?.write_all(state.token.as_bytes())?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// The board's MCP servers for a run (see runs::start): its tools (`huntaway mcp`) and GitHub's, then the
/// project's own. They read the board's token from a file (see `token_file`), and call it as the thread (see
/// `helper_run_id`).
fn mcp_servers(state: &Shared, run: &Run, spec: &Spec) -> BTreeMap<String, McpServer> {
    let exe = path_str(&state.exe);
    let (token, run_id) = (path_str(&token_file(state)), helper_run_id(&run.task_id));
    let env = |extra: &[(&str, &str)]| -> BTreeMap<String, String> {
        let mut env: BTreeMap<String, String> =
            [("IA_URL", state.internal_url.as_str()), ("IA_TOKEN_FILE", token.as_str()), ("IA_RUN_ID", run_id.as_str())].map(|(k, v)| (k.to_string(), v.to_string())).into();
        env.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
        env
    };
    let mut servers = BTreeMap::new();
    let board = McpServer::Stdio { command: exe.clone(), args: vec!["mcp".into()], env: env(&[]) };
    servers.insert(crate::agent::runner::MCP_SERVER_NAME.to_string(), board);
    let account: Vec<(&str, &str)> = spec.github_account.as_deref().map(|a| (crate::mcp::gh_mcp::ACCOUNT_ENV, a)).into_iter().collect();
    let gh = McpServer::Stdio { command: exe, args: vec!["gh-mcp".into()], env: env(&[[("IA_CWD", spec.cwd.as_str())].as_slice(), &account].concat()) };
    servers.insert(crate::mcp::gh_mcp::SERVER_NAME.to_string(), gh);
    for (name, server) in &spec.mcp_servers {
        if name == crate::agent::runner::MCP_SERVER_NAME {
            continue;
        }
        match McpServer::from_json(server) {
            Some(s) => {
                servers.insert(name.clone(), s);
            }
            None => tracing::warn!(task = %run.task_id, "the project's MCP server {name} isn't one agent-threads can run"),
        }
    }
    servers
}

/// Starts run `run` of an agent-threads task: its thread (made with the task's id the first time) gets the
/// run's options, launch options and capabilities, then the message (or a compaction). Returns once the
/// thread has it; `follow` ends the run.
pub async fn launch(state: &Shared, run: &Run, spec: Spec) -> Result<()> {
    let backend = backend(state).context("the agent-threads backend isn't running")?;
    let task_id = run.task_id.as_str();
    let harness = if spec.codex { "codex" } else { "claude" };
    let cwd = crate::util::expand_tilde(&spec.cwd);
    if !cwd.is_dir() {
        bail!("working directory {} does not exist", cwd.display());
    }
    let mut args = spec.args.clone();
    if spec.permission_mode == "auto" && !spec.codex {
        args.extend(["--permission-mode".into(), "auto".into()]);
    }
    let mut env: BTreeMap<String, Option<String>> = spec.env.iter().map(|(k, v)| (k.clone(), Some(v.clone()))).collect();
    if !spec.codex {
        // As a legacy run has it: the board's MCP tools wait for their answers (a wait, a question) for longer
        // than Claude Code's default.
        env.insert("MCP_TOOL_TIMEOUT".into(), Some("86400000".into()));
    }
    let launch = LaunchOptions {
        args,
        env,
        add_dirs: spec.add_dirs.iter().map(|d| crate::util::expand_tilde(d)).collect(),
        config_dir: spec.config_dir.as_deref().filter(|d| !d.trim().is_empty()).map(crate::util::expand_tilde),
    };
    let thread = backend.get(task_id).await.map_err(|e| anyhow!("{e}"))?;
    match thread {
        Some(t) if t.harness != harness => bail!(
            "this task's conversation is on {}, and its config now runs {harness}: agent-threads can't move a conversation between them",
            t.harness
        ),
        Some(_) => {}
        None => {
            let mut metadata = Map::new();
            metadata.insert("task_id".into(), json!(task_id));
            backend
                .create(CreateOptions {
                    id: Some(task_id.to_string()),
                    harness: Some(harness.into()),
                    cwd: Some(cwd.clone()),
                    metadata,
                    launch: launch.clone(),
                    ..Default::default()
                })
                .await
                .map_err(|e| anyhow!("creating the task's thread: {e}"))?;
        }
    }
    ALLOWED.lock().unwrap().insert(task_id.to_string(), Allowed { tools: spec.allowed.clone() });
    let options = ThreadOptions {
        model: Some(spec.model.clone().unwrap_or_default()),
        effort: Some(spec.effort.clone().unwrap_or_default()),
        permission_mode: Some(mode(&spec.permission_mode)),
        standing_answers: None,
        launch: Some(launch),
    };
    backend.set_options(task_id, options).await.map_err(|e| anyhow!("{e}"))?;
    let update = CapabilitiesUpdate {
        mcp_servers: Some(mcp_servers(state, run, &spec)),
        skills: Some(if spec.codex { spec.skills.iter().cloned().map(Skill::Dir).collect() } else { Vec::new() }),
        system_prompt: Some(spec.system_prompt.clone()),
        ..Default::default()
    };
    backend.configure(task_id, update).await.map_err(|e| anyhow!("{e}"))?;
    tracing::info!(task = task_id, run = %run.id, kind = %run.kind, cwd = %spec.cwd, harness, "starting the agent on agent-threads");
    if spec.compact {
        backend.compact(task_id).await.map_err(|e| anyhow!("{e}"))?;
    } else {
        let origin = run_origin(state, run);
        backend.send(task_id, &spec.text, send_options(task_id, origin)).await.map_err(|e| anyhow!("{e}"))?;
    }
    // (Its turn may have ended already: the follower ends the run with it, being prepared or not.)
    started(state, run)?;
    Ok(())
}

/// The run's message is with the thread: from here a stop interrupts it, and the messages sent while it was
/// prepared go to it now, in order.
fn started(state: &Shared, run: &Run) -> Result<()> {
    let task_id = run.task_id.as_str();
    let runs = state.runs.lock().unwrap();
    state.db().execute("UPDATE runs SET status='running' WHERE id=?1 AND status='preparing'", [&run.id])?;
    if runs.get(task_id).is_none_or(|h| h.run_id != run.id) {
        return Ok(());
    }
    let Some(task) = db::get_task(&state.db(), task_id)? else { return Ok(()) };
    let (mine, rest): (Vec<db::Steer>, Vec<db::Steer>) = task.steering.clone().into_iter().partition(|s| s.run_id == run.id);
    for s in &mine {
        sent(state, &task, &s.text, s.from_agent)?;
    }
    if !mine.is_empty() {
        let t = db::update_task(&state.db(), task_id, &[("steering", json!(rest))])?;
        if let Some(t) = t {
            state.emit_task(&t);
        }
    }
    drop(runs);
    Ok(())
}

/// Whether a message can go to the agent-threads run `run` now: it's started (see `started`). One still being
/// prepared waits in the task's `steering` until it has.
pub fn takes_messages(run: &Run) -> bool {
    run.kind != "compact" && run.status == "running"
}

/// Sends a message to the thread of a task whose run is going (see `takes_messages`): the crate steers the
/// running turn with it, or carries it into its next turn. It goes in the board's thread at once. Call with the
/// runs lock held, so it keeps its order with the run's start (see `started`).
pub fn steer(state: &Shared, task: &Task, text: &str, from_agent: bool) -> Result<Option<Task>> {
    sent(state, task, text, from_agent)?;
    Ok(db::get_task(&state.db(), &task.id)?)
}

/// Queues `text` for the task's thread (see `sender`) and records it in the board's thread as steered.
fn sent(state: &Shared, task: &Task, text: &str, from_agent: bool) -> Result<()> {
    // `/plan`, as a legacy run's steering has it (see runner::write_steers).
    let plan_file = crate::agent::documents::path(state, task, "plan").filter(|_| task.kind == "task").map(|p| path_str(&p));
    let plan = plan_file.as_deref().zip(crate::agent::documents::plan_command(text)).map(|(f, rest)| crate::agent::documents::plan_prompt(f, rest, false));
    let tx = SENDS.lock().unwrap().get(&key(state)).cloned().context("the agent-threads backend isn't running")?;
    let origin = Origin { from_agent, ..Default::default() };
    tx.send((task.id.clone(), plan.unwrap_or_else(|| text.to_string()), origin)).map_err(|_| anyhow!("the agent-threads backend has stopped"))?;
    let mut msg = json!({"text": text, "steered": true});
    if from_agent {
        msg["from_agent"] = json!(true);
    }
    state.add_message(&task.id, "user", msg)?;
    Ok(())
}

/// Who sent a message to a thread, where it isn't wholly the user's: the board's own (`auto`), another agent's
/// (`from_agent`), or the user's with other agents' messages queued alongside (`user_text`, the user's part), as
/// the board's thread has them (see runner::send_message). agent-threads' items don't say, so it's kept with
/// the user_message item's id (see `record_origin`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Origin {
    pub auto: bool,
    pub from_agent: bool,
    pub user_text: Option<String>,
}

impl Origin {
    fn is_users(&self) -> bool {
        self == &Origin::default()
    }
}

/// The origins of messages sent to threads whose user_message items haven't been seen yet, by the message's
/// client id (see `send_options`).
static ORIGINS: LazyLock<Mutex<HashMap<String, Origin>>> = LazyLock::new(Default::default);

/// A message's options: one that isn't wholly the user's gets a client id, which its user_message item has, to
/// record its origin by (see `follow`).
fn send_options(task_id: &str, origin: Origin) -> SendOptions {
    if origin.is_users() {
        return SendOptions::default();
    }
    let client_id = format!("ha-{task_id}-{}", crate::util::new_id());
    ORIGINS.lock().unwrap().insert(client_id.clone(), origin);
    SendOptions { client_id: Some(client_id), ..Default::default() }
}

/// The origin of the message run `run` started with: the board's user message it recorded (runs.turn_message_id).
fn run_origin(state: &Shared, run: &Run) -> Origin {
    let data: Option<String> = state
        .db()
        .query_row("SELECT m.data FROM runs r JOIN messages m ON m.id=r.turn_message_id WHERE r.id=?1", [&run.id], |r| r.get(0))
        .ok();
    let Some(v) = data.and_then(|d| serde_json::from_str::<Value>(&d).ok()) else { return Origin::default() };
    Origin {
        auto: v["auto"] == true,
        from_agent: v["from_agent"] == true,
        user_text: v["user_text"].as_str().map(String::from),
    }
}

/// Keeps who sent user_message `item_id` of thread `thread_id`, for the board's readers of its items.
// HA-144 (on its own branch) keeps these in `at_item_origins`: once both are in HA-128, this calls
// `threads::history::record_origin(&conn, thread_id, item_id, &history::Origin { auto, from_agent, user_text, .. })`.
fn record_origin(_state: &Shared, thread_id: &str, item_id: &str, origin: &Origin) -> Result<()> {
    tracing::debug!(thread = thread_id, item = item_id, ?origin, "a message's origin (kept once HA-144's at_item_origins is in)");
    Ok(())
}

/// Messages for each state's threads, sent one at a time in the order they were queued (see `sent`).
static SENDS: LazyLock<Mutex<HashMap<usize, mpsc::UnboundedSender<(String, String, Origin)>>>> = LazyLock::new(Default::default);

/// A state's key in SENDS.
fn key(state: &Shared) -> usize {
    Arc::as_ptr(state) as usize
}

async fn sender(state: Weak<AppState>, mut rx: mpsc::UnboundedReceiver<(String, String, Origin)>) {
    while let Some((task_id, text, origin)) = rx.recv().await {
        let Some(s) = state.upgrade() else { return };
        let Some(b) = backend(&s) else { continue };
        if let Err(e) = b.send(&task_id, &text, send_options(&task_id, origin)).await {
            tracing::warn!(task = %task_id, "sending a message to the agent: {e}");
            s.add_event(&task_id, "error", "Couldn't send the message to the agent", Some(format!("{e}\n\n{text}")));
        }
    }
}

/// Stops the turn of an agent-threads task's run: the crate interrupts it (and stops its process if it doesn't end
/// in time), and `follow` ends the run as stopped.
pub fn stop(state: &Shared, task_id: &str) {
    let Some(b) = backend(state).cloned() else { return };
    let id = task_id.to_string();
    tokio::spawn(async move {
        if let Err(e) = b.interrupt(&id).await {
            tracing::warn!(task = %id, "stopping the agent: {e}");
        }
    });
}

/// The task is being deleted: its thread goes first, its harness stopped (its rows would go with the task's,
/// but the backend would keep it, and fail to save it). Waits up to 5s for the harness, then lets it go on being
/// deleted in the background. Nothing for a task without a thread.
pub async fn delete(state: &Shared, task_id: &str) {
    ALLOWED.lock().unwrap().remove(task_id);
    OPEN.lock().unwrap().remove(task_id);
    let Some(b) = backend(state).cloned() else { return };
    let (st, id) = (state.clone(), task_id.to_string());
    let deleting = tokio::spawn(async move {
        if let Err(e) = b.delete(&id).await {
            tracing::warn!(task = %id, "deleting the agent's thread: {e}");
        }
        // Its run ends with it (or, if the task has gone meanwhile, its handle goes: see runner::finish).
        let run_id = st.runs.lock().unwrap().get(&id).map(|h| h.run_id.clone());
        if let Some(run_id) = run_id {
            crate::agent::runner::finish(&st, &run_id, crate::agent::runner::Outcome::Cancelled);
        }
    });
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), deleting).await;
}

// ---------- following threads ----------

/// The runs being ended, so two `settle`s don't both end one.
static ENDING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

/// The requests open on each task's thread (questions and plans), by task id.
static OPEN: LazyLock<Mutex<HashMap<String, Vec<String>>>> = LazyLock::new(Default::default);

/// Mirrors the backend's threads onto their tasks (see the module's doc).
async fn follow(state: Weak<AppState>, mut events: broadcast::Receiver<ThreadEvent>) {
    loop {
        let event = match events.recv().await {
            Ok(e) => e,
            Err(broadcast::error::RecvError::Lagged(n)) => {
                tracing::warn!("fell {n} agent-threads events behind; settling every run on it");
                let Some(s) = state.upgrade() else { return };
                let tasks: Vec<String> = s.runs.lock().unwrap().keys().cloned().collect();
                for id in tasks {
                    if db::get_task(&s.db(), &id).ok().flatten().is_some_and(|t| uses(&t)) {
                        settle(&s, &id, None).await;
                    }
                }
                continue;
            }
            Err(broadcast::error::RecvError::Closed) => return,
        };
        #[cfg(test)]
        {
            let delay = FOLLOW_DELAY.get();
            if delay > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            }
        }
        let Some(s) = state.upgrade() else { return };
        if let Err(e) = on_event(&s, event).await {
            tracing::warn!("following an agent-threads thread: {e:#}");
        }
    }
}

#[cfg(test)]
thread_local! {
    /// How long the follower takes over each event, to have it fall behind as it does under load.
    pub(crate) static FOLLOW_DELAY: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// The task an event's thread is for, if it runs on agent-threads.
fn task_of(state: &Shared, thread_id: &str) -> Result<Option<Task>> {
    Ok(db::get_task(&state.db(), thread_id)?.filter(uses))
}

/// The board's run going on the task, if it has one.
fn current_run(state: &Shared, task_id: &str) -> Result<Option<Run>> {
    let run_id = state.runs.lock().unwrap().get(task_id).map(|h| h.run_id.clone());
    match run_id {
        Some(id) => Ok(db::get_run(&state.db(), &id)?.filter(|r| r.status != "exited")),
        None => Ok(None),
    }
}

async fn on_event(state: &Shared, event: ThreadEvent) -> Result<()> {
    match event {
        ThreadEvent::ThreadUpdated(e) => {
            let Some(task) = task_of(state, &e.thread_id)? else { return Ok(()) };
            let t = &e.thread;
            if let Some(sid) = t.session_id.as_deref().filter(|s| task.session_id.as_deref() != Some(*s)) {
                state.update_task(&task.id, &[("session_id", json!(sid))])?;
                if let Some(run) = current_run(state, &task.id)? {
                    db::set_run_session(&state.db(), &run.id, sid)?;
                }
            }
            // A run ends with its turn (see TurnCompleted), not with these, which can come late: the follower reads
            // events in order, while the thread may well have moved on.
        }
        ThreadEvent::TurnCompleted(e) => {
            if task_of(state, &e.thread_id)?.is_some() {
                settle(state, &e.thread_id, Some(&e.turn_id)).await;
            }
        }
        ThreadEvent::ItemAdded(e) => {
            if let Item::UserMessage(m) = &e.item
                && let Some(origin) = m.client_id.as_deref().and_then(|c| ORIGINS.lock().unwrap().remove(c))
            {
                record_origin(state, &e.thread_id, &m.id, &origin)?;
                return Ok(());
            }
            let Item::TurnResult(r) = &e.item else { return Ok(()) };
            if r.parent_id.is_some() {
                return Ok(());
            }
            let Some(task) = task_of(state, &e.thread_id)? else { return Ok(()) };
            let Some(run) = current_run(state, &task.id)? else { return Ok(()) };
            // The turn a stop interrupted: from here, a message it takes in starts a new one (as runner::record_turn_end).
            let error = (!r.ok && !r.interrupted).then(|| r.error.clone().unwrap_or_else(|| "The turn failed.".into()));
            state.db().execute(
                "UPDATE runs SET saw_result=1, between_turns=1, result_error=?1, stop_requested = CASE WHEN stop_requested=1 THEN 2 ELSE stop_requested END WHERE id=?2",
                rusqlite::params![error, run.id],
            )?;
            crate::mcp::wait::ended(state, &task.id, &run.id);
            crate::agent::documents::turn_ended(state, &task.id);
        }
        ThreadEvent::TurnStarted(e) => {
            let Some(task) = task_of(state, &e.thread_id)? else { return Ok(()) };
            match current_run(state, &task.id)? {
                // A new turn (a message carried over): what the last one ended with isn't the run's outcome, and
                // after a stop, the run is no longer stopped (as runner::steered has it).
                Some(run) => {
                    state.db().execute(
                        "UPDATE runs SET between_turns=0, result_error=NULL, stop_requested = CASE WHEN stop_requested=2 THEN 0 ELSE stop_requested END WHERE id=?1",
                        [&run.id],
                    )?;
                }
                // A turn no board run started (an answer to a question kept after its turn, which the crate sends
                // as the next message), even if it has ended by now: its end settles the run (runs are settled in
                // the order of their events, so a turn of a run that has ended doesn't come here).
                None => adopt(state, &task)?,
            }
        }
        ThreadEvent::RequestOpened(e) => {
            let Some(task) = task_of(state, &e.thread_id)? else { return Ok(()) };
            let (id, reason) = request_reason(&e.request);
            OPEN.lock().unwrap().entry(task.id.clone()).or_default().push(id);
            if let Some(run) = current_run(state, &task.id)? {
                state.db().execute("UPDATE runs SET attention=?1 WHERE id=?2", rusqlite::params![reason, run.id])?;
            }
            let mut fields = vec![("attention_reason", json!(reason))];
            if task.kind == "task" && task.status != "done" {
                fields.push(("status", json!("needs_attention")));
            }
            state.update_task(&task.id, &fields)?;
        }
        ThreadEvent::RequestResolved(e) => {
            let Some(task) = task_of(state, &e.thread_id)? else { return Ok(()) };
            let left = {
                let mut open = OPEN.lock().unwrap();
                let list = open.entry(task.id.clone()).or_default();
                list.retain(|r| r != &e.request_id);
                let left = list.len();
                if left == 0 {
                    open.remove(&task.id);
                }
                left
            };
            if left > 0 {
                return Ok(());
            }
            if let Some(run) = current_run(state, &task.id)? {
                state.db().execute("UPDATE runs SET attention=NULL WHERE id=?1", [&run.id])?;
            }
            // Back at work, if it's still running; otherwise its run's end has moved it on (see `settle`).
            if state.is_running(&task.id) && task.status == "needs_attention" {
                let mut fields = vec![("attention_reason", Value::Null)];
                if task.kind == "task" {
                    fields.push(("status", json!(task.working_status())));
                }
                state.update_task(&task.id, &fields)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// A request's id, and what its task says it's waiting for (as mcp::permissions does for the board's own).
fn request_reason(request: &ThreadRequest) -> (String, String) {
    let one_line = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    let v = serde_json::to_value(request).unwrap_or_default();
    let id = v["id"].as_str().unwrap_or_default().to_string();
    let reason = match request {
        ThreadRequest::Question(_) => {
            let questions = v["questions"].as_array().map(Vec::as_slice).unwrap_or_default();
            let first = questions.iter().find_map(|q| q["question"].as_str().or(q["text"].as_str())).map(one_line).filter(|q| !q.is_empty());
            match (first, questions.len()) {
                (None, _) => "The agent has questions for you".into(),
                (Some(q), 0 | 1) => q,
                (Some(q), n) => format!("{q} (and {} more question{})", n - 1, if n == 2 { "" } else { "s" }),
            }
        }
        ThreadRequest::Plan(_) => "Plan ready for approval".into(),
        ThreadRequest::Permission(_) => format!("Approve {}?", v["tool_name"].as_str().or(v["name"].as_str()).unwrap_or("a tool call")),
    };
    (id, reason)
}

/// A thread of an agent-threads task started a turn with no board run going: an answer to a question left
/// open after its turn, say, which the crate sends as the next message. The board's run for it starts here.
fn adopt(state: &Shared, task: &Task) -> Result<()> {
    let run = {
        let mut runs = state.runs.lock().unwrap();
        if runs.contains_key(&task.id) {
            return Ok(());
        }
        let run = db::insert_run(&state.db(), &task.id, "prompt")?;
        state.db().execute("UPDATE runs SET status='running' WHERE id=?1", [&run.id])?;
        runs.insert(task.id.clone(), crate::state::RunHandle { run_id: run.id.clone(), cancel: None });
        run
    };
    let mut fields = vec![("running", json!(true)), ("steerable", json!(true)), ("attention_reason", Value::Null), ("waiting", json!(false))];
    if !task.running {
        fields.push(("run_started_at", json!(crate::util::now())));
    }
    if task.kind == "task" {
        fields.push(("status", json!(task.working_status())));
    }
    state.update_task(&task.id, &fields)?;
    tracing::info!(task = %task.id, run = %run.id, "the agent's thread started a turn of its own");
    Ok(())
}

/// Ends the board's run on an agent-threads task once its thread isn't running any more, with the outcome of
/// its last turn as the thread has it (see runner::finish). `completed` is the turn the follower has just seen
/// end: unless that's the thread's latest turn, a later one is going (or has ended, and its own end settles the
/// run). Without it (after a restart, or events missed), whatever the thread's state is now.
pub async fn settle(state: &Shared, task_id: &str, completed: Option<&str>) {
    let Some(backend) = backend(state) else { return };
    let thread = match backend.get(task_id).await {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!(task = task_id, "reading the agent's thread: {e}");
            return;
        }
    };
    if thread.as_ref().is_some_and(|t| t.status == ThreadStatus::Running) {
        return;
    }
    let (latest, result) = match &thread {
        Some(_) => last_turn(backend, task_id).await,
        None => (None, None),
    };
    match completed {
        Some(t) if latest.as_deref() != Some(t) => return,
        // A question or plan open in a turn that's still running.
        None if thread.as_ref().is_some_and(|t| t.status == ThreadStatus::Waiting) && latest.is_some() && result.is_none() => return,
        _ => {}
    }
    let run_id = state.runs.lock().unwrap().get(task_id).map(|h| h.run_id.clone());
    let Some(run_id) = run_id else { return };
    let run = match db::get_run(&state.db(), &run_id) {
        Ok(Some(r)) if r.status != "exited" => r,
        // Gone with its task: so is the handle (as runner::finish does).
        Ok(None) => return crate::agent::runner::finish(state, &run_id, crate::agent::runner::Outcome::Cancelled),
        _ => return,
    };
    // Still being prepared, and no turn of its seen to end: its turn hasn't started.
    if run.status == "preparing" && completed.is_none() {
        return;
    }
    if !ENDING.lock().unwrap().insert(run.id.clone()) {
        return;
    }
    use crate::agent::runner::Outcome;
    let outcome = match (&thread, &result) {
        _ if run.stop_requested => Outcome::Cancelled,
        (None, _) => Outcome::Failed("The task's thread is gone".into()),
        (_, Some(r)) if r.ok => Outcome::Ok,
        (_, Some(r)) if r.interrupted => Outcome::Cancelled,
        (_, Some(r)) => Outcome::Failed(r.error.clone().unwrap_or_else(|| "The turn failed.".into())),
        (Some(t), None) if t.status == ThreadStatus::Error => Outcome::Failed(t.error.clone().unwrap_or_else(|| "The turn failed.".into())),
        (Some(_), None) => Outcome::Failed("The agent stopped before it ended its turn".into()),
    };
    crate::agent::runner::finish(state, &run.id, outcome);
    ENDING.lock().unwrap().remove(&run.id);
}

/// The thread's latest turn (of its main conversation), and its result if it has ended.
async fn last_turn(backend: &AgentThreads, thread_id: &str) -> (Option<String>, Option<agent_threads::protocol::TurnResult>) {
    let Ok(snapshot) = backend.snapshot_window(thread_id, 50).await else { return (None, None) };
    let main = |i: &&Item| serde_json::to_value(*i).ok().is_some_and(|v| v["parent_id"].is_null());
    let turn_of = |i: &Item| serde_json::to_value(i).ok().and_then(|v| v["turn_id"].as_str().map(String::from));
    let Some(latest) = snapshot.items.iter().rev().filter(main).find_map(turn_of) else { return (None, None) };
    let result = snapshot.items.iter().rev().find_map(|i| match i {
        Item::TurnResult(r) if r.parent_id.is_none() && r.turn_id.as_deref() == Some(latest.as_str()) => Some(r.clone()),
        _ => None,
    });
    (Some(latest), result)
}

/// The turn running on the thread now, if one is.
async fn running_turn(backend: &AgentThreads, thread_id: &str) -> Option<String> {
    match last_turn(backend, thread_id).await {
        (Some(t), None) => Some(t),
        _ => None,
    }
}

// ---------- harness output ----------

/// What a legacy run takes from the agent's own output that the crate's items leave out (see
/// runner::handle_line): the session, the tools it saw, rate limits, and cost.
fn on_harness_message(state: &Shared, m: &HarnessMessage) {
    let Some(v) = &m.message else { return };
    if m.harness != "claude" {
        return;
    }
    if let Err(e) = claude_line(state, &m.thread_id, v) {
        tracing::warn!(task = %m.thread_id, "reading the agent's output: {e:#}");
    }
}

fn claude_line(state: &Shared, task_id: &str, v: &Value) -> Result<()> {
    let config = |state: &Shared| -> Result<Option<db::ClaudeConfig>> {
        let c = state.db();
        Ok(db::get_task(&c, task_id)?.map(|t| db::task_claude_config(&c, &t)).transpose()?.flatten())
    };
    match v["type"].as_str().unwrap_or("") {
        "system" if v["subtype"] == "init" => {
            let c = state.db();
            if let Some(t) = db::get_task(&c, task_id)?.filter(|t| t.project_id.is_some()) {
                let config = db::task_claude_config(&c, &t)?;
                crate::agent::agent_tools::record_seen(&c, t.project_id.as_deref().unwrap(), config.as_ref().map(|c| c.id.as_str()), v)?;
            }
        }
        "rate_limit_event" => {
            if let Some(config) = config(state)? {
                crate::agent::usage::on_rate_limit_event(state, &config.id, v);
            }
        }
        "assistant" if v["api_error"] == "usage_limit_reached" && v["api_error_params"]["rate_limit_info"].is_object() => {
            if let Some(config) = config(state)? {
                crate::agent::usage::on_rate_limit_event(state, &config.id, &json!({"rate_limit_info": v["api_error_params"]["rate_limit_info"]}));
            }
        }
        "result" => {
            if v["api_error"] == "usage_limit_reached"
                && let Some(config) = config(state)?
            {
                crate::agent::usage::ran_out(state, task_id, &config.id);
            }
            // The session's running total, as runner::claude_result keeps it.
            let Some(total) = v["total_cost_usd"].as_f64() else { return Ok(()) };
            let Some(run) = current_run(state, task_id)? else { return Ok(()) };
            let counted = v["modelUsage"].as_object().is_some_and(|m| !m.is_empty());
            let cost = db::add_cost(&state.db(), &run.id, v["session_id"].as_str(), total, counted)?;
            let task = db::get_task(&state.db(), task_id)?;
            if let Some(t) = task {
                state.update_task(task_id, &[("cost_usd", json!(t.cost_usd + cost))])?;
            }
        }
        _ => {}
    }
    Ok(())
}

// ---------- permissions ----------

/// Whether a tool is one `allowed` lets the agent use without asking: a tool's name, or an MCP server's prefix.
fn is_allowed(allowed: &[String], name: &str) -> bool {
    allowed.iter().any(|a| a == name || name.strip_prefix(a.as_str()).is_some_and(|rest| rest.starts_with("__")))
}

/// The threads' permission policy: what the run's allowed tools don't cover is the board's own prompt (see
/// mcp::permissions::prompt), with its always-allowed tools, the thread's mode as it is now, and the user's
/// answer from the thread's permission card.
fn policy(state: Weak<AppState>) -> PermissionPolicy {
    PermissionPolicy::from_async(move |q, ctx| {
        let state = state.clone();
        async move {
            let Some(s) = state.upgrade() else { return PermissionDecision::deny("The server is stopping") };
            let Some(task_id) = ctx.metadata.get("task_id").and_then(Value::as_str).map(String::from) else {
                return PermissionDecision::Ask;
            };
            let Ok(Some(task)) = db::get_task(&s.db(), &task_id) else { return PermissionDecision::deny("The task is gone") };
            // As Claude Code names it (and the board's prompts, auto-allow and allowed tools do).
            let (name, input) = match (&q.server, &q.command) {
                (Some(server), _) => (format!("mcp__{server}__{}", q.name), q.input.clone()),
                (None, Some(command)) if q.kind == agent_threads::protocol::ToolKind::Shell && ctx.thread.harness == "codex" => {
                    ("Bash".to_string(), json!({"command": command}))
                }
                _ => (q.name.clone(), q.input.clone()),
            };
            let allowed = ALLOWED.lock().unwrap().get(&task_id).cloned().unwrap_or_default();
            if is_allowed(&allowed.tools, &name) {
                return PermissionDecision::Allow;
            }
            let call_id = format!("at-{task_id}-{}", q.tool_call_id.clone().unwrap_or_else(crate::util::new_id));
            match crate::mcp::permissions::prompt(&s, &task, &call_id, &name, &input, q.tool_call_id.as_deref()).await {
                Ok(v) if v["behavior"] == "allow" => PermissionDecision::Allow,
                Ok(v) => PermissionDecision::Deny(v["message"].as_str().map(String::from)),
                Err(e) => PermissionDecision::deny(format!("{e:#}")),
            }
        }
    })
}

#[cfg(test)]
mod tests;
