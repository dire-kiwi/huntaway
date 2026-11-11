import { Context, Effect, Layer } from "effect"
import type { RemoteToolCall, ToolOutcome } from "@huntaway/contracts"

// The other hosts a board tool call can go to (docs/plan/08-hosts.md, Board tools across hosts; inventory 03 §2.3):
// what `ToolCalls` needs of the hosts area, which is built after it (06-server.md, Dependency order). `hosts/Uplink.ts`
// implements it over the live links and the hubs; `layerNone` (a host linked to nothing) is for tests.

/** A host a call can be passed to: its id and name, and how a call gets there. */
export interface OtherHost {
  readonly id: string
  readonly name: string
  /**
   * Runs `call` there: its outcome. A host that can't be reached is an `Err` (not "not found"). A hub that doesn't take
   * this host's calls answers `Off`; one that went quiet after the call went up says it may or may not have taken effect.
   */
  readonly call: (call: RemoteToolCall) => Effect.Effect<ToolOutcome>
}

export interface OtherHostsShape {
  /** The linked hosts connected now (down: this host is their hub), in the order they are asked. */
  readonly links: Effect.Effect<ReadonlyArray<OtherHost>>
  /**
   * The hubs that take this host's agents' calls now (up): those it dialled in to, and those that dialled it and hold
   * `link.upcalls` open, but not a hub it links itself (that one is asked down, with its token).
   */
  readonly hubs: Effect.Effect<ReadonlyArray<OtherHost>>
}

export class OtherHosts extends Context.Service<OtherHosts, OtherHostsShape>()("huntaway-server/mcp/OtherHosts") {
  /** No other host. */
  static readonly layerNone = Layer.succeed(OtherHosts, OtherHosts.of({ links: Effect.succeed([]), hubs: Effect.succeed([]) }))
}
