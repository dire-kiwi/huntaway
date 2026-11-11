import { SqliteClient } from "@effect/sql-sqlite-node"
import { Config, Console, DateTime, Effect, FileSystem, Layer, Option, Redacted, Result, Runtime, Schema } from "effect"
import { Command, Flag } from "effect/cli"
import { FetchHttpClient } from "effect/http"
import type { HttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { VERSION } from "../platform/ServerConfig.ts"
import { collect } from "../platform/telemetry/backfill.ts"
import { chTime, query, splitUrl, statements } from "../platform/telemetry/clickhouse.ts"
import type { ClickHouseError, Target } from "../platform/telemetry/clickhouse.ts"
import { SCHEMA, TABLES } from "../platform/telemetry/schema.ts"

// `huntaway telemetry …` (the old telemetry/cli.ts, HA-284; docs/plan/06-server.md, The CLI):
//
// - `init --url http://admin:pass@host:8123[/database]`: creates the database and tables (platform/telemetry/schema.ts),
//   or brings them up to date. Run it with a login that can (an admin's), not a host's writer, which can only insert.
// - `test [--url …]`: whether a login can insert into the tables, as the host's Test button checks.
// - `backfill [--data-dir DIR] [--url …] [--dry-run]`: sends a host's history from before telemetry was turned on.
//
// A password left out of the URL is read from HUNTAWAY_TELEMETRY_PASSWORD. (The old one also asked on a terminal; this
// one doesn't, so a script never hangs on it.)

class TelemetryCliExit extends Schema.TaggedError<TelemetryCliExit, { readonly brand: unique symbol }>()("TelemetryCliExit", { code: Schema.Int }) {
  readonly [Runtime.errorReported] = false
  get [Runtime.errorExitCode](): number {
    return this.code
  }
}

const fail = (command: string, message: string) =>
  Console.error(`huntaway telemetry ${command}: ${message}`).pipe(Effect.andThen(Effect.fail(new TelemetryCliExit({ code: 1 }))))

const urlFlag = Flag.String("url").pipe(
  Flag.withDescription("ClickHouse: http://USER[:PASSWORD]@HOST:8123[/DATABASE] (default $HUNTAWAY_TELEMETRY_URL)"),
  Flag.withFallbackConfig(Config.String("HUNTAWAY_TELEMETRY_URL")),
  Flag.optional,
)

/** The ClickHouse a URL names, with its password from the URL or HUNTAWAY_TELEMETRY_PASSWORD. */
const targetOf = Effect.fnUntraced(function* (command: string, raw: string) {
  const parsed = splitUrl(raw)
  if (Result.isFailure(parsed)) return yield* fail(command, parsed.failure)
  const u = parsed.success
  const fromEnv = yield* Config.String("HUNTAWAY_TELEMETRY_PASSWORD").pipe(Config.withDefault(""))
  const target: Target = { url: u.url, database: u.database ?? "huntaway", user: u.user, password: Redacted.make(u.password === "" ? fromEnv : u.password) }
  return target
})

const required = (command: string, url: Option.Option<string>) =>
  Option.isSome(url) ? targetOf(command, url.value) : fail(command, "give ClickHouse's address with --url")

const hintOf = (e: ClickHouseError) => (e.code === 60 || e.code === 81 ? " (run `huntaway telemetry init` with an admin login)" : "")

/** With a layer of its own (a command is its own entry point), built for the call. */
const using =
  <ROut, LE>(layer: Layer.Layer<ROut, LE>) =>
  <A, E>(effect: Effect.Effect<A, E, ROut>) =>
    Effect.scoped(Effect.flatMap(Layer.build(layer), (context) => Effect.provideContext(effect, context)))

const withHttp = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) => using(FetchHttpClient.layer)(effect)

/** Creates the database and the tables, or brings them up to date (every statement can run again). */
const init = Effect.fn("telemetry.init")(function* (url: Option.Option<string>) {
  const t = yield* required("init", url)
  if (!/^[A-Za-z_]\w*$/.test(t.database)) return yield* fail("init", `"${t.database}" isn't a ClickHouse database name`)
  const run = Effect.gen(function* () {
    yield* query(t, `CREATE DATABASE IF NOT EXISTS ${t.database}`, { inDatabase: false })
    for (const st of statements(SCHEMA)) yield* query(t, st)
    return (yield* query(t, "SELECT name FROM system.tables WHERE database = currentDatabase() ORDER BY name FORMAT TSV")).split("\n").filter((l) => l !== "")
  })
  const have = yield* withHttp(run).pipe(Effect.catch((e) => fail("init", `${e.reason}${hintOf(e)}`)))
  const missing = TABLES.filter((x) => !have.includes(x))
  if (missing.length > 0) return yield* fail("init", `these tables still aren't there: ${missing.join(", ")}`)
  yield* Console.log(`${t.url}: database ${t.database} has ${TABLES.join(", ")}.`)
  return yield* Console.log(`Each host writes with a login of its own that can only insert, e.g.:
  CREATE USER huntaway_<host> IDENTIFIED BY '…' HOST IP '192.168.0.0/16';
  GRANT INSERT ON ${t.database}.* TO huntaway_<host>;
and is set up on its Settings page (Telemetry), or with --telemetry-url.`)
})

/** An empty insert into each table, as a host's Test button does into `events`. */
const test = Effect.fn("telemetry.test")(function* (url: Option.Option<string>) {
  const t = yield* required("test", url)
  let failed = 0
  for (const table of TABLES) {
    const r = yield* withHttp(query(t, `INSERT INTO ${table} FORMAT JSONEachRow`, { body: "" })).pipe(Effect.result)
    if (Result.isSuccess(r)) yield* Console.log(`${table}: ok`)
    else {
      failed++
      yield* Console.log(`${table}: ${r.failure.reason}${hintOf(r.failure)}`)
    }
  }
  return failed > 0 ? yield* new TelemetryCliExit({ code: 1 }) : undefined
})

/** A host's history from before it sent, for the profiles that send, straight to ClickHouse (not through the outbox). */
const backfill = Effect.fn("telemetry.backfill")(function* (dataDirFlag: Option.Option<string>, url: Option.Option<string>, dryRun: boolean) {
  const fs = yield* FileSystem.FileSystem
  const home = yield* Config.String("HOME").pipe(Config.withDefault("/"))
  const dataHome = yield* Config.String("XDG_DATA_HOME").pipe(Config.withDefault(`${home}/.local/share`))
  const fromEnv = yield* Config.String("HUNTAWAY_DATA_DIR").pipe(Config.option)
  const dir = Option.getOrElse(
    Option.orElse(dataDirFlag, () => fromEnv),
    () => `${dataHome}/huntaway-effect`,
  )
  const file = `${dir}/board.db`
  if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) return yield* fail("backfill", `no board database in ${dir} (give --data-dir)`)
  const hostId = (yield* fs.readFileString(`${dir}/host_id`).pipe(Effect.orElseSucceed(() => ""))).trim()
  if (hostId === "") return yield* fail("backfill", `${dir} has no host_id: is it a board's data folder?`)
  const name = yield* Config.String("HUNTAWAY_NAME").pipe(Config.withDefault(""))
  const hostName = name.trim() !== "" ? name.trim() : (yield* fs.readFileString("/proc/sys/kernel/hostname").pipe(Effect.orElseSucceed(() => "host"))).trim()

  const work = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const setting = (key: string) =>
      sql.unsafe<{ readonly value: string }>("SELECT value FROM settings WHERE key = ?", [key]).pipe(
        Effect.map((rows) => rows[0]?.value ?? null),
        Effect.orDie,
      )
    // ClickHouse: --url's, else the host's own settings.
    let target: Target | null = Option.isSome(url) ? yield* targetOf("backfill", url.value) : null
    const saved = yield* setting("telemetry_url")
    if (target === null && saved !== null) {
      const database = yield* setting("telemetry_database")
      target = {
        url: saved,
        database: database ?? "huntaway",
        user: (yield* setting("telemetry_user")) ?? "",
        password: Redacted.make((yield* setting("telemetry_password")) ?? ""),
      }
    }
    if (target === null && !dryRun) return yield* fail("backfill", "this host has no ClickHouse set up (Settings → the host → Telemetry): give one with --url")
    const until = (yield* setting("telemetry_since")) ?? DateTime.formatIso(yield* DateTime.now)
    const batches = yield* collect(until)
    let total = 0
    for (const b of batches) {
      total += b.rows.length
      if (dryRun || target === null) continue
      const body = yield* Effect.forEach(
        b.rows,
        (r) =>
          Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            ...r,
            host_id: hostId,
            host_name: hostName,
            version: VERSION,
            ts: chTime(typeof r["ts"] === "string" ? r["ts"] : ""),
          }),
        { concurrency: 1 },
      ).pipe(Effect.orDie)
      const t = target
      yield* withHttp(
        query(t, `INSERT INTO ${b.table} FORMAT JSONEachRow`, {
          body: body.join("\n"),
          settings: { input_format_skip_unknown_fields: 1, date_time_input_format: "best_effort", insert_deduplication_token: `backfill:${hostId}:${b.key}` },
          timeout: "120 seconds",
        }),
      ).pipe(Effect.catch((e) => fail("backfill", `${e.reason}${hintOf(e)}`)))
    }
    const kinds = new Map<string, number>()
    for (const b of batches) for (const r of b.rows) kinds.set(String(r["event"]), (kinds.get(String(r["event"])) ?? 0) + 1)
    const list = [...kinds].map(([k, n]) => `${n} ${k}`).join(", ")
    return yield* Console.log(`${dryRun ? "Would send" : "Sent"} ${total} rows from before ${until}: ${list === "" ? "nothing" : list}.`)
  })
  // Read-only, beside the running server.
  return yield* using(Layer.orDie(SqliteClient.layer({ filename: file, readonly: true })))(work)
})

const initCommand = Command.make("init", { url: urlFlag }, ({ url }) => init(url)).pipe(
  Command.withDescription("Create the database (default huntaway) and its tables, or bring them up to date: give it a login that can, such as an admin's"),
)
const testCommand = Command.make("test", { url: urlFlag }, ({ url }) => test(url)).pipe(
  Command.withDescription("Check that a login can insert into the tables, as a host's writer must"),
)
const backfillCommand = Command.make(
  "backfill",
  {
    dataDir: Flag.String("data-dir").pipe(
      Flag.withDescription("The board's data folder (default $HUNTAWAY_DATA_DIR, else ~/.local/share/huntaway-effect)"),
      Flag.optional,
    ),
    url: urlFlag,
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDescription("Count what would be sent, and send nothing"), Flag.withDefault(false)),
  },
  ({ dataDir, url, dryRun }) => backfill(dataDir, url, dryRun),
).pipe(Command.withDescription("Send this host's history from before telemetry was turned on, for the profiles that send"))

export const telemetryCommand = Command.make("telemetry").pipe(
  Command.withDescription("Set up and check the ClickHouse telemetry goes to (a password left out of --url is read from HUNTAWAY_TELEMETRY_PASSWORD)"),
  Command.withSubcommands([initCommand, testCommand, backfillCommand]),
)
