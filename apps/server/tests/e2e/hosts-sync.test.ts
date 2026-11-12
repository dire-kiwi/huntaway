import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option, Path, Stream } from "effect"
import { RpcClient } from "effect/rpc"
import { HostRpcs, HubRpcs, LinkId, PublicRpcs } from "@huntaway/contracts"
import type { Host, HostId, HostSettings } from "@huntaway/contracts"
import { httpRpcClientLayer } from "../../src/cli/rpc.ts"
import { startServer } from "./launch.ts"

// Settings sync and discovery between whole servers (docs/plan/08-hosts.md, Discovery, SSH, settings sync): a hub links
// a host, both switch sync on, and a setting changed on either reaches the other through the hub's exchange; a hub finds
// the hosts its linked hosts link (the mesh), and copies a config's login from one host to another (refused before the
// target is touched when there is nothing to copy). Test servers run with --no-discovery: no mDNS, no Tailscale.

const BoardRpcs = PublicRpcs.merge(HostRpcs, HubRpcs)

const SERVE = ["--no-agents", "--no-discovery"]

/** A client of `port`'s own board over HTTP. */
const boardClient = (port: number, token: string) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(httpRpcClientLayer(`http://127.0.0.1:${port}`, token))
    return yield* RpcClient.make(BoardRpcs, { flatten: true }).pipe(Effect.provideContext(context))
  })
type Board = Effect.Success<ReturnType<typeof boardClient>>

/** The first of `stream` that `ready` holds for, within 20 seconds. */
const until = <A, E>(stream: Stream.Stream<A, E>, ready: (a: A) => boolean, what: string) =>
  stream.pipe(
    Stream.filter(ready),
    Stream.runHead,
    Effect.orDie,
    Effect.map(Option.getOrThrow),
    Effect.timeoutOrElse({ duration: "20 seconds", orElse: () => Effect.die(`never: ${what}`) }),
  )

/** A board's settings once `ready` holds for them, as its stream says. */
const settingsWhen = (board: Board, ready: (s: HostSettings) => boolean, what: string) =>
  until(
    board("board.watch", {}).pipe(Stream.flatMap((m) => (m.type === "snapshot" || m.type === "settings_changed" ? Stream.make(m.settings) : Stream.empty))),
    ready,
    what,
  )

/** Links `host` (at `port` with `token`) from `hub`, and waits until it is connected. */
const linkTo = (hub: Board, port: number, token: string, id: HostId) =>
  Effect.gen(function* () {
    yield* hub("hub.hosts.add", { url: `http://127.0.0.1:${port}`, token })
    return yield* until(hub("hub.hosts.watch", undefined), (hosts: ReadonlyArray<Host>) => hosts.some((h) => h.id === id && h.connected), `${id} connected`)
  })

describe("settings sync and discovery, whole servers", () => {
  it.live(
    "a hub and its host that both sync keep a setting the same, whichever changes it",
    () =>
      Effect.gen(function* () {
        const hubServer = yield* startServer(SERVE)
        const hostServer = yield* startServer(SERVE)
        const hub = yield* boardClient(hubServer.port, hubServer.token)
        const host = yield* boardClient(hostServer.port, hostServer.token)
        const hostInfo = yield* host("host.info", undefined)
        assert.include(hostInfo.capabilities, "settings_sync")
        yield* linkTo(hub, hostServer.port, hostServer.token, hostInfo.host_id)

        // Off on a host: no entries, nothing merged into it.
        assert.deepStrictEqual((yield* host("settingsSync.get", undefined)).entries, [])
        yield* hub("host.updateSettings", { patch: { settings_sync: true } })
        yield* host("host.updateSettings", { patch: { settings_sync: true } })

        yield* host("host.updateSettings", { patch: { default_model: "sonnet" } })
        yield* settingsWhen(hub, (s) => s.default_model === "sonnet", "the hub takes the host's change")

        yield* hub("host.updateSettings", { patch: { default_effort: "max" } })
        yield* settingsWhen(host, (s) => s.default_effort === "max", "the host takes the hub's change")

        const entry = (yield* host("settingsSync.get", undefined)).entries.find((e) => e.name === "global/default_model")
        assert.strictEqual(entry?.value, "sonnet")
        assert.strictEqual(entry?.changed_by, hostInfo.host_id)
        // What belongs to one host stays there.
        yield* host("host.updateSettings", { patch: { public_url: "https://host.example.com" } })
        yield* host("host.updateSettings", { patch: { default_model: "haiku" } })
        const hubSettings = yield* settingsWhen(hub, (s) => s.default_model === "haiku", "the hub takes the next change")
        assert.isNull(hubSettings.public_url)
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    60_000,
  )

  it.live(
    "a hub finds the hosts its linked hosts link, and copies a config's login to one",
    () =>
      Effect.gen(function* () {
        const hubServer = yield* startServer(SERVE)
        const bServer = yield* startServer(SERVE)
        const cServer = yield* startServer(SERVE)
        const hub = yield* boardClient(hubServer.port, hubServer.token)
        const b = yield* boardClient(bServer.port, bServer.token)
        const c = yield* boardClient(cServer.port, cServer.token)
        const hubId = (yield* hub("host.info", undefined)).host_id
        const bId = (yield* b("host.info", undefined)).host_id
        const cId = (yield* c("host.info", undefined)).host_id
        yield* linkTo(hub, bServer.port, bServer.token, bId)
        yield* linkTo(b, cServer.port, cServer.token, cId)
        yield* hub("hub.hosts.update", { id: LinkId.make(bId), name: "bee" })

        // C, linked by B at a URL that answers here as C: found through B; not B itself, nor the hub.
        const found = yield* hub("hub.hosts.discover", undefined)
        assert.isFalse(found.tailscale)
        assert.deepStrictEqual(
          found.hosts.map((h) => [h.host_id, h.url, h.via, h.through, h.linked]),
          [[cId, `http://127.0.0.1:${cServer.port}`, "mesh", "bee", false]],
        )
        assert.strictEqual(found.hosts[0]?.protocol, 1)
        assert.include(found.hosts[0]?.capabilities ?? [], "settings_sync")
        // Once linked here, it is not offered again.
        yield* linkTo(hub, cServer.port, cServer.token, cId)
        assert.deepStrictEqual((yield* hub("hub.hosts.discover", undefined)).hosts, [])

        // A config with nothing to copy, to a host that has none of that name: refused before anything is made there.
        yield* hub("configs.create", { config: { name: "work", config_dir: "/claude/work" } })
        const before = (yield* b("configs.list", undefined)).length
        const empty = yield* Effect.flip(hub("hub.hosts.copyConfig", { from_host: hubId, to_host: bId, config: "work" }))
        assert.strictEqual(empty._tag, "Invalid")
        assert.strictEqual((yield* b("configs.list", undefined)).length, before)
        const missing = yield* Effect.flip(hub("hub.hosts.copyConfig", { from_host: bId, to_host: hubId, config: "work" }))
        assert.strictEqual(missing._tag, "NotFound")

        // One with a login: made on B in the folder given, with its files; again only with overwrite.
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const from = yield* fs.makeTempDirectoryScoped()
        const to = path.join(yield* fs.makeTempDirectoryScoped(), "home")
        yield* fs.writeFileString(path.join(from, ".credentials.json"), '{"token":"t"}')
        yield* fs.writeFileString(path.join(from, "settings.json"), "{}")
        yield* hub("configs.create", { config: { name: "home", config_dir: from } })
        const copied = yield* hub("hub.hosts.copyConfig", { from_host: hubId, to_host: bId, config: "home", config_dir: to })
        assert.deepStrictEqual([...(copied.files ?? [])].toSorted(), [".credentials.json", "settings.json"])
        assert.strictEqual((yield* b("configs.list", undefined)).find((config) => config.name === "home")?.config_dir, to)
        assert.strictEqual(yield* fs.readFileString(path.join(to, ".credentials.json")), '{"token":"t"}')
        const again = yield* Effect.flip(hub("hub.hosts.copyConfig", { from_host: hubId, to_host: bId, config: "home" }))
        assert.strictEqual(again._tag, "Invalid")
        yield* hub("hub.hosts.copyConfig", { from_host: hubId, to_host: bId, config: "home", overwrite: true })
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    60_000,
  )
})
