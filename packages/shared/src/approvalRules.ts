// Approval rules (docs/plan/inventory/02-agent-support.md 2.6, 03-mcp.md 2.13): what a rule is, which rule decides a
// tool, and what `huntaway approval-hook` answers for a call. From huntaway's agent/approval_rules/{rules,hook}.ts.
// Plain TypeScript: the hook loads this for every tool call a rule may match, and the board's UI decides by it as the
// server does, so it imports nothing.

/** The board's MCP server's name, now and before (a rule may use any). The server's `huntaway`; `issue_agent` and `issue-agent` came before it. */
export const BOARD_SERVER_NAMES: ReadonlyArray<string> = ["huntaway", "issue_agent", "issue-agent"]

/** Claude Code's question tool and Codex's: only ever the user's (Permissions' `isQuestion`). */
export const QUESTION_TOOLS: ReadonlyArray<string> = ["AskUserQuestion", "request_user_input"]

/** The tool a plan is put to the user with: only ever the user's. */
export const EXIT_PLAN_TOOL = "ExitPlanMode"

/** What a rule does with the calls it matches, weakest first: when several match, the strongest wins. */
export type Decision = "allow" | "ask" | "never"

export const DECISIONS: ReadonlyArray<Decision> = ["allow", "ask", "never"]

/** How strong a decision is: allow, then ask, then never. */
export const rank = (d: Decision): number => DECISIONS.indexOf(d)

export interface Rule {
  /**
   * A tool's name (`mcp__google__send_gmail_message`, `Bash`), an MCP server's prefix for all its tools (`mcp__google`),
   * or a pattern where `*` stands for anything (`mcp__google__*delete*`), matched without regard to case.
   */
  readonly tool: string
  readonly decision: Decision
}

/** A profile's rules, and how long its routine runs' prompts wait. */
export interface Rules {
  readonly rules: ReadonlyArray<Rule>
  /** Minutes until a prompt raised by a routine run is denied; 0 never. */
  readonly expiry_minutes: number
}

/** A field of a JSON object, if `v` is one and has it. */
export const field = (v: unknown, key: string): unknown =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? Object.getOwnPropertyDescriptor(v, key)?.value : undefined

const isDecision = (v: unknown): v is Decision => v === "allow" || v === "ask" || v === "never"

/** A rule as JSON has it (`{tool, decision}`, other keys ignored), else null. */
export const parseRule = (v: unknown): Rule | null => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null
  const tool = field(v, "tool")
  const decision = field(v, "decision")
  return typeof tool === "string" && isDecision(decision) ? { tool, decision } : null
}

/** A list of rules as JSON has it, else null (one bad rule spoils the list). */
export const parseRuleList = (v: unknown): ReadonlyArray<Rule> | null => {
  if (!Array.isArray(v)) return null
  const out: Array<Rule> = []
  for (const item of v) {
    const rule = parseRule(item)
    if (rule === null) return null
    out.push(rule)
  }
  return out
}

/** `*` matches any run of characters, everything else itself. */
const glob = (p: string, t: string): boolean => {
  let pi = 0
  let ti = 0
  let star = -1
  let mark = 0
  while (ti < t.length) {
    if (pi < p.length && p[pi] === "*") {
      star = pi
      mark = ti
      pi += 1
    } else if (pi < p.length && p[pi] === t[ti]) {
      pi += 1
      ti += 1
    } else if (star >= 0) {
      pi = star + 1
      mark += 1
      ti = mark
    } else {
      return false
    }
  }
  return /^\**$/.test(p.slice(pi))
}

/** Whether `pattern` matches tool `tool` (see `Rule.tool`). */
export const matches = (pattern: string, tool: string): boolean => {
  const p = pattern.trim().toLowerCase()
  const t = tool.toLowerCase()
  if (p === "") return false
  if (!p.includes("*")) return t === p || (p.startsWith("mcp__") && !p.slice(5).includes("__") && t.startsWith(p) && t.slice(p.length).startsWith("__"))
  return glob(p, t)
}

/** Whether `tool` is one of the board's own, which the board decides as it runs them, not the hook. */
export const isBoardTool = (tool: string): boolean => {
  const t = tool.toLowerCase()
  return BOARD_SERVER_NAMES.some((n) => t.startsWith(`mcp__${n}__`) || t === `mcp__${n}`)
}

/** Whether rules hold for `tool` at all: questions and plans only ever go to the user. */
const ruled = (tool: string): boolean => !QUESTION_TOOLS.includes(tool) && tool !== EXIT_PLAN_TOOL

/** The rule that decides `tool`: the strongest of those that match it (never, then ask, then allow), the first of equals. */
export const decide = (rules: Rules, tool: string): Rule | null => {
  if (!ruled(tool)) return null
  let best: Rule | null = null
  for (const r of rules.rules) {
    if (matches(r.tool, tool) && (best === null || rank(r.decision) > rank(best.decision))) best = r
  }
  return best
}

/** The rules for a run in `mode`: plan mode takes no allow rules, which would let a tool that changes things run while the agent only plans. */
export const forMode = (rules: Rules, mode: string): Rules => ({
  rules: rules.rules.filter((r) => mode !== "plan" || r.decision !== "allow"),
  expiry_minutes: rules.expiry_minutes,
})

/** Whether any of `rules` asks or refuses, so that a call they can't be checked for is refused. */
export const strict = (rules: Iterable<Rule>): boolean => {
  for (const r of rules) if (r.decision !== "allow") return true
  return false
}

// ---------- the hook ----------

/** What a blocked call's result starts with, by which the board finds it in the agent's output and logs it. */
export const BLOCKED = "Blocked by the user's approval rules"

/** The reason a call that rule `pattern` sets to never is turned away with. */
export const blockedReason = (pattern: string): string =>
  `${BLOCKED} (never: ${pattern}). Don't retry it or try another way to do the same thing: carry on without it, and tell the user what you couldn't do.`

/** Why a call is refused when the hook couldn't check the rules. */
export const HOOK_FAILED =
  "The user's approval rules couldn't be checked for this call (their hook failed), so it was refused. " +
  "Don't try another way to do the same thing: tell the user the rules' hook isn't working."

/** What a PreToolUse hook prints to decide a call. */
export interface HookAnswer {
  readonly hookSpecificOutput: {
    readonly hookEventName: "PreToolUse"
    readonly permissionDecision: "allow" | "ask" | "deny"
    readonly permissionDecisionReason: string
  }
}

/** The tool a hook's input (Claude Code's PreToolUse JSON) names, if it names one. */
export const hookTool = (call: unknown): string | null => {
  const tool = field(call, "tool_name")
  return typeof tool === "string" ? tool : null
}

/** What the hook answers for a call (its input), if a rule decides it. The board's own tools are the board's to decide. */
export const hookDecision = (rules: Rules, call: unknown): HookAnswer | null => {
  const tool = hookTool(call)
  if (tool === null || isBoardTool(tool)) return null
  const r = decide(rules, tool)
  if (r === null) return null
  const [permissionDecision, permissionDecisionReason] =
    r.decision === "allow"
      ? (["allow", `Allowed by the user's approval rules (${r.tool})`] as const)
      : r.decision === "ask"
        ? (["ask", `The user's approval rules ask them first (${r.tool})`] as const)
        : (["deny", blockedReason(r.tool)] as const)
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason } }
}
