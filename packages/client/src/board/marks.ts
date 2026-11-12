import { Effect, Stream } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import { HostId, type Task, TaskId, type TaskPatch, Timestamp } from "@huntaway/contracts"
import { callRpc } from "../rpc.ts"
import type { HostTask } from "./hostBoard.ts"
import { hostBoardAtom } from "./watch.ts"

// A task's star and reminder as the user has just set them (the old board's `setMarks`, docs/plan/09-frontend.md,
// Optimistic changes): shown at once on top of what the host says, each save on its own. A save that fails takes back
// only its own change, so what changed on the host meanwhile (a rename, a reminder set by an agent) stays, and so does
// another save still in flight (a clear after a snooze). Unlike `optimisticMove`, the board goes on taking the host's
// events while a save is in flight.

/** What a star or reminder save changes. */
export type Marks = Pick<TaskPatch, "starred" | "remind_at" | "reminder">

/** A save in flight: compared by identity, so two saves of the same change are two. */
export interface PendingMarks {
  readonly host_id: string
  readonly id: string
  readonly patch: Marks
}

/** The saves in flight, oldest first. */
export const pendingMarksAtom: Atom.Writable<ReadonlyArray<PendingMarks>> = Atom.make<ReadonlyArray<PendingMarks>>([]).pipe(Atom.keepAlive)

/** `x` with `changes`. */
const changed = <T extends object>(x: T, changes: Partial<T>): T => ({ ...x, ...changes })

/** `task` as `patch` shows it (pure): a blank or null `remind_at` clears the reminder's note too, as the host does. */
export const withMarks = (task: HostTask, patch: Marks): HostTask => {
  const cleared = patch.remind_at !== undefined && (patch.remind_at === null || patch.remind_at.trim() === "")
  return changed(task, {
    ...(patch.starred !== undefined ? { starred: patch.starred } : {}),
    ...(patch.remind_at !== undefined ? { remind_at: cleared || patch.remind_at === null ? null : Timestamp.make(patch.remind_at) } : {}),
    ...(cleared ? { reminder: null } : patch.reminder !== undefined ? { reminder: patch.reminder } : {}),
  })
}

/** The tasks of `tasks` (by bare id) with the saves in flight shown on them (pure); the same object when none is. */
export const withPendingMarks = (tasks: Readonly<Record<string, HostTask>>, pending: ReadonlyArray<PendingMarks>): Readonly<Record<string, HostTask>> => {
  if (pending.length === 0) return tasks
  const out: Record<string, HostTask> = { ...tasks }
  for (const p of pending) {
    const task = out[p.id]
    if (task?.host_id === p.host_id) out[p.id] = withMarks(task, p.patch)
  }
  return out
}

/** How long a save that succeeded waits for the host's event before its change stops being shown anyway. */
const EVENT_WAIT = "5 seconds"

/**
 * Stars, unstars, sets or clears a task's reminder (`tasks.update`), shown on the board at once. Once the host has
 * answered and its event has come (the board has the task as the answer left it, or later), the board shows the host's
 * own task; a refused save just stops being shown. Fails with the call's error.
 */
export const saveMarks = Effect.fn("saveMarks")(function* (ref: { readonly host_id: string; readonly id: string }, patch: Marks) {
  const registry = yield* AtomRegistry.AtomRegistry
  const pending: PendingMarks = { host_id: ref.host_id, id: ref.id, patch }
  registry.update(pendingMarksAtom, (all) => [...all, pending])
  const done = Effect.sync(() => registry.update(pendingMarksAtom, (all) => all.filter((p) => p !== pending)))
  return yield* Effect.gen(function* () {
    const task: Task = yield* callRpc(ref.host_id, "tasks.update", { id: TaskId.make(ref.id), patch })
    yield* AtomRegistry.toStreamResult(registry, hostBoardAtom(HostId.make(ref.host_id))).pipe(
      Stream.filter((b) => (b.tasks.get(task.id)?.updated_at ?? task.updated_at) >= task.updated_at),
      Stream.runHead,
      Effect.timeoutOption(EVENT_WAIT),
      Effect.ignore,
    )
    return task
  }).pipe(Effect.ensuring(done))
})
