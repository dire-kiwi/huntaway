// Port of server/src/agent/codex.rs.
/**
 * Codex agents. A thread whose config is for Codex (see db::AGENTS) runs `huntaway
 * codex-run` under ia-shim instead of `claude -p`. That adapter starts `codex app-server`,
 * speaks its JSON-RPC protocol (JSONL over stdio), and runs one turn: it starts or resumes the
 * thread, sends the prompt, answers approval requests by asking the board (the same
 * `permission_prompt` call the MCP helper makes for Claude), and exits once the turn ends.
 *
 * With `Spec::input`, its stdin takes the same stream-json input as Claude Code's (see
 * runner::steer): the prompt is the first user message, a message that arrives during the
 * turn is steered into it (`turn/steer`), one that arrives between turns starts the next turn,
 * and an `interrupt` control request interrupts the turn. It echoes each message back (as
 * `--replay-user-messages` does) once the model has taken it in, and exits when its input
 * ends with no turn going.
 *
 * It writes the app-server's notifications to stdout as they are (`out.jsonl`), and the server
 * turns them into thread messages shaped like Claude Code's stream-json (`handle_line`), so the
 * thread view shows both agents the same way. Like the rest of a run directory these lines are
 * a stable format: they're Codex's own protocol, which a newer server must keep reading.
 *
 * `codex.json` in the run directory holds what the runner decided for the run (see `Spec`);
 * the MCP servers come from the same `mcp.json` Claude gets, converted to Codex's config.
 */

export * from "./codex/adapter.ts";
export * from "./codex/queries.ts";
export * from "./codex/output.ts";

export function program(): string {
  return process.env.IA_CODEX_BIN ?? "codex";
}

/** What a run needs from the runner, saved as `codex.json` in the run directory. */
export interface Spec {
  cwd: string;
  /** The Codex thread to resume (the task's session id). */
  thread_id: string | null;
  model: string | null;
  effort: string | null;
  approval_policy: string;
  approvals_reviewer: string;
  /** `read-only`, `workspace-write` or `danger-full-access`. */
  sandbox: string;
  /** Codex's plan mode (collaboration mode `plan`). */
  plan: boolean;
  /** Compact the conversation instead of running a prompt. */
  compact: boolean;
  developer_instructions: string;
  /** Stdin is stream-json input (see the module docs), not just the prompt. */
  input: boolean;
  /** Writable on top of the working directory (e.g. a worktree's git directory). */
  writable_roots: string[];
  /**
   * With a `read-only` sandbox, paths to `write` besides the temp directories (a reviewer's
   * build output and caches) and paths inside those to keep `read`, through a permission
   * profile (see `REVIEW_PROFILE`). The most specific path wins.
   */
  filesystem: Record<string, string>;
  /** Holds the project's skills, one directory each. */
  skills_dir: string | null;
  /** MCP servers whose tools run without asking (the board's always does). */
  approved_mcp_servers: string[];
  /** MCP tools the agent doesn't get, by server (e.g. a reviewer's gh tools that write). */
  disabled_mcp_tools: Record<string, string[]>;
  /**
   * Codex's reviewer reviews the board's `wait` calls (auto mode), command included, so the
   * board runs a wait's command without asking. A run from an older build pre-approved them.
   */
  review_waits: boolean;
  /** Revert the thread to before this turn first (a rewind's, see checkpoints::Rewind). Left out when there's none. */
  revert_before_turn?: string;
}

/** `Spec::default()`, with `fields` over it. */
export function Spec_default(fields: Partial<Spec> = {}): Spec {
  return {
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
    ...fields,
  };
}

/** A `codex.json` read back (serde's defaults for missing fields), or null if it isn't one. */
export function Spec_from_json(v: any): Spec | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const str = (k: string) => typeof v[k] === "string";
  if (!str("cwd") || !str("approval_policy") || !str("approvals_reviewer") || !str("sandbox")) return null;
  const opt = (k: string) => (typeof v[k] === "string" ? v[k] : null);
  const strs = (x: any) => (Array.isArray(x) && x.every((s) => typeof s === "string") ? x : []);
  const spec = Spec_default({
    cwd: v.cwd,
    thread_id: opt("thread_id"),
    model: opt("model"),
    effort: opt("effort"),
    approval_policy: v.approval_policy,
    approvals_reviewer: v.approvals_reviewer,
    sandbox: v.sandbox,
    plan: v.plan === true,
    compact: v.compact === true,
    developer_instructions: typeof v.developer_instructions === "string" ? v.developer_instructions : "",
    input: v.input === true,
    writable_roots: strs(v.writable_roots),
    filesystem: v.filesystem && typeof v.filesystem === "object" ? v.filesystem : {},
    skills_dir: opt("skills_dir"),
    approved_mcp_servers: strs(v.approved_mcp_servers),
    disabled_mcp_tools: v.disabled_mcp_tools && typeof v.disabled_mcp_tools === "object" ? v.disabled_mcp_tools : {},
    review_waits: v.review_waits === true,
  });
  if (typeof v.revert_before_turn === "string") spec.revert_before_turn = v.revert_before_turn;
  return spec;
}

/**
 * How a permission mode runs under Codex: (approval policy, approvals reviewer, sandbox).
 * Reviewers get a read-only sandbox (they read and report) and run what fits in it unasked;
 * `Spec::filesystem` lets them build and test in it.
 */
export function policy(mode: string, review: boolean): [string, string, string] {
  if (mode === "bypassPermissions") return ["never", "user", "danger-full-access"];
  if (review) return ["never", "user", "read-only"];
  switch (mode) {
    case "dontAsk":
      return ["never", "user", "workspace-write"];
    case "acceptEdits":
      return ["on-request", "user", "workspace-write"];
    // Codex's own reviewer decides, like Claude's auto mode.
    case "auto":
      return ["on-request", "auto_review", "workspace-write"];
    case "plan":
      return ["untrusted", "user", "read-only"];
    default:
      return ["untrusted", "user", "workspace-write"];
  }
}

/**
 * The permission profile of a read-only sandbox with `Spec::filesystem`: it reads everything and
 * writes only the temp directories and the paths given, so a reviewer can run the tests without
 * being able to change the work. (Codex's `workspace-write` always lets the working directory be
 * written.)
 */
export const REVIEW_PROFILE = "huntaway-review";

/** The `thread/start` (and `thread/resume`) parameters for a run. */
export function thread_params(spec: Spec, cwd: string, servers: Record<string, any>): any {
  const config: any = {
    mcp_servers: servers,
    // The plan tool, shown as a todo list.
    "tools.update_plan.enabled": true,
  };
  const profile = uses_profile(spec);
  if (profile) {
    // A profile replaces the sandbox settings, which mustn't be given alongside it.
    const fs: Record<string, string> = { ":tmpdir": "write", ":slash_tmp": "write" };
    for (const [path, access] of Object.entries(spec.filesystem)) fs[path] = access;
    config.default_permissions = REVIEW_PROFILE;
    config.permissions = { [REVIEW_PROFILE]: { extends: ":read-only", filesystem: fs, network: { enabled: true } } };
  } else {
    // Agents need the network (git push, gh, package managers), as Claude's do.
    config.sandbox_workspace_write = { network_access: true };
    if (spec.writable_roots.length) config.sandbox_workspace_write.writable_roots = spec.writable_roots;
  }
  const params: any = {
    cwd,
    approvalPolicy: spec.approval_policy,
    approvalsReviewer: spec.approvals_reviewer,
    config,
    developerInstructions: spec.developer_instructions,
  };
  if (!profile) params.sandbox = spec.sandbox;
  if (spec.model != null) params.model = spec.model;
  return params;
}

export function uses_profile(spec: Spec): boolean {
  return spec.sandbox === "read-only" && Object.keys(spec.filesystem).length > 0;
}

/** Whether `model` names a Claude model, so a Codex thread shouldn't inherit it from its project, profile or host. */
export function is_claude_model(model: string): boolean {
  const m = model.trim().toLowerCase();
  return ["fable", "opus", "sonnet", "haiku", "default", "opusplan"].includes(m) || m.startsWith("claude");
}
