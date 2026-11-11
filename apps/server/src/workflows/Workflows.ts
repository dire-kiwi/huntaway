import { Context, Effect, Layer, Option, Result } from "effect"
import { SecureRandom } from "effect/crypto"
import { Conflict, Invalid, NotFound, WorkflowId } from "@huntaway/contracts"
import type { Project, ProjectId, Workflow, WorkflowGraph, WorkflowPatch } from "@huntaway/contracts"
import { nowTimestamp } from "../platform/columns.ts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { Permissions } from "../permissions/Permissions.ts"
import { ProfileRepo } from "../profiles/ProfileRepo.ts"
import { ProjectRepo } from "../projects/ProjectRepo.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { checkGraph, checkName } from "./check.ts"
import { agentWorks, columnNode, statusLabel } from "./graph.ts"
import { hasReviewStep, reviewSettingsGraph } from "./reviewSettings.ts"
import { WorkflowEngine } from "./WorkflowEngine.ts"
import { WorkflowStore } from "./WorkflowStore.ts"

// Changing a project's workflows (inventory 06, 2.1; huntaway's integrations/workflows/change.ts and store.ts
// `move_review_settings`): making one (checked against the project), changing and deleting it, and the Review tab's
// automatic reviews moved into one when a project starts using workflows.

/** What a new workflow is. */
export interface NewWorkflowInput {
  readonly project_id: ProjectId
  readonly name: string
  readonly graph: WorkflowGraph
  readonly enabled?: boolean | undefined
}

export interface WorkflowsShape {
  readonly list: (project: ProjectId) => Effect.Effect<ReadonlyArray<Workflow>, NotFound>
  readonly get: (id: string) => Effect.Effect<Workflow, NotFound>
  /** The name and graph as they would be kept, checked against the project (`Invalid` says why not). */
  readonly check: (project: Project, name: string, graph: WorkflowGraph) => Effect.Effect<{ readonly name: string; readonly graph: WorkflowGraph }, Invalid>
  /** A new workflow, on unless `enabled` is false. A column where the agent works belongs to one workflow that's on. */
  readonly create: (input: NewWorkflowInput) => Effect.Effect<Workflow, NotFound | Invalid | Conflict>
  /** Changes any of its name, graph and whether it's on. Turned off, its runs waiting for a column's work stop. */
  readonly update: (id: string, patch: WorkflowPatch) => Effect.Effect<Workflow, NotFound | Invalid | Conflict>
  /** Deletes it, stopping its runs in progress; their threads stay with their tasks. The workflow as it was. */
  readonly delete: (id: string) => Effect.Effect<Workflow, NotFound>
  /**
   * A project's Review tab's automatic reviews, rounds of fixes and summaries moved into a workflow of their own, which
   * is on, now that its workflows take its tasks across the board: unless they're off, or one of its workflows that's
   * on has an In review step already. The workflow made, or null.
   */
  readonly moveReviewSettings: (project: Project) => Effect.Effect<Workflow | null>
}

export class Workflows extends Context.Service<Workflows, WorkflowsShape>()("huntaway-server/workflows/Workflows") {
  static readonly layer = Layer.effect(
    Workflows,
    Effect.gen(function* () {
      const db = yield* Db
      const store = yield* WorkflowStore
      const events = yield* Events
      const projects = yield* ProjectRepo
      const profiles = yield* ProfileRepo
      const taskRepo = yield* TaskRepo
      const engine = yield* WorkflowEngine
      const permissions = yield* Permissions
      const random = yield* SecureRandom.SecureRandom

      const projectOf = Effect.fnUntraced(function* (id: ProjectId) {
        const p = yield* projects.get(id)
        if (Option.isNone(p)) return yield* new NotFound({ what: "project", id })
        return p.value
      })

      const load = Effect.fnUntraced(function* (id: string) {
        const w = yield* store.get(id)
        if (w === null) return yield* new NotFound({ what: "workflow", id })
        return w
      })

      const check = Effect.fn("Workflows.check")(function* (p: Project, name: string, graph: WorkflowGraph) {
        const n = checkName(name)
        if (Result.isFailure(n)) return yield* new Invalid({ field: "name", reason: n.failure })
        const ref = yield* taskRepo.project(p.id)
        const configs = yield* taskRepo.configs(p.profile_id, ref)
        const g = checkGraph(graph, configs)
        if (Result.isFailure(g)) return yield* new Invalid({ field: "graph", reason: g.failure })
        return { name: n.success, graph: g.success }
      })

      /**
       * Refused when another workflow of the project that's on (but `except`) has a node for a column where `graph` or it
       * waits for the agent's work: the agent is sent one column's prompt, and its work goes on from one node.
       */
      const checkColumns = Effect.fnUntraced(function* (project: ProjectId, except: string | null, graph: WorkflowGraph) {
        for (const w of yield* store.list(project)) {
          if (w.id === except || !w.enabled) continue
          for (const n of graph.nodes) {
            if (n.kind !== "column") continue
            const other = columnNode(w.graph, n.status)
            if (other !== undefined && (agentWorks(n, graph) || agentWorks(other, w.graph))) {
              return yield* new Conflict({
                reason: "in_use",
                detail: `the workflow "${w.name}" has the column ${statusLabel(n.status)} already, where the task's agent works: a column with the agent's work belongs to one workflow that's on`,
              })
            }
          }
        }
        return true
      })

      const changed = (project: ProjectId, id: WorkflowId) => events.emit({ type: "workflows_changed", project_id: project, workflow_id: id })

      const create = Effect.fn("Workflows.create")(function* (input: NewWorkflowInput) {
        const p = yield* projectOf(input.project_id)
        const { name, graph } = yield* check(p, input.name, input.graph)
        const enabled = input.enabled ?? true
        const at = yield* nowTimestamp
        const w: Workflow = { id: WorkflowId.make(yield* random.uuidV4()), project_id: p.id, name, enabled, graph, created_at: at, updated_at: at }
        yield* db.tx(
          Effect.gen(function* () {
            if (enabled) yield* checkColumns(p.id, null, graph)
            yield* store.insert(w)
            yield* changed(p.id, w.id)
          }),
        )
        return w
      })

      const update = Effect.fn("Workflows.update")(function* (id: string, patch: WorkflowPatch) {
        const before = yield* load(id)
        const p = yield* projectOf(before.project_id)
        const checked = yield* check(p, patch.name ?? before.name, patch.graph ?? before.graph)
        const name = patch.name === undefined ? before.name : checked.name
        const graph = patch.graph === undefined ? before.graph : checked.graph
        const enabled = patch.enabled ?? before.enabled
        const after: Workflow = { ...before, name, graph, enabled, updated_at: yield* nowTimestamp }
        yield* db.tx(
          Effect.gen(function* () {
            if (enabled && (patch.graph !== undefined || !before.enabled)) yield* checkColumns(p.id, before.id, graph)
            yield* store.update(before.id, after)
            yield* changed(p.id, before.id)
          }),
        )
        // Turned off, it no longer waits for its columns' work.
        if (!enabled && before.enabled) yield* engine.stopWaiting(before.id, "Stopped because the workflow was turned off.")
        return after
      })

      const remove = Effect.fn("Workflows.delete")(function* (id: string) {
        const w = yield* load(id)
        const tasks = yield* engine.stopWorkflow(w.id, "Stopped because the workflow was deleted.")
        yield* db.tx(
          Effect.gen(function* () {
            yield* store.delete(w.id)
            yield* changed(w.project_id, w.id)
            for (const t of tasks) yield* events.emit({ type: "workflow_runs_changed", task_id: t })
          }),
        )
        // Requests to change it that are still asked: what they'd change is gone.
        yield* permissions.expireFor({ _tag: "Workflow", workflow: w.id })
        return w
      })

      const moveReviewSettings = Effect.fn("Workflows.moveReviewSettings")(function* (p: Project) {
        const profile = Option.getOrNull(yield* profiles.get(p.profile_id))
        const configs = yield* taskRepo.configs(p.profile_id, yield* taskRepo.project(p.id))
        const graph = reviewSettingsGraph(p, profile, configs)
        if (graph === null || hasReviewStep(yield* store.list(p.id))) return null
        const made = yield* Effect.result(create({ project_id: p.id, name: p.auto_summary ? "Review and summarise" : "Review", graph, enabled: true }))
        if (Result.isFailure(made)) {
          yield* Effect.logWarning(`project ${p.id}: moving the Review tab's reviews into a workflow: ${made.failure._tag}`)
          return null
        }
        yield* Effect.logInfo(`project ${p.key}: moved the Review tab's reviews into the workflow "${made.success.name}"`)
        return made.success
      })

      return Workflows.of({
        list: Effect.fn("Workflows.list")(function* (project) {
          yield* projectOf(project)
          return yield* store.list(project)
        }),
        get: Effect.fn("Workflows.get")(function* (id) {
          return yield* load(id)
        }),
        check,
        create,
        update,
        delete: remove,
        moveReviewSettings,
      })
    }),
  )
}
