import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Conflict, HostOffline, HostRefused, Invalid, NotFound, Unavailable } from "../errors.ts"
import { Host } from "../host.ts"
import { HostId, LinkId } from "../ids.ts"
import { Auth, RequiredScope } from "../session.ts"

// What a server adds as the board a client opened (docs/plan/05-protocol.md, `hub.hosts`): the directory of hosts,
// linking, and the relay to the others.

/** Link a host that this one can reach: its URL and its board token. */
export const AddHost = Schema.Struct({ url: Schema.String, token: Schema.String })

/** Link a host over SSH: `user@host`, its SSH port (22) and the port its server listens on there (7879). */
export const AddSshHost = Schema.Struct({ target: Schema.String, ssh_port: Schema.optional(Schema.Int), remote_port: Schema.optional(Schema.Int) })

/** What a host needs to dial in to this hub, given the URL the browser reaches it at. */
export const JoinInfo = Schema.Struct({ hub_token: Schema.String, host_token: Schema.String, command: Schema.String })
export interface JoinInfo extends Schema.Schema.Type<typeof JoinInfo> {}

/** A host found nearby (mDNS, Tailscale) or through a linked host's own links. */
export const FoundHost = Schema.Struct({
  host_id: Schema.NullOr(HostId),
  name: Schema.String,
  url: Schema.String,
  via: Schema.Literals(["lan", "tailscale", "mesh"]),
  /** For `mesh`: the linked host that links it. */
  through: Schema.optional(Schema.String),
  version: Schema.NullOr(Schema.String),
  /** The RPC protocol it speaks (`PROTOCOL`): its mDNS record's or its health's; null when neither said. */
  protocol: Schema.NullOr(Schema.Int),
  /** Its capabilities as its health gave them; null for one heard over mDNS only (the record has no room for them). */
  capabilities: Schema.NullOr(Schema.Array(Schema.String)),
  /** Linked here already (by its id, or by its URL). */
  linked: Schema.Boolean,
})
export interface FoundHost extends Schema.Schema.Type<typeof FoundHost> {}

/** Copy an agent config's login and settings (or a profile's config) from one host to another. */
export const CopyConfig = Schema.Struct({
  from_host: HostId,
  to_host: HostId,
  config: Schema.optional(Schema.String),
  profile: Schema.optional(Schema.String),
  config_dir: Schema.optional(Schema.String),
  overwrite: Schema.optional(Schema.Boolean),
})

export class HubHostRpcs extends RpcGroup.make(
  /** This host and every linked host, with their live state; again on every change. */
  Rpc.make("hub.hosts.watch", { success: Schema.Array(Host), stream: true }).annotate(RequiredScope, "read"),
  Rpc.make("hub.hosts.list", { success: Schema.Array(Host) }).annotate(RequiredScope, "read"),
  /** Link a host by URL and token: it is asked who it is first. */
  Rpc.make("hub.hosts.add", { payload: AddHost, success: Host, error: Invalid }).annotate(RequiredScope, "admin"),
  Rpc.make("hub.hosts.addSsh", {
    payload: AddSshHost,
    success: Schema.Struct({ id: HostId, name: Schema.String, started: Schema.NullOr(Schema.Boolean) }),
    error: Schema.Union([Invalid, Unavailable]),
  }).annotate(RequiredScope, "admin"),
  /** The hub's SSH public key, for a host's `authorized_keys`. */
  Rpc.make("hub.hosts.sshKey", { success: Schema.Struct({ public_key: Schema.String }), error: Unavailable }).annotate(RequiredScope, "admin"),
  /** What a host needs to dial in: `url` is where the browser reaches this hub. */
  Rpc.make("hub.hosts.join", { payload: { url: Schema.String }, success: JoinInfo }).annotate(RequiredScope, "admin"),
  Rpc.make("hub.hosts.discover", {
    success: Schema.Struct({ tailscale: Schema.Boolean, hosts: Schema.Array(FoundHost) }),
    error: Unavailable,
  }).annotate(RequiredScope, "admin"),
  /** Rename a link, or let its agents use this board's tools (or not). */
  Rpc.make("hub.hosts.update", {
    payload: { id: LinkId, name: Schema.optional(Schema.String), uplink: Schema.optional(Schema.Boolean) },
    error: NotFound,
  }).annotate(RequiredScope, "admin"),
  /** Forget a link; its data stays on that host. */
  Rpc.make("hub.hosts.remove", { payload: { id: LinkId } }).annotate(RequiredScope, "admin"),
  Rpc.make("hub.hosts.copyConfig", {
    payload: CopyConfig,
    success: Schema.Struct({ ok: Schema.Boolean, files: Schema.NullOr(Schema.Int) }),
    error: Schema.Union([Invalid, NotFound, HostOffline, Unavailable]),
  }).annotate(RequiredScope, "admin"),
  /**
   * A single-use ticket, good for a minute, for `/api/relay/<ticket>`: a socket to that host's `path` (`/api/rpc`, the
   * default, or a terminal's), carrying this session's scopes.
   */
  Rpc.make("hub.hosts.openRelay", {
    payload: { host_id: HostId, path: Schema.optional(Schema.String) },
    success: Schema.Struct({ ticket: Schema.String }),
    error: Schema.Union([NotFound, Invalid, HostOffline, HostRefused, Conflict]),
  }).annotate(RequiredScope, "read"),
).middleware(Auth) {}

/** What a server adds as the board a client opened: the directory of hosts (push subscriptions and devices come later). */
export const HubRpcs = HubHostRpcs
