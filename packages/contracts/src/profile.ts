import { Schema } from "effect"
import { AgentConfigId, LinkId, ProfileId } from "./ids.ts"
import { Reviewer } from "./project.ts"
import { Timestamp } from "./time.ts"

// A profile (huntaway's apps/server/src/wire/profiles.ts): one person's board on a host, with its own agent logins.
// Without `claude_config_dir` (the default config's folder, for clients from before configs) and `summarizer` (the first
// of `summarizers`). Its Asana token is a secret: written through `ProfilePatch`, never sent.

export const Profile = Schema.Struct({
  id: ProfileId,
  name: Schema.String,
  /** The configs its threads can use, the default first. */
  claude_config_ids: Schema.Array(AgentConfigId),
  default_model: Schema.NullOr(Schema.String),
  /** Names of the profiles whose agents may use this board's tools (`*` for all). Names, as profiles match by name across hosts. */
  agent_access: Schema.Array(Schema.String),
  /** The GitHub account its agents' gh acts as: a login, or `HOST/LOGIN`. null uses gh's active account. */
  github_account: Schema.NullOr(Schema.String),
  /** Where the new project dialog clones repositories; null is `~/<name>`. */
  clone_dir: Schema.NullOr(Schema.String),
  /** Whose Asana token it has, as Asana named them; null when it has none. */
  asana_user: Schema.NullOr(Schema.String),
  asana_enabled: Schema.Boolean,
  /** A run that runs out of usage waits in In progress for the limit to reset, then carries on. */
  limit_wait: Schema.Boolean,
  /** Tasks not started yet start on the next of their configs that has usage left. */
  limit_switch: Schema.Boolean,
  /** For its projects with none of their own; empty is one reviewer with the task's config. */
  reviewers: Schema.Array(Reviewer),
  summarizers: Schema.Array(Reviewer),
  /** Merges wait for the user's approval of a summary (its projects can say otherwise). */
  merge_approval: Schema.Boolean,
  /** Ready for merge needs an approving review on GitHub (its projects can say otherwise). */
  require_pr_approval: Schema.Boolean,
  /** The linked host its assistant runs on; null for this host. */
  assistant_host: Schema.NullOr(LinkId),
  /** The config its assistant and routines start a conversation with; null for the default. */
  assistant_config_id: Schema.NullOr(AgentConfigId),
  /** The same for its pens thread and its pens' threads. */
  threads_config_id: Schema.NullOr(AgentConfigId),
  /** Its tasks' events go to the host's telemetry store. */
  telemetry: Schema.Boolean,
  telemetry_titles: Schema.Boolean,
  /** `#rrggbb` the board tints its theme with while this profile is active; null for the stock theme. */
  tint: Schema.NullOr(Schema.String),
  created_at: Timestamp,
})
export interface Profile extends Schema.Schema.Type<typeof Profile> {}

/** What `profiles.create` takes (the old `POST /profiles`). */
export const NewProfile = Schema.Struct({
  /** Unique, whatever its case. */
  name: Schema.String,
  claude_config_ids: Schema.optional(Schema.Array(AgentConfigId)),
  default_model: Schema.optional(Schema.NullOr(Schema.String)),
  agent_access: Schema.optional(Schema.Array(Schema.String)),
  github_account: Schema.optional(Schema.NullOr(Schema.String)),
  clone_dir: Schema.optional(Schema.NullOr(Schema.String)),
  /** Default true. */
  asana_enabled: Schema.optional(Schema.Boolean),
  limit_wait: Schema.optional(Schema.Boolean),
  limit_switch: Schema.optional(Schema.Boolean),
  /** At most 6. */
  reviewers: Schema.optional(Schema.NullOr(Schema.Array(Reviewer))),
  summarizers: Schema.optional(Schema.NullOr(Schema.Array(Reviewer))),
  merge_approval: Schema.optional(Schema.Boolean),
  require_pr_approval: Schema.optional(Schema.Boolean),
  assistant_host: Schema.optional(Schema.NullOr(LinkId)),
  /** Among `claude_config_ids`. */
  assistant_config_id: Schema.optional(Schema.NullOr(AgentConfigId)),
  threads_config_id: Schema.optional(Schema.NullOr(AgentConfigId)),
  tint: Schema.optional(Schema.NullOr(Schema.String)),
})
export interface NewProfile extends Schema.Schema.Type<typeof NewProfile> {}

/** What `profiles.update` takes (the old `PATCH /profiles/{id}`): each field optional. */
export const ProfilePatch = Schema.Struct({
  name: Schema.optional(Schema.String),
  default_model: Schema.optional(Schema.NullOr(Schema.String)),
  agent_access: Schema.optional(Schema.Array(Schema.String)),
  github_account: Schema.optional(Schema.NullOr(Schema.String)),
  clone_dir: Schema.optional(Schema.NullOr(Schema.String)),
  /** Write-only: checked with Asana, which names its user (`asana_user`). null or blank disconnects. */
  asana_token: Schema.optional(Schema.NullOr(Schema.String)),
  asana_enabled: Schema.optional(Schema.Boolean),
  limit_wait: Schema.optional(Schema.Boolean),
  limit_switch: Schema.optional(Schema.Boolean),
  reviewers: Schema.optional(Schema.NullOr(Schema.Array(Reviewer))),
  summarizers: Schema.optional(Schema.NullOr(Schema.Array(Reviewer))),
  merge_approval: Schema.optional(Schema.Boolean),
  require_pr_approval: Schema.optional(Schema.Boolean),
  claude_config_ids: Schema.optional(Schema.Array(AgentConfigId)),
  assistant_host: Schema.optional(Schema.NullOr(LinkId)),
  /** A config it no longer has goes back to the default. */
  assistant_config_id: Schema.optional(Schema.NullOr(AgentConfigId)),
  threads_config_id: Schema.optional(Schema.NullOr(AgentConfigId)),
  telemetry: Schema.optional(Schema.Boolean),
  telemetry_titles: Schema.optional(Schema.Boolean),
  tint: Schema.optional(Schema.NullOr(Schema.String)),
})
export interface ProfilePatch extends Schema.Schema.Type<typeof ProfilePatch> {}
