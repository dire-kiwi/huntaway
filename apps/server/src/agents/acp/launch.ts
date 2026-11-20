import { Effect, Option, Schema } from "effect"
import type { PermissionMode, Task } from "@huntaway/contracts"
import type { LaunchSpec } from "../AgentDriver.ts"
import { BROWSER_SERVER, DESKTOP_SERVER, GH_SERVER, SPACES_SERVER, usesServer } from "../claude/access.ts"
import type { RunTools } from "../claude/access.ts"
import { boardServers, mcpRun, pluginServers, TASK_ENV, userInput } from "../claude/launch.ts"
import type { BoardManifest, ServedServers } from "../claude/launch.ts"
import { LaunchRefused } from "../codex/launch.ts"
import { isClaudeModel } from "../codex/spec.ts"
import { commandLine } from "./spec.ts"
import type { AcpMcpServer, AcpSpec } from "./spec.ts"

// How an ACP agent's run is started (HE-69; docs/plan/07-agents.md, ACP agents): `huntaway acp-run <run dir>/acp.json`
// under ia-shim, as a Codex run is `codex-run codex.json`, with the spec the adapter reads (`acp.json`: the agent's
// command line, the session, the model, the mode, the board's instructions and the MCP servers it gives the agent in
// `session/new`) and the prompt as the first stream-json user message of its input. Pure given its input:
// `runs/LaunchFacts` gathers it.

export interface AcpLaunchInput {
  readonly run: string
  /** The run's folder: `acp.json` is named by its path in it. */
  readonly runDir: string
  /** ACP has no compaction: a `compact` run is refused. */
  readonly kind: "prompt" | "compact" | "review"
  readonly task: Pick<Task, "id" | "kind" | "session_id">
  readonly cwd: string
  /** This server's launcher (`huntaway`), which runs the adapter (`huntaway acp-run`); null if it has none. */
  readonly exe: string | null
  /** The home folder, for a config folder given with `~`. */
  readonly home: string
  /** The config folder, the agent's home (`GEMINI_HOME`); null for the agent's own. */
  readonly configDir: string | null
  /** The config's command line (`AgentConfig.command`); null for the default, `agy acp`. */
  readonly command: string | null
  readonly tmp: string | null
  /** The model to select, or null for the agent's own. */
  readonly model: string | null
  readonly effort: string | null
  readonly permissionMode: PermissionMode
  readonly tools: RunTools
  readonly served: ServedServers
  readonly githubAccount: string | null
  /** What it is told (`Prompts.system`, the text for agents other than Claude Code): put before a new session's first prompt. */
  readonly systemPrompt: string
  /** What it is sent first. */
  readonly prompt: string
  /** The uuid of the prompt's stream-json message. */
  readonly promptId: string
  /** The board's MCP servers: their URLs start with `url`, with the run's secret; the board server's handshake. */
  readonly mcp: { readonly url: string; readonly secret: string; readonly manifest: BoardManifest }
}

/** A model name Codex's (`gpt-5.1`, `codex-mini`, `o3`). */
const isCodexModel = (model: string): boolean => /^(gpt-|codex|o\d)/iu.test(model.trim())

/** The model an ACP agent is asked for: the one given unless it is Claude's or Codex's, else null (the agent's own). */
export const acpModel = (model: string | null): string | null => (model === null || isClaudeModel(model) || isCodexModel(model) ? null : model)

/** What an ACP launch makes: the launch spec (with `acp.json`). */
export interface AcpLaunch {
  readonly spec: LaunchSpec
  readonly acp: AcpSpec
}

const Pairs = Schema.Record(Schema.String, Schema.String)
/** An `mcp.json` entry ACP can give an agent: over HTTP (`http`, `streamable-http`), or a command (stdio, the default type). */
const McpEntry = Schema.Union([
  Schema.Struct({ type: Schema.Literals(["http", "streamable-http"]), url: Schema.String, headers: Schema.optional(Pairs) }),
  Schema.Struct({
    type: Schema.optional(Schema.Literal("stdio")),
    command: Schema.String,
    args: Schema.optional(Schema.Array(Schema.String)),
    env: Schema.optional(Pairs),
  }),
])
const decodeEntry = Schema.decodeUnknownOption(McpEntry)

const pairs = (record: Readonly<Record<string, string>> | undefined) => Object.entries(record ?? {}).map(([name, value]) => ({ name, value }))

/** `mcp.json`'s servers as ACP's `session/new` takes them; one of another type (`sse`) or shape is left out. */
export const acpServers = (servers: Readonly<Record<string, unknown>>): ReadonlyArray<AcpMcpServer> =>
  Object.entries(servers).flatMap(([name, entry]): ReadonlyArray<AcpMcpServer> => {
    const found = Option.getOrNull(decodeEntry(entry))
    if (found === null) return []
    if ("url" in found) return [{ type: "http", name, url: found.url, headers: pairs(found.headers) }]
    return [{ name, command: found.command, args: found.args ?? [], env: pairs(found.env) }]
  })

/** What to run for an ACP agent's run, and what goes in its folder. */
export const acpLaunch = (input: AcpLaunchInput): Effect.Effect<AcpLaunch, LaunchRefused> =>
  Effect.gen(function* () {
    const { task, tools } = input
    if (input.exe === null)
      return yield* new LaunchRefused({ reason: "this server wasn't started by its launcher (bin/huntaway), so it can't run an ACP agent" })
    if (input.kind === "compact") return yield* new LaunchRefused({ reason: "an ACP agent's conversation can't be compacted" })
    const review = task.kind === "review"
    const servers: ServedServers = {
      gh: usesServer(tools, GH_SERVER, input.served.gh),
      desktop: usesServer(tools, DESKTOP_SERVER, input.served.desktop),
      spaces: usesServer(tools, SPACES_SERVER, input.served.spaces === true),
      browser: usesServer(tools, BROWSER_SERVER, input.served.browser === true),
      plugins: pluginServers(tools, input.served),
    }
    // The board's own server is one of them, over HTTP: an ACP agent has no dynamic tools.
    const mcpServers = boardServers(input, servers, false)
    const { program, args } = commandLine(input.command)
    const acp: AcpSpec = {
      cwd: input.cwd,
      program,
      args,
      session_id: task.session_id,
      model: input.model,
      effort: input.effort,
      mode: input.permissionMode,
      system_prompt: input.systemPrompt,
      input: true,
      requests_on_output: true,
      mcp_servers: acpServers(mcpServers),
    }
    const configDir = input.configDir !== null && input.configDir.trim() !== "" ? input.configDir : null
    const env: Array<readonly [string, string]> = [
      ...(input.tmp === null ? [] : [["TMPDIR", input.tmp] as const]),
      [TASK_ENV, task.id],
      ...(configDir === null ? [] : [["GEMINI_HOME", expand(configDir, input.home)] as const]),
    ]
    const spec: LaunchSpec = {
      program: input.exe,
      args: ["acp-run", `${input.runDir}/acp.json`],
      env,
      cwd: input.cwd,
      configDir: input.configDir,
      prompt: `${yield* userInput(input.promptId, input.prompt)}\n`,
      input: true,
      promptId: null,
      systemPrompt: null,
      mcpServers,
      mcpRun: mcpRun({ cwd: input.cwd, github_account: input.githubAccount, review, in_process: false, desktop: servers.desktop }, servers),
      acp,
    }
    return { spec, acp }
  })

/** `~` expanded against `home`. */
const expand = (path: string, home: string) => (path === "~" ? home : path.startsWith("~/") ? `${home}${path.slice(1)}` : path)
