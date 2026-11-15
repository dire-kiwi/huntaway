import { Schema } from "effect"
import { TaskId } from "./ids.ts"

// HE-34: plugins (docs/plan/15-plugins.md). What a host says of the plugins it was built with, and what their pages
// and calls carry. The plugins' own API is `@huntaway/plugin`; this is only what crosses the wire.

/** A plugin's id: its MCP server's name, its pages' first path segment. */
export const PluginId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,31}$/))
export type PluginId = typeof PluginId.Type

/** Where a plugin's page is shown: its own page, a section of Settings, a panel on a task's page. */
export const PluginSlot = Schema.Literals(["page", "settings", "task"])
export type PluginSlot = typeof PluginSlot.Type

/** A plugin as its host has it. `error`: it failed to start (a migration, its `make`), so it has none of its parts. */
export const PluginInfo = Schema.Struct({
  /**
   * Not `PluginId`: a plugin refused for its id is listed too, with why, and the list as a whole must still encode
   * (HE-34's review).
   */
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
  description: Schema.NullOr(Schema.String),
  /** The menu's entry for its page, if it has one. */
  nav: Schema.NullOr(Schema.Struct({ title: Schema.String })),
  /** Its section of Settings, if it has one. */
  settings: Schema.NullOr(Schema.Struct({ title: Schema.String })),
  /** Whether it has a panel on tasks' pages. */
  task: Schema.Boolean,
  /** Whether agents get its MCP server (`mcp__<id>`), and its tools' names. */
  mcp: Schema.NullOr(Schema.Struct({ tools: Schema.Array(Schema.String) })),
  error: Schema.NullOr(Schema.String),
})
export type PluginInfo = typeof PluginInfo.Type

/** What `plugins.page` asks for. */
export const PluginPageRequest = Schema.Struct({
  plugin: PluginId,
  slot: PluginSlot,
  /** Under `/<plugin id>/`, no leading `/`. */
  path: Schema.String,
  query: Schema.Record(Schema.String, Schema.String),
  task_id: Schema.NullOr(TaskId),
})
export type PluginPageRequest = typeof PluginPageRequest.Type

/** A plugin's page: its HTML for the frame (`empty`: nothing to show), or another of its paths to go to. */
export const PluginPage = Schema.Union([
  Schema.Struct({ type: Schema.Literal("html"), title: Schema.NullOr(Schema.String), html: Schema.String, empty: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("redirect"), path: Schema.String }),
])
export type PluginPage = typeof PluginPage.Type

/** A plugin refused or failed what it was asked (`reason` as `@huntaway/plugin`'s `PluginError` has it). */
export class PluginFailed extends Schema.TaggedError<PluginFailed, { readonly brand: unique symbol }>()("PluginFailed", {
  plugin: Schema.String,
  reason: Schema.Literals(["not_found", "invalid", "conflict", "unavailable", "forbidden", "failed"]),
  message: Schema.String,
}) {}
