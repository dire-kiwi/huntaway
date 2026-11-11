import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import {
  applyEvents,
  initialState,
  type Item,
  type NewEvent,
  PermissionMode,
  type RequestResolution,
  type SavedEvent,
  type Snapshot,
  TaskId,
  ThreadEvent,
  type ThreadRequest,
  Timestamp,
  toThreadPermissionMode,
} from "@huntaway/contracts"
import { readThreadScenario, type ThreadScenarioData, threadScenarios } from "@huntaway/testing"
import { Effect, Option, Predicate, Result, Schema } from "effect"
import { type ClaudeLine, decodeLine } from "./lines.ts"
import { ASK_USER, EXIT_PLAN, requestForPrompt } from "./requests.ts"
import { emptyState, type ItemMeta, type LineEffect, observe, stateFromItems, translate, type TranslateWarning, type TranslatorState } from "./translate.ts"
import { jsonText } from "./tools.ts"

// The recorded Claude sessions (packages/testing/fixtures/threads/claude), each replayed as the new board will write
// it, and folded: the items and requests must be those the scenario's expected events fold into, but for what the board
// does not keep or makes otherwise (`normalize`), as the old threads/fixtures.test.ts compared them. Every line Claude
// Code wrote goes through `decodeLine` and `translate`. What the board writes itself is written the way `Threads` will:
// a user message (`in` user lines; "steered" while a turn is going; `/compact` is a compaction run, no message) is an
// item.added of the board's, and a permission prompt the policy asks about (every can_use_tool under "ask", and always
// AskUserQuestion and ExitPlanMode) is a request.opened made with `requestForPrompt`, resolved with request.resolved
// when the answer goes in; each is fed to the translator with `observe`. An interrupt marks the run as stopping until
// its next result, as `runs.stop` does.

const thread = TaskId.make("thread")
const at = Timestamp.make("2026-11-01T00:00:00.000Z")

const Entry = Schema.Struct({
  dir: Schema.String,
  run: Schema.optionalKey(Schema.Finite),
  msg: Schema.optionalKey(Schema.Unknown),
  line: Schema.optionalKey(Schema.String),
})
const InUser = Schema.Struct({
  type: Schema.Literal("user"),
  message: Schema.Struct({ content: Schema.Array(Schema.Struct({ text: Schema.optionalKey(Schema.String) })) }),
})
const InControl = Schema.Struct({ type: Schema.Literal("control_request"), request: Schema.Struct({ subtype: Schema.String }) })
const InAnswer = Schema.Struct({
  type: Schema.Literal("control_response"),
  response: Schema.Struct({
    request_id: Schema.String,
    response: Schema.optionalKey(
      Schema.Struct({
        behavior: Schema.String,
        message: Schema.optionalKey(Schema.String),
        updatedInput: Schema.optionalKey(Schema.Unknown),
        updatedPermissions: Schema.optionalKey(Schema.Array(Schema.Unknown)),
      }),
    ),
  }),
})

const option =
  <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  (input: unknown): S["Type"] | null =>
    Option.getOrNull(Schema.decodeUnknownOption(schema)(input))
const entryOf = option(Entry)
const inUser = option(InUser)
const inControl = option(InControl)
const inAnswer = option(InAnswer)
const isMode = Schema.is(PermissionMode)

/** One step of a session as the board takes it. */
type Step =
  | { readonly _tag: "Line"; readonly line: ClaudeLine }
  | { readonly _tag: "User"; readonly text: string }
  | { readonly _tag: "Interrupt" }
  | { readonly _tag: "Spawn"; readonly run: number }
  | {
      readonly _tag: "Answer"
      readonly requestId: string
      readonly behavior: string
      readonly message?: string
      readonly updatedInput?: unknown
      readonly updatedPermissions?: ReadonlyArray<unknown>
    }

/** A session's lines, decoded once; lines that are not one of Claude Code's the server reads are skipped, as the follower will. */
const stepsOf = (data: ThreadScenarioData): ReadonlyArray<Step> =>
  data.session.flatMap((raw): ReadonlyArray<Step> => {
    const entry = entryOf(raw)
    if (entry === null) return []
    if (entry.dir === "spawn") return [{ _tag: "Spawn", run: entry.run ?? 1 }]
    if (entry.dir === "in") {
      const user = inUser(entry.msg)
      if (user !== null) return [{ _tag: "User", text: user.message.content.map((b) => b.text ?? "").join("") }]
      if (inControl(entry.msg)?.request.subtype === "interrupt") return [{ _tag: "Interrupt" }]
      const answer = inAnswer(entry.msg)
      const response = answer?.response.response
      if (answer === null || response === undefined) return []
      return [{ _tag: "Answer", requestId: answer.response.request_id, ...response }]
    }
    if (entry.dir !== "out") return []
    const decoded = decodeLine(entry.line ?? jsonText(entry.msg))
    return Result.isSuccess(decoded) ? [{ _tag: "Line", line: decoded.success }] : []
  })

/** An AskUserQuestion's answers as Claude Code takes them (by question text), by the request's question ids. */
const answersOf = (request: ThreadRequest, given: unknown): Record<string, ReadonlyArray<string>> => {
  if (request.type !== "question" || !Predicate.isObject(given)) return {}
  const out: Record<string, ReadonlyArray<string>> = {}
  for (const q of request.questions) {
    const found = given[q.question] ?? given[q.id]
    if (typeof found === "string") out[q.id] = [found]
    else if (Array.isArray(found)) out[q.id] = found.filter((x): x is string => typeof x === "string")
  }
  return out
}

/** The resolution of `request` that the user's answer makes, as the permissions area will write it. */
const resolutionOf = (request: ThreadRequest, answer: Extract<Step, { _tag: "Answer" }>): RequestResolution => {
  const allow = answer.behavior === "allow"
  if (request.type === "question") {
    if (!allow) return { outcome: "cancel", ...(answer.message === undefined ? {} : { message: answer.message }) }
    const input = answer.updatedInput
    return { outcome: "answer", answers: answersOf(request, Predicate.isObject(input) ? input["answers"] : undefined) }
  }
  if (!allow) return { outcome: "deny", ...(answer.message === undefined ? {} : { message: answer.message }) }
  const mode = (answer.updatedPermissions ?? []).flatMap((u) => (Predicate.isObject(u) && u["type"] === "setMode" && isMode(u["mode"]) ? [u["mode"]] : []))[0]
  return request.type === "plan" && mode !== undefined ? { outcome: "allow", permission_mode: toThreadPermissionMode(mode) } : { outcome: "allow" }
}

interface Replayed {
  readonly snapshot: Snapshot
  readonly metas: ReadonlyMap<string, ItemMeta>
  readonly warnings: ReadonlyArray<TranslateWarning>
  readonly effects: ReadonlyArray<LineEffect>
}

/**
 * A session's steps as the board takes them, from the beginning; with `rebuildAt`, the translator's state is rebuilt from
 * the store (the items, requests and metas so far) before that step, as a restarted server's would be.
 */
const replay = (data: ThreadScenarioData, steps: ReadonlyArray<Step>, rebuildAt?: number): Replayed => {
  const policy = data.fixture["permissions"]
  const asks = (tool: string) => policy === "ask" || tool === ASK_USER || tool === EXIT_PLAN
  let state: TranslatorState = emptyState
  let snapshot = initialState({ id: thread, harness: "claude", status: "idle", created_at: at })
  const metas = new Map<string, ItemMeta>()
  const warnings: Array<TranslateWarning> = []
  const effects: Array<LineEffect> = []
  const requests = new Map<string, ThreadRequest>()
  let writeNo = 0
  let turn = false
  let stopping = false
  const append = (events: ReadonlyArray<NewEvent>) => {
    snapshot = applyEvents(
      snapshot,
      events.map((e): SavedEvent => ({ ...e, thread_id: thread, seq: snapshot.seq + 1 })),
    )
  }
  const appendOne = (events: ReadonlyArray<NewEvent>) => {
    for (const e of events) append([e])
  }
  /** What the board writes itself: saved, and taken in by the translator. */
  const board = (events: ReadonlyArray<NewEvent>) => {
    appendOne(events)
    state = observe(state, events)
  }
  steps.forEach((step, i) => {
    if (i === rebuildAt) state = stateFromItems(snapshot.items, snapshot.requests, (id) => metas.get(id))
    switch (step._tag) {
      case "Spawn":
        if (step.run > 1) stopping = false
        return
      case "User":
        // A compaction is a run of its own on the board, with no message of the user's.
        if (step.text !== "/compact")
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
        const request = requests.get(step.requestId)
        if (request === undefined) return
        board([{ type: "request.resolved", request_id: request.id, resolution: resolutionOf(request, step) }])
        return
      }
      case "Line": {
        const line = step.line
        if (line.type === "control_request" && line.request.subtype === "can_use_tool" && "tool_name" in line.request) {
          const prompt = line.request
          if (!asks(prompt.tool_name)) return
          writeNo++
          const made = requestForPrompt(state, {
            id: line.request_id,
            tool_name: prompt.tool_name,
            input: prompt.input,
            tool_use_id: prompt.tool_use_id ?? undefined,
            created_at: at,
          })
          state = made.state
          warnings.push(...made.warnings)
          if (made.request === null) return
          requests.set(made.request.id, made.request)
          board([{ type: "request.opened", request: made.request }])
          return
        }
        const ending = line.type === "result"
        const t = translate(state, line, { writeNo: ++writeNo, at, ...(ending ? { turn: { cost: 0, stopping, compact: false } } : {}) })
        state = t.state
        appendOne(t.events)
        for (const [id, meta] of t.metas) metas.set(id, meta)
        warnings.push(...t.warnings)
        effects.push(...t.effects)
        if (ending) {
          turn = false
          stopping = false
        }
        return
      }
    }
  })
  return { snapshot, metas, warnings, effects }
}

const decodeEvent = option(ThreadEvent)

/** The items and requests the scenario's expected events fold into (a rewind's `items.removed` aside: the board keeps them). */
const expectedOf = (data: ThreadScenarioData): Snapshot => {
  const events = data.expected.flatMap((raw) => {
    const e = raw["type"] === "delta" ? null : decodeEvent(raw)
    return e === null ? [] : [e]
  })
  let state = initialState({ id: thread, harness: "claude", status: "idle", created_at: at })
  events.forEach((e, i) => {
    state = applyEvents(state, [{ ...e, thread_id: thread, seq: i + 1 }])
  })
  return state
}

/** Notices agent-threads makes that the board doesn't: for its own commands, and for hooks and API retries. */
const BOARD_NOTICES = new Set(["session.new", "rewind", "hook", "retry"])

/**
 * An item as compared: without its id (but a tool call's, which is Claude's for both), time and the board's metadata, a
 * subagent's end time, and an edit's diff (from its result's structuredPatch, which the board does not read).
 */
const normalize = (item: Item): unknown => {
  const { id, created_at: _created, metadata: _metadata, ...rest } = item
  const out: Record<string, unknown> = item.type === "tool_call" ? { id, ...rest } : rest
  if (item.type === "tool_call" && item.subagent !== undefined) {
    const { ended_at: _ended, ...subagent } = item.subagent
    out["subagent"] = subagent
  }
  if (item.type === "tool_call" && item.changes !== undefined) out["changes"] = item.changes.map((c) => ({ path: c.path }))
  return out
}

/** The expected items, without agent-threads' own notices and `/compact` as a user message. */
const expectedItems = (items: ReadonlyArray<Item>) =>
  items
    .filter((i) => !(i.type === "notice" && i.code !== undefined && BOARD_NOTICES.has(i.code)) && !(i.type === "user_message" && i.text === "/compact"))
    .map(normalize)

/** Ours, without what the board keeps that agent-threads leaves out: "[Request interrupted…]" and API error notices. */
const ourItems = (items: ReadonlyArray<Item>) => items.filter((i) => !(i.type === "notice" && i.code !== undefined && i.level !== "warning")).map(normalize)

/** A request as compared: without its id, time and metadata, which the board picks. */
const normalizeRequest = (r: ThreadRequest): unknown => {
  const { id: _id, created_at: _created, metadata: _metadata, ...rest } = r
  return rest
}

const scenarios = Effect.gen(function* () {
  const all = yield* threadScenarios
  return yield* Effect.forEach(
    all.filter((s) => s.harness === "claude"),
    (s) => Effect.map(readThreadScenario(s), (data) => ({ data, steps: stepsOf(data) })),
    { concurrency: 1 },
  )
}).pipe(Effect.provide(NodeServices.layer))

describe("the recorded Claude sessions", () => {
  it.effect("there are 22", () => Effect.map(scenarios, (all) => assert.strictEqual(all.length, 22)))

  it.effect("each translates to the items and requests its expected events fold into, with no warning", () =>
    Effect.gen(function* () {
      const passed: Array<string> = []
      for (const { data, steps } of yield* scenarios) {
        const ours = replay(data, steps)
        const want = expectedOf(data)
        assert.deepStrictEqual(ourItems(ours.snapshot.items), expectedItems(want.items), `${data.name}: items`)
        assert.deepStrictEqual(ours.snapshot.requests.map(normalizeRequest), want.requests.map(normalizeRequest), `${data.name}: requests`)
        assert.deepStrictEqual(ours.warnings, [], `${data.name}: warnings`)
        passed.push(data.name)
      }
      assert.strictEqual(passed.length, 22)
    }),
  )

  it.effect("the reply being written streams as the text it is saved as, and the session and turns are the run's", () =>
    Effect.gen(function* () {
      const found = (yield* scenarios).find((s) => s.data.name === "plain-reply") ?? assert.fail("no plain-reply")
      const { snapshot, effects } = replay(found.data, found.steps)
      const reply = snapshot.items.find((i) => i.type === "assistant_message")
      const streamed = effects.flatMap((e) => (e._tag === "PreviewText" ? [e.text] : [])).join("")
      assert.strictEqual(streamed, reply?.type === "assistant_message" ? reply.text : "")
      assert.deepStrictEqual(
        effects.filter((e) => e._tag === "SessionStarted" || e._tag === "TurnEnded"),
        [
          { _tag: "SessionStarted", sessionId: "f3ea1afc-611c-40e9-92cd-b9af43f70400" },
          { _tag: "TurnEnded", error: null, interrupted: false, usageLimit: false },
        ],
      )
    }),
  )

  it.effect("a state rebuilt from the store before any step goes on as the live one does", () =>
    Effect.gen(function* () {
      for (const { data, steps } of yield* scenarios) {
        const live = replay(data, steps)
        for (let i = 0; i <= steps.length; i++) {
          const rebuilt = replay(data, steps, i)
          assert.deepStrictEqual(rebuilt.snapshot.items, live.snapshot.items, `${data.name}: items, rebuilt before step ${i}`)
          assert.deepStrictEqual(rebuilt.snapshot.requests, live.snapshot.requests, `${data.name}: requests, rebuilt before step ${i}`)
          assert.deepStrictEqual([...rebuilt.metas], [...live.metas], `${data.name}: metas, rebuilt before step ${i}`)
        }
      }
    }),
  )
})
