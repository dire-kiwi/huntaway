import { NodeServices, NodeWS } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { NodeSocketServer } from "@effect/platform-node"
import { Effect, Exit, FileSystem, Layer, Option, Path, Schedule, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Headers } from "effect/http"
import { RpcClient, RpcMiddleware, RpcSerialization } from "effect/rpc"
import { Socket } from "effect/socket"
import { Auth, HostRpcs, HubRpcs, LinkId, LinkRpcs, PublicRpcs } from "@huntaway/contracts"
import type { Host } from "@huntaway/contracts"
import { FAKE_SSH } from "@huntaway/testing"
import { httpRpcClientLayer } from "../../src/cli/rpc.ts"
import { e2eDataDir, startServer } from "./launch.ts"

// Hosts (docs/plan/08-hosts.md), whole servers through the launcher: a hub links a host by URL and token and keeps a
// connection to it; a client of the hub reaches the host's board through the relay, with the hub's token on its
// requests and the session the hub sealed for it; forgetting the link ends it.

const BoardRpcs = PublicRpcs.merge(HostRpcs, HubRpcs)
const RelayedRpcs = HostRpcs.merge(LinkRpcs)

const SERVE = ["--no-agents", "--no-discovery"]

/** A client of `port`'s own board over HTTP. */
const boardClient = (port: number, token: string) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(httpRpcClientLayer(`http://127.0.0.1:${port}`, token))
    return yield* RpcClient.make(BoardRpcs, { flatten: true }).pipe(Effect.provideContext(context))
  })

/** A client of `host` through `hub`'s relay, as the web app makes one: a new ticket on every connection. */
const relayedClient = (hubPort: number, token: string, ticket: Effect.Effect<string>) =>
  Effect.gen(function* () {
    const url = Effect.map(ticket, (t) => `ws://127.0.0.1:${hubPort}/api/relay/${t}`)
    const context = yield* Layer.build(
      Layer.mergeAll(
        RpcClient.layerProtocolSocket().pipe(
          Layer.provide(Layer.effect(Socket.Socket, Socket.makeWebSocket(url))),
          Layer.provide(NodeWS.layerWebSocketConstructor),
          Layer.provide(RpcSerialization.layerNdjson),
        ),
        RpcMiddleware.layerClient(Auth, ({ next, request }) => next({ ...request, headers: Headers.set(request.headers, "authorization", `Bearer ${token}`) })),
      ),
    )
    return yield* RpcClient.make(RelayedRpcs, { flatten: true }).pipe(Effect.provideContext(context))
  })

/** A port on 127.0.0.1 nothing listens on now. */
const freePort = Effect.scoped(
  Effect.map(NodeSocketServer.make({ port: 0, host: "127.0.0.1" }), (server) => (server.address._tag === "UnixPathAddress" ? 0 : server.address.port)),
).pipe(Effect.orDie)

/** A process's output, whole. */
const text = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (all, chunk) => all + chunk,
    ),
  )

/** A process's stdout, stderr and exit code, once it ends. */
const output = (child: ChildProcessSpawner.ChildProcessHandle) =>
  Effect.all([text(child.stdout), text(child.stderr), child.exitCode], { concurrency: 3 }).pipe(Effect.orDie)

const SshHostLine = Schema.fromJsonString(
  Schema.Struct({ token: Schema.String, started: Schema.Boolean, port: Schema.Int, info: Schema.Struct({ host_id: Schema.String }) }),
)

/** The hub's directory once `ready` holds for it. */
const until = <E>(hosts: Stream.Stream<ReadonlyArray<Host>, E>, ready: (hosts: ReadonlyArray<Host>) => boolean) =>
  hosts.pipe(
    Stream.filter(ready),
    Stream.runHead,
    Effect.orDie,
    Effect.map(Option.getOrThrow),
    Effect.timeoutOrElse({ duration: "20 seconds", orElse: () => Effect.die("the hub's hosts never got there") }),
  )

describe("hosts, whole servers", () => {
  it.live(
    "a hub links a host by URL and token, a client reaches the host's board through the relay, and forgetting the link ends it",
    () =>
      Effect.gen(function* () {
        const hub = yield* startServer(SERVE)
        const host = yield* startServer(SERVE)
        const board = yield* boardClient(hub.port, hub.token)
        const hostInfo = yield* (yield* boardClient(host.port, host.token))("host.info", undefined)

        // A wrong token is refused before anything is stored.
        const wrong = yield* Effect.exit(board("hub.hosts.add", { url: `http://127.0.0.1:${host.port}`, token: "nope" }))
        assert.isTrue(Exit.isFailure(wrong))
        assert.strictEqual((yield* board("hub.hosts.list", undefined)).length, 1)

        const added = yield* board("hub.hosts.add", { url: `http://127.0.0.1:${host.port}/`, token: host.token })
        assert.strictEqual(added.id, hostInfo.host_id)
        assert.strictEqual(added.url, `http://127.0.0.1:${host.port}`)
        const linked = yield* until(board("hub.hosts.watch", undefined), (hosts) => hosts.some((h) => h.id === hostInfo.host_id && h.connected))
        const entry = linked.find((h) => h.id === hostInfo.host_id)
        assert.strictEqual(entry?.mode, "outbound")
        assert.strictEqual(entry?.status, "connected")
        assert.strictEqual(entry?.version, hostInfo.version)
        assert.isTrue(linked[0]?.local)

        // Through the relay: the host's own board, with the hub's token on each request.
        const ticket = Effect.map(board("hub.hosts.openRelay", { host_id: hostInfo.host_id }), (r) => r.ticket).pipe(Effect.orDie)
        const relayed = yield* relayedClient(hub.port, hub.token, ticket)
        assert.strictEqual((yield* relayed("host.info", undefined)).host_id, hostInfo.host_id)
        const profiles = yield* relayed("profiles.list", undefined)
        assert.isArray(profiles)
        // The relayed session never has `link`.
        const asLink = yield* Effect.exit(
          relayed("link.hello", {
            host_id: hostInfo.host_id,
            name: "x",
            protocol: 1,
            version: "x",
            capabilities: [],
            commit: null,
            agents: false,
            updates_from: null,
          }),
        )
        assert.isTrue(Exit.isFailure(asLink))

        // A ticket is used once.
        const once = yield* board("hub.hosts.openRelay", { host_id: hostInfo.host_id })
        const first = yield* relayedClient(hub.port, hub.token, Effect.succeed(once.ticket))
        assert.strictEqual((yield* first("host.info", undefined)).host_id, hostInfo.host_id)

        yield* board("hub.hosts.update", { id: LinkId.make(added.id), name: "renamed", uplink: true })
        const renamed = (yield* board("hub.hosts.list", undefined)).find((h) => h.id === hostInfo.host_id)
        assert.strictEqual(renamed?.name, "renamed")
        assert.isTrue(renamed?.uplink)

        yield* board("hub.hosts.remove", { id: LinkId.make(added.id) })
        assert.strictEqual((yield* board("hub.hosts.list", undefined)).length, 1)
        const gone = yield* Effect.exit(board("hub.hosts.openRelay", { host_id: hostInfo.host_id }))
        assert.isTrue(Exit.isFailure(gone))
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    60_000,
  )

  it.live(
    "a host dials in with the hub token; a second one under its id is refused while it is connected",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const hub = yield* startServer(SERVE)
        const hubToken = (yield* fs.readFileString(`${hub.dataDir}/hub_token`)).trim()
        const dialIn = ["--hub", `http://127.0.0.1:${hub.port}`, "--hub-token", hubToken]
        const host = yield* startServer([...SERVE, ...dialIn])
        const hostInfo = yield* (yield* boardClient(host.port, host.token))("host.info", undefined)
        const board = yield* boardClient(hub.port, hub.token)
        const linked = yield* until(board("hub.hosts.watch", undefined), (hosts) => hosts.some((h) => h.id === hostInfo.host_id && h.connected))
        assert.strictEqual(linked.find((h) => h.id === hostInfo.host_id)?.mode, "inbound")

        // The hub reaches it through sockets it opens back to the hub: the relay, and the hub's own client.
        const ticket = Effect.map(board("hub.hosts.openRelay", { host_id: hostInfo.host_id }), (r) => r.ticket).pipe(Effect.orDie)
        const relayed = yield* relayedClient(hub.port, hub.token, ticket)
        assert.strictEqual((yield* relayed("host.info", undefined)).host_id, hostInfo.host_id)
        assert.isArray(yield* relayed("profiles.list", undefined))

        // Another server claiming its id (its data folder has the same host_id) is refused while it is connected.
        const twin = yield* e2eDataDir
        yield* fs.writeFileString(`${twin}/host_id`, `${hostInfo.host_id}\n`)
        const impostor = yield* startServer([...SERVE, ...dialIn], {}, twin)
        const refused = yield* impostor.log.pipe(
          Effect.repeat({ until: (log) => log.includes("is already connected to this hub"), schedule: Schedule.spaced("100 millis"), times: 100 }),
        )
        assert.include(refused, "is already connected to this hub")
        assert.strictEqual((yield* board("hub.hosts.list", undefined)).filter((h) => h.id === hostInfo.host_id).length, 1)

        // A wrong hub token gets nowhere.
        const stranger = yield* startServer([...SERVE, "--hub", `http://127.0.0.1:${hub.port}`, "--hub-token", "wrong"])
        const strangerId = (yield* (yield* boardClient(stranger.port, stranger.token))("host.info", undefined)).host_id
        assert.isFalse((yield* board("hub.hosts.list", undefined)).some((h) => h.id === strangerId))
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    60_000,
  )

  it.live(
    "a host the hub dials as a profile's assistant host can't be stood in for by one dialling in under its id",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const hub = yield* startServer(SERVE)
        const hubToken = (yield* fs.readFileString(`${hub.dataDir}/hub_token`)).trim()
        const host = yield* startServer(SERVE)
        const hostInfo = yield* (yield* boardClient(host.port, host.token))("host.info", undefined)
        const board = yield* boardClient(hub.port, hub.token)
        yield* board("hub.hosts.add", { url: `http://127.0.0.1:${host.port}`, token: host.token })
        yield* until(board("hub.hosts.watch", undefined), (hosts) => hosts.some((h) => h.id === hostInfo.host_id && h.connected))
        const profile = yield* board("profiles.create", { profile: { name: "Me" } })
        yield* board("profiles.update", { id: profile.id, patch: { assistant_host: LinkId.make(hostInfo.host_id) } })

        // The dialled host goes; another dials in under its id, and is refused even though the link is down.
        yield* host.process.kill({ killSignal: "SIGKILL" })
        yield* until(board("hub.hosts.watch", undefined), (hosts) => hosts.some((h) => h.id === hostInfo.host_id && !h.connected))
        const twin = yield* e2eDataDir
        yield* fs.writeFileString(`${twin}/host_id`, `${hostInfo.host_id}\n`)
        const impostor = yield* startServer([...SERVE, "--hub", `http://127.0.0.1:${hub.port}`, "--hub-token", hubToken], {}, twin)
        const log = yield* impostor.log.pipe(
          Effect.repeat({ until: (said) => said.includes("isn't taken for it"), schedule: Schedule.spaced("100 millis"), times: 100 }),
        )
        assert.include(log, "links assistant host")
        assert.isFalse((yield* board("hub.hosts.list", undefined)).some((h) => h.id === hostInfo.host_id && h.connected))
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    60_000,
  )

  it.live(
    "a hub links a host over SSH: the forced command gives its token, and the hub follows it through a tunnel",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const host = yield* startServer(SERVE)
        const hostInfo = yield* (yield* boardClient(host.port, host.token))("host.info", undefined)
        const log = `${host.dataDir}/fake-ssh.log`
        const hub = yield* startServer(SERVE, {
          HUNTAWAY_SSH_BIN: FAKE_SSH,
          FAKE_SSH_PORT: String(host.port),
          FAKE_SSH_DATA_DIR: host.dataDir,
          FAKE_SSH_LOG: log,
        })
        const board = yield* boardClient(hub.port, hub.token)

        const bad = yield* Effect.exit(board("hub.hosts.addSsh", { target: "-oProxyCommand=evil" }))
        assert.isTrue(Exit.isFailure(bad))
        assert.isFalse(yield* fs.exists(log), "ssh never ran for a target that starts with -")

        assert.include((yield* board("hub.hosts.sshKey", undefined)).public_key, "ssh-ed25519")
        const added = yield* board("hub.hosts.addSsh", { target: "me@there", ssh_port: 2222, remote_port: host.port })
        assert.strictEqual(added.id, hostInfo.host_id)
        const linked = yield* until(board("hub.hosts.watch", undefined), (hosts) => hosts.some((h) => h.id === hostInfo.host_id && h.connected))
        const entry = linked.find((h) => h.id === hostInfo.host_id)
        assert.strictEqual(entry?.mode, "ssh")
        assert.strictEqual(entry?.url, "ssh://me@there")

        const ticket = Effect.map(board("hub.hosts.openRelay", { host_id: hostInfo.host_id }), (r) => r.ticket).pipe(Effect.orDie)
        const relayed = yield* relayedClient(hub.port, hub.token, ticket)
        assert.strictEqual((yield* relayed("host.info", undefined)).host_id, hostInfo.host_id)

        // ssh was run as the specification says: the hub's key, its own known_hosts, batch mode, the port given.
        const calls = (yield* fs.readFileString(log)).trim().split("\n")
        const first = calls[0] ?? ""
        for (const part of [
          "IdentitiesOnly=yes",
          "BatchMode=yes",
          "StrictHostKeyChecking=accept-new",
          "UserKnownHostsFile=",
          '"-p","2222"',
          '"me@there","link"',
        ])
          assert.include(first, part)
        assert.isTrue(calls.some((call) => call.includes("ExitOnForwardFailure=yes") && call.includes(`:127.0.0.1:${host.port}`)))
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    60_000,
  )

  // The old ssh.test.ts's ssh-host cases. HA-278: ssh-host never starts a host, and a hub adding one (`link`) is told at
  // once that none runs. HA-271: otherwise it waits for one that is restarting (an Update), so the hub reconnects
  // without a failure for each restart.
  it.live(
    "ssh-host says at once that no host runs when one is being added, and otherwise waits for one that comes back",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const bin = yield* path.fromFileUrl(new URL("../../bin/huntaway", import.meta.url))
        const dataDir = yield* e2eDataDir
        const port = yield* freePort
        const sshHost = (original: string) =>
          spawner.spawn(
            ChildProcess.make(bin, ["ssh-host", "--port", String(port), "--data-dir", dataDir], { env: { SSH_ORIGINAL_COMMAND: original }, extendEnv: true }),
          )

        const [, refused, code] = yield* output(yield* sshHost("link"))
        assert.notStrictEqual(Number(code), 0)
        assert.include(refused, "no host is running on port")

        // Started before the host: it waits, and answers once the host is up.
        const waiting = yield* sshHost("ensure")
        const host = yield* startServer([...SERVE, "--port", String(port)], {}, dataDir)
        const [printed, , ok] = yield* output(waiting)
        assert.strictEqual(Number(ok), 0)
        const line = yield* Schema.decodeEffect(SshHostLine)(printed.trim())
        assert.strictEqual(line.token, host.token)
        assert.strictEqual(line.started, false)
        assert.strictEqual(line.port, port)
        assert.isString(line.info.host_id)
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    60_000,
  )
})
