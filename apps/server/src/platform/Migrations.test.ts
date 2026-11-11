import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Ref } from "effect"
import { SqlClient } from "effect/sql"
import { Backup } from "./Backup.ts"
import { Db } from "./Db.ts"
import { migration } from "./migration.ts"
import { loadMigrations, runMigrations } from "./Migrations.ts"
import type { NamedMigration } from "./Migrations.ts"

const backups = Ref.makeUnsafe<ReadonlyArray<string>>([])
const FakeBackup = Layer.succeed(Backup, Backup.of({ beforeMigrate: (from, to) => Ref.update(backups, (b) => [...b, `${from}->${to}`]) }))
const TestLive = Layer.mergeAll(Db.layerMemory, FakeBackup, NodeServices.layer)

const named = (name: string, sqlText: string, after?: ReadonlyArray<string>): NamedMigration => ({
  ...migration({
    ...(after === undefined ? {} : { after }),
    run: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe(sqlText)
    }),
  }),
  name,
})

describe("Migrations", () => {
  it.effect("this build's migrations load and apply to an empty database", () =>
    Effect.gen(function* () {
      const all = yield* loadMigrations
      assert.isTrue(all.length > 0)
      const applied = yield* runMigrations(all)
      assert.deepStrictEqual(
        applied,
        all.map((m) => m.name),
      )
      const sql = (yield* Db).sql
      const tables = yield* sql<{ readonly name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('tasks', 'projects', 'profiles')`
      assert.strictEqual(tables.length, 3)
    }).pipe(Effect.provide(TestLive)),
  )

  it.effect("runs only what is not recorded, by name; backs up first when the database has data", () =>
    Effect.gen(function* () {
      yield* Ref.set(backups, [])
      const a = named("2026-01-01-a", "CREATE TABLE a (x INTEGER) STRICT")
      const b = named("2026-01-02-b", "CREATE TABLE b (x INTEGER) STRICT", ["2026-01-01-a"])
      assert.deepStrictEqual(yield* runMigrations([a]), ["2026-01-01-a"])
      assert.deepStrictEqual(yield* Ref.get(backups), [])
      assert.deepStrictEqual(yield* runMigrations([a, b]), ["2026-01-01-a", "2026-01-02-b"])
      assert.deepStrictEqual(yield* Ref.get(backups), ["2026-01-01-a->2026-01-02-b"])
      // Again: nothing to do, no backup.
      assert.deepStrictEqual(yield* runMigrations([a, b]), ["2026-01-01-a", "2026-01-02-b"])
      assert.strictEqual((yield* Ref.get(backups)).length, 1)
    }).pipe(Effect.provide(TestLive)),
  )

  it.effect("a migration merged later with an earlier name still runs (the old numbered scheme skipped it)", () =>
    Effect.gen(function* () {
      const later = named("2026-02-01-later", "CREATE TABLE later (x INTEGER) STRICT")
      const earlier = named("2026-01-15-earlier", "CREATE TABLE earlier (x INTEGER) STRICT")
      yield* runMigrations([later])
      assert.deepStrictEqual(yield* runMigrations([earlier, later]), ["2026-01-15-earlier", "2026-02-01-later"])
    }).pipe(Effect.provide(TestLive)),
  )

  it.effect("leaves a newer build's records alone, and refuses an `after` it doesn't have", () =>
    Effect.gen(function* () {
      const sql = (yield* Db).sql
      yield* runMigrations([])
      yield* sql`INSERT INTO migrations (name, applied_at) VALUES ('2099-01-01-newer', '2099-01-01T00:00:00.000Z')`
      const c = named("2026-03-01-c", "CREATE TABLE c (x INTEGER) STRICT", ["2026-02-28-missing"])
      const error = yield* runMigrations([c]).pipe(Effect.flip)
      assert.strictEqual(error._tag, "StartupError")
      assert.deepStrictEqual(yield* runMigrations([]), ["2099-01-01-newer"])
    }).pipe(Effect.provide(TestLive)),
  )
})
