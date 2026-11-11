import { NodeServices } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option, Schema, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { RpcClient } from "effect/rpc"
import { SqlClient } from "effect/sql"
import { createHmac } from "node:crypto"
import { HostRpcs, HubRpcs, LinkId, PublicRpcs } from "@huntaway/contracts"
import type { Host, ProfileId } from "@huntaway/contracts"
import { httpRpcClientLayer } from "../../src/cli/rpc.ts"
import { startServer } from "./launch.ts"

// Board tools across hosts on whole servers (docs/plan/08-hosts.md, Board tools across hosts; plan task 7.4): an agent
// on the hub finds a task on a host it links; an agent on the host (its profile's assistant host) uses the hub's board
// once the hub lets it, both when the hub dialled the host (the call goes up on `link.upcalls`) and when the host dialled
// in (it calls the hub's `tools.call`). Each agent is a run put straight into its server's database, calling the board's
// MCP server over HTTP as boardTools.test.ts does.

const BoardRpcs = PublicRpcs.merge(HostRpcs, HubRpcs)
const SERVE = ["--no-agents", "--no-discovery"]
const AT = "2026-11-12T00:00:00.000Z"

const Response = Schema.Struct({
  id: Schema.Finite,
  result: Schema.Struct({ content: Schema.optional(Schema.Array(Schema.Struct({ text: Schema.String }))), isError: Schema.optional(Schema.Boolean) }),
})
const Answer = Schema.fromJsonString(Response)
const Found = Schema.fromJsonString(Schema.Struct({ key: Schema.String, title: Schema.String, host: Schema.String }))

/** The last event's data of an event stream, or the body as it is for a JSON answer. */
const lastData = (text: string) => {
  const data = text.split("\n").findLast((l) => l.startsWith("data:") && l.trim() !== "data:")
  return data === undefined ? text : data.slice("data:".length).trim()
}

interface Server {
  readonly port: number
  readonly token: string
  readonly dataDir: string
}

/** A client of a server's own board. */
const boardClient = (s: Server) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(httpRpcClientLayer(`http://127.0.0.1:${s.port}`, s.token))
    return yield* RpcClient.make(BoardRpcs, { flatten: true }).pipe(Effect.provideContext(context))
  })

/** A profile named `name` with a project (key `key`) holding one task, `title`, on `s`'s board; the profile. */
const boardWith = (s: Server, name: string, key: string, title: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const board = yield* boardClient(s)
    const profile = yield* board("profiles.create", { profile: { name } })
    const folder = `${s.dataDir}/${key.toLowerCase()}`
    yield* fs.makeDirectory(folder, { recursive: true })
    const project = yield* board("projects.create", { project: { profile_id: profile.id, name: key.toLowerCase(), key, repo_path: folder } })
    yield* board("tasks.create", { task: { project_id: project.id, title, use_worktree: false, start: false } })
    return profile
  })

/**
 * An agent of `profile` on `s`: a run of a thread of its, put into the server's database (as boardTools.test.ts), and
 * its board tool calls over the run's MCP server: the tool's answer's text, and whether it is an error.
 */
const agentOn = (s: Server, profile: ProfileId, run: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO tasks (id, profile_id, title, status, task_type, number, running, last_activity_at, created_at, updated_at)
        VALUES (${`${run}-task`}, ${profile}, 'The caller', 'in_progress', 'scratch', 1, 1, ${AT}, ${AT}, ${AT})`
      yield* sql`INSERT INTO runs (id, task_id, kind, status, created_at) VALUES (${run}, ${`${run}-task`}, 'prompt', 'running', ${AT})`
    }).pipe(Effect.provide(SqliteClient.layer({ filename: `${s.dataDir}/board.db`, busyTimeout: "5 seconds" })), Effect.orDie)
    yield* fs.makeDirectory(`${s.dataDir}/runs/${run}`, { recursive: true })
    yield* fs.writeFileString(`${s.dataDir}/runs/${run}/mcp-run.json`, '{"cwd":"/tmp","github_account":null,"review":false,"in_process":false,"desktop":false}')
    const client = yield* HttpClient.HttpClient
    const headers = {
      authorization: `Bearer ${createHmac("sha256", s.token).update(`mcp:${run}`).digest("hex")}`,
      accept: "application/json, text/event-stream",
    }
    let id = 0
    return (name: string, args: unknown) =>
      Effect.gen(function* () {
        id += 1
        const request = HttpClientRequest.post(`http://127.0.0.1:${s.port}/api/mcp/${run}/huntaway`).pipe(
          HttpClientRequest.setHeaders(headers),
          HttpClientRequest.bodyJsonUnsafe({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
        )
        const answer = yield* Schema.decodeEffect(Answer)(lastData(yield* (yield* client.execute(request)).text))
        return { text: answer.result.content?.[0]?.text ?? "", error: answer.result.isError === true }
      }).pipe(Effect.orDie)
  })

/** The hub's directory once `ready` holds for it. */
const until = <E>(hosts: Stream.Stream<ReadonlyArray<Host>, E>, ready: (hosts: ReadonlyArray<Host>) => boolean) =>
  hosts.pipe(
    Stream.filter(ready),
    Stream.runHead,
    Effect.orDie,
    Effect.map(Option.getOrThrow),
    Effect.timeoutOrElse({ duration: "20 seconds", orElse: () => Effect.die("the hub's hosts never got there") }),
  )

describe("board tools across hosts, whole servers", () => {
  it.live(
    "a hub's agent finds a task on the host it dials, and the host's assistant uses the hub's board once it may",
    () =>
      Effect.gen(function* () {
        const hub = yield* startServer(SERVE, {}, undefined)
        const host = yield* startServer(SERVE)
        const board = yield* boardClient(hub)
        const hostId = (yield* (yield* boardClient(host))("host.info", undefined)).host_id
        yield* board("hub.hosts.add", { url: `http://127.0.0.1:${host.port}`, token: host.token })
        yield* until(board("hub.hosts.watch", undefined), (hosts) => hosts.some((h) => h.id === hostId && h.connected))
        const onHub = yield* boardWith(hub, "personal", "HUB", "On the hub")
        const onHost = yield* boardWith(host, "personal", "LAP", "On the host")

        // Down: the hub's agent names the host's task.
        const hubAgent = yield* agentOn(hub, onHub.id, "hub-run")
        const found = yield* hubAgent("get_task", { task_id: "LAP-1" })
        assert.isFalse(found.error, found.text)
        const task = yield* Schema.decodeEffect(Found)(found.text)
        assert.deepStrictEqual([task.key, task.title], ["LAP-1", "On the host"])
        const listed = yield* hubAgent("list_projects", {})
        assert.include(listed.text, '"LAP"')
        assert.include(listed.text, '"HUB"')

        // Up: off until the hub lets the host's agents in, and only for the profile whose assistant runs there.
        const hostAgent = yield* agentOn(host, onHost.id, "host-run")
        const off = yield* hostAgent("get_task", { task_id: "HUB-1" })
        assert.isTrue(off.error)
        assert.include(off.text, "doesn't let this host's agents use its board")
        yield* board("hub.hosts.update", { id: LinkId.make(hostId), uplink: true })
        const notPlaced = yield* hostAgent("get_task", { task_id: "HUB-1" })
        assert.include(notPlaced.text, "personal isn't one")
        yield* board("profiles.update", { id: onHub.id, patch: { assistant_host: LinkId.make(hostId) } })
        const up = yield* hostAgent("get_task", { task_id: "HUB-1" })
        assert.isFalse(up.error, up.text)
        assert.strictEqual((yield* Schema.decodeEffect(Found)(up.text)).title, "On the hub")
        // A thread tool for a task on the hub stays on the host.
        assert.include((yield* hostAgent("wait", { reason: "r", tasks: ["HUB-1"] })).text, "not found on this host")
      }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
    60_000,
  )

  it.live(
    "a host that dialled in passes its assistant's calls up on its own connection, and the hub takes no other",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const hub = yield* startServer(SERVE)
        const hubToken = (yield* fs.readFileString(`${hub.dataDir}/hub_token`)).trim()
        const host = yield* startServer([...SERVE, "--hub", `http://127.0.0.1:${hub.port}`, "--hub-token", hubToken])
        const board = yield* boardClient(hub)
        const hostId = (yield* (yield* boardClient(host))("host.info", undefined)).host_id
        yield* until(board("hub.hosts.watch", undefined), (hosts) => hosts.some((h) => h.id === hostId && h.connected))
        const onHub = yield* boardWith(hub, "personal", "HUB", "On the hub")
        const onHost = yield* boardWith(host, "personal", "LAP", "On the host")
        yield* board("hub.hosts.update", { id: LinkId.make(hostId), uplink: true })
        yield* board("profiles.update", { id: onHub.id, patch: { assistant_host: LinkId.make(hostId) } })

        const hostAgent = yield* agentOn(host, onHost.id, "host-run")
        const up = yield* hostAgent("get_task", { task_id: "HUB-1" })
        assert.isFalse(up.error, up.text)
        assert.strictEqual((yield* Schema.decodeEffect(Found)(up.text)).title, "On the hub")
        // It creates a task there, once however it is delivered.
        const made = yield* hostAgent("create_task", { project_id: "HUB", title: "From the host", start: false })
        assert.isFalse(made.error, made.text)
        assert.include((yield* hostAgent("list_tasks", { project_id: "HUB" })).text, "From the host")
        // And the hub's agent reaches the host's board down the same link.
        const hubAgent = yield* agentOn(hub, onHub.id, "hub-run")
        assert.include((yield* hubAgent("get_task", { task_id: "LAP-1" })).text, "On the host")

        // Anyone else with the hub token, on a connection that didn't attach, is refused whatever it claims.
        const stranger = yield* boardClient({ ...hub, token: hubToken })
        const taken = yield* stranger("tools.call", { profile: "personal", tool: "list_projects", args: {}, call_id: "x", up: true })
        assert.strictEqual(taken._tag, "Off")
        const down = yield* stranger("tools.call", { profile: "personal", tool: "list_projects", args: {}, call_id: null, up: false })
        assert.strictEqual(down._tag, "Off")
      }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
    60_000,
  )
})
