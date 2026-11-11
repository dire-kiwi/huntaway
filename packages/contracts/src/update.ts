import { Schema } from "effect"
import { UpdatesFrom } from "./host.ts"

// Restarts, updates, releases and the service (docs/plan/05-protocol.md, `admin`; huntaway's wire/server.ts and
// update/*.ts). `admin.status` and `admin.update` are part of the stable core a hub calls on a host of another
// version, so `ServerStatus` and `UpdateResult` only ever grow: a new field is optional.

/** What a restart (or an update, a release download it follows, a service install) is doing. */
export const RestartPhase = Schema.Literals(["starting", "building_ui", "building_server", "downloading", "verifying", "installing", "restarting", "failed"])
export type RestartPhase = typeof RestartPhase.Type

/** The one restart job of this server: its phase, the tail of its log, and why it failed. */
export const RestartJob = Schema.Struct({ phase: RestartPhase, log: Schema.String, error: Schema.NullOr(Schema.String) })
export interface RestartJob extends Schema.Schema.Type<typeof RestartJob> {}

/** What `--update-from`'s deployment said when last asked. */
export const Deployed = Schema.Struct({
  /** The commit it runs (kept from an earlier check while it can't be reached). */
  commit: Schema.NullOr(Schema.String),
  checked_at: Schema.String,
  error: Schema.NullOr(Schema.String),
})
export interface Deployed extends Schema.Schema.Type<typeof Deployed> {}

/** A release's file on GitHub. `sha256` is the digest GitHub lists, when it lists one. */
export const ReleaseAsset = Schema.Struct({ name: Schema.String, url: Schema.String, size: Schema.Finite, sha256: Schema.NullOr(Schema.String) })
export interface ReleaseAsset extends Schema.Schema.Type<typeof ReleaseAsset> {}

/** The release the last check picked. */
export const ReleaseLatest = Schema.Struct({
  version: Schema.String,
  prerelease: Schema.Boolean,
  published_at: Schema.NullOr(Schema.String),
  notes: Schema.NullOr(Schema.String),
  url: Schema.String,
  /** Its server tarball for this platform. */
  asset: ReleaseAsset,
  /** Newer than this server. */
  newer: Schema.Boolean,
})
export interface ReleaseLatest extends Schema.Schema.Type<typeof ReleaseLatest> {}

/** The desktop app that started this server, and whether the latest release needs a new package of it. */
export const DesktopShell = Schema.Struct({
  version: Schema.NullOr(Schema.String),
  /** `pacman`, `appimage`, `mac` or `other`. */
  install: Schema.String,
  path: Schema.NullOr(Schema.String),
  outdated: Schema.Boolean,
  package: Schema.NullOr(ReleaseAsset),
})
export interface DesktopShell extends Schema.Schema.Type<typeof DesktopShell> {}

/** A release's download in the background (a staged one is reported as `staged` instead). */
export const ReleaseDownload = Schema.Struct({
  version: Schema.String,
  phase: Schema.Literals(["downloading", "verifying", "installing", "failed"]),
  bytes: Schema.Finite,
  total: Schema.NullOr(Schema.Finite),
  error: Schema.NullOr(Schema.String),
})
export interface ReleaseDownload extends Schema.Schema.Type<typeof ReleaseDownload> {}

/** `admin.status`'s `release`, with `--release-updates`. */
export const ReleaseStatus = Schema.Struct({
  repo: Schema.String,
  /** The version this server runs. */
  running: Schema.String,
  /** Where it runs from: `<data dir>/app/<v>/huntaway`, the desktop app's own server, or a tarball's. */
  exe: Schema.NullOr(Schema.String),
  latest: Schema.NullOr(ReleaseLatest),
  prereleases: Schema.Boolean,
  checked_at: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  rate_limit_reset: Schema.NullOr(Schema.String),
  shell: Schema.NullOr(DesktopShell),
  bundled_server: Schema.NullOr(Schema.String),
  /** Downloaded and checked, for Update to restart onto. */
  staged: Schema.NullOr(Schema.String),
  download: Schema.NullOr(ReleaseDownload),
  previous: Schema.NullOr(Schema.String),
  /** Versions rolled back from or that didn't start: not offered again. */
  bad: Schema.Array(Schema.String),
  /** What Roll back would start: a version, `bundled` (the server the host was installed as), or null. */
  rollback_to: Schema.NullOr(Schema.String),
})
export interface ReleaseStatus extends Schema.Schema.Type<typeof ReleaseStatus> {}

/** The systemd user service this host could run as (Linux with systemd, not under the desktop app). */
export const ServiceStatus = Schema.Struct({
  unit: Schema.String,
  /** The unit file. */
  path: Schema.String,
  installed: Schema.Boolean,
  /** Started at boot (or at login, without lingering). */
  enabled: Schema.Boolean,
  /** This server runs as that service. */
  running: Schema.Boolean,
  /** Another systemd service this server runs as (`<unit>`, or `<unit> (system)`). */
  other: Schema.NullOr(Schema.String),
  /** Lingering is on, so the user's services start at boot. */
  linger: Schema.Boolean,
  user: Schema.String,
})
export interface ServiceStatus extends Schema.Schema.Type<typeof ServiceStatus> {}

/** `admin.status`: this server process, its restart job, and what it could update to. Part of the stable core. */
export const ServerStatus = Schema.Struct({
  boot_id: Schema.String,
  started_at: Schema.String,
  version: Schema.String,
  updates_from: Schema.NullOr(UpdatesFrom),
  /** The repository root it rebuilds from, if any. */
  source_dir: Schema.NullOr(Schema.String),
  /** The commit this process runs. */
  running_commit: Schema.NullOr(Schema.String),
  running_agents: Schema.Finite,
  restart: Schema.NullOr(RestartJob),
  /** With a checkout: its HEAD now, its branch, uncommitted changes, and the commits since the running one (max 30). */
  source_commit: Schema.optional(Schema.NullOr(Schema.String)),
  source_branch: Schema.optional(Schema.NullOr(Schema.String)),
  dirty: Schema.optional(Schema.Boolean),
  new_commits: Schema.optional(Schema.Array(Schema.String)),
  /** With `--update-from`: the deployment, what it runs, and its commits this host doesn't (when it is ahead). */
  update_from: Schema.optional(Schema.String),
  deployed: Schema.optional(Schema.NullOr(Deployed)),
  deployed_commits: Schema.optional(Schema.Array(Schema.String)),
  /** With `--release-updates`. */
  release: Schema.optional(ReleaseStatus),
  /** Where systemd user services run. */
  service: Schema.optional(ServiceStatus),
})
export interface ServerStatus extends Schema.Schema.Type<typeof ServerStatus> {}

/**
 * What a hub sends a host to update it (`admin.update`), by what the hub is: a checkout sends its `branch`, `commit` and
 * the commits the host lacks as a git `bundle` (base64); a deployment without a checkout its `commit`, which the host
 * fetches from its own origin; and every hub its `version`, which a host installed from a release updates to.
 */
export const UpdateRequest = Schema.Struct({
  commit: Schema.optional(Schema.String),
  bundle: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
})
export interface UpdateRequest extends Schema.Schema.Type<typeof UpdateRequest> {}

/** A host's answer to `admin.update`: started (to `commit` or `version`), or nothing to do. Part of the stable core. */
export const UpdateResult = Schema.Struct({
  ok: Schema.Literal(true),
  up_to_date: Schema.optional(Schema.Boolean),
  commit: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
})
export interface UpdateResult extends Schema.Schema.Type<typeof UpdateResult> {}
