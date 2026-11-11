import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Ref, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { RunId } from "@huntaway/contracts"
import { fakeAgent, TestBoard, TestMcp, TestMcpOver, TestTools } from "@huntaway/testing"
import type { FakeAgent } from "@huntaway/testing"
import { toJson } from "../../platform/columns.ts"
import { McpControl } from "../../runs/McpControl.ts"
import { RunDir } from "../../runs/RunDir.ts"
import { McpHooks } from "../McpHooks.ts"
import { controlCallId, ToolCalls } from "../ToolCalls.ts"
import { BOARD_TIMEOUT_MS, MANIFEST_PROTOCOL } from "./control.ts"

// The board's server in process for Claude runs (docs/plan/inventory/03-mcp.md 2.1): the old
// agent/runner/requests.test.ts's MCP cases, on the fake agent's files: the handshake answered on the input, a board
// call knowing its task from its run, answered once however often it is read, taken up again after a restart, and not
// answered once Claude Code gives up on it; and the `initialize` line.

const mcpMessage = (requestId: string, message: unknown, serverName: unknown = "huntaway") => ({ request_id: requestId, server_name: serverName, message })

const toolCall = (requestId: string, rpcId: number, name: string, args: unknown) =>
  mcpMessage(requestId, {
    jsonrpc: "2.0",
    id: rpcId,
    method: "tools/call",
    params: { name, arguments: args, _meta: { "claudecode/toolUseId": `toolu_${requestId}`, progressToken: rpcId } },
  })

/** Claude Code gives up on the board call it sent with JSON-RPC id `rpcId`, as it does: a notification to the server. */
const cancelled = (requestId: string, rpcId: number | string) =>
  mcpMessage(requestId, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: rpcId, reason: "AbortError: remote-cancel" } })

const McpResponse = Schema.Struct({
  jsonrpc: Schema.String,
  id: Schema.Union([Schema.String, Schema.Finite]),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ code: Schema.Finite, message: Schema.String })),
})

const ControlResponse = Schema.Struct({
  type: Schema.Literal("control_response"),
  response: Schema.Struct({
    subtype: Schema.String,
    request_id: Schema.String,
    response: Schema.Struct({ mcp_response: McpResponse }),
  }),
})
type ControlResponse = typeof ControlResponse.Type

const CallResult = Schema.Struct({
  content: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.String })),
  isError: Schema.optional(Schema.Boolean),
})

const ToolList = Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) })

/** The control responses the agent has been sent, by request id, in order. */
const responses = (agent: FakeAgent) =>
  Effect.flatMap(agent.input, (lines) => Effect.forEach(lines, (line) => Schema.decodeUnknownEffect(ControlResponse)(line), { concurrency: 1 })).pipe(
    Effect.orDie,
    Effect.map((all) => all.map((r) => r.response)),
  )

const byId = (all: ReadonlyArray<ControlResponse["response"]>) => new Map(all.map((r) => [r.request_id, r.response.mcp_response]))

/** What a board call's answer says, and whether it is an error. */
const said = (response: typeof McpResponse.Type | undefined): readonly [string, boolean] => {
  const result = response?.result
  if (!Schema.is(CallResult)(result)) return assert.fail("not a tool's result")
  return [result.content[0]?.text ?? "", result.isError === true]
}

const names = (result: unknown) => (Schema.is(ToolList)(result) ? result.tools.map((t) => t.name) : assert.fail("not a tool list"))

const touched = Effect.flatMap(TestTools, (tools) => tools.touched)

const callStatus = (run: RunId, request: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ readonly status: string }>`SELECT status FROM mcp_calls WHERE id = ${controlCallId(run, request)}`).pipe(
    Effect.orDie,
    Effect.map((rows) => rows[0]?.status),
  )

/**
 * Waits until the board call of control request `request` is done here, as a second delivery does: its answer, if it
 * has one, is on the input by then.
 */
const settled = (agent: FakeAgent, request: string, rpcId: number, tool: string, args: unknown) =>
  Effect.flatMap(ToolCalls, (calls) =>
    calls.call({
      call_id: controlCallId(agent.run.id, request),
      run: agent.run.id,
      server: "huntaway",
      tool,
      args,
      answer: { request_id: request, rpc_id: rpcId },
    }),
  )

/** What a server that stopped mid-call left: a board call on the run's output recorded executing. */
const left = (agent: FakeAgent, request: string, rpcId: number, tool: string, args: unknown) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const saved = yield* toJson({ request_id: request, rpc_id: rpcId, arguments: args })
    yield* sql`INSERT INTO mcp_calls (id, run_id, task_id, tool, args, status, created_at) VALUES (${controlCallId(agent.run.id, request)},
      ${agent.run.id}, ${agent.run.task_id}, ${tool}, ${saved}, 'executing', '2026-11-06T00:00:00Z')`
  }).pipe(Effect.orDie)

/** Hooks that record the calls the agent gave up on. */
const recording = (seen: Ref.Ref<ReadonlyArray<string>>) =>
  Layer.succeed(
    McpHooks,
    McpHooks.of({ callMade: () => Effect.void, askRule: () => Effect.void, cancelled: (_run, id) => Ref.update(seen, (all) => [...all, id]) }),
  )

describe("McpControl", () => {
  it.effect("the board server's handshake is answered on the input", () =>
    Effect.gen(function* () {
      const control = yield* McpControl
      const agent = yield* fakeAgent()
      for (const request of [
        mcpMessage("i1", { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {} } }),
        mcpMessage("i2", { jsonrpc: "2.0", method: "notifications/initialized" }),
        mcpMessage("i3", { jsonrpc: "2.0", id: 1, method: "tools/list" }),
        mcpMessage("i4", { jsonrpc: "2.0", id: 2, method: "ping" }),
        mcpMessage("i5", { jsonrpc: "2.0", id: 3, method: "tools/list" }, "other"),
      ])
        yield* control.handle(agent.run, request)
      const all = yield* responses(agent)
      assert.deepStrictEqual(
        all.map((r) => [r.request_id, r.subtype]),
        [
          ["i1", "success"],
          ["i2", "success"],
          ["i3", "success"],
          ["i4", "success"],
          ["i5", "success"],
        ],
      )
      const answers = byId(all)
      const InitializeResult = Schema.Struct({
        protocolVersion: Schema.String,
        serverInfo: Schema.Struct({ name: Schema.String }),
        instructions: Schema.String,
      })
      const init = yield* Schema.decodeUnknownEffect(InitializeResult)(answers.get("i1")?.result).pipe(Effect.orDie)
      assert.deepStrictEqual([answers.get("i1")?.id, init.serverInfo.name, init.protocolVersion], [0, "huntaway", "2025-11-25"])
      assert.match(init.instructions, /Huntaway board/)
      // A notification still gets its control response, which Claude Code waits for.
      assert.deepStrictEqual(answers.get("i2"), { jsonrpc: "2.0", id: 0, result: {} })
      const listed = names(answers.get("i3")?.result)
      assert.isTrue(listed.includes("test_echo") && listed.includes("wait") && !listed.includes("submit_test_review"), listed.join())
      assert.deepStrictEqual(answers.get("i4"), { jsonrpc: "2.0", id: 2, result: {} })
      // Only the board's server is in process.
      assert.deepStrictEqual(answers.get("i5")?.error, { code: -32601, message: `there's no MCP server "other" in process` })
      const calls = yield* Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM mcp_calls`).pipe(Effect.orDie)
      assert.strictEqual(calls[0]?.n, 0)
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("a board call on the output knows its task from its run, and is recorded with what answering it again takes", () =>
    Effect.gen(function* () {
      const control = yield* McpControl
      const agent = yield* fakeAgent()
      yield* control.handle(agent.run, toolCall("c1", 4, "test_echo", { text: "hi" }))
      yield* settled(agent, "c1", 4, "test_echo", { text: "hi" })
      const [r] = yield* responses(agent)
      assert.deepStrictEqual([r?.subtype, r?.request_id, r?.response.mcp_response.jsonrpc, r?.response.mcp_response.id], ["success", "c1", "2.0", 4])
      const [text, error] = said(r?.response.mcp_response)
      assert.isFalse(error, text)
      assert.include(text, agent.run.task_id)
      assert.strictEqual(yield* callStatus(agent.run.id, "c1"), "done")
      const row = yield* Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql<{ readonly args: string; readonly task_id: string }>`SELECT args, task_id FROM mcp_calls WHERE id = ${controlCallId(agent.run.id, "c1")}`,
      ).pipe(Effect.orDie)
      assert.deepStrictEqual(yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(row[0]?.args).pipe(Effect.orDie), {
        request_id: "c1",
        rpc_id: 4,
        arguments: { text: "hi" },
      })
      assert.strictEqual(row[0]?.task_id, agent.run.task_id)

      // An error is the tool's result, as the HTTP server has it.
      yield* control.handle(agent.run, toolCall("c2", 5, "test_echo", { task: "x" }))
      yield* settled(agent, "c2", 5, "test_echo", { task: "x" })
      const [text2, error2] = said((yield* responses(agent))[1]?.response.mcp_response)
      assert.isTrue(error2 && text2.startsWith('Error: test_echo has no argument "task"'), text2)
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("a reviewer's board server has the reviewers' tools only, whatever it calls", () =>
    Effect.gen(function* () {
      const control = yield* McpControl
      const agent = yield* fakeAgent()
      yield* Effect.flatMap(SqlClient.SqlClient, (sql) => sql`UPDATE tasks SET kind = 'review' WHERE id = ${agent.run.task_id}`).pipe(Effect.orDie)
      yield* control.handle(agent.run, mcpMessage("l1", { jsonrpc: "2.0", id: 1, method: "tools/list" }))
      const listed = names((yield* responses(agent))[0]?.response.mcp_response.result)
      assert.isTrue(listed.includes("submit_test_review") && listed.includes("test_echo") && !listed.includes("test_touch"), listed.join())
      yield* control.handle(agent.run, toolCall("c1", 2, "test_touch", { label: "x" }))
      yield* settled(agent, "c1", 2, "test_touch", { label: "x" })
      const [text, error] = said((yield* responses(agent))[1]?.response.mcp_response)
      assert.isTrue(error && /isn't available to reviewers/.test(text), text)
      assert.deepStrictEqual(yield* touched, [])
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("a board call read again runs and is answered once", () =>
    Effect.gen(function* () {
      const control = yield* McpControl
      const tools = yield* TestTools
      const agent = yield* fakeAgent()
      // Read again while it runs, and again after it is done (the server stopped before it saved how far it read).
      yield* control.handle(agent.run, toolCall("c1", 7, "test_block", { key: "k" }))
      yield* tools.blocked("k")
      yield* control.handle(agent.run, toolCall("c1", 7, "test_block", { key: "k" }))
      yield* tools.release("k")
      yield* settled(agent, "c1", 7, "test_block", { key: "k" })
      yield* control.handle(agent.run, toolCall("c1", 7, "test_block", { key: "k" }))
      yield* settled(agent, "c1", 7, "test_block", { key: "k" })
      assert.deepStrictEqual(
        (yield* responses(agent)).map((r) => r.request_id),
        ["c1"],
      )
      assert.deepStrictEqual(yield* touched, ["block:k"])
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("after a restart a board call cut short is answered, once", () =>
    Effect.gen(function* () {
      const agent = yield* fakeAgent()
      yield* left(agent, "c1", 11, "test_echo", { text: "again" })
      yield* left(agent, "c2", 12, "test_touch", { label: "twice?" })
      const resumed = Effect.gen(function* () {
        yield* (yield* ToolCalls).resume
        yield* settled(agent, "c1", 11, "test_echo", { text: "again" })
        yield* settled(agent, "c2", 12, "test_touch", { label: "twice?" })
      })
      yield* resumed
      const answers = byId(yield* responses(agent))
      // One that only reads runs again; one that may have taken effect says so, rather than run again or not answer.
      assert.strictEqual(answers.get("c1")?.id, 11)
      assert.include(said(answers.get("c1"))[0], agent.run.task_id)
      assert.strictEqual(answers.get("c2")?.id, 12)
      const [text, error] = said(answers.get("c2"))
      assert.isTrue(error && /was interrupted/.test(text), text)
      assert.deepStrictEqual(yield* touched, [])
      assert.deepStrictEqual([yield* callStatus(agent.run.id, "c1"), yield* callStatus(agent.run.id, "c2")], ["done", "done"])
      // Another restart answers neither again.
      yield* resumed.pipe(Effect.provide(TestMcpOver()))
      assert.strictEqual((yield* responses(agent)).length, 2)
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("a wait carries on over a restart", () =>
    Effect.gen(function* () {
      const tools = yield* TestTools
      const agent = yield* fakeAgent()
      yield* left(agent, "w1", 21, "wait", { key: "w" })
      yield* (yield* ToolCalls).resume
      yield* tools.blocked("w")
      assert.deepStrictEqual(yield* responses(agent), [])
      yield* tools.release("w")
      yield* settled(agent, "w1", 21, "wait", { key: "w" })
      const [r] = yield* responses(agent)
      assert.strictEqual(r?.response.mcp_response.id, 21)
      assert.isFalse(said(r?.response.mcp_response)[1])
      yield* (yield* ToolCalls).resume
      assert.strictEqual((yield* responses(agent)).length, 1)
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("a board call Claude Code cancels ends unanswered", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<ReadonlyArray<string>>([])
      yield* Effect.gen(function* () {
        const control = yield* McpControl
        const tools = yield* TestTools
        const agent = yield* fakeAgent()
        yield* control.handle(agent.run, toolCall("w1", 3, "wait", { key: "w" }))
        yield* tools.blocked("w")
        // A cancel of another id (or of the same id as a string) leaves it; the notifications themselves are answered.
        yield* control.handle(agent.run, cancelled("n1", 4))
        yield* control.handle(agent.run, cancelled("n2", "3"))
        assert.deepStrictEqual(yield* Ref.get(seen), [])
        assert.deepStrictEqual(
          (yield* responses(agent)).map((r) => [r.request_id, r.response.mcp_response.result]),
          [
            ["n1", {}],
            ["n2", {}],
          ],
        )
        yield* control.handle(agent.run, cancelled("n3", 3))
        assert.deepStrictEqual(yield* Ref.get(seen), [controlCallId(agent.run.id, "w1")])
        // The call itself isn't answered when it ends.
        yield* tools.release("w")
        yield* settled(agent, "w1", 3, "wait", { key: "w" })
        assert.deepStrictEqual(
          (yield* responses(agent)).map((r) => r.request_id),
          ["n1", "n2", "n3"],
        )
        assert.strictEqual(yield* callStatus(agent.run.id, "w1"), "done")

        // Nor is one whose control request Claude Code cancels.
        yield* control.handle(agent.run, toolCall("w2", 5, "wait", { key: "w2" }))
        yield* tools.blocked("w2")
        yield* control.cancel(agent.run, "w2")
        assert.include(yield* Ref.get(seen), controlCallId(agent.run.id, "w2"))
        yield* tools.release("w2")
        yield* settled(agent, "w2", 5, "wait", { key: "w2" })
        assert.strictEqual((yield* responses(agent)).length, 3)
      }).pipe(Effect.provide(TestMcp(recording(seen))))
    }),
  )

  it.effect("a call's answer is on the run's input before the call is recorded done", () =>
    Effect.gen(function* () {
      const statuses = yield* Ref.make<ReadonlyArray<string | undefined>>([])
      // The run's folder as the board writes it, noting the call's status as each answer is written.
      const watched = Layer.effect(
        RunDir,
        Effect.gen(function* () {
          const dirs = yield* RunDir
          const sql = yield* SqlClient.SqlClient
          return RunDir.of({
            ...dirs,
            appendInput: (run, line) =>
              sql<{ readonly status: string }>`SELECT status FROM mcp_calls WHERE run_id = ${run}`.pipe(
                Effect.orDie,
                Effect.flatMap((rows) => Ref.update(statuses, (all) => [...all, rows[0]?.status])),
                Effect.andThen(dirs.appendInput(run, line)),
              ),
          })
        }),
      )
      yield* Effect.gen(function* () {
        const control = yield* McpControl
        const agent = yield* fakeAgent()
        yield* control.handle(agent.run, toolCall("c1", 1, "test_touch", { label: "x" }))
        yield* settled(agent, "c1", 1, "test_touch", { label: "x" })
        assert.strictEqual(yield* callStatus(agent.run.id, "c1"), "done")
        assert.deepStrictEqual(yield* Ref.get(statuses), ["executing"])
      }).pipe(Effect.provide(TestMcpOver().pipe(Layer.provideMerge(watched), Layer.provideMerge(TestTools.layer), Layer.provideMerge(TestBoard()))))
    }),
  )

  it.effect("the initialize registers the board server with its handshake", () =>
    Effect.gen(function* () {
      const control = yield* McpControl
      const agent = yield* fakeAgent()
      const Line = Schema.fromJsonString(
        Schema.Struct({
          type: Schema.String,
          request_id: Schema.String,
          request: Schema.Struct({
            subtype: Schema.String,
            sdkMcpServers: Schema.Array(Schema.String),
            sdkMcpServerConfigs: Schema.Struct({ huntaway: Schema.Struct({ timeout: Schema.Finite, disableAutoBackground: Schema.Boolean }) }),
            sdkMcpServerManifests: Schema.Struct({
              huntaway: Schema.Struct({ initializeResult: Schema.Struct({ protocolVersion: Schema.String }), toolsListResult: ToolList }),
            }),
          }),
        }),
      )
      const line = yield* Schema.decodeEffect(Line)(yield* control.initializeLine(agent.run.id, false)).pipe(Effect.orDie)
      assert.deepStrictEqual(
        [line.type, line.request_id, line.request.subtype, line.request.sdkMcpServers],
        ["control_request", `huntaway-init-${agent.run.id}`, "initialize", ["huntaway"]],
      )
      assert.deepStrictEqual(line.request.sdkMcpServerConfigs.huntaway, { timeout: BOARD_TIMEOUT_MS, disableAutoBackground: true })
      assert.strictEqual(line.request.sdkMcpServerManifests.huntaway.initializeResult.protocolVersion, MANIFEST_PROTOCOL)
      const tools = (review: boolean) =>
        Effect.flatMap(control.initializeLine(agent.run.id, review), (text) =>
          Schema.decodeEffect(Line)(text).pipe(
            Effect.orDie,
            Effect.map((decoded) => decoded.request.sdkMcpServerManifests.huntaway.toolsListResult.tools.map((t) => t.name)),
          ),
        )
      const own = yield* tools(false)
      const reviewer = yield* tools(true)
      assert.isTrue(own.includes("test_touch") && !own.includes("submit_test_review"), own.join())
      assert.isTrue(reviewer.includes("submit_test_review") && !reviewer.includes("test_touch"), reviewer.join())
      // Claude Code's answer to it is told apart from the others.
      assert.isTrue(control.isInitializeResponse(`huntaway-init-${agent.run.id}`))
      assert.isFalse(control.isInitializeResponse("stop-1"))
    }).pipe(Effect.provide(TestMcp())),
  )
})
