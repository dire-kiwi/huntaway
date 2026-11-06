// Port of server/src/integrations/workflows/handlers.rs (HA-173's branch, ported by HA-189).
// The API: workflows' and runs' JSON, and their routes' handlers.
import * as db from "../../db.ts";
import type { Conn } from "../../db.ts";
import { ApiError, type Req } from "../../http.ts";
import type { Shared } from "../../state.ts";
import { create, get, get_run, latest_runs, list, update, delete_, type Run, type Workflow } from "../workflows.ts";
import { start, stop_run } from "./engine.ts";

export function to_json(w: Workflow): any {
  return {
    id: w.id,
    project_id: w.project_id,
    name: w.name,
    enabled: w.enabled,
    graph: w.graph,
    created_at: w.created_at,
    updated_at: w.updated_at,
  };
}

/** A run, with its workflow's name (or null, once the workflow is deleted). */
export function run_json(c: Conn, r: Run): any {
  let name: string | null = null;
  try {
    name = get(c, r.workflow_id)?.name ?? null;
  } catch {}
  return { ...r, workflow_name: name };
}

function workflow(c: Conn, id: string): Workflow {
  const w = get(c, id);
  if (!w) throw ApiError.not_found("workflow");
  return w;
}

/** `GET /projects/{id}/workflows`. */
export async function list_handler(s: Shared, r: Req): Promise<any> {
  const c = s.db();
  if (!db.get_project(c, r.params.id)) throw ApiError.not_found("project");
  return { workflows: list(c, r.params.id).map(to_json) };
}

/** `POST /projects/{id}/workflows`: `{name, graph, enabled?}`. */
export async function create_handler(s: Shared, r: Req): Promise<any> {
  return to_json(create(s, r.params.id, r.body ?? {}));
}

export async function get_handler(s: Shared, r: Req): Promise<any> {
  return to_json(workflow(s.db(), r.params.id));
}

/** `PATCH /workflows/{id}`: any of `{name, graph, enabled}`. */
export async function update_handler(s: Shared, r: Req): Promise<any> {
  return to_json(update(s, r.params.id, r.body ?? {}));
}

export async function delete_handler(s: Shared, r: Req): Promise<any> {
  delete_(s, r.params.id);
  return { deleted: true };
}

/** `POST /workflows/{id}/run`: `{task_id}`, whether or not the workflow is on or its trigger matches. */
export async function run_handler(s: Shared, r: Req): Promise<any> {
  const task = r.body?.task_id;
  if (typeof task !== "string") throw ApiError.bad("task_id is needed");
  const run = await start(s, r.params.id, task, true);
  if (!run) throw ApiError.conflict("the workflow didn't run");
  return run_json(s.db(), run);
}

/**
 * `GET /tasks/{id}/workflow-runs`: the latest run of each workflow on the task (with the earlier ones its tabs show,
 * see `latest_runs`), and the project's workflows (to run one by hand).
 */
export async function task_runs_handler(s: Shared, r: Req): Promise<any> {
  const c = s.db();
  const task = db.get_task(c, r.params.id);
  if (!task) throw ApiError.not_found("task");
  const runs = latest_runs(c, task.id, true).map((x) => run_json(c, x));
  const workflows = task.project_id && task.kind === "task" ? list(c, task.project_id).map((w) => ({ id: w.id, name: w.name, enabled: w.enabled })) : [];
  return { runs, workflows };
}

/** `POST /workflow-runs/{id}/stop`. */
export async function stop_run_handler(s: Shared, r: Req): Promise<any> {
  if (!get_run(s.db(), r.params.id)) throw ApiError.not_found("workflow run");
  return { stopped: stop_run(s, r.params.id, "Stopped by the user.") };
}
