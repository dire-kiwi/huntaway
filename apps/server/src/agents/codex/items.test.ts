import { assert, describe, it } from "@effect/vitest"
import { displayCommand, toolOutput, toolUse } from "./items.ts"

// What a Codex item shows as (huntaway's agent/codex/tests.test.ts: unwraps_shell_commands, shows_items_as_tools).

describe("Codex items", () => {
  it("unwraps shell commands", () => {
    assert.strictEqual(displayCommand("/usr/bin/bash -lc 'ls -la && printf hi > hello.txt'"), "ls -la && printf hi > hello.txt")
    assert.strictEqual(displayCommand("/bin/zsh -lc 'echo '\\''hi'\\'''"), "echo 'hi'")
    assert.strictEqual(displayCommand('bash -c "make"'), "make")
    assert.strictEqual(
      displayCommand(String.raw`/usr/bin/bash -lc "printf 'hi\\n' && git commit -m \"Add it\""`),
      String.raw`printf 'hi\n' && git commit -m "Add it"`,
    )
    assert.strictEqual(displayCommand("git status"), "git status")
    assert.strictEqual(displayCommand("python -c 'print(1)'"), "python -c 'print(1)'")
    assert.strictEqual(displayCommand(`/usr/bin/bash -lc "cat <<'EOF'\n#"'!/bin/sh'"\nEOF"`), "cat <<'EOF'\n#!/bin/sh\nEOF")
    assert.strictEqual(displayCommand("bash -lc 'a' 'b'"), "bash -lc 'a' 'b'")
  })

  it("shows items as tools", () => {
    const cmd = { type: "commandExecution", id: "e1", command: "/usr/bin/bash -lc 'false'", status: "completed", exitCode: 1, aggregatedOutput: "nope\n" }
    assert.strictEqual(toolUse(cmd)?.[0], "Bash")
    assert.deepStrictEqual(toolOutput(cmd), ["nope\n(exit code 1)", true])
    const mcp = {
      type: "mcpToolCall",
      server: "huntaway",
      tool: "get_task",
      arguments: { task_id: "IA-1" },
      status: "completed",
      result: { content: [{ type: "text", text: "ok" }] },
    }
    assert.strictEqual(toolUse(mcp)?.[0], "mcp__huntaway__get_task")
    assert.deepStrictEqual(toolOutput(mcp), ["ok", false])
    assert.strictEqual(toolUse({ type: "userMessage" }), null)
    // A server's name with characters a tool name can't have.
    assert.strictEqual(toolUse({ type: "mcpToolCall", server: "claude.ai Drive", tool: "find" })?.[0], "mcp__claude_ai_Drive__find")
    // Collab states, as JSON with two spaces.
    assert.deepStrictEqual(toolOutput({ type: "collabAgentToolCall", status: "completed", agentsStates: { a: { status: "running" } } }), [
      '{\n  "a": {\n    "status": "running"\n  }\n}',
      false,
    ])
  })
})
