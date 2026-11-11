import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema, Stream } from "effect"
import type { Scope, FileSystem } from "effect"
import type { SecureRandom } from "effect/crypto"
import type { SqlClient } from "effect/sql"
import { ThreadSnapshot } from "@huntaway/contracts"
import { fakeAgent, TestBoard } from "@huntaway/testing"
import type { FakeAgent } from "@huntaway/testing"
import { TaskRepo } from "../../tasks/TaskRepo.ts"
import { Threads } from "../../threads/Threads.ts"
import type { RunDir } from "../RunDir.ts"
import { RunOutput } from "../RunOutput.ts"
import type { RunRepo } from "../RunRepo.ts"
import { CHUNK_LINES } from "./output.ts"

// The Claude line handler's chunks (docs/plan/07-agents.md, Following): lines read together are applied several to a
// transaction, and come out as they do one by one.

const Json = Schema.fromJsonString(Schema.Unknown)
const isSnapshot = Schema.is(ThreadSnapshot)

type Env = SecureRandom.SecureRandom | RunOutput | RunRepo | RunDir | TaskRepo | Threads | SqlClient.SqlClient | FileSystem.FileSystem | Scope.Scope

const run = <A, E>(effect: Effect.Effect<A, E, Env>) => effect.pipe(Effect.scoped, Effect.provide(TestBoard()))

const said = (uuid: string, text: string) => ({
  type: "assistant",
  session_id: "s1",
  uuid,
  parent_tool_use_id: null,
  message: { id: `m-${uuid}`, role: "assistant", content: [{ type: "text", text }] },
})
const event = (e: unknown) => ({ type: "stream_event", session_id: "s1", parent_tool_use_id: null, event: e })
const result = { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.5, num_turns: 1, session_id: "s1" }

/** A turn: messages, a call and its result, a reply streamed, a line that isn't JSON, its end, and a message after it. */
const turn: ReadonlyArray<unknown> = [
  { type: "system", subtype: "init", session_id: "s1", model: "m", cwd: "/", tools: [] },
  said("u1", "Looking."),
  {
    type: "assistant",
    session_id: "s1",
    uuid: "u2",
    parent_tool_use_id: null,
    message: { id: "m-u2", role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/x" } }] },
  },
  {
    type: "user",
    session_id: "s1",
    uuid: "u3",
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "x" }] },
  },
  {
    type: "stream_event",
    session_id: "s1",
    parent_tool_use_id: null,
    event: { type: "message_start", message: { id: "m-u4", role: "assistant", content: [] } },
  },
  {
    type: "stream_event",
    session_id: "s1",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Do" } },
  },
  "not json",
  said("u4", "Done."),
  result,
  said("u5", "One more thing."),
]

const encoded = Effect.forEach(turn, (line) => (typeof line === "string" ? Effect.succeed(line) : Schema.encodeEffect(Json)(line)), {
  concurrency: 1,
}).pipe(Effect.orDie)

/** The lines with the offset after each, as the follower reads them. */
const withEnds = (lines: ReadonlyArray<string>, from: number) => {
  let end = from
  return lines.map((line) => {
    end += new TextEncoder().encode(`${line}\n`).length
    return [line, end] as const
  })
}

/** What a run and its task are left with: the thread's items, the run's progress columns, its input. */
const outcome = (agent: FakeAgent) =>
  Effect.gen(function* () {
    const stored = yield* (yield* Threads).stored(agent.run.task_id).pipe(Effect.orDie)
    const row = yield* agent.row
    const task = yield* (yield* TaskRepo).get(agent.run.task_id)
    return {
      items: stored.entries.map((e) => [e.item.type, "text" in e.item ? e.item.text : null, e.item.parent_id ?? null]),
      row: [row.between_turns, row.saw_result, row.agent_at, row.session_id, row.out_offset, row.cost_usd],
      task: [task?.session_id, task?.cost_usd],
      inputClosed: yield* agent.inputClosed,
    }
  })

describe("Claude output in chunks", () => {
  it.effect("lines read together are applied as they are one by one", () =>
    run(
      Effect.gen(function* () {
        const handler = yield* RunOutput
        const handleChunk = handler.handleChunk
        assert.isDefined(handleChunk)
        if (handleChunk === undefined) return
        const lines = yield* encoded

        const single = yield* fakeAgent()
        yield* single.write(lines)
        for (const [line, end] of withEnds(lines, 0)) yield* handler.handle(yield* single.row, line, end)

        const chunked = yield* fakeAgent()
        yield* chunked.write(lines)
        yield* handleChunk(yield* chunked.row, withEnds(lines, 0))

        const one = yield* outcome(single)
        assert.deepStrictEqual(yield* outcome(chunked), one)
        // The turn ended (nothing was waiting, so its input is closed) and its message after it is there.
        assert.isTrue(one.inputClosed)
        assert.deepStrictEqual(one.items.at(-1), ["assistant_message", "One more thing.", null])
      }),
    ),
  )

  it.effect("a reply streamed and then saved in the same chunk leaves no reply being written", () =>
    run(
      Effect.gen(function* () {
        const handler = yield* RunOutput
        const agent = yield* fakeAgent()
        const lines = yield* Effect.forEach(
          [
            event({ type: "message_start", message: { id: "m-u1", role: "assistant", content: [] } }),
            event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
            event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }),
            event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } }),
            said("u1", "Hello"),
          ],
          (line) => Schema.encodeEffect(Json)(line),
          { concurrency: 1 },
        ).pipe(Effect.orDie)
        yield* agent.write(lines)
        yield* (handler.handleChunk ?? (() => Effect.void))(yield* agent.row, withEnds(lines, 0))
        // The preview is published in order with the saved message, which ends it, as when each line is its own.
        const first = yield* (yield* Threads).watch(agent.run.task_id, { limit: 10 }).pipe(Stream.take(1), Stream.runCollect)
        const snapshot = first[0]
        assert.isTrue(snapshot !== undefined && isSnapshot(snapshot))
        if (snapshot === undefined || !isSnapshot(snapshot)) return
        assert.deepStrictEqual(
          snapshot.items.map((i) => ("text" in i ? i.text : null)),
          ["Hello"],
        )
        assert.isNull(snapshot.preview)
      }),
    ),
  )

  it.effect("a chunk longer than a transaction's lines is applied whole, in order", () =>
    run(
      Effect.gen(function* () {
        const handler = yield* RunOutput
        const agent = yield* fakeAgent()
        const n = CHUNK_LINES * 2 + 3
        const lines = yield* Effect.forEach(
          Array.from({ length: n }, (_, i) => said(`u${i}`, `line ${i}`)),
          (line) => Schema.encodeEffect(Json)(line),
          { concurrency: 1 },
        ).pipe(Effect.orDie)
        yield* agent.write(lines)
        const chunk = withEnds(lines, 0)
        yield* (handler.handleChunk ?? (() => Effect.void))(yield* agent.row, chunk)
        const stored = yield* (yield* Threads).stored(agent.run.task_id).pipe(Effect.orDie)
        assert.deepStrictEqual(
          stored.entries.map((e) => ("text" in e.item ? e.item.text : null)),
          Array.from({ length: n }, (_, i) => `line ${i}`),
        )
        const row = yield* agent.row
        assert.deepStrictEqual([row.out_offset, row.agent_at], [chunk.at(-1)?.[1], `u${n - 1}`])
      }),
    ),
  )
})
