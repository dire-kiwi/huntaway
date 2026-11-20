import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { TaskId } from "@huntaway/contracts"
import { noRunTools } from "../claude/access.ts"
import { acpLaunch, acpModel, acpServers } from "./launch.ts"
import type { AcpLaunchInput } from "./launch.ts"

// How an ACP agent's run is launched (HE-69): the adapter on acp.json, the board's servers over HTTP (its own among
// them: no dynamic tools), the agent's home in GEMINI_HOME, and no compaction.

const input = (fields: Partial<AcpLaunchInput> = {}): AcpLaunchInput => ({
  run: "r1",
  runDir: "/data/runs/r1",
  kind: "prompt",
  task: { id: TaskId.make("t1"), kind: "task", session_id: null },
  cwd: "/w",
  exe: "/opt/huntaway/bin/huntaway",
  home: "/home/me",
  configDir: "~/.gemini-work",
  command: null,
  tmp: "/tmp/ha/t1",
  model: "gemini-3-pro",
  effort: "high",
  permissionMode: "acceptEdits",
  tools: noRunTools,
  served: { gh: true, desktop: false },
  githubAccount: "me",
  systemPrompt: "You are an agent.",
  prompt: "Do it.",
  promptId: "p1",
  mcp: {
    url: "http://127.0.0.1:1/api/mcp/r1/",
    secret: "s",
    manifest: { initializeResult: { instructions: "The board." }, toolsListResult: { tools: [{ name: "get_task" }] } },
  },
  ...fields,
})

const launch = (fields: Partial<AcpLaunchInput> = {}) => acpLaunch(input(fields))

const bearer = [{ name: "Authorization", value: "Bearer s" }]

describe("an ACP agent's run's launch", () => {
  it.effect("runs the adapter on acp.json, with the prompt as its input's first message and the board's servers over HTTP", () =>
    Effect.gen(function* () {
      const { spec, acp } = yield* launch()
      assert.deepStrictEqual(acp, {
        cwd: "/w",
        program: "agy",
        args: ["acp"],
        session_id: null,
        model: "gemini-3-pro",
        effort: "high",
        mode: "acceptEdits",
        system_prompt: "You are an agent.",
        input: true,
        requests_on_output: true,
        mcp_servers: [
          { type: "http", name: "huntaway", url: "http://127.0.0.1:1/api/mcp/r1/huntaway", headers: bearer },
          { type: "http", name: "gh", url: "http://127.0.0.1:1/api/mcp/r1/gh", headers: bearer },
        ],
      })
      assert.deepStrictEqual(
        { ...spec, mcpServers: Object.keys(spec.mcpServers ?? {}) },
        {
          program: "/opt/huntaway/bin/huntaway",
          args: ["acp-run", "/data/runs/r1/acp.json"],
          env: [
            ["TMPDIR", "/tmp/ha/t1"],
            ["HUNTAWAY_TASK_ID", "t1"],
            ["GEMINI_HOME", "/home/me/.gemini-work"],
          ],
          cwd: "/w",
          configDir: "~/.gemini-work",
          prompt: '{"type":"user","uuid":"p1","message":{"role":"user","content":"Do it."}}\n',
          input: true,
          promptId: null,
          systemPrompt: null,
          mcpServers: ["huntaway", "gh"],
          mcpRun: { cwd: "/w", github_account: "me", review: false, in_process: false, desktop: false },
          acp,
        },
      )
    }),
  )

  it.effect("a config's command line, a session to go on with, and no GEMINI_HOME for the agent's own folder", () =>
    Effect.gen(function* () {
      const { spec, acp } = yield* launch({
        command: " my-agent  --acp --verbose ",
        configDir: null,
        task: { id: TaskId.make("t1"), kind: "review", session_id: "sess-1" },
        model: null,
      })
      assert.deepStrictEqual([acp.program, acp.args, acp.session_id, acp.model], ["my-agent", ["--acp", "--verbose"], "sess-1", null])
      assert.isFalse(spec.env.some(([k]) => k === "GEMINI_HOME"))
      assert.isTrue(spec.mcpRun?.review)
      assert.strictEqual((yield* launch({ configDir: " " })).spec.env.length, 2)
    }),
  )

  it.effect("is refused without the launcher, and for a compaction", () =>
    Effect.gen(function* () {
      const noExe = yield* Effect.flip(launch({ exe: null }))
      assert.include(noExe.reason, "launcher")
      const compact = yield* Effect.flip(launch({ kind: "compact" }))
      assert.include(compact.reason, "can't be compacted")
    }),
  )

  it.effect("the project's servers and the plugins' join the board's; one the project names replaces the board's but its own", () =>
    Effect.gen(function* () {
      const tools = {
        ...noRunTools,
        mcp_servers: {
          gh: { command: "my-gh", args: ["serve"], env: { TOKEN: "t" } },
          huntaway: { type: "http", url: "http://elsewhere" },
          sentry: { type: "streamable-http", url: "https://mcp.sentry.dev", headers: { Authorization: "k" } },
          old: { type: "sse", url: "http://sse" },
          odd: { type: "stdio" },
        },
      }
      const { acp } = yield* launch({ tools, served: { gh: true, desktop: false, plugins: [{ name: "docs", preApproved: true }] } })
      assert.deepStrictEqual(acp.mcp_servers, [
        { type: "http", name: "huntaway", url: "http://127.0.0.1:1/api/mcp/r1/huntaway", headers: bearer },
        { type: "http", name: "docs", url: "http://127.0.0.1:1/api/mcp/r1/docs", headers: bearer },
        { name: "gh", command: "my-gh", args: ["serve"], env: [{ name: "TOKEN", value: "t" }] },
        { type: "http", name: "sentry", url: "https://mcp.sentry.dev", headers: [{ name: "Authorization", value: "k" }] },
      ])
    }),
  )

  it("asks for the thread's model unless it is Claude's or Codex's", () => {
    assert.deepStrictEqual(
      ["gemini-3-pro", "opus", "claude-sonnet-4-5", "gpt-5.1", "codex-mini", "o3", null].map(acpModel),
      ["gemini-3-pro", null, null, null, null, null, null],
    )
  })

  it("turns mcp.json's entries into ACP's, leaving out what it can't give", () => {
    assert.deepStrictEqual(acpServers({ a: { command: "x" }, b: null, c: { type: "http" }, d: "no" }), [{ name: "a", command: "x", args: [], env: [] }])
  })
})
