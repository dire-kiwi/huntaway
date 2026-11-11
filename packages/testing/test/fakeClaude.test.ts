import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Queue, Schema } from "effect"
import { RunId, Timestamp } from "@huntaway/contracts"
import { interruptLine, userInput } from "huntaway-server/src/agents/claude/launch.ts"
import { Changes } from "huntaway-server/src/platform/Changes.ts"
import { RunDir } from "huntaway-server/src/runs/RunDir.ts"
import { RunFollower } from "huntaway-server/src/runs/RunFollower.ts"
import { RunOutput } from "huntaway-server/src/runs/RunOutput.ts"
import { RunRepo } from "huntaway-server/src/runs/RunRepo.ts"
import { Shim } from "huntaway-server/src/runs/Shim.ts"
import { ensureShim, FAKE_CLAUDE, fakeTask, TestRuns } from "../src/fakeAgent.ts"

// fake-claude as a run's agent, through the real ia-shim and the server's follower: what inventory 01, section 10 says
// a fake agent must do for one turn.

const SHIM = ensureShim()

const Line = Schema.fromJsonString(Schema.Struct({ type: Schema.String, subtype: Schema.optional(Schema.String), result: Schema.optional(Schema.String) }))
type Line = typeof Line.Type

const ARGS = ["-p", "--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--replay-user-messages"]

/** A line's type, with its subtype. */
const kind = (l: Line) => (l.subtype === undefined ? l.type : `${l.type} ${l.subtype}`)

/**
 * Starts fake-claude on `prompt` under the shim and follows it; `body` gets the run, a take of its next output line,
 * and the run's folder and changes.
 */
const withFake = <A, E>(prompt: string, body: (run: RunId, next: Effect.Effect<Line, Schema.SchemaError>) => Effect.Effect<A, E, RunDir | Changes>) =>
  Effect.gen(function* () {
    const lines = yield* Queue.unbounded<string>()
    const output = Layer.succeed(RunOutput, RunOutput.of({ handle: (_, line) => Queue.offer(lines, line).pipe(Effect.asVoid) }))
    return yield* Effect.gen(function* () {
      const repo = yield* RunRepo
      const dir = yield* RunDir
      const shim = yield* Shim
      const follower = yield* RunFollower
      const fs = yield* FileSystem.FileSystem
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "huntaway-run-" })
      const task = yield* fakeTask
      const run = yield* repo.insert({ id: RunId.make(`run-${task}`), task_id: task, kind: "prompt", created_at: Timestamp.make("2026-11-12T00:00:00.000Z") })
      const message = `${yield* userInput("u1", prompt)}\n`
      yield* dir.prepare(run.id, {
        program: FAKE_CLAUDE,
        args: ARGS,
        env: [],
        cwd,
        configDir: null,
        prompt: message,
        input: true,
        promptId: "u1",
        systemPrompt: null,
        mcpServers: null,
        mcpRun: null,
      })
      yield* shim.spawn(run.id, { program: FAKE_CLAUDE, args: ARGS, env: [], cwd })
      yield* repo.setPhase(run.id, "running")
      yield* follower.follow(run)
      return yield* body(run.id, Effect.flatMap(Queue.take(lines), Schema.decodeEffect(Line)))
    }).pipe(Effect.provide(TestRuns(output, { shimBin: SHIM })))
  }).pipe(Effect.scoped)

/** The lines up to and including the turn's result. */
const turnOf = (next: Effect.Effect<Line, Schema.SchemaError>) =>
  Effect.gen(function* () {
    const turn: Array<Line> = []
    while (turn.at(-1)?.type !== "result") turn.push(yield* next)
    return turn
  })

/** It waits for more, as Claude Code does, until the server closes its input: then it exits. */
const exitsOnClose = (run: RunId) =>
  Effect.gen(function* () {
    yield* (yield* RunDir).closeInput(run)
    const change = yield* (yield* Changes).take
    assert.deepStrictEqual(change._tag === "RunExited" ? change.exit : null, { code: 0, signal: null })
  })

describe.skipIf(SHIM === null)("fake-claude (needs cargo to build ia-shim)", () => {
  it.live("takes its prompt, says init, replies, ends the turn with a result, and exits once its input is closed", () =>
    withFake("say hello", (run, next) =>
      Effect.gen(function* () {
        const turn = yield* turnOf(next)
        assert.deepStrictEqual(turn.map(kind), ["system init", "assistant", "result success"])
        assert.strictEqual(turn.at(-1)?.result, "Fake reply to: say hello")
        yield* exitsOnClose(run)
      }),
    ),
  )

  it.live("with fake-until-interrupted, its turn goes on until an interrupt ends it as Claude Code's does", () =>
    withFake("work on fake-until-interrupted", (run, next) =>
      Effect.gen(function* () {
        assert.strictEqual(kind(yield* next), "system init")
        yield* (yield* RunDir).appendInput(run, yield* interruptLine("stop-1"))
        const turn = yield* turnOf(next)
        assert.deepStrictEqual(turn.map(kind), ["control_response", "user", "result error_during_execution"])
        yield* exitsOnClose(run)
      }),
    ),
  )
})
