import { Context, Effect, type Stream } from "effect"
import { Atom, type AtomRegistry } from "effect/reactivity"
import type { Rpc, RpcClient, RpcClientError } from "effect/rpc"
import { HostId, type Unavailable } from "@huntaway/contracts"
import { type ClientRpcs, HostClient } from "./session/HostClient.ts"
import { hostRuntime, hubRuntime } from "./session/sessions.ts"

type ByTag<K extends string> = Rpc.ExtractTag<ClientRpcs, K>

/** The RPCs that answer once (the streams have their own atoms). */
type Callable = {
  readonly [K in ClientRpcs["_tag"]]: Rpc.Success<ByTag<K>> extends Stream.Stream<infer _A, infer _E, infer _R> ? never : K
}[ClientRpcs["_tag"]]

/** What calling `M` gives: the RPC client's own type for it. */
type CallResult<M extends Callable> = RpcClient.RpcClient.Result<ByTag<M>, RpcClientError.RpcClientError, false, false>

/**
 * Every method a host answers once, with what it takes, gives and fails with (derived from the contract). `error`
 * includes the session's (`Unauthorized`, `Forbidden`) and the connection's (`RpcClientError`).
 */
export type Methods = {
  readonly [K in Callable]: {
    readonly payload: Rpc.PayloadConstructor<ByTag<K>>
    readonly success: Effect.Success<CallResult<K>>
    readonly error: Effect.Error<CallResult<K>>
  }
}

/** What any method answers, and fails with. */
export type AnySuccess = Methods[keyof Methods]["success"]
export type AnyError = Methods[keyof Methods]["error"]

/** What a call can fail with: its own errors, the session's and the connection's, and a host that cannot be reached. */
export type CallError<M extends keyof Methods> = Methods[M]["error"] | Unavailable

/**
 * Calls `method` on `host` (a host id) over its session, waiting for the session's runtime to be built. A mutation's
 * answer is not written into the board: the event that follows it is.
 */
export const callRpc = <M extends keyof Methods>(
  host: string,
  method: M,
  payload: Methods[M]["payload"],
): Effect.Effect<Methods[M]["success"], CallError<M>, AtomRegistry.AtomRegistry> => callOn(hostRuntime(HostId.make(host)), method, payload)

/** Calls `method` on the page's own server (the hub): for what is asked before its host id is known (`public.openToken`). */
export const callHub = <M extends keyof Methods>(
  method: M,
  payload: Methods[M]["payload"],
): Effect.Effect<Methods[M]["success"], CallError<M>, AtomRegistry.AtomRegistry> => callOn(hubRuntime, method, payload)

const callOn = <M extends keyof Methods>(
  runtime: Atom.AtomRuntime<HostClient, Unavailable>,
  method: M,
  payload: Methods[M]["payload"],
): Effect.Effect<Methods[M]["success"], CallError<M>, AtomRegistry.AtomRegistry> =>
  Effect.flatMap(Atom.getResult(runtime, { suspendOnWaiting: true }), (context) => callWith(Context.get(context, HostClient), method, payload))

/**
 * Calls a method chosen at run time on the host whose runtime this runs in (a query's atom, keyed by method and
 * payload): its answer is the method's, which the query's typed accessor names.
 */
export const callOnClient = (method: keyof Methods, payload: unknown): Effect.Effect<AnySuccess, AnyError, HostClient> =>
  Effect.gen(function* () {
    const client: unknown = yield* HostClient
    return yield* isLooseCall(client) ? client(method, payload) : Effect.die(new Error("the host's RPC client is not a function"))
  })

const callWith = <M extends keyof Methods>(
  client: unknown,
  method: M,
  payload: Methods[M]["payload"],
): Effect.Effect<Methods[M]["success"], Methods[M]["error"]> =>
  isCall(client) ? client(method, payload) : Effect.die(new Error("the host's RPC client is not a function"))

/** The flat client, for a method chosen at run time. */
type Call = <M extends keyof Methods>(method: M, payload: Methods[M]["payload"]) => Effect.Effect<Methods[M]["success"], Methods[M]["error"]>

/**
 * The flat client answers every method, but its type is a union of signatures that a method chosen at run time cannot
 * pick from; `Call` is the same, per method (both are derived from the contract).
 */
const isCall = (client: unknown): client is Call => typeof client === "function"

/** The same, for a method and payload that are only known at run time (the payload is checked by the client's schema). */
const isLooseCall = (client: unknown): client is (method: keyof Methods, payload: unknown) => Effect.Effect<AnySuccess, AnyError> =>
  typeof client === "function"
