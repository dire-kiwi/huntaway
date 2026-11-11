import { Effect, Option, Stream } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { HostId, type Task, TaskId, type TaskPatch } from "@huntaway/contracts"
import { callRpc, type CallError } from "../rpc.ts"
import { type Board, boardAtom } from "./board.ts"
import type { HostTask } from "./hostBoard.ts"
import { hostBoardAtom } from "./watch.ts"

/** A task on a host: ids are unique per host only. */
export interface TaskRef {
  readonly host_id: string
  readonly id: string
}

const refKey = (ref: TaskRef): string => `${ref.host_id}\u0000${ref.id}`

const taskByKey = Atom.family((key: string) => {
  const [host = "", id = ""] = key.split("\u0000")
  return Atom.make((get): HostTask | undefined => {
    const shown = get(boardAtom).tasks[id]
    if (shown?.host_id === host) return shown
    // Another host's task with the same id is not on the merged board: its own host's board has it.
    const own = AsyncResult.value(get(hostBoardAtom(HostId.make(host))))
    return Option.isSome(own) ? own.value.tasks.get(TaskId.make(id)) : undefined
  })
})

/** The exact lookup of a task, with any optimistic change in flight. New code uses it rather than `tasks[id]`. */
export const taskAtom = (ref: TaskRef): Atom.Atom<HostTask | undefined> => taskByKey(refKey(ref))

/** The fields of a patch that a task shows as they are, and so can be shown before the host answers. */
const shownAtOnce = (task: HostTask, patch: TaskPatch): HostTask =>
  changed(task, {
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.position !== undefined ? { position: patch.position } : {}),
    ...(patch.starred !== undefined ? { starred: patch.starred } : {}),
    ...(patch.pen_id !== undefined ? { pen_id: patch.pen_id } : {}),
  })

/** `x` with `changes`. */
const changed = <T extends object>(x: T, changes: Partial<T>): T => ({ ...x, ...changes })

/** The board with a task changed as `patch` will change it (pure). */
export const withPatch = (board: Board, ref: TaskRef, patch: TaskPatch): Board => {
  const task = board.tasks[ref.id]
  if (task?.host_id !== ref.host_id) return board
  return { ...board, tasks: { ...board.tasks, [ref.id]: shownAtOnce(task, patch) } }
}

/** How long a change waits for the host's event before the optimistic copy goes anyway. */
const EVENT_WAIT = "5 seconds"

const moveByKey = Atom.family((key: string) => {
  const [host_id = "", id = ""] = key.split("\u0000")
  const ref = { host_id, id }
  return Atom.optimisticFn(boardAtom, {
    reducer: (board: Board, patch: TaskPatch) => withPatch(board, ref, patch),
    // `tasks.update` on the task's host, then a wait for the board to have the task as the answer left it (its event),
    // so the optimistic copy is not dropped a moment before the event arrives.
    fn: Atom.fn<TaskPatch>()(
      Effect.fn("optimisticMove")(function* (patch, get) {
        const task: Task = yield* callRpc(ref.host_id, "tasks.update", { id: TaskId.make(ref.id), patch })
        yield* get.streamResult(hostBoardAtom(HostId.make(ref.host_id))).pipe(
          Stream.filter((b) => (b.tasks.get(task.id)?.updated_at ?? task.updated_at) >= task.updated_at),
          Stream.runHead,
          Effect.timeoutOption(EVENT_WAIT),
          Effect.ignore,
        )
        return task
      }),
    ),
  })
})

/**
 * Moving, reordering and starring a task (docs/plan/09-frontend.md): `tasks.update` with the change shown on the board
 * at once (its status, position, star and pen), until the host's event replaces it, or rolled back if the host refuses.
 * One per task, so moves of different cards run side by side; a second move of the same card replaces the first.
 */
export const optimisticMove = (ref: TaskRef): Atom.AtomResultFn<TaskPatch, Task, CallError<"tasks.update">> => moveByKey(refKey(ref))
