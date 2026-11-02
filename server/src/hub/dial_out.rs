//! Dialling out: this node as a host of someone else's hub, serving the requests it tunnels.

use super::*;

/// Keep a tunnel open to `hub`, answering its requests from our own API.
pub fn dial_out(s: &Shared, hub: String, token: String) {
    let s = s.clone();
    tokio::spawn(async move {
        let mut backoff = 1;
        loop {
            match tunnel_to(&s, &hub, &token).await {
                Ok(()) => backoff = 1,
                Err(e) => tracing::warn!("hub {hub}: {e:#}"),
            }
            tokio::time::sleep(Duration::from_secs(backoff)).await;
            backoff = (backoff * 2).min(30);
        }
    });
}

pub(super) async fn tunnel_to(s: &Shared, hub: &str, token: &str) -> Result<()> {
    let hub = crate::broker::resolve(hub, None).await?;
    let url = format!("{}/api/hub/connect", hub.trim_end_matches('/').replacen("http", "ws", 1));
    let mut req = url.into_client_request()?;
    req.headers_mut().insert("Authorization", format!("Bearer {token}").parse()?);
    let (mut sink, mut stream) = relay::open(req).await?.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Up>();
    tx.send(Up::Hello {
        host_id: s.host_id.clone(),
        name: s.host_name.clone(),
        version: env!("CARGO_PKG_VERSION").into(),
        protocol: PROTOCOL,
        api_version: API_VERSION,
        api_compat: API_COMPAT,
    })?;
    // Websocket pings rather than a message of the tunnel's own, which hubs from before `Down::Ping`
    // would log as bad. Through a broker that answers them, we hear from the hub by its `Down::Ping`.
    let writer = tokio::spawn(async move {
        let mut ping = tokio::time::interval(PING);
        loop {
            let msg = tokio::select! {
                msg = rx.recv() => match msg {
                    Some(msg) => TMessage::Text(serde_json::to_string(&msg).unwrap_or_default().into()),
                    None => break,
                },
                _ = ping.tick() => TMessage::Ping(Default::default()),
            };
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });
    let events = {
        let (s, tx) = (s.clone(), tx.clone());
        tokio::spawn(async move {
            let mut ev = s.events.subscribe();
            loop {
                match ev.recv().await {
                    Ok(event) => {
                        if tx.send(Up::Event { event }).is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        let _ = tx.send(Up::Event { event: json!({"type": "resync"}) });
                    }
                    Err(_) => break,
                }
            }
        })
    };
    tracing::info!("connected to hub {hub}");
    let streams: HubStreams = Arc::default();
    let result = async {
        loop {
            let text = match tokio::time::timeout(SILENCE, stream.next()).await {
                Err(_) => bail!("nothing from the hub for {}s", SILENCE.as_secs()),
                Ok(None) => return Ok(()),
                Ok(Some(msg)) => match msg? {
                    TMessage::Text(t) => t.to_string(),
                    TMessage::Close(Some(f)) if u16::from(f.code) == REFUSED => bail!("refused: {}", f.reason),
                    TMessage::Close(_) => return Ok(()),
                    _ => continue,
                },
            };
            tunnel_message(s, &text, &tx, &streams);
        }
    }
    .await;
    // Dropping the senders closes the relayed websockets.
    streams.lock().unwrap().clear();
    events.abort();
    writer.abort();
    result
}

/// Websockets the hub opened on our API, by id.
type HubStreams = Arc<Mutex<HashMap<u64, mpsc::UnboundedSender<Frame>>>>;

/// Act on a message from the hub.
fn tunnel_message(s: &Shared, text: &str, tx: &mpsc::UnboundedSender<Up>, streams: &HubStreams) {
    match serde_json::from_str::<Down>(text) {
        Ok(Down::Req { id, method, path, body }) => {
            let (s, tx) = (s.clone(), tx.clone());
            tokio::spawn(async move {
                let (status, body) = match local_request(&s, &method, &path, body.map(|b| b.to_string().into_bytes())).await {
                    Ok(r) => r,
                    Err(e) => (500, json!({"error": format!("{e:#}")})),
                };
                let _ = tx.send(Up::Res { id, status, body });
            });
        }
        Ok(Down::WsOpen { id, path }) => {
            // Registered right away: the hub's first messages can arrive while we connect.
            let (hub_tx, hub_rx) = mpsc::unbounded_channel();
            streams.lock().unwrap().insert(id, hub_tx);
            let (s, tx, streams) = (s.clone(), tx.clone(), streams.clone());
            tokio::spawn(async move {
                relay_local(&s, id, &path, hub_rx, &tx).await;
                streams.lock().unwrap().remove(&id);
            });
        }
        Ok(Down::WsMsg { id, text, data }) => {
            if let (Some(w), Some(f)) = (streams.lock().unwrap().get(&id), Frame::from_wire(text, data)) {
                let _ = w.send(f);
            }
        }
        Ok(Down::WsClose { id }) => {
            if let Some(w) = streams.lock().unwrap().remove(&id) {
                let _ = w.send(Frame::Close(None));
            }
        }
        Ok(Down::Ping) => {
            let _ = tx.send(Up::Pong);
        }
        Err(_) => {}
    }
}

/// Open a websocket on our own API for the hub and relay it until either side closes.
async fn relay_local(s: &Shared, id: u64, path: &str, mut from_hub: mpsc::UnboundedReceiver<Frame>, to_hub: &mpsc::UnboundedSender<Up>) {
    let url = format!("{}{path}", s.internal_url.replacen("http", "ws", 1));
    let (local_tx, mut local_rx) = match relay::connect(&url, &s.token).await {
        Ok(p) => p,
        Err(e) => {
            let _ = to_hub.send(Up::WsClose { id, code: Some(1011), reason: Some(format!("{e:#}")) });
            return;
        }
    };
    loop {
        tokio::select! {
            f = from_hub.recv() => {
                let f = f.unwrap_or(Frame::Close(None));
                let close = matches!(f, Frame::Close(_));
                if local_tx.send(f).is_err() || close {
                    break;
                }
            }
            f = local_rx.recv() => match f.unwrap_or(Frame::Close(None)) {
                Frame::Close(c) => {
                    let (code, reason) = c.unzip();
                    let _ = to_hub.send(Up::WsClose { id, code, reason });
                    break;
                }
                f => {
                    let (text, data) = f.to_wire();
                    if to_hub.send(Up::WsMsg { id, text, data }).is_err() {
                        break;
                    }
                }
            },
        }
    }
}

/// Run a request against this node's own host API (as an authenticated caller).
pub(super) async fn local_request(s: &Shared, method: &str, path: &str, body: Option<Vec<u8>>) -> Result<(u16, Value)> {
    let router: Router = s.local_router.get().context("router not ready")?.clone();
    let mut req = axum::http::Request::builder()
        .method(method)
        .uri(path)
        .header("authorization", format!("Bearer {}", s.token))
        .header("content-type", "application/json")
        .body(Body::from(body.unwrap_or_default()))?;
    req.extensions_mut().insert(axum::extract::ConnectInfo(std::net::SocketAddr::from(([127, 0, 0, 1], 0))));
    let res = router.oneshot(req).await?;
    let status = res.status().as_u16();
    let bytes = axum::body::to_bytes(res.into_body(), 64 << 20).await?;
    let text = String::from_utf8_lossy(&bytes).to_string();
    Ok((status, serde_json::from_str(&text).unwrap_or(Value::String(text))))
}
