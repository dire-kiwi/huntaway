import { afterAll, assert, describe, it } from "vite-plus/test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { hookDenial } from "./gh.ts"

// `huntaway gh-hook` (huntaway's mcp/gh_mcp/tests.test.ts, `the_hook_turns_away_gh_in_bash`), and as Claude Code runs
// it: through bin/huntaway, with the call on stdin. The shell reader's own cases are packages/shared/test/shell.test.ts.

const BIN = fileURLToPath(new URL("../../bin/huntaway", import.meta.url))
const ENTRY = fileURLToPath(new URL("gh-hook.ts", import.meta.url))

const dirs: Array<string> = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const denial = (tool: string, command: string) => hookDenial({ tool_name: tool, tool_input: { command } })
const run = (input: string) => spawnSync(BIN, ["gh-hook"], { input, encoding: "utf8" })
const bash = (command: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } })

describe("gh-hook", () => {
  it("turns away gh in Bash", () => {
    for (const c of [
      "gh pr view 3",
      "cd /x && gh pr create --fill",
      "GH_TOKEN=x /usr/bin/gh api user",
      "echo $(gh pr list)",
      "timeout 60 gh run watch",
      "bash -c 'gh pr checks'",
      "env -u; gh api user",
      "$'g\\x68' api user",
      "builtin command gh api user",
      "eval 'gh api user'",
      // One the reader can't make sense of (a substitution that never ends) is turned away too.
      "echo $(gh pr view",
    ]) {
      assert.include(denial("Bash", c) ?? "", "mcp__gh__pr_view", c)
    }
    for (const c of ["git push -u origin x", "grep -r gh src", "echo gh", "ls ~/.config/gh", "cargo test gh_mcp"])
      assert.strictEqual(denial("Bash", c), null, c)
    assert.strictEqual(denial("Read", "gh pr view"), null)
    assert.strictEqual(hookDenial({}), null)
  })

  it("answers through the launcher", () => {
    const out = run(bash("cd /x && gh pr view 3"))
    assert.strictEqual(out.status, 0, out.stderr)
    const answer = JSON.parse(out.stdout).hookSpecificOutput
    assert.deepStrictEqual([answer.hookEventName, answer.permissionDecision], ["PreToolUse", "deny"])
    assert.include(answer.permissionDecisionReason, "Don't run the GitHub CLI (gh) in Bash here")
    // Nothing to say about other commands and tools.
    for (const input of [bash("git status"), JSON.stringify({ tool_name: "Read", tool_input: { file_path: "gh" } })]) {
      assert.deepStrictEqual([run(input).status, run(input).stdout], [0, ""], input)
    }
    // A call it can't read is refused, which exit code 2 is for a PreToolUse hook.
    assert.strictEqual(run("not json").status, 2)
  })

  it("refuses calls when gh.ts can't be loaded", () => {
    const dir = mkdtempSync(join(tmpdir(), "huntaway-hook-test-"))
    dirs.push(dir)
    const preload = join(dir, "broken.mjs")
    writeFileSync(
      preload,
      `import { registerHooks } from "node:module";
registerHooks({
  load(url, context, next) {
    const r = next(url, context);
    if (url.endsWith("/hooks/gh.ts")) r.source = 'throw new Error("gh.ts is broken");';
    return r;
  },
});
`,
    )
    const out = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", pathToFileURL(preload).href, ENTRY], {
      input: bash("gh pr view"),
      encoding: "utf8",
    })
    assert.strictEqual(out.status, 2, out.stderr)
    assert.include(out.stderr, "gh hook failed")
  })
})
