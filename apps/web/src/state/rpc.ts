import { Cause, type Effect } from "effect"
import { Atom, type AtomRegistry } from "effect/reactivity"
import { callHub, callRpc, type Methods } from "@huntaway/client"
import { registry } from "./registry"

/** Calls a method on a host and gives a promise, for event handlers: it rejects with the tagged error (see `isTagged`). */
export type Rpc = <M extends keyof Methods>(host: string, method: M, payload: Methods[M]["payload"]) => Promise<Methods[M]["success"]>

/**
 * Runs an effect through the registry (no runtime of its own) and gives its answer as a promise: a call that failed
 * rejects with its error (a tagged one, or the defect).
 */
export function run<A, E>(effect: Effect.Effect<A, E, AtomRegistry.AtomRegistry>): Promise<A> {
  const fn = Atom.fn<void>()(() => effect)
  const { promise, resolve, reject } = Promise.withResolvers<A>()
  const unmount = registry.mount(fn)
  const cancel = registry.subscribe(fn, (result) => {
    if (result._tag === "Initial" || result.waiting) return
    cancel()
    unmount()
    if (result._tag === "Success") resolve(result.value)
    else reject(Cause.squash(result.cause))
  })
  registry.set(fn, undefined)
  return promise
}

/** `rpc(host, "tasks.update", { id, patch })`: the same as `useRpc()`, for module-level code. */
export const rpc: Rpc = (host, method, payload) => run(callRpc(host, method, payload))

/** `hubRpc("hub.push.info", undefined)`: a call to the page's own server (the hub's methods, 6.8), as a promise. */
export const hubRpc = <M extends keyof Methods>(method: M, payload: Methods[M]["payload"]): Promise<Methods[M]["success"]> => run(callHub(method, payload))

/** The host call for event handlers. A mutation's answer is not put on the board: the event that follows it is. */
export function useRpc(): Rpc {
  return rpc
}

/** Whether `e` is the tagged error `tag` (`isTagged(e, "Conflict")`), as a rejected `rpc` gives it. */
export function isTagged<T extends string>(e: unknown, tag: T): e is { readonly _tag: T } {
  return typeof e === "object" && e !== null && "_tag" in e && e._tag === tag
}
