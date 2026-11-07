/**
 * Each profile's pens thread (HA-285): one long-lived thread in no project, keyed `S-<n>` among the profile's scratch
 * tasks, that arranges the profile's pens (see db/pens.ts) as the user asks: making, renaming, hiding, showing and
 * ordering them, and moving tasks into and out of them, so the board's tabs show the work the user is on. It's opened
 * from the profile board's tab bar, and like the assistant it never goes to review or merge (see db.is_pens_thread). It
 * works in the profile's scratch folder.
 */
import * as db from "../db.ts";
import type { Task } from "../db.ts";
import { ApiError } from "../http.ts";
import type { Shared } from "../state.ts";

/**
 * The profile's pens thread, made the first time it's asked for. The check and the insert run with nothing in between
 * (they're synchronous), so two first opens at once make one between them.
 */
export function get_or_create(s: Shared, profile_id: string): Task {
  const c = s.db();
  if (!db.get_profile(c, profile_id)) throw ApiError.not_found("profile");
  const found = db.pens_thread(c, profile_id);
  if (found) return found;
  const t = db.insert_pens_thread(c, { profile_id, project_id: null, kind: "task", title: "Pens", description: "", status: "todo", use_worktree: false });
  s.emit_task(t);
  return t;
}

/** The pens thread as the API returns it: with the host it's on. */
export function with_host(s: Shared, t: Task): any {
  return { ...t, host_id: s.host_id };
}

/** What the pens thread's agent is told, `tools` being what every agent is told of the board's tools. */
export function system_prompt(task: Task, tools: string): string {
  return (
    `You keep the pens of this Huntaway profile, in thread S-${task.number} (id ${task.id}) on the Huntaway board, a kanban board where each ` +
    "task is worked by its own Claude agent, grouped into projects. A pen is a named set of tasks, from any of the " +
    "profile's projects (and its tasks in no project); the profile's board shows each pen that isn't hidden as a tab, " +
    "in the pens' order, beside an All tab with every task. A task is in one pen at most. The user keeps pens for what " +
    "they're working on (today, this week, a feature that spans projects) and for work they've parked to come back to. " +
    "You aren't a coding agent and you aren't in a project or a repository: your working directory is a scratch folder.\n\n" +
    `${tools}\n\n` +
    "For the pens there are also `list_pens` (the pens with their tasks), `create_pen`, `update_pen` (rename, hide or " +
    "show, or move its tab with `index`), and `delete_pen` (its tasks stay, in no pen); `update_task` with `pen` moves a " +
    "task into a pen (by its name, making the pen if there's none by that name) or, with an empty string, out of its pen; " +
    '`create_task` takes `pen` too; and `list_tasks` with `pen` lists a pen\'s tasks (`pen: "none"` lists those in no pen).\n\n' +
    "Do what the user asks to set up the view they want: for example, when they say what they're working on today, " +
    "find those tasks with `list_tasks` (project_id='all') and `get_task`, put them in a pen for it (making it if need " +
    "be), show it, and hide the pens they're not on. Ask before deleting a pen that has tasks, and don't change the " +
    "tasks themselves (their status, title or description) or start their agents unless the user asks. When the user " +
    "names a task loosely, match it by key, title or project; if more than one fits, ask.\n\n" +
    "If you need a decision or information from the user before you can go on, call `request_user_input` with your " +
    "question (and its `options`, when the choices are known), then end your turn. Otherwise just reply with what you " +
    "changed: this thread stays open and never goes to review or merge, so don't move it to another status."
  );
}
