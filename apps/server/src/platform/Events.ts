import { Context, Effect, Layer, Queue, Ref, Semaphore, Stream } from "effect"
import type { Cause, Scope } from "effect"
import { SecureRandom } from "effect/crypto"
import { SqlClient } from "effect/sql"
import type { BoardEvent, BoardEventInput } from "@huntaway/contracts"

/**
 * How many events are kept in memory for a subscriber that resumes, not counting those a later one replaces
 * (`replacedBy`).
 */
export const TAIL = 5000
/** How many events a subscriber may fall behind before it is cut off with `resync`. */
export const BACKLOG = 10_000

export interface Since {
  readonly boot: string
  readonly seq: number
}

export interface Watch {
  /** The sequence number the stream continues from. */
  readonly seq: number
  /** With a `since` this boot's tail still covers: the events after it. Otherwise null, and a snapshot is due. */
  readonly replay: ReadonlyArray<BoardEvent> | null
  /** Every event after `seq`, ending with `resync` if this subscriber falls `BACKLOG` behind. */
  readonly live: Stream.Stream<BoardEvent>
}

export interface EventsShape {
  /** This server process's boot id: a `since` from another boot cannot be replayed. */
  readonly boot: string
  /**
   * Publish an event. Inside `Db.tx` it is published after the commit, in commit order, and not at all on a rollback;
   * outside a transaction, at once. This is the only way anything reaches a client.
   */
  readonly emit: (event: BoardEventInput) => Effect.Effect<void>
  /** The last number given. */
  readonly seq: Effect.Effect<number>
  /** Subscribe; the subscription lasts as long as the scope. */
  readonly watch: (since: Since | undefined) => Effect.Effect<Watch, never, Scope.Scope>
}

/**
 * What an event says all of, so a later event with the same key replaces it in a replay: a task's whole row (or its
 * deletion), an agent config's whole usage. Each `task` event holds a whole task, and a running agent's task changes
 * many times a minute, so without this the tail was mostly old copies of the same few tasks (HE-104).
 */
export const replacedBy = (event: BoardEvent): string | null =>
  event.type === "task"
    ? `task ${event.task.id}`
    : event.type === "task_deleted"
      ? `task ${event.id}`
      : event.type === "usage"
        ? `usage ${event.usage.config_id}`
        : null

/**
 * The events kept for a subscriber that resumes, by number, oldest first (a `Map` keeps insertion order). One a later
 * event replaces is deleted at once, so it holds at most `TAIL` events. Only touched holding the bus's lock.
 */
export interface Tail {
  readonly events: Map<number, BoardEvent>
  /** The number of the latest event of each `replacedBy` key. */
  readonly latest: Map<string, number>
  /** The number of the newest event dropped for room (not replaced): a `since` below it can't be replayed. */
  floor: number
}

/** Adds `event` to `tail`, deleting an earlier one with its key, and drops the oldest past `TAIL`. */
export const keep = (tail: Tail, event: BoardEvent) => {
  const key = replacedBy(event)
  if (key !== null) {
    const before = tail.latest.get(key)
    if (before !== undefined) tail.events.delete(before)
    tail.latest.set(key, event.seq)
  }
  tail.events.set(event.seq, event)
  while (tail.events.size > TAIL) {
    const first = tail.events.entries().next()
    if (first.done === true) break
    const [seq, oldest] = first.value
    tail.events.delete(seq)
    tail.floor = seq
    const oldestKey = replacedBy(oldest)
    if (oldestKey !== null && tail.latest.get(oldestKey) === seq) tail.latest.delete(oldestKey)
  }
}

interface Subscriber {
  readonly queue: Queue.Queue<BoardEvent, Cause.Done>
}

/** The board's event bus: numbers each event, keeps a tail for replay, and publishes to every subscriber. */
export class Events extends Context.Service<Events, EventsShape>()("huntaway-server/platform/Events") {
  static readonly layer = Layer.effect(
    Events,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const random = yield* SecureRandom.SecureRandom
      const boot = yield* random.uuidV4()
      const lock = yield* Semaphore.make(1)
      const state = yield* Ref.make<{ readonly seq: number; readonly subscribers: ReadonlySet<Subscriber> }>({ seq: 0, subscribers: new Set() })
      const tail: Tail = { events: new Map(), latest: new Map(), floor: 0 }

      const publish = (input: BoardEventInput) =>
        Semaphore.withPermits(
          lock,
          1,
        )(
          Effect.gen(function* () {
            const before = yield* Ref.get(state)
            const event: BoardEvent = { ...input, seq: before.seq + 1 }
            const dropped: Array<Subscriber> = []
            for (const subscriber of before.subscribers) {
              if (!Queue.offerUnsafe(subscriber.queue, event)) dropped.push(subscriber)
            }
            for (const subscriber of dropped) Queue.endUnsafe(subscriber.queue)
            keep(tail, event)
            const subscribers = dropped.length === 0 ? before.subscribers : new Set([...before.subscribers].filter((s) => !dropped.includes(s)))
            yield* Ref.set(state, { seq: event.seq, subscribers })
          }),
        )

      const emit = (event: BoardEventInput) => sql.afterCommit(publish(event))

      const watch = Effect.fnUntraced(function* (since: Since | undefined) {
        const queue = yield* Queue.bounded<BoardEvent, Cause.Done>(BACKLOG)
        const subscriber: Subscriber = { queue }
        const taken = yield* Semaphore.withPermits(
          lock,
          1,
        )(
          Ref.modify(state, (s) => {
            const covered = since !== undefined && since.boot === boot && since.seq <= s.seq && since.seq >= tail.floor
            const replay = covered ? [...tail.events.values()].filter((e) => e.seq > since.seq) : null
            return [
              { seq: s.seq, replay },
              { ...s, subscribers: new Set([...s.subscribers, subscriber]) },
            ] as const
          }),
        )
        yield* Effect.addFinalizer(() =>
          Ref.update(state, (s) => ({ ...s, subscribers: new Set([...s.subscribers].filter((x) => x !== subscriber)) })).pipe(
            Effect.andThen(Queue.shutdown(queue)),
          ),
        )
        // A queue ended by `publish` is a subscriber that fell behind: its stream ends with `resync`.
        const live = Stream.fromQueue(queue).pipe(
          Stream.concat(Stream.fromEffect(Effect.map(Ref.get(state), (s): BoardEvent => ({ type: "resync", seq: s.seq })))),
        )
        return { seq: taken.seq, replay: taken.replay, live }
      })

      return Events.of({ boot, emit, seq: Effect.map(Ref.get(state), (s) => s.seq), watch })
    }),
  )
}
