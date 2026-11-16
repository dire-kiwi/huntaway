import { Schema } from "effect"
import { AgentConfigId, ProfileId } from "./ids.ts"
import { Timestamp } from "./time.ts"

// Spaces (HE-35, after Cua Spaces): Linux desktops in Docker containers on a host, each running Cua's spacesd (its
// desktop, Cua Driver and an H.264 stream of its screen), with the host's Claude Code and Codex sign-ins copied in.
// The board shows a Space's desktop through spacesd's own viewer, relayed by the host's server (or straight from the
// container where the board can reach it).

/** Where a Space is: being made (pulling or building its image, starting, copying sign-ins), up, stopped, or broken. */
export const SpaceState = Schema.Literals(["preparing", "running", "stopped", "failed"])
export type SpaceState = typeof SpaceState.Type

export const Space = Schema.Struct({
  /** The container's name without its `huntaway-space-` prefix. */
  id: Schema.String,
  name: Schema.String,
  /** The image it runs. */
  image: Schema.String,
  state: SpaceState,
  /** Docker's word for it ("Up 3 minutes"), what a preparing Space is doing, or why it failed. */
  detail: Schema.NullOr(Schema.String),
  /** Its spacesd port is published on every interface (a direct link), not only on 127.0.0.1 (the relay alone). */
  direct: Schema.Boolean,
  /** The configs whose sign-ins and settings it was given. */
  claude_config_id: Schema.NullOr(AgentConfigId),
  codex_config_id: Schema.NullOr(AgentConfigId),
  created_at: Timestamp,
})
export interface Space extends Schema.Schema.Type<typeof Space> {}

/** Whether the host can have Spaces, and the ones it has. */
export const SpacesStatus = Schema.Struct({
  docker: Schema.Struct({
    available: Schema.Boolean,
    /** The Docker engine's version. */
    version: Schema.NullOr(Schema.String),
    /** Why it isn't available. */
    reason: Schema.NullOr(Schema.String),
  }),
  /** HE-37: this host's agents get the `spaces` MCP server (from their next run). Off until the host's page turns it on. */
  agent_tools: Schema.Boolean,
  /** The image new Spaces are built on (Cua's Linux image with spacesd). */
  base_image: Schema.String,
  spaces: Schema.Array(Space),
})
export interface SpacesStatus extends Schema.Schema.Type<typeof SpacesStatus> {}

/** What `spaces.create` takes. */
export const NewSpace = Schema.Struct({
  name: Schema.String,
  /** A Claude Code config whose sign-in and settings go in; none when left out. */
  claude_config_id: Schema.optional(Schema.NullOr(AgentConfigId)),
  /** A Codex config's. */
  codex_config_id: Schema.optional(Schema.NullOr(AgentConfigId)),
  /** Publish spacesd's port on every interface, so a board that reaches the host can open the Space directly. */
  direct: Schema.optional(Schema.Boolean),
})
export interface NewSpace extends Schema.Schema.Type<typeof NewSpace> {}

/**
 * How to open a Space's viewer. The relay is `relay_path` on the host's own address, with `fragment` after it; the
 * direct link is `http://<the host's address>:<direct_port>/viewer/` with the same fragment. The fragment holds
 * spacesd's viewer ticket, which never reaches a server.
 */
export const SpaceView = Schema.Struct({
  relay_path: Schema.String,
  direct_port: Schema.NullOr(Schema.Int),
  fragment: Schema.String,
  expires_at: Timestamp,
})
export interface SpaceView extends Schema.Schema.Type<typeof SpaceView> {}

// HE-48: sign-ins for Spaces, after Cua's Keyvault and `request_site_login`. A profile keeps logins (a site's origin, a
// username, a password); when the user allows it, the host's server types one into a Space's browser through the
// Space's Cua Driver, on that origin only. The password goes to the server and never comes back: no answer has it.

/** A saved sign-in, without its password. */
export const SignIn = Schema.Struct({
  id: Schema.String,
  profile_id: ProfileId,
  /** The site it's for, `scheme://host[:port]`: it is typed only into a page on exactly this origin. */
  origin: Schema.String,
  /** Its sign-in page, as the user gave it (on `origin`): where the board opens the site to sign in. */
  login_url: Schema.String,
  username: Schema.String,
  /** What the user calls it, if anything. */
  label: Schema.NullOr(Schema.String),
  created_at: Timestamp,
  updated_at: Timestamp,
  last_used_at: Schema.NullOr(Timestamp),
})
export interface SignIn extends Schema.Schema.Type<typeof SignIn> {}

/** A password as it goes to the server: a plain string on the wire, `Redacted` once decoded (never logged or shown). */
export const Password = Schema.RedactedFromValue(Schema.String)

/** What `signIns.create` takes: the site's sign-in page (and so its origin), the username and the password. */
export const NewSignIn = Schema.Struct({
  profile_id: ProfileId,
  url: Schema.String,
  username: Schema.String,
  password: Password,
  label: Schema.optional(Schema.NullOr(Schema.String)),
})
export interface NewSignIn extends Schema.Schema.Type<typeof NewSignIn> {}

/** What `signIns.update` changes; a field left out stays. */
export const SignInChange = Schema.Struct({
  id: Schema.String,
  /** A new sign-in page; the sign-in is then for its origin. */
  url: Schema.optional(Schema.String),
  username: Schema.optional(Schema.String),
  password: Schema.optional(Password),
  label: Schema.optional(Schema.NullOr(Schema.String)),
})
export interface SignInChange extends Schema.Schema.Type<typeof SignInChange> {}

/** What signing in did: never the password. */
export const SignedIn = Schema.Struct({
  origin: Schema.String,
  /** The username, masked (`a***@example.com`). */
  username_hint: Schema.String,
  /** A submit button was found and clicked. */
  submitted: Schema.Boolean,
  /** Where the tab went: its origin and path, never its query or fragment. */
  page_url: Schema.String,
  /**
   * The site sent the form by GET, so the password was in the tab's address: the tab was taken to the same page without
   * its query, and the site may have the password in its own logs.
   */
  password_in_address: Schema.Boolean,
  /** The browser tab it filled, as Cua Driver names it: the caller's, or one the server opened (with a session label of its own). */
  session: Schema.String,
  target_id: Schema.String,
  tab_id: Schema.String,
})
export interface SignedIn extends Schema.Schema.Type<typeof SignedIn> {}
