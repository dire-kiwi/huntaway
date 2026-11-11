import { Schema } from "effect"
import { AgentConfigId } from "./ids.ts"
import { Agent } from "./task.ts"
import { Timestamp } from "./time.ts"

// An agent config (huntaway's apps/server/src/wire/claude_configs.ts, `ClaudeConfig`): an agent's config folder (its
// login, settings and history) on a host, Claude Code's or Codex's. Profiles and projects pick which ones their threads
// can use, so a thread's config also decides which agent runs it. Its proxy keys are secrets: written through
// `NewAgentConfig` and `AgentConfigPatch`, never sent.

export const AgentConfig = Schema.Struct({
  id: AgentConfigId,
  name: Schema.String,
  /** May start with `~`. Empty is the agent's default (`~/.claude`, `~/.codex`). */
  config_dir: Schema.String,
  agent: Agent,
  /** The host fetches and shows its plan's usage limits. */
  show_usage: Schema.Boolean,
  /** The host starts its plan's next 5-hour window as soon as one ends. */
  restart_window: Schema.Boolean,
  /** An Anthropic-compatible proxy its Claude Code agents go through (ANTHROPIC_BASE_URL); null for Codex configs. */
  api_url: Schema.NullOr(Schema.String),
  /** The proxy its folder's settings.json sends Claude Code to, when it does; null for Codex configs. */
  settings_api_url: Schema.NullOr(Schema.String),
  /** It has the key its agents present to the proxy. */
  has_api_key: Schema.Boolean,
  /** It has the proxy's management key, which its accounts' usage is read with. */
  has_management_key: Schema.Boolean,
  created_at: Timestamp,
})
export interface AgentConfig extends Schema.Schema.Type<typeof AgentConfig> {}

/** A model a Codex config offers. */
export const AgentModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  is_default: Schema.Boolean,
  efforts: Schema.Array(Schema.String),
  default_effort: Schema.NullOr(Schema.String),
})
export interface AgentModel extends Schema.Schema.Type<typeof AgentModel> {}

/** The proxy fields, write-only: null or blank clears one. A Codex config has no proxy. */
const proxyFields = {
  /** An http(s) URL. */
  api_url: Schema.optional(Schema.NullOr(Schema.String)),
  api_key: Schema.optional(Schema.NullOr(Schema.String)),
  management_key: Schema.optional(Schema.NullOr(Schema.String)),
}

/** What `agentConfigs.create` takes (the old `POST /claude-configs`). */
export const NewAgentConfig = Schema.Struct({
  name: Schema.String,
  /** Default "": the agent's default folder. */
  config_dir: Schema.optional(Schema.String),
  /** Default `claude`. */
  agent: Schema.optional(Agent),
  ...proxyFields,
})
export interface NewAgentConfig extends Schema.Schema.Type<typeof NewAgentConfig> {}

/** What `agentConfigs.update` takes (the old `PATCH /claude-configs/{id}`): each field optional. */
export const AgentConfigPatch = Schema.Struct({
  name: Schema.optional(Schema.String),
  config_dir: Schema.optional(Schema.String),
  /** Refused once a thread has a session on it. */
  agent: Schema.optional(Agent),
  show_usage: Schema.optional(Schema.Boolean),
  restart_window: Schema.optional(Schema.Boolean),
  ...proxyFields,
})
export interface AgentConfigPatch extends Schema.Schema.Type<typeof AgentConfigPatch> {}
