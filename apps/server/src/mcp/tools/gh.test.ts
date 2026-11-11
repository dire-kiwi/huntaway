import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import { CallId } from "@huntaway/contracts"
import { fakeAgent, fakeGitHub, fakePull, git, gitRepo, TestBoard } from "@huntaway/testing"
import type { FakeAgent, FakeGitHub, FakeGitHubState } from "@huntaway/testing"
import { GH_READ_ONLY, GH_WRITES } from "../../agents/claude/access.ts"
import { MergeGate, openGate } from "../../merge/MergeGate.ts"
import { ProfileRepo } from "../../profiles/ProfileRepo.ts"
import { RunDir } from "../../runs/RunDir.ts"
import { TaskRepo } from "../../tasks/TaskRepo.ts"
import { callResult } from "../jsonrpc.ts"
import { GH_INSTRUCTIONS, McpServers } from "../McpServers.ts"
import type { McpCaller } from "../tool.ts"
import { ToolCalls } from "../ToolCalls.ts"
import { ghTools } from "./gh.ts"

// The gh server's tools (docs/plan/inventory/03-mcp.md 2.10): huntaway's mcp/gh_mcp/tests.test.ts
// `every_tool_builds_and_read_only_ones_exist` and `runs_gh_and_reports_failures`' list, and a call made as a run, through
// `ToolCalls` (recorded, at most once), as the account its launch recorded, against the fake gh. What `Gh` runs is
// github/Gh.test.ts's.

/** The whole board over a fake GitHub of `state`. */
const withBoard = <A, E, R>(state: FakeGitHubState, body: (fake: FakeGitHub) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fake = yield* fakeGitHub(state)
    return yield* body(fake).pipe(Effect.provide(TestBoard({ ghBin: fake.bin })))
  }).pipe(Effect.provide(NodeServices.layer))

/** A running agent whose launch recorded `cwd` and the GitHub account its gh tools act as. */
const runningIn = (cwd: string, account: string | null) =>
  Effect.gen(function* () {
    const agent = yield* fakeAgent()
    yield* (yield* RunDir).writeMcpRun(agent.run.id, { cwd, github_account: account, review: false, in_process: true, desktop: false }).pipe(Effect.orDie)
    return agent
  })

const ghCall = (agent: FakeAgent, tool: string, args: unknown) =>
  Effect.gen(function* () {
    const id = CallId.make(yield* (yield* SecureRandom.SecureRandom).uuidV4())
    const result = yield* (yield* ToolCalls).call({ call_id: id, run: agent.run.id, server: "gh", tool, args })
    return yield* callResult(result, "gh")
  })

const Said = Schema.Struct({ content: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.String })), isError: Schema.optional(Schema.Boolean) })
const said = (result: unknown): readonly [string, boolean] =>
  Schema.is(Said)(result) ? [result.content.map((c) => c.text).join(""), result.isError === true] : assert.fail("not a tool's result")

const Listed = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    inputSchema: Schema.Struct({
      type: Schema.String,
      properties: Schema.Record(Schema.String, Schema.Unknown),
      required: Schema.optional(Schema.Array(Schema.String)),
    }),
    annotations: Schema.Struct({ readOnlyHint: Schema.Boolean }),
  }),
)

describe("the gh server", () => {
  it.effect("lists its 17 tools, each with repo and dir, the read-only ones saying so", () =>
    withBoard({}, () =>
      Effect.gen(function* () {
        const servers = yield* McpServers
        const tools = yield* servers.tools("gh", false)
        const listed = yield* Schema.decodeUnknownEffect(Listed)(tools).pipe(Effect.orDie)
        assert.deepStrictEqual(listed.map((t) => t.name).toSorted(), [...GH_READ_ONLY, ...GH_WRITES].toSorted())
        for (const t of listed) {
          assert.strictEqual(t.annotations.readOnlyHint, GH_READ_ONLY.includes(t.name), t.name)
          assert.strictEqual(t.inputSchema.type, "object", t.name)
          assert.isTrue("repo" in t.inputSchema.properties && "dir" in t.inputSchema.properties, t.name)
        }
        const required = Object.fromEntries(listed.map((t) => [t.name, [...(t.inputSchema.required ?? [])].toSorted()]))
        assert.deepStrictEqual(required["issue_comment"], ["body", "issue"])
        assert.deepStrictEqual(required["pr_comment"], ["body"])
        assert.deepStrictEqual(required["api"], ["endpoint"])
        assert.deepStrictEqual(required["pr_view"], [])
        // Reviewers are shown the same list: their writes are the CLI's to refuse (--disallowedTools), as before.
        assert.strictEqual((yield* servers.tools("gh", true)).length, 17)
        // Its name, and the instructions Claude Code adds to the system prompt, naming the run's account.
        const init = servers.initializeResult("gh", "2025-06-18", "me")
        assert.deepStrictEqual(init["serverInfo"], { name: "huntaway-gh", version: "0.1.0" })
        assert.strictEqual(init["instructions"], `${GH_INSTRUCTIONS} They act as the GitHub account me.`)
        assert.strictEqual(servers.initializeResult("gh", "2025-06-18")["instructions"], GH_INSTRUCTIONS)
      }),
    ),
  )

  it.effect("a call runs gh in the run's folder as its account, once per call id", () =>
    withBoard(
      {
        accounts: [
          { host: "github.com", login: "me", token: "tok-me" },
          { host: "github.com", login: "other", token: "tok-other", active: true },
        ],
        repos: { "o/r": { pulls: [fakePull({ number: 4, head: "feature", title: "Add it" })] } },
      },
      (fake) =>
        Effect.gen(function* () {
          const repo = yield* gitRepo
          yield* git(repo, ["remote", "add", "origin", "https://github.com/o/r.git"])
          const agent = yield* runningIn(repo, "me")
          const [text, failed] = said(yield* ghCall(agent, "pr_view", { pr: "4" }))
          assert.isFalse(failed, text)
          assert.include(text, '"title": "Add it"')
          const view = (yield* fake.calls).find((c) => c.args[0] === "pr" && c.args[1] === "view" && !c.args.includes("--help"))
          assert.deepStrictEqual([view?.as, view?.cwd, view?.repo], ["me", repo, null])
          assert.deepStrictEqual(view?.args, [
            "pr",
            "view",
            "4",
            "--json=number,title,state,isDraft,url,author,headRefName,baseRefName,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,body",
          ])
          // gh's failures are the tool's (isError, gh's own words); refusals and bad arguments are errors.
          const [missing, missingFailed] = said(yield* ghCall(agent, "pr_view", { pr: "99", repo: "o/r" }))
          assert.isTrue(missingFailed && missing.includes("Could not resolve to a PullRequest") && missing.includes("(gh exited with exit status: 1)"), missing)
          const [refused, refusedFailed] = said(yield* ghCall(agent, "gh", { args: ["auth", "token"] }))
          assert.isTrue(refusedFailed && refused.startsWith("Error: gh auth isn't available to agents"), refused)
          const [wrong] = said(yield* ghCall(agent, "pr_view", { nope: 1 }))
          assert.include(wrong, `pr_view has no argument "nope"; its arguments are comments, dir, pr, repo`)
          // Nulls are "not given", as the old tools read them.
          assert.isFalse(said(yield* ghCall(agent, "pr_view", { pr: "4", comments: null }))[1])
          // A comment, made once however often the call is delivered.
          const id = CallId.make("comment-1")
          const toolCalls = yield* ToolCalls
          const comment = { call_id: id, run: agent.run.id, server: "gh", tool: "pr_comment", args: { pr: "4", body: "Looks good" } } as const
          yield* toolCalls.call(comment)
          yield* toolCalls.call(comment)
          assert.deepStrictEqual(
            (yield* fake.pull("o/r", 4))?.comments?.map((c) => [c.author, c.body]),
            [["me", "Looks good"]],
          )
        }),
    ),
  )

  it.effect("asks the merge gate before anything that may merge", () =>
    withBoard(
      {
        accounts: [{ host: "github.com", login: "other", token: "tok-other", active: true }],
        repos: { "o/r": { pulls: [fakePull({ number: 1, head: "x" })] } },
      },
      (fake) =>
        Effect.gen(function* () {
          const agent = yield* runningIn("/tmp", null)
          const task = (yield* (yield* TaskRepo).get(agent.run.task_id)) ?? assert.fail("no task")
          const profile = Option.getOrThrow(yield* (yield* ProfileRepo).get(task.profile_id))
          const caller: McpCaller = { call_id: CallId.make("c1"), server: "gh", run: agent.run, task, profile, mode: "default" }
          const asked: Array<string> = []
          const tools = yield* ghTools.pipe(
            Effect.provideService(
              MergeGate,
              MergeGate.of({
                ...openGate(),
                blocked: (id) => {
                  asked.push(id)
                  return Effect.succeed("Merging is disabled: the user hasn't approved this merge")
                },
              }),
            ),
          )
          const merge = tools.find((t) => t.tool.name === "pr_merge") ?? assert.fail("no pr_merge")
          const out = yield* merge.run({ pr: "1", repo: "o/r" }, caller)
          assert.deepStrictEqual(out, { content: [{ type: "text", text: "Merging is disabled: the user hasn't approved this merge" }], isError: true })
          assert.deepStrictEqual(asked, [task.id])
          assert.deepStrictEqual(yield* fake.calls, [])
          assert.strictEqual((yield* fake.pull("o/r", 1))?.state, "OPEN")
        }),
    ),
  )
})
