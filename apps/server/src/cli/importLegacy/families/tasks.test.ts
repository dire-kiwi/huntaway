import { NodeServices } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option, Result, Schema } from "effect"
import { ChangeSummary, PrChecks, ProfileId, Review, TaskId, Todo } from "@huntaway/contracts"
import { makeLegacyBoard } from "@huntaway/testing"
import type { LegacyBoard } from "@huntaway/testing"
import { Db } from "../../../platform/Db.ts"
import { PenRepo } from "../../../tasks/PenRepo.ts"
import { TaskRepo } from "../../../tasks/TaskRepo.ts"
import type { Family } from "../family.ts"
import { importLegacy } from "../run.ts"
import { convertPen, OldPen } from "./pens.ts"
import { absolutePath, convertTask, convertTasks, INTERRUPTED, OldTask, queueOf, tasksPens } from "./tasks.ts"
import type { OldQueue, TaskFacts } from "./tasks.ts"

// The tasks-pens family (docs/plan/11-migration.md, Tasks): its conversions on their own, then an old board imported
// and read back through the new server's repositories.

const OLD = "/old/data"
const T0 = "2026-01-01T00:00:00.000Z"
const facts: TaskFacts = {
  oldDataDir: OLD,
  projects: new Map([
    ["j1", { key: "PRJ", scratch_path: "/home/u/scratch/prj" }],
    ["j2", { key: "REL", scratch_path: "scratch/rel" }],
  ]),
}

/** `value` read with `schema`, or a thrown failure. */
const decoded =
  <S extends Schema.Decoder<unknown>>(schema: S) =>
  (value: unknown): S["Type"] =>
    Result.getOrThrow(Schema.decodeUnknownResult(schema)(value))
const decodeOldTask = decoded(OldTask)
/** An old task row with what the old schema's defaults give, and `row`. */
const old = (row: Readonly<Record<string, unknown>>): OldTask =>
  decodeOldTask({
    id: "t1",
    profile_id: "p1",
    project_id: "j1",
    kind: "task",
    number: 1,
    title: "A task",
    status: "todo",
    position: 1,
    last_activity_at: T0,
    created_at: T0,
    updated_at: T0,
    ...row,
  })
const columnsOf = (row: Readonly<Record<string, unknown>>) => convertTask(old(row), facts, new Set()).task.columns
const notesOf = (row: Readonly<Record<string, unknown>>) => convertTask(old(row), facts, new Set()).notes

const queue = (q: Partial<OldQueue>): OldQueue => ({ message: null, userText: null, fromAgent: false, routine: false, routineRuns: [], steers: [], ...q })

describe("queueOf", () => {
  const cases: ReadonlyArray<readonly [string, Partial<OldQueue>, ReadonlyArray<readonly [string, string, string | null]>]> = [
    ["nothing", {}, []],
    ["blank text", { message: "  " }, []],
    ["the user's", { message: "do it", userText: "do it" }, [["do it", "user", null]]],
    ["the user's, from before queued_user_text", { message: "do it" }, [["do it", "user", null]]],
    ["another agent's", { message: "from B-2", fromAgent: true }, [["from B-2", "agent", null]]],
    ["a routine's", { message: "brief", fromAgent: true, routine: true }, [["brief", "routine", null]]],
    [
      "the user's part and the rest",
      { message: "mine\n\nfrom B-2", userText: "mine" },
      [
        ["mine", "user", null],
        ["from B-2", "agent", null],
      ],
    ],
    [
      "the user's part after the rest",
      { message: "from B-2\n\nmine", userText: "mine" },
      [
        ["mine", "user", null],
        ["from B-2", "agent", null],
      ],
    ],
    ["the user's parts between others'", { message: "a\n\nb\n\nc", userText: "a\n\nc" }, [["a\n\nb\n\nc", "user", null]]],
    [
      "parked automation runs",
      { routineRuns: ["ar1", "ar2"] },
      [
        ["", "automation", "ar1"],
        ["", "automation", "ar2"],
      ],
    ],
    [
      "a routine's text and its runs",
      { message: "brief", fromAgent: true, routine: true, routineRuns: ["ar1"] },
      [
        ["brief", "routine", null],
        ["", "routine", "ar1"],
      ],
    ],
    [
      "the user's text after a parked run",
      { message: "go", userText: "go", routineRuns: ["ar1"] },
      [
        ["go", "user", null],
        ["", "automation", "ar1"],
      ],
    ],
    [
      "steers never taken in, ahead",
      {
        message: "later",
        userText: "later",
        steers: [{ id: "s1", text: "now", from_agent: true, run_id: "r1", written: true, routine_runs: ["ar9"], routine: false }],
      },
      [
        ["now", "agent", null],
        ["", "agent", "ar9"],
        ["later", "user", null],
      ],
    ],
  ]
  for (const [name, q, rows] of cases) {
    it(name, () => {
      expect(queueOf(queue(q)).map((r) => [r.text, r.source, r.automation_run_id])).toStrictEqual(rows)
    })
  }
})

describe("absolutePath", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["/abs/dir", "/abs/dir"],
    ["documents/t1", `${OLD}/documents/t1`],
    ["./assistants/a1", `${OLD}/assistants/a1`],
    ["~/scratch", "~/scratch"],
  ]
  for (const [path, absolute] of cases) it(path, () => expect(absolutePath(path, OLD)).toBe(absolute))
})

describe("convertTask", () => {
  it("resets the run state, and an In progress task with nothing queued needs attention", () => {
    const c = columnsOf({
      status: "in_progress",
      running: 1,
      steerable: 1,
      waiting: 0,
      agent_wait: '{"reason":null,"since":"x","until":"y","tasks":[],"call_id":"c","run_id":"r"}',
      background_work: '{"run_id":"r","idle":false,"tasks":[]}',
      servers: "[]",
    })
    expect([c["running"], c["steerable"], c["agent_wait"], c["background_work"], c["servers"]]).toStrictEqual([0, 0, null, null, null])
    expect([c["status"], c["attention_reason"]]).toStrictEqual(["needs_attention", INTERRUPTED])
  })

  it("leaves In progress a task with something queued, a review thread, and a task in another column", () => {
    expect(columnsOf({ status: "in_progress", queued_message: "next", queued_user_text: "next" })["status"]).toBe("in_progress")
    expect(columnsOf({ status: "in_progress", kind: "review", parent_id: "t0", number: 0 })["status"]).toBe("in_progress")
    expect(columnsOf({ status: "in_review", attention_reason: "x" })["attention_reason"]).toBe("x")
  })

  it("reads work_dir in both forms as absolute, and gives a scratch task or pen's thread with none its old folder", () => {
    expect(columnsOf({ project_id: null, work_dir: "/home/u/chat" })["work_dir"]).toBe("/home/u/chat")
    expect(columnsOf({ project_id: null, task_type: "assistant", work_dir: "assistants/t1" })["work_dir"]).toBe(`${OLD}/assistants/t1`)
    expect(columnsOf({ project_id: null, task_type: "scratch" })["work_dir"]).toBe(`${OLD}/documents/t1`)
    expect(columnsOf({ project_id: null, task_type: "pen" })["work_dir"]).toBe(`${OLD}/documents/t1`)
    expect(columnsOf({})["work_dir"]).toBeNull()
  })

  it("reads a plan, artifact or diagram task type as its label, in its own folder", () => {
    const c = columnsOf({ task_type: "diagram", labels: '["plan"]' })
    expect([c["task_type"], c["labels"], c["work_dir"]]).toStrictEqual([null, ["plan", "diagram"], `${OLD}/documents/t1`])
  })

  it("reads a scratch chat as a done scratch task in no project, working in its project's scratch folder or its profile's", () => {
    const c = columnsOf({ kind: "scratch", project_id: "j2", status: "todo" })
    expect([c["kind"], c["task_type"], c["project_id"], c["status"], c["resolution"], c["done_at"], c["work_dir"]]).toStrictEqual([
      "task",
      "scratch",
      null,
      "done",
      "done",
      T0,
      `${OLD}/scratch/rel`,
    ])
    expect(columnsOf({ kind: "scratch", project_id: null })["work_dir"]).toBe(`${OLD}/profiles/p1/scratch`)
  })

  it("keeps a config that names no config, and drops an effort or mode the new board does not have", () => {
    const c = columnsOf({ claude_config_id: "gone", effort: "extreme", permission_mode: "acceptEdits" })
    expect([c["claude_config_id"], c["effort"], c["permission_mode"]]).toStrictEqual(["gone", null, "acceptEdits"])
    expect(notesOf({ effort: "extreme" }).map((n) => n.key)).toStrictEqual(["PRJ-1.effort"])
  })

  it("reads JSON values from before their newer fields with their defaults, as the new schemas read them", () => {
    const c = columnsOf({
      summary: '{"thread_id":"s1","state":"done","head":null,"text":"Did it","updated_at":"x","after_run":null}',
      review: '{"thread_id":"r1","state":"passed","issues":[],"updated_at":"x","verdict":null}',
      pr_checks: '{"url":"u","head":"h","outcome":"passed","failed":[],"since":"x"}',
      todos: '[{"text":"a","status":"weird"},{"status":"completed"}]',
      rewind: '{"turn":2,"message_id":40,"session":"s","resume_at":null}',
    })
    const summaries = decoded(Schema.Array(ChangeSummary))(c["summaries"])
    expect(summaries).toStrictEqual([
      { thread_id: "s1", label: "", skills: [], custom_prompt: false, state: "done", head: null, text: "Did it", updated_at: "x" },
    ])
    expect(decoded(Review)(c["review"])).toStrictEqual({
      thread_id: "r1",
      state: "passed",
      head: null,
      summary: null,
      issues: [],
      fixes: 0,
      extra_rounds: 0,
      updated_at: "x",
      reviewers: [],
    })
    expect(decoded(PrChecks)(c["pr_checks"])).toMatchObject({ more_failed: 0, pending: 0, passed: 0 })
    expect(decoded(Schema.Array(Todo))(c["todos"])).toStrictEqual([
      { text: "a", status: "pending" },
      { text: "", status: "completed" },
    ])
    expect(c["rewind"]).toStrictEqual({ turn: 2, message_id: 40, session: "s" })
  })

  it("reads a summary list as it is, null JSON as null, and a value the old reader could not read as its fallback, with a note", () => {
    expect(columnsOf({ summary: "[]" })["summaries"]).toStrictEqual([])
    expect(columnsOf({ review: "null" })["review"]).toBeNull()
    expect(columnsOf({ review: "{not json" })["review"]).toBeNull()
    expect(columnsOf({ depends_on: '[1, "x"]' })["depends_on"]).toStrictEqual([])
    expect(notesOf({ review: "{not json", depends_on: '[1, "x"]' }).map((n) => n.key)).toStrictEqual(["PRJ-1.depends_on", "PRJ-1.review"])
  })
})

describe("convertTasks", () => {
  const rows = [
    old({ id: "sp", number: 1, subproject: 1, branch: "ia/prj-1-sub" }),
    old({ id: "child", number: 2, parent_id: "sp", base_branch: "ia/prj-1-sub", branch: "ia/prj-2-a" }),
    old({ id: "merged", number: 3, parent_id: "sp", base_branch: "ia/prj-1-sub", status: "done", resolution: "done" }),
    old({ id: "review", number: 0, kind: "review", parent_id: "child" }),
    old({ id: "rev-sp", number: 0, kind: "review", parent_id: "sp" }),
    old({ id: "routine", project_id: null, number: 2, task_type: "routine", parent_id: "assistant" }),
    old({ id: "s3", project_id: null, number: 3, task_type: "scratch", status: "done", position: 4 }),
    old({ id: "chat-b", kind: "scratch", project_id: null, created_at: "2025-02-01T00:00:00.000Z" }),
    old({ id: "chat-a", kind: "scratch", project_id: "j1", created_at: "2025-01-01T00:00:00.000Z" }),
  ]
  const { tasks, notes } = convertTasks(rows, facts)
  const byId = new Map(tasks.map((t) => [t.id, t.columns]))

  it("makes a subproject an ordinary task, and its tasks lose parent_id while threads under a task keep theirs", () => {
    expect(byId.get("sp")).not.toHaveProperty("subproject")
    expect(["child", "merged", "review", "rev-sp", "routine"].map((id) => byId.get(id)?.["parent_id"])).toStrictEqual([null, null, "child", "sp", "assistant"])
    expect(byId.get("child")?.["base_branch"]).toBe("ia/prj-1-sub")
  })

  it("names an unmerged task that still targets a subproject's branch", () => {
    expect(notes).toStrictEqual([{ key: "PRJ-2", text: expect.stringContaining("give it merges_into PRJ-1") }])
  })

  it("numbers scratch chats after the profile's S- tasks, oldest first, and places them after the done tasks in no project", () => {
    expect([byId.get("chat-a")?.["number"], byId.get("chat-b")?.["number"]]).toStrictEqual([4, 5])
    expect([byId.get("chat-a")?.["position"], byId.get("chat-b")?.["position"]]).toStrictEqual([5, 6])
  })
})

const pen = (row: Readonly<Record<string, unknown>>) =>
  convertPen(decoded(OldPen)({ id: "n1", profile_id: "p1", name: "Today", position: 1, created_at: T0, updated_at: T0, ...row }))

describe("convertPen", () => {
  const cases: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>, 0 | 1, string]> = [
    ["active", { active: 1, hidden: 0, color: "teal" }, 1, "teal"],
    ["inactive", { active: 0, hidden: 1, color: "red" }, 0, "red"],
    ["hidden by a release from before active", { active: 1, hidden: 1, color: "red" }, 0, "red"],
    ["shown by a release from before active", { active: 0, hidden: 0, color: "red" }, 1, "red"],
    ["from before colours", { color: "" }, 1, "blue"],
  ]
  for (const [name, row, active, color] of cases) it(name, () => expect([pen(row).active, pen(row).color]).toStrictEqual([active, color]))
})

// ---- an old board imported -------------------------------------------------------------------------------------

/**
 * The profiles and projects the tasks point at, as the settings-profiles-projects family writes them (enough of them
 * for the server's reads), so this family is tested on its own.
 */
const owners: Family = {
  name: "owners",
  reads: ["profiles", "projects"],
  writes: ["profiles", "projects"],
  run: (io) =>
    Effect.gen(function* () {
      for (const p of yield* io.old.rows("profiles")) {
        yield* io.exec(`INSERT INTO profiles (id, name, created_at) VALUES (?, ?, ?)`, [String(p["id"]), String(p["name"]), String(p["created_at"])])
      }
      for (const p of yield* io.old.rows("projects")) {
        yield* io.exec(
          `INSERT INTO projects (id, profile_id, name, key, repo_path, scratch_path, worktrees_root, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ["id", "profile_id", "name", "key", "repo_path", "scratch_path", "worktrees_root", "created_at"].map((c) => String(p[c])),
        )
      }
    }),
}

const task = (board: LegacyBoard, row: Readonly<Record<string, string | number | null>>) =>
  board.insert("tasks", {
    profile_id: "p1",
    project_id: "j1",
    title: "A task",
    thread_source: "items",
    thread_items: 1,
    last_activity_at: T0,
    created_at: T0,
    updated_at: T0,
    ...row,
  })

const seed = (root: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const board = yield* makeLegacyBoard(root)
      yield* board.insert("profiles", { id: "p1", name: "Me", created_at: T0 })
      yield* board.insert("projects", {
        id: "j1",
        profile_id: "p1",
        name: "Proj",
        key: "PRJ",
        repo_path: "/nonexistent/repo",
        scratch_path: "/nonexistent/scratch",
        worktrees_root: "/nonexistent/wt",
        created_at: T0,
      })
      yield* task(board, { id: "sp", number: 1, subproject: 1, branch: "ia/prj-1-sub", status: "in_review" })
      yield* task(board, { id: "child", number: 2, parent_id: "sp", base_branch: "ia/prj-1-sub", status: "in_progress", running: 1, steerable: 1 })
      yield* task(board, {
        id: "queued",
        number: 3,
        status: "in_progress",
        waiting: 1,
        queued_message: "mine\n\nfrom PRJ-1",
        queued_user_text: "mine",
        queued_routine_runs: '["ar1"]',
        summary: '{"thread_id":"s1","state":"done","head":null,"text":"Did it","updated_at":"2026-01-02T00:00:00.000Z"}',
      })
      yield* task(board, { id: "review", number: 0, kind: "review", parent_id: "child", status: "in_progress" })
      yield* task(board, { id: "chat", number: 9, kind: "scratch", project_id: "j1", created_at: "2025-01-01T00:00:00.000Z" })
      yield* task(board, { id: "doc", number: 4, task_type: "plan", claude_config_id: "deleted-config" })
      yield* board.insert("pens", { id: "n1", profile_id: "p1", name: "Today", position: 1, active: 1, hidden: 1, color: "", created_at: T0, updated_at: T0 })
    }),
  )

const options = (from: string, dataDir: string) => ({
  from,
  dataDir,
  check: true,
  force: false,
  rehearsal: false,
  database: Option.none<string>(),
  families: [owners, tasksPens],
})

/** The new board's repositories over its `board.db`. */
const repos = (file: string) =>
  Layer.mergeAll(TaskRepo.layer, PenRepo.layer).pipe(Layer.provideMerge(Db.layerOver), Layer.provide(Layer.orDie(SqliteClient.layer({ filename: file }))))

describe("import-legacy tasks-pens", () => {
  it.effect("imports tasks, their queues and pens, which the server reads", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmp = yield* fs.makeTempDirectoryScoped()
      yield* seed(`${tmp}/old`)
      const result = yield* importLegacy(options(`${tmp}/old`, `${tmp}/new`))
      expect(result.report.failures).toStrictEqual([])
      expect(result.report.json).toStrictEqual([])
      expect(result.passes).toBe(true)
      expect(result.report.tables["tasks"]).toStrictEqual({ old: 6, written: 6, withheld: 0 })
      expect(result.report.tables["task_queue"]).toStrictEqual({ old: 1, written: 3, withheld: 0 })
      expect(result.report.tables["pens"]).toStrictEqual({ old: 1, written: 1, withheld: 0 })
      // The check's notes on work folders not on disk are its own.
      expect(result.report.notes.filter((n) => !n.error.endsWith("is not on disk")).map((n) => n.key)).toStrictEqual(["PRJ-2"])

      yield* Effect.gen(function* () {
        const tasks = yield* TaskRepo
        const sp = yield* tasks.get("sp")
        expect([sp?.key, sp?.status, sp?.parent_id]).toStrictEqual(["PRJ-1", "in_review", null])
        const child = yield* tasks.get("child")
        expect([child?.key, child?.parent_id, child?.base_branch, child?.status, child?.attention_reason, child?.running, child?.steerable]).toStrictEqual([
          "PRJ-2",
          null,
          "ia/prj-1-sub",
          "needs_attention",
          INTERRUPTED,
          false,
          false,
        ])
        expect((yield* tasks.reviewThreads(TaskId.make("child"))).map((t) => t.id)).toStrictEqual(["review"])
        const queued = yield* tasks.get("queued")
        expect([queued?.key, queued?.status, queued?.waiting, queued?.queued_message]).toStrictEqual(["PRJ-3", "in_progress", true, "mine\n\nfrom PRJ-1"])
        expect(queued?.summaries.map((s) => [s.thread_id, s.label])).toStrictEqual([["s1", ""]])
        expect(yield* tasks.queued(TaskId.make("queued"))).toStrictEqual([
          { text: "mine", source: "user", automation_run_id: null },
          { text: "from PRJ-1", source: "agent", automation_run_id: null },
          { text: "", source: "automation", automation_run_id: "ar1" },
        ])
        const chat = yield* tasks.get("chat")
        expect([chat?.key, chat?.task_type, chat?.project_id, chat?.status, chat?.work_dir]).toStrictEqual([
          "S-1",
          "scratch",
          null,
          "done",
          "/nonexistent/scratch",
        ])
        const doc = yield* tasks.get("doc")
        expect([doc?.task_type, doc?.labels, doc?.work_dir, doc?.claude_config_id]).toStrictEqual([
          null,
          ["plan"],
          `${yield* fs.realPath(`${tmp}/old`)}/documents/doc`,
          "deleted-config",
        ])
        expect((yield* tasks.steers(TaskId.make("child"))).length).toBe(0)
        const pens = yield* (yield* PenRepo).list(ProfileId.make("p1"))
        expect(pens.map((p) => [p.name, p.active, p.color])).toStrictEqual([["Today", false, "blue"]])
      }).pipe(Effect.provide(repos(`${tmp}/new/board.db`)))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect("reports a task whose row does not read, and imports the rest", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmp = yield* fs.makeTempDirectoryScoped()
      yield* Effect.scoped(
        Effect.gen(function* () {
          const board = yield* makeLegacyBoard(`${tmp}/old`)
          yield* board.insert("profiles", { id: "p1", name: "Me", created_at: T0 })
          yield* task(board, { id: "ok", project_id: null, task_type: "scratch", number: 1 })
          yield* task(board, { id: "odd", project_id: null, task_type: "mystery", number: 2, queued_message: "lost with it" })
          yield* task(board, { id: "orphan", project_id: null, kind: "review", number: 0 })
        }),
      )
      const result = yield* importLegacy(options(`${tmp}/old`, `${tmp}/new`))
      expect(result.report.failures.map((f) => [f.table, f.key])).toStrictEqual([
        ["tasks", "odd"],
        ["tasks", "orphan"],
      ])
      expect(result.report.tables["tasks"]?.written).toBe(2)
      // The queue of the task that failed is not written beside it.
      expect(result.report.tables["task_queue"]).toStrictEqual({ old: 1, written: 0, withheld: 0 })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
