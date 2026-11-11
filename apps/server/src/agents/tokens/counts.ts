import { Predicate } from "effect"

// What a model used, as totals or as what they went up by (huntaway's agent/tokens.ts, `Counts`): the arithmetic the
// token counting (`agents/Tokens`) and the side calls' records (`agents/SideCalls`) share. Plain functions over plain
// records; `add` and `scale` change their first argument, as the old ones did, for the counting's local copies.

export interface Counts {
  input: number
  output: number
  cache_read: number
  cache_write: number
  /**
   * The part of `cache_write` written to the 1-hour cache, and to the 5-minute one (HA-304), as Claude Code says them
   * (`cacheCreationEphemeral1hInputTokens`/`5m`, a request's `cache_creation`). Not known where they don't add up to
   * `cache_write` (see `writeSplit`): older Claude Code didn't say, nor did snapshots saved before they were counted.
   */
  cache_write_1h: number
  cache_write_5m: number
  reasoning: number
  cost: number
}

export type ByModel = Record<string, Counts>

export const counts = (fields: Partial<Counts> = {}): Counts => ({
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
  cache_write_1h: 0,
  cache_write_5m: 0,
  reasoning: 0,
  cost: 0,
  ...fields,
})

/** `v[key]`, if `v` is an object that has it. */
export const field = (v: unknown, key: string): unknown => (Predicate.hasProperty(v, key) ? v[key] : undefined)

/** A whole number, else 0 (serde's default for a missing or mistyped count). */
export const int = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) ? v : 0)

/** Counts read back from a saved snapshot (serde's defaults for missing fields). */
export const countsFromJson = (v: unknown): Counts => {
  const n = (k: string) => {
    const x = field(v, k)
    return typeof x === "number" ? x : 0
  }
  return {
    input: n("input"),
    output: n("output"),
    cache_read: n("cache_read"),
    cache_write: n("cache_write"),
    cache_write_1h: n("cache_write_1h"),
    cache_write_5m: n("cache_write_5m"),
    reasoning: n("reasoning"),
    cost: n("cost"),
  }
}

export const total = (c: Counts): number => c.input + c.output + c.cache_read + c.cache_write

/** The tokens fed in, which a Claude Code request's message has in full (its output count can be short). */
export const fed = (c: Counts): number => c.input + c.cache_read + c.cache_write

/** Whether every count is at least `o`'s: the same totals, gone on from there. */
export const covers = (c: Counts, o: Counts): boolean =>
  c.input >= o.input && c.output >= o.output && c.cache_read >= o.cache_read && c.cache_write >= o.cache_write

export const minus = (c: Counts, o: Counts): Counts => ({
  input: c.input - o.input,
  output: c.output - o.output,
  cache_read: c.cache_read - o.cache_read,
  cache_write: c.cache_write - o.cache_write,
  cache_write_1h: c.cache_write_1h - o.cache_write_1h,
  cache_write_5m: c.cache_write_5m - o.cache_write_5m,
  reasoning: Math.max(c.reasoning - o.reasoning, 0),
  cost: Math.max(c.cost - o.cost, 0),
})

/** Adds `o` to `c`, in place. */
export const add = (c: Counts, o: Counts): void => {
  c.input += o.input
  c.output += o.output
  c.cache_read += o.cache_read
  c.cache_write += o.cache_write
  c.cache_write_1h += o.cache_write_1h
  c.cache_write_5m += o.cache_write_5m
  c.reasoning += o.reasoning
  c.cost += o.cost
}

/** Rust's `f64::round` (half away from zero). */
const round = (x: number) => Math.sign(x) * Math.round(Math.abs(x))

/** Scales `c` by `f`, in place, keeping the cache writes' split adding up if it did. */
export const scale = (c: Counts, f: number): void => {
  const split = writeSplit(c)
  c.input = round(c.input * f)
  c.output = round(c.output * f)
  c.cache_read = round(c.cache_read * f)
  c.cache_write = round(c.cache_write * f)
  c.cache_write_1h = round(c.cache_write_1h * f)
  // Still adding up to the writes, if they did.
  c.cache_write_5m = split ? c.cache_write - c.cache_write_1h : round(c.cache_write_5m * f)
  c.reasoning = round(c.reasoning * f)
  c.cost *= f
}

/** One model's part of a Claude Code `modelUsage`. */
export const countsFromClaude = (m: unknown): Counts => {
  const cost = field(m, "costUSD")
  return {
    input: int(field(m, "inputTokens")),
    output: int(field(m, "outputTokens")),
    cache_read: int(field(m, "cacheReadInputTokens")),
    cache_write: int(field(m, "cacheCreationInputTokens")),
    cache_write_1h: int(field(m, "cacheCreationEphemeral1hInputTokens")),
    cache_write_5m: int(field(m, "cacheCreationEphemeral5mInputTokens")),
    reasoning: int(field(m, "thinkingTokens")),
    cost: typeof cost === "number" ? cost : 0,
  }
}

/** A Codex `tokenUsage`'s `total` or `last`. */
export const countsFromCodex = (u: unknown): Counts => ({
  input: Math.max(int(field(u, "inputTokens")) - int(field(u, "cachedInputTokens")), 0),
  output: int(field(u, "outputTokens")),
  cache_read: int(field(u, "cachedInputTokens")),
  cache_write: int(field(u, "cacheWriteInputTokens")),
  // Codex doesn't say which cache (see `writeSplit`).
  cache_write_1h: 0,
  cache_write_5m: 0,
  reasoning: int(field(u, "reasoningOutputTokens")),
  cost: 0,
})

/**
 * The 1-hour and 5-minute cache writes in `c`, if they're known: they add up to its writes. A run that went on from a
 * snapshot saved before they were counted, or from older Claude Code that didn't say, has them short (or over).
 */
export const writeSplit = (c: Counts): readonly [number, number] | null => {
  if (c.cache_write_1h < 0 || c.cache_write_5m < 0 || c.cache_write_1h + c.cache_write_5m !== c.cache_write) return null
  return [c.cache_write_1h, c.cache_write_5m]
}

/** The `cache_write_1h_tokens` and `cache_write_5m_tokens` of a row: null where they aren't known (always for Codex). */
export const splitColumns = (runtime: string, n: Counts): readonly [number | null, number | null] =>
  (runtime === "claude" ? writeSplit(n) : null) ?? [null, null]

export const countsEqual = (a: Counts, b: Counts): boolean =>
  a.input === b.input &&
  a.output === b.output &&
  a.cache_read === b.cache_read &&
  a.cache_write === b.cache_write &&
  a.reasoning === b.reasoning &&
  a.cost === b.cost

/** `m` with its keys sorted (a BTreeMap's order). */
export const sorted = <T>(m: Readonly<Record<string, T>>): Record<string, T> => {
  const out: Record<string, T> = {}
  for (const k of Object.keys(m).toSorted()) {
    const v = m[k]
    if (v !== undefined) out[k] = v
  }
  return out
}
