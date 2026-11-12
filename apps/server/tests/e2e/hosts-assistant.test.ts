import { NodeServices } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Schedule, Stream } from "effect"
import { RpcClient } from "effect/rpc"
import { SqlClient } from "effect/sql"
import { HostRpcs, HubRpcs, LinkId, PublicRpcs } from "@huntaway/contracts"
import type { Host } from "@huntaway/contracts"
import { ensureShim, FAKE_CLAUDE } from "@huntaway/testing"
import { httpRpcClientLayer } from "../../src/cli/rpc.ts"
import { startServer } from "./launch.ts"

// A profile's assistant on a host of its own, on whole servers linked over real sockets (docs/plan/08-hosts.md, As
// built HE-8; plan task 7.4; the old agent/assistant/tests.test.ts `the_hub_sends_a_profiles_assistant_to_its_host` and
// `a_message_to_the_assistant_goes_to_its_host`): the hub sends `assistant.get` and `assistant.send` for a profile whose
// assistant runs on a linked host to that host's profile of the same name, asking for its own there, so the assistant
// is made and talked to there and never on the hub. The host's agent is the fake claude, so a message starts a run.
//
// Dropped from the old cases: the hub's REST proxy (`/api/h/<host>/tasks/<id>`), which a relayed session replaced; a
// host on an older build (no host of another protocol links: 14-dropped-and-open.md).

const BoardRpcs = PublicRpcs.merge(HostRpcs, HubRpcs)

interface Server {
  readonly port: number
  readonly token: string
  readonly dataDir: string
}

const boardClient = (s: Server) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(httpRpcClientLayer(`http://127.0.0.1:${s.port}`, s.token))
    return yield* RpcClient.make(BoardRpcs, { flatten: true }).pipe(Effect.provideContext(context))
  })

/** A server's directory once `ready` holds for it. */
const until = <E>(hosts: Stream.Stream<ReadonlyArray<Host>, E>, ready: (hosts: ReadonlyArray<Host>) => boolean) =>
  hosts.pipe(
    Stream.filter(ready),
    Stream.runHead,
    Effect.orDie,
    Effect.map(Option.getOrThrow),
    Effect.timeoutOrElse({ duration: "20 seconds", orElse: () => Effect.die("the hosts never got there") }),
  )

/** How many assistants `s`'s database has. */
const assistants = (s: Server) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM tasks WHERE task_type = 'assistant'`
    return rows[0]?.n ?? 0
  }).pipe(Effect.provide(SqliteClient.layer({ filename: `${s.dataDir}/board.db`, busyTimeout: "5 seconds" })), Effect.orDie)

const shim = ensureShim()

describe.skipIf(shim === null)("the assistant on a host of its own, whole servers", () => {
  it.live(
    "the hub sends a profile's assistant to its host, and the user's messages with it",
    () =>
      Effect.gen(function* () {
        const hub = yield* startServer(["--no-agents", "--no-discovery"])
        const host = yield* startServer(["--no-discovery", "--claude-bin", FAKE_CLAUDE])
        const onHub = yield* boardClient(hub)
        const onHost = yield* boardClient(host)
        const hubId = (yield* onHub("host.info", undefined)).host_id
        const hostId = LinkId.make((yield* onHost("host.info", undefined)).host_id)
        yield* onHub("hub.hosts.add", { url: `http://127.0.0.1:${host.port}`, token: host.token })
        yield* onHub("hub.hosts.update", { id: hostId, name: "homeserver" })
        yield* until(onHub("hub.hosts.watch", undefined), (hosts) => hosts.some((h) => String(h.id) === hostId && h.connected))
        const personal = yield* onHub("profiles.create", { profile: { name: "personal" } })
        yield* onHub("profiles.update", { id: personal.id, patch: { assistant_host: hostId } })

        // The host has no personal profile yet.
        const none = yield* Effect.flip(onHub("assistant.get", { profile_id: personal.id }))
        assert.strictEqual(none._tag === "Conflict" ? none.reason : none._tag, "no_profile")
        assert.include(none._tag === "Conflict" ? none.detail : "", "homeserver has no profile named personal")
        const there = yield* onHost("profiles.create", { profile: { name: "personal" } })

        // Its own profile's, on that host, which says so; none is made on the hub.
        const a = yield* onHub("assistant.get", { profile_id: personal.id })
        assert.deepStrictEqual([a.host_id, a.task_type, a.profile_id], [hostId, "assistant", there.id])
        assert.strictEqual((yield* onHost("tasks.get", { id: a.id })).id, a.id)
        assert.strictEqual(yield* assistants(hub), 0)

        // A host's profile that names the hub as its assistant's host doesn't send it back.
        yield* onHost("hub.hosts.add", { url: `http://127.0.0.1:${hub.port}`, token: hub.token })
        yield* onHost("profiles.update", { id: there.id, patch: { assistant_host: LinkId.make(hubId) } })
        assert.strictEqual((yield* onHub("assistant.get", { profile_id: personal.id })).id, a.id)
        assert.strictEqual(yield* assistants(hub), 0)

        // The user's message goes to it there, and its agent answers there.
        const sent = yield* onHub("assistant.send", { profile_id: personal.id, text: "Remind me at 5" })
        assert.deepStrictEqual([sent.id, sent.host_id], [a.id, hostId])
        const replied = yield* onHost("threads.page", { task_id: a.id, before: Number.MAX_SAFE_INTEGER, limit: 50 }).pipe(
          Effect.map((page) => page.items.some((i) => i.type === "assistant_message" && i.text.includes("Remind me at 5"))),
          Effect.repeat({ until: (done) => done, schedule: Schedule.spaced("100 millis"), times: 100 }),
        )
        assert.isTrue(replied)

        // Asked for the hub's own (`here`), it's the hub's.
        const own = yield* onHub("assistant.get", { profile_id: personal.id, here: true })
        assert.strictEqual(own.host_id, hubId)
        assert.strictEqual(yield* assistants(hub), 1)

        // Offline: says so, rather than using the hub's.
        yield* host.process.kill({ killSignal: "SIGKILL" })
        yield* until(onHub("hub.hosts.watch", undefined), (hosts) => hosts.some((h) => String(h.id) === hostId && !h.connected))
        for (const e of [
          yield* Effect.flip(onHub("assistant.get", { profile_id: personal.id })),
          yield* Effect.flip(onHub("assistant.send", { profile_id: personal.id, text: "hello" })),
        ]) {
          assert.strictEqual(e._tag === "Unavailable" ? e.reason : e._tag, "personal's assistant runs on homeserver, which is offline")
        }
        // Without the setting, it's the hub's own.
        yield* onHub("profiles.update", { id: personal.id, patch: { assistant_host: null } })
        assert.strictEqual((yield* onHub("assistant.get", { profile_id: personal.id })).id, own.id)
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    60_000,
  )
})
