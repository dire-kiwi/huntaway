// Port of server/src/agent/focus.rs.
/**
 * The board's now/later split: a task is in "later" until it's put in "now" (by the user's prompt to its agent, an
 * update to it, or from the board or the API), and goes back after a day with no activity on it. The day is the host's
 * `now_expiry_hours` setting; 0 keeps tasks in "now" until they're moved.
 *
 * A task in "now" has `now_at` set (see `Task.now_at`). Anything that adds to its thread (the agent's output, a prompt,
 * an answer) moves `last_activity_at`, and a task whose agent is running is never taken out, so what a task has to go
 * without for a day is both.
 */
import * as db from "../db.ts";
import type { Conn, Task } from "../db.ts";
import type { AppState, Shared } from "../state.ts";
import { err_str, now } from "../util.ts";

/** The host setting for how many hours a task in "now" can go without activity before it goes back to "later". */
export const EXPIRY_SETTING = "now_expiry_hours";

/** The hours when the setting isn't set. */
export const DEFAULT_EXPIRY_HOURS = 24;

/** The longest the setting can be: a year. */
export const MAX_EXPIRY_HOURS = 24 * 365;

/** How often tasks are looked at, in milliseconds. */
const SWEEP = 60_000;

/** The hours the setting gives, 0 for never. */
export function expiry_hours(c: Conn): number {
  let v: string | null = null;
  try {
    v = db.get_setting(c, EXPIRY_SETTING);
  } catch {}
  const t = v?.trim() ?? "";
  // Rust's `parse::<u32>()`.
  if (!/^\+?\d+$/.test(t)) return DEFAULT_EXPIRY_HOURS;
  const h = Number(t.replace(/^\+/, ""));
  if (!Number.isSafeInteger(h) || h > 0xffff_ffff) return DEFAULT_EXPIRY_HOURS;
  return Math.min(h, MAX_EXPIRY_HOURS);
}

/**
 * Puts the task in "now" from this moment (which is also what keeps one already there), unless it's a thread that
 * isn't a task. The task as it is then, if it changed.
 */
export function put_in_now(s: Shared, task_id: string): Task | null {
  try {
    return s.update_task_if(task_id, [["now_at", now()]], (c) => db.get_task(c, task_id)?.kind === "task");
  } catch (e) {
    console.warn(`task ${task_id}: putting a task in now failed: ${err_str(e)}`);
    return null;
  }
}

/**
 * Task `t` after a change made to it through `update_task` (the API's or the MCP tool's, `body` being what was asked
 * for): a task that's been updated at all, by the user or an agent, is in "now" (for another day). Unless the change
 * itself said where it goes (`now`), or only reorders it: the board renumbers a whole column's `position`s when a card is
 * dropped, and the other cards weren't touched.
 */
export function updated(s: Shared, t: Task, body: Record<string, any>): Task {
  const keys = Object.keys(body);
  // Nor moving it into or out of a pen (see db/pens.ts), which is arranging the board too.
  const reorder_only = keys.length > 0 && keys.every((k) => k === "position" || k === "pen" || k === "pen_id");
  if (reorder_only || (body.now !== undefined && body.now !== null)) return t;
  return put_in_now(s, t.id) ?? t;
}

/** Sends the tasks in "now" with nothing happening on them since `cutoff` back to "later". How many. */
function expire_before(s: AppState, cutoff: string): number {
  let ids: string[];
  try {
    ids = db.all(s.db(), "SELECT id FROM tasks WHERE now_at IS NOT NULL AND now_at <= ?1 AND last_activity_at <= ?1 AND running=0", cutoff).map((r) => r.id);
  } catch (e) {
    console.warn(`finding tasks to send back to later failed: ${err_str(e)}`);
    return 0;
  }
  let n = 0;
  for (const id of ids) {
    try {
      // Checked again as it's changed: a prompt since then keeps it.
      const moved = s.update_task_if(id, [["now_at", null]], (c) => {
        const t = db.get_task(c, id);
        return !!t && !t.running && t.now_at != null && t.now_at <= cutoff && t.last_activity_at <= cutoff;
      });
      if (moved) n++;
    } catch (e) {
      console.warn(`task ${id}: sending a task back to later failed: ${err_str(e)}`);
    }
  }
  return n;
}

/** Sends the tasks that have gone without activity for the setting's hours back to "later". How many. */
export function expire(s: AppState): number {
  const hours = expiry_hours(s.db());
  if (hours === 0) return 0;
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
  return expire_before(s, cutoff);
}

/** Looks for tasks to send back to "later" when the server starts, then every `SWEEP`. */
export function start(state: Shared): void {
  const tick = () => {
    const n = expire(state);
    if (n > 0) console.info(`sent ${n} idle tasks back to later`);
  };
  setImmediate(tick).unref();
  setInterval(tick, SWEEP).unref();
}
