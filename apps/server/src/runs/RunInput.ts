import { Context, Effect, FiberMap, Layer } from "effect"
import type { RunId, TaskId } from "@huntaway/contracts"
import { interruptLine, userInput } from "../agents/claude/launch.ts"
import { Prompts } from "../agents/Prompts.ts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { fromAgent, TaskRepo } from "../tasks/TaskRepo.ts"
import { Threads } from "../threads/Threads.ts"
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
// The timers are fibers here, one of each kind per run (a `FiberMap` keyed by run id: arming one again replaces it),
// each checking the run's row when it fires, so they can be armed again from the row after a restart (`rearm`).

/** How long a stopped agent has to end its turn before its process is stopped. */
export const STOP_GRACE = "10 seconds"
/** How long an agent that ended its turn with messages still waiting has to start the next turn with them. */
export const STEER_GRACE = "30 seconds"
// Background work (plan task 2.8, `BackgroundWork`) adds BACKGROUND_GRACE (120 s: background tasks ended between turns,
// wait for the turn Claude Code takes on their outcome) and FOLLOW_UP_GRACE (15 s: tasks ended during the turn whose
// outcome it was not given), at the hooks marked "2.8" below.

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
  /** The agent is working on a turn of its own: it is no longer between turns. Database only. */
  readonly turnStarted: (run: RunId) => Effect.Effect<void>
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
  /** After a restart (2.6's `Runs.reattach`): the stop's grace and the end of a turn that had ended, armed again from the run's row. */
  readonly rearm: (run: Run) => Effect.Effect<void>
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
      const stopTimers = yield* FiberMap.make<RunId>()
      const steerTimers = yield* FiberMap.make<RunId>()

      const closeInput = (run: RunId) => dir.closeInput(run).pipe(Effect.catch((e) => Effect.logError(`run=${run} closing the agent's input: ${e.reason}`)))
      const closeAndKill = Effect.fnUntraced(function* (run: RunId) {
        yield* closeInput(run)
        return yield* shim.kill(run)
      })

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
        })
        // The automation runs it carried are this run's, for their cost: plan task 6.5 (`Routines.takenIn`).
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

      const turnEnded = Effect.fn("RunInput.turnEnded")(function* (run: Run) {
        const waiting = yield* tasks.steers(run.task_id, run.id)
        if (waiting.length > 0) {
          yield* closeUnlessTakenIn(
            run,
            waiting.map((s) => s.id),
          )
        } else {
          // 2.8: with background tasks going, the input stays open (HA-187) unless the run was stopped (then close
          // and kill); with tasks that ended during the turn and whose outcome it wasn't given, FOLLOW_UP_GRACE.
          yield* closeInput(run.id)
        }
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

      const rearm = Effect.fn("RunInput.rearm")(function* (run: Run) {
        const takesInput = yield* dir.acceptsInput(run.id)
        if (!takesInput) return
        if (run.stop === "requested") yield* stopUnlessInterrupted(run.id, run.stop_id ?? "")
        // Its turn ended, maybe before the end was seen to: the messages it has been sent start the next one, written
        // now if they weren't, or else its input is closed so it exits. (2.8: or BACKGROUND_GRACE.)
        if (run.between_turns) {
          yield* writeSteers(run.task_id)
          yield* turnEnded(run)
        }
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
      })
    }),
  )
}
