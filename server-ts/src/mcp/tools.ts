// Port of server/src/mcp/tools.rs.
/**
 * The `huntaway` MCP tools that agents call, executed here on behalf of the agent's MCP helper (`POST
 * /api/internal/mcp`). Calls are deduplicated by call id, so a helper that retries across a server restart never runs a
 * tool twice.
 *
 * Tools act on the caller's profile's board and on the boards of the other profiles that let its agents in
 * (`Profile::agent_access`). `list_projects` covers all of them, labelled with their profile; projects and tasks can be
 * named by id, by key (`SD`, `SD-3`), or by key qualified with a profile (`work:SD-3`) or the `profile` argument. An
 * unqualified key means the caller's own board if it has it there, else the one other board that has it; a key on
 * several other boards must be qualified.
 *
 * A project or task that isn't found here is looked up on linked hosts (`POST /api/tools/<tool>` there), and
 * `list_projects` covers every host, so an orchestrating agent can work across machines.
 */
import type * as db from "../db.ts";
import type { Task } from "../db.ts";
import { ApiError } from "../http.ts";
import { err_str } from "../util.ts";

export * from "./tools/dispatch.ts";
export * from "./tools/projects.ts";

/**
 * Who is calling. The caller's profile picks the boards it can use: its own (`profile_id`, unset when this host has no
 * profile by its name) and those whose profiles let it in. The task is set for agent calls, with the call's id: a change
 * the user has to approve is asked in the task's thread, once per call.
 */
export interface Ctx {
  profile_id: string | null;
  profile_name: string;
  task: Task | null;
  call_id: string | null;
  /** The original caller's helper advertises get_task_field (not just this host's build). */
  task_fields: boolean;
}

export function is_own(ctx: Ctx, p: db.Profile): boolean {
  return ctx.profile_id === p.id;
}

/** Why a tool failed: what it names wasn't found here (so linked hosts are asked), or another reason. */
export class ToolError extends Error {
  kind: "NotFound" | "Other";
  constructor(kind: "NotFound" | "Other", message: string) {
    super(message);
    this.kind = kind;
  }
  static not_found(m: string) {
    return new ToolError("NotFound", m);
  }
  static other(m: string) {
    return new ToolError("Other", m);
  }
}

/** Any error as a ToolError, as Rust's `From` conversions make one: an API 404 is NotFound, anything else Other. */
export function te(e: unknown): ToolError {
  if (e instanceof ToolError) return e;
  if (e instanceof ApiError) return new ToolError(e.status === 404 ? "NotFound" : "Other", e.message);
  return ToolError.other(err_str(e));
}

export function msg(e: unknown): string {
  return te(e).message;
}

/** JSON as serde_json writes a Value: object keys sorted (its maps are BTreeMaps), `undefined` fields left out. */
export function canonical(v: any): string {
  return JSON.stringify(v ?? null, (_k, x) => {
    if (x && typeof x === "object" && !Array.isArray(x)) {
      const out: Record<string, any> = {};
      for (const k of Object.keys(x).sort()) if (x[k] !== undefined) out[k] = x[k];
      return out;
    }
    return x;
  });
}

/** Whether two JSON values are equal (serde_json's `Value` equality). */
export function json_eq(a: any, b: any): boolean {
  return canonical(a) === canonical(b);
}
