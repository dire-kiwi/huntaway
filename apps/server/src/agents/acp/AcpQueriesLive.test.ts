import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Result, Schema } from "effect"
import { AgentConfigId, Timestamp } from "@huntaway/contracts"
import { tempDir, TestBoard, TestPlatform } from "@huntaway/testing"
import { AgentConfigRepo } from "../../profiles/AgentConfigRepo.ts"
import type { AgentConfigRow } from "../../profiles/AgentConfigRepo.ts"
import { AgentConfigs } from "../../profiles/AgentConfigs.ts"
import { AcpModelsScript, AcpQueries, AcpUnavailable, ModelListing, modelsFromListing, signInReason } from "../AcpQueries.ts"
import { AcpQueriesLive } from "./AcpQueriesLive.ts"

// An ACP config's models (HE-69): what `acp-run --list-models` prints read as the board's models, the live layer
// against a stand-in launcher (a shell script that records what it was given and prints the listing), and the test
// layer behind `configs.models`.

const config = (fields: Partial<AgentConfigRow> = {}): AgentConfigRow => ({
  id: AgentConfigId.make("g"),
  name: "Gemini",
  config_dir: "~/.gemini-work",
  agent: "acp",
  command: null,
  show_usage: false,
  restart_window: false,
  api_url: null,
  has_api_key: false,
  has_management_key: false,
  created_at: Timestamp.make("2026-11-21T00:00:00.000Z"),
  ...fields,
})

const LISTING =
  '{"models":[{"id":"gemini-3-pro","name":"Gemini 3 Pro","description":"The smartest"},{"id":"gemini-3-flash","name":"Gemini 3 Flash","description":null}],' +
  '"current":"gemini-3-flash","efforts":["low","high"],"default_effort":"high"}'

const MODELS = [
  { id: "gemini-3-pro", name: "Gemini 3 Pro", description: "The smartest", is_default: false, efforts: ["low", "high"], default_effort: "high" },
  { id: "gemini-3-flash", name: "Gemini 3 Flash", description: null, is_default: true, efforts: ["low", "high"], default_effort: "high" },
]

/** A launcher that records its arguments, its folder, GEMINI_HOME and the spec it was given in `<dir>/seen`, then prints `out` and exits `code`. */
const launcher = (dir: string, out: string, code: number) =>
  `#!/bin/sh
{ for a in "$@"; do printf '%s\\n' "[$a]"; done; echo "cwd=$(pwd)"; echo "home=$GEMINI_HOME"; cat "$3"; echo; } >> ${dir}/seen
printf '%s\\n' '${out}'
echo "stderr says why" >&2
exit ${code}
`

const withLauncher = (out: string, code = 0) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* tempDir
    yield* fs.writeFileString(`${dir}/huntaway`, launcher(dir, out, code)).pipe(Effect.orDie)
    yield* fs.chmod(`${dir}/huntaway`, 0o755).pipe(Effect.orDie)
    return dir
  })

const live = (exe: string | null, home: string) =>
  AcpQueriesLive.pipe(Layer.provideMerge(AgentConfigRepo.layer), Layer.provideMerge(TestPlatform({ exe, home })))

/** Why the live layer, with launcher `exe`, can't list an ACP config's models. */
const reason = (exe: string | null) =>
  Effect.gen(function* () {
    const e = yield* Effect.flip((yield* AcpQueries).models(config()))
    return e.reason
  }).pipe(Effect.provide(live(exe, "/home/me")))

describe("AcpQueries", () => {
  it("reads acp-run --list-models' line as the config's models, the current one the default", () => {
    assert.deepStrictEqual(modelsFromListing(`\n${LISTING}\n`), MODELS)
    assert.deepStrictEqual(modelsFromListing('noise\n{"models":[],"current":null,"efforts":[],"default_effort":null}'), [])
    assert.strictEqual(modelsFromListing('{"models":"no"}'), null)
    assert.strictEqual(modelsFromListing(""), null)
    // The contract, as the adapter prints it.
    assert.isTrue(Schema.is(ModelListing)({ models: [{ id: "a", name: "A", description: null }], current: "a", efforts: [], default_effort: null }))
  })

  it("says how to sign in, Antigravity's way or a custom agent's", () => {
    assert.include(signInReason(null), "sign in by running `agy` once")
    assert.include(signInReason("agy acp"), "`agy`")
    assert.include(signInReason("my-agent --acp"), "my-agent isn't signed in")
  })

  it.live("asks the launcher with a spec in a fresh folder, the config's command line and home; keeps them 10 minutes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* withLauncher(LISTING)
      const listed = yield* Effect.gen(function* () {
        const queries = yield* AcpQueries
        const first = yield* queries.models(config({ command: "agy acp --verbose" }))
        // Kept: asked once.
        yield* queries.models(config({ command: "agy acp --verbose" }))
        return first
      }).pipe(Effect.provide(live(`${dir}/huntaway`, "/home/me")))
      assert.deepStrictEqual(listed, MODELS)
      const seen = (yield* fs.readFileString(`${dir}/seen`).pipe(Effect.orDie)).trim().split("\n")
      assert.deepStrictEqual(seen.slice(0, 2), ["[acp-run]", "[--list-models]"])
      const cwd = seen[3]?.slice("cwd=".length) ?? ""
      assert.strictEqual(seen[2], `[${cwd}/spec.json]`)
      assert.strictEqual(seen[4], "home=/home/me/.gemini-work")
      assert.deepStrictEqual(yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(seen[5] ?? "null").pipe(Effect.orDie), {
        cwd,
        program: "agy",
        args: ["acp", "--verbose"],
        session_id: null,
        model: null,
        effort: null,
        mode: "default",
        system_prompt: "",
        input: false,
        requests_on_output: false,
        mcp_servers: [],
      })
      assert.strictEqual(seen.length, 6, "asked once")
      assert.isFalse(yield* fs.exists(cwd).pipe(Effect.orDie), "its folder goes")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.live("an agent that needs a sign-in, a failure, a listing that doesn't read, and no launcher are unavailable", () =>
    Effect.gen(function* () {
      assert.include(yield* reason(`${yield* withLauncher("", 3)}/huntaway`), "sign in by running `agy` once")
      assert.strictEqual(yield* reason(`${yield* withLauncher("", 1)}/huntaway`), "stderr says why")
      assert.strictEqual(yield* reason(`${yield* withLauncher("nope")}/huntaway`), "the agent's models didn't read")
      assert.include(yield* reason(null), "launcher")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect("configs.models' test layer: an ACP config's scripted models, null for another agent's", () =>
    Effect.gen(function* () {
      const configs = yield* AgentConfigs
      const queries = yield* AcpQueries
      const script = yield* AcpModelsScript
      const acp = yield* configs.create({ name: "g", agent: "acp" })
      const claude = yield* configs.create({ name: "c" })
      assert.deepStrictEqual(yield* queries.configModels(acp.id), [])
      yield* script.set(Result.succeed(MODELS))
      assert.deepStrictEqual(yield* queries.configModels(acp.id), MODELS)
      assert.strictEqual(yield* queries.configModels(claude.id), null)
      yield* script.set(Result.fail(new AcpUnavailable({ reason: "signed out" })))
      assert.strictEqual((yield* Effect.flip(queries.configModels(acp.id)))._tag, "AcpUnavailable")
      assert.strictEqual((yield* Effect.flip(queries.configModels(AgentConfigId.make("gone"))))._tag, "AgentConfigNotFound")
    }).pipe(Effect.provide(TestBoard())),
  )
})
