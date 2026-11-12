import { Effect, FileSystem, Option, Path, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Timestamp } from "@huntaway/contracts"

// What `huntaway import-legacy` leaves in the folder it filled (docs/plan/11-migration.md, The importer; The guard), and
// the one fact both the importer and the guard ask of the machine: which processes have a database file open.

/** The file the importer writes and every start reads (`ImportGuard`). */
export const IMPORT_FILE = "import.json"

/**
 * `import.json`: where the board came from, when, the old host's id (null in a rehearsal, which keeps no identity of
 * the old host's), and whether it is a rehearsal, which only a read-only server opens.
 */
export const ImportRecord = Schema.Struct({
  from: Schema.String,
  at: Timestamp,
  old_host_id: Schema.NullOr(Schema.String),
  rehearsal: Schema.Boolean,
  /** The old database file the import read (`huntaway-2.db`, or an older name), under `from`. */
  database: Schema.String,
})
export type ImportRecord = typeof ImportRecord.Type

export const ImportRecordJson = Schema.fromJsonString(ImportRecord)

/** The old server's database files, newest name first (`apps/server/src/db/file.ts` of the old repository). */
export const OLD_DATABASE_NAMES: ReadonlyArray<string> = ["huntaway-2.db", "huntaway.db", "issue-agent.db"]

/** `import.json` of the folder `root`, if it has one. A file that does not decode is a startup failure for the caller. */
export const readImportRecord = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = path.join(root, IMPORT_FILE)
  if (!(yield* fs.exists(file))) return Option.none<ImportRecord>()
  const text = yield* fs.readFileString(file)
  return Option.some(yield* Schema.decodeEffect(ImportRecordJson)(text))
})

const isPid = (name: string) => /^\d+$/.test(name)

/**
 * The processes other than this one that have `file` open (as `copy-live-board.sh` finds them: the links in
 * `/proc/<pid>/fd` on Linux, `lsof` on macOS). The `-wal` and `-shm` files are not asked about: a reader of the database
 * has the database itself open. Processes this user cannot look into are not seen.
 */
export const processesWithOpen = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  const real = yield* fs.realPath(file)
  if (process.platform === "darwin") {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const out = yield* spawner.string(ChildProcess.make("lsof", ["-t", "--", real], { stdin: "ignore", stderr: "ignore" })).pipe(Effect.orElseSucceed(() => ""))
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => isPid(l) && Number(l) !== process.pid)
      .map(Number)
  }
  const pids = (yield* fs.readDirectory("/proc").pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))).filter(
    (p) => isPid(p) && Number(p) !== process.pid,
  )
  const found = yield* Effect.forEach(
    pids,
    (pid) =>
      Effect.gen(function* () {
        const fds = yield* fs.readDirectory(`/proc/${pid}/fd`)
        for (const fd of fds) {
          const target = yield* fs.readLink(`/proc/${pid}/fd/${fd}`).pipe(Effect.orElseSucceed(() => ""))
          if (target === real) return Number(pid)
        }
        return null
      }).pipe(Effect.orElseSucceed(() => null)),
    { concurrency: 16 },
  )
  return found.filter((pid): pid is number => pid !== null)
})
