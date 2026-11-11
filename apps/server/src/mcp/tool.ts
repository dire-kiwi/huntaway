import { Context, Effect, Schema } from "effect"
import { Tool } from "effect/ai"
import type { CallId, PermissionMode, Profile, Task } from "@huntaway/contracts"
import { toJson } from "../platform/columns.ts"
import type { Run } from "../runs/Run.ts"

// The frame every tool of the board's MCP servers is defined in (docs/plan/07-agents.md, Board tools: Definitions).
// A tool is declared once with `Tool.make` from `effect/ai` (its name, description, parameters and success schemas)
// and annotated with what the dispatcher needs to know of it (`Rerunnable`, `ForReviewers`, `ForPlanning`…). From that
// one value come the JSON Schema the agent is shown (`listed`), the check of what it sends (`checkArgs`), and the
// handler's types (`ToolHandler`). An area registers its tools' handlers with `McpServers.register`; `ToolCalls` runs
// them. Tool names, argument names and descriptions are copied from the old server exactly: prompts, approval rules
// and agents' habits depend on them.

/** The board's MCP servers: its own tools, GitHub through `gh`, the profile's documents, the host's desktop. */
export const ServerName = Schema.Literals(["huntaway", "gh", "docs", "desktop"])
export type ServerName = typeof ServerName.Type

/** The board's own server. */
export const BOARD_SERVER: ServerName = "huntaway"

/**
 * A call of it found executing after a restart may run again (docs/plan/inventory/03-mcp.md 2.4): it only reads,
 * records what it is given, or picks up where it left off by its call id (`wait`). Any other is answered that it was
 * interrupted and may or may not have taken effect.
 */
export const Rerunnable = Context.Reference<boolean>("huntaway-server/mcp/tool/Rerunnable", { defaultValue: () => false })

/**
 * A review thread may call it (and is offered it). Reviewers read untrusted content, so they read the board, wait, ask
 * and report, and the server checks it per call, whatever the run's tool list says.
 */
export const ForReviewers = Context.Reference<boolean>("huntaway-server/mcp/tool/ForReviewers", { defaultValue: () => false })

/** Offered to review threads only (`submit_review`). */
export const ReviewersOnly = Context.Reference<boolean>("huntaway-server/mcp/tool/ReviewersOnly", { defaultValue: () => false })

/**
 * A thread in plan mode may call it: it only reads the board until its plan is approved. Checked per call, because a
 * run's tool list is fixed at its launch while its mode changes.
 */
export const ForPlanning = Context.Reference<boolean>("huntaway-server/mcp/tool/ForPlanning", { defaultValue: () => false })

/**
 * The kind of approval (`permission_requests.kind`) the tool asks the user for before it changes anything
 * (`update_project`: `project`, `delete_task`: `delete_task`, the automation and workflow tools: `automation`). A call
 * cut short while that approval was not given has changed nothing, so it may run again.
 */
export const ApprovalKind = Context.Reference<"project" | "delete_task" | "automation" | null>("huntaway-server/mcp/tool/ApprovalKind", {
  defaultValue: () => null,
})

/** An annotation of a tool (its default if the tool has none). */
export const annotation = <A>(tool: Tool.Any, key: Context.Reference<A>): A => Context.get(tool.annotations, key)

/**
 * Who is calling (docs/plan/07-agents.md, Who the caller is): the run the call came from, its task, and the task's
 * profile, with the call's id. A handler acts as this agent: on its profile's board, asking in its thread.
 *
 * An agent on another host (a call that came down a link, or up one: 7.4) has no run or thread here: `run` and `task`
 * are null, and its profile is this host's profile of its name (`id` null when this host has none by that name: it
 * reaches only the boards of the profiles that let that name in). The tools for the agent's own thread refuse it
 * (`ownThread`), and a change that needs the user's approval is refused for it (there is no thread here to ask in).
 */
export interface McpCaller {
  readonly call_id: CallId
  readonly server: ServerName
  readonly run: Run | null
  readonly task: Task | null
  readonly profile: CallerProfile
  /** The thread's permission mode at the call: its own, else its project's, else the host's default. */
  readonly mode: PermissionMode
}

/** The caller's profile as the tools read it: its id here (null: this host has none of that name) and its name. */
export interface CallerProfile {
  readonly id: Profile["id"] | null
  readonly name: string
}

/** A caller whose agent runs on this host: its run and its thread. */
export interface LocalCaller extends McpCaller {
  readonly run: Run
  readonly task: Task
}

/** Whether the call came from an agent on this host. */
export const isLocal = (caller: McpCaller): caller is LocalCaller => caller.run !== null && caller.task !== null

/**
 * The tools that act for the calling agent's own thread, which only its own host can run (the old `THREAD_TOOLS`):
 * refused for a call from another host's agent, and never passed to another host.
 */
export const THREAD_TOOLS: ReadonlyArray<string> = [
  "permission_prompt",
  "request_user_input",
  "finish_work",
  "submit_review",
  "wait",
  "background_wait",
  "track_work",
  "untrack_work",
  "list_tracked_work",
]

/** What a thread tool tells an agent on another host. */
export const onlyOnItsHost = (tool: string) => `${tool} only works on the host the agent runs on`

/** The caller as one on this host, or the refusal a thread tool gives an agent on another. */
export const ownThread = (caller: McpCaller, tool: string): Effect.Effect<LocalCaller, ToolError> =>
  isLocal(caller) ? Effect.succeed(caller) : Effect.fail(ToolError.other(onlyOnItsHost(tool)))

/**
 * Why a tool failed, as the agent is told. `notFound`: what it names is not on this host (so linked hosts may be asked,
 * M7); anything else is a refusal or a failure.
 */
export class ToolError extends Schema.TaggedError<ToolError, { readonly brand: unique symbol }>()("ToolError", {
  message: Schema.String,
  notFound: Schema.Boolean,
}) {
  static readonly other = (message: string) => new ToolError({ message, notFound: false })
  static readonly notFound = (message: string) => new ToolError({ message, notFound: true })
}

/** What a tool does with a call: its decoded parameters and the caller, to its result or the error the agent is told. */
export type ToolHandler<T extends Tool.Any> = (params: Tool.Parameters<T>, caller: McpCaller) => Effect.Effect<Tool.Success<T>, ToolError>

/** A handler for each tool of a toolkit. */
export type ToolHandlers<Tools extends Record<string, Tool.Any>> = { readonly [K in keyof Tools]: ToolHandler<Tools[K]> }

/** How a call came out: the tool's result as JSON, or the message of its error. What `mcp_calls` records. */
export type ToolResult =
  | { readonly _tag: "Ok"; readonly value: unknown }
  /** `notFound`: what it names isn't on this host (an up-call's answer says so); not recorded, so unset on a call answered again. */
  | { readonly _tag: "Err"; readonly message: string; readonly notFound?: boolean | undefined }

export const ToolResult = {
  ok: (value: unknown): ToolResult => ({ _tag: "Ok", value }),
  err: (message: string, notFound?: boolean): ToolResult => (notFound === true ? { _tag: "Err", message, notFound } : { _tag: "Err", message }),
}

/** A tool as `tools/list` shows it. */
export interface ListedTool {
  readonly name: string
  readonly description?: string
  readonly inputSchema: Readonly<Record<string, unknown>>
  /** MCP's hints (`readOnlyHint`), on the servers that give them. */
  readonly annotations?: Readonly<Record<string, unknown>>
}

/** The parts of a tool's JSON Schema the argument check reads. */
const InputShape = Schema.Struct({
  properties: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  required: Schema.optional(Schema.Array(Schema.String)),
})

const AnObject = Schema.Record(Schema.String, Schema.Unknown)
const isObject = Schema.is(AnObject)

/**
 * A tool's JSON Schema, an object with `properties` always there (an object of none for a tool without parameters).
 * MCP requires `"type": "object"`, and Claude Code drops a server's whole tool list when one tool's schema lacks it (seen
 * with a real `claude`: `Tool.getJsonSchema` gives a struct of no fields as `{ not: { type: "null" }, properties: {} }`).
 */
export const inputSchema = (tool: Tool.Any): Readonly<Record<string, unknown>> => {
  const { not: _not, ...schema }: Record<string, unknown> = { ...Tool.getJsonSchema(tool) }
  schema["type"] = "object"
  if (schema["properties"] === undefined) schema["properties"] = {}
  return schema
}

/** The tool as `tools/list` shows it: its name, description and JSON Schema. */
export const listed = (tool: Tool.Any): ListedTool => {
  const description = Tool.getDescription(tool)
  return description === undefined ? { name: tool.name, inputSchema: inputSchema(tool) } : { name: tool.name, description, inputSchema: inputSchema(tool) }
}

/** A tool's argument names (sorted) and the required ones, from its JSON Schema. */
export interface ToolArguments {
  readonly names: ReadonlyArray<string>
  readonly required: ReadonlyArray<string>
}

export const toolArguments = (tool: Tool.Any): ToolArguments => {
  const shape = Schema.decodeOption(InputShape)(inputSchema(tool))
  const properties = shape._tag === "Some" ? (shape.value.properties ?? {}) : {}
  return { names: Object.keys(properties).toSorted(), required: shape._tag === "Some" ? (shape.value.required ?? []) : [] }
}

const HINT = "If you haven't loaded this tool's schema (e.g. with ToolSearch), load it first."

/**
 * Checks an agent's arguments for `tool` (docs/plan/inventory/03-mcp.md 2.3, the old `check_args`): an argument the
 * tool doesn't have, or a missing or blank required one, is an error that names the tool's arguments. Claude Code
 * doesn't check them itself for a deferred tool whose schema the agent never loaded, and an agent that guesses (`task`
 * for `task_id`) would otherwise get "not found" or, where the argument is optional, the default instead. `host` is
 * always allowed (it picks a linked host). Gives the arguments as an object (none: `{}`).
 */
export const checkArgs = Effect.fnUntraced(function* (tool: string, shape: ToolArguments, args: unknown) {
  const names = shape.names.join(", ")
  const given = args === null || args === undefined ? {} : args
  if (!isObject(given)) return yield* ToolError.other(`${tool}'s arguments must be an object`)
  const extra = Object.keys(given)
    .toSorted()
    .find((key) => !shape.names.includes(key) && key !== "host")
  if (extra !== undefined) return yield* ToolError.other(`${tool} has no argument ${yield* toJson(extra)}; its arguments are ${names}. ${HINT}`)
  for (const name of shape.required) {
    const value = given[name]
    if (value === undefined || value === null || value === "") return yield* ToolError.other(`${tool} needs ${name} (its arguments are ${names}). ${HINT}`)
  }
  return given
})
