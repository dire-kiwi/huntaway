import { describe, expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Layer, Option } from "effect"
import { AsyncResult, type Atom, AtomRegistry } from "effect/reactivity"
import { Conflict, PROTOCOL, type Task, TaskId, Timestamp } from "@huntaway/contracts"
import {
  boardAtom,
  callRpc,
  hostBoardAtom,
  hostSessionAtom,
  optimisticMove,
  taskAtom,
  type Transport,
  transportAtom,
  HostClient,
  HostSession,
} from "../src/index.ts"
import { fakeHost, type FakeHost } from "./fakeHost.ts"
import { info, snapshot, task } from "./fixtures.ts"

const T1 = TaskId.make("task-1")
const LATER = Timestamp.make("2026-11-02T09:00:00.000Z")

/** A registry whose page's own server is `own`, and whose other hosts are `others`; disposed with the scope. */
const registryFor = (own: FakeHost, ...others: ReadonlyArray<FakeHost>) => {
  const transport: Transport = (host) => {
    const found = host === null ? own : others.find((o) => o.id === host)
    return found ? found.layer : Layer.effect(HostClient, Effect.die(new Error(`no fake host ${host}`))).pipe(Layer.provideMerge(HostSession.layer(true)))
  }
  return Effect.acquireRelease(
    Effect.sync(() => AtomRegistry.make({ initialValues: [[transportAtom, transport]] })),
    (registry) => Effect.sync(() => registry.dispose()),
  )
}

/** Waits for `atom` to hold a value `pass` accepts: what the code produces, not a sleep. */
const until = <A>(registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<A>, pass: (a: A) => boolean): Effect.Effect<A> =>
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

const titleOf = (id: string) => (b: { readonly tasks: Readonly<Record<string, { readonly title: string }>> }) => b.tasks[id]?.title

describe("sessions and the board", () => {
  it.effect("folds the page's own host's board stream, and its session goes live", () =>
    Effect.gen(function* () {
      const a = yield* fakeHost("host-a")
      const registry = yield* registryFor(a)
      const board = yield* until(registry, boardAtom, (b) => b.loaded)
      expect(board.authed).toBe(true)
      expect(board.connected).toBe(true)
      expect(board.localHostId).toBe(a.id)
      expect(board.hosts.map((h) => [h.id, h.name, h.local, h.connected])).toEqual([[a.id, "host-a's machine", true, true]])
      expect(Object.keys(board.tasks)).toEqual([T1])
      expect(board.tasks[T1]?.host_id).toBe(a.id)
      // Live events.
      yield* a.emit({ type: "task", task: task({ title: "Changed", updated_at: LATER }) })
      yield* until(registry, boardAtom, (b) => titleOf(T1)(b) === "Changed")
    }).pipe(Effect.scoped),
  )

  it.effect("a dropped connection keeps the board, then resubscribes from the last event it had", () =>
    Effect.gen(function* () {
      const a = yield* fakeHost("host-a")
      const registry = yield* registryFor(a)
      yield* until(registry, boardAtom, (b) => b.loaded)
      yield* a.emit({ type: "task", task: task({ title: "Before", updated_at: LATER }) })
      yield* until(registry, boardAtom, (b) => titleOf(T1)(b) === "Before")
      yield* a.drop
      const offline = yield* until(registry, boardAtom, (b) => !b.connected)
      // Offline, it shows what it had: a failed connection does not empty a host's board.
      expect(offline.authed).toBe(true)
      expect(offline.loaded).toBe(true)
      expect(titleOf(T1)(offline)).toBe("Before")
      expect(registry.get(hostSessionAtom(a.id)).state._tag).toBe("offline")
      // What happened meanwhile is replayed after the `since` it gives.
      yield* a.emit({ type: "task", task: task({ title: "Meanwhile", updated_at: LATER }) })
      yield* a.reconnect
      const back = yield* until(registry, boardAtom, (b) => b.connected && titleOf(T1)(b) === "Meanwhile")
      expect(a.subscriptions).toEqual([undefined, { boot: "boot-1", seq: 2 }])
      expect(back.loaded).toBe(true)
    }).pipe(Effect.scoped),
  )

  it.effect("after resync, and after the host restarted, it takes a fresh snapshot", () =>
    Effect.gen(function* () {
      const a = yield* fakeHost("host-a")
      const registry = yield* registryFor(a)
      yield* until(registry, boardAtom, (b) => b.loaded)
      a.snapshot = snapshot({ seq: 5, tasks: [task({ title: "From the snapshot" })] })
      yield* a.resync
      yield* until(registry, boardAtom, (b) => titleOf(T1)(b) === "From the snapshot")
      expect(a.subscriptions.at(-1)).toBeUndefined()
      // A new boot cannot replay the old one's events.
      yield* a.drop
      a.boot = "boot-2"
      a.snapshot = snapshot({ seq: 1, tasks: [task({ title: "After the restart" })] })
      yield* a.reconnect
      yield* until(registry, boardAtom, (b) => titleOf(T1)(b) === "After the restart")
      expect(a.subscriptions.at(-1)).toEqual({ boot: "boot-1", seq: 5 })
      expect(Option.getOrUndefined(AsyncResult.value(registry.get(hostBoardAtom(a.id))))).toMatchObject({ boot: "boot-2", seq: 1 })
    }).pipe(Effect.scoped),
  )

  it.effect("the page's own host turning the token down shows the token screen", () =>
    Effect.gen(function* () {
      const a = yield* fakeHost("host-a")
      const registry = yield* registryFor(a)
      yield* until(registry, boardAtom, (b) => b.loaded)
      yield* a.refuse
      const refused = yield* until(registry, boardAtom, (b) => b.authed === false)
      expect(refused.connected).toBe(false)
      expect(registry.get(hostSessionAtom(a.id)).state._tag).toBe("unauthorized")
    }).pipe(Effect.scoped),
  )

  it.effect("a host that speaks another protocol needs an update", () =>
    Effect.gen(function* () {
      const a = yield* fakeHost("host-a")
      a.on("host.info", () => Effect.succeed(info("host-a", { protocol: PROTOCOL + 1 })))
      const registry = yield* registryFor(a)
      registry.mount(boardAtom)
      const session = yield* until(registry, hostSessionAtom(a.id), (s) => s.state._tag === "needs_update")
      expect(session.state).toEqual({ _tag: "needs_update", protocol: PROTOCOL + 1 })
    }).pipe(Effect.scoped),
  )

  it.effect("each host has a session of its own; the page's own host shares the hub's", () =>
    Effect.gen(function* () {
      const a = yield* fakeHost("host-a")
      const b = yield* fakeHost("host-b")
      b.snapshot = snapshot({ tasks: [task({ title: "On b" })] })
      b.on("tasks.get", () => Effect.succeed(task({ title: "Got from b" })))
      const registry = yield* registryFor(a, b)
      yield* until(registry, boardAtom, (x) => x.loaded)
      const onB = yield* until(registry, hostBoardAtom(b.id), (r) => r._tag === "Success")
      expect(onB._tag === "Success" && onB.value.tasks.get(T1)?.title).toBe("On b")
      expect(registry.get(hostSessionAtom(b.id)).info?.host_name).toBe("host-b's machine")
      // One connection each: the hub's health and the local board share a's.
      expect([a.builds(), b.builds()]).toEqual([1, 1])
      const got = yield* callRpc(b.id, "tasks.get", { id: "DEMO-1" }).pipe(Effect.provideService(AtomRegistry.AtomRegistry, registry))
      expect(got.title).toBe("Got from b")
      expect(b.calls.map(([m]) => m)).toContain("tasks.get")
      expect(a.calls.map(([m]) => m)).not.toContain("tasks.get")
      // The exact lookup finds b's task, which the merged board (a's first) leaves out.
      expect(registry.get(taskAtom({ host_id: b.id, id: T1 }))?.title).toBe("On b")
      expect(registry.get(taskAtom({ host_id: a.id, id: T1 }))?.title).toBe("A task")
    }).pipe(Effect.scoped),
  )
})

describe("optimistic moves", () => {
  const setup = Effect.gen(function* () {
    const a = yield* fakeHost("host-a")
    const answer = yield* Deferred.make<Task, Conflict>()
    a.on("tasks.update", () => Deferred.await(answer))
    const registry = yield* registryFor(a)
    yield* until(registry, boardAtom, (b) => b.loaded)
    const move = optimisticMove({ host_id: a.id, id: T1 })
    const unmount = registry.mount(move)
    yield* Effect.addFinalizer(() => Effect.sync(unmount))
    registry.set(move, { status: "in_progress", position: 3 })
    return { a, answer, registry, move }
  })

  it.effect("a moved card shows in its new place at once, and stays when the host's event comes", () =>
    Effect.gen(function* () {
      const { a, answer, registry, move } = yield* setup
      const shown = yield* until(registry, boardAtom, (b) => b.tasks[T1]?.status === "in_progress")
      expect(shown.tasks[T1]?.position).toBe(3)
      expect(registry.get(taskAtom({ host_id: a.id, id: T1 }))?.status).toBe("in_progress")
      expect(a.calls.filter(([m]) => m === "tasks.update")).toEqual([["tasks.update", { id: T1, patch: { status: "in_progress", position: 3 } }]])
      const moved = task({ status: "in_progress", position: 3, updated_at: LATER })
      yield* a.emit({ type: "task", task: moved })
      yield* Deferred.succeed(answer, moved)
      yield* until(registry, move, (r) => r._tag === "Success" && !r.waiting)
      expect(registry.get(boardAtom).tasks[T1]?.status).toBe("in_progress")
      expect(registry.get(boardAtom).tasks[T1]?.updated_at).toBe(LATER)
    }).pipe(Effect.scoped),
  )

  it.effect("a move the host refuses goes back", () =>
    Effect.gen(function* () {
      const { answer, registry, move } = yield* setup
      yield* until(registry, boardAtom, (b) => b.tasks[T1]?.status === "in_progress")
      yield* Deferred.fail(answer, new Conflict({ reason: "todos_unfinished", detail: "its todo list is not done" }))
      const failed = yield* until(registry, move, AsyncResult.isFailure)
      expect(AsyncResult.isFailure(failed) && Cause.squash(failed.cause)).toBeInstanceOf(Conflict)
      yield* until(registry, boardAtom, (b) => b.tasks[T1]?.status === "todo")
    }).pipe(Effect.scoped),
  )
})
