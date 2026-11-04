//! The adapter, `huntaway codex-run`: runs Codex turns for a run, with its MCP servers, input and
//! approvals.

use super::*;

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
pub(crate) fn mcp_server_config(name: &str, c: &Value, approved: bool, disabled: &[String], review_waits: bool) -> Option<Value> {
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
        out.insert("tool_timeout_sec".into(), json!(crate::mcp::wait::MAX_SECS + 300));
    } else if name == crate::mcp::gh_mcp::SERVER_NAME {
        // As can gh.
        out.insert("tool_timeout_sec".into(), json!(600));
    } else if crate::agent::assistant::google::is_google(name) {
        // uvx fetches workspace-mcp the first time, which takes longer than Codex's 10s default for a start.
        out.insert("startup_timeout_sec".into(), json!(120));
    }
    if approved || name == MCP_SERVER_NAME {
        out.insert("default_tools_approval_mode".into(), json!("approve"));
    }
    if name == MCP_SERVER_NAME && review_waits {
        // Every wait goes to the reviewer, which sees its arguments: a wait's command runs as
        // the agent's own commands would (see mcp/tools.rs).
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
        if let Some(mut cfg) = mcp_server_config(name, c, spec.approved_mcp_servers.contains(name), disabled, spec.review_waits) {
            // The user's approval rules (see agent/approval_rules.rs) may ask about its calls, or turn it off.
            let on = match (&spec.approval_rules, cfg.as_object_mut()) {
                (Some(rules), Some(cfg)) => crate::agent::approval_rules::codex_server(rules, name, cfg),
                _ => true,
            };
            if on {
                servers.insert(name.clone(), cfg);
            }
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
    // For the board's count of the tokens each model used (see agent/tokens.rs).
    if let Some(m) = &model {
        emit(&json!({"method": "huntaway/model", "params": {"threadId": thread_id, "model": m}}));
    }
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

pub(super) fn file_changes(item: Option<&Value>) -> Value {
    let changes = item.and_then(|i| i["changes"].as_array()).cloned().unwrap_or_default();
    json!(changes
        .iter()
        .map(|c| json!({"path": c["path"], "kind": c["kind"]["type"], "move_path": c["kind"]["move_path"], "diff": c["diff"]}))
        .collect::<Vec<_>>())
}

/// Answer one of the app-server's requests: approvals go to the board like Claude's
/// permission prompts, so the user approves them in the thread.
pub(super) async fn answer(board: Arc<crate::mcp::Ctx>, reply: Responder, msg: Value, item: Option<Value>) {
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
            let board = crate::agent::runner::is_board_server(server);
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
                    None => ask(&format!("{}__wait", crate::agent::agent_tools::tool_prefix(server)), json!({"message": message})).await,
                };
                reply.result(id, json!({"action": if ok { "accept" } else { "decline" }, "content": if ok { json!({}) } else { Value::Null }}));
            } else if board {
                // The board's own tools never need approval.
                reply.result(id, json!({"action": "accept", "content": {}}));
            } else {
                let tool = format!("{}__{tool}", crate::agent::agent_tools::tool_prefix(server));
                // With what it's called with, when Codex says (for the user, and the action log).
                let mut input = json!({"message": message});
                if params.is_object() {
                    input["arguments"] = params.clone();
                }
                let ok = ask(&tool, input).await;
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
            let args = json!({"tool_name": crate::mcp::permissions::CODEX_QUESTIONS, "input": {"questions": questions}, "tool_use_id": p["itemId"]});
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
