// Port of server/src/agent/approval_rules.rs (HA-123, on the HA-117 branch).
/**
 * Approval rules: for each tool or MCP server, the assistant may use it (allow), asks the user first (ask) or never does
 * (never), whatever its thread's permission mode. They're its profile's (`approval_rules:<profile id>` in the settings),
 * and they hold for the profile's assistant and the threads under it (see `applies_to`).
 *
 * How each runtime holds them (checked with Claude Code 2.1.317 and Codex 0.166):
 *
 * - **Claude:** a PreToolUse hook (`huntaway approval-hook`, see approval_rules/hook.ts) decides every call a rule
 *   matches. A hook's `ask` reaches the permission prompt tool in every mode, Bypass, Don't ask and Auto included (and
 *   even for a tool in `--allowedTools`), so the board passes `--permission-prompt-tool` in Bypass too, and its prompt
 *   (mcp/permissions.ts) asks the user whatever the mode, but denies in Don't ask. Its `deny` holds in Bypass. Tools a
 *   rule names exactly that are *never* go in `--disallowedTools` as well, so the agent doesn't see them. The hook is
 *   only installed for rules on tools other than the board's, and only for MCP tools unless a rule names another.
 * - **Codex:** a PreToolUse hook's `ask` fails open there, and hooks it hasn't been told to trust don't run, so the rules
 *   go in each MCP server's config instead: a server a rule may match asks about every call
 *   (`default_tools_approval_mode = "prompt"`), and the board's prompt decides by the rules (allow, ask the user, or
 *   deny); tools named exactly are approved or disabled up front. Codex's own reviewer would answer in Auto, so the
 *   assistant's Codex runs in Auto have the user as reviewer instead (they ask as in Ask). With an approval policy of
 *   `never` (Bypass and Don't ask), Codex refuses a call that asks: *ask* and *never* still hold, as refusals, but a tool
 *   allowed only by a pattern is refused too. Codex's own tools (Bash, ApplyPatch) can't be stopped before they run: an
 *   *ask* rule on them has it ask about everything it doesn't take as safe, and a *never* rule on them keeps the run
 *   from starting (see `codex_policy`).
 * - **The board's own tools** (create_task, wait and the rest) are decided by the board as it runs them (see
 *   mcp/tools/dispatch.ts's check_rules), for both. Those that always ask the user themselves (`ASKS_ITSELF`) aren't
 *   asked about again.
 */
import * as db from "../db.ts";
import type { Conn, Task } from "../db.ts";
import type { Shared } from "../state.ts";
import { new_id, now, path_str } from "../util.ts";
import * as runner from "./runner.ts";
import * as agent_tools from "./agent_tools.ts";
import type { Decision, Rule, Rules } from "./approval_rules/hook.ts";
import { BLOCKED, BOARD_SERVER_NAMES, HOOK_FAILED, decide, is_board_tool, parse_rule_list, rank, strict } from "./approval_rules/hook.ts";

export * from "./approval_rules/hook.ts";

function rule(tool: string, decision: Decision): Rule {
  return { tool, decision };
}

/** How long a prompt from a routine run waits for an answer by default, in minutes. */
export const DEFAULT_EXPIRY_MINUTES = 30;
/** The longest a prompt from a routine run can be set to wait: a week. */
export const MAX_EXPIRY_MINUTES = 7 * 24 * 60;
const MAX_RULES = 200;

/** `Rules::default()`: the default rules (see `default_rules`), with the default expiry. */
export function Rules_default(): Rules {
  return { rules: default_rules(), expiry_minutes: DEFAULT_EXPIRY_MINUTES };
}

/** Rules as serde reads them (`expiry_minutes` defaulting), else null. */
export function parse_rules(v: any): Rules | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const rules = parse_rule_list(v.rules);
  if (rules === null) return null;
  const e = v.expiry_minutes;
  if (e === undefined) return { rules, expiry_minutes: DEFAULT_EXPIRY_MINUTES };
  if (!Number.isInteger(e) || e < 0 || e > 0xffffffff) return null;
  return { rules, expiry_minutes: e };
}

/** The MCP server name the Google defaults are written for: the Google Workspace server the assistant is given (Gmail, Calendar and Drive) goes by it. */
export const GOOGLE_SERVER = "google";

/**
 * The rules a profile starts with: for the Google server, reading, searching and drafting are allowed; sending mail,
 * making, changing or deleting events, sharing files or handing them over, changing files, mail filters and mail's labels
 * (which is how mail goes to the trash) ask; deleting or trashing mail and files is never. The patterns fit the tool
 * names of the Google Workspace MCP server (`search_gmail_messages`, `send_gmail_message`, `create_event`,
 * `share_drive_file` and so on) and names like them.
 */
export function default_rules(): Rule[] {
  const g = (p: string) => `mcp__${GOOGLE_SERVER}__${p}`;
  const allow = ["search*", "get*", "list*", "read*", "check*", "query*", "*draft*"].map((p) => rule(g(p), "allow"));
  const ask = [
    "*send*", "create*event*", "modify*event*", "update*event*", "delete*event*", "*share*", "*add*permission*", "*update*permission*",
    "*remove*permission*", "set*permission*", "*message*label*", "manage*", "update*file*", "create*filter*", "*transfer*",
  ].map((p) => rule(g(p), "ask"));
  const never = ["*trash*", "*delete*mail*", "*mail*delete*", "*delete*message*", "*delete*file*", "*delete*drive*", "*drive*delete*"].map((p) =>
    rule(g(p), "never")
  );
  return [...allow, ...ask, ...never];
}

/** The board tools that create tasks, which an optional rule asks about (`create_task` makes scratch tasks too). */
export const CREATE_TASK_TOOLS = ["create_task"];

/**
 * The board's tools that ask the user to approve what they do whatever the thread's mode (see mcp/tools/approvals.ts): an
 * ask rule doesn't ask about them again (a never rule still refuses them). update_project asks only for some settings, so
 * an ask rule asks about it too.
 */
export const ASKS_ITSELF = ["delete_task", "create_project", "create_automation", "update_automation", "delete_automation"];

/**
 * The rule that decides the board's tool `tool` (e.g. `create_task`), named by the server's current name or an older
 * one, and the name it matched: the strongest, if several do.
 */
export function board_rule(rules: Rules, tool: string): [string, Rule] | null {
  let best: [string, Rule] | null = null;
  for (const n of BOARD_SERVER_NAMES.map((n) => `mcp__${n}__${tool}`)) {
    const r = decide(rules, n);
    // `max_by_key` keeps the last of equals.
    if (r && (best === null || rank(r.decision) >= rank(best[1].decision))) best = [n, r];
  }
  return best;
}

/** Checked and tidied for saving: patterns trimmed and empty ones dropped; a pattern given twice (whatever its case) is refused. Throws why not. */
export function checked(rules: Rules): Rules {
  const list = rules.rules.map((r) => ({ ...r, tool: r.tool.trim() })).filter((r) => r.tool !== "");
  // One rule for each tool or pattern: which of two would hold isn't for the board to guess.
  const seen = new Set<string>();
  const twice = list.find((r) => {
    const k = r.tool.toLowerCase();
    if (seen.has(k)) return true;
    seen.add(k);
    return false;
  });
  if (twice) throw new Error(`"${twice.tool}" has more than one rule: keep one for each tool or pattern`);
  if (list.length > MAX_RULES) throw new Error(`at most ${MAX_RULES} rules`);
  const bad = list.find((r) => Buffer.byteLength(r.tool) > 200 || /[\s\p{Cc}]/u.test(r.tool));
  if (bad) throw new Error(`"${bad.tool}" isn't a tool name or pattern: no spaces, and at most 200 characters`);
  if (rules.expiry_minutes > MAX_EXPIRY_MINUTES) throw new Error(`expiry_minutes is at most ${MAX_EXPIRY_MINUTES} (a week)`);
  return { rules: list, expiry_minutes: rules.expiry_minutes };
}

/** The rules for a run in `mode`: plan mode doesn't take allow rules, which would let a tool that changes things run while the agent is only meant to plan. */
export function for_mode(rules: Rules, mode: string): Rules {
  return { rules: rules.rules.filter((r) => mode !== "plan" || r.decision !== "allow").map((r) => ({ ...r })), expiry_minutes: rules.expiry_minutes };
}

function has(rules: Rules, d: Decision): boolean {
  return rules.rules.some((r) => r.decision === d);
}

function setting_key(profile_id: string): string {
  return `approval_rules:${profile_id}`;
}

/** A profile's rules: the ones saved, or else the defaults. */
export function get(c: Conn, profile_id: string): Rules {
  return saved(c, profile_id) ?? Rules_default();
}

/** The rules a profile saved, if it has. */
export function saved(c: Conn, profile_id: string): Rules | null {
  const v = db.get_setting(c, setting_key(profile_id));
  if (v === null) return null;
  try {
    return parse_rules(JSON.parse(v));
  } catch {
    return null;
  }
}

/** Save a profile's rules; null goes back to the defaults. */
export function set(c: Conn, profile_id: string, rules: Rules | null): void {
  db.set_setting(c, setting_key(profile_id), rules === null ? null : JSON.stringify(rules));
}

/** Whether the rules hold for `task`'s runs: its profile's assistant, and threads under it. */
export function applies_to(c: Conn, task: Task): boolean {
  if (db.is_assistant(task)) return true;
  if (task.parent_id == null) return false;
  const p = db.get_task(c, task.parent_id);
  return !!p && db.is_assistant(p);
}

/** The rules for `task`'s runs, if they hold for it (see `applies_to`). */
export function for_task(c: Conn, task: Task): Rules | null {
  return applies_to(c, task) ? get(c, task.profile_id) : null;
}

// ---------- Claude ----------

/** The hook's rules: those it decides, which are all but the board's tools' (see `is_board_tool`). */
function hook_rules(rules: Rules): Rule[] {
  return rules.rules.filter((r) => !is_board_tool(r.tool));
}

/**
 * The PreToolUse hook entry for a Claude run with `rules` (already for its mode, see `for_mode`), if it has any for the
 * hook: `'<exe>' approval-hook '<rules>'`.
 */
export function claude_hook(exe: string, rules: Rules): any | null {
  const own = hook_rules(rules);
  if (own.length === 0) return null;
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  let command = `${quote(path_str(exe))} approval-hook ${quote(JSON.stringify(own))}`;
  // Claude Code lets a call through when its hook fails, so with rules that ask or refuse, a hook that can't run at all
  // (this binary moved, say) refuses it (exit 2). The hook does the same when it fails itself (see `hook`).
  if (strict(own)) command += ` || { echo ${quote(HOOK_FAILED)} >&2; exit 2; }`;
  // It answers at once: asking is the permission prompt's (the board's), not the hook's.
  return { matcher: claude_matcher(own), hooks: [{ type: "command", command, timeout: 30 }] };
}

/**
 * The hook's matcher (a regular expression Claude Code tests tool names with) for `rules`: the MCP servers they name, so
 * that other tools' calls (the board's, say) don't pay for starting it (HA-245), else every tool, for a rule that isn't
 * for an MCP server's. It may match more than the rules do (the hook checks the name again), never less: a call it
 * misses goes through as though no rule matched it. So it's case-insensitive, as `matches` is, by hand (`[gG]`, as a
 * matcher has no flags), and anchored at both ends, so it means the same whether Claude Code anchors it or not.
 */
export function claude_matcher(rules: Rule[]): string {
  const alts = new Set<string>();
  for (const r of rules) {
    const p = r.tool.trim().toLowerCase();
    if (!p.startsWith("mcp__")) return "*";
    const rest = p.slice(5);
    const star = rest.indexOf("*"), sep = rest.indexOf("__");
    // A pattern in the server's name matches whatever starts with what comes before it; otherwise the rule is for the
    // server or its tools.
    const in_server = star >= 0 && (sep < 0 || star < sep);
    const prefix = in_server ? p.slice(0, 5 + star) : `mcp__${sep < 0 ? rest : rest.slice(0, sep)}`;
    // Not one that other cases of a non-ASCII letter could match (MCP servers' names have none).
    if (/[^\x00-\x7f]/.test(prefix)) return "*";
    alts.add(any_case(prefix) + (in_server ? "[\\s\\S]*" : "(?:__[\\s\\S]*)?"));
  }
  return `^(?:${[...alts].join("|")})$`;
}

/**
 * Lowercase ASCII `s` as a regular expression matching every name that lowercases to it: each letter either case, and the
 * two other characters whose lowercase has an ASCII letter in it (the Kelvin sign's is k, and İ's is i and a dot above).
 * Characters with a meaning in a regular expression are escaped, and no others, as an escape that means nothing is an
 * error under the `u` flag.
 */
function any_case(s: string): string {
  let out = "";
  for (const c of s) {
    if (c === "k") out += "[kK\\u212A]";
    else if (c === "i") out += "[iI\\u0130]";
    else if (c >= "a" && c <= "z") out += `[${c}${c.toUpperCase()}]`;
    else if (/[\\^$.*+?()[\]{}|/]/.test(c)) out += `\\${c}`;
    else out += c;
  }
  return out;
}

/** `--disallowedTools` for a Claude run with `rules`: the tools and servers a rule names exactly that are never, so the agent doesn't get them at all. */
export function claude_disallowed(rules: Rules): string[] {
  return hook_rules(rules)
    .filter((r) => r.decision === "never" && !r.tool.includes("*"))
    .map((r) => r.tool);
}

/** Whether a Claude run with `rules` needs the board's permission prompt even in Bypass, where it otherwise has none: a hook's ask goes to it. */
export function needs_prompt_tool(rules: Rules): boolean {
  return hook_rules(rules).some((r) => r.decision === "ask");
}

/** A Claude message with tool results (`v`, as the run streamed it): the calls the hook blocked go in the action log. */
export function on_tool_results(s: Shared, task: Task, v: any): void {
  const blocks: any[] = Array.isArray(v?.message?.content) ? v.message.content : [];
  for (const b of blocks.filter((b) => b?.type === "tool_result" && b?.is_error === true)) {
    let text: string;
    if (typeof b.content === "string") text = b.content;
    else if (Array.isArray(b.content)) text = b.content.filter((p: any) => typeof p?.text === "string").map((p: any) => p.text).join("\n");
    else continue;
    if (!text.includes(BLOCKED)) continue;
    if (typeof b.tool_use_id !== "string") continue;
    const use = tool_use(s, task.id, b.tool_use_id);
    if (!use) continue;
    const [tool, input] = use;
    // Only a call the hook blocked: one a never rule decides, of a tool the hook decides (the board logs its own), and
    // not some other tool's output that happens to quote the reason.
    let rules: Rules | null;
    try {
      rules = for_task(s.db(), task);
    } catch {
      continue;
    }
    if (!rules) continue;
    const r = decide(rules, tool);
    if (!r || r.decision !== "never" || is_board_tool(tool)) continue;
    try {
      log_blocked(s, task, tool, input, r.tool);
    } catch (e) {
      console.warn(`task ${task.id}: logging a blocked call: ${e}`);
    }
  }
}

/** The name and input of tool call `id` in `task_id`'s thread. */
function tool_use(s: Shared, task_id: string, id: string): [string, any] | null {
  let rows: Array<{ data: string }>;
  try {
    rows = db.all(s.db(), "SELECT data FROM messages WHERE task_id=?1 AND kind='claude' AND instr(data, ?2) > 0 ORDER BY id DESC LIMIT 5", task_id, id);
  } catch {
    return null;
  }
  for (const { data } of rows) {
    let v: any;
    try {
      v = JSON.parse(data);
    } catch {
      continue;
    }
    if (!Array.isArray(v?.message?.content)) continue;
    const b = v.message.content.find((b: any) => b?.type === "tool_use" && b?.id === id);
    if (b) return [typeof b.name === "string" ? b.name : "unknown", b.input ?? null];
  }
  return null;
}

// ---------- Codex ----------

/** Server `server`'s config for a Codex run with `rules` (already for its mode), changed to hold them (see the module docs). False if a rule turns the whole server off. */
export function codex_server(rules: Rules, server: string, cfg: Record<string, any>): boolean {
  if (server === runner.MCP_SERVER_NAME || server === runner.LEGACY_MCP_SERVER_NAME) return true;
  const prefix = agent_tools.tool_prefix(server).toLowerCase();
  const mine = rules.rules.filter((r) => may_match_server(r.tool.toLowerCase(), prefix));
  if (mine.some((r) => r.decision === "never" && r.tool.toLowerCase() === prefix)) return false;
  if (mine.length === 0) return true;
  const exact = (d: Decision): string[] =>
    mine
      .filter((r) => r.decision === d && !r.tool.includes("*"))
      .map((r) => r.tool.toLowerCase())
      .filter((t) => t.startsWith(`${prefix}__`))
      .map((t) => t.slice(prefix.length + 2));
  if (strict(mine)) {
    // Every call asks, and the board answers by the rules.
    cfg.default_tools_approval_mode = "prompt";
  }
  cfg.tools ??= {};
  const tools = cfg.tools;
  for (const [d, mode] of [["allow", "approve"], ["ask", "prompt"]] as const) {
    for (const t of exact(d)) {
      // Unless a stronger rule matches it too.
      if (decide(rules, `${prefix}__${t}`)?.decision === d) tools[t] = { approval_mode: mode };
    }
  }
  const never = exact("never");
  if (never.length) {
    const disabled: any[] = Array.isArray(cfg.disabled_tools) ? [...cfg.disabled_tools] : [];
    disabled.push(...never);
    cfg.disabled_tools = disabled;
  }
  return true;
}

/** Whether a pattern (lowercase) may match a tool of the server with tool prefix `prefix`. */
function may_match_server(pattern: string, prefix: string): boolean {
  const literal = pattern.split("*")[0] ?? "";
  const own = `${prefix}__`;
  if (!pattern.includes("*")) return pattern === prefix || pattern.startsWith(own);
  return own.startsWith(literal) || literal.startsWith(own);
}

/** Whether the assistant's Codex runs with `rules` have the user rather than Codex's reviewer answer its approvals: the reviewer would answer ask rules itself. */
export function codex_needs_user_reviewer(rules: Rules): boolean {
  return has(rules, "ask") || has(rules, "never");
}

/**
 * A Codex run's (approval policy, approvals reviewer, sandbox) with `rules` (already for its mode), from what its mode
 * gives (see codex.policy): the user rather than Codex's reviewer answers when a rule asks or refuses (the reviewer would
 * answer them itself), and with a rule asking about its own tools it asks about every command and file change it doesn't
 * take as safe, never with full access (see `codex_own_tools`, which also says when it can't run at all, by throwing).
 */
export function codex_policy(rules: Rules | null, mode: [string, string, string]): [string, string, string] {
  let [policy, reviewer, sandbox] = mode;
  if (!rules) return mode;
  if (codex_needs_user_reviewer(rules) && reviewer === "auto_review") reviewer = "user";
  if (codex_own_tools(rules)) {
    [policy, reviewer] = ["untrusted", "user"];
    if (sandbox === "danger-full-access") sandbox = "workspace-write";
  }
  return [policy, reviewer, sandbox];
}

/** Whether a rule may match one of an agent's own tools rather than an MCP server's (Bash, and Codex's ApplyPatch, as the board asks about them). */
function for_own_tools(r: Rule): boolean {
  return !r.tool.trim().toLowerCase().startsWith("mcp__");
}

/**
 * What a Codex run needs for the rules (already for its mode) on its own tools, which nothing can stop before they run:
 * true for an ask rule, so Codex asks about every command and file change it doesn't take as safe (approval policy
 * `untrusted`, never full access), and the board answers by the rules; or it throws why it can't run, for a never rule,
 * which Codex can't hold (it runs the commands it takes as read-only without asking, and has other ways to run code,
 * such as its JavaScript tool, checked with Codex 0.166).
 */
export function codex_own_tools(rules: Rules): boolean {
  const r = rules.rules.find((r) => r.decision === "never" && for_own_tools(r));
  if (r) {
    throw new Error(
      `The assistant's approval rule "${r.tool}: never" is for the agent's own tools, which Codex can't be stopped from using: ` +
        "it runs commands it takes as safe without asking. Change the rule to ask, or give the assistant a Claude config.",
    );
  }
  return rules.rules.some((r) => r.decision === "ask" && for_own_tools(r));
}

// ---------- the action log ----------

/** A call that hit an ask or never rule. */
export interface Action {
  id: string;
  task_id: string;
  request_id: string | null;
  tool_name: string;
  /** What it was called with, in a line. */
  summary: string;
  /** The rule that matched it. */
  rule: string;
  /** ask or never. */
  decision: string;
  /** pending, allowed, denied, expired or blocked. */
  outcome: string;
  /**
   * Who answered: `user` (on the board), `push` (from a notification), `expiry` (nobody, in time), `mode` (Don't ask),
   * `rule` (a never rule), or `ended` (its run ended first).
   */
  answered_by: string | null;
  created_at: string;
  decided_at: string | null;
}

/** Most entries listed at once. */
export const MAX_LISTED = 500;
/** How many entries a profile keeps: older ones go. */
const KEEP = 5000;

/** A run of characters cut to `n`, whitespace and all on one line. */
function cut(s: string, n: number): string {
  const one = s.split(/\s+/).filter(Boolean).join(" ");
  const chars = [...one];
  return chars.length > n ? `${chars.slice(0, n).join("")}…` : one;
}

/**
 * A tool input in a line: its fields and values, each cut short. Codex's prompts for an MCP tool (see codex/adapter.ts)
 * give the tool's arguments beside its question, and only those are shown.
 */
export function summarize(input: any): string {
  const is_obj = (v: any) => !!v && typeof v === "object" && !Array.isArray(v);
  if (is_obj(input) && is_obj(input.arguments) && "message" in input) return summarize(input.arguments);
  let text: string;
  if (is_obj(input)) {
    // In key order, as serde_json's map keeps them.
    text = Object.entries(input)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => `${k}: ${cut(typeof v === "string" ? v : JSON.stringify(v), 80)}`)
      .join(", ");
  } else if (input === null || input === undefined) text = "";
  else text = JSON.stringify(input);
  return cut(text, 300);
}

/** Log a call that rule `r` asked about, raised as prompt `request_id`. */
export function log_asked(c: Conn, task: Task, request_id: string, tool: string, input: any, r: Rule): void {
  insert(c, task, request_id, tool, input, r.tool, r.decision, "pending", null);
}

/** Log a call a never rule (`pattern`) turned away. */
export function log_blocked(s: Shared, task: Task, tool: string, input: any, pattern: string): void {
  insert(s.db(), task, null, tool, input, pattern, "never", "blocked", "rule");
  emit(s, task);
}

/** Log a call that rule `r` decided without asking (a never, or an ask that the mode denied). */
export function log_decided(s: Shared, task: Task, tool: string, input: any, r: Rule, outcome: string, by: string): void {
  insert(s.db(), task, null, tool, input, r.tool, r.decision, outcome, by);
  emit(s, task);
}

function insert(c: Conn, task: Task, request_id: string | null, tool: string, input: any, rule: string, d: Decision, outcome: string, by: string | null): void {
  const at = now();
  const decided = outcome !== "pending" ? at : null;
  db.run(
    c,
    `INSERT INTO approval_log (id,profile_id,task_id,request_id,tool_name,summary,rule,decision,outcome,answered_by,created_at,decided_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`,
    new_id(), task.profile_id, task.id, request_id, tool, summarize(input), rule, d, outcome, by, at, decided,
  );
  db.run(
    c,
    "DELETE FROM approval_log WHERE profile_id=?1 AND id NOT IN (SELECT id FROM approval_log WHERE profile_id=?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2)",
    task.profile_id, KEEP,
  );
}

/** Prompt `request_id` was answered (`outcome`: allowed, denied or expired) by `by`: its log entry says so. */
export function settle(s: Shared, request_id: string, outcome: string, by: string): void {
  const c = s.db();
  const n = db.run(
    c,
    "UPDATE approval_log SET outcome=?2, answered_by=?3, decided_at=?4 WHERE request_id=?1 AND outcome='pending'",
    request_id, outcome, by, now(),
  ).changes;
  if (n === 0) return;
  const task_id = db.value<string>(c, "SELECT task_id FROM approval_log WHERE request_id=?1", request_id);
  const t = task_id !== undefined ? db.get_task(c, task_id) : null;
  if (t) emit(s, t);
}

/** The UI's action log changed for `task`'s profile. */
function emit(s: Shared, task: Task): void {
  s.emit({ type: "approval_log", profile_id: task.profile_id, task_id: task.id });
}

/** A profile's action log, newest first. */
export function list(c: Conn, profile_id: string, limit: number): Action[] {
  return db.all<Action>(
    c,
    `SELECT id,task_id,request_id,tool_name,summary,rule,decision,outcome,answered_by,created_at,decided_at FROM approval_log
     WHERE profile_id=?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2`,
    profile_id, Math.min(Math.max(limit, 1), MAX_LISTED),
  );
}
