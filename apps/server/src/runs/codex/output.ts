import { Cause, Effect, Exit, Layer, MutableHashMap, Option, Result, Schema } from "effect"
import type { NewEvent, RunId, TaskId } from "@huntaway/contracts"
import { SavedEvent } from "@huntaway/contracts"
import { decodeLine } from "../../agents/codex/lines.ts"
import type { CodexLine, LineProblem } from "../../agents/codex/lines.ts"
import { planType, rateLimits } from "../../agents/codex/queries.ts"
import { requestId } from "../../agents/codex/requests.ts"
import { emptyState, numbered, observe, stateFromItems, translate } from "../../agents/codex/translate.ts"
import type { CodexEffect, CodexLineContext, CodexState, Translated } from "../../agents/codex/translate.ts"
import { ContextMeter } from "../../agents/ContextMeter.ts"
import { nowTimestamp, toJson } from "../../platform/columns.ts"
import { Checkpoints } from "../../git/Checkpoints.ts"
import { Db } from "../../platform/Db.ts"
import { Events } from "../../platform/Events.ts"
import { Usage } from "../../profiles/Usage.ts"
import { TaskRepo } from "../../tasks/TaskRepo.ts"
import { Threads } from "../../threads/Threads.ts"
import { ThreadStore } from "../../threads/ThreadStore.ts"
import { AgentRequests } from "../AgentRequests.ts"
import type { Run } from "../Run.ts"
import { RunDir } from "../RunDir.ts"
import { RunInput } from "../RunInput.ts"
import { RunOutput } from "../RunOutput.ts"
import type { RunOutputShape } from "../RunOutput.ts"
import { RunRepo } from "../RunRepo.ts"
import { RunWaits } from "../RunWaits.ts"
import { TurnHooks } from "../TurnHooks.ts"

// A Codex run's output, line by line (docs/plan/07-agents.md, Following; inventory 01, section 5 "Codex"; huntaway's
// agent/codex/output.ts `handle_line` and driver.ts `handle`): the adapter writes the app-server's notifications, its
// requests (with their item), `serverRequest/resolved`, its own `huntaway/model` and `huntaway/boardTools`, and echoes
// of the messages the model took in. A request goes to `AgentRequests` (approvals and questions to `Permissions`, the
// board's tools to the dynamic-tools transport), a resolution cancels it there. A notification is translated with the
// thread's translator state (`agents/codex/translate.ts`) into thread events, written with what it tells the run (its
// session, turns, steers taken in, `agent_at`) **in one transaction with the run's offset at the end of the line**, as a
// Claude line is; what follows outside the database (the reply being written, rate limits, the context meter, a
// subagent's end for the wait, the end of a turn closing the input) comes after the commit. A turn's end closes the input
// even if recording it failed: its line is not read again.
//
// The translator's state is kept per thread while a run of it is followed, with the thread's `seq` it has seen; what
// others wrote to the thread meanwhile is taken in from the thread's log before each line, and a run followed afresh
// rebuilds it from the stored items.

/** A thread's translator state, as of `seq`, for the run being followed. */
interface Kept {
  readonly run: RunId
  readonly state: CodexState
  readonly seq: number
}

/** What a line leaves to do after its transaction commits. */
interface After {
  readonly kept: Kept
  readonly effects: ReadonlyArray<CodexEffect>
  readonly turnEnded: boolean
}

const isSaved = Schema.is(SavedEvent)

/** The subagent statuses that end it, for the wait. */
const ended = (status: string): "completed" | "failed" | "stopped" | null =>
  status === "completed" || status === "failed" || status === "stopped" ? status : null

/** A Codex run's line handler: what `CodexOutput` routes a Codex run's lines to. */
export const makeCodexOutput = Effect.gen(function* () {
  const db = yield* Db
  const threads = yield* Threads
  const store = yield* ThreadStore
  const repo = yield* RunRepo
  const tasks = yield* TaskRepo
  const events = yield* Events
  const input = yield* RunInput
  const requests = yield* AgentRequests
  const meter = yield* ContextMeter
  const usage = yield* Usage
  const waits = yield* RunWaits
  const checkpoints = yield* Checkpoints
  const turnHooks = yield* TurnHooks
  const kept = MutableHashMap.empty<TaskId, Kept>()

  /** The thread's state as stored, for a run followed afresh. */
  const rebuild = Effect.fnUntraced(function* (run: Run) {
    const stored = yield* threads.stored(run.task_id).pipe(Effect.orElseSucceed(() => ({ entries: [], requests: [], seq: 0 })))
    const state = stored.entries.length === 0 ? emptyState : stateFromItems(stored.entries.map((e) => e.item))
    const fresh: Kept = { run: run.id, state, seq: stored.seq }
    return fresh
  })

  /** The state for `run`'s line, with what others wrote to the thread since taken in. In the line's transaction. */
  const current = Effect.fnUntraced(function* (run: Run) {
    const had = Option.getOrUndefined(MutableHashMap.get(kept, run.task_id))
    const base = had !== undefined && had.run === run.id ? had : yield* rebuild(run)
    const seq = yield* store.seq(run.task_id)
    if (seq === base.seq) return base
    const since = yield* store.eventsAfter(run.task_id, base.seq)
    // The log no longer reaches back that far: what is stored is the truth.
    if (since === null) return yield* rebuild(run)
    const seen: Array<NewEvent> = since.filter(isSaved)
    return { ...base, state: observe(base.state, seen), seq }
  })

  /** The task's columns a line changed, published. */
  const writeTask = Effect.fnUntraced(function* (task: TaskId, columns: Parameters<typeof tasks.write>[1]) {
    yield* tasks.write(task, columns, yield* nowTimestamp)
    const after = yield* tasks.get(task)
    if (after !== null) yield* events.emit({ type: "task", task: after })
  })

  /** What a line tells the run, in its transaction, given its row as the line found it; the `agent_at` to save with the offset. */
  const apply = Effect.fnUntraced(function* (run: Run, effects: ReadonlyArray<CodexEffect>, now: Run) {
    let agentAt: string | undefined
    let turnEnded = false
    for (const effect of effects) {
      switch (effect._tag) {
        case "SessionStarted": {
          // The run that started the thread, which says where it's kept.
          const task = yield* tasks.get(run.task_id)
          if (task !== null && task.session_id !== effect.sessionId) yield* writeTask(run.task_id, { session_id: effect.sessionId })
          yield* repo.update(run.id, { session_id: effect.sessionId })
          break
        }
        case "TurnStarted":
          // Where a rewind to before this turn takes the thread back to.
          agentAt = effect.turnId
          break
        case "TurnEnded": {
          // A checkpoint of what the turn left (4.3), taken in the background once this commits, with the message the
          // turn started with, which goes (as the Claude line handler does). Documents (6.2) follow the commit; memory (6.7) here.
          const atEnd = Option.getOrElse(yield* repo.get(run.id), () => now)
          const status = now.stop === "requested" ? "stopped" : effect.error !== null ? "failed" : "done"
          yield* db.sql.afterCommit(checkpoints.afterTurn(atEnd, status))
          // The turn a stop interrupted: from here, a message it takes in starts a new one.
          yield* repo.update(run.id, {
            write_no: null,
            stop: now.stop === "requested" ? "interrupted" : undefined,
            saw_result: true,
            between_turns: true,
            result_error: effect.error,
          })
          // A turn that ended isn't waiting any more, even if the agent gave up on the call.
          yield* waits.over(run.task_id, run.id)
          turnEnded = true
          break
        }
        case "Echoed":
          yield* input.steered(run, effect.uuid)
          break
        case "Working":
          // A tool call of its own thread means it's working again.
          yield* waits.over(run.task_id, run.id)
          break
        case "Notice":
          yield* threads
            .notice(run.task_id, "warning", effect.text, ...(effect.detail === null ? [] : [effect.detail]))
            .pipe(Effect.catchTag("TaskNotFound", () => Effect.void))
          break
        case "BoardToolsRefused":
          // Its session's later runs have the board's MCP server too.
          yield* repo.update(run.id, { board_tools: false })
          break
        // After the commit.
        case "PreviewReset":
        case "PreviewText":
        case "SubagentEnded":
        case "RateLimits":
        case "TokenUsage":
        case "Compacted":
        case "ToolDone":
          break
      }
    }
    return { agentAt, turnEnded }
  })

  /** A translated line's events and metas, written in the line's transaction (with a write number when it needs one). */
  const write = Effect.fnUntraced(function* (run: Run, line: CodexLine, before: Kept, ctx: Omit<CodexLineContext, "writeNo">) {
    if (numbered(line)) {
      let translated: Translated | null = null
      // The run's row is there, so its task is.
      const written = yield* threads.writeFromRun(run.task_id, (writeNo) => {
        translated = translate(before.state, line, { ...ctx, writeNo })
        return { events: translated.events, metas: translated.metas }
      })
      if (translated === null) return yield* Effect.die(`run=${run.id} the line was not translated`)
      return { made: translated, seq: written.saved.at(-1)?.seq ?? before.seq }
    }
    const made = translate(before.state, line, { ...ctx, writeNo: 0 })
    if (made.events.length === 0) return { made, seq: before.seq }
    const saved = yield* threads.appendFromAgent(run.task_id, made.events, made.metas).pipe(Effect.orElseSucceed(() => []))
    return { made, seq: saved.at(-1)?.seq ?? before.seq }
  })

  /** What a notification writes, in its transaction: its events, what it tells the run, and the offset after it. */
  const record = Effect.fnUntraced(function* (run: Run, line: CodexLine, end: number) {
    const row = yield* repo.get(run.id)
    // A run that has ended (or is gone with its task) is not written to.
    if (Option.isNone(row) || !row.value.isLive) {
      yield* repo.saveOffset(run.id, end)
      return null
    }
    const now = row.value
    const before = yield* current(run)
    const task = yield* tasks.get(run.task_id)
    const ctx = {
      session: task?.session_id ?? null,
      compact: run.kind === "compact",
      at: yield* nowTimestamp,
      stopping: now.stop === "requested",
      sawResult: now.saw_result,
    }
    const { made, seq } = yield* write(run, line, before, ctx)
    for (const warning of made.warnings) yield* Effect.logWarning(`run=${run.id} ${warning.code}: ${warning.text}`)
    const { agentAt, turnEnded } = yield* apply(run, made.effects, now)
    yield* repo.saveOffset(run.id, end, agentAt === undefined ? undefined : { agent_at: agentAt })
    const after: After = { kept: { run: run.id, state: made.state, seq }, effects: made.effects, turnEnded }
    return after
  })

  /** The config the run's task runs on, if it has one. */
  const configOf = Effect.fnUntraced(function* (run: Run) {
    return (yield* tasks.get(run.task_id))?.claude_config_id ?? null
  })

  /** What follows the line's commit. */
  const follow = Effect.fnUntraced(function* (run: Run, done: After) {
    MutableHashMap.set(kept, run.task_id, done.kept)
    for (const effect of done.effects) {
      switch (effect._tag) {
        case "PreviewReset":
          yield* threads.endPreview(run.task_id)
          break
        case "PreviewText":
          yield* threads.preview(run.task_id, effect.text)
          break
        case "RateLimits": {
          const config = yield* configOf(run)
          if (config !== null) yield* usage.setLimits(config, rateLimits(effect.rateLimits), planType(effect.rateLimits))
          break
        }
        case "TokenUsage":
          yield* meter.onCodexUsage(run, effect.params)
          break
        case "Compacted":
          yield* meter.onCompacted(run, { trigger: effect.trigger })
          break
        case "SubagentEnded": {
          const status = ended(effect.status)
          if (status !== null) yield* waits.subagentEnded(run, effect.id, status, effect.summary)
          break
        }
        case "TurnEnded": {
          yield* meter.recordTurn(run, null)
          // 6.2: the task's documents the turn changed are kept, their versions closed.
          yield* turnHooks.turnEnded(run.task_id)
          // Refused for the account's usage limit: the config is out until it resets, which the run's end reads.
          if (effect.usageLimit) {
            const config = yield* configOf(run)
            if (config !== null) {
              yield* usage.codexRefused(config)
              const until = yield* usage.outUntil(config)
              if (until !== null) yield* db.tx(writeTask(run.task_id, { limit_reset_at: until }))
            }
          }
          break
        }
        // A tool call may have changed the task's documents: the task shows them as they're written (6.2).
        case "ToolDone":
          yield* turnHooks.toolDone(run.task_id)
          break
        case "SessionStarted":
        case "TurnStarted":
        case "Echoed":
        case "Working":
        case "Notice":
        case "BoardToolsRefused":
          break
      }
    }
  })

  /** A line that doesn't decode: logged (unless it is one the board ignores) and skipped. */
  const skip = Effect.fnUntraced(function* (run: Run, problem: LineProblem, end: number) {
    if (problem._tag !== "Ignored") {
      yield* Effect.logWarning(`run=${run.id} skipping a line of its output: ${problem._tag}${"method" in problem ? ` ${yield* toJson(problem.method)}` : ""}`)
    }
    return yield* repo.saveOffset(run.id, end)
  })

  const handle = Effect.fnUntraced(function* (run: Run, raw: string, end: number) {
    const decoded = decodeLine(raw)
    if (Result.isFailure(decoded)) return yield* skip(run, decoded.failure, end)
    const line = decoded.success
    switch (line._tag) {
      case "Request":
        // Read again after a restart, it finds the same call (`stdio:<run>:codex:<id>`).
        yield* repo.saveOffset(run.id, end)
        return yield* requests.handleCodex(run, line.request)
      case "Resolved":
        // The app-server no longer wants it answered (the adapter says so only of one the board hasn't answered).
        yield* repo.saveOffset(run.id, end)
        return yield* line.requestId === null ? Effect.void : Effect.flatMap(requestId(line.requestId), (id) => requests.cancel(run, id))
      case "Model":
        // For the board's count of the tokens each model used, which reads `out.jsonl` itself.
        return yield* repo.saveOffset(run.id, end)
      case "Notification":
      case "Echo":
      case "BoardTools":
        break
    }
    const exit = yield* Effect.exit(db.tx(record(run, line, end)))
    if (Exit.isSuccess(exit)) {
      if (exit.value === null) return yield* Effect.void
      yield* follow(run, exit.value)
      return yield* exit.value.turnEnded ? input.turnEnded(run) : Effect.void
    }
    // Recording it failed: a turn's end still closes the input (the line isn't read again), and the state from before
    // the line stays.
    if (line._tag === "Notification" && (line.method === "turn/completed" || line.method === "thread/compacted")) yield* input.turnEnded(run)
    return yield* Effect.failCause(exit.cause)
  })

  const shape: RunOutputShape = {
    handle: (run, line, end) =>
      handle(run, line, end).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => Effect.logError(`run=${run.id} handling a line of output failed`, cause).pipe(Effect.andThen(repo.saveOffset(run.id, end))),
        ),
        Effect.asVoid,
        Effect.annotateLogs({ module: "runs" }),
      ),
    released: (run) =>
      Effect.sync(() => {
        const had = Option.getOrUndefined(MutableHashMap.get(kept, run.task_id))
        if (had !== undefined && had.run === run.id) MutableHashMap.remove(kept, run.task_id)
      }),
  }
  return shape
})

/**
 * The follower's line handler for both agents: a Codex run's lines (its folder has `codex.json`) go to the Codex
 * handler, the others to the `RunOutput` this is built over (the Claude handler, `runs/claude/output.ts`).
 */
export const CodexOutput = Layer.effect(
  RunOutput,
  Effect.gen(function* () {
    const claude = yield* RunOutput
    const codex = yield* makeCodexOutput
    const dir = yield* RunDir
    // Whether each run being followed is Codex's, read from its folder once.
    const codexRuns = MutableHashMap.empty<RunId, boolean>()
    const isCodex = Effect.fnUntraced(function* (run: Run) {
      const known = Option.getOrUndefined(MutableHashMap.get(codexRuns, run.id))
      if (known !== undefined) return known
      const found = yield* dir.isCodex(run.id)
      MutableHashMap.set(codexRuns, run.id, found)
      return found
    })
    const handleChunk = claude.handleChunk
    return RunOutput.of({
      handle: (run, line, end) => Effect.flatMap(isCodex(run), (yes) => (yes ? codex.handle(run, line, end) : claude.handle(run, line, end))),
      ...(handleChunk === undefined
        ? {}
        : {
            handleChunk: (run, lines) =>
              Effect.flatMap(isCodex(run), (yes) =>
                yes ? Effect.forEach(lines, ([line, end]) => codex.handle(run, line, end), { concurrency: 1, discard: true }) : handleChunk(run, lines),
              ),
          }),
      released: (run) =>
        Effect.gen(function* () {
          MutableHashMap.remove(codexRuns, run.id)
          if (codex.released !== undefined) yield* codex.released(run)
          if (claude.released !== undefined) yield* claude.released(run)
        }),
    })
  }),
)
