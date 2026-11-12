import { Context, Effect, Layer, Option, Result, Schema } from "effect"
import { AgentConfigId, Invalid, ProjectId, WorkflowGraph } from "@huntaway/contracts"
import type { Conflict, NotFound, Project, Workflow } from "@huntaway/contracts"
import { NotApproved, sameJson } from "../permissions/Approvals.ts"
import { Permissions } from "../permissions/Permissions.ts"
import type { Asker } from "../permissions/Permissions.ts"
import { Identity } from "../platform/Identity.ts"
import { AgentConfigRepo } from "../profiles/AgentConfigRepo.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { checkName } from "./check.ts"
import { Workflows } from "./Workflows.ts"

// An agent's changes to a project's workflows (inventory 06, 7; huntaway's mcp/tools/workflows.ts and approvals.ts
// `ask_user`): making one, changing what it does or turning it on, and deleting one ask the user first, as automations
// do (a workflow starts agents on the project's tasks and sends them messages); turning one off or renaming it doesn't.
// What the user approved is exactly what's applied. A call that was asking when the server stopped carries on with the
// input it asked about. The approval is a permission request of kind `automation` whose input has `workflow`.

/** What `create_workflow` asks for. */
export interface CreateRequest {
  readonly project: Project
  readonly name: string
  readonly graph: WorkflowGraph
  readonly enabled: boolean
  readonly reason: string | null
}

/** What `update_workflow` asks for: what's given, the rest as it is. */
export interface UpdateRequest {
  readonly workflow: Workflow
  readonly project: Project
  readonly name: string | null
  readonly graph: WorkflowGraph | null
  readonly enabled: boolean | null
  readonly reason: string | null
}

/** What `delete_workflow` asks for. */
export interface DeleteRequest {
  readonly workflow: Workflow
  readonly project: Project
  readonly reason: string | null
}

/** What `delete_workflow` did. */
export interface Deleted {
  readonly deleted: true
  readonly id: string
  readonly name: string
}

type Errors = NotApproved | Invalid | Conflict | NotFound

export interface WorkflowApprovalsShape {
  readonly create: <E>(asker: Asker, request: Effect.Effect<CreateRequest, E>) => Effect.Effect<Workflow, E | Errors>
  readonly update: <E>(asker: Asker, request: Effect.Effect<UpdateRequest, E>) => Effect.Effect<Workflow, E | Errors>
  readonly delete: <E>(asker: Asker, request: Effect.Effect<DeleteRequest, E>) => Effect.Effect<Deleted, E | Errors>
}

/** What an approved change reads back. */
const Saved = Schema.Struct({
  op: Schema.Literals(["create", "update", "delete"]),
  project: Schema.Struct({ id: ProjectId }),
  workflow: Schema.Struct({ id: Schema.String, name: Schema.String }),
  apply: Schema.optional(
    Schema.Struct({ name: Schema.optional(Schema.String), graph: Schema.optional(WorkflowGraph), enabled: Schema.optional(Schema.Boolean) }),
  ),
})
const read = (input: unknown) =>
  Effect.fromOption(Schema.decodeUnknownOption(Saved)(input)).pipe(
    Effect.mapError(() => new Invalid({ field: "input", reason: "the approved change doesn't read: call it again" })),
  )

const VERB = { create: "creating", update: "changing", delete: "deleting" } as const
const NOTHING = { create: "created", update: "changed", delete: "changed" } as const

export class WorkflowApprovals extends Context.Service<WorkflowApprovals, WorkflowApprovalsShape>()("huntaway-server/workflows/WorkflowApprovals") {
  static readonly layer = Layer.effect(
    WorkflowApprovals,
    Effect.gen(function* () {
      const permissions = yield* Permissions
      const workflows = yield* Workflows
      const configs = yield* AgentConfigRepo
      const tasks = yield* TaskRepo
      const { hostName } = yield* Identity

      const projectRef = (p: Pick<Project, "id" | "key" | "name">) => ({ id: p.id, key: p.key, name: p.name, host: hostName })
      const askedBy = Effect.fnUntraced(function* (asker: Asker) {
        const t = yield* tasks.get(asker.run.task_id)
        if (t === null) return null
        return t.kind === "task" ? { id: t.id, key: t.key, title: t.title } : { id: t.id, title: t.title }
      })

      /** A workflow as its approval shows it: what it is, with its agent steps' configs by name. */
      const view = Effect.fnUntraced(function* (id: string, name: string, enabled: boolean, graph: WorkflowGraph) {
        const found: Array<{ readonly node: string; readonly id: string; readonly name: string; readonly agent: string }> = []
        for (const n of graph.nodes) {
          if (n.kind !== "agent" || n.claude_config_id === undefined) continue
          const c = yield* configs.get(AgentConfigId.make(n.claude_config_id))
          if (Option.isSome(c)) found.push({ node: n.id, id: c.value.id, name: c.value.name, agent: c.value.agent })
        }
        return { id, name, enabled, graph, configs: found }
      })

      /** Asks the user to approve `input` for `op` in the asker's thread and waits: the input they approved. */
      const ask = Effect.fnUntraced(function* (asker: Asker, op: "create" | "update" | "delete", input: unknown, name: string) {
        const answer = yield* permissions.approve(asker, "automation", `${op}_workflow`, input)
        if (Result.isSuccess(answer)) return answer.success
        // Deleted while the user was asked (which took the question with it). `delete` says so itself.
        if (op === "update") {
          const asked = yield* Effect.option(read(input))
          if (Option.isSome(asked) && Result.isFailure(yield* Effect.result(workflows.get(asked.value.workflow.id)))) {
            return yield* new NotApproved({ message: `the workflow "${name}" was deleted meanwhile, so nothing was changed` })
          }
        }
        return yield* new NotApproved({
          message: `The user didn't approve ${VERB[op]} the workflow "${name}", so nothing was ${NOTHING[op]}: ${answer.failure}`,
        })
      })
      /** A retried call goes on with the approval it asked for. */
      const again = Effect.fnUntraced(function* (asker: Asker, op: "create" | "update", input: unknown) {
        const s = yield* read(input)
        return yield* apply(yield* ask(asker, op, input, s.workflow.name))
      })

      /** Makes what an approved input says. */
      const apply = Effect.fnUntraced(function* (input: unknown) {
        const saved = yield* read(input)
        const a = saved.apply ?? {}
        if (saved.op === "create") {
          return yield* workflows.create({ project_id: saved.project.id, name: a.name ?? "", graph: a.graph ?? { nodes: [], edges: [] }, enabled: a.enabled })
        }
        return yield* workflows.update(saved.workflow.id, a)
      })

      /** A retried call's saved input, if it asked before. */
      const saved = (asker: Asker) => Effect.map(permissions.asked(asker.call_id), Option.getOrNull)

      const create = Effect.fn("WorkflowApprovals.create")(function* <E>(asker: Asker, request: Effect.Effect<CreateRequest, E>) {
        const before = yield* saved(asker)
        if (before !== null) return yield* again(asker, "create", before)
        const r = yield* request
        const checked = yield* workflows.check(r.project, r.name, r.graph)
        const input = {
          op: "create",
          project: projectRef(r.project),
          task: yield* askedBy(asker),
          workflow: yield* view("", checked.name, r.enabled, checked.graph),
          before: null,
          changes: null,
          apply: { name: checked.name, enabled: r.enabled, graph: checked.graph },
          reason: r.reason,
        }
        return yield* apply(yield* ask(asker, "create", input, checked.name))
      })

      const update = Effect.fn("WorkflowApprovals.update")(function* <E>(asker: Asker, request: Effect.Effect<UpdateRequest, E>) {
        const before = yield* saved(asker)
        if (before !== null) return yield* again(asker, "update", before)
        const r = yield* request
        const w = r.workflow
        const changes: Record<string, unknown> = {}
        let name = w.name
        if (r.name !== null) {
          const n = checkName(r.name)
          if (Result.isFailure(n)) return yield* new Invalid({ field: "name", reason: n.failure })
          name = n.success
        }
        if (name !== w.name) changes["name"] = name
        const graph = r.graph === null ? w.graph : (yield* workflows.check(r.project, name, r.graph)).graph
        if (!sameJson(graph, w.graph)) changes["graph"] = graph
        const enabled = r.enabled ?? w.enabled
        if (enabled !== w.enabled) changes["enabled"] = enabled
        const keys = Object.keys(changes).toSorted()
        if (keys.length === 0) return yield* new Invalid({ field: "workflow", reason: "nothing to change" })
        // Turning it off, or renaming it, doesn't make it do anything it didn't.
        if (keys.every((k) => k === "name" || k === "enabled") && (!enabled || w.enabled)) return yield* workflows.update(w.id, changes)
        const input = {
          op: "update",
          project: projectRef(r.project),
          task: yield* askedBy(asker),
          workflow: yield* view(w.id, name, enabled, graph),
          before: yield* view(w.id, w.name, w.enabled, w.graph),
          changes: keys,
          apply: changes,
          reason: r.reason,
        }
        return yield* apply(yield* ask(asker, "update", input, name))
      })

      const remove = Effect.fn("WorkflowApprovals.delete")(function* <E>(asker: Asker, request: Effect.Effect<DeleteRequest, E>) {
        let input: unknown = yield* saved(asker)
        if (input === null) {
          const r = yield* request
          input = {
            op: "delete",
            project: projectRef(r.project),
            task: yield* askedBy(asker),
            workflow: yield* view(r.workflow.id, r.workflow.name, r.workflow.enabled, r.workflow.graph),
            before: null,
            changes: null,
            reason: r.reason,
          }
        }
        const target = yield* read(input)
        const asked = yield* Effect.result(ask(asker, "delete", input, target.workflow.name))
        if (Result.isFailure(asked)) {
          // Deleted while the user was asked.
          const gone = yield* Effect.result(workflows.get(target.workflow.id))
          if (Result.isFailure(gone)) {
            return yield* new NotApproved({ message: `the workflow "${target.workflow.name}" was deleted meanwhile, so nothing was changed` })
          }
          return yield* asked.failure
        }
        const w = yield* workflows.delete(target.workflow.id)
        const out: Deleted = { deleted: true, id: w.id, name: w.name }
        return out
      })

      return WorkflowApprovals.of({ create, update, delete: remove })
    }),
  )
}
