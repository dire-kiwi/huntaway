import type { Methods } from "@huntaway/client"
import { Cause } from "effect"
import { AsyncResult } from "effect/reactivity"
import { board } from "../../../state/board"
import { rpc } from "../../../state/rpc"
import { errorText } from "../../ui"

// What the Hosts settings ask of the hub (the page's own server): the old `api.addHost`, `renameHost` and the like.

/** Calls a `hub.hosts.*` method on the board's own host, the hub. Rejects with the tagged error, as `rpc` does. */
export function hubRpc<M extends keyof Methods>(method: M, payload: Methods[M]["payload"]): Promise<Methods[M]["success"]> {
  const hub = board.get().localHostId
  return hub === null ? Promise.reject(new Error("This board's own host isn't known yet.")) : rpc(hub, method, payload)
}

/** A query's value, once it has one. */
export const valueOf = <A, E>(result: AsyncResult.AsyncResult<A, E>): A | null => (AsyncResult.isSuccess(result) ? result.value : null)

/** A query's failure, as text to show. */
export const failureOf = <A, E>(result: AsyncResult.AsyncResult<A, E>): string | null =>
  AsyncResult.isFailure(result) ? errorText(Cause.squash(result.cause)) : null
