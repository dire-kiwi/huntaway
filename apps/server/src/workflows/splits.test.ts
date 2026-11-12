import { assert, describe, it } from "@effect/vitest"
import { Effect, Result } from "effect"
import { readGraph } from "./read.ts"
import { SplitRandom } from "./engine/core.ts"
import { engine, make, notices, onBoard, TASK, workable } from "./tests/board.ts"
import { Workflows } from "./Workflows.ts"

// A/B tests (huntaway's integrations/workflows/splits.test.ts): the path a task takes. The dice are `SplitRandom`'s
// (the old `engine_testing.random`), given for each run.

/** A start, an A/B test with `split`'s settings, and a check after each of its paths (which runs without an agent). */
const abGraph = (split: Readonly<Record<string, unknown>>, paths = 2) => {
  const ports = "abcdefgh".slice(0, paths).split("")
  return {
    nodes: [
      { id: "t", kind: "trigger", on: "manual" },
      { id: "ab", kind: "split", ...split },
      ...ports.map((p) => ({ id: `on_${p}`, kind: "condition", check: "has_pr" })),
    ],
    edges: [{ from: "t", port: "out", to: "ab" }, ...ports.map((p) => ({ from: "ab", port: p, to: `on_${p}` }))],
  }
}

describe("A/B tests", () => {
  it.effect("an A/B test takes a path by weight and keeps the task on it", () =>
    onBoard(
      Effect.gen(function* () {
        yield* workable()
        const workflows = yield* Workflows
        const eng = yield* engine
        const w = yield* make(abGraph({ weights: [25, 75] }))
        /** A run by hand, the dice giving `x`. */
        const run = (x: number) => eng.run(w.id, TASK).pipe(Effect.provideService(SplitRandom, Effect.succeed(x)))
        const update = (g: unknown) => {
          const read = readGraph(g)
          return Result.isSuccess(read) ? workflows.update(w.id, { graph: read.success }) : Effect.die(read.failure)
        }
        // 1 in 4 is A, 3 in 4 B: 0.3 of the way along the weights is B's.
        let r = yield* run(0.3)
        assert.deepStrictEqual([r.state, r.nodes["ab"]?.port, r.nodes["ab"]?.text], ["done", "b", "B"])
        assert.deepStrictEqual([r.nodes["on_a"]?.state, r.nodes["on_b"]?.state], ["skipped", "done"])
        assert.isTrue(
          (yield* notices()).some((t) => t.includes("took path B of its A/B test ab (75% likely)")),
          "it says which path it took",
        )
        // The task keeps its path, whatever the dice say.
        r = yield* run(0.1)
        assert.strictEqual(r.nodes["ab"]?.port, "b")
        // Until that path weighs nothing.
        yield* update(abGraph({ weights: [25, 0] }))
        r = yield* run(0.99)
        assert.strictEqual(r.nodes["ab"]?.port, "a")
        // Picking again each run.
        yield* update(abGraph({ weights: [50, 50], each_run: true }))
        assert.strictEqual((yield* run(0.7)).nodes["ab"]?.port, "b")
        assert.strictEqual((yield* run(0.2)).nodes["ab"]?.port, "a")
        // A path weighing nothing is never taken, even at the end of the range.
        yield* update(abGraph({ weights: [10, 0, 10], each_run: true }, 3))
        assert.strictEqual((yield* run(0.999)).nodes["ab"]?.port, "c")
        assert.strictEqual((yield* run(0.5)).nodes["ab"]?.port, "c")
      }),
    ),
  )
})
