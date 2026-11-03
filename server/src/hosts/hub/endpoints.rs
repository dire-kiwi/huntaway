//! The hub's HTTP endpoints: the proxy to each host, the hosts list, joining, and the UI's events.

use super::*;

/// `/api/h/{host_id}/{*rest}`: the UI's way of talking to any host.
pub async fn proxy(State(s): State<Shared>, Path((host_id, rest)): Path<(String, String)>, req: Request) -> Response {
    if is_websocket(&req) {
        return proxy_ws(s, host_id, rest, req).await;
    }
    let method = req.method().as_str().to_string();
    let path = host_path(&rest, req.uri().query());
    let bytes = match axum::body::to_bytes(req.into_body(), 64 << 20).await {
        Ok(b) => b,
        Err(e) => return (StatusCode::BAD_REQUEST, Json(json!({"error": e.to_string()}))).into_response(),
    };
    // A task the user moves to another column doesn't push them a notification of it (see integrations/push.rs).
    if method == "PATCH"
        && let Some(id) = rest.strip_prefix("tasks/").filter(|id| !id.contains('/'))
        && let Some(status) = serde_json::from_slice::<Value>(&bytes).ok().and_then(|b| b["status"].as_str().map(String::from))
    {
        s.push.note_move(&host_id, id, &status);
    }
    let result = if host_id == s.host_id {
        local_request(&s, &method, &path, (!bytes.is_empty()).then(|| bytes.to_vec())).await
    } else {
        let Some(link) = s.links.lock().unwrap().get(&host_id).cloned() else {
            let name = db::get_link(&s.db(), &host_id).ok().flatten().map(|l| l.name).unwrap_or(host_id);
            return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error": format!("host {name} is offline")}))).into_response();
        };
        let body = (!bytes.is_empty()).then(|| serde_json::from_slice(&bytes).unwrap_or(Value::Null));
        link.request(&method, &path, body).await
    };
    match result {
        // Hosts from before the JSON 404 answer an unknown route (or method) with an empty 404 or 405.
        Ok((status @ (404 | 405), Value::String(_))) => {
            (StatusCode::from_u16(status).unwrap(), Json(crate::api::no_route_error(&method, &path))).into_response()
        }
        Ok((status, body)) => (StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY), Json(body)).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({"error": format!("{e:#}")}))).into_response(),
    }
}

/// The path a proxied request takes on its host. A client may authenticate to us with `?token=`;
/// that token is ours, not the host's, so it isn't passed on (a linked host gets the link's token).
fn host_path(rest: &str, query: Option<&str>) -> String {
    let query: Vec<&str> = query.unwrap_or("").split('&').filter(|kv| !kv.is_empty() && !kv.starts_with("token=")).collect();
    if query.is_empty() { format!("/api/{rest}") } else { format!("/api/{rest}?{}", query.join("&")) }
}

fn is_websocket(req: &Request) -> bool {
    req.headers().get(axum::http::header::UPGRADE).and_then(|v| v.to_str().ok()).is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
}

/// A websocket for a host (a terminal): handled by our own router for this host, relayed
/// to a linked one.
async fn proxy_ws(s: Shared, host_id: String, rest: String, req: Request) -> Response {
    let path = host_path(&rest, req.uri().query());
    let (mut parts, body) = req.into_parts();
    if host_id == s.host_id {
        let Some(router) = s.local_router.get().cloned() else {
            return (StatusCode::SERVICE_UNAVAILABLE, "router not ready").into_response();
        };
        // A fresh request (without this route's path parameters) that takes the upgrade
        // handle along, so the local handler can take the connection over.
        let mut local = Request::new(body);
        *local.method_mut() = parts.method;
        *local.headers_mut() = parts.headers;
        let Ok(uri) = path.parse() else { return (StatusCode::BAD_REQUEST, "bad path").into_response() };
        *local.uri_mut() = uri;
        local.headers_mut().insert(axum::http::header::AUTHORIZATION, format!("Bearer {}", s.token).parse().unwrap());
        if let Some(upgrade) = parts.extensions.remove::<hyper::upgrade::OnUpgrade>() {
            local.extensions_mut().insert(upgrade);
        }
        return router.oneshot(local).await.into_response();
    }
    let upgrade = match WebSocketUpgrade::from_request_parts(&mut parts, &s).await {
        Ok(u) => u,
        Err(e) => return e.into_response(),
    };
    let Some(link) = s.links.lock().unwrap().get(&host_id).cloned() else {
        return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error": "host is offline"}))).into_response();
    };
    match link.open_ws(&path).await {
        Ok(pipe) => upgrade.on_upgrade(move |ws| relay::bridge(ws, pipe)),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({"error": format!("{e:#}")}))).into_response(),
    }
}

/// This host plus every linked host, with live status.
pub async fn list_hosts(State(s): State<Shared>) -> ApiResult<Json<Value>> {
    let mut out = vec![json!({
        "id": s.host_id,
        "name": s.host_name,
        "local": true,
        "connected": true,
        "mode": "local",
        "version": env!("CARGO_PKG_VERSION"),
        "build_id": BUILD_ID,
        "api_version": API_VERSION,
        "api_compat": API_COMPAT,
        "commit": s.meta.running_commit,
        "updates_from": crate::update::admin::updates_from(&s.meta),
        "agents": crate::agent::runs::can_run_agents(&s),
    })];
    for l in db::list_links(&s.db())? {
        let live = s.links.lock().unwrap().get(&l.id).cloned();
        let mut v = serde_json::to_value(&l).unwrap();
        v["local"] = json!(false);
        v["connected"] = json!(live.as_ref().is_some_and(|link| s.push.link_ready(link)));
        if let Some(c) = live {
            v["mode"] = json!(c.mode);
            let ver = c.version.lock().unwrap().clone();
            v["version"] = json!(ver.version);
            v["api_version"] = json!(ver.api_version);
            v["api_compat"] = json!(ver.api_compat);
            v["commit"] = json!(ver.commit);
            v["agents"] = json!(ver.agents);
            v["updates_from"] = json!(ver.updates_from);
            // Pings keep this recent on a live link: a while ago means the link is about to be dropped.
            v["last_message_at"] = json!(c.last_message_at());
        }
        if let Some(t) = l.ssh.as_deref().and_then(|j| serde_json::from_str::<crate::hosts::ssh::Target>(j).ok()) {
            v["url"] = json!(format!("ssh://{}", t.target));
        }
        if let Some(o) = v.as_object_mut() {
            o.remove("ssh");
        }
        out.push(v);
    }
    Ok(Json(json!(out)))
}

#[derive(Deserialize)]
pub struct AddHost {
    url: String,
    token: String,
}

/// Link a host we can reach directly.
pub async fn add_host(State(s): State<Shared>, Json(b): Json<AddHost>) -> ApiResult<Json<Value>> {
    let url = b.url.trim().trim_end_matches('/').to_string();
    let endpoint = crate::hosts::broker::resolve(&url, None).await.map_err(|e| ApiError::bad(format!("can't resolve {url}: {e:#}")))?;
    let info: Value = http()
        .get(format!("{endpoint}/api/info"))
        .bearer_auth(b.token.trim())
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| ApiError::bad(format!("can't reach {url}: {e}")))?
        .error_for_status()
        .map_err(|e| ApiError::bad(format!("{url} refused the token: {e}")))?
        .json()
        .await
        .map_err(|e| ApiError::bad(format!("{url} isn't a Huntaway host: {e}")))?;
    let host_id = info["host_id"].as_str().ok_or_else(|| ApiError::bad(format!("{url} is too old to be linked (no host_id)")))?;
    if host_id == s.host_id {
        return Err(ApiError::bad("that's this host"));
    }
    let name = info["host_name"].as_str().unwrap_or(host_id);
    let link = db::upsert_link(&s.db(), host_id, name, "outbound", Some(&url), Some(b.token.trim()))?;
    spawn_outbound(&s, link.clone());
    changed(&s);
    Ok(Json(json!(link)))
}

#[derive(Deserialize)]
pub struct UpdateHost {
    #[serde(default)]
    name: Option<String>,
    /// Whether its agents may use this board's tools, up the link (API 98, see hosts/uplink.rs).
    #[serde(default)]
    uplink: Option<bool>,
}

/// Rename a linked host, or let its agents use this board (or not).
pub async fn change_host(State(s): State<Shared>, Path(id): Path<String>, Json(b): Json<UpdateHost>) -> ApiResult<Json<Value>> {
    let c = s.db();
    if db::get_link(&c, &id)?.is_none() {
        return Err(ApiError::not_found("host"));
    }
    if let Some(name) = b.name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        c.execute("UPDATE links SET name=?1 WHERE id=?2", rusqlite::params![name, id])?;
    }
    if let Some(on) = b.uplink {
        c.execute("UPDATE links SET uplink=?1 WHERE id=?2", rusqlite::params![on, id])?;
    }
    drop(c);
    changed(&s);
    Ok(Json(json!({"ok": true})))
}

/// Forget a link. Its data stays on that host.
pub async fn remove_host(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    s.db().execute("DELETE FROM links WHERE id=?1", [&id])?;
    if let Some(t) = s.link_tasks.lock().unwrap().remove(&id) {
        t.abort();
    }
    s.links.lock().unwrap().remove(&id);
    changed(&s);
    Ok(Json(json!({"ok": true})))
}

/// What a host needs to dial in to this hub.
pub async fn join_info(State(s): State<Shared>, headers: HeaderMap) -> Json<Value> {
    Json(json!({
        "hub_token": s.hub_token,
        "host_token": s.token,
        "command": format!("huntaway serve --hub {} --hub-token {}", hub_url(&s, &headers), s.hub_token),
    }))
}

/// The URL hosts dial this hub at, as the browser asking reaches it.
pub(super) fn hub_url(s: &Shared, headers: &HeaderMap) -> String {
    // Through a broker, whose request comes from loopback without the client's Host: at the broker.
    if headers.contains_key(crate::hosts::broker::VIA_BROKER)
        && let Some(url) = s.broker_url.get()
    {
        return url.clone();
    }
    let header = |name: &str| headers.get(name).and_then(|h| h.to_str().ok()).and_then(|h| h.split(',').next()).map(str::trim).filter(|h| !h.is_empty());
    // Behind a TLS proxy (Caddy sets X-Forwarded-Proto), hosts must dial https: they don't follow redirects.
    let scheme = match header("x-forwarded-proto") {
        Some("https") => "https",
        _ => "http",
    };
    let host = header("x-forwarded-host").or_else(|| header("host")).unwrap_or("this-hub:7878");
    format!("{scheme}://{host}")
}

/// Merged events from every host, for the UI.
pub async fn ws(State(s): State<Shared>, upgrade: WebSocketUpgrade) -> Response {
    upgrade.on_upgrade(move |socket| ui_loop(s, socket))
}

async fn ui_loop(s: Shared, mut socket: WebSocket) {
    let mut rx = s.hub_events.subscribe();
    let _ = socket.send(WsMessage::Text(json!({"type": "hello", "host_id": s.host_id}).to_string().into())).await;
    loop {
        tokio::select! {
            ev = rx.recv() => match ev {
                Ok(v) => {
                    if socket.send(WsMessage::Text(v.to_string().into())).await.is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    if socket.send(WsMessage::Text(json!({"type": "resync"}).to_string().into())).await.is_err() {
                        break;
                    }
                }
                Err(_) => break,
            },
            msg = socket.recv() => match msg {
                Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            }
        }
    }
}
