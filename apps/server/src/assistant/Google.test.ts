import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { assert, layer } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { ProfileId } from "@huntaway/contracts"
import type { Profile } from "@huntaway/contracts"
import { TestBoard } from "@huntaway/testing"
import { AgentTools } from "../agents/AgentTools.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { Assistant } from "./Assistant.ts"
import { Google } from "./Google.ts"
import { CLIENT_SECRET_ENV, CREDENTIALS_ENV, EMAIL_ENV, PACKAGE, SCOPES, SERVER, serverConfig } from "./googleText.ts"

/** JSON text, through a schema (the global `JSON` throws). */
const encodeJson = Schema.encodeResult(Schema.fromJsonString(Schema.Unknown))
const json = (v: unknown): string => Result.getOrElse(encodeJson(v), () => "")

// The assistant's Google card on the whole board (the old agent/assistant/google/tests.test.ts, its status and set-up
// half): what's missing until Google is connected, set up as a global MCP server switched on for the profile, the
// refresh token checked against a token endpoint of the test's own (never Google's). The consent flow's plain parts are
// googleText.test.ts. `only_the_assistant_gets_the_google_server…` is 6.4's (agents/agentTools/effective.test.ts).

const board = TestBoard()

const profile = (name: string) => Effect.flatMap(Profiles, (p) => p.create({ name })).pipe(Effect.orDie)

const CLIENT = '{"installed": {"client_id": "id.apps.googleusercontent.com", "client_secret": "shh", "redirect_uris": ["http://localhost"]}}'

const creds = (refresh: string | null, scopes: ReadonlyArray<string>, tokenUri = "https://oauth2.googleapis.com/token") =>
  json({ token: "at", refresh_token: refresh, token_uri: tokenUri, client_id: "id", client_secret: "shh", scopes, expiry: null })

/** A Google server whose files are in `dir` (not the home folder), run by a program that's there. */
const testConfig = (dir: string, email: string | null) => {
  const bin = `${dir}/uvx`
  writeFileSync(bin, "#!/bin/sh\n")
  chmodSync(bin, 0o755)
  const c = serverConfig("/home/nobody", email)
  return { ...c, command: bin, env: { ...c.env, [CLIENT_SECRET_ENV]: `${dir}/client_secret.json`, [CREDENTIALS_ENV]: `${dir}/credentials` } }
}

const status = (p: Profile) => Effect.flatMap(Google, (g) => g.status(p.id, false))

/** The host's `google` server's id. */
const serverId = Effect.gen(function* () {
  const all = yield* (yield* AgentTools).global
  return all.mcp_servers.find((s) => s.name === SERVER)?.id ?? assert.fail("no google server")
})

const setConfig = (config: unknown) =>
  Effect.gen(function* () {
    yield* (yield* AgentTools).updateServer(null, yield* serverId, { config })
  }).pipe(Effect.orDie)

layer(board)("Google", (it) => {
  it.effect("the card says what is missing until Google is connected", () =>
    Effect.gen(function* () {
      const google = yield* Google
      const tools = yield* AgentTools
      const p = yield* profile("personal")
      // No server yet.
      let v = yield* status(p)
      assert.deepStrictEqual([v.connected, v.server], [false, null])
      assert.include(v.problem, "no Google server")
      assert.isTrue((yield* google.line(p.id)).startsWith("not connected: There's no Google server"))
      // Setting it up makes the server and switches it on for the profile.
      v = yield* google.setup(p.id)
      const id = yield* serverId
      const added = (yield* tools.global).mcp_servers.find((s) => s.id === id)
      assert.deepStrictEqual(added?.config["args"], [PACKAGE, "--single-user", "--tools", "gmail", "calendar", "drive", "--tool-tier", "extended"])
      assert.isTrue((yield* tools.global).profile_switches[p.id]?.[id])
      assert.isTrue(v.server?.on)
      // Once more keeps it as it is (here, pointed at a folder of the test's own).
      const dir = mkdtempSync(`${tmpdir()}/huntaway-google-`)
      yield* setConfig(testConfig(dir, null))
      v = yield* google.setup(p.id)
      assert.strictEqual((yield* tools.global).mcp_servers.filter((s) => s.name === SERVER).length, 1)
      assert.include(v.problem, "no OAuth client")
      // Switched off for the profile.
      yield* tools.setSwitch({ scope: "profile", scope_id: p.id, item_id: id, enabled: false }).pipe(Effect.orDie)
      assert.include((yield* status(p)).problem, "isn't switched on for this profile")
      yield* tools.setSwitch({ scope: "profile", scope_id: p.id, item_id: id, enabled: true }).pipe(Effect.orDie)
      // The client's there; no one's signed in.
      writeFileSync(`${dir}/client_secret.json`, CLIENT)
      chmodSync(`${dir}/client_secret.json`, 0o600)
      v = yield* status(p)
      assert.include(v.problem, "Not signed in to Google yet: run huntaway google-auth --client-secret")
      assert.include(v.consent_command, `${dir}/client_secret.json`)
      // Signed in without a refresh token.
      mkdirSync(`${dir}/credentials`)
      const file = `${dir}/credentials/sam@example.com.json`
      writeFileSync(file, creds(null, SCOPES))
      chmodSync(file, 0o600)
      assert.include((yield* status(p)).problem, "no refresh token")
      // With one: connected, but its file is readable by others, and it was given less than the brief reads.
      writeFileSync(file, creds("rt", ["openid", "https://www.googleapis.com/auth/calendar"]))
      chmodSync(file, 0o644)
      v = yield* status(p)
      assert.deepStrictEqual([v.connected, v.account], [true, "sam@example.com"])
      const warnings = json(v.warnings)
      assert.isTrue(
        warnings.includes("chmod 600") && warnings.includes("gmail.readonly") && warnings.includes("drive.readonly") && !warnings.includes("calendar.readonly"),
        warnings,
      )
      assert.strictEqual(yield* google.line(p.id), "connected as sam@example.com")
      chmodSync(file, 0o600)
      writeFileSync(file, creds("rt", SCOPES))
      assert.deepStrictEqual((yield* status(p)).warnings, [])
      // A second account: the server has to be told which.
      const other = `${dir}/credentials/kim@example.com.json`
      writeFileSync(other, creds("rt", SCOPES))
      chmodSync(other, 0o600)
      assert.include((yield* status(p)).warnings[0], EMAIL_ENV)
      // Told one it has no credentials for.
      yield* setConfig(testConfig(dir, "lee@example.com"))
      assert.include((yield* status(p)).problem, "no credentials for lee@example.com")
      yield* setConfig(testConfig(dir, "kim@example.com"))
      assert.strictEqual((yield* status(p)).account, "kim@example.com")
      // A program that isn't there.
      yield* setConfig({ ...testConfig(dir, null), command: "no-such-uvx-here" })
      assert.include((yield* status(p)).problem, "no-such-uvx-here isn't on this host's PATH")
    }),
  )

  it.effect("a check tries the account's refresh token with the token endpoint, and says why it failed", () =>
    Effect.gen(function* () {
      const google = yield* Google
      const p = yield* profile("checked")
      yield* google.setup(p.id)
      const dir = mkdtempSync(`${tmpdir()}/huntaway-google-`)
      yield* setConfig(testConfig(dir, null))
      writeFileSync(`${dir}/client_secret.json`, CLIENT)
      chmodSync(`${dir}/client_secret.json`, 0o600)
      mkdirSync(`${dir}/credentials`)
      // A token endpoint of the test's own: it takes refresh token "good" only.
      const seen: Array<string> = []
      const server = createServer((req, res) => {
        let body = ""
        req.on("data", (c: Buffer) => (body += c.toString()))
        req.on("end", () => {
          seen.push(body)
          const ok = new URLSearchParams(body).get("refresh_token") === "good"
          res.writeHead(ok ? 200 : 400, { "content-type": "application/json" })
          res.end(ok ? '{"access_token": "at", "expires_in": 3599}' : '{"error": "invalid_grant", "error_description": "Token has been expired or revoked."}')
        })
      })
      yield* Effect.callback<void>((resume) => {
        server.listen(0, "127.0.0.1", () => resume(Effect.void))
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => server.close()))
      const address = server.address()
      const uri = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}/token`
      const file = `${dir}/credentials/sam@example.com.json`
      writeFileSync(file, creds("good", SCOPES, uri))
      chmodSync(file, 0o600)
      let v = yield* google.status(p.id, true)
      assert.deepStrictEqual([v.connected, v.verified, v.verify_error], [true, true, undefined])
      assert.include(seen[0], "grant_type=refresh_token")
      writeFileSync(file, creds("revoked", SCOPES, uri))
      v = yield* google.status(p.id, true)
      assert.strictEqual(v.verified, false)
      assert.include(v.verify_error, "Google said 400 (invalid_grant: Token has been expired or revoked.)")
      // Without `check`, nothing's asked.
      assert.isUndefined((yield* google.status(p.id, false)).verified)
      assert.strictEqual(seen.length, 2)
    }).pipe(Effect.scoped),
  )

  it.effect("a profile whose assistant is elsewhere has its Google there", () =>
    Effect.gen(function* () {
      const google = yield* Google
      const sql = yield* SqlClient.SqlClient
      const p = yield* profile("away")
      assert.strictEqual((yield* Effect.flip(google.status(ProfileId.make("nope"), false)))._tag, "NotFound")
      yield* sql`UPDATE profiles SET assistant_host = 'elsewhere' WHERE id = ${p.id}`
      assert.strictEqual((yield* Effect.flip(google.status(p.id, false)))._tag, "Conflict")
      assert.strictEqual((yield* Effect.flip(google.setup(p.id)))._tag, "Conflict")
      // One this host has already is its own, whatever its profile says.
      yield* sql`UPDATE profiles SET assistant_host = NULL WHERE id = ${p.id}`
      yield* (yield* Assistant).get(p.id)
      yield* sql`UPDATE profiles SET assistant_host = 'elsewhere' WHERE id = ${p.id}`
      assert.isFalse((yield* google.status(p.id, false)).connected)
    }),
  )
})
