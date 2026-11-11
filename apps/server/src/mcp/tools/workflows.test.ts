import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Result } from "effect"
import type { Approval, RequestId } from "@huntaway/contracts"
import { TestMcp } from "@huntaway/testing"
import type { FakeAgent } from "@huntaway/testing"
import { Permissions } from "../../permissions/Permissions.ts"
import { TaskRepo } from "../../tasks/TaskRepo.ts"
import { readGraph } from "../../workflows/read.ts"
import { Workflows } from "../../workflows/Workflows.ts"
import { agentOn, at, call, err, grant, ok, profile, project, str, task } from "./tests/board.ts"

// The workflow tools (the old mcp/tools/workflows.test.ts): an agent lists, creates, changes, runs and deletes a
// project's workflows, the changes that make one do something asked of the user first (an approval of kind `automation`
// whose input has `workflow`), and only on the boards it can use.
//
// Dropped, with why:
// - that the approval isn't shown to UIs from before workflows: there are none (its kind as listed is `workflow`, below);
// - "older hosts aren't sent workflow calls" (`too_old`): linked hosts are M7's.

const MOVE_GRAPH = {
  nodes: [
    { id: "t", kind: "trigger", on: "manual" },
    { id: "m", kind: "set_status", status: "backlog" },
  ],
  edges: [{ from: "t", port: "out", to: "m" }],
}

/** The approval call `id` is waiting on, as the board lists it, once it is being waited on. */
const asked = (id: string) =>
  Effect.gen(function* () {
    const permissions = yield* Permissions
    const request = yield* permissions.asking(id)
    const found = (yield* permissions.approvals).find((a) => a.request_id === request)
    return found === undefined ? assert.fail(`no approval ${request}`) : found
  })

const answer = (request: RequestId, allow: boolean) =>
  Effect.flatMap(Permissions, (p) => p.answer(request, { decision: allow ? "allow" : "deny" }, "user")).pipe(Effect.orDie)

/** Call `id` of `agent`, answered `allow` by the user once it asks: what it gave, and what it asked. */
const answered = (agent: FakeAgent, tool: string, args: unknown, id: string, allow: boolean) =>
  Effect.gen(function* () {
    const running = yield* Effect.forkChild(call(agent, tool, args, id))
    const approval = yield* asked(id)
    yield* answer(approval.request_id, allow)
    return { result: yield* Fiber.join(running), approval }
  })

const input = (a: Approval): unknown => a.input

const pendingApprovals = Effect.map(
  Effect.flatMap(Permissions, (p) => p.approvals),
  (all) => all.filter((a) => a.status === "pending").length,
)

const graphOf = (g: unknown) => {
  const read = readGraph(g)
  return Result.isSuccess(read) ? Effect.succeed(read.success) : Effect.die(read.failure)
}

describe("workflow tools", () => {
  it.effect("agents create, change, run and delete workflows once the user approves", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const kiw = yield* project(p, "kiwicd", "KIW")
      const caller = yield* task(kiw, "Caller")
      const me = yield* agentOn(caller)
      const workflows = yield* Workflows
      const own = Effect.map(workflows.list(kiw.id), (all) => all.length)
      const args = { name: "Park", graph: MOVE_GRAPH, reason: "Park tasks" }

      // Denied: nothing is made. The approval (an `automation` request whose input has `workflow`, which the board lists
      // as a workflow's) shows the workflow.
      let { result, approval } = yield* answered(me, "create_workflow", args, "c1", false)
      assert.include(err(result), `didn't approve creating the workflow "Park", so nothing was created`)
      assert.strictEqual(yield* own, 0)
      const shown = input(approval)
      assert.deepStrictEqual([approval.kind, approval.tool_name, at(shown, "op"), at(shown, "reason")], ["workflow", "create_workflow", "create", "Park tasks"])
      const nodes = at(shown, "workflow", "graph", "nodes")
      assert.deepStrictEqual([at(shown, "workflow", "name"), Array.isArray(nodes) ? nodes.length : null], ["Park", 2])
      assert.strictEqual((yield* (yield* TaskRepo).get(caller.id))?.attention_reason, "Approve a workflow?")
      // A graph that doesn't check out isn't asked about.
      const bad = { nodes: MOVE_GRAPH.nodes, edges: [...MOVE_GRAPH.edges, { from: "t", port: "nope", to: "m" }] }
      assert.include(err(yield* call(me, "create_workflow", { name: "Bad", graph: bad }, "c2")), "has no port nope")
      assert.strictEqual(yield* pendingApprovals, 0)
      // Approved: it's made as it was shown.
      ;({ result } = yield* answered(me, "create_workflow", args, "c3", true))
      const made = ok(result)
      assert.deepStrictEqual([made["name"], made["enabled"], yield* own], ["Park", true, 1])
      const listed = ok(yield* call(me, "list_workflows", {}, "c4"))
      const first = Array.isArray(listed["workflows"]) ? listed["workflows"][0] : null
      assert.deepStrictEqual([at(listed, "project", "key"), at(first, "id")], ["KIW", made["id"]])
      const id = str(made, "id")

      // Turning it off or renaming it isn't asked about; turning it on is.
      const off = ok(yield* call(me, "update_workflow", { workflow_id: "park", enabled: false, name: "Parking" }, "c5"))
      assert.deepStrictEqual([off["enabled"], off["name"]], [false, "Parking"])
      assert.strictEqual(yield* pendingApprovals, 0)
      assert.include(err(yield* call(me, "update_workflow", { workflow_id: id, enabled: false }, "c6")), "nothing to change")
      ;({ result, approval } = yield* answered(me, "update_workflow", { workflow_id: id, enabled: true }, "c7", false))
      assert.include(err(result), `didn't approve changing the workflow "Parking"`)
      assert.deepStrictEqual(at(input(approval), "changes"), ["enabled"])
      assert.isFalse((yield* workflows.get(id)).enabled)

      // Run by hand on a task of its project, on or off.
      const target = yield* task(kiw, "Target")
      const run = ok(yield* call(me, "run_workflow", { workflow_id: "Parking", task_id: target.key }, "c8"))
      assert.deepStrictEqual([run["state"], run["workflow_name"], run["source"]], ["done", "Parking", "manual"])
      assert.strictEqual((yield* (yield* TaskRepo).get(target.id))?.status, "backlog")
      // get_task shows the task's latest runs.
      const details = ok(yield* call(me, "get_task", { task_id: target.key }, "c9"))
      assert.deepStrictEqual(details["workflows"], [{ workflow: "Parking", state: "done", started_at: run["created_at"], steps: [] }])

      // Deleted by the user while an agent asks to change it: the question goes, and the call says so.
      const change = yield* Effect.forkChild(call(me, "update_workflow", { workflow_id: id, graph: { nodes: [MOVE_GRAPH.nodes[0]], edges: [] } }, "c10"))
      yield* asked("c10")
      yield* workflows.delete(id)
      assert.include(err(yield* Fiber.join(change)), "was deleted meanwhile")
      assert.strictEqual(yield* pendingApprovals, 0)

      // Deleting one is asked about too.
      const again = yield* workflows.create({ project_id: kiw.id, name: "Park", graph: yield* graphOf(MOVE_GRAPH) })
      ;({ result, approval } = yield* answered(me, "delete_workflow", { workflow_id: again.id, reason: "Not needed" }, "c11", true))
      assert.strictEqual(ok(result)["deleted"], true)
      assert.deepStrictEqual([at(input(approval), "op"), at(input(approval), "reason")], ["delete", "Not needed"])
      assert.strictEqual(yield* own, 0)
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("agents only reach workflows on boards they can use", () =>
    Effect.gen(function* () {
      const mine = yield* profile("personal")
      const work = yield* profile("work")
      const kiw = yield* project(mine, "kiwicd", "KIW")
      const sec = yield* project(work, "secret", "SEC")
      const workflows = yield* Workflows
      const graph = yield* graphOf(MOVE_GRAPH)
      const theirs = yield* workflows.create({ project_id: sec.id, name: "Park", graph })
      const hidden = yield* task(sec, "Hidden")
      const me = yield* agentOn(yield* task(kiw, "Caller"))
      // Each is told what it names isn't found.
      const notFound = (tool: string, args: unknown, what: string) =>
        Effect.gen(function* () {
          assert.strictEqual(err(yield* call(me, tool, args)), what, tool)
        })
      yield* notFound("list_workflows", { project_id: "SEC" }, "project SEC")
      yield* notFound("create_workflow", { project_id: "SEC", name: "x", graph: MOVE_GRAPH }, "project SEC")
      yield* notFound("update_workflow", { workflow_id: theirs.id, enabled: false }, `workflow ${theirs.id}`)
      yield* notFound("delete_workflow", { workflow_id: theirs.id }, `workflow ${theirs.id}`)
      yield* notFound("run_workflow", { workflow_id: theirs.id, task_id: hidden.id }, `workflow ${theirs.id}`)
      assert.isTrue((yield* workflows.get(theirs.id)).enabled)
      assert.strictEqual((yield* (yield* TaskRepo).get(hidden.id))?.status, "todo")
      // A workflow of this board's doesn't run on another project's task.
      const ours = yield* workflows.create({ project_id: kiw.id, name: "Mine", graph })
      yield* grant(work, ["personal"])
      assert.include(err(yield* call(me, "run_workflow", { workflow_id: ours.id, task_id: hidden.id })), "isn't in KIW")
    }).pipe(Effect.provide(TestMcp())),
  )
})
