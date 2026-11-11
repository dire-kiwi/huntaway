import { Context, Effect, Layer, Ref, Schema } from "effect"
import { Tool } from "effect/ai"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { askedProtocol, METHOD_NOT_FOUND, rpcError, rpcResult } from "./jsonrpc.ts"
import type { RpcResponse } from "./jsonrpc.ts"
import { annotation, BOARD_SERVER, ForReviewers, listed, ownThread, ReviewersOnly, ToolError, toolArguments } from "./tool.ts"
import type { ListedTool, LocalCaller, McpCaller, ServerName, ToolArguments, ToolHandler } from "./tool.ts"

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

/** 6.3: the docs server's (huntaway's mcp/docs_mcp.ts), copied word for word. */
export const DOCS_INSTRUCTIONS =
  "Docs keeps Markdown documents for the user to read on this Huntaway board: reports, plans, research, write-ups. " +
  "Publish with `publish_document` (one or more pages; nested paths like `plan/phase-1` make a nested menu). Every " +
  'publish creates a new version, so you can revise freely; `mode: "merge"` keeps the other pages of the previous ' +
  "version. If you can start sub-agents, have one write and publish the document: give it what the document should " +
  "say, let it look up components, publish and fix any problems, and have it return the URL. That keeps the component " +
  "reference and the page sources out of your own context. Plain Markdown needs no reference. For components " +
  '(callouts, collapsible sections, form fields), call `list_components` for their names, props and examples, and use format "mdx". ' +
  "Form fields (`<Approval />`, inputs and the like) show read-only here and collect no answers, so ask the user in the " +
  "thread for a decision or input instead. `publish_document` is the check: it rejects a page it can't publish and says " +
  "why, and returns warnings (an unknown component, a bad prop) with the URL; fix them and publish again. Don't install " +
  "or run npm packages, renderers or other tools to check pages. The user can select text in a document on the board and " +
  "comment on it for you: read the comments with `get_feedback` (pass its `cursor` as `since` next time for only new " +
  "ones); the board can also send them to the task that published the document as a message. " +
  "Documents belong to your profile on this board. A new " +
  "document goes in a folder named after your task's project unless you give `folder`; a `folder` you give is used as " +
  'it is (`"plans"` is a top-level folder, `"<project>/plans"` one inside the project\'s), and later versions stay ' +
  "wherever the document is. Use `move_document` only when the user asks to move one. Documents can also have labels, " +
  "nested with '/' (\"research/ai\"): pass `labels` to `publish_document` or call `set_document_labels`, and call " +
  "`list_labels` to reuse the labels that already exist rather than inventing near-duplicates. Images: pass them to " +
  "`publish_document` as `images` ({name, data}: base64 PNG, JPEG, WebP, GIF or AVIF, name a relative path like " +
  '"images/chart.png") and refer to them by name (`![Chart](images/chart.png)`), or inline them as data: URIs. Every image ' +
  "is converted to AVIF and must be at most 500 KB after that (downscale or crop one that isn't); only the AVIF is kept, " +
  "not the original, and SVG and remote images aren't shown. Always give the reader the URL returned by `publish_document`."

/** What the gh server tells a run whose tools act as `account`. */
export const ghInstructions = (account: string | null): string =>
  account === null ? GH_INSTRUCTIONS : `${GH_INSTRUCTIONS} They act as the GitHub account ${account}.`

/** 6.10: the desktop server's (huntaway's mcp/desktop_mcp.ts), copied word for word. */
export const DESKTOP_INSTRUCTIONS =
  "`desktop` drives native apps on the desktop of the computer you run on, through Cua Driver. Use it only when the " +
  "shell, files or other tools can't do the job. Find the app with `windows` (or `apps`, then `launch`), `read` its " +
  'window\'s accessibility tree (start with `query` to keep it small; `since: "latest"` gets only what changed), then ' +
  "`act` with a batch of steps on `element_token`s from that read: it reports what changed, so you rarely need another " +
  "read. Use `screen` to look, and pixels only for what the tree can't reach. Keep delivery in the background (the " +
  'default): don\'t bring windows to the front just to look, and use `delivery_mode: "foreground"` only when the user ' +
  "allows it. Target windows by `pid` and `window_id`. Give each `act`, `launch` and `clipboard` an `op_id`; if an " +
  "answer is lost, call `op_status` with it instead of acting again. The person at this computer may be using it: " +
  "leave it as you found it (close the windows you opened, not theirs). If the screen is locked or another task is " +
  "using the desktop, stop and say so; don't try to unlock it."

/** What each server says it is in `initialize` (`serverInfo.name`, `instructions`). gh's name the run's account (`ghInstructions`). */
export const SERVER_INFO: { readonly [S in ServerName]: { readonly name: string; readonly instructions: string | null } } = {
  huntaway: { name: "huntaway", instructions: INSTRUCTIONS },
  gh: { name: "huntaway-gh", instructions: GH_INSTRUCTIONS },
  docs: { name: "huntaway-docs", instructions: DOCS_INSTRUCTIONS },
  desktop: { name: "huntaway-desktop", instructions: DESKTOP_INSTRUCTIONS },
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
 * `toolHandler` for a tool of a server only this host's runs are given (the desktop's, 6.10): its caller is an agent on
 * this host, with its run and thread; any other is refused as a thread tool is (M7's callers from other hosts).
 */
export const localToolHandler = <Config extends HandledConfig>(
  tool: Tool.Tool<string, Config, unknown>,
  handle: (
    params: Tool.Parameters<Tool.Tool<string, Config, unknown>>,
    caller: LocalCaller,
  ) => Effect.Effect<Tool.Success<Tool.Tool<string, Config, unknown>>, ToolError>,
): RegisteredTool => toolHandler(tool, (params, caller) => Effect.flatMap(ownThread(caller, tool.name), (local) => handle(params, local)))

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
  /**
   * 6.10: whether runs get a server is asked of `gate` at each launch (the desktop's: computer use is on and there is a
   * driver). A server with no gate is served once it has tools.
   */
  readonly serveWhen: (server: ServerName, gate: Effect.Effect<boolean>) => Effect.Effect<void>
  /** Whether a run launched now gets the server: it has tools, and its gate (if any) says so. */
  readonly serves: (server: ServerName) => Effect.Effect<boolean>
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

      const gates = yield* Ref.make<{ readonly [S in ServerName]?: Effect.Effect<boolean> }>({})

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
        serveWhen: (server, gate) => Ref.update(gates, (all) => ({ ...all, [server]: gate })),
        serves: (server) =>
          Effect.gen(function* () {
            if ((yield* Ref.get(registry))[server].length === 0) return false
            const gate = (yield* Ref.get(gates))[server]
            return gate === undefined ? true : yield* gate
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
            // 6.3: the docs server answers these as the hosted one does, with none.
            case "resources/list":
              return server === "docs"
                ? rpcResult(request.id, { resources: [] })
                : rpcError(request.id, METHOD_NOT_FOUND, `method not found: ${request.method}`)
            case "prompts/list":
              return server === "docs" ? rpcResult(request.id, { prompts: [] }) : rpcError(request.id, METHOD_NOT_FOUND, `method not found: ${request.method}`)
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
