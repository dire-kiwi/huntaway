import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Queue, Schema } from "effect"
import { RunId, Timestamp } from "@huntaway/contracts"
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

describe.skipIf(SHIM === null)("fake-claude (needs cargo to build ia-shim)", () => {
  it.live("takes its prompt, says init, replies, ends the turn with a result, and exits once its input is closed", () =>
    Effect.gen(function* () {
      const lines = yield* Queue.unbounded<string>()
      const output = Layer.succeed(RunOutput, RunOutput.of({ handle: (_, line) => Queue.offer(lines, line).pipe(Effect.asVoid) }))
      yield* Effect.gen(function* () {
        const repo = yield* RunRepo
        const dir = yield* RunDir
        const shim = yield* Shim
        const follower = yield* RunFollower
        const changes = yield* Changes
        const fs = yield* FileSystem.FileSystem
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "huntaway-run-" })
        const task = yield* fakeTask
        const run = yield* repo.insert({ id: RunId.make(`run-${task}`), task_id: task, kind: "prompt", created_at: Timestamp.make("2026-11-12T00:00:00.000Z") })
        const prompt = '{"type":"user","uuid":"u1","message":{"role":"user","content":"say hello"}}\n'
        const args = ["-p", "--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--replay-user-messages"]
        yield* dir.prepare(run.id, {
          program: FAKE_CLAUDE,
          args,
          env: [],
          cwd,
          configDir: null,
          prompt,
          input: true,
          promptId: "u1",
          systemPrompt: null,
          mcpServers: null,
          mcpRun: null,
        })
        yield* shim.spawn(run.id, { program: FAKE_CLAUDE, args, env: [], cwd })
        yield* repo.setPhase(run.id, "running")
        yield* follower.follow(run)
        const turn: Array<typeof Line.Type> = []
        while (turn.at(-1)?.type !== "result") turn.push(yield* Schema.decodeEffect(Line)(yield* Queue.take(lines)))
        assert.deepStrictEqual(
          turn.map((l) => (l.subtype === undefined ? l.type : `${l.type} ${l.subtype}`)),
          ["system init", "assistant", "result success"],
        )
        assert.strictEqual(turn.at(-1)?.result, "Fake reply to: say hello")
        // It waits for more, as Claude Code does, until the server closes its input.
        yield* dir.closeInput(run.id)
        const change = yield* changes.take
        assert.deepStrictEqual(change._tag === "RunExited" ? change.exit : null, { code: 0, signal: null })
      }).pipe(Effect.provide(TestRuns(output, { shimBin: SHIM })))
    }).pipe(Effect.scoped),
  )
})
