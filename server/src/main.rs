// The tool list in mcp.rs is one json! value, deeper than the default limit lets the macro expand.
#![recursion_limit = "256"]

mod admin;
mod agent_tools;
mod attachments;
mod automations;
mod broker;
mod codex;
mod context;
mod analytics;
mod changes;
mod checkpoints;
mod api;
mod asana;
mod db;
mod demo;
mod disk;
mod documents;
mod fanout;
mod gh_mcp;
mod git_view;
mod github;
mod hub;
mod mcp;
mod merged;
mod permissions;
mod pr_watch;
mod prompts;
mod questions;
mod proto;
mod pty;
mod push;
mod relay;
mod relocate;
mod review;
mod runner;
mod runs;
mod ssh;
mod state;
mod status_script;
mod terminal;
#[cfg(test)]
mod testing;
mod title;
mod tools;
mod usage;
mod wait;
mod util;
mod worktree;
mod worktree_files;

use std::io::Write;
use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use tower_http::services::{ServeDir, ServeFile};

#[derive(Parser)]
#[command(name = "huntaway", about = "Kanban board that orchestrates Claude Code and Codex agents")]
struct Cli {
    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run the server (default).
    Serve(ServeArgs),
    /// Stdio MCP server used by agents to talk to the board (spawned by claude).
    Mcp,
    /// Stdio MCP server that runs the GitHub CLI for agents, outside their sandbox (spawned by claude).
    GhMcp,
    /// Claude Code hook that turns away gh in Bash, for the gh MCP server's tools (run by claude).
    #[command(hide = true)]
    GhHook,
    /// gh for a wait's command, as its task's GitHub account (see gh_mcp::gh_run).
    #[command(hide = true)]
    GhRun {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    /// Run one turn of a Codex agent through `codex app-server` (started under ia-shim).
    #[command(hide = true)]
    CodexRun { spec: String },
    /// Forced command for a hub's SSH key: start a host here if needed, print how to reach it.
    SshHost {
        #[arg(long, default_value_t = 7878)]
        port: u16,
        #[arg(long, env = "IA_DATA_DIR")]
        data_dir: Option<PathBuf>,
        #[arg(long)]
        name: Option<String>,
    },
    /// Print the titles tasks would get from their prompts now (see title::check), without changing them.
    #[command(hide = true)]
    TitleCheck {
        /// The database, a copy of a live one: opening it migrates it.
        #[arg(long)]
        db: PathBuf,
        /// The title after each of the user's messages in turn.
        #[arg(long)]
        steps: bool,
        /// Print what the model is sent too.
        #[arg(long)]
        input: bool,
        /// Task ids.
        tasks: Vec<String>,
    },
    /// Print this host's access token (or, with --hub, the token hosts use to dial in).
    Token {
        #[arg(long, env = "IA_DATA_DIR")]
        data_dir: Option<PathBuf>,
        #[arg(long)]
        hub: bool,
    },
}

#[derive(Parser, Clone)]
struct ServeArgs {
    /// Address to bind. Use 127.0.0.1 to disable network access.
    #[arg(long, env = "IA_HOST", default_value = "0.0.0.0")]
    host: String,
    /// Port to listen on. 0 picks a free one (printed in the `IA_READY` line).
    #[arg(long, env = "IA_PORT", default_value_t = 7878)]
    port: u16,
    /// Where the database, scratch folders and worktrees live.
    #[arg(long, env = "IA_DATA_DIR")]
    data_dir: Option<PathBuf>,
    /// Built web UI to serve (app/dist).
    #[arg(long, env = "IA_UI_DIR")]
    ui_dir: Option<PathBuf>,
    /// Repository checkout to rebuild from when restarting from the UI
    /// (defaults to the checkout this binary was built in).
    #[arg(long, env = "IA_SOURCE_DIR")]
    source_dir: Option<PathBuf>,
    /// A deployment of the board (e.g. https://board.example) to follow: when it runs a newer commit
    /// than this server, the UI offers to update to it (fetched from the source checkout's origin).
    #[arg(long, env = "IA_UPDATE_FROM")]
    update_from: Option<String>,
    /// Name shown for this host on boards (defaults to the hostname).
    #[arg(long, env = "IA_NAME")]
    name: Option<String>,
    /// Hub to dial out to, so it shows this host without needing to reach us (repeatable).
    #[arg(long = "hub", env = "IA_HUB", value_delimiter = ',')]
    hubs: Vec<String>,
    /// Token for --hub (from that hub's Settings → Hosts).
    #[arg(long, env = "IA_HUB_TOKEN")]
    hub_token: Option<String>,
    /// Broker to dial out to (`huntaway-broker`), so this host can be reached through it from
    /// anywhere: the board in a browser, and the API from hubs.
    #[arg(long, env = "IA_BROKER")]
    broker: Option<String>,
    /// Token for --broker (the broker's BROKER_TOKEN). Prefer the environment variable over the flag.
    #[arg(long, env = "IA_BROKER_TOKEN", hide_env_values = true)]
    broker_token: Option<String>,
    /// Name to reach this host by on the broker (defaults to the host's name, as lowercase letters,
    /// digits and hyphens).
    #[arg(long, env = "IA_BROKER_NAME")]
    broker_name: Option<String>,
    /// Use this access token instead of the generated one in the data dir (e.g. one shared
    /// by deployments, set from a secret). Prefer the environment variable over the flag.
    #[arg(long = "token", env = "IA_TOKEN", hide_env_values = true)]
    access_token: Option<String>,
    /// On a fresh data dir, create a sample profile, project and tasks (for PR previews).
    #[arg(long, env = "IA_DEMO")]
    demo: bool,
    /// Give the access token to any browser that opens the board, so it signs in without
    /// `?token=` (for LAN-only PR previews; anyone who can reach the server gets full control).
    #[arg(long, env = "IA_OPEN_TOKEN")]
    open_token: bool,
    /// Make a profile NAME with the Claude config in DIR on start, unless there's a profile of
    /// that name already (repeatable, or comma-separated). For PR previews, with a login mounted in.
    #[arg(long = "profile", env = "IA_PROFILES", value_name = "NAME=DIR", value_delimiter = ',', value_parser = parse_profile)]
    profiles: Vec<Option<(String, String)>>,
}

/// A `--profile` value, `NAME=DIR`. A blank one is none, so a deployment can leave `IA_PROFILES=` empty.
fn parse_profile(s: &str) -> Result<Option<(String, String)>, String> {
    if s.trim().is_empty() {
        return Ok(None);
    }
    match s.split_once('=').map(|(name, dir)| (name.trim(), dir.trim())) {
        Some((name, dir)) if !name.is_empty() && !dir.is_empty() => Ok(Some((name.to_string(), dir.to_string()))),
        _ => Err(format!("{s:?} isn't NAME=DIR")),
    }
}

/// `<data dir>/huntaway`, or `<data dir>/issue-agent` on a machine that ran the board before it
/// was renamed to Huntaway (and has no `huntaway` dir yet), so existing data stays where it is.
fn default_data_dir() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    let (dir, legacy) = (base.join("huntaway"), base.join("issue-agent"));
    if !dir.exists() && legacy.is_dir() { legacy } else { dir }
}

/// The database in a data dir: `huntaway.db`, or `issue-agent.db` from before the rename.
fn db_path(data_dir: &std::path::Path) -> PathBuf {
    let (db, legacy) = (data_dir.join("huntaway.db"), data_dir.join("issue-agent.db"));
    if !db.exists() && legacy.is_file() { legacy } else { db }
}

/// A secret stored in the data dir, created on first use.
fn load_or_create_token(data_dir: &std::path::Path, file: &str) -> Result<String> {
    let path = data_dir.join(file);
    if let Ok(t) = std::fs::read_to_string(&path) {
        if !t.trim().is_empty() {
            return Ok(t.trim().to_string());
        }
    }
    let token = util::new_token();
    // Made private from the start, rather than with the umask's mode and tightened after.
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(&path)?.write_all(token.as_bytes())?;
    Ok(token)
}

fn find_ui_dir(explicit: Option<PathBuf>) -> Option<PathBuf> {
    if let Some(p) = explicit {
        return Some(p);
    }
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;
    [
        exe_dir.join("ui"),
        exe_dir.join("../ui"),
        exe_dir.join("../../../app/dist"), // server/target/{debug,release}/huntaway
    ]
    .into_iter()
    .find(|p| p.join("index.html").exists())
}

/// Browsers revalidate index.html on every load, so a new UI build shows up on the next reload
/// (without a Cache-Control header they may reuse a stale copy for hours). The hashed files under
/// /assets never change, so they're cached for good.
async fn ui_cache_control(req: axum::extract::Request, next: axum::middleware::Next) -> axum::response::Response {
    use axum::http::header::{HeaderValue, CACHE_CONTROL, CONTENT_TYPE};
    let asset = req.uri().path().starts_with("/assets/");
    let mut res = next.run(req).await;
    // A missing asset gets index.html (the SPA fallback), which mustn't be cached as that asset.
    let html = res.headers().get(CONTENT_TYPE).is_some_and(|v| v.as_bytes().starts_with(b"text/html"));
    let policy = if asset && !html && res.status().is_success() { "public, max-age=31536000, immutable" } else { "no-cache" };
    res.headers_mut().insert(CACHE_CONTROL, HeaderValue::from_static(policy));
    res
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.cmd {
        Some(Cmd::Mcp) => mcp::serve_stdio().await,
        Some(Cmd::GhMcp) => gh_mcp::serve_stdio().await,
        Some(Cmd::GhHook) => gh_mcp::bash_hook(),
        Some(Cmd::GhRun { args }) => std::process::exit(gh_mcp::gh_run(args).await?),
        Some(Cmd::CodexRun { spec }) => codex::run_adapter(&spec).await,
        Some(Cmd::Token { data_dir, hub }) => {
            let dir = data_dir.unwrap_or_else(default_data_dir);
            std::fs::create_dir_all(&dir)?;
            println!("{}", load_or_create_token(&dir, if hub { "hub_token" } else { "auth_token" })?);
            Ok(())
        }
        Some(Cmd::TitleCheck { db, steps, input, tasks }) => title::check(&db, &tasks, steps, input).await,
        Some(Cmd::Serve(args)) => serve(args).await,
        Some(Cmd::SshHost { port, data_dir, name }) => ssh::ssh_host(port, data_dir.unwrap_or_else(default_data_dir), name).await,
        None => serve(ServeArgs::parse_from(["huntaway"])).await,
    }
}

/// `--open-token`'s route: the token for whoever asks, but not through a broker (where whoever
/// asks could be anyone).
fn open_token(token: String) -> impl Fn(axum::http::HeaderMap) -> std::future::Ready<axum::response::Response> + Clone {
    move |headers| {
        use axum::response::IntoResponse;
        std::future::ready(if headers.contains_key(broker::VIA_BROKER) {
            (axum::http::StatusCode::NOT_FOUND, axum::Json(api::no_route_error("GET", "/api/open-token"))).into_response()
        } else {
            axum::Json(serde_json::json!({ "token": token })).into_response()
        })
    }
}

async fn serve(args: ServeArgs) -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "huntaway=info".into()))
        .init();
    admin::reap_inherited();
    let data_dir = args.data_dir.unwrap_or_else(default_data_dir);
    std::fs::create_dir_all(&data_dir).with_context(|| format!("creating {}", data_dir.display()))?;
    let data_dir = data_dir.canonicalize()?;
    let token = match args.access_token.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => t.to_string(),
        None => load_or_create_token(&data_dir, "auth_token")?,
    };
    let hub_token = load_or_create_token(&data_dir, "hub_token")?;
    let host_id = load_or_create_token(&data_dir, "host_id")?;
    let host_name = args.name.clone().filter(|n| !n.trim().is_empty()).unwrap_or_else(|| {
        std::fs::read_to_string("/proc/sys/kernel/hostname").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "host".into()).trim().to_string()
    });
    let conn = db::open(&db_path(&data_dir))?;
    let listener = tokio::net::TcpListener::bind((args.host.as_str(), args.port))
        .await
        .with_context(|| format!("binding {}:{}", args.host, args.port))?;
    // The bound port, which differs from args.port with --port 0.
    let port = listener.local_addr()?.port();
    let internal_url = format!("http://127.0.0.1:{port}");
    let source_dir = admin::detect_source_dir(args.source_dir.clone());
    // Without a checkout (e.g. deployed from a CI bundle), the deployment says which commit it is.
    let running_commit = match &source_dir {
        Some(src) => admin::head_commit(src).await,
        None => std::env::var("IA_COMMIT").ok().map(|c| c.trim().to_string()).filter(|c| !c.is_empty()),
    };
    let meta = admin::ServerMeta {
        boot_id: util::new_id(),
        started_at: util::now(),
        source_dir,
        running_commit,
        update_from: args.update_from.clone().map(|u| u.trim().trim_end_matches('/').to_string()).filter(|u| !u.is_empty()),
        args: std::env::args_os().skip(1).collect(),
    };
    let identity = state::Identity { host_id, host_name, token: token.clone(), hub_token, internal_url };
    let state = state::AppState::new(conn, data_dir.clone(), identity, meta);
    if args.demo {
        demo::seed(&state).await.context("seeding the demo project")?;
    }
    // After the demo, which only seeds a host that has no profiles.
    for (name, dir) in args.profiles.iter().flatten() {
        let made = db::ensure_profile(&state.db(), name, dir).with_context(|| format!("making profile {name}"))?;
        if let Some(p) = made {
            std::fs::create_dir_all(state.profile_scratch_dir(&p.id))?;
            tracing::info!("made profile {name} with the Claude config in {dir}");
            if !util::expand_tilde(dir).is_dir() {
                tracing::warn!("profile {name}'s Claude config {dir} isn't a directory here");
            }
        }
    }
    let mut app = api::router(state.clone());
    match find_ui_dir(args.ui_dir) {
        Some(ui) => {
            tracing::info!("serving UI from {}", ui.display());
            let files = ServeDir::new(&ui).fallback(ServeFile::new(ui.join("index.html")));
            app = app.fallback_service(axum::Router::new().fallback_service(files).layer(axum::middleware::from_fn(ui_cache_control)));
        }
        None => tracing::warn!("no UI build found; API only (build app/ or pass --ui-dir)"),
    }
    let mut app = app.layer(tower_http::cors::CorsLayer::permissive());
    // Added after the CORS layer, so other sites' pages can't read the token.
    if args.open_token {
        tracing::warn!("--open-token: handing the access token to every browser that opens the board");
        let token = token.clone();
        app = app.route("/api/open-token", axum::routing::get(open_token(token)));
    }

    // Agents kept running while we were down; catch up on their output.
    runner::load_active(&state)?;
    runner::auto_compact(&state);
    usage::resume_loop(&state);
    pr_watch::watch_in_review(&state);
    terminal::start_reaper(&state);
    attachments::start_pruner(&state);
    runs::start_pruner(&state);
    automations::start(&state);
    merged::start(&state);
    relocate::start_recording(&state);
    admin::start_update_check(&state);
    hub::start(&state)?;
    push::start(&state);
    match (&args.hub_token, args.hubs.is_empty()) {
        (Some(t), false) => {
            for h in &args.hubs {
                hub::dial_out(&state, h.clone(), t.clone());
            }
        }
        (None, false) => tracing::warn!("--hub needs --hub-token"),
        _ => {}
    }
    if let Some(url) = args.broker.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
        let name = args.broker_name.as_deref().map(str::trim).filter(|n| !n.is_empty()).map(String::from);
        match (args.broker_token.as_deref().map(str::trim).filter(|t| !t.is_empty()), name) {
            (None, _) => tracing::warn!("--broker needs --broker-token"),
            (Some(_), Some(n)) if !huntaway_broker::proto::valid_name(&n) => {
                tracing::warn!("bad --broker-name {n:?}: use up to 48 lowercase letters, digits and hyphens")
            }
            (Some(t), name) => {
                let name = name.unwrap_or_else(|| huntaway_broker::proto::slug(&state.host_name));
                broker::dial_out(&state, url.to_string(), t.to_string(), name, load_or_create_token(&data_dir, "broker_key")?);
            }
        }
    }
    tracing::info!("host {} ({})", state.host_name, state.host_id);
    tracing::info!("data dir: {}", data_dir.display());
    // A token from IA_TOKEN is a shared secret managed elsewhere; keep it out of the logs.
    let token_from_env = args.access_token.as_deref().is_some_and(|t| !t.trim().is_empty());
    if token_from_env {
        tracing::info!("listening on http://{}:{port}/ (token from IA_TOKEN)", args.host);
    } else {
        tracing::info!("listening on http://{}:{port}/?token={}", args.host, token);
    }
    // Machine-readable line for the Electron shell.
    let ready_token = if token_from_env { None } else { Some(&token) };
    println!("IA_READY {}", serde_json::json!({"port": port, "token": ready_token}));
    // Agents keep running under ia-shim; we pick them up again on the next start.
    axum::serve(listener, app).with_graceful_shutdown(shutdown_signal()).await?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("signal handler");
        tokio::select! { _ = ctrl_c => {}, _ = term.recv() => {} }
    }
    #[cfg(not(unix))]
    let _ = ctrl_c.await;
    tracing::info!("shutting down");
    // Agents' permission prompts are long-polls that would hold a graceful shutdown open.
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_secs(2));
        std::process::exit(0);
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn db_path_keeps_the_database_from_before_the_rename() {
        let dir = crate::testing::temp_dir();
        assert_eq!(super::db_path(&dir), dir.join("huntaway.db"));
        std::fs::write(dir.join("issue-agent.db"), "").unwrap();
        assert_eq!(super::db_path(&dir), dir.join("issue-agent.db"));
        std::fs::write(dir.join("huntaway.db"), "").unwrap();
        assert_eq!(super::db_path(&dir), dir.join("huntaway.db"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn profile_flags_take_name_dir_pairs() {
        use clap::Parser;
        let args = super::ServeArgs::try_parse_from(["huntaway", "--profile", "personal=/claude/personal", "--profile", "a = ~/.a,b=/b=c,"]).unwrap();
        let pair = |n: &str, d: &str| Some((n.to_string(), d.to_string()));
        assert_eq!(args.profiles, [pair("personal", "/claude/personal"), pair("a", "~/.a"), pair("b", "/b=c"), None]);
        // As from an empty IA_PROFILES.
        assert_eq!(super::ServeArgs::try_parse_from(["huntaway", "--profile", ""]).unwrap().profiles, [None]);
        for bad in ["personal", "=/claude", "personal=", "personal=/a,b"] {
            assert!(super::ServeArgs::try_parse_from(["huntaway", "--profile", bad]).is_err(), "{bad}");
        }
    }
}
