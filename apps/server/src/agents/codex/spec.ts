import { parseRuleList } from "@huntaway/shared"
import type { Rules } from "@huntaway/shared"
import { Predicate } from "effect"
import { DEFAULT_EXPIRY_MINUTES } from "../rules.ts"

// What a Codex run is started with (huntaway's agent/codex.ts; inventory 01, section 3 "Codex Spec"): `codex.json` in
// the run's folder, which the adapter (`huntaway codex-run`, codex-run.ts) reads, and which also marks the run as
// Codex's. The launch decides it (`launch.ts`); the adapter turns it into `thread/start`'s parameters (`threadParams`).
// Like the rest of a run's folder it is a stable format: read back leniently (`specFromJson`), as serde read it.

/** What a run needs from the launch, saved as `codex.json`. */
export interface CodexSpec {
  readonly cwd: string
  /** The Codex thread to resume (the task's session id). */
  readonly thread_id: string | null
  readonly model: string | null
  readonly effort: string | null
  readonly approval_policy: string
  readonly approvals_reviewer: string
  /** `read-only`, `workspace-write` or `danger-full-access`. */
  readonly sandbox: string
  /** Codex's plan mode (collaboration mode `plan`). */
  readonly plan: boolean
  /** Compact the conversation instead of running a prompt. */
  readonly compact: boolean
  readonly developer_instructions: string
  /** Stdin is stream-json input (a user message, an interrupt, an answer to a request), not just the prompt. */
  readonly input: boolean
  /** Writable on top of the working directory (e.g. a worktree's git directory). */
  readonly writable_roots: ReadonlyArray<string>
  /**
   * With a `read-only` sandbox, paths to `write` besides the temp directories (a reviewer's build output and caches)
   * and paths inside those to keep `read`, through a permission profile (`REVIEW_PROFILE`). The most specific path wins.
   */
  readonly filesystem: Readonly<Record<string, string>>
  /** Holds the project's skills, one directory each. */
  readonly skills_dir: string | null
  /** MCP servers whose tools run without asking (the board's always does). */
  readonly approved_mcp_servers: ReadonlyArray<string>
  /** MCP tools the agent doesn't get, by server (a reviewer's gh tools that write). */
  readonly disabled_mcp_tools: Readonly<Record<string, ReadonlyArray<string>>>
  /** Codex's reviewer reviews the board's `wait` calls on its MCP server (auto mode), command included. */
  readonly review_waits: boolean
  /**
   * The app-server's requests (approvals, questions, the board's tools) go to the run's output as they are, and their
   * answers come back on its input (`{"type": "codex_response", "id", "result" | "error"}`). Only with `input`.
   */
  readonly requests_on_output: boolean
  /** The board's tools as a `namespace` dynamic tool for a new thread (`requests.ts`'s `boardTools`); null to give none. */
  readonly board_tools: Readonly<Record<string, unknown>> | null
  /** Revert the thread to before this turn first (a rewind's `before_turn`). Left out when there's none. */
  readonly revert_before_turn?: string
  /** The user's approval rules, which its MCP servers' configs hold (`rules.ts`' `codexServer`). Left out when there are none. */
  readonly approval_rules?: Rules
  /** Config overrides for its app-server (`codex -c key=value app-server`): telemetry's. Left out when there are none. */
  readonly config_overrides?: ReadonlyArray<string>
}

/** `Spec::default()`, with `fields` over it. */
export const defaultSpec = (fields: Partial<CodexSpec> = {}): CodexSpec => ({
  cwd: "",
  thread_id: null,
  model: null,
  effort: null,
  approval_policy: "",
  approvals_reviewer: "",
  sandbox: "",
  plan: false,
  compact: false,
  developer_instructions: "",
  input: false,
  writable_roots: [],
  filesystem: {},
  skills_dir: null,
  approved_mcp_servers: [],
  disabled_mcp_tools: {},
  review_waits: false,
  requests_on_output: false,
  board_tools: null,
  ...fields,
})

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => Predicate.isObject(v) && !Array.isArray(v)
const strings = (v: unknown): ReadonlyArray<string> => (Array.isArray(v) && v.every((s) => typeof s === "string") ? v : [])
const optString = (v: unknown): string | null => (typeof v === "string" ? v : null)

/** Approval rules as serde read them (`expiry_minutes` defaulting), else null. */
export const parseRules = (v: unknown): Rules | null => {
  if (!isRecord(v)) return null
  const rules = parseRuleList(v["rules"])
  if (rules === null) return null
  const e = v["expiry_minutes"]
  if (e === undefined) return { rules, expiry_minutes: DEFAULT_EXPIRY_MINUTES }
  return typeof e === "number" && Number.isInteger(e) && e >= 0 ? { rules, expiry_minutes: e } : null
}

/** Whether a value is a `namespace` dynamic tool. */
const isNamespace = (v: unknown): v is Readonly<Record<string, unknown>> =>
  isRecord(v) && v["type"] === "namespace" && typeof v["name"] === "string" && Array.isArray(v["tools"])

/** A `codex.json` read back (serde's defaults for missing fields), or null if it isn't one. */
export const specFromJson = (v: unknown): CodexSpec | null => {
  if (!isRecord(v)) return null
  const cwd = v["cwd"]
  const policy = v["approval_policy"]
  const reviewer = v["approvals_reviewer"]
  const sandbox = v["sandbox"]
  if (typeof cwd !== "string" || typeof policy !== "string" || typeof reviewer !== "string" || typeof sandbox !== "string") return null
  const filesystem: Record<string, string> = {}
  if (isRecord(v["filesystem"])) for (const [k, x] of Object.entries(v["filesystem"])) if (typeof x === "string") filesystem[k] = x
  const disabled: Record<string, ReadonlyArray<string>> = {}
  if (isRecord(v["disabled_mcp_tools"])) for (const [k, x] of Object.entries(v["disabled_mcp_tools"])) disabled[k] = strings(x)
  const instructions = v["developer_instructions"]
  const tools = v["board_tools"]
  let spec: CodexSpec = defaultSpec({
    cwd,
    thread_id: optString(v["thread_id"]),
    model: optString(v["model"]),
    effort: optString(v["effort"]),
    approval_policy: policy,
    approvals_reviewer: reviewer,
    sandbox,
    plan: v["plan"] === true,
    compact: v["compact"] === true,
    developer_instructions: typeof instructions === "string" ? instructions : "",
    input: v["input"] === true,
    writable_roots: strings(v["writable_roots"]),
    filesystem,
    skills_dir: optString(v["skills_dir"]),
    approved_mcp_servers: strings(v["approved_mcp_servers"]),
    disabled_mcp_tools: disabled,
    review_waits: v["review_waits"] === true,
    requests_on_output: v["requests_on_output"] === true,
    board_tools: isNamespace(tools) ? tools : null,
  })
  const revert = v["revert_before_turn"]
  if (typeof revert === "string") spec = { ...spec, revert_before_turn: revert }
  const overrides = strings(v["config_overrides"])
  if (overrides.length > 0) spec = { ...spec, config_overrides: overrides }
  const raw = v["approval_rules"]
  if (raw !== undefined && raw !== null) {
    // Rules it can't read: the run doesn't start, rather than without them.
    const rules = parseRules(raw)
    if (rules === null) return null
    spec = { ...spec, approval_rules: rules }
  }
  return spec
}

/** Codex's approval policy, its approvals' reviewer and its sandbox. */
export type CodexPolicy = readonly [policy: string, reviewer: string, sandbox: string]

/**
 * How a permission mode runs under Codex. Reviewers get a read-only sandbox (they read and report) and run what fits in
 * it unasked; `CodexSpec.filesystem` lets them build and test in it.
 */
export const policy = (mode: string, review: boolean): CodexPolicy => {
  if (mode === "bypassPermissions") return ["never", "user", "danger-full-access"]
  if (review) return ["never", "user", "read-only"]
  switch (mode) {
    case "dontAsk":
      return ["never", "user", "workspace-write"]
    case "acceptEdits":
      return ["on-request", "user", "workspace-write"]
    // Codex's own reviewer decides, like Claude's auto mode.
    case "auto":
      return ["on-request", "auto_review", "workspace-write"]
    case "plan":
      return ["untrusted", "user", "read-only"]
    default:
      return ["untrusted", "user", "workspace-write"]
  }
}

/**
 * The permission profile of a read-only sandbox with `CodexSpec.filesystem`: it reads everything and writes only the temp
 * directories and the paths given, so a reviewer can run the tests without being able to change the work.
 */
export const REVIEW_PROFILE = "huntaway-review"

/** Whether the run's sandbox is the review profile's: read-only with paths to write. */
export const usesProfile = (spec: CodexSpec): boolean => spec.sandbox === "read-only" && Object.keys(spec.filesystem).length > 0

/** The `thread/start` (and `thread/resume`) parameters for a run, with `servers` as its MCP servers. */
export const threadParams = (spec: CodexSpec, cwd: string, servers: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  const config: Record<string, unknown> = {
    mcp_servers: servers,
    // The plan tool, shown as a todo list.
    "tools.update_plan.enabled": true,
  }
  const profile = usesProfile(spec)
  if (profile) {
    // A profile replaces the sandbox settings, which mustn't be given alongside it.
    const fs: Record<string, string> = { ":tmpdir": "write", ":slash_tmp": "write", ...spec.filesystem }
    config["default_permissions"] = REVIEW_PROFILE
    config["permissions"] = { [REVIEW_PROFILE]: { extends: ":read-only", filesystem: fs, network: { enabled: true } } }
  } else {
    // Agents need the network (git push, gh, package managers), as Claude's do.
    config["sandbox_workspace_write"] =
      spec.writable_roots.length > 0 ? { network_access: true, writable_roots: spec.writable_roots } : { network_access: true }
  }
  return {
    cwd,
    approvalPolicy: spec.approval_policy,
    approvalsReviewer: spec.approvals_reviewer,
    config,
    developerInstructions: spec.developer_instructions,
    ...(profile ? {} : { sandbox: spec.sandbox }),
    ...(spec.model === null ? {} : { model: spec.model }),
  }
}

/** Whether `model` names a Claude model, so a Codex thread shouldn't inherit it from its project, profile or host. */
export const isClaudeModel = (model: string): boolean => {
  const m = model.trim().toLowerCase()
  return ["fable", "opus", "sonnet", "haiku", "default", "opusplan"].includes(m) || m.startsWith("claude")
}
