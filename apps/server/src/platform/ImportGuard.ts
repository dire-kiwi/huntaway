import { Context, Effect, FileSystem, Layer, Path } from "effect"
import { IMPORT_FILE, processesWithOpen, readImportRecord } from "./ImportRecord.ts"
import type { ImportRecord } from "./ImportRecord.ts"
import { ServerConfig } from "./ServerConfig.ts"
import { StartupError } from "./StartupError.ts"

export interface ImportGuardShape {
  /** The folder's `import.json`, if `import-legacy` filled it. */
  readonly record: ImportRecord | null
  /** A rehearsal: the server starts read-only (`ReadOnlyMain`), and in no other way. */
  readonly readOnly: boolean
}

/**
 * Two servers never act as one host (docs/plan/11-migration.md, The guard; 06-server.md, Startup step 1). Read before
 * anything else is built: before the identity and the database. A folder with no `import.json` starts as usual; a
 * rehearsal's (`rehearsal: true`) starts read-only, whatever the flags say; a switch's refuses to start while any
 * process has the old folder's database open. An `import.json` that can't be read refuses too: a rehearsal folder
 * whose record is damaged must not start as a board that acts.
 */
export class ImportGuard extends Context.Service<ImportGuard, ImportGuardShape>()("huntaway-server/platform/ImportGuard") {
  static readonly layer = Layer.effect(
    ImportGuard,
    Effect.gen(function* () {
      const config = yield* ServerConfig
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = path.resolve(config.dataDir)
      const found = yield* readImportRecord(root).pipe(
        Effect.mapError((e) => new StartupError({ reason: `can't read ${path.join(root, IMPORT_FILE)}: ${e.message}` })),
      )
      if (found._tag === "None") return ImportGuard.of({ record: null, readOnly: false })
      const record = found.value
      if (record.rehearsal) return ImportGuard.of({ record, readOnly: true })
      const database = path.join(record.from, record.database)
      const there = yield* fs.exists(database).pipe(Effect.orElseSucceed(() => false))
      const holders = there
        ? yield* processesWithOpen(database).pipe(
            Effect.mapError((e) => new StartupError({ reason: `can't tell whether the old server still has ${database} open: ${e.message}` })),
          )
        : []
      if (holders.length > 0)
        return yield* new StartupError({
          reason:
            `this board was imported from ${record.from}, and the old board's database ${database} is open (process ${holders.join(", ")}): ` +
            "stop the old server for good, or, to go back to it, stop this one and start only the old one. Two servers must never act as one host.",
        })
      return ImportGuard.of({ record, readOnly: false })
    }),
  )

  /** A folder that was not imported, or `record`'s: for tests and for a composition given the guard's answer. */
  static readonly layerOf = (record: ImportRecord | null) => Layer.succeed(ImportGuard, ImportGuard.of({ record, readOnly: record?.rehearsal ?? false }))
}
