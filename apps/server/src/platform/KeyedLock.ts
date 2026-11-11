import { Context, Effect, Layer, Ref, Semaphore } from "effect"

/**
 * What a lock is taken on. Locks are taken in this order (project, then worktree, then task, then run) and never across a
 * wait for a person. `["worktree", task]` serialises a task's worktree setup, teardown and restack, which can take
 * minutes (a setup script), so its `["task", task]` lock is only taken for each write meanwhile.
 */
export type LockKey =
  | readonly ["project", string]
  | readonly ["worktree", string]
  | readonly ["task", string]
  | readonly ["run", string]
  | readonly ["workspace", string]

export interface KeyedLockShape {
  /** One holder per key at a time, waiters in order, released on any exit. */
  readonly withLock: (key: LockKey) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

const name = (key: LockKey) => `${key[0]}:${key[1]}`

interface Entry {
  readonly semaphore: Semaphore.Semaphore
  readonly users: number
}

/**
 * Per-entity locks for work that spans a wait (docs/plan/06-server.md, KeyedLock). Backed by a map of semaphores that
 * drops an entry when nobody holds or waits for it.
 */
export class KeyedLock extends Context.Service<KeyedLock, KeyedLockShape>()("huntaway-server/platform/KeyedLock") {
  static readonly layer = Layer.effect(
    KeyedLock,
    Effect.gen(function* () {
      const entries = yield* Ref.make<ReadonlyMap<string, Entry>>(new Map())

      const acquire = (id: string) =>
        Effect.flatMap(Semaphore.make(1), (fresh) =>
          Ref.modify(entries, (map) => {
            const entry = map.get(id) ?? { semaphore: fresh, users: 0 }
            const next = new Map(map)
            next.set(id, { semaphore: entry.semaphore, users: entry.users + 1 })
            return [entry.semaphore, next] as const
          }),
        )
      const release = (id: string) =>
        Ref.update(entries, (map) => {
          const entry = map.get(id)
          if (entry === undefined) return map
          const next = new Map(map)
          if (entry.users <= 1) next.delete(id)
          else next.set(id, { semaphore: entry.semaphore, users: entry.users - 1 })
          return next
        })

      const withLock =
        (key: LockKey) =>
        <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
          const id = name(key)
          return Effect.acquireUseRelease(
            acquire(id),
            (semaphore) => Semaphore.withPermits(semaphore, 1)(effect),
            () => release(id),
          )
        }
      return KeyedLock.of({ withLock })
    }),
  )
}
