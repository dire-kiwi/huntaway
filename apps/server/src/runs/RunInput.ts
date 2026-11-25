import { Clock, Context, Effect, Fiber, FiberMap, FileSystem, Layer, Option, Schema } from "effect"
import type { Duration } from "effect"
import { SecureRandom } from "effect/crypto"
import type { RunId, TaskId } from "@huntaway/contracts"
import { interruptLine, userInput } from "../agents/claude/launch.ts"
import { Prompts } from "../agents/Prompts.ts"
import { planRest } from "../agents/prompts/start.ts"
import { Changes } from "../platform/Changes.ts"
import { nowTimestamp, toJson } from "../platform/columns.ts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { fromAgent, TaskRepo } from "../tasks/TaskRepo.ts"
import { Threads } from "../threads/Threads.ts"
import { detachable, kindOf, listed, notTakenIn } from "./background.ts"
import { BackgroundWork } from "./BackgroundWork.ts"
import { shellsListen, SUPPORTED } from "./DevServers.ts"
import { lastingOf } from "./finish.ts"
import { isCompact } from "./queue.ts"
import type { Run } from "./Run.ts"
import { RunDir } from "./RunDir.ts"
import { RunRepo } from "./RunRepo.ts"
import { Shim } from "./Shim.ts"

// What the server writes to a live run's input, and when it closes it (docs/plan/07-agents.md, Following; inventory 01,
// section 9, "Turns, steering, closing the input" and "Stop"; huntaway's runner/queue.ts and runner.ts). A message
// sent while the agent works is a steer: kept as a row (`task_steers`) and written to the input at once (or once the
// run starts), and it goes in the thread only when the agent echoes it, which is when it takes it in. Every run but a
// compaction takes input, so its agent never exits by itself: **the server closes the input, or the run never ends**.
// It does so when a turn ends with nothing waiting; with messages waiting, it gives them `STEER_GRACE` to start the next
// turn. A stop interrupts the turn and gives it `STOP_GRACE` to end before the process is stopped.
//
// A turn that ends with only dev servers left (HA-409) ends its run all the same: Claude Code doesn't exit while it has
// background tasks, so the task would sit in "In progress" with its work done. Once each of them listens on a port, the
// agent is killed outright, which leaves its shells running (they're in sessions of their own), and the run ends as a
// turn's end does: the task moves on to "In review" with its dev server still up, listed as outliving its run.
//
// The timers are fibers here, one of each kind per run (a `FiberMap` keyed by run id: arming one again replaces it),
// each checking the run's row when it fires, so they can be armed again from the row after a restart (`rearm`).

/** How long a stopped agent has to end its turn before its process is stopped. */
export const STOP_GRACE = "10 seconds"
/** How long an agent that ended its turn with messages still waiting has to start the next turn with them. */
export const STEER_GRACE = "30 seconds"
/**
 * How long an agent that asks on its output has, once its background tasks have ended between turns, to start the turn
 * Claude Code takes on their outcome, while it says nothing at all: re-armed while its output grows.
 */
export const BACKGROUND_GRACE = "120 seconds"
/** The same for background tasks that ended during a turn whose outcome Claude Code didn't give the agent in it. */
export const FOLLOW_UP_GRACE = "15 seconds"
/** How long Claude Code has to stop a background shell (`stop_task`) before the run is stopped instead. */
export const BACKGROUND_STOP_GRACE = "10 seconds"
/** How long after a turn ends with only dev servers left the board first looks whether they listen (for Claude Code to write its session out). */
export const DETACH_AFTER = "1500 millis"
/** How often it looks again while one doesn't listen yet (a server slow to start)… */
export const DETACH_RETRY = "5 seconds"
/** …until this long after the turn's end, when it leaves the run be. */
export const DETACH_FOR_MS = 120_000
/** The request id prefix of a `stop_task` the board sends. */
const BACKGROUND_STOP = "bgstop-"

/** Why a background shell can't be stopped. */
export class BackgroundRefused extends Schema.TaggedError<BackgroundRefused, { readonly brand: unique symbol }>()("BackgroundRefused", {
  reason: Schema.String,
}) {}

export interface RunInputShape {
  /**
   * Write the task's steers that are not written yet to their runs' input, in the order they were sent; the first that
   * cannot be written (its run takes no input yet, or any more) stops the rest, to keep the order. The task is
   * published if any was. Returns whether any was.
   */
  readonly writeSteers: (task: TaskId) => Effect.Effect<boolean>
  /**
   * The agent took in (echoed) the message `id`: if it is one of the task's steers, it goes, the user message is added
   * to the thread (`steered`), and the run is in a turn again: no longer between turns, a stop's ended turn is behind
   * it, and the user's message (not another agent's) answers the question the agent asked and undoes its
   * `finish_work`. Database statements only, for the caller's transaction. Returns whether it was a steer.
   */
  readonly steered: (run: Run, id: string) => Effect.Effect<boolean>
  /**
   * The agent is working on a turn of its own: it is no longer between turns. Database only. Returns whether it was
   * between turns (the old `turn_started`'s `changes`), which is when its background work is shown again.
   */
  readonly turnStarted: (run: RunId) => Effect.Effect<boolean>
  /**
   * The agent ended a turn (after its end is recorded, or failed to be). Unless messages are waiting, which start its
   * next turn, its input is closed so that it exits and the run ends; with messages waiting, they get `STEER_GRACE`.
   */
  readonly turnEnded: (run: Run) => Effect.Effect<void>
  /** Ask the agent to end its turn for the stop `stopId`, and stop its process if it hasn't within `STOP_GRACE`. False when it takes no input. */
  readonly interrupt: (run: RunId, stopId: string) => Effect.Effect<boolean>
  /** End the run now: its input closed and its process stopped (SIGTERM, then SIGKILL). False when there was no process to signal. */
  readonly closeAndKill: (run: RunId) => Effect.Effect<boolean>
  readonly closeInput: (run: RunId) => Effect.Effect<void>
  /**
   * Stop the run (its launch over): its row marked stopped, then the turn interrupted with `STOP_GRACE`, or, with
   * `kill`, between turns kept going only by background work, or when it takes no input, its input closed and its
   * process stopped; one that never started ends here (`RunExited`).
   */
  readonly stop: (run: Run, kill: boolean) => Effect.Effect<void>
  /**
   * Claude Code listed the agent's background tasks (`background_tasks_changed`): kept, shown, and with none left
   * between turns, the input closed as at the end of a turn without them (after `BACKGROUND_GRACE` for the turn Claude
   * Code takes on their outcome, for an agent that asks on its output). Those that end during a turn are kept, for
   * `FOLLOW_UP_GRACE` at its end.
   */
  readonly backgroundChanged: (run: Run, listed: ReadonlyArray<unknown>) => Effect.Effect<void>
  /** Claude Code gave the agent the outcome of its background task `id` (its `<task-notification>`). */
  readonly tookIn: (run: Run, id: string) => Effect.Effect<void>
  /**
   * The banner's Stop: stop the agent's background shells (or just `id`) with `stop_task` control requests, leaving
   * the agent be; the run is stopped instead if they can't be asked, or haven't stopped within 10 s. The ids asked.
   */
  readonly stopBackground: (run: Run, id: string | null) => Effect.Effect<ReadonlyArray<string>, BackgroundRefused>
  /** A `control_response` to a `stop_task`: a refusal stops the run. Whether it was one. */
  readonly onStopResponse: (run: Run, requestId: string | undefined, ok: boolean) => Effect.Effect<boolean>
  /** After a restart (2.6's `Runs.reattach`): the stop's grace and the end of a turn that had ended, armed again from the run's row. */
  readonly rearm: (run: Run) => Effect.Effect<void>
  /** Waits until the run's stop (or steer) grace has done what it does (tests, after moving the clock past it). */
  readonly settled: (run: RunId, timer: "stop" | "steer" | "grace" | "shells" | "detach") => Effect.Effect<void>
}

export class RunInput extends Context.Service<RunInput, RunInputShape>()("huntaway-server/runs/RunInput") {
  static readonly layer = Layer.effect(
    RunInput,
    Effect.gen(function* () {
      const { tx } = yield* Db
      const dir = yield* RunDir
      const repo = yield* RunRepo
      const tasks = yield* TaskRepo
      const threads = yield* Threads
      const events = yield* Events
      const shim = yield* Shim
      const prompts = yield* Prompts
      const background = yield* BackgroundWork
      const changes = yield* Changes
      const random = yield* SecureRandom.SecureRandom
      const fs = yield* FileSystem.FileSystem
      const detachTimers = yield* FiberMap.make<RunId>()
      const stopTimers = yield* FiberMap.make<RunId>()
      const steerTimers = yield* FiberMap.make<RunId>()
      const graceTimers = yield* FiberMap.make<RunId>()
      const shellTimers = yield* FiberMap.make<RunId>()

      const closeInput = (run: RunId) => dir.closeInput(run).pipe(Effect.catch((e) => Effect.logError(`run=${run} closing the agent's input: ${e.reason}`)))
      const closeAndKill = Effect.fnUntraced(function* (run: RunId) {
        // What it has going stops with it, which the agent never hears of: its next prompt says so.
        yield* background.keepKilled(run)
        yield* closeInput(run)
        return yield* shim.kill(run)
      })
      /** Whether the agent asks for permission (and calls the board's tools) on its output, so needs its input for any turn. */
      const asksOnOutput = (run: Run) => (run.kind === "compact" ? Effect.succeed(false) : dir.acceptsInput(run.id))
      const stopping = (run: RunId) => Effect.map(repo.get(run), (r) => Option.isSome(r) && r.value.stop !== "none")

      const publish = Effect.fnUntraced(function* (task: TaskId) {
        const now = yield* tasks.get(task)
        if (now !== null) yield* events.emit({ type: "task", task: now })
      })

      const writeSteers = Effect.fn("RunInput.writeSteers")(function* (task: TaskId) {
        let wrote = false
        for (const steer of yield* tasks.steers(task)) {
          if (steer.written) continue
          // `/plan` (only steered into a run that can write the plan) says how; and what the keys in it name.
          const text = yield* prompts.steer(task, steer.text).pipe(Effect.orElseSucceed(() => steer.text))
          const sent = yield* dir
            .appendInput(steer.run_id, yield* userInput(steer.id, text))
            .pipe(Effect.catch((e) => Effect.logWarning(`run=${steer.run_id} writing a message to the agent: ${e.reason}`).pipe(Effect.as(false))))
          // Keep the order: the rest wait with it.
          if (!sent) break
          yield* tasks.steerWritten(steer.id)
          wrote = true
        }
        if (wrote) yield* publish(task)
        return wrote
      })

      const steered = Effect.fnUntraced(function* (run: Run, id: string) {
        const steer = yield* tasks.takeSteer(run.task_id, id)
        // Anything else is the prompt, or a message replayed after a restart.
        if (steer === null) return false
        const row = yield* repo.get(run.id)
        const newTurn = row._tag === "Some" && row.value.between_turns
        const stop = row._tag === "Some" && row.value.stop === "interrupted" ? "none" : undefined
        // The user's message moves the work on: a question the agent asked them is answered, and work it said was
        // finished goes on. Another agent's (or a routine's) answers neither, so the question still waits for the user.
        const byAgent = fromAgent(steer.source, steer.text)
        const writeNo = yield* threads
          .userMessage(run.task_id, steer.text, {
            steered: true,
            ...(byAgent ? { from_agent: true } : {}),
            ...(steer.source === "routine" ? { routine: true } : {}),
          })
          .pipe(Effect.orDie)
        yield* repo.update(run.id, {
          between_turns: false,
          stop,
          ...(byAgent ? {} : { attention: null, finished: false }),
          // The message the next turn starts with (checkpoints).
          ...(newTurn ? { write_no: writeNo } : {}),
          // What its agent sends another task from now on is one hop further than this message (the user's: 0).
          hops: steer.hops,
        })
        // The automation runs it carried are this run's, for their cost (6.5).
        if (steer.automation_run_id !== null) yield* repo.chargeAutomationRuns(run.id, [steer.automation_run_id])
        yield* publish(run.task_id)
        return true
      })

      const turnStarted = (run: RunId) => repo.startTurn(run)

      /** Close the input unless the messages `waiting` start the agent's next turn within `STEER_GRACE`. */
      const closeUnlessTakenIn = (run: Run, waiting: ReadonlyArray<string>) =>
        FiberMap.run(
          steerTimers,
          run.id,
          Effect.gen(function* () {
            yield* Effect.sleep(STEER_GRACE)
            const left = yield* tasks.steers(run.task_id, run.id)
            if (left.some((s) => waiting.includes(s.id))) {
              yield* Effect.logWarning(`run=${run.id} the agent didn't take in the messages sent to it; ending its run`)
              yield* closeInput(run.id)
            }
          }),
        ).pipe(Effect.asVoid)

      /**
       * HE-113: what was queued for the task while the agent worked goes to it now that its turn is over, as steers of
       * its run, in the order queued, so that it starts the agent's next turn rather than waiting for the run to end
       * and a new one to start on it. Not into a run that is stopped, failed its turn, is a compaction or takes no input; and a
       * `/compact` or `/plan` among it keeps the whole queue for the next run, as it would have been. Whether any went.
       */
      const steerQueued = Effect.fnUntraced(function* (run: Run) {
        if (run.kind === "compact" || !(yield* dir.acceptsInput(run.id))) return false
        const at = yield* nowTimestamp
        const moved = yield* tx(
          Effect.gen(function* () {
            const row = yield* repo.get(run.id)
            // A turn that failed (out of usage, say) leaves it for the run's end, which knows what to do with it.
            if (Option.isNone(row) || !row.value.isLive || row.value.stop !== "none" || row.value.result_error !== null) return false
            const queued = yield* tasks.queued(run.task_id)
            if (queued.length === 0 || queued.some((q) => isCompact(q.text) || planRest(q.text) !== null)) return false
            for (const q of yield* tasks.takeQueued(run.task_id)) {
              if (q.text.trim() === "") continue
              const id = yield* random.uuidV4()
              yield* tasks.addSteer(
                run.task_id,
                { id, run_id: run.id, text: q.text, source: q.source, automation_run_id: q.automation_run_id, hops: q.hops ?? 0 },
                at,
              )
            }
            return true
          }),
        )
        if (!moved) return false
        // Shown as sent once written; as waiting to be, if it couldn't be.
        if (!(yield* writeSteers(run.task_id))) yield* publish(run.task_id)
        return true
      })

      const turnEnded: (run: Run) => Effect.Effect<void> = Effect.fn("RunInput.turnEnded")(function* (run: Run) {
        yield* steerQueued(run)
        const waiting = yield* tasks.steers(run.task_id, run.id)
        if (waiting.length > 0) {
          yield* closeUnlessTakenIn(
            run,
            waiting.map((s) => s.id),
          )
          return
        }
        // An agent with background tasks going doesn't exit until they end: its input stays open, so what's sent to it
        // meanwhile starts a turn at once (HA-187). A stopped turn's run is ended instead: the stop was for all of it.
        if ((yield* background.tasks(run.id)).length > 0) {
          yield* background.setEnded(run.id, null)
          if (yield* stopping(run.id)) yield* closeAndKill(run.id)
          // Only dev servers it doesn't wait on: the run ends, and leaves them running (HA-409).
          else yield* detachLater(run)
          return
        }
        // Background tasks ended during the turn: Claude Code takes another on those it didn't give the agent the
        // outcome of, which may ask for permission on its input.
        const ended = yield* background.ended(run.id)
        if (ended !== null) {
          yield* background.setEnded(run.id, null)
          if (notTakenIn(ended).length > 0 && (yield* asksOnOutput(run)) && !(yield* stopping(run.id))) {
            yield* closeUnlessTurnStarts(run, FOLLOW_UP_GRACE)
            return
          }
        }
        yield* closeInput(run.id)
      })

      /** Whether the run is between turns with only dev servers left that it doesn't wait on, and nothing sent to it. */
      const onlyServers = Effect.fnUntraced(function* (id: RunId) {
        const row = yield* repo.get(id)
        if (Option.isNone(row) || !row.value.isLive || !row.value.between_turns || row.value.stop !== "none" || row.value.kind === "compact") return null
        // A message sent meanwhile starts its next turn, whose end looks again.
        if ((yield* tasks.steers(row.value.task_id, id)).length > 0) return null
        if (!detachable(yield* background.tasks(id), yield* background.waited(id))) return null
        return row.value
      })

      /**
       * The agent's turn ended with only shells left that look like dev servers it doesn't wait on, of a task that goes
       * to review, on a host that finds them again (Linux): once `DETACH_AFTER` has passed and each of them listens on a
       * port (looked at again every `DETACH_RETRY`, up to `DETACH_FOR_MS` after, for a server slow to start), its agent
       * is killed outright, leaving them running, and its run ends as a turn's end without them would (HA-409). Anything
       * else keeps the run, as before: the agent hears when it ends.
       */
      const detachLater = Effect.fnUntraced(function* (run: Run) {
        if (!SUPPORTED || run.kind === "compact") return
        const task = yield* tasks.get(run.task_id)
        if (task === null || task.kind !== "task" || lastingOf(task) !== null) return
        if ((yield* onlyServers(run.id)) === null) return
        yield* FiberMap.run(
          detachTimers,
          run.id,
          Effect.gen(function* () {
            yield* Effect.sleep(DETACH_AFTER)
            const until = (yield* Clock.currentTimeMillis) + DETACH_FOR_MS
            while (true) {
              const now = yield* onlyServers(run.id)
              if (now === null) return
              const { agent } = yield* dir.pids(run.id)
              if (agent !== null && (yield* shellsListen(fs, agent))) break
              if ((yield* Clock.currentTimeMillis) >= until) return
              yield* Effect.sleep(DETACH_RETRY)
            }
            const left = yield* background.tasks(run.id)
            yield* background.setDetached(run.id, left)
            if (yield* shim.killAgentOnly(run.id)) {
              yield* Effect.logInfo(
                `run=${run.id} its turn ended with only servers left in the background; ending it, and leaving ${left.map((t) => t.id).join(", ")} running`,
              )
            } else yield* background.setDetached(run.id, [])
          }),
          { onlyIfMissing: true },
        )
      })

      /**
       * The input is left open for the turn Claude Code takes on what its background tasks did; if none has started
       * after `grace`, and the agent wrote nothing since, its turn is over as it would have been; if it wrote
       * something, it gets another `grace`.
       */
      const closeUnlessTurnStarts = (run: Run, grace: Duration.Input): Effect.Effect<void> =>
        Effect.gen(function* () {
          const at = Option.match(yield* repo.get(run.id), { onNone: () => Number.MAX_SAFE_INTEGER, onSome: (r) => r.out_offset })
          yield* FiberMap.run(
            graceTimers,
            run.id,
            Effect.gen(function* () {
              yield* Effect.sleep(grace)
              const now = yield* repo.get(run.id)
              if (Option.isNone(now) || !now.value.isLive || !now.value.between_turns || (yield* background.tasks(run.id)).length > 0) return
              if (now.value.out_offset > at) {
                yield* closeUnlessTurnStarts(now.value, grace)
                return
              }
              yield* Effect.logWarning(`run=${run.id} the agent took no turn on its background tasks' outcome; ending its run`)
              yield* turnEnded(now.value)
            }),
          )
        })

      const backgroundChanged: (run: Run, given: ReadonlyArray<unknown>) => Effect.Effect<void> = Effect.fn("RunInput.backgroundChanged")(function* (
        run: Run,
        given: ReadonlyArray<unknown>,
      ) {
        const before = yield* background.tasks(run.id)
        const after = listed(before, given, yield* nowTimestamp)
        yield* background.setTasks(run.id, after)
        yield* background.sync(run.id)
        const asks = yield* asksOnOutput(run)
        const row = yield* repo.get(run.id)
        if (Option.isNone(row) || !row.value.isLive) return
        const ids = after.map((t) => t.id)
        if (!row.value.between_turns) {
          if (!asks) return
          // Those no longer going; one without an id, if fewer are.
          const gone: Array<string | null> = before.flatMap((t) => (t.id !== null && !ids.includes(t.id) ? [t.id] : []))
          if (before.some((t) => t.id === null) && ids.length < before.length) gone.push(null)
          if (gone.length === 0) return
          const ended = (yield* background.ended(run.id)) ?? { ended: [], taken: [] }
          yield* background.setEnded(run.id, { ended: [...ended.ended, ...gone], taken: ended.taken })
          return
        }
        if (ids.length > 0) return
        // Those the board stopped (the banner's Stop) get no turn: Claude Code takes none on a task it was told to stop.
        const stopped = new Set((yield* background.killed(run.id)).map((t) => t.id))
        const unasked = before.some((t) => t.id === null || !stopped.has(t.id))
        if (asks && unasked && !(yield* stopping(run.id))) yield* closeUnlessTurnStarts(row.value, BACKGROUND_GRACE)
        else yield* turnEnded(row.value)
      })

      const tookIn = Effect.fnUntraced(function* (run: Run, id: string) {
        if (!(yield* asksOnOutput(run))) return
        const ended = (yield* background.ended(run.id)) ?? { ended: [], taken: [] }
        if (!ended.taken.includes(id)) yield* background.setEnded(run.id, { ended: ended.ended, taken: [...ended.taken, id] })
      })

      /** Stop the run's process if the turn the stop `stopId` interrupts hasn't ended within `STOP_GRACE`. */
      const stopUnlessInterrupted = (run: RunId, stopId: string) =>
        FiberMap.run(
          stopTimers,
          run,
          Effect.gen(function* () {
            yield* Effect.sleep(STOP_GRACE)
            const row = yield* repo.get(run)
            if (row._tag === "None" || !row.value.isLive || row.value.stop !== "requested" || (row.value.stop_id ?? "") !== stopId) return
            yield* Effect.logWarning(`run=${run} the agent didn't end its turn when stopped; stopping its process`)
            yield* closeAndKill(run)
          }),
        ).pipe(Effect.asVoid)

      const interrupt = Effect.fn("RunInput.interrupt")(function* (run: RunId, stopId: string) {
        const sent = yield* dir
          .appendInput(run, yield* interruptLine(stopId))
          .pipe(Effect.catch((e) => Effect.logWarning(`run=${run} couldn't interrupt the agent: ${e.reason}`).pipe(Effect.as(false))))
        if (sent) yield* stopUnlessInterrupted(run, stopId)
        return sent
      })

      const stop = Effect.fn("RunInput.stop")(function* (run: Run, kill: boolean) {
        // `requested` until the turn it interrupts ends, then `interrupted`. A later stop gets its own id, so the grace
        // of an earlier one leaves it alone.
        const stopId = `stop-${yield* random.uuidV4()}`
        yield* repo.update(run.id, { stop: "requested", stop_id: stopId })
        let now = kill
        // Between turns, an agent kept going by its background tasks has no turn to interrupt.
        if (!now && (yield* background.tasks(run.id)).length > 0) {
          const row = yield* repo.get(run.id)
          now = Option.isSome(row) && row.value.between_turns && (yield* tasks.steers(run.task_id, run.id)).length === 0
        }
        if (!now && (yield* interrupt(run.id, stopId))) return
        const signalled = yield* closeAndKill(run.id)
        // Never got as far as starting the agent: it ends here.
        if (!signalled && !(yield* dir.started(run.id))) {
          yield* changes.offer({
            _tag: "RunExited",
            run: run.id,
            task: run.task_id,
            exit: { code: null, signal: null, error: "it was stopped before its agent started" },
            errorTail: "",
          })
        }
      })

      const stopBackground = Effect.fn("RunInput.stopBackground")(function* (run: Run, id: string | null) {
        const shells = (yield* background.tasks(run.id)).filter((t) => kindOf(t) === "shell" && (id === null || t.id === id))
        if (shells.length === 0) {
          return yield* new BackgroundRefused({ reason: id === null ? "the agent has no background shells going" : `the agent has no background shell ${id}` })
        }
        // For the agent's next prompt if the run ends before it hears of it.
        yield* background.addKilled(run.id, shells)
        const asked: Array<string> = []
        for (const t of shells) {
          if (t.id === null) continue
          const line = yield* toJson({
            type: "control_request",
            request_id: `${BACKGROUND_STOP}${yield* random.uuidV4()}`,
            request: { subtype: "stop_task", task_id: t.id },
          })
          const sent = yield* dir.appendInput(run.id, line).pipe(Effect.orElseSucceed(() => false))
          if (sent) asked.push(t.id)
        }
        // It can't be asked (no input, or tasks without ids): only the run's stop ends them.
        if (asked.length < shells.length) {
          yield* Effect.logWarning(`run=${run.id} stopping the run to end its background shells`)
          yield* stop(run, false)
          return asked
        }
        yield* FiberMap.run(
          shellTimers,
          run.id,
          Effect.gen(function* () {
            yield* Effect.sleep(BACKGROUND_STOP_GRACE)
            const left = (yield* background.tasks(run.id)).filter((t) => t.id !== null && asked.includes(t.id))
            const now = yield* repo.get(run.id)
            if (left.length === 0 || Option.isNone(now) || !now.value.isLive) return
            yield* Effect.logWarning(`run=${run.id} the agent didn't stop its background tasks; stopping the run`)
            yield* stop(now.value, false)
          }),
        )
        return asked
      })

      const onStopResponse = Effect.fnUntraced(function* (run: Run, requestId: string | undefined, ok: boolean) {
        if (requestId === undefined || !requestId.startsWith(BACKGROUND_STOP)) return false
        if (!ok) {
          yield* Effect.logWarning(`run=${run.id} the agent refused to stop a background task; stopping the run`)
          yield* stop(run, false)
        }
        return true
      })

      const rearm = Effect.fn("RunInput.rearm")(function* (run: Run) {
        const takesInput = yield* dir.acceptsInput(run.id)
        if (!takesInput) return
        if (run.stop === "requested") yield* stopUnlessInterrupted(run.id, run.stop_id ?? "")
        // Its turn ended, maybe before the end was seen to: the messages it has been sent start the next one, written
        // now if they weren't, or else its input is closed so it exits.
        if (!run.between_turns) return
        yield* writeSteers(run.task_id)
        if ((yield* tasks.steers(run.task_id, run.id)).length > 0) {
          yield* turnEnded(run)
          return
        }
        // Its background tasks may have ended just before, and the turn on their outcome may yet ask on its input.
        if (run.stop === "none" && (yield* background.tasks(run.id)).length === 0 && (yield* asksOnOutput(run))) {
          yield* closeUnlessTurnStarts(run, BACKGROUND_GRACE)
          return
        }
        yield* turnEnded(run)
      })

      return RunInput.of({
        writeSteers,
        steered: (run, id) => tx(steered(run, id)),
        turnStarted,
        turnEnded,
        interrupt,
        closeAndKill,
        closeInput,
        rearm,
        stop,
        backgroundChanged,
        tookIn,
        stopBackground,
        onStopResponse,
        settled: (run, timer) =>
          FiberMap.get(
            timer === "stop" ? stopTimers : timer === "steer" ? steerTimers : timer === "grace" ? graceTimers : timer === "detach" ? detachTimers : shellTimers,
            run,
          ).pipe(
            Effect.flatMap((found) => (Option.isSome(found) ? Fiber.await(found.value) : Effect.void)),
            Effect.asVoid,
          ),
      })
    }),
  )
}
