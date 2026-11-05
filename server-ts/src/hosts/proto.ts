// Port of the constants in server/src/hosts/proto.rs. (The tunnel messages are for linked hosts, which this port
// doesn't dial; see hosts/hub.ts.)
import { readFileSync } from "node:fs";

/** Bump on incompatible changes to the tunnel messages. */
export const PROTOCOL = 1;

/**
 * Version of the host API (endpoints, fields and events the UI relies on). It went on from the Rust server's.
 *
 * API 110: routines (a profile's automations, which wake its assistant): `/profiles/{id}/automations`, the `cron` and `at`
 * triggers, `active_hours`, `precheck` and `budget_usd`, runs' `outcome` and `cost_usd`, `report` messages, and push's
 * `replies` and `reports` events.
 * API 111: the assistant's approval rules and action log (`/profiles/{id}/approval-rules` and `/approval-log`, see
 * agent/approval_rules.ts, and their `approval_rules` and `approval_log` events), prompts' `expires_at` and `rule`, `via`
 * on a prompt's answer, and answering prompts from a notification (push's `prompts` event setting, a prompt's push with
 * `request_id` and `answer`, and `POST /permissions/{id}/push-answer`, see integrations/push_answers.ts).
 */
export const API_VERSION = 111;

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
