import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit } from "effect"
import type { Atom } from "effect/reactivity"
import { AttachmentId } from "@huntaway/contracts"
import { type Board as BoardView, boardAtom, callRpc, type Methods, mutate, tokenAtom, transportAtom } from "@huntaway/client"
import { changed, board as fakeBoard } from "../../browser/fake/builders"
import { fakeHost } from "../../browser/fake/host"
import { board } from "../../../src/state/board"
import { registry } from "../../../src/state/registry"
import { isTagged, runExit } from "../../../src/state/mutation"

// The component checks' fake host (tests/browser/fake), under the page's own registry and `runExit`, without a browser:
// what mount.tsx does, and what a check then relies on.

/** Waits for `atom` to hold a value `pass` accepts. */
const until = <A>(atom: Atom.Atom<A>, pass: (a: A) => boolean): Effect.Effect<A> =>
  Effect.callback<A>((resume) => {
    const now = registry.get(atom)
    if (pass(now)) return resume(Effect.succeed(now))
    const cancel = registry.subscribe(atom, (a) => {
      if (!pass(a)) return
      cancel()
      resume(Effect.succeed(a))
    })
    return Effect.sync(cancel)
  })

/** A fresh registry on a fake host for a new board, as `mount` sets it up. */
const setUp = Effect.acquireRelease(
  Effect.sync(() => {
    registry.reset()
    const b = fakeBoard()
    const task = b.task({ title: "First" })
    const host = fakeHost(b)
    registry.set(transportAtom, host.transport)
    registry.set(tokenAtom, "test-token")
    return { b, task, host }
  }),
  () => Effect.sync(() => registry.reset()),
)

const loaded = (b: BoardView) => b.loaded

/** A call run as the page runs one (`runExit` through the registry): its exit. Task calls are mutations. */
const call = <M extends keyof Methods>(host: string, method: M, payload: Methods[M]["payload"]) =>
  Effect.promise(() => runExit(method.startsWith("tasks.") ? mutate(method, host, payload) : callRpc(host, method, payload)))

/** What a call answered (failing the check if it failed). */
const answer = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) return exit.value
  throw new Error(`the call failed: ${Cause.pretty(exit.cause)}`)
}

/** What a call failed with (undefined if it didn't). */
const failure = <A, E>(exit: Exit.Exit<A, E>): unknown => (Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined)

describe("the fake host", () => {
  it.live("serves the board to the page, signed in and connected, and its events after", () =>
    Effect.gen(function* () {
      const { b, task, host } = yield* setUp
      const shown = yield* until(boardAtom, loaded)
      expect([shown.authed, shown.connected]).toEqual([true, true])
      expect(shown.hosts.map((h) => [h.id, h.name, h.local])).toEqual([[b.host.id, "this machine", true]])
      expect(shown.profiles.map((p) => p.name)).toEqual(["Default"])
      expect(shown.projects.map((p) => p.key)).toEqual(["DEMO"])
      expect(shown.tasks[task.id]?.title).toBe("First")
      host.emit({ type: "task", task: changed(task, { title: "Renamed" }) })
      yield* until(boardAtom, (x) => x.tasks[task.id]?.title === "Renamed")
      host.update(task.id, { status: "done" })
      yield* until(boardAtom, (x) => x.tasks[task.id]?.status === "done")
    }).pipe(Effect.scoped),
  )

  it.live("answers the page's task calls as the server does, and keeps what was sent", () =>
    Effect.gen(function* () {
      const { b, task, host } = yield* setUp
      yield* until(boardAtom, loaded)
      const updated = answer(yield* call(b.host.id, "tasks.update", { id: task.id, patch: { status: "in_progress", todos_override: true } }))
      expect(updated.status).toBe("in_progress")
      expect(host.sent("tasks.update")).toEqual([{ id: task.id, patch: { status: "in_progress", todos_override: true } }])
      // The answer is not put on the board: the event that follows it is.
      yield* until(boardAtom, (x) => x.tasks[task.id]?.status === "in_progress")
      expect(board.get().tasks[task.id]?.status).toBe("in_progress")
      const made = answer(yield* call(b.host.id, "tasks.create", { task: { project_id: b.demo.id, title: "Second" } }))
      yield* until(boardAtom, (x) => x.tasks[made.id]?.title === "Second")
    }).pipe(Effect.scoped),
  )

  it.live("a call fails with the tagged error a host fails with", () =>
    Effect.gen(function* () {
      const { b } = yield* setUp
      const e = failure(yield* call(b.host.id, "tasks.get", { id: "NOPE-1" }))
      expect(isTagged(e, "NotFound")).toBe(true)
      expect(isTagged(e, "Conflict")).toBe(false)
    }).pipe(Effect.scoped),
  )

  it.live("a call it does not expect fails, and is kept to fail the check, unless allowed", () =>
    Effect.gen(function* () {
      const { b, host } = yield* setUp
      expect(failure(yield* call(b.host.id, "pens.list", { profile_id: b.me.id }))).toBeDefined()
      expect(host.missed).toEqual(["pens.list"])
      host.allow(/^attachments\./)
      expect(failure(yield* call(b.host.id, "attachments.get", { id: AttachmentId.make("a"), name: "x" }))).toBeDefined()
      expect(host.missed).toEqual(["pens.list"])
      // A handler of the check's own answers it.
      host.on("pens.list", () => [])
      expect(answer(yield* call(b.host.id, "pens.list", { profile_id: b.me.id }))).toEqual([])
    }).pipe(Effect.scoped),
  )
})
