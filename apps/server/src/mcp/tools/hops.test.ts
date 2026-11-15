import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { SecureRandom } from "effect/crypto"
import { CallId } from "@huntaway/contracts"
import type { TaskId } from "@huntaway/contracts"
import { fakeAgent, TestMcp, TestMcpOver } from "@huntaway/testing"
import { nowTimestamp } from "../../platform/columns.ts"
import type { Run } from "../../runs/Run.ts"
import { RunInput } from "../../runs/RunInput.ts"
import { RunRepo } from "../../runs/RunRepo.ts"
import { Runs } from "../../runs/Runs.ts"
import { TaskRepo } from "../../tasks/TaskRepo.ts"
import { ToolCalls } from "../ToolCalls.ts"
import { MAX_HOPS } from "./common.ts"
import { agentOn, err, idOf, ok, profile, project, task } from "./tests/board.ts"

// Hops between agents (docs/plan/07-agents.md, Hops between agents): the runs here are the ones `Runs` registers for
// each message, so what a message carries is what the next agent's calls are counted from.

/** The task's latest run. */
const latest = (id: TaskId) =>
  Effect.gen(function* () {
    yield* (yield* Runs).launched(id)
    const run = yield* (yield* RunRepo).latest(id)
    return Option.isSome(run) ? run.value : assert.fail("no run")
  })

/** The one steer of `run`. */
const onlySteer = (id: TaskId, run: Run) =>
  Effect.flatMap(TaskRepo, (repo) => repo.steers(id, run.id)).pipe(
    Effect.map((rows) => (rows.length === 1 && rows[0] !== undefined ? rows[0] : assert.fail(`${rows.length} steers`))),
  )

/** A board call made by run `run`'s agent. */
const callAs = (run: Run, tool: string, args: unknown) =>
  Effect.gen(function* () {
    const id = CallId.make(yield* (yield* SecureRandom.SecureRandom).uuidV4())
    return yield* (yield* ToolCalls).call({ call_id: id, run: run.id, server: "huntaway", tool, args })
  })

/** `run`'s agent sends `to` a message, and its run is over: the task's next message starts another. */
const sendAndEnd = (run: Run, to: string) =>
  Effect.gen(function* () {
    const sent = yield* callAs(run, "send_to_task", { task_id: to, message: `from ${run.task_id}` })
    yield* (yield* RunRepo).end(run.id, yield* nowTimestamp)
    return sent
  })

/** Two tasks, A (KIW-1) and B (KIW-2), and an agent on A that the user started. */
const twoTasks = Effect.gen(function* () {
  const p = yield* profile("personal")
  const kiw = yield* project(p, "kiwicd", "KIW")
  const a = yield* task(kiw, "A")
  const b = yield* task(kiw, "B")
  const first = yield* agentOn(a)
  return { a, b, first: first.run }
})

describe("hops between agents", () => {
  it.effect("a chain A→B→A→B goes, and the next message is refused", () =>
    Effect.gen(function* () {
      const { a, b, first } = yield* twoTasks
      assert.strictEqual(first.hops, 0)
      ok(yield* sendAndEnd(first, "KIW-2"))
      const b1 = yield* latest(b.id)
      ok(yield* sendAndEnd(b1, "KIW-1"))
      const a2 = yield* latest(a.id)
      ok(yield* sendAndEnd(a2, "KIW-2"))
      const b3 = yield* latest(b.id)
      assert.deepStrictEqual([b1.hops, a2.hops, b3.hops], [1, 2, MAX_HOPS])
      const e = err(yield* callAs(b3, "send_to_task", { task_id: "KIW-1", message: "and back" }))
      assert.isTrue(e.startsWith("The message wasn't sent: agents have been waking one another without the user"), e)
      assert.isTrue(e.includes("report to the user"), e)
      // Nothing started on A.
      assert.strictEqual((yield* latest(a.id)).id, a2.id)
      // Nor do the other ways of waking an agent go past it: a task it makes isn't started.
      const made = ok(yield* callAs(b3, "create_task", { title: "Another" }))
      assert.isTrue(String(made["note"]).startsWith("The task was made, but its agent wasn't started"), String(made["note"]))
      assert.strictEqual(made["running"], false)
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("a task an agent starts counts as a hop", () =>
    Effect.gen(function* () {
      const { first } = yield* twoTasks
      const made = ok(yield* callAs(first, "create_task", { title: "Child" }))
      const child = yield* latest(idOf(made))
      assert.strictEqual(child.hops, 1)
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("the user's message in between starts the count again", () =>
    Effect.gen(function* () {
      const { a, b, first } = yield* twoTasks
      const runs = yield* Runs
      ok(yield* sendAndEnd(first, "KIW-2"))
      ok(yield* sendAndEnd(yield* latest(b.id), "KIW-1"))
      ok(yield* sendAndEnd(yield* latest(a.id), "KIW-2"))
      const b3 = yield* latest(b.id)
      yield* (yield* RunRepo).end(b3.id, yield* nowTimestamp)
      // The user writes to B: its next run is theirs, and B's agent may message A again.
      yield* runs.send(b.id, { text: "Ask A again", source: "user" })
      const b4 = yield* latest(b.id)
      assert.strictEqual(b4.hops, 0)
      ok(yield* sendAndEnd(b4, "KIW-1"))
      assert.strictEqual((yield* latest(a.id)).hops, 1)
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("a message steered into a run counts once its agent takes it in; the user's starts the count again", () =>
    Effect.gen(function* () {
      const { b, first } = yield* twoTasks
      const input = yield* RunInput
      // B's agent is working on what the user asked it.
      const working = yield* agentOn(b)
      ok(yield* callAs(first, "send_to_task", { task_id: "KIW-2", message: "Have a look" }))
      const fromA = yield* onlySteer(b.id, working.run)
      assert.strictEqual(fromA.hops, 1)
      // Until it takes it in, its turn is the user's.
      assert.strictEqual((yield* working.row).hops, 0)
      yield* input.steered(yield* working.row, fromA.id)
      assert.strictEqual((yield* working.row).hops, 1)
      yield* (yield* Runs).send(b.id, { text: "Thanks, carry on", source: "user" })
      const fromUser = yield* onlySteer(b.id, working.run)
      yield* input.steered(yield* working.row, fromUser.id)
      assert.strictEqual((yield* working.row).hops, 0)
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("a restart mid-chain keeps the count: the runs' and the queued message's", () =>
    Effect.gen(function* () {
      const { a, b, first } = yield* twoTasks
      // B's agent works without reading messages as it goes: what A's sends it waits in its queue.
      const busy = yield* fakeAgent({ task: b.id, input: false })
      ok(yield* sendAndEnd(first, "KIW-2"))
      assert.deepStrictEqual(
        (yield* (yield* TaskRepo).queued(b.id)).map((q) => q.hops),
        [1],
      )
      // The board's tools are built again, as after a restart (the count is kept only in the database: the runs' and the
      // queue's rows), and B's run ends: what's queued starts its next.
      yield* Effect.gen(function* () {
        yield* (yield* RunRepo).end(busy.run.id, yield* nowTimestamp)
        yield* (yield* Runs).sendQueued(b.id)
        const b1 = yield* latest(b.id)
        assert.strictEqual(b1.hops, 1)
        ok(yield* sendAndEnd(b1, "KIW-1"))
      }).pipe(Effect.provide(Layer.fresh(TestMcpOver())))
      yield* Effect.gen(function* () {
        const a2 = yield* latest(a.id)
        assert.strictEqual(a2.hops, 2)
        ok(yield* sendAndEnd(a2, "KIW-2"))
        const b3 = yield* latest(b.id)
        assert.strictEqual(b3.hops, MAX_HOPS)
        err(yield* callAs(b3, "send_to_task", { task_id: "KIW-1", message: "and back" }))
      }).pipe(Effect.provide(Layer.fresh(TestMcpOver())))
    }).pipe(Effect.provide(TestMcp())),
  )
})
