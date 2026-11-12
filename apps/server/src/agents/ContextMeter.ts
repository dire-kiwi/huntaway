import { Context, DateTime, Effect, HashMap, Layer, Option, Predicate, Ref, Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import { Timestamp } from "@huntaway/contracts"
import type { Context as TaskContext, RunId, TaskId } from "@huntaway/contracts"
import { toJson } from "../platform/columns.ts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { TaskNotFound } from "../tasks/Tasks.ts"
import { ThreadReaders } from "../threads/ThreadReaders.ts"
import type { AssistantLine, ControlResponseLine, ResultLine } from "./claude/lines.ts"
import { ContextStatsRepo } from "./ContextStatsRepo.ts"
import { field } from "./tokens/counts.ts"

// How full each thread's context window is, like Claude Code's `/context` (huntaway's agent/context.ts).
//
// The token count follows the agent's replies as it works: each reply's usage (Claude Code's `assistant` messages,
// Codex's `thread/tokenUsage/updated`) says how much the session sent the model. At the end of each Claude Code turn the
// board also asks the agent for the breakdown `/context` shows (a `get_context_usage` control request on its input), and
// keeps the latest one for `tasks.context`. It asks for the summary: the total is the last reply's usage and the parts
// are estimated locally. The full one counts each part with Anthropic's token-counting API, which would be more requests
// every turn, and Claude Code waits for it before exiting (up to 5 minutes), keeping a finished run going.
//
// For statistics it also keeps a row for the end of each turn with the context it leaves, and one for each compaction,
// in `context_stats`, which outlive the session. The run's line handler calls these methods; nothing here reads a
// run's files or writes its input (`requestLine` gives the line to append).

/** Prefix of the control requests' ids, so their responses can be told from others. */
const REQUEST_PREFIX = "context-"

/** The run a line came from, as far as the meter needs it (`runs/Run` satisfies it). */
export interface RunRef {
  readonly id: RunId
  readonly task_id: TaskId
  readonly kind: "prompt" | "compact" | "review"
  readonly created_at: Timestamp
}

/** A compaction's `compact_metadata` (Claude Code's; Codex's has just the `trigger`). */
export interface CompactInfo {
  readonly trigger?: string | null | undefined
  readonly pre_tokens?: number | null | undefined
  readonly post_tokens?: number | null | undefined
  readonly duration_ms?: number | null | undefined
}

/** What `tasks.context` answers: the summary on the task and the latest breakdown, each null if there's none. */
export interface ContextView {
  readonly context: TaskContext | null
  /** Shaped like Claude Code's `get_context_usage` response, without `gridRows`. */
  readonly detail: unknown
}

export interface ContextMeterShape {
  /** A Claude Code `assistant` message: its usage is what the session sent the model for it. Subagents' are in their own context. */
  readonly onAssistant: (run: RunRef, line: AssistantLine) => Effect.Effect<void>
  /** A turn's `result`: the model's context window from its `modelUsage`, until a breakdown says it. */
  readonly onResult: (task: TaskId, line: ResultLine) => Effect.Effect<void>
  /**
   * The end of one of the agent's turns: the context it started from (its first request) and leaves, and what the turn
   * cost (`RunRepo.addCost`'s answer for it), as a `context_stats` row. Only for a turn the model answered, and never a
   * `/compact`'s.
   */
  readonly recordTurn: (run: RunRef, costUsd: number | null) => Effect.Effect<void>
  /** After compacting, the session starts again from the summary; the compaction gets a row with where it came from. */
  readonly onCompacted: (run: RunRef, meta: CompactInfo | null | undefined) => Effect.Effect<void>
  /** The line that asks the agent for its context's (summary) breakdown, for the run's input, if it still takes input. */
  readonly requestLine: Effect.Effect<string>
  /** A `control_response`: the breakdown, if it answers `requestLine`'s request. Returns whether it was one of those. */
  readonly onControlResponse: (task: TaskId, line: ControlResponseLine) => Effect.Effect<boolean>
  /** Codex's `thread/tokenUsage/updated` params, for the thread's own session (not a subagent's). */
  readonly onCodexUsage: (run: RunRef, params: unknown) => Effect.Effect<void>
  /** Forget the session's context, when the thread starts a new one. */
  readonly clear: (task: TaskId) => Effect.Effect<void>
  /** For `tasks.context`. */
  readonly get: (task: TaskId) => Effect.Effect<ContextView, TaskNotFound>
}

/** serde's `as_u64`: a non-negative whole number, else null. */
const u64 = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null)
/** serde's `as_i64`. */
const i64 = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null)
const isMap = (v: unknown): v is Record<string, unknown> => Predicate.isObject(v) && !Array.isArray(v)

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/** A thread's context before anything said it. */
const fresh = (at: Timestamp): TaskContext => ({ tokens: 0, max_tokens: null, compact_at: null, model: null, updated_at: at, detail_at: null })

/** `base` with `over` written over it. */
const withFields = (base: TaskContext, over: Partial<TaskContext>): TaskContext => ({
  tokens: over.tokens ?? base.tokens,
  max_tokens: over.max_tokens === undefined ? base.max_tokens : over.max_tokens,
  compact_at: over.compact_at === undefined ? base.compact_at : over.compact_at,
  model: over.model === undefined ? base.model : over.model,
  updated_at: over.updated_at ?? base.updated_at,
  detail_at: over.detail_at === undefined ? base.detail_at : over.detail_at,
})

export class ContextMeter extends Context.Service<ContextMeter, ContextMeterShape>()("huntaway-server/agents/ContextMeter") {
  static readonly layer = Layer.effect(
    ContextMeter,
    Effect.gen(function* () {
      const repo = yield* ContextStatsRepo
      const tasks = yield* TaskRepo
      const db = yield* Db
      const events = yield* Events
      const readers = yield* ThreadReaders
      const random = yield* SecureRandom.SecureRandom

      const now = Effect.map(DateTime.now, (t) => Timestamp.make(DateTime.formatIso(t)))
      /**
       * The tokens each task's run last reported on an assistant line, and noted: one reply comes as several lines with
       * the same usage, and noting them again (the turn's sizes on the run, the task's context read and compared) was half
       * the follower's time per line (docs/plan/10-testing.md, As measured before the switch). Forgotten whenever the
       * context or the turn's sizes change another way.
       */
      const noted = yield* Ref.make(HashMap.empty<TaskId, { readonly run: RunId; readonly tokens: number }>())
      const forget = (task: TaskId) => Ref.update(noted, HashMap.remove(task))
      const current = (task: TaskId) => Effect.map(tasks.get(task), (t) => t?.context ?? null)

      /**
       * Writes the task's context (and breakdown, unless undefined) and tells the board, in one transaction. Not through
       * `Tasks.change`: the context changes nothing the reactor reacts to, and this runs for each of an agent's replies.
       */
      const save = Effect.fnUntraced(function* (task: TaskId, ctx: TaskContext | null, detail?: string | null) {
        yield* forget(task)
        const at = yield* now
        yield* db.tx(
          Effect.gen(function* () {
            if ((yield* tasks.get(task)) === null) return
            yield* tasks.write(task, { context: ctx }, at)
            if (detail !== undefined) yield* repo.setDetail(task, detail)
            const after = yield* tasks.get(task)
            if (after !== null) yield* events.emit({ type: "task", task: after })
          }),
        )
      })

      const setTokens = Effect.fnUntraced(function* (task: TaskId, tokens: number, maxTokens: number | null) {
        const old = yield* current(task)
        const at = yield* now
        const ctx = withFields(old ?? fresh(at), { tokens, max_tokens: maxTokens ?? old?.max_tokens ?? null })
        // One reply comes as several messages with the same usage.
        if (old !== null && old.tokens === ctx.tokens && old.max_tokens === ctx.max_tokens) return
        yield* save(task, withFields(ctx, { updated_at: at }))
      })

      const onAssistant = Effect.fnUntraced(function* (run: RunRef, line: AssistantLine) {
        if (line.parent_tool_use_id != null) return
        const u = line.message.usage
        if (!isMap(u)) return
        // Synthetic messages (an error, a stop) weren't sent to the model.
        if (line.message.model?.startsWith("<") === true) return
        const n = (k: string) => u64(u[k]) ?? 0
        // Counted as `/context` counts it.
        const tokens = n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens")
        if (tokens === 0) return
        const last = HashMap.get(yield* Ref.get(noted), run.task_id)
        if (Option.isSome(last) && last.value.run === run.id && last.value.tokens === tokens) return
        yield* repo.turnUsage(run.id, tokens)
        yield* setTokens(run.task_id, tokens, null)
        yield* Ref.update(noted, HashMap.set(run.task_id, { run: run.id, tokens }))
      })

      const onCodexUsage = Effect.fnUntraced(function* (run: RunRef, params: unknown) {
        const session = (yield* tasks.get(run.task_id))?.session_id ?? null
        const thread = field(params, "threadId")
        if (typeof thread === "string" && session !== null && session !== thread) return
        const usage = field(params, "tokenUsage")
        const tokens = u64(field(field(usage, "last"), "totalTokens"))
        if (tokens === null) return
        yield* repo.turnUsage(run.id, tokens)
        yield* setTokens(run.task_id, tokens, u64(field(usage, "modelContextWindow")))
      })

      /** Where a compaction came from: the agent's own (`auto`), the board's after a session sat idle (a `/compact` run no user message started), or the user's. */
      const compactionSource = Effect.fnUntraced(function* (run: RunRef, trigger: string) {
        if (trigger === "auto") return "auto" as const
        const prompted = yield* readers.userMessagedSince(run.task_id, run.created_at)
        return run.kind === "compact" && !prompted ? ("idle" as const) : ("user" as const)
      })

      const onCompacted = Effect.fnUntraced(function* (run: RunRef, meta: CompactInfo | null | undefined) {
        const before = yield* current(run.task_id)
        const source = yield* compactionSource(run, typeof meta?.trigger === "string" ? meta.trigger : "")
        yield* repo.insertCompaction({
          task_id: run.task_id,
          run_id: run.id,
          at: yield* now,
          // Codex doesn't say how big the context was: it's the latest count.
          tokens: i64(meta?.pre_tokens) ?? before?.tokens ?? null,
          post_tokens: i64(meta?.post_tokens),
          max_tokens: before?.max_tokens ?? null,
          model: before?.model ?? null,
          source,
          duration_ms: i64(meta?.duration_ms),
        })
        const tokens = u64(meta?.post_tokens)
        if (tokens === null) return
        yield* repo.compactedTurn(run.id, tokens)
        yield* setTokens(run.task_id, tokens, null)
        yield* forget(run.task_id)
      })

      const recordTurn = Effect.fnUntraced(function* (run: RunRef, costUsd: number | null) {
        if (run.kind === "compact") return
        yield* forget(run.task_id)
        const turn = yield* db.tx(repo.takeTurn(run.id))
        if (turn === null || turn.end === null) return
        const ctx = yield* current(run.task_id)
        yield* repo.insertTurn({
          task_id: run.task_id,
          run_id: run.id,
          at: yield* now,
          tokens: turn.end,
          start_tokens: turn.start,
          max_tokens: ctx?.max_tokens ?? null,
          model: ctx?.model ?? null,
          cost_usd: costUsd,
        })
      })

      const onResult = Effect.fnUntraced(function* (task: TaskId, line: ResultLine) {
        const cur = yield* current(task)
        if (cur === null || cur.max_tokens !== null) return
        const models = line.modelUsage
        if (!isMap(models)) return
        let window: number | null
        if (cur.model !== null && Object.hasOwn(models, cur.model)) {
          window = u64(field(models[cur.model], "contextWindow"))
        } else {
          // Otherwise the biggest: subagents may have run on smaller models.
          const all = Object.values(models)
            .map((m) => u64(field(m, "contextWindow")))
            .filter((w): w is number => w !== null)
          window = all.length > 0 ? Math.max(...all) : null
        }
        if (window === null) return
        yield* save(task, withFields(cur, { max_tokens: window }))
      })

      const requestLine = Effect.gen(function* () {
        const id = `${REQUEST_PREFIX}${yield* random.uuidV4()}`
        return yield* toJson({ type: "control_request", request_id: id, request: { subtype: "get_context_usage", detail: "summary" } })
      })

      const onControlResponse = Effect.fnUntraced(function* (task: TaskId, line: ControlResponseLine) {
        const r = line.response
        if (r.request_id?.startsWith(REQUEST_PREFIX) !== true) return false
        // Claude Code versions without it say so; the token count still works.
        if (r.subtype !== "success") return true
        const resp = r.response
        if (!isMap(resp)) return true
        // The board draws its own grid from the categories.
        const { gridRows: _grid, ...detail } = resp
        const at = yield* now
        const old = yield* current(task)
        const total = u64(detail["totalTokens"])
        const model = detail["model"]
        const ctx = withFields(old ?? fresh(at), {
          ...(total === null ? {} : { tokens: total }),
          max_tokens: u64(detail["maxTokens"]) ?? old?.max_tokens ?? null,
          compact_at: detail["isAutoCompactEnabled"] === false ? null : u64(detail["autoCompactThreshold"]),
          ...(typeof model === "string" ? { model } : {}),
          updated_at: at,
          detail_at: at,
        })
        yield* save(task, ctx, yield* toJson(detail))
        return true
      })

      const clear = Effect.fn("ContextMeter.clear")(function* (task: TaskId) {
        yield* save(task, null, null)
      })

      const get = Effect.fn("ContextMeter.get")(function* (task: TaskId) {
        const t = yield* tasks.get(task)
        if (t === null) return yield* new TaskNotFound({ id: task })
        const raw = yield* repo.detail(task)
        const view: ContextView = { context: t.context, detail: raw === null ? null : Option.getOrNull(decodeJson(raw)) }
        return view
      })

      return ContextMeter.of({ onAssistant, onResult, recordTurn, onCompacted, requestLine, onControlResponse, onCodexUsage, clear, get })
    }),
  )
}
