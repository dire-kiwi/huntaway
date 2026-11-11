import { decide, strict } from "@huntaway/shared"
import type { Decision, Rule, Rules } from "@huntaway/shared"
import { Predicate } from "effect"
import { BOARD_SERVER, DESKTOP_READS, DESKTOP_SERVER, GH_SERVER, LEGACY_BOARD_SERVER } from "../claude/access.ts"
import type { CodexPolicy } from "./spec.ts"
import { toolPrefix } from "./items.ts"

// A Codex run's MCP servers and approval rules (huntaway's agent/codex/adapter.ts `mcp_server_config` and
// agent/approval_rules.ts' Codex part; inventory 03, 2.13): the servers of the run's `mcp.json` as Codex's config takes
// them, changed to hold the user's rules, and what the rules do to the run's approval policy. Codex has no hook to hold
// a rule with, so its servers' configs ask (or turn a tool off), and a never rule on Codex's own tools refuses the run.

/** How long a board call may take: `wait` blocks for as long as it's asked to (an hour), and more besides. */
export const BOARD_TOOL_TIMEOUT_SEC = 3600 + 300

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => Predicate.isObject(v) && !Array.isArray(v)

/** The Google Workspace server the assistant is given: `uvx` fetches it the first time, slower than Codex's 10 s start. */
const isGoogle = (name: string): boolean => name === "google"

/** A Claude-style `mcpServers` entry as Codex's `mcp_servers` config, or null for one Codex can't run. */
export const mcpServerConfig = (
  name: string,
  c: unknown,
  approved: boolean,
  disabled: ReadonlyArray<string>,
  reviewWaits: boolean,
): Record<string, unknown> | null => {
  const out: Record<string, unknown> = {}
  const t = isRecord(c) ? c["type"] : undefined
  const type = typeof t === "string" ? t : "stdio"
  if (!isRecord(c)) return null
  if (type === "stdio") {
    if (c["command"] === undefined) return null
    out["command"] = c["command"]
    for (const k of ["args", "env"]) if (c[k] !== undefined && c[k] !== null) out[k] = c[k]
  } else if (type === "http" || type === "streamable-http") {
    if (c["url"] === undefined) return null
    out["url"] = c["url"]
    const headers = c["headers"]
    if (isRecord(headers) && Object.keys(headers).length > 0) out["http_headers"] = headers
  } else {
    return null
  }
  if (name === BOARD_SERVER) {
    // send_to_task and friends can take a while (setting up a worktree), and wait blocks for as long as it's asked to.
    out["tool_timeout_sec"] = BOARD_TOOL_TIMEOUT_SEC
  } else if (name === GH_SERVER) {
    out["tool_timeout_sec"] = 600
  } else if (isGoogle(name)) {
    out["startup_timeout_sec"] = 120
  }
  if (approved || name === BOARD_SERVER) out["default_tools_approval_mode"] = "approve"
  // Every wait goes to the reviewer, which sees its arguments: a wait's command runs as the agent's own commands would.
  if (name === BOARD_SERVER && reviewWaits) out["tools"] = { wait: { approval_mode: "prompt" } }
  if (name === DESKTOP_SERVER) {
    // Its read-only tools need no approval; its actions ask.
    out["tool_timeout_sec"] = 300
    out["tools"] = Object.fromEntries(DESKTOP_READS.map((tool) => [tool, { approval_mode: "approve" }]))
  }
  if (disabled.length > 0) out["disabled_tools"] = [...disabled]
  return out
}

/** Whether a pattern (lowercase) may match a tool of the server with tool prefix `prefix`. */
const mayMatchServer = (pattern: string, prefix: string): boolean => {
  const literal = pattern.split("*")[0] ?? ""
  const own = `${prefix}__`
  if (!pattern.includes("*")) return pattern === prefix || pattern.startsWith(own)
  return own.startsWith(literal) || literal.startsWith(own)
}

/**
 * Server `server`'s config for a Codex run with `rules` (already for its mode), changed to hold them: every call asks
 * when a rule that may match one asks or refuses, exact allow and ask rules approve or prompt their tool, exact never
 * rules turn theirs off. Null when a rule turns the whole server off. The board's own server is the board's to hold.
 */
export const codexServer = (rules: Rules, server: string, cfg: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | null => {
  if (server === BOARD_SERVER || server === LEGACY_BOARD_SERVER) return cfg
  const prefix = toolPrefix(server).toLowerCase()
  const mine = rules.rules.filter((r) => mayMatchServer(r.tool.toLowerCase(), prefix))
  if (mine.some((r) => r.decision === "never" && r.tool.toLowerCase() === prefix)) return null
  if (mine.length === 0) return cfg
  const exact = (d: Decision): ReadonlyArray<string> =>
    mine
      .filter((r) => r.decision === d && !r.tool.includes("*"))
      .map((r) => r.tool.toLowerCase())
      .filter((t) => t.startsWith(`${prefix}__`))
      .map((t) => t.slice(prefix.length + 2))
  const out: Record<string, unknown> = { ...cfg }
  const had = out["tools"]
  const tools: Record<string, unknown> = isRecord(had) ? { ...had } : {}
  if (strict(mine)) {
    // Every call asks, and the board answers by the rules.
    out["default_tools_approval_mode"] = "prompt"
    // A tool the server's config approves up front (the desktop's reads) asks too when a rule that asks or refuses
    // matches it, as the hook makes it on a Claude run; one no rule matches stays as it was.
    for (const [t, v] of Object.entries(tools)) {
      const r = decide(rules, `${prefix}__${t.toLowerCase()}`)
      if (isRecord(v) && v["approval_mode"] === "approve" && r !== null && r.decision !== "allow") Reflect.deleteProperty(tools, t)
    }
  }
  for (const [d, mode] of [
    ["allow", "approve"],
    ["ask", "prompt"],
  ] as const) {
    for (const t of exact(d)) {
      // Unless a stronger rule matches it too.
      if (decide(rules, `${prefix}__${t}`)?.decision === d) tools[t] = { approval_mode: mode }
    }
  }
  out["tools"] = tools
  const never = exact("never")
  if (never.length > 0) {
    const was = out["disabled_tools"]
    out["disabled_tools"] = [...(Array.isArray(was) ? was : []), ...never]
  }
  return out
}

/** Whether a rule may match one of an agent's own tools rather than an MCP server's (Bash, and Codex's ApplyPatch). */
const forOwnTools = (r: Rule): boolean => !r.tool.trim().toLowerCase().startsWith("mcp__")

/** Whether the run has the user rather than Codex's reviewer answer its approvals: the reviewer would answer ask rules itself. */
export const needsUserReviewer = (rules: Rules): boolean => rules.rules.some((r) => r.decision === "ask" || r.decision === "never")

/**
 * What a Codex run needs for the rules (already for its mode) on its own tools, which nothing can stop before they run:
 * true for an ask rule, so Codex asks about every command and file change it doesn't take as safe (approval policy
 * `untrusted`, never full access), and the board answers by the rules; or why it can't run, for a never rule, which
 * Codex can't hold (it runs the commands it takes as read-only without asking).
 */
export const ownTools = (rules: Rules): { readonly asks: boolean } | { readonly refused: string } => {
  const r = rules.rules.find((x) => x.decision === "never" && forOwnTools(x))
  if (r !== undefined) {
    return {
      refused:
        `The assistant's approval rule "${r.tool}: never" is for the agent's own tools, which Codex can't be stopped from using: ` +
        "it runs commands it takes as safe without asking. Change the rule to ask, or give the assistant a Claude config.",
    }
  }
  return { asks: rules.rules.some((x) => x.decision === "ask" && forOwnTools(x)) }
}

/**
 * A Codex run's policy with `rules` (already for its mode), from what its mode gives (`spec.ts`' `policy`): the user
 * rather than Codex's reviewer answers when a rule asks or refuses, and with a rule asking about its own tools it asks
 * about every command and file change it doesn't take as safe, never with full access. Why it can't run, for a never
 * rule on its own tools.
 */
export const codexPolicy = (rules: Rules | null, mode: CodexPolicy): { readonly policy: CodexPolicy } | { readonly refused: string } => {
  if (rules === null) return { policy: mode }
  let [policy, reviewer, sandbox] = mode
  if (needsUserReviewer(rules) && reviewer === "auto_review") reviewer = "user"
  const own = ownTools(rules)
  if ("refused" in own) return own
  if (own.asks) {
    policy = "untrusted"
    reviewer = "user"
    if (sandbox === "danger-full-access") sandbox = "workspace-write"
  }
  return { policy: [policy, reviewer, sandbox] }
}
