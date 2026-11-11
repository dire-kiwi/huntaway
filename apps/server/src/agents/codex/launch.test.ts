import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { TaskId } from "@huntaway/contracts"
import { noRunTools } from "../claude/access.ts"
import { codexLaunch, REVIEW_SANDBOX_NOTE } from "./launch.ts"
import type { CodexLaunchInput } from "./launch.ts"

// How a Codex run is launched (the old agent/codex/launch.test.ts, which ran the old launch under a stand-in ia-shim; here
// the pure launch): a new session gets the board's tools as dynamic tools (and the board's MCP server only if its Codex
// won't take them); one that started with them keeps them; one from before, or whose Codex wouldn't take them, has the
// board's MCP server, whose waits Codex's reviewer reviews in auto mode. Dropped: the docs and desktop servers' cases (no
// HTTP server but the board's is served yet: 6.3, 6.10), which `claude/launch.test.ts`' served-server cases cover.

const input = (fields: Partial<CodexLaunchInput> = {}): CodexLaunchInput => ({
  run: "r1",
  runDir: "/data/runs/r1",
  kind: "prompt",
  task: { id: TaskId.make("t1"), kind: "task", session_id: null },
  cwd: "/w",
  exe: "/opt/huntaway/bin/huntaway",
  codexBin: "codex",
  home: "/home/me",
  configDir: "~/.codex-work",
  tmp: "/tmp/ha/t1",
  model: null,
  effort: null,
  permissionMode: "default",
  rules: null,
  tools: noRunTools,
  served: { gh: true, docs: false, desktop: false },
  githubAccount: null,
  systemPrompt: "You are an agent.",
  prompt: "Do it.",
  promptId: "p1",
  gitDir: "/w/.git",
  cacheDirs: ["/home/me/.cache"],
  documentsDir: null,
  reviewFilesystem: null,
  sessionBoardTools: false,
  revertBeforeTurn: null,
  configOverrides: [],
  mcp: {
    url: "http://127.0.0.1:1/api/mcp/r1/",
    secret: "s",
    manifest: { initializeResult: { instructions: "The board." }, toolsListResult: { tools: [{ name: "get_task" }] } },
  },
  ...fields,
})

const launch = (fields: Partial<CodexLaunchInput> = {}) => codexLaunch(input(fields))

describe("a Codex run's launch", () => {
  it.effect("runs the adapter on codex.json, with the prompt as its input's first message, CODEX_HOME and no Claude settings", () =>
    Effect.gen(function* () {
      const { spec, codex } = yield* launch()
      assert.deepStrictEqual([spec.program, spec.args], ["/opt/huntaway/bin/huntaway", ["codex-run", "/data/runs/r1/codex.json"]])
      assert.strictEqual(spec.prompt, '{"type":"user","uuid":"p1","message":{"role":"user","content":"Do it."}}\n')
      assert.deepStrictEqual([spec.input, spec.promptId, spec.systemPrompt], [true, null, null])
      const env = new Map(spec.env)
      assert.deepStrictEqual(
        [env.get("CODEX_HOME"), env.get("HUNTAWAY_CODEX_BIN"), env.get("TMPDIR"), env.get("HUNTAWAY_TASK_ID")],
        ["/home/me/.codex-work", "codex", "/tmp/ha/t1", "t1"],
      )
      // Codex has its own todo list (update_plan), and isn't told of Claude's.
      assert.isFalse(env.has("CLAUDE_CODE_ENABLE_TODO_TOOLS") || env.has("CLAUDE_CODE_ENABLE_TASKS"))
      assert.deepStrictEqual([codex.approval_policy, codex.approvals_reviewer, codex.sandbox], ["untrusted", "user", "workspace-write"])
      assert.deepStrictEqual(codex.writable_roots, ["/w/.git", "/home/me/.cache", "/tmp/ha/t1"])
      assert.strictEqual(codex.developer_instructions, "You are an agent.")
    }),
  )

  it.effect("a new session gets the board's tools as dynamic tools, and keeps the board's server for a Codex that won't take them", () =>
    Effect.gen(function* () {
      const { spec, codex, boardTools } = yield* launch()
      assert.isTrue(boardTools)
      assert.deepStrictEqual([codex.requests_on_output, codex.board_tools?.["type"], codex.board_tools?.["name"]], [true, "namespace", "huntaway"])
      assert.deepStrictEqual(Object.keys(spec.mcpServers ?? {}).toSorted(), ["gh", "huntaway"])
      assert.isFalse(spec.mcpRun?.in_process)
    }),
  )

  it.effect("a session that started with them keeps them; one from before (or whose Codex wouldn't) has the board's server", () =>
    Effect.gen(function* () {
      const kept = yield* launch({ task: { id: TaskId.make("t1"), kind: "task", session_id: "s1" }, sessionBoardTools: true })
      assert.deepStrictEqual([kept.codex.thread_id, kept.codex.board_tools, kept.codex.requests_on_output, kept.boardTools], ["s1", null, true, false])
      assert.deepStrictEqual(Object.keys(kept.spec.mcpServers ?? {}), ["gh"])
      assert.isTrue(kept.spec.mcpRun?.in_process)

      // A session from before: its runs gave it none, so it has the board's server, which Codex's reviewer reviews in auto mode.
      const old = yield* launch({ task: { id: TaskId.make("t1"), kind: "task", session_id: "s0" }, sessionBoardTools: false, permissionMode: "auto" })
      assert.deepStrictEqual([old.codex.board_tools, old.codex.requests_on_output, old.codex.review_waits], [null, true, true])
      assert.isDefined(old.spec.mcpServers?.["huntaway"])
    }),
  )

  it.effect("in auto mode a dynamic wait is the board's to ask about", () =>
    Effect.gen(function* () {
      const { codex } = yield* launch({ permissionMode: "auto" })
      assert.deepStrictEqual([codex.approvals_reviewer, codex.review_waits], ["auto_review", false])
    }),
  )

  it.effect("a compaction takes no input and calls no tools", () =>
    Effect.gen(function* () {
      const { spec, codex, boardTools } = yield* launch({ kind: "compact", prompt: "" })
      assert.deepStrictEqual(
        [spec.input, spec.prompt, codex.compact, codex.requests_on_output, codex.board_tools, boardTools],
        [false, "", true, false, null, false],
      )
    }),
  )

  it.effect("a reviewer reads and reports: a read-only sandbox it can build in, and none of gh's tools that write", () =>
    Effect.gen(function* () {
      const fs = { "/w": "read", "/w/target": "write" } as const
      const { codex } = yield* launch({ task: { id: TaskId.make("t1"), kind: "review", session_id: null }, reviewFilesystem: fs })
      assert.deepStrictEqual([codex.approval_policy, codex.sandbox, codex.filesystem], ["never", "read-only", fs])
      assert.isTrue(codex.developer_instructions.endsWith(REVIEW_SANDBOX_NOTE))
      assert.include(codex.disabled_mcp_tools["gh"] ?? [], "pr_merge")
    }),
  )

  it.effect("the rules: an ask rule on its own tools asks about every command; a never rule there refuses the run", () =>
    Effect.gen(function* () {
      const asks = yield* launch({ permissionMode: "bypassPermissions", rules: { rules: [{ tool: "Bash", decision: "ask" }], expiry_minutes: 30 } })
      assert.deepStrictEqual([asks.codex.approval_policy, asks.codex.approvals_reviewer, asks.codex.sandbox], ["untrusted", "user", "workspace-write"])
      assert.deepStrictEqual(asks.codex.approval_rules?.rules, [{ tool: "Bash", decision: "ask" }])
      const refused = yield* launch({ rules: { rules: [{ tool: "Bash", decision: "never" }], expiry_minutes: 30 } }).pipe(Effect.flip)
      assert.include(refused.reason, "Codex can't be stopped from using")
      // No launcher, no adapter.
      assert.strictEqual((yield* launch({ exe: null }).pipe(Effect.flip))._tag, "LaunchRefused")
    }),
  )

  it.effect("a rewind reverts the thread to before its turn", () =>
    Effect.gen(function* () {
      const { codex } = yield* launch({ task: { id: TaskId.make("t1"), kind: "task", session_id: "s1" }, sessionBoardTools: true, revertBeforeTurn: "turn-3" })
      assert.strictEqual(codex.revert_before_turn, "turn-3")
    }),
  )
})
