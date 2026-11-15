import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { AgentConfigId, Timestamp } from "@huntaway/contracts"
import { TestPlatform, tempDir } from "@huntaway/testing"
import { AgentConfigRepo } from "../profiles/AgentConfigRepo.ts"
import { LABEL, NAME_PREFIX } from "./containers.ts"
import type { Inspected } from "./containers.ts"
import { Docker, DockerError } from "./Docker.ts"
import { Spaces } from "./Spaces.ts"

// Spaces (HE-35) on a fake Docker, which keeps its containers in memory and the files written into them, and a fake
// spacesd behind the HTTP client, which answers its health check and gives a viewer ticket. Never this machine's Docker.

interface FakeDocker {
  readonly images: Set<string>
  readonly containers: Map<string, Inspected>
  /** What each container was given in its home: its path, and its contents. */
  readonly files: Map<string, Map<string, string>>
  readonly calls: Array<string>
  /** Fails `docker run` with this, when set. */
  runFails: string | null
}

const fake: FakeDocker = { images: new Set(), containers: new Map(), files: new Map(), calls: [], runFails: null }

const flag = (args: ReadonlyArray<string>, name: string) => args.flatMap((a, i) => (a === name ? [args[i + 1] ?? ""] : []))

const FakeDockerLive = Layer.succeed(
  Docker,
  Docker.of({
    version: Effect.succeed({ version: "29.0.0" }),
    list: (hostId) =>
      Effect.succeed(
        [...fake.containers.values()]
          .filter((c) => c.Config.Labels?.[LABEL.host] === hostId)
          .map((container) => ({ container, status: container.State.Status === "running" ? "Up 1 second" : "Exited (0)" })),
      ),
    inspect: (name) => Effect.succeed(fake.containers.get(name) ?? null),
    imageExists: (ref) => Effect.succeed(fake.images.has(ref)),
    pull: (ref) => Effect.sync(() => (fake.calls.push(`pull ${ref}`), fake.images.add(ref))),
    build: (tag) => Effect.sync(() => (fake.calls.push(`build ${tag}`), fake.images.add(tag))),
    run: (args) =>
      Effect.gen(function* () {
        if (fake.runFails !== null) return yield* new DockerError({ reason: fake.runFails })
        const name = flag(args, "--name")[0] ?? ""
        const labels = Object.fromEntries(flag(args, "--label").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]))
        fake.containers.set(name, {
          Name: `/${name}`,
          State: { Status: "running" },
          Config: { Image: args.at(-1) ?? "", Env: flag(args, "--env"), Labels: labels },
          NetworkSettings: { Ports: { "3211/tcp": [{ HostIp: "127.0.0.1", HostPort: "40001" }] } },
        })
        return name
      }),
    start: (name) => Effect.sync(() => fake.calls.push(`start ${name}`)),
    stop: (name) =>
      Effect.sync(() => {
        const c = fake.containers.get(name)
        if (c !== undefined) fake.containers.set(name, { ...c, State: { Status: "exited" } })
      }),
    remove: (name) => Effect.sync(() => fake.containers.delete(name)),
    exec: (name, _user, argv, options = {}) =>
      Effect.sync(() => {
        const files = fake.files.get(name) ?? new Map<string, string>()
        files.set(argv.at(-1) ?? "", options.stdin ?? "")
        fake.files.set(name, files)
        return { code: 0, stdout: "", stderr: "" }
      }),
  }),
)

/** spacesd: healthy, and a viewer ticket `v1.tick` in a gRPC-Web answer. */
const fakeSpacesd = HttpClient.make((request, url) =>
  Effect.sync(() => {
    if (url.pathname === "/health") return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }))
    const ticket = [...new TextEncoder().encode("v1.tick")]
    const message = [0x0a, ticket.length, ...ticket]
    return HttpClientResponse.fromWeb(request, new Response(Uint8Array.from([0, 0, 0, 0, message.length, ...message]), { status: 200 }))
  }),
)

const TestSpaces = Spaces.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(FakeDockerLive, AgentConfigRepo.layer, Layer.succeed(HttpClient.HttpClient, fakeSpacesd))),
  Layer.provideMerge(TestPlatform()),
)

let configs = 0
/** A Claude Code config on a folder with a sign-in in it. */
const claudeConfig = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const dir = yield* tempDir
  yield* fs.writeFileString(`${dir}/.credentials.json`, '{"claudeAiOauth":{"accessToken":"at","refreshToken":"rt"}}').pipe(Effect.orDie)
  const id = AgentConfigId.make(`cfg-${++configs}`)
  yield* (yield* AgentConfigRepo).insert(id, Timestamp.make("2026-11-15T00:00:00.000Z"), { name: "work", config_dir: dir, agent: "claude" })
  return id
})

describe("Spaces", () => {
  it.effect("makes a Space: builds the image once, runs it, and gives it the config's sign-in without its refresh token", () =>
    Effect.gen(function* () {
      const spaces = yield* Spaces
      const config = yield* claudeConfig
      const made = yield* spaces.create({ name: " Tests ", claude_config_id: config })
      assert.strictEqual(made.state, "preparing")
      assert.strictEqual(made.name, "Tests")
      assert.strictEqual((yield* spaces.settled(made.id)).state, "running")
      assert.deepStrictEqual(fake.calls.slice(0, 2), ["pull ghcr.io/trycua/linux:24.04", `build ${made.image}`])

      const listed = (yield* spaces.status).spaces.find((s) => s.id === made.id)
      assert.strictEqual(listed?.state, "running")
      assert.strictEqual(listed?.claude_config_id, config)
      const files = fake.files.get(`${NAME_PREFIX}${made.id}`)
      assert.include(files?.get(".claude/.credentials.json") ?? "", '"accessToken": "at"')
      assert.notInclude(files?.get(".claude/.credentials.json") ?? "", "rt")

      // The second doesn't pull or build again.
      yield* spaces.settled((yield* spaces.create({ name: "Two", claude_config_id: config })).id)
      assert.strictEqual(fake.calls.filter((c) => c.startsWith("pull") || c.startsWith("build")).length, 2)
    }).pipe(Effect.provide(TestSpaces)),
  )

  it.effect("gives a viewer a relay ticket for the Space's port, until the Space is deleted", () =>
    Effect.gen(function* () {
      const spaces = yield* Spaces
      const config = yield* claudeConfig
      const made = yield* spaces.create({ name: "View me", claude_config_id: config })
      yield* spaces.settled(made.id)

      const view = yield* spaces.view(made.id, true)
      assert.strictEqual(view.fragment, "#ticket=v1.tick")
      assert.isNull(view.direct_port)
      const ticket = view.relay_path.split("/")[4] ?? ""
      assert.deepStrictEqual(yield* spaces.relayTarget(ticket), { id: made.id, port: 40001 })
      assert.isNull(yield* spaces.relayTarget("nope"))

      yield* spaces.remove(made.id)
      assert.isNull(yield* spaces.relayTarget(ticket))
      assert.strictEqual((yield* Effect.flip(spaces.view(made.id, true)))._tag, "NotFound")
    }).pipe(Effect.provide(TestSpaces)),
  )

  it.effect("refuses a bad name or a config of the other agent, and shows why a Space failed", () =>
    Effect.gen(function* () {
      const spaces = yield* Spaces
      const config = yield* claudeConfig
      assert.strictEqual((yield* Effect.flip(spaces.create({ name: " " })))._tag, "Invalid")
      const wrong = yield* Effect.flip(spaces.create({ name: "x", codex_config_id: config }))
      assert.deepStrictEqual(wrong._tag === "Invalid" ? wrong.field : null, "codex_config_id")
      assert.strictEqual((yield* Effect.flip(spaces.create({ name: "x", claude_config_id: AgentConfigId.make("gone") })))._tag, "NotFound")

      fake.runFails = "docker run: no space left on device"
      const made = yield* spaces.create({ name: "Doomed" })
      const failed = yield* spaces.settled(made.id)
      fake.runFails = null
      assert.strictEqual(failed.state, "failed")
      assert.strictEqual(failed.detail, "docker run: no space left on device")
      yield* spaces.remove(made.id)
      assert.isUndefined((yield* spaces.status).spaces.find((x) => x.id === made.id))
    }).pipe(Effect.provide(TestSpaces)),
  )
})
