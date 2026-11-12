import { SqliteClient } from "@effect/sql-sqlite-node"
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option, Result, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { TaskId } from "@huntaway/contracts"
import type { Item, ThreadRequest } from "@huntaway/contracts"
import { makeLegacyBoard } from "@huntaway/testing"
import type { LegacyBoard } from "@huntaway/testing"
import { AgentToolsRepo } from "../../../agents/AgentToolsRepo.ts"
import { jsonText } from "../../../agents/claude/tools.ts"
import { Db } from "../../../platform/Db.ts"
import { ThreadStore } from "../../../threads/ThreadStore.ts"
import type { Family } from "../family.ts"
import { importLegacy } from "../run.ts"
import { FAMILIES } from "./index.ts"
import { counterValue, insertionIndex, itemRow, LEGACY_MESSAGE, messageItems, requestRow, toolsRows, withMessages, writeNumber } from "./threads.ts"
import type { OldItem, OldMessage, OldRequest, Prior } from "./threads.ts"

// The threads family (docs/plan/11-migration.md, Table by table and Threads not yet items). The rows below are
// hand-written in the shapes an old test server's fake agent left (a start message, notices, a Bash call with its
// prompt, a reply and a turn result, a question still pending); none is real data.

const T = "2026-01-01T00:00:0"
const at = (s: number) => `${T}${s}.000Z`

const oldItem = (over: Partial<OldItem> & Pick<OldItem, "id" | "pos" | "type" | "data">): OldItem => ({
  task_id: "t1",
  parent_id: null,
  meta: null,
  created_at: at(1),
  updated_at: at(1),
  write_no: null,
  ...over,
})

const oldRequest = (data: unknown, over: Partial<OldRequest> = {}): OldRequest => ({
  task_id: "t1",
  id: "r1",
  pos: 0,
  type: "permission",
  tool_call_id: null,
  open: 1,
  data: jsonText(data),
  created_at: at(1),
  updated_at: at(1),
  ...over,
})

const oldMessage = (id: number, kind: string, data: unknown): OldMessage => ({
  id,
  task_id: "t1",
  kind,
  data: typeof data === "string" ? data : jsonText(data),
  created_at: at(5),
  key: "PRJ-1",
})

const permission = (metadata: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: "r1",
  type: "permission",
  name: "Bash",
  kind: "shell",
  input: { command: "echo fake" },
  metadata,
  ...extra,
})

const assistantLine = (text: string) => ({
  type: "assistant",
  session_id: "s-1",
  parent_tool_use_id: null,
  message: { id: "msg_1", role: "assistant", content: [{ type: "text", text }] },
})

const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))
const parseJson = (text: string): unknown => Result.getOrElse(decodeJson(text), () => undefined)

const noPrior: Prior = { items: [], requests: [], meta: () => undefined, ids: new Set() }

describe("threads family: conversions", () => {
  it.each([
    [5, 5],
    ["12", 12],
    [18.0, 18],
    ["x", null],
    [null, null],
    [undefined, null],
    [-1, null],
  ])("a write number %j reads as %j", (value, expected) => {
    expect(writeNumber(value)).toBe(expected)
  })

  it("an item keeps its id, position, data and meta; its write is the lowest origin", () => {
    const data = '{"id":"legacy:1","type":"user_message","text":"Go","turn_id":"x","extra":1}'
    expect(itemRow(oldItem({ id: "legacy:1", pos: 3, type: "user_message", data, meta: '{"auto":true}', write_no: 1 }))).toEqual({
      task_id: "t1",
      id: "legacy:1",
      pos: 3,
      type: "user_message",
      parent_id: null,
      write_no: 1,
      data,
      meta: '{"auto":true}',
      created_at: at(1),
      updated_at: at(1),
    })
  })

  it.each([
    {
      name: "write from metadata.message_id, text kept as stored",
      data: permission({ status: "allowed", message_id: 5 }, { resolution: { outcome: "allow" } }),
      pending: false,
      write_no: 5,
      open: 0,
      changed: false,
    },
    {
      name: "a workflow approval stored as an automation's says workflow",
      data: permission({ status: "allowed", kind: "automation", message_id: 7 }, { input: { workflow: { id: "w" } }, resolution: { outcome: "allow" } }),
      pending: false,
      write_no: 7,
      open: 0,
      changed: true,
      kind: "workflow",
    },
    {
      name: "an automation's approval stays an automation's",
      data: permission({ status: "allowed", kind: "automation", message_id: 7 }, { input: { automation: { id: "a" } }, resolution: { outcome: "allow" } }),
      pending: false,
      write_no: 7,
      open: 0,
      changed: false,
      kind: "automation",
    },
    {
      name: "a prompt still pending is expired",
      data: permission({ status: "pending", message_id: 9 }),
      pending: true,
      write_no: 9,
      open: 0,
      changed: true,
      status: "expired",
      resolution: { outcome: "cancel", message: "Request expired" },
    },
    {
      name: "a board question with no prompt row stays open",
      data: { id: "legacy:9", type: "question", questions: [{ id: "q", question: "?" }], metadata: { status: "pending", message_id: 9 } },
      pending: false,
      write_no: 9,
      open: 1,
      changed: false,
    },
    {
      name: "no message_id: no write",
      data: permission({ status: "allowed" }, { resolution: { outcome: "allow" } }),
      pending: false,
      write_no: null,
      open: 0,
      changed: false,
    },
  ])("a request: $name", (c) => {
    const old = oldRequest(c.data)
    const row = requestRow(old, c.pending)
    expect(row["write_no"]).toBe(c.write_no)
    expect(row["open"]).toBe(c.open)
    if (!c.changed) expect(row["data"]).toBe(old.data)
    else {
      expect(row["data"]).toMatchObject({
        metadata: { message_id: c.write_no, ...(c.kind === undefined ? {} : { kind: c.kind }), ...(c.status === undefined ? {} : { status: c.status }) },
        ...(c.resolution === undefined ? {} : { resolution: c.resolution }),
      })
    }
  })

  it("a request that is not JSON is passed on as it is (the row check reports it)", () => {
    const row = requestRow({ ...oldRequest({}), data: "{nope", open: 1 }, true)
    expect(row).toMatchObject({ data: "{nope", write_no: null, open: 1 })
  })

  it("thread tools are merged by task", () => {
    expect(
      toolsRows(
        [
          { task_id: "a", list: '["s"]' },
          { task_id: "b", list: '["t"]' },
        ],
        [
          { task_id: "b", list: '["gh"]' },
          { task_id: "c", list: '["docs"]' },
        ],
      ),
    ).toEqual([
      { task_id: "a", skills: '["s"]', disabled_mcp_servers: "[]" },
      { task_id: "b", skills: '["t"]', disabled_mcp_servers: '["gh"]' },
      { task_id: "c", skills: "[]", disabled_mcp_servers: '["docs"]' },
    ])
  })

  it.each([
    [[18.0, 3, null, "40"], 40],
    [[], 0],
    [[null, undefined, "x"], 0],
  ])("the counter of %j is %j", (marks, expected) => {
    expect(counterValue(marks)).toBe(expected)
  })

  it.each([
    [[1, 2, 4, 8, 10], 9, 4],
    [[1, 2, 4], 9, 3],
    [[null, 5, null, 12], 9, 3],
    [[], 3, 0],
  ])("among writes %j, write %j goes at %j", (written, writeNo, expected) => {
    expect(insertionIndex(written, writeNo)).toBe(expected)
  })

  it("a kept assistant line is converted by the translator, at its id", () => {
    const made = messageItems(oldMessage(9, "claude", assistantLine("A late reply")), noPrior)
    expect(made.how).toBe("converted")
    expect(made.entries.map((e) => e.item)).toEqual([{ id: "legacy:9:0", type: "assistant_message", text: "A late reply", created_at: at(5) }])
  })

  it("a kept result line is converted with its turn's cost", () => {
    const made = messageItems(
      oldMessage(9, "claude", { type: "result", subtype: "success", is_error: false, result: "Done", num_turns: 1, total_cost_usd: 0.5 }),
      noPrior,
    )
    expect(made.how).toBe("converted")
    const result = made.entries.find((e) => e.item.type === "turn_result")
    expect(result?.item).toMatchObject({ id: "legacy:9", ok: true, metadata: { total_cost_usd: 0.5 } })
    expect(result?.meta).toEqual({ result_text: "Done" })
  })

  it.each([
    { name: "a user message (the board's own write)", kind: "user", data: { text: "Hello" } },
    { name: "an event", kind: "event", data: { level: "warn", text: "Odd" } },
    { name: "a line that is not JSON", kind: "claude", data: "{not json" },
    {
      name: "a tool result (it changes an item already there)",
      kind: "claude",
      data: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] } },
    },
    { name: "a line that makes no item", kind: "claude", data: { type: "system", subtype: "init", session_id: "s" } },
  ])("$name is carried as a notice with the row whole", ({ kind, data }) => {
    const m = oldMessage(12, kind, data)
    const made = messageItems(m, noPrior)
    expect(made.how).toBe("carried")
    const [entry] = made.entries
    expect(entry?.item).toMatchObject({ id: "legacy:12", type: "notice", level: "warning", code: "legacy_message", text: LEGACY_MESSAGE, created_at: at(5) })
    const detail = entry?.item.type === "notice" ? entry.item.detail : undefined
    expect(parseJson(detail ?? "null")).toEqual({ kind, data })
  })

  it("a converted line whose item id the thread has already is carried instead", () => {
    const made = messageItems(oldMessage(9, "claude", assistantLine("Again")), { ...noPrior, ids: new Set(["legacy:9:0"]) })
    expect(made.how).toBe("carried")
    expect(made.entries[0]?.item.id).toBe("legacy:9")
  })

  it("a carried notice whose id the thread has takes another", () => {
    const made = messageItems(oldMessage(9, "event", { text: "x" }), { ...noPrior, ids: new Set(["legacy:9"]) })
    expect(made.entries[0]?.item.id).toBe("legacy:9:message")
  })

  it("kept messages go in at their writes, and positions are numbered again", () => {
    const items = [
      oldItem({ id: "legacy:1", pos: 0, type: "user_message", data: '{"id":"legacy:1","type":"user_message","text":"Go"}', write_no: 1 }),
      oldItem({ id: "legacy:8", pos: 4, type: "turn_result", data: '{"id":"legacy:8","type":"turn_result","ok":true}', write_no: 8 }),
      oldItem({
        id: "toolu_Q",
        pos: 7,
        type: "tool_call",
        data: '{"id":"toolu_Q","type":"tool_call","name":"X","kind":"other","input":{},"status":"running"}',
        write_no: 10,
      }),
    ]
    const merged = withMessages(items, [oldMessage(12, "event", { text: "late" }), oldMessage(9, "claude", assistantLine("Between"))], [])
    expect(merged.rows.map((r) => [r["id"], r["pos"], r["write_no"]])).toEqual([
      ["legacy:1", 0, 1],
      ["legacy:8", 1, 8],
      ["legacy:9:0", 2, 9],
      ["toolu_Q", 3, 10],
      ["legacy:12", 4, 12],
    ])
    expect(merged.how.map((h) => [h.message.id, h.how])).toEqual([
      [9, "converted"],
      [12, "carried"],
    ])
  })
})

// ---- the import, read back through the new server -------------------------------------------------------------------

/**
 * Until the families that import profiles, projects and tasks are in `FAMILIES`, a stand-in copies the few columns
 * the threads' rows point at, so they are not dropped as pointing at nothing.
 */
const standIn: Family = {
  name: "test: profiles, projects and tasks",
  reads: [],
  writes: ["profiles", "projects", "tasks"],
  run: (io) =>
    Effect.gen(function* () {
      for (const p of yield* io.old.rows("profiles"))
        yield* io.exec(`INSERT INTO profiles (id, name, created_at) VALUES (?, ?, ?)`, [String(p["id"]), String(p["name"]), String(p["created_at"])])
      for (const p of yield* io.old.rows("projects"))
        yield* io.exec(
          `INSERT INTO projects (id, profile_id, name, key, repo_path, scratch_path, worktrees_root, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            String(p["id"]),
            String(p["profile_id"]),
            String(p["name"]),
            String(p["key"]),
            String(p["repo_path"]),
            String(p["scratch_path"]),
            String(p["worktrees_root"]),
            String(p["created_at"]),
          ],
        )
      for (const t of yield* io.old.rows("tasks"))
        yield* io.exec(
          `INSERT INTO tasks (id, profile_id, project_id, number, title, last_activity_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            String(t["id"]),
            String(t["profile_id"]),
            typeof t["project_id"] === "string" ? t["project_id"] : null,
            typeof t["number"] === "number" ? t["number"] : null,
            String(t["title"]),
            String(t["last_activity_at"]),
            String(t["created_at"]),
            String(t["updated_at"]),
          ],
        )
    }),
}
const families = FAMILIES.some((f) => f.writes.includes("tasks")) ? FAMILIES : [standIn, ...FAMILIES]

const options = (from: string, dataDir: string) => ({ from, dataDir, check: true, force: false, rehearsal: false, database: Option.none<string>(), families })

const j = jsonText

/** An old board with one task's thread (items, origins, requests, two kept messages) and two threads' tools. */
const oldBoard = (root: string, more: (old: LegacyBoard) => Effect.Effect<void> = () => Effect.void) =>
  Effect.scoped(
    Effect.gen(function* () {
      const old = yield* makeLegacyBoard(root)
      yield* old.insert("profiles", { id: "p1", name: "Me", created_at: at(0) })
      yield* old.insert("projects", {
        id: "j1",
        profile_id: "p1",
        name: "Proj",
        key: "PRJ",
        repo_path: "/nonexistent/repo",
        scratch_path: "/nonexistent/scratch",
        worktrees_root: "/nonexistent/wt",
        created_at: at(0),
      })
      for (const [id, number, title] of [
        ["t1", 1, "Threaded"],
        ["t2", 2, "Review thread"],
        ["t3", 3, "Workflow step"],
      ] as const)
        yield* old.insert("tasks", {
          id,
          profile_id: "p1",
          project_id: "j1",
          number,
          title,
          thread_source: "items",
          thread_items: 1,
          last_activity_at: at(0),
          created_at: at(0),
          updated_at: at(0),
        })
      // An older translator's thread: imported as it is.
      yield* old.insert("threads", { task_id: "t1", seq: 20, converter: 4, writes: 19, created_at: at(1) })
      const items: ReadonlyArray<readonly [string, number, string, unknown, unknown, ReadonlyArray<number>]> = [
        [
          "legacy:1",
          0,
          "user_message",
          { id: "legacy:1", type: "user_message", text: "Start working on this task.", metadata: { auto: true } },
          { auto: true, start: true },
          [1],
        ],
        ["legacy:2", 1, "notice", { id: "legacy:2", type: "notice", level: "info", text: "Setting up worktree…" }, null, [2]],
        [
          "toolu_A",
          2,
          "tool_call",
          {
            id: "toolu_A",
            type: "tool_call",
            name: "Bash",
            kind: "shell",
            command: "echo fake",
            input: { command: "echo fake" },
            status: "completed",
            result: { content: "fake" },
          },
          { session: "s-1" },
          [6, 4],
        ],
        // A gap in positions, and a field this build does not know.
        ["legacy:7:0", 4, "assistant_message", { id: "legacy:7:0", type: "assistant_message", text: "Done.", future_field: { x: 1 } }, null, [7]],
        [
          "legacy:8",
          5,
          "turn_result",
          { id: "legacy:8", type: "turn_result", ok: true, duration_ms: 1, metadata: { subtype: "success", num_turns: 1, total_cost_usd: 0 } },
          { result_text: "Done." },
          [8],
        ],
        [
          "toolu_Q",
          6,
          "tool_call",
          { id: "toolu_Q", type: "tool_call", name: "AskUserQuestion", kind: "other", input: { questions: [{ question: "Which one?" }] }, status: "running" },
          { session: "s-1" },
          [10],
        ],
      ]
      for (const [id, pos, type, data, meta, origins] of items) {
        yield* old.insert("thread_items", {
          task_id: "t1",
          id,
          pos,
          type,
          turn_id: "turn-1",
          live: 0,
          data: j(data),
          meta: meta === null ? null : j(meta),
          created_at: at(1),
          updated_at: at(2),
        })
        for (const o of origins) yield* old.insert("thread_item_origins", { task_id: "t1", item_id: id, message_id: o })
      }
      const request = (id: string, pos: number, type: string, data: Record<string, unknown>, toolCall: string | null) =>
        old.insert("thread_requests", {
          task_id: "t1",
          id,
          pos,
          type,
          tool_call_id: toolCall,
          turn_id: null,
          open: data["resolution"] === undefined ? 1 : 0,
          data: j({ id, type, ...data }),
          created_at: at(1),
          updated_at: at(2),
        })
      yield* request(
        "perm-1",
        0,
        "permission",
        {
          tool_call_id: "toolu_A",
          name: "Bash",
          kind: "shell",
          input: { command: "echo fake" },
          title: "echo fake",
          metadata: { tool_name: "Bash", request_id: "perm-1", status: "allowed", message_id: 5 },
          resolution: { outcome: "allow" },
        },
        "toolu_A",
      )
      yield* request(
        "perm-2",
        1,
        "question",
        {
          tool_call_id: "toolu_Q",
          questions: [{ id: "Which one?", question: "Which one?", options: [{ label: "a" }, { label: "b" }], allow_other: true }],
          metadata: { tool_name: "AskUserQuestion", request_id: "perm-2", status: "pending", message_id: 10 },
        },
        "toolu_Q",
      )
      yield* request(
        "perm-3",
        2,
        "permission",
        {
          name: "create_workflow",
          kind: "app",
          input: { workflow: { id: "w1", name: "Flow" } },
          metadata: { tool_name: "create_workflow", request_id: "perm-3", status: "allowed", kind: "automation", message_id: 11 },
          resolution: { outcome: "allow" },
        },
        null,
      )
      const prompt = (id: string, message: number, tool: string, status: string, kind = "tool") =>
        old.insert("permission_requests", { id, task_id: "t1", message_id: message, tool_name: tool, input: "{}", status, kind, created_at: at(1) })
      yield* prompt("perm-1", 5, "Bash", "allowed")
      yield* prompt("perm-2", 10, "AskUserQuestion", "pending")
      yield* prompt("perm-3", 11, "create_workflow", "allowed", "automation")
      // Two messages kept after their items could not be written: a reply the translator converts, an event it does not.
      yield* old.insert("messages", { id: 9, task_id: "t1", kind: "claude", data: j(assistantLine("A late reply")), created_at: at(5) })
      yield* old.insert("messages", { id: 12, task_id: "t1", kind: "event", data: j({ level: "warn", text: "Odd", detail: null }), created_at: at(6) })
      // The sequence went on past them without rows (writes of items tasks take ids and write no row); stored as a REAL,
      // as the old server's `seq = seq + 1` leaves it.
      yield* old.run(`UPDATE sqlite_sequence SET seq = 40.0 WHERE name = 'messages'`)
      yield* old.insert("thread_events", { task_id: "t1", seq: 20, type: "item.added", data: "{}", created_at: at(2) })
      yield* old.insert("mcp_calls", { id: "c1", run_id: "r1", task_id: "t1", tool: "list_tasks", args: "{}", status: "done", created_at: at(2) })
      yield* old.insert("review_thread_skills", { task_id: "t2", skills: j(["skill-a"]) })
      yield* old.insert("thread_mcp_servers", { task_id: "t2", disabled: j(["gh"]) })
      yield* old.insert("thread_mcp_servers", { task_id: "t3", disabled: j(["docs"]) })
      yield* more(old)
    }),
  )

/** The new board's repositories, over its database. */
const boardLayer = (file: string) =>
  Layer.mergeAll(ThreadStore.layer, AgentToolsRepo.layer).pipe(
    Layer.provideMerge(Layer.provideMerge(Db.layerOver, Layer.orDie(SqliteClient.layer({ filename: file })))),
  )

describe("threads family: imported", () => {
  it.effect("a thread reads back whole through the store, with its kept messages, requests, counter and tools", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmp = yield* fs.makeTempDirectoryScoped()
      yield* oldBoard(`${tmp}/old`)
      const result = yield* importLegacy(options(`${tmp}/old`, `${tmp}/new`))
      expect(result.report.failures).toEqual([])
      expect(result.report.json).toEqual([])
      expect(result.passes).toBe(true)
      expect(result.report.messages).toEqual({ converted: { "PRJ-1": 1 }, carried: { "PRJ-1": 1 } })
      expect(result.report.tables["threads"]).toEqual({ old: 1, written: 1, withheld: 0 })
      expect(result.report.tables["thread_items"]).toEqual({ old: 6, written: 8, withheld: 0 })
      expect(result.report.tables["thread_requests"]).toEqual({ old: 3, written: 3, withheld: 0 })
      expect(result.report.tables["thread_tools"]).toEqual({ old: 3, written: 2, withheld: 0 })
      expect(result.report.tables["thread_events (not imported)"]?.old).toBe(1)
      expect(result.report.tables["mcp_calls (not imported)"]?.old).toBe(1)

      yield* Effect.gen(function* () {
        const store = yield* ThreadStore
        const t1 = TaskId.make("t1")
        const state = yield* store.window(t1, undefined)
        expect(state.seq).toBe(20)
        expect(state.items.map((i: Item) => i.id)).toEqual(["legacy:1", "legacy:2", "toolu_A", "legacy:7:0", "legacy:8", "legacy:9:0", "toolu_Q", "legacy:12"])
        const entries = yield* store.entries(t1)
        expect(entries.map((e) => e.write_no)).toEqual([1, 2, 4, 7, 8, 9, 10, 12])
        expect(entries[0]?.meta).toEqual({ auto: true, start: true })
        expect(entries.find((e) => e.item.id === "legacy:9:0")?.item).toMatchObject({ type: "assistant_message", text: "A late reply" })
        const carried = entries.find((e) => e.item.id === "legacy:12")?.item
        expect(carried).toMatchObject({ type: "notice", level: "warning", code: "legacy_message", text: LEGACY_MESSAGE })
        expect(parseJson(carried?.type === "notice" ? (carried.detail ?? "") : "")).toEqual({
          kind: "event",
          data: { level: "warn", text: "Odd", detail: null },
        })
        // A window of the last two: the store reads the imported rows the way it reads its own.
        expect((yield* store.window(t1, 2)).items.map((i: Item) => i.id)).toEqual(["toolu_Q", "legacy:12"])

        const allowed = yield* store.request(t1, "perm-1")
        expect(allowed?.write_no).toBe(5)
        expect(allowed?.request.resolution).toEqual({ outcome: "allow" })
        const expired = yield* store.request(t1, "perm-2")
        expect(expired?.write_no).toBe(10)
        expect(expired?.request.resolution).toEqual({ outcome: "cancel", message: "Request expired" })
        expect(expired?.request.metadata).toMatchObject({ status: "expired", message_id: 10 })
        const workflow = yield* store.request(t1, "perm-3")
        expect(workflow?.write_no).toBe(11)
        expect(workflow?.request.metadata?.["kind"]).toBe("workflow")
        expect((yield* store.openRequests(t1)).map((r: ThreadRequest) => r.id)).toEqual([])

        // The next write number goes on after the old sequence's mark.
        expect(yield* store.nextWriteNo).toBe(41)

        const tools = yield* AgentToolsRepo
        expect(yield* tools.threadTools(TaskId.make("t2"))).toEqual({ skills: ["skill-a"], disabled_mcp_servers: ["gh"] })
        expect(yield* tools.threadTools(TaskId.make("t3"))).toEqual({ skills: [], disabled_mcp_servers: ["docs"] })

        // Unknown fields are kept in the stored item; `turn_id` and `live` are gone.
        const sql = yield* SqlClient.SqlClient
        const raw = yield* sql<{ readonly data: string }>`SELECT data FROM thread_items WHERE task_id = 't1' AND id = 'legacy:7:0'`
        expect(raw[0]?.data).toContain('"future_field":{"x":1}')
      }).pipe(Effect.provide(boardLayer(`${tmp}/new/board.db`)))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect("the counter is at least every write kept, past a sequence that fell behind", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmp = yield* fs.makeTempDirectoryScoped()
      yield* oldBoard(`${tmp}/old`, (old) =>
        Effect.gen(function* () {
          yield* old.run(`UPDATE sqlite_sequence SET seq = 3 WHERE name = 'messages'`)
          yield* old.run(`UPDATE permission_requests SET message_id = 77 WHERE id = 'perm-1'`)
        }),
      )
      const result = yield* importLegacy(options(`${tmp}/old`, `${tmp}/new`))
      expect(result.passes).toBe(true)
      yield* Effect.gen(function* () {
        expect(yield* (yield* ThreadStore).nextWriteNo).toBe(78)
      }).pipe(Effect.provide(boardLayer(`${tmp}/new/board.db`)))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
