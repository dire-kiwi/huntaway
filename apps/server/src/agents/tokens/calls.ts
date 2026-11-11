import { Option, Predicate, Schema } from "effect"
import type { ByModel } from "./counts.ts"
import { countsFromClaude, countsFromCodex, field, sorted } from "./counts.ts"

// What one of the board's own model calls used (huntaway's agent/tokens/calls.ts): a title (`agents/Titles`) or a
// window's restart (`agents/UsageWindow`), read from what its reply says. `agents/SideCalls` keeps it.

/** What a call used, by model. */
export interface Spent {
  readonly runtime: "claude" | "codex"
  readonly models: ByModel
}

/** From a Claude Code `result` (`--output-format json`'s output, or stream-json's last line). */
export const spentFromClaude = (result: unknown): Spent => {
  const usage = field(result, "modelUsage")
  const models: ByModel = {}
  if (Predicate.isObject(usage) && !Array.isArray(usage)) for (const [m, u] of Object.entries(usage)) models[m] = countsFromClaude(u)
  return { runtime: "claude", models: sorted(models) }
}

/** From the latest `tokenUsage` of a Codex thread started with `model`. */
export const spentFromCodex = (model: string, usage: unknown): Spent => ({ runtime: "codex", models: { [model]: countsFromCodex(field(usage, "total")) } })

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/** From the last `result` in Claude Code's stream-json output, if it has one. */
export const spentFromClaudeStream = (stdout: string): Spent | null => {
  const lines = stdout.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i] ?? ""
    if (!l.includes('"result"')) continue
    const v = decodeJson(l)
    if (Option.isSome(v) && field(v.value, "type") === "result") return spentFromClaude(v.value)
  }
  return null
}
