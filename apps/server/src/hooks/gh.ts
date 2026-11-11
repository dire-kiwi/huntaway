import { readFileSync } from "node:fs"
import { field, runsProgram } from "@huntaway/shared"

// `huntaway gh-hook` (docs/plan/inventory/03-mcp.md 2.13): Claude Code's PreToolUse hook for Bash in runs that have the
// board's `gh` MCP server. It turns away commands that run gh, saying to use the server's tools instead: gh in Bash may
// not reach GitHub from the sandbox, and would act as gh's active account rather than the run's. It runs for every Bash
// call, so it loads only this, `@huntaway/shared` and Node. From huntaway's mcp/gh_mcp.ts (`bash_hook`, `hook_denial`).

/** The board's gh MCP server's name, which its tools go by (`mcp__gh__pr_view`). */
export const GH_SERVER = "gh"

/** Why a tool call (a hook's input) is turned away, if it is. */
export const hookDenial = (call: unknown): string | null => {
  const command = field(field(call, "tool_input"), "command")
  if (typeof command !== "string" || field(call, "tool_name") !== "Bash") return null
  // A command the check can't read (it throws) is turned away too, rather than let through.
  let runsGh: boolean
  try {
    runsGh = runsProgram(command, "gh")
  } catch {
    runsGh = true
  }
  if (!runsGh) return null
  return (
    `Don't run the GitHub CLI (gh) in Bash here: use the \`${GH_SERVER}\` MCP server's tools instead (mcp__${GH_SERVER}__pr_view, ` +
    `pr_create, pr_checks, pr_merge, issue_view, api and the others; mcp__${GH_SERVER}__gh runs any other gh command, with ` +
    `gh's arguments). They run gh outside the sandbox as the GitHub account this project uses. Run the rest of the ` +
    `command on its own.`
  )
}

/** Why the hook refused a call it couldn't read. */
export const UNREADABLE = "The board's gh hook couldn't read this tool call, so it was refused."

/**
 * Decide the call `input` (Claude Code's PreToolUse JSON, stdin by default): a denial printed for a command that runs gh,
 * nothing for any other. Input that isn't JSON is refused with exit code 2, as a PreToolUse hook blocks a call. Returns
 * the exit code.
 */
export const bashHook = (input: () => string = () => readFileSync(0, "utf8")): number => {
  let call: unknown
  try {
    call = JSON.parse(input())
  } catch {
    process.stderr.write(`${UNREADABLE}\n`)
    return 2
  }
  const reason = hookDenial(call)
  if (reason !== null) {
    const answer = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }
    process.stdout.write(`${JSON.stringify(answer)}\n`)
  }
  return 0
}
