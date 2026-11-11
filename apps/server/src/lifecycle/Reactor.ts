import { Context, Effect, Layer } from "effect"
import { Changes } from "../platform/Changes.ts"
import type { Change } from "../platform/Changes.ts"
import { Dependencies } from "../tasks/Dependencies.ts"

export interface ReactorShape {
  /** Waits until every change offered so far has been handled. Tests wait on this instead of sleeping. */
  readonly idle: Effect.Effect<void>
}

/**
 * The one consumer of `Changes` (docs/plan/06-server.md, How an area reaches upward). For each change it calls, in a
 * fixed order, the reconcilers the change could affect. M1 handles changes one at a time in commit order, which keeps
 * one task's in order too; handling different tasks in parallel, each under its lock, comes with the slow reconcilers
 * (M2 on). M1 has the dependencies; the merge lane, reviews, workflows, status scripts and the rest join with their areas.
 */
export class Reactor extends Context.Service<Reactor, ReactorShape>()("huntaway-server/lifecycle/Reactor") {
  static readonly layer = Layer.effect(
    Reactor,
    Effect.gen(function* () {
      const changes = yield* Changes
      const dependencies = yield* Dependencies

      const handle = Effect.fn("Reactor.handle")(function* (change: Change) {
        // A run's end is decided in M2's next steps (docs/plan/07-agents.md, When a run ends).
        if (change._tag !== "TaskChanged") return
        const task = change.after ?? change.before
        if (task === null) return
        const moved = change.before?.status !== change.after?.status
        const depsChanged = change.before?.depends_on !== change.after?.depends_on
        // A task that moved, was deleted or changed what it waits for may unblock tasks waiting on its project.
        if (moved || depsChanged || change.after === null) yield* dependencies.reconcile(task.project_id)
      })

      // Handled one at a time, in the order they were committed. A failure is logged and does not stop the loop.
      const loop = changes.take.pipe(
        Effect.flatMap((change) =>
          handle(change).pipe(
            Effect.catchCause((cause) => Effect.logError("reactor: handling a change failed", cause)),
            Effect.ensuring(changes.done),
          ),
        ),
        Effect.forever,
        Effect.annotateLogs({ module: "reactor" }),
      )
      yield* Effect.forkScoped(loop)
      return Reactor.of({ idle: changes.idle })
    }),
  )
}
