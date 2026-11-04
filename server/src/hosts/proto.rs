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
/// API 98: a profile's assistant host (`assistant_host`), and board tool calls up a link (`Down::Hello`,
/// `Up::ToolCall`, and `hub_hello`/`hub_call` on `/api/host/ws`, see hosts/uplink.rs). A host passes calls
/// only to a hub that said hello, which older hubs don't, and older hosts ignore the hello.
/// API 99: the assistant's memory (`/profiles/{id}/assistant/memory`: its files, their history, restore and import).
/// API 100: paired devices (devices.rs): `/devices`, `POST /api/devices/pair`, `api_version` in `/api/health`, and
/// `GET /permissions?profile_id=`.
/// API 101: routines (a profile's automations, which wake its assistant): `/profiles/{id}/automations`, the `cron`
/// and `at` triggers, `active_hours`, `precheck` and `budget_usd`, runs' `outcome` and `cost_usd`, and `report` messages.
/// API 102: the assistant's approval rules and action log (`/profiles/{id}/approval-rules` and `/approval-log`,
/// see agent/approval_rules.rs), prompts' `expires_at` and `rule`, and `via` on a prompt's answer.
/// API 103: native push through Expo (`kind` `expo` on `/push/subscriptions`, which paired devices may use for their own).
/// API 104: the assistant's Telegram bot (`/profiles/{id}/telegram`, `/telegram/link` and `/telegram/owner`, see
/// integrations/telegram.rs), `telegram` events, and `telegram` as who answered in the action log.
/// API 105: Google and the morning brief: `/profiles/{id}/assistant/google` (the Google card, and adding the Google
/// server), `/profiles/{id}/assistant/brief` (the routine template) and `/brief/feedback` (ratings into MEMORY.md), the
/// assistant's `brief` document, `{{google}}` in routines, and `reports` in a push subscription's events.
/// API 106: paired devices reach a profile's assistant (`GET`/`POST /profiles/{id}/assistant`, `?local=1` too), for the
/// app's Assistant tab, and attachments know audio types (voice notes).
pub const API_VERSION: u32 = 106;

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
    /// A board tool call from one of our agents that we couldn't resolve here, for the hub to run (API 98).
    /// Sent only to a hub that said `Down::Hello`.
    ToolCall(ToolCall),
}

/// A board tool call a host passes up its link to a hub (see hosts/uplink.rs).
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ToolCall {
    /// This call on this link, which the answer carries.
    pub id: u64,
    /// The agent's call id on the host, by which the hub runs it at most once.
    pub call_id: String,
    pub tool: String,
    /// The calling agent's profile, by name: the hub acts with that profile's access to its boards.
    pub profile: String,
    #[serde(default)]
    pub args: Value,
    #[serde(default)]
    pub task_fields: bool,
}

/// The hub's answer to a `ToolCall`.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ToolAnswer {
    pub id: u64,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<String>,
    /// The hub doesn't let this host's agents use its board (Settings → Hosts there).
    #[serde(default)]
    pub off: bool,
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
    /// Who the hub is, sent once the tunnel is up (API 98). A host may then pass it board tool calls
    /// (`Up::ToolCall`). Older hosts ignore it.
    Hello { hub_id: String, name: String, api_version: u32 },
    /// The answer to `Up::ToolCall`.
    ToolAnswer(ToolAnswer),
}
