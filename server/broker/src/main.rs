//! `huntaway-broker`: see the library's comment, and server/broker/README.md.

use anyhow::{Context, Result, bail};
use clap::Parser;

#[derive(Parser)]
#[command(name = "huntaway-broker", about = "Relay for Huntaway hosts: they dial out to it, and browsers and hubs reach them through it")]
struct Args {
    /// Address to listen on. Serve it behind a TLS proxy: it speaks plain HTTP.
    #[arg(long, env = "BROKER_HOST", default_value = "0.0.0.0")]
    host: String,
    #[arg(long, env = "BROKER_PORT", default_value_t = 8080)]
    port: u16,
    /// The token hosts connect with (`huntaway serve --broker-token`). Prefer the environment
    /// variable over the flag.
    #[arg(long, env = "BROKER_TOKEN", hide_env_values = true)]
    token: String,
    /// The host for requests that don't pick one (by cookie, header or path).
    #[arg(long, env = "BROKER_DEFAULT_HOST")]
    default_host: Option<String>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "huntaway_broker=info".into()))
        .with_ansi(std::io::IsTerminal::is_terminal(&std::io::stdout()))
        .init();
    let args = Args::parse();
    let token = args.token.trim().to_string();
    if token.len() < 16 {
        bail!("the broker token needs at least 16 characters");
    }
    let default_host = args.default_host.map(|h| h.trim().to_string()).filter(|h| !h.is_empty());
    if let Some(h) = default_host.as_deref().filter(|h| !huntaway_broker::proto::valid_name(h)) {
        bail!("bad default host {h:?}: use up to 48 lowercase letters, digits and hyphens");
    }
    let listener = tokio::net::TcpListener::bind((args.host.as_str(), args.port)).await.with_context(|| format!("binding {}:{}", args.host, args.port))?;
    tracing::info!("listening on http://{}", listener.local_addr()?);
    let app = huntaway_broker::router(huntaway_broker::Config { token, default_host });
    axum::serve(listener, app).with_graceful_shutdown(shutdown()).await?;
    Ok(())
}

async fn shutdown() {
    let ctrl_c = tokio::signal::ctrl_c();
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("signal handler");
    tokio::select! { _ = ctrl_c => {}, _ = term.recv() => {} }
}
