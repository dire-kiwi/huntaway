import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { LinkHello, LinkRefused, OpenStream } from "../link.ts"
import { Auth, RequiredScope } from "../session.ts"
import { RemoteToolCall, ToolOutcome } from "./tools.ts"

/** A board tool call a host offers the hub that dialled it, on `link.upcalls`; `id` pairs it with its `link.upcallResult`. */
export const UpCall = Schema.Struct({ id: Schema.Int, ...RemoteToolCall.fields, call_id: Schema.String })
export interface UpCall extends Schema.Schema.Type<typeof UpCall> {}

/** The hub's answer to an `UpCall`. */
export const UpCallResult = Schema.Struct({ id: Schema.Int, outcome: ToolOutcome })
export interface UpCallResult extends Schema.Schema.Type<typeof UpCallResult> {}

/**
 * Hosts talking to each other (docs/plan/08-hosts.md, A link is a control connection). Every method needs `link`: a
 * hub's own connection to a host it dials (a sealed session of kind `link`), or a host that dialled in (the hub token).
 */
export class LinkRpcs extends RpcGroup.make(
  /** Both directions: who are you, what do you speak. Part of the stable core. */
  Rpc.make("link.hello", { payload: LinkHello, success: LinkHello, error: LinkRefused }).annotate(RequiredScope, "link"),
  /**
   * A host that dialled in (with the hub token) keeps this open, saying who it is; the hub asks for sockets through it.
   * Refused under an id already connected, or one the hub dials as a profile's assistant host.
   */
  Rpc.make("link.attach", { payload: LinkHello, success: OpenStream, error: LinkRefused, stream: true }).annotate(RequiredScope, "link"),
  /**
   * A hub that dialled this host keeps this open, saying who it is: the board tool calls this host's agents pass up to
   * it (7.4). Only on the hub's own connection (a sealed session of kind `link` from that hub).
   */
  Rpc.make("link.upcalls", { payload: LinkHello, success: UpCall, error: LinkRefused, stream: true }).annotate(RequiredScope, "link"),
  /** The hub's answer to a call it took on `link.upcalls`. */
  Rpc.make("link.upcallResult", { payload: UpCallResult }).annotate(RequiredScope, "link"),
).middleware(Auth) {}
