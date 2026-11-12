import { SqliteClient } from "@effect/sql-sqlite-node"
import { Context, DateTime, Effect, FileSystem, Layer, Option, Path, Predicate, Schema } from "effect"
import type { Scope } from "effect"
import { SqlClient } from "effect/sql"
import { Timestamp } from "@huntaway/contracts"
import { Backup } from "../../platform/Backup.ts"
import type { ColumnValue } from "../../platform/columns.ts"
import { Db } from "../../platform/Db.ts"
import { IMPORT_FILE, ImportRecordJson, OLD_DATABASE_NAMES, processesWithOpen, readImportRecord } from "../../platform/ImportRecord.ts"
import type { ImportRecord } from "../../platform/ImportRecord.ts"
import { loadMigrations, runMigrations } from "../../platform/Migrations.ts"
import { StartupError } from "../../platform/StartupError.ts"
import { checkImport } from "./check.ts"
import { FAMILIES } from "./families/index.ts"
import { issueText } from "./family.ts"
import type { Family, FamilyIo, ImportContext, NewRow, TableCheck } from "./family.ts"
import { makeOldDb } from "./oldDb.ts"
import type { OldDb } from "./oldDb.ts"
import { makeReport, ReportJson, reportPasses } from "./report.ts"
import type { Report } from "./report.ts"

// `huntaway import-legacy` (docs/plan/11-migration.md, The importer): the refusals, a copy of the old database to read,
// the families writing `board.db.partial`, the check, the files, `board.db`, the report and `import.json`. The old
// folder is only read: the database is read from a copy made in the new folder (a byte copy of a stopped server's
// files, or for a rehearsal an online backup through a read-only connection), so not even SQLite's `-shm` is written
// beside the old file.

export interface ImportOptions {
  /** The old data folder. */
  readonly from: string
  /** The new data folder. */
  readonly dataDir: string
  /** `--check`: check the result and fail if the report has a failure; on its own, check an existing import. */
  readonly check: boolean
  /** `--force`: record live runs as interrupted rather than refusing. */
  readonly force: boolean
  /** `--rehearsal`: beside a running old server, a board only a read-only server opens. */
  readonly rehearsal: boolean
  /** `--db`: which old database file, when the old folder has more than one. */
  readonly database: Option.Option<string>
  /** The families to run, for tests (every family of `FAMILIES` when not given). */
  readonly families?: ReadonlyArray<Family> | undefined
}

/** The schema version and named migrations of the old repository at f2298f0c, the one the importer reads. */
export const OLD_VERSION = 130
export const KNOWN_NAMED: ReadonlySet<string> = new Set([
  "2026-11-11-background-work",
  "2026-11-11-desktop-ops",
  "2026-11-11-profile-tint",
  "2026-11-11-synced-setting-versions",
])

/** Run folders kept: those of runs that ended in the last 14 days (token counts and failure tails are read from them). */
const RECENT_RUN_DAYS = 14
/** Rows written to the new board in one transaction. */
const BATCH = 500

const ReportText = Schema.fromJsonString(ReportJson)
const encodeReport = Schema.encodeEffect(ReportText)
const encodeRecord = Schema.encodeEffect(ImportRecordJson)

const refuse = (reasons: ReadonlyArray<string>) => new StartupError({ reason: `import-legacy refuses:\n${reasons.map((r) => `  - ${r}`).join("\n")}` })

/** With a layer of its own built for the call (a command is its own entry point). */
const using =
  <ROut, LE>(layer: Layer.Layer<ROut, LE>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | LE, Exclude<Exclude<R, ROut>, Scope.Scope>> =>
    Effect.scoped(Effect.flatMap(Layer.build(layer), (context) => Effect.provideContext(effect, context)))

const sqliteAt = (filename: string, readonly = false) => Layer.orDie(SqliteClient.layer({ filename, readonly }))

/** A connection of its own to `filename`, for the scope. */
const clientAt = (filename: string, readonly = false) =>
  Effect.map(Layer.build(sqliteAt(filename, readonly)), (context) => Context.get(context, SqlClient.SqlClient))

/** Which old database file to read: `--db`, else the only one there. */
const pickDatabase = Effect.fnUntraced(function* (from: string, wanted: Option.Option<string>) {
  const fs = yield* FileSystem.FileSystem
  if (Option.isSome(wanted)) {
    if (!(yield* fs.exists(`${from}/${wanted.value}`))) return yield* refuse([`${from} has no ${wanted.value}`])
    return wanted.value
  }
  const present: Array<string> = []
  for (const name of OLD_DATABASE_NAMES) if (yield* fs.exists(`${from}/${name}`)) present.push(name)
  const only = present[0]
  if (only === undefined) return yield* refuse([`${from} has no old board database (${OLD_DATABASE_NAMES.join(", ")})`])
  if (present.length > 1) return yield* refuse([`${from} has ${present.join(" and ")}: say which the old server used with --db <file>`])
  return only
})

/**
 * A copy of the old database at `copy`: for a rehearsal an online backup through a read-only connection (the old server
 * may be writing it), otherwise the database file and its `-wal` copied byte for byte (the old server is stopped; opening
 * the copy applies the log).
 */
const copyOldDatabase = Effect.fnUntraced(function* (file: string, copy: string, rehearsal: boolean) {
  const fs = yield* FileSystem.FileSystem
  for (const f of [copy, `${copy}-wal`, `${copy}-shm`]) yield* fs.remove(f, { force: true })
  if (rehearsal) {
    yield* using(sqliteAt(file, true))(
      Effect.gen(function* () {
        const client = yield* SqliteClient.SqliteClient
        yield* client.backup(copy)
      }),
    ).pipe(Effect.orDie)
    return
  }
  yield* fs.copyFile(file, copy)
  if (yield* fs.exists(`${file}-wal`)) yield* fs.copyFile(`${file}-wal`, `${copy}-wal`)
})

/** Keys for a refusal: the first 30, and how many more. */
const listed = (keys: ReadonlyArray<string>) => (keys.length <= 30 ? keys.join(", ") : `${keys.slice(0, 30).join(", ")} and ${keys.length - 30} more`)

/** What the old database must be before it is imported; every reason it is not. */
const preconditions = Effect.fnUntraced(function* (old: OldDb, options: ImportOptions) {
  const reasons: Array<string> = []
  if (old.version !== OLD_VERSION) reasons.push(`the old database is at schema version ${old.version}, not ${OLD_VERSION}: update the old server first`)
  const unknown = old.named.filter((n) => !KNOWN_NAMED.has(n))
  if (unknown.length > 0) reasons.push(`the old database has named migrations this importer does not know: ${unknown.join(", ")}`)
  if (!options.force && !options.rehearsal && old.tables.has("runs")) {
    const live = yield* old.query(`SELECT id FROM runs WHERE status <> 'exited' ORDER BY rowid`)
    if (live.length > 0)
      reasons.push(`${live.length} runs are live (${listed(live.map((r) => String(r["id"])))}): wait for them to end, or --force records them as interrupted`)
  }
  // A task not yet moved onto items whose thread has no `messages` rows has nothing to convert: the old server leaves
  // every task made since its last start on messages until its next start, and moving one with no rows rebuilds nothing.
  if (old.columns("tasks").has("thread_source") && old.tables.has("messages")) {
    const onMessages = yield* old.query(`SELECT ${taskKeySql} AS key FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.thread_source <> 'items' AND EXISTS (SELECT 1 FROM messages m WHERE m.task_id = t.id) ORDER BY t.created_at`)
    if (onMessages.length > 0)
      reasons.push(
        `${onMessages.length} tasks' threads are not yet items (${listed(onMessages.map((r) => String(r["key"])))}): start the old server once and let it move them (docs/plan/11-migration.md, Threads not yet items)`,
      )
  }
  if (old.columns("threads").has("error")) {
    const broken = yield* old.query(`SELECT ${taskKeySql} AS key FROM threads h JOIN tasks t ON t.id = h.task_id LEFT JOIN projects p ON p.id = t.project_id
      WHERE h.error IS NOT NULL ORDER BY t.created_at`)
    if (broken.length > 0)
      reasons.push(
        `${broken.length} threads stopped on a fault (${listed(broken.map((r) => String(r["key"])))}): rebuild them on the old server (huntaway threads-rebuild <key>)`,
      )
  }
  return reasons
})

/** A task's key in the old database, for the report: its project's key and number, else its id. */
export const taskKeySql = `CASE WHEN p.key IS NOT NULL THEN p.key || '-' || t.number ELSE t.id END`

/** What SQLite said about a statement that failed (a constraint's name, say), else the error's own message. */
const sqliteMessage = (e: { readonly message: string; readonly reason?: unknown }): string => {
  const cause = Predicate.hasProperty(e.reason, "cause") ? e.reason.cause : undefined
  return Predicate.hasProperty(cause, "message") && typeof cause.message === "string" ? cause.message : e.message
}

const quoteName = (name: string) => `"${name.replaceAll('"', '""')}"`

/** The writer of the new board's rows: each checked, then inserted in batches. */
const makeWriter = (sql: SqlClient.SqlClient, report: Report) => {
  const write = (table: string, check: TableCheck, rows: Iterable<NewRow>) =>
    Effect.gen(function* () {
      const decodeRow = Schema.decodeUnknownResult(check.row)
      const jsonChecks = Object.entries(check.json ?? {}).map(
        ([column, schema]) => [column, Schema.decodeUnknownResult(Schema.fromJsonString(schema))] as const,
      )
      let written = 0
      let batch: Array<NewRow> = []
      const flush = Effect.gen(function* () {
        const rowsNow = batch
        batch = []
        if (rowsNow.length === 0) return
        written += yield* sql
          .withTransaction(
            Effect.gen(function* () {
              let n = 0
              for (const row of rowsNow) {
                const columns = Object.keys(row)
                const statement = `INSERT INTO ${quoteName(table)} (${columns.map(quoteName).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`
                const ok = yield* sql
                  .unsafe(
                    statement,
                    columns.map((c) => row[c] ?? null),
                  )
                  .pipe(
                    Effect.as(true),
                    Effect.catchTag("SqlError", (e) => Effect.as(report.failure(table, check.key(row), `insert: ${sqliteMessage(e)}`.slice(0, 500)), false)),
                  )
                if (ok) n++
              }
              return n
            }),
          )
          .pipe(Effect.orDie)
      })
      for (const row of rows) {
        const decoded = decodeRow(row)
        if (decoded._tag === "Failure") {
          yield* report.failure(table, check.key(row), `new row: ${issueText(decoded.failure)}`)
          continue
        }
        for (const [column, decode] of jsonChecks) {
          const value = row[column]
          if (typeof value !== "string") continue
          const result = decode(value)
          if (result._tag === "Failure") yield* report.json(table, `${check.key(row)}.${column}`, issueText(result.failure))
        }
        batch.push(row)
        if (batch.length >= BATCH) yield* flush
      }
      yield* flush
      yield* report.written(table, written)
      return written
    })
  return write
}

/**
 * Rows that point at nothing (the old tables had fewer foreign keys): each is a failure in the report and is deleted, so
 * the board opens with its foreign keys on. Repeated, since a deleted row may leave others pointing at nothing.
 */
const dropDangling = Effect.fnUntraced(function* (sql: SqlClient.SqlClient, report: Report) {
  for (let round = 0; round < 16; round++) {
    const broken = yield* sql.unsafe<{ readonly table: string; readonly parent: string; readonly fkid: number }>(`PRAGMA foreign_key_check`).pipe(Effect.orDie)
    if (broken.length === 0) return
    const seen = new Set<string>()
    for (const b of broken) {
      const id = `${b.table}:${b.fkid}`
      if (seen.has(id)) continue
      seen.add(id)
      const fks = yield* sql
        .unsafe<{ readonly id: number; readonly from: string; readonly to: string | null }>(`SELECT id, "from", "to" FROM pragma_foreign_key_list(?)`, [
          b.table,
        ])
        .pipe(Effect.orDie)
      const parts = fks.filter((f) => f.id === b.fkid)
      if (parts.length === 0) continue
      const where = parts.map((p) => `${quoteName(p.from)} IS NOT NULL`).join(" AND ")
      const target = parts.map((p) => quoteName(p.to ?? "rowid")).join(", ")
      const source = parts.map((p) => quoteName(p.from)).join(", ")
      const condition = `${where} AND (${source}) NOT IN (SELECT ${target} FROM ${quoteName(b.parent)})`
      const rows = yield* sql.unsafe<Record<string, unknown>>(`SELECT ${source} FROM ${quoteName(b.table)} WHERE ${condition}`).pipe(Effect.orDie)
      for (const r of rows) yield* report.failure(b.table, parts.map((p) => String(r[p.from])).join("/"), `points at no row of ${b.parent}`)
      yield* sql.unsafe(`DELETE FROM ${quoteName(b.table)} WHERE ${condition}`).pipe(Effect.orDie)
    }
  }
})

/** Copies `name` from the old folder to the new one, if it is there. */
const copyOver = Effect.fnUntraced(function* (from: string, to: string, name: string) {
  const fs = yield* FileSystem.FileSystem
  if (!(yield* fs.exists(`${from}/${name}`))) return false
  yield* fs.makeDirectory(to, { recursive: true, mode: 0o700 })
  yield* fs.copy(`${from}/${name}`, `${to}/${name}`, { overwrite: true, preserveTimestamps: true })
  return true
})

const readTrimmed = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* fs.exists(file))) return null
    const text = (yield* fs.readFileString(file)).trim()
    return text === "" ? null : text
  })

/**
 * The import, or with `--check` on a folder already imported from `from`, the check alone. `families` is for tests: a
 * family's test runs it after stand-ins for the families whose rows it points at.
 */
export const importLegacy = Effect.fn("importLegacy")(function* (options: ImportOptions, families: ReadonlyArray<Family> = FAMILIES) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  if (!(yield* fs.exists(options.from))) return yield* refuse([`there is no folder ${options.from}`])
  const from = yield* fs.realPath(options.from)
  yield* fs.makeDirectory(options.dataDir, { recursive: true, mode: 0o700 })
  const to = yield* fs.realPath(options.dataDir)
  if (to === from || to.startsWith(`${from}/`) || from.startsWith(`${to}/`))
    return yield* refuse([`the new folder ${to} and the old one ${from} must be separate folders`])
  const database = yield* pickDatabase(from, options.database)
  const oldFile = path.join(from, database)
  const boardFile = path.join(to, "board.db")
  const existing = yield* readImportRecord(to)
  const checkOnly = options.check && (yield* fs.exists(boardFile)) && Option.isSome(existing) && existing.value.from === from
  if (!checkOnly && (yield* fs.exists(boardFile)))
    return yield* refuse([`${to} has a board.db already: move it aside first (a board tried out there is not merged with an import)`])
  if (!options.rehearsal) {
    const open = yield* processesWithOpen(oldFile)
    if (open.length > 0)
      return yield* refuse([
        `processes ${open.join(", ")} have ${oldFile} open: stop the old server first (or rehearse beside it with --rehearsal, which makes a board only a read-only server opens)`,
      ])
  }
  const rehearsal = checkOnly && Option.isSome(existing) ? existing.value.rehearsal : options.rehearsal
  const now = DateTime.formatIso(yield* DateTime.now)
  const ctx: ImportContext = { oldDataDir: from, newDataDir: to, rehearsal, force: options.force, now }
  const copy = path.join(to, "legacy-copy.db")
  const partial = path.join(to, "board.db.partial")
  const reportFile = path.join(to, "import-report.json")
  const recordFile = path.join(to, IMPORT_FILE)
  yield* copyOldDatabase(oldFile, copy, rehearsal)
  const removeCopy = Effect.forEach([copy, `${copy}-wal`, `${copy}-shm`], (f) => fs.remove(f, { force: true }), { concurrency: 1, discard: true }).pipe(
    Effect.ignore,
  )
  const report = yield* makeReport({ from, database, at: now, rehearsal })
  // The check alone, on the copy and the board as they are.
  const checkAlone = Effect.scoped(
    Effect.gen(function* () {
      const old = yield* makeOldDb(yield* clientAt(copy))
      yield* report.checked(yield* checkImport(old, yield* clientAt(boardFile, true), ctx, report))
    }),
  )
  const importAll = Effect.gen(function* () {
    for (const f of [partial, `${partial}-wal`, `${partial}-shm`]) yield* fs.remove(f, { force: true })
    yield* using(sqliteAt(copy))(
      Effect.gen(function* () {
        const old = yield* makeOldDb(yield* SqlClient.SqlClient)
        const reasons = yield* preconditions(old, options)
        if (reasons.length > 0) return yield* refuse(reasons)
        return yield* using(Layer.provideMerge(Db.layerOver, sqliteAt(partial)))(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            const migrations = yield* loadMigrations
            // A new file: there is nothing to back up before migrating it.
            yield* using(Layer.succeed(Backup, Backup.of({ beforeMigrate: () => Effect.void })))(runMigrations(migrations))
            yield* sql`PRAGMA foreign_keys = OFF`.pipe(Effect.orDie)
            const io: FamilyIo = {
              ctx,
              old,
              report,
              write: makeWriter(sql, report),
              exec: (statement: string, params: ReadonlyArray<ColumnValue> = []) => sql.unsafe<Record<string, unknown>>(statement, params).pipe(Effect.orDie),
            }
            for (const family of options.families ?? families) {
              yield* Effect.logInfo(`importing ${family.name}`)
              yield* family.run(io)
            }
            yield* dropDangling(sql, report)
            yield* sql`PRAGMA foreign_keys = ON`.pipe(Effect.orDie)
            if (options.check) yield* report.checked(yield* checkImport(old, sql, ctx, report))
            yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`.pipe(Effect.orDie)
          }),
        )
      }),
    )
    // `board.db` appears last, once the files and `import.json` are there: a folder with a board but no record would
    // start as an acting board (no guard, no read-only server), and a new try would be refused for its `board.db`.
    yield* copyFiles(from, to, rehearsal, partial, now)
    const record: ImportRecord = {
      from,
      at: Timestamp.make(now),
      old_host_id: rehearsal ? null : yield* readTrimmed(path.join(from, "host_id")),
      rehearsal,
      database,
    }
    yield* fs.writeFileString(recordFile, `${yield* encodeRecord(record)}\n`, { mode: 0o600 })
    for (const f of [`${partial}-wal`, `${partial}-shm`]) yield* fs.remove(f, { force: true })
    yield* fs.rename(partial, boardFile)
  })
  // A failed import leaves no board and no record (what it copied stays, and a new try copies it again).
  const undo = Effect.forEach([partial, `${partial}-wal`, `${partial}-shm`, recordFile], (f) => fs.remove(f, { force: true }), {
    concurrency: 1,
    discard: true,
  }).pipe(Effect.ignore)
  yield* (checkOnly ? checkAlone : importAll).pipe(
    Effect.ensuring(removeCopy),
    Effect.onError(() => (checkOnly ? Effect.void : undo)),
  )
  const result = yield* report.get
  yield* fs.writeFileString(reportFile, `${yield* encodeReport(result)}\n`, { mode: 0o600 })
  return { report: result, passes: reportPasses(result), reportFile, checkOnly }
})

/**
 * The files the new server finds under its own folder (docs/plan/11-migration.md, the table at the top): the identity
 * and `ssh/` (not in a rehearsal, which gets an identity of its own on first start), attachments, skill sources, and
 * the folders of runs that ended in the last 14 days.
 */
const copyFiles = Effect.fnUntraced(function* (from: string, to: string, rehearsal: boolean, board: string, now: string) {
  const fs = yield* FileSystem.FileSystem
  if (!rehearsal) {
    for (const name of ["host_id", "auth_token", "hub_token"]) {
      if (yield* copyOver(from, to, name)) yield* fs.chmod(`${to}/${name}`, 0o600)
    }
    yield* copyOver(from, to, "ssh")
  }
  yield* copyOver(from, to, "attachments")
  yield* copyOver(from, to, "skill-sources")
  const recent = yield* using(sqliteAt(board, true))(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return yield* sql<{
        readonly id: string
      }>`SELECT id FROM runs WHERE ended_at IS NULL OR julianday(ended_at) >= julianday(${now}) - ${RECENT_RUN_DAYS}`.pipe(Effect.orDie)
    }),
  )
  for (const run of recent) yield* copyOver(`${from}/runs`, `${to}/runs`, run.id).pipe(Effect.ignore)
})
