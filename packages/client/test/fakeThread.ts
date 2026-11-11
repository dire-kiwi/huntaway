import { type Cause, Effect, Predicate, Queue, Stream } from "effect"
import { RpcClientError } from "effect/rpc"
import { Socket } from "effect/socket"
import {
  applyEvent,
  type Item,
  initialState,
  itemPage,
  NotFound,
  type SavedEvent,
  type Snapshot,
  snapshotWindow,
  TaskId,
  type ThreadMessage,
} from "@huntaway/contracts"
import type { FakeHost } from "./fakeHost.ts"
import { AT } from "./fixtures.ts"

// A task's thread on the fake host, answering `threads.watch` and `threads.page` as the server's Threads does: a
// window of the whole thread (or, with a `since` it can replay, the events after it), then what is emitted; pages
// from the whole thread.

type NewSaved = SavedEvent extends infer E ? (E extends unknown ? Omit<E, "seq" | "thread_id"> : never) : never

export interface FakeThread {
  readonly id: TaskId
  /** The whole thread as the host has it. */
  state: Snapshot
  /** What each `threads.watch` was asked: its `since`. */
  readonly watches: Array<number | undefined>
  /** What each `threads.page` was asked: its `before`. */
  readonly pages: Array<number>
  /** Numbers an event after the thread's last, applies it and sends it to the open subscription. */
  emit(event: NewSaved): Effect.Effect<void>
  /** Sends a message as it is (a preview, or an event of a newer host's type, whose number it takes). */
  send(message: ThreadMessage): Effect.Effect<void>
  /** The open subscription fails as a dropped socket's does. */
  drop: Effect.Effect<void>
}

export const message = (id: string, text: string): Item => ({ id, type: "assistant_message", text })

const dropped = new RpcClientError.RpcClientError({ reason: new Socket.SocketReadError({ cause: new Error("connection dropped") }) })

const number = (u: unknown, key: string): number | undefined => (Predicate.hasProperty(u, key) && typeof u[key] === "number" ? u[key] : undefined)

/** Serves task `id`'s thread, with `items` in it, on `host`; any other task's is NotFound. */
export const fakeThread = (host: FakeHost, id: string, items: ReadonlyArray<Item> = []): FakeThread => {
  const task = TaskId.make(id)
  const log: Array<SavedEvent> = []
  let open: Queue.Queue<ThreadMessage, RpcClientError.RpcClientError | Cause.Done> | undefined
  const fake: FakeThread = {
    id: task,
    state: { ...initialState({ id: task, harness: "claude", status: "idle", created_at: AT }), items },
    watches: [],
    pages: [],
    emit: (event) =>
      Effect.suspend(() => {
        const saved = { ...event, thread_id: task, seq: fake.state.seq + 1 }
        log.push(saved)
        fake.state = applyEvent(fake.state, saved)
        return open ? Effect.asVoid(Queue.offer(open, saved)) : Effect.void
      }),
    send: (m) =>
      Effect.suspend(() => {
        if (m.type !== "preview" && m.seq > fake.state.seq) fake.state = { ...fake.state, seq: m.seq }
        return open ? Effect.asVoid(Queue.offer(open, m)) : Effect.void
      }),
    drop: Effect.suspend(() => (open ? Effect.asVoid(Queue.fail(open, dropped)) : Effect.void)),
  }
  host.on("threads.watch", (payload) => {
    if (!Predicate.hasProperty(payload, "task_id") || payload.task_id !== task) return Stream.fail(new NotFound({ what: "task", id: String(payload) }))
    const since = number(payload, "since")
    const limit = number(payload, "limit")
    return Stream.unwrap(
      Effect.gen(function* () {
        fake.watches.push(since)
        const queue = yield* Queue.unbounded<ThreadMessage, RpcClientError.RpcClientError | Cause.Done>()
        open = queue
        if (since !== undefined && since <= fake.state.seq)
          yield* Queue.offerAll(
            queue,
            log.filter((e) => e.seq > since),
          )
        else yield* Queue.offer(queue, { type: "snapshot", ...snapshotWindow(fake.state, limit), preview: null })
        return Stream.fromQueue(queue)
      }),
    )
  })
  host.on("threads.page", (payload) =>
    Effect.sync(() => {
      const before = number(payload, "before") ?? 0
      fake.pages.push(before)
      return itemPage(fake.state, before, number(payload, "limit") ?? 100)
    }),
  )
  return fake
}
