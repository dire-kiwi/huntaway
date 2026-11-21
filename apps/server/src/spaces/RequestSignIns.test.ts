import * as NodeServices from "@effect/platform-node/NodeServices"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Fiber, FileSystem, Layer, Schema } from "effect"
import { Cipher, Digest, Kdf, SecureRandom } from "effect/crypto"
import { Base64 } from "effect/encoding"
import { SqlClient } from "effect/sql"
import { CallId } from "@huntaway/contracts"
import { fakeAgent, fakeDocker, fakeSpacesd, tempDir, TestBoard } from "@huntaway/testing"
import type { FakeAgent } from "@huntaway/testing"
import { callResult } from "../mcp/jsonrpc.ts"
import { ToolCalls } from "../mcp/ToolCalls.ts"
import { Permissions } from "../permissions/Permissions.ts"
import { Spaces } from "./Spaces.ts"
import { Teleport } from "./Teleport.ts"
import { deriveKey, V10_PASSWORD } from "./teleport/chromiumCrypto.ts"

// HE-49: `space_request_sign_ins` as a run calls it, through `ToolCalls` on the whole board, over a fake Docker CLI, a
// fake spacesd that takes teleports, and a Google Chrome profile in the board's home whose cookies are encrypted as
// Linux Chrome does (`v10`, in a version-24 `Cookies` database, so each value starts with its host_key's SHA-256). The
// tool asks the user itself, even in Bypass; the card offers only registrable domains the profile holds, identity
// providers unticked; a denial sends nothing; only what the user leaves ticked of what was offered goes.

const Said = Schema.Struct({ content: Schema.Array(Schema.Unknown), isError: Schema.optional(Schema.Boolean) })
const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
const said = (result: unknown): { readonly text: string; readonly error: boolean } => {
  if (!Schema.is(Said)(result)) return assert.fail("not a tool's result")
  return {
    text: result.content
      .filter(Schema.is(TextPart))
      .map((c) => c.text)
      .join("\n"),
    error: result.isError === true,
  }
}

const spacesCall = (agent: FakeAgent, tool: string, args: unknown, id: string) =>
  Effect.gen(function* () {
    const result = yield* (yield* ToolCalls).call({ call_id: CallId.make(id), run: agent.run.id, server: "spaces", tool, args })
    return yield* callResult(result, "spaces")
  })

/** Microseconds since 1601: too big for a JS number's exact integers, as Chrome's expiries are. */
const EXPIRES = 13453171036399180n

const crypto = Layer.mergeAll(Kdf.layerWebCrypto, Cipher.layerWebCrypto, Digest.layerWebCrypto).pipe(Layer.provideMerge(SecureRandom.layerWebCrypto))

/** A Google Chrome profile (`Default`) in `home` with these cookies, `v10`-encrypted with their host_key's digest. */
const chromeProfile = (home: string, cookies: ReadonlyArray<readonly [string, string, string, string?]>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = `${home}/.config/google-chrome`
      yield* fs.makeDirectory(`${root}/Default`, { recursive: true })
      yield* fs.writeFileString(`${root}/Local State`, '{"profile":{"info_cache":{"Default":{"name":"Me"}}}}')
      const context = yield* Layer.build(SqliteClient.layer({ filename: `${root}/Default/Cookies` }))
      const sql = Context.get(context, SqlClient.SqlClient)
      yield* sql`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)`
      yield* sql`INSERT INTO meta VALUES ('version', '24')`
      yield* sql`CREATE TABLE cookies (host_key TEXT, top_frame_site_key TEXT NOT NULL DEFAULT '', name TEXT, value TEXT,
                 encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER)`
      const key = yield* deriveKey(yield* Kdf.Kdf, V10_PASSWORD)
      const cipher = yield* Cipher.Cipher
      const digest = yield* Digest.Digest
      for (const [host, name, value, topFrame = ""] of cookies) {
        const sum = yield* digest.digest(Digest.sha256, new TextEncoder().encode(host))
        const body = yield* cipher.encrypt(key, Uint8Array.from([...sum, ...new TextEncoder().encode(value)]), { iv: new Uint8Array(16).fill(0x20) })
        const encrypted = Uint8Array.from([0x76, 0x31, 0x30, ...body])
        yield* sql`INSERT INTO cookies VALUES (${host}, ${topFrame}, ${name}, '', ${encrypted}, '/', ${EXPIRES}, 1, 1, 1)`
      }
    }).pipe(Effect.provide(crypto), Effect.orDie),
  )

const AskedInput = Schema.Struct({
  sites: Schema.Array(Schema.String),
  offered: Schema.Array(Schema.Struct({ site: Schema.String, identity_provider: Schema.Boolean })),
  not_found: Schema.Array(Schema.String),
  profile_label: Schema.String,
})

const TIMEOUT = 30_000

describe("space_request_sign_ins", () => {
  it.effect(
    "asks the user itself even in Bypass, offers what the profile holds, sends only what's left ticked",
    () =>
      Effect.gen(function* () {
        const home = yield* tempDir
        yield* chromeProfile(home, [
          [".github.com", "user_session", "gh-secret"],
          // A partitioned (CHIPS) twin, set inside another site's page: never sent as the first-party cookie.
          [".github.com", "user_session", "gh-partitioned", "https://other.example"],
          ["accounts.google.com", "SID", "g-secret"],
          [".other.com", "pref", "o-value"],
        ])
        const docker = yield* fakeDocker
        const spacesd = yield* fakeSpacesd
        yield* docker.setSpacesdPort(spacesd.port)
        yield* Effect.gen(function* () {
          yield* (yield* Spaces).setAgentTools(true)
          const agent = yield* fakeAgent()
          const sql = yield* SqlClient.SqlClient
          yield* sql`UPDATE tasks SET permission_mode = 'bypassPermissions' WHERE id = ${agent.run.task_id}`
          assert.isFalse(said(yield* spacesCall(agent, "create_space", { name: "Signed" }, "c0")).error)
          const permissions = yield* Permissions
          const args = { space: "Signed", sites: ["github.com", "google.com", "com", "nothere.com"] }

          // Asked, not allowed by Bypass; the card offers github.com ticked and google.com unticked.
          const denied = yield* Effect.forkChild(spacesCall(agent, "space_request_sign_ins", args, "s1"))
          const first = yield* permissions.asking("s1")
          // Bypass, applied again as a mode change would, leaves it to the user.
          yield* permissions.applyMode(agent.run.task_id)
          const pending = (yield* permissions.pending({ task: agent.run.task_id })).find((p) => p.id === first)
          const input = yield* Schema.decodeUnknownEffect(AskedInput)(pending?.input).pipe(Effect.orDie)
          assert.deepStrictEqual(input.sites, ["github.com"])
          assert.deepStrictEqual(
            input.offered.map((o) => [o.site, o.identity_provider]),
            [
              ["github.com", false],
              ["google.com", true],
            ],
          )
          assert.deepStrictEqual(input.not_found, ["nothere.com"])
          assert.strictEqual(input.profile_label, "Me")
          yield* permissions.answer(first, { decision: "deny" }, "user").pipe(Effect.orDie)
          const no = said(yield* Fiber.join(denied))
          assert.isTrue(no.error && no.text.includes("No sign-ins were brought"), no.text)
          assert.lengthOf(spacesd.teleports, 0)

          // Allowed with google.com ticked back and a site that wasn't offered added: the latter is dropped.
          const allowed = yield* Effect.forkChild(spacesCall(agent, "space_request_sign_ins", args, "s2"))
          const second = yield* permissions.asking("s2")
          const asked = (yield* permissions.pending({ task: agent.run.task_id })).find((p) => p.id === second)?.input
          const fields = yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown))(asked).pipe(Effect.orDie)
          const edited = { ...fields, sites: ["github.com", "google.com", "other.com"] }
          yield* permissions.answer(second, { decision: "allow", input: edited }, "user").pipe(Effect.orDie)
          const yes = said(yield* Fiber.join(allowed))
          assert.isFalse(yes.error, yes.text)
          assert.include(yes.text, "github.com, google.com")
          assert.lengthOf(spacesd.teleports, 1)
          const bundle = new TextDecoder("latin1").decode(spacesd.teleports[0]?.bundle)
          assert.isTrue(bundle.startsWith("manifest.json"))
          assert.include(bundle, Base64.encode(new TextEncoder().encode("gh-secret")))
          assert.include(bundle, Base64.encode(new TextEncoder().encode("g-secret")))
          assert.notInclude(bundle, Base64.encode(new TextEncoder().encode("o-value")))
          assert.notInclude(bundle, Base64.encode(new TextEncoder().encode("gh-partitioned")))
          // The Space's browser was closed by exact process names first.
          assert.isTrue((yield* docker.calls).some((c) => c[0] === "exec" && (c.at(-1) ?? "").includes("pkill -TERM -x")))

          // Removing it wipes it in the Space.
          const teleport = yield* Teleport
          const space = (yield* (yield* Spaces).find("Signed")).id
          const [made] = yield* teleport.imports(space)
          assert.isDefined(made)
          yield* teleport.remove(made?.import_id ?? "")
          assert.deepStrictEqual(spacesd.wiped, [made?.import_id])
          assert.lengthOf(yield* teleport.imports(space), 0)
        }).pipe(Effect.provide(TestBoard({ dockerBin: docker.bin, home, configHome: `${home}/.config` })))
      }).pipe(Effect.provide(NodeServices.layer)),
    TIMEOUT,
  )
})
