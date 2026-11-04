// Port of the constants in server/src/hosts/proto.rs. (The tunnel messages are for linked hosts, which this port
// doesn't dial; see hosts/hub.ts.)

/** Bump on incompatible changes to the tunnel messages. */
export const PROTOCOL = 1;

/** Version of the host API (endpoints, fields and events the UI relies on). Kept equal to the Rust server's. */
export const API_VERSION = 106;

/** Oldest API version a client (a hub's UI) may be built against and still work with this host. */
export const API_COMPAT = 1;

/** Identifies the exact build: here, the process's start (the Rust build stamps its build time). */
export const BUILD_ID = `ts-${Date.now().toString(16)}`;

/** The version the Rust crate has (CARGO_PKG_VERSION). */
export const VERSION = "0.1.0";
