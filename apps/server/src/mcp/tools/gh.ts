import { Effect, Schema } from "effect"
import { Tool } from "effect/ai"
import { parseAccount } from "@huntaway/shared"
import { Gh } from "../../github/Gh.ts"
import type { GhOutput, GhRun } from "../../github/Gh.ts"
import { MergeGate } from "../../merge/MergeGate.ts"
import { RunDir } from "../../runs/RunDir.ts"
import { McpServers } from "../McpServers.ts"
import type { RegisteredTool } from "../McpServers.ts"
import { Rerunnable, ToolError } from "../tool.ts"
import type { LocalCaller } from "../tool.ts"
import { threadTool } from "./common.ts"

// The board's `gh` server (docs/plan/inventory/03-mcp.md 2.10; huntaway's mcp/gh_mcp.ts `tools`): GitHub through the
// gh CLI, run outside the agent's sandbox as the run's GitHub account (`Gh`). Names, arguments and descriptions are the
// old ones word for word. Every tool takes `repo` and `dir` too. The read-only ones say so (`readOnlyHint`, which
// Codex runs without asking) and may run again after a restart; Claude runs have them in `--allowedTools`
// (agents/claude/access.ts `ghAllowed`), and reviewers don't get the rest (`GH_WRITES` in `--disallowedTools`): the
// server itself doesn't check who calls, as before. A result is gh's output as text, `isError` when gh failed.

const repo = Schema.String.annotate({ description: "OWNER/REPO, if not the working directory's repository" })
const dir = Schema.String.annotate({ description: "Directory to run in (defaults to your working directory)" })
const pr = Schema.String.annotate({ description: "Pull request number, URL or branch; defaults to the current branch's" })
const issue = Schema.String.annotate({ description: "Issue number or URL" })
const limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })).annotate({ description: "At most this many (default 30)" })
const markdown = Schema.String.annotate({ description: "Markdown" })

/** A gh tool's result: gh's output as one text, an error when gh failed. */
export const GhContent = Schema.Struct({
  content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
  isError: Schema.Boolean,
})
export type GhContent = typeof GhContent.Type

const opt = Schema.optionalKey

/** A gh tool: its own parameters and `repo` and `dir`, gh's output as its result. */
const ghTool = <const Name extends string, const Fields extends Schema.Struct.Fields>(name: Name, description: string, fields: Fields) =>
  Tool.make(name, { description, parameters: Schema.Struct({ ...fields, repo: opt(repo), dir: opt(dir) }), success: GhContent })

/** One that only reads: Codex runs it without asking, and it may run again after a restart. */
const readOnlyTool = <const Name extends string, const Fields extends Schema.Struct.Fields>(name: Name, description: string, fields: Fields) =>
  ghTool(name, description, fields).annotate(Tool.Readonly, true).annotate(Rerunnable, true)

export const PrCreate = ghTool(
  "pr_create",
  "Open a pull request for the current branch (push it first, e.g. with git_push). Without a title, gh fills the title and body from the commits.",
  {
    title: opt(Schema.String),
    body: opt(markdown),
    base: opt(Schema.String.annotate({ description: "Branch to merge into (defaults to the repository's default branch)" })),
    head: opt(Schema.String.annotate({ description: "Branch to merge from (defaults to the current branch)" })),
    draft: opt(Schema.Boolean),
  },
)

export const PrView = readOnlyTool(
  "pr_view",
  "A pull request's details as JSON: state, branches, mergeability, review decision, checks and body; with comments, its comments and reviews too.",
  { pr: opt(pr), comments: opt(Schema.Boolean) },
)

export const PrList = readOnlyTool("pr_list", "List pull requests as JSON.", {
  state: opt(Schema.Literals(["open", "closed", "merged", "all"]).annotate({ description: "Default open" })),
  head: opt(Schema.String.annotate({ description: "Only PRs from this branch" })),
  base: opt(Schema.String.annotate({ description: "Only PRs into this branch" })),
  author: opt(Schema.String.annotate({ description: "Only PRs by this user (@me for yourself)" })),
  search: opt(Schema.String.annotate({ description: "GitHub search query" })),
  limit: opt(limit),
})

export const PrChecks = readOnlyTool("pr_checks", "A pull request's CI checks as JSON (name, state, bucket pass/fail/pending/skipping, link).", { pr: opt(pr) })

export const PrDiff = readOnlyTool("pr_diff", "A pull request's diff.", {
  pr: opt(pr),
  name_only: opt(Schema.Boolean.annotate({ description: "Only the names of the changed files" })),
})

export const PrComment = ghTool("pr_comment", "Comment on a pull request.", { pr: opt(pr), body: markdown })

export const PrEdit = ghTool("pr_edit", "Change a pull request's title, body or base branch.", {
  pr: opt(pr),
  title: opt(Schema.String),
  body: opt(Schema.String),
  base: opt(Schema.String),
})

export const PrMerge = ghTool(
  "pr_merge",
  "Merge a pull request on GitHub. This doesn't touch local branches or worktrees. One in a stack on GitHub (a stacked pull " +
    "request) is merged with GitHub's merge-async API, which those need, once those below it are merged.",
  {
    pr: opt(pr),
    method: opt(Schema.Literals(["merge", "squash", "rebase"]).annotate({ description: "Default merge" })),
    auto: opt(Schema.Boolean.annotate({ description: "Merge once the required checks pass, instead of now" })),
    delete_branch: opt(Schema.Boolean.annotate({ description: "Delete the PR's branch on GitHub after merging (not with auto, or for a PR from a fork)" })),
  },
)

export const IssueView = readOnlyTool("issue_view", "An issue's details as JSON; with comments, its comments too.", { issue, comments: opt(Schema.Boolean) })

export const IssueList = readOnlyTool("issue_list", "List issues as JSON.", {
  state: opt(Schema.Literals(["open", "closed", "all"]).annotate({ description: "Default open" })),
  label: opt(Schema.String),
  assignee: opt(Schema.String.annotate({ description: "@me for yourself" })),
  search: opt(Schema.String.annotate({ description: "GitHub search query" })),
  limit: opt(limit),
})

export const IssueCreate = ghTool("issue_create", "Open an issue.", {
  title: Schema.String,
  body: opt(markdown),
  labels: opt(Schema.Array(Schema.String)),
})

export const IssueComment = ghTool("issue_comment", "Comment on an issue.", { issue, body: markdown })

export const RunList = readOnlyTool("run_list", "List recent GitHub Actions workflow runs as JSON.", {
  branch: opt(Schema.String),
  workflow: opt(Schema.String.annotate({ description: "Workflow name or file" })),
  limit: opt(limit),
})

export const RunView = readOnlyTool("run_view", "A workflow run's jobs and steps, or with log_failed, the logs of its failed steps.", {
  run_id: Schema.String.annotate({ description: "The run's id (databaseId in run_list)" }),
  log_failed: opt(Schema.Boolean),
})

export const Api = ghTool("api", "Call the GitHub REST API (gh api). {owner} and {repo} in the endpoint are filled in from the repository.", {
  endpoint: Schema.String.annotate({ description: "e.g. repos/{owner}/{repo}/pulls/1/comments, or graphql" }),
  method: opt(Schema.Literals(["GET", "POST", "PATCH", "PUT", "DELETE"]).annotate({ description: "Default GET (POST when there are fields)" })),
  fields: opt(
    Schema.Record(Schema.String, Schema.Unknown).annotate({
      description: "Parameters: query parameters for GET, otherwise the request body. Strings are sent as they are; numbers, booleans and null as JSON.",
    }),
  ),
  jq: opt(Schema.String.annotate({ description: "jq expression to filter the response with" })),
  paginate: opt(Schema.Boolean.annotate({ description: "Fetch every page" })),
})

export const GhCommand = ghTool("gh", "Run any gh command, for what the other tools don't cover. Nothing is interactive: pass everything as arguments.", {
  args: Schema.Array(Schema.String).annotate({ description: 'gh\'s arguments, e.g. ["release", "list"]' }),
})

export const GitPush = ghTool("git_push", "Push a branch with git, outside the sandbox and with the user's git credentials.", {
  remote: opt(Schema.String.annotate({ description: "Default origin" })),
  branch: opt(Schema.String.annotate({ description: "Default the current branch" })),
  force_with_lease: opt(Schema.Boolean.annotate({ description: "Overwrite the remote branch if it hasn't changed since you last fetched it" })),
})

/** The gh server's tools, in `tools/list`'s order. */
export const GH_TOOLS = [
  PrCreate,
  PrView,
  PrList,
  PrChecks,
  PrDiff,
  PrComment,
  PrEdit,
  PrMerge,
  IssueView,
  IssueList,
  IssueCreate,
  IssueComment,
  RunList,
  RunView,
  Api,
  GhCommand,
  GitPush,
] as const

/** gh's output as a tool's result. */
const content = (out: GhOutput): GhContent => ({ content: [{ type: "text", text: out.text }], isError: out.failed })

/** The gh server's tools with their handlers: each runs `Gh.run` for the caller's run, as the account its launch recorded. */
export const ghTools = Effect.gen(function* () {
  const gh = yield* Gh
  const dirs = yield* RunDir
  const gate = yield* MergeGate

  /** Where the caller's calls run and as whom (the run's `mcp-run.json`), and the board's say on its merges. */
  const runOf = Effect.fnUntraced(function* (caller: LocalCaller) {
    const settings = yield* dirs.mcpRun(caller.run.id)
    const name = settings?.github_account ?? null
    const account = name === null ? null : parseAccount(name)
    if (name !== null && account === null) return yield* ToolError.other(`the GitHub account ${name} isn't one gh can use`)
    const run: GhRun = { cwd: settings === null || settings.cwd === "" ? null : settings.cwd, account, mergeGate: gate.blocked(caller.task.id) }
    return run
  })

  const handle = (tool: Tool.Any) => (params: Readonly<Record<string, unknown>>, caller: LocalCaller) =>
    runOf(caller).pipe(
      Effect.flatMap((run) => gh.run(tool.name, params, run)),
      Effect.map(content),
      Effect.catchTag("GhRefused", (e) => Effect.fail(ToolError.other(e.message))),
    )

  const all: ReadonlyArray<RegisteredTool> = [
    threadTool(PrCreate, handle(PrCreate)),
    threadTool(PrView, handle(PrView)),
    threadTool(PrList, handle(PrList)),
    threadTool(PrChecks, handle(PrChecks)),
    threadTool(PrDiff, handle(PrDiff)),
    threadTool(PrComment, handle(PrComment)),
    threadTool(PrEdit, handle(PrEdit)),
    threadTool(PrMerge, handle(PrMerge)),
    threadTool(IssueView, handle(IssueView)),
    threadTool(IssueList, handle(IssueList)),
    threadTool(IssueCreate, handle(IssueCreate)),
    threadTool(IssueComment, handle(IssueComment)),
    threadTool(RunList, handle(RunList)),
    threadTool(RunView, handle(RunView)),
    threadTool(Api, handle(Api)),
    threadTool(GhCommand, handle(GhCommand)),
    threadTool(GitPush, handle(GitPush)),
  ]
  return all
})

/** The `gh` server's tools, registered (`Main.ts`' `mcpLayer`, beside the board's). */
export const GhTools = McpServers.register("gh", ghTools)
