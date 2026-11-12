import { NodeServices } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option } from "effect"
import { SecureRandom } from "effect/crypto"
import { ProfileId, RequestId, RunId, TaskId } from "@huntaway/contracts"
import { makeLegacyBoard } from "@huntaway/testing"
import type { LegacyBoard } from "@huntaway/testing"
import { AnalyticsRepo } from "../../../analytics/AnalyticsRepo.ts"
import { ApprovalRulesRepo } from "../../../agents/ApprovalRulesRepo.ts"
import { ContextStatsRepo } from "../../../agents/ContextStatsRepo.ts"
import { TokenRepo } from "../../../agents/TokenRepo.ts"
import { DesktopOpRepo } from "../../../desktop/DesktopOpRepo.ts"
import { TaskDocumentRepo } from "../../../docs/TaskDocumentRepo.ts"
import { CheckpointRepo } from "../../../git/CheckpointRepo.ts"
import { PrWatchRepo } from "../../../github/PrWatchRepo.ts"
import { PermissionRepo } from "../../../permissions/PermissionRepo.ts"
import { Db } from "../../../platform/Db.ts"
import type { ColumnValue } from "../../../platform/columns.ts"
import { Events } from "../../../platform/Events.ts"
import { RunRepo } from "../../../runs/RunRepo.ts"
import type { Family } from "../family.ts"
import { importLegacy } from "../run.ts"
import { checkpointStats, convertCheckpoint, watchState } from "./runRecords.ts"
import { convertAction, convertDesktopOp, convertPrompt, convertRun, costDifferences, runsFamily } from "./runs.ts"
import type { OldAction, OldDesktopOp, OldPrompt, OldRun } from "./runs.ts"

// The runs family (docs/plan/11-migration.md, Table by table): its conversions on their own, then old folders imported
// and read back through the new server's repositories.

const NOW = "2026-11-12T00:00:00.000Z"

const oldRun = (fields: Partial<OldRun> = {}): OldRun => ({
  old_rowid: 1,
  id: "r1",
  task_id: "t1",
  status: "exited",
  out_offset: 10,
  stop_requested: 0,
  attention: null,
  result_error: null,
  saw_result: 1,
  created_at: "2026-01-01T00:00:00.000Z",
  ended_at: "2026-01-01T00:01:00.000Z",
  kind: "prompt",
  cost_usd: 0.25,
  stop_id: null,
  between_turns: 0,
  turn_message_id: 41,
  agent_at: null,
  turn_start_tokens: null,
  turn_tokens: null,
  session_id: null,
  session_cost: null,
  usage_at: null,
  usage_session: null,
  usage_snapshot: null,
  usage_tail: null,
  effort: null,
  config_dir: null,
  board_tools: 0,
  finished: 0,
  ...fields,
})

const prompt = (status: string, note: string | null = null): OldPrompt => ({
  id: "q1",
  task_id: "t1",
  message_id: 7,
  tool_name: "Bash",
  input: "{}",
  status,
  created_at: "2026-01-01T00:00:00.000Z",
  call_id: null,
  note,
  kind: "tool",
  expires_at: null,
  rule: null,
})

const action = (outcome: string, answered_by: string | null, decided_at: string | null): OldAction => ({
  id: "a1",
  profile_id: "p1",
  task_id: "t1",
  request_id: "q1",
  tool_name: "Bash",
  summary: "ls",
  rule: "Bash",
  decision: "ask",
  outcome,
  answered_by,
  created_at: "2026-01-01T00:00:00.000Z",
  decided_at,
})

const op = (status: string): OldDesktopOp => ({
  id: "d1",
  task_id: "t1",
  run_id: null,
  op_id: null,
  tool: "act",
  summary: "click",
  args: "{}",
  status,
  result: null,
  boot: "b",
  created_at: "2026-01-01T00:00:00.000Z",
  finished_at: null,
})

describe("runs: conversions", () => {
  it.each([
    { name: "exited, no stop", old: oldRun(), status: "exited", stop: "none", ended: "2026-01-01T00:01:00.000Z" },
    { name: "exited, stop asked", old: oldRun({ stop_requested: 1 }), status: "exited", stop: "requested", ended: "2026-01-01T00:01:00.000Z" },
    { name: "exited, turn interrupted", old: oldRun({ stop_requested: 2 }), status: "exited", stop: "interrupted", ended: "2026-01-01T00:01:00.000Z" },
    { name: "running: interrupted at the import", old: oldRun({ status: "running", ended_at: null }), status: "exited", stop: "interrupted", ended: NOW },
    {
      name: "preparing, stop asked: interrupted",
      old: oldRun({ status: "preparing", stop_requested: 1, ended_at: null }),
      status: "exited",
      stop: "interrupted",
      ended: NOW,
    },
    { name: "exited with no end: unknown, kept", old: oldRun({ ended_at: null }), status: "exited", stop: "none", ended: null },
  ])("a run $name", ({ old, status, stop, ended }) => {
    const row = convertRun(old, NOW)
    expect(row).toMatchObject({ seq: 1, status, stop, ended_at: ended, write_no: 41 })
    expect(row).not.toHaveProperty("stop_requested")
    expect(row).not.toHaveProperty("turn_message_id")
    expect(row).not.toHaveProperty("old_rowid")
  })

  it("keeps a run's unknown markers as they are", () => {
    const row = convertRun(oldRun({ session_id: null, session_cost: null, effort: null, config_dir: "", turn_message_id: null }), NOW)
    expect(row).toMatchObject({ session_id: null, session_cost: null, effort: null, config_dir: "", write_no: null })
  })

  it.each([
    { old: prompt("pending"), status: "expired", note: "Request expired" },
    { old: prompt("allowed", "fine"), status: "allowed", note: "fine" },
    { old: prompt("denied"), status: "denied", note: null },
    { old: prompt("expired", "Request expired"), status: "expired", note: "Request expired" },
  ])("a prompt $old.status becomes $status", ({ old, status, note }) => {
    expect(convertPrompt(old)).toMatchObject({ status, note, write_no: 7, run_id: null, control_id: null, answered: 0 })
  })

  it.each([
    { old: action("pending", null, null), outcome: "expired", by: "ended", at: NOW },
    { old: action("allowed", "user", "2026-01-01T00:00:05.000Z"), outcome: "allowed", by: "user", at: "2026-01-01T00:00:05.000Z" },
  ])("an action $old.outcome becomes $outcome", ({ old, outcome, by, at }) => {
    expect(convertAction(old, NOW)).toMatchObject({ outcome, answered_by: by, decided_at: at })
  })

  it.each([
    ["running", "interrupted"],
    ["ok", "ok"],
    ["failed", "failed"],
  ])("a desktop op %s becomes %s", (from, to) => {
    expect(convertDesktopOp(op(from))).toMatchObject({ status: to })
  })

  it.each([
    { text: null, stats: null },
    { text: "not json", stats: null },
    { text: `{"files":"x","additions":1,"deletions":0}`, stats: null },
    { text: `{"files":2,"additions":3,"deletions":1}`, stats: { files: 2, additions: 3, deletions: 1, excluded: [], excluded_count: 0 } },
    {
      text: `{"files":2,"additions":3,"deletions":1,"excluded":["a"],"excluded_count":5}`,
      stats: { files: 2, additions: 3, deletions: 1, excluded: ["a"], excluded_count: 5 },
    },
  ])("checkpoint stats $text", ({ text, stats }) => {
    expect(checkpointStats(text)).toEqual(stats)
  })

  it("a checkpoint's message_id is its write_no", () => {
    const row = convertCheckpoint({
      task_id: "t1",
      n: 0,
      kind: "turn",
      sha: "s",
      tree: "t",
      head: null,
      before_n: null,
      run_id: null,
      turn: 1,
      message_id: 9,
      status: "done",
      session: null,
      agent_at: null,
      stats: null,
      stale: 0,
      created_at: "2026-01-01T00:00:00.000Z",
    })
    expect(row).toMatchObject({ write_no: 9, stats: null })
    expect(row).not.toHaveProperty("message_id")
  })

  const seen = { head: null, failed: [], passed: false, remarks: [], conflicting: false }
  const summary = {
    base_branch: "main",
    checks: { failed: [], outcome: "passed", passed: 2, pending: [], required_checks: true },
    draft: false,
    head: "abc",
    merge_state: null,
    mergeable: "MERGEABLE",
    number: 3,
    review_decision: null,
    state: "OPEN",
    title: "T",
    url: "https://example.invalid/pr/3",
  }
  const summaryText = `{"base_branch":"main","checks":{"failed":[],"outcome":"passed","passed":2,"pending":[],"required_checks":true},"draft":false,"head":"abc","merge_state":null,"mergeable":"MERGEABLE","number":3,"review_decision":null,"state":"OPEN","title":"T","url":"https://example.invalid/pr/3"}`

  it.each([
    { name: "unreadable", text: "{", state: { seen, last: null, polled_at: "", comment_wakes: 0, comments_paused: false }, noted: true },
    {
      name: "from before the comment wakes",
      text: `{"seen":{"head":"abc","failed":["x"]},"last":null,"polled_at":"p"}`,
      state: { seen: { ...seen, head: "abc", failed: ["x"] }, last: null, polled_at: "p", comment_wakes: 0, comments_paused: false },
      noted: false,
    },
    { name: "with no seen", text: `{}`, state: { seen, last: null, polled_at: "", comment_wakes: 0, comments_paused: false }, noted: false },
    {
      name: "pending, superseded, woken",
      text: `{"seen":{},"pending":{"call_id":"c","told":{"passed":true},"superseded":true},"last":null,"polled_at":"","comment_wakes":2,"woke_at":"w","comments_paused":true}`,
      state: {
        seen,
        pending: { call_id: "c", told: { ...seen, passed: true }, superseded: true },
        last: null,
        polled_at: "",
        comment_wakes: 2,
        woke_at: "w",
        comments_paused: true,
      },
      noted: false,
    },
    {
      name: "with a last read",
      text: `{"seen":{},"last":${summaryText},"polled_at":"p","comment_wakes":0,"comments_paused":false}`,
      state: { seen, last: summary, polled_at: "p", comment_wakes: 0, comments_paused: false },
      noted: false,
    },
    {
      name: "with a last read in an older form",
      text: `{"seen":{},"last":{"state":"OPEN"},"polled_at":"p"}`,
      state: { seen, last: null, polled_at: "p", comment_wakes: 0, comments_paused: false },
      noted: true,
    },
  ])("a PR watch state $name", ({ text, state, noted }) => {
    const out = watchState(text)
    expect(out.state).toEqual(state)
    expect(out.note !== null).toBe(noted)
  })

  it("notes the tasks whose cost is not their runs' sum", () => {
    const notes = costDifferences([
      { key: "A-1", task: 0.5, runs: 0.5 },
      { key: "A-2", task: 0.1 + 0.2, runs: 0.3 },
      { key: "A-3", task: 1, runs: 0.4 },
    ])
    expect(notes.map(([key]) => key)).toEqual(["A-3"])
  })
})

/** What the earlier families write that this one's rows point at, as a stand-in: profiles and tasks, as bare as they go. */
const col = (value: unknown): ColumnValue => (typeof value === "string" || typeof value === "number" ? value : null)
const parents: Family = {
  name: "parents (stand-in)",
  reads: [],
  writes: [],
  run: (io) =>
    Effect.gen(function* () {
      for (const p of yield* io.old.rows("profiles"))
        yield* io.exec(`INSERT INTO profiles (id, name, created_at) VALUES (?, ?, ?)`, [col(p["id"]), col(p["name"]), col(p["created_at"])])
      for (const t of yield* io.old.rows("tasks"))
        yield* io.exec(
          `INSERT INTO tasks (id, profile_id, number, title, cost_usd, last_activity_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            col(t["id"]),
            col(t["profile_id"]),
            col(t["number"]),
            col(t["title"]),
            col(t["cost_usd"]),
            col(t["last_activity_at"]),
            col(t["created_at"]),
            col(t["updated_at"]),
          ],
        )
    }),
}

const options = (from: string, dataDir: string, flags: { readonly force?: boolean; readonly rehearsal?: boolean } = {}) => ({
  from,
  dataDir,
  check: true,
  force: flags.force ?? false,
  rehearsal: flags.rehearsal ?? false,
  database: Option.none<string>(),
})

const AT = "2026-01-01T00:00:00.000Z"

/** An old board with profile `p1` and task `t1` (cost `cost`). */
const withTask = (old: LegacyBoard, cost = 0) =>
  Effect.gen(function* () {
    yield* old.insert("profiles", { id: "p1", name: "Me", created_at: AT })
    yield* old.insert("tasks", {
      id: "t1",
      profile_id: "p1",
      number: 1,
      title: "One",
      thread_source: "items",
      cost_usd: cost,
      last_activity_at: AT,
      created_at: AT,
      updated_at: AT,
    })
  })

const run = (id: string, fields: Readonly<Record<string, string | number | null>>) => ({ id, task_id: "t1", status: "exited", created_at: AT, ...fields })

/** The new board's repositories over its `board.db`. */
const board = (file: string) =>
  Layer.mergeAll(
    RunRepo.layer,
    TokenRepo.layer,
    ContextStatsRepo.layer,
    AnalyticsRepo.layer,
    PermissionRepo.layer,
    ApprovalRulesRepo.layer,
    DesktopOpRepo.layer,
    CheckpointRepo.layer,
    PrWatchRepo.layer,
    TaskDocumentRepo.layer,
  ).pipe(
    Layer.provideMerge(Events.layer),
    Layer.provideMerge(Db.layerOver),
    Layer.provide(SecureRandom.layerWebCrypto),
    Layer.provideMerge(Layer.orDie(SqliteClient.layer({ filename: file }))),
  )

const FAMILIES = [parents, runsFamily]
const FAR = "2100-01-01T00:00:00.000Z"

describe("runs: imported", () => {
  it.effect("keeps runs in rowid order whatever their times, maps their stops, and interrupts a live one with --force", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmp = yield* fs.makeTempDirectoryScoped()
      yield* Effect.scoped(
        Effect.gen(function* () {
          const old = yield* makeLegacyBoard(`${tmp}/old`)
          yield* withTask(old, 0.75)
          // Started first, though its clock said later.
          yield* old.insert(
            "runs",
            run("r-first", {
              created_at: "2026-01-02T00:00:00.000Z",
              ended_at: "2026-01-02T00:05:00.000Z",
              stop_requested: 1,
              cost_usd: 0.25,
              session_id: "s1",
              usage_at: AT,
              usage_session: "s1",
              usage_snapshot: `{"claude-opus":{"input":3}}`,
            }),
          )
          yield* old.insert(
            "runs",
            run("r-second", { created_at: "2026-01-01T00:00:00.000Z", ended_at: AT, stop_requested: 2, cost_usd: 0.5, turn_message_id: 12 }),
          )
          yield* old.insert("runs", run("r-live", { status: "running", created_at: "2026-01-01T12:00:00.000Z" }))
          yield* old.insert("token_usage", { run_id: "r-second", model: "claude-opus", runtime: "claude", input_tokens: 100, output_tokens: 20, cost_usd: 0.5 })
          yield* old.insert("context_stats", {
            task_id: "t1",
            run_id: "r-second",
            kind: "turn",
            at: "2026-01-01T00:00:30.000Z",
            tokens: 5000,
            model: "claude-opus",
          })
        }),
      )
      const result = yield* importLegacy(options(`${tmp}/old`, `${tmp}/new`, { force: true }), FAMILIES)
      expect(result.report.failures).toEqual([])
      expect(result.passes).toBe(true)
      expect(result.report.tables["runs"]).toEqual({ old: 3, written: 3, withheld: 0 })
      expect(result.report.notes.map((n) => n.key)).toEqual(["r-live"])
      yield* Effect.gen(function* () {
        const runs = yield* RunRepo
        const first = Option.getOrThrow(yield* runs.get(RunId.make("r-first")))
        const second = Option.getOrThrow(yield* runs.get(RunId.make("r-second")))
        const live = Option.getOrThrow(yield* runs.get(RunId.make("r-live")))
        expect([first.seq < second.seq, second.seq < live.seq]).toEqual([true, true])
        expect([first.stop, second.stop, live.stop]).toEqual(["requested", "interrupted", "interrupted"])
        expect(second.write_no).toBe(12)
        expect(live.phase).toBe("exited")
        expect(live.ended_at).not.toBeNull()
        expect(yield* runs.active).toEqual([])
        // The latest run is the last started, not the one with the latest clock.
        expect(Option.getOrThrow(yield* runs.latest(TaskId.make("t1"))).id).toBe("r-live")
        expect(yield* runs.laterThan(second)).toBe(true)
        // The token counting goes on from what the old board counted.
        const tokens = yield* TokenRepo
        expect((yield* tokens.savedBefore(TaskId.make("t1"), second.seq)).map((s) => s.usage_snapshot)).toEqual([`{"claude-opus":{"input":3}}`])
        expect((yield* tokens.pending(null)).map((r) => r.id)).toEqual(["r-second", "r-live"])
        expect(yield* tokens.runModel(RunId.make("r-second"))).toBe("claude-opus")
        const analytics = yield* AnalyticsRepo
        const usage = yield* analytics.runUsage(ProfileId.make("p1"), AT, FAR)
        expect(usage.map((u) => [u.run_id, u.input_tokens, u.cost_usd])).toEqual([["r-second", 100, 0.5]])
        const context = yield* analytics.contextStats(ProfileId.make("p1"), AT, FAR)
        expect(context.map((c) => [c.kind, c.tokens])).toEqual([["turn", 5000]])
      }).pipe(Effect.provide(board(`${tmp}/new/board.db`)))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect("records a live run as interrupted in a rehearsal too", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmp = yield* fs.makeTempDirectoryScoped()
      yield* Effect.scoped(
        Effect.gen(function* () {
          const old = yield* makeLegacyBoard(`${tmp}/old`)
          yield* withTask(old)
          yield* old.insert("runs", run("r-live", { status: "preparing" }))
        }),
      )
      const result = yield* importLegacy(options(`${tmp}/old`, `${tmp}/new`, { rehearsal: true }), FAMILIES)
      expect(result.passes).toBe(true)
      const live = yield* Effect.gen(function* () {
        return yield* (yield* RunRepo).get(RunId.make("r-live"))
      }).pipe(Effect.provide(board(`${tmp}/new/board.db`)))
      expect(Option.getOrThrow(live)).toMatchObject({ phase: "exited", stop: "interrupted" })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect("expires pending prompts and their log entries, interrupts running desktop ops, and notes a task whose cost is not its runs'", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmp = yield* fs.makeTempDirectoryScoped()
      yield* Effect.scoped(
        Effect.gen(function* () {
          const old = yield* makeLegacyBoard(`${tmp}/old`)
          yield* withTask(old, 2)
          yield* old.insert("runs", run("r1", { cost_usd: 0.5 }))
          for (const [id, status] of [
            ["q-pending", "pending"],
            ["q-allowed", "allowed"],
          ] as const)
            yield* old.insert("permission_requests", {
              id,
              task_id: "t1",
              message_id: 30,
              tool_name: "Bash",
              input: `{"command":"ls"}`,
              status,
              created_at: AT,
            })
          yield* old.insert("approval_log", {
            id: "a1",
            profile_id: "p1",
            task_id: "t1",
            request_id: "q-pending",
            tool_name: "Bash",
            summary: "ls",
            rule: "Bash",
            decision: "ask",
            outcome: "pending",
            created_at: AT,
          })
          yield* old.insert("desktop_ops", {
            id: "d1",
            task_id: "t1",
            run_id: "r1",
            tool: "act",
            summary: "click",
            args: "{}",
            status: "running",
            boot: "old-boot",
            created_at: AT,
          })
        }),
      )
      const result = yield* importLegacy(options(`${tmp}/old`, `${tmp}/new`), FAMILIES)
      expect(result.passes).toBe(true)
      expect(result.report.notes).toContainEqual(expect.objectContaining({ table: "tasks", key: "t1" }))
      yield* Effect.gen(function* () {
        const prompts = yield* PermissionRepo
        expect(Option.getOrThrow(yield* prompts.get(RequestId.make("q-pending")))).toMatchObject({
          status: "expired",
          note: "Request expired",
          write_no: 30,
          run_id: null,
          control_id: null,
          answered: false,
        })
        expect(Option.getOrThrow(yield* prompts.get(RequestId.make("q-allowed"))).status).toBe("allowed")
        expect(yield* prompts.pending({})).toEqual([])
        expect(yield* prompts.orphans).toEqual([])
        const log = yield* (yield* ApprovalRulesRepo).list(ProfileId.make("p1"), 10)
        expect(log.map((a) => [a.outcome, a.answered_by])).toEqual([["expired", "ended"]])
        const ops = yield* (yield* DesktopOpRepo).ofTask(TaskId.make("t1"))
        expect(ops.map((o) => o.status)).toEqual(["interrupted"])
      }).pipe(Effect.provide(board(`${tmp}/new/board.db`)))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect("carries checkpoints, pull request watches and states, documents, review and call stats", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmp = yield* fs.makeTempDirectoryScoped()
      yield* Effect.scoped(
        Effect.gen(function* () {
          const old = yield* makeLegacyBoard(`${tmp}/old`)
          yield* withTask(old)
          // Stats from before the files left out were kept.
          yield* old.insert("checkpoints", {
            task_id: "t1",
            n: 0,
            kind: "turn",
            sha: "a1",
            tree: "b1",
            turn: 1,
            message_id: 21,
            status: "done",
            stats: `{"files":1,"additions":2,"deletions":3}`,
            created_at: AT,
          })
          // A watch state from before comment wakes.
          yield* old.insert("pr_watches", {
            task_id: "t1",
            pr: "o/r#3",
            state: `{"seen":{"head":"abc","passed":true},"last":null,"polled_at":"p"}`,
            updated_at: AT,
          })
          yield* old.insert("pr_states", { task_id: "t1", pr_url: "https://example.invalid/pr/3", state: "merged", updated_at: AT })
          yield* old.insert("documents", { task_id: "t1", version: 1, content: "<p>plan</p>", open: 0, created_at: AT, updated_at: AT, label: "plan" })
          yield* old.insert("review_stats", { task_id: "t1", thread_id: "t1", round: AT, at: AT, verdict: "issues", serious: 2, minor: null, effort: "high" })
          yield* old.insert("call_usage", {
            at: AT,
            purpose: "title",
            task_id: "t1",
            model: "haiku",
            runtime: "claude",
            input_tokens: 4,
            call_id: "0123456789abcdef0123456789abcdef",
          })
        }),
      )
      const result = yield* importLegacy(options(`${tmp}/old`, `${tmp}/new`), FAMILIES)
      expect(result.report.failures).toEqual([])
      expect(result.report.json).toEqual([])
      expect(result.passes).toBe(true)
      yield* Effect.gen(function* () {
        const task = TaskId.make("t1")
        const [checkpoint] = yield* (yield* CheckpointRepo).list(task)
        expect(checkpoint).toMatchObject({ n: 0, write_no: 21, stats: { files: 1, additions: 2, deletions: 3, excluded: [], excluded_count: 0 } })
        const prs = yield* PrWatchRepo
        expect(yield* prs.get(task, "o/r#3")).toEqual({
          seen: { head: "abc", failed: [], passed: true, remarks: [], conflicting: false },
          last: null,
          polled_at: "p",
          comment_wakes: 0,
          comments_paused: false,
        })
        expect(yield* prs.prState(task, "https://example.invalid/pr/3")).toBe("merged")
        expect(yield* (yield* TaskDocumentRepo).content(task, "plan", 1)).toBe("<p>plan</p>")
        const analytics = yield* AnalyticsRepo
        const reviews = yield* analytics.reviewStats(ProfileId.make("p1"), AT, FAR)
        expect(reviews.map((r) => [r.verdict, r.serious, r.minor, r.effort])).toEqual([["issues", 2, null, "high"]])
        const calls = yield* analytics.callUsage(ProfileId.make("p1"), AT, FAR)
        expect(calls.map((c) => [c.purpose, c.input_tokens, c.call_id])).toEqual([["title", 4, "0123456789abcdef0123456789abcdef"]])
      }).pipe(Effect.provide(board(`${tmp}/new/board.db`)))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
