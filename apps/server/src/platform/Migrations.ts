import { Context, DateTime, Effect, FileSystem, Layer, Path, Predicate } from "effect"
import { SqlClient } from "effect/sql"
import { Backup } from "./Backup.ts"
import { Db } from "./Db.ts"
import type { Migration } from "./migration.ts"
import { StartupError } from "./StartupError.ts"

export interface NamedMigration extends Migration {
  readonly name: string
}

export interface MigrationsShape {
  /** Every migration recorded as applied, this build's and any newer build's. */
  readonly applied: ReadonlyArray<string>
}

const isMigration = (u: unknown): u is Migration => Predicate.hasProperty(u, "run") && Effect.isEffect(u.run)

/** The migrations folder beside `src/`: `apps/server/migrations` in a checkout, `server/migrations` in a release. */
const folder = new URL("../../migrations/", import.meta.url)

/** This build's migrations, read from the migrations folder: each file's default export, named for the file. */
export const loadMigrations = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = yield* path.fromFileUrl(folder)
  const files = (yield* fs.readDirectory(dir)).filter((f) => /^\d{4}-\d{2}-\d{2}-.+\.(ts|js)$/.test(f) && !f.endsWith(".d.ts")).toSorted()
  return yield* Effect.forEach(
    files,
    (file) =>
      Effect.gen(function* () {
        const module: unknown = yield* Effect.promise(() => import(new URL(file, folder).href))
        const value = Predicate.hasProperty(module, "default") ? module.default : undefined
        if (!isMigration(value)) return yield* new StartupError({ reason: `migration ${file} has no default export made with migration()` })
        return { ...value, name: file.replace(/\.(ts|js)$/, "") } satisfies NamedMigration
      }),
    { concurrency: 1 },
  )
}).pipe(Effect.mapError((e) => (e._tag === "StartupError" ? e : new StartupError({ reason: `can't read the migrations: ${e.message}` }))))

/**
 * The named-migration runner (docs/plan/04-database.md, Migrations). Runs, by name, each migration not yet recorded
 * in `migrations`, each in its own `BEGIN IMMEDIATE` transaction with its record. Names recorded by a newer build are
 * left alone. A migration's `after` must already be applied or come before it.
 */
export const runMigrations = Effect.fn("Migrations.run")(function* (all: ReadonlyArray<NamedMigration>) {
  const db = yield* Db
  const backup = yield* Backup
  const sql = db.sql
  yield* sql`CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT`.pipe(Effect.orDie)
  const appliedRows = yield* sql<{ readonly name: string }>`SELECT name FROM migrations ORDER BY name`.pipe(Effect.orDie)
  const applied = new Set(appliedRows.map((r) => r.name))
  const pending = all.filter((m) => !applied.has(m.name))
  const known = new Set(applied)
  for (const m of pending) {
    const missing = (m.after ?? []).filter((name) => !known.has(name))
    if (missing.length > 0)
      return yield* new StartupError({ reason: `migration ${m.name} must come after ${missing.join(", ")}, which this build doesn't have` })
    known.add(m.name)
  }
  const first = pending[0]
  const last = pending.at(-1)
  if (first !== undefined && last !== undefined && applied.size > 0) {
    yield* backup.beforeMigrate([...applied].toSorted().at(-1) ?? "none", last.name)
  }
  for (const m of pending) {
    if (m.foreignKeys === false) yield* sql`PRAGMA foreign_keys = OFF`.pipe(Effect.orDie)
    yield* db
      .tx(
        Effect.gen(function* () {
          const already = yield* sql<{ readonly n: number }>`SELECT count(*) AS n FROM migrations WHERE name = ${m.name}`
          if ((already[0]?.n ?? 0) > 0) return
          yield* m.run
          const now = DateTime.formatIso(yield* DateTime.now)
          yield* sql`INSERT INTO migrations (name, applied_at) VALUES (${m.name}, ${now})`
        }).pipe(Effect.provideService(SqlClient.BeginTransaction, "BEGIN IMMEDIATE")),
      )
      .pipe(Effect.catchTag("SqlError", (e) => Effect.die(e)))
    if (m.foreignKeys === false) {
      yield* sql`PRAGMA foreign_keys = ON`.pipe(Effect.orDie)
      const broken = yield* sql`PRAGMA foreign_key_check`.pipe(Effect.orDie)
      if (broken.length > 0) return yield* new StartupError({ reason: `migration ${m.name} left ${broken.length} rows pointing at nothing` })
    }
    yield* Effect.logInfo(`applied migration ${m.name}`)
  }
  const rows = yield* sql<{ readonly name: string }>`SELECT name FROM migrations ORDER BY name`.pipe(Effect.orDie)
  return rows.map((r) => r.name)
})

/** Brings the database up to this build's schema when its layer is built (startup step 2). */
export class Migrations extends Context.Service<Migrations, MigrationsShape>()("huntaway-server/platform/Migrations") {
  static readonly layer = Layer.effect(
    Migrations,
    Effect.gen(function* () {
      const all = yield* loadMigrations
      const applied = yield* runMigrations(all)
      return Migrations.of({ applied })
    }),
  )
}
