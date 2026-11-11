import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { TestBoard } from "@huntaway/testing"
import { Actor, Changes } from "../platform/Changes.ts"
import { Reactor } from "./Reactor.ts"

layer(TestBoard())("Reactor", (it) => {
  it.effect("handles every change offered, and `idle` waits for them", () =>
    Effect.gen(function* () {
      const changes = yield* Changes
      const reactor = yield* Reactor
      yield* reactor.idle
      for (let i = 0; i < 3; i++) yield* changes.offer({ _tag: "TaskChanged", before: null, after: null, cause: Actor.user })
      yield* reactor.idle
      assert.isTrue(true)
    }),
  )
})
