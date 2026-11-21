import { Config, Console, Effect, Option, Runtime, Schema } from "effect"
import { importLegacy } from "./importLegacy/run.ts"
import type { ImportOptions } from "./importLegacy/run.ts"

// `huntaway import-legacy --from <old data folder> [--data-dir <new folder>] [--check] [--force] [--rehearsal] [--db <file>]
// [--replace]` (docs/plan/11-migration.md, The importer). The work is `importLegacy/run.ts`; this takes the flags (bin.ts
// has them, and loads this file to run the command), says what happened, and exits 1 when `--check` finds a failure.

/** The command's own way out: what it says is already on stdout or stderr, so the runtime only takes its exit code. */
class ImportExit extends Schema.TaggedError<ImportExit, { readonly brand: unique symbol }>()("ImportExit", { code: Schema.Int }) {
  readonly [Runtime.errorReported] = false
  get [Runtime.errorExitCode](): number {
    return this.code
  }
}

/** The command, with `--data-dir` as given: the new server's default folder without one. */
export const importLegacyMain = (args: Omit<ImportOptions, "dataDir"> & { readonly dataDir: Option.Option<string> }) =>
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
    if (result.replaced !== null) yield* Console.log(`The board that was in ${dataDir} is set aside in ${result.replaced}.`)
    if (!result.checkOnly) yield* Console.log(`Imported ${r.from}/${r.database} into ${dataDir}${r.rehearsal ? " as a rehearsal (read-only)" : ""}:\n${tables}`)
    yield* Console.log(
      `${r.failures.length} failures, ${r.json.length} JSON values the new schema does not read, ${r.notes.length} notes${r.check === null ? "" : `; the check found ${r.check.problems.length} problems`}. The report is ${result.reportFile}.`,
    )
    return yield* args.check && !result.passes ? new ImportExit({ code: 1 }) : Effect.void
  })
