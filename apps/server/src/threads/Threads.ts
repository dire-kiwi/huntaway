import { Context, Effect, Layer, Option, PubSub, Ref, Schedule, Schema, Stream } from "effect"
import type { Scope } from "effect"
import { toThreadPermissionMode } from "@huntaway/contracts"
import type {
  Agent,
  Item,
  ItemPage,
  NewEvent,
  Notice,
  Preview,
  RequestResolution,
  SavedEvent,
  Task,
  TaskId,
  Thread,
  ThreadMessage,
  ThreadPreview,
  ThreadRequest,
  ThreadSnapshot,
  Timestamp,
  Todo,
} from "@huntaway/contracts"
import { nowTimestamp } from "../platform/columns.ts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { AgentConfigRepo } from "../profiles/AgentConfigRepo.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { TaskNotFound } from "../tasks/Tasks.ts"
import { legacyId } from "./model.ts"
import type { AgentWrite, Entry, ItemMeta, ItemMetas, WriteNo } from "./model.ts"
import { keepFrom, ThreadStore } from "./ThreadStore.ts"
import type { StoredEvent } from "./ThreadStore.ts"

/** The request is not open: there is none with its id, or it was answered or cancelled first. */
export class RequestNotOpen extends Schema.TaggedError<RequestNotOpen, { readonly brand: unique symbol }>()("RequestNotOpen", {
  task_id: Schema.String,
  request_id: Schema.String,
}) {}

/** Who sent a user message, as the board knows it (`ItemMeta`'s user-message part), and whether it joined a running turn. */
export type UserMessageMeta = Pick<ItemMeta, "auto" | "from_agent" | "user_text" | "start" | "routine" | "review_round"> & {
  /** Sent while a turn was running, so it joined that turn (the item's `steered`). */
  readonly steered?: boolean
}

type Opening<T> = T extends unknown ? Omit<T, "id" | "resolution"> & { readonly id?: string } : never

/**
 * A request to open, without a resolution: its id is the prompt's (`permission_requests.id`), or `legacy:<n>` (its
 * write's) when left out.
 */
export type NewRequest = Opening<ThreadRequest>

/** A thread's stored state, for a translator to rebuild its own from (docs/plan/07-agents.md, The two drivers). */
export interface StoredThread {
  /** Every item in order, with its meta and the write that made it. */
  readonly entries: ReadonlyArray<Entry>
  readonly requests: ReadonlyArray<ThreadRequest>
  readonly seq: number
}

/** What a live watcher is sent: saved events as they commit, and the reply being written. */
type Live = SavedEvent | ThreadPreview

interface Hub {
  readonly pubsub: PubSub.PubSub<Live>
  readonly watchers: number
}

interface Previews {
  /** How many previews this server has started: the `<n>` of the next one's id. */
  readonly started: number
  readonly byTask: ReadonlyMap<TaskId, Preview>
}

export interface ThreadsShape {
  /** A message to the agent, written by the board (the user's, the board's own, another agent's). Its item is `legacy:<n>`. */
  readonly userMessage: (task: TaskId, text: string, meta: UserMessageMeta) => Effect.Effect<WriteNo, TaskNotFound>
  /** Something to tell the user that is not the agent talking. Its item is `legacy:<n>`. */
  readonly notice: (task: TaskId, level: Notice["level"], text: string, detail?: string) => Effect.Effect<WriteNo, TaskNotFound>
  /**
   * 6.5: a routine's report in the assistant's thread: a notice with code `routine_report`, `metadata` the report (its
   * automation, its thread's key, its outcome, the text). Its item is `legacy:<n>`.
   */
  readonly report: (task: TaskId, level: Notice["level"], text: string, metadata: Readonly<Record<string, unknown>>) => Effect.Effect<WriteNo, TaskNotFound>
  /** 6.5: changes an item's fields (`item.updated`: one set to null is removed); nothing if the thread has no such item. */
  readonly updateItem: (task: TaskId, id: string, patch: Readonly<Record<string, unknown>>) => Effect.Effect<void, TaskNotFound>
  /** Opens a request, or opens one with the same id again in place (without its resolution). */
  readonly openRequest: (task: TaskId, request: NewRequest) => Effect.Effect<WriteNo, TaskNotFound>
  /** Answers or cancels an open request. The first answer wins: one that is not open (any more) fails. */
  readonly resolveRequest: (task: TaskId, id: string, resolution: RequestResolution) => Effect.Effect<void, RequestNotOpen | TaskNotFound>
  /** An agent's output, as a driver's translator made it: events whose ids are the agent's own. */
  readonly appendFromAgent: (task: TaskId, events: ReadonlyArray<NewEvent>, metas?: ItemMetas) => Effect.Effect<ReadonlyArray<SavedEvent>, TaskNotFound>
  /**
   * An agent's output that needs a write number (`legacy:<n>:<block>` ids for a Claude message's blocks, a turn's
   * result): `make` is given the next one, taken in the same transaction, and its items and requests get it.
   */
  readonly writeFromAgent: (
    task: TaskId,
    make: (writeNo: WriteNo) => AgentWrite,
  ) => Effect.Effect<{ readonly writeNo: WriteNo; readonly saved: ReadonlyArray<SavedEvent> }, TaskNotFound>
  /**
   * `writeFromAgent` for a run's line handler, in the line's transaction, which has read the run's row (a run goes with
   * its task, so the task is there): no check and no transaction of its own, which it paid on every line.
   */
  readonly writeFromRun: (
    task: TaskId,
    make: (writeNo: WriteNo) => AgentWrite,
  ) => Effect.Effect<{ readonly writeNo: WriteNo; readonly saved: ReadonlyArray<SavedEvent> }>
  /** Streamed text for the reply being written. Never stored; the snapshot carries what has streamed so far. */
  readonly preview: (task: TaskId, text: string) => Effect.Effect<void>
  /** The reply being written ended (or another starts): the next text streams into a new preview. */
  readonly endPreview: (task: TaskId) => Effect.Effect<void>
  /**
   * A snapshot (a window of the last `limit` items, the open requests, `seq` and the reply so far), or with a `since`
   * the day's log reaches, the events after it; then saved events and previews as they happen. It subscribes before it
   * reads, and drops what it has already sent. A task with no thread yet is an empty snapshot.
   */
  readonly watch: (task: TaskId, options: { readonly limit: number; readonly since?: number | undefined }) => Stream.Stream<ThreadMessage, TaskNotFound>
  /** The items before index `before` (a window's `start`), at most `limit` of them, with what they need. */
  readonly page: (task: TaskId, before: number, limit: number) => Effect.Effect<ItemPage, TaskNotFound>
  /**
   * The thread as stored, read in one transaction: the hook a translator rebuilds its state from when it has none for
   * the thread in memory (2.4 keeps that state; docs/plan/07-agents.md, The two drivers).
   */
  readonly stored: (task: TaskId) => Effect.Effect<StoredThread, TaskNotFound>
  /** Removes every thread's events older than the log's day: the hourly sweep. */
  readonly prune: Effect.Effect<number>
  /** How many watch the thread now: its live hub goes with the last of them. */
  readonly watchers: (task: TaskId) => Effect.Effect<number>
}

/** The todo list a card shows (`Task.todos`) after `items`, if one of them changes it; undefined if none does. */
export const todosAfter = (items: ReadonlyArray<Item>): ReadonlyArray<Todo> | undefined => {
  let todos: ReadonlyArray<Todo> | undefined
  for (const item of items) {
    // A Claude call that is still streaming has none of its list yet, which would empty the card meanwhile; a
    // subagent's list is its own.
    if (item.type === "tool_call" && item.kind === "todo" && item.status === "completed" && item.parent_id === undefined) todos = item.todos ?? []
  }
  if (todos === undefined) return undefined
  // A list whose items are all done is none, as Claude Code has it, so a finished task's card does not keep it.
  return todos.every((t) => t.status === "completed") ? [] : todos.map((t) => ({ text: t.text, status: t.status }))
}

const sameTodos = (a: ReadonlyArray<Todo>, b: ReadonlyArray<Todo>) =>
  a.length === b.length && a.every((t, i) => t.text === b[i]?.text && t.status === b[i]?.status)

/**
 * A task's thread (docs/plan/07-agents.md, Threads): the board's writes and an agent's, each one transaction that
 * numbers its events after the thread's last and publishes them after the commit, in order, to the thread's watchers
 * (a `PubSub` per watched thread, made with the first watcher and dropped with the last).
 */
export class Threads extends Context.Service<Threads, ThreadsShape>()("huntaway-server/threads/Threads") {
  static readonly layer = Layer.effect(
    Threads,
    Effect.gen(function* () {
      const db = yield* Db
      const store = yield* ThreadStore
      const tasks = yield* TaskRepo
      const configs = yield* AgentConfigRepo
      const events = yield* Events
      const hubs = yield* Ref.make<ReadonlyMap<TaskId, Hub>>(new Map())
      const previews = yield* Ref.make<Previews>({ started: 0, byTask: new Map() })

      const load = Effect.fnUntraced(function* (id: TaskId) {
        const task = yield* tasks.get(id)
        if (task === null) return yield* new TaskNotFound({ id })
        return task
      })
      /** The task is there (a write to its thread checks no more than that). */
      const check = (id: TaskId) => Effect.flatMap(tasks.exists(id), (found) => (found ? Effect.void : Effect.fail(new TaskNotFound({ id }))))

      // ---- live ----

      const publish = (task: TaskId, messages: ReadonlyArray<Live>) =>
        Effect.flatMap(Ref.get(hubs), (all) => {
          const hub = all.get(task)
          return hub === undefined || messages.length === 0 ? Effect.void : Effect.asVoid(PubSub.publishAll(hub.pubsub, messages))
        })

      /** A subscription to the thread's live messages for the scope: its hub is made with the first and dropped with the last. */
      const subscribe = (task: TaskId): Effect.Effect<PubSub.Subscription<Live>, never, Scope.Scope> =>
        Effect.acquireRelease(
          Effect.flatMap(PubSub.unbounded<Live>(), (fresh) =>
            Ref.modify(hubs, (all) => {
              const hub = all.get(task) ?? { pubsub: fresh, watchers: 0 }
              const next = new Map(all)
              next.set(task, { pubsub: hub.pubsub, watchers: hub.watchers + 1 })
              return [hub.pubsub, next] as const
            }),
          ),
          () =>
            Effect.flatMap(
              Ref.modify(hubs, (all) => {
                const hub = all.get(task)
                if (hub === undefined) return [null, all] as const
                const next = new Map(all)
                if (hub.watchers <= 1) next.delete(task)
                else next.set(task, { pubsub: hub.pubsub, watchers: hub.watchers - 1 })
                return [hub.watchers <= 1 ? hub.pubsub : null, next] as const
              }),
              (gone) => (gone === null ? Effect.void : PubSub.shutdown(gone)),
            ),
        ).pipe(Effect.flatMap((pubsub) => PubSub.subscribe(pubsub)))

      // ---- writing ----

      /**
       * After `saved` is applied, in its transaction: the card's todo list if they change it, and their publication
       * once it commits (an item added to the main conversation ends the reply being previewed).
       */
      const afterAppend = Effect.fnUntraced(function* (task: TaskId, saved: ReadonlyArray<SavedEvent>, at: Timestamp) {
        if (saved.length === 0) return
        const touched: Array<Item> = []
        for (const e of saved) {
          if (e.type === "item.added") touched.push(e.item)
          else if (e.type === "item.updated" && ("todos" in e.patch || "status" in e.patch)) {
            const entry = yield* store.item(task, e.item_id)
            if (entry !== null) touched.push(entry.item)
          }
        }
        const todos = todosAfter(touched)
        if (todos !== undefined) {
          const before = yield* tasks.get(task)
          if (before !== null && !sameTodos(before.todos, todos)) {
            yield* tasks.write(task, { todos }, at)
            const after = yield* tasks.get(task)
            if (after !== null) yield* events.emit({ type: "task", task: after })
          }
        }
        const ends = saved.some((e) => e.type === "item.added" && e.item.parent_id === undefined)
        yield* db.sql.afterCommit(Effect.andThen(ends ? endPreview(task) : Effect.void, publish(task, saved)))
      })

      /** Writes `made` to the thread in the caller's transaction, and what follows from it. */
      const commit = Effect.fnUntraced(function* (task: TaskId, made: AgentWrite, at: Timestamp, writeNo: WriteNo | undefined) {
        const saved = yield* store.append(task, made.events, { at, writeNo, metas: made.metas })
        yield* afterAppend(task, saved, at)
        return saved
      })

      /** A write that takes the next write number, in the caller's transaction: `make` turns it into the events. */
      const numbered = Effect.fnUntraced(function* (task: TaskId, make: (writeNo: WriteNo, at: Timestamp) => AgentWrite) {
        const writeNo = yield* store.nextWriteNo
        const at = yield* nowTimestamp
        const saved = yield* commit(task, make(writeNo, at), at, writeNo)
        return { writeNo, saved }
      })

      /** A numbered write to a task that is there, in one transaction. */
      const numberedWrite = (task: TaskId, make: (writeNo: WriteNo, at: Timestamp) => AgentWrite) => db.tx(Effect.andThen(check(task), numbered(task, make)))

      /** A board write: it returns its write number. */
      const boardWrite = (task: TaskId, make: (writeNo: WriteNo, at: Timestamp) => AgentWrite) => Effect.map(numberedWrite(task, make), (done) => done.writeNo)

      const userMessage = Effect.fn("Threads.userMessage")(function* (task: TaskId, text: string, meta: UserMessageMeta) {
        return yield* boardWrite(task, (n, at) => {
          const id = legacyId(n)
          const item: Item = {
            id,
            type: "user_message",
            text,
            created_at: at,
            ...(meta.steered === true ? { steered: true } : {}),
            ...(meta.auto === true ? { metadata: { auto: true } } : {}),
          }
          const kept: ItemMeta = {
            ...(meta.auto === true ? { auto: true } : {}),
            ...(meta.from_agent === true ? { from_agent: true } : {}),
            ...(meta.user_text === undefined ? {} : { user_text: meta.user_text }),
            ...(meta.start === true ? { start: true } : {}),
            ...(meta.routine === true ? { routine: true } : {}),
            ...(meta.review_round === undefined ? {} : { review_round: meta.review_round }),
          }
          return { events: [{ type: "item.added", item }], metas: Object.keys(kept).length === 0 ? undefined : new Map([[id, kept]]) }
        })
      })

      const notice = Effect.fn("Threads.notice")(function* (task: TaskId, level: Notice["level"], text: string, detail?: string) {
        return yield* boardWrite(task, (n, at) => {
          const item: Item = { id: legacyId(n), type: "notice", level, text, created_at: at, ...(detail === undefined ? {} : { detail }) }
          return { events: [{ type: "item.added", item }] }
        })
      })

      const report = Effect.fn("Threads.report")(function* (task: TaskId, level: Notice["level"], text: string, metadata: Readonly<Record<string, unknown>>) {
        return yield* boardWrite(task, (n, at) => {
          const item: Item = { id: legacyId(n), type: "notice", level, text, code: "routine_report", created_at: at, metadata: { ...metadata } }
          return { events: [{ type: "item.added", item }] }
        })
      })

      const updateItem = Effect.fn("Threads.updateItem")(function* (task: TaskId, id: string, patch: Readonly<Record<string, unknown>>) {
        yield* db.tx(
          Effect.gen(function* () {
            yield* check(task)
            if ((yield* store.item(task, id)) === null) return
            yield* commit(task, { events: [{ type: "item.updated", item_id: id, patch: { ...patch } }] }, yield* nowTimestamp, undefined)
          }),
        )
      })

      const openRequest = Effect.fn("Threads.openRequest")(function* (task: TaskId, request: NewRequest) {
        return yield* boardWrite(task, (n, at) => {
          const opened: ThreadRequest = { ...request, id: request.id ?? legacyId(n), created_at: request.created_at ?? at }
          return { events: [{ type: "request.opened", request: opened }] }
        })
      })

      const resolveRequest = Effect.fn("Threads.resolveRequest")(function* (task: TaskId, id: string, resolution: RequestResolution) {
        yield* db.tx(
          Effect.gen(function* () {
            yield* check(task)
            // The compare and set: in the transaction, so of two answers the first one wins.
            const found = yield* store.request(task, id)
            if (found === null || found.request.resolution !== undefined) return yield* new RequestNotOpen({ task_id: task, request_id: id })
            const at = yield* nowTimestamp
            return yield* commit(task, { events: [{ type: "request.resolved", request_id: id, resolution }] }, at, undefined)
          }),
        )
      })

      const appendFromAgent = Effect.fnUntraced(function* (task: TaskId, added: ReadonlyArray<NewEvent>, metas?: ItemMetas) {
        return yield* db.tx(
          Effect.gen(function* () {
            yield* check(task)
            const at = yield* nowTimestamp
            return yield* commit(task, { events: added, metas }, at, undefined)
          }),
        )
      })

      const writeFromAgent = Effect.fnUntraced(function* (task: TaskId, make: (writeNo: WriteNo) => AgentWrite) {
        return yield* numberedWrite(task, (writeNo) => make(writeNo))
      })
      const writeFromRun = (task: TaskId, make: (writeNo: WriteNo) => AgentWrite) => numbered(task, (writeNo) => make(writeNo))

      // ---- the reply being written ----

      const preview = Effect.fnUntraced(function* (task: TaskId, text: string) {
        if (text === "") return
        const { id, offset } = yield* Ref.modify(previews, (state) => {
          const current = state.byTask.get(task)
          const started = current === undefined ? state.started + 1 : state.started
          const item_id = current?.item_id ?? `stream:${events.boot}:${started}`
          const had = current?.text ?? ""
          const byTask = new Map(state.byTask)
          byTask.set(task, { item_id, text: had + text })
          return [
            { id: item_id, offset: had.length },
            { started, byTask },
          ] as const
        })
        const seq = yield* store.seq(task)
        yield* publish(task, [{ type: "preview", thread_id: task, seq, item_id: id, offset, text }])
      })

      const endPreview = (task: TaskId) =>
        Ref.update(previews, (state) => {
          if (!state.byTask.has(task)) return state
          const byTask = new Map(state.byTask)
          byTask.delete(task)
          return { started: state.started, byTask }
        })

      // ---- reading ----

      /** The agent a config runs; none for no config, or one that is gone. */
      const agent = (id: Task["claude_config_id"]) =>
        id === null
          ? Effect.succeed(Option.none<Agent>())
          : Effect.map(
              configs.get(id),
              Option.map((c) => c.agent),
            )

      /** The agent the task's thread runs (the old `task_is_codex`): its config's, else its project's or profile's first. */
      const agentOf = Effect.fnUntraced(function* (task: Task) {
        if (task.claude_config_id !== null) {
          const own = yield* agent(task.claude_config_id)
          if (Option.isSome(own)) return own.value
        } else if (task.session_id !== null) {
          // A thread is given a config when it starts, so one with a session and none started in Claude's default.
          return "claude"
        }
        const project = task.project_id === null ? null : yield* tasks.project(task.project_id)
        const [first] = yield* tasks.configs(task.profile_id, project)
        return Option.getOrElse(yield* agent(first ?? null), (): Agent => "claude")
      })

      /** The thread's own state, which is its task's: none of it is kept with the items. */
      const threadOf = Effect.fnUntraced(function* (task: Task, openRequests: number) {
        const thread: Thread = {
          id: task.id,
          harness: yield* agentOf(task),
          status: !task.running ? "idle" : openRequests > 0 ? "waiting" : "running",
          title: task.title,
          created_at: task.created_at,
          updated_at: task.updated_at,
          ...(task.model === null ? {} : { model: task.model }),
          ...(task.effort === null ? {} : { effort: task.effort }),
          ...(task.permission_mode === null ? {} : { permission_mode: toThreadPermissionMode(task.permission_mode) }),
          ...(task.worktree_path === null ? {} : { cwd: task.worktree_path }),
          ...(task.session_id === null ? {} : { session_id: task.session_id }),
        }
        return thread
      })

      /** What a watcher is sent first, read in one transaction, and the seq the live messages go on from. */
      const head = Effect.fnUntraced(function* (id: TaskId, limit: number, since: number | undefined) {
        return yield* db.tx(
          Effect.gen(function* () {
            const task = yield* load(id)
            if (since !== undefined) {
              const seq = yield* store.seq(id)
              const replay = since <= seq ? yield* store.eventsAfter(id, since) : null
              if (replay !== null) return { first: replay, seq }
            }
            const state = yield* store.window(id, limit)
            const thread = yield* threadOf(task, state.requests.filter((r) => r.resolution === undefined).length)
            const streamed = (yield* Ref.get(previews)).byTask.get(id) ?? null
            const snapshot: ThreadSnapshot = { type: "snapshot", thread, ...state, preview: streamed }
            const first: ReadonlyArray<ThreadSnapshot | StoredEvent> = [snapshot]
            return { first, seq: state.seq }
          }),
        )
      })

      const watch = (task: TaskId, options: { readonly limit: number; readonly since?: number | undefined }): Stream.Stream<ThreadMessage, TaskNotFound> =>
        Stream.unwrap(
          Effect.gen(function* () {
            // Subscribed before the read: what commits after it comes live, and what the read has already is dropped.
            const subscription = yield* subscribe(task)
            const start = yield* head(task, options.limit, options.since)
            const live = Stream.fromSubscription(subscription).pipe(
              Stream.mapAccum(
                () => start.seq,
                (seq, message): readonly [number, ReadonlyArray<ThreadMessage>] => {
                  if (message.type === "preview") return [seq, [message]]
                  return message.seq <= seq ? [seq, []] : [message.seq, [message]]
                },
              ),
            )
            return Stream.concat(Stream.fromIterable(start.first), live)
          }),
        )

      const page = Effect.fn("Threads.page")(function* (task: TaskId, before: number, limit: number) {
        return yield* db.tx(Effect.andThen(check(task), store.page(task, before, limit)))
      })

      const stored = Effect.fn("Threads.stored")(function* (task: TaskId) {
        return yield* db.tx(
          Effect.gen(function* () {
            yield* check(task)
            const result: StoredThread = { entries: yield* store.entries(task), requests: yield* store.requests(task), seq: yield* store.seq(task) }
            return result
          }),
        )
      })

      const prune = Effect.gen(function* () {
        const now = yield* nowTimestamp
        return yield* store.prune(keepFrom(now))
      }).pipe(Effect.withSpan("Threads.prune"))

      return Threads.of({
        userMessage,
        notice,
        // 6.5
        report,
        updateItem,
        openRequest,
        resolveRequest,
        appendFromAgent,
        writeFromAgent,
        writeFromRun,
        preview,
        endPreview,
        watch,
        page,
        stored,
        prune,
        watchers: (task) => Effect.map(Ref.get(hubs), (all) => all.get(task)?.watchers ?? 0),
      })
    }),
  )

  /** Every thread's log pruned to its last day: now, then every hour, for as long as the server runs. */
  static readonly pruner = Layer.effectDiscard(
    Effect.gen(function* () {
      const threads = yield* Threads
      yield* threads.prune.pipe(Effect.repeat(Schedule.spaced("1 hour")), Effect.forkScoped)
    }),
  )
}
