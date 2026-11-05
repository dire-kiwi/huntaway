// Port of server/src/agent/assistant.rs (HA-119 and HA-120, on the HA-117 branch).
/**
 * Each profile's assistant: one long-lived thread in no project, keyed `A-<n>`, that the user talks to from the board's
 * sidebar. It's a task (see db.is_assistant), so it has the thread UI, runs, steering, compaction, prompts and the board
 * tools of any other, but it works in a workspace of its own (`assistants/<task id>` in the data dir) and never goes to
 * review or merge.
 *
 * `get_or_create` is the one place a profile's assistant is found on a host. A profile can have it run on a linked host of
 * its own (`assistant_host`, API 112): the hub then sends `/profiles/{id}/assistant` there (`on_its_host`), to that
 * host's profile of the same name, so its credentials and its agents stay on that machine. The board's sidebar goes there
 * too (`assistantHome` in the client package).
 *
 * Its memory (USER.md, MEMORY.md and daily logs in its workspace, with their history) is `assistant/memory.ts`.
 */
import * as db from "../db.ts";
import type { Task } from "../db.ts";
import { ApiError } from "../http.ts";
import type { Shared } from "../state.ts";
import { err_str } from "../util.ts";
import * as runner from "./runner.ts";
import * as memory from "./assistant/memory.ts";
import * as questions from "../mcp/questions.ts";
import * as hub from "../hosts/hub.ts";

/**
 * The API version from which a host can be a profile's assistant host: it takes the routed requests (`?local=1`) and
 * passes its agents' board tool calls up its link (see hosts/uplink.ts).
 */
export const ASSISTANT_HOST_API = 112;

/**
 * The assistant whose workspace a run of `task` has: the assistant's own, and a routine thread's its parent's
 * (`parent`), whose workspace it has to be in. None for any other thread.
 */
export function whose_workspace(task: Task, parent: Task | null): Task | null {
  if (db.is_assistant(task)) return task;
  if (!db.is_routine(task)) return null;
  if (parent && db.is_assistant(parent) && parent.work_dir === task.work_dir) return parent;
  throw new Error("this routine thread's assistant, or its workspace, is gone");
}

/** Where an assistant works, relative to the data dir (see documents.work_dir), so it moves with it. */
export function work_dir(task_id: string): string {
  return `assistants/${task_id}`;
}

/**
 * The profile's assistant, made the first time it's asked for. The check and the insert run with nothing in between
 * (they're synchronous), so two first opens at once make one between them.
 */
export function get_or_create(s: Shared, profile_id: string): Task {
  const c = s.db();
  if (!db.get_profile(c, profile_id)) throw ApiError.not_found("profile");
  let task = db.assistant_task(c, profile_id);
  const made = task === null;
  if (task === null) {
    const t = db.insert_assistant_task(
      c,
      { profile_id, project_id: null, kind: "task", title: "Assistant", description: "", status: "todo", use_worktree: false },
      work_dir,
    );
    // Its title stays: it isn't renamed after the user's prompts (see title.refresh).
    task = db.update_task(c, t.id, [["title_pinned", true]]) ?? t;
  }
  // Its workspace, with its memory files (see assistant/memory.ts). Made again if it went missing. It's made a git
  // repository before its first run, or when the Memory tab opens.
  try {
    const dir = memory.checked(s, task);
    try {
      memory.seed(dir);
    } catch (e) {
      console.warn(`task ${task.id}: making the assistant's memory files in ${dir}: ${err_str(e)}`);
    }
  } catch (e) {
    console.warn(`task ${task.id}: the assistant's folder: ${err_str(e)}`);
  }
  if (made) s.emit_task(task);
  return task;
}

/**
 * Send the user's message to the profile's assistant (made if it has none yet), starting its agent or steering the one
 * that's running, as a message in its thread does.
 */
export function send(s: Shared, profile_id: string, text: string): Task {
  const task = get_or_create(s, profile_id);
  const t = runner.send(s, task.id, text);
  if (text.trim()) questions.replied(s, t.id);
  return t;
}

/** The assistant as the API returns it: with the host it's on. */
export function with_host(s: Shared, t: Task): any {
  return { ...t, host_id: s.host_id };
}

/**
 * What a profile's `assistant_host` may be set to, as it's stored: null for this host, else a linked host that can be an
 * assistant host (API 112).
 */
export function check_host(s: Shared, v: any): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw ApiError.bad("assistant_host must be a linked host's id or null");
  const id = v.trim();
  if (!id || id === s.host_id) return null;
  const link = db.get_link(s.db(), id);
  if (!link) throw ApiError.bad("assistant_host must be a linked host");
  // One that's offline can't say; it's checked when it's used.
  const live = s.links.get(id);
  if (live && live.version.api_version < ASSISTANT_HOST_API) {
    throw ApiError.bad(`${link.name} runs an older build that can't be an assistant host; update it first`);
  }
  return id;
}

/**
 * Profile `profile_id`'s assistant on its assistant host, through `method` on `/profiles/{id}/assistant` there (with the
 * host's id): null when it has none, and it's on this host.
 */
export async function on_its_host(s: Shared, profile_id: string, method: string, body: any = null): Promise<any | null> {
  const p = db.get_profile(s.db(), profile_id);
  if (!p) throw ApiError.not_found("profile");
  const host = p.assistant_host;
  if (!host || host === s.host_id) return null;
  const name = db.get_link(s.db(), host)?.name ?? host;
  const link = s.links.get(host);
  if (!link) throw new ApiError(503, `${p.name}'s assistant runs on ${name}, which is offline`);
  // A host that dialled in under the id of one we dial isn't it: the user's messages don't go there.
  const stored = db.get_link(s.db(), host);
  if (stored && !hub.linked_via(stored, hub.conn_via(link))) {
    throw new ApiError(503, `${p.name}'s assistant runs on ${name}, which isn't connected the way it's linked (another host dialled in under its id)`);
  }
  if (link.version.api_version < ASSISTANT_HOST_API) {
    throw ApiError.conflict(`${p.name}'s assistant runs on ${name}, which runs an older build that can't be an assistant host; update it`);
  }
  // Its profile of the same name: profiles are matched by name across hosts.
  const profiles = await hub.host_request(s, host, "GET", "/api/profiles");
  const there = (Array.isArray(profiles) ? profiles : []).find((r: any) => r?.name === p.name && typeof r?.id === "string")?.id;
  if (!there) throw ApiError.conflict(`${name} has no profile named ${p.name}, for its assistant; add one there`);
  const t = await hub.host_request(s, host, method, `/api/profiles/${there}/assistant?local=1`, body);
  return t && typeof t === "object" && !Array.isArray(t) ? { ...t, host_id: host } : t;
}

/** Statuses the assistant can't be moved to: it never goes to review or merge, nor is it done or parked, since it lasts. */
export const NOT_FOR_ASSISTANT = ["in_review", "ready_for_merge", "done", "backlog"];
