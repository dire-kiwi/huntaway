import { Cause, Effect, Option, Predicate } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { DocumentLabel, HostId, TaskId, type TaskDocument } from "@huntaway/contracts"
import { HostClient } from "../session/HostClient.ts"
import { hostRuntime } from "../session/sessions.ts"
import { hostBoardAtom } from "./watch.ts"

// A task's document for one of its labels (`tasks.document`, 6.2): a version of the plan, artifact or diagram its agent
// writes, and the list of its versions. Read again when the board says one of the task's documents changed (its
// `document_at`), as the old view fetched it again on that.

/** A task's document on a host: its label's, at `version` (null: the latest). */
export interface TaskDocumentRef {
  readonly host_id: string
  readonly task_id: string
  readonly label: DocumentLabel
  readonly version: number | null
}

const refKey = (ref: TaskDocumentRef): string => [ref.host_id, ref.task_id, ref.label, ref.version ?? ""].join("\u0000")

const isLabel = (s: string): s is DocumentLabel => DocumentLabel.literals.some((l) => l === s)

const parseKey = (key: string) => {
  const [host = "", task = "", label = "", version = ""] = key.split("\u0000")
  return {
    host: HostId.make(host),
    task: TaskId.make(task),
    label: isLabel(label) ? label : ("plan" as const),
    version: version === "" ? undefined : Number(version),
  }
}

/** What the document is read again on: the task's `document_at`. */
const versionByKey = Atom.family((key: string) =>
  Atom.make((get): string => {
    const { host, task } = parseKey(key)
    const board = Option.getOrUndefined(AsyncResult.value(get(hostBoardAtom(host))))
    return board?.tasks.get(task)?.document_at ?? ""
  }),
)

const documentByKey = Atom.family((key: string) => {
  const { host, task, label, version } = parseKey(key)
  return hostRuntime(host)
    .atom((get) => {
      get(versionByKey(key))
      return Effect.gen(function* () {
        const client = yield* HostClient
        return yield* client("tasks.document", { id: task, label, ...(version === undefined ? {} : { version }) })
      })
    })
    .pipe(Atom.setIdleTTL("10 seconds"))
})

/** A task's document as a view shows it: the latest read (kept while it's read again), and why the last failed. */
export interface TaskDocumentView {
  readonly doc: TaskDocument | null
  readonly failed: string | null
}

const NOTHING: TaskDocumentView = { doc: null, failed: null }

/** Why the document couldn't be read, as the view says it. */
const failure = (cause: Cause.Cause<unknown>): string => {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause))
  if (Predicate.isTagged(error, "NotFound") && Predicate.hasProperty(error, "what") && error.what === "version") return "That version isn't there"
  if (Predicate.isTagged(error, "NotFound")) return "The task isn't on its host"
  if (Predicate.isTagged(error, "Unavailable") && Predicate.hasProperty(error, "reason") && typeof error.reason === "string") return error.reason
  return "Its host can't be reached"
}

const viewByKey = Atom.family((key: string) =>
  Atom.make((get): TaskDocumentView => {
    const result = get(documentByKey(key))
    if (AsyncResult.isSuccess(result)) return { doc: result.value, failed: null }
    if (AsyncResult.isFailure(result)) return { doc: Option.getOrNull(AsyncResult.value(result)), failed: failure(result.cause) }
    return NOTHING
  }),
)

/** A task's document, read while something shows it (and for ten seconds after), again as it changes. */
export const taskDocumentAtom = (ref: TaskDocumentRef): Atom.Atom<TaskDocumentView> => viewByKey(refKey(ref))
