import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { External, NotFound, Unavailable } from "../errors.ts"
import { ProfileId } from "../ids.ts"
import { Auth, RequiredScope } from "../session.ts"

// 6.11: Asana, for linking a task to the Asana task it's for (docs/plan/inventory/06-integrations.md §2.5). A profile
// connects with a token (`profiles.update`'s `asana_token`, checked with Asana); the link is the task's `external_links`.

/** An Asana task, as a profile's Asana search finds it. */
export const AsanaTask = Schema.Struct({
  gid: Schema.String,
  name: Schema.String,
  url: Schema.String,
  completed: Schema.Boolean,
  /** Its description, as plain text. */
  notes: Schema.String,
  assignee: Schema.NullOr(Schema.String),
  projects: Schema.Array(Schema.String),
  workspace: Schema.NullOr(Schema.String),
})
export interface AsanaTask extends Schema.Schema.Type<typeof AsanaTask> {}

export class AsanaRpcs extends RpcGroup.make(
  /**
   * The Asana tasks the profile's token finds for `q`: the task a pasted URL (or gid) names (none when the token can't
   * see it), or those named like `q` in each of its workspaces, open ones first (the old `GET
   * /profiles/{id}/asana/tasks`). `Unavailable` (`asana`) when Asana is off for the profile or it isn't connected;
   * `External` when Asana fails.
   */
  Rpc.make("profiles.asanaTasks", {
    payload: { profile_id: ProfileId, q: Schema.String },
    success: Schema.Array(AsanaTask),
    error: Schema.Union([NotFound, Unavailable, External]),
  }).annotate(RequiredScope, "read"),
).middleware(Auth) {}
