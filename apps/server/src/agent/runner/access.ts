// Port of server/src/agent/runner/access.rs: what a run may use: the board's tools, GitHub, and the folders its sandbox
// lets it write.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as db from "../../db.ts";
import type { ClaudeConfig, Profile, Project, Task } from "../../db.ts";
import type { Shared } from "../../state.ts";
import { expand_tilde, home_dir, path_str } from "../../util.ts";
import { run_cmd } from "../../proc.ts";
import * as mcp from "../../mcp.ts";
import * as docs_mcp from "../../mcp/docs_mcp.ts";
import * as gh_mcp from "../../mcp/gh_mcp.ts";
import * as codex from "../codex.ts";
import * as agent_tools from "../agent_tools.ts";
import * as runs from "../runs.ts";
import { LEGACY_MCP_SERVER_NAME, MCP_SERVER_NAME } from "../runner.ts";

/**
 * The board tools a Claude run gets without asking (`--allowedTools`). In auto mode that's all but `wait`, so Claude's
 * classifier reviews each wait as it does the agent's Bash calls: a wait's command runs like one of them (see
 * mcp/tools.rs).
 */
export function board_tools_allowed(permission_mode: string, review: boolean): string[] {
  if (permission_mode !== "auto") return [`mcp__${MCP_SERVER_NAME}`];
  return mcp
    .tool_names(review)
    .filter((t: string) => t !== "wait")
    .map((t: string) => `mcp__${MCP_SERVER_NAME}__${t}`);
}

/**
 * Whether Claude itself approved the `wait` calls of the run with these launch arguments (in auto mode, see
 * `board_tools_allowed`), so a wait's command needs no prompt of ours. Not for a Codex run, one in another mode, or
 * one that pre-approves `wait` under the board's current or old server name, like an auto run started by an older
 * build.
 */
export function approves_own_waits(args: string[]): boolean {
  const auto = args.some((a, i) => a === "--permission-mode" && args[i + 1] === "auto");
  const i = args.indexOf("--allowedTools");
  if (i < 0 || !auto) return false;
  const pre_approved = [MCP_SERVER_NAME, LEGACY_MCP_SERVER_NAME].flatMap((n) => [`mcp__${n}`, `mcp__${n}__wait`]);
  const listed: string[] = [];
  for (const a of args.slice(i + 1)) {
    if (a.startsWith("--")) break;
    listed.push(...a.split(/[, ]/));
  }
  return !listed.some((t) => pre_approved.includes(t));
}

/** A Codex run's effort, as `codex_effort` has it with the config's models (as it is if they can't be listed). */
export async function codex_run_effort(config: ClaudeConfig, model: string | null, effort: string | null): Promise<string | null> {
  if (effort == null) return null;
  try {
    const models = await codex.models(db.dir(config));
    return codex_effort(effort, model, models);
  } catch {
    return effort;
  }
}

/**
 * A Codex run's effort, if its model (or the default model) takes it; otherwise that model's own default. Models that
 * don't say which efforts they take take any.
 */
export function codex_effort(effort: string | null, model: string | null, models: codex.Model[]): string | null {
  const m = model != null ? models.find((m) => m.id === model) : (models.find((m) => m.is_default) ?? models[0]);
  if (effort != null && m && m.efforts.length && !m.efforts.includes(effort)) return m.default_effort ?? null;
  return effort;
}

/**
 * Whether the agent's own reviewer approved the `wait` calls of a run, command included: Claude's classifier (see
 * `approves_own_waits`) or Codex's reviewer (`codex::Spec::review_waits`).
 */
export function agent_reviews_waits(state: Shared, run_id: string): boolean {
  const spec = runs.codex_spec(state, run_id);
  return spec ? !!spec.review_waits : approves_own_waits(runs.launch_args(state, run_id));
}

/**
 * The gh server's tools a Claude run uses without asking: the read-only ones, and `pr_merge` while its task is merging,
 * since moving the task to "Ready for merge" was the user's say-so. Allowed tools skip auto mode's classifier too, so
 * a merge doesn't stall when it fails.
 */
export function gh_allowed(task: Task): string[] {
  const tools = [...gh_mcp.READ_ONLY];
  if (task.merging && task.kind === "task") tools.push("pr_merge");
  return tools;
}

/** Whether a run gets our gh server: unless the project turns it off or has its own by that name. */
export function uses_gh_server(tools: agent_tools.RunTools): boolean {
  const name = gh_mcp.SERVER_NAME;
  return !Object.hasOwn(tools.mcp_servers, name) && !tools.disallowed.includes(agent_tools.tool_prefix(name));
}

/**
 * Whether a run gets our docs server (mcp/docs_mcp.ts), whose tools it uses without asking (they only read and write the
 * profile's documents on this board): unless the project turns it off or has its own by that name.
 */
export function uses_docs_server(tools: agent_tools.RunTools): boolean {
  const name = docs_mcp.SERVER_NAME;
  return !Object.hasOwn(tools.mcp_servers, name) && !tools.disallowed.includes(agent_tools.tool_prefix(name));
}

/** What a run with our docs server is told about it (see `uses_docs_server`). */
export function docs_note(codex: boolean): string {
  const n = docs_mcp.SERVER_NAME;
  const tool = codex ? `\`${n}.publish_document\`` : `mcp__${n}__publish_document`;
  return (
    `\n\nTo give the user a report, plan, research or other write-up to read, publish it as a document with the ` +
    `\`${n}\` MCP server (${tool}; it's kept on this board, under your profile, with every version) and give them the ` +
    `URL it returns, rather than leaving it only in a message or a file. Its form fields (\`<Approval />\`, inputs) ` +
    `collect no answers here: ask in the thread for a decision or input.`
  );
}

/** The GitHub account a run's gh tools act as: the project's, or else its profile's. */
export function github_account(project: Project | null | undefined, profile: Profile): string | null {
  const set = (a: string | null | undefined) => {
    const t = a?.trim();
    return t ? t : null;
  };
  return (project ? set(project.github_account) : null) ?? set(profile.github_account);
}

/**
 * The environment that makes gh act as the GitHub account `task`'s runs use (see `github_account`), for the host's own
 * gh calls about the task (see gh_mcp::account_env). Null when no account is set, which leaves gh's active account.
 * Fails when the account set isn't signed in to gh, so nothing runs as another account instead.
 */
export async function task_gh_env(state: Shared, task: Task): Promise<gh_mcp.GhEnv | null> {
  return await gh_mcp.account_env(task_github_account(state, task));
}

/** The GitHub account `task`'s runs use (see `github_account`), if one is set. */
export function task_github_account(state: Shared, task: Task): string | null {
  const c = state.db();
  let project: Project | null = null;
  if (task.project_id != null) {
    project = db.get_project(c, task.project_id);
    if (!project) throw new Error("project not found");
  }
  const profile = db.get_profile(c, task.profile_id);
  if (!profile) throw new Error("profile not found");
  return github_account(project, profile);
}

/** What a Claude run with our gh server is told about GitHub. gh in Bash is turned away (see `gh_hook_settings`). */
export function gh_note(account: string | null): string {
  const n = gh_mcp.SERVER_NAME;
  return (
    `\n\nFor GitHub (pull requests, issues, CI runs, the API), use the \`${n}\` MCP server's tools (mcp__${n}__pr_view, ` +
    `pr_create, pr_checks and so on; mcp__${n}__gh runs any other gh command) rather than the gh CLI in Bash, which is ` +
    `blocked here. They run gh outside the sandbox${account != null ? ` as the GitHub account ${account}` : ""}.`
  );
}

/**
 * `--settings` for a Claude run with our gh server: a PreToolUse hook that turns away gh in Bash (`huntaway gh-hook`),
 * which may not reach GitHub from the sandbox or would act as gh's active account rather than the run's.
 */
export function gh_hook_settings(exe: string): string {
  return hook_settings(exe, null);
}

/**
 * `--settings` with a Claude run's PreToolUse hooks: the gh one (`gh_hook_settings`), with this binary, and the approval
 * rules' (see approval_rules.claude_hook).
 */
export function hook_settings(gh: string | null, rules: any | null): string {
  const hooks: any[] = [];
  if (gh !== null) {
    const command = `'${path_str(gh).replaceAll("'", "'\\''")}' gh-hook`;
    hooks.push({ matcher: "Bash", hooks: [{ type: "command", command, timeout: 10 }] });
  }
  if (rules != null) hooks.push(rules);
  return JSON.stringify({ hooks: { PreToolUse: hooks } });
}

/** The git directory a worktree shares with its repository, where commits are written. */
export async function git_common_dir(cwd: string): Promise<string | null> {
  try {
    const out = await run_cmd("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: expand_tilde(cwd) });
    const dir = out.stdout.trim();
    return out.success && dir ? dir : null;
  } catch {
    return null;
  }
}

/**
 * Package managers' caches, which Codex's `workspace-write` sandbox would otherwise keep read-only (so `npm ci`, say,
 * fails). Each is made first if it's missing, parents and all, as the sandbox would keep its tool from making it on
 * first use. In the home directory, or where the environment says (`env`, e.g. `CARGO_HOME` for a system-wide Cargo).
 */
export function cache_dirs(): string[] {
  const home = home_dir();
  return home ? cache_dirs_in(home, (k) => process.env[k] ?? null) : [];
}

export function cache_dirs_in(home: string, env: (k: string) => string | null): string[] {
  const base = (v: string, def: string) => {
    const e = env(v);
    return e != null && e.startsWith("/") ? e : join(home, def);
  };
  const [cargo, data] = [base("CARGO_HOME", ".cargo"), base("XDG_DATA_HOME", ".local/share")];
  const dirs = [base("XDG_CACHE_HOME", ".cache"), join(home, ".npm"), join(cargo, "registry"), join(cargo, "git"), join(data, "pnpm")];
  return dirs
    .filter((p) => {
      try {
        mkdirSync(p, { recursive: true });
        return true;
      } catch {
        return false;
      }
    })
    .map(path_str);
}

/**
 * A reviewer's `codex::Spec::filesystem`: it writes `write` and reads `work` (its working and git directories), which
 * stay read-only even inside a cache or temp directory (a test server's). Sorted by path, as Rust's BTreeMap is.
 */
export function review_filesystem(write: string[], work: string[]): Record<string, string> {
  const m = new Map<string, string>();
  for (const p of write) m.set(p, "write");
  for (const p of work) m.set(p, "read");
  const keys = [...m.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return Object.fromEntries(keys.map((k) => [k, m.get(k)!]));
}

/** Agents' own settings, which stay read-only to a reviewer even when git ignores them. */
const AGENT_DIRS = [".git", ".claude", ".codex", ".agents"];

/** Most git-ignored directories a reviewer may write. */
const MAX_IGNORED_DIRS = 200;

/** Run git in `dir` with `input` on its stdin (written while its output is read): its exit code and stdout. */
function git_io(dir: string, args: string[], input: string | null): Promise<[number | null, string] | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("git", args, { cwd: dir, stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      return resolve(null);
    }
    const chunks: Buffer[] = [];
    child.stdout!.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve([code, Buffer.concat(chunks).toString("utf8")]));
    child.stdin!.on("error", () => {});
    if (input != null) child.stdin!.end(input);
    else child.stdin!.end();
  });
}

/**
 * The directories in `cwd` that git ignores as a whole (build output, installed packages): a reviewer may write them
 * without changing the work, which they hold none of. Absolute paths.
 */
export async function ignored_dirs(cwd: string): Promise<string[]> {
  const dir = expand_tilde(cwd);
  const listed = await git_io(dir, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], null);
  if (!listed || listed[0] !== 0) return [];
  // That lists untracked directories with only ignored files in them too.
  const candidates = listed[1]
    .split("\0")
    .filter((p) => p.endsWith("/"))
    .map((p) => p.slice(0, -1))
    .filter((p) => !p.split("/").some((c) => AGENT_DIRS.includes(c)))
    .slice(0, MAX_IGNORED_DIRS);
  if (!candidates.length) return [];
  // Exits with 1 when none of them is ignored.
  const ignored = await git_io(dir, ["check-ignore", "-z", "--stdin"], candidates.join("\0"));
  if (!ignored || ignored[0] !== 0) return [];
  return ignored[1]
    .split("\0")
    .filter((p) => p)
    .map((p) => path_str(join(dir, p)));
}
