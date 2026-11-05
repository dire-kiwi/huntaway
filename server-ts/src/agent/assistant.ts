// Port of server/src/agent/assistant.rs (HA-119, on the HA-117 branch).
/**
 * Each profile's assistant: one long-lived thread in no project, keyed `A-<n>`, that the user talks to from the board's
 * sidebar. It's a task (see db.is_assistant), so it has the thread UI, runs, steering, compaction, prompts and the board
 * tools of any other, but it works in a workspace of its own (`assistants/<task id>` in the data dir) and never goes to
 * review or merge.
 *
 * `get_or_create` is the one place a profile's assistant is found. A later step routes it to a linked host of its own
 * (an *Assistant host* setting per profile), which goes there.
 */
import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as db from "../db.ts";
import type { Task } from "../db.ts";
import { ApiError } from "../http.ts";
import type { Shared } from "../state.ts";
import { err_str } from "../util.ts";
import * as runner from "./runner.ts";
import * as documents from "./documents.ts";
import * as questions from "../mcp/questions.ts";

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

/**
 * The assistant's workspace, made if it isn't there, once it's checked to be its own: `assistants/<task id>` in the data
 * dir, as real folders. A symlink in their place (or a file) could lead to another assistant's workspace, or anywhere
 * else, so it's refused, and nothing is run there. The data dir itself may be a symlink. (Rust's
 * `assistant::memory::checked`, which the memory's port keeps with the rest of it.)
 */
export function checked(state: Shared, task: Task): string {
  if (!db.is_assistant(task)) throw new Error(`${task.id} isn't an assistant`);
  if (task.work_dir !== work_dir(task.id)) throw new Error(`the assistant's folder isn't its own workspace (${JSON.stringify(task.work_dir)})`);
  let dir = state.data_dir;
  for (const part of ["assistants", task.id]) {
    dir = join(dir, part);
    try {
      mkdirSync(dir);
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw new Error(`making ${dir}: ${err_str(e)}`);
    }
    if (!lstatSync(dir).isDirectory()) {
      throw new Error(`${dir} isn't a folder of its own (it's a symlink or a file), so the assistant's memory isn't used`);
    }
  }
  return dir;
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
  // Its workspace, which later steps keep memory files in. Made again if it went missing.
  const dir = documents.work_dir(s, task);
  if (dir !== null) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (e) {
      console.warn(`task ${task.id}: making the assistant's folder ${dir}: ${err_str(e)}`);
    }
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

/** Statuses the assistant can't be moved to: it never goes to review or merge, nor is it done or parked, since it lasts. */
export const NOT_FOR_ASSISTANT = ["in_review", "ready_for_merge", "done", "backlog"];
