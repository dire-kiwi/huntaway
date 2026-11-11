import { Option, Predicate, Schema } from "effect"
import type { ByModel, Counts } from "./counts.ts"
import { add, counts, countsEqual, countsFromClaude, countsFromCodex, covers, fed, field, int, minus, sorted, total } from "./counts.ts"

// What a run used, counted from its output once it has ended (huntaway's agent/tokens.ts, `count_claude` and
// `count_codex`): plain functions of the run's lines and of what the task's earlier runs had reached. The algorithm is
// the old one, step for step; `agents/Tokens` reads the files and keeps the result.
//
// - Claude Code's `result` at the end of each turn has `modelUsage`: the session's totals for each model so far, its
//   subagents' included. Like its `total_cost_usd`, they go on over the runs that resume the session, so a run used
//   what they went up by: from its task's latest earlier run in the session (`usage_session`, `usage_snapshot`), or
//   from nothing in a new session or one whose totals went down (Claude Code started counting again). Requests after a
//   run's last `result` are counted from their own messages (see `countClaude`).
// - Codex's `thread/tokenUsage/updated` has each thread's totals (subagents' threads are their own) and its latest
//   request's (`last`). Threads keep their totals when they're resumed, so a run used what they went up by too. A
//   thread whose earlier totals aren't known, or that went down (rolled back), adds just its latest request. Here
//   `input` is what wasn't cached, as for Claude.

/** What a run used, by model, and the totals its agent's session (`session`) or threads had reached. */
export interface Counted {
  runtime: "claude" | "codex"
  models: ByModel
  session: string | null
  snapshot: ByModel
  /** The part of `snapshot` a Claude Code run's requests after its last `result` add, counted from their own usage (see `countClaude`). */
  tail: ByModel
  /** Some of it is a guess. */
  estimated: boolean
}

export const counted = (runtime: "claude" | "codex"): Counted => ({ runtime, models: {}, session: null, snapshot: {}, tail: {}, estimated: false })

/** The totals a run's agent started from: its task's latest earlier counted run's, and the part of them that run's requests after its last `result` add. */
export interface Before {
  readonly totals: ByModel
  readonly tail: ByModel
}

/** The totals the task's latest earlier counted run had reached for session (or thread) `key`. */
export type Earlier = (key: string) => Before | null

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const parse = (line: string): unknown => Option.getOrUndefined(decodeJson(line))
const isMap = (v: unknown): v is Record<string, unknown> => Predicate.isObject(v) && !Array.isArray(v)
const isEmpty = (m: object) => Object.keys(m).length === 0
const copy = (m: ByModel): ByModel => Object.fromEntries(Object.entries(m).map(([k, c]) => [k, { ...c }]))

/** `m`'s entry for `k`, made (zero) if there's none. */
const at = (m: ByModel, k: string): Counts => {
  const have = m[k]
  if (have !== undefined) return have
  const made = counts()
  m[k] = made
  return made
}

/** One Claude Code request's usage, from an `assistant` message, and its model and id. */
const requestUsage = (v: unknown): readonly [string, string, Counts] | null => {
  const m = field(v, "message")
  const model = field(m, "model")
  const id = field(m, "id")
  if (typeof model !== "string" || model.startsWith("<")) return null
  if (typeof id !== "string") return null
  const u = field(m, "usage")
  const creation = field(u, "cache_creation")
  const c = counts({
    input: int(field(u, "input_tokens")),
    output: int(field(u, "output_tokens")),
    cache_read: int(field(u, "cache_read_input_tokens")),
    cache_write: int(field(u, "cache_creation_input_tokens")),
    cache_write_1h: int(field(creation, "ephemeral_1h_input_tokens")),
    cache_write_5m: int(field(creation, "ephemeral_5m_input_tokens")),
  })
  return [id, model, c]
}

/**
 * The requests Claude Code `assistant` messages (`lines`) are of, by id, with their model: each request once, though its
 * message comes once for each content block, with the most output any of them says.
 */
const requestsOf = (lines: ReadonlyArray<string>): Map<string, readonly [string, Counts]> => {
  const requests = new Map<string, readonly [string, Counts]>()
  for (const line of lines) {
    const v = parse(line)
    if (field(v, "type") !== "assistant") continue
    const r = requestUsage(v)
    if (r === null) continue
    const [id, model, c] = r
    const have = requests.get(id)
    if (have !== undefined) have[1].output = Math.max(have[1].output, c.output)
    else requests.set(id, [model, c])
  }
  for (const [id, [, c]] of requests) if (total(c) <= 0) requests.delete(id)
  return new Map([...requests].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/**
 * Whether Claude Code didn't keep an earlier run's tail in a session's `totals`, which go on from both the totals with it
 * (`withTail`) and those without it (`without`): which of them the requests the run made before its first result
 * (`made`) are closer to having fed in, on the models the tail used. A guess (`estimated`) unless one is exact: the
 * totals also have requests that print no message.
 */
const tailWasLost = (totals: ByModel, withTail: ByModel, without: ByModel, made: Map<string, readonly [string, Counts]>, out: Counted): boolean => {
  const tailModels = Object.keys(withTail).filter((m) => {
    const w = without[m]
    const t = withTail[m]
    return w === undefined || t === undefined || !countsEqual(w, t)
  })
  const zero = counts()
  const fedSince = (from: ByModel) => tailModels.reduce((sum, m) => sum + fed(minus(totals[m] ?? zero, from[m] ?? zero)), 0)
  const fromWith = fedSince(withTail)
  const fromWithout = fedSince(without)
  let f = 0
  for (const [m, c] of made.values()) if (tailModels.includes(m)) f += fed(c)
  if (f !== fromWith && f !== fromWithout) out.estimated = true
  return Math.abs(fromWithout - f) < Math.abs(fromWith - f)
}

/** Whether a line can matter to `countClaude`: the others are skipped unread. */
export const claudeLineCounts = (line: string): boolean => line.includes('"assistant"') || line.includes('"result"') || line.includes('"init"')

/**
 * What a Claude Code run used, from its output's lines.
 *
 * Requests after the run's last `result` (a turn stopped, or a run that failed or was killed before its result) aren't
 * in any totals: they're counted from their `assistant` messages' own usage, each request once (its message comes once
 * for each content block), subagents' included, and estimated (a message's output count can be short of the
 * request's). They go in the session's totals too, as `tail`: Claude Code keeps them in its totals if it saved them as
 * the run ended, so a run that resumes the session goes on from the totals with them, or else from the totals without
 * them; when its totals go on from both, its own requests before its first result say which (see `tailWasLost`). A run
 * with no result at all goes on from its earlier run's totals, and its tail adds to that run's.
 */
export const countClaude = (lines: Iterable<string>, earlier: Earlier): Counted => {
  const out = counted("claude")
  let session: string | null = null
  // The session the totals in `out.snapshot` are for, and those totals without the earlier run's tail, if it had one.
  let baseSession: string | null = null
  let haveBase = false
  let withoutTail: ByModel | null = null
  // The assistant messages since the latest result, which no result's totals have.
  let since: Array<string> = []
  for (const line of lines) {
    const assistant = line.includes('"assistant"')
    const other = line.includes('"result"') || line.includes('"init"')
    if (!other) {
      // Read once it's known whether a result comes after it.
      if (assistant) since.push(line)
      continue
    }
    const v = parse(line)
    const type = field(v, "type")
    if (type === "assistant") {
      since.push(line)
      continue
    }
    if (type === "system" && field(v, "subtype") === "init") {
      const id = field(v, "session_id")
      if (typeof id === "string") session = id
      continue
    }
    if (type !== "result") continue
    const usage = field(v, "modelUsage")
    if (!isMap(usage) || isEmpty(usage)) continue
    const made = requestsOf(since)
    since = []
    const resultSession = field(v, "session_id")
    const sid: string | null = typeof resultSession === "string" ? resultSession : session
    if (!haveBase || baseSession !== sid) {
      const before: Before = (sid !== null ? earlier(sid) : null) ?? { totals: {}, tail: {} }
      if (!isEmpty(before.tail)) {
        const t = copy(before.totals)
        for (const [m, tail] of Object.entries(before.tail)) {
          const have = t[m]
          if (have !== undefined) t[m] = minus(have, tail)
        }
        // A model only the tail used isn't in totals that don't have it.
        for (const [m, c] of Object.entries(t)) if (total(c) <= 0) delete t[m]
        withoutTail = t
      } else withoutTail = null
      out.snapshot = copy(before.totals)
      baseSession = sid
      haveBase = true
    }
    const totals: ByModel = {}
    for (const m of Object.keys(usage).toSorted()) totals[m] = countsFromClaude(usage[m])
    const covered = (before: ByModel) =>
      Object.entries(before).every(([m, b]) => {
        const now = totals[m]
        return now !== undefined && covers(now, b)
      })
    const t = withoutTail
    withoutTail = null
    if (t !== null && covered(t) && (!covered(out.snapshot) || tailWasLost(totals, out.snapshot, t, made, out))) {
      // Claude Code didn't keep the earlier run's tail: the totals don't go on from it, or they go on from both and
      // the run's own requests say which.
      out.snapshot = t
    } else if (!covered(out.snapshot)) {
      // Counting started again: a model it had is gone, or went down.
      out.snapshot = {}
    }
    for (const [model, n] of Object.entries(totals)) add(at(out.models, model), minus(n, out.snapshot[model] ?? counts()))
    out.snapshot = totals
    out.session = sid
  }
  // The requests after the last result.
  const requests = requestsOf(since)
  // No result set where the session's totals were: the run's requests go on from its earlier run's (and from its tail,
  // if that had one too, which a run that resumes it may not find).
  if (requests.size > 0 && !haveBase) {
    const before = session !== null ? earlier(session) : null
    if (before !== null) {
      out.snapshot = copy(before.totals)
      out.tail = copy(before.tail)
    }
    out.session = session
  }
  for (const [model, c] of requests.values()) {
    out.estimated = true
    add(at(out.models, model), c)
    add(at(out.snapshot, model), c)
    add(at(out.tail, model), c)
  }
  for (const [m, c] of Object.entries(out.models)) if (!(total(c) > 0 || c.cost > 0)) delete out.models[m]
  out.models = sorted(out.models)
  out.snapshot = sorted(out.snapshot)
  out.tail = sorted(out.tail)
  return out
}

/** Whether a line can matter to `countCodex`: the others are skipped unread. */
export const codexLineCounts = (line: string): boolean =>
  line.includes("collabAgentToolCall") || line.includes("subAgentActivity") || line.includes("thread/tokenUsage/updated") || line.includes("huntaway/model")

/** The model a subagent's thread was started with, if it says one. */
const started = (m: unknown) => (typeof m === "string" && m !== "" ? m : null)

/**
 * What a Codex run used, from its output's lines, with `model` unless the output names it. A subagent's thread counts
 * towards the model it was started with, if its start says (Codex's `collabAgentToolCall` spawning it, or its
 * `subAgentActivity`), else the run's.
 */
export const countCodex = (lines: Iterable<string>, runModel: string, earlier: Earlier): Counted => {
  const out = counted("codex")
  let model = runModel
  // Threads' models, where they're known, and what each thread used.
  const models = new Map<string, string>()
  const used: Array<readonly [string, Counts]> = []
  for (const line of lines) {
    if (!codexLineCounts(line)) continue
    const v = parse(line)
    if (v === undefined) continue
    const p = field(v, "params") ?? {}
    const method = field(v, "method")
    if (method === "huntaway/model") {
      const m = field(p, "model")
      if (typeof m === "string" && m !== "") model = m
      continue
    }
    const item = field(p, "item") ?? {}
    const itemType = field(item, "type")
    if (itemType === "collabAgentToolCall" && field(item, "tool") === "spawnAgent") {
      const m = started(field(item, "model"))
      const receivers = field(item, "receiverThreadIds")
      if (m !== null && Array.isArray(receivers)) for (const t of receivers) if (typeof t === "string") models.set(t, m)
      continue
    }
    if (itemType === "subAgentActivity") {
      const m = started(field(item, "model"))
      const thread = field(item, "agentThreadId")
      if (typeof thread === "string" && m !== null) models.set(thread, m)
      continue
    }
    if (method !== "thread/tokenUsage/updated") continue
    const thread = field(p, "threadId")
    if (typeof thread !== "string") continue
    const usage = field(p, "tokenUsage")
    const tot = countsFromCodex(field(usage, "total"))
    const last = countsFromCodex(field(usage, "last"))
    if (!(thread in out.snapshot)) {
      const before = earlier(thread)?.totals[thread]
      if (before !== undefined) out.snapshot[thread] = { ...before }
    }
    const before = out.snapshot[thread]
    // Rolled back, if it doesn't cover them; just the latest request where its earlier totals aren't known.
    const added = before !== undefined ? (covers(tot, before) ? minus(tot, before) : last) : total(tot) === total(last) ? tot : last
    used.push([thread, added])
    out.snapshot[thread] = tot
  }
  // Once the run's own model is known (the adapter says it as the thread starts).
  for (const [thread, added] of used) add(at(out.models, models.get(thread) ?? model), added)
  for (const [m, c] of Object.entries(out.models)) if (!(total(c) > 0)) delete out.models[m]
  out.models = sorted(out.models)
  out.snapshot = sorted(out.snapshot)
  return out
}

/** The thread a Codex run's output says it started (`thread/started`), if it does. */
export const startedThread = (lines: Iterable<string>): string | null => {
  for (const l of lines) {
    if (!l.includes("thread/started")) continue
    const id = field(field(field(parse(l), "params"), "thread"), "id")
    if (typeof id === "string") return id
  }
  return null
}

/** The model of a Codex rollout file's `turn_context`, if it has one. */
export const rolloutModel = (lines: Iterable<string>): string | null => {
  for (const l of lines) {
    if (!l.includes('"turn_context"')) continue
    const m = field(field(parse(l), "payload"), "model")
    if (typeof m === "string") return m
  }
  return null
}
