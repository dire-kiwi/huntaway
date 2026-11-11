import { spawnSync } from "node:child_process"
import { Effect, FileSystem, Layer, Option, Schema } from "effect"
import type { Duration } from "effect"
import { SecureRandom } from "effect/crypto"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { ProfileId, RunId, TaskId, Timestamp } from "@huntaway/contracts"
import { runsLayer } from "huntaway-server/src/Main.ts"
import type { ServerConfigShape } from "huntaway-server/src/platform/ServerConfig.ts"
import type { Run, RunKind } from "huntaway-server/src/runs/Run.ts"
import { RunDir } from "huntaway-server/src/runs/RunDir.ts"
import type { RunExit } from "huntaway-server/src/runs/RunDir.ts"
import { RunOutput } from "huntaway-server/src/runs/RunOutput.ts"
import { RunRepo } from "huntaway-server/src/runs/RunRepo.ts"
import { TestPlatform } from "./TestBoard.ts"

// The scripted agent for service tests (docs/plan/10-testing.md; replaces the old runner/testing.ts): a run as if
// ia-shim had started it (a row and a folder with an empty `out.jsonl` and `input.jsonl`), with no process behind it.
// The test writes its output, reads what the server sent it, and ends it.

const AT = Timestamp.make("2026-11-12T00:00:00.000Z")

const Json = Schema.fromJsonString(Schema.Unknown)

/** The runs area on the platform (an in-memory database, a temp data folder), with `output` handling runs' lines. No reactor reads `Changes`, so a test can. */
export const TestRuns = <E = never, R = never>(output?: Layer.Layer<RunOutput, E, R>, overrides: Partial<ServerConfigShape> = {}) =>
  runsLayer<E, R | RunRepo>(output ?? RunOutput.layerLog).pipe(Layer.provideMerge(TestPlatform(overrides)))

/** A task to hang runs on: a profile "p" (made once) and a task in no project. */
export const fakeTask = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const random = yield* SecureRandom.SecureRandom
  const profile = ProfileId.make("p")
  const task = TaskId.make(yield* random.uuidV4())
  yield* sql`INSERT OR IGNORE INTO profiles (id, name, created_at) VALUES (${profile}, 'p', ${AT})`
  yield* sql`INSERT INTO tasks (id, profile_id, title, status, running, last_activity_at, created_at, updated_at)
    VALUES (${task}, ${profile}, 'A task', 'in_progress', 1, ${AT}, ${AT}, ${AT})`
  return task
}).pipe(Effect.orDie)

export interface FakeAgentOptions {
  /** The task the run is for (default: a new one). */
  readonly task?: TaskId
  readonly kind?: RunKind
  /** It takes input as it works (`input.jsonl`); default true. */
  readonly input?: boolean
  /** Output it had written before the test starts. */
  readonly output?: string
  /** Bytes of it already applied (`out_offset`). */
  readonly offset?: number
}

export interface FakeAgent {
  /** The run as it started: `running`. */
  readonly run: Run
  readonly dir: string
  /** The agent writes these lines to its output: values as JSON, strings as they are. */
  readonly write: (lines: ReadonlyArray<unknown>) => Effect.Effect<void>
  /** The agent writes raw text to its output. */
  readonly writeRaw: (text: string) => Effect.Effect<void>
  /** What the server has sent it after its prompt, one value per line. */
  readonly input: Effect.Effect<ReadonlyArray<unknown>>
  readonly inputClosed: Effect.Effect<boolean>
  /** It exits (its shim writes `exit`; default code 0). */
  readonly end: (exit?: RunExit) => Effect.Effect<void>
  /** Its shim vanished without writing `exit`: `shim.pid` names a process that is not running. */
  readonly shimGone: Effect.Effect<void>
  /** The run's row now. */
  readonly row: Effect.Effect<Run>
}

/** A pid no process has (above Linux's and macOS's maximum). */
export const DEAD_PID = 999_999_999

export const fakeAgent = (options: FakeAgentOptions = {}) =>
  Effect.gen(function* () {
    const repo = yield* RunRepo
    const dir = yield* RunDir
    const fs = yield* FileSystem.FileSystem
    const random = yield* SecureRandom.SecureRandom
    const task = options.task ?? (yield* fakeTask)
    const id = RunId.make(yield* random.uuidV4())
    yield* repo.insert({ id, task_id: task, kind: options.kind ?? "prompt", created_at: AT })
    yield* repo.setPhase(id, "running")
    if (options.offset !== undefined) yield* repo.saveOffset(id, options.offset)
    yield* dir.make(id)
    yield* dir.writeHeader(id)
    yield* dir.writePrompt(id, "")
    const path = dir.path(id)
    yield* fs.writeFileString(`${path}/out.jsonl`, options.output ?? "")
    if (options.input ?? true) yield* dir.createInput(id)

    const row = repo.get(id).pipe(Effect.flatMap((found) => (Option.isSome(found) ? Effect.succeed(found.value) : Effect.die(`run ${id} is gone`))))
    const writeRaw = (text: string) => fs.writeFileString(`${path}/out.jsonl`, text, { flag: "a" }).pipe(Effect.orDie)
    const encode = Schema.encodeEffect(Json)
    const write = (lines: ReadonlyArray<unknown>) =>
      Effect.forEach(lines, (line) => (typeof line === "string" ? Effect.succeed(line) : encode(line)), { concurrency: 1 }).pipe(
        Effect.orDie,
        Effect.flatMap((encoded) => writeRaw(encoded.map((line) => `${line}\n`).join(""))),
      )
    const input = dir.input(id).pipe(
      Effect.flatMap((text) =>
        Effect.forEach(
          text.split("\n").filter((line) => line !== ""),
          (line) => Schema.decodeEffect(Json)(line),
          { concurrency: 1 },
        ),
      ),
      Effect.orDie,
    )
    return {
      run: yield* row,
      dir: path,
      write,
      writeRaw,
      input,
      inputClosed: dir.inputClosed(id),
      end: (exit: RunExit = { code: 0, signal: null }) => dir.writeExit(id, exit).pipe(Effect.orDie),
      shimGone: fs.writeFileString(`${path}/shim.pid`, String(DEAD_PID)).pipe(Effect.orDie),
      row,
    } satisfies FakeAgent
  })

/** The top of this checkout. */
export const REPO_ROOT = decodeURIComponent(new URL("../../../", import.meta.url).pathname)

/** The fake `claude` (bin/fake-claude): the program for whole-server tests and test servers. */
export const FAKE_CLAUDE = `${REPO_ROOT}packages/testing/bin/fake-claude`

/**
 * The checkout's ia-shim, built with cargo first (`cargo build -p ia-shim`, quick when it is up to date); null without
 * cargo, for tests that need a real shim to skip. Synchronous, for `describe.skipIf` and `beforeAll`.
 */
export const ensureShim = (): string | null => {
  const built = spawnSync("cargo", ["build", "-q", "-p", "ia-shim"], { cwd: REPO_ROOT, stdio: "inherit" })
  return built.status === 0 ? `${REPO_ROOT}target/debug/ia-shim` : null
}

/**
 * Wait for `effect` while moving the test clock on by `step` at a time, so that a loop that sleeps between passes
 * (a run's follower) makes its passes while files it reads are written outside the clock.
 */
export const whileTicking = <A, E, R>(effect: Effect.Effect<A, E, R>, step: Duration.Input = "200 millis") =>
  Effect.raceFirst(effect, Effect.forever(TestClock.adjust(step).pipe(Effect.andThen(Effect.yieldNow))).pipe(Effect.andThen(Effect.never)))
