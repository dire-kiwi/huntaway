//! A legacy-relay broker for the TypeScript server's tests (server-ts/src/hosts/broker/tests.test.ts), which need the
//! limits the Rust tests set through `Config` and the binary has no flags for:
//!
//! ```text
//! test_broker --token <token> [--max-streams N] [--stall-ms MS]
//! ```
//!
//! It listens on a free port on 127.0.0.1 and prints its URL on the first line of stdout.

use std::time::Duration;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut cfg = huntaway_broker::Config::default();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let mut value = || args.next().ok_or_else(|| anyhow::anyhow!("{arg} needs a value"));
        match arg.as_str() {
            "--token" => cfg.token = value()?,
            "--max-streams" => cfg.max_streams = value()?.parse()?,
            "--stall-ms" => cfg.stall = Duration::from_millis(value()?.parse()?),
            other => anyhow::bail!("unexpected argument {other}"),
        }
    }
    let app = huntaway_broker::router(cfg)?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    println!("http://{}", listener.local_addr()?);
    axum::serve(listener, app).await?;
    Ok(())
}
