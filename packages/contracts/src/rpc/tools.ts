import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Auth, RequiredScope } from "../session.ts"

// Board tools across hosts (docs/plan/08-hosts.md, Board tools across hosts; inventory 03 §2.3, 05 §9). An agent's
// board tool call that names something on another host goes there as `tools.call`: down, from a hub to a host it links
// (the hub's own sealed session), or up, from a host that dialled in to its hub (the hub token, on the connection that
// holds `link.attach`). A hub that dialled a host takes that host's calls up on `link.upcalls` instead.

/** How a board tool call on another host came out: its result, why it failed, or (up-calls) why the hub didn't take it. */
export const ToolOutcome = Schema.Union([
  Schema.TaggedStruct("Ok", { value: Schema.Unknown }),
  /** The agent's message, final as it is told it; `not_found`: what it names isn't there (other hosts may have it). */
  Schema.TaggedStruct("Err", { message: Schema.String, not_found: Schema.Boolean }),
  /** The hub doesn't take this host's agents' calls, or not in the caller's profile: its reason (null: the switch is off). */
  Schema.TaggedStruct("Off", { why: Schema.NullOr(Schema.String) }),
])
export type ToolOutcome = typeof ToolOutcome.Type

/** A board tool call for another host, as an agent made it: its profile's name, the tool and its arguments. */
export const RemoteToolCall = Schema.Struct({
  /** The name of the caller's profile on its own host: profiles are matched across hosts by name. */
  profile: Schema.String,
  tool: Schema.String,
  args: Schema.Unknown,
  /** The agent's call id (up-calls: the hub runs each at most once by it), or null for a call down a link. */
  call_id: Schema.NullOr(Schema.String),
})
export interface RemoteToolCall extends Schema.Schema.Type<typeof RemoteToolCall> {}

export class ToolRpcs extends RpcGroup.make(
  /**
   * Runs a board tool call of another host's agent here. `up: false`: from a hub (its own sealed session), here only.
   * `up: true`: from a host that dialled in, taken only as the link's `uplink` switch and the profile's assistant host
   * allow, at most once per call id, and never passed back down to that host nor further up.
   */
  Rpc.make("tools.call", { payload: Schema.Struct({ ...RemoteToolCall.fields, up: Schema.Boolean }), success: ToolOutcome }).annotate(RequiredScope, "link"),
).middleware(Auth) {}
