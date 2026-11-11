import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import {
  applyEvents,
  initialState,
  type Item,
  type NewEvent,
  type RequestResolution,
  type SavedEvent,
  type Snapshot,
  TaskId,
  ThreadEvent,
  type ThreadRequest,
  Timestamp,
} from "@huntaway/contracts"
import { readThreadScenario, type ThreadScenarioData, threadScenarios } from "@huntaway/testing"
import { Effect, Option, Predicate, Result, Schema } from "effect"
import { requestForPrompt } from "../claude/requests.ts"
import { stateFromItems as claudeState } from "../claude/state.ts"
import { displayCommand, field, strField } from "./items.ts"
import { type CodexLine, decodeValue, KEPT_METHODS } from "./lines.ts"
import { classify, CODEX_QUESTIONS } from "./requests.ts"
import { type CodexEffect, type CodexState, emptyState, numbered, observe, stateFromItems, translate } from "./translate.ts"
import type { ItemMeta } from "../../threads/model.ts"

// The recorded Codex sessions (packages/testing/fixtures/threads/codex), replayed as the board takes them (the old
// threads/codex_fixtures.test.ts): the app-server's notifications and requests as the adapter writes them to the run's
// output, each notification decoded (`decodeValue`) and translated (`translate`), and the board's own writes as it makes
// them: the user's messages (a `turn/start` or `turn/steer` the session sent; steered while a turn is going), its
// prompts (a request the policy asks about, and always a question, made with `classify` and `requestForPrompt` over the
// thread as stored, as `Permissions` does) and their answers, each taken in with `observe`. Each process is a run: a
// compaction's (its first request is thread/compact/start) or a prompt's. An interrupt marks the run as stopping until
// its turn ends. The items must be those the expected events fold into, but for what the board does otherwise (`ours`,
// `theirs`).

const thread = TaskId.make("thread")
const at = Timestamp.make("2026-11-01T00:00:00.000Z")

const Entry = Schema.Struct({ dir: Schema.String, msg: Schema.optionalKey(Schema.Unknown) })
const entryOf = (input: unknown) => Option.getOrNull(Schema.decodeUnknownOption(Entry)(input))
const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => Predicate.isObject(v) && !Array.isArray(v)
const isKept = (method: string) => KEPT_METHODS.some((m) => m === method)

/** One step of a session as the board takes it. */
type Step =
  | { readonly _tag: "Spawn"; readonly compact: boolean }
  | { readonly _tag: "User"; readonly text: string }
  | { readonly _tag: "Interrupt" }
  | { readonly _tag: "Answer"; readonly id: string; readonly result: unknown }
  /** thread/start's response: the adapter says the thread started, if the task has no session yet. */
  | { readonly _tag: "Started"; readonly threadId: string }
  | { readonly _tag: "Request"; readonly id: string | number; readonly method: string; readonly params: unknown; readonly item: unknown }
  | { readonly _tag: "Line"; readonly line: CodexLine; readonly method: string; readonly threadId: string | null }

const keyOf = (id: unknown): string => (typeof id === "number" ? `n${id}` : `s${String(id)}`)

/** A session's steps, decoded once. */
const stepsOf = (data: ThreadScenarioData): ReadonlyArray<Step> => {
  const entries = data.session.flatMap((raw) => {
    const e = entryOf(raw)
    return e === null ? [] : [e]
  })
  // Items seen so far, for approvals that only name theirs (the adapter attaches them).
  const items = new Map<string, unknown>()
  return entries.flatMap((entry, i): ReadonlyArray<Step> => {
    const m = entry.msg
    if (entry.dir === "spawn") {
      const first = entries
        .slice(i + 1)
        .find((l) => l.dir === "spawn" || (l.dir === "in" && ["turn/start", "thread/compact/start"].includes(strField(l.msg, "method") ?? "")))
      return [{ _tag: "Spawn", compact: first !== undefined && strField(first.msg, "method") === "thread/compact/start" }]
    }
    if (!isRecord(m) || (entry.dir !== "in" && entry.dir !== "out")) return []
    const method = strField(m, "method")
    if (entry.dir === "in") {
      if (method === "turn/start" || method === "turn/steer") {
        const input = field(m["params"], "input")
        const text = (Array.isArray(input) ? input : []).map((b: unknown) => strField(b, "text") ?? "").join("")
        return [{ _tag: "User", text }]
      }
      if (method === "turn/interrupt") return [{ _tag: "Interrupt" }]
      if (method === null && "id" in m) return [{ _tag: "Answer", id: keyOf(m["id"]), result: field(m, "result") }]
      return []
    }
    if (method === null) {
      const result = field(m, "result")
      const started = strField(field(result, "thread"), "id")
      return started !== null && !isRecord(field(result, "turn")) ? [{ _tag: "Started", threadId: started }] : []
    }
    const item = field(m["params"], "item")
    const itemId = strField(item, "id")
    if (method === "item/started" && itemId !== null) items.set(itemId, item)
    const id = m["id"]
    if (typeof id === "number" || typeof id === "string") {
      const named = strField(m["params"], "itemId")
      return [{ _tag: "Request", id, method, params: m["params"] ?? null, item: named === null ? null : (items.get(named) ?? null) }]
    }
    if (!isKept(method)) return []
    const decoded = decodeValue(m)
    if (Result.isFailure(decoded)) return []
    return [{ _tag: "Line", line: decoded.success, method, threadId: strField(m["params"], "threadId") }]
  })
}

/** The questions' answers a Codex answer gives (`{answers: {<id>: {answers: [...]}}}`), by question id. */
const answersOf = (request: ThreadRequest, result: unknown): Record<string, ReadonlyArray<string>> => {
  if (request.type !== "question") return {}
  const given = field(result, "answers")
  const out: Record<string, ReadonlyArray<string>> = {}
  for (const q of request.questions) {
    const list = field(field(given, q.id), "answers")
    out[q.id] = Array.isArray(list) ? list.filter((x: unknown): x is string => typeof x === "string") : []
  }
  return out
}

/** The resolution the board's answer makes. */
const resolutionOf = (request: ThreadRequest, result: unknown): RequestResolution => {
  const ok = field(result, "decision") === "accept" || field(result, "answers") !== null
  if (request.type === "question") return ok ? { outcome: "answer", answers: answersOf(request, result) } : { outcome: "cancel" }
  return ok ? { outcome: "allow" } : { outcome: "deny" }
}

interface Replayed {
  readonly snapshot: Snapshot
  readonly metas: ReadonlyMap<string, ItemMeta>
  readonly effects: ReadonlyArray<CodexEffect>
}

/** The tools the board asks about (the old `prompt_of`'s). */
const ASKED: ReadonlySet<string> = new Set(["Bash", "ApplyPatch", CODEX_QUESTIONS])

/** A session's steps as the board takes them; with `rebuildAt`, the state is rebuilt from the store before that step. */
const replay = (data: ThreadScenarioData, steps: ReadonlyArray<Step>, rebuildAt?: number): Replayed => {
  const asks = (tool: string) => data.fixture["permissions"] === "ask" || tool === CODEX_QUESTIONS
  let state: CodexState = emptyState
  let snapshot = initialState({ id: thread, harness: "codex", status: "idle", created_at: at })
  const metas = new Map<string, ItemMeta>()
  const effects: Array<CodexEffect> = []
  const asked = new Map<string, ThreadRequest>()
  let session: string | null = null
  let writeNo = 0
  let turn = false
  let compact = false
  let stopping = false
  let sawResult = false
  const append = (events: ReadonlyArray<NewEvent>) => {
    for (const e of events) snapshot = applyEvents(snapshot, [{ ...e, thread_id: thread, seq: snapshot.seq + 1 } satisfies SavedEvent])
  }
  const board = (events: ReadonlyArray<NewEvent>) => {
    append(events)
    state = observe(state, events)
  }
  const line = (l: CodexLine) => {
    const t = translate(state, l, { session, compact, at, writeNo: numbered(l) ? ++writeNo : 0, stopping, sawResult })
    state = t.state
    append(t.events)
    for (const [id, meta] of t.metas) metas.set(id, meta)
    assert.deepStrictEqual(t.warnings, [], `${data.name}: warnings`)
    for (const e of t.effects) {
      effects.push(e)
      if (e._tag === "SessionStarted") session = e.sessionId
      // The board's own warning, as `Threads.notice` writes it.
      if (e._tag === "Notice") {
        board([{ type: "item.added", item: { id: `legacy:${++writeNo}`, type: "notice", level: "warning", text: e.text, created_at: at } }])
      }
      if (e._tag === "TurnEnded") {
        sawResult = true
        stopping = false
      }
    }
  }
  steps.forEach((step, i) => {
    if (i === rebuildAt) state = stateFromItems(snapshot.items)
    switch (step._tag) {
      case "Spawn":
        compact = step.compact
        stopping = false
        sawResult = false
        return
      case "User":
        board([
          {
            type: "item.added",
            item: { id: `legacy:${++writeNo}`, type: "user_message", text: step.text, created_at: at, ...(turn ? { steered: true } : {}) },
          },
        ])
        turn = true
        return
      case "Interrupt":
        stopping = true
        return
      case "Answer": {
        const request = asked.get(step.id)
        if (request !== undefined) board([{ type: "request.resolved", request_id: request.id, resolution: resolutionOf(request, step.result) }])
        return
      }
      case "Started":
        if (session === null) line({ _tag: "Notification", method: "thread/started", params: { thread: { id: step.threadId } }, emittedAtMs: null })
        return
      case "Request": {
        const c = classify({ id: step.id, method: step.method, params: step.params, item: step.item })
        if (c._tag !== "Prompt" || !ASKED.has(c.tool_name) || !asks(c.tool_name)) return
        writeNo++
        const made = requestForPrompt(
          claudeState(snapshot.items, snapshot.requests, () => undefined),
          {
            id: `r-${keyOf(step.id)}`,
            tool_name: c.tool_name,
            input: c.input,
            tool_use_id: c.tool_use_id ?? undefined,
            created_at: at,
          },
        )
        if (made.request === null) return
        asked.set(keyOf(step.id), made.request)
        board([{ type: "request.opened", request: made.request }])
        return
      }
      case "Line":
        if (step.method === "turn/completed" && step.threadId === session) turn = false
        line(step.line)
        return
    }
  })
  return { snapshot, metas, effects }
}

const decodeEvent = (input: unknown) => Option.getOrNull(Schema.decodeUnknownOption(ThreadEvent)(input))

/** The items and requests the scenario's expected events fold into (a rewind's `items.removed` aside: the board keeps them). */
const expectedOf = (data: ThreadScenarioData): Snapshot => {
  const events = data.expected.flatMap((raw) => {
    const e = raw["type"] === "delta" ? null : decodeEvent(raw)
    return e === null ? [] : [e]
  })
  let s = initialState({ id: thread, harness: "codex", status: "idle", created_at: at })
  events.forEach((e, i) => {
    s = applyEvents(s, [{ ...e, thread_id: thread, seq: i + 1 }])
  })
  return s
}

/**
 * An item as compared: what it says, without its id, turn, time and the names and inputs each gives its tools
 * (agent-threads gives Codex's, `commandExecution`; the board its own, `Bash`), with its parent as whether it has one.
 */
const shape = (i: Item): Record<string, unknown> => {
  const out: Record<string, unknown> = { type: i.type }
  if (i.parent_id !== undefined) out["child"] = true
  switch (i.type) {
    case "user_message":
      out["text"] = i.text
      if (i.steered === true) out["steered"] = true
      break
    case "assistant_message":
    case "reasoning":
      out["text"] = i.text
      break
    case "tool_call":
      out["kind"] = i.kind
      out["status"] = i.status
      for (const k of ["command", "path", "query", "url", "server"] as const) if (i[k] !== undefined) out[k] = i[k]
      if (i.changes !== undefined) out["changes"] = i.changes.map((c) => `${c.op} ${c.path}`)
      if (i.todos !== undefined) out["todos"] = i.todos
      // A file change's result is the board's own "Applied.", and a denied call's says it was.
      if (i.result !== undefined && i.kind !== "edit" && i.status !== "denied") out["result"] = i.result.content
      if (i.subagent !== undefined) out["subagent"] = i.subagent.status
      break
    case "notice":
      out["level"] = i.level
      break
    case "turn_result":
      out["ok"] = i.ok
      if (i.interrupted === true) out["interrupted"] = true
      break
    case "compaction":
      break
  }
  return out
}

/**
 * The expected items, without what the board does otherwise: agent-threads' notices for its own commands (a new session,
 * a rewind), `/compact` as the user's message (the board runs it as a compaction), and a question's tool call (Codex
 * makes no item for request_user_input; the board shows its question's card). An app tool (a dynamic tool of
 * agent-threads' own) is kind `app` there; the board's dynamic tools are its MCP server's, and another's is `other`.
 */
const theirs = (s: Snapshot) =>
  s.items
    .filter((i) => !(i.type === "notice" && i.code !== undefined && ["session.new", "rewind"].includes(i.code)))
    .filter((i) => !(i.type === "user_message" && i.text === "/compact"))
    .filter((i) => !(i.type === "tool_call" && i.name === CODEX_QUESTIONS))
    .map((i) => {
      const out = shape(i)
      if (i.type !== "tool_call") return out
      if (i.kind === "app") out["kind"] = "other"
      if (i.command !== undefined) out["command"] = displayCommand(strField(i.input, "command") ?? "")
      return out
    })

/** Codex's collab tools but spawnAgent, whose calls the board shows as calls of their own (agent-threads doesn't). */
const COLLAB = new Set(["wait", "sendInput", "followupTask", "sendMessage", "resumeAgent", "closeAgent", "interruptAgent"])

/**
 * The board's items, without its calls of Codex's collab tools but spawnAgent (see COLLAB), and the user's replies to a
 * Codex plan (plan mode's feedback, and "Implement the plan.") with the turns they end, which agent-threads takes as the
 * plan request's answer, in one turn, rather than as messages.
 */
const ours = (s: Snapshot, scenario: string) =>
  s.items
    .filter((i) => !(i.type === "tool_call" && i.kind === "other" && COLLAB.has(i.name)))
    .filter((i, n, all) => !(scenario === "plan" && ((i.type === "user_message" && n > 0) || (i.type === "turn_result" && n < all.length - 1))))
    .map(shape)

/** A request as compared: its type and kind, and how it was resolved (a plan's are agent-threads' own, see `ours`). */
const requestShape = (r: ThreadRequest) => ({
  type: r.type,
  kind: r.type === "permission" ? r.kind : undefined,
  outcome: r.resolution?.outcome,
  answers: r.resolution?.outcome === "answer" ? r.resolution.answers : undefined,
})

const scenarios = Effect.gen(function* () {
  const all = yield* threadScenarios
  return yield* Effect.forEach(
    all.filter((s) => s.harness === "codex"),
    (s) => Effect.map(readThreadScenario(s), (data) => ({ data, steps: stepsOf(data) })),
    { concurrency: 1 },
  )
}).pipe(Effect.provide(NodeServices.layer))

describe("the recorded Codex sessions", () => {
  it.effect("there are 20", () => Effect.map(scenarios, (all) => assert.strictEqual(all.length, 20)))

  it.effect("each translates to the items and requests its expected events fold into", () =>
    Effect.gen(function* () {
      const passed: Array<string> = []
      for (const { data, steps } of yield* scenarios) {
        const got = replay(data, steps)
        const want = expectedOf(data)
        assert.deepStrictEqual(ours(got.snapshot, data.name), theirs(want), `${data.name}: items`)
        assert.deepStrictEqual(
          got.snapshot.requests.map(requestShape),
          want.requests.filter((r) => r.type !== "plan").map(requestShape),
          `${data.name}: requests`,
        )
        passed.push(data.name)
      }
      assert.strictEqual(passed.length, 20)
    }),
  )

  it.effect("the session and its turns are the run's", () =>
    Effect.gen(function* () {
      const found = (yield* scenarios).find((s) => s.data.name === "plain-reply") ?? assert.fail("no plain-reply")
      const { snapshot, effects } = replay(found.data, found.steps)
      const ended = effects.filter((e) => e._tag === "TurnEnded")
      assert.deepStrictEqual(ended, [{ _tag: "TurnEnded", error: null, interrupted: false, usageLimit: false }])
      assert.strictEqual(effects.filter((e) => e._tag === "SessionStarted").length, 1)
      assert.strictEqual(snapshot.items.at(-1)?.type, "turn_result")
      // The reply being written streams.
      assert.isTrue(effects.some((e) => e._tag === "PreviewText"))
    }),
  )

  it.effect("an interrupted turn ends interrupted", () =>
    Effect.gen(function* () {
      const found = (yield* scenarios).find((s) => s.data.name === "interrupt") ?? assert.fail("no interrupt")
      const { effects } = replay(found.data, found.steps)
      const ended = effects.filter((e) => e._tag === "TurnEnded")
      assert.deepStrictEqual(ended, [{ _tag: "TurnEnded", error: "The turn was interrupted", interrupted: true, usageLimit: false }])
    }),
  )

  it.effect("a state rebuilt from the store before any step goes on as the live one does", () =>
    Effect.gen(function* () {
      for (const { data, steps } of yield* scenarios) {
        const live = replay(data, steps)
        for (let i = 0; i <= steps.length; i++) {
          const rebuilt = replay(data, steps, i)
          assert.deepStrictEqual(rebuilt.snapshot.items, live.snapshot.items, `${data.name}: items, rebuilt before step ${i}`)
          assert.deepStrictEqual([...rebuilt.metas], [...live.metas], `${data.name}: metas, rebuilt before step ${i}`)
        }
      }
    }),
  )
})
