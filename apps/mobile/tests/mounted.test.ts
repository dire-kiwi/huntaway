import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import { type Ended, runMounted } from "../src/logic/mounted"

describe("a change that outlives what started it", () => {
  it.effect("runs to its end with nothing else mounting it, however long the host takes", () =>
    Effect.gen(function* () {
      // A registry that drops an atom the moment nobody mounts it: a component's own mount would end with its sheet.
      const registry = AtomRegistry.make()
      const host = yield* Deferred.make<number>()
      const ended = yield* Deferred.make<Ended<number, never>>()
      const change = Atom.fn<number>()((n) => Effect.map(Deferred.await(host), (answer) => answer + n))
      runMounted(registry, change, 1, (result) => Deferred.doneUnsafe(ended, Effect.succeed(result)))
      yield* Effect.yieldNow
      expect(Deferred.isDoneUnsafe(ended)).toBe(false)
      yield* Deferred.succeed(host, 41)
      const result = yield* Deferred.await(ended)
      expect(result._tag === "Success" && result.value).toBe(42)
    }),
  )

  it.effect("says when the host refused", () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make()
      const host = yield* Deferred.make<number, string>()
      const ended = yield* Deferred.make<Ended<number, string>>()
      const change = Atom.fn<number>()(() => Deferred.await(host))
      runMounted(registry, change, 1, (result) => Deferred.doneUnsafe(ended, Effect.succeed(result)))
      yield* Deferred.fail(host, "no")
      const result = yield* Deferred.await(ended)
      expect(result._tag).toBe("Failure")
    }),
  )
})
