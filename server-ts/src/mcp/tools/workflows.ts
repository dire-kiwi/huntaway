// Port of server/src/mcp/tools/workflows.rs (HA-173's branch, ported by HA-189): the workflow tools: listing, creating,
// changing and running a project's workflows (see integrations/workflows.rs). Creating one, changing what it does or
// turning it on, and deleting one ask the user first, as automations do: a workflow starts agents on the project's tasks
// and sends them messages.
import * as db from "../../db.ts";
import type { Shared } from "../../state.ts";
import * as wf from "../../integrations/workflows.ts";
import { ToolError, json_eq, te, type Ctx } from "../tools.ts";
import { boards, resolve_task } from "./resolve.ts";
import { project_or_own } from "./projects.ts";
import { approval_project, approval_task, ask_user } from "./approvals.ts";

const eq_ic = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The workflow an agent names in `workflow_id`: its id, or its name in `project_id` (or the agent's own project). */
export function resolve_workflow(s: Shared, ctx: Ctx, args: any, profile: string | null, own_project: string | null): [wf.Workflow, db.Project] {
  const r = typeof args.workflow_id === "string" ? args.workflow_id.trim() : "";
  const by_id = wf.get(s.db(), r);
  if (by_id) {
    const p = db.get_project(s.db(), by_id.project_id);
    let usable = false;
    if (p) {
      try {
        usable = boards(s, ctx).some((b) => b.id === p.profile_id);
      } catch {}
    }
    if (p && usable) return [by_id, p];
    throw ToolError.not_found(`workflow ${r}`);
  }
  const pid = typeof args.project_id === "string" && args.project_id ? args.project_id : null;
  const p = project_or_own(s, ctx, pid, profile, own_project);
  const named = wf.list(s.db(), p.id).filter((w) => eq_ic(w.name, r));
  if (named.length === 0) throw ToolError.not_found(`workflow ${r} in ${p.key} (use list_workflows)`);
  if (named.length === 1) return [named[0], p];
  throw ToolError.other(`${p.key} has several workflows named ${r}; give its id (see list_workflows)`);
}

/** A workflow as list_workflows shows it. */
export function workflow_json(w: wf.Workflow): any {
  return wf.to_json(w);
}

/** A workflow as its approval shows it: what it is, with its agent steps' configs by name. */
export function workflow_view(s: Shared, id: string, name: string, enabled: boolean, graph: wf.Graph): any {
  const configs: any[] = [];
  for (const n of graph.nodes) {
    if (n.kind !== "agent" || !n.claude_config_id) continue;
    let c: db.ClaudeConfig | null = null;
    try {
      c = db.get_claude_config(s.db(), n.claude_config_id);
    } catch {}
    if (c) configs.push({ node: n.id, id: c.id, name: c.name, agent: c.agent });
  }
  return { id, name, enabled, graph, configs };
}

function workflow_input(s: Shared, ctx: Ctx, op: string, p: db.Project, workflow: any): any {
  return { op, project: approval_project(s, p), task: approval_task(s, ctx), workflow };
}

/** What `create_workflow` asks the user to approve: the workflow, checked. */
export function workflow_creation(s: Shared, ctx: Ctx, p: db.Project, args: any): any {
  const name = wf.check_name(args.name ?? null);
  const graph = wf.check_graph(s.db(), p, args.graph ?? null);
  const enabled = typeof args.enabled === "boolean" ? args.enabled : true;
  const input = workflow_input(s, ctx, "create", p, workflow_view(s, "", name, enabled, graph));
  input.apply = { name, enabled, graph };
  input.reason = args.reason ?? null;
  return input;
}

/**
 * What `update_workflow` asks the user to approve (`{ask: input}`), or the change to make without asking (`{apply}`):
 * turning it off, or renaming it. Only what differs is changed.
 */
export function workflow_update(s: Shared, ctx: Ctx, w: wf.Workflow, p: db.Project, args: any): { ask: any } | { apply: Record<string, any> } {
  const apply: Record<string, any> = {};
  const name = args.name == null ? w.name : wf.check_name(args.name);
  if (name !== w.name) apply.name = name;
  const graph = args.graph == null ? w.graph : wf.check_graph(s.db(), p, args.graph);
  if (!json_eq(graph, w.graph)) apply.graph = graph;
  let enabled: boolean;
  if (args.enabled == null) enabled = w.enabled;
  else if (typeof args.enabled === "boolean") enabled = args.enabled;
  else throw ToolError.other("enabled must be true or false");
  if (enabled !== w.enabled) apply.enabled = enabled;
  const keys = Object.keys(apply);
  if (!keys.length) throw ToolError.other("nothing to change");
  // Turning it off, or renaming it, doesn't make it do anything it didn't.
  if (keys.every((k) => k === "name" || k === "enabled") && (!enabled || w.enabled)) return { apply };
  const input = workflow_input(s, ctx, "update", p, workflow_view(s, w.id, name, enabled, graph));
  input.before = workflow_view(s, w.id, w.name, w.enabled, w.graph);
  // serde_json's map, sorted by key.
  input.changes = [...keys].sort();
  input.apply = apply;
  input.reason = args.reason ?? null;
  return { ask: input };
}

export function workflow_deletion(s: Shared, ctx: Ctx, w: wf.Workflow, p: db.Project, reason: string | null): any {
  const input = workflow_input(s, ctx, "delete", p, workflow_view(s, w.id, w.name, w.enabled, w.graph));
  input.reason = reason;
  return input;
}

/** Asks the user to approve the workflow change `input` describes, then makes it, exactly as they saw it. */
export async function change_workflow(s: Shared, ctx: Ctx, input: any): Promise<any> {
  const op: string = typeof input?.op === "string" ? input.op : "";
  const tool = `${op}_workflow`;
  const id: string = typeof input?.workflow?.id === "string" ? input.workflow.id : "";
  let approved: any;
  try {
    approved = await ask_user(s, ctx, tool, input);
  } catch (e) {
    // Deleted while the user was asked.
    if (op !== "create" && !wf.get(s.db(), id)) {
      const name = typeof input?.workflow?.name === "string" ? input.workflow.name : id;
      throw ToolError.other(`the workflow "${name}" was deleted meanwhile, so nothing was changed`);
    }
    throw e;
  }
  const apply: Record<string, any> = approved?.apply && typeof approved.apply === "object" && !Array.isArray(approved.apply) ? { ...approved.apply } : {};
  let w: wf.Workflow;
  if (op === "create") w = wf.create(s, typeof approved?.project?.id === "string" ? approved.project.id : "", apply);
  else if (op === "update") w = wf.update(s, id, apply);
  else {
    const gone = wf.delete(s, id);
    return { deleted: true, id: gone.id, name: gone.name };
  }
  return workflow_json(w);
}

/** `run_workflow`: runs it on a task of its project now, and returns the run as it is once its first steps started. */
export async function run_workflow(s: Shared, ctx: Ctx, args: any, profile: string | null, own_project: string | null): Promise<any> {
  const [w, p] = resolve_workflow(s, ctx, args, profile, own_project);
  const r = typeof args.task_id === "string" ? args.task_id.trim() : "";
  let t: db.Task;
  try {
    t = resolve_task(s, ctx, r, profile);
  } catch (e) {
    const err = te(e);
    throw err.kind === "NotFound" ? ToolError.other(`task ${r} not found in ${p.key}`) : err;
  }
  if (t.project_id !== p.id) throw ToolError.other(`task ${r} isn't in ${p.key}, the workflow's project`);
  const run = await wf.start(s, w.id, t.id, true);
  if (!run) throw ToolError.other("the workflow didn't run");
  return wf.run_json(s.db(), run);
}

/** A task's latest workflow runs, briefly, for get_task: each step's state and output. */
export function task_workflows(s: Shared, task_id: string): any[] {
  const c = s.db();
  let runs: wf.Run[] = [];
  try {
    runs = wf.latest_runs(c, task_id);
  } catch {}
  return runs.map((r) => {
    const steps = r.graph.nodes
      .filter((n) => n.kind === "agent")
      .map((n) => {
        const nr = wf.run_node(r, n.id);
        return { name: wf.node_name(n), state: nr.state, port: nr.port ?? null, text: nr.text ?? null, issues: nr.issues ?? [] };
      });
    let workflow: string | null = null;
    try {
      workflow = wf.get(c, r.workflow_id)?.name ?? null;
    } catch {}
    return { workflow, state: r.state, started_at: r.created_at, steps };
  });
}
