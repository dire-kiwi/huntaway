import { Context, Effect, Layer, Queue, Stream, SubscriptionRef } from "effect"
import type { Project, RunId, Task, TaskId } from "@huntaway/contracts"

/** Who asked for a change (docs/plan/06-server.md, Tasks): decides what may be set, and is recorded as its cause. */
export type Actor =
  | { readonly _tag: "User" }
  | { readonly _tag: "Device"; readonly device_id: string }
  | { readonly _tag: "Agent"; readonly task_id: TaskId }
  | { readonly _tag: "Automation"; readonly automation_id: string }
  | { readonly _tag: "Board" }

export const Actor = {
  user: { _tag: "User" } as Actor,
  board: { _tag: "Board" } as Actor,
}

/** How a run's process ended: its folder's `exit` file (`runs/RunDir`'s `RunExit`). */
export interface RunExitStatus {
  readonly code: number | null
  readonly signal: number | null
  readonly error?: string | undefined
}

/**
 * What a service tells the reactor after its commit (docs/plan/06-server.md, How an area reaches upward). M1 has task
 * changes; runs, reviews, pull requests and workflows add theirs.
 */
export type Change =
  | {
      readonly _tag: "TaskChanged"
      /** null for a new task. */
      readonly before: Task | null
      /** null for a deleted task. */
      readonly after: Task | null
      readonly cause: Actor
    }
  | {
      /**
       * A run's agent exited and its follower has applied all its output (`runs/RunFollower`); or its launch ended
       * before the agent started (`runs/Runs`: given up, failed, or stopped while it was prepared), with `code` and
       * `signal` null and `error` saying why.
       */
      readonly _tag: "RunExited"
      readonly run: RunId
      readonly task: TaskId
      readonly exit: RunExitStatus
      /** The last 4000 bytes of its `err.log`, for a failure's reason. */
      readonly errorTail: string
    }
  | {
      /** A project's settings changed (`projects/Projects.update`): its tasks follow what they take from them (4.5: previews). */
      readonly _tag: "ProjectChanged"
      readonly before: Project
      readonly after: Project
    }

export interface ChangesShape {
  /** After a commit: hand a change to the reactor. Never waits. */
  readonly offer: (change: Change) => Effect.Effect<void>
  /** The reactor's side: the next change, waiting for one. Call `done` when it is handled. */
  readonly take: Effect.Effect<Change>
  readonly done: Effect.Effect<void>
  /** Waits until every change offered so far has been handled: what tests wait on (`Reactor.idle`). */
  readonly idle: Effect.Effect<void>
}

/** The queue the reactor (`lifecycle/Reactor`) reads. In memory: what must survive a restart is reconciled at startup. */
export class Changes extends Context.Service<Changes, ChangesShape>()("huntaway-server/platform/Changes") {
  static readonly layer = Layer.effect(
    Changes,
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<Change>()
      const outstanding = yield* SubscriptionRef.make(0)
      return Changes.of({
        offer: (change) => SubscriptionRef.update(outstanding, (n) => n + 1).pipe(Effect.andThen(Queue.offer(queue, change)), Effect.asVoid),
        take: Queue.take(queue),
        done: SubscriptionRef.update(outstanding, (n) => Math.max(0, n - 1)),
        idle: SubscriptionRef.changes(outstanding).pipe(
          Stream.filter((n) => n === 0),
          Stream.take(1),
          Stream.runDrain,
        ),
      })
    }),
  )
}
