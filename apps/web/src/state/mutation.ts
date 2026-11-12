import { Cause, Effect, Exit } from "effect"
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity"
import { type CallError, type Methods, mutate } from "@huntaway/client"
import { useCallback, useState } from "react"
import { registry } from "./registry"

// How components change things (docs/plan/09-frontend.md, step 2): a mutation of `@huntaway/client` run from an event
// handler, its state (waiting, the failure by tag) the component's own. What it changes comes back as the board's
// events, and the queries of its group are read again (invalidate.ts); its answer is not written anywhere.

/**
 * Runs `effect` through the page's registry (no runtime of its own) and gives its exit: what `useAction` runs, and what
 * module-level code that is not a component (the notifier, push) calls with. The promise never rejects.
 */
export function runExit<A, E>(effect: Effect.Effect<A, E, AtomRegistry.AtomRegistry>): Promise<Exit.Exit<A, E>> {
  const { promise, resolve } = Promise.withResolvers<Exit.Exit<A, E>>()
  const fn = Atom.fn<void>()(() => Effect.exit(effect).pipe(Effect.tap((exit) => Effect.sync(() => resolve(exit)))))
  const unmount = registry.mount(fn)
  registry.set(fn, undefined)
  return promise.finally(unmount)
}

/** What a component shows of its own action: whether it's running, and why it failed last (null once it runs again). */
export interface ActionState {
  readonly busy: boolean
  readonly error: string | null
  /** The last failure itself, to tell by its tag (`isTagged(failure, "Conflict")`). */
  readonly failure: unknown
}

/** The failure of a result, if it failed with one (an interruption is not a failure). */
export function failureOf(result: AsyncResult.AsyncResult<unknown, unknown>): unknown {
  if (!AsyncResult.isFailure(result) || Cause.hasInterruptsOnly(result.cause)) return undefined
  return Cause.squash(result.cause)
}

/**
 * A component's own action: `run(effect)` runs an effect (one call, or a few in order) and resolves with its exit,
 * never rejecting; `state` is whether it is running and why it failed. Runs don't wait for each other, and `busy` is
 * true while any runs. The state is this component's, not shared with others running the same calls; a run is the
 * page's, not the component's, so it goes on when the component goes (a dialog closed while its save is on its way, a
 * set of tasks still being made): interrupting it would interrupt the call on the host too.
 */
export function useAction(): readonly [ActionState, <A, E>(effect: Effect.Effect<A, E, AtomRegistry.AtomRegistry>) => Promise<Exit.Exit<A, E>>] {
  const [own, setOwn] = useState<{ readonly running: number; readonly failure: unknown }>({ running: 0, failure: undefined })
  const run = useCallback(<A, E>(effect: Effect.Effect<A, E, AtomRegistry.AtomRegistry>): Promise<Exit.Exit<A, E>> => {
    setOwn((s) => ({ running: s.running + 1, failure: undefined }))
    return runExit(effect).then((exit) => {
      const failed = Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
      setOwn((s) => ({ running: s.running - 1, failure: failed ? Cause.squash(exit.cause) : s.failure }))
      return exit
    })
  }, [])
  const { running, failure } = own
  return [{ busy: running > 0, error: failure === undefined ? null : errorText(failure), failure }, run]
}

/**
 * `const [state, update] = useMutation("tasks.update")`, then `update(host, { id, patch })` in a handler: one method's
 * mutation as the component's own action (see `useAction`).
 */
export function useMutation<M extends keyof Methods>(
  method: M,
): readonly [ActionState, (host: string, payload: Methods[M]["payload"]) => Promise<Exit.Exit<Methods[M]["success"], CallError<M>>>] {
  const [state, run] = useAction()
  const call = useCallback((host: string, payload: Methods[M]["payload"]) => run(mutate(method, host, payload)), [method, run])
  return [state, call]
}

/** Whether `e` is the tagged error `tag` (`isTagged(e, "Conflict")`). */
export function isTagged<T extends string>(e: unknown, tag: T): e is { readonly _tag: T } {
  return typeof e === "object" && e !== null && "_tag" in e && e._tag === tag
}

/** A string field of an error, if it has a non-empty one. */
const textOf = (e: object, key: string): string | undefined => {
  const v: unknown = Reflect.get(e, key)
  return typeof v === "string" && v !== "" ? v : undefined
}

/**
 * An error's message, for showing. A host's tagged errors (`NotFound`, `Invalid`, `Conflict`, `Unavailable`…) have no
 * message of their own: what they say is in their fields.
 */
export const errorText = (e: unknown): string => {
  if (typeof e === "object" && e !== null && "_tag" in e && typeof e._tag === "string") {
    const [what, id, field, reason, detail] = ["what", "id", "field", "reason", "detail"].map((k) => textOf(e, k))
    if (e._tag === "NotFound") return `No ${what ?? "such thing"}${id ? ` ${id}` : ""} here.`
    if (e._tag === "Invalid") return field ? `${field}: ${reason ?? "not valid"}` : (reason ?? "Not valid.")
    if (e._tag === "Conflict") return detail ?? reason ?? "It conflicts with the board as it is now."
    if (e._tag === "Unavailable") return `${what ? `${what.charAt(0).toUpperCase()}${what.slice(1)}: ` : ""}${reason ?? "not available"}`
    const own = e instanceof Error ? e.message : ""
    return own || reason || detail || e._tag
  }
  return e instanceof Error ? e.message : String(e)
}

/** Why an exit failed, for showing; null for a success or an interruption. */
export function exitError(exit: Exit.Exit<unknown, unknown>): string | null {
  if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return null
  return errorText(Cause.squash(exit.cause))
}
