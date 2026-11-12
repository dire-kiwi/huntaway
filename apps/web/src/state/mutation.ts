import { useAtomMount, useAtomValue } from "@effect/atom-react"
import { Cause, Effect, Exit, Schema } from "effect"
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity"
import { type CallError, type Methods, mutate } from "@huntaway/client"
import { useCallback, useState } from "react"
import { registry } from "./registry"

// How components change things (docs/plan/09-frontend.md, step 2): a mutation of `@huntaway/client` run from an event
// handler, its state (waiting, the failure by tag) the component's own. What it changes comes back as the board's
// events, and the queries of its group are read again (invalidate.ts); its answer is not written anywhere.

/** A component's action failed: `failure` is what it failed with (a host's tagged error, mostly). */
class ActionFailed extends Schema.TaggedError<ActionFailed, { readonly brand: unique symbol }>()("ActionFailed", { failure: Schema.Unknown }) {}

const isActionFailed = Schema.is(ActionFailed)

/** What a component's action runs: the effect it was given, its exit already passed to whoever waits for it. */
type Job = Effect.Effect<void, ActionFailed, AtomRegistry.AtomRegistry>

/**
 * Runs `effect` through the page's registry (no runtime of its own) and gives its exit: for module-level code (the
 * notifier, push) that is not a component. The promise never rejects.
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
 * true while any runs. The state is this component's, not shared with others running the same calls.
 */
export function useAction(): readonly [ActionState, <A, E>(effect: Effect.Effect<A, E, AtomRegistry.AtomRegistry>) => Promise<Exit.Exit<A, E>>] {
  const [fn] = useState(() => Atom.fn<Job>()((job) => job, { concurrent: true }))
  useAtomMount(fn)
  const result = useAtomValue(fn)
  const run = useCallback(
    <A, E>(effect: Effect.Effect<A, E, AtomRegistry.AtomRegistry>): Promise<Exit.Exit<A, E>> => {
      const { promise, resolve } = Promise.withResolvers<Exit.Exit<A, E>>()
      registry.set(
        fn,
        Effect.exit(effect).pipe(
          Effect.tap((exit) => Effect.sync(() => resolve(exit))),
          Effect.flatMap((exit) =>
            Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause) ? Effect.void : Effect.fail(new ActionFailed({ failure: Cause.squash(exit.cause) })),
          ),
        ),
      )
      return promise
    },
    [fn],
  )
  const failed = failureOf(result)
  const failure = isActionFailed(failed) ? failed.failure : failed
  return [{ busy: result.waiting, error: failure === undefined ? null : errorText(failure), failure }, run]
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
