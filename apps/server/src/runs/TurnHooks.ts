import { Cause, Context, Effect, Layer, Ref } from "effect"
import type { TaskId } from "@huntaway/contracts"

// What hears of a run's tool calls and the ends of its turns (huntaway's runner/output.ts and codex/driver.ts calling
// `documents.follow` after a tool result and `documents.turn_ended` at a turn's and a run's end). The areas that keep
// something an agent writes as it goes (the task's documents, 6.2) sit below `runs/` in the dependency order, so they
// register here when their layer is built (`TaskDocuments.registered`), as the areas below answer agents' requests
// through `AgentRequests`. Every hook registered hears of each, in the order registered; one that fails is logged.

/** 6.7: a turn's end as its agent's output said it (not a run's end): whether it was a compaction's. */
export interface TurnEnd {
  readonly compact: boolean
}

/** An area's hooks. */
export interface TurnHook {
  /** A tool call of the task's agent finished (it may have written a file the area keeps). After the line commits. */
  readonly toolDone: (task: TaskId) => Effect.Effect<void>
  /**
   * A turn of the task's agent ended, or its run did (what the run left unfinished is kept as its turn's). `end` (6.7):
   * the turn's, from the agent's output; none for a run's end.
   */
  readonly turnEnded: (task: TaskId, end?: TurnEnd) => Effect.Effect<void>
}

export interface TurnHooksShape {
  readonly register: (hook: TurnHook) => Effect.Effect<void>
  readonly toolDone: (task: TaskId) => Effect.Effect<void>
  readonly turnEnded: (task: TaskId, end?: TurnEnd) => Effect.Effect<void>
}

export class TurnHooks extends Context.Service<TurnHooks, TurnHooksShape>()("huntaway-server/runs/TurnHooks") {
  static readonly layer = Layer.effect(
    TurnHooks,
    Effect.gen(function* () {
      const hooks = yield* Ref.make<ReadonlyArray<TurnHook>>([])
      const each = (task: TaskId, what: string, f: (hook: TurnHook) => Effect.Effect<void>) =>
        Effect.flatMap(Ref.get(hooks), (all) =>
          Effect.forEach(
            all,
            (hook) =>
              f(hook).pipe(
                Effect.catchCauseIf(
                  (cause) => !Cause.hasInterruptsOnly(cause),
                  (cause) => Effect.logWarning(`task=${task} ${what} failed`, cause),
                ),
              ),
            { concurrency: 1, discard: true },
          ),
        )
      return TurnHooks.of({
        register: (hook) => Ref.update(hooks, (all) => [...all, hook]),
        toolDone: (task) => each(task, "following a tool call", (hook) => hook.toolDone(task)),
        turnEnded: (task, end) => each(task, "following a turn's end", (hook) => hook.turnEnded(task, end)),
      })
    }),
  )
}
