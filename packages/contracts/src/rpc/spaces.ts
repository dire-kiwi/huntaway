import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Invalid, NotFound, Unavailable } from "../errors.ts"
import { Auth, RequiredScope } from "../session.ts"
import { NewSpace, Space, SpacesStatus, SpaceView } from "../space.ts"

const SpaceRef = { id: Schema.String }

/**
 * Spaces (HE-35): Linux desktops in Docker on a host. Seeing them is `terminal` (a Space's viewer drives its desktop);
 * making, starting, stopping, deleting them and copying sign-ins in are `admin`. `Unavailable` where the host has no
 * Docker.
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
  /** A viewer ticket for a running Space, good for an hour; `interactive` false only watches. */
  Rpc.make("spaces.view", {
    payload: { id: Schema.String, interactive: Schema.optional(Schema.Boolean) },
    success: SpaceView,
    error: Schema.Union([NotFound, Unavailable]),
  }).annotate(RequiredScope, "terminal"),
).middleware(Auth) {}
