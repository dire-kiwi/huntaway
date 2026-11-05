import { enc, type Http } from "./http";
import { type Host, hostSupports } from "./hosts";

/** Approval rules (API 112): what a profile's assistant may do (allow), asks first (ask) or never does, per tool or MCP
 *  server, whatever its thread's mode; prompts from routine runs expire; and an action log of the calls the rules asked
 *  about or turned away (see server-ts/src/agent/approval_rules.ts). */
export const APPROVAL_RULES_API = 112;

export const hasApprovalRules = (h: Host | undefined) => hostSupports(h, APPROVAL_RULES_API);

export type RuleDecision = "allow" | "ask" | "never";

export const RULE_DECISIONS: RuleDecision[] = ["allow", "ask", "never"];

export type ApprovalRule = {
  /** A tool's name (`mcp__google__send_gmail_message`, `Bash`), an MCP server's prefix for all its tools (`mcp__google`), or a
   *  pattern where `*` stands for anything (`mcp__google__*delete*`), matched without regard to case. */
  tool: string;
  decision: RuleDecision;
};

export type ApprovalRules = {
  rules: ApprovalRule[];
  /** Minutes until a prompt raised by a routine run is denied; 0 never. */
  expiry_minutes: number;
  /** They're the defaults: the profile hasn't changed them. */
  is_default: boolean;
  defaults: { rules: ApprovalRule[]; expiry_minutes: number };
  /** The board's MCP server's name, whose tools a rule names as `mcp__<board_server>__<tool>`. */
  board_server: string;
  /** The MCP server name the Google defaults are for. */
  google_server: string;
  /** The board's tools that create tasks, which an optional rule asks about. */
  create_task_tools: string[];
};

/** A call that hit an ask or never rule. */
export type ApprovalAction = {
  id: string;
  task_id: string;
  request_id: string | null;
  tool_name: string;
  /** What it was called with, in a line. */
  summary: string;
  /** The rule that matched it. */
  rule: string;
  decision: "ask" | "never";
  outcome: "pending" | "allowed" | "denied" | "expired" | "blocked";
  /** `user` (on the board), `push` (a notification), `expiry` (nobody, in time), `mode` (Don't ask), `rule`, or `ended` (its
   *  run ended first). */
  answered_by: string | null;
  created_at: string;
  decided_at: string | null;
};

/** Which rule decides `tool`: the strongest that matches it (never, then ask, then allow), as the server has it. */
export function ruleFor(rules: ApprovalRule[], tool: string): ApprovalRule | undefined {
  const rank = { allow: 0, ask: 1, never: 2 };
  let best: ApprovalRule | undefined;
  for (const r of rules) if (ruleMatches(r.tool, tool) && (!best || rank[r.decision] > rank[best.decision])) best = r;
  return best;
}

export function ruleMatches(pattern: string, tool: string): boolean {
  const p = pattern.trim().toLowerCase();
  const t = tool.toLowerCase();
  if (!p) return false;
  if (!p.includes("*")) return t === p || (p.startsWith("mcp__") && !p.slice(5).includes("__") && t.startsWith(`${p}__`));
  const re = new RegExp(`^${p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s");
  return re.test(t);
}

export const approvalRulesApi = ({ on }: Http) => ({
  approvalRules: (h: string, profileId: string) => on(h).get<ApprovalRules>(`/profiles/${enc(profileId)}/approval-rules`),
  /** Save them (either may be left out, keeping it), or with `reset` go back to the defaults. They hold from the next run on. */
  setApprovalRules: (h: string, profileId: string, body: { rules?: ApprovalRule[]; expiry_minutes?: number; reset?: boolean }) =>
    on(h).post<ApprovalRules>(`/profiles/${enc(profileId)}/approval-rules`, body),
  approvalLog: (h: string, profileId: string, limit = 200) => on(h).get<ApprovalAction[]>(`/profiles/${enc(profileId)}/approval-log?limit=${limit}`),
});
