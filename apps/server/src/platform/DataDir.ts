import { Context, Effect, FileSystem, Layer, Path } from "effect"
import { ServerConfig } from "./ServerConfig.ts"
import { StartupError } from "./StartupError.ts"

// The data folder's layout is the old one (docs/plan/inventory/07-server-root-api.md, section 3), so the same habits
// apply; the database is `board.db` (docs/plan/04-database.md).

export interface DataDirShape {
  /** The data folder, absolute and resolved through symbolic links. */
  readonly root: string
  readonly database: string
  readonly backups: string
  readonly attachments: string
  readonly attachment: (id: string) => string
  readonly runs: string
  readonly runDir: (runId: string) => string
  readonly projectDir: (projectId: string) => string
  readonly profileDir: (profileId: string) => string
  readonly documents: (taskId: string) => string
  /** A file at the top of the data folder (`host_id`, `auth_token`, `import.json`…). */
  readonly file: (name: string) => string
}

/** Every path under the data folder, as a function. Building it makes the folder (mode 0700). */
export class DataDir extends Context.Service<DataDir, DataDirShape>()("huntaway-server/platform/DataDir") {
  static readonly make = (root: string): DataDirShape => {
    const at = (...parts: ReadonlyArray<string>) => [root, ...parts].join("/")
    return {
      root,
      database: at("board.db"),
      backups: at("backups"),
      attachments: at("attachments"),
      attachment: (id) => at("attachments", id),
      runs: at("runs"),
      runDir: (runId) => at("runs", runId),
      projectDir: (projectId) => at("projects", projectId),
      profileDir: (profileId) => at("profiles", profileId),
      documents: (taskId) => at("documents", taskId),
      file: (name) => at(name),
    }
  }

  static readonly layer = Layer.effect(
    DataDir,
    Effect.gen(function* () {
      const config = yield* ServerConfig
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const wanted = path.resolve(config.dataDir)
      const root = yield* Effect.gen(function* () {
        yield* fs.makeDirectory(wanted, { recursive: true, mode: 0o700 })
        yield* fs.chmod(wanted, 0o700)
        return yield* fs.realPath(wanted)
      }).pipe(Effect.mapError((e) => new StartupError({ reason: `can't use the data folder ${wanted}: ${e.message}` })))
      return DataDir.of(DataDir.make(root))
    }),
  )
}
