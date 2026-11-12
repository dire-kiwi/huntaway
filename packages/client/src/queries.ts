import { Duration, Effect, Option } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { HostId, type Unavailable } from "@huntaway/contracts"
import { hostBoardAtom } from "./board/watch.ts"
import { groupKey, groupsInvalidatedBy, invalidateGroups, triggers } from "./invalidate.ts"
import { type AnyError, type AnySuccess, callOnClient, callRpc, type CallError, type Methods } from "./rpc.ts"
import { hostRuntime } from "./session/sessions.ts"

// Queries and mutations (docs/plan/09-frontend.md): a read that is not in the board snapshot is an atom, read while
// something shows it (and ten seconds after), again when a mutation of its group on its host runs or what it follows on
// the board changes (invalidate.ts); a change is a mutation, whose answer is not written into the board (the event that
// follows it is).

/** A read of a host: initial, waiting (with the previous value), its answer, or why it failed. */
export type QueryResult<M extends keyof Methods> = AsyncResult.AsyncResult<Methods[M]["success"], CallError<M>>

/** How a reader wants a query kept. */
export interface QueryOptions {
  /** Read again this often while something shows it (a status an agent or a host changes outside the board). */
  readonly refresh?: Duration.Input | undefined
  /** Read again when the window gets the focus back. */
  readonly focus?: boolean | undefined
}

interface Key {
  readonly method: keyof Methods
  readonly host: string
  readonly payload: unknown
  readonly refresh: number
  readonly focus: boolean
}

/** What is read: one atom for every reader, however each keeps it. */
type Source = Omit<Key, "refresh" | "focus">

/** The value of a query's board trigger (invalidate.ts), or nothing to follow. */
const triggerOf = Atom.family((key: Source) =>
  Atom.make((get): string | number => {
    const trigger: unknown = triggers[key.method]
    if (typeof trigger !== "function") return ""
    const board = Option.getOrUndefined(AsyncResult.value(get(hostBoardAtom(HostId.make(key.host)))))
    const value: unknown = board === undefined ? "" : trigger(board, key.payload)
    return typeof value === "number" ? value : String(value)
  }),
)

const read = Atom.family((key: Source) =>
  hostRuntime(HostId.make(key.host))
    .atom((get) => {
      get(triggerOf(key))
      return callOnClient(key.method, key.payload)
    })
    .pipe(Atom.withReactivity([groupKey(key.host, key.method.slice(0, key.method.indexOf(".")))]), Atom.setIdleTTL("10 seconds")),
)

const kept = Atom.family((key: Key) => {
  const { refresh, focus, ...source } = key
  const polled = refresh > 0 ? Atom.withRefresh(read(source), refresh) : read(source)
  return focus ? Atom.refreshOnWindowFocus(polled) : polled
})

/**
 * `useAtomValue(query("git.status", host, { id }))`: what `method` answers on `host` with `payload`. One atom per
 * method, host and payload (payloads are compared by value), shared by every reader.
 */
export function query<M extends keyof Methods>(method: M, host: string, payload: Methods[M]["payload"], options?: QueryOptions): Atom.Atom<QueryResult<M>> {
  const atom: Atom.Atom<AsyncResult.AsyncResult<AnySuccess, AnyError | Unavailable>> = kept({
    method,
    host,
    payload,
    refresh: options?.refresh === undefined ? 0 : Duration.toMillis(Duration.fromInputUnsafe(options.refresh)),
    focus: options?.focus === true,
  })
  return isQueryOf(method, atom) ? atom : Atom.make(AsyncResult.initial())
}

/**
 * The family keeps every method's atoms together, so their type is the union of all; the atom for `method` holds what
 * `method` answers (it was built from it). Derived from the contract like the flat client's `isCall`.
 */
const isQueryOf = <M extends keyof Methods>(
  _method: M,
  atom: Atom.Atom<AsyncResult.AsyncResult<AnySuccess, AnyError | Unavailable>>,
): atom is Atom.Atom<QueryResult<M>> => Atom.isAtom(atom)

/**
 * Calls `method` on `host` as a change: the queries of its group on that host (and the groups `invalidates` adds) are
 * read again once it has run, whether it succeeded or not.
 */
export const mutate = <M extends keyof Methods>(method: M, host: string, payload: Methods[M]["payload"]) =>
  callRpc(host, method, payload).pipe(Effect.ensuring(invalidateGroups(host, groupsInvalidatedBy(method))))
