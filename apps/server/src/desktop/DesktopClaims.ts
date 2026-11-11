import { Clock, Context, Effect, Layer, Ref } from "effect"
import type { DesktopTarget, TaskId } from "@huntaway/contracts"
import { nowTimestamp } from "../platform/columns.ts"

// Who drives the desktop (huntaway's desktop.ts `claim` and `set_target`): one task at a time, since tasks' agents share
// one keyboard, pointer and focus. A task holds it for `LEASE_MS` after its last action. And the window each task's
// agent last looked at or acted on, which the board's viewer shows. Both are lost with the process, as before: the
// journal (`DesktopOpRepo`) is the durable part.

/** How long a task keeps the desktop after its last action, before another may drive it. */
export const LEASE_MS = 120_000

/** The task driving the desktop, and when it last acted (ms since the epoch). */
export interface Holder {
  readonly task_id: TaskId
  readonly at: number
}

export interface DesktopClaimsShape {
  /**
   * Let task `task` drive the desktop: null if it may (it holds it now, from `now`, the clock's time by default), or the
   * task that holds it (for `LEASE_MS` after that task's last action).
   */
  readonly claim: (task: TaskId, now?: number) => Effect.Effect<Holder | null>
  /** The task driving the desktop now, if any. */
  readonly holder: Effect.Effect<Holder | null>
  /** Let the desktop go: `task`'s hold, or anyone's. */
  readonly release: (task?: TaskId) => Effect.Effect<void>
  /** Task `task`'s agent looked at or acted on this window. */
  readonly setTarget: (task: TaskId, pid: number, windowId: number | null) => Effect.Effect<void>
  /** The window task `task`'s agent last used. */
  readonly target: (task: TaskId) => Effect.Effect<DesktopTarget | null>
}

export class DesktopClaims extends Context.Service<DesktopClaims, DesktopClaimsShape>()("huntaway-server/desktop/DesktopClaims") {
  static readonly layer = Layer.effect(
    DesktopClaims,
    Effect.gen(function* () {
      const holder = yield* Ref.make<Holder | null>(null)
      const targets = yield* Ref.make<ReadonlyMap<TaskId, DesktopTarget>>(new Map())
      return DesktopClaims.of({
        claim: (task, at) =>
          Effect.flatMap(at === undefined ? Clock.currentTimeMillis : Effect.succeed(at), (now) =>
            Ref.modify(holder, (h): readonly [Holder | null, Holder | null] =>
              h !== null && h.task_id !== task && now - h.at < LEASE_MS ? [h, h] : [null, { task_id: task, at: now }],
            ),
          ),
        holder: Effect.flatMap(Clock.currentTimeMillis, (now) => Effect.map(Ref.get(holder), (h) => (h !== null && now - h.at < LEASE_MS ? h : null))),
        release: (task) => Ref.update(holder, (h) => (task === undefined || h?.task_id === task ? null : h)),
        setTarget: (task, pid, windowId) =>
          Effect.flatMap(nowTimestamp, (at) => Ref.update(targets, (all) => new Map([...all, [task, { pid, window_id: windowId, at }]]))),
        target: (task) => Effect.map(Ref.get(targets), (all) => all.get(task) ?? null),
      })
    }),
  )
}
