// Port of server/src/mcp/tools/local.rs: the tools, as run on this host (`local`).
import * as db from "../../db.ts";
import type { Task } from "../../db.ts";
import type { Shared } from "../../state.ts";
import * as api from "../../api.ts";
import * as runner from "../../agent/runner.ts";
import * as assistant from "../../agent/assistant.ts";
import * as au from "../../integrations/automations.ts";
import * as permissions from "../permissions.ts";
import { ToolError, is_own, te, type Ctx } from "../tools.ts";
import { dependency_ids, pick_boards, project_json, project_settings_json, resolve_project, resolve_task, subproject_arg } from "./resolve.ts";
import { created, new_task_marks, reminder_args, summarize, task_details, task_field, task_overview } from "./tasks.ts";
import { create_project, project_creation, project_or_own, update_project } from "./projects.ts";
import { deletion, delete_task, resume_approval } from "./approvals.ts";
import {
  automation_creation,
  automation_input,
  automation_json,
  automation_update,
  automation_view,
  change_automation,
  has_secret,
  resolve_automation,
  own_routines,
  wants_routines,
  Guards_of,
} from "./automations.ts";
import { pen_tool } from "./pens.ts";
import * as pens_api from "../../api/pens.ts";
import { change_workflow, resolve_workflow, run_workflow, workflow_creation, workflow_deletion, workflow_json, workflow_update } from "./workflows.ts";
import * as wf from "../../integrations/workflows.ts";

/** A new task's fields, as `CreateTask::default()` has them. */
function create_task_body(): any {
  return {
    title: "",
    description: "",
    status: null,
    resolution: null,
    use_worktree: null,
    model: null,
    effort: null,
    kind: null,
    start: null,
    parent_id: null,
    subproject: null,
    claude_config_id: null,
    depends_on: null,
    task_type: null,
    labels: null,
    external_links: null,
    fanout_id: null,
    start_from: null,
  };
}

/** The pen `create_task` puts its new task in, checked before the task is made: its name, or null for none. */
function new_task_pen(args: any): string | null {
  if (args.pen == null || args.pen === "") return null;
  try {
    return db.check_pen_name(args.pen);
  } catch (e) {
    throw ToolError.other(te(e).message);
  }
}

/** Task `t`, just made, in pen `pen` (by name, made if need be), unless that's null. */
function into_pen(s: Shared, t: Task, pen: string | null): Task {
  if (pen === null) return t;
  const id = pens_api.task_pen(s, t, { pen });
  return id ? (s.update_task(t.id, [["pen_id", id]]) ?? t) : t;
}

/**
 * Which tasks are in pen `pen` (a name or id) on the caller's boards, or with "none" in no pen. Not found if none of them
 * has it, so linked hosts are asked.
 */
function pen_filter(s: Shared, ctx: Ctx, pen: string, profile: string | null): (t: Task) => boolean {
  if (pen.toLowerCase() === "none") return (t) => t.pen_id === null;
  const ids = new Set<string>();
  for (const b of pick_boards(s, ctx, profile)) {
    const p = db.get_pen(s.db(), pen) ?? db.pen_by_name(s.db(), b.id, pen);
    if (p && p.profile_id === b.id) ids.add(p.id);
  }
  if (!ids.size) throw ToolError.not_found(`pen ${pen}`);
  return (t) => t.pen_id !== null && ids.has(t.pen_id);
}

/** Run a board tool on this host. Throws a ToolError. */
export async function local(s: Shared, ctx: Ctx, tool: string, args: any): Promise<any> {
  try {
    return await local_inner(s, ctx, tool, args && typeof args === "object" && !Array.isArray(args) ? args : {});
  } catch (e) {
    throw te(e);
  }
}

async function local_inner(s: Shared, ctx: Ctx, tool: string, args: any): Promise<any> {
  const str_arg = (k: string): string | null => (typeof args[k] === "string" && args[k] !== "" ? args[k] : null);
  const profile = str_arg("profile");
  // The caller's own project and subproject are defaults only on its own board.
  const own_task = profile === null ? ctx.task : null;
  const own_project = own_task?.project_id ?? null;
  // The subproject the caller is (or works in): where its new tasks go by default.
  let own_subproject: Task | null = null;
  if (own_task) own_subproject = own_task.subproject ? own_task : db.subproject_of(s.db(), own_task);
  const bool_arg = (k: string): boolean | null => (typeof args[k] === "boolean" ? args[k] : null);
  const asked = () => (ctx.call_id !== null ? permissions.asked(s, ctx.call_id) : null);

  switch (tool) {
    case "list_projects": {
      const out: any[] = [];
      for (const b of pick_boards(s, ctx, profile)) {
        // Archived ones are off the board until the user unarchives them.
        for (const p of db.list_projects(s.db(), b.id).filter((p) => p.archived_at == null)) out.push(project_json(s, p, b));
      }
      return out;
    }
    case "list_tasks": {
      // undefined: every task; null: top-level ones; a task: that subproject's.
      let in_subproject: Task | null | undefined;
      const sp = str_arg("subproject");
      if (sp === "all") in_subproject = undefined;
      else if (sp === "none") in_subproject = null;
      else if (sp !== null) in_subproject = subproject_arg(s, ctx, sp, profile);
      // A subproject's agents see its tasks unless they ask for more.
      else if (str_arg("project_id") === null) in_subproject = own_subproject ?? undefined;
      else in_subproject = undefined;
      const pen = str_arg("pen");
      // A pen's tasks are from every project, unless it's given one.
      const pid = str_arg("project_id") ?? in_subproject?.project_id ?? (pen !== null ? null : own_project);
      let tasks: Task[];
      if (pid === null || pid === "all") {
        // Every task on the named board(s), else on the caller's own.
        const all = pick_boards(s, ctx, profile);
        const bs = profile === null && all.some((b) => is_own(ctx, b)) ? all.filter((b) => is_own(ctx, b)) : all;
        tasks = [];
        for (const b of bs) {
          const archived = db
            .list_projects(s.db(), b.id)
            .filter((p) => p.archived_at != null)
            .map((p) => p.id);
          // The assistant only when asked for, and only the caller's own (see agent/assistant.ts).
          const assistant = bool_arg("include_assistant") === true && is_own(ctx, b);
          const list = db.list_tasks_for_profile(s.db(), b.id, assistant);
          tasks.push(...list.filter((t) => t.project_id === null || !archived.includes(t.project_id)));
        }
      } else {
        const p = resolve_project(s, ctx, pid, profile);
        tasks = db.list_tasks_for_project(s.db(), p.id, "task");
      }
      const status = str_arg("status");
      if (pen !== null) {
        const in_pen = pen_filter(s, ctx, pen, profile);
        tasks = tasks.filter(in_pen);
      }
      return tasks
        .filter((t) => status === null || t.status === status)
        .filter((t) => in_subproject === undefined || (t.parent_id ?? null) === (in_subproject?.id ?? null))
        .map((t) => summarize(s, t));
    }
    case "get_task":
    case "get_task_field": {
      const t = resolve_task(s, ctx, str_arg("task_id") ?? "", profile);
      const details = task_details(s, ctx, t);
      if (tool === "get_task_field") return task_field(details, args);
      // Old helpers and linked hosts cannot offer the field tool. Keep all details available to them, including calls
      // forwarded by an upgraded host.
      return ctx.task_fields ? task_overview(details) : details;
    }
    case "create_task": {
      // A scratch task is in no project unless it's given one (or a subproject); the caller's own project isn't a
      // default for it, as it wasn't before scratch tasks could be in one.
      const sp = str_arg("subproject");
      if (str_arg("type") === db.SCRATCH && str_arg("project_id") === null && (sp === null || sp === "none")) {
        if (args.is_subproject === true) throw ToolError.other("a scratch task can't be a subproject");
        // On the caller's own board unless it names another.
        const bs = pick_boards(s, ctx, profile);
        const board = profile === null ? (bs.find((b) => is_own(ctx, b)) ?? bs[0]) : bs[0];
        if (!board) throw ToolError.not_found("your profile's board");
        const body = {
          ...create_task_body(),
          title: str_arg("title") ?? "",
          description: str_arg("description") ?? "",
          status: str_arg("status"),
          resolution: str_arg("resolution"),
          start: args.start === true ? true : null,
          labels: args.labels ?? null,
        };
        const marks = new_task_marks(args);
        const pen = new_task_pen(args);
        let t = api.create_scratch_task_inner(s, board.id, body);
        t = created(s, ctx, t, marks);
        t = into_pen(s, t, pen);
        return summarize(s, t);
      }
      let parent: Task | null = sp !== null && sp !== "none" ? subproject_arg(s, ctx, sp, profile) : null;
      let project: db.Project;
      const given_pid = str_arg("project_id");
      if (given_pid !== null) project = resolve_project(s, ctx, given_pid, profile);
      else {
        const pid = parent?.project_id ?? own_project;
        if (pid === null) throw ToolError.other("project_id is required (use list_projects)");
        const p = db.get_project(s.db(), pid);
        if (!p) throw ToolError.not_found(`project ${pid}`);
        project = p;
      }
      // Tasks created from a subproject (or one of its tasks) go in it, unless they're for another project.
      if (sp === null) parent = own_subproject && own_subproject.project_id === project.id ? own_subproject : null;
      const body = {
        ...create_task_body(),
        parent_id: parent?.id ?? null,
        subproject: bool_arg("is_subproject"),
        title: str_arg("title") ?? "",
        description: str_arg("description") ?? "",
        status: str_arg("status"),
        resolution: str_arg("resolution"),
        use_worktree: bool_arg("use_worktree"),
        start: args.start === true ? true : null,
        // The project's profile's default, so its agent runs with that profile's login.
        claude_config_id: null,
        depends_on: dependency_ids(s, ctx, args.depends_on, profile),
        task_type: str_arg("type"),
        labels: args.labels ?? null,
        start_from: args.start_from ?? null,
      };
      const marks = new_task_marks(args);
      const pen = new_task_pen(args);
      let t = api.create_task_inner(s, project.id, body);
      t = created(s, ctx, t, marks);
      t = into_pen(s, t, pen);
      return summarize(s, t);
    }
    case "update_task": {
      const found = resolve_task(s, ctx, str_arg("task_id") ?? "", profile);
      const body: Record<string, any> = {};
      for (const k of ["title", "description", "status", "resolution", "preview_url", "pr_url", "remerge", "labels", "start_from"]) {
        if (args[k] != null) body[k] = args[k];
      }
      const ids = dependency_ids(s, ctx, args.depends_on, profile);
      if (ids !== null) body.depends_on = ids;
      Object.assign(body, reminder_args(args));
      if (typeof args.pen === "string") body.pen = args.pen;
      return summarize(s, await api.update_task_inner(s, found.id, body));
    }
    case "delete_task": {
      // A call retried after a restart carries on with the deletion it asked about.
      let input = asked();
      if (input === null) {
        const t = resolve_task(s, ctx, str_arg("task_id") ?? "", profile);
        input = deletion(s, ctx, t, args.delete_branch === true, str_arg("reason"));
      }
      return delete_task(s, ctx, input);
    }
    case "send_to_task": {
      const found = resolve_task(s, ctx, str_arg("task_id") ?? "", profile);
      if (ctx.task && ctx.task.id === found.id) throw ToolError.other("cannot send a message to your own task");
      const t = runner.send_from_agent(s, found.id, str_arg("message") ?? "");
      return summarize(s, t);
    }
    case "get_project":
    case "update_project": {
      // A call retried after a restart carries on with the approval it asked for, and the project it was for, whatever
      // has changed since.
      if (tool === "update_project") {
        const saved = asked();
        if (saved !== null) return resume_approval(s, ctx, saved);
      }
      let p: db.Project;
      const pid = str_arg("project_id");
      if (pid !== null) p = resolve_project(s, ctx, pid, profile);
      else {
        if (own_project === null) throw ToolError.other("project_id is required (use list_projects)");
        const found = db.get_project(s.db(), own_project);
        if (!found) throw ToolError.not_found(`project ${own_project}`);
        p = found;
      }
      const board = db.get_profile(s.db(), p.profile_id);
      if (!board) throw ToolError.not_found("profile");
      if (tool === "update_project") p = await update_project(s, ctx, p, args, str_arg("reason"));
      return project_settings_json(s, p, board);
    }
    case "create_project": {
      // A call retried after a restart carries on with the approval it asked for.
      const saved = asked();
      if (saved !== null) return create_project(s, ctx, saved);
      const bs = pick_boards(s, ctx, profile);
      const board = profile !== null ? bs[0] : bs.find((b) => is_own(ctx, b));
      if (!board) throw ToolError.not_found(`profile ${ctx.profile_name} on host ${s.host_name}`);
      const input = await project_creation(s, ctx, board, str_arg("name"), str_arg("repo_path") ?? "", str_arg("reason"));
      return create_project(s, ctx, input);
    }
    case "list_automations": {
      if (wants_routines(ctx, args)) {
        const owner = own_routines(s, ctx, profile);
        const list = au.list_routines(s.db(), au.owner_profile_id(owner)).map((a) => automation_json(s, a));
        return { profile: ctx.profile_name, routines: list, time_zone: au.time_zone() };
      }
      const p = project_or_own(s, ctx, str_arg("project_id"), profile, own_project);
      const list = au.list(s.db(), p.id).map((a) => automation_json(s, a));
      return { project: { id: p.id, key: p.key, name: p.name }, automations: list, time_zone: au.time_zone() };
    }
    case "create_automation":
    case "update_automation":
    case "delete_automation": {
      // A call retried after a restart carries on with the approval it asked for.
      const saved = asked();
      if (saved !== null) return change_automation(s, ctx, saved);
      let input: any;
      if (tool === "create_automation") {
        const owner: au.Owner = wants_routines(ctx, args)
          ? own_routines(s, ctx, profile)
          : { project: project_or_own(s, ctx, str_arg("project_id"), profile, own_project) };
        // Not one that couldn't run, before the user's asked about it (see running.guards).
        const rp = "profile" in owner ? db.get_profile(s.db(), owner.profile) : null;
        const elsewhere = rp ? assistant.routines_elsewhere(s, rp) : null;
        if (elsewhere !== null) throw ToolError.other(elsewhere);
        input = automation_creation(s, ctx, owner, args, profile);
      } else if (tool === "update_automation") {
        const [a, p] = resolve_automation(s, ctx, args, profile, own_project);
        const u = automation_update(s, ctx, a, p, args, profile);
        // Nothing that needs asking: turning it off, or renaming it.
        if ("apply" in u) return automation_json(s, au.update(s, a.id, u.apply));
        input = u.ask;
      } else {
        const [a, p] = resolve_automation(s, ctx, args, profile, own_project);
        const view = automation_view(s, a.id, a.name, a.enabled, a.trigger, a.action, has_secret(a), Guards_of(a));
        input = automation_input(s, ctx, "delete", p, view);
        input.reason = str_arg("reason");
      }
      return change_automation(s, ctx, input);
    }
    case "run_automation": {
      const [a] = resolve_automation(s, ctx, args, profile, own_project);
      const event = str_arg("event");
      const payload = args.payload ?? null;
      const run = await au.run_now(s, a, { payload, event });
      return au.run_json(s.db(), run);
    }
    case "list_workflows": {
      const p = project_or_own(s, ctx, str_arg("project_id"), profile, own_project);
      return { project: { id: p.id, key: p.key, name: p.name }, workflows: wf.list(s.db(), p.id).map(workflow_json) };
    }
    case "create_workflow":
    case "update_workflow":
    case "delete_workflow": {
      // A call retried after a restart carries on with the approval it asked for.
      const saved = asked();
      if (saved !== null) return change_workflow(s, ctx, saved);
      let input: any;
      if (tool === "create_workflow") {
        const p = project_or_own(s, ctx, str_arg("project_id"), profile, own_project);
        input = workflow_creation(s, ctx, p, args);
      } else if (tool === "update_workflow") {
        const [w, p] = resolve_workflow(s, ctx, args, profile, own_project);
        const u = workflow_update(s, ctx, w, p, args);
        // Nothing that needs asking: turning it off, or renaming it.
        if ("apply" in u) return workflow_json(wf.update(s, w.id, u.apply));
        input = u.ask;
      } else {
        const [w, p] = resolve_workflow(s, ctx, args, profile, own_project);
        input = workflow_deletion(s, ctx, w, p, str_arg("reason"));
      }
      return change_workflow(s, ctx, input);
    }
    case "run_workflow":
      return run_workflow(s, ctx, args, profile, own_project);
    case "list_pens":
    case "create_pen":
    case "update_pen":
    case "delete_pen":
      return pen_tool(s, ctx, tool, args, profile);
    default:
      throw ToolError.other(`unknown tool ${tool}`);
  }
}
