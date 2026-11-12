import { callHub, type CallError, localHostIdAtom, type Methods, mutate } from "@huntaway/client"
import { Cause, Effect, Exit } from "effect"
import { Atom, type AtomRegistry } from "effect/reactivity"
import { useCallback } from "react"
import { type ActionState, runExit, useAction } from "../../../state/mutation"

// What the Hosts settings ask of the hub (the page's own server): the old `api.addHost`, `renameHost` and the like. The
// hub's reads are the client's query atoms (`hubSshKeyAtom`, `hubJoinAtom`, `nearbyHostsAtom`); its directory
// (`hub.hosts.watch`) shows what a change did.

/**
 * Calls a `hub.hosts.*` method on the hub as a change: on its host id once known (its group's queries there are read
 * again), else on the page's own server, which is the hub.
 */
export const hubMutate = <M extends keyof Methods>(
  method: M,
  payload: Methods[M]["payload"],
): Effect.Effect<Methods[M]["success"], CallError<M>, AtomRegistry.AtomRegistry> =>
  Effect.flatMap(Atom.get(localHostIdAtom), (hub) => (hub === null ? callHub(method, payload) : mutate(method, hub, payload)))

/** `const [state, link] = useHubMutation("hub.hosts.add")`: a hub method as the component's own action (`useMutation`). */
export function useHubMutation<M extends keyof Methods>(
  method: M,
): readonly [ActionState, (payload: Methods[M]["payload"]) => Promise<Exit.Exit<Methods[M]["success"], CallError<M>>>] {
  const [state, run] = useAction()
  const call = useCallback((payload: Methods[M]["payload"]) => run(hubMutate(method, payload)), [method, run])
  return [state, call]
}

/** An exit as a promise that rejects with its failure, for what shows a rejection (a confirm dialog's `onConfirm`). */
export const orReject = <A, E>(exit: Exit.Exit<A, E>): Promise<A> =>
  Exit.isSuccess(exit) ? Promise.resolve(exit.value) : Promise.reject(Cause.squash(exit.cause))

/** Calls a hub method and gives its answer as a promise that rejects with the tagged error (`hubMutate`). */
export function hubRpc<M extends keyof Methods>(method: M, payload: Methods[M]["payload"]): Promise<Methods[M]["success"]> {
  return runExit(hubMutate(method, payload)).then(orReject)
}
