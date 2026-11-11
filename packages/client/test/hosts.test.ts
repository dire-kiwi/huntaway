import { describe, expect, it } from "@effect/vitest"
import { Context, Deferred, Effect, Exit, Layer, Ref, SubscriptionRef } from "effect"
import { Socket } from "effect/socket"
import { ProjectId, PROTOCOL, TaskId } from "@huntaway/contracts"
import { boardAtom, HostClient, hostSessionAtom, relaySocket, relayUrl, socketSession } from "../src/index.ts"
import type { HostSession } from "../src/index.ts"
import { fakeHost } from "./fakeHost.ts"
import { hostEntry, project, snapshot, task } from "./fixtures.ts"
import { registryFor, until } from "./registry.ts"

// One board across hosts (docs/plan/08-hosts.md; inventory 05 §2.2a): the page's own server is the hub, its directory
// (`hub.hosts.watch`) says which hosts it links, and each of those has a session of its own (through the relay; here an
// in-memory host each).

/** A host whose board has a project and a task of its own, `name`d. */
const linked = (id: string, name: string) =>
  Effect.gen(function* () {
    const host = yield* fakeHost(id)
    const projectId = ProjectId.make(`project-${id}`)
    host.snapshot = snapshot({
      projects: [project({ id: projectId, name })],
      tasks: [task({ id: TaskId.make(`task-${id}`), project_id: projectId, title: `${name}'s task` })],
    })
    return host
  })

/** A hub (`hub`) and two hosts it links (`b`, `c`). */
const setup = Effect.gen(function* () {
  const hub = yield* fakeHost("hub")
  const b = yield* linked("b", "Bravo")
  const c = yield* linked("c", "Charlie")
  const local = hostEntry("hub", { name: "hub's machine", local: true, mode: "local", url: null })
  return { hub, b, c, local }
})

const titles = (board: { readonly tasks: Readonly<Record<string, { readonly title: string }>> }) => Object.values(board.tasks).map((t) => t.title)

describe("linked hosts", () => {
  it.effect("the board shows every host the hub links: their projects and tasks, and the hub's entry for each", () =>
    Effect.gen(function* () {
      const { hub, b, c, local } = yield* setup
      yield* SubscriptionRef.set(hub.hosts, [local, hostEntry("b", { name: "Build box", uplink: true }), hostEntry("c", { mode: "ssh", url: "ssh://me@c" })])
      const registry = yield* registryFor(hub, b, c)
      const board = yield* until(registry, boardAtom, (x) => x.loaded && x.hosts.filter((h) => h.connected).length === 3 && Object.keys(x.tasks).length === 3)
      expect(board.hosts.map((h) => [h.id, h.name, h.local, h.mode])).toEqual([
        ["hub", "hub's machine", true, "local"],
        ["b", "Build box", false, "outbound"],
        ["c", "c link", false, "ssh"],
      ])
      expect(board.hosts.find((h) => h.id === "b")?.uplink).toBe(true)
      expect(board.hosts.find((h) => h.id === "c")?.url).toBe("ssh://me@c")
      expect(titles(board).toSorted()).toEqual(["A task", "Bravo's task", "Charlie's task"])
      expect(board.tasks["task-b"]?.host_id).toBe("b")
      expect(board.projects.map((p) => [p.host_id, p.name])).toEqual([
        ["b", "Bravo"],
        ["c", "Charlie"],
        ["hub", "Demo"],
      ])
      // Each host's board comes on its own session.
      expect([hub.builds(), b.builds(), c.builds()]).toEqual([1, 1, 1])
      // A host linked later joins the board; one forgotten leaves it.
      yield* SubscriptionRef.set(hub.hosts, [local, hostEntry("c", { mode: "ssh" })])
      const forgotten = yield* until(registry, boardAtom, (x) => x.hosts.length === 2)
      expect(titles(forgotten).toSorted()).toEqual(["A task", "Charlie's task"])
    }).pipe(Effect.scoped),
  )

  it.effect("a linked host that drops keeps its last board, marked offline, and continues when it is back", () =>
    Effect.gen(function* () {
      const { hub, b, c, local } = yield* setup
      yield* SubscriptionRef.set(hub.hosts, [local, hostEntry("b"), hostEntry("c")])
      const registry = yield* registryFor(hub, b, c)
      yield* until(registry, boardAtom, (x) => Object.keys(x.tasks).length === 3)
      yield* b.drop
      yield* SubscriptionRef.set(hub.hosts, [
        local,
        hostEntry("b", { connected: false, status: "offline", status_reason: "connection refused" }),
        hostEntry("c"),
      ])
      const offline = yield* until(registry, boardAtom, (x) => x.hosts.find((h) => h.id === "b")?.status === "offline")
      expect(offline.hosts.find((h) => h.id === "b")?.connected).toBe(false)
      expect(offline.tasks["task-b"]?.title).toBe("Bravo's task")
      expect(registry.get(hostSessionAtom(b.id)).state._tag).toBe("offline")
      yield* b.reconnect
      yield* until(registry, boardAtom, (x) => x.hosts.find((h) => h.id === "b")?.connected === true)
      expect(b.subscriptions.at(-1)).toEqual({ boot: "boot-1", seq: 1 })
    }).pipe(Effect.scoped),
  )

  it.effect("a linked host that speaks another protocol needs an update, and is not subscribed to", () =>
    Effect.gen(function* () {
      const { hub, b, c, local } = yield* setup
      const newer = hostEntry("c", { connected: false, protocol: PROTOCOL + 1, status: "needs_update" })
      yield* SubscriptionRef.set(hub.hosts, [local, hostEntry("b"), newer])
      const registry = yield* registryFor(hub, b, c)
      const board = yield* until(registry, boardAtom, (x) => Object.keys(x.tasks).length === 2 && x.hosts.length === 3)
      expect(board.hosts.find((h) => h.id === "c")).toMatchObject({ connected: false, status: "needs_update" })
      expect(registry.get(hostSessionAtom(c.id)).state).toEqual({ _tag: "needs_update", protocol: PROTOCOL + 1 })
      expect([c.builds(), c.subscriptions.length]).toEqual([0, 0])
      expect(titles(board).toSorted()).toEqual(["A task", "Bravo's task"])
    }).pipe(Effect.scoped),
  )
})

describe("the relay's socket", () => {
  it("is on the page's own server, under /api/relay/<ticket>", () => {
    expect(relayUrl("ws://hub:7878/api/rpc", "abc")).toBe("ws://hub:7878/api/relay/abc")
    expect(relayUrl("wss://board.example/api/rpc", "a/b")).toBe("wss://board.example/api/relay/a%2Fb")
  })

  it.effect("asks for a new ticket each time it opens; a ticket refused is an error opening it", () =>
    Effect.gen(function* () {
      const opened: Array<string> = []
      // A websocket that closes at once: each open of the socket makes one.
      const closed = Layer.succeed(Socket.WebSocketConstructor)((url) => {
        opened.push(url)
        return { readyState: 3, addEventListener: () => {}, removeEventListener: () => {}, close: () => {}, send: () => {} }
      })
      const n = yield* Ref.make(0)
      const ticket = Effect.flatMap(
        Ref.updateAndGet(n, (i) => i + 1),
        (i) => (i < 3 ? Effect.succeed(`ticket-${i}`) : Effect.fail("host offline")),
      )
      const socket = yield* relaySocket("ws://hub/api/rpc", ticket).pipe(Effect.provide(closed))
      const first = yield* Effect.exit(Effect.scoped(socket.reader))
      const second = yield* Effect.exit(Effect.scoped(socket.reader))
      expect(Exit.isFailure(first) && Exit.isFailure(second)).toBe(true)
      expect(opened).toEqual(["ws://hub/api/relay/ticket-1", "ws://hub/api/relay/ticket-2"])
      const refused = yield* Effect.flip(Effect.scoped(socket.reader))
      expect(refused.reason._tag).toBe("SocketOpenError")
      expect(opened).toHaveLength(2)
    }),
  )
})

// Review of HE-6: the hub pipes a relayed session's frames to the host as they are, request headers included, so a
// token on them would hand the hub's board token to every host linked to it (a dial-in one only ever held the hub
// token). A relayed session's requests carry none; a session of the page's own board keeps its token.
/** A frame as text. */
const frameText = (chunk: unknown) => (typeof chunk === "string" ? chunk : chunk instanceof Uint8Array ? String.fromCharCode(...chunk) : "")

/** The frames `session` writes for one call, on a socket that records them and never answers. */
const framesOf = (session: (socket: Layer.Layer<Socket.Socket>) => Layer.Layer<HostClient | HostSession>) =>
  Effect.gen(function* () {
    const written = yield* Ref.make<ReadonlyArray<string>>([])
    const sent = yield* Deferred.make<void>()
    const record = (chunks: ReadonlyArray<unknown>) =>
      Effect.andThen(
        Ref.update(written, (all) => [...all, ...chunks.map(frameText)]),
        Effect.flatMap(Ref.get(written), (all) => (all.some((f) => f.includes("host.info")) ? Deferred.succeed(sent, undefined) : Effect.void)),
      )
    const socket = Layer.succeed(
      Socket.Socket,
      Socket.make({
        reader: Effect.succeed({ pull: Effect.never, upgrade: Socket.SocketUpgradeError.unsupported }),
        writer: Effect.succeed({ write: (chunk) => record([chunk]), writeAll: (chunks) => record(chunks) }),
      }),
    )
    const context = yield* Layer.build(session(socket))
    yield* Effect.forkScoped(Context.get(context, HostClient)("host.info", undefined))
    yield* Deferred.await(sent)
    return (yield* Ref.get(written)).join("\n")
  }).pipe(Effect.scoped)

describe("what a session's requests carry", () => {
  it.live("a relayed session sends no token; the page's own sends its own", () =>
    Effect.gen(function* () {
      const relayed = yield* framesOf((socket) => socketSession(socket, null))
      expect(relayed).toContain("host.info")
      expect(relayed).not.toContain("authorization")
      const own = yield* framesOf((socket) => socketSession(socket, "the-board-token"))
      expect(own).toContain("Bearer the-board-token")
    }),
  )
})
