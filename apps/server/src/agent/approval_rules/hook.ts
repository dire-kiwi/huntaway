// Port of the rules and the hook of server/src/agent/approval_rules.rs (HA-123, on the HA-117 branch).
/**
 * The approval rules themselves (what a rule is, which rule decides a tool) and `huntaway approval-hook <rules>`, Claude
 * Code's PreToolUse hook that holds them in the assistant's Claude runs (see approval_rules.ts, which re-exports all of
 * this).
 *
 * The hook runs once for every tool call a rule may match, so `bin/huntaway approval-hook` runs it straight from
 * `hook_main.ts`, as it runs `mcp_main.ts`: this file imports nothing, not even the server's `util.ts`, so Node loads
 * only these two. The few constants it needs from other modules are mirrored below, and `approval_rules.test.ts` checks
 * that they match.
 */

// ---------- constants mirrored from the modules that own them (see approval_rules.test.ts) ----------

/** runner::MCP_SERVER_NAME, runner::LEGACY_MCP_SERVER_NAME, and the name before them. */
const MIRRORED_BOARD_NAMES = ["huntaway", "issue_agent", "issue-agent"] as const;
/** permissions::ASK_USER and permissions::CODEX_QUESTIONS (see permissions::is_question). */
const MIRRORED_QUESTIONS = ["AskUserQuestion", "request_user_input"];
/** permissions::EXIT_PLAN */
const MIRRORED_EXIT_PLAN = "ExitPlanMode";

/** What a rule does with the calls it matches, weakest first: when several match, the strongest wins. */
export type Decision = "allow" | "ask" | "never";

export const DECISIONS: Decision[] = ["allow", "ask", "never"];

/** How strong a decision is (Rust's `Ord` on `Decision`): allow, then ask, then never. */
export function rank(d: Decision): number {
  return DECISIONS.indexOf(d);
}

export interface Rule {
  /**
   * A tool's name (`mcp__google__send_gmail_message`, `Bash`), an MCP server's prefix for all its tools (`mcp__google`),
   * or a pattern where `*` stands for anything (`mcp__google__*delete*`), matched without regard to case.
   */
  tool: string;
  decision: Decision;
}

/** A profile's rules, and how long its routine runs' prompts wait (see permissions::expiry). */
export interface Rules {
  rules: Rule[];
  /** Minutes until a prompt raised by a routine run is denied; 0 never. */
  expiry_minutes: number;
}

/** A rule as serde reads one: `{tool, decision}`, else null. */
export function parse_rule(v: any): Rule | null {
  if (!v || typeof v !== "object" || Array.isArray(v) || typeof v.tool !== "string" || !DECISIONS.includes(v.decision)) return null;
  return { tool: v.tool, decision: v.decision };
}

/** A list of rules as serde reads one (`Vec<Rule>`), else null. */
export function parse_rule_list(v: any): Rule[] | null {
  if (!Array.isArray(v)) return null;
  const out: Rule[] = [];
  for (const r of v) {
    const rule = parse_rule(r);
    if (!rule) return null;
    out.push(rule);
  }
  return out;
}

/** Whether `pattern` matches tool `tool` (see Rule.tool). */
export function matches(pattern: string, tool: string): boolean {
  const p = pattern.trim().toLowerCase(), t = tool.toLowerCase();
  if (p === "") return false;
  if (!p.includes("*")) return t === p || (p.startsWith("mcp__") && !p.slice(5).includes("__") && t.startsWith(p) && t.slice(p.length).startsWith("__"));
  return glob(p, t);
}

/** `*` matches any run of characters, everything else itself. */
function glob(p: string, t: string): boolean {
  let pi = 0, ti = 0;
  let star = -1, mark = 0;
  while (ti < t.length) {
    if (pi < p.length && p[pi] === "*") {
      star = pi;
      mark = ti;
      pi += 1;
    } else if (pi < p.length && p[pi] === t[ti]) {
      pi += 1;
      ti += 1;
    } else if (star >= 0) {
      pi = star + 1;
      mark += 1;
      ti = mark;
    } else {
      return false;
    }
  }
  return [...p.slice(pi)].every((c) => c === "*");
}

/** The names the board's MCP server goes by, now and before (a rule may use any). */
export const BOARD_SERVER_NAMES: readonly string[] = MIRRORED_BOARD_NAMES;

/** Whether `tool` is one of the board's own (decided by the board as it runs them, see mcp/tools/dispatch.ts's check_rules). */
export function is_board_tool(tool: string): boolean {
  const t = tool.toLowerCase();
  return BOARD_SERVER_NAMES.some((n) => t.startsWith(`mcp__${n}__`) || t === `mcp__${n}`);
}

/** Whether rules hold for `tool` at all: questions and plans only ever go to the user. */
function ruled(tool: string): boolean {
  return !MIRRORED_QUESTIONS.includes(tool) && tool !== MIRRORED_EXIT_PLAN;
}

/** The rule that decides `tool`: the strongest of those that match it (never, then ask, then allow), the first of those given. */
export function decide(rules: Rules, tool: string): Rule | null {
  if (!ruled(tool)) return null;
  let best: Rule | null = null;
  for (const r of rules.rules) {
    if (matches(r.tool, tool) && (best === null || rank(r.decision) > rank(best.decision))) best = r;
  }
  return best;
}

// ---------- the hook ----------

/** What a blocked call's result starts with (see `hook_decision`), by which the runner finds it in the agent's output and logs it (see `on_tool_results`). */
export const BLOCKED = "Blocked by the user's approval rules";

/** The reason a call that rule `pattern` sets to never is turned away with. */
export function blocked_reason(pattern: string): string {
  return (
    `${BLOCKED} (never: ${pattern}). Don't retry it or try another way to do the same thing: carry on without it, and tell the user ` +
    "what you couldn't do."
  );
}

/** Whether any of `rules` asks or refuses, so that a call they can't be checked for is refused. */
export function strict(rules: Iterable<Rule>): boolean {
  for (const r of rules) if (r.decision !== "allow") return true;
  return false;
}

/** Why a call is refused when the hook couldn't check the rules. */
export const HOOK_FAILED =
  "The user's approval rules couldn't be checked for this call (their hook failed), so it was refused. " +
  "Don't try another way to do the same thing: tell the user the rules' hook isn't working.";

/** What the hook answers for a call (its input), if a rule decides it. */
export function hook_decision(rules: Rules, call: any): any | null {
  const tool = call?.tool_name;
  if (typeof tool !== "string") return null;
  if (is_board_tool(tool)) return null;
  const r = decide(rules, tool);
  if (!r) return null;
  let decision: string, reason: string;
  if (r.decision === "allow") [decision, reason] = ["allow", `Allowed by the user's approval rules (${r.tool})`];
  else if (r.decision === "ask") [decision, reason] = ["ask", `The user's approval rules ask them first (${r.tool})`];
  else [decision, reason] = ["deny", blocked_reason(r.tool)];
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } };
}

/** Reads all of stdin. */
async function read_stdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * `huntaway approval-hook <rules>`: Claude Code's PreToolUse hook for the assistant's runs, which decides the calls the
 * rules match (`<rules>` is their JSON list).
 *
 * It fails closed: with rules that ask or refuse (or ones it can't read), a call it can't decide (its input unreadable,
 * or the hook failing in any way) is refused, with exit code 2, which is how a PreToolUse hook blocks a call. With only
 * allow rules, the call goes on to the run's own permissions, as it would without them. Returns the exit code, having
 * written what it answers (to stdout) or why it refused (to stderr).
 */
export async function hook(rules: string | undefined, input: () => Promise<string> = read_stdin): Promise<number> {
  let parsed: Rule[] | null = null;
  try {
    parsed = parse_rule_list(JSON.parse(rules ?? ""));
  } catch {}
  let out: any | null;
  try {
    if (parsed === null) throw new Error("its rules can't be read");
    const call = JSON.parse(await input());
    if (typeof call?.tool_name !== "string") throw new Error("the call has no tool name");
    out = hook_decision({ rules: parsed, expiry_minutes: 0 }, call);
  } catch {
    // Failed: refused, unless only allow rules hold (which then just don't allow).
    if (parsed === null || strict(parsed)) {
      process.stderr.write(`${HOOK_FAILED}\n`);
      return 2;
    }
    out = null;
  }
  if (out !== null) process.stdout.write(`${JSON.stringify(out)}\n`);
  return 0;
}
