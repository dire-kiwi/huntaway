import { Context, DateTime, Effect, FileSystem, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { DataDir } from "./DataDir.ts"
import { ServerConfig } from "./ServerConfig.ts"
import { StartupError } from "./StartupError.ts"

/** How many backups are kept besides the newest from before a version change. */
export const KEEP = 2

export interface BackupShape {
  /**
   * Before migrating a database that has data: `VACUUM INTO backups/board-<from>-to-<to>-<time>.db`, keeping the
   * newest `KEEP`. Fails, and so refuses to start, if the backup cannot be made, unless `--skip-db-backup`.
   */
  readonly beforeMigrate: (from: string, to: string) => Effect.Effect<void, StartupError>
}

const fileName = (name: string) => name.replaceAll(/[^A-Za-z0-9.-]/g, "_")

export class Backup extends Context.Service<Backup, BackupShape>()("huntaway-server/platform/Backup") {
  static readonly layer = Layer.effect(
    Backup,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const fs = yield* FileSystem.FileSystem
      const dataDir = yield* DataDir
      const config = yield* ServerConfig

      const prune = Effect.gen(function* () {
        const names = yield* fs.readDirectory(dataDir.backups)
        const backups = names.filter((n) => n.startsWith("board-") && n.endsWith(".db")).toSorted()
        // The name ends in the time it was made, so the newest sort last within a pair; sort by that time.
        const byTime = backups.toSorted((a, b) => a.slice(-24).localeCompare(b.slice(-24)))
        const old = byTime.slice(0, Math.max(0, byTime.length - KEEP))
        yield* Effect.forEach(old, (name) => fs.remove(`${dataDir.backups}/${name}`), { concurrency: 1, discard: true })
      })

      const beforeMigrate = Effect.fn("Backup.beforeMigrate")(function* (from: string, to: string) {
        const now = yield* DateTime.now
        const stamp = DateTime.formatIso(now).slice(0, 19).replaceAll(":", "-")
        const target = `${dataDir.backups}/board-${fileName(from)}-to-${fileName(to)}-${stamp}Z.db`
        const made = yield* Effect.gen(function* () {
          yield* fs.makeDirectory(dataDir.backups, { recursive: true, mode: 0o700 })
          yield* sql`VACUUM INTO ${target}`
          yield* fs.chmod(target, 0o600)
          yield* prune
        }).pipe(Effect.result)
        if (made._tag === "Success") return yield* Effect.logInfo(`backed the database up to ${target}`)
        const why = String(made.failure)
        if (config.skipDbBackup) return yield* Effect.logWarning(`couldn't back the database up before migrating, going on (--skip-db-backup): ${why}`)
        return yield* new StartupError({
          reason: `couldn't back the database up to ${dataDir.backups} before migrating it (${why}); start with --skip-db-backup to go on without one`,
        })
      })
      return Backup.of({ beforeMigrate })
    }),
  )
}
