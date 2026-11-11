import { assert, describe, it } from "@effect/vitest"
import { jsonText } from "./claude/tools.ts"
import { Effect, FileSystem, Layer } from "effect"
import { SecureRandom } from "effect/crypto"
import { SqlClient } from "effect/sql"
import { RunId } from "@huntaway/contracts"
import type { TaskId } from "@huntaway/contracts"
import { fakeTask, TestBoard } from "@huntaway/testing"
import { DataDir } from "../platform/DataDir.ts"
import { TokenRepo } from "./TokenRepo.ts"
import { Tokens } from "./Tokens.ts"

// The old agent/tokens/tests.test.ts's cases that go through the database and the run folders: runs counted once,
// oldest first for each task, from their output or their cost; scaled down to what the board charged; killed runs'
// tails; the cache writes' split columns. The counting's own cases are tokens/count.test.ts.

const TestLive = Tokens.layer.pipe(Layer.provideMerge(TokenRepo.layer), Layer.provideMerge(TestBoard()))
type Env = Tokens | SqlClient.SqlClient | DataDir | FileSystem.FileSystem | SecureRandom.SecureRandom

const run = <A, E>(effect: Effect.Effect<A, E, Env>) => effect.pipe(Effect.provide(TestLive))

const json = jsonText
const result = (session: string, models: unknown): string => json({ type: "result", subtype: "success", session_id: session, modelUsage: models })
const opus = (input: number, output: number, read: number, cost: number) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadInputTokens: read,
  cacheCreationInputTokens: 10,
  costUSD: cost,
  thinkingTokens: 1,
})
const opusSplit = (output: number, w1h: number, w5m: number) => ({
  ...opus(1, output, 100, 0.1),
  cacheCreationInputTokens: w1h + w5m,
  cacheCreationEphemeral1hInputTokens: w1h,
  cacheCreationEphemeral5mInputTokens: w5m,
})
const reply = (id: string, model: string, input: number, output: number) =>
  json({
    type: "assistant",
    parent_tool_use_id: null,
    message: { id, model, content: [{ type: "text", text: "…" }], usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 100 } },
  })
const init = () => json({ type: "system", subtype: "init", session_id: "s1" })
const tokenUsage = ([input, cached, output]: readonly [number, number, number]) => ({ inputTokens: input, cachedInputTokens: cached, outputTokens: output })
const usage = (thread: string, total: readonly [number, number, number], last: readonly [number, number, number]): string =>
  json({ method: "thread/tokenUsage/updated", params: { threadId: thread, tokenUsage: { total: tokenUsage(total), last: tokenUsage(last) } } })

interface RunOptions {
  /** Its output; none for a run whose folder is gone. */
  readonly lines?: ReadonlyArray<string>
  readonly exited?: boolean
  readonly cost?: number
  /** A Codex run (`codex.json`). */
  readonly codex?: boolean
}

/** A run of `task`, in the order they start. */
const newRun = (task: TaskId, o: RunOptions = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const dir = yield* DataDir
    const fs = yield* FileSystem.FileSystem
    const random = yield* SecureRandom.SecureRandom
    const id = RunId.make(yield* random.uuidV4())
    yield* sql`INSERT INTO runs (id, task_id, status, cost_usd, created_at) VALUES (${id}, ${task}, ${o.exited === false ? "running" : "exited"}, ${o.cost ?? 0},
      '2026-11-12T00:00:00.000Z')`
    if (o.lines !== undefined) {
      yield* fs.makeDirectory(dir.runDir(id), { recursive: true })
      yield* fs.writeFileString(`${dir.runDir(id)}/out.jsonl`, o.lines.join("\n"))
      if (o.codex === true) yield* fs.writeFileString(`${dir.runDir(id)}/codex.json`, json({ model: "gpt-6.1-sol" }))
    }
    return id
  }).pipe(Effect.orDie)

const rows = (id: RunId) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{
      readonly model: string
      readonly output_tokens: number
      readonly cost_usd: number | null
      readonly estimated: number
    }>`SELECT model, output_tokens, cost_usd, estimated FROM token_usage WHERE run_id = ${id} ORDER BY model`.pipe(
      Effect.map((all) => all.map((r) => [r.model, r.output_tokens, r.cost_usd, r.estimated !== 0] as const)),
      Effect.orDie,
    ),
  )

const near = (a: number | null | undefined, b: number) => a != null && Math.abs(a - b) < 1e-9

/** Counts runs of one task with these outputs, the last with the cost the board charged it, and gives each one's output tokens and whether they're estimated. */
const countedInDb = (outs: ReadonlyArray<ReadonlyArray<string>>, cost: number) =>
  Effect.gen(function* () {
    const task = yield* fakeTask
    const ids: Array<RunId> = []
    for (const [i, lines] of outs.entries()) ids.push(yield* newRun(task, { lines, ...(i === outs.length - 1 ? { cost } : {}) }))
    yield* (yield* Tokens).countPending(null)
    const out: Array<readonly [number, boolean]> = []
    for (const id of ids) {
      const r = yield* rows(id)
      out.push([r.reduce((s, x) => s + x[1], 0), r.some((x) => x[3])])
    }
    return out
  })

describe("Tokens", () => {
  it.effect("counts runs once, from their output or their cost", () =>
    run(
      Effect.gen(function* () {
        const tokens = yield* Tokens
        const sql = yield* SqlClient.SqlClient
        const task = yield* fakeTask
        yield* sql`UPDATE tasks SET model = 'opus' WHERE id = ${task}`
        const first = yield* newRun(task, { lines: [result("s1", { "claude-opus-5-5": opus(5, 100, 1000, 1.0) })] })
        // The second hasn't ended.
        const second = yield* newRun(task, { lines: [result("s1", { "claude-opus-5-5": opus(6, 160, 1500, 1.25) })], cost: 0.25, exited: false })
        // The third's folder is gone: it has its cost.
        const third = yield* newRun(task, { cost: 0.75 })

        // The others are counted, and the second waits.
        assert.strictEqual(yield* tokens.countPending(null), 2)
        yield* sql`UPDATE runs SET status = 'exited' WHERE id = ${second}`
        assert.strictEqual(yield* tokens.countPending(task), 1)
        assert.strictEqual(yield* tokens.countPending(null), 0)

        assert.deepStrictEqual(yield* rows(first), [["claude-opus-5-5", 100, 1.0, false]])
        // It went on from the first, though counted after the third.
        assert.deepStrictEqual(yield* rows(second), [["claude-opus-5-5", 60, 0.25, false]])
        assert.deepStrictEqual(yield* rows(third), [["opus", 0, 0.75, true]])
      }),
    ),
  )

  it.effect("a run counted from nothing is scaled to its cost", () =>
    run(
      Effect.gen(function* () {
        const task = yield* fakeTask
        // It resumed a session whose earlier runs' output is gone: its totals are all of them.
        const id = yield* newRun(task, { lines: [result("s1", { "claude-opus-5-5": opus(10, 400, 4000, 4.0) })], cost: 1.0 })
        yield* (yield* Tokens).countPending(null)
        const [row] = yield* rows(id)
        assert.deepStrictEqual([row?.[1], row?.[3]], [100, true])
        assert.isTrue(near(row?.[2], 1.0))
      }),
    ),
  )

  it.effect("a run killed before its result doesn't hide its session's totals", () =>
    run(
      Effect.gen(function* () {
        const counted = yield* countedInDb(
          [
            [init(), result("s1", { "claude-opus-5-5": opus(5, 100, 1000, 1.0) })],
            [init(), reply("m1", "claude-opus-5-5", 2, 40)],
            [init(), reply("m2", "claude-opus-5-5", 802, 30), result("s1", { "claude-opus-5-5": opus(9, 170, 2000, 1.5) })],
          ],
          0.5,
        )
        assert.deepStrictEqual(counted, [
          [100, false],
          [40, true],
          [30, false],
        ])
        // The killed run used a model the session hadn't, and Claude Code didn't keep it.
        const unkept = yield* countedInDb(
          [
            [init(), result("s1", { "claude-opus-5-5": opus(5, 100, 1000, 1.0) })],
            [init(), reply("m1", "claude-haiku-5-5", 2, 40)],
            [init(), result("s1", { "claude-opus-5-5": opus(9, 130, 2000, 1.5) })],
          ],
          0.5,
        )
        assert.deepStrictEqual(unkept, [
          [100, false],
          [40, true],
          [30, false],
        ])
      }),
    ),
  )

  it.effect("a resumed run's own requests say whether an unkept tail is in its totals, saved so", () =>
    run(
      Effect.gen(function* () {
        const a = [init(), result("s1", { "claude-opus-5-5": opus(5, 100, 1000, 1.0) })]
        const b = [init(), reply("m1", "claude-opus-5-5", 2, 40)]
        const lost = [init(), reply("m2", "claude-opus-5-5", 900, 100), result("s1", { "claude-opus-5-5": opus(905, 200, 1100, 1.5) })]
        assert.deepStrictEqual(yield* countedInDb([a, b, lost], 0.5), [
          [100, false],
          [40, true],
          [100, false],
        ])
      }),
    ),
  )

  it.effect("cache write splits are kept where known and null where not", () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const task = yield* fakeTask
        const split = yield* newRun(task, { lines: [result("s1", { "claude-opus-5-5": opusSplit(10, 300, 20) })] })
        const unknown = yield* newRun(task, { lines: [result("s2", { "claude-opus-5-5": opus(1, 10, 100, 0.1) })] })
        const codex = yield* newRun(task, { lines: [usage("main", [100, 40, 10], [100, 40, 10])], codex: true })
        yield* (yield* Tokens).countPending(null)
        const cols = (id: RunId) =>
          sql<{ readonly h: number | null; readonly m: number | null; readonly runtime: string }>`SELECT cache_write_1h_tokens AS h,
              cache_write_5m_tokens AS m, runtime FROM token_usage WHERE run_id = ${id}`.pipe(Effect.map((all) => all.map((r) => [r.h, r.m, r.runtime])))
        assert.deepStrictEqual(yield* cols(split), [[300, 20, "claude"]])
        assert.deepStrictEqual(yield* cols(unknown), [[null, null, "claude"]])
        assert.deepStrictEqual(yield* cols(codex), [[null, null, "codex"]])
      }),
    ),
  )

  it.effect("scaling a run keeps its cache write split adding up", () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const task = yield* fakeTask
        const id = yield* newRun(task, { lines: [result("s1", { "claude-opus-5-5": { ...opusSplit(400, 333, 333), costUSD: 3.0 } })], cost: 1.0 })
        yield* (yield* Tokens).countPending(null)
        const [r] = yield* sql<{
          readonly w: number
          readonly h: number
          readonly m: number
        }>`SELECT cache_write_tokens AS w, cache_write_1h_tokens AS h, cache_write_5m_tokens AS m FROM token_usage WHERE run_id = ${id}`
        assert.strictEqual((r?.h ?? 0) + (r?.m ?? 0), r?.w)
        assert.strictEqual(r?.h, 111)
      }),
    ),
  )

  it.effect("a run that can't be counted is marked counted, and a run's end counts in the background", () =>
    run(
      Effect.gen(function* () {
        const tokens = yield* Tokens
        const sql = yield* SqlClient.SqlClient
        const task = yield* fakeTask
        const id = yield* newRun(task, { lines: [result("s1", { "claude-opus-5-5": opus(5, 100, 1000, 1.0) })] })
        // The database refuses the row, as a full disk would.
        yield* sql`CREATE TRIGGER full BEFORE INSERT ON token_usage BEGIN SELECT RAISE(FAIL, 'database or disk is full'); END`
        assert.strictEqual(yield* tokens.countPending(null), 1)
        assert.strictEqual(yield* tokens.countPending(null), 0)
        yield* sql`DROP TRIGGER full`
        assert.deepStrictEqual(yield* rows(id), [])

        const later = yield* newRun(task, { lines: [result("s2", { "claude-opus-5-5": opus(1, 7, 10, 0.1) })] })
        yield* tokens.runEnded(task)
        // Waits for the background count, which holds the one count at a time.
        yield* tokens.countPending(task)
        assert.deepStrictEqual(yield* rows(later), [["claude-opus-5-5", 7, 0.1, false]])
      }),
    ),
  )
})
