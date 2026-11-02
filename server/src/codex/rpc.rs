//! A JSON-RPC client for `codex app-server`: requests, their responses, and replies to the server's
//! requests.

use super::*;

type Pending = Arc<std::sync::Mutex<HashMap<i64, oneshot::Sender<Result<Value>>>>>;

/// One `codex app-server` process. Messages are JSON lines without a `jsonrpc` field.
pub(super) struct Rpc {
    pub(super) child: Child,
    out: mpsc::UnboundedSender<String>,
    pending: Pending,
    next: AtomicI64,
    /// Notifications and requests from the server, in order.
    pub(super) incoming: mpsc::UnboundedReceiver<Value>,
}

impl Rpc {
    pub(super) fn start(codex_home: Option<&str>, cwd: &Path) -> Result<Self> {
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

    pub(super) fn sender(&self) -> Responder {
        Responder(self.out.clone())
    }

    pub(super) async fn request(&self, method: &str, params: Value) -> Result<Value> {
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
    pub(super) async fn initialize(&self) -> Result<Value> {
        let info = json!({"name": "huntaway", "title": "Huntaway", "version": env!("CARGO_PKG_VERSION")});
        let r = self.request("initialize", json!({"clientInfo": info, "capabilities": {"experimentalApi": true}})).await?;
        self.notify("initialized");
        Ok(r)
    }
}

/// Answers the server's requests; cloneable into the tasks that wait on the board.
#[derive(Clone)]
pub(super) struct Responder(pub(super) mpsc::UnboundedSender<String>);

impl Responder {
    pub(super) fn result(&self, id: &Value, result: Value) {
        let _ = self.0.send(json!({"id": id, "result": result}).to_string());
    }

    pub(super) fn error(&self, id: &Value, message: &str) {
        let _ = self.0.send(json!({"id": id, "error": {"code": -32601, "message": message}}).to_string());
    }
}
