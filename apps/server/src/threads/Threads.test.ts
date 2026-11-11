import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Result, Schema, Stream } from "effect"
import type { Scope } from "effect"
import { TestClock } from "effect/testing"
import { SqlClient } from "effect/sql"
import { ItemAdded, ProfileId, TaskId, ThreadPreview, ThreadSnapshot, Timestamp } from "@huntaway/contracts"
import type { BoardEvent, NewEvent, ThreadMessage, ToolCall } from "@huntaway/contracts"
import { TestBoard } from "@huntaway/testing"
import { Actor } from "../platform/Changes.ts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { WriteNo } from "./model.ts"
import { ThreadStore } from "./ThreadStore.ts"
import { Threads } from "./Threads.ts"

// Threads on the whole board's services: the board's writes (the old write.test.ts, for what a write is now: items
// written directly, with write numbers), the thread's state from its task, `watch` and `page` (the old live.test.ts),
// the preview, first-answer-wins, the card's todo list, pruning on the test clock. Dropped from the old write and live
// cases: the `thread_items` setting and flag, rebuilds and `compare`, translator caching and failure (no translator
// here; 2.4), the legacy `message` events, the HTTP routes and the hub's path (RPC now), and the commands (the
// handlers they go to come with 2.5 and 3.3).

const AT = Timestamp.make("2026-11-12T00:00:00.000Z")
/** The test clock's start, when every write here happens. */
const EPOCH = Timestamp.make("1970-01-01T00:00:00.000Z")

// A message's `type` does not narrow it (an event of a newer host's type is a message too): its schema does.
const isSnapshot = Schema.is(ThreadSnapshot)
const isAdded = Schema.is(ItemAdded)
const isPreview = Schema.is(ThreadPreview)

const newTask = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const tasks = yield* Tasks
  yield* sql`INSERT OR IGNORE INTO profiles (id, name, created_at) VALUES ('p', 'p', ${AT})`.pipe(Effect.orDie)
  return (yield* tasks.create({ profile_id: ProfileId.make("p"), title: "t" }, Actor.user)).id
}).pipe(Effect.orDie)

interface WatchOptions {
  readonly limit?: number
  readonly since?: number
}

/**
 * The first `n` messages of a watch, read by a fiber that has subscribed by the time this returns (it starts at once
 * and runs until it waits for the database), but may not have read its window yet.
 */
const subscribed = (task: TaskId, n: number, options: WatchOptions = {}) =>
  Effect.gen(function* () {
    const threads = yield* Threads
    return yield* threads
      .watch(task, { limit: options.limit ?? 50, since: options.since })
      .pipe(Stream.take(n), Stream.runCollect, Effect.forkChild({ startImmediately: true }))
  })

/** The first `n` messages of a watch, read by a fiber that has its first message by the time this returns. */
const watching = (task: TaskId, n: number, options: WatchOptions = {}) =>
  Effect.gen(function* () {
    const threads = yield* Threads
    const first = yield* Deferred.make<void>()
    const fiber = yield* threads.watch(task, { limit: options.limit ?? 50, since: options.since }).pipe(
      Stream.tap(() => Deferred.succeed(first, undefined)),
      Stream.take(n),
      Stream.runCollect,
      Effect.forkChild({ startImmediately: true }),
    )
    yield* Deferred.await(first)
    return fiber
  })

/** A message, shortly. */
const brief = (m: ThreadMessage): string => {
  if (isSnapshot(m)) return `snapshot ${m.seq} [${m.items.map((i) => i.id).join(" ")}]${m.preview === null ? "" : ` preview ${m.preview.text}`}`
  if (isAdded(m)) return `${m.seq} added ${m.item.id}`
  if (isPreview(m)) return `preview ${m.offset} ${m.text}`
  return `${m.seq} ${m.type}`
}

const run = <A, E>(effect: Effect.Effect<A, E, Threads | ThreadStore | Tasks | TaskRepo | Events | Db | SqlClient.SqlClient | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(TestBoard()))

describe("Threads' board writes", () => {
  it.effect("take the next write number, and make items and requests named by it", () =>
    run(
      Effect.gen(function* () {
        const threads = yield* Threads
        const store = yield* ThreadStore
        const task = yield* newTask
        const other = yield* newTask
        const first = yield* threads.userMessage(task, "Fix it", { auto: true, start: true })
        const second = yield* threads.notice(other, "warning", "Worktree ready", "on branch x")
        const third = yield* threads.userMessage(task, "And this", { from_agent: true, user_text: "this", steered: true })
        const asked = yield* threads.openRequest(task, { type: "question", questions: [{ id: "q", question: "Which?" }] })
        const prompt = yield* threads.openRequest(task, { id: "perm-1", type: "permission", name: "Bash", kind: "shell", input: { command: "ls" } })
        // Board-wide, in order.
        assert.deepStrictEqual([first, second, third, asked, prompt], [1, 2, 3, 4, 5])
        const entries = yield* store.entries(task)
        assert.deepStrictEqual(
          entries.map((e) => ({ item: e.item, meta: e.meta, write_no: e.write_no })),
          [
            {
              item: { id: "legacy:1", type: "user_message", text: "Fix it", created_at: EPOCH, metadata: { auto: true } },
              meta: { auto: true, start: true },
              write_no: WriteNo.make(1),
            },
            {
              item: { id: "legacy:3", type: "user_message", text: "And this", created_at: EPOCH, steered: true },
              meta: { from_agent: true, user_text: "this" },
              write_no: WriteNo.make(3),
            },
          ],
        )
        assert.deepStrictEqual((yield* store.item(other, "legacy:2"))?.item, {
          id: "legacy:2",
          type: "notice",
          level: "warning",
          text: "Worktree ready",
          created_at: EPOCH,
          detail: "on branch x",
        })
        assert.deepStrictEqual(
          (yield* store.requests(task)).map((r) => r.id),
          ["legacy:4", "perm-1"],
        )
        assert.strictEqual((yield* store.request(task, "perm-1"))?.write_no, 5)
      }),
    ),
  )

  it.effect("fail with TaskNotFound for a task that isn't there, and write nothing", () =>
    run(
      Effect.gen(function* () {
        const threads = yield* Threads
        const store = yield* ThreadStore
        const gone = TaskId.make("gone")
        const errors = yield* Effect.all(
          [
            Effect.flip(threads.userMessage(gone, "hi", {})),
            Effect.flip(threads.notice(gone, "info", "x")),
            Effect.flip(threads.appendFromAgent(gone, [])),
            Effect.flip(threads.page(gone, 0, 10)),
            Effect.flip(Stream.runCollect(threads.watch(gone, { limit: 10 }))),
          ],
          { concurrency: 1 },
        )
        assert.deepStrictEqual(
          errors.map((e) => e._tag),
          ["TaskNotFound", "TaskNotFound", "TaskNotFound", "TaskNotFound", "TaskNotFound"],
        )
        assert.strictEqual(yield* store.seq(gone), 0)
      }),
    ),
  )

  it.effect("rolled back with the caller's transaction, publish nothing and leave no gap", () =>
    run(
      Effect.gen(function* () {
        const threads = yield* Threads
        const db = yield* Db
        const task = yield* newTask
        const watcher = yield* watching(task, 2)
        yield* db.tx(Effect.andThen(threads.notice(task, "info", "lost"), Effect.fail("the rest failed"))).pipe(Effect.ignore)
        yield* threads.notice(task, "info", "kept")
        // Its write number went with it too.
        assert.deepStrictEqual((yield* Fiber.join(watcher)).map(brief), ["snapshot 0 []", "1 added legacy:1"])
      }),
    ),
  )
})

/** A todo call of the agent's (or a subagent's), running. */
const todo = (id: string, list: ToolCall["todos"], parent_id?: string): ToolCall => ({
  id,
  type: "tool_call",
  name: "TodoWrite",
  kind: "todo",
  input: {},
  status: "running",
  todos: list ?? [],
  ...(parent_id === undefined ? {} : { parent_id }),
})

describe("Threads' agent writes", () => {
  const call: ToolCall = { id: "toolu_1", type: "tool_call", name: "Bash", kind: "shell", input: { command: "ls" }, status: "running" }

  it.effect("save the agent's events as given, with their metas", () =>
    run(
      Effect.gen(function* () {
        const threads = yield* Threads
        const store = yield* ThreadStore
        const task = yield* newTask
        const saved = yield* threads.appendFromAgent(task, [{ type: "item.added", item: call }], new Map([["toolu_1", { session: "S" }]]))
        assert.deepStrictEqual(
          saved.map((e) => [e.seq, e.type]),
          [[1, "item.added"]],
        )
        const entry = yield* store.item(task, "toolu_1")
        assert.deepStrictEqual([entry?.meta, entry?.write_no], [{ session: "S" }, null])
      }),
    ),
  )

  it.effect("that need a write number take one in the same transaction", () =>
    run(
      Effect.gen(function* () {
        const threads = yield* Threads
        const store = yield* ThreadStore
        const task = yield* newTask
        yield* threads.notice(task, "info", "first")
        const { writeNo, saved } = yield* threads.writeFromAgent(task, (n) => ({
          events: [0, 1].map((block): NewEvent => ({ type: "item.added", item: { id: `legacy:${n}:${block}`, type: "assistant_message", text: `${block}` } })),
        }))
        assert.strictEqual(writeNo, 2)
        assert.deepStrictEqual(
          saved.map((e) => (e.type === "item.added" ? e.item.id : "")),
          ["legacy:2:0", "legacy:2:1"],
        )
        assert.deepStrictEqual(
          (yield* threads.stored(task)).entries.map((e) => `${e.item.id} ${e.write_no}`),
          ["legacy:1 1", "legacy:2:0 2", "legacy:2:1 2"],
        )
        assert.strictEqual((yield* store.item(task, "legacy:2:1"))?.pos, 2)
      }),
    ),
  )

  it.effect("keep the agent's todo list on its task once its call is done, and not a subagent's", () =>
    run(
      Effect.gen(function* () {
        const threads = yield* Threads
        const tasks = yield* TaskRepo
        const events = yield* Events
        const task = yield* newTask
        const todos = Effect.map(tasks.get(task), (t) => t?.todos)
        const write = (id: string, list: ToolCall["todos"], parent_id?: string) =>
          threads.appendFromAgent(task, [{ type: "item.added", item: todo(id, list, parent_id) }])
        const done = (id: string) => threads.appendFromAgent(task, [{ type: "item.updated", item_id: id, patch: { status: "completed" } }])
        const list: ToolCall["todos"] = [
          { text: "Read it", status: "completed" },
          { text: "Fix it", status: "in_progress" },
          { text: "Test it", status: "pending" },
        ]
        // The task's changes as clients get them: the first three after now.
        const watch = yield* events.watch(undefined)
        const sent = yield* watch.live.pipe(
          Stream.filter((e: BoardEvent) => e.type === "task" && e.task.id === task),
          Stream.take(3),
          Stream.runCollect,
          Effect.forkScoped,
        )
        yield* write("todo1", list)
        // Not until it's done.
        assert.deepStrictEqual(yield* todos, [])
        yield* done("todo1")
        assert.deepStrictEqual(yield* todos, list)
        // A subagent's list is its own.
        yield* write("todo2", [{ text: "Theirs", status: "pending" }], "agent1")
        yield* done("todo2")
        assert.deepStrictEqual(yield* todos, list)
        // The next replaces it, and the same list again isn't written again.
        yield* write("todo3", [{ text: "Fix it", status: "in_progress" }])
        yield* done("todo3")
        assert.deepStrictEqual(yield* todos, [{ text: "Fix it", status: "in_progress" }])
        yield* write("todo4", [{ text: "Fix it", status: "in_progress" }])
        yield* done("todo4")
        // Once all of it is done, there is none, as Claude Code has it.
        yield* threads.appendFromAgent(task, [
          { type: "item.added", item: { ...todo("todo5", [{ text: "Fix it", status: "completed" }]), status: "completed" } },
        ])
        assert.deepStrictEqual(yield* todos, [])
        // Each change went to clients as the task, and the same list again was not one.
        const lengths = (yield* Fiber.join(sent)).map((e) => (e.type === "task" ? e.task.todos.length : -1))
        assert.deepStrictEqual(lengths, [3, 1, 0])
      }),
    ),
  )
})

describe("Threads.watch", () => {
  it.effect("a task with no thread yet is an empty snapshot; then its events as they commit", () =>
    run(
      Effect.gen(function* () {
        const threads = yield* Threads
        const task = yield* newTask
        const watcher = yield* watching(task, 3)
        yield* threads.notice(task, "info", "one")
        yield* threads.userMessage(task, "two", {})
        const got = yield* Fiber.join(watcher)
        assert.deepStrictEqual(got.map(brief), ["snapshot 0 []", "1 added legacy:1", "2 added legacy:2"])
        const [snapshot] = got
        assert.deepStrictEqual(
          isSnapshot(snapshot) ? [snapshot.thread.id, snapshot.thread.harness, snapshot.thread.status, snapshot.thread.title, snapshot.preview] : [],
          [task, "claude", "idle", "t", null],
        )
      }),
    ),
  )

  it.effect("a write between subscribing and reading the window is neither lost nor doubled", () =>
    run(
      Effect.gen(function* () {
        const threads = yield* Threads
        const db = yield* Db
        const task = yield* newTask
        // A write that holds the database (its transaction) until told to commit.
        const inside = yield* Deferred.make<void>()
        const commit = yield* Deferred.make<void>()
        const writer = yield* db
          .tx(
            Effect.gen(function* () {
              yield* threads.notice(task, "info", "between")
              yield* Deferred.succeed(inside, undefined)
              yield* Deferred.await(commit)
            }),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(inside)
        // The watcher subscribes, then waits for the database to read its window.
        const watcher = yield* subscribed(task, 2)
        assert.strictEqual(yield* threads.watchers(task), 1)
        yield* Deferred.succeed(commit, undefined)
        yield* Fiber.join(writer)
        yield* threads.notice(task, "info", "after")
        // The write before the read is in the window, and not sent again; the one after it is sent.
        assert.deepStrictEqual((yield* Fiber.join(watcher)).map(brief), ["snapshot 1 [legacy:1]", "2 added legacy:2"])
      }),
    ),
  )

  it.effect("with a since the log reaches, the events after it; otherwise a snapshot", () =>
    run(
      Effect.gen(function* () {
        const threads = yield* Threads
        const task = yield* newTask
        for (const text of ["a", "b", "c"]) yield* threads.notice(task, "info", text)
        const replay = yield* watching(task, 3, { since: 1 })
        yield* threads.notice(task, "info", "d")
        assert.deepStrictEqual((yield* Fiber.join(replay)).map(brief), ["2 added legacy:2", "3 added legacy:3", "4 added legacy:4"])
        // Up to date: nothing but what comes.
        const current = yield* subscribed(task, 1, { since: 4 })
        yield* threads.notice(task, "info", "e")
        assert.deepStrictEqual((yield* Fiber.join(current)).map(brief), ["5 added legacy:5"])
        // Ahead of the thread (another boot's, say): a snapshot.
        const ahead = yield* watching(task, 1, { since: 99, limit: 2 })
        assert.deepStrictEqual((yield* Fiber.join(ahead)).map(brief), ["snapshot 5 [legacy:4 legacy:5]"])
      }),
    ),
  )

  it.effect("past the day the log keeps, a snapshot (pruned on the test clock)", () =>
    run(
      Effect.gen(function* () {
        const threads = yield* Threads
        const store = yield* ThreadStore
        const task = yield* newTask
        yield* threads.notice(task, "info", "old")
        yield* TestClock.adjust("25 hours")
        yield* threads.notice(task, "info", "new")
        assert.isNull(yield* store.eventsAfter(task, 0))
        assert.strictEqual((yield* store.eventsAfter(task, 1))?.length, 1)
        const behind = yield* watching(task, 1, { since: 0 })
        assert.deepStrictEqual((yield* Fiber.join(behind)).map(brief), ["snapshot 2 [legacy:1 legacy:2]"])
        const kept = yield* watching(task, 1, { since: 1 })
        assert.deepStrictEqual((yield* Fiber.join(kept)).map(brief), ["2 added legacy:2"])
        // The hourly sweep prunes a thread nobody writes to.
        yield* TestClock.adjust("25 hours")
        assert.isNull(yield* store.eventsAfter(task, 1))
        assert.strictEqual(yield* store.seq(task), 2)
      }),
    ),
  )

  it.effect("the thread's own state is its task's", () =>
    run(
      Effect.gen(function* () {
        const threads = yield* Threads
        const tasks = yield* TaskRepo
        const task = yield* newTask
        const state = Effect.gen(function* () {
          const [first] = yield* Stream.runCollect(Stream.take(threads.watch(task, { limit: 10 }), 1))
          return isSnapshot(first) ? first.thread : null
        })
        yield* tasks.write(task, { model: "sonnet", permission_mode: "acceptEdits", session_id: "sess_9", worktree_path: "/w" }, AT)
        const idle = yield* state
        assert.deepStrictEqual(
          [idle?.status, idle?.model, idle?.permission_mode, idle?.session_id, idle?.cwd, idle?.title],
          ["idle", "sonnet", "accept_edits", "sess_9", "/w", "t"],
        )
        // Running, and waiting on a request.
        yield* tasks.write(task, { running: true }, AT)
        assert.strictEqual((yield* state)?.status, "running")
        yield* threads.openRequest(task, { id: "p9", type: "permission", name: "Bash", kind: "shell", input: {} })
        assert.strictEqual((yield* state)?.status, "waiting")
        yield* threads.resolveRequest(task, "p9", { outcome: "allow" })
        assert.strictEqual((yield* state)?.status, "running")
      }),
    ),
  )

  it.effect("the snapshot carries the reply being written, and a saved reply ends it", () =>
    run(
      Effect.gen(function* () {
        const threads = yield* Threads
        const task = yield* newTask
        yield* threads.userMessage(task, "go", {})
        const live = yield* watching(task, 3)
        yield* threads.preview(task, "Hel")
        // Opened mid-reply: the reply so far.
        const late = yield* watching(task, 2)
        yield* threads.preview(task, "lo")
        const first = yield* Fiber.join(live)
        assert.deepStrictEqual(first.map(brief), ["snapshot 1 [legacy:1]", "preview 0 Hel", "preview 3 lo"])
        assert.deepStrictEqual((yield* Fiber.join(late)).map(brief), ["snapshot 1 [legacy:1] preview Hel", "preview 3 lo"])
        const ids = first.flatMap((m) => (isPreview(m) ? [m.item_id] : []))
        assert.match(ids[0] ?? "", /^stream:/)
        assert.strictEqual(ids[0], ids[1])
        // Saved (an item in the main conversation), the next text is another reply.
        yield* threads.appendFromAgent(task, [{ type: "item.added", item: { id: "a1", type: "assistant_message", text: "Hello" } }])
        const after = yield* watching(task, 2)
        yield* threads.preview(task, "Next")
        const next = yield* Fiber.join(after)
        assert.deepStrictEqual(next.map(brief), ["snapshot 2 [legacy:1 a1]", "preview 0 Next"])
        assert.notStrictEqual(isPreview(next[1]) ? next[1].item_id : null, ids[0])
        // As does ending it.
        yield* threads.endPreview(task)
        const ended = yield* watching(task, 1)
        assert.deepStrictEqual((yield* Fiber.join(ended)).map(brief), ["snapshot 2 [legacy:1 a1]"])
      }),
    ),
  )

  it.effect("a thread's hub is made with its first watcher and goes with its last", () =>
    run(
      Effect.gen(function* () {
        const threads = yield* Threads
        const task = yield* newTask
        const one = yield* watching(task, 99)
        const two = yield* watching(task, 99)
        assert.strictEqual(yield* threads.watchers(task), 2)
        yield* Fiber.interrupt(one)
        assert.strictEqual(yield* threads.watchers(task), 1)
        yield* Fiber.interrupt(two)
        assert.strictEqual(yield* threads.watchers(task), 0)
        // Writes with nobody watching go nowhere.
        yield* threads.notice(task, "info", "unwatched")
      }),
    ),
  )

  it.effect("pages before a window's start", () =>
    run(
      Effect.gen(function* () {
        const threads = yield* Threads
        const task = yield* newTask
        for (const text of ["a", "b", "c", "d", "e"]) yield* threads.notice(task, "info", text)
        const window = yield* watching(task, 1, { limit: 2 })
        const [snapshot] = yield* Fiber.join(window)
        assert.strictEqual(isSnapshot(snapshot) ? snapshot.start : null, 3)
        const page = yield* threads.page(task, 3, 2)
        assert.deepStrictEqual([page.start, page.items.map((i) => i.id), page.seq], [1, ["legacy:2", "legacy:3"], 5])
      }),
    ),
  )
})

describe("Threads.resolveRequest", () => {
  it.effect("is first-answer-wins: of two at once, one answers and the other finds it not open", () =>
    run(
      Effect.gen(function* () {
        const threads = yield* Threads
        const store = yield* ThreadStore
        const task = yield* newTask
        yield* threads.openRequest(task, { id: "p1", type: "permission", name: "Bash", kind: "shell", input: {} })
        const [a, b] = yield* Effect.all(
          [
            Effect.result(threads.resolveRequest(task, "p1", { outcome: "allow" })),
            Effect.result(threads.resolveRequest(task, "p1", { outcome: "deny", message: "no" })),
          ],
          { concurrency: 2 },
        )
        assert.deepStrictEqual([a, b].filter(Result.isSuccess).length, 1)
        const winner = Result.isSuccess(a) ? "allow" : "deny"
        assert.strictEqual((yield* store.request(task, "p1"))?.request.resolution?.outcome, winner)
        const loser = Result.isFailure(a) ? a : b
        assert.strictEqual(Result.isFailure(loser) ? loser.failure._tag : null, "RequestNotOpen")
        // One resolution event, then nothing.
        assert.deepStrictEqual(
          ((yield* store.eventsAfter(task, 0)) ?? []).map((e) => e.type),
          ["request.opened", "request.resolved"],
        )
        // Opened again (its answer could not be sent), it can be answered again.
        yield* threads.openRequest(task, { id: "p1", type: "permission", name: "Bash", kind: "shell", input: {} })
        yield* threads.resolveRequest(task, "p1", { outcome: "cancel" })
        const missing = yield* Effect.flip(threads.resolveRequest(task, "nope", { outcome: "cancel" }))
        assert.deepStrictEqual([missing._tag, missing._tag === "RequestNotOpen" ? missing.request_id : ""], ["RequestNotOpen", "nope"])
      }),
    ),
  )
})
