import { assert } from "@effect/vitest"
import { DateTime, Effect, Layer } from "effect"
import { Mac } from "effect/crypto"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql"
import { TestClock } from "effect/testing"
import { Timestamp } from "@huntaway/contracts"
import type { AutomationRun, NewAutomation, Profile, Project, Task } from "@huntaway/contracts"
import { tempDir, TestBoard } from "@huntaway/testing"
import type { ServerConfigShape } from "../../platform/ServerConfig.ts"
import { Profiles } from "../../profiles/Profiles.ts"
import { Projects } from "../../projects/Projects.ts"
import { TaskRepo } from "../../tasks/TaskRepo.ts"
import { AutomationRepo } from "../AutomationRepo.ts"
import type { StoredAutomation, StoredRun } from "../AutomationRepo.ts"
import { Automations } from "../Automations.ts"
import { Scheduler } from "../Scheduler.ts"
import { fromLocal, isoOf, naive, parseTime } from "../schedule.ts"
import { Webhooks } from "../Webhooks.ts"
import type { WebhookAnswer } from "../Webhooks.ts"

// What the automations' tests share (the old automations/tests.test.ts and tests/routines.test.ts helpers): a board in
// New Zealand's time zone (whose daylight saving the old tests made by hand), a profile and project to automate, and
// deliveries through `Webhooks` as the route makes them.

export const NZ = DateTime.zoneMakeNamedUnsafe("Pacific/Auckland")

export const utc = (s: string): number => parseTime(s) ?? assert.fail(`not a time: ${s}`)

/** 2026-10-01 13:00 in New Zealand: when the tests' board starts. */
export const NOW = utc("2026-10-01T00:00:00Z")

/** A local time in New Zealand, `YYYY-MM-DD HH:MM`. */
export const nz = (s: string): number => {
  const [d = "", t = ""] = s.split(" ")
  const [y = 0, mo = 0, da = 0] = d.split("-").map(Number)
  const [h = 0, mi = 0] = t.split(":").map(Number)
  return fromLocal(NZ, naive(y, mo, da, h, mi) ?? assert.fail(s)) ?? assert.fail(s)
}

/**
 * The whole board's services in New Zealand's time zone. Its clock is set to `NOW` before it's built (`atNow`): moved on
 * after, its loops (the thread pruner's hours) would each run once for every hour since 1970.
 */
export const boardLayer = (config: Partial<ServerConfigShape> = {}) => TestBoard(config).pipe(Layer.provide(DateTime.layerCurrentZone(NZ)))

/** The test clock at `NOW`, then `effect`. */
export const atNow = <A, E, R>(effect: Effect.Effect<A, E, R>) => TestClock.setTime(NOW).pipe(Effect.andThen(effect))

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

export const profile = (name: string) => Effect.flatMap(Profiles, (p) => p.create({ name })).pipe(Effect.orDie)

/** A project of `p`'s on a new folder. */
export const project = (p: Profile, name: string, key: string) =>
  Effect.gen(function* () {
    const dir = yield* tempDir
    return yield* (yield* Projects).create({ profile_id: p.id, name, key, repo_path: `${dir}/${name}` })
  }).pipe(Effect.orDie)

/** A profile "work" and its project Web (`WEB`). */
export const setup = Effect.gen(function* () {
  const p = yield* profile("work")
  return { profile: p, project: yield* project(p, "web", "WEB") }
})

export const create = (p: Project, input: NewAutomation) => Effect.flatMap(Automations, (a) => a.create({ _tag: "Project", id: p.id }, input))

export const get = (a: Pick<StoredAutomation, "id">) => Effect.flatMap(AutomationRepo, (r) => r.get(a.id)).pipe(Effect.map((x) => x ?? assert.fail("gone")))

/** The project's tasks (not review threads), oldest first. */
export const tasksOf = (p: Project) =>
  Effect.map(
    Effect.flatMap(TaskRepo, (r) => r.projectTasks(p.id)),
    (all) => all.filter((t) => t.kind === "task").toSorted((a, b) => a.number - b.number),
  )

/** An automation's runs, oldest first. */
export const runsOf = (a: Pick<StoredAutomation, "id">) =>
  Effect.map(
    Effect.flatMap(AutomationRepo, (r) => r.runs(a.id, 5000)),
    (runs) => runs.toReversed(),
  )

export const statuses = (a: Pick<StoredAutomation, "id">) => Effect.map(runsOf(a), (runs) => runs.map((r) => r.status))

export const lastRun = (a: Pick<StoredAutomation, "id">) => Effect.map(runsOf(a), (runs) => runs.at(-1) ?? assert.fail("no run"))

export const setNext = (a: Pick<StoredAutomation, "id">, at: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE automations SET next_run_at = ${isoOf(at)} WHERE id = ${a.id}`
  }).pipe(Effect.orDie)

/** Sets columns of an automation's row, as the old tests' `db.run` did. */
export const sqlRun = (statement: (sql: SqlClient.SqlClient) => Effect.Effect<unknown, SqlError.SqlError>) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => statement(sql)).pipe(Effect.orDie, Effect.asVoid)

export const tick = (now: number) => Effect.flatMap(Scheduler, (s) => s.tick(now))

/** A run, as the board stored it. */
export const run = (id: string) => Effect.flatMap(AutomationRepo, (r) => r.getRun(id)).pipe(Effect.map((x) => x ?? assert.fail(`no run ${id}`)))

/** A delivery to `a` from outside, as the route takes it (headers in lower case). */
export const deliver = (
  a: { readonly id: string; readonly token: string },
  headers: Readonly<Record<string, string>>,
  body: string,
  contentType = "application/json",
) => Effect.flatMap(Webhooks, (w) => w.deliver(a.id, a.token, { "content-type": contentType, ...headers }, null, new TextEncoder().encode(body)))

/** The run a delivery was answered with (`running`, its action carrying on by itself), once it's over. */
export const ran = (answer: WebhookAnswer) =>
  Effect.gen(function* () {
    assert.strictEqual(answer.body["status"], "running", `answered ${answer.status}`)
    yield* (yield* Automations).idle
    return yield* run(String(answer.body["run"]))
  })

/** `sha256=<hex>` of `body` with `secret`, as GitHub signs. */
export const sign = (secret: string, body: string) =>
  Effect.gen(function* () {
    const mac = yield* Mac.Mac
    const key = yield* Mac.key(Mac.hmacSha256, new TextEncoder().encode(secret))
    const tag = yield* mac.sign(key, new TextEncoder().encode(body))
    return `sha256=${[...tag].map((b) => b.toString(16).padStart(2, "0")).join("")}`
  }).pipe(Effect.orDie)

/** A new run's row for `a`, as the old tests' `Run_new` made it. */
export const newRun = (
  a: Pick<StoredAutomation, "id">,
  source: AutomationRun["source"],
  status: AutomationRun["status"],
  at: number,
  id: string,
): StoredRun => ({
  id,
  automation_id: a.id,
  source,
  status,
  detail: null,
  outcome: null,
  cost_usd: null,
  task_id: null,
  delivery_id: null,
  event: null,
  count: 1,
  batch_id: null,
  due_at: null,
  created_at: Timestamp.make(isoOf(at)),
  finished_at: null,
  agent_run_id: null,
  batch_key: null,
  payload: null,
})

export const insertRun = (r: StoredRun) => Effect.flatMap(AutomationRepo, (repo) => repo.insertRun(r))

/** The title of each task, sorted. */
export const titles = (ts: ReadonlyArray<Task>) => ts.map((t) => t.title).toSorted()
