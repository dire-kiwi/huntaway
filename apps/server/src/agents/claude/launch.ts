import { Effect } from "effect"
import type { PermissionMode, Task } from "@huntaway/contracts"
import { forMode } from "@huntaway/shared"
import type { Rules } from "@huntaway/shared"
import { toJson } from "../../platform/columns.ts"
import type { LaunchSpec } from "../AgentDriver.ts"
import { claudeDisallowed, claudeHook, ghHook, hookSettings, needsPromptTool } from "../rules.ts"
import type { ClaudeHook } from "../rules.ts"
import {
  BOARD_SERVER,
  boardToolsAllowed,
  claudeEffort,
  DESKTOP_SERVER,
  desktopAllowed,
  desktopDisallowed,
  DOCS_SERVER,
  GH_SERVER,
  GH_WRITES,
  ghAllowed,
  REVIEW_ALLOWED,
  REVIEW_DISALLOWED,
  usesServer,
} from "./access.ts"
import type { RunTools } from "./access.ts"

// How a Claude Code run is started (huntaway's agent/runner/launch.ts, its Claude half, and runs.ts `start`; inventory
// 01, section 5, "claude launch"): the argument list in order, the environment, `mcp.json`, the hooks and the two
// prompt lines. Pure given its input: what it needs of the board (the prompt, the system prompt, the rules, the
// project's tools, the board server's manifest and the run's MCP secret) is gathered by `Runs`, which writes the result
// to the run's folder (`RunDir.prepare`) and starts it (`Shim.spawn`).

/** What `--permission-prompt-tool` is for a run that is asked on its output (its `can_use_tool` control requests). */
export const PROMPT_TOOL = "stdio"
/** The MCP version whose handshake the `initialize` line gives Claude Code up front. */
export const MCP_PROTOCOL = "2025-11-25"
/** The request id of a run's `initialize` is this and the run's id; Claude Code's answer to it says whether it took the board's tools. */
export const INIT_PREFIX = "huntaway-init-"

/** Claude Code's per-server `timeout` (ms): without one, it gives up on an HTTP server's call after 5 minutes without news. */
export const BOARD_TIMEOUT_MS = 86_400_000
/** gh commands time out after 10 minutes. */
export const GH_TIMEOUT_MS = 900_000
/** A desktop call's own limit, but for its permission prompt, which Claude Code asks before it. */
export const DESKTOP_TIMEOUT_MS = 300_000

/**
 * Claude's task list tool (HA-316). Claude Code turns its todo tools off for models newer than Sonnet 4.6 and Haiku 4.5
 * unless `CLAUDE_CODE_ENABLE_TODO_TOOLS` is set, and then gives it TaskCreate and friends, which keep the list in files,
 * unless `CLAUDE_CODE_ENABLE_TASKS` is off: then it's TodoWrite, the list in one call, which the thread shows.
 */
export const TODO_ENV: ReadonlyArray<readonly [string, string]> = [
  ["CLAUDE_CODE_ENABLE_TODO_TOOLS", "1"],
  ["CLAUDE_CODE_ENABLE_TASKS", "0"],
]

/** The environment variable a run's agent (and what it starts) carries its task in, so the board finds the servers it leaves listening. */
export const TASK_ENV = "HUNTAWAY_TASK_ID"

/** What the board's in-process server says of itself in the `initialize` line: its handshake's results (`sdkMcpServerManifests`). */
export interface BoardManifest {
  readonly initializeResult: unknown
  readonly toolsListResult: { readonly tools: ReadonlyArray<unknown> }
}

/** The board's HTTP MCP servers this server serves, besides the board's own (whose HTTP transport a compaction uses). */
export interface ServedServers {
  readonly gh: boolean
  readonly docs: boolean
  /** Computer use is on for this host and it has a driver. */
  readonly desktop: boolean
}

export interface ClaudeLaunchInput {
  readonly run: string
  /** The run's folder (`RunDir.path`): `system-prompt.md` and `mcp.json` are named by their paths in it. */
  readonly runDir: string
  /** A `compact` run reads its prompt and nothing more; every other run takes input as it works. */
  readonly kind: "prompt" | "compact" | "review"
  readonly task: Pick<Task, "id" | "kind" | "merging" | "session_id">
  /** Where it works. */
  readonly cwd: string
  /** The `claude` to run (`ServerConfig.claudeBin`). */
  readonly program: string
  /** This server's launcher, which the gh and approval-rules hooks run; null for none (no hooks). */
  readonly exe: string | null
  /** The home folder, for a config folder given with `~`. */
  readonly home: string
  /** The config folder its conversation is kept in (`CLAUDE_CONFIG_DIR`), null for Claude Code's default. */
  readonly configDir: string | null
  /** The config's proxy (`ANTHROPIC_BASE_URL` and friends), if it has one. */
  readonly apiEnv: ReadonlyArray<readonly [string, string]>
  /** Telemetry's environment for the agent's own OpenTelemetry events, if any. */
  readonly telemetryEnv: ReadonlyArray<readonly [string, string]>
  /** The task's temp folder (its `TMPDIR`, and an `--add-dir`), if it has one. */
  readonly tmp: string | null
  /** A rewind's point in the session to resume at (`--resume-session-at`). */
  readonly resumeAt: string | null
  /** The first non-blank of the task's, project's, profile's and host's. */
  readonly model: string | null
  /** The task's or the host's, as given (`ultra` and `minimal` are mapped to Claude's). */
  readonly effort: string | null
  readonly permissionMode: PermissionMode
  /** The thread's approval rules (all modes'), if it has any. */
  readonly rules: Rules | null
  /** The project's own skills and MCP servers, and those it turns off. */
  readonly tools: RunTools
  readonly served: ServedServers
  /** The GitHub account its gh tools act as (`mcp-run.json`). */
  readonly githubAccount: string | null
  /** Folders it may read besides its own (its group's repositories, the task's documents folder…), in order. */
  readonly addDirs: ReadonlyArray<string>
  /** Folders of files attached to its prompt. */
  readonly attachmentDirs: ReadonlyArray<string>
  /** What it is sent first (for a compaction, `/compact …`). */
  readonly prompt: string
  /** The uuid of the prompt's stream-json message, whose echo its first turn waits for. */
  readonly promptId: string
  /** What it is told on top of Claude Code's own system prompt (`system-prompt.md`). */
  readonly systemPrompt: string
  /** The board's MCP servers: their URLs start with `url` (`<internal url>/api/mcp/<run id>/`), with the run's secret. */
  readonly mcp: { readonly url: string; readonly secret: string; readonly manifest: BoardManifest }
}

/** A stream-json user message, as the agent's input takes it. */
export const userInput = (id: string, text: string): Effect.Effect<string> => toJson({ type: "user", uuid: id, message: { role: "user", content: text } })

/** The `control_request` that asks the agent to end its turn now, for the stop `stopId` (`stop-<uuid>`). */
export const interruptLine = (stopId: string): Effect.Effect<string> =>
  toJson({ type: "control_request", request_id: stopId, request: { subtype: "interrupt" } })

/** A `control_response` line answering one of the agent's requests. */
export const controlResponse = (response: unknown): Effect.Effect<string> => toJson({ type: "control_response", response })

/**
 * The `initialize` control request that starts the input of a run that calls the board's tools on its output: it
 * registers the board's in-process server, with no time limit on its calls and none of them moved to the background
 * (they may wait on the user), and its handshake's results, so Claude Code needn't ask for them before the first turn.
 */
export const initializeLine = (run: string, manifest: BoardManifest): Effect.Effect<string> =>
  toJson({
    type: "control_request",
    request_id: `${INIT_PREFIX}${run}`,
    request: {
      subtype: "initialize",
      sdkMcpServers: [BOARD_SERVER],
      sdkMcpServerConfigs: { [BOARD_SERVER]: { timeout: BOARD_TIMEOUT_MS, disableAutoBackground: true } },
      sdkMcpServerManifests: { [BOARD_SERVER]: manifest },
    },
  })

/** The names of the tools a manifest lists. */
const toolNames = (manifest: BoardManifest): ReadonlyArray<string> =>
  manifest.toolsListResult.tools.flatMap((t) => (typeof t === "object" && t !== null && "name" in t && typeof t.name === "string" ? [t.name] : []))

/** A gh server tool's name, as Claude Code calls it. */
const ghTool = (t: string) => `mcp__${GH_SERVER}__${t}`

/** `~` expanded against `home`. */
const expand = (path: string, home: string) => (path === "~" ? home : path.startsWith("~/") ? `${home}${path.slice(1)}` : path)

/** The run's `mcpServers` entries for the board's servers: HTTP, with the run's secret. */
const boardServers = (input: ClaudeLaunchInput, servers: ServedServers, inProcess: boolean): Record<string, unknown> => {
  const headers = { Authorization: `Bearer ${input.mcp.secret}` }
  const url = (name: string) => `${input.mcp.url}${name}`
  const out: Record<string, unknown> = {}
  if (!inProcess) out[BOARD_SERVER] = { type: "http", url: url(BOARD_SERVER), headers, timeout: BOARD_TIMEOUT_MS }
  if (servers.gh) out[GH_SERVER] = { type: "http", url: url(GH_SERVER), headers, timeout: GH_TIMEOUT_MS }
  if (servers.docs) out[DOCS_SERVER] = { type: "http", url: url(DOCS_SERVER), headers }
  if (servers.desktop) out[DESKTOP_SERVER] = { type: "http", url: url(DESKTOP_SERVER), headers, timeout: DESKTOP_TIMEOUT_MS }
  // The project's own (which may replace any but the board's).
  for (const [name, server] of Object.entries(input.tools.mcp_servers)) if (name !== BOARD_SERVER) out[name] = server
  return out
}

/** What to run for a Claude Code run, and what goes in its folder. */
export const claudeLaunch = (input: ClaudeLaunchInput): Effect.Effect<LaunchSpec> =>
  Effect.gen(function* () {
    const { task, tools } = input
    const review = task.kind === "review"
    // Every run but a `/compact` takes messages while it works; the prompt is its first.
    const takesInput = input.kind !== "compact"
    // The board's tools are an in-process MCP server, called on the run's output and answered on its input, which the
    // `initialize` its input starts with registers. A compaction, which takes no input, would call them over HTTP.
    const inProcess = takesInput
    let prompt = takesInput ? `${yield* userInput(input.promptId, input.prompt)}\n` : input.prompt
    if (inProcess) prompt = `${yield* initializeLine(input.run, input.mcp.manifest)}\n${prompt}`

    const servers: ServedServers = {
      gh: usesServer(tools, GH_SERVER, input.served.gh),
      docs: usesServer(tools, DOCS_SERVER, input.served.docs),
      desktop: usesServer(tools, DESKTOP_SERVER, input.served.desktop),
    }
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]
    // Echoed back, the messages show where in the turn the agent took them in.
    if (takesInput) args.push("--input-format", "stream-json", "--replay-user-messages")
    // In a file rather than an argument: the assistant's memory and a project's documents can make it longer than the
    // most an argument may be (128 KiB on Linux).
    args.push("--append-system-prompt-file", `${input.runDir}/system-prompt.md`)
    args.push("--permission-mode", input.permissionMode)
    // The user's approval rules: a hook's ask goes to the permission prompt even in Bypass, which otherwise has none.
    const rules = input.rules === null ? null : forMode(input.rules, input.permissionMode)
    // Asked on the run's output and answered on its input. A compaction, which has no input, calls no tools, so it has
    // no prompt tool: Claude Code refuses what would need one.
    const asks = takesInput && (input.permissionMode !== "bypassPermissions" || (rules !== null && needsPromptTool(rules)))
    if (asks) args.push("--permission-prompt-tool", PROMPT_TOOL)
    const hooks: Array<ClaudeHook> = []
    if (input.exe !== null) {
      if (servers.gh) hooks.push(ghHook(input.exe))
      const rulesHook = rules === null ? null : yield* claudeHook(input.exe, rules)
      if (rulesHook !== null) hooks.push(rulesHook)
    }
    if (hooks.length > 0) args.push("--settings", yield* hookSettings(hooks))
    // The board's tools never need approval, nor do some of the gh server's, nor the docs server's (they only touch
    // the profile's documents), nor the desktop's that only look.
    args.push("--allowedTools", ...boardToolsAllowed(input.permissionMode, toolNames(input.mcp.manifest)))
    if (servers.docs) args.push(`mcp__${DOCS_SERVER}`)
    if (servers.desktop) args.push(...desktopAllowed())
    const ownGh = Object.hasOwn(tools.mcp_servers, GH_SERVER)
    if (!ownGh) args.push(...ghAllowed(task).map(ghTool))
    args.push(...tools.allowed)
    const disallowed = [...tools.disallowed, ...(rules === null ? [] : claudeDisallowed(rules))]
    if (servers.desktop) disallowed.push(...desktopDisallowed(review).map((t) => `mcp__${DESKTOP_SERVER}__${t}`))
    if (review) {
      // Reviewers read and report; they don't change the work.
      args.push(...REVIEW_ALLOWED)
      disallowed.push(...REVIEW_DISALLOWED)
      if (!ownGh) disallowed.push(...GH_WRITES.map(ghTool))
    }
    if (disallowed.length > 0) args.push("--disallowedTools", disallowed.join(" "))
    if (task.session_id !== null) {
      args.push("--resume", task.session_id)
      if (input.resumeAt !== null) args.push("--resume-session-at", input.resumeAt)
    }
    if (input.model !== null) args.push("--model", input.model)
    if (input.effort !== null) args.push("--effort", claudeEffort(input.effort))
    const addDirs = [
      ...input.addDirs,
      ...(tools.skills_dir === null ? [] : [tools.skills_dir]),
      ...input.attachmentDirs,
      ...(input.tmp === null ? [] : [input.tmp]),
    ]
    for (const d of addDirs) args.push("--add-dir", d)
    args.push("--mcp-config", `${input.runDir}/mcp.json`)

    const configDir = input.configDir !== null && input.configDir.trim() !== "" ? input.configDir : null
    const env: Array<readonly [string, string]> = [
      // Permission prompts block until the user answers.
      ["MCP_TOOL_TIMEOUT", "86400000"],
      ...TODO_ENV,
      ...(input.tmp === null ? [] : [["TMPDIR", input.tmp] as const]),
      [TASK_ENV, task.id],
      ...input.apiEnv,
      ...input.telemetryEnv,
      ...(configDir === null ? [] : [["CLAUDE_CONFIG_DIR", expand(configDir, input.home)] as const]),
    ]
    const spec: LaunchSpec = {
      program: input.program,
      args,
      env,
      cwd: input.cwd,
      configDir: input.configDir,
      prompt,
      input: takesInput,
      promptId: takesInput ? input.promptId : null,
      systemPrompt: input.systemPrompt,
      mcpServers: boardServers(input, servers, inProcess),
      mcpRun: { cwd: input.cwd, github_account: input.githubAccount, review, in_process: inProcess, desktop: servers.desktop },
    }
    return spec
  })

/** The effort a run records (`runs.effort`): as the agent is given it, and "" for the agent's own default. */
export const recordedEffort = (effort: string | null): string => (effort === null ? "" : claudeEffort(effort).trim())
