import { assert, describe, it } from "@effect/vitest"
import { defaultSpec, isClaudeModel, policy, REVIEW_PROFILE, specFromJson, threadParams } from "./spec.ts"
import { mcpServerConfig } from "./servers.ts"

// The Codex spec, its permission modes and its servers (huntaway's agent/codex/tests.test.ts: maps_permission_modes,
// a_reviewer_writes_only_its_build_output_and_temp_directories, converts_mcp_servers, spots_claude_models).

const spec = (sandbox: string, fs: Record<string, string>) => defaultSpec({ sandbox, approval_policy: "never", writable_roots: ["/repo/.git"], filesystem: fs })
const config = (x: Record<string, unknown>): Record<string, unknown> => {
  const c = x["config"]
  return typeof c === "object" && c !== null ? { ...c } : {}
}

describe("Codex's spec", () => {
  it("maps permission modes", () => {
    assert.deepStrictEqual(policy("default", false), ["untrusted", "user", "workspace-write"])
    assert.deepStrictEqual(policy("bypassPermissions", true), ["never", "user", "danger-full-access"])
    assert.deepStrictEqual(policy("acceptEdits", true), ["never", "user", "read-only"])
    assert.strictEqual(policy("plan", false)[2], "read-only")
    assert.deepStrictEqual(policy("auto", false), ["on-request", "auto_review", "workspace-write"])
    assert.deepStrictEqual(policy("dontAsk", false), ["never", "user", "workspace-write"])
    assert.deepStrictEqual(policy("acceptEdits", false), ["on-request", "user", "workspace-write"])
  })

  it("a reviewer writes only its build output and temp directories", () => {
    let p = threadParams(spec("read-only", { "/w": "read", "/w/target": "write", "/home/me/.npm": "write" }), "/w", {})
    assert.strictEqual(p["sandbox"], undefined)
    assert.strictEqual(config(p)["sandbox_workspace_write"], undefined)
    assert.strictEqual(config(p)["default_permissions"], REVIEW_PROFILE)
    assert.deepStrictEqual(config(p)["permissions"], {
      [REVIEW_PROFILE]: {
        extends: ":read-only",
        filesystem: { ":tmpdir": "write", ":slash_tmp": "write", "/w": "read", "/w/target": "write", "/home/me/.npm": "write" },
        network: { enabled: true },
      },
    })
    // Without anything to write, or in another sandbox, it's the sandbox as given.
    p = threadParams(spec("read-only", {}), "/w", {})
    assert.deepStrictEqual([p["sandbox"], config(p)["permissions"]], ["read-only", undefined])
    p = threadParams(spec("workspace-write", { "/w/target": "write" }), "/w", {})
    assert.strictEqual(p["sandbox"], "workspace-write")
    assert.deepStrictEqual(config(p)["sandbox_workspace_write"], { network_access: true, writable_roots: ["/repo/.git"] })
    assert.strictEqual(config(p)["default_permissions"], undefined)
  })

  it("converts MCP servers", () => {
    const stdio = { type: "stdio", command: "x", args: ["mcp"], env: { A: "1" } }
    assert.deepStrictEqual(mcpServerConfig("s", stdio, false, [], false), { command: "x", args: ["mcp"], env: { A: "1" } })
    assert.strictEqual(mcpServerConfig("s", stdio, true, [], false)?.["default_tools_approval_mode"], "approve")
    const http = { type: "http", url: "https://h/mcp", headers: { Authorization: "Bearer t" } }
    assert.deepStrictEqual(mcpServerConfig("h", http, false, [], false), { url: "https://h/mcp", http_headers: { Authorization: "Bearer t" } })
    assert.strictEqual(mcpServerConfig("e", { type: "sse", url: "u" }, false, [], false), null)
    assert.strictEqual(mcpServerConfig("huntaway", { command: "ia" }, false, [], false)?.["tool_timeout_sec"], 3900)
    assert.deepStrictEqual(mcpServerConfig("s", stdio, false, ["w"], false)?.["disabled_tools"], ["w"])
    // In auto mode the board's tools stay approved but wait, which Codex's reviewer reviews.
    const board = mcpServerConfig("huntaway", { command: "ia" }, false, [], true)
    assert.deepStrictEqual([board?.["default_tools_approval_mode"], board?.["tools"]], ["approve", { wait: { approval_mode: "prompt" } }])
    assert.strictEqual(mcpServerConfig("huntaway", { command: "ia" }, false, [], false)?.["tools"], undefined)
    assert.strictEqual(mcpServerConfig("s", stdio, true, [], true)?.["tools"], undefined)
    // The desktop's read-only tools are approved and its actions ask (HA-273).
    const desktop = mcpServerConfig("desktop", http, false, ["act"], false)
    const tools = desktop?.["tools"]
    const tool = (name: string) => (typeof tools === "object" && tools !== null ? Reflect.get(tools, name) : undefined)
    assert.strictEqual(desktop?.["default_tools_approval_mode"], undefined)
    assert.deepStrictEqual([tool("read"), tool("act"), desktop?.["disabled_tools"]], [{ approval_mode: "approve" }, undefined, ["act"]])
  })

  it("spots Claude models", () => {
    assert.isTrue(isClaudeModel("opus"))
    assert.isTrue(isClaudeModel("claude-sonnet-5-5"))
    assert.isFalse(isClaudeModel("gpt-6.1-sol"))
  })

  it("reads codex.json back as serde did, and not one with rules it can't read", () => {
    const base = { cwd: "/w", approval_policy: "never", approvals_reviewer: "user", sandbox: "read-only" }
    assert.deepStrictEqual(specFromJson(base), defaultSpec(base))
    assert.isNull(specFromJson({ ...base, cwd: 1 }))
    assert.isNull(specFromJson([]))
    const read = specFromJson({
      ...base,
      plan: true,
      writable_roots: ["/a", 2],
      board_tools: { type: "namespace", name: "huntaway", tools: [] },
      revert_before_turn: "t1",
      config_overrides: ["a=b"],
      approval_rules: { rules: [{ tool: "Bash", decision: "ask" }] },
    })
    assert.isTrue(read?.plan)
    assert.deepStrictEqual(read?.writable_roots, [])
    assert.deepStrictEqual(read?.board_tools, { type: "namespace", name: "huntaway", tools: [] })
    assert.strictEqual(read?.revert_before_turn, "t1")
    assert.deepStrictEqual(read?.config_overrides, ["a=b"])
    assert.deepStrictEqual(read?.approval_rules, { rules: [{ tool: "Bash", decision: "ask" }], expiry_minutes: 30 })
    // Not a namespace: none.
    assert.isNull(specFromJson({ ...base, board_tools: { type: "function" } })?.board_tools)
    // Rules it can't read: no spec, so the run doesn't start rather than without them.
    assert.isNull(specFromJson({ ...base, approval_rules: { rules: [{ tool: "Bash", decision: "maybe" }] } }))
  })
})
