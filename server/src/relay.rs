//! Relaying websockets (terminals) from the UI to a host: straight through for a host we
//! reach over HTTP, or as `WsOpen`/`WsMsg`/`WsClose` messages over a host's tunnel.

use anyhow::Result;
use axum::extract::ws::{CloseFrame, Message as WsMessage, WebSocket};
use base64::Engine;
use futures::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message as TMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::client::Request;
use tokio_tungstenite::tungstenite::protocol::CloseFrame as TCloseFrame;

/// One websocket message, whichever library carried it.
#[derive(Debug)]
pub enum Frame {
    Text(String),
    Binary(Vec<u8>),
    Close(Option<(u16, String)>),
}

/// Both directions of a relayed websocket: frames to send, and frames received.
pub type Pipe = (mpsc::UnboundedSender<Frame>, mpsc::UnboundedReceiver<Frame>);

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

impl Frame {
    /// The `text`/`data` fields of a tunnel `WsMsg` (binary data is base64).
    pub fn to_wire(&self) -> (Option<String>, Option<String>) {
        match self {
            Frame::Text(t) => (Some(t.clone()), None),
            Frame::Binary(b) => (None, Some(B64.encode(b))),
            Frame::Close(_) => (None, None),
        }
    }

    pub fn from_wire(text: Option<String>, data: Option<String>) -> Option<Frame> {
        match (text, data) {
            (Some(t), _) => Some(Frame::Text(t)),
            (None, Some(d)) => B64.decode(d).ok().map(Frame::Binary),
            _ => None,
        }
    }
}

/// Open a websocket to `url` (`ws://…`) with a bearer token.
pub async fn connect(url: &str, token: &str) -> Result<Pipe> {
    let mut req = url.into_client_request()?;
    req.headers_mut().insert("Authorization", format!("Bearer {token}").parse()?);
    Ok(open(req).await?)
}

/// Open a websocket for a handshake request. A server that answers with something other than
/// a websocket gives `Error::Http` with its response.
pub async fn open(req: Request) -> Result<Pipe, tokio_tungstenite::tungstenite::Error> {
    let (ws, _) = tokio_tungstenite::connect_async(req).await?;
    let (mut sink, mut stream) = ws.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Frame>();
    let (in_tx, in_rx) = mpsc::unbounded_channel::<Frame>();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                f = out_rx.recv() => {
                    let msg = match f {
                        Some(Frame::Text(t)) => TMessage::Text(t.into()),
                        Some(Frame::Binary(b)) => TMessage::Binary(b.into()),
                        Some(Frame::Close(c)) => TMessage::Close(c.map(|(code, reason)| TCloseFrame { code: code.into(), reason: reason.into() })),
                        None => TMessage::Close(None),
                    };
                    let close = matches!(msg, TMessage::Close(_));
                    if sink.send(msg).await.is_err() || close {
                        break;
                    }
                }
                m = stream.next() => {
                    let f = match m {
                        Some(Ok(TMessage::Text(t))) => Frame::Text(t.to_string()),
                        Some(Ok(TMessage::Binary(b))) => Frame::Binary(b.to_vec()),
                        Some(Ok(TMessage::Close(c))) => Frame::Close(c.map(|c| (c.code.into(), c.reason.to_string()))),
                        Some(Ok(_)) => continue,
                        None | Some(Err(_)) => Frame::Close(None),
                    };
                    let close = matches!(f, Frame::Close(_));
                    if in_tx.send(f).is_err() || close {
                        break;
                    }
                }
            }
        }
    });
    Ok((out_tx, in_rx))
}

/// Shuttle frames between the UI's websocket and a relayed one until either side closes.
pub async fn bridge(mut ui: WebSocket, (tx, mut rx): Pipe) {
    loop {
        tokio::select! {
            m = ui.recv() => {
                let f = match m {
                    Some(Ok(WsMessage::Text(t))) => Frame::Text(t.to_string()),
                    Some(Ok(WsMessage::Binary(b))) => Frame::Binary(b.to_vec()),
                    Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => {
                        let _ = tx.send(Frame::Close(None));
                        return;
                    }
                    Some(Ok(_)) => continue,
                };
                if tx.send(f).is_err() {
                    break;
                }
            }
            f = rx.recv() => {
                let msg = match f {
                    Some(Frame::Text(t)) => WsMessage::Text(t.into()),
                    Some(Frame::Binary(b)) => WsMessage::Binary(b.into()),
                    Some(Frame::Close(c)) => return close(&mut ui, c).await,
                    None => break,
                };
                if ui.send(msg).await.is_err() {
                    let _ = tx.send(Frame::Close(None));
                    return;
                }
            }
        }
    }
    close(&mut ui, Some((1011, "host disconnected".into()))).await;
}

/// Close and wait (briefly) for the peer's reply: hanging up right away can reset the
/// connection before the close frame is read.
pub async fn close(ws: &mut WebSocket, frame: Option<(u16, String)>) {
    let frame = frame.map(|(code, reason)| CloseFrame { code, reason: reason.into() });
    if ws.send(WsMessage::Close(frame)).await.is_err() {
        return;
    }
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while let Some(Ok(m)) = ws.recv().await {
            if matches!(m, WsMessage::Close(_)) {
                break;
            }
        }
    })
    .await;
}
