import { Schema } from "effect"
import { AgentConfigId } from "./ids.ts"
import { Timestamp } from "./time.ts"

// An agent config's subscription usage (huntaway's apps/server/src/wire/usage.ts). Kept in memory, not in the database.

/** One of a plan's limits. */
export const UsageLimit = Schema.Struct({
  /** `session`, `weekly`, or `weekly:<model>`. */
  id: Schema.String,
  label: Schema.String,
  /** 0 to 100: how much of the limit is used. */
  percent: Schema.Finite,
  resets_at: Schema.NullOr(Timestamp),
})
export interface UsageLimit extends Schema.Schema.Type<typeof UsageLimit> {}

/** One of a proxy's Claude accounts, with its own limits. */
export const UsageAccount = Schema.Struct({
  /** Its email, or the proxy's name for it. */
  name: Schema.String,
  limits: Schema.Array(UsageLimit),
  /** Why its usage could not be read, or why the proxy is not using it. */
  error: Schema.NullOr(Schema.String),
})
export interface UsageAccount extends Schema.Schema.Type<typeof UsageAccount> {}

export const Usage = Schema.Struct({
  config_id: AgentConfigId,
  limits: Schema.Array(UsageLimit),
  /** From the login: `max`, `pro`… */
  plan: Schema.NullOr(Schema.String),
  /** When `limits` was last updated, by a fetch or an agent's run. */
  updated_at: Schema.NullOr(Timestamp),
  /** Why the last fetch failed; `limits` may still hold older numbers. */
  error: Schema.NullOr(Schema.String),
  /** Until when the config is out of usage, as a refused run said. */
  out_until: Schema.NullOr(Timestamp),
  /** For a config with a proxy: each of the proxy's accounts, which `limits` is picked from. null for other configs. */
  accounts: Schema.NullOr(Schema.Array(UsageAccount)),
})
export interface Usage extends Schema.Schema.Type<typeof Usage> {}
