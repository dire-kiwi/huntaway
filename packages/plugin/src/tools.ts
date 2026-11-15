import { Effect, Schema } from "effect"
import type { Tool } from "effect/ai"
import type { CallContext, RunContext } from "./context.ts"
import { PluginError } from "./errors.ts"

// A plugin's MCP server (docs/plan/15-plugins.md, MCP): its tools, declared with `Tool.make` from `effect/ai` as the
// board's own are, each with its handler. The board serves it to every agent run on this host as the server named by
// the plugin's id (`mcp__<id>__<tool>`), over HTTP with the run's own secret, unless the run's project turns it off
// (denying `mcp__<id>`, or a server of its own by that name). Calls go through the board's dispatcher: each runs at
// most once per call id, and is recorded with the run's other calls.

/** The schemas of a tool the board can run: its parameters decode, and its result encodes, with no services. */
export interface HandledConfig {
  readonly parameters: Schema.Top & { readonly DecodingServices: never }
  readonly success: Schema.Top & { readonly EncodingServices: never }
  readonly failure: Schema.Top
  readonly failureMode: Tool.FailureMode
}

/** A tool with its handler, over JSON: what the board runs. Made with `pluginTool`. */
export interface PluginTool {
  readonly tool: Tool.Any
  /** The handler, given the agent's arguments as JSON: decodes them with the tool's schema and encodes its result. */
  readonly run: (args: Readonly<Record<string, unknown>>, call: CallContext) => Effect.Effect<unknown, PluginError>
  /** Whether a run is offered it (`tools/list`); every run when missing. A call of a tool not offered is refused. */
  readonly offer?: ((run: RunContext) => Effect.Effect<boolean>) | undefined
}

/**
 * `tool`'s handler: the agent's arguments decoded with the tool's parameters schema (an argument of the wrong type is an
 * error that says so), the result encoded with its success schema. A result that is already MCP content
 * (`{ content: [...] }`) is given to the agent as it is; anything else as its JSON.
 */
export const pluginTool = <Config extends HandledConfig>(
  tool: Tool.Tool<string, Config, unknown>,
  handle: (
    params: Tool.Parameters<Tool.Tool<string, Config, unknown>>,
    call: CallContext,
  ) => Effect.Effect<Tool.Success<Tool.Tool<string, Config, unknown>>, PluginError>,
  options?: { readonly offer?: (run: RunContext) => Effect.Effect<boolean> },
): PluginTool => {
  const decode = Schema.decodeUnknownEffect(Schema.toCodecJson(tool.parametersSchema))
  const encode = Schema.encodeEffect(Schema.toCodecJson(tool.successSchema))
  return {
    tool,
    offer: options?.offer,
    run: (args, call) =>
      decode(args).pipe(
        Effect.mapError((e) => PluginError.invalid(`${tool.name}'s arguments don't fit its schema: ${e.message}`)),
        Effect.flatMap((params) => handle(params, call)),
        Effect.flatMap((result) => Effect.orDie(encode(result))),
      ),
  }
}

/** What the plugin's MCP server is. */
export interface PluginMcp {
  /** In the order `tools/list` shows them. */
  readonly tools: ReadonlyArray<PluginTool>
  /** What `initialize` tells the agent (Claude Code adds it to its system prompt): fixed, or for the run. */
  readonly instructions?: string | ((run: RunContext) => Effect.Effect<string | null>) | undefined
  /**
   * Whether agents call its tools without asking (`--allowedTools mcp__<id>`, Codex's `approve`): for tools that only
   * touch the plugin's own data. Otherwise each call asks, as another MCP server's do. Default false.
   */
  readonly preApproved?: boolean | undefined
  /** The largest request it takes, in bytes (a publish with images is large). Default 32 MiB. */
  readonly maxRequestBytes?: number | undefined
}
