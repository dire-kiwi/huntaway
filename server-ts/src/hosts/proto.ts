// Port of the constants in server/src/hosts/proto.rs. (The tunnel messages are for linked hosts, which this port
// doesn't dial; see hosts/hub.ts.)
import { readFileSync } from "node:fs";

/** Bump on incompatible changes to the tunnel messages. */
export const PROTOCOL = 1;

/** Version of the host API (endpoints, fields and events the UI relies on). It went on from the Rust server's. */
export const API_VERSION = 108;

/** Oldest API version a client (a hub's UI) may be built against and still work with this host. */
export const API_COMPAT = 1;

/** Identifies the exact build: here, the process's start (the Rust build stamps its build time). */
export const BUILD_ID = `ts-${Date.now().toString(16)}`;

/** server-ts/package.json, and build.json beside it, which a release writes (see .github/workflows/release.yml). */
const read_json = (name: string): any => {
  try {
    return JSON.parse(readFileSync(new URL(`../../${name}`, import.meta.url), "utf8"));
  } catch {
    return {};
  }
};

/** This server's version: package.json's, which a release sets to its own (as CARGO_PKG_VERSION is in Rust). */
export const VERSION: string = read_json("package.json").version ?? "0.1.0";

/** The commit a release was built from (Rust's IA_BUILD_COMMIT), from build.json; null in a checkout. */
export const BUILD_COMMIT: string | null = read_json("build.json").commit ?? null;
