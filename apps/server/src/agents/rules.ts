import { Effect } from "effect"
import { Invalid } from "@huntaway/contracts"
import { BLOCKED, BOARD_SERVER_NAMES, decide, field, HOOK_FAILED, isBoardTool, rank, strict } from "@huntaway/shared"
import type { Decision, Rule, Rules } from "@huntaway/shared"
import { toJson } from "../platform/columns.ts"

// What the server does with approval rules beyond matching them (`@huntaway/shared` matches them): the defaults, the
// checks before saving, the action log's summary of a call, and what a Claude run is launched with to hold them
// (docs/plan/inventory/02-agent-support.md 2.6). Plain functions, from huntaway's agent/approval_rules.ts; the
// `ApprovalRules` service beside them stores and logs. Codex's side (`codex_server`, `codex_policy`) comes with Codex (5.3).

/** How long a prompt from a routine run waits for an answer by default, in minutes. */
export const DEFAULT_EXPIRY_MINUTES = 30
/** The longest a prompt from a routine run can be set to wait: a week. */
export const MAX_EXPIRY_MINUTES = 7 * 24 * 60
/** The most rules a profile keeps. */
export const MAX_RULES = 200
/** The longest a pattern may be, in bytes. */
const MAX_PATTERN_BYTES = 200

/** The board's MCP server's name. */
export const BOARD_SERVER = BOARD_SERVER_NAMES[0] ?? "huntaway"

/** The MCP server name the Google defaults are written for: the Google Workspace server the assistant is given goes by it. */
export const GOOGLE_SERVER = "google"

/** The board tools that create tasks, which an optional rule asks about (`create_task` makes scratch tasks too). */
export const CREATE_TASK_TOOLS: ReadonlyArray<string> = ["create_task"]

/**
 * The board's tools that ask the user to approve what they do whatever the thread's mode (`Approvals`): an ask rule
 * doesn't ask about them again (a never rule still refuses them). update_project asks only for some settings, so an ask
 * rule asks about it too.
 */
export const ASKS_ITSELF: ReadonlyArray<string> = ["delete_task", "create_project", "create_automation", "update_automation", "delete_automation"]

const rule = (tool: string, decision: Decision): Rule => ({ tool, decision })

/** A pattern for the Google server's tools. */
const g = (pattern: string) => `mcp__${GOOGLE_SERVER}__${pattern}`

/**
 * The rules a profile starts with: for the Google server, reading, searching and drafting are allowed; sending mail,
 * making, changing or deleting events, sharing files or handing them over, changing files, mail filters and mail's labels
 * (which is how mail goes to the trash) ask; deleting or trashing mail and files is never. The patterns fit the tool
 * names of the Google Workspace MCP server (`search_gmail_messages`, `send_gmail_message`, `create_event`,
 * `share_drive_file` and so on) and names like them.
 */
export const defaultRules = (): ReadonlyArray<Rule> => {
  const allow = ["search*", "get*", "list*", "read*", "check*", "query*", "*draft*"].map((p) => rule(g(p), "allow"))
  const ask = [
    "*send*",
    "create*event*",
    "modify*event*",
    "update*event*",
    "delete*event*",
    "*share*",
    "*add*permission*",
    "*update*permission*",
    "*remove*permission*",
    "set*permission*",
    "*message*label*",
    "manage*",
    "update*file*",
    "create*filter*",
    "*transfer*",
  ].map((p) => rule(g(p), "ask"))
  const never = ["*trash*", "*delete*mail*", "*mail*delete*", "*delete*message*", "*delete*file*", "*delete*drive*", "*drive*delete*"].map((p) =>
    rule(g(p), "never"),
  )
  return [...allow, ...ask, ...never]
}

/** The defaults, with the default expiry. */
export const defaultRuleSet = (): Rules => ({ rules: defaultRules(), expiry_minutes: DEFAULT_EXPIRY_MINUTES })

/**
 * The rule that decides the board's tool `tool` (e.g. `create_task`), named by the server's current name or an older
 * one, and the name it matched: the strongest, if several do (the last of equals).
 */
export const boardRule = (rules: Rules, tool: string): { readonly name: string; readonly rule: Rule } | null => {
  let best: { readonly name: string; readonly rule: Rule } | null = null
  for (const name of BOARD_SERVER_NAMES.map((n) => `mcp__${n}__${tool}`)) {
    const r = decide(rules, name)
    if (r !== null && (best === null || rank(r.decision) >= rank(best.rule.decision))) best = { name, rule: r }
  }
  return best
}

/** How many bytes `s` takes in UTF-8. */
const utf8Length = (s: string): number => {
  let n = 0
  for (const c of s) {
    const code = c.codePointAt(0) ?? 0
    n += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return n
}

/**
 * Checked and tidied for saving: patterns trimmed and empty ones dropped; a pattern given twice (whatever its case) is
 * refused, as which of two would hold isn't for the board to guess.
 */
export const checkRules = (rules: Rules): Effect.Effect<Rules, Invalid> => {
  const list = rules.rules.map((r) => ({ ...r, tool: r.tool.trim() })).filter((r) => r.tool !== "")
  const seen = new Set<string>()
  const twice = list.find((r) => {
    const k = r.tool.toLowerCase()
    if (seen.has(k)) return true
    seen.add(k)
    return false
  })
  if (twice !== undefined)
    return Effect.fail(new Invalid({ field: "rules", reason: `"${twice.tool}" has more than one rule: keep one for each tool or pattern` }))
  if (list.length > MAX_RULES) return Effect.fail(new Invalid({ field: "rules", reason: `at most ${MAX_RULES} rules` }))
  const bad = list.find((r) => utf8Length(r.tool) > MAX_PATTERN_BYTES || /[\s\p{Cc}]/u.test(r.tool))
  if (bad !== undefined) {
    return Effect.fail(
      new Invalid({ field: "rules", reason: `"${bad.tool}" isn't a tool name or pattern: no spaces, and at most ${MAX_PATTERN_BYTES} characters` }),
    )
  }
  if (!Number.isInteger(rules.expiry_minutes) || rules.expiry_minutes < 0 || rules.expiry_minutes > MAX_EXPIRY_MINUTES) {
    return Effect.fail(new Invalid({ field: "expiry_minutes", reason: `expiry_minutes is from 0 to ${MAX_EXPIRY_MINUTES} (a week)` }))
  }
  return Effect.succeed({ rules: list, expiry_minutes: rules.expiry_minutes })
}

// ---------- the action log ----------

/** A run of characters cut to `n`, whitespace and all on one line. */
const cut = (s: string, n: number): string => {
  const one = s.split(/\s+/).filter(Boolean).join(" ")
  const chars = Array.from(one)
  return chars.length > n ? `${chars.slice(0, n).join("")}…` : one
}

const isObject = (v: unknown): v is object => typeof v === "object" && v !== null && !Array.isArray(v)

/**
 * A tool input in a line, for the action log: its fields and values in key order, each cut short. Codex's prompts for
 * an MCP tool give the tool's arguments beside its question, and only those are shown.
 */
export const summarize = (input: unknown): Effect.Effect<string> =>
  Effect.gen(function* () {
    const args = field(input, "arguments")
    if (isObject(input) && isObject(args) && "message" in input) return yield* summarize(args)
    if (input === null || input === undefined) return ""
    if (!isObject(input)) return cut(yield* toJson(input), 300)
    const parts: Array<string> = []
    for (const [k, v] of Object.entries(input).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (v === null || v === undefined) continue
      parts.push(`${k}: ${cut(typeof v === "string" ? v : yield* toJson(v), 80)}`)
    }
    return cut(parts.join(", "), 300)
  })

/**
 * The tool calls a Claude message with tool results (a `user` line of the run's output) says the approval hook
 * blocked: the ids of its error results that carry the BLOCKED text. Whoever follows the run looks each up and gives
 * it to `ApprovalRules.blocked`, which logs the ones a never rule really decides.
 */
export const blockedToolUses = (message: unknown): ReadonlyArray<string> => {
  const content = field(field(message, "message"), "content")
  if (!Array.isArray(content)) return []
  const ids: Array<string> = []
  for (const block of content) {
    if (field(block, "type") !== "tool_result" || field(block, "is_error") !== true) continue
    const body = field(block, "content")
    const text =
      typeof body === "string"
        ? body
        : Array.isArray(body)
          ? body
              .map((part) => field(part, "text"))
              .filter((t) => typeof t === "string")
              .join("\n")
          : null
    const id = field(block, "tool_use_id")
    if (text !== null && text.includes(BLOCKED) && typeof id === "string") ids.push(id)
  }
  return ids
}

// ---------- Claude ----------

/** A PreToolUse hook entry of Claude Code's `--settings`. */
export interface ClaudeHook {
  readonly matcher: string
  readonly hooks: ReadonlyArray<{ readonly type: "command"; readonly command: string; readonly timeout: number }>
}

/** `s` quoted for the shell. */
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`

/** The hook's rules: those it decides, which are all but the board's tools' (the board decides those as it runs them). */
const hookRules = (rules: Rules): ReadonlyArray<Rule> => rules.rules.filter((r) => !isBoardTool(r.tool))

/**
 * The PreToolUse hook entry for a Claude run with `rules` (already for its mode, see `forMode`), if it has any for the
 * hook: `'<exe>' approval-hook '<rules json>'`, `exe` being the launcher (`HUNTAWAY_EXE`).
 */
export const claudeHook = (exe: string, rules: Rules): Effect.Effect<ClaudeHook | null> =>
  Effect.gen(function* () {
    const own = hookRules(rules)
    if (own.length === 0) return null
    let command = `${quote(exe)} approval-hook ${quote(yield* toJson(own))}`
    // Claude Code lets a call through when its hook fails, so with rules that ask or refuse, a hook that can't run at all
    // (this binary moved, say) refuses it (exit 2). The hook does the same when it fails itself, having said why, so
    // then it isn't said again.
    if (strict(own)) command += ` || { [ $? -eq 2 ] || echo ${quote(HOOK_FAILED)} >&2; exit 2; }`
    // It answers at once: asking is the permission prompt's (the board's), not the hook's.
    return { matcher: claudeMatcher(own), hooks: [{ type: "command", command, timeout: 30 }] }
  })

/** Whether `s` is all ASCII. */
const isAscii = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false
  return true
}

/**
 * Lowercase ASCII `s` as a regular expression matching every name that lowercases to it: each letter either case, and the
 * two other characters whose lowercase has an ASCII letter in it (the Kelvin sign's is k, and İ's is i and a dot above).
 * Characters with a meaning in a regular expression are escaped, and no others, as an escape that means nothing is an
 * error under the `u` flag.
 */
const anyCase = (s: string): string => {
  let out = ""
  for (const c of s) {
    if (c === "k") out += "[kK\\u212A]"
    else if (c === "i") out += "[iI\\u0130]"
    else if (c >= "a" && c <= "z") out += `[${c}${c.toUpperCase()}]`
    else if (/[\\^$.*+?()[\]{}|/]/.test(c)) out += `\\${c}`
    else out += c
  }
  return out
}

/**
 * The hook's matcher (a regular expression Claude Code tests tool names with) for `rules`: the MCP servers they name, so
 * that other tools' calls (the board's, say) don't pay for starting it (HA-245), else every tool, for a rule that isn't
 * for an MCP server's. It may match more than the rules do (the hook checks the name again), never less: a call it
 * misses goes through as though no rule matched it. So it's case-insensitive, as `matches` is, by hand (`[gG]`, as a
 * matcher has no flags), and anchored at both ends, so it means the same whether Claude Code anchors it or not.
 */
export const claudeMatcher = (rules: ReadonlyArray<Rule>): string => {
  const alts = new Set<string>()
  for (const r of rules) {
    const p = r.tool.trim().toLowerCase()
    if (!p.startsWith("mcp__")) return "*"
    const rest = p.slice(5)
    const star = rest.indexOf("*")
    const sep = rest.indexOf("__")
    // A pattern in the server's name matches whatever starts with what comes before it; otherwise the rule is for the
    // server or its tools.
    const inServer = star >= 0 && (sep < 0 || star < sep)
    const prefix = inServer ? p.slice(0, 5 + star) : `mcp__${sep < 0 ? rest : rest.slice(0, sep)}`
    // Not one that other cases of a non-ASCII letter could match (MCP servers' names have none).
    if (!isAscii(prefix)) return "*"
    alts.add(anyCase(prefix) + (inServer ? "[\\s\\S]*" : "(?:__[\\s\\S]*)?"))
  }
  return `^(?:${[...alts].join("|")})$`
}

/** `--disallowedTools` for a Claude run with `rules`: the tools and servers a rule names exactly that are never, so the agent doesn't get them at all. */
export const claudeDisallowed = (rules: Rules): ReadonlyArray<string> =>
  hookRules(rules)
    .filter((r) => r.decision === "never" && !r.tool.includes("*"))
    .map((r) => r.tool)

/** Whether a Claude run with `rules` needs the board's permission prompt tool even in Bypass, where it otherwise has none: a hook's ask goes to it. */
export const needsPromptTool = (rules: Rules): boolean => hookRules(rules).some((r) => r.decision === "ask")

/**
 * The PreToolUse hook entry for a Claude run with the board's gh server: `'<exe>' gh-hook` on Bash, which turns away gh
 * in Bash (it may not reach GitHub from the sandbox, or would act as gh's active account rather than the run's).
 */
export const ghHook = (exe: string): ClaudeHook => ({ matcher: "Bash", hooks: [{ type: "command", command: `${quote(exe)} gh-hook`, timeout: 10 }] })

/** `--settings` with a Claude run's PreToolUse hooks (`ghHook`, `claudeHook`), in the order given. */
export const hookSettings = (hooks: ReadonlyArray<ClaudeHook>): Effect.Effect<string> => toJson({ hooks: { PreToolUse: hooks } })
