import { Cause, Effect, Exit } from "effect"
import { Atom, type AtomRegistry } from "effect/reactivity"
import { useCallback, useState } from "react"
import { registry } from "./registry"

// How screens change things, as the web app's state/mutation.ts: an effect of @huntaway/client (a mutation, a call)
// run through the registry from a handler, its state (busy, why it failed) the component's own. What it changes comes
// back as the board's events.

/**
 * Runs `effect` through the registry (as the web app's `runExit`: a one-off `Atom.fn`, mounted until it ends) and calls
 * `done` with its exit. Callbacks rather than a promise: making one would need `Promise.withResolvers`, which Hermes
 * may not have.
 */
export function runExit<A, E>(effect: Effect.Effect<A, E, AtomRegistry.AtomRegistry>, done: (exit: Exit.Exit<A, E>) => void): void {
  let unmount: (() => void) | undefined
  const fn = Atom.fn<void>()(() =>
    Effect.exit(effect).pipe(
      Effect.tap((exit) =>
        Effect.sync(() => {
          done(exit)
          // Not from inside the run itself: unmounting interrupts it.
          void Promise.resolve().then(() => unmount?.())
        }),
      ),
    ),
  )
  unmount = registry.mount(fn)
  registry.set(fn, undefined)
}

/** Whether a component's own action is running, and why it failed last (null once it runs again). */
export interface ActionState {
  readonly busy: boolean
  readonly error: string | null
}

/** Runs an effect as the component's own action, then `onExit` with how it ended. */
export type Run = <A, E>(effect: Effect.Effect<A, E, AtomRegistry.AtomRegistry>, onExit?: (exit: Exit.Exit<A, E>) => void) => void

/**
 * A component's own action: `run(effect, onExit)`; `state` says whether any run is going and why the last one failed.
 * A run is the app's, not the component's: leaving the screen does not stop a send.
 */
export function useAction(): readonly [ActionState, Run] {
  const [own, setOwn] = useState<{ readonly running: number; readonly error: string | null }>({ running: 0, error: null })
  const run = useCallback<Run>((effect, onExit) => {
    setOwn((st) => ({ running: st.running + 1, error: null }))
    runExit(effect, (exit) => {
      const error = exitError(exit)
      setOwn((st) => ({ running: st.running - 1, error: error ?? st.error }))
      onExit?.(exit)
    })
  }, [])
  return [{ busy: own.running > 0, error: own.error }, run]
}

/** A string field of an error, if it has a non-empty one. */
const textOf = (e: object, key: string): string | undefined => {
  const v: unknown = Reflect.get(e, key)
  return typeof v === "string" && v !== "" ? v : undefined
}

/**
 * An error's message, for showing (the web app's `errorText`): a host's tagged errors say what they mean in their
 * fields, not in a message.
 */
export const errorText = (e: unknown): string => {
  if (typeof e === "object" && e !== null && "_tag" in e && typeof e._tag === "string") {
    const [what, id, field, reason, detail] = ["what", "id", "field", "reason", "detail"].map((k) => textOf(e, k))
    if (e._tag === "NotFound") return `No ${what ?? "such thing"}${id === undefined ? "" : ` ${id}`} here.`
    if (e._tag === "Invalid") return field === undefined ? (reason ?? "Not valid.") : `${field}: ${reason ?? "not valid"}`
    if (e._tag === "Conflict") return detail ?? reason ?? "It conflicts with the board as it is now."
    if (e._tag === "Unavailable") return `${what === undefined ? "" : `${what.charAt(0).toUpperCase()}${what.slice(1)}: `}${reason ?? "not available"}`
    if (e._tag === "Unauthorized") return "The board turned this token down."
    if (e._tag === "Forbidden") return "This token may not do that."
    const own = e instanceof Error ? e.message : ""
    return own || (reason ?? detail ?? e._tag)
  }
  return e instanceof Error ? e.message : String(e)
}

/** Why an exit failed, for showing; null for a success or an interruption. */
export function exitError(exit: Exit.Exit<unknown, unknown>): string | null {
  if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return null
  return errorText(Cause.squash(exit.cause))
}
