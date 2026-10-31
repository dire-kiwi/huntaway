//! Tunnel used when a host dials out to a hub (`serve --hub <url>`): the hub sends API
//! requests over the websocket and the host answers them from its own router, while also
//! forwarding its events. Hubs that connect to a host directly use plain HTTP instead.
//! Websockets (terminals) are relayed as `WsOpen`/`WsMsg`/`WsClose`; binary data is base64.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Bump on incompatible changes to these tunnel messages.
pub const PROTOCOL: u32 = 1;

/// Version of the host API (endpoints, fields and events the UI relies on). Bump it with
/// every API change; changes should be additive (new endpoints, optional fields).
pub const API_VERSION: u32 = 78;

/// Oldest API version a client (a hub's UI) may be built against and still work with this
/// host. Raise it only for a breaking change, after keeping the old behaviour for a while.
pub const API_COMPAT: u32 = 1;

/// Identifies the exact build (changes whenever the code does).
pub const BUILD_ID: &str = env!("IA_BUILD_ID");

/// Host → hub.
#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Up {
    Hello {
        host_id: String,
        name: String,
        version: String,
        protocol: u32,
        #[serde(default)]
        api_version: u32,
        #[serde(default)]
        api_compat: u32,
    },
    Res { id: u64, status: u16, body: Value },
    Event { event: Value },
    /// A message on a websocket the hub opened with `Down::WsOpen`.
    WsMsg {
        id: u64,
        #[serde(default)]
        text: Option<String>,
        #[serde(default)]
        data: Option<String>,
    },
    WsClose {
        id: u64,
        #[serde(default)]
        code: Option<u16>,
        #[serde(default)]
        reason: Option<String>,
    },
    /// The answer to `Down::Ping`.
    Pong,
}

/// Hub → host.
#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Down {
    /// `path` includes the query string, e.g. `/api/projects/x/tasks?kind=task`.
    Req {
        id: u64,
        method: String,
        path: String,
        #[serde(default)]
        body: Option<Value>,
    },
    /// Open a websocket to `path` on the host's own API (hosts before API 7 ignore this).
    WsOpen { id: u64, path: String },
    WsMsg {
        id: u64,
        #[serde(default)]
        text: Option<String>,
        #[serde(default)]
        data: Option<String>,
    },
    WsClose { id: u64 },
    /// Sent every `relay::PING`, so each side hears from the other even through a broker, which
    /// answers websocket pings itself. Hosts answer `Up::Pong`; older ones ignore it.
    Ping,
}
