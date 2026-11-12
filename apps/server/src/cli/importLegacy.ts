import { Config, Console, Effect, Option, Runtime, Schema } from "effect"
import { Command, Flag } from "effect/cli"
import { serveFlags } from "../platform/ServerConfig.ts"
import { importLegacy } from "./importLegacy/run.ts"

// `huntaway import-legacy --from <old data folder> [--data-dir <new folder>] [--check] [--force] [--rehearsal] [--db <file>]`
// (docs/plan/11-migration.md, The importer). The work is `importLegacy/run.ts`; this decodes the flags, says what
// happened, and exits 1 when `--check` finds a failure.

/** The command's own way out: what it says is already on stdout or stderr, so the runtime only takes its exit code. */
class ImportExit extends Schema.TaggedError<ImportExit, { readonly brand: unique symbol }>()("ImportExit", { code: Schema.Int }) {
  readonly [Runtime.errorReported] = false
  get [Runtime.errorExitCode](): number {
    return this.code
  }
}

const flags = {
  from: Flag.String("from").pipe(Flag.withDescription("The old server's data folder (e.g. ~/.local/share/issue-agent); only read")),
  dataDir: serveFlags.dataDir,
  check: Flag.Boolean("check").pipe(
    Flag.withDescription("Check the import against the old database and exit 1 if the report has a failure; on a folder already imported, check it alone"),
    Flag.withDefault(false),
  ),
  force: Flag.Boolean("force").pipe(Flag.withDescription("Record live runs as interrupted instead of refusing"), Flag.withDefault(false)),
  rehearsal: Flag.Boolean("rehearsal").pipe(
    Flag.withDescription("Beside a running old server: a board with no identity or credentials of the old host's, which only a read-only server opens"),
    Flag.withDefault(false),
  ),
  database: Flag.String("db").pipe(Flag.withDescription("Which old database file, when the old folder has more than one"), Flag.optional),
}

export const importLegacyCommand = Command.make("import-legacy", flags, (args) =>
  Effect.gen(function* () {
    // The new server's default folder, as `serve` finds it (platform/ServerConfig.ts).
    const home = yield* Config.String("HOME").pipe(Config.withDefault(""))
    const dataHome = yield* Config.String("XDG_DATA_HOME").pipe(Config.withDefault(`${home}/.local/share`))
    const dataDir = Option.getOrElse(args.dataDir, () => `${dataHome}/huntaway-effect`)
    const result = yield* importLegacy({ ...args, dataDir })
    const r = result.report
    const tables = Object.entries(r.tables)
      .map(([t, c]) => `  ${t}: ${c.written} written${c.withheld > 0 ? `, ${c.withheld} withheld` : ""} (old ${c.old})`)
      .join("\n")
    if (!result.checkOnly) yield* Console.log(`Imported ${r.from}/${r.database} into ${dataDir}${r.rehearsal ? " as a rehearsal (read-only)" : ""}:\n${tables}`)
    yield* Console.log(
      `${r.failures.length} failures, ${r.json.length} JSON values the new schema does not read, ${r.notes.length} notes${r.check === null ? "" : `; the check found ${r.check.problems.length} problems`}. The report is ${result.reportFile}.`,
    )
    return yield* args.check && !result.passes ? new ImportExit({ code: 1 }) : Effect.void
  }),
).pipe(Command.withDescription("Import an old Huntaway board's data folder into a new one (docs/guide/switching.md)"))
