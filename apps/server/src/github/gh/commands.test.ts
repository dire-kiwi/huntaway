import { assert, describe, it } from "@effect/vitest"
import { Result } from "effect"
import { branchName, clip, command, MAX_OUTPUT, merges, prFromUrl } from "./commands.ts"
import type { ToolArgs } from "./commands.ts"

// huntaway's mcp/gh_mcp/tests.test.ts, the cases of the commands the gh tools run: `builds_commands` (its refusals of gh
// commands are packages/shared's, test/gh.test.ts), `knows_which_calls_merge`, `reads_pr_urls`, `clips_long_output`.

const built = (tool: string, a: ToolArgs) => {
  const c = command(tool, a)
  return Result.isSuccess(c) ? c.success : assert.fail(`${tool} ${c.failure}`)
}
const args = (tool: string, a: ToolArgs) => built(tool, a).args
const refused = (tool: string, a: ToolArgs) => Result.isFailure(command(tool, a))
const gh = (a: ReadonlyArray<string>) => merges("gh", { args: a }, "")
/** `api`'s call, with its arguments as JSON as the tool gives them. */
const apiMerges = (a: ToolArgs, json: string) => merges("api", a, json)

describe("the gh tools' commands", () => {
  it("builds every tool's command", () => {
    const full = { pr: "3", repo: "o/r", issue: "4", body: "b", title: "t", run_id: "5", endpoint: "user", args: ["status"] }
    for (const tool of [
      "pr_create",
      "pr_view",
      "pr_list",
      "pr_checks",
      "pr_diff",
      "pr_comment",
      "pr_edit",
      "pr_merge",
      "issue_view",
      "issue_list",
      "issue_create",
      "issue_comment",
      "run_list",
      "run_view",
      "api",
      "gh",
      "git_push",
    ]) {
      assert.isFalse(refused(tool, full), tool)
    }
    assert.isTrue(refused("no_such_tool", full))
  })

  it("builds commands with --flag=value and no target starting with -", () => {
    assert.deepStrictEqual(args("pr_create", {}), ["pr", "create", "--fill"])
    const create = built("pr_create", { title: "Fix it", body: "- one\n", base: "master", draft: true, repo: "o/r" })
    assert.deepStrictEqual(create.args, ["pr", "create", "--title=Fix it", "--body=- one\n", "--base=master", "--draft"])
    assert.strictEqual(create.repo, "o/r")
    // gh api has no --repo: the repository goes in GH_REPO, as for every gh command.
    const api = built("api", { endpoint: "repos/{owner}/{repo}/pulls", repo: "cli/cli" })
    assert.deepStrictEqual([api.args, api.repo], [["api", "repos/{owner}/{repo}/pulls"], "cli/cli"])
    assert.isTrue(refused("pr_create", { body: "x" }))
    // pr_merge always passes --repo (resolved by `Gh.run`), so gh leaves local branches alone.
    assert.deepStrictEqual(args("pr_merge", { pr: "12", repo: "o/r", delete_branch: true }), ["pr", "merge", "12", "--repo=o/r", "--merge", "--delete-branch"])
    assert.isTrue(refused("pr_merge", { pr: "12" }))
    assert.isTrue(refused("pr_merge", { pr: "feature", repo: "o/r" }))
    assert.isTrue(refused("pr_edit", { pr: "1" }))
    assert.deepStrictEqual(args("pr_edit", { body: "" }), ["pr", "edit", "--body="])
    assert.deepStrictEqual(args("pr_edit", { pr: "1", title: "T" }), ["pr", "edit", "1", "--title=T"])
    assert.isTrue(refused("pr_view", { pr: "-R evil.example.com/o/r" }))
    assert.deepStrictEqual(built("pr_checks", {}).okCodes, [0, 8])
    assert.deepStrictEqual(args("api", { endpoint: "repos/{owner}/{repo}/issues", fields: { title: "@x" }, paginate: true }), [
      "api",
      "repos/{owner}/{repo}/issues",
      "--raw-field",
      "title=@x",
      "--paginate",
    ])
    assert.deepStrictEqual(args("api", { endpoint: "graphql", fields: { n: 2, b: true, z: null } }), [
      "api",
      "graphql",
      "--field",
      "b=true",
      "--field",
      "n=2",
      "--field",
      "z=null",
    ])
    assert.isTrue(refused("api", { endpoint: "x", fields: { a: [1] } }))
    assert.isTrue(refused("run_view", { run_id: "1; rm" }))
    assert.isTrue(refused("gh", { args: [] }))
    assert.isTrue(refused("gh", { args: ["auth", "token"] }))
    assert.deepStrictEqual(args("issue_create", { title: "T", labels: ["a", "b"] }), ["issue", "create", "--title=T", "--body=", "--label=a", "--label=b"])
    const push = built("git_push", { repo: "ignored" })
    assert.deepStrictEqual([push.program, push.args], ["git", ["push", "-u", "origin", "HEAD"]])
    assert.deepStrictEqual(args("git_push", { branch: "ia/x-1_fix.it" }), ["push", "-u", "origin", "ia/x-1_fix.it"])
  })

  it("pushes a branch, not a refspec that would push (or force-push) another ref", () => {
    for (const bad of [
      "+HEAD:refs/heads/master",
      "HEAD:master",
      ":master",
      "-f",
      "a b",
      "a..b",
      "x^",
      "*",
      "+master",
      "a[b",
      "@",
      "a@{1}",
      "a/.b",
      "a.lock",
      "a/",
      "a.",
      "a//b",
      "a\tb",
      "a\u0085b",
    ]) {
      assert.isTrue(refused("git_push", { branch: bad }), bad)
    }
    for (const good of ["feature/c++", "HEAD", "v1.2", "a@b", "x+"]) assert.deepStrictEqual(args("git_push", { branch: good }), ["push", "-u", "origin", good])
    assert.isFalse(branchName(""))
  })

  // HA-86: a merge waiting for approval could go through the gh tool or the API instead.
  it("knows which calls merge", () => {
    assert.isTrue(merges("pr_merge", { pr: "1" }, ""))
    assert.isTrue(gh(["pr", "merge", "1", "--squash"]) && gh(["--help", "pr", "merge"]))
    // With flags between the command and its subcommand.
    assert.isTrue(gh(["pr", "--repo=o/r", "merge", "1", "--merge"]) && gh(["pr", "-R", "o/r", "merge", "1"]))
    assert.isTrue(gh(["api", "--method", "PUT", "repos/o/r/pulls/1/merge"]))
    assert.isTrue(gh(["api", "-X", "PUT", "repos/o/r/pulls/1/merge"]))
    assert.isTrue(gh(["api", "graphql", "-f", "query=mutation { mergePullRequest(input: {}) { clientMutationId } }"]))
    assert.isTrue(apiMerges({ endpoint: "repos/o/r/pulls/1/merge", method: "PUT" }, '{"endpoint":"repos/o/r/pulls/1/merge","method":"PUT"}'))
    assert.isTrue(apiMerges({}, '{"endpoint":"graphql","fields":{"query":"mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }"}}'))
    // A request read from a file could be anything (HA-86 review).
    assert.isTrue(gh(["api", "graphql", "--method", "POST", "--input", "/x/payload.json"]) && gh(["api", "graphql", "--input=/x/p.json"]))
    assert.isTrue(gh(["api", "graphql", "-F", "query=@/x/query.graphql"]) && gh(["api", "graphql", "--field=query=@q"]))
    // As could one that mentions merging, so it waits too, even if it only reads.
    assert.isTrue(apiMerges({}, '{"endpoint":"repos/o/r/pulls/1/merge"}'))
    // Anything else doesn't.
    assert.isTrue(!gh(["api", "repos/o/r/pulls/1"]) && !gh(["api", "graphql", "-f", "query={ viewer { login } }", "-F", "n=1"]))
    assert.isFalse(apiMerges({}, '{"endpoint":"repos/o/r/issues","fields":{"body":"@someone"}}'))
    assert.isTrue(!gh(["pr", "view", "1"]) && !merges("pr_view", { pr: "1" }, "") && !merges("pr_checks", { pr: "merge" }, ""))
  })

  it("reads pull requests' URLs", () => {
    assert.deepStrictEqual(prFromUrl("https://github.com/o/r/pull/12\n"), ["12", "o/r"])
    assert.deepStrictEqual(prFromUrl("https://ghe.example.com/o/r/pull/3"), ["3", "ghe.example.com/o/r"])
    assert.isNull(prFromUrl("https://github.com/o/r/issues/3"))
    assert.isNull(prFromUrl("no pull request"))
  })

  it("clips long output from the middle, on a character's boundary", () => {
    assert.strictEqual(clip("short"), "short")
    const long = "é".repeat(MAX_OUTPUT)
    const c = clip(long)
    assert.isTrue(new TextEncoder().encode(c).length < new TextEncoder().encode(long).length && c.includes("bytes cut"))
    assert.isFalse(c.includes("�"))
  })
})
