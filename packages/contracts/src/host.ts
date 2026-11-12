import { Schema } from "effect"
import { HostId, LinkId } from "./ids.ts"
import { PermissionMode } from "./task.ts"
import { Timestamp } from "./time.ts"

// What a host says of itself, its agent defaults, and the hub's view of the hosts it shows (huntaway's
// apps/server/src/wire/server.ts, wire/terminal.ts and packages/client/src/hosts.ts). The API version numbers
// (`api_version`, `api_compat`) are replaced by `protocol` and `version`; named capabilities stay.

/** A host's, profile's or reviewer's default effort: a thread's own can also be `minimal` or `ultra` (`Effort`). */
export const HostEffort = Schema.Literals(["low", "medium", "high", "xhigh", "max"])
export type HostEffort = typeof HostEffort.Type

/** A TUI program offered as a shortcut in task terminals, e.g. `lazygit`. */
export const TerminalTool = Schema.Struct({ id: Schema.String, name: Schema.String, command: Schema.String })
export interface TerminalTool extends Schema.Schema.Type<typeof TerminalTool> {}

/** A host's agent defaults and settings (`settings.get`). */
export const HostSettings = Schema.Struct({
  /** Used when the thread, project and profile pick none. */
  default_model: Schema.NullOr(Schema.String),
  default_effort: Schema.NullOr(HostEffort),
  /** Used when the thread and project pick none; null is `default`. */
  default_permission_mode: Schema.NullOr(PermissionMode),
  /** On a host that cannot run agents: the linked host its scratch tasks go to. */
  scratch_host: Schema.NullOr(LinkId),
  terminal_tools: Schema.Array(TerminalTool),
  /** Where the host is reached from outside, which webhook and document URLs are given with. */
  public_url: Schema.NullOr(Schema.String),
  /** Release checks include prereleases. */
  release_prereleases: Schema.Boolean,
  /** Keep this host's settings the same as the board's other hosts that have this on. */
  settings_sync: Schema.Boolean,
})
export interface HostSettings extends Schema.Schema.Type<typeof HostSettings> {}

/** What `settings.update` takes: each field optional; null or blank text clears a setting. */
export const HostSettingsPatch = Schema.Struct({
  default_model: Schema.optional(Schema.NullOr(Schema.String)),
  default_effort: Schema.optional(Schema.NullOr(HostEffort)),
  default_permission_mode: Schema.optional(Schema.NullOr(PermissionMode)),
  scratch_host: Schema.optional(Schema.NullOr(LinkId)),
  /** The whole list; a new tool gets an id. */
  terminal_tools: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.optional(Schema.String), name: Schema.String, command: Schema.String }))),
  public_url: Schema.optional(Schema.NullOr(Schema.String)),
  /** Changing it checks for releases again. */
  release_prereleases: Schema.optional(Schema.Boolean),
  settings_sync: Schema.optional(Schema.Boolean),
})
export interface HostSettingsPatch extends Schema.Schema.Type<typeof HostSettingsPatch> {}

/** Where a host updates from: its source checkout, or GitHub's releases. */
export const UpdatesFrom = Schema.Literals(["checkout", "releases"])
export type UpdatesFrom = typeof UpdatesFrom.Type

/** What a host says of itself without a token (`GET /api/health`): read by the desktop shell, discovery and deploy checks. */
export const Health = Schema.Struct({
  ok: Schema.Literal(true),
  host_id: HostId,
  version: Schema.String,
  /** The protocol it speaks. */
  protocol: Schema.Int,
  /** Its named capabilities. */
  capabilities: Schema.Array(Schema.String),
  /** The commit it runs, if it runs from a checkout. */
  commit: Schema.NullOr(Schema.String),
})
export interface Health extends Schema.Schema.Type<typeof Health> {}

/** What a host says of itself to its hub and its board. */
export const HostInfo = Schema.Struct({
  host_id: HostId,
  host_name: Schema.String,
  /** Which build it runs. */
  build_id: Schema.String,
  version: Schema.String,
  protocol: Schema.Int,
  capabilities: Schema.Array(Schema.String),
  /** A rehearsal: a server over an imported copy of the old board, which changes nothing outside its data folder. */
  read_only: Schema.Boolean,
  /**
   * On a rehearsal (`read_only`), the board it is a copy of: the old server's data folder it was imported from, and when
   * (9.1; docs/plan/11-migration.md, Rehearsal). Absent elsewhere, and from hosts older than it.
   */
  rehearsal: Schema.optional(Schema.Struct({ from: Schema.String, imported_at: Timestamp })),
  commit: Schema.NullOr(Schema.String),
  updates_from: Schema.NullOr(UpdatesFrom),
  /** It can run agents, and which agents' CLIs it has. */
  agents: Schema.Boolean,
  agent_clis: Schema.Array(Schema.String),
  data_dir: Schema.String,
  /** The machine's name, and the home folder of the user it runs as. */
  hostname: Schema.String,
  home: Schema.NullOr(Schema.String),
})
export interface HostInfo extends Schema.Schema.Type<typeof HostInfo> {}

/**
 * A machine running Huntaway, as the hub shows it: itself (`local`) or a linked host. Every profile, project and task
 * lives on exactly one. What a linked host says of itself is null until it has connected.
 */
export const Host = Schema.Struct({
  id: HostId,
  name: Schema.String,
  /** The host the board is served from. */
  local: Schema.Boolean,
  connected: Schema.Boolean,
  /** `outbound`: the hub connects to it; `inbound`: it dials the hub; `ssh`: the hub starts it and tunnels to it. */
  mode: Schema.Literals(["local", "outbound", "inbound", "ssh"]),
  /** It can run agents (false for a hub that only shows other hosts). */
  agents: Schema.NullOr(Schema.Boolean),
  url: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.String),
  protocol: Schema.NullOr(Schema.Int),
  capabilities: Schema.Array(Schema.String),
  commit: Schema.NullOr(Schema.String),
  updates_from: Schema.NullOr(UpdatesFrom),
  last_seen: Schema.NullOr(Timestamp),
  /** When the hub last heard from it; pings keep a connected host's within about 20 seconds. */
  last_message_at: Schema.NullOr(Timestamp),
  /** Its agents may use this board's tools, up the link. */
  uplink: Schema.Boolean,
  /** The link's live state (M7); absent from a host's own entry. */
  status: Schema.optional(Schema.Literals(["connecting", "connected", "offline", "needs_update", "refused"])),
  /** Why it is `offline` or `refused`, to show beside it. */
  status_reason: Schema.optional(Schema.NullOr(Schema.String)),
})
export interface Host extends Schema.Schema.Type<typeof Host> {}
