import { Cause, Effect, Option, Predicate } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { AutomationId, HostId, ProfileId, ProjectId, type AutomationList, type AutomationRuns } from "@huntaway/contracts"
import { HostClient } from "../session/HostClient.ts"
import { hostRuntime } from "../session/sessions.ts"
import { hostBoardAtom } from "./watch.ts"

// A project's automations or a profile's routines (`automations.list`), and an automation's runs (`automations.runs`):
// read while something shows them, and again when the board says they changed (the `automations_changed` event, kept
// in the host's board by owner and by automation).

/** A project's automations, or (with `profile_id`) a profile's routines, on a host. */
export type AutomationsRef = { readonly host_id: string; readonly project_id: string } | { readonly host_id: string; readonly profile_id: string }

/** An automation on a host. */
export interface AutomationRunsRef {
  readonly host_id: string
  readonly automation_id: string
}

/** What a component shows: the latest read (kept while it's read again), and why the last failed. */
export interface QueryView<A> {
  readonly data: A | null
  readonly failed: string | null
}

const SEP = "\u0000"

/** The number of the latest `automations_changed` event about `key` (an owner's id, or an automation's) on `host`. */
const versionOf = Atom.family((k: string) =>
  Atom.make((get): number => {
    const [host = "", key = ""] = k.split(SEP)
    const board = Option.getOrUndefined(AsyncResult.value(get(hostBoardAtom(HostId.make(host)))))
    return board?.automations.get(key) ?? 0
  }),
)

const listByKey = Atom.family((k: string) => {
  const [host = "", kind = "", id = ""] = k.split(SEP)
  return hostRuntime(HostId.make(host))
    .atom((get) => {
      get(versionOf(`${host}${SEP}${id}`))
      return Effect.gen(function* () {
        const client = yield* HostClient
        return yield* client("automations.list", kind === "profile" ? { profile_id: ProfileId.make(id) } : { project_id: ProjectId.make(id) })
      })
    })
    .pipe(Atom.setIdleTTL("10 seconds"))
})

const runsByKey = Atom.family((k: string) => {
  const [host = "", id = ""] = k.split(SEP)
  return hostRuntime(HostId.make(host))
    .atom((get) => {
      get(versionOf(k))
      return Effect.gen(function* () {
        const client = yield* HostClient
        return yield* client("automations.runs", { id: AutomationId.make(id) })
      })
    })
    .pipe(Atom.setIdleTTL("10 seconds"))
})

/** Why a read failed, as the view says it: a tagged error's reason or detail, else that the host can't be reached. */
const errorMessage = (error: unknown): string => {
  for (const k of ["reason", "detail"]) {
    if (Predicate.hasProperty(error, k) && typeof error[k] === "string" && error[k] !== "") return error[k]
  }
  if (Predicate.isTagged(error, "NotFound")) return "it isn't on its host"
  return "its host can't be reached"
}

const viewOf = <A>(result: AsyncResult.AsyncResult<A, unknown>): QueryView<A> => {
  if (AsyncResult.isSuccess(result)) return { data: result.value, failed: null }
  if (AsyncResult.isFailure(result)) return { data: Option.getOrNull(AsyncResult.value(result)), failed: errorMessage(Cause.squash(result.cause)) }
  return { data: null, failed: null }
}

const listViews = Atom.family((k: string) => Atom.make((get): QueryView<AutomationList> => viewOf(get(listByKey(k)))))
const runsViews = Atom.family((k: string) => Atom.make((get): QueryView<AutomationRuns> => viewOf(get(runsByKey(k)))))

/** A project's automations or a profile's routines, with the host's time zone, read again as they change. */
export const automationsAtom = (ref: AutomationsRef): Atom.Atom<QueryView<AutomationList>> =>
  listViews("project_id" in ref ? `${ref.host_id}${SEP}project${SEP}${ref.project_id}` : `${ref.host_id}${SEP}profile${SEP}${ref.profile_id}`)

/** An automation's latest runs and its latest delivery, read again as they change. */
export const automationRunsAtom = (ref: AutomationRunsRef): Atom.Atom<QueryView<AutomationRuns>> => runsViews(`${ref.host_id}${SEP}${ref.automation_id}`)
