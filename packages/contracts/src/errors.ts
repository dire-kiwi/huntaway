import { Schema } from "effect"

// The errors that cross the wire (docs/plan/03-domain.md, Errors that cross the wire): a small closed set, so a client
// can handle any call the same way. Services fail with more specific errors; RPC handlers map them to these.

/** A thing that does not exist: "task … not found". Was 404. */
export class NotFound extends Schema.TaggedError<NotFound, { readonly brand: unique symbol }>()("NotFound", { what: Schema.String, id: Schema.String }) {}

/** A request that is wrong, shown beside its field. Was 400 and the 422 texts. */
export class Invalid extends Schema.TaggedError<Invalid, { readonly brand: unique symbol }>()("Invalid", { field: Schema.String, reason: Schema.String }) {}

/** What a client may react to when a request conflicts with the board's state (the fix it can offer). */
export const ConflictReason = Schema.Literals([
  "agent_running",
  "worktree_made",
  "merging",
  "todos_unfinished",
  "pr_not_approved",
  "changed_meanwhile",
  "has_session",
  "archived",
  "already_running",
  "not_pending",
  "moved_on",
  "duplicate_name",
  "restart_in_progress",
  "in_use",
  "worktree_kept",
  // Fix broken checks (4.5): the pull request is merged or closed, or none of its checks failed.
  "pr_not_open",
  "nothing_failed",
])
export type ConflictReason = typeof ConflictReason.Type

/** Was 409. `reason` is what the UI keys its offer on; `detail` is what it shows. */
export class Conflict extends Schema.TaggedError<Conflict, { readonly brand: unique symbol }>()("Conflict", {
  reason: ConflictReason,
  detail: Schema.String,
}) {}

/** The session lacks the scope the method needs. Was 403. */
export class Forbidden extends Schema.TaggedError<Forbidden, { readonly brand: unique symbol }>()("Forbidden", { scope: Schema.String }) {}

/** No session, or a wrong token: the token screen. Was 401. */
export class Unauthorized extends Schema.TaggedError<Unauthorized, { readonly brand: unique symbol }>()("Unauthorized", {}) {}

/** A linked host that is not connected. Was 503 from the proxy. */
export class HostOffline extends Schema.TaggedError<HostOffline, { readonly brand: unique symbol }>()("HostOffline", {
  host_id: Schema.String,
  host_name: Schema.String,
}) {}

/** A linked host that refused the hub. Was 502 from the proxy. */
export class HostRefused extends Schema.TaggedError<HostRefused, { readonly brand: unique symbol }>()("HostRefused", {
  host_id: Schema.String,
  reason: Schema.String,
}) {}

/** Something this host cannot do now: no tmux, no gh, agents can't run here, a peer that needs an update. Was 503. */
export class Unavailable extends Schema.TaggedError<Unavailable, { readonly brand: unique symbol }>()("Unavailable", {
  what: Schema.String,
  reason: Schema.String,
}) {}

/** A service outside the board failed: Asana, GitHub, a docs site. Was 502. */
export class External extends Schema.TaggedError<External, { readonly brand: unique symbol }>()("External", {
  service: Schema.String,
  reason: Schema.String,
}) {}
