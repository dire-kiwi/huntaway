// Port of server/src/mcp/gh_mcp.rs.
//
// The `gh` MCP server, which runs the GitHub CLI for agents. Claude Code can sandbox Bash, and there `gh` (and
// `git push`) often can't reach GitHub or the user's stored login. MCP servers run outside the sandbox, so going through
// these tools works either way. Every run gets it as the `gh` server, working in the run's directory: the board serves
// it over HTTP (see mcp/http.ts, and `GhRun`); `huntaway gh-mcp` is the stdio server runs from before that started.
//
// A profile (on each host) can pick the GitHub account its agents act as, and a project can pick its own
// (`github_account`). The run's launch records it (`IA_GH_ACCOUNT` for `huntaway gh-mcp`), and each call then runs with
// that account's token from gh's own logins (`gh auth token --user`), whichever account is active in gh, and with no
// other credentials (see `GhEnv`).
// Claude runs also get `huntaway gh-hook`, which turns away `gh` in Bash in favour of these tools.
//
// `gh-mcp`, `gh-hook` and `gh-run` run as processes of their own, many times over: this module and its parts import
// only light modules (util.ts, hosts/proto.ts), and load anything else when they need it.
import { readFileSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { expand_tilde, err_str, context } from "../util.ts";
import { VERSION } from "../hosts/proto.ts";
import { Account } from "./gh_mcp/account.ts";
import { TEST_BOARD, command_output, exit_status, extra_header_resets, gh_program, io_error, push_urls, type CmdOutput } from "./gh_mcp/env.ts";

export * from "./gh_mcp/account.ts";
export * from "./gh_mcp/env.ts";

export const SERVER_NAME = "gh";

/** Tools that only read, so they run without asking (`--allowedTools mcp__gh__<name>`). */
export const READ_ONLY = ["pr_view", "pr_list", "pr_checks", "pr_diff", "issue_view", "issue_list", "run_list", "run_view"];

/** The rest, which reviewers don't get. */
export const WRITES = ["pr_create", "pr_comment", "pr_edit", "pr_merge", "issue_create", "issue_comment", "api", "gh", "git_push"];

/** Sent with `initialize`; Claude Code adds it to the agent's system prompt. */
const INSTRUCTIONS =
  "GitHub through the gh CLI, run outside any sandbox with the user's GitHub login. Use these tools instead of running gh in Bash (where it may not reach GitHub or its login, or act as the wrong account), and git_push instead of `git push` if that fails. They work in your working directory's repository by default; pass repo (OWNER/REPO) for another one, or dir to run in another checkout. pr_* tools take a pull request number, URL or branch, defaulting to the current branch's PR. For anything else, call the gh tool with gh's arguments.";

/** The environment variable a run's account comes in (see `Account`). */
export const ACCOUNT_ENV = "IA_GH_ACCOUNT";

/**
 * The run a gh server is for: where its calls run, the account they act as, and the board's say on merging. The board
 * serves it over HTTP for runs it starts (see mcp/http.ts), with what the run's launch recorded; `huntaway gh-mcp`, the
 * stdio server of runs from before that, has them in its environment (`GhRun_from_env`).
 */
export interface GhRun {
  /** The run's directory, where calls without a `dir` run. */
  cwd: string | null;
  account: Account | null;
  /** Why the board won't let this run merge, if it won't (see review/merge_gate.rs). */
  merge_gate(): Promise<string | null>;
}

/** `huntaway gh-mcp`'s run, from its environment (`IA_CWD`, `IA_GH_ACCOUNT` and the board's `BOARD_ENV`). */
export function GhRun_from_env(): GhRun {
  return { cwd: process.env.IA_CWD ?? null, account: Account.from_env(), merge_gate: env_merge_gate };
}

/**
 * `huntaway gh-hook`: Claude Code's PreToolUse hook for Bash in runs that have this server. Turns away commands that run
 * gh, saying to use these tools instead: gh in Bash may not reach GitHub from the sandbox, and would act as gh's active
 * account rather than the run's.
 */
export async function bash_hook(): Promise<void> {
  const input = readFileSync(0, "utf8");
  let call: any = null;
  try {
    call = JSON.parse(input);
  } catch {}
  const { runs_program } = await import("../git/changes.ts");
  const reason = hook_denial(call, runs_program);
  if (reason !== null) {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
  }
}

/** Why a tool call (a hook's input) is turned away, if it is. `runs_program` is git/changes.ts's. */
export function hook_denial(call: any, runs_program: (command: string, program: string) => boolean): string | null {
  const command = call?.tool_input?.command;
  if (typeof command !== "string" || call?.tool_name !== "Bash") return null;
  // A command the check can't read (it throws) is turned away too, rather than let through.
  let runs_gh: boolean;
  try {
    runs_gh = runs_program(command, "gh");
  } catch {
    runs_gh = true;
  }
  if (!runs_gh) return null;
  return (
    `Don't run the GitHub CLI (gh) in Bash here: use the \`${SERVER_NAME}\` MCP server's tools instead (mcp__${SERVER_NAME}__pr_view, ` +
    `pr_create, pr_checks, pr_merge, issue_view, api and the others; mcp__${SERVER_NAME}__gh runs any other gh command, with ` +
    `gh's arguments). They run gh outside the sandbox as the GitHub account this project uses. Run the rest of the ` +
    `command on its own.`
  );
}

/** Output beyond this (in bytes) is cut from the middle. */
export const MAX_OUTPUT = 60_000;
const TIMEOUT = 600_000;

export function tools(): any[] {
  const repo = { type: "string", description: "OWNER/REPO, if not the working directory's repository" };
  const dir = { type: "string", description: "Directory to run in (defaults to your working directory)" };
  const pr = { type: "string", description: "Pull request number, URL or branch; defaults to the current branch's" };
  const issue = { type: "string", description: "Issue number or URL" };
  const limit = { type: "integer", minimum: 1, maximum: 1000, description: "At most this many (default 30)" };
  const tool = (name: string, description: string, props: any, required: string[]) => {
    props = { ...props, repo, dir };
    // Codex runs tools marked read-only without asking, and asks for the rest.
    const annotations = { readOnlyHint: READ_ONLY.includes(name) };
    // serde_json's maps are sorted by key.
    return { annotations, description, inputSchema: { properties: sorted(props), required, type: "object" }, name };
  };
  return [
    tool("pr_create", "Open a pull request for the current branch (push it first, e.g. with git_push). Without a title, gh fills the title and body from the commits.", {
      title: { type: "string" },
      body: { type: "string", description: "Markdown" },
      base: { type: "string", description: "Branch to merge into (defaults to the repository's default branch)" },
      head: { type: "string", description: "Branch to merge from (defaults to the current branch)" },
      draft: { type: "boolean" },
    }, []),
    tool("pr_view", "A pull request's details as JSON: state, branches, mergeability, review decision, checks and body; with comments, its comments and reviews too.", {
      pr, comments: { type: "boolean" },
    }, []),
    tool("pr_list", "List pull requests as JSON.", {
      state: { type: "string", enum: ["open", "closed", "merged", "all"], description: "Default open" },
      head: { type: "string", description: "Only PRs from this branch" },
      base: { type: "string", description: "Only PRs into this branch" },
      author: { type: "string", description: "Only PRs by this user (@me for yourself)" },
      search: { type: "string", description: "GitHub search query" },
      limit,
    }, []),
    tool("pr_checks", "A pull request's CI checks as JSON (name, state, bucket pass/fail/pending/skipping, link).", { pr }, []),
    tool("pr_diff", "A pull request's diff.", { pr, name_only: { type: "boolean", description: "Only the names of the changed files" } }, []),
    tool("pr_comment", "Comment on a pull request.", { pr, body: { type: "string", description: "Markdown" } }, ["body"]),
    tool("pr_edit", "Change a pull request's title, body or base branch.", { pr, title: { type: "string" }, body: { type: "string" }, base: { type: "string" } }, []),
    tool("pr_merge", "Merge a pull request on GitHub. This doesn't touch local branches or worktrees.", {
      pr,
      method: { type: "string", enum: ["merge", "squash", "rebase"], description: "Default merge" },
      auto: { type: "boolean", description: "Merge once the required checks pass, instead of now" },
      delete_branch: { type: "boolean", description: "Delete the PR's branch on GitHub after merging (not with auto, or for a PR from a fork)" },
    }, []),
    tool("issue_view", "An issue's details as JSON; with comments, its comments too.", { issue, comments: { type: "boolean" } }, ["issue"]),
    tool("issue_list", "List issues as JSON.", {
      state: { type: "string", enum: ["open", "closed", "all"], description: "Default open" },
      label: { type: "string" },
      assignee: { type: "string", description: "@me for yourself" },
      search: { type: "string", description: "GitHub search query" },
      limit,
    }, []),
    tool("issue_create", "Open an issue.", {
      title: { type: "string" },
      body: { type: "string", description: "Markdown" },
      labels: { type: "array", items: { type: "string" } },
    }, ["title"]),
    tool("issue_comment", "Comment on an issue.", { issue, body: { type: "string", description: "Markdown" } }, ["issue", "body"]),
    tool("run_list", "List recent GitHub Actions workflow runs as JSON.", {
      branch: { type: "string" },
      workflow: { type: "string", description: "Workflow name or file" },
      limit,
    }, []),
    tool("run_view", "A workflow run's jobs and steps, or with log_failed, the logs of its failed steps.", {
      run_id: { type: "string", description: "The run's id (databaseId in run_list)" },
      log_failed: { type: "boolean" },
    }, ["run_id"]),
    tool("api", "Call the GitHub REST API (gh api). {owner} and {repo} in the endpoint are filled in from the repository.", {
      endpoint: { type: "string", description: "e.g. repos/{owner}/{repo}/pulls/1/comments, or graphql" },
      method: { type: "string", enum: ["GET", "POST", "PATCH", "PUT", "DELETE"], description: "Default GET (POST when there are fields)" },
      fields: {
        type: "object",
        description: "Parameters: query parameters for GET, otherwise the request body. Strings are sent as they are; numbers, booleans and null as JSON.",
      },
      jq: { type: "string", description: "jq expression to filter the response with" },
      paginate: { type: "boolean", description: "Fetch every page" },
    }, ["endpoint"]),
    tool("gh", "Run any gh command, for what the other tools don't cover. Nothing is interactive: pass everything as arguments.", {
      args: { type: "array", items: { type: "string" }, description: "gh's arguments, e.g. [\"release\", \"list\"]" },
    }, ["args"]),
    tool("git_push", "Push a branch with git, outside the sandbox and with the user's git credentials.", {
      remote: { type: "string", description: "Default origin" },
      branch: { type: "string", description: "Default the current branch" },
      force_with_lease: { type: "boolean", description: "Overwrite the remote branch if it hasn't changed since you last fetched it" },
    }, []),
  ];
}

function sorted(o: any): any {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}

/** A command to run for a tool call. */
export interface Command {
  program: "gh" | "git";
  args: string[];
  /** Exit codes that aren't failures (`gh pr checks` exits 8 while checks are pending). */
  ok_codes: number[];
  /** The call's `repo`, given to gh as `GH_REPO`: not every gh command takes `--repo` (`gh api` doesn't). */
  repo: string | null;
}

const digits = (s: string) => /^[0-9]*$/.test(s);

export function command(tool: string, a: any): Command {
  const s = (k: string): string | null => {
    const v = a?.[k];
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t ? t : null;
  };
  const text = (k: string): string | null => (typeof a?.[k] === "string" ? a[k] : null); // bodies keep their whitespace
  const yes = (k: string) => a?.[k] === true;
  const args: string[] = [];
  // `--flag=value`, so a value starting with `-` isn't taken for a flag.
  const flag = (f: string, v: string | null) => {
    if (v !== null) args.push(`--${f}=${v}`);
  };
  const words = (w: string[]) => args.push(...w);
  const target = (k: string) => {
    const v = s(k);
    if (v !== null) {
      if (v.startsWith("-")) throw new Error(`bad ${k}: ${v}`);
      args.push(v);
    }
  };
  const limit = () => {
    const n = a?.limit;
    if (typeof n === "number" && Number.isInteger(n) && n >= 0) args.push(`--limit=${n}`);
  };
  let ok_codes = [0];
  switch (tool) {
    case "pr_create": {
      words(["pr", "create"]);
      const t = s("title");
      if (t !== null) {
        flag("title", t);
        flag("body", text("body") ?? "");
      } else if (text("body") !== null) throw new Error("give a title with the body, or neither to fill both from the commits");
      else args.push("--fill");
      flag("base", s("base"));
      flag("head", s("head"));
      if (yes("draft")) args.push("--draft");
      break;
    }
    case "pr_view": {
      words(["pr", "view"]);
      target("pr");
      let fields = "number,title,state,isDraft,url,author,headRefName,baseRefName,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,body";
      if (yes("comments")) fields += ",comments,reviews";
      flag("json", fields);
      break;
    }
    case "pr_list": {
      words(["pr", "list"]);
      for (const k of ["state", "head", "base", "author", "search"]) flag(k, s(k));
      limit();
      flag("json", "number,title,state,isDraft,url,author,headRefName,baseRefName,updatedAt");
      break;
    }
    case "pr_checks": {
      words(["pr", "checks"]);
      target("pr");
      flag("json", "name,state,bucket,workflow,link,startedAt,completedAt");
      ok_codes = [0, 8];
      break;
    }
    case "pr_diff": {
      words(["pr", "diff"]);
      target("pr");
      if (yes("name_only")) args.push("--name-only");
      break;
    }
    case "pr_comment":
    case "issue_comment": {
      const what = tool === "pr_comment" ? "pr" : "issue";
      words([what, "comment"]);
      target(what);
      const body = text("body");
      if (body === null) throw new Error("body is required");
      flag("body", body);
      break;
    }
    case "pr_edit": {
      words(["pr", "edit"]);
      target("pr");
      const before = args.length;
      flag("title", s("title"));
      flag("body", text("body"));
      flag("base", s("base"));
      if (args.length === before) throw new Error("nothing to change: give a title, body or base");
      break;
    }
    case "pr_merge": {
      // `--repo` keeps gh from cleaning up locally (switching branches, deleting the head branch and any worktree
      // it's checked out in), so `run` resolves the PR to its number and repository first.
      words(["pr", "merge"]);
      const number = s("pr");
      const repo = s("repo");
      if (number === null || !digits(number) || repo === null) throw new Error("pr_merge needs the PR's number and repository");
      args.push(number);
      flag("repo", repo);
      const m = s("method") ?? "merge";
      if (m === "merge") args.push("--merge");
      else if (m === "squash") args.push("--squash");
      else if (m === "rebase") args.push("--rebase");
      else throw new Error(`unknown merge method ${m}`);
      if (yes("auto")) args.push("--auto");
      if (yes("delete_branch")) args.push("--delete-branch");
      break;
    }
    case "issue_view": {
      words(["issue", "view"]);
      target("issue");
      let fields = "number,title,state,url,author,assignees,labels,createdAt,body";
      if (yes("comments")) fields += ",comments";
      flag("json", fields);
      break;
    }
    case "issue_list": {
      words(["issue", "list"]);
      for (const k of ["state", "label", "assignee", "search"]) flag(k, s(k));
      limit();
      flag("json", "number,title,state,url,author,assignees,labels,updatedAt");
      break;
    }
    case "issue_create": {
      words(["issue", "create"]);
      const title = s("title");
      if (title === null) throw new Error("title is required");
      flag("title", title);
      flag("body", text("body") ?? "");
      if (Array.isArray(a?.labels)) for (const l of a.labels) if (typeof l === "string") flag("label", l);
      break;
    }
    case "run_list": {
      words(["run", "list"]);
      flag("branch", s("branch"));
      flag("workflow", s("workflow"));
      limit();
      flag("json", "databaseId,workflowName,displayTitle,headBranch,event,status,conclusion,url,createdAt");
      break;
    }
    case "run_view": {
      words(["run", "view"]);
      const id = s("run_id");
      if (id === null) throw new Error("run_id is required");
      if (!digits(id)) throw new Error(`bad run_id: ${id}`);
      args.push(id);
      if (yes("log_failed")) args.push("--log-failed");
      break;
    }
    case "api": {
      words(["api"]);
      const endpoint = s("endpoint");
      if (endpoint === null) throw new Error("endpoint is required");
      if (endpoint.startsWith("-")) throw new Error(`bad endpoint: ${endpoint}`);
      args.push(endpoint);
      flag("method", s("method"));
      const fields = a?.fields;
      if (fields && typeof fields === "object" && !Array.isArray(fields)) {
        // serde_json's maps are sorted by key.
        for (const k of Object.keys(fields).sort()) {
          const v = fields[k];
          if (typeof v === "string") args.push("--raw-field", `${k}=${v}`);
          // -F reads `@file` values from disk; JSON scalars never start with `@`.
          else if (typeof v === "number" || typeof v === "boolean" || v === null) args.push("--field", `${k}=${JSON.stringify(v)}`);
          else throw new Error(`field ${k}: only strings, numbers, booleans and null (use graphql variables or a string for more)`);
        }
      }
      flag("jq", s("jq"));
      if (yes("paginate")) args.push("--paginate");
      break;
    }
    case "gh": {
      const list = a?.args;
      if (!Array.isArray(list)) throw new Error("args must be a list of strings");
      for (const v of list) {
        if (typeof v !== "string") throw new Error("args must be a list of strings");
        args.push(v);
      }
      if (!args.length) throw new Error("args is empty");
      refuse(args);
      break;
    }
    case "git_push": {
      args.push("push");
      if (yes("force_with_lease")) args.push("--force-with-lease");
      const remote = s("remote") ?? "origin";
      const branch = s("branch") ?? "HEAD";
      if (remote.startsWith("-") || branch.startsWith("-")) throw new Error("bad remote or branch");
      // A branch name, not a refspec: `+HEAD:refs/heads/master` would force-push master.
      if (!branch_name(branch)) throw new Error("branch must be a branch name");
      // HEAD pushes the current branch under its own name, and -u makes it the upstream.
      args.push("-u", remote, branch);
      return { program: "git", args, ok_codes, repo: null };
    }
    default:
      throw new Error(`unknown tool ${tool}`);
  }
  return { program: "gh", args, ok_codes, repo: s("repo") };
}

/**
 * Whether git_push's `branch` is a branch name git would take (`git check-ref-format --branch`) rather than a refspec:
 * a leading `+` forces the push and a `:` names another ref to push to. A `+` further in is part of the name
 * (`feature/c++`).
 */
export function branch_name(branch: string): boolean {
  return (
    branch.length > 0 &&
    !"-+/".includes(branch[0]) &&
    !branch.endsWith("/") &&
    !branch.endsWith(".") &&
    branch !== "@" &&
    !["..", "//", "@{"].some((x) => branch.includes(x)) &&
    // Whitespace, control characters (C0, DEL and C1), and those git takes for something else.
    !/[\s\u0000-\u001f\u007f-\u009f:^~*?[\\]/u.test(branch) &&
    branch.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"))
  );
}

/**
 * Fails for gh commands no agent gets, whatever its permission mode (the gh tool's approval doesn't apply in auto or
 * bypass): `gh auth` (`gh auth token` would put the account's token in the thread, as would `config get` of a host's
 * `oauth_token`), and those that change what later gh commands run (extensions, aliases, settings). gh's command comes
 * first: a flag before it could take the next argument as its value, so only `--help` and `--version` may.
 */
export function refuse(all: string[]) {
  let i = 0;
  while (i < all.length && ["--help", "-h", "--version"].includes(all[i])) i++;
  const args = all.slice(i);
  const [first, second] = args;
  let refused: string | null = null;
  if (first === undefined) return;
  if (first.startsWith("-")) throw new Error(`put gh's command first, e.g. ["release", "list", ${JSON.stringify(first)}]`);
  if (first === "auth") refused = "gh auth";
  else if (["extension", "extensions", "ext"].includes(first)) refused = "gh extension";
  // Their subcommands come first too, for the same reason.
  else if ((first === "alias" || first === "config") && second !== undefined && second.startsWith("-")) {
    throw new Error(`put the subcommand straight after ${JSON.stringify(first)}`);
  } else if (first === "alias" && ["set", "import", "delete"].includes(second)) refused = "changing gh's aliases";
  else if (first === "config" && ["set", "clear-cache"].includes(second)) refused = "changing gh's settings";
  // A host's settings are its login, token and all (`config get -h HOST oauth_token` prints it).
  else if (first === "config" && args.slice(1).some((a) => a.includes("oauth_token") || a.startsWith("-h") || a.startsWith("--host"))) {
    refused = "reading a host's gh settings";
  }
  if (refused !== null) throw new Error(`${refused} isn't available to agents; ask the user to run it`);
}

/** A PR's number and `[HOST/]OWNER/REPO`, from its URL. */
export function pr_from_url(url: string): [string, string] | null {
  const t = url.trim();
  const rest = t.startsWith("https://") ? t.slice(8) : t.startsWith("http://") ? t.slice(7) : null;
  if (rest === null) return null;
  const parts = rest.split("/");
  if (parts.length !== 5 || parts[3] !== "pull") return null;
  const [host, owner, name, , number] = parts;
  if (!number || !digits(number)) return null;
  const repo = host === "github.com" ? `${owner}/${name}` : `${host}/${owner}/${name}`;
  return [number, repo];
}

/** pr_merge's arguments with `pr` and `repo` resolved to the PR's number and repository. */
async function resolve_pr(a: any, r: GhRun): Promise<any> {
  const args = ["pr", "view"];
  const pr = typeof a?.pr === "string" ? a.pr.trim() : "";
  if (pr) {
    if (pr.startsWith("-")) throw new Error(`bad pr: ${pr}`);
    args.push(pr);
  }
  args.push("--json=url", "--jq=.url");
  const repo = typeof a?.repo === "string" && a.repo.trim() ? a.repo.trim() : null;
  const [text, failed] = await exec({ program: "gh", args, ok_codes: [0], repo }, a, r);
  if (failed) throw new Error(`couldn't find the pull request: ${text}`);
  const found = pr_from_url(text);
  if (!found) throw new Error(`unexpected pull request URL ${text}`);
  return { ...a, pr: found[0], repo: found[1] };
}

/** Where a call runs: its `dir`, or the run's directory. */
function work_dir(a: any, r: GhRun): string | null {
  const d = typeof a?.dir === "string" && a.dir.trim() ? a.dir : r.cwd;
  return d === null ? null : expand_tilde(d);
}

/** Keep the start and end of long output (a log's failure is usually at the end). */
export function clip(s: string): string {
  const b = Buffer.from(s);
  if (b.length <= MAX_OUTPUT) return s;
  // Back up to a char boundary (a byte that isn't a UTF-8 continuation byte).
  const floor = (i: number) => {
    while (i > 0 && (b[i] & 0xc0) === 0x80) i--;
    return i;
  };
  const head = floor(MAX_OUTPUT / 2);
  const tail = floor(b.length - MAX_OUTPUT / 2);
  return `${b.subarray(0, head).toString()}\n\n[… ${tail - head} bytes cut …]\n\n${b.subarray(tail).toString()}`;
}

/** Run a tool call: its output, and whether it failed. */
export async function run(tool: string, a: any, r: GhRun = GhRun_from_env()): Promise<[string, boolean]> {
  if (merges(tool, a)) {
    const why = await r.merge_gate();
    if (why !== null) return [why, true];
  }
  const args = tool === "pr_merge" ? await resolve_pr(a, r) : a;
  return exec(command(tool, args), args, r);
}

/** The board's line to the run this server is for, which the commands it runs don't get. */
const BOARD_ENV = ["IA_URL", "IA_TOKEN", "IA_RUN_ID"];

/**
 * Whether call `a` to `tool` may merge a pull request: pr_merge, `gh pr merge`, or GitHub's API (REST or GraphQL) with
 * "merge" anywhere in the call, or with a request read from a file, which can't be seen. It errs on the side of asking
 * the board: a call that only reads (a PR's mergeability, say) is refused too while a merge waits for approval, and
 * pr_view has that.
 */
export function merges(tool: string, a: any): boolean {
  switch (tool) {
    case "pr_merge":
      return true;
    // Wherever its words are: flags (and their values) can come between a command and its subcommand
    // (`pr --repo o/r merge`), so any call with both words counts.
    case "gh": {
      const args: string[] = Array.isArray(a?.args) ? a.args.filter((x: any) => typeof x === "string") : [];
      const has = (w: string) => args.some((x) => x.toLowerCase() === w);
      // `--input FILE` (or `-`) is the request body, and `-F key=@FILE` a field's value.
      const from_file = args.some((x) => x.startsWith("--input") || x.startsWith("@") || x.includes("=@"));
      return (has("pr") && has("merge")) || (has("api") && (from_file || mentions_merge(args.join(" "))));
    }
    // Its string fields are sent as they are (--raw-field), never read from files.
    case "api":
      return mentions_merge(JSON.stringify(a ?? null));
    default:
      return false;
  }
}

function mentions_merge(call: string): boolean {
  return call.toLowerCase().includes("merge");
}

/**
 * Why the board won't let this run merge, if it won't (see review/merge_gate.rs), asked over HTTP by `huntaway gh-mcp`.
 * A server started without the board's address (by hand, say) has no say from it.
 */
async function env_merge_gate(): Promise<string | null> {
  const board = TEST_BOARD.get() ?? BOARD_ENV.map((k) => process.env[k]);
  const [url, token, run_id] = board;
  if (url === undefined || token === undefined || run_id === undefined) return null;
  let v: any;
  try {
    const res = await fetch(`${url}/api/internal/merge-gate/${run_id}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP status ${res.status} for url (${url}/api/internal/merge-gate/${run_id})`);
    v = await res.json();
  } catch (e: any) {
    const why = e?.name === "TimeoutError" ? new Error("timed out") : e;
    throw context("couldn't ask the board whether this merge is approved, so it wasn't merged (try again)", why);
  }
  return typeof v?.blocked === "string" ? v.blocked : null;
}

/** Run a command where call `a` runs, as the run's account if it has one: its output, and whether it failed. */
async function exec(c: Command, a: any, r: GhRun): Promise<[string, boolean]> {
  const program = c.program === "gh" ? gh_program() : c.program;
  const env: NodeJS.ProcessEnv = { ...process.env };
  const pre: string[] = [];
  // Kept until gh is done with it.
  let gh_env: { drop(): void } | null = null;
  try {
    const account = r.account;
    if (account) {
      if (c.program === "git") {
        // To another host, the push would go as whoever git's credentials (or SSH keys) there are. So it's to a
        // remote by name, all of whose push URLs (as git rewrites them) are checked: a URL given as the remote would
        // be rewritten when pushing.
        const u = c.args.indexOf("-u");
        const remote = u >= 0 && c.args[u + 1] !== undefined ? c.args[u + 1] : "origin";
        const urls = await push_urls(work_dir(a, r), remote);
        if (!urls) {
          throw new Error(`there's no remote named ${remote}: with a GitHub account set, git_push takes a remote's name (add one with git remote add)`);
        }
        account.check_git_urls(urls);
        const token = await account.token();
        pre.push(...(await extra_header_resets(work_dir(a, r))), ...account.git_config());
        env.IA_GH_GIT_TOKEN = token;
      } else {
        account.check_targets(c.args, c.repo);
        const e = account.env(await account.token());
        e.apply(env);
        gh_env = e;
      }
    }
    Object.assign(env, { GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0" });
    for (const k of BOARD_ENV) delete env[k];
    // Only the call's own repository, which was checked.
    delete env.GH_REPO;
    if (c.repo !== null) env.GH_REPO = c.repo;
    const d = work_dir(a, r);
    if (d !== null && !is_dir(d)) throw new Error(`${d} is not a directory`);
    let out: CmdOutput;
    try {
      out = await command_output(program, [...pre, ...c.args], { env, cwd: d ?? undefined, timeout: TIMEOUT });
    } catch (e) {
      throw context(`couldn't run ${c.program}`, new Error(io_error(e)));
    }
    if (out.timed_out) throw new Error(`${c.program} timed out after ${TIMEOUT / 1000} seconds`);
    const stdout = out.stdout.toString(), stderr = out.stderr.toString();
    const failed = out.code === null || !c.ok_codes.includes(out.code);
    let text = stdout.trimEnd();
    if (stderr.trim()) {
      if (text) text += "\n\n";
      text += stderr.trimEnd();
    }
    if (failed) text += `\n\n(${c.program} exited with ${exit_status(out)})`;
    else if (!text) text = "Done.";
    return [clip(text.trimStart()), failed];
  } finally {
    gh_env?.drop();
  }
}

function is_dir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export async function handle(req: any, r: GhRun = GhRun_from_env()): Promise<any | null> {
  if (req === null || typeof req !== "object" || !("id" in req)) return null; // notifications get no response
  const id = req.id;
  const method = typeof req.method === "string" ? req.method : "";
  let result: any;
  let error: any = null;
  switch (method) {
    case "initialize": {
      const a = r.account;
      result = {
        capabilities: { tools: {} },
        instructions: a ? `${INSTRUCTIONS} They act as the GitHub account ${a}.` : INSTRUCTIONS,
        protocolVersion: typeof req.params?.protocolVersion === "string" ? req.params.protocolVersion : "2025-06-18",
        serverInfo: { name: "huntaway-gh", version: VERSION },
      };
      break;
    }
    case "ping":
      result = {};
      break;
    case "tools/list":
      result = { tools: tools() };
      break;
    case "tools/call": {
      const name = typeof req.params?.name === "string" ? req.params.name : "";
      try {
        const [text, failed] = await run(name, req.params?.arguments ?? null, r);
        result = { content: [{ text, type: "text" }], isError: failed };
      } catch (e) {
        result = { content: [{ text: `Error: ${err_str(e)}`, type: "text" }], isError: true };
      }
      break;
    }
    default:
      error = { code: -32601, message: `method not found: ${method}` };
  }
  return error !== null ? { error, id, jsonrpc: "2.0" } : { id, jsonrpc: "2.0", result };
}

export async function serve_stdio(): Promise<void> {
  const r = GhRun_from_env();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  // Calls run concurrently, and the ones still running when stdin closes get to finish.
  const calls: Promise<void>[] = [];
  for await (const line of lines) {
    let req: any;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    calls.push(
      handle(req, r)
        .then((resp) => {
          if (resp !== null) process.stdout.write(`${JSON.stringify(resp)}\n`);
        })
        .catch((e) => console.error("gh-mcp:", err_str(e))),
    );
  }
  await Promise.all(calls);
}
