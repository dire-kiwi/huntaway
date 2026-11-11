import { Effect, Schema } from "effect"
import type { PermissionMode, Task } from "@huntaway/contracts"
import { forMode } from "@huntaway/shared"
import type { Rules } from "@huntaway/shared"
import type { LaunchSpec } from "../AgentDriver.ts"
import { DESKTOP_SERVER, desktopDisallowed, DOCS_SERVER, GH_SERVER, GH_WRITES, toolPrefix, usesServer } from "../claude/access.ts"
import type { RunTools } from "../claude/access.ts"
import { boardServers, TASK_ENV, userInput } from "../claude/launch.ts"
import type { BoardManifest, ServedServers } from "../claude/launch.ts"
import { boardTools } from "./requests.ts"
import { codexPolicy } from "./servers.ts"
import { defaultSpec, policy } from "./spec.ts"
import type { CodexSpec } from "./spec.ts"

// How a Codex run is started (huntaway's agent/runner/launch.ts, its Codex half, and runs.ts `start`; inventory 01,
// section 5 "Codex"): `huntaway codex-run <run dir>/codex.json` under ia-shim, with the spec the adapter reads
// (`codex.json`), the `mcp.json` it converts, and the prompt as the first stream-json user message of its input. Pure
// given its input: `runs/LaunchFacts` gathers it (the model and effort Codex takes, the reviewer's sandbox, the rules).

/** A reviewer's sandbox: it can't change the work, but can build and test it (`CodexSpec.filesystem`). */
export const REVIEW_SANDBOX_NOTE =
  "\n\nYour sandbox can't change the work: its files are read-only. You can write to the temp directories (/tmp), " +
  "package caches and the working directory's git-ignored directories, such as build output, so you can build it " +
  "and run its tests to check what you find. If a build needs to write anywhere else in the working directory, " +
  "point it at /tmp instead (e.g. `CARGO_TARGET_DIR`)."

/** The Codex run can't be started: a never rule on Codex's own tools, which it can't hold, or no launcher to run the adapter with. */
export class LaunchRefused extends Schema.TaggedError<LaunchRefused, { readonly brand: unique symbol }>()("LaunchRefused", {
  reason: Schema.String,
}) {
  override get message() {
    return this.reason
  }
}

export interface CodexLaunchInput {
  readonly run: string
  /** The run's folder: `codex.json` is named by its path in it. */
  readonly runDir: string
  readonly kind: "prompt" | "compact" | "review"
  readonly task: Pick<Task, "id" | "kind" | "session_id">
  readonly cwd: string
  /** This server's launcher (`huntaway`), which runs the adapter (`huntaway codex-run`); null if it has none. */
  readonly exe: string | null
  /** The `codex` the adapter starts (`ServerConfig.codexBin`). */
  readonly codexBin: string
  /** The home folder, for a config folder given with `~`. */
  readonly home: string
  /** The config folder its conversation is kept in (`CODEX_HOME`), null for Codex's default. */
  readonly configDir: string | null
  readonly tmp: string | null
  /** Codex's model: the task's, else the first of its project's, profile's and host's that isn't a Claude model. */
  readonly model: string | null
  /** As Codex's model takes it (`codexEffort`). */
  readonly effort: string | null
  readonly permissionMode: PermissionMode
  /** The thread's approval rules (all modes'), if it has any. */
  readonly rules: Rules | null
  readonly tools: RunTools
  readonly served: ServedServers
  readonly githubAccount: string | null
  /** What it is told (`Prompts.system` with `codex: true`): its developer instructions. */
  readonly systemPrompt: string
  /** What it is sent first (for a compaction, nothing: it compacts). */
  readonly prompt: string
  /** The uuid of the prompt's stream-json message. */
  readonly promptId: string
  /** The repository's git directory (`git rev-parse --git-common-dir`), which a worktree's commits write. */
  readonly gitDir: string | null
  /** Package managers' caches (`cacheDirsIn`), made if missing. */
  readonly cacheDirs: ReadonlyArray<string>
  /** The task's own documents folder, when it writes there and works elsewhere. */
  readonly documentsDir: string | null
  /** A reviewer's read-only sandbox's paths (`reviewFilesystem`); null for any other run. */
  readonly reviewFilesystem: Readonly<Record<string, "read" | "write">> | null
  /**
   * Whether the session has the board's tools as dynamic tools (`RunRepo.sessionBoardTools`): a new one is given them,
   * one that started with them keeps them, one from before (or whose Codex wouldn't take them) has the board's MCP server.
   */
  readonly sessionBoardTools: boolean
  /** A rewind's turn to revert the thread to before (`thread/revert`). */
  readonly revertBeforeTurn: string | null
  /** Telemetry's config overrides (`-c key=value`), if any. */
  readonly configOverrides: ReadonlyArray<string>
  /** The board's MCP servers: their URLs start with `url`, with the run's secret; the board server's handshake. */
  readonly mcp: { readonly url: string; readonly secret: string; readonly manifest: BoardManifest }
}

/** What a Codex launch makes: the launch spec (with `codex.json`), and whether it gives a new session the board's tools. */
export interface CodexLaunch {
  readonly spec: LaunchSpec
  readonly codex: CodexSpec
  /** `runs.board_tools`: this run gives the new session the board's tools as dynamic tools. */
  readonly boardTools: boolean
}

/** What to run for a Codex run, and what goes in its folder. */
export const codexLaunch = (input: CodexLaunchInput): Effect.Effect<CodexLaunch, LaunchRefused> =>
  Effect.gen(function* () {
    const { task, tools } = input
    if (input.exe === null) return yield* new LaunchRefused({ reason: "this server wasn't started by its launcher (bin/huntaway), so it can't run Codex" })
    const review = task.kind === "review"
    // Every run but a `/compact` takes messages while it works; the prompt is its first.
    const takesInput = input.kind !== "compact"
    const prompt = takesInput ? `${yield* userInput(input.promptId, input.prompt)}\n` : input.prompt
    // The user's approval rules may have Codex ask more, or keep it from running.
    const rules = input.rules === null ? null : forMode(input.rules, input.permissionMode)
    const decided = codexPolicy(rules, policy(input.permissionMode, review))
    if ("refused" in decided) return yield* new LaunchRefused({ reason: decided.refused })
    const [approvalPolicy, approvalsReviewer, sandbox] = decided.policy
    const servers: ServedServers = {
      gh: usesServer(tools, GH_SERVER, input.served.gh),
      docs: usesServer(tools, DOCS_SERVER, input.served.docs),
      desktop: usesServer(tools, DESKTOP_SERVER, input.served.desktop),
    }
    const ownGh = Object.hasOwn(tools.mcp_servers, GH_SERVER)
    // Reviewers read and report.
    const disabled: Record<string, ReadonlyArray<string>> = {}
    if (review && !ownGh) disabled[GH_SERVER] = GH_WRITES
    // The desktop's read-only tools need no approval; a reviewer only looks. Plan mode keeps the ones that act, which the
    // server refuses until the plan is approved.
    const desktopOff = desktopDisallowed(review)
    if (servers.desktop && desktopOff.length > 0) disabled[DESKTOP_SERVER] = desktopOff
    // In their read-only sandbox, reviewers can still build and run the tests to check what they find.
    const filesystem = review && sandbox === "read-only" && input.reviewFilesystem !== null ? input.reviewFilesystem : {}
    const instructions = Object.keys(filesystem).length > 0 ? input.systemPrompt + REVIEW_SANDBOX_NOTE : input.systemPrompt
    const writable = [
      ...(input.gitDir === null ? [] : [input.gitDir]),
      ...input.cacheDirs,
      ...(input.documentsDir === null ? [] : [input.documentsDir]),
      ...(input.tmp === null ? [] : [input.tmp]),
    ]
    // The board's tools are dynamic tools of a session that started with them (given to a new one); a session from
    // before has them on the board's MCP server, since Codex can't give a session it resumes new dynamic tools. Its
    // requests (approvals, questions, those tools' calls) are answered on its input, which every run but `/compact` has.
    const fresh = task.session_id === null
    const dynamic = fresh ? takesInput : input.sessionBoardTools
    const given = fresh && takesInput ? boardTools(input.mcp.manifest) : null
    const codex: CodexSpec = {
      ...defaultSpec({
        cwd: input.cwd,
        thread_id: task.session_id,
        model: input.model,
        effort: input.effort,
        approval_policy: approvalPolicy,
        approvals_reviewer: approvalsReviewer,
        sandbox,
        plan: input.permissionMode === "plan",
        compact: input.kind === "compact",
        developer_instructions: instructions,
        input: takesInput,
        writable_roots: writable,
        filesystem,
        skills_dir: tools.skills_dir === null ? null : `${tools.skills_dir}/.claude/skills`,
        // The project's servers it allows, and the docs server, whose tools only touch the profile's documents.
        approved_mcp_servers: [...Object.keys(tools.mcp_servers).filter((n) => tools.allowed.includes(toolPrefix(n))), ...(servers.docs ? [DOCS_SERVER] : [])],
        disabled_mcp_tools: disabled,
        // Codex's reviewer reviews the board's waits on its MCP server; a dynamic tool's call is the board's to ask about.
        review_waits: approvalsReviewer === "auto_review" && !dynamic,
        requests_on_output: takesInput,
        board_tools: given,
      }),
      ...(input.revertBeforeTurn === null ? {} : { revert_before_turn: input.revertBeforeTurn }),
      ...(rules === null ? {} : { approval_rules: rules }),
      ...(input.configOverrides.length > 0 ? { config_overrides: input.configOverrides } : {}),
    }
    // The board's server is left in `mcp.json` but for a session that has its tools as dynamic tools (a new one's, for
    // the adapter to give the thread only if Codex won't take them).
    const inProcess = dynamic && given === null
    const configDir = input.configDir !== null && input.configDir.trim() !== "" ? input.configDir : null
    const env: Array<readonly [string, string]> = [
      ...(input.tmp === null ? [] : [["TMPDIR", input.tmp] as const]),
      [TASK_ENV, task.id],
      ["HUNTAWAY_CODEX_BIN", input.codexBin],
      ...(configDir === null ? [] : [["CODEX_HOME", expand(configDir, input.home)] as const]),
    ]
    const spec: LaunchSpec = {
      program: input.exe,
      args: ["codex-run", `${input.runDir}/codex.json`],
      env,
      cwd: input.cwd,
      configDir: input.configDir,
      prompt,
      input: takesInput,
      promptId: null,
      systemPrompt: null,
      mcpServers: boardServers(input, servers, inProcess),
      mcpRun: { cwd: input.cwd, github_account: input.githubAccount, review, in_process: inProcess, desktop: servers.desktop },
      codex,
    }
    return { spec, codex, boardTools: given !== null }
  })

/** `~` expanded against `home`. */
const expand = (path: string, home: string) => (path === "~" ? home : path.startsWith("~/") ? `${home}${path.slice(1)}` : path)
