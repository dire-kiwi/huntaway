import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Invalid, NotFound, Unavailable } from "../errors.ts"
import { Auth, RequiredScope } from "../session.ts"
import { ProfileId } from "../ids.ts"
import { NewSignIn, NewSpace, SignedIn, SignIn, SignInChange, Space, SpacesStatus, SpaceView } from "../space.ts"

const SpaceRef = { id: Schema.String }

/**
 * Spaces (HE-35): Linux desktops in Docker on a host. Seeing them is `terminal` (a Space's viewer drives its desktop);
 * making, starting, stopping, deleting them and copying sign-ins in are `admin`. `Unavailable` where the host has no
 * Docker. HE-48's sign-ins are a profile's on this host, and `admin` too: the list has no passwords, and none of them
 * answers with one.
 */
export class SpacesRpcs extends RpcGroup.make(
  Rpc.make("spaces.status", { success: SpacesStatus }).annotate(RequiredScope, "terminal"),
  /** Make one: it shows as `preparing` while its image is pulled or built and it starts, then `running` or `failed`. */
  Rpc.make("spaces.create", { payload: NewSpace, success: Space, error: Schema.Union([Invalid, NotFound, Unavailable]) }).annotate(RequiredScope, "admin"),
  Rpc.make("spaces.start", { payload: SpaceRef, success: Space, error: Schema.Union([NotFound, Unavailable]) }).annotate(RequiredScope, "admin"),
  Rpc.make("spaces.stop", { payload: SpaceRef, success: Space, error: Schema.Union([NotFound, Unavailable]) }).annotate(RequiredScope, "admin"),
  /** Remove the container and what was in it. */
  Rpc.make("spaces.delete", { payload: SpaceRef, error: Schema.Union([NotFound, Unavailable]) }).annotate(RequiredScope, "admin"),
  /** Copy its configs' sign-ins in again (they are copied without refresh tokens, so they expire). */
  Rpc.make("spaces.syncAgents", { payload: SpaceRef, success: Space, error: Schema.Union([NotFound, Unavailable]) }).annotate(RequiredScope, "admin"),
  /** HE-37: give this host's agents the `spaces` MCP server (their next runs), or not. */
  Rpc.make("spaces.setAgentTools", { payload: { enabled: Schema.Boolean }, success: SpacesStatus }).annotate(RequiredScope, "admin"),
  /** A viewer ticket for a running Space, good for an hour; `interactive` false only watches. */
  Rpc.make("spaces.view", {
    payload: { id: Schema.String, interactive: Schema.optional(Schema.Boolean) },
    success: SpaceView,
    error: Schema.Union([NotFound, Unavailable]),
  }).annotate(RequiredScope, "terminal"),
  /** HE-48: a profile's sign-ins on this host (every profile's when left out), without their passwords. */
  Rpc.make("signIns.list", { payload: { profile_id: Schema.optional(ProfileId) }, success: Schema.Array(SignIn) }).annotate(RequiredScope, "admin"),
  /** Save one: `Invalid` (`url`) for an address that isn't http(s), (`username`, `password`) for an empty one. */
  Rpc.make("signIns.create", { payload: NewSignIn, success: SignIn, error: Schema.Union([Invalid, NotFound]) }).annotate(RequiredScope, "admin"),
  Rpc.make("signIns.update", { payload: SignInChange, success: SignIn, error: Schema.Union([Invalid, NotFound]) }).annotate(RequiredScope, "admin"),
  Rpc.make("signIns.delete", { payload: { id: Schema.String }, error: NotFound }).annotate(RequiredScope, "admin"),
  /**
   * Type a sign-in into a running Space's browser and submit it: the server opens the site's address in a fresh
   * Chromium of its own and fills the form only on the sign-in's origin. `Invalid` (`page`) when the page is on another origin or has no password field.
   */
  Rpc.make("spaces.signIn", {
    payload: { id: Schema.String, sign_in_id: Schema.String },
    success: SignedIn,
    error: Schema.Union([NotFound, Unavailable, Invalid]),
  }).annotate(RequiredScope, "admin"),
).middleware(Auth) {}
