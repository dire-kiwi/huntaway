import { assert, describe, it } from "@effect/vitest"
import { Context, DateTime, Effect, FileSystem, Layer, Option, Result, Schema } from "effect"
import { TestClock } from "effect/testing"
import { SqlClient } from "effect/sql"
import { ProfileId, RunId, TaskId } from "@huntaway/contracts"
import { fakeClickHouse, tempDir, TestPlatform } from "@huntaway/testing"
import type { FakeClickHouse } from "@huntaway/testing"
import { Identity } from "./Identity.ts"
import { LIMITS, stringMap, Telemetry } from "./Telemetry.ts"
import { badRows, ClickHouseError, setupError, splitUrl, statements } from "./telemetry/clickhouse.ts"
import { SCHEMA, TABLES } from "./telemetry/schema.ts"
import { TelemetryRepo } from "./TelemetryRepo.ts"

// The old telemetry.test.ts (HA-284), against a fake ClickHouse (`@huntaway/testing`'s `fakeClickHouse`). The exporter
// isn't running here: each test flushes and samples itself, on the test clock. The agents' events (mapping and the
// receiver) are in telemetry/otlp.test.ts, the backfill in telemetry/backfill.test.ts, the events other areas send
// beside their areas' code. Dropped: the case against a real ClickHouse (`IA_TEST_CLICKHOUSE_URL`): no test reaches a
// real one; `a_codex_run_s_app_server_gets_its_overrides_from_its_spec` is codex/spec.ts's and rpc.ts's (M5's tests).

const AT = "2026-11-08T10:00:00.000Z"
const JsonRow = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

/** A board with a profile that sends (`personal`, with a project HA and its task HA-1) and one that doesn't (`work`). */
const board = (url: string | null, opts: { readonly titles?: boolean } = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const telemetry = yield* Telemetry
    const p = ProfileId.make("personal")
    const work = ProfileId.make("work")
    yield* sql`INSERT INTO profiles (id, name, created_at, telemetry, telemetry_titles) VALUES (${p}, 'personal', ${AT}, 1, ${opts.titles === false ? 0 : 1})`
    yield* sql`INSERT INTO profiles (id, name, created_at) VALUES (${work}, 'work', ${AT})`
    yield* sql`INSERT INTO projects (id, profile_id, name, key, repo_path, scratch_path, worktrees_root, created_at)
      VALUES ('proj', ${p}, 'Huntaway', 'HA', '/tmp/x', '/tmp/x', '/tmp/x', ${AT})`
    const task = TaskId.make("11111111-1111-1111-1111-111111111111")
    const workTask = TaskId.make("22222222-2222-2222-2222-222222222222")
    yield* sql`INSERT INTO tasks (id, profile_id, project_id, number, title, status, last_activity_at, created_at, updated_at)
      VALUES (${task}, ${p}, 'proj', 1, 'Secret plans', 'todo', ${AT}, ${AT}, ${AT})`
    yield* sql`INSERT INTO tasks (id, profile_id, title, status, last_activity_at, created_at, updated_at)
      VALUES (${workTask}, ${work}, 'Work thing', 'todo', ${AT}, ${AT}, ${AT})`
    if (url !== null) yield* telemetry.update({ url, user: "huntaway_h", password: "pw" })
    return { sql, telemetry, p, task, workTask, hostId: (yield* Identity).hostId }
  }).pipe(Effect.orDie)

const outbox = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ readonly id: number; readonly target: string; readonly row: string }>`SELECT id, target, row FROM telemetry_outbox ORDER BY id`
  return rows.map((r) => ({
    id: r.id,
    target: r.target,
    row: Option.getOrElse(Schema.decodeOption(JsonRow)(r.row), (): Readonly<Record<string, unknown>> => ({})),
  }))
}).pipe(Effect.orDie)

/** Another exporter over the same database: as after a restart, or with other limits. */
const another = (limits = LIMITS) => Layer.build(Layer.fresh(Telemetry.layerWith(limits))).pipe(Effect.map((ctx) => Context.get(ctx, Telemetry)))

const tokenOf = (f: FakeClickHouse, i: number) => f.inserts[i]?.params.get("insert_deduplication_token") ?? ""

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.scoped, Effect.provide(TestPlatform()))

describe("Telemetry", () => {
  it.effect("nothing is kept or sent without a ClickHouse", () =>
    run(
      Effect.gen(function* () {
        const { telemetry, task } = yield* board(null)
        yield* telemetry.emit("events", { event: "server_start" })
        yield* telemetry.taskEvent(task, { event: "run_start" })
        yield* telemetry.log("warn", "huntaway", "something")
        assert.strictEqual((yield* outbox).length, 0)
        assert.strictEqual((yield* telemetry.status).state, "off")
      }),
    ),
  )

  it.effect("only a profile that sends has its tasks' rows, and their titles only if it says", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fakeClickHouse
        const { telemetry, task, workTask, sql, p, hostId } = yield* board(f.url)
        yield* telemetry.taskEvent(task, { event: "task_status", status: "in_progress" })
        yield* telemetry.taskEvent(workTask, { event: "task_status", status: "in_progress" })
        let rows = (yield* outbox).map((r) => r.row)
        assert.strictEqual(rows.length, 1, "the work profile doesn't send")
        const first = rows[0] ?? {}
        assert.strictEqual(first["profile"], "personal")
        assert.strictEqual(first["task_key"], "HA-1")
        assert.strictEqual(first["project_key"], "HA")
        assert.strictEqual(first["task_title"], "Secret plans")
        assert.strictEqual(first["host_id"], hostId)
        assert.match(String(first["ts"]), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}$/)
        yield* sql`UPDATE profiles SET telemetry_titles = 0 WHERE id = ${p}`
        yield* telemetry.taskEvent(task, { event: "task_status", status: "done" })
        rows = (yield* outbox).map((r) => r.row)
        assert.strictEqual(rows[1]?.["task_title"], "", "titles off")
        yield* sql`UPDATE profiles SET telemetry = 0 WHERE id = ${p}`
        yield* telemetry.taskEvent(task, { event: "task_status", status: "todo" })
        assert.strictEqual((yield* outbox).length, 2, "the profile stopped sending")
      }),
    ),
  )

  it.effect("a batch goes in one insert with the login and a token, and its rows go", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fakeClickHouse
        const { telemetry, hostId } = yield* board(f.url)
        for (let i = 0; i < 5; i++) yield* telemetry.emit("events", { event: "error", error: `e${i}`, attrs: { n: i, empty: "" } })
        yield* telemetry.emit("metrics", { name: "rss_bytes", value: 1, labels: {} })
        yield* telemetry.flush
        assert.strictEqual(f.inserts.length, 2, "one insert for each table")
        const [ev, m] = f.inserts
        assert.strictEqual(ev?.query, "INSERT INTO events FORMAT JSONEachRow")
        assert.strictEqual(ev?.params.get("database"), "huntaway")
        assert.strictEqual(ev?.headers["x-clickhouse-user"], "huntaway_h")
        assert.strictEqual(ev?.headers["x-clickhouse-key"], "pw")
        assert.strictEqual(ev?.params.get("input_format_skip_unknown_fields"), "1")
        assert.isTrue(tokenOf(f, 0).startsWith(`${hostId}:events:1-5:`))
        assert.strictEqual(ev?.rows.length, 5)
        assert.deepStrictEqual(ev?.rows[2]?.["attrs"], { n: "2" }, "Map values are strings, without empty ones")
        assert.strictEqual(m?.query, "INSERT INTO metrics FORMAT JSONEachRow")
        assert.strictEqual((yield* outbox).length, 0)
        const st = yield* telemetry.status
        assert.strictEqual(st.state, "ok")
        assert.strictEqual(st.sent, 6)
      }),
    ),
  )

  it.effect("large batches are gzipped", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fakeClickHouse
        const { telemetry } = yield* board(f.url)
        for (let i = 0; i < 50; i++) yield* telemetry.emit("logs", { level: "warn", module: "x", message: "y".repeat(100) })
        yield* telemetry.flush
        assert.strictEqual(f.inserts[0]?.headers["content-encoding"], "gzip")
        assert.strictEqual(f.inserts[0]?.rows.length, 50)
      }),
    ),
  )

  it.effect("a failed batch is sent again as it was, with its token, after a restart too", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fakeClickHouse
        const { telemetry, hostId } = yield* board(f.url)
        for (let i = 0; i < 3; i++) yield* telemetry.emit("events", { event: "error", error: `first ${i}` })
        f.fail = { status: 503, code: 0 }
        yield* telemetry.flush
        const st = yield* telemetry.status
        assert.strictEqual(st.state, "retrying")
        assert.isNotNull(st.next_attempt_at, "it backs off")
        assert.strictEqual((yield* outbox).length, 3, "kept")
        // Rows that come meanwhile, and a restart.
        yield* telemetry.emit("events", { event: "error", error: "later" })
        f.fail = null
        const again = yield* another()
        yield* again.flush
        assert.strictEqual(f.inserts.length, 2)
        assert.deepStrictEqual(
          f.inserts[0]?.rows.map((r) => r["error"]),
          ["first 0", "first 1", "first 2"],
          "the batch that failed, as it was",
        )
        assert.isTrue(tokenOf(f, 0).startsWith(`${hostId}:events:1-3:`))
        assert.deepStrictEqual(
          f.inserts[1]?.rows.map((r) => r["error"]),
          ["later"],
        )
        assert.isTrue(tokenOf(f, 1).startsWith(`${hostId}:events:4-4:`))
      }),
    ),
  )

  it.effect("ids are never used again, so a new batch never has an old token", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fakeClickHouse
        const { telemetry, hostId } = yield* board(f.url)
        yield* telemetry.emit("events", { event: "error", error: "a" })
        yield* telemetry.flush
        // The outbox is empty now; its next row mustn't be id 1 again (AUTOINCREMENT).
        yield* telemetry.emit("events", { event: "error", error: "b" })
        yield* telemetry.flush
        assert.deepStrictEqual(
          [0, 1].map((i) => tokenOf(f, i).split(":").slice(0, 3).join(":")),
          [`${hostId}:events:1-1`, `${hostId}:events:2-2`],
        )
      }),
    ),
  )

  it.effect("a setup error waits long and says why; rows ClickHouse can't read are dropped and counted", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fakeClickHouse
        const { telemetry } = yield* board(f.url)
        yield* telemetry.emit("events", { event: "error", error: "x" })
        f.fail = { status: 403, code: 516 }
        yield* telemetry.flush
        let st = yield* telemetry.status
        assert.strictEqual(st.state, "error")
        assert.match(st.last_error ?? "", /Code 516: failed on purpose/)
        const now = DateTime.toEpochMillis(yield* DateTime.now)
        const next = Option.map(DateTime.make(st.next_attempt_at ?? ""), DateTime.toEpochMillis)
        assert.isAbove(Option.getOrElse(next, () => 0) - now, 25 * 60_000, "it waits half an hour")
        assert.strictEqual(st.queued["events"], 1)
        // The exporter's own warning isn't teed to `logs` (it'd log itself in a loop).
        yield* telemetry.drainLogs
        assert.strictEqual((yield* outbox).length, 1)

        f.fail = { status: 400, code: 27, times: 1 }
        // A change of settings tries again at once.
        yield* telemetry.update({ user: "huntaway_h" })
        yield* telemetry.flush
        const rows = yield* outbox
        assert.strictEqual(rows.length, 1, "the bad batch went; its drop is counted in an event")
        assert.strictEqual(rows[0]?.row["event"], "telemetry_dropped")
        assert.deepStrictEqual(rows[0]?.row["attrs"], { rows: "1" })
        yield* telemetry.flush
        assert.strictEqual(f.inserts.at(-1)?.rows[0]?.["event"], "telemetry_dropped")
        st = yield* telemetry.status
        assert.strictEqual(st.dropped, 0)
      }),
    ),
  )

  it.effect("the outbox keeps to its limit, dropping the oldest", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fakeClickHouse
        yield* board(f.url)
        const telemetry = yield* another({ rows: 10, bytes: 1 << 20 })
        const repo = yield* TelemetryRepo
        f.fail = { status: 503, code: 0 }
        for (let i = 0; i < 25; i++) yield* telemetry.emit("events", { event: "error", error: `${i}` })
        yield* telemetry.flush
        const left = (yield* outbox).map((r) => r.row["error"])
        assert.strictEqual(left.length, 9)
        assert.strictEqual(left[0], "16", "the oldest went")
        assert.strictEqual(Number(yield* repo.setting("telemetry_dropped")), 16)
      }),
    ),
  )

  it.effect("turning it off deletes what waits; a URL with a login or a database is refused", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fakeClickHouse
        const { telemetry } = yield* board(f.url)
        yield* telemetry.emit("events", { event: "error", error: "x" })
        yield* telemetry.update({ url: null })
        assert.strictEqual((yield* outbox).length, 0)
        assert.strictEqual((yield* telemetry.status).state, "off")
        const login = yield* Effect.flip(telemetry.update({ url: "http://u:p@host:8123" }))
        assert.match(login.reason, /own fields/)
        const database = yield* Effect.flip(telemetry.update({ url: "http://host:8123/db" }))
        assert.match(database.reason, /own field/)
        const name = yield* Effect.flip(telemetry.update({ database: "no-dashes" }))
        assert.strictEqual(name.field, "database")
      }),
    ),
  )

  it.effect("the password is stored as typed and never given back", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fakeClickHouse
        const { telemetry } = yield* board(f.url)
        const repo = yield* TelemetryRepo
        yield* telemetry.update({ password: " spaced " })
        assert.strictEqual(yield* repo.setting("telemetry_password"), " spaced ")
        const st = yield* telemetry.status
        assert.isTrue(st.has_password)
        assert.notInclude(Object.values(st).map(String).join(" "), "spaced")
      }),
    ),
  )

  it.effect("the logs tee takes lines at its level, at most a hundred a second, and not those of tasks that don't send", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fakeClickHouse
        const { telemetry, task, workTask } = yield* board(f.url)
        const logs = Effect.map(outbox, (rows) => rows.filter((r) => r.target === "logs").map((r) => r.row))
        // The host's level is `warn` unless it says.
        yield* telemetry.log("info", "huntaway", "listening")
        yield* telemetry.log("warn", "tokens", "purpose=title couldn't keep")
        yield* telemetry.log("error", "server", "something failed: boom")
        yield* telemetry.log("error", "runs", `task=${task} run=11111111-2222-3333-4444-555555555555: broke`)
        yield* telemetry.log("error", "runs", `task=${workTask}: broke in /home/me/work`)
        yield* telemetry.log("warn", "telemetry", "sending to ClickHouse failed")
        let got = yield* logs
        assert.deepStrictEqual(
          got.map((r) => [r["level"], r["module"], r["message"]]),
          [
            ["warn", "tokens", "purpose=title couldn't keep"],
            ["error", "server", "something failed: boom"],
            ["error", "runs", `task=${task} run=11111111-2222-3333-4444-555555555555: broke`],
          ],
        )
        assert.strictEqual(got[2]?.["task_id"], task)
        assert.strictEqual(got[2]?.["run_id"], "11111111-2222-3333-4444-555555555555")
        // At `info`, info lines go too.
        yield* telemetry.update({ logs: "info" })
        yield* telemetry.log("info", "huntaway", "listening")
        assert.strictEqual((yield* logs).at(-1)?.["message"], "listening")
        // A storm: 100 in a second, the rest counted.
        const sql = yield* SqlClient.SqlClient
        yield* sql`DELETE FROM telemetry_outbox`
        yield* TestClock.adjust("1 second")
        for (let i = 0; i < 150; i++) yield* telemetry.log("warn", "x", `line ${i}`)
        got = yield* logs
        assert.strictEqual(got.length, 100)
        yield* TestClock.adjust("1 second")
        yield* telemetry.log("warn", "x", "after")
        got = yield* logs
        assert.match(String(got[100]?.["message"]), /^50 log lines weren't sent/)
        assert.strictEqual(got[101]?.["message"], "after")
      }),
    ),
  )

  it.effect("the platform's logger queues lines for the tee at the host's level", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fakeClickHouse
        const { telemetry } = yield* board(f.url)
        // The platform's layer has the tee beside the server's logger: whatever runs over it logs to both.
        yield* Effect.logWarning("something odd").pipe(Effect.annotateLogs({ module: "tasks" }))
        yield* Effect.logInfo("just so")
        yield* Effect.logWarning("its own").pipe(Effect.annotateLogs({ module: "telemetry" }))
        yield* telemetry.drainLogs
        const logs = (yield* outbox).filter((r) => r.target === "logs").map((r) => [r.row["level"], r.row["module"], r.row["message"]])
        assert.deepStrictEqual(logs, [["warn", "tasks", "something odd"]])
      }),
    ),
  )

  it.effect("samples are rows in metrics", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fakeClickHouse
        const { telemetry } = yield* board(f.url)
        yield* telemetry.sample
        const names = (yield* outbox).filter((r) => r.target === "metrics").map((r) => r.row["name"])
        for (const n of ["rss_bytes", "heap_used_bytes", "runs_running", "tasks_needing_attention", "telemetry_outbox_rows"]) assert.include(names, n)
      }),
    ),
  )

  it.effect("the test says what is wrong", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fakeClickHouse
        const { telemetry } = yield* board(f.url)
        assert.deepStrictEqual(yield* telemetry.test({}), { ok: true, error: null })
        assert.strictEqual(f.inserts[0]?.query, "INSERT INTO events FORMAT JSONEachRow")
        f.fail = { status: 404, code: 60 }
        const r = yield* telemetry.test({ url: f.url, user: "other", password: "x" })
        assert.isFalse(r.ok)
        assert.match(r.error ?? "", /telemetry init/)
      }),
    ),
  )

  it.effect("--telemetry-url is used while the settings name none, without its login in the status", () =>
    Effect.gen(function* () {
      const f = yield* fakeClickHouse
      const url = f.url.replace("http://", "http://writer:secret@")
      const status = yield* Effect.gen(function* () {
        const telemetry = yield* Telemetry
        yield* telemetry.emit("events", { event: "server_start" })
        yield* telemetry.flush
        return yield* telemetry.status
      }).pipe(Effect.provide(TestPlatform({ telemetryUrl: `${url}/hosts` })))
      assert.strictEqual(status.from, "flag")
      assert.strictEqual(status.flag_url, `${f.url}/hosts`)
      assert.strictEqual(f.inserts[0]?.params.get("database"), "hosts")
      assert.strictEqual(f.inserts[0]?.headers["x-clickhouse-user"], "writer")
    }).pipe(Effect.scoped),
  )

  it.effect("runs get the variables only when their profile sends and their login doesn't send its own", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fakeClickHouse
        const { telemetry, task, workTask } = yield* board(f.url)
        const fs = yield* FileSystem.FileSystem
        const identity = yield* Identity
        const dir = yield* tempDir
        const claude = `${dir}/claude`
        const codex = `${dir}/codex`
        yield* fs.makeDirectory(claude, { recursive: true })
        yield* fs.makeDirectory(codex, { recursive: true })
        const runId = RunId.make("run-1")
        const env = new Map(yield* telemetry.claudeEnv(task, runId, claude))
        assert.strictEqual(env.get("CLAUDE_CODE_ENABLE_TELEMETRY"), "1")
        assert.match(env.get("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT") ?? "", /^http:\/\/127\.0\.0\.1:\d+\/api\/otlp\/run-1\/v1\/logs$/)
        assert.strictEqual(env.get("OTEL_EXPORTER_OTLP_LOGS_HEADERS"), `Authorization=Bearer%20${yield* identity.runSecret(runId)}`)
        assert.strictEqual(env.get("OTEL_METRICS_EXPORTER"), "none")
        assert.strictEqual((yield* telemetry.claudeEnv(workTask, RunId.make("run-2"), claude)).length, 0, "the work profile doesn't send")
        const o = yield* telemetry.codexOverrides(task, runId, codex)
        assert.strictEqual(o.length, 3)
        assert.match(
          o[0] ?? "",
          /^otel\.exporter=\{otlp-http=\{endpoint="http:\/\/127\.0\.0\.1:\d+\/api\/otlp\/run-1\/v1\/logs",protocol="json",headers=\{Authorization="Bearer [0-9a-f]+"\}\}\}$/,
        )
        // A login that sends its own.
        yield* fs.writeFileString(`${claude}/settings.json`, '{"env":{"OTEL_EXPORTER_OTLP_ENDPOINT":"https://corp"}}')
        assert.strictEqual((yield* telemetry.claudeEnv(task, runId, claude)).length, 0)
        yield* fs.writeFileString(`${codex}/config.toml`, 'model = "x"\n\n[otel]\nenvironment = "corp"\n')
        assert.strictEqual((yield* telemetry.codexOverrides(task, runId, codex)).length, 0)
        // The host's agents setting off.
        yield* fs.writeFileString(`${claude}/settings.json`, "{}")
        assert.strictEqual((yield* telemetry.claudeEnv(task, runId, claude)).length, 4 + 4)
        yield* telemetry.update({ agents: false })
        assert.strictEqual((yield* telemetry.claudeEnv(task, runId, claude)).length, 0)
      }),
    ),
  )

  it.effect("a board tool call is the server's to send only if it began once sending had", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fakeClickHouse
        yield* TestClock.adjust("1 hour")
        const { telemetry } = yield* board(f.url)
        const repo = yield* TelemetryRepo
        const since = (yield* repo.setting("telemetry_since")) ?? ""
        assert.isFalse(yield* telemetry.beganSince("1970-01-01T00:00:00.000Z"))
        assert.isTrue(yield* telemetry.beganSince(since))
      }),
    ),
  )
})

const e = (status: number, code: number | null) => new ClickHouseError({ reason: "", status, code })

describe("ClickHouse", () => {
  it("urls split into their login and database, and errors are classed", () => {
    assert.deepStrictEqual(Result.getOrUndefined(splitUrl("http://a%40b:p%3Aw@host:8123/db/")), {
      url: "http://host:8123",
      user: "a@b",
      password: "p:w",
      database: "db",
    })
    assert.deepStrictEqual(Result.getOrUndefined(splitUrl("https://host")), { url: "https://host", user: "", password: "", database: null })
    assert.isTrue(Result.isFailure(splitUrl("ftp://x")))
    assert.isTrue(setupError(e(403, 516)))
    assert.isTrue(setupError(e(404, 115)), "an unknown setting")
    assert.isTrue(setupError(e(400, 62)), "a syntax error")
    assert.isTrue(badRows(e(400, 27)))
    assert.isTrue(!setupError(e(503, 0)) && !badRows(e(503, 0)))
    assert.isFalse(setupError(e(429, 0)))
    assert.strictEqual(statements(SCHEMA).length, TABLES.length)
    assert.deepStrictEqual(stringMap({ a: 1, b: "", c: null, d: { e: true }, f: false }), { a: "1", d: '{"e":true}', f: "false" })
  })
})
