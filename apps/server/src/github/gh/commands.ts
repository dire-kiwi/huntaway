import { Result } from "effect"
import { refuse } from "@huntaway/shared"

// The commands the gh tools run (docs/plan/inventory/03-mcp.md 2.10; huntaway's mcp/gh_mcp.ts `command`, `merges`,
// `branch_name`, `pr_from_url`, `clip`): a tool call's arguments as gh's (or git's), flags always `--flag=value` so a
// value starting with `-` isn't taken for a flag, and positional targets never starting with `-`. Plain functions.

/** A command to run for a tool call. */
export interface Command {
  readonly program: "gh" | "git"
  readonly args: ReadonlyArray<string>
  /** Exit codes that aren't failures (`gh pr checks` exits 8 while checks are pending). */
  readonly okCodes: ReadonlyArray<number>
  /** The call's `repo`, given to gh as `GH_REPO`: not every gh command takes `--repo` (`gh api` doesn't). */
  readonly repo: string | null
}

const fail = (why: string): Result.Result<Command, string> => Result.fail(why)

/** A tool call's arguments, as the agent gave them (decoded by the tool's schema). */
export type ToolArgs = Readonly<Record<string, unknown>>

const digits = (s: string) => /^[0-9]*$/.test(s)

/** `a[k]` trimmed, or null when it isn't a string or is blank. */
export const trimmedArg = (a: ToolArgs, k: string): string | null => {
  const v = a[k]
  if (typeof v !== "string") return null
  const t = v.trim()
  return t === "" ? null : t
}

/** The command a call to `tool` runs, or why its arguments won't do. */
export const command = (tool: string, a: ToolArgs): Result.Result<Command, string> => {
  const s = (k: string) => trimmedArg(a, k)
  // Bodies keep their whitespace.
  const text = (k: string): string | null => {
    const v = a[k]
    return typeof v === "string" ? v : null
  }
  const yes = (k: string) => a[k] === true
  const args: Array<string> = []
  const flag = (f: string, v: string | null) => {
    if (v !== null) args.push(`--${f}=${v}`)
  }
  const target = (k: string): string | null => {
    const v = s(k)
    if (v === null) return null
    if (v.startsWith("-")) return `bad ${k}: ${v}`
    args.push(v)
    return null
  }
  const limit = () => {
    const n = a["limit"]
    if (typeof n === "number" && Number.isInteger(n) && n >= 0) args.push(`--limit=${n}`)
  }
  const gh = (okCodes: ReadonlyArray<number> = [0]): Result.Result<Command, string> => Result.succeed({ program: "gh", args, okCodes, repo: s("repo") })
  switch (tool) {
    case "pr_create": {
      args.push("pr", "create")
      const t = s("title")
      if (t !== null) {
        flag("title", t)
        flag("body", text("body") ?? "")
      } else if (text("body") !== null) return fail("give a title with the body, or neither to fill both from the commits")
      else args.push("--fill")
      flag("base", s("base"))
      flag("head", s("head"))
      if (yes("draft")) args.push("--draft")
      return gh()
    }
    case "pr_view": {
      args.push("pr", "view")
      const bad = target("pr")
      if (bad !== null) return fail(bad)
      let fields = "number,title,state,isDraft,url,author,headRefName,baseRefName,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,body"
      if (yes("comments")) fields += ",comments,reviews"
      flag("json", fields)
      return gh()
    }
    case "pr_list": {
      args.push("pr", "list")
      for (const k of ["state", "head", "base", "author", "search"]) flag(k, s(k))
      limit()
      flag("json", "number,title,state,isDraft,url,author,headRefName,baseRefName,updatedAt")
      return gh()
    }
    case "pr_checks": {
      args.push("pr", "checks")
      const bad = target("pr")
      if (bad !== null) return fail(bad)
      flag("json", "name,state,bucket,workflow,link,startedAt,completedAt")
      return gh([0, 8])
    }
    case "pr_diff": {
      args.push("pr", "diff")
      const bad = target("pr")
      if (bad !== null) return fail(bad)
      if (yes("name_only")) args.push("--name-only")
      return gh()
    }
    case "pr_comment":
    case "issue_comment": {
      const what = tool === "pr_comment" ? "pr" : "issue"
      args.push(what, "comment")
      const bad = target(what)
      if (bad !== null) return fail(bad)
      const body = text("body")
      if (body === null) return fail("body is required")
      flag("body", body)
      return gh()
    }
    case "pr_edit": {
      args.push("pr", "edit")
      const bad = target("pr")
      if (bad !== null) return fail(bad)
      const before = args.length
      flag("title", s("title"))
      flag("body", text("body"))
      flag("base", s("base"))
      if (args.length === before) return fail("nothing to change: give a title, body or base")
      return gh()
    }
    case "pr_merge": {
      // `--repo` keeps gh from cleaning up locally (switching branches, deleting the head branch and any worktree it's
      // checked out in), so `Gh.run` resolves the PR to its number and repository first.
      args.push("pr", "merge")
      const number = s("pr")
      const repo = s("repo")
      if (number === null || !digits(number) || repo === null) return fail("pr_merge needs the PR's number and repository")
      args.push(number)
      flag("repo", repo)
      const m = s("method") ?? "merge"
      if (m === "merge") args.push("--merge")
      else if (m === "squash") args.push("--squash")
      else if (m === "rebase") args.push("--rebase")
      else return fail(`unknown merge method ${m}`)
      if (yes("auto")) args.push("--auto")
      if (yes("delete_branch")) args.push("--delete-branch")
      return gh()
    }
    case "issue_view": {
      args.push("issue", "view")
      const bad = target("issue")
      if (bad !== null) return fail(bad)
      let fields = "number,title,state,url,author,assignees,labels,createdAt,body"
      if (yes("comments")) fields += ",comments"
      flag("json", fields)
      return gh()
    }
    case "issue_list": {
      args.push("issue", "list")
      for (const k of ["state", "label", "assignee", "search"]) flag(k, s(k))
      limit()
      flag("json", "number,title,state,url,author,assignees,labels,updatedAt")
      return gh()
    }
    case "issue_create": {
      args.push("issue", "create")
      const title = s("title")
      if (title === null) return fail("title is required")
      flag("title", title)
      flag("body", text("body") ?? "")
      const labels = a["labels"]
      if (Array.isArray(labels)) for (const l of labels) if (typeof l === "string") flag("label", l)
      return gh()
    }
    case "run_list": {
      args.push("run", "list")
      flag("branch", s("branch"))
      flag("workflow", s("workflow"))
      limit()
      flag("json", "databaseId,workflowName,displayTitle,headBranch,event,status,conclusion,url,createdAt")
      return gh()
    }
    case "run_view": {
      args.push("run", "view")
      const id = s("run_id")
      if (id === null) return fail("run_id is required")
      if (!digits(id)) return fail(`bad run_id: ${id}`)
      args.push(id)
      if (yes("log_failed")) args.push("--log-failed")
      return gh()
    }
    case "api": {
      args.push("api")
      const endpoint = s("endpoint")
      if (endpoint === null) return fail("endpoint is required")
      if (endpoint.startsWith("-")) return fail(`bad endpoint: ${endpoint}`)
      args.push(endpoint)
      flag("method", s("method"))
      const fields = a["fields"]
      if (typeof fields === "object" && fields !== null && !Array.isArray(fields)) {
        const entries: ReadonlyArray<readonly [string, unknown]> = Object.entries(fields)
        for (const [k, v] of entries.toSorted(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
          if (typeof v === "string") args.push("--raw-field", `${k}=${v}`)
          // -F reads `@file` values from disk; JSON scalars never start with `@`.
          else if (typeof v === "number" || typeof v === "boolean") args.push("--field", `${k}=${String(v)}`)
          else if (v === null) args.push("--field", `${k}=null`)
          else return fail(`field ${k}: only strings, numbers, booleans and null (use graphql variables or a string for more)`)
        }
      }
      flag("jq", s("jq"))
      if (yes("paginate")) args.push("--paginate")
      return gh()
    }
    case "gh": {
      const list = a["args"]
      if (!Array.isArray(list)) return fail("args must be a list of strings")
      for (const v of list) {
        if (typeof v !== "string") return fail("args must be a list of strings")
        args.push(v)
      }
      if (args.length === 0) return fail("args is empty")
      const refused = refuse(args)
      if (refused !== null) return fail(refused)
      return gh()
    }
    case "git_push": {
      args.push("push")
      if (yes("force_with_lease")) args.push("--force-with-lease")
      const remote = s("remote") ?? "origin"
      const branch = s("branch") ?? "HEAD"
      if (remote.startsWith("-") || branch.startsWith("-")) return fail("bad remote or branch")
      // A branch name, not a refspec: `+HEAD:refs/heads/master` would force-push master.
      if (!branchName(branch)) return fail("branch must be a branch name")
      // HEAD pushes the current branch under its own name, and -u makes it the upstream.
      args.push("-u", remote, branch)
      return Result.succeed({ program: "git", args, okCodes: [0], repo: null })
    }
    default:
      return fail(`unknown tool ${tool}`)
  }
}

/**
 * Whether git_push's `branch` is a branch name git would take (`git check-ref-format --branch`) rather than a refspec:
 * a leading `+` forces the push and a `:` names another ref to push to. A `+` further in is part of the name
 * (`feature/c++`).
 */
export const branchName = (branch: string): boolean =>
  branch.length > 0 &&
  !"-+/".includes(branch[0] ?? "") &&
  !branch.endsWith("/") &&
  !branch.endsWith(".") &&
  branch !== "@" &&
  !["..", "//", "@{"].some((x) => branch.includes(x)) &&
  // Whitespace, control characters (C0, DEL and C1), and those git takes for something else.
  !hasRefChars(branch) &&
  branch.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"))

/** Whether `s` has whitespace, control characters (C0, DEL and C1), or characters git takes for something else in a ref. */
const hasRefChars = (s: string): boolean => {
  for (const c of s) {
    const n = c.codePointAt(0) ?? 0
    if (n <= 0x1f || (n >= 0x7f && n <= 0x9f) || /[\s:^~*?[\\]/u.test(c)) return true
  }
  return false
}

/** A PR's number and `[HOST/]OWNER/REPO`, from its URL. */
export const prFromUrl = (url: string): readonly [string, string] | null => {
  const t = url.trim()
  const rest = t.startsWith("https://") ? t.slice(8) : t.startsWith("http://") ? t.slice(7) : null
  if (rest === null) return null
  const parts = rest.split("/")
  if (parts.length !== 5 || parts[3] !== "pull") return null
  const [host, owner, name, , number] = parts
  if (number === undefined || number === "" || !digits(number)) return null
  return [number, host === "github.com" ? `${owner}/${name}` : `${host}/${owner}/${name}`]
}

const mentionsMerge = (call: string) => call.toLowerCase().includes("merge")

/**
 * Whether call `a` to `tool` may merge a pull request: pr_merge, `gh pr merge`, or GitHub's API (REST or GraphQL) with
 * "merge" anywhere in the call, or with a request read from a file, which can't be seen. It errs on the side of asking
 * the board: a call that only reads (a PR's mergeability, say) is refused too while a merge waits for approval, and
 * pr_view has that.
 */
export const merges = (tool: string, a: ToolArgs, json: string): boolean => {
  switch (tool) {
    case "pr_merge":
      return true
    // Wherever its words are: flags (and their values) can come between a command and its subcommand
    // (`pr --repo o/r merge`), so any call with both words counts.
    case "gh": {
      const list = a["args"]
      const args: ReadonlyArray<string> = Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []
      const has = (w: string) => args.some((x) => x.toLowerCase() === w)
      // `--input FILE` (or `-`) is the request body, and `-F key=@FILE` a field's value.
      const fromFile = args.some((x) => x.startsWith("--input") || x.startsWith("@") || x.includes("=@"))
      return (has("pr") && has("merge")) || (has("api") && (fromFile || mentionsMerge(args.join(" "))))
    }
    // Its string fields are sent as they are (--raw-field), never read from files: `json` is the call's arguments as JSON.
    case "api":
      return mentionsMerge(json)
    default:
      return false
  }
}

/** Output beyond this (in bytes) is cut from the middle. */
export const MAX_OUTPUT = 60_000

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Keep the start and end of long output (a log's failure is usually at the end). */
export const clip = (s: string): string => {
  const b = encoder.encode(s)
  if (b.length <= MAX_OUTPUT) return s
  // Back up to a char boundary (a byte that isn't a UTF-8 continuation byte).
  const floor = (start: number) => {
    let i = start
    while (i > 0 && ((b[i] ?? 0) & 0xc0) === 0x80) i--
    return i
  }
  const head = floor(MAX_OUTPUT / 2)
  const tail = floor(b.length - MAX_OUTPUT / 2)
  return `${decoder.decode(b.subarray(0, head))}\n\n[… ${tail - head} bytes cut …]\n\n${decoder.decode(b.subarray(tail))}`
}

/** A process's end as Rust's `ExitStatus` shows it (`exit status: 1`, `signal: 9 (SIGKILL)`). */
export const exitStatus = (code: number | null, signal: string | null): string => {
  if (code !== null) return `exit status: ${code}`
  const numbers: Readonly<Record<string, number>> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGABRT: 6, SIGKILL: 9, SIGSEGV: 11, SIGPIPE: 13, SIGTERM: 15 }
  return `signal: ${numbers[signal ?? ""] ?? 0} (${signal ?? "unknown"})`
}
