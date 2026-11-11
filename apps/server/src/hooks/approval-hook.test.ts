import { afterAll, assert, describe, it } from "vite-plus/test"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { HOOK_FAILED } from "@huntaway/shared"

// `huntaway approval-hook`, as Claude Code runs it: through bin/huntaway, with the call on stdin (huntaway's
// agent/approval_rules/tests.test.ts, from the Rust server's tests/approval_hook.rs). Its two cases through main.ts are
// gone with main.ts's hook command: bin.ts loads effect and has none, so the launcher is the one way in.

const BIN = fileURLToPath(new URL("../../bin/huntaway", import.meta.url))
const ENTRY = fileURLToPath(new URL("approval-hook.ts", import.meta.url))

const dirs: Array<string> = []
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "huntaway-hook-test-"))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const hook = (rules: string, input: string, env: NodeJS.ProcessEnv = process.env) => spawnSync(BIN, ["approval-hook", rules], { input, encoding: "utf8", env })

const decision = (out: { readonly stdout: string }): string | null => {
  try {
    return JSON.parse(out.stdout).hookSpecificOutput.permissionDecision ?? null
  } catch {
    return null
  }
}

const STRICT = '[{"tool": "mcp__google__*send*", "decision": "ask"}, {"tool": "mcp__google__*delete*", "decision": "never"}]'

const call = (tool: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: {} })

/**
 * bin/huntaway's node made one whose modules see `import.meta.main` as undefined, as Node before 24.2 does: there, a
 * hook that ran only `if (import.meta.main)` exited 0 with no output, which Claude Code takes as no decision, so ask
 * and never rules didn't hold (HA-245).
 */
const oldNode = (): NodeJS.ProcessEnv => {
  const dir = tempDir()
  const preload = join(dir, "no_main.mjs")
  writeFileSync(
    preload,
    `import { registerHooks } from "node:module";
registerHooks({
  load(url, context, next) {
    const r = next(url, context);
    if (url.startsWith("file:") && r.source != null) r.source = String(r.source).replaceAll("import.meta.main", "undefined");
    return r;
  },
});
`,
  )
  const node = join(dir, "node")
  writeFileSync(node, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --import ${JSON.stringify(pathToFileURL(preload).href)} "$@"\n`)
  chmodSync(node, 0o755)
  // It does take import.meta.main away.
  const probe = join(dir, "probe.mjs")
  writeFileSync(probe, "if (import.meta.main) process.exit(3);\n")
  assert.strictEqual(spawnSync(node, [probe]).status, 0)
  assert.strictEqual(spawnSync(process.execPath, [probe]).status, 3)
  return { ...process.env, HUNTAWAY_NODE: node }
}

/** node's arguments for a preload that makes approval.ts fail to load, as a broken install would. */
const brokenHook = (): ReadonlyArray<string> => {
  const preload = join(tempDir(), "broken_hook.mjs")
  writeFileSync(
    preload,
    `import { registerHooks } from "node:module";
registerHooks({
  load(url, context, next) {
    const r = next(url, context);
    if (url.endsWith("/hooks/approval.ts")) r.source = 'throw new Error("approval.ts is broken");';
    return r;
  },
});
`,
  )
  return ["--import", pathToFileURL(preload).href]
}

describe("approval-hook", () => {
  it("decides by the rules", () => {
    for (const [tool, want] of [
      ["mcp__google__send_mail", "ask"],
      ["mcp__google__delete_mail", "deny"],
      ["mcp__google__get_mail", null],
    ] as const) {
      const out = hook(STRICT, call(tool))
      assert.strictEqual(out.status, 0, `${tool}: ${out.stderr}`)
      assert.strictEqual(decision(out), want, tool)
    }
  })

  it("refuses what it can't check while rules ask or refuse", () => {
    // Input it can't read, rules it can't read: refused, which exit code 2 is for a PreToolUse hook.
    for (const [rules, input] of [
      [STRICT, "not json"],
      [STRICT, "{}"],
      ["not rules", call("mcp__google__get_mail")],
      [STRICT, ""],
    ] as const) {
      const out = hook(rules, input)
      assert.strictEqual(out.status, 2, `${rules} ${input}`)
      assert.strictEqual(out.stderr.trim(), HOOK_FAILED)
    }
    // No rules argument at all, or rules of the wrong shape: refused too.
    for (const args of [["approval-hook"], ["approval-hook", '[{"tool": "x"}]'], ["approval-hook", '{"rules": []}']]) {
      const out = spawnSync(BIN, args, { input: call("mcp__google__get_mail"), encoding: "utf8" })
      assert.strictEqual(out.status, 2, args.join(" "))
    }
    // With only allow rules, the call is left to the run's own permissions.
    const out = hook('[{"tool": "mcp__google__get*", "decision": "allow"}]', "not json")
    assert.deepStrictEqual([out.status, decision(out)], [0, null])
  })

  it("runs without import.meta.main", () => {
    const env = oldNode()
    for (const [rules, input] of [
      [STRICT, "not json"],
      [STRICT, "{}"],
      ["not rules", call("mcp__google__get_mail")],
    ] as const) {
      const out = hook(rules, input, env)
      assert.strictEqual(out.status, 2, `${rules} ${input}: ${out.stderr}`)
      assert.include(out.stderr, "couldn't be checked")
    }
    const out = hook(STRICT, call("mcp__google__delete_mail"), env)
    assert.deepStrictEqual([out.status, decision(out)], [0, "deny"], out.stderr)
  })

  it("refuses calls with HOOK_FAILED's message when approval.ts can't be loaded", () => {
    const out = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", ...brokenHook(), ENTRY, STRICT], {
      input: call("mcp__google__get_mail"),
      encoding: "utf8",
    })
    assert.strictEqual(out.status, 2, out.stderr)
    // The entry's FALLBACK, a hand-kept copy of HOOK_FAILED (nothing is loaded before its handlers are on): the same
    // but for saying the hook failed to start.
    assert.strictEqual(out.stderr.trim().replace("(their hook failed to start)", "(their hook failed)"), HOOK_FAILED)
  })

  it("the entry loads nothing but its hook before its handlers are on", () => {
    // What it imports statically runs before the handlers, where a failure would exit 1 and let the call through.
    assert.notMatch(readFileSync(ENTRY, "utf8"), /^import /m)
  })
})
