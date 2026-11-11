import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { TaskId } from "@huntaway/contracts"
import type { PermissionMode } from "@huntaway/contracts"
import type { Rules } from "@huntaway/shared"
import { defaultRuleSet } from "../rules.ts"
import { noRunTools } from "./access.ts"
import { launchGoldens } from "./fixtures/launchSpecs.ts"
import type { LaunchGolden } from "./fixtures/launchSpecs.ts"
import { claudeLaunch, initializeLine, recordedEffort } from "./launch.ts"
import type { ClaudeLaunchInput } from "./launch.ts"

// The Claude launch against what the old server wrote for the same run (fixtures/launchSpecs.ts, recorded from
// huntaway's launch.ts): the arguments in order, the environment it adds, spec.json, the two prompt lines (or a
// compaction's plain prompt), mcp.json and mcp-run.json.

/** What each recorded case was set up with, beyond the defaults below. */
const cases: Readonly<Record<string, Partial<ClaudeLaunchInput>>> = {
  "a task's first run": {},
  "a resumed session with a model and effort": { effort: "ultra" },
  "auto mode": { permissionMode: "auto" },
  "bypass without rules": { permissionMode: "bypassPermissions" },
  "plan mode with minimal effort": { permissionMode: "plan", effort: "minimal" },
  "a merging task": {},
  "a compaction": { kind: "compact" },
  "a labelled task": { addDirs: ["/data/documents/TASK"] },
  "a review thread": {},
  "a scratch task": {},
  "a config with its own folder and a proxy": {
    configDir: "~/.claude-work",
    apiEnv: [
      ["ANTHROPIC_BASE_URL", "https://proxy.example/v1"],
      ["ANTHROPIC_AUTH_TOKEN", "k-123"],
      ["ANTHROPIC_API_KEY", ""],
    ],
  },
  "the assistant, with the default approval rules": { rules: defaultRuleSet() },
  "the assistant in bypass, with rules that ask and refuse": {
    permissionMode: "bypassPermissions",
    rules: {
      rules: [
        { tool: "Bash", decision: "ask" },
        { tool: "WebFetch", decision: "never" },
        { tool: "mcp__github__*", decision: "ask" },
        { tool: "mcp__huntaway__create_task", decision: "ask" },
      ],
      expiry_minutes: 30,
    } satisfies Rules,
  },
}

const inputOf = (golden: LaunchGolden, own: Partial<ClaudeLaunchInput>): ClaudeLaunchInput => ({
  run: "RUN",
  runDir: "/data/runs/RUN",
  kind: "prompt",
  task: { id: TaskId.make("TASK"), ...golden.task },
  cwd: golden.expected.cwd,
  program: "claude",
  exe: "/opt/huntaway/bin/huntaway",
  home: "/home/me",
  configDir: null,
  apiEnv: [],
  telemetryEnv: [],
  tmp: "/tmp/ha-0/TASKTMP",
  resumeAt: null,
  model: "opus",
  effort: "high",
  permissionMode: "default" satisfies PermissionMode,
  rules: null,
  tools: noRunTools,
  served: { gh: true, docs: true, desktop: false },
  githubAccount: null,
  addDirs: [],
  attachmentDirs: [],
  prompt: golden.promptText,
  promptId: "PROMPT",
  systemPrompt: "",
  mcp: { url: "/api/mcp/RUN/", secret: "SECRET", manifest: golden.manifest },
  ...own,
})

const goldenOf = (name: string): LaunchGolden => {
  const golden = launchGoldens[name]
  if (golden === undefined) throw new Error(`no golden ${name}`)
  return golden
}

describe("claudeLaunch", () => {
  it("covers every recorded case", () => {
    assert.deepStrictEqual(Object.keys(cases).toSorted(), Object.keys(launchGoldens).toSorted())
  })

  for (const [name, golden] of Object.entries(launchGoldens)) {
    it.effect(`launches as the old server did: ${name}`, () =>
      Effect.gen(function* () {
        const spec = yield* claudeLaunch(inputOf(golden, cases[name] ?? {}))
        const want = golden.expected
        assert.strictEqual(spec.program, want.program)
        assert.deepStrictEqual(spec.args, want.args)
        assert.deepStrictEqual(Object.fromEntries(spec.env.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), want.env)
        // spec.json
        assert.deepStrictEqual({ args: spec.args, config_dir: spec.configDir, cwd: spec.cwd }, want.spec)
        assert.strictEqual(spec.prompt, want.prompt)
        assert.strictEqual(spec.promptId, want.awaited)
        assert.strictEqual(spec.input, want.input)
        assert.deepStrictEqual({ mcpServers: spec.mcpServers }, want.mcp)
        assert.deepStrictEqual(spec.mcpRun, want.mcpRun)
      }),
    )
  }

  it.effect("a run without a launcher has no hooks, and a server the board doesn't serve isn't offered", () =>
    Effect.gen(function* () {
      const golden = goldenOf("a task's first run")
      const spec = yield* claudeLaunch({ ...inputOf(golden, {}), exe: null, served: { gh: false, docs: false, desktop: false } })
      assert.isFalse(spec.args.includes("--settings"))
      // gh's read-only tools stay allowed, as they were whether or not the run had the server.
      assert.isFalse(spec.args.includes("mcp__docs"))
      assert.isTrue(spec.args.includes("mcp__gh__pr_view"))
      assert.deepStrictEqual(Object.keys(spec.mcpServers ?? {}), [])
    }),
  )

  it.effect("the initialize line names the board's in-process server", () =>
    Effect.gen(function* () {
      const line = yield* initializeLine("r1", { initializeResult: { protocolVersion: "2025-11-25" }, toolsListResult: { tools: [] } })
      assert.strictEqual(
        line,
        '{"type":"control_request","request_id":"huntaway-init-r1","request":{"subtype":"initialize","sdkMcpServers":["huntaway"],"sdkMcpServerConfigs":{"huntaway":{"timeout":86400000,"disableAutoBackground":true}},"sdkMcpServerManifests":{"huntaway":{"initializeResult":{"protocolVersion":"2025-11-25"},"toolsListResult":{"tools":[]}}}}}',
      )
    }),
  )

  // huntaway's a_run_keeps_the_effort_its_agent_was_given: Claude has no `minimal` or `ultra`; the agent's own default is "".
  it("keeps the effort its agent was given", () => {
    assert.deepStrictEqual([recordedEffort("minimal"), recordedEffort("ultra"), recordedEffort("high"), recordedEffort(null)], ["low", "max", "high", ""])
  })
})
