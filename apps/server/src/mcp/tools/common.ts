import { Effect, Schema } from "effect"
import type { Tool } from "effect/ai"
import { toolHandler } from "../McpServers.ts"
import type { RegisteredTool } from "../McpServers.ts"
import { ToolError } from "../tool.ts"
import type { ToolHandler } from "../tool.ts"

// What the board's tools share (docs/plan/07-agents.md, Board tools): the arguments every area's tools take, copied
// from the old mcp.ts `board_tools`, the way a tool's handler is registered, and the services' errors as the agent is
// told them.

/** The `profile` argument of every tool but the thread's own ones. */
export const ProfileArg = Schema.String.annotate({
  description: "The profile whose board to use (e.g. work), if not your own; must be one that lets your agents in (see list_projects)",
})

/** A task named by id or key. */
export const TaskRefArg = Schema.String.annotate({
  description: "Task id or key like ABC-12; <profile>:ABC-12 for a task on another profile's board whose key is also used elsewhere",
})

/** A project named by id, key or name, the caller's own by default. */
export const PROJECT_ONE = "Project id, key or name (<profile>:<key> for another profile's board); defaults to the current project"

/** What a board tool returns: JSON, as the old tools built it. */
export const Json = Schema.Unknown
export type Json = typeof Json.Type

/** A JSON object a tool builds and returns. */
export type JsonObject = Record<string, unknown>

/** The schemas of a tool a server can run (as `McpServers` has it): its parameters decode, and its result encodes, with no services. */
interface HandledConfig {
  readonly parameters: Schema.Top & { readonly DecodingServices: never }
  readonly success: Schema.Top & { readonly EncodingServices: never }
  readonly failure: Schema.Top
  readonly failureMode: Tool.FailureMode
}

/** Options for a board tool's registration. */
export interface BoardToolOptions {
  /**
   * Keep arguments the agent gave as null. By default they are dropped before the arguments are decoded, as the old
   * tools read null as "not given" (`str_arg`, `args[k] != null`); `get_task_field` refuses a null offset or limit.
   */
  readonly keepNulls?: boolean
  /** Rewrites the arguments before they are decoded (`request_user_input`'s options given as plain strings). */
  readonly prepare?: (args: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>
}

/** `tool`'s handler as the board's server runs it (`toolHandler`), with null arguments dropped unless `keepNulls`. */
export const boardTool = <Config extends HandledConfig>(
  tool: Tool.Tool<string, Config, unknown>,
  handle: ToolHandler<Tool.Tool<string, Config, unknown>>,
  options: BoardToolOptions = {},
): RegisteredTool => {
  const registered = toolHandler(tool, handle)
  const prepare = options.prepare ?? ((args) => args)
  return {
    ...registered,
    run: (args, caller) =>
      registered.run(prepare(options.keepNulls === true ? args : Object.fromEntries(Object.entries(args).filter(([, v]) => v !== null))), caller),
  }
}

/** A string argument, or null when it's left out or blank (the old `str_arg`). */
export const given = (v: string | undefined): string | null => (v === undefined || v === "" ? null : v)

/** An error a board service fails with, that a tool tells the agent. */
export type ServiceError =
  | ToolError
  | { readonly _tag: "TaskNotFound" | "ProjectNotFound" | "ProfileNotFound" | "PenNotFound"; readonly id: string }
  | { readonly _tag: "NotFound"; readonly what: string; readonly id: string }
  | { readonly _tag: "Invalid"; readonly reason: string }
  | { readonly _tag: "Conflict"; readonly detail: string }
  | { readonly _tag: "SendRefused"; readonly detail: string }

const NOT_FOUND = { TaskNotFound: "task", ProjectNotFound: "project", ProfileNotFound: "profile", PenNotFound: "pen" } as const

/**
 * A board service's error as the agent is told it: not found (so linked hosts may be asked, M7), or the reason a
 * change was refused.
 */
export const toolErrorOf = (e: ServiceError): ToolError => {
  if (e._tag === "ToolError") return e
  if (e._tag === "NotFound") return ToolError.notFound(`${e.what} ${e.id}`)
  if (e._tag === "Invalid") return ToolError.other(e.reason)
  if (e._tag === "Conflict" || e._tag === "SendRefused") return ToolError.other(e.detail)
  return ToolError.notFound(`${NOT_FOUND[e._tag]} ${e.id}`)
}

/** `self` with a board service's errors as the agent is told them. */
export const told = <A, E extends ServiceError, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, ToolError, R> => Effect.mapError(self, toolErrorOf)
