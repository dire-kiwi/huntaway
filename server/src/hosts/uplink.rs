//! Board tools up the link: a host's agents using the board of a hub it's linked to (API 98).
//!
//! Links are made by the hub, which calls the host (over HTTP, or through the tunnel a host opens with
//! `--hub`), so a host had no way to ask the hub anything. Now the hub says who it is once it's connected
//! (`{"type": "hub_hello"}` on `/api/host/ws`, or `Down::Hello` on the tunnel), and the host keeps it here
//! as an up-link while that connection lasts. A board tool call that the host can't resolve on its own
//! board or its own links (a project or task on the hub's, say) goes up each of them
//! (`{"type": "hub_call"}` or `Up::ToolCall`), and the hub answers (`hub_result` or `Down::ToolAnswer`).
//!
//! The hub runs it only if its user lets that host's agents use its board (`links.uplink`, Settings →
//! Hosts, off by default), and only for a caller in one of its profiles whose assistant runs on that host
//! (`assistant_host`): whoever controls the host can name any profile, so the name alone proves nothing.
//! It runs with the access of that profile (`agent_access`), at most once per call id, and never further
//! up: see `hub::run_up_call`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

use crate::hosts::proto::{ToolAnswer, ToolCall};
use crate::state::Shared;

/// How long a call up the link may take: the hub's own tools answer at once, but it may ask its other hosts.
const TIMEOUT: Duration = Duration::from_secs(300);

/// A hub this host is linked to that takes its agents' board tool calls.
pub struct Uplink {
    pub hub_id: String,
    pub hub_name: String,
    tx: mpsc::UnboundedSender<ToolCall>,
    pending: Mutex<HashMap<u64, oneshot::Sender<ToolAnswer>>>,
    next: AtomicU64,
}

/// What a call up the link came to.
pub enum Outcome {
    Ok(Value),
    Err(String),
    /// The hub doesn't let this host's agents use its board, or not in the caller's profile (with the hub's
    /// reason for that).
    Off(Option<String>),
}

impl Uplink {
    /// Pass a board tool call to the hub, and wait for its answer.
    pub async fn call(&self, call_id: &str, tool: &str, profile: &str, args: &Value, task_fields: bool) -> Outcome {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (rtx, rrx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, rtx);
        let call = ToolCall { id, call_id: call_id.into(), tool: tool.into(), profile: profile.into(), args: args.clone(), task_fields };
        if self.tx.send(call).is_err() {
            self.pending.lock().unwrap().remove(&id);
            return Outcome::Err(format!("lost the link to {}, so this {tool} call wasn't sent there", self.hub_name));
        }
        // Once it's sent, the hub may have run it whatever becomes of the answer.
        let maybe = |what: String| {
            format!("{what}: this {tool} call may or may not have taken effect there. Check (with get_task or list_tasks, say) before you call it again.")
        };
        match tokio::time::timeout(TIMEOUT, rrx).await {
            Ok(Ok(a)) if a.off => Outcome::Off(a.error),
            Ok(Ok(ToolAnswer { error: Some(e), .. })) => Outcome::Err(e),
            Ok(Ok(a)) => Outcome::Ok(a.result.unwrap_or(Value::Null)),
            Ok(Err(_)) => Outcome::Err(maybe(format!("lost the link to {} before it answered", self.hub_name))),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Outcome::Err(maybe(format!("{} didn't answer in time", self.hub_name)))
            }
        }
    }

    /// The hub's answer to one of our calls.
    pub fn answer(&self, a: ToolAnswer) {
        if let Some(w) = self.pending.lock().unwrap().remove(&a.id) {
            let _ = w.send(a);
        }
    }
}

/// An up-link, counted as this host's for as long as this is kept: dropped, it's gone and its calls
/// waiting for answers fail.
pub struct Registered {
    s: Shared,
    pub link: Arc<Uplink>,
}

impl Drop for Registered {
    fn drop(&mut self) {
        let mut ups = self.s.uplinks.lock().unwrap();
        if ups.get(&self.link.hub_id).is_some_and(|l| Arc::ptr_eq(l, &self.link)) {
            ups.remove(&self.link.hub_id);
        }
        drop(ups);
        self.link.pending.lock().unwrap().clear();
    }
}

/// Count the hub `hub_id` that just said hello on a connection as an up-link, in place of any earlier
/// connection of its. The calls to send it come out of the receiver.
pub fn register(s: &Shared, hub_id: &str, hub_name: &str) -> (Registered, mpsc::UnboundedReceiver<ToolCall>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let link = Arc::new(Uplink { hub_id: hub_id.into(), hub_name: hub_name.into(), tx, pending: Mutex::new(HashMap::new()), next: AtomicU64::new(1) });
    s.uplinks.lock().unwrap().insert(hub_id.into(), link.clone());
    tracing::info!("hub {hub_name} takes this host's board tool calls");
    (Registered { s: s.clone(), link }, rx)
}

/// The hubs this host's agents can ask, but not those it's linked to itself, whose boards it already
/// asks the other way (with their tokens).
pub fn hubs(s: &Shared) -> Vec<Arc<Uplink>> {
    let links = s.links.lock().unwrap();
    let mut ups: Vec<Arc<Uplink>> = s.uplinks.lock().unwrap().values().filter(|u| !links.contains_key(&u.hub_id)).cloned().collect();
    ups.sort_by(|a, b| a.hub_name.cmp(&b.hub_name));
    ups
}

// ---------- on `/api/host/ws` ----------

/// What the hub says on `/api/host/ws` when it connects (hubs from API 98).
pub fn hub_hello(s: &Shared) -> Value {
    json!({"type": "hub_hello", "hub_id": s.host_id, "name": s.host_name, "api_version": crate::hosts::proto::API_VERSION})
}

/// A call as it goes to the hub on `/api/host/ws`.
pub fn call_frame(c: &ToolCall) -> Value {
    let mut v = serde_json::to_value(c).unwrap_or_default();
    v["type"] = json!("hub_call");
    v
}

/// An answer as it comes back on `/api/host/ws`.
pub fn answer_frame(a: &ToolAnswer) -> Value {
    let mut v = serde_json::to_value(a).unwrap_or_default();
    v["type"] = json!("hub_result");
    v
}

#[cfg(test)]
pub(crate) mod tests;
