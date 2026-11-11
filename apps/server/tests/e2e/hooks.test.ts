import { assert, describe, it } from "vite-plus/test"
import { spawnSync } from "node:child_process"
import { performance } from "node:perf_hooks"
import { fileURLToPath } from "node:url"

// A hook's start (docs/plan/10-testing.md, Measurements): Claude Code runs `huntaway approval-hook` before every tool
// call a rule may match, so its wall time through the launcher, from start to exit, stays under 60 ms. The first run
// fills Node's compile cache (bin/huntaway); the limit holds for the median of the runs after it, as an agent's calls
// find the cache filled. A wall-clock limit is what this measures, so it is here and not in `pnpm test`, whose files
// run side by side.

const BIN = fileURLToPath(new URL("../../bin/huntaway", import.meta.url))
const RULES = '[{"tool": "mcp__google__*send*", "decision": "ask"}, {"tool": "mcp__google__*delete*", "decision": "never"}]'
const CALL = '{"hook_event_name": "PreToolUse", "tool_name": "mcp__google__delete_mail", "tool_input": {}}'

const timed = (): number => {
  const start = performance.now()
  const out = spawnSync(BIN, ["approval-hook", RULES], { input: CALL, encoding: "utf8" })
  const took = performance.now() - start
  assert.strictEqual(out.status, 0, out.stderr)
  assert.include(out.stdout, '"permissionDecision":"deny"')
  return took
}

describe("hook commands", () => {
  it("approval-hook answers in under 60 ms", () => {
    const first = timed()
    const runs = Array.from({ length: 7 }, timed).toSorted((a, b) => a - b)
    const median = runs[3] ?? Infinity
    assert.isBelow(median, 60, `first ${first.toFixed(0)} ms, then ${runs.map((t) => t.toFixed(0)).join(", ")} ms`)
  })
})
