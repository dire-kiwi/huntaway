//! The agent-threads backend in the server's state. HA-145 (the threads' API and live updates) has this
//! module too, where `install` also sends the backend's events to clients: this is the part the engine needs
//! (see threads/engine.rs), which that one replaces.

use agent_threads::AgentThreads;

use crate::state::Shared;

/// Puts the backend in the state, once: false if one was there already.
pub fn install(s: &Shared, backend: AgentThreads) -> bool {
    s.agent_threads.set(backend).is_ok()
}
