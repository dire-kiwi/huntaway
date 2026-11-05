// Port of the constants in server/src/hosts/proto.rs. (The tunnel messages, `Up` and `Down`, are in hosts/hub.ts, but
// for the board tool calls a host passes up its link, which are here.)
import { readFileSync } from "node:fs";

/** Bump on incompatible changes to the tunnel messages. */
export const PROTOCOL = 1;

/**
 * Version of the host API (endpoints, fields and events the UI relies on). It went on from the Rust server's.
 *
 * API 110: routines (a profile's automations, which wake its assistant): `/profiles/{id}/automations`, the `cron` and `at`
 * triggers, `active_hours`, `precheck` and `budget_usd`, runs' `outcome` and `cost_usd`, `report` messages, and push's
 * `replies` and `reports` events.
 * API 111: the assistant's memory (`/profiles/{id}/assistant/memory`: its files, their history, restore and import).
 *
 * API 112: a profile's assistant host (`assistant_host`), and board tool calls up a link (`Down::Hello`, `Up::ToolCall`,
 * and `hub_hello`/`hub_call` on `/api/host/ws`, see hosts/uplink.ts). A host passes calls only to a hub that said hello,
 * which older hubs don't, and older hosts ignore the hello.
 *
 * API 113: Google and the morning brief: `/profiles/{id}/assistant/google` (the Google card, and adding the Google server),
 * `/profiles/{id}/assistant/brief` (the routine template) and `/brief/feedback` (ratings into MEMORY.md), the assistant's
 * `brief` document (with its `items`), and `{{google}}` in routines. (Push's `reports` event came with routines, API 110.)
 *
 * API 114: a task's thread kept as items (`/tasks/{id}/thread`, its items, events and commands, and the `thread_event`
 * and `thread_resync` events: see docs/threads-api.md).
 *
 * API 115: the assistant's approval rules and action log (`/profiles/{id}/approval-rules` and `/approval-log`, see
 * agent/approval_rules.ts, and their `approval_rules` and `approval_log` events), prompts' `expires_at` and `rule`, `via`
 * on a prompt's answer, and answering prompts from a notification (push's `prompts` event setting, a prompt's push with
 * `request_id` and `answer`, and `POST /permissions/{id}/push-answer`, see integrations/push_answers.ts).
 *
 * API 116: paired devices (devices.ts): `/devices`, `POST /api/devices/pair`, `api_version` in `/api/health`, and
 * `GET /permissions?profile_id=`.
 */
export const API_VERSION = 116;

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

/** A board tool call a host passes up its link to a hub (see hosts/uplink.ts). */
export interface ToolCall {
  /** This call on this link, which the answer carries. */
  id: number;
  /** The agent's call id on the host, by which the hub runs it at most once. */
  call_id: string;
  tool: string;
  /** The calling agent's profile, by name: the hub acts with that profile's access to its boards. */
  profile: string;
  args: any;
  task_fields: boolean;
}

/** The hub's answer to a `ToolCall`. */
export interface ToolAnswer {
  id: number;
  result: any;
  error: string | null;
  /** The hub doesn't let this host's agents use its board (Settings → Hosts there). */
  off: boolean;
}

/** A `ToolCall` as serde reads one (its optional fields defaulted), or null if it isn't one. */
export function ToolCall_from(v: any): ToolCall | null {
  if (!v || typeof v !== "object" || typeof v.id !== "number" || typeof v.call_id !== "string" || typeof v.tool !== "string" || typeof v.profile !== "string") {
    return null;
  }
  return { id: v.id, call_id: v.call_id, tool: v.tool, profile: v.profile, args: v.args ?? null, task_fields: v.task_fields === true };
}

/** A `ToolAnswer` as serde reads one, or null if it isn't one. */
export function ToolAnswer_from(v: any): ToolAnswer | null {
  if (!v || typeof v !== "object" || typeof v.id !== "number") return null;
  return { id: v.id, result: v.result ?? null, error: typeof v.error === "string" ? v.error : null, off: v.off === true };
}
