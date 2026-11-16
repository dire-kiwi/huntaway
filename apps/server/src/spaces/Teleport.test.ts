import { NodeServices } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, FileSystem, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { fakeDocker, fakeSpacesd, tempDir, TestBoard } from "@huntaway/testing"
import { Spaces } from "./Spaces.ts"
import { Teleport } from "./Teleport.ts"

// HE-49: Teleport reading a current Firefox (147 and later keep profiles under `~/.config/mozilla/firefox`; from schema
// 16, Firefox 142, `moz_cookies.expiry` is in milliseconds; `SAMESITE_UNSET` is 256), and sending what `sites` lists,
// `localhost` included, but nothing wider than a site of the profile's. Over a fake Docker CLI and a fake spacesd that
// keeps each bundle.

/** Chrome's epoch offset: microseconds between 1601 and 1970. */
const CHROME_EPOCH_MICROS = 11644473600 * 1_000_000
/** 2026-11-16T00:00:00Z, in milliseconds. */
const EXPIRY_MS = 1795219200000

/** A Firefox profile under `<home>/.config/mozilla/firefox`, its cookies.sqlite at schema 17. */
const firefoxProfile = (home: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = `${home}/.config/mozilla/firefox`
      yield* fs.makeDirectory(`${root}/abcd.default-release`, { recursive: true })
      yield* fs.writeFileString(`${root}/profiles.ini`, "[Profile0]\nName=default-release\nIsRelative=1\nPath=abcd.default-release\nDefault=1\n")
      const context = yield* Layer.build(SqliteClient.layer({ filename: `${root}/abcd.default-release/cookies.sqlite` }))
      const sql = Context.get(context, SqlClient.SqlClient)
      yield* sql`PRAGMA user_version = 17`
      yield* sql`CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT '', name TEXT, value TEXT,
                 host TEXT, path TEXT, expiry INTEGER, lastAccessed INTEGER, creationTime INTEGER, isSecure INTEGER,
                 isHttpOnly INTEGER, sameSite INTEGER)`
      yield* sql`INSERT INTO moz_cookies (name, value, host, path, expiry, isSecure, isHttpOnly, sameSite)
                 VALUES ('sid', 'ex-secret', '.example.com', '/', ${EXPIRY_MS}, 1, 1, 256),
                        ('session', 'dev-secret', 'localhost', '/', ${EXPIRY_MS}, 0, 1, 1)`
    }).pipe(Effect.orDie),
  )

/** A tar archive's file, by name (ustar: a 512-byte header with the name and an octal size, then the data in blocks). */
const tarFile = (tar: Uint8Array, name: string): string | null => {
  let at = 0
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512)
    const entry = new TextDecoder().decode(header.subarray(0, 100)).replace(/\0.*$/su, "")
    if (entry === "") return null
    const size = Number.parseInt(new TextDecoder().decode(header.subarray(124, 136)).replace(/\0.*$/su, "").trim(), 8)
    if (entry === name) return new TextDecoder().decode(tar.subarray(at + 512, at + 512 + size))
    at += 512 + Math.ceil(size / 512) * 512
  }
  return null
}

const Cookies = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ host_key: Schema.String, name: Schema.String, expires_utc: Schema.Finite, samesite: Schema.Finite })),
)

describe("Teleport", () => {
  it.effect(
    "reads Firefox from the config folder, ms expiries and unset SameSite; sends what sites lists, localhost included",
    () =>
      Effect.gen(function* () {
        const home = yield* tempDir
        yield* firefoxProfile(home)
        const docker = yield* fakeDocker
        const spacesd = yield* fakeSpacesd
        yield* docker.setSpacesdPort(spacesd.port)
        yield* Effect.gen(function* () {
          const teleport = yield* Teleport
          const sources = yield* teleport.sources
          const firefox = sources.find((s) => s.key === "firefox")
          assert.deepStrictEqual(firefox?.profiles, [{ id: "abcd.default-release", label: "default-release" }])
          const listed = yield* teleport.sites("firefox", "abcd.default-release")
          assert.deepStrictEqual(listed.sites.map((s) => s.site).toSorted(), ["example.com", "localhost"])

          const spaces = yield* Spaces
          const made = yield* spaces.create({ name: "Fox" })
          yield* spaces.settled(made.id)
          // Nothing wider than a site of the profile's: `com` isn't one.
          const wide = yield* Effect.flip(teleport.bring({ id: made.id, browser: "firefox", profile: "abcd.default-release", sites: ["com"] }))
          assert.strictEqual(wide._tag, "Invalid")
          assert.lengthOf(spacesd.teleports, 0)

          const r = yield* teleport.bring({ id: made.id, browser: "firefox", profile: "abcd.default-release", sites: ["example.com", "localhost"] })
          assert.strictEqual(r.import.app, "firefox")
          const sent = tarFile(spacesd.teleports[0]?.bundle ?? new Uint8Array(), "cookies.json")
          const cookies = yield* Schema.decodeUnknownEffect(Cookies)(sent).pipe(Effect.orDie)
          const sid = cookies.find((c) => c.name === "sid")
          // Milliseconds since 1970 → microseconds since 1601 (to within the float's rounding at that size).
          assert.isTrue(Math.abs((sid?.expires_utc ?? 0) - (EXPIRY_MS * 1000 + CHROME_EPOCH_MICROS)) <= 4, String(sid?.expires_utc))
          // Firefox's SAMESITE_UNSET (256) is unspecified, not Strict; Lax stays Lax.
          assert.strictEqual(sid?.samesite, -1)
          assert.strictEqual(cookies.find((c) => c.name === "session")?.samesite, 1)
          assert.deepStrictEqual(cookies.map((c) => c.host_key).toSorted(), [".example.com", "localhost"])
        }).pipe(Effect.provide(TestBoard({ dockerBin: docker.bin, home, configHome: `${home}/.config` })))
      }).pipe(Effect.provide(NodeServices.layer)),
    30_000,
  )
})
