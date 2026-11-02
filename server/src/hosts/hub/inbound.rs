//! The inbound tunnel: hosts started with `--hub` dial `/api/hub/connect`, and requests to them
//! go back over that websocket.

use super::*;

/// The close code a hub refuses a host's tunnel with (a policy violation).
pub(super) const REFUSED: u16 = 1008;

pub async fn accept(State(s): State<Shared>, headers: HeaderMap, upgrade: WebSocketUpgrade) -> Response {
    let token = headers.get("authorization").and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer "));
    if !token.is_some_and(|t| crate::util::same_secret(t, &s.hub_token)) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    upgrade.on_upgrade(move |ws| async move {
        if let Err(e) = serve_tunnel(s, ws).await {
            tracing::warn!("hosted tunnel ended: {e:#}");
        }
    })
}

async fn serve_tunnel(s: Shared, ws: WebSocket) -> Result<()> {
    let (mut sink, mut stream) = ws.split();
    let hello = tokio::time::timeout(Duration::from_secs(10), stream.next()).await.context("no hello")?;
    let (host_id, name, version) = match hello {
        Some(Ok(WsMessage::Text(t))) => match serde_json::from_str::<Up>(&t)? {
            Up::Hello { host_id, name, protocol, version, api_version, api_compat } if protocol == PROTOCOL => {
                (host_id, name, Version { version, api_version, api_compat, commit: None, agents: true, updates_from: None })
            }
            Up::Hello { protocol, .. } => bail!("host speaks protocol {protocol}, we speak {PROTOCOL}"),
            _ => bail!("expected hello"),
        },
        _ => bail!("expected hello"),
    };
    if host_id == s.host_id {
        bail!("a host can't link to itself");
    }
    let (tx, mut rx) = mpsc::unbounded_channel::<Down>();
    let kind = Kind::Tunnel { tx, pending: Mutex::new(HashMap::new()), streams: Mutex::new(HashMap::new()), next: AtomicU64::new(1) };
    let conn = Arc::new(LinkConn::new(&host_id, &name, "inbound", version, kind));
    let Some(_registered) = register(&s, conn.clone()) else {
        let reason = format!("host {host_id} is already connected to this hub");
        let _ = sink.send(WsMessage::Close(Some(axum::extract::ws::CloseFrame { code: REFUSED, reason: reason.clone().into() }))).await;
        bail!("{name}: {reason}");
    };
    db::note_inbound_link(&s.db(), &host_id, &name)?;
    let writer = tokio::spawn(async move {
        let mut ping = tokio::time::interval(PING);
        loop {
            let msgs = tokio::select! {
                msg = rx.recv() => match msg {
                    Some(msg) => vec![WsMessage::Text(serde_json::to_string(&msg).unwrap_or_default().into())],
                    None => break,
                },
                // A websocket ping for hosts from before `Down::Ping`, which answer it whatever their
                // version; `Down::Ping` for the others, which gets through a broker.
                _ = ping.tick() => vec![WsMessage::Ping(Default::default()), WsMessage::Text(serde_json::to_string(&Down::Ping).unwrap_or_default().into())],
            };
            for msg in msgs {
                if sink.send(msg).await.is_err() {
                    return;
                }
            }
        }
    });
    forward_event(&s, &host_id, json!({"type": "resync"}));
    tracing::info!("host {name} connected in");
    // The hello doesn't carry the commit; ask once the tunnel is up.
    {
        let (s, conn) = (s.clone(), conn.clone());
        tokio::spawn(async move {
            if let Ok((200, info)) = conn.request("GET", "/api/info", None).await {
                *conn.version.lock().unwrap() = Version::from_info(&info);
                changed(&s);
            }
        });
    }
    // A websocket pong needn't come from the host: through a broker, it's our own relay to the broker that
    // answers our pings. So once the host has answered a `Down::Ping`, only its messages count.
    let mut answers_pings = false;
    let mut deadline = tokio::time::Instant::now() + SILENCE;
    loop {
        let msg = match tokio::time::timeout_at(deadline, stream.next()).await {
            Ok(msg) => msg,
            Err(_) => {
                tracing::info!("nothing from host {name} for {}s", SILENCE.as_secs());
                break;
            }
        };
        let text = match msg {
            Some(Ok(WsMessage::Text(t))) => Some(t.to_string()),
            Some(Ok(WsMessage::Close(_)) | Err(_)) | None => break,
            _ => None,
        };
        if text.is_some() || !answers_pings {
            conn.heard();
            deadline = tokio::time::Instant::now() + SILENCE;
        }
        let Some(text) = text else { continue };
        match serde_json::from_str::<Up>(&text) {
            Ok(Up::Res { id, status, body }) => {
                if let Kind::Tunnel { pending, .. } = &conn.kind {
                    if let Some(w) = pending.lock().unwrap().remove(&id) {
                        let _ = w.send((status, body));
                    }
                }
            }
            Ok(Up::Event { event }) => forward_event(&s, &host_id, event),
            Ok(Up::WsMsg { id, text, data }) => {
                if let (Kind::Tunnel { streams, .. }, Some(f)) = (&conn.kind, Frame::from_wire(text, data)) {
                    if let Some(w) = streams.lock().unwrap().get(&id) {
                        let _ = w.send(f);
                    }
                }
            }
            Ok(Up::WsClose { id, code, reason }) => {
                if let Kind::Tunnel { streams, .. } = &conn.kind {
                    if let Some(w) = streams.lock().unwrap().remove(&id) {
                        let _ = w.send(Frame::Close(code.map(|c| (c, reason.unwrap_or_default()))));
                    }
                }
            }
            Ok(Up::Pong) => answers_pings = true,
            Ok(Up::Hello { .. }) => {}
            Err(e) => tracing::warn!("bad tunnel message from {name}: {e}"),
        }
    }
    writer.abort();
    // Requests and websockets in flight hold the connection, so they'd wait for answers that won't come.
    if let Kind::Tunnel { pending, streams, .. } = &conn.kind {
        pending.lock().unwrap().clear();
        streams.lock().unwrap().clear();
    }
    tracing::info!("host {name} disconnected");
    Ok(())
}
