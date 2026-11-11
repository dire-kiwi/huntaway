import { Context, Effect, Layer, Option } from "effect"
import type { RunId, TaskId } from "@huntaway/contracts"
import type { AssistantLine, TaskLine } from "../agents/claude/lines.ts"
import { nowTimestamp, toJson } from "../platform/columns.ts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import type { LostBackground } from "../tasks/TaskRepo.ts"
import { addKilled, kindOf, labelOf, lostAtEnd, NOTE_ITEMS, parseBackground, parseCalls, parseEnded, parseIds, parseKilled, workOf } from "./background.ts"
import type { BackgroundEnded, BackgroundTask } from "./background.ts"
import type { Run } from "./Run.ts"
import { RunDir } from "./RunDir.ts"
import type { RunFile } from "./RunDir.ts"
import { RunRepo } from "./RunRepo.ts"

// What a run's agent has going in the background (HA-405; inventory 01, section 2 "Background work and dev servers";
// huntaway's runner/background.ts and runs/background.ts): the run's `background*` files, kept through `RunDir` so a
// restarted server reads them again, and the task's `background_work` column, which shows a run whose turn has ended
// with only shells it doesn't wait on as idle rather than working. What it means for the run's input (HA-187, the
// graces) is `RunInput`'s; the end of a run tells the agent's next prompt what it stopped (`lost_background`).

export interface BackgroundWorkShape {
  /** The run's background tasks, as Claude Code last listed them. */
  readonly tasks: (run: RunId) => Effect.Effect<ReadonlyArray<BackgroundTask>>
  readonly setTasks: (run: RunId, tasks: ReadonlyArray<BackgroundTask>) => Effect.Effect<void>
  /** The ids of the shells the agent said it waits on (`background_wait`, which writes `background-waited`). */
  readonly waited: (run: RunId) => Effect.Effect<ReadonlyArray<string>>
  /** What the board stopped of them (`background-killed`). */
  readonly killed: (run: RunId) => Effect.Effect<ReadonlyArray<BackgroundTask>>
  readonly addKilled: (run: RunId, tasks: ReadonlyArray<BackgroundTask>) => Effect.Effect<void>
  /** Keep what it has going as stopped by the board: the run is being stopped. */
  readonly keepKilled: (run: RunId) => Effect.Effect<void>
  /** What ended during the agent's turn, for a turn on their outcome (`background-ended`); null for none. */
  readonly ended: (run: RunId) => Effect.Effect<BackgroundEnded | null>
  readonly setEnded: (run: RunId, ended: BackgroundEnded | null) => Effect.Effect<void>
  /** An assistant message: the calls in it that may start a background shell, kept until Claude Code says which. */
  readonly onAssistant: (run: Run, line: AssistantLine) => Effect.Effect<void>
  /** Claude Code started a background shell (`task_started`): what started it, and its command. */
  readonly started: (run: Run, line: TaskLine) => Effect.Effect<void>
  /** Show the run's background work on its task, if it changed and the run is the task's latest. */
  readonly sync: (run: RunId) => Effect.Effect<void>
  /**
   * The run ended: what it had going stopped with it, and the agent's next prompt says so (`lost_background`, the latest
   * ten); its task no longer shows it. Not for a compaction's.
   */
  readonly runEnded: (run: Run) => Effect.Effect<void>
  /** What the task's agent hasn't been told of what its last runs' ends stopped, taken: it is told now (or never). */
  readonly takeLost: (task: TaskId) => Effect.Effect<ReadonlyArray<LostBackground>>
}

export class BackgroundWork extends Context.Service<BackgroundWork, BackgroundWorkShape>()("huntaway-server/runs/BackgroundWork") {
  static readonly layer = Layer.effect(
    BackgroundWork,
    Effect.gen(function* () {
      const db = yield* Db
      const dir = yield* RunDir
      const runs = yield* RunRepo
      const tasks = yield* TaskRepo
      const events = yield* Events

      const read = (run: RunId, name: RunFile) => dir.readFile(run, name)
      const write = (run: RunId, name: RunFile, text: string | null) =>
        dir.writeFile(run, name, text).pipe(Effect.catch((e) => Effect.logError(`run=${run} writing ${name}: ${e.reason}`)))
      const writeJson = (run: RunId, name: RunFile, value: unknown, empty: boolean) =>
        Effect.flatMap(empty ? Effect.succeed(null) : toJson(value), (text) => write(run, name, text))

      const list = (run: RunId) => Effect.map(read(run, "background"), parseBackground)
      const waited = (run: RunId) => Effect.map(read(run, "background-waited"), parseIds)
      const killed = (run: RunId) => Effect.map(read(run, "background-killed"), parseKilled)
      const setTasks = (run: RunId, all: ReadonlyArray<BackgroundTask>) =>
        Effect.flatMap(all.length === 0 ? Effect.succeed(null) : Effect.map(toJson(all), (t) => `${t}\n`), (text) => write(run, "background", text))
      const addKilledTo = Effect.fnUntraced(function* (run: RunId, more: ReadonlyArray<BackgroundTask>) {
        const before = yield* killed(run)
        const after = addKilled(before, more)
        if (after.length !== before.length) yield* writeJson(run, "background-killed", after, false)
      })

      const sync = Effect.fnUntraced(function* (id: RunId) {
        const found = yield* runs.get(id)
        if (Option.isNone(found)) return
        const run = found.value
        const latest = yield* runs.latest(run.task_id)
        if (Option.isNone(latest) || latest.value.id !== id) return
        const sent = (yield* tasks.steers(run.task_id, id)).length > 0
        const work = run.isLive ? workOf(id, yield* list(id), yield* waited(id), { betweenTurns: run.between_turns, live: run.isLive, sent }) : null
        yield* db.tx(
          Effect.gen(function* () {
            const task = yield* tasks.get(run.task_id)
            if (task === null || (yield* toJson(task.background_work)) === (yield* toJson(work))) return
            yield* tasks.write(task.id, { background_work: work }, yield* nowTimestamp)
            const after = yield* tasks.get(task.id)
            if (after !== null) yield* events.emit({ type: "task", task: after })
          }),
        )
      })

      const onAssistant = Effect.fnUntraced(function* (run: Run, line: AssistantLine) {
        if ((line.parent_tool_use_id ?? null) !== null) return
        const calls = line.message.content.flatMap((b) => {
          if (b.type !== "tool_use" || !("name" in b) || !("id" in b) || typeof b.id !== "string") return []
          const input: unknown = "input" in b ? b.input : undefined
          const background = typeof input === "object" && input !== null && "run_in_background" in input && input.run_in_background === true
          if (!((b.name === "Bash" && background) || b.name === "Monitor")) return []
          const command = typeof input === "object" && input !== null && "command" in input && typeof input.command === "string" ? input.command : null
          return [[b.id, { tool: b.name, command }] as const]
        })
        if (calls.length === 0) return
        const kept = { ...parseCalls(yield* read(run.id, "background-calls")), ...Object.fromEntries(calls) }
        // The latest few: a call's task starts as it's made.
        yield* writeJson(run.id, "background-calls", Object.fromEntries(Object.entries(kept).slice(-20)), false)
      })

      const started = Effect.fnUntraced(function* (run: Run, line: TaskLine) {
        if (line.subtype !== "task_started" || line.task_type !== "local_bash" || typeof line.task_id !== "string" || typeof line.tool_use_id !== "string")
          return
        const call = parseCalls(yield* read(run.id, "background-calls"))[line.tool_use_id]
        if (call === undefined) return
        const all = yield* list(run.id)
        if (!all.some((t) => t.id === line.task_id)) return
        yield* setTasks(
          run.id,
          all.map((t): BackgroundTask =>
            t.id === line.task_id ? { id: t.id, type: t.type, description: t.description, since: t.since, command: call.command, tool: call.tool } : t,
          ),
        )
        yield* sync(run.id)
      })

      const runEnded = Effect.fn("BackgroundWork.runEnded")(function* (run: Run) {
        const lost = lostAtEnd(yield* killed(run.id), yield* list(run.id))
        yield* db.tx(
          Effect.gen(function* () {
            const task = yield* tasks.get(run.task_id)
            if (task === null) return
            if (lost.length > 0 && run.kind !== "compact") {
              const lines = lost.map((t): LostBackground => ({ kind: kindOf(t), label: labelOf(t) }))
              yield* tasks.setLostBackground(task.id, [...(yield* tasks.lostBackground(task.id)), ...lines].slice(-NOTE_ITEMS))
            }
            if (task.background_work?.run_id !== run.id) return
            yield* tasks.write(task.id, { background_work: null }, yield* nowTimestamp)
            const after = yield* tasks.get(task.id)
            if (after !== null) yield* events.emit({ type: "task", task: after })
          }),
        )
      })

      return BackgroundWork.of({
        tasks: list,
        setTasks,
        waited,
        killed,
        addKilled: addKilledTo,
        keepKilled: (run) => Effect.flatMap(list(run), (all) => addKilledTo(run, all)),
        ended: (run) => Effect.map(read(run, "background-ended"), parseEnded),
        setEnded: (run, ended) => writeJson(run, "background-ended", ended, ended === null),
        onAssistant,
        started,
        sync,
        runEnded,
        takeLost: (task) =>
          db.tx(
            Effect.gen(function* () {
              const lost = yield* tasks.lostBackground(task)
              if (lost.length > 0) yield* tasks.setLostBackground(task, [])
              return lost
            }),
          ),
      })
    }),
  )
}
