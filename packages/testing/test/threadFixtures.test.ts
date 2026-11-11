import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import {
  type AnyThreadEvent,
  applyEvents,
  initialState,
  ItemPage,
  itemPage,
  Snapshot,
  snapshotWindow,
  Thread,
  ThreadEvent,
  ThreadMessage,
  withPage,
} from "@huntaway/contracts"
import { Effect, Option, Path, Schema } from "effect"
import { type JsonObject, readJsonFile, readJsonLines, readThreadScenario, threadFixturesDir, threadScenarios } from "../src/threadFixtures.ts"

// The recorded sessions against the thread protocol's schemas and reducer. The old fixtures.test.ts and
// codex_fixtures.test.ts folded each scenario's expected events (but `items.removed` and deltas) with the reducer and
// compared the translator's items with them; the translators are ported later (plan tasks 2.4 and the Codex driver), so
// here every expected event must decode, losing only what the port leaves out, and fold.

const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => {
  const decodeOption = Schema.decodeUnknownOption(schema)
  return (input: unknown): S["Type"] | null => Option.getOrNull(decodeOption(input))
}
const decodeEvent = decode(ThreadEvent)
const decodeMessage = decode(ThreadMessage)
const decodeThread = decode(Thread)

/** Event types of the old protocol that the board never produced, and the port leaves out (docs/plan/03-domain.md). */
const leftOutTypes = new Set(["thread.updated", "turn.started", "turn.completed", "items.removed"])

/** What of an item or request the port leaves out: never produced by the board. */
const leftOutKeys: Readonly<Record<string, ReadonlyArray<string>>> = {
  user_message: ["turn_id", "client_id", "queued"],
  turn_result: ["turn_id", "usage", "session"],
  question: ["turn_id", "user_messages"],
}

const without = (value: JsonObject, keys: ReadonlyArray<string>): JsonObject => Object.fromEntries(Object.entries(value).filter(([k]) => !keys.includes(k)))

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value)

/** An item or request as the port keeps it. */
const kept = (value: unknown): unknown => {
  if (!isObject(value)) return value
  const type = typeof value["type"] === "string" ? value["type"] : ""
  return without(value, leftOutKeys[type] ?? ["turn_id"])
}

/** An expected event as the port keeps it. */
const keptEvent = (event: JsonObject): JsonObject => {
  if ("item" in event) return { ...event, item: kept(event["item"]) }
  if ("request" in event) return { ...event, request: kept(event["request"]) }
  return event
}

describe("the recorded sessions", () => {
  it.effect("there are 22 Claude and 20 Codex scenarios, each with its files", () =>
    Effect.gen(function* () {
      const scenarios = yield* threadScenarios
      assert.strictEqual(scenarios.filter((s) => s.harness === "claude").length, 22)
      assert.strictEqual(scenarios.filter((s) => s.harness === "codex").length, 20)
      for (const scenario of scenarios) {
        const data = yield* readThreadScenario(scenario)
        assert.isAbove(data.session.length, 0, scenario.dir)
        assert.isAbove(data.expected.length, 0, scenario.dir)
        assert.isString(data.fixture["description"], scenario.dir)
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect("every expected event decodes, as its own type where the protocol declares it, losing only what the port leaves out", () =>
    Effect.gen(function* () {
      let declared = 0
      for (const scenario of yield* threadScenarios) {
        const { expected } = yield* readThreadScenario(scenario)
        expected.forEach((raw, line) => {
          const where = `${scenario.harness}/${scenario.name}/expected.jsonl:${line + 1}`
          assert.isNotNull(decodeMessage(raw), `${where}: not a stream message`)
          if (leftOutTypes.has(String(raw["type"]))) return
          declared++
          assert.deepStrictEqual(decodeEvent(raw), keptEvent(raw), `${where}: refused, or lost more than the port leaves out`)
        })
      }
      // item.added 238, item.updated 137, request.opened 11, request.resolved 11, delta 298.
      assert.strictEqual(declared, 695)
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect("every scenario's events fold, each update finding what it updates, and fold the same delivered twice", () =>
    Effect.gen(function* () {
      for (const scenario of yield* threadScenarios) {
        const { expected } = yield* readThreadScenario(scenario)
        const where = `${scenario.harness}/${scenario.name}`
        const first = expected.find((e) => e["type"] === "thread.updated")
        const thread = decodeThread(first?.["thread"])
        assert.isNotNull(thread, where)
        if (thread === null) continue
        const events = expected.flatMap((raw): ReadonlyArray<AnyThreadEvent> => {
          const message = decodeMessage(raw)
          return message === null || message.type === "snapshot" || message.type === "preview" || !("thread_id" in message) ? [] : [message]
        })
        assert.strictEqual(events.length, expected.length, where)
        let state = initialState(thread)
        for (const event of events) {
          const before = state
          state = applyEvents(state, [event])
          // The updates name items and requests the thread has: none is dropped for want of what it updates.
          if (event.type === "item.updated" && "item_id" in event)
            assert.isTrue(
              before.items.some((i) => i.id === event.item_id),
              `${where}: ${event.seq}`,
            )
          if (event.type === "request.resolved" && "request_id" in event)
            assert.isTrue(
              before.requests.some((r) => r.id === event.request_id),
              `${where}: ${event.seq}`,
            )
        }
        const saved = expected.filter((e) => e["type"] !== "delta")
        assert.strictEqual(state.seq, saved.at(-1)?.["seq"], where)
        assert.deepStrictEqual(
          applyEvents(
            initialState(thread),
            events.flatMap((e) => [e, e]),
          ),
          state,
          where,
        )
        // Deltas only stream text that the item's final text has: folding without them gives the same items.
        assert.deepStrictEqual(
          applyEvents(
            initialState(thread),
            events.filter((e) => e.type !== "delta"),
          ).items,
          state.items,
          where,
        )
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  )
})

// agent-threads' spec examples, which the old protocol.test.ts read through examples.ts: its "spec/examples" cases.
// Dropped: "commands.jsonl has one of each command", since its `rewind` names a `turn_id` and its `send`s carry
// `attachments` and `client_id`, which the port leaves out; contracts' protocol.test.ts decodes one of each command.
const example = (name: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    return path.join(threadFixturesDir, "examples", name)
  })

describe("the protocol's examples", () => {
  const examples = Effect.gen(function* () {
    const raw = yield* readJsonLines(yield* example("thread.events.jsonl"))
    const events = raw.flatMap((e): ReadonlyArray<AnyThreadEvent> => {
      const message = decodeMessage(e)
      return message === null || message.type === "snapshot" || message.type === "preview" || !("thread_id" in message) ? [] : [message]
    })
    const whole = decode(Snapshot)(yield* readJsonFile(yield* example("thread.snapshot.json")))
    const window = decode(Snapshot)(yield* readJsonFile(yield* example("thread.window.json")))
    const page = decode(ItemPage)(yield* readJsonFile(yield* example("thread.page.json")))
    assert.strictEqual(events.length, raw.length)
    assert.isNotNull(whole)
    assert.isNotNull(window)
    assert.isNotNull(page)
    return { raw, events, whole, window, page }
  }).pipe(Effect.provide(NodeServices.layer))

  it.effect("the thread's events fold into thread.snapshot.json, and the same with every event delivered twice", () =>
    Effect.gen(function* () {
      const { events, whole } = yield* examples
      if (whole === null) return
      // `thread.updated` is not declared any more: the thread is the snapshot's, and the events are counted.
      assert.deepStrictEqual(applyEvents(initialState(whole.thread), events), whole)
      assert.deepStrictEqual(
        applyEvents(
          initialState(whole.thread),
          events.flatMap((e) => [e, e]),
        ),
        whole,
      )
    }),
  )

  it.effect("their seqs go up by one, and a delta's is the last saved event's", () =>
    Effect.gen(function* () {
      const { raw } = yield* examples
      let seq = 0
      for (const e of raw) {
        if (e["type"] === "delta") assert.strictEqual(e["seq"], seq)
        else assert.strictEqual(e["seq"], ++seq)
      }
    }),
  )

  it.effect("thread.window.json is the snapshot's window of 8, thread.page.json its page of 3 before 5, and the two the window of 11", () =>
    Effect.gen(function* () {
      const { whole, window, page } = yield* examples
      if (whole === null || window === null || page === null) return
      assert.deepStrictEqual(snapshotWindow(whole, 8), window)
      assert.deepStrictEqual(itemPage(whole, 5, 3), page)
      assert.deepStrictEqual(withPage(window, page), snapshotWindow(whole, 11))
    }),
  )
})
