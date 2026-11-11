import { Context, Effect, Layer, Ref, Schema } from "effect"
import type { Tool } from "effect/ai"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { askedProtocol, METHOD_NOT_FOUND, rpcError, rpcResult } from "./jsonrpc.ts"
import type { RpcResponse } from "./jsonrpc.ts"
import { annotation, ForReviewers, listed, ReviewersOnly, ToolError, toolArguments } from "./tool.ts"
import type { ListedTool, McpCaller, ServerName, ToolArguments, ToolHandler } from "./tool.ts"

// The board's MCP servers (docs/plan/07-agents.md, Board tools): which tools each has, with their handlers, and the
// part of the protocol that calls nothing (`initialize`, `ping`, `tools/list`). Areas register their tools' handlers
// with `McpServers.register` (3.2 the board's, M4 gh's…); `ToolCalls` runs the calls.

/** Sent with `initialize`; Claude Code adds it to the agent's system prompt. Copied word for word. */
export const INSTRUCTIONS =
  "Tools for the Huntaway board, a kanban board where each task is worked by its own Claude agent. " +
  "The board has a profile for each Claude login (e.g. work, personal), each with its own projects and tasks. Besides your own " +
  "profile's, you can use the boards of the profiles that let your agents in (each profile chooses which, in Settings → Profiles). " +
  "list_projects shows every project you can use, labelled with its profile and host. The other tools take a project or task " +
  "from any of them by id or key; an unqualified key means your own profile's board first, and one used on several other boards " +
  "must be qualified as <profile>:<key> (e.g. work:SD-3) or with the profile argument. A task created in another profile's " +
  "project runs under that profile's Claude login. Don't create a project the user refers to as if it existed: if " +
  "list_projects doesn't show it, it may be on a profile's board you can't use, so ask the user. To split a piece of work into " +
  "smaller tasks that are each reviewed and merged on their own and then land together, create them with merges_into that " +
  "task (new subprojects can't be made any more); group related tasks, across projects too, in a pen."

/** What each server says it is in `initialize` (`serverInfo.name`, `instructions`). gh's instructions name the run's account (M4). */
export const SERVER_INFO: { readonly [S in ServerName]: { readonly name: string; readonly instructions: string | null } } = {
  huntaway: { name: "huntaway", instructions: INSTRUCTIONS },
  gh: { name: "huntaway-gh", instructions: null },
  docs: { name: "huntaway-docs", instructions: null },
  desktop: { name: "huntaway-desktop", instructions: null },
}

/** A tool with its handler, over JSON: what `ToolCalls` runs. */
export interface RegisteredTool {
  readonly tool: Tool.Any
  /** Its argument names and required ones, for the argument check. */
  readonly args: ToolArguments
  /** The handler, given the checked arguments: decodes them with the tool's schema and encodes its result as JSON. */
  readonly run: (args: Readonly<Record<string, unknown>>, caller: McpCaller) => Effect.Effect<unknown, ToolError>
}

/** The schemas of a tool a server can run: its parameters decode, and its result encodes, with no services. */
interface HandledConfig {
  readonly parameters: Schema.Top & { readonly DecodingServices: never }
  readonly success: Schema.Top & { readonly EncodingServices: never }
  readonly failure: Schema.Top
  readonly failureMode: Tool.FailureMode
}

/**
 * `tool`'s handler, `handle`, as a server runs it: the arguments decoded with the tool's parameters schema (an argument
 * of the wrong type is an error that says so), the result encoded with its success schema.
 */
export const toolHandler = <Config extends HandledConfig>(
  tool: Tool.Tool<string, Config, unknown>,
  handle: ToolHandler<Tool.Tool<string, Config, unknown>>,
): RegisteredTool => {
  const decode = Schema.decodeUnknownEffect(Schema.toCodecJson(tool.parametersSchema))
  const encode = Schema.encodeEffect(Schema.toCodecJson(tool.successSchema))
  return {
    tool,
    args: toolArguments(tool),
    run: (args, caller) =>
      decode(args).pipe(
        Effect.mapError((e) => ToolError.other(`${tool.name}'s arguments don't fit its schema: ${e.message}`)),
        Effect.flatMap((params) => handle(params, caller)),
        Effect.flatMap((result) => Effect.orDie(encode(result))),
      ),
  }
}

/** The tools a server offers a run: a review thread's run the reviewers' tools, any other run all but those. */
const offered = (registered: RegisteredTool, review: boolean) =>
  review ? annotation(registered.tool, ForReviewers) : !annotation(registered.tool, ReviewersOnly)

export interface McpServersShape {
  /** Adds tools to a server, after the ones it has (the order `tools/list` shows them in). A name already there is replaced. */
  readonly add: (server: ServerName, tools: ReadonlyArray<RegisteredTool>) => Effect.Effect<void>
  /** A server's tool by name. */
  readonly find: (server: ServerName, name: string) => Effect.Effect<RegisteredTool | undefined>
  /** The tools a server offers a run (`tools/list`): a review thread's the reviewers' tools. */
  readonly tools: (server: ServerName, review: boolean) => Effect.Effect<ReadonlyArray<ListedTool>>
  /** A server's answer to `initialize` for a client that asks for `protocol`. */
  readonly initializeResult: (server: ServerName, protocol: string) => Readonly<Record<string, unknown>>
  /** The answer to a request that calls nothing: `initialize`, `ping`, `tools/list`; anything else but `tools/call` is -32601. */
  readonly answer: (
    server: ServerName,
    review: boolean,
    request: { readonly id: string | number; readonly method: string; readonly params: unknown },
  ) => Effect.Effect<RpcResponse>
}

export class McpServers extends Context.Service<McpServers, McpServersShape>()("huntaway-server/mcp/McpServers") {
  static readonly layer = Layer.effect(
    McpServers,
    Effect.gen(function* () {
      const config = yield* ServerConfig
      const registry = yield* Ref.make<{ readonly [S in ServerName]: ReadonlyArray<RegisteredTool> }>({ huntaway: [], gh: [], docs: [], desktop: [] })

      const find = (server: ServerName, name: string) => Effect.map(Ref.get(registry), (all) => all[server].find((r) => r.tool.name === name))
      const tools = (server: ServerName, review: boolean) =>
        Effect.map(Ref.get(registry), (all) => all[server].filter((r) => offered(r, review)).map((r) => listed(r.tool)))

      const initializeResult = (server: ServerName, protocol: string) => {
        const info = SERVER_INFO[server]
        const result = { protocolVersion: protocol, capabilities: { tools: {} }, serverInfo: { name: info.name, version: config.version } }
        return info.instructions === null ? result : { ...result, instructions: info.instructions }
      }

      return McpServers.of({
        add: (server, added) =>
          Ref.update(registry, (all) => {
            const names = new Set(added.map((r) => r.tool.name))
            return { ...all, [server]: [...all[server].filter((r) => !names.has(r.tool.name)), ...added] }
          }),
        find,
        tools,
        initializeResult,
        answer: Effect.fn("McpServers.answer")(function* (server, review, request) {
          switch (request.method) {
            case "initialize":
              return rpcResult(request.id, initializeResult(server, askedProtocol(request.params)))
            case "ping":
              return rpcResult(request.id, {})
            case "tools/list":
              return rpcResult(request.id, { tools: yield* tools(server, review) })
            default:
              return rpcError(request.id, METHOD_NOT_FOUND, `method not found: ${request.method}`)
          }
        }),
      })
    }),
  )

  /**
   * A layer that adds tools and their handlers to a server, built where the handlers' services are: one per area
   * (`McpServers.register("huntaway", Effect.gen(function* () { const tasks = yield* Tasks; return [toolHandler(GetTask,
   * …)] }))`), merged in `Main.ts`. The order of the list is the order runs are shown the tools in.
   */
  static readonly register = <E = never, R = never>(
    server: ServerName,
    tools: ReadonlyArray<RegisteredTool> | Effect.Effect<ReadonlyArray<RegisteredTool>, E, R>,
  ) =>
    // Fresh: every `McpServers` it is built over gets the tools (a test builds its own over the board's).
    Layer.fresh(
      Layer.effectDiscard(
        Effect.gen(function* () {
          const servers = yield* McpServers
          yield* servers.add(server, Effect.isEffect(tools) ? yield* tools : tools)
        }),
      ),
    )
}
