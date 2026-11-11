import { Context, Effect, Layer, Schema } from "effect"
import type { RunId, TaskId } from "@huntaway/contracts"
import { BOARD_SERVER_NAMES } from "@huntaway/shared"
import { ToolUseBlock } from "../agents/claude/lines.ts"
import type { ClaudeLine, TaskLine } from "../agents/claude/lines.ts"
import { nowTimestamp } from "../platform/columns.ts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { ThreadReaders } from "../threads/ThreadReaders.ts"
import type { Run } from "./Run.ts"

// What a run's output tells the wait its agent is in (the board's `wait` tool, `mcp/Wait.ts`; docs/plan/inventory/
// 03-mcp.md 2.8; huntaway's mcp/wait.ts `resumed`, `ended` and `subagent_finished`, which runner/output.ts called). The
// stored wait (`tasks.agent_wait`) is what the wait's fiber watches: it reads it again on every `task` event of its
// task, so these write it and publish the task, and the wait ends. The runs area is above `mcp/`, so it reaches the
// wait through the column, as the old server did, not through `Wait`.
//
// - The agent's own thread calling a tool other than `wait` (a Claude `assistant` line with no `parent_tool_use_id`) is
//   the run carrying on with other work: its wait ends (`resumed`). A subagent's calls don't count, so an agent can
//   wait for its subagents; nor do permission prompts (they are no tool calls of the thread).
// - A subagent (an `Agent` or `Task` call) completing, failing or stopping is recorded on the wait, the first only,
//   kept until the call returns (a retried wait after a restart returns it): `subagent_finished`.
// - A turn that ended isn't waiting any more, even if the agent gave up on the call; nor is a run that ended (`over`,
//   which the end of a run calls, plan task 2.6).

/** Whether a tool, as an agent's tool calls name it, is the board's `wait` (under any of the board server's names). */
export const isWaitTool = (tool: string): boolean => BOARD_SERVER_NAMES.some((name) => tool === `mcp__${name}__wait`)

const isToolUse = Schema.is(ToolUseBlock)

/** Whether a line is the agent's own thread (not a subagent) calling a tool other than `wait`. */
export const isActivity = (line: ClaudeLine): boolean =>
  line.type === "assistant" && (line.parent_tool_use_id ?? null) === null && line.message.content.some((block) => isToolUse(block) && !isWaitTool(block.name))

/** A subagent's end, as the wait records it: how it ended. */
export type SubagentEnd = "completed" | "failed" | "stopped"

/**
 * How a subagent's lifecycle line says it ended: a `task_notification`'s status or a `task_updated`'s new one, when it
 * is terminal. Progress, a start and anything else is null.
 */
export const subagentEnd = (line: TaskLine): SubagentEnd | null => {
  const raw = line.subtype === "task_notification" ? line.status : line.subtype === "task_updated" ? line.patch?.status : null
  if (raw === "completed" || raw === "success") return "completed"
  if (raw === "failed" || raw === "error") return "failed"
  if (raw === "killed" || raw === "stopped" || raw === "cancelled" || raw === "interrupted") return "stopped"
  return null
}

export interface RunWaitsShape {
  /**
   * What a line of the run's output says about its wait: activity of its own thread ends it, a subagent's end is
   * recorded on it, a turn's end (`result`) ends it. Database statements and an event, for the line's transaction.
   */
  readonly line: (run: Run, line: ClaudeLine) => Effect.Effect<void>
  /** Run `run` of `task` carried on with other work, or its turn or the run ended: its wait is over (a later run's isn't). */
  readonly over: (task: TaskId, run: RunId) => Effect.Effect<void>
}

export class RunWaits extends Context.Service<RunWaits, RunWaitsShape>()("huntaway-server/runs/RunWaits") {
  static readonly layer = Layer.effect(
    RunWaits,
    Effect.gen(function* () {
      const { tx } = yield* Db
      const tasks = yield* TaskRepo
      const events = yield* Events
      const readers = yield* ThreadReaders

      const publish = Effect.fnUntraced(function* (task: TaskId) {
        const now = yield* tasks.get(task)
        if (now !== null) yield* events.emit({ type: "task", task: now })
      })

      const over = Effect.fn("RunWaits.over")(function* (task: TaskId, run: RunId) {
        yield* tx(
          Effect.gen(function* () {
            const now = yield* tasks.get(task)
            if (now?.agent_wait?.run_id !== run) return
            yield* tasks.write(task, { agent_wait: null }, yield* nowTimestamp)
            yield* publish(task)
          }),
        )
      })

      /** One read and one write with nothing in between: another call can end the wait or start a new one meanwhile. */
      const subagentFinished = Effect.fnUntraced(function* (run: Run, line: TaskLine, status: SubagentEnd) {
        yield* tx(
          Effect.gen(function* () {
            const now = yield* tasks.get(run.task_id)
            const wait = now?.agent_wait
            if (wait === null || wait === undefined || wait.run_id !== run.id || wait.subagent_finished !== undefined) return
            // A background shell's or an internal agent's end isn't a subagent's.
            const call = yield* readers.subagentCall(run.task_id, {
              tool_use_id: line.tool_use_id ?? undefined,
              task_id: line.task_id ?? undefined,
            })
            if (call === null) return
            const finished = { status, summary: line.summary ?? null, task_id: line.task_id ?? null, tool_use_id: call }
            yield* tasks.write(run.task_id, { agent_wait: { ...wait, subagent_finished: finished } }, yield* nowTimestamp)
            yield* publish(run.task_id)
          }),
        )
      })

      const onLine = Effect.fn("RunWaits.line")(function* (run: Run, line: ClaudeLine) {
        if (line.type === "result" || isActivity(line)) yield* over(run.task_id, run.id)
        else if (line.type === "system" && (line.subtype === "task_notification" || line.subtype === "task_updated")) {
          const status = subagentEnd(line)
          if (status !== null) yield* subagentFinished(run, line, status)
        }
      })

      return RunWaits.of({ line: onLine, over })
    }),
  )
}
