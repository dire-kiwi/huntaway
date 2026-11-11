import { Cause, Effect, Exit, Layer, Option, Ref, Result, Schema } from "effect"
import type { NewEvent, RunId, TaskId } from "@huntaway/contracts"
import { SavedEvent } from "@huntaway/contracts"
import { INIT_PREFIX } from "../../agents/claude/launch.ts"
import { ContextMeter } from "../../agents/ContextMeter.ts"
import { Usage } from "../../profiles/Usage.ts"
import { decodeLine } from "../../agents/claude/lines.ts"
import type { ClaudeLine, ResultLine } from "../../agents/claude/lines.ts"
import { emptyState, isForeignResult, observe, stateFromItems, translate, turnCost } from "../../agents/claude/translate.ts"
import type { LineEffect, Translated, TranslatorState } from "../../agents/claude/translate.ts"
import { nowTimestamp, toJson } from "../../platform/columns.ts"
import { Db } from "../../platform/Db.ts"
import { Events } from "../../platform/Events.ts"
import { TaskRepo } from "../../tasks/TaskRepo.ts"
import { Threads } from "../../threads/Threads.ts"
import { ThreadStore } from "../../threads/ThreadStore.ts"
import { AgentRequests } from "../AgentRequests.ts"
import type { Run } from "../Run.ts"
import { RunDir } from "../RunDir.ts"
import { RunInput } from "../RunInput.ts"
import { RunOutput } from "../RunOutput.ts"
import { RunRepo } from "../RunRepo.ts"

// A Claude run's output, line by line (docs/plan/07-agents.md, Following; inventory 01, sections 5 and 9; huntaway's
// runner/output.ts `handle_line`): each line is decoded (`decodeLine`; a problem is logged and skipped), translated
// with the thread's translator state into thread events (`translate`), and written with what it tells the run (its
// session, cost, turns, steers taken in, `agent_at`) **in one transaction with the run's offset at the end of the
// line**, so a line read again after a crash adds nothing twice. What follows outside the database comes after the
// commit: the reply being written (never stored), the `awaited` file, the agent's requests (`AgentRequests`) and the end
// of a turn (`RunInput.turnEnded`, which closes the input), the last even if recording the turn failed: its line is
// not read again, and an input left open would keep the agent waiting for good.
//
// The translator's state is kept per thread while a run of it is followed, with the thread's `seq` it has seen; what
// others wrote to the thread meanwhile (the board's messages, prompts) is taken in from the thread's log before each
// line (`observe`), and a run followed afresh (a new run, a restart) rebuilds it from the stored items.

/** A thread's translator state, as of `seq`, for the run being followed; and the prompt whose echo the run waits for. */
interface Kept {
  readonly run: RunId
  readonly state: TranslatorState
  readonly seq: number
  readonly awaited: string | null
}

/** What a line leaves to do after its transaction commits. */
interface After {
  readonly kept: Kept
  /** The prompt the run waited for before the line. */
  readonly awaitedBefore: string | null
  readonly effects: ReadonlyArray<LineEffect>
  readonly turnEnded: boolean
  /** What the turn the line ended cost (`RunRepo.addCost`). */
  readonly cost: number
}

/** The lines whose items take the board's write number (`legacy:<n>…` ids): the others make no items. */
const numbered = (line: ClaudeLine): boolean =>
  line.type === "assistant" ||
  line.type === "user" ||
  line.type === "result" ||
  (line.type === "system" && line.subtype !== "init" && line.subtype !== "background_tasks_changed")

/** The prompt ids a line says Claude Code has taken in (`user_message_uuids`, on any frame of the turn). */
const UserMessageUuids = Schema.fromJsonString(Schema.Struct({ user_message_uuids: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Unknown))) }))
const decodeUuids = Schema.decodeUnknownOption(UserMessageUuids)

const isSaved = Schema.is(SavedEvent)

/** Whether the line says Claude Code took in the message `id`: its echo, or a frame naming it. */
const echoes = (line: ClaudeLine, raw: string, id: string): boolean => {
  if (line.type === "user" && line.isReplay === true && line.uuid === id) return true
  const uuids = Option.getOrUndefined(decodeUuids(raw))?.user_message_uuids
  return Array.isArray(uuids) && uuids.includes(id)
}

/**
 * Whether Claude Code's result ends a conversation this run started that the model never answered (the old
 * `never_answered`): it failed before reaching the API (not logged in, say), with nothing spent, and wasn't stopped.
 * Kept, it would be resumed by the next run, which is started again from the task's description instead.
 */
const neverAnswered = (line: ResultLine): boolean =>
  line.is_error === true && typeof line.session_id === "string" && line.duration_api_ms === 0 && (line.total_cost_usd ?? 0) === 0

export const ClaudeOutput = Layer.effect(
  RunOutput,
  Effect.gen(function* () {
    const db = yield* Db
    const threads = yield* Threads
    const store = yield* ThreadStore
    const repo = yield* RunRepo
    const dir = yield* RunDir
    const tasks = yield* TaskRepo
    const events = yield* Events
    const input = yield* RunInput
    const requests = yield* AgentRequests
    const meter = yield* ContextMeter
    const usage = yield* Usage
    const kept = yield* Ref.make<ReadonlyMap<TaskId, Kept>>(new Map())

    /** The thread's state as stored, for a run followed afresh. */
    const rebuild = Effect.fnUntraced(function* (run: Run) {
      const stored = yield* threads.stored(run.task_id).pipe(Effect.orElseSucceed(() => ({ entries: [], requests: [], seq: 0 })))
      const metas = new Map(stored.entries.map((e) => [e.item.id, e.meta] as const))
      const state =
        stored.entries.length === 0 && stored.requests.length === 0
          ? emptyState
          : stateFromItems(
              stored.entries.map((e) => e.item),
              stored.requests,
              (id) => metas.get(id),
            )
      const fresh: Kept = { run: run.id, state, seq: stored.seq, awaited: yield* dir.awaited(run.id) }
      return fresh
    })

    /** The state for `run`'s line, with what others wrote to the thread since taken in. In the line's transaction. */
    const current = Effect.fnUntraced(function* (run: Run) {
      const had = (yield* Ref.get(kept)).get(run.task_id)
      const base = had !== undefined && had.run === run.id ? had : yield* rebuild(run)
      const seq = yield* store.seq(run.task_id)
      if (seq === base.seq) return base
      const since = yield* store.eventsAfter(run.task_id, base.seq)
      // The log no longer reaches back that far: what is stored is the truth.
      if (since === null) return { ...(yield* rebuild(run)), awaited: base.awaited }
      const seen: Array<NewEvent> = since.filter(isSaved)
      return { ...base, state: observe(base.state, seen), seq }
    })

    /** The task's columns a line changed, published. */
    const writeTask = Effect.fnUntraced(function* (task: TaskId, columns: Parameters<typeof tasks.write>[1]) {
      yield* tasks.write(task, columns, yield* nowTimestamp)
      const after = yield* tasks.get(task)
      if (after !== null) yield* events.emit({ type: "task", task: after })
    })

    /** A turn's end, recorded (the old `claude_result` and `record_turn_end`, but for closing the input). */
    const recordTurn = Effect.fnUntraced(function* (run: Run, line: ResultLine, error: string | null, cost: number, stop: Run["stop"]) {
      const task = yield* tasks.get(run.task_id)
      if (task === null) return
      // Only a task's (its next run starts again from its description), not after a stop (it keeps its session to
      // resume), only the session's first run, and not after an earlier turn of this run that cost something.
      let dud = false
      if (neverAnswered(line) && task.kind === "task" && stop === "none" && typeof line.session_id === "string") {
        const first = yield* repo.sessionStartedBy(run.task_id, line.session_id)
        const row = yield* repo.get(run.id)
        dud = Option.getOrUndefined(first) === run.id && Option.isSome(row) && row.value.cost_usd - cost === 0
      }
      if (dud) yield* Effect.logInfo(`task=${run.task_id} run=${run.id} session ${line.session_id} was never answered, so the next run starts a new one`)
      const session = dud ? null : typeof line.session_id === "string" ? line.session_id : task.session_id
      yield* writeTask(run.task_id, { cost_usd: task.cost_usd + cost, session_id: session })
      // The turn a stop interrupted: from here, a message it takes in starts a new one.
      yield* repo.update(run.id, { stop: stop === "requested" ? "interrupted" : undefined, saw_result: true, between_turns: true, result_error: error })
      // Checkpoints (4.x), waits (3.5), documents (6.2), memory (6.7), the context meter (2.8) hear of the turn's end here.
    })

    /** What a line tells the run, in its transaction. */
    const apply = Effect.fnUntraced(function* (run: Run, line: ClaudeLine, effects: ReadonlyArray<LineEffect>, cost: number, stop: Run["stop"]) {
      let ended = false
      for (const effect of effects) {
        switch (effect._tag) {
          case "SessionStarted": {
            const task = yield* tasks.get(run.task_id)
            if (task !== null && task.session_id !== effect.sessionId) yield* writeTask(run.task_id, { session_id: effect.sessionId })
            yield* repo.update(run.id, { session_id: effect.sessionId })
            break
          }
          case "TurnStarted":
            // A turn starting, unless it's the one a message sent to the agent starts (it's echoed then).
            if (effect.from !== "init" || (yield* tasks.steers(run.task_id, run.id)).length === 0) yield* input.turnStarted(run.id)
            break
          case "TurnEnded":
            if (line.type === "result") yield* recordTurn(run, line, effect.error, cost, stop)
            // usageLimit: the config is out of usage (`Usage.ranOut`, plan task 2.x usage limits).
            ended = true
            break
          case "Echoed":
            // A background task's notification taken in (`taskNotification`) is 2.8's (`BackgroundWork.tookIn`).
            if (effect.uuid !== null) yield* input.steered(run, effect.uuid)
            break
          case "AgentAt":
            yield* repo.update(run.id, { agent_at: effect.uuid })
            break
          // The reply being written is published after the commit; rate limits are `Usage`'s and compactions the
          // context meter's (plan task 2.8).
          case "PreviewReset":
          case "PreviewText":
          case "RateLimit":
          case "Compacted":
            break
        }
      }
      return ended
    })

    /** Claude Code refused the `initialize` that gives it the board's tools: the agent goes on without them. */
    const initRefused = Effect.fnUntraced(function* (run: Run, line: Extract<ClaudeLine, { readonly type: "control_response" }>) {
      const id = line.response.request_id
      if (id === undefined || !id.startsWith(INIT_PREFIX) || line.response.subtype === "success") return
      const error = line.response.error
      const why = typeof error === "string" && error !== "" ? error : "no reason given"
      yield* Effect.logWarning(`task=${run.task_id} run=${run.id} Claude Code refused the board's tools: ${why}`)
      yield* threads
        .notice(run.task_id, "warning", `Claude Code didn't take the board's tools (${why}), so this run goes on without them.`)
        .pipe(Effect.catchTag("TaskNotFound", () => Effect.void))
      // Background stops (`bgstop-`) and context reads (`context-`) are answered here too (plan task 2.8).
    })

    /** The line's transaction: its events, what it tells the run, and the offset after it. */
    const record = (run: Run, line: ClaudeLine, raw: string, end: number) =>
      db.tx(
        Effect.gen(function* () {
          const row = yield* repo.get(run.id)
          // A run that has ended (or is gone with its task) is not written to.
          if (Option.isNone(row) || !row.value.isLive) {
            yield* repo.saveOffset(run.id, end)
            return null
          }
          const now = row.value
          const before = yield* current(run)
          // Claude Code has taken in the run's prompt: from here, its results end the run's turns.
          const awaited = before.awaited !== null && echoes(line, raw, before.awaited) ? null : before.awaited
          if (line.type === "result" && isForeignResult(line, { sawResult: now.saw_result, awaiting: awaited !== null })) {
            yield* Effect.logInfo(`run=${run.id} a result of another turn than its prompt's, before it took the prompt in`)
            yield* repo.saveOffset(run.id, end)
            const skipped: After = { kept: { ...before, awaited }, awaitedBefore: before.awaited, effects: [], turnEnded: false, cost: 0 }
            return skipped
          }
          const at = yield* nowTimestamp
          // A running total for the session, which goes on over its turns and the runs that resume it.
          const total = line.type === "result" ? turnCost(line) : null
          const cost = total === null ? 0 : yield* repo.addCost(run.id, total.session, total.total, total.counted)
          const turn = { cost, stopping: now.stop === "requested", compact: run.kind === "compact" }
          let made: Translated
          let seq = before.seq
          if (numbered(line)) {
            let translated: Translated | null = null
            const written = yield* threads
              .writeFromAgent(run.task_id, (writeNo) => {
                translated = translate(before.state, line, { writeNo, at, turn })
                return { events: translated.events, metas: translated.metas }
              })
              .pipe(Effect.orDie)
            if (translated === null) return yield* Effect.die(`run=${run.id} the line was not translated`)
            made = translated
            seq = written.saved.at(-1)?.seq ?? seq
          } else made = translate(before.state, line, { writeNo: 0, at, turn })
          for (const warning of made.warnings) yield* Effect.logWarning(`run=${run.id} ${warning.code}: ${warning.text}`)
          const turnEnded = yield* apply(run, line, made.effects, cost, now.stop)
          if (line.type === "control_response") yield* initRefused(run, line)
          yield* repo.saveOffset(run.id, end)
          const after: After = { kept: { run: run.id, state: made.state, seq, awaited }, awaitedBefore: before.awaited, effects: made.effects, turnEnded, cost }
          return after
        }),
      )

    /** The config the run's task runs on, if it has one. */
    const configOf = Effect.fnUntraced(function* (run: Run) {
      const task = yield* tasks.get(run.task_id)
      return task?.claude_config_id ?? null
    })

    const rateLimit = Effect.fnUntraced(function* (run: Run, info: unknown) {
      const config = yield* configOf(run)
      if (config !== null) yield* usage.onRateLimit(config, info)
    })

    /** The run's config is out of usage: the task notes when it resets (the old `usage::ran_out`). */
    const ranOut = Effect.fnUntraced(function* (run: Run) {
      const config = yield* configOf(run)
      if (config === null) return
      const until = yield* usage.outUntil(config)
      if (until !== null) yield* db.tx(writeTask(run.task_id, { limit_reset_at: until }))
    })

    /** What follows the line's commit. */
    const follow = Effect.fnUntraced(function* (run: Run, line: ClaudeLine, done: After) {
      yield* Ref.update(kept, (all) => new Map([...all, [run.task_id, done.kept]]))
      if (done.awaitedBefore !== null && done.kept.awaited === null) {
        yield* dir.setAwaited(run.id, null).pipe(Effect.catch((e) => Effect.logWarning(`run=${run.id} forgetting its awaited prompt: ${e.reason}`)))
      }
      for (const effect of done.effects) {
        if (effect._tag === "PreviewReset") yield* threads.endPreview(run.task_id)
        else if (effect._tag === "PreviewText") yield* threads.preview(run.task_id, effect.text)
        // How much of a usage window is left: the config's usage (a `rate_limit_event`, or a turn refused for it).
        else if (effect._tag === "RateLimit") yield* rateLimit(run, line.type === "rate_limit_event" ? line : effect.info)
        else if (effect._tag === "Compacted") yield* meter.onCompacted(run, effect.metadata)
      }
      // The context meter: each request's context, and the breakdown asked for at a turn's end (before the input closes).
      if (line.type === "assistant") yield* meter.onAssistant(run, line)
      if (line.type === "control_response") yield* meter.onControlResponse(run.task_id, line)
      if (line.type === "result" && done.turnEnded) {
        yield* meter.onResult(run.task_id, line)
        const ask = yield* meter.requestLine
        yield* dir.appendInput(run.id, ask).pipe(Effect.catch((e) => Effect.logWarning(`run=${run.id} asking for its context: ${e.reason}`)))
        yield* meter.recordTurn(run, done.cost)
        // Refused for the usage limit: the config is out until it resets, which the run's end reads.
        if (line.api_error === "usage_limit_reached") yield* ranOut(run)
      }
      if (line.type === "control_request") yield* requests.handle(run, line)
      else if (line.type === "control_cancel_request") yield* requests.cancel(run, line.request_id)
    })

    const handle = Effect.fnUntraced(function* (run: Run, raw: string, end: number) {
      const decoded = decodeLine(raw)
      if (Result.isFailure(decoded)) {
        const problem = decoded.failure
        if (problem._tag === "Malformed" || problem._tag === "Unknown" || problem._tag === "NotJson") {
          yield* Effect.logWarning(`run=${run.id} skipping a line of its output: ${problem._tag}${"type" in problem ? ` ${yield* toJson(problem.type)}` : ""}`)
        }
        return yield* repo.saveOffset(run.id, end)
      }
      const line = decoded.success
      const exit = yield* Effect.exit(record(run, line, raw, end))
      if (Exit.isSuccess(exit)) {
        if (exit.value !== null) yield* follow(run, line, exit.value)
        return yield* exit.value?.turnEnded === true ? input.turnEnded(run) : Effect.void
      }
      // Recording it failed: a turn's end still closes the input (the line isn't read again), and the state from
      // before the line stays.
      if (line.type === "result") yield* input.turnEnded(run)
      return yield* Effect.failCause(exit.cause)
    })

    return RunOutput.of({
      handle: (run, line, end) =>
        handle(run, line, end).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) => Effect.logError(`run=${run.id} handling a line of output failed`, cause).pipe(Effect.andThen(repo.saveOffset(run.id, end))),
          ),
          Effect.asVoid,
          Effect.annotateLogs({ module: "runs" }),
        ),
    })
  }),
)
