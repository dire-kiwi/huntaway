import { HOOK_FAILED, hookDecision, hookTool, parseRuleList, strict } from "@huntaway/shared"
import type { HookAnswer, Rule } from "@huntaway/shared"

// `huntaway approval-hook '<rules json>'` (docs/plan/06-server.md, Hook commands): Claude Code's PreToolUse hook that
// holds a profile's approval rules in its assistant's Claude runs. Claude Code runs it for every call its matcher
// matches (agents/rules.ts's `claudeHook`), so it loads only this, `@huntaway/shared` and Node. From huntaway's
// agent/approval_rules/hook.ts.

/** Reads all of stdin. */
const readStdin = async (): Promise<string> => {
  const chunks: Array<Buffer> = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  return Buffer.concat(chunks).toString("utf8")
}

const parseJson = (text: string): unknown => JSON.parse(text)

/**
 * Decide the call on stdin by `rules` (the JSON list the command line gives).
 *
 * It fails closed: with rules that ask or refuse (or ones it can't read), a call it can't decide (its input unreadable,
 * or the hook failing in any way) is refused, with exit code 2, which is how a PreToolUse hook blocks a call. With only
 * allow rules, the call goes on to the run's own permissions, as it would without them. Returns the exit code, having
 * written what it answers (to stdout) or why it refused (to stderr).
 */
export const hook = async (rules: string | undefined, input: () => Promise<string> = readStdin): Promise<number> => {
  let parsed: ReadonlyArray<Rule> | null = null
  try {
    parsed = parseRuleList(parseJson(rules ?? ""))
  } catch {
    parsed = null
  }
  let out: HookAnswer | null
  try {
    if (parsed === null) throw new Error("its rules can't be read")
    const call = parseJson(await input())
    if (hookTool(call) === null) throw new Error("the call has no tool name")
    out = hookDecision({ rules: parsed, expiry_minutes: 0 }, call)
  } catch {
    // Failed: refused, unless only allow rules hold (which then just don't allow).
    if (parsed === null || strict(parsed)) {
      process.stderr.write(`${HOOK_FAILED}\n`)
      return 2
    }
    out = null
  }
  if (out !== null) process.stdout.write(`${JSON.stringify(out)}\n`)
  return 0
}
