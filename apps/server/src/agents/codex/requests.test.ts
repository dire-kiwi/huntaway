import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { boardTools, classify, codexResponse, promptAnswer, requestId, toolAnswer } from "./requests.ts"

// What Codex's requests are to the board, and how they're answered (the old agent/codex/requests.test.ts's plain cases;
// the ones that go through the prompts and the run's input are runs/codex/output.test.ts's).

const elicit = (tool: string, params: unknown) => ({
  id: 1,
  method: "mcpServer/elicitation/request",
  params: {
    threadId: "main",
    serverName: "huntaway",
    mode: "form",
    message: `Allow the huntaway MCP server to run tool "${tool}"?`,
    requestedSchema: { type: "object", properties: {} },
    _meta: { tool_params: params },
  },
})

describe("Codex's requests", () => {
  it("an approval is a prompt of the tool it is for, with the command as the agent wrote it", () => {
    const c = classify({
      id: 0,
      method: "item/commandExecution/requestApproval",
      params: { itemId: "c1", command: "/usr/bin/bash -lc 'make'", cwd: "/w", reason: "Build" },
    })
    assert.deepStrictEqual(c, {
      _tag: "Prompt",
      tool_name: "Bash",
      input: { command: "make", cwd: "/w", description: "Build" },
      tool_use_id: "c1",
      ask: { id: 0, method: "item/commandExecution/requestApproval" },
    })
    const change = classify({
      id: 1,
      method: "item/fileChange/requestApproval",
      params: { itemId: "f1" },
      item: { type: "fileChange", id: "f1", changes: [{ path: "/w/a", kind: { type: "add" }, diff: "x" }] },
    })
    assert.deepStrictEqual(change._tag === "Prompt" ? [change.tool_name, change.input] : null, [
      "ApplyPatch",
      { changes: [{ path: "/w/a", kind: "add", move_path: null, diff: "x" }] },
    ])
  })

  it("a wait Codex leaves to the user is asked about as its command; the board's other tools need no approval", () => {
    const wait = classify(elicit("wait", { reason: "waiting for CI", command: " gh pr checks 1 " }))
    assert.deepStrictEqual(wait._tag === "Prompt" ? [wait.tool_name, wait.input] : null, [
      "Bash",
      { command: "gh pr checks 1", description: "Run while waiting: waiting for CI" },
    ])
    assert.deepStrictEqual(classify(elicit("wait", { seconds: 60, command: "" })), { _tag: "Answer", answer: { result: { action: "accept", content: {} } } })
    assert.deepStrictEqual(classify(elicit("get_task", { task: "IA-1" })), { _tag: "Answer", answer: { result: { action: "accept", content: {} } } })
    // Without its arguments, a wait is asked about as itself.
    const bare = classify(elicit("wait", null))
    assert.strictEqual(bare._tag === "Prompt" ? bare.tool_name : null, "mcp__huntaway__wait")
  })

  it("the board's tools are its calls; a method it doesn't handle is refused", () => {
    assert.deepStrictEqual(classify({ id: 2, method: "item/tool/call", params: { namespace: "huntaway", tool: "get_task", arguments: { task: "A-1" } } }), {
      _tag: "Tool",
      tool: "get_task",
      args: { task: "A-1" },
    })
    // Older sessions' namespaces name the board by its old name.
    assert.strictEqual(classify({ id: 2, method: "item/tool/call", params: { namespace: "issue_agent", tool: "get_task" } })._tag, "Tool")
    assert.deepStrictEqual(classify({ id: 3, method: "account/chatgptAuthTokens/refresh", params: {} }), {
      _tag: "Answer",
      answer: { error: { code: -32601, message: "Method not supported by Huntaway: account/chatgptAuthTokens/refresh" } },
    })
  })

  it("answers as Codex takes them", () => {
    const allow = { behavior: "allow", updatedInput: { answers: { q: { answers: ["a"] } } } } as const
    const deny = { behavior: "deny" } as const
    assert.deepStrictEqual(promptAnswer({ id: 1, method: "item/commandExecution/requestApproval" }, allow), { decision: "accept" })
    assert.deepStrictEqual(promptAnswer({ id: 1, method: "item/fileChange/requestApproval" }, deny), { decision: "decline" })
    assert.deepStrictEqual(promptAnswer({ id: 1, method: "item/permissions/requestApproval", permissions: { x: 1 } }, deny), { permissions: {}, scope: "turn" })
    assert.deepStrictEqual(promptAnswer({ id: 1, method: "item/permissions/requestApproval", permissions: { x: 1 } }, allow), {
      permissions: { x: 1 },
      scope: "turn",
    })
    assert.deepStrictEqual(promptAnswer({ id: 1, method: "mcpServer/elicitation/request" }, allow), { action: "accept", content: {} })
    assert.deepStrictEqual(promptAnswer({ id: 1, method: "item/tool/requestUserInput" }, allow), { answers: { q: { answers: ["a"] } } })
    assert.deepStrictEqual(promptAnswer({ id: 1, method: "item/tool/requestUserInput" }, deny), { answers: {} })
    assert.deepStrictEqual(toolAnswer({ content: [{ type: "text", text: '{\n  "a": 1\n}' }] }), {
      contentItems: [{ type: "inputText", text: '{\n  "a": 1\n}' }],
      success: true,
    })
    assert.deepStrictEqual(toolAnswer({ content: [{ type: "text", text: "Error: boom" }], isError: true }), {
      contentItems: [{ type: "inputText", text: "Error: boom" }],
      success: false,
    })
  })

  it.effect("its lines and ids", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* codexResponse(7, { result: { decision: "accept" } }), '{"type":"codex_response","id":7,"result":{"decision":"accept"}}')
      assert.deepStrictEqual([yield* requestId(7), yield* requestId("a")], ["codex:7", 'codex:"a"'])
    }),
  )

  it("the board's tools as one namespace, without the helper's permission_prompt", () => {
    const ns = boardTools({
      initializeResult: { instructions: "The board." },
      toolsListResult: {
        tools: [{ name: "get_task", description: "Get it.", inputSchema: { type: "object", properties: {} } }, { name: "permission_prompt" }, { name: "wait" }],
      },
    })
    assert.deepStrictEqual(ns, {
      type: "namespace",
      name: "huntaway",
      description: "The board.",
      tools: [
        { type: "function", name: "get_task", description: "Get it.", inputSchema: { type: "object", properties: {} } },
        { type: "function", name: "wait", description: "", inputSchema: { type: "object" } },
      ],
    })
  })
})
