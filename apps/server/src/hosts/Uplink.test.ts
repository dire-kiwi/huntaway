import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Queue, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Rpc } from "effect/rpc"
import { boardScopes, HostId, LinkId } from "@huntaway/contracts"
import type { LinkHello, SessionShape, ToolOutcome, UpCall } from "@huntaway/contracts"
import { TestBoard } from "@huntaway/testing"
import { HostTools } from "./HostTools.ts"
import { Uplink } from "./Uplink.ts"

// A host's side of board tools up a link (the old hosts/uplink/tests.test.ts `an_up_link_goes_with_its_connection`,
// and HA-262's hub that went without closing): the hub that dialled the host holds `link.upcalls` open, takes the calls
// offered on it, and answers by `link.upcallResult`; and who may call `tools.call` which way.

const hello = (id: string, name: string): LinkHello => ({
  host_id: HostId.make(id),
  name,
  protocol: 1,
  version: "0",
  capabilities: [],
  commit: null,
  agents: true,
  updates_from: null,
})

/** The hub's own session on this host: sealed, of kind `link`, naming it. */
const hubSession = (id: string): SessionShape => ({ kind: "link", scopes: new Set([...boardScopes, "link"]), device_id: null, via_link: LinkId.make(id) })
/** A host that dialled in, with the hub token. */
const dialInSession: SessionShape = { kind: "link", scopes: new Set(["link"]), device_id: null, via_link: null }

const call = { profile: "personal", tool: "get_task", args: { task_id: "HUB-1" }, call_id: "c1" }

/** The one hub holding `link.upcalls` open. */
const theHub = Effect.flatMap(Uplink, (uplink) => Effect.flatMap(uplink.holders, ([hub]) => (hub === undefined ? Effect.die("no hub") : Effect.succeed(hub))))

describe("Uplink", () => {
  it.effect("a hub that dialled the host takes its calls on its stream, and answers them", () =>
    Effect.gen(function* () {
      const uplink = yield* Uplink
      const offered = yield* Queue.unbounded<UpCall>()
      yield* Effect.forkChild(Stream.runForEach(uplink.offer(hello("hub", "desktop"), hubSession("hub")), (c) => Queue.offer(offered, c)))
      yield* Effect.yieldNow
      const hub = yield* theHub
      assert.deepStrictEqual([hub.id, hub.name], ["hub", "desktop"])
      const pending = yield* Effect.forkChild(hub.call(call))
      const sent = yield* Queue.take(offered)
      assert.deepStrictEqual([sent.call_id, sent.tool, sent.profile], ["c1", "get_task", "personal"])
      const id = sent.id
      // An answer on another hub's connection isn't taken for it.
      yield* uplink.answer(hubSession("other"), { id, outcome: { _tag: "Ok", value: "wrong" } })
      yield* uplink.answer(hubSession("hub"), { id, outcome: { _tag: "Ok", value: { key: "HUB-1" } } })
      assert.deepStrictEqual(yield* Fiber.join(pending), { _tag: "Ok", value: { key: "HUB-1" } } satisfies ToolOutcome)
    }).pipe(Effect.provide(TestBoard())),
  )

  it.effect("a call waiting when the hub's connection goes may or may not have taken effect, and the next connection takes over", () =>
    Effect.gen(function* () {
      const uplink = yield* Uplink
      const first = yield* Effect.forkChild(Stream.runDrain(uplink.offer(hello("hub", "desktop"), hubSession("hub"))))
      yield* Effect.yieldNow
      const hub = yield* theHub
      const pending = yield* Effect.forkChild(hub.call(call))
      yield* Effect.yieldNow
      // The hub connects again: its earlier connection's waiting calls fail, rather than wait on.
      const second = yield* Effect.forkChild(Stream.runDrain(uplink.offer(hello("hub", "desktop"), hubSession("hub"))))
      yield* Effect.yieldNow
      const o = yield* Fiber.join(pending)
      assert.isTrue(
        o._tag === "Err" && o.message.includes("lost the link to desktop before it answered") && o.message.includes("may or may not have taken effect"),
      )
      // The old one going leaves the new one.
      yield* Fiber.interrupt(first)
      assert.strictEqual((yield* uplink.holders).length, 1)
      yield* Fiber.interrupt(second)
      assert.strictEqual((yield* uplink.holders).length, 0)
    }).pipe(Effect.provide(TestBoard())),
  )

  it.effect("a hub that went quiet is given up on after 300 seconds", () =>
    Effect.gen(function* () {
      const uplink = yield* Uplink
      yield* Effect.forkChild(Stream.runDrain(uplink.offer(hello("hub", "desktop"), hubSession("hub"))))
      yield* Effect.yieldNow
      const hub = yield* theHub
      const pending = yield* Effect.forkChild(hub.call(call))
      yield* TestClock.adjust("300 seconds")
      const o = yield* Fiber.join(pending)
      assert.isTrue(o._tag === "Err" && o.message.startsWith("desktop didn't answer in time: this get_task call may or may not have taken effect"))
    }).pipe(Effect.provide(TestBoard())),
  )

  it.effect("only the hub itself, on its own connection, takes the calls", () =>
    Effect.gen(function* () {
      const uplink = yield* Uplink
      const refused = (session: SessionShape, id = "hub") =>
        uplink.offer(hello(id, "desktop"), session).pipe(
          Stream.runDrain,
          Effect.flip,
          Effect.map((e) => e.reason),
        )
      // A host that dialled in, a relayed board client, a hub claiming another's id.
      assert.include(yield* refused(dialInSession), "only to a hub on its own connection")
      assert.include(yield* refused({ ...hubSession("hub"), kind: "board" }), "only to a hub on its own connection")
      assert.include(yield* refused(hubSession("other")), "only to a hub on its own connection")
      assert.strictEqual((yield* uplink.holders).length, 0)
    }).pipe(Effect.provide(TestBoard())),
  )
})

describe("tools.call", () => {
  it.effect("a call down comes from a hub, and a call up from a host on the connection it attached on", () =>
    Effect.gen(function* () {
      const tools = yield* HostTools
      const over = new Rpc.ServerClient(1)
      // Down, from a host that dialled in with the hub token: it isn't a hub of this host's.
      const down = yield* tools.call({ ...call, call_id: null, up: false }, dialInSession, over)
      assert.deepStrictEqual(down, { _tag: "Off", why: "a call down a link comes from the hub on its own connection" })
      // Up, on a connection no host attached on, or from a hub's own session.
      for (const session of [dialInSession, hubSession("hub")]) {
        const up = yield* tools.call({ ...call, up: true }, session, over)
        assert.isTrue(up._tag === "Off" && up.why !== null && up.why.includes("only from a host connected to it, on its own connection"))
      }
      // Down from a hub: run here (no such profile here).
      const ran = yield* tools.call({ ...call, call_id: null, up: false }, hubSession("hub"), over)
      assert.deepStrictEqual(ran._tag === "Err" ? ran.not_found : null, true)
    }).pipe(Effect.provide(TestBoard())),
  )
})
