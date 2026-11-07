// Pens (HA-285, API 126): a profile's named sets of tasks, which its board shows as tabs (see db/pens.ts). They're this
// host's own, so a hub reaches them through `/h/{host}/…` like the rest; a board spanning hosts merges them by name.
//
// - `GET /profiles/{id}/pens`: its pens in their tabs' order, each with its `task_count`.
// - `POST /profiles/{id}/pens` (`name`, `hidden`): a new pen, at the end of the tabs. 409 if it has one by that name.
// - `PATCH /pens/{id}` (`name`, `hidden`, `index`: its tab's place among the profile's pens, from 0).
// - `DELETE /pens/{id}`: its tasks are in no pen after.
// - `GET /profiles/{id}/pens-thread`: the profile's pens thread (see agent/pens.ts), made if it has none.
//
// A task goes into a pen with `PATCH /tasks/{id}` and `pen` (a pen's name, which is made if the profile has none by it)
// or `pen_id`; null or "" takes it out. Each change to a profile's pens is a `pens` event with its `profile_id`.
import * as db from "../db.ts";
import { ApiError, type Req } from "../http.ts";
import { json_map } from "./extract.ts";
import type { AppState, Shared } from "../state.ts";
import { err_str } from "../util.ts";
import * as pens from "../agent/pens.ts";

function profile(s: AppState, r: Req): db.Profile {
  const p = db.get_profile(s.db(), r.params.id);
  if (!p) throw ApiError.not_found("profile");
  return p;
}

function pen(s: AppState, r: Req): db.Pen {
  const p = db.get_pen(s.db(), r.params.id);
  if (!p) throw ApiError.not_found("pen");
  return p;
}

/** Tells the boards that the profile's pens changed. */
export function changed(s: Shared, profile_id: string): void {
  s.emit({ type: "pens", profile_id });
}

/** A pen as the API returns it, with how many tasks it has. */
export function pen_json(p: db.Pen, counts: Map<string, number>): any {
  return { ...p, task_count: counts.get(p.id) ?? 0 };
}

export async function list(s: AppState, r: Req) {
  const p = profile(s, r);
  const counts = db.pen_counts(s.db(), p.id);
  return db.list_pens(s.db(), p.id).map((x) => pen_json(x, counts));
}

/** A database's error (a name taken, say) as the API's. */
function bad(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  const m = err_str(e);
  return m.includes("already") ? ApiError.conflict(m) : ApiError.bad(m);
}

export async function create(s: AppState, r: Req) {
  const p = profile(s, r);
  const b = json_map(r);
  if (b.hidden != null && typeof b.hidden !== "boolean") throw ApiError.bad("hidden must be true or false");
  let made: db.Pen;
  try {
    made = db.insert_pen(s.db(), p.id, b.name, b.hidden === true);
  } catch (e) {
    throw bad(e);
  }
  changed(s, p.id);
  return pen_json(made, new Map());
}

/** The change `b` asks of a pen, checked. */
export function pen_change(b: Record<string, any>): { name?: string; hidden?: boolean; index?: number } {
  const ch: { name?: string; hidden?: boolean; index?: number } = {};
  if (b.name != null) ch.name = b.name;
  if (b.hidden != null) {
    if (typeof b.hidden !== "boolean") throw ApiError.bad("hidden must be true or false");
    ch.hidden = b.hidden;
  }
  if (b.index != null) {
    if (typeof b.index !== "number" || !Number.isFinite(b.index)) throw ApiError.bad("index must be a number");
    ch.index = b.index;
  }
  return ch;
}

export async function update(s: AppState, r: Req) {
  const p = pen(s, r);
  let out: db.Pen | null;
  try {
    out = db.update_pen(s.db(), p.id, pen_change(json_map(r)));
  } catch (e) {
    throw bad(e);
  }
  if (!out) throw ApiError.not_found("pen");
  changed(s, p.profile_id);
  return pen_json(out, db.pen_counts(s.db(), p.profile_id));
}

export async function remove(s: AppState, r: Req) {
  const p = pen(s, r);
  removed(s, p);
  return { ok: true };
}

/** Deletes pen `p`, telling the boards of it and of its tasks, which are in no pen after. */
export function removed(s: Shared, p: db.Pen): void {
  const ids = db.delete_pen(s.db(), p.id);
  for (const id of ids) {
    const t = db.get_task(s.db(), id);
    if (t) s.emit_task(t);
  }
  changed(s, p.profile_id);
}

export async function thread(s: AppState, r: Req) {
  return pens.with_host(s, pens.get_or_create(s, profile(s, r).id));
}

/**
 * The `pen_id` field a task update asks for with `pen` (a name, made if the profile has none by it) or `pen_id`, null or
 * "" being none; undefined if it asks for neither. Only a task on the board can be in a pen.
 */
export function task_pen(s: Shared, task: db.Task, b: Record<string, any>): string | null | undefined {
  const by_name = Object.hasOwn(b, "pen");
  if (!by_name && !Object.hasOwn(b, "pen_id")) return undefined;
  const v = by_name ? b.pen : b.pen_id;
  if (v !== null && typeof v !== "string") throw ApiError.bad(by_name ? "pen must be a pen's name, or null" : "pen_id must be a pen's id, or null");
  const none = v === null || v.trim() === "";
  if (task.kind !== "task" || db.is_assistants(task) || db.is_pens_thread(task)) {
    if (none) return null;
    throw ApiError.bad("only a task on the board can be in a pen");
  }
  if (none) return null;
  if (!by_name) {
    const p = db.get_pen(s.db(), v);
    if (!p || p.profile_id !== task.profile_id) throw ApiError.not_found("pen");
    return p.id;
  }
  const had = db.pen_by_name(s.db(), task.profile_id, v);
  if (had) return had.id;
  let made: db.Pen;
  try {
    made = db.pen_named(s.db(), task.profile_id, v);
  } catch (e) {
    throw bad(e);
  }
  changed(s, task.profile_id);
  return made.id;
}
