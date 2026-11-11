import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { ProfileId } from "@huntaway/contracts"
import { TestBoard } from "@huntaway/testing"
import { Analytics, classify, clip, MERGE_PREFIX, parseTs, START_TEXT, TEXT_LIMIT } from "./Analytics.ts"

// The old analytics.test.ts, on the board's own schema: rows are written as the areas write them (thread items, runs,
// `token_usage`, `call_usage`, `review_stats`, `context_stats`). Dropped: the subproject parts of "reports tokens,
// reviews and follow-ups" (subprojects are gone, docs/plan/14-dropped-and-open.md); the rest of it is here.

const AT = "2026-09-01T00:00:00.000Z"
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.scoped, Effect.provide(TestBoard()))

/** A database seeded by hand: one statement at a time. */
const seed = (statements: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    for (const s of statements) yield* sql.unsafe(s)
  }).pipe(Effect.orDie)

const profile = (id: string, configs: ReadonlyArray<string> = [], at = AT) =>
  `INSERT INTO profiles (id, name, claude_config_ids, created_at) VALUES ('${id}', '${id}', '[${configs.map((c) => `"${c}"`).join(",")}]', '${at}')`
const task = (
  id: string,
  profileId: string,
  extra: { kind?: string; parent?: string; project?: string; number?: number; createdBy?: string; type?: string } = {},
) =>
  `INSERT INTO tasks (id, profile_id, project_id, kind, number, title, status, parent_id, created_by, task_type, last_activity_at, created_at, updated_at)
   VALUES ('${id}', '${profileId}', ${extra.project === undefined ? "NULL" : `'${extra.project}'`}, '${extra.kind ?? "task"}', ${extra.number ?? 1}, 'Task ${id}',
     'in_review', ${extra.parent === undefined ? "NULL" : `'${extra.parent}'`}, ${extra.createdBy === undefined ? "NULL" : `'${extra.createdBy}'`},
     ${extra.type === undefined ? "NULL" : `'${extra.type}'`}, '${AT}', '${AT}', '${AT}')`
const userMessage = (taskId: string, pos: number, text: string, at: string, meta: string | null = null) =>
  `INSERT INTO thread_items (task_id, id, pos, type, data, meta, created_at, updated_at) VALUES ('${taskId}', 'u${pos}', ${pos}, 'user_message',
     '{"id":"u${pos}","type":"user_message","text":"${text}"}', ${meta === null ? "NULL" : `'${meta}'`}, '${at}', '${at}')`
const runRow = (id: string, taskId: string, kind: string, created: string, ended: string | null, counted: string | null = created) =>
  `INSERT INTO runs (id, task_id, kind, status, created_at, ended_at, usage_at) VALUES ('${id}', '${taskId}', '${kind}', 'exited', '${created}',
     ${ended === null ? "NULL" : `'${ended}'`}, ${counted === null ? "NULL" : `'${counted}'`})`
const usage = (runId: string, model: string, output: number, extra = "") =>
  `INSERT INTO token_usage (run_id, model, runtime, output_tokens, cost_usd${extra === "" ? "" : `, ${extra.split("=")[0]}`})
   VALUES ('${runId}', '${model}', 'claude', ${output}, 0.5${extra === "" ? "" : `, ${extra.split("=")[1]}`})`
const review = (taskId: string, thread: string, round: string, at: string, verdict: string, serious: number, label: string, runId: string | null = null) =>
  `INSERT INTO review_stats (task_id, thread_id, round, run_id, at, verdict, serious, minor, label)
   VALUES ('${taskId}', '${thread}', '${round}', ${runId === null ? "NULL" : `'${runId}'`}, '${at}', '${verdict}', ${serious}, 0, '${label}')`

const cacheRow = (id: string, runtime: string, split: string) =>
  `INSERT INTO token_usage (run_id, model, runtime, input_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, cache_write_5m_tokens)
   VALUES ('${id}', 'm', '${runtime}', 10, 80, 10, ${split})`
const at = (h: number) => `2026-10-01T${String(h).padStart(2, "0")}:00:00.000Z`

describe("Analytics", () => {
  it("classifies user messages and clips long prompts", () => {
    assert.strictEqual(classify({ text: "fix the bug" }), "prompt")
    assert.strictEqual(classify({ text: START_TEXT, auto: true }), "start")
    assert.strictEqual(classify({ text: "Plan first.", auto: true, start: true }), "start")
    assert.strictEqual(classify({ text: `${MERGE_PREFIX}. Merge branch \`x\``, auto: true }), "merge")
    assert.strictEqual(classify({ text: "Address the review", auto: true }), null)
    assert.strictEqual(classify({ text: "please rebase", from_agent: true }), null)
    assert.strictEqual(clip("short"), "short")
    assert.strictEqual(Array.from(clip("é".repeat(TEXT_LIMIT + 5))).length, TEXT_LIMIT + 1)
    assert.strictEqual(parseTs("2026-10-01T10:00:00+02:00"), "2026-10-01T08:00:00.000Z")
    assert.strictEqual(parseTs("2026-10-01 10:00:00.123456z"), "2026-10-01T10:00:00.123Z")
    assert.isNull(parseTs("yesterday"))
  })

  it.effect("reports a profile's activity in range, a review thread's for the task it reviews", () =>
    run(
      Effect.gen(function* () {
        yield* seed([
          profile("me"),
          profile("other"),
          "INSERT INTO projects (id, profile_id, name, key, repo_path, scratch_path, worktrees_root, created_at) VALUES ('p1', 'me', 'Proj', 'PRJ', '/x', '/x', '/x', '2026-01-01T00:00:00.000Z')",
          task("t1", "me", { project: "p1" }),
          task("r1", "me", { kind: "review", parent: "t1", project: "p1", number: 0 }),
          task("x1", "other"),
          userMessage("t1", 0, "Start working on this task.", "2026-10-01T09:00:00.000Z", '{"auto":true}'),
          userMessage("t1", 1, "looks good", "2026-10-01T10:00:00.000Z"),
          userMessage("r1", 0, "why?", "2026-10-01T11:00:00.000Z"),
          userMessage("t1", 3, "too late", "2026-10-02T00:00:00.000Z"),
          userMessage("x1", 0, "someone else", "2026-10-01T10:00:00.000Z"),
          runRow("a", "t1", "prompt", "2026-09-30T23:50:00.000Z", "2026-10-01T00:10:00.000Z"),
          runRow("b", "r1", "review", "2026-10-01T12:00:00.000Z", null),
          runRow("c", "t1", "prompt", "2026-09-30T20:00:00.000Z", "2026-09-30T21:00:00.000Z"),
        ])
        const r = yield* (yield* Analytics).report(ProfileId.make("me"), "2026-10-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z")
        assert.deepStrictEqual(
          r.events.map((e) => [e.kind, e.task_id, e.text]),
          [
            ["start", "t1", ""],
            ["prompt", "t1", "looks good"],
            ["prompt", "t1", "why?"],
          ],
        )
        assert.deepStrictEqual(
          r.runs.map((x) => [x.task_id, x.kind]),
          [
            ["t1", "prompt"],
            ["t1", "review"],
          ],
        )
        assert.strictEqual(r.tasks.length, 1)
        assert.strictEqual(r.projects.length, 1)
        const bad = yield* Effect.flip((yield* Analytics).report(ProfileId.make("me"), "now", "2026-10-02T00:00:00.000Z"))
        assert.strictEqual(bad._tag, "Invalid")
        const gone = yield* Effect.flip((yield* Analytics).report(ProfileId.make("nobody"), "2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z"))
        assert.strictEqual(gone._tag, "NotFound")
      }),
    ),
  )

  it.effect("reports tokens, reviews and follow-ups", () =>
    run(
      Effect.gen(function* () {
        yield* seed([
          profile("p"),
          profile("o"),
          task("child", "p"),
          task("thread", "p", { kind: "review", parent: "child", number: 0 }),
          task("follow", "p", { createdBy: "child", number: 2 }),
          task("theirs", "o"),
          runRow("r1", "child", "prompt", "2026-10-01T01:00:00.000Z", null),
          usage("r1", "opus", 100),
          runRow("r2", "child", "prompt", "2026-10-01T02:00:00.000Z", null),
          usage("r2", "haiku", 300),
          runRow("r3", "child", "prompt", "2026-10-01T03:00:00.000Z", null),
          usage("r3", "opus", 250),
          runRow("rv", "thread", "review", "2026-10-01T04:00:00.000Z", null),
          usage("rv", "gpt", 50),
          runRow("r4", "child", "prompt", "2026-09-01T00:00:00.000Z", null),
          usage("r4", "opus", 1),
          runRow("r5", "theirs", "prompt", "2026-10-01T01:00:00.000Z", null),
          usage("r5", "opus", 1),
          // Ended, not counted yet.
          runRow("r0", "child", "prompt", "2026-10-01T05:00:00.000Z", null, null),
          review("child", "thread", "2026-10-01T04:00:00.000Z", "2026-10-01T04:30:00.000Z", "issues", 2, "Codex · gpt", "rv"),
        ])
        const r = yield* (yield* Analytics).tokenStats(ProfileId.make("p"), "2026-10-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z")
        assert.strictEqual(r.usage.length, 4)
        assert.strictEqual(r.pending, 1)
        assert.deepStrictEqual(
          r.reviews.map((v) => [v.serious, v.minor, v.model, v.task_model, v.round]),
          [[2, 0, "gpt", "opus", 1]],
        )
        const ids = r.tasks.map((t) => t.id)
        for (const t of ["child", "thread", "follow"]) assert.include(ids, t)
        assert.notInclude(ids, "theirs")
        assert.deepStrictEqual(
          r.follow_ups.map((f) => [f.task_id, f.created_by]),
          [["follow", "child"]],
        )
        // The model it used most, its earlier runs' included.
        assert.strictEqual(r.tasks.find((t) => t.id === "child")?.model, "opus")
        assert.strictEqual(r.tasks.find((t) => t.id === "thread")?.parent_id, "child")
      }),
    ),
  )

  it.effect("review rounds are numbered from the task's first, whatever the range", () =>
    run(
      Effect.gen(function* () {
        yield* seed([
          profile("p"),
          task("t", "p"),
          // Round 1, the day before: A found issues, B passed.
          review("t", "A", "2026-10-01T10:00:00.000Z", "2026-10-01T10:05:00.000Z", "issues", 2, "A"),
          review("t", "B", "2026-10-01T10:00:00.000Z", "2026-10-01T10:06:00.000Z", "pass", 0, "B"),
          // Round 2.
          review("t", "A", "2026-10-02T09:00:00.000Z", "2026-10-02T09:05:00.000Z", "pass", 0, "A"),
          review("t", "B", "2026-10-02T09:00:00.000Z", "2026-10-02T09:06:00.000Z", "issues", 1, "B"),
          // Round 3: a reviewer added since (another thread); A didn't submit.
          review("t", "C", "2026-10-02T12:00:00.000Z", "2026-10-02T12:05:00.000Z", "issues", 1, "C"),
          // Round 4, a minute after: rounds are kept apart however close they started.
          review("t", "B", "2026-10-02T12:01:00.000Z", "2026-10-02T12:03:00.000Z", "issues", 1, "B"),
        ])
        const r = yield* (yield* Analytics).tokenStats(ProfileId.make("p"), "2026-10-02T00:00:00.000Z", "2026-10-03T00:00:00.000Z")
        assert.deepStrictEqual(
          r.reviews.map((v) => [v.label, v.round]),
          [
            ["A", 2],
            ["B", 2],
            ["B", 4],
            ["C", 3],
          ],
        )
        assert.deepStrictEqual(
          r.rounds.map((x) => [x.round, x.verdict, x.serious, x.reviewers]),
          [
            [1, "issues", 2, 2],
            [2, "issues", 1, 2],
            [3, "issues", 1, 1],
            [4, "issues", 1, 1],
          ],
        )
      }),
    ),
  )

  it.effect("the token report has which cache writes went to where it's known", () =>
    run(
      Effect.gen(function* () {
        yield* seed([
          profile("p"),
          task("t", "p"),
          runRow("a", "t", "prompt", "2026-10-01T01:00:00.000Z", null),
          cacheRow("a", "claude", "7, 3"),
          // From before the split was kept, and Codex's: not known.
          runRow("b", "t", "prompt", "2026-10-01T02:00:00.000Z", null),
          cacheRow("b", "claude", "NULL, NULL"),
          runRow("c", "t", "prompt", "2026-10-01T03:00:00.000Z", null),
          cacheRow("c", "codex", "NULL, NULL"),
          `INSERT INTO call_usage (at, purpose, task_id, model, runtime, cache_write_tokens, cache_write_1h_tokens, cache_write_5m_tokens)
           VALUES ('2026-10-01T04:00:00.000Z', 'title', 't', 'haiku', 'claude', 5, 0, 5)`,
        ])
        const r = yield* (yield* Analytics).tokenStats(ProfileId.make("p"), "2026-10-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z")
        assert.deepStrictEqual(
          r.usage.map((u) => [u.runtime, u.cache_read_tokens, u.cache_write_tokens, u.cache_write_1h_tokens, u.cache_write_5m_tokens]),
          [
            ["claude", 80, 10, 7, 3],
            ["claude", 80, 10, null, null],
            ["codex", 80, 10, null, null],
            ["claude", 0, 5, 0, 5],
          ],
        )
      }),
    ),
  )

  // HA-328: the Analytics page's All tab merges each profile's reports, so they must split the board's data between them,
  // leaving nothing out and nothing counted twice: assistant threads, reviews, titles and window restarts too.
  it.effect("each profile's reports split the board's data, so All is their sum", () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const analytics = yield* Analytics
        const [from, to] = ["2026-10-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z"]
        const statements = [profile("personal", ["cfg-a"]), profile("work", ["cfg-b"])]
        let h = 0
        for (const p of ["personal", "work"]) {
          statements.push(
            task(`${p}-task`, p),
            task(`${p}-review`, p, { kind: "review", parent: `${p}-task`, number: 0 }),
            task(`${p}-assistant`, p, { type: "assistant" }),
          )
          for (const t of [`${p}-task`, `${p}-review`, `${p}-assistant`]) {
            const when = at(++h)
            statements.push(
              userMessage(t, 0, "go", when),
              runRow(`${t}-run`, t, t.endsWith("review") ? "review" : "prompt", when, when),
              usage(`${t}-run`, "m", 10),
              `INSERT INTO context_stats (task_id, run_id, kind, at, tokens) VALUES ('${t}', '${t}-run', 'turn', '${when}', 100)`,
            )
          }
          statements.push(
            `INSERT INTO call_usage (at, purpose, task_id, model, runtime) VALUES ('${at(++h)}', 'title', '${p}-task', 'haiku', 'claude')`,
            `INSERT INTO call_usage (at, purpose, config_id, model, runtime) VALUES ('${at(++h)}', 'window', '${p === "personal" ? "cfg-a" : "cfg-b"}', 'haiku', 'claude')`,
          )
        }
        // A window of a config no profile uses goes to the first profile's.
        statements.push(`INSERT INTO call_usage (at, purpose, config_id, model, runtime) VALUES ('${at(++h)}', 'window', 'gone', 'haiku', 'claude')`)
        yield* seed(statements)

        const ofProfile = (p: string) =>
          Effect.all(
            {
              activity: analytics.report(ProfileId.make(p), from, to),
              context: analytics.contextStats(ProfileId.make(p), from, to),
              tokens: analytics.tokenStats(ProfileId.make(p), from, to),
            },
            { concurrency: 1 },
          )
        const mine = yield* ofProfile("personal")
        const theirs = yield* ofProfile("work")
        type R = typeof mine
        const count = (q: string) => Effect.map(sql.unsafe<{ readonly n: number }>(q, [from, to]), (rows) => rows[0]?.n ?? 0).pipe(Effect.orDie)
        const checks: ReadonlyArray<readonly [string, (r: R) => ReadonlyArray<string>, number]> = [
          [
            "usage",
            (r) => r.tokens.usage.map((u) => `${u.run_id ?? u.call_id ?? u.kind}@${u.at}`),
            yield* count("SELECT (SELECT COUNT(*) FROM token_usage) + (SELECT COUNT(*) FROM call_usage WHERE at >= ? AND at < ?) AS n"),
          ],
          [
            "events",
            (r) => r.activity.events.map((e) => `${e.task_id}@${e.at}`),
            yield* count("SELECT COUNT(*) AS n FROM thread_items WHERE created_at >= ? AND created_at < ?"),
          ],
          [
            "runs",
            (r) => r.activity.runs.map((x) => `${x.task_id}@${x.started_at}`),
            yield* count("SELECT COUNT(*) AS n FROM runs WHERE created_at >= ? AND created_at < ?"),
          ],
          [
            "turns",
            (r) => r.context.stats.map((x) => `${x.task_id}@${x.at}`),
            yield* count("SELECT COUNT(*) AS n FROM context_stats WHERE at >= ? AND at < ?"),
          ],
        ]
        for (const [what, rows, all] of checks) {
          const [a, b] = [rows(mine), rows(theirs)]
          assert.strictEqual(a.length + b.length, all, `${what}: every row is in a profile's report`)
          assert.isTrue(a.length > 0 && b.length > 0, `${what}: both profiles have some`)
          assert.deepStrictEqual(
            a.filter((x) => b.includes(x)),
            [],
            `${what}: no row is in both`,
          )
        }
        // The window of the unused config is the first profile's.
        assert.strictEqual(mine.tokens.usage.filter((u) => u.kind === "window").length, 2)
        // Each report refers only to its own profile's tasks.
        for (const [r, p] of [
          [mine, "personal"],
          [theirs, "work"],
        ] as const) {
          for (const t of [...r.activity.tasks, ...r.context.tasks, ...r.tokens.tasks]) assert.isTrue(t.id.startsWith(p), `${t.id} is ${p}'s`)
        }
      }),
    ),
  )

  it.effect("the first profile is the first added, even when profiles were made in the same millisecond", () =>
    run(
      Effect.gen(function* () {
        // The first added has the id that sorts last, so neither `id` nor table order alone gives it.
        yield* seed([
          profile("zz-first", ["cfg-a"]),
          profile("aa-second", ["cfg-a"]),
          "INSERT INTO call_usage (at, purpose, config_id, model, runtime) VALUES ('2026-10-01T00:00:00.000Z', 'window', 'cfg-a', 'haiku', 'claude')",
          "INSERT INTO call_usage (at, purpose, config_id, model, runtime) VALUES ('2026-10-01T01:00:00.000Z', 'window', 'gone', 'haiku', 'claude')",
        ])
        const analytics = yield* Analytics
        const windows = (id: string) =>
          Effect.map(
            analytics.tokenStats(ProfileId.make(id), "2026-10-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z"),
            (r) => r.usage.filter((u) => u.kind === "window").length,
          )
        // A config both use, and one neither uses, are the first's.
        assert.strictEqual(yield* windows("zz-first"), 2)
        assert.strictEqual(yield* windows("aa-second"), 0)
      }),
    ),
  )
})
