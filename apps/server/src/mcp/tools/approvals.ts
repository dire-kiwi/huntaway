// Port of server/src/mcp/tools/approvals.rs: changes that wait for the user's approval in the agent's thread: asking,
// carrying on once answered, and deleting tasks.
import * as db from "../../db.ts";
import type { Task } from "../../db.ts";
import type { Shared } from "../../state.ts";
import * as api from "../../api.ts";
import * as permissions from "../permissions.ts";
import { ToolError, type Ctx } from "../tools.ts";
import { project_key, project_settings_json } from "./resolve.ts";
import { apply_changes } from "./projects.ts";

/**
 * Carries on with the approval `saved` that this call asked for before it was retried: waits for the answer if there
 * isn't one yet, then makes exactly what was asked, if approved.
 */
export async function resume_approval(s: Shared, ctx: Ctx, saved: any): Promise<any> {
  const approved = await ask_user(s, ctx, "update_project", saved);
  const pid = typeof approved?.project?.id === "string" ? approved.project.id : "";
  const found = db.get_project(s.db(), pid);
  if (!found) throw ToolError.not_found(`project ${pid}`);
  const p = await apply_changes(s, found, approved.apply);
  const board = db.get_profile(s.db(), p.profile_id);
  if (!board) throw ToolError.not_found("profile");
  return project_settings_json(s, p, board);
}

/** What an approval asks for, for the agent, e.g. "changing setup_script" or "deleting KIW-2". */
/** Whether an automation approval's input is about a profile's routine (it names the profile, not a project). */
function is_routine_input(input: any): boolean {
  return input?.profile !== null && typeof input?.profile === "object" && !Array.isArray(input.profile);
}

function approval_what(tool: string, input: any): string {
  if (tool === "create_project") return `adding ${typeof input?.repo_path === "string" ? input.repo_path : "the folder"} as a project`;
  if (tool === "delete_task") return `deleting ${typeof input?.delete?.key === "string" ? input.delete.key : "the task"}`;
  if (tool.endsWith("_workflow")) {
    const op = tool.slice(0, -"_workflow".length);
    const verb = op === "create" ? "creating" : op === "update" ? "changing" : "deleting";
    return `${verb} the workflow "${typeof input?.workflow?.name === "string" ? input.workflow.name : ""}"`;
  }
  if (tool.endsWith("_automation")) {
    const op = tool.slice(0, -"_automation".length);
    const verb = op === "create" ? "creating" : op === "update" ? "changing" : "deleting";
    const what = is_routine_input(input) ? "routine" : "automation";
    return `${verb} the ${what} "${typeof input?.automation?.name === "string" ? input.automation.name : ""}"`;
  }
  const changes: any[] = Array.isArray(input?.changes) ? input.changes : [];
  const fields = changes.filter((c) => c?.needs_approval === true && typeof c.field === "string").map((c) => c.field);
  return `changing ${fields.join(", ")}`;
}

/**
 * Asks the user to approve what `input` describes for `tool` (update_project, delete_task or an automation tool) in the
 * calling agent's thread, and waits for their answer: the input they approved.
 */
export async function ask_user(s: Shared, ctx: Ctx, tool: string, input: any): Promise<any> {
  const what = approval_what(tool, input);
  let [kind, of, instead, nothing] = ["project", "project", "ask the user to do it in the project's settings", "changed"];
  const routine = is_routine_input(input);
  if (tool === "delete_task") [kind, of, instead, nothing] = ["delete_task", "task", "ask the user to delete it on the board", "deleted"];
  else if (tool === "create_automation" && routine) [kind, of, instead, nothing] = ["automation", "profile", "ask the user to add it on the assistant's Routines page", "created"];
  else if ((tool === "update_automation" || tool === "delete_automation") && routine)
    [kind, of, instead, nothing] = ["automation", "profile", "ask the user to do it on the assistant's Routines page", "changed"];
  else if (tool === "create_automation") [kind, of, instead, nothing] = ["automation", "project", "ask the user to add it in the project's settings (Automations)", "created"];
  else if (tool === "update_automation" || tool === "delete_automation")
    [kind, of, instead, nothing] = ["automation", "project", "ask the user to do it in the project's settings (Automations)", "changed"];
  // Workflow changes are asked as automations are (the board shows them by their `workflow`).
  else if (tool === "create_workflow") [kind, of, instead, nothing] = ["automation", "project", "ask the user to add it in the project's settings (Workflows)", "created"];
  else if (tool === "update_workflow" || tool === "delete_workflow")
    [kind, of, instead, nothing] = ["automation", "project", "ask the user to do it in the project's settings (Workflows)", "changed"];
  else if (tool === "create_project") [kind, of, instead, nothing] = ["project", "board", "ask the user to add it on the board", "added"];
  if (!ctx.task || ctx.call_id === null) {
    // Agents on other hosts have no thread here to ask in.
    throw ToolError.other(`${what} needs the user's approval, which only an agent on the ${of}'s own host can ask for; ${instead}`);
  }
  const r = await permissions.approve(s, ctx.task, ctx.call_id, kind, tool, input);
  if ("err" in r) throw ToolError.other(`The user didn't approve ${what}, so nothing was ${nothing}: ${r.err}`);
  return r.ok;
}

/** What `delete_task` asks the user to confirm: deleting `t`, and a subproject's tasks with it. */
export function deletion(s: Shared, ctx: Ctx, t: Task, delete_branch: boolean, reason: string | null): any {
  const with_it = t.subproject ? db.subproject_tasks(s.db(), t.id) : [];
  const own = ctx.task;
  if (own) {
    if (own.id === t.id) throw ToolError.other("you can't delete your own task");
    if (with_it.some((c) => c.id === own.id)) throw ToolError.other("you can't delete the subproject you're in");
  }
  const project = t.project_id ? db.get_project(s.db(), t.project_id) : null;
  const item = (t: Task): any => ({ id: t.id, key: `${project_key(s, t)}-${t.number}`, title: t.title, status: t.status });
  const del = item(t);
  del.branch = t.branch ?? null;
  del.running = s.is_running(t.id);
  del.subproject = t.subproject;
  return {
    project: project ? approval_project(s, project) : null,
    task: approval_task(s, ctx),
    delete: del,
    tasks_with_it: with_it.map(item),
    delete_branch,
    reason,
  };
}

/** `delete_task`: deletes what `input` (see `deletion`) describes once the user confirms it. */
export async function delete_task(s: Shared, ctx: Ctx, input: any): Promise<any> {
  const id: string = typeof input?.delete?.id === "string" ? input.delete.id : "";
  const key: string = typeof input?.delete?.key === "string" ? input.delete.key : "";
  const gone = () => db.get_task(s.db(), id) === null;
  const already = { deleted: false, key, note: "It was deleted meanwhile (not by this call)." };
  let approved: any;
  try {
    approved = await ask_user(s, ctx, "delete_task", input);
  } catch (e) {
    // Deleted while the user was asked, which settles the question.
    if (gone()) return already;
    throw e;
  }
  // No task can be added to it from here on, so what's checked below is what goes.
  const deleting = new api.Deleting(s, id);
  try {
    const t = db.get_task(s.db(), id);
    if (!t) return already;
    const delete_branch = approved?.delete_branch === true;
    // Only the tasks the user was shown go with it: a subproject's tasks added since (or an ordinary task made a
    // subproject since) need asking again.
    const shown: string[] = (Array.isArray(approved?.tasks_with_it) ? approved.tasks_with_it : []).map((c: any) => c?.id).filter((x: any) => typeof x === "string");
    // Every task in it, whether or not it's (still) a subproject, as they'd all go with it.
    const children = db.subproject_tasks(s.db(), t.id);
    const unshown = children.filter((c) => !shown.includes(c.id)).map((c) => `${project_key(s, c)}-${c.number}`);
    if (unshown.length) {
      throw ToolError.other(
        `${unshown.join(", ")} became tasks of ${key} while the user was asked, so nothing was deleted; call delete_task again so the user can confirm deleting them too`,
      );
    }
    for (const c of children) await api.delete_one(s, c, delete_branch);
    await api.delete_last(s, t, delete_branch);
    return { deleted: true, key, title: t.title, tasks_deleted_with_it: children.length };
  } finally {
    deleting.drop();
  }
}

/** The project a change is to, as the approval shows it. */
export function approval_project(s: Shared, p: db.Project): any {
  return { id: p.id, key: p.key, name: p.name, host: s.host_name };
}

/** The thread asking for a change, as the approval shows it. */
export function approval_task(s: Shared, ctx: Ctx): any {
  const t = ctx.task;
  if (!t) return null;
  if (t.kind === "task") return { id: t.id, key: `${project_key(s, t)}-${t.number}`, title: t.title };
  return { id: t.id, title: t.title };
}
