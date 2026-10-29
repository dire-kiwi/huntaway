//! Dialling out to a broker (`serve --broker <url>`, see `server/broker`), so this host can be
//! reached through it from anywhere: its board in a browser, and its API from hubs.
//!
//! The broker passes each client's request down our websocket, and we make it against our own
//! server over loopback, with the client's own headers. The broker is no more trusted than the
//! client: requests need our token as they would anywhere else.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use huntaway_broker::proto::{self, Ctl};
use futures::{SinkExt, StreamExt};
use serde_json::json;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message as TMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

use crate::relay::{self, Frame};
use crate::state::Shared;

/// Paths a client mustn't reach through the broker: `--open-token` hands the token to whoever asks.
const BLOCKED: &[&str] = &["/api/open-token"];

/// The broker pings every 20s; one we hear nothing from for this long is gone.
const SILENCE: Duration = Duration::from_secs(60);

/// What the broker sent on one of our streams.
enum Incoming {
    Data(Vec<u8>),
    Text(String),
    End,
    Close(Option<u16>, Option<String>),
}

/// Our streams by id: where to send what the broker sends on each, and for a request, how to stop
/// it when the client goes away.
type Streams = Arc<Mutex<HashMap<u64, (mpsc::UnboundedSender<Incoming>, Option<tokio::task::AbortHandle>)>>>;

/// Keep a connection to the broker at `url`, as `name`.
pub fn dial_out(s: &Shared, url: String, token: String, name: String) {
    let s = s.clone();
    tokio::spawn(async move {
        let mut backoff = 1;
        loop {
            match session(&s, &url, &token, &name).await {
                Ok(()) => backoff = 1,
                Err(e) => tracing::warn!("broker {url}: {e:#}"),
            }
            tokio::time::sleep(Duration::from_secs(backoff)).await;
            backoff = (backoff * 2).min(30);
        }
    });
}

async fn session(s: &Shared, url: &str, token: &str, name: &str) -> Result<()> {
    let ws_url = format!("{}/_broker/connect", url.trim_end_matches('/').replacen("http", "ws", 1));
    let mut req = ws_url.into_client_request()?;
    req.headers_mut().insert("Authorization", format!("Bearer {token}").parse()?);
    let (ws, _) = tokio_tungstenite::connect_async(req).await.context("connecting")?;
    let (mut sink, mut stream) = ws.split();
    let hello = Ctl::Hello { name: name.into(), host_id: s.host_id.clone(), version: env!("CARGO_PKG_VERSION").into(), protocol: proto::PROTOCOL };
    sink.send(TMessage::Text(serde_json::to_string(&hello)?.into())).await?;
    match tokio::time::timeout(Duration::from_secs(10), stream.next()).await {
        Ok(Some(Ok(TMessage::Text(t)))) => match serde_json::from_str::<Ctl>(&t)? {
            Ctl::Welcome { name } => tracing::info!("reachable through the broker {url} as {name}"),
            Ctl::Refused { error } => bail!("refused: {error}"),
            other => bail!("expected a welcome, got {other:?}"),
        },
        _ => bail!("no welcome"),
    }
    let (tx, mut rx) = mpsc::unbounded_channel::<TMessage>();
    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });
    let streams: Streams = Arc::default();
    let result = async {
        loop {
            let msg = match tokio::time::timeout(SILENCE, stream.next()).await {
                Ok(Some(m)) => m?,
                Ok(None) => return Ok(()),
                Err(_) => bail!("the broker went quiet"),
            };
            match msg {
                TMessage::Text(t) => match serde_json::from_str::<Ctl>(&t) {
                    Ok(Ctl::Req { id, method, path, headers, body, ws }) => {
                        let (in_tx, in_rx) = mpsc::unbounded_channel();
                        // Registered right away: the request body follows at once.
                        streams.lock().unwrap().insert(id, (in_tx, None));
                        let (s, tx, streams2) = (s.clone(), Out { id, tx: tx.clone() }, streams.clone());
                        let task = tokio::spawn(async move {
                            if ws {
                                websocket(&s, &path, headers, in_rx, &tx).await;
                            } else {
                                request(&s, &method, &path, headers, body.then_some(in_rx), &tx).await;
                            }
                            streams2.lock().unwrap().remove(&tx.id);
                        });
                        // A websocket is closed by the Close the broker sends it; a request stops at once.
                        if let (false, Some(entry)) = (ws, streams.lock().unwrap().get_mut(&id)) {
                            entry.1 = Some(task.abort_handle());
                        }
                    }
                    Ok(Ctl::End { id }) => incoming(&streams, id, Incoming::End, false),
                    Ok(Ctl::Close { id, code, reason }) => incoming(&streams, id, Incoming::Close(code, reason), true),
                    Ok(_) => {}
                    Err(e) => tracing::warn!("bad message from the broker: {e}"),
                },
                TMessage::Binary(b) => match proto::decode(&b) {
                    Some((id, proto::TEXT, bytes)) => incoming(&streams, id, Incoming::Text(String::from_utf8_lossy(bytes).into()), false),
                    Some((id, _, bytes)) => incoming(&streams, id, Incoming::Data(bytes.to_vec()), false),
                    None => {}
                },
                TMessage::Close(f) => {
                    if let Some(f) = f {
                        tracing::info!("the broker hung up: {}", f.reason);
                    }
                    return Ok(());
                }
                _ => {}
            }
        }
    }
    .await;
    // Dropping the senders closes the websockets in flight; requests are stopped.
    for (_, (_, abort)) in streams.lock().unwrap().drain() {
        if let Some(a) = abort {
            a.abort();
        }
    }
    writer.abort();
    result
}

fn incoming(streams: &Streams, id: u64, msg: Incoming, last: bool) {
    let mut streams = streams.lock().unwrap();
    if last {
        if let Some((tx, abort)) = streams.remove(&id) {
            let _ = tx.send(msg);
            if let Some(a) = abort {
                a.abort();
            }
        }
    } else if let Some((tx, _)) = streams.get(&id) {
        let _ = tx.send(msg);
    }
}

/// Sending on one stream.
struct Out {
    id: u64,
    tx: mpsc::UnboundedSender<TMessage>,
}

impl Out {
    fn ctl(&self, ctl: Ctl) -> bool {
        self.tx.send(TMessage::Text(serde_json::to_string(&ctl).unwrap_or_default().into())).is_ok()
    }

    fn data(&self, kind: u8, bytes: &[u8]) -> bool {
        self.tx.send(TMessage::Binary(proto::encode(self.id, kind, bytes).into())).is_ok()
    }

    fn head(&self, status: u16, headers: Vec<(String, String)>) -> bool {
        self.ctl(Ctl::Head { id: self.id, status, headers })
    }

    fn end(&self) {
        self.ctl(Ctl::End { id: self.id });
    }

    /// A whole JSON response, as the API answers errors.
    fn json(&self, status: u16, body: serde_json::Value) {
        self.head(status, vec![("content-type".into(), "application/json".into())]);
        self.data(proto::DATA, body.to_string().as_bytes());
        self.end();
    }
}

fn blocked(path: &str) -> bool {
    let p = path.split('?').next().unwrap_or_default().trim_end_matches('/');
    BLOCKED.contains(&p)
}

fn local() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    // Redirects go back to the client as they are, and loopback never goes through a proxy.
    CLIENT.get_or_init(|| reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).no_proxy().build().expect("http client"))
}

/// Pass the client's headers on, but not the ones that belong to the hop to the broker.
fn passed_on(headers: Vec<(String, String)>) -> impl Iterator<Item = (String, String)> {
    headers.into_iter().filter(|(k, _)| !proto::hop_by_hop(k) && !k.eq_ignore_ascii_case("content-length"))
}

/// Make an HTTP request on our own server and send the response back.
async fn request(s: &Shared, method: &str, path: &str, headers: Vec<(String, String)>, body: Option<mpsc::UnboundedReceiver<Incoming>>, out: &Out) {
    if blocked(path) {
        return out.json(404, crate::api::no_route_error(method, path));
    }
    let Ok(m) = reqwest::Method::from_bytes(method.as_bytes()) else {
        return out.json(400, json!({"error": format!("bad method {method}")}));
    };
    let mut req = local().request(m, format!("{}{path}", s.internal_url));
    for (k, v) in passed_on(headers) {
        req = req.header(k, v);
    }
    if let Some(rx) = body {
        // The body as the broker sends it; a client that went away fails the request.
        let chunks = futures::stream::unfold(Some(rx), |rx| async move {
            let mut rx = rx?;
            match rx.recv().await {
                Some(Incoming::Data(b)) => Some((Ok(b), Some(rx))),
                Some(Incoming::Text(t)) => Some((Ok(t.into_bytes()), Some(rx))),
                Some(Incoming::End) => None,
                Some(Incoming::Close(..)) | None => Some((Err(std::io::Error::other("the client went away")), None)),
            }
        });
        req = req.body(reqwest::Body::wrap_stream(chunks));
    }
    let res = match req.send().await {
        Ok(r) => r,
        Err(e) => return out.json(502, json!({"error": format!("{e:#}")})),
    };
    let headers = res.headers().iter().filter_map(|(k, v)| Some((k.to_string(), v.to_str().ok()?.to_string()))).collect();
    if !out.head(res.status().as_u16(), headers) {
        return;
    }
    let mut body = res.bytes_stream();
    while let Some(chunk) = body.next().await {
        match chunk {
            Ok(c) => {
                if !out.data(proto::DATA, &c) {
                    return;
                }
            }
            Err(e) => {
                out.ctl(Ctl::Close { id: out.id, code: None, reason: Some(format!("{e:#}")) });
                return;
            }
        }
    }
    out.end();
}

/// Open a websocket on our own server and relay it until either side closes it.
async fn websocket(s: &Shared, path: &str, headers: Vec<(String, String)>, mut from_broker: mpsc::UnboundedReceiver<Incoming>, out: &Out) {
    if blocked(path) {
        return out.json(404, crate::api::no_route_error("GET", path));
    }
    let url = format!("{}{path}", s.internal_url.replacen("http", "ws", 1));
    let req = url.into_client_request().map(|mut req| {
        for (k, v) in passed_on(headers) {
            if let (Ok(k), Ok(v)) = (axum::http::HeaderName::try_from(k), axum::http::HeaderValue::try_from(v)) {
                req.headers_mut().append(k, v);
            }
        }
        req
    });
    let (local_tx, mut local_rx) = match req {
        Ok(req) => match relay::open(req).await {
            Ok(pipe) => pipe,
            // Not a websocket after all (unauthorized, say): the client gets that response.
            Err(tokio_tungstenite::tungstenite::Error::Http(res)) => {
                let headers = res.headers().iter().filter_map(|(k, v)| Some((k.to_string(), v.to_str().ok()?.to_string()))).collect();
                out.head(res.status().as_u16(), headers);
                if let Some(b) = res.body() {
                    out.data(proto::DATA, b);
                }
                return out.end();
            }
            Err(e) => return out.json(502, json!({"error": format!("{e:#}")})),
        },
        Err(e) => return out.json(400, json!({"error": format!("{e:#}")})),
    };
    out.head(101, vec![]);
    loop {
        tokio::select! {
            m = from_broker.recv() => {
                let f = match m {
                    Some(Incoming::Data(b)) => Frame::Binary(b),
                    Some(Incoming::Text(t)) => Frame::Text(t),
                    Some(Incoming::End) => continue,
                    Some(Incoming::Close(code, reason)) => Frame::Close(code.map(|c| (c, reason.unwrap_or_default()))),
                    None => Frame::Close(None),
                };
                let close = matches!(f, Frame::Close(_));
                if local_tx.send(f).is_err() || close {
                    break;
                }
            }
            f = local_rx.recv() => match f.unwrap_or(Frame::Close(None)) {
                Frame::Close(c) => {
                    let (code, reason) = c.unzip();
                    out.ctl(Ctl::Close { id: out.id, code, reason });
                    break;
                }
                Frame::Text(t) => {
                    if !out.data(proto::TEXT, t.as_bytes()) {
                        break;
                    }
                }
                Frame::Binary(b) => {
                    if !out.data(proto::DATA, &b) {
                        break;
                    }
                }
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::Identity;
    use crate::testing;
    use serde_json::Value;

    const BROKER_TOKEN: &str = "broker-token-0123456789";

    async fn broker() -> String {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", l.local_addr().unwrap());
        let app = huntaway_broker::router(huntaway_broker::Config { token: BROKER_TOKEN.into(), default_host: None });
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        url
    }

    /// A host (`id`, token `<id>-tok`) served on a free port and dialled out to `broker` as `id`.
    async fn host(id: &str, broker: &str) -> Shared {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let internal_url = format!("http://{}", l.local_addr().unwrap());
        let s = testing::state_as(Identity { host_id: id.into(), host_name: id.into(), token: format!("{id}-tok"), hub_token: format!("{id}-hub"), internal_url });
        let app = crate::api::router(s.clone());
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        dial_out(&s, broker.into(), BROKER_TOKEN.into(), id.into());
        // Connected once the broker passes a request to it.
        for _ in 0..100 {
            if call("GET", &format!("{broker}/_broker/h/{id}/api/health"), &[]).await.0 == 200 {
                return s;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("host {id} didn't connect to the broker");
    }

    /// A request with these headers (`body` is a JSON body).
    async fn call(method: &str, url: &str, headers: &[(&str, &str)]) -> (u16, Value) {
        let mut req = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap().request(method.parse().unwrap(), url);
        for (k, v) in headers {
            req = if *k == "body" { req.header("content-type", "application/json").body(v.to_string()) } else { req.header(*k, *v) };
        }
        let res = req.send().await.unwrap();
        let status = res.status().as_u16();
        let text = res.text().await.unwrap();
        (status, serde_json::from_str(&text).unwrap_or(Value::String(text)))
    }

    #[test]
    fn relays_requests_to_a_host() {
        testing::run(async || {
            let b = broker().await;
            host("desktop", &b).await;
            let auth = ("authorization", "Bearer desktop-tok");
            // The host's token still guards its API.
            assert_eq!(call("GET", &format!("{b}/api/info"), &[]).await, (401, json!({"error": "unauthorized"})));
            assert_eq!(call("GET", &format!("{b}/api/info"), &[("authorization", "Bearer nope")]).await.0, 401);
            let (status, info) = call("GET", &format!("{b}/api/info"), &[auth]).await;
            assert_eq!((status, &info["host_id"]), (200, &json!("desktop")));
            assert_eq!(call("GET", &format!("{b}/api/info?token=desktop-tok"), &[]).await.0, 200);
            // Request bodies get there.
            let (status, p) = call("POST", &format!("{b}/api/profiles"), &[auth, ("body", r#"{"name": "remote"}"#)]).await;
            assert_eq!((status, &p["name"]), (200, &json!("remote")), "{p}");
            let (status, err) = call("POST", &format!("{b}/api/profiles"), &[auth, ("body", r#"{"name": 5}"#)]).await;
            assert!(status == 422 && err.to_string().contains("invalid type"), "{status} {err}");
            // By path, which hubs use.
            assert_eq!(call("GET", &format!("{b}/_broker/h/desktop/api/info"), &[auth]).await.1["host_id"], "desktop");
            assert_eq!(
                call("GET", &format!("{b}/_broker/h/laptop/api/info"), &[auth]).await,
                (502, json!({"error": "host laptop isn't connected to the broker"}))
            );
            assert_eq!(call("GET", &format!("{b}/_broker/nope"), &[]).await.0, 404);
            // The broker's own token, for hosts to connect.
            let mut req = format!("{}/_broker/connect", b.replacen("http", "ws", 1)).into_client_request().unwrap();
            req.headers_mut().insert("Authorization", "Bearer desktop-tok".parse().unwrap());
            match tokio_tungstenite::connect_async(req).await {
                Err(tokio_tungstenite::tungstenite::Error::Http(res)) => assert_eq!(res.status(), 401),
                other => panic!("connected with the wrong token: {:?}", other.map(|_| ())),
            }
        })
    }

    #[test]
    fn picks_a_host_by_header_cookie_or_path() {
        testing::run(async || {
            let b = broker().await;
            host("desktop", &b).await;
            // The only host gets the requests that don't pick one.
            assert_eq!(call("GET", &format!("{b}/api/info?token=desktop-tok"), &[]).await.1["host_id"], "desktop");
            host("laptop", &b).await;
            let (status, err) = call("GET", &format!("{b}/api/info?token=desktop-tok"), &[]).await;
            assert!(status == 502 && err["error"].as_str().unwrap().contains("several hosts"), "{err}");
            assert_eq!(call("GET", &format!("{b}/api/info?token=laptop-tok"), &[("x-huntaway-host", "laptop")]).await.1["host_id"], "laptop");
            assert_eq!(call("GET", &format!("{b}/api/info?token=desktop-tok"), &[("cookie", "a=b; huntaway_host=desktop")]).await.1["host_id"], "desktop");
            assert_eq!(call("GET", &format!("{b}/_broker/h/laptop/api/info?token=laptop-tok"), &[]).await.1["host_id"], "laptop");
            // Opening /_broker/use/<name> sets the cookie, and keeps ?token= for the board.
            let res = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap().get(format!("{b}/_broker/use/laptop?token=x")).send().await.unwrap();
            assert_eq!(res.status(), 302);
            assert_eq!(res.headers()["location"], "/?token=x");
            assert!(res.headers()["set-cookie"].to_str().unwrap().starts_with("huntaway_host=laptop;"));
        })
    }

    #[test]
    fn relays_websockets() {
        testing::run(async || {
            let b = broker().await;
            let s = host("desktop", &b).await;
            let ws = b.replacen("http", "ws", 1);
            match tokio_tungstenite::connect_async(format!("{ws}/api/host/ws")).await {
                Err(tokio_tungstenite::tungstenite::Error::Http(res)) => assert_eq!(res.status(), 401),
                other => panic!("opened the events without the token: {:?}", other.map(|_| ())),
            }
            let (mut events, _) = tokio_tungstenite::connect_async(format!("{ws}/api/host/ws?token=desktop-tok")).await.unwrap();
            let mut next = async || loop {
                match events.next().await.unwrap().unwrap() {
                    TMessage::Text(t) => return serde_json::from_str::<Value>(&t).unwrap(),
                    _ => continue,
                }
            };
            assert_eq!(next().await, json!({"type": "hello"}));
            s.events.send(json!({"type": "test", "n": 1})).unwrap();
            assert_eq!(next().await, json!({"type": "test", "n": 1}));
        })
    }

    #[test]
    fn links_a_host_to_a_hub_through_the_broker() {
        testing::run(async || {
            let b = broker().await;
            // The hub is behind the broker, and the host dials in to it there (`--hub <broker>/_broker/h/<hub>`).
            let hub = host("desktop", &b).await;
            let laptop = testing::state_as(Identity { host_id: "laptop".into(), host_name: "laptop".into(), token: "laptop-tok".into(), hub_token: String::new(), internal_url: String::new() });
            let _ = crate::api::router(laptop.clone());
            crate::hub::dial_out(&laptop, format!("{b}/_broker/h/desktop"), "desktop-hub".into());
            for _ in 0..100 {
                if let Some(link) = crate::hub::find_link(&hub, "laptop") {
                    let (status, info) = link.request("GET", "/api/info", None).await.unwrap();
                    assert_eq!((status, &info["host_id"]), (200, &json!("laptop")));
                    return;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            panic!("the host didn't link to the hub");
        })
    }

    #[test]
    fn blocks_the_open_token() {
        assert!(blocked("/api/open-token") && blocked("/api/open-token?x=1") && blocked("/api/open-token/"));
        assert!(!blocked("/api/info") && !blocked("/"));
    }
}
