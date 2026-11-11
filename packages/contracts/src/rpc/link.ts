import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { LinkHello, LinkRefused, OpenStream } from "../link.ts"
import { Auth, RequiredScope } from "../session.ts"

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
  /** Board tool calls from this host's agents, for the hub that dialled it and said hello (7.4). */
  Rpc.make("link.upcalls", { success: Schema.Unknown, stream: true }).annotate(RequiredScope, "link"),
).middleware(Auth) {}
