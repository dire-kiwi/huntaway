import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Path, Schema } from "effect"
import type { FileSystem, Scope } from "effect"
import { SqlClient } from "effect/sql"
import { applyEvents, initialState, itemPage, ProfileId, SavedEvent, snapshotWindow, Timestamp } from "@huntaway/contracts"
import type { Item, NewEvent, Snapshot, TaskId, Thread, ThreadRequest, ToolCall } from "@huntaway/contracts"
import { readJsonLines, TestBoard, threadFixturesDir } from "@huntaway/testing"
import { Actor } from "../platform/Changes.ts"
import { Db } from "../platform/Db.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { WriteNo } from "./model.ts"
import { ThreadStore } from "./ThreadStore.ts"
import type { AppendOptions } from "./ThreadStore.ts"

// The thread store (the old threads/store.test.ts): appending numbers and applies events, requests in place, the log and
// its pruning, windows and pages read from the tables against the contracts' reducer and window functions, write
// numbers. Dropped from the old cases: origins (`item_origins`, `items_from`: an item's write is its `write_no`),
// `items.removed`, `turn.*` and `thread.updated` events (not in the protocol any more), `clear` and `log: false` (for
// rebuilds from messages, which are gone), and the live `live` column (no reader used it).

const AT = Timestamp.make("2026-11-12T00:00:00.000Z")
const thread = (id: TaskId): Thread => ({ id, harness: "claude", status: "idle", created_at: AT })

/** A task in a profile of its own (made the first time). */
const newTask = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const tasks = yield* Tasks
  yield* sql`INSERT OR IGNORE INTO profiles (id, name, created_at) VALUES ('p', 'p', ${AT})`.pipe(Effect.orDie)
  return (yield* tasks.create({ profile_id: ProfileId.make("p") }, Actor.user)).id
}).pipe(Effect.orDie)

/** Appends in a transaction of its own, at `AT` unless told otherwise. */
const append = (task: TaskId, events: ReadonlyArray<NewEvent>, options: Partial<AppendOptions> = {}) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore
    const db = yield* Db
    return yield* db.tx(store.append(task, events, { at: AT, ...options }))
  })

const added = (item: Item): NewEvent => ({ type: "item.added", item })
const note = (id: string) => added({ id, type: "notice", level: "info", text: id })
const notices = (n: number, from = 0): ReadonlyArray<NewEvent> =>
  Array.from({ length: n }, (_, i) => added({ id: `n${from + i}`, type: "notice", level: "info", text: `${from + i}` }))
const ids = (list: ReadonlyArray<{ readonly id: string }>) => list.map((x) => x.id)
const rows = (table: string, task: TaskId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const found = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${sql(table)} WHERE task_id = ${task}`.pipe(Effect.orDie)
    return found[0]?.n ?? 0
  })

/** The whole thread as the store has it. */
const whole = (task: TaskId) =>
  Effect.gen(function* () {
    const state = yield* (yield* ThreadStore).window(task, undefined)
    const snapshot: Snapshot = { thread: thread(task), ...state }
    return snapshot
  })

const run = <A, E>(effect: Effect.Effect<A, E, ThreadStore | Tasks | Db | SqlClient.SqlClient | FileSystem.FileSystem | Path.Path | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(TestBoard()))

describe("ThreadStore.append", () => {
  it.effect("adds items after the last, and updates them in place", () =>
    run(
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const task = yield* newTask
        const call: ToolCall = { id: "tc1", type: "tool_call", name: "Bash", kind: "shell", input: { command: "ls" }, status: "pending" }
        const saved = yield* append(task, [added({ id: "u1", type: "user_message", text: "hi" }), added(call)], { writeNo: WriteNo.make(7) })
        assert.deepStrictEqual(
          saved.map((e) => [e.thread_id, e.seq, e.type]),
          [
            [task, 1, "item.added"],
            [task, 2, "item.added"],
          ],
        )
        const positions = Effect.map(store.entries(task), (es) => es.map((e) => [e.item.id, e.pos, e.write_no]))
        assert.deepStrictEqual(yield* positions, [
          ["u1", 0, 7],
          ["tc1", 1, 7],
        ])
        yield* append(task, [{ type: "item.updated", item_id: "tc1", patch: { status: "completed", result: { content: "a" } } }], { writeNo: WriteNo.make(8) })
        assert.deepStrictEqual((yield* store.item(task, "tc1"))?.item, { ...call, status: "completed", result: { content: "a" } })
        // Added again with its id: replaced where it was, and it keeps the write that made it.
        yield* append(task, [added({ ...call, status: "failed" }), added({ id: "a1", type: "assistant_message", text: "done" })], { writeNo: WriteNo.make(9) })
        assert.deepStrictEqual(yield* positions, [
          ["u1", 0, 7],
          ["tc1", 1, 7],
          ["a1", 2, 9],
        ])
        const tc1 = (yield* store.item(task, "tc1"))?.item
        assert.strictEqual(tc1?.type === "tool_call" ? tc1.status : null, "failed")
        // An update to an item it doesn't have only goes in the log.
        yield* append(task, [{ type: "item.updated", item_id: "nope", patch: { text: "x" } }])
        assert.strictEqual(yield* rows("thread_items", task), 3)
        assert.strictEqual(yield* store.seq(task), 6)
        assert.strictEqual((yield* whole(task)).seq, 6)
      }),
    ),
  )

  it.effect("opens and resolves requests in place", () =>
    run(
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const task = yield* newTask
        const p: ThreadRequest = { id: "p1", type: "permission", name: "Bash", kind: "shell", input: {}, tool_call_id: "tc1" }
        const q: ThreadRequest = { id: "q1", type: "question", questions: [{ id: "a", question: "?" }] }
        yield* append(task, [
          { type: "request.opened", request: p },
          { type: "request.opened", request: q },
        ])
        assert.deepStrictEqual(ids(yield* store.openRequests(task)), ["p1", "q1"])
        yield* append(task, [
          { type: "request.resolved", request_id: "p1", resolution: { outcome: "allow", always: true } },
          { type: "request.resolved", request_id: "nope", resolution: { outcome: "cancel" } },
        ])
        assert.deepStrictEqual(yield* store.requests(task), [{ ...p, resolution: { outcome: "allow", always: true } }, q])
        assert.deepStrictEqual(ids(yield* store.openRequests(task)), ["q1"])
        // Opened again: open again, where it was.
        yield* append(task, [{ type: "request.opened", request: p }])
        assert.deepStrictEqual(yield* store.requests(task), [p, q])
        assert.strictEqual(yield* rows("thread_requests", task), 2)
      }),
    ),
  )

  it.effect("writes all of a write or none of it, with the caller's transaction", () =>
    run(
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const db = yield* Db
        const task = yield* newTask
        yield* append(task, [added({ id: "a", type: "assistant_message", text: "a" })])
        const failed = yield* db
          .tx(
            Effect.gen(function* () {
              yield* store.append(task, [added({ id: "c", type: "assistant_message", text: "c" })], { at: AT })
              return yield* Effect.fail("the rest of the write failed")
            }),
          )
          .pipe(Effect.flip)
        assert.strictEqual(failed, "the rest of the write failed")
        assert.strictEqual(yield* store.seq(task), 1)
        assert.deepStrictEqual(
          (yield* store.entries(task)).map((e) => e.item.id),
          ["a"],
        )
        assert.strictEqual(yield* rows("thread_events", task), 1)
      }),
    ),
  )

  it.effect("numbers each thread's events on its own, whatever it was given", () =>
    run(
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const task = yield* newTask
        const other = yield* newTask
        yield* append(task, [note("a")])
        yield* append(other, [note("a"), note("b")])
        yield* append(task, [note("b")])
        assert.deepStrictEqual([yield* store.seq(task), yield* store.seq(other)], [2, 2])
        // A thread and seq it was given are replaced.
        const sneaky = Object.assign(note("c"), { thread_id: "x", seq: 99 })
        const [e] = yield* append(task, [sneaky])
        assert.deepStrictEqual([e?.thread_id, e?.seq], [task, 3])
        // A thread with no row has seq 0.
        assert.strictEqual(yield* store.seq(yield* newTask), 0)
      }),
    ),
  )

  it.effect("items keep what the board knows about them", () =>
    run(
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const task = yield* newTask
        yield* append(task, [added({ id: "u1", type: "user_message", text: "hi" })])
        assert.deepStrictEqual((yield* store.item(task, "u1"))?.meta, {})
        yield* append(task, [], { metas: new Map([["u1", { from_agent: true }]]) })
        // An update to the item, or the item added again, leaves it.
        yield* append(task, [{ type: "item.updated", item_id: "u1", patch: { steered: true } }, added({ id: "u1", type: "user_message", text: "hi!" })])
        assert.deepStrictEqual((yield* store.item(task, "u1"))?.meta, { from_agent: true })
        yield* append(task, [], { metas: new Map([["u1", {}]]) })
        assert.deepStrictEqual((yield* store.item(task, "u1"))?.meta, {})
      }),
    ),
  )

  it.effect("a task's thread goes with it", () =>
    run(
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const tasks = yield* Tasks
        const task = yield* newTask
        const other = yield* newTask
        for (const t of [task, other]) {
          yield* append(
            t,
            [
              added({ id: "a", type: "assistant_message", text: "a" }),
              { type: "request.opened", request: { id: "p", type: "permission", name: "Bash", kind: "shell", input: {} } },
            ],
            { metas: new Map([["a", { auto: true }]]) },
          )
        }
        const tables = ["threads", "thread_items", "thread_requests", "thread_events"]
        const counts = (t: TaskId) => Effect.forEach(tables, (table) => (table === "threads" ? rows("threads", t) : rows(table, t)), { concurrency: 1 })
        assert.deepStrictEqual(yield* counts(task), [1, 1, 1, 2])
        yield* tasks.delete(task, { deleteBranch: false }, Actor.user)
        assert.deepStrictEqual(yield* counts(task), [0, 0, 0, 0])
        assert.deepStrictEqual(yield* counts(other), [1, 1, 1, 2])
        assert.deepStrictEqual((yield* store.item(other, "a"))?.meta, { auto: true })
      }),
    ),
  )

  it.effect("write numbers go up across the whole board, from 1", () =>
    run(
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const db = yield* Db
        const taken = yield* Effect.forEach([1, 2, 3], () => db.tx(store.nextWriteNo), { concurrency: 1 })
        assert.deepStrictEqual(taken, [1, 2, 3])
        // One rolled back is not taken.
        yield* db.tx(Effect.andThen(store.nextWriteNo, Effect.fail("no"))).pipe(Effect.ignore)
        assert.strictEqual(yield* db.tx(store.nextWriteNo), 4)
      }),
    ),
  )
})

describe("ThreadStore's log", () => {
  const twoDaysAgo = Timestamp.make("2026-11-10T00:00:00.000Z")
  const halfADayAgo = Timestamp.make("2026-11-11T12:00:00.000Z")

  it.effect("saves events numbered, and reads them back after a seq", () =>
    run(
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const task = yield* newTask
        const saved = yield* append(task, notices(5))
        assert.deepStrictEqual(yield* store.eventsAfter(task, 0), saved)
        assert.deepStrictEqual(yield* store.eventsAfter(task, 3), saved.slice(3))
        assert.deepStrictEqual(yield* store.eventsAfter(task, 5), [])
        assert.deepStrictEqual(yield* store.eventsAfter(task, 9), [])
      }),
    ),
  )

  it.effect("keeps a thread's last day of events, and its seq when they've gone", () =>
    run(
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const task = yield* newTask
        yield* append(task, notices(10), { at: twoDaysAgo })
        // Old, but nothing has been written since: all kept.
        assert.strictEqual(yield* rows("thread_events", task), 10)
        yield* append(task, notices(5, 10), { at: halfADayAgo })
        yield* append(task, notices(1, 15))
        assert.strictEqual(yield* store.seq(task), 16)
        assert.strictEqual(yield* rows("thread_events", task), 6)
        // The items stay, and so does the seq.
        assert.strictEqual((yield* whole(task)).items.length, 16)
        // A client further behind than the log takes a snapshot.
        assert.isNull(yield* store.eventsAfter(task, 0))
        assert.isNull(yield* store.eventsAfter(task, 9))
        assert.strictEqual((yield* store.eventsAfter(task, 10))?.length, 6)
        // With every event gone, the seq is kept: one up to date has nothing to catch up on, one behind takes a snapshot.
        assert.strictEqual(yield* store.prune(Timestamp.make("2026-11-15T00:00:00.000Z")), 6)
        assert.strictEqual(yield* store.seq(task), 16)
        assert.deepStrictEqual(yield* store.eventsAfter(task, 16), [])
        assert.isNull(yield* store.eventsAfter(task, 15))
        const [next] = yield* append(task, notices(1, 16))
        assert.strictEqual(next?.seq, 17)
        assert.deepStrictEqual(
          (yield* store.eventsAfter(task, 16))?.map((e) => e.seq),
          [17],
        )
      }),
    ),
  )

  it.effect("prune sweeps every thread", () =>
    run(
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const sql = yield* SqlClient.SqlClient
        const task = yield* newTask
        const other = yield* newTask
        yield* append(task, notices(10), { at: twoDaysAgo })
        yield* append(other, notices(3), { at: twoDaysAgo })
        yield* append(other, notices(2, 3))
        const seqs = (t: TaskId) =>
          Effect.map(sql<{ seq: number }>`SELECT seq FROM thread_events WHERE task_id = ${t} ORDER BY seq`.pipe(Effect.orDie), (r) => r.map((x) => x.seq))
        assert.deepStrictEqual(yield* seqs(other), [4, 5])
        assert.strictEqual(yield* store.prune(Timestamp.make("2026-11-11T00:00:00.000Z")), 10)
        assert.deepStrictEqual(yield* seqs(task), [])
        assert.deepStrictEqual(yield* seqs(other), [4, 5])
        assert.deepStrictEqual([yield* store.seq(task), yield* store.seq(other)], [10, 5])
      }),
    ),
  )

  it.effect("an event of a type a newer build saved reads back as unknown", () =>
    run(
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const sql = yield* SqlClient.SqlClient
        const task = yield* newTask
        yield* append(task, notices(1))
        const newer = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ type: "thread.renamed", thread_id: task, seq: 2, title: "x" }).pipe(
          Effect.orDie,
        )
        yield* sql`INSERT INTO thread_events (task_id, seq, type, data, created_at) VALUES (${task}, 2, 'thread.renamed', ${newer}, ${AT})`.pipe(Effect.orDie)
        yield* sql`UPDATE threads SET seq = 2 WHERE task_id = ${task}`.pipe(Effect.orDie)
        const [, unknown] = (yield* store.eventsAfter(task, 0)) ?? []
        assert.deepStrictEqual([unknown?.type, unknown?.seq, Schema.is(SavedEvent)(unknown)], ["thread.renamed", 2, false])
      }),
    ),
  )
})

const msg = (id: string, parent_id?: string): Item => ({ id, type: "assistant_message", text: id, ...(parent_id === undefined ? {} : { parent_id }) })
const agent = (id: string, status: ToolCall["status"], parent_id?: string): Item => ({
  id,
  type: "tool_call",
  name: "Agent",
  kind: "subagent",
  input: {},
  status,
  ...(parent_id === undefined ? {} : { parent_id }),
})
const permission = (id: string, extra: Partial<Pick<ThreadRequest, "tool_call_id" | "parent_id">> = {}): ThreadRequest => ({
  id,
  type: "permission",
  name: "Bash",
  kind: "shell",
  input: {},
  ...extra,
})

/** The contracts' windows thread, with sb's subagent still running: m0 sa m2 sb m4 b1 m6 tc m8 m9. */
const events: ReadonlyArray<NewEvent> = [
  added(msg("m0")),
  added(agent("sa", "completed")),
  added(msg("m2")),
  added(agent("sb", "running", "sa")),
  added(msg("m4")),
  added(msg("b1", "sb")),
  added(msg("m6")),
  added({ id: "tc", type: "tool_call", name: "Bash", kind: "shell", input: {}, status: "pending", parent_id: "sa" }),
  added(msg("m8")),
  added(msg("m9")),
  ...[
    permission("p-old", { tool_call_id: "m2" }),
    permission("p-sa", { tool_call_id: "tc", parent_id: "sa" }),
    permission("p-new", { tool_call_id: "m8" }),
    permission("p-none"),
    permission("p-gone", { tool_call_id: "x1" }),
  ].map((request): NewEvent => ({ type: "request.opened", request })),
  ...["p-old", "p-new", "p-none", "p-gone"].map((request_id): NewEvent => ({ type: "request.resolved", request_id, resolution: { outcome: "cancel" } })),
]

/** Every window and page the store reads is the contracts' of the whole state. */
const sameAsContracts = (task: TaskId) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore
    const all = yield* whole(task)
    for (let limit = 0; limit <= all.items.length + 1; limit++) {
      assert.deepStrictEqual({ thread: all.thread, ...(yield* store.window(task, limit)) }, snapshotWindow(all, limit), `limit ${limit}`)
    }
    assert.deepStrictEqual({ thread: all.thread, ...(yield* store.window(task, 2.5)) }, snapshotWindow(all, 2.5))
    for (let before = -1; before <= all.items.length + 1; before++) {
      for (let limit = 0; limit <= all.items.length + 1; limit++) {
        assert.deepStrictEqual(yield* store.page(task, before, limit), itemPage(all, before, limit), `before ${before}, limit ${limit}`)
      }
    }
  })

describe("ThreadStore's windows and pages", () => {
  it.effect("are the contracts' of the whole thread, for every limit and place", () =>
    run(
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const task = yield* newTask
        yield* append(task, events)
        const all = yield* whole(task)
        assert.deepStrictEqual(ids(all.items), ["m0", "sa", "m2", "sb", "m4", "b1", "m6", "tc", "m8", "m9"])
        assert.deepStrictEqual(all, applyEvents(initialState(thread(task)), (yield* store.eventsAfter(task, 0)) ?? []))
        yield* sameAsContracts(task)
        // sb is running: a window after it brings it, and sa (and tc, for the open p-sa).
        assert.deepStrictEqual((yield* store.window(task, 1)).context, [1, 3, 7])
        // Ended, and p-sa answered: both subagents' calls still come (the app's Agents list shows every one).
        yield* append(task, [
          { type: "item.updated", item_id: "sb", patch: { status: "completed" } },
          { type: "request.resolved", request_id: "p-sa", resolution: { outcome: "allow" } },
        ])
        yield* sameAsContracts(task)
        assert.deepStrictEqual((yield* store.window(task, 1)).context, [1, 3])
      }),
    ),
  )

  it.effect("go by index where positions have gaps (an imported thread)", () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const task = yield* newTask
        yield* append(task, events)
        yield* sql`UPDATE thread_items SET pos = pos * 3 + 5 WHERE task_id = ${task}`.pipe(Effect.orDie)
        yield* sameAsContracts(task)
      }),
    ),
  )

  it.effect("of a thread with no items are empty", () =>
    run(
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const task = yield* newTask
        assert.deepStrictEqual(yield* store.window(task, 5), { items: [], requests: [], seq: 0 })
        assert.deepStrictEqual(yield* store.page(task, 5, 5), { thread_id: task, items: [], requests: [], start: 0, context: [], seq: 0 })
      }),
    ),
  )

  it.effect("agent-threads' example thread, saved, folds to what the store reads", () =>
    run(
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const path = yield* Path.Path
        const task = yield* newTask
        // Its events of the types the protocol keeps, as the store is given them.
        const lines = yield* readJsonLines(path.join(threadFixturesDir, "examples", "thread.events.jsonl"))
        const decode = Schema.decodeUnknownOption(SavedEvent)
        const given = lines.flatMap((line): ReadonlyArray<NewEvent> =>
          Option.match(decode(line), {
            onNone: () => [],
            onSome: (e) => {
              const { thread_id: _thread, seq: _seq, ...rest } = e
              return [rest]
            },
          }),
        )
        assert.isAbove(given.length, 20)
        const saved = yield* append(task, given)
        const all = yield* whole(task)
        assert.deepStrictEqual(all, applyEvents(initialState(thread(task)), saved))
        assert.deepStrictEqual({ thread: all.thread, ...(yield* store.window(task, 8)) }, snapshotWindow(all, 8))
        assert.deepStrictEqual(yield* store.page(task, 5, 3), itemPage(all, 5, 3))
      }),
    ),
  )
})
