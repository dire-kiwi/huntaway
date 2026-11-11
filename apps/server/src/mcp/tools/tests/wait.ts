import { assert } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option, Ref, Result, Stream } from "effect"
import { TaskId, Timestamp } from "@huntaway/contracts"
import type { Project, Task } from "@huntaway/contracts"
import { TestBoard } from "@huntaway/testing"
import type { FakeAgent } from "@huntaway/testing"
import { mcpLayer } from "../../../Main.ts"
import { nowTimestamp, toJson } from "../../../platform/columns.ts"
import { Db } from "../../../platform/Db.ts"
import { Events } from "../../../platform/Events.ts"
import type { ServerConfigShape } from "../../../platform/ServerConfig.ts"
import { ProjectRepo } from "../../../projects/ProjectRepo.ts"
import { RunOutput } from "../../../runs/RunOutput.ts"
import type { TaskColumns } from "../../../tasks/decide.ts"
import { TaskRepo } from "../../../tasks/TaskRepo.ts"
import { Wait } from "../../Wait.ts"
import { CommandApproval } from "../../wait/CommandApproval.ts"
import type { CommandAnswer, CommandInput } from "../../wait/CommandApproval.ts"

// What the wait's tests share: the board with its MCP area built over it with a command approval of the test's, a way
// to see a task's agent start waiting (its `task` event), and changes to a task's row that publish it, as the old
// tests' `s.update_task` did.

/** The approval of wait commands: records what it was asked, and answers with `answer` (all allowed by default). */
export const approvalOf = (asked: Ref.Ref<ReadonlyArray<CommandInput>>, answer: (input: CommandInput) => CommandAnswer = () => ({ allowed: true })) =>
  Layer.succeed(CommandApproval, CommandApproval.of({ ask: (_caller, input) => Ref.update(asked, (all) => [...all, input]).pipe(Effect.as(answer(input))) }))

/** The board's MCP area (with `Wait`'s hooks) built again over what is in the environment, with `approval`. */
export const WaitMcp = (approval: Layer.Layer<CommandApproval> = CommandApproval.layerNone) => mcpLayer(Wait.hooks).pipe(Layer.provideMerge(approval))

/** `WaitMcp` over a fresh board (its configuration changed by `overrides`). */
export const WaitBoard = (approval: Layer.Layer<CommandApproval> = CommandApproval.layerNone, overrides: Partial<ServerConfigShape> = {}) =>
  WaitMcp(approval).pipe(Layer.provideMerge(TestBoard(overrides)))

/**
 * Subscribes now (in the scope), and gives what waits for task `id` to show its agent waiting: the task as it was
 * then. The subscription comes first, so a wait that starts in between is seen.
 */
export const waitingOn = (id: string) =>
  Effect.map(
    Effect.flatMap(Events, (events) => events.watch(undefined)),
    (watching): Effect.Effect<Task> =>
      watching.live.pipe(
        Stream.filterMap((e) => (e.type === "task" && e.task.id === id && e.task.agent_wait !== null ? Result.succeed(e.task) : Result.failVoid)),
        Stream.runHead,
        Effect.map(Option.getOrElse(() => assert.fail("the events ended before the task showed a wait"))),
      ),
  )

/** Writes columns of a task's row and publishes it, as the board's own writes do (not an explicit move). */
export const change = (id: string, columns: TaskColumns) =>
  Effect.gen(function* () {
    const repo = yield* TaskRepo
    const events = yield* Events
    yield* (yield* Db).tx(
      Effect.gen(function* () {
        yield* repo.write(TaskId.make(id), columns, yield* nowTimestamp)
        const after = yield* repo.get(id)
        if (after !== null) yield* events.emit({ type: "task", task: after })
      }),
    )
  })

/** The task's row now. */
export const reload = (id: string) =>
  Effect.gen(function* () {
    const t = yield* (yield* TaskRepo).get(id)
    return t ?? assert.fail(`task ${id} is gone`)
  })

/** The project's repository folder, made (a wait's command runs there). */
export const repoOf = (p: Project) =>
  Effect.gen(function* () {
    const found = yield* (yield* ProjectRepo).get(p.id)
    const path = Option.isSome(found) ? found.value.repo_path : assert.fail("no project")
    yield* (yield* FileSystem.FileSystem).makeDirectory(path, { recursive: true }).pipe(Effect.orDie)
    return path
  })

/** A review of a task in `state`, last changed at `at`. */
export const review = (thread: string, state: "running" | "passed" | "issues" | "failed" | "stopped", at: string) => ({
  thread_id: TaskId.make(thread),
  state,
  head: null,
  summary: "A long summary. ".repeat(200),
  issues: state === "issues" ? ["an issue"] : [],
  fixes: 0,
  extra_rounds: 0,
  updated_at: Timestamp.make(at),
  reviewers: [],
})

/** The agent writes `line` (as JSON) to its output, and the board reads it, as far as `end`. */
export const feed = (agent: FakeAgent, line: unknown, end: number) =>
  Effect.gen(function* () {
    yield* (yield* RunOutput).handle(agent.run, yield* toJson(line), end)
  })

/** A server over the board in the environment: the MCP area and `Wait` built afresh, with `approval`; a restart is another. */
export const ServerAgain = (approval: Layer.Layer<CommandApproval> = CommandApproval.layerNone) =>
  WaitMcp(approval).pipe(Layer.provideMerge(Layer.fresh(Wait.layer)))
