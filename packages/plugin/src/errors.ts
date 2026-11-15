import { Schema } from "effect"

// What a plugin's tool, page, call or board service fails with (docs/plan/15-plugins.md). The board turns it into the
// wire's errors for a page or a call (`NotFound`, `Invalid`, `Conflict`, `Unavailable`, `Forbidden`, `PluginFailed`)
// and into the message an agent is told for a tool.

/** Why it failed: `failed` for anything that isn't one of the others. */
export const PluginErrorReason = Schema.Literals(["not_found", "invalid", "conflict", "unavailable", "forbidden", "failed"])
export type PluginErrorReason = typeof PluginErrorReason.Type

export class PluginError extends Schema.TaggedError<PluginError, { readonly brand: unique symbol }>()("PluginError", {
  reason: PluginErrorReason,
  message: Schema.String,
}) {
  static readonly notFound = (message: string) => new PluginError({ reason: "not_found", message })
  static readonly invalid = (message: string) => new PluginError({ reason: "invalid", message })
  static readonly conflict = (message: string) => new PluginError({ reason: "conflict", message })
  static readonly unavailable = (message: string) => new PluginError({ reason: "unavailable", message })
  static readonly forbidden = (message: string) => new PluginError({ reason: "forbidden", message })
  static readonly failed = (message: string) => new PluginError({ reason: "failed", message })
}
