// Versions between hosts and clients (docs/plan/05-protocol.md, Versions).

/**
 * The RPC protocol's number, checked in `public.health` and `link.hello`. It changes only when RPC framing or the
 * meaning of an existing method changes; schemas otherwise change by adding.
 */
export const PROTOCOL = 1

/** A capability is a name a host reports in `host.info`, for a feature only some hosts can do. */
export const Capability = {
  /** The board is a read-only rehearsal of an import. */
  readOnly: "read_only",
  /** It takes part in settings sync (`settingsSync.*`) when switched on. */
  settingsSync: "settings_sync",
} as const
export type Capability = (typeof Capability)[keyof typeof Capability]
