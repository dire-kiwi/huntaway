import { Schema } from "effect"
import { AgentConfigId } from "./ids.ts"
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
