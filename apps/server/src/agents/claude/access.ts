import { BOARD_SERVER_NAMES } from "@huntaway/shared"
import type { PermissionMode, Task } from "@huntaway/contracts"

// What a run may use (huntaway's agent/runner/access.ts; inventory 01, section 5): the board's tools, GitHub's, the
// desktop's and the docs server's, and what a reviewer may not touch. Plain functions over what the launch knows.
// The parts that run git (a Codex reviewer's sandbox: `git_common_dir`, `ignored_dirs`) and list Codex's models
// (`codex_run_effort`) are the Codex driver's (M5), and the notes that tell an agent about the servers are in
// `prompts/` (`ghNote`, `docsNote`, `desktopNote`).

/** The board's own MCP server. */
export const BOARD_SERVER = BOARD_SERVER_NAMES[0] ?? "huntaway"
/** Its name before the rename to Huntaway: runs started by an older build call its tools `mcp__issue_agent__<tool>`. */
export const LEGACY_BOARD_SERVER = BOARD_SERVER_NAMES[1] ?? "issue_agent"
/** The board's gh server (huntaway's mcp/gh_mcp.ts). */
export const GH_SERVER = "gh"
/** The board's docs server (mcp/docs_mcp.ts). */
export const DOCS_SERVER = "docs"
/** The board's desktop server (mcp/desktop_mcp.ts). */
export const DESKTOP_SERVER = "desktop"

/** The gh server's tools that only read, so they run without asking (`--allowedTools mcp__gh__<name>`). */
export const GH_READ_ONLY: ReadonlyArray<string> = ["pr_view", "pr_list", "pr_checks", "pr_diff", "issue_view", "issue_list", "run_list", "run_view"]
/** The rest, which reviewers don't get. */
export const GH_WRITES: ReadonlyArray<string> = ["pr_create", "pr_comment", "pr_edit", "pr_merge", "issue_create", "issue_comment", "api", "gh", "git_push"]
/** The desktop's tools that only look. */
export const DESKTOP_READS: ReadonlyArray<string> = ["health", "apps", "windows", "read", "screen", "zoom", "verify", "op_status"]
/** The desktop's tools that change something, which ask first unless the run may do anything. */
export const DESKTOP_WRITES: ReadonlyArray<string> = ["act", "launch", "clipboard"]

/** What a reviewer may use without asking (huntaway's review.ts `ALLOWED_TOOLS`): reading, and git and gh that only read. */
export const REVIEW_ALLOWED: ReadonlyArray<string> = [
  "Read",
  "Grep",
  "Glob",
  "Skill",
  "Agent",
  "Task",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git status:*)",
  "Bash(git merge-base:*)",
  "Bash(git rev-parse:*)",
  "Bash(gh pr view:*)",
  "Bash(gh pr diff:*)",
  "Bash(gh pr list:*)",
  "Bash(gh pr checks:*)",
]
/** What a reviewer doesn't get: it reads and reports, and doesn't change the work. */
export const REVIEW_DISALLOWED: ReadonlyArray<string> = ["Edit", "Write", "NotebookEdit"]

/** What a run in a project gets on top of the board's own setup (huntaway's agent_tools `RunTools`, the project's skills and servers). */
export interface RunTools {
  /** Directory holding `.claude/skills`, for `--add-dir`. */
  readonly skills_dir: string | null
  /** Extra `mcpServers` entries. */
  readonly mcp_servers: Readonly<Record<string, unknown>>
  /** For `--allowedTools`. */
  readonly allowed: ReadonlyArray<string>
  /** For `--disallowedTools`. */
  readonly disallowed: ReadonlyArray<string>
}

/** Nothing on top of the board's own: what a run gets until the project's tools are ported (`AgentTools`). */
export const noRunTools: RunTools = { skills_dir: null, mcp_servers: {}, allowed: [], disallowed: [] }

/** How Claude Code names a server in its tool names (`mcp__<name>__<tool>`). */
export const toolPrefix = (server: string): string => `mcp__${server.replaceAll(/[^A-Za-z0-9_-]/gu, "_")}`

/**
 * The board tools a Claude run gets without asking (`--allowedTools`). In auto mode that's each of `tools` (the board
 * server's tool names) but `wait`, so Claude's classifier reviews each wait as it does the agent's Bash calls: a
 * wait's command runs like one of them.
 */
export const boardToolsAllowed = (mode: PermissionMode, tools: ReadonlyArray<string>): ReadonlyArray<string> =>
  mode !== "auto" ? [`mcp__${BOARD_SERVER}`] : tools.filter((t) => t !== "wait").map((t) => `mcp__${BOARD_SERVER}__${t}`)

/**
 * Whether Claude itself approved the `wait` calls of the run with these launch arguments (in auto mode, see
 * `boardToolsAllowed`), so a wait's command needs no prompt of ours. Not for a Codex run, one in another mode, or one
 * that pre-approves `wait` under the board's current or old server name, like an auto run started by an older build.
 */
export const approvesOwnWaits = (args: ReadonlyArray<string>): boolean => {
  const auto = args.some((a, i) => a === "--permission-mode" && args[i + 1] === "auto")
  const at = args.indexOf("--allowedTools")
  if (at < 0 || !auto) return false
  const preApproved = new Set([BOARD_SERVER, LEGACY_BOARD_SERVER].flatMap((n) => [`mcp__${n}`, `mcp__${n}__wait`]))
  const listed: Array<string> = []
  for (const a of args.slice(at + 1)) {
    if (a.startsWith("--")) break
    listed.push(...a.split(/[, ]/))
  }
  return !listed.some((t) => preApproved.has(t))
}

/**
 * The gh server's tools a Claude run uses without asking: the read-only ones, and `pr_merge` while its task is merging,
 * since moving the task to "Ready for merge" was the user's say-so. Allowed tools skip auto mode's classifier too, so
 * a merge doesn't stall when it fails.
 */
export const ghAllowed = (task: Pick<Task, "merging" | "kind">): ReadonlyArray<string> =>
  task.merging && task.kind === "task" ? [...GH_READ_ONLY, "pr_merge"] : GH_READ_ONLY

/**
 * Whether a run gets one of the board's HTTP servers (`gh`, `docs`, `desktop`): the board serves it (`served`: computer
 * use is on for the desktop's), and the project neither turns it off nor has its own by that name.
 */
export const usesServer = (tools: RunTools, name: string, served: boolean): boolean =>
  served && !Object.hasOwn(tools.mcp_servers, name) && !tools.disallowed.includes(toolPrefix(name))

/**
 * The desktop tools a run may use without asking: the read-only ones. The rest ask (in Bypass, nothing asks). A
 * reviewer gets only the read-only ones (`desktopDisallowed`); a run in plan mode gets them all, and the server
 * refuses the ones that act until its plan is approved, since the run goes on after.
 */
export const desktopAllowed = (): ReadonlyArray<string> => DESKTOP_READS.map((t) => `mcp__${DESKTOP_SERVER}__${t}`)

/** The desktop tools a run doesn't get: the ones that act, for a reviewer (the server refuses them too). */
export const desktopDisallowed = (review: boolean): ReadonlyArray<string> => (review ? DESKTOP_WRITES : [])

/** Trimmed, or null when blank. */
const set = (s: string | null | undefined): string | null => {
  const t = s?.trim()
  return t === undefined || t === "" ? null : t
}

/** The GitHub account a run's gh tools act as: the project's, or else its profile's. */
export const githubAccount = (project: { readonly github_account: string | null } | null, profile: { readonly github_account: string | null }): string | null =>
  (project === null ? null : set(project.github_account)) ?? set(profile.github_account)

/** The nearest effort Claude has to one only Codex models offer. */
export const claudeEffort = (effort: string): string => (effort === "ultra" ? "max" : effort === "minimal" ? "low" : effort)

/** A Codex model as `codex app-server` lists it: what a run's effort is checked against. */
export interface CodexModel {
  readonly id: string
  readonly is_default: boolean
  readonly efforts: ReadonlyArray<string>
  readonly default_effort: string | null
}

/**
 * A Codex run's effort, if its model (or the default model) takes it; otherwise that model's own default. Models that
 * don't say which efforts they take take any.
 */
export const codexEffort = (effort: string | null, model: string | null, models: ReadonlyArray<CodexModel>): string | null => {
  const m = model !== null ? models.find((x) => x.id === model) : (models.find((x) => x.is_default) ?? models[0])
  if (effort !== null && m !== undefined && m.efforts.length > 0 && !m.efforts.includes(effort)) return m.default_effort
  return effort
}

/**
 * Package managers' caches, which Codex's `workspace-write` sandbox would otherwise keep read-only (so `npm ci`, say,
 * fails): in the home directory, or where the environment says (`env`, e.g. `CARGO_HOME` for a system-wide Cargo). The
 * caller makes each that is missing, parents and all, and keeps those it could.
 */
export const cacheDirsIn = (home: string, env: (name: string) => string | null): ReadonlyArray<string> => {
  const base = (name: string, fallback: string) => {
    const e = env(name)
    return e !== null && e.startsWith("/") ? e : `${home}/${fallback}`
  }
  const cargo = base("CARGO_HOME", ".cargo")
  const data = base("XDG_DATA_HOME", ".local/share")
  return [base("XDG_CACHE_HOME", ".cache"), `${home}/.npm`, `${cargo}/registry`, `${cargo}/git`, `${data}/pnpm`]
}

/** Strings by their UTF-8 bytes, as Rust's BTreeMap orders its keys. */
const byBytes = (a: string, b: string): number => {
  const encoder = new TextEncoder()
  const [x, y] = [encoder.encode(a), encoder.encode(b)]
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d
  }
  return x.length - y.length
}

/**
 * A Codex reviewer's sandbox filesystem: it writes `write` and reads `work` (its working and git directories), which
 * stay read-only even inside a cache or temp directory (a test server's). Sorted by path.
 */
export const reviewFilesystem = (write: ReadonlyArray<string>, work: ReadonlyArray<string>): Readonly<Record<string, "read" | "write">> => {
  const m = new Map<string, "read" | "write">()
  for (const p of write) m.set(p, "write")
  for (const p of work) m.set(p, "read")
  return Object.fromEntries([...m.keys()].toSorted(byBytes).map((k) => [k, m.get(k) ?? "read"]))
}
