import { Cause, Effect, Option, Predicate } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { HostId, TaskId, type Turns } from "@huntaway/contracts"
import { HostClient } from "../session/HostClient.ts"
import { hostRuntime } from "../session/sessions.ts"
import { hostBoardAtom } from "./watch.ts"

// A task's turns with checkpoints (`checkpoints.turns`): what each of its agent's turns changed, and whether it can be
// rewound to before one. Read again when the board says its checkpoints changed (the `checkpoints` event: a turn's was
// taken, or it was rewound) and when its run, worktree or conversation changes, which change what can be rewound.

/** A task on a host. */
export interface TurnsRef {
  readonly host_id: string
  readonly task_id: string
}

const refKey = (ref: TurnsRef): string => `${ref.host_id}\u0000${ref.task_id}`

const parseKey = (key: string): { readonly host: HostId; readonly task: TaskId } => {
  const [host = "", task = ""] = key.split("\u0000")
  return { host: HostId.make(host), task: TaskId.make(task) }
}

/** What the task's turns are read again on: its latest `checkpoints` event, its run, its worktree and its session. */
const versionByKey = Atom.family((key: string) =>
  Atom.make((get): string => {
    const { host, task } = parseKey(key)
    const board = Option.getOrUndefined(AsyncResult.value(get(hostBoardAtom(host))))
    const t = board?.tasks.get(task)
    return `${board?.checkpoints.get(task) ?? 0}:${t?.running === true}:${t?.worktree_state ?? ""}:${t?.session_id ?? ""}`
  }),
)

const turnsByKey = Atom.family((key: string) => {
  const { host, task } = parseKey(key)
  return hostRuntime(host)
    .atom((get) => {
      get(versionByKey(key))
      return Effect.gen(function* () {
        const client = yield* HostClient
        return yield* client("checkpoints.turns", { task_id: task })
      })
    })
    .pipe(Atom.setIdleTTL("10 seconds"))
})

/** A task's turns as a component shows them: the latest read (kept while it's read again), and why the last failed. */
export interface TurnsView {
  readonly data: Turns | null
  readonly failed: string | null
}

const NOTHING: TurnsView = { data: null, failed: null }

/** Why the turns couldn't be read, as the view says it. */
const failure = (cause: Cause.Cause<unknown>): string => {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause))
  if (Predicate.isTagged(error, "Unavailable") && Predicate.hasProperty(error, "reason") && typeof error.reason === "string") return error.reason
  if (Predicate.isTagged(error, "NotFound")) return "the task isn't on its host"
  return "its host can't be reached"
}

const viewByKey = Atom.family((key: string) =>
  Atom.make((get): TurnsView => {
    const result = get(turnsByKey(key))
    if (AsyncResult.isSuccess(result)) return { data: result.value, failed: null }
    if (AsyncResult.isFailure(result)) return { data: Option.getOrNull(AsyncResult.value(result)), failed: failure(result.cause) }
    return NOTHING
  }),
)

/** A task's turns, read while something shows them (and for ten seconds after), again as they change. */
export const turnsAtom = (ref: TurnsRef): Atom.Atom<TurnsView> => viewByKey(refKey(ref))

/** No turns: for a task that has none to read (no worktree of its own). */
export const noTurnsAtom: Atom.Atom<TurnsView> = Atom.make(NOTHING)
