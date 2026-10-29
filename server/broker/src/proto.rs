//! What a host and the broker say to each other over the websocket the host opens to
//! `/_broker/connect`.
//!
//! Text frames carry `Ctl` messages as JSON. Binary frames carry a stream's data: its id (8 bytes,
//! big-endian), a kind byte (`DATA` or `TEXT`), then the bytes. A stream is one request from a
//! client. The broker sends `Req`, then the request body as data and `End` (nothing when `body` is
//! false), and the host answers `Head`, the response body as data and `End`. For a websocket
//! (`ws`), the host opens it on its own server and answers `Head` with 101 (or with the response
//! it got instead, as for a request), then both sides send its messages as data until one sends
//! `Close`. `Close` also abandons a request: a client that went away, or a host that failed.

use serde::{Deserialize, Serialize};

/// Bump on incompatible changes to these messages.
pub const PROTOCOL: u32 = 1;

/// Request or response body bytes, or a binary websocket message.
pub const DATA: u8 = 0;
/// A text websocket message.
pub const TEXT: u8 = 1;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Ctl {
    /// Host → broker, first: which host this is.
    Hello { name: String, host_id: String, version: String, protocol: u32 },
    /// Broker → host: it's reachable as `name` now.
    Welcome { name: String },
    /// Broker → host: not taken (a bad name, another protocol). The broker hangs up after it.
    Refused { error: String },
    /// Broker → host: a client's request. `path` includes the query string.
    Req {
        id: u64,
        method: String,
        path: String,
        headers: Vec<(String, String)>,
        #[serde(default)]
        body: bool,
        #[serde(default)]
        ws: bool,
    },
    /// Host → broker: the response's status and headers.
    Head { id: u64, status: u16, headers: Vec<(String, String)> },
    /// The body that way is complete.
    End { id: u64 },
    /// Either way: the stream is over (a websocket closed, or the request was abandoned).
    Close {
        id: u64,
        #[serde(default)]
        code: Option<u16>,
        #[serde(default)]
        reason: Option<String>,
    },
}

pub fn encode(id: u64, kind: u8, bytes: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(9 + bytes.len());
    v.extend_from_slice(&id.to_be_bytes());
    v.push(kind);
    v.extend_from_slice(bytes);
    v
}

pub fn decode(frame: &[u8]) -> Option<(u64, u8, &[u8])> {
    let id = u64::from_be_bytes(frame.get(..8)?.try_into().ok()?);
    Some((id, *frame.get(8)?, &frame[9..]))
}

/// Headers that belong to one hop, which a proxy doesn't pass on. The websocket handshake's are
/// made again for the connection on the other side.
pub fn hop_by_hop(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    matches!(n.as_str(), "connection" | "keep-alive" | "proxy-connection" | "proxy-authenticate" | "proxy-authorization" | "te" | "trailer" | "transfer-encoding" | "upgrade" | "host")
        || n.starts_with("sec-websocket-")
}

/// A host's name on the broker: what clients pick it by.
pub fn valid_name(name: &str) -> bool {
    (1..=48).contains(&name.len())
        && name.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// A valid name made from a host's own name ("Ivan's Desktop" → "ivan-s-desktop").
pub fn slug(name: &str) -> String {
    let mut s = String::new();
    for c in name.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            s.push(c);
        } else if !s.is_empty() && !s.ends_with('-') {
            s.push('-');
        }
    }
    let s = s.trim_end_matches('-');
    let s = s[..s.len().min(48)].trim_end_matches('-');
    if s.is_empty() { "host".into() } else { s.into() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_frames_round_trip() {
        let f = encode(0x0102030405060708, TEXT, b"hi");
        assert_eq!(decode(&f), Some((0x0102030405060708, TEXT, &b"hi"[..])));
        assert_eq!(decode(&encode(1, DATA, b"")), Some((1, DATA, &b""[..])));
        assert_eq!(decode(&[0; 8]), None);
    }

    #[test]
    fn names() {
        assert!(valid_name("desktop") && valid_name("pc-2") && valid_name("2pc"));
        assert!(!valid_name("") && !valid_name("-pc") && !valid_name("Desktop") && !valid_name("a/b") && !valid_name(&"a".repeat(49)));
        assert_eq!(slug("Ivan's Desktop"), "ivan-s-desktop");
        assert_eq!(slug("--x--"), "x");
        assert_eq!(slug("ŵ"), "host");
        assert_eq!(slug(&format!("{}-b", "a".repeat(47))), "a".repeat(47));
        assert!(valid_name(&slug(&"é1".repeat(40))));
    }

    #[test]
    fn ctl_wire_format() {
        let req = Ctl::Req { id: 3, method: "GET".into(), path: "/api/info".into(), headers: vec![], body: false, ws: false };
        assert_eq!(serde_json::to_value(&req).unwrap(), serde_json::json!({"t": "req", "id": 3, "method": "GET", "path": "/api/info", "headers": [], "body": false, "ws": false}));
        assert_eq!(serde_json::from_str::<Ctl>(r#"{"t":"close","id":3}"#).unwrap(), Ctl::Close { id: 3, code: None, reason: None });
    }
}
