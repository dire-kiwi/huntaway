import { Context, Effect, Layer, Ref, Schema } from "effect"
import { Tool } from "effect/ai"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { askedProtocol, METHOD_NOT_FOUND, rpcError, rpcResult } from "./jsonrpc.ts"
import type { RpcResponse } from "./jsonrpc.ts"
import { annotation, BOARD_SERVER, ForReviewers, listed, ReviewersOnly, ToolError, toolArguments } from "./tool.ts"
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

/** The gh server's (huntaway's mcp/gh_mcp.ts), copied word for word; a run with a GitHub account is told which (`ghInstructions`). */
export const GH_INSTRUCTIONS =
  "GitHub through the gh CLI, run outside any sandbox with the user's GitHub login. Use these tools instead of running gh in Bash (where it may not reach GitHub or its login, or act as the wrong account), and git_push instead of `git push` if that fails. They work in your working directory's repository by default; pass repo (OWNER/REPO) for another one, or dir to run in another checkout. pr_* tools take a pull request number, URL or branch, defaulting to the current branch's PR. For anything else, call the gh tool with gh's arguments."

/** What the gh server tells a run whose tools act as `account`. */
export const ghInstructions = (account: string | null): string =>
  account === null ? GH_INSTRUCTIONS : `${GH_INSTRUCTIONS} They act as the GitHub account ${account}.`

/** What each server says it is in `initialize` (`serverInfo.name`, `instructions`). gh's name the run's account (`ghInstructions`). */
export const SERVER_INFO: { readonly [S in ServerName]: { readonly name: string; readonly instructions: string | null } } = {
  huntaway: { name: "huntaway", instructions: INSTRUCTIONS },
  gh: { name: "huntaway-gh", instructions: GH_INSTRUCTIONS },
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

/**
 * A tool as a server lists it. The board's servers but its own say whether each only reads (`readOnlyHint`): Codex
 * runs those without asking.
 */
const listedOn = (server: ServerName, tool: Tool.Any): ListedTool =>
  server === BOARD_SERVER ? listed(tool) : { ...listed(tool), annotations: { readOnlyHint: Context.get(tool.annotations, Tool.Readonly) } }

/**
 * The tools a server offers a run: on the board's own, a review thread's run the reviewers' tools and any other run all
 * but those. The other servers offer every run all of theirs (a reviewer's gh writes are the CLI's to refuse, as before).
 */
const offered = (server: ServerName, registered: RegisteredTool, review: boolean) =>
  server !== BOARD_SERVER ? true : review ? annotation(registered.tool, ForReviewers) : !annotation(registered.tool, ReviewersOnly)

export interface McpServersShape {
  /** Adds tools to a server, after the ones it has (the order `tools/list` shows them in). A name already there is replaced. */
  readonly add: (server: ServerName, tools: ReadonlyArray<RegisteredTool>) => Effect.Effect<void>
  /** A server's tool by name. */
  readonly find: (server: ServerName, name: string) => Effect.Effect<RegisteredTool | undefined>
  /** The tools a server offers a run (`tools/list`): a review thread's the reviewers' tools. */
  readonly tools: (server: ServerName, review: boolean) => Effect.Effect<ReadonlyArray<ListedTool>>
  /** A server's answer to `initialize` for a client that asks for `protocol` (gh's naming the run's GitHub account). */
  readonly initializeResult: (server: ServerName, protocol: string, account?: string | null) => Readonly<Record<string, unknown>>
  /** The answer to a request that calls nothing: `initialize`, `ping`, `tools/list`; anything else but `tools/call` is -32601. */
  readonly answer: (
    server: ServerName,
    review: boolean,
    request: { readonly id: string | number; readonly method: string; readonly params: unknown },
    account?: string | null,
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
        Effect.map(Ref.get(registry), (all) => all[server].filter((r) => offered(server, r, review)).map((r) => listedOn(server, r.tool)))

      const initializeResult = (server: ServerName, protocol: string, account: string | null = null) => {
        const info = SERVER_INFO[server]
        const result = { protocolVersion: protocol, capabilities: { tools: {} }, serverInfo: { name: info.name, version: config.version } }
        const instructions = server === "gh" ? ghInstructions(account) : info.instructions
        return instructions === null ? result : { ...result, instructions }
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
        answer: Effect.fn("McpServers.answer")(function* (server, review, request, account) {
          switch (request.method) {
            case "initialize":
              return rpcResult(request.id, initializeResult(server, askedProtocol(request.params), account ?? null))
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
