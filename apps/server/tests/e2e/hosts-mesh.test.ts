import { NodeServices, NodeWS } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option, Stream } from "effect"
import { RpcClient, RpcMiddleware, RpcSerialization } from "effect/rpc"
import { Socket } from "effect/socket"
import { Auth, HostRpcs, HubRpcs, LinkId, PublicRpcs } from "@huntaway/contracts"
import type { GlobalAgentTools, Host, HostId } from "@huntaway/contracts"
import { httpRpcClientLayer } from "../../src/cli/rpc.ts"
import { startServer } from "./launch.ts"

// The mesh (HE-46; docs/plan/08-hosts.md, The mesh), whole servers: a link goes both ways, whichever host made it; each
// host's directory lists the hosts its neighbours reach, and a client of any host reaches any other through the relay,
// hop by hop; a link's Mesh switch off makes it one way again. Global skills and MCP servers sync across the mesh with
// settings sync (on unless switched off), through a host that links neither end, as profiles do.

const BoardRpcs = PublicRpcs.merge(HostRpcs, HubRpcs)

const SERVE = ["--no-agents", "--no-discovery"]

/** A client of `port`'s own board over HTTP. */
const boardClient = (port: number, token: string) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(httpRpcClientLayer(`http://127.0.0.1:${port}`, token))
    return yield* RpcClient.make(BoardRpcs, { flatten: true }).pipe(Effect.provideContext(context))
  })
type Board = Effect.Success<ReturnType<typeof boardClient>>

/** A client of another host through `port`'s relay, as the web app makes one: a new ticket on every connection, no token. */
const relayedClient = (port: number, ticket: Effect.Effect<string>) =>
  Effect.gen(function* () {
    const url = Effect.map(ticket, (t) => `ws://127.0.0.1:${port}/api/relay/${t}`)
    const context = yield* Layer.build(
      Layer.mergeAll(
        RpcClient.layerProtocolSocket().pipe(
          Layer.provide(Layer.effect(Socket.Socket, Socket.makeWebSocket(url))),
          Layer.provide(NodeWS.layerWebSocketConstructor),
          Layer.provide(RpcSerialization.layerNdjson),
        ),
        RpcMiddleware.layerClient(Auth, ({ next, request }) => next(request)),
      ),
    )
    return yield* RpcClient.make(HostRpcs, { flatten: true }).pipe(Effect.provideContext(context))
  })

/** The first of `stream` that `ready` holds for, within 30 seconds. */
const until = <A, E>(stream: Stream.Stream<A, E>, ready: (a: A) => boolean, what: string) =>
  stream.pipe(
    Stream.filter(ready),
    Stream.runHead,
    Effect.orDie,
    Effect.map(Option.getOrThrow),
    Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => Effect.die(`never: ${what}`) }),
  )

/** `board`'s directory once `ready` holds for it. */
const hostsWhen = (board: Board, ready: (hosts: ReadonlyArray<Host>) => boolean, what: string) => until(board("hub.hosts.watch", undefined), ready, what)

/** A ticket for `host` through `board`'s relay. */
const ticket = (board: Board, host: HostId) => Effect.map(board("hub.hosts.openRelay", { host_id: host }), (r) => r.ticket).pipe(Effect.orDie)

const entry = (hosts: ReadonlyArray<Host>, id: HostId) => hosts.find((h) => h.id === id)

/** `board`'s skills and servers once `ready` holds for them, read again on its `agent_tools_changed` events. */
const toolsWhen = (board: Board, ready: (tools: GlobalAgentTools) => boolean, what: string) =>
  until(
    board("board.watch", {}).pipe(
      Stream.filter((m) => m.type === "snapshot" || m.type === "agent_tools_changed"),
      Stream.mapEffect(() => Effect.orDie(board("agentTools.get", undefined)), { concurrency: 1 }),
    ),
    ready,
    what,
  )

const SKILL = "---\nname: deploy-notes\ndescription: How this fleet deploys.\n---\n\nUse the release script.\n"

describe("the mesh, whole servers", () => {
  it.live(
    "hosts linked in a chain by URL each show and reach every other, both ways",
    () =>
      Effect.gen(function* () {
        const aServer = yield* startServer(SERVE)
        const bServer = yield* startServer(SERVE)
        const cServer = yield* startServer(SERVE)
        const a = yield* boardClient(aServer.port, aServer.token)
        const b = yield* boardClient(bServer.port, bServer.token)
        const c = yield* boardClient(cServer.port, cServer.token)
        const aId = (yield* a("host.info", undefined)).host_id
        const bId = (yield* b("host.info", undefined)).host_id
        const cId = (yield* c("host.info", undefined)).host_id
        assert.include((yield* a("host.info", undefined)).capabilities, "mesh")

        // A links B, B links C: each by URL and token, one way.
        yield* a("hub.hosts.add", { url: `http://127.0.0.1:${bServer.port}`, token: bServer.token })
        yield* b("hub.hosts.add", { url: `http://127.0.0.1:${cServer.port}`, token: cServer.token })

        // B shows A, which links it, as it does C; C shows B, and A through B; A shows C through B.
        const onB = yield* hostsWhen(b, (hs) => entry(hs, aId)?.connected === true && entry(hs, cId)?.connected === true, "B shows A and C")
        assert.strictEqual(entry(onB, aId)?.mode, "reverse")
        assert.isUndefined(entry(onB, aId)?.mesh)
        assert.strictEqual(entry(onB, cId)?.mesh, true)
        const onC = yield* hostsWhen(c, (hs) => entry(hs, aId)?.connected === true && entry(hs, bId)?.connected === true, "C shows A and B")
        assert.strictEqual(entry(onC, bId)?.mode, "reverse")
        assert.deepStrictEqual([entry(onC, aId)?.mode, entry(onC, aId)?.through, entry(onC, aId)?.route], ["mesh", bId, [bId]])
        const onA = yield* hostsWhen(a, (hs) => entry(hs, cId)?.connected === true, "A shows C")
        assert.deepStrictEqual([entry(onA, cId)?.mode, entry(onA, cId)?.through], ["mesh", bId])
        // Each host once, with no route back through itself.
        assert.deepStrictEqual(onA.map((h) => h.id).toSorted(), [aId, bId, cId].toSorted())

        // A client of C reaches B (which links C) and A (two hops away); a client of A reaches C.
        const cToB = yield* relayedClient(cServer.port, ticket(c, bId))
        assert.strictEqual((yield* cToB("host.info", undefined)).host_id, bId)
        const cToA = yield* relayedClient(cServer.port, ticket(c, aId))
        assert.strictEqual((yield* cToA("host.info", undefined)).host_id, aId)
        assert.isArray(yield* cToA("profiles.list", undefined))
        const aToC = yield* relayedClient(aServer.port, ticket(a, cId))
        assert.strictEqual((yield* aToC("host.info", undefined)).host_id, cId)

        // B says what it is for; the others see it when it next says hello, and its own board at once.
        yield* b("host.updateSettings", { patch: { role: "access" } })
        assert.strictEqual((yield* b("host.info", undefined)).role, "access")
        assert.strictEqual((yield* cToB("host.info", undefined)).role, "access")

        // A's Mesh switch off: B and C no longer reach A; A still reaches B, and C through it.
        yield* a("hub.hosts.update", { id: LinkId.make(bId), mesh: false })
        yield* hostsWhen(b, (hs) => entry(hs, aId)?.connected !== true, "B no longer reaches A")
        yield* hostsWhen(c, (hs) => entry(hs, aId) === undefined, "C no longer reaches A")
        yield* hostsWhen(a, (hs) => entry(hs, bId)?.connected === true && entry(hs, cId)?.connected === true, "A still reaches B and C")
        const refused = yield* Effect.flip(c("hub.hosts.openRelay", { host_id: aId }))
        assert.strictEqual(refused._tag, "NotFound")
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    90_000,
  )

  it.live(
    "a host that dials in to a hub reaches the hub back once the hub turns its Mesh switch on, and not after it's off",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const hubServer = yield* startServer(SERVE)
        const hubToken = (yield* fs.readFileString(`${hubServer.dataDir}/hub_token`)).trim()
        const hostServer = yield* startServer([...SERVE, "--hub", `http://127.0.0.1:${hubServer.port}`, "--hub-token", hubToken])
        const hub = yield* boardClient(hubServer.port, hubServer.token)
        const host = yield* boardClient(hostServer.port, hostServer.token)
        const hubId = (yield* hub("host.info", undefined)).host_id
        const hostId = (yield* host("host.info", undefined)).host_id

        // A host the hub hasn't seen before: known only by the id it gives with the hub token, it starts with Mesh off.
        const onHub = yield* hostsWhen(hub, (hs) => entry(hs, hostId)?.connected === true, "the hub shows the host")
        assert.deepStrictEqual([entry(onHub, hostId)?.mode, entry(onHub, hostId)?.mesh], ["inbound", false])
        const refused = yield* Effect.flip(host("hub.hosts.openRelay", { host_id: hubId }))
        assert.strictEqual(refused._tag, "NotFound")
        // On: the hub drops the host, which dials in again and reaches the hub back.
        yield* hub("hub.hosts.update", { id: LinkId.make(hostId), mesh: true })
        const onHost = yield* hostsWhen(host, (hs) => entry(hs, hubId)?.connected === true, "the host shows the hub")
        assert.strictEqual(entry(onHost, hubId)?.mode, "hub")

        const toHub = yield* relayedClient(hostServer.port, Effect.map(host("hub.hosts.openRelay", { host_id: hubId }), (r) => r.ticket).pipe(Effect.orDie))
        assert.strictEqual((yield* toHub("host.info", undefined)).host_id, hubId)

        // Off: the hub drops the host, which dials in again and no longer gets a way back.
        yield* hub("hub.hosts.update", { id: LinkId.make(hostId), mesh: false })
        yield* hostsWhen(host, (hs) => entry(hs, hubId) === undefined || entry(hs, hubId)?.connected === false, "the host no longer reaches the hub")
        yield* hostsWhen(hub, (hs) => entry(hs, hostId)?.connected === true, "the hub reaches the host again")
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    90_000,
  )

  it.live(
    "global skills and MCP servers sync across the mesh, through a host that links neither end",
    () =>
      Effect.gen(function* () {
        const aServer = yield* startServer(SERVE)
        const bServer = yield* startServer(SERVE)
        const cServer = yield* startServer(SERVE)
        const a = yield* boardClient(aServer.port, aServer.token)
        const b = yield* boardClient(bServer.port, bServer.token)
        const c = yield* boardClient(cServer.port, cServer.token)
        // A links B, and C links B: B is the one host between them.
        yield* a("hub.hosts.add", { url: `http://127.0.0.1:${bServer.port}`, token: bServer.token })
        yield* c("hub.hosts.add", { url: `http://127.0.0.1:${bServer.port}`, token: bServer.token })

        const skill = yield* c("agentTools.addSkill", { project_id: null, skill: { content: SKILL } })
        yield* toolsWhen(a, (t) => t.skills.some((s) => s.name === "deploy-notes" && s.content === SKILL), "A has C's skill")
        yield* a("agentTools.addServer", { project_id: null, server: { name: "docs", config: { type: "http", url: "https://docs.example.com/mcp" } } })
        const onC = yield* toolsWhen(c, (t) => t.mcp_servers.some((s) => s.name === "docs"), "C has A's server")
        assert.strictEqual(onC.mcp_servers.find((s) => s.name === "docs")?.config.url, "https://docs.example.com/mcp")

        yield* c("agentTools.removeSkill", { project_id: null, id: skill.id })
        yield* toolsWhen(a, (t) => !t.skills.some((s) => s.name === "deploy-notes"), "A no longer has the skill")
        yield* toolsWhen(b, (t) => !t.skills.some((s) => s.name === "deploy-notes") && t.mcp_servers.some((s) => s.name === "docs"), "B is the same")

        // With no switch turned on anywhere (sync is on unless switched off): a profile made on C is on A, with its tint.
        yield* c("profiles.create", { profile: { name: "side", tint: "#7c7cf8" } })
        yield* until(
          a("board.watch", {}).pipe(Stream.flatMap((m) => (m.type === "snapshot" || m.type === "profiles_changed" ? Stream.make(m.profiles) : Stream.empty))),
          (profiles) => profiles.some((p) => p.name === "side" && p.tint === "#7c7cf8"),
          "A has C's profile",
        )
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    90_000,
  )

  it.live(
    "two linked hosts go quiet; a restart keeps the other way up; a host linked back can be a profile's assistant host",
    () =>
      Effect.gen(function* () {
        const aServer = yield* startServer(SERVE)
        const bServer = yield* startServer(SERVE)
        const a = yield* boardClient(aServer.port, aServer.token)
        const b = yield* boardClient(bServer.port, bServer.token)
        const aId = (yield* a("host.info", undefined)).host_id
        const bId = (yield* b("host.info", undefined)).host_id
        yield* a("hub.hosts.add", { url: `http://127.0.0.1:${bServer.port}`, token: bServer.token })
        yield* hostsWhen(b, (hs) => entry(hs, aId)?.connected === true, "B shows A")
        yield* hostsWhen(a, (hs) => entry(hs, bId)?.connected === true, "A shows B")

        // Idle, a directory changes only with a ping's heard time (every 20 s): no more than a few lists in 5 s, where
        // the two re-sending each other's lists sent thousands.
        const burst = yield* a("hub.hosts.watch", undefined).pipe(Stream.take(10), Stream.runCount, Effect.timeoutOption("5 seconds"))
        assert.isTrue(Option.isNone(burst), "A's directory kept changing while nothing happened")

        // B restarts: A dials it again and attaches back, and B shows A connected, not a link it can't dial.
        yield* bServer.process.kill({ killSignal: "SIGKILL" })
        const again = yield* startServer([...SERVE, "--port", String(bServer.port)], {}, bServer.dataDir)
        const b2 = yield* boardClient(again.port, again.token)
        // Before A is back it is away, never "refused" for a link B has no URL or token to dial.
        assert.notStrictEqual(entry(yield* b2("hub.hosts.list", undefined), aId)?.status, "refused")
        const onB = yield* hostsWhen(b2, (hs) => entry(hs, aId)?.connected === true, "B shows A again after its restart")
        assert.strictEqual(entry(onB, aId)?.mode, "reverse")

        // B's profile runs its assistant on A, which B reaches back over A's link: A's attach is still taken.
        const profile = yield* b2("profiles.create", { profile: { name: "assist" } })
        yield* b2("profiles.update", { id: profile.id, patch: { assistant_host: LinkId.make(aId) } })
        yield* a("hub.hosts.update", { id: LinkId.make(bId), mesh: false })
        yield* hostsWhen(b2, (hs) => entry(hs, aId)?.connected !== true, "A no longer attaches back")
        yield* a("hub.hosts.update", { id: LinkId.make(bId), mesh: true })
        yield* hostsWhen(b2, (hs) => entry(hs, aId)?.connected === true, "A attaches back to B, whose profile's assistant runs on A")

        // B forgets A's link back: A, still linking B, attaches back again and B shows it once more.
        yield* b2("hub.hosts.remove", { id: LinkId.make(aId) })
        yield* hostsWhen(b2, (hs) => entry(hs, aId)?.connected === true && entry(hs, aId)?.mode === "reverse", "A comes back to B after B forgot it")
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    90_000,
  )
})
