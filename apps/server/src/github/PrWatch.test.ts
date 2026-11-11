import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { fakeGitHub, TestBoard } from "@huntaway/testing"
import { compare, EVENTS, seenNothing } from "./prWatch/pr.ts"
import { PrWatch } from "./PrWatch.ts"
import { github, pull7 } from "./tests/pullRequests.ts"

// Reading a pull request through gh (the old mcp/pr_watch/tests.test.ts `reads_every_page_of_review_threads`), over
// the fake GitHub, which pages review threads as GitHub does. Dropped, with why: its page that fails while the first
// read works (the fake answers every page of a pull request alike; a failed read is the wait's cases' `unreadable`).

/** `n` review threads with a comment each, `T<first>`… (each one later than the one before). */
const threads = (first: number, n: number) =>
  Array.from({ length: n }, (_, k) => {
    const i = first + k
    const at = `2026-10-31T01:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`
    return { path: "a.rs", comments: [{ id: `T${i}`, author: "carol", body: "x", createdAt: at, line: i }] }
  })

describe("PrWatch", () => {
  it.effect("reads every page of review threads", () =>
    Effect.gen(function* () {
      // 250 threads: the first page comes with the pull request, the rest after it.
      const fake = yield* fakeGitHub(github([pull7({ reviewThreads: threads(0, 250) })]))
      yield* Effect.gen(function* () {
        const prWatch = yield* PrWatch
        const pr = yield* prWatch.read({ target: { host: "github.com", owner: "o", name: "r", number: 7 }, account: null }).pipe(Effect.orDie)
        const reads = (yield* fake.calls).filter((c) => c.args[1] === "graphql")
        assert.deepStrictEqual(
          reads.map((c) => c.args.find((a) => a.startsWith("after=")) ?? null),
          [null, "after=100", "after=200"],
        )
        assert.strictEqual(pr.remarks.length, 250)
        // So a comment on the newest thread is news.
        const seen = { ...seenNothing, remarks: pr.remarks.slice(0, 249).map((r) => r.id) }
        assert.strictEqual(compare(seen, pr, [...EVENTS]).news?.news.comments?.[0]?.line, 249)
      }).pipe(Effect.provide(TestBoard({ ghBin: fake.bin })))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
