// Port of server/src/agent/assistant.rs (HA-119, on the HA-117 branch).
/**
 * Each profile's assistant: one long-lived thread in no project, keyed `A-<n>`, that the user talks to from the board's
 * sidebar. It's a task (see db.is_assistant), so it has the thread UI, runs, steering, compaction, prompts and the board
 * tools of any other, but it works in a workspace of its own (`assistants/<task id>` in the data dir) and never goes to
 * review or merge.
 *
 * `get_or_create` is the one place a profile's assistant is found. A later step routes it to a linked host of its own
 * (an *Assistant host* setting per profile), which goes there.
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

/** Statuses the assistant can't be moved to: it never goes to review or merge, nor is it done or parked, since it lasts. */
export const NOT_FOR_ASSISTANT = ["in_review", "ready_for_merge", "done", "backlog"];
