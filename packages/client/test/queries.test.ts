import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { AsyncResult, AtomRegistry } from "effect/reactivity"
import { TaskId, Timestamp } from "@huntaway/contracts"
import { boardAtom, mutate, query } from "../src/index.ts"
import { fakeHost } from "./fakeHost.ts"
import { task } from "./fixtures.ts"
import { registryFor, until } from "./registry.ts"

const T1 = TaskId.make("task-1")
const LATER = Timestamp.make("2026-11-02T09:00:00.000Z")

describe("queries", () => {
  it.effect("reads a method's answer while shown; the same payload is the same atom", () =>
    Effect.gen(function* () {
      const a = yield* fakeHost("host-a")
      let reads = 0
      a.on("git.status", () => Effect.sync(() => ({ available: true, reason: `read ${++reads}` })))
      const registry = yield* registryFor(a)
      yield* until(registry, boardAtom, (b) => b.loaded)
      const atom = query("git.status", a.id, { id: T1 })
      expect(query("git.status", a.id, { id: T1 })).toBe(atom)
      registry.mount(atom)
      const first = yield* until(registry, atom, AsyncResult.isSuccess)
      expect(AsyncResult.getOrThrow(first).reason).toBe("read 1")
    }).pipe(Effect.scoped),
  )

  it.effect("a mutation reads its group's queries on its host again; another group's does not", () =>
    Effect.gen(function* () {
      const a = yield* fakeHost("host-a")
      let reads = 0
      a.on("git.status", () => Effect.sync(() => ({ available: true, reason: `read ${++reads}` })))
      a.on("git.stage", () => Effect.void)
      a.on("tasks.update", () => Effect.succeed(task()))
      const registry = yield* registryFor(a)
      yield* until(registry, boardAtom, (b) => b.loaded)
      const atom = query("git.status", a.id, { id: T1 })
      registry.mount(atom)
      yield* until(registry, atom, (r) => AsyncResult.isSuccess(r) && r.value.reason === "read 1")
      yield* mutate("tasks.update", a.id, { id: T1, patch: { title: "Other" } }).pipe(Effect.provideService(AtomRegistry.AtomRegistry, registry))
      expect(reads).toBe(1)
      yield* mutate("git.stage", a.id, { id: T1, paths: ["a.txt"] }).pipe(Effect.provideService(AtomRegistry.AtomRegistry, registry))
      yield* until(registry, atom, (r) => AsyncResult.isSuccess(r) && r.value.reason === "read 2")
    }).pipe(Effect.scoped),
  )

  it.effect("is read again when what it follows on the board changes (a task's run, for its git status)", () =>
    Effect.gen(function* () {
      const a = yield* fakeHost("host-a")
      let reads = 0
      a.on("git.status", () => Effect.sync(() => ({ available: true, reason: `read ${++reads}` })))
      const registry = yield* registryFor(a)
      yield* until(registry, boardAtom, (b) => b.loaded)
      const atom = query("git.status", a.id, { id: T1 })
      registry.mount(atom)
      yield* until(registry, atom, (r) => AsyncResult.isSuccess(r) && r.value.reason === "read 1")
      // A change it doesn't follow: not read again.
      yield* a.emit({ type: "task", task: task({ title: "Renamed", updated_at: LATER }) })
      yield* until(registry, boardAtom, (b) => b.tasks[T1]?.title === "Renamed")
      expect(reads).toBe(1)
      yield* a.emit({ type: "task", task: task({ running: true, updated_at: LATER }) })
      yield* until(registry, atom, (r) => AsyncResult.isSuccess(r) && r.value.reason === "read 2")
    }).pipe(Effect.scoped),
  )
})
